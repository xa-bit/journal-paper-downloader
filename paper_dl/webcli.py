"""Web 服务用的机器可读接口：所有子命令把结果以 JSON 打印到 stdout。

用法:
    python -m paper_dl.webcli journal "<期刊网址>"
    python -m paper_dl.webcli works --issn 1944-8007 [--cursor CURSOR] [--rows 500]
    python -m paper_dl.webcli search "<标题>"
    python -m paper_dl.webcli resolve --doi 10.xxxx [--arxiv ...]

成功输出 {"ok": true, ...}，失败输出 {"ok": false, "error": "..."}，退出码 0/1。
下载统一由浏览器自动化完成（python -m paper_dl.browserdl，由 Web 服务拉起）。
"""

from __future__ import annotations

import argparse
import json

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


def cmd_search(args) -> int:
    try:
        papers = search_by_title(" ".join(args.title), rows=args.rows)
    except ResolveError as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1
    _emit({"ok": True, "papers": [p.to_dict() for p in papers]})
    return 0


def cmd_resolve(args) -> int:
    if args.arxiv:
        try:
            paper = resolve_arxiv(args.arxiv)
        except ResolveError as exc:
            _emit({"ok": False, "error": str(exc)})
            return 1
    elif args.doi:
        try:
            paper = resolve_doi(args.doi)
        except ResolveError as exc:
            _emit({"ok": False, "error": str(exc)})
            return 1
    else:
        _emit({"ok": False, "error": "必须提供 --doi 或 --arxiv"})
        return 1
    _emit({"ok": True, "paper": paper.to_dict()})
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

    p_search = sub.add_parser("search", help="按标题检索候选论文")
    p_search.add_argument("title", nargs="+", help="论文标题（可含空格，无需引号）")
    p_search.add_argument("--rows", type=int, default=8, help="返回候选数量（默认 8）")
    p_search.set_defaults(func=cmd_search)

    p_resolve = sub.add_parser("resolve", help="解析 DOI / arXiv 为论文详情")
    p_resolve.add_argument("--doi", help="论文 DOI")
    p_resolve.add_argument("--arxiv", help="arXiv ID")
    p_resolve.set_defaults(func=cmd_resolve)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
