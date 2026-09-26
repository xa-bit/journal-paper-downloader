"""下载辅助：文件命名规则、信息文件与权限记录文件生成（实际下载由浏览器自动化完成）。"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

from .resolvers import Paper

#: 权限记录文件后缀：<DOI尾缀>.access.json，标志该文献是否具有下载权限
ACCESS_MARKER_SUFFIX = ".access.json"


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


def is_pdf_file_ok(target: str | Path) -> bool:
    """简单校验 PDF 文件是否正常：文件存在且非空、头部含 %PDF-、尾部含 %%EOF。

    用于扫盘时识别异常文件（0 字节、HTML 错误页、下载中断的残缺文件），
    异常文件按不存在处理，允许重新下载。头尾各留 1-2 KB 容错空间：
    部分工具会在 %PDF- 前插入少量字节，部分 PDF 尾部带填充数据。
    """
    target = Path(target)
    try:
        size = target.stat().st_size
    except OSError:
        return False
    if size == 0:
        return False
    try:
        with target.open("rb") as fh:
            head = fh.read(1024)
            fh.seek(max(0, size - 2048))
            tail = fh.read(2048)
    except OSError:
        return False
    return b"%PDF-" in head and b"%%EOF" in tail


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


def access_marker_path(target_dir: str | Path, stem: str) -> Path:
    """权限记录文件路径：与 PDF 同目录同名，后缀 .access.json。"""
    return Path(target_dir) / f"{stem}{ACCESS_MARKER_SUFFIX}"


def read_access_marker(target_dir: str | Path, stem: str) -> dict:
    """读取权限记录文件（三路径权限）；不存在或不可解析时返回空 dict。

    供下载流程按“各下载源是否已记录无权限”决定是否跳过该下载源
    （受界面“无权限时跳过”三个选项控制）。
    """
    target = access_marker_path(target_dir, stem)
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


#: 权限记录（三路径）取值
OFFICIAL_GRANTED = "granted"        # 官方网页（出版商）：有访问权限
OFFICIAL_DENIED = "denied"          # 官方网页（出版商）：无访问权限（付费墙/机构登录）
SCIHUB_AVAILABLE = "available"      # Sci-Hub：收录该文献
SCIHUB_UNAVAILABLE = "unavailable"  # Sci-Hub：未收录该文献
RG_AVAILABLE = "available"          # ResearchGate：有公开全文可下载
RG_UNAVAILABLE = "unavailable"      # ResearchGate：无公开全文（仅可请求/无下载入口/未收录）


def write_access_marker(
    paper: Paper,
    target_dir: str | Path,
    stem: str,
    *,
    official: str | None = None,
    scihub: str | None = None,
    researchgate: str | None = None,
    reason_official: str = "",
    reason_scihub: str = "",
    reason_researchgate: str = "",
) -> Path:
    """写入/合并权限记录文件（<DOI尾缀>.access.json，三路径权限）。

    三个权限：
      official     —— 官方网页（出版商）访问权限："granted" / "denied"；
      scihub       —— Sci-Hub 是否有该文献："available" / "unavailable"；
      researchgate —— ResearchGate 是否有公开全文："available" / "unavailable"。
    合并语义：只更新本次传入的路径（None 表示保留旧值），其他路径的已知状态
    不受影响；兼容旧格式记录（access: granted/denied → 迁移到 official 路径）。
    下载前扫描（始终开启）：仅当三条路径都标记为“无”（official=denied、
    scihub=unavailable 且 researchgate=unavailable）时该文献才直接跳过。
    """
    if official is not None and official not in (OFFICIAL_GRANTED, OFFICIAL_DENIED):
        raise ValueError(f"official 取值非法: {official}")
    if scihub is not None and scihub not in (SCIHUB_AVAILABLE, SCIHUB_UNAVAILABLE):
        raise ValueError(f"scihub 取值非法: {scihub}")
    if researchgate is not None and researchgate not in (RG_AVAILABLE, RG_UNAVAILABLE):
        raise ValueError(f"researchgate 取值非法: {researchgate}")
    if official is None and scihub is None and researchgate is None:
        raise ValueError("official / scihub / researchgate 至少需要指定一个")
    target = access_marker_path(target_dir, stem)
    target.parent.mkdir(parents=True, exist_ok=True)
    existing: dict = {}
    if target.exists():
        try:
            existing = json.loads(target.read_text(encoding="utf-8")) or {}
        except Exception:
            existing = {}
    # 旧格式兼容：access=granted/denied（无新字段时）→ official 路径
    if "official" not in existing and "scihub" not in existing:
        if existing.get("access") == "granted":
            existing["official"] = "granted"
        elif existing.get("access") == "denied":
            existing["official"] = "denied"
            existing.setdefault("reason_official", existing.get("reason") or "")
    payload = {
        "doi": paper.doi or "",
        "title": paper.display_title or "",
        "official": official or existing.get("official"),
        "scihub": scihub or existing.get("scihub"),
        "researchgate": researchgate or existing.get("researchgate"),
        "reason_official": reason_official or existing.get("reason_official", ""),
        "reason_scihub": reason_scihub or existing.get("reason_scihub", ""),
        "reason_researchgate": reason_researchgate
        or existing.get("reason_researchgate", ""),
        "checked_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return target
