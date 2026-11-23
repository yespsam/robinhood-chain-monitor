import test from 'node:test';
import assert from 'node:assert/strict';
import {validateChartSource,validateChartProvenance,CHART_SOURCE_VERSION} from '../src/paper-chart-source.js';
import {opportunityChart} from '../src/paper-opportunity-policy.js';

const END=Date.parse('2026-11-10T04:45:00Z'),NOW=END+15000,iso=at=>new Date(at).toISOString();
const CA='0x'+'a'.repeat(40),OTHER='0x'+'b'.repeat(40),POOL='0x'+'c'.repeat(64);
const SOL='D4CzGsZgusVj2K8R1its5H8WWdo9mazbDwBc6qvsmfun',SOL_POOL='2ZJpQEnyTugE237Cs9X5FHPrXhPauC6DBx5jLV5FqyV7';
const token={chain:'bsc',address:CA};
function source() {
  return {status:'ok',source:'geckoterminal',chain:'bsc',address:CA,tokenAddress:CA,network:'bsc',
    poolId:POOL,dexId:'uniswap-v4-bsc',tokenSide:'base',currency:'usd',resolution:'1m',
    from:END/1000-3600,to:END/1000,requestWindow:'latest_closed_at_dispatch',
    requestedAt:iso(NOW-2000),receivedAt:iso(NOW-1000),emptyIntervals:false,inferredBars:0,
    binding:{network:'bsc',poolId:POOL,baseToken:{address:CA,decimals:18},quoteToken:{address:OTHER,decimals:18},
      metadataRequestedAt:iso(NOW-5000),metadataReceivedAt:iso(NOW-3000)},
    ohlcvMeta:{base:{address:CA},quote:{address:OTHER}},
    candles:Array.from({length:30},(_,i)=>({time:iso(END-(30-i)*60000),open:1,high:1.1,low:.9,close:1,volume:10,source:'geckoterminal'}))};
}
const check=(chart=source(),t=token,now=NOW)=>validateChartSource(chart,t,{nowMs:now});

test('strict source validation freezes one exact V4 pool and an independently checkable candle digest',()=>{
  const raw=source(),original=structuredClone(raw),result=check(raw);
  assert.equal(result.ready,true);assert.deepEqual(raw,original);
  assert.equal(result.provenance.version,CHART_SOURCE_VERSION);assert.equal(result.provenance.poolId,POOL);
  assert.ok(result.candles.every(c=>c.source==='geckoterminal'&&c.sourcePoolId===POOL));
  assert.equal(validateChartProvenance(result.provenance,token,result.candles,{nowMs:NOW}).ready,true);
  raw.binding.baseToken.address=OTHER;raw.candles[0].volume=1000;
  assert.equal(validateChartProvenance(result.provenance,token,result.candles,{nowMs:NOW}).ready,true,'snapshot has no input aliases');
});

test('ordinary V2 pool addresses and exact quote-side target binding are accepted',()=>{
  const chart=source();chart.poolId='0x'+'d'.repeat(40);chart.binding.poolId=chart.poolId;
  chart.tokenSide='quote';chart.binding.baseToken.address=OTHER;chart.binding.quoteToken.address=CA;
  chart.ohlcvMeta={base:{address:OTHER},quote:{address:CA}};
  assert.equal(check(chart).ready,true);
  chart.binding.baseToken.decimals=null;
  const unknownCounter=check(chart);assert.equal(unknownCounter.ready,true);
  assert.equal(unknownCounter.provenance.binding.baseToken.decimals,null,'USD values do not invent counter-token decimals');
  chart.binding.quoteToken.decimals=null;assert.equal(check(chart).ready,false,'target-token identity precision remains required');
});

test('same CA on a different network, false target side and conflicting metadata fail closed',()=>{
  const mutations=[
    c=>{c.chain='robinhood';},c=>{c.network='robinhood';},c=>{c.binding.network='robinhood';},
    c=>{c.address=OTHER;},c=>{c.tokenAddress=OTHER;},c=>{c.tokenSide='quote';},
    c=>{c.binding.baseToken.address=OTHER;},c=>{c.ohlcvMeta.base.address=OTHER;},
    c=>{c.binding.poolId='0x'+'d'.repeat(64);},c=>{c.poolId=CA.slice(0,-1);},
    c=>{c.binding.baseToken.decimals=null;},c=>{c.currency='native';},
  ];
  for(const mutate of mutations){const c=source();mutate(c);assert.equal(check(c).ready,false,mutate.toString());}
  const upper=source();upper.address=CA.toUpperCase().replace('0X','0x');assert.equal(check(upper).ready,true);
});

test('Solana identity remains case sensitive across target, pool and response metadata',()=>{
  const chart=source(),quote='So11111111111111111111111111111111111111112';
  Object.assign(chart,{chain:'sol',network:'solana',address:SOL,tokenAddress:SOL,poolId:SOL_POOL,dexId:'raydium'});
  chart.binding={...chart.binding,network:'solana',poolId:SOL_POOL,baseToken:{address:SOL,decimals:9},quoteToken:{address:quote,decimals:9}};
  chart.ohlcvMeta={base:{address:SOL},quote:{address:quote}};
  const target={chain:'sol',address:SOL};assert.equal(check(chart,target).ready,true);
  for(const mutate of [c=>{c.tokenAddress=SOL.toLowerCase();},c=>{c.ohlcvMeta.base.address=SOL.toLowerCase();},
    c=>{c.binding.poolId=SOL_POOL.toLowerCase();}]){
    const copy=structuredClone(chart);mutate(copy);assert.equal(check(copy,target).ready,false);
  }
});

test('source window is anchored at dispatch, with fixed historical windows explicitly distinguished',()=>{
  const invalid=[c=>{c.to+=60;c.from+=60;},c=>{c.from-=60;},c=>{c.to++;c.from++;},
    c=>{c.receivedAt=iso(NOW+1);},c=>{c.receivedAt=iso(NOW-2500);},
    c=>{c.binding.metadataReceivedAt=c.receivedAt;},c=>{c.requestWindow='unknown';},c=>{c.requestedAt='invalid';}];
  for(const mutate of invalid){const c=source();mutate(c);assert.equal(check(c).ready,false,mutate.toString());}
  const old=source();old.requestedAt=iso(NOW+60000);old.receivedAt=iso(NOW+61000);
  assert.equal(check(old,token,NOW+62000).ready,false,'latest response cannot reuse a prior dispatch boundary');
  old.requestWindow='fixed_historical';assert.equal(check(old,token,NOW+62000).ready,true);
});

test('unfinished and future bars never become closed by aging in the response or cache',()=>{
  const c=source();c.candles.push({...c.candles[0],time:iso(END)},{...c.candles[0],time:iso(END+60000)});
  c.receivedAt=iso(NOW+120000);
  const result=check(c,token,NOW+120000);assert.equal(result.ready,true);assert.equal(result.candles.length,30);
  assert.equal(result.excludedUnclosedBars,2);assert.ok(result.candles.every(x=>x.time+60000<=END));
  assert.equal(opportunityChart(result.candles,'ok',NOW+120000,{contiguousTail:true}).ready,false,'source success does not refresh the old bar clock');
  assert.equal(validateChartProvenance(result.provenance,token,result.candles,{nowMs:NOW+180000}).ready,true);
  const injected=[...result.candles,{...result.candles.at(-1),time:END}];
  assert.equal(validateChartProvenance(result.provenance,token,injected,{nowMs:NOW+180000}).ready,false);
});

test('synthetic filling, mixed providers and mixed pools are rejected before chart continuity checks',()=>{
  for(const mutate of [c=>{c.emptyIntervals=true;},c=>{c.inferredBars=1;},c=>{c.synthetic=true;},c=>{c.noTrade=true;},
    c=>{c.candles[15].synthetic=true;c.candles[15].volume=0;},
    c=>{c.candles[15].source='gmgn-cli';},c=>{c.candles[15].sourcePoolId='0x'+'d'.repeat(64);}]) {
    const c=source();mutate(c);assert.equal(check(c).ready,false,mutate.toString());
  }
  const sparse=source();sparse.candles.splice(15,1);const result=check(sparse);
  assert.equal(result.ready,true,'source integrity and trade readiness are separate');
  assert.equal(opportunityChart(result.candles,'ok',NOW,{contiguousTail:true}).diagnostics.code,'insufficient_contiguous_tail');
  assert.equal(result.candles.length,29,'validator does not fill the missing minute');
  const zero=source();zero.candles[15].volume=0;
  assert.equal(check(zero).reasonCode,'CHART_SOURCE_NO_TRADE_BAR','backup sparse mode never silently counts provider no-trade bars');
});

test('invalid, duplicate, shifted and malformed bars are not normalized into valid candles',()=>{
  for(const mutate of [c=>{c.candles[2].time=c.candles[1].time;},c=>{c.candles.forEach(x=>{x.time=iso(Date.parse(x.time)+30000);});},
    c=>{c.candles[0].time='invalid';},c=>{c.candles[0].high=.5;},c=>{c.candles[0].volume=-1;},
    c=>{c.candles[0].close=NaN;},c=>{c.candles[0].volume='10';},c=>{c.candles=[];}]) {
    const c=source();mutate(c);assert.equal(check(c).ready,false,mutate.toString());
  }
});

test('provenance cannot be removed or independently altered after a source window is frozen',()=>{
  const result=check();
  assert.equal(validateChartProvenance(null,token,result.candles,{nowMs:NOW}).reasonCode,'CHART_PROVENANCE_REQUIRED');
  for(const mutate of [p=>{p.poolId='0x'+'d'.repeat(64);},p=>{p.chain='robinhood';},p=>{p.to-=60;},
    p=>{p.source='gmgn-cli';},p=>{p.barCount--;},p=>{p.sourceDigest='0'.repeat(64);},p=>{p.candleDigest='0'.repeat(64);}]) {
    const p=structuredClone(result.provenance);mutate(p);
    assert.equal(validateChartProvenance(p,token,result.candles,{nowMs:NOW}).ready,false,mutate.toString());
  }
  const changed=structuredClone(result.candles);changed[5].volume++;
  assert.equal(validateChartProvenance(result.provenance,token,changed,{nowMs:NOW}).ready,false);
});

test('existing unmarked GMGN proof behavior remains compatible and explicit GMGN metadata can be retained',()=>{
  const chart=source();chart.source='gmgn-cli';chart.candles.forEach(c=>{c.source='';});
  assert.equal(validateChartProvenance(undefined,token,chart.candles,{nowMs:NOW}).ready,true);
  const result=check(chart);assert.equal(result.ready,true);assert.equal(result.provenance.source,'gmgn-cli');
  assert.equal(validateChartProvenance(result.provenance,token,result.candles,{nowMs:NOW}).ready,true);
  for(const mutate of [c=>{c.candles[0].source='geckoterminal';},c=>{c.candles[0].sourcePoolId=POOL;},
    c=>{c.candles[0].synthetic=true;},c=>{c.candles[0].noTrade=true;},c=>{c.emptyIntervals=true;}]) {
    const forged=structuredClone(chart);mutate(forged);assert.equal(check(forged).ready,false,mutate.toString());
  }
  const marked=structuredClone(chart.candles);marked[0].noTrade=true;
  assert.equal(validateChartProvenance(undefined,token,marked,{nowMs:NOW}).ready,false,'legacy compatibility cannot launder explicit artificial markers');
});
