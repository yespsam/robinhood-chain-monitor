import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPaperStrategyAccount,evaluatePaperStrategies,advancePaperStrategyAccount,validatePaperStrategyAccount,costAssumptions} from '../src/paper-strategy-engine.js';
import {createConfirmedPaperSession,createEstimatedPaperSession,loadEstimatedPaperSession,paperSessionLedgerFile,LEGACY_PAPER_FILE,PAPER_SESSION_FILE,ESTIMATED_SESSION_FILE} from '../src/paper-account-session.js';
import {createPaperStrategyRuntime} from '../src/paper-strategy-runtime.js';
import {loadPaperLossGuardPolicy, paperLossGuard} from '../src/paper-loss-guard.js';
import {ESTIMATED_COST_VERSION,ESTIMATED_GAS_USD} from '../src/paper-estimated-cost.js';
import {opportunityChart} from '../src/paper-opportunity-policy.js';
import {createPublicSnapshot} from '../src/public-dashboard-state.js';
import {ALPHA_LIST_URL,ALPHA_ENTRY_VERSION,advanceAlphaCatalog} from '../src/binance-alpha-catalog.js';
import {createNarrativeResearchIndex} from '../src/paper-narrative-thesis.js';
const NOW=Date.parse('2026-09-28T05:00:00Z'),iso=t=>new Date(t).toISOString(),CA='0x'+'a'.repeat(40),ID='confirmed-pvp-v2-estimated-offline';
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true,memeExitMode:true,recoveryMode:true,lossRepairMode:true};
const token={chain:'base',address:CA,symbol:'OFFLINE',price:1.03,marketStage:'external',liquidity:60000,volume:5000,
  isHoneypot:false,isWashTrading:false,rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,buyTax:0,sellTax:0};
const candles=()=>Array.from({length:30},(_,i)=>({time:NOW-(30-i)*60000,open:i===29?1:i<8?.8+i*.025:1,
  high:i===29?1.035:i<8?.81+i*.025:1.01,low:i===29?.999:i<8?.795+i*.025:.995,
  close:i===29?1.03:i<8?.8+i*.025:1,volume:i===29?180:100}));
const flow=()=>({...token,status:'healthy',provider:'gmgn',fresh:true,complete:true,observedAt:iso(NOW),netBuyUsd:600,
  uniqueBuyerCount:2,smartMoneyCount:2,highProfitCount:1,profileCheckedCount:1,fomoCount:0,
  wallets:[1,2].map(n=>({wallet:'0x'+String(n).repeat(40),buyUsd:300,sellUsd:0,netBuyUsd:300,tags:['smart_money'],lastBuyAt:NOW-1000}))});
const input=()=>({...modes,estimatedFeeMode:true,nowMs:NOW,token:{...token},observedAt:iso(NOW),marketStatus:'ok',priceObservedAt:iso(NOW),flow:flow(),
  requireFastQuote:true,compoundingCash:100,klineStatus:'ok',candles:candles(),
  quoteHistory:[-4000,0].map(d=>({...token,status:'ok',observedAt:iso(NOW+d),price:d?1.028:1.03}))});
const estimatedAccount=()=>({...createPaperStrategyAccount({nowMs:NOW}),estimatedCostModel:ESTIMATED_COST_VERSION});

test('estimated book skips legacy shadow evaluation and renders full learning reports only on demand', async t => {
  const f = await fixture(t, 'bsc'), session = await createEstimatedPaperSession({ dataDir: f.dataDir, id: ID, nowMs: NOW });
  let reportReads = 0, evidenceReads = 0, legacyEvaluations = 0, brokenReport = false;
  const market = { trending: async () => ({ status: 'ok', observedAt: iso(NOW), tokens: [{ ...token, chain: 'bsc' }] }),
    trenches: async () => ({ status: 'ok', observedAt: iso(NOW), tokens: [] }),
    kline: async q => ({ ...q, status: 'unavailable', candles: [] }), quote: async () => ({ status: 'unavailable' }) };
  const r = createPaperStrategyRuntime({ ...modes, dataDir: f.dataDir, session, chain: 'bsc', chains: ['bsc'], market,
    now: () => NOW, evidenceLoader: () => ({}),
    learningLoader: () => { evidenceReads++; return { policies: [{ id: 'unused-legacy-policy' }], verifiedProfiles: {} }; },
    learningReportSnapshot: () => { reportReads++; if (brokenReport) throw Error('SECRET'); return { walletCount: 7, policies: [], lastError: null }; },
    evaluate: i => { if (!i.confirmedMode) legacyEvaluations++; return evaluatePaperStrategies(i); } });
  try {
    await r.runOnce(); await r.fastOnce();
    assert.equal(reportReads, 0, 'observation reports are not in scan/decision preparation');
    assert.ok(evidenceReads >= 2); assert.equal(legacyEvaluations, 0);
    const s = r.snapshot(); assert.equal(reportReads, 1); assert.equal(s.learning.walletCount, 7);
    assert.equal(s.account.cash, 100); assert.equal(s.account.trades.length, 0);
    assert.equal(s.cadence.runtimePathVersion, 'paper_compute_memo_v2');
    assert.equal(s.cadence.phaseTiming.newsWireMs, 0);
    assert.equal(s.cadence.phaseTiming.narrativeRecallMs, 0);
    const saved = JSON.parse(await fs.readFile(r.stateFile, 'utf8'));
    assert.equal(saved.learningShadow, null); assert.equal(saved.reviewComparison, null); assert.equal(saved.exitComparison, null);
    brokenReport = true; await r.fastOnce();
    assert.equal(r.snapshot().learning.lastError, 'learning_report_unavailable');
    assert.equal(r.snapshot().account.cash, 100, 'report errors do not affect the ledger');
  } finally { await r.stop(); }
});

test('graduated launchpad entry uses a valid post-open window, not earlier disputed candles',()=>{
  const i=input();i.flow={};i.token={...i.token,chain:'bsc',launchpadPlatform:'flap',
    creationTimestamp:(NOW-27*60000+11000)/1000,openTimestamp:(NOW-27*60000+11000)/1000};
  i.quoteHistory=i.quoteHistory.map(q=>({...q,chain:'bsc'}));
  const before=structuredClone(i),r=evaluatePaperStrategies(i)[0];
  assert.equal(r.evidence.chartSelection.excludedPrefixBars,3);
  assert.equal(r.evidence.recoveryEntry.candles.length,27);
  assert.equal(r.decision,'可模拟',JSON.stringify({r:r.reasons,m:r.missing}));
  assert.equal(advancePaperStrategyAccount(estimatedAccount(),{...modes,estimatedFeeMode:true,evaluations:[r],nowMs:NOW}).trades.length,1);
  assert.deepEqual(i,before);
  const tooYoung=structuredClone(i);tooYoung.token.creationTimestamp=tooYoung.token.openTimestamp=(NOW-10*60000)/1000;
  assert.notEqual(evaluatePaperStrategies(tooYoung)[0].decision,'可模拟','no invented pre-open history');
  const unbound=structuredClone(i);unbound.token.openTimestamp=null;
  assert.notEqual(evaluatePaperStrategies(unbound)[0].decision,'可模拟','ordinary birth mismatch still fails');
});

test('hot external non-setup receives bounded normal-priority quotes without a forced fill',async t=>{
  const f=await fixture(t,'bsc'),session=await createEstimatedPaperSession({dataDir:f.dataDir,id:ID,nowMs:NOW});
  let clock=NOW;const calls=[],hot={...token,chain:'bsc',rank:3,volumeWindow:'1h',volume:1332510,price:1};
  const flat=Array.from({length:30},(_,i)=>({time:NOW-(30-i)*60000,open:1,high:1.001,low:.999,close:1,volume:100}));
  const market={trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[hot]}),
    trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    kline:async q=>({chain:q.chain,address:q.address,resolution:'1m',status:'ok',candles:flat}),
    quote:async q=>{calls.push(q);return {...q,status:'ok',price:1,observedAt:iso(clock)};}};
  const r=createPaperStrategyRuntime({...modes,dataDir:f.dataDir,session,chain:'bsc',chains:['bsc'],market,now:()=>clock,evidenceLoader:()=>({})});
  try{
    await r.runOnce();await r.setEnabled(true);await r.fastOnce();await r.refreshQuote();await r.fastOnce();
    assert.ok(calls.length>0,JSON.stringify({hot:r.snapshot().researchPipeline.hotCandidates,probe:r.snapshot().researchPipeline.hotQuoteResearch,
      e:r.snapshot().evaluations.map(e=>({chart:e.evidence.chart,safety:e.evidence.safety,repair:e.evidence.lossRepair,cost:e.evidence.costAssumptions}))}));
    assert.ok(calls.every(q=>q.purpose==='candidate'&&q.researchOnly===true),'never borrow critical confirmation priority');
    const s=r.snapshot();assert.equal(s.account.trades.length,0);assert.equal(s.account.cash,100);
    assert.equal(s.researchPipeline.hotQuoteResearch.target.address,CA);
    clock+=16000;await r.fastOnce();const count=calls.length;await r.refreshQuote();assert.equal(calls.length,count);
    assert.equal(r.snapshot().researchPipeline.hotQuoteResearch.target,null);assert.equal(s.execution,false);
  }finally{await r.stop();}
});

test('signalled but economically unready Alpha research cannot occupy critical confirmation or pause discovery',async t=>{
  const f=await fixture(t),session=await createEstimatedPaperSession({dataDir:f.dataDir,id:ID,nowMs:NOW});
  let clock=NOW;const calls=[],thin={...token,liquidity:10000};
  const market={trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[thin]}),
    trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    kline:async q=>({...q,status:'ok',candles:candles()}),
    quote:async q=>{calls.push(q);return {...q,status:'ok',price:1.03,observedAt:iso(clock)};}};
  const r=createPaperStrategyRuntime({...modes,dataDir:f.dataDir,session,chain:'base',chains:['base'],market,now:()=>clock,
    evidenceLoader:()=>({alphaCatalog:advanceAlphaCatalog(null,[{...alphaInput().alphaSignal,tokenId:'offline',symbol:'OFFLINE',name:'Offline'}],clock)}),
    intervalMs:60000,marketIntervalMs:60000});
  try{
    await r.runOnce();await r.setEnabled(true);await r.start();
    for(let n=0;n<3;n++){await r.fastOnce();await r.refreshQuote();clock+=4000;}
    assert.ok(calls.length>0,'unready candidates can still obtain real research quotes');
    assert.ok(calls.every(q=>q.researchOnly===true&&q.purpose==='candidate'),JSON.stringify(calls));
    assert.notEqual(r.snapshot().researchPipeline.entryFocus?.active,true);
    assert.equal(r.snapshot().account.trades.length,0);assert.equal(r.snapshot().researchPipeline.researchDeferrals.auxiliary,0);
  }finally{await r.stop();}
});

const alphaInput=(age=7200000)=>{
  const listingTime=NOW-age;
  return {...input(),flow:{},narrativeResearchIndex:createNarrativeResearchIndex({nowMs:NOW}),
    alphaSignal:{version:ALPHA_ENTRY_VERSION,sourceUrl:ALPHA_LIST_URL,chain:token.chain,address:CA,
      alphaId:'ALPHA_123',listingTime,observedAt:iso(NOW),offline:false,offsell:false,
      id:`binance-alpha:ALPHA_123:${token.chain}:${CA}:${listingTime}`}};
};
test('BSC estimated runtime exposes a three-CA shortlist without increasing requests or bypassing quote gates',async t=>{
  const f=await fixture(t,'bsc'),session=await createEstimatedPaperSession({dataDir:f.dataDir,id:ID,nowMs:NOW});
  const tokens=[1,2,3,4,5].map(n=>({...token,chain:'bsc',address:'0x'+String(n).repeat(40)}));
  let chartCalls=0;
  const market={trending:async()=>({status:'ok',observedAt:iso(NOW),tokens}),
    trenches:async()=>({status:'ok',observedAt:iso(NOW),tokens:[]}),
    kline:async q=>{chartCalls++;return {chain:q.chain,address:q.address,status:'unavailable',candles:[]};},
    quote:async()=>{assert.fail('missing structure cannot create a quote/entry');}};
  const r=createPaperStrategyRuntime({...modes,dataDir:f.dataDir,session,chain:'bsc',chains:['bsc'],market,now:()=>NOW,evidenceLoader:()=>({})});
  try{
    await r.runOnce();const s=r.snapshot();
    assert.equal(s.researchPipeline.hotLimit,3);assert.equal(s.researchPipeline.hotCandidates.length,3);
    assert.equal(s.researchPipeline.readonlyAdmission.backgroundConcurrency,1);
    assert.equal(s.researchPipeline.readonlyAdmission.criticalAgingBypass,false);
    assert.ok(chartCalls<=1,'shortlist expansion does not dispatch three concurrent charts');
    assert.equal(s.account.trades.length,0);assert.equal(s.signing,false);assert.equal(s.broadcast,false);
  }finally{await r.stop();}
});
test('estimated external structure independently opens without news or wallet profiles, with unchanged safety and quote gates',()=>{
  const i={...input(),flow:{}},row=evaluatePaperStrategies(i)[0];
  assert.equal(row.decision,'可模拟');assert.equal(row.evidence.opportunity.basis,'ohlcv');
  assert.equal(row.evidence.lossRepair.catalystReady,false);
  assert.equal(row.evidence.lossRepair.entryPathAllowed,true);
  assert.equal(row.evidence.lossRepair.entryPath,'external_structure');
  assert.equal(row.evidence.lossRepair.group,'price_only','do not relabel momentum as verified narrative');
  const opened=advancePaperStrategyAccount(estimatedAccount(),{...modes,estimatedFeeMode:true,evaluations:[row],nowMs:NOW});
  assert.equal(opened.trades.length,1);validatePaperStrategyAccount(opened);
  assert.equal(opened.trades[0].entryEvidence.traderDecision.selectionPolicy,'eligible_algorithm_catalyst_v3');
  for(const mutate of [x=>x.quoteHistory=[],x=>x.quoteHistory[0].price=1.04,x=>x.token.marketStage='internal',
    x=>x.token.buyTax=.07,x=>x.token.isHoneypot=true,x=>x.token.sellTax=null,
    x=>x.observedAt=iso(NOW-120001),x=>x.candles[29].high=.5,x=>x.candles=[]]) {
    const bad=structuredClone(i);mutate(bad);
    const next=advancePaperStrategyAccount(estimatedAccount(),{...modes,estimatedFeeMode:true,evaluations:evaluatePaperStrategies(bad),nowMs:NOW});
    assert.equal(next.trades.length,0,mutate.toString());
  }
  const forged=structuredClone(row);forged.evidence.opportunity={id:'flow_momentum',basis:'flow'};
  assert.equal(advancePaperStrategyAccount(estimatedAccount(),{...modes,estimatedFeeMode:true,evaluations:[forged],nowMs:NOW}).trades.length,0);
});

test('isolated external route completes chart, quote, fill and restart without original history changes',async t=>{
  const f=await fixture(t),session=await createEstimatedPaperSession({dataDir:f.dataDir,id:ID,nowMs:NOW});
  let clock=NOW,price=1.028;const calls=[];
  const market={trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[{...token,price}]}),
    trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    kline:async q=>{calls.push(['chart',q.purpose]);return {...token,resolution:'1m',status:'ok',candles:candles()};},
    quote:async()=>{calls.push(['quote']);return {...token,price,status:'ok',observedAt:iso(clock)};}};
  const options={...modes,dataDir:f.dataDir,session,chain:'base',chains:['base'],market,now:()=>clock,evidenceLoader:()=>({})};
  let r=createPaperStrategyRuntime(options);
  try {
    await r.runOnce();await r.setEnabled(true);
    for(let n=0;n<6&&r.snapshot().account.trades.length===0;n++){
      await r.fastOnce();await r.refreshQuote();await r.fastOnce();clock+=4000;price=1.03;
    }
    const s=r.snapshot();assert.equal(s.account.trades.length,1,JSON.stringify(s.evaluations.map(x=>({missing:x.missing,reasons:x.reasons}))));
    assert.ok(calls.filter(c=>c[0]==='quote').length>=2);assert.ok(calls.some(c=>c[0]==='chart'));
    assert.equal(s.account.trades[0].entryEvidence.lossRepair.entryPath,'external_structure');
    const before=JSON.parse(JSON.stringify(s.account.trades)),cash=s.account.cash;
    await r.stop();r=createPaperStrategyRuntime(options);await r.runOnce();
    assert.deepEqual(JSON.parse(JSON.stringify(r.snapshot().account.trades)),before);assert.equal(r.snapshot().account.cash,cash);
    assert.equal(await fs.readFile(f.originalFile,'utf8'),f.original);
  }finally{await r.stop();}
});
test('three-list BSC ranking and completed-only candidates can still complete a paper fill and restore it',async t=>{
  for(const source of ['ranking_5m','completed'])await t.test(source,async t=>{
    const f=await fixture(t,'bsc'),session=await createEstimatedPaperSession({dataDir:f.dataDir,id:ID,nowMs:NOW});
    let clock=NOW,price=1.028;const current=()=>({...token,chain:'bsc',price,
      ...(source==='ranking_5m'?{volumeWindow:'5m',rank:1}:{marketCategory:'completed'})});
    const market={trending:async q=>({status:'ok',interval:q.interval,observedAt:iso(clock),tokens:source==='ranking_5m'?[current()]:[]}),
      trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:source==='completed'?[current()]:[]}),
      kline:async q=>({...q,status:'ok',candles:candles()}),
      quote:async q=>({...q,price,status:'ok',observedAt:iso(clock)})};
    const options={...modes,dataDir:f.dataDir,session,chain:'bsc',chains:['bsc'],discoveryMode:'gmgn_three_lists_v1',market,now:()=>clock,evidenceLoader:()=>({})};
    let r=createPaperStrategyRuntime(options);
    try{
      await r.runOnce();await r.setEnabled(true);
      for(let n=0;n<6&&r.snapshot().account.trades.length===0;n++){
        await r.fastOnce();await r.refreshQuote();await r.fastOnce();clock+=4000;price=1.03;
      }
      const s=r.snapshot();assert.equal(s.account.trades.length,1,JSON.stringify(s.evaluations.map(x=>x.missing)));
      assert.equal(s.account.trades[0].chain,'bsc');assert.equal(s.execution,false);assert.equal(s.signing,false);assert.equal(s.broadcast,false);
      const trades=JSON.parse(JSON.stringify(s.account.trades)),cash=s.account.cash;
      await r.stop();r=createPaperStrategyRuntime(options);await r.runOnce();
      assert.deepEqual(JSON.parse(JSON.stringify(r.snapshot().account.trades)),trades);assert.equal(r.snapshot().account.cash,cash);
      assert.equal(await fs.readFile(f.originalFile,'utf8'),f.original);
    }finally{await r.stop();}
  });
});

test('repair Alpha follow-through uses the same original 24h catalog clock through ledger commit',()=>{
  const i=alphaInput(),row=evaluatePaperStrategies(i)[0];
  assert.equal(row.decision,'可模拟',JSON.stringify({missing:row.missing,reasons:row.reasons}));
  assert.equal(row.evidence.lossRepair.group,'event_narrative');
  assert.equal(row.evidence.lossRepair.catalystReady,true);
  assert.equal(row.evidence.narrativeThesis.catalyst.phase,'follow_through');
  assert.equal(row.evidence.narrativeThesis.event.sourceAt,iso(NOW-7200000));
  const opened=advancePaperStrategyAccount(estimatedAccount(),{...modes,estimatedFeeMode:true,evaluations:[row],nowMs:NOW});
  assert.equal(opened.trades.length,1);assert.equal(opened.trades[0].atMs,NOW);
  validatePaperStrategyAccount(opened);
  for(const mutate of [x=>x.quoteHistory[0].price=1.04,
    x=>x.token.sellTax=.07,x=>{x.candles=[];x.klineStatus='unavailable';}]) {
    const bad=alphaInput();mutate(bad);const r=evaluatePaperStrategies(bad);
    assert.equal(advancePaperStrategyAccount(estimatedAccount(),{...modes,estimatedFeeMode:true,evaluations:r,nowMs:NOW}).trades.length,0);
  }
  for(const mutate of [x=>x.alphaSignal.observedAt=iso(NOW-30001),x=>x.alphaSignal.offline=true,
    x=>x.alphaSignal.address='0x'+'b'.repeat(40),x=>x.alphaSignal.listingTime=NOW-86400001]) {
    const bad=alphaInput();mutate(bad);const r=evaluatePaperStrategies(bad)[0];
    assert.notEqual(r.evidence.opportunity.id,'alpha_listing','invalid Alpha cannot borrow a valid external route');
    assert.equal(r.evidence.lossRepair.catalystReady,false);
    assert.equal(r.evidence.lossRepair.entryPath,'external_structure');
  }
});

test('three-list mode prevents an unlisted Alpha event from entering research, while preserving the old main ledger',async t=>{
  const f=await fixture(t,'bsc'),session=await createEstimatedPaperSession({dataDir:f.dataDir,id:ID,nowMs:NOW});
  const calls=[],evidence={alphaCatalog:advanceAlphaCatalog(null,[{...alphaInput(0).alphaSignal,chain:'bsc',tokenId:'offline',symbol:'OFFLINE',name:'Offline'}],NOW)};
  const r=createPaperStrategyRuntime({...modes,dataDir:f.dataDir,session,chain:'bsc',chains:['bsc'],discoveryMode:'gmgn_three_lists_v1',now:()=>NOW,
    market:{trending:async q=>({status:'ok',interval:q.interval,observedAt:iso(NOW),tokens:[]}),
      trenches:async()=>({status:'ok',observedAt:iso(NOW),tokens:[]}),
      details:async q=>{calls.push(q);return {status:'unavailable'};},
      quote:async q=>{calls.push(q);return {status:'unavailable'};},kline:async q=>{calls.push(q);return {status:'unavailable'};}},
    evidenceLoader:()=>evidence});
  try{
    await r.runOnce();await r.setEnabled(true);await r.refreshEvents();
    await r.fastOnce();await r.refreshDetails();await r.refreshQuote();
    const s=r.snapshot();assert.equal(s.evaluations.length,0);assert.equal(s.account.trades.length,0);
    assert.equal(s.cadence.eventDispatch.evaluations,0);assert.equal(calls.length,0);
    assert.deepEqual(await fs.readFile(f.originalFile,'utf8'),f.original);
  }finally{await r.stop();}
});

test('runtime completes a normal-priority Alpha research chart outside the external list, then confirms and fills',async t=>{
  const f=await fixture(t),session=await createEstimatedPaperSession({dataDir:f.dataDir,id:ID,nowMs:NOW});
  let clock=NOW;const calls=[],quotes=[];
  const internalStage={...token,marketStage:'internal'};
  const market={trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[internalStage]}),
    trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    quote:async query=>{quotes.push(query);return {...internalStage,price:clock===NOW?1.028:1.03,status:'ok',observedAt:iso(clock)};},
    kline:async query=>{calls.push(query);return {chain:token.chain,address:CA,resolution:'1m',status:'ok',candles:candles()};}};
  const r=createPaperStrategyRuntime({...modes,dataDir:f.dataDir,session,chain:'base',chains:['base'],market,now:()=>clock,
    evidenceLoader:()=>({alphaCatalog:advanceAlphaCatalog(null,[{...alphaInput().alphaSignal,tokenId:'offline',symbol:'OFFLINE',name:'Offline'}],clock)}),
    intervalMs:60000,marketIntervalMs:60000});
  try {
    await r.runOnce();await r.setEnabled(true);await r.start();await r.fastOnce();
    for(let i=0;i<8&&r.snapshot().account.trades.length===0;i++) {
      await r.refreshQuote();await r.fastOnce();
      await new Promise(resolve=>setTimeout(resolve,20));clock+=4000;
    }
    const s=r.snapshot();
    assert.ok(calls.some(c=>c.purpose==='candidate'),JSON.stringify({calls,focus:s.researchPipeline.entryFocus,quote:s.cadence.lastCandidateEvaluation,eval:s.evaluations.map(x=>({d:x.decision,m:x.missing,r:x.reasons}))}));
    assert.ok(quotes.length>=2);assert.equal(s.account.trades.length,1,JSON.stringify(s.cadence.lastCandidateEvaluation));
    assert.equal(s.account.trades[0].address,CA);assert.equal(s.account.trades[0].entryEvidence.lossRepair.group,'event_narrative');
    assert.deepEqual(await fs.readFile(f.originalFile,'utf8'),f.original,'original main book unchanged');
  }finally{await r.stop();}
});

test('funded repair account resumes entries without deleting historical loss and persists enabled state across restart',async t=>{
  const f=await fixture(t),session=await createEstimatedPaperSession({dataDir:f.dataDir,id:ID,nowMs:NOW});
  const file=path.join(f.dataDir,paperSessionLedgerFile(session));
  const saved=JSON.parse(await fs.readFile(file,'utf8'));
  saved.account.cash=1;saved.account.realizedPnl=-99;
  await fs.writeFile(file,JSON.stringify(saved));
  const unavailable=async()=>({status:'unavailable',tokens:[]});
  const options={...modes,dataDir:f.dataDir,session,chain:'base',chains:['base'],market:{trending:unavailable,trenches:unavailable,quote:unavailable},evidenceLoader:()=>({}),now:()=>NOW};
  let r=createPaperStrategyRuntime(options);
  try {
    await r.runOnce();await assert.rejects(r.setEnabled(true),{code:'PAPER_LOSS_GUARD_ACTIVE'});
    await r.resetCash('repair_round_refill');await r.setEnabled(true);await r.runOnce();
    assert.equal(r.snapshot().enabled,true);assert.equal(r.snapshot().entryGuard.allowed,true);
    assert.equal(r.snapshot().account.realizedPnl,-99);assert.equal(r.snapshot().lossGuards.realizedPnlUsd,0);
    await r.stop();r=createPaperStrategyRuntime(options);await r.runOnce();
    assert.equal(r.snapshot().enabled,true);assert.equal(r.snapshot().account.stats.enabled,true);
    const row=evaluatePaperStrategies(input())[0];
    const opened=advancePaperStrategyAccount(r.snapshot().account,{...modes,estimatedFeeMode:true,evaluations:[row],nowMs:NOW});
    assert.equal(opened.trades.length,1);assert.equal(opened.realizedPnl,-99);assert.equal(opened.cash,90);
    assert.equal(validatePaperStrategyAccount(opened),true);
  }finally{await r.stop();}
});

test('session-scoped loss override survives restart without refill and preserves every non-loss entry check',async t=>{
  const f=await fixture(t),session=await createEstimatedPaperSession({dataDir:f.dataDir,id:ID,nowMs:NOW});
  const file=path.join(f.dataDir,paperSessionLedgerFile(session)),saved=JSON.parse(await fs.readFile(file,'utf8'));
  saved.account.cash=50;saved.account.realizedPnl=-50;
  await fs.writeFile(file,JSON.stringify(saved));
  const policyFile=path.join(f.dataDir,'paper-loss-guard-policy.json');
  assert.equal(await loadPaperLossGuardPolicy(f.dataDir,session),undefined,'missing config retains old defaults');
  const policy={schema:'paper_loss_guard_policy_v1',mode:'paper',sessionId:ID,enforced:false,authorizedAt:iso(NOW),reason:'offline user authorization'};
  await fs.writeFile(policyFile,JSON.stringify(policy));
  assert.equal(await loadPaperLossGuardPolicy(f.dataDir,session),false);
  assert.equal(await loadPaperLossGuardPolicy(f.dataDir,f.main),undefined,'never changes original main');
  assert.equal(await loadPaperLossGuardPolicy(f.dataDir,{...session,id:'confirmed-pvp-v2-another'}),undefined);
  const unavailable=async()=>({status:'unavailable',tokens:[]});
  const options={...modes,dataDir:f.dataDir,session,chain:'base',chains:['base'],market:{trending:unavailable,trenches:unavailable,quote:unavailable},evidenceLoader:()=>({}),now:()=>NOW,
    enforceLossGuards:await loadPaperLossGuardPolicy(f.dataDir,session)};
  let r=createPaperStrategyRuntime(options);
  try {
    await r.runOnce();assert.equal(r.snapshot().enabled,false,'policy does not silently resume a manual pause');
    await r.setEnabled(true);await r.runOnce();await r.fastOnce();await r.exitOnce();
    await r.stop();r=createPaperStrategyRuntime(options);await r.runOnce();
    const s=r.snapshot();assert.equal(s.enabled,true);assert.equal(s.entryGuard.allowed,true);
    assert.equal(s.lossGuards.enforced,false);assert.equal(s.lossGuards.lossLimitUsd,null);assert.equal(s.lossGuards.newEntriesStop,false);
    assert.equal(s.lossGuards.realizedPnlUsd,-50);assert.equal(s.account.stats.dailyLossGuard,false);
    assert.equal(s.operatingPolicy.enforceLossGuards,false);assert.equal(s.account.cash,50);assert.equal(s.account.realizedPnl,-50);
    assert.deepEqual(s.account.trades,saved.account.trades);assert.deepEqual(s.account.cashAdjustments,saved.account.cashAdjustments);
    assert.equal(s.execution,false);assert.equal(s.signing,false);assert.equal(s.broadcast,false);
    assert.equal(await fs.readFile(f.originalFile,'utf8'),f.original);
    const row=evaluatePaperStrategies(input())[0];
    const normal={...modes,estimatedFeeMode:true,evaluations:[row],nowMs:NOW};
    assert.equal(advancePaperStrategyAccount(s.account,normal).trades.length,0,'default protection remains on');
    const opened=advancePaperStrategyAccount(s.account,{...normal,enforceLossGuards:false});
    assert.equal(opened.trades.length,1);assert.equal(opened.realizedPnl,-50);assert.equal(opened.trades[0].entryEvidence.accountPolicy.enforceLossGuards,false);
    assert.equal(advancePaperStrategyAccount(s.account,{...normal,enforceLossGuards:false,enabled:false}).trades.length,0);
    const stale={...row,observedAt:iso(NOW-3600000)};
    assert.equal(advancePaperStrategyAccount(s.account,{...normal,enforceLossGuards:false,evaluations:[stale]}).trades.length,0);
    const unsafe=input();unsafe.token.isHoneypot=true;
    assert.equal(advancePaperStrategyAccount(s.account,{...normal,enforceLossGuards:false,evaluations:evaluatePaperStrategies(unsafe)}).trades.length,0);
    const taxed=input();taxed.token.sellTax=.07;
    assert.equal(advancePaperStrategyAccount(s.account,{...normal,enforceLossGuards:false,evaluations:evaluatePaperStrategies(taxed)}).trades.length,0);
    assert.throws(()=>advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{...modes,enforceLossGuards:false,nowMs:NOW}),/estimated paper/);
    assert.throws(()=>createPaperStrategyRuntime({...options,enforceLossGuards:'false'}),/loss guard/);
    assert.equal(paperLossGuard(s.account,NOW).triggered,true,'loss record was not cleared');
    await fs.writeFile(policyFile,JSON.stringify({...policy,enforced:'false'}));
    await assert.rejects(loadPaperLossGuardPolicy(f.dataDir,session),/配置无效/);
  } finally {await r.stop();}
});

test('isolated model buys and exits using charged hypothetical costs, preserving fixed thesis and exact cash arithmetic',()=>{
  const row=evaluatePaperStrategies(input())[0];assert.equal(row.decision,'可模拟',JSON.stringify({reasons:row.reasons,missing:row.missing}));
  assert.equal(row.evidence.lossRepair.fee.status,'model_only');assert.equal(row.evidence.lossRepair.group,'verified_wallet');
  const original=estimatedAccount(),opened=advancePaperStrategyAccount(original,{...modes,estimatedFeeMode:true,evaluations:[row],nowMs:NOW});
  assert.equal(original.cash,100);assert.equal(opened.trades.length,1);const pos=Object.values(opened.positions)[0];
  assert.ok(pos.tradeThesis);assert.equal(pos.costAssumptions.version,ESTIMATED_COST_VERSION);assert.equal(pos.costAssumptions.actualOnchainFee,false);
  assert.equal(pos.costAssumptions.gasUsd,.02);assert.equal(opened.cash,100-pos.entryUsd);validatePaperStrategyAccount(opened);
  const now=NOW+180000,bars=candles().map(b=>({...b,time:b.time+180000}));
  [.97,.95,.93].forEach((close,i)=>Object.assign(bars[27+i],{open:close+.01,high:close+.02,low:close-.01,close,volume:200}));
  const mark={...token,price:.93,status:'ok',observedAt:iso(now),structureChart:{...opportunityChart(bars,'ok',now),chain:token.chain,address:CA}};
  const closed=advancePaperStrategyAccount(opened,{...modes,estimatedFeeMode:true,enabled:false,marks:[mark],nowMs:now});
  assert.equal(closed.trades.length,2);assert.equal(Object.keys(closed.positions).length,0);
  assert.ok(Math.abs(closed.cash-(100+closed.realizedPnl))<1e-9);assert.ok(closed.trades.every(t=>t.costsUsd>0));
  assert.deepEqual(closed.trades[0],opened.trades[0]);validatePaperStrategyAccount(closed);
});
test('model permission cannot write main or bypass evidence, tax and data freshness checks',()=>{
  const row=evaluatePaperStrategies(input())[0],main=createPaperStrategyAccount({nowMs:NOW});
  assert.throws(()=>advancePaperStrategyAccount(main,{...modes,estimatedFeeMode:true,evaluations:[row],nowMs:NOW}),/original main/);
  assert.equal(advancePaperStrategyAccount(main,{...modes,evaluations:[row],nowMs:NOW}).trades.length,0);
  assert.equal(advancePaperStrategyAccount(estimatedAccount(),{...modes,evaluations:[row],nowMs:NOW}).trades.length,0);
  for(const mutate of [i=>i.token.buyTax=.07,i=>i.token.isHoneypot=true,i=>i.priceObservedAt=iso(NOW-180000)]){
    const i=input();mutate(i);const rows=evaluatePaperStrategies(i);assert.equal(advancePaperStrategyAccount(estimatedAccount(),{...modes,estimatedFeeMode:true,evaluations:rows,nowMs:NOW}).trades.length,0,mutate.toString());
  }
  for(const [chain,gas]of Object.entries(ESTIMATED_GAS_USD)){
    const c=costAssumptions(chain,0,0,10,undefined,{gasUsd:999999},NOW,false,true);
    assert.equal(c.gasUsd,gas);assert.equal(c.actualOnchainFee,false);assert.equal(c.gasEstimate,undefined);assert.match(c.label,/非链上实付/);
  }
});
async function fixture(t,chain='base'){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-estimated-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const a=createPaperStrategyAccount({nowMs:NOW});await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify({schema:'yesp_atm_runtime_v1',chain,chains:[chain],enabled:false,account:a}));
  const main=await createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-original-offline',nowMs:NOW});
  const originalFile=path.join(dataDir,paperSessionLedgerFile(main));
  const original=await fs.readFile(originalFile,'utf8'),pointer=await fs.readFile(path.join(dataDir,PAPER_SESSION_FILE),'utf8');
  return{dataDir,main,originalFile,original,pointer};
}
test('estimated session is exclusive and idempotent, survives enable/restart, never writes or selects original main',async t=>{
  const f=await fixture(t),session=await createEstimatedPaperSession({dataDir:f.dataDir,id:ID,nowMs:NOW});
  const unavailable=async()=>({status:'unavailable',tokens:[]});
  const options={...modes,dataDir:f.dataDir,session,chain:'base',chains:['base'],market:{trending:unavailable,trenches:unavailable,quote:unavailable},evidenceLoader:()=>({}),now:()=>NOW,tradeReviewEvery:100};
  let r=createPaperStrategyRuntime(options);
  try{
    await r.runOnce();assert.equal(r.snapshot().enabled,false);assert.equal(r.snapshot().account.cash,100);assert.match(r.snapshot().costModel,/独立估算/);
    await r.setEnabled(true);await r.runOnce();assert.equal(r.snapshot().enabled,true);assert.equal(r.snapshot().reviewComparison,null);
    const publicData=createPublicSnapshot(r.snapshot(),NOW);assert.equal(publicData.session.label,'估算费用独立模拟盘');assert.match(publicData.costModel,/非链上实付/);
    await r.stop();
    const file=path.join(f.dataDir,paperSessionLedgerFile(session)),saved=JSON.parse(await fs.readFile(file,'utf8'));
    saved.account.cash=97;saved.account.realizedPnl=-3;await fs.writeFile(file,JSON.stringify(saved));
    assert.deepEqual(await createEstimatedPaperSession({dataDir:f.dataDir,id:ID}),session);
    assert.deepEqual(await loadEstimatedPaperSession(f.dataDir),session);
    r=createPaperStrategyRuntime(options);await r.runOnce();assert.equal(r.snapshot().enabled,true);assert.equal(r.snapshot().account.cash,97);
    assert.equal(await fs.readFile(f.originalFile,'utf8'),f.original);assert.equal(await fs.readFile(path.join(f.dataDir,PAPER_SESSION_FILE),'utf8'),f.pointer);
    await assert.rejects(createEstimatedPaperSession({dataDir:f.dataDir,id:'confirmed-pvp-v2-different'}),/已有估算盘/);
  }finally{await r.stop();}
});
test('missing/corrupt experiment never falls back to main or recreates virtual capital; live main lock prevents selection',async t=>{
  const f=await fixture(t),lock=f.originalFile+'.lock';await fs.writeFile(lock,'busy');
  await assert.rejects(createEstimatedPaperSession({dataDir:f.dataDir,id:ID}),{code:'EEXIST'});await fs.unlink(lock);
  const s=await createEstimatedPaperSession({dataDir:f.dataDir,id:ID});
  await fs.unlink(path.join(f.dataDir,paperSessionLedgerFile(s)));
  await assert.rejects(createEstimatedPaperSession({dataDir:f.dataDir,id:ID}),{code:'ENOENT'});
  await fs.writeFile(path.join(f.dataDir,ESTIMATED_SESSION_FILE),'{broken');await assert.rejects(loadEstimatedPaperSession(f.dataDir));
  assert.equal(await fs.readFile(f.originalFile,'utf8'),f.original);
});
