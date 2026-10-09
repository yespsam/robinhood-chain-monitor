import test from 'node:test';
import assert from 'node:assert/strict';
import {paperEventTriggers} from '../src/paper-event-triggers.js';
import {strictFlapTrackedPoolTokenEvent} from './fixtures/paper-pool-event.js';
import {row as binanceRow,warmFeed,stateFor} from './fixtures/binance-flow.js';
import {buildPaperDualFlowEvidence} from '../src/paper-strategy-evidence.js';
const NOW=Date.parse('2026-09-30T06:00:00Z'),iso=t=>new Date(t).toISOString();
const ca='0x'+'a'.repeat(40),wallet='0x'+'b'.repeat(40);
function evidence(side='buy') {
  const feedCoverage=Object.fromEntries(['smartmoney','kol'].map(k=>[k,{valid:true,startAt:NOW-360000,endAt:NOW,observedAt:NOW,keys:[]}]));
  return {flowState:{chains:{bsc:{status:'healthy',lastSuccessAt:iso(NOW),feedCoverage}},profiles:{},
    trades:{bsc:[{chain:'bsc',tokenAddress:ca,wallet,side,amountUsd:1000,at:NOW-1000,hash:'0x'+'1'.repeat(64),tags:['smart_degen']}]}}};
}
test('wallet event is CA-bound, fresh and buy-only; a public label is not a verified profitable wallet',()=>{
  const result=paperEventTriggers({evidence:evidence(),account:{trades:[]},chains:['bsc'],nowMs:NOW});
  assert.equal(result.length,1);assert.equal(result[0].address,ca);assert.equal(result[0].source,'wallet_buy');
  for(const side of ['sell','transfer'])assert.deepEqual(paperEventTriggers({evidence:evidence(side),chains:['bsc'],nowMs:NOW}),[]);
  assert.deepEqual(paperEventTriggers({evidence:evidence(),chains:['sol'],nowMs:NOW}),[]);
  assert.deepEqual(paperEventTriggers({evidence:evidence(),chains:['bsc'],nowMs:NOW+91000}),[]);
  const broken=evidence();broken.flowState.chains.bsc.feedCoverage={};
  assert.deepEqual(paperEventTriggers({evidence:broken,chains:['bsc'],nowMs:NOW}),[]);
});
test('only authenticated first-three pool proofs can trigger; old receipts and consumed CAs cannot',()=>{
  const event=strictFlapTrackedPoolTokenEvent({ordinal:1,blockTimestamp:iso(NOW-1000),observedAt:iso(NOW)});
  const query={evidence:{events:[event]},account:{trades:[]},chains:['bsc'],nowMs:NOW};
  const result=paperEventTriggers(query);assert.equal(result.length,1);assert.equal(result[0].source,'new_pool_first_three');
  assert.deepEqual(paperEventTriggers({...query,nowMs:NOW+121000}),[]);
  assert.deepEqual(paperEventTriggers({...query,account:{trades:[{side:'buy',chain:'bsc',address:result[0].address}]}}),[]);
  assert.deepEqual(paperEventTriggers({...query,evidence:{events:[{...event,featurePlatform:'fourmeme'}]}}),[]);
});

function bothSources({gmgnAge=110000,binanceAge=20000}={}) {
  const value=evidence();value.flowState.trades.bsc[0].at=NOW-gmgnAge;
  const feed=warmFeed([binanceRow(1,{chainId:'56',ts:(NOW-binanceAge)/1000})],{chain:'bsc',kind:'kol',at:NOW});
  value.binanceState={...stateFor(feed),updatedAt:NOW,chains:{bsc:{feeds:{kol:feed}}}};
  return value;
}
const triggers=value=>paperEventTriggers({evidence:value,chains:['bsc'],nowMs:NOW});

test('an older GMGN cohort cannot mask a new Binance buy; entry cohort precedence stays unchanged',()=>{
  const value=bothSources(),result=triggers(value);
  const chosen=buildPaperDualFlowEvidence({state:value.flowState,binanceState:value.binanceState,chain:'bsc',address:ca,nowMs:NOW});
  assert.equal(chosen.complete,true);assert.equal(chosen.provider,'gmgn');
  assert.equal(result.length,1);assert.equal(result[0].provider,'binance_kol');
  assert.equal(result[0].sourceAt,iso(NOW-20000));
  assert.equal(result[0].sourceWindowEndAt,iso(NOW-10000));
  assert.equal(result[0].sourceSnapshotReceivedAt,iso(NOW),'coverage watermark is not a receipt timestamp');
  assert.equal(chosen.netBuyUsd,1000,'independent sources are not summed');
});

test('the same CA/buy timestamp across providers is one stable wake-up, including provider failover',()=>{
  const value=bothSources({gmgnAge:20000});
  const first=triggers(value);assert.equal(first.length,1);assert.equal(first[0].provider,'gmgn');
  assert.equal(first[0].sourceSnapshotReceivedAt,null,'do not invent a merged GMGN receipt timestamp');
  value.flowState.chains.bsc.feedCoverage={};
  const second=triggers(value);assert.equal(second.length,1);assert.equal(second[0].provider,'binance_kol');
  assert.equal(second[0].id,first[0].id);
});

test('independent discovery still rejects ambiguous, warming, stale, sell, transfer and wrong-chain secondary data',()=>{
  for(const change of [
    v=>v.binanceState.chains.bsc.feeds.kol.rows[0].chain='eth',
    v=>v.binanceState.chains.bsc.feeds.kol.issues[ca]=NOW+300000,
    v=>v.binanceState.chains.bsc.feeds.kol.coverage.startAt=NOW-30000,
    v=>v.binanceState.chains.bsc.feeds.kol.coverage.receivedAt=NOW-100000,
    v=>v.binanceState.chains.bsc.feeds.kol.rows.find(r=>r.tokenAddress===ca).side='sell',
    v=>v.binanceState.chains.bsc.feeds.kol.rows.find(r=>r.tokenAddress===ca).side='unknown',
  ]) {const value=bothSources();change(value);assert.deepEqual(triggers(value),[],change.toString());}
  assert.deepEqual(triggers(bothSources({binanceAge:100000})),[]);
  assert.deepEqual(triggers(bothSources({binanceAge:5000})),[],'preserve the index watermark, not provisional buys');
});

test('event candidates are ordered by recency, not truncated to the top thirty inflow candidates',()=>{
  const value=evidence();
  value.flowState.trades.bsc=Array.from({length:40},(_,i)=>({...value.flowState.trades.bsc[0],
    tokenAddress:`0x${(100+i).toString(16).padStart(40,'0')}`,at:NOW-40000+i*1000,amountUsd:10000-i*200}));
  const result=triggers(value);
  assert.equal(result.length,40);
  assert.equal(result[0].address,value.flowState.trades.bsc[39].tokenAddress);
  assert.equal(result.at(-1).address,value.flowState.trades.bsc[0].tokenAddress);
});
