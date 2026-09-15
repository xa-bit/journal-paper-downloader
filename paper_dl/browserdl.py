"""浏览器自动化下载模块（Playwright）。

以持久化 worker 进程方式运行：``python -m paper_dl.browserdl``。
通过 stdin/stdout 的 JSON 行协议与 Node 服务通信：

请求（stdin）:
    {"id": 1, "op": "ping"}
    {"id": 2, "op": "fetch", "doi": "...", "root": "...", "rel": "期刊/卷/文章",
     "stem": "2025JC023188", "meta": {...},
     "wait_minutes": 5, "max_refresh": 3, "human_wait_min": 0,
     "browser": "auto|chrome|edge|firefox|safari",
     "generate_info": true, "overwrite": false}
    {"id": 3, "op": "stop"}     # 中止当前 fetch（不关闭浏览器）
    {"id": 4, "op": "skip"}     # 人工跳过当前 fetch
    {"id": 5, "op": "reload"}   # 刷新当前页面（验证页卡死时人工触发重试）
    {"id": 6, "op": "shutdown"} # 关闭浏览器并退出

响应（stdout）:
    {"type": "ready"}                       # worker 就绪（playwright 可用）
    {"type": "fatal", "error": "..."}       # 无法启动（如未安装 playwright）
    {"type": "status", "state": "...", "message": "...", "doi": "..."}
    {"id": 2, "ok": true, "path": "...", "info_path": "...", ...}
    {"id": 2, "ok": false, "error": "...", "skipped": true}

单个任务的流程：
打开落地页 -> 寻找并点击 PDF 下载入口（失败则尝试出版商直链）
-> 每轮等待 wait_minutes 分钟：期间监测下载队列 / 登录与验证页 / 跳过与停止指令
-> 无响应则刷新页面，最多 max_refresh 次，仍无响应则报错交给下一个任务
-> 检测到浏览器开始下载 PDF 后等待完成 -> 按命名规则移动/重命名到目标目录
-> 按设置生成信息文件 -> 关闭标签页，等待下一个任务。

验证处理分两类：
- 人机验证 / 反爬拦截（Cloudflare Turnstile、“确认您是真人”等）：走自动验证循环——
  每 verify_interval_s 秒对验证控件模拟点击一次，连续 verify_max_fails 次未通过则
  刷新页面等待重新验证；这些时间都计入当前轮的等待窗口（即“每页等待时间”内），
  窗口耗尽按“无响应”处理（消耗一次刷新次数）。验证通过（连续两次干净检测）不消耗刷新次数。
- 登录页等身份验证：页面保持打开等待人工处理（human_wait_min=0 表示无限等待），
  可通过 skip/stop/reload 指令跳过、停止或刷新页面重试。
页面正在跳转导致无法判定验证状态时一律视为“仍在验证”，避免在验证完成前导航离开。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
import threading
import time
import traceback
from pathlib import Path

from .downloader import write_info_file
from .resolvers import Paper, ResolveError, resolve_doi

# 触发下载时优先点击的页面元素（出版商通用的 PDF 链接形态）
CLICK_SELECTORS = [
    "a[href*='/doi/pdf/']",
    "a[href*='/doi/pdfdirect/']",
    "a[href*='/doi/epdf/']",
    "a[href$='.pdf']",
    "a[download]",
]

#: 界面可选的浏览器（auto = 依次尝试本机 Chrome / Edge / 内置 Chromium）
BROWSER_CHOICES = ("auto", "chrome", "edge", "firefox", "safari")

#: 各选择在错误信息 / 日志中的显示名
BROWSER_LABELS = {
    "auto": "自动（Chrome / Edge / 内置 Chromium）",
    "chrome": "Chrome",
    "edge": "Edge",
    "firefox": "Firefox",
    "safari": "Safari（WebKit 引擎）",
}

MIN_WINDOW_SECONDS = 60
DOWNLOAD_COMPLETE_TIMEOUT = 900  # 单个文件下载完成的兜底等待（15 分钟）

PLAYWRIGHT_INSTALL_HINT = (
    "浏览器自动化需要先安装 Playwright 并准备浏览器："
    "pip install playwright && python -m playwright install chromium "
    "（若本机已装 Chrome/Edge 会自动优先使用）"
)


class SkipRequested(RuntimeError):
    """人工跳过当前任务。"""


class StopRequested(RuntimeError):
    """下载被用户停止。"""


def _emit(payload: dict) -> None:
    """输出一行 JSON 并立即刷新（stdout 是与 Node 通信的唯一通道）。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# 页面上检测登录 / 人机验证 / 反爬拦截的信号（在浏览器内执行）
_AUTH_SNIFF_JS = """() => {
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const pwd = [...document.querySelectorAll('input[type=password]')].some(visible);
  const title = document.title || '';
  const body = ((document.body && document.body.innerText) || '').slice(0, 4000);
  // 关键：Turnstile/reCAPTCHA 验证成功后，其 iframe 仍会留在页面上显示“成功”，
  // 不能凭 iframe 存在判定“仍在验证”；验证通过后隐藏 token 输入框会被填值，
  // 以此判定验证已成功（verified=true 时直接视为页面干净，避免误刷新清掉已通过的验证）
  const verified = [...document.querySelectorAll(
    'input[name="cf-turnstile-response"], input[name="g-recaptcha-response"], input[name="h-captcha-response"]'
  )].some((i) => (i.value || '').length > 10);
  const cf = /just a moment|attention required|verify you are human|checking your browser|performing security verification/i.test(title)
    || !!document.querySelector('#cf-challenge-running, .cf-browser-verification, #challenge-form, iframe[src*="challenges.cloudflare.com"]');
  const denied = /access denied|request blocked|403 forbidden|are you a robot|unusual traffic/i.test(title + ' ' + body);
  return { pwd, cf, denied, verified, title: title.slice(0, 200) };
}"""

_AUTH_URL_RE = re.compile(
    r"(?:^|[./@-])(?:login|signin|log-in|logon|sso|athens|shibboleth|idp|authenticate)(?:[./?#]|$)",
    re.IGNORECASE,
)

#: 这些验证原因属于“人机验证/拦截”类：走自动点击 + 有限次数刷新的验证循环
#: （受每轮等待窗口约束）；其余（登录页等）保持等待人工处理。
CHALLENGE_REASONS = ("Cloudflare 人机验证", "访问受限/反爬拦截页")

#: 注入到每个页面加载前的反检测脚本：抹掉最常见的自动化特征（navigator.webdriver、
#: window.chrome、plugins、languages、permissions），降低被 Cloudflare 等人机验证
#: 系统识别为自动化浏览器的概率。需配合真实 Chrome/Edge 通道 + 有头模式使用。
STEALTH_JS = """() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (e) {}
  try { window.chrome = window.chrome || { runtime: {} }; } catch (e) {}
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' },
      ],
    });
  } catch (e) {}
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const orig = navigator.permissions.query.bind(navigator.permissions);
      const perm = (window.Notification && Notification.permission) || 'prompt';
      navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: perm, onchange: null })
          : orig(p);
    }
  } catch (e) {}
}"""


class BrowserWorker:
    """维护一个可复用的真实浏览器实例，按队列逐篇执行浏览器自动化下载。"""

    def __init__(self) -> None:
        self.stop_event = asyncio.Event()
        self.skip_event = asyncio.Event()
        self.reload_event = asyncio.Event()
        self.current_fetch_id: int | None = None  # 正在处理的 fetch 请求 id
        self._last_auth_reason: str | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._pw = None
        self._context = None
        self._channel_used = ""
        self._browser_requested = ""
        self._browser_redirect: str | None = None  # firefox→edge 等自动改道提示
        self._downloads: asyncio.Queue = asyncio.Queue()
        self._stray_pages: set = set()

    # ------------------------------------------------------------------
    # 浏览器生命周期
    # ------------------------------------------------------------------

    @staticmethod
    def _profile_dir(browser: str = "auto") -> Path:
        """浏览器用户数据目录：跨会话保留 Cookie / 登录态。

        不同引擎的配置文件互不兼容，按浏览器族分开存放；
        chromium 族（auto/chrome/edge）沿用原目录，保留已有登录态。
        """
        if sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
            base = Path(os.environ["LOCALAPPDATA"])
        elif sys.platform == "darwin":
            base = Path.home() / "Library" / "Caches"
        else:
            base = Path.home() / ".cache"
        suffix = {
            "firefox": "browser-profile-firefox",
            "safari": "browser-profile-webkit",
        }.get(browser, "browser-profile")
        return base / "journal-paper-downloader" / suffix

    async def _ensure_browser(self, browser: str = "auto") -> None:
        """确保浏览器实例就绪；浏览器选择变化时先关闭旧实例再按新选择启动。"""
        browser = str(browser or "auto").strip().lower()
        if browser not in BROWSER_CHOICES:
            browser = "auto"
        if browser == "firefox":
            # Cloudflare 等反爬系统对 Playwright 版 Firefox 的识别率极高，
            # 人机验证基本无法通过（实测反复挑战、点击无效）：
            # 自动改用本机 Edge（真实 Chromium 内核 + 反检测脚本），保证下载流程可用
            self._browser_redirect = "edge"
            browser = "edge"
        if self._context is not None:
            if self._browser_requested == browser:
                return
            await self._teardown_browser()  # 切换浏览器：重建实例

        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise ResolveError(PLAYWRIGHT_INSTALL_HINT) from exc

        if self._pw is None:
            self._pw = await async_playwright().start()
        profile = self._profile_dir(browser)
        profile.mkdir(parents=True, exist_ok=True)

        # (playwright 引擎, channel)：chromium 族可用本机 Chrome / Edge / 内置 Chromium
        if browser == "chrome":
            specs: list[tuple] = [(self._pw.chromium, "chrome")]
        elif browser == "edge":
            specs = [(self._pw.chromium, "msedge")]
        elif browser == "firefox":
            specs = [(self._pw.firefox, None)]
        elif browser == "safari":
            specs = [(self._pw.webkit, None)]  # Playwright 的 WebKit（Safari 技术预览引擎）
        else:  # auto
            specs = [(self._pw.chromium, c) for c in ("chrome", "msedge", None)]

        errors: list[str] = []
        for launcher, channel in specs:
            kwargs: dict = {
                "user_data_dir": str(profile),
                "headless": False,
                "accept_downloads": True,
                "no_viewport": True,
            }
            if launcher is self._pw.chromium:
                # 反爬规避参数仅适用于 Chromium 系；Firefox / WebKit 不支持
                kwargs["args"] = [
                    "--disable-blink-features=AutomationControlled",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--start-maximized",
                ]
                # 移除 Playwright 默认追加的 --enable-automation（ Cloudflare 检测点之一）
                kwargs["ignore_default_args"] = ["--enable-automation"]
                if channel:
                    kwargs["channel"] = channel
            try:
                self._context = await launcher.launch_persistent_context(**kwargs)
                self._channel_used = channel or {
                    self._pw.chromium: "chromium(内置)",
                    self._pw.firefox: "firefox",
                    self._pw.webkit: "webkit",
                }[launcher]
                self._browser_requested = browser
                break
            except Exception as exc:  # 逐个渠道回退
                label = channel or {
                    self._pw.chromium: "chromium(内置)",
                    self._pw.firefox: "Firefox",
                    self._pw.webkit: "WebKit",
                }[launcher]
                errors.append(f"{label}: {exc}")
        if self._context is None:
            await self._teardown_browser()
            raise ResolveError(
                f"无法启动自动化浏览器（{BROWSER_LABELS[browser]}){self._browser_hint(browser, errors)}: "
                + " | ".join(errors)
            )

        # 反检测脚本：对本上下文之后打开的每个页面生效（每篇文献都是新标签页）
        try:
            await self._context.add_init_script(STEALTH_JS)
        except Exception:
            pass

        self._context.on("download", self._on_download)
        self._context.on("page", self._on_page)

    @staticmethod
    def _browser_hint(browser: str, errors: list[str]) -> str:
        """针对所选浏览器给出可操作的排查提示。"""
        hints: list[str] = []
        if sys.platform.startswith("linux") and not (
            os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
        ):
            hints.append("（当前是无图形输出的 Linux/WSL 环境，需要 WSLg 或 X 服务器才能弹出浏览器窗口）")
        if browser == "chrome":
            hints.append("请确认本机已安装 Chrome 浏览器")
        elif browser == "edge":
            hints.append("请确认本机已安装 Edge 浏览器")
        elif browser == "firefox":
            hints.append(
                "Firefox 由 Playwright 自带的 Firefox 构建驱动"
                "（系统安装的 Firefox 如 snap 版无法直接使用），"
                "可先执行 python -m playwright install firefox 安装"
            )
        elif browser == "safari":
            hints.append(
                "Safari 由 Playwright 的 WebKit（Safari 技术预览引擎）驱动，"
                "可先执行 python -m playwright install webkit 安装"
            )
        elif any("chromium(内置)" in e for e in errors):
            hints.append("也可先执行 python -m playwright install chromium 安装内置浏览器")
        return "".join(hints)

    def _on_download(self, download) -> None:
        # 任何标签页开始的下载都进入队列，由当前任务消费
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._downloads.put_nowait, download)

    def _on_page(self, page) -> None:
        # 出版商常把验证/下载入口放进弹出的子窗口：记录并自动置前，
        # 避免子窗口被主窗口遮挡“找不到位置”，也降低其因失焦被网站自动关闭的概率
        self._stray_pages.add(page)
        if self._loop is not None:
            async def _bring_front() -> None:
                try:
                    await page.bring_to_front()
                except Exception:
                    pass
            self._loop.create_task(_bring_front())

    def _pick_active_page(self, fallback):
        """选择当前应操作的页面：最新打开且未关闭的非空白页（子窗口优先）。

        出版商的验证/下载流程可能跳到子窗口中进行，检测与点击必须跟着走；
        找不到合适的子窗口时回退到本任务的主页面。
        """
        if self._context is None:
            return fallback
        pages = [p for p in self._context.pages if not p.is_closed()]
        for p in reversed(pages):  # context.pages 按创建顺序，最新优先
            if p is fallback:
                return fallback
            if p in self._stray_pages and (p.url or "") not in ("", "about:blank"):
                return p
        return fallback

    async def _teardown_browser(self) -> None:
        try:
            if self._context is not None:
                await self._context.close()
        except Exception:
            pass
        try:
            if self._pw is not None:
                await self._pw.stop()
        except Exception:
            pass
        self._context = None
        self._pw = None

    # ------------------------------------------------------------------
    # 状态上报
    # ------------------------------------------------------------------

    @staticmethod
    def _status(req: dict, state: str, message: str) -> None:
        _emit(
            {
                "type": "status",
                "state": state,
                "message": message,
                "doi": req.get("doi") or "",
                "title": (req.get("meta") or {}).get("title") or "",
            }
        )

    # ------------------------------------------------------------------
    # 单篇下载
    # ------------------------------------------------------------------

    async def fetch(self, req: dict) -> dict:
        doi = str(req.get("doi") or "").strip()
        if not doi:
            return {"ok": False, "error": "缺少 DOI"}
        self.stop_event.clear()
        self.skip_event.clear()
        self.reload_event.clear()
        self._drain_downloads()

        wait_minutes = float(req.get("wait_minutes") or 2)
        window = max(MIN_WINDOW_SECONDS, int(wait_minutes * 60))
        max_refresh = int(req.get("max_refresh") if req.get("max_refresh") is not None else 2)
        max_refresh = max(0, max_refresh)
        # 人机验证的模拟点击节奏：每 verify_interval_s 点击一次，连续 verify_max_fails
        # 次未通过则刷新页面重试；这些时间都计入上面的每轮等待窗口（见 _challenge_wait）
        req["verify_interval_s"] = max(1, int(req.get("verify_interval_s") or 5))
        req["verify_max_fails"] = max(1, int(req.get("verify_max_fails") or 5))
        generate_info = bool(req.get("generate_info", True))
        stem = str(req.get("stem") or "").strip()
        if not stem:
            stem = doi.rstrip("/").split("/")[-1]

        root = Path(str(req.get("root") or "papers"))
        rel_parts = [p for p in str(req.get("rel") or "").split("/") if p]
        target_dir = root.joinpath(*rel_parts) if rel_parts else root
        final_pdf = target_dir / f"{stem}.pdf"
        if final_pdf.exists() and not req.get("overwrite"):
            return {"ok": False, "error": f"文件已存在: {final_pdf}"}

        meta = req.get("meta") or {}
        try:
            paper = resolve_doi(doi)
        except ResolveError as exc:
            return {"ok": False, "error": f"解析 DOI 失败: {exc}"}

        try:
            self._browser_redirect = None
            await self._ensure_browser(req.get("browser"))
        except ResolveError as exc:
            return {"ok": False, "error": str(exc)}
        if self._browser_redirect:
            self._status(
                req, "opening",
                f"Playwright 版 Firefox 极易被 Cloudflare 识别导致验证无法通过，已自动改用本机 "
                f"{ {'edge': 'Edge', 'auto': 'Edge'}.get(self._browser_redirect, self._browser_redirect) }",
            )

        task_pages: list = []
        page = await self._context.new_page()
        task_pages.append(page)
        for stray in list(self._stray_pages):
            self._stray_pages.discard(stray)
        try:
            await page.bring_to_front()  # 主页面置前，便于人工干预
        except Exception:
            pass

        try:
            download = await self._run_task(page, paper, req, window, max_refresh)
            self._status(req, "saving", "下载完成，正在按命名规则保存文件…")
            tmp_path = await download.path()
            failure = await download.failure()
            if failure:
                raise ResolveError(f"浏览器下载失败: {failure}")
            saved, info_path = await asyncio.to_thread(
                self._finalize, Path(tmp_path), target_dir, stem, paper, meta, generate_info
            )
            self._status(req, "done", f"已保存: {saved.name}")
            return {
                "ok": True,
                "path": str(saved),
                "info_path": str(info_path) if info_path else None,
                "paper": paper.to_dict(),
                "suggested": download.suggested_filename,
                "channel": self._channel_used,
            }
        except SkipRequested as exc:
            return {"ok": False, "error": str(exc), "skipped": True}
        except StopRequested as exc:
            return {"ok": False, "error": str(exc), "stopped": True}
        except ResolveError as exc:
            return {"ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001 —— 任何意外都转为任务失败，不拖垮 worker
            traceback.print_exc()
            return {"ok": False, "error": f"浏览器自动化出错: {exc}"}
        finally:
            # 关闭本任务打开的所有标签页（“关闭连接，进行下一个下载”）
            # 下载导航后的页面可能处于异常状态导致 close 挂起，必须限时
            for p in task_pages:
                self._stray_pages.discard(p)
                try:
                    await asyncio.wait_for(p.close(), timeout=10)
                except Exception:
                    pass
            for p in list(self._stray_pages):
                self._stray_pages.discard(p)
                try:
                    await asyncio.wait_for(p.close(), timeout=10)
                except Exception:
                    pass
            self._drain_downloads()

    async def _run_task(self, page, paper: Paper, req: dict, window: int, max_refresh: int):
        """打开页面并按 等待/刷新/人工干预 循环触发下载，返回完成的 Download。

        每个等待窗口最长 window 秒；超时则刷新页面重试，最多 max_refresh 次；
        人工验证通过后立即重试，不消耗刷新次数。
        """
        start_url = paper.landing_url or (
            f"https://doi.org/{paper.doi}" if paper.doi else paper.pdf_urls[0]
        )
        self._status(req, "opening", f"正在打开出版商页面: {start_url}")
        try:
            await asyncio.wait_for(
                page.goto(start_url, wait_until="domcontentloaded", timeout=90000),
                timeout=95,
            )
        except Exception:
            pass  # 打不开也继续走等待/刷新逻辑
        try:
            await page.wait_for_load_state("load", timeout=20000)
        except Exception:
            pass

        refresh_left = max_refresh

        async def refresh_or_give_up() -> None:
            """等待窗口耗尽后的统一出口：刷新页面（消耗刷新次数）或放弃本篇。"""
            nonlocal refresh_left
            if refresh_left > 0:
                refresh_left -= 1
                self._status(
                    req, "refreshing",
                    f"页面在 {window // 60} 分钟内无下载响应，刷新页面（剩余刷新次数 {refresh_left}）",
                )
                try:
                    await asyncio.wait_for(
                        page.reload(wait_until="domcontentloaded"), timeout=90
                    )
                except Exception:
                    pass
            else:
                raise ResolveError(
                    f"刷新 {max_refresh} 次（每轮 {window // 60} 分钟）后页面仍无下载响应，已放弃: {page.url}"
                )

        while True:
            # 1) 优先消费已开始的下载：验证通过后 Cloudflare 会自动重载原地址并
            #    直接触发下载，此时绝不能再导航/刷新，否则会打断下载甚至重新触发验证
            got = self._pop_download()
            if got is not None:
                return got
            # 2) 出版商可能把验证/下载入口放在弹出的子窗口里：每轮切到最新打开的页面操作
            page = self._pick_active_page(page)
            self._status(
                req, "waiting",
                f"等待页面响应（每轮最长 {window // 60} 分钟，剩余刷新次数 {refresh_left}）",
            )
            reason = await self._detect_auth(page)
            if reason and reason != "unknown":
                outcome = await self._handle_auth(page, req, reason, window)
                if outcome == "download":
                    got = self._pop_download()
                    if got is not None:
                        return got
                if outcome == "cleared":
                    # 验证已通过：不消耗刷新次数；留出短暂宽限，等 Cloudflare 的
                    # 成功跳转/重载落定（其间开始的下载会在下一轮循环顶部被取走）
                    await asyncio.sleep(2)
                    continue
                # outcome == "timeout"：验证占用的时间已计入等待窗口，
                # 直接按“无响应”刷新/放弃，不再重新触发下载或另开等待窗口
                await refresh_or_give_up()
                continue

            await self._trigger_download(page, paper, req)
            outcome = await self._wait_window(
                page, req, window,
                retry_trigger=lambda: self._trigger_download(page, paper, req),
            )

            if outcome == "download":
                got = self._pop_download()
                if got is not None:
                    return got
            if outcome == "skip":
                raise SkipRequested("已人工跳过该篇")
            if outcome == "stop":
                raise StopRequested("下载已被停止")
            if outcome == "auth":
                reason = self._last_auth_reason or "登录/验证"
                outcome = await self._handle_auth(page, req, reason, window)
                if outcome == "download":
                    got = self._pop_download()
                    if got is not None:
                        return got
                if outcome == "cleared":
                    await asyncio.sleep(2)  # 同上：等成功跳转落定
                    continue  # 验证已通过：不消耗刷新次数，立即重试
                # timeout → 掉到下方刷新/放弃逻辑

            # 超时：刷新或放弃
            await refresh_or_give_up()

    async def _handle_auth(self, page, req: dict, reason: str, window: int) -> str:
        """按验证类型分派：人机验证走自动点击循环（受窗口约束），登录页等待人工处理。

        返回 "download"（已开始下载）/"cleared"（已通过）/"timeout"（窗口/人工等待超时），
        人工跳过 / 停止以异常抛出。
        """
        if reason in CHALLENGE_REASONS:
            return await self._challenge_wait(page, req, reason, window)
        return await self._human_intervention(page, req, reason)

    async def _challenge_wait(
        self, page, req: dict, reason: str, window: int
    ) -> str:
        """人机验证循环（受本轮等待窗口约束，时间计入“每页等待时间”）：

        - 每 verify_interval_s 秒对验证控件模拟点击一次（Turnstile / reCAPTCHA 等）；
        - 连续 verify_max_fails 次点击仍未通过 → 刷新页面，等待重新验证；
        - 窗口耗尽仍未通过 → 返回 "timeout"，由外层按“无响应”逻辑刷新或放弃；
        - 期间检测到下载开始 → 返回 "download"；验证通过（连续两次干净检测）→ "cleared"。
        """
        verify_interval = int(req.get("verify_interval_s") or 5)
        verify_max_fails = int(req.get("verify_max_fails") or 5)
        deadline = time.monotonic() + window
        next_click = time.monotonic() + 1  # 给验证页 1s 渲染时间，然后立即点击一次
        fails = 0
        clean_streak = 0
        next_check = 0.0  # 验证状态检测节流（见循环内注释）
        while True:
            if not self._downloads.empty():
                return "download"
            if self.skip_event.is_set():
                raise SkipRequested("已人工跳过该篇")
            if self.stop_event.is_set():
                raise StopRequested("下载已被停止")
            if self.reload_event.is_set():
                self.reload_event.clear()
                self._status(req, "auth", "正在刷新验证页面（重试验证）…")
                try:
                    await asyncio.wait_for(
                        page.reload(wait_until="domcontentloaded"), timeout=90
                    )
                except Exception:
                    pass
                fails = 0
                next_click = time.monotonic() + 5
                clean_streak = 0
            if time.monotonic() >= deadline:
                self._status(
                    req, "auth",
                    f"人机验证在 {window // 60} 分钟内未通过，按无响应处理（刷新页面后重试）",
                )
                return "timeout"
            # 验证状态检测节流：挑战页自带 CPU 密集计算（PoW），高频 evaluate 会
            # 加重页面卡顿，也拖慢自身循环；每 2s 检测一次足够
            now = time.monotonic()
            if now < next_check:
                await asyncio.sleep(0.5)
                continue
            next_check = now + 2
            state = await self._detect_auth(page)
            if state is None:
                # 需连续两次干净检测（间隔 > 1s）才认定验证通过，避免页面跳转瞬间误判
                clean_streak += 1
                if clean_streak >= 2:
                    self._status(req, "waiting", "已通过人机验证，继续尝试自动下载")
                    return "cleared"
                continue
            clean_streak = 0
            if now >= next_click:
                try:
                    await self._try_auto_verify(page)
                except Exception:
                    pass
                # 点击后挑战仍在 = 一次失败尝试（无论是否命中验证控件）：
                # 保证“每 N 次失败刷新页面”与状态进度一定持续推进
                fails += 1
                if fails >= verify_max_fails:
                    fails = 0
                    self._status(
                        req, "auth",
                        f"人机验证连续 {verify_max_fails} 次点击未通过，刷新页面等待重新验证"
                        "（也可在浏览器窗口中手动完成验证；验证可能出现在弹出的子窗口中，"
                        "请勿点击子窗口以外区域，以免子窗口被网站自动关闭）",
                    )
                    try:
                        await asyncio.wait_for(
                            page.reload(wait_until="domcontentloaded"), timeout=90
                        )
                    except Exception:
                        pass
                    next_click = time.monotonic() + 5
                else:
                    self._status(
                        req, "auth",
                        f"人机验证中：每 {verify_interval}s 模拟点击一次（第 {fails}"
                        f"/{verify_max_fails} 次尝试，{verify_max_fails} 次未通过将刷新页面）；"
                        "也可在浏览器窗口/子窗口中手动完成验证，通过后无需任何操作会自动继续",
                    )
                    # 用当前时间调度，避免页面检测耗时把点击间隔越拖越长
                    next_click = time.monotonic() + verify_interval
            await asyncio.sleep(0.5)

    # ------------------------------------------------------------------
    # 页面交互辅助
    # ------------------------------------------------------------------

    def _drain_downloads(self) -> None:
        while not self._downloads.empty():
            try:
                self._downloads.get_nowait()
            except asyncio.QueueEmpty:
                break

    def _pop_download(self):
        try:
            return self._downloads.get_nowait()
        except asyncio.QueueEmpty:
            return None

    async def _trigger_download(self, page, paper: Paper, req: dict | None = None) -> None:
        """在页面上触发 PDF 下载；每个动作后短等下载事件，未开始则继续下一方案。

        实测要点：
        - 直接 page.goto(pdfdirect) 会被 Cloudflare 拦（缺 Referer，等同 curl 403），
          真人下载是“在文章页上点 PDF 链接”；因此点击优先，直链导航必须带 referer；
        - Wiley 的“PDF”按钮可能指向 epdf 阅读器（打开≠下载），点击后若 6s 内无下载
          事件则降级到下一方案；
        - 若页面停留在 PDF 直链/拦截页上，先回文章页再找入口。
        失败不抛错（由等待/刷新逻辑兜底）。
        """

        async def download_started() -> bool:
            for _ in range(6):  # 每个动作后最多观察 6s，确认下载是否开始
                if not self._downloads.empty():
                    return True
                await asyncio.sleep(1)
            return not self._downloads.empty()

        async def attempt(desc: str, action) -> bool:
            if not self._downloads.empty():
                return True
            if req is not None:
                self._status(req, "waiting", f"触发下载：{desc}")
            try:
                await action()
            except Exception:
                pass  # 导航被下载接管（ERR_ABORTED）等，交由下载事件/等待窗口判断
            return await download_started()

        # 下载已在进行时绝不导航/点击：否则会打断下载，甚至重新触发验证
        if not self._downloads.empty():
            return

        landing = paper.landing_url or (
            f"https://doi.org/{paper.doi}" if paper.doi else paper.pdf_urls[0]
        )

        # 0) 若当前停留在 PDF 直链/拦截页（之前尝试留下的），先回文章页再找入口
        try:
            if "/doi/pdf" in (page.url or ""):
                if req is not None:
                    self._status(req, "waiting", "回到文章页寻找下载入口")
                await asyncio.wait_for(
                    page.goto(landing, wait_until="domcontentloaded", timeout=60000),
                    timeout=65,
                )
        except Exception:
            pass

        # 1) 出版商规范直链 + download=true（Wiley pdfdirect 实测必需）：
        #    无该参数时返回 inline PDF，自动化中表现为空白页且无下载事件；
        #    带 Referer 的导航会触发附件下载（playwright 报 "Download is starting"，
        #    下载事件随后进入队列——正是预期行为）
        direct_urls: list[str] = []
        for url, source in zip(paper.pdf_urls, paper.pdf_sources):
            if source != "publisher":
                continue
            if "pdfdirect" in url and "download=" not in url:
                url = url + ("&" if "?" in url else "?") + "download=true"
            if url not in direct_urls:
                direct_urls.append(url)
        referrer = page.url or landing
        for url in direct_urls[:2]:
            if await attempt(
                f"带来源访问 PDF 直链 {url}",
                lambda u=url, r=referrer: page.goto(u, referer=r, wait_until="commit", timeout=60000),
            ):
                return

        # 2) 点击文章页上的 PDF / epdf 链接、按钮（带 Referer 与会话 Cookie）
        candidates = []
        for sel in CLICK_SELECTORS:
            try:
                loc = page.locator(sel).first
                if await loc.count() and await loc.is_visible():
                    candidates.append(loc)
                    break
            except Exception:
                continue
        if not candidates:
            try:
                link = page.get_by_role("link", name=re.compile(r"pdf", re.IGNORECASE)).first
                if await link.count() and await link.is_visible():
                    candidates.append(link)
            except Exception:
                pass
        for loc in candidates[:2]:
            if await attempt("点击文章页上的 PDF 链接", lambda l=loc: l.click(timeout=10000)):
                return

        # 3) citation_pdf_url（页面 meta 声明的 PDF 地址）
        try:
            meta_url = await page.eval_on_selector(
                "meta[name='citation_pdf_url']", "el => el.content"
            )
        except Exception:
            meta_url = None
        if meta_url:
            if await attempt(
                f"带来源访问 citation_pdf_url {meta_url}",
                lambda u=meta_url, r=referrer: page.goto(u, referer=r, wait_until="commit", timeout=60000),
            ):
                return

        # 3) 诊断信息：当前页面 URL/标题 + PDF 相关链接（便于排查入口选择器）
        if req is not None:
            hint = ""
            try:
                info = await asyncio.wait_for(
                    page.evaluate(
                        """() => ({
                            url: location.href,
                            title: document.title,
                            hrefs: [...document.querySelectorAll('a')]
                              .map(e => e.href)
                              .filter(h => h && h.toLowerCase().includes('pdf'))
                              .slice(0, 3),
                        })"""
                    ),
                    timeout=10,
                )
                hint = f"；页面: {info.get('title', '')[:60]} ({info.get('url', '')[:90]})"
                hrefs = info.get("hrefs") or []
                if hrefs:
                    hint += "；PDF 链接: " + " | ".join(hrefs)
            except Exception:
                hint = f"；页面: {(page.url or '')[:90]}"
            self._status(req, "waiting", "本轮未找到可用的下载入口，继续等待页面加载/重试" + hint)

    async def _wait_window(self, page, req: dict, window: int, retry_trigger=None) -> str:
        """在一个等待窗口内监听：下载事件 / 跳过 / 停止 / 出现登录验证 / 超时。

        retry_trigger：可选的周期性下载重触发回调（页面链接迟渲染、首次触发
        未命中时，每 45s 重试一次，避免干等整个窗口）。
        """
        deadline = time.monotonic() + window
        next_auth_check = time.monotonic() + 5
        next_trigger = time.monotonic() + 45 if retry_trigger else None
        while True:
            if not self._downloads.empty():
                return "download"
            if self.skip_event.is_set():
                return "skip"
            if self.stop_event.is_set():
                return "stop"
            now = time.monotonic()
            if next_trigger is not None and now >= next_trigger:
                next_trigger = now + 45
                if retry_trigger:
                    await retry_trigger()
            if now >= next_auth_check:
                next_auth_check = now + 5
                reason = await self._detect_auth(page)
                # "unknown"（页面正在跳转）不算发现验证，下一周期再检测
                if reason and reason != "unknown":
                    self._last_auth_reason = reason
                    return "auth"
            if now >= deadline:
                return "timeout"
            await asyncio.sleep(0.5)

    async def _try_auto_verify(self, page) -> bool:
        """尝试自动通过点击式人机验证（Cloudflare Turnstile / reCAPTCHA / hCaptcha 等）。

        注意：Playwright 的合成点击不会移动可见鼠标，只派发受信任的输入事件，
        所以在浏览器窗口里“看不到鼠标在点”，以状态消息里的点击计数为准。
        点击目标按可靠性排序：
        1) 验证 iframe 内部的复选框 / 标签元素；
        2) 父页面中的验证 iframe 元素本身，按复选框在组件内的坐标点击
           （Turnstile 复选框位于组件左侧约 (28,33)）——不依赖 iframe 内部 DOM，
           对闭包 shadow DOM / 混淆过的验证组件同样有效；
        3) iframe 内 body 的复选框坐标位置点击；
        4) 页面内“确认您是真人 / Verify you are human”等按钮文本。
        返回 True 表示已执行点击动作（不代表验证已通过，需重新检测确认）。
        """
        # 1) 验证 iframe 内部的可点击元素
        try:
            for frame in page.frames:
                url = (frame.url or "").lower()
                if not any(
                    k in url
                    for k in ("challenges.cloudflare.com", "recaptcha", "turnstile", "hcaptcha")
                ):
                    continue
                for sel in (
                    "input[type='checkbox']",
                    ".cb-lb",
                    ".recaptcha-checkbox-border",
                    "label",
                ):
                    try:
                        loc = frame.locator(sel).first
                        if await loc.count() and await loc.is_visible():
                            await loc.click(timeout=3000)
                            return True
                    except Exception:
                        continue
        except Exception:
            pass
        # 2) 父页面里的验证 iframe 元素：按复选框坐标点击（最稳，不依赖内部 DOM）
        for sel, x, y in (
            ("iframe[src*='challenges.cloudflare.com']", 28, 33),
            ("iframe[src*='google.com/recaptcha']", 30, 39),
            ("iframe[src*='hcaptcha.com']", 30, 38),
        ):
            try:
                el = page.locator(sel).first
                if await el.count() and await el.is_visible():
                    await el.click(timeout=3000, position={"x": x, "y": y})
                    return True
            except Exception:
                continue
        # 3) iframe 内 body 的复选框位置点击
        try:
            for frame in page.frames:
                url = (frame.url or "").lower()
                if not any(
                    k in url
                    for k in ("challenges.cloudflare.com", "recaptcha", "turnstile", "hcaptcha")
                ):
                    continue
                x, y = (30, 39) if "recaptcha" in url else (28, 33)
                try:
                    body = frame.locator("body").first
                    if await body.count():
                        await body.click(timeout=3000, position={"x": x, "y": y})
                        return True
                except Exception:
                    continue
        except Exception:
            pass
        # 4) 页面级验证按钮 / 复选框（非 iframe 形态，如简单的“点击验证”）
        for pattern in (
            r"verify you are human",
            r"i'?m not a robot",
            r"confirm you'?re human",
            r"我不是机器人",
            r"点击.{0,4}(验证|确认)",
        ):
            try:
                btn = page.get_by_text(re.compile(pattern, re.IGNORECASE)).first
                if await btn.count() and await btn.is_visible():
                    await btn.click(timeout=3000)
                    return True
            except Exception:
                continue
        return False

    async def _human_intervention(self, page, req: dict, reason: str) -> str:
        """登录页等需要人工身份验证的场景：保持页面打开，等待人工在浏览器中处理。

        返回 "download"（已开始下载）/"cleared"（已通过）/"timeout"（人工等待超时），
        人工跳过 / 停止 / 刷新验证页指令均已处理。human_wait_min=0 表示无限等待。
        """
        human_wait_min = float(req.get("human_wait_min") or 0)
        deadline = time.monotonic() + human_wait_min * 60 if human_wait_min > 0 else None
        self._status(
            req, "auth",
            f"检测到{reason}，浏览器窗口保持打开，请在窗口中完成登录"
            "（完成后自动继续；也可手动点击页面上的下载按钮；"
            "页面卡死时可点“刷新验证页”重试，或在界面中跳过该篇；"
            "验证可能出现在弹出的子窗口中，请勿点击子窗口以外区域，以免子窗口被网站自动关闭）",
        )
        clean_streak = 0
        while True:
            if not self._downloads.empty():
                return "download"
            if self.skip_event.is_set():
                raise SkipRequested("已人工跳过该篇")
            if self.stop_event.is_set():
                raise StopRequested("下载已被停止")
            if self.reload_event.is_set():
                self.reload_event.clear()
                self._status(req, "auth", "正在刷新登录/验证页面（重试）…")
                try:
                    await asyncio.wait_for(
                        page.reload(wait_until="domcontentloaded"), timeout=90
                    )
                except Exception:
                    pass
                await asyncio.sleep(2)  # 给新页面一点加载时间
                clean_streak = 0
                continue
            if deadline is not None and time.monotonic() >= deadline:
                return "timeout"
            state = await self._detect_auth(page)
            if state is None:
                # 连续两次干净检测才认定已通过：页面跳转瞬间的检测失败（unknown）
                # 不能当成“验证已通过”，否则会在验证完成前导航离开、打断验证
                clean_streak += 1
                if clean_streak >= 2:
                    self._status(req, "waiting", "登录/验证已通过，继续尝试自动下载")
                    return "cleared"
            else:
                clean_streak = 0
            await asyncio.sleep(1)

    @staticmethod
    async def _detect_auth(page) -> str | None:
        """识别登录页 / 人机验证 / 反爬拦截页。

        返回原因描述；页面正常且无验证时返回 None；
        页面正在跳转/重载导致无法判定时返回 "unknown"（调用方必须视为“仍在验证”，
        绝不能当成验证已通过——否则会在验证进行到一半时导航离开，导致验证永远无法完成）。
        """
        try:
            signals = await asyncio.wait_for(page.evaluate(_AUTH_SNIFF_JS), timeout=10)
        except Exception:
            return "unknown"
        # 验证已成功（token 已生成）：Turnstile 等成功后 iframe 仍留在页面，
        # 必须先于 cf 判定返回“干净”，否则会把已通过的验证当成仍在验证而误刷新
        if signals.get("verified"):
            return None
        url = page.url or ""
        if signals.get("cf"):
            return "Cloudflare 人机验证"
        if signals.get("pwd"):
            return "登录页（需要输入密码）"
        if signals.get("denied"):
            return "访问受限/反爬拦截页"
        if _AUTH_URL_RE.search(url):
            return "登录/身份验证页"
        return None

    # ------------------------------------------------------------------
    # 下载完成后的落地
    # ------------------------------------------------------------------

    @staticmethod
    def _finalize(
        tmp_path: Path,
        target_dir: Path,
        stem: str,
        paper: Paper,
        meta: dict,
        generate_info: bool,
    ) -> tuple[Path, Path | None]:
        """把浏览器下载的原始文件按命名规则移动/重命名到目标目录，并生成信息文件。"""
        target_dir.mkdir(parents=True, exist_ok=True)
        final_pdf = target_dir / f"{stem}.pdf"
        if final_pdf.exists():
            final_pdf.unlink()
        # 重命名 + 移动到目标目录；原始下载文件随 move 消失（即“删除原下载文件”）
        shutil.move(str(tmp_path), final_pdf)
        try:
            if Path(tmp_path).exists():
                Path(tmp_path).unlink(missing_ok=True)
        except Exception:
            pass
        info_path = None
        if generate_info:
            info_path = write_info_file(paper, target_dir / f"{stem}.txt", extra=meta or {})
        return final_pdf, info_path

    # ------------------------------------------------------------------
    # worker 主循环
    # ------------------------------------------------------------------

    async def serve(self) -> None:
        self._loop = asyncio.get_running_loop()
        inbox: asyncio.Queue = asyncio.Queue()

        def _reader() -> None:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                op = msg.get("op")
                if op == "stop":
                    # 带 target 时只中止对应的 fetch 请求（避免并发请求间误杀）；
                    # 不带 target 为全局停止（“停止下载”按钮）
                    target = msg.get("target")
                    if target is None or target == self.current_fetch_id:
                        self._loop.call_soon_threadsafe(self.stop_event.set)
                    self._loop.call_soon_threadsafe(
                        _emit, {"id": msg.get("id"), "ok": True, "stopped": True}
                    )
                elif op == "skip":
                    self._loop.call_soon_threadsafe(self.skip_event.set)
                    self._loop.call_soon_threadsafe(
                        _emit, {"id": msg.get("id"), "ok": True, "skipped": True}
                    )
                elif op == "reload":
                    self._loop.call_soon_threadsafe(self.reload_event.set)
                    self._loop.call_soon_threadsafe(
                        _emit, {"id": msg.get("id"), "ok": True, "reloaded": True}
                    )
                else:
                    self._loop.call_soon_threadsafe(inbox.put_nowait, msg)
            self._loop.call_soon_threadsafe(inbox.put_nowait, {"op": "eof"})

        threading.Thread(target=_reader, daemon=True, name="browserdl-stdin").start()
        _emit({"type": "ready"})

        while True:
            msg = await inbox.get()
            op = msg.get("op")
            rid = msg.get("id")
            if op == "eof" or op == "shutdown":
                if rid is not None:
                    _emit({"id": rid, "ok": True})
                break
            if op == "ping":
                _emit({"id": rid, "ok": True})
            elif op == "fetch":
                self.current_fetch_id = rid  # 供带 target 的 stop 精确中止
                result = await self._fetch_safe(msg)
                self.current_fetch_id = None
                _emit({"id": rid, **result})
            else:
                _emit({"id": rid, "ok": False, "error": f"未知操作: {op}"})

        await self._teardown_browser()

    async def _fetch_safe(self, req: dict) -> dict:
        try:
            return await self.fetch(req)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return {"ok": False, "error": f"浏览器自动化出错: {exc}"}


def main() -> int:
    # playwright 未安装时立即给出明确失败标记（Node 端会转成安装指引）
    try:
        import playwright  # noqa: F401
    except ImportError:
        _emit({"type": "fatal", "error": "PLAYWRIGHT_MISSING"})
        return 1
    try:
        asyncio.run(BrowserWorker().serve())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
