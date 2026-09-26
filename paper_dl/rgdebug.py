"""ResearchGate 通道调试入口：单篇 DOI 只走 ResearchGate 下载源，实时打印
每个自动化状态行与最终结果，用于调试“RG 下载是否顺利、无权限判定是否正常”。

用法:
    python -m paper_dl.rgdebug <DOI> [保存目录] [--wait 分钟] [--refresh 次] [--browser chrome]

内部强制 SCIHUB_ENABLED=0 与 OFFICIAL_ENABLED=0：Sci-Hub 与官方页面路径被关闭，
只走 ResearchGate——命中时正常落盘 PDF 并写 researchgate=available 权限；
无公开全文（确定性结论）时写 researchgate=unavailable 并输出判定原因；
页面打不开/反爬拦截等非确定性失败按下载失败结束，绝不写权限记录。

示例:
    python -m paper_dl.rgdebug 10.1103/PhysRevFluids.1.014301 ./papers --wait 2 --refresh 2
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="paper-dl-rgdebug",
        description="单篇 DOI 只走 ResearchGate 下载源的调试入口",
    )
    parser.add_argument("doi", help="文献 DOI，如 10.1103/PhysRevFluids.1.014301")
    parser.add_argument("root", nargs="?", default="papers", help="保存目录（默认 papers）")
    parser.add_argument("--wait", type=int, default=2, help="每页等待分钟数（默认 2）")
    parser.add_argument("--refresh", type=int, default=2, help="无响应最大刷新次数（默认 2）")
    parser.add_argument(
        "--browser", default="chrome",
        help="浏览器（默认 chrome；可选 auto/edge/firefox/safari）",
    )
    args = parser.parse_args()

    # 只走 ResearchGate：关闭 Sci-Hub 与官方页面路径（researchgate 模块在调用时读 env）
    os.environ["SCIHUB_ENABLED"] = "0"
    os.environ["OFFICIAL_ENABLED"] = "0"

    from . import browserdl
    from .downloader import doi_file_stem
    from .resolvers import ResolveError, resolve_doi

    try:
        paper = resolve_doi(args.doi)
    except ResolveError as exc:
        print(f"[rgdebug] 解析 DOI 失败: {exc}", file=sys.stderr)
        return 1

    stem = doi_file_stem(args.doi)
    req = {
        "id": 1,
        "doi": args.doi,
        "root": args.root,
        "stem": stem,
        "rel": "",
        "meta": {},
        "browser": args.browser,
        "wait_minutes": max(1, args.wait),
        "max_refresh": max(0, args.refresh),
        "verify_interval_s": 5,
        "verify_max_fails": 5,
    }

    async def run() -> dict:
        worker = browserdl.BrowserWorker()
        worker._loop = asyncio.get_running_loop()  # 供下载事件的跨线程投递使用
        # _status 直接 _emit 到 stdout（JSON 行），调试时原样透出每个状态
        try:
            return await worker._fetch_safe(req)
        finally:
            try:
                await asyncio.wait_for(worker._teardown_browser(), timeout=20)
            except Exception:
                pass

    access_file = Path(args.root) / f"{stem}.access.json"
    print(f"[rgdebug] DOI={args.doi} 目标 PDF={Path(args.root).resolve() / (stem + '.pdf')}")
    print("[rgdebug] 只走 ResearchGate 通道（SCIHUB_ENABLED=0, OFFICIAL_ENABLED=0），开始…")
    result = asyncio.run(run())
    if result.get("ok"):
        print(f"[rgdebug] ✔ ResearchGate 下载成功: {result.get('path')}")
        return 0
    if access_file.exists():
        print(f"[rgdebug] ✘ 判定无公开全文（确定性结论，已写权限记录）: {result.get('error')}")
        print(f"[rgdebug]    权限记录内容:\n{access_file.read_text(encoding='utf-8')}")
        return 2
    print(f"[rgdebug] ✘ 下载失败（非确定性失败，不写权限记录）: {result.get('error')}")
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
