#!/usr/bin/env node
// Read-only candle replay. Refuses to invent liquidity or a quote.
// A file is replayed only when a sibling `<name>.meta.json` supplies liquidityUsd or quoteReserveUsd.
// Usage: node scripts/backtest.js [ohlcvDir]
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, swingConfirm, openPosition, exitDecision, closeTrade, costEstimate, summarize } from '../src/liquidity-signal.js';

const cfg = loadConfig(process.env);
const dir = process.argv[2] || path.resolve('data', 'swing-liquidity', 'ohlcv');
if (!fs.existsSync(dir)) {
  console.log(JSON.stringify({ files: 0, skipped: 0, trades: 0, note: 'no ohlcv directory; nothing invented' }));
  process.exit(0);
}
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
const closed = [];
let skipped = 0;
const skipReasons = {};
for (const f of files) {
  const metaPath = path.join(dir, `${f}.meta.json`);
  if (!fs.existsSync(metaPath)) { skipped++; skipReasons.no_liquidity_metadata = (skipReasons.no_liquidity_metadata || 0) + 1; continue; }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const now0 = Date.now();
  const cost = costEstimate({
    totalLiquidityUsd: meta.quoteReserveUsd == null ? meta.liquidityUsd : undefined,
    quoteReserveUsd: meta.quoteReserveUsd,
    knownBuyFeePct: meta.buyFeePct,
    knownSellFeePct: meta.sellFeePct,
    knownLpFeePct: meta.lpFeePct,
  }, cfg, now0);
  if (!cost.ok) { skipped++; skipReasons[cost.reasons[0] || 'cost'] = (skipReasons[cost.reasons[0] || 'cost'] || 0) + 1; continue; }
  const rows = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const bars = [...new Map(rows.map(r => [r[0], { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }])).values()].sort((a, b) => a.t - b.t);
  let pos = null;
  let cool = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const now = b.t + 300_000;
    if (pos) {
      const obs = { price: b.l, at: now, stale: false, liquidityUsd: meta.liquidityUsd ?? meta.quoteReserveUsd, impactPct: cost.impactPct, impactSellPct: cost.impactSellPct, impactFresh: true, sellable: true };
      const d = exitDecision(pos, obs, cfg, now);
      const obs2 = d.type === 'sell' ? obs : { ...obs, price: b.h };
      const d2 = d.type === 'sell' ? d : exitDecision(pos, obs2, cfg, now);
      const use = d.type === 'sell' ? { d, px: b.l } : d2.type === 'sell' ? { d: d2, px: b.h } : null;
      if (use) {
        const stop = !!use.d.stop;
        const sellPct = (cost.appliedSellPct ?? 0) + (stop ? cfg.modelStopCushionPct : 0);
        const r = use.d.writeoff ? closeTrade(pos, 0, null, { writeoff: true }) : closeTrade(pos, use.px, sellPct);
        closed.push({ addr: f, symbol: f.slice(0, 8), netUsd: r.netUsd, netPct: r.netPct ?? -100, reason: use.d.reason, closedAt: now });
        pos = null;
        cool = now + (stop ? cfg.stopCooldownHours : cfg.cooldownHours) * 3600e3;
      }
      continue;
    }
    if (now < cool) continue;
    const sig = swingConfirm(bars.slice(0, i + 1), cfg, now + 1000, b.c);
    if (!sig.ok) continue;
    pos = openPosition({ spot: b.c, cost, cfg, now, liquidityUsd: meta.liquidityUsd ?? meta.quoteReserveUsd });
  }
}
const sm = summarize(closed, closed.length ? Math.min(...closed.map(c => c.closedAt)) : Date.now(), Date.now(), cfg);
console.log(JSON.stringify({ files: files.length, skipped, skipReasons, trades: sm.closedCount, winRate: sm.winRate, avgNetPct: sm.avgNetPct, totalNetUsd: sm.totalNetUsd, note: 'replay is not evidence of future profit; files without liquidity metadata were skipped' }, null, 1));
