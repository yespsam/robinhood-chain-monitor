# 老盘重启 (old-token revival) — paper only

Strategy id `paper-old-revival`. Separate process (`scripts/old-revival-paper.js`, LaunchAgent `com.qohfq.old-revival-paper`),
separate ledger (`data/old-revival/{state.json,ledger.jsonl,signals.jsonl,status.json}`). It imports no live-trading module,
reads only `OLD_REVIVAL_*` keys from `.env` (no wallet / API secrets) and refuses to start with `OLD_REVIVAL_LIVE=true`.

Data: Binance meme-rush migrated list (protocol 2002) + GeckoTerminal trending/top-volume BSC pools (Flap vanity suffix 7777/8888)
for discovery; DexScreener batch snapshot per minute (price, vol m5/h1/h6/h24, txns, liquidity); GeckoTerminal hourly OHLCV
(ATH / drawdown / base); GoPlus (honeypot, tax, holder count; holders sampled every ~20 min, "rising" needs a 50min–6h old sample).

Entry (all must hold): age 12h–14d; liquidity ≥ $20k; mcap $30k–20M; ATH→trough drawdown ≥ 70% and price ≤ 50% of ATH and ≤ 3x trough;
6h base range ≤ 1.8x; vol spike 5m ≥ 3x or 1h ≥ 3x vs baseline, h1 vol ≥ $1.5k; buys ≥ 8 and buy ratio ≥ 0.55;
holders rising ≥ 1%; Binance netBuy > 0 when known; no wash (vol24/mcap ≤ 8, vol24/liq ≤ 40, tx per wallet ≤ 12, Binance wash tags);
no honeypot / tax > 5%. Smart-money / KOL holders are a logged bonus (OLD_REVIVAL_REQUIRE_SMART=true makes it a gate).

Paper execution: $20/trade, 5 positions, $200 virtual cash, 10 entries/day, 12h per-token cooldown; 2% (or size/liq-based) entry slippage,
3% exit slippage (+5% on stops), 0.25% fee/side. Exits: stop −15%; TP1 +40% sells 70% then stop moves to breakeven; trailing 30% from peak once
peak ≥ +70%; liquidity < 50% of entry; 24h max hold. Prices are polled every 60s (stops can gap).

Backtest (price/volume/chart gates only): `node scripts/old-revival-backtest.js [addr ...]`. Dry run: `node scripts/old-revival-paper.js --dry`.
Report: `cat data/old-revival/status.json`.
