import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY_POLICIES, evaluatePaperStrategies, createPaperStrategyAccount, advancePaperStrategyAccount, validatePaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { breakoutCandles, sourcedNarrative } from './fixtures/paper-strategy-v2.js';

const NOW = Date.parse('2026-09-20T10:00:00Z');
const CA = `0x${'a'.repeat(40)}`;
const iso = value => new Date(value).toISOString();
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
function input(nowMs = NOW, changes = {}) {
  return {
    nowMs, marketStatus: 'ok', observedAt: iso(nowMs), klineStatus: 'ok',
    token: { chain: 'robinhood', address: CA, symbol: 'TEST', marketStage: 'internal', price: 1, liquidity: 60_000, volume: 10_000, isHoneypot: false, isWashTrading: false, rugRatio: .01, top10HolderRate: .15, devTeamHoldRate: .02, bundlerRate: .01, buyTax: 0, sellTax: 0, launchpad: 'verified_feed_launchpad', creationTimestamp: nowMs - 600_000 },
    flow: { fresh: true, complete: true, status: 'healthy', coverageGap: null, observedAt: iso(nowMs), highProfitCount: 6, fomoCount: 3, uniqueBuyerCount: 10, smartMoneyCount: 4, netBuyUsd: 6_000, wallets: [] },
    narrative: sourcedNarrative(nowMs, 'robinhood', CA),
    candles: breakoutCandles(nowMs),
    ...changes,
  };
}
function evaluation(strategyId = 'internal', nowMs = NOW, change = {}) {
  return evaluatePaperStrategies(input(nowMs, change)).find(item => item.strategyId === strategyId);
}
function open({ initialCash = 100, strategyId = 'internal', nowMs = NOW } = {}) {
  return advancePaperStrategyAccount(createPaperStrategyAccount({ initialCash, nowMs }), { evaluations: [evaluation(strategyId, nowMs)], nowMs });
}
function mark(price, nowMs = NOW + 1_000, extra = {}) { return { chain: 'robinhood', address: CA, price, status: 'ok', observedAt: iso(nowMs), ...extra }; }

test('all strategies reject either tax above 6% while the exact boundary is not a tax block', () => {
  for (const field of ['buyTax', 'sellTax']) for (const value of [.06, .060001, .07]) {
    const i = input(); i.token[field] = value;
    const rows = evaluatePaperStrategies(i);
    for (const row of rows) {
      assert.equal(row.evidence.safety.taxFilter.blocked, value > .06);
      if (value > .06) {
        assert.equal(row.decision, '不买'); assert.ok(row.reasons.some(r => r.includes('税超过 6%')));
      }
    }
    if (value > .06) assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: rows, nowMs: NOW }).trades.length, 0);
  }
});

test('ledger rechecks entry tax even for an otherwise eligible or older decision', () => {
  assert.equal(evaluation().decision, '可模拟');
  for (const field of ['buyTax', 'sellTax']) for (const value of [.060001, .07, null, false, [], '6%']) {
    const row = evaluation(); row.evidence.costAssumptions[field] = value;
    const result = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [row], nowMs: NOW });
    assert.equal(result.trades.length, 0, `${field}: ${String(value)}`);
  }
});

test('new tax filter never invalidates an old holding or disables its mark and exit processing', () => {
  const opened = open(), key = `robinhood:${CA}`;
  opened.positions[key].costAssumptions.sellTax = .07;
  assert.equal(validatePaperStrategyAccount(opened), true);
  const marked = advancePaperStrategyAccount(opened, { marks: [mark(1.01)], nowMs: NOW + 1000 });
  assert.equal(marked.positions[key].markPrice, 1.01);
  const exited = advancePaperStrategyAccount(marked, { marks: [mark(.5, NOW + 2000)], nowMs: NOW + 2000 });
  assert.equal(exited.trades.at(-1).side, 'sell'); assert.equal(Object.keys(exited.positions).length, 0);
  assert.deepEqual(exited.trades[0], opened.trades[0]);
});

function exploratoryInput() {
  const candidate = input(); candidate.allowExploratory = true;
  Object.assign(candidate.flow, { highProfitCount: 0, fomoCount: 0, uniqueBuyerCount: 2, smartMoneyCount: 1, netBuyUsd: 600 });
  return candidate;
}
test('explicit small exploratory tier uses v2 signal gates and keeps strong signals on standard budgets', () => {
  const candidate = exploratoryInput(), results = evaluatePaperStrategies(candidate);
  for (const r of results.filter(r => r.strategyId !== 'narrative_pvp')) {
    assert.equal(r.decision, '可模拟'); assert.equal(r.entryUsd, 2); assert.equal(r.evidence.entryTier, 'exploratory');
    assert.equal(r.evidence.flow.highProfitCount, 0); assert.equal(r.evidence.entryThresholds.minHighProfit, 0);
    assert.equal(r.evidence.entryPolicyVersion, 'paper_exploration_v2');
    assert.match(r.entryLogic, /标签不代表已核实盈利/);
  }
  assert.ok(evaluatePaperStrategies({ ...candidate, allowExploratory: false }).every(r => r.decision === '观察'));
  assert.ok(evaluatePaperStrategies({ ...input(), allowExploratory: true }).every(r => r.entryTier === 'standard'));
  candidate.token.marketStage = 'external';
  assert.equal(evaluatePaperStrategies(candidate).find(r => r.strategyId === 'narrative_pvp').decision, '可模拟');
  candidate.narrative = {}; assert.equal(evaluatePaperStrategies(candidate).find(r => r.strategyId === 'narrative_pvp').decision, '观察');
});
test('exploratory boundaries retain complete sources, a smart net buyer, real inflow, safety, chart and quote gates', () => {
  for (const patch of [{ uniqueBuyerCount: 0 }, { smartMoneyCount: 0 }, { netBuyUsd: 199.99 }, { netBuyUsd: -1 },
    { highProfitCount: null }, { complete: false }, { fresh: false }, { observedAt: iso(NOW - 120001) }, { coverageGap: 'gap' }]) {
    const c = exploratoryInput(); Object.assign(c.flow, patch);
    assert.ok(evaluatePaperStrategies(c).every(r => r.decision !== '可模拟'), JSON.stringify(patch));
  }
  for (const patch of [{ isHoneypot: true }, { cannotSell: true }, { rugRatio: null }, { liquidity: 4999 }, { bundlerRate: .5 }]) {
    const c = exploratoryInput(); Object.assign(c.token, patch);
    assert.ok(evaluatePaperStrategies(c).every(r => r.decision !== '可模拟'), JSON.stringify(patch));
  }
  const c = exploratoryInput();
  assert.ok(evaluatePaperStrategies({ ...c, candles: [] }).every(r => r.decision !== '可模拟'));
  assert.ok(evaluatePaperStrategies({ ...c, requireFastQuote: true, priceObservedAt: iso(NOW - 15001) }).every(r => r.decision !== '可模拟'));
  const eth = exploratoryInput(); eth.token.chain = 'eth';
  assert.ok(evaluatePaperStrategies(eth).every(r => r.decision !== '可模拟'));
  Object.assign(c.flow, { uniqueBuyerCount: 1, smartMoneyCount: 1, netBuyUsd: 200 });
  c.token.liquidity = 5000;
  assert.equal(evaluatePaperStrategies(c)[0].decision, '可模拟');
  assert.equal(evaluatePaperStrategies(c)[1].decision, '观察');
  c.token.liquidity = 10000;
  assert.equal(evaluatePaperStrategies(c)[1].decision, '可模拟');
  assert.match(evaluatePaperStrategies(c)[1].entryLogic, /单钱包不是多地址共振/);
  for (const priceObservedAt of [null, iso(NOW - 5001), iso(NOW + 1)]) {
    assert.ok(evaluatePaperStrategies({ ...c, pvpMode: true, priceObservedAt }).every(r => r.decision !== '可模拟'));
  }
  assert.equal(evaluatePaperStrategies({ ...c, pvpMode: true, priceObservedAt: iso(NOW) })[1].decision, '可模拟');
});
test('v1 exploration holdings restore and exit, but old or unknown entry decisions cannot create v2 trades', () => {
  const r = evaluatePaperStrategies(exploratoryInput())[0];
  const account = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [r], nowMs: NOW });
  const old = structuredClone(account);
  Object.values(old.positions)[0].entryEvidence.entryPolicyVersion = 'paper_exploration_v1';
  assert.equal(validatePaperStrategyAccount(old), true);
  const closed = advancePaperStrategyAccount(old, { marks: [mark(.8)], enabled: false, nowMs: NOW + 1000 });
  assert.equal(Object.keys(closed.positions).length, 0);
  assert.equal(closed.trades.at(-1).price, .8);
  assert.equal(closed.trades.at(-1).exitEvidence.activeStopPrice, Object.values(old.positions)[0].activeStopPrice);
  assert.equal(Object.values(old.positions)[0].entryEvidence.entryPolicyVersion, 'paper_exploration_v1');
  for (const version of ['paper_exploration_v1', 'unknown']) {
    const decision = structuredClone(r); decision.evidence.entryPolicyVersion = version;
    assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [decision], nowMs: NOW }).trades.length, 0);
  }
  Object.values(old.positions)[0].entryEvidence.entryPolicyVersion = 'unknown';
  assert.throws(() => validatePaperStrategyAccount(old), /exploratory budget/);
});
test('exploration never increases the two-dollar budget and survives persistence with original stop-loss protection', () => {
  const candidate = exploratoryInput(), r = evaluatePaperStrategies(candidate)[0];
  const result = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [{ ...r, entryUsd: 8 }], nowMs: NOW });
  assert.equal(result.cash, 98); assert.equal(result.trades.length, 1);
  const p = Object.values(result.positions)[0]; assert.equal(p.entryUsd, 2); assert.equal(p.entryEvidence.entryTier, 'exploratory');
  const restored = JSON.parse(JSON.stringify(result)); assert.equal(validatePaperStrategyAccount(restored), true);
  const stopped = advancePaperStrategyAccount(restored, { marks: [mark(.8)], enabled: false, nowMs: NOW + 1000 });
  assert.equal(Object.keys(stopped.positions).length, 0); assert.ok(stopped.realizedPnl < 0);
  const invalid = structuredClone(restored); Object.values(invalid.positions)[0].entryUsd = 8;
  assert.throws(() => validatePaperStrategyAccount(invalid), /exploratory budget/);
});

test('cash compounding rechecks each fill, preserves costs and does not compound open-position marks', () => {
  const candidate = { ...exploratoryInput(), compoundingCash: 100 };
  const first = evaluatePaperStrategies(candidate)[0];
  const second = evaluatePaperStrategies({ ...candidate, token: { ...candidate.token, address: `0x${'b'.repeat(40)}` } })[0];
  let account = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [first, second], nowMs: NOW });
  assert.deepEqual(account.trades.map(t => t.costBasisUsd), [2, 1.96]);
  closeTo(account.cash, 96.04);
  const p = Object.values(account.positions)[1];
  assert.equal(p.entryEvidence.positionSizing.cashBeforeEntry, 98);
  assert.equal(p.entryEvidence.positionSizing.signalBudgetCapUsd, 2);
  closeTo(p.entryEvidence.costAssumptions.notionalUsd, p.quantity);
  assert.equal(validatePaperStrategyAccount(JSON.parse(JSON.stringify(account))), true);
  const quantities = Object.values(account.positions).map(p => p.quantity);
  account = advancePaperStrategyAccount(account, { evaluations: [first], marks: [mark(1.1, NOW), mark(1.1, NOW, { address: `0x${'b'.repeat(40)}` })], nowMs: NOW });
  assert.equal(account.trades.length, 2); assert.deepEqual(Object.values(account.positions).map(p => p.quantity), quantities);
  closeTo(account.cash, 96.04); assert.ok(account.stats.unrealizedPnl > 0);
  for (const bad of [{ ...first, entryUsd: 20 }, { ...first, evidence: { ...first.evidence, positionSizing: { ...first.evidence.positionSizing, entryFraction: .2 } } }]) {
    assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [bad], nowMs: NOW }).trades.length, 0);
  }
  const thin = { ...candidate, compoundingCash: 79 };
  const nearLimit = [evaluatePaperStrategies(thin)[0], evaluatePaperStrategies({ ...thin, token: { ...thin.token, address: `0x${'b'.repeat(40)}` } })[0]];
  assert.ok(nearLimit.every(r => r.decision === '可模拟'));
  const bounded = advancePaperStrategyAccount(createPaperStrategyAccount({ initialCash: 79, nowMs: NOW }), { evaluations: nearLimit, nowMs: NOW });
  assert.equal(bounded.trades.length, 1, 'smaller second fill must pass its own cost-aware reward/risk again');
});
test('only realized sale proceeds fund larger subsequent entries; loss shrinks budgets and safety gates remain', () => {
  for (const [exitPrice, direction] of [[1.9, 1], [.8, -1]]) {
    const initial = { ...exploratoryInput(), compoundingCash: 100 };
    let account = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [evaluatePaperStrategies(initial)[0]], nowMs: NOW });
    const later = NOW + 46 * 60000;
    account = advancePaperStrategyAccount(account, { marks: [mark(exitPrice, later)], nowMs: later });
    assert.equal(Object.keys(account.positions).length, 0); assert.ok(direction * account.realizedPnl > 0);
    const candidate = { ...input(later), allowExploratory: true, compoundingCash: account.cash };
    candidate.flow = { ...candidate.flow, highProfitCount: 0, fomoCount: 0, uniqueBuyerCount: 2, smartMoneyCount: 1, netBuyUsd: 600 };
    candidate.token.address = `0x${'b'.repeat(40)}`;
    const entry = evaluatePaperStrategies(candidate)[0]; assert.ok(direction * (entry.entryUsd - 2) > 0);
    const next = advancePaperStrategyAccount(account, { evaluations: [entry], nowMs: later });
    assert.equal(next.trades.length, 3); assert.equal(next.trades.at(-1).costBasisUsd, Math.floor((account.cash * .02 + 1e-9) * 100) / 100);
    candidate.token.isHoneypot = true; assert.equal(evaluatePaperStrategies(candidate)[0].decision, '不买');
  }
  for (const compoundingCash of [0, NaN, -1]) {
    assert.ok(evaluatePaperStrategies({ ...exploratoryInput(), compoundingCash }).every(r => r.decision !== '可模拟'));
  }
  const large = { ...exploratoryInput(), compoundingCash: 1000 };
  const entry = evaluatePaperStrategies(large)[0]; assert.equal(entry.entryUsd, 20);
  const account = advancePaperStrategyAccount(createPaperStrategyAccount({ initialCash: 1000, nowMs: NOW }), { evaluations: [entry], nowMs: NOW });
  assert.equal(account.cash, 980); assert.equal(validatePaperStrategyAccount(account), true);
});

test('distilled exits are frozen per entry, never loosen original gates, and remain paper-only', () => {
  const policy = { version: '1234567890abcdef', chain: 'robinhood', group: 'gmgn_fomo', maxHoldMs: 120000, lossCutRate: .06,
    teacherCount: 3, matchedSells: 30, trainedAt: iso(NOW), trainingEndAt: iso(NOW - 1) };
  const empty = { ...createPaperStrategyAccount({ nowMs: NOW }), variant: 'distilled_shadow' };
  assert.equal(advancePaperStrategyAccount(empty, { evaluations: [evaluation()], nowMs: NOW }).trades.length, 0);
  const unsafe = input(); unsafe.token.isHoneypot = true;
  assert.equal(advancePaperStrategyAccount(empty, { evaluations: evaluatePaperStrategies(unsafe), distilledPolicy: policy, nowMs: NOW }).trades.length, 0);
  const student = advancePaperStrategyAccount(empty, { evaluations: [evaluation()], distilledPolicy: policy, nowMs: NOW });
  const baseline = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [evaluation()], distilledPolicy: policy, nowMs: NOW });
  assert.equal(Object.values(baseline.positions)[0].distilledHabit, undefined);
  const stop = advancePaperStrategyAccount(student, { marks: [mark(.93)], distilledPolicy: { ...policy, lossCutRate: .15 }, nowMs: NOW + 1000 });
  assert.equal(Object.keys(stop.positions).length, 0); assert.equal(stop.trades.at(-1).price, .93); assert.equal(stop.execution, false);
  const damaged = structuredClone(student); delete Object.values(damaged.positions)[0].distilledHabit;
  assert.throws(() => validatePaperStrategyAccount(damaged), /missing distilled/);
  const expired = advancePaperStrategyAccount(student, { nowMs: NOW + 10000000, marks: [] });
  assert.equal(Object.keys(expired.positions).length, 1); assert.equal(Object.values(expired.positions)[0].markStatus, 'stale');
});

test('four independent strategies accept verified stages, not token names', () => {
  const evaluations = evaluatePaperStrategies(input());
  assert.deepEqual(evaluations.map(item => item.strategyId), ['internal', 'smart_money', 'narrative_pvp', 'launch_sniper']);
  assert.equal(evaluations[0].decision, '可模拟');
  assert.equal(evaluations[1].decision, '可模拟');
  assert.equal(evaluations[2].decision, '观察');
  assert.equal(evaluations[3].decision, '可模拟');
  const unknown = input(); unknown.token.marketStage = 'unknown'; unknown.token.symbol = 'pump.fun 内盘毕业';
  assert.ok(evaluatePaperStrategies(unknown).every(item => item.decision === '观察'));
  const conflicted = input(); conflicted.token.stageConflict = true;
  assert.ok(evaluatePaperStrategies(conflicted).every(item => item.decision === '观察'));
});

test('fast entries require a separate fifteen-second quote without renewing research or safety', () => {
  assert.equal(evaluation('internal', NOW, { requireFastQuote: true, priceObservedAt: iso(NOW - 2000) }).decision, '可模拟');
  for (const priceObservedAt of [null, iso(NOW - 15001), iso(NOW + 1)]) {
    const result = evaluation('internal', NOW, { requireFastQuote: true, priceObservedAt });
    assert.equal(result.decision, '观察'); assert.ok(result.missing.includes('十五秒内的独立报价'));
  }
  const result = evaluation('internal', NOW, { requireFastQuote: true, priceObservedAt: iso(NOW), observedAt: iso(NOW - 120001) });
  assert.equal(result.decision, '观察'); assert.equal(result.evidence.marketFresh, false);
});

test('unknown safety and partial flow fail closed without requiring creator_close', () => {
  assert.equal(evaluation().decision, '可模拟');
  for (const field of ['isHoneypot', 'isWashTrading', 'rugRatio', 'top10HolderRate', 'devTeamHoldRate', 'bundlerRate', 'buyTax', 'sellTax']) {
    const candidate = input(); candidate.token[field] = null;
    assert.ok(evaluatePaperStrategies(candidate).every(item => item.decision === '观察'), field);
  }
  for (const change of [{ complete: false }, { fresh: false }, { status: 'partial', coverageGap: 'ambiguous_trade_legs' }, { highProfitCount: null }, { uniqueBuyerCount: 2 }]) {
    const candidate = input(); Object.assign(candidate.flow, change);
    assert.ok(evaluatePaperStrategies(candidate).every(item => item.decision === '观察'));
  }
});

test('Binance FOMO-unavailable is explicit while profitability and safety gates still apply', () => {
  const candidate = input(); Object.assign(candidate.flow, { provider: 'binance_kol', fomoSupported: false, fomoCount: null });
  const result = evaluatePaperStrategies(candidate)[0];
  assert.equal(result.decision, '可模拟'); assert.equal(result.evidence.flow.fomoCount, null); assert.equal(result.evidence.flowDiagnostics.fomoSupported, false);
  candidate.flow.highProfitCount = 0; assert.equal(evaluatePaperStrategies(candidate)[0].decision, '观察');
  candidate.flow.highProfitCount = 6; candidate.flow.provider = 'gmgn'; assert.equal(evaluatePaperStrategies(candidate)[0].decision, '观察');
  candidate.flow.provider = 'binance_kol'; candidate.token.isHoneypot = null; assert.equal(evaluatePaperStrategies(candidate)[0].decision, '观察');
});

test('known hard dangers block all four strategies', () => {
  for (const change of [{ isHoneypot: true }, { isWashTrading: true }, { liquidity: 0 }, { top10HolderRate: .7 }, { devTeamHoldRate: .3 }, { bundlerRate: .5 }, { sellTax: .2 }, { canMint: true }]) {
    const candidate = input(); Object.assign(candidate.token, change);
    assert.ok(evaluatePaperStrategies(candidate).every(item => item.decision === '不买'), JSON.stringify(change));
  }
});

test('out-of-range GMGN risk and tax fractions remain unknown rather than becoming safe percentages', () => {
  for (const field of ['rugRatio', 'top10HolderRate', 'devTeamHoldRate', 'bundlerRate', 'buyTax', 'sellTax']) {
    const candidate = input(); candidate.token[field] = 2;
    const evaluations = evaluatePaperStrategies(candidate);
    assert.ok(evaluations.every(item => item.decision === '观察'), field);
    assert.equal(evaluations[0].evidence.safety.metrics[field], null, field);
    const account = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations, nowMs: NOW });
    assert.equal(account.trades.length, 0, field);
  }
});

test('Solana requires explicit revoked mint and freeze authorities', () => {
  const candidate = input(); Object.assign(candidate.token, { chain: 'sol', address: 'So11111111111111111111111111111111111111112', isHoneypot: null });
  assert.equal(evaluatePaperStrategies(candidate)[0].decision, '观察');
  Object.assign(candidate.token, { renouncedMint: true, renouncedFreezeAccount: true });
  assert.equal(evaluatePaperStrategies(candidate)[0].decision, '可模拟');
  candidate.token.renouncedFreezeAccount = false;
  assert.equal(evaluatePaperStrategies(candidate)[0].decision, '不买');
});

test('narrative lane requires a current source bound to the exact chain and CA', () => {
  const candidate = input(); candidate.token.marketStage = 'external';
  const decision = () => evaluatePaperStrategies(candidate).find(item => item.strategyId === 'narrative_pvp').decision;
  assert.equal(decision(), '可模拟');
  for (const change of [{ caBound: false }, { address: `0x${'b'.repeat(40)}` }, { chain: 'base' }, { sourceAt: iso(NOW + 1) }, { sourceAt: iso(NOW - 86_400_001) }, { sourceUrl: 'javascript:alert(1)' }]) {
    const previous = { ...candidate.narrative }; Object.assign(candidate.narrative, change);
    assert.equal(decision(), '观察'); candidate.narrative = previous;
  }
});

test('future, stale, unavailable and malformed market observations never qualify', () => {
  for (const change of [{ observedAt: iso(NOW + 1) }, { observedAt: iso(NOW - 120_001) }, { marketStatus: 'stale' }, { observedAt: 'not-a-date' }, { klineStatus: 'unavailable' }]) {
    assert.ok(evaluatePaperStrategies(input(NOW, change)).every(item => item.decision === '观察'));
  }
  const candidate = input(); candidate.flow.observedAt = iso(NOW + 1);
  assert.ok(evaluatePaperStrategies(candidate).every(item => item.decision === '观察'));
  candidate.flow.observedAt = iso(NOW); candidate.candles[2].time = NOW + 1;
  assert.ok(evaluatePaperStrategies(candidate).every(item => item.decision === '观察'));
});

test('early lanes use smaller liquidity thresholds but still require real volume and launch age', () => {
  const candidate = input(); candidate.token.liquidity = 12_000;
  assert.equal(evaluatePaperStrategies(candidate)[0].decision, '可模拟');
  assert.equal(evaluatePaperStrategies(candidate)[1].decision, '观察');
  candidate.token.volume = 0;
  assert.equal(evaluatePaperStrategies(candidate)[0].decision, '观察');
  candidate.token.volume = 10_000; candidate.token.creationTimestamp = NOW - 16 * 60_000;
  assert.equal(evaluatePaperStrategies(candidate)[3].decision, '观察');
  candidate.token.creationTimestamp = NOW + 1;
  assert.equal(evaluatePaperStrategies(candidate)[3].decision, '观察');
});

test('trenches hourly volume remains an explicit hourly observation rather than an invented minute volume', () => {
  const candidate = input(); Object.assign(candidate.token, { volume: null, volume1h: 8_000, volume24h: 80_000 });
  const result = evaluatePaperStrategies(candidate)[0];
  assert.equal(result.decision, '可模拟');
  assert.deepEqual(result.evidence.volume, { value: 8_000, window: '1h' });
  candidate.token.volume1h = null;
  assert.deepEqual(evaluatePaperStrategies(candidate)[0].evidence.volume, { value: 80_000, window: '24h' });
});

test('cost assumptions are explicit and Ethereum gas prevents uneconomic tiny entries', () => {
  const entry = evaluation();
  assert.equal(entry.evidence.costAssumptions.source, 'assumption');
  assert.equal(entry.evidence.costAssumptions.feeBps, 30);
  assert.equal(entry.evidence.costAssumptions.slippageBps, 100);
  const candidate = input(); candidate.token.chain = 'eth';
  assert.equal(evaluatePaperStrategies(candidate)[0].decision, '观察');
  assert.ok(evaluatePaperStrategies(candidate)[0].reasons.some(item => item.includes('往返成本')));
});

test('entry budgets include costs and ledger preserves buy evidence without mutating input', () => {
  const initial = createPaperStrategyAccount({ nowMs: NOW });
  const result = advancePaperStrategyAccount(initial, { evaluations: [evaluation()], nowMs: NOW });
  const position = Object.values(result.positions)[0];
  assert.equal(initial.cash, 100); assert.equal(Object.keys(initial.positions).length, 0);
  assert.equal(result.cash, 95); assert.equal(position.costBasisUsd, 5);
  closeTo(position.quantity, (5 - .02) / 1.013);
  closeTo(position.entryCostsUsd, 5 - position.quantity);
  assert.equal(position.markStatus, 'ok'); assert.equal(position.markAt, iso(NOW));
  assert.equal(position.entryEvidence.marketStage, 'internal');
  assert.ok(position.pnl < 0); assert.equal(result.mode, 'paper');
  assert.equal(result.execution, false); assert.equal(result.signing, false); assert.equal(result.broadcast, false);
  assert.equal(validatePaperStrategyAccount(result), true);
});

test('one token cannot duplicate across strategies and shared account caps at two positions', () => {
  const candidates = [evaluation('internal'), evaluation('smart_money'), evaluation('launch_sniper')];
  for (const letter of ['b', 'c']) {
    const candidate = input(); candidate.token.address = `0x${letter.repeat(40)}`;
    candidates.push(evaluatePaperStrategies(candidate)[0]);
  }
  const result = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: candidates, nowMs: NOW });
  assert.equal(Object.keys(result.positions).length, 2); assert.equal(result.trades.length, 2);
  assert.equal(Object.values(result.positions).filter(position => position.address === CA).length, 1);
});

test('same-token attribution uses a stable early-launch, internal, narrative, smart-money priority', () => {
  const candidates = evaluatePaperStrategies(input());
  const run = evaluations => advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations, nowMs: NOW });
  for (const list of [candidates, [...candidates].reverse()]) {
    const account = run(list), position = Object.values(account.positions)[0];
    assert.equal(account.trades.length, 1);
    assert.equal(position.strategyId, 'launch_sniper');
    assert.deepEqual(position.qualifiedStrategyIds, ['launch_sniper', 'internal', 'smart_money']);
  }
  const older = input(); older.token.creationTimestamp = NOW - 16 * 60_000;
  const internal = Object.values(run(evaluatePaperStrategies(older)).positions)[0];
  assert.equal(internal.strategyId, 'internal');
  assert.deepEqual(internal.qualifiedStrategyIds, ['internal', 'smart_money']);
  older.token.marketStage = 'external';
  const external = Object.values(run(evaluatePaperStrategies(older)).positions)[0];
  assert.equal(external.strategyId, 'narrative_pvp');
  assert.deepEqual(external.qualifiedStrategyIds, ['narrative_pvp', 'smart_money']);
  older.narrative.caBound = false;
  assert.equal(Object.values(run(evaluatePaperStrategies(older)).positions)[0].strategyId, 'smart_money');
});

test('stale/future/nonfinite marks never cause exits or update prices', () => {
  const account = open();
  const later = NOW + 180_000;
  for (const bad of [mark(.1, NOW), mark(.1, later + 1), mark(NaN, later), mark(.1, later, { status: 'stale' })]) {
    const result = advancePaperStrategyAccount(account, { marks: [bad], nowMs: later });
    const position = Object.values(result.positions)[0];
    assert.equal(position.markPrice, 1); assert.equal(position.markStatus, 'stale');
    assert.equal(result.trades.length, 1);
  }
});

test('pause stops new entries while a fresh mark still triggers the existing stop loss', () => {
  const account = open(); const nowMs = NOW + 1_000;
  const result = advancePaperStrategyAccount(account, { evaluations: [evaluation('internal', nowMs)], marks: [mark(.7, nowMs)], nowMs, enabled: false });
  assert.equal(Object.keys(result.positions).length, 0); assert.equal(result.trades.length, 2);
  assert.equal(result.trades.at(-1).reason, '价格止损');
  const quantity = (5 - .02) / 1.013;
  const proceeds = quantity * .7 * (1 - .013) - .02;
  closeTo(result.cash, 95 + proceeds); closeTo(result.realizedPnl, proceeds - 5);
  assert.equal(validatePaperStrategyAccount(result), true);
});

test('2x/5x/10x partials retain a ten-percent runner and trailing stop closes it', () => {
  let account = open();
  const original = Object.values(account.positions)[0].quantity;
  for (const [price, step] of [[2, 1], [5, 2], [10, 3]]) {
    account = advancePaperStrategyAccount(account, { marks: [mark(price, NOW + step * 1_000)], nowMs: NOW + step * 1_000 });
    assert.equal(validatePaperStrategyAccount(account), true);
  }
  closeTo(Object.values(account.positions)[0].quantity, original * .1);
  assert.deepEqual(Object.values(account.positions)[0].profitTiersTaken, [2, 5, 10]);
  account = advancePaperStrategyAccount(account, { marks: [mark(6, NOW + 4_000)], nowMs: NOW + 4_000 });
  assert.equal(Object.keys(account.positions).length, 0);
  assert.equal(account.trades.at(-1).reason, '盈利回撤止盈');
  assert.equal(account.stats.wins, 1); assert.ok(account.realizedPnl > 0);
  closeTo(account.cash, 100 + account.realizedPnl);
});

test('flat-price timed exit records a loss from entry and exit costs', () => {
  const policy = STRATEGY_POLICIES.find(item => item.id === 'internal');
  const nowMs = NOW + policy.maxHoldMs;
  const result = advancePaperStrategyAccount(open(), { marks: [mark(1, nowMs)], nowMs });
  assert.equal(Object.keys(result.positions).length, 0);
  assert.equal(result.trades.at(-1).reason, '持仓到期');
  closeTo(result.realizedPnl, -evaluation().evidence.costAssumptions.estimatedRoundTripCost);
});

test('confirmed zero becomes a loss writeoff, ambiguous zero does not fabricate an exit', () => {
  const account = open();
  const unchanged = advancePaperStrategyAccount(account, { marks: [mark(0)], nowMs: NOW + 1_000 });
  assert.equal(unchanged.trades.length, 1);
  const result = advancePaperStrategyAccount(account, { marks: [mark(0, NOW + 1_000, { confirmedZero: true })], nowMs: NOW + 1_000 });
  assert.equal(Object.keys(result.positions).length, 0);
  assert.equal(result.trades.at(-1).side, 'writeoff');
  assert.equal(result.realizedPnl, -5); assert.equal(result.cash, 95);
  assert.equal(result.stats.wins, 0); assert.equal(result.stats.losses, 1);
});

test('loss drawdown and same-token cooldown suppress new entries', () => {
  const nowMs = NOW + 1_000;
  const other = input(nowMs); other.token.address = `0x${'b'.repeat(40)}`;
  const stopped = advancePaperStrategyAccount(open({ initialCash: 20 }), { marks: [mark(.4, nowMs)], evaluations: evaluatePaperStrategies(other), nowMs });
  assert.equal(stopped.stats.dailyLossGuard, true);
  assert.equal(Object.keys(stopped.positions).length, 0);
  const exited = advancePaperStrategyAccount(open(), { marks: [mark(.7, nowMs)], nowMs });
  const blocked = advancePaperStrategyAccount(exited, { evaluations: [evaluation('internal', nowMs + 1_000)], nowMs: nowMs + 1_000 });
  assert.equal(Object.keys(blocked.positions).length, 0);
});

test('invalid accounts, nonfinite state and backwards clocks are rejected', () => {
  assert.throws(() => createPaperStrategyAccount({ initialCash: NaN, nowMs: NOW }));
  assert.throws(() => evaluatePaperStrategies({ nowMs: NaN }));
  const account = open();
  assert.throws(() => advancePaperStrategyAccount(account, { nowMs: NOW - 1 }));
  for (const mutate of [a => { a.execution = true; }, a => { a.cash += 1; }, a => { a.stats.entries = NaN; }, a => { a.cooldowns.bad = Infinity; }, a => { Object.values(a.positions)[0].peakPrice = NaN; }, a => { Object.values(a.positions)[0].profitTiersTaken = [2, 2]; }]) {
    const invalid = structuredClone(account); mutate(invalid);
    assert.throws(() => validatePaperStrategyAccount(invalid));
  }
});

test('structural stops exit before the hard loss cap, using the observed price rather than the stop level', () => {
  const account = open(), position = Object.values(account.positions)[0];
  const price = position.activeStopPrice - .01;
  assert.ok(price > .82);
  const result = advancePaperStrategyAccount(account, { marks: [mark(price)], nowMs: NOW + 1000 });
  assert.equal(result.trades.at(-1).reason, '结构失效止损');
  assert.equal(result.trades.at(-1).price, price);
  assert.equal(result.trades.at(-1).exitEvidence.activeStopPrice, position.activeStopPrice);
  assert.equal(Object.keys(result.positions).length, 0);
});

test('first target sells only twenty percent once and protects the remaining cost basis', () => {
  let account = open(); const position = Object.values(account.positions)[0], original = position.quantity;
  const target = position.exitPlan.referenceTargetPrice;
  account = advancePaperStrategyAccount(account, { marks: [mark(target)], nowMs: NOW + 1000 });
  let held = Object.values(account.positions)[0];
  closeTo(held.quantity, original * .8); assert.equal(held.firstTargetTaken, true);
  assert.equal(held.profitProtectionArmed, true); assert.ok(held.activeStopPrice > held.entryPrice);
  assert.equal(account.trades.at(-1).reason, '结构目标首档兑现 20%');
  account = advancePaperStrategyAccount(account, { marks: [mark(target, NOW + 2000)], nowMs: NOW + 2000 });
  assert.equal(account.trades.length, 2);
  held = Object.values(account.positions)[0]; const stop = held.activeStopPrice;
  account = advancePaperStrategyAccount(account, { marks: [mark(stop, NOW + 3000)], nowMs: NOW + 3000 });
  assert.equal(account.trades.at(-1).reason, '本金与成本保护退出');
  assert.ok(account.realizedPnl > 0); assert.equal(validatePaperStrategyAccount(account), true);
});

test('protection never loosens, gap-down exits are losses when observed below breakeven', () => {
  let account = open();
  account = advancePaperStrategyAccount(account, { marks: [mark(1.6)], nowMs: NOW + 1000 });
  const raised = Object.values(account.positions)[0].activeStopPrice;
  account = advancePaperStrategyAccount(account, { marks: [mark(1.4, NOW + 2000)], nowMs: NOW + 2000 });
  assert.ok(Object.values(account.positions)[0].activeStopPrice >= raised);
  account = advancePaperStrategyAccount(account, { marks: [mark(.9, NOW + 3000)], nowMs: NOW + 3000 });
  assert.equal(account.trades.at(-1).price, .9); assert.ok(account.trades.at(-1).realizedPnl < 0);
});

const exitFlow = (nowMs, change = {}) => ({ chain: 'robinhood', address: CA, status: 'healthy', fresh: true, complete: true, coverageGap: null, observedAt: iso(nowMs), netBuyUsd: -4000, smartMoneySellerCount: 3, ...change });

test('smart-money exits need two distinct full fresh observations at least thirty seconds apart', () => {
  let account = open();
  account = advancePaperStrategyAccount(account, { marks: [mark(1, NOW + 1000, { flow: exitFlow(NOW + 1000) })], nowMs: NOW + 1000 });
  assert.equal(account.trades.length, 1); assert.equal(Object.values(account.positions)[0].flowExitWatch.count, 1);
  account = advancePaperStrategyAccount(account, { marks: [mark(1, NOW + 31000, { flow: exitFlow(NOW + 1000) })], nowMs: NOW + 31000 });
  assert.equal(account.trades.length, 1);
  account = advancePaperStrategyAccount(account, { marks: [mark(1, NOW + 61000, { flow: exitFlow(NOW + 61000) })], nowMs: NOW + 61000 });
  assert.equal(Object.keys(account.positions).length, 0);
  assert.equal(account.trades.at(-1).reason, '聪明钱连续净卖出，买入逻辑失效');
  assert.equal(account.trades.at(-1).exitEvidence.flowConfirmation.count, 2);
});

test('a provider switch cannot confirm a flow reversal or compare a different cohort with entry inflow', () => {
  let account = open();
  account = advancePaperStrategyAccount(account, { marks: [mark(1, NOW + 1000, { flow: exitFlow(NOW + 1000) })], nowMs: NOW + 1000 });
  account = advancePaperStrategyAccount(account, { marks: [mark(1, NOW + 61000, { flow: exitFlow(NOW + 61000, { provider: 'binance_kol' }) })], nowMs: NOW + 61000 });
  assert.equal(account.trades.length, 1); assert.equal(Object.values(account.positions)[0].flowExitWatch, null);
  account = advancePaperStrategyAccount(account, { marks: [mark(.7, NOW + 62000, { flow: exitFlow(NOW + 62000, { provider: 'binance_kol' }) })], nowMs: NOW + 62000 });
  assert.equal(account.trades.length, 2); assert.match(account.trades[1].reason, /止损/);
});

test('stale, partial, foreign or ambiguous flow never sells a position or preserves a false streak', () => {
  for (const change of [{ complete: false }, { fresh: false }, { status: 'partial' }, { address: `0x${'b'.repeat(40)}` }, { chain: 'bsc' }, { coverageGap: 'ambiguous_trade_legs' }, { smartMoneySellerCount: null }, { observedAt: iso(NOW + 999999) }]) {
    let account = open();
    account = advancePaperStrategyAccount(account, { marks: [mark(1, NOW + 1000, { flow: exitFlow(NOW + 1000) })], nowMs: NOW + 1000 });
    account = advancePaperStrategyAccount(account, { marks: [mark(1, NOW + 31000, { flow: exitFlow(NOW + 31000, change) })], nowMs: NOW + 31000 });
    assert.equal(account.trades.length, 1); assert.equal(Object.values(account.positions)[0].flowExitWatch, null);
  }
});

test('entry evidence and structural levels cannot be rewritten by later research or bypassed with old decisions', () => {
  const entry = evaluation(), original = structuredClone(entry);
  const account = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [entry], nowMs: NOW });
  entry.evidence.entryPlan.stopPrice = .1; entry.evidence.narrativeAssessment.event = 'replacement';
  assert.deepEqual(account.trades[0].entryEvidence, original.evidence);
  for (const change of [{ stopPrice: 0 }, { targetPrice: 100 }, { confirmedAt: iso(NOW + 1) }, { netRewardRisk: NaN }, { eligible: false }]) {
    const wrong = structuredClone(original); Object.assign(wrong.evidence.entryPlan, change);
    assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [wrong], nowMs: NOW }).trades.length, 0);
  }
  const old = structuredClone(original); delete old.evidence.version;
  assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [old], nowMs: NOW }).trades.length, 0);
  const early = input(); early.token.creationTimestamp = NOW - 60000;
  assert.ok(evaluatePaperStrategies(early).every(row => row.decision === '观察'));
});

test('legacy persisted holdings are not silently migrated to new stop or target rules', () => {
  const account = open(), held = Object.values(account.positions)[0];
  delete held.exitPlan; delete held.activeStopPrice; delete held.firstTargetTaken; delete held.profitProtectionArmed;
  const result = advancePaperStrategyAccount(account, { marks: [mark(.9)], nowMs: NOW + 1000 });
  assert.equal(result.trades.length, 1); assert.equal(validatePaperStrategyAccount(result), true);
});
