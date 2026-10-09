import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {applyLossRepair,entryBoundThesis,validEntryBoundThesis,lossReentryCheck,repairEntryReview,lossRepairReport,ORDER_FEE_CAPABILITY} from '../src/paper-loss-repair.js';
import {evaluatePaperStrategies,createPaperStrategyAccount,advancePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {createPaperStrategyRuntime} from '../src/paper-strategy-runtime.js';
import {assessMemeExit,MEME_EXIT_POLICY} from '../src/paper-meme-exit.js';
import {opportunityChart} from '../src/paper-opportunity-policy.js';
import {ESTIMATED_COST_VERSION} from '../src/paper-estimated-cost.js';

// Offline fixtures; no network, account secrets or runtime data.
const NOW=Date.parse('2026-09-28T00:00:00Z'),iso=t=>new Date(t).toISOString(),CA='0x'+'a'.repeat(40);
const token={chain:'base',address:CA,symbol:'OFFLINE',price:1.03,marketStage:'external',liquidity:60000,volume:5000,
  isHoneypot:false,isWashTrading:false,rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,buyTax:0,sellTax:0};
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true,memeExitMode:true,recoveryMode:true};
const candles=()=>Array.from({length:30},(_,i)=>({time:NOW-(30-i)*60000,open:i===29?1:i<8?.8+i*.025:1,
  high:i===29?1.035:i<8?.81+i*.025:1.01,low:i===29?.999:i<8?.795+i*.025:.995,
  close:i===29?1.03:i<8?.8+i*.025:1,volume:i===29?180:100}));
const input=()=>({...modes,nowMs:NOW,token:{...token},observedAt:iso(NOW),marketStatus:'ok',priceObservedAt:iso(NOW),
  requireFastQuote:true,compoundingCash:100,klineStatus:'ok',candles:candles(),
  quoteHistory:[-4000,0].map(d=>({...token,status:'ok',observedAt:iso(NOW+d),price:d?1.028:1.03}))});
const row=()=>evaluatePaperStrategies(input())[0];

test('repair diagnostics distinguish missing catalyst and structure from unavailable actual fees',()=>{
  const r=row();r.evidence.costAssumptions.version=ESTIMATED_COST_VERSION;
  assert.equal(applyLossRepair(r,null,NOW).evidence.opportunityRoutes[0].repairStatus,'order_fee_unavailable');
  const options={estimatedFees:true};
  r.evidence.opportunity={id:'flow_momentum',basis:'flow'};
  assert.equal(applyLossRepair(r,null,NOW,options).evidence.opportunityRoutes[0].repairStatus,'catalyst_unavailable');
  r.evidence.flowFresh=true;r.evidence.flow={uniqueBuyerCount:2,smartMoneyCount:2,highProfitCount:1};
  r.evidence.flowDiagnostics={complete:true,observedAt:iso(NOW),sourceStatus:'healthy',profileCheckedCount:1};
  r.evidence.recoveryEntry.candles=[];
  const corrected=applyLossRepair(r,null,NOW,options);
  assert.equal(corrected.evidence.opportunityRoutes[0].repairStatus,'entry_thesis_unavailable');
  assert.equal(corrected.decision,'观察');assert.equal(corrected.evidence.lossRepair.fee.ready,true);
});

test('expired or denied original is reported accurately without renewing its clock or permitting entry',()=>{
  const r=row(),url='https://x.com/alice/status/12345',at=iso(NOW-3600001);
  r.evidence.narrativeThesis={...token,observedAt:iso(NOW),relationship:{kind:'direct_ca'},event:{sourceUrl:url,sourceAt:at},
    sources:[{url,at,binding:'direct_ca'}]};
  assert.equal(repairEntryReview(r,null,NOW).ready,false);
  assert.match(repairEntryReview(r,null,NOW).researchReasons.join(' '),/超过一小时/);
  r.evidence.narrativeThesis.invalidation={blockNewNarrativeEntry:true};
  assert.match(repairEntryReview(r,null,NOW).researchReasons.join(' '),/否认或关联失效/);
});

test('main quarantine rejects old receipt-cost rows and forged ready flags at the ledger, controls stay unchanged',()=>{
  const original=row();assert.equal(original.decision,'可模拟');
  const copy=structuredClone(original),fixed=applyLossRepair(original,null,NOW);
  assert.equal(fixed.decision,'观察');assert.equal(fixed.evidence.costAssumptions.accountingEligible,false);
  assert.match(fixed.reasons.join(' '),/订单级/);assert.deepEqual(original,copy);
  assert.equal(evaluatePaperStrategies({...input(),lossRepairMode:true})[0].decision,'观察');
  const account=createPaperStrategyAccount({nowMs:NOW});
  const normal=advancePaperStrategyAccount(account,{...modes,nowMs:NOW,evaluations:[original]});
  assert.equal(normal.trades.length,1);
  for(const candidate of [original,{...fixed,decision:'可模拟',evidence:{...fixed.evidence,paperEligible:true,entryPlan:{...fixed.evidence.entryPlan,eligible:true},lossRepair:{ready:true}}}]) {
    const guarded=advancePaperStrategyAccount(account,{...modes,lossRepairMode:true,nowMs:NOW,evaluations:[candidate]});
    assert.equal(guarded.trades.length,0);assert.equal(guarded.cash,100);
  }
  assert.equal(ORDER_FEE_CAPABILITY.ready,false);
});

test('frozen entry low avoids selling merely because the same pre-entry weak EMA persists; a new break still exits',()=>{
  const r=row();r.token.price=.8;r.evidence.opportunity={id:'flow_momentum',basis:'flow'};
  r.evidence.recoveryEntry.candles=Array.from({length:30},(_,i)=>({time:NOW-(30-i)*60000,open:i<27?1.4:.79,
    close:i<27?1.4:.79,high:i<27?1.41:.81,low:i<27?1.39:.7,volume:100}));
  const thesis=entryBoundThesis(r,NOW);assert.equal(thesis.anchor,.7);
  const p={...r.token,entryPrice:.8,openedAt:iso(NOW),memeExitPolicy:{...MEME_EXIT_POLICY},entryEvidence:{opportunity:{basis:'flow'},flowDiagnostics:{provider:'gmgn'}}};
  assert.equal(validEntryBoundThesis(thesis,p),true);
  const now=NOW+180000,rows=Array.from({length:30},(_,i)=>({time:now-(30-i)*60000,open:1.4,close:1.4,high:1.41,low:1.39,volume:100}));
  [.81,.82,.83].forEach((close,i)=>Object.assign(rows[27+i],{open:close-.01,close,high:close+.01,low:close-.02,volume:50}));
  const mark={...r.token,price:.83,status:'ok',observedAt:iso(now),structureChart:{...opportunityChart(rows,'ok',now),chain:'base',address:CA}};
  assert.equal(assessMemeExit(p,mark,now).exit,true,'legacy EMA decision remains reproducible');
  const revised={...p,tradeThesis:thesis};
  assert.equal(assessMemeExit(revised,mark,now).exit,false,'rising below an already-weak EMA is not a new failure');
  [.69,.68,.67].forEach((close,i)=>Object.assign(rows[27+i],{open:close+.01,close,high:close+.02,low:close-.01,volume:200}));
  const broken={...mark,price:.67,structureChart:{...opportunityChart(rows,'ok',now),chain:'base',address:CA}};
  assert.equal(assessMemeExit(revised,broken,now).exit,true);
  for(const change of [t=>t.address='0x'+'b'.repeat(40),t=>t.createdAt=iso(NOW+1),t=>t.anchor=.9,t=>t.chartClosedAt=NOW+60000]) {
    const bad=structuredClone(thesis);change(bad);assert.equal(validEntryBoundThesis(bad,p),false);
    assert.equal(assessMemeExit({...p,tradeThesis:bad},mark,now).exit,false,'invalid thesis never falls back to an unrelated EMA');
  }
});

const wallet=(n,at=NOW-1000)=>({wallet:'0x'+String(n).repeat(40),buyUsd:300,sellUsd:0,netBuyUsd:300,tags:['smart_money'],lastBuyAt:at});
function priorLoss(){return {trades:[{id:'old-buy',chain:'base',address:CA,side:'buy',atMs:NOW-600000,quantity:10,
  entryEvidence:{flowDiagnostics:{provider:'gmgn'},memeExitContext:{cohortKnown:true,smartBuyers:[wallet(1).wallet,wallet(2).wallet]}}},
  {id:'old-sell',chain:'base',address:CA,side:'sell',atMs:NOW-300000,quantity:10,realizedPnl:-2,
    exitEvidence:{thesisDecision:{structure:{referenceLevel:2}}}}]};}
function flowRow(numbers=[1,2]) {const r=row();r.evidence.recoveryEntry.flow={...token,provider:'gmgn',status:'healthy',fresh:true,complete:true,
  observedAt:iso(NOW),netBuyUsd:600,wallets:numbers.map(n=>wallet(n))};return r;}
test('new timestamps/same cohort cannot re-buy a loser; two distinct new post-exit buyers can form research proof',()=>{
  const account=priorLoss();assert.equal(lossReentryCheck(flowRow(),account,NOW).ready,false);
  assert.equal(lossReentryCheck(flowRow([3,4]),account,NOW).ready,true);
  assert.equal(lossReentryCheck(flowRow([3,3]),account,NOW).ready,false);
  const old=flowRow([3,4]);old.evidence.recoveryEntry.flow.wallets.forEach(w=>w.lastBuyAt=NOW-400000);
  assert.equal(lossReentryCheck(old,account,NOW).ready,false);
  const stale=flowRow([3,4]);stale.evidence.recoveryEntry.flow.observedAt=iso(NOW-121000);
  assert.equal(lossReentryCheck(stale,account,NOW).ready,false);
  const wrong=flowRow([3,4]);wrong.evidence.recoveryEntry.flow.address='0x'+'b'.repeat(40);
  assert.equal(lossReentryCheck(wrong,account,NOW).ready,false);
  const malformed=flowRow([3,4]);malformed.evidence.recoveryEntry.flow.wallets[0].buyUsd=0;
  assert.equal(lossReentryCheck(malformed,account,NOW).ready,false);
  const badTags=flowRow([3,4]);badTags.evidence.recoveryEntry.flow.wallets[0].tags='smart_money';
  assert.equal(lossReentryCheck(badTags,account,NOW).ready,false);
  const provider=flowRow([3,4]);provider.evidence.recoveryEntry.flow.provider='binance_smartmoney';
  assert.equal(lossReentryCheck(provider,account,NOW).ready,false,'switching feeds is not proof of a new cohort');
  const noPrior=priorLoss();noPrior.trades[0].entryEvidence.memeExitContext.smartBuyers=[];
  assert.equal(lossReentryCheck(flowRow([3,4]),noPrior,NOW).ready,false,'unknown old cohort does not prove a changed cohort');
  const truncated=priorLoss();truncated.trades[0].entryEvidence.memeExitContext.cohortTruncated=true;
  assert.equal(lossReentryCheck(flowRow([3,4]),truncated,NOW).ready,false,'unseen tail of old cohort cannot prove new buyers');
  const casing=flowRow([3,4]),mixed=priorLoss();casing.evidence.recoveryEntry.flow.wallets[0].wallet='0x'+'A'.repeat(40);
  casing.evidence.recoveryEntry.flow.wallets[1].wallet='0x'+'B'.repeat(40);
  mixed.trades[0].entryEvidence.memeExitContext.smartBuyers=['0x'+'a'.repeat(40),'0x'+'b'.repeat(40)];
  assert.equal(lossReentryCheck(casing,mixed,NOW).ready,false,'checksum casing does not change wallet identity');
  const repaired=flowRow();account.trades[1].exitEvidence.thesisDecision.structure.referenceLevel=.9;
  assert.equal(lossReentryCheck(repaired,account,NOW).ready,true,'two full new bars reclaim the previous failure');
});

test('same tweet under a new host, tracking parameters or timestamp does not authorize loss reentry',()=>{
  const r=row(),account=priorLoss(),source='https://x.com/alice/status/12345?s=20';
  account.trades[0].entryEvidence.narrativeThesis={event:{sourceUrl:source}};
  r.evidence.narrativeThesis={...token,observedAt:iso(NOW),relationship:{kind:'direct_ca'},event:{sourceUrl:source,sourceAt:iso(NOW-1000)},
    sources:[{url:source,at:iso(NOW-1000),binding:'direct_ca'}]};
  for(const url of [source,'https://twitter.com/alice/status/12345','https://x.com/alice/status/12345?utm_source=fresh']){
    r.evidence.narrativeThesis.event.sourceUrl=url;r.evidence.narrativeThesis.sources[0].url=url;
    assert.equal(lossReentryCheck(r,account,NOW).ready,false);
  }
  r.evidence.narrativeThesis.event.sourceUrl='https://x.com/alice/status/67890';
  r.evidence.narrativeThesis.sources[0].url=r.evidence.narrativeThesis.event.sourceUrl;
  assert.equal(lossReentryCheck(r,account,NOW).ready,true);
});

test('research groups never call name-only matches narrative or unprofiled labels verified profit',()=>{
  const r=row();assert.equal(repairEntryReview(r,null,NOW).group,'price_only');
  r.evidence.opportunity.basis='flow';assert.equal(repairEntryReview(r,null,NOW).group,'tagged_or_unknown_wallet');
  r.evidence.flowFresh=true;r.evidence.flow={uniqueBuyerCount:2,smartMoneyCount:2,highProfitCount:1};
  r.evidence.flowDiagnostics={complete:true,observedAt:iso(NOW),sourceStatus:'healthy',profileCheckedCount:1};
  assert.equal(repairEntryReview(r,null,NOW).group,'verified_wallet');
  r.evidence.flowDiagnostics.profileCheckedCount=0;assert.notEqual(repairEntryReview(r,null,NOW).group,'verified_wallet');
  r.evidence.narrativeThesis={...token,observedAt:iso(NOW),relationship:{kind:'name_only'},event:{sourceUrl:'https://example.com/offline',sourceAt:iso(NOW-1000)},
    sources:[{url:'https://example.com/offline',at:iso(NOW-1000),binding:'name_only'}]};
  assert.notEqual(repairEntryReview(r,null,NOW).group,'event_narrative');
  r.evidence.narrativeThesis.relationship.kind='direct_ca';r.evidence.narrativeThesis.sources[0].binding='direct_ca';
  assert.equal(repairEntryReview(r,null,NOW).group,'event_narrative');
  r.evidence.narrativeThesis.event.sourceAt=iso(NOW+1);assert.notEqual(repairEntryReview(r,null,NOW).group,'event_narrative');
});

test('anomaly IDs are stable, immediate, local and non-mutating without waiting for the next 100 fills',()=>{
  const a=priorLoss(),t=a.trades[1];t.grossUsd=1;t.netUsd=-9;t.exitEvidence.gasUsd=10;
  const before=structuredClone(a),one=lossRepairReport(a,[],NOW),two=lossRepairReport(a,[],NOW+1000);
  assert.deepEqual(one.alerts,two.alerts);assert.equal(one.alerts.length,2);assert.deepEqual(a,before);
  assert.equal(one.automaticParameterChanges,false);
});

test('repair mode still sells a legacy lot on real fresh evidence without changing its buy or exit policy',()=>{
  const before=advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{...modes,nowMs:NOW,evaluations:[row()]});
  const buy=structuredClone(before.trades[0]),now=NOW+180000;
  const bars=candles().map(b=>({...b,time:b.time+180000}));
  [.97,.95,.93].forEach((close,i)=>Object.assign(bars[27+i],{open:close+.01,high:close+.02,low:close-.01,close,volume:200}));
  const mark={...token,price:.93,status:'ok',observedAt:iso(now),structureChart:{...opportunityChart(bars,'ok',now),chain:token.chain,address:CA}};
  const after=advancePaperStrategyAccount(before,{...modes,lossRepairMode:true,enabled:false,nowMs:now,marks:[mark]});
  assert.equal(after.trades.length,2);assert.deepEqual(after.trades[0],buy);assert.equal(after.trades[1].side,'sell');
  assert.equal(Object.keys(after.positions).length,0);assert.equal(after.execution,false);
});

test('runtime keeps discovery and old exits alive while restart and manual enable cannot reopen unsupported orders',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-loss-repair-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let scans=0;const market={trending:async()=>{scans++;return {status:'ok',observedAt:iso(NOW),tokens:[token]};},
    trenches:async()=>({status:'ok',observedAt:iso(NOW),tokens:[]}),kline:async()=>({status:'ok',candles:candles()}),
    quote:async()=>({...token,status:'ok',observedAt:iso(NOW)})};
  const options={...modes,lossRepairMode:true,dataDir,chain:'base',chains:['base'],market,now:()=>NOW,evidenceLoader:()=>({})};
  const r=createPaperStrategyRuntime(options);
  try {
    await r.runOnce();assert.equal(r.snapshot().enabled,false);assert.ok(scans>0);
    assert.equal(r.snapshot().lossRepair.feeCapability.ready,false);assert.equal(r.snapshot().account.trades.length,0);
    await assert.rejects(r.setEnabled(true),e=>e.code==='PAPER_ORDER_FEES_UNAVAILABLE');
    await r.exitOnce();assert.equal(r.snapshot().exitMonitor.entriesEnabled,false);
  }finally{await r.stop();}
  const reopened=createPaperStrategyRuntime(options);
  try{await reopened.runOnce();assert.equal(reopened.snapshot().enabled,false);assert.equal(reopened.snapshot().account.cash,100);}finally{await reopened.stop();}
});
