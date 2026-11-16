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

/** Signed percent, or a dash when the snapshot does not report one. */
function pct(v) {
  if (v === null || v === undefined) return '<span class="flat">-</span>';
  const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat';
  return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
}

/** Age in days as a short human span. */
function ageText(days) {
  if (days >= 730) return `${(days / 365).toFixed(1)} yrs`;
  if (days >= 365) return `${(days / 365).toFixed(1)} yrs`;
  return `${days} days`;
}

/** The verdict as a coloured chip. */
function chip(verdict) {
  return `<span class="chip ${verdict.toLowerCase()}">${verdict}</span>`;
}

// ---------------------------------------------------------------------------
// The masthead stats and the model bar: the fit, stated where a reader lands.
// ---------------------------------------------------------------------------

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
  document.getElementById('model-bar').innerHTML = `
    <h2>The value model, fitted not asserted</h2>
    <p class="eq">${eq}</p>
    <p>The line is fitted by weighted least squares on the protocols whose token already trades, cleaned to one row per token family at $10M of TVL or more, then tested blind by leave-one-out: every comp is re-priced by a line that never saw it. The bands on the board are that test's 75th-percentile miss, so a row's band is exactly as wide as the model has earned. Growth is the seven-day TVL change clamped to -50%..+60%; age is how long the snapshot's source has tracked the protocol. No protocol's name is an input anywhere.</p>
    <div class="kpis">
      <span class="kpi"><b>${m.comps_used}</b>comps fitted (of ${m.comps_considered} trading)</span>
      <span class="kpi"><b>${m.r_squared.toFixed(2)}</b>R-squared</span>
      <span class="kpi"><b>x${m.loo_error_multiple.toFixed(2)}</b>median blind miss</span>
      <span class="kpi"><b>x${m.band_multiple.toFixed(2)}</b>band width</span>
      <span class="kpi"><b>${D.as_of}</b>snapshot date</span>
    </div>
    <details class="assumptions"><summary>Every stated assumption behind the values and the verdicts</summary>
    <ol>${D.assumptions.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>`;
}

// ---------------------------------------------------------------------------
// The board: controls, a sortable table, and the live set kept apart below.
// ---------------------------------------------------------------------------

const state = { q: '', cat: '', verdict: '', wl: false, sort: 'rank', dir: 1 };
const SORTS = {
  rank: (r) => r.rank,
  name: (r) => r.name.toLowerCase(),
  tvl: (r) => r.tvl_usd,
  chg: (r) => (r.change_7d === null ? -Infinity : r.change_7d),
  age: (r) => r.age_days,
  implied: (r) => r.implied_value_usd,
  net: (r) => r.plan_reward_usd - r.plan_cost_usd,
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
  const vers = ['Farm', 'Thin', 'Skip'].map((v) => `<option value="${v}"${state.verdict === v ? ' selected' : ''}>${v}</option>`).join('');
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
    ['age', 'Tracked', 'n'], ['implied', 'Implied value (band)', 'n'], ['verdict', 'Verdict', ''], ['net', 'Plan net', 'n'],
  ];
  return `<thead><tr>${cols.map(([key, label, cls]) =>
    `<th class="${cls}" data-sort="${key}">${label}${state.sort === key ? ` <span class="arrow">${state.dir === 1 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead>`;
}

function rowHTML(r) {
  const net = r.plan_reward_usd - r.plan_cost_usd;
  return `<tr data-slug="${esc(r.slug)}">
    <td class="n">${r.rank}</td>
    <td><span class="proto-name">${esc(r.name)}</span>${r.watchlist ? '<span class="wl">watchlist</span>' : ''}<span class="proto-cat">${esc(r.category ?? 'Uncategorised')} · ${esc(r.chains.slice(0, 3).join(', '))}</span></td>
    <td class="n">${money(r.tvl_usd)}</td>
    <td class="n">${pct(r.change_7d)}</td>
    <td class="n">${ageText(r.age_days)}</td>
    <td class="n">${money(r.implied_value_usd)}<span class="band">${money(r.implied_low_usd)} - ${money(r.implied_high_usd)}</span></td>
    <td>${chip(r.verdict)}</td>
    <td class="n"><span class="net ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : '-'}${money(Math.abs(net))}</span></td>
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
  view.innerHTML = `${controlsHTML()}
    <table class="board">${headHTML()}<tbody id="tbody"></tbody></table>
    ${liveHTML()}`;
  wireControls();
  refreshTable();
}

function refreshTable() {
  const list = filteredRows();
  const tbody = document.getElementById('tbody');
  if (tbody) tbody.innerHTML = list.length ? list.map(rowHTML).join('') : `<tr><td colspan="8" class="empty">No protocol matches that filter. Loosen it and the radar sweeps again.</td></tr>`;
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
    else { state.sort = key; state.dir = key === 'name' ? 1 : -1; if (key === 'rank') state.dir = 1; }
    renderBoard();
  }));
  document.getElementById('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-slug]');
    if (tr) location.hash = `#/p/${tr.getAttribute('data-slug')}`;
  });
}

// ---------------------------------------------------------------------------
// The detail view: one protocol, its band, and its whole farm plan.
// ---------------------------------------------------------------------------

function bandHTML(r) {
  const lo = Math.log10(r.implied_low_usd);
  const hi = Math.log10(r.implied_high_usd);
  const mid = Math.log10(r.implied_value_usd);
  const span = hi - lo;
  const d0 = lo - span * 0.18;
  const d1 = hi + span * 0.18;
  const pos = (v) => (((Math.log10(v) - d0) / (d1 - d0)) * 100).toFixed(2);
  return `<div class="bandbar" aria-label="Value band">
    <div class="track">
      <div class="range" style="left:${pos(r.implied_low_usd)}%;width:${(pos(r.implied_high_usd) - pos(r.implied_low_usd)).toFixed(2)}%"></div>
      <div class="mark" style="left:${pos(r.implied_value_usd)}%"></div>
    </div>
    <div class="labels"><span>low ${moneyFull(r.implied_low_usd)}</span><span>fitted ${moneyFull(r.implied_value_usd)}</span><span>high ${moneyFull(r.implied_high_usd)}</span></div>
  </div>`;
}

function renderDetail(r) {
  const net = r.plan_reward_usd - r.plan_cost_usd;
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
      <div class="stat"><b>${money(r.tvl_usd)}</b><span>TVL</span></div>
      <div class="stat"><b>${r.change_7d === null ? '-' : `${r.change_7d > 0 ? '+' : ''}${r.change_7d.toFixed(1)}%`}</b><span>TVL change, 7d</span></div>
      <div class="stat"><b>${ageText(r.age_days)}</b><span>tracked with no token</span></div>
      <div class="stat"><b>${esc(r.chains.join(', '))}</b><span>chains</span></div>
    </div>
    ${bandHTML(r)}
    <section class="plan">
      <h2 class="section-h">The farm plan, costed and netted</h2>
      <div class="summary">
        <span class="kpi"><b>${moneyFull(r.plan_cost_usd)}</b>plan cost</span>
        <span class="kpi"><b>${r.plan_weeks} weeks</b>plan span</span>
        <span class="kpi"><b>${moneyFull(r.plan_reward_usd)}</b>netted credit at the band's low end</span>
        <span class="kpi"><b class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : '-'}${moneyFull(Math.abs(net)).slice(1)}</b>net</span>
      </div>
      <ol>${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    </section>`;
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Routing: #/ the board, #/f/<Verdict> a filtered board, #/p/<slug> a detail.
// ---------------------------------------------------------------------------

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/');
  if (parts[0] === 'p' && parts[1] && BY_SLUG.has(parts[1])) {
    renderDetail(BY_SLUG.get(parts[1]));
    return;
  }
  if (parts[0] === 'f' && ['Farm', 'Thin', 'Skip'].includes(parts[1])) {
    state.verdict = parts[1];
  }
  renderBoard();
}

window.addEventListener('hashchange', route);
renderChrome();
route();
