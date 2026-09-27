import test from 'node:test';
import assert from 'node:assert/strict';
import {GMGN_FLOW_CHAINS,gmgnFlowAddress,parseGmgnFlowTrades,parseGmgnFlowCandles,parseGmgnFlowProfile,
  qualifiesGmgnFlowWallet,gmgnFlowVolume,evaluateGmgnFlowSignal,isGmgnFlowEvent} from '../src/gmgn-flow-signal.js';
const now=Date.parse('2026-09-20T01:00:10Z'),end=Math.floor(now/60000)*60000;
const addr=n=>`0x${n.toString(16).padStart(40,'0')}`,hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
function input(chain='bsc') {
 const ca=addr(900),profiles={};
 const trades=Array.from({length:6},(_,i)=>({chain,tokenAddress:ca,wallet:addr(i+1),hash:hash(i+1),side:'buy',amountUsd:3000,at:end-60000,tags:i>=3?['fomo']:[]}));
 for(const t of trades.slice(0,5)) profiles[t.wallet]=Object.fromEntries(['7d','30d'].map(period=>[period,{chain,wallet:t.wallet,period,checkedAt:new Date(now).toISOString(),realizedProfitUsd:15000,realizedRoi:0.5,winRate:0.7,tokenCount:150,buyCount:200,sellCount:200,tags:[],createdAt:Math.floor(now/1000)-90*86400,lastTradeAt:Math.floor(now/1000)-60,createdTokenCount:0}]));
 return {chain,tokenAddress:ca,profiles,trades,nowMs:now,candles:Array.from({length:20},(_,i)=>({time:end-(20-i)*60000,volumeUsd:i<15?1000:10000}))};
}
function event() {
 const e=input(),r=evaluateGmgnFlowSignal(e);
 return {type:'gmgn_flow_surge',platform:'gmgn',chain:GMGN_FLOW_CHAINS.bsc,token:{address:e.tokenAddress,symbol:'TEST',name:'Fixture'},
 source:{id:'gmgn_flow_observed',trust:'provider_reported',url:`https://gmgn.ai/bsc/token/${e.tokenAddress}`},
 observedAt:new Date(now).toISOString(),sourceOccurredAt:r.signal.windowEndAt,eventKey:`gmgn-flow:bsc:${e.tokenAddress}:${end}`,...r,
 narrative:{status:'unverified',text:'叙事待核实',sourceUrl:null,sourceAt:null,chain:'bsc',tokenAddress:e.tokenAddress},
 evidence:{version:1,provider:'gmgn-cli',chain:e.chain,tokenAddress:e.tokenAddress,candles:e.candles,trades:e.trades,profiles:e.profiles}};
}
test('GMGN addresses preserve Solana case and isolate chain namespaces',()=>{
 assert.equal(gmgnFlowAddress('sol','So11111111111111111111111111111111111111112'),'So11111111111111111111111111111111111111112');
 assert.equal(gmgnFlowAddress('bsc',addr(11).toUpperCase().replace('0X','0x')),addr(11));
 assert.equal(gmgnFlowAddress('monad',addr(11)),null);
 assert.equal(gmgnFlowAddress('bsc',addr(0)),null);
});
test('trade parser binds chain, side and real time; deduplicates matching feed IDs',()=>{
 const row={maker:addr(1),base_address:addr(900),transaction_hash:hash(1),side:'buy',amount_usd:'3000',timestamp:Math.floor(now/1000)-60,maker_info:{tags:['fomo']}};
 const result=parseGmgnFlowTrades({code:0,data:{list:[row,row,{...row,chain:'eth'},{...row,timestamp:now},{...row,side:'transfer'}]}},'bsc',now);
 assert.equal(result.length,1);assert.equal(result[0].amountUsd,3000);
 assert.throws(()=>parseGmgnFlowTrades({data:{list:[row,{...row,amount_usd:99}]}},'bsc',now),/CONFLICT/);
 assert.throws(()=>parseGmgnFlowTrades({code:429},'bsc',now),/UPSTREAM/);
});
test('candles use USD volume not token amount and require complete nonzero baseline',()=>{
 const candles=parseGmgnFlowCandles({data:{list:input().candles.map(c=>({time:c.time,volume:String(c.volumeUsd),amount:String(c.volumeUsd*10),low:.09,high:.11}))}});
 const v=gmgnFlowVolume(candles,now);assert.equal(v.volumeUsd,50000);assert.equal(v.baselineVolumeUsd,5000);assert.equal(v.volumeMultiple,10);
 assert.equal(gmgnFlowVolume(candles.slice(1),now),null);
 assert.equal(gmgnFlowVolume(candles.map((c,i)=>({...c,volumeUsd:i<15?0:c.volumeUsd})),now),null);
 assert.equal(gmgnFlowVolume(candles,now+120000),null);
});
test('joint condition counts independent wallets and discloses the overlap',()=>{
 const result=evaluateGmgnFlowSignal(input());assert.ok(result);assert.equal(result.signal.highProfitCount,5);
 assert.equal(result.signal.fomoCount,3);assert.equal(result.signal.uniqueBuyerCount,6);assert.equal(result.signal.overlapCount,2);
 for(const field of ['profiles','trades']) assert.equal(evaluateGmgnFlowSignal({...input(),[field]:field==='profiles'?{}:[]}),null);
 const e=input();e.trades[5].tags=[];assert.equal(evaluateGmgnFlowSignal(e),null);
});
test('repeat buys do not multiply wallets; sell reversals reduce qualified net inflow',()=>{
 const e=input(); e.trades.push(...structuredClone(e.trades));assert.equal(evaluateGmgnFlowSignal(e).signal.netBuyUsd,18000);
 e.trades.push({...e.trades[0],hash:hash(100),side:'sell',amountUsd:3000});assert.equal(evaluateGmgnFlowSignal(e),null);
});
test('high-profit classification requires both realized-profit windows and fresh matching wallets',()=>{
 const e=input(),w=addr(1),p=e.profiles[w];assert.equal(qualifiesGmgnFlowWallet(p,'bsc',w,now),true);
 for(const [key,value] of [['realizedProfitUsd',0],['winRate',0.59],['checkedAt',new Date(now-3*3600000).toISOString()],['chain','eth'],['tokenCount',2],['tags',['wash_trader']]]){
  const copy=structuredClone(p);copy['30d'][key]=value;assert.equal(qualifiesGmgnFlowWallet(copy,'bsc',w,now),false,key);
 }
});
test('stats normalization binds wallet and does not substitute paper profit',()=>{
 const raw={wallet_address:addr(1),realized_profit:9000,unrealized_profit:1e9,realized_profit_pnl:0.1,pnl_stat:{winrate:0.7,token_num:60},buy:70,sell:60,last_timestamp:Math.floor(now/1000),common:{tags:[],created_at:Math.floor(now/1000)-90*86400,created_token_count:0}};
 assert.equal(parseGmgnFlowProfile({data:[raw]},'bsc',addr(1),'7d',now).realizedProfitUsd,9000);
 assert.equal(parseGmgnFlowProfile({data:[raw]},'bsc',addr(2),'7d',now),null);
 assert.equal(parseGmgnFlowProfile({data:[{...raw,realized_profit:null}]},'bsc',addr(1),'7d',now),null);
});
test('source gate recomputes evidence instead of trusting claimed counts or window IDs',()=>{
 const e=event();assert.equal(isGmgnFlowEvent(e,{nowMs:now}),true);
 for(const mutate of [e=>e.signal.fomoCount++,e=>e.chain=GMGN_FLOW_CHAINS.eth,e=>e.eventKey+='x',e=>e.evidence.trades[0].hash='fake',e=>e.narrative.sourceUrl='https://evil.test',e=>e.narrative=undefined]){
  const copy=structuredClone(e);mutate(copy);assert.equal(isGmgnFlowEvent(copy),false);
 }
 assert.equal(isGmgnFlowEvent(e,{nowMs:now+1000000}),false);
});

test('an unknown zero creation timestamp cannot qualify as an old high-profit wallet',()=>{
 const e=input(),wallet=addr(1),profiles=e.profiles[wallet];
 assert.equal(qualifiesGmgnFlowWallet(profiles,'bsc',wallet,now),true);
 for(const period of ['7d','30d']) {
  const unknownAge=structuredClone(profiles);unknownAge[period].createdAt=0;
  assert.equal(qualifiesGmgnFlowWallet(unknownAge,'bsc',wallet,now),false,period);
  assert.equal(evaluateGmgnFlowSignal({...e,profiles:{...e.profiles,[wallet]:unknownAge}}),null,
   'unknown wallet age cannot supply the fifth high-profit buyer');
 }
});

test('blocked performance-profile tags exclude the whole wallet even when its trade has the fomo tag',()=>{
 for(const period of ['7d','30d']) for(const tag of ['wash_trader','contract','mev_bot']) {
  const e=input(),wallet=addr(6);
  e.profiles[wallet]=structuredClone(e.profiles[addr(1)]);
  for(const profile of Object.values(e.profiles[wallet]))profile.wallet=wallet;
  e.profiles[wallet][period].tags=[tag];
  assert.equal(evaluateGmgnFlowSignal(e),null,`${period}/${tag}: dirty FOMO wallet must not meet the sixth-buyer threshold`);
  e.trades.push({...e.trades[5],wallet:addr(7),hash:hash(7)});
  const result=evaluateGmgnFlowSignal(e);
  assert.ok(result,'a separate clean FOMO buyer can restore the joint signal');
  assert.equal(result.signal.highProfitCount,5);
  assert.equal(result.signal.fomoCount,3);
  assert.equal(result.signal.uniqueBuyerCount,6);
  assert.equal(result.signal.netBuyUsd,18000);
  assert.equal(result.buyers.some(b=>b.wallet===wallet),false,`${period}/${tag}: dirty wallet must be absent, not merely downgraded`);
 }
});

test('duplicate transaction observations with equal amounts but conflicting times are rejected',()=>{
 const row={maker:addr(1),base_address:addr(900),transaction_hash:hash(1),side:'buy',amount_usd:'3000',
  timestamp:end/1000-60,maker_info:{tags:['fomo']}};
 for(const delta of [-60,60]) {
  const conflicting={...row,timestamp:row.timestamp+delta};
  assert.throws(()=>parseGmgnFlowTrades({list:[row,conflicting]},'bsc',now),/GMGN_TRADE_CONFLICT/);
  assert.throws(()=>parseGmgnFlowTrades({list:[conflicting,row]},'bsc',now),/GMGN_TRADE_CONFLICT/);
 }
 const e=input();e.trades.push({...e.trades[0],at:e.trades[0].at-60000});
 assert.equal(evaluateGmgnFlowSignal(e),null,'normalized evidence also rejects conflicting times within the selected window');
 const proof=event();proof.evidence.trades.push({...proof.evidence.trades[0],at:proof.evidence.trades[0].at-60000});
 assert.equal(isGmgnFlowEvent(proof),false,'source admission must not trust counts computed before the conflict');
});

test('a pinned closed-minute window survives processing across a minute but expires after 120 seconds',()=>{
 const e=input(),expected=evaluateGmgnFlowSignal({...e,windowEndMs:end});
 for(const processingAt of [end+60001,end+119999,end+120000]) {
  const result=evaluateGmgnFlowSignal({...e,windowEndMs:end,nowMs:processingAt});
  assert.deepEqual(result,expected,`window remains pinned at processing delay ${processingAt-end} ms`);
  assert.equal(result.signal.windowEndAt,new Date(end).toISOString());
 }
 assert.equal(evaluateGmgnFlowSignal({...e,windowEndMs:end,nowMs:end+120001}),null);
 assert.equal(evaluateGmgnFlowSignal({...e,windowEndMs:end+1}),null,'a non-minute-aligned anchor is invalid');
 assert.equal(evaluateGmgnFlowSignal({...e,windowEndMs:end+60000}),null,'a future closed-minute anchor is invalid');
 const proof=event();proof.evidence.windowEndMs=end;proof.observedAt=new Date(end+61000).toISOString();
 assert.equal(isGmgnFlowEvent(proof,{nowMs:end+61000}),true,'the source gate accepts a valid crossing-minute proof');
 proof.observedAt=new Date(end+120001).toISOString();
 assert.equal(isGmgnFlowEvent(proof,{nowMs:end+120001}),false);
});
