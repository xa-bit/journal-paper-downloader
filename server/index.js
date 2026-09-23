"use strict";

/**
 * journal-paper-downloader Web 服务（零依赖，仅用 Node 内置模块）。
 *
 * - 提供 web/ 目录下的交互页面
 * - 通过子进程调用 paper_dl.webcli（JSON 接口）完成期刊解析 / 文献拉取 / 下载
 * - 期刊文献按 ISSN 逐页缓存到 server/cache/<issn>.jsonl，卷汇总与卷内文献都从缓存读取，
 *   页面只按层级请求需要的数据，减轻浏览器负担
 * - 期刊库 journal-library.json（站点根目录）：界面可增删改期刊、联网搜索添加、
 *   勾选后批量导入文献检索栏
 * - 下载清单按期刊拆分为 任务清单-<期刊名>.json / 任务清单-未下载-<期刊名>.json
 *   （同名覆盖，不再追加 -1/-2 序号）；支持一份或多份清单批量导入，合并为当前执行清单
 * - 合并后的当前清单镜像缓存到 download-manifest.json
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
  return {
    rel,
    stem,
    dir,
    pdf: path.join(dir, stem + ".pdf"),
    txt: path.join(dir, stem + ".txt"),
    // 权限记录文件（browserdl 写入，双路径权限）：
    // official="granted"/"denied"（官方网页权限），scihub="available"/"unavailable"（Sci-Hub 是否收录）
    access: path.join(dir, stem + ".access.json"),
  };
}

/** 读取权限记录文件（双路径权限）：返回 {official, scihub}，未知路径为 null。
 *  official: "granted"/"denied"；scihub: "available"/"unavailable"。
 *  兼容旧格式记录（access: granted/denied → official 路径）。 */
function readAccessRecord(p) {
  const rec = { official: null, scihub: null };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p.access, "utf8"));
  } catch {
    return rec;
  }
  if (data.official === "granted" || data.official === "denied") {
    rec.official = data.official;
  } else if (data.access === "granted") {
    rec.official = "granted";
  } else if (data.access === "denied") {
    rec.official = "denied";
  }
  if (data.scihub === "available" || data.scihub === "unavailable") {
    rec.scihub = data.scihub;
  }
  return rec;
}

/** 仅当官方网页与 Sci-Hub 两条路径都标记为“无”时才直接跳过该文献。 */
function accessBothDenied(rec) {
  return !!rec && rec.official === "denied" && rec.scihub === "unavailable";
}

/** 简单校验 PDF 是否正常：文件存在且非空、头部含 %PDF-、尾部含 %%EOF。
 *  异常文件（0 字节、HTML 错误页、下载中断的残缺文件）按不存在处理，允许重新下载。
 *  头尾各留 1-2 KB 容错：部分 PDF 头部前有少量字节、尾部带填充数据。 */
function isPdfFileOk(p) {
  let size;
  try {
    size = fs.statSync(p).size;
  } catch {
    return false;
  }
  if (size === 0) return false;
  let fd;
  try {
    fd = fs.openSync(p, "r");
    const head = Buffer.alloc(Math.min(1024, size));
    fs.readSync(fd, head, 0, head.length, 0);
    if (!head.includes("%PDF-")) return false;
    const tail = Buffer.alloc(Math.min(2048, size));
    fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - 2048));
    return tail.includes("%%EOF");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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

/** 探测一个 Python：能否导入 paper_dl，以及是否装有 playwright（浏览器自动化依赖）。 */
function probePython(cmd) {
  return new Promise((resolve) => {
    execFile(cmd, ["-c", "import paper_dl.webcli"], { cwd: ROOT }, (err) => {
      if (err) return resolve(null);
      execFile(cmd, ["-c", "import playwright"], { cwd: ROOT }, (err2) => {
        resolve({ cmd, playwright: !err2 });
      });
    });
  });
}

async function findPython() {
  // 浏览器自动化是唯一的下载方式：多个 Python 都可用时，
  // 优先选择装有 playwright 的那个，避免下载第一步就失败
  const found = [];
  for (const cmd of PYTHON_CANDIDATES) {
    const probe = await probePython(cmd);
    if (probe) found.push(probe);
  }
  const withPlaywright = found.find((p) => p.playwright);
  return (withPlaywright || found[0] || {}).cmd || null;
}

let pythonCmd = null;

/** 调用 python -m paper_dl.webcli <args>，返回解析后的 JSON。 */
function runWebCli(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    if (!pythonCmd) return reject(new Error("Python 环境不可用"));
    execFile(
      pythonCmd,
      ["-m", "paper_dl.webcli", ...args],
      { cwd: ROOT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const line = (stdout || "").trim().split("\n").pop() || "";
        let data = null;
        try {
          data = JSON.parse(line);
        } catch {
          // 保留 null，走下方错误分支
        }
        if (data) return resolve(data);
        const detail = err ? (err.killed ? "子进程超时" : err.message) : "";
        reject(new Error(`webcli 调用失败: ${detail} ${stderr || ""}`.trim()));
      }
    );
  });
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
        let onId = null;
        if (payload && typeof payload.onId === "function") {
          onId = payload.onId;
          delete payload.onId; // 不随协议下发
        }
        try {
          w.child.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
        } catch (err) {
          w.pending.delete(id);
          reject(new Error("浏览器自动化进程不可用: " + err.message));
        }
        if (onId) onId(id); // 让调用方拿到自己的请求 id，用于精确中止
      })
  );
}

/** 向浏览器 worker 发送控制指令。target 指明只中止对应的 fetch 请求；为空则全局生效。 */
function bwControl(op, target = null) {
  if (!bw || bw.exited || !bw.ready) return false;
  const id = bw.nextId++;
  const msg = { id, op };
  if (target !== null && target !== undefined) msg.target = target;
  try {
    bw.child.stdin.write(JSON.stringify(msg) + "\n");
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
// 清单读写（支持“当前任务清单”切换：上次所用清单 / 生成的未下载清单 / 导入的清单；
// 支持多清单并行激活——批量导入或按期刊拆分生成时，扫盘与下载按合并后的清单执行）
// ---------------------------------------------------------------------------

const STATE_PATH = path.join(__dirname, "state.json");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeState(st) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2), "utf8");
}

/** 当前活动任务清单（数组，按顺序合并）：默认 download-manifest.json；
 *  网站打开时自动沿用上次所用清单。清单文件可能已被删除/移动，缺失的自动剔除，
 *  全部缺失时回退到默认清单。兼容旧版的单个 activeList 字段。 */
let activeListPaths = (() => {
  const st = readState();
  const list = Array.isArray(st.activeLists) && st.activeLists.length
    ? st.activeLists
    : st.activeList
      ? [st.activeList]
      : [MANIFEST_PATH];
  const existing = list.filter((p) => fs.existsSync(p));
  return existing.length ? existing : [MANIFEST_PATH];
})();

function setActiveLists(paths) {
  const unique = [...new Set(paths.map((p) => path.resolve(p)))];
  activeListPaths = unique.length ? unique : [MANIFEST_PATH];
  const st = readState();
  st.activeLists = activeListPaths;
  delete st.activeList; // 旧版单清单字段，迁移后移除
  writeState(st);
}

function readManifest() {
  const merged = { journals: [], items: [], updatedAt: null };
  const seenDoi = new Set();
  for (const p of activeListPaths) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    for (const j of data.journals || []) {
      if (j && !merged.journals.includes(j)) merged.journals.push(j);
    }
    for (const item of data.items || []) {
      if (!item || !item.doi || seenDoi.has(item.doi)) continue;
      seenDoi.add(item.doi);
      merged.items.push(item);
    }
    if (data.updatedAt && (!merged.updatedAt || data.updatedAt > merged.updatedAt)) {
      merged.updatedAt = data.updatedAt;
    }
  }
  return merged;
}

function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
}

/** 清单文件路径：任务清单-[未下载-]<名称>.json。
 *  同名文件已存在时直接覆盖（不再追加 -1/-2 序号）。 */
function listPath(name, undone = false) {
  const base = sanitizeComponent((undone ? "任务清单-未下载-" : "任务清单-") + name, 120);
  return path.join(ROOT, base + ".json");
}

/** 删除不符合命名规则的旧清单文件（历史上重名自动加的 -1/-2 序号版本）。 */
function cleanupNumberedLists() {
  const removed = [];
  try {
    for (const f of fs.readdirSync(ROOT)) {
      if (/^任务清单-.*-\d+\.json$/.test(f)) {
        try {
          fs.unlinkSync(path.join(ROOT, f));
          removed.push(f);
        } catch {
          /* 删除失败忽略 */
        }
      }
    }
  } catch {
    /* 目录读取失败忽略 */
  }
  return removed;
}

/** 从清单推断展示用名称（期刊名） */
function listName(manifest, fallback) {
  const journals = (manifest.journals || []).filter(Boolean);
  if (journals.length) return journals.join("、");
  const j = (manifest.items || []).find((it) => it.journal);
  return (j && j.journal) || fallback || "任务";
}

/** 把清单条目按期刊分组（保持出现顺序）。无期刊字段的条目归入“未知期刊”。 */
function groupItemsByJournal(items) {
  const groups = [];
  const byName = new Map();
  for (const item of items) {
    const name = item.journal || "未知期刊";
    let arr = byName.get(name);
    if (!arr) {
      arr = [];
      byName.set(name, arr);
      groups.push({ journal: name, items: arr });
    }
    arr.push(item);
  }
  return groups;
}

/** 按期刊把清单写成多个文件（每刊一份，覆盖式），返回写入的文件列表。 */
function writeListsPerJournal(prefix, items, extra = {}) {
  cleanupNumberedLists();
  const files = [];
  for (const group of groupItemsByJournal(items)) {
    const undone = prefix === "undone";
    const p = listPath(group.journal, undone);
    const payload = {
      journals: [group.journal],
      items: group.items,
      updatedAt: new Date().toISOString(),
      ...extra,
    };
    fs.writeFileSync(p, JSON.stringify(payload, null, 2), "utf8");
    files.push({ path: p, journal: group.journal, count: group.items.length });
  }
  return files;
}

// ---------------------------------------------------------------------------
// 期刊库（journal-library.json：站点根目录，可从界面增删改并导入检索栏）
// ---------------------------------------------------------------------------

const JOURNAL_LIBRARY_PATH = path.join(ROOT, "journal-library.json");

function readJournalLibrary() {
  try {
    const data = JSON.parse(fs.readFileSync(JOURNAL_LIBRARY_PATH, "utf8"));
    if (Array.isArray(data.journals)) return data.journals;
  } catch {
    /* 无库文件或坏 JSON */
  }
  return [];
}

function sanitizeJournalEntry(e) {
  return {
    name: String(e.name || "").trim().slice(0, 200),
    url: String(e.url || "").trim().slice(0, 500),
    issn: String(e.issn || "").trim().toUpperCase().slice(0, 9),
  };
}

function writeJournalLibrary(journals) {
  const cleaned = [];
  const seen = new Set();
  for (const e of journals) {
    const entry = sanitizeJournalEntry(e);
    if (!entry.name && !entry.url && !entry.issn) continue;
    const key = (entry.issn || entry.url || entry.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(entry);
  }
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    journals: cleaned,
  };
  fs.writeFileSync(JOURNAL_LIBRARY_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return cleaned;
}

// ---------------------------------------------------------------------------
// 下载设置持久化（state.json：下次打开网站自动恢复上次执行任务时的设置）
// ---------------------------------------------------------------------------

const KNOWN_BROWSERS = ["auto", "chrome", "edge", "firefox", "safari"];

const clampRange = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : undefined;
};

/** 只保留已知设置项并做类型/范围收敛，防止脏数据写进 state.json */
function sanitizeSettings(s) {
  const out = {};
  out.root = String(s.root || "").trim().slice(0, 500);
  const nums = {
    waitMinutes: [1, 120],
    maxRefresh: [0, 20],
    verifyInterval: [1, 120],
    verifyMaxFails: [1, 50],
    intervalSec: [0, 300],
  };
  for (const [k, [min, max]] of Object.entries(nums)) {
    const v = clampRange(s[k], min, max);
    if (v !== undefined) out[k] = v;
  }
  if (KNOWN_BROWSERS.includes(s.browser)) out.browser = s.browser;
  return out;
}

// ---------------------------------------------------------------------------
// API 路由
// ---------------------------------------------------------------------------

async function handleApi(req, res, pathname, body) {
  if (pathname === "/api/journal") {
    // 支持三种输入：期刊网址、纯 ISSN（期刊库导入）、名称（经 webcli 确认后返回候选）
    const url = String(body.url || "").trim();
    const issn = String(body.issn || "").trim();
    if (!url && !issn) return sendJson(res, 400, { error: "期刊网址或 ISSN 不能为空" });
    const result = issn
      ? await runWebCli(["journal", "--issn", issn])
      : await runWebCli(["journal", url]);
    return sendJson(res, result.ok ? 200 : 502, result);
  }

  // 期刊库：读取（GET 语义，POST 便于统一走 readBody 之外的轻量调用）
  if (pathname === "/api/journal-library") {
    return sendJson(res, 200, { ok: true, journals: readJournalLibrary(), path: JOURNAL_LIBRARY_PATH });
  }

  // 期刊库：整体保存（界面中的编辑 / 删除 / 手动添加最终都以整表提交）
  if (pathname === "/api/journal-library/save") {
    const journals = Array.isArray(body.journals) ? body.journals : null;
    if (!journals) return sendJson(res, 400, { error: "缺少期刊库内容" });
    const saved = writeJournalLibrary(journals);
    return sendJson(res, 200, { ok: true, count: saved.length, journals: saved });
  }

  // 期刊库：联网检索候选期刊。输入是网址 -> 解析该网址；输入是名称 -> Crossref 期刊库检索
  if (pathname === "/api/journal-library/search") {
    const query = String(body.query || "").trim();
    if (!query) return sendJson(res, 400, { error: "请输入期刊名称或网址" });
    const isUrl = /^https?:\/\//i.test(query) || /^[a-z0-9.-]+\.[a-z]{2,}/i.test(query);
    if (isUrl) {
      const result = await runWebCli(["journal", query]);
      if (!result.ok) return sendJson(res, 200, { ok: true, candidates: [], error: result.error });
      return sendJson(res, 200, {
        ok: true,
        candidates: [
          {
            title: result.journal.title,
            issn: result.journal.issn,
            url: query,
            publisher: "",
          },
        ],
      });
    }
    const result = await runWebCli(["journals", "--query", query, "--rows", "8"]);
    if (!result.ok) return sendJson(res, 502, result);
    const candidates = (result.journals || [])
      .filter((j) => j.issn)
      .map((j) => ({ title: j.title, issn: j.issn, url: "", publisher: j.publisher || "" }));
    return sendJson(res, 200, { ok: true, candidates });
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
    return sendJson(res, 200, {
      ok: true,
      manifest: readManifest(),
      paths: activeListPaths,
    });
  }

  // 下载设置持久化：GET 读取上次执行任务时的设置；POST 保存当前设置（下次打开自动恢复）
  if (pathname === "/api/settings") {
    if (req.method === "GET") {
      return sendJson(res, 200, { ok: true, settings: readState().settings || null });
    }
    const s = body.settings && typeof body.settings === "object" ? body.settings : null;
    if (!s) return sendJson(res, 400, { error: "缺少设置内容" });
    const st = readState();
    st.settings = sanitizeSettings(s);
    writeState(st);
    return sendJson(res, 200, { ok: true, settings: st.settings });
  }

  // 生成下载清单：按选择集（整刊 / 整卷 / 单篇）从缓存展开为完整文献信息。
  // 整刊/整卷选择会先确保该期刊检索完成，再依次汇总。
  // 检索了多本期刊时按期刊拆分，每本期刊各生成一份清单文件（同名覆盖）。
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
      if (sel.all || wholeVolumes.length) await ensureFullScan(issn);
      const { works } = readCache(issn);
      if (sel.all) {
        // 整刊全选（前端勾选期刊即生效，不依赖卷目录加载进度）：
        // 展开该期刊全部文献，excludeDois 为整刊范围内被取消的单篇
        const excluded = new Set(Array.isArray(sel.excludeDois) ? sel.excludeDois : []);
        for (const w of works) {
          if (excluded.has(w.doi) || seen.has(w.doi)) continue;
          seen.add(w.doi);
          items.push({ ...w, journal: journalTitle });
        }
        continue;
      }
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
    writeManifest({ journals: journalNames, items, updatedAt: new Date().toISOString() });
    const files = writeListsPerJournal("manifest", items);
    setActiveLists(files.map((f) => f.path)); // 各期刊清单共同作为当前执行清单
    return sendJson(res, 200, { ok: true, count: items.length, files });
  }

  // 保存当前任务清单：按期刊拆分为 任务清单-<期刊名>.json（同名覆盖）
  if (pathname === "/api/list/save") {
    const manifest = readManifest();
    if (!manifest.items || !manifest.items.length) {
      return sendJson(res, 400, { error: "当前没有任务清单可保存，请先生成或导入" });
    }
    const files = writeListsPerJournal("manifest", manifest.items);
    return sendJson(res, 200, { ok: true, path: files[0] && files[0].path, count: manifest.items.length, files });
  }

  // 生成“未下载清单”：按本地目录扫描当前清单，缺失条目按期刊拆分另存为新清单
  //（每本期刊一份 任务清单-未下载-<期刊名>.json，同名覆盖）并设为当前执行清单
  if (pathname === "/api/list/undone") {
    const root = String(body.root || "").trim();
    if (!root) return sendJson(res, 400, { error: "本地目录不能为空" });
    const manifest = readManifest();
    const items = manifest.items || [];
    if (!items.length) return sendJson(res, 400, { error: "当前任务清单为空" });
    const missingItems = [];
    let exists = 0;
    for (const item of items) {
      const p = entryPaths(root, item);
      // PDF 存在且文件正常（非 0 字节 / 残缺）才算已下载，异常文件进入未下载清单
      if (isPdfFileOk(p.pdf)) exists += 1;
      else missingItems.push(item);
    }
    if (!missingItems.length) {
      return sendJson(res, 200, { ok: true, count: 0, exists, message: "清单内文献均已下载，未下载清单为空" });
    }
    const files = writeListsPerJournal("undone", missingItems, { source: "undone", root });
    setActiveLists(files.map((f) => f.path));
    return sendJson(res, 200, { ok: true, files, count: missingItems.length, exists });
  }

  // 读取一份已保存的清单文件内容（仅限站点根目录下任务清单文件，供前端“保存任务清单”时逐份下载）
  if (pathname === "/api/list/file") {
    let p = String((body && body.path) || "").trim();
    if (!p && req.url) {
      try {
        p = String(new URL(req.url, "http://localhost").searchParams.get("path") || "").trim();
      } catch {
        p = "";
      }
    }
    if (!p) return sendJson(res, 400, { error: "缺少清单文件路径" });
    if (!path.isAbsolute(p)) p = path.join(ROOT, p);
    const resolved = path.resolve(p);
    const okName = /^任务清单-.*\.json$/.test(path.basename(resolved));
    if (!resolved.startsWith(ROOT) || !okName || !fs.existsSync(resolved)) {
      return sendJson(res, 400, { error: "清单文件不可读取: " + p });
    }
    try {
      const data = JSON.parse(fs.readFileSync(resolved, "utf8"));
      return sendJson(res, 200, { ok: true, data });
    } catch (e) {
      return sendJson(res, 400, { error: "读取清单失败: " + e.message });
    }
  }

  // 导入任务清单（支持批量）：paths 为本地路径数组（或单值 path）；
  // files 为浏览器直接选择上传的清单内容 [{name, content}]，先落盘再激活。
  if (pathname === "/api/list/import") {
    const rawPaths = Array.isArray(body.paths)
      ? body.paths
      : body.path
        ? [body.path]
        : [];
    const uploaded = Array.isArray(body.files) ? body.files : [];
    if (!rawPaths.length && !uploaded.length) {
      return sendJson(res, 400, { error: "任务清单路径不能为空" });
    }

    const loaded = [];
    const errors = [];
    for (let p of rawPaths.map((x) => String(x || "").trim()).filter(Boolean)) {
      if (!path.isAbsolute(p)) p = path.join(ROOT, p);
      if (!fs.existsSync(p)) {
        errors.push(`文件不存在: ${p}`);
        continue;
      }
      try {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        if (!Array.isArray(data.items)) throw new Error("缺少 items 数组");
        loaded.push({ path: p, count: data.items.length, journals: data.journals || [] });
      } catch (e) {
        errors.push(`读取失败 ${path.basename(p)}: ${e.message}`);
      }
    }
    for (const f of uploaded) {
      const name = sanitizeComponent(String(f.name || "").replace(/\.json$/i, ""), 120) || "导入清单";
      if (/[\\/]|^\.+$/.test(String(f.name || ""))) {
        errors.push("文件名不合法: " + f.name);
        continue;
      }
      try {
        const data = JSON.parse(String(f.content || ""));
        if (!Array.isArray(data.items)) throw new Error("缺少 items 数组");
        const p = listPath(listName({ journals: data.journals || [], items: data.items }));
        fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
        loaded.push({ path: p, count: data.items.length, journals: data.journals || [] });
      } catch (e) {
        errors.push(`读取失败 ${String(f.name || "")}: ${e.message}`);
      }
    }

    if (!loaded.length) {
      return sendJson(res, 400, { error: errors.join("；") || "没有成功导入的清单" });
    }
    setActiveLists(loaded.map((l) => l.path));
    return sendJson(res, 200, {
      ok: true,
      lists: loaded,
      count: loaded.reduce((sum, l) => sum + l.count, 0),
      errors: errors.length ? errors : undefined,
    });
  }

  if (pathname === "/api/scan") {
    const root = String(body.root || "").trim();
    if (!root) return sendJson(res, 400, { error: "本地目录不能为空" });
    const manifest = readManifest();
    const entries = (manifest.items || []).map((item, i) => {
      const p = entryPaths(root, item);
      // 判定规则：pdf 不存在或文件异常（0 字节 / 残缺 / HTML 错误页）均视为未下载
      // （pdfExists = 存在且正常，pdfInvalid = 文件在但异常）；信息文件状态一并报告；
      // 权限记录（双路径）一并报告，accessSkip = 两条路径均标记为“无”（下载时直接跳过）
      const pdfFileExists = fs.existsSync(p.pdf);
      const pdfOk = pdfFileExists && isPdfFileOk(p.pdf);
      const accessRec = readAccessRecord(p);
      return {
        index: i,
        doi: item.doi,
        title: item.title,
        rel: p.rel,
        stem: p.stem,
        pdfPath: p.pdf,
        txtPath: p.txt,
        accessPath: p.access,
        pdfExists: pdfOk,
        pdfInvalid: pdfFileExists && !pdfOk,
        txtExists: fs.existsSync(p.txt),
        access: accessRec,
        accessSkip: accessBothDenied(accessRec),
      };
    });
    const missing = entries.filter((e) => !e.pdfExists).length;
    // 缺失条目中两条权限路径均标记为“无”的数量：下载前扫描（始终开启）会直接跳过
    const noAccessMarked = entries.filter(
      (e) => !e.pdfExists && e.accessSkip
    ).length;
    return sendJson(res, 200, {
      ok: true,
      root,
      total: entries.length,
      missing,
      exists: entries.length - missing,
      noAccessMarked,
      entries,
    });
  }

  const BROWSER_CHOICES = ["auto", "chrome", "edge", "firefox", "safari"];
  const clampNum = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
  };

  if (pathname === "/api/fetch") {
    const root = String(body.root || "").trim();
    const item = body.item || {};
    if (!root || !item.doi) return sendJson(res, 400, { error: "缺少 root 或 doi" });
    const p = entryPaths(root, item);
    const waitMinutes = clampNum(body.waitMinutes, 1, 120, 2);
    const maxRefresh = clampNum(body.maxRefresh, 0, 20, 2);
    // 人机验证的模拟点击节奏：每 verifyInterval 秒点击一次，连续 verifyMaxFails 次未通过刷新页面
    const verifyInterval = clampNum(body.verifyInterval, 1, 120, 5);
    const verifyMaxFails = clampNum(body.verifyMaxFails, 1, 50, 5);
    const rawBrowser = String(body.browser || "auto").trim().toLowerCase();
    const browser = BROWSER_CHOICES.includes(rawBrowser) ? rawBrowser : "auto";
    // 下载前扫描权限记录（始终自动进行）：权限记录含两个权限——
    // 官方网页权限（official）与 Sci-Hub 是否收录（scihub）；
    // 仅当两者都被标记为“无”时直接跳过该篇，不再打开任何页面（删除记录文件后可重试）
    if (accessBothDenied(readAccessRecord(p))) {
      return sendJson(res, 200, {
        ok: false,
        error:
          "保存目录权限记录已标记官方网页与 Sci-Hub 均无权限，已直接跳过该篇" +
          `（如需重试请删除记录文件: ${p.access}）`,
        no_access: true,
        skipped: true,
        skipped_by_access_file: true,
      });
    }

    // 下载只走浏览器自动化：打开出版商页面，自动通过人机验证并触发 PDF 下载
    // 前端中断（停止下载 / 页面刷新 / 连接断开）时，只中止“本请求自己”的浏览器任务：
    // 否则会误杀其他并发请求正在执行的任务（全局停止走 /api/fetch-stop）
    let finished = false;
    let myFetchId = null; // 本请求的浏览器任务 id
    res.on("close", () => {
      if (finished) return;
      finished = true;
      bwControl("stop", myFetchId);
    });
    let result = null;
    let error = null;
    let noAccess = false; // 出版商返回无访问权限（付费墙）：前端按“无权限跳过”而非“失败”展示
    try {
      const r = await bwRequest({
        op: "fetch",
        onId: (id) => { myFetchId = id; },
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
        wait_minutes: waitMinutes,
        max_refresh: maxRefresh,
        verify_interval_s: verifyInterval,
        verify_max_fails: verifyMaxFails,
        human_wait_min: 0,
        browser,
        generate_info: true,
        overwrite: false,
      });
      if (r.ok) {
        result = r;
      } else {
        error = friendlyBrowserError(r.error || "下载失败");
        noAccess = !!r.no_access;
      }
    } catch (err) {
      error = friendlyBrowserError(err.message);
    }
    // 标记请求已结束：之后的连接关闭属于正常结束，不再触发中止
    finished = true;
    if (result) {
      return sendJson(res, 200, {
        ok: true,
        path: result.path,
        info_path: result.info_path,
        paper: result.paper || null,
        // 下载来源（sci-hub / publisher）：仅接口返回，不在界面上展示
        source: result.source || "publisher",
      });
    }
    return sendJson(res, 502, {
      ok: false,
      error: error || "浏览器自动化下载失败",
      no_access: noAccess,
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

  // 人工干预：刷新当前验证页面（Cloudflare 等验证页卡死/循环时人工触发重试）
  if (pathname === "/api/fetch-reload") {
    const sent = bwControl("reload");
    return sendJson(res, 200, { ok: sent, reloaded: sent, error: sent ? undefined : "当前没有浏览器自动化任务" });
  }

  // 停止当前下载：向浏览器 worker 发送中止指令（半成品文件由前端“继续下载”重新拉取）
  if (pathname === "/api/fetch-stop") {
    const stoppedBrowser = bwControl("stop");
    return sendJson(res, 200, { ok: true, stopped: stoppedBrowser });
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
      if (url.pathname === "/api/settings" && req.method === "GET") {
        return await handleApi(req, res, url.pathname, {});
      }
      if (url.pathname === "/api/fetch-status" && req.method === "GET") {
        return await handleApi(req, res, url.pathname, {});
      }
      if (url.pathname === "/api/journal-library" && req.method === "GET") {
        return await handleApi(req, res, url.pathname, {});
      }
      if (url.pathname === "/api/list/file" && req.method === "GET") {
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
    console.log("  浏览器不会自动打开，请手动复制上方地址访问");
    console.log("  按 Ctrl+C 停止服务");
    console.log("");
  });
}

main();
