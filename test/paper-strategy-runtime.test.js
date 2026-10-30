import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaperStrategyRuntime } from '../src/paper-strategy-runtime.js';
import { createPaperStrategyAccount, advancePaperStrategyAccount, evaluatePaperStrategies } from '../src/paper-strategy-engine.js';
import { createConfirmedPaperSession } from '../src/paper-account-session.js';
import { NOW as RECALL_NOW, DAY as RECALL_DAY, TEXT as RECALL_TEXT, kolEvent } from './fixtures/paper-narrative-recall.js';
import { discoverPaperFlowCandidates } from '../src/paper-candidate-discovery.js';
import { breakoutCandles } from './fixtures/paper-strategy-v2.js';
import { NOW as BINANCE_NOW, row as binanceRow, warmFeed, stateFor, profilesFor } from './fixtures/binance-flow.js';
import { normalizePlatformCall, GMGN_SOCIAL_VERSION } from '../src/gmgn-social-monitor.js';

const NOW = Date.parse('2026-09-20T10:00:00Z'), CA = `0x${'a'.repeat(40)}`;
const iso = value => new Date(value).toISOString();
const token = { chain: 'robinhood', address: CA, symbol: 'OFFLINE_FIXTURE', price: 1, marketStage: 'internal', liquidity: 60000, volume1h: 10000, isHoneypot: false, isWashTrading: false, rugRatio: .01, top10HolderRate: .15, devTeamHoldRate: .02, bundlerRate: .01, buyTax: 0, sellTax: 0, launchpad: 'fixture', creationTimestamp: NOW - 600000 };
const candles = breakoutCandles;

test('BSC scan overlay rejects other-chain cached/event candidates without rewriting session universe',async t=>{
  const dataDir=await directory(t),chains=['robinhood','bsc','base'],calls=[];
  await fs.writeFile(path.join(dataDir,'trading-scan-scope.json'),JSON.stringify({version:1,chains:['bsc']}));
  const feed={trending:async q=>{calls.push(['market',q.chain]);return {status:'ok',observedAt:iso(NOW),tokens:chains.map(chain=>({...token,chain}))};},
    trenches:async q=>{calls.push(['trenches',q.chain]);return {status:'ok',observedAt:iso(NOW),tokens:chains.map(chain=>({...token,chain}))};},
    details:async q=>{calls.push(['detail',q.chain]);return {status:'unavailable'};},
    quote:async q=>{calls.push(['quote',q.chain]);return {status:'unavailable'};},
    kline:async q=>{calls.push(['chart',q.chain]);return {status:'unavailable',candles:[]};}};
  const runtime=createPaperStrategyRuntime({dataDir,market:feed,chains,now:()=>NOW,
    evidenceLoader:()=>multiSources(chains),allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,
    continuousPaperMode:true,opportunityMode:true,memeExitMode:true});
  try {
    for(let i=0;i<6;i++)await runtime.runOnce();await runtime.refreshDetails();
    const s=runtime.snapshot();assert.deepEqual(s.scanScope.scanChains,['bsc']);assert.deepEqual(s.chains,chains);
    assert.equal(s.strategyFocusShadow?.durability,'bounded_persistent_journal_plus_latest_scan_snapshot');
    assert.equal(s.strategyFocusShadow?.entryAllowed,false);
    assert.equal(s.cadence.marketChains,1);assert.ok(s.evaluations.length>0);
    assert.ok(s.evaluations.every(e=>e.token.chain==='bsc'));assert.ok(calls.every(c=>c[1]==='bsc'));
    assert.equal(s.chainCoverage.base.scanning,false);assert.equal(s.chainCoverage.bsc.scanning,true);
    const stored=JSON.parse(await fs.readFile(runtime.stateFile,'utf8'));assert.deepEqual(stored.chains,chains);
    assert.equal(s.execution,false);assert.equal(s.signing,false);assert.equal(s.broadcast,false);
    await runtime.stop();
    const shadow=JSON.parse(await fs.readFile(path.join(dataDir,'paper-strategy-focus-shadow-v1.json'),'utf8'));
    assert.ok(shadow.samples.length>0,'research observations persist in their independent bounded file');
    assert.ok(shadow.samples.every(sample=>sample.latest.entryAllowed===false&&sample.latest.paperFillAllowed===false));
  }finally{await runtime.stop();}
});

test('focus simulator is exposed only for confirmed recovery paper mode and stays separate from the main ledger',async t=>{
  let clock=NOW;const dataDir=await directory(t),candidate={...token,chain:'bsc',marketStage:'external',price:1.42};
  const feed={...market(()=>clock),
    trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[candidate]}),
    trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    quote:async({chain,address})=>({chain,address,status:'ok',price:1.42,observedAt:iso(clock)}),
    kline:async({chain,address})=>({chain,address,resolution:'1m',status:'ok',candles:candles(clock)})};
  const runtime=createPaperStrategyRuntime({dataDir,market:feed,chain:'bsc',chains:['bsc'],now:()=>clock,
    evidenceLoader:()=>({}),allowExploratory:true,pvpMode:true,confirmedMode:true,
    evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true,memeExitMode:true,recoveryMode:true,
    strategyFocusSimulation:true});
  try{
    await runtime.runOnce();
    const state=runtime.snapshot();
    assert.equal(state.strategyFocusSimulation.mode,'paper_sidecar');
    assert.equal(state.strategyFocusSimulation.enabled,true);
    assert.equal(state.strategyFocusSimulation.status,'ready');
    assert.equal(state.strategyFocusSimulation.execution,false);
    assert.equal(state.strategyFocusSimulation.signing,false);
    assert.equal(state.strategyFocusSimulation.broadcast,false);
    assert.equal(state.account.trades.length,0,'strictly incomplete fixture does not create a main-ledger trade');
    assert.throws(()=>createPaperStrategyRuntime({market:feed,strategyFocusSimulation:true}),
      /confirmed multi-setup recovery paper mode/);
  }finally{await runtime.stop();}
});

test('BSC three-list discovery overlay retains a pre-existing Robinhood holding and its independent exit quotes',async t=>{
  const dataDir=await directory(t),chains=['robinhood','bsc'];let clock=NOW;
  const initial=createPaperStrategyRuntime({dataDir,chains,market:market(()=>clock),now:()=>clock,evidenceLoader:()=>sources(clock)});
  await initial.runOnce();const before=initial.snapshot();await initial.stop();
  assert.ok(Object.keys(before.account.positions).length>0);
  await fs.writeFile(path.join(dataDir,'trading-scan-scope.json'),JSON.stringify({version:1,chains:['bsc']}));
  const calls=[];
  const runtime=createPaperStrategyRuntime({dataDir,chains,discoveryMode:'gmgn_three_lists_v1',market:{...market(()=>clock),quote:async q=>{
    calls.push(q);return {chain:q.chain,address:q.address,price:.5,status:'ok',observedAt:iso(clock)};
  }},now:()=>clock,evidenceLoader:()=>sources(clock)});
  try {
    clock+=1000;await runtime.fastOnce();await runtime.refreshQuote();
    const after=runtime.snapshot();assert.ok(calls.some(c=>c.chain==='robinhood'));
    assert.deepEqual(after.scanScope.retainedExitChains,['robinhood']);
    assert.deepEqual(after.account.trades,JSON.parse(JSON.stringify(before.account.trades)));
    assert.equal(Object.keys(after.account.positions).length,Object.keys(before.account.positions).length);
    assert.ok(after.evaluations.every(e=>e.token.chain==='bsc'));
    await runtime.exitOnce();assert.equal(Object.keys(runtime.snapshot().account.positions).length,0);
    assert.equal(runtime.snapshot().account.trades.at(-1).side,'sell');
    assert.equal(runtime.snapshot().account.trades.at(-1).chain,'robinhood');
  }finally{await runtime.stop();}
});

test('new wallet buy reaches priority detail/chart research but cannot force a paper fill',async t=>{
  const evidence=multiSources(['bsc']);
  evidence.flowState.profiles={};
  evidence.flowState.trades.bsc=evidence.flowState.trades.bsc.slice(0,1).map(r=>({...r,at:NOW-20000}));
  const current={...token,chain:'bsc',marketStage:'external'},calls=[];
  const feed={trending:async()=>({status:'ok',observedAt:iso(NOW-40000),tokens:[current]}),
    trenches:async()=>({status:'ok',observedAt:iso(NOW),tokens:[]}),
    quote:async()=>{calls.push('quote');return {status:'unavailable'};},
    kline:async q=>{calls.push(['chart',q.purpose]);return {...current,resolution:'1m',status:'unavailable',candles:[]};},
    details:async q=>{calls.push(['detail',q.researchPriority]);return {status:'unavailable'};}};
  const r=createPaperStrategyRuntime({dataDir:await directory(t),market:feed,chain:'bsc',chains:['bsc'],now:()=>NOW,
    evidenceLoader:()=>evidence,allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,
    continuousPaperMode:true,opportunityMode:true,memeExitMode:true});
  try{
    await r.runOnce();await r.refreshDetails();
    const s=r.snapshot();assert.equal(s.cadence.walletBuyPriority.triggers.length,1);
    assert.equal(s.cadence.walletBuyPriority.triggers[0].buyAt,iso(NOW-20000));
    assert.equal(s.researchPipeline.lastChartDispatch.lane,'wallet');
    assert.ok(calls.some(c=>Array.isArray(c)&&c[0]==='detail'&&c[1]===3));
    assert.equal(s.account.trades.length,0,'priority is not permission and no quote was invented');
    assert.ok(!calls.includes('quote'));
    await r.fastOnce();await r.refreshDetails();
    assert.equal(calls.filter(c=>c[0]==='chart').length,1,'repeat snapshots retain chart backoff');
    assert.equal(calls.filter(c=>c[0]==='detail').length,1,'repeat snapshots do not storm details');
  }finally{await r.stop();}
});

test('Plus auxiliary reads have two bounded distinct seats and minute rediscovery yields its fresh 30s budget',async t=>{
  const dataDir=await directory(t);await fs.writeFile(path.join(dataDir,'gmgn-readonly-plan.json'),JSON.stringify({version:1,plan:'plus'}));
  let clock=NOW;const calls=[],pending=[];
  const feed={quote:async()=>({status:'unavailable'}),trending:q=>{
    calls.push(q.interval);return q.interval==='1m'?Promise.resolve({status:'ok',observedAt:iso(clock),tokens:[]}):new Promise(resolve=>pending.push(resolve));
  },trenches:()=>{calls.push('trenches');return new Promise(resolve=>pending.push(resolve));}};
  const r=createPaperStrategyRuntime({dataDir,market:feed,now:()=>clock,evidenceLoader:()=>({}),
    higherFrequencyResearch:true,confirmedMode:true,opportunityMode:true,continuousPaperMode:true,memeExitMode:true,
    allowExploratory:true,pvpMode:true,evidenceHoldMode:true});
  const turn=()=>new Promise(resolve=>setImmediate(resolve));
  try {
    await r.setEnabled(false);await r.refreshMarket({background:true});await turn();
    assert.deepEqual(calls,['1m','trenches','1h']);
    for(let n=0;n<5;n++){clock+=1000;await r.refreshMarket({background:true});}
    assert.equal(calls.length,3,'fresh minute feed does not monopolize the shared quota');
    pending[1]({status:'ok',observedAt:iso(clock),tokens:[]});await turn();
    assert.equal(calls.length,3,'a stuck auxiliary cannot be duplicated');
    clock=NOW+30000;await r.refreshMarket({background:true});assert.equal(calls.at(-1),'1m');
    await fs.writeFile(path.join(dataDir,'gmgn-readonly-plan.json'),JSON.stringify({version:1,plan:'free'}));
    clock=NOW+61000;await r.refreshMarket({background:true});await turn();
    assert.equal(pending.length,2,'downgrade waits for pending auxiliary work');
    let stopped=false;const stopping=r.stop().then(()=>{stopped=true;});await turn();assert.equal(stopped,false);
    pending[0]({status:'unavailable'});await stopping;assert.equal(stopped,true);
  }finally{pending.forEach(resolve=>resolve({status:'unavailable'}));await r.stop();}
});

test('auxiliary feeds drain due work without waiting for another minute response and stay single-flight',async t=>{
  const calls=[],releases=[];
  const feed={...market(),quote:async()=>({status:'unavailable'}),trending:q=>{
    calls.push(q.interval);return q.interval==='1m'?Promise.resolve({status:'ok',observedAt:iso(NOW),tokens:[]}):
      new Promise(resolve=>releases.push(resolve));},trenches:()=>{calls.push('trenches');return new Promise(resolve=>releases.push(resolve));}};
  const runtime=createPaperStrategyRuntime({dataDir:await directory(t),market:feed,now:()=>NOW,
    evidenceLoader:()=>({}),higherFrequencyResearch:true,confirmedMode:true,opportunityMode:true,
    allowExploratory:true,pvpMode:true,evidenceHoldMode:true});
  const turn=()=>new Promise(resolve=>setImmediate(resolve));
  try{
    await runtime.setEnabled(false);await runtime.refreshMarket({background:true});await turn();
    assert.deepEqual(calls,['1m','trenches']);
    releases[0]({status:'ok',observedAt:iso(NOW),tokens:[]});await turn();
    assert.deepEqual(calls,['1m','trenches','1h'],'no intervening minute response is needed');
    await runtime.refreshMarket({background:true});await turn();assert.equal(releases.length,2);
    releases[1]({status:'ok',observedAt:iso(NOW),tokens:[]});await turn();
    assert.equal(releases.length,2,'per-feed attempt pacing prevents a tight retry loop');
  }finally{releases.forEach(resolve=>resolve({status:'unavailable'}));await runtime.stop();}
});

test('hour-ranking-only candidates refresh before market expiry without borrowing minute feed timestamps',async t=>{
  let clock=NOW,failHour=false;const calls=[];
  const feed={...market(()=>clock),quote:async()=>({status:'unavailable'}),
    trending:async q=>{calls.push({...q,at:clock});return q.interval==='1h'&&failHour?{status:'unavailable'}:
      {status:'ok',observedAt:iso(clock),tokens:q.interval==='1h'?[token]:[]};},
    trenches:async q=>{calls.push({...q,interval:'trenches',at:clock});return {status:'ok',observedAt:iso(clock),tokens:[]};}};
  const runtime=createPaperStrategyRuntime({dataDir:await directory(t),market:feed,now:()=>clock,
    evidenceLoader:()=>({}),higherFrequencyResearch:true,confirmedMode:true,opportunityMode:true,
    allowExploratory:true,pvpMode:true,evidenceHoldMode:true});
  const pump=async()=>{for(let i=0;i<3;i++){
    await runtime.refreshMarket({background:true});await new Promise(resolve=>setImmediate(resolve));
  }await runtime.fastOnce();};
  try{
    await runtime.setEnabled(false);await pump();
    assert.equal(calls.filter(c=>c.interval==='1h').length,1);
    clock+=61000;await pump();
    assert.equal(calls.filter(c=>c.interval==='1h').length,2,'1h volume window still refreshes inside the 120s data TTL');
    assert.ok(calls.filter(c=>c.interval!=='1m').every(c=>c.purpose==='scan'));
    assert.ok(runtime.snapshot().evaluations.every(r=>r.evidence.marketFresh));
    const observed=iso(clock);failHour=true;clock+=61000;await pump();
    const source=runtime.snapshot().cadence.marketAuxiliarySourceAges.find(s=>s.source==='ranking_1h');
    assert.equal(source.status,'stale');assert.equal(source.observedAt,observed);
    assert.ok(runtime.snapshot().evaluations.every(r=>!r.evidence.marketFresh));
    assert.equal(runtime.snapshot().account.trades.length,0);assert.equal(runtime.snapshot().execution,false);
  }finally{await runtime.stop();}
});

test('semantic research dispatch does not block scans or alter paper eligibility and ledger actions',async t=>{
  let observed=0,stopped=false;
  const jevResearch={observe:rows=>{observed+=rows.length;return new Promise(()=>{});},hint:()=>({adjustment:20,canExecute:false}),
    snapshot:()=>({status:'in_flight',researchOnly:true,canExecute:false}),stop:async()=>{stopped=true;}};
  const base={market:market(),now:()=>NOW,evidenceLoader:()=>({})};
  const control=createPaperStrategyRuntime({...base,dataDir:await directory(t)});
  const treated=createPaperStrategyRuntime({...base,dataDir:await directory(t),jevResearch});
  try{
    await control.runOnce();await treated.runOnce();
    assert.ok(observed>0);assert.equal(treated.snapshot().jevResearch.status,'in_flight');
    assert.equal(treated.snapshot().account.trades.length,control.snapshot().account.trades.length);
    assert.deepEqual(treated.snapshot().evaluations,control.snapshot().evaluations);
    assert.equal(treated.snapshot().execution,false);
  }finally{await control.stop();await treated.stop();}
  assert.equal(stopped,true);
});

test('fresh GMGN call seeds off-ranking research but never fabricates a price, narrative or trade',async t=>{
  let clock=NOW,requests=0;
  const call=normalizePlatformCall({id:'wire-test',signal_type:13,token_address:CA,trigger_at:(NOW-1000)/1000,
    data:{chain:'bsc',address:CA,symbol:'NEWS'}},'bsc',NOW);
  const evidence={events:[],gmgnSocial:{version:GMGN_SOCIAL_VERSION,events:[call],chains:{bsc:{status:'healthy',lastSuccessAt:iso(NOW)}}}};
  const feed={...market(()=>clock),trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),quote:async()=>({status:'unavailable'}),
    details:async()=>{requests++;return {status:'ok',observedAt:iso(clock),token:{...token,chain:'bsc'}};}};
  const runtime=createPaperStrategyRuntime({dataDir:await directory(t),market:feed,chain:'bsc',chains:['bsc'],now:()=>clock,
    evidenceLoader:()=>evidence,allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,
    continuousPaperMode:true,opportunityMode:true});
  try{
    await runtime.runOnce();assert.equal(runtime.snapshot().newsWire.freshHints,1);
    assert.equal(runtime.snapshot().cadence.detailTargets,1);
    assert.equal(runtime.snapshot().account.trades.length,0);
    await runtime.refreshDetails();assert.equal(requests,1);await runtime.fastOnce();
    assert.equal(runtime.snapshot().account.trades.length,0);
    assert.equal(runtime.snapshot().researchPipeline.lastDetail.priority,3);
    assert.equal(runtime.snapshot().execution,false);
    clock+=121000;await runtime.fastOnce();assert.equal(runtime.snapshot().newsWire.freshHints,0);
  }finally{await runtime.stop();}
});

for (const profileSource of ['verifiedLeaderboardProfiles', 'verifiedProfiles']) test(`${profileSource} enriches real feed wallets only, without synthetic buy events or changing the cached source`, async t => {
  const dataDir = await directory(t), evidence = sources(), profiles = structuredClone(evidence.flowState.profiles);
  evidence.flowState.profiles = {}; let ready = false;
  const runtime = createPaperStrategyRuntime({ dataDir, market: market(), now: () => NOW, evidenceLoader: () => evidence,
    learningLoader: () => ({ [profileSource]: ready ? profiles : {} }) });
  try {
    await runtime.runOnce(); assert.equal(runtime.snapshot().account.trades.length, 0);
    ready = true; await runtime.runOnce(); assert.equal(runtime.snapshot().account.trades.length, 1);
    assert.deepEqual(evidence.flowState.profiles, {});
  } finally { await runtime.stop(); }
  const empty = createPaperStrategyRuntime({ dataDir: await directory(t), market: market(), now: () => NOW, evidenceLoader: () => ({ flowState: { ...evidence.flowState, trades: {} } }),
    learningLoader: () => ({ [profileSource]: profiles }) });
  try { await empty.runOnce(); assert.equal(empty.snapshot().account.trades.length, 0); } finally { await empty.stop(); }
});
function multiSources(chains, at = NOW) {
  const flowState = { chains: {}, trades: {}, profiles: {} };
  for (const chain of chains) {
    const single = sources(at).flowState;
    flowState.chains[chain] = single.chains.robinhood;
    flowState.trades[chain] = single.trades.robinhood.map(row => ({ ...row, chain }));
    for (const pair of Object.values(single.profiles)) {
      const wallet = pair['7d'].wallet;
      flowState.profiles[`${chain}:${wallet}`] = Object.fromEntries(Object.entries(pair).map(([period, profile]) => [period, { ...profile, chain }]));
    }
  }
  return { flowState, events: [] };
}

test('one-second background scans publish minute feeds without waiting for auxiliary requests', async t => {
  const chains = ['robinhood', 'base'], calls = [];
  let clock = NOW, release, auxiliaryCalls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const feed = { ...market(() => clock), trending: async ({ chain, interval, purpose }) => {
    calls.push({ chain, interval, purpose });
    return { status: 'ok', observedAt: iso(clock), tokens: [{ ...token, chain }] };
  }, trenches: () => { auxiliaryCalls++; return pending; } };
  const runtime = createPaperStrategyRuntime({ dataDir: await directory(t), market: feed, chains,
    now: () => clock, evidenceLoader: () => ({}), marketIntervalMs: 1000 });
  try {
    await runtime.setEnabled(false);
    for (let i = 0; i < 5; i++) { await runtime.refreshMarket({ background: true }); clock += 1000; }
    await runtime.fastOnce();
    assert.deepEqual(calls.map(x => x.chain), ['robinhood', 'base', 'robinhood', 'base', 'robinhood']);
    assert.ok(calls.every(x => x.interval === '1m' && x.purpose === 'scan'));
    assert.equal(auxiliaryCalls, 1, 'auxiliary requests stay single-flight');
    const state = runtime.snapshot();
    assert.equal(state.cadence.evaluationIntervalMs, 1000);
    assert.equal(state.cadence.marketRefreshIntervalMs, 1000);
    assert.equal(state.cadence.marketAuxiliaryPending, true);
    assert.equal(state.chainCoverage.robinhood.market.observedAt, iso(NOW + 4000));
    assert.equal(state.chainCoverage.base.market.observedAt, iso(NOW + 3000));
    clock += 1000; await runtime.fastOnce();
    assert.equal(runtime.snapshot().chainCoverage.base.market.observedAt, iso(NOW + 3000), 'local scanning cannot renew an old source timestamp');
    let closed = false;
    const stopping = runtime.stop().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
    release({ status: 'unavailable', tokens: [] }); await stopping;
    assert.equal(closed, true);
  } finally { release({ status: 'unavailable', tokens: [] }); await runtime.stop(); }
});

test('Plus market lanes isolate a stuck chain, cap pending calls and drain them on shutdown', async t => {
  const dataDir=await directory(t),calls=[],pending=[];
  await fs.writeFile(path.join(dataDir,'gmgn-readonly-plan.json'),JSON.stringify({version:1,plan:'plus'}));
  const chains=['robinhood','bsc','base'];
  const feed={...market(),trending:query=>new Promise(resolve=>{calls.push(query.chain);pending.push(resolve);}),
    trenches:async()=>({status:'unavailable',tokens:[]}),quote:async()=>({status:'unavailable'})};
  const runtime=createPaperStrategyRuntime({dataDir,market:feed,chains,now:()=>NOW,
    evidenceLoader:()=>({}),higherFrequencyResearch:true,confirmedMode:true,opportunityMode:true,
    allowExploratory:true,pvpMode:true,evidenceHoldMode:true});
  const finish=async()=>{await new Promise(resolve=>setImmediate(resolve));};
  try {
    await runtime.setEnabled(false);
    const first=runtime.refreshMarket({background:true});await finish();
    const second=runtime.refreshMarket({background:true});await finish();
    await runtime.refreshMarket({background:true});
    assert.deepEqual(calls,['robinhood','bsc']);
    pending[1]({status:'ok',observedAt:iso(NOW),tokens:[{...token,chain:'bsc'}]});await second;
    const third=runtime.refreshMarket({background:true});await finish();
    assert.deepEqual(calls,['robinhood','bsc','base'],'slow Robinhood cannot hold the other chains');
    await runtime.fastOnce();
    assert.equal(runtime.snapshot().chainCoverage.bsc.market.observedAt,iso(NOW));
    assert.equal(runtime.snapshot().cadence.marketRefreshInFlight.length,2);
    await fs.writeFile(path.join(dataDir,'gmgn-readonly-plan.json'),JSON.stringify({version:1,plan:'free'}));
    await runtime.refreshMarket({background:true});assert.equal(calls.length,3,'downgrade adds no work');
    let closed=false;const stopping=runtime.stop().then(()=>{closed=true;});await finish();assert.equal(closed,false);
    pending[0]({status:'unavailable'});pending[2]({status:'unavailable'});
    await Promise.all([first,third,stopping]);assert.equal(closed,true);
    assert.equal(runtime.snapshot().account.trades.length,0);
  } finally {pending.forEach(resolve=>resolve({status:'unavailable'}));await runtime.stop();}
});

test('all configured chains rotate fairly, share one balance and global position cap, and preserve the old ledger', async t => {
  const dataDir = await directory(t), calls = [], chains = ['robinhood', 'base', 'bsc'];
  const feed = { ...market(), trenches: async ({ chain }) => { calls.push(chain); return { status: 'ok', observedAt: iso(NOW), tokens: [{ ...token, chain }] }; } };
  const options = { dataDir, market: feed, now: () => NOW, evidenceLoader: () => multiSources(chains) };
  const old = createPaperStrategyRuntime(options);
  await old.runOnce(); const priorTrade = old.snapshot().account.trades[0]; await old.stop();
  const runtime = createPaperStrategyRuntime({ ...options, chains });
  try {
    for (let i = 0; i < 3; i++) await runtime.runOnce();
    const result = runtime.snapshot();
    assert.deepEqual(calls, ['robinhood', ...chains]); assert.deepEqual(result.chains, chains);
    assert.equal(result.account.initialCash, 100); assert.equal(result.account.cash, 92);
    assert.equal(result.account.trades.length, 2); assert.deepEqual(result.account.trades[0], JSON.parse(JSON.stringify(priorTrade)));
    assert.deepEqual(Object.keys(result.account.positions).sort(), [`base:${CA}`, `robinhood:${CA}`]);
    assert.equal(result.chainCoverage.bsc.candidates, 1); assert.equal(result.evaluations.filter(row => row.token.chain === 'bsc').length, 4); assert.equal(result.execution, false);
    assert.deepEqual(JSON.parse(await fs.readFile(runtime.stateFile, 'utf8')).chains, chains);
  } finally { await runtime.stop(); }
  const narrow = createPaperStrategyRuntime(options);
  try { await assert.rejects(narrow.runOnce(), /仍有持仓/); } finally { await narrow.stop(); }
});

test('flow-only token enters research without rankings; only bound research plus original gates can enter', async t => {
  const dataDir = await directory(t); let clock = NOW, correct = false, requests = 0;
  const feed = { ...market(() => clock), trenches: async () => ({ status: 'ok', observedAt: iso(clock), tokens: [] }),
    details: async () => { requests++; return { status: 'ok', observedAt: iso(clock), token: { ...token, chain: correct ? 'robinhood' : 'base' } }; } };
  const runtime = createPaperStrategyRuntime({ dataDir, market: feed, now: () => clock, evidenceLoader: () => sources(clock) });
  try {
    await runtime.runOnce(); assert.equal(runtime.snapshot().chainCoverage.robinhood.flowDiscovered, 1);
    assert.equal(runtime.snapshot().account.trades.length, 0);
    await runtime.refreshDetails(); await runtime.runOnce(); assert.equal(runtime.snapshot().account.trades.length, 0);
    assert.equal(requests, 1); correct = true; clock += 61000;
    await runtime.refreshDetails(); await runtime.runOnce();
    assert.equal(runtime.snapshot().account.trades.length, 1); assert.equal(requests, 2);
    assert.equal(runtime.snapshot().account.cash, 96);
  } finally { await runtime.stop(); }
});

test('secondary discovery works without ranking while stale, malformed, foreign and blocked flow cannot seed candidates', () => {
  const rows = Array.from({ length: 6 }, (_, i) => binanceRow(i + 1));
  assert.equal(discoverPaperFlowCandidates({ evidence: { binanceState: stateFor(warmFeed(rows)), flowState: profilesFor(rows) }, chains: ['robinhood'], nowMs: BINANCE_NOW })[0].flow.highProfitCount, 6);
  for (const mutate of [e => { e.flowState.trades.robinhood.forEach(row => { row.chain = 'base'; }); },
    e => { e.flowState.trades.robinhood.forEach(row => { row.tags = ['wash_trader']; }); },
    e => { e.flowState.trades.robinhood.forEach(row => { row.at = NOW - 301000; }); },
    e => { e.flowState.trades.robinhood.forEach(row => { row.hash = 'bad'; }); }]) {
    const evidence = sources(); mutate(evidence);
    assert.deepEqual(discoverPaperFlowCandidates({ evidence, chains: ['robinhood'], nowMs: NOW }), []);
  }
});

test('multi-chain control/student comparisons never acquire a foreign-chain position', async t => {
  const dataDir = await directory(t), chains = ['robinhood', 'base'];
  const feed = { ...market(), trenches: async ({ chain }) => ({ status: 'ok', observedAt: iso(NOW), tokens: [{ ...token, chain }] }) };
  const policy = { version: '1234567890abcdef', chain: 'robinhood', group: 'gmgn_fomo', maxHoldMs: 120000, lossCutRate: .08,
    teacherCount: 3, matchedSells: 30, trainedAt: iso(NOW), trainingEndAt: iso(NOW - 1000) };
  const runtime = createPaperStrategyRuntime({ dataDir, market: feed, chains, now: () => NOW, evidenceLoader: () => multiSources(chains), learningLoader: () => ({ policies: [policy] }) });
  try {
    await runtime.runOnce(); await runtime.runOnce(); const s = runtime.snapshot();
    assert.equal(Object.keys(s.account.positions).length, 2);
    assert.equal(s.learningComparison.control.positions.length, 1); assert.equal(s.learningComparison.student.positions.length, 1);
    assert.equal(s.learningComparison.control.positions[0].chain, 'robinhood');
  } finally { await runtime.stop(); }
});

test('flow enrichment is single-flight, fair by chain and never holds the fast ledger queue', async t => {
  const dataDir = await directory(t), chains = ['robinhood', 'base']; let clock = NOW, release; const calls = [];
  const feed = { ...market(), trenches: async () => ({ status: 'ok', tokens: [] }),
    details: item => { calls.push(item.chain); return new Promise(resolve => { release = resolve; }); } };
  const runtime = createPaperStrategyRuntime({ dataDir, market: feed, chains, now: () => clock, evidenceLoader: () => multiSources(chains, clock) });
  try {
    await runtime.runOnce(); const pending = runtime.refreshDetails(); await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 3; i++) await runtime.fastOnce();
    assert.deepEqual(calls, ['robinhood']); assert.equal(runtime.snapshot().cadence.tickCount, 4);
    release({ status: 'unavailable' }); await pending; clock += 11000;
    const second = runtime.refreshDetails(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['robinhood', 'base']); release({ status: 'unavailable' }); await second;
  } finally { release?.({ status: 'unavailable' }); await runtime.stop(); }
});
function sources(nowMs = NOW) {
  const profiles = {}, trades = [];
  for (let i = 1; i <= 6; i++) {
    const wallet = `0x${String(i).repeat(40)}`;
    trades.push({ chain: 'robinhood', tokenAddress: CA, wallet, side: 'buy', amountUsd: 1000, at: nowMs - 1000, hash: `0x${String(i).repeat(64)}`, tags: ['smart_degen', 'fomo'] });
    profiles[`robinhood:${wallet}`] = Object.fromEntries(['7d', '30d'].map(period => [period, { chain: 'robinhood', wallet, period, checkedAt: iso(nowMs), realizedProfitUsd: 20000, realizedRoi: .1, winRate: .8, tokenCount: 120, tags: [], createdAt: Math.floor(nowMs / 1000) - 40 * 86400, lastTradeAt: Math.floor(nowMs / 1000) - 60, createdTokenCount: 0 }]));
  }
  const feedCoverage=Object.fromEntries(['smartmoney','kol'].map(k=>[k,{valid:true,startAt:nowMs-360000,endAt:nowMs,observedAt:nowMs,keys:[]}]));
  return { flowState: { chains: { robinhood: { status: 'healthy', lastSuccessAt: iso(nowMs), feedTruncated: false,feedCoverage } }, trades: { robinhood: trades }, profiles }, events: [] };
}
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yesp-strategy-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
function market(now = () => NOW) {
  return {
    trending: async () => ({ status: 'ok', observedAt: iso(now()), tokens: [] }),
    trenches: async () => ({ status: 'ok', observedAt: iso(now()), tokens: [token] }),
    kline: async () => ({ status: 'ok', candles: candles(now()) }),
  };
}

test('confirmed entry focus defers unrelated details and auxiliary reads but keeps minute discovery and resumes after twenty seconds', async t => {
  let clock=NOW;const calls={details:0,auxiliary:0,minute:0};const chains=['robinhood','base'];
  const feed={...market(()=>clock),
    trending:async()=>{calls.minute++;return {status:'ok',observedAt:iso(clock),tokens:[]};},
    trenches:async({chain})=>{calls.auxiliary++;return {status:'ok',observedAt:iso(clock),tokens:[{...token,chain,...(chain==='base'?{buyTax:null}:{})}]};},
    details:async()=>{calls.details++;return {status:'unavailable'};},
    quote:async()=>({status:'unavailable'})};
  const runtime=createPaperStrategyRuntime({dataDir:await directory(t),market:feed,chains,now:()=>clock,
    pvpMode:true,allowExploratory:true,confirmedMode:true,fixedEntryUsd:10,evidenceLoader:()=>multiSources(chains,clock)});
  try {
    await runtime.runOnce();await runtime.runOnce();const before={...calls};
    await runtime.fastOnce();await runtime.refreshDetails();await runtime.refreshMarket({background:true});
    let s=runtime.snapshot();assert.equal(s.researchPipeline.entryFocus?.active,true);
    assert.equal(calls.details,0,'unrelated missing safety is deferred, not invented');
    assert.equal(calls.auxiliary,before.auxiliary);assert.equal(calls.minute,before.minute+1,'minute chain scans never stop');
    clock+=20000;await runtime.fastOnce();await runtime.refreshDetails();await runtime.refreshMarket({background:true});
    s=runtime.snapshot();assert.equal(s.researchPipeline.entryFocus.active,false);
    assert.equal(calls.details,1,'mandatory discovery interval restores unrelated research');
    assert.equal(calls.auxiliary,before.auxiliary+1);
    assert.equal(s.account.trades.length,0);assert.equal(s.account.cash,100,'focus is not a buy permission');
    clock+=10000;await runtime.fastOnce();assert.equal(runtime.snapshot().researchPipeline.entryFocus.active,true);
    await runtime.setEnabled(false);await runtime.fastOnce();
    assert.equal(runtime.snapshot().researchPipeline.entryFocus.active,false,'paused entries cannot reserve request capacity');
    for(const flag of ['execution','signing','broadcast'])assert.equal(runtime.snapshot()[flag],false);
  } finally {await runtime.stop();}
});

test('higher research cadence admits two distinct Plus charts while Free/downgrade remain serial and stop drains both',async t=>{
  for(const plan of ['plus','free'])await t.test(plan,async t=>{
    const dataDir=await directory(t),planFile=path.join(dataDir,'gmgn-readonly-plan.json');
    await fs.writeFile(planFile,JSON.stringify({version:1,plan}));
    let clock=NOW;const calls=[],chains=['base','bsc','robinhood'];
    const feed={trending:async({chain})=>({status:'ok',observedAt:iso(clock),tokens:[{...token,chain,marketStage:'external',volume:10000}]}),
      trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),quote:async()=>({status:'unavailable'}),
      kline:target=>new Promise(resolve=>calls.push({target,resolve}))};
    const runtime=createPaperStrategyRuntime({dataDir,market:feed,chain:'base',chains,now:()=>clock,evidenceLoader:()=>({}),
      allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,opportunityMode:true,higherFrequencyResearch:true});
    try{
      for(let i=0;i<3;i++)await runtime.refreshMarket({background:true});
      await runtime.fastOnce();assert.equal(calls.length,1);
      clock+=2500;await runtime.fastOnce();assert.equal(calls.length,plan==='plus'?2:1);
      clock+=2500;await runtime.fastOnce();assert.equal(calls.length,plan==='plus'?2:1);
      assert.equal(new Set(calls.map(c=>`${c.target.chain}:${c.target.address}`)).size,calls.length);
      await fs.writeFile(planFile,JSON.stringify({version:1,plan:'free'}));clock+=10000;await runtime.fastOnce();
      assert.equal(calls.length,plan==='plus'?2:1);assert.equal(runtime.snapshot().researchPipeline.chartConcurrency,1);
      let drained=false;const stopping=runtime.stop().then(()=>{drained=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
      calls.forEach(c=>c.resolve({status:'unavailable'}));await stopping;
      assert.equal(runtime.snapshot().account.trades.length,0);
    }finally{calls.forEach(c=>c.resolve({status:'unavailable'}));await runtime.stop();}
  });
});

test('hundred-fill counter starts after existing trades, counts an exit, survives restart and isolates corrupt review state',async t=>{
  const dataDir=await directory(t);let clock=NOW;
  const seed=createPaperStrategyRuntime({dataDir,market:market(),now:()=>clock,evidenceLoader:()=>sources(clock)});
  await seed.runOnce();await seed.stop();
  const feed={...market(()=>clock),quote:async({chain,address})=>({chain,address,status:'ok',price:.7,observedAt:iso(clock)})};
  const options={dataDir,market:feed,now:()=>clock,evidenceLoader:()=>({}),tradeReviewEvery:100};
  let runtime=createPaperStrategyRuntime(options);
  try{
    await runtime.setEnabled(false);assert.equal(runtime.snapshot().tradeCountReview.baselineTradeCount,1);
    await runtime.refreshQuote();clock+=1000;await runtime.exitOnce();await runtime.fastOnce();
    assert.equal(runtime.snapshot().tradeCountReview.pendingFills,1);assert.equal(runtime.snapshot().account.trades.length,2);
    await runtime.stop();runtime=createPaperStrategyRuntime(options);await runtime.runOnce();
    assert.equal(runtime.snapshot().tradeCountReview.pendingFills,1);assert.equal(runtime.snapshot().tradeCountReview.completedBatches,0);
    await runtime.stop();const ledger=JSON.parse(await fs.readFile(runtime.stateFile,'utf8'));
    ledger.tradeCountReview.processedHash='bad';await fs.writeFile(runtime.stateFile,JSON.stringify(ledger));
    runtime=createPaperStrategyRuntime(options);await runtime.runOnce();
    assert.equal(runtime.snapshot().status,'ok');assert.equal(runtime.snapshot().tradeCountReview.status,'error');
    assert.equal(runtime.snapshot().account.trades.length,2);
    assert.equal(JSON.parse(await fs.readFile(runtime.stateFile,'utf8')).tradeCountReview.processedHash,'bad','bad checkpoint is preserved, never silently reset');
  }finally{await runtime.stop();}
});

test('running confirmed engine immediately admits only a newly selected candidate, not repeated ticks or holding-only scans', async t => {
  for(const holdingOnly of [false,true]) await t.test(`holdingOnly=${holdingOnly}`,async t=>{
    const dataDir=await directory(t);let calls=0;
    if(holdingOnly){const seed=createPaperStrategyRuntime({dataDir,market:market(),now:()=>NOW,evidenceLoader:()=>sources()});
      await seed.runOnce();await seed.stop();}
    t.mock.timers.enable({apis:['setTimeout']});
    const feed={...market(),trending:async()=>({status:'ok',observedAt:iso(NOW),tokens:holdingOnly?[]:[token]}),
      quote:async()=>{calls++;return {status:'unavailable'};}};
    const runtime=createPaperStrategyRuntime({dataDir,market:feed,now:()=>NOW,pvpMode:true,allowExploratory:true,
      confirmedMode:true,fixedEntryUsd:10,evidenceLoader:()=>holdingOnly?{}:sources()});
    try{
      await runtime.start();await runtime.refreshMarket({background:true});await runtime.fastOnce();
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(calls,holdingOnly?0:1,'new candidate is admitted before any timer fires; holdings retain their ordinary timer');
      await runtime.fastOnce();await runtime.fastOnce();await new Promise(resolve=>setImmediate(resolve));
      assert.equal(calls,holdingOnly?0:1,'local evaluations cannot amplify quote request frequency');
      assert.equal(runtime.snapshot().account.trades.length,holdingOnly?1:0);
    }finally{await runtime.stop();t.mock.timers.reset();}
  });
});

test('fresh ranking with missing safety is researched immediately and newer rankings retain fresh supplements', async t => {
  const dataDir = await directory(t); let clock = NOW, requests = 0;
  const feed = { ...market(() => clock), trenches: async () => ({ status: 'ok', observedAt: iso(clock), tokens: [{ ...token, rugRatio: null }] }),
    details: async item => { requests++; assert.equal(item.purpose, 'candidate'); return { status: 'ok', observedAt: iso(clock),
      token: { chain: token.chain, address: CA, rugRatio: .01, marketStage: 'unknown' } }; },
    quote: async () => ({ status: 'unavailable' }) };
  const runtime = createPaperStrategyRuntime({ dataDir, market: feed, now: () => clock, evidenceLoader: () => sources(clock) });
  try {
    await runtime.runOnce(); assert.equal(runtime.snapshot().cadence.detailTargets, 1); assert.equal(runtime.snapshot().account.trades.length, 0);
    await runtime.refreshDetails(); clock += 2000; await runtime.runOnce();
    const s = runtime.snapshot(), entry = s.evaluations.find(row => row.strategyId === 'internal');
    assert.equal(requests, 1); assert.equal(entry.evidence.safety.metrics.rugRatio, .01);
    assert.equal(entry.evidence.marketStage, 'internal'); assert.equal(entry.evidence.marketObservedAt, iso(NOW));
    assert.equal(s.researchPipeline.detailsSucceeded, 1); assert.equal(s.account.trades.length, 0, 'supplement alone is not a quote');
    clock += 121000; await runtime.runOnce();
    assert.ok(runtime.snapshot().evaluations[0].missing.includes('撤池风险比'), 'expired supplement cannot survive a newer ranking');
  } finally { await runtime.stop(); }
});

test('unloaded charts do not claim near-entry priority while unseen-chain research progresses', async t => {
  const dataDir = await directory(t), chains = ['base', 'robinhood']; let clock = NOW; const calls = [];
  const feed = { ...market(() => clock), trenches: async ({ chain }) => ({ status: 'ok', observedAt: iso(clock - 61000), tokens: chain === 'robinhood' ? [token] : [] }),
    details: async item => { calls.push(item.chain); return { status: 'ok', observedAt: iso(clock), token: { ...token, chain: item.chain } }; },
    quote: async () => ({ status: 'unavailable' }) };
  const runtime = createPaperStrategyRuntime({ dataDir, market: feed, chain: 'base', chains, now: () => clock, evidenceLoader: () => multiSources(chains, clock) });
  try {
    await runtime.runOnce(); await runtime.runOnce();
    assert.equal(runtime.snapshot().researchPipeline.nearEntryRefreshPending, 0);
    await runtime.refreshDetails(); assert.deepEqual(calls, ['base']);
    clock += 11000; await runtime.fastOnce(); await runtime.refreshDetails();
    assert.deepEqual(calls, ['base'],'complete fields waiting for a chart must not trigger another detail refresh');
    assert.equal(runtime.snapshot().account.trades.length, 0);
  } finally { await runtime.stop(); }
});

test('recovering flow can prefetch safety and charts but cannot request entry quotes or trade before completeness', async t => {
  const evidence = sources();
  for (const v of Object.values(evidence.flowState.chains.robinhood.feedCoverage)) v.startAt = NOW - 60_000;
  let detailCalls = 0, chartCalls = 0, quoteCalls = 0;
  const feed = { ...market(),
    trenches: async () => ({ status: 'ok', observedAt: iso(NOW), tokens: [{ ...token, buyTax: null }] }),
    details: async () => { detailCalls++; return { status: 'ok', observedAt: iso(NOW), token }; },
    kline: async () => { chartCalls++; return { status: 'ok', candles: candles(NOW) }; },
    quote: async ({ chain, address }) => { quoteCalls++; return { status: 'ok', chain, address, price: 1, observedAt: iso(NOW) }; } };
  const runtime = createPaperStrategyRuntime({ dataDir: await directory(t), market: feed, now: () => NOW, evidenceLoader: () => evidence });
  try {
    await runtime.runOnce(); await runtime.refreshDetails(); await runtime.runOnce(); await runtime.refreshQuote();
    assert.equal(detailCalls, 1); assert.equal(chartCalls, 1);
    assert.equal(quoteCalls, 0); assert.equal(runtime.snapshot().account.trades.length, 0);
    for (const v of Object.values(evidence.flowState.chains.robinhood.feedCoverage)) v.startAt = NOW - 360_000;
    await runtime.runOnce(); await runtime.refreshQuote(); await runtime.fastOnce();
    assert.equal(quoteCalls, 1); assert.equal(runtime.snapshot().account.trades.length, 1);
    assert.equal(chartCalls, 1, 'complete flow reuses the still-fresh prefetched chart');
  } finally { await runtime.stop(); }
});

test('missing charts cannot consume the candidate quote queue', async t => {
  let quoteCalls = 0;
  const runtime = createPaperStrategyRuntime({ dataDir: await directory(t), market: { ...market(),
    kline: async () => ({ status: 'unavailable', candles: [] }), quote: async () => { quoteCalls++; return { status: 'unavailable' }; } },
    now: () => NOW, evidenceLoader: () => sources() });
  try {
    await runtime.runOnce(); await runtime.refreshQuote();
    assert.equal(runtime.snapshot().cadence.quoteTargets, 0); assert.equal(quoteCalls, 0);
    assert.equal(runtime.snapshot().account.trades.length, 0);
  } finally { await runtime.stop(); }
});

test('upside runtime freezes new exits, keeps learning controls unchanged, and restores through mode rollback', async t => {
  const dataDir = await directory(t); let clock = NOW, price = 1;
  const feed = { ...market(() => clock), trenches: async () => ({ status: 'ok', observedAt: iso(clock), tokens: [{ ...token, price }] }) };
  const learned = { version: '1234567890abcdef', chain: 'robinhood', group: 'gmgn_fomo', maxHoldMs: 120000, lossCutRate: .08,
    teacherCount: 3, matchedSells: 30, trainedAt: iso(NOW), trainingEndAt: iso(NOW - 1000) };
  const options = { dataDir, market: feed, now: () => clock, evidenceLoader: () => sources(clock),
    learningLoader: () => ({ policies: [learned] }), compoundEntries: true };
  const runtime = createPaperStrategyRuntime({ ...options, upsideMode: true });
  let quantity;
  try {
    await runtime.runOnce(); const s = runtime.snapshot(), p = Object.values(s.account.positions)[0]; quantity = p.quantity;
    assert.equal(s.exitPolicy.version, 'asymmetric_upside_v1'); assert.equal(s.exitPolicy.runnerFraction, .4);
    assert.equal(p.upsidePolicy.version, s.exitPolicy.version);
    assert.equal(s.learningComparison.control.positions[0].upsidePolicy, undefined);
    assert.equal(s.learningComparison.student.positions[0].upsidePolicy, undefined);
    const disk = JSON.parse(await fs.readFile(runtime.stateFile, 'utf8'));
    for (const a of [disk.learningShadow.control, disk.learningShadow.student]) assert.equal(Object.values(a.positions)[0].entryEvidence.exitPolicy, undefined);
    clock += 1000; price = 3; await runtime.runOnce();
    assert.equal(runtime.snapshot().account.trades.length, 2);
    assert.ok(Math.abs(Object.values(runtime.snapshot().account.positions)[0].quantity - quantity * .8) < 1e-8);
  } finally { await runtime.stop(); }
  const restored = createPaperStrategyRuntime({ ...options, upsideMode: false });
  try {
    clock += 1000; price = 10; await restored.runOnce(); const s = restored.snapshot(), p = Object.values(s.account.positions)[0];
    assert.equal(s.exitPolicy, null); assert.equal(p.upsidePolicy.version, 'asymmetric_upside_v1');
    assert.deepEqual(p.profitTiersTaken, [3, 10]); assert.ok(Math.abs(p.quantity - quantity * .6) < 1e-8);
    assert.equal(s.account.trades.length, 3); assert.equal(s.execution, false); assert.equal(s.signing, false); assert.equal(s.broadcast, false);
  } finally { await restored.stop(); }
});

test('learning waits for evidence, then runs isolated paired forward accounts with frozen exits and persistence', async t => {
  const dataDir = await directory(t); let clock = NOW, ready = false;
  const feed = market(() => clock);
  const learned = { version: '1234567890abcdef', chain: 'robinhood', group: 'gmgn_fomo', maxHoldMs: 120000, lossCutRate: .08,
    teacherCount: 3, matchedSells: 30, trainedAt: iso(NOW), trainingEndAt: iso(NOW - 1000) };
  const options = { dataDir, market: feed, now: () => clock, evidenceLoader: async () => sources(clock), learningLoader: () => ({ policies: ready ? [learned] : [] }) };
  const runtime = createPaperStrategyRuntime(options);
  try {
    await runtime.runOnce(); assert.equal(runtime.snapshot().account.cash, 96); assert.equal(runtime.snapshot().learningComparison.student, null);
    ready = true; clock += 1000; await runtime.runOnce();
    const started = runtime.snapshot(), pair = started.learningComparison;
    assert.equal(started.account.cash, 96); assert.equal(started.account.trades.length, 1); assert.equal(pair.control.cash, 96); assert.equal(pair.student.cash, 96);
    assert.equal(pair.student.positions[0].distilledHabit.version, learned.version); assert.equal(pair.control.positions[0].distilledHabit, undefined);
    await runtime.setEnabled(false); ready = false; clock += 121000;
    feed.trenches = async () => ({ status: 'ok', observedAt: iso(clock), tokens: [] });
    feed.kline = async () => ({ status: 'ok', candles: [{ time: clock, close: 1 }] });
    await runtime.runOnce(); const result = runtime.snapshot();
    assert.equal(Object.keys(result.account.positions).length, 1); assert.equal(result.learningComparison.control.positions.length, 1);
    assert.equal(result.learningComparison.student.positions.length, 0); assert.match(result.learningComparison.student.trades.at(-1).reason, /蒸馏模拟：持仓期限/);
    assert.equal(result.learningComparison.promotion, false); assert.equal(result.account.execution, false);
  } finally { await runtime.stop(); }
  const restored = createPaperStrategyRuntime(options);
  try { await restored.runOnce(); assert.equal(restored.snapshot().learningComparison.student.exits, 1); assert.equal(restored.snapshot().account.trades.length, 1); assert.equal(restored.snapshot().enabled, false); }
  finally { await restored.stop(); }
});

test('failed or wrong-chain learning evidence never opens shadow positions or changes main rules', async t => {
  const dataDir = await directory(t);
  const runtime = createPaperStrategyRuntime({ dataDir, market: market(), now: () => NOW, evidenceLoader: async () => sources(),
    learningLoader: () => { throw new Error('bad report'); } });
  try { await runtime.runOnce(); assert.equal(runtime.snapshot().account.cash, 96); assert.equal(runtime.snapshot().learningComparison.student, null); }
  finally { await runtime.stop(); }
});

test('complete secondary flow with primary profit profiles enters paper once and records the selected source', async t => {
  const dataDir = await directory(t), rows = Array.from({ length: 6 }, (_, i) => binanceRow(i + 1));
  const binanceState = stateFor(warmFeed(rows)), flowState = profilesFor(rows);
  const runtime = createPaperStrategyRuntime({ dataDir, market: market(() => BINANCE_NOW), now: () => BINANCE_NOW,
    evidenceLoader: async () => ({ flowState, binanceState, events: [] }) });
  try {
    await runtime.runOnce(); await runtime.runOnce(); const result = runtime.snapshot();
    assert.equal(result.account.trades.length, 1); assert.equal(result.account.trades[0].entryEvidence.flowDiagnostics.provider, 'binance_kol');
    assert.equal(result.account.trades[0].entryEvidence.flow.netBuyUsd, 6000); assert.equal(result.account.trades[0].entryEvidence.flow.fomoCount, null);
    assert.equal(result.execution, false); assert.equal(result.signing, false); assert.equal(result.broadcast, false);
    assert.equal(result.coverage.flow.sources.length, 3);
  } finally { await runtime.stop(); }
});

test('secondary labels without primary profitability profiles cannot open paper positions', async t => {
  const dataDir = await directory(t), rows = Array.from({ length: 6 }, (_, i) => binanceRow(i + 1));
  const runtime = createPaperStrategyRuntime({ dataDir, market: market(() => BINANCE_NOW), now: () => BINANCE_NOW,
    evidenceLoader: async () => ({ binanceState: stateFor(warmFeed(rows)), events: [] }) });
  try { await runtime.runOnce(); assert.equal(runtime.snapshot().account.trades.length, 0); }
  finally { await runtime.stop(); }
});

test('opt-in v2 researches a single smart buyer at $200, waits for a real quote, and leaves standard shadows unchanged', async t => {
  const dataDir = await directory(t), evidence = sources(); let staleQuote = true, calls = 0;
  evidence.flowState.profiles = {};
  evidence.flowState.trades.robinhood = evidence.flowState.trades.robinhood.slice(0, 1).map(r => ({ ...r, amountUsd: 200 }));
  const learned = { version: '1234567890abcdef', chain: 'robinhood', group: 'gmgn_fomo', maxHoldMs: 120000, lossCutRate: .08,
    teacherCount: 3, matchedSells: 30, trainedAt: iso(NOW), trainingEndAt: iso(NOW - 1000) };
  const feed = { ...market(), trenches: async () => ({ status: 'ok', tokens: [], observedAt: iso(NOW) }),
    details: async () => { calls++; return { status: 'ok', token, observedAt: iso(NOW) }; },
    quote: async ({ chain, address }) => ({ chain, address, price: 1, status: 'ok', observedAt: iso(NOW - (staleQuote ? 16000 : 0)) }) };
  const options = { dataDir, market: feed, now: () => NOW, evidenceLoader: () => evidence, allowExploratory: true, learningLoader: () => ({ policies: [learned] }) };
  assert.throws(() => createPaperStrategyRuntime({ ...options, allowExploratory: 'true' }), /entry mode/);
  const runtime = createPaperStrategyRuntime(options);
  try {
    await runtime.runOnce(); assert.equal(runtime.snapshot().cadence.detailTargets, 1);
    await runtime.refreshDetails(); await runtime.runOnce(); assert.equal(calls, 1);
    assert.equal(runtime.snapshot().cadence.quoteTargets, 1);
    await runtime.refreshQuote(); await runtime.fastOnce(); assert.equal(runtime.snapshot().account.trades.length, 0);
    staleQuote = false; await runtime.refreshQuote(); await runtime.fastOnce();
    const result = runtime.snapshot();
    assert.equal(result.entryMode, 'standard_and_exploratory'); assert.equal(result.account.cash, 98);
    assert.equal(result.entryPolicyVersion, 'paper_exploration_v2');
    assert.equal(result.account.trades.length, 1); assert.equal(result.account.trades[0].entryEvidence.flow.highProfitCount, 0);
    assert.equal(result.account.trades[0].entryEvidence.entryTier, 'exploratory');
    assert.equal(result.learningComparison.control.entries, 0); assert.equal(result.learningComparison.student.entries, 0);
    assert.equal(result.signing, false); assert.equal(result.broadcast, false);
    await runtime.fastOnce(); assert.equal(runtime.snapshot().account.trades.length, 1);
  } finally { await runtime.stop(); }
  const restored = createPaperStrategyRuntime({ ...options, allowExploratory: false });
  try { await restored.runOnce(); assert.equal(restored.snapshot().account.cash, 98); assert.equal(restored.snapshot().account.trades.length, 1); }
  finally { await restored.stop(); }
});

test('v2 research does not turn dust, KOL-only or unverified flow into smart-money evidence', async t => {
  for (const kind of ['below_minimum', 'kol_only', 'partial', 'standard_mode']) {
    const evidence = sources(); evidence.flowState.profiles = {};
    evidence.flowState.trades.robinhood = evidence.flowState.trades.robinhood.slice(0, 1)
      .map(r => ({ ...r, amountUsd: kind === 'below_minimum' ? 199.99 : 200, tags: kind === 'kol_only' ? ['kol'] : ['smart_degen'] }));
    if (kind === 'partial') evidence.flowState.chains.robinhood.feedCoverage.smartmoney.valid = false;
    let requests = 0;
    const feed = { ...market(), trenches: async () => ({ status: 'ok', tokens: [], observedAt: iso(NOW) }),
      details: async () => { requests++; return { status: 'ok', token, observedAt: iso(NOW) }; } };
    const runtime = createPaperStrategyRuntime({ dataDir: await directory(t), market: feed, now: () => NOW,
      evidenceLoader: () => evidence, allowExploratory: kind !== 'standard_mode' });
    try {
      await runtime.runOnce(); await runtime.refreshDetails();
      assert.equal(runtime.snapshot().cadence.detailTargets, 0, kind);
      assert.equal(requests, 0, kind); assert.equal(runtime.snapshot().account.trades.length, 0, kind);
    } finally { await runtime.stop(); }
  }
});

test('compounding preview follows cash, retains fixed-size shadow experiments and restores the same ledger', async t => {
  const dataDir = await directory(t), chains = ['robinhood', 'base'];
  const learned = { version: '1234567890abcdef', chain: 'robinhood', group: 'gmgn_fomo', maxHoldMs: 120000, lossCutRate: .08,
    teacherCount: 3, matchedSells: 30, trainedAt: iso(NOW), trainingEndAt: iso(NOW - 1000) };
  const feed = { ...market(), trenches: async ({ chain }) => ({ status: 'ok', observedAt: iso(NOW), tokens: [{ ...token, chain }] }) };
  const options = { dataDir, market: feed, chains, now: () => NOW, evidenceLoader: () => multiSources(chains),
    compoundEntries: true, allowExploratory: true, learningLoader: () => ({ policies: [learned] }) };
  assert.throws(() => createPaperStrategyRuntime({ ...options, compoundEntries: 'true' }), /sizing mode/);
  const runtime = createPaperStrategyRuntime(options);
  try {
    await runtime.runOnce(); await runtime.runOnce(); const r = runtime.snapshot();
    assert.equal(r.positionSizing.mode, 'cash_fraction'); assert.equal(r.positionSizing.includesUnrealizedPnl, false);
    assert.deepEqual(r.account.trades.map(t => t.costBasisUsd), [4, 3.84]);
    assert.equal(r.account.cash, 92.16); assert.equal(r.positionSizing.cashBasis, 92.16);
    assert.equal(r.learningComparison.control.entries, 1); assert.equal(r.learningComparison.control.cash, 96);
    assert.equal(r.learningComparison.control.positions[0].entryEvidence.positionSizing, undefined);
    assert.equal(r.learningComparison.student.cash, 96);
    assert.equal(r.account.trades[1].entryEvidence.positionSizing.cashBeforeEntry, 96);
    assert.equal(r.execution, false); assert.equal(r.signing, false); assert.equal(r.broadcast, false);
  } finally { await runtime.stop(); }
  const restarted = createPaperStrategyRuntime({ ...options, compoundEntries: false });
  try { await restarted.runOnce(); assert.equal(restarted.snapshot().account.cash, 92.16); assert.equal(restarted.snapshot().account.trades.length, 2); }
  finally { await restarted.stop(); }
});

test('fixed-ten runtime exposes the active budget, passes cash and isolates learning budgets after restart', async t => {
  const dataDir = await directory(t), seen = [];
  const learned = { version: '1234567890abcdef', chain: 'robinhood', group: 'gmgn_fomo', maxHoldMs: 120000, lossCutRate: .08,
    teacherCount: 3, matchedSells: 30, trainedAt: iso(NOW), trainingEndAt: iso(NOW - 1000) };
  const options = { dataDir, market: { ...market(), quote: async () => ({ status: 'unavailable' }) }, now: () => NOW,
    evidenceLoader: () => sources(), allowExploratory: true, confirmedMode: true, pvpMode: true, fixedEntryUsd: 10,
    compoundEntries: false, learningLoader: () => ({ policies: [learned] }), evaluate: input => { seen.push(input); return []; } };
  assert.throws(() => createPaperStrategyRuntime({ ...options, fixedEntryUsd: 100 }), /fixed paper ticket/);
  assert.throws(() => createPaperStrategyRuntime({ ...options, confirmedMode: false }), /fixed paper ticket/);
  for (let i = 0; i < 2; i++) {
    const runtime = createPaperStrategyRuntime(options);
    try {
      await runtime.runOnce(); const s = runtime.snapshot();
      assert.equal(s.positionSizing.mode, 'fixed'); assert.equal(s.positionSizing.fixedEntryUsd, 10);
      assert.equal(s.positionSizing.version, 'fixed_ten_v1'); assert.equal(s.positionSizing.exactTicket, true);
      assert.equal(s.account.cash, 100); assert.equal(s.account.trades.length, 0);
      assert.equal(s.execution, false); assert.equal(s.signing, false); assert.equal(s.broadcast, false);
    } finally { await runtime.stop(); }
  }
  assert.ok(seen.some(input => input.confirmedMode && input.fixedEntryUsd === 10 && input.compoundingCash === 100));
  assert.ok(seen.some(input => !input.confirmedMode && input.fixedEntryUsd === null && input.compoundingCash === null));
});

test('server-side cycle opens from real-shaped evidence once, persists costs, and survives restart', async t => {
  const dataDir = await directory(t), feed = market(); let calls = 0;
  const original = feed.trenches; feed.trenches = async () => { calls++; return original(); };
  const runtime = createPaperStrategyRuntime({ market: feed, dataDir, now: () => NOW, evidenceLoader: async () => sources() });
  try {
    await Promise.all([runtime.runOnce(), runtime.runOnce(), runtime.runOnce()]);
    const result = runtime.snapshot();
    assert.equal(calls, 1); assert.equal(result.status, 'ok'); assert.equal(result.account.trades.length, 1);
    assert.equal(result.account.cash, 96); assert.equal(Object.keys(result.account.positions).length, 1);
    assert.equal(result.account.trades[0].strategyId, 'launch_sniper');
    assert.ok(result.account.trades[0].costsUsd > 0); assert.equal(result.execution, false);
    result.account.cash = 0; assert.equal(runtime.snapshot().account.cash, 96);
    await runtime.setEnabled(false); await runtime.runOnce(); assert.equal(runtime.snapshot().account.trades.length, 1);
  } finally { await runtime.stop(); }
  const restored = createPaperStrategyRuntime({ market: feed, dataDir, now: () => NOW + 1000, evidenceLoader: async () => sources() });
  try { await restored.runOnce(); assert.equal(restored.snapshot().enabled, false); assert.equal(restored.snapshot().account.cash, 96); assert.equal(restored.snapshot().account.trades.length, 1); }
  finally { await restored.stop(); }
});

test('existing malformed, null or false account files fail closed without reset', async t => {
  const dataDir = await directory(t), file = path.join(dataDir, 'yesp-atm-strategy-paper.json');
  for (const contents of ['null', 'false', '0', '""', '{broken', '{}']) {
    await fs.writeFile(file, contents);
    const runtime = createPaperStrategyRuntime({ market: market(), dataDir, now: () => NOW });
    try { await assert.rejects(runtime.runOnce()); assert.equal(runtime.snapshot().status, 'error'); assert.equal(await fs.readFile(file, 'utf8'), contents); }
    finally { await runtime.stop(); }
  }
});

test('a second runtime cannot write an account locked by a live process', async t => {
  const dataDir = await directory(t);
  const first = createPaperStrategyRuntime({ market: market(), dataDir, now: () => NOW, evidenceLoader: async () => sources() });
  const second = createPaperStrategyRuntime({ market: market(), dataDir, now: () => NOW, evidenceLoader: async () => sources() });
  try { await first.runOnce(); await assert.rejects(second.runOnce(), /已有进程运行/); assert.equal(first.snapshot().account.cash, 96); }
  finally { await second.stop(); await first.stop(); }
});

test('paused entries still stop out an existing holding absent from rankings using fresh kline', async t => {
  const dataDir = await directory(t); let clock = NOW;
  const feed = market(() => clock);
  const runtime = createPaperStrategyRuntime({ market: feed, dataDir, now: () => clock, evidenceLoader: async () => sources(clock) });
  try {
    await runtime.runOnce(); await runtime.setEnabled(false); clock += 61000;
    feed.trenches = async () => ({ status: 'ok', observedAt: iso(clock), tokens: [] });
    feed.kline = async () => ({ status: 'ok', candles: [{ time: clock, close: .7 }] });
    await runtime.runOnce(); const result = runtime.snapshot();
    assert.equal(result.enabled, false); assert.equal(result.account.trades.length, 2);
    assert.equal(result.account.trades[1].reason, '价格止损'); assert.ok(result.account.realizedPnl < 0);
    assert.equal(Object.keys(result.account.positions).length, 0);
  } finally { await runtime.stop(); }
});

test('partial flow and stale market snapshots are observable but never enter a position', async t => {
  const dataDir = await directory(t), evidence = sources();
  Object.assign(evidence.flowState.chains.robinhood, { status: 'partial', coverageGap: 'ambiguous_trade_legs' });
  delete evidence.flowState.chains.robinhood.feedCoverage;
  const feed = market(); let chartCalls = 0; feed.kline = async () => { chartCalls++; return { status: 'ok', candles: candles(NOW) }; };
  const runtime = createPaperStrategyRuntime({ market: feed, dataDir, now: () => NOW, evidenceLoader: async () => evidence });
  try { await runtime.runOnce(); const result = runtime.snapshot(); assert.equal(result.account.trades.length, 0); assert.equal(result.coverage.flow.complete, false); assert.ok(result.evaluations.every(e => e.decision !== '可模拟')); assert.equal(chartCalls, 0); }
  finally { await runtime.stop(); }
});

test('final decision rechecks five-minute evidence window after slow chart request', async t => {
  const dataDir = await directory(t); let clock = NOW; const evidence = sources();
  evidence.flowState.trades.robinhood.forEach(trade => { trade.at = NOW - 299000; });
  const feed = market(() => clock); feed.kline = async () => { clock += 2000; return { status: 'ok', candles: candles(clock) }; };
  const runtime = createPaperStrategyRuntime({ market: feed, dataDir, now: () => clock, evidenceLoader: async () => evidence });
  try { await runtime.runOnce(); assert.equal(runtime.snapshot().account.trades.length, 0); assert.equal(runtime.snapshot().evaluations[0].evidence.flow.uniqueBuyerCount, 0); }
  finally { await runtime.stop(); }
});

test('live-shaped exit flow is passed through holding marks and its confirmation survives restart', async t => {
  const dataDir = await directory(t); let clock = NOW, selling = false;
  const evidenceLoader = async () => {
    const evidence = sources(clock);
    if (selling) evidence.flowState.trades.robinhood.forEach(row => { row.side = 'sell'; });
    return evidence;
  };
  const feed = market(() => clock);
  let runtime = createPaperStrategyRuntime({ market: feed, dataDir, now: () => clock, evidenceLoader });
  try {
    await runtime.runOnce(); assert.equal(runtime.snapshot().strategyVersion, 'narrative_structure_v2');
    selling = true; clock += 1000; await runtime.runOnce();
    assert.equal(Object.values(runtime.snapshot().account.positions)[0].flowExitWatch.count, 1);
    await runtime.stop();
    clock += 30000;
    runtime = createPaperStrategyRuntime({ market: feed, dataDir, now: () => clock, evidenceLoader });
    await runtime.runOnce();
    assert.equal(runtime.snapshot().account.trades.at(-1).reason, '聪明钱连续净卖出，买入逻辑失效');
    assert.equal(Object.keys(runtime.snapshot().account.positions).length, 0);
  } finally { await runtime.stop(); }
});

test('Plus quote lanes let a candidate fill while a held quote is pending and drain both on stop', async t => {
  const dataDir = await directory(t);
  await fs.writeFile(path.join(dataDir, 'gmgn-readonly-plan.json'), JSON.stringify({version:1,plan:'plus'}));
  const seed = createPaperStrategyRuntime({dataDir,market:market(),now:()=>NOW,evidenceLoader:()=>sources()});
  await seed.runOnce(); assert.equal(seed.snapshot().account.trades.length,1); await seed.stop();
  let clock=NOW; const calls=[];
  const feed={...market(()=>clock),
    trenches:async({chain})=>({status:'ok',observedAt:iso(clock),tokens:chain==='base'?[{...token,chain}]:[]}),
    quote:target=>new Promise(resolve=>calls.push({target,resolve}))};
  const runtime=createPaperStrategyRuntime({dataDir,market:feed,chains:['robinhood','base'],now:()=>clock,
    evidenceLoader:()=>multiSources(['base'],clock)});
  try {
    await runtime.runOnce(); await runtime.runOnce();
    assert.equal(runtime.snapshot().cadence.quoteTargets,2);
    const first=runtime.refreshQuote(); await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(calls.map(c=>c.target.purpose),['exit','candidate'],'a pending exit must not own the candidate lane');
    const duplicate=runtime.refreshQuote(); await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,2,'repeated pumps keep one request per lane and asset');
    clock+=4000;
    calls[1].resolve({...calls[1].target,status:'ok',price:1,observedAt:iso(clock)});
    await new Promise(resolve=>setImmediate(resolve)); await runtime.fastOnce();
    assert.equal(runtime.snapshot().account.trades.length,2,'fresh candidate can fill before the old holding response');
    assert.equal(runtime.snapshot().account.trades.at(-1).chain,'base');
    for(const flag of ['execution','signing','broadcast'])assert.equal(runtime.snapshot()[flag],false);
    let stopped=false; const stopping=runtime.stop().then(()=>{stopped=true;});
    await new Promise(resolve=>setImmediate(resolve)); assert.equal(stopped,false,'shutdown drains the pending exit');
    calls[0].resolve({...calls[0].target,status:'ok',price:1,observedAt:iso(clock)});
    await Promise.all([first,duplicate,stopping]);
    assert.equal(JSON.parse(await fs.readFile(runtime.stateFile,'utf8')).account.trades.length,2);
  } finally {for(const call of calls)call.resolve({status:'unavailable'});await runtime.stop();}
});

test('quote lane isolation is bidirectional, bounded and respects Free or a Plus downgrade', async t => {
  for (const plan of ['plus','free']) await t.test(plan,async t=>{
    const dataDir=await directory(t),planFile=path.join(dataDir,'gmgn-readonly-plan.json');
    await fs.writeFile(planFile,JSON.stringify({version:1,plan}));
    const seed=createPaperStrategyRuntime({dataDir,market:market(),now:()=>NOW,evidenceLoader:()=>sources()});
    await seed.runOnce();await seed.stop();
    let clock=NOW;const calls=[];
    const feed={...market(()=>clock),
      trenches:async({chain})=>({status:'ok',observedAt:iso(clock),tokens:chain==='base'?[{...token,chain}]:[]}),
      quote:target=>new Promise(resolve=>calls.push({target,resolve}))};
    const runtime=createPaperStrategyRuntime({dataDir,market:feed,chains:['robinhood','base'],now:()=>clock,
      evidenceLoader:()=>multiSources(['base'],clock)});
    try {
      await runtime.runOnce();await runtime.runOnce();
      const first=runtime.refreshQuote();await new Promise(resolve=>setImmediate(resolve));
      assert.equal(calls.length,plan==='plus'?2:1);
      const repeated=runtime.refreshQuote();await new Promise(resolve=>setImmediate(resolve));
      assert.equal(calls.length,plan==='plus'?2:1,'no duplicate request while lanes are occupied');
      if(plan==='plus') {
        calls[0].resolve({...calls[0].target,status:'ok',price:1,observedAt:iso(clock)});
        await new Promise(resolve=>setImmediate(resolve));clock+=8000;
        void runtime.refreshQuote();await new Promise(resolve=>setImmediate(resolve));
        assert.equal(calls.length,3);assert.equal(calls[2].target.purpose,'exit','a pending candidate cannot block the next exit quote');
        await fs.writeFile(planFile,JSON.stringify({version:1,plan:'free'}));
        void runtime.refreshQuote();await new Promise(resolve=>setImmediate(resolve));
        assert.equal(calls.length,3,'downgrade admits no new work until existing jobs drain');
      }
      for(const call of calls)call.resolve({status:'unavailable'});
      await Promise.all([first,repeated]);await runtime.fastOnce();
      assert.equal(runtime.snapshot().account.trades.length,1,'unavailable candidate cannot manufacture a fill');
      assert.equal(runtime.snapshot().cadence.quoteConcurrency,1);
    } finally {for(const call of calls)call.resolve({status:'unavailable'});await runtime.stop();}
  });
});

test('three holdings share bounded Plus exit slots without blocking a candidate or duplicating an asset', async t => {
  for (const plan of ['plus', 'free']) for (const withCandidate of [false, true]) {
    await t.test(`${plan}, candidate=${withCandidate}`, async t => {
      const dataDir = await directory(t), planFile = path.join(dataDir, 'gmgn-readonly-plan.json');
      await fs.writeFile(planFile, JSON.stringify({ version: 1, plan }));
      // Produce valid positions with the ordinary pure paper engine, in a test
      // directory only. No production ledger, credentials or live market reads.
      const evaluations = [1, 2, 3].map(id => {
        const held = { ...token, address: `0x${id.toString(16).padStart(40, '0')}`, price: 1.01 };
        return evaluatePaperStrategies({ nowMs: NOW, token: held, marketStatus: 'ok', observedAt: iso(NOW),
          priceObservedAt: iso(NOW), allowExploratory: true, pvpMode: true, confirmedMode: true,
          evidenceHoldMode: true, continuousPaperMode: true, compoundingCash: 100, fixedEntryUsd: 10,
          flow: { fresh: true, complete: true, status: 'healthy', observedAt: iso(NOW), highProfitCount: 0,
            fomoCount: 0, smartMoneyCount: 1, uniqueBuyerCount: 2, netBuyUsd: 600,
            pulse: { windowMs: 90000, recentBuyerCount: 2, recentNetBuyUsd: 600, lastBuyAt: NOW - 1 } },
          quoteHistory: [1, 1.006, 1.01].map((price, i) => ({ ...held, price, status: 'ok', observedAt: iso(NOW - (2-i)*6000) }))
        })[0];
      });
      const account = advancePaperStrategyAccount(createPaperStrategyAccount({ nowMs: NOW }),
        { evaluations, nowMs: NOW, confirmedMode: true, continuousPaperMode: true });
      assert.equal(Object.keys(account.positions).length, 3);
      const seed = createPaperStrategyRuntime({ dataDir, market: market(), now: () => NOW, evidenceLoader: () => ({}) });
      await seed.runOnce(); await seed.stop();
      const ledger = JSON.parse(await fs.readFile(seed.stateFile, 'utf8'));
      ledger.account = account;
      await fs.writeFile(seed.stateFile, JSON.stringify(ledger));
      let clock = NOW; const calls = [], pending = new Set();
      const feed = { ...market(() => clock),
        trenches: async () => ({ status: 'ok', observedAt: iso(clock), tokens: withCandidate ? [token] : [] }),
        quote: target => new Promise(resolve => { const call = { target, resolve: value => { pending.delete(call); resolve(value); } };
          calls.push(call); pending.add(call); }) };
      const runtime = createPaperStrategyRuntime({ dataDir, market: feed, now: () => clock,
        evidenceLoader: () => withCandidate ? sources(clock) : ({}) });
      try {
        await runtime.runOnce();
        const first = runtime.refreshQuote(); await new Promise(resolve => setImmediate(resolve));
        assert.equal(calls.filter(c => c.target.purpose === 'exit').length, plan === 'plus' ? 2 : 1,
          'multiple held assets must not serialize behind a single exit slot');
        assert.equal(calls.filter(c => c.target.purpose === 'candidate').length, plan === 'plus' && withCandidate ? 1 : 0);
        assert.ok(pending.size <= (plan === 'plus' ? 3 : 1));
        void runtime.refreshQuote(); await new Promise(resolve => setImmediate(resolve));
        assert.equal(calls.length, plan === 'plus' ? 2 + Number(withCandidate) : 1, 'pumps do not duplicate in-flight assets');
        const released = calls[0];
        released.resolve({ ...released.target, status: 'ok', price: 1.01, observedAt: iso(clock) });
        await new Promise(resolve => setImmediate(resolve)); clock += 1000;
        void runtime.refreshQuote(); await new Promise(resolve => setImmediate(resolve));
        assert.equal(calls.at(-1).target.purpose, 'exit');
        assert.notEqual(calls.at(-1).target.address, released.target.address, 'least-recently-attempted holding gets the free slot');
        assert.equal(new Set([...pending].map(c => `${c.target.chain}:${c.target.address}`)).size, pending.size);
        if (plan === 'plus') {
          await fs.writeFile(planFile, JSON.stringify({ version: 1, plan: 'free' }));
          const before = calls.length;
          void runtime.refreshQuote(); await new Promise(resolve => setImmediate(resolve));
          assert.equal(calls.length, before, 'downgrade cannot add work while the serial limit is exceeded');
        }
        let stopped = false; const stopping = runtime.stop().then(() => { stopped = true; });
        await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
        for (const call of pending) call.resolve({ status: 'unavailable' });
        await Promise.all([first, stopping]);
        const final = JSON.parse(await fs.readFile(runtime.stateFile, 'utf8'));
        assert.deepEqual(final.account.trades, JSON.parse(JSON.stringify(account.trades)), 'scheduling and unavailable responses cannot manufacture trades');
        for (const flag of ['execution', 'signing', 'broadcast']) assert.equal(final.account[flag], false);
      } finally { for (const call of pending) call.resolve({ status: 'unavailable' }); await runtime.stop(); }
    });
  }
});

test('two-second ticks and quote stop losses do not wait for a pending market refresh', async t => {
  const dataDir = await directory(t); let clock = NOW, price = 1, release;
  const feed = market(() => clock);
  feed.quote = async ({ chain, address }) => ({ chain, address, price, status: 'ok', observedAt: iso(clock) });
  const runtime = createPaperStrategyRuntime({ market: feed, dataDir, now: () => clock, evidenceLoader: async () => sources(clock) });
  try {
    await runtime.runOnce(); assert.equal(runtime.snapshot().account.trades.length, 0, 'independent quote required');
    await runtime.refreshQuote(); await runtime.fastOnce();
    assert.equal(runtime.snapshot().account.trades.length, 1);
    await Promise.all([runtime.fastOnce(), runtime.fastOnce()]);
    assert.equal(runtime.snapshot().account.trades.length, 1, 'same evidence never duplicates a position');
    feed.trending = () => new Promise(resolve => { release = resolve; });
    const pending = runtime.refreshMarket(); await new Promise(resolve => setImmediate(resolve));
    await runtime.setEnabled(false); price = .7; clock += 2000;
    await runtime.refreshQuote(); await runtime.fastOnce();
    const result = runtime.snapshot();
    assert.equal(result.cadence.evaluationIntervalMs, 1000); assert.equal(result.cadence.actualTickGapMs, 2000);
    assert.equal(result.cadence.marketRefreshPending, true);
    assert.equal(result.account.trades.length, 2); assert.equal(result.account.trades[1].reason, '价格止损');
    assert.equal(result.account.trades[1].price, .7); assert.equal(result.execution, false);
    release({ status: 'ok', tokens: [], observedAt: iso(clock) }); await pending;
  } finally { release?.({ status: 'unavailable', tokens: [] }); await runtime.stop(); }
});

test('a slow but still-fresh candidate quote triggers entry evaluation without waiting for the periodic tick', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const feed = { ...market(), quote: () => pending };
  const runtime = createPaperStrategyRuntime({ dataDir: await directory(t), market: feed, now: () => NOW,
    intervalMs: 60_000, pvpMode: true, evidenceLoader: () => sources() });
  try {
    await runtime.runOnce();
    await runtime.start(); await runtime.fastOnce();
    assert.equal(runtime.snapshot().account.trades.length, 0);
    const request = runtime.refreshQuote();
    release({ status: 'ok', chain: token.chain, address: CA, price: 1,
      queuedAt: iso(NOW - 40_000), observedAt: iso(NOW - 4000), receivedAt: iso(NOW) });
    await request;
    for (let i = 0; i < 100 && runtime.snapshot().account.trades.length === 0; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const state = runtime.snapshot();
    assert.equal(state.account.trades.length, 1, 'fresh response must not wait for the periodic timer');
    assert.equal(state.account.trades[0].side, 'buy');
    assert.equal(state.cadence.quoteTriggeredEvaluations, 1);
    assert.equal(state.execution, false); assert.equal(state.signing, false); assert.equal(state.broadcast, false);
    await runtime.fastOnce(); assert.equal(runtime.snapshot().account.trades.length, 1, 'no duplicate entry');
  } finally { release({ status: 'unavailable' }); await runtime.stop(); }
});

test('quote-arrival evaluation rejects stale, failed, foreign and paused inputs', async t => {
  for (const kind of ['expired', 'failed', 'foreign', 'paused']) await t.test(kind, async t => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const runtime = createPaperStrategyRuntime({ dataDir: await directory(t), market: { ...market(), quote: () => pending },
      now: () => NOW, intervalMs: 60_000, pvpMode: true, evidenceLoader: () => sources() });
    try {
      await runtime.runOnce(); await runtime.start(); await runtime.fastOnce();
      if (kind === 'paused') await runtime.setEnabled(false);
      const request = runtime.refreshQuote();
      release({ status: kind === 'failed' ? 'stale' : 'ok', chain: token.chain,
        address: kind === 'foreign' ? `0x${'b'.repeat(40)}` : CA, price: 1,
        observedAt: iso(NOW - (kind === 'expired' ? 6000 : 0)) });
      await request; await new Promise(resolve => setTimeout(resolve, 30));
      const state = runtime.snapshot();
      assert.equal(state.account.trades.length, 0); assert.equal(state.cadence.quoteTriggeredEvaluations, 0);
    } finally { release({ status: 'unavailable' }); await runtime.stop(); }
  });
});

test('quote-arrival evaluation reloads evidence and cannot buy from a lost flow signal', async t => {
  let release, evidence = sources();
  const pending = new Promise(resolve => { release = resolve; });
  const runtime = createPaperStrategyRuntime({ dataDir: await directory(t), market: { ...market(), quote: () => pending },
    now: () => NOW, intervalMs: 60_000, pvpMode: true, evidenceLoader: () => evidence });
  try {
    await runtime.runOnce(); await runtime.start(); await runtime.fastOnce();
    evidence = { flowState: { ...evidence.flowState, trades: {} } };
    const request = runtime.refreshQuote();
    release({ status: 'ok', chain: token.chain, address: CA, price: 1, observedAt: iso(NOW) });
    await request;
    for (let i = 0; i < 100 && !runtime.snapshot().cadence.quoteTriggeredEvaluations; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const state = runtime.snapshot();
    assert.equal(state.cadence.quoteTriggeredEvaluations, 1);
    assert.equal(state.account.trades.length, 0);
    assert.ok(state.evaluations.every(row => row.decision !== '可模拟'));
  } finally { release({ status: 'unavailable' }); await runtime.stop(); }
});

test('quote arrival coalesces behind an active evaluation and cannot create duplicate entries', async t => {
  let releaseQuote, releaseResearch, blocked = false, enteredResearch;
  const quotePending = new Promise(resolve => { releaseQuote = resolve; });
  const researchEntered = new Promise(resolve => { enteredResearch = resolve; });
  const runtime = createPaperStrategyRuntime({ dataDir: await directory(t), market: { ...market(), quote: () => quotePending },
    now: () => NOW, intervalMs: 60_000, pvpMode: true, evidenceLoader: async () => {
      if (blocked) { enteredResearch(); await new Promise(resolve => { releaseResearch = resolve; }); }
      return sources();
    } });
  try {
    await runtime.runOnce(); await runtime.start(); await runtime.fastOnce();
    blocked = true; const cycle = runtime.fastOnce(); await researchEntered;
    const request = runtime.refreshQuote();
    releaseQuote({ status: 'ok', chain: token.chain, address: CA, price: 1, observedAt: iso(NOW) });
    await request;
    assert.equal(runtime.snapshot().account.trades.length, 0);
    blocked = false; releaseResearch(); await cycle;
    for (let i = 0; i < 100 && !runtime.snapshot().cadence.quoteTriggeredEvaluations; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const state = runtime.snapshot();
    assert.equal(state.cadence.quoteTriggeredEvaluations, 1); assert.equal(state.account.trades.length, 1);
    assert.equal(JSON.parse(await fs.readFile(runtime.stateFile, 'utf8')).account.trades.length, 1);
  } finally { blocked = false; releaseResearch?.(); releaseQuote({ status: 'unavailable' }); await runtime.stop(); }
});

test('independent exit loop remains responsive to fresh stop quotes while research is stuck', async t => {
  const dataDir = await directory(t); let clock = NOW, price = 1, blocked = false, release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const feed = market(() => clock);
  feed.quote = async ({ chain, address }) => ({ chain, address, price, status: 'ok', observedAt: iso(clock) });
  const runtime = createPaperStrategyRuntime({ dataDir, market: feed, now: () => clock, evidenceLoader: async () => {
    if (blocked) { entered(); await new Promise(resolve => { release = resolve; }); }
    return sources(clock);
  } });
  try {
    await runtime.runOnce(); await runtime.refreshQuote(); await runtime.fastOnce();
    assert.equal(runtime.snapshot().account.trades.length, 1);
    blocked = true; const pending = runtime.fastOnce(); await ready;
    await runtime.setEnabled(false); clock += 2000; price = .7;
    await runtime.refreshQuote(); await Promise.all([runtime.exitOnce(), runtime.exitOnce()]);
    const s = runtime.snapshot(); assert.equal(s.account.trades.length, 2); assert.equal(s.account.trades[1].price, .7);
    assert.equal(s.exitMonitor.intervalMs, 1000); assert.equal(s.exitMonitor.entriesEnabled, false);
    assert.equal(s.cadence.quotePriorityScope, 'shared_account_queue');
    await runtime.exitOnce(); assert.equal(runtime.snapshot().account.trades.length, 2);
    release(); await pending; assert.equal(runtime.snapshot().account.trades.length, 2);
    assert.equal(JSON.parse(await fs.readFile(runtime.stateFile, 'utf8')).account.trades.length, 2);
  } finally { release?.(); await runtime.stop(); }
  await runtime.fastOnce(); await runtime.runOnce();
  await assert.rejects(fs.stat(`${runtime.stateFile}.lock`), { code: 'ENOENT' });
});

test('independent exits retain stale holdings instead of making up a stop fill', async t => {
  const dataDir = await directory(t); let clock = NOW;
  const feed = market(() => clock);
  feed.quote = async ({ chain, address }) => ({ chain, address, price: 1, status: 'ok', observedAt: iso(clock) });
  const runtime = createPaperStrategyRuntime({ dataDir, market: feed, now: () => clock, evidenceLoader: () => sources(clock) });
  try {
    await runtime.runOnce(); await runtime.refreshQuote(); await runtime.fastOnce();
    await runtime.setEnabled(false); clock += 16000; await runtime.exitOnce();
    const s = runtime.snapshot(); assert.equal(s.account.trades.length, 1); assert.equal(s.exitMonitor.staleQuotes, 1);
    assert.equal(s.account.stats.stalePositions, 1);
  } finally { await runtime.stop(); }
});

test('fast heartbeats cannot renew stale or failed quotes, even when old ranking prices look fresh', async t => {
  const dataDir = await directory(t); let clock = NOW, failing = false;
  const feed = market(() => clock);
  feed.quote = async ({ chain, address }) => failing ? { status: 'stale', chain, address, price: 1, observedAt: iso(NOW) }
    : { status: 'ok', chain, address, price: 1, observedAt: iso(clock) };
  const runtime = createPaperStrategyRuntime({ market: feed, dataDir, now: () => clock, evidenceLoader: async () => sources(clock) });
  try {
    await runtime.runOnce(); await runtime.refreshQuote(); clock += 16000; await runtime.fastOnce();
    assert.equal(runtime.snapshot().account.trades.length, 0);
    assert.ok(runtime.snapshot().evaluations[0].missing.includes('十五秒内的独立报价'));
    await runtime.refreshQuote(); await runtime.fastOnce(); assert.equal(runtime.snapshot().account.trades.length, 1);
    failing = true; clock += 2000; await runtime.refreshQuote(); await runtime.fastOnce();
    assert.equal(runtime.snapshot().account.stats.stalePositions, 1);
    assert.equal(runtime.snapshot().account.trades.length, 1);
  } finally { await runtime.stop(); }
});

test('fast quote binding rejects a foreign token and never overwrites research timestamps', async t => {
  const dataDir = await directory(t); let clock = NOW, wrong = true;
  const feed = market(() => clock);
  feed.quote = async ({ chain, address }) => ({ chain, address: wrong ? `0x${'b'.repeat(40)}` : address, price: 1, status: 'ok', observedAt: iso(clock) });
  const runtime = createPaperStrategyRuntime({ market: feed, dataDir, now: () => clock, evidenceLoader: async () => sources(clock) });
  try {
    await runtime.runOnce(); await runtime.refreshQuote(); await runtime.fastOnce();
    assert.equal(runtime.snapshot().account.trades.length, 0);
    wrong = false; clock += 121000; await runtime.refreshQuote(); await runtime.fastOnce();
    assert.equal(runtime.snapshot().account.trades.length, 0, 'new quote cannot freshen expired safety/market snapshot');
    assert.equal(runtime.snapshot().evaluations[0].evidence.marketObservedAt, iso(NOW));
  } finally { await runtime.stop(); }
});

test('background charts are single-flight and bounded while ticks continue', async t => {
  const dataDir = await directory(t); let calls = 0; const releases = [];
  const feed = market();
  feed.trenches = async () => ({ status: 'ok', observedAt: iso(NOW), tokens: Array.from({ length: 8 }, (_, i) => ({ ...token, address: `0x${String(i + 1).repeat(40)}` })) });
  feed.kline = () => { calls++; return new Promise(resolve => releases.push(resolve)); };
  const evaluate = ({ token }) => [{ token, decision: '观察', strategyId: 'internal', reasons: [], missing: ['新鲜且足够的 K 线'], score: 1 }];
  const runtime = createPaperStrategyRuntime({ market: feed, dataDir, now: () => NOW, evaluate, evidenceLoader: async () => ({}) });
  try {
    await runtime.refreshMarket();
    for (let i = 0; i < 8; i++) await runtime.fastOnce();
    assert.equal(calls, 2); assert.equal(runtime.snapshot().cadence.tickCount, 8);
  } finally { releases.forEach(resolve => resolve({ status: 'unavailable', candles: [] })); await runtime.stop(); }
});

test('PVP runtime prioritizes held quotes, exposes timing and restores frozen short-hold rules after restart', async t => {
  const dataDir = await directory(t); let clock = NOW; const purposes = [];
  const feed = market(() => clock);
  feed.quote = async ({ chain, address, purpose }) => {
    purposes.push(purpose);
    return { chain, address, price: 1, status: 'ok', queuedAt: iso(clock - 200), observedAt: iso(clock), receivedAt: iso(clock + 100) };
  };
  let runtime = createPaperStrategyRuntime({ market: feed, dataDir, now: () => clock, pvpMode: true, evidenceLoader: async () => sources(clock) });
  try {
    await runtime.runOnce(); await runtime.refreshQuote(); await runtime.fastOnce();
    let state = runtime.snapshot(); assert.equal(state.account.trades.length, 1);
    assert.equal(state.exitPolicy.mode, 'pvp'); assert.equal(state.cadence.lastQuoteTiming.queueMs, 200);
    assert.ok(state.strategies.every(s => s.maxHoldMs === 180000));
    await runtime.fastOnce(); clock += 3000; await runtime.refreshQuote(); await runtime.fastOnce();
    assert.equal(purposes.at(-1), 'exit');
    await runtime.stop();
    runtime = createPaperStrategyRuntime({ market: feed, dataDir, now: () => clock, evidenceLoader: async () => sources(clock) });
    await runtime.runOnce(); clock = NOW + 45000; await runtime.refreshQuote(); await runtime.fastOnce();
    state = runtime.snapshot(); assert.equal(state.account.trades.length, 2); assert.match(state.account.trades.at(-1).reason, /45 秒/);
    assert.equal(state.execution, false); assert.equal(state.signing, false);
  } finally { await runtime.stop(); }
});

test('auxiliary-audit PVP candidate crosses research, fresh quote, persisted holding and timed exit end to end', async t => {
  const dataDir = await directory(t); let clock = NOW;
  const partial = { ...token, isWashTrading: null, rugRatio: null, bundlerRate: null };
  const feed = { ...market(() => clock),
    trenches: async () => ({ status: 'ok', observedAt: iso(clock), tokens: [partial] }),
    quote: async ({ chain, address }) => ({ chain, address, price: 1, status: 'ok', observedAt: iso(clock), receivedAt: iso(clock) }) };
  const runtime = createPaperStrategyRuntime({ dataDir, market: feed, now: () => clock, pvpMode: true,
    allowExploratory: true, compoundEntries: true, evidenceLoader: () => sources(clock) });
  try {
    await runtime.runOnce(); assert.equal(runtime.snapshot().account.trades.length, 0);
    await runtime.refreshQuote(); await runtime.fastOnce();
    const opened = runtime.snapshot(); assert.equal(opened.account.trades.length, 1, JSON.stringify({ evaluations: opened.evaluations, cadence: opened.cadence })); assert.equal(opened.account.cash, 98);
    const position = Object.values(opened.account.positions)[0];
    assert.equal(position.entryEvidence.safety.auditMissing.length, 3);
    assert.equal(position.entryEvidence.safety.metrics.rugRatio, null);
    await runtime.setEnabled(false); clock += 45000;
    await runtime.refreshQuote(); await runtime.exitOnce();
    const closed = runtime.snapshot(); assert.equal(closed.account.trades.length, 2); assert.equal(Object.keys(closed.account.positions).length, 0);
    assert.match(closed.account.trades.at(-1).reason, /45 秒/);
    const saved = JSON.parse(await fs.readFile(runtime.stateFile, 'utf8'));
    assert.deepEqual(saved.account.trades, JSON.parse(JSON.stringify(closed.account.trades)));
    for (const flag of ['execution', 'signing', 'broadcast']) assert.equal(closed[flag], false);
  } finally { await runtime.stop(); }
});

test('main diagnostic mode quotes and trades without candles or smart tags, records baseline and restores frozen exits', async t => {
  const dataDir = await directory(t); let clock = NOW, chartCalls = 0, badQuote = true;
  const candidate = { ...token, marketStage: 'unknown', top10HolderRate: .85, canMint: true };
  const feed = { ...market(() => clock),
    trenches: async () => ({ status: 'ok', observedAt: iso(clock), tokens: [candidate] }),
    kline: async () => { chartCalls++; return { status: 'unavailable', candles: [] }; },
    quote: async ({ chain, address }) => ({ chain: badQuote ? 'bsc' : chain, address, price: 1, status: 'ok', observedAt: iso(clock), receivedAt: iso(clock) }) };
  const evidenceLoader = () => {
    const s = sources(clock); s.flowState.profiles = {};
    s.flowState.trades.robinhood = s.flowState.trades.robinhood.slice(0, 1).map(row => ({ ...row, tags: ['kol'], amountUsd: 150 }));
    return s;
  };
  const options = { dataDir, market: feed, now: () => clock, pvpMode: true, allowExploratory: true, compoundEntries: true, diagnosticMode: true, evidenceLoader };
  let runtime = createPaperStrategyRuntime(options);
  try {
    await runtime.runOnce(); await runtime.refreshQuote(); await runtime.fastOnce();
    assert.equal(runtime.snapshot().account.trades.length, 0); assert.equal(chartCalls, 0);
    badQuote = false; clock += 3000;
    await runtime.refreshQuote(); await runtime.fastOnce();
    const opened = runtime.snapshot(); assert.equal(opened.account.trades.length, 1, JSON.stringify({ evaluations: opened.evaluations, cadence: opened.cadence })); assert.equal(opened.account.cash, 98);
    const p = Object.values(opened.account.positions)[0];
    assert.equal(p.entryEvidence.flow.smartMoneyCount, 0); assert.equal(p.entryEvidence.flow.netBuyUsd, 150);
    assert.equal(p.entryEvidence.chart.ready, false); assert.equal(p.entryEvidence.diagnostic.baseline.decision, '不买');
    assert.equal(opened.entryMode, 'paper_diagnostic_entry_v1'); assert.equal(opened.chainCoverage.robinhood.funnel.eligible, 1);
    await runtime.setEnabled(false); await runtime.stop(); clock += 45000;
    runtime = createPaperStrategyRuntime({ ...options, diagnosticMode: false });
    await runtime.runOnce(); await runtime.refreshQuote(); await runtime.exitOnce();
    const closed = runtime.snapshot(); assert.equal(closed.account.trades.length, 2);
    assert.equal(Object.keys(closed.account.positions).length, 0); assert.match(closed.account.trades.at(-1).reason, /45 秒/);
    const saved = JSON.parse(await fs.readFile(runtime.stateFile, 'utf8'));
    assert.deepEqual(saved.account.trades, JSON.parse(JSON.stringify(closed.account.trades)));
    for (const flag of ['execution', 'signing', 'broadcast']) assert.equal(closed[flag], false);
  } finally { await runtime.stop(); }
});

test('PVP changes main-account rules without contaminating paired learning controls', async t => {
  const learned = { version: '1234567890abcdef', chain: 'robinhood', group: 'gmgn_fomo', maxHoldMs: 120000, lossCutRate: .08,
    teacherCount: 3, matchedSells: 30, trainedAt: iso(NOW), trainingEndAt: iso(NOW - 1000) };
  const runtime = createPaperStrategyRuntime({ dataDir: await directory(t), market: market(), now: () => NOW, pvpMode: true,
    evidenceLoader: () => sources(), learningLoader: () => ({ policies: [learned] }) });
  try {
    await runtime.runOnce(); const state = runtime.snapshot();
    assert.equal(Object.values(state.account.positions)[0].pvpPolicy.version, 'fast_pvp_v1');
    for (const account of [state.learningComparison.control, state.learningComparison.student]) {
      assert.equal(account.positions.length, 1); assert.equal(account.positions[0].pvpPolicy, undefined);
      assert.equal(account.positions[0].entryEvidence.exitPolicy, undefined);
    }
  } finally { await runtime.stop(); }
});

test('continuous runtime exposes non-blocking limits, persists versioned fills and restores without rewriting old results', async t => {
  const dataDir = await directory(t); let clock = NOW, price = 1;
  const feed = { ...market(() => clock), quote: async ({ chain, address }) => ({ chain, address, price, status: 'ok', observedAt: iso(clock) }) };
  const options = { dataDir, market: feed, now: () => clock, pvpMode: true, allowExploratory: true,
    confirmedMode: true, fixedEntryUsd: 10, evidenceHoldMode: true, continuousPaperMode: true,
    evidenceLoader: () => sources(clock), learningLoader: () => ({ policies: [], personaPolicies: [] }) };
  let runtime = createPaperStrategyRuntime(options);
  try {
    await runtime.runOnce();
    for (const next of [1, 1.006, 1.01]) {
      price = next; await runtime.refreshQuote(); await runtime.fastOnce(); clock += 6000;
    }
    let s = runtime.snapshot();
    assert.equal(s.operatingPolicy.version, 'continuous_paper_v1');
    assert.equal(s.entryGuard.allowed, true, 'no global one-minute pause after an entry');
    assert.equal(s.positionSizing.maxPositions, null);
    assert.equal(s.account.trades.length, 1);
    assert.equal(s.account.trades[0].entryEvidence.accountPolicy.version, 'continuous_paper_v1');
    price = .5; await runtime.refreshQuote(); await runtime.exitOnce();
    s = runtime.snapshot();
    assert.ok(s.account.realizedPnl < -3);
    assert.equal(s.entryGuard.allowed, true, 'independent exit loop uses the same continuous policy');
    assert.ok(s.entryGuard.warnings.length);
    const frozen = JSON.parse(JSON.stringify(s.account.trades));
    await runtime.stop(); runtime = createPaperStrategyRuntime(options);
    clock += 6000; await runtime.runOnce();
    s = runtime.snapshot(); assert.equal(s.entryGuard.allowed, true);
    assert.deepEqual(s.account.trades, frozen);
    assert.equal(s.strategies.find(r=>r.id==='smart_money').entries, 1);
    await runtime.stop(); runtime = createPaperStrategyRuntime({ ...options, continuousPaperMode: false });
    clock += 6000; await runtime.runOnce(); s = runtime.snapshot();
    assert.equal(s.entryGuard.allowed, false);
    assert.deepEqual(s.account.trades, frozen);
    for (const field of ['execution', 'signing', 'broadcast']) assert.equal(s[field], false);
  } finally { await runtime.stop(); }
  assert.throws(() => createPaperStrategyRuntime({ ...options, confirmedMode: false, fixedEntryUsd: null, evidenceHoldMode: false }), /continuous mode requires/);
});

test('evidence-hold runtime persists a ten-dollar entry, holds beyond 83 minutes and restores without clock exits', async t => {
  const dataDir = await directory(t); let clock = NOW, price = 1;
  const feed = { ...market(() => clock),
    quote: async ({ chain, address }) => ({ chain, address, price, status: 'ok', observedAt: iso(clock) }) };
  const options = { dataDir, market: feed, now: () => clock, pvpMode: true, allowExploratory: true,
    confirmedMode: true, fixedEntryUsd: 10, evidenceHoldMode: true, evidenceLoader: () => sources(clock) };
  let runtime = createPaperStrategyRuntime(options);
  try {
    await runtime.runOnce();
    for (const next of [1, 1.006, 1.01]) {
      price = next; await runtime.refreshQuote(); await runtime.fastOnce(); clock += 6000;
    }
    let s = runtime.snapshot();
    assert.equal(s.exitPolicy.version, 'evidence_hold_v1');
    assert.equal(s.exitPolicy.coreHoldMs, null);
    assert.equal(s.account.trades.length, 1); assert.equal(s.account.trades[0].netUsd, -10);
    const frozenBuy = JSON.parse(JSON.stringify(s.account.trades[0]));
    assert.equal(Object.values(s.account.positions)[0].pvpPolicy.version, 'evidence_hold_v1');
    assert.equal(s.strategies.find(x=>x.id==='smart_money').maxHoldMs, null);
    await runtime.setEnabled(false);
    clock += 83 * 60000; price = 1.1;
    await runtime.refreshQuote(); await runtime.exitOnce();
    s = runtime.snapshot(); assert.equal(s.account.trades.length, 1);
    assert.equal(Object.values(s.account.positions)[0].exitStatus.timeExitEnabled, false);
    await runtime.stop();
    runtime = createPaperStrategyRuntime({ ...options, evidenceHoldMode: false });
    await runtime.runOnce(); clock += 3600000; price = 1.2;
    await runtime.refreshQuote(); await runtime.exitOnce();
    s = runtime.snapshot(); assert.equal(s.account.trades.length, 1);
    assert.equal(Object.values(s.account.positions)[0].pvpPolicy.version, 'evidence_hold_v1');
    assert.deepEqual(s.account.trades[0], frozenBuy);
    clock += 6000; price = .9;
    await runtime.refreshQuote(); await runtime.exitOnce();
    s = runtime.snapshot(); assert.equal(s.account.trades.length, 2);
    assert.equal(s.account.trades[1].exitEvidence.exitPolicyVersion, 'evidence_hold_v1');
    for (const flag of ['execution', 'signing', 'broadcast']) assert.equal(s[flag], false);
    const disk = JSON.parse(await fs.readFile(runtime.stateFile, 'utf8'));
    assert.deepEqual(disk.account.trades, s.account.trades);
  } finally { await runtime.stop(); }
  assert.throws(() => createPaperStrategyRuntime({ ...options, confirmedMode: false, fixedEntryUsd: null }), /requires confirmed/);
});

test('switching to evidence hold leaves an existing timed position unchanged and does not relabel its PnL', async t => {
  const dataDir = await directory(t); let clock = NOW, price = 1;
  const feed = { ...market(() => clock), quote: async ({ chain, address }) => ({ chain, address, price, status: 'ok', observedAt: iso(clock) }) };
  const options = { dataDir, market: feed, now: () => clock, pvpMode: true, allowExploratory: true,
    confirmedMode: true, compoundEntries: true, evidenceLoader: () => sources(clock) };
  let runtime = createPaperStrategyRuntime(options);
  try {
    await runtime.runOnce();
    for (const next of [1, 1.006, 1.01]) { price = next; await runtime.refreshQuote(); await runtime.fastOnce(); clock += 6000; }
    const original = JSON.parse(JSON.stringify(runtime.snapshot().account.trades[0]));
    await runtime.setEnabled(false); await runtime.stop();
    runtime = createPaperStrategyRuntime({ ...options, evidenceHoldMode: true });
    await runtime.runOnce(); clock += 120000;
    await runtime.refreshQuote(); await runtime.exitOnce(); await runtime.fastOnce();
    const s = runtime.snapshot(), lane = s.strategies.find(x=>x.id==='smart_money');
    assert.equal(s.account.trades.length, 2); assert.deepEqual(s.account.trades[0], original);
    assert.match(s.account.trades[1].reason, /120 秒/);
    assert.equal(s.account.trades[1].exitEvidence.exitPolicyVersion, 'confirmed_pvp_exit_v2');
    assert.ok(s.account.realizedPnl < 0);
    assert.equal(lane.entries, 0); assert.equal(lane.realizedPnl, 0); assert.equal(lane.costsUsd, 0);
  } finally { await runtime.stop(); }
});

test('recovery quote arrival evaluates only its CA before a fresh quote expires, then persists exactly once',async t=>{
  for(const variant of ['fresh','research_pending','lost_flow','expired_during_evaluation'])await t.test(variant,async t=>{
    let clock=NOW,price=1,slow=false,otherEvaluations=0,evidenceMissing=false,release;
    let blockResearchOnce=false,releaseResearch,enteredResearch,pendingCycle;
    const entered=new Promise(resolve=>{enteredResearch=resolve;});
    const pending=new Promise(resolve=>{release=resolve;});
    const noise=Array.from({length:20},(_,i)=>({...token,address:`0x${(i+100).toString(16).padStart(40,'0')}`,liquidity:0}));
    const feed={...market(()=>clock),trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[token,...noise]}),
      kline:async()=>({status:'unavailable'}),quote:async({chain,address})=>slow?pending:{chain,address,price,status:'ok',observedAt:iso(clock)}};
    const r=createPaperStrategyRuntime({dataDir:await directory(t),market:feed,now:()=>clock,intervalMs:60000,marketIntervalMs:60000,
      allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true,memeExitMode:true,recoveryMode:true,
      evidenceLoader:async()=>{
        if(blockResearchOnce){blockResearchOnce=false;enteredResearch();await new Promise(resolve=>{releaseResearch=resolve;});}
        return evidenceMissing?{}:sources(clock);
      },evaluate:input=>{
        if(slow&&input.token.address!==CA){otherEvaluations++;clock+=500;}
        if(slow&&input.token.address===CA&&variant==='expired_during_evaluation')clock+=700;
        return evaluatePaperStrategies(input);
      }});
    try{
      await r.runOnce();await r.fastOnce();await r.refreshQuote();await r.fastOnce();
      assert.equal(r.snapshot().cadence.lastCandidateQuote?.confirmationHistoryCount,1,'first independent observation');
      clock+=6000;price=1.006;await r.refreshQuote();await r.fastOnce();
      await r.start();await r.fastOnce();assert.equal(r.snapshot().account.trades.length,0);
      if(variant==='research_pending'){blockResearchOnce=true;pendingCycle=r.fastOnce();await entered;}
      clock+=10400;price=1.01;slow=true;evidenceMissing=variant==='lost_flow';
      const request=r.refreshQuote();release({chain:token.chain,address:CA,price,status:'ok',observedAt:iso(clock-4400),receivedAt:iso(clock)});await request;
      for(let i=0;i<100&&!r.snapshot().cadence?.lastCandidateEvaluation;i++)await new Promise(resolve=>setTimeout(resolve,10));
      const s=r.snapshot();assert.equal(otherEvaluations,0,'quote callback must not reevaluate the unrelated universe');
      assert.equal(s.cadence.quoteEvaluationMode,'targeted_main_quote_v1');
      const shouldFill=['fresh','research_pending'].includes(variant);
      assert.equal(s.account.trades.length,shouldFill?1:0,JSON.stringify({last:s.cadence.lastCandidateEvaluation,quote:s.cadence.lastCandidateQuote,
        confirmation:s.evaluations.find(r=>r.token.address===CA)?.evidence.confirmedPolicy?.confirmation}));
      if(shouldFill){
        assert.ok(s.cadence.lastCandidateEvaluation.quoteAgeAtDecisionMs<=5000);
        assert.equal(JSON.parse(await fs.readFile(r.stateFile,'utf8')).account.trades.length,1);
        slow=false;releaseResearch?.();await pendingCycle;await r.fastOnce();assert.equal(r.snapshot().account.trades.length,1);
      }
      for(const flag of ['execution','signing','broadcast'])assert.equal(s[flag],false);
    }finally{slow=false;releaseResearch?.();release({status:'unavailable'});await pendingCycle;await r.stop();}
  });
});

test('fresh quotes interrupt pure broad-scan work without losing a fill to the later broad ledger write',async t=>{
  let clock=NOW,price=1,busy=false,released=false,release,filledBeforeScanEnd=false,scanEnded=false;
  const pending=new Promise(resolve=>{release=resolve;});
  const noise=Array.from({length:50},(_,i)=>({...token,address:`0x${(i+100).toString(16).padStart(40,'0')}`,liquidity:0}));
  const feed={...market(()=>clock),trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[token,...noise]}),
    kline:async()=>({status:'unavailable'}),quote:async({chain,address})=>busy?pending:{chain,address,price,status:'ok',observedAt:iso(clock)}};
  const r=createPaperStrategyRuntime({dataDir:await directory(t),market:feed,now:()=>clock,intervalMs:60000,marketIntervalMs:60000,
    allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true,memeExitMode:true,recoveryMode:true,
    evidenceLoader:()=>sources(clock),evaluate:input=>{
      if(busy&&input.token.address!==CA) {
        clock+=100;
        if(!released){released=true;release({chain:token.chain,address:CA,price,status:'ok',observedAt:iso(clock-1000)});}
      }
      const rows=evaluatePaperStrategies(input);
      if(busy&&input.token.address===CA&&rows.some(r=>r.decision==='可模拟'))filledBeforeScanEnd=!scanEnded;
      return rows;
    }});
  try {
    await r.runOnce();await r.fastOnce();await r.refreshQuote();await r.fastOnce();
    clock+=6000;price=1.006;await r.refreshQuote();await r.fastOnce();
    await r.start();await r.fastOnce();
    clock+=10400;price=1.01;busy=true;
    const quote=r.refreshQuote();await r.fastOnce();scanEnded=true;await quote;
    for(let n=0;n<100&&!r.snapshot().cadence?.lastCandidateEvaluation;n++)await new Promise(resolve=>setTimeout(resolve,10));
    const s=r.snapshot();
    assert.ok(s.cadence.cooperativeQuoteEvaluations>=1,JSON.stringify(s.cadence.lastCandidateEvaluation));
    assert.equal(filledBeforeScanEnd,true);
    assert.equal(s.account.trades.filter(t=>t.side==='buy').length,1);
    assert.ok(s.cadence.lastCandidateEvaluation.quoteAgeAtDecisionMs<=5000);
    assert.equal(JSON.parse(await fs.readFile(r.stateFile,'utf8')).account.trades.filter(t=>t.side==='buy').length,1);
  }finally{busy=false;release({status:'unavailable'});await r.stop();}
});

test('confirmed runtime gathers independent quotes, persists v2, isolates controls and restores its new exit', async t => {
  const dataDir = await directory(t); let clock = NOW, price = 1, chartCalls = 0;
  const feed = { ...market(() => clock), kline: async () => { chartCalls++; return { status: 'unavailable' }; },
    quote: async ({chain,address}) => ({chain,address,price,status:'ok',observedAt:iso(clock),receivedAt:iso(clock)}) };
  const options = { dataDir, market: feed, now:()=>clock, pvpMode:true, allowExploratory:true, compoundEntries:true,
    confirmedMode:true, evidenceLoader:()=>sources(clock) };
  let runtime = createPaperStrategyRuntime(options);
  try {
    await runtime.runOnce(); await runtime.refreshQuote(); await runtime.fastOnce();
    assert.equal(runtime.snapshot().account.trades.length,0); assert.equal(chartCalls,0);
    await runtime.refreshQuote(); await runtime.fastOnce(); assert.equal(runtime.snapshot().account.trades.length,0,'same timestamp cannot add confirmation');
    clock+=6000;price=1.006;await runtime.refreshQuote();await runtime.fastOnce();
    assert.equal(runtime.snapshot().account.trades.length,0);
    clock+=6000;price=1.01;await runtime.refreshQuote();await runtime.fastOnce();
    const s=runtime.snapshot();assert.equal(s.account.trades.length,1,JSON.stringify(s.evaluations));
    assert.equal(s.entryMode,'confirmed_pvp_v2');assert.equal(s.account.cash,98);
    const p=Object.values(s.account.positions)[0];assert.equal(p.entryEvidence.confirmedPolicy.confirmation.count,3);
    assert.equal(p.entryEvidence.traderDecision.version,'evidence_first_v1');
    assert.equal(p.entryEvidence.traderDecision.economics.budgetUsd,2);
    assert.equal(s.entryGuard.traderReview.overall.closedRounds,0);
    assert.equal(s.strategies.find(r=>r.id==='smart_money').traderDecision.questions.length,4);
    assert.equal(p.entryEvidence.confirmedPolicy.pulse.recentBuyerCount,6);
    assert.equal(s.entryGuard.allowed,false,'opening starts the global minimum interval');
    await runtime.setEnabled(false);await runtime.stop();
    runtime=createPaperStrategyRuntime({...options,confirmedMode:false});await runtime.runOnce();
    clock+=45000;price=1.02;await runtime.refreshQuote();await runtime.exitOnce();
    assert.equal(runtime.snapshot().account.trades.length,1,'legacy 45-second cost exit does not overwrite v2');
    clock+=75000;price=1.01;await runtime.refreshQuote();await runtime.exitOnce();
    const closed=runtime.snapshot();assert.equal(closed.account.trades.length,2);assert.match(closed.account.trades.at(-1).reason,/120 秒/);
    for(const flag of ['execution','signing','broadcast'])assert.equal(closed[flag],false);
    assert.equal(closed.account.stats.enabled,false);
    const saved=JSON.parse(await fs.readFile(runtime.stateFile,'utf8'));assert.equal(saved.account.trades.length,2);
    assert.deepEqual(saved.account.trades[0].entryEvidence.traderDecision,p.entryEvidence.traderDecision);
  } finally { await runtime.stop(); }
});

test('selected v2 experiment executes and restores its own paper trades without changing the legacy file', async t => {
  const dataDir=await directory(t);let clock=NOW,price=1;
  const feed={...market(()=>clock),quote:async({chain,address})=>({chain,address,price,status:'ok',observedAt:iso(clock)})};
  const options={dataDir,market:feed,now:()=>clock,pvpMode:true,allowExploratory:true,compoundEntries:true,
    confirmedMode:true,evidenceLoader:()=>sources(clock)};
  const old=createPaperStrategyRuntime(options);await old.setEnabled(false);await old.stop();
  const oldBytes=await fs.readFile(old.stateFile,'utf8');
  const session=await createConfirmedPaperSession({dataDir,id:'confirmed-pvp-v2-offline-execution',nowMs:clock});
  let r=createPaperStrategyRuntime({...options,session});
  try {
    await r.setEnabled(true);await r.runOnce();
    for(const quote of [1,1.006,1.01]) {price=quote;await r.refreshQuote();await r.fastOnce();clock+=6000;}
    assert.equal(r.snapshot().account.trades.length,1);assert.equal(r.snapshot().account.cash,98);
    await r.stop();r=createPaperStrategyRuntime({...options,session});await r.runOnce();
    assert.equal(r.snapshot().enabled,true);assert.equal(r.snapshot().account.trades.length,1);
    clock+=120000;await r.refreshQuote();await r.exitOnce();
    assert.equal(r.snapshot().account.trades.length,2);assert.equal(Object.keys(r.snapshot().account.positions).length,0);
    assert.equal(await fs.readFile(old.stateFile,'utf8'),oldBytes);
    assert.equal(JSON.parse(await fs.readFile(r.stateFile,'utf8')).session.id,session.id);
  }finally{await r.stop();}
});

test('no-CA KOL recall researches an off-ranking historical OG and records the paper entry once',async t=>{
  const dataDir=await directory(t);let clock=RECALL_NOW-RECALL_DAY,price=1,ranked=true;
  let events=[{...kolEvent(`${RECALL_TEXT} ${CA}`,clock-1000,'2102563652285145111'),chain:'robinhood'}];
  const tok=()=>({...token,marketCap:1000000,historyHighestMarketCap:5000000,price});
  const unavailable=async()=>({status:'ok',observedAt:iso(clock),tokens:[]});
  const feed={trending:async()=>({status:'ok',observedAt:iso(clock),tokens:ranked?[tok()]:[]}),trenches:unavailable,
    details:async()=>({status:'ok',observedAt:iso(clock),token:tok()}),
    quote:async({chain,address})=>({chain,address,price,status:'ok',observedAt:iso(clock)})};
  const evidence=()=>{const s=sources(clock);s.flowState.profiles={};s.flowState.trades.robinhood.forEach(t=>t.tags=[]);return {...s,events};};
  const options={dataDir,market:feed,now:()=>clock,pvpMode:true,allowExploratory:true,confirmedMode:true,compoundEntries:true,evidenceLoader:evidence};
  let r=createPaperStrategyRuntime(options);
  try {
    await r.runOnce();assert.equal(r.snapshot().account.trades.length,0);assert.equal(r.snapshot().narrativeRecall.knownTokens,1);
    await r.stop();clock=RECALL_NOW;ranked=false;events=[kolEvent(RECALL_TEXT,clock-1000)];
    r=createPaperStrategyRuntime(options);await r.runOnce();
    assert.equal(r.snapshot().narrativeRecall.matches.length,1);
    assert.ok(r.snapshot().researchPipeline.pending.some(x=>x.priority===3&&x.address===CA));
    await r.refreshDetails();await r.fastOnce();
    for(const value of [1,1.006,1.01]){price=value;await r.refreshQuote();await r.fastOnce();clock+=6000;}
    const state=r.snapshot();assert.equal(state.account.trades.length,1,JSON.stringify(state.evaluations));
    assert.equal(state.account.trades[0].entryEvidence.narrativeRecall.kind,'reviewed_big_kol');
    assert.equal(state.account.trades[0].entryEvidence.flow.smartMoneyCount,0);
    assert.equal(state.account.trades[0].entryEvidence.narrativeFresh,false,'inferred recall never becomes a direct CA endorsement');
    await r.fastOnce();assert.equal(r.snapshot().account.trades.length,1);
    const stored=JSON.parse(await fs.readFile(r.stateFile,'utf8'));assert.equal(stored.narrativeMemory.assets[`robinhood:${CA}`].activity.length>0,true);
  }finally{await r.stop();}
});

test('event-first casebook persists without a surge, survives controls/restart, and isolates corrupt memory',async t=>{
  const dataDir=await directory(t);let clock=RECALL_NOW;
  const feed={...market(()=>clock),quote:async()=>({status:'unavailable'}),trending:async()=>({status:'ok',observedAt:iso(clock),tokens:[{...token,name:'Mooncake',symbol:'MOONCAKE',marketCap:5000}]}),
    trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]})};
  const options={dataDir,market:feed,now:()=>clock,confirmedMode:true,pvpMode:true,allowExploratory:true,compoundEntries:true,
    evidenceLoader:()=>({events:[kolEvent('Mooncake cat mascot',RECALL_NOW-1000)]})};
  let r=createPaperStrategyRuntime(options);
  try{
    await r.setEnabled(false);await r.runOnce();
    const a=r.snapshot().narrativeAcademy;assert.equal(a.caseCount,1);assert.equal(a.candidateObservations,1);
    assert.equal(r.snapshot().narrativeLearning.sampleCount,0);assert.equal(r.snapshot().account.cash,100);
    await r.exitOnce();await r.setEnabled(true);await r.setEnabled(false);
    const stored=JSON.parse(await fs.readFile(r.stateFile,'utf8'));assert.equal(stored.narrativeAcademyMemory.cases.length,1);
    await r.stop();clock+=300000;r=createPaperStrategyRuntime(options);await r.runOnce();
    assert.equal(r.snapshot().narrativeAcademy.caseCount,1);assert.equal(r.snapshot().narrativeAcademy.outcomes['5m'].observed,1);
    assert.equal(r.snapshot().account.trades.length,0);assert.equal(r.snapshot().execution,false);
    await r.stop();const bad=JSON.parse(await fs.readFile(r.stateFile,'utf8'));bad.narrativeAcademyMemory={version:'corrupt'};
    await fs.writeFile(r.stateFile,JSON.stringify(bad));r=createPaperStrategyRuntime(options);await r.runOnce();await r.exitOnce();
    assert.match(r.snapshot().narrativeAcademy.error,/异常/);assert.equal(r.snapshot().account.cash,100);
    assert.deepEqual(JSON.parse(await fs.readFile(r.stateFile,'utf8')).narrativeAcademyMemory,{version:'corrupt'});
  }finally{await r.stop();}
});

test('surge narrative learning persists while entries are paused and follows an off-ranking token without trading',async t=>{
  const dataDir=await directory(t);let clock=RECALL_NOW-180000,volume=2000,ranked=true;
  const requests=[];
  const feed={
    trending:async()=>({status:'ok',source:'gmgn-cli',chain:'base',interval:'1m',observedAt:iso(clock),
      tokens:ranked?[{...token,chain:'base',volume,marketCap:2000000}]:[]}),
    trenches:async()=>({status:'ok',observedAt:iso(clock),tokens:[]}),
    quote:async query=>{requests.push(query);return {status:'ok',chain:query.chain,address:query.address,price:.8,observedAt:iso(clock)};},
  };
  const options={dataDir,chain:'base',market:feed,now:()=>clock,confirmedMode:true,pvpMode:true,allowExploratory:true,
    evidenceLoader:()=>({events:[]})};
  let r=createPaperStrategyRuntime(options);
  try {
    await r.setEnabled(false);
    for(let i=0;i<3;i++){await r.runOnce();clock+=60000;}
    volume=12000;await r.runOnce();
    assert.equal(r.snapshot().narrativeLearning.sampleCount,1);assert.equal(r.snapshot().account.trades.length,0);
    assert.equal(r.snapshot().narrativeLearning.narrativePending,1);await r.stop();
    ranked=false;clock+=300000;r=createPaperStrategyRuntime(options);await r.runOnce();
    assert.equal(r.snapshot().enabled,false);assert.equal(r.snapshot().narrativeLearning.sampleCount,1);
    await r.refreshNarrativeLearning();await r.fastOnce();await r.refreshNarrativeLearning();
    assert.equal(requests.length,1,'one bounded follow-up, no duplicate or trading quote');
    assert.equal(requests[0].purpose,'learning');assert.equal(requests[0].address,CA);
    const state=r.snapshot(),e=state.narrativeLearning.recentSamples[0];
    assert.ok(e.outcomes['5m'].returnRate<0);assert.equal(state.account.cash,100);assert.equal(state.account.trades.length,0);
    const stored=JSON.parse(await fs.readFile(r.stateFile,'utf8'));
    assert.equal(stored.narrativeLearningMemory.episodes[0].outcomes['5m'].status,'observed');
    await r.exitOnce();await r.setEnabled(true);
    assert.equal(JSON.parse(await fs.readFile(r.stateFile,'utf8')).narrativeLearningMemory.episodes.length,1);
  }finally{await r.stop();}
});

test('corrupt narrative learning memory is preserved and isolated from account and exits',async t=>{
  const dataDir=await directory(t),options={dataDir,market:{...market(),quote:async()=>({status:'unavailable'})},
    now:()=>NOW,confirmedMode:true,pvpMode:true,allowExploratory:true,evidenceLoader:()=>({events:[]})};
  let r=createPaperStrategyRuntime(options);
  await r.runOnce();await r.stop();
  const s=JSON.parse(await fs.readFile(r.stateFile,'utf8'));s.narrativeLearningMemory={version:'broken'};
  await fs.writeFile(r.stateFile,JSON.stringify(s));r=createPaperStrategyRuntime(options);
  try {
    await r.runOnce();await r.exitOnce();assert.match(r.snapshot().narrativeLearning.error,/异常/);
    assert.equal(r.snapshot().account.cash,100);assert.equal(r.snapshot().exitMonitor.lastError,null);
    assert.deepEqual(JSON.parse(await fs.readFile(r.stateFile,'utf8')).narrativeLearningMemory,{version:'broken'});
  }finally{await r.stop();}
});

test('surge learning automatically retrieves the provider-linked tweet without adding a CA endorsement or entry',async t=>{
  const dataDir=await directory(t),url='https://x.com/example/status/2102563652285145999';
  let clock=RECALL_NOW-180000,volume=2000,calls=0;
  const feed={trending:async()=>({status:'ok',source:'gmgn-cli',chain:'base',interval:'1m',observedAt:iso(clock),
    tokens:[{...token,chain:'base',volume,marketCap:2000000,twitterUsername:url}]}),
    quote:async()=>{throw new Error('No trade/follow-up quote is due');}};
  const r=createPaperStrategyRuntime({dataDir,chain:'base',market:feed,now:()=>clock,confirmedMode:true,pvpMode:true,allowExploratory:true,
    evidenceLoader:()=>({events:[]}),narrativeSourceReader:async target=>{calls++;assert.equal(target,url);
      return {status:'ok',url,at:RECALL_NOW-60000,observedAt:clock,text:RECALL_TEXT,author:'example',sourceVerifiedBy:'official_x_oembed'};}});
  try {
    for(let i=0;i<3;i++){await r.runOnce();clock+=60000;}volume=12000;await r.runOnce();
    await r.refreshNarrativeLearning();await r.fastOnce();await r.refreshNarrativeLearning();
    assert.equal(calls,1);assert.equal(r.snapshot().narrativeLearning.linkedNarrativeSamples,1);
    assert.equal(r.snapshot().narrativeLearning.verifiedNarrativeSamples,0);
    assert.equal(r.snapshot().narrativeRecall.knownTokens,0);assert.equal(r.snapshot().account.trades.length,0);
  }finally{await r.stop();}
});

test('independent exit management also closes paired learning positions with their own frozen rules', async t => {
  let clock = NOW, price = 1;
  const learned = { version: '1234567890abcdef', chain: 'robinhood', group: 'gmgn_fomo', maxHoldMs: 120000, lossCutRate: .08,
    teacherCount: 3, matchedSells: 30, trainedAt: iso(NOW), trainingEndAt: iso(NOW - 1000) };
  const feed = market(() => clock);
  feed.quote = async ({ chain, address }) => ({ chain, address, price, status: 'ok', observedAt: iso(clock) });
  const runtime = createPaperStrategyRuntime({ dataDir: await directory(t), market: feed, now: () => clock, pvpMode: true,
    evidenceLoader: () => sources(clock), learningLoader: () => ({ policies: [learned] }) });
  try {
    await runtime.runOnce(); await runtime.refreshQuote(); await runtime.fastOnce();
    for (const a of [runtime.snapshot().learningComparison.control, runtime.snapshot().learningComparison.student]) {
      assert.equal(a.positions.length, 1); assert.equal(a.positions[0].pvpPolicy, undefined);
    }
    await runtime.setEnabled(false); price = .5; clock += 3000;
    await runtime.refreshQuote(); await runtime.exitOnce();
    const s = runtime.snapshot(); assert.equal(s.account.trades.length, 2);
    for (const a of [s.learningComparison.control, s.learningComparison.student]) {
      assert.equal(a.positions.length, 0); assert.equal(a.trades.length, 2); assert.ok(a.cash < 100);
    }
    await runtime.exitOnce(); assert.equal(runtime.snapshot().learningComparison.student.trades.length, 2);
  } finally { await runtime.stop(); }
});
