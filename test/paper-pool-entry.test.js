import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {strictFlapTrackedPoolTokenEvent} from './fixtures/paper-pool-event.js';
import {isStrictFlapTrackedPoolTokenUpdate} from '../src/source-controls.js';
import {buildPoolFirstThreeWire,poolEntryAllowed,validPoolSignal} from '../src/paper-pool-signal.js';
import {evaluatePaperStrategies,advancePaperStrategyAccount,createPaperStrategyAccount,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {createNarrativeResearchIndex} from '../src/paper-narrative-thesis.js';
import {ESTIMATED_COST_VERSION} from '../src/paper-estimated-cost.js';
import {createPaperStrategyRuntime} from '../src/paper-strategy-runtime.js';
import {createConfirmedPaperSession,createEstimatedPaperSession,LEGACY_PAPER_FILE} from '../src/paper-account-session.js';
import {createPublicSnapshot} from '../src/public-dashboard-state.js';
import {row as binanceRow,warmFeed,stateFor} from './fixtures/binance-flow.js';

const NOW=Date.parse('2026-09-30T06:00:00Z'),iso=v=>new Date(v).toISOString();
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,
  opportunityMode:true,memeExitMode:true,recoveryMode:true,lossRepairMode:true,estimatedFeeMode:true,evidenceGapExitMode:false};
const account=()=>({...createPaperStrategyAccount({nowMs:NOW}),estimatedCostModel:ESTIMATED_COST_VERSION});
function event(ordinal=1) {
  const raw=strictFlapTrackedPoolTokenEvent({ordinal,blockTimestamp:iso(NOW-4000+ordinal*1000),observedAt:iso(NOW)});
  const e=JSON.parse(JSON.stringify(raw).replaceAll('0x'+'4'.repeat(40),'0x'+String(ordinal+5).repeat(40))
    .replaceAll('0x'+'11'.repeat(32),'0x'+String(ordinal+3).repeat(64)));
  e.blockNumber+=ordinal;e.featureTokenProof.blockNumber=e.blockNumber;
  return e;
}
const wire=(events=[event()],a=account(),nowMs=NOW)=>buildPoolFirstThreeWire({events,account:a,nowMs});
function input(s) {
  const token={chain:s.chain,address:s.address,symbol:'OFFLINE',price:1,marketStage:'external',liquidity:60000,
    volume:10000,buyTax:0,sellTax:0,isHoneypot:false,isWashTrading:false,rugRatio:.01,
    top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01};
  return {...modes,token,marketStatus:'ok',observedAt:iso(NOW),priceObservedAt:iso(NOW),
    nowMs:NOW,compoundingCash:100,opportunityAccount:account(),requireFastQuote:true,flow:{},candles:[],klineStatus:'unavailable',
    monitorSignal:s,narrativeResearchIndex:createNarrativeResearchIndex({nowMs:NOW}),
    quoteHistory:[{...token,status:'ok',observedAt:iso(NOW)}]};
}
const evaluate=i=>evaluatePaperStrategies(i)[0];
const advance=(a,rows)=>advancePaperStrategyAccount(a,{...modes,evaluations:rows,nowMs:NOW});

test('canonical producer order, not arrival/popularity, yields three distinct CA and no fourth substitute',()=>{
  const events=[event(3),event(1),event(2),event(1),event(4)];
  assert.equal(isStrictFlapTrackedPoolTokenUpdate(events[0]),true);
  const w=wire(events);assert.deepEqual(w.signals.map(s=>s.pool.ordinal),[1,2,3]);
  assert.equal(new Set(w.signals.map(s=>s.address)).size,3);
  assert.equal(w.report.coverageNote.includes('其他发射台未覆盖'),true);
  for(const s of w.signals)assert.equal(validPoolSignal(s,s,NOW),true);
});

test('zero signals retain explicit source coverage gaps rather than declaring no market opportunities',()=>{
  const w=buildPoolFirstThreeWire({events:[],nowMs:NOW,sourceHealth:{status:'degraded',lastSuccessAt:iso(NOW-86400000),
    lastErrorCode:'FLAP_QUOTE_PORTAL_VERSION_MISMATCH',checkedAt:iso(NOW)}});
  assert.equal(w.report.readySignals,0);assert.equal(w.report.sourceHealth.status,'degraded');
  assert.match(w.report.sourceHealth.note,/零信号不能解释为市场没有/);
  assert.equal(w.report.lastVerifiedEventAt,null);
});

test('first-three reports late arrival separately from aged history, dedupes lag samples and never renews expiry',()=>{
  const old=event(1),late=event(2);old.observedAt=iso(NOW-180000);old.blockTimestamp=iso(NOW-181000);
  late.blockTimestamp=iso(NOW-705876);late.observedAt=iso(NOW);
  const w=wire([old,late,late]);
  assert.equal(w.signals.length,0);assert.equal(w.report.expiredOnArrivalEvents,1);
  assert.equal(w.report.uniqueEvents,2);assert.equal(w.report.latency.sampleCount,2);
  assert.equal(w.report.latency.p95Ms,705876);assert.equal(w.report.rejectionReasons.expired,2);
  assert.equal(w.report.diagnostics[0].verificationLagMs,705876);
  const future=event();future.observedAt=iso(NOW-10000);
  assert.equal(wire([future]).signals.length,0,'verification cannot precede source creation');
});

test('all three paper slots fill without chart or tweet, with frozen mechanism rather than forged endorsement',()=>{
  const signals=wire([event(1),event(2),event(3)]).signals;
  const rows=signals.map(s=>evaluate(input(s)));
  for(const row of rows){assert.equal(row.decision,'可模拟',JSON.stringify({r:row.reasons,m:row.missing}));
    assert.equal(row.evidence.narrativeThesis.relationship.kind,'onchain_pool');
    assert.equal(row.evidence.lossRepair.group,'new_pool_first_three');}
  const a=advance(account(),rows);assert.equal(a.trades.length,3);assert.equal(validatePaperStrategyAccount(a),true);
  assert.deepEqual(a.trades.map(t=>t.entryEvidence.newLaunch.pool.ordinal).sort(),[1,2,3]);
  assert.equal(advance(a,rows).trades.length,3);assert.equal(a.execution,false);assert.equal(a.signing,false);
  for(const s of signals)assert.equal(poolEntryAllowed(s,{trades:a.trades},NOW),false,'exit/cash reset cannot erase consumed ranks');
  assert.equal(wire([event(1),event(2),event(3)],a).signals.length,0);
});

test('missing rank, unsafe data, stale quotes or stale/future/cross-CA proofs cannot fabricate fills',()=>{
  const changes=[i=>i.monitorSignal.pool.ordinal=4,i=>delete i.monitorSignal.poolEvent,
    i=>i.monitorSignal.poolEvent.featureTokenProof.canonical=false,i=>i.monitorSignal.poolEvent.tokens[0].token='0x'+'a'.repeat(40),
    i=>i.token.isHoneypot=true,i=>delete i.token.isHoneypot,i=>i.token.sellTax=.07,
    i=>i.token.liquidity=0,i=>i.token.stageConflict=true,i=>i.quoteHistory=[],
    i=>i.quoteHistory[0].observedAt=iso(NOW-6000)];
  for(const change of changes){const i=input(wire().signals[0]);change(i);const r=evaluate(i);
    assert.notEqual(r.decision,'可模拟',change.toString());assert.equal(advance(account(),[r]).trades.length,0);}
  assert.equal(wire([event()],account(),NOW+120001).signals.length,0);
  assert.equal(wire([event()],account(),NOW-10000).signals.length,0);
  assert.throws(()=>evaluate({...input(wire().signals[0]),lossRepairMode:false}),/isolated repair/);
  const unsupported={...event(),featurePlatform:'fourmeme'};assert.equal(wire([unsupported]).signals.length,0);
});

test('conflicting ordinals, duplicate CA in another rank and reversed canonical order quarantine the asset',()=>{
  const first=event(1),second=event(2);
  const conflict=JSON.parse(JSON.stringify(first).replaceAll(first.tokens[0].token,'0x'+'a'.repeat(40)));
  assert.equal(isStrictFlapTrackedPoolTokenUpdate(conflict),true);
  assert.equal(wire([first,conflict]).signals.length,0);
  const duplicate=JSON.parse(JSON.stringify(second).replaceAll(second.tokens[0].token,first.tokens[0].token));
  assert.equal(wire([first,duplicate]).signals.length,0);
  second.blockNumber=first.blockNumber-1;second.featureTokenProof.blockNumber=second.blockNumber;
  assert.equal(wire([first,second]).signals.length,0);
});

test('writer recomputes ordinal/quote binding and does not grant control-book or real execution authority',()=>{
  const row=evaluate(input(wire().signals[0]));
  for(const change of [r=>r.evidence.newLaunch.pool.ordinal=3,r=>r.evidence.recoveryEntry.newLaunch.pool.quoteAddress='0x'+'a'.repeat(40),
    r=>r.evidence.opportunity.event.poolEvent.featureTokenOrdinal=4,r=>r.evidence.safety.auditComplete=false]){
    const r=structuredClone(row);change(r);assert.equal(advance(account(),[r]).trades.length,0);}
  assert.throws(()=>advancePaperStrategyAccount(account(),{...modes,lossRepairMode:false,evaluations:[row],nowMs:NOW}),/cannot write original main/);
  const a=advance(account(),[row]);Object.values(a.positions)[0].launchThesis.pool.ordinal=3;
  assert.throws(()=>validatePaperStrategyAccount(a),/launch event thesis/);
});

test('new activation generation cannot reset a quote asset slot; a different quote asset is independent',()=>{
  const s=wire().signals[0],a=advance(account(),[evaluate(input(s))]);
  const raw=event(2),old=raw.featureGenerationKey;
  // A generation replay with a different activation hash still has a valid producer contract.
  const replacement=JSON.parse(JSON.stringify(raw).replaceAll('0x'+'22'.repeat(32),'0x'+'88'.repeat(32)));
  replacement.mode.fingerprint=createHash('sha256').update(JSON.stringify({generationKey:replacement.featureGenerationKey,
    quoteAddress:replacement.mode.quoteAsset})).digest('hex').slice(0,20);
  assert.notEqual(replacement.featureGenerationKey,old);assert.equal(isStrictFlapTrackedPoolTokenUpdate(replacement),true);
  assert.equal(wire([replacement],a).signals.length,0);
  const distinct=JSON.parse(JSON.stringify(event(1)).replaceAll(s.pool.quoteAddress,'0x'+'b'.repeat(40)));
  distinct.tokens[0].token='0x'+'c'.repeat(40);
  const distinctBound=JSON.parse(JSON.stringify(distinct).replaceAll(s.address,'0x'+'c'.repeat(40)));
  distinctBound.mode.fingerprint=createHash('sha256').update(JSON.stringify({generationKey:distinctBound.featureGenerationKey,
    quoteAddress:distinctBound.mode.quoteAsset})).digest('hex').slice(0,20);
  assert.equal(isStrictFlapTrackedPoolTokenUpdate(distinctBound),true);assert.equal(wire([distinctBound],a).signals.length,1);
  assert.equal(poolEntryAllowed(s,{trades:[{side:'buy',chain:s.chain,address:s.address}]},NOW),false);
});

test('runtime discovers off-ranking first-three receipts, quotes without candles, persists and resumes without duplicates',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-pool-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'bsc',chains:['bsc'],enabled:false,account:createPaperStrategyAccount({nowMs:NOW})}));
  await createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-pool-original',nowMs:NOW});
  const session=await createEstimatedPaperSession({dataDir,id:'confirmed-pvp-v2-estimated-pool-test',nowMs:NOW});
  let clock=NOW,charts=0;const events=[event(3),event(2),event(1)];
  const tokens=new Map(wire(events).signals.map(s=>[s.address,input(s).token]));
  const market={trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    details:async ({address})=>({status:'ok',observedAt:iso(clock),token:tokens.get(address)}),
    quote:async ({address})=>({...tokens.get(address),status:'ok',observedAt:iso(clock)}),
    kline:async()=>{charts++;return {status:'unavailable',candles:[]};}};
  const options={...modes,dataDir,session,chain:'bsc',chains:['bsc'],market,now:()=>clock,
    evidenceLoader:()=>({events}),intervalMs:60000,marketIntervalMs:60000};
  let runtime=createPaperStrategyRuntime(options);
  try{
    await runtime.runOnce();await runtime.setEnabled(true);await runtime.start();
    for(let i=0;i<80&&runtime.snapshot().account.trades.length<3;i++){
      await runtime.fastOnce();await runtime.refreshDetails();await runtime.refreshQuote();
      await new Promise(resolve=>setTimeout(resolve,10));clock+=250;
    }
    const s=runtime.snapshot();assert.equal(s.account.trades.length,3,JSON.stringify({r:s.researchPipeline,m:s.evaluations.map(e=>({r:e.reasons,m:e.missing}))}));
    const p=createPublicSnapshot(s,clock);assert.deepEqual(p.poolFirstThreePolicy.supportedSources,['bsc:flap','bsc:fourmeme']);
    assert.ok(Object.values(s.account.positions).every(x=>x.entryEvidence.newLaunch.pool.ordinal<=3));
    assert.equal(validatePaperStrategyAccount(s.account),true);
    await runtime.stop();runtime=createPaperStrategyRuntime(options);await runtime.runOnce();
    assert.equal(runtime.snapshot().account.trades.length,3);assert.equal(runtime.snapshot().enabled,true);
  }finally{await runtime.stop();}
});

test('new pool event after the broad scan goes directly through details and quote to one paper fill',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-pool-event-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'bsc',chains:['bsc'],enabled:false,account:createPaperStrategyAccount({nowMs:NOW})}));
  await createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-event-original',nowMs:NOW});
  const session=await createEstimatedPaperSession({dataDir,id:'confirmed-pvp-v2-estimated-event-test',nowMs:NOW});
  const original=await fs.readFile(path.join(dataDir,session.legacy.file),'utf8');
  const source=event(1),tok=input(wire([source]).signals[0]).token;
  let events=[],detailCalls=0,quoteCalls=0;
  const market={trending:async()=>({status:'ok',observedAt:iso(NOW),tokens:[]}),trenches:async()=>({status:'ok',observedAt:iso(NOW),tokens:[]}),
    details:async()=>{detailCalls++;return {status:'ok',observedAt:iso(NOW),token:tok};},
    quote:async()=>{quoteCalls++;return {...tok,status:'ok',observedAt:iso(NOW)};},
    kline:async()=>{throw Error('new pool lane must not need candles');}};
  const r=createPaperStrategyRuntime({...modes,dataDir,session,chain:'bsc',chains:['bsc'],market,now:()=>NOW,
    evidenceLoader:()=>({events}),intervalMs:60000,marketIntervalMs:60000});
  try {
    await r.runOnce();await r.setEnabled(true);await r.start();await r.fastOnce();
    const ticks=r.snapshot().cadence.tickCount;
    events=[source];await r.refreshEvents();
    for(let n=0;n<100&&!r.snapshot().account.trades.length;n++)await new Promise(resolve=>setTimeout(resolve,10));
    const s=r.snapshot();assert.equal(s.account.trades.length,1,JSON.stringify(s.cadence.eventDispatch));
    assert.equal(s.cadence.tickCount,ticks,'no broad rescan required');
    assert.equal(detailCalls,1);assert.equal(quoteCalls,1);
    assert.equal(s.account.trades[0].entryEvidence.newLaunch.pool.ordinal,1);
    for(let n=0;n<3;n++)await r.refreshEvents();
    assert.equal(r.snapshot().account.trades.length,1);
    assert.equal(quoteCalls,1,'same immutable event cannot storm quote requests');
    assert.equal(await fs.readFile(path.join(dataDir,session.legacy.file),'utf8'),original);
    for(const key of ['execution','signing','broadcast'])assert.equal(s[key],false);
  }finally{await r.stop();}
});

test('new secondary wallet buy wakes the CA once despite an older preferred cohort, without authorizing a fill',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-dual-event-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'bsc',chains:['bsc'],enabled:false,account:createPaperStrategyAccount({nowMs:NOW})}));
  await createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-dual-original',nowMs:NOW});
  const session=await createEstimatedPaperSession({dataDir,id:'confirmed-pvp-v2-estimated-dual-test',nowMs:NOW});
  const original=await fs.readFile(path.join(dataDir,session.legacy.file),'utf8');
  let evidence={},quotes=0;
  const market={trending:async()=>({status:'ok',observedAt:iso(NOW),tokens:[]}),trenches:async()=>({status:'ok',observedAt:iso(NOW),tokens:[]}),
    details:async()=>({status:'unavailable'}),quote:async()=>{quotes++;return {status:'unavailable'};},kline:async()=>({status:'unavailable',candles:[]})};
  const r=createPaperStrategyRuntime({...modes,dataDir,session,chain:'bsc',chains:['bsc'],market,now:()=>NOW,
    evidenceLoader:()=>evidence,intervalMs:60000,marketIntervalMs:60000});
  try {
    await r.runOnce();await r.setEnabled(true);await r.start();await r.fastOnce();
    const ticks=r.snapshot().cadence.tickCount;
    const row=binanceRow(1,{chainId:'56',ts:(NOW-20000)/1000}),feed=warmFeed([row],{chain:'bsc',kind:'kol',at:NOW});
    evidence={flowState:{chains:{bsc:{status:'healthy',feedCoverage:Object.fromEntries(['smartmoney','kol'].map(k=>[k,
      {valid:true,startAt:NOW-360000,endAt:NOW,observedAt:NOW}]))}},profiles:{},trades:{bsc:[
      {chain:'bsc',tokenAddress:row.ca,wallet:row.address,side:'buy',amountUsd:1000,at:NOW-110000,hash:row.txHash,tags:['smart_degen']}]}},
      binanceState:{...stateFor(feed),updatedAt:NOW,chains:{bsc:{feeds:{kol:feed}}}}};
    await r.refreshEvents();
    for(let n=0;n<100&&!r.snapshot().cadence.eventDispatch.evaluations;n++)await new Promise(resolve=>setTimeout(resolve,10));
    const s=r.snapshot(),last=s.cadence.eventDispatch.lastEvaluation;
    assert.equal(s.cadence.tickCount,ticks,'does not wait for a broad scan');
    assert.equal(s.cadence.eventDispatch.evaluations,1);assert.equal(last.provider,'binance_kol');
    assert.equal(last.sourceToDetectionMs,20000);assert.equal(last.detectionToEvaluationMs,0);
    assert.equal(last.sourceWindowEndAt,iso(NOW-10000));assert.equal(last.sourceSnapshotReceivedAt,iso(NOW));
    for(let n=0;n<3;n++)await r.refreshEvents();
    assert.equal(r.snapshot().cadence.eventDispatch.evaluations,1,'same snapshot does not storm the writer');
    assert.equal(s.account.trades.length,0);assert.equal(quotes,0);
    assert.equal(await fs.readFile(path.join(dataDir,session.legacy.file),'utf8'),original);
    for(const key of ['execution','signing','broadcast'])assert.equal(s[key],false);
  }finally{await r.stop();}
});
