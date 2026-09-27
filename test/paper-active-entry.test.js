import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluatePaperStrategies, createPaperStrategyAccount, advancePaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { createExitComparison, activateExitEntrySampling, advanceExitComparison, validateExitComparison, exitComparisonSummary, ACTIVE_ENTRY_VERSION } from '../src/paper-exit-comparison.js';
import { createPaperStrategyRuntime } from '../src/paper-strategy-runtime.js';
import { renderExitComparison } from '../dashboard/exit-comparison.js';

const NOW=Date.parse('2026-09-24T03:00:00Z'), iso=n=>new Date(n).toISOString(), CA=`0x${'a'.repeat(40)}`;
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true};
const token={chain:'base',address:CA,symbol:'OFFLINE_SAMPLE_ONLY',price:1.029,marketStage:'external',liquidity:60000,volume:5000,
  isHoneypot:false,isWashTrading:false,rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,buyTax:0,sellTax:0};
const candles=Array.from({length:30},(_,i)=>{const p=1+i*.001;return {time:NOW-(30-i)*60000,open:p-.0002,high:p+.002,low:p-.002,close:p,volume:100};});
const input=(more={})=>({...modes,nowMs:NOW,token,marketStatus:'ok',observedAt:iso(NOW),priceObservedAt:iso(NOW),requireFastQuote:true,
  compoundingCash:100,fixedEntryUsd:10,candles,klineStatus:'ok',flow:{},
  quoteHistory:[-4000,0].map(d=>({...token,status:'ok',observedAt:iso(NOW+d)})),...more});
const evaluate=more=>evaluatePaperStrategies(input(more));
const pair=()=>activateExitEntrySampling(createExitComparison(createPaperStrategyAccount({nowMs:NOW}),NOW),NOW);

test('basic entry produces recorded 10 U samples while strict main rejects the same weak trend',()=>{
  const strict=evaluate(), basic=evaluate({opportunityReviewMode:false});
  assert.notEqual(strict[0].decision,'可模拟'); assert.equal(basic[0].decision,'可模拟');
  const main=createPaperStrategyAccount({nowMs:NOW}), before=JSON.stringify(main);
  const original=createExitComparison(main,NOW), active=activateExitEntrySampling(original,NOW);
  assert.equal(JSON.stringify(main),before); assert.equal(original.entrySampling,undefined);
  const next=advanceExitComparison(active,{evaluations:strict,samplingEvaluations:basic,marksFor:()=>[],enabled:true,nowMs:NOW});
  for(const key of ['control','dynamic']) {
    assert.equal(next[key].trades.length,1); assert.equal(next[key].cash,90);
    assert.equal(next[key].trades[0].entryEvidence.entrySampling.version,ACTIVE_ENTRY_VERSION);
    assert.notEqual(next[key].trades[0].entryEvidence.entrySampling.mainDecision,'可模拟');
    assert.ok(next[key].trades[0].entryEvidence.entrySampling.mainBlockers.length>0);
    assert.equal(next[key].trades[0].entryEvidence.opportunity.version,'multi_setup_v1');
    assert.equal(next[key].execution,false); assert.equal(next[key].signing,false); assert.equal(next[key].broadcast,false);
  }
  assert.equal(next.control.positions[`base:${CA}`].exitExperiment,undefined);
  assert.equal(next.dynamic.positions[`base:${CA}`].exitExperiment.fixedStop,false);
  assert.equal(advancePaperStrategyAccount(main,{...modes,evaluations:basic,nowMs:NOW}).trades.length,0);
  assert.equal(exitComparisonSummary(next).entrySampling.results.dynamic.entries,1);
  assert.equal(next.samplingScan.observed,1); assert.equal(next.samplingScan.eligible,1);
  assert.equal(validateExitComparison(next),true);
});

test('active experiment never falls back to main signals or overwrites its activation baseline',()=>{
  const p=pair(), before=JSON.stringify(p);
  assert.equal(activateExitEntrySampling(p,NOW+60000),p);
  assert.equal(advanceExitComparison(p,{evaluations:evaluate({opportunityReviewMode:false}),marksFor:()=>[],enabled:true,nowMs:NOW}).dynamic.trades.length,0);
  assert.equal(JSON.stringify(p),before);
  const bad=structuredClone(p);bad.entrySampling.dynamic.tradeCount=1;assert.throws(()=>validateExitComparison(bad));
});

test('fresh real quotes, candle integrity, costs, safety and cash still apply',()=>{
  for(const change of [
    {priceObservedAt:iso(NOW-20000)}, {quoteHistory:[]}, {klineStatus:'unavailable'},
    {candles:candles.filter((_,i)=>i!==25)}, {token:{...token,price:0}},
    {token:{...token,isHoneypot:true}}, {token:{...token,buyTax:.2,sellTax:.2}},
    {compoundingCash:9}, {token:{...token,marketStage:'unknown'}},
  ]) {
    const rows=evaluate({opportunityReviewMode:false,...change});
    assert.notEqual(rows[0].decision,'可模拟',JSON.stringify(change));
    const next=advanceExitComparison(pair(),{samplingEvaluations:rows,marksFor:()=>[],enabled:true,nowMs:NOW});
    assert.equal(next.dynamic.trades.length,0);assert.equal(next.samplingScan.eligible,0);
  }
});

test('sampling is independent of main occupancy and cash; repeated signals cannot duplicate holdings',()=>{
  const basic=evaluate({opportunityReviewMode:false});
  const next=advanceExitComparison(pair(),{samplingEvaluations:basic,marksFor:()=>[],enabled:true,nowMs:NOW});
  const repeated=advanceExitComparison(next,{samplingEvaluations:basic,marksFor:()=>[],enabled:true,nowMs:NOW+1000});
  assert.equal(repeated.dynamic.trades.length,1);
  const stopped=advanceExitComparison(pair(),{samplingEvaluations:basic,marksFor:()=>[],enabled:false,nowMs:NOW});
  assert.equal(stopped.dynamic.trades.length,0);
  assert.match(renderExitComparison(exitComparisonSummary(next)),/积极采样/);
  assert.match(renderExitComparison(exitComparisonSummary(next)),/本轮检查 1 个 CA/);
});

test('runtime quotes basic candidates, fills both experiments with main blocked and persists activation',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-active-entry-')); t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let now=NOW;
  const chartRequests=[];
  const market={trending:async()=>({status:'ok',observedAt:iso(now),tokens:[token]}),trenches:async()=>({status:'ok',observedAt:iso(now),tokens:[]}),
    kline:async args=>{chartRequests.push(args);return {...args,status:'ok',candles};},quote:async args=>({...args,status:'ok',price:token.price,observedAt:iso(now)})};
  const options={...modes,thesisExitExperiment:true,activeEntrySampling:true,fixedEntryUsd:10,tradeReviewEvery:100,dataDir,chain:'base',chains:['base'],market,now:()=>now,evidenceLoader:()=>({})};
  let baseline;
  const runtime=createPaperStrategyRuntime(options);
  try {
    await runtime.runOnce(); await runtime.runOnce(); await runtime.refreshQuote(); now+=4000; await runtime.refreshQuote(); await runtime.runOnce();
    const state=runtime.snapshot();assert.equal(state.account.trades.length,0);
    assert.equal(state.exitComparison.dynamic.entries,1);assert.equal(state.exitComparison.control.entries,1);
    assert.equal(state.tradeCountReview.pendingFills,0,'paired comparison fills never inflate the main 100-fill trigger');
    baseline=state.exitComparison.entrySampling.activatedAt;
    now+=61000;await runtime.runOnce();
    assert.equal(chartRequests.at(-1).purpose,'exit','deduplicated legacy holding must retain the dynamic account chart requirement');
    assert.equal(runtime.snapshot().researchPipeline.lastChartDispatch.lane,'holding');
    await runtime.setEnabled(false);
  } finally {await runtime.stop();}
  const resumed=createPaperStrategyRuntime(options);
  try {
    await resumed.runOnce(); const s=resumed.snapshot();assert.equal(s.exitComparison.entrySampling.activatedAt,baseline);
    assert.equal(s.exitComparison.dynamic.entries,1);assert.equal(s.enabled,false);
  } finally {await resumed.stop();}
});
