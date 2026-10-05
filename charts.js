// Small SVG chart helpers (no libraries). Colors come from CSS classes .s1/.s2 → --series-1/--series-2.

const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const tooltip = () => document.getElementById('tooltip');

  function el(tag, attrs = {}, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  // Clean axis ticks: 0, 5K, 10K ...
  function niceTicks(max, count = 4) {
    if (max <= 0) return [0, 1];
    const raw = max / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
    const ticks = [];
    for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }

  // Rect with 4px rounded top corners, square at the baseline.
  function topRounded(x, y, w, h, r = 4) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  // ---------- tooltip ----------
  function showTip(html, x, y) {
    const t = tooltip();
    t.innerHTML = html;
    t.classList.add('show');
    const r = t.getBoundingClientRect();
    let left = x + 14, top = y - r.height - 10;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (left < 8) left = 8;
    if (top < 8) top = y + 16;
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }
  function hideTip() { tooltip().classList.remove('show'); }
  document.addEventListener('scroll', hideTip, { passive: true });

  function tipHtml(title, series, i, fmt) {
    let total = 0;
    const rows = series.map(s => {
      total += s.values[i] || 0;
      return `<div class="tt-row"><span><i class="key ${s.cls}"></i>${s.name}</span><b>${fmt(s.values[i] || 0)}</b></div>`;
    }).reverse().join('');
    return `<div class="tt-title">${title}</div>${rows}
      <div class="tt-row tt-total"><span>Total</span><b>${fmt(total)}</b></div>`;
  }

  // ---------- stacked column chart ----------
  // opts: { labels[], titles[], series:[{name, cls, values[]}], fmt, fmtAxis, emptyText }
  function stackedColumns(container, opts) {
    container._opts = opts;
    if (!container._ro) {
      let lastW = 0;
      container._ro = new ResizeObserver(() => {
        const w = container.clientWidth;
        if (w && Math.abs(w - lastW) > 1) { lastW = w; draw(container); }
      });
      container._ro.observe(container);
    }
    draw(container);
  }

  function draw(container) {
    const o = container._opts;
    const W = container.clientWidth;
    if (!W) return;
    const n = o.labels.length;
    const plotH = W < 520 ? 190 : 240;
    const axisH = 26;
    const totals = o.labels.map((_, i) => o.series.reduce((t, s) => t + (s.values[i] || 0), 0));
    const max = Math.max(0, ...totals);
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1];
    const tickLabels = ticks.map(o.fmtAxis);
    const padL = Math.max(...tickLabels.map(t => t.length)) * 6.6 + 10;
    const padT = 8, padR = 4;
    const plotW = W - padL - padR;
    const H = padT + plotH + axisH;
    const y = v => padT + plotH - (v / top) * plotH;

    container.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': o.ariaLabel || 'Chart' }, container);

    // gridlines + y ticks
    const g = el('g', { class: 'grid' }, svg);
    ticks.forEach((t, k) => {
      const yy = Math.round(y(t)) + 0.5;
      if (k > 0) el('line', { x1: padL, x2: W - padR, y1: yy, y2: yy }, g);
      const tx = el('text', { x: padL - 8, y: yy + 4, 'text-anchor': 'end' }, svg);
      tx.textContent = tickLabels[k];
    });

    if (!n || max === 0) {
      el('line', { class: 'baseline', x1: padL, x2: W - padR, y1: padT + plotH + 0.5, y2: padT + plotH + 0.5 }, svg);
      const m = el('text', { class: 'empty-msg', x: padL + plotW / 2, y: padT + plotH / 2, 'text-anchor': 'middle' }, svg);
      m.textContent = o.emptyText || 'No data for this period';
      return;
    }

    const band = plotW / n;
    const barW = Math.max(2, Math.min(24, band * 0.62));
    const GAP = 2;

    // bars
    const bars = el('g', {}, svg);
    for (let i = 0; i < n; i++) {
      const x = padL + i * band + (band - barW) / 2;
      const nonZero = o.series.map((s, k) => (s.values[i] > 0 ? k : -1)).filter(k => k >= 0);
      const topK = nonZero[nonZero.length - 1];
      let cum = 0;
      o.series.forEach((s, k) => {
        const v = s.values[i] || 0;
        if (v <= 0) return;
        const y0 = y(cum), y1 = y(cum + v);
        cum += v;
        let h = y0 - y1;
        let yTop = y1;
        if (k !== topK && h > GAP + 1) { yTop += GAP; h -= GAP; } // 2px surface gap between segments
        if (k === topK) el('path', { class: s.cls, d: topRounded(x, yTop, barW, h) }, bars);
        else el('rect', { class: s.cls, x, y: yTop, width: barW, height: h }, bars);
      });
    }

    // baseline
    el('line', { class: 'baseline', x1: padL, x2: W - padR, y1: padT + plotH + 0.5, y2: padT + plotH + 0.5 }, svg);

    // x labels (thinned so they never collide)
    const maxLabels = Math.max(1, Math.floor(plotW / (o.labelWidth || 40)));
    const step = Math.ceil(n / maxLabels);
    for (let i = 0; i < n; i += step) {
      const t = el('text', { x: padL + i * band + band / 2, y: padT + plotH + 18, 'text-anchor': 'middle' }, svg);
      t.textContent = o.labels[i];
    }

    // hover / focus bands (hit area = the whole column slot)
    const hits = el('g', {}, svg);
    for (let i = 0; i < n; i++) {
      const r = el('rect', {
        class: 'band', x: padL + i * band, y: padT, width: band, height: plotH,
        tabindex: totals[i] ? 0 : -1, 'aria-label': `${o.titles[i]}: ${o.fmt(totals[i])}`,
      }, hits);
      const html = () => tipHtml(o.titles[i], o.series, i, o.fmt);
      r.addEventListener('mousemove', e => showTip(html(), e.clientX, e.clientY));
      r.addEventListener('mouseleave', hideTip);
      r.addEventListener('click', e => showTip(html(), e.clientX, e.clientY));
      r.addEventListener('focus', () => {
        const b = r.getBoundingClientRect();
        showTip(html(), b.left + b.width / 2, b.top + 40);
      });
      r.addEventListener('blur', hideTip);
    }
  }

  // ---------- horizontal bars (single series) ----------
  // items: [{label, value, title}]
  function hbars(container, items, fmt) {
    const max = Math.max(0, ...items.map(i => i.value));
    const best = items.findIndex(i => i.value === max && max > 0);
    container.innerHTML = items.map((it, k) => `
      <div class="hbar ${k === best ? 'top' : ''}" title="${it.title || ''}">
        <span class="day">${it.label}</span>
        <span class="track">
          ${it.value ? `<span class="bar" style="width:${(it.value / max) * 78}%"></span>` : ''}
          <span class="val">${it.value ? fmt(it.value) : '—'}</span>
        </span>
      </div>`).join('');
  }

  return { stackedColumns, hbars, hideTip };
})();
