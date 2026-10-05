// X-Station Manager — one record per day (drinks sales, charging, expenses), stored in Firebase (see firebase.js).

import * as FB from './firebase.js';

const LEGACY_KEY = 'xstation-daily-v1';  // records saved on this device before Firebase
const PREFS_KEY = 'xstation-prefs';      // per-device choices (theme, dashboard period)

const DEFAULT_SETTINGS = { shopName: 'X-Station', currency: '₦', target: '', theme: 'system', period: 'month' };
const CLOUD_SETTINGS = ['shopName', 'currency', 'target'];   // shared by every device on the account

// =========================================================
// Helpers
// =========================================================
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dateStr(new Date());
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); };
const fmtDate = (s, o = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) =>
  parseDate(s).toLocaleDateString(undefined, o);
const monthName = (ym, o = { month: 'long', year: 'numeric' }) => parseDate(ym + '-01').toLocaleDateString(undefined, o);
const daysInMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };

function money(n) {
  const v = Number(n || 0);
  const s = Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (v < 0 ? '−' : '') + data.settings.currency + s;
}
function compact(n) {
  const v = Math.abs(n);
  const c = data.settings.currency;
  if (v >= 1e6) return c + +(n / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return c + +(n / 1e3).toFixed(1) + 'K';
  return c + n;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// one record → numbers
function calc(r) {
  const drinks = Number(r?.drinks || 0), charging = Number(r?.charging || 0), expenses = Number(r?.expenses || 0);
  const revenue = drinks + charging;
  return { drinks, charging, expenses, revenue, profit: revenue - expenses };
}
// records between two dates (inclusive), sorted
function between(start, end) {
  return Object.keys(data.days).filter(d => d >= start && d <= end).sort()
    .map(d => ({ date: d, note: data.days[d].note || '', ...calc(data.days[d]) }));
}
function totals(list) {
  const t = { drinks: 0, charging: 0, expenses: 0, revenue: 0, profit: 0, days: list.length };
  list.forEach(r => { t.drinks += r.drinks; t.charging += r.charging; t.expenses += r.expenses; t.revenue += r.revenue; t.profit += r.profit; });
  return t;
}

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: data.settings.theme, period: data.settings.period })); } catch { /* ignore */ }
}
function saveCloudSettings() {
  const s = {};
  CLOUD_SETTINGS.forEach(k => { s[k] = data.settings[k]; });
  FB.saveSettings(s).catch(err => toast('Could not save settings: ' + err.message));
  FB.track('update_settings');
}

let data = { settings: { ...DEFAULT_SETTINGS, ...readJSON(PREFS_KEY) }, days: {} };
let workDate = todayStr();

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

// =========================================================
// Routing
// =========================================================
const PAGES = ['dashboard', 'record', 'reports', 'admin', 'settings'];
function route() {
  let page = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
  if (page === 'admin' && !isAdmin()) page = 'dashboard';
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  Charts.hideTip();
  render(page);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
function go(page) { if (location.hash === '#' + page) route(); else location.hash = page; }

function render(page) {
  renderShell();
  if (page === 'dashboard') renderDashboard();
  if (page === 'record') { loadForm(); renderRecordSide(); }
  if (page === 'reports') renderReports();
  if (page === 'admin') renderAdmin();
  if (page === 'settings') renderSettings();
}

function renderShell() {
  $('shopName').textContent = data.settings.shopName;
  document.title = data.settings.shopName + ' Manager';
  const today = data.days[todayStr()];
  $('sidebarToday').innerHTML = `${fmtDate(todayStr(), { weekday: 'long', day: 'numeric', month: 'long' })}<br>` +
    (today ? `Today: <b style="color:#fff">${money(calc(today).revenue)}</b>` : 'Today not recorded yet');
}

// =========================================================
// Dashboard
// =========================================================
function periodRange(p) {
  const T = todayStr();
  const ym = T.slice(0, 7);
  const prevYm = (k) => { const d = parseDate(ym + '-01'); d.setMonth(d.getMonth() - k); return dateStr(d).slice(0, 7); };
  switch (p) {
    case '7d':  return { start: addDays(T, -6), end: T, prevStart: addDays(T, -13), prevEnd: addDays(T, -7), vs: 'prev. 7 days', unit: 'day' };
    case '30d': return { start: addDays(T, -29), end: T, prevStart: addDays(T, -59), prevEnd: addDays(T, -30), vs: 'prev. 30 days', unit: 'day' };
    case 'lastmonth': {
      const a = prevYm(1), b = prevYm(2);
      return { start: a + '-01', end: `${a}-${pad(daysInMonth(a))}`, prevStart: b + '-01', prevEnd: `${b}-${pad(daysInMonth(b))}`,
        vs: monthName(b, { month: 'long' }), unit: 'day', month: a };
    }
    case 'year': {
      const y = +T.slice(0, 4);
      return { start: `${y}-01-01`, end: T, prevStart: `${y - 1}-01-01`, prevEnd: `${y - 1}${T.slice(4)}`,
        vs: `${y - 1}`, unit: 'month', year: y };
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
  const period = data.settings.period;
  document.querySelectorAll('#periodFilter button').forEach(b => b.classList.toggle('active', b.dataset.period === period));
  const R = periodRange(period);
  const list = between(R.start, R.end);
  const prev = totals(between(R.prevStart, R.prevEnd));
  const t = totals(list);

  $('dashRange').textContent = `${fmtDate(R.start, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmtDate(R.end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  $('todayAlert').classList.toggle('hidden', !!data.days[todayStr()]);

  // KPIs
  $('kRevenue').textContent = money(t.revenue);
  $('kRevenueDelta').innerHTML = deltaHtml(t.revenue, prev.revenue, R.vs);
  $('kDrinks').textContent = money(t.drinks);
  $('kDrinksDelta').innerHTML = deltaHtml(t.drinks, prev.drinks, R.vs);
  $('kCharging').textContent = money(t.charging);
  $('kChargingDelta').innerHTML = deltaHtml(t.charging, prev.charging, R.vs);
  $('kExpenses').textContent = money(t.expenses);
  $('kExpensesDelta').innerHTML = deltaHtml(t.expenses, prev.expenses, R.vs, false);
  $('kProfit').textContent = money(t.profit);
  $('kProfitDelta').innerHTML = deltaHtml(t.profit, prev.profit, R.vs);

  const spanDays = Math.round((parseDate(R.end) - parseDate(R.start)) / 864e5) + 1;
  $('kAvg').textContent = money(t.days ? t.revenue / t.days : 0);
  $('kDays').textContent = `${t.days} of ${spanDays} days recorded`;
  const best = list.reduce((b, r) => (!b || r.revenue > b.revenue ? r : b), null);
  $('kBest').textContent = best ? money(best.revenue) : '—';
  $('kBestDate').textContent = best ? fmtDate(best.date) : 'No records yet';

  // target
  const target = Number(data.settings.target) || 0;
  const tgt = R.month ? target : R.year ? target * 12 : 0;
  $('targetBox').classList.toggle('hidden', !tgt);
  if (tgt) {
    const pct = (t.revenue / tgt) * 100;
    let text = `${money(t.revenue)} of ${money(tgt)} target`;
    if (period === 'month' && t.days) {
      const projected = (t.revenue / +R.end.slice(8)) * daysInMonth(R.month);
      text += ` · on pace for ${compact(Math.round(projected))}`;
    }
    $('targetText').textContent = text;
    $('targetPct').textContent = Math.round(pct) + '%';
    $('targetFill').style.width = Math.min(100, pct) + '%';
  }

  // trend chart
  let labels = [], titles = [], d1 = [], d2 = [];
  if (R.unit === 'month') {
    for (let m = 1; m <= +R.end.slice(5, 7); m++) {
      const ym = `${R.year}-${pad(m)}`;
      const mt = totals(list.filter(r => r.date.startsWith(ym)));
      labels.push(monthName(ym, { month: 'short' }));
      titles.push(monthName(ym));
      d1.push(mt.drinks); d2.push(mt.charging);
    }
    $('trendSub').textContent = 'Monthly drinks and charging revenue';
  } else {
    const byDate = Object.fromEntries(list.map(r => [r.date, r]));
    for (let d = R.start; d <= R.end; d = addDays(d, 1)) {
      const r = byDate[d];
      labels.push(period === '7d' ? fmtDate(d, { weekday: 'short' }) : spanDays > 31 || period === '30d' ? fmtDate(d, { day: 'numeric', month: 'short' }) : String(+d.slice(8)));
      titles.push(fmtDate(d));
      d1.push(r ? r.drinks : 0); d2.push(r ? r.charging : 0);
    }
    $('trendSub').textContent = 'Daily drinks and charging revenue';
  }
  const series = [{ name: 'Drinks', cls: 's1', values: d1 }, { name: 'Charging', cls: 's2', values: d2 }];
  Charts.stackedColumns($('trendChart'), {
    labels, titles, series, fmt: money, fmtAxis: compact,
    labelWidth: period === '30d' ? 52 : 40, emptyText: 'No records in this period', ariaLabel: 'Revenue trend',
  });
  $('trendTable').innerHTML = seriesTable(titles, series);

  // revenue mix
  const pD = t.revenue ? (t.drinks / t.revenue) * 100 : 0;
  const pC = t.revenue ? 100 - pD : 0;
  $('mixBar').innerHTML = t.revenue
    ? `<div style="width:${pD}%;background:var(--series-1)"></div><div style="width:${pC}%;background:var(--series-2)"></div>` : '';
  $('mixList').innerHTML = `
    <li><i class="key s1"></i><span class="name">Drinks</span><b>${money(t.drinks)}</b><span class="pct">${pD.toFixed(0)}%</span></li>
    <li><i class="key s2"></i><span class="name">Charging</span><b>${money(t.charging)}</b><span class="pct">${pC.toFixed(0)}%</span></li>`;
  const margin = t.revenue ? (t.profit / t.revenue) * 100 : null;
  $('marginValue').textContent = margin === null ? '—' : margin.toFixed(1) + '%';
  $('marginSub').textContent = t.revenue ? `${money(t.profit)} kept from ${money(t.revenue)} revenue after ${money(t.expenses)} expenses` : 'No revenue in this period';

  // weekday averages (Mon → Sun)
  const wd = [1, 2, 3, 4, 5, 6, 0].map(w => {
    const rs = list.filter(r => parseDate(r.date).getDay() === w);
    const label = new Date(2024, 0, 7 + w).toLocaleDateString(undefined, { weekday: 'short' }); // Jan 7 2024 = Sunday
    return { label, value: rs.length ? totals(rs).revenue / rs.length : 0, title: `${rs.length} day(s) recorded` };
  });
  Charts.hbars($('weekdayChart'), wd, money);

  // recent days
  const recent = Object.keys(data.days).sort()
    .reverse().slice(0, 5).map(d => ({ date: d, ...calc(data.days[d]) }));
  $('recentBody').innerHTML = recent.length
    ? recent.map(r => `<tr class="clickable" data-date="${r.date}">
        <td class="row-title">${fmtDate(r.date)}</td>
        <td class="num" data-label="Drinks">${money(r.drinks)}</td>
        <td class="num" data-label="Charging">${money(r.charging)}</td>
        <td class="num" data-label="Revenue"><b>${money(r.revenue)}</b></td>
        <td class="num" data-label="Expenses">${money(r.expenses)}</td>
        <td class="num ${r.profit < 0 ? 'neg' : ''}" data-label="Profit">${money(r.profit)}</td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">No days recorded yet. <a href="#record">Record your first day →</a></td></tr>`;
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
  data.settings.period = p;
  savePrefs();
  renderDashboard();
});
$('recentBody').addEventListener('click', e => {
  const row = e.target.closest('tr[data-date]');
  if (row) { workDate = row.dataset.date; go('record'); }
});
$('todayAlertBtn').addEventListener('click', () => { workDate = todayStr(); });

document.querySelectorAll('[data-table-toggle]').forEach(btn => btn.addEventListener('click', () => {
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
['fDrinks', 'fCharging', 'fExpenses', 'fNote'].forEach(id => $(id).addEventListener('input', () => { formDirty = true; }));

function loadForm() {
  formDirty = false;
  const r = data.days[workDate];
  $('workDate').value = workDate;
  $('fDrinks').value = r ? r.drinks : '';
  $('fCharging').value = r ? r.charging : '';
  $('fExpenses').value = r && r.expenses ? r.expenses : '';
  $('fNote').value = r ? r.note || '' : '';
  $('saveBtn').textContent = r ? 'Update day' : 'Save day';
  $('deleteBtn').classList.toggle('hidden', !r || !isAdmin()); // only admins can delete days
  $('formStatus').textContent = r
    ? `✔ ${fmtDate(workDate)} is recorded${r.updatedBy ? ` (last saved by ${r.updatedBy})` : ''}. Change the numbers and press Update.`
    : `No record yet for ${fmtDate(workDate)}.`;
  updateFormTotals();
}
function formValues() {
  return { drinks: Number($('fDrinks').value) || 0, charging: Number($('fCharging').value) || 0, expenses: Number($('fExpenses').value) || 0 };
}
function updateFormTotals() {
  const c = calc(formValues());
  $('fRevenue').textContent = money(c.revenue);
  $('fExp').textContent = money(c.expenses);
  $('fProfit').textContent = money(c.profit);
  renderCompare(c.revenue);
}
['fDrinks', 'fCharging', 'fExpenses'].forEach(id => $(id).addEventListener('input', updateFormTotals));

function renderCompare(rev) {
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
  const y = addDays(workDate, -1), w = addDays(workDate, -7);
  const ym = workDate.slice(0, 7);
  const typed = rev > 0 || !!data.days[workDate];
  const others = between(ym + '-01', `${ym}-${pad(daysInMonth(ym))}`).filter(r => r.date !== workDate);
  const avg = others.length ? totals(others).revenue / others.length : null;
  $('compareBox').innerHTML =
    `<div><span class="c-label"><b>This day</b><small>${fmtDate(workDate)}</small></span><span class="c-val">${money(rev)}</span></div>` +
    row('Yesterday', fmtDate(y, { weekday: 'short', day: 'numeric', month: 'short' }), data.days[y] ? calc(data.days[y]).revenue : null) +
    row('Same day last week', fmtDate(w, { weekday: 'short', day: 'numeric', month: 'short' }), data.days[w] ? calc(data.days[w]).revenue : null) +
    row('Month average', `${others.length} other day(s) in ${monthName(ym, { month: 'long' })}`, avg);
}

function renderRecordSide() {
  const ym = workDate.slice(0, 7);
  const list = between(ym + '-01', `${ym}-${pad(daysInMonth(ym))}`);
  $('monthListTitle').textContent = monthName(ym);
  $('monthListTotal').textContent = money(totals(list).revenue);
  $('monthListBody').innerHTML = list.length
    ? list.slice().reverse().map(r => `<tr class="clickable ${r.date === workDate ? 'selected' : ''}" data-date="${r.date}">
        <td class="row-title">${fmtDate(r.date)}</td>
        <td class="num" data-label="Drinks">${money(r.drinks)}</td>
        <td class="num" data-label="Charging">${money(r.charging)}</td>
        <td class="num" data-label="Revenue"><b>${money(r.revenue)}</b></td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">No days recorded this month</td></tr>';
}
$('monthListBody').addEventListener('click', e => {
  const row = e.target.closest('tr[data-date]');
  if (row) { setDate(row.dataset.date); $('dayForm').scrollIntoView({ behavior: 'smooth' }); }
});

$('dayForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = formValues();
  if (!v.drinks && !v.charging && !confirm('Drinks and charging are both 0. Save anyway?')) return;
  const existed = !!data.days[workDate];
  const date = workDate;
  data.days[date] = { ...v, note: $('fNote').value.trim() };
  // Firestore applies the write locally at once (works offline) and uploads in the background.
  FB.saveDay(date, data.days[date]).catch(err => writeFailed(err, `saving ${fmtDate(date)}`));
  FB.track('record_day', { revenue: v.drinks + v.charging, update: existed });
  loadForm();
  renderRecordSide();
  renderShell();
  toast(`${existed ? 'Updated' : 'Saved'} ${fmtDate(date, { day: 'numeric', month: 'short' })} — revenue ${money(v.drinks + v.charging)}${navigator.onLine ? '' : ' (will sync when online)'}`);
});
$('deleteBtn').addEventListener('click', () => {
  if (!confirm(`Delete the record for ${fmtDate(workDate)}?`)) return;
  const date = workDate;
  delete data.days[date];
  FB.removeDay(date).catch(err => writeFailed(err, `deleting ${fmtDate(date)}`));
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
  if (!$('reportMonth').value) $('reportMonth').value = todayStr().slice(0, 7);
  if (!$('reportYear').value) $('reportYear').value = todayStr().slice(0, 4);
  const ym = $('reportMonth').value;
  const list = between(ym + '-01', `${ym}-${pad(daysInMonth(ym))}`);
  const t = totals(list);

  $('reportTitle').textContent = 'Monthly statement — ' + monthName(ym);
  $('mDrinks').textContent = money(t.drinks);
  $('mCharging').textContent = money(t.charging);
  $('mRevenue').textContent = money(t.revenue);
  $('mAvg').textContent = t.days ? `${t.days} days · avg ${money(t.revenue / t.days)}/day` : 'No records';
  $('mProfit').textContent = money(t.profit);
  $('mExp').textContent = `after ${money(t.expenses)} expenses`;

  $('reportBody').innerHTML = list.length
    ? list.map(r => `<tr class="clickable" data-date="${r.date}">
        <td class="row-title">${fmtDate(r.date)}</td>
        <td class="num" data-label="Drinks">${money(r.drinks)}</td>
        <td class="num" data-label="Charging">${money(r.charging)}</td>
        <td class="num" data-label="Revenue"><b>${money(r.revenue)}</b></td>
        <td class="num" data-label="Expenses">${money(r.expenses)}</td>
        <td class="num ${r.profit < 0 ? 'neg' : ''}" data-label="Profit">${money(r.profit)}</td>
        <td class="note ${r.note ? '' : 'empty-cell'}" data-label="Note">${esc(r.note)}</td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">No records this month</td></tr>';
  $('reportFoot').innerHTML = list.length
    ? `<tr><td class="row-title">Month total</td>
        <td class="num" data-label="Drinks">${money(t.drinks)}</td><td class="num" data-label="Charging">${money(t.charging)}</td>
        <td class="num" data-label="Revenue">${money(t.revenue)}</td><td class="num" data-label="Expenses">${money(t.expenses)}</td>
        <td class="num" data-label="Profit">${money(t.profit)}</td><td class="empty-cell"></td></tr>` : '';

  // year chart
  const year = $('reportYear').value;
  const titles = [], labels = [], d1 = [], d2 = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${pad(m)}`;
    const mt = totals(between(key + '-01', key + '-31'));
    labels.push(monthName(key, { month: 'short' }));
    titles.push(monthName(key));
    d1.push(mt.drinks); d2.push(mt.charging);
  }
  const series = [{ name: 'Drinks', cls: 's1', values: d1 }, { name: 'Charging', cls: 's2', values: d2 }];
  Charts.stackedColumns($('yearChart'), {
    labels, titles, series, fmt: money, fmtAxis: compact, labelWidth: 34,
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
  const ym = $('reportMonth').value || todayStr().slice(0, 7);
  const list = between(ym + '-01', `${ym}-${pad(daysInMonth(ym))}`);
  const t = totals(list);
  const rows = [['Date', 'Drinks', 'Charging', 'Revenue', 'Expenses', 'Profit', 'Note']];
  list.forEach(r => rows.push([r.date, r.drinks, r.charging, r.revenue, r.expenses, r.profit, r.note]));
  rows.push(['TOTAL', t.drinks, t.charging, t.revenue, t.expenses, t.profit, '']);
  download(`${data.settings.shopName}-${ym}.csv`, rows.map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv');
});

// =========================================================
// Settings
// =========================================================
function applyTheme() {
  const th = data.settings.theme;
  if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th;
  else delete document.documentElement.dataset.theme;
}
function renderSettings() {
  $('setShopName').value = data.settings.shopName;
  $('setCurrency').value = data.settings.currency;
  $('setTarget').value = data.settings.target;
  $('setTheme').value = data.settings.theme;
  document.querySelectorAll('[data-admin-edit]').forEach(el => { el.disabled = !isAdmin(); });
}
$('setShopName').addEventListener('change', e => { data.settings.shopName = e.target.value.trim() || 'X-Station'; saveCloudSettings(); renderShell(); toast('Saved'); });
$('setCurrency').addEventListener('change', e => { data.settings.currency = e.target.value || '₦'; saveCloudSettings(); renderShell(); toast('Saved'); });
$('setTarget').addEventListener('change', e => { data.settings.target = e.target.value === '' ? '' : Number(e.target.value); saveCloudSettings(); toast('Saved'); });
$('setTheme').addEventListener('change', e => { data.settings.theme = e.target.value; savePrefs(); applyTheme(); });

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('backupBtn').addEventListener('click', () => {
  const days = {};
  Object.keys(data.days).sort().forEach(d => { const { updatedBy, ...r } = data.days[d]; days[d] = r; });
  const settings = {};
  CLOUD_SETTINGS.forEach(k => { settings[k] = data.settings[k]; });
  download(`${data.settings.shopName}-backup-${todayStr()}.json`, JSON.stringify({ settings, days }, null, 2), 'application/json');
  FB.track('download_backup');
});
$('restoreFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file || !isAdmin()) return;
  let imported;
  try {
    imported = JSON.parse(await file.text());
    if (!imported.days || typeof imported.days !== 'object') throw new Error('bad file');
  } catch {
    alert('That file is not a valid backup.');
    e.target.value = '';
    return;
  }
  e.target.value = '';
  const n = Object.keys(imported.days).length;
  if (!confirm(`Replace ALL shop records with the ${n} day(s) in this backup?`)) return;
  toast('Restoring backup…');
  try {
    await FB.uploadDays(imported.days, true, data.days);
    if (imported.settings) {
      CLOUD_SETTINGS.forEach(k => { if (k in imported.settings) data.settings[k] = imported.settings[k]; });
      saveCloudSettings();
    }
    FB.track('restore_backup', { days: n });
    toast(`Backup restored — ${n} day(s)`);
  } catch (err) {
    writeFailed(err, 'restoring the backup');
  }
});

// =========================================================
// Cloud: errors, sync status, sign in
// =========================================================
function writeFailed(err, what) {
  console.error(err);
  const msg = err.code === 'permission-denied'
    ? 'Permission denied — your account is not allowed to do this (or the Firestore rules are not published, see SETUP.md).'
    : err.message;
  alert(`Problem ${what}: ${msg}`);
}

let syncState = { fromCache: true, pending: false };
function renderSync() {
  const online = navigator.onLine;
  const [cls, text] = !online ? ['offline', 'Offline — changes saved on this device']
    : syncState.pending ? ['pending', 'Syncing…']
    : syncState.fromCache ? ['pending', 'Connecting…']
    : ['ok', 'All changes synced'];
  document.querySelectorAll('[data-sync]').forEach(el => {
    el.className = 'sync ' + cls;
    el.querySelector('span').textContent = text;
  });
}
window.addEventListener('online', renderSync);
window.addEventListener('offline', renderSync);

function currentPage() {
  return PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
}
// Re-draw after live data arrives, without wiping what someone is typing.
function refreshFromCloud() {
  const page = currentPage();
  renderShell();
  if (page === 'record') {
    if (!formDirty) loadForm(); else updateFormTotals();
    renderRecordSide();
  } else {
    render(page);
  }
}

// Offer to move records that were saved on this device before Firebase was added.
async function migrateLegacy() {
  const legacy = readJSON(LEGACY_KEY);
  if (!legacy || !legacy.days) return;
  const missing = {};
  Object.entries(legacy.days).forEach(([d, r]) => { if (!data.days[d]) missing[d] = r; });
  const n = Object.keys(missing).length;
  if (!n) { localStorage.removeItem(LEGACY_KEY); return; }
  if (!confirm(`Found ${n} day(s) saved on this device from before. Upload them to your cloud account?`)) return;
  try {
    await FB.uploadDays(missing);
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
let me = null;              // this user's member record { email, name, role, active }
let members = [];           // all users (admins only)
let meUnsub = null, membersUnsub = null, dataUnsubs = [];
let settingUp = false;      // true while the first admin account is being created

const isAdmin = () => !!(me && me.active && me.role === 'admin');

function showScreen(name) {
  document.body.classList.remove('booting');
  $('authScreen').classList.toggle('hidden', name !== 'auth');
  $('noAccessScreen').classList.toggle('hidden', name !== 'noaccess');
  $('app').classList.toggle('hidden', name !== 'app');
}

function startSession(user) {
  document.querySelectorAll('[data-user-email]').forEach(el => { el.textContent = user.email; });
  meUnsub = FB.watchMe(m => {
    me = m;
    if (!m || !m.active) { stopData(); showNoAccess(m); return; }
    applyRole();
    if (!dataUnsubs.length) startData();
    else refreshFromCloud();
  }, err => { stopData(); showNoAccess(null, err); });
}

function startData() {
  let firstLoad = true;
  dataUnsubs.push(FB.watchSettings(s => {
    if (s) CLOUD_SETTINGS.forEach(k => { if (k in s) data.settings[k] = s[k]; });
    refreshFromCloud();
  }, err => writeFailed(err, 'loading settings')));
  dataUnsubs.push(FB.watchDays((days, meta) => {
    data.days = days;
    syncState = meta;
    renderSync();
    if (firstLoad) {
      firstLoad = false;
      showScreen('app');
      route();
      if (!meta.fromCache || !navigator.onLine) migrateLegacy();
      else setTimeout(migrateLegacy, 2500); // give the server a moment so we compare against real cloud data
    } else {
      refreshFromCloud();
    }
  }, err => {
    // e.g. database not created yet or rules not published — show the app (empty) plus the reason
    showScreen('app');
    route();
    writeFailed(err, 'loading records');
  }));
}
function stopData() {
  dataUnsubs.forEach(u => u());
  dataUnsubs = [];
  if (membersUnsub) { membersUnsub(); membersUnsub = null; }
  members = [];
  data.days = {};
  CLOUD_SETTINGS.forEach(k => { data.settings[k] = DEFAULT_SETTINGS[k]; });
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
  document.querySelectorAll('[data-user-role]').forEach(el => {
    el.textContent = me.role;
    el.className = 'role-tag ' + me.role;
  });
  document.querySelectorAll('[data-admin-edit]').forEach(el => { el.disabled = !admin; });
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
    $('noAccessText').textContent = 'Your access to this app has been removed by the admin. Contact the admin if this is a mistake.';
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
// Admin page — users
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

function renderAdmin() {
  if (!isAdmin()) return;
  const active = members.filter(m => m.active);
  const removed = members.filter(m => !m.active);
  $('aActive').textContent = active.length;
  $('aAdmins').textContent = active.filter(m => m.role === 'admin').length;
  $('aStaff').textContent = active.filter(m => m.role === 'staff').length;
  $('aRemoved').textContent = removed.length;

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
      <td data-label="Added">${tsDate(m.createdAt)}</td>
      <td class="num" data-label="Actions"><span class="actions">
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

function memberName(uid) {
  const m = members.find(x => x.uid === uid);
  return m ? (m.name || m.email) : 'this user';
}
$('usersBody').addEventListener('change', async e => {
  const uid = e.target.dataset.roleUid;
  if (!uid) return;
  const role = e.target.value;
  if (!confirm(`Make ${memberName(uid)} ${role === 'admin' ? 'an Admin (full control, including users)' : 'Staff'}?`)) { renderAdmin(); return; }
  try {
    await FB.updateMember(uid, { role });
    FB.track('change_role', { role });
    toast('Role updated');
  } catch (err) { writeFailed(err, 'changing the role'); renderAdmin(); }
});
$('usersBody').addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.remove) {
    const uid = btn.dataset.remove;
    if (!confirm(`Delete ${memberName(uid)}?\n\nThey will be signed out and can no longer use the app. You can restore them later from "Removed users".`)) return;
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
  $('addUserBtn').disabled = true;
  $('addUserMsg').classList.add('hidden');
  try {
    await FB.addUser({ name, email, password, role });
    FB.track('add_user', { role });
    addUserMsg(`✔ ${name} added as ${role}. Give them these login details — Email: ${email} · Password: ${password}`, true);
    e.target.reset();
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
    ? 'No admin exists yet. This account will be the admin — it can add and remove other users.'
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
document.querySelectorAll('[data-signout]').forEach(b => b.addEventListener('click', () => {
  if (syncState.pending && !confirm('Some changes have not uploaded yet. Sign out anyway? (They will be lost.)')) return;
  FB.logOut();
}));

// =========================================================
// Start
// =========================================================
applyTheme();
FB.onUser(user => {
  if (user) startSession(user);
  else endSession();
});
