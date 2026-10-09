import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGmgnFlowMonitor, validateGmgnFlowState,selectGmgnFlowChain } from "../src/gmgn-flow-monitor.js";
import { GMGN_FLOW_CHAINS, GMGN_HOT_ONLY_CHAINS, isGmgnFlowEvent } from "../src/gmgn-flow-signal.js";
import { runHealthCheck } from "../deploy/health-check.mjs";
import { createEthTradeLegResolver } from "../src/gmgn-eth-trade-legs.js";

const START = Date.parse("2026-09-19T18:00:10Z");
const MINUTE = 60_000;
const addr = n => `0x${n.toString(16).padStart(40, "0")}`;
const hash = n => `0x${n.toString(16).padStart(64, "0")}`;
const CA = addr(900);
const iso = n => new Date(n).toISOString();

function rawTrades(now, { fomoCount = 3, buyers = 6, sell = false } = {}) {
  const end = Math.floor(now / MINUTE) * MINUTE;
  const rows = Array.from({ length: buyers }, (_, i) => ({ maker: addr(i + 1), base_address: CA,
    chain: "bsc", transaction_hash: hash(i + 1 + end / MINUTE * 10), side: "buy", amount_usd: "3000",
    timestamp: (end - MINUTE) / 1000, maker_info: { tags: i >= buyers - fomoCount ? ["fomo"] : [] }, base_token: { symbol: "TEST" } }));
  if (sell) rows.push({ ...rows[0], transaction_hash: hash(99 + end / MINUTE * 10), side: "sell" });
  return rows;
}

function rawProfile(wallet, now, profitable = true) {
  return { wallet_address: wallet, chain: "bsc", realized_profit: profitable ? 15_000 : 0,
    realized_profit_pnl: 0.5, pnl_stat: { winrate: 0.7, token_num: 150 }, buy: 200, sell: 200,
    last_timestamp: Math.floor(now / 1000) - 60,
    common: { tags: [], created_at: Math.floor(now / 1000) - 90 * 86400, created_token_count: 0 } };
}

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gmgn-flow-monitor-"));
  let time = START;
  const calls = [], sent = [], instances = [];
  const client = {};
  const defaults = {
    trades: async chain => ({ code: 0, data: { list: chain === "bsc" ? rawTrades(time, options) : [] } }),
    trending: async () => ({ data: { rank: [{ address: CA, symbol: "TEST", name: "Test project", ...options.market }] } }),
    candles: async () => ({ data: { list: Array.from({ length: 20 }, (_, i) => ({
      time: Math.floor(time / MINUTE) * MINUTE - (20 - i) * MINUTE,
      volume: i < 15 ? 1000 : options.surge === false ? 1000 : 10000,
      amount: (i < 15 ? 1000 : options.surge === false ? 1000 : 10000) * 10, low: .09, high: .11,
    })) } }),
    stats: async (_chain, wallets) => ({ data: wallets.map(w => rawProfile(w, time, Number.parseInt(w.slice(2), 16) <= (options.profitableCount ?? 5))) }),
    info: async () => ({ data: { chain: "bsc", address: CA, symbol: "TEST", name: "Test project",
      link: { description: "A project-claimed AI agent experiment." } } }),
    hotSearches: async chains => ({ data: chains.map(chain => ({ chain, tokens: [{ address: "discovery only" }] })) }),
    stop: async () => {},
  };
  for (const [name, fn] of Object.entries(defaults)) client[name] = async (...args) => {
    calls.push({ name, args, at: time }); return (options.client?.[name] || fn)(...args);
  };
  const config = { dataDir, gmgnFlowMonitorEnabled: true, gmgnFlowPollIntervalMs: 5000, gmgnFlowAdaptiveSchedulingEnabled:false,...options.config };
  const create = (overrides = {}) => {
    const monitor = createGmgnFlowMonitor(config, { client, autoStart: false, now: () => time, logger: { error() {} },
      narrativeEventsImpl: async () => [], sendAlertsImpl: async (_config, event) => {
        const durable = JSON.parse(await fs.readFile(path.join(dataDir, "gmgn-flow-state.json"), "utf8"));
        assert.ok(durable.pendingEvents.some(e => e.eventKey === event.eventKey), "reserve before sending");
        sent.push(structuredClone(event));
        return options.send ? options.send(event) : { status: "queued" };
      }, ...overrides });
    instances.push(monitor); return monitor;
  };
  t.after(async () => { for (const monitor of instances) await monitor.stop().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  const step = async (monitor, count = 1) => {
    for (let i = 0; i < count; i++) { await monitor.check(); time += 15_000; }
  };
  return { dataDir, calls, sent, client, create, step, now: () => time,
    advance: ms => { time += ms; }, file: path.join(dataDir, "gmgn-flow-state.json") };
}

test("GMGN disabled monitor neither loads files nor invokes its client", async (t) => {
  const f = await fixture(t, { config: { gmgnFlowMonitorEnabled: false } });
  const monitor = f.create();
  assert.deepEqual(await monitor.check(), { status: "disabled" });
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
});

async function until(predicate) {
  const deadline=Date.now()+3000;
  while(!predicate()){
    if(Date.now()>deadline)assert.fail('bounded background job did not reach checkpoint');
    await new Promise(r=>setTimeout(r,5));
  }
}

test('paired feeds start together, keep kind identity out of order and wait for both before commit',async t=>{
  const pending={};let f;
  f=await fixture(t,{config:{gmgnFlowParallelFeedReads:true,gmgnFlowResearchDecoupled:true},client:{
    trades:async(_chain,kind,{onRequestStart})=>new Promise(resolve=>{pending[kind]={resolve,onRequestStart};})
  }});
  const monitor=f.create();const running=monitor.check();
  try{
    await until(()=>pending.smartmoney&&pending.kol);
    assert.equal(f.calls.filter(c=>c.name==='trades').length,2);
    f.advance(1000);pending.kol.onRequestStart(f.now());f.advance(200);pending.kol.resolve({data:{list:[]}});
    await until(()=>monitor.state().chains.sol.feedTiming?.kol?.status==='ok');
    assert.equal(monitor.state().chains.sol.lastFeedSuccessAt,undefined);
    f.advance(3000);pending.smartmoney.onRequestStart(f.now());f.advance(800);pending.smartmoney.resolve({data:{list:[]}});
    await running;
    const h=monitor.state().chains.sol;
    assert.equal(h.feedTiming.kol.queueWaitMs,1000);assert.equal(h.feedTiming.kol.responseMs,200);
    assert.equal(h.feedTiming.smartmoney.queueWaitMs,4200);assert.equal(h.feedTiming.smartmoney.responseMs,800);
    assert.equal(h.feedCoverage.kol.endAt,START+1000);
    assert.equal(h.feedCoverage.smartmoney.endAt,START+4200);
    assert.equal(h.lastFeedSuccessAt,iso(START+1000),'source freshness is the earlier dispatch, not the last response');
    assert.equal(monitor.state().scheduling.feed.reads,'account_gated_pair_v1');
  }finally{for(const p of Object.values(pending))p.resolve({data:{list:[]}});await running;await monitor.stop();}
});

test('paired failure drains the other page and never commits half coverage or starts another chain',async t=>{
  const pending={};const f=await fixture(t,{config:{gmgnFlowParallelFeedReads:true},client:{
    trades:async(_chain,kind)=>new Promise((resolve,reject)=>{pending[kind]={resolve,reject};})
  }});
  const monitor=f.create();let done=false;const running=monitor.check().then(()=>{done=true;});
  try{
    await until(()=>pending.smartmoney&&pending.kol);
    pending.smartmoney.reject(Object.assign(new Error('timeout'),{code:'GMGN_CLI_TIMEOUT'}));
    await until(()=>monitor.state().chains.sol.feedTiming?.smartmoney?.status==='failed');
    const concurrent=monitor.check();await new Promise(r=>setTimeout(r,10));
    assert.equal(done,false);assert.equal(f.calls.filter(c=>c.name==='trades').length,2);
    pending.kol.resolve({data:{list:[]}});await Promise.all([running,concurrent]);
    const h=monitor.state().chains.sol;assert.equal(h.status,'backoff');assert.equal(h.lastErrorCode,'GMGN_CLI_TIMEOUT');
    assert.equal(h.feedCoverage,undefined);assert.equal(h.feedTiming.kol.dispatchedAt,null);
    assert.equal(h.feedTiming.kol.queueWaitMs,null);
  }finally{for(const p of Object.values(pending))p.resolve({data:{list:[]}});await running;await monitor.stop();}
});

test('paired 429 is visible before other page drains and remains global across restart',async t=>{
  const pending={};const retryAt=iso(START+5*MINUTE);
  const f=await fixture(t,{config:{gmgnFlowParallelFeedReads:true,gmgnFlowResearchDecoupled:true},client:{
    trades:async(_chain,kind)=>new Promise((resolve,reject)=>{pending[kind]={resolve,reject};})
  }});
  const monitor=f.create();const running=monitor.check();
  try{
    await until(()=>pending.smartmoney&&pending.kol);
    pending.smartmoney.reject(Object.assign(new Error('limit'),{code:'GMGN_RATE_LIMITED',retryAt}));
    await until(()=>monitor.state().health.lastErrorCode==='GMGN_RATE_LIMITED');
    assert.equal(monitor.state().health.nextAttemptAt,retryAt);
    pending.kol.reject(Object.assign(new Error('timeout'),{code:'GMGN_CLI_TIMEOUT'}));await running;
    assert.equal(monitor.state().chains.sol.lastErrorCode,'GMGN_RATE_LIMITED');
    await monitor.stop();const restored=f.create();await restored.check();
    assert.equal(f.calls.filter(c=>c.name==='trades').length,2);
    assert.equal(restored.state().health.nextAttemptAt,retryAt);
  }finally{for(const p of Object.values(pending))p.resolve({data:{list:[]}});await running;await monitor.stop();}
});

test('shutdown drains both feed requests without committing cancelled pages or sending alerts',async t=>{
  const pending={};const f=await fixture(t,{config:{gmgnFlowParallelFeedReads:true,gmgnFlowResearchDecoupled:true},client:{
    trades:async(_chain,kind)=>new Promise(resolve=>{pending[kind]=resolve;}),
    stop:async()=>{for(const resolve of Object.values(pending))resolve({data:{list:[]}});}
  }});
  const monitor=f.create();const running=monitor.check();
  await until(()=>pending.smartmoney&&pending.kol);await monitor.stop();await running;await monitor.check();
  assert.equal(f.calls.filter(c=>c.name==='trades').length,2);assert.equal(f.sent.length,0);
  assert.equal(monitor.state().chains.sol.feedCoverage,undefined);
  assert.equal(monitor.state().scheduling.feed.activeChain,null);
});

test('split lanes keep collecting every chain while one profile stalls, coalesce backlog and drain on stop', {timeout:10000},async t=>{
  let release,entered;const ready=new Promise(r=>{entered=r;});
  const f=await fixture(t,{config:{gmgnFlowResearchDecoupled:true},client:{stats:async()=>{
    entered();await new Promise(r=>{release=r;});return {data:[]};
  }}});
  const monitor=f.create();
  try {
    await f.step(monitor,2);await ready;
    await f.step(monitor,12);
    const state=monitor.state(),lane=state.scheduling;
    assert.equal(lane.version,'split_feed_research_v1');assert.equal(lane.research.activeChain,'bsc');
    assert.equal(f.calls.filter(c=>c.name==='trades').length,28,'feed cycles do not wait for profile response');
    assert.equal(f.calls.filter(c=>c.name==='stats').length,1,'never start a second research worker');
    assert.ok(lane.research.pendingChains.length<=5);assert.ok(lane.research.coalesced>0);
    assert.equal(new Set(lane.research.pendingChains).size,lane.research.pendingChains.length);
    assert.ok(Date.parse(state.chains.bsc.lastFeedSuccessAt)>START+MINUTE);
    assert.equal(validateGmgnFlowState(state),state);
    const durable=JSON.parse(await fs.readFile(f.file,'utf8'));
    assert.equal(durable.chains.bsc.lastFeedSuccessAt,state.chains.bsc.lastFeedSuccessAt);
    const stopping=monitor.stop();release();await stopping;
    assert.equal(f.calls.filter(c=>c.name==='stats').length,1,'shutdown does not launch the next period or queued jobs');
    assert.equal(monitor.state().scheduling.research.activeChain,null);
    assert.deepEqual(monitor.state().scheduling.research.pendingChains,[]);
  }finally{release?.();await monitor.stop();}
});

test('split research errors do not overwrite newer feed success or failure',async t=>{
  for(const failFeed of [false,true]){
    let release,entered,broken=false;const ready=new Promise(r=>{entered=r;});
    let f;f=await fixture(t,{config:{gmgnFlowResearchDecoupled:true},client:{
      stats:async()=>{entered();await new Promise(r=>{release=r;});throw Object.assign(new Error('timeout'),{code:'GMGN_CLI_TIMEOUT'});},
      trades:async chain=>{if(broken&&chain==='bsc')throw Object.assign(new Error('feed failed'),{code:'GMGN_CLI_FAILED'});
        return {data:{list:chain==='bsc'?rawTrades(f.now()):[]}};}
    }});
    const monitor=f.create();
    try {
      await f.step(monitor,2);await ready;broken=failFeed;await f.step(monitor,5);
      const before=structuredClone(monitor.state().chains.bsc);
      release();await until(()=>monitor.state().chains.bsc.research.lastErrorCode==='GMGN_CLI_TIMEOUT');
      const after=monitor.state().chains.bsc;
      assert.equal(after.status,before.status);assert.equal(after.lastErrorCode,before.lastErrorCode);
      assert.equal(after.lastFeedSuccessAt,before.lastFeedSuccessAt);
      assert.equal(after.coverageGap,before.coverageGap);
      assert.equal(after.research.coverageGap,'research_unavailable');
      assert.equal(after.research.status,'backoff');assert.equal(f.sent.length,0);
    }finally{release?.();await monitor.stop();}
  }
});

test('split research 429 stops queued work and later feed pages, and survives restart',async t=>{
  let release,entered;const ready=new Promise(r=>{entered=r;});let f;
  f=await fixture(t,{config:{gmgnFlowResearchDecoupled:true},client:{stats:async()=>{
    entered();await new Promise(r=>{release=r;});throw Object.assign(new Error('account limit'),{code:'GMGN_RATE_LIMITED',retryAt:iso(f.now()+5*MINUTE)});
  }}});
  const monitor=f.create();
  try {
    await f.step(monitor,2);await ready;await f.step(monitor,2);
    release();await until(()=>monitor.state().health.lastErrorCode==='GMGN_RATE_LIMITED');
    const count=f.calls.length;await f.step(monitor,3);assert.equal(f.calls.length,count);
    await monitor.stop();const stoppedCount=f.calls.length;
    const restarted=f.create();await restarted.check();assert.equal(f.calls.length,stoppedCount);
    assert.equal(restarted.state().health.status,'backoff');
  }finally{release?.();await monitor.stop();}
});

test('a background 429 between trade pages blocks the second page before it reaches the client',async t=>{
  let releaseProfile,releaseFeed,enteredProfile,enteredFeed,f;
  const profileReady=new Promise(r=>{enteredProfile=r;}),feedReady=new Promise(r=>{enteredFeed=r;});
  f=await fixture(t,{config:{gmgnFlowResearchDecoupled:true},client:{
    stats:async()=>{enteredProfile();await new Promise(r=>{releaseProfile=r;});throw Object.assign(new Error('limit'),
      {code:'GMGN_RATE_LIMITED',retryAt:iso(f.now()+5*MINUTE)});},
    trades:async(chain,kind)=>{
      if(chain==='base'&&kind==='smartmoney'){enteredFeed();await new Promise(r=>{releaseFeed=r;});}
      return {data:{list:chain==='bsc'?rawTrades(f.now()):[]}};
    }
  }});
  const monitor=f.create();
  try{
    await f.step(monitor,2);await profileReady;
    const next=monitor.check();await feedReady;
    releaseProfile();await until(()=>monitor.state().health.lastErrorCode==='GMGN_RATE_LIMITED');
    releaseFeed();await next;
    assert.deepEqual(f.calls.filter(c=>c.name==='trades'&&c.args[0]==='base').map(c=>c.args[1]),['smartmoney']);
    assert.equal(monitor.state().health.status,'backoff');
  }finally{releaseProfile?.();releaseFeed?.();await monitor.stop();}
});

test('slow durable alert delivery occupies only the research lane and never duplicates the event',async t=>{
  let release,entered;const ready=new Promise(r=>{entered=r;});
  const f=await fixture(t,{config:{gmgnFlowResearchDecoupled:true},send:async()=>{
    entered();await new Promise(r=>{release=r;});return {status:'queued'};
  }});
  const monitor=f.create();
  try {
    await f.step(monitor,2);await ready;await f.step(monitor,5);
    assert.equal(f.calls.filter(c=>c.name==='trades').length,14);
    assert.equal(f.sent.length,1);assert.equal(monitor.state().pendingEvents.length,1);
    release();await until(()=>monitor.state().pendingEvents.length===0);
    assert.equal(f.sent.length,1);assert.ok(monitor.state().episodes[`bsc:${CA}`].lastSentAt);
  }finally{release?.();await monitor.stop();}
});

test('upstream zero wallet age is durable missing evidence, not a successful qualification',async t=>{
  const f=await fixture(t,{client:{stats:async (_chain,wallets)=>({data:wallets.map(w=>{
    const p=rawProfile(w,START);p.common.created_at=0;return p;
  })})}});
  const monitor=f.create();await f.step(monitor,2);
  const state=monitor.state(),p=state.profiles[`bsc:${addr(1)}`];
  assert.equal(p['7d'].realizedProfitUsd,15000);
  assert.equal(p.lastProfileIssue,'upstream_profile_evidence_incomplete');
  assert.equal(p.qualification.status,'missing_evidence');
  assert.ok(p.qualification.missing.includes('7d:wallet_age_unknown'));
  assert.equal(state.chains.bsc.walletResearch.qualified,0);
  assert.equal(state.chains.bsc.walletResearch.reasonCounts.wallet_age_unknown,6);
  assert.equal(f.sent.length,0);
  const durable=JSON.parse(await fs.readFile(f.file,'utf8'));
  assert.equal(durable.profiles[`bsc:${addr(1)}`].qualification.qualified,false);
});

test('ETH receipt-resolved split trades survive durable restart and partial follow-up feeds without double counting', async t => {
  const at=START-60000, tx=hash(77), blockHash=hash(88), wallet=addr(1);
  const raw=(base,quote)=>({chain:'eth',maker:wallet,base_address:CA,transaction_hash:tx,side:'sell',
    timestamp:at/1000,base_amount:base,quote_amount:quote,amount_usd:quote*10,maker_info:{tags:['smart_degen']}});
  let partial=false, requests=0;
  const f=await fixture(t,{client:{trades:async chain=>({data:{list:chain==='eth'?(partial?[raw(100,1)]:[raw(100,1),raw(200,2)]):[]}})}});
  const receipt={status:'0x1',transactionHash:tx,from:wallet,blockHash,blockNumber:'0x1',logs:[{
    address:CA,topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',hash(1),hash(2)],
    data:'0x'+(300n*10n**18n).toString(16).padStart(64,'0'),logIndex:'0x1'}]};
  const resolver=()=>createEthTradeLegResolver({now:f.now,fetchImpl:async(_url,opt)=>{
    requests++;const {method}=JSON.parse(opt.body);
    const result={eth_chainId:'0x1',eth_call:'0x12',eth_getTransactionReceipt:receipt,
      eth_getBlockByHash:{hash:blockHash,timestamp:'0x'+(at/1000).toString(16)}}[method];
    assert.ok(result);return {ok:true,json:async()=>({id:1,result})};
  }});
  const first=f.create({legResolver:resolver()});await f.step(first,5);
  assert.equal(first.state().trades.eth.length,1);assert.equal(first.state().trades.eth[0].amountUsd,30);
  assert.equal(first.state().chains.eth.receiptResolvedTrades,1);assert.equal(requests,4);
  await first.stop();partial=true;
  const restarted=f.create({legResolver:resolver()});await f.step(restarted,5);
  const durable=JSON.parse(await fs.readFile(f.file,'utf8'));
  assert.equal(validateGmgnFlowState(durable),durable);
  assert.equal(durable.trades.eth.length,1);assert.equal(durable.trades.eth[0].baseAmount,300);
  assert.equal(durable.trades.eth[0].amountUsd,30);assert.equal(requests,4,'persisted receipt proof handles a partial poll without a new RPC');
  assert.equal(durable.chains.eth.receiptResolvedTrades,1);assert.equal(f.sent.length,0);
});

test('adaptive scheduling revisits dense feeds before they roll off without starving quiet chains',()=>{
 const state={nextChainIndex:0,chains:Object.fromEntries(Object.keys(GMGN_FLOW_CHAINS).map(c=>[c,{lastFeedSuccessAt:iso(START-30000),nextAttemptAt:null}]))};
 state.chains.robinhood.feedCoverage={smartmoney:{valid:true,count:100,oldestAt:START-70000,endAt:START-30000}};
 assert.equal(selectGmgnFlowChain(state,START),'robinhood');
 state.chains.eth.lastFeedSuccessAt=iso(START-121000);assert.equal(selectGmgnFlowChain(state,START),'eth');
 state.chains.eth.nextAttemptAt=iso(START+60000);state.chains.robinhood.nextAttemptAt=iso(START+60000);
 assert.equal(selectGmgnFlowChain(state,START),'sol');
});

test('failed chains cannot starve unattempted chains by keeping an older last success', () => {
 const state={nextChainIndex:0,chains:Object.fromEntries(Object.keys(GMGN_FLOW_CHAINS).map(c=>[c,{lastFeedSuccessAt:iso(START-7_200_000),checkedAt:iso(START-30_000),nextAttemptAt:null}]))};
 state.chains.sol.lastFeedSuccessAt=iso(START-7_000_000);state.chains.sol.checkedAt=iso(START-7_000_000);
 state.chains.bsc.lastFeedSuccessAt=iso(START-7_100_000);state.chains.bsc.checkedAt=iso(START-7_100_000);
 assert.equal(selectGmgnFlowChain(state,START),'bsc');
 state.chains.bsc.checkedAt=iso(START);
 assert.equal(selectGmgnFlowChain(state,START),'sol');
});

test("GMGN polls exactly one full chain per cycle and keeps hot-only chains discovery-only", async (t) => {
  const f = await fixture(t, { buyers: 0 }); const monitor = f.create();
  await f.step(monitor, 5);
  assert.deepEqual(f.calls.filter(c => c.name === "trades").map(c => c.args.slice(0,2)),
    Object.keys(GMGN_FLOW_CHAINS).flatMap(chain => [[chain, "smartmoney"], [chain, "kol"]]));
  assert.deepEqual(f.calls.find(c => c.name === "hotSearches").args[0], GMGN_HOT_ONLY_CHAINS);
  assert.equal(f.calls.some(c => ["stats", "candles", "info"].includes(c.name)), false);
  assert.equal(f.sent.length, 0);
  assert.equal(monitor.state().nextChainIndex, 0);
  assert.ok(monitor.state().hotDiscovery.chains.every(c => c.mode === "discovery_only"));
});

test("GMGN volume plus verified high-profit and FOMO entrants produces one durable narrative alert", async (t) => {
  const f = await fixture(t); const monitor = f.create(); await f.step(monitor, 2);
  assert.equal(f.sent.length, 1);
  const event = f.sent[0];
  assert.equal(isGmgnFlowEvent(event), true);
  assert.equal(event.signal.highProfitCount, 5);
  assert.equal(event.signal.fomoCount, 3);
  assert.equal(event.signal.uniqueBuyerCount, 6);
  assert.equal(event.signal.overlapCount, 2);
  assert.equal(event.signal.netBuyUsd, 18_000);
  assert.equal(event.signal.volumeUsd, 50_000);
  assert.equal(event.signal.volumeMultiple, 10);
  assert.equal(event.narrative.status, "project_claim");
  assert.equal(event.narrative.tokenAddress, CA);
  assert.equal(monitor.state().pendingEvents.length, 0);
  assert.ok(monitor.state().episodes[`bsc:${CA}`]);
  assert.deepEqual(f.calls.filter(c => c.name === "stats").map(c => c.args[2]), ["7d", "30d"]);
});

test('GMGN enriches paper candidates without requiring FOMO or a completed volume alert',async t=>{
  const f=await fixture(t,{fomoCount:0,buyers:4,surge:false});const monitor=f.create();await f.step(monitor,2);
  assert.deepEqual(f.calls.filter(c=>c.name==='stats').map(c=>c.args[2]),['7d','30d']);
  assert.equal(Object.keys(monitor.state().profiles).length,4);assert.equal(f.sent.length,0);
  assert.equal(f.calls.some(c=>c.name==='candles'),false);
});

test('two-buyer paper candidates get bounded profitability research before the larger alert threshold',async t=>{
  const f=await fixture(t,{buyers:2,fomoCount:0}),monitor=f.create();await f.step(monitor,2);
  assert.equal(Object.keys(monitor.state().profiles).length,2);
  assert.deepEqual(f.calls.filter(c=>c.name==='stats').map(c=>c.args[2]),['7d','30d']);
  assert.equal(f.sent.length,0,'research does not weaken the alert or trading gates');
});

test('unqualified profiles never spend the chart or metadata budget needed by dense feeds',async t=>{
  const f=await fixture(t,{profitableCount:0});const monitor=f.create();await f.step(monitor,2);
  assert.equal(f.calls.filter(c=>c.name==='stats').length,2);
  assert.equal(f.calls.some(c=>['trending','candles','info'].includes(c.name)),false);
  assert.equal(f.sent.length,0);
});

test('partial batch stats switches to single-wallet requests without falsely caching omitted wallets',async t=>{
  let f;
  f=await fixture(t,{fomoCount:0,buyers:4,client:{stats:async(_chain,wallets)=>({data:rawProfile(wallets[0],f.now())})}});
  const monitor=f.create();await f.step(monitor,2);
  let state=monitor.state();assert.equal(state.chains.bsc.profileBatchSize,1);
  assert.ok(state.profiles[`bsc:${addr(1)}`]['7d']);assert.ok(state.profiles[`bsc:${addr(1)}`]['30d']);
  assert.equal(state.profiles[`bsc:${addr(2)}`].lastProfileIssue,'upstream_wallet_not_returned');
  assert.ok(Date.parse(state.profiles[`bsc:${addr(2)}`].nextCheckAt)<=f.now()+15000);
  await f.step(monitor,5);state=monitor.state();
  assert.ok(state.profiles[`bsc:${addr(2)}`]['7d']);assert.ok(state.profiles[`bsc:${addr(2)}`]['30d']);
  assert.ok(f.calls.filter(c=>c.name==='stats').slice(2).every(c=>c.args[1].length===1));
  assert.equal(validateGmgnFlowState(state),state);
});

test("GMGN missing any joint condition or net-entry count emits no alert", async (t) => {
  for (const options of [{ surge: false }, { profitableCount: 4 }, { fomoCount: 2 }, { buyers: 5 }, { sell: true }]) {
    const f = await fixture(t, options); const monitor = f.create(); await f.step(monitor, 2);
    assert.equal(f.sent.length, 0, JSON.stringify(options));
  }
});

test("GMGN known wash-trading or honeypot flags suppress the candidate", async (t) => {
  for (const market of [{ is_wash_trading: true }, { is_honeypot: true }, { rug_ratio: 0.4 }]) {
    const f = await fixture(t, { market }); const monitor = f.create(); await f.step(monitor, 2);
    assert.equal(f.sent.length, 0);
    // Wallet performance is reusable evidence, not a buy endorsement. Unsafe
    // token metadata still prevents chart/token research and any alert.
    assert.equal(f.calls.some(c => ["candles","info"].includes(c.name)), false);
  }
});

test("GMGN repeated feeds and later windows respect token cooldown across restart", async (t) => {
  const f = await fixture(t); const first = f.create(); await f.step(first, 7);
  assert.equal(f.sent.length, 1);
  assert.equal(first.state().trades.bsc.length, 12, "two windows are retained, duplicate smartmoney/kol rows are merged");
  await first.stop(); const restarted = f.create(); await f.step(restarted, 5);
  assert.equal(f.sent.length, 1, "persisted episode suppresses another alert inside cooldown");
  f.advance(31 * MINUTE); await f.step(restarted, 5);
  assert.equal(f.sent.length, 2, "a new qualifying episode can alert after cooldown");
});

test("GMGN rejected delivery survives restart and is replayed before collecting more trades", async (t) => {
  let durable = false;
  const f = await fixture(t, { send: () => ({ status: durable ? "queued" : "failed" }) });
  const first = f.create(); await f.step(first, 2);
  const pending = first.state().pendingEvents;
  assert.equal(pending.length, 1);
  assert.ok(Object.values(first.state().episodes).every(episode => !episode.lastSentAt));
  await first.stop(); durable = true;
  const before = f.calls.length, restarted = f.create(); await restarted.check();
  assert.equal(restarted.state().pendingEvents.length, 0);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].eventKey, f.sent[1].eventKey);
  assert.equal(restarted.state().episodes[`bsc:${CA}`].eventKey, pending[0].eventKey);
  assert.equal(f.calls.slice(before).find(c => c.name === "trades")?.args[0], "base");
});

test("GMGN durable sender duplicate acknowledgement clears reserved pending item", async (t) => {
  const f = await fixture(t, { send: () => ({ status: "duplicate" }) });
  const monitor = f.create(); await f.step(monitor, 2);
  assert.equal(f.sent.length, 1);
  assert.equal(monitor.state().pendingEvents.length, 0);
  assert.equal(Object.keys(monitor.state().episodes).length, 1);
});

test("GMGN 429 stops all chain requests until durable global cooldown expires", async (t) => {
  let limited = true, f;
  f = await fixture(t, { client: { trades: async () => {
    if (limited) throw Object.assign(new Error("account limit"), { code: "GMGN_RATE_LIMITED", retryAt: iso(f.now() + 5 * MINUTE) });
    return { data: { list: [] } };
  } } });
  const monitor = f.create(); await monitor.check();
  assert.equal(monitor.state().health.status, "backoff");
  assert.equal(f.calls.filter(c => c.name === "trades").length, 1);
  await f.step(monitor, 4);
  assert.equal(f.calls.filter(c => c.name === "trades").length, 1);
  await monitor.stop(); const restarted = f.create(); await restarted.check();
  assert.equal(f.calls.filter(c => c.name === "trades").length, 1);
  limited = false; f.advance(5 * MINUTE); await restarted.check();
  assert.deepEqual(f.calls.filter(c => c.name === "trades").slice(1).map(c => c.args.slice(0,2)), [["bsc", "smartmoney"], ["bsc", "kol"]]);
});

test('coverage uses actual feed dispatch boundaries after queue waits',async t=>{
  let f;const dispatches=[];
  f=await fixture(t,{client:{trades:async(_chain,_kind,{onRequestStart})=>{
    f.advance(15000);dispatches.push(f.now());onRequestStart(f.now());
    f.advance(1000);return {data:{list:[]}};
  }}});
  const monitor=f.create();await monitor.check();
  const feed=monitor.state().chains.sol;
  assert.equal(feed.feedCoverage.smartmoney.endAt,dispatches[0]);
  assert.equal(feed.feedCoverage.kol.endAt,dispatches[1]);
  assert.equal(feed.lastFeedSuccessAt,iso(dispatches[0]));
  assert.equal(feed.feedCoverage.kol.observedAt,dispatches[1]+1000);
});

test('profile timeouts preserve durable fresh feed health and back off only research across restart',async t=>{
 let f;
 f=await fixture(t,{client:{stats:async()=>{throw Object.assign(new Error('profile timeout'),{code:'GMGN_CLI_TIMEOUT'});}}});
 const monitor=f.create();await f.step(monitor,2);
 const h=monitor.state().chains.bsc;
 assert.equal(h.status,'partial');assert.equal(h.lastErrorCode,null);
 assert.equal(h.lastSuccessAt,h.lastFeedSuccessAt);assert.equal(h.research.lastErrorCode,'GMGN_CLI_TIMEOUT');
 assert.ok(Date.parse(h.nextAttemptAt)<Date.parse(h.research.nextAttemptAt));
 assert.equal(h.coverageGap,'research_unavailable');assert.equal(monitor.state().trades.bsc.length,6);
 assert.equal(f.calls.filter(c=>c.name==='stats').length,1);assert.equal(f.sent.length,0);
 await monitor.stop();
 const saved=JSON.parse(await fs.readFile(f.file,'utf8'));saved.nextChainIndex=1;
 await fs.writeFile(f.file,JSON.stringify(saved));
 const restarted=f.create();await restarted.check();
 assert.equal(f.calls.filter(c=>c.name==='trades'&&c.args[0]==='bsc').length,4);
 assert.equal(f.calls.filter(c=>c.name==='stats').length,1,'research cooldown is durable but does not throttle feeds');
 assert.equal(validateGmgnFlowState(restarted.state()).chains.bsc.status,'partial');
 f.advance(MINUTE);await f.step(restarted,5);
 assert.equal(f.calls.filter(c=>c.name==='stats').length,2);
});

test('fresh feed recovery is committed before an optional slow profile query finishes',async t=>{
 let release,entered;const ready=new Promise(r=>{entered=r;});
 const f=await fixture(t,{client:{stats:async()=>{entered();await new Promise(r=>{release=r;});return {data:[]};}}});
 const first=f.create();await f.step(first);await first.stop();
 const saved=JSON.parse(await fs.readFile(f.file,'utf8'));
 Object.assign(saved.chains.bsc,{status:'backoff',lastError:'old timeout',lastErrorCode:'GMGN_CLI_TIMEOUT'});
 await fs.writeFile(f.file,JSON.stringify(saved));
 const monitor=f.create();const active=monitor.check();await ready;
 const durable=JSON.parse(await fs.readFile(f.file,'utf8'));
 assert.equal(durable.chains.bsc.lastErrorCode,null);assert.equal(durable.chains.bsc.status,'healthy');
 assert.equal(durable.chains.bsc.lastSuccessAt,durable.chains.bsc.lastFeedSuccessAt);
 assert.equal(durable.trades.bsc.length,6);
 // Stop at the paused read so the second profile period cannot start.
 const stopping=monitor.stop();release();await stopping;await active;
});

test('optional research 429 honors global cooldown without erasing successful feed observations',async t=>{
 for(const stage of ['stats','trending','candles','info','hotSearches']){
  let f;f=await fixture(t,{client:{[stage]:async()=>{throw Object.assign(new Error('account limit'),
   {code:'GMGN_RATE_LIMITED',retryAt:iso(f.now()+5*MINUTE)});}}});
  const monitor=f.create();await f.step(monitor,stage==='hotSearches'?5:2);
  const state=monitor.state(),chain=stage==='hotSearches'?'robinhood':'bsc';
  assert.equal(state.health.status,'backoff',stage);assert.equal(state.chains[chain].status,'partial',stage);
  assert.equal(state.chains[chain].lastErrorCode,null,stage);
  assert.equal(state.chains[chain].lastSuccessAt,state.chains[chain].lastFeedSuccessAt,stage);
  await monitor.stop();const count=f.calls.length;const restarted=f.create();await f.step(restarted,3);
  assert.equal(f.calls.length,count,'no calls during persisted account cooldown: '+stage);
  if(stage!=='hotSearches')assert.equal(f.sent.length,0,stage);
 }
});

test('a candle timeout isolates research without changing required signal evidence',async t=>{
 const f=await fixture(t,{client:{candles:async()=>{throw Object.assign(new Error('timeout'),{code:'GMGN_CLI_TIMEOUT'});}}});
 const monitor=f.create();await f.step(monitor,2);
 assert.equal(monitor.state().chains.bsc.status,'partial');
 assert.equal(monitor.state().chains.bsc.research.lastErrorCode,'GMGN_CLI_TIMEOUT');
 assert.equal(monitor.state().health.nextAttemptAt,null);assert.equal(f.sent.length,0);
});

test("GMGN single-flight checks share work and stop interrupts the active client without more requests", async (t) => {
  let release, entered;
  const ready = new Promise(r => { entered = r; });
  const f = await fixture(t, { client: {
    trades: () => new Promise((_resolve, reject) => { release = () => reject(Object.assign(new Error("stopped"), { code: "GMGN_STOPPED" })); entered(); }),
    stop: async () => release?.(),
  } });
  const monitor = f.create(); const a = monitor.check(), b = monitor.check();
  assert.equal(a, b); await ready; await monitor.stop(); await a;
  assert.equal(f.calls.filter(c => c.name === "trades").length, 1);
  assert.deepEqual(await monitor.check(), { status: "stopped" });
  assert.equal(f.sent.length, 0);
});

test("GMGN malformed persisted JSON fails closed without any network attempt", async (t) => {
  const f = await fixture(t); await fs.writeFile(f.file, "{broken"); const monitor = f.create();
  await assert.rejects(monitor.check());
  assert.equal(f.calls.length, 0);
  assert.equal(await fs.readFile(f.file, "utf8"), "{broken");
});

test("GMGN missing profile evidence never substitutes smart-money labels for profitability", async (t) => {
  const f = await fixture(t, { client: { stats: async () => ({ data: [] }) } });
  const monitor = f.create(); await f.step(monitor, 2);
  assert.equal(f.sent.length, 0);
  assert.equal(monitor.state().chains.bsc.status, "partial");
  assert.equal(monitor.state().chains.bsc.coverageGap, "wallet_profile_incomplete");
});

test("GMGN metadata outage retains measured signal with an explicitly unverified narrative", async (t) => {
  const f = await fixture(t, { client: { info: async () => { throw new Error("temporarily unavailable"); } } });
  const monitor = f.create(); await f.step(monitor, 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].narrative.status, "unverified");
  assert.equal(f.sent[0].narrative.sourceUrl, null);
  assert.equal(monitor.state().chains.bsc.coverageGap, "narrative_metadata_unavailable");
  assert.equal(isGmgnFlowEvent(f.sent[0]), true);
});

test("GMGN conflicting duplicate trade amounts quarantine the token without a chain-wide backoff", async (t) => {
  let f;
  f = await fixture(t, { client: { trades: async (chain, kind) => ({ data: { list: chain !== "bsc" ? []
    : rawTrades(f.now()).map((row, i) => ({ ...row, amount_usd: kind === "kol" && i === 0 ? "9999" : row.amount_usd })) } }) } });
  const monitor = f.create(); await f.step(monitor, 2);
  assert.equal(f.sent.length, 0);
  assert.equal(f.calls.some(c => c.name === "stats"), false);
  assert.equal(monitor.state().chains.bsc.status, "partial");
  assert.equal(monitor.state().chains.bsc.lastErrorCode, null);
  assert.equal(monitor.state().chains.bsc.coverageGap, "ambiguous_trade_legs");
  assert.ok(Date.parse(monitor.state().chains.bsc.quarantinedTokens[CA]) > f.now());
  assert.equal(monitor.state().trades.bsc.length, 0);
});

test("GMGN state write fault stops requests and cannot silently reset the checkpoint", async (t) => {
  const f = await fixture(t);
  const brokenFs = { ...fs, rename: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
  const monitor = f.create({ fsImpl: brokenFs });
  await assert.rejects(monitor.check(), /disk full/);
  await assert.rejects(monitor.check(), /disk full/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
});

test("GMGN refuses an oversized restart file before reading or invoking clients", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const monitor = f.create({ fsImpl: { ...fs,
    stat: async () => ({ size: 24 * 1024 * 1024 + 1 }),
    readFile: async () => { reads++; throw new Error("must not read oversized state"); },
  } });
  await assert.rejects(monitor.check(), /GMGN_FLOW_STATE_TOO_LARGE/);
  assert.equal(reads, 0);
  assert.equal(f.calls.length, 0);
});

test("GMGN restart state rejects malformed nested source, trade, episode and profile records", async (t) => {
  const f = await fixture(t, { buyers: 0 }); const seed = f.create(); await seed.check();
  const healthy = seed.state(); await seed.stop();
  const mutations = [
    s => { s.version = 2; }, s => { s.updatedAt = "invalid"; }, s => { s.nextChainIndex = 5; },
    s => { s.health.checkedAt = "invalid"; }, s => { s.chains.sol.status = "invalid"; },
    s => { s.chains.bsc.tradeCount = -1; }, s => { s.trades.bsc = [{}]; },
    s => { s.profiles[`bsc:${addr(1)}`] = { "7d": { chain: "eth", wallet: addr(1) } }; },
    s => { s.episodes[`bsc:${CA}`] = { lastSentAt: "invalid", windowEndAt: "invalid" }; },
    s => { s.pendingEvents = [null]; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const state = structuredClone(healthy); mutate(state);
    assert.throws(() => validateGmgnFlowState(state), /GMGN_/, `mutation ${index}`);
    await fs.writeFile(f.file, JSON.stringify(state));
    const before = f.calls.length, restarted = f.create(); await assert.rejects(restarted.check(), /GMGN_/);
    assert.equal(f.calls.length, before, `mutation ${index} must not reach client`);
  }
});

test("GMGN stop during metadata or narrative read must not send or reserve a new alert", async (t) => {
  for (const stage of ["info", "narrative"]) {
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const pause = () => new Promise(resolve => { release = () => resolve(stage === "info"
      ? { data: { chain: "bsc", address: CA, symbol: "TEST" } } : []); entered(); });
    const f = await fixture(t, { client: { ...(stage === "info" ? { info: pause } : {}), stop: async () => release?.() } });
    const monitor = f.create(stage === "narrative" ? { narrativeEventsImpl: pause } : {});
    await f.step(monitor);
    const active = monitor.check(); await ready; await monitor.stop(); await active;
    assert.equal(f.sent.length, 0, stage);
    assert.equal(monitor.state().pendingEvents.length, 0, stage);
    assert.ok(Object.values(monitor.state().episodes).every(episode => !episode.lastSentAt), stage);
  }
});

test("GMGN terminally expired pending alert does not start a fresh token cooldown", async (t) => {
  let phase = "failing", f;
  f = await fixture(t, { send: event => phase === "failing" ? { status: "failed" }
    : Date.parse(event.observedAt) < f.now() - 15 * MINUTE
      ? { status: "suppressed", terminal: true, reason: "freshness_too_old" } : { status: "queued" } });
  const first = f.create(); await f.step(first, 2); await first.stop();
  phase = "recovering"; f.advance(20 * MINUTE);
  const restarted = f.create(); await restarted.check();
  assert.equal(restarted.state().pendingEvents.length, 0);
  assert.ok(Object.values(restarted.state().episodes).every(episode => !episode.lastSentAt));
  await f.step(restarted, 5);
  assert.equal(f.sent.length, 3, "expired replay is followed by a fresh qualifying signal");
  assert.equal(f.sent[0].eventKey, f.sent[1].eventKey);
  assert.notEqual(f.sent[1].eventKey, f.sent[2].eventKey);
  assert.equal(restarted.state().episodes[`bsc:${CA}`].eventKey, f.sent[2].eventKey);
});

test("GMGN over-800 token evidence is not sliced into a misleading inflow signal", async (t) => {
  let f;
  f = await fixture(t, { client: { trades: async chain => ({ data: { list: chain !== "bsc" ? []
    : Array.from({ length: 801 }, (_, i) => ({ ...rawTrades(f.now())[i % 6], transaction_hash: hash(100_000 + i) })) } }) } });
  const monitor = f.create(); await f.step(monitor, 2);
  assert.equal(monitor.state().trades.bsc.length, 801);
  assert.equal(f.sent.length, 0);
  assert.equal(f.calls.some(call => call.name === "stats"), false);
  assert.equal(monitor.state().chains.bsc.coverageGap, "token_evidence_budget_exceeded");
});

test("GMGN candidate budget rotates beyond the first two tokens instead of starving later candidates", async (t) => {
  const tokens = [CA, addr(901), addr(902)];
  let f;
  f = await fixture(t, { surge: false, client: {
    trades: async chain => ({ data: { list: chain !== "bsc" ? [] : tokens.flatMap((token, tokenIndex) =>
      rawTrades(f.now()).map(row => ({ ...row, base_address: token, amount_usd: String(3000 - tokenIndex * 500) }))) } }),
    trending: async () => ({ data: { rank: tokens.map(address => ({ address })) } }),
  } });
  const monitor = f.create(); await f.step(monitor, 2);
  assert.deepEqual(f.calls.filter(c => c.name === "candles").map(c => c.args[1]), tokens.slice(0, 2));
  assert.equal(monitor.state().chains.bsc.coverageGap, "candidate_budget_limited");
  await f.step(monitor, 5);
  assert.equal(f.calls.filter(c => c.name === "candles")[2].args[1], tokens[2]);
  assert.equal(f.sent.length, 0);
});

test("GMGN incomplete wallet stats persist retry cooldown without claiming complete source coverage", async (t) => {
  const f = await fixture(t, { client: { stats: async () => ({ data: [] }) } });
  const monitor = f.create(); await f.step(monitor, 2);
  const firstRequests = f.calls.filter(c => c.name === "stats").length;
  assert.equal(firstRequests, 2);
  assert.ok(Object.values(monitor.state().profiles).every(p => Date.parse(p.nextCheckAt) > f.now()));
  await f.step(monitor, 5);
  assert.equal(f.calls.filter(c => c.name === "stats").length, firstRequests);
  assert.equal(monitor.state().chains.bsc.coverageGap, "wallet_profile_incomplete");
  assert.equal(monitor.state().chains.bsc.status, "partial");
  assert.equal(f.sent.length, 0);
});

test("GMGN actual producer checkpoint is accepted by semantic health including partial hot-only discovery", async (t) => {
  const f = await fixture(t, { buyers: 0, client: { hotSearches: async () => ({ data: [{ chain: "monad", tokens: [] }] }) } });
  const monitor = f.create(); await f.step(monitor, 5);
  assert.equal(monitor.state().hotDiscovery.status, "partial");
  const report = await runHealthCheck({
    env: { DATA_DIR: f.dataDir, HEALTH_CONFIG_DIR: f.dataDir, GMGN_FLOW_MONITOR_ENABLED: "true", HEALTH_REQUIRE_EXTERNAL_HEARTBEAT: "false" },
    nowMs: f.now(), writeReportFile: false, serviceStateImpl: async () => "active",
    fetchImpl: async () => { throw new Error("network must not be called"); },
  });
  const lane = report.lanes.gmgnFlow;
  assert.equal(lane.operationalHealthy, true, lane.operationalReasons.join(","));
  assert.equal(lane.coverageComplete, false);
  assert.ok(lane.coverageReasons.includes("gmgn_hot_only_chains_no_wallet_verification"));
  assert.ok(lane.coverageReasons.includes("gmgn_flow_source_hotDiscovery_partial"));
});

test("GMGN single-feed conflicting legs quarantine only the ambiguous token while another token alerts", async (t) => {
  for (const conflict of ["amount", "timestamp"]) {
    const other = addr(901);
    let f;
    f = await fixture(t, { client: {
      trades: async (chain, kind) => {
        if (chain !== "bsc") return { data: { list: [] } };
        const rows = rawTrades(f.now());
        const ambiguous = { ...rows[0], ...(conflict === "amount" ? { amount_usd: "9999" } : { timestamp: rows[0].timestamp - 1 }) };
        return { data: { list: [...rows, ...(kind === "smartmoney" ? [ambiguous] : []), ...rows.map(row => ({ ...row, base_address: other }))] } };
      },
      trending: async () => ({ data: { rank: [CA, other].map(address => ({ address, symbol: "TEST" })) } }),
      info: async (chain, address) => ({ data: { chain, address, symbol: "TEST", link: { description: "A project claim." } } }),
    } });
    const monitor = f.create(); await f.step(monitor, 2);
    assert.deepEqual(f.sent.map(event => event.token.address), [other], conflict);
    assert.equal(monitor.state().chains.bsc.status, "partial", conflict);
    assert.equal(monitor.state().chains.bsc.coverageGap, "ambiguous_trade_legs", conflict);
    assert.ok(monitor.state().trades.bsc.every(trade => trade.tokenAddress === other), conflict);
    assert.ok(Date.parse(monitor.state().chains.bsc.quarantinedTokens[CA]) > f.now(), conflict);
    assert.equal(isGmgnFlowEvent(f.sent[0]), true);
    const { lanes: { gmgnFlow: lane } } = await runHealthCheck({
      env: { DATA_DIR: f.dataDir, HEALTH_CONFIG_DIR: f.dataDir, GMGN_FLOW_MONITOR_ENABLED: "true", HEALTH_REQUIRE_EXTERNAL_HEARTBEAT: "false" },
      nowMs: f.now(), writeReportFile: false, serviceStateImpl: async () => "active",
      fetchImpl: async () => { throw new Error("network must not be called"); },
    });
    assert.equal(lane.operationalHealthy, true, lane.operationalReasons.join(","));
    assert.equal(lane.semantic.chains.bsc.quarantinedTokenCount, 1);
    assert.equal(lane.semantic.chains.bsc.coverageComplete, false);
  }
});

test("GMGN quarantine survives restart and a clean later feed until the six-minute exclusion expires", async (t) => {
  let conflicting = true, f;
  f = await fixture(t, { client: { trades: async (chain, kind) => ({ data: { list: chain !== "bsc" ? []
    : rawTrades(f.now()).map((row, i) => ({ ...row, amount_usd: conflicting && kind === "kol" && i === 0 ? "9999" : row.amount_usd })) } }) } });
  const first = f.create(); await f.step(first, 2);
  const deadline = Date.parse(first.state().chains.bsc.quarantinedTokens[CA]);
  assert.ok(deadline > f.now() && deadline <= f.now() + 6 * MINUTE);
  await first.stop(); conflicting = false;
  const restarted = f.create(); await f.step(restarted, 5);
  assert.equal(f.sent.length, 0);
  assert.equal(restarted.state().chains.bsc.coverageGap, "ambiguous_trade_legs");
  assert.equal(Date.parse(restarted.state().chains.bsc.quarantinedTokens[CA]), deadline);
  f.advance(6 * MINUTE); await f.step(restarted, 5);
  assert.equal(f.sent.length, 0, 'isolation discarded observations; expiry alone is not a rebuilt window');
  assert.equal(restarted.state().chains.bsc.quarantinedTokens[CA], undefined);
  assert.ok(Date.parse(restarted.state().chains.bsc.tokenRebuildUntil[CA])>f.now());
  await f.step(restarted,25);
  assert.equal(f.sent.length, 1);
  assert.equal(restarted.state().chains.bsc.tokenRebuildUntil[CA], undefined);
  assert.equal(restarted.state().chains.bsc.status, "healthy");
});

test("GMGN treats the observed 100-row feed cap as truncated coverage", async (t) => {
  for (const length of [99, 100]) {
    let f;
    f = await fixture(t, { client: { trades: async chain => ({ data: { list: chain !== "bsc" ? []
      : Array.from({ length }, (_, i) => ({ ...rawTrades(f.now())[0], transaction_hash: hash(50_000 + i) })) } }) } });
    const monitor = f.create(); await f.step(monitor, 2);
    const source = monitor.state().chains.bsc;
    assert.equal(source.feedTruncated, length === 100, `rows ${length}`);
    assert.equal(source.status, length === 100 ? "partial" : "healthy");
    assert.equal(source.coverageGap, length === 100 ? "bounded_trade_feed_not_full_chain" : null);
    assert.equal(f.sent.length, 0);
  }
});

test("GMGN empty or stale-only feeds do not claim current-window coverage", async (t) => {
  for (const empty of [true, false]) {
    let f;
    f = await fixture(t, { client: { trades: async chain => ({ data: { list: chain !== "bsc" || empty ? []
      : rawTrades(f.now()).map(row => ({ ...row, timestamp: Math.floor(f.now() / 1000) - 10 * 60 })) } }) } });
    const monitor = f.create(); await f.step(monitor, 2);
    assert.equal(monitor.state().chains.bsc.status, "partial");
    assert.equal(monitor.state().chains.bsc.coverageGap, "no_recent_trade_observations");
    assert.equal(f.calls.some(call => call.name === "stats"), false);
    assert.equal(f.sent.length, 0);
  }
});
