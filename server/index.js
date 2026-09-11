"use strict";

/**
 * journal-paper-downloader Web 服务（零依赖，仅用 Node 内置模块）。
 *
 * - 提供 web/ 目录下的交互页面
 * - 通过子进程调用 paper_dl.webcli（JSON 接口）完成期刊解析 / 文献拉取 / 下载
 * - 期刊文献按 ISSN 逐页缓存到 server/cache/<issn>.jsonl，卷汇总与卷内文献都从缓存读取，
 *   页面只按层级请求需要的数据，减轻浏览器负担
 * - 下载清单缓存在本地文件 download-manifest.json
 *
 * 启动: npm start，然后浏览器打开 http://localhost:3210
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const { execFile, spawn } = require("child_process");

const PORT = Number(process.env.PORT) || 3210;
const ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(ROOT, "web");
const MANIFEST_PATH = path.join(ROOT, "download-manifest.json");
const CACHE_DIR = path.join(__dirname, "cache");

// ---------------------------------------------------------------------------
// 与 Python downloader.sanitize_component / doi_file_stem 保持一致的清理逻辑
// ---------------------------------------------------------------------------

function sanitizeComponent(text, maxLen = 100) {
  let t = String(text || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ");
  t = t.replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  t = t.slice(0, maxLen).trim().replace(/\.+$/, "");
  return t || "untitled";
}

function doiFileStem(doi) {
  const parts = String(doi).trim().replace(/\/+$/, "").split("/");
  return sanitizeComponent(parts[parts.length - 1] || "untitled");
}

function volumeDirName(item) {
  if (item.volume) return `Volume ${item.volume}`;
  if (item.issue) return `Issue ${item.issue}`;
  return "未分卷";
}

/** 清单条目 -> 相对目录 "期刊名/出版卷/文章名"。 */
function entryRelPath(item) {
  return [
    sanitizeComponent(item.journal || "未知期刊"),
    sanitizeComponent(volumeDirName(item)),
    sanitizeComponent(item.title || item.doi),
  ].join("/");
}

function entryPaths(root, item) {
  const rel = entryRelPath(item);
  const stem = doiFileStem(item.doi || "");
  const dir = path.join(root, ...rel.split("/"));
  return { rel, stem, dir, pdf: path.join(dir, stem + ".pdf"), txt: path.join(dir, stem + ".txt") };
}

// ---------------------------------------------------------------------------
// 卷分组 key（前后端保持一致）
// ---------------------------------------------------------------------------

function volumeKeyOf(work) {
  if (work.volume) return "v:" + work.volume;
  if (work.issue) return "i:" + work.issue;
  return "none";
}

function volumeLabelOf(key) {
  if (key.startsWith("v:")) return "Volume " + key.slice(2);
  if (key.startsWith("i:")) return "Issue " + key.slice(2);
  return "未分卷";
}

// ---------------------------------------------------------------------------
// Python 子进程封装
// ---------------------------------------------------------------------------

const PYTHON_CANDIDATES = ["python3", "python"];

function findPython() {
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= PYTHON_CANDIDATES.length) return resolve(null);
      const cmd = PYTHON_CANDIDATES[i++];
      execFile(cmd, ["-c", "import paper_dl.webcli"], { cwd: ROOT }, (err) => {
        if (err) tryNext();
        else resolve(cmd);
      });
    };
    tryNext();
  });
}

let pythonCmd = null;

/** 调用 python -m paper_dl.webcli <args>，返回解析后的 JSON。 */
/** 当前正在执行的下载任务（供停止功能终止进程并清理半成品文件）。 */
let activeFetch = null; // {child, pdfPath, txtPath}

function runWebCli(args, timeoutMs = 180000, track = null) {
  return new Promise((resolve, reject) => {
    if (!pythonCmd) return reject(new Error("Python 环境不可用"));
    const child = execFile(
      pythonCmd,
      ["-m", "paper_dl.webcli", ...args],
      { cwd: ROOT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (activeFetch && activeFetch.child === child) activeFetch = null;
        const line = (stdout || "").trim().split("\n").pop() || "";
        let data = null;
        try {
          data = JSON.parse(line);
        } catch {
          // 保留 null，走下方错误分支
        }
        if (data) return resolve(data);
        const detail = err ? (err.killed ? "下载已停止或子进程超时" : err.message) : "";
        reject(new Error(`webcli 调用失败: ${detail} ${stderr || ""}`.trim()));
      }
    );
    if (track) {
      activeFetch = { child, pdfPath: track.pdfPath, txtPath: track.txtPath };
    }
  });
}

/** 停止当前下载：杀掉下载子进程，并删除停止前产生的半成品 PDF / 信息文件。 */
function stopActiveFetch() {
  if (!activeFetch) return false;
  activeFetch.stopped = true;
  try {
    activeFetch.child.kill("SIGKILL");
  } catch {
    /* 进程可能已退出 */
  }
  for (const p of [activeFetch.pdfPath, activeFetch.txtPath]) {
    try {
      if (p) fs.rmSync(p, { force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 浏览器自动化 worker（python -m paper_dl.browserdl，stdin/stdout JSON 行协议）
// ---------------------------------------------------------------------------

let bw = null; // {child, buf, pending, nextId, status, stderrTail, exited, ready}

function friendlyBrowserError(msg) {
  const text = String(msg || "");
  if (/PLAYWRIGHT_MISSING/.test(text)) {
    return "浏览器自动化模块需要先安装 Playwright：pip install playwright && python -m playwright install chromium（本机已装 Chrome/Edge 会自动优先使用）";
  }
  return text;
}

function lastLineOf(text) {
  const lines = String(text || "").trim().split("\n");
  return lines[lines.length - 1] || "";
}

function killBrowserWorker() {
  if (!bw || !bw.child) return;
  try {
    bw.child.kill("SIGKILL");
  } catch {
    /* 忽略 */
  }
}

function startBrowserWorker() {
  if (!pythonCmd) return Promise.reject(new Error("Python 环境不可用"));
  const w = {
    child: null,
    buf: "",
    pending: new Map(),
    nextId: 1,
    status: null,
    stderrTail: "",
    exited: false,
    ready: false,
    settled: false,
  };
  bw = w;
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCmd, ["-m", "paper_dl.browserdl"], { cwd: ROOT });
    w.child = child;
    const fail = (msg) => {
      if (w.settled) return;
      w.settled = true;
      reject(new Error(msg));
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      w.buf += chunk;
      let idx;
      while ((idx = w.buf.indexOf("\n")) >= 0) {
        const line = w.buf.slice(0, idx).trim();
        w.buf = w.buf.slice(idx + 1);
        if (!line) continue;
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "ready") {
          w.ready = true;
          if (!w.settled) {
            w.settled = true;
            resolve(w);
          }
        } else if (msg.type === "fatal") {
          fail(friendlyBrowserError(msg.error));
          killBrowserWorker();
        } else if (msg.type === "status") {
          w.status = msg;
        } else if (msg.id !== undefined && w.pending.has(msg.id)) {
          const pending = w.pending.get(msg.id);
          w.pending.delete(msg.id);
          pending.resolve(msg);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      w.stderrTail = (w.stderrTail + c).slice(-4000);
    });
    child.on("exit", (code) => {
      w.exited = true;
      const detail = w.stderrTail ? `：${lastLineOf(w.stderrTail)}` : "";
      for (const [, pending] of w.pending) {
        pending.reject(new Error(`浏览器自动化进程已退出 (code ${code})${detail}`));
      }
      w.pending.clear();
      if (bw === w) bw = null;
      fail(`浏览器自动化进程异常退出 (code ${code})${detail}`);
    });
    child.on("error", (err) => fail("无法启动浏览器自动化进程: " + err.message));
  });
}

/** 确保浏览器 worker 已就绪（惰性启动，首个浏览器下载任务时拉起）。 */
function ensureBrowserWorker() {
  if (bw && bw.ready && !bw.exited) return Promise.resolve(bw);
  return startBrowserWorker();
}

/** 向浏览器 worker 发送一条请求（fetch 不设超时：人工干预可能耗时很久）。 */
function bwRequest(payload) {
  return ensureBrowserWorker().then(
    (w) =>
      new Promise((resolve, reject) => {
        const id = w.nextId++;
        w.pending.set(id, { resolve, reject });
        try {
          w.child.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
        } catch (err) {
          w.pending.delete(id);
          reject(new Error("浏览器自动化进程不可用: " + err.message));
        }
      })
  );
}

/** 向浏览器 worker 发送控制指令（stop/skip），失败不抛错。 */
function bwControl(op) {
  if (!bw || bw.exited || !bw.ready) return false;
  const id = bw.nextId++;
  try {
    bw.child.stdin.write(JSON.stringify({ id, op }) + "\n");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 期刊文献缓存（按 ISSN 逐页追加到 server/cache/<issn>.jsonl）
// ---------------------------------------------------------------------------

function cacheFiles(issn) {
  const safe = issn.replace(/[^\dxX-]/g, "");
  return {
    data: path.join(CACHE_DIR, safe + ".jsonl"),
    meta: path.join(CACHE_DIR, safe + ".json"),
  };
}

function readCache(issn) {
  const files = cacheFiles(issn);
  let meta = { cursor: "*", done: false, loaded: 0, total: 0 };
  try {
    meta = JSON.parse(fs.readFileSync(files.meta, "utf8"));
  } catch {
    /* 无缓存 */
  }
  const works = [];
  const seen = new Set();
  try {
    for (const line of fs.readFileSync(files.data, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const w = JSON.parse(line);
        if (w.doi && !seen.has(w.doi)) {
          seen.add(w.doi);
          works.push(w);
        }
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    /* 无数据文件 */
  }
  return { works, meta };
}

/** 拉取下一页文献并追加进缓存；返回 {fetched, done, loaded, total}。同一 ISSN 串行执行。 */
const scanLocks = new Map();

function scanStep(issn, rows = 1000) {
  const prev = scanLocks.get(issn) || Promise.resolve(null);
  const next = prev.then(async () => {
    const { meta } = readCache(issn);
    if (meta.done) return { fetched: 0, ...meta };
    const r = await runWebCli(
      ["works", "--issn", issn, "--cursor", meta.cursor, "--rows", String(rows)],
      120000
    );
    if (!r.ok) throw new Error(r.error || "文献拉取失败");
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const files = cacheFiles(issn);
    if (r.works.length) {
      fs.appendFileSync(files.data, r.works.map((w) => JSON.stringify(w)).join("\n") + "\n");
    }
    const newMeta = {
      cursor: r.next_cursor || meta.cursor,
      done: !!r.done,
      loaded: meta.loaded + r.works.length,
      total: r.total || meta.total,
    };
    fs.writeFileSync(files.meta, JSON.stringify(newMeta), "utf8");
    return { fetched: r.works.length, ...newMeta };
  });
  scanLocks.set(issn, next.catch(() => {}));
  return next;
}

/** 持续拉取直到整本期刊扫描完成（用于整卷勾选时展开清单）。 */
async function ensureFullScan(issn, maxPages = 300) {
  for (let i = 0; i < maxPages; i++) {
    const r = await scanStep(issn);
    if (r.done) return r;
    if (r.fetched === 0) return r;
  }
  return readCache(issn).meta;
}

// ---------------------------------------------------------------------------
// 请求辅助
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求体不是合法的 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not Found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(content);
  });
}

// ---------------------------------------------------------------------------
// 清单读写
// ---------------------------------------------------------------------------

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return { journals: [], items: [], updatedAt: null };
  }
}

function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// API 路由
// ---------------------------------------------------------------------------

async function handleApi(req, res, pathname, body) {
  if (pathname === "/api/journal") {
    const url = String(body.url || "").trim();
    if (!url) return sendJson(res, 400, { error: "期刊网址不能为空" });
    const result = await runWebCli(["journal", url]);
    return sendJson(res, result.ok ? 200 : 502, result);
  }

  // 期刊的卷汇总（不含具体文献）。more=true 时先向后拉取一页再汇总。
  if (pathname === "/api/volumes") {
    const issn = String(body.issn || "").trim();
    if (!issn) return sendJson(res, 400, { error: "缺少 ISSN" });
    const hadCache = readCache(issn).meta.loaded > 0;
    if (!hadCache || body.more) await scanStep(issn);
    const { works, meta } = readCache(issn);
    const groups = new Map();
    for (const w of works) {
      const key = volumeKeyOf(w);
      const g = groups.get(key) || { key, label: volumeLabelOf(key), count: 0, latest: "" };
      g.count += 1;
      if ((w.date || "") > g.latest) g.latest = w.date || "";
      groups.set(key, g);
    }
    const volumes = [...groups.values()].sort((a, b) => b.latest.localeCompare(a.latest));
    return sendJson(res, 200, {
      ok: true,
      volumes,
      scan: { loaded: meta.loaded, total: meta.total, done: meta.done },
    });
  }

  // 某一卷的具体文献列表（只在该卷被点开时调用）
  if (pathname === "/api/volume-works") {
    const issn = String(body.issn || "").trim();
    const volumeKey = String(body.volumeKey || "");
    if (!issn || !volumeKey) return sendJson(res, 400, { error: "缺少 issn 或 volumeKey" });
    const { works, meta } = readCache(issn);
    const list = works
      .filter((w) => volumeKeyOf(w) === volumeKey)
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    return sendJson(res, 200, { ok: true, works: list, scanDone: meta.done });
  }

  if (pathname === "/api/manifest") {
    return sendJson(res, 200, { ok: true, manifest: readManifest() });
  }

  // 生成下载清单：按选择集（整卷 / 单篇）从缓存展开为完整文献信息，
  // 整卷选择会先确保该期刊扫描完成，再依次汇总。
  if (pathname === "/api/manifest/save") {
    const selections = Array.isArray(body.selections) ? body.selections : [];
    const items = [];
    const seen = new Set();
    const journalNames = [];
    for (const sel of selections) {
      const issn = String(sel.issn || "").trim();
      const journalTitle = sel.journal || issn;
      if (!issn) continue;
      journalNames.push(journalTitle);
      const wholeVolumes = Array.isArray(sel.volumes) ? sel.volumes : [];
      const dois = Array.isArray(sel.dois) ? sel.dois : [];
      if (wholeVolumes.length) await ensureFullScan(issn);
      const { works } = readCache(issn);
      const byDoi = new Map(works.map((w) => [w.doi, w]));
      const volSet = new Set(wholeVolumes);
      for (const w of works) {
        if (!volSet.has(volumeKeyOf(w))) continue;
        if (seen.has(w.doi)) continue;
        seen.add(w.doi);
        items.push({ ...w, journal: journalTitle });
      }
      for (const doi of dois) {
        if (seen.has(doi)) continue;
        const w = byDoi.get(doi);
        if (w) {
          seen.add(doi);
          items.push({ ...w, journal: journalTitle });
        }
      }
    }
    const manifest = {
      journals: journalNames,
      items,
      updatedAt: new Date().toISOString(),
    };
    writeManifest(manifest);
    return sendJson(res, 200, { ok: true, count: items.length });
  }

  if (pathname === "/api/scan") {
    const root = String(body.root || "").trim();
    if (!root) return sendJson(res, 400, { error: "本地目录不能为空" });
    const manifest = readManifest();
    const entries = (manifest.items || []).map((item, i) => {
      const p = entryPaths(root, item);
      // 判定规则：pdf 不存在即视为未下载（信息文件状态一并报告）
      return {
        index: i,
        doi: item.doi,
        title: item.title,
        rel: p.rel,
        stem: p.stem,
        pdfPath: p.pdf,
        txtPath: p.txt,
        pdfExists: fs.existsSync(p.pdf),
        txtExists: fs.existsSync(p.txt),
      };
    });
    const missing = entries.filter((e) => !e.pdfExists).length;
    return sendJson(res, 200, {
      ok: true,
      root,
      total: entries.length,
      missing,
      exists: entries.length - missing,
      entries,
    });
  }

  const DEFAULT_STRATEGIES = ["browser", "unpaywall", "openalex", "publisher"];
  const STRATEGY_NAMES = {
    browser: "浏览器自动化",
    unpaywall: "Unpaywall",
    openalex: "OpenAlex",
    publisher: "出版商直链",
  };
  const clampNum = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
  };

  if (pathname === "/api/fetch") {
    const root = String(body.root || "").trim();
    const item = body.item || {};
    if (!root || !item.doi) return sendJson(res, 400, { error: "缺少 root 或 doi" });
    const p = entryPaths(root, item);
    const meta = JSON.stringify({
      journal: item.journal || "",
      volume: item.volume || "",
      issue: item.issue || "",
      date: item.date || "",
      authors: item.authors || [],
    });
    const email = String(body.email || "paper-dl@localhost");
    const strategies =
      Array.isArray(body.strategies) && body.strategies.length
        ? body.strategies.map(String).filter((s) => DEFAULT_STRATEGIES.includes(s))
        : DEFAULT_STRATEGIES;
    if (!strategies.length) return sendJson(res, 400, { error: "下载策略列表为空" });
    const waitMinutes = clampNum(body.waitMinutes, 1, 120, 5);
    const maxRefresh = clampNum(body.maxRefresh, 0, 20, 3);
    const genInfo = body.genInfo !== false;

    // 按用户排序的策略依次尝试：browser 走浏览器自动化 worker，其余走 webcli 子进程
    const attempts = [];
    let result = null;
    let paper = null;
    for (const st of strategies) {
      if (st === "browser") {
        try {
          const r = await bwRequest({
            op: "fetch",
            doi: String(item.doi),
            root,
            rel: p.rel,
            stem: p.stem,
            meta: {
              journal: item.journal || "",
              volume: item.volume || "",
              issue: item.issue || "",
              date: item.date || "",
              authors: item.authors || [],
            },
            email,
            wait_minutes: waitMinutes,
            max_refresh: maxRefresh,
            human_wait_min: 0,
            generate_info: genInfo,
            overwrite: false,
          });
          paper = r.paper || paper;
          if (r.ok) {
            result = { ...r, strategy: "browser" };
            break;
          }
          attempts.push({ strategy: "browser", error: friendlyBrowserError(r.error) });
          if (r.skipped) break; // 人工跳过：该篇不再尝试其他策略
        } catch (err) {
          attempts.push({ strategy: "browser", error: friendlyBrowserError(err.message) });
        }
      } else {
        const args = [
          "fetch",
          "--doi", String(item.doi),
          "--root", root,
          "--rel", p.rel,
          "--meta", meta,
          "--email", email,
          "--strategies", st,
        ];
        if (!genInfo) args.push("--no-info");
        try {
          // 登记为活动下载任务，支持“停止”操作
          const r = await runWebCli(args, 180000, { pdfPath: p.pdf, txtPath: p.txt });
          paper = r.paper || paper;
          if (r.ok) {
            result = { ...r, strategy: st };
            break;
          }
          attempts.push({ strategy: st, error: r.error || "下载失败" });
        } catch (err) {
          attempts.push({ strategy: st, error: err.message });
        }
      }
    }
    if (result) {
      return sendJson(res, 200, {
        ok: true,
        path: result.path,
        info_path: result.info_path,
        strategy: result.strategy,
        paper: result.paper || paper,
        attempts,
      });
    }
    return sendJson(res, 502, {
      ok: false,
      error:
        attempts.map((a) => `[${STRATEGY_NAMES[a.strategy] || a.strategy}] ${a.error}`).join("；") ||
        "所有下载策略均失败",
      attempts,
      paper,
    });
  }

  // 浏览器自动化实时状态（供前端轮询展示等待/刷新/人工干预进度）
  if (pathname === "/api/fetch-status") {
    return sendJson(res, 200, { ok: true, status: bw && bw.ready ? bw.status : null });
  }

  // 人工干预：跳过当前浏览器自动化任务
  if (pathname === "/api/fetch-skip") {
    const sent = bwControl("skip");
    return sendJson(res, 200, { ok: sent, skipped: sent, error: sent ? undefined : "当前没有浏览器自动化任务" });
  }

  // 停止当前下载：终止下载进程（浏览器任务则发送中止指令）并删除半成品文件
  if (pathname === "/api/fetch-stop") {
    const stopped = stopActiveFetch();
    const stoppedBrowser = bwControl("stop");
    return sendJson(res, 200, { ok: true, stopped: stopped || stoppedBrowser });
  }

  if (pathname === "/api/open-dir") {
    const dir = String(body.dir || "").trim();
    if (!dir) return sendJson(res, 400, { error: "目录不能为空" });
    const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
    const opener =
      process.platform === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", abs] }
        : process.platform === "darwin"
          ? { cmd: "open", args: [abs] }
          : { cmd: "xdg-open", args: [abs] };
    try {
      execFile(opener.cmd, opener.args, { cwd: ROOT }, () => {});
    } catch {
      // 打不开就只返回路径，前端照常展示
    }
    return sendJson(res, 200, { ok: true, path: abs });
  }

  return sendJson(res, 404, { error: "接口不存在" });
}

// ---------------------------------------------------------------------------
// 服务启动
// ---------------------------------------------------------------------------

async function main() {
  // 服务退出时关闭浏览器自动化进程（连带关闭自动化浏览器窗口）
  process.on("exit", killBrowserWorker);
  process.on("SIGINT", () => {
    killBrowserWorker();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    killBrowserWorker();
    process.exit(0);
  });

  pythonCmd = await findPython();
  if (!pythonCmd) {
    console.error("✗ 未找到可用的 Python 环境（需要 python3 且已安装 requests）。");
    console.error("  请先执行: pip install -r requirements.txt");
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    try {
      if (url.pathname === "/api/manifest" && req.method === "GET") {
        return await handleApi(req, res, url.pathname, {});
      }
      if (url.pathname === "/api/fetch-status" && req.method === "GET") {
        return await handleApi(req, res, url.pathname, {});
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        const body = await readBody(req);
        await handleApi(req, res, url.pathname, body);
      } else if (req.method === "GET") {
        serveStatic(req, res, url.pathname);
      } else {
        sendJson(res, 405, { error: "Method Not Allowed" });
      }
    } catch (e) {
      sendJson(res, 500, { error: e.message || "服务器内部错误" });
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`✗ 端口 ${PORT} 已被占用，可通过 PORT=xxxx npm start 更换端口。`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log("");
    console.log("  journal-paper-downloader");
    console.log("");
    console.log(`  ➜  本地访问:  ${url}`);
    console.log(`  ➜  网络访问:  http://<本机IP>:${PORT}`);
    console.log("");
    console.log("  按 Ctrl+C 停止服务");
    console.log("");

    // 尝试自动打开浏览器，失败则忽略（用户可手动点击上方链接）
    const opener =
      process.platform === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", url] }
        : process.platform === "darwin"
          ? { cmd: "open", args: [url] }
          : { cmd: "xdg-open", args: [url] };
    try {
      execFile(opener.cmd, opener.args, () => {});
    } catch {
      /* 忽略 */
    }
  });
}

main();
