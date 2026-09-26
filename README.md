# journal-paper-downloader

[English](#english) | [中文](#中文说明)

---

## English

**Journal paper downloader**: enter a journal's website URL to search its papers, generate a download manifest, scan your local disk, and then batch-download paper PDFs using **browser automation**.

Usage: **interactive Web UI** (`npm start`).

### Data sources

| Source | Purpose |
|---|---|
| [Crossref](https://www.crossref.org/) | Look up paper metadata (title, authors, year, landing page) by DOI / title |
| Sci-Hub mirrors | **Default (hidden) download source**: the DOI is looked up on the Sci-Hub mirror list (`sci-hub.al` → `www.tesble.com` → `www.wellesu.com`); when a mirror first serves a Cloudflare challenge page (403 "Just a moment…"), the worker auto-verifies within the per-page wait and lets the page finish loading instead of giving up early; a mirror is switched only when it cannot be opened (30 s timeout) or stays on its home page with no search result for 15 s |
| ResearchGate | Second source when Sci-Hub fails: the DOI is searched on ResearchGate; if the publication page has a public full text ("Download full-text PDF"), it is downloaded directly; the search/publish wait and refresh budgets reuse the per-page settings. Deterministic no-public-fulltext conclusions (search shows no results / "Request full-text" only / no download entry) are recorded as `researchgate: unavailable`; blocked pages / login walls count as plain failures and never set it |
| Publisher pages | Final fallback when both Sci-Hub and ResearchGate fail: open the article page via browser automation and trigger the PDF download |

> Note: the Sci-Hub / ResearchGate steps are built-in default strategies and are not exposed in the UI. Environment switches for debugging: `SCIHUB_ENABLED=0` skips Sci-Hub, `RESEARCHGATE_ENABLED=0` skips ResearchGate, `OFFICIAL_ENABLED=0` skips the publisher page. For single-DOI ResearchGate-channel debugging use `python -m paper_dl.rgdebug <DOI> [save-dir]` (it forces Sci-Hub and the official page off).

### Installation

```bash
pip install -r requirements.txt          # requests + playwright
python -m playwright install chromium    # optional: Playwright's bundled browser (skip if you use Chrome/Edge)
```

The Web UI is served by Node.js with zero third-party dependencies — no `npm install` required.

### Web UI (recommended)

```bash
npm start
```

On startup the terminal prints the access URL (default `http://localhost:3210`; if the port is taken, use `PORT=xxxx npm start`). The browser is **not** opened automatically — copy the URL into your browser manually.

**UI language** — the selector in the header switches the interface between 中文 and English on the fly. Your choice is stored in the browser (localStorage); by default it follows your browser language and falls back to Chinese when unrecognized.

The UI has two modules.

**1. Literature search**

- The journal URL field supports **multiple journals**: click "＋ 增加期刊网址" to add an input row; each row takes one journal **URL or ISSN**; click "检索期刊" to resolve them all (ISSN is auto-detected; publisher home pages such as Wiley / Nature / Springer / AMS are supported, and sites behind anti-bot walls such as journals.aps.org are matched via Crossref keyword search).
- **Journal library** (期刊库, `journal-library.json` in the site root, shipping with a curated default of 21 verified journals): click "📚 期刊库" to open the library dialog, where you can
  - tick journals (or “全选”) and click "导入所选至检索栏" to **batch-import their URLs into the search bar**;
  - **add a journal manually**: type a journal name or URL and click "联网搜索" — the project searches Crossref online and lists candidate journals (name / ISSN / publisher) for you to confirm before adding;
  - **edit** any entry's name or URL (a changed URL is re-confirmed online for its ISSN) or **remove** it — changes are saved to `journal-library.json` immediately.
- The tree is **lazy-loaded in three levels** to keep the page light:
  1. **Journal level**: only the journal name and the selected/total paper count are shown; no papers are loaded yet;
  2. Click a journal name → **one page** of its volume list is loaded (other journals collapse at the same time). Expanding does **not** scan the whole journal in the background anymore — that retrieval is deferred to “生成下载清单” so checkbox clicks are never interrupted by re-rendering; a “检索全部卷” button is provided in the volume-list footer if you want the complete volume list immediately. Metadata is cached page by page per ISSN on the server (`server/cache/`) and reused on the next visit;
  3. Click a volume name → only then are its **paper titles** listed (other volumes' lists collapse at the same time); clicking a paper title shows the title, date, authors, DOI, etc. in the right panel.
- Checkbox cascading: checking a journal node is a **whole-journal select-all that takes effect immediately**, regardless of whether the volume list has finished loading (the count falls back to the journal's total; the full scan runs when the list is generated). A “全选” checkbox next to “已选 x 篇” selects/unselects **every retrieved journal** at once. After selecting a whole journal/volume you can still uncheck individual volumes/papers.
- When you click "生成下载清单", any journal that was not fully searched beforehand is auto-completed first (progress shown: "清单准备中：《期刊》文献检索 x / 约 y 篇…"), then the server expands the selection into full paper records. **One manifest file is generated per journal** (`任务清单-期刊名.json`, overwriting any existing file of the same name — no more `-1`/`-2` suffixes), and together they become the current pending manifest;
- After generating, click "**保存任务清单**": the current manifest is saved per journal (`任务清单-期刊名.json`, same-name overwrite), and a copy of each file is downloaded to your machine via the browser.

**2. Scan & download**

- Set a local directory (e.g. `/mnt/d/paper`) and click "扫描本地目录" to check which PDFs from the manifest already exist (**PDFs only — info files are not considered**); a simple validity check is also performed (non-empty, `%PDF-` header, `%%EOF` tail), and a corrupted PDF (0 bytes, HTML error page, truncated download) is treated as missing so it gets re-downloaded; on top of that, a **deep quality check** runs on files that pass the basic check — cross-reference structure validation (`startxref` → `xref` table / xref-stream object), zero-filled-body detection and HTML-content detection — to catch files that look complete but cannot actually be opened; such files are **deleted at scan time** (the summary reports “已删除损坏 PDF N 份”) and re-downloaded when the download queue reaches them; if deletion fails (file locked), the re-download overwrites the old file;
- Click "下载缺失文件" to download the missing papers one by one; files are stored as `local dir/journal name/volume/paper name/`; during a run you can click "停止下载" to interrupt the current item, then "继续下载" to retry from the interrupted item and continue the queue; the download list **shows pending papers only** — already-existing and successfully-downloaded entries are no longer displayed (the summary still reports full counts), keeping the list focused on missing / failed / no-access papers for debugging;
- PDFs are named after the DOI suffix (e.g. DOI `10.1029/2025JC023188` → `2025JC023188.pdf`); a same-name `.txt` info file (title, date, authors, DOI, etc.; can be disabled via checkbox) is (re)generated after each download;
- **Permission records (triple-path)**: every download confirms the paper's access rights and writes a permission record file (`<DOI suffix>.access.json`) into the paper's target folder. The record carries three download sources — `official`: the publisher's official-page access (`granted` / `denied`); `scihub`: whether Sci-Hub has the paper (`available` / `unavailable` — `unavailable` is set **only when a mirror's DOI search page actually loads and explicitly reports the DOI as not found**; unopened pages, HTTP errors and network failures count as download failures and never set it); `researchgate`: whether ResearchGate has a public full text (`available` / `unavailable` — `unavailable` is set **only when the search/publication page actually loads and clearly shows no public full text** (no results / "Request full-text" only / no download entry); blocked pages, login walls and network failures count as download failures and never set it). Each path updates itself only and keeps the other paths' known state (legacy single-`access` records are read as the `official` path; records without `researchgate` are treated as unknown and are never skipped until ResearchGate has been checked). Before every download the record is scanned automatically: the paper is skipped **only when all three paths are marked as no** (`official: denied`, `scihub: unavailable` and `researchgate: unavailable`) — delete the record file to retry. The scan report also shows how many missing papers are marked no on all three paths;
- **Info files**: the matching info file (`.txt`) is generated automatically for every successful download (no UI toggle);
- **Download method**: browser automation with a built-in default strategy (not shown in the UI): first try a DOI lookup on the Sci-Hub mirrors (`sci-hub.al` → `www.tesble.com` → `www.wellesu.com`, 30 s per mirror before switching to the next); when Sci-Hub fails (not indexed / mirror not openable / PDF link failed), automatically fall back to the publisher's official page, where the browser passes any human verification and triggers the PDF download; set `SCIHUB_ENABLED=0` to skip Sci-Hub entirely;
- **Skip no-access sources (three options)**: Sci-Hub / ResearchGate / publisher page can each be checked — a checked source is skipped when its permission record says no; unchecked sources are retried even when recorded as no. When all three are skipped the paper is skipped outright without opening any page.
- **ResearchGate "Request full-text" handling**: when a publication page has no public full text and only offers "Request full-text", the worker simulates clicking it (including the confirmation dialog) to request the paper from the author — `researchgate` is **not** marked unavailable, and the flow continues to the publisher page;
- **Early paywall detection on publisher pages**: Springer / Wiley purchase panels ("Log in via an institution / Buy article PDF / Institutional subscriptions / Get access to the full version…") are detected within 5 s of page load and skipped immediately instead of waiting out the whole no-response window;
- **Browser choice**: you can specify which browser to use (Chrome by default / Auto / Edge / Firefox / Safari; stored in the browser and still effective on the next visit); "Auto" tries local Chrome, then Edge, then the bundled Chromium in order; picking a specific browser launches it directly when downloading (switching browsers rebuilds the browser instance automatically);
- **Settings auto-memory**: the local directory, wait/refresh/verification/task-interval values, the browser choice and all other settings are saved automatically; reopening the site restores the settings from the last task run (stored server-side in `server/state.json`, so it also works when opening from a different browser);
- **Refresh**: during a run you can click "⟳ 刷新" — it keeps your current inputs (the saved directory and other settings stay unchanged), resets the download state and re-scans, after which you can click "下载缺失文件" again to download in sequence.

#### Task manifest management

The current pending manifest is shown in the "扫盘与下载" module (entry count and file list). When the site opens it **reuses the manifest(s) from the last task**; after generating manifests in "文献检索", importing some, or generating not-downloaded manifests, the current manifest set switches automatically and is persisted (`server/state.json`). **Multiple manifests can be active at once** — they are merged (deduplicated by DOI) for scanning and downloading.

- **Import task manifests** (导入任务清单, batch, single entry): enter one or more manifest JSON file paths (absolute, or relative to the site root; separate multiple paths with commas / semicolons / newlines) in the input and click "导入任务清单" (or press Enter); when the input is empty, clicking the button opens a file picker so you can select several manifest files at once (e.g. all 20+ journal lists of the library — tested with 22 lists / ~210k entries in one go) — all of them are imported together, merged as the current pending manifest, and re-scanned automatically. Manifests stored in the site root are imported **by filename only** (a few KB per request, so even huge libraries never hit request-body limits); files outside the root fall back to content upload, one file per request, and the request-body cap is 512 MB;
- **Generate not-downloaded manifest** (生成未下载清单): after a scan, save the **not-yet-downloaded entries** of the current manifest as new manifests, **one per journal** (`任务清单-未下载-期刊名.json`, same-name overwrite — no more `-1`/`-2` suffixes), and switch them to the current pending manifest automatically; legacy numbered files (`…-1.json`, `…-2.json`) are cleaned up automatically whenever a manifest is written;
- **Save task manifest** (保存任务清单): save the current pending manifest per journal as `任务清单-期刊名.json` (same-name overwrite).

#### Browser automation details

- The browser window stays visible and one instance is reused throughout: each paper opens in a new tab, which is closed before the next one is processed;
- The PDF entry point is found automatically: it first clicks a PDF link/button on the page, falling back to `citation_pdf_url` or the publisher's canonical direct link;
- **Inline PDF viewer pages**: Edge / Chrome render inline PDFs (`Content-Type: application/pdf` without an attachment header, e.g. APS supplemental PDFs) in the built-in viewer instead of firing a download event. When the current page is detected as a PDF viewer page (URL ending in `.pdf`), the automation fetches the file bytes with the browser session (cookies included), verifies the `%PDF` magic and saves it directly — equivalent to clicking “Save” in the viewer, so such pages are no longer mistaken for “no download entry”;
- **Wait & refresh**: each page is given "每页等待时间" (default 5 minutes) for the download to start; if there is no response the page refreshes automatically, and after "最大刷新次数" (default 3) refreshes with no response it reports an error and moves on to the next paper;
- **Human verification (auto-click)**: when a Cloudflare human verification / anti-bot interstitial is detected, an auto-verification loop starts — every "验证点击间隔" (default 5 s) it simulates a click on the verification control (covers Cloudflare Turnstile / reCAPTCHA / hCaptcha checkboxes and page-level "confirm you are human" buttons; the checkbox sits in the component's closed shadow DOM, so the click is placed at its fixed coordinates within the component; click priority: iframe-internal element → parent-page iframe coordinates → page-level button). Note: the simulated click does not move the cursor, so seeing no mouse movement in the browser window is normal — the status text in the download list ("第 x/N 次尝试") reflects the real progress. After "验证失败几次后刷新" (default 5) consecutive failed attempts the page is refreshed to re-verify; **all of this time counts against "每页等待时间"** — when the window is exhausted, the no-response logic consumes a refresh; once verified, the download continues automatically without consuming a refresh; the banner always offers "刷新验证页" or "跳过此篇";
- **Login (manual)**: when a login page is detected, the page stays open until you finish logging in in the browser window, then continues automatically (you can also click the download manually); the login state is kept in the local browser profile, so later downloads pass automatically;
- **Anti-detection**: an anti-detection script is injected at startup (hides automation fingerprints such as `navigator.webdriver`, fills in `window.chrome` / plugins / languages / permissions) and Playwright's default `--enable-automation` argument is removed, lowering the chance of being identified as an automated browser (Chrome / Edge recommended; anti-detection works best on Chromium-based browsers);
- Verification status uses "two consecutive clean checks" to confirm success, avoiding a misjudgement in the instant of a page transition that would interrupt the verification midway;
- **No false refresh after a successful verification**: after Turnstile / reCAPTCHA passes, its component iframe remains on the page; the code reads the verification token (hidden input value) to detect "already passed" and won't treat a passed check as still-verifying and refresh the page into a re-verification; after passing, it also won't re-navigate and interrupt a download that has already started;
- **Popup child windows (verification / download entry) are followed automatically**: when a publisher puts the flow in a child window, the code brings the new window to the front (so it is not hidden behind the main window) and switches to the newest child window for detection and clicking; please complete the verification inside the child window and avoid clicking outside it (on some sites the child window auto-closes on blur).
- **Download detection & landing**: once a PDF enters the browser's download queue, the code waits for the download to complete, then moves/renames it into the target directory per the naming rule (the original download file is removed immediately), generates the info file automatically, and records the confirmed access on the matching path of the permission record file (`scihub: available` for a Sci-Hub download, `researchgate: available` for a ResearchGate download, `official: granted` for a publisher download);
- **Task interval**: a default 5 s pause (adjustable) between adjacent downloads avoids a request rate that websites might treat as malicious;
- **Browser choice**: Auto / Chrome / Edge / Firefox / Safari are selectable in the UI. Chrome / Edge / Auto use Playwright's Chromium channel; Firefox / Safari (WebKit engine) use their respective engines — if not installed, run `python -m playwright install firefox` or `python -m playwright install webkit` first;
- Cookies and login state are kept per browser family in local browser profile directories (the Chromium family shares one directory; Firefox / WebKit each have their own), so after one institutional login, subsequent downloads pass automatically.

Install the following before using browser automation (if missing, a download will show explicit install instructions):

```bash
pip install playwright && python -m playwright install chromium
# To select Firefox / Safari (WebKit) in the UI, also run:
# python -m playwright install firefox
# python -m playwright install webkit
```

> Note: by default each download first tries the (hidden) Sci-Hub mirror list, then ResearchGate, and only falls back to the publisher's official page when both cannot deliver the PDF — the publisher flow simulates a normal manual download and never bypasses paywalls or verification mechanisms. Use `SCIHUB_ENABLED=0` / `RESEARCHGATE_ENABLED=0` when launching the worker to skip those sources.

### Project layout

```
paper_dl/
├── __main__.py      # python -m paper_dl entry point (points you to the Web UI)
├── resolvers.py     # DOI / arXiv / title resolution (Crossref) and publisher canonical links
├── journal.py       # journal URL parsing (ISSN) and paper fetching (Crossref cursor pagination)
├── downloader.py    # file naming rules and info-file generation
├── browserdl.py     # browser-automation download worker (Playwright, stdin/stdout JSON protocol)
└── webcli.py        # JSON interface (called by the Web server)
server/
├── index.js         # Node Web server (zero dependencies, started via npm start)
└── cache/           # journal paper scan cache (appended page by page per ISSN, generated at runtime)
web/
├── index.html       # interactive page (literature search + scan & download)
├── app.js
├── i18n.js          # UI i18n (zh / en)
└── style.css
```

### License

[MIT](LICENSE)

---

## 中文说明

期刊文献下载工具：输入期刊网址检索文献、生成下载清单、扫盘后通过**浏览器自动化**批量下载论文 PDF。

用法：**Web 交互界面**（`npm start`）。

### 数据来源

| 渠道 | 用途 |
|---|---|
| [Crossref](https://www.crossref.org/) | 按 DOI / 标题检索论文元数据（标题、作者、年份、落地页） |
| Sci-Hub 镜像 | **默认（不在界面显示）下载源**：按 DOI 依次尝试镜像列表（`sci-hub.al` → `www.tesble.com` → `www.wellesu.com`）；镜像先返回 Cloudflare 挑战页（403“Just a moment…”）时会在每页等待时间内自动验证、等待页面加载出检索结果，而不是未加载完就放弃；镜像无法打开（30 秒超时）或停在首页 15 秒无检索页才切换下一个 |
| ResearchGate | Sci-Hub 失败后的第二下载源：按 DOI 在 ResearchGate 检索，文献页存在公开全文（"Download full-text PDF"）时直接下载；检索与刷新沿用每页等待/刷新设置。确定性无全文结论（检索无结果 / 仅可 Request full-text / 无下载入口）记 `researchgate: unavailable`；页面被拦截 / 跳登录墙按下载失败处理，绝不标记 |
| 出版商页面 | Sci-Hub 与 ResearchGate 均失败后的最终回退：浏览器自动化打开文章页并触发 PDF 下载 |

> 说明：Sci-Hub 与 ResearchGate 均为内置默认策略，不在界面上显示任何选项。调试用环境开关：`SCIHUB_ENABLED=0` 跳过 Sci-Hub，`RESEARCHGATE_ENABLED=0` 跳过 ResearchGate，`OFFICIAL_ENABLED=0` 跳过官方页面；单篇 DOI 调试 ResearchGate 通道可用 `python -m paper_dl.rgdebug <DOI> [保存目录]`（强制关闭 Sci-Hub 与官方路径）。

### 安装

```bash
pip install -r requirements.txt          # 核心依赖（requests + playwright）
python -m playwright install chromium    # 可选：浏览器自动化内置浏览器（已有 Chrome/Edge 可跳过）
```

Web 界面由 Node.js 提供（无第三方依赖），无需 `npm install`。

### Web 交互界面（推荐）

```bash
npm start
```

启动后终端会打印访问链接（默认 `http://localhost:3210`，端口被占用时可用 `PORT=xxxx npm start` 更换）；**不会自动打开浏览器**，请手动复制地址访问。

**界面语言**——顶部语言选择器可在 中文 / English 之间即时切换界面；选择保存在浏览器（localStorage），默认跟随浏览器语言，无法识别时回退为中文。

界面包含两个模块：**1. 文献检索**

- 期刊网址栏支持**多个期刊**：点“＋ 增加期刊网址”添加输入行，每行填一个期刊**网址或 ISSN**；点“检索期刊”统一解析（自动识别 ISSN，支持 Wiley / Nature / Springer / AMS 等出版商主页，journals.aps.org 这类有反爬拦截的站点会改用 Crossref 关键词匹配）。
- **期刊库**（`journal-library.json`，位于网站根目录，自带 21 本经过验证的默认期刊）：点“📚 期刊库”打开弹窗，可以
  - 勾选期刊（或“全选”）后点“导入所选至检索栏”，把期刊地址**批量导入**检索栏；
  - **手动添加期刊**：输入期刊名称或网址后点“联网搜索”，项目会联网（Crossref）检索并列出候选期刊（名称 / ISSN / 出版商）供确认后加入；
  - **编辑**任一期刊的名称或检索地址（地址变更时自动联网重新确认 ISSN）、**删除**条目——改动即时保存到 `journal-library.json`。
- 目录为**三级懒加载**，尽量减小页面负担：
  1. **期刊级**：只显示期刊名与 已选/总文献 数量，不加载具体文献；
  2. 点击期刊名 → 只加载**一页**卷目录（同时收起其他期刊）。展开不再后台检索整本期刊——这部分可移动的检索工作统一推迟到点击“生成下载清单”时进行，避免检索过程中的反复重绘打断勾选操作；如需立即看全部卷，可点卷目录下方的“检索全部卷”按钮。文献元数据在服务端按 ISSN 逐页缓存（`server/cache/`），下次打开直接复用；
  3. 点击卷名 → 才列出该卷**文献名称**（同时收起其他卷的文献列表），点击文章标题在右侧查看标题、日期、作者、DOI 等详情。
- 勾选支持级联：勾选期刊节点即**整刊全选，立即生效**，与卷目录是否加载完无关（已选数量按期刊总数显示，完整检索在生成清单时自动补全）；“已选 x 篇”旁的“全选”复选框可一次性勾选/取消**所有已检索期刊**；整刊/整卷勾选后仍可单独取消某卷或某篇。
- 点击“生成下载清单”时，若期刊此前未完整检索，会先对每本期刊自动补全检索（带进度显示：“清单准备中：《期刊》文献检索 x / 约 y 篇…”），再由服务端按选择集展开为完整文献信息，**按期刊拆分生成清单文件**（`任务清单-期刊名.json`，每刊一份，同名直接覆盖，不再追加 `-1`/`-2` 序号），并共同设为当前待执行清单（合并镜像同时缓存到 `download-manifest.json`）；
- 生成清单后可点“**保存任务清单**”：按期刊分别保存为 `任务清单-期刊名.json`（同名覆盖），同时通过浏览器逐份下载到本机。

**2. 扫盘与下载**

- 设置本地目录（如 `/mnt/d/paper`），点击“扫描本地目录”检查清单中每篇文献的 PDF 是否已存在（**仅判断 PDF，不看信息文件**）；同时简单校验 PDF 是否正常（非空、头部含 `%PDF-`、尾部含 `%%EOF`），异常文件（0 字节、HTML 错误页、下载中断的残缺文件）按不存在处理，可重新下载；在此基础上还有**深度质量检查**——对通过粗检的文件再验证交叉引用结构（`startxref` 指向 `xref` 表或 xref 流对象）、检测空字节填充与 HTML 伪装内容，识别“看着完整但实际打不开”的损坏 PDF：此类文件在**扫描时直接删除**（汇总显示“已删除损坏 PDF N 份”），下载队列轮到时自动重新下载；删除失败（文件被占用）时重新下载会覆盖旧文件；
- 点击“下载缺失文件”依次下载缺失文献，保存结构为 `本地目录/期刊名/出版卷/文章名/`；下载过程中可点“停止下载”中断当前条目，再点“继续下载”从被中断的条目重新下载并继续队列；下载列表**只显示待处理文献**——已存在的与已下载成功的条目不再显示（汇总统计仍报告完整数量），列表聚焦缺失、失败与无权限文献，便于调试；
- PDF 以 DOI 尾缀命名（如 DOI `10.1029/2025JC023188` → `2025JC023188.pdf`），同时生成同名 `.txt` 信息文件（标题、日期、作者、DOI 等，可取消勾选），每次下载后重新生成；
- **权限记录（三路径）**：每次下载都会确认该文献的访问权限，并在其保存目录写入权限记录文件（`DOI尾缀.access.json`）。记录包含三个下载源——`official`：官方网页（出版商）访问权限（`granted` / `denied`）；`scihub`：Sci-Hub 是否收录该文献（`available` / `unavailable`；`unavailable` **仅在检索结果页成功打开并明确报告未收录时标记**——镜像打不开 / HTTP 错误 / 网络波动一律按下载失败处理，不标记）；`researchgate`：ResearchGate 是否有公开全文（`available` / `unavailable`；`unavailable` **仅在检索/文献页成功打开并明确显示无公开全文时标记**——检索无结果 / 仅可 Request full-text / 无下载入口三种确定性结论；页面被拦截、跳登录墙、网络波动一律按下载失败处理，不标记）。各路径只更新自己、保留其他路径的已知状态（旧版单 `access` 字段记录按 `official` 路径读取；缺少 `researchgate` 字段的记录视为未知，在 ResearchGate 补查之前不会跳过）。下载前始终自动扫描该记录：**仅当三条路径都标记为“无”**（`official: denied`、`scihub: unavailable` 且 `researchgate: unavailable`）时才直接跳过该篇——删除记录文件后可重试；扫盘结果会显示缺失条目中三条路径均标记为“无”的数量；
- **信息文件**：每次成功下载都会自动生成配套信息文件（`.txt`），无需界面开关；
- **无权限时跳过对应下载源（三个选项）**：设置区可分别勾选 Sci-Hub / ResearchGate / 官方页面——勾选后，该下载源在权限记录为“无”时直接跳过，不再尝试；不勾选则即便记录为无也依旧尝试。三个源都被跳过时整篇直接跳过（不再打开任何页面）。
- **ResearchGate “Request full-text” 处理**：文献页无公开全文、仅显示 “Request full-text” 时，会自动模拟点击向作者请求全文（含确认对话框的补充点击）——**不标记 researchgate 无权限**，随后继续官方页面下载；
- **官网付费墙早判**：Springer / Wiley 等购买面板（“Log in via an institution / Buy article PDF / Institutional subscriptions / Get access to the full version…”）在页面加载后 5 秒内即可判定为无权限并立即跳过，不再按“无响应”空等整轮等待时间；
- **下载方式**：浏览器自动化 + 内置默认策略（不在界面显示）——按 **Sci-Hub → ResearchGate → 官方页面** 的顺序尝试。先走 Sci-Hub 镜像按 DOI 检索下载（`sci-hub.al` → `www.tesble.com` → `www.wellesu.com`，某个镜像无法打开 30 秒后自动切换下一个）；失败后转 ResearchGate：按 DOI 检索文献页，存在公开全文（"Download full-text PDF"）即直接下载（检索等待与刷新沿用每页等待/无响应刷新设置；检索无结果 / 仅可 Request full-text / 无下载入口记 `researchgate: unavailable`，页面被拦截 / 跳登录墙按下载失败处理不标记）；仍失败最后转文献官方页面：用 Playwright 驱动本机真实浏览器打开文章页、通过人机验证并触发 PDF 下载。环境开关：`SCIHUB_ENABLED=0` / `RESEARCHGATE_ENABLED=0` / `OFFICIAL_ENABLED=0`；单篇调试 ResearchGate 用 `python -m paper_dl.rgdebug <DOI> [保存目录]`；
- **浏览器选择**：浏览器自动化可按需指定所用浏览器（Chrome 默认 / 自动 / Edge / Firefox / Safari，保存在浏览器中，下次打开仍生效）；“自动”会依次尝试本机 Chrome、Edge、内置 Chromium，选中其他浏览器时下载时直接启动对应浏览器（切换浏览器会自动重建浏览器实例）；
- **设置自动记忆**：本地目录、等待/刷新/验证/任务间隔、浏览器选择等全部设置会自动保存；下次打开网站自动恢复上次执行任务时的设置（保存在服务端 `server/state.json`，换浏览器打开也生效）；
- **刷新**：下载过程中可点“⟳ 刷新”——保留当前输入（保存目录等设置不变），重置下载状态并重新扫盘，之后可再次点击“下载缺失文件”依次下载。

#### 任务清单管理

当前待执行清单显示在“扫盘与下载”模块中（含条目数与文件列表）。网站打开时自动沿用**上次任务所用清单**；在“文献检索”生成清单、在此导入清单或生成未下载清单后，当前清单自动切换并持久化（`server/state.json`）。**支持多份清单同时激活**——扫描与下载按合并后的清单执行（按 DOI 去重）。

- **导入任务清单（支持批量，单一入口）**：在输入框填入一份或多份清单 JSON 文件路径（绝对路径，或相对网站根目录的相对路径；多份清单用逗号 / 分号 / 换行分隔），点“导入任务清单”（或回车）载入；输入框为空时点击按钮会打开文件选择器，可一次选择多份清单文件（实测 22 份期刊清单 / 约 21 万条一次性导入无报错）——全部导入后合并设为当前待执行清单并自动重新扫盘。存放在网站根目录的清单**只按文件名导入**（每次请求仅几 KB，大清单库也不会触发请求体上限）；根目录外的文件回退为逐份上传内容，请求体上限 512MB；
- **生成未下载清单**：扫盘后可点击，按本地目录扫描结果把当前清单里**未下载的条目**按期刊分别另存为新清单（`任务清单-未下载-期刊名.json`，每刊一份，同名覆盖，不再追加序号）并自动切换为当前待执行清单；生成时会自动清理历史上带 `-1`/`-2` 序号的不合规清单文件；
- **保存任务清单**：把当前待执行清单按期刊分别保存为 `任务清单-期刊名.json`（同名覆盖）。

#### 浏览器自动化细节

- 浏览器窗口保持可见，全程复用同一实例：每篇文献打开一个新标签页，下载完成后关闭该标签页再处理下一篇；
- 自动寻找 PDF 入口：优先点击页面上的 PDF 链接/按钮，失败时访问 `citation_pdf_url` 或出版商规范直链；
- **PDF 浏览页直接保存**：Edge / Chrome 对 inline PDF（`Content-Type: application/pdf` 且无附件头，如 APS 的 supplemental PDF）不触发下载事件，而是进入内置 PDF 浏览页——这不是没有下载连接。检测到当前页面是 PDF 浏览页（URL 以 `.pdf` 结尾）时，自动化会用浏览器会话（含 Cookie）直接取回文件字节，校验 `%PDF` 魔数后保存，等效于真人在浏览页上点“保存”；
- **等待与刷新**：每页在“每页等待时间”（默认 5 分钟）内等待下载开始，无响应则自动刷新，最多“最大刷新次数”（默认 3 次）后仍无响应则报错并进入下一篇；
- **人机验证（自动点击）**：检测到 Cloudflare 人机验证 / 反爬拦截页时进入自动验证循环——每“验证点击间隔”（默认 5 秒）对验证控件模拟点击一次（覆盖 Cloudflare Turnstile / reCAPTCHA / hCaptcha 复选框及页面级“确认您是真人”按钮；复选框位于组件内部闭包 shadow DOM，程序会按其在组件内的固定坐标点击，点击优先级为 iframe 内部元素 → 父页面 iframe 元素坐标 → 页面级按钮）。注意：模拟点击不会显示鼠标移动，浏览器窗口里看不到光标动作属正常现象，实际进度以下载列表中的状态文字（“第 x/N 次尝试”）为准。连续“验证失败几次后刷新”（默认 5 次）仍未通过则刷新页面等待重新验证；**这些时间都算在“每页等待时间”内**，窗口耗尽按无响应逻辑消耗刷新次数；验证通过后自动继续下载，不消耗刷新次数；界面横幅可随时点“刷新验证页”或“跳过此篇”；
- **登录身份验证（人工处理）**：检测到登录页时页面保持打开，等待你在浏览器窗口中完成登录后自动继续（也可手动点击下载）；登录态保存在本地浏览器配置中，之后下载可自动通过；
- **反检测**：启动时注入反检测脚本（隐藏 `navigator.webdriver` 等自动化特征、补齐 `window.chrome` / plugins / languages / permissions），并移除 Playwright 默认的 `--enable-automation` 参数，降低被人机验证系统识别为自动化浏览器的概率（建议配合 Chrome / Edge 使用，反检测对 Chromium 系效果最好）；
- 验证状态判定采用“连续两次干净检测”确认通过，避免页面跳转瞬间误判导致验证被中途打断；
- **验证成功不误刷新**：Turnstile / reCAPTCHA 验证成功后其组件 iframe 仍会留在页面上，程序通过验证 token（隐藏输入框取值）判定“已通过”，不会把已通过的验证误判为仍在验证而刷新页面导致重新验证；验证通过后也不会再重复导航打断已开始的下载；
- **弹出的子窗口（验证 / 下载入口）自动跟随**：出版商把流程放进子窗口时，程序会自动把新窗口置前（不会被主窗口遮挡），并自动切换到最新子窗口上进行检测与点击；请在子窗口内完成验证，避免点击子窗口以外区域（部分网站的子窗口失焦会自动关闭）。
- **下载检测与落盘**：检测到 PDF 进入浏览器下载队列后等待下载完成，按命名规则移动/重命名到目标目录（原下载文件随即清除），自动生成信息文件，并把确认的访问权限按来源写入权限记录文件（Sci-Hub 下载记 `scihub: available`，ResearchGate 下载记 `researchgate: available`，出版商下载记 `official: granted`）；
- **任务间隔**：相邻下载任务之间默认间隔 5 秒（可调），避免请求过密被网站判定为恶意行为；
- **浏览器选择**：界面可选 自动 / Chrome / Edge / Firefox / Safari。Chrome / Edge / 自动 使用 Playwright 的 Chromium 通道；Firefox / Safari（WebKit 引擎）使用对应引擎，未安装时先执行 `python -m playwright install firefox` 或 `python -m playwright install webkit`；
- Cookie 与登录态按浏览器族分别保存在本地浏览器配置目录中（Chromium 族共用一个目录，Firefox / WebKit 各自独立），机构登录一次后后续下载可自动通过。

启用浏览器自动化前需安装（未安装时下载会明确提示安装方法）：

```bash
pip install playwright && python -m playwright install chromium
# 如需在界面中选择 Firefox / Safari（WebKit），再执行：
# python -m playwright install firefox
# python -m playwright install webkit
```

> 说明：默认每篇文献按（隐藏的）Sci-Hub → ResearchGate → 官方页面顺序尝试下载，前两者都无法提供 PDF 时才回退到出版商官方页面——官方页面流程模拟正常的人工下载，不会绕过付费墙或验证机制。启动 worker 时设置 `SCIHUB_ENABLED=0` / `RESEARCHGATE_ENABLED=0` 可跳过对应下载源。

### 项目结构

```
paper_dl/
├── __main__.py      # python -m paper_dl 入口（提示改用 Web 界面）
├── resolvers.py     # DOI / arXiv / 标题解析（Crossref）与出版商规范直链
├── journal.py       # 期刊网址/ISSN 解析、Crossref 期刊检索与文献拉取（游标分页）
├── downloader.py    # 文件命名规则与信息文件生成
├── browserdl.py     # 浏览器自动化下载 worker（Playwright，stdin/stdout JSON 协议）
└── webcli.py        # JSON 接口（供 Web 服务调用）
server/
├── index.js         # Node Web 服务（零依赖，npm start 启动；期刊库 API / 清单拆分与批量导入）
└── cache/           # 期刊文献扫描缓存（按 ISSN 逐页追加，运行时生成）
web/
├── index.html       # 交互页面（文献检索 + 期刊库 + 扫盘下载）
├── app.js
├── i18n.js          # 界面多语言（中文 / English）
└── style.css
journal-library.json # 期刊库（默认 21 本已验证期刊；界面中可增删改并批量导入检索栏）
```

### License

[MIT](LICENSE)
