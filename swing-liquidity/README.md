# Liquidity-first low-cap swing (paper only)

Isolated paper book for BSC names with market cap at most $3M. It ranks **depth, two-sided persistence, and estimated $20 impact** ahead of “fell 30% and printed a green candle.”

This process cannot place an order. `live` is hard-coded `false`. `SWING_LIVE=true` exits 2. It does not import the repository’s live-entry gates, and a passing informational gate does not turn anything on.

It is **not** a claim that the new rules make money. The only closed-trade sample described for the previous rule (13 DEX paper closes, 3 wins / 10 losses, about −55.47U) was not in the source bundle and is not replayed here. Thresholds below were not fitted to that sample.

## Deploy without touching the shared checkout

Copy this directory to its own folder. Do not merge it into the shared repo working tree, and do not point the existing `com.qohfq.swing-paper` agent at it. That agent and `data/swing/` stay on the original strategy. This book uses strategy id `paper-lowcap-swing-liquidity` and directory `data/swing-liquidity`. Startup refuses a directory named `swing` and any ledger whose strategy id is different, so an old book is not marked, migrated, or appended.

```bash
# from the copied bundle root — Node 20 or newer
npm install
npm test
npm run offline          # fixture only; no network; no files written
# optional, public market data, writes only data/swing-liquidity (or SWING_DATA_DIR):
node scripts/paper.js --once
node scripts/paper.js        # loop
```

No `.env` is required. If a `.env` sits in the bundle root, only `SWING_*` keys are read. Wallet keys are neither required nor parsed.

`SWING_DATA_DIR` is honored. A relative value is resolved from this bundle root. The default is `<bundle>/data/swing-liquidity`. Setting it to a `.../data/swing` path throws before any write.

LaunchAgent template: `launchagent/com.qohfq.swing-paper-liquidity.plist.template`. Replace `__ISOLATED_ROOT__`. Do not `launchctl bootout` the old agent as part of installing this one.

Original sources are kept verbatim under `vendor/original-swing/` for reading and for the read-only Flap client. The vendored entry still pins `data/swing` and is not the process this bundle starts.

## What changed relative to the old paper rule

The old fill model (3% buy slip, 4% sell, +5% extra on stops, 0.25% fee per side) turns a +20% move above the fill into about **+14.62% net**, and a −15% stop under the fill into about **−23.04% net**. Those percentages are that model’s assumptions, re-derived in `test/original-cost-baseline.test.js`. They are not treated as measured BSC slippage.

This book’s take-profit is a **+20% net** identity under an explicit cost stack. A +20% spot print is not enough. See `docs/liquidity-swing.md` for the stack, the quote-versus-model split, and the defaults.

## Tests

```bash
npm test
node --test vendor/original-swing/test/swing-signal.test.js
```

`ethers` is only needed for live Flap reads (`src/swing-flap.js` in the vendor tree). Screening, ranking, the offline rehearsal, and the ledger guards do not need a network or an RPC.
