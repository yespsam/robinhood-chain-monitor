import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePaperStrategies, createPaperStrategyAccount, advancePaperStrategyAccount, validatePaperStrategyAccount, STRATEGY_POLICIES } from '../src/paper-strategy-engine.js';
import { UPSIDE_EXIT_POLICY, validUpsideExitPolicy } from '../src/paper-upside-policy.js';
import { renderStrategyDetails } from '../dashboard/strategy-details.js';
import { breakoutCandles } from './fixtures/paper-strategy-v2.js';
const NOW = Date.parse('2026-09-20T10:00:00Z'), CA = `0x${'a'.repeat(40)}`;
const iso = at => new Date(at).toISOString();
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const input = (upsideMode = true) => ({ upsideMode, nowMs: NOW, marketStatus: 'ok', observedAt: iso(NOW), klineStatus: 'ok', candles: breakoutCandles(NOW),
  token: { chain: 'robinhood', address: CA, symbol: 'OFFLINE_TEST', price: 1, marketStage: 'internal', liquidity: 60000, volume: 10000,
    isHoneypot: false, isWashTrading: false, rugRatio: .01, top10HolderRate: .15, devTeamHoldRate: .02, bundlerRate: .01, buyTax: 0, sellTax: 0 },
  flow: { fresh: true, complete: true, status: 'healthy', observedAt: iso(NOW), highProfitCount: 6, fomoCount: 3, uniqueBuyerCount: 10, smartMoneyCount: 4, netBuyUsd: 6000 } });
const evaluation = upside => evaluatePaperStrategies(input(upside)).find(e => e.strategyId === 'internal');
const open = (upside = true) => advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [evaluation(upside)], nowMs: NOW });
const mark = (price, at, extra = {}) => ({ chain: 'robinhood', address: CA, price, status: 'ok', observedAt: iso(at), ...extra });
const step = (account, price, at, extra = {}) => advancePaperStrategyAccount(account, { marks: [mark(price, at, extra)], nowMs: at, enabled: false });
const held = a => Object.values(a.positions)[0];

test('upside changes only exit objective: same entry gates, no small-target or 2x selling', () => {
  assert.equal(evaluation(true).decision, '可模拟');
  assert.equal(evaluation(false).decision, '可模拟');
  for (const mode of [false, true]) {
    const unknown = input(mode); delete unknown.token.isHoneypot;
    assert.notEqual(evaluatePaperStrategies(unknown)[0].decision, '可模拟');
    const noFlow = input(mode); noFlow.flow.complete = false;
    assert.notEqual(evaluatePaperStrategies(noFlow)[0].decision, '可模拟');
  }
  let a = open(), quantity = held(a).quantity;
  const reference = held(a).exitPlan.referenceTargetPrice;
  a = step(a, reference, NOW + 1000); close(held(a).quantity, quantity); assert.equal(a.trades.length, 1);
  a = step(a, 1.6, NOW + 2000); assert.equal(held(a).profitProtectionArmed, false);
  a = step(a, 2, NOW + 3000); assert.equal(held(a).profitProtectionArmed, true); assert.equal(a.trades.length, 1);
  close(held(a).quantity, quantity); assert.equal(held(a).firstTargetTaken, false);
  assert.match(renderStrategyDetails(held(a).entryEvidence.entryPlan, null, held(a)), /结构参考位（不触发减仓）/);
});

test('upside 3/10/30 sells original 20% each once, retains 40% above 1000x and trails on observed price', () => {
  let a = open(); const original = held(a).quantity;
  for (const [index, price] of [3, 10, 30].entries()) {
    const at = NOW + (index + 1) * 1000;
    a = step(a, price, at); close(held(a).quantity, original * (1 - (index + 1) * .2));
    assert.equal(a.trades.length, index + 2);
    const again = step(a, price, at + 1); assert.equal(again.trades.length, a.trades.length); a = again;
  }
  assert.deepEqual(held(a).profitTiersTaken, [3, 10, 30]);
  a = step(a, 1001, NOW + 5000); close(held(a).quantity, original * .4); assert.equal(a.trades.length, 4);
  a = step(a, 760, NOW + 6000); assert.ok(held(a));
  a = step(a, 750, NOW + 7000); assert.equal(held(a), undefined);
  assert.equal(a.trades.at(-1).price, 750); assert.match(a.trades.at(-1).reason, /回撤/);
  assert.equal(a.trades.at(-1).exitEvidence.exitPolicyVersion, UPSIDE_EXIT_POLICY.version);
  assert.equal(validatePaperStrategyAccount(a), true);
});

test('upside gap across tiers records actual marks and each fee without duplicate partials', () => {
  let a = open(); const original = held(a).quantity;
  a = step(a, 50, NOW + 1000);
  assert.equal(a.trades.length, 4); close(held(a).quantity, original * .4);
  for (const t of a.trades.slice(1)) { assert.equal(t.price, 50); close(t.quantity, original * .2); assert.ok(t.costsUsd > 0); }
  a = step(a, 50, NOW + 2000); assert.equal(a.trades.length, 4);
});

test('upside does not loosen structural stops, stale quotes do not exit, and gap losses are real', () => {
  let a = open(); const stop = held(a).activeStopPrice;
  a = step(a, stop - .01, NOW + 1000); assert.equal(held(a), undefined); assert.ok(a.realizedPnl < 0);
  a = step(open(), 2, NOW + 1000); const protectedStop = held(a).activeStopPrice;
  a = step(a, 1.9, NOW + 2000); assert.ok(held(a).activeStopPrice >= protectedStop);
  a = step(a, .5, NOW + 3000, { observedAt: iso(NOW - 130000) }); assert.ok(held(a));
  a = step(a, .5, NOW + 4000); assert.equal(held(a), undefined); assert.equal(a.trades.at(-1).price, .5); assert.ok(a.realizedPnl < 0);
});

test('only still-strong upside positions extend beyond weak timeout, absolute seven-day cap remains', () => {
  const expiry = NOW + STRATEGY_POLICIES.find(p => p.id === 'internal').maxHoldMs;
  let weak = step(open(), 1.1, expiry); assert.equal(held(weak), undefined); assert.equal(weak.trades.at(-1).reason, '持仓到期');
  let strong = step(open(), 1.6, expiry); assert.ok(held(strong)); assert.equal(strong.trades.length, 1);
  const fading = step(strong, 1.2, expiry + 1000); assert.equal(held(fading), undefined);
  strong = step(strong, 3, expiry + 2000);
  strong = step(strong, 3, NOW + UPSIDE_EXIT_POLICY.runnerHoldMs); assert.equal(held(strong), undefined);
});

test('upside keeps two fresh same-provider net-outflow confirmations as an invalidation exit', () => {
  let a = open();
  const flow = at => ({ chain: 'robinhood', address: CA, provider: 'gmgn', status: 'healthy', fresh: true, complete: true,
    observedAt: iso(at), netBuyUsd: -4000, smartMoneySellerCount: 3 });
  a = step(a, 1.2, NOW + 1000, { flow: flow(NOW + 1000) }); assert.ok(held(a));
  a = step(a, 1.2, NOW + 31000, { flow: flow(NOW + 31000) }); assert.equal(held(a), undefined);
  assert.match(a.trades.at(-1).reason, /聪明钱连续净卖出/);
});

test('versioned upside holdings survive persistence; tampering rejects and legacy positions stay legacy', () => {
  let a = JSON.parse(JSON.stringify(open())); assert.equal(validatePaperStrategyAccount(a), true);
  a = step(a, 3, NOW + 1000); assert.deepEqual(held(a).profitTiersTaken, [3]);
  for (const mutate of [p => { p.upsidePolicy.profitTiers[0].fraction = .9; }, p => { p.upsidePolicy.version = 'future'; },
    p => { p.firstTargetTaken = true; }, p => { delete p.upsidePolicy; }, p => { p.entryEvidence.exitPolicy.runnerFraction = .9; },
    p => { p.profitTiersTaken = [2]; }]) {
    const bad = structuredClone(a); mutate(held(bad)); assert.throws(() => validatePaperStrategyAccount(bad));
  }
  const badEntry = evaluation(true); badEntry.evidence.exitPolicy.runnerFraction = .9;
  assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { nowMs: NOW, evaluations: [badEntry] }).trades.length, 0);
  const shadow = createPaperStrategyAccount({ nowMs: NOW }); shadow.variant = 'learning_control';
  assert.equal(advancePaperStrategyAccount(shadow, { nowMs: NOW, evaluations: [evaluation(true)] }).trades.length, 0);
  let old = open(false), reference = held(old).exitPlan.referenceTargetPrice;
  old = step(old, reference, NOW + 1000); assert.equal(old.trades.length, 2); assert.equal(held(old).upsidePolicy, undefined);
  assert.equal(validUpsideExitPolicy(UPSIDE_EXIT_POLICY), true);
});
