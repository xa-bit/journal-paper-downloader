"""Resolver: 将 DOI / arXiv ID / 论文标题解析为可下载的 PDF 地址。

只使用合法的开放获取（Open Access）渠道：
- Unpaywall: 根据 DOI 查找合法的 OA 全文链接
- arXiv: 预印本 PDF 直链
- Crossref: 按标题检索论文元数据（DOI、作者、年份等）
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import requests

CROSSREF_WORKS_API = "https://api.crossref.org/works"
UNPAYWALL_API = "https://api.unpaywall.org/v2"
ARXIV_PDF_URL = "https://arxiv.org/pdf/{arxiv_id}"
UNPAYWALL_EMAIL = "paper-dl@localhost"

DEFAULT_TIMEOUT = 30


class ResolveError(RuntimeError):
    """解析失败（网络错误、未找到 OA 版本等）。"""


@dataclass
class Paper:
    """一篇论文的元数据与下载地址。"""

    title: str
    doi: str | None = None
    arxiv_id: str | None = None
    authors: list[str] = field(default_factory=list)
    year: int | None = None
    pdf_urls: list[str] = field(default_factory=list)
    landing_url: str | None = None
    is_oa: bool = False

    @property
    def display_title(self) -> str:
        return self.title.strip() or (self.doi or self.arxiv_id or "unknown")


def _get(url: str, *, params: dict | None = None, accept: str | None = None) -> requests.Response:
    headers = {"User-Agent": "journal-paper-downloader/1.0"}
    if accept:
        headers["Accept"] = accept
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=DEFAULT_TIMEOUT)
    except requests.RequestException as exc:
        raise ResolveError(f"网络请求失败: {exc}") from exc
    if resp.status_code == 404:
        raise ResolveError(f"未找到资源: {url}")
    if resp.status_code != 200:
        raise ResolveError(f"请求 {url} 返回 {resp.status_code}: {resp.text[:200]}")
    return resp


def normalize_arxiv_id(raw: str) -> str:
    """规范化 arXiv ID，去掉版本号与多余前缀。"""
    text = raw.strip()
    match = re.search(r"(\d{4}\.\d{4,5})(v\d+)?", text)
    if match:
        return match.group(1)
    # 旧式分类 ID，如 hep-th/9901001
    match = re.search(r"([a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?", text)
    if match:
        return match.group(1)
    raise ResolveError(f"无法识别的 arXiv ID: {raw}")


def resolve_arxiv(arxiv_id: str) -> Paper:
    """arXiv ID -> 预印本 PDF。"""
    arxiv_id = normalize_arxiv_id(arxiv_id)
    return Paper(
        title=f"arXiv:{arxiv_id}",
        arxiv_id=arxiv_id,
        pdf_urls=[ARXIV_PDF_URL.format(arxiv_id=arxiv_id)],
        landing_url=f"https://arxiv.org/abs/{arxiv_id}",
        is_oa=True,
    )


def _crossref_item_to_paper(item: dict) -> Paper:
    title = (item.get("title") or [""])[0]
    authors = []
    for author in item.get("author") or []:
        name = " ".join(filter(None, [author.get("given"), author.get("family")]))
        if name:
            authors.append(name)
    year = None
    for key in ("published-print", "published-online", "issued", "created"):
        parts = (item.get(key) or {}).get("date-parts")
        if parts and parts[0]:
            year = parts[0][0]
            break
    return Paper(
        title=title,
        doi=item.get("DOI"),
        authors=authors,
        year=year,
        landing_url=(item.get("URL") or None),
    )


def search_by_title(title: str, rows: int = 5) -> list[Paper]:
    """按标题在 Crossref 中检索，返回候选列表（按相关度排序）。"""
    resp = _get(
        CROSSREF_WORKS_API,
        params={"query.title": title, "rows": rows, "select": "DOI,title,author,issued,URL"},
    )
    items = resp.json().get("message", {}).get("items", [])
    papers = [_crossref_item_to_paper(item) for item in items]
    if not papers:
        raise ResolveError(f"Crossref 中未找到标题匹配的论文: {title}")
    return papers


def resolve_doi(doi: str, email: str = UNPAYWALL_EMAIL) -> Paper:
    """DOI -> Unpaywall 查找合法的 OA PDF。"""
    doi = doi.strip().removeprefix("https://doi.org/").removeprefix("http://dx.doi.org/")
    if not doi:
        raise ResolveError("DOI 为空")

    resp = _get(f"{UNPAYWALL_API}/{doi}", params={"email": email})
    data = resp.json()

    paper = Paper(
        title=data.get("title") or doi,
        doi=data.get("doi") or doi,
        year=data.get("year"),
        landing_url=data.get("url_for_landing_page"),
        is_oa=bool(data.get("is_oa")),
    )
    # 收集所有 OA 位置的 PDF 链接（best 优先），下载时按顺序尝试
    locations = [data.get("best_oa_location") or {}] + list(data.get("oa_locations") or [])
    seen = set()
    for location in locations:
        pdf_url = location.get("url_for_pdf")
        if pdf_url and pdf_url not in seen:
            seen.add(pdf_url)
            paper.pdf_urls.append(pdf_url)
    if paper.pdf_urls:
        paper.landing_url = (data.get("best_oa_location") or {}).get("url_for_landing_page") or paper.landing_url
    if not paper.pdf_urls and not paper.is_oa:
        raise ResolveError(
            f"论文 {doi} 没有开放获取版本（Unpaywall）。"
            "可通过出版商页面获取: " + (paper.landing_url or f"https://doi.org/{doi}")
        )
    if not paper.pdf_urls:
        # OA 但没有 PDF 直链时，回退到落地页
        paper.landing_url = (data.get("best_oa_location") or {}).get("url_for_landing_page") or paper.landing_url
    return paper
