import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluatePaperStrategies, createPaperStrategyAccount, advancePaperStrategyAccount, validatePaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { opportunityChart, OPPORTUNITY_VERSION, confirmStructureQuotes } from '../src/paper-opportunity-policy.js';
import { confirmedAccountGate } from '../src/paper-confirmed-policy.js';
import { createPaperStrategyRuntime } from '../src/paper-strategy-runtime.js';
import { paperEntryFunnel } from '../src/paper-entry-funnel.js';
import { REFERENCE_COST_VERSION, assessStructureHold } from '../src/paper-opportunity-review.js';
import { analyzePaperChart } from '../src/paper-strategy-analysis.js';
import { normalizePlatformCall, GMGN_SOCIAL_VERSION } from '../src/gmgn-social-monitor.js';
import { buildPaperNewsWire } from '../src/paper-news-wire.js';
import { readyForPaperQuote } from '../src/paper-candidate-research.js';
import { createReviewComparison } from '../src/paper-review-comparison.js';
import { ETH_GAS_VERSION } from '../src/paper-eth-gas.js';
import { gasFixture } from './helpers/paper-gas-fixture.js';

// Offline fixtures only; never imported by the running service.
const NOW=Date.parse('2026-09-24T03:00:00Z'), CA=`0x${'a'.repeat(40)}`, iso=ms=>new Date(ms).toISOString();
const token={chain:'base',address:CA,symbol:'OFFLINE_ONLY',price:1.03,marketStage:'external',liquidity:60000,volume:5000,
  isHoneypot:false,isWashTrading:false,rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,buyTax:0,sellTax:0};
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true};
function bars(kind='breakout',now=NOW) {
  let rows;
  if(kind==='breakout') rows=Array.from({length:24},(_,i)=>{const p=i<8?.8+i*.025:1;return [p,p+.01,p-.005,p,100];});
  if(kind==='trend') rows=Array.from({length:30},(_,i)=>{const p=1+i*.006;return [p-.001,p+.002,p-.002,p,i===29?130:100];});
  if(kind==='pullback') rows=[...Array.from({length:15},(_,i)=>{const p=.7+i*.035;return [p-.01,p+.01,p-.02,p,100];}),
    [1.2,1.3,1.19,1.29,200],[1.29,1.3,1.15,1.16,150],[1.16,1.17,1.02,1.04,110],
    ...Array.from({length:12},()=>[1.04,1.05,1.02,1.04,100]),
    [1.04,1.06,1.015,1.03,100],[1.03,1.035,1.02,1.025,90],[1.025,1.055,1.025,1.05,160]];
  if(kind==='breakout') rows[23]=[1,1.035,.999,1.03,180];
  return rows.map(([open,high,low,close,volume],i)=>({time:now-(rows.length-i)*60000,open,high,low,close,volume}));
}
function input(kind='breakout',now=NOW) {
  const candles=bars(kind,now),price=candles.at(-1).close,t={...token,price};
  return {...modes,nowMs:now,token:t,marketStatus:'ok',observedAt:iso(now),priceObservedAt:iso(now),requireFastQuote:true,
    compoundingCash:100,fixedEntryUsd:10,candles,klineStatus:'ok',flow:{},
    quoteHistory:[-4000,0].map(delta=>({...t,price:delta?price*.998:price,status:'ok',observedAt:iso(now+delta)}))};
}
const evaluate=i=>evaluatePaperStrategies(i)[0];
const advance=(a,rows,now=NOW,extra={})=>advancePaperStrategyAccount(a,{...modes,evaluations:rows,nowMs:now,...extra});

function breakoutFlowInput(kind='breakout') {
  const i={...input(kind),memeExitMode:true,recoveryMode:true};
  i.token.chain='bsc';i.quoteHistory.forEach(q=>q.chain='bsc');
  i.flow={chain:'bsc',address:CA,provider:'gmgn',scope:'public_tagged_wallets_not_full_market',
    status:'healthy',fresh:true,complete:true,observedAt:iso(NOW-11000),netBuyUsd:350,
    uniqueBuyerCount:0,smartMoneyCount:0,highProfitCount:0,fomoCount:0,wallets:[]};
  return i;
}

test('recovered BSC breakout observes fresh scoped net outflow before quote admission and serialized fill',()=>{
  const good=breakoutFlowInput(),row=evaluate(good);
  assert.equal(row.decision,'可模拟');assert.equal(row.evidence.opportunity.id,'external_breakout');
  assert.equal(row.evidence.opportunity.breakoutFlow.version,'bsc_breakout_observed_outflow_v1');
  const i=structuredClone(good);i.flow.netBuyUsd=-375.21;
  const bad=evaluate(i),route=bad.evidence.opportunityRoutes.find(r=>r.id==='external_breakout');
  assert.equal(route.decision,'观察');assert.equal(route.breakoutFlow.blocked,true);
  assert.equal(route.signalReady,false,'contradictory breakout cannot claim a ready quote-warmup signal');
  assert.match(route.reasons.join(' '),/已观测净流出/);
  assert.equal(readyForPaperQuote(bad),false,'outflow does not reserve independent quote capacity');
  const settings={memeExitMode:true,recoveryMode:true};
  const account=createPaperStrategyAccount({nowMs:NOW});
  assert.equal(advance(account,[row],NOW,settings).trades.length,1);
  const fallback=advance(account,[bad],NOW,settings);
  assert.ok(fallback.trades.every(t=>t.entryEvidence.opportunity.id!=='external_breakout'),
    'a different independently qualified route is not the rejected breakout');
  const forged=structuredClone(row);forged.evidence.recoveryEntry.flow.netBuyUsd=-1;
  assert.equal(advance(account,[forged],NOW,settings).trades.length,0,'writer recomputes source proof, not the ready flags');
  assert.equal(account.trades.length,0,'original history remains untouched');
});

test('breakout outflow filter does not invent selling from unknown, stale, partial, mismatched or zero data',()=>{
  for(const mutate of [i=>i.flow={},i=>i.flow.netBuyUsd=null,i=>i.flow.netBuyUsd=NaN,i=>i.flow.netBuyUsd='-12',
    i=>i.flow.netBuyUsd=0,i=>i.flow.netBuyUsd=12,i=>i.flow.complete=false,i=>i.flow.fresh=false,
    i=>i.flow.status='partial',i=>i.flow.coverageGap='missing_page',i=>i.flow.observedAt=iso(NOW-120001),
    i=>i.flow.observedAt=iso(NOW+1),i=>i.flow.observedAt=null,i=>i.flow.address=`0x${'b'.repeat(40)}`,
    i=>i.flow.chain='base',i=>i.flow.provider='unknown',i=>i.flow.scope=null]) {
    const i=breakoutFlowInput();i.flow.netBuyUsd=-12;mutate(i);
    const row=evaluate(i),route=row.evidence.opportunityRoutes.find(r=>r.id==='external_breakout');
    assert.equal(route.breakoutFlow.blocked,false,mutate.toString());
    assert.equal(route.decision,'可模拟',mutate.toString());
  }
  const caseOnly=breakoutFlowInput();caseOnly.flow.address=CA.toUpperCase().replace('0X','0x');caseOnly.flow.netBuyUsd=-12;
  assert.equal(evaluate(caseOnly).evidence.opportunityRoutes.find(r=>r.id==='external_breakout').breakoutFlow.blocked,true);
});

test('local wallet proof truncation preserves source aggregate selling without validating a truncated cohort',()=>{
  const i=breakoutFlowInput();i.flow.netBuyUsd=-10;
  i.flow.wallets=Array.from({length:201},(_,n)=>({wallet:`0x${n.toString(16).padStart(40,'0')}`}));
  const row=evaluate(i),route=row.evidence.opportunityRoutes.find(r=>r.id==='external_breakout');
  assert.equal(route.decision,'观察');assert.equal(route.breakoutFlow.blocked,true);
  const f=row.evidence.recoveryEntry.flow;
  assert.equal(f.complete,false);assert.equal(f.coverageGap,'proof_wallets_truncated');assert.equal(f.wallets.length,200);
  assert.equal(f.preTruncationCoverage.complete,true);
  const incomplete=structuredClone(i);incomplete.flow.coverageGap='source_page_missing';incomplete.flow.complete=false;
  assert.equal(evaluate(incomplete).evidence.opportunityRoutes.find(r=>r.id==='external_breakout').breakoutFlow.status,'unknown');
  const good=breakoutFlowInput();good.flow.wallets=i.flow.wallets;
  const forged=evaluate(good);forged.evidence.recoveryEntry.flow.netBuyUsd=-10;
  assert.equal(advance(createPaperStrategyAccount({nowMs:NOW}),[forged],NOW,{memeExitMode:true,recoveryMode:true}).trades.length,0);
});

test('outflow contradiction is route-local, does not modify other chains or legacy control and cannot bypass safety',()=>{
  const pullback=breakoutFlowInput('pullback');pullback.flow.netBuyUsd=-300;
  const p=evaluate(pullback);assert.equal(p.decision,'可模拟');assert.equal(p.evidence.opportunity.id,'external_pullback');
  assert.equal(p.evidence.recoveryCheck.breakoutFlow.applicable,false,'route check cache must not leak the breakout veto');
  const b=breakoutFlowInput();b.flow.netBuyUsd=-300;
  assert.equal(evaluate({...b,recoveryMode:false}).decision,'可模拟','legacy control is unchanged');
  b.token.chain='base';b.flow.chain='base';b.quoteHistory.forEach(q=>q.chain='base');
  assert.equal(evaluate(b).decision,'可模拟');
  for(const mutate of [i=>i.token.isHoneypot=true,i=>i.token.liquidity=0,i=>i.priceObservedAt=iso(NOW-6000),
    i=>i.token.sellTax=.061,i=>i.candles=[]]) {
    const i=breakoutFlowInput();mutate(i);assert.notEqual(evaluate(i).decision,'可模拟');
  }
});

test('main admits a real pattern despite high Gas, fully charges it and does not relax controls or safety',()=>{
  const i={...input(),memeExitMode:true,recoveryMode:true,chainGasAccounting:true,gasEstimate:gasFixture('eth',NOW,2)};
  i.token={...i.token,chain:'eth'};i.quoteHistory=i.quoteHistory.map(q=>({...q,chain:'eth'}));
  const row=evaluate(i);assert.equal(row.decision,'可模拟',JSON.stringify({missing:row.missing,reasons:row.reasons}));
  assert.ok(row.evidence.costAssumptions.estimatedRoundTripCostRate>.4);
  assert.equal(row.evidence.costGate.gasExcludedFromAdmission,true);
  const account=createPaperStrategyAccount({nowMs:NOW}),settings={memeExitMode:true,recoveryMode:true,chainGasAccounting:true};
  const next=advance(account,[row],NOW,settings),p=next.positions[`eth:${CA}`];
  assert.equal(next.trades.length,1);assert.equal(p.costAssumptions.gasUsd,2);
  assert.ok(p.entryCostsUsd>2);assert.ok(p.quantity*i.token.price<8);assert.equal(next.cash,90);
  assert.equal(validatePaperStrategyAccount(next),true);
  assert.equal(advance(account,[row],NOW,{memeExitMode:true,recoveryMode:true}).trades.length,0,'candidate cannot enable the policy');
  for(const modify of [x=>x.gasEstimate.status='unavailable',x=>x.gasEstimate.chain='base',x=>x.token.isHoneypot=true,x=>x.token.sellTax=.061,
    x=>x.gasEstimate.observedAt=iso(NOW-90001),x=>{x.gasEstimate.gasUsd=11;x.gasEstimate.samples[0].feeNative=.11;}]) {
    const bad=structuredClone(i);modify(bad);assert.notEqual(evaluate(bad).decision,'可模拟');
  }
});

test('ETH fresh gas evidence reaches evaluation and serialized fill; stale evidence cannot create a new position',()=>{
  const gas={version:ETH_GAS_VERSION,chain:'eth',status:'ok',observedAt:iso(NOW),blockAt:iso(NOW-1000),priceObservedAt:iso(NOW-60000),
    gasPriceWei:10000000,nativeUsd:2700,gasUnits:250000,buffer:1.25};
  const i={...input(),memeExitMode:true,recoveryMode:true,gasEstimate:gas};i.token={...i.token,chain:'eth'};
  i.quoteHistory=i.quoteHistory.map(q=>({...q,chain:'eth'}));
  const row=evaluate(i);assert.equal(row.decision,'可模拟',JSON.stringify({reasons:row.reasons,missing:row.missing}));
  const account=createPaperStrategyAccount({nowMs:NOW});
  const next=advance(account,[row],NOW,{memeExitMode:true,recoveryMode:true});
  assert.equal(next.trades.length,1);assert.ok(Math.abs(next.positions[`eth:${CA}`].costAssumptions.gasUsd-.0084375)<1e-12);
  assert.equal(validatePaperStrategyAccount(next),true);
  const stale=structuredClone(row);stale.evidence.costAssumptions.gasEstimate.observedAt=iso(NOW-90001);
  assert.equal(advance(account,[stale],NOW,{memeExitMode:true,recoveryMode:true}).trades.length,0,'fill revalidates the actual gas evidence, not a ready flag');
  assert.notEqual(evaluate({...i,gasEstimate:{...gas,status:'unavailable'}}).decision,'可模拟');
});

test('taxed main structure uses net economics at analysis and fill, not the old 5% veto',()=>{
  const i={...input(),memeExitMode:true,recoveryMode:true};
  i.token.buyTax=.01;i.token.sellTax=.01;
  const row=evaluate(i);
  assert.ok(row.evidence.costAssumptions.estimatedRoundTripCostRate>.06);
  assert.equal(row.decision,'可模拟',JSON.stringify({reasons:row.reasons,missing:row.missing}));
  assert.equal(row.evidence.costGate.version,'structure_net_cost_v1');
  assert.equal(row.evidence.costGate.ready,true);
  const account=createPaperStrategyAccount({nowMs:NOW});
  const next=advance(account,[row],NOW,{memeExitMode:true,recoveryMode:true});
  assert.equal(next.trades.length,1);assert.equal(validatePaperStrategyAccount(next),true);
  assert.equal(next.trades[0].entryEvidence.costGate.version,'structure_net_cost_v1');
  assert.ok(next.positions[`base:${CA}`].costAssumptions.estimatedRoundTripCostRate>.06,'costs are charged, not removed');
  assert.equal(advance(account,[row]).trades.length,0,'row cannot change the control book policy');
  assert.notEqual(evaluate({...i,memeExitMode:false,recoveryMode:false}).decision,'可模拟');
  const noChart=evaluate({...i,candles:[],klineStatus:'unavailable'});
  assert.notEqual(noChart.decision,'可模拟');assert.doesNotMatch(noChart.reasons.join(' '),/超过 5%/);
  const noQuote=evaluate({...i,quoteHistory:[],priceObservedAt:null});
  assert.equal(readyForPaperQuote(noQuote),true,'net-positive structure may request real quotes');
  for(const mutate of [x=>{x.token.buyTax=.061;},x=>{x.priceObservedAt=iso(NOW-6000);},x=>{x.token.isHoneypot=true;},
    x=>{x.token.chain='eth';x.quoteHistory.forEach(q=>q.chain='eth');}]){
    const bad=structuredClone(i);mutate(bad);assert.notEqual(evaluate(bad).decision,'可模拟');
  }
  const forged=structuredClone(row);forged.evidence.entryPlan.targetPrice=i.token.price*1.02;
  assert.equal(advance(account,[forged],NOW,{memeExitMode:true,recoveryMode:true}).trades.length,0,'fill rechecks net economics');
});

test('recovery checks each route before selection; a failed monitored event cannot veto an independent structure',()=>{
  const e=normalizePlatformCall({id:'offline-route-check',signal_type:13,token_address:CA,trigger_at:(NOW-10000)/1000,
    data:{chain:'bsc',address:CA,symbol:token.symbol}},'bsc',NOW);
  const monitorSignal=buildPaperNewsWire({gmgn:{version:GMGN_SOCIAL_VERSION,chains:{bsc:{status:'healthy',lastSuccessAt:iso(NOW)}},events:[e]},nowMs:NOW}).paperSignals[0];
  assert.ok(monitorSignal);
  const i={...input(),monitorSignal,memeExitMode:true,recoveryMode:true};
  i.token.chain='bsc';i.quoteHistory.forEach(q=>q.chain='bsc');
  const row=evaluate(i),routes=row.evidence.opportunityRoutes;
  assert.equal(row.decision,'可模拟',JSON.stringify({missing:row.missing,reasons:row.reasons}));
  assert.equal(row.evidence.opportunity.id,'external_breakout');
  assert.equal(routes.find(r=>r.id==='external_breakout').decision,'可模拟');
  assert.equal(routes.find(r=>r.id==='monitored_event').decision,'观察');
  assert.match(routes.find(r=>r.id==='monitored_event').reasons.join(' '),/双地址/);
  assert.doesNotMatch(routes.find(r=>r.id==='external_breakout').reasons.join(' '),/双地址/);
  const next=advance(createPaperStrategyAccount({nowMs:NOW}),[row],NOW,{memeExitMode:true,recoveryMode:true});
  assert.equal(next.trades.length,1);assert.equal(validatePaperStrategyAccount(next),true);
  assert.equal(next.trades[0].entryEvidence.opportunity.id,'external_breakout');
  const noQuote=evaluate({...i,quoteHistory:[],priceObservedAt:null});
  assert.equal(readyForPaperQuote(noQuote),true,'valid structure still gets independent quote research');
  assert.notEqual(evaluate({...i,candles:[],klineStatus:'unavailable'}).decision,'可模拟','news without buyers or structure remains ineligible');
});

test('main chart window can use a complete recent suffix without filling an older gap',()=>{
  const recent=bars(),older=Array.from({length:12},(_,i)=>({...recent[0],time:recent[0].time-(12-i)*60000}));
  const raw=[...older,...recent];raw.splice(5,1);
  const options={contiguousTail:true};
  assert.equal(opportunityChart(raw,'ok',NOW).ready,false,'legacy window stays strict');
  const chart=opportunityChart(raw,'ok',NOW,options);
  assert.equal(chart.ready,true);assert.equal(chart.rows.length,30);
  assert.equal(chart.diagnostics.windowPolicy,'contiguous_tail_v1');
  assert.equal(chart.diagnostics.excludedPrefixBars,5);
  assert.deepEqual(chart.rows,raw.slice(5),'only original bars after the last gap');
  for(const mutate of [r=>r.splice(-5,1),r=>r.push({...r[0]}),r=>{r[0].high=.1;},r=>{r[0].time+=1000;},r=>r.forEach(b=>b.time-=180000)]){
    const bad=structuredClone(raw);mutate(bad);assert.equal(opportunityChart(bad,'ok',NOW,options).ready,false,mutate.toString());
  }
  const i={...input(),memeExitMode:true,recoveryMode:true,candles:raw};
  const row=evaluate(i);assert.equal(row.decision,'可模拟',JSON.stringify({missing:row.missing,reasons:row.reasons}));
  assert.equal(row.evidence.opportunity.chartWindowPolicy,'contiguous_tail_v1');
  const next=advance(createPaperStrategyAccount({nowMs:NOW}),[row],NOW,{memeExitMode:true,recoveryMode:true});
  assert.equal(next.trades.length,1);assert.equal(validatePaperStrategyAccount(next),true);
  assert.equal(next.trades[0].entryEvidence.recoveryEntry.chartWindowPolicy,'contiguous_tail_v1');
  assert.notEqual(evaluate({...i,memeExitMode:false,recoveryMode:false}).decision,'可模拟');
});

test('evidence-exit main removes fixed structure distance at both analysis and fill, controls stay unchanged',()=>{
  const i=input();
  for(let n=0;n<8;n++){
    const p=.3+n*.09;i.candles[n]={...i.candles[n],open:p,close:p,low:p-.005,high:p+.01};
  }
  for(const bar of i.candles.slice(-15)) bar.low=.85;
  const old=evaluate(i),row=evaluate({...i,memeExitMode:true});
  assert.notEqual(old.decision,'可模拟');
  assert.equal(row.decision,'可模拟',JSON.stringify({missing:row.missing,reasons:row.reasons}));
  assert.ok(row.evidence.entryPlan.stopPrice<i.token.price*.94);
  assert.equal(row.evidence.entryPlan.entryPolicyVersion,'meme_structure_entry_v1');
  assert.equal(row.evidence.entryPlan.maxStructureDistance,null);
  const initial=createPaperStrategyAccount({nowMs:NOW});
  assert.equal(advance(initial,[row]).trades.length,0,'a row cannot grant the main-only relaxation to a legacy ledger');
  const next=advance(initial,[row],NOW,{memeExitMode:true});
  assert.equal(next.trades.length,1);assert.equal(next.cash,90);
  assert.equal(next.positions[`base:${CA}`].memeExitPolicy.version,'meme_evidence_exit_v2');
  assert.equal(validatePaperStrategyAccount(next),true);
  const broken=structuredClone(next);delete broken.positions[`base:${CA}`].memeExitPolicy;
  assert.throws(()=>validatePaperStrategyAccount(broken));
  for(const mutate of [x=>x.priceObservedAt=iso(NOW-6000),x=>x.compoundingCash=9,
    x=>x.token.isHoneypot=true,x=>x.candles.splice(4,1),x=>x.quoteHistory=[],x=>x.token.liquidity=0]){
    const bad=structuredClone(i);mutate(bad);assert.notEqual(evaluate({...bad,memeExitMode:true}).decision,'可模拟');
  }
  assert.throws(()=>evaluate({...i,memeExitMode:true,opportunityReviewMode:false}));
});

for(const [kind,id] of [['breakout','external_breakout'],['pullback','external_pullback'],['trend','external_trend']]) {
  test(`${kind} is a genuine external entry without fabricated wallet evidence`,()=>{
    const row=evaluate(input(kind));
    assert.equal(row.decision,'可模拟',JSON.stringify({missing:row.missing,reasons:row.reasons,routes:row.evidence.opportunityRoutes}));
    assert.equal(row.evidence.opportunity.id,id);
    assert.equal(row.evidence.flowFresh,false);
    assert.equal(row.evidence.flow.uniqueBuyerCount,null);
    assert.equal(row.evidence.confirmedPolicy.pulse,null);
    assert.equal(row.evidence.traderDecision.hypothesis,id);
    assert.equal(row.evidence.entryPlan.stopPrice,row.evidence.opportunity.pattern.support);
    const a=advance(createPaperStrategyAccount({nowMs:NOW}),[row]);
    assert.equal(a.trades.length,1);assert.equal(a.cash,90);
    assert.equal(a.trades[0].strategyLabel,row.label);
    assert.equal(a.trades[0].entryEvidence.opportunity.version,OPPORTUNITY_VERSION);
    assert.equal(validatePaperStrategyAccount(a),true);
    assert.equal(a.execution,false);assert.equal(a.signing,false);assert.equal(a.broadcast,false);
    assert.equal(paperEntryFunnel([row]).eligible,1);
  });
}

test('internal route needs real buyers but not a smart-money label',()=>{
  const i=input();i.token.marketStage='near_completion';i.token.price=1.01;
  i.flow={status:'ok',fresh:true,complete:true,observedAt:iso(NOW),uniqueBuyerCount:2,highProfitCount:0,smartMoneyCount:0,fomoCount:0,netBuyUsd:350,
    pulse:{recentBuyerCount:2,recentNetBuyUsd:350,lastBuyAt:NOW-1}};
  i.quoteHistory=[1,1.006,1.01].map((price,j)=>({...i.token,price,status:'ok',observedAt:iso(NOW-(2-j)*6000)}));
  const row=evaluate(i);assert.equal(row.decision,'可模拟');assert.equal(row.evidence.opportunity.id,'internal_launch');
  i.flow.pulse.lastBuyAt=NOW-100000;assert.notEqual(evaluate(i).decision,'可模拟');
  i.flow={};assert.notEqual(evaluate(i).decision,'可模拟');
});

test('narrative route never invents a catalyst from a symbol or web link',()=>{
  const i=input();i.token.website='https://example.com';i.token.symbol='AI AGENT OG';
  const row=evaluate(i),route=row.evidence.opportunityRoutes.find(r=>r.id==='narrative_recall');
  assert.notEqual(route.decision,'可模拟');assert.ok(route.missing.includes('绑定精确 CA 的新鲜叙事催化'));
  assert.equal(row.evidence.narrativeRecall,undefined);
});

test('all routes retain security, stage, cost, cash, quote and authentic-candle checks',()=>{
  const mutations=[i=>{i.token.isHoneypot=true;},i=>{delete i.token.isHoneypot;},i=>{i.token.stageConflict=true;},
    i=>{i.token.marketStage='unknown';},i=>{i.compoundingCash=9.99;},i=>{i.token.liquidity=0;},
    i=>{i.observedAt=iso(NOW-121000);},i=>{i.priceObservedAt=iso(NOW-6000);},i=>{i.quoteHistory=[];},
    i=>{i.quoteHistory[0].address=`0x${'b'.repeat(40)}`;},i=>{i.candles[5].high=.5;},
    i=>{i.candles.splice(5,1);},i=>{i.candles.push({...i.candles[5]});},i=>{i.candles.forEach(r=>r.time-=180000);},
    i=>{i.candles.at(-1).volume=10;},i=>{i.token.creationTimestamp=NOW-300000;},
    i=>{i.token.chain='eth';i.quoteHistory.forEach(q=>q.chain='eth');}];
  for(const mutate of mutations){const i=input();mutate(i);assert.notEqual(evaluate(i).decision,'可模拟',mutate.toString());}
  const i=input(); i.candles.push({time:NOW,open:1,high:100,low:1,close:100,volume:1e9});
  assert.equal(evaluate(i).evidence.opportunity.pattern.close,1.03,'open/future candle cannot create alpha');
});

test('chart and quote validation reject zero volume baseline and conflicting quotes',()=>{
  const i=input();i.candles.forEach(c=>c.volume=0);assert.notEqual(evaluate(i).decision,'可模拟');
  assert.equal(opportunityChart(bars().slice(-8),'ok',NOW).ready,false);
  const j=input(),pattern=evaluate(j).evidence.opportunity.pattern;
  assert.equal(confirmStructureQuotes([...j.quoteHistory,{...j.quoteHistory[0],price:2}],j.token,pattern,NOW).ready,false);
});

test('short chart readiness does not override full opportunity-window integrity',()=>{
  const full=bars();
  const shortReady=candles=>analyzePaperChart({candles,klineStatus:'ok',nowMs:NOW}).ready;
  assert.equal(shortReady(full),true);
  assert.equal(opportunityChart(full,'ok',NOW).ready,true);
  // Earlier errors lie outside the legacy last-12-bar summary, but remain
  // inside the longer opportunity window. Both public states can be valid.
  for(const mutate of [rows=>rows.splice(2,1),rows=>rows.push({...rows[2]}),rows=>{rows[2].high=.1;}]) {
    const rows=structuredClone(full);mutate(rows);
    assert.equal(shortReady(rows),true);
    const longer=opportunityChart(rows,'ok',NOW);
    assert.equal(longer.ready,false);
    assert.equal(longer.reason,'K 线缺口、重复或价格字段异常');
  }
  const recentGap=structuredClone(full);recentGap.splice(-4,1);
  assert.equal(shortReady(recentGap),false);
  assert.equal(opportunityChart(recentGap,'ok',NOW).ready,false);
});

test('chart diagnostics distinguish missing, stale, duplicate and malformed evidence without changing readiness',()=>{
  const inspect=rows=>opportunityChart(rows,'ok',NOW);
  assert.equal(inspect(bars()).diagnostics.code,'ready');
  assert.equal(opportunityChart([], 'unavailable',NOW).diagnostics.code,'source_unavailable');
  assert.equal(inspect(bars().slice(-8)).diagnostics.code,'insufficient_closed_bars');
  assert.equal(inspect(bars().map(r=>({...r,time:r.time-180000}))).diagnostics.code,'stale_closed_bars');
  const cases=[['missing_intervals',r=>r.splice(2,1)],['duplicate_time',r=>r.push({...r[2]})],
    ['invalid_ohlc_range',r=>{r[2].high=.1;}],['invalid_price',r=>{r[2].close=0;}],
    ['invalid_volume',r=>{r[2].volume=-1;}],['irregular_interval',r=>{r[2].time+=1000;}]];
  for(const [code,mutate] of cases){const rows=bars();mutate(rows);const c=inspect(rows);
    assert.equal(c.ready,false);assert.equal(c.reason,'K 线缺口、重复或价格字段异常');
    assert.equal(c.diagnostics.code,code);assert.ok(Number.isFinite(c.diagnostics.issue.openAtMs));
    assert.ok(c.diagnostics.closedBars>=13);assert.equal(c.rows.length,0);
  }
  const gap=bars();gap.splice(2,1);const d=inspect(gap).diagnostics;
  assert.equal(d.issue.gapMs,120000);assert.equal(d.issue.missingIntervals,1);
  assert.equal(d.lastClosedAtMs,NOW);assert.equal(d.closedBars,23);
});

test('birth inside the first minute is valid but a fully pre-birth candle remains rejected',()=>{
  const i=input(),first=i.candles[0].time;
  for(const offset of [0,1,30000,59999]) {
    i.token.creationTimestamp=first+offset;
    assert.equal(evaluate(i).decision,'可模拟');
  }
  i.token.creationTimestamp=first+60000;
  assert.notEqual(evaluate(i).decision,'可模拟');
});

test('same closed-candle signal cannot reopen; later signal can; no fixed-time sale',()=>{
  const row=evaluate(input()),fresh=createPaperStrategyAccount({nowMs:NOW});
  assert.equal(advancePaperStrategyAccount(fresh,{evaluations:[row],...modes,opportunityMode:false,nowMs:NOW}).trades.length,0);
  let a=advance(fresh,[row]);
  a=advance(a,[],NOW+3600000,{enabled:false,marks:[{...token,status:'ok',price:1.03,observedAt:iso(NOW+3600000)}]});
  assert.equal(a.trades.length,1,'not sold merely after one hour');
  a=advance(a,[],NOW+3601000,{enabled:false,marks:[{...token,status:'ok',price:.97,observedAt:iso(NOW+3601000)}]});
  assert.equal(a.trades.length,2);assert.match(a.trades[1].reason,/止损/);
  const old=confirmedAccountGate(a,NOW+3602000,token,null,null,{continuousPaperMode:true,opportunity:row.evidence.opportunity});
  assert.equal(old.allowed,false);
  const later=evaluate(input('breakout',NOW+3660000));
  a=advance(a,[later],NOW+3660000);assert.equal(a.trades.length,3);
  assert.equal(advancePaperStrategyAccount(JSON.parse(JSON.stringify(a)),{enabled:false,nowMs:NOW+3660000}).trades.length,3);
});

test('an already-consumed wallet signal cannot hide a new valid external route',()=>{
  let a=advance(createPaperStrategyAccount({nowMs:NOW-60000}),[evaluate(input('breakout',NOW-60000))],NOW-60000);
  a=advance(a,[],NOW-59000,{enabled:false,marks:[{...token,status:'ok',price:.97,observedAt:iso(NOW-59000)}]});
  const i=input();i.opportunityAccount=a;
  i.flow={status:'ok',fresh:true,complete:true,observedAt:iso(NOW),uniqueBuyerCount:2,smartMoneyCount:1,highProfitCount:0,fomoCount:0,netBuyUsd:600,
    pulse:{lastBuyAt:NOW-60001,recentBuyerCount:2,recentNetBuyUsd:600}};
  i.quoteHistory=[1.02,1.025,1.03].map((price,j)=>({...token,price,status:'ok',observedAt:iso(NOW-(2-j)*6000)}));
  const row=evaluate(i);assert.equal(row.evidence.opportunity.id,'external_breakout');assert.equal(row.decision,'可模拟');
  const flow=row.evidence.opportunityRoutes.find(r=>r.id==='flow_momentum');assert.equal(flow.decision,'观察');assert.match(flow.reasons.join(' '),/旧资金流/);
  assert.equal(advance(a,[row]).trades.length,3);
});

test('chain receipt costs flow through runtime quote fills and restart while comparison costs stay separate',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'gas-runtime-test-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let now=NOW,refreshes=0;
  const market={trending:async()=>({status:'ok',observedAt:iso(now),tokens:[token]}),trenches:async()=>({status:'ok',observedAt:iso(now),tokens:[]}),
    kline:async args=>({...args,status:'ok',candles:bars()}),quote:async args=>({...args,status:'ok',price:now===NOW?1.029:1.03,observedAt:iso(now)})};
  const gasMonitor={refresh:async()=>{refreshes++;},snapshot:chain=>chain?gasFixture(chain,now,2):{base:gasFixture('base',now,2)}};
  const options={...modes,memeExitMode:true,chainGasAccounting:true,gasMonitor,dataDir,chain:'base',chains:['base'],market,now:()=>now,evidenceLoader:()=>({}),fixedEntryUsd:10};
  const runtime=createPaperStrategyRuntime(options);
  try {
    await runtime.runOnce();await runtime.runOnce();await runtime.refreshQuote();now+=4000;await runtime.refreshQuote();await runtime.runOnce();
    const s=runtime.snapshot();assert.equal(s.lastError,null);assert.ok(refreshes>0);
    assert.equal(s.account.trades.length,1,JSON.stringify(s.evaluations.map(r=>({r:r.reasons,m:r.missing}))));
    assert.equal(s.account.positions[`base:${CA}`].costAssumptions.gasUsd,2);
    assert.equal(s.cadence.chainGas.base.status,'ok');assert.equal(s.mainEntryPolicy.gasExcludedFromAdmission,true);
  } finally {await runtime.stop();}
  const restart=createPaperStrategyRuntime(options);
  try{await restart.runOnce();const s=restart.snapshot();assert.equal(s.account.trades.length,1);assert.equal(s.account.cash,90);}
  finally{await restart.stop();}
});

test('runtime researches external charts without wallets, fetches hourly discovery, buys and restarts without reset',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-multi-test-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let now=NOW;const calls=[];
  const market={trending:async args=>{calls.push(['rank',args.interval]);return {status:'ok',observedAt:iso(now),tokens:[token]};},
    trenches:async()=>({status:'ok',observedAt:iso(now),tokens:[]}),
    kline:async args=>{calls.push(['kline',args.address,args.purpose]);return {...args,status:'ok',candles:bars()};},
    quote:async args=>({...args,status:'ok',price:now===NOW?1.029:1.03,observedAt:iso(now)})};
  const options={...modes,dataDir,chain:'base',chains:['base'],market,now:()=>now,evidenceLoader:()=>({}),fixedEntryUsd:10};
  const runtime=createPaperStrategyRuntime(options);
  try {
    await runtime.runOnce(); await runtime.runOnce(); await runtime.refreshQuote();now+=4000;await runtime.refreshQuote();await runtime.runOnce();
    const s=runtime.snapshot();assert.equal(s.lastError,null);assert.equal(s.opportunityMode,OPPORTUNITY_VERSION);
    assert.ok(calls.some(c=>c[0]==='kline'));assert.equal(calls.some(c=>c[1]==='1h'),false,'no historical burst during cold start');assert.equal(s.opportunityRoutes.length,6);
    assert.equal(s.account.trades.length,1,JSON.stringify(s.evaluations.map(r=>({missing:r.missing,reasons:r.reasons}))));
    assert.equal(s.account.trades[0].strategyLabel,'外盘放量突破');
    assert.equal(s.reviewComparison.version,'review_forward_v1');
    assert.equal(s.reviewComparison.main.entries,1);assert.equal(s.reviewComparison.control.entries,1);
    assert.equal(s.account.trades[0].entryEvidence.costAssumptions.version,REFERENCE_COST_VERSION);
    for(let n=0;n<3;n++)await runtime.refreshMarket();
    assert.ok(calls.some(c=>c[1]==='1h'),'hourly discovery is retained on the slower schedule');
    now+=61000;await runtime.runOnce();
    assert.equal(calls.filter(c=>c[0]==='kline').at(-1)[2],'exit','main v2 holding wins chart priority over same-token legacy control');
  } finally {await runtime.stop();}
  const resumed=createPaperStrategyRuntime(options);
  try{await resumed.runOnce();assert.equal(resumed.snapshot().account.trades.length,1);assert.equal(resumed.snapshot().account.cash,90);
    assert.equal(resumed.snapshot().reviewComparison.control.entries,1);}finally{await resumed.stop();}
});

test('runtime rejects foreign-chain candles even if their pattern would qualify',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-multi-bind-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const market={trending:async()=>({status:'ok',observedAt:iso(NOW),tokens:[token]}),
    kline:async args=>({...args,chain:'bsc',status:'ok',candles:bars()}),quote:async args=>({...args,status:'ok',price:1.03,observedAt:iso(NOW)})};
  const runtime=createPaperStrategyRuntime({...modes,dataDir,chain:'base',market,now:()=>NOW,evidenceLoader:()=>({}),fixedEntryUsd:10});
  try{await runtime.runOnce();await runtime.runOnce();const s=runtime.snapshot();assert.equal(s.account.trades.length,0);assert.equal(s.researchPipeline.chartReadyCandidates,0);}
  finally{await runtime.stop();}
});

test('runtime exposes bounded cache diagnostics without raw bars, extra requests or ledger mutation',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-chart-diagnostics-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const candles=bars();candles.splice(2,1);let requests=0;
  const market={trending:async()=>({status:'ok',observedAt:iso(NOW),tokens:[token]}),
    kline:async args=>{requests++;return {...args,status:'ok',observedAt:iso(NOW),candles};},
    quote:async args=>({...args,status:'ok',price:token.price,observedAt:iso(NOW)})};
  const runtime=createPaperStrategyRuntime({...modes,dataDir,chain:'base',market,now:()=>NOW,evidenceLoader:()=>({}),fixedEntryUsd:10});
  try{
    await runtime.runOnce();await runtime.runOnce();
    const before=requests,s=runtime.snapshot(),d=s.researchPipeline.chartDiagnostics;
    assert.ok(d.length>0&&d.length<=10);
    assert.equal(d[0].chain,'base');assert.equal(d[0].address,CA);
    assert.equal(d[0].ready,false);assert.equal(d[0].diagnostics.code,'missing_intervals');
    assert.equal(d[0].diagnostics.issue.missingIntervals,1);
    assert.equal(d[0].fetchedAt,iso(NOW));assert.equal(d[0].candles,undefined);
    assert.equal(d[0].rows,undefined);assert.equal(s.account.trades.length,0);
    runtime.snapshot();assert.equal(requests,before,'snapshot never fetches extra market data');
  }finally{await runtime.stop();}
});

test('a cached forming candle cannot become a final closed candle just because time passed',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-chart-close-bound-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let now=NOW+30000,requests=0,release;
  const market={trending:async()=>({status:'ok',observedAt:iso(now),tokens:[token]}),
    kline:async args=>{requests++;if(requests>1)await new Promise(resolve=>{release=resolve;});
      return {...args,status:'ok',observedAt:iso(now),candles:[...bars(),
      {time:NOW,open:1.03,high:1.05,low:1.03,close:1.05,volume:10000}]};},
    quote:async args=>({...args,status:'ok',price:token.price,observedAt:iso(now)})};
  const runtime=createPaperStrategyRuntime({...modes,dataDir,chain:'base',market,now:()=>now,evidenceLoader:()=>({}),fixedEntryUsd:10});
  try{
    await runtime.runOnce();await runtime.runOnce();
    assert.equal(runtime.snapshot().researchPipeline.chartDiagnostics[0].diagnostics.lastClosedAtMs,NOW);
    now=NOW+61000;await runtime.fastOnce();
    const d=runtime.snapshot().researchPipeline.chartDiagnostics[0];
    assert.equal(requests,2,'hot refresh is pending but cannot renew the cached forming bar');
    assert.equal(d.diagnostics.lastClosedAtMs,NOW,'forming OHLCV was not final at the original request');
    assert.equal(d.excludedUnclosedBars,1);
    assert.equal(d.closedThroughAt,iso(NOW));
    now=NOW+91000;release();await new Promise(resolve=>setImmediate(resolve));await runtime.runOnce();
    assert.equal(requests,2);
    assert.equal(runtime.snapshot().researchPipeline.chartDiagnostics[0].diagnostics.lastClosedAtMs,NOW+60000,'a fresh request can establish the final bar');
  }finally{release?.();await runtime.stop();}
});

test('a minute-crossing response uses request-time candle closure and retains malformed closed bars',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-chart-response-bound-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let now=NOW+59000;
  const candles=bars();candles[2].high=0;
  const market={trending:async()=>({status:'ok',observedAt:iso(now),tokens:[token]}),
    kline:async args=>{now=NOW+61000;return {...args,status:'ok',observedAt:iso(now),candles:[...candles,
      ...[NOW,NOW/1000,iso(NOW)].map(time=>({time,open:1,high:1.05,low:1,close:1.05,volume:10000}))]};},
    quote:async args=>({...args,status:'ok',price:token.price,observedAt:iso(now)})};
  const runtime=createPaperStrategyRuntime({...modes,dataDir,chain:'base',market,now:()=>now,evidenceLoader:()=>({}),fixedEntryUsd:10});
  try{
    await runtime.runOnce();await runtime.runOnce();
    const d=runtime.snapshot().researchPipeline.chartDiagnostics[0];
    assert.equal(d.fetchedAt,iso(NOW+61000));assert.equal(d.closedThroughAt,iso(NOW));
    assert.equal(d.excludedUnclosedBars,3);assert.equal(d.diagnostics.closedBars,24);
    assert.equal(d.diagnostics.lastClosedAtMs,NOW);
    assert.equal(d.ready,false);assert.equal(d.diagnostics.code,'invalid_price');
  }finally{await runtime.stop();}
});

test('runtime uses validated dispatch-time boundaries and never the response-time minute',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-chart-dispatch-bound-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let now=NOW+59000;
  const market={trending:async()=>({status:'ok',observedAt:iso(now),tokens:[token]}),
    kline:async args=>{assert.equal(args.latestClosed,true);now=NOW+125000;return {...args,status:'ok',source:'gmgn-cli',requestWindow:'latest_closed_at_dispatch',
      from:NOW/1000+60-3600,to:NOW/1000+60,queuedAt:iso(NOW+59000),requestedAt:iso(NOW+65000),receivedAt:iso(now),observedAt:iso(now),
      candles:[...bars('breakout',NOW+60000),{time:NOW+60000,open:1,high:1.1,low:.99,close:1.05,volume:10000}]};},quote:async()=>({status:'unavailable'})};
  const runtime=createPaperStrategyRuntime({...modes,dataDir,chain:'base',market,now:()=>now,evidenceLoader:()=>({}),fixedEntryUsd:10});
  try{
    await runtime.runOnce();await runtime.runOnce();
    const d=runtime.snapshot().researchPipeline.chartDiagnostics[0];
    assert.equal(d.closedThroughAt,iso(NOW+60000));assert.equal(d.excludedUnclosedBars,1);
    assert.equal(d.diagnostics.lastClosedAtMs,NOW+60000);
    assert.equal(d.requestedAt,iso(NOW+65000));assert.equal(d.receivedAt,iso(NOW+125000));
    assert.equal(runtime.snapshot().account.trades.length,0,'chart alone cannot fabricate quote confirmation');
  }finally{await runtime.stop();}
});

test('runtime rejects mismatched, future or foreign dispatch-window metadata',async t=>{
  for(const override of [{source:'other'}, {requestedAt:iso(NOW+120000)}, {to:NOW/1000+60}, {from:NOW/1000-3500}]){
    const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-chart-invalid-window-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
    const market={trending:async()=>({status:'ok',observedAt:iso(NOW),tokens:[token]}),
      kline:async args=>({...args,status:'ok',source:'gmgn-cli',requestWindow:'latest_closed_at_dispatch',requestedAt:iso(NOW),candles:bars(),...override}),quote:async()=>({status:'unavailable'})};
    const runtime=createPaperStrategyRuntime({...modes,dataDir,chain:'base',market,now:()=>NOW,evidenceLoader:()=>({}),fixedEntryUsd:10});
    try{await runtime.runOnce();await runtime.runOnce();
      const d=runtime.snapshot().researchPipeline.chartDiagnostics[0];
      assert.equal(d.sourceStatus,'unavailable');assert.equal(d.sourceReason,'kline_request_window_mismatch');
      assert.equal(d.ready,false);assert.equal(runtime.snapshot().account.trades.length,0);
    }finally{await runtime.stop();}
  }
});

test('runtime refreshes expired closed evidence before a late-response cache reaches sixty seconds',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-chart-expiry-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let now=NOW+59000,requests=0;
  const market={trending:async()=>({status:'ok',observedAt:iso(now),tokens:[token]}),
    kline:async args=>{requests++;return {...args,status:'ok',observedAt:iso(now),candles:bars('breakout',args.to*1000)};},
    quote:async args=>({...args,status:'ok',price:token.price,observedAt:iso(now)})};
  const runtime=createPaperStrategyRuntime({...modes,dataDir,chain:'base',market,now:()=>now,evidenceLoader:()=>({}),fixedEntryUsd:10});
  try{
    await runtime.runOnce();await runtime.runOnce();assert.equal(requests,1);
    now=NOW+91000;await runtime.runOnce();await runtime.runOnce();
    assert.equal(requests,2,'both scheduler and cache must agree that the original closed boundary expired');
    const d=runtime.snapshot().researchPipeline.chartDiagnostics[0];
    assert.equal(d.closedThroughAt,iso(NOW+60000));assert.equal(d.ready,true);
    await runtime.runOnce();assert.equal(requests,2,'fresh evidence remains cached');
    assert.equal(runtime.snapshot().account.trades.length,0,'refresh does not force an entry without independent quotes');
  }finally{await runtime.stop();}
});

test('hot candidate chart refresh crosses cache gate before expiry and is evaluated with the newly closed bar',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-chart-proactive-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let now=NOW+59000,requests=0,release;
  const market={trending:async()=>({status:'ok',observedAt:iso(now),tokens:[token]}),
    kline:async args=>{requests++;if(requests>1)await new Promise(resolve=>{release=resolve;});
      return {...args,status:'ok',observedAt:iso(now),candles:bars('breakout',args.to*1000)};},
    quote:async args=>({...args,status:'unavailable'})};
  const runtime=createPaperStrategyRuntime({...modes,dataDir,chain:'base',market,now:()=>now,evidenceLoader:()=>({}),fixedEntryUsd:10});
  try{
    await runtime.runOnce();await runtime.runOnce();assert.equal(requests,1);
    now=NOW+64000;await runtime.fastOnce();
    assert.equal(requests,2,'a new closed minute must reach the source despite a five-second-old cache');
    const dispatched=runtime.snapshot().researchPipeline;
    assert.equal(dispatched.lastChartDispatch.proactive,true);assert.equal(dispatched.lastChartDispatch.previousClosedAgeMs,64000);
    assert.equal(dispatched.chartDispatches.proactive,1);
    for(let i=0;i<3;i++){now+=1000;await runtime.fastOnce();}
    assert.equal(requests,2,'single-flight remains bounded while the source is pending');
    assert.equal(runtime.snapshot().researchPipeline.chartDiagnostics[0].closedThroughAt,iso(NOW),'pending request cannot renew old evidence');
    release();await new Promise(resolve=>setImmediate(resolve));await runtime.fastOnce();
    const s=runtime.snapshot(),d=s.researchPipeline.chartDiagnostics[0];
    assert.equal(d.closedThroughAt,iso(NOW+60000));assert.equal(d.ready,true);
    assert.ok(s.evaluations[0].evidence.opportunityRoutes.some(r=>r.pattern?.closedAt===NOW+60000),'new candle participates in the actual entry evaluation');
    assert.equal(requests,2);assert.equal(s.account.trades.length,0,'no fill without independent quotes');
    assert.equal(s.execution,false);assert.equal(s.signing,false);assert.equal(s.broadcast,false);
  }finally{release?.();await runtime.stop();}
});

test('an old non-setup is refreshed and reevaluated on the next close despite unseen competitors',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-chart-new-setup-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let now=NOW+59000;const requests=[],observed={...token,volume:1e9},unseen={...token,address:`0x${'b'.repeat(40)}`};
  const market={trending:async()=>({status:'ok',observedAt:iso(now),tokens:[observed,unseen]}),
    kline:async args=>{requests.push(args);const candles=bars('breakout',args.to*1000);
      if(args.to*1000===NOW)candles.at(-1).volume=0;
      return {...args,status:'ok',observedAt:iso(now),candles};},
    quote:async args=>({...args,status:'unavailable'})};
  const runtime=createPaperStrategyRuntime({...modes,dataDir,chain:'base',market,now:()=>now,evidenceLoader:()=>({}),fixedEntryUsd:10});
  try{
    await runtime.runOnce();await runtime.runOnce();
    const before=runtime.snapshot().evaluations.find(r=>r.token.address===CA);
    assert.ok(before.evidence.opportunityRoutes.filter(r=>r.basis==='ohlcv').every(r=>!r.signalReady));
    assert.equal(runtime.snapshot().researchPipeline.hotCandidates[0].address,unseen.address,'the prior non-setup yields its hot seat');
    now=NOW+64000;await runtime.runOnce();
    assert.equal(requests.length,2);assert.equal(requests[1].address,CA,'new-minute reevaluation reaches the previously checked token');
    const s=runtime.snapshot(),after=s.evaluations.find(r=>r.token.address===CA);
    assert.ok(after.evidence.opportunityRoutes.some(r=>r.basis==='ohlcv'&&r.signalReady),'actual new close can now reveal a setup');
    assert.equal(s.researchPipeline.lastChartDispatch.proactive,true);
    assert.equal(s.account.trades.length,0,'shape alone cannot buy without independent quotes');
  }finally{await runtime.stop();}
});

test('runtime rotates hot-chart chains even when earlier chains keep offering unseen candidates',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-hot-chain-fair-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let now=NOW;const chains=['base','bsc','robinhood'],dispatches=[];
  const market={trending:async({chain})=>({status:'ok',observedAt:iso(now),tokens:Array.from({length:12},(_,i)=>({...token,chain,address:`0x${(i+1).toString(16).padStart(40,'0')}`}))}),
    kline:async args=>{const candles=bars('breakout',args.to*1000);candles.at(-1).volume=0;return {...args,status:'ok',observedAt:iso(now),candles};},
    quote:async args=>({...args,status:'unavailable'})};
  const runtime=createPaperStrategyRuntime({...modes,dataDir,chain:'base',chains,market,now:()=>now,evidenceLoader:()=>({}),fixedEntryUsd:10});
  try{
    for(let i=0;i<6;i++){await runtime.runOnce();const d=runtime.snapshot().researchPipeline.lastChartDispatch;if(d?.lane==='hot')dispatches.push(d.chain);now+=6000;}
    assert.deepEqual(dispatches.slice(0,3),chains,'one hot seat per chain must translate into fair actual requests');
    assert.equal(runtime.snapshot().account.trades.length,0);
  }finally{await runtime.stop();}
});

test('a new candidate completes real quote scheduling beside an existing paper holding',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-held-and-candidate-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const existing=advance(createPaperStrategyAccount({nowMs:NOW}),[evaluate(input())]);
  await fs.writeFile(path.join(dataDir,'yesp-atm-strategy-paper.json'),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'base',chains:['base'],enabled:true,account:existing}));
  const candidate={...token,address:`0x${'b'.repeat(40)}`};
  let now=NOW+1000,candidateQuotes=0;const dispatches=[];
  const market={trending:async()=>({status:'ok',observedAt:iso(now),tokens:[candidate]}),
    kline:async args=>({...args,status:'ok',candles:bars()}),
    quote:async args=>{
      const observedAt=iso(now);dispatches.push(args.purpose);now+=1000;
      return {...args,status:'ok',price:args.address===CA?1.03:1.028+(++candidateQuotes)*.001,observedAt};
    }};
  const runtime=createPaperStrategyRuntime({...modes,dataDir,chain:'base',market,now:()=>now,evidenceLoader:()=>({}),fixedEntryUsd:10});
  try {
    await runtime.runOnce();now+=5000;await runtime.runOnce();await runtime.fastOnce();
    assert.equal(runtime.snapshot().researchPipeline.stageSnapshot[0].quoteReady,1,'main/control share one candidate, not two');
    for(let n=0;n<6&&runtime.snapshot().account.trades.length<2;n++) {
      await runtime.refreshQuote();await runtime.fastOnce();now+=3000;
    }
    const state=runtime.snapshot();
    assert.equal(dispatches[0],'exit');assert.ok(candidateQuotes>=2);
    assert.equal(state.account.trades.length,2,JSON.stringify({dispatches,rows:state.evaluations.map(r=>({missing:r.missing,reasons:r.reasons}))}));
    assert.deepEqual(state.account.trades[0],JSON.parse(JSON.stringify(existing.trades[0])));assert.equal(state.account.cash,80);
    assert.equal(state.account.trades[1].entryEvidence.opportunity.version,OPPORTUNITY_VERSION);
    assert.ok(state.cadence.quoteDispatches.exit>0&&state.cadence.quoteDispatches.candidate>=2);
    assert.equal(state.researchPipeline.stageSnapshot[0].observedCandidates,1);
  } finally {await runtime.stop();}
});

test('review rejects flat and falling quotes; old entry is available only to explicit control',()=>{
  for(const delta of [0,.001]) {
    const i=input();i.quoteHistory[0].price=i.token.price+delta;
    assert.notEqual(evaluate(i).decision,'可模拟');
    const old=evaluate({...i,opportunityReviewMode:false});assert.equal(old.decision,'可模拟');
    const fresh=createPaperStrategyAccount({nowMs:NOW});
    assert.equal(advance(fresh,[old]).trades.length,0);
    assert.equal(advance(fresh,[old],NOW,{opportunityReviewMode:false}).trades.length,1);
  }
});

test('recovery comparison-only quotes stay background; a real main candidate preempts without duplicate CA reads',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-book-quotes-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dataDir,'gmgn-readonly-plan.json'),JSON.stringify({version:1,plan:'plus'}));
  const weakInput=input('trend');weakInput.candles.at(-1).volume=80;
  const weak=weakInput.token,strong={...token,address:`0x${'b'.repeat(40)}`};
  assert.equal(readyForPaperQuote(evaluate({...weakInput,quoteHistory:[],priceObservedAt:null,memeExitMode:true,recoveryMode:true})),false);
  assert.equal(readyForPaperQuote(evaluate({...weakInput,quoteHistory:[],priceObservedAt:null,opportunityReviewMode:false})),true);
  let clock=NOW,includeMain=false;const calls=[];
  const market={trending:async()=>({status:'ok',observedAt:iso(clock),tokens:includeMain?[weak,strong]:[weak]}),
    kline:async args=>({...args,status:'ok',candles:args.address===CA?weakInput.candles:bars()}),
    quote:async args=>{calls.push({...args});return {...args,status:'ok',price:args.address===CA?weak.price:strong.price,observedAt:iso(clock)};}};
  const r=createPaperStrategyRuntime({...modes,memeExitMode:true,recoveryMode:true,fixedEntryUsd:10,dataDir,chain:'base',market,now:()=>clock,evidenceLoader:()=>({})});
  try{
    await r.runOnce();await r.fastOnce();await r.refreshQuote();await r.fastOnce();
    let s=r.snapshot();assert.equal(calls[0]?.purpose,'comparison',JSON.stringify({stage:s.researchPipeline.stageSnapshot,chart:s.researchPipeline.chartDiagnostics,eval:s.evaluations[0]?.evidence?.opportunityRoutes?.map(x=>({id:x.id,missing:x.missing,reasons:x.reasons}))}));
    assert.ok(!s.researchPipeline.entryFocus?.active,'control cannot freeze main discovery');
    assert.equal(s.cadence.lastCandidateQuote,null,'control response is not a main attempt');
    assert.equal(s.researchPipeline.stageSnapshot[0].mainQuoteReady,0);
    clock+=2000;await r.refreshQuote();assert.equal(calls.length,1,'background candidate is throttled');
    includeMain=true;await r.runOnce();await r.fastOnce();clock+=5000;await r.runOnce();await r.fastOnce();
    await r.refreshQuote();await r.fastOnce();s=r.snapshot();
    assert.equal(calls.at(-1).address,strong.address);assert.equal(calls.at(-1).purpose,'entry_confirmation');
    assert.equal(s.researchPipeline.quoteLease.candidateBook,'main');
    assert.equal(s.researchPipeline.entryFocus?.key,`base:${strong.address}`);
    assert.ok(s.researchPipeline.entryFocus?.active);
    assert.equal(s.cadence.lastCandidateQuote.address,strong.address);
    assert.equal(s.account.trades.length,0,'one quote never fabricates structure confirmation');
  }finally{await r.stop();}
});

test('a comparison holding in the same CA cannot downgrade fresh main entry confirmation',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-same-ca-book-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const main=createPaperStrategyAccount({nowMs:NOW}),comparison=createReviewComparison(main,NOW);
  comparison.control=advance(main,[evaluate({...input(),opportunityReviewMode:false})],NOW,{opportunityReviewMode:false});
  assert.equal(comparison.control.trades.length,1);
  const original=JSON.parse(JSON.stringify(comparison.control.trades[0]));
  await fs.writeFile(path.join(dataDir,'yesp-atm-strategy-paper.json'),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'base',chains:['base'],enabled:true,account:main,reviewComparison:comparison}));
  await fs.writeFile(path.join(dataDir,'gmgn-readonly-plan.json'),JSON.stringify({version:1,plan:'plus'}));
  let clock=NOW,price=1.03;const calls=[];
  const market={trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[token]}),
    kline:async args=>({...args,status:'ok',candles:bars()}),
    quote:async args=>{calls.push(args);return {...args,status:'ok',price,observedAt:iso(clock)};}};
  const options={...modes,memeExitMode:true,recoveryMode:true,fixedEntryUsd:10,dataDir,chain:'base',market,now:()=>clock,evidenceLoader:()=>({})};
  let r=createPaperStrategyRuntime(options);
  try{
    await r.runOnce();await r.fastOnce();await r.refreshQuote();await r.fastOnce();
    assert.equal(calls[0].purpose,'entry_confirmation');
    clock+=4000;price=1.031;await r.refreshQuote();await r.fastOnce();
    assert.equal(calls[1].purpose,'entry_confirmation','control holding must not impose 60s refresh');
    assert.equal(r.snapshot().account.trades.length,1);assert.equal(r.snapshot().account.cash,90);
    const saved=JSON.parse(await fs.readFile(r.stateFile,'utf8'));
    assert.deepEqual(saved.reviewComparison.control.trades[0],original);
    await r.stop();r=createPaperStrategyRuntime(options);await r.runOnce();
    assert.deepEqual(r.snapshot().account.trades,saved.account.trades,'restart neither resets nor duplicates the main fill');
    assert.equal(validatePaperStrategyAccount(r.snapshot().account),true);
  }finally{await r.stop();}
});

test('legacy trend explanation describes its own rules, not the reviewed main policy',()=>{
  const i=input('trend');
  i.quoteHistory[0].price=i.token.price*1.001;
  const legacy=evaluate({...i,opportunityReviewMode:false}),reviewed=evaluate(i);
  assert.equal(legacy.decision,'可模拟','legacy control still allows a structurally valid falling quote');
  assert.equal(legacy.evidence.opportunity.id,'external_trend');
  assert.equal(legacy.evidence.opportunity.version,'multi_setup_v1');
  assert.equal(legacy.evidence.opportunity.reviewVersion,undefined);
  assert.equal(legacy.evidence.entryPlan.economics,undefined);
  for(const text of [legacy.entryLogic,legacy.evidence.entryPlan.summary]) {
    assert.doesNotMatch(text,/向上报价共同确认|真实结构空间须覆盖成本/);
    assert.match(text,/旧策略对照/);
    assert.match(text,/0\.8 倍/);
    assert.match(text,/不要求上涨/);
  }
  assert.notEqual(reviewed.decision,'可模拟');
  assert.match(reviewed.entryLogic,/均线差、斜率、放量与向上报价共同确认/);
  assert.match(reviewed.entryLogic,/真实结构空间须覆盖成本/);
  assert.equal(reviewed.evidence.opportunity.version,OPPORTUNITY_VERSION);
});

test('MSFT-like nearly flat EMA signal cannot use a hypothetical 15 percent as profit evidence',()=>{
  const i=input('trend');
  i.candles=Array.from({length:30},(_,j)=>{const close=500+j*.0002;return {time:NOW-(30-j)*60000,open:close-.0001,high:close+.0001,low:close-.0001,close,volume:j===29?500:100};});
  i.token.price=i.candles.at(-1).close;i.quoteHistory=i.quoteHistory.map((q,j)=>({...q,price:i.token.price*(j?1:.99999)}));
  assert.notEqual(evaluate(i).decision,'可模拟');
  assert.equal(evaluate({...i,opportunityReviewMode:false}).decision,'可模拟');
});

test('new entries record real candle evidence, cost economics and volatility-buffered stop',()=>{
  const row=evaluate(input('trend')),p=row.evidence.opportunity.pattern,plan=row.evidence.entryPlan;
  assert.equal(row.decision,'可模拟');assert.ok(row.token.price-p.support>=p.atr*1.25-1e-12);
  assert.ok(plan.economics.ready);assert.ok(plan.economics.netRewardRisk>=1.2);
  assert.notEqual(plan.targetPrice,row.token.price*1.15);assert.equal(row.evidence.opportunity.closedCandles.length,30);
  const a=advance(createPaperStrategyAccount({nowMs:NOW}),[row]);
  assert.equal(Object.values(a.positions)[0].costAssumptions.feeRate,.01);
  const forged=structuredClone(row);forged.evidence.entryPlan.targetPrice=row.token.price*1.01;
  assert.equal(advance(createPaperStrategyAccount({nowMs:NOW}),[forged]).trades.length,0,'fill recomputes economics');
});

function failedBreakoutChart(now=NOW+120000) {
  const candles=[...bars(),...[1,2].map(n=>({time:NOW+(n-1)*60000,open:1.006,high:1.008,low:1.003,close:1.005,volume:180}))];
  return {...opportunityChart(candles,'ok',now),chain:'base',address:CA};
}
test('two bound post-entry closed bars invalidate breakout, not clocks, absent data or one bar',()=>{
  const opened=advance(createPaperStrategyAccount({nowMs:NOW}),[evaluate(input())]);
  for(const chart of [null,{...failedBreakoutChart(),chain:'eth'},failedBreakoutChart(NOW+60000)]) {
    const now=NOW+120000, mark={...token,status:'ok',price:1.005,observedAt:iso(now),structureChart:chart};
    const a=advance(opened,[],now,{enabled:false,marks:[mark]});assert.equal(a.trades.length,1);
  }
  const now=NOW+120000,mark={...token,status:'ok',price:1.005,observedAt:iso(now),structureChart:failedBreakoutChart()};
  const a=advance(opened,[],now,{enabled:false,marks:[mark]});assert.equal(a.trades.length,2);
  assert.match(a.trades.at(-1).reason,/连续两根/);assert.equal(a.trades.at(-1).exitEvidence.structureConfirmation.exit,true);
  assert.equal(validatePaperStrategyAccount(JSON.parse(JSON.stringify(a))),true);
  const p=Object.values(opened.positions)[0];
  assert.equal(assessStructureHold(p,failedBreakoutChart(),{...mark,observedAt:iso(NOW+60000)}).status,'warming','future bar cannot confirm an earlier quote');
});

test('structure target partial exit and 2/3x tiers leave a true 20 percent runner and restore safely',()=>{
  let a=advance(createPaperStrategyAccount({nowMs:NOW}),[evaluate(input())]),p=Object.values(a.positions)[0],q=p.initialQuantity;
  for(const [offset,price] of [[1000,p.exitPlan.referenceTargetPrice],[2000,p.entryPrice*2],[3000,p.entryPrice*3]]) {
    a=advance(a,[],NOW+offset,{enabled:false,marks:[{...token,status:'ok',price,observedAt:iso(NOW+offset)}]});
    assert.equal(validatePaperStrategyAccount(JSON.parse(JSON.stringify(a))),true);
  }
  p=Object.values(a.positions)[0];assert.ok(Math.abs(p.quantity/q-.2)<1e-10);assert.equal(p.firstTargetTaken,true);
  assert.equal(a.trades.filter(t=>t.side==='sell').length,3);
  assert.ok(a.trades.filter(t=>t.side==='sell').every(t=>t.realizedPnl>0));
});
