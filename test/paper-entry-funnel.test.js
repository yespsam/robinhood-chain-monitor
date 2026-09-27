import test from 'node:test';
import assert from 'node:assert/strict';
import { paperEntryFunnel } from '../src/paper-entry-funnel.js';
const ready = () => ({ token: { chain: 'sol', address: 'example' }, decision: '可模拟', evidence: {
  marketFresh: true, flowFresh: true, flow: { uniqueBuyerCount: 1, highProfitCount: 0, smartMoneyCount: 1, netBuyUsd: 200 },
  entryThresholds: { minBuyers: 1, minHighProfit: 0, minSmartMoney: 1, minNetBuy: 200 },
  safety: { missing: [], blocked: [] }, chart: { ready: true }, priceFresh: true, paperEligible: true,
} });
test('entry funnel deduplicates strategy lanes and counts nested evidence gates without approving anything', () => {
  const good = ready(), old = ready(), unknown = ready(), small = ready();
  old.token.address = 'old'; old.evidence.marketFresh = false;
  unknown.token.address = 'unknown'; unknown.evidence.safety.missing = ['sell tax'];
  small.token.address = 'small'; small.evidence.flow.netBuyUsd = 199;
  assert.deepEqual(paperEntryFunnel([good, structuredClone(good), old, unknown, small]), {
    detected: 4, marketFresh: 3, flowReady: 2, safetyReady: 1, chartReady: 1, quoteFresh: 1, eligible: 1,
  });
  assert.equal(paperEntryFunnel([{ token: good.token }]).eligible, 0);
  assert.equal(paperEntryFunnel([]).detected, 0);
});
