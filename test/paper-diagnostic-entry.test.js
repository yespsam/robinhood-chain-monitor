import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePaperStrategies, createPaperStrategyAccount, advancePaperStrategyAccount, validatePaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { paperEntryFunnel } from '../src/paper-entry-funnel.js';
const NOW = Date.parse('2026-09-23T00:00:00Z'), CA = `0x${'a'.repeat(40)}`;
const iso = t => new Date(t).toISOString();
function input() { return { nowMs: NOW, marketStatus: 'ok', observedAt: iso(NOW), priceObservedAt: iso(NOW),
  requireFastQuote: true, allowExploratory: true, pvpMode: true, diagnosticMode: true, compoundingCash: 100,
  token: { chain: 'base', address: CA, symbol: 'OFFLINE_TEST', price: 1, liquidity: 20000, volume: 1000,
    buyTax: 0, sellTax: 0, isHoneypot: false, top10HolderRate: .8, canMint: true },
  flow: { fresh: true, complete: true, status: 'healthy', observedAt: iso(NOW), uniqueBuyerCount: 1,
    netBuyUsd: 5, smartMoneyCount: 0, highProfitCount: 0, fomoCount: 0 } }; }
const evaluate = c => evaluatePaperStrategies(c)[0];
test('diagnostic mode records rather than invents technical setups, narratives and risk screening', () => {
  const c = input(), row = evaluate(c);
  assert.equal(row.decision, '可模拟'); assert.equal(row.entryUsd, 2); assert.equal(evaluatePaperStrategies(c).length, 1);
  assert.equal(row.evidence.chart.ready, false); assert.equal(row.evidence.safety.metrics.rugRatio, null);
  assert.ok(row.evidence.diagnostic.warnings.includes('Top10 集中度超过筛选线'));
  assert.ok(row.evidence.diagnostic.warnings.includes('可任意增发'));
  assert.ok(row.evidence.diagnostic.baseline.missing.includes('新鲜且足够的 K 线'));
  assert.equal(row.evidence.flow.smartMoneyCount, 0); assert.equal(row.evidence.narrativeFresh, false);
  assert.match(row.entryLogic, /不标为审计通过/); assert.equal(paperEntryFunnel([row]).eligible, 1);
  assert.notEqual(evaluate({ ...c, diagnosticMode: false }).decision, '可模拟');
});
test('freshness, real net buyers, impossible fills and cost arithmetic are not bypassed', () => {
  const changes = [c => c.observedAt = iso(NOW - 120001), c => c.priceObservedAt = iso(NOW - 5001),
    c => c.priceObservedAt = iso(NOW + 1), c => c.token.price = 0, c => c.token.address = 'invalid',
    c => c.token.liquidity = 0, c => c.token.buyTax = null, c => c.token.sellTax = 1,
    c => c.token.isHoneypot = true, c => c.token.cannotSell = true, c => c.token.fakePool = true,
    c => c.flow.complete = false, c => c.flow.fresh = false, c => c.flow.netBuyUsd = 0,
    c => c.flow.uniqueBuyerCount = null, c => c.token.chain = 'eth'];
  for (const change of changes) { const c = input(); change(c); assert.notEqual(evaluate(c).decision, '可模拟', String(change)); }
});
test('explicit diagnostic authority required; actual buy, serialization, five-percent stop and bounded re-entry work', () => {
  const c = input(), row = evaluate(c), empty = createPaperStrategyAccount({ nowMs: NOW });
  assert.equal(advancePaperStrategyAccount(empty, { evaluations: [row], nowMs: NOW }).trades.length, 0);
  let account = advancePaperStrategyAccount(empty, { evaluations: [row], diagnosticMode: true, nowMs: NOW });
  assert.equal(account.cash, 98); assert.equal(account.trades.length, 1);
  account = JSON.parse(JSON.stringify(account)); assert.equal(validatePaperStrategyAccount(account), true);
  const at = NOW + 1000;
  const closed = advancePaperStrategyAccount(account, { marks: [{ ...c.token, price: .94, status: 'ok', observedAt: iso(at) }], enabled: false, nowMs: at });
  assert.equal(closed.trades.length, 2); assert.equal(Object.keys(closed.positions).length, 0);
  assert.ok(closed.realizedPnl < 0); assert.equal(closed.cooldowns[`base:${CA}`], at + 45000);
  for (const flag of ['execution', 'signing', 'broadcast']) assert.equal(closed[flag], false);
  const damaged = structuredClone(account); Object.values(damaged.positions)[0].entryEvidence.diagnostic.version = 'unknown';
  assert.throws(() => validatePaperStrategyAccount(damaged), /diagnostic/);
});
test('diagnostic reward/risk observation keeps the explicit scan tax cap', () => {
  const c = input(); c.token.buyTax = .06; c.token.sellTax = .06;
  const row = evaluate(c); assert.equal(row.decision, '可模拟');
  assert.ok(row.evidence.entryPlan.netRewardRisk < 1.5);
  const account = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [row], diagnosticMode: true, nowMs: NOW });
  assert.equal(account.trades.length, 1); assert.equal(validatePaperStrategyAccount(account), true);
  for (const field of ['buyTax', 'sellTax']) for (const value of [.060001, .3]) {
    const high = input(); high.token[field] = value;
    const blocked = evaluate(high); assert.equal(blocked.decision, '不买');
    assert.ok(blocked.reasons.some(reason => reason.includes('税超过 6%')));
    assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [blocked], diagnosticMode: true, nowMs: NOW }).trades.length, 0);
  }
});
