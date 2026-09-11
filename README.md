# journal-paper-downloader

期刊文献下载工具：通过 **DOI / arXiv ID / 论文标题**，从合法的开放获取（Open Access）渠道下载论文 PDF。

提供两种用法：**Web 交互界面**（`npm start`）和**命令行**（`python -m paper_dl`）。

## 数据来源

| 渠道 | 用途 |
|---|---|
| [Unpaywall](https://unpaywall.org/) | 根据 DOI 查找合法的 OA 全文 PDF |
| [arXiv](https://arxiv.org/) | 预印本 PDF 直链 |
| [Crossref](https://www.crossref.org/) | 按标题检索论文元数据 |

> 注意：本工具只下载开放获取的文献。付费墙（paywall）论文会提示通过出版商页面获取，不会绕过付费墙。

## 安装

```bash
pip install -r requirements.txt          # 核心依赖（requests）
python -m playwright install chromium    # 可选：浏览器自动化内置浏览器（已有 Chrome/Edge 可跳过）
```

Web 界面由 Node.js 提供（无第三方依赖），无需 `npm install`。

## Web 交互界面（推荐）

```bash
npm start
```

启动后终端会打印访问链接（默认 `http://localhost:3210`，端口被占用时可用 `PORT=xxxx npm start` 更换），并尝试自动打开浏览器。界面包含两个模块：**1. 文献检索**

- 期刊网址栏支持**多个期刊**：点“＋ 增加期刊网址”添加输入行；单行内粘贴多个网址（空格 / 逗号 / 换行分隔）后点“⇱ 分离多网址行”可自动拆分成多行；点“检索期刊”统一解析（自动识别 ISSN，支持 Wiley / Nature 等出版商主页）。
- 目录为**三级懒加载**，尽量减小页面负担：
  1. **期刊级**：只显示期刊名与 已选/总文献 数量，不加载具体文献；
  2. 点击期刊名 → 自动逐页检索该期刊文献直到**卷目录完整**（带进度显示："卷目录检索中：已扫描 x / 约 y 篇"，再次点击期刊名可收起并暂停），随后显示全部卷及每卷 已选/总文献 数量（同时收起其他期刊）；文献元数据在服务端按 ISSN 逐页缓存（`server/cache/`），下次打开直接复用；
  3. 点击卷名 → 才列出该卷**文献名称**（同时收起其他卷的文献列表），点击文章标题在右侧查看标题、日期、作者、DOI 等详情。
- 勾选支持级联：勾选期刊/卷节点即选中其下全部文献（整卷勾选无需先加载文献）；整卷勾选后仍可单独取消某篇。
- 点击“生成下载清单”时，若期刊此前未完整检索，会先对每本期刊自动补全检索（带进度显示："清单准备中：《期刊》文献检索 x / 约 y 篇…"），再由服务端按选择集展开为完整文献信息并缓存到本地 `download-manifest.json`。

**2. 扫盘与下载**

- 设置本地目录（如 `/mnt/d/paper`），点击“扫描本地目录”检查清单中每篇文献的 PDF 是否已存在（**仅判断 PDF，不看信息文件**）；
- 点击“下载缺失文件”依次下载缺失文献，保存结构为 `本地目录/期刊名/出版卷/文章名/`；下载过程中可点“停止下载”中断（当前条目的半成品文件会被自动删除），再点“继续下载”从被中断的条目重新下载并继续队列；
- PDF 以 DOI 尾缀命名（如 DOI `10.1029/2025JC023188` → `2025JC023188.pdf`），同时生成同名 `.txt` 信息文件（标题、日期、作者、DOI 等，可取消勾选），每次下载后重新生成；
- **下载方式排序**：界面中可按 ↑↓ 手动调整各下载策略的尝试顺序（保存在浏览器中，下次打开仍生效），下载时从上到下依次尝试，一种方式失败自动换下一种。

### 下载策略

| 策略 | 说明 |
|---|---|
| 浏览器自动化（默认首选） | 用 Playwright 驱动本机真实浏览器（优先 Chrome / Edge）打开出版商页面，自动寻找并点击 PDF 下载入口，可应对 Cloudflare 等反爬保护 |
| Unpaywall OA 直链 | 开放获取存档的 PDF 直链 |
| OpenAlex 开放副本 | 机构库 / 预印本等开放副本 |
| 出版商直链 | 出版商规范 PDF 链接（`requests` 直接下载，常被反爬拦截） |

### 浏览器自动化细节

- 浏览器窗口保持可见，全程复用同一实例：每篇文献打开一个新标签页，下载完成后关闭该标签页再处理下一篇；
- 自动寻找 PDF 入口：优先点击页面上的 PDF 链接/按钮，失败时访问 `citation_pdf_url` 或出版商规范直链；
- **等待与刷新**：每页在“每页等待时间”（默认 5 分钟）内等待下载开始，无响应则自动刷新，最多“最大刷新次数”（默认 3 次）后仍无响应则报错并进入下一篇；
- **登录/人机验证**：检测到登录页、Cloudflare 人机验证或反爬拦截页时，页面保持打开等待人工在浏览器窗口中处理（登录后自动继续，也可手动点击下载）；界面会弹出提示横幅，可点“跳过此篇”；
- **下载检测与落盘**：检测到 PDF 进入浏览器下载队列后等待下载完成，按命名规则移动/重命名到目标目录（原下载文件随即清除），再按设置生成信息文件；
- **任务间隔**：相邻下载任务之间默认间隔 5 秒（可调），避免请求过密被网站判定为恶意行为；
- Cookie 与登录态保存在本地浏览器配置目录中，机构登录一次后后续下载可自动通过。

启用浏览器自动化前需安装（未安装时该策略会明确提示并自动跳到下一种方式）：

```bash
pip install playwright && python -m playwright install chromium
```

> 注意：本工具只下载开放获取的文献，或你在浏览器中有权限访问的文献。浏览器自动化只在出版商页面上模拟正常的人工下载操作，不会绕过付费墙或验证机制。

## 命令行用法

```bash
# 通过 DOI 下载
python -m paper_dl doi 10.1038/nature12373

# 通过 arXiv ID 下载预印本
python -m paper_dl arxiv 2401.00001

# 通过标题检索（会列出候选，选择序号下载）
python -m paper_dl title attention is all you need

# 常用选项
python -m paper_dl -o ~/papers --email you@example.com doi 10.7554/eLife.09560
python -m paper_dl --overwrite --yes title "a precise title"   # 直接下载第一个候选
```

下载的文件按 `第一作者_年份_标题.pdf` 命名，保存到 `papers/` 目录（可用 `-o` 修改）。

## 命令参数

```
python -m paper_dl [-h] [-o OUTPUT] [--overwrite] [--email EMAIL] [-y] {doi,arxiv,title} ...

可选参数:
  -o, --output    保存目录（默认: papers）
  --overwrite     覆盖已存在的文件
  --email         提供给 Unpaywall 的邮箱（建议改为自己的邮箱，默认 paper-dl@localhost）
  -y, --yes       标题检索时直接下载第一个候选
```

## 项目结构

```
paper_dl/
├── __main__.py      # python -m paper_dl 入口
├── cli.py           # 命令行解析与交互
├── resolvers.py     # DOI / arXiv / 标题解析（Unpaywall、Crossref）
├── journal.py       # 期刊网址解析（ISSN）与文献拉取（Crossref 游标分页）
├── downloader.py    # PDF 下载、文件命名与信息文件生成
└── webcli.py        # JSON 接口（供 Web 服务调用）
server/
├── index.js         # Node Web 服务（零依赖，npm start 启动）
└── cache/           # 期刊文献扫描缓存（按 ISSN 逐页追加，运行时生成）
web/
├── index.html       # 交互页面（文献检索 + 扫盘下载）
├── app.js
└── style.css
```

## License

[MIT](LICENSE)
