# journal-paper-downloader

期刊文献下载工具：通过 **DOI / arXiv ID / 论文标题**，从合法的开放获取（Open Access）渠道下载论文 PDF。

## 数据来源

| 渠道 | 用途 |
|---|---|
| [Unpaywall](https://unpaywall.org/) | 根据 DOI 查找合法的 OA 全文 PDF |
| [arXiv](https://arxiv.org/) | 预印本 PDF 直链 |
| [Crossref](https://www.crossref.org/) | 按标题检索论文元数据 |

> 注意：本工具只下载开放获取的文献。付费墙（paywall）论文会提示通过出版商页面获取，不会绕过付费墙。

## 安装

```bash
pip install -r requirements.txt
```

## 使用

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
└── downloader.py    # PDF 下载与文件命名
```

## License

[MIT](LICENSE)
