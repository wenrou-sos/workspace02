/* 设备异常记录关联台 —— 前端 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTs = (ts) => ts ? ts.replace("T", " ").slice(5, 16) : "";
const fmtFull = (ts) => ts ? ts.replace("T", " ") : "";
const VERDICT_COLOR = {
  single_device: "var(--single)", room_local: "var(--room)",
  zone_link: "var(--zone)", public_service: "var(--public)", core_link: "var(--core)",
};

let META = null;
let clustersCache = [];
let historyState = { page: 1, pageSize: 20, loaded: false };
let mergeState = { selected: new Set(), presetId: null };

// ============ 启动 ============
async function boot() {
  META = await api("/api/meta");
  initForm();
  bindTabs();
  bindGlobal();
  await refreshAll();
}

function bindTabs() {
  $$(".tab").forEach(t => t.addEventListener("click", () => {
    $$(".tab").forEach(x => x.classList.toggle("active", x === t));
    $$(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + t.dataset.tab));
    if (t.dataset.tab === "topo") loadTopology();
    if (t.dataset.tab === "settings") loadSettingsPage();
    if (t.dataset.tab === "history") {
      initHistoryFilters();
      if (!historyState.loaded) loadHistory(1);
    }
  }));
}

function switchTab(tab) {
  $$(".tab").forEach(x => x.classList.toggle("active", x.dataset.tab === tab));
  $$(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + tab));
}

function bindGlobal() {
  $("#btn-seed").addEventListener("click", async () => {
    const n = META.demo_event_count;
    if (!confirm(`将清空当前业务数据并载入 ${n} 条演示事件（含 8 个典型关联簇），继续？`)) return;
    const r = await api("/api/seed", { method: "POST" });
    toast(`已生成 ${r.created} 条记录并完成自动关联`);
    await refreshAll();
  });
  $("#btn-reset").addEventListener("click", async () => {
    if (!confirm("清空全部事件、簇、屏障和审计？")) return;
    await api("/api/reset", { method: "POST" });
    toast("已清空");
    await refreshAll();
  });
  $("#btn-recompute").addEventListener("click", async () => {
    const r = await api("/api/recompute", { method: "POST" });
    toast(`重算完成：${r.remerged} 条重新归并，${r.protected_clusters.length} 个手动/锁定簇受保护`);
    await refreshAll();
  });
  $("#show-closed").addEventListener("change", loadBoard);
  $("#topo-cluster").addEventListener("change", () =>
    loadTopology($("#topo-cluster").value));
  $("#d-close").addEventListener("click", closeDrawer);
  $("#drawer-mask").addEventListener("click", closeDrawer);
  $("#btn-board-merge").addEventListener("click", () => openMergeModal());
  ["#merge-close", "#merge-cancel"].forEach(id =>
    $(id).addEventListener("click", closeMergeModal));
  $("#merge-mask").addEventListener("click", e => {
    if (e.target.id === "merge-mask") closeMergeModal();
  });
  $("#merge-search").addEventListener("input", renderMergeList);
  $("#merge-show-closed").addEventListener("change", renderMergeList);
  $("#merge-confirm").addEventListener("click", confirmMerge);
  $("#event-form").addEventListener("submit", submitEvent);
  $("#f-room").addEventListener("change", syncDeviceOptions);
  $("#f-symptom").addEventListener("change", updateSymptomHint);
  $("#btn-save-settings").addEventListener("click", saveSettings);
  $("#goto-history").addEventListener("click", () => {
    switchTab("history");
    initHistoryFilters();
    if (!historyState.loaded) loadHistory(1);
  });
  $("#q-room").addEventListener("change", () => {
    fillHistoryDeviceOptions($("#q-room").value);
  });
  $("#q-search").addEventListener("click", () => loadHistory(1));
  $("#q-clear").addEventListener("click", clearHistoryFilters);
  // 筛选区回车直接查询
  ["q-from", "q-to"].forEach(id => $("#" + id).addEventListener("keydown", e => {
    if (e.key === "Enter") loadHistory(1);
  }));
}

async function refreshAll() {
  await Promise.all([loadOverview(), loadBoard(), loadRecent()]);
  if (historyState.loaded) await loadHistory(historyState.page);
}

// ============ ① 上报表单 ============
function initForm() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - -new Date().getTimezoneOffset());
  $("#f-ts").value = now.toISOString().slice(0, 16);

  const roomSel = $("#f-room");
  roomSel.innerHTML = '<option value="">请选择包厢</option>' +
    META.rooms.map(r => `<option value="${r.id}">${r.zone_name} · ${r.name}</option>`).join("");
  $("#f-symptom").innerHTML = '<option value="">请选择现象</option>' +
    META.symptoms.filter(s => s.id !== "other")
      .map(s => `<option value="${s.id}">${s.name}</option>`).join("") +
    '<option value="other">其他异常</option>';
}

function roomDevices(roomId) {
  return META.devices.filter(d => d.room_id === roomId);
}

function syncDeviceOptions() {
  const roomId = $("#f-room").value;
  $("#f-device").innerHTML = '<option value="">请选择设备</option>' +
    roomDevices(roomId).map(d => `<option value="${d.id}">${d.name}</option>`).join("");
}

function updateSymptomHint() {
  const s = META.symptoms.find(x => x.id === $("#f-symptom").value);
  $("#form-hint").textContent = s && s.aliases.length ? `常见说法：${s.aliases.join("、")}` : "";
  $("#form-hint").classList.remove("err");
}

async function submitEvent(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  try {
    const r = await api("/api/events", { method: "POST", body: payload });
    const merged = r.event.merge_reason;
    const hint = $("#form-hint");
    if (merged) {
      hint.textContent = `✓ 已按规则 ${merged.rule}（${merged.score}分，相隔${merged.gap_min}分钟）自动并入簇 #${r.cluster_id}`;
      hint.classList.remove("err");
    } else {
      hint.textContent = `✓ 未发现可关联事件，已新建簇 #${r.cluster_id}`;
      hint.classList.remove("err");
    }
    e.target.querySelector("textarea").value = "";
    await refreshAll();
    setTimeout(() => openCluster(r.cluster_id), 350);
  } catch (err) {
    const hint = $("#form-hint");
    hint.textContent = "✗ " + err.message;
    hint.classList.add("err");
  }
}

async function loadRecent() {
  const data = await api("/api/events?page=1&page_size=30");
  $("#recent-count").textContent = `（显示最新 ${data.items.length} / 共 ${data.total} 条，完整筛选见历史记录）`;
  $("#recent-events").innerHTML = data.items.map(ev => `
    <div class="ev" data-cluster="${ev.cluster_id}">
      <div class="sev ${ev.severity}"></div>
      <div class="ev-main">
        <div class="ev-title">${esc(ev.room_name)} · ${esc(ev.device_name)}
          <span class="sym-chip">${esc(ev.symptom_name)}</span></div>
        <div class="ev-desc">${esc(ev.description) || "（无描述）"}</div>
        <div class="ev-meta">${fmtFull(ev.ts)} · ${esc(ev.reporter || "匿名")}
          <span class="ev-tag ${ev.merge_reason ? "merged" : "new"}">
            ${ev.merge_reason ? `${ev.merge_reason.rule} 并入 #${ev.cluster_id}` : `新簇 #${ev.cluster_id}`}</span>
        </div>
      </div>
    </div>`).join("") || '<div class="empty">还没有记录</div>';
  $$("#recent-events .ev").forEach(el =>
    el.addEventListener("click", () => openCluster(el.dataset.cluster)));
}

// ============ 概览统计 ============
async function loadOverview() {
  const ov = await api("/api/overview");
  $("#stats").innerHTML = `
    <div class="stat"><b>${ov.total_events}</b><span>异常记录</span></div>
    <div class="stat"><b>${ov.active_clusters}</b><span>活跃关联簇</span></div>
    <div class="stat"><b>${ov.multi_room_clusters}</b><span>跨包厢簇</span></div>
    <div class="stat"><b class="${ov.critical_events ? "critical" : ""}">${ov.critical_events}</b><span>严重</span></div>`;
}

// ============ ② 关联看板 ============
async function loadBoard() {
  const status = $("#show-closed").checked ? "all" : "active";
  const data = await api("/api/clusters?status=" + status);
  clustersCache = data.items;
  $("#board-empty").classList.toggle("hidden", data.items.length > 0);
  $("#cluster-grid").innerHTML = data.items.map(c => {
    const conf = c.confidence != null ? Math.round(c.confidence * 100) : null;
    const badges = `${c.created_manually ? '<span class="badge manual">手动</span>' : ""}` +
      `${c.locked ? '<span class="badge locked">🔒锁定</span>' : ""}` +
      `${c.status === "closed" ? '<span class="badge closed">已关闭</span>' : ""}`;
    return `
    <div class="cc ${c.verdict_key || ""}" data-id="${c.id}">
      <div class="cc-head">
        <div class="cc-name">#${c.id} ${esc(c.name)}${badges}</div>
        <div class="cc-time">${fmtTs(c.first_ts)} → ${fmtTs(c.last_ts)}</div>
      </div>
      <div class="cc-verdict">${c.verdict ? `研判：<b style="color:${VERDICT_COLOR[c.verdict_key]}">${esc(c.verdict)}</b>` : ""}</div>
      <div class="cc-bars">
        <span>📋 ${c.event_count} 条记录</span>
        <span>🚪 ${c.room_count} 包厢</span>
        <span>🔌 ${c.device_count} 设备</span>
        ${c.max_severity === "critical" ? "<span style='color:var(--critical)'>⛔ 含严重</span>" : ""}
      </div>
      ${conf != null ? `<div class="conf-wrap">
        <div class="conf-bar"><div class="conf-fill" style="width:${conf}%"></div></div>
        <div class="conf-num">置信度 ${conf}%</div></div>` : ""}
    </div>`;
  }).join("");
  $$("#cluster-grid .cc").forEach(el =>
    el.addEventListener("click", () => openCluster(el.dataset.id)));
}

// ============ 簇详情抽屉 ============
async function openCluster(cid) {
  const data = await api(`/api/clusters/${cid}`);
  const c = data.cluster, d = data.diagnosis;
  $("#d-title").textContent = `#${c.id} ${c.name}`;

  const diagHtml = d ? `
    <div class="diag-box">
      <div class="diag-verdict" style="color:${VERDICT_COLOR[d.verdict_key]}">${esc(d.verdict)}</div>
      <div class="conf-wrap" style="margin:0 0 4px">
        <div class="conf-bar"><div class="conf-fill" style="width:${Math.round(d.confidence * 100)}%"></div></div>
        <div class="conf-num">置信度 ${Math.round(d.confidence * 100)}%</div>
      </div>
      <div>${d.suspects.map(s => `<span class="suspect-chip">${s.role === "primary" ? "🎯" : "❔"} ${esc(s.name)}</span>`).join("")}</div>
      <ul>${d.rationale.map(r => `<li>${esc(r)}</li>`).join("")}</ul>
    </div>` : "";

  const eventsHtml = `
    <h2 style="margin-bottom:4px">归并时间线（${data.events.length} 条）</h2>
    <div class="timeline">
      ${data.events.map(ev => `
        <div class="tl-item">
          <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">
            <input type="checkbox" class="member-check" value="${ev.id}"
              style="margin-top:2px" ${c.locked ? "disabled" : ""}>
            <div>
              <div class="tl-time">${fmtFull(ev.ts)} · ${esc(ev.reporter || "匿名")}</div>
              <div class="tl-title">
                <span class="sev ${ev.severity}" style="display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px"></span>
                ${esc(ev.room_name)} · ${esc(ev.device_name)}
                <span class="sym-chip">${esc(ev.symptom_name)}</span>
              </div>
              <div class="tl-desc">${esc(ev.description) || "（无描述）"}</div>
              ${ev.merge_reason ? `
                <div class="merge-reason ${ev.merge_reason.rule === "MANUAL" ? "manual" : ""}">
                  ${mergeReasonText(ev.merge_reason)}
                </div>` : '<div class="merge-reason manual">⏱ 首条事件（新簇起点）</div>'}
            </div>
          </label>
        </div>`).join("")}
    </div>`;

  const blockHtml = data.blocks.length ? `
    <div class="block-note">🛡 本簇含 ${data.blocks.length} 条归并屏障，被拆开的事件不会再被自动并回。</div>` : "";

  const actionsHtml = `
    <div class="split-bar">
      <button class="btn btn-sm btn-danger" id="act-split" ${c.locked ? "disabled" : ""}>↩ 拆分勾选项到新簇</button>
      <button class="btn btn-sm" id="act-lock">${c.locked ? "🔓 解锁" : "🔒 锁定防改"}</button>
      <button class="btn btn-sm" id="act-status">${c.status === "closed" ? "重新打开" : "标记关闭"}</button>
      <button class="btn btn-sm" id="act-merge">🔗 与其他簇合并</button>
      <button class="btn btn-sm" id="act-topo">在拓扑中查看</button>
    </div>`;

  $("#d-body").innerHTML = diagHtml + actionsHtml + blockHtml + eventsHtml;
  $("#drawer").classList.add("open");
  $("#drawer-mask").classList.remove("hidden");

  $("#act-split").onclick = () => doSplit(cid);
  $("#act-lock").onclick = async () => {
    await api(`/api/clusters/${cid}/lock`, { method: "POST", body: { locked: !c.locked } });
    toast(c.locked ? "已解锁" : "已锁定，自动关联不再改动该簇");
    await openCluster(cid); await loadBoard();
  };
  $("#act-status").onclick = async () => {
    const st = c.status === "closed" ? "active" : "closed";
    await api(`/api/clusters/${cid}/status`, { method: "POST", body: { status: st } });
    toast(st === "closed" ? "已标记关闭" : "已重新打开");
    closeDrawer(); await refreshAll();
  };
  $("#act-topo").onclick = () => {
    switchTab("topo");
    $("#topo-cluster").value = cid;
    loadTopology(cid);
    closeDrawer();
  };
  $("#act-merge").onclick = () => {
    closeDrawer();
    openMergeModal(cid);
  };
}

function mergeReasonText(r) {
  if (r.rule === "MANUAL") return `✋ 人工合并：${esc(r.detail || "")}`;
  const names = { R1: "同设备复发规则 R1", R2: "同包厢关联规则 R2", R3: "公共链路规则 R3" };
  return `⚙ ${names[r.rule]}：${esc(r.detail)}；参照事件 #${r.ref_event_id}，` +
    `时间相隔 ${r.gap_min} 分钟，相似度 ${r.score} 分` +
    (r.shared_node ? `，共享上游 ${r.shared_node}` : "") +
    (r.recompute ? "（重算）" : "");
}

// ============ 多簇人工合并 ============
async function openMergeModal(presetId = null) {
  mergeState = { selected: new Set(), presetId };
  if (presetId) mergeState.selected.add(presetId);
  $("#merge-reason").value = "";
  $("#merge-err").textContent = "";
  $("#merge-search").value = "";
  $("#merge-show-closed").checked = true;   // 预置簇可能已关闭，默认全列
  $("#merge-mask").classList.remove("hidden");
  await renderMergeList();
}

function closeMergeModal() {
  $("#merge-mask").classList.add("hidden");
  mergeState.selected.clear();
}

async function renderMergeList() {
  const includeClosed = $("#merge-show-closed").checked;
  const data = await api("/api/clusters?status=" + (includeClosed ? "all" : "active"));
  clustersCache = data.items;
  const kw = $("#merge-search").value.trim().toLowerCase();
  const list = data.items.filter(c => {
    if (!kw) return true;
    return [c.name, c.symptom_name, c.verdict].some(v =>
      String(v || "").toLowerCase().includes(kw));
  });
  $("#merge-list").innerHTML = list.map(c => {
    const sel = mergeState.selected.has(c.id);
    return `<div class="merge-item ${sel ? "sel" : ""}" data-id="${c.id}">
      <input type="checkbox" class="mi-check" ${sel ? "checked" : ""} tabindex="-1">
      <div>
        <div class="mi-name">#${c.id} ${esc(c.name)}
          ${c.created_manually ? '<span class="badge manual">手动</span>' : ""}
          ${c.locked ? '<span class="badge locked">🔒</span>' : ""}
          ${c.status === "closed" ? '<span class="badge closed">已关闭</span>' : ""}
        </div>
        <div class="mi-verdict" style="color:${VERDICT_COLOR[c.verdict_key] || "var(--muted)"}">
          ${esc(c.verdict || "（无研判）")}</div>
        <div class="mi-meta">${fmtTs(c.first_ts)} → ${fmtTs(c.last_ts)} ·
          ${c.event_count} 条记录 · ${c.room_count} 包厢 · ${c.device_count} 设备</div>
      </div>
    </div>`;
  }).join("") || '<div class="empty" style="padding:24px">没有匹配的簇</div>';

  $$("#merge-list .merge-item").forEach(el =>
    el.addEventListener("click", () => {
      const id = Number(el.dataset.id);
      if (mergeState.selected.has(id)) mergeState.selected.delete(id);
      else mergeState.selected.add(id);
      renderMergeList();
    }));
  $("#merge-count").textContent = `已选 ${mergeState.selected.size} 个簇`;
}

async function confirmMerge() {
  const ids = [...mergeState.selected];
  const reason = $("#merge-reason").value.trim();
  const err = $("#merge-err");
  err.textContent = "";
  if (ids.length < 2) {
    err.textContent = "✗ 请至少勾选两个簇（单个簇无需合并）";
    return;
  }
  if (!reason) {
    err.textContent = "✗ 请填写合并理由，审计中需要留存处置原因";
    return;
  }
  const btn = $("#merge-confirm");
  btn.disabled = true;
  try {
    const r = await api("/api/clusters/merge", {
      method: "POST", body: { cluster_ids: ids, reason },
    });
    closeMergeModal();
    toast(`已合并 ${ids.length} 个簇 → 手动簇 #${r.cluster_id}，研判已重新生成`);
    await refreshAll();
    openCluster(r.cluster_id);
  } catch (e) {
    err.textContent = "✗ " + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function doSplit(cid) {
  const ids = $$(".member-check:checked").map(x => Number(x.value));
  if (!ids.length) return toast("请先勾选要拆出的事件");
  const reason = prompt("拆分理由（将建立归并屏障，这些事件不会再被自动并回）：",
    "判定为不同故障，自动归并为误合并");
  if (reason === null) return;
  try {
    const r = await api(`/api/clusters/${cid}/split`, {
      method: "POST", body: { event_ids: ids, reason },
    });
    toast(`已拆分到新簇 #${r.new_cluster_id}，屏障已建立`);
    closeDrawer();
    await refreshAll();
    openCluster(r.new_cluster_id);
  } catch (e) { toast(e.message); }
}

function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#drawer-mask").classList.add("hidden");
}

// ============ ② 历史记录组合筛选 + 分页 ============
let historyFiltersInited = false;

function initHistoryFilters() {
  if (historyFiltersInited) return;
  historyFiltersInited = true;
  $("#q-room").insertAdjacentHTML("beforeend",
    META.rooms.map(r => `<option value="${r.id}">${r.zone_name} · ${r.name}</option>`).join(""));
  $("#q-symptom").insertAdjacentHTML("beforeend",
    META.symptoms.map(s => `<option value="${s.id}">${s.name}</option>`).join(""));
  fillHistoryDeviceOptions("");
}

function fillHistoryDeviceOptions(roomId) {
  const sel = $("#q-device");
  const devices = roomId ? META.devices.filter(d => d.room_id === roomId)
    : META.devices.filter(d => d.room_id);
  const keep = sel.value;
  sel.innerHTML = `<option value="">${roomId ? "该包厢全部设备" : "全部设备"}</option>` +
    devices.map(d => `<option value="${d.id}">${d.name}</option>`).join("");
  sel.disabled = false;
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}

function historyQueryString(page) {
  const f = (id) => $(id).value;
  const params = new URLSearchParams();
  if (f("#q-room")) params.set("room", f("#q-room"));
  if (f("#q-device")) params.set("device", f("#q-device"));
  if (f("#q-symptom")) params.set("symptom", f("#q-symptom"));
  if (f("#q-severity")) params.set("severity", f("#q-severity"));
  if (f("#q-from")) params.set("time_from", f("#q-from"));
  if (f("#q-to")) params.set("time_to", f("#q-to"));
  params.set("page", page);
  params.set("page_size", historyState.pageSize);
  return params.toString();
}

const SEV_LABEL = { critical: "严重", warn: "一般", info: "轻微" };

async function loadHistory(page = 1) {
  historyState.loaded = true;
  const hint = $("#q-hint");
  hint.textContent = "";
  hint.classList.remove("err");
  // 时间范围基本校验
  const tf = $("#q-from").value, tt = $("#q-to").value;
  if (tf && tt && tf > tt) {
    hint.textContent = "✗ 开始时间不能晚于结束时间";
    hint.classList.add("err");
    return;
  }
  let data;
  try {
    data = await api("/api/events?" + historyQueryString(page));
  } catch (e) {
    hint.textContent = "✗ " + e.message;
    hint.classList.add("err");
    return;
  }
  historyState.page = data.page;
  renderHistoryRows(data.items);
  $("#q-summary").textContent =
    data.total === 0 ? "无匹配记录"
      : `共 ${data.total} 条 · 第 ${data.page}/${data.pages} 页 · 按发生时间倒序`;
  renderPager(data);
}

function renderHistoryRows(items) {
  $("#q-rows").innerHTML = items.map(ev => {
    const clusterCell = ev.cluster_id
      ? `<span class="cluster-link" data-cluster="${ev.cluster_id}">#${ev.cluster_id} 查看</span>
         ${ev.verdict ? `<span class="verdict-mini" style="color:${VERDICT_COLOR[ev.verdict_key] || "var(--muted)"}">${esc(ev.verdict)}</span>` : ""}`
      : '<span class="muted">—</span>';
    return `<tr>
      <td class="col-time">${fmtFull(ev.ts)}</td>
      <td>${esc(ev.room_name)}</td>
      <td>${esc(ev.device_name)}</td>
      <td><span class="sym-chip">${esc(ev.symptom_name)}</span></td>
      <td><span class="sev-pill ${ev.severity}">${SEV_LABEL[ev.severity]}</span></td>
      <td class="col-desc">${esc(ev.description) || '<span class="muted">（无描述）</span>'}</td>
      <td>${esc(ev.reporter || "—")}</td>
      <td class="col-cluster">${clusterCell}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="8" class="empty">没有符合条件的记录，试试放宽筛选条件</td></tr>';
  $$("#q-rows .cluster-link").forEach(el =>
    el.addEventListener("click", () => openCluster(el.dataset.cluster)));
}

function renderPager(data) {
  if (data.total === 0) { $("#q-pager").innerHTML = ""; return; }
  const btn = (label, page, opts = {}) =>
    `<button class="btn btn-sm ${opts.cur ? "cur" : ""}" ${opts.disabled ? "disabled" : ""}
       data-page="${page}">${label}</button>`;
  // 页码窗口：当前页前后各2页
  const win = [];
  for (let p = Math.max(1, data.page - 2); p <= Math.min(data.pages, data.page + 2); p++) win.push(p);
  let html = btn("‹ 上一页", data.page - 1, { disabled: !data.has_prev });
  html += '<span class="pages">' + win.map(p =>
    btn(String(p), p, { cur: p === data.page })).join("") + "</span>";
  html += btn("下一页 ›", data.page + 1, { disabled: !data.has_next });
  html += `<select id="q-pagesize">
      ${[20, 50, 100].map(n => `<option value="${n}" ${n === data.page_size ? "selected" : ""}>每页 ${n} 条</option>`).join("")}
    </select>`;
  $("#q-pager").innerHTML = html;
  $$("#q-pager button[data-page]").forEach(b =>
    b.addEventListener("click", () => loadHistory(Number(b.dataset.page))));
  $("#q-pagesize").addEventListener("change", e => {
    historyState.pageSize = Number(e.target.value);
    loadHistory(1);
  });
}

function clearHistoryFilters() {
  ["#q-room", "#q-device", "#q-symptom", "#q-severity", "#q-from", "#q-to"]
    .forEach(sel => { $(sel).value = ""; });
  fillHistoryDeviceOptions("");
  const hint = $("#q-hint");
  hint.textContent = "";
  hint.classList.remove("err");
  loadHistory(1);
}

// ============ ③ 拓扑可视化（SVG，手工坐标） ============
async function loadTopology(clusterId = "") {
  const data = await api("/api/topology" + (clusterId ? `?cluster=${clusterId}` : ""));
  const nodes = data.nodes;
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  const W = Math.max(...nodes.map(n => n.x)) + 200;
  const H = Math.max(...nodes.map(n => n.y)) + 130;
  const svg = $("#topo-svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);

  const edgePath = (a, b) => {
    const n1 = byId[a], n2 = byId[b];
    return `<path d="M${n1.x + 110},${n1.y + 20} C${n1.x + 110},${(n1.y + n2.y) / 2} ${n2.x + 55},${(n1.y + n2.y) / 2} ${n2.x + 55},${n2.y + 20}"
      fill="none" stroke="${n1.highlight || n2.highlight ? "var(--primary)" : "#2a3546"}"
      stroke-width="${n1.highlight || n2.highlight ? 2.4 : 1.2}"
      ${n1.highlight || n2.highlight ? 'class="hl-edge"' : ""}/>`;
  };

  const TYPE_STYLE = {
    server: { fill: "#1e3a5f", stroke: "#5b9bd5", icon: "🖥" },
    core: { fill: "#3b2a4f", stroke: "#c084fc", icon: "⬢" },
    switch: { fill: "#14352c", stroke: "#34d399", icon: "▤" },
    pod: { fill: "#222a38", stroke: "#3d4c63", icon: "🎤" },
    amp: { fill: "#222a38", stroke: "#3d4c63", icon: "🔊" },
    mic: { fill: "#222a38", stroke: "#3d4c63", icon: "🎙" },
    tv: { fill: "#222a38", stroke: "#3d4c63", icon: "📺" },
  };

  let html = `
    <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="#2a3546"/></marker></defs>`;

  // 区域背景：以该区域真实包厢设备的首排/末排为边界精确包裹
  // （首排在 sw.y-200，每间占 150px，排高 40px），标题与高度均反映真实包厢数
  const zones = META.zones;
  zones.forEach((z) => {
    const sw = byId["SW-" + z.id];
    if (!sw) return;
    const n = z.rooms.length;
    const top = sw.y - 225;            // 首排设备(sw.y-200)上方 25px
    const zoneH = (n - 1) * 150 + 90;  // 包住 n 排设备到末排下方 10px
    html += `<rect x="330" y="${top}" width="${W - 360}" height="${zoneH}" rx="12"
      fill="rgba(255,255,255,.018)" stroke="#1e2735" stroke-dasharray="4 4"/>
      <text x="345" y="${top + 22}" fill="#556378" font-size="13">${z.name}（${n}间包厢）</text>`;
  });

  html += data.edges.map(([a, b]) => edgePath(a, b)).join("");
  html += nodes.map(n => {
    const st = TYPE_STYLE[n.type] || TYPE_STYLE.pod;
    const w = n.type === "tv" ? 130 : (["switch", "core", "server"].includes(n.type) ? 110 : 130);
    let stroke = st.stroke, sw = 1.2, extra = "";
    if (n.highlight) { stroke = "var(--primary)"; sw = 2; }
    if (n.suspect) {
      stroke = "var(--critical)"; sw = 3;
      extra = `<circle cx="${n.x + w - 6}" cy="${n.y + 2}" r="7" fill="var(--critical)"/>
               <text x="${n.x + w - 6}" y="${n.y + 6}" text-anchor="middle" font-size="9" fill="#1b0606">!</text>`;
    }
    const badge = n.event_count ? `<text x="${n.x + 8}" y="${n.y + 14}" fill="#fbbf24" font-size="10">●${n.event_count}</text>` : "";
    return `<g class="topo-node" data-id="${n.id}" style="cursor:pointer">
      <rect x="${n.x}" y="${n.y}" width="${w}" height="40" rx="7"
        fill="${st.fill}" stroke="${stroke}" stroke-width="${sw}"/>
      <text x="${n.x + 10}" y="${n.y + 25}" fill="#dbe4ee" font-size="12">${st.icon} ${esc(n.name)}</text>
      ${badge}${extra}
      <title>${esc(n.name)}（${n.type}）${n.event_count ? ` · ${n.event_count}条异常` : ""}</title>
    </g>`;
  }).join("");

  // 簇研判浮层
  if (data.diagnosis) {
    const d = data.diagnosis;
    html += `<foreignObject x="40" y="${H - 92}" width="520" height="84">
      <div xmlns="http://www.w3.org/1999/xhtml" style="background:#161d29;border:1px solid var(--critical);
        border-radius:8px;padding:10px 14px;color:var(--text);font-size:13px">
        <b style="color:${VERDICT_COLOR[d.verdict_key]}">${esc(d.verdict)}</b>
        （置信度 ${Math.round(d.confidence * 100)}%）<br/>
        <span style="color:var(--muted)">${d.rationale.map(esc).join(" ｜ ")}</span>
      </div></foreignObject>`;
  }
  svg.innerHTML = html;
  $$(".topo-node", svg).forEach(g => g.addEventListener("click", () => {
    const n = byId[g.dataset.id];
    if (n.event_count) toast(`${n.name}：${n.event_count} 条异常记录（在看板中按设备筛选查看）`);
  }));

  // 簇下拉
  const clusters = await api("/api/clusters?status=all");
  $("#topo-cluster").innerHTML = '<option value="">全部簇叠加</option>' +
    clusters.items.filter(c => c.room_count > 1)
      .map(c => `<option value="${c.id}" ${String(c.id) === String(clusterId) ? "selected" : ""}>#${c.id} ${esc(c.name)}</option>`).join("");
}

// ============ ④ 设置 + 审计 ============
async function loadSettingsPage() {
  const settings = await api("/api/settings");
  $$(".mini").forEach(inp => { inp.value = settings[inp.dataset.k]; });
  const blocks = await api("/api/blocks");
  $("#block-list").innerHTML = blocks.items.length ? blocks.items.map(b => `
    <div class="block-item">🛡 事件#${b.event_a}（${esc(b.a_dev)} · ${fmtTs(b.a_ts)}）
      ⊥ 事件#${b.event_b}（${esc(b.b_dev)} · ${fmtTs(b.b_ts)}）<br>
      理由：${esc(b.reason)} · <span class="audit-time">${fmtFull(b.created_at)}</span></div>`).join("")
    : '<div class="empty" style="padding:24px">暂无屏障。拆分误合并簇后会自动建立。</div>';

  const audit = await api("/api/audit");
  $("#audit-list").innerHTML = audit.items.map(a => `
    <div class="audit-item">
      <span class="audit-time">${fmtFull(a.ts)}</span><br>
      <b>${actionName(a.action)}</b>
      ${a.cluster_id ? ` · 簇#${a.cluster_id}` : ""}${a.event_id ? ` · 事件#${a.event_id}` : ""}
      ${a.detail ? `<br>${esc(a.detail)}` : ""}
    </div>`).join("") || '<div class="empty" style="padding:24px">暂无操作记录</div>';
}

function actionName(a) {
  return { auto_merge: "自动归并", create_cluster: "新建簇", split: "人工拆分",
    manual_merge: "人工合并", lock: "锁定", unlock: "解锁", close: "关闭",
    reopen: "重开", recompute: "全量重算" }[a] || a;
}

async function saveSettings() {
  const body = {};
  $$(".mini").forEach(inp => { body[inp.dataset.k] = Number(inp.value); });
  await api("/api/settings", { method: "PUT", body });
  const hint = $("#settings-hint");
  hint.textContent = "✓ 已保存（仅影响后续自动归并，点顶栏「全量重算」可应用到历史数据）";
  hint.classList.remove("err");
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 3200);
}

boot().catch(e => {
  console.error(e);
  document.body.insertAdjacentHTML("afterbegin",
    `<div style="padding:20px;color:#f87171">启动失败：${esc(e.message)}</div>`);
});
