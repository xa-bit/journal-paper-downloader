"use strict";

/**
 * 期刊文献下载器 - 前端逻辑
 *
 * 模块一 文献检索（三级懒加载，减小页面负担）：
 *   期刊级目录（只显示 已选/总文献 数量，不加载文献）
 *     -> 点击期刊名显示卷目录（只显示 已选/总文献 数量，同时关闭其他期刊）
 *       -> 点击卷名列出该卷文献名称（同时关闭其他卷的文献列表）
 *   “生成下载清单”时才由服务端按选择集依次加载完整文献信息。
 *
 * 模块二 扫盘与下载：扫描本地目录判断清单条目是否存在，下载缺失文件（PDF + 信息文件）。
 */

const $ = (sel) => document.querySelector(sel);

/** 每本期刊的前端状态 */
function newJournalState(info) {
  return {
    issn: info.issn,
    title: info.title,
    url: info.url,
    totalResults: info.total_results || 0,
    scan: { loaded: 0, total: 0, done: false },
    volumes: [], // {key, label, count, latest}
    volumesLoaded: false,
    expanded: false,
    expandedVolume: null,
    volumeWorks: new Map(), // volumeKey -> [work]
    selectedVolumes: new Set(), // 整卷勾选
    selectedDois: new Set(), // 单篇勾选
    deselectedDois: new Set(), // 整卷勾选内被取消的单篇
    loading: false,
  };
}

const state = {
  journals: [],
  detail: null, // {issn, work}
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

async function api(pathname, body, method = "POST") {
  const resp = await fetch(pathname, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({ error: "服务器返回异常" }));
  if (!resp.ok && data.ok !== false) data.ok = false;
  return data;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getJournal(issn) {
  return state.journals.find((j) => j.issn === issn);
}

// ---------------------------------------------------------------------------
// 期刊网址输入区（多行 / 增行 / 分离）
// ---------------------------------------------------------------------------

function addUrlRow(value = "") {
  const rows = $("#url-rows");
  const row = document.createElement("div");
  row.className = "url-row";
  row.innerHTML = `
    <input type="text" class="journal-url-input" value="${escapeHtml(value)}"
           placeholder="期刊网址，如 https://www.nature.com/ngeo/" autocomplete="off" />
    <button type="button" class="secondary row-remove" title="删除该行">×</button>
  `;
  row.querySelector(".row-remove").addEventListener("click", () => {
    if (rows.children.length > 1) row.remove();
    else row.querySelector("input").value = "";
  });
  rows.appendChild(row);
  return row;
}

function splitUrlRows() {
  const rows = [...document.querySelectorAll("#url-rows .url-row")];
  const urls = [];
  for (const row of rows) {
    const tokens = row.querySelector("input").value.split(/[\s,;，、]+/).filter(Boolean);
    urls.push(...tokens);
  }
  $("#url-rows").innerHTML = "";
  if (!urls.length) urls.push("");
  for (const u of urls) addUrlRow(u);
}

async function onSearchAll() {
  splitUrlRows(); // 检索前自动分离，避免一行多址导致解析失败
  const urls = [...document.querySelectorAll(".journal-url-input")]
    .map((i) => i.value.trim())
    .filter(Boolean);
  if (!urls.length) return;

  const btn = $("#search-all-btn");
  btn.disabled = true;
  const msg = $("#journal-msg");
  for (const [i, url] of urls.entries()) {
    btn.textContent = `解析中 ${i + 1}/${urls.length}…`;
    try {
      const r = await api("/api/journal", { url });
      if (!r.ok) throw new Error(r.error || "解析失败");
      if (!getJournal(r.journal.issn)) {
        state.journals.push(newJournalState(r.journal));
      }
    } catch (err) {
      msg.textContent = `「${url}」解析失败：${err.message}`;
    }
  }
  btn.disabled = false;
  btn.textContent = "检索期刊";
  $("#browse-area").classList.toggle("hidden", !state.journals.length);
  renderTree();
}

// ---------------------------------------------------------------------------
// 选择计数
// ---------------------------------------------------------------------------

/** 某卷内已选文献数 */
function volumeSelectedCount(j, vol) {
  if (j.selectedVolumes.has(vol.key)) {
    const works = j.volumeWorks.get(vol.key) || [];
    const deselected = works.filter((w) => j.deselectedDois.has(w.doi)).length;
    return vol.count - deselected;
  }
  const works = j.volumeWorks.get(vol.key) || [];
  return works.filter((w) => j.selectedDois.has(w.doi)).length;
}

function journalSelectedCount(j) {
  return j.volumes.reduce((sum, vol) => sum + volumeSelectedCount(j, vol), 0);
}

function journalTotal(j) {
  return j.scan.total || j.totalResults || 0;
}

function isArticleChecked(j, volKey, doi) {
  if (j.selectedVolumes.has(volKey)) return !j.deselectedDois.has(doi);
  return j.selectedDois.has(doi);
}

function totalSelectedCount() {
  return state.journals.reduce((sum, j) => sum + journalSelectedCount(j), 0);
}

function updateSelectedSummary() {
  const n = totalSelectedCount();
  $("#selected-summary").textContent = `已选 ${n} 篇`;
  $("#save-manifest-btn").disabled = n === 0;
}

// ---------------------------------------------------------------------------
// 树形目录渲染（期刊 -> 卷 -> 文章，逐级懒加载）
// ---------------------------------------------------------------------------

function renderTree() {
  const tree = $("#tree");
  tree.innerHTML = "";

  for (const j of state.journals) {
    const jEl = document.createElement("div");
    jEl.className = "tree-journal";

    const sel = journalSelectedCount(j);
    const allVolumesSelected =
      j.volumes.length > 0 && j.volumes.every((v) => j.selectedVolumes.has(v.key));
    const head = document.createElement("div");
    head.className = "tree-node root";
    head.innerHTML = `
      <span class="caret">${j.expanded ? "▾" : "▸"}</span>
      <input type="checkbox" class="journal-check" ${allVolumesSelected ? "checked" : ""} />
      <span class="root-title" title="点击展开/收起卷目录">${escapeHtml(j.title)}</span>
      <span class="count">${sel} / ${journalTotal(j)} 篇${j.scan.done ? `，共 ${j.volumes.length} 卷` : j.scan.loaded ? `（已扫描 ${j.scan.loaded}）` : ""}</span>
    `;
    jEl.appendChild(head);

    head.querySelector(".caret").addEventListener("click", () => toggleJournal(j));
    head.querySelector(".root-title").addEventListener("click", () => toggleJournal(j));
    head.querySelector(".journal-check").addEventListener("change", (e) => {
      if (e.target.checked) {
        j.volumes.forEach((v) => j.selectedVolumes.add(v.key));
        j.deselectedDois.clear();
      } else {
        j.selectedVolumes.clear();
        j.selectedDois.clear();
        j.deselectedDois.clear();
      }
      renderTree();
      updateSelectedSummary();
    });

    if (j.expanded) {
      const body = document.createElement("div");
      body.className = "tree-children";

      if (!j.volumesLoaded) {
        body.innerHTML = '<p class="empty">卷目录加载中…</p>';
      } else {
        for (const vol of j.volumes) {
          body.appendChild(renderVolumeNode(j, vol));
        }
        const status = document.createElement("div");
        status.className = "load-bar";
        if (j.scan.done) {
          status.innerHTML = `<span class="hint">共 ${j.volumes.length} 卷，已扫描 ${j.scan.loaded} 篇文献</span>`;
        } else {
          status.innerHTML = `<span class="hint">卷目录检索中：已扫描 ${j.scan.loaded} / 约 ${j.scan.total} 篇（再点击期刊名可收起并暂停）</span>`;
        }
        body.appendChild(status);
      }
      jEl.appendChild(body);
    }
    tree.appendChild(jEl);
  }
}

function renderVolumeNode(j, vol) {
  const el = document.createElement("div");
  el.className = "tree-volume";
  const isOpen = j.expandedVolume === vol.key;
  const selCount = volumeSelectedCount(j, vol);
  const volWorks = j.volumeWorks.get(vol.key) || [];
  const allChecked = j.selectedVolumes.has(vol.key) ||
    (volWorks.length > 0 && volWorks.every((w) => j.selectedDois.has(w.doi)));

  const head = document.createElement("div");
  head.className = "tree-node vol";
  head.innerHTML = `
    <span class="caret">${isOpen ? "▾" : "▸"}</span>
    <input type="checkbox" class="vol-check" ${allChecked ? "checked" : ""} />
    <span class="vol-label" title="点击加载/收起该卷文献">${escapeHtml(vol.label)}</span>
    <span class="count">${selCount} / ${vol.count} 篇</span>
  `;
  el.appendChild(head);

  head.querySelector(".caret").addEventListener("click", () => toggleVolume(j, vol));
  head.querySelector(".vol-label").addEventListener("click", () => toggleVolume(j, vol));
  head.querySelector(".vol-check").addEventListener("change", (e) => {
    if (e.target.checked) {
      j.selectedVolumes.add(vol.key);
      // 清除该卷内的单篇例外
      for (const w of volWorks) j.deselectedDois.delete(w.doi);
    } else {
      j.selectedVolumes.delete(vol.key);
      for (const w of volWorks) j.selectedDois.delete(w.doi);
      for (const w of volWorks) j.deselectedDois.delete(w.doi);
    }
    renderTree();
    updateSelectedSummary();
  });

  if (isOpen) {
    const children = document.createElement("div");
    children.className = "tree-children";
    if (!volWorks.length) {
      children.innerHTML = '<p class="empty">文献加载中…</p>';
    } else {
      for (const work of volWorks) {
        children.appendChild(renderArticleNode(j, vol.key, work));
      }
      if (!j.scan.done) {
        const note = document.createElement("p");
        note.className = "empty";
        note.textContent = "期刊卷目录仍在检索中，该卷文献可能不全（稍候自动补全）。";
        children.appendChild(note);
      }
    }
    el.appendChild(children);
  }
  return el;
}

function renderArticleNode(j, volKey, work) {
  const row = document.createElement("div");
  row.className =
    "tree-node article" +
    (state.detail && state.detail.work.doi === work.doi ? " active" : "");
  row.innerHTML = `
    <input type="checkbox" class="art-check" ${isArticleChecked(j, volKey, work.doi) ? "checked" : ""} />
    <span class="art-title" title="${escapeHtml(work.title)}">${escapeHtml(work.title || work.doi)}</span>
    <span class="art-date">${escapeHtml(work.date || "")}</span>
  `;
  row.querySelector(".art-check").addEventListener("change", (e) => {
    if (j.selectedVolumes.has(volKey)) {
      if (e.target.checked) j.deselectedDois.delete(work.doi);
      else j.deselectedDois.add(work.doi);
    } else {
      if (e.target.checked) j.selectedDois.add(work.doi);
      else j.selectedDois.delete(work.doi);
    }
    renderTree();
    updateSelectedSummary();
  });
  row.querySelector(".art-title").addEventListener("click", () => {
    state.detail = { issn: j.issn, work };
    renderTree();
    renderDetail();
  });
  return row;
}

// ---------------------------------------------------------------------------
// 逐级加载
// ---------------------------------------------------------------------------

/** 点击期刊名：展开其卷目录并自动检索到全部卷（带进度），同时关闭其他期刊的展开状态。 */
async function toggleJournal(j) {
  if (j.expanded) {
    j.expanded = false;
    renderTree();
    return;
  }
  for (const other of state.journals) {
    other.expanded = false;
    other.expandedVolume = null;
  }
  j.expanded = true;
  renderTree();
  await scanVolumesToDone(j);
}

/** 逐页检索期刊文献直到卷目录完整；卷一级只汇总数量，不加载具体文献。再次点击期刊名收起可暂停。 */
async function scanVolumesToDone(j) {
  if (j.loading) return;
  j.loading = true;
  renderTree();
  try {
    do {
      const r = await api("/api/volumes", { issn: j.issn, more: j.volumesLoaded });
      if (!r.ok) throw new Error(r.error || "卷目录加载失败");
      j.volumes = r.volumes;
      j.volumesLoaded = true;
      j.scan = r.scan;
      renderTree();
    } while (j.expanded && !j.scan.done);
  } catch (err) {
    $("#journal-msg").textContent = `「${j.title}」卷目录加载失败：${err.message}`;
  } finally {
    j.loading = false;
    renderTree();
    updateSelectedSummary();
  }
}

/** 点击卷名：加载该卷文献名称，并关闭其他卷的文献列表。 */
async function toggleVolume(j, vol) {
  if (j.expandedVolume === vol.key) {
    j.expandedVolume = null;
    renderTree();
    return;
  }
  j.expandedVolume = vol.key;
  renderTree();
  if (!j.volumeWorks.has(vol.key)) {
    try {
      const r = await api("/api/volume-works", { issn: j.issn, volumeKey: vol.key });
      if (!r.ok) throw new Error(r.error || "文献加载失败");
      j.volumeWorks.set(vol.key, r.works);
      vol.count = r.works.length;
    } catch (err) {
      $("#journal-msg").textContent = `「${vol.label}」文献加载失败：${err.message}`;
    }
    renderTree();
  }
}

// ---------------------------------------------------------------------------
// 详情面板
// ---------------------------------------------------------------------------

function renderDetail() {
  const pane = $("#detail-pane");
  if (!state.detail) {
    pane.innerHTML = '<p class="empty">点击文章标题，在此查看详情。</p>';
    return;
  }
  const j = getJournal(state.detail.issn);
  const work = state.detail.work;
  const volKey = work.volume ? "v:" + work.volume : work.issue ? "i:" + work.issue : "none";
  const checked = j ? isArticleChecked(j, volKey, work.doi) : false;
  pane.innerHTML = `
    <h3>${escapeHtml(work.title || work.doi)}</h3>
    <dl>
      <dt>日期</dt><dd>${escapeHtml(work.date || "未知")}</dd>
      <dt>作者</dt><dd>${escapeHtml((work.authors || []).join(", ") || "未知")}</dd>
      <dt>DOI</dt><dd>${escapeHtml(work.doi || "无")}</dd>
      <dt>期刊</dt><dd>${escapeHtml((j && j.title) || work.journal || "")}</dd>
      <dt>卷 / 期</dt><dd>${escapeHtml([work.volume && "Volume " + work.volume, work.issue && "Issue " + work.issue].filter(Boolean).join(" / ") || "无")}</dd>
      <dt>链接</dt><dd><a href="${escapeHtml(work.url || "https://doi.org/" + work.doi)}" target="_blank" rel="noopener">${escapeHtml(work.url || "https://doi.org/" + work.doi)}</a></dd>
    </dl>
    <label class="detail-check">
      <input type="checkbox" id="detail-check" ${checked ? "checked" : ""} /> 加入下载清单
    </label>
  `;
  $("#detail-check").addEventListener("change", (e) => {
    if (!j) return;
    if (j.selectedVolumes.has(volKey)) {
      if (e.target.checked) j.deselectedDois.delete(work.doi);
      else j.deselectedDois.add(work.doi);
    } else {
      if (e.target.checked) j.selectedDois.add(work.doi);
      else j.selectedDois.delete(work.doi);
    }
    renderTree();
    updateSelectedSummary();
  });
}

// ---------------------------------------------------------------------------
// 下载清单：按选择集生成，服务端再依次加载完整文献信息
// ---------------------------------------------------------------------------

async function saveManifest() {
  const selections = [];
  for (const j of state.journals) {
    const volumes = [...j.selectedVolumes];
    const dois = [...j.selectedDois].filter((doi) => {
      // 整卷已含的不再单独发送
      for (const [key, works] of j.volumeWorks) {
        if (j.selectedVolumes.has(key) && works.some((w) => w.doi === doi)) return false;
      }
      return true;
    });
    if (volumes.length || dois.length) {
      selections.push({ issn: j.issn, journal: j.title, volumes, dois });
    }
  }
  if (!selections.length) return;

  const btn = $("#save-manifest-btn");
  const msg = $("#manifest-msg");
  btn.disabled = true;
  try {
    // 即使此前未完整检索，生成清单前也先对每本期刊补全扫描（带进度显示）
    for (const j of state.journals) {
      const sel = selections.find((s) => s.issn === j.issn);
      if (!sel) continue;
      while (!j.scan.done) {
        msg.textContent = `清单准备中：《${j.title}》文献检索 ${j.scan.loaded} / 约 ${j.scan.total} 篇…`;
        const r = await api("/api/volumes", { issn: j.issn, more: true });
        if (!r.ok) throw new Error(r.error || "文献检索失败");
        j.volumes = r.volumes;
        j.volumesLoaded = true;
        j.scan = r.scan;
      }
      msg.textContent = `清单准备中：《${j.title}》已完整检索（${j.scan.loaded} 篇），正在汇总…`;
    }
    msg.textContent = "正在生成清单…";
    const r = await api("/api/manifest/save", { selections });
    if (!r.ok) throw new Error(r.error || "保存失败");
    msg.textContent = `✔ 清单已缓存（${r.count} 篇），请到下方“扫盘与下载”模块操作。`;
    await refreshManifestInfo();
  } catch (err) {
    msg.textContent = "保存失败：" + err.message;
  } finally {
    updateSelectedSummary();
  }
}

// ---------------------------------------------------------------------------
// 模块二：扫盘与下载
// ---------------------------------------------------------------------------

// 下载方式：仅浏览器自动化（真实浏览器打开出版商页面、自动通过人机验证并下载 PDF）
// 浏览器选择（localStorage 持久化；默认 Edge，auto = 依次尝试本机 Chrome / Edge / 内置 Chromium）
// 说明：Playwright 版 Firefox 极易被 Cloudflare 识别为自动化浏览器导致验证无法通过，
// 默认使用本机 Edge（真实浏览器内核 + 反检测脚本），通过率最高
const BROWSER_CHOICES = ["edge", "auto", "chrome", "firefox", "safari"];

function loadBrowserChoice() {
  try {
    const saved = localStorage.getItem("pdl-browser-v2");
    if (BROWSER_CHOICES.includes(saved)) return saved;
  } catch { /* 忽略坏数据 */ }
  return "edge"; // 默认 Edge（真实内核，反检测通过率最高）
}

let browserChoice = loadBrowserChoice();

function saveBrowserChoice() {
  localStorage.setItem("pdl-browser-v2", browserChoice);
  scheduleSettingsSave(); // 同步到服务端，下次打开自动恢复
}

// ---------------------------------------------------------------------------
// 设置持久化（服务端 state.json）：改动即自动保存，下次打开网站自动恢复
// 上次执行任务时的全部设置（含浏览器选择）
// ---------------------------------------------------------------------------

const SETTINGS_INPUT_IDS = [
  "local-root",
  "wait-min",
  "max-refresh",
  "verify-interval",
  "verify-max-fails",
  "task-interval",
];

function collectSettings() {
  const num = (id) => {
    const v = parseInt($("#" + id).value, 10);
    return Number.isFinite(v) ? v : null;
  };
  return {
    root: $("#local-root").value.trim(),
    waitMinutes: num("wait-min"),
    maxRefresh: num("max-refresh"),
    verifyInterval: num("verify-interval"),
    verifyMaxFails: num("verify-max-fails"),
    intervalSec: num("task-interval"),
    genInfo: $("#gen-info").checked,
    browser: browserChoice,
  };
}

function applySettings(s) {
  if (!s || typeof s !== "object") return;
  if (typeof s.root === "string" && s.root) $("#local-root").value = s.root;
  const setNum = (id, v) => {
    if (Number.isFinite(v)) $("#" + id).value = v;
  };
  setNum("wait-min", s.waitMinutes);
  setNum("max-refresh", s.maxRefresh);
  setNum("verify-interval", s.verifyInterval);
  setNum("verify-max-fails", s.verifyMaxFails);
  setNum("task-interval", s.intervalSec);
  if (typeof s.genInfo === "boolean") $("#gen-info").checked = s.genInfo;
  if (BROWSER_CHOICES.includes(s.browser)) {
    browserChoice = s.browser;
    saveBrowserChoice();
    $("#browser-select").value = browserChoice;
  }
}

let settingsSaveTimer = null;

/** 设置变更后延时自动保存（防抖：连续输入只写一次） */
function scheduleSettingsSave() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(async () => {
    try {
      await api("/api/settings", { settings: collectSettings() });
    } catch {
      /* 保存失败不阻塞界面 */
    }
  }, 800);
}

async function loadSettings() {
  try {
    const r = await api("/api/settings", null, "GET");
    if (r.ok && r.settings) applySettings(r.settings);
  } catch {
    /* 读取失败时沿用默认/localStorage 设置 */
  }
}

/** 读取下载参数（带上下限保护，默认 等待2分钟 / 刷新2次 / 验证点击5s / 验证5次失败刷新 / 间隔5秒） */
function readDownloadOptions() {
  const num = (sel, min, max, def) => {
    const v = parseInt($(sel).value, 10);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  };
  return {
    browser: browserChoice,
    waitMinutes: num("#wait-min", 1, 120, 2),
    maxRefresh: num("#max-refresh", 0, 20, 2),
    verifyInterval: num("#verify-interval", 1, 120, 5),
    verifyMaxFails: num("#verify-max-fails", 1, 50, 5),
    intervalSec: num("#task-interval", 0, 300, 5),
    genInfo: $("#gen-info").checked,
  };
}

// 浏览器自动化状态轮询 + 人工干预横幅
let statusTimer = null;
let statusEntryIndex = null;

function showAuthBanner(message) {
  const banner = $("#auth-banner");
  $("#auth-banner-text").textContent = message;
  banner.classList.remove("hidden");
}

function hideAuthBanner() {
  $("#auth-banner").classList.add("hidden");
}

async function pollFetchStatus() {
  try {
    const r = await api("/api/fetch-status", null, "GET");
    const st = r.ok ? r.status : null;
    if (!st) return;
    const li = statusEntryIndex !== null ? $("#scan-" + statusEntryIndex) : null;
    const detail = li && li.querySelector(".dl-detail");
    if (detail && st.message) {
      detail.textContent = "浏览器自动化：" + st.message;
    }
    if (st.state === "auth") {
      showAuthBanner(st.message);
    } else if (!$("#auth-banner").classList.contains("hidden")) {
      hideAuthBanner(); // 验证已通过或任务状态变化，收起横幅
    }
  } catch { /* 轮询失败忽略，下个周期重试 */ }
}

function startStatusPolling(entryIndex) {
  stopStatusPolling();
  statusEntryIndex = entryIndex;
  statusTimer = setInterval(pollFetchStatus, 1500);
  pollFetchStatus();
}

function stopStatusPolling() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
  statusEntryIndex = null;
  hideAuthBanner();
}

async function onSkipCurrent() {
  try {
    await api("/api/fetch-skip", {});
  } catch { /* 忽略 */ }
  hideAuthBanner();
}

/** 人工刷新当前验证页（Cloudflare 验证页卡死/循环时触发重试）。 */
async function onAuthReload() {
  try {
    const r = await api("/api/fetch-reload", {});
    if (!r.ok) $("#auth-banner-text").textContent = r.error || "刷新失败";
  } catch { /* 忽略 */ }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshManifestInfo() {
  const r = await api("/api/manifest", null, "GET");
  const box = $("#manifest-info");
  const manifest = r.ok ? r.manifest : null;
  const hasItems = !!(manifest && manifest.items && manifest.items.length);
  // 两个板块的“保存任务清单”按钮：有当前清单才可用
  $("#save-list-btn").disabled = !hasItems;
  $("#export-list-btn").disabled = !hasItems;
  if (!hasItems) {
    box.classList.remove("hidden");
    box.innerHTML = '<span class="hint">当前没有任务清单，请先生成或导入。</span>';
    return;
  }
  const names = (manifest.journals || []).join("、") || "未知期刊";
  const t = manifest.updatedAt ? new Date(manifest.updatedAt).toLocaleString() : "";
  const source = manifest.source === "undone" ? " ｜ 来源：未下载清单" : "";
  box.classList.remove("hidden");
  box.innerHTML =
    `当前待执行任务清单：<b>${escapeHtml(names)}</b> ｜ ${manifest.items.length} 篇 ｜ 生成于 ${escapeHtml(t)}${source}` +
    (r.path ? ` ｜ 文件: <span class="list-path">${escapeHtml(r.path)}</span>` : "");
}

let scanResult = null;

// ---------------------------------------------------------------------------
// 任务清单操作：保存 / 导入 / 生成未下载清单（当前待执行清单自动切换并持久化）
// ---------------------------------------------------------------------------

/** 重置扫盘与下载状态：清单切换后旧结果作废 */
function resetScanState() {
  stopStatusPolling();
  hideAuthBanner();
  dlSession = null;
  scanResult = null;
  $("#scan-list").innerHTML = "";
  $("#scan-summary").textContent = "";
  $("#fetch-btn").disabled = true;
  setDownloadButtons("idle");
}

/** 板块一：保存当前任务清单为文件（重名自动加序号），并通过浏览器下载 */
async function onExportList() {
  const btn = $("#export-list-btn");
  const msg = $("#manifest-msg");
  btn.disabled = true;
  try {
    const r = await api("/api/list/save", {});
    if (!r.ok) throw new Error(r.error || "保存失败");
    // 以保存时的文件名（含防重序号）触发浏览器下载一份
    const m = await api("/api/manifest", null, "GET");
    if (!m.ok) throw new Error(m.error || "读取清单失败");
    const blob = new Blob([JSON.stringify(m.manifest, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = String(r.path || "任务清单.json").split(/[\\/]/).pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    msg.textContent = `✔ 任务清单已保存（${r.count} 篇）：${r.path}，并已通过浏览器下载`;
  } catch (err) {
    msg.textContent = "保存任务清单失败：" + err.message;
  } finally {
    btn.disabled = false;
    refreshManifestInfo();
  }
}

/** 板块二：把当前待执行的任务清单保存为文件（任务清单-期刊名.json，重名自动加序号） */
async function onSaveList() {
  const btn = $("#save-list-btn");
  btn.disabled = true;
  try {
    const r = await api("/api/list/save", {});
    if (!r.ok) throw new Error(r.error || "保存失败");
    $("#list-msg").textContent = `✔ 当前任务清单已保存（${r.count} 篇）：${r.path}`;
    refreshManifestInfo();
  } catch (err) {
    $("#list-msg").textContent = "保存任务清单失败：" + err.message;
  } finally {
    btn.disabled = false;
  }
}

/** 板块二：按输入路径导入任务清单，导入后自动切换为当前待执行清单并重新扫盘 */
async function onImportList() {
  const p = $("#import-path").value.trim();
  if (!p) {
    $("#list-msg").textContent = "请先输入任务清单文件路径";
    return;
  }
  const btn = $("#import-btn");
  btn.disabled = true;
  try {
    const r = await api("/api/list/import", { path: p });
    if (!r.ok) throw new Error(r.error || "导入失败");
    $("#list-msg").textContent = `✔ 已导入任务清单（${r.count} 篇）并设为当前清单：${r.path}`;
    $("#import-path").value = r.path; // 回填绝对路径，便于核对
    resetScanState();
    await refreshManifestInfo();
    await onScan();
  } catch (err) {
    $("#list-msg").textContent = "导入任务清单失败：" + err.message;
  } finally {
    btn.disabled = false;
  }
}

/** 板块二：按扫盘结果生成“未下载清单”（仅含缺失条目），并自动切换为当前待执行清单 */
async function onGenUndone() {
  const root = $("#local-root").value.trim();
  if (!root) {
    $("#list-msg").textContent = "请先填写本地目录";
    return;
  }
  const btn = $("#undone-btn");
  btn.disabled = true;
  try {
    const r = await api("/api/list/undone", { root });
    if (!r.ok) throw new Error(r.error || "生成失败");
    if (r.count === 0) {
      $("#list-msg").textContent = r.message || "清单内文献均已下载，未下载清单为空";
      return;
    }
    $("#list-msg").textContent =
      `✔ 未下载清单已生成并设为当前任务清单（缺失 ${r.count} 篇，已下载 ${r.exists} 篇）：${r.path}`;
    resetScanState();
    await refreshManifestInfo();
    await onScan(); // 用新清单重新扫盘，界面即切换为未下载任务
  } catch (err) {
    $("#list-msg").textContent = "生成未下载清单失败：" + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function onScan() {
  const root = $("#local-root").value.trim();
  if (!root) return;
  const btn = $("#scan-btn");
  btn.disabled = true;
  btn.textContent = "扫描中…";
  try {
    const r = await api("/api/scan", { root });
    if (!r.ok) throw new Error(r.error || "扫描失败");
    scanResult = r;
    dlSession = null;
    setDownloadButtons("idle");
    renderScanList();
    $("#scan-summary").textContent =
      r.total === 0
        ? "清单为空，请先生成下载清单"
        : `清单 ${r.total} 篇：已存在 ${r.exists} 篇，缺失 ${r.missing} 篇`;
    $("#fetch-btn").disabled = r.missing === 0;
    $("#undone-btn").disabled = r.total === 0; // 扫盘后可按缺失条目生成未下载清单
    $("#open-dir-btn").disabled = false;
  } catch (err) {
    $("#scan-summary").textContent = "扫描失败：" + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "扫描本地目录";
  }
}

function renderScanList() {
  const list = $("#scan-list");
  list.innerHTML = "";
  if (!scanResult) return;
  scanResult.entries.forEach((entry, i) => {
    const li = document.createElement("li");
    li.className = "download-item";
    li.id = "scan-" + i;
    const status = entry.pdfExists
      ? '<span class="status ok">✔ 已存在</span>'
      : '<span class="status pending">✘ 缺失</span>';
    const txtNote = entry.pdfExists
      ? entry.txtExists
        ? "（含信息文件）"
        : "（缺信息文件，重新下载时会重新生成）"
      : "";
    li.innerHTML = `
      ${status}
      <span class="dl-title">${escapeHtml(entry.title || entry.doi)}</span>
      <span class="dl-detail">${escapeHtml(entry.rel + "/" + entry.stem + ".pdf")} ${txtNote}</span>
    `;
    list.appendChild(li);
  });
}

// 下载会话：支持停止 / 继续
let dlSession = null; // {entries, idx, root, options, manifestItems, ok, fail, stopped}

function setDownloadButtons(mode) {
  // mode: idle | running | stopped
  $("#fetch-btn").classList.toggle("hidden", mode !== "idle");
  $("#stop-btn").classList.toggle("hidden", mode !== "running");
  $("#resume-btn").classList.toggle("hidden", mode !== "stopped");
  // 扫描 / 刷新仅在下載进行中禁用：停止后可重新扫盘、重建待下载任务序列
  $("#scan-btn").disabled = mode === "running";
  $("#refresh-btn").disabled = mode === "running";
}

async function onFetch() {
  if (!scanResult) return;
  const missing = scanResult.entries.filter((e) => !e.pdfExists);
  if (!missing.length) return;

  const manifestResp = await api("/api/manifest", null, "GET");
  const manifestItems = (manifestResp.ok && manifestResp.manifest.items) || [];

  // 快照本次执行任务所用设置到服务端：下次打开网站自动恢复
  try {
    await api("/api/settings", { settings: collectSettings() });
  } catch {
    /* 保存失败不影响下载 */
  }

  dlSession = {
    entries: missing,
    idx: 0,
    root: $("#local-root").value.trim(),
    options: readDownloadOptions(),
    manifestItems,
    ok: 0,
    fail: 0,
    stopped: false,
  };
  setDownloadButtons("running");
  await runDownloadLoop();
}

async function runDownloadLoop() {
  const s = dlSession;
  const opts = s.options || readDownloadOptions();
  for (; s.idx < s.entries.length; s.idx++) {
    if (s.stopped) break;
    const entry = s.entries[s.idx];
    const li = $("#scan-" + entry.index);
    if (li) li.querySelector(".status").outerHTML = '<span class="status pending">⏳ 下载中</span>';
    $("#scan-summary").textContent =
      `下载中… 第 ${s.idx + 1} / ${s.entries.length} 篇（成功 ${s.ok}，失败 ${s.fail}）`;
    const item = s.manifestItems[entry.index] || { doi: entry.doi, title: entry.title };
    startStatusPolling(entry.index);
    try {
      const r = await api("/api/fetch", {
        root: s.root,
        item,
        browser: opts.browser,
        waitMinutes: opts.waitMinutes,
        maxRefresh: opts.maxRefresh,
        verifyInterval: opts.verifyInterval,
        verifyMaxFails: opts.verifyMaxFails,
        genInfo: opts.genInfo,
      });
      stopStatusPolling();
      if (r.ok) {
        s.ok += 1;
        if (li) {
          li.querySelector(".status").outerHTML = '<span class="status ok">✔ 成功</span>';
          li.querySelector(".dl-detail").textContent =
            "［浏览器自动化］" + r.path + (r.info_path ? "（信息文件: " + r.info_path + "）" : "");
        }
      } else {
        if (s.stopped) break; // 停止导致的错误不计入失败
        s.fail += 1;
        if (li) {
          li.querySelector(".status").outerHTML = '<span class="status fail">✘ 失败</span>';
          li.querySelector(".dl-detail").textContent = r.error || "未知错误";
        }
      }
    } catch (err) {
      stopStatusPolling();
      if (s.stopped) break;
      s.fail += 1;
      if (li) {
        li.querySelector(".status").outerHTML = '<span class="status fail">✘ 失败</span>';
        li.querySelector(".dl-detail").textContent =
          "网络错误（连接中断或服务未响应）：" + err.message;
      }
    }
    // 任务间隔：防止请求过密被网站判定为恶意行为
    if (opts.intervalSec > 0 && s.idx < s.entries.length - 1 && !s.stopped) {
      $("#scan-summary").textContent =
        `任务间隔中（${opts.intervalSec} 秒）… 已完成 ${s.ok + s.fail} / ${s.entries.length} 篇`;
      for (let t = 0; t < opts.intervalSec * 4 && !s.stopped; t++) {
        await sleep(250);
      }
    }
  }
  stopStatusPolling();

  if (s.stopped) {
    // 被中断的条目：服务端已删除停止前的半成品，继续时从该条目重新下载
    const li = $("#scan-" + s.entries[Math.min(s.idx, s.entries.length - 1)].index);
    if (li && s.idx < s.entries.length) {
      li.querySelector(".status").outerHTML = '<span class="status pending">⏸ 已停止</span>';
    }
    $("#scan-summary").textContent =
      `已停止：完成 ${s.ok + s.fail} / ${s.entries.length} 篇，点“继续下载”从当前条目重新下载`;
    setDownloadButtons("stopped");
  } else {
    $("#scan-summary").textContent =
      `下载完成：成功 ${s.ok}，失败 ${s.fail}，跳过已存在 ${scanResult.exists} 篇`;
    setDownloadButtons("idle");
    $("#fetch-btn").disabled = true;
  }
}

/** 刷新：保留当前输入（保存目录等设置不变），重置下载状态后重新扫盘，可再次依次下载。 */
async function onRefresh() {
  stopStatusPolling();
  hideAuthBanner();
  dlSession = null;
  scanResult = null;
  $("#scan-list").innerHTML = "";
  $("#scan-summary").textContent = "已刷新，正在重新扫盘…";
  $("#fetch-btn").disabled = true;
  setDownloadButtons("idle");
  refreshManifestInfo();
  await onScan();
}

async function onStopFetch() {
  if (!dlSession || dlSession.stopped) return;
  dlSession.stopped = true;
  $("#scan-summary").textContent = "正在停止当前下载…";
  hideAuthBanner();
  try {
    await api("/api/fetch-stop", {});
  } catch {
    /* 停止请求失败也按已停止处理 */
  }
}

async function onResumeFetch() {
  if (!dlSession) return;
  // 继续：当前条目在停止前的下载内容已被服务端删除，从它开始重新下载
  dlSession.stopped = false;
  setDownloadButtons("running");
  await runDownloadLoop();
}

async function onOpenDir() {
  const dir = $("#local-root").value.trim() || "papers";
  try {
    const r = await api("/api/open-dir", { dir });
    if (!r.ok) $("#scan-summary").textContent = r.error || "打开目录失败";
  } catch (err) {
    $("#scan-summary").textContent = "打开目录失败：" + err.message;
  }
}

// ---------------------------------------------------------------------------
// 事件绑定与初始化
// ---------------------------------------------------------------------------

$("#add-url-btn").addEventListener("click", () => addUrlRow());
$("#split-url-btn").addEventListener("click", splitUrlRows);
$("#search-all-btn").addEventListener("click", onSearchAll);
$("#save-manifest-btn").addEventListener("click", saveManifest);
$("#scan-btn").addEventListener("click", onScan);
$("#refresh-btn").addEventListener("click", onRefresh);
$("#fetch-btn").addEventListener("click", onFetch);
$("#browser-select").value = browserChoice;
$("#browser-select").addEventListener("change", () => {
  browserChoice = $("#browser-select").value;
  saveBrowserChoice();
});
$("#stop-btn").addEventListener("click", onStopFetch);
$("#resume-btn").addEventListener("click", onResumeFetch);
$("#open-dir-btn").addEventListener("click", onOpenDir);
$("#auth-done-btn").addEventListener("click", hideAuthBanner);
$("#auth-reload-btn").addEventListener("click", onAuthReload);
$("#auth-skip-btn").addEventListener("click", onSkipCurrent);
$("#export-list-btn").addEventListener("click", onExportList);
$("#import-btn").addEventListener("click", onImportList);
$("#undone-btn").addEventListener("click", onGenUndone);
$("#save-list-btn").addEventListener("click", onSaveList);
$("#import-path").addEventListener("keydown", (e) => {
  if (e.key === "Enter") onImportList();
});

// 设置变更自动保存（防抖），下次打开网站自动恢复
for (const id of SETTINGS_INPUT_IDS) {
  document.getElementById(id).addEventListener("input", scheduleSettingsSave);
}
$("#gen-info").addEventListener("change", scheduleSettingsSave);

loadSettings();

// 初始行的删除按钮
document.querySelectorAll("#url-rows .row-remove").forEach((btn) => {
  btn.addEventListener("click", () => {
    const rows = $("#url-rows");
    if (rows.children.length > 1) btn.closest(".url-row").remove();
    else btn.closest(".url-row").querySelector("input").value = "";
  });
});

updateSelectedSummary();
refreshManifestInfo();
