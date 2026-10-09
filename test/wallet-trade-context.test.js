import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceWalletContext,validWalletContext,walletContextReport,walletTradeChartContext,selectWalletChartTarget} from '../src/wallet-trade-context.js';
import {analyzeWalletHabits} from '../src/wallet-learning.js';
import {renderWalletTradeLearning} from '../dashboard/wallet-learning.js';
import {NOW,teacher,row,address} from './fixtures/wallet-learning.js';
const M=60000;
const buy=()=>row(1,'buy',{at:NOW-5*M}),sell=()=>row(2,'sell',{at:NOW-M,quantity:5,usd:7.5,price:1.5});
const wallet=()=>({...teacher(),rows:[buy(),sell()]});
const chart=(action=buy())=>({chain:action.chain,address:action.token,status:'ok',resolution:'1m',fetchedAt:NOW,closedThroughAtMs:NOW,
  candles:Array.from({length:5},(_,i)=>({time:action.at-(5-i)*M,open:1.2,high:2,low:.9,close:1.2,volume:100}))});
const doc=(extra={})=>({url:'https://x.com/example/status/100',sourceAt:NOW-6*M,firstSeenAt:NOW-6*M,text:'A community event',author:'example',categories:[],
  candidates:[{chain:'robinhood',address:address(100),binding:'direct_ca',firstSeenAt:NOW-6*M}],...extra});
const run=(prior=null,args={})=>advanceWalletContext(prior,{wallets:[wallet()],charts:[chart()],documents:[doc()],nowMs:NOW,...args});

test('FIFO actions expose actual basis and inventory fractions but no presumed motive',()=>{
  const h=analyzeWalletHabits(wallet().rows);assert.equal(h.actions.length,2);
  const a=h.actions.find(a=>a.side==='sell');assert.equal(a.soldFraction,.5);assert.equal(a.averageBuyPrice,1);
  assert.equal(a.matchedCostUsd,5);assert.equal(a.grossReturn,.5);assert.equal(a.holdMs,4*M);
  assert.equal(a.positionAction,'partial_exit');assert.equal(h.actions[0].positionAction,'observed_entry');
  const adds=analyzeWalletHabits([buy(),row(3,'buy',{at:NOW-4*M,usd:12,price:1.2})]);
  assert.equal(adds.actions[1].positionAction,'add');assert.ok(Math.abs(adds.actions[1].addPriceChange-.2)<1e-9);
});
test('records prices, gains AND losses; linking a story never gives buy authority',()=>{
  const a=run();assert.equal(a.report.cases,2);assert.equal(a.report.observed.narrativeContexts,2);
  assert.equal(a.report.observed.winningExits,1);assert.equal(a.report.autoTradingChanges,false);
  assert.equal(a.memory.cases[0].narratives[0].walletAwareness,'unknown');assert.equal(validWalletContext(a.memory),true);
  const w=wallet();w.rows[1]={...sell(),price:.5,usd:2.5};const loss=run(null,{wallets:[w]});
  assert.equal(loss.report.observed.losingExits,1);assert.equal(loss.memory.cases[0].grossReturn,-.5);
});
test('buy and sell positions use only contiguous PRE-trade closed bars, never later ATH',()=>{
  const good=walletTradeChartContext(buy(),chart(),NOW);assert.equal(good.kind,'deep_pullback');
  assert.equal(good.knowledge,'retrospective');assert.equal(good.windowEnd,buy().at);
  const future=chart();future.candles.push({time:buy().at,open:1,high:1000,low:1,close:1000,volume:1e9});
  assert.equal(walletTradeChartContext(buy(),future,NOW).priorHigh,2);
  for(const c of [{...chart(),chain:'eth'},{...chart(),address:address(999)},{...chart(),status:'error'},
    {...chart(),resolution:'5m'},{...chart(),fetchedAt:NOW+1},{...chart(),closedThroughAtMs:buy().at-M},
    {...chart(),candles:chart().candles.filter((_,i)=>i!==2)}])assert.equal(walletTradeChartContext(buy(),c,NOW),null);
  const breakthrough={...buy(),price:2.1};assert.equal(walletTradeChartContext(breakthrough,chart(),NOW).kind,'above_prior_high');
});
test('future posts, name guesses and foreign chains cannot explain prior transactions',()=>{
  for(const d of [doc({sourceAt:NOW+1}),doc({firstSeenAt:NOW+1}),doc({conflicted:true}),
    doc({candidates:[{chain:'eth',address:address(100),binding:'direct_ca'}]}),
    doc({candidates:[{chain:'robinhood',address:address(100),binding:'name_tag_hypothesis'}]})])assert.equal(run(null,{documents:[d]}).report.observed.narrativeContexts,0);
  const retro=run(null,{documents:[doc({firstSeenAt:NOW})]});assert.equal(retro.memory.cases[0].narratives[0].knowledge,'retrospective');
  const later=run(null,{documents:[doc({sourceAt:NOW-2*M,firstSeenAt:NOW-2*M})]});
  assert.equal(later.memory.cases.find(c=>c.side==='buy').narratives.length,0);assert.equal(later.memory.cases.find(c=>c.side==='sell').narratives.length,1);
});
test('history gaps, transfers, revised lot costs and missing inventory quarantine previously retained cases',()=>{
  const a=run(),before=JSON.stringify(a.memory);
  const gap=run(a.memory,{wallets:[{...wallet(),historyGap:true}]});assert.equal(gap.report.quarantined,2);assert.equal(gap.report.observed.cases,0);
  assert.equal(JSON.stringify(a.memory),before);assert.equal(run(gap.memory).report.observed.cases,2);
  const transfer={...row(3,'buy',{at:NOW-2*M}),side:'unattributable',quantity:null,usd:null,price:null};
  const bad=run(a.memory,{wallets:[{...wallet(),rows:[buy(),transfer,sell()]}]});assert.equal(bad.report.quarantined,2);
  const revised=run(a.memory,{wallets:[{...wallet(),rows:[{...buy(),price:.5,usd:5},sell()]}]});
  assert.equal(revised.report.quarantined,2,'changed FIFO cost invalidates old sell evidence too');
});
test('restart is idempotent, context survives missing cache but contradictory source is removed',()=>{
  const a=run(),again=run(JSON.parse(JSON.stringify(a.memory)),{charts:[],documents:[],nowMs:NOW+M});
  assert.equal(again.report.cases,2);assert.equal(again.memory.cases[0].firstObservedAt,NOW);
  assert.equal(again.report.observed.narrativeContexts,2);
  const contradicted=run(again.memory,{documents:[doc({conflicted:true})],nowMs:NOW+M});assert.equal(contradicted.report.observed.narrativeContexts,0);
  const broken=structuredClone(a.memory);broken.cases=[null];assert.equal(validWalletContext(broken),false);
  assert.throws(()=>run(broken),/invalid/);assert.equal(walletContextReport(broken).status,'error');
});
test('newer missing charts may enrich later but cannot fabricate any pre-trade price path',()=>{
  const a=run(null,{charts:[],documents:[]});assert.equal(a.report.observed.chartContexts,0);
  const next=run(a.memory);assert.ok(next.report.observed.chartContexts>0);
  assert.equal(next.memory.cases.find(c=>c.side==='buy').chart.retrievedAt,NOW);
});
test('future transactions are ignored and only bounded newest actions are retained',()=>{
  const w=wallet();w.rows=[...w.rows,row(3,'buy',{at:NOW+1})];assert.equal(run(null,{wallets:[w]}).report.cases,2);
  const many={...wallet(),rows:Array.from({length:100},(_,i)=>row(i+1,'buy',{token:address(100+i),at:NOW-(100-i)*M}))};
  const result=run(null,{wallets:[many]});assert.equal(result.report.cases,20);
  assert.equal(run(result.memory,{wallets:[],nowMs:NOW+31*86400000}).report.cases,0);
});
test('Chinese view escapes tickers and text, explicitly labels missing evidence and retrospective data',()=>{
  const result=run(null,{charts:[],documents:[]});result.report.recent[0].symbol='<script>bad</script>';
  const html=renderWalletTradeLearning(result.report);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
  assert.match(html,/缺少成交前完整 K 线/);assert.match(html,/不证明该钱包读过消息/);assert.match(html,/FIFO 毛回报/);
});
test('historical chart targets bind the pre-trade window and limit retries, chains and sample quality',()=>{
  const w={...teacher(1,'bsc'),rows:wallet().rows.map(r=>({...r,chain:'bsc'}))};
  const state=run(null,{wallets:[w],charts:[],documents:[]}).memory;
  let t=selectWalletChartTarget(state,NOW);assert.equal(t.chain,'bsc');assert.equal(t.to*1000,sell().at);
  assert.equal(t.to-t.from,1800);assert.equal(t.latestClosed,false);assert.equal(t.purpose,'learning');
  state.cases.forEach(c=>{c.chartAttempts=1;c.chartAttemptAt=NOW;});assert.equal(selectWalletChartTarget(state,NOW),null);
  assert.ok(selectWalletChartTarget(state,NOW+6*3600000));
  state.cases.forEach(c=>c.chartAttempts=2);assert.equal(selectWalletChartTarget(state,NOW+7*3600000),null);
  assert.equal(selectWalletChartTarget(run().memory,NOW),null,'unsupported historical chain stays a documented gap');
});
