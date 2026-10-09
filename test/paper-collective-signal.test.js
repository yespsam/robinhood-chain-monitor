import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {buildCollectiveWire,validCollectiveSignal,COLLECTIVE_SIGNAL_VERSION,COLLECTIVE_THESIS_VERSION,PREQUALIFIED_WALLET_VERSION} from '../src/paper-collective-signal.js';
import {GMGN_THREE_LISTS} from '../src/paper-discovery-scope.js';
import {evaluatePaperStrategies,advancePaperStrategyAccount,createPaperStrategyAccount,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {createPaperStrategyRuntime} from '../src/paper-strategy-runtime.js';
import {buildPaperFlowEvidence} from '../src/paper-strategy-evidence.js';
import {createConfirmedPaperSession,createEstimatedPaperSession,LEGACY_PAPER_FILE} from '../src/paper-account-session.js';
import {ESTIMATED_COST_VERSION} from '../src/paper-estimated-cost.js';
import {paperEventTriggers} from '../src/paper-event-triggers.js';
import {researchReadyForQuote} from '../src/paper-candidate-research.js';
import {assessMemeExit,memeEntryContext} from '../src/paper-meme-exit.js';
import {INTERNAL_BURST_VERSION} from '../src/paper-collective-signal.js';
import {depthFixture} from './helpers/internal-depth-fixture.js';
import {PAPER_INTERNAL_DEPTH_SIZING_VERSION} from '../src/paper-position-sizing.js';

const NOW=Date.parse('2026-10-04T06:00:00Z'),iso=n=>new Date(n).toISOString(),CA='0x'+'a'.repeat(40);
const address=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0');
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,
  opportunityMode:true,memeExitMode:true,recoveryMode:true,lossRepairMode:true,estimatedFeeMode:true,evidenceGapExitMode:false};
const token={chain:'bsc',address:CA,symbol:'OFFLINE',price:1,marketStage:'internal',creationTimestamp:NOW-5000,
  liquidity:60000,volume:10000,buyTax:0,sellTax:0,isHoneypot:false,isWashTrading:false,
  rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01};
function state() {
  const profiles={};
  for(let i=1;i<=3;i++)profiles[`bsc:${address(i)}`]=Object.fromEntries(['7d','30d'].map(period=>[period,{
    chain:'bsc',wallet:address(i),period,checkedAt:iso(NOW-5000),realizedProfitUsd:20000,realizedRoi:.1,winRate:.7,
    tokenCount:150,buyCount:200,sellCount:150,tags:['smart_money'],createdAt:Math.floor(NOW/1000)-90*86400,
    lastTradeAt:Math.floor(NOW/1000)-10,createdTokenCount:0}]));
  const feedCoverage=Object.fromEntries(['smartmoney','kol'].map(k=>[k,{valid:true,startAt:NOW-360000,endAt:NOW,observedAt:NOW,keys:[]}]));
  return {chains:{bsc:{status:'healthy',feedCoverage}},profiles,trades:{bsc:[1,2,3].map(n=>({chain:'bsc',tokenAddress:CA,wallet:address(n),
    side:'buy',amountUsd:200,at:NOW-(4-n)*1000,hash:hash(n),tags:['smart_money']}))}};
}
function input() {
  const s=state();return {...modes,token:structuredClone(token),marketStatus:'ok',observedAt:iso(NOW),priceObservedAt:iso(NOW),
    nowMs:NOW,compoundingCash:100,requireFastQuote:true,candles:[],klineStatus:'unavailable',
    flow:buildPaperFlowEvidence({state:s,chain:'bsc',address:CA,nowMs:NOW}),
    collectiveSignal:buildCollectiveWire({state:s,nowMs:NOW}).signals[0],quoteHistory:[{...token,status:'ok',observedAt:iso(NOW)}]};
}
const evaluate=i=>evaluatePaperStrategies(i)[0];
const account=()=>({...createPaperStrategyAccount({nowMs:NOW}),estimatedCostModel:ESTIMATED_COST_VERSION});
const advance=(row,extra={})=>advancePaperStrategyAccount(account(),{...modes,evaluations:[row],nowMs:NOW,...extra});

function singleState() {const s=state();s.trades.bsc=s.trades.bsc.slice(0,1);return s;}
function singleInput() {
  const s=singleState();return {...input(),flow:buildPaperFlowEvidence({state:s,chain:'bsc',address:CA,nowMs:NOW}),
    collectiveSignal:buildCollectiveWire({state:s,nowMs:NOW,allowPrequalified:true}).signals[0]};
}

function burstState(){const s=state();s.profiles={};s.trades.bsc=s.trades.bsc.map(t=>({...t,amountUsd:400,tags:[]}));
  s.trades.bsc.push(...[1,2].map(n=>({...s.trades.bsc[n-1],hash:hash(80+n),at:NOW-(60+n)*1000,amountUsd:100})));return s;}
function burstInput(){const s=burstState();return {...input(),flow:buildPaperFlowEvidence({state:s,chain:'bsc',address:CA,nowMs:NOW}),
  collectiveSignal:buildCollectiveWire({state:s,nowMs:NOW,allowBurst:true}).signals[0]};}

test('inner burst is independent of profit profiles and charts; true adjacent acceleration and diverse actual buys are required',()=>{
  const s=burstState(),signal=buildCollectiveWire({state:s,nowMs:NOW,allowBurst:true}).signals[0];
  assert.equal(signal.version,INTERNAL_BURST_VERSION);assert.equal(signal.acceleration,12);assert.equal(signal.volumeUsd,1200);
  assert.equal(buildCollectiveWire({state:s,nowMs:NOW}).signals.length,0,'existing route unchanged');
  const row=evaluate(burstInput()),a=advance(row);assert.equal(row.decision,'可模拟',JSON.stringify({m:row.missing,r:row.reasons}));
  assert.equal(row.evidence.recoveryCheck.requiresChart,false);assert.equal(a.trades.length,1);assert.ok(validatePaperStrategyAccount(a));
  assert.equal(row.evidence.opportunity.id,'internal_burst');assert.equal(Object.values(a.positions)[0].collectiveThesis.kind,'公共逐笔子集加速放量与分散净买');
  for(const patch of [{marketStage:'external'},{marketStage:'unknown'},{isHoneypot:true},{sellTax:.07}]) {
    const i=burstInput();Object.assign(i.token,patch);assert.equal(advance(evaluate(i)).trades.length,0,JSON.stringify(patch));
  }
  s.trades.bsc.push(structuredClone(s.trades.bsc[0]));
  assert.equal(buildCollectiveWire({state:s,nowMs:NOW,allowBurst:true}).signals[0].id,signal.id);
  assert.equal(buildCollectiveWire({state:s,nowMs:NOW,allowBurst:true,account:a}).signals.length,0);
  for(const mutate of [x=>x.trades.bsc=x.trades.bsc.slice(0,3),x=>x.trades.bsc[3].amountUsd=10000,
    x=>x.trades.bsc[0].amountUsd=5000,x=>x.trades.bsc[1].hash=x.trades.bsc[0].hash,
    x=>x.trades.bsc[0].side='transfer',x=>x.chains.bsc.feedCoverage.kol.valid=false,
    x=>x.trades.bsc.push({...x.trades.bsc[0],hash:hash(90),side:'sell',at:NOW,amountUsd:1500})]) {
    const x=burstState();mutate(x);assert.equal(buildCollectiveWire({state:x,nowMs:NOW,allowBurst:true}).signals.length,0,mutate.toString());
  }
  const forged=structuredClone(signal);forged.acceleration=1000;assert.equal(validCollectiveSignal(forged,token,NOW),false);
  assert.equal(buildCollectiveWire({state:s,nowMs:NOW+30001,allowBurst:true}).signals.length,0);
});

test('inner burst below 20k uses authentic curve proof; budget/quote/stage/tax gates and full model charges remain',()=>{
  const i=burstInput();i.token.liquidity=10000;i.token.buyTax=.01;i.token.sellTax=.01;
  let row=evaluate(i);assert.equal(advance(row).trades.length,0);assert.ok(row.missing.includes('等待真实订单曲线深度'));
  assert.ok(researchReadyForQuote(row),'missing depth must not deadlock its required price research');
  i.internalDepth=depthFixture(i.token,row.entryUsd,row.evidence.costAssumptions.notionalUsd,NOW);
  row=evaluate(i);assert.equal(row.decision,'可模拟',JSON.stringify({m:row.missing,r:row.reasons}));
  assert.equal(row.evidence.costGate.version,'internal_depth_cost_v1');assert.ok(row.evidence.costAssumptions.estimatedRoundTripCostRate>.05);
  const a=advance(row);assert.equal(a.trades.length,1);assert.ok(validatePaperStrategyAccount(JSON.parse(JSON.stringify(a))));
  assert.ok(a.trades[0].costsUsd>0);assert.equal(a.execution,false);assert.equal(a.broadcast,false);
  for(const change of [r=>r.evidence.internalDepth.budgetUsd=100,r=>r.evidence.internalDepth.raw.sell='0x',
    r=>r.evidence.collectiveSignal.buyers=[],r=>r.evidence.marketStage='external',r=>r.evidence.safety.auditComplete=false]) {
    const x=structuredClone(row);change(x);assert.equal(advance(x).trades.length,0,change.toString());
  }
  const changed={...createPaperStrategyAccount({initialCash:90,nowMs:NOW}),estimatedCostModel:ESTIMATED_COST_VERSION};
  assert.equal(advancePaperStrategyAccount(changed,{...modes,evaluations:[row],nowMs:NOW}).trades.length,0,'smaller serialized ticket requires own depth quote');
  const p=Object.values(a.positions)[0];p.entryEvidence.internalDepth.raw.buy='0x';assert.throws(()=>validatePaperStrategyAccount(a),/depth evidence/);
});

for(const liquidity of [null,.0025,50,999])test(`internal provider liquidity ${liquidity}: proposal researches full order but cannot authorize a fill`,()=>{
  const i=burstInput();i.token.liquidity=liquidity;
  let row=evaluate(i);
  assert.equal(row.entryUsd,10);assert.equal(row.evidence.positionSizing.version,PAPER_INTERNAL_DEPTH_SIZING_VERSION);
  assert.equal(row.evidence.liquidity,liquidity,'do not manufacture reserves or silently convert units');
  assert.equal(row.decision,'观察');assert.ok(row.missing.includes('等待真实订单曲线深度'));
  assert.equal(advance(row).trades.length,0);assert.ok(researchReadyForQuote(row));
  i.internalDepth=depthFixture(i.token,10,row.evidence.costAssumptions.notionalUsd,NOW);
  row=evaluate(i);assert.equal(row.decision,'可模拟',JSON.stringify({m:row.missing,r:row.reasons}));
  const a=advance(row);assert.equal(a.trades.length,1);assert.ok(validatePaperStrategyAccount(JSON.parse(JSON.stringify(a))));
  assert.equal(a.execution,false);assert.equal(a.signing,false);assert.equal(a.broadcast,false);
  assert.equal(advancePaperStrategyAccount(a,{...modes,evaluations:[row],nowMs:NOW}).trades.length,1);
  for(const mutate of [r=>r.evidence.internalDepth=depthFixture(i.token,10,1,NOW),
    r=>r.evidence.internalDepth.address=address(99),r=>r.evidence.internalDepth.budgetUsd=9,
    r=>r.evidence.internalDepth.observedAt=iso(NOW-16000),r=>r.evidence.marketStage='external',
    r=>r.evidence.safety.auditComplete=false,r=>r.evidence.liquidity=0,
    r=>r.evidence.internalDepth=null,r=>r.evidence.collectiveSignal.sourceAt=iso(NOW-31000)]) {
    const x=structuredClone(row);mutate(x);assert.equal(advance(x).trades.length,0,mutate.toString());
  }
  const changed={...createPaperStrategyAccount({initialCash:90,nowMs:NOW}),estimatedCostModel:ESTIMATED_COST_VERSION};
  assert.equal(advancePaperStrategyAccount(changed,{...modes,evaluations:[row],nowMs:NOW}).trades.length,0);
  for(const mutate of [p=>p.entryEvidence.internalDepth=depthFixture(i.token,10,1,NOW),
    p=>p.entryEvidence.internalDepth=null,p=>p.entryEvidence.marketStage='external',
    p=>p.costAssumptions.feeRate=0,p=>p.costAssumptions.slippageRate=0,p=>p.costAssumptions.gasUsd=0,
    p=>delete p.costAssumptions.notionalUsd,p=>p.entryEvidence.costAssumptions.notionalUsd=1,
    p=>p.entryEvidence.safety.missing=['可卖出检测'],p=>p.initialQuantity=1,
    p=>{p.entryEvidence.costGate.version='fixed_cost_cap_v1';delete p.entryEvidence.internalDepth;}]) {
    const x=structuredClone(a);mutate(Object.values(x.positions)[0]);assert.throws(()=>validatePaperStrategyAccount(x),undefined,mutate.toString());
  }
});

test('curve budget does not rescue zero liquidity, invalid safety/signal/stage or other modes',()=>{
  for(const mutate of [i=>i.token.liquidity=0,i=>i.token.liquidity=-1,i=>i.token.marketStage='external',
    i=>i.token.marketStage='unknown',i=>i.token.stageConflict=true,i=>i.token.isHoneypot=true,
    i=>i.token.sellTax=.07,i=>i.token.buyTax=null,i=>i.token.isWashTrading=null,
    i=>i.collectiveSignal=null,i=>i.collectiveSignal.sourceAt=iso(NOW-31000),
    i=>i.compoundingCash=9,i=>i.estimatedFeeMode=false]) {
    const i=burstInput();i.token.liquidity=null;mutate(i);
    i.internalDepth=depthFixture(i.token,10,9.764705882352942,NOW);
    assert.equal(advance(evaluate(i)).trades.length,0,mutate.toString());
  }
});

test('one prequalified buyer is a separate internal-only route; frozen proof survives restart without changing collective policy',()=>{
  assert.equal(buildCollectiveWire({state:singleState(),nowMs:NOW}).signals.length,0);
  const i=singleInput(),row=evaluate(i);
  assert.equal(i.collectiveSignal.version,PREQUALIFIED_WALLET_VERSION);
  assert.equal(row.decision,'可模拟',JSON.stringify({missing:row.missing,reasons:row.reasons}));
  assert.equal(row.evidence.recoveryCheck.requiresChart,false);
  assert.equal(row.evidence.lossRepair.group,'prequalified_wallet');
  const a=advance(row);assert.equal(a.trades.length,1);assert.ok(validatePaperStrategyAccount(JSON.parse(JSON.stringify(a))));
  assert.equal(a.execution,false);assert.equal(a.signing,false);assert.equal(a.broadcast,false);
  assert.equal(buildCollectiveWire({state:singleState(),nowMs:NOW,account:a,allowPrequalified:true}).signals.length,0);
  for(const patch of [{marketStage:'external'},{marketStage:'unknown'},{stageConflict:true},{isHoneypot:true},{sellTax:.07}]) {
    const x=singleInput();Object.assign(x.token,patch);assert.equal(advance(evaluate(x)).trades.length,0,JSON.stringify(patch));
  }
});

test('prequalification cannot be learned after this buy, labels/transfers/net sells cannot grant a fast pass',()=>{
  const change=[s=>s.profiles={},s=>s.profiles[`bsc:${address(1)}`]['7d'].checkedAt=iso(NOW-1000),
    s=>s.profiles[`bsc:${address(1)}`]['30d'].lastTradeAt=NOW/1000,
    s=>s.profiles[`bsc:${address(1)}`]['7d'].realizedProfitUsd=-1,
    s=>s.trades.bsc[0].side='transfer',s=>s.trades.bsc[0].amountUsd=99,
    s=>s.trades.bsc.push({...s.trades.bsc[0],side:'sell',hash:hash(50),at:NOW,amountUsd:250}),
    s=>s.trades.bsc[0].tags=['mev_bot'],s=>s.chains.bsc.feedCoverage.kol.valid=false];
  for(const mutate of change){const s=singleState();mutate(s);assert.equal(buildCollectiveWire({state:s,nowMs:NOW,allowPrequalified:true}).signals.length,0,mutate.toString());}
  const s=singleState(),first=buildCollectiveWire({state:s,nowMs:NOW,allowPrequalified:true}).signals[0];
  s.trades.bsc.push(structuredClone(s.trades.bsc[0]));
  assert.equal(buildCollectiveWire({state:s,nowMs:NOW+1000,allowPrequalified:true}).signals[0].id,first.id);
  assert.equal(buildCollectiveWire({state:s,nowMs:NOW+30001,allowPrequalified:true}).signals.length,0);
  assert.equal(paperEventTriggers({evidence:{flowState:s},chains:['bsc'],nowMs:NOW,allowPrequalified:true})[0].source,'prequalified_wallet');
});

test('three qualified net buyer groups trigger before any chart or model request; repeated feeds and receipt clocks do not create a new ID',()=>{
  const s=state(),wire=buildCollectiveWire({state:s,nowMs:NOW});
  assert.equal(wire.signals.length,1,JSON.stringify(wire.checks));
  const signal=wire.signals[0];assert.equal(signal.groupCount,3);assert.equal(signal.windowMs,10000);assert.equal(signal.netBuyUsd,600);
  assert.ok(validCollectiveSignal(signal,token,NOW));
  s.trades.bsc.push(structuredClone(s.trades.bsc[0]));
  for(const v of Object.values(s.chains.bsc.feedCoverage)){v.endAt+=1000;v.observedAt+=1000;}
  assert.equal(buildCollectiveWire({state:s,nowMs:NOW+1000}).signals[0].id,signal.id);
  assert.equal(paperEventTriggers({evidence:{flowState:state()},chains:['bsc'],nowMs:NOW})[0].source,'collective_smart_money');
  assert.equal(paperEventTriggers({evidence:{flowState:state()},chains:['bsc'],nowMs:NOW}).length,1,'generic hint cannot overwrite algorithm detection');
  s.chains.bsc.status='partial';assert.equal(buildCollectiveWire({state:s,nowMs:NOW+1000}).signals.length,1,'unrelated chain-wide profile warnings cannot reject a complete CA window');
});

test('same-tx groups, fake tags, net selling, conflicts, transfers, gaps and stale/future evidence do not authorize an entry',()=>{
  const mutations=[s=>s.trades.bsc[1].hash=s.trades.bsc[0].hash,s=>s.profiles={},
    s=>s.trades.bsc.push({...s.trades.bsc[0],side:'sell',hash:hash(9),amountUsd:200}),
    s=>s.trades.bsc.push({...s.trades.bsc[0],side:'sell'}),s=>s.trades.bsc[0].side='transfer',
    s=>s.trades.bsc[0].at=NOW+1,s=>s.trades.bsc[0].wallet=CA,
    s=>s.chains.bsc.feedCoverage.kol.startAt=NOW-1000,s=>s.chains.bsc.feedCoverage.kol.observedAt=NOW+1,
    s=>s.chains.bsc.quarantinedTokens={[CA]:iso(NOW+60000)},s=>s.chains.bsc.tokenRebuildUntil={[CA]:iso(NOW+60000)},
    s=>s.profiles[`bsc:${address(1)}`]['7d'].checkedAt=iso(NOW+1),
    s=>s.profiles[`bsc:${address(1)}`]['30d'].wallet=CA,
    s=>s.trades.bsc[0].tags=['mev_bot']];
  for(const change of mutations){const s=state();change(s);assert.equal(buildCollectiveWire({state:s,nowMs:NOW}).signals.length,0,change.toString());}
  assert.equal(buildCollectiveWire({state:state(),nowMs:NOW+30001}).signals.length,0);
  const signal=input().collectiveSignal;
  assert.equal(validCollectiveSignal({...signal,netBuyUsd:1000000},token,NOW),false);
  assert.equal(validCollectiveSignal(signal,{...token,address:address(99)},NOW),false);
});

test('internal signal uses a single real quote, frozen wallet thesis and paper-only writer; no fake fill or duplicate after restart',()=>{
  const start=performance.now(),row=evaluate(input());
  assert.equal(row.decision,'可模拟',JSON.stringify({missing:row.missing,reasons:row.reasons,routes:row.evidence.opportunityRoutes}));
  assert.ok(performance.now()-start<1000);
  assert.equal(row.evidence.opportunity.id,'collective_smart_money');assert.equal(row.evidence.recoveryCheck.requiresChart,false);
  assert.equal(row.evidence.lossRepair.group,'collective_smart_money');assert.equal(row.evidence.lossRepair.thesis.version,COLLECTIVE_THESIS_VERSION);
  const a=advance(row),p=Object.values(a.positions)[0];
  assert.equal(a.trades.length,1);assert.equal(a.cash,90);assert.equal(p.tradeThesis,undefined);assert.equal(p.collectiveThesis.version,COLLECTIVE_THESIS_VERSION);
  assert.equal(validatePaperStrategyAccount(a),true);
  assert.equal(advancePaperStrategyAccount(JSON.parse(JSON.stringify(a)),{...modes,evaluations:[row],nowMs:NOW+1}).trades.length,1);
  assert.equal(a.execution,false);assert.equal(a.signing,false);assert.equal(a.broadcast,false);
  p.collectiveThesis.buyers=[];assert.throws(()=>validatePaperStrategyAccount(a),/collective wallet thesis/);
});

test('external stage still needs real closed structure; missing safety, taxes, quote and balance never get bypassed',()=>{
  const changes=[i=>i.token.marketStage='external',i=>i.token.marketStage='unknown',i=>i.token.stageConflict=true,
    i=>delete i.token.isHoneypot,i=>i.token.isHoneypot=true,i=>i.token.buyTax=.061,i=>delete i.token.sellTax,
    i=>i.token.liquidity=0,i=>i.compoundingCash=0,i=>i.quoteHistory=[],i=>i.quoteHistory[0].observedAt=iso(NOW-6000),
    i=>i.quoteHistory[0].price=2,i=>i.quoteHistory.push({...i.quoteHistory[0],price:2}),i=>i.collectiveSignal.proof.profiles={}];
  for(const change of changes){const i=input();change(i);const r=evaluate(i);assert.notEqual(r.decision,'可模拟',change.toString());assert.equal(advance(r).trades.length,0);}
  const i=input();i.quoteHistory=[];const r=evaluate(i);assert.equal(researchReadyForQuote(r),true,'quote can be requested without faking a fill');
});

test('single writer rechecks exact wallet proof and source expiry, not the UI ready flag',()=>{
  const original=evaluate(input());
  for(const change of [r=>r.evidence.collectiveSignal.buyers=[],r=>r.evidence.recoveryEntry.collectiveSignal=null,
    r=>r.evidence.recoveryEntry.marketStage='external',r=>r.evidence.safety.auditComplete=false,
    r=>r.evidence.confirmedPolicy.confirmation.rows=[],r=>r.evidence.recoveryEntry.quotes=[]]) {
    const r=structuredClone(original);change(r);assert.equal(advance(r).trades.length,0,change.toString());
  }
  assert.equal(advance(original,{nowMs:NOW+6000}).trades.length,0);
});

test('external collective entry retains a closed-chart anchor rather than pretending to be a new launch',()=>{
  const i=input();i.token.marketStage='external';i.klineStatus='ok';
  i.candles=Array.from({length:30},(_,n)=>({time:NOW-(30-n)*60000,open:.98,close:.99,low:.97,high:1,volume:1000}));
  const row=evaluate(i);assert.equal(row.decision,'可模拟',JSON.stringify({m:row.missing,r:row.reasons}));
  assert.equal(row.evidence.recoveryCheck.requiresChart,true);
  const a=advance(row),p=Object.values(a.positions)[0];assert.equal(a.trades.length,1);
  assert.equal(p.collectiveThesis,undefined);assert.equal(p.tradeThesis.anchor,.97);assert.equal(validatePaperStrategyAccount(a),true);
});

test('entry cohort selling stays visible without current profit tags; repeated/stale windows never invent an exit',()=>{
  const i=input(),row=evaluate(i);row.evidence.memeExitContext=memeEntryContext(token,{flow:i.flow},NOW);
  const p=Object.values(advance(row).positions)[0];
  const mark=(offset,amount)=>({...token,status:'ok',observedAt:iso(NOW+offset),flow:{chain:'bsc',address:CA,
    provider:'gmgn',fresh:true,complete:true,status:'healthy',observedAt:iso(NOW+offset),netBuyUsd:-3*amount,
    wallets:[1,2,3].map(n=>({wallet:address(n),buyUsd:0,sellUsd:amount,netBuyUsd:-amount,tags:[],highProfit:false,lastSellAt:NOW+offset}))}});
  const first=assessMemeExit(p,mark(1000,200),NOW+1000);assert.equal(first.exit,false);assert.equal(first.flow.sellerCount,3);
  p.thesisFlowWatch=first.flowWatch;
  assert.equal(assessMemeExit(p,mark(31000,200),NOW+31000).exit,false,'timestamp change without new sales is not confirmation');
  const second=assessMemeExit(p,mark(31000,300),NOW+31000);assert.equal(second.exit,true);assert.equal(second.flow.cohortSellers.length,3);
  assert.equal(assessMemeExit(p,mark(31000,300),NOW+47000).exit,false,'no fresh sell quote, no paper exit');
});

test('runtime discovers an off-ranking CA, fetches details then quote, persists one fill plus telemetry and keeps them on restart',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-collective-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'bsc',chains:['bsc'],enabled:false,account:createPaperStrategyAccount({nowMs:NOW})}));
  await createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-collective-original',nowMs:NOW});
  const session=await createEstimatedPaperSession({dataDir,id:'confirmed-pvp-v2-estimated-collective-test',nowMs:NOW});
  let clock=NOW,details=0,quotes=0,charts=0;
  const market={trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    details:async()=>{details++;return {status:'ok',observedAt:iso(clock),token};},
    quote:async()=>{quotes++;return {...token,status:'ok',observedAt:iso(clock)};},kline:async()=>{charts++;return {status:'unavailable',candles:[]};}};
  const options={...modes,dataDir,session,chain:'bsc',chains:['bsc'],market,now:()=>clock,
    evidenceLoader:()=>({flowState:state(),events:[]}),intervalMs:60000,marketIntervalMs:60000};
  let r=createPaperStrategyRuntime(options);
  try {
    await r.runOnce();await r.setEnabled(true);await r.fastOnce();await r.refreshDetails();await r.fastOnce();
    await r.refreshQuote();await r.fastOnce();
    let s=r.snapshot();assert.ok(details>0);assert.equal(quotes,1);assert.equal(charts,0);
    assert.equal(s.account.trades.length,1,JSON.stringify({journal:s.algorithmSignals,eval:s.cadence.lastCandidateEvaluation,diagnostics:s.researchPipeline.entryDiagnostics}));
    assert.equal(s.algorithmSignals.filled,1);assert.equal(s.algorithmSignals.records[0].detectionToFillMs,0);
    const stored=JSON.parse(await fs.readFile(r.stateFile,'utf8'));assert.equal(stored.algorithmSignalJournal.length,1);
    assert.equal(validatePaperStrategyAccount(stored.account),true);
    await r.stop();r=createPaperStrategyRuntime(options);clock+=1000;await r.runOnce();s=r.snapshot();
    assert.equal(s.account.trades.length,1);assert.equal(s.algorithmSignals.filled,1);assert.equal(s.enabled,true);
  }finally{await r.stop();}
});

for(const liquidity of [10000,null,.0025,50,999])for(const mode of ['scan','dispatch','expired_quote'])test(`runtime burst depth ${mode}, liquidity ${liquidity} rechecks evidence without K line`,async t=>{
  const eventDriven=mode!=='scan';let clock=NOW;
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-inner-burst-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'bsc',chains:['bsc'],enabled:false,account:createPaperStrategyAccount({nowMs:NOW})}));
  await createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-burst-original',nowMs:NOW});
  const session=await createEstimatedPaperSession({dataDir,id:'confirmed-pvp-v2-estimated-burst-test',nowMs:NOW});
  const inner={...token,liquidity,buyTax:.01,sellTax:.01};let depthCalls=0,charts=0,release;
  const options={...modes,dataDir,session,chain:'bsc',chains:['bsc'],now:()=>clock,discoveryMode:GMGN_THREE_LISTS,
    evidenceLoader:()=>({flowState:burstState(),events:[]}),intervalMs:60000,marketIntervalMs:60000,
    internalDepthProbe:{probe:args=>{depthCalls++;return new Promise(resolve=>{release=()=>resolve({status:'ok',proof:depthFixture(args.token,args.budgetUsd,args.notionalUsd,NOW)});});}},
    market:{trending:async()=>({status:'ok',observedAt:iso(NOW),interval:'5m',tokens:[]}),trenches:async()=>({status:'ok',observedAt:iso(NOW),tokens:[]}),
      details:async()=>({status:'ok',observedAt:iso(NOW),token:inner}),quote:async()=>({...inner,status:'ok',observedAt:iso(NOW)}),
      kline:async()=>{charts++;return {status:'unavailable',candles:[]};}}};
  let r=createPaperStrategyRuntime(options);
  try {
    await r.runOnce();await r.setEnabled(true);await r.fastOnce();await r.refreshDetails();await r.fastOnce();await r.refreshQuote();await r.fastOnce();
    assert.equal(depthCalls,1,JSON.stringify({a:r.snapshot().algorithmSignals,e:r.snapshot().evaluations.map(x=>({d:x.decision,m:x.missing,r:x.reasons}))}));
    assert.equal(r.snapshot().account.trades.length,0,'pending real evidence cannot be fabricated');
    await r.fastOnce();assert.equal(depthCalls,1,'single-flight probe does not block scans or multiply work');
    if(eventDriven) {
      await r.start();await r.fastOnce();
      // Let the already-seen quote's targeted evaluation finish first. The
      // broad scan interval is 60 s, so depth must wake its own event lane.
      await new Promise(resolve=>setTimeout(resolve,40));
      assert.equal(r.snapshot().account.trades.length,0);
    }
    const priorDispatches=r.snapshot().cadence.eventDispatch?.evaluations||0;
    if(mode==='expired_quote')clock+=6000;
    release();await new Promise(resolve=>setImmediate(resolve));
    if(eventDriven) {
      for(let n=0;n<100&&r.snapshot().account.trades.length===0;n++)await new Promise(resolve=>setTimeout(resolve,2));
      assert.ok(r.snapshot().cadence.eventDispatch.evaluations>priorDispatches,'depth completion must dispatch, without waiting for another quote or broad scan');
    } else await r.fastOnce();
    if(mode==='expired_quote') {
      assert.equal(r.snapshot().account.trades.length,0,'new depth must not rejuvenate a six-second-old entry quote');
      assert.equal(charts,0);
      return;
    }
    const s=r.snapshot();assert.equal(charts,0);assert.equal(s.account.trades.length,1,JSON.stringify({a:s.algorithmSignals,e:s.evaluations.map(x=>({d:x.decision,m:x.missing,r:x.reasons}))}));
    assert.equal(s.account.trades[0].entryEvidence.opportunity.id,'internal_burst');assert.equal(s.algorithmSignals.filled,1);
    assert.ok(validatePaperStrategyAccount(s.account));await r.stop();r=createPaperStrategyRuntime(options);await r.runOnce();assert.equal(r.snapshot().account.trades.length,1);
  } finally {release?.();await r.stop();}
});

const capacityDepthFailure={status:'unavailable',code:'RPC_COORDINATOR_UNAVAILABLE',rpcFailureScope:'capacity',
  retryAfterMs:100,diagnostics:{physicalRequests:0}};

async function depthRetryRuntime(t,probe) {
  let clock=NOW,flow=burstState(),runtime;const calls=[];
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-depth-capacity-retry-'));
  t.after(async()=>{await runtime?.stop();await fs.rm(dataDir,{recursive:true,force:true});});
  await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'bsc',chains:['bsc'],enabled:false,account:createPaperStrategyAccount({nowMs:NOW})}));
  await createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-depth-retry-original',nowMs:NOW});
  const session=await createEstimatedPaperSession({dataDir,id:'confirmed-pvp-v2-estimated-depth-retry-test',nowMs:NOW});
  const inner={...token,liquidity:10000,buyTax:.01,sellTax:.01};
  const options={...modes,dataDir,session,chain:'bsc',chains:['bsc'],now:()=>clock,discoveryMode:GMGN_THREE_LISTS,
    evidenceLoader:()=>({flowState:flow,events:[]}),intervalMs:60000,marketIntervalMs:60000,
    internalDepthProbe:{probe:args=>{calls.push({at:clock,args});return probe(args,calls.length,clock);}},
    market:{trending:async()=>({status:'ok',observedAt:iso(clock),interval:'5m',tokens:[]}),
      trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
      details:async()=>({status:'ok',observedAt:iso(clock),token:inner}),
      quote:async()=>({...inner,status:'ok',observedAt:iso(clock)}),
      kline:async()=>({status:'unavailable',candles:[]})}};
  runtime=createPaperStrategyRuntime(options);
  try {
    await runtime.runOnce();await runtime.setEnabled(true);await runtime.fastOnce();await runtime.refreshDetails();
    await runtime.fastOnce();await runtime.refreshQuote();await runtime.fastOnce();
    await new Promise(resolve=>setImmediate(resolve));await runtime.fastOnce();
  }catch(error){await runtime.stop();throw error;}
  return {runtime,calls,options,setClock:value=>{clock=value;},setFlow:value=>{flow=value;},
    async scan(){await runtime.fastOnce();await new Promise(resolve=>setImmediate(resolve));await runtime.fastOnce();}};
}

test('runtime depth retries zero-RPC capacity once available, keeps the anchored generation and deduplicates fills',async t=>{
  const h=await depthRetryRuntime(t,(args,n,clock)=>n===1?capacityDepthFailure:
    {status:'ok',proof:depthFixture(args.token,args.budgetUsd,args.notionalUsd,clock)});
  const {runtime,calls}=h;
  assert.equal(calls.length,1);assert.equal(runtime.snapshot().account.trades.length,0);
  const retryPolicy=runtime.snapshot().algorithmSignals.depthProbe;
  assert.equal(retryPolicy.retryPolicyVersion,'bounded_zero_rpc_capacity_retry_v1');
  assert.equal(retryPolicy.maxAttempts,3);assert.equal(retryPolicy.windowMs,10000);
  assert.equal(retryPolicy.minBackoffMs,1000);assert.equal(retryPolicy.failureBackoffMs,60000);
  assert.equal(retryPolicy.maxCandidates,64);assert.equal(retryPolicy.trackedCandidates,1);
  h.setClock(NOW+999);await h.scan();assert.equal(calls.length,1,'one-second minimum, not a scan-speed busy loop');
  h.setClock(NOW+1000);await h.scan();
  assert.equal(calls.length,2);assert.equal(runtime.snapshot().account.trades.length,1);
  const last=runtime.snapshot().algorithmSignals.depthProbe.last;
  assert.equal(last.attempts,2);assert.equal(last.generationStartedAt,iso(NOW));
  await h.scan();assert.equal(runtime.snapshot().account.trades.length,1);
  assert.ok(validatePaperStrategyAccount(runtime.snapshot().account));
  await runtime.stop();const restarted=createPaperStrategyRuntime(h.options);
  try {await restarted.runOnce();assert.equal(restarted.snapshot().account.trades.length,1);}finally{await restarted.stop();}
});

test('runtime capacity retries stop at three attempts even when signal IDs change or the window elapses',async t=>{
  const h=await depthRetryRuntime(t,()=>capacityDepthFailure),{runtime,calls}=h;
  const original=runtime.snapshot().algorithmSignals.depthProbe.last.generationSignalId;
  for(const offset of [1000,2000]) {
    const flow=burstState();flow.trades.bsc[0].hash=hash(200+offset);
    h.setFlow(flow);h.setClock(NOW+offset);await h.scan();
  }
  assert.equal(calls.length,3);
  const last=runtime.snapshot().algorithmSignals.depthProbe.last;
  assert.equal(last.generationSignalId,original);assert.equal(last.generationStartedAt,iso(NOW));
  assert.equal(last.attempts,3);assert.equal(last.capacityRetry,false);assert.equal(last.nextAttemptAt,iso(NOW+62000));
  for(const offset of [3000,9000,10000,11000,20000]) {
    h.setClock(NOW+offset);await runtime.refreshQuote();await h.scan();
  }
  assert.equal(calls.length,3,'fresh quotes and fixed-window expiry do not reset an exhausted CA cooldown');
  assert.equal(runtime.snapshot().account.trades.length,0);
});

for(const patch of [{rpcFailureScope:'host',retryAfterMs:90000},{rpcFailureScope:'method',retryAfterMs:90000},
  {diagnostics:{physicalRequests:1}},{diagnostics:null},{rpcFailureScope:'unknown'},{retryAfterMs:'100'},
  {code:'RPC_TIMEOUT'},{status:'unavailable',code:'flap_quote_route_unsupported',rpcFailureScope:null}])
  test(`runtime depth does not short-retry non-capacity/unproven failures ${JSON.stringify(patch)}`,async t=>{
    const h=await depthRetryRuntime(t,()=>({...capacityDepthFailure,...patch}));
    h.setClock(NOW+1000);await h.scan();h.setClock(NOW+4000);await h.scan();
    assert.equal(h.calls.length,1);assert.equal(h.runtime.snapshot().account.trades.length,0);
    const last=h.runtime.snapshot().algorithmSignals.depthProbe.last;
    assert.equal(last.capacityRetry,false);
    assert.equal(last.nextAttemptAt,iso(NOW+(['host','method'].includes(patch.rpcFailureScope)?90000:60000)));
  });

test('runtime capacity retry honors its advertised wait and cannot turn new depth into a fresh entry quote',async t=>{
  let resolveProbe;
  const h=await depthRetryRuntime(t,(args,n,clock)=>n===1?{...capacityDepthFailure,retryAfterMs:3000}:
    new Promise(resolve=>{resolveProbe=()=>resolve({status:'ok',proof:depthFixture(args.token,args.budgetUsd,args.notionalUsd,clock)});}));
  h.setClock(NOW+1000);await h.scan();assert.equal(h.calls.length,1);
  h.setClock(NOW+3000);await h.scan();assert.equal(h.calls.length,2);
  h.setClock(NOW+6000);resolveProbe();await h.scan();
  assert.equal(h.runtime.snapshot().account.trades.length,0,'the original six-second quote is still stale');
  assert.equal(h.calls.length,2);
});

for(const elapsed of [9000,9500])test(`runtime capacity retry window is anchored before a ${elapsed} ms refusal, not renewed at completion`,async t=>{
  let resolveProbe;
  const h=await depthRetryRuntime(t,()=>new Promise(resolve=>{resolveProbe=resolve;}));
  h.setClock(NOW+elapsed);resolveProbe(capacityDepthFailure);await h.scan();
  const last=h.runtime.snapshot().algorithmSignals.depthProbe.last;
  assert.equal(last.generationStartedAt,iso(NOW));assert.equal(last.capacityRetry,false);
  assert.equal(last.nextAttemptAt,iso(NOW+elapsed+60000));
  h.setClock(NOW+10500);await h.runtime.refreshQuote();await h.scan();
  assert.equal(h.calls.length,1);assert.equal(h.runtime.snapshot().account.trades.length,0);
});

test('runtime 5-second capacity waits cannot schedule a retry at the ten-second generation boundary',async t=>{
  const h=await depthRetryRuntime(t,()=>({...capacityDepthFailure,retryAfterMs:5000}));
  h.setClock(NOW+5000);await h.runtime.refreshQuote();await h.scan();
  assert.equal(h.calls.length,2);
  const last=h.runtime.snapshot().algorithmSignals.depthProbe.last;
  assert.equal(last.capacityRetry,false);assert.equal(last.generationStartedAt,iso(NOW));
  assert.equal(last.nextAttemptAt,iso(NOW+65000));
  for(const offset of [10000,15000,20000]) {
    const flow=burstState();flow.trades.bsc[0].hash=hash(300+offset);h.setFlow(flow);
    h.setClock(NOW+offset);await h.runtime.refreshQuote();await h.scan();
  }
  assert.equal(h.calls.length,2);assert.equal(h.runtime.snapshot().account.trades.length,0);
});

for(const elapsed of [10000,11000])test(`runtime delayed capacity tick at ${elapsed} ms cannot reset its pending short-retry generation`,async t=>{
  const h=await depthRetryRuntime(t,()=>({...capacityDepthFailure,retryAfterMs:5000}));
  const flow=burstState();flow.trades.bsc[0].hash=hash(400+elapsed);h.setFlow(flow);
  h.setClock(NOW+elapsed);await h.runtime.refreshQuote();await h.scan();
  assert.equal(h.calls.length,1);
  const last=h.runtime.snapshot().algorithmSignals.depthProbe.last;
  assert.equal(last.retryWindowExpired,true);assert.equal(last.capacityRetry,false);
  assert.equal(last.generationStartedAt,iso(NOW));assert.equal(last.nextAttemptAt,iso(NOW+60000));
  h.setClock(NOW+20000);await h.runtime.refreshQuote();await h.scan();
  assert.equal(h.calls.length,1);
  assert.equal(h.runtime.snapshot().account.trades.length,0);
});

test('runtime capacity retry cannot revive an expired signal with a newly fetched quote',async t=>{
  const h=await depthRetryRuntime(t,()=>capacityDepthFailure);
  h.setClock(NOW+31000);await h.runtime.refreshQuote();await h.scan();
  assert.equal(h.calls.length,1);assert.equal(h.runtime.snapshot().account.trades.length,0);
});

for(const stage of ['internal','event','external','unknown','expired'])test(`three-list runtime wallet exception: ${stage}, no stale or external escape`,async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-inner-wallet-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dataDir,LEGACY_PAPER_FILE),JSON.stringify({schema:'yesp_atm_runtime_v1',chain:'bsc',chains:['bsc'],enabled:false,account:createPaperStrategyAccount({nowMs:NOW})}));
  await createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-inner-original',nowMs:NOW});
  const session=await createEstimatedPaperSession({dataDir,id:'confirmed-pvp-v2-estimated-inner-test',nowMs:NOW});
  let clock=NOW,chartCalls=0,detailCalls=0,live=stage!=='event';
  const expectedFill=['internal','event'].includes(stage);
  const tok={...token,marketStage:['expired','event'].includes(stage)?'internal':stage};
  const market={trending:async()=>({status:'ok',interval:'5m',observedAt:iso(clock),tokens:[]}),
    trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    details:async()=>{detailCalls++;return {status:'ok',observedAt:iso(clock),token:tok};},
    quote:async()=>({...tok,status:'ok',observedAt:iso(clock)}),
    kline:async()=>{chartCalls++;return {status:'unavailable',candles:[]};}};
  const options={...modes,dataDir,session,chain:'bsc',chains:['bsc'],discoveryMode:GMGN_THREE_LISTS,
    market,now:()=>clock,evidenceLoader:()=>({flowState:live?singleState():{},events:[]}),intervalMs:60000,marketIntervalMs:60000};
  let r=createPaperStrategyRuntime(options);
  try {
    await r.runOnce();await r.setEnabled(true);
    if(stage==='event') {
      await r.start();for(let n=0;n<30;n++)await new Promise(resolve=>setTimeout(resolve,1));
      live=true;await r.refreshEvents();
      for(let n=0;n<300&&r.snapshot().account.trades.length===0;n++)await new Promise(resolve=>setTimeout(resolve,1));
      assert.ok(r.snapshot().cadence.eventDispatch.evaluations>0);
    } else {
      await r.fastOnce();await r.refreshDetails();
      if(stage==='expired')clock+=31000;
      await r.fastOnce();await r.refreshQuote();await r.fastOnce();
    }
    let s=r.snapshot();assert.ok(detailCalls>0);assert.equal(s.discoveryScope.uniqueCandidates,0);
    assert.equal(s.account.trades.length,expectedFill?1:0,JSON.stringify({stage,eval:s.evaluations?.map(x=>({m:x.missing,r:x.reasons})),journal:s.algorithmSignals,event:s.cadence.eventDispatch}));
    if(expectedFill) {
      assert.equal(chartCalls,0);assert.equal(s.algorithmSignals.filled,1);
      assert.equal(s.account.trades[0].entryEvidence.entryPlan.entryPolicyVersion,PREQUALIFIED_WALLET_VERSION);
      await r.stop();r=createPaperStrategyRuntime(options);clock+=1000;await r.runOnce();s=r.snapshot();
      assert.equal(s.account.trades.length,1);assert.equal(s.algorithmSignals.filled,1);
    }
  }finally{await r.stop();}
});
