"""命令行入口: python -m paper_dl ..."""

from __future__ import annotations

import argparse
import sys

from .downloader import build_filename, download_pdf, print_paper
from .resolvers import ResolveError, resolve_arxiv, resolve_doi, search_by_title

DEFAULT_OUTPUT_DIR = "papers"


def _confirm(prompt: str) -> bool:
    try:
        return input(f"{prompt} [y/N] ").strip().lower() in ("y", "yes")
    except EOFError:
        return False


def _download(paper, args) -> int:
    print_paper(paper)
    target = build_filename(paper)
    print(f"即将保存为: {args.output}/{target}", file=sys.stderr)
    try:
        path = download_pdf(paper, args.output, overwrite=args.overwrite)
    except ResolveError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1
    print(path)
    return 0


def cmd_doi(args) -> int:
    try:
        paper = resolve_doi(args.doi, email=args.email)
    except ResolveError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1
    return _download(paper, args)


def cmd_arxiv(args) -> int:
    paper = resolve_arxiv(args.arxiv_id)
    return _download(paper, args)


def cmd_title(args) -> int:
    try:
        candidates = search_by_title(" ".join(args.title))
    except ResolveError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    if len(candidates) > 1 and not args.yes:
        print("找到以下候选论文:", file=sys.stderr)
        for idx, paper in enumerate(candidates, 1):
            year = f" ({paper.year})" if paper.year else ""
            print(f"  {idx}. {paper.display_title}{year} — {paper.doi or '无 DOI'}", file=sys.stderr)
        choice = input("请输入序号下载（直接回车取消）: ").strip()
        if not choice.isdigit() or not (1 <= int(choice) <= len(candidates)):
            print("已取消", file=sys.stderr)
            return 1
        paper = candidates[int(choice) - 1]
    else:
        paper = candidates[0]

    if not paper.doi:
        print("错误: 该论文没有 DOI，无法通过 Unpaywall 获取", file=sys.stderr)
        return 1

    try:
        paper = resolve_doi(paper.doi, email=args.email)
    except ResolveError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1
    return _download(paper, args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="paper-dl",
        description="期刊文献下载工具：通过 DOI / arXiv ID / 标题下载开放获取（OA）论文 PDF",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=DEFAULT_OUTPUT_DIR,
        help=f"保存目录（默认: {DEFAULT_OUTPUT_DIR}）",
    )
    parser.add_argument("--overwrite", action="store_true", help="覆盖已存在的文件")
    parser.add_argument(
        "--email",
        default="paper-dl@localhost",
        help="提供给 Unpaywall 的邮箱（建议改为自己的邮箱）",
    )
    parser.add_argument("-y", "--yes", action="store_true", help="标题检索时直接下载第一个候选")

    sub = parser.add_subparsers(dest="command", required=True)

    p_doi = sub.add_parser("doi", help="通过 DOI 下载")
    p_doi.add_argument("doi", help="论文 DOI，如 10.1038/nature12373")
    p_doi.set_defaults(func=cmd_doi)

    p_arxiv = sub.add_parser("arxiv", help="通过 arXiv ID 下载预印本")
    p_arxiv.add_argument("arxiv_id", help="arXiv ID，如 2401.00001 或 arxiv.org/abs/2401.00001")
    p_arxiv.set_defaults(func=cmd_arxiv)

    p_title = sub.add_parser("title", help="通过标题检索下载")
    p_title.add_argument("title", nargs="+", help="论文标题（可含空格，无需引号）")
    p_title.set_defaults(func=cmd_title)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
