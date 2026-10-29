import test from 'node:test';
import assert from 'node:assert/strict';
import {safeBudget,budgetMessage,safePriceChange,automaticFailureMessage} from '../extension/funding-model.js';
const facts={kind:'fund',maxBnb:'0.1',amount:'10000000.0',tokenSymbol:'AGC',symbol:'GANG',needed:'11876.919269596787461133',expected:'9205.735760219014041843',minimum:'8285.162184197112637658'};
test('public budget facts strip unrelated data and reject malformed numbers and symbols',()=>{
 assert.deepEqual(safeBudget({...facts,apiKey:'not-a-real-secret',stderr:'untrusted'}),facts);
 for(const altered of [{needed:'1e10'},{maxBnb:'Infinity'},{amount:100},{symbol:'GANG\nunsafe'},{kind:'unknown'}])assert.equal(safeBudget({...facts,...altered}),null);
 assert.match(budgetMessage(facts),/11,876.919269/);assert.match(budgetMessage(facts),/9,205.73576/);assert.match(budgetMessage(facts),/8,285.162184/);
});
test('messages distinguish no submission from already completed funding',()=>{
 const op={status:'FAILED',error:{code:'FUNDING_BUDGET_EXCEEDED',budget:facts},steps:[]};assert.match(automaticFailureMessage(op),/未提交兑换/);
 assert.doesNotMatch(automaticFailureMessage({...op,steps:[{status:'CONFIRMED'}]}),/未提交兑换/);assert.match(automaticFailureMessage({...op,steps:[{status:'CONFIRMED'}]}),/已执行步骤保留/);
});
test('price failure reports original minimum and separates trading slippage from funding slippage',()=>{
 const price={amount:'10000000',expected:'9800000',minimum:'9900000',spend:'0.17',symbol:'BOND',quoteSymbol:'WBNB',slippageBps:'100'};
 assert.deepEqual(safePriceChange({...price,apiKey:'ignored',stderr:'ignored'}),price);assert.equal(safePriceChange({...price,expected:'NaN'}),null);assert.equal(safePriceChange({...price,symbol:'bad\nname'}),null);
 const op={status:'FAILED',error:{code:'AUTO_PRICE_CHANGED',price},request:{slippageBps:'100',swapSlippageBps:'1000'},steps:[{action:'panelWrap',status:'CONFIRMED'}]};
 const msg=automaticFailureMessage(op);for(const part of ['9,800,000','9,900,000','买入滑点 1%','兑换滑点 10%','结算币保留在钱包','尚未买入','不会自动重发'])assert(msg.includes(part),part);
 const legacy=automaticFailureMessage({...op,error:{code:'AUTO_PRICE_CHANGED'}});assert.match(legacy,/买入滑点 1%/);assert.match(legacy,/兑换滑点 10%/);assert.doesNotMatch(legacy,/9,800,000/);
});
