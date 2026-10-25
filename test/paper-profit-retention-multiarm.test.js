import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfitRetentionMultiarm, advanceProfitRetentionMultiarm, validateProfitRetentionMultiarm, profitRetentionMultiarmSummary } from '../src/paper-profit-retention-multiarm.js';

const T = Date.parse('2026-10-18T00:00:00Z'), CA = `0x${'a'.repeat(40)}`;
const COSTS = { version: 'isolated_estimated_cost_v1', feeRate: .01, slippageRate: .01, gasUsd: .04, buyTax: 0, sellTax: 0 };
const account = trades => ({ mode: 'paper', execution: false, signing: false, broadcast: false, estimatedCostModel: COSTS.version, trades, positions: {} });
function buy(id = 'entry', atMs = T + 1, address = CA) {
  return { id, side: 'buy', chain: 'bsc', address, quantity: 10, price: 1, grossUsd: 10, costsUsd: .24, netUsd: -10.24,
    costBasisUsd: 10.24, realizedPnl: 0, atMs, entryEvidence: { costAssumptions: COSTS } };
}
function sell(entry, price, atMs, side = 'sell') {
  const grossUsd = entry.quantity * price, costsUsd = side === 'writeoff' ? 0 : grossUsd * .02 + .04;
  return { id: `exit-${entry.id}`, side, chain: entry.chain, address: entry.address, quantity: entry.quantity, price, grossUsd, costsUsd,
    netUsd: grossUsd - costsUsd, costBasisUsd: entry.costBasisUsd, realizedPnl: grossUsd - costsUsd - entry.costBasisUsd, atMs };
}
const mark = (price, atMs, address = CA) => ({ chain: 'bsc', address, status: 'ok', price, observedAt: new Date(atMs).toISOString() });
function setup() {
  const empty = account([]), entry = buy(), source = account([entry]);
  const baseline = createProfitRetentionMultiarm(empty, { sessionId: 'three-paired', nowMs: T });
  const state = advanceProfitRetentionMultiarm(baseline, { beforeAccount: empty, afterAccount: source, marks: [], nowMs: T + 1 });
  return { state, source, entry };
}
const observe = (state, source, price, atMs) => advanceProfitRetentionMultiarm(state, { beforeAccount: source, afterAccount: source, marks: [mark(price, atMs)], nowMs: atMs });
const finish = (state, source, entry, price = 1, atMs = T + 8000) => advanceProfitRetentionMultiarm(state, {
  beforeAccount: source, afterAccount: account([...source.trades, sell(entry, price, atMs)]), marks: [], nowMs: atMs });

test('fixed complete ordered hypotheses share one source entry, quotes and baseline without mutating inputs', () => {
  const { state, source } = setup(), stateBefore = JSON.stringify(state), sourceBefore = JSON.stringify(source);
  const next = observe(state, source, 2.1, T + 1000);
  assert.deepEqual(next.policy.triggerPriceMultiples, [2, 3, 5]);
  assert.deepEqual(next.arms.map(a => a.study.pairs.map(p => p.id)), [['entry'], ['entry'], ['entry']]);
  for (const arm of next.arms) {
    assert.deepEqual(arm.study.cursor, next.cursor); assert.equal(arm.study.baseline.establishedAtMs, next.baseline.establishedAtMs);
    assert.deepEqual(arm.study.pairs[0].observations, next.arms[0].study.pairs[0].observations);
  }
  assert.equal(JSON.stringify(state), stateBefore); assert.equal(JSON.stringify(source), sourceBefore);
  const summary = profitRetentionMultiarmSummary(next, { nowMs: T + 1000 });
  assert.equal(summary.openPairs, 1); assert.equal(summary.closedPairs, 0); assert.equal(summary.pairedCohort, true);
  assert.equal('performance' in summary, false); assert.ok(summary.arms.every(a => a.performance === null));
});

test('2x recovers but untouched 3x/5x still count in the same completed cohort and share one control', () => {
  const { state, source, entry } = setup();
  const next = finish(observe(observe(state, source, 2.1, T + 1000), source, 2.2, T + 2000), source, entry);
  const summary = profitRetentionMultiarmSummary(next, { nowMs: T + 8000 });
  assert.equal(summary.closedPairs, 1); assert.equal(summary.arms.length, 3); assert.equal('performance' in summary, false);
  assert.deepEqual(summary.arms.map(a => a.performance.completedRounds), [1, 1, 1]);
  assert.deepEqual(summary.arms.map(a => a.performance.recoveries), [1, 0, 0]);
  assert.deepEqual(summary.arms.map(a => a.performance.unrecoveredRounds), [0, 1, 1]);
  assert.deepEqual(summary.arms.map(a => a.performance.neverTriggeredRounds), [0, 1, 1]);
  assert.deepEqual(summary.arms.map(a => a.performance.recoveryRate), [1, 0, 0]);
  assert.equal(new Set(summary.arms.map(a => a.performance.controlNetUsd)).size, 1);
  assert.ok(summary.arms[0].performance.deltaNetUsd > 0);
  assert.equal(summary.arms[1].performance.deltaNetUsd, 0); assert.equal(summary.arms[2].performance.deltaNetUsd, 0);
});

test('2x, 3x and 5x each recover once on later distinct quotes, retain full per-exit gas', () => {
  const { state, source } = setup(); let next = state;
  for (const [i, price] of [2, 2.1, 3, 3.1, 5, 5.1, 10, 10.1].entries()) next = observe(next, source, price, T + (i + 1) * 1000);
  assert.deepEqual(next.arms.map(a => a.study.pairs[0].treatment.legs.length), [1, 1, 1]);
  assert.deepEqual(next.arms.map(a => a.study.pairs[0].treatment.legs[0].atMs), [T + 2000, T + 4000, T + 6000]);
  for (const arm of next.arms) {
    const leg = arm.study.pairs[0].treatment.legs[0];
    assert.ok(Math.abs(leg.netUsd - 10.24) < 1e-10); assert.ok(Math.abs(leg.costsUsd - leg.grossUsd * .02 - .04) < 1e-10);
  }
  const stale = profitRetentionMultiarmSummary(next, { nowMs: T + 50000 });
  assert.ok(stale.arms.every(a => a.active[0].controlUnrealizedNetUsd === null && a.active[0].treatmentTotalIfLiquidatedUsd === null));
});

test('early principal recovery exposes forgone upside rather than selecting the best arm after the fact', () => {
  const { state, source, entry } = setup();
  const recovered = observe(observe(state, source, 2, T + 1000), source, 2.1, T + 2000);
  const summary = profitRetentionMultiarmSummary(finish(recovered, source, entry, 6), { nowMs: T + 8000 });
  assert.equal(summary.arms[0].performance.foregoneUpsideRounds, 1);
  assert.ok(summary.arms[0].performance.foregoneUpsideUsd > 0);
  assert.equal(summary.arms[0].performance.foregoneUpsideUsd, -summary.arms[0].performance.deltaNetUsd);
  assert.equal(summary.arms[1].performance.foregoneUpsideRounds, 0);
  assert.equal(summary.arms[2].performance.foregoneUpsideRounds, 0);
});

test('deep decline measures completed-round drawdown; no completed sample is not zero performance', () => {
  const { state, source, entry } = setup();
  const next = finish(state, source, entry, .1);
  const summary = profitRetentionMultiarmSummary(next, { nowMs: T + 8000 });
  for (const arm of summary.arms) {
    assert.equal(arm.performance.closedRoundDrawdown.controlMaxDrawdownUsd, -arm.performance.controlNetUsd);
    assert.equal(arm.performance.closedRoundDrawdown.treatmentMaxDrawdownUsd, -arm.performance.treatmentNetUsd);
    assert.equal(arm.performance.caRobustness.treatment.largestPositiveCA, null);
    assert.equal(arm.performance.caRobustness.treatment.netExcludingLargestPositiveCAUsd, null);
  }
});

test('completed CA concentration and largest-positive-CA exclusion aggregate repeated same-CA rounds', () => {
  const empty = account([]), a = buy('a', T + 1), b = buy('b', T + 1, `0x${'b'.repeat(40)}`), c = buy('c', T + 1, `0x${'c'.repeat(40)}`);
  const entries = account([a, b, c]);
  let state = advanceProfitRetentionMultiarm(createProfitRetentionMultiarm(empty, { sessionId: 'ca', nowMs: T }), { beforeAccount: empty, afterAccount: entries, marks: [], nowMs: T + 1 });
  const exits = [sell(a, 3, T + 1000), sell(b, 2, T + 2000), sell(c, .5, T + 3000)], closed = account([...entries.trades, ...exits]);
  state = advanceProfitRetentionMultiarm(state, { beforeAccount: entries, afterAccount: closed, marks: [], nowMs: T + 3000 });
  const a2 = buy('a2', T + 4000), reopened = account([...closed.trades, a2]);
  state = advanceProfitRetentionMultiarm(state, { beforeAccount: closed, afterAccount: reopened, marks: [], nowMs: T + 4000 });
  state = advanceProfitRetentionMultiarm(state, { beforeAccount: reopened, afterAccount: account([...reopened.trades, sell(a2, 1.2, T + 5000)]), marks: [], nowMs: T + 5000 });
  const summary = profitRetentionMultiarmSummary(state, { nowMs: T + 5000 });
  const robust = summary.arms[0].performance.caRobustness.treatment;
  assert.equal(summary.closedPairs, 4);
  assert.equal(robust.largestPositiveCA, `bsc:${CA}`); assert.equal(robust.distinctCAs, 3);
  assert.ok(Math.abs(robust.netExcludingLargestPositiveCAUsd - exits[1].realizedPnl - exits[2].realizedPnl) < 1e-10);
  assert.ok(robust.largestPositiveCAShare > .5 && robust.largestPositiveCAShare < 1);
});

test('restart roundtrip is valid; missing/reordered/duplicated arm or cross-arm tamper fails closed', () => {
  const { state, source } = setup(); const good = observe(state, source, 1.5, T + 1000);
  assert.equal(validateProfitRetentionMultiarm(JSON.parse(JSON.stringify(good))), true);
  for (const mutate of [s => s.arms.pop(), s => s.arms.reverse(), s => s.arms[1].multiple = 2,
    s => s.arms[1].study.cursor.lastTradeId = 'changed', s => s.arms[1].study.ineligibleCount++,
    s => { s.arms[1].study.pairs[0].observationCount++; }, s => s.arms[1].study.pairs[0].entry.riskUsd = 1,
    s => s.policy.triggerPriceMultiples = [2, 3], s => s.arms[1].study.pairs[0].treatment.remainingQuantity = 9]) {
    const bad = structuredClone(good); mutate(bad); const frozen = JSON.stringify(bad);
    assert.throws(() => validateProfitRetentionMultiarm(bad));
    assert.throws(() => advanceProfitRetentionMultiarm(bad, { beforeAccount: source, afterAccount: source, marks: [mark(6, T + 2000)], nowMs: T + 2000 }));
    assert.equal(JSON.stringify(bad), frozen);
  }
});

test('main actual exit wins in every arm over a same-call threshold; baseline holdings are not counted', () => {
  const old = buy('old', T - 1), oldAccount = account([old]); oldAccount.positions.old = { quantity: 10 };
  const baseline = createProfitRetentionMultiarm(oldAccount, { sessionId: 'no-backfill', nowMs: T });
  const final = account([old, sell(old, 6, T + 1000)]);
  const noBackfill = advanceProfitRetentionMultiarm(baseline, { beforeAccount: oldAccount, afterAccount: final, marks: [mark(6, T + 1000)], nowMs: T + 1000 });
  assert.equal(profitRetentionMultiarmSummary(noBackfill, { nowMs: T + 1000 }).closedPairs, 0);
  const { state, source, entry } = setup(); const armed = observe(state, source, 5, T + 1000);
  const exit = sell(entry, 5.1, T + 2000);
  const next = advanceProfitRetentionMultiarm(armed, { beforeAccount: source, afterAccount: account([entry, exit]), marks: [mark(6, T + 2000)], nowMs: T + 2000 });
  assert.ok(next.arms.every(a => a.study.pairs[0].treatment.partialTaken === false));
  assert.ok(profitRetentionMultiarmSummary(next, { nowMs: T + 2000 }).arms.every(a => a.performance.deltaNetUsd === 0));
});

test('long commit gap followed by a fresh quote is recorded, not backfilled or treated as complete coverage', () => {
  const { state, source, entry } = setup();
  let next = observe(state, source, 1.1, T + 1000);
  next = observe(next, source, 2.1, T + 22000);
  assert.equal(next.sharedCoverage.reasons.observer_commit_gap, 1);
  const gap = next.sharedCoverage.latest.find(g => g.reason === 'observer_commit_gap');
  assert.deepEqual(gap.pairIds, ['entry']); assert.equal(gap.fromMs, T + 1000); assert.equal(gap.atMs, T + 22000);
  assert.ok(next.arms.every(a => a.study.pairs[0].observationCount === 2));
  assert.ok(next.arms.every(a => a.study.pairs[0].treatment.partialTaken === false));
  next = finish(next, source, entry, .8, T + 23000);
  const summary = profitRetentionMultiarmSummary(next, { nowMs: T + 23000 });
  assert.ok(summary.arms.every(a => a.performance.completedWithCoverageGaps === 1));
  assert.deepEqual(summary.arms.map(a => a.performance.observedNeverTriggeredRounds), [0, 1, 1]);
  assert.equal(summary.sharedCoverage.reasons.observer_commit_gap, 1);
  const tampered = structuredClone(next); tampered.sharedCoverage.latest = []; tampered.sharedCoverage.byPair = [];
  assert.throws(() => validateProfitRetentionMultiarm(tampered), /pair coverage incident/);
});

test('arm-specific infeasible recovery is not relabeled as a shared quote gap', () => {
  const empty = account([]), expensive = buy();
  expensive.entryEvidence.costAssumptions = { ...COSTS, gasUsd: 15 };
  expensive.costsUsd = 15.2; expensive.netUsd = -25.2; expensive.costBasisUsd = 25.2;
  const source = account([expensive]);
  let state = advanceProfitRetentionMultiarm(createProfitRetentionMultiarm(empty, { sessionId: 'costs', nowMs: T }), {
    beforeAccount: empty, afterAccount: source, marks: [], nowMs: T + 1 });
  state = observe(observe(state, source, 2, T + 1000), source, 2, T + 2000);
  assert.equal(state.arms[0].study.coverage.reasons.principal_recovery_infeasible, 1);
  assert.equal(state.sharedCoverage.reasons.principal_recovery_infeasible, undefined);
  assert.equal(state.sharedCoverage.gapCount, 1); // Only the missing post-entry quote, not a data fault from the hypothesis.
});

test('same-commit buy and full exit retains accounts but marks absent post-entry observations once', () => {
  const empty = account([]), baseline = createProfitRetentionMultiarm(empty, { sessionId: 'same-commit', nowMs: T });
  const entry = buy(), source = account([entry, sell(entry, 3, T + 1000)]);
  let next = advanceProfitRetentionMultiarm(baseline, { beforeAccount: empty, afterAccount: source,
    marks: [mark(3, T + 1000)], nowMs: T + 1000 });
  let summary = profitRetentionMultiarmSummary(next, { nowMs: T + 1000 });
  assert.equal(summary.closedPairs, 1); assert.equal(summary.sharedCoverage.gapCount, 1);
  assert.equal(summary.sharedCoverage.reasons.no_post_entry_observation, 1);
  assert.deepEqual(summary.sharedCoverage.latest[0].pairIds, ['entry']);
  assert.ok(summary.arms.every(a => a.performance.completedWithCoverageGaps === 1));
  assert.ok(summary.arms.every(a => a.performance.deltaNetUsd === 0));
  next = advanceProfitRetentionMultiarm(next, { beforeAccount: source, afterAccount: structuredClone(source), marks: [], nowMs: T + 2000 });
  summary = profitRetentionMultiarmSummary(next, { nowMs: T + 2000 });
  assert.equal(summary.sharedCoverage.gapCount, 1); assert.equal(summary.sharedCoverage.reasons.no_post_entry_observation, 1);
  assert.ok(summary.arms.every(a => a.performance.completedWithCoverageGaps === 1));
  const erased = structuredClone(next); erased.sharedCoverage = { gapCount: 0, pairGapCount: 0, reasons: {}, latest: [], byPair: [] };
  assert.throws(() => validateProfitRetentionMultiarm(erased), /without observations/);
});
