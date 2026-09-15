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
// 清单读写（支持“当前任务清单”切换：上次所用清单 / 生成的未下载清单 / 导入的清单）
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

/** 当前活动任务清单：默认 download-manifest.json；网站打开时自动沿用上次所用清单。
 *  上次所用清单文件可能已被删除/移动，此时回退到默认清单。 */
let activeListPath = readState().activeList || MANIFEST_PATH;
if (activeListPath !== MANIFEST_PATH && !fs.existsSync(activeListPath)) {
  activeListPath = MANIFEST_PATH;
}

function setActiveList(p) {
  activeListPath = p;
  const st = readState();
  st.activeList = p;
  writeState(st);
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(activeListPath, "utf8"));
  } catch {
    return { journals: [], items: [], updatedAt: null };
  }
}

function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
}

/** 生成不重复的清单文件路径：任务清单-<名称>.json，重名自动加 -1/-2 序号 */
function nextListPath(name) {
  const base = sanitizeComponent(name, 60);
  let p = path.join(ROOT, base + ".json");
  let n = 1;
  while (fs.existsSync(p)) {
    p = path.join(ROOT, `${base}-${n}.json`);
    n += 1;
  }
  return p;
}

/** 从清单推断展示用名称（期刊名） */
function listName(manifest, fallback) {
  const journals = (manifest.journals || []).filter(Boolean);
  if (journals.length) return journals.join("、");
  const j = (manifest.items || []).find((it) => it.journal);
  return (j && j.journal) || fallback || "任务";
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
  if (typeof s.genInfo === "boolean") out.genInfo = s.genInfo;
  if (KNOWN_BROWSERS.includes(s.browser)) out.browser = s.browser;
  return out;
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
    return sendJson(res, 200, {
      ok: true,
      manifest: readManifest(),
      path: activeListPath,
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
    setActiveList(MANIFEST_PATH); // 板块一生成的清单自动作为当前执行清单
    return sendJson(res, 200, { ok: true, count: items.length });
  }

  // 保存当前任务清单：任务清单-<期刊名>.json，重名自动加序号
  if (pathname === "/api/list/save") {
    const manifest = readManifest();
    if (!manifest.items || !manifest.items.length) {
      return sendJson(res, 400, { error: "当前没有任务清单可保存，请先生成或导入" });
    }
    const p = nextListPath("任务清单-" + listName(manifest));
    fs.writeFileSync(p, JSON.stringify(manifest, null, 2), "utf8");
    return sendJson(res, 200, { ok: true, path: p, count: manifest.items.length });
  }

  // 生成“未下载清单”：按本地目录扫描当前清单，缺失条目另存为新清单并设为当前执行清单
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
      if (fs.existsSync(p.pdf)) exists += 1;
      else missingItems.push(item);
    }
    if (!missingItems.length) {
      return sendJson(res, 200, { ok: true, count: 0, exists, message: "清单内文献均已下载，未下载清单为空" });
    }
    const undone = {
      journals: manifest.journals || [],
      items: missingItems,
      updatedAt: new Date().toISOString(),
      source: "undone",
      root,
    };
    const p = nextListPath("任务清单-未下载-" + listName(manifest));
    fs.writeFileSync(p, JSON.stringify(undone, null, 2), "utf8");
    setActiveList(p);
    return sendJson(res, 200, { ok: true, path: p, count: missingItems.length, exists });
  }

  // 导入任务清单：按路径载入并设为当前执行清单
  if (pathname === "/api/list/import") {
    let p = String(body.path || "").trim();
    if (!p) return sendJson(res, 400, { error: "任务清单路径不能为空" });
    if (!path.isAbsolute(p)) p = path.join(ROOT, p);
    if (!fs.existsSync(p)) return sendJson(res, 400, { error: "文件不存在: " + p });
    let data;
    try {
      data = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      return sendJson(res, 400, { error: "读取任务清单失败: " + e.message });
    }
    if (!Array.isArray(data.items)) {
      return sendJson(res, 400, { error: "文件不是有效的任务清单（缺少 items 数组）" });
    }
    setActiveList(p);
    return sendJson(res, 200, { ok: true, path: p, count: data.items.length, journals: data.journals || [] });
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
    const genInfo = body.genInfo !== false;
    // 人机验证的模拟点击节奏：每 verifyInterval 秒点击一次，连续 verifyMaxFails 次未通过刷新页面
    const verifyInterval = clampNum(body.verifyInterval, 1, 120, 5);
    const verifyMaxFails = clampNum(body.verifyMaxFails, 1, 50, 5);
    const rawBrowser = String(body.browser || "auto").trim().toLowerCase();
    const browser = BROWSER_CHOICES.includes(rawBrowser) ? rawBrowser : "auto";

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
        generate_info: genInfo,
        overwrite: false,
      });
      if (r.ok) {
        result = r;
      } else {
        error = friendlyBrowserError(r.error || "下载失败");
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
      });
    }
    return sendJson(res, 502, { ok: false, error: error || "浏览器自动化下载失败" });
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
