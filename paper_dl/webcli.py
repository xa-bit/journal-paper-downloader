"""Web 服务用的机器可读接口：所有子命令把结果以 JSON 打印到 stdout。

用法:
    python -m paper_dl.webcli journal "<期刊网址>"
    python -m paper_dl.webcli works --issn 1944-8007 [--cursor CURSOR] [--rows 500]
    python -m paper_dl.webcli fetch --doi 10.xxxx --root /mnt/d/paper --rel "期刊/卷/文章" \
        [--meta '{...}'] [--strategies unpaywall,openalex,publisher] [--no-info] [--overwrite]
    python -m paper_dl.webcli search "<标题>"
    python -m paper_dl.webcli resolve --doi 10.xxxx [--email you@example.com]
    python -m paper_dl.webcli download --doi 10.xxxx [--arxiv ...] --output papers [--overwrite]

成功输出 {"ok": true, ...}，失败输出 {"ok": false, "error": "..."}，退出码 0/1。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .downloader import doi_file_stem, download_pdf, write_info_file
from .journal import fetch_journal_works, resolve_journal
from .resolvers import ResolveError, resolve_arxiv, resolve_doi, search_by_title


def _emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def cmd_journal(args) -> int:
    try:
        journal = resolve_journal(args.url)
    except ResolveError as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1
    _emit({"ok": True, "journal": journal.to_dict()})
    return 0


def cmd_works(args) -> int:
    try:
        works, next_cursor, total, done = fetch_journal_works(
            args.issn, cursor=args.cursor, rows=args.rows
        )
    except ResolveError as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1
    _emit(
        {
            "ok": True,
            "works": [w.to_dict() for w in works],
            "next_cursor": next_cursor,
            "total": total,
            "done": done,
        }
    )
    return 0


def cmd_fetch(args) -> int:
    """按下载清单条目下载：root/rel/<doi尾缀>.pdf + <doi尾缀>.txt。"""
    extra = {}
    if args.meta:
        try:
            extra = json.loads(args.meta)
        except json.JSONDecodeError:
            _emit({"ok": False, "error": "--meta 不是合法 JSON"})
            return 1

    strategies = [s.strip() for s in (args.strategies or "").split(",") if s.strip()]

    try:
        paper = resolve_doi(args.doi, email=args.email)
    except ResolveError as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1

    stem = doi_file_stem(args.doi)
    out_dir = Path(args.root) / args.rel
    try:
        pdf_path = download_pdf(
            paper, out_dir, overwrite=args.overwrite, filename=stem + ".pdf",
            strategies=strategies or None,
        )
    except ResolveError as exc:
        msg = str(exc)
        if not paper.is_oa:
            msg += (
                "（该论文未被 Unpaywall/OpenAlex 标记为开放获取；出版商页面有反爬保护，"
                "程序无法直接下载，可在浏览器中手动获取）"
            )
        _emit({"ok": False, "error": msg, "paper": paper.to_dict()})
        return 1
    info_path = None
    if not args.no_info:
        info_path = write_info_file(paper, out_dir / (stem + ".txt"), extra=extra)
    _emit(
        {
            "ok": True,
            "path": str(pdf_path),
            "info_path": str(info_path) if info_path else None,
            "paper": paper.to_dict(),
        }
    )
    return 0


def cmd_search(args) -> int:
    try:
        papers = search_by_title(" ".join(args.title), rows=args.rows)
    except ResolveError as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1
    _emit({"ok": True, "papers": [p.to_dict() for p in papers]})
    return 0


def _resolve_one(args) -> tuple[object, None] | tuple[None, str]:
    if args.arxiv:
        try:
            return resolve_arxiv(args.arxiv), None
        except ResolveError as exc:
            return None, str(exc)
    if args.doi:
        try:
            return resolve_doi(args.doi, email=args.email), None
        except ResolveError as exc:
            return None, str(exc)
    return None, "必须提供 --doi 或 --arxiv"


def cmd_resolve(args) -> int:
    paper, error = _resolve_one(args)
    if error:
        _emit({"ok": False, "error": error})
        return 1
    _emit({"ok": True, "paper": paper.to_dict()})
    return 0


def cmd_download(args) -> int:
    paper, error = _resolve_one(args)
    if error:
        _emit({"ok": False, "error": error})
        return 1
    try:
        path = download_pdf(paper, Path(args.output), overwrite=args.overwrite)
    except ResolveError as exc:
        _emit({"ok": False, "error": str(exc), "paper": paper.to_dict()})
        return 1
    _emit({"ok": True, "path": str(path), "paper": paper.to_dict()})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="paper-dl-webcli",
        description="journal-paper-downloader 的 JSON 接口（供 Web 服务调用）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_journal = sub.add_parser("journal", help="从期刊网址解析期刊信息（ISSN、标题）")
    p_journal.add_argument("url", help="期刊网址，如 https://www.nature.com/ngeo/")
    p_journal.set_defaults(func=cmd_journal)

    p_works = sub.add_parser("works", help="按 ISSN 拉取期刊文献（Crossref，游标分页）")
    p_works.add_argument("--issn", required=True, help="期刊 ISSN，如 1944-8007")
    p_works.add_argument("--cursor", default="*", help="Crossref 游标（默认从头开始）")
    p_works.add_argument("--rows", type=int, default=500, help="每页数量（默认 500）")
    p_works.set_defaults(func=cmd_works)

    p_fetch = sub.add_parser("fetch", help="按下载清单条目下载 PDF 并生成信息文件")
    p_fetch.add_argument("--doi", required=True, help="论文 DOI")
    p_fetch.add_argument("--root", required=True, help="本地根目录，如 /mnt/d/paper")
    p_fetch.add_argument("--rel", required=True, help="相对子目录，如 期刊名/卷号/文章名")
    p_fetch.add_argument("--meta", help="Crossref 元数据 JSON（journal/volume/issue/date）")
    p_fetch.add_argument("--email", default="paper-dl@localhost", help="提供给 Unpaywall 的邮箱")
    p_fetch.add_argument(
        "--strategies",
        default="",
        help="逗号分隔的下载策略（unpaywall/openalex/publisher，默认全部按解析顺序）",
    )
    p_fetch.add_argument("--no-info", action="store_true", help="不生成信息文件")
    p_fetch.add_argument("--overwrite", action="store_true", help="覆盖已存在的文件")
    p_fetch.set_defaults(func=cmd_fetch)

    p_search = sub.add_parser("search", help="按标题检索候选论文")
    p_search.add_argument("title", nargs="+", help="论文标题（可含空格，无需引号）")
    p_search.add_argument("--rows", type=int, default=8, help="返回候选数量（默认 8）")
    p_search.set_defaults(func=cmd_search)

    p_resolve = sub.add_parser("resolve", help="解析 DOI / arXiv 为论文详情")
    p_resolve.add_argument("--doi", help="论文 DOI")
    p_resolve.add_argument("--arxiv", help="arXiv ID")
    p_resolve.add_argument("--email", default="paper-dl@localhost", help="提供给 Unpaywall 的邮箱")
    p_resolve.set_defaults(func=cmd_resolve)

    p_download = sub.add_parser("download", help="解析并下载一篇论文 PDF")
    p_download.add_argument("--doi", help="论文 DOI")
    p_download.add_argument("--arxiv", help="arXiv ID")
    p_download.add_argument("--email", default="paper-dl@localhost", help="提供给 Unpaywall 的邮箱")
    p_download.add_argument("-o", "--output", default="papers", help="保存目录（默认 papers）")
    p_download.add_argument("--overwrite", action="store_true", help="覆盖已存在的文件")
    p_download.set_defaults(func=cmd_download)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
