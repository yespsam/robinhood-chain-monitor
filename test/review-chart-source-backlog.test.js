import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {analyzeCandleWindow,compareChartWindows,reviewChartSourceBacklog} from '../scripts/review-chart-source-backlog.js';

const END=Date.parse('2026-11-10T01:00:00Z'),NOW=END+3600000,from=END/1000-3600,to=END/1000;
const CA='0x'+'a'.repeat(40),QUOTE='0x'+'b'.repeat(40),POOL='0x'+'c'.repeat(64),iso=at=>new Date(at).toISOString();
const bars=()=>Array.from({length:60},(_,i)=>({time:END-(60-i)*60000,open:1,high:1.1,low:.9,close:1,volume:10}));
function backup() {return {status:'ok',source:'geckoterminal',chain:'bsc',address:CA,tokenAddress:CA,network:'bsc',poolId:POOL,
  dexId:'uniswap-v4-bsc',tokenSide:'base',currency:'usd',resolution:'1m',from,to,requestWindow:'fixed_historical',
  requestedAt:iso(NOW-2000),receivedAt:iso(NOW-1000),emptyIntervals:false,inferredBars:0,
  binding:{network:'bsc',poolId:POOL,baseToken:{address:CA,decimals:18},quoteToken:{address:QUOTE,decimals:null},
    metadataRequestedAt:iso(NOW-5000),metadataReceivedAt:iso(NOW-3000)},
  ohlcvMeta:{base:{address:CA},quote:{address:QUOTE}},candles:bars()};}
async function fixture(t,{raw=true,secondaryMutation=()=>{},currentReady=true}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'source-compare-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const artifact=path.join(dir,'original.json'),target={chain:'bsc',address:CA,symbol:'OFFLINE',historicalFrom:from,historicalTo:to,
    historicalWindowProvenance:raw?'exact_raw_gmgn_request_window':'runtime_bound_closed_window',
    latestSuccessfulObservation:{artifact,at:iso(END+10000),diagnostic:'insufficient_contiguous_tail',closedBars:59}};
  const old=bars();old.splice(45,1);
  await fs.writeFile(artifact,JSON.stringify(raw?{results:[{chain:'bsc',address:CA,sourceStatus:'ok',receivedAt:iso(END+10000),
    rawResponse:{status:'ok',source:'gmgn-cli',chain:'bsc',address:CA,from,to,candles:old}}]}:{items:[{chain:'bsc',address:CA,closedBars:59}]}));
  const source=backup();secondaryMutation(source);
  const paths={targetsPath:path.join(dir,'targets.json'),secondaryPath:path.join(dir,'secondary.json'),currentPath:path.join(dir,'current.json')};
  await fs.writeFile(paths.targetsPath,JSON.stringify({candidates:[target]}));
  await fs.writeFile(paths.secondaryPath,JSON.stringify({results:[{chain:'bsc',address:CA,from,to,sourceStatus:'ok',rawResponse:source}]}));
  await fs.writeFile(paths.currentPath,JSON.stringify({id:'current',status:'complete',items:[{chain:'bsc',address:CA,status:'fetched',attempts:1,
    chartStatus:'ok',ready:currentReady,chartDiagnostic:currentReady?'ready':'stale_closed_bars',closedBars:60,closedThroughAt:iso(NOW)}]}));
  return {...paths,now:()=>NOW};
}

test('exact historical comparison reports the missing minute without merging either series',async t=>{
  const options=await fixture(t),r=await reviewChartSourceBacklog(options),row=r.candidates[0];
  assert.equal(row.historicalComparison.comparable,true);
  assert.deepEqual(row.historicalComparison.addedMinuteStarts,[iso(END-15*60000)]);
  assert.equal(row.historicalComparison.primaryContiguousTailBars,14);
  assert.equal(row.historicalComparison.secondaryContiguousTailBars,60);
  assert.equal(row.historicalComparison.samePoolVerified,false);
  assert.equal(row.primaryHistorical.atHistoricalBoundary.ready,false);
  assert.equal(row.secondaryHistorical.atHistoricalBoundary.ready,true);
  assert.equal(row.currentRuntime.closedThroughAt,iso(NOW));
  assert.equal(row.historicalWindow.to,to,'current response never replaces the original UTC window');
});

test('missing original raw candles never become an invented original minute set',async t=>{
  const r=await reviewChartSourceBacklog(await fixture(t,{raw:false})),row=r.candidates[0];
  assert.equal(row.primaryHistorical.available,false);assert.equal(row.primaryHistorical.reportedClosedBars,59);
  assert.equal(row.primaryHistorical.minuteStarts,undefined);assert.equal(row.primaryHistorical.missingMinuteStarts,undefined);
  assert.equal(row.historicalComparison.reasonCode,'PRIMARY_RAW_UNAVAILABLE');
  assert.equal(row.historicalComparison.addedMinuteStarts,undefined);
  assert.equal(row.secondaryHistorical.closedBars,60,'secondary source can still be described independently');
});

test('cross-chain same-CA and mismatched source request windows are not compared',async t=>{
  const mismatch=await reviewChartSourceBacklog(await fixture(t,{secondaryMutation:c=>{c.network='robinhood';}}));
  assert.equal(mismatch.candidates[0].secondaryHistorical.identityVerified,false);
  assert.equal(mismatch.candidates[0].historicalComparison.comparable,false);
  const shifted=await reviewChartSourceBacklog(await fixture(t,{secondaryMutation:c=>{c.from+=60;c.to+=60;}}));
  assert.equal(shifted.candidates[0].secondaryHistorical.available,false);
  assert.equal(shifted.candidates[0].historicalComparison.comparable,false);
});

test('a newly created pool is explicitly limited history even within the same requested UTC window',async t=>{
  const r=await reviewChartSourceBacklog(await fixture(t,{secondaryMutation:c=>{c.poolCreatedAt=iso(END-30*60000);c.candles=c.candles.slice(-30);}}));
  const row=r.candidates[0];assert.equal(row.secondaryHistorical.poolHistory.predatesWholeWindow,false);
  assert.equal(row.secondaryHistorical.poolHistory.createdDuringWindow,true);
  assert.equal(row.secondaryHistorical.poolHistory.returnedBarsEndingBeforePoolCreation,0);
  assert.match(row.historicalComparison.historyLimit,/cannot establish complete original history/);
  assert.equal(r.summary.secondaryPoolsCreatedAfterWindowStart,1);
});

test('open provider bar is excluded even though retrospective fetch occurs an hour later',()=>{
  const rows=bars();rows.push({...rows[0],time:END});
  const r=analyzeCandleWindow(rows,{from,to,observedAt:iso(END+10000)});
  assert.equal(r.closedBars,60);assert.equal(r.excludedUnclosedBars,1);assert.equal(r.lastActualClosedAt,iso(END));
  assert.equal(r.atOriginalObservation.ready,true);
  const different=analyzeCandleWindow(bars(),{from:from+60,to:to+60});
  assert.equal(compareChartWindows(r,different).reasonCode,'UTC_WINDOW_MISMATCH');
});

test('malformed or duplicate source bars do not create a valid observed-minute set',()=>{
  const rows=bars();rows.push({...rows[0]});
  assert.equal(analyzeCandleWindow(rows,{from,to}).reasonCode,'DUPLICATE_CANDLE');
  rows.pop();rows[0].time+=30000;
  assert.equal(analyzeCandleWindow(rows,{from,to}).reasonCode,'INVALID_CANDLE');
});
