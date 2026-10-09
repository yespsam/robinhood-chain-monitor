import test from 'node:test';
import assert from 'node:assert/strict';
import {marketLeaderHint,hotQuoteResearchReady,selectHotQuoteResearch,externalEntryCandles,advanceHotWatch,HOT_WATCH_MS} from '../src/paper-hot-research.js';
import {planHotResearch,selectResearchChart} from '../src/paper-research-scheduler.js';
const NOW=Date.parse('2026-10-04T07:34:00Z'), CA='0xd75a0cc8614b7c8cac56f5af39d73491c2ea7777';
const row=()=>({input:{memeExitMode:true,marketStatus:'ok',observedAt:new Date(NOW).toISOString(),
  token:{chain:'bsc',address:CA,symbol:'OFFLINE_躺赢',rank:3,volumeWindow:'1h',volume:1332510,liquidity:96000,marketStage:'external'}},
  decisions:[{decision:'观察',reasons:['均线尚未收复'],missing:['五秒内的独立报价'],evidence:{marketFresh:true,chart:{ready:true},
    safety:{blocked:[],missing:[]},costAssumptions:{accountingEligible:true},
    lossRepair:{entryPath:'external_structure',entryPathAllowed:true,reentry:{ready:true}},
    opportunityRoutes:[{basis:'ohlcv',signalReady:false,pattern:{ready:false}}]}}]});

test('two bounded watch seats survive a non-setup while the third rotates; clocks never slide',()=>{
  const rows=[1,2,3,4,5].map(n=>{const r=row();r.input.token.address='0x'+String(n).repeat(40);r.input.token.rank=20;return r;});
  const previous=rows.slice(0,3).map(r=>'bsc:'+r.input.token.address),watch=advanceHotWatch(new Map(),rows.slice(0,3),NOW);
  assert.equal(watch.size,2);
  const charts=new Map(previous.map(k=>[k,{status:'ok',fetchedAt:NOW,closedThroughAtMs:NOW,candles:[]}]));
  const choose=(rs,at)=>planHotResearch(rs,['bsc'],charts,at,previous,()=>0,{perChainLimit:3,maintainLeader:true,watchSince:watch});
  const hot=choose(rows,NOW+1);
  assert.deepEqual(hot.slice(0,2),rows.slice(0,2));assert.ok(hot.includes(rows[3]),'third seat discovers an unchecked candidate');
  assert.equal(advanceHotWatch(watch,hot,NOW+1000).get(previous[0]),NOW);
  for(const r of rows)r.input.observedAt=new Date(NOW+HOT_WATCH_MS).toISOString();
  const expired=choose(rows,NOW+HOT_WATCH_MS);
  assert.deepEqual(expired,planHotResearch(rows,['bsc'],charts,NOW+HOT_WATCH_MS,previous,()=>0,
    {perChainLimit:3,maintainLeader:true}),'expired seats rejoin ordinary ranking without artificial exclusion');
  rows[0].decisions[0].evidence.safety.blocked=['honeypot'];
  assert.ok(!choose(rows,NOW+HOT_WATCH_MS).includes(rows[0]));
  assert.ok(!choose(rows.slice(1),NOW+1000).includes(rows[0]),'delisting releases watch');
  assert.equal(advanceHotWatch(watch,rows,NOW+2*HOT_WATCH_MS+1).size,0,'stale market cannot retain watch');
  assert.equal(advanceHotWatch(new Map(),rows,NOW-1).size,0,'future sources are not watched');
});

test('a still-active market leader keeps one of three seats after a failed pattern check',()=>{
  const leader=row(),other=Array.from({length:20},(_,i)=>{const r=row();r.input.token={...r.input.token,address:'0x'+String(i).padStart(40,'0'),rank:20,volume:1000};return r;});
  const charts=new Map([['bsc:'+CA,{status:'ok',fetchedAt:NOW,closedThroughAtMs:NOW,candles:[]}]]);
  const before=structuredClone(leader),hot=planHotResearch([...other,leader],['bsc'],charts,NOW,[],()=>0,{perChainLimit:3});
  assert.equal(hot.length,3);assert.equal(hot[0],leader);assert.deepEqual(leader,before);
  const p={holdings:[],hot,broad:[leader,...other],charts,nowMs:NOW+60000,dispatch:1,chains:['bsc']};
  assert.equal(selectResearchChart(p).address,CA,'due leader beats endless never-requested charts');
  assert.equal(selectResearchChart({...p,dispatch:2}).researchLane,'discovery');
  assert.equal(selectResearchChart({...p,holdings:[{chain:'bsc',address:'held',holdingTier:'main',requiresStructureChart:true}]}).purpose,'exit');
  assert.notEqual(selectResearchChart({...p,pendingKeys:new Set(['bsc:'+CA])}).address,CA);
});

test('heat never renews stale data or exempts an unsafe/non-BSC/internal token',()=>{
  for(const mutate of [r=>r.input.observedAt=new Date(NOW-120001).toISOString(),r=>r.input.observedAt=new Date(NOW+1).toISOString(),
    r=>r.input.marketStatus='stale',r=>r.input.token.chain='sol',r=>r.input.token.rank=6,r=>r.input.token.volumeWindow='24h',
    r=>r.input.token.marketStage='internal',r=>r.input.token.stageConflict=true,r=>r.input.token.liquidity=0,
    r=>r.decisions[0].evidence.safety.blocked=['honeypot']]){const r=row();mutate(r);assert.equal(marketLeaderHint(r,NOW),null);}
});

test('top-volume seat rotates by evidence age so rank one cannot starve other leaders',()=>{
  const a=row(),b=row();b.input.token={...b.input.token,address:'0x'+'b'.repeat(40),rank:1};
  const charts=new Map([['bsc:'+b.input.token.address,{status:'ok',fetchedAt:NOW}]]);
  const pick=()=>planHotResearch([b,a],['bsc'],charts,NOW,[],()=>0,{perChainLimit:3})[0];
  assert.equal(pick(),a);charts.set('bsc:'+CA,{status:'ok',fetchedAt:NOW+1});assert.equal(pick(),b);
  const request={holdings:[],hot:[b,a],broad:[b,a],charts,nowMs:NOW+61000,dispatch:1,chains:['bsc'],pendingKeys:new Set(['bsc:'+b.input.token.address])};
  assert.equal(selectResearchChart(request).address,CA,'rank-one in flight cannot suppress another due leader');
});

test('fresh hourly popularity survives a weaker minute rank without borrowing its clock or CA',()=>{
  const r=row(),hourly={...r.input.token,observedAt:new Date(NOW-10000).toISOString(),marketStatus:'ok'};
  r.input.token={...r.input.token,rank:30,volume:1000,volumeWindow:'1m'};
  const minute={...r.input.token,observedAt:r.input.observedAt,marketStatus:'ok'};
  r.input.marketRankObservations=[hourly,minute];
  assert.equal(marketLeaderHint(r,NOW).window,'1h');assert.equal(marketLeaderHint(r,NOW).observedAt,hourly.observedAt);
  for(const patch of [{observedAt:new Date(NOW-120001).toISOString()},{observedAt:new Date(NOW+1).toISOString()},
    {address:'0x'+'b'.repeat(40)},{marketStatus:'stale'}]){
    r.input.marketRankObservations=[{...hourly,...patch},minute];assert.equal(marketLeaderHint(r,NOW),null);
  }
});

test('quote prewarm can research a non-setup but never bypasses known data gaps or cooldown',()=>{
  const r=row(),before=structuredClone(r);assert.equal(hotQuoteResearchReady(r,NOW),true);
  const first=selectHotQuoteResearch([r],null,NOW);assert.equal(first.row,r);
  assert.equal(selectHotQuoteResearch([r],first.lease,NOW+14999).row,r);
  assert.equal(selectHotQuoteResearch([r],first.lease,NOW+15000).row,null);
  assert.equal(selectHotQuoteResearch([r],first.lease,NOW+59999).row,null);
  assert.equal(selectHotQuoteResearch([r],first.lease,NOW+60000).row,r);
  assert.deepEqual(r,before,'no decision/reason/evidence or admission mutated');
  for(const mutate of [x=>x.decisions[0].evidence.chart.ready=false,x=>x.decisions[0].evidence.safety.missing=['卖出税'],
    x=>x.decisions[0].evidence.lossRepair.reentry.ready=false,x=>x.decisions[0].evidence.costAssumptions.accountingEligible=false,
    x=>x.input.opportunityAccount={positions:{['bsc:'+CA]:{}}}]){const bad=row();mutate(bad);assert.equal(hotQuoteResearchReady(bad,NOW),false);}
});

test('spare quote probes rotate across qualified leaders instead of repeatedly selecting rank one',()=>{
  const rows=Array.from({length:5},(_,i)=>{const r=row();r.input.token={...r.input.token,address:'0x'+String(i+1).repeat(40),rank:i+1};return r;});
  let lease=null;
  for(let i=0;i<10;i++){
    const at=NOW+i*60000;for(const r of rows)r.input.observedAt=new Date(at).toISOString();
    const picked=selectHotQuoteResearch(rows,lease,at);assert.equal(picked.row,rows[i%5]);lease=picked.lease;
    assert.equal(selectHotQuoteResearch([],lease,at+5000).row,null,'ordinary eligible entry preempts probe');
    assert.equal(selectHotQuoteResearch(rows,lease,at+15000).row,null,'rotation never bypasses cooldown');
  }
  assert.equal(Object.keys(lease.served).length,5);
  const large={...lease,nextAllowedAt:0,served:Object.fromEntries(Array.from({length:30},(_,i)=>['old:'+i,NOW-i]))};
  assert.equal(Object.keys(selectHotQuoteResearch(rows,large,NOW+600000).lease.served).length,20);
});

test('a busy candidate quote lane cannot consume the next token probe lease without requesting it',()=>{
  const a=row(),b=row();b.input.token={...b.input.token,address:'0x'+'b'.repeat(40)};
  const first=selectHotQuoteResearch([a],null,NOW);
  const blocked=selectHotQuoteResearch([b],first.lease,NOW+60000,{laneAvailable:false});
  assert.equal(blocked.row,null);assert.equal(blocked.lease,first.lease);
  assert.equal(blocked.lease.served['bsc:'+b.input.token.address],undefined);
  const next=selectHotQuoteResearch([b],blocked.lease,NOW+75000,{laneAvailable:true});
  assert.equal(next.row,b);assert.equal(next.lease.until,NOW+90000);
  assert.equal(selectHotQuoteResearch([b],null,NOW,{laneAvailable:false}).lease,null);
});

test('ambiguous launchpad creation/open timestamps use only the post-open source suffix',()=>{
  const candles=Array.from({length:45},(_,i)=>({time:1791096480000+i*60000,close:i+1}));
  const t={chain:'bsc',marketStage:'external',creationTimestamp:1791096711,openTimestamp:1791096711,launchpadPlatform:'flap'};
  const before=structuredClone(candles),result=externalEntryCandles(t,candles);
  assert.equal(result.selection.excludedPrefixBars,3);assert.equal(result.candles[0].time,1791096660000);
  assert.equal(result.candles.length,42);assert.deepEqual(candles,before);
  for(const altered of [{...t,openTimestamp:null},{...t,openTimestamp:t.openTimestamp+1},{...t,marketStage:'internal'},
    {...t,stageConflict:true},{...t,chain:'sol'},{...t,launchpadPlatform:'unknown'}])assert.equal(externalEntryCandles(altered,candles).selection,null);
  assert.ok(externalEntryCandles(t,[{time:'invalid'},...candles]).candles.some(c=>c.time==='invalid'),'bad rows must still fail validation');
});
