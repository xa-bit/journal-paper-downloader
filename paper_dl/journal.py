"""期刊检索：从期刊网址解析 ISSN，经 Crossref 拉取期刊文献列表。

解析 ISSN 的策略（按顺序，前一级命中即停止）：
1. 网址路径中直接包含 ISSN 数字（如 Wiley: .../journal/19448007 -> 1944-8007）
2. 抓取期刊页面 HTML，只从 <head> 的权威位置提取 ISSN：
   prism.issn / citation_issn meta 标签，或 head 内出现的 ISSN 字面量。
   不再扫描正文——部分出版社页面（如 scholars.direct）的导航菜单里
   列出了旗下所有期刊的 ISSN，全文扫描会把别的期刊误当成本刊。
3. 依次用多个关键词查询 Crossref journals API：
   页面标题（og:title / citation_journal_title / <title> 清洗后）->
   网址查询参数值（如 ?jid=fluid-dynamics）->
   主机名（如 hydrology-and-earth-system-sciences.net）->
   路径末段（去掉 .xml/.php、-overview 等尾巴）。
   对被反爬拦截无法抓页的站点（如 journals.aps.org 返回 403），
   路径段以 pr 开头时展开为 “Physical Review <余下部分>” 再查询，
   因此 https://journals.aps.org/prfluids/ -> “Physical Review Fluids”。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlparse

import requests

from .resolvers import CROSSREF_WORKS_API, ResolveError, _get

CROSSREF_JOURNALS_API = "https://api.crossref.org/journals"

ISSN_PATH_RE = re.compile(r"(?<!\d)(\d{4})-?(\d{3}[\dXx])(?!\d)")
ISSN_LITERAL_RE = re.compile(r"\b(\d{4}-\d{3}[\dXx])\b")
ISSN_HTML_RES = [
    re.compile(r'name=["\']prism\.issn["\'][^>]*content=["\'](\d{4}-\d{3}[\dXx])', re.IGNORECASE),
    re.compile(r'content=["\'](\d{4}-\d{3}[\dXx])["\'][^>]*name=["\']prism\.issn', re.IGNORECASE),
    re.compile(r'name=["\']citation_issn["\'][^>]*content=["\'](\d{4}-\d{3}[\dXx])', re.IGNORECASE),
    re.compile(r'content=["\'](\d{4}-\d{3}[\dXx])["\'][^>]*name=["\']citation_issn', re.IGNORECASE),
    re.compile(r'itemprop=["\']issn["\'][^>]*>(\d{4}-\d{3}[\dXx])<', re.IGNORECASE),
]
TITLE_HTML_RES = [
    re.compile(r'property=["\']og:title["\'][^>]*content=["\']([^"\']+)', re.IGNORECASE),
    re.compile(r'content=["\']([^"\']+)["\'][^>]*property=["\']og:title', re.IGNORECASE),
    re.compile(r'name=["\']citation_journal_title["\'][^>]*content=["\']([^"\']+)', re.IGNORECASE),
    re.compile(r'<title[^>]*>([^<]+)</title>', re.IGNORECASE),
]

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) journal-paper-downloader/1.0"

# 标题清洗时丢弃的站点样板词（“Home | xxx | Springer Nature Link” 这类）
_TITLE_NOISE = re.compile(
    r"(?i)\b(home|welcome|overview|best scientific journals|springer nature link|"
    r"journals a-z|an? open access (international )?peer[- ]reviewed journal)\b"
)
# URL 查询参数中常携带期刊名的键
_JID_PARAM_KEYS = ("jid", "journal", "jname", "journalname", "name", "title", "id")


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


def _fetch_page(url: str) -> str | None:
    """抓取页面 HTML；被反爬拦截或网络失败时返回 None（由后续策略兜底）。"""
    headers = {"User-Agent": USER_AGENT}
    try:
        resp = requests.get(url, headers=headers, timeout=30, allow_redirects=True)
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None
    return resp.text


def _issn_from_jsonld(html: str | None) -> str | None:
    """从页面 JSON-LD 结构化数据（schema.org Periodical）提取 ISSN（如 Springer）。"""
    if not html:
        return None
    for match in re.finditer(
        r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.IGNORECASE | re.DOTALL
    ):
        try:
            data = json.loads(match.group(1))
        except (json.JSONDecodeError, TypeError):
            continue
        entries = data if isinstance(data, list) else [data]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            types = entry.get("@type") or ""
            types = types if isinstance(types, list) else [types]
            if not any("Periodical" in str(t) for t in types):
                continue
            issns = entry.get("issn") or []
            issns = issns if isinstance(issns, list) else [issns]
            for issn in issns:
                m = ISSN_LITERAL_RE.fullmatch(str(issn).strip())
                if m:
                    return m.group(1).upper()
    return None


def _issn_from_html(html: str | None) -> str | None:
    """从页面权威位置提取 ISSN；正文 ISSN 一律不采信（防导航菜单污染）。"""
    if not html:
        return None
    for pattern in ISSN_HTML_RES:
        match = pattern.search(html)
        if match:
            return match.group(1).upper()
    issn = _issn_from_jsonld(html)
    if issn:
        return issn
    head = html.split("</head>", 1)[0]
    match = ISSN_LITERAL_RE.search(head)
    return match.group(1).upper() if match else None


def _clean_title(raw: str) -> str:
    """清洗页面标题：去噪声词、取 “|” 分隔中最像期刊名的一段。"""
    text = re.sub(r"\s+", " ", raw or "").strip()
    if not text:
        return ""
    segments = [s.strip() for s in re.split(r"[|·—–-]\s*", text) if s.strip()]
    candidates = [s for s in segments if not _TITLE_NOISE.search(s)] or segments
    best = max(candidates, key=len)
    best = _TITLE_NOISE.sub(" ", best)
    return re.sub(r"\s+", " ", best).strip(" |-–—.")


def _title_from_html(html: str | None) -> str:
    if not html:
        return ""
    for pattern in TITLE_HTML_RES:
        match = pattern.search(html)
        if match:
            title = _clean_title(match.group(1))
            if title:
                return title
    return ""


def _keywords_from_url(url: str, page_title: str = "") -> list[str]:
    """从网址各部分推导 Crossref 查询关键词（按可信度排序，依次尝试）。"""
    parts = urlparse(url)
    keywords: list[str] = []

    # 1. 页面标题（og:title 等）——最接近期刊名；
    #    过短的缩写标题（如 HESS 首页 <title> “HESS - Home” -> “HESS”）歧义太大，
    #    直接丢弃，让位于更完整的主机名关键词
    if len(page_title) >= 10 and len(page_title.split()) >= 2:
        keywords.append(page_title)

    # 2. 查询参数值（如 scholars.direct 的 ?jid=fluid-dynamics）
    for key, value in parse_qsl(parts.query):
        if key.lower() in _JID_PARAM_KEYS and 3 < len(value) <= 80:
            keywords.append(value.replace("-", " ").replace("+", " ").strip())

    # 3. 主机名（如 hydrology-and-earth-system-sciences.net -> 期刊全名）
    host_tokens = [
        t for t in parts.netloc.lower().split(".")
        if t and t not in ("www", "com", "net", "org", "co", "uk")
    ]
    if host_tokens:
        keywords.append(" ".join(host_tokens))

    # 4. 路径末段（去 .xml/.php 等扩展名与 -overview 之类的尾巴）
    segments = [s for s in parts.path.split("/") if s]
    if segments:
        slug = segments[-1]
        slug = re.sub(r"\.(xml|php|html?)$", "", slug, flags=re.IGNORECASE)
        slug = re.sub(r"-?overview$", "", slug, flags=re.IGNORECASE)
        slug = re.sub(r"^journal$", "", slug, flags=re.IGNORECASE).strip("-")
        if slug:
            keywords.append(slug.replace("-", " ").strip())

    # 5. journals.aps.org 被 Cloudflare 拦截抓不到页面；其 pr* 前缀 = Physical Review 系列
    if not page_title and "aps.org" in parts.netloc.lower() and segments:
        slug = segments[0].lower()
        if slug.startswith("pr") and len(slug) > 3:
            keywords.insert(0, f"Physical Review {slug[2:]}")

    # 去重、去空，保持顺序
    seen = set()
    unique = []
    for kw in keywords:
        kw = re.sub(r"\s+", " ", kw).strip()
        if kw and kw.lower() not in seen:
            seen.add(kw.lower())
            unique.append(kw)
    return unique


def _norm_text(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", re.sub(r"\s+", " ", str(s or "").lower())).strip()


def _issn_from_query(keywords: list[str]) -> str | None:
    """依次用关键词查 Crossref journals，取第一个带 ISSN 的结果。

    若某关键词的首条结果与关键词完全同名但没有 ISSN（如 scholars.direct 的
    “Journal of Fluid Dynamics”），说明该期刊确实不在 Crossref ISSN 体系内，
    不能拿第二名的同名/近名期刊凑数——换下一个关键词继续尝试。
    """
    for query in keywords:
        try:
            resp = _get(CROSSREF_JOURNALS_API, params={"query": query, "rows": 5})
        except ResolveError:
            continue
        items = resp.json().get("message", {}).get("items", [])
        if not items:
            continue
        if (
            _norm_text(items[0].get("title") or [""][0]) == _norm_text(query)
            and not (items[0].get("ISSN") or [])
        ):
            continue
        for item in items[:3]:
            issns = item.get("ISSN") or []
            if issns:
                return issns[0]
    return None


def search_journals(query: str, rows: int = 8) -> list[dict]:
    """按名称/关键词搜索 Crossref 期刊库，供“手动添加期刊”时挑选候选。"""
    resp = _get(CROSSREF_JOURNALS_API, params={"query": query, "rows": rows})
    items = resp.json().get("message", {}).get("items", [])
    results = []
    for item in items:
        issns = item.get("ISSN") or []
        results.append(
            {
                "title": (item.get("title") or [""])[0] if isinstance(item.get("title"), list) else item.get("title"),
                "issn": issns[0] if issns else "",
                "publisher": item.get("publisher") or "",
            }
        )
    return results


def journal_from_issn(issn: str, url: str = "") -> Journal:
    """ISSN -> 期刊信息（期刊库导入路径：跳过网址解析，直接查 Crossref）。"""
    issn = issn.strip().upper()
    if not re.fullmatch(r"\d{4}-\d{3}[\dX]", issn):
        raise ResolveError(f"ISSN 格式不正确: {issn}")
    return _journal_from_issn(issn, url)


def _journal_from_issn(issn: str, url: str) -> Journal:
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


def resolve_journal(url: str) -> Journal:
    """期刊网址 -> 期刊信息（标题、ISSN）。"""
    url = url.strip()
    if re.fullmatch(r"\d{4}-\d{3}[\dXx]", url):
        return journal_from_issn(url)
    if not re.match(r"^https?://", url):
        url = "https://" + url

    page_html = None
    issn = _issn_in_path(url)
    if not issn:
        page_html = _fetch_page(url)
        issn = _issn_from_html(page_html)
    if not issn:
        keywords = _keywords_from_url(url, _title_from_html(page_html))
        issn = _issn_from_query(keywords)
    if not issn:
        raise ResolveError(f"无法从网址解析出期刊 ISSN: {url}")
    return _journal_from_issn(issn, url)


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
