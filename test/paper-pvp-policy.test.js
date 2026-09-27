import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePaperStrategies, createPaperStrategyAccount, advancePaperStrategyAccount, validatePaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { PVP_EXIT_POLICY } from '../src/paper-pvp-policy.js';
import { breakoutCandles } from './fixtures/paper-strategy-v2.js';
import { renderStrategyDetails } from '../dashboard/strategy-details.js';
const NOW = Date.parse('2026-09-20T10:00:00Z'), CA = `0x${'a'.repeat(40)}`;
const iso = at => new Date(at).toISOString();
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const input = () => ({ pvpMode: true, nowMs: NOW, marketStatus: 'ok', observedAt: iso(NOW), klineStatus: 'ok', candles: breakoutCandles(NOW),
  token: { chain: 'robinhood', address: CA, symbol: 'OFFLINE_TEST', price: 1, marketStage: 'internal', liquidity: 60000, volume: 10000,
    isHoneypot: false, isWashTrading: false, rugRatio: .01, top10HolderRate: .15, devTeamHoldRate: .02, bundlerRate: .01, buyTax: 0, sellTax: 0 },
  flow: { fresh: true, complete: true, status: 'healthy', observedAt: iso(NOW), highProfitCount: 6, fomoCount: 3, uniqueBuyerCount: 10, smartMoneyCount: 4, netBuyUsd: 6000 } });
const evaluation = () => evaluatePaperStrategies(input()).find(e => e.strategyId === 'internal');
const open = () => advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [evaluation()], nowMs: NOW });
const step = (account, price, ms, extra = {}) => advancePaperStrategyAccount(account, { marks: [{ chain: 'robinhood', address: CA, price, status: 'ok', observedAt: iso(NOW + ms), ...extra }], nowMs: NOW + ms, enabled: false });
const held = a => Object.values(a.positions)[0];

test('PVP requires five-second quotes without removing safety, flow or chart gates', () => {
  assert.equal(evaluation().decision, '可模拟');
  for (const mutate of [i => { i.priceObservedAt = iso(NOW - 5001); }, i => { delete i.token.isHoneypot; },
    i => { i.flow.complete = false; }, i => { i.candles = []; }]) {
    const i = input(); mutate(i); assert.ok(evaluatePaperStrategies(i).every(e => e.decision !== '可模拟'));
  }
  const e = evaluation(); e.observedAt = iso(NOW - 5001);
  assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [e], nowMs: NOW }).trades.length, 0);
  assert.throws(() => evaluatePaperStrategies({ ...input(), upsideMode: true }));
});

test('missing auxiliary audits permit only a small PVP paper experiment without fabricating safe values', () => {
  const i = input(); i.allowExploratory = true;
  for (const field of ['isWashTrading', 'rugRatio', 'top10HolderRate', 'devTeamHoldRate', 'bundlerRate']) delete i.token[field];
  const e = evaluatePaperStrategies(i).find(e => e.strategyId === 'internal');
  assert.equal(e.decision, '可模拟', JSON.stringify(e.reasons)); assert.equal(e.entryTier, 'exploratory'); assert.equal(e.entryUsd, 2);
  assert.equal(e.evidence.safety.auditMissing.length, 5); assert.equal(e.evidence.safety.auditComplete, false);
  assert.equal(e.evidence.safety.metrics.rugRatio, null); assert.match(e.entryLogic, /不标为审计通过/);
  const account = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [e], nowMs: NOW });
  assert.equal(account.trades.length, 1);
  assert.equal(held(account).entryEvidence.safety.policyVersion, 'pvp_aux_audit_v1');
  validatePaperStrategyAccount(JSON.parse(JSON.stringify(account)));
  for (const changes of [{ pvpMode: false }, { allowExploratory: false }]) {
    assert.ok(evaluatePaperStrategies({ ...i, ...changes }).every(e => e.decision !== '可模拟'));
  }
  for (const tokenPatch of [{ sellTax: null }, { buyTax: null }, { isHoneypot: null }, { cannotSell: true }, { isHoneypot: true },
    { isWashTrading: true }, { liquidity: 0 }, { canMint: true }, { canFreeze: true }, { rugRatio: 2 }, { rugRatio: .4 }, { top10HolderRate: .9 }]) {
    assert.ok(evaluatePaperStrategies({ ...i, token: { ...i.token, ...tokenPatch } }).every(e => e.decision !== '可模拟'), JSON.stringify(tokenPatch));
  }
});

test('PVP does not scalp the structure target and abandons cost-negative positions after 45 seconds', () => {
  let a = open();
  a = step(a, 1.01, 44999); assert.equal(a.trades.length, 1);
  a = step(a, 1.01, 45000); assert.equal(held(a), undefined); assert.ok(a.realizedPnl < 0);
  assert.match(a.trades.at(-1).reason, /45 秒/);
  const e = held(open());
  const before = step(open(), e.exitPlan.referenceTargetPrice, 1000);
  assert.equal(before.trades.length, 1);
  assert.match(renderStrategyDetails(e.entryEvidence.entryPlan, null, e), /PVP 兑现规则/);
});

test('PVP core expires at three minutes even if profitable; a price rise alone is not fresh continuation', () => {
  for (const price of [1.1, 1.2]) {
    const a = step(open(), price, 180000); assert.equal(held(a), undefined);
    assert.match(a.trades.at(-1).reason, /主仓 3 分钟/);
  }
  let a = step(open(), 1.2, 177000); a = step(a, 1.2, 180000);
  assert.equal(held(a), undefined, 'flat consecutive quotes cannot extend core');
});

test('PVP strong continuation keeps at most original 20%, never sells its tiers again and has a 20-minute cap', () => {
  let a = open(); const qty = held(a).quantity;
  a = step(a, 1.19, 177000); a = step(a, 1.2, 180000);
  close(held(a).quantity, qty * .2); assert.ok(held(a).pvpRunnerStartedAt);
  assert.equal(a.trades.length, 2);
  a = step(a, 3, 183000); close(held(a).quantity, qty * .2); assert.equal(a.trades.length, 2);
  a = step(a, 3.1, 1200000); assert.equal(held(a), undefined); assert.match(a.trades.at(-1).reason, /20 分钟/);
  assert.equal(validatePaperStrategyAccount(a), true);
});

test('PVP fast 2x/3x pays each modeled cost once, leaves 20%, then follows 12% drawdown', () => {
  let a = open(); const qty = held(a).quantity;
  a = step(a, 2, 3000); close(held(a).quantity, qty * .5);
  a = step(a, 3, 6000); close(held(a).quantity, qty * .2); assert.equal(a.trades.length, 3);
  a = step(a, 3, 9000); assert.equal(a.trades.length, 3);
  a = step(a, 2.65, 12000); assert.ok(held(a));
  a = step(a, 2.63, 15000); assert.equal(held(a), undefined); assert.equal(a.trades.at(-1).price, 2.63);
  assert.equal(a.trades.at(-1).exitEvidence.exitPolicyVersion, PVP_EXIT_POLICY.version);
  assert.ok(a.trades.every(t => t.costsUsd > 0));
  const gap = step(open(), 10, 3000); close(held(gap).quantity, qty * .2); assert.equal(gap.trades.length, 3);
});

test('PVP never uses old or repeated observations as a timed fill; fresh gaps use real observed loss', () => {
  let a = step(open(), 1, 44000);
  a = step(a, 1, 45000, { observedAt: iso(NOW + 44000) }); assert.equal(a.trades.length, 1);
  a = step(a, .5, 60000, { observedAt: iso(NOW + 44000) }); assert.equal(a.trades.length, 1);
  a = step(a, .5, 61000); assert.equal(a.trades.at(-1).price, .5); assert.ok(a.realizedPnl < 0);
  assert.equal(held(a), undefined);
});

test('PVP metadata survives JSON and rejects tampering or shadow-account leakage', () => {
  const a = JSON.parse(JSON.stringify(open())); assert.equal(validatePaperStrategyAccount(a), true);
  for (const mutate of [p => { p.pvpPolicy.coreHoldMs = 999999; }, p => { delete p.pvpPolicy; },
    p => { p.entryEvidence.exitPolicy.runnerFraction = .8; }, p => { p.firstTargetTaken = true; },
    p => { p.pvpRunnerStartedAt = iso(NOW); }]) {
    const bad = structuredClone(a); mutate(held(bad)); assert.throws(() => validatePaperStrategyAccount(bad));
  }
  const shadow = createPaperStrategyAccount({ nowMs: NOW }); shadow.variant = 'learning_control';
  assert.equal(advancePaperStrategyAccount(shadow, { evaluations: [evaluation()], nowMs: NOW }).trades.length, 0);
  const bad = evaluation(); bad.evidence.exitPolicy.runnerHoldMs = 700000000;
  assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [bad], nowMs: NOW }).trades.length, 0);
});
