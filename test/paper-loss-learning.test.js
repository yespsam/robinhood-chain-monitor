import test from 'node:test';
import assert from 'node:assert/strict';
import {paperLossLearning} from '../src/paper-loss-learning.js';
const NOW=Date.parse('2026-09-30T00:00:00Z'),CA='0x'+'a'.repeat(40);
const buy=(id,atMs=NOW-4000)=>({id,side:'buy',chain:'bsc',address:CA,atMs,quantity:10,costsUsd:.2});
const sell=(id,pnl=-2,atMs=NOW-2000)=>({id,side:'sell',chain:'bsc',address:CA,atMs,quantity:10,costsUsd:.2,realizedPnl:pnl});
test('losses split price and costs; future fills, open positions and deposits are not realized profits',()=>{
  const account={trades:[buy('a'),sell('b'),buy('c',NOW-1000),sell('future',100,NOW+1)],
    cashAdjustments:[{id:'fund',at:new Date(NOW-1500).toISOString(),tradeCount:2,amountUsd:100}]};
  const before=structuredClone(account),r=paperLossLearning(account,NOW);
  assert.equal(r.overall.closedRounds,1);assert.equal(r.overall.netPnlUsd,-2);assert.equal(r.overall.modelCostsUsd,.4);
  assert.equal(r.overall.grossPricePnlUsd,-1.6);assert.equal(r.currentRound.fills,1);
  assert.equal(r.currentRound.realizedPnlUsd,0);assert.equal(r.currentRound.closedRounds,0);assert.deepEqual(account,before);
});
test('partial exits count once; cost-only and evidence-gap cohorts overlap without causal claims',()=>{
  const a=buy('a'),b={...sell('b',-.1),quantity:4,reason:'证据持续中断'},c={...sell('c',-.1,NOW-1000),quantity:6};
  const r=paperLossLearning({trades:[a,b,c]},NOW);
  assert.equal(r.overall.closedRounds,1);assert.equal(r.overall.netPnlUsd,-.2);
  assert.equal(r.lessons.find(x=>x.id==='cost_drag').closedRounds,1);
  assert.equal(r.lessons.find(x=>x.id==='evidence_gap_exit').closedRounds,1);assert.match(r.note,/不能相加/);
  delete b.costsUsd;const missing=paperLossLearning({trades:[a,b,c]},NOW);
  assert.equal(missing.overall.modelCostsUsd,null);assert.equal(missing.overall.grossPricePnlUsd,null);
  assert.equal(missing.lessons.find(x=>x.id==='cost_drag').closedRounds,0);
});
test('a new deposit separates the ongoing round without rewriting or hiding historic losses',()=>{
  const a={trades:[buy('a'),sell('b'),buy('c',NOW-900),sell('d',3,NOW-800)],
    cashAdjustments:[{id:'new',at:new Date(NOW-1000).toISOString(),tradeCount:2,amountUsd:100}]};
  const r=paperLossLearning(a,NOW);
  assert.equal(r.overall.netPnlUsd,1);assert.equal(r.currentRound.netPnlUsd,3);assert.equal(r.currentRound.realizedPnlUsd,3);
  assert.equal(r.lessons[0].closedRounds,2);assert.equal(r.automaticParameterChanges,false);
});
test('route results use frozen route and selection version, not names or later story; open lots are excluded',()=>{
  const event={...buy('event'),entryEvidence:{lossRepair:{group:'event_narrative'},traderDecision:{selectionPolicy:'new'}}};
  const price={...buy('price',NOW-1900),entryEvidence:{lossRepair:{group:'price_only'},traderDecision:{selectionPolicy:'old'}}};
  const unknown=buy('unknown',NOW-900),open=buy('open',NOW-300);
  const account={trades:[event,sell('event-sell',2),price,sell('price-sell',-3,NOW-1000),unknown,sell('unknown-sell',-.2,NOW-400),open]};
  const before=structuredClone(account),r=paperLossLearning(account,NOW).routePerformance;
  assert.equal(r.groups.find(g=>g.id==='event_narrative').netPnlUsd,2);
  assert.equal(r.groups.find(g=>g.id==='price_only').netPnlUsd,-3);
  assert.equal(r.groups.find(g=>g.id==='unknown').closedRounds,1);
  assert.equal(r.groups.find(g=>g.id==='verified_wallet').closedRounds,0);
  assert.equal(r.groups.reduce((n,g)=>n+g.closedRounds,0),3);
  assert.equal(r.selectionCohorts.find(c=>c.selectionPolicy==='new').netPnlUsd,2);
  assert.deepEqual(account,before);
  account.cashAdjustments=[{id:'fund',at:new Date(NOW-1950).toISOString(),tradeCount:2}];
  assert.equal(paperLossLearning(account,NOW).routePerformance.groups.find(g=>g.id==='event_narrative').closedRounds,0);
});
