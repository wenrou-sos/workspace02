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
  }));
}

function bindGlobal() {
  $("#btn-seed").addEventListener("click", async () => {
    if (!confirm("将清空当前业务数据并载入 16 条演示事件（含 8 个典型关联簇），继续？")) return;
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
  $("#event-form").addEventListener("submit", submitEvent);
  $("#f-room").addEventListener("change", syncDeviceOptions);
  $("#f-symptom").addEventListener("change", updateSymptomHint);
  $("#btn-save-settings").addEventListener("click", saveSettings);
}

async function refreshAll() {
  const [ov, _c, _e] = await Promise.all([loadOverview(), loadBoard(), loadRecent()]);
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
  const data = await api("/api/events");
  $("#recent-count").textContent = `（共 ${data.items.length} 条）`;
  $("#recent-events").innerHTML = data.items.slice(0, 30).map(ev => `
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
    $$(".tab").forEach(x => x.classList.toggle("active", x.dataset.tab === "topo"));
    $$(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-topo"));
    $("#topo-cluster").value = cid;
    loadTopology(cid);
    closeDrawer();
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

  // 区域背景
  const zones = META.zones;
  zones.forEach((z, i) => {
    const sw = byId["SW-" + z.id];
    if (!sw) return;
    html += `<rect x="330" y="${sw.y - 60}" width="${W - 360}" height="630" rx="12"
      fill="rgba(255,255,255,.018)" stroke="#1e2735" stroke-dasharray="4 4"/>
      <text x="345" y="${sw.y - 38}" fill="#556378" font-size="13">${z.name}（4间包厢）</text>`;
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
