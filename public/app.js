/* Azure AI Manager · 管理面板 (阶段四) — vanilla JS, 无构建依赖 */
(() => {
  "use strict";

  // ---------- 基础工具 ----------
  const $ = (sel) => document.querySelector(sel);
  const TOKEN_LS_KEY = "azmgr_admin_token";

  const state = {
    token: localStorage.getItem(TOKEN_LS_KEY) || "",
    view: "overview",
    keys: [],
    nodes: [],
    sps: [],
    subs: [],
    warmupLogs: [],
    quota: { subs: [], sel: "", tier: null, usage: null },
    arm: { sp: "", sub: "", rg: "", accounts: [], deployments: [], selected: null },
  };

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }
  const fmtInt = (n) => (n ?? 0).toLocaleString("en-US");
  const fmtMs = (n) => (n == null ? "—" : `${Math.round(n)} ms`);
  const shortTime = (ts) => (ts ? esc(String(ts).replace("T", " ").slice(0, 19)) : "—");
  const boolBadge = (on) => `<span class="badge ${on ? "on" : "off"}">${on ? "启用" : "禁用"}</span>`;
  const quota = (v) => (v == null ? "∞" : fmtInt(v));

  function toast(msg, type = "ok", ms = 3200) {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    $("#toast-root").appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  async function copyText(text, tip = "已复制到剪贴板") {
    try {
      await navigator.clipboard.writeText(text);
      toast(tip);
    } catch {
      toast("复制失败，请手动选择复制", "err");
    }
  }

  function confirmDialog(message, { danger = true, okText = "确认删除" } = {}) {
    return new Promise((resolve) => {
      const m = openModal(`
        <h3>${danger ? "⚠️ 确认操作" : "确认"}</h3>
        <p style="white-space:pre-wrap">${esc(message)}</p>
        <div class="modal-foot">
          <button class="btn ghost" data-act="cancel">取消</button>
          <button class="btn ${danger ? "danger" : "primary"}" data-act="ok">${esc(okText)}</button>
        </div>`);
      m.addEventListener("click", (e) => {
        const act = e.target?.dataset?.act;
        if (act === "ok") { closeModal(); resolve(true); }
        if (act === "cancel") { closeModal(); resolve(false); }
      });
    });
  }

  // ---------- 模态框 ----------
  function openModal(html) {
    const root = $("#modal-root");
    root.innerHTML = `<div class="modal-overlay"><div class="modal">${html}</div></div>`;
    const overlay = root.firstElementChild;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeModal(); });
    return overlay;
  }
  function closeModal() { $("#modal-root").innerHTML = ""; }

  // ---------- API ----------
  async function api(path, { method = "GET", body } = {}) {
    const headers = {};
    if (state.token) headers["Authorization"] = `Bearer ${state.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error("网络错误：无法连接到后端");
    }
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
    if (!res.ok) {
      const err = new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data?.error?.code || data?.error?.type;
      throw err;
    }
    return data;
  }
  const armList = async (path) => {
    const data = await api(path);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.value)) return data.value;
    return [];
  };

  // ---------- 管理令牌 ----------
  function tokenModal({ first = false } = {}) {
    const m = openModal(`
      <h3>🔑 管理令牌</h3>
      ${first ? `<p class="muted">首次使用：输入服务端的 <code>ADMIN_TOKEN</code> 以连接管理 API。令牌只保存在本浏览器。</p>` : `<p class="muted">更换令牌后立即生效，不影响已发放的网关 Key。</p>`}
      <div class="form-row">
        <label>ADMIN_TOKEN</label>
        <input id="tok-input" type="password" placeholder="粘贴 ADMIN_TOKEN" autocomplete="off" />
        <div class="form-hint" id="tok-msg"></div>
      </div>
      <div class="modal-foot">
        ${first ? "" : `<button class="btn ghost" data-act="clear">清除本地令牌</button>`}
        <button class="btn primary" data-act="save">保存并连接</button>
      </div>`);
    const input = m.querySelector("#tok-input");
    if (state.token) input.value = state.token;
    input.focus();
    const msg = m.querySelector("#tok-msg");
    const trySave = async () => {
      const tok = input.value.trim();
      if (!tok) { msg.textContent = "请输入令牌"; msg.style.color = "var(--err)"; return; }
      msg.textContent = "验证中…"; msg.style.color = "var(--muted)";
      const prev = state.token;
      state.token = tok;
      try {
        await api("/admin/keys");
        localStorage.setItem(TOKEN_LS_KEY, tok);
        closeModal();
        toast("令牌有效，已连接 ✓");
        healthCheck();
        state.keys = [];
        loadCurrentView(true);
      } catch (e) {
        state.token = prev;
        msg.textContent = e.status === 401 ? "令牌无效 (401)" : e.message;
        msg.style.color = "var(--err)";
      }
    };
    m.addEventListener("click", (e) => {
      const act = e.target?.dataset?.act;
      if (act === "save") trySave();
      if (act === "clear") {
        state.token = "";
        localStorage.removeItem(TOKEN_LS_KEY);
        closeModal();
        tokenModal({ first: true });
      }
    });
    m.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === input) trySave(); });
  }

  // ---------- 健康检查 ----------
  async function healthCheck() {
    const dot = $("#health-dot"), text = $("#health-text");
    try {
      const h = await api("/admin/health");
      dot.className = "dot ok";
      text.textContent = `已连接 · ${String(h.time || "").slice(11, 19) || "ok"}`;
    } catch {
      dot.className = "dot err";
      text.textContent = "后端不可达";
    }
  }

  // ---------- 路由 ----------
  const VIEWS = {
    overview: { title: "📊 概览", load: loadOverview },
    keys:     { title: "🔑 网关密钥", load: loadKeys },
    logs:     { title: "📜 用量日志", load: loadLogs },
    nodes:    { title: "🖥️ 节点池", load: loadNodes },
    sps:      { title: "🛡️ 服务主体", load: loadSps },
    arm:      { title: "☁️ Azure 资源浏览器", load: initArm },
    warmup:   { title: "🌱 养号打卡", load: loadWarmup },
    quota:    { title: "📊 配额与 Tier", load: loadQuota },
    settings: { title: "⚙️ 设置", load: loadSettings },
  };

  function showView(name) {
    if (!VIEWS[name]) name = "overview";
    state.view = name;
    document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === `view-${name}`));
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
    $("#view-title").textContent = VIEWS[name].title;
    if (location.hash !== `#${name}`) location.hash = `#${name}`;
    loadCurrentView(true);
  }
  function loadCurrentView(force = false) {
    const loader = VIEWS[state.view]?.load;
    if (loader) Promise.resolve(loader(force)).catch((e) => toast(e.message, "err"));
  }
  const renderError = (el, e) => {
    el.innerHTML = `<div class="error-box">请求失败 (HTTP ${e.status ?? "—"}): ${esc(e.message)}${e.status === 401 ? "\n请在右上角「管理令牌」检查 ADMIN_TOKEN。" : ""}</div>`;
  };
  const requireTokenNotice = (el) => {
    if (!state.token) {
      el.innerHTML = `<div class="error-box">尚未配置管理令牌。请点击右上角「🔑 管理令牌」。</div>`;
      return true;
    }
    return false;
  };
  const fillKeyFilter = (sel, current) => {
    sel.innerHTML = `<option value="">全部</option>` +
      state.keys.map((k) => `<option value="${esc(k.id)}" ${k.id === current ? "selected" : ""}>${esc(k.label || k.id)}</option>`).join("");
  };
  async function ensureKeys() {
    if (state.keys.length || !state.token) return;
    const data = await api("/admin/keys");
    state.keys = data.keys ?? [];
  }

  // ---------- 概览 ----------
  const card = (k, v, s) =>
    `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`;

  async function loadOverview() {
    if (requireTokenNotice($("#ov-cards"))) return;
    try { await ensureKeys(); } catch { /* Key 列表失败不阻塞统计 */ }
    fillKeyFilter($("#ov-key"), $("#ov-key").value || null);
    const days = $("#ov-days").value || "7";
    const keySel = $("#ov-key").value;
    const qs = new URLSearchParams({ days });
    if (keySel) qs.set("key", keySel);
    let data;
    try { data = await api(`/admin/usage?${qs}`); } catch (e) { renderError($("#ov-cards"), e); return; }
    const s = data.summary ?? {};
    const totalTokens = (s.prompt_tokens ?? 0) + (s.completion_tokens ?? 0);
    const errRate = s.requests ? ((s.errors / s.requests) * 100).toFixed(1) + "%" : "0%";
    $("#ov-cards").innerHTML = [
      card("总请求", fmtInt(s.requests), `最近 ${data.days} 天`),
      card("总 Tokens", fmtInt(totalTokens), `输入 ${fmtInt(s.prompt_tokens)} / 输出 ${fmtInt(s.completion_tokens)}`),
      card("错误请求", fmtInt(s.errors), `错误率 ${errRate}`),
      card("平均延迟", fmtMs(s.avg_latency_ms), "端到端 (含上游)"),
    ].join("");

    const byDay = data.byDay ?? [];
    const max = Math.max(...byDay.map((r) => r.requests), 1);
    $("#ov-chart").innerHTML = byDay.length
      ? byDay.map((r) => {
          const h = Math.max((r.requests / max) * 100, 2);
          const tot = (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0);
          return `<div class="bar-col" title="${esc(r.day)}: ${r.requests} 次 / ${fmtInt(tot)} tokens">
            <div class="bar-val">${r.requests}</div>
            <div class="bar" style="height:${h}%"></div>
            <div class="bar-label">${esc(String(r.day).slice(5))}</div>
          </div>`;
        }).join("")
      : `<div class="empty">窗口内暂无请求</div>`;

    const keyName = (id) => {
      const k = state.keys.find((x) => x.id === id);
      return k ? (k.label || k.id) : (id || "—");
    };
    const byKey = data.byKey ?? [];
    $("#ov-bykey").innerHTML = byKey.length ? `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Key</th><th>请求</th><th>Tokens</th><th>错误</th></tr></thead><tbody>
      ${byKey.map((r) => `<tr><td>${esc(keyName(r.key_id))}<div class="sub mono">${esc(r.key_id ?? "")}</div></td>
        <td>${fmtInt(r.requests)}</td><td>${fmtInt(r.tokens)}</td><td>${fmtInt(r.errors)}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">暂无数据</div>`;

    const byDep = data.byDeployment ?? [];
    $("#ov-bydep").innerHTML = byDep.length ? `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>部署</th><th>请求</th><th>Tokens</th></tr></thead><tbody>
      ${byDep.map((r) => `<tr><td class="mono">${esc(r.deployment)}</td>
        <td>${fmtInt(r.requests)}</td><td>${fmtInt(r.tokens)}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">暂无数据</div>`;
  }

  // ---------- 网关密钥 ----------
  const keyRow = (k) => `
    <tr>
      <td>${esc(k.label || "(未命名)")}<div class="sub mono">${esc(k.id)}</div></td>
      <td class="mono">${esc(k.keyMasked)}</td>
      <td>${quota(k.rateLimitPerMin)}</td>
      <td>${quota(k.dailyRequestQuota)}</td>
      <td>${quota(k.dailyTokenQuota)}</td>
      <td>${boolBadge(k.enabled)}</td>
      <td class="mono">${shortTime(k.createdAt)}</td>
      <td class="actions">
        <button class="btn sm ghost" data-kact="edit" data-id="${esc(k.id)}">编辑</button>
        <button class="btn sm ghost" data-kact="toggle" data-id="${esc(k.id)}">${k.enabled ? "禁用" : "启用"}</button>
        <button class="btn sm danger" data-kact="del" data-id="${esc(k.id)}">删除</button>
      </td>
    </tr>`;

  async function loadKeys() {
    const el = $("#keys-list");
    if (requireTokenNotice(el)) return;
    let data;
    try { data = await api("/admin/keys"); } catch (e) { renderError(el, e); return; }
    state.keys = data.keys ?? [];
    el.innerHTML = state.keys.length ? `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>标签 / ID</th><th>Key</th><th>限流/分</th><th>日请求</th><th>日 Tokens</th><th>状态</th><th>创建时间</th><th></th></tr></thead>
      <tbody>${state.keys.map(keyRow).join("")}</tbody></table></div>`
      : `<div class="empty">还没有网关 Key，点上方「＋ 发放新 Key」创建。<br/>环境变量 <code>GATEWAY_KEYS</code> 中的 Key 仍然可用。</div>`;
  }

  function keyFormModal(existing) {
    const isEdit = !!existing;
    const val = (v) => (v == null ? "" : String(v));
    const m = openModal(`
      <h3>${isEdit ? "编辑网关 Key" : "发放新网关 Key"}</h3>
      <div class="form-row"><label>标签 (可选)</label><input id="kf-label" maxlength="128" placeholder="例如: my-app-prod" value="${isEdit ? esc(existing.label ?? "") : ""}" /></div>
      <div class="form-cols">
        <div class="form-row"><label>限流 (次/分钟, 留空不限)</label><input id="kf-rpm" type="number" min="1" placeholder="∞" value="${isEdit ? val(existing.rateLimitPerMin) : ""}" /></div>
        <div class="form-row"><label>日请求配额 (留空不限)</label><input id="kf-drq" type="number" min="1" placeholder="∞" value="${isEdit ? val(existing.dailyRequestQuota) : ""}" /></div>
      </div>
      <div class="form-row"><label>日 Token 配额 (prompt+completion, 留空不限)</label><input id="kf-dtq" type="number" min="1" placeholder="∞" value="${isEdit ? val(existing.dailyTokenQuota) : ""}" /></div>
      ${isEdit ? `<div class="form-row"><label>状态</label><select id="kf-enabled">
        <option value="1" ${existing.enabled ? "selected" : ""}>启用</option>
        <option value="0" ${!existing.enabled ? "selected" : ""}>禁用</option></select></div>` : ""}
      <div class="form-hint" id="kf-msg"></div>
      <div class="modal-foot">
        <button class="btn ghost" data-act="cancel">取消</button>
        <button class="btn primary" data-act="save">${isEdit ? "保存" : "创建"}</button>
      </div>`);
    m.addEventListener("click", async (e) => {
      const act = e.target?.dataset?.act;
      if (act === "cancel") closeModal();
      if (act !== "save") return;
      const num = (id) => {
        const v = m.querySelector(id).value.trim();
        if (v === "") return null;
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : NaN;
      };
      const body = {
        label: m.querySelector("#kf-label").value.trim() || null,
        rateLimitPerMin: num("#kf-rpm"),
        dailyRequestQuota: num("#kf-drq"),
        dailyTokenQuota: num("#kf-dtq"),
      };
      if (isEdit) body.enabled = m.querySelector("#kf-enabled").value === "1";
      if ([body.rateLimitPerMin, body.dailyRequestQuota, body.dailyTokenQuota].includes(NaN)) {
        m.querySelector("#kf-msg").textContent = "限额必须是正整数或留空";
        return;
      }
      try {
        if (isEdit) {
          await api(`/admin/keys/${encodeURIComponent(existing.id)}`, { method: "PATCH", body });
          closeModal(); toast("Key 已更新 ✓"); loadKeys();
        } else {
          const res = await api("/admin/keys", { method: "POST", body });
          closeModal(); plaintextModal(res.key, res.plaintext); loadKeys();
        }
      } catch (err) { m.querySelector("#kf-msg").textContent = err.message; }
    });
  }

  function plaintextModal(key, plaintext) {
    const m = openModal(`
      <h3>✅ Key 已创建</h3>
      <p class="muted">明文<b>只显示这一次</b>，服务端只保存 SHA-256 摘要。请立即复制保存。</p>
      <div class="kv" style="margin-bottom:12px">
        <div class="k">标签</div><div>${esc(key.label || "(未命名)")}</div>
        <div class="k">Key ID</div><div class="mono">${esc(key.id)}</div>
        <div class="k">标识</div><div class="mono">${esc(key.keyMasked)}</div>
      </div>
      <div class="plainkey-box" id="pk-text">${esc(plaintext)}</div>
      <div class="modal-foot">
        <button class="btn ghost" data-act="copy">📋 复制明文</button>
        <button class="btn primary" data-act="close">我已保存</button>
      </div>`);
    m.addEventListener("click", (e) => {
      if (e.target?.dataset?.act === "copy") copyText(plaintext);
      if (e.target?.dataset?.act === "close") closeModal();
    });
  }

  function wireKeys() {
    $("#keys-add").addEventListener("click", () => keyFormModal(null));
    $("#keys-list").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-kact]");
      if (!btn) return;
      const id = btn.dataset.id;
      const k = state.keys.find((x) => x.id === id);
      if (!k) return;
      const act = btn.dataset.kact;
      if (act === "edit") keyFormModal(k);
      if (act === "toggle") {
        try {
          await api(`/admin/keys/${encodeURIComponent(id)}`, { method: "PATCH", body: { enabled: !k.enabled } });
          toast(k.enabled ? "已禁用" : "已启用"); loadKeys();
        } catch (err) { toast(err.message, "err"); }
      }
      if (act === "del") {
        if (!(await confirmDialog(`删除网关 Key「${k.label || id}」？\n使用该 Key 的客户端将立即 401。`))) return;
        try { await api(`/admin/keys/${encodeURIComponent(id)}`, { method: "DELETE" }); toast("已删除"); loadKeys(); }
        catch (err) { toast(err.message, "err"); }
      }
    });
  }

  // ---------- 用量日志 ----------
  async function loadLogs() {
    const el = $("#logs-list");
    if (requireTokenNotice(el)) return;
    try { await ensureKeys(); } catch { /* 忽略 */ }
    fillKeyFilter($("#log-key"), $("#log-key").value || null);
    const qs = new URLSearchParams({ limit: $("#log-limit").value || "50" });
    if ($("#log-key").value) qs.set("key", $("#log-key").value);
    let logs;
    try { logs = (await api(`/admin/usage/logs?${qs}`)).logs ?? []; } catch (e) { renderError(el, e); return; }
    el.innerHTML = logs.length ? `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>时间</th><th>Key</th><th>节点 / 部署</th><th>路径</th><th>状态</th><th>延迟</th><th>Tokens</th><th>错误</th></tr></thead>
      <tbody>${logs.map((l) => `
        <tr>
          <td class="mono">${shortTime(l.ts)}</td>
          <td class="mono">${esc(l.key_id ?? "—")}</td>
          <td>${esc(l.node ?? "—")}<div class="sub mono">${esc(l.deployment ?? "")}</div></td>
          <td class="mono">${esc(l.path ?? "—")}${l.stream ? ' <span class="badge info">SSE</span>' : ""}</td>
          <td class="mono st${String(l.status ?? 0)[0] ?? "0"}">${l.status ?? "—"}</td>
          <td>${fmtMs(l.latency_ms)}</td>
          <td>${l.prompt_tokens == null && l.completion_tokens == null ? "—" : `${fmtInt(l.prompt_tokens)} + ${fmtInt(l.completion_tokens)}`}</td>
          <td class="cell-err" title="${esc(l.error ?? "")}">${esc(l.error ?? "")}</td>
        </tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">暂无日志</div>`;
  }

  function wireLogs() {
    $("#log-limit").addEventListener("change", () => loadLogs());
    $("#log-key").addEventListener("change", () => loadLogs());
    $("#log-purge").addEventListener("click", async () => {
      const days = prompt("清理多少天之前的日志？", "7");
      if (days === null) return;
      const n = Number(days);
      if (!Number.isInteger(n) || n < 1) { toast("请输入正整数天数", "err"); return; }
      if (!(await confirmDialog(`删除 ${n} 天之前的全部请求日志？此操作不可恢复。`, { okText: "确认清理" }))) return;
      try {
        const res = await api(`/admin/usage/logs?days=${n}`, { method: "DELETE" });
        toast(`已清理 ${res.deleted} 条日志`);
        loadLogs();
      } catch (e) { toast(e.message, "err"); }
    });
  }

  // ---------- 节点池 ----------
  const depSummary = (deps) =>
    Object.entries(deps ?? {}).map(([m, d]) => `<span class="badge info" title="${esc(m)} → ${esc(d)}">${esc(m)}→${esc(d)}</span>`).join(" ");

  const nodeRow = (n, h) => `
    <tr>
      <td><b>${esc(n.name)}</b>${n.enabled ? "" : ' <span class="badge off">禁用</span>'}<div class="sub mono">${esc(n.endpoint)}</div></td>
      <td class="mono">${esc(n.apiKeyMasked)}</td>
      <td>${depSummary(n.deployments) || '<span class="muted">无</span>'}</td>
      <td>${n.weight}</td>
      <td>${breakerBadge(h)}</td>
      <td class="mono">${shortTime(n.updatedAt)}</td>
      <td class="actions">
        <button class="btn sm ghost" data-nact="edit" data-name="${esc(n.name)}">编辑</button>
        ${h && h.state !== "closed" ? `<button class="btn sm ghost" data-nact="resetbreaker" data-name="${esc(n.name)}">熔断复位</button>` : ""}
        <button class="btn sm danger" data-nact="del" data-name="${esc(n.name)}">删除</button>
      </td>
    </tr>`;

  const breakerBadge = (h) => {
    if (!h) return '<span class="badge on">正常</span>';
    if (h.state === "open") return `<span class="badge off">熔断 (${h.failures} 次失败)</span>`;
    if (h.state === "half_open") return '<span class="badge warn">半开探测</span>';
    return '<span class="badge on">正常</span>';
  };

  async function loadNodes() {
    const el = $("#nodes-list");
    if (requireTokenNotice(el)) return;
    let data, brk;
    try {
      [data, brk] = await Promise.all([
        api("/admin/nodes"),
        api("/admin/breakers").catch(() => null),
      ]);
    } catch (e) { renderError(el, e); return; }
    state.nodes = data.nodes ?? [];
    const healthMap = new Map((brk?.breakers ?? []).map((b) => [b.nodeName, b]));
    el.innerHTML = state.nodes.length ? `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>节点</th><th>API Key</th><th>部署映射 (模型→部署)</th><th>权重</th><th>熔断</th><th>更新时间</th><th></th></tr></thead>
      <tbody>${state.nodes.map((n) => nodeRow(n, healthMap.get(n.name))).join("")}</tbody></table></div>`
      : `<div class="empty">节点池为空 — 网关请求将返回 503。可手动添加，或在「☁️ Azure 资源」页从订阅一键导入。</div>`;
  }

  function nodeFormModal(prefill, existing) {
    const isEdit = !!existing;
    const src = existing ?? prefill ?? {};
    const deps = src.deployments ?? {};
    const m = openModal(`
      <h3>${isEdit ? `编辑节点 ${esc(existing.name)}` : "新增节点"}</h3>
      <div class="form-cols">
        <div class="form-row"><label>节点名称 ${isEdit ? "(只读)" : ""}</label>
          <input id="nf-name" ${isEdit ? 'disabled value="' + esc(existing.name) + '"' : 'placeholder="node-eastus-1"'} value="${isEdit ? "" : esc(src.name ?? "")}" /></div>
        <div class="form-row"><label>权重</label><input id="nf-weight" type="number" min="1" max="100" value="${src.weight ?? 1}" /></div>
      </div>
      <div class="form-row"><label>Endpoint</label><input id="nf-endpoint" placeholder="https://xxx.openai.azure.com" value="${esc(src.endpoint ?? "")}" /></div>
      <div class="form-row"><label>API Key ${isEdit ? "(留空保留原凭据)" : ""}</label><input id="nf-key" type="password" autocomplete="off" placeholder="${isEdit ? "•••••• (已加密保存)" : "上游账户密钥"}" /></div>
      <div class="form-row"><label>部署映射 JSON (OpenAI 模型名 → Azure 部署名)</label>
        <textarea id="nf-deps" rows="5" spellcheck="false">{${Object.keys(deps).length ? "\n" : ""}} </textarea>
        <div class="form-hint">示例: {"gpt-4o": "gpt-4o-2024-08-06", "gpt-4o-mini": "gpt4o-mini"}</div></div>
      <div class="form-row"><label>状态</label><select id="nf-enabled">
        <option value="1" ${src.enabled === false ? "" : "selected"}>启用</option>
        <option value="0" ${src.enabled === false ? "selected" : ""}>禁用</option></select></div>
      <div class="form-hint" id="nf-msg"></div>
      <div class="modal-foot">
        <button class="btn ghost" data-act="cancel">取消</button>
        <button class="btn primary" data-act="save">${isEdit ? "保存" : "创建"}</button>
      </div>`);
    const depsTa = m.querySelector("#nf-deps");
    depsTa.value = JSON.stringify(deps, null, 2);
    m.addEventListener("click", async (e) => {
      const act = e.target?.dataset?.act;
      if (act === "cancel") closeModal();
      if (act !== "save") return;
      const msg = m.querySelector("#nf-msg");
      let depsObj;
      try { depsObj = JSON.parse(depsTa.value || "{}"); } catch { msg.textContent = "部署映射不是合法 JSON"; return; }
      if (typeof depsObj !== "object" || Array.isArray(depsObj) || depsObj === null) { msg.textContent = "部署映射必须是 JSON 对象"; return; }
      const name = isEdit ? existing.name : m.querySelector("#nf-name").value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) { msg.textContent = "名称: 1-64 位字母数字或 . _ -，且以字母数字开头"; return; }
      const endpoint = m.querySelector("#nf-endpoint").value.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//.test(endpoint)) { msg.textContent = "Endpoint 必须以 http(s):// 开头"; return; }
      const body = { endpoint, deployments: depsObj, weight: Number(m.querySelector("#nf-weight").value) || 1, enabled: m.querySelector("#nf-enabled").value === "1" };
      const keyInput = m.querySelector("#nf-key").value;
      if (isEdit) { if (keyInput) body.apiKey = keyInput; }
      else {
        if (!keyInput) { msg.textContent = "请填写上游 API Key"; return; }
        body.apiKey = keyInput;
        body.name = name;
      }
      try {
        await api(isEdit ? `/admin/nodes/${encodeURIComponent(name)}` : "/admin/nodes", { method: isEdit ? "PUT" : "POST", body });
        closeModal(); toast(isEdit ? "节点已更新 ✓" : "节点已创建 ✓"); loadNodes();
      } catch (err) { msg.textContent = err.message; }
    });
  }

  function wireNodes() {
    $("#nodes-add").addEventListener("click", () => nodeFormModal(null, null));
    $("#nodes-list").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-nact]");
      if (!btn) return;
      const name = btn.dataset.name;
      const n = state.nodes.find((x) => x.name === name);
      if (!n) return;
      if (btn.dataset.nact === "edit") nodeFormModal(null, n);
      if (btn.dataset.nact === "resetbreaker") {
        try {
          await api(`/admin/breakers/${encodeURIComponent(name)}/reset`, { method: "POST" });
          toast("熔断器已复位 ✓");
          loadNodes();
        } catch (err) { toast(err.message, "err"); }
      }
      if (btn.dataset.nact === "del") {
        if (!(await confirmDialog(`删除节点「${name}」？`))) return;
        try { await api(`/admin/nodes/${encodeURIComponent(name)}`, { method: "DELETE" }); toast("已删除"); loadNodes(); }
        catch (err) { toast(err.message, "err"); }
      }
    });
  }

  // ---------- 服务主体 ----------
  const spRow = (s) => `
    <tr>
      <td><b>${esc(s.label || s.id)}</b><div class="sub mono">${esc(s.id)}</div></td>
      <td class="mono">${esc(s.tenantId)}</td>
      <td class="mono">${esc(s.clientId)}</td>
      <td class="mono">${esc(s.clientSecretMasked)}</td>
      <td class="mono">${shortTime(s.updatedAt)}</td>
      <td class="actions">
        <button class="btn sm ghost" data-sact="edit" data-id="${esc(s.id)}">编辑</button>
        <button class="btn sm ghost" data-sact="token" data-id="${esc(s.id)}">刷新令牌</button>
        <button class="btn sm ghost" data-sact="revoke" data-id="${esc(s.id)}">失效令牌</button>
        <button class="btn sm danger" data-sact="del" data-id="${esc(s.id)}">删除</button>
      </td>
    </tr>`;

  async function loadSps() {
    const el = $("#sps-list");
    if (requireTokenNotice(el)) return;
    let data;
    try { data = await api("/admin/sps"); } catch (e) { renderError(el, e); return; }
    state.sps = data.sps ?? [];
    el.innerHTML = state.sps.length ? `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>标识</th><th>Tenant ID</th><th>Client ID</th><th>Secret</th><th>更新时间</th><th></th></tr></thead>
      <tbody>${state.sps.map(spRow).join("")}</tbody></table></div>`
      : `<div class="empty">还没有服务主体。添加后可在「☁️ Azure 资源」页浏览订阅与 OpenAI 账户。</div>`;
  }

  function spFormModal(existing) {
    const isEdit = !!existing;
    const m = openModal(`
      <h3>${isEdit ? `编辑服务主体 ${esc(existing.id)}` : "新增服务主体"}</h3>
      <div class="form-row"><label>ID ${isEdit ? "(只读)" : "(自定义标识, 如 sp-prod)"}</label>
        <input id="sf-id" ${isEdit ? "disabled" : ""} placeholder="sp-prod" value="${isEdit ? esc(existing.id) : ""}" /></div>
      <div class="form-row"><label>标签 (可选)</label><input id="sf-label" maxlength="128" value="${isEdit ? esc(existing.label ?? "") : ""}" /></div>
      <div class="form-row"><label>Tenant ID (目录 ID)</label><input id="sf-tenant" placeholder="00000000-0000-..." value="${isEdit ? esc(existing.tenantId) : ""}" /></div>
      <div class="form-row"><label>Client ID (应用程序 ID)</label><input id="sf-client" value="${isEdit ? esc(existing.clientId) : ""}" /></div>
      <div class="form-row"><label>Client Secret ${isEdit ? "(留空保留原值)" : ""}</label><input id="sf-secret" type="password" autocomplete="off" placeholder="${isEdit ? "••••••" : "客户端密码"}" /></div>
      <div class="form-hint" id="sf-msg"></div>
      <div class="modal-foot">
        <button class="btn ghost" data-act="cancel">取消</button>
        <button class="btn primary" data-act="save">${isEdit ? "保存" : "创建"}</button>
      </div>`);
    m.addEventListener("click", async (e) => {
      const act = e.target?.dataset?.act;
      if (act === "cancel") closeModal();
      if (act !== "save") return;
      const msg = m.querySelector("#sf-msg");
      const body = {
        label: m.querySelector("#sf-label").value.trim() || null,
        tenantId: m.querySelector("#sf-tenant").value.trim(),
        clientId: m.querySelector("#sf-client").value.trim(),
      };
      const secret = m.querySelector("#sf-secret").value;
      const id = isEdit ? existing.id : m.querySelector("#sf-id").value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) { msg.textContent = "ID: 1-64 位字母数字或 . _ -"; return; }
      if (!body.tenantId || !body.clientId) { msg.textContent = "Tenant ID 与 Client ID 必填"; return; }
      if (secret) body.clientSecret = secret;
      try {
        await api(isEdit ? `/admin/sps/${encodeURIComponent(id)}` : "/admin/sps", { method: isEdit ? "PUT" : "POST", body });
        closeModal(); toast(isEdit ? "服务主体已更新 ✓" : "服务主体已创建 ✓"); loadSps();
      } catch (err) { msg.textContent = err.message; }
    });
  }

  /** 一键粘贴 Azure CLI JSON: 自动解析回填 → 验真 → 订阅穿透入库 */
  function spImportJsonModal() {
    const m = openModal(`
      <h3>📋 一键粘贴服务主体 JSON</h3>
      <p class="muted">粘贴 <code>az ad sp create-for-rbac</code> 输出的标准 JSON，系统将校验凭据并自动发现关联订阅。</p>
      <div class="form-row"><label>JSON 文本</label>
        <textarea id="si-json" rows="6" spellcheck="false" placeholder='{\n  "appId": "...",\n  "displayName": "...",\n  "password": "...",\n  "tenant": "..."\n}'></textarea></div>
      <div class="form-cols">
        <div class="form-row"><label>自定义 ID (选填)</label><input id="si-id" placeholder="sp-prod" value="" /></div>
        <div class="form-row"><label>标签 (选填)</label><input id="si-label" placeholder="默认取 displayName" value="" /></div>
      </div>
      <div class="form-hint" id="si-msg"></div>
      <div class="modal-foot">
        <button class="btn ghost" data-act="cancel">取消</button>
        <button class="btn primary" data-act="save">验证并导入</button>
      </div>`);
    m.addEventListener("click", async (e) => {
      const act = e.target?.dataset?.act;
      if (act === "cancel") { closeModal(); return; }
      if (act !== "save") return;
      const msg = m.querySelector("#si-msg");
      const json = m.querySelector("#si-json").value.trim();
      if (!json) { msg.textContent = "请粘贴 JSON"; msg.style.color = "var(--err)"; return; }
      const body = {
        json,
        id: m.querySelector("#si-id").value.trim() || undefined,
        label: m.querySelector("#si-label").value.trim() || undefined,
      };
      msg.textContent = "验真中… (OAuth2 + 订阅穿透)"; msg.style.color = "var(--muted)";
      const btn = m.querySelector('[data-act="save"]');
      btn.disabled = true;
      try {
        const r = await api("/admin/sps/import", { method: "POST", body });
        closeModal();
        toast(`已导入 ${r.label || r.sp}，发现 ${r.subCount} 个订阅 ✓`);
        loadSps();
        if (state.view === "warmup") loadWarmup();
        if (state.view === "quota") loadQuota();
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = "var(--err)";
        btn.disabled = false;
      }
    });
  }

  /** 同步全部服务主体 → 订阅图片入库 */
  async function syncAllSubs() {
    if (!state.sps.length) { toast("暂无服务主体可同步", "err"); return; }
    if (!(await confirmDialog("重新拉取全部服务主体名下的订阅并更新画像？", { danger: false, okText: "同步" }))) return;
    let count = 0;
    try {
      for (const sp of state.sps) {
        const r = await api(`/admin/subs/sync/${encodeURIComponent(sp.id)}`, { method: "POST" });
        count += r.subCount ?? 0;
      }
      toast(`同步完成：共 ${count} 个订阅`);
      if (state.view === "warmup") loadWarmup();
      if (state.view === "quota") loadQuota();
    } catch (e) { toast(e.message, "err"); }
  }

  function wireSps() {
    $("#sps-add").addEventListener("click", () => spFormModal(null));
    $("#sps-import-json").addEventListener("click", () => spImportJsonModal());
    $("#sps-sync-all").addEventListener("click", () => syncAllSubs());
    $("#sps-list").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-sact]");
      if (!btn) return;
      const id = btn.dataset.id;
      const s = state.sps.find((x) => x.id === id);
      const act = btn.dataset.sact;
      if (act === "edit" && s) spFormModal(s);
      if (act === "token") {
        try {
          const r = await api(`/admin/sps/${encodeURIComponent(id)}/token`, { method: "POST" });
          openModal(`<h3>🎫 令牌已刷新</h3><div class="kv">
            <div class="k">服务主体</div><div class="mono">${esc(id)}</div>
            <div class="k">来源</div><div>${esc(r.source ?? "—")}</div>
            <div class="k">过期时间</div><div class="mono">${esc(r.expiresOn ?? "—")}</div></div>
            <div class="modal-foot"><button class="btn primary" data-act="close">好的</button></div>`)
            .addEventListener("click", (ev) => { if (ev.target?.dataset?.act === "close") closeModal(); });
        } catch (err) { toast(err.message, "err"); }
      }
      if (act === "revoke") {
        try { await api(`/admin/sps/${encodeURIComponent(id)}/token`, { method: "DELETE" }); toast("已失效该主体的缓存令牌"); }
        catch (err) { toast(err.message, "err"); }
      }
      if (act === "del") {
        if (!(await confirmDialog(`删除服务主体「${id}」？`))) return;
        try { await api(`/admin/sps/${encodeURIComponent(id)}`, { method: "DELETE" }); toast("已删除"); loadSps(); }
        catch (err) { toast(err.message, "err"); }
      }
    });
  }

  // ---------- Azure 资源浏览器 ----------
  function initArm() {
    const sel = $("#arm-sp");
    if (!state.arm.inited) {
      state.arm.inited = true;
      wireArm();
    }
    return (async () => {
      if (requireTokenNotice($("#arm-status"))) return;
      try {
        if (!state.sps.length) state.sps = (await api("/admin/sps")).sps ?? [];
      } catch (e) { renderError($("#arm-status"), e); return; }
      const cur = sel.value;
      sel.innerHTML = state.sps.length
        ? state.sps.map((s) => `<option value="${esc(s.id)}" ${s.id === cur ? "selected" : ""}>${esc(s.label || s.id)}</option>`).join("")
        : `<option value="">— 请先在「服务主体」页添加 —</option>`;
      state.arm.sp = sel.value;
      if (!sel.value) {
        $("#arm-status").textContent = "暂无服务主体。";
        $("#arm-accounts").innerHTML = "";
        return;
      }
      if (!state.arm.subs) await loadSubs();
    })().catch((e) => renderError($("#arm-status"), e));
  }

  function wireArm() {
    $("#arm-sp").addEventListener("change", () => { state.arm.sp = $("#arm-sp").value; state.arm.subs = null; loadSubs(); });
    $("#arm-sub").addEventListener("change", async () => {
      state.arm.sub = $("#arm-sub").value;
      state.arm.rg = "";
      $("#arm-rg").innerHTML = `<option value="">全部</option>`;
      await Promise.all([loadRgs(), loadAccounts()]);
    });
    $("#arm-rg").addEventListener("change", () => { state.arm.rg = $("#arm-rg").value; renderAccounts(); });
    $("#arm-reload").addEventListener("click", async () => {
      state.arm.subs = null;
      if (state.arm.sp) await loadSubs();
    });
  }

  async function loadSubs() {
    const subSel = $("#arm-sub");
    $("#arm-status").innerHTML = `<span class="spin">◌</span> 正在加载订阅…`;
    try {
      const subs = await armList(`/admin/arm/${encodeURIComponent(state.arm.sp)}/subscriptions`);
      state.arm.subs = subs;
      subSel.innerHTML = subs.length
        ? subs.map((s) => `<option value="${esc(s.subscriptionId)}">${esc(s.displayName || s.subscriptionId)}</option>`).join("")
        : `<option value="">— 该主体无可用订阅 —</option>`;
      state.arm.sub = subSel.value;
      $("#arm-status").textContent = `共 ${subs.length} 个订阅。`;
      if (state.arm.sub) { await Promise.all([loadRgs(), loadAccounts()]); }
      else { $("#arm-accounts").innerHTML = ""; }
    } catch (e) {
      $("#arm-status").innerHTML = "";
      renderError($("#arm-status"), e);
    }
  }

  async function loadRgs() {
    const rgSel = $("#arm-rg");
    try {
      const rgs = await armList(`/admin/arm/${encodeURIComponent(state.arm.sp)}/subscriptions/${encodeURIComponent(state.arm.sub)}/resourcegroups`);
      rgSel.innerHTML = `<option value="">全部</option>` +
        rgs.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join("");
    } catch { rgSel.innerHTML = `<option value="">全部</option>`; }
  }

  const accRg = (acc) => (String(acc.id).match(/\/resourceGroups\/([^/]+)\/?/i)?.[1] ?? "");
  const accEndpoint = (acc) => acc.properties?.endpoint ?? "";

  async function loadAccounts() {
    const el = $("#arm-accounts");
    el.innerHTML = `<div class="panel muted"><span class="spin">◌</span> 正在加载 OpenAI / Cognitive 账户…</div>`;
    try {
      state.arm.accounts = await armList(`/admin/arm/${encodeURIComponent(state.arm.sp)}/subscriptions/${encodeURIComponent(state.arm.sub)}/accounts`);
    } catch (e) { el.innerHTML = ""; renderError(el, e); return; }
    renderAccounts();
  }

  function renderAccounts() {
    const el = $("#arm-accounts");
    const all = state.arm.accounts ?? [];
    const list = state.arm.rg ? all.filter((a) => accRg(a).toLowerCase() === state.arm.rg.toLowerCase()) : all;
    if (!all.length) { el.innerHTML = `<div class="panel"><div class="empty">该订阅下没有 OpenAI / Cognitive 账户</div></div>`; return; }
    el.innerHTML = `<div class="panel"><h2>账户 (${list.length}/${all.length})</h2>` + (list.length
      ? list.map((a) => `
        <div class="res-card">
          <div>
            <div class="res-name">${esc(a.name)} <span class="badge warn">${esc(a.kind ?? a.type?.split("/").pop() ?? "")}</span></div>
            <div class="res-meta">RG: ${esc(accRg(a))} · 位置: ${esc(a.location ?? "—")} · ${esc(accEndpoint(a) || "无 endpoint")}</div>
          </div>
          <div>
            <button class="btn sm primary" data-aact="dep" data-acc="${esc(a.name)}" data-rg="${esc(accRg(a))}">查看部署</button>
            <button class="btn sm ghost" data-aact="warmup" data-acc="${esc(a.name)}" data-rg="${esc(accRg(a))}">🌱 初始化养号</button>
          </div>
        </div>`).join("")
      : `<div class="empty">该资源组下没有账户</div>`) + `</div>`;
  }

  function wireArmAccounts() {
    $("#arm-accounts").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-aact]");
      if (!btn) return;
      const acc = (state.arm.accounts ?? []).find((a) => a.name === btn.dataset.acc);
      if (!acc) return;
      if (btn.dataset.aact === "dep") loadDeployments(acc, btn.dataset.rg);
      if (btn.dataset.aact === "warmup") armWarmupAccount(btn.dataset.rg);
    });
  }

  /** ARM 页: 对当前选中订阅一键初始化养号 (模块3: 资源页提供一键按钮) */
  async function armWarmupAccount(rg) {
    const subId = state.arm.sub;
    if (!subId) { toast("请先选择订阅", "err"); return; }
    let sub = (state.subs ?? []).find((x) => x.id === subId);
    if (!sub) {
      // 从 /admin/subs 拉取画像 (可能尚未同步)
      try {
        const data = await api("/admin/subs");
        state.subs = data.subs ?? [];
        sub = state.subs.find((x) => x.id === subId);
      } catch (e) { toast(e.message, "err"); return; }
    }
    if (!sub) {
      toast("该订阅还没有画像，请先在「🛡️ 服务主体」页同步订阅", "err");
      return;
    }
    const picked = await pickRegion(sub);
    if (picked === false) return;
    toast(`正在上架 ${picked ? `(${picked})` : ""} …`, "ok", 30000);
    try {
      const r = await runBootstrap(sub, picked || undefined);
      toast(`上架成功：${r.result.message}${picked ? ` (${picked})` : ""}`);
      loadWarmup();
    } catch (e) { toast(e.message, "err"); }
  }

  async function loadDeployments(acc, rg) {
    const el = $("#arm-deployments");
    el.innerHTML = `<div class="panel"><h2>部署 · ${esc(acc.name)}</h2><div class="muted"><span class="spin">◌</span> 加载中…</div></div>`;
    const path = `/admin/arm/${encodeURIComponent(state.arm.sp)}/subscriptions/${encodeURIComponent(state.arm.sub)}/resourceGroups/${encodeURIComponent(rg)}/accounts/${encodeURIComponent(acc.name)}/deployments`;
    let deps;
    try { deps = await armList(path); } catch (e) { el.innerHTML = ""; renderError(el, e); return; }
    const depMap = {};
    for (const d of deps) {
      const model = d.properties?.model?.name ?? d.name;
      if (model) depMap[model] = d.name;
    }
    el.innerHTML = `<div class="panel"><h2>部署 · ${esc(acc.name)}
        <button class="btn sm primary" data-aact="import" style="float:right">⬇ 导入为节点 (全部部署)</button></h2>
      ${deps.length ? deps.map((d) => `
        <div class="deploy-row">
          <span class="badge info">${esc(d.properties?.model?.name ?? "?")}</span>
          <span class="mono">${esc(d.name)}</span>
          <span class="muted">${esc(d.properties?.provisioningState ?? "")}</span>
          <button class="btn sm ghost" data-aact="import" data-only="${esc(d.name)}" style="margin-left:auto">仅导入此部署</button>
        </div>`).join("")
      : `<div class="empty">该账户暂无部署</div>`}</div>`;
    el.querySelectorAll("button[data-aact=import]").forEach((b) =>
      b.addEventListener("click", () => {
        const only = b.dataset.only;
        const map = only ? Object.fromEntries(Object.entries(depMap).filter(([, v]) => v === only)) : depMap;
        importAsNode(acc, map);
      })
    );
  }

  /** 导入为节点: listKeys 拿账户密钥 (失败则让用户手填), 预填节点表单 */
  async function importAsNode(acc, depMap) {
    const rg = accRg(acc);
    const path = `/admin/arm/${encodeURIComponent(state.arm.sp)}/subscriptions/${encodeURIComponent(state.arm.sub)}/resourceGroups/${encodeURIComponent(rg)}/accounts/${encodeURIComponent(acc.name)}/listKeys`;
    let apiKey = "";
    try {
      const keys = await api(path, { method: "POST" });
      apiKey = keys.key1 ?? keys.primaryKey ?? "";
    } catch { /* 无权限时让用户手填 */ }
    let name = String(acc.name).toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^[^a-z0-9]+/, "") || "imported-node";
    name = name.slice(0, 64);
    nodeFormModal({
      name,
      endpoint: accEndpoint(acc).replace(/\/+$/, ""),
      apiKey,
      deployments: depMap,
      weight: 1,
      enabled: true,
    }, null);
    toast(apiKey ? "已获取账户密钥，请确认后保存" : "无法自动获取密钥 (权限不足)，请手动粘贴", apiKey ? "ok" : "err");
  }

  // ---------- 养号打卡 (阶段六) ----------

  const warmupBadge = (s) => {
    switch (s ?? "Pending") {
      case "Active": return '<span class="badge on">Active · 打卡中</span>';
      case "Upgraded": return '<span class="badge info">Upgraded · 已提档</span>';
      case "Disabled": return '<span class="badge off">已停用</span>';
      default: return '<span class="badge warn">Pending · 未上架</span>';
    }
  };

  const tierTag = (t) => {
    const tier = t ?? "Unknown";
    if (/free/i.test(tier)) return `<span class="badge warn">Free Tier</span>`;
    return `<span class="badge on">${esc(tier)}</span>`;
  };

  const regionChips = (regions) =>
    (regions ?? []).length
      ? regions.map((r) => `<span class="badge info">${esc(r)}</span>`).join(" ")
      : '<span class="muted">未探测</span>';

  const subRow = (s) => `
    <tr>
      <td><b>${esc(s.name || s.id)}</b><div class="sub mono">${esc(s.id)}</div></td>
      <td class="mono">${esc(s.spId)}</td>
      <td>${tierTag(s.currentTier)}</td>
      <td>${regionChips(s.allowedRegions)}</td>
      <td>${warmupBadge(s.warmupStatus)}</td>
      <td>${s.warmupTarget ? '<span class="badge on">已上架</span>' : '<span class="badge off">未上架</span>'}</td>
      <td class="actions">
        <button class="btn sm ghost" data-wact="probe" data-id="${esc(s.id)}">🌐 探测区域</button>
        ${s.warmupStatus !== "Active" && s.warmupStatus !== "Upgraded"
          ? `<button class="btn sm primary" data-wact="bootstrap" data-id="${esc(s.id)}">🪴 一键上架</button>` : ""}
        <button class="btn sm ghost" data-wact="tier" data-id="${esc(s.id)}">📊 看 Tier</button>
        <button class="btn sm danger" data-wact="del" data-id="${esc(s.id)}">删除</button>
      </td>
    </tr>`;

  async function loadWarmup() {
    const el = $("#wu-subs");
    if (requireTokenNotice(el)) return;
    let data, logs;
    try {
      [data, logs] = await Promise.all([
        api("/admin/subs"),
        api("/admin/warmup/logs?limit=50").catch(() => ({ logs: [] })),
      ]);
    } catch (e) { renderError(el, e); return; }
    state.subs = data.subs ?? [];
    state.warmupLogs = logs.logs ?? [];
    const s = state.subs;
    const active = s.filter((x) => x.warmupStatus === "Active").length;
    $("#wu-summary").textContent = `共 ${s.length} 个订阅 · 打卡中 ${active} · 已提档 ${s.filter((x) => x.warmupStatus === "Upgraded").length}`;
    el.innerHTML = s.length ? `<table class="tbl">
      <thead><tr><th>订阅</th><th>服务主体</th><th>Tier</th><th>合规区域</th><th>打卡状态</th><th>上架</th><th></th></tr></thead>
      <tbody>${s.map(subRow).join("")}</tbody></table>`
      : `<div class="empty">还没有订阅画像。先在「🛡️ 服务主体」页一键粘贴 JSON 导入，或点击「服务主体」页的「↻ 同步全部订阅」。</div>`;
    renderWarmupLogs();
  }

  function warmupLogRow(l) {
    const ok = l.result_status === "Success";
    return `
      <tr>
        <td class="mono">${shortTime(l.created_at)}</td>
        <td class="mono">${esc(l.subscription_id)}</td>
        <td>${esc(l.instance_name)}</td>
        <td><span class="badge info">${esc(l.model_name)}</span></td>
        <td>${l.tokens_consumed ?? 0}</td>
        <td class="mono ${ok ? "st2" : "st5"}">${l.status_code ?? "—"}</td>
        <td>${fmtMs(l.response_time_ms)}</td>
        <td>${ok ? '<span class="badge on">Success</span>' : '<span class="badge off">Failed</span>'}</td>
        <td class="cell-err" title="${esc(l.error ?? "")}">${esc(l.error ?? "")}</td>
      </tr>`;
  }

  function renderWarmupLogs() {
    const el = $("#wu-logs");
    const logs = state.warmupLogs;
    el.innerHTML = logs.length ? `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>时间</th><th>订阅</th><th>实例</th><th>模型</th><th>Tokens</th><th>状态码</th><th>延迟</th><th>结果</th><th>错误</th></tr></thead>
      <tbody>${logs.map(warmupLogRow).join("")}</tbody></table></div>`
      : `<div class="empty">暂无打卡流水。</div>`;
  }

async function runBootstrap(sub, chosenRegion) {
    const opts = {};
    if (chosenRegion) opts.location = chosenRegion;
    return api(`/admin/subs/${encodeURIComponent(sub.id)}/bootstrap`, { method: "POST", body: opts });
  }

  async function bootstrapOne(sub) {
    const regions = sub.allowedRegions ?? [];
    if (!regions.length) {
      const go = await confirmDialog("该订阅尚无区域白名单。是否先自动探测合规区域？", { danger: false, okText: "先探测" });
      if (!go) return;
      try {
        const r = await api(`/admin/subs/${encodeURIComponent(sub.id)}/probe`, { method: "POST" });
        const found = r.allowedRegions ?? [];
        toast(found.length ? `探测到 ${found.length} 个合规区域：${found.join(", ")}` : "未探测到合规区域，将使用默认区域", found.length ? "ok" : "err");
        if (found.length) sub.allowedRegions = found;
      } catch (e) { toast(e.message, "err"); return; }
    }
    const picked = await pickRegion(sub);
    if (picked === false) return;
    try {
      const r = await runBootstrap(sub, picked || undefined);
      toast(picked ? `上架成功：${r.result.message} (${picked})` : `上架成功：${r.result.message}`);
      loadWarmup();
    } catch (e) { toast(e.message, "err"); }
  }

  /** 若存在白名单, 弹出区域选择; 返回所选区域 | null(直接用默认区域) | false(取消) */
  async function pickRegion(sub) {
    const regions = sub.allowedRegions ?? [];
    if (!regions.length) return null;
    return new Promise((resolve) => {
      const m = openModal(`<h3>🪴 一键上架 · ${esc(sub.id)}</h3>
        <div class="form-row"><label>选择部署区域 (来自探测白名单)</label>
          <select id="bs-loc">${regions.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select></div>
        <div class="modal-foot">
          <button class="btn ghost" data-act="cancel">取消</button>
          <button class="btn primary" data-act="ok">上架</button></div>`);
      m.addEventListener("click", (e) => {
        const act = e.target?.dataset?.act;
        if (act === "cancel") { closeModal(); resolve(false); }
        if (act === "ok") { const v = m.querySelector("#bs-loc")?.value; closeModal(); resolve(v || null); }
      });
    });
  }

  async function runWarmupNow() {
    toast("立即打卡中… (每日 Cron 任务可随时手动触发)", "ok", 8000);
    try {
      const r = await api("/admin/warmup/run", { method: "POST" });
      const s = r.summary || {};
      toast(`打卡完成：成功 ${s.ok} / 失败 ${s.failures} / 跳过 ${s.skipped}，提档 ${(s.upgraded ?? []).length}`, s.failures ? "err" : "ok");
      loadWarmup();
      if (state.view === "quota") loadQuota();
    } catch (e) { toast(e.message, "err"); }
  }

  function wireWarmup() {
    $("#wu-refresh").addEventListener("click", () => loadWarmup());
    $("#wu-run-now").addEventListener("click", () => runWarmupNow());
    $("#wu-bootstrap-all").addEventListener("click", async () => {
      const pend = state.subs.filter((s) => s.warmupStatus !== "Active" && s.warmupStatus !== "Upgraded");
      if (!pend.length) { toast("没有待上架的订阅"); return; }
      if (!(await confirmDialog(`对 ${pend.length} 个待上架订阅执行一键上架？将创建 AIServices 资源。`, { danger: true, okText: "全部上架" }))) return;
      toast(`开始上架 ${pend.length} 个订阅…`, "ok", 10000);
      let ok = 0;
      for (const sub of pend) {
        try {
          await runBootstrap(sub, null);
          ok++;
        } catch (e) { toast(`上架失败 ${sub.id}: ${e.message}`, "err"); }
      }
      toast(`完成：上架 ${ok}/${pend.length}`);
      loadWarmup();
    });
    $("#wu-subs").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-wact]");
      if (!btn) return;
      const id = btn.dataset.id;
      const sub = state.subs.find((x) => x.id === id);
      if (!sub) return;
      const act = btn.dataset.wact;
      if (act === "probe") {
        toast("正在探测合规区域…", "ok", 10000);
        try {
          const r = await api(`/admin/subs/${encodeURIComponent(id)}/probe`, { method: "POST" });
          const found = r.allowedRegions ?? [];
          toast(found.length ? `探测到 ${found.length} 个合规区域：${found.join(", ")}` : "未探测到合规区域", found.length ? "ok" : "err");
          loadWarmup();
        } catch (err) { toast(err.message, "err"); }
      }
      if (act === "bootstrap") bootstrapOne(sub);
      if (act === "tier") await viewTierModal(id);
      if (act === "del") {
        if (!(await confirmDialog(`删除订阅画像「${id}」？（不影响 Azure 资源）`))) return;
        try { await api(`/admin/subs/${encodeURIComponent(id)}`, { method: "DELETE" }); toast("已删除"); loadWarmup(); }
        catch (err) { toast(err.message, "err"); }
      }
    });
  }

  async function viewTierModal(id) {
    try {
      const r = await api(`/admin/subs/${encodeURIComponent(id)}/tier`);
      const t = r.tier || {};
      openModal(`<h3>📊 Tier 状态 · ${esc(id)}</h3><div class="kv">
        <div class="k">当前 Tier</div><div>${tierTag(t.currentTierName)}</div>
        <div class="k">分配时间</div><div class="mono">${esc(t.assignedTime ?? "—")}</div>
        <div class="k">不可升级原因</div><div>${esc(t.upgradeUnavailabilityReason ?? "—")}</div>
        <div class="k">提档策略</div><div class="mono" style="white-space:pre-wrap">${esc(JSON.stringify(t.tierUpgradePolicy ?? {}, null, 2))}</div></div>
        <div class="modal-foot"><button class="btn primary" data-act="close">好的</button></div>`)
        .addEventListener("click", (ev) => { if (ev.target?.dataset?.act === "close") closeModal(); });
    } catch (err) { toast(err.message, "err"); }
  }
  // ---------- 设置 ----------
  async function loadSettings() {
    const healthEl = $("#set-health");
    const armEl = $("#set-arm");
    try {
      const h = await api("/admin/health");
      healthEl.innerHTML = `<div class="kv">
        <div class="k">服务</div><div>${esc(h.service ?? "—")}</div>
        <div class="k">服务器时间</div><div class="mono">${esc(h.time ?? "—")}</div>
        <div class="k">站点地址</div><div class="mono">${esc(location.origin)}</div></div>`;
    } catch (e) { renderError(healthEl, e); }
    try {
      const a = await api("/admin/arm");
      armEl.innerHTML = `<div class="kv">
        <div class="k">ARM Base</div><div class="mono">${esc(a.armBaseUrl ?? "—")}</div>
        <div class="k">Token Scope</div><div class="mono">${esc(a.armScope ?? "—")}</div>
        <div class="k">默认 API 版本</div><div class="mono">${esc(a.defaultApiVersion ?? "—")}</div></div>`;
    } catch (e) { renderError(armEl, e); }
    $("#set-snippet").textContent =
`# 以任意网关 Key 调用 (与 OpenAI SDK 兼容)
curl ${location.origin}/v1/chat/completions \\
  -H "Authorization: Bearer sk-az-..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"你好"}]}'

# 流式: 追加 "stream": true (SSE 透传, 用量仍在后台统计)`;
  }

  // ---------- 阶段五: 面板手动巡检 ----------
// ---------- 配额与 Tier (阶段六) ----------

  async function loadQuota() {
    const el = $("#qt-sub");
    if (requireTokenNotice($("#qt-tier"))) return;
    try {
      const data = await api("/admin/subs");
      state.quota.subs = data.subs ?? [];
    } catch (e) { renderError($("#qt-tier"), e); return; }
    const sel = state.quota.sel;
    el.innerHTML = state.quota.subs.length
      ? state.quota.subs.map((s) => `<option value="${esc(s.id)}" ${s.id === sel ? "selected" : ""}>${esc(s.name || s.id)}</option>`).join("")
      : `<option value="">— 请先导入订阅 —</option>`;
    state.quota.sel = el.value;
  }

  function qtyTable(tier, usage) {
    const mk = (v) => (v == null ? "—" : v);
    const rows = (usage?.items ?? []).map((it) => {
      const cur = it.currentValue ?? 0;
      const lim = it.limit ?? 0;
      const pct = lim ? Math.min(100, Math.round((cur / lim) * 100)) : 0;
      return `<tr>
        <td>${esc(it.name ?? "—")}</td>
        <td class="mono">${fmtInt(cur)}</td>
        <td class="mono">${fmtInt(lim)}</td>
        <td>${esc(it.unit ?? "—")}</td>
        <td>
          <div class="meter"><div class="meter-fill" style="width:${pct}%"></div></div>
          <span class="muted">${pct}%</span>
        </td></tr>`;
    }).join("");
    return `
      <div class="kv">
        <div class="k">当前 Tier</div><div>${tierTag(tier?.currentTierName ?? "Unknown")}</div>
        <div class="k">分配时间</div><div class="mono">${esc(mk(tier?.assignedTime))}</div>
        <div class="k">检查时间</div><div class="mono">${shortTime(new Date().toISOString())}</div>
        <div class="k">不可升级原因</div><div>${esc(mk(tier?.upgradeUnavailabilityReason))}</div>
      </div>
      <div class="panel" style="margin-top:14px">
        <h2>配额水位 ${usage ? `· ${esc(usage.location)}` : ""}</h2>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>指标</th><th>当前</th><th>限额</th><th>单位</th><th>使用率</th></tr></thead>
          <tbody>${rows ? rows : '<tr><td colspan="5" class="muted">该区域暂无配额数据</td></tr>'}</tbody></table></div>
      </div>`;
  }

  function renderQuota(tier, usage) {
    const tierEl = $("#qt-tier");
    const usageEl = $("#qt-usage");
    if (!tier) {
      tierEl.innerHTML = '<div class="empty">尚无数据，点击「📡 拉取 Tier 与配额」</div>';
      usageEl.innerHTML = "";
    } else {
      tierEl.innerHTML = qtyTable(tier, usage);
      usageEl.innerHTML = "";
    }
  }

  function wireQuota() {
    $("#qt-sub").addEventListener("change", () => { state.quota.sel = $("#qt-sub").value; });
    $("#qt-load").addEventListener("click", async () => {
      const id = $("#qt-sub").value;
      const loc = $("#qt-location").value.trim() || "centralus";
      if (!id) { toast("请先选择订阅", "err"); return; }
      $("#qt-tier").innerHTML = '<div class="muted"><span class="spin">◌</span> 拉取中…</div>';
      try {
        const tierR = await api(`/admin/subs/${encodeURIComponent(id)}/tier`).catch(() => null);
        const usageR = await api(`/admin/subs/${encodeURIComponent(id)}/usage-snapshot?location=${encodeURIComponent(loc)}`).catch(() => null);
        renderQuota(tierR?.tier ?? null, usageR?.snapshot ?? null);
        const pol = tierR?.tier?.tierUpgradePolicy;
        const tEl = $("#qt-policy");
        tEl.className = "";
        tEl.innerHTML = `<div class="kv">
          <div class="k">currentTierName</div><div>${esc(tierR?.tier?.currentTierName ?? "—")}</div>
          <div class="k">upgradeUnavailabilityReason</div><div>${esc(tierR?.tier?.upgradeUnavailabilityReason ?? "—")}</div>
          <div class="k">tierUpgradePolicy</div><div class="mono" style="white-space:pre-wrap">${esc(JSON.stringify(pol ?? {}, null, 2))}</div></div>`;
        toast(usageR ? `已拉取 ${loc} 配额 (${(usageR.snapshot?.items ?? []).length} 项)` : "Tier 拉取成功，配额不可用", usageR ? "ok" : "err");
      } catch (e) {
        $("#qt-tier").innerHTML = "";
        renderError($("#qt-tier"), e);
      }
    });
    $("#qt-clear").addEventListener("click", () => {
      state.quota.tier = null;
      state.quota.usage = null;
      renderQuota(null, null);
      $("#qt-policy").className = "muted";
      $("#qt-policy").textContent = "选择订阅后点击「拉取」查看详细提档资格与限制。";
    });
  }
  async function runPatrolNow() {
    const out = $("#set-patrol-out");
    out.style.display = "block";
    out.textContent = "巡检中… (节点探活 / 令牌预热 / 日志清理)";
    try {
      const res = await api("/admin/patrol", { method: "POST" });
      out.textContent = JSON.stringify(res.summary, null, 2);
      toast("巡检完成 ✓");
    } catch (e) {
      out.textContent = `巡检失败: ${e.message}`;
      toast(e.message, "err");
    }
  }

  // ---------- 初始化 ----------
  function boot() {
    document.querySelectorAll("#nav a").forEach((a) =>
      a.addEventListener("click", (e) => { e.preventDefault(); showView(a.dataset.view); }));
    $("#btn-refresh").addEventListener("click", () => { healthCheck(); loadCurrentView(true); });
    $("#btn-token").addEventListener("click", () => tokenModal());
    $("#set-token").addEventListener("click", () => tokenModal());
    $("#ov-days").addEventListener("change", () => loadOverview());
    $("#ov-key").addEventListener("change", () => loadOverview());
    wireKeys();
    wireLogs();
    wireNodes();
    wireSps();
    wireArmAccounts();
    wireWarmup();
    wireQuota();
    $("#set-patrol-run").addEventListener("click", runPatrolNow);

    window.addEventListener("hashchange", () => {
      const name = location.hash.replace("#", "") || "overview";
      if (name !== state.view) showView(name);
    });

    healthCheck();
    showView(location.hash.replace("#", "") || "overview");

    if (!state.token) setTimeout(() => tokenModal({ first: true }), 300);
  }

  boot();
})();