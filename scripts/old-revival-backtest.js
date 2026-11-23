#!/usr/bin/env node
// Read-only backtest of the 老盘重启 signal on GeckoTerminal 5m/1h candles. No orders, no writes except stdout.
// Price/volume/chart gates only: buy-ratio, holders, net-buy, security, wash-by-wallet cannot be reconstructed historically.
// usage: node scripts/old-revival-backtest.js [addr ...]   (default: today's examples + Binance migrated Flap list older than 12h)
import { loadConfig, chartShape, evaluate, openPosition, exitDecision, sellProceeds, volumeSpike } from '../src/old-revival-signal.js';
import { binanceMigrated, dexSnapshot } from '../src/old-revival-paper.js';
const cfg = loadConfig({ ...process.env, OLD_REVIVAL_ENABLED: 'true' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gt = async url => { for (let i = 0; i < 4; i++) { const r = await fetch(url, { headers: { accept: 'application/json' } }); if (r.status === 429) { await sleep(20000); continue; } if (!r.ok) throw new Error(r.status); await sleep(2300); return r.json(); } throw new Error('429'); };
const bj = t => new Date(t + 8 * 3600e3).toISOString().replace('T', ' ').slice(5, 16) + ' UTC+8';
const EX = ['0x42c76d2665f97343469b1d22ce504dccabd97777', '0x0b35285fe783dd3441573b84be4fbdb743457777', '0xb84a69219443d278bbab801ba19380eee6cc7777'];
let addrs = process.argv.slice(2).map(a => a.toLowerCase());
const mig = await binanceMigrated().catch(() => []);
if (!addrs.length) addrs = [...EX, ...mig.filter(t => Date.now() - (t.createdAt || 0) > cfg.minAgeHours * 3600e3).map(t => t.addr).filter(a => !EX.includes(a)).slice(0, Number(process.env.BT_EXTRA || 12))];
const snaps = await dexSnapshot(addrs);
const bars5 = async pool => { let all = []; let before = Math.floor(Date.now() / 1000) + 600;
  for (let i = 0; i < 2; i++) { const j = await gt(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${pool}/ohlcv/minute?aggregate=5&limit=1000&before_timestamp=${before}&currency=usd`);
    const l = (j?.data?.attributes?.ohlcv_list || []); if (!l.length) break; all = all.concat(l); before = Math.min(...l.map(r => r[0])); if (l.length < 900) break; }
  const m = new Map(all.map(r => [r[0], r])); return [...m.values()].sort((a, b) => a[0] - b[0]).map(r => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] })); };
const barsH = async pool => (await gt(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${pool}/ohlcv/hour?aggregate=1&limit=1000&currency=usd`)).data.attributes.ohlcv_list
  .map(r => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] })).sort((a, b) => a.t - b.t);
const rows = [];
for (const a of addrs) {
  const s = snaps.get(a); if (!s) { console.log(a, 'no pancake pair'); continue; }
  const b = mig.find(t => t.addr === a);
  const created = b?.createdAt || s.pairCreatedAt;
  let m5, h1; try { m5 = await bars5(s.pair); h1 = await barsH(s.pair); } catch (e) { console.log(s.symbol, 'fetch fail', e.message); continue; }
  // zero-volume candles are omitted by GT -> treat gaps as zero volume
  const step = 300e3, t0 = m5[0].t, tEnd = m5[m5.length - 1].t; const by = new Map(m5.map(x => [x.t, x]));
  const grid = []; let lastC = m5[0].o;
  const tFinal = Math.floor(Date.now()/step)*step - step; for (let t = t0; t <= tFinal; t += step) { const x = by.get(t); if (x) { grid.push(x); lastC = x.c; } else grid.push({ t, o: lastC, h: lastC, l: lastC, c: lastC, v: 0 }); }
  const mcapPerPx = s.mcapUsd / s.price;
  const hourlyBefore = h1.filter(x => x.t + 3600e3 <= t0);
  let pos = null, cool = 0; const trades = []; const triggers = [];
  for (let i = 72; i < grid.length; i++) {
    const bar = grid[i], now = bar.t + step;
    if (pos) {
      let acted = false;
      for (const px of [bar.l, bar.h, bar.c]) {
        const d = exitDecision(pos, { price: px, liquidityUsd: 0 }, cfg, now); pos.peak = d.peak;
        if (d.type !== 'sell') continue;
        const fillPrice = d.reason.includes('stop') ? Math.min(pos.stopPrice, bar.o) * (1 - (cfg.exitSlippagePct + cfg.stopExtraSlippagePct) / 100) : d.fillPrice;
        const q = pos.qtyOpen * d.fraction; pos.qtyOpen -= q; pos.proceedsUsd += sellProceeds(q, fillPrice, cfg);
        if (d.reason === 'tp1') { pos.tp1Done = true; pos.stopPrice = pos.entryPrice; }
        if (d.fraction === 1 || pos.qtyOpen < 1e-12) { trades.push({ entry: pos.at, exit: now, reason: d.reason, pnlPct: (pos.proceedsUsd / pos.costUsd - 1) * 100, tp1: pos.tp1Done }); pos = null; cool = now + cfg.cooldownHours * 3600e3; acted = true; break; }
      }
      if (acted || pos) continue;
    }
    if (pos || now < cool) continue;
    const sum = (n) => { let x = 0; for (let k = Math.max(0, i - n + 1); k <= i; k++) x += grid[k].v; return x; };
    const vol = { m5: grid[i].v, h1: sum(12), h6: sum(72), h24: sum(288) };
    const price = bar.c;
    const hourStart = Math.floor(bar.t / 3600e3) * 3600e3; const rs = new Map();
    for (const g of grid.slice(0, i + 1)) { const hs = Math.floor(g.t / 3600e3) * 3600e3; if (hs > hourStart) break; const r = rs.get(hs); if (!r) rs.set(hs, { t: hs, o: g.o, h: g.h, l: g.l, c: g.c, v: g.v }); else { r.h = Math.max(r.h, g.h); r.l = Math.min(r.l, g.l); r.c = g.c; r.v += g.v; } }
    const chart = chartShape([...hourlyBefore, ...rs.values()].sort((x, y) => x.t - y.t), cfg);
    const f = { ageHours: (now - created) / 3600e3, liquidityUsd: s.liquidityUsd * Math.min(1, price / s.price + 0.5), mcapUsd: price * mcapPerPx, vol, vol24: vol.h24,
      buys: 100, sells: 0, txPerWallet: null, chart, holdersRisePct: 100, netBuyUsd: null, smartHolders: 0, kolHolders: 0, security: { honeypot: false, buyTaxPct: 0, sellTaxPct: 0 } };
    const ev = evaluate(f, cfg);
    if (process.env.BT_DIAG && i % 12 === 0) console.log(`   ${bj(now)} px=${price.toPrecision(3)} r5=${ev.spike.r5.toFixed(1)} r1=${ev.spike.r1.toFixed(1)} dd=${chart.ok?chart.maxDrawdownPct.toFixed(0):"-"}% toATH=${chart.ok?chart.priceToAth.toFixed(2):"-"} reb=${chart.ok?chart.reboundFromLow.toFixed(1):"-"} base=${chart.ok?chart.baseRange.toFixed(2):"-"} liq=${f.liquidityUsd.toFixed(0)} :: ${ev.reasons.join(",")}`);
    if (ev.pass) { triggers.push({ at: now, price, r5: ev.spike.r5, r1: ev.spike.r1, dd: chart.maxDrawdownPct }); pos = { ...openPosition({ price, liquidityUsd: f.liquidityUsd, cfg, now }), at: now }; }
  }
  const tEndReal = grid[grid.length-1].t; const dd = (() => { const ch = chartShape([...hourlyBefore, ...h1.filter(x => x.t >= t0)], cfg); return ch.ok ? `ATH->low ${ch.maxDrawdownPct.toFixed(0)}%, now/ATH ${ch.priceToAth.toFixed(2)}` : ch.reason; })();
  console.log(`\n${s.symbol} ${a} age=${((Date.now() - created) / 3600e3).toFixed(0)}h window=${bj(grid[72]?.t)}→${bj(tEndReal)} | ${dd}`);
  if (!triggers.length) console.log('  no trigger'); 
  for (const t of triggers) console.log(`  TRIGGER ${bj(t.at)} px=${t.price.toPrecision(4)} r5=${Number.isFinite(t.r5) ? t.r5.toFixed(1) : 'inf'} r1=${Number.isFinite(t.r1) ? t.r1.toFixed(1) : 'inf'} dd=${t.dd.toFixed(0)}%`);
  for (const t of trades) console.log(`  TRADE ${bj(t.entry)} → ${bj(t.exit)} ${t.reason} pnl=${t.pnlPct.toFixed(1)}%${t.tp1 ? ' (tp1 hit)' : ''}`);
  if (pos) console.log(`  OPEN at end, pnl≈${((pos.qtyOpen * grid[grid.length - 1].c + pos.proceedsUsd) / pos.costUsd * 100 - 100).toFixed(1)}%`);
  rows.push({ s: s.symbol, triggers: triggers.length, trades });
}
const all = rows.flatMap(r => r.trades);
console.log(`\n== ${rows.length} tokens, ${rows.reduce((a, r) => a + r.triggers, 0)} triggers, ${all.length} closed trades, avg pnl ${(all.reduce((a, t) => a + t.pnlPct, 0) / (all.length || 1)).toFixed(1)}%, wins ${all.filter(t => t.pnlPct > 0).length}`);
