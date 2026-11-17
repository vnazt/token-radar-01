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
//      fitted on the cleaned comps only, with the comps it cannot explain at 2.25 robust sigmas
//      dropped and the line refitted. Growth is the snapshot's seven-day TVL change, clamped;
//      age is how long DefiLlama has tracked the protocol. No protocol name is ever an input:
//      the same fitted line prices every row.
//   3. PROOF, FOUR WAYS. (a) Leave-one-out: each comp is priced by a line that never saw it; the
//      median miss is the model's error multiple and the interquartile range of the signed
//      misses draws every row's band. (b) An ablation ladder: the same test run on a flat
//      multiple of TVL, on size alone, on size with growth, on size with age, and on the full
//      line, so every term has to earn its place. (c) A walk-forward: the line is fitted on the
//      older half of the comps by listing date and tested on the newer half it never saw.
//      (d) Two hundred seeded refits of the comps give every board row a rank range, P10 to
//      P90: a rank is a claim, and the range says how hard the data holds it.
//   4. BOARD. Every pre-token protocol that passes the same hygiene the house's watchlist uses
//      (no wrapped, staked, bridged or exchange product of a token that already trades, no
//      versioned spin-off) is priced by the line and ranked by implied value. The watchlist is
//      the floor of the board, never its ceiling.
//   5. PLANS. Each row carries an eight-step farm plan whose steps state when they happen, what
//      they cost and how long they take, including a stop rule and a claim step that only ever
//      uses the protocol's own bookmarked domain. The economics are printed, not asserted: a
//      stated share of the implied value is assumed to reach early users, one farmer's slice of
//      it is their deposit diluted by the protocol's whole TVL, and the verdict at a $10,000
//      deposit is Worth farming when the plan breaks even at a 10% launch chance or better,
//      Marginal to 35%, Skip beyond that. Most large protocols are Skip, and the board says so.
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
  /** Leave-one-out residuals in the original y units, exact via the hat matrix. */
  looSigned: number[];
  /** Absolute leave-one-out residuals. */
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
  const looSigned = tx.map((x, i) => {
    const h = Math.min(0.999, leverage(x, xtxInv));
    const eScaled = ty[i]! - x.reduce((sum, v, j) => sum + v * beta[j]!, 0);
    return eScaled / (1 - h) / sw[i]!;
  });
  const mean = ys.reduce((s, v) => s + v, 0) / ys.length;
  const ssTot = ys.reduce((s, v) => s + (v - mean) ** 2, 0);
  const ssRes = residuals.reduce((s, v) => s + v * v, 0);
  return { beta, residuals, looSigned, looAbs: looSigned.map(Math.abs), rSquared: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

/** Leverage of row i: x_i' (X'X)^-1 x_i. */
function leverage(x: number[], xtxInv: number[][]): number {
  let h = 0;
  for (let a = 0; a < x.length; a++) for (let b = 0; b < x.length; b++) h += x[a]! * xtxInv[a]![b]! * x[b]!;
  return h;
}

/** A quantile of a copy of the values, sorted ascending. */
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** Median absolute miss as a multiple, plus the share of misses within 3x, for one error set. */
function missStats(absLogErrors: number[]): { median_x: number; within_3x: number } {
  return {
    median_x: Math.pow(10, quantile(absLogErrors, 0.5)),
    within_3x: absLogErrors.filter((e) => e <= Math.log10(3)).length / Math.max(1, absLogErrors.length),
  };
}

// ---------------------------------------------------------------------------
// The comps: cleaned traded protocols, the fit, and its blind tests.
// ---------------------------------------------------------------------------

export interface AblationRow {
  label: string;
  loo_median_x: number;
  within_3x: number;
}

export interface ModelReport {
  comps_considered: number;
  comps_used: number;
  families_merged: number;
  outliers_dropped: number;
  beta: number[];
  r_squared: number;
  /** Median leave-one-out miss, as a multiple: the model is typically within this factor. */
  loo_error_multiple: number;
  /** 75th-percentile leave-one-out miss, as a multiple: the width of every row's wide band. */
  band_multiple: number;
  /** The ablation ladder, weakest first: every term has to earn its place. */
  ablation: AblationRow[];
  /** Walk-forward: fitted on the older half of the comps, tested on the newer half. */
  walk_forward: { train: number; test: number; median_x: number; within_3x: number };
  /** Seeded refits behind every row's rank range. */
  refits: number;
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
function fitClean(snap: Snapshot, ages: Map<string, number>): { fit: OlsFit; comps: Comp[]; considered: number; merged: number; dropped: number } {
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
  return { fit, comps: kept, considered, merged, dropped };
}

/** The ablation ladder on the cleaned comps: each variant priced blind by leave-one-out. */
function ablation(comps: Comp[]): AblationRow[] {
  const rows: AblationRow[] = [];
  // Flat multiple: predict every comp at the median cap-to-TVL ratio of the others.
  const logRatio = comps.map((c) => c.y - c.x[1]!);
  const flatErrs = logRatio.map((r, i) => Math.abs(r - quantile(logRatio.filter((_, j) => j !== i), 0.5)));
  const flat = missStats(flatErrs);
  rows.push({ label: 'One flat multiple of TVL', loo_median_x: flat.median_x, within_3x: flat.within_3x });
  const variants: { label: string; cols: number[] }[] = [
    { label: 'Size curve (log TVL)', cols: [0, 1] },
    { label: '+ growth carry', cols: [0, 1, 2] },
    { label: '+ seasoning (log age)', cols: [0, 1, 3] },
    { label: 'Full line (size, growth, age)', cols: [0, 1, 2, 3] },
  ];
  for (const v of variants) {
    const xs = comps.map((c) => v.cols.map((j) => c.x[j]!));
    const f = ols(xs, comps.map((c) => c.y), comps.map((c) => c.w));
    const s = missStats(f.looAbs);
    rows.push({ label: v.label, loo_median_x: s.median_x, within_3x: s.within_3x });
  }
  return rows;
}

/** Walk-forward: fit on the older half of the dated comps, price the newer half blind. */
function walkForward(comps: Comp[]): { train: number; test: number; median_x: number; within_3x: number } {
  const dated = comps.filter((c) => c.p.listed_at !== null).sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  if (train.length < 12 || test.length < 4) return { train: train.length, test: test.length, median_x: 0, within_3x: 0 };
  const f = ols(train.map((c) => c.x), train.map((c) => c.y), train.map((c) => c.w));
  const errs = test.map((c) => Math.abs(c.x.reduce((s, v, j) => s + v * f.beta[j]!, 0) - c.y));
  return { train: train.length, test: test.length, ...missStats(errs) };
}

/** mulberry32: a tiny seeded PRNG, so the refits are the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REFITS = 200;
const REFIT_SEED = 0x5eed;

/**
 * Rank ranges: resample the comps with replacement, refit, reprice every subject, and keep
 * each subject's P10 and P90 rank across the refits. A rank the data holds loosely shows it.
 */
function rankRanges(comps: Comp[], subjects: { slug: string; x: number[] }[]): Map<string, { p10: number; p90: number }> {
  const rand = mulberry32(REFIT_SEED);
  const ranks = new Map<string, number[]>(subjects.map((s) => [s.slug, []]));
  for (let r = 0; r < REFITS; r++) {
    const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rand() * comps.length)]!);
    let beta: number[];
    try {
      beta = ols(sample.map((c) => c.x), sample.map((c) => c.y), sample.map((c) => c.w)).beta;
    } catch {
      continue;
    }
    const priced = subjects.map((s) => ({ slug: s.slug, v: s.x.reduce((sum, v, j) => sum + v * beta[j]!, 0) }));
    priced.sort((a, b) => b.v - a.v || (a.slug < b.slug ? -1 : 1));
    priced.forEach((row, i) => ranks.get(row.slug)!.push(i + 1));
  }
  const out = new Map<string, { p10: number; p90: number }>();
  for (const s of subjects) {
    const list = ranks.get(s.slug)!;
    out.set(s.slug, { p10: Math.round(quantile(list, 0.1)), p90: Math.round(quantile(list, 0.9)) });
  }
  return out;
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
// Farm economics and plans. Every figure a step quotes is computed here from
// the row and the stated assumptions, so the page and the plan never disagree.
// ---------------------------------------------------------------------------

/** The model's stated planning assumptions, printed on the dashboard as-is. */
export const ASSUMPTIONS: string[] = [
  'Value model: log10(market cap) fitted by weighted least squares on the cleaned traded comps (one row per token family, $10M+ TVL, weighted by TVL^0.25), on log10(TVL), seven-day TVL growth clamped to -50%..+60%, and log10(days tracked). Comps the line cannot explain at 2.25 robust sigmas are dropped and the line refitted, at most twice.',
  'Validation: leave-one-out on the comps (each priced by a line that never saw it), an ablation ladder from one flat multiple of TVL to the full line, a walk-forward fitted on the older half of the comps by listing date and tested on the newer half, and 200 seeded bootstrap refits behind every rank range.',
  'Bands: each row shows a P25-P75 range from the signed leave-one-out misses and a wider low/high at the 75th-percentile miss; a row\u2019s band is exactly as wide as the model has earned.',
  'Economics: 10% of a row\u2019s implied value is assumed to reach early users. One farmer\u2019s slice of it is that share times their deposit over their deposit plus the protocol\u2019s whole TVL - size dilutes, and the board does not pretend otherwise.',
  'Plan cost: gas at $6.00 an action on Ethereum, $0.35 on low-fee chains, $1.20 elsewhere, three actions a week, plus the deposit charged at 5% a year for the plan\u2019s weeks. Hands-on time is 0.6 hours of setup and closing plus 0.35 hours a week.',
  'Verdicts at the $10,000 reference deposit: Worth farming when costs break even at a 10% launch chance or better, Marginal to 35%, Skip beyond that. The $1,000 column runs the same plan smaller; its verdict can differ and the detail view shows both.',
];

const AIRDROP_SHARE = 0.1;
const REF_DEPOSIT = 10_000;
const SMALL_DEPOSIT = 1_000;
const OPPORTUNITY_RATE = 0.05;
const WORTH_MAX_BREAKEVEN = 0.1;
const MARGINAL_MAX_BREAKEVEN = 0.35;

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

/** Dollars with cents when small, for step costs. */
function usd2(n: number): string {
  if (Math.abs(n) >= 1000) return usd(n);
  return `$${n.toFixed(2)}`;
}

/** Signed dollars for nets: -$197, never $-197. */
function usdSigned(n: number): string {
  return n < 0 ? `-${usd(-n)}` : usd(n);
}

export type Verdict = 'Worth farming' | 'Marginal' | 'Skip';

export interface FarmPlan {
  steps: string[];
  weeks: number;
  hours: number;
  gas_usd: number;
  slice_ref_usd: number;
  cost_ref_usd: number;
  net_ref_usd: number;
  breakeven_ref: number;
  net_small_usd: number;
  breakeven_small: number;
  net_per_hour_usd: number;
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

const CORE_STEP: Record<string, (name: string) => string> = {
  dex: (name) => `Swap through ${name}'s pools in $150-$300 trades, favouring its highest-TVL pairs; routed volume is the activity a launch snapshot can see.`,
  lending: (name) => `Supply about 60% of the deposit to ${name}'s main market and borrow a small, safely collateralised amount against it once; leave both sides open so the book records a real user.`,
  yield: (name) => `Deposit about 70% of the deposit into ${name}'s flagship vault and leave it untouched; a vault share that sits still for weeks is the clearest early-user signal there is.`,
  curator: (name) => `Allocate about 60% of the deposit across ${name}'s two largest curated vaults and stay through a full market cycle; curators reward depositors who remain, not drive-by deposits.`,
  perps: (name) => `Trade small, hedged size on ${name}, $100-$200 a position, closing flat each time; steady volume without directional risk is the record to build.`,
  rwa: (name) => `Complete ${name}'s onboarding or verification if it asks for it, then hold a small position in its main real-world-asset pool; expect onboarding to take a few days before size can move.`,
  generic: (name) => `Use ${name}'s core product with real size, about $200 a session, and let the history accumulate; regular genuine usage is what a launch allocation can measure.`,
};

/** One deposit size run through the stated economics. */
function economics(deposit: number, implied: number, tvl: number, gasTotal: number, weeks: number): { slice: number; cost: number; net: number; breakeven: number } {
  const slice = AIRDROP_SHARE * implied * (deposit / (deposit + Math.max(1, tvl)));
  const cost = gasTotal + deposit * OPPORTUNITY_RATE * (weeks / 52);
  const net = slice - cost;
  const breakeven = slice > 0 ? cost / slice : 99;
  return { slice, cost, net, breakeven };
}

/** Build one row's farm plan: eight steps, each with its when, its cost and its minutes. */
function farmPlan(p: SnapshotProtocol, implied: number, onWatchlist: boolean): FarmPlan {
  const chain0 = p.chains[0] ?? 'Ethereum';
  const gas = gasFor(chain0);
  const weeks = onWatchlist ? 12 : p.tvl_usd >= 20_000_000 ? 10 : 8;
  const gasTotal = 3 * weeks * gas;
  const hours = Math.round((0.6 + 0.35 * weeks) * 10) / 10;
  const ref = economics(REF_DEPOSIT, implied, p.tvl_usd, gasTotal, weeks);
  const small = economics(SMALL_DEPOSIT, implied, p.tvl_usd, gasTotal, weeks);
  const verdict: Verdict = ref.breakeven <= WORTH_MAX_BREAKEVEN ? 'Worth farming' : ref.breakeven <= MARGINAL_MAX_BREAKEVEN ? 'Marginal' : 'Skip';
  const group = planGroup(p.category);
  const stopLevel = usd(p.tvl_usd * 0.8);
  const pct = (x: number) => `${Math.round(Math.min(9.99, x) * 100)}%`;
  const steps: string[] = [
    `Day 0 \u00b7 $1.00 \u00b7 20 min - Set up a fresh wallet for ${p.name}; open its listing on DefiLlama, follow the official domain from there and bookmark it - that bookmark is the only address a claim will ever come from.`,
    `Day 0 \u00b7 ${usd2(gas)} \u00b7 15 min - Fund the wallet on ${chain0}, ${p.name}'s main chain, and place the core position at the reference size of $10,000 (the same plan runs at $1,000): ${CORE_STEP[group]!(p.name)}`,
    `Weekly \u00d7${weeks} \u00b7 ${usd2(3 * gas)} a week \u00b7 15 min a week - Repeat the core activity three times a week, every week, at a steady size; a rhythm held for ${weeks} weeks is the record, not any single session.`,
    p.chains.length > 1
      ? `Week 3 \u00b7 ${usd2(gasFor(p.chains[1]!))} \u00b7 10 min - Repeat the same activity on ${p.chains[1]}, ${p.name}'s second chain, with about 25% of the deposit; multi-chain users are the cohort launches most often over-weight.`
      : `Week 3 \u00b7 ${usd2(gas)} \u00b7 10 min - Raise the core position by about 25% out of the reserve; a balance that grows reads as conviction, not a one-off visit farmed in an afternoon.`,
    `Weekly \u00b7 $0.00 \u00b7 10 min - Check ${p.name}'s own dashboard or points page and its TVL against the stop level of ${stopLevel}; leave the position untouched between checks.`,
    `Any day \u00b7 ${usd2(gas + 0.66)} \u00b7 15 min - Stop rule: if TVL closes under ${stopLevel}, withdrawals pause, or bad debt is reported, withdraw at once and end the plan; no verdict on this board outranks capital safety.`,
    `Week ${weeks} \u00b7 $0.00 \u00b7 10 min - Hold the position untouched through the final week; if ${p.name} posts a snapshot or an eligibility list, stop adding size at once and keep what is placed.`,
    `Netting \u00b7 $0.00 \u00b7 0 min - At $10,000: slice if launch ${usd(ref.slice)} = 10% of ${usd(implied)} \u00d7 $10,000/($10,000 + ${usd(p.tvl_usd)} TVL); costs ${usd(ref.cost)} (gas ${usd(gasTotal)} + opportunity ${usd(ref.cost - gasTotal)}); net ${usdSigned(ref.net)}, break-even ${pct(ref.breakeven)}, ${usdSigned(Math.round(ref.net / hours))} an hour over ${hours} hands-on hours. At $1,000: net ${usdSigned(small.net)}, break-even ${pct(small.breakeven)}. Verdict: ${verdict}.`,
  ];
  return {
    steps,
    weeks,
    hours,
    gas_usd: Math.round(gasTotal * 100) / 100,
    slice_ref_usd: Math.round(ref.slice),
    cost_ref_usd: Math.round(ref.cost),
    net_ref_usd: Math.round(ref.net),
    breakeven_ref: Math.round(Math.min(9.99, ref.breakeven) * 1000) / 1000,
    net_small_usd: Math.round(small.net),
    breakeven_small: Math.round(Math.min(9.99, small.breakeven) * 1000) / 1000,
    net_per_hour_usd: Math.round(ref.net / hours),
    verdict,
  };
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
  /** P25-P75 range from the signed leave-one-out misses. */
  band25_low_usd: number;
  band25_high_usd: number;
  /** Wider low/high at the 75th-percentile leave-one-out miss. */
  implied_low_usd: number;
  implied_high_usd: number;
  /** Rank range across the 200 seeded refits. */
  rank_p10: number;
  rank_p90: number;
  watchlist: boolean;
  verdict: Verdict;
  plan_cost_usd: number;
  plan_weeks: number;
  plan_reward_usd: number;
  slice_ref_usd: number;
  net_ref_usd: number;
  breakeven_ref: number;
  net_small_usd: number;
  breakeven_small: number;
  net_per_hour_usd: number;
  hands_on_hours: number;
  gas_usd: number;
}

/** One cleaned comp, for the fit plot and the detail view's nearest-comps table. */
export interface CompPoint {
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  curve_usd: number;
  ratio: number;
}

export interface Radar {
  as_of: string;
  floor_usd: number;
  model: ModelReport;
  assumptions: string[];
  rows: BoardRow[];
  comps: CompPoint[];
  live: { name: string; symbol: string; tvl_usd: number; mcap_usd: number }[];
  early_size: number;
  live_size: number;
  audited_size: number;
  watchlist_size: number;
}

/** Build the whole radar from the snapshot: fit, test, price, rank, plan. */
export function buildRadar(snap: Snapshot): { board: BoardRow[]; radar: Radar } {
  const ages = ageTable(snap);
  const { fit, comps, considered, merged, dropped } = fitClean(snap, ages);
  const report: ModelReport = {
    comps_considered: considered,
    comps_used: comps.length,
    families_merged: merged,
    outliers_dropped: dropped,
    beta: fit.beta,
    r_squared: fit.rSquared,
    loo_error_multiple: Math.pow(10, quantile(fit.looAbs, 0.5)),
    band_multiple: Math.pow(10, quantile(fit.looAbs, 0.75)),
    ablation: ablation(comps),
    walk_forward: walkForward(comps),
    refits: REFITS,
  };
  const watchlist = new Set(snap.watchlist);
  const subjects = snap.protocols.filter((p) => isPreToken(p) && passesHygiene(p));
  const subjectX = subjects.map((p) => ({ slug: p.slug, x: features(p, ages.get(p.slug)!) }));
  const ranges = rankRanges(comps, subjectX);
  const q25 = quantile(fit.looSigned, 0.25);
  const q75 = quantile(fit.looSigned, 0.75);
  const rows: BoardRow[] = subjects.map((p, i) => {
    const x = subjectX[i]!.x;
    const logValue = x.reduce((sum, v, j) => sum + v * fit.beta[j]!, 0);
    const implied = Math.min(100_000_000_000_000, Math.max(1, Math.round(Math.pow(10, logValue))));
    const low = Math.max(1, Math.round(implied / report.band_multiple));
    const high = Math.min(100_000_000_000_000, Math.round(implied * report.band_multiple));
    const plan = farmPlan(p, implied, watchlist.has(p.slug));
    const range = ranges.get(p.slug)!;
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
      band25_low_usd: Math.max(1, Math.round(Math.pow(10, logValue + q25))),
      band25_high_usd: Math.min(100_000_000_000_000, Math.round(Math.pow(10, logValue + q75))),
      implied_low_usd: low,
      implied_high_usd: high,
      rank_p10: range.p10,
      rank_p90: range.p90,
      watchlist: watchlist.has(p.slug),
      verdict: plan.verdict,
      plan_cost_usd: plan.cost_ref_usd,
      plan_weeks: plan.weeks,
      plan_reward_usd: plan.slice_ref_usd,
      slice_ref_usd: plan.slice_ref_usd,
      net_ref_usd: plan.net_ref_usd,
      breakeven_ref: plan.breakeven_ref,
      net_small_usd: plan.net_small_usd,
      breakeven_small: plan.breakeven_small,
      net_per_hour_usd: plan.net_per_hour_usd,
      hands_on_hours: plan.hours,
      gas_usd: plan.gas_usd,
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  rows.forEach((row, i) => { row.rank = i + 1; });
  const compPoints: CompPoint[] = comps.map((c) => {
    const curve = Math.pow(10, c.x.reduce((sum, v, j) => sum + v * fit.beta[j]!, 0));
    return {
      name: c.p.name,
      category: c.p.category,
      tvl_usd: c.p.tvl_usd,
      mcap_usd: c.p.mcap_usd!,
      curve_usd: Math.round(curve),
      ratio: Math.round((c.p.mcap_usd! / curve) * 100) / 100,
    };
  }).sort((a, b) => b.tvl_usd - a.tvl_usd);
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
    comps: compPoints,
    live,
    early_size: rows.length,
    live_size: live.length,
    audited_size: snap.protocols.filter(isPreToken).length,
    watchlist_size: snap.watchlist.length,
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
