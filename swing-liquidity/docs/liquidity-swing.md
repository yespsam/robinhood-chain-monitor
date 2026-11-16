# Liquidity-first paper swing

Strategy id: `paper-lowcap-swing-liquidity`. Mode: paper. Orders: none. Wallet: none.

The previous paper rule bought a low-cap name after a 30–70% drop from the 4h wick high plus one green 5m close. On the cost model shipped with that rule, the +20% take-profit above the slipped fill nets about +14.62%, and the −15% stop under the fill nets about −23.04% after the extra stop slip. A reported forward sample of 13 DEX closes (3 wins, 10 losses, about −55.47U) is the reason this variant exists. That ledger was not in the input pack, so those 13 rows are **not** reproduced here and were **not** used to tune thresholds. A 13-trade sample would be a poor fit set even if it were present.

Nothing in this document is a forecast.

## Selection

A name has to clear every hard gate. Volume does not buy an exception for a thin pool. Among names that also pass the swing check, the order key is:

`0.45 * impact quality + 0.35 * depth quality + 0.20 * (side balance × candle persistence)`

Raw 24h volume is not in the score. Depth quality is `log10(liquidity / $20)`, scaled for display around 1,000× the clip. That scale is only an ordering normalizer. The hard floor is separate: reported liquidity must be at least `max($25,000, 1,250 × $20)` = **$25,000**, and estimated impact of the $20 clip must be at most **1%**.

Under the DEX reserve assumption below, a pool that clears $25,000 has modeled impact of about 0.23% or less, so the $25,000 floor is what rejects ordinary shallow DEX pools. The 1% cap is the backstop for an executable quote or an observed quote reserve that is worse than that assumption. A busy pool with $8,000 of liquidity and a very large 24h volume fails `liq_low` (and usually `wash_vol_liq`). A pool that *reports* deep liquidity but carries an executable impact above 1% fails `impact_high`, and a stale or one-sided executable quote is not replaced with the rosy figure.

### Quote-backed versus model

| Source | When | Label |
|---|---|---|
| Executable buy and sell impact, both finite and at most `maxSnapAgeSec` old | Caller supplied a real quote | `executable_quote`, quote-backed |
| Positive observed quote reserve (Flap BNB reserve × BNB/USD) | Curve state is fresh | `observed_quote_reserve`, quote-backed |
| Reported total liquidity × `quoteReserveFraction` (default **0.35**) | DEX row has liquidity and no executable quote | `reported_liquidity_fraction`, **model assumption, not a quote** |

`0.35` is tighter than “half a balanced pool.” Reported DexScreener liquidity is not a quote reserve, and low-cap pools are often skewed. It is an assumption. Constant-product impact for a clip of size `q` against quote reserve `y` is `q / y`, which is the no-fee execution-versus-spot result. It is not a router simulation unless an executable quote was actually passed in.

Missing, zero, stale, or partial data fails the name. The code does not fill in a reserve, a price, or a two-sided print.

### Activity has to show up on more than one window

All of these are required on a DEX snapshot, and each one can fail on its own:

- 24h volume ≥ $20,000, 6h ≥ $8,000, 1h ≥ $4,000
- 24h volume / liquidity ≤ 40
- 1h trades ≥ 12 buys and ≥ 12 sells; 6h ≥ 40 and ≥ 40
- On both the 1h and the 6h window, `min(buys, sells) / max(buys, sells) ≥ 0.35`
- Trade counts present. Missing `txns.h1` or `txns.h6` is `no_trade_counts`, not a pass
- Snapshot receipt younger than 90s, positive price, quote in the USDT/WBNB/USDC/BNB/BUSD/FDUSD/USD1 set, base not a stable or major
- Market cap, or FDV when cap is absent, from $10,000 through **$3,000,000**

Candle persistence is a second check, not a substitute for trade counts: at least 8 of the last 12 closed 5m bars have volume, and that window contains both a green and a red bar.

These counts will skip quiet markets. That is intentional. They were not measured as the profit-maximizing cut.

## Swing confirmation

Closed 5m bars only. The reference high is the **maximum close** in the lookback, so a long wick cannot create the dip. The wick is still reported as `wickOverClosePct`.

- At least 48 closed bars, covering 4h from the open of the first included bar through the close of the last (48 × 5 minutes).
- Inside that window, at most one missing 5m bar in total, and no single hole larger than one bar. A larger hole is `history_gap` even if some other reason also fires. Two holes fail. Bars are not synthesized.
- Last closed bar finished within 10 minutes. Live price present and within 5% of that close.
- Pullback of the last close from the close-high is **8% to 35%**. Below 8% is not treated as a swing. Above 35% is the crash zone the old 30–70% rule lived in. A 30% dip can still pass, but only after the recent-bar checks below. The band is a design choice, not a fitted edge.
- The close-high is at least 6 bars (30 minutes) behind the last bar.
- Over the last 6 closes, the drop from the local max to the last close is at most 6%, and the last close is at least 1.5% above the local min. The last bar is green and closes above the previous close. This is what refuses a falling knife that has not actually turned.
- Last bar volume is positive and at most 8× the median of the prior positive bars in the 12-bar window.

## Costs and the +20% net target

Paper quantity is `size / (spot × (1 + appliedBuy/100))` with `size = $20`. There is no second cash fee on top, so the pieces below are not charged twice.

`appliedBuy = impact + known buy tax or curve fee + lp fee + model cushion buy`

`appliedSell = impact + known sell tax or curve fee + lp fee + model cushion sell`

- Known token tax (GoPlus) or the Flap portal fee is required. Unknown tax is a skip.
- LP fee is the venue value when the venue reports one. Flap passes `0` here because the portal fee is already the known fee. A DEX row does not invent a measured LP fee: it adds **0.25% labeled `lpFeeSource: "model"`**, the usual v2-shaped allowance, not a reading of the pool’s fee tier.
- Model cushions default to **0.80% buy and 1.20% sell**. They are an allowance for latency and for the reserve assumption being wrong. They are not a measurement, and they are not the old 3/4/9 slips.
- Defensive exits (stop, liquidity drop, impact through the cap, unsellable) add a further **0.50%** model stop cushion.

The stored take-profit spot is the price at which this same stack nets +20% of the $20:

`spotTP / spot = 1.20 × (1 + appliedBuy/100) / (1 − appliedSell/100)`

At that price, net is +20% by identity. It is not evidence the price will get there. A later exit recomputes the sell impact from a **fresh** reserve or quote. Take-profit is allowed only when that fresh impact is still inside the 1% cap and the fresh stack still nets at least +20%. If the spot is through the stored target but the fresh impact is missing, the position is held (`tp_blocked_no_fresh_impact`) rather than booked as a win. If fresh impact is over the cap, the exit reason is `impact_widened`, which is a risk exit.

Examples (identity, not a backtest), $20 clip:

| Situation | Impact source | Applied buy / sell | Spot move that nets +20% | Net if spot is only +20% |
|---|---|---|---|---|
| $100k reported liquidity, 1% known tax each side, model 0.25% LP | fraction 0.35 (model) | 2.11% / 2.51% | +25.68% | about +14.58% |
| $200k reported, 0% buy tax, 1% sell tax, model LP | fraction 0.35 (model) | 1.08% / 2.48% | +24.38% | about +15.78% |
| $12k observed curve reserve, 1% portal fee each side, no extra LP | observed reserve (quote-backed) | 1.97% / 2.37% | +25.33% | about +14.90% |

The stop is a **spot** rule: exit when price ≤ entry spot × (1 − 12%). Modeled net at that stop is worse than −12% because the sell stack and the stop cushion still apply. The −12% figure is not a net-loss promise and not a measured gap.

Gross on a close is the spot move on the $20. Net is proceeds after the sell stack, minus $20. Both are written on the ledger line, with `impactSource`, `quoteBacked`, `modelReserveAssumption`, and `lpFeeSource`.

## Repeated names

- One open position per token. A second signal while it is open is `duplicate`.
- Any close starts a cooldown. A take-profit or time exit uses **4h**. A stop, liquidity drop, impact widening, or unsellable writeoff uses **12h**.
- Two stop-like exits on the same token inside **24h** set a **24h** knife ban. The old 1h cooldown is what allowed the same name to be stopped again; this book does not copy that.
- At most **6** new entries per UTC+8 day, and at most **3** open positions. DEX and curve share the three slots. One venue can fill the book. That starvation is left visible rather than papered over with a second hidden cap.
- Max hold **18h**. If a position still has no fresh price `18h + 6h` after entry, it is written off at **−100% net** with null gross. No substitute price is used. An explicit “cannot sell” verdict is the same writeoff, not a last-print profit.

## Flap curve

The vendored reader is still the read-only Portal log / `getTokenV8Safe` / Chainlink path. No key and no transaction.

A curve candidate needs fresh chain state (90s), a positive BNB/USD print, tradable status, native BNB quote, progress 20–90%, portal fee known and ≤ 5%, reserve ≥ **$8,000** (a $20 clip is then 0.25% of that reserve), and cap inside the same $10k–$3M band. Activity over the ingested trades must show 1h volume ≥ $3,000, ≥ 12 buys, ≥ 8 sells, ≥ 8 buyers, ≥ 5 sellers, both sides within the 0.35 ratio, ≥ 4 active 5m bars in the hour, and age ≥ 45 minutes. The same candle confirmation as DEX then applies.

If the oracle, the log scan, or `getTokenV8Safe` fails, the status `curve` block carries the error and **no curve entry is invented**. A missing reserve stays `c_no_state` / `c_reserve_low`. There is still no dev-wallet dump filter; the read-only sources do not provide one.

After graduation, a position is marked from a real DexScreener row when one exists. If the curve is no longer tradable and no DEX price is present, the position is unpriced rather than assigned a graduation price. The DEX leg then uses the model LP allowance. The curve sell fee already stored on the position remains the known fee.

## Safety that this bundle does not touch

`src/live-entry-gates.js` and the rest of the live/paper mirror are not modified and not imported. `gate.allPass` in this book’s status is informational. `authorizesLive` is false even when every informational check would pass. `SWING_LIVE=true` throws before a tick and the entry exits 2.

GoPlus is fail-closed: missing object, non-boolean honeypot / sellability flags, unknown tax, unknown or closed source, hidden owner, or owner-can-change-balance skips the entry. A GoPlus error is a skip, not a pass.

## Defaults worth not pretending are optimal

| Knob | Default | Why it is here | What it does not mean |
|---|---|---|---|
| `MIN_LIQ_USD` / `MIN_LIQ_TO_SIZE` | $25,000 / 1,250× | $20 is a small fraction of the pool | A measured “safe” size |
| `QUOTE_RESERVE_FRACTION` | 0.35 | Conservative share of *reported* liquidity | An executable quote |
| `MAX_IMPACT_PCT` | 1 | Reject a quote or reserve that moves the $20 clip more than this | The DEX floor; $25k already implies ~0.23% under the 0.35 assumption |
| `MIN_BUYS_*` / `MIN_SELLS_*` / `MIN_SIDE_RATIO` | 12/12 and 40/40, ratio 0.35 | Two windows, both sides | A fitted flow signal |
| `PULLBACK_MIN_PCT` / `MAX` | 8 / 35 | Swing, not a 30% knife requirement | An optimized entry |
| `MAX_RECENT_DROP_PCT` | 6 over 6 closes | The dip has stopped extending | A reversal model |
| `TARGET_NET_PCT` | 20 | The requested net room, after the stack above | A hit rate |
| `SL_SPOT_PCT` | 12 | Spot invalidation, tighter than the old −15% under an already-slipped fill | Net loss of exactly 12% |
| `MODEL_CUSHION_*` / `MODEL_LP_FEE_PCT` / `MODEL_STOP_CUSHION_PCT` | 0.80 / 1.20 / 0.25 / 0.50 | Labeled uncertainty | Measured slippage |
| `COOLDOWN_HOURS` / `STOP_COOLDOWN_HOURS` / knife | 4 / 12 / 2 stops in 24h → 24h ban | Do not rebuy the same stop | A guarantee against a third loss later |
| `SIZE_USD` / `MAX_POSITIONS` | 20 / 3 | Same paper sizing as the old book | Live size |

Environment overrides use the `SWING_` prefix (`SWING_MIN_LIQ_USD`, and the rest of the names in `loadConfig`). Changing them does not turn on live trading. The sizing defaults are the ones this paper book is meant to run with.

## Files

- `src/liquidity-signal.js` — gates, ranking, candle checks, cost identity, ledger guard
- `src/liquidity-paper.js` — paper runtime. Public HTTP only when `tick()` is called without an injected market
- `src/offline-fixture.js` — deterministic rehearsal
- `scripts/paper.js` — entry. Honors `SWING_DATA_DIR`
- `scripts/backtest.js` — replays candles only when a sibling `*.jsonl.meta.json` supplies liquidity or a quote reserve. Otherwise the file is skipped
- `vendor/original-swing/` — verbatim previous paper sources, including the Flap reader
