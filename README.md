# Token Launch Radar

[![make.fun bounty](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/vnazt/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/vnazt/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

An entry for the make.fun bounty [token-radar-01](https://make.fun/bounty/token-radar-01): a radar for protocols that record no token yet, ranked by an implied value learned from the protocols whose tokens already trade.

## The model

No hand-picked multiples and no hardcoded names. From the sealed snapshot alone:

1. **Comps.** The traded protocols are cleaned to one row per token family, TVL of $10M or more, with market-cap-to-TVL ratios a fit can survive: 89 comps.
2. **Fit.** Weighted least squares in log space: `log10(value) = a + b*log10(TVL) + c*growth + d*log10(age)`, weights TVL^0.25. Growth is the seven-day TVL change clamped to -50%..+60%; age is how long the source has tracked the protocol.
3. **Blind test.** Leave-one-out over the comps: every comp is re-priced by a line that never saw it. The median miss (x3.29) and the 75th-percentile miss (x6.07, the width of every row's band) are printed on the dashboard itself.
4. **Board.** 201 pre-token protocols that pass the watchlist's own hygiene, priced by the fitted line, ranked by implied value, all 40 watchlist protocols covered. The 144 protocols whose token already trades are set aside as the model's teachers, never ranked.
5. **Plans.** Every row carries a six-step farm plan with dollar costs and week spans, netted at the low end of its band to a Farm / Thin / Skip verdict, under assumptions the dashboard states in full.

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
