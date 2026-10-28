import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGangLaunchGateway} from '../server/gang-launch-gateway.mjs';
import {createRoundtripLedger,token,wallet,U,settlement} from './helpers/roundtrip-ledger.mjs';
import {VT} from '../server/gang-reader.mjs';
const config={mode:'live',perTokenMaxBnb:'1',totalMaxBnb:'2',maxBuys:2,validForSeconds:3600,maxAgeSeconds:120,slippageBps:'1000',swapSlippageBps:'100'};
async function fixture(t,options={}){const dir=await mkdtemp(join(tmpdir(),'yesp-gang-strategy-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=createRoundtripLedger(dir,options),gateway=createGangLaunchGateway(f),m=await f.reader.inspect(token),row={tokenAddress:token,manager:m.manager},entry=await gateway.entry(row,config,wallet);return {...f,gateway,p:{...entry,...row,wallet,config,mode:'live',buyIntentId:randomUUID()}};}
const guard={active(){},async verify(){}};
test('Gang strategy full ledger: 1% supply, BNB funding, approval, receipt cost, 2x quote, half sale and conversion preserve remainder',async t=>{
 const f=await fixture(t,{phone:true,oldAllowance:true,roundFunding:true});assert.equal(f.p.amountRaw,(10000000n*U).toString());assert.equal(f.p.expectedRaw,f.p.amountRaw);assert.equal(f.state.submissions.length,0);
 const bought=await f.gateway.buy(f.p,guard);assert.equal(bought.status,'COMPLETE');assert(BigInt(bought.acquiredRaw)>0n);assert(BigInt(bought.costRaw)>0n);Object.assign(f.p,bought,{halfRaw:(BigInt(bought.acquiredRaw)/2n).toString(),sellIntentId:randomUUID()});
 assert.equal(f.state.submissions.filter(s=>s.kind==='buy').length,1);assert(BigInt((await f.gateway.exitQuote(f.p)).netBnbRaw)<BigInt(bought.costRaw));
 // Other buyers advance the deterministic curve; no external RPC or wallet exists.
 f.state.sold=VT/2n;f.state.reserve=475292n*U;assert(BigInt((await f.gateway.exitQuote(f.p)).netBnbRaw)>=BigInt(bought.costRaw));
 const sold=await f.gateway.sell(f.p,guard);assert.equal(sold.status,'COMPLETE');assert.equal(sold.halfSold,true);assert.equal(f.state.base,BigInt(bought.acquiredRaw)-BigInt(f.p.halfRaw));assert.equal(f.state.submissions.filter(s=>s.kind==='sell').length,1);assert(f.state.submissions.some(s=>s.kind==='convert'));
 const readback=await f.gateway.recover(f.p);assert.equal(readback.halfSold,true);assert.equal(f.state.submissions.filter(s=>s.kind==='sell').length,1);
});
test('Gang strategy rechecks its cap before funding and rejects inventory changes before selling',async t=>{
 const f=await fixture(t);f.p.config={...config,perTokenMaxBnb:'0.001'};const result=await f.gateway.buy(f.p,guard);assert.equal(result.status,'FAILED');assert.equal(f.state.submissions.length,0);
 f.p.config=config;f.p.buyIntentId=randomUUID();const bought=await f.gateway.buy(f.p,guard);assert.equal(bought.status,'COMPLETE');Object.assign(f.p,bought,{halfRaw:(BigInt(bought.acquiredRaw)/2n).toString()});f.state.base-=1n;await assert.rejects(f.gateway.exitQuote(f.p),{code:'GANG_POSITION_CHANGED'});
});
test('Gang strategy settlement valuation respects non-18 decimals and rejects mismatched or malformed quotes',async()=>{
 let output={fromCoinAmount:'12.345678',toCoinAmount:'0.002'};const gateway=createGangLaunchGateway({trader:{},reader:{rpc(){}},cli:{quoteSwap:async()=>output}});
 assert.equal(await gateway.toBnb({address:settlement,decimals:6},12345678n,'100'),2000000000000000n);
 output={fromCoinAmount:'12.345679',toCoinAmount:'0.002'};await assert.rejects(gateway.toBnb({address:settlement,decimals:6},12345678n,'100'),{code:'SWAP_QUOTE_INVALID'});
 output={fromCoinAmount:'12.345678',toCoinAmount:'Infinity'};await assert.rejects(gateway.toBnb({address:settlement,decimals:6},12345678n,'100'),{code:'SWAP_QUOTE_INVALID'});
});
test('simulation keeps the current curve invariant coherent as other buyers move price, without ledger transactions',async t=>{const f=await fixture(t);Object.assign(f.p,{mode:'simulate',acquiredRaw:f.p.expectedRaw,halfRaw:(BigInt(f.p.expectedRaw)/2n).toString()});assert(BigInt((await f.gateway.exitQuote(f.p)).netBnbRaw)<BigInt(f.p.costRaw));f.state.sold=VT/2n;f.state.reserve=475292n*U;assert(BigInt((await f.gateway.exitQuote(f.p)).netBnbRaw)>=BigInt(f.p.costRaw));assert.equal(f.state.submissions.length,0);});
test('receipt cost uses the actual funding fill for new quote and values only the consumed prior quote balance',async()=>{const manager='0x'+'3'.repeat(40),quote={address:settlement,decimals:0},p={config,manager,tokenAddress:token,quote,wallet,decimals:0,amountRaw:'10000',buyIntentId:randomUUID()};
 const op={wallet,market:token,status:'COMPLETE',receivedAmount:'10000',spentRaw:'1000',steps:[{action:'panelFund',status:'CONFIRMED',actualQuoteRaw:'800',actualNativeInputRaw:'160',plan:{quote,funding:{available:'200'}}},{action:'panelBuy',status:'CONFIRMED',strategyCostRaw:'100',plan:{quote,amountRaw:'10000',manager,spendRaw:'1000'}}]};
 const gateway=createGangLaunchGateway({reader:{rpc(){}},cli:{},trader:{startStrategy:async()=>{},drain:async()=>{},strategyOperation:async()=>op}});assert.equal((await gateway.buy(p,guard)).costRaw,'180');
});
test('a partially completed later conversion does not mark the confirmed exact half sale as unsold',async()=>{const p={wallet,tokenAddress:token,halfRaw:'500',sellIntentId:randomUUID()},op={wallet,market:token,status:'COMPLETE',partial:true,steps:[{action:'panelSell',status:'CONFIRMED',plan:{protocol:'gang-curve',amountRaw:'500'}}]};const g=createGangLaunchGateway({reader:{rpc(){}},cli:{},trader:{strategyOperation:async()=>op}});const r=await g.recover(p);assert.equal(r.halfSold,true);assert.equal(r.status,'PARTIAL_CONVERSION');});
