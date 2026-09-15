"""下载辅助：文件命名规则与信息文件生成（实际下载由浏览器自动化完成）。"""

from __future__ import annotations

import re
from pathlib import Path

from .resolvers import Paper


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
