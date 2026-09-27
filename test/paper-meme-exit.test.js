import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MEME_EXIT_VERSION,MEME_EXIT_POLICY,LEGACY_MEME_EXIT_POLICY,assessMemeExit,memeEntryContext,memeExitEvaluation} from '../src/paper-meme-exit.js';
import {createPaperStrategyAccount,advancePaperStrategyAccount,evaluatePaperStrategies,validatePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {createPaperStrategyRuntime} from '../src/paper-strategy-runtime.js';
import {createExitComparison,advanceExitComparison} from '../src/paper-exit-comparison.js';
import {opportunityChart} from '../src/paper-opportunity-policy.js';
import {completedPaperRounds} from '../src/paper-confirmed-policy.js';
import {traderReview} from '../src/paper-trader-reasoning.js';
import {renderStrategyDetails} from '../dashboard/strategy-details.js';
import {createReadonlyMarketClient} from '../src/gmgn-readonly-market.js';
const NOW=Date.parse('2026-09-25T03:00:00Z'),iso=ms=>new Date(ms).toISOString(),CA=`0x${'a'.repeat(40)}`;
const token={chain:'base',address:CA,symbol:'OFFLINE_ONLY',price:1.03,marketStage:'external',liquidity:60000,volume:5000,
  isHoneypot:false,isWashTrading:false,rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,buyTax:0,sellTax:0};
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true};
const wallet=(n,buyUsd=0,sellUsd=200)=>({wallet:`0x${String(n).repeat(40)}`,buyUsd,sellUsd,netBuyUsd:buyUsd-sellUsd,tags:['smart_money']});
const flow=(now=NOW+1000,rows=[wallet(1),wallet(2)])=>({...token,provider:'gmgn',status:'healthy',fresh:true,complete:true,
  observedAt:iso(now),netBuyUsd:rows.reduce((s,r)=>s+r.netBuyUsd,0),wallets:rows.map(w=>({...w,lastBuyAt:w.buyUsd?now:null,lastSellAt:w.sellUsd?now:null}))});
const pos=()=>({...token,entryPrice:1.03,openedAt:iso(NOW),memeExitPolicy:{...MEME_EXIT_POLICY},entryEvidence:{flowDiagnostics:{provider:'gmgn'},
  flow:{netBuyUsd:500},opportunity:{basis:'ohlcv',pattern:{reclaimPrice:1}}}});
const quote=(now,price=.8)=>({...token,status:'ok',price,observedAt:iso(now)});
function mark(now=NOW+180000,closes=[1.04,.98,.96],volume=130){
  const rows=Array.from({length:30},(_,i)=>({time:now-(30-i)*60000,open:1.04,high:1.05,low:1.03,close:1.04,volume:100}));
  closes.forEach((close,i)=>{rows[27+i]={...rows[27+i],open:close+.01,high:close+.015,low:close-.01,close,volume:i===2?volume:100};});
  return {...quote(now,closes.at(-1)),structureChart:{...opportunityChart(rows,'ok',now),chain:token.chain,address:CA}};
}
function candles(){
  const rows=Array.from({length:24},(_,i)=>{const p=i<8?.8+i*.025:1;return [p,p+.01,p-.005,p,100];});
  rows[23]=[1,1.035,.999,1.03,180];
  return rows.map(([open,high,low,close,volume],i)=>({time:NOW-(rows.length-i)*60000,open,high,low,close,volume}));
}
function entry(){
  const row=evaluatePaperStrategies({...modes,nowMs:NOW,token,observedAt:iso(NOW),marketStatus:'ok',priceObservedAt:iso(NOW),
    requireFastQuote:true,compoundingCash:100,fixedEntryUsd:10,flow:{},klineStatus:'ok',candles:candles(),
    quoteHistory:[-4000,0].map(d=>quote(NOW+d,d?1.028:1.03))})[0];
  assert.equal(row.decision,'可模拟');return row;
}

test('V2 structure reference survives ledger restart, exits on a fresh quote and leaves V1 positions untouched',()=>{
  let main=advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{...modes,memeExitMode:true,evaluations:[entry()],nowMs:NOW});
  const buy=structuredClone(main.trades[0]);
  const rows=Array.from({length:30},(_,i)=>({time:NOW+(i-20)*60000,open:1.5,close:1.5,high:1.55,low:1.45,volume:100}));
  rows[24]={...rows[24],open:1.38,close:1.37,high:1.4,low:1.3};
  rows[25]={...rows[25],open:1.4,close:1.5,high:1.53,low:1.36};
  rows[26]={...rows[26],open:1.5,close:1.55,high:1.6,low:1.45};
  rows[27]={...rows[27],open:1.55,close:1.6,high:1.65,low:1.5};
  const rising={...quote(NOW+480000,1.6),structureChart:{...opportunityChart(rows.filter(r=>r.time+60000<=NOW+480000),'ok',NOW+480000),chain:token.chain,address:CA}};
  main=advancePaperStrategyAccount(main,{marks:[rising],nowMs:NOW+480000,enabled:false});
  assert.equal(main.trades.length,1);assert.equal(main.positions[`base:${CA}`].structureTrail.level,1.3);
  main=JSON.parse(JSON.stringify(main));assert.equal(validatePaperStrategyAccount(main),true);
  const old=structuredClone(main),oldPosition=old.positions[`base:${CA}`];
  old.memeExitActivation.version=LEGACY_MEME_EXIT_POLICY.version;
  oldPosition.memeExitPolicy={...LEGACY_MEME_EXIT_POLICY};oldPosition.entryEvidence.memeExitPolicy={...LEGACY_MEME_EXIT_POLICY};
  delete oldPosition.structureTrail;
  rows[28]={...rows[28],open:1.32,close:1.29,high:1.33,low:1.28};
  rows[29]={...rows[29],open:1.29,close:1.27,high:1.30,low:1.26};
  const broken={...quote(NOW+600000,1.27),structureChart:{...opportunityChart(rows,'ok',NOW+600000),chain:token.chain,address:CA}};
  main=advancePaperStrategyAccount(main,{marks:[broken],nowMs:NOW+600000,enabled:false});
  assert.equal(main.trades.length,2);assert.deepEqual(main.trades[0],JSON.parse(JSON.stringify(buy)));assert.equal(main.trades[1].price,1.27);
  assert.ok(main.trades[1].costsUsd>0);assert.equal(main.trades[1].exitEvidence.thesisDecision.comparison.exit,false);
  assert.equal(validatePaperStrategyAccount(main),true);
  const preserved=advancePaperStrategyAccount(old,{...modes,memeExitMode:true,marks:[broken],nowMs:NOW+600000,enabled:false});
  assert.equal(preserved.trades.length,1);assert.equal(preserved.positions[`base:${CA}`].memeExitPolicy.version,LEGACY_MEME_EXIT_POLICY.version);
});

test('main confirmation survives 20-second queue and makes independent reads without blocking discovery indefinitely',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-entry-confirm-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let clock=NOW,reads=0,scans=0;const purposes=[];
  const quotes=createReadonlyMarketClient({now:()=>clock,runner:async(args,options)=>{
    assert.equal(options.priority,2,'recovery entry confirmation uses existing critical admission');
    reads++;if(reads===1)clock+=20000;options.onRequestStart(clock);clock+=4000;
    return JSON.stringify({data:{address:CA,price:{price:reads===1?1.028:1.03}}});
  }});
  const market={trending:async()=>{scans++;return {status:'ok',observedAt:iso(clock),tokens:[token]};},
    trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    kline:async args=>({...args,status:'ok',candles:candles()}),quote:args=>{purposes.push(args.purpose);return quotes.quote(args);}};
  const r=createPaperStrategyRuntime({...modes,memeExitMode:true,recoveryMode:true,dataDir,chain:'base',chains:['base'],market,
    now:()=>clock,fixedEntryUsd:10,evidenceLoader:()=>({}),tradeReviewEvery:100});
  try{
    await r.runOnce();await r.fastOnce();assert.equal(r.snapshot().researchPipeline.entryFocus.active,true);
    const before=scans;
    await r.refreshQuote();await r.fastOnce();
    assert.equal(r.snapshot().researchPipeline.entryFocus.active,true,'first response at 24 seconds keeps its bounded lease');
    await r.refreshMarket({background:true});assert.equal(scans,before,'broad dashboard requests yield during confirmation');
    await r.refreshQuote();await r.fastOnce();
    assert.equal(reads,2,'second quote bypasses successful cache, not account pacing');
    assert.deepEqual(purposes,['entry_confirmation','entry_confirmation']);
    const s=r.snapshot();assert.equal(s.account.trades.length,1);assert.equal(s.tradeCountReview.pendingFills,1);
    assert.equal(s.account.trades[0].entryEvidence.entryPlan.entryPolicyVersion,'meme_structure_entry_v1');
    await r.setEnabled(false);await r.fastOnce();await r.refreshMarket({background:true});
    assert.ok(scans>before,'discovery resumes after entry focus ends');
  }finally{await r.stop();}
});

test('new main lots have no percent/multiple/time exit, preserve history and leave controls unchanged',()=>{
  const initial=createPaperStrategyAccount({nowMs:NOW}),row=entry();
  let main=advancePaperStrategyAccount(initial,{...modes,memeExitMode:true,evaluations:[memeExitEvaluation(row)],nowMs:NOW});
  const buy=structuredClone(main.trades[0]);
  assert.equal(main.positions[`base:${CA}`].memeExitPolicy.version,MEME_EXIT_VERSION);
  assert.equal(main.memeExitActivation.baselineTradeCount,0);
  for(const [i,price] of [.8,3.2,.2].entries())main=advancePaperStrategyAccount(main,{marks:[quote(NOW+(i+1)*1000,price)],enabled:false,nowMs:NOW+(i+1)*1000});
  assert.equal(main.trades.length,1);assert.deepEqual(main.trades[0],buy);assert.ok(main.stats.netLiquidationValue<93);
  main=advancePaperStrategyAccount(main,{marks:[quote(NOW+86400000,.8)],enabled:false,nowMs:NOW+86400000});
  assert.equal(main.trades.length,1,'elapsed time is not an exit');assert.equal(validatePaperStrategyAccount(main),true);
  const old=advancePaperStrategyAccount(initial,{...modes,evaluations:[row],nowMs:NOW});
  const oldPosition=structuredClone(old.positions[`base:${CA}`]);
  const activated=advancePaperStrategyAccount(old,{...modes,memeExitMode:true,enabled:false,nowMs:NOW+1});
  for(const field of ['entryEvidence','exitLogic','exitPlan','pvpPolicy','costAssumptions','openedAt','entryPrice'])
    assert.deepEqual(activated.positions[`base:${CA}`][field],oldPosition[field]);
  const closed=advancePaperStrategyAccount(activated,{marks:[quote(NOW+1000,.8)],nowMs:NOW+1000});
  assert.equal(closed.trades.at(-1).side,'sell');assert.notEqual(closed.trades.at(-1).exitEvidence.exitPolicyVersion,MEME_EXIT_VERSION);
  const pair=advanceExitComparison(createExitComparison(initial,NOW),{evaluations:[row],marksFor:()=>[],enabled:true,nowMs:NOW});
  assert.equal(pair.control.positions[`base:${CA}`].memeExitPolicy,undefined);
  assert.equal(pair.dynamic.positions[`base:${CA}`].exitExperiment.version,'volume_structure_exit_v1');
});

test('confirmed structure exits freeze new version and accounting while future/stale/wrong-CA data cannot sell',()=>{
  let main=advancePaperStrategyAccount(createPaperStrategyAccount({nowMs:NOW}),{...modes,memeExitMode:true,evaluations:[entry()],nowMs:NOW});
  main=advancePaperStrategyAccount(main,{marks:[mark()],nowMs:NOW+180000});
  assert.equal(main.trades.at(-1).exitEvidence.exitPolicyVersion,MEME_EXIT_VERSION);
  assert.equal(main.trades.at(-1).exitEvidence.activeStopPrice,null);assert.ok(main.trades.at(-1).costsUsd>0);
  assert.equal(traderReview(completedPaperRounds(main.trades),NOW+180000).cohorts[0].exitVersion,MEME_EXIT_VERSION);
  for(const change of [m=>m.observedAt=iso(NOW+190000),m=>m.address=`0x${'b'.repeat(40)}`,m=>m.structureChart.chain='bsc',m=>m.structureChart.rows.splice(5,1),m=>m.observedAt=iso(NOW+160000)]){
    const m=mark();change(m);assert.equal(assessMemeExit(pos(),m,NOW+180000).exit,false);
  }
});

test('quiet pullback with verified buying is observed, heavy breakdown is not waived by buy labels',()=>{
  const m=mark(NOW+180000,[.99,.98,.96],50);m.flow=flow(NOW+180000,[wallet(1,300,0),wallet(2,300,0)]);
  const d=assessMemeExit(pos(),m,NOW+180000);assert.equal(d.exit,false);assert.equal(d.status,'supported_pullback');
  assert.match(d.operator.summary,/未核实/);
  m.structureChart.rows.at(-1).volume=200;assert.equal(assessMemeExit(pos(),m,NOW+180000).exit,true);
  m.structureChart.rows.at(-1).volume=50;m.flow.complete=false;
  assert.equal(assessMemeExit(pos(),m,NOW+180000).exit,true,'known persistent breakdown remains actionable, missing data cannot rescue it');
  m.flow.complete=true;m.flow.wallets.forEach(w=>w.lastBuyAt=NOW-1000);
  assert.equal(assessMemeExit(pos(),m,NOW+180000).exit,true,'pre-entry buys cannot be described as fresh absorption');
});

test('continued selling needs new sell amounts from two same-source addresses, not advancing timestamps',()=>{
  const p=pos(),m={...quote(NOW+1000),flow:flow()};
  let d=assessMemeExit(p,m,NOW+1000);assert.equal(d.flowWatch.count,1);p.thesisFlowWatch=d.flowWatch;
  m.observedAt=iso(NOW+32000);m.flow.observedAt=m.observedAt;
  d=assessMemeExit(p,m,NOW+32000);assert.equal(d.exit,false);assert.equal(d.flowWatch.count,1);
  m.flow=flow(NOW+32000,[wallet(1,0,250),wallet(2,0,250)]);
  d=assessMemeExit(p,m,NOW+32000);assert.equal(d.exit,true);assert.equal(d.flow.confirmed,true);
  const delayed=structuredClone(m);delayed.flow.wallets.forEach(w=>w.lastSellAt=NOW);
  assert.equal(assessMemeExit(p,delayed,NOW+32000).exit,false,'late-arriving old sales do not establish continued post-observation selling');
  for(const change of [f=>f.complete=false,f=>f.provider='binance_smartmoney',f=>f.coverageGap='gap',f=>f.wallets.push(f.wallets[0]),f=>f.observedAt=iso(NOW+33000),f=>f.observedAt=iso(NOW)]){
    const bad=structuredClone(m);change(bad.flow);assert.equal(assessMemeExit(p,bad,NOW+32000).exit,false);
  }
  const rotating={...m,flow:flow(NOW+32000,[wallet(3,0,300),wallet(4,0,300)])};
  assert.equal(assessMemeExit(p,rotating,NOW+32000).exit,false,'unrelated wallets do not prove continued selling by the same group');
});

test('Binance smartmoney source has no tags; KOL does not become smart money and cohort silence is unknown',()=>{
  const rows=[wallet(1,300,0),wallet(2,300,0)].map(({tags,...w})=>w);
  const f={...flow(NOW,rows),provider:'binance_smartmoney'};
  const context=memeEntryContext(token,{flow:f},NOW);
  assert.equal(context.smartBuyers.length,2);assert.equal(context.cohortKnown,true);
  assert.equal(memeEntryContext(token,{flow:{...f,provider:'binance_kol'}},NOW).smartBuyers.length,0);
  const p=pos();p.entryEvidence.flowDiagnostics.provider='binance_smartmoney';p.entryEvidence.memeExitContext=context;
  const m={...quote(NOW+1000),flow:{...flow(NOW+1000,[]),provider:'binance_smartmoney'}};
  const d=assessMemeExit(p,m,NOW+1000);assert.equal(d.flow.usable,true);assert.match(d.flow.summary,/不能证明未减仓/);
});

test('narrative followups require authenticated bound original sources; denial words alone cannot sell',()=>{
  const p=pos(),m={...quote(NOW+1000),narrative:{caBound:true,sources:[{chain:'base',tokenAddress:CA,sourceAuthenticated:true,
    sourceKind:'authenticated_call',sourceUrl:'https://example.com/call/1',sourceId:'one',sourceAt:iso(NOW+500),authorKey:'author',
    sourceText:'AI agent mainnet launched with new community integration and a product roadmap.'}]}};
  let d=assessMemeExit(p,m,NOW+1000);assert.equal(d.narrative.state,'出现后续原文');assert.equal(d.exit,false);
  m.narrative.sources[0].sourceText='AI mainnet cancelled, fake project launch denied by another account.';
  d=assessMemeExit(p,m,NOW+1000);assert.equal(d.narrative.state,'待复核');assert.equal(d.exit,false);
  m.narrative.sources[0].sourceAuthenticated=false;
  assert.equal(assessMemeExit(p,m,NOW+1000).narrative.followups.length,0);
  const html=renderStrategyDetails({},null,{...p,thesisStatus:{...d,narrative:{summary:'<img src=x>',followups:[{sourceUrl:'javascript:bad',text:'<script>'}]}}});
  assert.ok(!html.includes('<img'));assert.ok(!html.includes('javascript:'));assert.match(html,/无固定百分比/);assert.ok(!html.includes('当前止损线'));
});

test('holder concentration is a bound fresh observation, never proof of a sell or common controller',()=>{
  const p=pos();p.entryEvidence.safety={metrics:{top10HolderRate:.2}};
  const m={...quote(NOW+1000),holderSnapshot:{...token,observedAt:iso(NOW+500),top10HolderRate:.4}};
  let d=assessMemeExit(p,m,NOW+1000);
  assert.equal(d.operator.holders.rows[0].delta,.2);assert.equal(d.exit,false);assert.equal(d.operator.status,'unverified');
  m.holderSnapshot.chain='bsc';assert.equal(assessMemeExit(p,m,NOW+1000).operator.holders.available,false);
});

test('runtime persists activation and main policy through restart, prioritizes holding charts, keeps 100-fill count',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yesp-meme-exit-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let now=NOW,price=1.028;const chartCalls=[];
  const market={trending:async()=>({status:'ok',observedAt:iso(now),tokens:[token]}),trenches:async()=>({status:'ok',observedAt:iso(now),tokens:[]}),
    kline:async args=>{chartCalls.push(args);return {...args,status:'ok',candles:candles()};},quote:async args=>({...args,status:'ok',price,observedAt:iso(now)})};
  const options={...modes,memeExitMode:true,tradeReviewEvery:100,dataDir,chain:'base',chains:['base'],market,now:()=>now,fixedEntryUsd:10,evidenceLoader:()=>({})};
  let stored;const runtime=createPaperStrategyRuntime(options);
  try{
    await runtime.runOnce();await runtime.runOnce();await runtime.refreshQuote();now+=4000;price=1.03;await runtime.refreshQuote();await runtime.runOnce();
    let s=runtime.snapshot();assert.equal(s.account.trades.length,1);assert.equal(s.mainExitPolicy.version,MEME_EXIT_VERSION);assert.equal(s.tradeCountReview.pendingFills,1);
    assert.equal(s.account.positions[`base:${CA}`].memeExitPolicy.version,MEME_EXIT_VERSION);
    now+=61000;price=.8;await runtime.runOnce();assert.equal(chartCalls.at(-1).purpose,'exit');
    await runtime.refreshQuote();await runtime.exitOnce();assert.equal(runtime.snapshot().account.trades.length,1);
    await runtime.setEnabled(false);stored=JSON.parse(await fs.readFile(runtime.stateFile,'utf8'));
  }finally{await runtime.stop();}
  now+=1000;const resumed=createPaperStrategyRuntime(options);
  try{
    await resumed.runOnce();const s=resumed.snapshot();assert.deepEqual(s.account.trades,stored.account.trades);
    assert.deepEqual(s.account.memeExitActivation,stored.account.memeExitActivation);assert.equal(s.tradeCountReview.pendingFills,1);
    assert.equal(s.enabled,false);assert.equal(s.execution,false);assert.equal(s.signing,false);assert.equal(s.broadcast,false);
  }finally{await resumed.stop();}
});
