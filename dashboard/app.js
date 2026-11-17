// Token Launch Radar: the page.
//
// Renders window.RADAR_DATA, the script main.ts writes beside this page from the same board the
// gate checks, as a sortable, filterable board with a detail view for every protocol. No
// framework, no network: everything the page shows was computed by the entry's model, and the
// farm plan a reader opens here is the very text handed in with the board.
'use strict';

const D = window.RADAR_DATA;
const ROWS = D.rows;
const BY_SLUG = new Map(ROWS.map((r) => [r.slug, r]));
const view = document.getElementById('view');

/** Escape a data string for HTML text. */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Compact dollars for table cells: $2.75B, $217.5M, $9.8K. */
function money(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n}`;
}

/** Grouped dollars for prose: $35,800,000. */
function moneyFull(n) {
  return `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** Signed grouped dollars: -$197, never $-197. */
function moneySigned(n) {
  return n < 0 ? `-${moneyFull(-n)}` : moneyFull(n);
}

/** Signed percent, or a dash when the snapshot does not report one. */
function pct(v) {
  if (v === null || v === undefined) return '<span class="flat">-</span>';
  const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat';
  return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
}

/** A break-even fraction as a percent, capped for display. */
function beText(frac) {
  return frac >= 9.99 ? '>999%' : `${Math.round(frac * 100)}%`;
}

/** Age in days as a short human span. */
function ageText(days) {
  if (days >= 365) return `${(days / 365).toFixed(1)} yrs`;
  return `${days} days`;
}

/** The verdict as a coloured chip. */
function chip(verdict) {
  const cls = verdict === 'Worth farming' ? 'worth' : verdict === 'Marginal' ? 'marginal' : 'skip';
  return `<span class="chip ${cls}">${verdict}</span>`;
}

// ---------------------------------------------------------------------------
// The masthead stats and the model section: the fit, its plot, its proofs.
// ---------------------------------------------------------------------------

/** The fit as a scatter: every comp at its TVL, its market cap against the curve's price. */
function scatterSVG() {
  const comps = D.comps;
  const W = 560, H = 232, PL = 44, PR = 8, PT = 10, PB = 26;
  const xs = comps.map((c) => Math.log10(c.tvl_usd));
  const ys = comps.map((c) => Math.log10(c.mcap_usd));
  const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs));
  const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  const px = (v) => (PL + ((v - x0) / (x1 - x0)) * (W - PL - PR)).toFixed(1);
  const py = (v) => (PT + (1 - (v - y0) / (y1 - y0)) * (H - PT - PB)).toFixed(1);
  const [a, b, , d] = D.model.beta;
  // The size line at zero growth and one year of age; each ring carries its comp's own fit.
  const base = a + d * Math.log10(365);
  const line = (lx) => base + b * lx;
  const band = Math.log10(D.model.band_multiple);
  let s = `<svg class="scatter" viewBox="0 0 ${W} ${H}" role="img" aria-label="Market cap against TVL for the traded comps, with the fitted curve">`;
  for (let gx = x0; gx <= x1; gx++) s += `<line x1="${px(gx)}" y1="${PT}" x2="${px(gx)}" y2="${H - PB}" class="grid"/><text x="${px(gx)}" y="${H - 8}" class="ax">${money(Math.pow(10, gx))}</text>`;
  for (let gy = y0; gy <= y1; gy++) s += `<line x1="${PL}" y1="${py(gy)}" x2="${W - PR}" y2="${py(gy)}" class="grid"/><text x="${PL - 5}" y="${py(gy)}" class="ay">${money(Math.pow(10, gy))}</text>`;
  s += `<polygon class="bandpoly" points="${px(x0)},${py(line(x0) + band)} ${px(x1)},${py(line(x1) + band)} ${px(x1)},${py(line(x1) - band)} ${px(x0)},${py(line(x0) - band)}"/>`;
  s += `<line x1="${px(x0)}" y1="${py(line(x0))}" x2="${px(x1)}" y2="${py(line(x1))}" class="curve"/>`;
  for (const cp of comps) {
    s += `<circle cx="${px(Math.log10(cp.tvl_usd))}" cy="${py(Math.log10(cp.curve_usd))}" r="2.4" class="cfit"/>`;
    s += `<circle cx="${px(Math.log10(cp.tvl_usd))}" cy="${py(Math.log10(cp.mcap_usd))}" r="2.4" class="cdot"/>`;
  }
  return s + '</svg>';
}

function renderChrome() {
  const wl = ROWS.filter((r) => r.watchlist).length;
  document.getElementById('mast-stats').innerHTML = [
    [String(ROWS.length), 'pre-token ranked'],
    [`${wl}/${D.watchlist_size}`, 'watchlist covered'],
    [String(D.audited_size), 'pre-token audited'],
    [String(D.live_size), 'already trading'],
  ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');

  const m = D.model;
  const [a, b, c, d] = m.beta;
  const eq = `log10(value) = ${a.toFixed(2)} + ${b.toFixed(2)}*log10(TVL) ${c >= 0 ? '+' : '-'} ${Math.abs(c).toFixed(2)}*growth ${d >= 0 ? '+' : '-'} ${Math.abs(d).toFixed(2)}*log10(age)`;
  const wf = m.walk_forward;
  document.getElementById('model-bar').innerHTML = `
    <h2>The value model, fitted not asserted</h2>
    <div class="model-cols">
      <div class="model-main">
        <p class="eq">${eq}</p>
        <p>The line is fitted by weighted least squares on the protocols whose token already trades, cleaned to one row per token family at $10M of TVL or more, with the comps it cannot explain dropped and the line refitted. Every protocol that records no token is priced by that same line: size curve, growth carry, seasoning. No protocol's name is an input anywhere.</p>
        <div class="kpis">
          <span class="kpi"><b>${m.comps_used}</b>comps fitted (of ${m.comps_considered} trading)</span>
          <span class="kpi"><b>${m.r_squared.toFixed(2)}</b>R-squared</span>
          <span class="kpi"><b>x${m.loo_error_multiple.toFixed(2)}</b>median blind miss</span>
          <span class="kpi"><b>x${wf.median_x.toFixed(2)}</b>walk-forward miss</span>
          <span class="kpi"><b>${m.refits}</b>refits per rank range</span>
          <span class="kpi"><b>${D.as_of}</b>snapshot date</span>
        </div>
        ${scatterSVG()}
        <p class="figcap">Each traded comp: a dot at its market cap, a ring at the curve's price for it. The shaded band is the 75th-percentile blind miss, the width every row's wide band carries.</p>
      </div>
      <div class="model-side">
        <h3>Out of sample, four ways</h3>
        <table class="ablation">
          <thead><tr><th>Model</th><th>Blind miss</th><th>Within 3x</th></tr></thead>
          <tbody>${m.ablation.map((r) => `<tr><td>${esc(r.label)}</td><td class="n">x${r.loo_median_x.toFixed(2)}</td><td class="n">${Math.round(r.within_3x * 100)}%</td></tr>`).join('')}</tbody>
        </table>
        <p class="wf">Walk-forward: fitted on the ${wf.train} older comps by listing date, the line prices the ${wf.test} newer ones it never saw at a x${wf.median_x.toFixed(2)} median miss, ${Math.round(wf.within_3x * 100)}% within 3x. And ${m.refits} seeded refits of the comps reprice the whole board each time: the rank range on every row is its P10-P90 across those refits, so a rank the data holds loosely says so.</p>
        <details class="assumptions"><summary>Every stated assumption behind the values and the verdicts</summary>
        <ol>${D.assumptions.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// The board: controls, a sortable table, and the live set kept apart below.
// ---------------------------------------------------------------------------

const VERDICTS = ['Worth farming', 'Marginal', 'Skip'];
const state = { q: '', cat: '', verdict: '', wl: false, sort: 'rank', dir: 1 };
const SORTS = {
  rank: (r) => r.rank,
  name: (r) => r.name.toLowerCase(),
  tvl: (r) => r.tvl_usd,
  chg: (r) => (r.change_7d === null ? -Infinity : r.change_7d),
  age: (r) => r.age_days,
  implied: (r) => r.implied_value_usd,
  be: (r) => r.breakeven_ref,
  net: (r) => r.net_ref_usd,
};

function filteredRows() {
  const q = state.q.trim().toLowerCase();
  let list = ROWS.filter((r) =>
    (state.cat === '' || r.category === state.cat) &&
    (state.verdict === '' || r.verdict === state.verdict) &&
    (!state.wl || r.watchlist) &&
    (q === '' || r.name.toLowerCase().includes(q) || r.slug.includes(q)));
  const key = SORTS[state.sort];
  list = [...list].sort((x, y) => {
    const a = key(x), b = key(y);
    return (a < b ? -1 : a > b ? 1 : 0) * state.dir;
  });
  return list;
}

function categories() {
  return [...new Set(ROWS.map((r) => r.category).filter((c) => c !== null))].sort();
}

function controlsHTML() {
  const cats = categories().map((c) => `<option value="${esc(c)}"${state.cat === c ? ' selected' : ''}>${esc(c)}</option>`).join('');
  const vers = VERDICTS.map((v) => `<option value="${v}"${state.verdict === v ? ' selected' : ''}>${v}</option>`).join('');
  return `<div class="controls">
    <input type="search" id="q" placeholder="Search protocols..." value="${esc(state.q)}" aria-label="Search protocols">
    <select id="cat" aria-label="Filter by category"><option value="">All categories</option>${cats}</select>
    <select id="verdict" aria-label="Filter by verdict"><option value="">All verdicts</option>${vers}</select>
    <label class="check"><input type="checkbox" id="wl"${state.wl ? ' checked' : ''}> Watchlist only</label>
    <span class="count" id="count"></span>
  </div>`;
}

function headHTML() {
  const cols = [
    ['rank', '#', ''], ['name', 'Protocol', ''], ['tvl', 'TVL', 'n'], ['chg', '7d', 'n'],
    ['age', 'Tracked', 'n'], ['implied', 'Implied value (P25-P75)', 'n'], ['be', 'Break-even', 'n'],
    ['net', 'Net if launch', 'n'], ['verdict', 'Verdict', ''],
  ];
  return `<thead><tr>${cols.map(([key, label, cls]) =>
    `<th class="${cls}" data-sort="${key}">${label}${state.sort === key ? ` <span class="arrow">${state.dir === 1 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead>`;
}

/** A row's P25-P75 range as a small bar inside its wide band, on a log scale. */
function rangeBar(r) {
  const lo = Math.log10(r.implied_low_usd), hi = Math.log10(r.implied_high_usd);
  const span = Math.max(0.01, hi - lo);
  const l = ((Math.log10(r.band25_low_usd) - lo) / span) * 100;
  const w = Math.max(4, ((Math.log10(r.band25_high_usd) - Math.log10(r.band25_low_usd)) / span) * 100);
  const mid = ((Math.log10(r.implied_value_usd) - lo) / span) * 100;
  return `<span class="rbar"><span class="rseg" style="left:${l.toFixed(1)}%;width:${w.toFixed(1)}%"></span><span class="rmark" style="left:${mid.toFixed(1)}%"></span></span>`;
}

function rowHTML(r) {
  return `<tr data-slug="${esc(r.slug)}">
    <td class="n">${r.rank}</td>
    <td><span class="proto-name">${esc(r.name)}</span>${r.watchlist ? '<span class="wl">watchlist</span>' : ''}<span class="proto-cat">${esc(r.category ?? 'Uncategorised')} · ${esc(r.chains.slice(0, 3).join(', '))}</span></td>
    <td class="n">${money(r.tvl_usd)}</td>
    <td class="n">${pct(r.change_7d)}</td>
    <td class="n">${ageText(r.age_days)}</td>
    <td class="n">${money(r.implied_value_usd)}${rangeBar(r)}<span class="band">${money(r.band25_low_usd)} - ${money(r.band25_high_usd)}</span></td>
    <td class="n">${beText(r.breakeven_ref)}</td>
    <td class="n"><span class="net ${r.net_ref_usd >= 0 ? 'pos' : 'neg'}">${moneySigned(r.net_ref_usd)}</span><span class="band">${moneySigned(r.net_per_hour_usd)}/h</span></td>
    <td>${chip(r.verdict)}</td>
  </tr>`;
}

function liveHTML() {
  const top = D.live.slice(0, 24);
  return `<section class="live">
    <h2>Already trading: set aside, never ranked</h2>
    <p>These ${D.live_size} protocols record a token that already trades. They are the model's teachers, not its subjects: the board above ranks only protocols whose record carries no token. The largest of them:</p>
    <div class="strip">${top.map((t) => `<span class="tok"><b>${esc(t.name)}</b> <span class="sym">${esc(t.symbol)}</span> · mcap ${money(t.mcap_usd)}</span>`).join('')}</div>
  </section>`;
}

function renderBoard() {
  document.getElementById('model-bar').style.display = '';
  view.innerHTML = `${controlsHTML()}
    <table class="board">${headHTML()}<tbody id="tbody"></tbody></table>
    ${liveHTML()}`;
  wireControls();
  refreshTable();
}

function refreshTable() {
  const list = filteredRows();
  const tbody = document.getElementById('tbody');
  if (tbody) tbody.innerHTML = list.length ? list.map(rowHTML).join('') : `<tr><td colspan="9" class="empty">No protocol matches that filter. Loosen it and the radar sweeps again.</td></tr>`;
  const count = document.getElementById('count');
  if (count) count.textContent = `${list.length} of ${ROWS.length} rows`;
}

function wireControls() {
  document.getElementById('q').addEventListener('input', (e) => { state.q = e.target.value; refreshTable(); });
  document.getElementById('cat').addEventListener('change', (e) => { state.cat = e.target.value; refreshTable(); });
  document.getElementById('verdict').addEventListener('change', (e) => { state.verdict = e.target.value; refreshTable(); });
  document.getElementById('wl').addEventListener('change', (e) => { state.wl = e.target.checked; refreshTable(); });
  view.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const key = th.getAttribute('data-sort');
    if (state.sort === key) state.dir = -state.dir;
    else { state.sort = key; state.dir = key === 'name' || key === 'be' ? 1 : -1; if (key === 'rank') state.dir = 1; }
    renderBoard();
  }));
  document.getElementById('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-slug]');
    if (tr) location.hash = `#/p/${tr.getAttribute('data-slug')}`;
  });
}

// ---------------------------------------------------------------------------
// The detail view: one protocol, its evidence, and its whole farm plan.
// ---------------------------------------------------------------------------

function bandHTML(r) {
  const lo = Math.log10(r.implied_low_usd);
  const hi = Math.log10(r.implied_high_usd);
  const span = hi - lo;
  const d0 = lo - span * 0.15;
  const d1 = hi + span * 0.15;
  const pos = (v) => (((Math.log10(v) - d0) / (d1 - d0)) * 100).toFixed(2);
  return `<div class="bandbar" aria-label="Value band">
    <div class="track">
      <div class="range wide" style="left:${pos(r.implied_low_usd)}%;width:${(pos(r.implied_high_usd) - pos(r.implied_low_usd)).toFixed(2)}%"></div>
      <div class="range core" style="left:${pos(r.band25_low_usd)}%;width:${(pos(r.band25_high_usd) - pos(r.band25_low_usd)).toFixed(2)}%"></div>
      <div class="mark" style="left:${pos(r.implied_value_usd)}%"></div>
    </div>
    <div class="labels"><span>wide low ${moneyFull(r.implied_low_usd)}</span><span>P25-P75 ${moneyFull(r.band25_low_usd)} - ${moneyFull(r.band25_high_usd)}</span><span>fitted ${moneyFull(r.implied_value_usd)}</span><span>wide high ${moneyFull(r.implied_high_usd)}</span></div>
  </div>`;
}

/** The value, decomposed: size curve at this TVL, times growth carry, times seasoning. */
function decompositionHTML(r) {
  const [a, b, c, d] = D.model.beta;
  const growth = Math.min(60, Math.max(-50, r.change_7d ?? 0)) / 100;
  const size = Math.pow(10, a + b * Math.log10(Math.max(1, r.tvl_usd)));
  const gF = Math.pow(10, c * growth);
  const aF = Math.pow(10, d * Math.log10(Math.max(30, r.age_days)));
  return `<div class="decomp">
    <div class="dcard"><b>${money(size)}</b><span>size curve at ${money(r.tvl_usd)} TVL</span></div>
    <div class="dop">x</div>
    <div class="dcard"><b>x${gF.toFixed(3)}</b><span>growth carry, 7d ${r.change_7d === null ? 'unreported' : `${r.change_7d.toFixed(1)}%`}</span></div>
    <div class="dop">x</div>
    <div class="dcard"><b>x${aF.toFixed(3)}</b><span>seasoning, ${ageText(r.age_days)} tracked</span></div>
    <div class="dop">=</div>
    <div class="dcard hot"><b>${money(r.implied_value_usd)}</b><span>implied value</span></div>
  </div>`;
}

/** The five traded comps nearest this row: same family first, then nearest TVL. */
function compsHTML(r) {
  const lt = Math.log10(Math.max(1, r.tvl_usd));
  const near = [...D.comps].sort((x, y) => {
    const sx = x.category === r.category ? 0 : 1, sy = y.category === r.category ? 0 : 1;
    if (sx !== sy) return sx - sy;
    return Math.abs(Math.log10(x.tvl_usd) - lt) - Math.abs(Math.log10(y.tvl_usd) - lt);
  }).slice(0, 5);
  return `<table class="comps">
    <thead><tr><th>Traded comp</th><th>TVL</th><th>Market cap</th><th>Curve says</th><th>Actual / curve</th></tr></thead>
    <tbody>${near.map((cp) => `<tr><td>${esc(cp.name)}<span class="proto-cat">${esc(cp.category ?? 'Uncategorised')}</span></td><td class="n">${money(cp.tvl_usd)}</td><td class="n">${money(cp.mcap_usd)}</td><td class="n">${money(cp.curve_usd)}</td><td class="n">x${cp.ratio.toFixed(2)}</td></tr>`).join('')}</tbody>
  </table>`;
}

/** The plan at both deposit sizes, from the row's own computed economics. */
function depositHTML(r) {
  const opp = (dep) => dep * 0.05 * (r.plan_weeks / 52);
  const costS = r.gas_usd + opp(1000);
  const sliceS = r.net_small_usd + costS;
  const verdictFor = (be) => (be <= 0.1 ? 'Worth farming' : be <= 0.35 ? 'Marginal' : 'Skip');
  const row = (label, cost, slice, net, be) => `<tr><td>${label}</td><td class="n">${moneyFull(cost)}</td><td class="n">${moneyFull(slice)}</td><td class="n ${net >= 0 ? 'pos' : 'neg'}">${moneySigned(net)}</td><td class="n">${beText(be)}</td><td>${chip(verdictFor(be))}</td></tr>`;
  return `<table class="comps deposit">
    <thead><tr><th>Deposit</th><th>Costs</th><th>Slice if launch</th><th>Net if launch</th><th>Break-even</th><th>Verdict</th></tr></thead>
    <tbody>
      ${row('$1,000', costS, sliceS, r.net_small_usd, r.breakeven_small)}
      ${row('$10,000 (reference)', r.plan_cost_usd, r.slice_ref_usd, r.net_ref_usd, r.breakeven_ref)}
    </tbody>
  </table>`;
}

/** The eight steps as a timeline: when, what, cost, time. */
function stepsHTML(r) {
  const rows = r.farm_steps.map((s, i) => {
    const cut = s.indexOf(' - ');
    const head = cut > 0 ? s.slice(0, cut) : '';
    const text = cut > 0 ? s.slice(cut + 3) : s;
    const parts = head.split(' \u00b7 ');
    return `<tr><td class="n stepno">${i + 1}</td><td class="when">${esc(parts[0] ?? '')}</td><td>${esc(text)}</td><td class="n">${esc(parts[1] ?? '')}</td><td class="n">${esc(parts[2] ?? '')}</td></tr>`;
  }).join('');
  return `<table class="steps"><thead><tr><th>#</th><th>When</th><th>Step</th><th>Cost</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderDetail(r) {
  document.getElementById('model-bar').style.display = 'none';
  view.innerHTML = `
    <a class="back" href="#/">&larr; Back to the board</a>
    <div class="detail-head">
      <h2>${esc(r.name)}</h2>
      ${chip(r.verdict)}
      ${r.watchlist ? '<span class="wl">on the watchlist</span>' : ''}
    </div>
    <p class="tagline">${esc(r.category ?? 'Uncategorised')} · rank #${r.rank} of ${ROWS.length} pre-token protocols · records no token in the snapshot</p>
    <div class="detail-grid">
      <div class="stat"><b>${moneyFull(r.implied_value_usd)}</b><span>implied value, fitted</span></div>
      <div class="stat"><b>#${r.rank}</b><span>rank, P10-P90 ${r.rank_p10}-${r.rank_p90} over ${D.model.refits} refits</span></div>
      <div class="stat"><b>${money(r.tvl_usd)}</b><span>TVL</span></div>
      <div class="stat"><b>${r.change_7d === null ? '-' : `${r.change_7d > 0 ? '+' : ''}${r.change_7d.toFixed(1)}%`}</b><span>TVL change, 7d</span></div>
      <div class="stat"><b>${ageText(r.age_days)}</b><span>tracked with no token</span></div>
      <div class="stat"><b>${esc(r.chains.join(', '))}</b><span>chains</span></div>
    </div>
    <h3 class="section-h">How this value is built</h3>
    ${decompositionHTML(r)}
    ${bandHTML(r)}
    <h3 class="section-h">Its record in the snapshot</h3>
    <p class="record">tvl_usd ${moneyFull(r.tvl_usd)} · change_7d ${r.change_7d === null ? 'null (unreported)' : `${r.change_7d.toFixed(2)}%`} · days tracked ${r.age_days} · category ${esc(r.category ?? 'null')} · mcap_usd null · gecko_id null · symbol null - it records no token, which is a statement about the record, not proof that none exists.</p>
    <h3 class="section-h">Nearest traded comps</h3>
    ${compsHTML(r)}
    <section class="plan">
      <h3 class="section-h">The farm plan, costed and netted</h3>
      ${depositHTML(r)}
      <div class="summary">
        <span class="kpi"><b>${moneyFull(r.gas_usd)}</b>gas over ${r.plan_weeks} weeks</span>
        <span class="kpi"><b>${moneyFull(r.slice_ref_usd)}</b>slice if launch at $10,000</span>
        <span class="kpi"><b>${beText(r.breakeven_ref)}</b>break-even launch chance</span>
        <span class="kpi"><b>${moneySigned(r.net_per_hour_usd)}</b>net per hands-on hour (${r.hands_on_hours} h)</span>
      </div>
      ${stepsHTML(r)}
    </section>`;
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Routing: #/ the board, #/f/<key> a filtered board, #/p/<slug> a detail.
// ---------------------------------------------------------------------------

const FILTER_KEYS = { worth: 'Worth farming', marginal: 'Marginal', skip: 'Skip' };

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/');
  if (parts[0] === 'p' && parts[1] && BY_SLUG.has(parts[1])) {
    renderDetail(BY_SLUG.get(parts[1]));
    return;
  }
  if (parts[0] === 'f' && FILTER_KEYS[parts[1]]) {
    state.verdict = FILTER_KEYS[parts[1]];
  }
  renderBoard();
}

window.addEventListener('hashchange', route);
renderChrome();
route();
