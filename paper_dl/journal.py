"""期刊检索：从期刊网址解析 ISSN，经 Crossref 拉取期刊文献列表。

解析 ISSN 的策略（按顺序）：
1. 网址路径中直接包含 ISSN 数字（如 Wiley: .../journal/19448007 -> 1944-8007）
2. 抓取期刊页面 HTML，提取 prism.issn / itemprop=issn 等元数据（如 nature.com）
3. 用网址最后一段路径作为关键词查询 Crossref journals API
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

import requests

from .resolvers import CROSSREF_WORKS_API, ResolveError, _get

CROSSREF_JOURNALS_API = "https://api.crossref.org/journals"

ISSN_PATH_RE = re.compile(r"(?<!\d)(\d{4})-?(\d{3}[\dXx])(?!\d)")
ISSN_HTML_RES = [
    re.compile(r'name=["\']prism\.issn["\'][^>]*content=["\'](\d{4}-\d{3}[\dXx])', re.IGNORECASE),
    re.compile(r'content=["\'](\d{4}-\d{3}[\dXx])["\'][^>]*name=["\']prism\.issn', re.IGNORECASE),
    re.compile(r'itemprop=["\']issn["\'][^>]*>(\d{4}-\d{3}[\dXx])<', re.IGNORECASE),
]


@dataclass
class Journal:
    """一份期刊的标识信息。"""

    title: str
    issn: str
    url: str
    total_results: int = 0
    works_url: str | None = None

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "issn": self.issn,
            "url": self.url,
            "total_results": self.total_results,
            "works_url": self.works_url,
        }


@dataclass
class JournalWork:
    """期刊中的一篇文献（Crossref 元数据）。"""

    doi: str
    title: str
    authors: list[str] = field(default_factory=list)
    date: str | None = None
    year: int | None = None
    volume: str | None = None
    issue: str | None = None
    journal: str | None = None
    url: str | None = None

    def to_dict(self) -> dict:
        return {
            "doi": self.doi,
            "title": self.title,
            "authors": list(self.authors),
            "date": self.date,
            "year": self.year,
            "volume": self.volume,
            "issue": self.issue,
            "journal": self.journal,
            "url": self.url,
        }


def _issn_in_path(url: str) -> str | None:
    """从 URL 路径提取 ISSN（如 /journal/19448007）。"""
    match = ISSN_PATH_RE.search(urlparse(url).path)
    if not match:
        return None
    return f"{match.group(1)}-{match.group(2).upper()}"


def _issn_from_html(url: str) -> str | None:
    """抓取期刊页面，从 meta 标签提取 ISSN（如 nature.com 的 prism.issn）。"""
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) journal-paper-downloader/1.0"}
    try:
        resp = requests.get(url, headers=headers, timeout=30, allow_redirects=True)
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None
    html = resp.text
    for pattern in ISSN_HTML_RES:
        match = pattern.search(html)
        if match:
            return match.group(1).upper()
    match = re.search(r"\b(\d{4}-\d{3}[\dXx])\b", html)
    return match.group(1).upper() if match else None


def _issn_from_query(url: str) -> str | None:
    """用 URL 最后一段路径作为关键词查 Crossref journals。"""
    segments = [s for s in urlparse(url).path.split("/") if s]
    if not segments:
        segments = [urlparse(url).netloc.split(".")[0]]
    query = segments[-1].replace("-", " ")
    try:
        resp = _get(CROSSREF_JOURNALS_API, params={"query": query, "rows": 1})
    except ResolveError:
        return None
    items = resp.json().get("message", {}).get("items", [])
    if not items:
        return None
    issns = items[0].get("ISSN") or []
    return issns[0] if issns else None


def resolve_journal(url: str) -> Journal:
    """期刊网址 -> 期刊信息（标题、ISSN）。"""
    url = url.strip()
    if not re.match(r"^https?://", url):
        url = "https://" + url

    issn = _issn_in_path(url) or _issn_from_html(url) or _issn_from_query(url)
    if not issn:
        raise ResolveError(f"无法从网址解析出期刊 ISSN: {url}")

    resp = _get(f"{CROSSREF_JOURNALS_API}/{issn}")
    info = resp.json().get("message", {})
    title = info.get("title") or issn
    counts = info.get("counts") or {}
    return Journal(
        title=title,
        issn=issn,
        url=url,
        total_results=counts.get("total-dois", 0),
        works_url=info.get("works"),
    )


def _format_date(item: dict) -> tuple[str | None, int | None]:
    for key in ("published", "published-print", "published-online", "issued", "created"):
        parts = (item.get(key) or {}).get("date-parts")
        if parts and parts[0] and parts[0][0]:
            date_parts = parts[0]
            date = "-".join(str(p).zfill(2) for p in date_parts)
            return date, date_parts[0]
    return None, None


def _item_to_work(item: dict) -> JournalWork:
    title = (item.get("title") or [""])[0]
    authors = []
    for author in item.get("author") or []:
        name = " ".join(filter(None, [author.get("given"), author.get("family")]))
        if name:
            authors.append(name)
    date, year = _format_date(item)
    containers = item.get("container-title") or []
    return JournalWork(
        doi=item.get("DOI") or "",
        title=title,
        authors=authors,
        date=date,
        year=year,
        volume=item.get("volume") or None,
        issue=item.get("issue") or None,
        journal=containers[0] if containers else None,
        url=item.get("URL") or None,
    )


def fetch_journal_works(
    issn: str, *, cursor: str = "*", rows: int = 500
) -> tuple[list[JournalWork], str, int, bool]:
    """按 ISSN 从 Crossref 拉取一页文献（按发表日期倒序）。

    返回 (文献列表, 下一页 cursor, 期刊总文献数, 是否已到最后一页)。
    """
    resp = _get(
        CROSSREF_WORKS_API,
        params={
            "filter": f"issn:{issn},type:journal-article",
            "select": "DOI,title,author,volume,issue,published,published-print,published-online,issued,container-title,URL",
            "rows": rows,
            "cursor": cursor,
        },
    )
    message = resp.json().get("message", {})
    items = message.get("items", [])
    works = [_item_to_work(item) for item in items]
    next_cursor = message.get("next-cursor") or ""
    total = message.get("total-results", 0)
    done = not items or not next_cursor or next_cursor == cursor
    return works, next_cursor, total, done
