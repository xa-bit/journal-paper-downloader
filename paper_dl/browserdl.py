"""浏览器自动化下载模块（Playwright）。

以持久化 worker 进程方式运行：``python -m paper_dl.browserdl``。
通过 stdin/stdout 的 JSON 行协议与 Node 服务通信：

请求（stdin）:
    {"id": 1, "op": "ping"}
    {"id": 2, "op": "fetch", "doi": "...", "root": "...", "rel": "期刊/卷/文章",
     "stem": "2025JC023188", "meta": {...}, "email": "...",
     "wait_minutes": 5, "max_refresh": 3, "human_wait_min": 0,
     "generate_info": true, "overwrite": false}
    {"id": 3, "op": "stop"}     # 中止当前 fetch（不关闭浏览器）
    {"id": 4, "op": "skip"}     # 人工跳过当前 fetch
    {"id": 5, "op": "shutdown"} # 关闭浏览器并退出

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
遇到登录 / 人机验证 / 访问受限时，保持页面打开等待人工在浏览器窗口中处理
（human_wait_min=0 表示无限等待，可通过 skip/stop 指令退出）。
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
from .resolvers import UNPAYWALL_EMAIL, Paper, ResolveError, resolve_doi

# 触发下载时优先点击的页面元素（出版商通用的 PDF 链接形态）
CLICK_SELECTORS = [
    "a[href*='/doi/pdf/']",
    "a[href*='/doi/pdfdirect/']",
    "a[href*='/doi/epdf/']",
    "a[href$='.pdf']",
    "a[download]",
]

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
  const cf = /just a moment|attention required|verify you are human|checking your browser/i.test(title)
    || !!document.querySelector('#cf-challenge-running, .cf-browser-verification, #challenge-form, iframe[src*="challenges.cloudflare.com"]');
  const denied = /access denied|request blocked|403 forbidden|are you a robot|unusual traffic/i.test(title + ' ' + body);
  return { pwd, cf, denied, title: title.slice(0, 200) };
}"""

_AUTH_URL_RE = re.compile(
    r"(?:^|[./@-])(?:login|signin|log-in|logon|sso|athens|shibboleth|idp|authenticate)(?:[./?#]|$)",
    re.IGNORECASE,
)


class BrowserWorker:
    """维护一个可复用的真实浏览器实例，按队列逐篇执行浏览器自动化下载。"""

    def __init__(self) -> None:
        self.stop_event = asyncio.Event()
        self.skip_event = asyncio.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._pw = None
        self._context = None
        self._channel_used = ""
        self._downloads: asyncio.Queue = asyncio.Queue()
        self._stray_pages: set = set()

    # ------------------------------------------------------------------
    # 浏览器生命周期
    # ------------------------------------------------------------------

    @staticmethod
    def _profile_dir() -> Path:
        """浏览器用户数据目录：跨会话保留 Cookie / 登录态。"""
        if sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
            base = Path(os.environ["LOCALAPPDATA"])
        elif sys.platform == "darwin":
            base = Path.home() / "Library" / "Caches"
        else:
            base = Path.home() / ".cache"
        return base / "journal-paper-downloader" / "browser-profile"

    async def _ensure_browser(self) -> None:
        if self._context is not None:
            return
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise ResolveError(PLAYWRIGHT_INSTALL_HINT) from exc

        self._pw = await async_playwright().start()
        profile = self._profile_dir()
        profile.mkdir(parents=True, exist_ok=True)

        errors: list[str] = []
        for channel in ("chrome", "msedge", None):
            kwargs: dict = {
                "user_data_dir": str(profile),
                "headless": False,
                "accept_downloads": True,
                "no_viewport": True,
                "args": ["--disable-blink-features=AutomationControlled", "--start-maximized"],
            }
            if channel:
                kwargs["channel"] = channel
            try:
                self._context = await self._pw.chromium.launch_persistent_context(**kwargs)
                self._channel_used = channel or "chromium"
                break
            except Exception as exc:  # 逐个渠道回退
                errors.append(f"{channel or 'chromium(内置)'}: {exc}")
        if self._context is None:
            await self._teardown_browser()
            hint = ""
            if sys.platform.startswith("linux") and not (
                os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
            ):
                hint = "（当前是无图形输出的 Linux/WSL 环境，需要 WSLg 或 X 服务器才能弹出浏览器窗口）"
            if all(" chromium(内置)" in e for e in errors) and errors:
                hint += "；也可先执行 python -m playwright install chromium 安装内置浏览器"
            raise ResolveError(
                "无法启动自动化浏览器（已依次尝试 Chrome / Edge / 内置 Chromium）" + hint + ": "
                + " | ".join(errors)
            )

        self._context.on("download", self._on_download)
        self._context.on("page", self._on_page)

    def _on_download(self, download) -> None:
        # 任何标签页开始的下载都进入队列，由当前任务消费
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._downloads.put_nowait, download)

    def _on_page(self, page) -> None:
        self._stray_pages.add(page)

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
        self._drain_downloads()

        wait_minutes = float(req.get("wait_minutes") or 5)
        window = max(MIN_WINDOW_SECONDS, int(wait_minutes * 60))
        max_refresh = int(req.get("max_refresh") if req.get("max_refresh") is not None else 3)
        max_refresh = max(0, max_refresh)
        rounds = max_refresh + 1  # 初始加载 + N 次刷新
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

        email = str(req.get("email") or UNPAYWALL_EMAIL)
        meta = req.get("meta") or {}
        try:
            paper = resolve_doi(doi, email=email)
        except ResolveError as exc:
            return {"ok": False, "error": f"解析 DOI 失败: {exc}"}

        try:
            await self._ensure_browser()
        except ResolveError as exc:
            return {"ok": False, "error": str(exc)}

        task_pages: list = []
        page = await self._context.new_page()
        task_pages.append(page)
        for stray in list(self._stray_pages):
            self._stray_pages.discard(stray)

        try:
            download = await self._run_task(page, paper, req, window, rounds)
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
            for p in task_pages:
                try:
                    await p.close()
                except Exception:
                    pass
            for p in list(self._stray_pages):
                self._stray_pages.discard(p)
                try:
                    await p.close()
                except Exception:
                    pass
            self._drain_downloads()

    async def _run_task(self, page, paper: Paper, req: dict, window: int, rounds: int):
        """打开页面并按 等待/刷新/人工干预 循环触发下载，返回完成的 Download。"""
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

        for rnd in range(1, rounds + 1):
            self._status(
                req, "waiting",
                f"等待页面响应（第 {rnd}/{rounds} 轮，每轮最长 {window // 60} 分钟）",
            )
            reason = await self._detect_auth(page)
            if reason:
                outcome = await self._human_intervention(page, req, reason)
                if outcome == "download":
                    got = self._pop_download()
                    if got is not None:
                        return got
                if outcome == "skip":
                    raise SkipRequested("已人工跳过该篇")
                if outcome == "stop":
                    raise StopRequested("下载已被停止")

            await self._trigger_download(page, paper)
            outcome = await self._wait_window(page, req, window)

            if outcome == "download":
                got = self._pop_download()
                if got is not None:
                    return got
            if outcome == "skip":
                raise SkipRequested("已人工跳过该篇")
            if outcome == "stop":
                raise StopRequested("下载已被停止")
            if outcome == "auth":
                reason = await self._detect_auth(page) or "登录/验证"
                outcome = await self._human_intervention(page, req, reason)
                if outcome == "download":
                    got = self._pop_download()
                    if got is not None:
                        return got
                if outcome == "skip":
                    raise SkipRequested("已人工跳过该篇")
                if outcome == "stop":
                    raise StopRequested("下载已被停止")
                continue  # 验证已通过，下一轮重新尝试自动下载

            # 超时：刷新或放弃
            if rnd < rounds:
                self._status(
                    req, "refreshing",
                    f"页面在 {window // 60} 分钟内无下载响应，刷新页面（刷新 {rnd}/{rounds - 1}）",
                )
                try:
                    await asyncio.wait_for(
                        page.reload(wait_until="domcontentloaded"), timeout=90
                    )
                except Exception:
                    pass
            else:
                raise ResolveError(
                    f"等待 {rounds} 轮（每轮 {window // 60} 分钟）后页面仍无下载响应，已放弃: {page.url}"
                )
        raise ResolveError("未能获取下载")

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

    async def _trigger_download(self, page, paper: Paper) -> None:
        """在页面上寻找并触发 PDF 下载；失败不抛错（由等待/刷新逻辑兜底）。"""
        # 1) 点击页面上的 PDF 链接 / 按钮（最接近人工操作）
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
            try:
                await loc.click(timeout=10000)
                return
            except Exception:
                continue

        # 2) 退而求其次：直接访问 citation_pdf_url / 出版商规范直链
        urls: list[str] = []
        try:
            meta_url = await page.eval_on_selector(
                "meta[name='citation_pdf_url']", "el => el.content"
            )
            if meta_url:
                urls.append(meta_url)
        except Exception:
            pass
        for url, source in zip(paper.pdf_urls, paper.pdf_sources):
            if source == "publisher" and url not in urls:
                urls.append(url)
        for url in urls[:2]:
            try:
                await asyncio.wait_for(
                    page.goto(url, wait_until="commit", timeout=60000), timeout=65
                )
                return
            except Exception:
                # 导航被下载接管（ERR_ABORTED）或被拦截，都交给等待窗口判断
                continue

    async def _wait_window(self, page, req: dict, window: int) -> str:
        """在一个等待窗口内监听：下载事件 / 跳过 / 停止 / 出现登录验证 / 超时。"""
        deadline = time.monotonic() + window
        next_auth_check = time.monotonic() + 5
        while True:
            if not self._downloads.empty():
                return "download"
            if self.skip_event.is_set():
                return "skip"
            if self.stop_event.is_set():
                return "stop"
            now = time.monotonic()
            if now >= next_auth_check:
                next_auth_check = now + 5
                if await self._detect_auth(page):
                    return "auth"
            if now >= deadline:
                return "timeout"
            await asyncio.sleep(0.5)

    async def _human_intervention(self, page, req: dict, reason: str) -> str:
        """检测到登录 / 验证 / 拦截：页面保持打开，等待人工在浏览器中处理。

        返回 "download"（已开始下载）/"cleared"（验证已通过）/"timeout"（人工等待超时），
        人工跳过 / 停止则以异常抛出。human_wait_min=0 表示无限等待。
        """
        human_wait_min = float(req.get("human_wait_min") or 0)
        deadline = time.monotonic() + human_wait_min * 60 if human_wait_min > 0 else None
        self._status(
            req, "auth",
            f"检测到{reason}，浏览器窗口保持打开，请在窗口中完成登录/验证"
            "（完成后自动继续；也可手动点击页面上的下载按钮，或在界面中跳过该篇）",
        )
        while True:
            if not self._downloads.empty():
                return "download"
            if self.skip_event.is_set():
                raise SkipRequested("已人工跳过该篇")
            if self.stop_event.is_set():
                raise StopRequested("下载已被停止")
            if deadline is not None and time.monotonic() >= deadline:
                return "timeout"
            if await self._detect_auth(page) is None:
                self._status(req, "waiting", "验证已通过，继续尝试自动下载")
                return "cleared"
            await asyncio.sleep(1)

    @staticmethod
    async def _detect_auth(page) -> str | None:
        """识别登录页 / 人机验证 / 反爬拦截页；返回原因描述，正常页面返回 None。"""
        try:
            signals = await asyncio.wait_for(page.evaluate(_AUTH_SNIFF_JS), timeout=10)
        except Exception:
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
                    self._loop.call_soon_threadsafe(self.stop_event.set)
                    self._loop.call_soon_threadsafe(
                        _emit, {"id": msg.get("id"), "ok": True, "stopped": True}
                    )
                elif op == "skip":
                    self._loop.call_soon_threadsafe(self.skip_event.set)
                    self._loop.call_soon_threadsafe(
                        _emit, {"id": msg.get("id"), "ok": True, "skipped": True}
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
                result = await self._fetch_safe(msg)
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
