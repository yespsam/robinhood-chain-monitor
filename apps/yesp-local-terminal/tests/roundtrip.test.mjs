import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseUnits} from 'ethers';
import {createRoundtripLedger,U,token,wallet} from './helpers/roundtrip-ledger.mjs';
async function fixture(t,options={}){const dir=await mkdtemp(join(tmpdir(),'yesp-roundtrip-'));t.after(()=>rm(dir,{recursive:true,force:true}));return createRoundtripLedger(dir,options);}
for(const phone of [false,true])test(`continuous ledger: BNB -> GANG -> revoke -> approve -> buy -> revoke -> sell -> BNB (phone ${phone})`,async t=>{
 const f=await fixture(t,{phone,oldAllowance:true,roundFunding:true,moveAfterFunding:100}),before=f.state.native,buy=await f.trade('buy');
 assert.equal(buy.status,'COMPLETE',JSON.stringify(buy.error));assert.deepEqual(f.state.submissions.map(x=>x.kind),['fund','revoke','approve','buy']);assert(f.state.base>=9000000n*U&&f.state.base<=10000000n*U);assert.equal(parseUnits(buy.receivedAmount,18),f.state.base);
 assert.equal(buy.steps[0].inputRoundingRaw,'1');const input=buy.steps[0].plan.funding.required;assert(buy.steps.slice(1).every(s=>s.plan.spendRaw===parseUnits(input,18).toString()));assert.equal(buy.steps.at(-1).plan.minimumRaw,(9000000n*U).toString());
 assert(before-f.state.native>U/10n);assert(before-f.state.native<U);const leftover=f.state.quote,owned=f.state.base,sell=await f.trade('sell');
 assert.equal(sell.status,'COMPLETE',JSON.stringify(sell.error));assert.deepEqual(f.state.submissions.map(x=>x.kind),['fund','revoke','approve','buy','revoke','approve','sell','convert']);assert.equal(f.state.base,0n);assert.equal(f.state.quote,leftover);assert(parseUnits(sell.receivedAmount,18)>0n);
 assert.equal(sell.steps.find(s=>s.action==='panelSell').plan.amountRaw,owned.toString());assert.equal(sell.steps.at(-1).trade.amount,sell.saleReceivedAmount);
 for(const s of [...buy.steps,...sell.steps]){assert(s.prepareMs>=0);assert(s.submittedAt>=s.startedAt);assert(s.confirmedAt>=s.submittedAt);}
 const count=f.state.submissions.length;await f.trader.handle('panelTrade',f.state.requests[0]);await f.trader.drain();assert.equal(f.state.submissions.length,count);assert.equal((await f.journal.all()).length,2);
});
test('existing settlement balance is used first; sell converts only new proceeds, never the leftover',async t=>{
 const f=await fixture(t,{heldQuote:10000n*U}),buy=await f.trade('buy');assert.equal(buy.status,'COMPLETE',JSON.stringify(buy.error));assert(!f.state.submissions.some(x=>x.kind==='fund'));const leftover=f.state.quote;assert(leftover>0n);
 const sale=await f.trade('sell');assert.equal(sale.status,'COMPLETE',JSON.stringify(sale.error));assert.equal(f.state.quote,leftover);assert.equal(f.state.submissions.filter(x=>x.kind==='convert').length,1);
});
test('continuous WBNB route wraps the deficit, buys and sells, then unwraps exactly the proceeds',async t=>{
 const f=await fixture(t,{wrapped:true,phone:true,oldAllowance:true}),buy=await f.trade('buy');assert.equal(buy.status,'COMPLETE',JSON.stringify(buy.error));assert.equal(buy.steps[0].plan.kind,'wrap');const leftover=f.state.quote;
 const sale=await f.trade('sell');assert.equal(sale.status,'COMPLETE',JSON.stringify(sale.error));assert.equal(sale.steps.at(-1).plan.conversionMode,'unwrap');assert.equal(f.state.base,0n);assert.equal(f.state.quote,leftover);assert.equal(f.state.quotes.length,0);assert.equal(f.state.submissions.filter(x=>x.kind==='unwrap').length,1);
});
test('a move beyond original slippage stops after funding, with no extra swap or automatic retry',async t=>{
 const f=await fixture(t,{moveAfterFunding:5}),op=await f.trade('buy');assert.equal(op.status,'FAILED');assert.equal(op.error.code,'AUTO_PRICE_CHANGED');assert.deepEqual(f.state.submissions.map(x=>x.kind),['fund']);assert.equal(f.state.base,0n);assert(f.state.quote>0n);
 const request=f.state.requests[0];await f.trader.handle('panelTrade',request);await f.trader.drain();assert.equal(f.state.submissions.length,1);
});
test('BNB shortage and preview risk both stop before any simulated financial submission',async t=>{
 for(const [options,code]of [[{native:U/100n},'FUNDING_BALANCE_INSUFFICIENT'],[{heldQuote:10000n*U,risk:true},'AUTO_RISK_REVIEW_REQUIRED']]){const f=await fixture(t,options),op=await f.trade('buy');assert.equal(op.status,'FAILED');assert.equal(op.error.code,code);assert.equal(f.state.submissions.length,0);assert.equal(f.state.base,0n);}
});
test('failed conversion leaves sale proceeds and original quote balance intact and is never replayed',async t=>{
 const f=await fixture(t,{conversionFails:true,heldQuote:10000n*U});assert.equal((await f.trade('buy')).status,'COMPLETE');const leftover=f.state.quote,sale=await f.trade('sell');
 assert.equal(sale.status,'FAILED');assert.equal(sale.error.code,'AUTO_CONVERSION_FAILED');assert.equal(f.state.base,0n);assert.equal(f.state.quote,leftover+parseUnits(sale.saleReceivedAmount,18));assert(f.state.conversionFailed);const count=f.state.submissions.length;await f.trader.handle('panelStatus',{profile:'unified'});assert.equal(f.state.submissions.length,count);
});
