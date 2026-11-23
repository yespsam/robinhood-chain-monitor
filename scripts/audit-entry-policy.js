// Offline analysis only. Imports pure policy functions; never starts a client,
// changes a source clock, writes runtime state, or submits an order.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { opportunityChart, structurePattern, canResearchExternal } from '../src/paper-opportunity-policy.js';
import { reviewStructurePattern, structureEconomics } from '../src/paper-opportunity-review.js';
import { paperChaseGate } from '../src/paper-chase-gate.js';
import { readyForPaperQuote, researchReadyForQuote } from '../src/paper-candidate-research.js';

const minute=60000, finite=Number.isFinite, positive=n=>finite(n)&&n>0;
const stamp=v=>typeof v==='number'?(v<1e10?v*1000:v):Date.parse(v||'');
const key=t=>`${t.chain}:${t.chain==='sol'?t.address:t.address.toLowerCase()}`;
const routes=['external_breakout','external_pullback','external_trend'];
const countBy=(rows,fn)=>rows.reduce((o,r)=>(o[fn(r)]=(o[fn(r)]||0)+1,o),{});

// Separate analytical validator makes hypothetical limits explicit. The
// baseline is checked against the production function for every real input.
// It never shifts timestamps or fills missing candles.
export function inspectWindow(candles,status,nowMs,{maxAgeMs=90000,postGapMin=24}={}) {
  const fail=code=>({ready:false,code,rows:[]});
  if(status!=='ok'||!Array.isArray(candles))return fail(status!=='ok'?'source_unavailable':'invalid_candle_list');
  let rows=candles.map(c=>({...c,time:stamp(c.time)})).filter(c=>c.time>=nowMs-61*minute&&c.time+minute<=nowMs).sort((a,b)=>a.time-b.time).slice(-60);
  if(rows.length<13)return fail('insufficient_closed_bars');
  const ageMs=nowMs-rows.at(-1).time-minute;
  if(ageMs>maxAgeMs)return {...fail('stale_closed_bars'),ageMs};
  let lastGap=0;
  for(let i=0;i<rows.length;i++) {
    const r=rows[i];
    if(![r.open,r.high,r.low,r.close].every(positive))return fail('invalid_price');
    if(!finite(r.volume)||r.volume<0)return fail('invalid_volume');
    if(r.high<Math.max(r.open,r.close,r.low)||r.low>Math.min(r.open,r.close))return fail('invalid_ohlc_range');
    if(i&&r.time-rows[i-1].time!==minute) {
      const gap=r.time-rows[i-1].time;
      if(!gap)return fail('duplicate_time');
      if(!(gap>minute&&gap%minute===0))return fail('irregular_interval');
      lastGap=i;
    }
  }
  const tailBars=rows.length-lastGap;
  if(lastGap&&tailBars<postGapMin)return {...fail('insufficient_contiguous_tail'),tailBars,ageMs};
  rows=rows.slice(lastGap);
  return {ready:true,code:'ready',rows,last:rows.at(-1),previous:rows.at(-2),tailBars,ageMs};
}

// All unmodified predicates are identical to the active base policy. Review,
// support and net economics still use the production pure functions.
export function patternAtLimits(id,chart,price,limits={}) {
  const original=structurePattern({id},chart,price,true);
  if(!chart.ready)return original;
  const p={...original},r=chart.rows,last=chart.last,prev=chart.previous;
  let ready;
  if(id==='external_breakout')ready=last.close>p.resistance*1.002
    &&p.volumeMultiple>=(limits.breakoutVolume??1.5)&&price>=p.resistance&&price<=p.resistance*(1+(limits.chaseMaximum??.08));
  else if(id==='external_pullback') {
    const history=r.slice(0,-3),peakIndex=history.reduce((best,row,i)=>row.high>history[best].high?i:best,0);
    ready=peakIndex>=2&&p.rise>=.25&&p.pullback>=(limits.pullbackMinimum??.15)&&p.pullback<=.65
      &&last.low>prev.low&&last.close>prev.high&&last.close>last.open&&p.volumeMultiple>=1.2&&price>=prev.high&&price<=last.close*1.03;
  } else return original;
  ready=ready&&p.support>0&&p.support<price;
  return {...p,ready,reason:ready?null:original.reason||'分析参数下形态未成立'};
}

function currentRecord(e,snapshotAt) {
  const v=e.evidence,p=v.recoveryEntry||{};
  const nowMs=Date.parse(v.opportunity?.evaluatedAt||snapshotAt);
  return {identity:e.token,price:e.token.price,candles:p.candles,status:p.klineStatus,nowMs,
    costs:v.costAssumptions,budget:e.entryUsd,evaluation:e};
}
export function evaluateRecord(record,limits={}) {
  const chart=inspectWindow(record.candles,record.status,record.nowMs,limits);
  const output=routes.map(id=>{
    let pattern=patternAtLimits(id,chart,record.price,limits);
    const basePattern=pattern;
    pattern=reviewStructurePattern({id},chart,record.price,pattern,{evidenceExit:true});
    if(id==='external_trend'&&chart.ready&&limits.trendReviewVolume!==undefined) {
      const separation=pattern.ema8/pattern.ema21-1,slope=pattern.ema8/pattern.priorEma8-1;
      const reviewReady=separation>=Math.max(.002,pattern.atr/record.price*.15)
        &&slope>=Math.max(.0003,pattern.atr/record.price*.03)
        &&pattern.volumeMultiple>=limits.trendReviewVolume&&chart.last.close>chart.last.open
        &&pattern.support>0&&pattern.support<record.price;
      pattern={...pattern,ready:basePattern.ready&&reviewReady,
        reason:basePattern.ready&&reviewReady?null:'分析参数下趋势审核未通过'};
    }
    const economics=chart.ready&&record.costs?structureEconomics(pattern,record.price,record.costs,record.budget):null;
    const thesis=chart.ready&&chart.rows.length>=(limits.thesisMinimum??24)&&positive(pattern.reclaimPrice)&&pattern.reclaimPrice<record.price;
    return {id,patternReady:pattern.ready,thesis,economicsReady:economics?.ready??null,
      reviewedShapeAndEconomics:pattern.ready&&economics?.ready===true,
      referenceGainRate:positive(pattern.targetPrice)?pattern.targetPrice/record.price-1:null,
      pattern,economics};
  });
  return {chartCode:chart.code,windowReady:chart.ready,bars:chart.rows.length,tailBars:chart.tailBars??null,
    shapeReady:output.some(r=>r.patternReady),shapeAndEconomics:output.some(r=>r.reviewedShapeAndEconomics),
    structureResearchReady:output.some(r=>r.reviewedShapeAndEconomics&&r.thesis),routes:output};
}

export function analyzeSnapshot(snapshot) {
  const records=snapshot.evaluations.map(e=>currentRecord(e,snapshot.updatedAt));
  const baseline=records.map(r=>evaluateRecord(r));
  const mismatches=[];
  for(const [i,r] of records.entries()) {
    const live=opportunityChart(r.candles,r.status,r.nowMs,{contiguousTail:true});
    if(live.ready!==baseline[i].windowReady||live.diagnostics.code!==baseline[i].chartCode)mismatches.push({identity:r.identity,kind:'window'});
    if(live.ready)for(const id of routes) {
      const original=reviewStructurePattern({id},live,r.price,structurePattern({id},live,r.price,true),{evidenceExit:true});
      if(original.ready!==baseline[i].routes.find(p=>p.id===id).patternReady)mismatches.push({identity:r.identity,kind:id});
    }
  }
  if(mismatches.length)throw new Error(`Offline baseline mismatch: ${JSON.stringify(mismatches)}`);
  const eligible=r=>{const e=r.evaluation,v=e.evidence;return e.decision!=='不买'&&!v.safety?.blocked?.length&&v.marketFresh===true&&v.marketStage==='external'
    &&canResearchExternal({token:{...e.token,marketStage:v.marketStage},marketStatus:'unavailable'},[e]);};
  let indexes=records.map((_,i)=>i);const sequential=[];
  const step=(name,predicate)=>{indexes=indexes.filter(i=>predicate(records[i],baseline[i]));sequential.push({stage:name,count:indexes.length});};
  step('all_current_unique_candidates',()=>true);
  step('no_hard_safety_block',r=>r.evaluation.decision!=='不买'&&!r.evaluation.evidence.safety?.blocked?.length);
  step('fresh_market',r=>r.evaluation.evidence.marketFresh===true);
  step('external_stage_and_regular_research_admission',eligible);
  step('reentry_allowed',r=>r.evaluation.evidence.lossRepair?.reentry?.ready===true);
  step('required_safety_fields_complete',r=>!r.evaluation.evidence.safety?.missing?.length);
  step('fee_model_available',r=>r.evaluation.evidence.lossRepair?.fee?.ready===true);
  step('fresh_valid_closed_window',(_,b)=>b.windowReady);
  step('at_least_24_real_closed_bars',(_,b)=>b.bars>=24);
  step('any_reviewed_pattern_ready',(_,b)=>b.shapeReady);
  step('same_route_net_economics_ready',(_,b)=>b.shapeAndEconomics);
  step('same_route_entry_thesis_ready',(_,b)=>b.structureResearchReady);
  step('actual_quote_research_ready',r=>readyForPaperQuote(r.evaluation)||researchReadyForQuote(r.evaluation));
  step('actual_paper_eligible',r=>r.evaluation.evidence.paperEligible===true);
  step('actual_primary_evidence_gate',r=>paperChaseGate(r.evaluation.evidence,{chain:r.identity.chain,costRate:r.costs?.estimatedRoundTripCostRate}).mainAllowed);
  const scenarios=[['baseline',{}],['breakout_volume_1_2',{breakoutVolume:1.2}],['breakout_volume_1_0',{breakoutVolume:1}],
    ['pullback_minimum_10pct',{pullbackMinimum:.10}],['chase_maximum_12pct',{chaseMaximum:.12}],
    ['trend_review_volume_0_8',{trendReviewVolume:.8}],
    ['closed_freshness_120s',{maxAgeMs:120000}],['closed_freshness_180s',{maxAgeMs:180000}],
    ['post_gap_tail_13_only',{postGapMin:13}],['post_gap_and_thesis_13',{postGapMin:13,thesisMinimum:13}],
    ['combined_research_relaxation',{breakoutVolume:1.2,pullbackMinimum:.10,chaseMaximum:.12,maxAgeMs:180000,postGapMin:13,thesisMinimum:13}]];
  const sensitivity=scenarios.map(([name,limits])=>{
    const outcomes=records.map(r=>evaluateRecord(r,limits));
    const subset=outcomes.filter((_,i)=>eligible(records[i]));
    return {name,limits,all:{windowReady:outcomes.filter(x=>x.windowReady).length,patternReady:outcomes.filter(x=>x.shapeReady).length,
      shapeAndEconomics:outcomes.filter(x=>x.shapeAndEconomics).length},regularResearch:{candidates:subset.length,
      windowReady:subset.filter(x=>x.windowReady).length,patternReady:subset.filter(x=>x.shapeReady).length,
      shapeAndEconomics:subset.filter(x=>x.shapeAndEconomics).length,structureResearchReady:subset.filter(x=>x.structureResearchReady).length},
      newlyStructuralCandidates:outcomes.flatMap((x,i)=>x.structureResearchReady&&!baseline[i].structureResearchReady&&eligible(records[i])?[records[i].identity]:[])};
  });
  const gateRecords=records.map(r=>({identity:r.identity,externalResearch:eligible(r),
    gate:paperChaseGate(r.evaluation.evidence,{chain:r.identity.chain,costRate:r.costs?.estimatedRoundTripCostRate})}));
  return {snapshotAt:snapshot.updatedAt,evaluations:records.length,baselineParity:{checked:records.length,mismatches:0},
    liveDiagnostics:snapshot.researchPipeline.entryDiagnostics,sequential,sourceWindowCounts:countBy(baseline,x=>x.chartCode),sensitivity,
    evidenceGate:{enabled:snapshot.evidenceTierGate,accountVariant:snapshot.account.variant??null,
      tiers:countBy(gateRecords,r=>r.gate.tier),primaryAllowedIgnoringEarlierChecks:gateRecords.filter(r=>r.gate.mainAllowed).length,
      externalResearchCandidates:gateRecords.filter(r=>r.externalResearch).length,
      externalResearchShadowOnly:gateRecords.filter(r=>r.externalResearch&&r.gate.tier==='shadow_only').length,
      externalResearchPrimaryAllowedForCurrentlySelectedRoute:gateRecords.filter(r=>r.externalResearch&&r.gate.mainAllowed).length,
      externalResearchPrimaryAllowedByHypotheticalRoute:Object.fromEntries(routes.map(id=>[id,records.filter(r=>eligible(r)
        &&paperChaseGate({...r.evaluation.evidence,opportunity:{...r.evaluation.evidence.opportunity,id}},
          {chain:r.identity.chain,costRate:r.costs?.estimatedRoundTripCostRate}).mainAllowed).length])),
      removeEvidenceGateOnlyActualEligible:snapshot.evaluations.filter(e=>e.evidence.paperEligible===true).length},
    freshWindowExamples:records.flatMap((r,i)=>baseline[i].windowReady?[{identity:r.identity,...baseline[i],
      actualReasons:r.evaluation.reasons,actualMissing:r.evaluation.missing,
      costRate:r.costs?.estimatedRoundTripCostRate,gate:gateRecords[i].gate}]:[])};
}

export function analyzeArchivedAudits(files) {
  const seen=new Set(),records=[];let rejected=0;
  for(const file of files)for(const row of JSON.parse(fs.readFileSync(file,'utf8')).results||[]) {
    const raw=row.rawResponse,at=Date.parse(row.receivedAt||'');
    if(!raw||raw.status!=='ok'||!row.identityBound||!row.validation?.sourceWindow?.valid||!finite(at)){rejected++;continue;}
    const id=`${key(row)}:${raw.from}:${raw.to}:${raw.receivedAt}`;if(seen.has(id))continue;seen.add(id);
    const candles=raw.candles.filter(c=>stamp(c.time)>=raw.from*1000&&stamp(c.time)+minute<=raw.to*1000);
    const chart=opportunityChart(candles,'ok',at,{contiguousTail:true});
    const price=chart.ready?chart.last.close:null;
    records.push({file,identity:{chain:row.chain,address:row.address,symbol:row.symbol},candles,status:'ok',nowMs:at,price});
  }
  // Archive has no contemporaneous independently quoted entry price or full
  // safety/fees/narrative context. Test chart shape only, at actual receivedAt,
  // using last closed price explicitly as a proxy, never as a simulated fill.
  const scenarios=[['baseline',{}],['breakout_volume_1_2',{breakoutVolume:1.2}],['breakout_volume_1_0',{breakoutVolume:1}],
    ['pullback_minimum_10pct',{pullbackMinimum:.10}],['chase_maximum_12pct',{chaseMaximum:.12}]];
  for(const record of records) {
    const live=opportunityChart(record.candles,record.status,record.nowMs,{contiguousTail:true}),offline=evaluateRecord(record);
    if(live.ready!==offline.windowReady||live.diagnostics.code!==offline.chartCode)throw new Error('Archive baseline window mismatch');
    if(live.ready)for(const id of routes) {
      const actual=reviewStructurePattern({id},live,record.price,structurePattern({id},live,record.price,true),{evidenceExit:true});
      if(actual.ready!==offline.routes.find(r=>r.id===id).patternReady)throw new Error('Archive baseline pattern mismatch');
    }
  }
  return {sourceFiles:files,uniqueSourceObservations:records.length,excludedFailedOrUnvalidatedResponses:rejected,
    baselineParity:{checked:records.length,mismatches:0},
    uniqueContracts:new Set(records.map(r=>key(r.identity))).size,
    priceBasis:'last closed candle close proxy; no quote/fees/safety/narrative/entry inference',
    sensitivity:scenarios.map(([name,limits])=>{const outcomes=records.map(r=>evaluateRecord(r,limits));return {name,
      windowReady:outcomes.filter(x=>x.windowReady).length,patternReady:outcomes.filter(x=>x.shapeReady).length,
      byRoute:Object.fromEntries(routes.map(id=>[id,outcomes.filter(x=>x.routes.find(r=>r.id===id).patternReady).length])),
      passingObservations:outcomes.flatMap((x,i)=>x.shapeReady?[{identity:records[i].identity,sourceFile:records[i].file,
        observedAt:new Date(records[i].nowMs).toISOString(),priceProxy:records[i].price,
        routes:x.routes.filter(r=>r.patternReady).map(r=>({id:r.id,volumeMultiple:r.pattern.volumeMultiple}))}]:[])};})};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [input,output,...archives]=process.argv.slice(2);
  if(!input||!output)throw new Error('Usage: node scripts/audit-entry-policy.js INPUT_STATE OUTPUT_REPORT [ARCHIVED_AUDIT ...]');
  const out=path.resolve(output),dataDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data');
  if(out===path.resolve(input)||out===dataDir||out.startsWith(dataDir+path.sep))throw new Error('Output must not overwrite source or runtime data');
  const report={version:'offline_entry_policy_audit_v1',input:path.resolve(input),collection:{networkRequests:0,tradeRequests:0,runtimeMutations:0},
    current:analyzeSnapshot(JSON.parse(fs.readFileSync(input,'utf8'))),archive:analyzeArchivedAudits(archives),
    limitations:['Single snapshot sensitivity is not a profit backtest.','New passes are research candidates only; no quotes are invented and no gates are changed.',
      'Each source is evaluated alone, using original candle and observation times; no cross-provider splicing.']};
  fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({report:out,sequential:report.current.sequential,sensitivity:report.current.sensitivity,evidenceGate:report.current.evidenceGate,archive:report.archive}));
}
