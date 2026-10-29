import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGmgnCharts,createChartSources,normalizeGmgnCandles,GmgnConfigStore} from '../server/gmgn-chart.mjs';
import {scanLane} from '../extension/scan-ui.js';
const ca='0x'+'2'.repeat(40),key='test-only-gmgn-key-00000',params={tokenAddress:ca,interval:60};
const mem=(apiKey=key)=>({value:{apiKey,cooldownUntil:0},async read(){return this.value;},async save(v){this.value={...v};}});
const candle=(time,close='2')=>({time,open:'1',high:'3',low:'0.5',close,volume:'24',amount:'12'});
test('live-style microprice bars show token count and USD turnover in their correct units',()=>{
 const row={time:1800000000,open:'0.00000319',high:'0.00000320',low:'0.00000318',close:'0.00000319',volume:'4.155021',amount:'1303582'};
 const [c]=normalizeGmgnCandles({code:0,data:{list:[row]}},{ca,interval:60,from:1799999940,to:1800000060});
 assert.equal(c.volume,1303582);assert.equal(c.quoteVolume,4.155021);assert(c.quoteVolume/c.volume>=Number(row.low)&&c.quoteVolume/c.volume<=Number(row.high));
});
const response=list=>new Response(JSON.stringify({code:0,data:{list}}),{status:200,headers:{'content-type':'application/json'}});
test('GMGN uses the documented BSC readonly route, milliseconds in query, USD/base volume semantics and cache',async()=>{
 let calls=0,now=1800000000000;const gmgn=createGmgnCharts({store:mem(),clock:()=>now,fetchImpl:async(url,opts)=>{calls++;assert.equal(url.origin,'https://openapi.gmgn.ai');assert.equal(url.pathname,'/v1/market/token_kline');assert.equal(url.searchParams.get('chain'),'bsc');assert.equal(url.searchParams.get('address'),ca);assert.equal(url.searchParams.get('resolution'),'1m');assert.equal(Number(url.searchParams.get('to')),now);assert.equal(Number(url.searchParams.get('timestamp')),now/1000);assert.equal(opts.method,'GET');assert.equal(opts.headers['X-APIKEY'],key);assert.equal(opts.redirect,'error');assert.equal(opts.headers['X-Signature'],undefined);return response([candle(now/1000-60)]);}});
 const {chart}=await gmgn.query(params);assert.equal(chart.source,'gmgn');assert.equal(chart.quoteSymbol,'USD');assert.equal(chart.candles[0].volume,12);assert.equal(chart.candles[0].quoteVolume,24);assert.equal(chart.candles[0].trades,null);await gmgn.query(params);assert.equal(calls,1);assert(!JSON.stringify(await gmgn.status()).includes(key));
});
test('GMGN rejects missing configuration and invalid settings before external requests',async()=>{
 const store=mem('');let called=0;const gmgn=createGmgnCharts({store,fetchImpl:async()=>{called++;throw Error('unexpected');}});
 await assert.rejects(gmgn.query(params),{code:'GMGN_NOT_CONFIGURED'});await assert.rejects(gmgn.configure({apiKey:key,url:'https://evil.invalid'}),{code:'GMGN_INVALID_KEY'});await assert.rejects(gmgn.configure({apiKey:'x\nheader'}),{code:'GMGN_INVALID_KEY'});
 await gmgn.configure({apiKey:key});assert.equal((await gmgn.status()).gmgn.configured,true);await gmgn.configure({apiKey:''});assert.equal((await gmgn.status()).gmgn.configured,false);assert.equal(called,0);
});
test('GMGN validates identity, OHLC, ranges, duplicate timestamps and units',()=>{
 const q={ca,interval:60,from:1800000000-120,to:1800000000};const parse=list=>normalizeGmgnCandles({code:0,data:{chain:'bsc',address:ca,list}},q);
 assert.equal(parse([candle(1800000000000)])[0].time,1800000000);assert.throws(()=>parse([{...candle(1800000000),low:'4'}]),{code:'GMGN_INVALID_RESPONSE'});
 for(const bad of [{address:'0x'+'3'.repeat(40)},{chain:'eth'},{volume:null},{amount:undefined},{time:1800000001},{time:1700000000},{open:'NaN'}])assert.throws(()=>parse([{...candle(1800000000),...bad}]),{code:'GMGN_INVALID_RESPONSE'});
 assert.throws(()=>parse([candle(1800000000),candle(1800000000,'1.5')]),{code:'GMGN_INVALID_RESPONSE'});
});
test('GMGN fetches older history without duplicating bars or moving latest time backwards',async()=>{
 let now=1800000000000;const gmgn=createGmgnCharts({store:mem(),clock:()=>now,fetchImpl:async(url)=>{const end=Math.floor(Number(url.searchParams.get('to'))/1000/60)*60;return response([candle(end-60),candle(end)]);}});
 const first=(await gmgn.query(params)).chart;now+=12000;const older=(await gmgn.query({...params,older:true})).chart;assert(older.fromTime<first.fromTime);assert.equal(older.toTime,first.toTime);assert.equal(older.candles.length,4);assert.equal(new Set(older.candles.map(c=>c.time)).size,4);
 now+=60000;const latest=(await gmgn.query(params)).chart;assert.equal(latest.fromTime,older.fromTime);assert(latest.toTime>older.toTime);
});
test('GMGN 429 cooldown persists across clients and never retries before reset',async()=>{
 const now=1800000000000,store=mem();let calls=0;const fetchImpl=async()=>{calls++;return new Response(JSON.stringify({code:429,error:'RATE_LIMIT_BANNED'}),{status:429,headers:{'x-ratelimit-reset':String(now/1000+120)}});};
 const a=createGmgnCharts({store,clock:()=>now,fetchImpl});await assert.rejects(a.query(params),{code:'GMGN_RATE_LIMITED'});assert(store.value.cooldownUntil>now+120000);
 const b=createGmgnCharts({store,clock:()=>now+1000,fetchImpl});await assert.rejects(b.query(params),{code:'GMGN_RATE_LIMITED'});await b.configure({apiKey:key});await assert.rejects(b.query(params),{code:'GMGN_RATE_LIMITED'});assert.equal(calls,1);
});
test('GMGN failures expose only error codes, and credentials changes discard inflight results',async()=>{
 let release;const gmgn=createGmgnCharts({store:mem(),fetchImpl:()=>new Promise(r=>{release=r;})});const pending=gmgn.query(params);while(!release)await new Promise(r=>setImmediate(r));await gmgn.configure({apiKey:''});release(response([]));await assert.rejects(pending,{code:'GMGN_CONFIG_CHANGED'});
 const fail=createGmgnCharts({store:mem(),fetchImpl:async()=>{throw Error('PRIVATE-CONTENT '+key);}});await assert.rejects(fail.query(params),e=>e.message==='GMGN_UNAVAILABLE'&&!JSON.stringify(e).includes(key));
});
test('GMGN authentication errors stop repeated calls until settings are updated',async()=>{
 let calls=0,now=1800000000000;const gmgn=createGmgnCharts({store:mem(),clock:()=>now,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({code:401,error:'INVALID_API_KEY',message:key}),{status:401});}});
 await assert.rejects(gmgn.query(params),{code:'GMGN_INVALID_KEY'});now+=60000;await assert.rejects(gmgn.query({...params,interval:300}),{code:'GMGN_INVALID_KEY'});assert.equal(calls,1);assert(!JSON.stringify(await gmgn.status()).includes(key));
});
test('source selection never mixes GMGN USD series with native-asset fallback',async()=>{
 const onchain={async query(){return {chart:{source:'onchain',quoteSymbol:'BNB',candles:[{close:3}]}};}},gmgn={async query(){throw Object.assign(Error(),{code:'GMGN_NO_DATA'});}},sources=createChartSources({gmgn,onchain});
 const fallback=(await sources.query(params)).chart;assert.equal(fallback.quoteSymbol,'BNB');assert.equal(fallback.fallbackReason,'GMGN_NO_DATA');assert.equal(fallback.candles.length,1);await assert.rejects(sources.query({...params,source:'gmgn'}),{code:'GMGN_NO_DATA'});await assert.rejects(sources.query({...params,source:'other'}),{code:'INVALID_REQUEST'});await assert.rejects(sources.query({...params,url:'https://evil.invalid'}),{code:'INVALID_REQUEST'});
});
test('private GMGN settings survive restart and clear without returning credentials',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'yesp-gmgn-'));try{const store=new GmgnConfigStore(join(directory,'private'));await store.save({apiKey:key,cooldownUntil:0});assert.deepEqual(await store.read(),{apiKey:key,cooldownUntil:0});const gmgn=createGmgnCharts({store});assert.deepEqual((await gmgn.status()).gmgn,{configured:true,cooldownUntil:0,lastError:null});await gmgn.configure({apiKey:''});assert(!String(await readFile(join(directory,'private/settings.json'))).includes(key));}finally{await rm(directory,{recursive:true,force:true});}
});
test('trench lanes distinguish graduation from sale progress and unknown state',()=>{
 assert.equal(scanLane({phase:1,progressBps:'1000'}),'new');assert.equal(scanLane({info:{phase:1,progressBps:'9000'}}),'near');assert.equal(scanLane({phase:2}),'near');assert.equal(scanLane({phase:3,progressBps:'0'}),'launched');assert.equal(scanLane({progressBps:null}),'new');assert.equal(scanLane({progressBps:'10000'}),'near');assert.equal(scanLane({info:{phase:4,progressBps:'10000'}}),'new');
});
