// X-Station — manage several businesses: one record per day per business (income by category, expenses),
// stored in Firebase (see firebase.js). Installable as an app (see sw.js / manifest.webmanifest).

import * as FB from './firebase.js';

const LEGACY_KEY = 'xstation-daily-v1';  // records saved on this device before Firebase
const PREFS_KEY = 'xstation-prefs';      // per-device choices (theme, dashboard period, last business)
const MAX_CATS = 6;                       // the chart palette has 6 validated colours

// Ready-made business types: the income categories they start with (all editable).
const PRESETS = [
  { id: 'charging-drinks', name: 'Charging & drinks', cats: ['Drinks', 'Charging'] },
  { id: 'shop', name: 'Shop / supermarket', cats: ['Sales'] },
  { id: 'restaurant', name: 'Restaurant / food', cats: ['Food', 'Drinks'] },
  { id: 'bar', name: 'Bar / lounge', cats: ['Drinks', 'Food', 'Events'] },
  { id: 'salon', name: 'Salon / barbershop', cats: ['Services', 'Products'] },
  { id: 'pos', name: 'POS / mobile money', cats: ['Withdrawals', 'Transfers', 'Bill payments'] },
  { id: 'pharmacy', name: 'Pharmacy', cats: ['Drugs', 'Other items'] },
  { id: 'phone', name: 'Phone & accessories', cats: ['Phones', 'Accessories', 'Repairs'] },
  { id: 'laundry', name: 'Laundry', cats: ['Washing', 'Ironing'] },
  { id: 'transport', name: 'Transport', cats: ['Trips'] },
  { id: 'custom', name: 'Other', cats: ['Sales'] },
];
const presetName = id => (PRESETS.find(p => p.id === id) || PRESETS[PRESETS.length - 1]).name;

// =========================================================
// Helpers
// =========================================================
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const pad = n => String(n).padStart(2, '0');
const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dateStr(new Date());
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); };
const fmtDate = (s, o = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) =>
  parseDate(s).toLocaleDateString(undefined, o);
const monthName = (ym, o = { month: 'long', year: 'numeric' }) => parseDate(ym + '-01').toLocaleDateString(undefined, o);
const daysInMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const monthEnd = ym => `${ym}-${pad(daysInMonth(ym))}`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'item';
}
const rand = () => Math.random().toString(36).slice(2, 6);

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
}
const prefs = { theme: 'system', period: 'month', biz: null, ...readJSON(PREFS_KEY) };
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// =========================================================
// State
// =========================================================
const state = {
  businesses: {},   // id → normalized business
  days: {},         // id → { 'YYYY-MM-DD': { income, expenses, note, updatedBy } }
  sync: {},         // id → { fromCache, pending }
  current: null,    // id of the business being viewed
  ready: false,     // first list of businesses has arrived
};
let workDate = todayStr();

// Business documents written before multi-business support only had { settings: { shopName, currency, target } }.
function normBiz(id, raw = {}) {
  const s = raw.settings || {};
  let cats = Array.isArray(raw.categories) && raw.categories.length ? raw.categories : null;
  if (!cats) {
    cats = id === 'main'
      ? [{ id: 'drinks', name: 'Drinks', slot: 1 }, { id: 'charging', name: 'Charging', slot: 2 }]
      : [{ id: 'sales', name: 'Sales', slot: 1 }];
  }
  cats = cats.map((c, i) => ({ id: c.id, name: c.name, slot: c.slot || i + 1 }));
  return {
    id,
    name: raw.name || s.shopName || 'X-Station',
    type: raw.type || (id === 'main' ? 'charging-drinks' : 'custom'),
    currency: raw.currency || s.currency || '₦',
    target: raw.target ?? s.target ?? '',
    categories: cats,
    archived: !!raw.archived,
    legacy: !raw.categories,
  };
}

const B = () => state.businesses[state.current] || null;           // current business
const D = (id = state.current) => state.days[id] || {};            // its day records
const activeBusinesses = () => Object.values(state.businesses).filter(b => !b.archived)
  .sort((a, b) => a.name.localeCompare(b.name));

function money(n, biz = B()) {
  const v = Number(n || 0);
  const s = Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (v < 0 ? '−' : '') + (biz ? biz.currency : '') + s;
}
function compact(n, biz = B()) {
  const v = Math.abs(n);
  const c = biz ? biz.currency : '';
  if (v >= 1e6) return c + +(n / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return c + +(n / 1e3).toFixed(1) + 'K';
  return c + n;
}

// one day record → numbers
function calc(r) {
  const income = r?.income || {};
  const revenue = Object.values(income).reduce((t, v) => t + (Number(v) || 0), 0);
  const expenses = Number(r?.expenses || 0);
  return { income, revenue, expenses, profit: revenue - expenses };
}
// records of a business between two dates (inclusive), sorted
function between(start, end, id = state.current) {
  const days = D(id);
  return Object.keys(days).filter(d => d >= start && d <= end).sort()
    .map(d => ({ date: d, note: days[d].note || '', updatedBy: days[d].updatedBy || '', ...calc(days[d]) }));
}
function totals(list) {
  const t = { byCat: {}, revenue: 0, expenses: 0, profit: 0, days: list.length };
  list.forEach(r => {
    Object.entries(r.income).forEach(([k, v]) => { t.byCat[k] = (t.byCat[k] || 0) + (Number(v) || 0); });
    t.revenue += r.revenue; t.expenses += r.expenses; t.profit += r.profit;
  });
  return t;
}
const catAmount = (r, cat) => Number(r.income?.[cat.id] || r.byCat?.[cat.id] || 0);
const keyHtml = cat => `<i class="key s${cat.slot}"></i>`;
const legendHtml = biz => biz.categories.map(c => `<span>${keyHtml(c)}${esc(c.name)}</span>`).join('');

// =========================================================
// Routing
// =========================================================
const PAGES = ['businesses', 'dashboard', 'record', 'reports', 'admin', 'settings', 'empty'];
const BIZ_PAGES = ['dashboard', 'record', 'reports'];
function currentPage() {
  const h = location.hash.slice(1);
  return PAGES.includes(h) ? h : (B() ? 'dashboard' : 'businesses');
}
function route() {
  if (!state.ready) return;
  let page = currentPage();
  if (page === 'admin' && !isAdmin()) page = 'dashboard';
  if (BIZ_PAGES.includes(page) && !B()) page = 'empty';
  if (page === 'empty' && B()) page = 'dashboard';
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  Charts.hideTip();
  render(page);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
function go(page) { if (location.hash === '#' + page) route(); else location.hash = page; }

function render(page) {
  renderShell();
  if (page === 'businesses') renderBusinesses();
  if (page === 'dashboard') renderDashboard();
  if (page === 'record') { loadForm(); renderRecordSide(); }
  if (page === 'reports') renderReports();
  if (page === 'admin') renderAdmin();
  if (page === 'settings') renderSettings();
  if (page === 'empty') renderEmpty();
}

function renderShell() {
  const biz = B();
  document.title = biz ? `${biz.name} · X-Station` : 'X-Station';
  $$('[data-biz-name]').forEach(el => { el.textContent = biz ? biz.name : ''; });

  // business switchers
  const list = activeBusinesses();
  const opts = list.map(b => `<option value="${b.id}" ${b.id === state.current ? 'selected' : ''}>${esc(b.name)}</option>`).join('')
    + (list.length ? '' : '<option value="" selected>No business</option>')
    + (isAdmin() ? '<option value="__new">＋ Add business…</option>' : '');
  $$('[data-biz-select]').forEach(sel => { sel.innerHTML = opts; });

  const today = biz && D()[todayStr()];
  $('sidebarToday').innerHTML = `${fmtDate(todayStr(), { weekday: 'long', day: 'numeric', month: 'long' })}<br>` +
    (!biz ? '' : today ? `Today: <b style="color:#fff">${money(calc(today).revenue)}</b>` : 'Today not recorded yet');
  renderSync();
}

function setCurrent(id, { silent = false } = {}) {
  if (!state.businesses[id] || state.businesses[id].archived) return;
  if (state.current !== id) formDirty = false;
  state.current = id;
  prefs.biz = id;
  savePrefs();
  renderIncomeFields();
  if (!silent) route();
}
$$('[data-biz-select]').forEach(sel => sel.addEventListener('change', e => {
  const v = e.target.value;
  if (v === '__new') { renderShell(); openBizDialog(); return; }
  if (v) {
    setCurrent(v);
    if (!BIZ_PAGES.includes(currentPage())) go('dashboard');
    toast(`Now viewing ${B().name}`);
  }
}));

// =========================================================
// Businesses overview
// =========================================================
function monthStats(id) {
  const T = todayStr(), ym = T.slice(0, 7);
  const pd = parseDate(ym + '-01'); pd.setMonth(pd.getMonth() - 1);
  const pym = dateStr(pd).slice(0, 7);
  const day = Math.min(+T.slice(8), daysInMonth(pym));
  return {
    cur: totals(between(ym + '-01', T, id)),
    prev: totals(between(pym + '-01', `${pym}-${pad(day)}`, id)),
    today: !!D(id)[T],
    vs: `${monthName(pym, { month: 'short' })} 1–${day}`,
  };
}

function renderBusinesses() {
  const list = activeBusinesses();
  const T = todayStr();
  $('bizSub').textContent = `${monthName(T.slice(0, 7))} so far · ${list.length} business${list.length === 1 ? '' : 'es'}`;

  // combined totals only make sense when every business uses the same currency
  const stats = Object.fromEntries(list.map(b => [b.id, monthStats(b.id)]));
  const currencies = new Set(list.map(b => b.currency));
  $('bizTotals').classList.toggle('hidden', list.length < 2 || currencies.size !== 1);
  if (list.length >= 2 && currencies.size === 1) {
    const any = list[0];
    const rev = list.reduce((t, b) => t + stats[b.id].cur.revenue, 0);
    const prevRev = list.reduce((t, b) => t + stats[b.id].prev.revenue, 0);
    const profit = list.reduce((t, b) => t + stats[b.id].cur.profit, 0);
    const recorded = list.filter(b => stats[b.id].today).length;
    $('bizTotals').innerHTML = `
      <div class="card kpi"><div class="kpi-label">Revenue, all businesses</div><div class="kpi-value">${money(rev, any)}</div>
        <div class="delta">${deltaHtml(rev, prevRev, stats[any.id].vs)}</div></div>
      <div class="card kpi"><div class="kpi-label">Net profit, all businesses</div><div class="kpi-value">${money(profit, any)}</div></div>
      <div class="card kpi"><div class="kpi-label">Businesses</div><div class="kpi-value">${list.length}</div></div>
      <div class="card kpi"><div class="kpi-label">Recorded today</div><div class="kpi-value">${recorded} of ${list.length}</div>
        <div class="kpi-foot">${recorded === list.length ? 'All done ✔' : 'Some are still missing'}</div></div>`;
  }

  $('bizGrid').innerHTML = list.length ? list.map(b => {
    const s = stats[b.id];
    const mix = s.cur.revenue
      ? b.categories.map(c => { const w = (catAmount(s.cur, c) / s.cur.revenue) * 100; return w ? `<div class="key s${c.slot}" style="width:${w}%"></div>` : ''; }).join('')
      : '';
    return `<article class="card biz-card ${b.id === state.current ? 'current' : ''}" data-open-biz="${b.id}" tabindex="0">
      <div class="biz-card-head">
        <span class="biz-avatar">${esc(b.name.trim()[0] || '?').toUpperCase()}</span>
        <div class="biz-title"><h2>${esc(b.name)}</h2><span class="sub">${esc(presetName(b.type))}</span></div>
        ${isAdmin() ? `<button class="icon-btn small" data-edit-biz="${b.id}" aria-label="Edit ${esc(b.name)}" title="Edit">✎</button>` : ''}
      </div>
      <div class="biz-rev">
        <span class="kpi-label">Revenue this month</span>
        <strong>${money(s.cur.revenue, b)}</strong>
        <span class="delta">${deltaHtml(s.cur.revenue, s.prev.revenue, s.vs)}</span>
      </div>
      <div class="mix-bar thin">${mix}</div>
      <div class="biz-legend">${b.categories.map(c => `<span>${keyHtml(c)}${esc(c.name)}</span>`).join('')}</div>
      <div class="biz-foot">
        <span>Profit <b class="${s.cur.profit < 0 ? 'neg' : ''}">${money(s.cur.profit, b)}</b></span>
        <span class="${s.today ? 'ok-text' : 'warn-text'}">${s.today ? '✔ Today recorded' : '○ Today not recorded'}</span>
      </div>
    </article>`;
  }).join('') : `<div class="card empty-card"><p class="sub">${isAdmin() ? 'No businesses yet. Add your first one.' : 'You have not been given access to any business yet.'}</p></div>`;

  // archived (admin)
  const archived = Object.values(state.businesses).filter(b => b.archived);
  $('archivedBox').classList.toggle('hidden', !isAdmin() || !archived.length);
  $('archivedCount').textContent = archived.length;
  $('archivedBody').innerHTML = archived.map(b => `<tr>
      <td class="row-title">${esc(b.name)}</td>
      <td data-label="Type">${esc(presetName(b.type))}</td>
      <td class="num" data-label="Actions"><span class="actions">
        <button class="btn ghost" data-unarchive="${b.id}">Restore</button>
        <button class="btn ghost danger" data-delete-biz="${b.id}">Delete forever</button>
      </span></td></tr>`).join('');
}
$('bizGrid').addEventListener('click', e => {
  const edit = e.target.closest('[data-edit-biz]');
  if (edit) { e.stopPropagation(); openBizDialog(edit.dataset.editBiz); return; }
  const card = e.target.closest('[data-open-biz]');
  if (card) { setCurrent(card.dataset.openBiz, { silent: true }); go('dashboard'); }
});
$('bizGrid').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.dataset.openBiz) { setCurrent(e.target.dataset.openBiz, { silent: true }); go('dashboard'); }
});
$('archivedBody').addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.unarchive) {
    try { await FB.updateBusiness(btn.dataset.unarchive, { archived: false }); toast('Business restored'); }
    catch (err) { writeFailed(err, 'restoring the business'); }
  }
  if (btn.dataset.deleteBiz) {
    const b = state.businesses[btn.dataset.deleteBiz];
    const typed = prompt(`This permanently deletes "${b.name}" and ALL its records. It cannot be undone.\n\nType the business name to confirm:`);
    if (typed === null) return;
    if (typed.trim() !== b.name) { alert('The name did not match. Nothing was deleted.'); return; }
    try {
      toast('Deleting…');
      await FB.deleteBusiness(b.id);
      FB.track('delete_business');
      toast(`${b.name} deleted`);
    } catch (err) { writeFailed(err, 'deleting the business'); }
  }
});
$$('[data-new-business]').forEach(b => b.addEventListener('click', () => openBizDialog()));
$$('[data-edit-business]').forEach(b => b.addEventListener('click', () => B() && openBizDialog(B().id)));

function renderEmpty() {
  $('emptyTitle').textContent = isAdmin() ? 'Add your first business' : 'No business yet';
  $('emptyText').textContent = isAdmin()
    ? 'X-Station can manage several businesses — a charging centre, a shop, a restaurant… Each one gets its own records, dashboard and reports.'
    : 'You have not been given access to any business yet. Ask the admin to give you access.';
}

// ---------- add / edit business dialog ----------
let editingBiz = null;      // id, or null for a new business
let catDraft = [];          // [{ id, name, slot, isNew }]

function nextSlot(cats) {
  for (let s = 1; s <= MAX_CATS; s++) if (!cats.some(c => c.slot === s)) return s;
  return null;
}
function catsFromPreset(presetId) {
  const p = PRESETS.find(x => x.id === presetId) || PRESETS[0];
  return p.cats.map((name, i) => ({ id: slug(name), name, slot: i + 1, isNew: true }));
}
function renderCatRows() {
  $('catRows').innerHTML = catDraft.map((c, i) => `
    <div class="cat-row">
      <i class="key s${c.slot}"></i>
      <input type="text" value="${esc(c.name)}" data-cat-index="${i}" maxlength="30" required aria-label="Category name">
      <button type="button" class="icon-btn small" data-remove-cat="${i}" aria-label="Remove ${esc(c.name)}" ${catDraft.length <= 1 ? 'disabled' : ''}>×</button>
    </div>`).join('');
  $('addCatBtn').classList.toggle('hidden', catDraft.length >= MAX_CATS);
}
function openBizDialog(id = null) {
  if (!isAdmin()) return;
  editingBiz = id;
  const b = id ? state.businesses[id] : null;
  $('bizDialogTitle').textContent = b ? `Edit ${b.name}` : 'Add business';
  $('bType').innerHTML = PRESETS.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('bType').value = b ? b.type : 'shop';
  $('bName').value = b ? b.name : '';
  $('bCurrency').value = b ? b.currency : (B()?.currency || '₦');
  $('bTarget').value = b ? b.target : '';
  catDraft = b ? b.categories.map(c => ({ ...c })) : catsFromPreset('shop');
  renderCatRows();
  $('archiveBizBtn').classList.toggle('hidden', !b);
  $('bizMsg').classList.add('hidden');
  $('bizDialog').showModal();
  setTimeout(() => $('bName').focus(), 50);
}
$('bType').addEventListener('change', e => {
  // a new type suggests its categories; existing businesses keep categories that already have records
  if (!editingBiz) { catDraft = catsFromPreset(e.target.value); renderCatRows(); }
});
$('catRows').addEventListener('input', e => {
  const i = e.target.dataset.catIndex;
  if (i !== undefined) catDraft[i].name = e.target.value;
});
$('catRows').addEventListener('click', e => {
  const i = e.target.closest('[data-remove-cat]')?.dataset.removeCat;
  if (i === undefined) return;
  const c = catDraft[i];
  if (editingBiz && !c.isNew) {
    const used = Object.values(D(editingBiz)).some(r => Number(r.income?.[c.id] || 0) > 0);
    if (used) { bizMsg(`“${c.name}” already has recorded money, so it can't be removed. You can rename it instead.`); return; }
  }
  catDraft.splice(i, 1);
  renderCatRows();
});
$('addCatBtn').addEventListener('click', () => {
  if (catDraft.length >= MAX_CATS) return;
  catDraft.push({ id: '', name: '', slot: nextSlot(catDraft), isNew: true });
  renderCatRows();
  $('catRows').querySelector(`[data-cat-index="${catDraft.length - 1}"]`).focus();
});
function bizMsg(text) { $('bizMsg').textContent = text; $('bizMsg').classList.remove('hidden'); }

$('bizForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('bName').value.trim();
  const currency = $('bCurrency').value.trim() || '₦';
  const target = $('bTarget').value === '' ? '' : Number($('bTarget').value);
  const names = catDraft.map(c => c.name.trim());
  if (!name) return bizMsg('Enter the business name.');
  if (names.some(n => !n)) return bizMsg('Every category needs a name.');
  if (new Set(names.map(n => n.toLowerCase())).size !== names.length) return bizMsg('Two categories have the same name.');
  const used = new Set();
  const categories = catDraft.map(c => {
    let cid = c.isNew ? slug(c.name) : c.id;
    while (used.has(cid)) cid = `${slug(c.name)}-${rand()}`;
    used.add(cid);
    return { id: cid, name: c.name.trim(), slot: c.slot };
  });
  const fields = { name, type: $('bType').value, currency, target, categories };
  $('saveBizBtn').disabled = true;
  try {
    if (editingBiz) {
      await FB.updateBusiness(editingBiz, fields);
      FB.track('edit_business');
      toast('Business saved');
    } else {
      const id = `${slug(name)}-${rand()}`;
      await FB.createBusiness(id, fields);
      FB.track('add_business', { type: fields.type });
      pendingSwitch = id;     // switch to it as soon as it arrives from the database
      toast(`${name} added`);
    }
    $('bizDialog').close();
  } catch (err) {
    bizMsg(err.code === 'permission-denied' ? 'Not allowed — only admins can add or edit businesses.' : err.message);
  } finally {
    $('saveBizBtn').disabled = false;
  }
});
$('archiveBizBtn').addEventListener('click', async () => {
  const b = state.businesses[editingBiz];
  if (!b || !confirm(`Archive “${b.name}”?\n\nIt will be hidden for everyone, but its records are kept. You can restore it from the Businesses page.`)) return;
  try {
    await FB.updateBusiness(b.id, { archived: true });
    FB.track('archive_business');
    $('bizDialog').close();
    toast(`${b.name} archived`);
  } catch (err) { bizMsg(err.message); }
});
$$('dialog [data-close]').forEach(btn => btn.addEventListener('click', () => btn.closest('dialog').close()));

// =========================================================
// Dashboard
// =========================================================
function periodRange(p) {
  const T = todayStr();
  const ym = T.slice(0, 7);
  const prevYm = k => { const d = parseDate(ym + '-01'); d.setMonth(d.getMonth() - k); return dateStr(d).slice(0, 7); };
  switch (p) {
    case '7d':  return { start: addDays(T, -6), end: T, prevStart: addDays(T, -13), prevEnd: addDays(T, -7), vs: 'prev. 7 days', unit: 'day' };
    case '30d': return { start: addDays(T, -29), end: T, prevStart: addDays(T, -59), prevEnd: addDays(T, -30), vs: 'prev. 30 days', unit: 'day' };
    case 'lastmonth': {
      const a = prevYm(1), b = prevYm(2);
      return { start: a + '-01', end: monthEnd(a), prevStart: b + '-01', prevEnd: monthEnd(b), vs: monthName(b, { month: 'long' }), unit: 'day', month: a };
    }
    case 'year': {
      const y = +T.slice(0, 4);
      return { start: `${y}-01-01`, end: T, prevStart: `${y - 1}-01-01`, prevEnd: `${y - 1}${T.slice(4)}`, vs: `${y - 1}`, unit: 'month', year: y };
    }
    default: { // this month
      const a = prevYm(1);
      const day = Math.min(+T.slice(8), daysInMonth(a));
      return { start: ym + '-01', end: T, prevStart: a + '-01', prevEnd: `${a}-${pad(day)}`,
        vs: `${monthName(a, { month: 'short' })} 1–${day}`, unit: 'day', month: ym };
    }
  }
}

function deltaHtml(cur, prev, vs, upIsGood = true) {
  if (!prev) return `<span>No data for ${vs}</span>`;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 0.05) return `<span>No change vs ${vs}</span>`;
  const up = pct > 0;
  const good = up === upIsGood;
  return `<span class="${good ? 'up' : 'down'}"><b>${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</b></span> vs ${vs}`;
}

function renderDashboard() {
  const biz = B();
  if (!biz) return;
  const period = prefs.period;
  $$('#periodFilter button').forEach(b => b.classList.toggle('active', b.dataset.period === period));
  const R = periodRange(period);
  const list = between(R.start, R.end);
  const prev = totals(between(R.prevStart, R.prevEnd));
  const t = totals(list);
  const cats = biz.categories;

  $('dashRange').textContent = `${fmtDate(R.start, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmtDate(R.end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  $('todayAlert').classList.toggle('hidden', !!D()[todayStr()]);

  // target
  const target = Number(biz.target) || 0;
  const tgt = R.month ? target : R.year ? target * 12 : 0;
  let targetHtml = '';
  if (tgt) {
    const pct = (t.revenue / tgt) * 100;
    let text = `${money(t.revenue)} of ${money(tgt)} target`;
    if (period === 'month' && t.days) text += ` · on pace for ${compact(Math.round((t.revenue / +R.end.slice(8)) * daysInMonth(R.month)))}`;
    targetHtml = `<div class="target"><div class="target-row"><span>${text}</span><span>${Math.round(pct)}%</span></div>
      <div class="meter"><div class="meter-fill" style="width:${Math.min(100, pct)}%"></div></div></div>`;
  }

  const spanDays = Math.round((parseDate(R.end) - parseDate(R.start)) / 864e5) + 1;
  const best = list.reduce((b, r) => (!b || r.revenue > b.revenue ? r : b), null);
  const tile = (label, value, foot) => `<div class="card kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${foot}</div>`;
  $('kpiGrid').innerHTML =
    `<div class="card hero"><div class="kpi-label">Total revenue</div><div class="hero-value">${money(t.revenue)}</div>
      <div class="delta">${deltaHtml(t.revenue, prev.revenue, R.vs)}</div>${targetHtml}</div>` +
    cats.map(c => tile(`${keyHtml(c)}${esc(c.name)}`, money(catAmount(t, c)),
      `<div class="delta">${deltaHtml(catAmount(t, c), catAmount(prev, c), R.vs)}</div>`)).join('') +
    tile('Expenses', money(t.expenses), `<div class="delta">${deltaHtml(t.expenses, prev.expenses, R.vs, false)}</div>`) +
    tile('Net profit', money(t.profit), `<div class="delta">${deltaHtml(t.profit, prev.profit, R.vs)}</div>`) +
    tile('Average per day', money(t.days ? t.revenue / t.days : 0), `<div class="kpi-foot">${t.days} of ${spanDays} days recorded</div>`) +
    tile('Best day', best ? money(best.revenue) : '—', `<div class="kpi-foot">${best ? fmtDate(best.date) : 'No records yet'}</div>`);
  $('kpiGrid').dataset.tiles = cats.length + 4;

  // trend chart
  const labels = [], titles = [];
  const values = cats.map(() => []);
  if (R.unit === 'month') {
    for (let m = 1; m <= +R.end.slice(5, 7); m++) {
      const ym = `${R.year}-${pad(m)}`;
      const mt = totals(list.filter(r => r.date.startsWith(ym)));
      labels.push(monthName(ym, { month: 'short' }));
      titles.push(monthName(ym));
      cats.forEach((c, k) => values[k].push(catAmount(mt, c)));
    }
    $('trendSub').textContent = 'Monthly revenue by category';
  } else {
    const byDate = Object.fromEntries(list.map(r => [r.date, r]));
    for (let d = R.start; d <= R.end; d = addDays(d, 1)) {
      const r = byDate[d];
      labels.push(period === '7d' ? fmtDate(d, { weekday: 'short' }) : spanDays > 31 || period === '30d' ? fmtDate(d, { day: 'numeric', month: 'short' }) : String(+d.slice(8)));
      titles.push(fmtDate(d));
      cats.forEach((c, k) => values[k].push(r ? catAmount(r, c) : 0));
    }
    $('trendSub').textContent = 'Daily revenue by category';
  }
  const series = cats.map((c, k) => ({ name: esc(c.name), cls: `s${c.slot}`, values: values[k] }));
  $('trendLegend').innerHTML = cats.length > 1 ? legendHtml(biz) : '';
  Charts.stackedColumns($('trendChart'), {
    labels, titles, series, fmt: v => money(v), fmtAxis: v => compact(v),
    labelWidth: period === '30d' ? 52 : 40, emptyText: 'No records in this period', ariaLabel: 'Revenue trend',
  });
  $('trendTable').innerHTML = seriesTable(titles, series);

  // revenue mix
  $('mixBar').innerHTML = t.revenue
    ? cats.map(c => { const w = (catAmount(t, c) / t.revenue) * 100; return w ? `<div style="width:${w}%;background:var(--series-${c.slot})"></div>` : ''; }).join('')
    : '';
  $('mixList').innerHTML = cats.map(c => {
    const v = catAmount(t, c);
    return `<li>${keyHtml(c)}<span class="name">${esc(c.name)}</span><b>${money(v)}</b><span class="pct">${t.revenue ? ((v / t.revenue) * 100).toFixed(0) : 0}%</span></li>`;
  }).join('');
  const margin = t.revenue ? (t.profit / t.revenue) * 100 : null;
  $('marginValue').textContent = margin === null ? '—' : margin.toFixed(1) + '%';
  $('marginSub').textContent = t.revenue ? `${money(t.profit)} kept from ${money(t.revenue)} revenue after ${money(t.expenses)} expenses` : 'No revenue in this period';

  // weekday averages (Mon → Sun)
  const wd = [1, 2, 3, 4, 5, 6, 0].map(w => {
    const rs = list.filter(r => parseDate(r.date).getDay() === w);
    const label = new Date(2024, 0, 7 + w).toLocaleDateString(undefined, { weekday: 'short' }); // Jan 7 2024 = Sunday
    return { label, value: rs.length ? totals(rs).revenue / rs.length : 0, title: `${rs.length} day(s) recorded` };
  });
  Charts.hbars($('weekdayChart'), wd, v => money(v));

  // recent days
  const days = D();
  const recent = Object.keys(days).sort().reverse().slice(0, 5).map(d => ({ date: d, updatedBy: days[d].updatedBy, ...calc(days[d]) }));
  $('recentBody').innerHTML = recent.length
    ? recent.map(r => `<tr class="clickable" data-date="${r.date}">
        <td class="row-title">${fmtDate(r.date)}</td>
        <td class="num" data-label="Revenue"><b>${money(r.revenue)}</b></td>
        <td class="num" data-label="Expenses">${money(r.expenses)}</td>
        <td class="num ${r.profit < 0 ? 'neg' : ''}" data-label="Profit">${money(r.profit)}</td>
        <td class="muted-cell" data-label="Saved by">${esc(personName(r.updatedBy))}</td></tr>`).join('')
    : `<tr><td colspan="5" class="empty">No days recorded yet. <a href="#record">Record your first day →</a></td></tr>`;
}

function seriesTable(titles, series) {
  const rows = titles.map((t, i) => {
    const tot = series.reduce((s, x) => s + x.values[i], 0);
    return tot ? `<tr><td class="row-title">${t}</td>${series.map(s => `<td class="num" data-label="${s.name}">${money(s.values[i])}</td>`).join('')}<td class="num" data-label="Total"><b>${money(tot)}</b></td></tr>` : '';
  }).join('');
  return `<div class="table-wrap"><table class="stack"><thead><tr><th>Period</th>${series.map(s => `<th class="num">${s.name}</th>`).join('')}<th class="num">Total</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="${series.length + 2}" class="empty">No records</td></tr>`}</tbody></table></div>`;
}

$('periodFilter').addEventListener('click', e => {
  const p = e.target.closest('button')?.dataset.period;
  if (!p) return;
  prefs.period = p;
  savePrefs();
  renderDashboard();
});
$('recentBody').addEventListener('click', e => {
  const row = e.target.closest('tr[data-date]');
  if (row) { workDate = row.dataset.date; go('record'); }
});
$('todayAlertBtn').addEventListener('click', () => { workDate = todayStr(); });

$$('[data-table-toggle]').forEach(btn => btn.addEventListener('click', () => {
  const tv = $(btn.dataset.tableToggle + 'Table');
  tv.classList.toggle('hidden');
  btn.textContent = tv.classList.contains('hidden') ? 'Show table' : 'Hide table';
}));

// =========================================================
// Record day
// =========================================================
function setDate(d) { workDate = d; loadForm(); renderRecordSide(); }
$('workDate').addEventListener('change', e => e.target.value && setDate(e.target.value));
$('prevDay').addEventListener('click', () => setDate(addDays(workDate, -1)));
$('nextDay').addEventListener('click', () => setDate(addDays(workDate, 1)));
$('goToday').addEventListener('click', () => setDate(todayStr()));

let formDirty = false; // true while the person is typing, so live updates don't overwrite the form
let fieldsFor = null;  // business id + categories the income inputs were built for

function renderIncomeFields() {
  const biz = B();
  if (!biz) { $('incomeFields').innerHTML = ''; fieldsFor = null; return; }
  const sig = biz.id + '|' + biz.categories.map(c => c.id + c.name + c.slot).join(',');
  if (sig === fieldsFor) return;
  fieldsFor = sig;
  $('incomeFields').innerHTML = biz.categories.map(c => `
    <label><span>${keyHtml(c)}${esc(c.name)}</span>
      <input type="number" class="big" data-cat="${c.id}" min="0" step="any" placeholder="0" inputmode="decimal">
    </label>`).join('');
  $('incomeFields').classList.toggle('single', biz.categories.length === 1);
}
$('dayForm').addEventListener('input', e => {
  if (e.target.matches('input:not([type=date])')) { formDirty = true; updateFormTotals(); }
});

function loadForm() {
  const biz = B();
  if (!biz) return;
  renderIncomeFields();
  formDirty = false;
  const r = D()[workDate];
  $('workDate').value = workDate;
  $$('#incomeFields [data-cat]').forEach(inp => { const v = r?.income?.[inp.dataset.cat]; inp.value = v ? v : ''; });
  $('fExpenses').value = r && r.expenses ? r.expenses : '';
  $('fNote').value = r ? r.note || '' : '';
  $('saveBtn').textContent = r ? 'Update day' : 'Save day';
  $('deleteBtn').classList.toggle('hidden', !r || !isAdmin()); // only admins can delete days
  $('formStatus').textContent = r
    ? `✔ ${fmtDate(workDate)} is recorded${r.updatedBy ? ` (last saved by ${personName(r.updatedBy)})` : ''}. Change the numbers and press Update.`
    : `No record yet for ${fmtDate(workDate)}.`;
  updateFormTotals();
}
function formValues() {
  const income = {};
  $$('#incomeFields [data-cat]').forEach(inp => { income[inp.dataset.cat] = Number(inp.value) || 0; });
  // keep amounts of categories that are no longer shown, so nothing is lost
  const old = D()[workDate]?.income || {};
  Object.keys(old).forEach(k => { if (!(k in income)) income[k] = old[k]; });
  return { income, expenses: Number($('fExpenses').value) || 0, note: $('fNote').value.trim() };
}
function updateFormTotals() {
  const c = calc(formValues());
  $('fRevenue').textContent = money(c.revenue);
  $('fExp').textContent = money(c.expenses);
  $('fProfit').textContent = money(c.profit);
  renderCompare(c.revenue);
}

function renderCompare(rev) {
  const typed = rev > 0 || !!D()[workDate];
  const row = (label, sub, other) => {
    if (other == null) return `<div><span class="c-label">${label}<small>${sub}</small></span><span class="c-val">—<small>no record</small></span></div>`;
    if (!typed) return `<div><span class="c-label">${label}<small>${sub}</small></span><span class="c-val">${money(other)}</span></div>`;
    const diff = rev - other;
    const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
    const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '';
    const pct = other ? ` (${Math.abs((diff / other) * 100).toFixed(0)}%)` : '';
    return `<div><span class="c-label">${label}<small>${sub}</small></span>
      <span class="c-val">${money(other)}<small class="${cls}">${arrow} ${money(Math.abs(diff))}${pct}</small></span></div>`;
  };
  const days = D();
  const y = addDays(workDate, -1), w = addDays(workDate, -7);
  const ym = workDate.slice(0, 7);
  const others = between(ym + '-01', monthEnd(ym)).filter(r => r.date !== workDate);
  const avg = others.length ? totals(others).revenue / others.length : null;
  $('compareBox').innerHTML =
    `<div><span class="c-label"><b>This day</b><small>${fmtDate(workDate)}</small></span><span class="c-val">${money(rev)}</span></div>` +
    row('Yesterday', fmtDate(y, { weekday: 'short', day: 'numeric', month: 'short' }), days[y] ? calc(days[y]).revenue : null) +
    row('Same day last week', fmtDate(w, { weekday: 'short', day: 'numeric', month: 'short' }), days[w] ? calc(days[w]).revenue : null) +
    row('Month average', `${others.length} other day(s) in ${monthName(ym, { month: 'long' })}`, avg);
}

function renderRecordSide() {
  if (!B()) return;
  const ym = workDate.slice(0, 7);
  const list = between(ym + '-01', monthEnd(ym));
  $('monthListTitle').textContent = monthName(ym);
  $('monthListTotal').textContent = money(totals(list).revenue);
  $('monthListBody').innerHTML = list.length
    ? list.slice().reverse().map(r => `<tr class="clickable ${r.date === workDate ? 'selected' : ''}" data-date="${r.date}">
        <td class="row-title">${fmtDate(r.date)}</td>
        <td class="num" data-label="Revenue"><b>${money(r.revenue)}</b></td>
        <td class="num" data-label="Expenses">${money(r.expenses)}</td>
        <td class="num ${r.profit < 0 ? 'neg' : ''}" data-label="Profit">${money(r.profit)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">No days recorded this month</td></tr>';
}
$('monthListBody').addEventListener('click', e => {
  const row = e.target.closest('tr[data-date]');
  if (row) { setDate(row.dataset.date); $('dayForm').scrollIntoView({ behavior: 'smooth' }); }
});

$('dayForm').addEventListener('submit', e => {
  e.preventDefault();
  const biz = B();
  if (!biz) return;
  const v = formValues();
  const c = calc(v);
  if (!c.revenue && !confirm('All income amounts are 0. Save anyway?')) return;
  const existed = !!D()[workDate];
  const date = workDate;
  state.days[biz.id] = { ...D(), [date]: { ...v, updatedBy: FB.currentUser()?.email || '' } };
  // Firestore applies the write locally at once (works offline) and uploads in the background.
  FB.saveDay(biz.id, date, v).catch(err => writeFailed(err, `saving ${fmtDate(date)}`));
  FB.track('record_day', { revenue: c.revenue, update: existed });
  loadForm();
  renderRecordSide();
  renderShell();
  toast(`${existed ? 'Updated' : 'Saved'} ${fmtDate(date, { day: 'numeric', month: 'short' })} — revenue ${money(c.revenue)}${navigator.onLine ? '' : ' (will sync when online)'}`);
});
$('deleteBtn').addEventListener('click', () => {
  const biz = B();
  if (!biz || !confirm(`Delete the record for ${fmtDate(workDate)}?`)) return;
  const date = workDate;
  const days = { ...D() };
  delete days[date];
  state.days[biz.id] = days;
  FB.removeDay(biz.id, date).catch(err => writeFailed(err, `deleting ${fmtDate(date)}`));
  FB.track('delete_day');
  loadForm();
  renderRecordSide();
  renderShell();
  toast('Deleted');
});

// =========================================================
// Reports
// =========================================================
function renderReports() {
  const biz = B();
  if (!biz) return;
  if (!$('reportMonth').value) $('reportMonth').value = todayStr().slice(0, 7);
  if (!$('reportYear').value) $('reportYear').value = todayStr().slice(0, 4);
  const cats = biz.categories;
  const ym = $('reportMonth').value;
  const list = between(ym + '-01', monthEnd(ym));
  const t = totals(list);

  $('reportTitle').textContent = 'Monthly statement — ' + monthName(ym);
  $('reportKpis').innerHTML = `
    <div class="card kpi"><div class="kpi-label">Revenue</div><div class="kpi-value">${money(t.revenue)}</div>
      <div class="kpi-foot">${t.days ? `${t.days} days · avg ${money(t.revenue / t.days)}/day` : 'No records'}</div></div>
    <div class="card kpi"><div class="kpi-label">Expenses</div><div class="kpi-value">${money(t.expenses)}</div></div>
    <div class="card kpi"><div class="kpi-label">Net profit</div><div class="kpi-value">${money(t.profit)}</div>
      <div class="kpi-foot">${t.revenue ? ((t.profit / t.revenue) * 100).toFixed(1) + '% margin' : ''}</div></div>
    <div class="card kpi"><div class="kpi-label">Top category</div><div class="kpi-value">${(() => {
      const top = cats.slice().sort((a, b) => catAmount(t, b) - catAmount(t, a))[0];
      return top && catAmount(t, top) ? `${keyHtml(top)} ${esc(top.name)}` : '—';
    })()}</div></div>`;

  $('reportHead').innerHTML = `<tr><th>Date</th>${cats.map(c => `<th class="num">${esc(c.name)}</th>`).join('')}
    <th class="num">Revenue</th><th class="num">Expenses</th><th class="num">Profit</th><th>Note</th></tr>`;
  $('reportBody').innerHTML = list.length
    ? list.map(r => `<tr class="clickable" data-date="${r.date}">
        <td class="row-title">${fmtDate(r.date)}</td>
        ${cats.map(c => `<td class="num" data-label="${esc(c.name)}">${money(catAmount(r, c))}</td>`).join('')}
        <td class="num" data-label="Revenue"><b>${money(r.revenue)}</b></td>
        <td class="num" data-label="Expenses">${money(r.expenses)}</td>
        <td class="num ${r.profit < 0 ? 'neg' : ''}" data-label="Profit">${money(r.profit)}</td>
        <td class="note ${r.note ? '' : 'empty-cell'}" data-label="Note">${esc(r.note)}</td></tr>`).join('')
    : `<tr><td colspan="${cats.length + 5}" class="empty">No records this month</td></tr>`;
  $('reportFoot').innerHTML = list.length
    ? `<tr><td class="row-title">Month total</td>
        ${cats.map(c => `<td class="num" data-label="${esc(c.name)}">${money(catAmount(t, c))}</td>`).join('')}
        <td class="num" data-label="Revenue">${money(t.revenue)}</td><td class="num" data-label="Expenses">${money(t.expenses)}</td>
        <td class="num" data-label="Profit">${money(t.profit)}</td><td class="empty-cell"></td></tr>` : '';

  // year chart
  const year = $('reportYear').value;
  const titles = [], labels = [];
  const values = cats.map(() => []);
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${pad(m)}`;
    const mt = totals(between(key + '-01', key + '-31'));
    labels.push(monthName(key, { month: 'short' }));
    titles.push(monthName(key));
    cats.forEach((c, k) => values[k].push(catAmount(mt, c)));
  }
  const series = cats.map((c, k) => ({ name: esc(c.name), cls: `s${c.slot}`, values: values[k] }));
  $('yearLegend').innerHTML = cats.length > 1 ? legendHtml(biz) : '';
  Charts.stackedColumns($('yearChart'), {
    labels, titles, series, fmt: v => money(v), fmtAxis: v => compact(v), labelWidth: 34,
    emptyText: `No records in ${year}`, ariaLabel: 'Monthly revenue for the year',
  });
  $('yearTable').innerHTML = seriesTable(titles, series);
}
$('reportMonth').addEventListener('change', renderReports);
$('reportYear').addEventListener('change', renderReports);
$('reportBody').addEventListener('click', e => {
  const row = e.target.closest('tr[data-date]');
  if (row) { workDate = row.dataset.date; go('record'); }
});
$('printBtn').addEventListener('click', () => window.print());

function csvCell(v) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }
$('exportCsv').addEventListener('click', () => {
  const biz = B();
  const cats = biz.categories;
  const ym = $('reportMonth').value || todayStr().slice(0, 7);
  const list = between(ym + '-01', monthEnd(ym));
  const t = totals(list);
  const rows = [['Date', ...cats.map(c => c.name), 'Revenue', 'Expenses', 'Profit', 'Note']];
  list.forEach(r => rows.push([r.date, ...cats.map(c => catAmount(r, c)), r.revenue, r.expenses, r.profit, r.note]));
  rows.push(['TOTAL', ...cats.map(c => catAmount(t, c)), t.revenue, t.expenses, t.profit, '']);
  download(`${biz.name}-${ym}.csv`, rows.map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv');
});

// =========================================================
// Settings
// =========================================================
function applyTheme() {
  const th = prefs.theme;
  if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th;
  else delete document.documentElement.dataset.theme;
  const dark = th === 'dark' || (th !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]').content = dark ? '#0b0d11' : '#101828';
}
function renderSettings() {
  $('setTheme').value = prefs.theme;
  const biz = B();
  $('bizSummary').innerHTML = biz ? `
    <div class="biz-card-head">
      <span class="biz-avatar">${esc(biz.name.trim()[0] || '?').toUpperCase()}</span>
      <div class="biz-title"><strong>${esc(biz.name)}</strong><span class="sub">${esc(presetName(biz.type))} · ${esc(biz.currency)}${biz.target ? ` · target ${money(biz.target)}/month` : ''}</span></div>
    </div>
    <div class="biz-legend mt">${legendHtml(biz)}</div>` : '<p class="sub">No business selected.</p>';
  renderInstall();
}
$('setTheme').addEventListener('change', e => { prefs.theme = e.target.value; savePrefs(); applyTheme(); });

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('backupBtn').addEventListener('click', () => {
  const biz = B();
  if (!biz) return;
  const days = {};
  Object.keys(D()).sort().forEach(d => { const { updatedBy, ...r } = D()[d]; days[d] = r; });
  const { name, type, currency, target, categories } = biz;
  download(`${biz.name}-backup-${todayStr()}.json`,
    JSON.stringify({ app: 'x-station', version: 2, business: { name, type, currency, target, categories }, days }, null, 2), 'application/json');
  FB.track('download_backup');
});
$('restoreFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  const biz = B();
  e.target.value = '';
  if (!file || !isAdmin() || !biz) return;
  let imported;
  try {
    imported = JSON.parse(await file.text());
    if (!imported.days || typeof imported.days !== 'object') throw new Error('bad file');
  } catch {
    alert('That file is not a valid backup.');
    return;
  }
  const n = Object.keys(imported.days).length;
  if (!confirm(`Replace ALL records of “${biz.name}” with the ${n} day(s) in this backup?`)) return;
  toast('Restoring backup…');
  try {
    // make sure every income category in the backup exists in this business
    const ids = new Set();
    Object.values(imported.days).forEach(r => Object.keys(FB.normalizeDay(r).income).forEach(k => ids.add(k)));
    const known = (imported.business?.categories || []);
    const cats = biz.categories.map(c => ({ ...c }));
    for (const id of ids) {
      if (cats.some(c => c.id === id)) continue;
      const slot = nextSlot(cats);
      if (!slot) throw new Error('The backup has more income categories than this business can hold (6).');
      const name = known.find(k => k.id === id)?.name || id.charAt(0).toUpperCase() + id.slice(1);
      cats.push({ id, name, slot });
    }
    if (cats.length !== biz.categories.length || biz.legacy) {
      await FB.updateBusiness(biz.id, { name: biz.name, type: biz.type, currency: biz.currency, target: biz.target, categories: cats });
    }
    await FB.uploadDays(biz.id, imported.days, true, D());
    FB.track('restore_backup', { days: n });
    toast(`Backup restored — ${n} day(s)`);
  } catch (err) {
    writeFailed(err, 'restoring the backup');
  }
});

// =========================================================
// Progressive web app: offline cache, install button, updates
// =========================================================
let installEvent = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function renderInstall() {
  const canPrompt = !!installEvent && !isStandalone();
  $$('[data-install]').forEach(b => b.classList.toggle('hidden', !canPrompt));
  $('installText').textContent = isStandalone()
    ? '✔ X-Station is installed on this device.'
    : canPrompt ? 'Add X-Station to your home screen to open it like an app — full screen, with its own icon, even offline.'
    : isIOS() ? 'On iPhone/iPad: tap the Share button in Safari, then “Add to Home Screen”.'
    : 'Open your browser menu and choose “Install app” or “Add to Home screen”.';
}
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvent = e;
  renderInstall();
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  renderInstall();
  toast('X-Station installed');
  FB.track('pwa_installed');
});
$$('[data-install]').forEach(b => b.addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  renderInstall();
}));

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      const offer = w => {
        $('updateBar').classList.remove('hidden');
        $('updateBtn').onclick = () => w.postMessage('skipWaiting');
      };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000); // look for a new version hourly
    } catch (err) { console.warn('Service worker not registered', err); }
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

// =========================================================
// Cloud: errors, sync status
// =========================================================
function writeFailed(err, what) {
  console.error(err);
  const msg = err.code === 'permission-denied'
    ? 'Permission denied — your account is not allowed to do this (or the Firestore rules are not published, see SETUP.md).'
    : err.message;
  alert(`Problem ${what}: ${msg}`);
}

function renderSync() {
  const s = state.sync[state.current] || { fromCache: true, pending: false };
  const pending = Object.values(state.sync).some(x => x.pending);
  const [cls, text] = !navigator.onLine ? ['offline', 'Offline — changes saved on this device']
    : pending ? ['pending', 'Syncing…']
    : s.fromCache ? ['pending', 'Connecting…']
    : ['ok', 'All changes synced'];
  $$('[data-sync]').forEach(el => {
    el.className = 'sync ' + cls;
    el.querySelector('span').textContent = text;
  });
}
window.addEventListener('online', renderSync);
window.addEventListener('offline', renderSync);

// Re-draw after live data arrives, without wiping what someone is typing.
let refreshQueued = false;
function refreshFromCloud() {
  if (!state.ready || refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    const page = currentPage();
    if (page === 'record' && B()) {
      renderShell();
      renderIncomeFields();
      if (!formDirty) loadForm(); else updateFormTotals();
      renderRecordSide();
    } else {
      route();
    }
  });
}

// Offer to move records that were saved on this device before Firebase was added (first business only).
async function migrateLegacy() {
  const legacy = readJSON(LEGACY_KEY);
  if (!legacy || !legacy.days || !state.businesses.main) return;
  const missing = {};
  Object.entries(legacy.days).forEach(([d, r]) => { if (!D('main')[d]) missing[d] = r; });
  const n = Object.keys(missing).length;
  if (!n) { localStorage.removeItem(LEGACY_KEY); return; }
  if (!confirm(`Found ${n} day(s) saved on this device from before. Upload them to “${state.businesses.main.name}”?`)) return;
  try {
    await FB.uploadDays('main', missing);
    localStorage.removeItem(LEGACY_KEY);
    toast(`Uploaded ${n} day(s) to the cloud`);
    FB.track('migrate_local', { days: n });
  } catch (err) {
    writeFailed(err, 'uploading old records');
  }
}

// =========================================================
// Session: who is signed in, and what they may do
// =========================================================
let me = null;              // this user's member record { email, name, role, active, businesses }
let members = [];           // all users (admins only)
let meUnsub = null, membersUnsub = null;
let bizUnsubs = {};         // business id → unsubscribe (business document)
let dayUnsubs = {};         // business id → unsubscribe (its day records)
let settingUp = false;      // true while the first admin account is being created
let pendingSwitch = null;   // business just created by this admin — open it when it arrives

const isAdmin = () => !!(me && me.active && me.role === 'admin');
const myBusinessIds = () => (Array.isArray(me?.businesses) ? me.businesses : ['main']);
function personName(email) {
  if (!email) return '—';
  if (email === FB.currentUser()?.email) return 'You';
  const m = members.find(x => x.email === email);
  return m?.name || email.split('@')[0];
}

function showScreen(name) {
  document.body.classList.remove('booting');
  $('authScreen').classList.toggle('hidden', name !== 'auth');
  $('noAccessScreen').classList.toggle('hidden', name !== 'noaccess');
  $('app').classList.toggle('hidden', name !== 'app');
}

function startSession(user) {
  $$('[data-user-email]').forEach(el => { el.textContent = user.email; });
  meUnsub = FB.watchMe(m => {
    const wasAdmin = isAdmin();
    const oldBiz = JSON.stringify(me?.businesses ?? null);
    me = m;
    if (!m || !m.active) { stopData(); showNoAccess(m); return; }
    applyRole();
    // (re)start business listeners when starting, or when role / business access changed
    if (!Object.keys(bizUnsubs).length || wasAdmin !== isAdmin() || oldBiz !== JSON.stringify(m.businesses ?? null)) startBusinesses();
    else refreshFromCloud();
  }, err => { stopData(); showNoAccess(null, err); });
}

function startBusinesses() {
  stopBusinesses();
  state.ready = false;
  let first = true;
  const onList = list => {
    const byId = {};
    list.forEach(raw => { byId[raw.id] = normBiz(raw.id, raw); });
    state.businesses = byId;
    syncDayListeners();
    if (first) { first = false; onBusinessesReady(); }
    if (pendingSwitch && state.businesses[pendingSwitch]) { const id = pendingSwitch; pendingSwitch = null; setCurrent(id, { silent: true }); go('dashboard'); }
    pickCurrent();
    refreshFromCloud();
  };
  if (isAdmin()) {
    bizUnsubs.__all = FB.watchAllBusinesses(onList, err => writeFailed(err, 'loading businesses'));
  } else {
    // staff: one listener per business they were given
    const ids = myBusinessIds();
    const got = {};
    if (!ids.length) onList([]);
    ids.forEach(id => {
      bizUnsubs[id] = FB.watchBusiness(id, b => {
        // the first business may not have a document yet (older setups) — use its defaults
        got[id] = b || (id === 'main' ? { id: 'main' } : null);
        if (Object.keys(got).length === ids.length) onList(Object.values(got).filter(Boolean));
      }, () => { got[id] = null; if (Object.keys(got).length === ids.length) onList(Object.values(got).filter(Boolean)); });
    });
  }
}

// Older setups kept the first business's records without a business document — create it once.
async function ensureMainBusiness() {
  if (!isAdmin() || state.businesses.main) return;
  try {
    if (await FB.hasDays('main')) {
      const b = normBiz('main', {});
      await FB.createBusiness('main', { name: b.name, type: b.type, currency: b.currency, target: b.target, categories: b.categories });
    }
  } catch (err) { console.warn('could not create the first business', err); }
}

function onBusinessesReady() {
  state.ready = true;
  showScreen('app');
  pickCurrent();
  renderIncomeFields();
  route();
  ensureMainBusiness();
  setTimeout(migrateLegacy, 3000); // give the records a moment to arrive so we compare against cloud data
}

// Choose which business to show: the last one used on this device, else the first available.
function pickCurrent() {
  const list = activeBusinesses();
  if (state.current && state.businesses[state.current] && !state.businesses[state.current].archived) return;
  const next = (prefs.biz && list.find(b => b.id === prefs.biz)) || list[0];
  state.current = next ? next.id : null;
  renderIncomeFields();
}

// Keep one live listener on the day records of every active business we can see.
function syncDayListeners() {
  const want = new Set(activeBusinesses().map(b => b.id));
  Object.keys(dayUnsubs).forEach(id => {
    if (!want.has(id)) { dayUnsubs[id](); delete dayUnsubs[id]; delete state.days[id]; delete state.sync[id]; }
  });
  want.forEach(id => {
    if (dayUnsubs[id]) return;
    dayUnsubs[id] = FB.watchDays(id, (days, meta) => {
      state.days[id] = days;
      state.sync[id] = meta;
      renderSync();
      refreshFromCloud();
    }, err => writeFailed(err, `loading records of ${state.businesses[id]?.name || id}`));
  });
}

function stopBusinesses() {
  Object.values(bizUnsubs).forEach(u => u());
  Object.values(dayUnsubs).forEach(u => u());
  bizUnsubs = {}; dayUnsubs = {};
  state.businesses = {}; state.days = {}; state.sync = {};
}
function stopData() {
  stopBusinesses();
  if (membersUnsub) { membersUnsub(); membersUnsub = null; }
  members = [];
  state.ready = false;
  state.current = null;
}
function endSession() {
  if (meUnsub) { meUnsub(); meUnsub = null; }
  stopData();
  me = null;
  document.body.classList.remove('is-admin');
  $('authPassword').value = '';
  showScreen('auth');
  setAuthMode('signin');
  const timeout = new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), 10000));
  Promise.race([FB.isSetupDone(), timeout])
    .then(done => { if (!done) setAuthMode('setup'); })
    .catch(err => {
      showAuthError(!navigator.onLine
        ? 'You are offline. Connect to the internet to sign in.'
        : 'Cannot reach the database. If this is a new setup, finish steps 2–3 in SETUP.md (create Firestore and publish the rules), then reload this page.');
      console.warn('setup check failed', err);
    });
}

// Show / hide admin-only parts, start the user list for admins.
function applyRole() {
  const admin = isAdmin();
  document.body.classList.toggle('is-admin', admin);
  $$('[data-user-role]').forEach(el => {
    el.textContent = me.role;
    el.className = 'role-tag ' + me.role;
  });
  if (admin && !membersUnsub) {
    membersUnsub = FB.watchMembers(list => {
      members = list;
      if (currentPage() === 'admin') renderAdmin();
    }, err => writeFailed(err, 'loading users'));
  }
  if (!admin && membersUnsub) { membersUnsub(); membersUnsub = null; members = []; }
  if (!admin && currentPage() === 'admin') go('dashboard');
}

async function showNoAccess(m, err) {
  if (settingUp) return; // first admin is being created — the member record arrives in a moment
  showScreen('noaccess');
  $('claimBox').classList.add('hidden');
  $('noAccessError').classList.add('hidden');
  if (err) {
    $('noAccessText').textContent = 'Could not check your access.';
    $('noAccessError').textContent = err.code === 'permission-denied'
      ? 'The Firestore security rules are not published yet (see SETUP.md step 3).'
      : err.message;
    $('noAccessError').classList.remove('hidden');
    return;
  }
  if (m && !m.active) {
    $('noAccessText').textContent = 'Your access to X-Station has been removed by the admin. Contact the admin if this is a mistake.';
    return;
  }
  $('noAccessText').textContent = 'This account has not been given access. Ask the admin to add you.';
  try {
    if (!(await FB.isSetupDone())) {
      $('noAccessText').textContent = 'No admin has been set up yet. You can make this account the admin.';
      $('claimBox').classList.remove('hidden');
    }
  } catch { /* keep the default message */ }
}
$('claimBtn').addEventListener('click', async () => {
  $('claimBtn').disabled = true;
  try {
    await FB.claimAdmin($('claimName').value.trim());
    FB.track('setup_admin');
  } catch (err) {
    $('noAccessError').textContent = err.code === 'permission-denied'
      ? 'Not allowed — an admin already exists, or the security rules are not published.'
      : err.message;
    $('noAccessError').classList.remove('hidden');
  } finally {
    $('claimBtn').disabled = false;
  }
});

// =========================================================
// Users page (admin)
// =========================================================
function initials(m) {
  const src = (m.name || m.email || '?').trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
function tsDate(ts) {
  const d = ts && ts.toDate ? ts.toDate() : null;
  return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}
function userCell(m) {
  const you = m.uid === FB.currentUser()?.uid;
  return `<div class="user-cell"><span class="avatar">${esc(initials(m))}</span>
    <span class="who"><b>${esc(m.name || m.email.split('@')[0])}${you ? '<span class="you">(you)</span>' : ''}</b><small>${esc(m.email)}</small></span></div>`;
}
const memberBiz = m => (Array.isArray(m.businesses) ? m.businesses : ['main']);
function bizNames(ids) {
  const names = ids.map(id => state.businesses[id]).filter(b => b && !b.archived).map(b => b.name);
  return names.length ? names.map(esc).join(', ') : '<span class="warn-text">None</span>';
}
function bizChecks(selected) {
  const list = activeBusinesses();
  return list.length
    ? list.map(b => `<label class="check"><input type="checkbox" value="${b.id}" ${selected.includes(b.id) ? 'checked' : ''}> ${esc(b.name)}</label>`).join('')
    : '<p class="sub">No businesses yet — add one on the Businesses page.</p>';
}

function renderAdmin() {
  if (!isAdmin()) return;
  const active = members.filter(m => m.active);
  const removed = members.filter(m => !m.active);
  $('aActive').textContent = active.length;
  $('aAdmins').textContent = active.filter(m => m.role === 'admin').length;
  $('aStaff').textContent = active.filter(m => m.role === 'staff').length;
  $('aRemoved').textContent = removed.length;

  // business checkboxes in the add-user form (keep what is already ticked)
  const ticked = [...$$('#uBizList input:checked')].map(i => i.value);
  $('uBizList').innerHTML = bizChecks(ticked.length ? ticked : (state.current ? [state.current] : []));
  $('uBizField').classList.toggle('hidden', $('uRole').value === 'admin');

  const q = $('userSearch').value.trim().toLowerCase();
  const match = m => !q || (m.name || '').toLowerCase().includes(q) || m.email.toLowerCase().includes(q);
  const sort = (a, b) => (a.role === b.role ? (a.name || a.email).localeCompare(b.name || b.email) : a.role === 'admin' ? -1 : 1);
  const myUid = FB.currentUser()?.uid;

  const rows = active.filter(match).sort(sort).map(m => {
    const you = m.uid === myUid;
    return `<tr>
      <td class="row-title">${userCell(m)}</td>
      <td data-label="Role">
        <select class="role-select" data-role-uid="${m.uid}" ${you ? 'disabled title="You cannot change your own role"' : ''}>
          <option value="staff" ${m.role === 'staff' ? 'selected' : ''}>Staff</option>
          <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select>
      </td>
      <td data-label="Businesses" class="biz-cell">${m.role === 'admin' ? 'All businesses' : bizNames(memberBiz(m))}</td>
      <td class="num" data-label="Actions"><span class="actions">
        ${m.role === 'staff' ? `<button class="btn ghost" data-access="${m.uid}">Access</button>` : ''}
        <button class="btn ghost" data-reset="${esc(m.email)}">Reset password</button>
        ${you ? '' : `<button class="btn ghost danger" data-remove="${m.uid}">Delete</button>`}
      </span></td></tr>`;
  }).join('');
  $('usersBody').innerHTML = rows || `<tr><td colspan="4" class="empty">${q ? 'No users match your search' : 'No users yet'}</td></tr>`;

  $('removedCount').textContent = removed.length;
  $('removedBox').classList.toggle('hidden', !removed.length);
  $('removedBody').innerHTML = removed.sort(sort).map(m => `<tr>
      <td class="row-title">${userCell(m)}</td>
      <td data-label="Role">${m.role === 'admin' ? 'Admin' : 'Staff'}</td>
      <td data-label="Removed">${tsDate(m.updatedAt)}</td>
      <td class="num" data-label="Actions"><span class="actions"><button class="btn ghost" data-restore="${m.uid}">Restore access</button></span></td>
    </tr>`).join('');
}
$('userSearch').addEventListener('input', renderAdmin);
$('uRole').addEventListener('change', () => $('uBizField').classList.toggle('hidden', $('uRole').value === 'admin'));

function memberName(uid) {
  const m = members.find(x => x.uid === uid);
  return m ? (m.name || m.email) : 'this user';
}
$('usersBody').addEventListener('change', async e => {
  const uid = e.target.dataset.roleUid;
  if (!uid) return;
  const role = e.target.value;
  if (!confirm(`Make ${memberName(uid)} ${role === 'admin' ? 'an Admin (full control of all businesses and users)' : 'Staff (only the businesses you choose)'}?`)) { renderAdmin(); return; }
  try {
    const fields = { role };
    const m = members.find(x => x.uid === uid);
    if (role === 'staff' && !Array.isArray(m?.businesses)) fields.businesses = state.current ? [state.current] : [];
    await FB.updateMember(uid, fields);
    FB.track('change_role', { role });
    toast('Role updated');
  } catch (err) { writeFailed(err, 'changing the role'); renderAdmin(); }
});

let accessUid = null;
$('usersBody').addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.access) {
    accessUid = btn.dataset.access;
    const m = members.find(x => x.uid === accessUid);
    $('accessFor').textContent = `Choose the businesses ${m.name || m.email} can see and record for.`;
    $('accessList').innerHTML = bizChecks(memberBiz(m));
    $('accessDialog').showModal();
  }
  if (btn.dataset.remove) {
    const uid = btn.dataset.remove;
    if (!confirm(`Delete ${memberName(uid)}?\n\nThey will be signed out and can no longer use X-Station. You can restore them later from "Removed users".`)) return;
    try {
      await FB.updateMember(uid, { active: false });
      FB.track('remove_user');
      toast('User deleted');
    } catch (err) { writeFailed(err, 'deleting the user'); }
  }
  if (btn.dataset.reset) {
    const email = btn.dataset.reset;
    if (!confirm(`Send a password reset link to ${email}?`)) return;
    try {
      await FB.resetPassword(email);
      toast(`Reset link sent to ${email}`);
    } catch (err) { alert(authMessage(err)); }
  }
});
$('accessForm').addEventListener('submit', async e => {
  e.preventDefault();
  const ids = [...$$('#accessList input:checked')].map(i => i.value);
  // keep access to archived businesses unchanged (they are not shown as checkboxes)
  const m = members.find(x => x.uid === accessUid);
  const keep = memberBiz(m).filter(id => state.businesses[id]?.archived);
  try {
    await FB.updateMember(accessUid, { businesses: [...new Set([...ids, ...keep])] });
    FB.track('change_access', { businesses: ids.length });
    $('accessDialog').close();
    toast('Access saved');
  } catch (err) { writeFailed(err, 'saving access'); }
});
$('removedBody').addEventListener('click', async e => {
  const uid = e.target.closest('button')?.dataset.restore;
  if (!uid) return;
  if (!confirm(`Restore access for ${memberName(uid)}?`)) return;
  try {
    await FB.updateMember(uid, { active: true });
    FB.track('restore_user');
    toast('Access restored');
  } catch (err) { writeFailed(err, 'restoring the user'); }
});

$('genPassword').addEventListener('click', () => {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.getRandomValues(new Uint32Array(10));
  $('uPassword').value = Array.from(buf, n => chars[n % chars.length]).join('');
});
function addUserMsg(text, ok) {
  const el = $('addUserMsg');
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
  el.classList.remove('hidden');
}
$('addUserForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!isAdmin()) return;
  const name = $('uName').value.trim(), email = $('uEmail').value.trim(), password = $('uPassword').value, role = $('uRole').value;
  const businesses = role === 'admin' ? [] : [...$$('#uBizList input:checked')].map(i => i.value);
  if (role === 'staff' && !businesses.length) { addUserMsg('Tick at least one business this person can work on.'); return; }
  $('addUserBtn').disabled = true;
  $('addUserMsg').classList.add('hidden');
  try {
    await FB.addUser({ name, email, password, role, businesses });
    FB.track('add_user', { role });
    addUserMsg(`✔ ${name} added as ${role}. Give them these login details — Email: ${email} · Password: ${password} · Link: ${location.origin}`, true);
    e.target.reset();
    $('uBizField').classList.remove('hidden');
  } catch (err) {
    addUserMsg(err.code === 'auth/email-already-in-use'
      ? 'This email already has a login. If the person was deleted before, use "Restore access" under Removed users.'
      : err.code && err.code.startsWith('auth/') ? authMessage(err) : `Could not add the user: ${err.message}`);
  } finally {
    $('addUserBtn').disabled = false;
  }
});

// =========================================================
// Login page
// =========================================================
let authMode = 'signin';   // 'signin' | 'setup' (first admin, only when no admin exists yet)
function setAuthMode(mode) {
  authMode = mode;
  const setup = mode === 'setup';
  $('setupBadge').classList.toggle('hidden', !setup);
  $('authNameRow').classList.toggle('hidden', !setup);
  $('authTitle').textContent = setup ? 'Create the admin account' : 'Sign in';
  $('authSub').textContent = setup
    ? 'No admin exists yet. This account will be the admin — it can add businesses and users.'
    : 'Use the email and password your admin gave you.';
  $('authSubmit').textContent = setup ? 'Create admin account' : 'Sign in';
  $('authPassword').autocomplete = setup ? 'new-password' : 'current-password';
  $('authReset').classList.toggle('hidden', setup);
  $('authError').classList.add('hidden');
}
function authMessage(err) {
  const map = {
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'No account with that email.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/email-already-in-use': 'An account with this email already exists.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/invalid-email': 'That email address is not valid.',
    'auth/missing-password': 'Enter a password.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
    'auth/network-request-failed': 'No internet connection. Connect and try again.',
    'auth/operation-not-allowed': 'Email/password sign-in is not enabled in Firebase yet (see SETUP.md step 1).',
    'auth/admin-restricted-operation': 'Creating accounts is switched off in Firebase (Authentication → Settings → User actions). Turn "Enable create" back on.',
    'auth/configuration-not-found': 'Authentication is not set up in Firebase yet (see SETUP.md step 1).',
  };
  return map[err.code] || err.message;
}
function showAuthError(msg, ok = false) {
  $('authError').textContent = msg;
  $('authError').classList.toggle('ok', ok);
  $('authError').classList.remove('hidden');
}
$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('authEmail').value.trim(), pw = $('authPassword').value;
  $('authSubmit').disabled = true;
  $('authError').classList.add('hidden');
  try {
    if (authMode === 'setup') {
      settingUp = true;
      await FB.createFirstAdmin(email, pw, $('authName').value.trim());
      settingUp = false;
      FB.track('setup_admin');
    } else {
      await FB.signIn(email, pw);
      FB.track('login', { method: 'password' });
    }
  } catch (err) {
    const wasSettingUp = settingUp;
    settingUp = false;
    if (wasSettingUp && FB.currentUser()) showNoAccess(null);   // account made, admin claim failed → offer retry
    else showAuthError(err.code && err.code.startsWith('auth/') ? authMessage(err) : err.message);
  } finally {
    $('authSubmit').disabled = false;
  }
});
$('authReset').addEventListener('click', async () => {
  const email = $('authEmail').value.trim();
  if (!email) { showAuthError('Type your email above first, then press "Forgot password?" again.'); return; }
  try {
    await FB.resetPassword(email);
    showAuthError(`If ${email} has an account, a password reset link has been sent. Check your inbox (and spam).`, true);
  } catch (err) {
    showAuthError(authMessage(err));
  }
});
$$('[data-signout]').forEach(b => b.addEventListener('click', () => {
  if (Object.values(state.sync).some(x => x.pending) && !confirm('Some changes have not uploaded yet. Sign out anyway? (They will be lost.)')) return;
  FB.logOut();
}));

// =========================================================
// Start
// =========================================================
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
FB.onUser(user => {
  if (user) startSession(user);
  else endSession();
});
