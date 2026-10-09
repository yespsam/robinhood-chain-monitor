import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluatePaperStrategies, createPaperStrategyAccount, advancePaperStrategyAccount, validatePaperStrategyAccount } from '../src/paper-strategy-engine.js';
import { EVIDENCE_GAP_POLICY, applyEvidenceGapExit, recoveryEntryCheck } from '../src/paper-recovery-policy.js';
import { paperPositionSize, validPaperPositionSize, PAPER_RECOVERY_SIZING_VERSION } from '../src/paper-position-sizing.js';
import { normalizePlatformCall, GMGN_SOCIAL_VERSION } from '../src/gmgn-social-monitor.js';
import { buildPaperNewsWire } from '../src/paper-news-wire.js';
import { createPaperStrategyRuntime } from '../src/paper-strategy-runtime.js';
import { createReviewComparison } from '../src/paper-review-comparison.js';
import { selectQuoteTarget, selectResearchChart } from '../src/paper-research-scheduler.js';
import { createReadonlyMarketClient } from '../src/gmgn-readonly-market.js';
import { renderStrategyDetails } from '../dashboard/strategy-details.js';
import { completedPaperRounds } from '../src/paper-confirmed-policy.js';
import { traderReview } from '../src/paper-trader-reasoning.js';

// Isolated synthetic fixtures, never runtime data or upstream requests.
const NOW=Date.parse('2026-09-26T06:00:00Z'),iso=n=>new Date(n).toISOString(),CA=`0x${'a'.repeat(40)}`,OTHER=`0x${'b'.repeat(40)}`;
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true,memeExitMode:true};
const token=address=>({chain:'bsc',address,symbol:'OFFLINE',price:1,liquidity:60000,volume:10000,marketStage:'unknown',buyTax:0,sellTax:0});
const quote=(at=NOW,address=CA,price=1)=>({...token(address),price,status:'ok',observedAt:iso(at)});
function signal(address=CA) {
  const e=normalizePlatformCall({id:'offline-test',signal_type:13,token_address:address,trigger_at:(NOW-10000)/1000,
    data:{chain:'bsc',address,symbol:'OFFLINE'}},'bsc',NOW);
  return buildPaperNewsWire({gmgn:{version:GMGN_SOCIAL_VERSION,chains:{bsc:{status:'healthy',lastSuccessAt:iso(NOW)}},events:[e]},nowMs:NOW}).paperSignals[0];
}
const flow=()=>({...token(CA),provider:'gmgn',status:'healthy',fresh:true,complete:true,observedAt:iso(NOW),
  netBuyUsd:600,uniqueBuyerCount:2,smartMoneyCount:2,highProfitCount:0,fomoCount:0,
  wallets:[1,2].map(n=>({wallet:`0x${String(n).repeat(40)}`,buyUsd:300,sellUsd:0,netBuyUsd:300,tags:['smart_money'],lastBuyAt:NOW-1000}))});
const input=(address=CA)=>({...modes,token:token(address),nowMs:NOW,marketStatus:'ok',observedAt:iso(NOW),priceObservedAt:iso(NOW),
  compoundingCash:100,fixedEntryUsd:10,requireFastQuote:true,monitorSignal:signal(address),flow:flow(),
  quoteHistory:[quote(NOW-4000,address,.99),quote(NOW,address)]});
const evaluate=i=>evaluatePaperStrategies(i)[0];
const oldAccount=(address=CA)=>advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{
  ...modes,evaluations:[evaluate(input(address))],nowMs:NOW});

test('recovery distinguishes a fresh feed from actual new buying and two independent rising quotes',()=>{
  const good={...input(),recoveryMode:true};
  const row=evaluate(good);assert.equal(row.decision,'可模拟',JSON.stringify(row.missing));
  assert.equal(row.evidence.recoveryCheck.exitObservable,true);
  assert.equal(row.evidence.positionSizing.version,PAPER_RECOVERY_SIZING_VERSION);
  assert.match(row.evidence.entryPlan.summary,/两次触发后走强报价/);
  const changes=[i=>i.flow={},i=>i.flow.netBuyUsd=0,i=>i.flow.netBuyUsd=-500,i=>i.flow.wallets=[],
    i=>i.flow.complete=false,i=>i.flow.address=OTHER,i=>i.flow.wallets.push(i.flow.wallets[0]),
    i=>i.flow.wallets.forEach(w=>w.tags=[]),i=>i.flow.wallets.forEach(w=>w.lastBuyAt=NOW-20000),
    i=>i.flow.wallets.forEach(w=>w.lastBuyAt=NOW+1),i=>i.flow.wallets[1].netBuyUsd=0,
    i=>i.flow.observedAt=iso(NOW-121000),i=>i.quoteHistory=[quote()],
    i=>i.quoteHistory[0].price=1.01,i=>i.quoteHistory[0].observedAt=iso(NOW-1000),
    i=>i.quoteHistory[0].address=OTHER,i=>i.quoteHistory.push(quote())];
  for(const change of changes){const i=structuredClone(good);change(i);const bad=evaluate(i);
    assert.notEqual(bad.decision,'可模拟',change.toString());
    if(bad.evidence.traderDecision)assert.equal(bad.evidence.traderDecision.decision,bad.decision,'decision summary must reflect the final recovery result');
    assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{...modes,recoveryMode:true,evaluations:[bad],nowMs:NOW}).trades.length,0);
  }
  const forged=structuredClone(row);forged.evidence.recoveryEntry.flow.netBuyUsd=0;
  assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{...modes,recoveryMode:true,evaluations:[forged],nowMs:NOW}).trades.length,0);
  assert.equal(recoveryEntryCheck({...row.evidence.recoveryEntry,address:OTHER},row.token,signal(),NOW).ready,false);
  assert.equal(advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{...modes,recoveryMode:true,evaluations:[evaluate(input())],nowMs:NOW}).trades.length,0,'old permissive decision cannot bypass recovery');
});

test('recovery size shrinks with cash, caps at 10 and validates frozen budget fields',()=>{
  for(const [cash,expected]of [[100,10],[1000,10],[60,6],[14.447577,1.44],[4.447577,.44],[0,0]]) {
    const size=paperPositionSize({cash,liquidity:60000,baseEntryUsd:2,recoverySizing:true});
    assert.equal(size.budgetUsd,expected);
    if(expected)assert.equal(validPaperPositionSize(size,2,expected,60000),true);
    assert.equal(validPaperPositionSize({...size,entryFraction:.9},2,expected,60000),false);
  }
  const row=evaluate({...input(),recoveryMode:true,compoundingCash:60});assert.equal(row.entryUsd,6);assert.equal(row.decision,'可模拟');
  const a=advancePaperStrategyAccount(createPaperStrategyAccount({initialCash:60,nowMs:NOW}),{...modes,recoveryMode:true,evaluations:[row],nowMs:NOW});
  assert.equal(a.trades[0].costBasisUsd,6);assert.equal(a.cash,54);assert.equal(validatePaperStrategyAccount(a),true);
  const pricey=evaluate({...input(),recoveryMode:true,compoundingCash:14.447577});
  assert.notEqual(pricey.decision,'可模拟','a smaller budget still has to clear the cost limit');
});

const missing={status:'unavailable',exit:false,reason:'missing',flow:{usable:true,buyerCount:0,sellerCount:0}};
const gapPosition=()=>({...token(CA),openedAt:iso(NOW),evidenceGapActivatedAt:iso(NOW),evidenceGapPolicy:{...EVIDENCE_GAP_POLICY}});
test('disabled gap exits still record the outage but cannot sell solely for a five-minute data gap',()=>{
  const p=gapPosition();let decision;
  for(let i=0;i<=10;i++) {
    const at=NOW+1000+i*60000;
    decision=applyEvidenceGapExit(p,quote(at,CA,.1),missing,at,{allowExit:false});
    p.evidenceGap=decision.evidenceGap;assert.equal(decision.exit,false);
  }
  assert.equal(decision.evidenceGap.observations,11);
  const html=renderStrategyDetails({},null,{...p,memeExitPolicy:{version:'meme_evidence_exit_v2'},exitStatus:{evidenceGapExitEnabled:false}});
  assert.match(html,/不会仅因中断满五分钟自动卖出/);
  assert.doesNotMatch(html,/加已授权的证据中断退出/);
});
test('gap exits need five minutes of distinct fresh observations and never invent a fill',()=>{
  const p=gapPosition();let d;
  for(let n=0;n<=5;n++) {
    const at=NOW+1000+n*60000;d=applyEvidenceGapExit(p,quote(at,CA,.1),missing,at);p.evidenceGap=d.evidenceGap;
    assert.equal(d.exit,n===5);
  }
  assert.equal(d.recoveryExit.version,EVIDENCE_GAP_POLICY.version);assert.equal(d.evidenceGap.observations,6);
  for(const bad of [quote(NOW+300001),{...quote(NOW+301000),price:0},quote(NOW+301000,OTHER),quote(NOW+302000)]) {
    const at=bad.observedAt===iso(NOW+300001)?NOW+320000:NOW+301000;
    assert.equal(applyEvidenceGapExit(p,bad,missing,at).exit,false);
  }
  const same=gapPosition();let first=applyEvidenceGapExit(same,quote(NOW+1000),missing,NOW+1000);same.evidenceGap=first.evidenceGap;
  const repeat=applyEvidenceGapExit(same,quote(NOW+1000),missing,NOW+2000);
  assert.equal(repeat.evidenceGap.observations,1);assert.equal(repeat.exit,false);
  const rebootGap=applyEvidenceGapExit(p,quote(NOW+600000),missing,NOW+600000);
  assert.equal(rebootGap.exit,false);assert.equal(rebootGap.evidenceGap.since,NOW+600000,'unobserved downtime is not backfilled');
});

test('real recovered structure or meaningful address observations cancel the gap, empty feeds do not',()=>{
  for(const healthy of [{...missing,structure:{twoBelow:false}},{...missing,status:'warming'},
    {...missing,flow:{usable:true,buyerCount:2,sellerCount:0}}]) {
    const p=gapPosition();p.evidenceGap={version:EVIDENCE_GAP_POLICY.version,since:NOW+1000,lastObservedAt:NOW+241000,observations:5};
    const d=applyEvidenceGapExit(p,quote(NOW+301000),healthy,NOW+301000);
    assert.equal(d.exit,false);assert.equal(d.evidenceGap,null);
  }
});

test('holding details distinguish evidence outage time from fixed holding time',()=>{
  const p={...gapPosition(),memeExitPolicy:{version:'meme_evidence_exit_v1'},markStatus:'stale',
    evidenceGap:{since:NOW,lastObservedAt:NOW+120000}};
  const html=renderStrategyDetails({},null,p);
  assert.match(html,/不按固定持仓时长卖出/);assert.match(html,/须新鲜真实报价/);
  assert.match(html,/已观测 120 秒/);assert.match(html,/报价过期/);
  assert.doesNotMatch(html,/无固定百分比、倍数或时间触发/);
});

test('authorized old main lots migrate only their exit overlay, preserve buy history, then exit at a current quote',()=>{
  const original=oldAccount(),buy=structuredClone(original.trades[0]),oldEvidence=structuredClone(original.positions[`bsc:${CA}`].entryEvidence);
  let a=advancePaperStrategyAccount(original,{...modes,recoveryMode:true,enabled:false,nowMs:NOW+100});
  assert.equal(a.positions[`bsc:${CA}`].evidenceGapActivatedAt,iso(NOW+100));
  assert.deepEqual(a.positions[`bsc:${CA}`].entryEvidence,oldEvidence);assert.deepEqual(a.trades[0],buy);
  for(let n=0;n<=5;n++){const at=NOW+1000+n*60000;a=advancePaperStrategyAccount(a,{...modes,recoveryMode:true,enabled:false,marks:[quote(at,CA,.1)],nowMs:at});}
  assert.equal(a.trades.length,2);assert.equal(a.trades[1].price,.1);assert.equal(a.trades[1].exitEvidence.exitPolicyVersion,EVIDENCE_GAP_POLICY.version);
  assert.ok(a.trades[1].realizedPnl<0);assert.deepEqual(a.trades[0],buy);assert.equal(Object.keys(a.positions).length,0);
  const review=traderReview(completedPaperRounds(a.trades),NOW+301000);
  assert.equal(review.cohorts[0].exitVersion,EVIDENCE_GAP_POLICY.version);
  assert.equal(review.cohorts[0].entryVersion,buy.entryEvidence.entryPlan.entryPolicyVersion);
  assert.equal(validatePaperStrategyAccount(a),true);assert.equal(a.execution,false);assert.equal(a.signing,false);assert.equal(a.broadcast,false);
  const untouched=advancePaperStrategyAccount(original,{...modes,enabled:false,marks:[quote(NOW+400000,CA,.1)],nowMs:NOW+400000});
  assert.equal(untouched.trades.length,1,'a control without explicit activation keeps the prior exit policy');
});

test('main exits precede older comparison jobs, while fresh mains allow comparison progress',()=>{
  const main={...token(CA),purpose:'exit',holdingTier:'main',requiresStructureChart:true};
  const control={...token(OTHER),purpose:'exit',holdingTier:'comparison',requiresStructureChart:true};
  const attempts=new Map([[`bsc:${CA}`,NOW-1000]]),quotes=new Map();
  assert.equal(selectQuoteTarget([control,main],quotes,attempts,NOW).address,CA);
  quotes.set(`bsc:${CA}`,quote());assert.equal(selectQuoteTarget([control,main],quotes,attempts,NOW).address,OTHER);
  const params={holdings:[control,main],hot:[],broad:[],charts:new Map(),nowMs:NOW,dispatch:0,chains:['bsc']};
  assert.equal(selectResearchChart(params).address,CA);
  params.charts.set(`bsc:${CA}`,{fetchedAt:NOW});assert.equal(selectResearchChart(params).purpose,'comparison');
});

test('comparison quote reads use background priority and cannot occupy reserved urgent slots',async()=>{
  const priorities=[];
  const market=createReadonlyMarketClient({now:()=>NOW,runner:async(args,opts)=>{
    priorities.push(opts.priority);opts.onRequestStart?.(NOW);
    return JSON.stringify({data:{address:args[args.indexOf('--address')+1],price:{price:1}}});
  }});
  await market.quote({chain:'bsc',address:CA,purpose:'exit'});
  await market.quote({chain:'bsc',address:OTHER,purpose:'comparison'});
  assert.deepEqual(priorities,[2,0]);
});

test('paused runtime persists recovery exits and pause across restart, with low-priority throttled controls',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'paper-recovery-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let clock=NOW+100,calls=[];
  const main=oldAccount(),comparison=createReviewComparison(main,NOW);comparison.control=oldAccount(OTHER);
  await fs.writeFile(path.join(dataDir,'yesp-atm-strategy-paper.json'),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'bsc',chains:['bsc'],
    enabled:false,account:main,reviewComparison:comparison}));
  await fs.writeFile(path.join(dataDir,'gmgn-readonly-plan.json'),JSON.stringify({version:1,plan:'plus'}));
  const market={trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    kline:async args=>({...args,status:'unavailable',candles:[]}),quote:async args=>{calls.push(args);return quote(clock,args.address,.1);}};
  const options={...modes,recoveryMode:true,market,dataDir,chain:'bsc',chains:['bsc'],fixedEntryUsd:10,now:()=>clock,evidenceLoader:()=>({}),tradeReviewEvery:100};
  let r=createPaperStrategyRuntime(options);
  try {
    await r.runOnce();assert.equal(r.snapshot().enabled,false);assert.equal(r.snapshot().cadence.quoteExitConcurrency,3);
    assert.equal(r.snapshot().narrativeDesk.version,'narrative_evidence_chain_v1');
    assert.equal(r.snapshot().newsWire.researchDocuments,undefined,'internal full texts are not duplicated in public state');
    clock=NOW+1000;await r.refreshQuote();await r.exitOnce();
    assert.equal(calls[0].address,CA);assert.equal(calls[0].purpose,'exit');assert.equal(calls.find(c=>c.address===OTHER).purpose,'comparison');
    clock+=3000;await r.refreshQuote();await r.exitOnce();assert.equal(calls.filter(c=>c.address===OTHER).length,1);
    for(let n=1;n<=5;n++){clock=NOW+1000+n*60000;await r.refreshQuote();await r.exitOnce();await r.fastOnce();}
    let s=r.snapshot();assert.equal(s.account.trades.length,2);assert.equal(s.account.trades.at(-1).side,'sell');
    assert.equal(s.enabled,false);assert.equal(s.recovery.automaticResume,false);
    assert.equal(Object.keys(s.account.positions).length,0);assert.equal(Object.keys(s.reviewComparison.control).includes('openPositions'),true);
    const saved=JSON.parse(await fs.readFile(r.stateFile,'utf8'));assert.equal(saved.reviewComparison.control.trades.length,1);
    assert.equal(saved.reviewComparison.control.positions[`bsc:${OTHER}`].evidenceGapPolicy,undefined);
    const prior=structuredClone(s.account.trades);await r.stop();clock+=1000;r=createPaperStrategyRuntime(options);await r.runOnce();s=r.snapshot();
    assert.equal(s.enabled,false);assert.deepEqual(s.account.trades,prior);assert.equal(s.positionSizing.maxEntryUsd,10);
    assert.equal(s.narrativeDesk.version,'narrative_evidence_chain_v1');
  }finally{await r.stop();}
});
