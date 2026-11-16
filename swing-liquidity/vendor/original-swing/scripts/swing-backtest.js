#!/usr/bin/env node
// Read-only backtest of the 低市值波段 rules on the 5m candles persisted by the paper runner (data/swing/ohlcv/*.jsonl).
// No orders, no writes except stdout. Price/volume gates only (universe + GoPlus cannot be reconstructed historically).
// usage: node scripts/swing-backtest.js [ohlcvDir]
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, pullbackSignal, openPosition, exitDecision, closeTrade, summarize } from '../src/swing-signal.js';
const cfg = loadConfig({});
const dir = process.argv[2] || path.resolve('data', 'swing', 'ohlcv');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')) : [];
const closed = [];
for (const f of files) {
  const rows = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const m = new Map(rows.map(r => [r[0], { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }]));
  const bars = [...m.values()].sort((a, b) => a.t - b.t); if (bars.length < 60) continue;
  let pos = null, cool = 0;
  for (let i = 50; i < bars.length; i++) {
    const b = bars[i], now = b.t + 300e3;
    if (pos) {                                   // stop first (conservative), then tp, then time
      for (const px of [b.l, b.h, b.c]) {
        const d = exitDecision(pos, { price: px, liquidityUsd: 0 }, cfg, now); if (d.type !== 'sell') continue;
        const r = closeTrade(pos, px, d.stop, cfg);
        closed.push({ addr: f, symbol: f.slice(0, 8), netUsd: r.netUsd, netPct: r.netPct, reason: d.reason, closedAt: now }); pos = null; cool = now + cfg.cooldownHours * 3600e3; break;
      }
      continue;
    }
    if (now < cool) continue;
    const sig = pullbackSignal(bars.slice(Math.max(0, i - 60), i + 1), cfg, now + 60e3);
    if (sig.ok) pos = { ...openPosition({ price: b.c, liquidityUsd: 0, cfg, now }), at: now };
  }
}
const sm = summarize(closed, closed.length ? Math.min(...closed.map(c => c.closedAt)) : Date.now(), Date.now(), cfg);
console.log(`files=${files.length} trades=${sm.closedCount} win=${sm.winRate} avgNet=${sm.avgNetPct}% totalNet=${sm.totalNetUsd}U maxDD=${sm.maxDrawdownUsd}U tpHit=${sm.tpHitRate} tokens+=${sm.tokensPositive}/${sm.tokensTraded}`);
