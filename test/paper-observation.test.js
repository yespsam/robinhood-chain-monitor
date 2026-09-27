import test from 'node:test';
import assert from 'node:assert/strict';
import { observationSample } from '../scripts/observe-paper-runtime.js';
const now = Date.parse('2026-09-22T08:30:00Z');
const state = () => ({ mode: 'paper', execution: false, signing: false, broadcast: false, status: 'ok', enabled: true,
  account: { cash: 99, realizedPnl: -1, trades: [{ id: 'old', side: 'buy' }, { id: 'new', side: 'sell', price: .5 }], positions: {} },
  evaluations: [{ token: { chain: 'base', address: 'a', price: 1 }, missing: ['新鲜且足够的 K 线'], reasons: [], evidence: {
    flowFresh: true, flow: { netBuyUsd: 300, uniqueBuyerCount: 2 }, safety: { missing: [], blocked: [] } } }],
  chainCoverage: { base: { market: { status: 'ok', observedAt: new Date(now - 130000).toISOString() },
    flow: { status: 'healthy', complete: true, fresh: true, observedAt: new Date(now - 1000).toISOString() } } } });
test('observation preserves account and deduplicates known fills without fabricating prices or coverage', () => {
  const s = state(), original = structuredClone(s), sample = observationSample(s, now, new Set(['old']));
  assert.deepEqual(s, original); assert.equal(sample.newTrades.length, 1); assert.equal(sample.newTrades[0].id, 'new');
  assert.equal(sample.funnel.uniqueCandidates, 1); assert.equal(sample.funnel.twoBuyers, 1);
  assert.equal(sample.chains.base.market.fresh, false); assert.equal(sample.chains.base.flow.fresh, true);
  assert.equal(sample.rejectionCounts['新鲜且足够的 K 线'], 1);
  assert.deepEqual(sample.trackedPrices, []);
});
test('observation rejects any non-paper execution flags', () => {
  for (const key of ['execution', 'signing', 'broadcast']) { const s = state(); s[key] = true; assert.throws(() => observationSample(s, now)); }
  const s = state(); s.mode = 'live'; assert.throws(() => observationSample(s, now));
});
