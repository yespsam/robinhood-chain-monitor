import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createGeckoTerminalMarketClient,bindGeckoPoolResponse,normalizeGeckoOhlcv} from '../src/geckoterminal-market.js';

const NOW=Date.parse('2026-11-10T04:00:00Z'),address='0x'+'1'.repeat(40),counter='0x'+'0'.repeat(40),poolId='0x'+'a'.repeat(64);
const stamp=at=>new Date(at).toISOString();
const token=(a=address)=>({id:`bsc_${a}`,type:'token',attributes:{address:a,decimals:18}});
const pool={id:`bsc_${poolId}`,type:'pool',attributes:{address:poolId,pool_created_at:'2026-11-01T00:00:00Z'},relationships:{
  base_token:{data:{id:`bsc_${address}`,type:'token'}},quote_token:{data:{id:`bsc_${counter}`,type:'token'}},dex:{data:{id:'uniswap-v4-bsc',type:'dex'}}}};
const metadata=()=>({data:[structuredClone(pool)],included:[token()]});
const raw=(end=NOW/1000)=>({data:{type:'ohlcv_request_response',attributes:{ohlcv_list:Array.from({length:30},(_,i)=>[end-(i+1)*60,1,1.1,.9,1,20])}},
  meta:{base:{address},quote:{address:counter}}});
const response=(body,status=200,headers={})=>({ok:status===200,status,headers:new Headers(headers),text:async()=>JSON.stringify(body)});
const instantGate=()=>async(work,signal)=>{if(signal.aborted)throw Object.assign(new Error(),{code:'GMGN_STOPPED'});return work();};
async function options(t,extra={}){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'gt-market-test-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));return {dataDir,gateFactory:instantGate,now:()=>NOW,...extra};}
const window={from:NOW/1000-3600,to:NOW/1000,requestedAt:stamp(NOW),receivedAt:stamp(NOW),queuedAt:stamp(NOW),requestWindow:'fixed_historical'};
const bound=()=>bindGeckoPoolResponse(metadata(),{chain:'bsc',address,requestedAt:stamp(NOW-1000),receivedAt:stamp(NOW-500)});

test('exact network and CA bind opaque V4 pools; non-target decimals may be null',()=>{
  const p=bound();assert.equal(p.poolId,poolId);assert.equal(p.binding.baseToken.decimals,18);assert.equal(p.binding.quoteToken.decimals,null);
  assert.throws(()=>bindGeckoPoolResponse(metadata(),{chain:'robinhood',address}),/GT_POOL_IDENTITY_MISMATCH/);
  const missing=metadata();missing.included=[];assert.throws(()=>bindGeckoPoolResponse(missing,{chain:'bsc',address}),/GT_TOKEN_METADATA_MISMATCH/);
  const bad=metadata();bad.included[0].attributes.address='0x'+'2'.repeat(40);
  assert.throws(()=>bindGeckoPoolResponse(bad,{chain:'bsc',address}),/GT_TOKEN_METADATA_MISMATCH/);
});

test('sparse USD OHLCV preserves real bars and original source boundary after delayed reception',()=>{
  const r=raw();r.data.attributes.ohlcv_list.push([NOW/1000,1,1.1,.9,1,20]);
  const chart=normalizeGeckoOhlcv(r,bound(),{...window,receivedAt:stamp(NOW+61000)});
  assert.equal(chart.candles.length,30);assert.equal(chart.rawResponse.data.attributes.ohlcv_list.length,31);
  assert.equal(chart.quality.excludedBars,1);assert.equal(chart.emptyIntervals,false);assert.equal(chart.inferredBars,0);
  assert.equal(chart.candles[0].source,'geckoterminal');assert.equal(chart.currency,'usd');
  const mismatch=raw();mismatch.meta.quote.address=address;
  assert.throws(()=>normalizeGeckoOhlcv(mismatch,bound(),window),/GT_OHLCV_IDENTITY_MISMATCH/);
  const duplicate=raw();duplicate.data.attributes.ohlcv_list.push(duplicate.data.attributes.ohlcv_list[0]);
  assert.throws(()=>normalizeGeckoOhlcv(duplicate,bound(),window),/GT_INVALID_OHLCV/);
  const future=raw();future.data.attributes.ohlcv_list.push([NOW/1000+60,1,1.1,.9,1,1]);
  assert.throws(()=>normalizeGeckoOhlcv(future,bound(),window),/GT_FUTURE_BAR/);
  const zero=raw();zero.data.attributes.ohlcv_list.push([window.from-60,1,1,1,1,0]);
  assert.throws(()=>normalizeGeckoOhlcv(zero,bound(),window),/GT_ZERO_VOLUME_BAR/);
  assert.throws(()=>normalizeGeckoOhlcv({...raw(),synthetic:true},bound(),window),/GT_SYNTHETIC_OR_MIXED_SOURCE/);
});

test('latest window binds at OHLCV dispatch; metadata does not change clock or token direction',async t=>{
  let clock=NOW,calls=0;const seen=[];
  const client=createGeckoTerminalMarketClient(await options(t,{now:()=>clock,gateFactory:()=>async work=>{if(calls)clock+=85000;return work();},
    fetchImpl:async url=>{seen.push(url);calls++;return response(calls===1?metadata():raw(Math.floor(clock/60000)*60));}}));
  const r=await client.kline({chain:'bsc',address,latestClosed:true});await client.close();
  assert.equal(r.status,'ok');assert.equal(r.to,Math.floor(clock/60000)*60);assert.equal(r.to-r.from,3600);
  assert.equal(seen[1].searchParams.get('token'),address);assert.equal(seen[1].searchParams.get('include_empty_intervals'),'false');
  assert.equal(seen[1].searchParams.get('currency'),'usd');assert.equal(r.binding.metadataReceivedAt,stamp(NOW));
});

test('429 persists provider cooldown across clients and never retries automatically',async t=>{
  const config=await options(t);let calls=0;
  const first=createGeckoTerminalMarketClient({...config,fetchImpl:async()=>{calls++;return response({},429,{'retry-after':'180'});}});
  const r=await first.resolvePool({chain:'bsc',address});await first.close();
  assert.equal(r.reasonCode,'GT_RATE_LIMITED');assert.equal(r.retryAt,stamp(NOW+180000));assert.equal(calls,1);
  const second=createGeckoTerminalMarketClient({...config,fetchImpl:()=>assert.fail('cooldown must not dispatch')});
  const next=await second.resolvePool({chain:'bsc',address});assert.equal(next.reasonCode,'GT_COOLDOWN');await second.close();
});

test('non-waiting mode returns pacing after metadata instead of waiting for next provider slot',async t=>{
  let calls=0;const client=createGeckoTerminalMarketClient(await options(t,{fetchImpl:async()=>{calls++;return response(metadata());}}));
  const r=await client.kline({chain:'bsc',address,latestClosed:true,waitForSlot:false});
  assert.equal(calls,1);assert.equal(r.reasonCode,'GT_PACING');assert.equal(r.retryAt,stamp(NOW+30000));await client.close();
});

test('batch metadata binds requested CA independently and avoids one pool request per token',async t=>{
  const dataToken={...token(),relationships:{top_pools:{data:[{id:pool.id,type:'pool'}]}}};let calls=0;
  const client=createGeckoTerminalMarketClient(await options(t,{metadataTtlMs:3600000,fetchImpl:async url=>{
    calls++;return response(url.pathname.includes('/tokens/multi/')?{data:[dataToken],included:[pool]}:raw());}}));
  const meta=await client.prefetchPools({targets:[{chain:'bsc',address}]});assert.equal(meta.results[0].status,'ok');
  const r=await client.kline({chain:'bsc',address,from:window.from,to:window.to});await client.close();
  assert.equal(r.status,'ok');assert.equal(calls,2);assert.equal(r.binding.quoteToken.decimals,null);
});

test('client close aborts the one active fetch and drains before resolving',async t=>{
  let entered,hold;const started=new Promise(resolve=>entered=resolve);
  const client=createGeckoTerminalMarketClient(await options(t,{fetchImpl:async(_url,{signal})=>{
    entered();return new Promise((resolve,reject)=>{hold=setTimeout(resolve,1000);signal.addEventListener('abort',()=>{clearTimeout(hold);reject(signal.reason);},{once:true});});}}));
  const work=client.resolvePool({chain:'bsc',address});await started;await client.close();
  assert.equal((await work).reasonCode,'GT_STOPPED');assert.equal(client.diagnostics().pending,0);
});

test('production gate gets its own directory and cannot be configured faster than 30 seconds',async t=>{
  const config=await options(t);const seen=[];
  const client=createGeckoTerminalMarketClient({...config,gateFactory:(dir,opts)=>{seen.push({dir,opts});return instantGate();}});
  assert.equal(seen[0].dir,path.join(config.dataDir,'geckoterminal-readonly'));assert.equal(seen[0].opts.intervalMs,30000);
  assert.throws(()=>createGeckoTerminalMarketClient({...config,minIntervalMs:1000}),/GT_INVALID_OPTIONS/);await client.close();
});

test('availability lets the shared gate recover an expired lease even when its PID is alive',async t=>{
  const config=await options(t),dir=path.join(config.dataDir,'geckoterminal-readonly');
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'gmgn-account-slot.json'),JSON.stringify({version:1,startedAt:NOW-61000,
    active:[{pid:process.pid,admittedAt:NOW-61000}]}));
  const client=createGeckoTerminalMarketClient(config);
  assert.equal((await client.availability()).available,true);await client.close();
});
