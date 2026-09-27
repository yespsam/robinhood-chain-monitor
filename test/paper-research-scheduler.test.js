import test from 'node:test';
import assert from 'node:assert/strict';
import {planHotResearch,selectResearchChart,selectQuoteCandidate,selectQuoteTarget,chartRefreshDue,advanceEntryFocus} from '../src/paper-research-scheduler.js';
import {createReviewComparison,validateReviewComparison,reviewComparisonSummary} from '../src/paper-review-comparison.js';
import {createPaperStrategyAccount} from '../src/paper-strategy-engine.js';
const NOW=Date.parse('2026-09-24T05:00:00Z');
const row=(chain,id,ready=false)=>({input:{token:{chain,address:String(id),volume:1000}},decisions:[{evidence:{opportunityRoutes:[{basis:'ohlcv',signalReady:ready}]}}]});
test('main external research is not starved by the legacy 5% estimate before chart economics exist',()=>{
  const main=row('bsc','taxed');main.input.memeExitMode=true;
  main.decisions[0].evidence.costAssumptions={estimatedRoundTripCostRate:.06224};
  assert.equal(planHotResearch([main],['bsc'],new Map(),NOW)[0],main);
  const legacy=structuredClone(main);legacy.input.memeExitMode=false;
  assert.deepEqual(planHotResearch([legacy],['bsc'],new Map(),NOW),[]);
  main.decisions[0].evidence.costAssumptions.estimatedRoundTripCostRate=.151;
  assert.deepEqual(planHotResearch([main],['bsc'],new Map(),NOW),[]);
  main.decisions[0].evidence.costAssumptions.estimatedRoundTripCostRate=.06224;
  main.decisions[0].evidence.safety={blocked:['存在貔貅标记']};
  assert.deepEqual(planHotResearch([main],['bsc'],new Map(),NOW),[]);
});
test('main unseen hotspot survives score churn until one bounded chart attempt finishes',()=>{
  const unseen=row('bsc','new'),ready=row('bsc','known',true);
  unseen.input.memeExitMode=true;ready.input.memeExitMode=true;
  const charts=new Map([['bsc:known',{status:'ok',fetchedAt:NOW}]]);
  assert.equal(planHotResearch([unseen,ready],['bsc'],charts,NOW,['bsc:new'])[0],unseen);
  for(const status of ['ok','unavailable']){
    charts.set('bsc:new',{status,fetchedAt:NOW});
    assert.equal(planHotResearch([unseen,ready],['bsc'],charts,NOW,['bsc:new'])[0],ready,'one finished attempt releases the seat');
  }
  charts.delete('bsc:new');unseen.decisions[0].evidence.safety={blocked:['honeypot']};
  assert.equal(planHotResearch([unseen,ready],['bsc'],charts,NOW,['bsc:new'])[0],ready);
  assert.equal(planHotResearch([ready],['bsc'],charts,NOW,['bsc:new'])[0],ready,'no dangling reservation');
});
test('main-ready quote candidates preempt comparison leases and cannot be overwritten by duplicate control rows',()=>{
  const main={...row('base','a'),candidateBook:'main'},control={...row('base','a'),candidateBook:'comparison'},other={...row('bsc','b'),candidateBook:'comparison'};
  const options={windowMs:45000,mainFirst:true};
  const previous=selectQuoteCandidate([other],null,NOW,options);
  const selected=selectQuoteCandidate([other,main,control],previous.lease,NOW+1000,options);
  assert.equal(selected.row,main);
  assert.equal(selected.lease.candidateBook,'main');
  const fallback=selectQuoteCandidate([other,control],selected.lease,NOW+2000,options);
  assert.equal(fallback.lease.candidateBook,'comparison');
  const mainHeld={...main,input:{...main.input,opportunityAccount:{positions:{'base:a':{}}}}};
  assert.equal(selectQuoteCandidate([mainHeld,control],null,NOW,options).row,control,'each account uses its own holdings');
});
test('evidence-exit focus tolerates a slow first quote but never renews indefinitely or removes discovery',()=>{
  const a=row('base','a'),b=row('base','b'),options={windowMs:45000};
  const focus=advanceEntryFocus(null,a.input.token,NOW,options);
  assert.equal(advanceEntryFocus(focus,a.input.token,NOW+22000,options).active,true);
  assert.equal(advanceEntryFocus(focus,a.input.token,NOW+45000,options).active,false);
  assert.equal(advanceEntryFocus(focus,b.input.token,NOW+54000,options).active,false);
  assert.equal(advanceEntryFocus(focus,b.input.token,NOW+55000,options).active,true);
  let lease=selectQuoteCandidate([a,b],null,NOW,options);
  assert.equal(selectQuoteCandidate([a,b],lease.lease,NOW+22000,options).row,a);
  assert.equal(selectQuoteCandidate([a,b],lease.lease,NOW+45000,options).row,b);
  assert.equal(selectQuoteCandidate([b],lease.lease,NOW+1000,options).row,b,'lost eligibility releases the lease');
});
test('entry focus expires after twenty seconds and leaves ten seconds for discovery even when candidates churn',()=>{
  const a=row('base','a').input.token,b=row('base','b').input.token;
  const first=advanceEntryFocus(null,a,NOW);
  assert.equal(first.key,'base:a');assert.equal(first.active,true);
  assert.equal(first.until,NOW+20000);assert.equal(first.nextAllowedAt,NOW+30000);
  assert.deepEqual(advanceEntryFocus(first,a,NOW+19000),first,'ticks cannot renew a window');
  const changed=advanceEntryFocus(first,b,NOW+1000);
  assert.equal(changed.active,false,'changing candidates cannot extend or transfer a window');
  assert.equal(advanceEntryFocus(changed,b,NOW+29000).active,false);
  assert.equal(advanceEntryFocus(first,a,NOW+20000).active,false);
  assert.equal(advanceEntryFocus(first,null,NOW+1).active,false,'eligibility loss releases focus immediately');
  assert.equal(advanceEntryFocus(changed,b,NOW+30000).key,'base:b');
});
test('focused candidate gets due candles before discovery; holdings still win and fresh candles are not duplicated',()=>{
  const a=row('base','a'),b=row('bsc','b'),c=row('base','cold');
  const params={holdings:[],hot:[a,b],broad:[a,b,c],charts:new Map(),nowMs:NOW,dispatch:2,chains:['base','bsc'],focus:a.input.token};
  assert.equal(selectResearchChart(params)?.address,'a');
  assert.equal(selectResearchChart(params)?.researchLane,'entry');
  assert.equal(selectResearchChart({...params,focus:{...a.input.token,requiresStructureChart:false}}),undefined,
    'a flow-only internal setup does not spend its focus window on unused candles');
  const held={chain:'base',address:'held',requiresStructureChart:true};
  assert.equal(selectResearchChart({...params,holdings:[held]})?.address,'held');
  params.charts.set('base:a',{status:'ok',fetchedAt:NOW,closedThroughAtMs:NOW});
  assert.equal(selectResearchChart(params),undefined,'unrelated chart work yields during the bounded focus window');
  assert.equal(selectResearchChart({...params,focus:null})?.address,'cold','normal discovery resumes immediately after focus');
});
test('parallel chart selection excludes in-flight assets without losing holding priority',()=>{
  const a=row('base','a'),b=row('bsc','b');
  const params={holdings:[],hot:[a,b],broad:[a,b],charts:new Map(),nowMs:NOW,dispatch:0,chains:['base','bsc'],pendingKeys:new Set(['base:a'])};
  assert.equal(selectResearchChart(params).address,'b');
  assert.equal(selectResearchChart({...params,pendingKeys:new Set(['base:a','bsc:b'])}),undefined);
  assert.equal(selectResearchChart({...params,holdings:[{chain:'base',address:'held',requiresStructureChart:true}]}).researchLane,'holding');
});
test('hundreds of discoveries get only one hot seat per chain and real ready setups win',()=>{
  const rows=Array.from({length:200},(_,i)=>row(i%2?'base':'bsc',i,i===7));
  const hot=planHotResearch(rows,['base','bsc'],new Map(),NOW,[]);
  assert.equal(hot.length,2);assert.equal(hot[0].input.token.address,'7');assert.equal(hot[1].input.token.chain,'bsc');
});
test('known expensive tokens and checked non-setups cannot monopolize the hot seats',()=>{
  const expensive=row('eth','expensive',true),cold=row('base','cold'),checked=row('base','checked');
  expensive.decisions[0].evidence.costAssumptions={estimatedRoundTripCostRate:.43};
  checked.decisions[0].evidence.opportunityRoutes[0].pattern={ready:false};
  checked.input.token.volume=1e9;
  const charts=new Map([['base:checked',{status:'ok',fetchedAt:NOW,candles:[{high:10,low:1}]}]]);
  assert.deepEqual(planHotResearch([expensive,checked,cold],['eth','base'],charts,NOW,['base:checked']).map(r=>r.input.token.address),['cold']);
  checked.decisions[0].evidence.opportunityRoutes[0].signalReady=true;
  assert.equal(planHotResearch([checked,cold],['base'],charts,NOW)[0].input.token.address,'checked');
});
test('slow held quotes do not starve candidates; stale or failed holdings still have priority',()=>{
  const held={chain:'base',address:'held',purpose:'exit'},candidate={chain:'base',address:'candidate',purpose:'candidate'};
  const quotes=new Map(),attempts=new Map(),sequence=[];
  for(let i=0;i<8;i++) {
    const now=NOW+i*4000,target=selectQuoteTarget([held,candidate],quotes,attempts,now);
    sequence.push(target.purpose);attempts.set(`base:${target.address}`,now);
    quotes.set(`base:${target.address}`,{...target,status:'ok',price:1,observedAt:new Date(now).toISOString()});
  }
  assert.deepEqual(sequence,['exit','candidate','exit','candidate','exit','candidate','exit','candidate']);
  const late=NOW+40000;
  assert.equal(selectQuoteTarget([held,candidate],quotes,attempts,late).purpose,'exit');
  quotes.set('base:held',{...held,status:'unavailable',observedAt:new Date(late).toISOString()});
  assert.equal(selectQuoteTarget([held,candidate],quotes,attempts,late).purpose,'exit');
});
test('holding chart comes first, hot refreshes are bounded and cold discovery keeps a slot',()=>{
  const a=row('base','a'),b=row('bsc','b'),c=row('base','c'),d=row('bsc','d');
  const charts=new Map(),params={hot:[a,b],broad:[a,b,c,d],charts,nowMs:NOW,dispatch:0,chains:['base','bsc']};
  const holding={chain:'base',address:'held',pvpPolicy:{version:'structure_hold_v2'}};
  assert.equal(selectResearchChart({...params,holdings:[holding]}).researchLane,'holding');
  charts.set('base:held',{fetchedAt:NOW});
  assert.equal(selectResearchChart({...params,holdings:[holding]}).researchLane,'hot');
  assert.equal(selectResearchChart({...params,holdings:[],dispatch:2}).address,'c');
  assert.equal(selectResearchChart({...params,holdings:[],dispatch:5}).address,'d');
  charts.set('base:a',{fetchedAt:NOW});charts.set('bsc:b',{fetchedAt:NOW});
  assert.equal(selectResearchChart({...params,holdings:[]}).researchLane,'discovery');
});
test('late-response chart refresh is due when its closed evidence expires inside the cache TTL',()=>{
  const a=row('base','late'),charts=new Map([['base:late',{status:'ok',fetchedAt:NOW+59000,closedThroughAtMs:NOW}]]);
  const params={holdings:[],hot:[],broad:[a],charts,dispatch:0,chains:['base']};
  assert.equal(selectResearchChart({...params,nowMs:NOW+90000}),undefined,'90 seconds remains valid');
  assert.equal(selectResearchChart({...params,nowMs:NOW+90001})?.address,'late','must not wait another 29 seconds after evidence expires');
  charts.set('base:late',{status:'unavailable',fetchedAt:NOW+59000,closedThroughAtMs:NOW});
  assert.equal(selectResearchChart({...params,nowMs:NOW+90001}),undefined,'failed responses retain normal retry backoff');
  charts.set('base:late',{status:'ok',fetchedAt:NOW+91000,closedThroughAtMs:NOW+60000});
  assert.equal(selectResearchChart({...params,nowMs:NOW+92000}),undefined,'a renewed request boundary prevents a tight refresh loop');
});
test('quote lease survives clock boundaries and rotates fairly across three candidates',()=>{
  const rows=[row('base','a'),row('base','b'),row('base','c')];
  let result=selectQuoteCandidate(rows,null,NOW+29000);assert.equal(result.row.input.token.address,'a');
  result=selectQuoteCandidate(rows,result.lease,NOW+31000);assert.equal(result.row.input.token.address,'a');
  result=selectQuoteCandidate(rows,result.lease,NOW+50000);assert.equal(result.row.input.token.address,'b');
  result=selectQuoteCandidate(rows,result.lease,NOW+71000);assert.equal(result.row.input.token.address,'c');
  result=selectQuoteCandidate(rows,result.lease,NOW+92000);assert.equal(result.row.input.token.address,'a');
  assert.equal(selectQuoteCandidate([],result.lease,NOW+93000).row,null);
});

test('active charts refresh at the next closed minute before expiry, without retry storms or changing cold backoff',()=>{
  const hot=row('base','hot'),cold=row('base','cold');
  const cached={status:'ok',fetchedAt:NOW+59000,closedThroughAtMs:NOW};
  const charts=new Map([['base:hot',cached],['base:cold',cached]]);
  const params={holdings:[],hot:[hot],broad:[hot,cold],charts,dispatch:0,chains:['base'],nowMs:NOW+64000};
  assert.equal(chartRefreshDue(cached,NOW+64000,{active:true}),true);
  assert.equal(chartRefreshDue(cached,NOW+64000),false,'cold cache retains its original TTL');
  assert.equal(selectResearchChart(params)?.address,'hot','refresh while old evidence is still valid, not after 90 seconds');
  assert.equal(selectResearchChart({...params,nowMs:NOW+61000}),undefined,'late responses keep a five-second minimum retry gap');
  const renewed={...cached,fetchedAt:NOW+64000,closedThroughAtMs:NOW+60000};
  charts.set('base:hot',renewed);
  assert.equal(selectResearchChart({...params,nowMs:NOW+70000}),undefined,'same close boundary is not repeatedly requested');
  charts.set('base:hot',{...cached,status:'unavailable'});
  assert.equal(selectResearchChart(params),undefined,'failed sources retain 60-second backoff');
  charts.set('base:hot',cached);charts.delete('base:cold');
  assert.equal(selectResearchChart({...params,dispatch:2})?.address,'cold','discovery still owns every third non-holding slot');
});

test('a previous non-setup can reclaim a hot seat when the next closed minute needs research',()=>{
  const checked=row('base','checked'),cold=row('base','cold');
  checked.decisions[0].evidence.opportunityRoutes[0].pattern={ready:false};
  const charts=new Map([['base:checked',{status:'ok',fetchedAt:NOW+59000,closedThroughAtMs:NOW,candles:[{high:10,low:1}]}]]);
  assert.equal(planHotResearch([checked,cold],['base'],charts,NOW+61000)[0].input.token.address,'cold','the known non-setup still yields during the retry gap');
  assert.equal(planHotResearch([checked,cold],['base'],charts,NOW+64000)[0].input.token.address,'checked','new closed evidence is not demoted using the stale 60-second cache test');
});

test('unseen hotspot churn on an earlier chain cannot starve other chains',()=>{
  const chains=['robinhood','sol','bsc','base','eth'],charts=new Map(),seen=[];let lastHotChain=null;
  for(let i=0;i<10;i++){
    const hot=chains.map(chain=>row(chain,`${chain}-${i}`));
    const target=selectResearchChart({holdings:[],hot,broad:hot,charts,nowMs:NOW+i*6000,dispatch:i,chains,lastHotChain});
    seen.push(target.chain);lastHotChain=target.chain;
    charts.set(`${target.chain}:${target.address}`,{status:'ok',fetchedAt:NOW+i*6000,closedThroughAtMs:NOW});
  }
  assert.deepEqual(seen,[...chains,...chains]);
});
test('forward control is a copy of existing capital and losses, not a new 100 dollar deposit',()=>{
  const account=createPaperStrategyAccount({nowMs:NOW});account.cash=92;account.realizedPnl=-8;account.stats.equity=92;
  const comparison=createReviewComparison(account,NOW);validateReviewComparison(comparison);
  assert.equal(comparison.control.cash,92);assert.equal(comparison.control.realizedPnl,-8);
  comparison.control.cash=91;comparison.control.realizedPnl=-9;comparison.control.stats.equity=91;
  validateReviewComparison(comparison);assert.equal(account.cash,92);
  const summary=reviewComparisonSummary(comparison,account);assert.equal(summary.main.equityChange,0);assert.equal(summary.control.equityChange,-1);
  assert.equal(reviewComparisonSummary(JSON.parse(JSON.stringify(comparison)),account).startedAt,comparison.startedAt);
  assert.throws(()=>validateReviewComparison({...comparison,baselineEquity:null}));
});

test('review metrics count complete new rounds, not partial exits or old positions',()=>{
  const account=createPaperStrategyAccount({nowMs:NOW}),comparison=createReviewComparison(account,NOW);
  const buy=(address,atMs)=>({chain:'base',address,side:'buy',quantity:10,atMs,entryEvidence:{opportunity:{id:'external_breakout'}}});
  const sell=(address,atMs,quantity,realizedPnl)=>({chain:'base',address,side:'sell',quantity,realizedPnl,atMs});
  account.trades=[buy('a',NOW),sell('a',NOW+1000,2,1),sell('a',NOW+2000,8,3),
    buy('b',NOW+3000),sell('b',NOW+5000,10,-2),buy('c',NOW+6000),sell('c',NOW+7000,2,1)];
  const result=reviewComparisonSummary(comparison,account).main;
  assert.equal(result.entries,3);assert.equal(result.closedRounds,2);assert.equal(result.newRoundPnl,2);
  assert.deepEqual(result.routeResults,[{route:'external_breakout',closedRounds:2,wins:1,losses:1,netPnl:2,
    winRate:.5,averageWin:4,averageLoss:2,profitFactor:2,averageHoldMs:2000}]);
  assert.deepEqual(reviewComparisonSummary(comparison,comparison.control).control.routeResults,[]);
});
