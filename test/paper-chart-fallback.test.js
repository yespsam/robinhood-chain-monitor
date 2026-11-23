import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPaperStrategyRuntime} from '../src/paper-strategy-runtime.js';
import {createChartFallback} from '../src/paper-chart-fallback.js';
const END=Date.parse('2026-10-10T10:00:00Z'),CA='0x'+'a'.repeat(40),POOL='0x'+'c'.repeat(40),QUOTE='0x'+'b'.repeat(40);
const iso=t=>new Date(t).toISOString(),token={chain:'bsc',address:CA,researchLane:'hot'};
const missing={status:'unavailable',candles:[]};
function response(at=END+10000,t=token){const end=Math.floor(at/60000)*60000;return {status:'ok',source:'geckoterminal',chain:t.chain,address:t.address,tokenAddress:t.address,
  network:'bsc',poolId:POOL,dexId:'pancakeswap-v2',tokenSide:'base',currency:'usd',resolution:'1m',from:end/1000-3600,to:end/1000,
  requestWindow:'latest_closed_at_dispatch',requestedAt:iso(at-1000),receivedAt:iso(at),emptyIntervals:false,inferredBars:0,
  binding:{network:'bsc',poolId:POOL,baseToken:{address:t.address,decimals:18},quoteToken:{address:QUOTE,decimals:18},metadataRequestedAt:iso(at-3000),metadataReceivedAt:iso(at-2000)},
  ohlcvMeta:{base:{address:t.address},quote:{address:QUOTE}},
  candles:Array.from({length:30},(_,i)=>({time:end-(30-i)*60000,open:1,high:1.1,low:.9,close:1,volume:100}))};}
const primary=()=>({status:'ok',candles:response().candles});

test('fallback returns the primary immediately, has one flight and never uses a GMGN client',async()=>{
  let resolve,calls=0;const results=[];
  const f=createChartFallback({secondaryMarket:{kline:args=>{calls++;assert.equal(args.waitForSlot,false);return new Promise(r=>resolve=r);}},now:()=>END+10000,isAdmitted:()=>true,getPrimary:()=>missing,onReady:(t,c)=>results.push(c)});
  assert.equal(f.observe(token,missing),missing);assert.equal(calls,0);
  await Promise.resolve();assert.equal(calls,1);
  assert.equal(f.observe({...token,address:'0x'+'d'.repeat(40)},missing),missing);assert.equal(calls,1);
  resolve(response());await f.drain();assert.equal(results.length,1);assert.equal(f.select(token,missing).source,'geckoterminal');
  assert.equal(f.snapshot().accepted,1);assert.equal(f.select(token,primary()).source,undefined,'valid primary always wins');await f.close();
});

test('retry is per CA at least sixty seconds and only hot/catchup can trigger it',async()=>{
  let at=END+10000,calls=0;
  const f=createChartFallback({secondaryMarket:{kline:async()=>{calls++;return {status:'unavailable',reasonCode:'GT_PACING'};}},now:()=>at,isAdmitted:()=>true});
  for(const researchLane of ['discovery','holding','entry','wallet'])f.observe({...token,researchLane},missing);
  await f.drain();assert.equal(calls,0);
  f.observe(token,missing);await f.drain();at+=59999;f.observe(token,missing);await f.drain();assert.equal(calls,1);
  at++;f.observe({...token,researchLane:'catchup'},missing);await f.drain();assert.equal(calls,2);await f.close();
});

test('late backup is discarded after current admission is lost or a good primary arrives',async()=>{
  for(const reason of ['admission','primary']) {
    let resolve,admitted=true,current=missing,accepted=0;
    const f=createChartFallback({secondaryMarket:{kline:()=>new Promise(r=>resolve=r)},now:()=>END+10000,isAdmitted:()=>admitted,getPrimary:()=>current,onReady:()=>accepted++});
    f.observe(token,missing);await Promise.resolve();if(reason==='admission')admitted=false;else current=primary();
    resolve(response());await f.drain();assert.equal(accepted,0);assert.equal(f.snapshot().cacheCount,0);assert.equal(f.snapshot().last.status,'discarded');await f.close();
  }
});

test('source mismatches, incomplete windows and stale originals never become fresh fallback data',async()=>{
  for(const change of [r=>{r.address='0x'+'d'.repeat(40);},r=>{r.source='unknown';},r=>{r.candles=r.candles.slice(-13);},r=>{r.to-=3600;r.from-=3600;}]) {
    let accepted=0;const raw=response();change(raw);
    const f=createChartFallback({secondaryMarket:{kline:async()=>raw},now:()=>END+10000,isAdmitted:()=>true,onReady:()=>accepted++});
    f.observe(token,missing);await f.drain();assert.equal(accepted,0);assert.equal(f.select(token,missing),missing);await f.close();
  }
  let at=END+10000;const f=createChartFallback({secondaryMarket:{kline:async()=>response(at)},now:()=>at,isAdmitted:()=>true});
  f.observe(token,missing);await f.drain();const cached=f.select(token,missing);assert.equal(cached.fetchedAt,at);at=END+90001;
  assert.equal(f.select(token,missing),missing);assert.equal(cached.fetchedAt,END+10000);await f.close();
});

test('bounded cache and shutdown abort/drain do not publish a late source',async()=>{
  let at=END+10000;const f=createChartFallback({secondaryMarket:{kline:async args=>response(at,args)},now:()=>at,isAdmitted:()=>true,cacheLimit:2});
  for(const char of ['d','e','f']){f.observe({...token,address:'0x'+char.repeat(40)},missing);await f.drain();at+=60000;}
  assert.equal(f.snapshot().cacheCount,2);await f.close();
  let resolve,accepted=0,closed=0;const stopping=createChartFallback({secondaryMarket:{kline:()=>new Promise(r=>resolve=r),close:async()=>{closed++;resolve(response());}},now:()=>END+10000,isAdmitted:()=>true,onReady:()=>accepted++});
  stopping.observe(token,missing);await Promise.resolve();await stopping.close();assert.equal(closed,1);assert.equal(accepted,0);assert.equal(stopping.snapshot().pending,false);
});

test('actual runtime does not wait for secondary IO and preserves whole-source proof through evaluation and wallet context',{timeout:4000},async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'chart-fallback-runtime-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let at=END+10000,resolve,secondaryCalls=0,primaryReady=false;
  const candidate={...token,symbol:'OFFLINE_ONLY',price:1,marketStage:'external',liquidity:60000,volume:5000,
    isHoneypot:false,isWashTrading:false,rugRatio:.01,top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,buyTax:0,sellTax:0};
  const market={trending:async()=>({status:'ok',observedAt:iso(at),tokens:[candidate]}),
    kline:async args=>({...args,source:'gmgn-cli',status:primaryReady?'ok':'unavailable',candles:primaryReady?response(at).candles:[]}),
    quote:async args=>({...args,status:'ok',price:1,observedAt:iso(at)})};
  const secondaryMarket={kline:async()=>{secondaryCalls++;return new Promise(r=>resolve=r);},close:async()=>resolve?.({status:'unavailable'})};
  const runtime=createPaperStrategyRuntime({dataDir,chain:'bsc',market,secondaryMarket,now:()=>at,evidenceLoader:()=>({}),
    allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,opportunityMode:true,memeExitMode:true,recoveryMode:true});
  try{
    await runtime.runOnce();assert.equal(secondaryCalls,1);assert.equal(runtime.snapshot().researchPipeline.chartFallback.pending,true);
    assert.equal(runtime.walletResearchContext().charts.length,0,'main cycle completed without waiting on the held secondary request');
    resolve(response(at));await new Promise(setImmediate);await runtime.fastOnce();
    const ctx=runtime.walletResearchContext().charts[0];assert.equal(ctx.source,'geckoterminal');assert.equal(ctx.candles.length,30);
    assert.equal(ctx.chartProvenance.source,'geckoterminal');
    assert.equal(runtime.snapshot().researchPipeline.chartFallback.accepted,1);
    assert.equal(runtime.snapshot().evaluations[0].evidence.recoveryEntry.chartProvenance.source,'geckoterminal');
    const catchup=runtime.queueChartCatchup([{chain:'bsc',address:CA}]);
    assert.equal(catchup.items[0].source,'geckoterminal');assert.equal(catchup.items[0].sourceDigest,ctx.chartProvenance.sourceDigest);
    primaryReady=true;at+=61000;await runtime.runOnce();await runtime.fastOnce();
    assert.equal(runtime.walletResearchContext().charts[0].source,'gmgn-cli','fresh complete primary replaces the backup whole series');
    assert.equal(secondaryCalls,1,'good primary suppresses extra secondary requests');
  }finally{await runtime.stop();}
});
