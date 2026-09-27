import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPLORATORY_FLOW, exploratoryEntryPolicy, meetsPaperEntryFlow } from '../src/paper-entry-policy.js';

test('research and strategy share the v2 signal floor while legacy exit thresholds stay available', () => {
  for (const id of ['internal', 'launch_sniper', 'smart_money', 'narrative_pvp']) {
    const policy = exploratoryEntryPolicy(id);
    for (const [key, value] of Object.entries(EXPLORATORY_FLOW)) assert.equal(policy[key], value);
    const early = ['internal', 'launch_sniper'].includes(id);
    assert.equal(policy.minLiquidity, early ? 5000 : 10000);
    const legacy = exploratoryEntryPolicy(id, 'paper_exploration_v1');
    assert.equal(legacy.minBuyers, 2); assert.equal(legacy.minNetBuy, early ? 250 : 500);
    assert.equal(legacy.minLiquidity, early ? 10000 : 25000);
  }
  assert.throws(() => exploratoryEntryPolicy('internal', 'unknown'), /unknown/);
});

test('flow floors accept the exact boundary but never coerce missing metrics to zero', () => {
  const flow = { highProfitCount: 0, uniqueBuyerCount: 1, smartMoneyCount: 1, netBuyUsd: 200 };
  assert.equal(meetsPaperEntryFlow(flow, EXPLORATORY_FLOW), true);
  for (const field of Object.keys(flow)) for (const value of [null, undefined, NaN, Infinity, '200']) {
    assert.equal(meetsPaperEntryFlow({ ...flow, [field]: value }, EXPLORATORY_FLOW), false);
  }
  for (const patch of [{ uniqueBuyerCount: 0 }, { smartMoneyCount: 0 }, { netBuyUsd: 199.99 }]) {
    assert.equal(meetsPaperEntryFlow({ ...flow, ...patch }, EXPLORATORY_FLOW), false);
  }
});
