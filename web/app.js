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
    selectAll: false, // 整刊全选（不依赖卷目录是否已加载，生成清单时服务端补全检索）
    selectedVolumes: new Set(), // 整卷勾选
    selectedDois: new Set(), // 单篇勾选
    deselectedDois: new Set(), // 整卷/整刊勾选内被取消的单篇
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
  const data = await resp.json().catch(() => ({ error: t("err_api") }));
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
// 期刊网址输入区（多行 / 增行）
// ---------------------------------------------------------------------------

function addUrlRow(value = "") {
  const rows = $("#url-rows");
  const row = document.createElement("div");
  row.className = "url-row";
  row.innerHTML = `
    <input type="text" class="journal-url-input" value="${escapeHtml(value)}"
           placeholder="${escapeHtml(t("url_input_ph_short"))}" autocomplete="off" />
    <button type="button" class="secondary row-remove" title="${escapeHtml(t("remove_row"))}">×</button>
  `;
  row.querySelector(".row-remove").addEventListener("click", () => {
    if (rows.children.length > 1) row.remove();
    else row.querySelector("input").value = "";
  });
  rows.appendChild(row);
  return row;
}

/** 当前检索栏里的全部输入（去空；每行一个网址或 ISSN）。 */
function currentUrlValues() {
  return [...document.querySelectorAll("#url-rows .journal-url-input")]
    .map((i) => i.value.trim())
    .filter(Boolean);
}

/** 批量填充检索栏：追加不重复的行（保留用户已输入的内容）。 */
function appendUrlRows(values) {
  const existing = new Set(currentUrlValues().map((v) => v.toLowerCase()));
  let added = 0;
  for (const v of values) {
    const val = String(v || "").trim();
    if (!val || existing.has(val.toLowerCase())) continue;
    existing.add(val.toLowerCase());
    addUrlRow(val);
    added += 1;
  }
  return added;
}

// ---------------------------------------------------------------------------
// 期刊库：勾选导入检索栏 / 手动添加（联网搜索确认）/ 编辑地址 / 删除
// ---------------------------------------------------------------------------

const library = {
  journals: [], // 服务端 journal-library.json 的工作副本 {name, url, issn}
  selected: new Set(), // 勾选的条目下标
  editing: null, // 正在编辑的条目下标
};

async function saveLibrary() {
  const r = await api("/api/journal-library/save", { journals: library.journals });
  if (!r.ok) throw new Error(r.error || t("err_api"));
  library.journals = r.journals || library.journals;
  return r;
}

async function openLibrary() {
  $("#library-modal").classList.remove("hidden");
  $("#library-candidates").classList.add("hidden");
  $("#library-candidates").innerHTML = "";
  $("#library-add-input").value = "";
  $("#library-filter").value = "";
  library.selected.clear();
  library.editing = null;
  try {
    const r = await api("/api/journal-library", {});
    if (!r.ok) throw new Error(r.error || t("err_api"));
    library.journals = r.journals || [];
  } catch (err) {
    library.journals = [];
    $("#library-count").textContent = t("lib_load_fail", { msg: err.message });
  }
  renderLibraryList();
}

function closeLibrary() {
  $("#library-modal").classList.add("hidden");
}

function renderLibraryList() {
  const box = $("#library-list");
  box.innerHTML = "";
  const filter = $("#library-filter").value.trim().toLowerCase();
  const shown = [];
  library.journals.forEach((j, idx) => {
    const hay = `${j.name || ""} ${j.issn || ""} ${j.url || ""}`.toLowerCase();
    if (filter && !hay.includes(filter)) return;
    shown.push(idx);
    box.appendChild(renderLibraryRow(j, idx));
  });
  if (!shown.length) {
    box.innerHTML = `<p class="empty">${t("lib_empty")}</p>`;
  }
  const allChecked = shown.length > 0 && shown.every((i) => library.selected.has(i));
  $("#library-check-all").checked = allChecked;
  $("#library-count").textContent = t("lib_count", {
    n: library.journals.length,
    sel: library.selected.size,
  });
}

function renderLibraryRow(j, idx) {
  const row = document.createElement("div");
  row.className = "library-row";
  if (library.editing === idx) {
    row.classList.add("editing");
    row.innerHTML = `
      <input type="text" class="lib-edit-name" value="${escapeHtml(j.name || "")}"
             placeholder="${escapeHtml(t("lib_name_ph"))}" />
      <input type="text" class="lib-edit-url" value="${escapeHtml(j.url || "")}"
             placeholder="${escapeHtml(t("lib_url_ph"))}" />
      <span class="lib-issn">${escapeHtml(j.issn || "")}</span>
      <button type="button" class="secondary lib-save-btn" title="${escapeHtml(t("lib_save_edit"))}">✔</button>
      <button type="button" class="secondary lib-cancel-btn" title="${escapeHtml(t("lib_cancel_edit"))}">✕</button>
    `;
    row.querySelector(".lib-save-btn").addEventListener("click", () => onLibraryEditSave(row, idx));
    row.querySelector(".lib-cancel-btn").addEventListener("click", () => {
      library.editing = null;
      renderLibraryList();
    });
    return row;
  }
  row.innerHTML = `
    <input type="checkbox" class="lib-check" ${library.selected.has(idx) ? "checked" : ""} />
    <span class="lib-name" title="${escapeHtml(j.name || "")}">${escapeHtml(j.name || t("unknown_journal"))}</span>
    <span class="lib-url" title="${escapeHtml(j.url || "")}">${escapeHtml(j.url || t("lib_no_url"))}</span>
    <span class="lib-issn">${escapeHtml(j.issn || "")}</span>
    <button type="button" class="secondary lib-edit-btn" title="${escapeHtml(t("lib_edit_tip"))}">✎</button>
    <button type="button" class="secondary lib-del-btn" title="${escapeHtml(t("lib_del_tip"))}">✕</button>
  `;
  row.querySelector(".lib-check").addEventListener("change", (e) => {
    if (e.target.checked) library.selected.add(idx);
    else library.selected.delete(idx);
    renderLibraryList();
  });
  row.querySelector(".lib-edit-btn").addEventListener("click", () => {
    library.editing = idx;
    renderLibraryList();
  });
  row.querySelector(".lib-del-btn").addEventListener("click", async () => {
    library.journals.splice(idx, 1);
    library.selected.clear(); // 下标变化，重置勾选
    library.editing = null;
    try {
      await saveLibrary();
    } catch (err) {
      $("#library-count").textContent = t("lib_load_fail", { msg: err.message });
    }
    renderLibraryList();
  });
  return row;
}

/** 编辑保存：名称 / 地址更新后立即写库；地址变化时联网重新确认 ISSN（失败保留原值）。 */
async function onLibraryEditSave(row, idx) {
  const entry = library.journals[idx];
  const name = row.querySelector(".lib-edit-name").value.trim();
  const url = row.querySelector(".lib-edit-url").value.trim();
  const urlChanged = url !== (entry.url || "");
  entry.name = name;
  entry.url = url;
  library.editing = null;
  try {
    if (urlChanged && url) {
      const r = await api("/api/journal", { url });
      if (r.ok && r.journal) {
        entry.issn = r.journal.issn || entry.issn;
        if (!name) entry.name = r.journal.title || entry.name;
      }
    }
    await saveLibrary();
  } catch (err) {
    $("#library-count").textContent = t("lib_load_fail", { msg: err.message });
  }
  renderLibraryList();
}

/** 手动添加：输入期刊名称或网址 -> 联网搜索候选 -> 用户确认后加入期刊库。 */
async function onLibrarySearch() {
  const query = $("#library-add-input").value.trim();
  const box = $("#library-candidates");
  if (!query) {
    box.classList.remove("hidden");
    box.innerHTML = `<p class="empty">${t("lib_add_empty")}</p>`;
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = `<p class="empty">${t("lib_searching")}</p>`;
  try {
    const r = await api("/api/journal-library/search", { query });
    if (!r.ok) throw new Error(r.error || t("err_api"));
    const candidates = r.candidates || [];
    if (!candidates.length) {
      box.innerHTML = `<p class="empty">${t("lib_no_candidates", { msg: r.error || "" })}</p>`;
      return;
    }
    box.innerHTML = "";
    for (const c of candidates) {
      const item = document.createElement("div");
      item.className = "library-candidate";
      item.innerHTML = `
        <span class="lib-name" title="${escapeHtml(c.title || "")}">${escapeHtml(c.title || "")}</span>
        <span class="lib-issn">${escapeHtml(c.issn || "")}</span>
        <span class="lib-url" title="${escapeHtml(c.publisher || "")}">${escapeHtml(c.publisher || "")}</span>
        <button type="button" class="secondary" title="${escapeHtml(t("lib_add_tip"))}">＋ ${escapeHtml(t("lib_add"))}</button>
      `;
      item.querySelector("button").addEventListener("click", async () => {
        library.journals.push({ name: c.title || "", url: c.url || "", issn: c.issn || "" });
        item.remove();
        try {
          await saveLibrary();
        } catch (err) {
          $("#library-count").textContent = t("lib_load_fail", { msg: err.message });
        }
        renderLibraryList();
      });
      box.appendChild(item);
    }
  } catch (err) {
    box.innerHTML = `<p class="empty">${t("lib_search_fail", { msg: err.message })}</p>`;
  }
}

/** 导入所选期刊地址至文献检索栏（优先网址，无网址时用 ISSN）。 */
function onLibraryImport() {
  const values = [];
  for (const idx of [...library.selected].sort((a, b) => a - b)) {
    const j = library.journals[idx];
    if (!j) continue;
    values.push(j.url || j.issn || j.name);
  }
  const added = appendUrlRows(values);
  closeLibrary();
  $("#journal-msg").textContent = t("lib_imported", { n: added });
}

async function onSearchAll() {
  const urls = currentUrlValues();
  if (!urls.length) return;

  const btn = $("#search-all-btn");
  btn.disabled = true;
  const msg = $("#journal-msg");
  for (const [i, url] of urls.entries()) {
    btn.textContent = t("resolving", { i: i + 1, n: urls.length });
    try {
      const r = await api("/api/journal", { url });
      if (!r.ok) throw new Error(r.error || t("parse_fail"));
      if (!getJournal(r.journal.issn)) {
        state.journals.push(newJournalState(r.journal));
      }
    } catch (err) {
      msg.textContent = t("parse_fail_for", { url, msg: err.message });
    }
  }
  btn.disabled = false;
  btn.textContent = t("search_journals");
  $("#browse-area").classList.toggle("hidden", !state.journals.length);
  renderTree();
  updateSelectedSummary(); // 新期刊未勾选：总“全选”与已选数量需要随之刷新
}

// ---------------------------------------------------------------------------
// 选择计数与整刊全选
// ---------------------------------------------------------------------------

/** 某卷内已选文献数 */
function volumeSelectedCount(j, vol) {
  if (j.selectAll || j.selectedVolumes.has(vol.key)) {
    const works = j.volumeWorks.get(vol.key) || [];
    const deselected = works.filter((w) => j.deselectedDois.has(w.doi)).length;
    return vol.count - deselected;
  }
  const works = j.volumeWorks.get(vol.key) || [];
  return works.filter((w) => j.selectedDois.has(w.doi)).length;
}

/** 某期刊已选文献数。整刊全选时：卷目录已完整则按卷合计，否则以期刊总数计
 *  （生成清单时服务端会补全检索整本期刊，总数即最终数量）。 */
function journalSelectedCount(j) {
  if (j.selectAll) {
    const total = j.scan.done
      ? j.volumes.reduce((sum, vol) => sum + vol.count, 0)
      : journalTotal(j);
    return Math.max(0, total - j.deselectedDois.size);
  }
  return j.volumes.reduce((sum, vol) => sum + volumeSelectedCount(j, vol), 0);
}

function journalTotal(j) {
  return j.scan.total || j.totalResults || 0;
}

function isArticleChecked(j, volKey, doi) {
  if (j.selectAll || j.selectedVolumes.has(volKey)) return !j.deselectedDois.has(doi);
  return j.selectedDois.has(doi);
}

/** 期刊节点勾选框是否应显示为选中（整刊全选或全部已加载卷均被勾选）。 */
function journalFullySelected(j) {
  return (
    j.selectAll ||
    (j.volumes.length > 0 && j.volumes.every((v) => j.selectedVolumes.has(v.key)))
  );
}

/** 整刊全选：与卷目录加载进度无关，立即生效。 */
function selectAllJournal(j) {
  j.selectAll = true;
  j.volumes.forEach((v) => j.selectedVolumes.add(v.key));
  j.deselectedDois.clear();
}

/** 取消整刊选择：清空该期刊所有选择状态。 */
function clearJournalSelection(j) {
  j.selectAll = false;
  j.selectedVolumes.clear();
  j.selectedDois.clear();
  j.deselectedDois.clear();
}

function totalSelectedCount() {
  return state.journals.reduce((sum, j) => sum + journalSelectedCount(j), 0);
}

function updateSelectedSummary() {
  const n = totalSelectedCount();
  $("#selected-summary").textContent = t("selected_count", { n });
  $("#save-manifest-btn").disabled = n === 0;
  $("#select-all-journals").checked =
    state.journals.length > 0 && state.journals.every(journalFullySelected);
}

/** 清单栏“全选”：把当前检索到的所有期刊整体勾选 / 取消。 */
function onSelectAllJournals(e) {
  for (const j of state.journals) {
    if (e.target.checked) selectAllJournal(j);
    else clearJournalSelection(j);
  }
  renderTree();
  updateSelectedSummary();
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
    const checked = journalFullySelected(j);
    const head = document.createElement("div");
    head.className = "tree-node root";
    let countText = t("count_pcs", { sel, total: journalTotal(j) });
    if (j.scan.done) countText += t("root_volumes_suffix", { n: j.volumes.length });
    else if (j.scan.loaded) countText += t("root_scanned_suffix", { n: j.scan.loaded });
    head.innerHTML = `
      <span class="caret">${j.expanded ? "▾" : "▸"}</span>
      <input type="checkbox" class="journal-check" ${checked ? "checked" : ""} />
      <span class="root-title" title="${escapeHtml(t("root_title_tip"))}">${escapeHtml(j.title)}</span>
      <span class="count">${countText}</span>
    `;
    jEl.appendChild(head);

    head.querySelector(".caret").addEventListener("click", () => toggleJournal(j));
    head.querySelector(".root-title").addEventListener("click", () => toggleJournal(j));
    head.querySelector(".journal-check").addEventListener("change", (e) => {
      // 整刊全选与卷目录加载进度无关：勾选立即生效，生成清单时服务端再补全检索
      if (e.target.checked) selectAllJournal(j);
      else clearJournalSelection(j);
      renderTree();
      updateSelectedSummary();
    });

    if (j.expanded) {
      const body = document.createElement("div");
      body.className = "tree-children";

      if (!j.volumesLoaded) {
        body.innerHTML = '<p class="empty">' + t("vol_loading") + "</p>";
      } else {
        for (const vol of j.volumes) {
          body.appendChild(renderVolumeNode(j, vol));
        }
        const status = document.createElement("div");
        status.className = "load-bar";
        if (j.scan.done) {
          status.innerHTML = `<span class="hint">${t("scan_done_bar", { n: j.volumes.length, m: j.scan.loaded })}</span>`;
        } else if (j.loading) {
          status.innerHTML = `<span class="hint">${t("scan_progress_bar", { loaded: j.scan.loaded, total: j.scan.total })}</span>`;
        } else {
          // 卷目录尚未完整：不再后台静默补全（避免检索重绘打断勾选），
          // 补全检索推迟到点击“生成下载清单”时进行，也可点按钮立即补全
          status.innerHTML = `
            <span class="hint">${t("vol_partial_bar", { loaded: j.scan.loaded, total: j.scan.total })}</span>
            <button type="button" class="secondary scan-more-btn">${t("scan_more")}</button>
          `;
          status.querySelector(".scan-more-btn").addEventListener("click", () => scanVolumesToDone(j));
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
  const allChecked = j.selectAll || j.selectedVolumes.has(vol.key) ||
    (volWorks.length > 0 && volWorks.every((w) => j.selectedDois.has(w.doi)));

  const head = document.createElement("div");
  head.className = "tree-node vol";
  head.innerHTML = `
    <span class="caret">${isOpen ? "▾" : "▸"}</span>
    <input type="checkbox" class="vol-check" ${allChecked ? "checked" : ""} />
    <span class="vol-label" title="${escapeHtml(t("vol_label_tip"))}">${escapeHtml(vol.label)}</span>
    <span class="count">${t("count_pcs", { sel: selCount, total: vol.count })}</span>
  `;
  el.appendChild(head);

  head.querySelector(".caret").addEventListener("click", () => toggleVolume(j, vol));
  head.querySelector(".vol-label").addEventListener("click", () => toggleVolume(j, vol));
  head.querySelector(".vol-check").addEventListener("change", (e) => {
    if (e.target.checked) {
      j.selectedVolumes.add(vol.key);
      // 清除该卷内的单篇例外
      for (const w of volWorks) j.deselectedDois.delete(w.doi);
    } else if (j.selectAll) {
      // 整刊全选下取消某一卷：转为逐卷勾选模式，保留其余已加载卷与单篇例外
      j.selectAll = false;
      j.volumes.forEach((v) => j.selectedVolumes.add(v.key));
      j.selectedVolumes.delete(vol.key);
      for (const w of volWorks) j.selectedDois.delete(w.doi);
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
      children.innerHTML = '<p class="empty">' + t("works_loading") + "</p>";
    } else {
      for (const work of volWorks) {
        children.appendChild(renderArticleNode(j, vol.key, work));
      }
      if (!j.scan.done) {
        const note = document.createElement("p");
        note.className = "empty";
        note.textContent = t("vol_incomplete");
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
    if (j.selectAll || j.selectedVolumes.has(volKey)) {
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

/** 点击期刊名：展开其卷目录（只取一页，不做后台全刊检索），同时关闭其他期刊的展开状态。
 *  完整检索属于“可移动的检索工作”，推迟到点击“生成下载清单”时进行；
 *  需要提前浏览全部卷时，可点卷目录下方的“检索全部卷”。 */
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
  await loadVolumesOnce(j);
}

/** 展开期刊时只加载一页卷目录（或已有缓存），避免整刊后台检索反复重绘打断勾选。 */
async function loadVolumesOnce(j) {
  if (j.loading || j.volumesLoaded) return;
  j.loading = true;
  renderTree();
  try {
    const r = await api("/api/volumes", { issn: j.issn, more: false });
    if (!r.ok) throw new Error(r.error || t("vol_load_fail"));
    j.volumes = r.volumes;
    j.volumesLoaded = true;
    j.scan = r.scan;
  } catch (err) {
    $("#journal-msg").textContent = t("vol_load_fail_for", { t: j.title, msg: err.message });
  } finally {
    j.loading = false;
    renderTree();
    updateSelectedSummary();
  }
}

/** 逐页检索期刊文献直到卷目录完整（用户点“检索全部卷”或生成清单前的补全时调用）。
 *  卷一级只汇总数量，不加载具体文献；再次点击期刊名收起可暂停。 */
async function scanVolumesToDone(j) {
  if (j.loading) return;
  j.loading = true;
  renderTree();
  try {
    do {
      const r = await api("/api/volumes", { issn: j.issn, more: j.volumesLoaded });
      if (!r.ok) throw new Error(r.error || t("vol_load_fail"));
      j.volumes = r.volumes;
      j.volumesLoaded = true;
      j.scan = r.scan;
      renderTree();
    } while (j.expanded && !j.scan.done);
  } catch (err) {
    $("#journal-msg").textContent = t("vol_load_fail_for", { t: j.title, msg: err.message });
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
      if (!r.ok) throw new Error(r.error || t("works_load_fail"));
      j.volumeWorks.set(vol.key, r.works);
      vol.count = r.works.length;
    } catch (err) {
      $("#journal-msg").textContent = t("works_load_fail_for", { t: vol.label, msg: err.message });
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
    pane.innerHTML = '<p class="empty">' + t("detail_empty") + "</p>";
    return;
  }
  const j = getJournal(state.detail.issn);
  const work = state.detail.work;
  const volKey = work.volume ? "v:" + work.volume : work.issue ? "i:" + work.issue : "none";
  const checked = j ? isArticleChecked(j, volKey, work.doi) : false;
  pane.innerHTML = `
    <h3>${escapeHtml(work.title || work.doi)}</h3>
    <dl>
      <dt>${t("dt_date")}</dt><dd>${escapeHtml(work.date || t("unknown"))}</dd>
      <dt>${t("dt_authors")}</dt><dd>${escapeHtml((work.authors || []).join(", ") || t("unknown"))}</dd>
      <dt>DOI</dt><dd>${escapeHtml(work.doi || t("none"))}</dd>
      <dt>${t("dt_journal")}</dt><dd>${escapeHtml((j && j.title) || work.journal || "")}</dd>
      <dt>${t("dt_vol_issue")}</dt><dd>${escapeHtml([work.volume && t("vol_n", { n: work.volume }), work.issue && t("issue_n", { n: work.issue })].filter(Boolean).join(" / ") || t("none"))}</dd>
      <dt>${t("dt_link")}</dt><dd><a href="${escapeHtml(work.url || "https://doi.org/" + work.doi)}" target="_blank" rel="noopener">${escapeHtml(work.url || "https://doi.org/" + work.doi)}</a></dd>
    </dl>
    <label class="detail-check">
      <input type="checkbox" id="detail-check" ${checked ? "checked" : ""} /> ${t("add_to_manifest")}
    </label>
  `;
  $("#detail-check").addEventListener("change", (e) => {
    if (!j) return;
    if (j.selectAll || j.selectedVolumes.has(volKey)) {
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
    // 整刊全选：发送 all 标记与被取消的单篇，由服务端补全检索后全量展开
    if (j.selectAll) {
      selections.push({
        issn: j.issn,
        journal: j.title,
        all: true,
        excludeDois: [...j.deselectedDois],
      });
      continue;
    }
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
        msg.textContent = t("manifest_preparing", { t: j.title, loaded: j.scan.loaded, total: j.scan.total });
        const r = await api("/api/volumes", { issn: j.issn, more: true });
        if (!r.ok) throw new Error(r.error || t("retrieve_fail"));
        j.volumes = r.volumes;
        j.volumesLoaded = true;
        j.scan = r.scan;
      }
      msg.textContent = t("manifest_prepared", { t: j.title, n: j.scan.loaded });
    }
    msg.textContent = t("manifest_generating");
    const r = await api("/api/manifest/save", { selections });
    if (!r.ok) throw new Error(r.error || t("save_failed"));
    msg.textContent = t("manifest_cached", {
      n: r.count,
      f: (r.files || []).length,
      names: (r.files || []).map((x) => x.journal).join(t("journal_sep")),
    });
    await refreshManifestInfo();
  } catch (err) {
    msg.textContent = t("save_fail_prefix") + err.message;
  } finally {
    updateSelectedSummary();
  }
}

// ---------------------------------------------------------------------------
// 模块二：扫盘与下载
// ---------------------------------------------------------------------------

// 下载方式：仅浏览器自动化（真实浏览器打开出版商页面、自动通过人机验证并下载 PDF）
// 浏览器选择（localStorage 持久化；默认 Chrome，auto = 依次尝试本机 Chrome / Edge / 内置 Chromium）
// 说明：Playwright 版 Firefox 极易被 Cloudflare 识别为自动化浏览器导致验证无法通过，
// 默认使用本机 Chrome（真实浏览器内核 + 反检测脚本），Chromium 系反检测效果最好
const BROWSER_CHOICES = ["chrome", "auto", "edge", "firefox", "safari"];

function loadBrowserChoice() {
  try {
    const saved = localStorage.getItem("pdl-browser-v2");
    if (BROWSER_CHOICES.includes(saved)) return saved;
  } catch { /* 忽略坏数据 */ }
  return "chrome"; // 默认 Chrome（真实内核，Chromium 系反检测效果最好）
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
      detail.textContent = t("ba_status") + st.message;
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
    if (!r.ok) $("#auth-banner-text").textContent = r.error || t("reload_failed");
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
    box.innerHTML = '<span class="hint">' + t("no_manifest") + "</span>";
    return;
  }
  const names = (manifest.journals || []).join(t("journal_sep")) || t("unknown_journal");
  const updatedText = manifest.updatedAt ? new Date(manifest.updatedAt).toLocaleString() : "";
  const source = manifest.source === "undone" ? t("from_undone") : "";
  const paths = (r.ok && Array.isArray(r.paths) && r.paths) || [];
  const fileList = paths
    .map((p) => String(p).split(/[\\/]/).pop())
    .join("、");
  const filesPart = fileList ? t("files_label", { n: paths.length, names: fileList }) : "";
  box.classList.remove("hidden");
  box.innerHTML =
    `${t("active_list_label")}<b>${escapeHtml(names)}</b>${t("list_count_part", { n: manifest.items.length })}${t("generated_at", { t: escapeHtml(updatedText) })}${source}${filesPart}`;
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

/** 通过浏览器逐份下载已保存的清单文件（内容从服务端按路径读取） */
async function downloadJsonFiles(files) {
  for (const f of files) {
    try {
      const r = await api("/api/list/file", { path: f.path });
      if (!r.ok) continue;
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = String(f.path || t("list_default_filename")).split(/[\\/]/).pop();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      await sleep(300); // 间隔触发，避免浏览器拦截多文件下载
    } catch {
      /* 单份失败不影响其余 */
    }
  }
}

/** 板块一：按期刊把当前任务清单保存为文件（每刊一份，同名覆盖），并通过浏览器下载 */
async function onExportList() {
  const btn = $("#export-list-btn");
  const msg = $("#manifest-msg");
  btn.disabled = true;
  try {
    const r = await api("/api/list/save", {});
    if (!r.ok) throw new Error(r.error || t("save_failed"));
    downloadJsonFiles(r.files || []);
    const names = (r.files || []).map((f) => String(f.path).split(/[\\/]/).pop()).join("、");
    msg.textContent = t("export_ok", { n: r.count, p: names });
  } catch (err) {
    msg.textContent = t("export_fail") + err.message;
  } finally {
    btn.disabled = false;
    refreshManifestInfo();
  }
}

/** 板块二：把当前待执行的任务清单按期刊分别保存为文件（任务清单-期刊名.json，同名覆盖） */
async function onSaveList() {
  const btn = $("#save-list-btn");
  btn.disabled = true;
  try {
    const r = await api("/api/list/save", {});
    if (!r.ok) throw new Error(r.error || t("save_failed"));
    const names = (r.files || []).map((f) => String(f.path).split(/[\\/]/).pop()).join("、");
    $("#list-msg").textContent = t("save_list_ok", { n: r.count, p: names });
    refreshManifestInfo();
  } catch (err) {
    $("#list-msg").textContent = t("export_fail") + err.message;
  } finally {
    btn.disabled = false;
  }
}

/** 导入成功后的公共处理：清空下载状态、刷新清单信息并重新扫盘 */
async function afterImportLists(r) {
  const names = (r.lists || []).map((l) => String(l.path).split(/[\\/]/).pop()).join("、");
  $("#list-msg").textContent = t("import_ok", { n: r.count, p: names });
  // 回填绝对路径便于核对；text 输入框会剥掉换行符，用分号分隔（可再次直接导入）
  $("#import-path").value = (r.lists || []).map((l) => l.path).join("；");
  resetScanState();
  await refreshManifestInfo();
  await onScan();
}

/** 板块二：导入任务清单（单一入口）。
 *  输入框有路径时按路径导入一份或多份（逗号 / 分号 / 换行分隔）；
 *  输入框为空时点击按钮直接打开文件选择器，一次选多份批量导入。
 *  导入后合并设为当前待执行清单并重新扫盘。 */
async function onImportList() {
  const paths = $("#import-path").value
    .split(/[\n;；,，]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paths.length) {
    $("#import-file-input").click(); // 没有输入路径：打开文件选择器批量导入
    return;
  }
  const btn = $("#import-btn");
  btn.disabled = true;
  try {
    const r = await api("/api/list/import", { paths });
    if (!r.ok) throw new Error(r.error || t("import_failed"));
    await afterImportLists(r);
  } catch (err) {
    $("#list-msg").textContent = t("import_fail") + err.message;
  } finally {
    btn.disabled = false;
  }
}

/** 文件选择器返回后：读取所选清单内容批量上传导入（服务端按期刊落盘并激活） */
async function onPickListFiles() {
  const input = $("#import-file-input");
  const files = [...(input.files || [])];
  input.value = ""; // 允许再次选择同一批文件
  if (!files.length) return;
  $("#list-msg").textContent = t("import_reading", { n: files.length });
  try {
    const uploaded = await Promise.all(
      files.map(
        (f) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ name: f.name, content: String(reader.result || "") });
            reader.onerror = () => reject(new Error(f.name));
            reader.readAsText(f, "utf8");
          })
      )
    );
    const r = await api("/api/list/import", { files: uploaded });
    if (!r.ok) throw new Error(r.error || t("import_failed"));
    await afterImportLists(r);
  } catch (err) {
    $("#list-msg").textContent = t("import_fail") + err.message;
  }
}

/** 板块二：按扫盘结果按期刊分别生成“未下载清单”，并自动切换为当前待执行清单 */
async function onGenUndone() {
  const root = $("#local-root").value.trim();
  if (!root) {
    $("#list-msg").textContent = t("root_empty");
    return;
  }
  const btn = $("#undone-btn");
  btn.disabled = true;
  try {
    const r = await api("/api/list/undone", { root });
    if (!r.ok) throw new Error(r.error || t("gen_failed"));
    if (r.count === 0) {
      $("#list-msg").textContent = r.message || t("all_downloaded");
      return;
    }
    const names = (r.files || []).map((f) => String(f.path).split(/[\\/]/).pop()).join("、");
    $("#list-msg").textContent =
      t("undone_ok", { missing: r.count, exists: r.exists, p: names });
    resetScanState();
    await refreshManifestInfo();
    await onScan(); // 用新清单重新扫盘，界面即切换为未下载任务
  } catch (err) {
    $("#list-msg").textContent = t("undone_fail") + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function onScan() {
  const root = $("#local-root").value.trim();
  if (!root) return;
  const btn = $("#scan-btn");
  btn.disabled = true;
  btn.textContent = t("scanning");
  try {
    const r = await api("/api/scan", { root });
    if (!r.ok) throw new Error(r.error || t("scan_failed"));
    scanResult = r;
    dlSession = null;
    setDownloadButtons("idle");
    renderScanList();
    let summary =
      r.total === 0
        ? t("manifest_empty")
        : t("scan_summary", { n: r.total, e: r.exists, m: r.missing });
    if (r.noAccessMarked > 0) summary += t("scan_denied_suffix", { n: r.noAccessMarked });
    $("#scan-summary").textContent = summary;
    $("#fetch-btn").disabled = r.missing === 0;
    $("#undone-btn").disabled = r.total === 0; // 扫盘后可按缺失条目生成未下载清单
    $("#open-dir-btn").disabled = false;
  } catch (err) {
    $("#scan-summary").textContent = t("scan_fail_prefix") + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = t("scan_local");
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
      ? `<span class="status ok">${t("st_exists")}</span>`
      : `<span class="status pending">${t("st_missing")}</span>`;
    // 文件在磁盘上（含 PDF 异常的条目）才报告信息文件状态
    const txtNote =
      entry.pdfExists || entry.pdfInvalid
        ? entry.txtExists
          ? t("with_txt")
          : t("without_txt")
      : "";
    // PDF 文件异常（残缺 / HTML 错误页等）：已按不存在处理，提示会重新下载
    const invalidNote = entry.pdfInvalid ? t("pdf_invalid_note") : "";
    // 缺失且权限记录两条路径（官方网页 / Sci-Hub）均标记为“无”的条目：
    // 下载前扫描（始终开启）会直接跳过
    const accessNote =
      !entry.pdfExists && entry.accessSkip ? t("access_denied_note") : "";
    li.innerHTML = `
      ${status}
      <span class="dl-title">${escapeHtml(entry.title || entry.doi)}</span>
      <span class="dl-detail">${escapeHtml(entry.rel + "/" + entry.stem + ".pdf")} ${txtNote}${escapeHtml(invalidNote)}${escapeHtml(accessNote)}</span>
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
    noAccess: 0, // 出版商明确无访问权限（付费墙）的篇数：单独计数，不算失败
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
    if (li) li.querySelector(".status").outerHTML = `<span class="status pending">${t("st_downloading")}</span>`;
    $("#scan-summary").textContent =
      t("downloading_n", { i: s.idx + 1, n: s.entries.length, ok: s.ok, fail: s.fail, na: s.noAccess });
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
      });
      stopStatusPolling();
      if (r.ok) {
        s.ok += 1;
        if (li) {
          li.querySelector(".status").outerHTML = `<span class="status ok">${t("st_ok")}</span>`;
          li.querySelector(".dl-detail").textContent =
            t("ba_prefix") + r.path + (r.info_path ? t("info_file_suffix", { p: r.info_path }) : "");
        }
      } else {
        if (s.stopped) break; // 停止导致的错误不计入失败
        if (r.no_access) {
          // 出版商明确返回无访问权限（付费墙）：立即跳过该篇，不计入失败
          s.noAccess += 1;
          if (li) {
            li.querySelector(".status").outerHTML = `<span class="status noaccess">${t("st_no_access")}</span>`;
            li.querySelector(".dl-detail").textContent = r.error || t("no_access_default");
          }
        } else {
          s.fail += 1;
          if (li) {
            li.querySelector(".status").outerHTML = `<span class="status fail">${t("st_fail")}</span>`;
            li.querySelector(".dl-detail").textContent = r.error || t("unknown_error");
          }
        }
      }
    } catch (err) {
      stopStatusPolling();
      if (s.stopped) break;
      s.fail += 1;
      if (li) {
        li.querySelector(".status").outerHTML = `<span class="status fail">${t("st_fail")}</span>`;
          li.querySelector(".dl-detail").textContent =
            t("net_error") + err.message;
      }
    }
    // 任务间隔：防止请求过密被网站判定为恶意行为
    if (opts.intervalSec > 0 && s.idx < s.entries.length - 1 && !s.stopped) {
      $("#scan-summary").textContent =
        t("interval_wait", { s: opts.intervalSec, done: s.ok + s.fail, n: s.entries.length });
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
      li.querySelector(".status").outerHTML = `<span class="status pending">${t("st_paused")}</span>`;
    }
    $("#scan-summary").textContent =
      t("stopped_summary", { done: s.ok + s.fail, n: s.entries.length });
    setDownloadButtons("stopped");
  } else {
    $("#scan-summary").textContent =
      t("done_summary", { ok: s.ok, fail: s.fail, na: s.noAccess, skip: scanResult.exists });
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
  $("#scan-summary").textContent = t("refreshed");
  $("#fetch-btn").disabled = true;
  setDownloadButtons("idle");
  refreshManifestInfo();
  await onScan();
}

async function onStopFetch() {
  if (!dlSession || dlSession.stopped) return;
  dlSession.stopped = true;
  $("#scan-summary").textContent = t("stopping");
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
    if (!r.ok) $("#scan-summary").textContent = r.error || t("open_dir_failed");
  } catch (err) {
    $("#scan-summary").textContent = t("open_dir_fail") + err.message;
  }
}

// ---------------------------------------------------------------------------
// 事件绑定与初始化
// ---------------------------------------------------------------------------

$("#add-url-btn").addEventListener("click", () => addUrlRow());
$("#search-all-btn").addEventListener("click", onSearchAll);
$("#save-manifest-btn").addEventListener("click", saveManifest);
$("#select-all-journals").addEventListener("change", onSelectAllJournals);
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
$("#import-file-input").addEventListener("change", onPickListFiles);
$("#undone-btn").addEventListener("click", onGenUndone);
$("#save-list-btn").addEventListener("click", onSaveList);
$("#import-path").addEventListener("keydown", (e) => {
  if (e.key === "Enter") onImportList();
});

// 期刊库弹窗
$("#library-btn").addEventListener("click", openLibrary);
$("#library-close-btn").addEventListener("click", closeLibrary);
$("#library-modal").addEventListener("click", (e) => {
  if (e.target === $("#library-modal")) closeLibrary(); // 点遮罩关闭
});
$("#library-search-btn").addEventListener("click", onLibrarySearch);
$("#library-add-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") onLibrarySearch();
});
$("#library-filter").addEventListener("input", renderLibraryList);
$("#library-check-all").addEventListener("change", (e) => {
  const filter = $("#library-filter").value.trim().toLowerCase();
  library.journals.forEach((j, idx) => {
    const hay = `${j.name || ""} ${j.issn || ""} ${j.url || ""}`.toLowerCase();
    if (filter && !hay.includes(filter)) return;
    if (e.target.checked) library.selected.add(idx);
    else library.selected.delete(idx);
  });
  renderLibraryList();
});
$("#library-import-btn").addEventListener("click", onLibraryImport);

// 设置变更自动保存（防抖），下次打开网站自动恢复
for (const id of SETTINGS_INPUT_IDS) {
  document.getElementById(id).addEventListener("input", scheduleSettingsSave);
}

// ---------------------------------------------------------------------------
// 语言切换（中文 / English）：词典与 t() 在 i18n.js，切换后重绘动态内容
// ---------------------------------------------------------------------------

$("#lang-select").value = currentLang();

function applyLanguage() {
  applyI18n();
  updateSelectedSummary();
  renderTree();
  renderDetail();
  refreshManifestInfo();
  if (scanResult) renderScanList();
  const scanBtn = $("#scan-btn");
  if (scanBtn.disabled) scanBtn.textContent = t("scanning"); // 扫盘进行中保持“扫描中…”
}

$("#lang-select").addEventListener("change", (e) => {
  setLang(e.target.value);
  applyLanguage();
});

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
