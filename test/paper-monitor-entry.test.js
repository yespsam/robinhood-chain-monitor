import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildPaperNewsWire} from '../src/paper-news-wire.js';
import {normalizePlatformCall,GMGN_SOCIAL_VERSION} from '../src/gmgn-social-monitor.js';
import {MONITOR_ENTRY_VERSION,validMonitorSignal,confirmMonitorQuote} from '../src/paper-monitor-signal.js';
import {evaluatePaperStrategies,createPaperStrategyAccount,advancePaperStrategyAccount,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {createPaperStrategyRuntime} from '../src/paper-strategy-runtime.js';
import {confirmedAccountGate} from '../src/paper-confirmed-policy.js';
import {readyForPaperQuote} from '../src/paper-candidate-research.js';
import {kolEvent} from './fixtures/paper-narrative-recall.js';
import {renderNewsWire} from '../dashboard/news-wire.js';
import {gasFixture} from './helpers/paper-gas-fixture.js';

// Isolated, synthetic fixtures. Nothing here is a real monitoring signal.
const NOW=Date.parse('2026-09-25T13:00:00Z'),CA=`0x${'a'.repeat(40)}`,OTHER=`0x${'b'.repeat(40)}`,iso=n=>new Date(n).toISOString();
const token={chain:'bsc',address:CA,symbol:'OFFLINE',price:1,liquidity:60000,volume:10000,marketStage:'unknown',buyTax:0,sellTax:0};
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true,memeExitMode:true};
const feed=(at=NOW)=>({version:GMGN_SOCIAL_VERSION,chains:{bsc:{status:'healthy',lastSuccessAt:iso(at)}},events:[normalizePlatformCall({
  id:'offline-test',signal_type:13,token_address:CA,trigger_at:(NOW-10000)/1000,data:{chain:'bsc',address:CA,symbol:'OFFLINE'}},'bsc',NOW)]});
const signal=()=>buildPaperNewsWire({gmgn:feed(),nowMs:NOW}).paperSignals[0];
const input=()=>({...modes,token:structuredClone(token),marketStatus:'ok',observedAt:iso(NOW),priceObservedAt:iso(NOW),requireFastQuote:true,
  nowMs:NOW,compoundingCash:100,fixedEntryUsd:10,candles:[],klineStatus:'unavailable',flow:{},monitorSignal:signal(),
  quoteHistory:[{...token,status:'ok',observedAt:iso(NOW)}]});
const evaluate=i=>evaluatePaperStrategies(i)[0];
const advance=(a,rows,extra={})=>advancePaperStrategyAccount(a,{...modes,evaluations:rows,nowMs:NOW,...extra});

test('monitor event high Gas is accounted for, not rejected at the old five-percent gate',()=>{
  const row=evaluate({...input(),chainGasAccounting:true,gasEstimate:gasFixture('bsc',NOW,2)});
  assert.equal(row.decision,'可模拟');assert.equal(row.evidence.opportunity.id,'monitored_event');
  assert.ok(row.evidence.costAssumptions.estimatedRoundTripCostRate>.4);
  const a=advance(createPaperStrategyAccount({nowMs:NOW}),[row],{chainGasAccounting:true});
  assert.equal(a.trades.length,1);assert.ok(a.positions[`bsc:${CA}`].entryCostsUsd>2);
  assert.equal(validatePaperStrategyAccount(a),true);
});

test('monitor signal is a separate opt-in paper lane, not authenticated Twitter or safety evidence',()=>{
  const w=buildPaperNewsWire({gmgn:feed(),nowMs:NOW}),s=w.paperSignals[0];
  assert.equal(w.hints[0].researchOnly,true);assert.equal(w.paperSignalCount,1);assert.equal(validMonitorSignal(s,token,NOW),true);
  assert.equal(s.authenticated,false);assert.equal(s.text,null);
  assert.equal(buildPaperNewsWire({gmgn:feed(NOW+121000),nowMs:NOW+121000}).paperSignalCount,0);
  for(const mutate of [f=>f.chains.bsc.status='backoff',f=>f.chains.bsc.lastSuccessAt=iso(NOW-31000),
    f=>f.events[0].conflict=true,f=>f.events[0].sourceAt=iso(NOW+1),f=>f.events[0].firstObservedAt=iso(NOW-11000)]){
    const f=feed();mutate(f);assert.equal(buildPaperNewsWire({gmgn:f,nowMs:NOW}).paperSignalCount,0,mutate.toString());
  }
});

test('own source needs authenticated exact single CA, declared chain, positive message and no conflicts',()=>{
  const e={...kolEvent(`BSC robotaxi launching ${CA}`,NOW-1000),chain:'bsc'};
  const wire=events=>buildPaperNewsWire({events,nowMs:NOW});
  const w=wire([e]);assert.equal(w.paperSignalCount,1);assert.equal(w.paperSignals[0].authenticated,true);
  assert.equal(evaluate({...input(),monitorSignal:w.paperSignals[0]}).decision,'可模拟');
  for(const text of ['BSC robotaxi launching',`BSC launching ${CA} ${OTHER}`,`BSC do not buy ${CA}`,`BSC 假冒 ${CA}`]){
    const bad=structuredClone(e);bad.tweet.text=text;assert.equal(wire([bad]).paperSignalCount,0);
  }
  const spoof=structuredClone(e);spoof.tweet.sourceVerifiedBy='unknown';assert.equal(wire([spoof]).paperSignalCount,0);
  const conflict=structuredClone(e);conflict.chain='base';assert.equal(wire([e,conflict]).paperSignalCount,0);
  const old={...kolEvent(`BSC launching ${CA}`,NOW-121000),chain:'bsc'};assert.equal(wire([old]).paperSignalCount,0);
});

test('one fresh post-trigger quote buys 10 paper dollars despite absent audits, flow, chart and stage',()=>{
  const row=evaluate(input());assert.equal(row.decision,'可模拟',JSON.stringify({m:row.missing,r:row.reasons}));
  const s=row.evidence.safety;assert.ok(s.auditMissing.includes('可卖出检测'));assert.ok(s.auditMissing.includes('Top10 集中度'));
  assert.equal(s.auditComplete,false);assert.equal(s.sellabilityVerified,false);assert.equal(s.metrics.top10HolderRate,null);
  assert.equal(row.evidence.flowFresh,false);assert.equal(row.evidence.flow.uniqueBuyerCount,null);
  const a=advance(createPaperStrategyAccount({nowMs:NOW}),[row]);assert.equal(a.trades.length,1);assert.equal(a.cash,90);
  assert.equal(a.trades[0].entryEvidence.entryPlan.entryPolicyVersion,MONITOR_ENTRY_VERSION);
  const p=a.positions[`bsc:${CA}`];assert.equal(p.activeStopPrice,null);assert.equal(p.memeExitPolicy.fixedStop,false);
  assert.equal(p.entryEvidence.traderDecision.hypothesis,'monitored_event');assert.match(p.entryEvidence.traderDecision.questions[0].text,/监控事件快线/);
  assert.equal(validatePaperStrategyAccount(a),true);assert.equal(advance(a,[],{nowMs:NOW+3600000}).trades.length,1);
  assert.equal(a.execution,false);assert.equal(a.signing,false);assert.equal(a.broadcast,false);
  const noQuote=input();noQuote.quoteHistory=[];noQuote.priceObservedAt=null;
  assert.equal(readyForPaperQuote(evaluate(noQuote)),true,'missing audit must not starve independent quote scheduling');
});

test('concentration and wash proxies remain visible as observations, not no-sell findings',()=>{
  const i=input();Object.assign(i.token,{isWashTrading:true,rugRatio:.9,top10HolderRate:.9,devTeamHoldRate:.8,bundlerRate:.9});
  const row=evaluate(i);assert.equal(row.decision,'可模拟');assert.equal(row.evidence.safety.warnings.length,5);
  assert.equal(row.evidence.safety.sourceBlocked.length,5);assert.equal(row.evidence.safety.metrics.rugRatio,.9);
  assert.equal(row.evidence.safety.blocked.length,0);
});

test('hard flags, malformed fields, absent taxes, bad quotes, stale data and insufficient cash still cannot fake a fill',()=>{
  const mutations=[i=>i.token.isHoneypot=true,i=>i.token.cannotSell=true,i=>i.token.isBlacklisted=true,
    i=>i.token.canMint=true,i=>i.token.canFreeze=true,i=>i.token.canPause=true,i=>i.token.fakePool=true,
    i=>i.token.stageConflict=true,i=>i.token.isHoneypot='nonsense',i=>i.token.rugRatio=2,
    i=>i.token.buyTax=null,i=>i.token.sellTax=null,i=>i.token.sellTax=.2,i=>i.token.liquidity=0,
    i=>i.token.volume=0,i=>i.compoundingCash=9,i=>i.observedAt=iso(NOW-121000),i=>i.priceObservedAt=iso(NOW-6000),
    i=>i.quoteHistory=[],i=>i.quoteHistory[0].observedAt=iso(NOW-6000),i=>i.quoteHistory[0].address=OTHER,
    i=>i.quoteHistory[0].price=2,i=>i.quoteHistory.push({...i.quoteHistory[0],price:2}),
    i=>i.monitorSignal.address=OTHER,i=>i.monitorSignal.id='forged',i=>i.monitorSignal.paperOnly=false,
    i=>i.monitorSignal.authenticated=true,i=>i.monitorSignal.sourceAt=iso(NOW-121000),i=>i.monitorSignal.sourceAt=iso(NOW+1),
    i=>i.monitorSignal.observedAt=iso(NOW-31000),i=>i.monitorSignal.sourceUrl='https://example.com'];
  for(const mutate of mutations){const i=input();mutate(i);const row=evaluate(i);
    assert.notEqual(row.decision,'可模拟',mutate.toString());assert.equal(advance(createPaperStrategyAccount({nowMs:NOW}),[row]).trades.length,0);
  }
  const row=evaluate(input());row.evidence.confirmedPolicy.confirmation.rows=[];
  assert.equal(advance(createPaperStrategyAccount({nowMs:NOW}),[row]).trades.length,0,'engine revalidates quote proof');
  const s=signal();s.sourceAt=iso(NOW-1000);
  assert.equal(confirmMonitorQuote([{...token,status:'ok',observedAt:iso(NOW-2000)}],token,s,NOW).ready,false);
});

test('no event can grant authority to controls or live modes and consumed/cross-source older events cannot buy again',()=>{
  const row=evaluate(input()),a=advance(createPaperStrategyAccount({nowMs:NOW}),[row]);
  assert.equal(advance(a,[row]).trades.length,1);
  assert.equal(advance(createPaperStrategyAccount({nowMs:NOW}),[row],{memeExitMode:false}).trades.length,0);
  assert.notEqual(evaluate({...input(),memeExitMode:false}).decision,'可模拟');
  assert.notEqual(evaluate({...input(),memeExitMode:false,opportunityReviewMode:false}).decision,'可模拟');
  const gate=o=>confirmedAccountGate(a,NOW,token,null,null,{continuousPaperMode:true,opportunity:o});
  assert.equal(gate(row.evidence.opportunity).allowed,false);
  const next=structuredClone(row.evidence.opportunity);next.signalId='different';
  assert.equal(gate(next).allowed,false);
  assert.throws(()=>advance({...a,execution:true},[]));
});

test('real runtime path discovers off-ranking event, researches only essential fields, quotes, fills and deduplicates',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-paper-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let at=NOW,detailCalls=0,quoteCalls=0;
  const market={trending:async()=>({status:'ok',observedAt:iso(at),tokens:[]}),trenches:async()=>({status:'ok',observedAt:iso(at),tokens:[]}),
    details:async()=>{detailCalls++;return {status:'ok',observedAt:iso(at),token};},
    quote:async()=>{quoteCalls++;return {...token,status:'ok',observedAt:iso(at)};},kline:async()=>({status:'unavailable',candles:[]})};
  const r=createPaperStrategyRuntime({...modes,market,dataDir:dir,chains:['bsc'],chain:'bsc',fixedEntryUsd:10,now:()=>at,
    evidenceLoader:()=>({events:[],gmgnSocial:feed(at)}),tradeReviewEvery:100});
  try{
    await r.runOnce();assert.equal(r.snapshot().cadence.detailTargets,1);
    await r.refreshDetails();assert.equal(detailCalls,1);at+=1000;await r.fastOnce();
    await r.refreshQuote();at+=100;await r.fastOnce();
    let s=r.snapshot();assert.ok(quoteCalls>0);assert.equal(s.account.trades.length,1,JSON.stringify(s.opportunityRoutes.at(-1)));
    assert.equal(s.account.trades[0].strategyLabel,'监控事件快线');assert.equal(s.account.cash,90);
    at+=100;await r.fastOnce();s=r.snapshot();assert.equal(s.account.trades.length,1);assert.equal(s.newsWire.unconsumedPaperSignals,0);
    assert.match(renderNewsWire(s.newsWire),/主模拟盘已启用监控事件快线/);
  }finally{await r.stop();}
});

test('monitored paper safety relaxation cannot waive the 6% tax cap',()=>{
  for(const field of ['buyTax','sellTax']) {
    const i=input();i.token[field]=.060001;
    const row=evaluate(i);assert.equal(row.decision,'不买');
    assert.ok(row.evidence.safety.blocked.some(r=>r.includes('税超过 6%')));
    assert.equal(advance(createPaperStrategyAccount({nowMs:NOW}),[row]).trades.length,0);
  }
});

test('scanner filters taxed rankings before candidate research, quotes and charts without muting news',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tax-scan-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let calls=0;
  const taxed={...token,buyTax:.060001};
  const market={trending:async()=>({status:'ok',observedAt:iso(NOW),tokens:[taxed]}),trenches:async()=>({status:'ok',observedAt:iso(NOW),tokens:[]}),
    details:async()=>{calls++;return {status:'ok',observedAt:iso(NOW),token:taxed};},
    quote:async()=>{calls++;return {...taxed,status:'ok',observedAt:iso(NOW)};},kline:async()=>{calls++;return {status:'unavailable',candles:[]};}};
  const r=createPaperStrategyRuntime({...modes,market,dataDir:dir,chain:'bsc',chains:['bsc'],fixedEntryUsd:10,now:()=>NOW,
    evidenceLoader:()=>({events:[],gmgnSocial:feed()})});
  try {
    await r.runOnce();await r.refreshDetails();await r.refreshQuote();await r.fastOnce();
    const s=r.snapshot();assert.equal(s.taxFilter.blockedCount,1);assert.equal(s.taxFilter.blocked[0].address,CA);
    assert.equal(s.cadence.detailTargets,0);assert.equal(s.cadence.quoteTargets,0);assert.equal(calls,0);
    assert.equal(s.account.trades.length,0);assert.ok(s.newsWire.paperSignalCount>0,'raw monitoring is not muted');
  }finally{await r.stop();}
});

test('off-ranking unknown tax can request details but a newly discovered high tax cannot enter',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tax-details-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let at=NOW,detailCalls=0,quoteCalls=0;
  const market={trending:async()=>({status:'ok',observedAt:iso(at),tokens:[]}),trenches:async()=>({status:'ok',observedAt:iso(at),tokens:[]}),
    details:async()=>{detailCalls++;return {status:'ok',observedAt:iso(at),token:{...token,sellTax:.07}};},
    quote:async()=>{quoteCalls++;return {...token,status:'ok',observedAt:iso(at)};},kline:async()=>({status:'unavailable',candles:[]})};
  const r=createPaperStrategyRuntime({...modes,market,dataDir:dir,chain:'bsc',chains:['bsc'],fixedEntryUsd:10,now:()=>at,
    evidenceLoader:()=>({events:[],gmgnSocial:feed(at)})});
  try {
    await r.runOnce();assert.equal(r.snapshot().taxFilter.unknownCount,1);assert.equal(r.snapshot().cadence.detailTargets,1);
    await r.refreshDetails();assert.equal(detailCalls,1);at+=1000;await r.fastOnce();await r.refreshQuote();
    const s=r.snapshot();assert.equal(s.taxFilter.blockedCount,1);assert.equal(s.cadence.detailTargets,0);
    assert.equal(s.account.trades.length,0);assert.equal(quoteCalls,0);
  }finally{await r.stop();}
});

test('holdings keep independent quotes and structure charts when their current tax rises above the cap',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tax-holding-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let at=NOW,current={...token},chartCalls=0;
  const market={trending:async()=>({status:'ok',observedAt:iso(at),tokens:[current]}),trenches:async()=>({status:'ok',observedAt:iso(at),tokens:[]}),
    quote:async()=>({...current,status:'ok',observedAt:iso(at)}),kline:async()=>{chartCalls++;return {status:'unavailable',candles:[]};}};
  const r=createPaperStrategyRuntime({...modes,market,dataDir:dir,chain:'bsc',chains:['bsc'],fixedEntryUsd:10,now:()=>at,
    evidenceLoader:()=>({events:[],gmgnSocial:feed(at)})});
  try {
    await r.runOnce();await r.refreshQuote();at+=100;await r.fastOnce();
    const prior=r.snapshot().account;assert.equal(prior.trades.length,1);
    const chartsBefore=chartCalls;
    // Unavailable chart responses retain their normal 60-second retry backoff.
    at+=61000;current={...token,sellTax:.07,price:1.05};await r.runOnce();
    await r.refreshQuote();at+=100;await r.fastOnce();
    const s=r.snapshot();assert.equal(s.taxFilter.blockedCount,1);assert.equal(s.cadence.quoteTargets,1);
    assert.equal(s.cadence.lastQuoteDispatch.purpose,'exit');assert.ok(chartCalls>chartsBefore);
    assert.equal(s.account.positions[`bsc:${CA}`].markPrice,1.05);assert.deepEqual(s.account.trades,prior.trades);
  }finally{await r.stop();}
});
