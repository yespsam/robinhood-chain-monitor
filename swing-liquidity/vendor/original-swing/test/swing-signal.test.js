import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, mcapBucket, universeCheck, securityCheck, pullbackSignal, openPosition, exitDecision, closeTrade, shadowStep, summarize, swingLiveRequested } from '../src/swing-signal.js';
import { createSwing } from '../src/swing-paper.js';
import { curveLocalCheck, curveStateCheck, breakdown } from '../src/swing-signal.js';
import { CurveBook, parseTrades } from '../src/swing-flap.js';

const cfg = loadConfig({});
const NOW = Date.UTC(2026, 10, 14, 8, 0, 0);
const mk = (t, o, c, h = Math.max(o, c) * 1.01, l = Math.min(o, c) * 0.99, v = 500) => ({ t, o, h, l, c, v });
// 4h of bars: spike to ~1.0 then sells off to ~0.6, then a green bar closing above prev close
const series = () => {
  const out = []; let t = NOW - 5 * 300e3 - 48 * 300e3;
  const closes = [0.5, 0.7, 0.95, 1.0, 0.9, 0.8, 0.7, 0.65, 0.62, 0.6, 0.58, 0.57];
  for (let i = 0; i < 40; i++, t += 300e3) out.push(mk(t, 0.55, 0.55));
  for (const c of closes) { out.push(mk(t, c * 1.02, c)); t += 300e3; }
  return { bars: out.slice(-48), t };
};
const withBounce = () => { const { bars } = series(); const last = bars[bars.length - 1], t = NOW - 300e3; bars.push(mk(t, last.c, last.c * 1.04)); return bars; };
const snap = () => ({ symbol: 'PEPE', quote: 'WBNB', mcapUsd: 300_000, liquidityUsd: 40_000, vol: { h1: 8000, h24: 120_000 } });

test('config: live hard-coded false, SWING_LIVE only flags refusal', () => {
  assert.equal(cfg.live, false); assert.equal(cfg.liveRequested, false);
  const c = loadConfig({ SWING_LIVE: 'true' }); assert.equal(c.live, false); assert.equal(c.liveRequested, true);
  assert.ok(swingLiveRequested({ SWING_LIVE: '1' })); assert.ok(!swingLiveRequested({}));
  assert.throws(() => createSwing({ cfg: c, dataDir: '/tmp/swing-test-never' }), /paper-only/);
});
test('defaults match spec', () => {
  assert.equal(cfg.pullbackPct, 30); assert.equal(cfg.tpPct, 20); assert.equal(cfg.slPct, 15); assert.equal(cfg.maxHoldHours, 24); assert.equal(cfg.sizeUsd, 20);
  assert.equal(cfg.maxPositions, 3); assert.equal(cfg.maxDailyEntries, 8); assert.equal(cfg.cooldownHours, 1);
  assert.equal(cfg.buySlippagePct, 3); assert.equal(cfg.sellSlippagePct, 4); assert.equal(cfg.stopExtraSlippagePct, 5); assert.equal(cfg.liqExitFraction, 0.5);
});
test('universe: good passes; thresholds reject', () => {
  assert.ok(universeCheck(snap(), cfg).ok);
  assert.ok(universeCheck({ ...snap(), mcapUsd: 4_000_000 }, cfg).reasons.includes('mcap_out_of_range'));
  assert.ok(universeCheck({ ...snap(), liquidityUsd: 5000 }, cfg).reasons.includes('liq_low'));
  assert.ok(universeCheck({ ...snap(), vol: { h1: 8000, h24: 10_000 } }, cfg).reasons.includes('vol24_low'));
  assert.ok(universeCheck({ ...snap(), vol: { h1: 1000, h24: 120_000 } }, cfg).reasons.includes('vol1h_low'));
  assert.ok(universeCheck({ ...snap(), liquidityUsd: 10_000, vol: { h1: 8000, h24: 900_000 } }, cfg).reasons.includes('wash:vol24/liq'));
  assert.ok(universeCheck({ ...snap(), quote: 'DOGE' }, cfg).reasons.some(r => r.startsWith('quote_')));
  assert.ok(universeCheck({ ...snap(), symbol: 'USDT' }, cfg).reasons.includes('stable_or_major'));
});
test('widened universe: $3M cap, $15k 24h vol, buckets', () => {
  assert.equal(cfg.maxMcapUsd, 3_000_000); assert.equal(cfg.minVol24Usd, 15_000); assert.equal(cfg.minLiquidityUsd, 10_000); assert.equal(cfg.minVol1hUsd, 5000); assert.equal(cfg.maxVolLiq24h, 60);
  assert.ok(universeCheck({ ...snap(), mcapUsd: 2_500_000, vol: { h1: 6000, h24: 16_000 } }, cfg).ok);
  assert.ok(!universeCheck({ ...snap(), vol: { h1: 6000, h24: 14_000 } }, cfg).ok);
  assert.ok(!universeCheck({ ...snap(), mcapUsd: 3_100_000 }, cfg).ok);
  assert.equal(mcapBucket(2e5), 'lt300k'); assert.equal(mcapBucket(5e5), '300k-1M'); assert.equal(mcapBucket(2e6), '1M-3M');
});
test('security: fail closed', () => {
  const ok = { honeypot: false, cannotBuy: false, cannotSellAll: false, buyTaxPct: 0, sellTaxPct: 1, openSource: true, hiddenOwner: false, ownerChangeBalance: false };
  assert.ok(securityCheck(ok, cfg).ok);
  assert.ok(!securityCheck(null, cfg).ok);
  assert.ok(securityCheck({ ...ok, honeypot: true }, cfg).reasons.includes('honeypot'));
  assert.ok(securityCheck({ ...ok, cannotSellAll: true }, cfg).reasons.includes('cannot_sell_all'));
  assert.ok(securityCheck({ ...ok, sellTaxPct: 6 }, cfg).reasons.some(r => r.startsWith('tax>')));
  assert.ok(securityCheck({ ...ok, buyTaxPct: null }, cfg).reasons.includes('tax_unknown'));
  assert.ok(securityCheck({ ...ok, openSource: false }, cfg).reasons.includes('closed_source'));
});
test('pullback signal: deep pullback + green bounce passes', () => {
  const r = pullbackSignal(withBounce(), cfg, NOW);
  assert.deepEqual(r.reasons, []); assert.ok(r.ok); assert.ok(r.pullbackPct >= 30);
});
test('pullback signal: rejects shallow, red bar, incomplete/stale bar, price drift', () => {
  const flat = Array.from({ length: 48 }, (_, i) => mk(NOW - (49 - i) * 300e3, 1, 1));
  assert.ok(pullbackSignal(flat, cfg, NOW).reasons.some(x => x.startsWith('pullback<')));
  const red = withBounce(); const l = red[red.length - 1]; red[red.length - 1] = { ...l, o: l.c * 1.02 }; assert.ok(pullbackSignal(red, cfg, NOW).reasons.includes('not_green'));
  assert.ok(pullbackSignal(withBounce(), cfg, NOW - 200e3).reasons.includes('last_bar_incomplete'));
  assert.ok(pullbackSignal(withBounce(), cfg, NOW + 3600e3).reasons.includes('bars_stale'));
  const b = withBounce(); assert.ok(pullbackSignal(b, cfg, NOW, b[b.length - 1].c * 1.3).reasons.includes('price_drift'));
  const dead = withBounce(); dead[10] = { ...dead[10], h: 100 }; assert.ok(pullbackSignal(dead, cfg, NOW).reasons.some(x => x.startsWith('pullback>')));
});
test('costs: entry fill +3%; tp at +20% over fill; stop -15% under fill', () => {
  const p = openPosition({ price: 1, liquidityUsd: 50_000, cfg, now: 0 });
  assert.ok(Math.abs(p.entryPrice - 1.03) < 1e-9); assert.ok(Math.abs(p.tpPrice - 1.03 * 1.2) < 1e-9); assert.ok(Math.abs(p.stopPrice - 1.03 * 0.85) < 1e-9);
  assert.equal(exitDecision(p, { price: 1.03 * 1.21, liquidityUsd: 50_000 }, cfg, 1000).reason, 'tp');
  assert.equal(exitDecision(p, { price: 1.03 * 0.84, liquidityUsd: 50_000 }, cfg, 1000).reason, 'stop_loss');
  assert.equal(exitDecision(p, { price: 1.03, liquidityUsd: 20_000 }, cfg, 1000).reason, 'liquidity_drop');
  assert.equal(exitDecision(p, { price: 1.03, liquidityUsd: 50_000 }, cfg, 24 * 3600e3 + 1).reason, 'max_hold');
  assert.equal(exitDecision(p, { price: 1.03, liquidityUsd: 26_000 }, cfg, 1000).type, 'hold');
});
test('closeTrade: net accounts slippage+fees; stop adds extra slippage', () => {
  const p = openPosition({ price: 1, liquidityUsd: 50_000, cfg, now: 0 });
  const tp = closeTrade(p, 1.03 * 1.2, false, cfg);   // +20% over fill => price 1.236 (raw +23.6% vs ref)
  const exp = p.qty * 1.236 * 0.96 * (1 - 0.0025) - 20;
  assert.ok(Math.abs(tp.netUsd - exp) < 1e-9); assert.ok(tp.grossPct > tp.netPct); assert.ok(tp.netPct > 10 && tp.netPct < 20);
  const sl = closeTrade(p, 1.03 * 0.85, true, cfg);
  assert.ok(sl.netPct < -20 && sl.netPct > -30); assert.ok(sl.fill < 1.03 * 0.85 * 0.92);
});
test('shadow: logs +30%/+50% hits, ends at stop or max hold', () => {
  const sh = { entryPrice: 1, stopPrice: 0.85, entryAt: 0, peak: 1, hits: {}, done: false };
  shadowStep(sh, 1.25, cfg, 10); assert.equal(sh.hits[30], undefined);
  shadowStep(sh, 1.31, cfg, 20); assert.equal(sh.hits[30], 20); assert.equal(sh.hits[50], undefined);
  shadowStep(sh, 0.8, cfg, 30); assert.ok(sh.done); assert.equal(sh.endedBy, 'stop');
});
test('summarize: metrics and live-gate progress', () => {
  const mkc = (i, netUsd, reason = 'tp', addr = 'a' + (i % 4)) => ({ addr, symbol: addr, netUsd, netPct: netUsd / 20 * 100, reason, closedAt: i * 1000 });
  const sm = summarize([mkc(1, 3), mkc(2, -4, 'stop_loss'), mkc(3, 3), mkc(4, 3)], 0, 3 * 86400e3, cfg);
  assert.equal(sm.closedCount, 4); assert.equal(sm.winRate, 0.75); assert.equal(sm.totalNetUsd, 5); assert.equal(sm.maxDrawdownUsd, 4);
  assert.equal(sm.tpHitRate, 0.75); assert.equal(sm.gate.allPass, false); assert.equal(sm.gate.days.ok, false); assert.equal(sm.gate.closed.ok, false);
  assert.equal(sm.gate.maxDdUsd.ok, true); assert.equal(sm.gate.bothHalvesPositive.ok, false);   // half1 = +3-4 = -1
  const none = summarize([], 0, 1000, cfg); assert.equal(none.winRate, null); assert.equal(none.gate.allPass, false);
  const many = Array.from({ length: 220 }, (_, i) => mkc(i, 3.5, 'tp', 't' + (i % 5)));
  const g = summarize(many, 0, 15 * 86400e3, cfg); assert.ok(g.gate.avgNetPct.value > 10); assert.equal(g.gate.allPass, true);
});

test('curve: local volume/buys/buyers/age filter', () => {
  const ok = { vol1hUsd: 5000, buys1h: 30, buyers1h: 12, ageMin: 45 };
  assert.ok(curveLocalCheck(ok, cfg).ok);
  assert.ok(curveLocalCheck({ ...ok, vol1hUsd: 1500 }, cfg).reasons.includes('c_vol1h_low'));
  assert.ok(curveLocalCheck({ ...ok, buys1h: 10 }, cfg).reasons.includes('c_buys_low'));
  assert.ok(curveLocalCheck({ ...ok, buyers1h: 5 }, cfg).reasons.includes('c_buyers_low'));
  assert.ok(curveLocalCheck({ ...ok, ageMin: 20 }, cfg).reasons.includes('c_too_young'));
});
test('curve: on-chain state filter (progress 20-90%, native BNB quote, reserve, fee, mcap)', () => {
  const cs = { status: 1, reserveBnb: 10, circ: 300e6, thresh: 800e6, priceBnb: 2e-7, quoteIsNative: true, taxBps: 100 };   // 37.5%, $6.2k reserve @620, mcap $124k
  const v = curveStateCheck(cs, 620, cfg);
  assert.ok(v.ok, v.reasons.join()); assert.ok(Math.abs(v.progressPct - 37.5) < 1e-9); assert.ok(Math.abs(v.mcapUsd - 124_000) < 1);
  assert.ok(curveStateCheck({ ...cs, circ: 100e6 }, 620, cfg).reasons.some(r => r.startsWith('c_progress')));
  assert.ok(curveStateCheck({ ...cs, circ: 700e6 }, 620, cfg).ok);
  assert.ok(curveStateCheck({ ...cs, circ: 750e6 }, 620, cfg).reasons.some(r => r.startsWith('c_progress')));
  assert.ok(curveStateCheck({ ...cs, status: 4 }, 620, cfg).reasons.includes('c_not_tradable_curve'));
  assert.ok(curveStateCheck({ ...cs, quoteIsNative: false }, 620, cfg).reasons.includes('c_quote_not_bnb'));
  assert.ok(curveStateCheck({ ...cs, reserveBnb: 1 }, 620, cfg).reasons.includes('c_reserve_low'));
  assert.ok(curveStateCheck({ ...cs, taxBps: 800 }, 620, cfg).reasons.includes('c_tax'));
  assert.ok(curveStateCheck({ ...cs, priceBnb: 1e-5 }, 620, cfg).reasons.includes('mcap_out_of_range'));
  assert.ok(!curveStateCheck(null, 620, cfg).ok);
});
test('curve: CurveBook aggregates trade ticks into 5m USD bars + 1h stats', () => {
  const b = new CurveBook(), T0 = Date.UTC(2026, 10, 14, 8, 0, 0), tok = '0x' + 'a'.repeat(40);
  const tr = [[0, 'b', 'u1', 1e-7, 1], [60e3, 'b', 'u2', 1.2e-7, 2], [120e3, 's', 'u1', 0.9e-7, 1], [300e3, 'b', 'u3', 1.1e-7, 1]]
    .map(([dt, side, trader, price, quote], i) => ({ blk: i, li: 0, t: T0 + dt, side, token: tok, trader, quote, fee: 0, price }));
  b.ingest(tr, 600);
  const bars = b.bars(tok); assert.equal(bars.length, 2);
  assert.ok(Math.abs(bars[0].o - 6e-5) < 1e-12 && Math.abs(bars[0].h - 7.2e-5) < 1e-12 && Math.abs(bars[0].l - 5.4e-5) < 1e-12 && Math.abs(bars[0].c - 5.4e-5) < 1e-12);
  assert.ok(Math.abs(bars[0].v - 4 * 600) < 1e-6); assert.equal(bars[0].fx, 600);
  const s = b.stats(tok, T0 + 400e3); assert.equal(s.buys1h, 3); assert.equal(s.sells1h, 1); assert.equal(s.buyers1h, 3); assert.ok(Math.abs(s.ageMin - 400 / 60) < 1e-9);
  b.prune(T0 + 2 * 3600e3); assert.equal(b.stats(tok, T0 + 2 * 3600e3).buys1h, 0);
  b.prune(T0 + 9 * 3600e3); assert.equal(b.size(), 0);
  assert.deepEqual(parseTrades([]), []);
});
test('curve: openPosition/closeTrade use venue fees; breakdown groups by venue and bucket', () => {
  const p = openPosition({ price: 1, liquidityUsd: 8000, cfg, now: 0, venue: 'curve', feePct: 1, exitFeePct: 1 });
  assert.equal(p.venue, 'curve'); assert.ok(Math.abs(p.entryFeeUsd - 0.2) < 1e-9); assert.equal(p.exitFeePct, 1);
  const r = closeTrade(p, 1.03 * 1.2, false, cfg); assert.ok(Math.abs(r.netUsd - (p.qty * 1.236 * 0.96 * 0.99 - 20)) < 1e-9);
  const bd = breakdown([{ venue: 'curve', bucket: 'lt300k', netUsd: 3, netPct: 15, reason: 'tp' }, { venue: 'curve', bucket: 'lt300k', netUsd: -4, netPct: -20, reason: 'stop_loss' }, { venue: 'dex', bucket: '1M-3M', netUsd: 2, netPct: 10, reason: 'tp' }]);
  assert.equal(bd.byVenue.curve.n, 2); assert.equal(bd.byVenue.curve.winRate, 0.5); assert.equal(bd.byVenue.dex.totalNetUsd, 2); assert.equal(bd.byVenueBucket['curve/lt300k'].n, 2); assert.equal(bd.byBucket['1M-3M'].tpHitRate, 1);
});
