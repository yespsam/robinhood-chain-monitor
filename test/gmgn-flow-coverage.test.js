import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceFeedCoverage,flowWindowCoverage,FLOW_SCOPE} from '../src/gmgn-flow-coverage.js';
import {parseGmgnFlowTrades,parseGmgnFlowCandles,mergeGmgnFlowTrade} from '../src/gmgn-flow-signal.js';
import {buildPaperFlowEvidence} from '../src/paper-strategy-evidence.js';
const NOW=Date.parse('2026-09-21T10:00:00Z'),CA=`0x${'1'.repeat(40)}`,W=`0x${'2'.repeat(40)}`;
const row=(at=NOW-360000,n='a')=>({maker:W,base_address:CA,transaction_hash:`0x${n.repeat(64)}`,side:'buy',amount_usd:300,base_amount:3000,quote_amount:1,timestamp:at/1000,maker_info:{tags:['smart_degen']}});
const source=feed=>({feedCoverage:{smartmoney:feed,kol:feed}});
test('a capped page spanning the whole window proves source scope, never full chain',()=>{
 const feed=advanceFeedCoverage(null,[row(NOW-360000),row(NOW-1000,'b')],'bsc',NOW,NOW+100);
 const result=flowWindowCoverage(source(feed),NOW+100);
 assert.equal(result.complete,true);assert.equal(result.scope,FLOW_SCOPE);assert.equal(result.endAt,NOW);
});
test('short and empty pages warm up; gaps, malformed records and stale snapshots fail closed',()=>{
 let feed=advanceFeedCoverage(null,[row(NOW-1000)],'bsc',NOW,NOW);
 assert.equal(flowWindowCoverage(source(feed),NOW).complete,false);
 for(let n=1;n<=5;n++)feed=advanceFeedCoverage(feed,[row(NOW-1000)],'bsc',NOW+n*60000,NOW+n*60000);
 assert.equal(flowWindowCoverage(source(feed),NOW+300000).complete,true);
 const gap=advanceFeedCoverage(feed,[row(NOW+350000,'b')],'bsc',NOW+360000,NOW+360000);
 assert.equal(flowWindowCoverage(source(gap),NOW+360000).complete,false);
 const invalid=advanceFeedCoverage(feed,[{...row(),maker:'invalid'}],'bsc',NOW,NOW);
 assert.equal(invalid.valid,false);assert.equal(flowWindowCoverage(source(invalid),NOW).complete,false);
 assert.equal(flowWindowCoverage(source(feed),NOW+500000).complete,false);
 let empty=advanceFeedCoverage(null,[],'bsc',NOW,NOW);assert.equal(flowWindowCoverage(source(empty),NOW).complete,false);
 for(let n=1;n<=5;n++)empty=advanceFeedCoverage(empty,[],'bsc',NOW+n*60000,NOW+n*60000);
 assert.equal(flowWindowCoverage(source(empty),NOW+300000).complete,true);
});
test('missing one source or local eviction never passes; gaps cannot be healed with only a heartbeat',()=>{
 const feed=advanceFeedCoverage(null,[row()],'bsc',NOW,NOW);
 assert.equal(flowWindowCoverage({feedCoverage:{smartmoney:feed}},NOW).complete,false);
 assert.equal(flowWindowCoverage({...source(feed),discardedThroughAt:NOW-1000},NOW).complete,false);
 assert.equal(flowWindowCoverage({...source(feed),lastSuccessAt:new Date(NOW+200000).toISOString()},NOW+200000).complete,false);
});
test('unrelated token quarantine and profile gaps do not poison a proven source window',()=>{
 const feed=advanceFeedCoverage(null,[row()],'bsc',NOW,NOW);
 const trades=parseGmgnFlowTrades({list:[row(NOW-1000)]},'bsc',NOW);
 const state={chains:{bsc:{...source(feed),status:'partial',coverageGap:'ambiguous_trade_legs',feedTruncated:true,
   quarantinedTokens:{[`0x${'3'.repeat(40)}`]:new Date(NOW+300000).toISOString()}}},trades:{bsc:trades},profiles:{}};
 const good=buildPaperFlowEvidence({state,chain:'bsc',address:CA,nowMs:NOW});
 assert.equal(good.complete,true);assert.equal(good.status,'healthy');assert.equal(good.coverageGap,null);assert.equal(good.netBuyUsd,300);
 state.chains.bsc.quarantinedTokens[CA]=new Date(NOW+300000).toISOString();
 assert.equal(buildPaperFlowEvidence({state,chain:'bsc',address:CA,nowMs:NOW}).complete,false);
});
test('USD revisions require identical units/time/direction, stay conservative and do not multiply wallets',()=>{
 const a=row(NOW-1000),b={...a,amount_usd:302};
 const trades=parseGmgnFlowTrades({list:[a,b]},'bsc',NOW);
 assert.equal(trades.length,1);assert.equal(trades[0].amountUsd,300);assert.equal(trades[0].usdRevised,true);
 const sell=parseGmgnFlowTrades({list:[{...a,side:'sell'},{...b,side:'sell'}]},'bsc',NOW);
 assert.equal(sell[0].amountUsd,302);
 assert.throws(()=>parseGmgnFlowTrades({list:[a,{...b,base_amount:2999}]},'bsc',NOW),/CONFLICT/);
 assert.throws(()=>mergeGmgnFlowTrade(trades[0],{...trades[0],at:NOW}),/CONFLICT/);
 assert.throws(()=>mergeGmgnFlowTrade(trades[0],{...trades[0],side:'sell'}),/CONFLICT/);
});
test('old milliseconds/USD volume and new seconds/USD amount are unit-checked; ambiguous units are rejected',()=>{
 const old={time:NOW,low:.09,high:.11,volume:30,amount:300};
 assert.deepEqual(parseGmgnFlowCandles({list:[old]}),[{time:NOW,volumeUsd:30}]);
 assert.deepEqual(parseGmgnFlowCandles({list:[{...old,time:NOW/1000,volume:300,amount:30}]}),[{time:NOW,volumeUsd:30}]);
 for(const r of [{time:NOW,volume:300}, {...old,amount:2},{...old,volume:99,amount:100,low:.95,high:1.05}])assert.throws(()=>parseGmgnFlowCandles({list:[r]}),/UNITS_UNVERIFIED/);
});
