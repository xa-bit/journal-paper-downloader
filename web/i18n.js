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
      "期刊网址或 ISSN，如 https://agupubs.onlinelibrary.wiley.com/journal/19448007、https://www.nature.com/ngeo/ 或 1944-8007",
    url_input_ph_short: "期刊网址或 ISSN，如 https://www.nature.com/ngeo/",
    remove_row: "删除该行",
    add_url: "＋ 增加期刊网址",
    open_library: "📚 期刊库",
    open_library_tip:
      "打开期刊库：全选或依次勾选期刊，把地址批量导入检索栏；也可手动添加（联网搜索确认）、编辑或删除期刊",
    search_journals: "检索期刊",
    multi_url_hint:
      "支持一次输入多个期刊（网址或 ISSN）；也可打开期刊库，全选或依次勾选后批量导入检索栏。",
    detail_empty: "点击文章标题，在此查看详情。",
    save_manifest: "生成下载清单",
    export_list: "保存任务清单",
    export_list_tip:
      "按期刊把当前任务清单保存为文件（任务清单-期刊名.json，每刊一份，同名覆盖），并通过浏览器下载",

    // 期刊库
    lib_title: "📚 期刊库",
    lib_close: "关闭",
    lib_add_ph: "手动添加：输入期刊名称或网址，联网搜索确认对应的期刊及可用地址",
    lib_search: "联网搜索",
    lib_searching: "联网检索中…",
    lib_no_candidates: "没有找到可用的期刊候选{msg}",
    lib_search_fail: "联网搜索失败：{msg}",
    lib_add: "添加",
    lib_add_tip: "把该候选期刊加入期刊库",
    lib_add_empty: "请先输入期刊名称或网址",
    lib_filter_ph: "按期刊名 / ISSN 筛选",
    lib_select_all: "全选",
    lib_count: "共 {n} 本期刊，已勾选 {sel} 本",
    lib_empty: "期刊库为空，可在上方手动添加，或直接在检索栏输入网址检索。",
    lib_name_ph: "期刊名称",
    lib_url_ph: "期刊网址（可用于检索；留空则按 ISSN 导入）",
    lib_save_edit: "保存修改",
    lib_cancel_edit: "取消编辑",
    lib_edit_tip: "编辑期刊名称 / 检索地址（地址变更时自动联网重新确认 ISSN）",
    lib_del_tip: "从期刊库删除该期刊",
    lib_no_url: "（无网址，按 ISSN 检索）",
    lib_footer_hint: "勾选后导入检索栏；✎ 编辑地址、✕ 删除条目（立即保存）",
    lib_import: "导入所选至检索栏",
    lib_imported: "✔ 已从期刊库导入 {n} 个期刊地址至检索栏",
    lib_load_fail: "期刊库读写失败：{msg}",

    // 模块二：扫盘与下载
    scan_title: "扫盘与下载",
    local_root: "本地目录",
    local_root_hint_html:
      "下载将在本地目录下按 <code>期刊名/出版卷/文章名/</code> 逐级生成子文件夹；PDF 以 DOI 尾缀命名（如 <code>2025JC023188.pdf</code>），并同时生成同名 <code>.txt</code> 信息文件（标题、日期、作者、DOI 等）。",
    browser_label: "浏览器选择（下载由浏览器自动化完成，按所选浏览器启动）",
    opt_chrome: "Chrome（默认）",
    opt_auto: "自动（优先本机 Chrome / Edge / 内置 Chromium）",
    opt_edge: "Edge",
    opt_firefox: "Firefox（易被 Cloudflare 识别，不推荐）",
    opt_safari: "Safari（WebKit 引擎）",
    browser_hint_html:
      "Firefox / Safari 由 Playwright 的 Firefox / WebKit 引擎驱动，未安装时先执行 <code>python -m playwright install firefox</code> 或 <code>python -m playwright install webkit</code>。",
    wait_min: "每页等待时间（分钟）",
    max_refresh: "无响应最大刷新次数",
    verify_interval: "验证点击间隔（秒）",
    verify_max_fails: "验证失败几次后刷新",
    task_interval: "任务间隔（秒）",
    skip_sources_label: "无权限时跳过对应下载源（勾选后，该下载源在权限记录为“无”时直接跳过；不勾选则依旧尝试）",
    skip_scihub: "Sci-Hub 无权限时跳过",
    skip_researchgate: "ResearchGate 无全文时跳过",
    skip_official: "官网无权限时跳过",
    auto_access_hint_html:
      "每次下载都会自动生成信息文件，并确认该文献的访问权限，在其保存目录写入权限记录文件（<code>DOI尾缀.access.json</code>），记录包含三个下载源：官方网页权限（出版商允许 / 拒绝访问）、Sci-Hub 是否收录与 ResearchGate 是否有公开全文。下载前自动扫描该记录：仅当三者都被标记为“无”时才直接跳过该篇（删除记录文件后可重试）；否则默认按 Sci-Hub → ResearchGate → 官方页面的顺序尝试下载。",
    auto_hint:
      "浏览器自动化会打开真实浏览器窗口：等待时间内无下载响应会自动刷新（超过刷新次数后跳过该篇）；遇到人机验证时每“验证点击间隔”秒自动模拟点击一次验证，连续“验证失败几次后刷新”次未通过会刷新页面重新验证（这些时间都算在每页等待时间内）；遇到登录身份验证时页面保持打开，等待你在浏览器中手动处理后自动继续。",
    import_ph:
      "输入任务清单路径后导入（多份用逗号 / 分号 / 换行分隔）；留空并点击按钮可直接选择文件批量导入",
    import_list: "导入任务清单",
    import_list_tip:
      "输入框有路径时按路径导入（可多份）；输入框为空时打开文件选择器，一次选多份清单批量导入",
    import_reading: "正在读取 {n} 份清单文件…",
    gen_undone: "生成未下载清单",
    gen_undone_tip:
      "按本地目录扫盘结果，把当前清单里未下载的条目按期刊分别生成新的任务清单并自动切换使用",
    save_list_tip: "把当前待执行的任务清单按期刊分别保存为文件（任务清单-期刊名.json，同名覆盖）",
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
    root_title_tip: "点击展开/收起卷目录（只加载一页，完整检索在生成下载清单时自动进行）",
    vol_label_tip: "点击加载/收起该卷文献",
    count_pcs: "{sel} / {total} 篇",
    root_volumes_suffix: "，共 {n} 卷",
    root_scanned_suffix: "（已扫描 {n}）",
    vol_loading: "卷目录加载中…",
    works_loading: "文献加载中…",
    scan_done_bar: "共 {n} 卷，已扫描 {m} 篇文献",
    scan_progress_bar: "卷目录检索中：已扫描 {loaded} / 约 {total} 篇（再点击期刊名可收起并暂停）",
    vol_partial_bar:
      "已加载 {loaded} / 约 {total} 篇的卷目录；点“生成下载清单”会自动补全检索整本期刊，无需等待。",
    scan_more: "检索全部卷",
    vol_incomplete: "期刊卷目录仍在检索中，该卷文献可能不全（稍候自动补全）。",
    select_all: "全选",
    select_all_tip: "勾选/取消当前检索到的所有期刊（整刊全选，生成清单时自动补全检索）",

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
    manifest_cached: "✔ 清单已生成（共 {n} 篇，按期刊拆分为 {f} 份：{names}），请到下方“扫盘与下载”模块操作。",
    save_fail_prefix: "保存失败：",
    no_manifest: "当前没有任务清单，请先生成或导入。",
    journal_sep: "、",
    unknown_journal: "未知期刊",
    active_list_label: "当前待执行任务清单：",
    list_count_part: " ｜ {n} 篇",
    generated_at: " ｜ 生成于 {t}",
    from_undone: " ｜ 来源：未下载清单",
    files_label: " ｜ 清单文件 {n} 份：{names}",
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
    access_denied_note: "（权限记录：官方网页 / Sci-Hub / ResearchGate 均标记为无，下载时直接跳过）",
    pdf_invalid_note: "（PDF 文件异常，已视为未下载，可重新下载）",
    scan_denied_suffix: "，其中 {n} 篇官方网页 / Sci-Hub / ResearchGate 均标记为无（下载时直接跳过）",
    // PDF 深度质量检查（扫盘时对粗检通过的文件验证结构；损坏文件当场删除待重下）
    pdf_q_too_small: "文件过小，内容不完整",
    pdf_q_no_startxref: "缺少交叉引用表（startxref）",
    pdf_q_bad_xref: "交叉引用表（xref）损坏",
    pdf_q_zero_filled: "文件主体为空字节数据",
    pdf_q_html: "内容为网页而非 PDF",
    pdf_q_read_failed: "文件读取失败",
    pdf_quality_deleted_note: "（PDF 质量异常：{reason}，已删除，轮到时将重新下载）",
    pdf_quality_keep_note: "（PDF 质量异常：{reason}，删除失败，重新下载时将覆盖）",
    scan_deleted_suffix: "，已删除损坏 PDF {n} 份",
    st_downloading: "⏳ 下载中",
    downloading_n: "下载中… 第 {i} / {n} 篇（成功 {ok}，失败 {fail}，无权限 {na}）",
    st_ok: "✔ 成功",
    st_fail: "✘ 失败",
    st_no_access: "⊘ 无权限",
    no_access_default: "无访问权限（需购买或机构登录），已自动跳过该篇",
    ba_prefix: "［浏览器自动化］",
    info_file_suffix: "（信息文件: {p}）",
    unknown_error: "未知错误",
    net_error: "网络错误（连接中断或服务未响应）：",
    interval_wait: "任务间隔中（{s} 秒）… 已完成 {done} / {n} 篇",
    st_paused: "⏸ 已停止",
    stopped_summary: "已停止：完成 {done} / {n} 篇，点“继续下载”从当前条目重新下载",
    done_summary: "下载完成：成功 {ok}，失败 {fail}，无权限跳过 {na}，已存在跳过 {skip} 篇",
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
      "Journal URL or ISSN, e.g. https://agupubs.onlinelibrary.wiley.com/journal/19448007, https://www.nature.com/ngeo/ or 1944-8007",
    url_input_ph_short: "Journal URL or ISSN, e.g. https://www.nature.com/ngeo/",
    remove_row: "Remove this row",
    add_url: "＋ Add journal URL",
    open_library: "📚 Journal Library",
    open_library_tip:
      "Open the journal library: select all or pick journals to import their URLs into the search bar; you can also add (confirmed via online search), edit or remove journals",
    search_journals: "Search Journals",
    multi_url_hint:
      "You can enter several journals at once (URL or ISSN); or open the journal library and import selected journals into the search bar in batch.",
    detail_empty: "Click an article title to view its details here.",
    save_manifest: "Generate Download List",
    export_list: "Save Task List",
    export_list_tip:
      "Save the current task list per journal (task list files, one per journal, overwriting on name clashes) and download them via the browser",

    // Journal library
    lib_title: "📚 Journal Library",
    lib_close: "Close",
    lib_add_ph: "Add manually: enter a journal name or URL, then search online to confirm the journal and its usable address",
    lib_search: "Search Online",
    lib_searching: "Searching online…",
    lib_no_candidates: "No usable journal candidates found{msg}",
    lib_search_fail: "Online search failed: {msg}",
    lib_add: "Add",
    lib_add_tip: "Add this candidate journal to the library",
    lib_add_empty: "Enter a journal name or URL first",
    lib_filter_ph: "Filter by journal name / ISSN",
    lib_select_all: "Select all",
    lib_count: "{n} journals, {sel} selected",
    lib_empty: "The library is empty. Add journals above, or type URLs in the search bar directly.",
    lib_name_ph: "Journal name",
    lib_url_ph: "Journal URL (used for search; leave empty to import by ISSN)",
    lib_save_edit: "Save changes",
    lib_cancel_edit: "Cancel editing",
    lib_edit_tip: "Edit the journal name / search URL (a changed URL is re-confirmed online for its ISSN)",
    lib_del_tip: "Remove this journal from the library",
    lib_no_url: "(no URL; searched by ISSN)",
    lib_footer_hint: "Select journals to import into the search bar; ✎ edit URL, ✕ remove entry (saved immediately)",
    lib_import: "Import Selected into Search Bar",
    lib_imported: "✔ Imported {n} journal URL(s) from the library into the search bar",
    lib_load_fail: "Journal library read/write failed: {msg}",

    // Module 2: Scan & Download
    scan_title: "Scan & Download",
    local_root: "Local directory",
    local_root_hint_html:
      "Subfolders are created level by level under the local directory as <code>journal/volume/article/</code>; PDFs are named with the DOI suffix (e.g. <code>2025JC023188.pdf</code>), and a matching <code>.txt</code> info file (title, date, authors, DOI, etc.) is generated.",
    browser_label:
      "Browser (downloads are performed by browser automation, launched with the selected browser)",
    opt_chrome: "Chrome (default)",
    opt_auto: "Auto (local Chrome / Edge / bundled Chromium first)",
    opt_edge: "Edge",
    opt_firefox: "Firefox (easily flagged by Cloudflare, not recommended)",
    opt_safari: "Safari (WebKit engine)",
    browser_hint_html:
      "Firefox / Safari are driven by Playwright's Firefox / WebKit engines; if not installed, run <code>python -m playwright install firefox</code> or <code>python -m playwright install webkit</code> first.",
    wait_min: "Wait per page (minutes)",
    max_refresh: "Max refreshes when unresponsive",
    verify_interval: "Verification click interval (s)",
    verify_max_fails: "Failed verifications before refresh",
    task_interval: "Interval between tasks (s)",
    skip_sources_label:
      "Skip a download source when it is recorded as no-access (checked: the source is skipped when its record says no; unchecked: it is retried anyway)",
    skip_scihub: "Skip Sci-Hub when no access",
    skip_researchgate: "Skip ResearchGate when no full text",
    skip_official: "Skip publisher page when no access",
    auto_access_hint_html:
      "Every download generates the info file automatically and confirms the paper's access rights, writing a permission record file (<code>&lt;DOI suffix&gt;.access.json</code>) into its target folder. The record carries three download sources: the publisher's official-page access (granted / denied), whether Sci-Hub has the paper (indexed / not indexed), and whether ResearchGate has a public full text (available / unavailable). The record is scanned before every download: a paper is skipped only when all three are marked as no (delete the record file to retry); otherwise downloads are tried in the order Sci-Hub → ResearchGate → publisher page.",
    auto_hint:
      "Browser automation opens a real browser window: if there is no download response within the wait time it refreshes automatically (the article is skipped once the refresh limit is exceeded); on human-verification pages it simulates a verification click every “verification click interval” seconds, and after “failed verifications before refresh” consecutive failures it refreshes the page to verify again (all within the per-page wait time); on login pages the window stays open and downloading continues automatically once you finish signing in manually in the browser.",
    import_ph:
      "Enter task list path(s) to import (separate multiple lists with commas / semicolons / newlines); leave empty and click the button to pick files instead",
    import_list: "Import Task List",
    import_list_tip:
      "Imports from the paths in the input (one or more); when the input is empty, clicking opens a file picker to select multiple list files at once",
    import_reading: "Reading {n} list file(s)…",
    gen_undone: "Generate Undone List",
    gen_undone_tip:
      "Based on the local directory scan, generate new task lists from the not-yet-downloaded items, one per journal, and switch to them automatically",
    save_list_tip:
      "Save the current pending task list per journal (task list files, overwriting on name clashes)",
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
    root_title_tip:
      "Click to expand/collapse the volume list (one page only; the full scan runs automatically when generating the download list)",
    vol_label_tip: "Click to load/collapse this volume's articles",
    count_pcs: "{sel} / {total} items",
    root_volumes_suffix: ", {n} volumes",
    root_scanned_suffix: " ({n} scanned)",
    vol_loading: "Loading volume list…",
    works_loading: "Loading articles…",
    scan_done_bar: "{n} volumes in total, {m} articles scanned",
    scan_progress_bar:
      "Scanning volume list: {loaded} / ~{total} articles scanned (click the journal name again to collapse and pause)",
    vol_partial_bar:
      "Volume list covers {loaded} / ~{total} articles; clicking “Generate Download List” completes the full journal scan automatically — no need to wait.",
    scan_more: "Scan all volumes",
    vol_incomplete:
      "The journal's volume list is still incomplete; this volume's articles may be partial (they will be filled in when the list is generated).",
    select_all: "Select all",
    select_all_tip:
      "Check/uncheck every retrieved journal (whole-journal selection; the full scan runs automatically when the list is generated)",

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
    manifest_cached:
      "✔ List generated ({n} articles in total, split into {f} file(s) by journal: {names}). Continue in the “Scan & Download” section below.",
    save_fail_prefix: "Save failed: ",
    no_manifest: "No task list yet. Generate or import one first.",
    journal_sep: ", ",
    unknown_journal: "Unknown journal",
    active_list_label: "Current pending task list: ",
    list_count_part: " ｜ {n} articles",
    generated_at: " ｜ Generated at {t}",
    from_undone: " ｜ Source: undone list",
    files_label: " ｜ {n} list file(s): {names}",
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
    access_denied_note: " (permission record: official pages / Sci-Hub / ResearchGate all marked no; will be skipped at download time)",
    pdf_invalid_note: " (corrupted PDF, treated as missing and safe to re-download)",
    scan_denied_suffix:
      ", {n} of them are marked no on all of official pages / Sci-Hub / ResearchGate (skipped at download time)",
    // PDF deep quality check (structure validation at scan time; corrupt files are deleted and re-downloaded)
    pdf_q_too_small: "file too small, content incomplete",
    pdf_q_no_startxref: "missing cross-reference table (startxref)",
    pdf_q_bad_xref: "corrupt cross-reference table (xref)",
    pdf_q_zero_filled: "body is zero-filled data",
    pdf_q_html: "content is a web page, not a PDF",
    pdf_q_read_failed: "file read failed",
    pdf_quality_deleted_note:
      " (corrupt PDF: {reason}; deleted at scan, will be re-downloaded)",
    pdf_quality_keep_note:
      " (corrupt PDF: {reason}; deletion failed, re-download will overwrite it)",
    scan_deleted_suffix: ", {n} corrupt PDF(s) deleted",
    st_downloading: "⏳ Downloading",
    downloading_n: "Downloading… item {i} / {n} (ok {ok}, failed {fail}, no access {na})",
    st_ok: "✔ Done",
    st_fail: "✘ Failed",
    st_no_access: "⊘ No access",
    no_access_default: "No access (purchase or institutional login required); article skipped automatically",
    ba_prefix: "[browser automation] ",
    info_file_suffix: " (info file: {p})",
    unknown_error: "Unknown error",
    net_error: "Network error (connection interrupted or server unresponsive): ",
    interval_wait: "Waiting between tasks ({s}s)… {done} / {n} done",
    st_paused: "⏸ Stopped",
    stopped_summary: "Stopped: {done} / {n} items done; click “Resume Download” to retry from the current item",
    done_summary: "Download finished: {ok} succeeded, {fail} failed, {na} skipped (no access), {skip} existing skipped",
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
