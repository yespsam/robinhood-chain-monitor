import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceNarrativeLearning, validNarrativeLearning, narrativeLearningReport } from '../src/paper-narrative-learning.js';
import { advanceNarrativeRecall } from '../src/paper-narrative-recall.js';
import { NOW,CA,TEXT,candidate,historyEvent } from './fixtures/paper-narrative-recall.js';

const MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
const snapshot=(at=NOW,volume=2000,extra={})=>({status:'ok',source:'gmgn-cli',chain:'base',interval:'1m',observedAt:new Date(at).toISOString(),
  tokens:[{...candidate(at).token,volume,...extra}]});
const advance=(s,at,volume=2000,extra={},options={})=>advanceNarrativeLearning(s,{snapshots:[snapshot(at,volume,extra)],nowMs:at,...options});
function baseline(){let s=null;for(let i=3;i>=1;i--)s=advance(s,NOW-i*MINUTE).memory;return s;}
function surge(extra={},options={}){return advance(baseline(),NOW,12000,extra,options);}
const mark=(at,price,extra={})=>({chain:'base',address:CA,status:'ok',price,observedAt:new Date(at).toISOString(),...extra});
const sourceMemory=()=>advanceNarrativeRecall(null,{events:[historyEvent()],candidates:[candidate(NOW-MINUTE)],nowMs:NOW-MINUTE}).memory;

test('learns a high-cap surge from a comparable minute baseline, never approves a trade',()=>{
  const s=surge({}, {narrativeMemory:sourceMemory()});
  assert.equal(s.report.sampleCount,1);assert.equal(s.report.verifiedNarrativeSamples,1);
  const e=s.memory.episodes[0];assert.equal(e.volumeMultiple,6);assert.equal(e.baselineSamples,3);
  assert.equal(e.narratives[0].text.includes(TEXT),true);assert.equal(e.narratives[0].binding,'verified_ca');
  assert.equal(e.learningOnly,true);assert.equal(s.report.autoTradingChanges,false);
  assert.equal(s.report.mode,'observation_only');assert.equal(validNarrativeLearning(s.memory),true);
  assert.equal(s.memory.episodes[0].at,NOW);
});
test('rejects stale, future, mixed-window, unknown-unit, low-cap, low-liquidity and weak-volume samples',()=>{
  for(const change of [s=>s.status='stale',s=>s.interval='1h',s=>delete s.interval,s=>s.source='unknown',
    s=>s.observedAt=new Date(NOW-120001).toISOString(),s=>s.observedAt=new Date(NOW+1).toISOString(),
    s=>s.tokens[0].chain='bsc',s=>s.tokens[0].address='bad',s=>s.tokens[0].marketCap=999999,
    s=>s.tokens[0].marketCap='1000000',s=>s.tokens[0].liquidity=0,s=>s.tokens[0].price=NaN,
    s=>s.tokens[0].volume=9999,s=>s.tokens[0].volume=null]) {
    const input=snapshot(NOW,12000);change(input);
    assert.equal(advanceNarrativeLearning(baseline(),{snapshots:[input],nowMs:NOW}).report.sampleCount,0,String(change));
  }
  assert.equal(advance(null,NOW,12000).report.sampleCount,0,'no fabricated baseline');
  let s=null;for(let i=3;i>=1;i--)s=advance(s,NOW-i*MINUTE,0).memory;
  assert.equal(advance(s,NOW,12000).report.sampleCount,0,'zero denominator remains unknown');
  assert.equal(advance(baseline(),NOW+10*MINUTE,12000).report.sampleCount,0,'gapped baseline cannot prove surge');
});
test('heartbeat, cached snapshot and the same minute cannot multiply samples; restart preserves the latch',()=>{
  let s=baseline();for(let i=0;i<5;i++)s=advance(s,NOW-10000+i*1000,2000).memory;
  assert.equal(s.series[`base:${CA}`].points.length,3);
  s=surge().memory;
  for(const at of [NOW,NOW+1000,NOW+MINUTE,NOW+2*MINUTE])s=advance(s,at,14000).memory;
  const restored=JSON.parse(JSON.stringify(s));assert.equal(validNarrativeLearning(restored),true);
  assert.equal(advance(restored,NOW+3*MINUTE,14000).report.sampleCount,1);
});
test('fresh price marks retain upside and downside, horizon timestamps and observed drawdown',()=>{
  let s=surge().memory;
  for(const [at,price] of [[NOW+MINUTE,2],[NOW+5*MINUTE,1.5],[NOW+HOUR,.8],[NOW+DAY,.5]]) {
    s=advanceNarrativeLearning(s,{marks:[mark(at,price)],nowMs:at}).memory;
  }
  const e=s.episodes[0];assert.equal(e.outcomes['5m'].returnRate,.5);assert.ok(e.outcomes['1h'].returnRate<0);
  assert.equal(e.outcomes['24h'].returnRate,-.5);assert.equal(e.peakPrice,2);assert.equal(e.troughPrice,.5);
  assert.equal(e.maxObservedDrawdown,.75);assert.equal(validNarrativeLearning(s),true);
});
test('stale, wrong-chain, missing, future and duplicate follow-up quotes cannot invent outcomes',()=>{
  const state=surge().memory,at=NOW+5*MINUTE;
  for(const m of [mark(at,2,{chain:'bsc'}),mark(at,2,{status:'stale'}),mark(NOW,2),mark(at+1,2),mark(at,null)]) {
    const s=advanceNarrativeLearning(state,{marks:[m],nowMs:at});assert.equal(s.memory.episodes[0].outcomes['5m'],undefined);
  }
  const target=advanceNarrativeLearning(state,{nowMs:at});assert.equal(target.followupTargets[0].horizon,'5m');
  let r=advanceNarrativeLearning(state,{nowMs:NOW+8*MINUTE});assert.equal(r.memory.episodes[0].outcomes['5m'].status,'missing');
  r=advanceNarrativeLearning(r.memory,{marks:[mark(NOW+9*MINUTE,2)],nowMs:NOW+9*MINUTE});
  assert.equal(r.memory.episodes[0].outcomes['5m'].status,'missing','late data cannot silently backfill a missed horizon');
});
test('unverified descriptions and exact provider permalinks stay separate from verified CA narrative learning',()=>{
  const memory=sourceMemory(),doc=memory.documents[0];delete doc.assetKey;memory.assets={};
  const exact=surge({twitterUsername:doc.url,raw:{link:{description:'Unverified advertising claim'}}},{narrativeMemory:memory});
  assert.equal(exact.report.verifiedNarrativeSamples,0);assert.equal(exact.report.linkedNarrativeSamples,1);
  assert.equal(exact.memory.episodes[0].narratives[0].binding,'provider_permalink');assert.equal(exact.report.themes[0].binding,'provider_permalink');
  assert.match(exact.report.themes[0].status,/不作买入依据/);
  for(const url of ['https://x.com/elonmusk','https://evil.test/elonmusk/status/2102563652285145000',doc.url.replace('elonmusk','fake')])
    assert.equal(surge({twitterUsername:url},{narrativeMemory:memory}).memory.episodes[0].narratives.length,0);
  assert.equal(surge({symbol:'robotaxi'}).report.narrativePending,1,'a name does not create narrative evidence');
});
test('exact linked post lookup is queued, bounded and observational even after official text verification',()=>{
  const url='https://x.com/example/status/2102563652285145999';
  const r=surge({twitterUsername:url});assert.deepEqual(r.sourceTargets,[url]);
  const observation={url,status:'ok',observedAt:NOW+1000,at:NOW-1000,text:TEXT,author:'example',sourceVerifiedBy:'official_x_oembed'};
  const s=advanceNarrativeLearning(r.memory,{sourceObservations:[observation],nowMs:NOW+1000});
  assert.equal(s.report.linkedNarrativeSamples,1);assert.equal(s.report.verifiedNarrativeSamples,0);assert.deepEqual(s.sourceTargets,[]);
  assert.equal(s.memory.episodes[0].sourceLookups[url].attempts,1);
  const duplicate=advanceNarrativeLearning(s.memory,{sourceObservations:[observation],nowMs:NOW+2000});
  assert.equal(duplicate.memory.episodes[0].sourceLookups[url].attempts,1);
  const failure=advanceNarrativeLearning(r.memory,{sourceObservations:[{...observation,status:'unavailable'}],nowMs:NOW+1000});
  assert.equal(failure.sourceTargets.length,0);
  assert.equal(advanceNarrativeLearning(failure.memory,{nowMs:NOW+301001}).sourceTargets.length,1);
  for(const override of [{at:NOW+1},{sourceVerifiedBy:'mirror'},{url:url.replace('example','fake')},{observedAt:NOW+9999}]) {
    assert.equal(advanceNarrativeLearning(r.memory,{sourceObservations:[{...observation,...override}],nowMs:NOW+1000}).report.linkedNarrativeSamples,0);
  }
});
test('later posts, conflicted documents and cross-chain bindings cannot explain earlier surges',()=>{
  for(const change of [m=>m.documents[0].at=NOW+1,m=>m.documents[0].negative=true,
    m=>m.conflicts.push(m.documents[0].id),m=>m.documents[0].assetKey=`bsc:${CA}`]) {
    const m=sourceMemory();change(m);assert.equal(surge({}, {narrativeMemory:m}).report.verifiedNarrativeSamples,0);
  }
  const s=surge().memory,m=sourceMemory();
  const learned=advanceNarrativeLearning(s,{narrativeMemory:m,nowMs:NOW+MINUTE});
  assert.equal(learned.memory.episodes[0].narratives[0].associatedAt,NOW+MINUTE);
  m.conflicts.push(m.documents[0].id);
  assert.equal(advanceNarrativeLearning(learned.memory,{narrativeMemory:m,nowMs:NOW+2*MINUTE}).report.verifiedNarrativeSamples,0);
});
test('learning themes count positive and negative examples together and require distinct coins and days',()=>{
  const s=surge({}, {narrativeMemory:sourceMemory()}).memory,seed=s.episodes[0];
  s.episodes=Array.from({length:12},(_,i)=>({...structuredClone(seed),id:`example-${i}`,at:NOW-i*DAY,
    peakPrice:2,outcomes:{'24h':{status:'observed',price:i%2?.5:1.5,at:NOW+(1-i)*DAY,returnRate:i%2?-.5:.5}}}));
  const theme=narrativeLearningReport(s).themes[0];assert.equal(theme.positive,6);assert.equal(theme.negative,6);
  assert.equal(theme.observedPumpThenFade,6);assert.match(theme.status,/样本不足/);assert.equal(theme.uniqueTokens,1);
  assert.equal(theme.autoTradingChanges,false);assert.equal(theme.medianReturn24h,0);
});
test('corrupt learning state fails closed, expiration is bounded, and inputs are not mutated',()=>{
  const original=baseline(),before=JSON.stringify(original);surge();advance(original,NOW,12000);assert.equal(JSON.stringify(original),before);
  const broken=surge().memory;broken.episodes[0].outcomes=null;
  assert.equal(validNarrativeLearning(broken),false);assert.throws(()=>advanceNarrativeLearning(broken),/记忆异常/);
  const old=advanceNarrativeLearning(surge().memory,{nowMs:NOW+31*DAY});assert.equal(old.report.sampleCount,0);assert.equal(old.report.trackedTokens,0);
});

function fullPendingCohort() {
  const state=baseline(),seed=surge().memory.episodes[0];
  state.episodes=Array.from({length:500},(_,i)=>({...structuredClone(seed),id:`pending-${i}`,
    at:NOW-HOUR,lastAt:NOW-HOUR,outcomes:{}}));
  return state;
}
test('capacity protects all pending 24h cases and counts a skipped wave only once across restart',()=>{
  const prior=fullPendingCohort(),before=JSON.stringify(prior);
  const r=advance(prior,NOW,12000);
  assert.deepEqual(r.memory.episodes.map(e=>e.id),prior.episodes.map(e=>e.id));
  assert.equal(r.report.retention.pending24h,500);
  assert.equal(r.report.retention.capacitySkippedEpisodes,1);
  assert.equal(JSON.stringify(prior),before);
  const restarted=advance(JSON.parse(JSON.stringify(r.memory)),NOW+MINUTE,14000);
  assert.equal(restarted.report.retention.capacitySkippedEpisodes,1);
  assert.equal(validNarrativeLearning(restarted.memory),true);
});
test('pending cases reach their true 24h outcome and completed cases coexist with new samples',()=>{
  const prior=fullPendingCohort(),due=NOW+23*HOUR;
  const mature=advanceNarrativeLearning(prior,{marks:[mark(due,1.5)],nowMs:due});
  assert.equal(mature.report.completed24h,500);
  assert.equal(mature.report.retention.pending24h,0);
  let s=mature.memory;
  for(let i=1;i<=3;i++)s=advance(s,due+i*MINUTE,2000).memory;
  const r=advance(s,due+4*MINUTE,12000);
  assert.equal(r.report.sampleCount,501);
  assert.equal(r.report.completed24h,500);
  assert.equal(r.report.retention.pending24h,1);
  assert.equal(validNarrativeLearning(r.memory),true);
  assert.ok(r.memory.episodes.some(e=>e.id==='pending-0'));
});
test('completed retention is bounded without selecting winners or silently dropping pending cases',()=>{
  const s=fullPendingCohort(),seed=s.episodes[0];
  const completed=Array.from({length:1500},(_,i)=>({...structuredClone(seed),id:`completed-${i}`,
    at:NOW-3*DAY+i*1000,lastAt:NOW-2*DAY+i*1000,
    outcomes:{'24h':{status:'observed',at:NOW-2*DAY+i*1000,price:i%2?1.5:.5,returnRate:i%2?.5:-.5}}}));
  s.episodes[0].at=NOW-DAY;s.episodes[0].lastAt=NOW-DAY;
  s.episodes=[...completed,...s.episodes];
  assert.equal(validNarrativeLearning(s),true);
  const r=advanceNarrativeLearning(s,{marks:[mark(NOW,2)],nowMs:NOW});
  assert.equal(r.report.retention.pending24h,499);
  assert.equal(r.report.retention.resolved24h,1500);
  assert.equal(r.report.retention.evictedResolvedEpisodes,1);
  assert.ok(r.memory.episodes.some(e=>e.id==='pending-0'));
  assert.ok(!r.memory.episodes.some(e=>e.id==='completed-0'));
  assert.equal(validNarrativeLearning(r.memory),true);
  for(const value of [-1,1.5,'1']) {
    const broken=structuredClone(r.memory);broken.capacitySkippedEpisodes=value;
    assert.equal(validNarrativeLearning(broken),false);
  }
});
