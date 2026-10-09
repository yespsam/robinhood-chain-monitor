import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildPaperNewsWire} from '../src/paper-news-wire.js';
import {kolEvent} from './fixtures/paper-narrative-recall.js';
import {createNarrativeResearchIndex} from '../src/paper-narrative-thesis.js';
import {evaluatePaperStrategies,advancePaperStrategyAccount,createPaperStrategyAccount,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {ESTIMATED_COST_VERSION} from '../src/paper-estimated-cost.js';
import {LAUNCH_ENTRY_VERSION,LAUNCH_THESIS_VERSION} from '../src/paper-launch-policy.js';
import {readyForPaperQuote} from '../src/paper-candidate-research.js';
import {createPaperStrategyRuntime} from '../src/paper-strategy-runtime.js';
import {createConfirmedPaperSession,createEstimatedPaperSession,LEGACY_PAPER_FILE} from '../src/paper-account-session.js';
import {createPublicSnapshot} from '../src/public-dashboard-state.js';

const NOW=Date.parse('2026-09-30T06:00:00Z'),iso=v=>new Date(v).toISOString(),CA='0x'+'a'.repeat(40);
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,
  opportunityMode:true,memeExitMode:true,recoveryMode:true,lossRepairMode:true,estimatedFeeMode:true,evidenceGapExitMode:false};
const token={chain:'bsc',address:CA,symbol:'OFFLINE',price:1,marketStage:'internal',creationTimestamp:NOW-5000,
  liquidity:60000,volume:10000,buyTax:0,sellTax:0,isHoneypot:false,isWashTrading:false,
  rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01};
const source=()=>({...kolEvent(`BSC OFFLINE launch ${CA}`,NOW-1500),chain:'bsc'});
function launchInput() {
  const signal=buildPaperNewsWire({events:[source()],nowMs:NOW}).paperSignals[0];
  return {...modes,token:structuredClone(token),marketStatus:'ok',observedAt:iso(NOW),priceObservedAt:iso(NOW),
    nowMs:NOW,compoundingCash:100,requireFastQuote:true,flow:{},candles:[],klineStatus:'unavailable',
    monitorSignal:signal,narrativeResearchIndex:createNarrativeResearchIndex({nowMs:NOW}),
    quoteHistory:[{...token,status:'ok',observedAt:iso(NOW)}]};
}
const evaluate=i=>evaluatePaperStrategies(i)[0];
const account=()=>({...createPaperStrategyAccount({nowMs:NOW}),estimatedCostModel:ESTIMATED_COST_VERSION});
const advance=(row,extra={})=>advancePaperStrategyAccount(account(),{...modes,evaluations:[row],nowMs:NOW,...extra});

test('fresh verified internal narrative needs one post-event quote, not candles, smart wallet count or three-second wait',()=>{
  const i=launchInput(),start=performance.now(),row=evaluate(i),elapsedMs=performance.now()-start;
  assert.equal(row.decision,'可模拟',JSON.stringify({missing:row.missing,reasons:row.reasons}));
  assert.equal(row.evidence.newLaunch.version,LAUNCH_ENTRY_VERSION);
  assert.equal(row.evidence.recoveryCheck.requiresChart,false);
  assert.equal(row.evidence.confirmedPolicy.confirmation.count,1);
  assert.equal(row.evidence.lossRepair.thesis.version,LAUNCH_THESIS_VERSION);
  assert.ok(elapsedMs<1000,`offline local decision ${elapsedMs} ms; this is not an upstream SLA`);
  const a=advance(row),position=Object.values(a.positions)[0];
  assert.equal(a.trades.length,1);assert.equal(a.cash,90);assert.equal(position.tradeThesis,undefined);
  assert.equal(position.launchThesis.version,LAUNCH_THESIS_VERSION);assert.equal(validatePaperStrategyAccount(a),true);
  assert.equal(advancePaperStrategyAccount(a,{...modes,evaluations:[row],nowMs:NOW+1}).trades.length,1);
  assert.equal(a.execution,false);assert.equal(a.signing,false);assert.equal(a.broadcast,false);
});

test('no quote can schedule fast research but cannot become a fill',()=>{
  const i=launchInput();i.quoteHistory=[];i.priceObservedAt=null;
  const row=evaluate(i);assert.notEqual(row.decision,'可模拟');
  assert.equal(readyForPaperQuote(row),true,JSON.stringify({r:row.reasons,m:row.missing,routes:row.evidence.opportunityRoutes}));
  assert.equal(advance(row).trades.length,0);
});

test('external, unknown stage, stale launches, ambiguous original and absent safety never borrow the fast lane',()=>{
  const changes=[i=>i.token.marketStage='external',i=>i.token.marketStage='unknown',i=>i.token.stageConflict=true,
    i=>delete i.token.creationTimestamp,i=>i.token.creationTimestamp=NOW+1,i=>i.token.creationTimestamp=NOW-900001,
    i=>i.monitorSignal.sourceAt=iso(NOW-120001),i=>i.monitorSignal.authenticated=false,
    i=>i.monitorSignal.address='0x'+'b'.repeat(40),i=>i.token.isHoneypot=true,i=>delete i.token.isHoneypot,
    i=>i.token.canMint=true,i=>i.token.buyTax=.060001,i=>delete i.token.sellTax,
    i=>i.token.liquidity=0,i=>i.observedAt=iso(NOW-120001),i=>i.quoteHistory[0].observedAt=iso(NOW-6000),
    i=>i.quoteHistory[0].observedAt=iso(NOW-2000),i=>i.quoteHistory[0].price=2,
    i=>i.quoteHistory.push({...i.quoteHistory[0],price:2})];
  for(const change of changes){const i=launchInput();change(i);const row=evaluate(i);
    assert.notEqual(row.decision,'可模拟',change.toString());assert.equal(advance(row).trades.length,0,change.toString());}
});

test('writer revalidates the launch proof, one fresh quote and frozen event; historic rows cannot be relabelled',()=>{
  const original=evaluate(launchInput());
  const changes=[r=>r.evidence.recoveryEntry.newLaunch.marketStage='external',r=>delete r.evidence.recoveryEntry.newLaunch,
    r=>r.evidence.newLaunch.sourceId='fake',r=>r.evidence.marketStage='external',r=>r.evidence.recoveryEntry.quotes=[],
    r=>r.evidence.confirmedPolicy.confirmation.rows=[],r=>r.evidence.safety.auditComplete=false,
    r=>r.evidence.narrativeThesis.relationship.kind='name_only'];
  for(const change of changes){const r=structuredClone(original);change(r);assert.equal(advance(r).trades.length,0,change.toString());}
  assert.equal(advance(original,{nowMs:NOW+6000}).trades.length,0);
  const a=advance(original);const p=Object.values(a.positions)[0];p.launchThesis.sourceUrl='https://x.com/fake/status/1';
  assert.throws(()=>validatePaperStrategyAccount(a),/launch event thesis/);
});

test('external event with real buying and two fresh quotes still needs an entry-bound closed-chart structure',()=>{
  const i=launchInput();i.token.marketStage='external';
  const event={...kolEvent(`BSC OFFLINE launch ${CA}`,NOW-5000),chain:'bsc'};
  i.monitorSignal=buildPaperNewsWire({events:[event],nowMs:NOW}).paperSignals[0];
  i.quoteHistory=[-4000,0].map(d=>({...token,price:d?.999:1,status:'ok',observedAt:iso(NOW+d)}));
  i.flow={...token,status:'healthy',provider:'gmgn',fresh:true,complete:true,observedAt:iso(NOW),netBuyUsd:600,
    uniqueBuyerCount:2,smartMoneyCount:2,highProfitCount:0,profileCheckedCount:0,fomoCount:0,
    wallets:[1,2].map(n=>({wallet:'0x'+String(n).repeat(40),buyUsd:300,sellUsd:0,netBuyUsd:300,tags:['smart_money'],lastBuyAt:NOW-1000}))};
  const r=evaluate(i);assert.equal(r.evidence.recoveryCheck.ready,true);
  assert.equal(r.evidence.newLaunch,undefined);assert.equal(r.evidence.lossRepair.thesis,null);
  assert.notEqual(r.decision,'可模拟');assert.equal(advance(r).trades.length,0);
  assert.ok(r.reasons.some(s=>s.includes('真实结构失效位')));
});

test('a no-CA original needs an actual project permalink, never only a matching name, and uses one quote',()=>{
  const event=source();event.tweet.text='BSC OFFLINE launch';
  // Use the same canonical URL as the source parser, not a second invented original.
  const direct=launchInput().monitorSignal.sourceUrl;
  const t={...token,twitterUsername:direct};
  const wire=buildPaperNewsWire({events:[event],candidates:[{token:t,marketStatus:'ok',observedAt:iso(NOW)}],nowMs:NOW});
  const signal=wire.paperSignals[0];
  assert.ok(signal,JSON.stringify(wire.twitterEvents));
  const i={...launchInput(),token:t,monitorSignal:signal};
  assert.equal(evaluate(i).decision,'可模拟');assert.equal(advance(evaluate(i)).trades.length,1);
  const unnamed=buildPaperNewsWire({events:[event],candidates:[{token,marketStatus:'ok',observedAt:iso(NOW)}],nowMs:NOW});
  assert.equal(unnamed.paperSignals.length,0,'name match alone is not an authenticated CA relation');
});

test('runtime quotes and fills a new internal event with no chart, persists, deduplicates, and exposes honest latency',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-launch-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'bsc',chains:['bsc'],enabled:false,account:createPaperStrategyAccount({nowMs:NOW})}));
  await createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-launch-original',nowMs:NOW});
  const session=await createEstimatedPaperSession({dataDir,id:'confirmed-pvp-v2-estimated-launch-test',nowMs:NOW});
  let clock=NOW,quotes=0,charts=0;
  const market={trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[token]}),
    trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    quote:async()=>{quotes++;return {...token,status:'ok',observedAt:iso(clock)};},
    kline:async()=>{charts++;return {status:'unavailable',candles:[]};}};
  const options={...modes,dataDir,session,chain:'bsc',chains:['bsc'],market,now:()=>clock,
    evidenceLoader:()=>({events:[source()]}),intervalMs:60000,marketIntervalMs:60000};
  let runtime=createPaperStrategyRuntime(options);
  try {
    await runtime.runOnce();await runtime.setEnabled(true);await runtime.fastOnce();
    assert.equal(runtime.snapshot().cadence.quoteTargets,1,'new launch reaches quotes before any candle data');
    await runtime.start();await runtime.fastOnce();await runtime.refreshQuote();
    for(let i=0;i<100&&!runtime.snapshot().cadence.lastCandidateEvaluation;i++)await new Promise(resolve=>setTimeout(resolve,10));
    const s=runtime.snapshot();
    assert.ok(quotes>0);assert.equal(charts,0);
    assert.equal(s.account.trades.length,1,JSON.stringify(s.cadence.lastCandidateEvaluation));
    assert.equal(s.cadence.lastCandidateEvaluation.entryLane,LAUNCH_ENTRY_VERSION);
    assert.equal(s.cadence.lastCandidateEvaluation.decisionTargetMs,1000);
    assert.equal(s.cadence.lastCandidateEvaluation.decisionTargetMet,true);
    const p=createPublicSnapshot(s,NOW);
    assert.equal(p.newLaunchPolicy.requiresChart,false);
    assert.equal(p.cadence.lastCandidateEvaluation.entryLane,LAUNCH_ENTRY_VERSION);
    const ledger=JSON.parse(await fs.readFile(runtime.stateFile,'utf8'));
    assert.equal(ledger.account.trades.length,1);assert.equal(validatePaperStrategyAccount(ledger.account),true);
    await runtime.stop();runtime=createPaperStrategyRuntime(options);clock+=1000;
    await runtime.runOnce();assert.equal(runtime.snapshot().account.trades.length,1);
    assert.equal(runtime.snapshot().enabled,true);
  } finally {await runtime.stop();}
});

test('off-ranking verified launch goes from discovery through bound details to quotes and a persisted fill; foreign data cannot',async t=>{
  for(const foreign of [true,false]) {
    const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-launch-pipeline-'));
    t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
    await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'bsc',chains:['bsc'],enabled:false,account:createPaperStrategyAccount({nowMs:NOW})}));
    await createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-launch-original',nowMs:NOW});
    const session=await createEstimatedPaperSession({dataDir,id:'confirmed-pvp-v2-estimated-launch-pipeline',nowMs:NOW});
    let clock=NOW,details=0,quotes=0;
    const market={trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
      details:async()=>{details++;return {status:'ok',observedAt:iso(clock),token:{...token,...(foreign?{address:'0x'+'b'.repeat(40)}:{})}};},
      quote:async()=>{quotes++;return {...token,status:'ok',observedAt:iso(clock)};},kline:async()=>({status:'unavailable',candles:[]})};
    const r=createPaperStrategyRuntime({...modes,dataDir,session,chain:'bsc',chains:['bsc'],market,now:()=>clock,
      evidenceLoader:()=>({events:[source()]}),intervalMs:60000,marketIntervalMs:60000});
    try {
      await r.runOnce();await r.setEnabled(true);await r.fastOnce();
      assert.equal(r.snapshot().researchPipeline.entryDiagnostics.detected,1);
      assert.equal(r.snapshot().account.trades.length,0);
      await r.refreshDetails();await r.fastOnce();
      assert.ok(details>0);
      assert.equal(r.snapshot().researchPipeline.entryDiagnostics.quoteScheduled,foreign?0:1);
      await r.refreshQuote();await r.fastOnce();
      assert.equal(quotes,foreign?0:1);
      const s=r.snapshot();assert.equal(s.account.trades.length,foreign?0:1,JSON.stringify(s.cadence.lastCandidateEvaluation));
      clock+=1000;await r.fastOnce();
      assert.equal(r.snapshot().account.trades.length,foreign?0:1,'same event cannot duplicate a fill');
      const ledger=JSON.parse(await fs.readFile(r.stateFile,'utf8'));
      assert.equal(ledger.account.trades.length,foreign?0:1);assert.equal(validatePaperStrategyAccount(ledger.account),true);
      assert.equal(s.execution,false);assert.equal(s.signing,false);assert.equal(s.broadcast,false);
    } finally {await r.stop();}
  }
});
