import test from 'node:test';
import assert from 'node:assert/strict';
import { paperTaxRate, paperTaxScreen } from '../src/paper-safety-policy.js';
import { mergePaperCandidateSnapshots } from '../src/paper-candidate-research.js';

test('tax cap is strictly greater than 6%, independently for buy and sell, not their sum', () => {
  for (const side of ['buyTax', 'sellTax']) {
    for (const value of [0, .059999, .06, '0.06']) {
      assert.equal(paperTaxScreen({ buyTax: 0, sellTax: 0, [side]: value }).blocked, false);
    }
    for (const value of [.060001, .07, .1, 1, '0.060001']) {
      const result = paperTaxScreen({ buyTax: 0, sellTax: 0, [side]: value });
      assert.equal(result.blocked, true); assert.equal(result.reasons.length, 1);
      assert.match(result.reasons[0], /税超过 6%/);
    }
  }
  assert.equal(paperTaxScreen({ buyTax: .04, sellTax: .04 }).blocked, false);
  assert.equal(paperTaxScreen({ buyTax: .07, sellTax: .08 }).reasons.length, 2);
  assert.equal(paperTaxScreen({ buyTax: .07, sellTax: null }).blocked, true);
});

test('missing, malformed or out-of-range tax is unknown, never a zero or guessed percentage', () => {
  for (const value of [null, undefined, '', ' ', false, true, [], [0], {}, NaN, Infinity, -1, 6, '6%', 'unknown']) {
    assert.equal(paperTaxRate(value), null, String(value));
    const result = paperTaxScreen({ buyTax: value, sellTax: value });
    assert.deepEqual(result.missing, ['买入税', '卖出税']);
    assert.equal(result.buyTax, null); assert.equal(result.sellTax, null);
  }
  assert.equal(paperTaxScreen(null).missing.length, 2);
});

test('snapshot merge preserves a fresh high tax, malformed values and freshness boundaries', () => {
  const nowMs = Date.parse('2026-09-26T01:00:00Z');
  const snapshot = (tax, age = 0) => ({ marketStatus: 'ok', observedAt: new Date(nowMs - age).toISOString(),
    token: { chain: 'bsc', address: `0x${'a'.repeat(40)}`, buyTax: tax, sellTax: 0 } });
  for (const other of [0, .06, null, false, [], '6%', 6]) {
    for (const pair of [[snapshot(.07, 1000), snapshot(other)], [snapshot(other, 1000), snapshot(.07)]]) {
      const result = paperTaxScreen(mergePaperCandidateSnapshots(...pair, nowMs).token);
      assert.equal(result.blocked, true); assert.equal(result.buyTax, .07);
    }
  }
  for (const value of [false, [], ' ', '6%', 6]) {
    const result = paperTaxScreen(mergePaperCandidateSnapshots(snapshot(value, 1000), snapshot(0), nowMs).token);
    assert.equal(result.buyTax, null);
  }
  const refreshed = paperTaxScreen(mergePaperCandidateSnapshots(snapshot(.07, 120001), snapshot(.02), nowMs).token);
  assert.equal(refreshed.blocked, false); assert.equal(refreshed.buyTax, .02);
});
