// Token launch radar: the model.
//
// One sealed snapshot in, one ranked board out. The board prices protocols that record no token
// yet by learning what the market already pays for the ones that do:
//
//   1. COMPS. Every protocol whose token already trades is a comparable. They are cleaned to one
//      row per token family (several listings can share one gecko_id), to TVL of $10M or more
//      (below that the ratio is microcap noise), and stripped of rows whose market-cap-to-TVL
//      ratio no fit could survive.
//   2. FIT. A weighted-least-squares line in log space, weights TVL^0.25 so the prices of large
//      protocols speak louder than small ones without shouting the rest down:
//        log10(mcap) = a + b*log10(TVL) + c*growth + d*log10(age in days),
//      fitted on the cleaned comps only. Growth is the snapshot's seven-day TVL change, clamped;
//      age is how long DefiLlama has tracked the protocol, the snapshot's own clock for how long
//      it has run. No protocol name is ever an input: the same fitted line prices every row.
//   3. PROOF. The fit is tested blind by leave-one-out: each comp is priced by a line that never
//      saw it, and the spread of those misses is published with the board. The median miss is the
//      model's error multiple; the 75th-percentile miss sets the low/high band on every row, so a
//      row's band is exactly as wide as the model has earned.
//   4. BOARD. Every pre-token protocol that passes the same hygiene the house's watchlist uses
//      (no wrapped, staked, bridged or exchange product of a token that already trades, no
//      versioned spin-off) is priced by the line and ranked by implied value. The watchlist is the
//      floor of the board, never its ceiling.
//   5. PLANS. Each row carries a farm plan whose steps state their cost in dollars and their span
//      in weeks, and a verdict netted at the LOW end of the row's band: a stated share of that low
//      value is assumed to reach early users, one farmer's slice of it is sized against the
//      capital the plan commits, and the plan is Farm, Thin or Skip by what is left after costs.
//
// Everything below is a pure function of the snapshot bytes: same input, same board, byte for byte.

/** One protocol of the sealed snapshot: exactly the ten fields the input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Parse and lightly validate the sealed snapshot text. */
export function parseSnapshot(text: string): Snapshot {
  const snap = JSON.parse(text) as Snapshot;
  if (!Array.isArray(snap.protocols) || !Array.isArray(snap.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return snap;
}

/** A protocol whose token already trades, per the snapshot's own record. */
export function isTraded(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.gecko_id !== null && p.symbol !== null;
}

/** A protocol that records no token: no market cap, no gecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// ---------------------------------------------------------------------------
// Features: the only three figures the model may see, all from the snapshot.
// ---------------------------------------------------------------------------

const GROWTH_FLOOR = -50;
const GROWTH_CAP = 60;
const AGE_FLOOR_DAYS = 30;

/** Days between two UTC date strings, whole days, never negative. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

/** The age the model uses for every protocol: known ages, and the median for unknown ones. */
function ageTable(snap: Snapshot): Map<string, number> {
  const known: number[] = [];
  const raw = new Map<string, number | null>();
  for (const p of snap.protocols) {
    const age = p.listed_at === null ? null : Math.max(AGE_FLOOR_DAYS, daysBetween(p.listed_at, snap.as_of));
    raw.set(p.slug, age);
    if (age !== null) known.push(age);
  }
  known.sort((x, y) => x - y);
  const median = known.length === 0 ? 365 : known[Math.floor(known.length / 2)]!;
  const table = new Map<string, number>();
  for (const p of snap.protocols) table.set(p.slug, raw.get(p.slug) ?? median);
  return table;
}

/** The model's three inputs for one protocol, as a row vector with its intercept. */
function features(p: SnapshotProtocol, ageDays: number): number[] {
  const growth = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, p.change_7d ?? 0)) / 100;
  return [1, Math.log10(Math.max(1, p.tvl_usd)), growth, Math.log10(Math.max(AGE_FLOOR_DAYS, ageDays))];
}

// ---------------------------------------------------------------------------
// Ordinary least squares on the normal equations, solved by Gauss-Jordan.
// Small, exact and deterministic: the design here never exceeds four columns.
// ---------------------------------------------------------------------------

interface OlsFit {
  beta: number[];
  /** Residuals in the original y units. */
  residuals: number[];
  /** Leave-one-out absolute residuals in the original y units, exact via the hat matrix. */
  looAbs: number[];
  rSquared: number;
}

function invert(matrix: number[][]): number[][] {
  const n = matrix.length;
  const aug = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(aug[r]![col]!) > Math.abs(aug[pivot]![col]!)) pivot = r;
    if (Math.abs(aug[pivot]![col]!) < 1e-12) throw new Error('ols: singular design');
    [aug[col], aug[pivot]] = [aug[pivot]!, aug[col]!];
    const div = aug[col]![col]!;
    for (let j = 0; j < 2 * n; j++) aug[col]![j]! /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) aug[r]![j]! -= factor * aug[col]![j]!;
    }
  }
  return aug.map((row) => row.slice(n));
}

/**
 * Weighted least squares. With weights, the fit runs on rows scaled by sqrt(w); the hat-matrix
 * leave-one-out shortcut is exact in that scaled space, and its residuals are divided back by
 * sqrt(w) so every figure the report quotes is in the original y units.
 */
function ols(xs: number[][], ys: number[], ws?: number[]): OlsFit {
  const k = xs[0]!.length;
  const sw = (ws ?? xs.map(() => 1)).map((w) => Math.sqrt(w));
  const tx = xs.map((x, i) => x.map((v) => v * sw[i]!));
  const ty = ys.map((y, i) => y * sw[i]!);
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < tx.length; i++) {
    for (let a = 0; a < k; a++) {
      xty[a]! += tx[i]![a]! * ty[i]!;
      for (let b = 0; b < k; b++) xtx[a]![b]! += tx[i]![a]! * tx[i]![b]!;
    }
  }
  const xtxInv = invert(xtx);
  const beta = xtxInv.map((row) => row.reduce((sum, v, j) => sum + v * xty[j]!, 0));
  const residuals = xs.map((x, i) => ys[i]! - x.reduce((sum, v, j) => sum + v * beta[j]!, 0));
  const looAbs = tx.map((x, i) => {
    const h = Math.min(0.999, leverage(x, xtxInv));
    const eScaled = ty[i]! - x.reduce((sum, v, j) => sum + v * beta[j]!, 0);
    return Math.abs(eScaled / (1 - h)) / sw[i]!;
  });
  const mean = ys.reduce((s, v) => s + v, 0) / ys.length;
  const ssTot = ys.reduce((s, v) => s + (v - mean) ** 2, 0);
  const ssRes = residuals.reduce((s, v) => s + v * v, 0);
  return { beta, residuals, looAbs, rSquared: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

/** Leverage of row i: x_i' (X'X)^-1 x_i. */
function leverage(x: number[], xtxInv: number[][]): number {
  let h = 0;
  for (let a = 0; a < x.length; a++) for (let b = 0; b < x.length; b++) h += x[a]! * xtxInv[a]![b]! * x[b]!;
  return h;
}

/** Median of a copy of the values, sorted ascending. */
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

// ---------------------------------------------------------------------------
// The comps: cleaned traded protocols, the fit, and its blind leave-one-out.
// ---------------------------------------------------------------------------

export interface ModelReport {
  comps_considered: number;
  comps_used: number;
  families_merged: number;
  outliers_dropped: number;
  beta: number[];
  r_squared: number;
  /** Median leave-one-out miss, as a multiple: the model is typically within this factor. */
  loo_error_multiple: number;
  /** 75th-percentile leave-one-out miss, as a multiple: the width of every row's band. */
  band_multiple: number;
}

interface Comp {
  p: SnapshotProtocol;
  x: number[];
  y: number;
  /** Fit weight: TVL^0.25. */
  w: number;
}

/** Clean the traded set: one row per token family, $10M of TVL or more, ratios a fit can survive. */
function cleanComps(snap: Snapshot, ages: Map<string, number>): { comps: Comp[]; considered: number; merged: number } {
  const traded = snap.protocols.filter(isTraded);
  const byFamily = new Map<string, SnapshotProtocol>();
  for (const p of traded) {
    const kept = byFamily.get(p.gecko_id!);
    if (kept === undefined || p.tvl_usd > kept.tvl_usd) byFamily.set(p.gecko_id!, p);
  }
  const comps: Comp[] = [];
  for (const p of byFamily.values()) {
    if (p.tvl_usd < 10_000_000) continue;
    const ratio = p.mcap_usd! / Math.max(1, p.tvl_usd);
    if (ratio < 0.01 || ratio > 100) continue;
    comps.push({ p, x: features(p, ages.get(p.slug)!), y: Math.log10(p.mcap_usd!), w: Math.pow(p.tvl_usd, 0.25) });
  }
  return { comps, considered: traded.length, merged: traded.length - byFamily.size };
}

/** Fit the line; drop the comps it cannot explain at 2.25 robust sigmas, refit, at most twice. */
function fitModel(snap: Snapshot, ages: Map<string, number>): { fit: OlsFit; comps: Comp[]; report: ModelReport } {
  const { comps: first, considered, merged } = cleanComps(snap, ages);
  let kept = first;
  let fit = ols(kept.map((c) => c.x), kept.map((c) => c.y), kept.map((c) => c.w));
  let dropped = 0;
  for (let round = 0; round < 2; round++) {
    const absResid = fit.residuals.map(Math.abs);
    const sigma = 1.4826 * quantile(absResid, 0.5) || 1;
    const next = kept.filter((_, i) => absResid[i]! <= 2.25 * sigma);
    if (next.length === kept.length || next.length < 12) break;
    dropped += kept.length - next.length;
    kept = next;
    fit = ols(kept.map((c) => c.x), kept.map((c) => c.y), kept.map((c) => c.w));
  }
  const report: ModelReport = {
    comps_considered: considered,
    comps_used: kept.length,
    families_merged: merged,
    outliers_dropped: dropped,
    beta: fit.beta,
    r_squared: fit.rSquared,
    loo_error_multiple: Math.pow(10, quantile(fit.looAbs, 0.5)),
    band_multiple: Math.pow(10, quantile(fit.looAbs, 0.75)),
  };
  return { fit, comps: kept, report };
}

// ---------------------------------------------------------------------------
// Hygiene: which pre-token protocols are real radar subjects. The same rule
// the house's watchlist states, applied to the whole snapshot: a wrapped,
// staked or bridged product of a token that already trades is not a launch
// candidate, and neither is an exchange's own shelf or a versioned spin-off.
// ---------------------------------------------------------------------------

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

function passesHygiene(p: SnapshotProtocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (/\s(V2|V3|v2|v3|2\.0|3\.0)$/.test(p.name)) return false;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return false;
  for (const ex of EXCHANGE_PREFIXES) if (p.name === ex || p.name.startsWith(`${ex} `)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Farm plans. Every figure a step quotes is computed here from the row and
// the stated assumptions, so the page and the plan can never disagree.
// ---------------------------------------------------------------------------

/** The model's stated planning assumptions, printed on the dashboard as-is. */
export const ASSUMPTIONS: string[] = [
  'Value model: log10(market cap) fitted by weighted least squares on the cleaned traded comps (one row per token family, $10M+ TVL, weighted by TVL^0.25), on log10(TVL), seven-day TVL growth clamped to -50%..+60%, and log10(days tracked).',
  'Bands: each row shows the fitted value divided and multiplied by the 75th-percentile leave-one-out miss of that fit, measured blind on the comps.',
  'Netting: 3% of a row\u2019s low-end value is assumed to reach early users; one farmer\u2019s slice is their committed capital over itself plus the capital assumed to farm alongside, 0.5% of the protocol\u2019s TVL capped at $5M (past that, TVL is passive, not farming).',
  'Plan cost: gas at $6.00 an action on Ethereum, $0.35 on low-fee chains, $1.20 elsewhere, three actions a week, plus committed capital charged at 5% a year for the plan\u2019s weeks.',
  'Verdicts: Farm when the netted credit clears the plan cost by $250 or more, Thin when it clears it at all, Skip when it does not.',
];

const POOL_SHARE = 0.03;
const PARTICIPATION = 0.005;
const PARTICIPATION_CAP = 5_000_000;
const OPPORTUNITY_RATE = 0.05;
const FARM_MARGIN = 250;

const CHEAP_CHAINS = new Set([
  'Arbitrum One', 'Base', 'Optimism', 'Polygon', 'BNB Smart Chain', 'Solana', 'Avalanche',
  'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Fantom', 'Gnosis', 'Blast', 'Mode', 'Sonic',
]);

/** Gas for one on-chain action on a chain, in dollars, per the stated table. */
function gasFor(chain: string): number {
  if (chain === 'Ethereum') return 6.0;
  if (CHEAP_CHAINS.has(chain)) return 0.35;
  return 1.2;
}

/** Whole dollars, grouped, for plan text. */
function usd(n: number): string {
  return `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

export type Verdict = 'Farm' | 'Thin' | 'Skip';

export interface FarmPlan {
  steps: string[];
  cost_usd: number;
  weeks: number;
  reward_usd: number;
  verdict: Verdict;
}

/** The plan's shape by what the protocol is. */
function planGroup(category: string | null): string {
  switch (category) {
    case 'Dexs': return 'dex';
    case 'Lending': return 'lending';
    case 'Yield': case 'Yield Aggregator': return 'yield';
    case 'RWA': return 'rwa';
    case 'Risk Curators': case 'Onchain Capital Allocator': return 'curator';
    case 'Derivatives': return 'perps';
    default: return 'generic';
  }
}

const CORE_STEP: Record<string, (name: string, gas: string) => string> = {
  dex: (name, gas) => `Swap through ${name}'s pools three times a week, $150-$300 a trade, favouring its highest-TVL pairs; routed volume is the activity a launch snapshot can see, and each swap costs about ${gas} in gas.`,
  lending: (name) => `Supply about 60% of the capital to ${name}'s main market and borrow a small, safely collateralised amount against it once; leave both sides open so the book records the wallet as a real user.`,
  yield: (name) => `Deposit about 70% of the capital into ${name}'s flagship vault and leave it there untouched; a vault share that simply sits still for weeks is the clearest early-user signal there is.`,
  rwa: (name) => `Complete ${name}'s onboarding or verification if it asks for it, then hold a small position in its main real-world-asset pool; expect the onboarding itself to take a few days before size can move.`,
  curator: (name) => `Allocate about 60% of the capital across ${name}'s two largest curated vaults and stay through a full market cycle; curators reward depositors who remain, not drive-by deposits.`,
  perps: (name, gas) => `Trade small, hedged size on ${name} three times a week, $100-$200 a position, closing flat each time at about ${gas} a trade; steady volume without directional risk is the record to build.`,
  generic: (name) => `Use ${name}'s core product three times a week with real size, about $200 a session, and let the history accumulate; regular genuine usage is what a launch allocation can measure.`,
};

/** Build one row's farm plan: six steps, each stating its cost or its span. */
function farmPlan(p: SnapshotProtocol, impliedLow: number, onWatchlist: boolean): FarmPlan {
  const chain0 = p.chains[0] ?? 'Ethereum';
  const gas = gasFor(chain0);
  const capital = onWatchlist ? 2500 : p.tvl_usd >= 20_000_000 ? 1000 : 400;
  const weeks = onWatchlist ? 12 : p.tvl_usd >= 20_000_000 ? 10 : 8;
  const gasTotal = Math.max(1, Math.round(3 * weeks * gas));
  const opportunity = Math.round(capital * OPPORTUNITY_RATE * (weeks / 52));
  const cost = gasTotal + opportunity;
  const pool = impliedLow * POOL_SHARE;
  const alongside = Math.min(p.tvl_usd * PARTICIPATION, PARTICIPATION_CAP);
  const reward = Math.round(pool * (capital / (capital + alongside)));
  const net = reward - cost;
  const verdict: Verdict = net >= FARM_MARGIN ? 'Farm' : net >= 0 ? 'Thin' : 'Skip';
  const group = planGroup(p.category);
  const steps: string[] = [
    `Set up a fresh wallet for ${p.name} and fund it on ${chain0}, its main chain, with about ${usd(capital)} of working capital; keep a separate ${usd(Math.max(10, gasTotal))} of the chain's gas token aside for fees.`,
    CORE_STEP[group]!(p.name, usd(gas)),
    p.chains.length > 1
      ? `From week 3, repeat the same activity on ${p.chains[1]}, ${p.name}'s second chain, with about 25% of the capital; multi-chain users are the cohort launches most often over-weight.`
      : `From week 3, raise the core position by about 25% out of the plan's reserve; a balance that grows reads as conviction, not a one-off visit farmed in an afternoon.`,
    `Hold the rhythm for ${weeks} weeks: about 3 actions a week comes to roughly ${usd(gasTotal)} of gas, and the committed capital carries about ${usd(opportunity)} of opportunity cost at the stated 5% a year.`,
    `Check ${p.name}'s own dashboard or points page once a week and leave the position untouched between checks; if a snapshot or eligibility post appears, stop adding size and keep what is placed.`,
    `Netting at the low end of the band: 3% of ${usd(impliedLow)} is ${usd(pool)} for early users, and this plan's realistic slice of it is about ${usd(reward)} against ${usd(cost)} of cost over ${weeks} weeks - verdict: ${verdict === 'Farm' ? 'Farm it' : verdict === 'Thin' ? 'Thin, farm only with spare capital' : 'Skip, the numbers do not pay'}.`,
  ];
  return { steps, cost_usd: cost, weeks, reward_usd: reward, verdict };
}

// ---------------------------------------------------------------------------
// The board.
// ---------------------------------------------------------------------------

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  implied_low_usd: number;
  implied_high_usd: number;
  watchlist: boolean;
  verdict: Verdict;
  plan_cost_usd: number;
  plan_weeks: number;
  plan_reward_usd: number;
}

export interface Radar {
  as_of: string;
  floor_usd: number;
  model: ModelReport;
  assumptions: string[];
  rows: BoardRow[];
  live: { name: string; symbol: string; tvl_usd: number; mcap_usd: number }[];
  early_size: number;
  live_size: number;
  audited_size: number;
}

/** Build the whole radar from the snapshot: fit, price, rank, plan. */
export function buildRadar(snap: Snapshot): { board: BoardRow[]; radar: Radar } {
  const ages = ageTable(snap);
  const { fit, report } = fitModel(snap, ages);
  const watchlist = new Set(snap.watchlist);
  const subjects = snap.protocols.filter((p) => isPreToken(p) && passesHygiene(p));
  const rows: BoardRow[] = subjects.map((p) => {
    const x = features(p, ages.get(p.slug)!);
    const logValue = x.reduce((sum, v, j) => sum + v * fit.beta[j]!, 0);
    const implied = Math.min(100_000_000_000_000, Math.max(1, Math.round(Math.pow(10, logValue))));
    const low = Math.max(1, Math.round(implied / report.band_multiple));
    const high = Math.min(100_000_000_000_000, Math.round(implied * report.band_multiple));
    const plan = farmPlan(p, low, watchlist.has(p.slug));
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: implied,
      farm_steps: plan.steps,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: ages.get(p.slug)!,
      implied_low_usd: low,
      implied_high_usd: high,
      watchlist: watchlist.has(p.slug),
      verdict: plan.verdict,
      plan_cost_usd: plan.cost_usd,
      plan_weeks: plan.weeks,
      plan_reward_usd: plan.reward_usd,
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  rows.forEach((row, i) => { row.rank = i + 1; });
  const live = snap.protocols
    .filter(isTraded)
    .map((p) => ({ name: p.name, symbol: p.symbol!, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd);
  const radar: Radar = {
    as_of: snap.as_of,
    floor_usd: snap.floor_usd,
    model: report,
    assumptions: ASSUMPTIONS,
    rows,
    live,
    early_size: rows.length,
    live_size: live.length,
    audited_size: snap.protocols.filter(isPreToken).length,
  };
  return { board: rows, radar };
}

/** The dashboard's data as a script: one global, deterministic bytes. */
export function dataScript(radar: Radar): string {
  return `window.RADAR_DATA = ${JSON.stringify(radar).replace(/</g, '\\u003c')};\n`;
}

/** The gate's board checks, run by the program itself before anything is written. */
export function boardIssue(board: BoardRow[], snap: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(snap.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const row of board) {
    if (!slugs.has(row.slug)) return `row slug ${row.slug} is not in the snapshot`;
    if (seen.has(row.slug)) return `row slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd < 1 || row.implied_value_usd > 100_000_000_000_000) {
      return `row ${row.slug} has an implied value outside the gate's range`;
    }
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${row.slug} has a farm step of ${len} characters`;
    }
  }
  for (const slug of snap.watchlist) if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `ranks are not exactly 1..${byRank.length}`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return 'implied value rises as rank ascends';
  }
  if (board.length > 1 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'every implied value is the same';
  return null;
}
