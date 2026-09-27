import test from 'node:test';
import assert from 'node:assert/strict';
import { traderDecision, traderReview, compareConfirmedCandidates, TRADER_REASONING_VERSION } from '../src/paper-trader-reasoning.js';
import { completedPaperRounds, confirmedAccountGate } from '../src/paper-confirmed-policy.js';
import { evaluatePaperStrategies, createPaperStrategyAccount, advancePaperStrategyAccount, validatePaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { renderStrategyDetails } from '../dashboard/strategy-details.js';

const NOW = Date.parse('2026-09-23T10:00:00Z'), CA = `0x${'a'.repeat(40)}`;
const iso = n => new Date(n).toISOString();
function input(address = CA) {
  const token = { chain: 'base', address, symbol: 'OFFLINE_TEST', price: 1.01, liquidity: 60000, volume: 5000,
    isHoneypot: false, isWashTrading: false, rugRatio: .01, top10HolderRate: .15, devTeamHoldRate: .01, bundlerRate: .01, buyTax: 0, sellTax: 0 };
  return { nowMs: NOW, token, marketStatus: 'ok', observedAt: iso(NOW), priceObservedAt: iso(NOW),
    allowExploratory: true, pvpMode: true, confirmedMode: true, compoundingCash: 100,
    flow: { fresh: true, complete: true, status: 'healthy', observedAt: iso(NOW), highProfitCount: 0, fomoCount: 0,
      smartMoneyCount: 1, uniqueBuyerCount: 2, netBuyUsd: 600,
      pulse: { recentBuyerCount: 2, recentNetBuyUsd: 600, lastBuyAt: NOW - 1000 } },
    quoteHistory: [1, 1.006, 1.01].map((price, i) => ({ ...token, price, status: 'ok', observedAt: iso(NOW - (2-i)*6000) })) };
}
const evaluate = c => evaluatePaperStrategies(c)[0];
function round({ at = NOW - 1000, pnl = 1, cost = .2, version = TRADER_REASONING_VERSION, address = CA, chain = 'base' } = {}) {
  return { at, pnl, entry: { atMs: at - 60000, chain, address, costsUsd: cost / 2,
    entryEvidence: { traderDecision: { version, hypothesis: 'fresh_flow_momentum', economics: { plannedStopLossUsd: .5 } },
      confirmedPolicy: { version: 'confirmed_pvp_v2', confirmation: { version: 'path_checked_v1' } } } },
    exits: [{ atMs: at, realizedPnl: pnl, costsUsd: cost / 2 }] };
}

test('four observable questions do not invent a narrative, win probability or expected profit', () => {
  const row = evaluate(input()), d = row.evidence.traderDecision;
  assert.equal(d.version, TRADER_REASONING_VERSION); assert.equal(d.questions.length, 4);
  assert.equal(d.hypothesis, 'fresh_flow_momentum'); assert.match(d.questions[0].text, /不编故事/);
  assert.equal(d.economics.expectedProfitUsd, null); assert.equal(d.decision, '可模拟');
  assert.deepEqual(d.blockers, []); assert.equal(d.execution, false);
  const c = row.evidence.costAssumptions, q = c.notionalUsd / row.token.price, k = 1 - c.feeRate - c.slippageRate - c.sellTax;
  assert.ok(Math.abs(q * d.economics.breakEvenPrice * k - c.gasUsd - row.entryUsd) < 1e-10);
  assert.ok(d.economics.plannedStopLossUsd > 0); assert.ok(d.economics.breakEvenRise > 0);
});

test('missing costs remain unknown; blocked evidence remains blocked and deduplicated', () => {
  const row = evaluate(input()); row.decision = '观察'; row.missing = ['缺报价', '缺报价']; row.reasons = ['缺报价'];
  row.evidence.costAssumptions = {};
  const d = traderDecision(row, NOW);
  assert.equal(d.economics.breakEvenPrice, null); assert.equal(d.economics.scenarioNetUsd, null);
  assert.equal(d.economics.roundTripCostRate, null); assert.deepEqual(d.blockers, ['缺报价']);
  assert.match(d.questions[2].text, /待确认/);
});

test('new fill freezes actual resized cash budget without rewriting its candidate or previous trades', () => {
  const a = createPaperStrategyAccount({ initialCash: 90, nowMs: NOW }), row = evaluate(input());
  const before = structuredClone(row);
  const next = advancePaperStrategyAccount(a, { evaluations: [row], confirmedMode: true, nowMs: NOW });
  assert.equal(next.trades.length, 1); assert.equal(validatePaperStrategyAccount(next), true);
  const d = next.trades[0].entryEvidence.traderDecision;
  assert.equal(d.economics.budgetUsd, 1.8); assert.equal(next.trades[0].costBasisUsd, 1.8);
  assert.deepEqual(row, before); assert.equal(a.trades.length, 0);
  assert.notEqual(d.economics.breakEvenRise, row.evidence.traderDecision.economics.breakEvenRise);
});

test('eligible ranking uses costs then actual buy recency, never a completeness score', () => {
  const expensive = evaluate(input(`0x${'b'.repeat(40)}`)), cheap = evaluate(input());
  expensive.evidence.costAssumptions.estimatedRoundTripCostRate = .049; expensive.score = 100;
  cheap.evidence.costAssumptions.estimatedRoundTripCostRate = .045; cheap.score = 1;
  assert.ok(compareConfirmedCandidates(cheap, expensive) < 0);
  expensive.evidence.costAssumptions.estimatedRoundTripCostRate = .045;
  expensive.evidence.confirmedPolicy.pulse.lastBuyAt = NOW;
  assert.ok(compareConfirmedCandidates(expensive, cheap) < 0);
  delete cheap.evidence.costAssumptions.estimatedRoundTripCostRate;
  delete expensive.evidence.costAssumptions.estimatedRoundTripCostRate;
  assert.ok(Number.isFinite(compareConfirmedCandidates(expensive, cheap)));
});

test('real evaluator fee ranking changes only which eligible paper candidate gets the slot', () => {
  const taxed = input(), cheap = input(`0x${'b'.repeat(40)}`); taxed.token.buyTax = .001;
  const first = evaluate(taxed), second = evaluate(cheap); first.score = 999; second.score = 1;
  assert.equal(first.decision, '可模拟'); assert.equal(second.decision, '可模拟');
  const next = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [first, second], confirmedMode: true, nowMs: NOW });
  assert.equal(next.trades.length, 1); assert.equal(next.trades[0].address, second.token.address);
  const bad = input(`0x${'c'.repeat(40)}`); bad.token.isHoneypot = true;
  const blocked = evaluate(bad); blocked.score = 10000;
  const safe = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [blocked], confirmedMode: true, nowMs: NOW });
  assert.equal(safe.trades.length, 0);
});

test('active lane optimization leaves standard four-strategy evaluation and original guards intact', () => {
  assert.equal(evaluatePaperStrategies(input()).length, 1);
  assert.equal(evaluatePaperStrategies({ ...input(), confirmedMode: false, diagnosticMode: true }).length, 1);
  assert.equal(evaluatePaperStrategies({ ...input(), confirmedMode: false }).length, 4);
  const a = createPaperStrategyAccount({ nowMs: NOW });
  assert.equal(confirmedAccountGate(a, NOW).lossReview.pauseMs, 0);
  assert.equal(confirmedAccountGate(a, NOW).traderReview.automaticParameterChanges, false);
});

test('review distinguishes cost-only losses, price losses, and net gains, without prediction', () => {
  const s = traderReview([round({ pnl: -.1 }), round({ pnl: -.5, at: NOW - 2000 }), round({ pnl: 1, at: NOW - 3000 })], NOW).overall;
  assert.equal(s.closedRounds, 3); assert.equal(s.costOnlyLosses, 1); assert.equal(s.priceLosses, 1);
  assert.ok(Math.abs(s.netPnlUsd - .4) < 1e-12); assert.ok(Math.abs(s.grossPricePnlUsd - 1) < 1e-12);
  assert.ok(Math.abs(s.profitFactor - 1 / .6) < 1e-12); assert.equal(s.winRate, 1/3);
  assert.ok(Math.abs(s.closedRoundDrawdownUsd - .6) < 1e-12); assert.equal(s.sampleStatus, 'collecting');
});

test('future, unclosed and partial exits do not inflate complete-round statistics', () => {
  const c = input(), opened = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [evaluate(c)], confirmedMode: true, nowMs: NOW });
  assert.equal(confirmedAccountGate(opened, NOW).traderReview.overall.closedRounds, 0);
  const trades = [{ side: 'buy', chain: 'base', address: CA, quantity: 10, atMs: NOW-3000 },
    { side: 'sell', chain: 'base', address: CA, quantity: 5, realizedPnl: 1, atMs: NOW-2000 }];
  assert.equal(completedPaperRounds(trades).length, 0);
  trades.push({ side: 'sell', chain: 'base', address: CA, quantity: 5, realizedPnl: -2, atMs: NOW-1000 });
  const result = traderReview(completedPaperRounds(trades), NOW).overall;
  assert.equal(result.closedRounds, 1); assert.equal(result.netPnlUsd, -1); assert.equal(result.modelCostsUsd, null);
  assert.equal(traderReview([round({ at: NOW + 1 })], NOW).overall.closedRounds, 0);
});

test('versions and chains are separate; legacy records are not relabeled or mutated', () => {
  const rows = [round(), round({ version: 'legacy_unversioned' }), round({ chain: 'bsc' })];
  const before = structuredClone(rows), review = traderReview(rows, NOW);
  assert.equal(review.cohorts.length, 3); assert.deepEqual(rows, before);
  assert.equal(review.overall.closedRounds, 3); assert.equal(review.automaticParameterChanges, false);
});

test('contiguous chart-window entries form a new cohort without relabeling legacy rounds',()=>{
  const old=round(),recent=round();recent.entry.entryEvidence.recoveryEntry={version:'paper_recovery_v1',chartWindowPolicy:'contiguous_tail_v1'};
  old.entry.entryEvidence.recoveryEntry={version:'paper_recovery_v1'};
  const before=structuredClone([old,recent]),review=traderReview([old,recent],NOW);
  assert.equal(review.cohorts.length,2);assert.equal(review.cohorts[0].chartWindowPolicy,undefined);
  assert.equal(review.cohorts[1].chartWindowPolicy,'contiguous_tail_v1');assert.deepEqual([old,recent],before);
});

test('per-route recovery selection is a new review cohort, not a rewrite of old results',()=>{
  const old=round(),recent=round();recent.entry.entryEvidence.routeSelectionVersion='recovery_per_route_v1';
  const before=structuredClone([old,recent]),review=traderReview([old,recent],NOW);
  assert.equal(review.cohorts.length,2);assert.equal(review.cohorts[0].routeSelectionVersion,undefined);
  assert.equal(review.cohorts[1].routeSelectionVersion,'recovery_per_route_v1');assert.deepEqual([old,recent],before);
});

test('zero/no-loss samples keep undefined ratios unknown, not infinity or a success claim', () => {
  const empty = traderReview([], NOW).overall, winner = traderReview([round()], NOW).overall;
  assert.equal(empty.averageNetUsd, null); assert.equal(empty.winRate, null);
  assert.equal(winner.profitFactor, null); assert.equal(winner.payoffRatio, null);
  assert.equal(winner.sampleStatus, 'collecting');
});

test('sample milestone allows review only and never promotes profitable historical cohorts', () => {
  const rounds = Array.from({ length: 30 }, (_, i) => round({ at: NOW - (29-i)*10800000, address: `0x${String(i%10).repeat(40)}` }));
  const result = traderReview(rounds, NOW);
  assert.equal(result.cohorts[0].sampleStatus, 'ready_for_review');
  assert.equal(result.automaticParameterChanges, false); assert.match(result.nextStep, /不自动晋升/);
  assert.equal(traderReview(rounds.slice(1), NOW).cohorts[0].sampleStatus, 'collecting');
});

test('already-blocked scan rows do not allocate verbose decision reports', () => {
  const c = input(); c.flow.fresh = false;
  const row = evaluate(c);
  assert.notEqual(row.decision, '可模拟'); assert.equal(row.evidence.traderDecision, undefined);
  assert.equal(traderDecision(row, NOW).questions.length, 4, 'displayed candidate can still explain its blockers');
});

test('stop shortfalls and missing quote evidence stay distinct without causal guesses', () => {
  const r = round(); r.exits[0] = { reason: '价格止损', price: .8, costsUsd: .1, exitEvidence: { activeStopPrice: .9 } };
  const s = traderReview([r], NOW).overall;
  assert.equal(s.stopShortfalls, 1); assert.equal(s.stopExitsWithoutQuotePath, 1);
});

test('decision renderer escapes untrusted source text and legacy positions still render', () => {
  const row = evaluate(input()), d = row.evidence.traderDecision;
  d.questions[0].text = '<img src=x onerror=alert(1)>';
  const html = renderStrategyDetails(row.evidence.entryPlan, null, { entryEvidence: { traderDecision: d } });
  assert.match(html, /为什么现在买/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img/);
  assert.doesNotThrow(() => renderStrategyDetails(row.evidence.entryPlan, null));
});
