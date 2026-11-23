import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, evaluate, chartShape, volumeSpike, openPosition, exitDecision, isFlapAddress } from '../src/old-revival-signal.js';

const cfg = loadConfig({ OLD_REVIVAL_ENABLED: 'true' });
const bars = (arr) => arr.map((c, i) => ({ t: i * 3600e3, o: c, h: c * 1.02, l: c * 0.98, c, v: 1000 }));
// pump to 1.0, dump to 0.1, sideways ~0.1, last hour 0.11
const shape = bars([0.1, 0.4, 1.0, 0.6, 0.3, 0.12, 0.1, 0.1, 0.101, 0.1, 0.099, 0.1, 0.11]);
const good = () => ({ ageHours: 30, liquidityUsd: 60000, mcapUsd: 120000, vol: { m5: 900, h1: 4000, h6: 9000, h24: 30000 }, vol24: 30000,
  buys: 40, sells: 20, txPerWallet: 3, chart: chartShape(shape, cfg), holdersRisePct: 5, netBuyUsd: 500, smartHolders: 1, kolHolders: 0,
  security: { honeypot: false, cannotSellAll: false, buyTaxPct: 0, sellTaxPct: 0 } });

test('flap address suffix', () => { assert.ok(isFlapAddress('0x42c76d2665f97343469b1d22ce504dccabd97777')); assert.ok(!isFlapAddress('0x42c76d2665f97343469b1d22ce504dccabd91234')); });
test('good revival passes', () => { const r = evaluate(good(), cfg); assert.deepEqual(r.reasons, []); assert.ok(r.pass); assert.ok(r.bonus.includes('smart1')); });
test('wash trading rejected (猫螂-like)', () => { const f = good(); f.mcapUsd = 16000; f.vol24 = 1_080_000; f.vol.h24 = f.vol24; const r = evaluate(f, { ...cfg, minMcapUsd: 1 }); assert.ok(r.reasons.some(x => x.startsWith('wash'))); });
test('young token rejected', () => { const f = good(); f.ageHours = 5; assert.ok(evaluate(f, cfg).reasons.includes('age<12h')); });
test('low liquidity rejected', () => { const f = good(); f.liquidityUsd = 5000; assert.ok(!evaluate(f, cfg).pass); });
test('honeypot / tax rejected', () => { const f = good(); f.security = { honeypot: true, buyTaxPct: 0, sellTaxPct: 0 }; assert.ok(evaluate(f, cfg).reasons.includes('honeypot'));
  const g = good(); g.security.sellTaxPct = 12; assert.ok(evaluate(g, cfg).reasons.some(x => x.startsWith('tax'))); });
test('no volume spike rejected', () => { const f = good(); f.vol = { m5: 100, h1: 1800, h6: 9000, h24: 30000 }; assert.ok(evaluate(f, cfg).reasons.some(x => x.startsWith('no_spike'))); });
test('holders falling rejected; unknown rejected', () => { const f = good(); f.holdersRisePct = -3; assert.ok(!evaluate(f, cfg).pass); f.holdersRisePct = null; assert.ok(evaluate(f, cfg).reasons.includes('holders_unknown')); });
test('no deep drawdown rejected', () => { const f = good(); f.chart = chartShape(bars([0.5, 0.52, 0.55, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.55]), cfg); assert.ok(!evaluate(f, cfg).pass); });
test('volumeSpike math', () => { const s = volumeSpike({ m5: 600, h1: 1700, h6: 6200 }); assert.ok(Math.abs(s.r5 - 600 / 100) < 1e-9); assert.ok(Math.abs(s.r1 - 1700 / 900) < 1e-9); });
test('stop at -15%, tp1 70% then breakeven, trailing', () => {
  const p = openPosition({ price: 1, liquidityUsd: 100000, cfg, now: 0 });
  assert.ok(p.stopPrice < p.entryPrice * 0.86 && p.stopPrice > p.entryPrice * 0.84);
  assert.equal(exitDecision(p, { price: p.entryPrice * 0.8, liquidityUsd: 100000 }, cfg, 1000).reason, 'stop_loss');
  const t = exitDecision(p, { price: p.entryPrice * 1.41, liquidityUsd: 100000 }, cfg, 1000);
  assert.equal(t.reason, 'tp1'); assert.equal(t.fraction, 0.7);
  p.tp1Done = true; p.stopPrice = p.entryPrice; p.peak = p.entryPrice * 2;
  assert.equal(exitDecision(p, { price: p.entryPrice * 1.3, liquidityUsd: 100000 }, cfg, 1000).reason, 'trailing_stop');
  assert.equal(exitDecision(p, { price: p.entryPrice * 0.99, liquidityUsd: 100000 }, cfg, 1000).reason, 'breakeven_stop');
  assert.equal(exitDecision(openPosition({ price: 1, liquidityUsd: 1e5, cfg, now: 0 }), { price: 1, liquidityUsd: 1e5 }, cfg, 25 * 3600e3).reason, 'max_hold');
});
test('live flag defaults off and runtime refuses live', async () => {
  assert.equal(loadConfig({}).live, false); assert.equal(loadConfig({}).enabled, false);
  const { createOldRevival } = await import('../src/old-revival-paper.js');
  assert.throws(() => createOldRevival({ cfg: loadConfig({ OLD_REVIVAL_LIVE: 'true' }) }), /paper-only/);
});
