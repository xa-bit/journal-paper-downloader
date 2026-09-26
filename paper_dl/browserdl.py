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
    {"id": 2, "ok": true, "path": "...", "info_path": "...", "access_path": "...", ...}
    {"id": 2, "ok": false, "error": "...", "skipped": true, "no_access": true,
     "access_path": "..."}                  # access_path：已写入的无权限记录文件

单个任务的流程：
默认先走 Sci-Hub 镜像按 DOI 检索下载（不在界面显示，见 scihub 模块）；Sci-Hub
失败后转 ResearchGate 检索公开全文下载（见 researchgate 模块）；再失败转出版商
官方页面：打开落地页 -> 寻找并点击 PDF 下载入口（失败则尝试出版商直链）
-> 每轮等待 wait_minutes 分钟：期间监测下载队列 / 登录与验证页 / 跳过与停止指令
-> 无响应则刷新页面，最多 max_refresh 次，仍无响应则报错交给下一个任务
（Sci-Hub / ResearchGate 阶段同样遵循等待与刷新这两项设置）
-> 检测到浏览器开始下载 PDF 后等待完成 -> 按命名规则移动/重命名到目标目录
-> 生成信息文件（始终） -> 写入权限记录文件 -> 关闭标签页，等待下一个任务。

无访问权限（付费墙）处理：出版商对无权下载的 PDF 请求通常返回购买/机构登录面板
（Wiley 系返回 "Get access to the full version of this article… Purchase Instant Access"，
或 302 重定向到 /doi/abs/ 摘要页）——检测到即立即跳过该篇（返回 no_access 标记），
不做等待/刷新重试。

权限记录文件（三路径权限）：权限确认后在该文献的保存目录写入 <DOI尾缀>.access.json，
包含三个权限：官方网页权限 official（"granted" 有权限 / "denied" 无权限）、
Sci-Hub 是否收录 scihub（"available" / "unavailable"；unavailable 仅在检索结果
页成功打开并明确报告未收录时标记——镜像打不开 / HTTP 错误 / 网络波动一律按
下载失败处理，不标记）与 ResearchGate 是否有公开全文 researchgate
（"available" / "unavailable"；unavailable 仅在检索/文献页成功打开并明确显示
无公开全文时标记——网页打不开 / 反爬拦截 / 网络波动一律按下载失败处理，不标记）。
各路径只更新自己、保留其他路径的已知状态。Node 服务下载前始终扫描该记录：
仅当三条路径都标记为“无”（official=denied、scihub=unavailable 且
researchgate=unavailable）时该文献才直接跳过。

验证处理分三类：
- 人机验证 / 反爬拦截（Cloudflare Turnstile、“确认您是真人”等）：走自动验证循环——
  存在可点击的验证控件（复选框/验证按钮）时每 verify_interval_s 秒模拟点击一次，
  连续 verify_max_fails 次未通过则刷新页面等待重新验证；这些时间都计入当前轮的等待
  窗口（即“每页等待时间”内），窗口耗尽按“无响应”处理（消耗一次刷新次数）。
  验证通过（连续两次干净检测）不消耗刷新次数。
  Cloudflare 托管型验证页没有可点击控件（会自动完成）：此时被动等待，不点击、
  不刷新——盲目点击/刷新反而会重启验证流程，导致验证永远无法完成。
- 无访问权限（付费墙）：出版商返回购买/机构登录面板（或 302 到摘要页）时立即跳过该篇
  （返回 no_access 标记），不做等待/刷新重试。
- 登录页等身份验证：页面保持打开等待人工处理（human_wait_min=0 表示无限等待），
  可通过 skip/stop/reload 指令跳过、停止或刷新页面重试。
页面正在跳转导致无法判定验证状态时一律视为“仍在验证”，避免在验证完成前导航离开。
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import re
import shutil
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from urllib.parse import urlparse

from .downloader import (
    is_pdf_file_ok,
    read_access_marker,
    write_access_marker,
    write_info_file,
)
from . import researchgate
from . import scihub
from .resolvers import Paper, ResolveError, resolve_doi

# 触发下载时优先点击的页面元素（出版商通用的 PDF 链接形态）
CLICK_SELECTORS = [
    "a[href*='/doi/pdf/']",
    "a[href*='/doi/pdfdirect/']",
    "a[href*='/doi/epdf/']",
    "a[href$='.pdf']",
    # 带查询参数的 PDF 链接（如 eLife /download/.../xxx.pdf?_hash=...，
    # href 不以 .pdf 结尾，a[href$='.pdf'] 匹配不到）
    "a[href*='.pdf?']",
    "a[download]",
]

#: 命中下载入口但实际是插图/附图的链接特征：跳过，继续找真正的文章 PDF
_FIGURE_LINK_RE = re.compile(r"/figs?/|[-_/]fig\d+|fig\d+[-_.]|_fig\d+", re.IGNORECASE)

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
# Cloudflare 托管型验证的被动等待时长：期间不点击、不刷新——验证无需点击、
# 实测约 5-20s 自动完成；过早模拟点击反而会打断/升级验证，使其永远无法通过
CF_PASSIVE_GRACE_SECONDS = 30
# Sci-Hub 镜像停在首页（302 回首页的未收录表现）的判定宽限：15s 无变化才切换
# 下一镜像（给迟到重定向留时间；绝不据此写 scihub=unavailable）
SCIHUB_HOME_REDIRECT_GRACE = 15

PLAYWRIGHT_INSTALL_HINT = (
    "浏览器自动化需要先安装 Playwright 并准备浏览器："
    "pip install playwright && python -m playwright install chromium "
    "（若本机已装 Chrome/Edge 会自动优先使用）"
)


class SkipRequested(RuntimeError):
    """人工跳过当前任务。"""


class StopRequested(RuntimeError):
    """下载被用户停止。"""


class NoAccessError(RuntimeError):
    """当前浏览器会话对该文献没有访问权限（付费墙），立即跳过该篇。"""


class _DirectPdfDownload:
    """inline PDF 浏览页直接取回的“伪 Download”：对齐 Playwright Download 的
    path()/failure()/suggested_filename 接口，后续保存流程与真实下载完全一致。"""

    def __init__(self, path: Path, filename: str):
        self._path = path
        self.suggested_filename = filename

    async def path(self) -> str:
        return str(self._path)

    async def failure(self) -> None:
        return None


def _emit(payload: dict) -> None:
    """输出一行 JSON 并立即刷新（stdout 是与 Node 通信的唯一通道）。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()

# 页面上检测登录 / 人机验证 / 反爬拦截 / 无访问权限的信号（在浏览器内执行）
_AUTH_SNIFF_JS = """() => {
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const pwd = [...document.querySelectorAll('input[type=password]')].some(visible);
  const title = document.title || '';
  const body = ((document.body && document.body.innerText) || '').slice(0, 12000);
  const text = title + ' ' + body;
  // 关键：Turnstile/reCAPTCHA 验证成功后，其 iframe 仍会留在页面上显示“成功”，
  // 不能凭 iframe 存在判定“仍在验证”；验证通过后隐藏 token 输入框会被填值，
  // 以此判定验证已成功（verified=true 时直接视为页面干净，避免误刷新清掉已通过的验证）
  const verified = [...document.querySelectorAll(
    'input[name="cf-turnstile-response"], input[name="g-recaptcha-response"], input[name="h-captcha-response"]'
  )].some((i) => (i.value || '').length > 10);
  // Cloudflare 验证页的标题/正文按浏览器语言本地化（如中文“请稍候…/正在进行安全验证”），
  // 只匹配英文会漏检，导致把验证页当普通页面干等整轮后按“无响应”刷新
  const cf = /just a moment|attention required|verify you are human|checking your browser|performing security verification|请稍候|正在进行安全验证|正在进行安全检查|确认您不是自动程序|请证明您不是机器人/i.test(text)
    || !!document.querySelector('#cf-challenge-running, .cf-browser-verification, #challenge-form, iframe[src*="challenges.cloudflare.com"]');
  const denied = /access denied|request blocked|403 forbidden|are you a robot|unusual traffic/i.test(text);
  // 无访问权限（付费墙）：出版商明确返回购买/租用/机构登录选项——
  // Wiley 系无权下载时 PDF 入口会返回 "Get access to the full version of this article /
  // Purchase Instant Access / $xx" 面板（或直接 302 到 /doi/abs/ 摘要页，见下方 URL 判定），
  // Springer 系付费墙则显示 "Log in via an institution / Buy article PDF 39,95 € /
  // Institutional subscriptions / Subscribe and save" 购买面板
  // ——这类状态刷新/重试无解，必须立即跳过而不是按“无响应”空等。
  // 注意不要收录 “access this article / buy now” 这类泛化短语：
  // 前者会跨词命中 Springer 开放获取页的版权声明（“Open Access This article is licensed…”）
  const paywall = /get access to the full version|purchase instant access|buy article pdf|rent this article|rent article|purchase this article|purchase access|get access to this (article|content)|you (do not|don't) have (access|permission) to (this|the) (article|content|resource)|you do not have full access|access to (this|the) (article|content|resource) (has been|is) denied|not entitled to access|log ?in via an institution|institutional subscriptions?|instant access to the full (article|issue)|subscribe and save|price includes vat/i.test(text);
  return { pwd, cf, denied, paywall, verified, title: title.slice(0, 200), url: location.href };
}"""

_AUTH_URL_RE = re.compile(
    r"(?:^|[./@-])(?:login|signin|log-in|logon|sso|athens|shibboleth|idp|authenticate)(?:[./?#]|$)",
    re.IGNORECASE,
)

#: Wiley 系（Wiley / AGU 等）对无权下载的 PDF 请求 302 重定向到 /doi/abs/ 摘要页
_ABS_REDIRECT_RE = re.compile(r"/doi/abs/", re.IGNORECASE)

#: 无访问权限（付费墙）：检测到立即跳过该篇，不等待、不刷新重试
NO_ACCESS_REASON = "无访问权限"

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
        self._pdf_grab_tried: set[str] = set()  # inline PDF 浏览页已尝试直接取回的 URL

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


    @staticmethod
    def _clean_profile_download_history(profile: Path) -> None:
        """启动浏览器前清理 profile 中的下载历史（downloads / downloads_url_chains）。

        实测：Chrome（153，WSL/WSLg 环境）在 profile 残留上一会话的下载记录
        （History 库 downloads 表）时，下次启动后浏览器进程会在下载/退出时崩溃
        （SIGSEGV/SIGTRAP），Playwright 侧表现为 “Target page, context or
        browser has been closed”，下载必然失败。每次启动前清空这两张表即可规避；
        自动化 profile 本身无需保留下载历史。清理失败不阻塞启动。
        """
        hist = profile / "Default" / "History"
        if not hist.exists():
            return
        try:
            import sqlite3

            db = sqlite3.connect(str(hist), timeout=5)
            try:
                for table in ("downloads", "downloads_url_chains"):
                    try:
                        db.execute(f"DELETE FROM {table}")
                    except sqlite3.OperationalError:
                        pass  # 表不存在（不同版本 schema 差异）
                db.commit()
            finally:
                db.close()
        except Exception:
            pass  # 数据库被占用/损坏等情况不阻塞浏览器启动

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
        # 启动前清理 profile 中的下载历史（见 _clean_profile_download_history 说明）
        self._clean_profile_download_history(profile)

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
        # inline PDF 浏览页直接取回：每个 URL 只尝试一次，失败不反复请求
        self._pdf_grab_tried: set[str] = set()

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
        # 已存在且文件正常的 PDF 才跳过；异常文件（残缺/HTML 错误页）视为不存在，
        # 允许重新下载（_finalize 落地前会先删除旧文件）
        if final_pdf.exists() and is_pdf_file_ok(final_pdf) and not req.get("overwrite"):
            return {"ok": False, "error": f"文件已存在: {final_pdf}"}

        meta = req.get("meta") or {}
        try:
            paper = resolve_doi(doi)
        except ResolveError as exc:
            return {"ok": False, "error": f"解析 DOI 失败: {exc}"}
        # 权限记录（三路径）：配合界面“无权限时跳过”选项做分源门控——
        # 勾选的下载源若已记录无权限则直接跳过该源；未勾选则依旧尝试
        access_rec = await asyncio.to_thread(read_access_marker, target_dir, stem)
        skip_scihub = bool(req.get("skip_scihub")) and access_rec.get("scihub") == "unavailable"
        skip_rg = (
            bool(req.get("skip_researchgate"))
            and access_rec.get("researchgate") == "unavailable"
        )
        skip_official = bool(req.get("skip_official")) and access_rec.get("official") == "denied"

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
            # 默认下载策略（不在界面显示，默认优先）：先走 Sci-Hub 按 DOI 检索下载，
            # 失败（镜像无法打开/未命中/PDF 直链失败）再转 ResearchGate 检索公开全文；
            # 仍失败最后转出版商官方页面。
            # 权限记录按路径写入：Sci-Hub 命中记 scihub=available、全部镜像报告
            # 未命中记 scihub=unavailable；ResearchGate 有公开全文记
            # researchgate=available、明确无公开全文记 researchgate=unavailable；
            # 出版商下载成功记 official=granted、出版商确认无权限记 official=denied
            #（见 _finalize / NoAccessError 处理）
            download = None
            source = "publisher"
            if paper.doi and scihub.scihub_enabled():
                if skip_scihub:
                    self._status(
                        req, "scihub",
                        "权限记录为 Sci-Hub 未收录且已勾选“无权限时跳过”，跳过 Sci-Hub",
                    )
                else:
                    outcome, download = await self._scihub_fetch(
                        page, paper, req, window, max_refresh
                    )
                    if outcome == "download":
                        source = "sci-hub"
                    elif outcome == "not_indexed":
                        # 全部镜像明确报告未收录该 DOI：记 Sci-Hub 路径（保留其他
                        # 路径的已知状态），随后仍回退 ResearchGate / 官方页面尝试
                        try:
                            write_access_marker(
                                paper, target_dir, stem,
                                scihub="unavailable",
                                reason_scihub="Sci-Hub 全部镜像报告未收录该 DOI",
                            )
                        except Exception:
                            pass  # 记录写失败不影响下载流程
            if download is None and paper.doi and researchgate.researchgate_enabled():
                if skip_rg:
                    self._status(
                        req, "researchgate",
                        "权限记录为 ResearchGate 无公开全文且已勾选“无权限时跳过”，跳过 ResearchGate",
                    )
                else:
                    outcome, download, rg_reason = await self._researchgate_fetch(
                        page, paper, req, window, max_refresh
                    )
                    if outcome == "download":
                        source = "researchgate"
                    elif outcome == "no_public_fulltext":
                        # ResearchGate 检索/文献页成功打开并明确显示无公开全文：
                        # 确定性结论，记 researchgate=unavailable（保留其他路径的
                        # 已知状态），随后仍回退官方页面尝试
                        try:
                            write_access_marker(
                                paper, target_dir, stem,
                                researchgate="unavailable",
                                reason_researchgate=rg_reason,
                            )
                        except Exception:
                            pass  # 记录写失败不影响下载流程
            if download is None:
                if skip_official:
                    raise ResolveError(
                        "官方页面权限记录为无权限且已勾选“无权限时跳过”，本篇跳过"
                    )
                if not researchgate.official_enabled():
                    raise ResolveError(
                        "Sci-Hub 与 ResearchGate 均未命中，且官方页面路径已通过 "
                        "OFFICIAL_ENABLED=0 关闭（调试模式），本篇按失败处理"
                    )
                download = await self._run_task(page, paper, req, window, max_refresh)
            self._status(req, "saving", "下载完成，正在按命名规则保存文件…")
            tmp_path = await download.path()
            failure = await download.failure()
            if failure:
                raise ResolveError(f"浏览器下载失败: {failure}")
            saved, info_path, access_path = await asyncio.to_thread(
                self._finalize, Path(tmp_path), target_dir, stem, paper, meta,
                generate_info, source,
            )
            self._status(req, "done", f"已保存: {saved.name}")
            return {
                "ok": True,
                "path": str(saved),
                "info_path": str(info_path) if info_path else None,
                "access_path": str(access_path),
                "paper": paper.to_dict(),
                "suggested": download.suggested_filename,
                "channel": self._channel_used,
                "source": source,
            }
        except NoAccessError as exc:
            # 官方路径无权限已确认：写入 official=denied（合并语义保留 Sci-Hub /
            # ResearchGate 路径的已知状态）；三条路径都标记为无时，下次扫盘直接跳过
            access_path = None
            try:
                access_path = write_access_marker(
                    paper, target_dir, stem, official="denied", reason_official=str(exc)
                )
            except Exception:
                pass  # 记录写失败不影响跳过流程
            note = f"；已在保存目录写入无权限记录: {access_path}" if access_path else ""
            self._status(req, "skipped", str(exc) + note)
            return {
                "ok": False,
                "error": str(exc),
                "no_access": True,
                "skipped": True,
                "access_path": str(access_path) if access_path else None,
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

    # ------------------------------------------------------------------
    # Sci-Hub 默认下载策略（不在界面显示）：镜像按序尝试，失败转官方页面
    # ------------------------------------------------------------------

    async def _scihub_fetch(self, page, paper: Paper, req: dict, window: int, max_refresh: int):
        """按镜像顺序尝试 Sci-Hub DOI 检索 + PDF 下载。

        返回 (outcome, download) 二元组，由调用方转入出版商官方页面流程：
          ("download", Download) —— 下载已完成；
          ("not_indexed", None)  —— 至少一个镜像的 DOI 检索结果页成功打开并渲染，
                                    且明确报告未收录该 DOI（确定性结论，调用方记
                                    scihub=unavailable 权限；三个镜像为同一后端，
                                    一个明确结论即足够）；
          ("failed", None)       —— 其余失败（镜像无法打开/刷新后仍无响应/
                                    PDF 直链失败），非确定性结论，调用方不标记
                                    Sci-Hub 未收录。
        判定原则：scihub 是否收录只以“成功打开的检索结果页”为准——HTTP 错误、
        302 回首页、超时等“网页没打开”的情况一律按下载失败（failed）处理，
        绝不据此判定未收录（避免网络波动误标 scihub=unavailable）。
        镜像策略（见 scihub 模块）：默认第一个，无法打开 30s 后切换下一个。
        延续“每页等待时间”（window）与“无响应最大刷新次数”（max_refresh）
        的数值设置（不在界面单独显示）：单轮等待窗口内无响应（检索结果未
        渲染 / PDF 直链无响应）则刷新页面重试，最多 max_refresh 次，仍无
        响应才切换下一镜像。
        注意：本阶段不写 official 权限——官方网页权限只以出版商官方页面为准。
        """
        doi = str(paper.doi or "").strip()
        if not doi:
            return "failed", None
        mirrors = scihub.SCIHUB_MIRRORS
        for idx, mirror in enumerate(mirrors):
            got = self._pop_download()  # 上一镜像遗留的下载直接取用
            if got is not None:
                return "download", got
            self._status(
                req, "scihub",
                f"正在通过 Sci-Hub 检索 DOI（镜像 {idx + 1}/{len(mirrors)}: {mirror}）…",
            )
            try:
                await asyncio.wait_for(
                    page.goto(
                        scihub.scihub_page_url(mirror, doi),
                        wait_until="commit",
                        timeout=scihub.MIRROR_OPEN_BUDGET * 1000,
                    ),
                    timeout=scihub.MIRROR_OPEN_BUDGET + 5,
                )
            except Exception as exc:
                self._status(
                    req, "scihub",
                    f"镜像 {mirror} 无法打开（{scihub.MIRROR_OPEN_BUDGET}s 预算内: "
                    f"{type(exc).__name__} {str(exc)[:120]}），切换下一镜像",
                )
                continue

            # 页面就绪等待（修复“网页还没加载完就跳下一下载源”）：
            # wait_until="commit" 只等响应开始，此时页面往往还在加载；镜像带
            # Cloudflare 防护时首个响应就是 403 挑战页（“Just a moment…”）。
            # 此前在 goto 一返回就按 HTTP 403/落地首页立即判失败，挑战页还没来得及
            # 自动验证就整组镜像放弃、直接跳下一下载源。现在在“每页等待时间”内
            # 等页面就绪：挑战页走自动验证（通过后浏览器自动重载出检索结果），
            # 停在镜像首页且 15s 无变化才判定该镜像无检索页、切换下一镜像。
            settled = await self._scihub_settle_page(page, req, window, mirror)
            if settled is None:
                continue  # 验证超时/一直未就绪/停在首页：切换下一镜像（提示已打印）

            # 等待窗口内取检索结果并触发下载；无响应则刷新页面重试
            # （延续“每页等待时间” / “无响应最大刷新次数”设置）
            refreshes_left = max_refresh
            info = settled
            while True:
                if info is not None:
                    if info.get("pdfUrl"):
                        got = await self._scihub_download_pdf(
                            page, info["pdfUrl"], req, window
                        )
                        if got is not None:
                            self._status(req, "scihub", f"Sci-Hub 下载成功（{mirror}）")
                            return "download", got
                        # PDF 直链无响应：落到下方“无响应刷新”逻辑重新触发
                    else:  # notFound：检索结果页已成功打开并渲染、明确报告未收录
                        # —— 确定性结论（镜像为同一后端），立即结束
                        self._status(
                            req, "scihub",
                            f"镜像 {mirror} 检索页确认未收录该 DOI，"
                            "转下一下载源（ResearchGate / 官方页面）…",
                        )
                        return "not_indexed", None
                    info = None
                # 刷新前先检查下载队列：等待/验证期间可能已有下载开始（验证通过
                # 后自动重载、页面自动触发等），直接取用，避免刷新冲掉进行中下载
                got = self._pop_download()
                if got is not None:
                    self._status(req, "scihub", f"Sci-Hub 下载成功（{mirror}）")
                    return "download", got
                if refreshes_left > 0:
                    refreshes_left -= 1
                    self._status(
                        req, "scihub",
                        f"页面在 {window // 60} 分钟内无响应，刷新页面"
                        f"（剩余刷新次数 {refreshes_left}）",
                    )
                    try:
                        await asyncio.wait_for(
                            page.reload(wait_until="domcontentloaded"), timeout=90
                        )
                    except Exception:
                        pass
                    # 刷新后重新评估检索结果（镜像 cf / pdfUrl / notFound）
                    info = await self._scihub_wait_result(page, req, window)
                    continue
                self._status(
                    req, "scihub",
                    f"刷新 {max_refresh} 次（每轮 {window // 60} 分钟）后仍无响应，"
                    f"尝试下一镜像",
                )
                break
        self._status(
            req, "scihub",
            "Sci-Hub 全部镜像下载失败（未获得检索页的明确结论），"
            "转下一下载源（ResearchGate / 官方页面）…",
        )
        return "failed", None

    async def _scihub_settle_page(self, page, req: dict, window: int, mirror: str):
        """等待镜像页面就绪并给出可判定的状态（最多 window 秒 = “每页等待时间”）。

        goto(wait_until="commit") 返回时页面通常仍在加载；镜像带 Cloudflare 防护时
        首个响应就是 403 挑战页。本方法在等待窗口内：
        - 出现人机验证 → 预算内走自动验证循环，通过后浏览器自动重载出检索结果；
        - 检索结果可判定（pdfUrl / notFound 标记）→ 原样返回给调用方；
        - 页面停在镜像首页（302 回首页的未收录表现）且 15s 无变化 → 返回 None
          （仅切换下一镜像，绝不写 scihub=unavailable——网络波动也会这样表现）；
        - 预算耗尽仍无结论 → 返回 None（切换下一镜像）。
        """
        deadline = time.monotonic() + window
        home_since = None
        while True:
            if self.skip_event.is_set():
                raise SkipRequested("已人工跳过该篇")
            if self.stop_event.is_set():
                raise StopRequested("下载已被停止")
            if not self._downloads.empty():
                return None  # 下载已在进行：由外层取走
            try:
                info = await asyncio.wait_for(
                    page.evaluate(scihub.PAGE_STATE_JS), timeout=10
                )
            except Exception:
                info = None  # 页面跳转/加载中：下轮再检测
            if info:
                if info.get("cf"):
                    remaining = int(max(5, deadline - time.monotonic()))
                    self._status(req, "auth", "Sci-Hub 镜像出现人机验证，自动验证中…")
                    try:
                        outcome = await self._challenge_wait(
                            page, req, "Cloudflare 人机验证", remaining
                        )
                    except NoAccessError:
                        return None
                    if outcome == "cleared":
                        home_since = None  # 验证通过：重新等结果页
                        continue
                    self._status(
                        req, "scihub",
                        f"镜像 {mirror} 人机验证未通过（{window // 60} 分钟内），切换下一镜像",
                    )
                    return None
                if info.get("pdfUrl") or info.get("notFound"):
                    return info  # 可判定：交给调用方下载 / 记未收录
                # 既非挑战也无可判定标记：若停在镜像首页（302 回首页的未收录表现），
                # 宽限 15s 无变化才判定，给迟到重定向留时间
                final_url = (page.url or "").rstrip("/").split("?")[0]
                if final_url == mirror.rstrip("/"):
                    if home_since is None:
                        home_since = time.monotonic()
                        self._status(req, "scihub", f"镜像 {mirror} 停在首页，等待重定向结果…")
                    elif time.monotonic() - home_since >= SCIHUB_HOME_REDIRECT_GRACE:
                        self._status(
                            req, "scihub",
                            f"镜像 {mirror} 停在首页无检索页"
                            f"（{SCIHUB_HOME_REDIRECT_GRACE}s 无变化），切换下一镜像",
                        )
                        return None
                else:
                    home_since = None  # 已离开首页（重载/跳转中）：重新等待
            if time.monotonic() >= deadline:
                self._status(
                    req, "scihub",
                    f"镜像 {mirror} 在 {window // 60} 分钟内未出现可判定的检索结果，"
                    "切换下一镜像",
                )
                return None
            await asyncio.sleep(2)


    async def _scihub_wait_result(self, page, req: dict, window: int):
        """等待 Sci-Hub 检索结果渲染（最多 window 秒，即“每页等待时间”）。

        返回 PAGE_STATE_JS 的结果 dict（含 pdfUrl / notFound / cf 等）；
        预算耗尽仍无结论返回 None（由外层按“无响应”刷新页面重试）。
        期间出现人机验证则在剩余预算内走自动点击循环（通过后重新检测）；
        验证超时按无响应处理。验证阶段可能抛出的 NoAccessError（页面呈现出版商
        无权限面板）不是 Sci-Hub 的“未收录”结论——Sci-Hub 页上不可信，一律按
        该镜像无响应（下载失败）处理，不写任何权限记录。
        """
        deadline = time.monotonic() + window
        while True:
            if self.skip_event.is_set():
                raise SkipRequested("已人工跳过该篇")
            if self.stop_event.is_set():
                raise StopRequested("下载已被停止")
            if not self._downloads.empty():
                return None  # 下载已在进行：由外层取走
            try:
                info = await asyncio.wait_for(
                    page.evaluate(scihub.PAGE_STATE_JS), timeout=10
                )
            except Exception:
                info = None
            if info:
                if info.get("pdfUrl") or info.get("notFound"):
                    return info
                if info.get("cf"):
                    remaining = int(max(5, deadline - time.monotonic()))
                    self._status(req, "auth", "Sci-Hub 镜像出现人机验证，自动验证中…")
                    try:
                        outcome = await self._challenge_wait(
                            page, req, "Cloudflare 人机验证", remaining
                        )
                    except NoAccessError:
                        # 出版商无权限面板出现在 Sci-Hub 页上不可信：
                        # 按无响应处理（外层刷新重试），绝不映射为“未收录”
                        return None
                    if outcome == "cleared":
                        continue  # 验证通过：重新检测页面状态
                    return None  # 验证超时：放弃该镜像
            if time.monotonic() >= deadline:
                return None
            await asyncio.sleep(2)

    async def _scihub_download_pdf(self, page, pdf_url: str, req: dict, window: int):
        """用浏览器会话下载 Sci-Hub 提供的 PDF 直链；成功返回 Download，失败 None。

        等待下载开始的最长时间为 window（“每页等待时间”）；失败返回 None，
        由外层按“无响应”刷新页面重新触发。带来源页 Referer 导航（文件源
        可能校验 Referer）；download=true 参数强制附件下载（触发下载事件）；
        若文件源返回 inline PDF（无附件头），按 PDF 浏览页直接取回字节
        （等效人工点“保存”）。
        """
        url = scihub.ensure_download_param(pdf_url)
        referrer = page.url or ""
        self._status(req, "scihub", "Sci-Hub 命中，正在下载 PDF…")
        resp = None
        try:
            resp = await asyncio.wait_for(
                page.goto(url, referer=referrer, wait_until="commit", timeout=60000),
                timeout=65,
            )
        except Exception:
            resp = None  # 下载接管导航（ERR_ABORTED）属预期
        if resp is not None:
            try:
                if resp.status >= 400:
                    self._status(req, "scihub", f"PDF 直链返回 HTTP {resp.status}，放弃该镜像")
                    return None
            except Exception:
                pass
        start = time.monotonic()
        html_checked = False
        deadline = start + window
        while time.monotonic() < deadline:
            if not self._downloads.empty():
                return self._pop_download()
            if self.skip_event.is_set():
                raise SkipRequested("已人工跳过该篇")
            if self.stop_event.is_set():
                raise StopRequested("下载已被停止")
            # inline PDF 浏览页兜底（文件源未返回附件头时）
            await self._maybe_grab_inline_pdf(self._pick_active_page(page), req)
            # 20s 后仍无下载：检查是否落到了 HTML 页面（403/404 错误页）
            if not html_checked and time.monotonic() - start > 20:
                html_checked = True
                try:
                    html = await asyncio.wait_for(
                        page.evaluate(
                            "() => ((document.documentElement && "
                            "document.documentElement.outerHTML) || '').slice(0, 300)"
                        ),
                        timeout=5,
                    )
                except Exception:
                    html = ""
                if html and "<html" in html.lower():
                    self._status(req, "scihub", "PDF 直链返回了 HTML 页面（非 PDF），放弃该镜像")
                    return None
            await asyncio.sleep(1)
        return None

    # ------------------------------------------------------------------
    # ResearchGate 下载源（Sci-Hub 之后、官方页面之前）：检索公开全文并下载
    # ------------------------------------------------------------------

    async def _researchgate_fetch(
        self, page, paper: Paper, req: dict, window: int, max_refresh: int
    ):
        """按 DOI 在 ResearchGate 检索公开全文并下载。

        返回三元组 (outcome, download, reason)，由调用方处理：
          ("download", Download, "")            —— 公开全文下载成功；
          ("no_public_fulltext", None, reason)  —— 检索/文献页成功打开并明确显示
                                                   无公开全文（确定性结论，调用方记
                                                   researchgate=unavailable）；
          ("failed", None, "")                  —— 其余失败（页面打不开/反爬拦截/
                                                   登录墙/刷新后仍无响应/PDF 直链
                                                   失败），非确定性结论，不标记。
        判定原则：researchgate 无公开全文只以“检索/文献页成功打开并渲染”为准；
        网页没打开、反爬拦截、跳登录墙等情况一律按下载失败（failed）处理，
        绝不据此判定无公开全文（避免误标 researchgate=unavailable）。
        等待与刷新沿用页面设置：单轮等待窗口 window（“每页等待时间”）内无响应
        则刷新页面重试，最多 max_refresh 次（“无响应最大刷新次数”）。
        注意：本阶段不写 official 权限——官方网页权限只以出版商官方页面为准。
        """
        doi = str(paper.doi or "").strip()
        if not doi:
            return "failed", None, ""
        self._status(req, "researchgate", "正在通过 ResearchGate 检索该 DOI…")
        try:
            await asyncio.wait_for(
                page.goto(
                    researchgate.search_url(doi),
                    wait_until="domcontentloaded",
                    timeout=researchgate.RG_OPEN_BUDGET * 1000,
                ),
                timeout=researchgate.RG_OPEN_BUDGET + 5,
            )
        except Exception as exc:
            self._status(
                req, "researchgate",
                f"ResearchGate 检索页无法打开（{researchgate.RG_OPEN_BUDGET}s 预算内: "
                f"{type(exc).__name__} {str(exc)[:120]}），按下载失败处理，转官方页面…",
            )
            return "failed", None, ""
        # 注意：此处不再按 HTTP 403 立即判失败——ResearchGate 的反爬拦截首响应
        # 就是 403 挑战页（页面尚未加载完），是否可判定交由 _researchgate_wait_state
        # 处理（人机验证走自动点击循环；拦截页/登录墙才会判 failed）。

        stage = "search"
        refreshes_left = max_refresh
        while True:
            got = self._pop_download()  # 上一阶段遗留的下载直接取用
            if got is not None:
                return "download", got, ""
            # search.Search.html?q=<DOI> 常被 ResearchGate 直接 302 到文献页：
            # 检测到已在文献页时跳过检索结果环节，直接进入文献页判定
            if stage == "search" and researchgate.is_publication_url(page.url or ""):
                self._status(req, "researchgate", "ResearchGate 已直接定位到文献页")
                stage = "publication"
                refreshes_left = max_refresh
                continue
            info = await self._researchgate_wait_state(page, req, window, stage)
            if info is not None and info.get("failed"):
                self._status(
                    req, "researchgate",
                    f"ResearchGate 页面不可判定（{info['failed']}），"
                    "按下载失败处理，转官方页面…",
                )
                return "failed", None, ""
            if info is None:
                # 等待窗口内无确定性结论：刷新重试（沿用“无响应最大刷新次数”）
                got = self._pop_download()
                if got is not None:
                    return "download", got, ""
                if refreshes_left > 0:
                    refreshes_left -= 1
                    self._status(
                        req, "researchgate",
                        f"页面在 {window // 60} 分钟内无响应，刷新页面"
                        f"（剩余刷新次数 {refreshes_left}）",
                    )
                    try:
                        await asyncio.wait_for(
                            page.reload(wait_until="domcontentloaded"), timeout=90
                        )
                    except Exception:
                        pass
                    continue
                self._status(
                    req, "researchgate",
                    f"刷新 {max_refresh} 次（每轮 {window // 60} 分钟）后仍无响应，"
                    "ResearchGate 阶段结束，转官方页面…",
                )
                return "failed", None, ""

            if stage == "search":
                if info.get("pubLinks"):
                    # 先确认仍在检索结果页：若 RG 已把 DOI 直接解析跳转到文献页，
                    # 文献页上的“相关文献”链接也会形成 pubLinks——绝不能点它们，
                    # 直接进入文献页判定阶段
                    if researchgate.is_publication_url(page.url or ""):
                        self._status(req, "researchgate", "ResearchGate 已直接定位到文献页")
                        stage = "publication"
                        refreshes_left = max_refresh
                        continue
                    target = info["pubLinks"][0]
                    # 拟人节奏打开文献页：随机短暂停顿后“点击”结果链接（RG 对
                    # 连续 page.goto 直跳的自动化特征拦截很敏感）；点击失败再
                    # 回退为 goto 直跳
                    await asyncio.sleep(random.uniform(1.5, 3.0))
                    m = re.search(r"/publication/(\d+)", target)
                    opened = False
                    if m:
                        try:
                            loc = page.locator(
                                f'a[href*="/publication/{m.group(1)}"]'
                            ).first
                            await loc.click(timeout=8000)
                            opened = True
                            try:
                                await page.wait_for_load_state(
                                    "domcontentloaded", timeout=30000
                                )
                            except Exception:
                                pass
                        except Exception:
                            opened = False  # 点击失败（链接迟渲染等）：goto 回退
                    if not opened:
                        try:
                            await asyncio.wait_for(
                                page.goto(
                                    target,
                                    wait_until="domcontentloaded",
                                    timeout=researchgate.RG_OPEN_BUDGET * 1000,
                                ),
                                timeout=researchgate.RG_OPEN_BUDGET + 5,
                            )
                        except Exception:
                            self._status(
                                req, "researchgate",
                                "文献页无法打开（超时/网络错误），按下载失败处理，转官方页面…",
                            )
                            return "failed", None, ""
                    # 不按 HTTP 403 立即判失败（可能只是还没加载完的反爬挑战页），
                    # 是否可判定交由 _researchgate_wait_state 处理
                    stage = "publication"
                    refreshes_left = max_refresh  # 文献页阶段的刷新次数单独计算
                    continue
                if info.get("noResults"):
                    reason = "ResearchGate 检索页无该 DOI 的文献结果"
                    self._status(req, "researchgate", f"{reason}（确定性结论），转官方页面…")
                    return "no_public_fulltext", None, reason
                # 既无结果也无渲染完成信号：按无响应刷新（落到下方统一处理）
            else:
                if info.get("downloadUrl"):
                    got = await self._researchgate_download_pdf(
                        page, info["downloadUrl"], req, window
                    )
                    if got is not None:
                        self._status(req, "researchgate", "ResearchGate 下载成功")
                        return "download", got, ""
                    # 全文直链无响应/失败：落到下方“无响应刷新”逻辑重新触发
                elif info.get("requestOnly"):
                    # 文献页仅可请求全文：模拟点击 “Request full-text”（向作者请求
                    # 全文）。请求是否被响应不由本流程保证——此处只负责发出请求；
                    # 不标记 researchgate 无权限，随后继续官方页面下载
                    clicked = await self._researchgate_click_request(page, req)
                    if clicked:
                        self._status(
                            req, "researchgate",
                            "已模拟点击 Request full-text 发出全文请求"
                            "（不标记无权限），转官方页面…",
                        )
                    else:
                        self._status(
                            req, "researchgate",
                            "未找到可点击的 Request full-text 入口，转官方页面…",
                        )
                    return "requested", None, ""
                elif info.get("noFulltext"):
                    # “无全文”确定性结论只在仍处于文献页时成立：被重定向走
                    #（如登录墙/首页）属于不可判定，按下载失败处理
                    if not researchgate.is_publication_url(page.url or ""):
                        self._status(
                            req, "researchgate",
                            "页面被重定向离开文献页（登录墙/拦截），无法判定公开全文，"
                            "按下载失败处理，转官方页面…",
                        )
                        return "failed", None, ""
                    reason = "ResearchGate 文献页已完整加载但无公开全文下载入口"
                    self._status(req, "researchgate", f"{reason}（确定性结论），转官方页面…")
                    return "no_public_fulltext", None, reason
                # 页面状态未定（渲染中）：按无响应刷新

    async def _researchgate_click_request(self, page, req: dict) -> bool:
        """模拟点击文献页上的 “Request full-text”（向作者请求全文）。

        点击后若弹出确认对话框（Send / Send request 等）则补一次确认点击。
        请求何时被作者响应无法由本流程控制——本方法只负责发出请求动作，
        返回是否成功点击了请求入口。
        """
        for sel in (
            'button:has-text("Request full-text")',
            'a:has-text("Request full-text")',
            'button:has-text("Request the full-text")',
            '[role="button"]:has-text("Request full-text")',
            'button:has-text("Request full text")',
        ):
            try:
                loc = page.locator(sel).first
                if await loc.count() and await loc.is_visible():
                    await asyncio.sleep(random.uniform(1.0, 2.0))  # 拟人节奏
                    await loc.click(timeout=8000)
                    self._status(req, "researchgate", "已点击 Request full-text 请求全文")
                    # RG 可能弹出确认对话框：补一次确认点击（找不到就跳过）
                    await asyncio.sleep(1.5)
                    for confirm in (
                        'button:has-text("Send request")',
                        'button:has-text("Send")',
                        'button:has-text("Confirm")',
                    ):
                        try:
                            c = page.locator(confirm).first
                            if await c.count() and await c.is_visible():
                                await c.click(timeout=5000)
                                self._status(req, "researchgate", "已确认发送全文请求")
                                break
                        except Exception:
                            continue
                    return True
            except Exception:
                continue
        return False

    async def _researchgate_wait_state(self, page, req: dict, window: int, stage: str):
        """等待 ResearchGate 页面呈现确定性结论（最多 window 秒 = “每页等待时间”）。

        返回 dict：
          search 阶段：{pubLinks: [...]}（命中文献结果）/ {noResults: true}
                       （页面渲染完成但没有任何文献结果）；
          publication 阶段：{downloadUrl: "..."}（公开全文下载入口）/
                       {requestOnly: true}（仅可请求全文）/
                       {noFulltext: true}（渲染完成且无任何下载/请求入口）；
          {failed: "..."}（反爬拦截页 / 跳登录墙，无法判定，不写权限记录）。
        返回 None：预算耗尽仍无结论（外层按“无响应”刷新页面重试）。
        渲染宽限：判定“无结果/无全文”前，页面须已渲染并保持 RG_RESULT_GRACE 秒
        无变化（防止 React 迟渲染把“可下载”误判成“无全文”）。
        期间出现人机验证则在剩余预算内走自动点击循环（通过后重新检测）。
        """
        deadline = time.monotonic() + window
        rendered_since = None
        while True:
            if self.skip_event.is_set():
                raise SkipRequested("已人工跳过该篇")
            if self.stop_event.is_set():
                raise StopRequested("下载已被停止")
            if not self._downloads.empty():
                return None  # 下载已在进行：由外层取走
            try:
                info = await asyncio.wait_for(
                    page.evaluate(researchgate.PAGE_STATE_JS), timeout=10
                )
            except Exception:
                info = None
            if info:
                if info.get("cf"):
                    remaining = int(max(5, deadline - time.monotonic()))
                    self._status(req, "auth", "ResearchGate 出现人机验证，自动验证中…")
                    try:
                        outcome = await self._challenge_wait(
                            page, req, "Cloudflare 人机验证", remaining
                        )
                    except NoAccessError:
                        # 无权限面板出现在 ResearchGate 页上不可信：按无响应处理，
                        # 绝不映射为“无公开全文”
                        return None
                    if outcome == "cleared":
                        rendered_since = None  # 验证通过：重新积累渲染宽限
                        continue
                    return None  # 验证超时：放弃（外层按无响应刷新）
                if info.get("blocked"):
                    return {"failed": "ResearchGate 反爬拦截页（403/限流）"}
                if info.get("loginWall"):
                    return {"failed": "ResearchGate 跳转登录墙（未登录不可判定）"}
                if stage == "search":
                    if info.get("pubLinks"):
                        return {"pubLinks": info["pubLinks"]}
                    if info.get("rendered"):
                        if rendered_since is None:
                            rendered_since = time.monotonic()
                        elif time.monotonic() - rendered_since >= researchgate.RG_RESULT_GRACE:
                            return {"noResults": True}
                else:
                    if info.get("downloadUrl"):
                        return {"downloadUrl": info["downloadUrl"]}
                    if info.get("requestOnly"):
                        return {"requestOnly": True}
                    if info.get("rendered"):
                        if rendered_since is None:
                            rendered_since = time.monotonic()
                        elif time.monotonic() - rendered_since >= researchgate.RG_RESULT_GRACE:
                            return {"noFulltext": True}
            if time.monotonic() >= deadline:
                return None
            await asyncio.sleep(2)

    async def _researchgate_download_pdf(self, page, pdf_url: str, req: dict, window: int):
        """用浏览器会话下载 ResearchGate 公开全文直链；成功返回 Download，失败 None。

        等待下载开始的最长时间为 window（“每页等待时间”）；失败返回 None，
        由外层按“无响应”刷新页面重新触发。带来源页 Referer 导航；若文件源
        返回 inline PDF（无附件头），按 PDF 浏览页直接取回字节（等效人工点“保存”）。
        """
        referrer = page.url or ""
        self._status(req, "researchgate", "ResearchGate 命中公开全文，正在下载 PDF…")
        resp = None
        try:
            resp = await asyncio.wait_for(
                page.goto(pdf_url, referer=referrer, wait_until="commit", timeout=60000),
                timeout=65,
            )
        except Exception:
            resp = None  # 下载接管导航（ERR_ABORTED）属预期
        if resp is not None:
            try:
                if resp.status >= 400:
                    self._status(req, "researchgate", f"全文直链返回 HTTP {resp.status}，放弃")
                    return None
            except Exception:
                pass
        start = time.monotonic()
        html_checked = False
        deadline = start + window
        while time.monotonic() < deadline:
            if not self._downloads.empty():
                return self._pop_download()
            if self.skip_event.is_set():
                raise SkipRequested("已人工跳过该篇")
            if self.stop_event.is_set():
                raise StopRequested("下载已被停止")
            # inline PDF 浏览页兜底（文件源未返回附件头时）
            await self._maybe_grab_inline_pdf(self._pick_active_page(page), req)
            # 20s 后仍无下载：检查是否落到了 HTML 页面（403/404/登录错误页）
            if not html_checked and time.monotonic() - start > 20:
                html_checked = True
                try:
                    html = await asyncio.wait_for(
                        page.evaluate(
                            "() => ((document.documentElement && "
                            "document.documentElement.outerHTML) || '').slice(0, 300)"
                        ),
                        timeout=5,
                    )
                except Exception:
                    html = ""
                if html and "<html" in html.lower():
                    self._status(req, "researchgate", "全文直链返回了 HTML 页面（非 PDF），放弃")
                    return None
            await asyncio.sleep(1)
        return None

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
            # 触发下载后立刻复查：出版商无权下载时（购买/机构登录面板、重定向到摘要页）
            # 立即跳过该篇，不再进入整轮等待
            await self._raise_if_no_access(page)
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

        无访问权限（付费墙）不等待、不重试，直接抛 NoAccessError 跳过该篇。
        返回 "download"（已开始下载）/"cleared"（已通过）/"timeout"（窗口/人工等待超时），
        人工跳过 / 停止以异常抛出。
        """
        if reason == NO_ACCESS_REASON:
            raise NoAccessError(
                "出版商页面显示当前会话没有该文献的访问权限（需购买或机构登录），已立即跳过该篇"
            )
        if reason in CHALLENGE_REASONS:
            return await self._challenge_wait(page, req, reason, window)
        return await self._human_intervention(page, req, reason)

    async def _challenge_wait(
        self, page, req: dict, reason: str, window: int
    ) -> str:
        """人机验证循环（受本轮等待窗口约束，时间计入“每页等待时间”）：

        - 先被动等待 CF_PASSIVE_GRACE_SECONDS 秒：Cloudflare 托管型验证无需点击、
          会自动完成（实测约 5-20s），期间任何点击/刷新都会重启验证、导致永远无法完成；
        - 超过被动等待仍未通过（存在必须点击的交互式验证控件）时，每 verify_interval_s 秒
          对验证控件模拟点击一次；连续 verify_max_fails 次点击仍未通过 → 刷新页面重新验证
          （刷新后重新进入被动等待）；
        - 窗口耗尽仍未通过 → 返回 "timeout"，由外层按“无响应”逻辑刷新或放弃；
        - 期间检测到下载开始 → 返回 "download"；验证通过（连续两次干净检测）→ "cleared"。
        """
        verify_interval = int(req.get("verify_interval_s") or 5)
        verify_max_fails = int(req.get("verify_max_fails") or 5)
        deadline = time.monotonic() + window
        next_click = time.monotonic() + 1  # 给验证页 1s 渲染时间，然后立即处理一次
        passive_until = time.monotonic() + CF_PASSIVE_GRACE_SECONDS
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
                passive_until = time.monotonic() + CF_PASSIVE_GRACE_SECONDS
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
            if state == NO_ACCESS_REASON:
                # 验证已通过/跳转后落到出版商的无权限页（购买/机构登录面板）：
                # 刷新与点击都无解，立即跳过该篇
                raise NoAccessError(
                    "已通过人机验证，但出版商显示当前会话没有该文献的访问权限"
                    "（需购买或机构登录），已立即跳过该篇"
                )
            if state is None:
                # 需连续两次干净检测（间隔 > 1s）才认定验证通过，避免页面跳转瞬间误判
                clean_streak += 1
                if clean_streak >= 2:
                    self._status(req, "waiting", "已通过人机验证，继续尝试自动下载")
                    return "cleared"
                continue
            clean_streak = 0
            if now >= next_click:
                if now < passive_until:
                    # 被动等待期：托管型验证无需点击、会自动完成；不点击、不计失败
                    self._status(
                        req, "auth",
                        "人机验证自动进行中（托管型验证无需点击），等待验证完成；"
                        "也可在浏览器窗口/子窗口中手动完成验证，通过后自动继续",
                    )
                    next_click = time.monotonic() + verify_interval
                else:
                    try:
                        clicked = await self._try_auto_verify(page)
                    except Exception:
                        clicked = False
                    if not clicked:
                        # 页面没有可点击的验证控件：继续被动等待，不刷新
                        # （刷新会重启验证流程，反而永远无法完成）
                        self._status(
                            req, "auth",
                            "人机验证自动进行中（未找到可点击的验证控件），等待验证完成；"
                            "也可在浏览器窗口/子窗口中手动完成验证，通过后自动继续",
                        )
                        next_click = time.monotonic() + verify_interval
                    else:
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
                            passive_until = time.monotonic() + CF_PASSIVE_GRACE_SECONDS
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
                # 每秒顺带检测无权限页：无权下载时立即抛出跳过，不空等 6s
                await self._raise_if_no_access(page)
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
                if not (await loc.count() and await loc.is_visible()):
                    continue
                # 排除指向插图/附图的链接（如 eLife 页面 figure 的 PDF 版本），
                # 避免把图片当成文章 PDF 下载
                try:
                    href = await loc.get_attribute("href") or ""
                except Exception:
                    href = ""
                if _FIGURE_LINK_RE.search(href):
                    continue
                candidates.append((loc, href))
                break
            except Exception:
                continue
        if not candidates:
            try:
                link = page.get_by_role("link", name=re.compile(r"pdf", re.IGNORECASE)).first
                if await link.count() and await link.is_visible():
                    try:
                        lhref = await link.get_attribute("href") or ""
                    except Exception:
                        lhref = ""
                    if not _FIGURE_LINK_RE.search(lhref):
                        candidates.append((link, lhref))
            except Exception:
                pass
        for loc, href in candidates[:2]:
            if await attempt("点击文章页上的 PDF 链接", lambda l=loc: l.click(timeout=10000)):
                return
            # 点击未生效（出版商用 JS 拦截点击事件，如 eLife 的 “Article PDF” 链接）：
            # 直接导航到链接地址（带来源 Referer），等效用户右键“在新标签页打开”
            if href and href.startswith("http"):
                if await attempt(
                    f"直接访问页面 PDF 入口 {href[:80]}",
                    lambda u=href, r=referrer: page.goto(
                        u, referer=r, wait_until="commit", timeout=60000
                    ),
                ):
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

    async def _maybe_grab_inline_pdf(self, page, req: dict | None) -> bool:
        """当前页面是浏览器内置 PDF 浏览页时，直接取回文件内容保存。

        Edge / Chrome 对 inline PDF（Content-Type: application/pdf 且无附件头）
        不触发下载事件，而是进入内置 PDF 浏览页——并非没有下载连接，真人点一下
        浏览页的“保存”即可下载。这里用浏览器会话（带 Cookie / 指纹）直接 GET 该
        地址取回字节，校验 %PDF 魔数后以伪 Download 入队，等效于点了“保存”。
        成功入队返回 True；不是 PDF 浏览页或取回失败返回 False。
        """
        url = (page.url or "").strip()
        if not url.lower().split("?", 1)[0].endswith(".pdf"):
            return False
        if url in self._pdf_grab_tried:
            return False
        self._pdf_grab_tried.add(url)
        if req is not None:
            self._status(req, "saving", "页面为 PDF 浏览页（无下载事件），直接取回文件内容保存…")
        try:
            resp = await asyncio.wait_for(
                # 与浏览器上下文共享 Cookie 的 API 请求；带 referer 降低被拦概率
                self._context.request.get(url, headers={"referer": url}, timeout=60000),
                timeout=65,
            )
            body = await resp.body()
        except Exception:
            return False
        if not body or b"%PDF-" not in body[:1024] or b"%%EOF" not in body[-2048:]:
            return False  # 拿到的不是完整 PDF（HTML 错误页 / 截断），交回常规流程
        filename = os.path.basename(urlparse(url).path) or "paper.pdf"
        fd, tmp_name = tempfile.mkstemp(suffix=".pdf", prefix="pdl-inline-")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(body)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            return False
        self._downloads.put_nowait(_DirectPdfDownload(Path(tmp_name), filename))
        return True

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
                # Edge / Chrome 的 inline PDF 浏览页不产生下载事件：
                # 检测到当前页是 PDF 浏览页时直接取回内容保存（等效人工点“保存”）
                if await self._maybe_grab_inline_pdf(page, req):
                    return "download"
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
        # 3) iframe 内 body 的复选框位置点击（仅可见的验证控件；隐藏的挑战 iframe 不点击，
        #    托管型验证无需点击、会自动完成）
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
                    if await body.count() and await body.is_visible():
                        await body.click(timeout=3000, position={"x": x, "y": y})
                        return True
                except Exception:
                    continue
        except Exception:
            pass
        # 4) 页面级验证按钮 / 复选框（非 iframe 形态，如简单的“点击验证”）。
        #    注意：只匹配自定义控件文案，不能匹配 Cloudflare 验证页的固定文案
        #    （"verify you are human" 等——那是托管型验证页的说明文字，点击会打断验证）
        for pattern in (
            r"i'?m not a robot",
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
            if state == NO_ACCESS_REASON:
                # 登录/验证流程结束后落到出版商的无权限页（购买/机构登录面板）：
                # 即使人工登录也无权下载，立即跳过该篇
                raise NoAccessError(
                    "登录后出版商仍显示当前会话没有该文献的访问权限（需购买或机构登录），已立即跳过该篇"
                )
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
        """识别登录页 / 人机验证 / 反爬拦截页 / 无访问权限（付费墙）。

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
        # 付费墙优先于“访问受限/反爬拦截”判定：无权下载刷新无解，必须立即跳过；
        # 登录页优先于付费墙判定——带密码输入框的登录页可能同时展示购买/机构登录选项，
        # 留给人工处理（登录后可能就有权限）
        if signals.get("paywall") or _ABS_REDIRECT_RE.search(url):
            return NO_ACCESS_REASON
        if signals.get("denied"):
            return "访问受限/反爬拦截页"
        if _AUTH_URL_RE.search(url):
            return "登录/身份验证页"
        return None

    async def _raise_if_no_access(self, page) -> None:
        """页面显示无访问权限（付费墙）时立即抛出 NoAccessError，由 fetch 转为跳过该篇。"""
        if await self._detect_auth(page) == NO_ACCESS_REASON:
            raise NoAccessError(
                "出版商页面显示当前会话没有该文献的访问权限（需购买或机构登录），已立即跳过该篇"
            )

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
        source: str = "publisher",
    ) -> tuple[Path, Path | None, Path]:
        """把浏览器下载的原始文件按命名规则移动/重命名到目标目录，并生成信息文件与权限记录。

        source 为下载来源（"sci-hub" / "researchgate" / "publisher"）：下载成功即
        该路径权限确认，按来源写入对应权限字段（合并语义保留其他路径的已知状态）。
        """
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
        # 下载成功即该路径权限确认：写入权限记录（三路径权限），供下载前扫描
        # （始终开启）判断——仅当 official=denied、scihub=unavailable 且
        # researchgate=unavailable 三者皆无时才跳过
        if source == "sci-hub":
            access_path = write_access_marker(paper, target_dir, stem, scihub="available")
        elif source == "researchgate":
            access_path = write_access_marker(paper, target_dir, stem, researchgate="available")
        else:
            access_path = write_access_marker(paper, target_dir, stem, official="granted")
        return final_pdf, info_path, access_path

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
