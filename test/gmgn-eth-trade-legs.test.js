import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileEthTradeLegs, createEthTradeLegResolver } from '../src/gmgn-eth-trade-legs.js';
import { parseGmgnFlowTrades, mergeGmgnFlowTrade } from '../src/gmgn-flow-signal.js';
const NOW=Date.parse('2026-09-27T12:00:00Z'),addr=n=>'0x'+String(n).padStart(40,'0'),hash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64),topic=a=>'0x'+a.slice(2).padStart(64,'0');
const raw=(base=100,quote=1,side='sell')=>({transaction_hash:hash,maker:addr(1),base_address:addr(2),side,timestamp:NOW/1000-60,base_amount:base,quote_amount:quote,amount_usd:quote*10,maker_info:{tags:['smart_degen']}});
const trade=r=>parseGmgnFlowTrades({list:[r]},'eth',NOW)[0];
const proof=(side='sell')=>({decimals:18,block:{hash:blockHash,timestamp:'0x'+(NOW/1000-60).toString(16)},receipt:{status:'0x1',transactionHash:hash,from:addr(1),blockHash,blockNumber:'0x1',logs:[{address:addr(2),topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',topic(addr(side==='sell'?1:3)),topic(addr(side==='sell'?3:1))],data:'0x'+(300n*10n**18n).toString(16).padStart(64,'0'),logIndex:'0x1'}]}});
test('receipt verifies split router legs, merges duplicate observations once and preserves later partial polls',()=>{
  for(const side of ['buy','sell']){
    const a=trade(raw(100,1,side)),b=trade(raw(200,2,side));
    const full=reconcileEthTradeLegs([a,b,a],proof(side),NOW);
    assert.equal(full.amountUsd,30);assert.equal(full.baseAmount,300);assert.equal(full.receiptLegs.parts.length,2);
    assert.equal(mergeGmgnFlowTrade(full,a).amountUsd,30);
    assert.equal(mergeGmgnFlowTrade(b,full).amountUsd,30);
    assert.equal(mergeGmgnFlowTrade(full,full).amountUsd,30);
  }
});
test('unverified distinct legs, other senders, failed receipts, wrong timestamps and unmatched balances remain conflicts',()=>{
  const a=trade(raw()),b=trade(raw(200,2));
  assert.throws(()=>parseGmgnFlowTrades({list:[raw(),raw(200,2)]},'eth',NOW),/CONFLICT/);
  for(const mutate of [x=>x.receipt.status='0x0',x=>x.receipt.from=addr(4),x=>x.receipt.transactionHash='0x'+'c'.repeat(64),x=>x.block.hash='0x'+'c'.repeat(64),x=>x.block.timestamp='0x1',x=>x.receipt.logs[0].removed=true,x=>x.decimals=17,x=>x.receipt.logs.push(x.receipt.logs[0])]){
    const p=proof();mutate(p);assert.throws(()=>reconcileEthTradeLegs([a,b],p,NOW),/CONFLICT/);
  }
});
test('resolver only spends bounded receipt reads on actual ETH conflicts and shares cache across polls',async()=>{
  let requests=0;const p=proof();const resolver=createEthTradeLegResolver({now:()=>NOW,fetchImpl:async(url,opt)=>{
    requests++;const q=JSON.parse(opt.body);const result={eth_chainId:'0x1',eth_getTransactionReceipt:p.receipt,eth_getBlockByHash:p.block,eth_call:'0x12'}[q.method];assert.ok(result);return{ok:true,json:async()=>({id:1,result})};
  }});
  resolver.beginScan();assert.equal((await resolver.parse([raw()],'eth',NOW)).length,1);assert.equal(requests,0);
  const full=(await resolver.parse([raw(),raw(200,2)],'eth',NOW))[0];assert.equal(requests,4);assert.equal(full.amountUsd,30);
  await resolver.parse([raw(),raw(200,2)],'eth',NOW);assert.equal(requests,4);
  const prior=new Map([[full.key,full]]);assert.equal((await resolver.parse([raw()],'eth',NOW,prior))[0].amountUsd,30);
});
