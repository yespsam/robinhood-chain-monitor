import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBinanceFlowClient, createBinanceFlowMonitor, BINANCE_FOCUS_ROTATION, selectBinanceFlowSlot } from '../src/binance-flow-monitor.js';
import { NOW, row } from './fixtures/binance-flow.js';
import { binanceFeedCoverage, validBinanceFlowState } from '../src/binance-flow-evidence.js';

test('public client sends only fixed read-only endpoint and no credentials or private auth', async () => {
  const calls = [], client = createBinanceFlowClient({ now: () => NOW, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json({ code: '000000', data: [row()] });
  } });
  try {
    await assert.rejects(client.trades('bad', 'kol'));
    await client.trades('robinhood', 'kol');
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/tracker/wallet/address/query');
    assert.deepEqual(JSON.parse(calls[0].options.body), { chainId: '4663', tagType: 1, enableFilterRiskTokens: false });
    assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.redirect, 'error');
    assert.equal(Object.keys(calls[0].options.headers).some(k => /cookie|authorization|key|session/i.test(k)), false);
  } finally { await client.stop(); }
});

test('rate-limit cooldown stops subsequent calls and preserves Retry-After', async () => {
  let calls = 0;
  const client = createBinanceFlowClient({ now: () => NOW, fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '300' } }); } });
  try { await assert.rejects(client.trades('robinhood', 'kol'), { code: 'binance_rate_limited', retryAt: NOW + 300000 });
    await assert.rejects(client.trades('bsc', 'smartmoney'), { code: 'binance_rate_limited' }); assert.equal(calls, 1);
  } finally { await client.stop(); }
});

test('malformed and oversized provider responses fail closed', async () => {
  for (const response of [Response.json({ code: 'bad', data: [] }), Response.json({ code: '000000', data: null }), new Response('x'.repeat(4 * 1024 * 1024 + 1))]) {
    const client = createBinanceFlowClient({ fetchImpl: async () => response });
    try { await assert.rejects(client.trades('robinhood', 'kol')); } finally { await client.stop(); }
  }
});

async function directory(t) { const p = await fs.mkdtemp(path.join(os.tmpdir(), 'binance-flow-test-')); t.after(() => fs.rm(p, { recursive: true, force: true })); return p; }
const fake = (extra = {}) => ({ trades: async (chain) => ({ code: '000000', data: chain === 'robinhood' ? [row()] : [] }), stop: async () => {}, ...extra });

test('single-flight monitor persists a readonly snapshot and gracefully releases writer lock', async t => {
  const dataDir = await directory(t); let calls = 0;
  const monitor = createBinanceFlowMonitor({ dataDir }, { now: () => NOW, autoStart: false, client: fake({ trades: async () => { calls++; return { code: '000000', data: [row()] }; } }) });
  try { await Promise.all([monitor.check(), monitor.check()]); assert.equal(calls, 2);
    const state = JSON.parse(await fs.readFile(monitor.stateFile, 'utf8')); assert.equal(state.mode, 'readonly');
    assert.equal(state.chains.robinhood.feeds.kol.rows.length, 1); assert.equal((await fs.stat(monitor.stateFile)).mode & 0o777, 0o600);
    const second = createBinanceFlowMonitor({ dataDir }, { autoStart: false, client: fake() });
    try { await assert.rejects(second.check()); } finally { await second.stop(); }
  } finally { await monitor.stop(); }
  await assert.rejects(fs.stat(`${monitor.stateFile}.lock`), { code: 'ENOENT' });
});

test('outages invalidate coverage, retain observed history and persist cross-restart cooldown', async t => {
  const dataDir = await directory(t); let clock = NOW, failing = false;
  const client = fake({ trades: async () => { if (failing) throw Object.assign(new Error('binance_rate_limited'), { code: 'binance_rate_limited', retryAt: clock + 300000 }); return { code: '000000', data: [row()] }; } });
  const monitor = createBinanceFlowMonitor({ dataDir }, { now: () => clock, autoStart: false, client, logger: {} });
  try {
    await monitor.check(); failing = true; clock += 30000; await monitor.check();
    assert.equal(monitor.state().cooldownUntil, clock + 300000);
  } finally { await monitor.stop(); }
  let calls = 0;
  const restored = createBinanceFlowMonitor({ dataDir }, { now: () => clock, autoStart: false, client: fake({ trades: async () => { calls++; return { code: '000000', data: [] }; } }) });
  try { await restored.check(); assert.equal(calls, 0); assert.equal(restored.state().chains.robinhood.feeds.kol.rows.length, 1);
    assert.equal(restored.state().chains.robinhood.feeds.kol.coverage, null);
  } finally { await restored.stop(); }
});

test('a transient failed poll stays unusable but a verified overlapping recovery preserves coverage', async t => {
  const dataDir = await directory(t); let clock = NOW - 420000, failing = false;
  const client = fake({ trades: async chain => {
    if (failing && chain === 'robinhood') throw Object.assign(new Error('binance_fetch_failed'), { code: 'binance_fetch_failed' });
    return { code: '000000', data: chain === 'robinhood' ? [row(1, { ts: NOW / 1000 - 450 })] : [] };
  } });
  const monitor = createBinanceFlowMonitor({ dataDir }, { now: () => clock, autoStart: false, client, logger: {} });
  const focus = async () => { await monitor.check(); await monitor.check(); };
  try {
    for (;clock <= NOW;clock += 30000) await focus();
    const before = monitor.state().chains.robinhood.feeds.kol;
    assert.equal(binanceFeedCoverage(before, NOW).complete, true);
    failing = true; await focus();
    const failed = monitor.state().chains.robinhood.feeds.kol;
    assert.equal(binanceFeedCoverage(failed, clock).complete, false);
    failing = false; clock += 60000; await focus();
    const recovered = monitor.state().chains.robinhood.feeds.kol;
    assert.equal(recovered.coverage.startAt, before.coverage.startAt);
    assert.equal(binanceFeedCoverage(recovered, clock).complete, true);
  } finally { await monitor.stop(); }
});

test('malformed existing state is not reset or overwritten', async t => {
  const dataDir = await directory(t), file = path.join(dataDir, 'binance-flow-state.json'); await fs.writeFile(file, '{bad');
  const monitor = createBinanceFlowMonitor({ dataDir }, { autoStart: false, client: fake() });
  try { await assert.rejects(monitor.check()); assert.equal(await fs.readFile(file, 'utf8'), '{bad'); } finally { await monitor.stop(); }
});

test('focus chain gets alternating slots without starving other chains', async t => {
  const dataDir = await directory(t), calls = [];
  const monitor = createBinanceFlowMonitor({ dataDir }, { now: () => NOW, autoStart: false,
    client: fake({ trades: async (chain, kind) => { calls.push([chain, kind]); return { code: '000000', data: [] }; } }) });
  try {
    for (let i = 0; i < 9; i++) await monitor.check();
    assert.deepEqual(calls.filter((_, i) => i % 2 === 0).map(([chain]) => chain), ['robinhood', 'sol', 'robinhood', 'bsc', 'robinhood', 'base', 'robinhood', 'eth', 'robinhood']);
    assert.equal(calls.length, 18);
  } finally { await monitor.stop(); }
});

test('weighted rotation gives BSC/SOL three slots each and retains all other chains across restart', async t => {
  const dataDir=await directory(t),calls=[];
  const create=()=>createBinanceFlowMonitor({dataDir,binanceFlowFocusSchedulingEnabled:true},{now:()=>NOW,autoStart:false,
    client:fake({trades:async(chain,kind)=>{calls.push([chain,kind]);return {code:'000000',data:[]};}})});
  let monitor=create();
  try {
    await monitor.check();assert.equal(monitor.state().focusChainIndex,1);
    await monitor.stop();monitor=create();
    for(let i=1;i<18;i++)await monitor.check();
    assert.deepEqual(calls.filter((_,i)=>i%2===0).map(([chain])=>chain),[...BINANCE_FOCUS_ROTATION,...BINANCE_FOCUS_ROTATION]);
    assert.equal(calls.length,36,'unchanged two requests per slot');
    assert.equal(monitor.state().focusChainIndex,0);
    assert.equal(monitor.state().scheduling.version,'bsc_sol_weighted_v1');
  }finally{await monitor.stop();}
});

test('weighted scheduler skips only fully cooling chains and is bounded when all cool down',()=>{
  const feeds=()=>Object.fromEntries(['kol','smartmoney'].map(k=>[k,{nextAttemptAt:NOW+60000}]));
  const state={focusChainIndex:0,chains:{bsc:{feeds:feeds()}}};
  assert.deepEqual(selectBinanceFlowSlot(state,NOW),{chain:'sol',nextIndex:2});
  state.chains.bsc.feeds.kol.nextAttemptAt=NOW;
  assert.deepEqual(selectBinanceFlowSlot(state,NOW),{chain:'bsc',nextIndex:1});
  state.chains=Object.fromEntries([...new Set(BINANCE_FOCUS_ROTATION)].map(chain=>[chain,{feeds:feeds()}]));
  assert.equal(selectBinanceFlowSlot(state,NOW),null);
});

test('weighted mode honors global cooldown before the next chain',async t=>{
  const dataDir=await directory(t);let calls=0;
  const monitor=createBinanceFlowMonitor({dataDir,binanceFlowFocusSchedulingEnabled:true},{now:()=>NOW,autoStart:false,logger:{},
    client:fake({trades:async()=>{calls++;throw Object.assign(new Error('limit'),{code:'binance_rate_limited',retryAt:NOW+60000});}})});
  try{await monitor.check();await monitor.check();assert.equal(calls,1);assert.equal(monitor.state().cooldownUntil,NOW+60000);}
  finally{await monitor.stop();}
});

test('actual dispatch after pacing anchors coverage and keeps index delay instead of using queue time',async t=>{
  const dataDir=await directory(t);let clock=NOW;
  const monitor=createBinanceFlowMonitor({dataDir,binanceFlowFocusSchedulingEnabled:true},{now:()=>clock,autoStart:false,
    client:fake({trades:async(_chain,_kind,{onRequestStart})=>{
      clock+=5000;onRequestStart(clock);clock+=200;return {code:'000000',data:[]};
    }})});
  try{
    await monitor.check();const feed=monitor.state().chains.bsc.feeds.smartmoney;
    assert.equal(feed.coverage.startAt,NOW+5000);assert.equal(feed.coverage.endAt,NOW-5000);
    assert.deepEqual(feed.timing,{requestedAt:NOW,dispatchedAt:NOW+5000,receivedAt:NOW+5200,queueWaitMs:5000,responseMs:200});
    assert.equal(binanceFeedCoverage(feed,clock).complete,false);
    const snapshot=monitor.state();delete snapshot.focusChainIndex;assert.equal(validBinanceFlowState(snapshot),true);
    for(const invalid of [-1,9,.5,'1',null])assert.equal(validBinanceFlowState({...snapshot,focusChainIndex:invalid}),false);
  }finally{await monitor.stop();}
});

test('public client invokes dispatch hook at the fetch boundary, never for invalid or cooled requests',async()=>{
  let clock=NOW;const sequence=[];
  const client=createBinanceFlowClient({now:()=>clock,fetchImpl:async()=>{
    sequence.push(['fetch',clock]);return new Response('',{status:429});
  }});
  const onRequestStart=at=>sequence.push(['dispatch',at]);
  try{
    await assert.rejects(client.trades('bsc','kol',{onRequestStart:'bad'}),{code:'binance_invalid_argument'});
    await assert.rejects(client.trades('bsc','kol',{onRequestStart}),{code:'binance_rate_limited'});
    clock+=100;await assert.rejects(client.trades('sol','kol',{onRequestStart}),{code:'binance_rate_limited'});
    assert.deepEqual(sequence,[['dispatch',NOW],['fetch',NOW]]);
  }finally{await client.stop();}
});
