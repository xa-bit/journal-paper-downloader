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
OPENALEX_API = "https://api.openalex.org/works"
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
    pdf_sources: list[str] = field(default_factory=list)  # 与 pdf_urls 一一对应的来源标签
    landing_url: str | None = None
    is_oa: bool = False

    @property
    def display_title(self) -> str:
        return self.title.strip() or (self.doi or self.arxiv_id or "unknown")

    def add_pdf(self, url: str, source: str) -> None:
        """追加一个 PDF 候选（去重），source ∈ unpaywall/openalex/publisher。"""
        if url and url not in self.pdf_urls:
            self.pdf_urls.append(url)
            self.pdf_sources.append(source)

    def to_dict(self) -> dict:
        """序列化为 JSON 友好的字典（供 Web 接口使用）。"""
        return {
            "title": self.title,
            "doi": self.doi,
            "arxiv_id": self.arxiv_id,
            "authors": list(self.authors),
            "year": self.year,
            "pdf_urls": list(self.pdf_urls),
            "pdf_sources": list(self.pdf_sources),
            "landing_url": self.landing_url,
            "is_oa": self.is_oa,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Paper":
        """从 to_dict() 的输出还原 Paper 对象。"""
        return cls(
            title=data.get("title") or "",
            doi=data.get("doi"),
            arxiv_id=data.get("arxiv_id"),
            authors=list(data.get("authors") or []),
            year=data.get("year"),
            pdf_urls=list(data.get("pdf_urls") or []),
            pdf_sources=list(data.get("pdf_sources") or []),
            landing_url=data.get("landing_url"),
            is_oa=bool(data.get("is_oa")),
        )


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
    paper = Paper(
        title=f"arXiv:{arxiv_id}",
        arxiv_id=arxiv_id,
        landing_url=f"https://arxiv.org/abs/{arxiv_id}",
        is_oa=True,
    )
    paper.add_pdf(ARXIV_PDF_URL.format(arxiv_id=arxiv_id), "unpaywall")
    return paper


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


def _openalex_pdf_urls(doi: str) -> list[str]:
    """OpenAlex 兜底：查找 Unpaywall 未收录的 OA PDF（如机构库副本）。"""
    try:
        resp = requests.get(
            f"{OPENALEX_API}/doi:{doi}",
            headers={"User-Agent": "journal-paper-downloader/1.0"},
            timeout=DEFAULT_TIMEOUT,
        )
        if resp.status_code != 200:
            return []
        data = resp.json()
    except requests.RequestException:
        return []
    urls: list[str] = []
    best = data.get("best_oa_location") or {}
    if best.get("pdf_url"):
        urls.append(best["pdf_url"])
    for location in data.get("locations") or []:
        pdf_url = location.get("pdf_url")
        if pdf_url and pdf_url not in urls:
            urls.append(pdf_url)
    return urls


def _publisher_pdf_candidates(doi: str) -> list[str]:
    """出版商页面的规范 PDF 直链（最后兜底；反爬拦截时自动失败，不影响其他来源）。"""
    doi_lower = doi.lower()
    tail = doi.split("/", 1)[-1]
    if doi_lower.startswith("10.1029/"):
        return [f"https://agupubs.onlinelibrary.wiley.com/doi/pdfdirect/{doi}"]
    if doi_lower.startswith(("10.1002/", "10.1111/")):
        return [f"https://onlinelibrary.wiley.com/doi/pdfdirect/{doi}"]
    if doi_lower.startswith("10.1038/"):
        return [f"https://www.nature.com/articles/{tail}.pdf"]
    return []


def resolve_doi(doi: str, email: str = UNPAYWALL_EMAIL) -> Paper:
    """DOI -> Unpaywall（首选）+ OpenAlex（兜底）查找合法的 OA PDF。"""
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
    for author in data.get("z_authors") or []:
        name = " ".join(filter(None, [author.get("given"), author.get("family")]))
        if not name:
            name = author.get("raw_author_name") or ""
        if name:
            paper.authors.append(name)
    # 收集所有 OA 位置的 PDF 链接（best 优先），下载时按顺序尝试
    locations = [data.get("best_oa_location") or {}] + list(data.get("oa_locations") or [])
    for location in locations:
        paper.add_pdf(location.get("url_for_pdf"), "unpaywall")
    if paper.pdf_urls:
        paper.landing_url = (data.get("best_oa_location") or {}).get("url_for_landing_page") or paper.landing_url

    # Unpaywall 没有 PDF 直链时，用 OpenAlex 兜底（机构库 / 预印本副本等）
    if not paper.pdf_urls:
        for pdf_url in _openalex_pdf_urls(doi):
            paper.add_pdf(pdf_url, "openalex")
        if paper.pdf_urls:
            paper.is_oa = True

    # 最后追加出版商规范直链（被反爬拦截时会在下载阶段自动跳过）
    for pdf_url in _publisher_pdf_candidates(doi):
        paper.add_pdf(pdf_url, "publisher")

    if not paper.pdf_urls and not paper.is_oa:
        raise ResolveError(
            f"论文 {doi} 在 Unpaywall / OpenAlex 中均无开放获取版本。"
            "出版商页面可能可手动获取（出版商有反爬保护，程序无法直接下载）: "
            + (paper.landing_url or f"https://doi.org/{doi}")
        )
    if not paper.pdf_urls:
        # OA 但没有 PDF 直链时，回退到落地页
        paper.landing_url = (data.get("best_oa_location") or {}).get("url_for_landing_page") or paper.landing_url
    return paper
