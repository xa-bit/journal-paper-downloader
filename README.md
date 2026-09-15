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
| Publisher pages | Open the article page via browser automation and trigger the PDF download |

> Note: this tool only simulates a normal manual download on publisher pages; it never bypasses paywalls or any verification mechanism.

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

On startup the terminal prints the access URL (default `http://localhost:3210`; if the port is taken, use `PORT=xxxx npm start`) and tries to open your browser automatically.

**UI language** — the selector in the header switches the interface between 中文 and English on the fly. Your choice is stored in the browser (localStorage); by default it follows your browser language and falls back to Chinese when unrecognized.

The UI has two modules.

**1. Literature search**

- The journal URL field supports **multiple journals**: click "＋ 增加期刊网址" to add an input row; paste several URLs into one row (separated by spaces / commas / newlines) and click "⇱ 分离多网址行" to split them into rows automatically; click "检索期刊" to resolve them all (ISSN is auto-detected; publisher home pages such as Wiley / Nature are supported).
- The tree is **lazy-loaded in three levels** to keep the page light:
  1. **Journal level**: only the journal name and the selected/total paper count are shown; no papers are loaded yet;
  2. Click a journal name → its papers are searched page by page until the **volume list is complete** (progress shown: "卷目录检索中：已扫描 x / 约 y 篇"; click the name again to collapse and pause), after which all volumes are listed with each volume's selected/total count (other journals collapse at the same time). Metadata is cached page by page per ISSN on the server (`server/cache/`) and reused on the next visit;
  3. Click a volume name → only then are its **paper titles** listed (other volumes' lists collapse at the same time); clicking a paper title shows the title, date, authors, DOI, etc. in the right panel.
- Checkbox cascading: checking a journal/volume node selects all papers under it (selecting a whole volume doesn't require loading its papers first); after selecting a whole volume you can still uncheck individual papers.
- When you click "生成下载清单", any journal that was not fully searched beforehand is auto-completed first (progress shown: "清单准备中：《期刊》文献检索 x / 约 y 篇…"), then the server expands the selection into full paper records and caches them in the local `download-manifest.json`, which is **automatically set as the current pending manifest**;
- After generating, click "**保存任务清单**": the manifest is saved to the site root as `任务清单-期刊名.json` (name collisions are auto-suffixed `-1`/`-2`), and a copy is also downloaded to your machine via the browser.

**2. Scan & download**

- Set a local directory (e.g. `/mnt/d/paper`) and click "扫描本地目录" to check which PDFs from the manifest already exist (**PDFs only — info files are not considered**);
- Click "下载缺失文件" to download the missing papers one by one; files are stored as `local dir/journal name/volume/paper name/`; during a run you can click "停止下载" to interrupt the current item, then "继续下载" to retry from the interrupted item and continue the queue;
- PDFs are named after the DOI suffix (e.g. DOI `10.1029/2025JC023188` → `2025JC023188.pdf`); a same-name `.txt` info file (title, date, authors, DOI, etc.; can be disabled via checkbox) is (re)generated after each download;
- **Download method**: browser automation only — Playwright drives a real local browser to open the publisher page, pass the human verification, and download the PDF;
- **Browser choice**: you can specify which browser to use (Edge by default / Auto / Chrome / Firefox / Safari; stored in the browser and still effective on the next visit); "Auto" tries local Chrome, then Edge, then the bundled Chromium in order; picking a specific browser launches it directly when downloading (switching browsers rebuilds the browser instance automatically);
- **Settings auto-memory**: the local directory, wait/refresh/verification/task-interval values, the info-file toggle, the browser choice and all other settings are saved automatically; reopening the site restores the settings from the last task run (stored server-side in `server/state.json`, so it also works when opening from a different browser);
- **Refresh**: during a run you can click "⟳ 刷新" — it keeps your current inputs (the saved directory and other settings stay unchanged), resets the download state and re-scans, after which you can click "下载缺失文件" again to download in sequence.

#### Task manifest management

The current pending manifest is shown in the "扫盘与下载" module (entry count and file path). When the site opens it **reuses the manifest from the last task**; after generating a manifest in "文献检索", importing one, or generating a not-downloaded manifest, the current manifest switches automatically and is persisted (`server/state.json`).

- **Import task manifest** (导入任务清单): enter the path of a manifest JSON file (absolute, or relative to the site root) in the input and click "导入任务清单" (or press Enter) to load it and re-scan automatically;
- **Generate not-downloaded manifest** (生成未下载清单): after a scan, save the **not-yet-downloaded entries** of the current manifest as a new manifest (`任务清单-未下载-期刊名.json`, name collisions are auto-suffixed) and switch it to the current pending manifest automatically;
- **Save task manifest** (保存任务清单): save the current pending manifest as `任务清单-期刊名.json` (name collisions are auto-suffixed `-1`/`-2`).

#### Browser automation details

- The browser window stays visible and one instance is reused throughout: each paper opens in a new tab, which is closed before the next one is processed;
- The PDF entry point is found automatically: it first clicks a PDF link/button on the page, falling back to `citation_pdf_url` or the publisher's canonical direct link;
- **Wait & refresh**: each page is given "每页等待时间" (default 5 minutes) for the download to start; if there is no response the page refreshes automatically, and after "最大刷新次数" (default 3) refreshes with no response it reports an error and moves on to the next paper;
- **Human verification (auto-click)**: when a Cloudflare human verification / anti-bot interstitial is detected, an auto-verification loop starts — every "验证点击间隔" (default 5 s) it simulates a click on the verification control (covers Cloudflare Turnstile / reCAPTCHA / hCaptcha checkboxes and page-level "confirm you are human" buttons; the checkbox sits in the component's closed shadow DOM, so the click is placed at its fixed coordinates within the component; click priority: iframe-internal element → parent-page iframe coordinates → page-level button). Note: the simulated click does not move the cursor, so seeing no mouse movement in the browser window is normal — the status text in the download list ("第 x/N 次尝试") reflects the real progress. After "验证失败几次后刷新" (default 5) consecutive failed attempts the page is refreshed to re-verify; **all of this time counts against "每页等待时间"** — when the window is exhausted, the no-response logic consumes a refresh; once verified, the download continues automatically without consuming a refresh; the banner always offers "刷新验证页" or "跳过此篇";
- **Login (manual)**: when a login page is detected, the page stays open until you finish logging in in the browser window, then continues automatically (you can also click the download manually); the login state is kept in the local browser profile, so later downloads pass automatically;
- **Anti-detection**: an anti-detection script is injected at startup (hides automation fingerprints such as `navigator.webdriver`, fills in `window.chrome` / plugins / languages / permissions) and Playwright's default `--enable-automation` argument is removed, lowering the chance of being identified as an automated browser (Chrome / Edge recommended; anti-detection works best on Chromium-based browsers);
- Verification status uses "two consecutive clean checks" to confirm success, avoiding a misjudgement in the instant of a page transition that would interrupt the verification midway;
- **No false refresh after a successful verification**: after Turnstile / reCAPTCHA passes, its component iframe remains on the page; the code reads the verification token (hidden input value) to detect "already passed" and won't treat a passed check as still-verifying and refresh the page into a re-verification; after passing, it also won't re-navigate and interrupt a download that has already started;
- **Popup child windows (verification / download entry) are followed automatically**: when a publisher puts the flow in a child window, the code brings the new window to the front (so it is not hidden behind the main window) and switches to the newest child window for detection and clicking; please complete the verification inside the child window and avoid clicking outside it (on some sites the child window auto-closes on blur).
- **Download detection & landing**: once a PDF enters the browser's download queue, the code waits for the download to complete, then moves/renames it into the target directory per the naming rule (the original download file is removed immediately), and generates the info file per settings;
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

> Note: this tool only downloads papers your browser has access to. Browser automation simulates normal manual downloads on publisher pages and never bypasses paywalls or verification mechanisms.

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
| 出版商页面 | 浏览器自动化打开文章页并触发 PDF 下载 |

> 注意：本工具只在出版商页面上模拟正常的人工下载操作，不会绕过付费墙或验证机制。

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

启动后终端会打印访问链接（默认 `http://localhost:3210`，端口被占用时可用 `PORT=xxxx npm start` 更换），并尝试自动打开浏览器。

**界面语言**——顶部语言选择器可在 中文 / English 之间即时切换界面；选择保存在浏览器（localStorage），默认跟随浏览器语言，无法识别时回退为中文。

界面包含两个模块：**1. 文献检索**

- 期刊网址栏支持**多个期刊**：点“＋ 增加期刊网址”添加输入行；单行内粘贴多个网址（空格 / 逗号 / 换行分隔）后点“⇱ 分离多网址行”可自动拆分成多行；点“检索期刊”统一解析（自动识别 ISSN，支持 Wiley / Nature 等出版商主页）。
- 目录为**三级懒加载**，尽量减小页面负担：
  1. **期刊级**：只显示期刊名与 已选/总文献 数量，不加载具体文献；
  2. 点击期刊名 → 自动逐页检索该期刊文献直到**卷目录完整**（带进度显示：“卷目录检索中：已扫描 x / 约 y 篇”，再次点击期刊名可收起并暂停），随后显示全部卷及每卷 已选/总文献 数量（同时收起其他期刊）；文献元数据在服务端按 ISSN 逐页缓存（`server/cache/`），下次打开直接复用；
  3. 点击卷名 → 才列出该卷**文献名称**（同时收起其他卷的文献列表），点击文章标题在右侧查看标题、日期、作者、DOI 等详情。
- 勾选支持级联：勾选期刊/卷节点即选中其下全部文献（整卷勾选无需先加载文献）；整卷勾选后仍可单独取消某篇。
- 点击“生成下载清单”时，若期刊此前未完整检索，会先对每本期刊自动补全检索（带进度显示：“清单准备中：《期刊》文献检索 x / 约 y 篇…”），再由服务端按选择集展开为完整文献信息并缓存到本地 `download-manifest.json`，并**自动设为当前待执行清单**；
- 生成清单后可点“**保存任务清单**”：按 `任务清单-期刊名.json` 命名保存到网站根目录（重名自动加 `-1`/`-2` 序号防重复），同时通过浏览器下载一份到本机。

**2. 扫盘与下载**

- 设置本地目录（如 `/mnt/d/paper`），点击“扫描本地目录”检查清单中每篇文献的 PDF 是否已存在（**仅判断 PDF，不看信息文件**）；
- 点击“下载缺失文件”依次下载缺失文献，保存结构为 `本地目录/期刊名/出版卷/文章名/`；下载过程中可点“停止下载”中断当前条目，再点“继续下载”从被中断的条目重新下载并继续队列；
- PDF 以 DOI 尾缀命名（如 DOI `10.1029/2025JC023188` → `2025JC023188.pdf`），同时生成同名 `.txt` 信息文件（标题、日期、作者、DOI 等，可取消勾选），每次下载后重新生成；
- **下载方式**：仅浏览器自动化——用 Playwright 驱动本机真实浏览器自动打开出版商页面、通过人机验证并下载 PDF；
- **浏览器选择**：浏览器自动化可按需指定所用浏览器（Edge 默认 / 自动 / Chrome / Firefox / Safari，保存在浏览器中，下次打开仍生效）；“自动”会依次尝试本机 Chrome、Edge、内置 Chromium，选中其他浏览器时下载时直接启动对应浏览器（切换浏览器会自动重建浏览器实例）；
- **设置自动记忆**：本地目录、等待/刷新/验证/任务间隔、生成信息文件、浏览器选择等全部设置会自动保存；下次打开网站自动恢复上次执行任务时的设置（保存在服务端 `server/state.json`，换浏览器打开也生效）；
- **刷新**：下载过程中可点“⟳ 刷新”——保留当前输入（保存目录等设置不变），重置下载状态并重新扫盘，之后可再次点击“下载缺失文件”依次下载。

#### 任务清单管理

当前待执行清单显示在“扫盘与下载”模块中（含条目数与文件路径）。网站打开时自动沿用**上次任务所用清单**；在“文献检索”生成清单、在此导入清单或生成未下载清单后，当前清单自动切换并持久化（`server/state.json`）。

- **导入任务清单**：在输入框填入清单 JSON 文件路径（绝对路径，或相对网站根目录的相对路径），点“导入任务清单”（或回车）载入并自动重新扫盘；
- **生成未下载清单**：扫盘后可点击，按本地目录扫描结果把当前清单里**未下载的条目**另存为新清单（`任务清单-未下载-期刊名.json`，重名自动加序号）并自动切换为当前待执行清单；
- **保存任务清单**：把当前待执行清单保存为 `任务清单-期刊名.json`（重名自动加 `-1`/`-2` 序号防重复）。

#### 浏览器自动化细节

- 浏览器窗口保持可见，全程复用同一实例：每篇文献打开一个新标签页，下载完成后关闭该标签页再处理下一篇；
- 自动寻找 PDF 入口：优先点击页面上的 PDF 链接/按钮，失败时访问 `citation_pdf_url` 或出版商规范直链；
- **等待与刷新**：每页在“每页等待时间”（默认 5 分钟）内等待下载开始，无响应则自动刷新，最多“最大刷新次数”（默认 3 次）后仍无响应则报错并进入下一篇；
- **人机验证（自动点击）**：检测到 Cloudflare 人机验证 / 反爬拦截页时进入自动验证循环——每“验证点击间隔”（默认 5 秒）对验证控件模拟点击一次（覆盖 Cloudflare Turnstile / reCAPTCHA / hCaptcha 复选框及页面级“确认您是真人”按钮；复选框位于组件内部闭包 shadow DOM，程序会按其在组件内的固定坐标点击，点击优先级为 iframe 内部元素 → 父页面 iframe 元素坐标 → 页面级按钮）。注意：模拟点击不会显示鼠标移动，浏览器窗口里看不到光标动作属正常现象，实际进度以下载列表中的状态文字（“第 x/N 次尝试”）为准。连续“验证失败几次后刷新”（默认 5 次）仍未通过则刷新页面等待重新验证；**这些时间都算在“每页等待时间”内**，窗口耗尽按无响应逻辑消耗刷新次数；验证通过后自动继续下载，不消耗刷新次数；界面横幅可随时点“刷新验证页”或“跳过此篇”；
- **登录身份验证（人工处理）**：检测到登录页时页面保持打开，等待你在浏览器窗口中完成登录后自动继续（也可手动点击下载）；登录态保存在本地浏览器配置中，之后下载可自动通过；
- **反检测**：启动时注入反检测脚本（隐藏 `navigator.webdriver` 等自动化特征、补齐 `window.chrome` / plugins / languages / permissions），并移除 Playwright 默认的 `--enable-automation` 参数，降低被人机验证系统识别为自动化浏览器的概率（建议配合 Chrome / Edge 使用，反检测对 Chromium 系效果最好）；
- 验证状态判定采用“连续两次干净检测”确认通过，避免页面跳转瞬间误判导致验证被中途打断；
- **验证成功不误刷新**：Turnstile / reCAPTCHA 验证成功后其组件 iframe 仍会留在页面上，程序通过验证 token（隐藏输入框取值）判定“已通过”，不会把已通过的验证误判为仍在验证而刷新页面导致重新验证；验证通过后也不会再重复导航打断已开始的下载；
- **弹出的子窗口（验证 / 下载入口）自动跟随**：出版商把流程放进子窗口时，程序会自动把新窗口置前（不会被主窗口遮挡），并自动切换到最新子窗口上进行检测与点击；请在子窗口内完成验证，避免点击子窗口以外区域（部分网站的子窗口失焦会自动关闭）。
- **下载检测与落盘**：检测到 PDF 进入浏览器下载队列后等待下载完成，按命名规则移动/重命名到目标目录（原下载文件随即清除），再按设置生成信息文件；
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

> 注意：本工具只下载你在浏览器中有权限访问的文献。浏览器自动化只在出版商页面上模拟正常的人工下载操作，不会绕过付费墙或验证机制。

### 项目结构

```
paper_dl/
├── __main__.py      # python -m paper_dl 入口（提示改用 Web 界面）
├── resolvers.py     # DOI / arXiv / 标题解析（Crossref）与出版商规范直链
├── journal.py       # 期刊网址解析（ISSN）与文献拉取（Crossref 游标分页）
├── downloader.py    # 文件命名规则与信息文件生成
├── browserdl.py     # 浏览器自动化下载 worker（Playwright，stdin/stdout JSON 协议）
└── webcli.py        # JSON 接口（供 Web 服务调用）
server/
├── index.js         # Node Web 服务（零依赖，npm start 启动）
└── cache/           # 期刊文献扫描缓存（按 ISSN 逐页追加，运行时生成）
web/
├── index.html       # 交互页面（文献检索 + 扫盘下载）
├── app.js
├── i18n.js          # 界面多语言（中文 / English）
└── style.css
```

### License

[MIT](LICENSE)
