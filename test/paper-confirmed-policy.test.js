import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRMED_PAPER_VERSION, CONFIRMED_QUOTE_VERSION, LOSS_RESPONSE_VERSION, CONFIRMED_PAPER_POLICY, confirmPaperQuotes, confirmedAccountGate, completedPaperRounds } from '../src/paper-confirmed-policy.js';
import { evaluatePaperStrategies, createPaperStrategyAccount, advancePaperStrategyAccount, validatePaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { paperFlowPulse } from '../src/paper-flow-pulse.js';
import { CONFIRMED_PVP_EXIT_POLICY, EVIDENCE_HOLD_EXIT_POLICY, validPvpExitPolicy } from '../src/paper-pvp-policy.js';
import { renderStrategyDetails } from '../dashboard/strategy-details.js';
const NOW = Date.parse('2026-09-23T10:00:00Z'), CA = `0x${'a'.repeat(40)}`;
const iso = n => new Date(n).toISOString();
function input(nowMs = NOW) {
  const token = { chain: 'base', address: CA, symbol: 'OFFLINE_TEST', price: 1.01, liquidity: 60000, volume: 5000,
    isHoneypot: false, isWashTrading: false, rugRatio: .01, top10HolderRate: .15, devTeamHoldRate: .01, bundlerRate: .01, buyTax: 0, sellTax: 0 };
  return { nowMs, token, marketStatus: 'ok', observedAt: iso(nowMs), priceObservedAt: iso(nowMs), allowExploratory: true,
    pvpMode: true, confirmedMode: true, compoundingCash: 100,
    flow: { fresh: true, complete: true, status: 'healthy', observedAt: iso(nowMs), highProfitCount: 0, fomoCount: 0,
      smartMoneyCount: 1, uniqueBuyerCount: 2, netBuyUsd: 600,
      pulse: { windowMs: 90000, recentBuyerCount: 2, recentNetBuyUsd: 600, lastBuyAt: nowMs - 1000 } },
    quoteHistory: [1, 1.006, 1.01].map((price, i) => ({ ...token, price, status: 'ok', observedAt: iso(nowMs - (2-i)*6000) })) };
}
const evaluate = c => evaluatePaperStrategies(c)[0];
const open = () => advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [evaluate(input())], confirmedMode: true, nowMs: NOW });
const step = (a, price, ms) => advancePaperStrategyAccount(a, { enabled: false, nowMs: NOW+ms,
  marks: [{ chain: 'base', address: CA, price, status: 'ok', observedAt: iso(NOW+ms) }] });

const openEvidence = () => advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), {
  evaluations: [evaluate({ ...input(), fixedEntryUsd: 10, evidenceHoldMode: true })], confirmedMode: true, nowMs: NOW });
const held = a => Object.values(a.positions)[0];
const reverseFlow = ms => ({ chain: 'base', address: CA, provider: 'gmgn', complete: true, fresh: true,
  status: 'healthy', observedAt: iso(NOW + ms), netBuyUsd: -5000, smartMoneySellerCount: 2 });
const flowStep = (a, ms, flow, price = 1.01) => advancePaperStrategyAccount(a, { enabled: false, nowMs: NOW + ms,
  marks: [{ chain: 'base', address: CA, status: 'ok', price, observedAt: iso(NOW + ms), flow }] });

test('evidence hold has no stagnation, core or runner clock exit and keeps a full flat position', () => {
  let a = openEvidence(); const quantity = held(a).quantity;
  assert.equal(a.trades[0].netUsd, -10);
  assert.equal(held(a).pvpPolicy.version, EVIDENCE_HOLD_EXIT_POLICY.version);
  assert.match(held(a).entryEvidence.traderDecision.questions[3].text, /不按 120 秒/);
  for (const ms of [120000, 300000, 1200000, 83 * 60000, 4 * 3600000]) {
    a = step(a, 1.01, ms);
    assert.equal(a.trades.length, 1); assert.equal(held(a).quantity, quantity);
    assert.equal(held(a).exitStatus.holdLimitMs, null);
    assert.equal(held(a).exitStatus.timeExitEnabled, false);
    assert.match(held(a).exitStatus.holdReason, /资金流不完整/);
  }
});

test('evidence hold growing price can last 83 minutes without a time-based trim', () => {
  let a = openEvidence(); const quantity = held(a).quantity;
  for (const [ms, price] of [[120000, 1.03], [300000, 1.08], [1200000, 1.16], [83*60000, 1.3]]) a = step(a, price, ms);
  assert.equal(a.trades.length, 1); assert.equal(held(a).quantity, quantity);
  assert.equal(held(a).profitProtectionArmed, true);
  assert.ok(held(a).activeStopPrice > held(a).entryPrice);
});

test('evidence hold retains immediate price stop, profit protection and a fresh-price fill', () => {
  const stopped = step(openEvidence(), .90, 1000);
  assert.equal(stopped.trades.length, 2); assert.match(stopped.trades[1].reason, /止损/);
  assert.equal(stopped.trades[1].price, .9);
  let a = step(openEvidence(), 1.3, 6000); const stop = held(a).activeStopPrice;
  a = step(a, 1.1, 12000);
  assert.equal(a.trades.length, 2); assert.match(a.trades[1].reason, /盈利回撤/);
  assert.ok(a.trades[1].price < stop);
  assert.equal(a.trades[1].exitEvidence.exitPolicyVersion, EVIDENCE_HOLD_EXIT_POLICY.version);
});

test('evidence hold still takes price tiers once and leaves a runner beyond twenty minutes', () => {
  let a = openEvidence(); const original = held(a).quantity;
  a = step(a, 2.1, 6000); assert.equal(a.trades.length, 2);
  a = step(a, 3.1, 12000); assert.equal(a.trades.length, 3);
  assert.ok(Math.abs(held(a).quantity / original - .2) < 1e-10);
  a = step(a, 3.2, 4 * 3600000);
  assert.equal(a.trades.length, 3); assert.match(held(a).exitStatus.holdingMode, /趋势尾仓/);
  assert.equal(held(a).exitStatus.holdLimitMs, null);
  a = step(a, 2.7, 4 * 3600000 + 1000);
  assert.equal(held(a), undefined); assert.equal(a.trades.length, 4);
});

test('evidence hold exits after two independent, complete reversal observations, not a duplicate', () => {
  let a = flowStep(openEvidence(), 10000, reverseFlow(10000));
  assert.equal(a.trades.length, 1); assert.equal(held(a).flowExitWatch.count, 1);
  assert.match(held(a).exitStatus.holdReason, /等待第二次/);
  a = flowStep(a, 41000, reverseFlow(10000));
  assert.equal(a.trades.length, 1); assert.equal(held(a).flowExitWatch.count, 1);
  a = flowStep(a, 42000, reverseFlow(42000));
  assert.equal(a.trades.length, 2); assert.match(a.trades[1].reason, /聪明钱连续净卖出/);
  assert.equal(a.trades[1].exitEvidence.flowConfirmation.count, 2);
});

test('foreign, missing, stale, future, pre-entry or provider-mismatched flow cannot close evidence hold', () => {
  for (const mutate of [f => f.address = `0x${'b'.repeat(40)}`, f => f.chain = 'bsc', f => f.provider = 'binance_smartmoney',
    f => f.complete = false, f => f.fresh = false, f => f.coverageGap = 'missing',
    f => f.observedAt = iso(NOW - 1), f => f.observedAt = iso(NOW + 99000),
    f => f.smartMoneySellerCount = 1]) {
    let a = openEvidence();
    for (const ms of [10000, 42000]) { const f = reverseFlow(ms); mutate(f); a = flowStep(a, ms, f); }
    assert.equal(a.trades.length, 1, String(mutate));
  }
  let a = flowStep(openEvidence(), 10000, reverseFlow(10000));
  a = flowStep(a, 200000, reverseFlow(10000));
  assert.equal(a.trades.length, 1); assert.equal(held(a).flowExitWatch, null);
});

test('stale or missing quotes cannot execute evidence exits or claim a current holding assessment', () => {
  let a = openEvidence();
  a = advancePaperStrategyAccount(a, { enabled: false, nowMs: NOW + 20000,
    marks: [{ chain: 'base', address: CA, status: 'ok', price: .1, observedAt: iso(NOW + 1000) }] });
  assert.equal(a.trades.length, 1); assert.equal(held(a).markStatus, 'stale');
  const html = renderStrategyDetails(held(a).entryEvidence.entryPlan, null, held(a));
  assert.match(html, /报价过期/); assert.match(html, /缺失数据不代表趋势仍然成立/);
  a = step(a, .1, 21000); assert.equal(a.trades.length, 2);
});

test('evidence hold restores frozen settings and rejects tampering, cross-profile and shadow use', () => {
  const a = JSON.parse(JSON.stringify(openEvidence()));
  assert.equal(validatePaperStrategyAccount(a), true);
  assert.equal(step(a, 1.01, 83*60000).trades.length, 1);
  for (const mutate of [p => p.pvpPolicy.coreHoldMs = 0,
    p => p.entryEvidence.exitPolicy = structuredClone(CONFIRMED_PVP_EXIT_POLICY),
    p => delete p.entryEvidence.confirmedPolicy]) {
    const bad = structuredClone(a); mutate(held(bad)); assert.throws(() => validatePaperStrategyAccount(bad));
  }
  assert.equal(validPvpExitPolicy({ ...EVIDENCE_HOLD_EXIT_POLICY, runnerHoldMs: 1 }), false);
  assert.equal(validPvpExitPolicy({ ...EVIDENCE_HOLD_EXIT_POLICY, version: 'unknown' }), false);
  const shadow = { ...a, variant: 'learning_control' }; assert.throws(() => validatePaperStrategyAccount(shadow));
  assert.throws(() => evaluate({ ...input(), confirmedMode: false, evidenceHoldMode: true }), /requires confirmed/);
  const old = step(open(), 1.01, 120000); assert.match(old.trades[1].reason, /120 秒/);
});

test('evidence and legacy exit results are separate review cohorts and UI shows new holding reasons', () => {
  const legacy = step(open(), 1.01, 120000), modern = step(openEvidence(), .94, 1000);
  const all = [...completedPaperRounds(legacy.trades), ...completedPaperRounds(modern.trades)];
  const mixed = { ...legacy, trades: [...legacy.trades, ...modern.trades.map(t => ({ ...t, address: `0x${'b'.repeat(40)}` }))] };
  const review = confirmedAccountGate(mixed, NOW + 120000).traderReview;
  assert.equal(all.length, 2); assert.deepEqual(new Set(review.cohorts.map(c=>c.exitVersion)), new Set([CONFIRMED_PVP_EXIT_POLICY.version, EVIDENCE_HOLD_EXIT_POLICY.version]));
  const p = held(step(openEvidence(), 1.1, 83*60000));
  const html = renderStrategyDetails(p.entryEvidence.entryPlan, null, p);
  assert.match(html, /本轮持仓依据/); assert.match(html, /按证据持有/);
  assert.doesNotMatch(html, /主仓最长 5 分钟|待确认 分钟|最多 0 分钟/);
});

test('fixed-ten confirmed paper entry charges exactly ten including costs and survives restore/exit', () => {
  const c = { ...input(), fixedEntryUsd: 10 }, row = evaluate(c), before = structuredClone(row);
  assert.equal(row.decision, '可模拟'); assert.equal(row.entryUsd, 10);
  const a = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [row], confirmedMode: true, nowMs: NOW });
  assert.equal(a.cash, 90); assert.equal(a.trades[0].netUsd, -10);
  assert.ok(Math.abs(a.trades[0].grossUsd + a.trades[0].costsUsd - 10) < 1e-10);
  assert.equal(a.trades[0].entryEvidence.positionSizing.version, 'fixed_ten_v1');
  assert.equal(a.trades[0].entryEvidence.traderDecision.economics.budgetUsd, 10);
  assert.match(a.trades[0].entryLogic, /固定单笔 10.00 U/);
  assert.equal(validatePaperStrategyAccount(JSON.parse(JSON.stringify(a))), true);
  const exit = step(JSON.parse(JSON.stringify(a)), .94, 1000);
  assert.equal(exit.trades.length, 2); assert.match(exit.trades[1].reason, /止损/);
  assert.equal(exit.execution, false); assert.equal(exit.signing, false); assert.equal(exit.broadcast, false);
  assert.deepEqual(row, before);
});

test('fixed ten does not borrow, shrink, enlarge an old signal, bypass costs, or enter shadow accounts', () => {
  const row = evaluate({ ...input(), fixedEntryUsd: 10 });
  const poor = createPaperStrategyAccount({ initialCash: 9.99, nowMs: NOW });
  assert.equal(advancePaperStrategyAccount(poor, { evaluations: [row], confirmedMode: true, nowMs: NOW }).trades.length, 0);
  assert.notEqual(evaluate({ ...input(), fixedEntryUsd: 10, compoundingCash: 9.99 }).decision, '可模拟');
  const eth = input(); eth.fixedEntryUsd = 10; eth.token.chain = 'eth'; eth.quoteHistory.forEach(q => q.chain = 'eth');
  assert.ok(evaluate(eth).reasons.some(r => r.includes('往返成本超过')));
  const shadow = { ...createPaperStrategyAccount({ nowMs: NOW }), variant: 'learning_control' };
  assert.throws(() => advancePaperStrategyAccount(shadow, { evaluations: [row], confirmedMode: true, nowMs: NOW }), /paper-main only/);
  assert.equal(advancePaperStrategyAccount(shadow, { evaluations: [row], nowMs: NOW }).trades.length, 0);
  const legacy = evaluate(input());
  const unchanged = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [legacy], confirmedMode: true, nowMs: NOW });
  assert.equal(unchanged.trades[0].costBasisUsd, 2);
  assert.throws(() => evaluate({ ...input(), fixedEntryUsd: 10, confirmedMode: false }), /fixed paper ticket/);
});

test('fixed-ten version is separate from earlier small-ticket review cohorts', () => {
  let a = open(); a = step(a, 1.01, 120000);
  const now = NOW + 3600000, c = { ...input(now), fixedEntryUsd: 10, compoundingCash: a.cash };
  a = advancePaperStrategyAccount(a, { evaluations: [evaluate(c)], confirmedMode: true, nowMs: now });
  a = advancePaperStrategyAccount(a, { enabled: false, nowMs: now + 120000,
    marks: [{ chain: 'base', address: CA, price: 1.01, status: 'ok', observedAt: iso(now + 120000) }] });
  const review = confirmedAccountGate(a, now + 120000).traderReview;
  assert.equal(review.cohorts.length, 2);
  assert.deepEqual(new Set(review.cohorts.map(c => c.sizingVersion)), new Set(['cash_fraction_v1', 'fixed_ten_v1']));
});

test('confirmed PVP replaces rare minute-candle patterns with new buying plus independent quote confirmation', () => {
  const c = input(), row = evaluate(c);
  assert.equal(row.decision, '可模拟', JSON.stringify(row)); assert.equal(row.entryUsd, 2);
  assert.equal(row.evidence.chart.ready, false); assert.equal(row.evidence.confirmedPolicy.version, CONFIRMED_PAPER_VERSION);
  assert.equal(row.evidence.exitPolicy.version, CONFIRMED_PVP_EXIT_POLICY.version);
  assert.equal(row.evidence.flow.highProfitCount, 0); assert.equal(row.evidence.narrativeFresh, false);
  assert.equal(open().trades.length, 1); assert.equal(open().cash, 98);
  assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [row], nowMs: NOW }).trades.length, 0);
  const legacy = evaluatePaperStrategies({ ...c, confirmedMode: false }).find(r => r.strategyId === 'smart_money');
  assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }), { evaluations: [legacy], confirmedMode: true, nowMs: NOW }).trades.length, 0);
});
test('duplicates, stale, conflicting, foreign, gapped or chasing quotes cannot become momentum', () => {
  for (const mutate of [c => c.quoteHistory = [c.quoteHistory[2], c.quoteHistory[2], c.quoteHistory[2]],
    c => c.quoteHistory[0].chain = 'bsc', c => c.quoteHistory[0].observedAt = iso(NOW-29000),
    c => c.quoteHistory.push({ ...c.quoteHistory[1], price: 100 }), c => c.quoteHistory[2].observedAt = iso(NOW+1),
    c => c.token.price = 1.1, c => c.quoteHistory[0].price = .8, c => c.quoteHistory[1].price = 1.03]) {
    const c = input(); mutate(c); assert.equal(confirmPaperQuotes(c.quoteHistory,c.token,NOW).ready,false,String(mutate));
    assert.notEqual(evaluate(c).decision,'可模拟');
  }
});
test('unknown safety, stale pulse, single buyer, high costs and tiny budgets remain blocked', () => {
  for (const mutate of [c => c.flow.pulse = null, c => c.flow.pulse.lastBuyAt = NOW-90001,
    c => c.flow.pulse.lastBuyAt = NOW+1, c => c.flow.pulse.recentBuyerCount = 1, c => c.flow.complete = false,
    c => c.flow.smartMoneyCount = 0, c => c.flow.netBuyUsd = 499, c => c.token.rugRatio = null,
    c => c.token.canMint = true, c => c.token.isHoneypot = true, c => c.token.buyTax = .04,
    c => c.compoundingCash = 6.26, c => c.token.liquidity = 10000]) {
    const c=input(); mutate(c); assert.notEqual(evaluate(c).decision,'可模拟',String(mutate));
  }
});
test('pulse uses event times not polling times, excludes old/future/dust buys and net sellers', () => {
  const rows=[{wallet:'a',side:'buy',at:NOW-1000,amountUsd:400},{wallet:'b',side:'buy',at:NOW-2000,amountUsd:300},
    {wallet:'c',side:'buy',at:NOW-91000,amountUsd:5000},{wallet:'d',side:'buy',at:NOW+1,amountUsd:5000},
    {wallet:'a',side:'buy',at:NOW,amountUsd:.01},{wallet:'b',side:'sell',at:NOW-500,amountUsd:400}];
  const pulse=paperFlowPulse(rows,NOW);
  assert.equal(pulse.recentBuyerCount,1); assert.equal(pulse.lastBuyAt,NOW-1000);
  assert.equal(paperFlowPulse(rows,NOW+100000).lastBuyAt,null);
});
test('new exit avoids fee-only 45-second churn but keeps stops, bounded holds and frozen versions', () => {
  let a=open(); a=step(a,1.02,45000); assert.equal(a.trades.length,1);
  a=step(a,1.02,120000); assert.equal(a.trades.length,1,'a slightly rising price is not fee-only stagnation');
  a=step(a,1.02,300000); assert.equal(a.trades.length,2); assert.match(a.trades.at(-1).reason,/主仓 5 分钟/);
  const flat=step(open(),1.01,120000); assert.equal(flat.trades.length,2); assert.match(flat.trades.at(-1).reason,/120 秒/);
  const stopped=step(open(),.94,1000); assert.equal(stopped.trades.length,2);
  assert.equal(stopped.cooldowns[`base:${CA}`],NOW+1000+1800000);
  assert.equal(validatePaperStrategyAccount(JSON.parse(JSON.stringify(open()))),true);
  assert.equal(validPvpExitPolicy({...CONFIRMED_PVP_EXIT_POLICY,coreHoldMs:360000}),false);
});
test('drawdown, daily entry budget, frequency and old flow remain brakes; losing streaks now trigger review only', () => {
  const a=createPaperStrategyAccount({nowMs:NOW});
  a.realizedPnl=-11; assert.equal(confirmedAccountGate(a,NOW).allowed,false);
  const bought=open(); assert.ok(confirmedAccountGate(bought,NOW+1000).reasons.some(r=>r.includes('间隔一分钟')));
  const closed=step(open(),.94,1000), later=NOW+1800001;
  assert.ok(confirmedAccountGate(closed,later,{chain:'base',address:CA},{lastBuyAt:NOW-1}).reasons.some(r=>r.includes('旧资金流')));
  assert.equal(confirmedAccountGate(closed,later+1000,{chain:'base',address:CA},{lastBuyAt:later}).allowed,true);
  const history=createPaperStrategyAccount({nowMs:NOW});
  for(let i=0;i<6;i++)history.trades.push({side:'buy',chain:'base',address:`token${i}`,atMs:NOW-100000*(i+1),quantity:1,realizedPnl:0});
  history.trades.sort((a,b)=>a.atMs-b.atMs);
  assert.ok(confirmedAccountGate(history,NOW).reasons.some(r=>r.includes('每小时')));
  const rounds=[];
  for(let i=0;i<3;i++)rounds.push({side:'buy',chain:'base',address:`coin${i}`,atMs:NOW-60000+i*1000,quantity:1,realizedPnl:0},
    {side:'sell',chain:'base',address:`coin${i}`,atMs:NOW-50000+i*1000,quantity:.5,realizedPnl:.1},
    {side:'sell',chain:'base',address:`coin${i}`,atMs:NOW-40000+i*1000,quantity:.5,realizedPnl:-.2});
  rounds.sort((a,b)=>a.atMs-b.atMs);history.trades=rounds;
  assert.equal(completedPaperRounds(rounds).length,3);
  const gate=confirmedAccountGate(history,NOW+10000);
  assert.equal(gate.allowed,true,JSON.stringify(gate.reasons));
  assert.equal(gate.lossReview.consecutiveNonWinningRounds,3);assert.equal(gate.lossReview.reviewTriggered,true);
  assert.equal(gate.lossReview.pauseMs,0);assert.equal(gate.lossResponseVersion,LOSS_RESPONSE_VERSION);
  assert.equal(CONFIRMED_PAPER_POLICY.losingPauseMs,0);
  assert.ok(!gate.reasons.some(r=>/冷静|连亏/.test(r)));
});

test('all quotes in the entry path are checked: a deep dip and sharp rebound cannot masquerade as steady strength',()=>{
  for(const prices of [[1,.94,1.02],[1,.9815,1.0215],[1,.993,.986,.98,1.01],[1,.986,1.03]]) {
    const c=input();c.token.price=prices.at(-1);c.quoteHistory=prices.map((price,i)=>({...c.token,price,status:'ok',observedAt:iso(NOW-(prices.length-1-i)*6000)}));
    const q=confirmPaperQuotes(c.quoteHistory,c.token,NOW);assert.equal(q.ready,false,JSON.stringify(prices));
    assert.match(q.reason,/路径/);assert.equal(q.version,CONFIRMED_QUOTE_VERSION);
    assert.notEqual(evaluate(c).decision,'可模拟');
  }
  const c=input();c.quoteHistory[1].price=.995;
  const good=confirmPaperQuotes(c.quoteHistory,c.token,NOW);assert.equal(good.ready,true);
  assert.ok(good.pathMaxDrawdown<.015);assert.ok(good.maxStepRise<.04);
});

test('three fully accounted losing rounds do not prevent the next valid paper entry',()=>{
  let a=createPaperStrategyAccount({nowMs:NOW-3600000});
  for(let i=0;i<3;i++) {
    const at=NOW-3600000+i*1200000,ca=`0x${String(i+1).repeat(40)}`,c=input(at);
    c.token.address=ca;c.quoteHistory.forEach(q=>q.address=ca);c.compoundingCash=a.cash;
    a=advancePaperStrategyAccount(a,{evaluations:[evaluate(c)],nowMs:at,confirmedMode:true});
    a=advancePaperStrategyAccount(a,{enabled:false,nowMs:at+1000,confirmedMode:true,
      marks:[{chain:'base',address:ca,price:.94,status:'ok',observedAt:iso(at+1000)}]});
  }
  assert.equal(a.trades.length,6);assert.equal(confirmedAccountGate(a,NOW).lossReview.consecutiveNonWinningRounds,3);
  const c=input();c.compoundingCash=a.cash;
  const next=advancePaperStrategyAccount(a,{evaluations:[evaluate(c)],nowMs:NOW,confirmedMode:true});
  assert.equal(next.trades.length,7);assert.equal(next.positions[`base:${CA}`].entryEvidence.confirmedPolicy.lossResponseVersion,LOSS_RESPONSE_VERSION);
  assert.equal(validatePaperStrategyAccount(next),true);
});

test('exit evidence preserves visible quote gaps and review reports stop shortfall without inventing causality',()=>{
  const a=step(open(),.6,12000),exit=a.trades.at(-1);
  assert.equal(exit.exitEvidence.quoteDiagnostics.gapMs,12000);
  assert.equal(exit.exitEvidence.quoteDiagnostics.previousPrice,1.01);
  assert.equal(exit.exitEvidence.quoteDiagnostics.price,.6);
  assert.equal(exit.exitEvidence.quoteDiagnostics.ageAtDecisionMs,0);
  const review=confirmedAccountGate(a,NOW+13000).lossReview.recent[0];
  assert.ok(review.stopShortfallRate>.3);assert.ok(review.findings.some(s=>s.includes('不能归因')));
  assert.equal(review.exitQuoteDiagnostics.gapMs,12000);
  const old=JSON.parse(JSON.stringify(a));delete old.trades.at(-1).exitEvidence.quoteDiagnostics;
  assert.equal(confirmedAccountGate(old,NOW+13000).lossReview.recent[0].exitQuoteDiagnostics,null);
});
test('daily loss, daily count and repeated-token losses cannot be bypassed by a new signal', () => {
  const a=createPaperStrategyAccount({nowMs:NOW});
  a.trades=[{side:'sell',chain:'base',address:CA,quantity:1,realizedPnl:-3,atMs:NOW-7200000}];
  a.realizedPnl=-3;
  assert.ok(confirmedAccountGate(a,NOW).reasons.some(r=>r.includes('当日已实现亏损')));
  a.trades=Array.from({length:24},(_,i)=>({side:'buy',chain:'base',address:`test${i}`,quantity:1,realizedPnl:0,atMs:NOW-7200000+i*60000}));
  assert.ok(confirmedAccountGate(a,NOW).reasons.some(r=>r.includes('每日 24')));
  a.realizedPnl=-.2;a.trades=[];
  for(let i=0;i<2;i++)a.trades.push({side:'buy',chain:'base',address:CA,quantity:1,realizedPnl:0,atMs:NOW-7200000+i*1800000},
    {side:'sell',chain:'base',address:CA,quantity:1,realizedPnl:-.1,atMs:NOW-7100000+i*1800000});
  const gate=confirmedAccountGate(a,NOW,{chain:'base',address:CA},{lastBuyAt:NOW-1000});
  assert.ok(gate.reasons.some(r=>r.includes('同币当日已亏损两次')));
  assert.equal(gate.dailyPnl,-.2);
});
test('diagnostic v1 no longer bypasses the daily loss circuit breaker', () => {
  const c=input();c.confirmedMode=false;c.diagnosticMode=true;
  const row=evaluate(c),a=createPaperStrategyAccount({nowMs:NOW});
  a.cash=89;a.realizedPnl=-11;a.trades=[{side:'sell',chain:'base',address:CA,quantity:1,price:1,grossUsd:1,costsUsd:0,netUsd:1,costBasisUsd:12,realizedPnl:-11,atMs:NOW-1000}];
  const next=advancePaperStrategyAccount(a,{evaluations:[row],diagnosticMode:true,nowMs:NOW});
  assert.equal(next.trades.length,1);assert.equal(next.cash,89);
});
