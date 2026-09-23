"""Sci-Hub 镜像检索与下载支持（默认隐藏下载策略）。

下载流程：默认先走 Sci-Hub 按 DOI 检索并下载（不在界面上显示）；
镜像无法打开时按顺序切换（每个镜像最多等 30 秒）；全部失败后再转入
出版商官方页面下载流程（见 browserdl 的 _run_task）。

镜像列表（按序，默认使用第一个；无法打开则切换下一个）：
    https://sci-hub.al
    https://www.tesble.com
    https://www.wellesu.com

三个镜像为同一套“搜索代理”服务（实测同后端）：
- 命中：检索结果页内嵌 PDF 直链（形如 https://<filehost>/pdf/<doi>.pdf，
  带 download=true 参数时返回附件下载），页面含 id="article" 的 <embed>
  与“↓下载”按钮（onclick 内嵌 location.href 直链）；
- 未命中：小页面，含 “no matching proxies found” / “Scientific mutual aid
  community” 标记，无 PDF 链接。
只有“未命中”（检索结果页成功打开并渲染出上述标记）才能判定该镜像未收录；
网页没打开（超时、HTTP 错误、403 回首页等，可能是网络波动）一律按下载失败
处理并切换下一镜像，绝不据此判定未收录。
"""

from __future__ import annotations

import os

#: Sci-Hub 镜像地址（有序，默认第一个；无法打开 30s 后切换下一个）
SCIHUB_MIRRORS: tuple[str, ...] = (
    "https://sci-hub.al",
    "https://www.tesble.com",
    "https://www.wellesu.com",
)

#: 单个镜像打开的最长秒数：超时视为“无法打开”，切换下一镜像
MIRROR_OPEN_BUDGET = 30
#: 镜像打开成功后，等待检索结果渲染的最长秒数
MIRROR_RESULT_GRACE = 20
#: 触发 PDF 后等待下载开始/完成的最长秒数
DOWNLOAD_BUDGET = 90


def scihub_enabled() -> bool:
    """Sci-Hub 策略开关（默认开启）。

    环境变量 SCIHUB_ENABLED=0/false/off 时关闭，直接走出版商官方页面
    下载（便于单独调试官方流程）。
    """
    return os.environ.get("SCIHUB_ENABLED", "1").strip().lower() not in (
        "0",
        "false",
        "off",
        "no",
    )


def scihub_page_url(mirror: str, doi: str) -> str:
    """拼接 Sci-Hub DOI 检索地址：https://<mirror>/<doi>。"""
    return f"{mirror.rstrip('/')}/{doi.strip().lstrip('/')}"


def ensure_download_param(pdf_url: str) -> str:
    """确保 PDF 直链带 download=true（强制附件下载，触发浏览器下载事件）。"""
    if "download=" in pdf_url:
        return pdf_url
    return pdf_url + ("&" if "?" in pdf_url else "?") + "download=true"


#: 在检索结果页内执行：提取 PDF 直链 / 未命中 / 人机验证信号
PAGE_STATE_JS = """() => {
  let pdfUrl = '';
  const embed = document.querySelector('embed[src*=".pdf"], object[data*=".pdf"]');
  if (embed) {
    pdfUrl = embed.getAttribute('src') || embed.getAttribute('data') || '';
  }
  if (!pdfUrl) {
    // “↓下载”按钮：onclick="location.href='https://...pdf?download=true'"
    const html = (document.body && document.body.innerHTML) || '';
    const m = html.match(/location\\.href\\s*=\\s*['"](https?:[^'"]+?\\.pdf[^'"]*)['"]/i)
      || html.match(/href\\s*=\\s*['"](https?:[^'"]+?\\/pdf\\/[^'"]*?\\.pdf[^'"]*)['"]/i);
    if (m) pdfUrl = m[1].replace(/\\\\/g, '/');
  }
  if (!pdfUrl) {
    pdfUrl = [...document.querySelectorAll('a[href*=".pdf"]')]
      .map((a) => a.href)
      .find((h) => /\\/pdf\\//i.test(h)) || '';
  }
  const text = ((document.body && document.body.innerText) || '').slice(0, 5000);
  const cf = /just a moment|attention required|verify you are human|checking your browser|请稍候|正在进行安全验证|确认您不是自动程序/i.test(text)
    || !!document.querySelector('#challenge-form, .cf-browser-verification, iframe[src*="challenges.cloudflare.com"]');
  // 未命中标记：该镜像族固定文案（命中页不含这些字样）
  const notFound = !pdfUrl && /no matching proxies found|mutual aid community|cannot be found|no article (found|available)|cannot find (the )?article/i.test(text);
  return { pdfUrl, notFound, cf, title: document.title || '', url: location.href };
}"""
