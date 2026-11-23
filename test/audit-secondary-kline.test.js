import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {auditSecondaryKline} from '../scripts/audit-secondary-kline.js';
const NOW=Date.parse('2026-11-10T04:00:00Z'),to=NOW/1000-3600;
const target=n=>({chain:'bsc',address:'0x'+String(n).repeat(40),historicalFrom:to-3600,historicalTo:to,
 historicalWindowProvenance:'exact_raw_gmgn_request_window',latestSuccessfulObservation:{diagnostic:'insufficient_contiguous_tail',ready:false,closedBars:20}});
const bars=Array.from({length:30},(_,i)=>({time:new Date((to-(30-i)*60)*1000).toISOString(),open:1,high:1.1,low:.9,close:1,volume:10}));
const chart=args=>({...args,status:'ok',source:'geckoterminal',tokenAddress:args.address,network:'bsc',poolId:'0x'+'a'.repeat(64),dexId:'uniswap-v4-bsc',
 tokenSide:'base',currency:'usd',resolution:'1m',requestedAt:new Date(NOW).toISOString(),receivedAt:new Date(NOW).toISOString(),
 requestWindow:'fixed_historical',emptyIntervals:false,inferredBars:0,
 binding:{network:'bsc',poolId:'0x'+'a'.repeat(64),baseToken:{address:args.address,decimals:18},quoteToken:{address:'0x'+'0'.repeat(40),decimals:null},
 metadataRequestedAt:new Date(NOW-1000).toISOString(),metadataReceivedAt:new Date(NOW-500).toISOString()},
 ohlcvMeta:{base:{address:args.address},quote:{address:'0x'+'0'.repeat(40)}},candles:bars,rawResponse:{preserved:true}});
async function fixture(t,targets=[target(1),target(2)]){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'secondary-audit-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const inputPath=path.join(dir,'input.json'),outputPath=path.join(dir,'output.json');await fs.writeFile(inputPath,JSON.stringify({candidates:targets}));return {inputPath,outputPath,now:()=>NOW,onProgress:()=>{}};}
test('secondary audit freezes targets and windows, one locked pool per CA, historical comparison only',async t=>{
 const config=await fixture(t);let calls=0,closed=0,active=0,max=0;
 const result=await auditSecondaryKline({...config,createClient:()=>({prefetchPools:async({targets})=>({status:'ok',results:targets.map(x=>({...x,status:'ok',poolId:'pool'})),rawResponses:[]}),
  kline:async args=>{calls++;active++;max=Math.max(max,active);assert.equal(args.frozenPoolId,'pool');assert.equal(args.latestClosed,false);
   await fs.writeFile(config.inputPath,JSON.stringify({candidates:[target(3)]}));active--;return chart(args);},close:async()=>{closed++;}})});
 assert.equal(calls,2);assert.equal(closed,1);assert.equal(max,1);assert.equal(result.summary.historicalChartReady,2);
 assert.equal(result.results[0].validation.asOfHistoricalWindowTo,new Date(to*1000).toISOString());
 assert.equal(result.results[0].qualityComparison.readinessChanged,true);assert.equal(result.results[0].rawResponse.rawResponse.preserved,true);
 await assert.rejects(auditSecondaryKline({...config,createClient:()=>assert.fail('must not create')}),{code:'EEXIST'});
});
test('HTTP-success-shaped data without pool provenance cannot become historical ready',async t=>{
 const config=await fixture(t,[target(1)]);
 const r=await auditSecondaryKline({...config,createClient:()=>({prefetchPools:async({targets})=>({status:'ok',results:targets.map(x=>({...x,status:'ok',poolId:'pool'}))}),
 kline:async args=>({...args,status:'ok',source:'geckoterminal',candles:bars}),close:async()=>{}})});
 assert.equal(r.summary.sourceResponsesOk,1);assert.equal(r.summary.trustedSourceValid,0);assert.equal(r.summary.historicalChartReady,0);
 assert.equal(r.results[0].sourceValidation.valid,false);
});
test('secondary audit stops on429 without retry or advancing to another CA',async t=>{
 const config=await fixture(t);let calls=0;
 const r=await auditSecondaryKline({...config,createClient:()=>({prefetchPools:async({targets})=>({status:'ok',results:targets.map(x=>({...x,status:'ok',poolId:'pool'}))}),
 kline:async args=>{calls++;return {...args,status:'unavailable',reasonCode:'GT_RATE_LIMITED',retryAt:new Date(NOW+120000).toISOString(),candles:[]};},close:async()=>{}})});
 assert.equal(calls,1);assert.equal(r.status,'stopped');assert.equal(r.stopReason,'GT_RATE_LIMITED');assert.equal(r.summary.unrecorded,1);
});
test('missing explicit historical window fails before output/client creation',async t=>{
 const config=await fixture(t,[{...target(1),historicalTo:null}]);
 await assert.rejects(auditSecondaryKline({...config,createClient:()=>assert.fail('must not create')}),/historical window/);
 await assert.rejects(fs.stat(config.outputPath),{code:'ENOENT'});
});
