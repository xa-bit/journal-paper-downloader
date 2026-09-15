"use strict";

/**
 * 期刊文献下载器 - 界面多语言（中文 / English）
 *
 * - 静态文案：HTML 元素带 data-i18n（textContent）/ data-i18n-title（title 属性）/
 *   data-i18n-placeholder（placeholder 属性）/ data-i18n-html（含 <code> 等标记的富文本），
 *   applyI18n() 按当前语言填充；
 * - 动态文案：app.js 通过 t(key, vars) 取词，vars 以 {name} 形式填入；
 * - 语言偏好保存在 localStorage（pdl-lang），未保存过时跟随浏览器语言，无法识别则用中文。
 */

const I18N = {
  zh: {
    app_title: "期刊文献下载器",
    app_heading: "📄 期刊文献下载器",
    subtitle: "输入期刊网址检索文献，生成下载清单，扫盘后通过浏览器自动化批量下载 PDF",

    // 模块一：文献检索
    search_title: "文献检索",
    url_input_ph:
      "期刊网址，如 https://agupubs.onlinelibrary.wiley.com/journal/19448007 或 https://www.nature.com/ngeo/",
    url_input_ph_short: "期刊网址，如 https://www.nature.com/ngeo/",
    remove_row: "删除该行",
    add_url: "＋ 增加期刊网址",
    split_urls: "⇱ 分离多网址行",
    search_journals: "检索期刊",
    multi_url_hint:
      "支持一次输入多个期刊；单行内粘贴多个网址（空格 / 逗号 / 换行分隔）后点“分离多网址行”可自动拆成多行。",
    detail_empty: "点击文章标题，在此查看详情。",
    save_manifest: "生成下载清单",
    export_list: "保存任务清单",
    export_list_tip:
      "把当前任务清单保存为文件（任务清单-期刊名.json，重名自动加序号），并通过浏览器下载",

    // 模块二：扫盘与下载
    scan_title: "扫盘与下载",
    local_root: "本地目录",
    local_root_hint_html:
      "下载将在本地目录下按 <code>期刊名/出版卷/文章名/</code> 逐级生成子文件夹；PDF 以 DOI 尾缀命名（如 <code>2025JC023188.pdf</code>），并同时生成同名 <code>.txt</code> 信息文件（标题、日期、作者、DOI 等）。",
    browser_label: "浏览器选择（下载由浏览器自动化完成，按所选浏览器启动）",
    opt_edge: "Edge（默认，通过反爬验证率最高）",
    opt_auto: "自动（优先本机 Chrome / Edge / 内置 Chromium）",
    opt_firefox: "Firefox（易被 Cloudflare 识别，不推荐）",
    opt_safari: "Safari（WebKit 引擎）",
    browser_hint_html:
      "Firefox / Safari 由 Playwright 的 Firefox / WebKit 引擎驱动，未安装时先执行 <code>python -m playwright install firefox</code> 或 <code>python -m playwright install webkit</code>。",
    wait_min: "每页等待时间（分钟）",
    max_refresh: "无响应最大刷新次数",
    verify_interval: "验证点击间隔（秒）",
    verify_max_fails: "验证失败几次后刷新",
    task_interval: "任务间隔（秒）",
    gen_info: "生成信息文件",
    auto_hint:
      "浏览器自动化会打开真实浏览器窗口：等待时间内无下载响应会自动刷新（超过刷新次数后跳过该篇）；遇到人机验证时每“验证点击间隔”秒自动模拟点击一次验证，连续“验证失败几次后刷新”次未通过会刷新页面重新验证（这些时间都算在每页等待时间内）；遇到登录身份验证时页面保持打开，等待你在浏览器中手动处理后自动继续。",
    import_ph:
      "输入任务清单文件路径后导入，如 /mnt/d/paper/任务清单-Nature.json（相对路径按网站根目录解析）",
    import_list: "导入任务清单",
    import_list_tip: "按路径载入任务清单，并设为当前待执行清单",
    gen_undone: "生成未下载清单",
    gen_undone_tip:
      "按本地目录扫盘结果，把当前清单里未下载的条目生成为新的任务清单并自动切换使用",
    save_list_tip: "把当前待执行的任务清单保存为文件（任务清单-期刊名.json，重名自动加序号）",
    list_persist_hint:
      "网站打开时自动使用上次任务所用清单；在上方“文献检索”生成清单、此处导入清单或生成未下载清单后，当前待执行清单会自动切换并持久化（清单内显示文件路径）。",
    scan_local: "扫描本地目录",
    refresh: "⟳ 刷新",
    refresh_tip: "保留当前设置（保存目录等），重置下载状态并重新扫盘",
    fetch_missing: "下载缺失文件",
    stop_download: "停止下载",
    resume_download: "继续下载",
    open_dir: "打开本地目录",

    // 页脚 / 人工干预横幅
    footer_note: "浏览器自动化只在出版商页面模拟正常的人工下载操作，不会绕过付费墙或验证机制。",
    auth_done: "我已完成验证，继续等待",
    auth_reload: "刷新验证页",
    auth_reload_tip: "验证页卡死/循环时刷新页面重试",
    auth_skip: "跳过此篇",

    // 树形目录
    root_title_tip: "点击展开/收起卷目录",
    vol_label_tip: "点击加载/收起该卷文献",
    count_pcs: "{sel} / {total} 篇",
    root_volumes_suffix: "，共 {n} 卷",
    root_scanned_suffix: "（已扫描 {n}）",
    vol_loading: "卷目录加载中…",
    works_loading: "文献加载中…",
    scan_done_bar: "共 {n} 卷，已扫描 {m} 篇文献",
    scan_progress_bar: "卷目录检索中：已扫描 {loaded} / 约 {total} 篇（再点击期刊名可收起并暂停）",
    vol_incomplete: "期刊卷目录仍在检索中，该卷文献可能不全（稍候自动补全）。",

    // 详情面板
    dt_date: "日期",
    dt_authors: "作者",
    dt_journal: "期刊",
    dt_vol_issue: "卷 / 期",
    dt_link: "链接",
    unknown: "未知",
    none: "无",
    vol_n: "Volume {n}",
    issue_n: "Issue {n}",
    add_to_manifest: "加入下载清单",

    // 动态消息
    err_api: "服务器返回异常",
    resolving: "解析中 {i}/{n}…",
    parse_fail: "解析失败",
    parse_fail_for: "「{url}」解析失败：{msg}",
    selected_count: "已选 {n} 篇",
    vol_load_fail: "卷目录加载失败",
    vol_load_fail_for: "「{t}」卷目录加载失败：{msg}",
    works_load_fail: "文献加载失败",
    works_load_fail_for: "「{t}」文献加载失败：{msg}",
    manifest_preparing: "清单准备中：《{t}》文献检索 {loaded} / 约 {total} 篇…",
    retrieve_fail: "文献检索失败",
    manifest_prepared: "清单准备中：《{t}》已完整检索（{n} 篇），正在汇总…",
    manifest_generating: "正在生成清单…",
    save_failed: "保存失败",
    manifest_cached: "✔ 清单已缓存（{n} 篇），请到下方“扫盘与下载”模块操作。",
    save_fail_prefix: "保存失败：",
    no_manifest: "当前没有任务清单，请先生成或导入。",
    journal_sep: "、",
    unknown_journal: "未知期刊",
    active_list_label: "当前待执行任务清单：",
    list_count_part: " ｜ {n} 篇",
    generated_at: " ｜ 生成于 {t}",
    from_undone: " ｜ 来源：未下载清单",
    file_label: " ｜ 文件: ",
    list_default_filename: "任务清单.json",
    read_manifest_fail: "读取清单失败",
    export_ok: "✔ 任务清单已保存（{n} 篇）：{p}，并已通过浏览器下载",
    export_fail: "保存任务清单失败：",
    save_list_ok: "✔ 当前任务清单已保存（{n} 篇）：{p}",
    import_path_empty: "请先输入任务清单文件路径",
    import_failed: "导入失败",
    import_ok: "✔ 已导入任务清单（{n} 篇）并设为当前清单：{p}",
    import_fail: "导入任务清单失败：",
    root_empty: "请先填写本地目录",
    gen_failed: "生成失败",
    all_downloaded: "清单内文献均已下载，未下载清单为空",
    undone_ok: "✔ 未下载清单已生成并设为当前任务清单（缺失 {missing} 篇，已下载 {exists} 篇）：{p}",
    undone_fail: "生成未下载清单失败：",
    scanning: "扫描中…",
    scan_failed: "扫描失败",
    manifest_empty: "清单为空，请先生成下载清单",
    scan_summary: "清单 {n} 篇：已存在 {e} 篇，缺失 {m} 篇",
    scan_fail_prefix: "扫描失败：",
    st_exists: "✔ 已存在",
    st_missing: "✘ 缺失",
    with_txt: "（含信息文件）",
    without_txt: "（缺信息文件，重新下载时会重新生成）",
    st_downloading: "⏳ 下载中",
    downloading_n: "下载中… 第 {i} / {n} 篇（成功 {ok}，失败 {fail}）",
    st_ok: "✔ 成功",
    st_fail: "✘ 失败",
    ba_prefix: "［浏览器自动化］",
    info_file_suffix: "（信息文件: {p}）",
    unknown_error: "未知错误",
    net_error: "网络错误（连接中断或服务未响应）：",
    interval_wait: "任务间隔中（{s} 秒）… 已完成 {done} / {n} 篇",
    st_paused: "⏸ 已停止",
    stopped_summary: "已停止：完成 {done} / {n} 篇，点“继续下载”从当前条目重新下载",
    done_summary: "下载完成：成功 {ok}，失败 {fail}，跳过已存在 {skip} 篇",
    refreshed: "已刷新，正在重新扫盘…",
    stopping: "正在停止当前下载…",
    open_dir_failed: "打开目录失败",
    open_dir_fail: "打开目录失败：",
    ba_status: "浏览器自动化：",
    reload_failed: "刷新失败",
  },

  en: {
    app_title: "Journal Paper Downloader",
    app_heading: "📄 Journal Paper Downloader",
    subtitle:
      "Search articles by journal URL, build download lists, then batch-download PDFs via browser automation after a local disk scan",

    // Module 1: Literature Search
    search_title: "Literature Search",
    url_input_ph:
      "Journal URL, e.g. https://agupubs.onlinelibrary.wiley.com/journal/19448007 or https://www.nature.com/ngeo/",
    url_input_ph_short: "Journal URL, e.g. https://www.nature.com/ngeo/",
    remove_row: "Remove this row",
    add_url: "＋ Add journal URL",
    split_urls: "⇱ Split multi-URL row",
    search_journals: "Search Journals",
    multi_url_hint:
      "You can enter several journals at once; paste multiple URLs into one row (separated by spaces / commas / newlines) and click “Split multi-URL row” to split them into rows automatically.",
    detail_empty: "Click an article title to view its details here.",
    save_manifest: "Generate Download List",
    export_list: "Save Task List",
    export_list_tip:
      "Save the current task list to a file (task-list-<journal>.json, auto-numbered on name clashes) and download it via the browser",

    // Module 2: Scan & Download
    scan_title: "Scan & Download",
    local_root: "Local directory",
    local_root_hint_html:
      "Subfolders are created level by level under the local directory as <code>journal/volume/article/</code>; PDFs are named with the DOI suffix (e.g. <code>2025JC023188.pdf</code>), and a matching <code>.txt</code> info file (title, date, authors, DOI, etc.) is generated.",
    browser_label:
      "Browser (downloads are performed by browser automation, launched with the selected browser)",
    opt_edge: "Edge (default, best at passing anti-bot checks)",
    opt_auto: "Auto (local Chrome / Edge / bundled Chromium first)",
    opt_firefox: "Firefox (easily flagged by Cloudflare, not recommended)",
    opt_safari: "Safari (WebKit engine)",
    browser_hint_html:
      "Firefox / Safari are driven by Playwright's Firefox / WebKit engines; if not installed, run <code>python -m playwright install firefox</code> or <code>python -m playwright install webkit</code> first.",
    wait_min: "Wait per page (minutes)",
    max_refresh: "Max refreshes when unresponsive",
    verify_interval: "Verification click interval (s)",
    verify_max_fails: "Failed verifications before refresh",
    task_interval: "Interval between tasks (s)",
    gen_info: "Generate info file",
    auto_hint:
      "Browser automation opens a real browser window: if there is no download response within the wait time it refreshes automatically (the article is skipped once the refresh limit is exceeded); on human-verification pages it simulates a verification click every “verification click interval” seconds, and after “failed verifications before refresh” consecutive failures it refreshes the page to verify again (all within the per-page wait time); on login pages the window stays open and downloading continues automatically once you finish signing in manually in the browser.",
    import_ph:
      "Enter a task list file path to import, e.g. /mnt/d/paper/任务清单-Nature.json (relative paths are resolved against the site root)",
    import_list: "Import Task List",
    import_list_tip: "Load a task list from the given path and set it as the current pending list",
    gen_undone: "Generate Undone List",
    gen_undone_tip:
      "Based on the local directory scan, generate a new task list from the not-yet-downloaded items in the current list and switch to it automatically",
    save_list_tip:
      "Save the current pending task list to a file (task-list-<journal>.json, auto-numbered on name clashes)",
    list_persist_hint:
      "The list used by the last task is restored automatically when the site opens; after generating a list in “Literature Search” above, importing one here, or generating an undone list, the current pending list switches automatically and is persisted (its file path is shown in the list info).",
    scan_local: "Scan Local Directory",
    refresh: "⟳ Refresh",
    refresh_tip: "Keep current settings (save directory, etc.), reset download state and rescan",
    fetch_missing: "Download Missing Files",
    stop_download: "Stop Download",
    resume_download: "Resume Download",
    open_dir: "Open Local Directory",

    // Footer / intervention banner
    footer_note:
      "Browser automation only simulates normal manual download operations on publisher pages; it never bypasses paywalls or verification mechanisms.",
    auth_done: "I've completed verification, keep waiting",
    auth_reload: "Reload Verification Page",
    auth_reload_tip: "Reload the page and retry when the verification page is stuck or looping",
    auth_skip: "Skip This Article",

    // Tree
    root_title_tip: "Click to expand/collapse the volume list",
    vol_label_tip: "Click to load/collapse this volume's articles",
    count_pcs: "{sel} / {total} items",
    root_volumes_suffix: ", {n} volumes",
    root_scanned_suffix: " ({n} scanned)",
    vol_loading: "Loading volume list…",
    works_loading: "Loading articles…",
    scan_done_bar: "{n} volumes in total, {m} articles scanned",
    scan_progress_bar:
      "Scanning volume list: {loaded} / ~{total} articles scanned (click the journal name again to collapse and pause)",
    vol_incomplete:
      "The journal's volume list is still being scanned; this volume's articles may be incomplete (they will be filled in automatically).",

    // Detail pane
    dt_date: "Date",
    dt_authors: "Authors",
    dt_journal: "Journal",
    dt_vol_issue: "Volume / Issue",
    dt_link: "Link",
    unknown: "Unknown",
    none: "None",
    vol_n: "Volume {n}",
    issue_n: "Issue {n}",
    add_to_manifest: "Add to download list",

    // Dynamic messages
    err_api: "Server returned an error",
    resolving: "Resolving {i}/{n}…",
    parse_fail: "Failed to parse",
    parse_fail_for: "Failed to parse “{url}”: {msg}",
    selected_count: "{n} selected",
    vol_load_fail: "Failed to load volume list",
    vol_load_fail_for: "Failed to load volume list for “{t}”: {msg}",
    works_load_fail: "Failed to load articles",
    works_load_fail_for: "Failed to load articles for “{t}”: {msg}",
    manifest_preparing: "Preparing list: “{t}” — retrieving {loaded} / ~{total} articles…",
    retrieve_fail: "Article retrieval failed",
    manifest_prepared: "Preparing list: “{t}” — fully retrieved ({n} articles), aggregating…",
    manifest_generating: "Generating download list…",
    save_failed: "Save failed",
    manifest_cached: "✔ List cached ({n} articles). Continue in the “Scan & Download” section below.",
    save_fail_prefix: "Save failed: ",
    no_manifest: "No task list yet. Generate or import one first.",
    journal_sep: ", ",
    unknown_journal: "Unknown journal",
    active_list_label: "Current pending task list: ",
    list_count_part: " ｜ {n} articles",
    generated_at: " ｜ Generated at {t}",
    from_undone: " ｜ Source: undone list",
    file_label: " ｜ File: ",
    list_default_filename: "task-list.json",
    read_manifest_fail: "Failed to read list",
    export_ok: "✔ Task list saved ({n} articles): {p}; a copy has been downloaded via the browser",
    export_fail: "Failed to save task list: ",
    save_list_ok: "✔ Current task list saved ({n} articles): {p}",
    import_path_empty: "Enter a task list file path first",
    import_failed: "Import failed",
    import_ok: "✔ Task list imported ({n} articles) and set as current: {p}",
    import_fail: "Failed to import task list: ",
    root_empty: "Fill in the local directory first",
    gen_failed: "Generation failed",
    all_downloaded: "All items in the list are already downloaded; the undone list is empty",
    undone_ok:
      "✔ Undone list generated and set as the current task list ({missing} missing, {exists} downloaded): {p}",
    undone_fail: "Failed to generate undone list: ",
    scanning: "Scanning…",
    scan_failed: "Scan failed",
    manifest_empty: "The list is empty; generate a download list first",
    scan_summary: "List: {n} articles — {e} exist, {m} missing",
    scan_fail_prefix: "Scan failed: ",
    st_exists: "✔ Exists",
    st_missing: "✘ Missing",
    with_txt: " (with info file)",
    without_txt: " (info file missing; it will be regenerated on re-download)",
    st_downloading: "⏳ Downloading",
    downloading_n: "Downloading… item {i} / {n} (ok {ok}, failed {fail})",
    st_ok: "✔ Done",
    st_fail: "✘ Failed",
    ba_prefix: "[browser automation] ",
    info_file_suffix: " (info file: {p})",
    unknown_error: "Unknown error",
    net_error: "Network error (connection interrupted or server unresponsive): ",
    interval_wait: "Waiting between tasks ({s}s)… {done} / {n} done",
    st_paused: "⏸ Stopped",
    stopped_summary: "Stopped: {done} / {n} items done; click “Resume Download” to retry from the current item",
    done_summary: "Download finished: {ok} succeeded, {fail} failed, {skip} existing skipped",
    refreshed: "Refreshed; rescanning…",
    stopping: "Stopping the current download…",
    open_dir_failed: "Failed to open directory",
    open_dir_fail: "Failed to open directory: ",
    ba_status: "Browser automation: ",
    reload_failed: "Reload failed",
  },
};

const I18N_LANG_KEY = "pdl-lang";

/** 当前语言：localStorage 已保存 -> 浏览器语言 -> 中文 */
function currentLang() {
  try {
    const saved = localStorage.getItem(I18N_LANG_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* localStorage 不可用时按浏览器语言 */
  }
  const nav = (navigator.languages && navigator.languages[0]) || navigator.language || "";
  return /^en/i.test(nav) ? "en" : "zh";
}

/** 切换并保存语言（不刷新页面） */
function setLang(lang) {
  if (lang !== "zh" && lang !== "en") return;
  try {
    localStorage.setItem(I18N_LANG_KEY, lang);
  } catch {
    /* 保存失败仅影响下次打开 */
  }
}

/** 取词：t("key") 或 t("key", { n: 3 }) 填充 {n} 占位符；缺 key 时回退中文 */
function t(key, vars) {
  const dict = I18N[currentLang()] || I18N.zh;
  let s = dict[key] ?? I18N.zh[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      s = s.split("{" + name + "}").join(String(value));
    }
  }
  return s;
}

/** 按当前语言填充页面上所有带 data-i18n* 属性的静态文案 */
function applyI18n() {
  const lang = currentLang();
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-html]")) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
}

// 首次加载即按当前语言渲染（脚本位于 </body> 前，DOM 已就绪）
applyI18n();
const i18nLangSelect = document.getElementById("lang-select");
if (i18nLangSelect) i18nLangSelect.value = currentLang();
