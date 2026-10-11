'use strict';
/* Order Tracker: static PWA. Orders live in a PRIVATE GitHub repo (orders.json) and are read/written
   with the GitHub contents API using a fine-grained token kept only in this browser's localStorage. */
(() => {
const API = 'https://api.github.com';
const FILE = 'orders.json';
const DEFAULT_REPO = 'braydendueck/order-tracker-data';
const LS = { token: 'ot.token', repo: 'ot.repo', cache: 'ot.cache', pending: 'ot.pending' };
const STATUSES = [['ordered', 'Ordered'], ['shipped', 'Shipped'], ['out_for_delivery', 'Out for delivery'], ['delivered', 'Delivered'], ['returned', 'Returned'], ['refunded', 'Refunded'], ['cancelled', 'Cancelled']];
const LABEL = Object.fromEntries(STATUSES);
const IN_TRANSIT = new Set(['ordered', 'shipped', 'out_for_delivery']);
const NEXT = { ordered: 'shipped', shipped: 'out_for_delivery', out_for_delivery: 'delivered' };
const NOT_SPENT = new Set(['cancelled', 'returned', 'refunded']);
const FIELDS = ['retailer', 'items', 'orderDate', 'total', 'orderNumber', 'status', 'carrier', 'trackingUrl', 'expectedStart', 'expectedEnd', 'expectedWindow', 'statusDate', 'notes'];
const CARRIERS = ['Canada Post', 'Purolator', 'UPS', 'FedEx', 'DHL', 'Canpar', 'Intelcom', 'Amazon', 'Instacart', 'Store pickup'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=Order+Tracker+phone&description=Order+Tracker+app%3A+read%2Fwrite+orders.json+in+order-tracker-data+only&target_name=braydendueck&expires_in=90&contents=write';
const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

const $ = s => document.querySelector(s);
const main = $('#main');
const S = {
  token: localStorage.getItem(LS.token) || '',
  repo: localStorage.getItem(LS.repo) || DEFAULT_REPO,
  base: { version: 1, orders: [] }, sha: null, syncedAt: null, loaded: false,
  pending: [], view: 'list', filter: 'all', q: '', month: null,
  net: 'idle', // idle | loading | saving | offline | error
  problem: null, // {kind, msg}
};

// ---------- helpers ----------
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDay(new Date());
const parseDay = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const dayDiff = (a, b) => Math.round((parseDay(a) - parseDay(b)) / 864e5);
function fmtDay(s, opts = {}) {
  const d = parseDay(s); if (!d) return '';
  const y = d.getFullYear() !== new Date().getFullYear() ? `, ${d.getFullYear()}` : '';
  return `${opts.dow ? DOW[d.getDay()] + ', ' : ''}${MON[d.getMonth()]} ${d.getDate()}${y}`;
}
function fmtRange(a, b) {
  if (!b || b === a) return fmtDay(a, { dow: true });
  const da = parseDay(a), db = parseDay(b);
  if (da && db && da.getMonth() === db.getMonth() && da.getFullYear() === db.getFullYear()) return `${fmtDay(a)}–${db.getDate()}`;
  return `${fmtDay(a)} – ${fmtDay(b)}`;
}
const isUrl = u => /^https?:\/\/[^\s]+$/i.test(u || '');
function parseTotal(v) {
  const t = String(v == null ? '' : v).replace(/[$,\s]|CAD/gi, '');
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(parseFloat(t) * 100) / 100;
}
const uid = () => 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clone = o => JSON.parse(JSON.stringify(o));
function b64encode(str) { const bytes = new TextEncoder().encode(str); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); }
function b64decode(b64) { const bin = atob(String(b64).replace(/\s/g, '')); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new TextDecoder().decode(bytes); }
let toastT;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); }
function ago(ts) { if (!ts) return 'never'; const m = Math.round((Date.now() - ts) / 6e4); if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 24) return `${h} h ago`; return new Date(ts).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }); }

// ---------- data model ----------
function normalize(o) { const n = { id: o.id || uid() }; for (const f of FIELDS) n[f] = o[f] == null ? (f === 'total' ? null : '') : o[f]; if (!LABEL[n.status]) n.status = 'ordered'; for (const k of ['createdAt', 'updatedAt']) if (o[k]) n[k] = o[k]; return n; }
function applyOps(data, ops) {
  const out = clone(data || { version: 1, orders: [] }); out.orders = (out.orders || []).map(normalize);
  for (const op of ops) {
    const i = out.orders.findIndex(o => o.id === op.id);
    if (op.op === 'delete') { if (i >= 0) out.orders.splice(i, 1); continue; }
    if (i >= 0) Object.assign(out.orders[i], op.fields, { updatedAt: op.at });
    else if (op.create) out.orders.push(normalize({ ...op.fields, id: op.id, createdAt: op.at, updatedAt: op.at }));
  }
  return out;
}
const current = () => applyOps(S.base, S.pending).orders;
const sortDate = o => o.orderDate || o.statusDate || o.expectedStart || '';
function sortOrders(list) {
  const transit = list.filter(o => IN_TRANSIT.has(o.status)).sort((a, b) =>
    (a.expectedStart || '9999') .localeCompare(b.expectedStart || '9999') || (a.expectedEnd || a.expectedStart || '9999').localeCompare(b.expectedEnd || b.expectedStart || '9999') || sortDate(a).localeCompare(sortDate(b)));
  const rest = list.filter(o => !IN_TRANSIT.has(o.status)).sort((a, b) => sortDate(b).localeCompare(sortDate(a)) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return { transit, rest };
}
function monthSpend(list, ym) {
  const os = list.filter(o => sortDate(o).slice(0, 7) === ym && !NOT_SPENT.has(o.status));
  const known = os.filter(o => typeof o.total === 'number');
  return { total: Math.round(known.reduce((s, o) => s + o.total, 0) * 100) / 100, count: os.length, unknown: os.length - known.length };
}
function persist() {
  localStorage.setItem(LS.cache, JSON.stringify({ data: S.base, sha: S.sha, at: S.syncedAt, repo: S.repo }));
  localStorage.setItem(LS.pending, JSON.stringify(S.pending));
}
function restore() {
  try { const c = JSON.parse(localStorage.getItem(LS.cache) || 'null'); if (c && c.repo === S.repo) { S.base = c.data; S.sha = c.sha; S.syncedAt = c.at; S.loaded = true; } } catch (e) { /* ignore */ }
  try { S.pending = JSON.parse(localStorage.getItem(LS.pending) || '[]'); } catch (e) { S.pending = []; }
}

// ---------- GitHub API ----------
class ApiError extends Error { constructor(kind, msg, status) { super(msg); this.kind = kind; this.status = status; } }
async function gh(path, opts = {}, token = S.token) {
  let r;
  try {
    r = await fetch(API + path, { ...opts, cache: 'no-store', headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
  } catch (e) { throw new ApiError('offline', 'No connection to GitHub.'); }
  if (r.ok) return r.json();
  let body = {}; try { body = await r.json(); } catch (e) { /* ignore */ }
  const m = body.message || '';
  if (r.status === 401) throw new ApiError('auth', 'GitHub rejected the token (wrong, revoked or expired).', 401);
  if (r.status === 404) throw new ApiError('notfound', 'Not found', 404);
  if (r.status === 409 || (r.status === 422 && /sha/i.test(m))) throw new ApiError('conflict', 'Changed elsewhere', r.status);
  if (r.status === 403 && /rate limit/i.test(m)) throw new ApiError('rate', 'GitHub rate limit hit. Try again in a few minutes.', 403);
  if (r.status === 403) throw new ApiError('forbidden', 'This token is not allowed to do that. It needs Contents: Read and write on ' + S.repo + '.', 403);
  throw new ApiError('http', `GitHub error ${r.status}${m ? ': ' + m : ''}`, r.status);
}
async function fetchRemote(token = S.token, repo = S.repo) {
  try {
    const j = await gh(`/repos/${repo}/contents/${FILE}`, {}, token);
    const data = JSON.parse(b64decode(j.content));
    if (!data || !Array.isArray(data.orders)) throw new ApiError('http', 'orders.json is not in the expected format.');
    return { data, sha: j.sha };
  } catch (e) {
    if (e.kind !== 'notfound') throw e;
    try { await gh(`/repos/${repo}`, {}, token); } catch (e2) {
      if (e2.kind === 'notfound') throw new ApiError('norepo', `This token can't see ${repo}. Give it access to that repository.`);
      throw e2;
    }
    return { data: { version: 1, orders: [] }, sha: null }; // repo exists, file not created yet
  }
}
function commitMsg(ops) {
  if (ops.length > 1) return `App: ${ops.length} order changes`;
  const op = ops[0], o = current().find(x => x.id === op.id) || op.fields || {};
  const name = `${o.retailer || 'order'}${o.orderNumber ? ' #' + o.orderNumber : ''}`;
  if (op.op === 'delete') return `App: delete ${op.label || 'order'}`;
  if (op.create) return `App: add ${name}`;
  return `App: update ${name}${op.fields && op.fields.status ? ' (' + LABEL[op.fields.status] + ')' : ''}`;
}
let syncing = null;
function sync() { if (!syncing) syncing = doSync().finally(() => { syncing = null; }); return syncing; }
async function doSync() {
  let conflicts = 0, merged = false;
  while (S.pending.length && S.token) {
    const ops = S.pending.slice();
    const next = applyOps(S.base, ops); next.version = 1; next.updatedAt = new Date().toISOString();
    S.net = 'saving'; renderChrome();
    try {
      const body = { message: commitMsg(ops), content: b64encode(JSON.stringify(next, null, 2) + '\n') };
      if (S.sha) body.sha = S.sha;
      const res = await gh(`/repos/${S.repo}/contents/${FILE}`, { method: 'PUT', body: JSON.stringify(body) });
      S.base = next; S.sha = res.content.sha; S.syncedAt = Date.now();
      S.pending = S.pending.slice(ops.length); S.problem = null; S.net = 'idle'; persist();
    } catch (e) {
      if (e.kind === 'conflict' && conflicts < 3) {
        conflicts++; merged = true;
        try { const r = await fetchRemote(); S.base = r.data; S.sha = r.sha; persist(); continue; } catch (e2) { fail(e2); break; }
      }
      fail(e); break;
    }
  }
  if (merged && !S.pending.length) toast('Someone else changed orders too. Merged both.');
  render();
}
async function refresh() {
  if (!S.token) return;
  S.net = 'loading'; renderChrome();
  try {
    const r = await fetchRemote();
    S.base = r.data; S.sha = r.sha; S.syncedAt = Date.now(); S.loaded = true; S.problem = null; S.net = 'idle'; persist();
    if (S.pending.length) await sync(); else render();
  } catch (e) { fail(e); render(); }
}
function fail(e) {
  S.net = e.kind === 'offline' ? 'offline' : 'error';
  S.problem = { kind: e.kind, msg: e.message };
}

// ---------- edits ----------
function change(id, fields, opts = {}) {
  S.pending.push({ op: 'upsert', id, fields, at: new Date().toISOString(), create: !!opts.create });
  persist(); render(); sync();
}
function remove(id) {
  const o = current().find(x => x.id === id);
  S.pending.push({ op: 'delete', id, at: new Date().toISOString(), label: o ? `${o.retailer}${o.orderNumber ? ' #' + o.orderNumber : ''}` : '' });
  persist(); render(); sync();
}
function setStatus(id, status) {
  const o = current().find(x => x.id === id); if (!o || o.status === status) return;
  change(id, { status, statusDate: status === 'ordered' ? '' : today() });
  toast(`${o.retailer}: ${LABEL[status]}`);
}

// ---------- rendering ----------
function renderChrome() {
  const ss = $('#syncstate');
  const n = S.pending.length;
  let cls = '', txt = '';
  if (!S.token) txt = '';
  else if (S.net === 'saving') { cls = 'saving'; txt = 'Saving…'; }
  else if (S.net === 'loading') { cls = 'saving'; txt = 'Loading…'; }
  else if (S.net === 'offline') { cls = 'offline'; txt = n ? `Offline · ${n} unsaved` : 'Offline'; }
  else if (S.net === 'error') { cls = 'error'; txt = n ? `${n} unsaved` : 'Sync problem'; }
  else if (n) { cls = 'pending'; txt = `${n} unsaved`; }
  else if (S.syncedAt) txt = 'Synced';
  ss.className = 'syncstate ' + cls; ss.textContent = txt;
  $('#btnRefresh').hidden = !S.token; $('#btnSettings').hidden = !S.token;
  $('#btnSettings').classList.toggle('on', S.view === 'settings');
  const showAdd = !!S.token && S.view === 'list';
  $('#addbar').hidden = !showAdd; document.body.classList.toggle('noadd', !showAdd);
  const b = $('#banner');
  const p = S.problem;
  if (!S.token || !p) { b.hidden = true; return; }
  b.hidden = false; b.className = 'banner' + (p.kind === 'offline' ? '' : ' err');
  if (p.kind === 'offline') b.innerHTML = `<span>Offline. Showing the copy saved ${esc(ago(S.syncedAt))}.${n ? ' Your changes will save when you are back online.' : ''}</span><button data-act="retry">Retry</button>`;
  else if (p.kind === 'auth' || p.kind === 'norepo' || p.kind === 'forbidden') b.innerHTML = `<span>${esc(p.msg)}${n ? ` ${n} change(s) are kept on this phone.` : ''}</span><button data-act="newtoken">New token</button>`;
  else b.innerHTML = `<span>${esc(p.msg)}</span><button data-act="retry">Retry</button>`;
}
function render() {
  renderChrome();
  if (!S.token || S.view === 'setup') return renderSetup();
  if (S.view === 'settings') return renderSettings();
  renderList();
}
function whenLine(o) {
  const t = today();
  if (IN_TRANSIT.has(o.status)) {
    if (!o.expectedStart) return `<div class="when">${o.expectedWindow ? 'Delivery ' + esc(o.expectedWindow) : 'No delivery date yet'}</div>`;
    const end = o.expectedEnd || o.expectedStart, win = o.expectedWindow ? `, ${esc(o.expectedWindow)}` : '';
    if (end < t) return `<div class="when late">Late: expected ${esc(fmtRange(o.expectedStart, o.expectedEnd))}${win}</div>`;
    if (o.expectedStart === t && end === t) return `<div class="when today">Arriving today${win}</div>`;
    if (o.expectedStart <= t) return `<div class="when today">Arriving by ${esc(fmtDay(end, { dow: true }))}${win}</div>`;
    const d = dayDiff(o.expectedStart, t);
    const rel = d === 1 && end === o.expectedStart ? 'tomorrow' : `in ${d} day${d > 1 ? 's' : ''}`;
    return `<div class="when">Expected ${esc(fmtRange(o.expectedStart, o.expectedEnd))}${win} <span class="muted">(${rel})</span></div>`;
  }
  if (o.statusDate) return `<div class="when past">${esc(LABEL[o.status])} ${esc(fmtDay(o.statusDate))}</div>`;
  if (o.expectedStart) return `<div class="when past">Was expected ${esc(fmtRange(o.expectedStart, o.expectedEnd))}${o.expectedWindow ? ', ' + esc(o.expectedWindow) : ''}</div>`;
  return '';
}
function card(o) {
  const meta = [];
  meta.push(`<span>Ordered <b>${o.orderDate ? esc(fmtDay(o.orderDate)) : '—'}</b></span>`);
  meta.push(`<span><b class="total">${typeof o.total === 'number' ? esc(money.format(o.total)) : 'Total unknown'}</b></span>`);
  if (o.orderNumber) meta.push(`<span class="onum">#${esc(o.orderNumber)}</span>`);
  if (o.carrier) meta.push(`<span>via <b>${esc(o.carrier)}</b></span>`);
  const nx = NEXT[o.status];
  return `<article class="order st-${o.status}" data-id="${esc(o.id)}">
    <div class="ohead"><div class="ret">${esc(o.retailer || 'Unknown retailer')}</div><button class="chip st-${o.status}" data-act="status" aria-label="Change status">${esc(LABEL[o.status])}</button></div>
    <div class="items${o.items ? '' : ' none'}">${o.items ? esc(o.items) : 'Items not listed'}</div>
    ${whenLine(o)}
    <div class="meta">${meta.join('')}</div>
    ${o.notes ? `<div class="notes">${esc(o.notes)}</div>` : ''}
    <div class="oact">
      ${isUrl(o.trackingUrl) ? `<a class="track" href="${esc(o.trackingUrl)}" target="_blank" rel="noopener noreferrer">Track</a>` : ''}
      ${nx ? `<button class="next" data-act="next">Mark ${esc(LABEL[nx].toLowerCase())}</button>` : ''}
      <button class="edit" data-act="edit">Edit</button>
    </div></article>`;
}
function matches(o, q) {
  if (!q) return true;
  const hay = [o.retailer, o.items, o.orderNumber, o.carrier, o.notes, LABEL[o.status]].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}
function renderList() {
  const all = current();
  if (!S.month) S.month = today().slice(0, 7);
  const sp = monthSpend(all, S.month);
  const [y, m] = S.month.split('-').map(Number);
  const isNow = S.month === today().slice(0, 7);
  const counts = { all: all.length, transit: all.filter(o => IN_TRANSIT.has(o.status)).length };
  for (const [k] of STATUSES) counts[k] = all.filter(o => o.status === k).length;
  const fl = [['all', 'All'], ['transit', 'On the way'], ...STATUSES].filter(([k]) => k === 'all' || k === 'transit' || counts[k] || S.filter === k);
  const shown = all.filter(o => (S.filter === 'all' || (S.filter === 'transit' ? IN_TRANSIT.has(o.status) : o.status === S.filter)) && matches(o, S.q));
  const { transit, rest } = sortOrders(shown);
  const activeEl = document.activeElement && document.activeElement.id === 'q';
  main.innerHTML = `
    <section class="summary" aria-label="Spending">
      <div class="mnav"><button data-act="mprev" aria-label="Previous month">‹</button>
        <div class="mcenter"><div class="mlabel">${isNow ? 'Spent this month' : 'Spent in'} · ${MONTH[m - 1]} ${y}</div>
        <div class="mtotal" id="monthTotal">${esc(money.format(sp.total))}</div>
        <div class="msub">${sp.count} order${sp.count === 1 ? '' : 's'}${sp.unknown ? ` · ${sp.unknown} total${sp.unknown === 1 ? '' : 's'} unknown` : ''} · ${counts.transit} on the way</div></div>
        <button data-act="mnext" aria-label="Next month" ${isNow ? 'disabled' : ''}>›</button></div>
    </section>
    <input id="q" class="search" type="search" placeholder="Search retailer, item, order #" value="${esc(S.q)}" autocomplete="off" enterkeyhint="search">
    <div class="filters" role="tablist">${fl.map(([k, l]) => `<button class="fchip${S.filter === k ? ' on' : ''}" data-filter="${k}">${esc(l)}<span class="n">${counts[k] || 0}</span></button>`).join('')}</div>
    ${!S.loaded ? '<div class="empty">Loading your orders…</div>' : ''}
    ${S.loaded && !shown.length ? `<div class="empty">${all.length ? 'No orders match.' : 'No orders yet. Tap “+ Add order”.'}</div>` : ''}
    ${transit.length ? `<h2>On the way <span class="n">${transit.length}</span></h2><div id="transit">${transit.map(card).join('')}</div>` : ''}
    ${rest.length ? `<h2>Delivered &amp; other <span class="n">${rest.length}</span></h2><div id="rest">${rest.map(card).join('')}</div>` : ''}`;
  if (activeEl) { const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}
function tokenSteps(withLink) {
  return `<ol class="steps">
    <li>Open ${withLink ? `<a href="${TOKEN_URL}" target="_blank" rel="noopener noreferrer">GitHub’s new fine-grained token page</a>` : 'the GitHub page (button above)'} and sign in as <b>braydendueck</b>. The name, a 90-day expiry and the Contents permission are filled in for you.</li>
    <li><b>Repository access:</b> choose <b>Only select repositories</b> and pick <b>order-tracker-data</b> only.</li>
    <li><b>Permissions:</b> check that <b>Contents</b> is <b>Read and write</b>. Add nothing else.</li>
    <li><b>Expiration:</b> keep an expiry (90 days is fine). When it runs out, this app asks for a new token.</li>
    <li>Tap <b>Generate token</b>, copy it (it starts with <code>github_pat_</code>) and paste it below.</li></ol>
    <p class="small muted">The token stays only on this device. It can only read and change the order list, nothing else on your GitHub.</p>`;
}
function renderSetup() {
  renderChrome(); $('#addbar').hidden = true; document.body.classList.add('noadd');
  main.innerHTML = `<div class="setup" id="setup">
    <div class="card"><h3>Connect your order list</h3>
      <p class="lead">Your orders are kept in your private GitHub repo <b>${esc(S.repo)}</b>. To let this phone read and update them, paste a GitHub access token once.</p>
      <a class="linkbtn" href="${TOKEN_URL}" target="_blank" rel="noopener noreferrer">Create the token on GitHub ↗</a>
      ${tokenSteps(false)}
      <form id="tokform" autocomplete="off">
        <label class="field"><span>Paste the token here</span><input id="tok" type="password" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
        <details><summary>Advanced: data repository</summary><label class="field"><span>owner/repo</span><input id="repo" value="${esc(S.repo)}" autocapitalize="off" spellcheck="false"></label></details>
        <div id="tokerr" class="err" hidden></div>
        <button class="primary" id="tokgo" type="submit">Connect</button>
        ${S.pending.length ? `<p class="small muted">${S.pending.length} unsaved change(s) on this phone will save after you connect.</p>` : ''}
      </form></div></div>`;
  $('#tokform').addEventListener('submit', async e => {
    e.preventDefault();
    const tok = $('#tok').value.trim(), repo = ($('#repo').value.trim() || DEFAULT_REPO).replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    const err = $('#tokerr'), go = $('#tokgo');
    err.hidden = true;
    if (!tok) return;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { err.textContent = 'Repository should look like owner/name.'; err.hidden = false; return; }
    go.disabled = true; go.textContent = 'Checking…';
    try {
      const r = await fetchRemote(tok, repo);
      const sameRepo = repo === S.repo;
      S.token = tok; S.repo = repo; localStorage.setItem(LS.token, tok); localStorage.setItem(LS.repo, repo);
      if (!sameRepo) S.pending = [];
      S.base = r.data; S.sha = r.sha; S.syncedAt = Date.now(); S.loaded = true; S.problem = null; S.net = 'idle'; S.view = 'list'; persist();
      if (S.pending.length) await sync(); else render();
      toast('Connected');
    } catch (ex) {
      err.textContent = ex.kind === 'auth' ? 'GitHub rejected this token. Check you copied all of it and that it has not expired.' : ex.message;
      err.hidden = false; go.disabled = false; go.textContent = 'Connect';
    }
  });
}
function renderSettings() {
  main.innerHTML = `<div class="card" id="settings"><h3>Sync</h3>
      <div class="kv"><span class="muted">Data repo</span><span>${esc(S.repo)} (private)</span></div>
      <div class="kv"><span class="muted">Last synced</span><span>${esc(ago(S.syncedAt))}</span></div>
      <div class="kv"><span class="muted">Unsaved changes</span><span>${S.pending.length}</span></div>
      <div class="kv"><span class="muted">Orders</span><span>${current().length}</span></div>
      <button class="secondary" data-act="retry">Refresh now</button>
      <button class="secondary" data-act="back">Back to orders</button></div>
    <div class="card"><h3>Token</h3><p class="small muted">Replace the token when it expires, or sign out to remove the token and the saved copy of your orders from this device.</p>
      <button class="secondary" data-act="newtoken">Enter a new token</button>
      <button class="dangerbtn" id="signout" data-act="signout">Sign out / forget token</button>
      <details><summary>How to create a token</summary>${tokenSteps(true)}</details></div>
    <p class="small muted">Order Tracker · data never leaves your GitHub and this device.</p>`;
}

// ---------- sheets ----------
const sheet = $('#sheet');
function openSheet(html, full) { sheet.innerHTML = `<div class="sheet${full ? ' full' : ''}" role="dialog" aria-modal="true">${html}</div>`; sheet.hidden = false; document.body.classList.add('locked'); }
function closeSheet() { sheet.hidden = true; sheet.innerHTML = ''; document.body.classList.remove('locked'); }
function statusSheet(id) {
  const o = current().find(x => x.id === id); if (!o) return;
  openSheet(`<div class="shead"><h3>${esc(o.retailer)}: set status</h3><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    <div class="stlist">${STATUSES.map(([k, l]) => `<button class="stbtn st-${k}${o.status === k ? ' cur' : ''}" data-setstatus="${k}" data-id="${esc(id)}"><span class="dot"></span>${esc(l)}</button>`).join('')}</div>`);
}
function formSheet(id) {
  const o = id ? current().find(x => x.id === id) : normalize({ status: 'ordered', orderDate: today() });
  if (!o) return;
  const retailers = [...new Set(current().map(x => x.retailer).filter(Boolean))];
  const f = (k, label, attrs = '') => `<label class="field" data-f="${k}"><span>${label}</span><input name="${k}" value="${esc(o[k] == null ? '' : o[k])}" ${attrs}></label>`;
  openSheet(`<form id="oform" novalidate><div class="shead"><h3>${id ? 'Edit order' : 'Add order'}</h3><button type="button" class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
    ${f('retailer', 'Retailer *', 'list="dl-ret" autocapitalize="words" required')}
    <label class="field"><span>Items</span><textarea name="items" rows="2">${esc(o.items)}</textarea></label>
    <div class="row2">${f('orderDate', 'Order date', 'type="date"')}${f('total', 'Total (CAD)', 'inputmode="decimal" placeholder="Unknown"')}</div>
    ${f('orderNumber', 'Order number', 'autocapitalize="off" spellcheck="false"')}
    <label class="field"><span>Status</span><select name="status">${STATUSES.map(([k, l]) => `<option value="${k}"${o.status === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    ${f('carrier', 'Carrier', 'list="dl-car"')}
    ${f('trackingUrl', 'Tracking link', 'type="url" inputmode="url" placeholder="https://…" autocapitalize="off" spellcheck="false"')}
    <div class="row2">${f('expectedStart', 'Expected delivery', 'type="date"')}${f('expectedEnd', 'Latest (if a range)', 'type="date"')}</div>
    ${f('expectedWindow', 'Time window', 'placeholder="e.g. 4:01–5:31 PM"')}
    ${f('statusDate', 'Delivered / picked up / cancelled on', 'type="date"')}
    <label class="field"><span>Notes</span><textarea name="notes" rows="2">${esc(o.notes)}</textarea></label>
    <div id="formerr" class="err" hidden></div>
    <button class="primary" type="submit">${id ? 'Save changes' : 'Add order'}</button>
    <button class="secondary" type="button" data-act="close">Cancel</button>
    ${id ? `<button class="dangerbtn" type="button" data-act="delete" data-id="${esc(id)}">Delete order</button>` : ''}
    <datalist id="dl-ret">${retailers.map(r => `<option value="${esc(r)}">`).join('')}</datalist>
    <datalist id="dl-car">${CARRIERS.map(r => `<option value="${esc(r)}">`).join('')}</datalist></form>`, true);
  $('#oform').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target), v = {};
    for (const k of FIELDS) v[k] = String(fd.get(k) == null ? '' : fd.get(k)).trim();
    const errs = [];
    sheet.querySelectorAll('.field.bad').forEach(x => x.classList.remove('bad'));
    const bad = (k, m) => { errs.push(m); const el = sheet.querySelector(`[data-f="${k}"]`); if (el) el.classList.add('bad'); };
    if (!v.retailer) bad('retailer', 'Retailer is required.');
    v.total = parseTotal(v.total); if (Number.isNaN(v.total)) bad('total', 'Total should be a number like 49.99, or blank if unknown.');
    if (v.trackingUrl && !isUrl(v.trackingUrl)) bad('trackingUrl', 'Tracking link should start with https://');
    if (v.expectedEnd && !v.expectedStart) { v.expectedStart = v.expectedEnd; v.expectedEnd = ''; }
    if (v.expectedEnd && v.expectedEnd < v.expectedStart) bad('expectedEnd', 'Latest date is before the expected date.');
    if (v.expectedEnd === v.expectedStart) v.expectedEnd = '';
    if (errs.length) { const fe = $('#formerr'); fe.textContent = errs.join(' '); fe.hidden = false; return; }
    if (id) {
      const diff = {}; for (const k of FIELDS) if ((o[k] == null ? '' : o[k]) !== (v[k] == null ? '' : v[k])) diff[k] = v[k];
      if (diff.status && !('statusDate' in diff) && !IN_TRANSIT.has(diff.status) && !o.statusDate) diff.statusDate = today();
      closeSheet();
      if (Object.keys(diff).length) { change(id, diff); toast('Saved'); }
    } else {
      if (!IN_TRANSIT.has(v.status) && !v.statusDate) v.statusDate = today();
      closeSheet(); change(uid(), v, { create: true }); toast('Order added');
    }
  });
}

// ---------- events ----------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act],[data-filter],[data-setstatus]'); if (!t) { if (e.target === sheet) closeSheet(); return; }
  if (t.dataset.filter) { S.filter = t.dataset.filter; return render(); }
  if (t.dataset.setstatus) { closeSheet(); return setStatus(t.dataset.id, t.dataset.setstatus); }
  const act = t.dataset.act, holder = t.closest('[data-id]'), id = holder ? holder.dataset.id : null;
  if (act === 'status') return statusSheet(id);
  if (act === 'next') { const o = current().find(x => x.id === id); return o && setStatus(id, NEXT[o.status]); }
  if (act === 'edit') return formSheet(id);
  if (act === 'close') return closeSheet();
  if (act === 'delete') { if (confirm('Delete this order?')) { closeSheet(); remove(t.dataset.id); toast('Deleted'); } return; }
  if (act === 'mprev' || act === 'mnext') { const [y, m] = S.month.split('-').map(Number); const d = new Date(y, m - 1 + (act === 'mprev' ? -1 : 1), 1); S.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; return render(); }
  if (act === 'retry') return refresh();
  if (act === 'back') { S.view = 'list'; return render(); }
  if (act === 'newtoken') { S.view = 'setup'; return render(); }
  if (act === 'signout') {
    const n = S.pending.length;
    if (!confirm(n ? `${n} change(s) have not been saved to GitHub yet and will be lost. Sign out anyway?` : 'Forget the token and the saved copy of your orders on this device?')) return;
    for (const k of Object.values(LS)) localStorage.removeItem(k);
    Object.assign(S, { token: '', repo: DEFAULT_REPO, base: { version: 1, orders: [] }, sha: null, syncedAt: null, loaded: false, pending: [], view: 'list', problem: null, net: 'idle' });
    render(); toast('Signed out. Token removed from this device.');
  }
});
$('#btnAdd').addEventListener('click', () => formSheet(null));
$('#btnRefresh').addEventListener('click', () => refresh());
$('#btnSettings').addEventListener('click', () => { S.view = S.view === 'settings' ? 'list' : 'settings'; render(); window.scrollTo(0, 0); });
main.addEventListener('input', e => { if (e.target.id === 'q') { S.q = e.target.value; renderList(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });
window.addEventListener('online', () => refresh());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.token && Date.now() - (S.syncedAt || 0) > 60e3) refresh(); });

// ---------- boot ----------
restore();
render();
if (S.token) refresh();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__OT = { applyOps, sortOrders, monthSpend, parseTotal, b64encode, b64decode, fmtRange, state: S };
})();
