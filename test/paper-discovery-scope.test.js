import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {GMGN_THREE_LISTS,focusedMembership,focusedDiscoverySnapshot} from '../src/paper-discovery-scope.js';
import {createReadonlyMarketClient} from '../src/gmgn-readonly-market.js';
import {createPaperStrategyRuntime} from '../src/paper-strategy-runtime.js';
import {renderBrainTelemetry} from '../dashboard/brain-desk.js';
import {marketLeaderHint} from '../src/paper-hot-research.js';

const NOW=Date.parse('2026-10-04T09:40:00Z'),iso=t=>new Date(t).toISOString(),ca=n=>'0x'+String(n).repeat(40);
const token=(n,extra={})=>({chain:'bsc',address:ca(n),symbol:'同名',price:1,liquidity:60000,volume:100000,
  marketStage:'external',isHoneypot:false,isWashTrading:false,rugRatio:.01,buyTax:0,sellTax:0,
  top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,...extra});
const list=(tokens,extra={})=>({status:'ok',observedAt:iso(NOW),tokens,...extra});
async function directory(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'three-lists-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('membership includes near completion, dedups CA not symbol, never mixes minute and five-minute windows',()=>{
  const sources=[list([token(1,{volumeWindow:'5m'}),token(2,{volumeWindow:'5m'}),token(9,{volumeWindow:'1m'})],{interval:'5m'}),
    list([token(1,{marketCategory:'completed'}),token(3,{marketCategory:'new_creation'}),token(4,{marketCategory:'near_completion'})]),
    list([token(5,{volumeWindow:'1h'})],{interval:'1h'})];
  const m=focusedMembership(sources,'bsc',NOW);assert.equal(m.size,4);assert.equal(m.get('bsc:'+ca(1)).length,2);
  assert.ok(m.has('bsc:'+ca(2)),'same ticker is not same CA');
  const s=focusedDiscoverySnapshot(new Map([['bsc',sources]]),['bsc'],NOW);
  assert.equal(s.uniqueCandidates,4);assert.deepEqual(s.feeds.map(x=>x.count),[1,1,1,2]);
  for(const patch of [{status:'stale'},{observedAt:iso(NOW-120001)},{observedAt:iso(NOW+1)}])
    assert.equal(focusedMembership(sources.map(x=>({...x,...patch})),'bsc',NOW).size,0);
  assert.ok(focusedDiscoverySnapshot(new Map([['bsc',sources]]),['bsc'],NOW+120001).feeds.every(f=>f.status==='stale'&&f.count===0));
  assert.equal(focusedMembership(sources,'eth',NOW).size,0);
});

test('trenches requests only selected types; omitted unrequested category is valid, missing requested category is not',async()=>{
  let bad=false;const calls=[];
  const client=createReadonlyMarketClient({ttlMs:0,runner:async args=>{
    calls.push(args);return JSON.stringify({data:{new_creation:[{address:ca(1),price:1}],
      ...(bad?{}:{completed:[{address:ca(2),price:1}]}),pump:[{address:ca(3),price:1}]}});
  }});
  const q={chain:'bsc',types:['completed','new_creation']},a=await client.trenches(q);
  assert.equal(a.status,'ok');assert.deepEqual(Object.keys(a.categories),['new_creation','completed']);
  assert.equal(a.tokens.length,2);assert.ok(!calls[0].includes('near_completion'));
  assert.deepEqual(calls[0].filter((_,i)=>calls[0][i-1]==='--type'),['new_creation','completed']);
  bad=true;const b=await client.trenches(q);assert.equal(b.status,'stale');assert.equal(b.observedAt,a.observedAt);
  await assert.rejects(client.trenches({chain:'bsc',types:['new_creation','new_creation']}),/invalid/);
  const all=await client.trenches({chain:'bsc'});assert.equal(all.status,'unavailable','full and narrowed caches cannot alias');
});

test('focused runtime uses the same two requests with all three trenches stages; leaving lists removes cached candidates',async t=>{
  let clock=NOW,empty=false;const calls=[];
  const dir=await directory(t),newborn=token(1,{marketCategory:'new_creation',marketStage:'internal'}),open=token(2,{marketCategory:'completed'});
  const market={trending:async q=>{calls.push(['rank',q]);return list(empty?[]:[open,token(3)].map(t=>({...t,volumeWindow:'5m',rank:1})),{interval:q.interval,observedAt:iso(clock)});},
    trenches:async q=>{calls.push(['trenches',q]);return list(empty?[]:[newborn,open,token(4,{marketCategory:'near_completion'})],{observedAt:iso(clock)});},
    kline:async q=>{calls.push(['chart',q]);return {status:'unavailable',candles:[]};},
    quote:async q=>{calls.push(['quote',q]);return {...q,status:'unavailable'};},
    details:async q=>{calls.push(['details',q]);return {status:'ok',chain:q.chain,address:q.address,observedAt:iso(clock),token:token(Number(q.address.at(-1)))};}};
  const r=createPaperStrategyRuntime({dataDir:dir,chain:'bsc',chains:['bsc'],discoveryMode:GMGN_THREE_LISTS,
    market,now:()=>clock,evidenceLoader:()=>({}),confirmedMode:true,pvpMode:true,allowExploratory:true,
    opportunityMode:true,memeExitMode:true,evidenceHoldMode:true,continuousPaperMode:true});
  try {
    await r.setEnabled(false);await r.runOnce();await r.refreshDetails();
    const s=r.snapshot();assert.equal(s.discoveryScope.uniqueCandidates,4);
    assert.deepEqual([...new Set(s.evaluations.map(e=>e.token.address))].sort(),[ca(1),ca(2),ca(3),ca(4)]);
    assert.ok(calls.filter(x=>x[0]==='rank').every(x=>x[1].interval==='5m'));
    assert.ok(calls.filter(x=>x[0]==='trenches').every(x=>JSON.stringify(x[1].types)==='["new_creation","near_completion","completed"]'));
    empty=true;clock+=15000;await r.runOnce();const count=calls.length;
    await r.refreshDetails();await r.refreshQuote();await r.fastOnce();
    assert.equal(r.snapshot().evaluations.length,0,'old detail cannot recreate a delisted candidate');
    assert.equal(calls.length,count);assert.equal(r.snapshot().account.trades.length,0);
  }finally{await r.stop();}
});

test('focused two-feed loop is paced and single-flight; a stalled source cannot block the other on Plus',async t=>{
  const dir=await directory(t);await fs.writeFile(path.join(dir,'gmgn-readonly-plan.json'),JSON.stringify({version:1,plan:'plus'}));
  let clock=NOW,release;const calls=[];
  const r=createPaperStrategyRuntime({dataDir:dir,chain:'bsc',chains:['bsc'],discoveryMode:GMGN_THREE_LISTS,
    higherFrequencyResearch:true,confirmedMode:true,opportunityMode:true,pvpMode:true,allowExploratory:true,evidenceHoldMode:true,now:()=>clock,evidenceLoader:()=>({}),market:{
      quote:async()=>({status:'unavailable'}),
      trenches:q=>{calls.push(['trenches',q]);return new Promise(resolve=>{release=resolve;});},
      trending:async q=>{calls.push(['rank',q]);return list([],{interval:'5m',observedAt:iso(clock)});}}});
  const turn=()=>new Promise(resolve=>setImmediate(resolve));
  try{
    await r.setEnabled(false);const pending=r.refreshMarket({background:true});await turn();
    assert.deepEqual(calls.map(c=>c[0]),['trenches','rank']);
    for(let i=0;i<5;i++){clock+=1000;await r.refreshMarket({background:true});}
    assert.equal(calls.length,2);
    clock=NOW+15000;await r.refreshMarket({background:true});assert.equal(calls.length,3);assert.equal(calls.at(-1)[0],'rank');
    const stopping=r.stop();release(list([]));await pending;await stopping;
  }finally{release?.(list([]));await r.stop();}
});

test('five-minute ranking is a real research window, not minute volume or trade approval',()=>{
  const input={memeExitMode:true,marketStatus:'ok',observedAt:iso(NOW),token:token(1,{rank:1,volumeWindow:'5m',volume:50000})};
  const row={input,decisions:[{decision:'观察',evidence:{safety:{blocked:[]}}}]};
  assert.equal(marketLeaderHint(row,NOW).window,'5m');assert.equal(marketLeaderHint(row,NOW).researchOnly,true);
  input.token.volume=49999;assert.equal(marketLeaderHint(row,NOW),null);
  const html=renderBrainTelemetry({discoveryScope:focusedDiscoverySnapshot(new Map(),['bsc'],NOW)},true);
  assert.match(html,/战壕·新创建/);assert.match(html,/战壕·已开盘/);assert.match(html,/热门·5分钟/);
  assert.match(html,/统计窗口/);
});

test('focused research alternates one chart/detail producer while discovery stays independent',async t=>{
  const dir=await directory(t);await fs.writeFile(path.join(dir,'gmgn-readonly-plan.json'),JSON.stringify({version:1,plan:'plus'}));
  let clock=NOW,empty=false;const calls=[],pending=[];
  const wait=()=>new Promise(resolve=>setImmediate(resolve));
  const source=()=>list(empty?[]:[1,2,3].map(n=>token(n,{volumeWindow:'5m',rank:n,sellTax:null})),{interval:'5m',observedAt:iso(clock)});
  const market={trending:async q=>{calls.push(['rank',q]);return source();},
    trenches:async q=>{calls.push(['trenches',q]);return list([],{observedAt:iso(clock)});},
    kline:q=>{calls.push(['chart',q]);return new Promise(resolve=>pending.push(()=>resolve({...q,status:'unavailable',candles:[]})));},
    details:q=>{calls.push(['details',q]);return new Promise(resolve=>pending.push(()=>resolve({status:'unavailable'})));},
    quote:async q=>{assert.fail('missing sell tax must not request an entry quote');}};
  const r=createPaperStrategyRuntime({dataDir:dir,chain:'bsc',chains:['bsc'],discoveryMode:GMGN_THREE_LISTS,
    market,now:()=>clock,evidenceLoader:()=>({}),confirmedMode:true,pvpMode:true,allowExploratory:true,
    opportunityMode:true,memeExitMode:true,evidenceHoldMode:true,continuousPaperMode:true,
    higherFrequencyResearch:true,intervalMs:60000,marketIntervalMs:60000});
  try{
    await r.setEnabled(false);await r.refreshMarket();await r.start();await r.fastOnce();
    const count=kind=>calls.filter(c=>c[0]===kind).length;
    assert.equal(count('chart'),1);assert.equal(count('details'),0);
    assert.equal(calls.find(c=>c[0]==='chart')[1].purpose,'research');
    clock+=5000;await r.fastOnce();await r.refreshDetails();
    assert.equal(count('chart'),1);assert.equal(count('details'),0,'pending chart does not fan out info/security');
    clock+=10000;await r.refreshMarket({background:true});assert.equal(count('rank'),2);assert.equal(count('trenches'),2);
    pending.shift()();for(let i=0;i<5;i++)await wait();
    assert.equal(count('details'),1,'due details receive the turn after the chart');
    assert.equal(calls.find(c=>c[0]==='details')[1].purpose,'research');
    clock+=5000;await r.fastOnce();assert.equal(count('chart'),1,'pending detail prevents another exploratory chart');
    assert.equal(r.snapshot().researchPipeline.focusedReadBudget.exploratoryActive,1);
    pending.shift()();for(let i=0;i<5;i++)await wait();
    // Reproduce completion-event traffic arriving BEFORE the next full scan,
    // after the ordinary detail interval has elapsed. It cannot take turn two.
    clock+=6000;void r.refreshDetails();for(let i=0;i<3;i++)await wait();
    assert.equal(count('details'),1,'completion/event caller must leave the reserved chart turn free');
    await r.fastOnce();assert.equal(count('chart'),2,'charts resume after detail completion');
    empty=true;await r.refreshMarket();await r.fastOnce();
    pending.shift()();for(let i=0;i<5;i++)await wait();
    await r.refreshDetails();assert.equal(count('details'),1,'no persisted deferred queue can revive a delisted CA');
    assert.equal(r.snapshot().account.trades.length,0);
  }finally{const done=r.stop();for(const resolve of pending.splice(0))resolve();await done;}
});

test('focused incomplete detail responses back off while fresh listings and completed fields remain truthful',async t=>{
  const dir=await directory(t);let clock=NOW,calls=0,complete=false;
  const tok=()=>token(1,{marketCategory:'new_creation',marketStage:'internal',isWashTrading:null,rugRatio:null});
  const r=createPaperStrategyRuntime({dataDir:dir,chain:'bsc',chains:['bsc'],discoveryMode:GMGN_THREE_LISTS,
    now:()=>clock,evidenceLoader:()=>({}),confirmedMode:true,pvpMode:true,allowExploratory:true,
    opportunityMode:true,memeExitMode:true,evidenceHoldMode:true,continuousPaperMode:true,
    market:{trending:async()=>list([],{interval:'5m',observedAt:iso(clock)}),
      trenches:async()=>list([tok()],{observedAt:iso(clock)}),quote:async()=>({status:'unavailable'}),
      kline:async()=>({status:'unavailable',candles:[]}),details:async()=>{calls++;return {status:'ok',observedAt:iso(clock),
        token:complete?{...tok(),isWashTrading:false,rugRatio:0}:tok()};}}});
  try{
    await r.setEnabled(false);await r.runOnce();await r.refreshDetails();assert.equal(calls,1);
    clock+=60000;await r.runOnce();await r.refreshDetails();assert.equal(calls,2);
    clock+=60000;await r.runOnce();await r.refreshDetails();assert.equal(calls,2,'same missing fields now wait two minutes');
    assert.ok(r.snapshot().evaluations[0].missing.includes('洗量检测'),'backoff never fills missing safety evidence');
    complete=true;clock+=60000;await r.runOnce();await r.refreshDetails();assert.equal(calls,3);
    await r.fastOnce();assert.equal(r.snapshot().researchPipeline.focusedReadBudget.detailBackoffCandidates,0);
    assert.equal(r.snapshot().account.trades.length,0);
  }finally{await r.stop();}
});

test('focused hot deadlines defer ordinary details for one extra chart only, with no parallel producer or fills',async t=>{
  const dir=await directory(t);let clock=NOW,block=false,release=null;const calls=[];
  const turn=()=>new Promise(resolve=>setImmediate(resolve));
  const candles=()=>Array.from({length:60},(_,n)=>({time:Math.floor(clock/60000)*60000-(60-n)*60000,
    open:1,high:1.01,low:.99,close:1,volume:100}));
  const market={trending:async()=>list([1,2,3,4].map(n=>token(n,{rank:n,volumeWindow:'5m',sellTax:null})),{interval:'5m',observedAt:iso(clock)}),
    trenches:async()=>list([],{observedAt:iso(clock)}),quote:async()=>assert.fail('missing sell tax cannot request entry'),
    kline:async q=>{calls.push(['chart',q]);const result={...q,status:'ok',candles:candles(),observedAt:iso(clock)};
      if(block)await new Promise(resolve=>{release=resolve;});return result;},
    details:async q=>{calls.push(['details',q]);return {status:'unavailable'};}};
  const r=createPaperStrategyRuntime({dataDir:dir,chain:'bsc',chains:['bsc'],discoveryMode:GMGN_THREE_LISTS,
    market,now:()=>clock,evidenceLoader:()=>({}),confirmedMode:true,pvpMode:true,allowExploratory:true,
    opportunityMode:true,memeExitMode:true,evidenceHoldMode:true,continuousPaperMode:true,recoveryMode:true,lossRepairMode:true});
  try{
    await r.setEnabled(false);await r.runOnce();clock+=5000;await r.runOnce();await r.refreshDetails();
    const count=k=>calls.filter(c=>c[0]===k).length,before=count('details');
    clock=NOW+65000;await r.refreshMarket();block=true;await r.fastOnce();
    assert.ok(release,'due chart is dispatched');await r.refreshDetails();
    assert.equal(count('details'),before,'chart in flight cannot fan out ordinary details');
    release();release=null;for(let i=0;i<5;i++)await turn();
    await r.refreshDetails();assert.equal(count('details'),before,'another due hot chart gets the bounded next turn');
    clock+=5000;await r.fastOnce();assert.ok(release,'next chart is dispatched without increasing concurrency');
    release();release=null;for(let i=0;i<5;i++)await turn();
    await r.refreshDetails();assert.equal(count('details'),before+1,'after two charts details must resume');
    await r.fastOnce();const s=r.snapshot();assert.ok(s.researchPipeline.focusedReadBudget.hotDeadlineDeferrals>0);
    assert.ok(s.researchPipeline.hotCandidates.filter(x=>x.watchSince).length<=2);
    assert.equal(s.account.trades.length,0);assert.equal(s.execution,false);
    assert.equal(s.algorithmSignals.fullMarketTradesCovered,false);
  }finally{release?.();await r.stop();}
});
