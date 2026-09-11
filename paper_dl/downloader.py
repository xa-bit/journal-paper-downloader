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


def sanitize_component(text: str, max_len: int = 100) -> str:
    """把任意文本清理为合法的单级目录/文件名（去掉路径分隔符等非法字符）。"""
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", text)
    text = re.sub(r"\s+", " ", text).strip().strip(".")
    return (text[:max_len].strip() or "untitled").strip(".")


def doi_file_stem(doi: str) -> str:
    """从 DOI 提取文件名片段，如 10.1029/2025JC023188 -> 2025JC023188。"""
    stem = doi.strip().rstrip("/").split("/")[-1]
    return sanitize_component(stem)


def build_filename(paper: Paper) -> str:
    parts = []
    if paper.authors:
        parts.append(paper.authors[0].split()[-1])
    if paper.year:
        parts.append(str(paper.year))
    parts.append(_slugify(paper.display_title))
    return "_".join(parts) + ".pdf"


def _ordered_candidates(paper: Paper, strategies: list[str] | None) -> list[str]:
    """按策略顺序（unpaywall/openalex/publisher）筛选并重排 PDF 候选链接。

    strategies 为 None 时返回全部候选（原顺序）；浏览器自动化不在 HTTP 候选之列。
    """
    if not strategies:
        return list(paper.pdf_urls)
    candidates: list[str] = []
    for name in strategies:
        for url, source in zip(paper.pdf_urls, paper.pdf_sources):
            if source == name and url not in candidates:
                candidates.append(url)
    return candidates


def download_pdf(
    paper: Paper,
    output_dir: str | Path,
    *,
    overwrite: bool = False,
    filename: str | None = None,
    strategies: list[str] | None = None,
) -> Path:
    """按策略顺序尝试 paper 的 PDF 候选链接，把第一个成功下载的保存到 output_dir。

    filename 为 None 时按 ``build_filename`` 命名；否则直接使用给定文件名。
    strategies 为 None 时尝试全部候选；否则只试指定来源（unpaywall/openalex/publisher）。
    """
    candidates = _ordered_candidates(paper, strategies)
    if not candidates:
        raise ResolveError(f"论文《{paper.display_title}》没有可用的 PDF 链接")

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / (filename or build_filename(paper))
    if target.exists() and not overwrite:
        raise ResolveError(f"文件已存在（可用 --overwrite 覆盖）: {target}")

    last_error: ResolveError | None = None
    for pdf_url in candidates:
        try:
            _download_to(pdf_url, target, paper)
            return target
        except ResolveError as exc:
            last_error = exc
            print(f"候选链接失败，尝试下一个: {exc}", file=sys.stderr)
    raise last_error or ResolveError("所有 PDF 链接均下载失败")


def write_info_file(paper: Paper, target: str | Path, *, extra: dict | None = None) -> Path:
    """生成与 PDF 配套的信息文件（.txt），始终覆盖已有文件。

    extra 中可补充 Crossref 侧元数据（如 volume/issue/journal/date）。
    """
    extra = extra or {}
    target = Path(target)
    authors = paper.authors or list(extra.get("authors") or [])
    lines = [
        ("标题", paper.display_title),
        ("期刊", extra.get("journal") or ""),
        ("卷", extra.get("volume") or ""),
        ("期", extra.get("issue") or ""),
        ("日期", extra.get("date") or (str(paper.year) if paper.year else "")),
        ("作者", ", ".join(authors) if authors else ""),
        ("DOI", paper.doi or ""),
        ("链接", paper.landing_url or (f"https://doi.org/{paper.doi}" if paper.doi else "")),
    ]
    target.write_text("\n".join(f"{k}: {v}" for k, v in lines) + "\n", encoding="utf-8")
    return target


DOWNLOAD_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def _download_to(pdf_url: str, target: Path, paper: Paper, *, attempts: int = 2) -> None:
    last_exc: ResolveError | None = None
    for attempt in range(1, attempts + 1):
        try:
            with requests.get(
                pdf_url,
                stream=True,
                timeout=DEFAULT_TIMEOUT,
                headers={"User-Agent": DOWNLOAD_UA, "Accept": "application/pdf,*/*"},
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
            break
        except requests.RequestException as exc:
            target.unlink(missing_ok=True)
            last_exc = ResolveError(f"下载出错: {exc}")
            if attempt < attempts:
                continue  # 连接重置 / 超时等网络错误重试一次
    else:
        raise last_exc or ResolveError("下载出错")

    if target.exists() and target.stat().st_size == 0:
        target.unlink(missing_ok=True)
        raise ResolveError("下载到空文件")
    if not target.exists():
        raise last_exc or ResolveError("下载出错")


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
