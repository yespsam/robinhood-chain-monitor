# 低市值波段 (low-cap swing) — paper only

Strategy id `paper-lowcap-swing`. Separate process (`scripts/swing-paper.js`, LaunchAgent `com.qohfq.swing-paper`), separate ledger
(`data/swing/{state.json,ledger.jsonl,signals.jsonl,status.json,ohlcv/}`). It imports no live-trading module (no GMGN trade path, no wallet/keys),
reads only `SWING_*` keys from `.env` (none required: defaults live in `src/swing-signal.js`). `live` is hard-coded `false`;
`SWING_LIVE=true` (env or `.env`) makes the process exit(2) at start and `createSwing` throw. Nothing here can place an order.

Widened 2026-11-14 17:48 (user t182u): cap $1M→$3M, 24h vol $30k→$15k, DexScreener discovery added.

Why: a rough GeckoTerminal 5m backtest (see chat 2026-11-14) showed the plain high-volume swing loses to costs; the low-cap/-20% TP variant was
only positive at zero cost on ~43 trades. This runner collects real forward evidence at realistic meme costs before anything is considered for live.

Universe (BSC only): mcap (FDV if missing) $10k–$3M (status buckets: <300k, 300k–1M, 1M–3M), liquidity ≥ $10k, 24h vol ≥ $15k, 1h vol ≥ $5k, 24h vol/liq ≤ 60, quote USDT/WBNB/USDC/BNB/BUSD/FDUSD/USD1,
no stables/majors, one pool per token (deepest). Discovery every 15 min, primarily DexScreener (rotating `search` queries, token-profiles/boosts feeds); GeckoTerminal lists only every 30 min and skipped during 429 backoff;
DexScreener snapshot every 60 s (price, liquidity, vol, mcap; `flapsh` bonding-curve pairs skipped); GeckoTerminal is used for 5m OHLCV only (per eligible token every ≥5 min, 25 s budget/tick, mid-pullback tokens first, exponential 429 backoff, 404 pools retried after 1 h).
GoPlus (chain 56) checked only when a pullback signal fires: honeypot, cannot_buy, cannot_sell_all, buy/sell tax > 5% or unknown, closed source, hidden owner,
owner can change balance → skip. GoPlus error / no data → skip (fail closed) and `skip_security` is logged in `signals.jsonl`.

Entry: ≥ 30% (≤ 70%) below the 4h high of completed 5m bars, last bar green and closing above the previous close, last bar ≤ 15 min old,
live price within 10% of that close. Paper size $20, max 3 positions, 1h per-token cooldown, 8 entries/day (UTC+8 day).
Exit: TP +20% over fill, SL −15% under fill, max hold 24h, emergency exit if liquidity < 50% of entry liquidity. Prices polled every 60 s (stops can gap).
Costs (meme tier): buy slippage 3%, sell 4%, +5% extra on stops/liquidity exits, 0.25% fee per side; every close logs gross (price move only) and net.
Shadow metric: for each entry, whether +30% / +50% would have been reached before the −15% level or 24h (`type:"shadow"` in the ledger, rates in status).
OHLCV: completed 5m bars appended to `data/swing/ohlcv/<pool>.jsonl` as `[t_ms,o,h,l,c,v]` (1m not collected: extra API cost).

Live-promotion gate (information only, in `status.json` → `gate`): ≥ 14 days, ≥ 200 closed, avg net > +10%, TP hit rate > 60%,
both chronological halves net positive, ≥ 50% of traded tokens net positive, max drawdown < $30. `gate.allPass` must be true AND the user must decide; nothing flips automatically.

Run: `node scripts/swing-paper.js` (loop) · `--once` (one tick, writes) · `--dry` (one tick, no writes). Report: `cat data/swing/status.json`.
Backtest on collected candles: `node scripts/swing-backtest.js`. Tests: `node --test test/swing-signal.test.js`.
Stop: `launchctl bootout gui/$(id -u)/com.qohfq.swing-paper` (or `launchctl unload ~/Library/LaunchAgents/com.qohfq.swing-paper.plist`).

## 内盘 (Flap bonding curve) venue

Paper-only, Flap only (Four.meme not included). No trades, no keys, read-only BSC RPC (`eth_getLogs` / `eth_call` / Multicall3) + Chainlink BNB/USD.

- **Discovery / price series**: `src/swing-flap.js` ingests Flap Portal `TokenBought`/`TokenSold` events (6h backfill after each process start, cursor persisted in state.json) and aggregates `postPrice` into 5m USD bars (`data/swing/ohlcv/curve_<token>.jsonl`, rows `[t,o,h,l,c,v,bnbUsd]`, prices already in USD).
- **Local filter**: 1h volume ≥ $2000, buys ≥ 15, unique buyers ≥ 8, age ≥ 30 min (since first observed trade).
- **Chain state filter** (`getTokenV8Safe`): status = 1 (tradable curve), native-BNB quote, progress 20–90% of dex threshold, reserve ≥ $1500, curve fee ≤ 5%, mcap $10k–$3M, GoPlus fail-closed.
- **Dev-dump filter**: NOT implemented – no dev-wallet data in the read-only sources.
- **Entry/exit**: identical to dex (pullback ≥30% from 4h high + green close above prev close; TP +20%, shadow +30/+50%; SL −15%; max hold 24h; reserve < 50% of entry → emergency exit).
- **Costs**: slippage tiers 3% buy / 4% sell / +5% on stops, plus the Portal buy/sell fee per side read from chain (typ. 1%). After graduation the exit fee = dex fee + curve sell fee.
- **Graduation during a position**: logged, mark source switches to DexScreener price, venue stays `curve` in the ledger (`graduated: true`) so stats are attributable to the entry venue.
- **Stuck/unpriceable**: written off −100% after maxHold + 6h.
- **Limits**: max 3 concurrent positions shared by both venues (one venue can starve the other; separate caps are an option).
- **Reporting**: every position/ledger row has `venue` (curve|dex) and `bucket` (lt300k / 300k-1M / 1M-3M). status.json has `venueStats`, `byVenueBucket`, and the `curve` block (tokensInBook, active1h, localCandidates, eligible, rejection reasons).
