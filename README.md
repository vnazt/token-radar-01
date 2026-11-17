# Token Launch Radar

[![make.fun bounty](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/vnazt/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/vnazt/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

An entry for the make.fun bounty [token-radar-01](https://make.fun/bounty/token-radar-01): a radar for protocols that record no token yet, ranked by an implied value learned from the protocols whose tokens already trade.

## The model

No hand-picked multiples and no hardcoded names. From the sealed snapshot alone:

1. **Comps.** The traded protocols are cleaned to one row per token family, TVL of $10M or more, with market-cap-to-TVL ratios a fit can survive: 89 comps.
2. **Fit.** Weighted least squares in log space: `log10(value) = a + b*log10(TVL) + c*growth + d*log10(age)`, weights TVL^0.25. Growth is the seven-day TVL change clamped to -50%..+60%; age is how long the source has tracked the protocol.
3. **Proof, four ways.** Leave-one-out over the comps (median miss x3.29; the 75th-percentile miss x6.07 widths every row's wide band, the signed interquartile range its P25-P75). An ablation ladder from one flat multiple of TVL (x4.63) to the full line, so every term earns its place. A walk-forward: fitted on the 33 older comps by listing date, the line prices the 33 newer ones at x3.35. And 200 seeded refits of the comps give every row a P10-P90 rank range. All of it is printed on the dashboard itself, next to a scatter of the comps against the curve.
4. **Board.** 201 pre-token protocols that pass the watchlist's own hygiene, priced by the fitted line, ranked by implied value, all 40 watchlist protocols covered. The 144 protocols whose token already trades are set aside as the model's teachers, never ranked.
5. **Plans.** Every row carries an eight-step farm plan - when each step happens, what it costs, how long it takes, a stop rule, a claim step that only ever uses the protocol's own bookmarked domain. The economics are printed, not asserted: 10% of the implied value is assumed to reach early users, one farmer's slice is their deposit diluted by the protocol's whole TVL, and the verdict at a $10,000 deposit is Worth farming when the plan breaks even at a 10% launch chance or better, Marginal to 35%, Skip beyond that. Most large protocols are Skip, and the board says so: 5 Worth farming, 78 Marginal, 118 Skip.

## Run it

Node 22, standard library only, no network:

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output directory. Two runs write identical bytes. Open `out/dashboard/index.html` in a browser to read the board.

## Layout

- `main.ts` — the entry program: snapshot in, hand-in out.
- `lib/model.ts` — the comps, the fit, the blind test, the board, the farm plans.
- `dashboard/` — the page: a sortable, filterable board, a detail view per protocol, the model stated up front.
- `screenshots/` — the board, a detail view, and a filtered view, as the judge sees them.
- `vendor/makefun-board.ts` — make.fun's dossier library, vendored so the dossier matches the scorer's rebuild byte for byte.

MIT licensed; see `LICENSE`.
