"""ResearchGate 公开全文检索与下载支持（默认第二下载源，位于 Sci-Hub 之后、
出版商官方页面之前）。

下载流程：Sci-Hub 失败后，按 DOI 在 ResearchGate 检索文献页；文献页存在
公开全文（作者自行上传，页面有 "Download full-text PDF" 入口）则直接下载；
明确无公开全文（仅有 "Request full-text" 请求入口，或检索无结果）属确定性
结论，记 researchgate=unavailable；网页没打开（超时 / HTTP 403 / 反爬拦截 /
登录墙）一律按下载失败处理转官方页面，绝不据此判定无公开全文。

权限判定原则（仔细判定，避免误标 unavailable）：
- researchgate=available：只有真实下载成功（_finalize 按来源写入）；
- researchgate=unavailable：仅以下三种“检索/文献页成功打开并渲染”后的
  确定性结论——
    1. 检索页渲染完成但没有任何该 DOI 的文献结果；
    2. 文献页渲染完成且明确显示 "Request full-text"（仅可请求，无公开 PDF）；
    3. 文献页渲染完成但既无下载入口也无请求入口（作者未上传公开全文）；
- 其余一切失败（打开超时、HTTP 错误、人机验证未通过、刷新后仍无响应、
  下载直链失败）均按“该下载源失败”处理，不写权限记录。
"""

from __future__ import annotations

import os
import urllib.parse

#: ResearchGate 站点地址
RG_SITE = "https://www.researchgate.net"

#: 打开检索/文献页的最长秒数：超时视为“无法打开”，按下载失败处理
RG_OPEN_BUDGET = 40
#: 检索/文献页打开后，等待内容渲染的最长秒数（判定前的宽限期）
RG_RESULT_GRACE = 20


def researchgate_enabled() -> bool:
    """ResearchGate 策略开关（默认开启）。

    环境变量 RESEARCHGATE_ENABLED=0/false/off 时关闭，Sci-Hub 失败后直接
    转出版商官方页面。
    """
    return os.environ.get("RESEARCHGATE_ENABLED", "1").strip().lower() not in (
        "0",
        "false",
        "off",
        "no",
    )


def official_enabled() -> bool:
    """出版商官方页面开关（默认开启；调试 ResearchGate 通道时可关闭）。"""
    return os.environ.get("OFFICIAL_ENABLED", "1").strip().lower() not in (
        "0",
        "false",
        "off",
        "no",
    )


def search_url(doi: str) -> str:
    """ResearchGate 检索地址（与手动检索同一入口）。

    使用与界面搜索框等效的 search.Search.html?query=<DOI>&type=publication：
    输入 DOI 后 ResearchGate 会直接解析并跳转到文献页。不要用 /search?q=
    （会被重定向到 publication 搜索页且 DOI 检索无直接结果），也不要给
    DOI 加引号（精确短语匹配反而搜不到）。
    """
    query = urllib.parse.quote(doi.strip(), safe="")
    return f"{RG_SITE}/search.Search.html?query={query}&type=publication"


def is_publication_url(url: str) -> bool:
    """判断链接是否为 ResearchGate 文献页（/publication/<数字ID>_…）。"""
    return bool(url) and "/publication/" in url


#: 在检索结果页 / 文献页内执行：提取下载入口 / 仅可请求 / 无结果 / 拦截信号。
#: 一次评估同时覆盖两类页面，由 Python 侧按页面阶段取用对应字段：
#:   检索页：pubLinks（/publication/ 结果链接）+ rendered（页面已渲染）；
#:   文献页：downloadUrl（公开全文下载入口）/ requestOnly（仅可请求全文）。
PAGE_STATE_JS = """() => {
  const text = ((document.body && document.body.innerText) || '').slice(0, 8000);
  const cf = /just a moment|attention required|checking your browser|verify you are human|请稍候|正在进行安全验证|确认您不是自动程序/i.test(text)
    || !!document.querySelector('#challenge-form, .cf-browser-verification, iframe[src*="challenges.cloudflare.com"]');
  // ResearchGate 反爬拦截页（403/限流）：标题与正文有固定文案
  const blocked = /sorry, we'?re busy|too much traffic|unusual activity|access denied|access is temporarily restricted/i.test(text)
    || /sorry, we'?re busy|too much traffic/i.test(document.title || '');
  // 检索结果页：指向 /publication/<数字ID> 的结果链接（去重取前 5 个）
  const pubLinks = [...new Set(
    [...document.querySelectorAll('a[href*="/publication/"]')]
      .map((a) => a.href)
      .filter((h) => /researchgate\\.net\\/publication\\/\\d+/.test(h))
  )].slice(0, 5);
  // 页面已渲染的信号：有搜索框，或正文有实质内容
  const rendered = !!document.querySelector('input[name="q"], form[action*="search"], input[type="search"]')
    || ((document.body && document.body.innerText) || '').length > 300;
  // 文献页公开全文下载入口：/fulltext/ 链接，或 "Download full-text PDF" 按钮/链接
  let downloadUrl = '';
  const dl = document.querySelector('a[href*="/fulltext/"]')
    || [...document.querySelectorAll('a[download], a.btn, button')].find((a) =>
      /download\\s+full-?text\\s+pdf/i.test((a.innerText || '').trim()));
  if (dl && dl.href && dl.href.includes('researchgate.net')) downloadUrl = dl.href;
  if (!downloadUrl) {
    const m = (document.body && document.body.innerHTML || '').match(
      /href\\s*=\\s*['"](https?:\\/\\/[^'"]*researchgate\\.net[^'"]*\\/fulltext\\/[^'"]+)['"]/i);
    if (m) downloadUrl = m[1].replace(/\\\\/g, '/');
  }
  // 仅可请求全文（无公开 PDF 的确定性信号；命中时页面上不会有下载入口）
  const requestOnly = !downloadUrl
    && /request (the )?full-?text|full-?text available on request|request publication/i.test(text);
  // 登录墙：出现密码输入框说明被要求登录，无法判定公开全文状态
  const loginWall = !!document.querySelector('input[type="password"]');
  const title = document.title || '';
  return { downloadUrl, requestOnly, pubLinks, rendered, cf, blocked, loginWall, title, url: location.href };
}"""
