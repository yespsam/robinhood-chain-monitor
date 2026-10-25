import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfitRetentionShadow, advanceProfitRetentionShadow, validateProfitRetentionShadow, profitRetentionSummary } from '../src/paper-profit-retention-shadow.js';

const T = Date.parse('2026-10-18T00:00:00Z'), CA = `0x${'a'.repeat(40)}`;
const costs = { version: 'isolated_estimated_cost_v1', feeRate: .01, slippageRate: .01, gasUsd: .04, buyTax: 0, sellTax: 0 };
const account = trades => ({ mode: 'paper', execution: false, signing: false, broadcast: false, estimatedCostModel: costs.version, trades, positions: {} });
function buy(id = 'buy1', atMs = T + 1, overrides = {}) {
  return { id, side: 'buy', chain: 'bsc', address: CA, quantity: 10, price: 1, grossUsd: 10, costsUsd: .24, netUsd: -10.24, costBasisUsd: 10.24, realizedPnl: 0, atMs,
    entryEvidence: { costAssumptions: costs, traderDecision: { economics: { plannedStopLossUsd: 1 } } }, ...overrides };
}
function sell(entry, price = 1, atMs = T + 5000, side = 'sell') {
  const grossUsd = entry.quantity * price, costsUsd = side === 'writeoff' ? 0 : grossUsd * .02 + .04;
  return { id: `exit-${entry.id}`, side, chain: entry.chain, address: entry.address, quantity: entry.quantity, price, grossUsd, costsUsd,
    netUsd: grossUsd - costsUsd, costBasisUsd: entry.costBasisUsd, realizedPnl: grossUsd - costsUsd - entry.costBasisUsd, atMs };
}
const quote = (price, atMs, overrides = {}) => ({ chain: 'bsc', address: CA, status: 'ok', price, observedAt: new Date(atMs).toISOString(), ...overrides });
function setup({ triggerPriceMultiple = 2, entryOverrides = {} } = {}) {
  const empty = account([]), entry = buy('buy1', T + 1, entryOverrides), source = account([entry]);
  const initial = createProfitRetentionShadow(empty, { sessionId: 'forward-test', nowMs: T, triggerPriceMultiple });
  const state = advanceProfitRetentionShadow(initial, { beforeAccount: empty, afterAccount: source, marks: [], nowMs: T + 1 });
  return { state, source, entry };
}
const mark = (state, source, price, atMs, overrides = {}) => advanceProfitRetentionShadow(state, { beforeAccount: source, afterAccount: source, marks: [quote(price, atMs, overrides)], nowMs: atMs });

test('forward baseline excludes existing holdings/history; no mutation and no performance from zero rounds', () => {
  const old = buy('old', T - 1000), a = account([old]); a.positions.old = { quantity: 10 };
  const frozen = JSON.stringify(a), state = createProfitRetentionShadow(a, { sessionId: 's', nowMs: T });
  assert.equal(state.pairs.length, 0); assert.equal(JSON.stringify(a), frozen);
  const next = advanceProfitRetentionShadow(state, { beforeAccount: a, afterAccount: account([old, sell(old, 2)]), marks: [], nowMs: T + 5000 });
  assert.equal(next.pairs.length, 0); assert.equal(profitRetentionSummary(next, { nowMs: T + 5000 }).performance, null);
  assert.equal(state.cursor.tradeCount, 1);
});

test('two distinct quotes recover all-in principal after full costs; complete only with actual exit', () => {
  const { state, source, entry } = setup(), snapshot = JSON.stringify(state);
  let next = mark(state, source, 2, T + 1000);
  assert.equal(next.pairs[0].treatment.legs.length, 0); assert.ok(next.pairs[0].armed);
  next = mark(next, source, 2, T + 1000); assert.equal(next.pairs[0].treatment.legs.length, 0);
  next = mark(next, source, 2, T + 2000);
  const partial = next.pairs[0].treatment.legs[0];
  assert.equal(partial.price, 2); assert.ok(partial.quantity > entry.quantity / 2);
  assert.ok(Math.abs(partial.quantity - (entry.costBasisUsd + .04) / (2 * .98)) < 1e-12);
  assert.ok(Math.abs(partial.netUsd - entry.costBasisUsd) < 1e-10);
  assert.ok(Math.abs(partial.costsUsd - (partial.grossUsd * .02 + .04)) < 1e-10);
  assert.equal(profitRetentionSummary(next, { nowMs: T + 2000 }).performance, null);
  const active = profitRetentionSummary(next, { nowMs: T + 2000 }).active[0];
  assert.ok(Math.abs(active.recoveredPrincipalUsd - entry.costBasisUsd) < 1e-10);
  assert.equal(active.principalTargetUsd, entry.costBasisUsd); assert.ok(active.remainingFraction < .5);
  assert.equal(active.recoveryAtMs, T + 2000);
  const exit = sell(entry, 1, T + 5000);
  next = advanceProfitRetentionShadow(next, { beforeAccount: source, afterAccount: account([entry, exit]), marks: [], nowMs: T + 5000 });
  const summary = profitRetentionSummary(next, { nowMs: T + 5000 });
  assert.equal(summary.closedPairs, 1); assert.equal(summary.performance.controlNetUsd, exit.realizedPnl);
  assert.ok(summary.performance.deltaNetUsd > 0); assert.equal(next.pairs[0].treatment.remainingQuantity, 0);
  assert.equal(JSON.stringify(state), snapshot); assert.equal(validateProfitRetentionShadow(JSON.parse(JSON.stringify(next))), true);
});

test('continuing winner quantifies forgone upside, never assumes partial dominates', () => {
  const { source, entry, state } = setup();
  let next = mark(mark(state, source, 2, T + 1000), source, 2.1, T + 2000);
  const exit = sell(entry, 3);
  next = advanceProfitRetentionShadow(next, { beforeAccount: source, afterAccount: account([entry, exit]), marks: [], nowMs: T + 5000 });
  assert.ok(profitRetentionSummary(next, { nowMs: T + 5000 }).performance.deltaNetUsd < 0);
});

test('main full exit takes precedence over a simultaneous eligible partial', () => {
  const { source, entry, state } = setup(); const armed = mark(state, source, 2, T + 1000), exit = sell(entry, 2.1, T + 2000);
  const next = advanceProfitRetentionShadow(armed, { beforeAccount: source, afterAccount: account([entry, exit]), marks: [quote(2, T + 2000)], nowMs: T + 2000 });
  assert.equal(next.pairs[0].treatment.partialTaken, false);
  assert.equal(profitRetentionSummary(next, { nowMs: T + 2000 }).performance.deltaNetUsd, 0);
});

test('main writeoff is zero-price zero-gas remainder; partial source exit excludes pair', () => {
  const { source, entry, state } = setup(); const partial = mark(mark(state, source, 2, T + 1000), source, 2.1, T + 2000);
  const next = advanceProfitRetentionShadow(partial, { beforeAccount: source, afterAccount: account([entry, sell(entry, 0, T + 5000, 'writeoff')]), marks: [], nowMs: T + 5000 });
  assert.equal(next.pairs[0].treatment.legs.at(-1).costsUsd, 0);
  const partialMain = sell({ ...entry, quantity: 5, costBasisUsd: 5.12 }, 1.5);
  const excluded = advanceProfitRetentionShadow(partial, { beforeAccount: source, afterAccount: account([entry, partialMain]), marks: [], nowMs: T + 5000 });
  assert.equal(excluded.pairs[0].status, 'excluded'); assert.equal(profitRetentionSummary(excluded, { nowMs: T + 5000 }).performance, null);
});

test('stale, missing, zero, future, wrong identity, unhealthy and pre-entry quotes do not fill', () => {
  const { state, source } = setup();
  for (const bad of [quote(2, T), quote(0, T + 2000), quote(2, T + 50000), quote(2, T + 2000, { status: 'stale' }), quote(2, T + 2000, { chain: 'base' }), quote(2, T + 2000, { address: `0x${'b'.repeat(40)}` }), quote(2, T + 2000, { observedAt: null })]) {
    const next = advanceProfitRetentionShadow(state, { beforeAccount: source, afterAccount: source, marks: [bad], nowMs: T + 20000 });
    assert.equal(next.pairs[0].observationCount, 0); assert.equal(next.pairs[0].treatment.legs.length, 0);
  }
  const fresh = mark(state, source, 1.5, T + 1000);
  assert.equal(profitRetentionSummary(fresh, { nowMs: T + 20000 }).active[0].controlUnrealizedNetUsd, null);
});

test('duplicate/conflicting/out-of-order quotes cannot turn a trigger into a fill', () => {
  const { state, source } = setup(); let next = mark(state, source, 2, T + 1000);
  next = mark(next, source, 2.1, T + 1000); assert.equal(next.pairs[0].treatment.legs.length, 0);
  next = advanceProfitRetentionShadow(next, { beforeAccount: source, afterAccount: source, marks: [quote(3, T + 900)], nowMs: T + 1100 });
  assert.equal(next.pairs[0].treatment.legs.length, 0);
  next = advanceProfitRetentionShadow(next, { beforeAccount: source, afterAccount: source, marks: [quote(3, T + 1500), quote(4, T + 1500)], nowMs: T + 1500 });
  assert.equal(next.pairs[0].treatment.legs.length, 0);
  next = mark(next, source, 1, T + 2000); assert.equal(next.pairs[0].armed, null);
  next = mark(next, source, 2.2, T + 3000); assert.ok(next.pairs[0].armed); assert.equal(next.pairs[0].treatment.legs.length, 0);
});

test('count/ID continuity plus full prefix digest reject rollback, rewritten prefix and wrong source', () => {
  const { state, source } = setup();
  const mutate = structuredClone(source); mutate.trades[0].price = 1.1;
  for (const [beforeAccount, afterAccount] of [[account([]), source], [source, account([])], [source, mutate], [mutate, mutate]]) {
    assert.throws(() => advanceProfitRetentionShadow(state, { beforeAccount, afterAccount, marks: [], nowMs: T + 1000 }));
  }
  assert.throws(() => advanceProfitRetentionShadow(state, { beforeAccount: source, afterAccount: source, marks: [], nowMs: T }));
});

test('invalid costs are explicit ineligible entries, not invented costs', () => {
  const empty = account([]), original = createProfitRetentionShadow(empty, { sessionId: 's', nowMs: T });
  for (const e of [buy('bad-cost', T + 1, { costsUsd: 0 }), buy('other-model', T + 1, { entryEvidence: { costAssumptions: { ...costs, version: 'other' }, traderDecision: { economics: { plannedStopLossUsd: 1 } } } })]) {
    const next = advanceProfitRetentionShadow(original, { beforeAccount: empty, afterAccount: account([e]), marks: [], nowMs: T + 1 });
    assert.equal(next.ineligibleCount, 1); assert.equal(next.pairs.length, 0);
  }
});

test('JSON restart validates policy, inventory, exit arithmetic and frozen source risk; no silent reset', () => {
  const { state, source } = setup(); let good = mark(mark(state, source, 2, T + 1000), source, 2.1, T + 2000);
  good = JSON.parse(JSON.stringify(good)); assert.equal(validateProfitRetentionShadow(good), true);
  for (const change of [s => s.policy.triggerPriceMultiple = 3, s => s.pairs[0].treatment.remainingQuantity = 10,
    s => s.pairs[0].treatment.legs[0].costsUsd = 0, s => s.pairs[0].treatment.legs[0].fillObservation.atMs = T + 1000]) {
    const bad = structuredClone(good); change(bad); assert.throws(() => validateProfitRetentionShadow(bad));
  }
  const forged = structuredClone(state); forged.pairs[0].entry.riskUsd = 2;
  assert.throws(() => advanceProfitRetentionShadow(forged, { beforeAccount: source, afterAccount: source, marks: [], nowMs: T + 1000 }), /frozen entry/);
});

test('observations are bounded while peak and first trigger remain preserved', () => {
  const { source, state } = setup(); let next = state;
  for (let i = 1; i <= 130; i++) next = mark(next, source, i === 1 ? 2.1 : 1, T + i * 1000);
  assert.equal(next.pairs[0].observations.length, 120); assert.equal(next.pairs[0].observationCount, 130);
  assert.equal(next.pairs[0].peak.price, 2.1); assert.equal(next.pairs[0].firstTrigger.price, 2.1);
});

test('study capacity stops admitting new pairs without deleting any previous paired entry', () => {
  const empty = account([]), initial = createProfitRetentionShadow(empty, { sessionId: 'bounded', nowMs: T });
  const trades = Array.from({ length: 201 }, (_, i) => buy(`b-${i}`, T + 1, { address: `0x${(i + 1).toString(16).padStart(40, '0')}` }));
  const next = advanceProfitRetentionShadow(initial, { beforeAccount: empty, afterAccount: account(trades), marks: [], nowMs: T + 1 });
  assert.equal(next.pairs.length, 200); assert.equal(next.admissionStopped, true); assert.equal(next.ineligibleCount, 1);
  assert.equal(next.pairs[0].id, 'b-0'); assert.equal(next.pairs.at(-1).id, 'b-199');
  assert.equal(next.ineligible[0].reason, 'study_capacity_reached'); assert.equal(validateProfitRetentionShadow(next), true);
});

test('price below frozen 2x does not arm even if net gain exceeds 2R; original funds identical', () => {
  const { state, source } = setup();
  const next = mark(state, source, 1.9, T + 1000);
  assert.equal(next.pairs[0].armed, null); assert.equal(next.pairs[0].entry.basisUsd, 10.24);
  assert.equal(next.pairs[0].treatment.remainingBasisUsd, 10.24);
});

test('native source checkpoint survives JSON round-trip; key-order rewrite conservatively freezes', () => {
  const { state, source } = setup(), reloaded = JSON.parse(JSON.stringify(source));
  assert.doesNotThrow(() => advanceProfitRetentionShadow(JSON.parse(JSON.stringify(state)), {
    beforeAccount: reloaded, afterAccount: structuredClone(reloaded), marks: [], nowMs: T + 1000 }));
  const reordered = account([{ ...Object.fromEntries(Object.entries(source.trades[0]).reverse()) }]);
  assert.throws(() => advanceProfitRetentionShadow(state, { beforeAccount: reordered, afterAccount: reordered, marks: [], nowMs: T + 1000 }), /checkpoint/);
  assert.throws(() => advanceProfitRetentionShadow(state, { beforeAccount: source, afterAccount: reordered, marks: [], nowMs: T + 1000 }), /history mutation/);
});

test('default 2x and explicitly frozen 3x/5x use price multiples and return actual policy', () => {
  const quantity = (10 - .04) / 1.02;
  const entryOverrides = { quantity, grossUsd: quantity, costsUsd: 10 - quantity, netUsd: -10, costBasisUsd: 10 };
  const expectedFractions = new Map([[2, .5245881485], [3, .3497254323], [5, .2098352594]]);
  for (const multiple of [2, 3, 5]) {
    const { state, source } = setup({ triggerPriceMultiple: multiple, entryOverrides });
    let next = mark(state, source, multiple - .01, T + 500);
    assert.equal(next.pairs[0].armed, null);
    next = mark(next, source, multiple, T + 1000); assert.ok(next.pairs[0].armed);
    next = mark(next, source, multiple, T + 2000);
    const partial = next.pairs[0].treatment.legs[0], summary = profitRetentionSummary(next, { nowMs: T + 2000 });
    assert.ok(Math.abs(partial.netUsd - 10) < 1e-10);
    assert.ok(Math.abs(partial.quantity / quantity - expectedFractions.get(multiple)) < 1e-9);
    assert.equal(summary.policy.triggerPriceMultiple, multiple);
    assert.ok(partial.realizedPnl < partial.netUsd); // Recovery cash is not all profit.
    next = mark(next, source, 10, T + 3000); assert.equal(next.pairs[0].treatment.legs.length, 1);
  }
  assert.equal(setup().state.policy.triggerPriceMultiple, 2);
  for (const invalid of [1, 2.5, 4, 6, '2', null, Infinity]) assert.throws(() => createProfitRetentionShadow(account([]), {
    sessionId: 'invalid', nowMs: T, triggerPriceMultiple: invalid }), /multiples/);
});

test('missing scenario R is frozen null and does not block cost-aware principal recovery', () => {
  const { state, source } = setup({ entryOverrides: { entryEvidence: { costAssumptions: costs } } });
  assert.equal(state.pairs.length, 1); assert.equal(state.pairs[0].entry.riskUsd, null); assert.equal(state.ineligibleCount, 0);
  const next = mark(mark(state, source, 2, T + 1000), source, 2.1, T + 2000);
  assert.equal(next.pairs[0].treatment.partialTaken, true); assert.equal(validateProfitRetentionShadow(JSON.parse(JSON.stringify(next))), true);
});

test('infeasible all-in principal recovery cannot clamp quantity or pretend capital was recovered', () => {
  const expensive = { ...costs, gasUsd: 15 }, basisUsd = 25.2;
  const { state, source } = setup({ entryOverrides: { costsUsd: 15.2, netUsd: -basisUsd, costBasisUsd: basisUsd,
    entryEvidence: { costAssumptions: expensive } } });
  const next = mark(mark(state, source, 2, T + 1000), source, 2, T + 2000);
  assert.equal(next.pairs[0].treatment.partialTaken, false); assert.equal(next.pairs[0].treatment.legs.length, 0);
  assert.equal(next.pairs[0].treatment.remainingQuantity, 10); assert.equal(next.pairs[0].armed, null);
  assert.equal(next.coverage.reasons.principal_recovery_infeasible, 1);
  assert.equal(profitRetentionSummary(next, { nowMs: T + 2000 }).active[0].recoveredPrincipalUsd, 0);
});

test('old v1 study is rejected rather than silently migrated or mixing hypotheses', () => {
  const old = setup().state; old.version = 'profit_retention_pair_v1';
  assert.throws(() => validateProfitRetentionShadow(old), /study identity/);
});

test('future remainder gas can create small total loss after recovered cash equals principal', () => {
  const { state, source, entry } = setup(); const recovered = mark(mark(state, source, 2, T + 1000), source, 2, T + 2000);
  const tinyExit = sell(entry, 1e-12, T + 5000);
  const closed = advanceProfitRetentionShadow(recovered, { beforeAccount: source, afterAccount: account([entry, tinyExit]), marks: [], nowMs: T + 5000 });
  const total = profitRetentionSummary(closed, { nowMs: T + 5000 }).performance.treatmentNetUsd;
  assert.ok(total < 0); assert.ok(Math.abs(total + .04) < 1e-9);
  const writeoff = advanceProfitRetentionShadow(recovered, { beforeAccount: source,
    afterAccount: account([entry, sell(entry, 0, T + 5000, 'writeoff')]), marks: [], nowMs: T + 5000 });
  assert.equal(writeoff.pairs[0].treatment.legs.at(-1).costsUsd, 0);
  assert.ok(Math.abs(profitRetentionSummary(writeoff, { nowMs: T + 5000 }).performance.treatmentNetUsd) < 1e-10);
});
