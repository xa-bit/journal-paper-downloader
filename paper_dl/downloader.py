"""下载器：把解析出的 PDF 地址保存到本地文件。"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import requests

from .resolvers import Paper, ResolveError

DEFAULT_TIMEOUT = 60
CHUNK_SIZE = 64 * 1024


def _slugify(text: str, max_len: int = 80) -> str:
    """把标题转成适合作为文件名的 slug（保留中日韩等 Unicode 字符）。"""
    text = re.sub(r"[^\w\s\-]", "", text, flags=re.UNICODE)
    text = re.sub(r"\s+", "-", text.strip())
    return text[:max_len].strip("-") or "paper"


def build_filename(paper: Paper) -> str:
    parts = []
    if paper.authors:
        parts.append(paper.authors[0].split()[-1])
    if paper.year:
        parts.append(str(paper.year))
    parts.append(_slugify(paper.display_title))
    return "_".join(parts) + ".pdf"


def download_pdf(paper: Paper, output_dir: str | Path, *, overwrite: bool = False) -> Path:
    """依次尝试 paper.pdf_urls，把第一个成功下载的保存到 output_dir。"""
    if not paper.pdf_urls:
        raise ResolveError(f"论文《{paper.display_title}》没有可用的 PDF 链接")

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / build_filename(paper)
    if target.exists() and not overwrite:
        raise ResolveError(f"文件已存在（可用 --overwrite 覆盖）: {target}")

    last_error: ResolveError | None = None
    for pdf_url in paper.pdf_urls:
        try:
            _download_to(pdf_url, target, paper)
            return target
        except ResolveError as exc:
            last_error = exc
            print(f"候选链接失败，尝试下一个: {exc}", file=sys.stderr)
    raise last_error or ResolveError("所有 PDF 链接均下载失败")


def _download_to(pdf_url: str, target: Path, paper: Paper) -> None:
    try:
        with requests.get(
            pdf_url,
            stream=True,
            timeout=DEFAULT_TIMEOUT,
            headers={"User-Agent": "journal-paper-downloader/1.0"},
            allow_redirects=True,
        ) as resp:
            if resp.status_code != 200:
                raise ResolveError(f"下载失败，HTTP {resp.status_code}: {pdf_url}")
            content_type = resp.headers.get("Content-Type", "")
            if "pdf" not in content_type.lower() and not pdf_url.lower().endswith(".pdf"):
                raise ResolveError(
                    f"目标似乎不是 PDF（Content-Type: {content_type}），落地页: {paper.landing_url or pdf_url}"
                )
            with open(target, "wb") as fh:
                for chunk in resp.iter_content(CHUNK_SIZE):
                    fh.write(chunk)
    except requests.RequestException as exc:
        target.unlink(missing_ok=True)
        raise ResolveError(f"下载出错: {exc}") from exc

    if target.stat().st_size == 0:
        target.unlink(missing_ok=True)
        raise ResolveError("下载到空文件")


def print_paper(paper: Paper, file=sys.stderr) -> None:
    """在终端打印论文元数据。"""
    print(f"标题: {paper.display_title}", file=file)
    if paper.authors:
        print(f"作者: {', '.join(paper.authors[:3])}{' 等' if len(paper.authors) > 3 else ''}", file=file)
    if paper.year:
        print(f"年份: {paper.year}", file=file)
    if paper.doi:
        print(f"DOI: {paper.doi}", file=file)
    if paper.landing_url:
        print(f"页面: {paper.landing_url}", file=file)
