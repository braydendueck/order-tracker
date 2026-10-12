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
const FIELDS = ['retailer', 'items', 'orderDate', 'total', 'orderNumber', 'status', 'carrier', 'trackingUrl', 'expectedStart', 'expectedEnd', 'expectedWindow', 'statusDate', 'notes',
  'lineItems', 'subtotal', 'shipping', 'tax', 'paymentBrand', 'paymentLast4', 'shipAddress', 'productUrl', 'emailLink', 'imageUrl'];
const MONEY = new Set(['total', 'subtotal', 'shipping', 'tax']);
const STEPS = ['ordered', 'shipped', 'out_for_delivery', 'delivered'];
const BRANDS = ['Visa', 'Mastercard', 'American Express', 'Interac', 'PayPal', 'Apple Pay', 'Google Pay', 'Gift card', 'Amazon balance'];
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
  pending: [], view: 'list', filter: 'all', q: '', month: null, detail: null, searchOpen: false,
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
function normalize(o) {
  const n = { id: o.id || uid() };
  for (const f of FIELDS) n[f] = o[f] == null ? (MONEY.has(f) ? null : f === 'lineItems' ? [] : '') : o[f];
  if (!Array.isArray(n.lineItems)) n.lineItems = []; if (!LABEL[n.status]) n.status = 'ordered'; for (const k of ['createdAt', 'updatedAt']) if (o[k]) n[k] = o[k]; return n; }
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
  buzz(); toast(`${o.retailer}: ${LABEL[status]}`);
}

// ---------- icons, motion, haptics ----------
const I = {
  chevL: '<path d="M15 18l-6-6 6-6"/>', chevR: '<path d="M9 6l6 6-6 6"/>', chevD: '<path d="M7 10l5 5 5-5"/>',
  bag: '<path d="M5 8h14l-1.2 12.2a1 1 0 0 1-1 .8H7.2a1 1 0 0 1-1-.8z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>',
  box: '<path d="M21 7.5l-9-4.5-9 4.5v9l9 4.5 9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9M7.5 5.2l9 4.6"/>',
  truck: '<path d="M2.5 6.5h11v9.5h-11zM13.5 9.5h4.2l3.3 3.3v3.2h-7.5"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  home: '<path d="M4 10.5L12 4l8 6.5V20H4z"/><path d="M9.5 20v-5.5h5V20"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  refund: '<circle cx="12" cy="12" r="9"/><path d="M14.8 9.3c-.5-.9-1.5-1.4-2.8-1.4-1.6 0-2.7.8-2.7 2s1 1.7 2.7 2.1 2.7.9 2.7 2.1-1.1 2-2.7 2c-1.4 0-2.4-.6-2.9-1.5M12 6v12"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19M6.5 15h4"/>',
  pin: '<path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 7.5l3 3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  alert: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  tag: '<path d="M3.5 12.5V4h8.5l9 9-8.5 8.5z"/><circle cx="8" cy="8.5" r="1.4"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
};
const ic = (n, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${I[n]}</svg>`;
const ST_ICON = { ordered: 'bag', shipped: 'box', out_for_delivery: 'truck', delivered: 'home', returned: 'undo', refunded: 'refund', cancelled: 'ban' };
const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
function buzz(ms = 10) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* not supported (iOS) */ } }
function hash(s) { let h = 0; for (const c of String(s || '').toLowerCase().replace(/\s*\(.*$/, '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
const letterOf = s => (String(s || '?').match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase();
function avatar(name, big) { return `<span class="av av${hash(name) % 6}${big ? ' big' : ''}" aria-hidden="true">${esc(letterOf(name))}</span>`; }
const fmtMoney = n => typeof n === 'number' ? money.format(n) : '';
const DOMAINS = [[/amazon/i, 'amazon.ca'], [/abellz/i, 'abellz.ca'], [/thermoworks/i, 'thermoworks.com'], [/instacart/i, 'instacart.ca'], [/canadian tire/i, 'canadiantire.ca'], [/bass ?pro/i, 'basspro.com'], [/best ?buy/i, 'bestbuy.ca'], [/costco/i, 'costco.ca'], [/walmart/i, 'walmart.ca'], [/ikea/i, 'ikea.com'], [/apple/i, 'apple.com'], [/pet ?valu/i, 'petvalu.ca'], [/home depot/i, 'homedepot.ca'], [/mec\b/i, 'mec.ca']];
function domainOf(o) {
  for (const [re, d] of DOMAINS) if (re.test(o.retailer || '')) return d;
  for (const u of [o.productUrl, o.trackingUrl]) if (isUrl(u)) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { /* ignore */ } }
  return '';
}
// Shop-style short name: "Instacart (Real Canadian Superstore)" -> "Instacart", "Amazon.ca" -> "Amazon"
const shortName = r => String(r || 'Unknown retailer').replace(/\s*\(.*\)\s*$/, '').replace(/^amazon\.ca$/i, 'Amazon') || String(r);
const IMG = u => `<img src="${esc(u)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
function logo(o, big) {
  const d = domainOf(o);
  return `<span class="logo${big ? ' big' : ''}" aria-hidden="true"><span class="lfb av${hash(o.retailer) % 6}">${esc(letterOf(o.retailer))}</span>${d ? IMG(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64`) : ''}</span>`;
}
const imagesOf = o => [...new Set([o.imageUrl, ...(o.lineItems || []).map(x => x.imageUrl)].filter(isUrl))];
const tile = (u, o, cls = '') => `<span class="tile${cls}"><span class="tfb av${hash(o.retailer) % 6}">${esc(letterOf(o.retailer))}</span>${u ? IMG(u) : ''}</span>`;
function thumbs(o, big) {
  const im = imagesOf(o);
  if (im.length > 1) return `<span class="thumbs stack${big ? ' big' : ''}">${tile(im[1], o, ' back')}${tile(im[0], o)}</span>`;
  return `<span class="thumbs${big ? ' big' : ''}">${tile(im[0], o)}</span>`;
}
const PKG = '<svg class="pkg" viewBox="0 0 22 22" aria-hidden="true"><rect x="2" y="3.5" width="18" height="15.5" rx="2.6" fill="#c8995a"/><rect x="2" y="3.5" width="18" height="5" rx="2.2" fill="#ddb57c"/><rect x="9.2" y="3.5" width="3.6" height="15.5" fill="#7b5cf5"/><rect x="14.6" y="12.4" width="3.6" height="4.2" rx=".7" fill="#fff" opacity=".9"/></svg>';
// Fill % by status and time (rounded to 5 for the CSS width classes):
// waiting for details 0 (icon at start) · ordered 15–45 by time elapsed toward the expected date · shipped 50–70 · out for delivery 85 · delivered 100
function progressPct(o) {
  const st = o.status; if (!STEPS.includes(st)) return -1;
  if (st === 'delivered') return 100;
  if (st === 'out_for_delivery') return 85;
  let f = null;
  const start = o.orderDate || '', end = o.expectedEnd || o.expectedStart || '';
  if (start && end) { const tot = dayDiff(end, start); f = tot > 0 ? Math.min(1, Math.max(0, dayDiff(today(), start) / tot)) : 1; }
  else if (end) f = end <= today() ? 1 : 0;
  if (st === 'shipped') return 50 + Math.round((f == null ? 0.5 : f) * 20);
  if (!o.expectedStart) return 0;
  return 15 + Math.round((f || 0) * 30);
}
function progress(o) {
  const pct = progressPct(o); if (pct < 0) return '';
  const w = Math.round(pct / 5) * 5;
  return `<div class="prog w${w}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(LABEL[o.status])}"><span class="pfill"></span>${PKG}<span class="prest"></span></div>`;
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
  $('#pill').hidden = !S.token || S.view === 'setup';
  $('#btnSearch').classList.toggle('on', !!S.searchOpen);
  $('#btnSettings').classList.toggle('on', S.view === 'settings');
  $('#navtitle').textContent = !S.token || S.view === 'setup' ? 'Connect' : S.view === 'settings' ? 'Settings' : 'Orders';
  const showAdd = !!S.token && S.view === 'list';
  $('#addbar').hidden = !showAdd; document.body.classList.toggle('noadd', !showAdd);
  const b = $('#banner');
  const p = S.problem;
  if (!S.token || !p) { b.hidden = true; return; }
  b.hidden = false; b.className = 'banner' + (p.kind === 'offline' ? '' : ' err');
  const icn = ic(p.kind === 'offline' ? 'clock' : 'alert');
  if (p.kind === 'offline') b.innerHTML = `${icn}<span>Offline. Showing the copy saved ${esc(ago(S.syncedAt))}.${n ? ' Your changes will save when you are back online.' : ''}</span><button data-act="retry">Retry</button>`;
  else if (p.kind === 'auth' || p.kind === 'norepo' || p.kind === 'forbidden') b.innerHTML = `${icn}<span>${esc(p.msg)}${n ? ` ${n} change(s) are kept on this phone.` : ''}</span><button data-act="newtoken">New token</button>`;
  else b.innerHTML = `${icn}<span>${esc(p.msg)}</span><button data-act="retry">Retry</button>`;
}
function render() {
  renderChrome();
  if (S.detail) renderDetail();
  if (!S.token || S.view === 'setup') return renderSetup();
  if (S.view === 'settings') return renderSettings();
  renderList();
}
// One Shop-style status line per order.
function etaText(o) {
  const t = today();
  if (IN_TRANSIT.has(o.status)) {
    if (!o.expectedStart) return { cls: 'wait', text: o.expectedWindow ? 'Delivery ' + o.expectedWindow : o.status === 'ordered' ? 'Waiting for details' : 'On the way' };
    const end = o.expectedEnd || o.expectedStart, win = o.expectedWindow ? `, ${o.expectedWindow}` : '';
    if (end < t) return { cls: 'late', text: `Late · expected ${fmtRange(o.expectedStart, o.expectedEnd)}` };
    if (o.expectedStart === t && end === t) return { cls: 'today', text: `Arrives today${win}` };
    if (o.expectedStart <= t) return { cls: 'today', text: `Arrives by ${fmtDay(end, { dow: true })}${win}` };
    const d = dayDiff(o.expectedStart, t);
    if (d === 1 && end === o.expectedStart) return { cls: '', text: `Arrives tomorrow${win}`, rel: 'tomorrow' };
    if (end === o.expectedStart) return { cls: '', text: `Arrives ${fmtDay(o.expectedStart, { dow: d < 7 })}${win}`, rel: `in ${d} days` };
    return { cls: '', text: `Arrives ${fmtRange(o.expectedStart, o.expectedEnd)}${win}`, rel: `in ${d} day${d > 1 ? 's' : ''}` };
  }
  if (o.statusDate) return { cls: 'past', text: `${LABEL[o.status]} ${fmtDay(o.statusDate)}` };
  return { cls: 'past', text: LABEL[o.status] };
}
function card(o) {
  const e = etaText(o);
  const swipe = IN_TRANSIT.has(o.status);
  return `<div class="swipe${swipe ? ' can' : ''}" data-id="${esc(o.id)}">${swipe ? `<div class="swipe-act" aria-hidden="true">${ic('check')}<span>Delivered</span></div>` : ''}
    <article class="order st-${o.status}${IN_TRANSIT.has(o.status) ? ' transit' : ''}" data-id="${esc(o.id)}" tabindex="0" aria-label="${esc(o.retailer)}: ${esc(e.text)}">
    <div class="ocol"><div class="ohead">${logo(o)}<span class="ret">${esc(shortName(o.retailer))}</span></div>
      <div class="when ${e.cls}">${esc(e.text)}</div>
      ${progress(o)}</div>
    ${thumbs(o)}
  </article></div>`;
}
function matches(o, q) {
  if (!q) return true;
  const hay = [o.retailer, o.items, o.orderNumber, o.carrier, o.notes, LABEL[o.status], ...(o.lineItems || []).map(x => x.name)].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}
const skeleton = () => `<div class="skel" aria-label="Loading your orders" role="status">${[0, 1, 2].map(() => `<div class="skelcard"><div class="sk-col"><span class="sk l1"></span><span class="sk l2"></span><span class="sk l3"></span></div><span class="sk tile"></span></div>`).join('')}</div>`;
function emptyState(all) {
  if (all) return `<div class="empty">${ic('search', 'big')}<div class="et">No orders match</div><div class="es">Try a different search or filter.</div><button class="ghost" data-act="clearfilter">Clear search &amp; filter</button></div>`;
  return `<div class="empty">${PKG}<div class="et">No orders yet</div><div class="es">Orders you or Margot add will show up here with their delivery status.</div><button class="ghost" data-act="add">${ic('plus')}Add your first order</button></div>`;
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
  const searching = S.searchOpen || S.q || S.filter !== 'all';
  main.innerHTML = `
    <section class="summary" aria-label="Spending">
      <div class="mnav"><button data-act="mprev" aria-label="Previous month">${ic('chevL')}</button>
        <div class="mcenter"><span class="mlabel">${isNow ? 'This month' : `${MONTH[m - 1]} ${y}`}</span> <span class="mtotal" id="monthTotal">${esc(money.format(sp.total))}</span>
        <div class="msub">${sp.count} order${sp.count === 1 ? '' : 's'}${sp.unknown ? ` · ${sp.unknown} total${sp.unknown === 1 ? '' : 's'} unknown` : ''} · ${counts.transit} on the way</div></div>
        <button data-act="mnext" aria-label="Next month" ${isNow ? 'disabled' : ''}>${ic('chevR')}</button></div>
    </section>
    <div class="searchpanel${searching ? ' open' : ''}" id="searchpanel">
      <div class="searchwrap">${ic('search')}<input id="q" class="search" type="search" placeholder="Search retailer, item, order #" value="${esc(S.q)}" autocomplete="off" enterkeyhint="search"></div>
      <div class="filters" role="tablist">${fl.map(([k, l]) => `<button class="fchip${S.filter === k ? ' on' : ''}" data-filter="${k}" role="tab" aria-selected="${S.filter === k}">${esc(l)}<span class="n">${counts[k] || 0}</span></button>`).join('')}</div>
    </div>
    ${!S.loaded ? skeleton() : ''}
    ${S.loaded && !shown.length ? emptyState(all.length) : ''}
    ${transit.length ? `<h2 class="sechead">On the way</h2><div id="transit">${transit.map(card).join('')}</div>` : ''}
    ${rest.length ? `<h2 class="sechead">Delivered &amp; other</h2><div id="rest">${rest.map(card).join('')}</div>` : ''}`;
  if (activeEl) { const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  onScroll();
}

// ---------- detail view ----------
const page = $('#page');
let pageT;
function timeline(o) {
  let steps = STEPS.slice();
  if (o.status === 'cancelled') steps = ['ordered', 'cancelled'];
  else if (o.status === 'returned' || o.status === 'refunded') steps = [...STEPS, o.status];
  const idx = steps.indexOf(o.status);
  const e = etaText(o);
  return `<ol class="timeline">${steps.map((k, i) => {
    const state = i < idx ? 'done' : i === idx ? 'cur' : 'todo';
    let sub = '';
    if (k === 'ordered') sub = o.orderDate ? fmtDay(o.orderDate, { dow: true }) : 'Order placed';
    else if (state === 'cur') sub = o.statusDate ? fmtDay(o.statusDate, { dow: true }) : 'Now';
    else if (state === 'done') sub = 'Done';
    else if (k === 'delivered') sub = o.expectedStart ? `Expected ${fmtRange(o.expectedStart, o.expectedEnd)}${o.expectedWindow ? ', ' + o.expectedWindow : ''}` : 'No delivery date yet';
    const desc = state === 'cur' && IN_TRANSIT.has(k) && e ? `<div class="tdesc ${e.cls}">${esc(e.text)}${e.rel ? ` <span class="muted">(${esc(e.rel)})</span>` : ''}</div>` : '';
    return `<li class="${state} t-${k}"><span class="tnode">${ic(state === 'done' ? 'check' : ST_ICON[k])}</span><div class="tbody"><div class="tl">${esc(LABEL[k])}</div><div class="ts">${esc(sub)}</div>${desc}</div></li>`;
  }).join('')}</ol>`;
}
const row = (label, value, cls = '') => `<div class="row ${cls}"><span class="rl">${label}</span><span class="rv">${value}</span></div>`;
const linkRow = (icon, label, href, sub = '') => `<a class="row link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${ic(icon, 'ri')}<span class="rl">${label}${sub ? `<small>${esc(sub)}</small>` : ''}</span>${ic('ext', 'rx')}</a>`;
function renderDetail() {
  const o = current().find(x => x.id === S.detail);
  if (!o) return closeDetail();
  const nx = NEXT[o.status];
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  const li = o.lineItems || [];
  const itemsHtml = li.length ? li.map(x => {
    const th = `<span class="ithumb">${tile(isUrl(x.imageUrl) ? x.imageUrl : '', o)}</span>`;
    const name = th + `<span class="iname">${x.qty > 1 ? `<b class="qty">${esc(x.qty)}×</b> ` : ''}${esc(x.name)}</span>`;
    const price = typeof x.price === 'number' ? `<span class="iprice">${esc(fmtMoney(x.price * (x.qty || 1)))}${x.qty > 1 ? `<small>${esc(fmtMoney(x.price))} each</small>` : ''}</span>` : '';
    return isUrl(x.url) ? `<a class="row item link" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${name}${price}${ic('chevR', 'rx')}</a>` : `<div class="row item">${name}${price}</div>`;
  }).join('') : `<div class="row item"><span class="iname${o.items ? '' : ' muted'}">${o.items ? esc(o.items) : 'Items not listed'}</span></div>`;
  const rc = [['Subtotal', o.subtotal], ['Shipping', o.shipping], ['Tax', o.tax]].filter(([, v]) => typeof v === 'number');
  const pay = o.paymentBrand || o.paymentLast4 ? `<div class="row">${ic('card', 'ri')}<span class="rl">${esc(o.paymentBrand || 'Card')}</span><span class="rv mono">${o.paymentLast4 ? '•••• ' + esc(o.paymentLast4) : ''}</span></div>` : '';
  const del = [];
  if (o.carrier) del.push(row('Carrier', esc(o.carrier)));
  if (o.expectedStart) del.push(row(IN_TRANSIT.has(o.status) ? 'Expected' : 'Was expected', esc(fmtRange(o.expectedStart, o.expectedEnd))));
  if (o.expectedWindow) del.push(row('Time window', esc(o.expectedWindow)));
  if (o.statusDate && !IN_TRANSIT.has(o.status)) del.push(row(esc(LABEL[o.status]), esc(fmtDay(o.statusDate, { dow: true }))));
  if (o.shipAddress) del.push(`<div class="row addr">${ic('pin', 'ri')}<span class="rl">Ship to<small>${esc(o.shipAddress)}</small></span></div>`);
  if (isUrl(o.trackingUrl)) del.push(linkRow('truck', 'Track package', o.trackingUrl, host(o.trackingUrl)));
  const links = [];
  if (isUrl(o.productUrl)) links.push(linkRow('tag', 'View product', o.productUrl, host(o.productUrl)));
  if (isUrl(o.emailLink)) links.push(linkRow('mail', 'Order confirmation email', o.emailLink, host(o.emailLink)));
  const e = etaText(o);
  const scroll = page.querySelector('.pscroll'); const keep = scroll && page.dataset.id === o.id ? scroll.scrollTop : 0;
  page.dataset.id = o.id;
  page.innerHTML = `<div class="pnav"><button class="navback" data-act="detailback" aria-label="Back to orders">${ic('chevL')}<span>Orders</span></button>
      <div class="ptitle">${esc(o.retailer)}</div><button class="navbtn" data-act="edit">Edit</button></div>
    <div class="pscroll"><div class="pinner" id="detail">
      <div class="hero">${thumbs(o, true)}
        <div class="dretrow">${logo(o)}<span class="dret">${esc(o.retailer || 'Unknown retailer')}</span></div>
        <h1 class="dstatus when ${e.cls}">${esc(e.text)}</h1>
        ${progress(o)}
        <div class="dsub">${o.orderNumber ? `<span class="onum">#${esc(o.orderNumber)}</span>` : ''}${o.orderDate ? `<span>Ordered ${esc(fmtDay(o.orderDate))}</span>` : ''}<span class="dtotal total">${typeof o.total === 'number' ? esc(money.format(o.total)) : 'Total unknown'}</span></div>
        <button class="chip st-${o.status}" data-act="status" aria-label="Change status: ${esc(LABEL[o.status])}">${esc(LABEL[o.status])}${ic('chevD')}</button>
      </div>
      <div class="quick">
        ${isUrl(o.trackingUrl) ? `<a class="qa track" href="${esc(o.trackingUrl)}" target="_blank" rel="noopener noreferrer">${ic('truck')}<span>Track</span></a>` : ''}
        ${nx ? `<button class="qa next" data-act="next">${ic(ST_ICON[nx])}<span>Mark ${esc(LABEL[nx].toLowerCase())}</span></button>` : ''}
        ${isUrl(o.emailLink) ? `<a class="qa" href="${esc(o.emailLink)}" target="_blank" rel="noopener noreferrer">${ic('mail')}<span>Email</span></a>` : ''}
        <button class="qa" data-act="edit">${ic('edit')}<span>Edit</span></button>
      </div>
      <div class="ghead">Status</div><div class="group pad" id="d-timeline">${timeline(o)}</div>
      <div class="ghead">Items${li.length ? ` <span class="n">${li.reduce((s, x) => s + (x.qty || 1), 0)}</span>` : ''}</div><div class="group" id="d-items">${itemsHtml}</div>
      <div class="ghead">Receipt</div><div class="group" id="d-receipt">${rc.map(([l, v]) => row(l, esc(fmtMoney(v)))).join('')}${row('Total', typeof o.total === 'number' ? esc(money.format(o.total)) : 'Unknown', 'strong')}</div>
      ${pay ? `<div class="ghead">Payment</div><div class="group" id="d-payment">${pay}</div>` : ''}
      ${del.length ? `<div class="ghead">Delivery</div><div class="group" id="d-delivery">${del.join('')}</div>` : ''}
      ${links.length ? `<div class="ghead">Links</div><div class="group" id="d-links">${links.join('')}</div>` : ''}
      ${o.notes ? `<div class="ghead">Notes</div><div class="group pad notesbox">${esc(o.notes)}</div>` : ''}
      <div class="group mt"><button class="row act" data-act="edit">${ic('edit', 'ri')}<span class="rl">Edit order</span>${ic('chevR', 'rx')}</button></div>
      <p class="foot">${o.updatedAt ? 'Updated ' + esc(ago(Date.parse(o.updatedAt))) : ''}</p>
    </div></div>`;
  const sc = page.querySelector('.pscroll'); sc.scrollTop = keep;
  sc.addEventListener('scroll', () => page.classList.toggle('compact', sc.scrollTop > 70), { passive: true });
  page.classList.toggle('compact', keep > 70);
}
function openDetail(id) {
  clearTimeout(pageT);
  S.detail = id; page.dataset.id = ''; renderDetail();
  page.hidden = false; document.body.classList.add('paged'); requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('pushed')));
  if (!history.state || history.state.detail !== id) history.pushState({ detail: id }, '');
  requestAnimationFrame(() => requestAnimationFrame(() => page.classList.add('in')));
  buzz(6);
}
function closeDetail(fromPop) {
  if (!S.detail) return;
  S.detail = null; page.classList.remove('in'); document.body.classList.remove('paged', 'pushed');
  clearTimeout(pageT); pageT = setTimeout(() => { if (!S.detail) { page.hidden = true; page.innerHTML = ''; } }, reduced() ? 0 : 420);
  if (!fromPop && history.state && history.state.detail) history.back();
}
window.addEventListener('popstate', () => { if (!sheet.hidden) closeSheet(); if (S.detail) closeDetail(true); });

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
    <div class="card"><div class="setupicon">${ic('box')}</div><h3>Connect your order list</h3>
      <p class="lead">Your orders are kept in your private GitHub repo <b>${esc(S.repo)}</b>. To let this phone read and update them, paste a GitHub access token once.</p>
      <a class="linkbtn" href="${TOKEN_URL}" target="_blank" rel="noopener noreferrer">Create the token on GitHub ${ic('ext')}</a>
      ${tokenSteps(false)}
      <form id="tokform" autocomplete="off">
        <label class="field"><span>Paste the token here</span><input id="tok" type="password" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
        <details><summary>Advanced: data repository</summary><label class="field"><span>owner/repo</span><input id="repo" value="${esc(S.repo)}" autocapitalize="off" spellcheck="false"></label></details>
        <div id="tokerr" class="err" hidden></div>
        <button class="primary" id="tokgo" type="submit">Connect</button>
        ${S.pending.length ? `<p class="small muted">${S.pending.length} unsaved change(s) on this phone will save after you connect.</p>` : ''}
      </form></div></div>`;
  onScroll();
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
      buzz(); toast('Connected');
    } catch (ex) {
      err.textContent = ex.kind === 'auth' ? 'GitHub rejected this token. Check you copied all of it and that it has not expired.' : ex.message;
      err.hidden = false; go.disabled = false; go.textContent = 'Connect';
    }
  });
}
function renderSettings() {
  main.innerHTML = `<div id="settings">
    <div class="ghead">Sync</div><div class="group">
      ${row('Data repo', `${esc(S.repo)} <small>(private)</small>`)}
      ${row('Last synced', esc(ago(S.syncedAt)))}
      ${row('Unsaved changes', S.pending.length)}
      ${row('Orders', current().length)}
      <button class="row act" data-act="retry"><span class="rl acc">Refresh now</span></button>
      <button class="row act" data-act="back"><span class="rl acc">Back to orders</span></button></div>
    <div class="ghead">Token</div><div class="group">
      <div class="row wrap"><span class="rl muted small">Replace the token when it expires, or sign out to remove the token and the saved copy of your orders from this device.</span></div>
      <button class="row act" data-act="newtoken"><span class="rl acc">Enter a new token</span></button>
      <button class="row act" id="signout" data-act="signout"><span class="rl danger">Sign out / forget token</span></button></div>
    <div class="group mt pad"><details><summary>How to create a token</summary>${tokenSteps(true)}</details></div>
    <p class="foot">Order Tracker · data never leaves your GitHub and this device.</p></div>`;
  onScroll();
}

// ---------- sheets ----------
const sheet = $('#sheet');
let sheetT;
function openSheet(html, full) {
  clearTimeout(sheetT);
  sheet.innerHTML = `<div class="sheet${full ? ' full' : ''}" role="dialog" aria-modal="true"><div class="grabber" data-grab aria-hidden="true"><i></i></div>${html}</div>`;
  sheet.hidden = false; sheet.classList.remove('in', 'closing'); document.body.classList.add('locked');
  requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('in')));
}
function closeSheet() {
  if (sheet.hidden) return;
  sheet.classList.remove('in'); sheet.classList.add('closing'); document.body.classList.remove('locked');
  const s = sheet.querySelector('.sheet'); if (s) s.style.transform = '';
  clearTimeout(sheetT); sheetT = setTimeout(() => { sheet.hidden = true; sheet.innerHTML = ''; sheet.classList.remove('closing'); }, reduced() ? 0 : 320);
}
function statusSheet(id, ctx) {
  const o = current().find(x => x.id === id); if (!o) return;
  const nx = NEXT[o.status];
  const acts = ctx ? `<div class="group ctxacts">
      ${!S.detail ? `<button class="row act" data-act="open" data-id="${esc(id)}">${ic('chevR', 'ri')}<span class="rl">Open details</span></button>` : ''}
      ${nx ? `<button class="row act" data-act="next" data-id="${esc(id)}">${ic(ST_ICON[nx], 'ri')}<span class="rl">Mark ${esc(LABEL[nx].toLowerCase())}</span></button>` : ''}
      ${isUrl(o.trackingUrl) ? `<a class="row act" href="${esc(o.trackingUrl)}" target="_blank" rel="noopener noreferrer" data-act="close">${ic('truck', 'ri')}<span class="rl">Track package</span></a>` : ''}
      <button class="row act" data-act="edit" data-id="${esc(id)}">${ic('edit', 'ri')}<span class="rl">Edit order</span></button></div><div class="ghead">Set status</div>` : '';
  openSheet(`<div class="shead"><span class="shlogo">${thumbs(o)}</span><h3>${esc(shortName(o.retailer))}<small>${esc(etaText(o).text)}</small></h3><button class="iconbtn sm" data-act="close" aria-label="Close">${ic('x')}</button></div>
    ${acts}<div class="stlist group">${STATUSES.map(([k, l]) => `<button class="stbtn st-${k}${o.status === k ? ' cur' : ''}" data-setstatus="${k}" data-id="${esc(id)}"><span class="dot">${ic(ST_ICON[k])}</span>${esc(l)}${o.status === k ? ic('check', 'tick') : ''}</button>`).join('')}</div>`);
  if (ctx) { sheet.querySelector('.sheet').classList.add('ctx'); buzz(12); }
}
const liRow = (x = {}) => `<div class="lirow"><input name="li_name" placeholder="Item name" value="${esc(x.name || '')}" aria-label="Item name">
  <div class="li2"><label><span>Qty</span><input name="li_qty" inputmode="numeric" value="${esc(x.qty || 1)}" aria-label="Quantity"></label><label><span>Price each</span><input name="li_price" inputmode="decimal" placeholder="—" value="${typeof x.price === 'number' ? x.price.toFixed(2) : ''}" aria-label="Price each"></label>
  <button type="button" class="iconbtn sm" data-act="rmline" aria-label="Remove item">${ic('x')}</button></div>
  <input name="li_url" type="url" inputmode="url" placeholder="https://product link (optional)" value="${esc(x.url || '')}" autocapitalize="off" spellcheck="false" aria-label="Product link">
  <input name="li_image" type="url" inputmode="url" placeholder="https://photo link (optional)" value="${esc(x.imageUrl || '')}" autocapitalize="off" spellcheck="false" aria-label="Photo link"></div>`;
function formSheet(id) {
  const o = id ? current().find(x => x.id === id) : normalize({ status: 'ordered', orderDate: today() });
  if (!o) return;
  const retailers = [...new Set(current().map(x => x.retailer).filter(Boolean))];
  const val = k => MONEY.has(k) && typeof o[k] === 'number' ? String(o[k]) : (o[k] == null ? '' : o[k]);
  const f = (k, label, attrs = '') => `<label class="field" data-f="${k}"><span>${label}</span><input name="${k}" value="${esc(val(k))}" ${attrs}></label>`;
  openSheet(`<form id="oform" novalidate><div class="shead"><button type="button" class="textbtn" data-act="close">Cancel</button><h3>${id ? 'Edit order' : 'Add order'}</h3><button type="button" class="textbtn strong" data-act="submitform">${id ? 'Save' : 'Add'}</button></div>
    <div class="ghead">Order</div>
    ${f('retailer', 'Retailer *', 'list="dl-ret" autocapitalize="words" required')}
    <label class="field"><span>Items (summary on the card)</span><textarea name="items" rows="2">${esc(o.items)}</textarea></label>
    <div class="row2">${f('orderDate', 'Order date', 'type="date"')}${f('total', 'Total (CAD)', 'inputmode="decimal" placeholder="Unknown"')}</div>
    ${f('orderNumber', 'Order number', 'autocapitalize="off" spellcheck="false"')}
    <label class="field"><span>Status</span><select name="status">${STATUSES.map(([k, l]) => `<option value="${k}"${o.status === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="ghead">Delivery</div>
    ${f('carrier', 'Carrier', 'list="dl-car"')}
    ${f('trackingUrl', 'Tracking link', 'type="url" inputmode="url" placeholder="https://…" autocapitalize="off" spellcheck="false"')}
    <div class="row2">${f('expectedStart', 'Expected delivery', 'type="date"')}${f('expectedEnd', 'Latest (if a range)', 'type="date"')}</div>
    ${f('expectedWindow', 'Time window', 'placeholder="e.g. 4:01–5:31 PM"')}
    ${f('statusDate', 'Delivered / picked up / cancelled on', 'type="date"')}
    <label class="field" data-f="shipAddress"><span>Ship to</span><textarea name="shipAddress" rows="2" placeholder="Name, street, city">${esc(o.shipAddress)}</textarea></label>
    <div class="ghead">Line items</div>
    <div id="lirows" data-f="lineItems">${o.lineItems.map(liRow).join('')}</div>
    <button type="button" class="ghost full" data-act="addline">${ic('plus')}Add line item</button>
    <div class="ghead">Receipt</div>
    <div class="row3">${f('subtotal', 'Subtotal', 'inputmode="decimal" placeholder="—"')}${f('shipping', 'Shipping', 'inputmode="decimal" placeholder="—"')}${f('tax', 'Tax', 'inputmode="decimal" placeholder="—"')}</div>
    <div class="ghead">Payment</div>
    <div class="row2">${f('paymentBrand', 'Card / method', 'list="dl-brand"')}${f('paymentLast4', 'Last 4 digits', 'inputmode="numeric" maxlength="4" placeholder="1234" autocomplete="off"')}</div>
    <p class="hint">Only the last 4 digits. Never enter a full card number.</p>
    <div class="ghead">Links</div>
    ${f('productUrl', 'Product page', 'type="url" inputmode="url" placeholder="https://…" autocapitalize="off" spellcheck="false"')}
    ${f('imageUrl', 'Order photo (defaults to the first item’s)', 'type="url" inputmode="url" placeholder="https://…" autocapitalize="off" spellcheck="false"')}
    ${f('emailLink', 'Confirmation email link', 'type="url" inputmode="url" placeholder="https://mail.google.com/…" autocapitalize="off" spellcheck="false"')}
    <div class="ghead">Notes</div>
    <label class="field"><span>Notes</span><textarea name="notes" rows="2">${esc(o.notes)}</textarea></label>
    <div id="formerr" class="err" hidden></div>
    <button class="primary" type="submit">${id ? 'Save changes' : 'Add order'}</button>
    <button class="secondary" type="button" data-act="close">Cancel</button>
    ${id ? `<button class="dangerbtn" type="button" data-act="delete" data-id="${esc(id)}">Delete order</button>` : ''}
    <datalist id="dl-ret">${retailers.map(r => `<option value="${esc(r)}">`).join('')}</datalist>
    <datalist id="dl-car">${CARRIERS.map(r => `<option value="${esc(r)}">`).join('')}</datalist>
    <datalist id="dl-brand">${BRANDS.map(r => `<option value="${esc(r)}">`).join('')}</datalist></form>`, true);
  $('#oform').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target), v = {};
    for (const k of FIELDS) if (k !== 'lineItems') v[k] = String(fd.get(k) == null ? '' : fd.get(k)).trim();
    const errs = [];
    sheet.querySelectorAll('.bad').forEach(x => x.classList.remove('bad'));
    const bad = (k, m, el) => { errs.push(m); el = el || sheet.querySelector(`[data-f="${k}"]`); if (el) el.classList.add('bad'); };
    if (!v.retailer) bad('retailer', 'Retailer is required.');
    for (const k of MONEY) { v[k] = parseTotal(v[k]); if (Number.isNaN(v[k])) bad(k, `${k === 'total' ? 'Total' : k[0].toUpperCase() + k.slice(1)} should be a number like 49.99, or blank if unknown.`); }
    if (v.trackingUrl && !isUrl(v.trackingUrl)) bad('trackingUrl', 'Tracking link should start with https://');
    for (const [k, l] of [['productUrl', 'Product page'], ['emailLink', 'Email link'], ['imageUrl', 'Photo link']]) if (v[k] && !/^https:\/\/\S+$/i.test(v[k])) bad(k, `${l} should start with https://`);
    const digits = v.paymentLast4.replace(/\D/g, '');
    if (digits.length > 4) bad('paymentLast4', 'Only enter the last 4 digits of the card.');
    else if (v.paymentLast4 && !/^\d{4}$/.test(v.paymentLast4)) bad('paymentLast4', 'Last 4 should be exactly 4 digits.');
    for (const k of ['paymentBrand', 'shipAddress', 'notes', 'items']) if (/\d{13,19}/.test(v[k].replace(/[\s-]/g, ''))) bad(k, 'That looks like a full card number. Only store the last 4 digits.');
    v.lineItems = [];
    sheet.querySelectorAll('.lirow').forEach(r => {
      const g = n => r.querySelector(`[name=${n}]`).value.trim();
      const name = g('li_name'), qs = g('li_qty'), ps = g('li_price'), url = g('li_url'), imageUrl = g('li_image');
      if (!name && !ps && !url && !imageUrl) return;
      const it = { name, qty: qs === '' ? 1 : Number(qs), price: parseTotal(ps), url, imageUrl };
      if (imageUrl && !/^https:\/\/\S+$/i.test(imageUrl)) bad('', `“${name}”: photo link should start with https://`, r);
      if (!name) bad('', 'Each line item needs a name.', r);
      if (!Number.isInteger(it.qty) || it.qty < 1) bad('', `“${name}”: quantity should be a whole number.`, r);
      if (Number.isNaN(it.price)) bad('', `“${name}”: price should be a number like 19.99.`, r);
      if (url && !/^https:\/\/\S+$/i.test(url)) bad('', `“${name}”: product link should start with https://`, r);
      v.lineItems.push(it);
    });
    if (v.expectedEnd && !v.expectedStart) { v.expectedStart = v.expectedEnd; v.expectedEnd = ''; }
    if (v.expectedEnd && v.expectedEnd < v.expectedStart) bad('expectedEnd', 'Latest date is before the expected date.');
    if (v.expectedEnd === v.expectedStart) v.expectedEnd = '';
    if (errs.length) { const fe = $('#formerr'); fe.textContent = errs.join(' '); fe.hidden = false; fe.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }); buzz([8, 40, 8]); return; }
    const same = (a, b) => JSON.stringify(a == null ? '' : a) === JSON.stringify(b == null ? '' : b);
    if (id) {
      const diff = {}; for (const k of FIELDS) if (!same(o[k], v[k])) diff[k] = v[k];
      if (diff.status && !('statusDate' in diff) && !IN_TRANSIT.has(diff.status) && !o.statusDate) diff.statusDate = today();
      closeSheet();
      if (Object.keys(diff).length) { change(id, diff); buzz(); toast('Saved'); }
    } else {
      if (!IN_TRANSIT.has(v.status) && !v.statusDate) v.statusDate = today();
      closeSheet(); change(uid(), v, { create: true }); buzz(); toast('Order added');
    }
  });
}
// drag the grabber down to dismiss a sheet
let drag = null;
sheet.addEventListener('touchstart', e => {
  const s = sheet.querySelector('.sheet'); if (!s) return;
  if (!e.target.closest('[data-grab],.shead') && s.scrollTop > 0) return;
  if (!e.target.closest('[data-grab],.shead')) return;
  drag = { y: e.touches[0].clientY, s, d: 0 };
}, { passive: true });
sheet.addEventListener('touchmove', e => {
  if (!drag) return; drag.d = Math.max(0, e.touches[0].clientY - drag.y);
  drag.s.style.transition = 'none'; drag.s.style.transform = `translateY(${drag.d}px)`;
}, { passive: true });
sheet.addEventListener('touchend', () => {
  if (!drag) return; const { s, d } = drag; drag = null; s.style.transition = '';
  if (d > 90) closeSheet(); else s.style.transform = '';
});

// ---------- large title / pull to refresh ----------
const nav = $('#nav');
let ticking = false;
function onScroll() { if (ticking) return; ticking = true; requestAnimationFrame(() => { ticking = false; nav.classList.toggle('compact', window.scrollY > 36); }); }
window.addEventListener('scroll', onScroll, { passive: true });
const ptrEl = $('#ptr');
let pull = null;
window.addEventListener('touchstart', e => {
  if (!S.token || S.view !== 'list' || !sheet.hidden || S.detail || window.scrollY > 0 || S.net === 'loading') return;
  pull = { y: e.touches[0].clientY, d: 0 };
}, { passive: true });
window.addEventListener('touchmove', e => {
  if (!pull) return;
  const dy = e.touches[0].clientY - pull.y;
  if (dy <= 0 || window.scrollY > 0) { pull.d = 0; ptrEl.style.transform = ''; ptrEl.classList.remove('show', 'armed'); return; }
  if (e.cancelable && dy > 8) e.preventDefault();
  pull.d = Math.min(dy * 0.5, 96);
  ptrEl.classList.add('show'); ptrEl.style.transform = `translate(-50%, ${pull.d}px) rotate(${pull.d * 4}deg)`;
  const armed = pull.d >= 64; if (armed && !ptrEl.classList.contains('armed')) buzz(8);
  ptrEl.classList.toggle('armed', armed);
}, { passive: false });
window.addEventListener('touchend', () => {
  if (!pull) return; const go = pull.d >= 64; pull = null;
  if (!go) { ptrEl.style.transform = ''; ptrEl.classList.remove('show', 'armed'); return; }
  ptrEl.classList.add('spin'); ptrEl.style.transform = 'translate(-50%, 60px)';
  refresh().finally(() => { ptrEl.classList.remove('spin', 'show', 'armed'); ptrEl.style.transform = ''; });
});

// ---------- events ----------
document.addEventListener('click', e => {
  if (lpFired) { lpFired = false; e.preventDefault(); return; }
  if (!e.target.closest('#menuwrap .menu') && !$('#menuwrap').hidden && !e.target.closest('#btnMenu')) { closeMenu(); if (e.target.closest('#menuwrap')) return; }
  const t = e.target.closest('[data-act],[data-filter],[data-setstatus]');
  if (!t) {
    if (e.target === sheet) return closeSheet();
    const oc = e.target.closest('.order'); if (oc && !e.target.closest('a')) openDetail(oc.dataset.id);
    return;
  }
  if (t.dataset.filter) { S.filter = t.dataset.filter; buzz(4); return render(); }
  if (t.dataset.setstatus) { closeSheet(); return setStatus(t.dataset.id, t.dataset.setstatus); }
  const act = t.dataset.act, holder = t.closest('[data-id]'), id = holder ? holder.dataset.id : null;
  if (t.closest('#menuwrap')) closeMenu();
  if (t.closest('.sheet.ctx') && act !== 'close' && act !== 'edit') closeSheet();
  if (act === 'open') return openDetail(id);
  if (act === 'togglesearch') return toggleSearch();
  if (act === 'detailback') return closeDetail();
  if (act === 'status') return statusSheet(id);
  if (act === 'next') { const o = current().find(x => x.id === id); return o && setStatus(id, NEXT[o.status]); }
  if (act === 'edit') return formSheet(id);
  if (act === 'add') return formSheet(null);
  if (act === 'close') return closeSheet();
  if (act === 'submitform') return $('#oform').requestSubmit();
  if (act === 'addline') { const box = $('#lirows'); box.insertAdjacentHTML('beforeend', liRow()); box.lastElementChild.querySelector('input').focus(); return; }
  if (act === 'rmline') { t.closest('.lirow').remove(); return; }
  if (act === 'clearfilter') { S.filter = 'all'; S.q = ''; return render(); }
  if (act === 'delete') { if (confirm('Delete this order?')) { closeSheet(); if (S.detail === t.dataset.id) closeDetail(); remove(t.dataset.id); buzz(20); toast('Deleted'); } return; }
  if (act === 'mprev' || act === 'mnext') { const [y, m] = S.month.split('-').map(Number); const d = new Date(y, m - 1 + (act === 'mprev' ? -1 : 1), 1); S.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; buzz(4); return render(); }
  if (act === 'retry') return refresh();
  if (act === 'back') { S.view = 'list'; return render(); }
  if (act === 'newtoken') { S.view = 'setup'; closeDetail(); return render(); }
  if (act === 'signout') {
    const n = S.pending.length;
    if (!confirm(n ? `${n} change(s) have not been saved to GitHub yet and will be lost. Sign out anyway?` : 'Forget the token and the saved copy of your orders on this device?')) return;
    for (const k of Object.values(LS)) localStorage.removeItem(k);
    Object.assign(S, { token: '', repo: DEFAULT_REPO, base: { version: 1, orders: [] }, sha: null, syncedAt: null, loaded: false, pending: [], view: 'list', problem: null, net: 'idle' });
    render(); toast('Signed out. Token removed from this device.');
  }
});
$('#btnAdd').addEventListener('click', () => formSheet(null));
$('#btnRefresh').addEventListener('click', () => { closeMenu(); buzz(6); refresh(); });
$('#btnSettings').addEventListener('click', () => { closeMenu(); S.view = S.view === 'settings' ? 'list' : 'settings'; render(); window.scrollTo(0, 0); });
$('#btnSearch').addEventListener('click', () => toggleSearch());
$('#btnMenu').addEventListener('click', () => { const w = $('#menuwrap'); if (!w.hidden) return closeMenu(); w.hidden = false; buzz(4); requestAnimationFrame(() => w.classList.add('in')); $('#btnMenu').setAttribute('aria-expanded', 'true'); });
function closeMenu() { const w = $('#menuwrap'); if (w.hidden) return; w.classList.remove('in'); w.hidden = true; $('#btnMenu').setAttribute('aria-expanded', 'false'); }
function toggleSearch() {
  if (S.view !== 'list') { S.view = 'list'; }
  S.searchOpen = !(S.searchOpen || S.q || S.filter !== 'all');
  if (!S.searchOpen) { S.q = ''; S.filter = 'all'; }
  render(); window.scrollTo(0, 0);
  if (S.searchOpen) $('#q').focus();
}
// broken product photo / logo -> show the letter fallback underneath
document.addEventListener('error', e => { const t = e.target; if (t && t.tagName === 'IMG' && t.closest('.tile,.logo')) t.remove(); }, true);
// long-press = context menu (status + actions); swipe left on an in-transit row = mark delivered
let lpT = null, lpFired = false, sw = null;
main.addEventListener('contextmenu', e => { const oc = e.target.closest('.order'); if (!oc) return; e.preventDefault(); clearTimeout(lpT); statusSheet(oc.dataset.id, true); });
main.addEventListener('touchstart', e => {
  const oc = e.target.closest('.order'); if (!oc) return;
  const p = e.touches[0]; lpFired = false;
  clearTimeout(lpT); lpT = setTimeout(() => { lpFired = true; sw = null; oc.classList.remove('pressing'); statusSheet(oc.dataset.id, true); }, 480);
  oc.classList.add('pressing');
  const row = oc.closest('.swipe.can'); sw = row ? { x: p.clientX, y: p.clientY, dx: 0, on: false, oc, row } : { x: p.clientX, y: p.clientY, dx: 0, on: false, oc, row: null };
}, { passive: true });
main.addEventListener('touchmove', e => {
  if (!sw) return; const p = e.touches[0]; const dx = p.clientX - sw.x, dy = p.clientY - sw.y;
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) { clearTimeout(lpT); sw.oc.classList.remove('pressing'); }
  if (!sw.row) return;
  if (!sw.on && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3 && dx < 0) { sw.on = true; pull = null; sw.row.classList.add('swiping'); }
  if (!sw.on) return;
  if (e.cancelable) e.preventDefault();
  sw.dx = Math.min(0, dx); const armed = sw.dx < -96;
  if (armed !== sw.row.classList.contains('armed')) { sw.row.classList.toggle('armed', armed); if (armed) buzz(8); }
  sw.oc.style.transform = `translateX(${sw.dx < -96 ? -96 + (sw.dx + 96) * 0.35 : sw.dx}px)`;
}, { passive: false });
main.addEventListener('touchend', () => {
  clearTimeout(lpT); if (!sw) return; const s = sw; sw = null; s.oc.classList.remove('pressing');
  if (!s.on) return;
  lpFired = true; setTimeout(() => { lpFired = false; }, 350); // swallow the click that follows a swipe
  s.row.classList.remove('swiping'); s.oc.style.transform = '';
  if (s.dx < -96) { s.row.classList.remove('armed'); setStatus(s.row.dataset.id, 'delivered'); } else s.row.classList.remove('armed');
});
main.addEventListener('touchcancel', () => { clearTimeout(lpT); if (sw) { sw.oc.style.transform = ''; sw.oc.classList.remove('pressing'); if (sw.row) sw.row.classList.remove('swiping', 'armed'); } sw = null; });
main.addEventListener('input', e => { if (e.target.id === 'q') { S.q = e.target.value; renderList(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!sheet.hidden) closeSheet(); else if (S.detail) closeDetail(); } });
window.addEventListener('online', () => refresh());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.token && Date.now() - (S.syncedAt || 0) > 60e3) refresh(); });

// ---------- boot ----------
restore();
render();
if (S.token) refresh();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__OT = { applyOps, sortOrders, monthSpend, parseTotal, b64encode, b64decode, fmtRange, state: S };
})();
