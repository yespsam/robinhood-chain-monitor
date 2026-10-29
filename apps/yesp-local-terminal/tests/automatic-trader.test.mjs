import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAutomaticTrader} from '../server/automatic-trader.mjs';
import {validateAutomatic} from '../server/automatic-policy.mjs';
import {createFourTrader} from '../server/four-trader.mjs';
import {FlapJournal} from '../server/flap-journal.mjs';
import {NATIVE} from '../server/model.mjs';
import {ZERO} from '../server/four-reader.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0'),token=addr(1),wallet=addr(2),quote=addr(3),manager=addr(4),U=10n**18n;
const request=(action='buy')=>({profile:'unified',tokenAddress:token,wallet,action,amount:'3',slippageBps:'100',swapSlippageBps:'100',...(action==='buy'?{maxBnb:'0.1'}:{}),intentId:randomUUID()});
function plan(kind,action='buy'){const p={chainId:'56',protocol:'flap-standard',tokenAddress:token,wallet,manager,kind,action,amount:'3',amountRaw:(3n*U).toString(),spendRaw:(100n*U).toString(),slippageBps:'100',base:{symbol:'T',decimals:18},quote:{address:quote,symbol:'QUOTE',decimals:18},nonce:'0x1',expiresAt:Date.now()+60000,tx:{from:wallet,to:manager,inputData:'0x12345678',value:'0x0'}};
 if(kind==='approve'||kind==='revoke'){p.kind='approve';p.approvalToken=quote;p.approvalRaw=kind==='revoke'?'0':(100n*U).toString();}
 if(kind==='fund'){delete p.tx;p.trade={chainId:'56',fromToken:NATIVE,toToken:quote,amount:'0.01',slippage:'1'};p.funding={required:'100'};p.resumeRequest={tokenAddress:token};}
 if(kind==='convert'){delete p.tx;p.conversionMode='swap';p.amount='5';p.amountRaw=(5n*U).toString();p.trade={chainId:'56',fromToken:quote,toToken:NATIVE,amount:'5',slippage:'1'};}
 return p;
}
async function fixture(t,kinds=['fund','approve','buy']){const dir=await mkdtemp(join(tmpdir(),'automatic-'));t.after(()=>rm(dir,{recursive:true,force:true}));const journal=new FlapJournal(dir),sent=[],prepared=[],events=[];let i=0,state={unknown:false,highPrice:false,risk:false,hold:null};
 const engine=createAutomaticTrader({journal,allowWrites:true,onProgress:e=>events.push(e),prepare:async(p,w,execution)=>{prepared.push({...p,execution});if(state.hold)await state.hold;const q=plan(kinds[i++],p.action);if(state.protocol)q.protocol=state.protocol;if(state.highPrice&&q.kind==='buy')q.spendRaw=(200n*U).toString();if(state.risk)q.official={risks:{riskDetails:['risk']}};return {preview:q};},submit:async h=>{sent.push(h.preview.kind);return state.unknown?{outcome:'UNKNOWN'}:{outcome:'SUBMITTED',data:{txHash:hash(sent.length)}};},
  reconcile:async op=>{op.status='COMPLETE';op.steps[0].status='CONFIRMED';op.steps[0].txHash??=hash(1);op.steps[0].blockNumber='0x100';op.steps[0].gasRaw='100';op.receivedAmount=op.steps[0].action==='panelSell'?'5':op.steps[0].action==='panelConvert'?'0.02':'3';op.message='confirmed';return op;},conversion:async sale=>{assert.equal(sale.receivedAmount,'5');return {preview:plan('convert','sell')};}});
 return {engine,journal,sent,prepared,state,events};
}
test('one buy request sequences funding, exact approval and purchase once under one durable wallet lock',async t=>{
 const f=await fixture(t),p=request();const accepted=await f.engine.start(p);assert.equal(accepted.operation.status,'SUBMITTING');await f.engine.drain();assert.deepEqual(f.sent,['fund','approve','buy']);const op=await f.journal.read(p.intentId);assert.equal(op.status,'COMPLETE');assert.equal(op.steps.length,3);assert(op.firstSubmittedAt>=op.createdAt);assert(op.completedAt>=op.firstSubmittedAt);
 await f.engine.start(p);await f.engine.drain();assert.equal(f.sent.length,3);assert(f.events.length>3);
});
test('sell converts only the confirmed proceeds and freezes percentage quantity after the first preview',async t=>{
 const f=await fixture(t,['approve','sell']),p=request('sell');delete p.amount;p.sellPercent='50';await f.engine.start(p);await f.engine.drain();assert.deepEqual(f.sent,['approve','sell','convert']);assert.equal(f.prepared[0].sellPercent,'50');assert.equal(f.prepared[1].amount,'3');assert.equal(f.prepared[1].sellPercent,undefined);const op=await f.journal.read(p.intentId);assert.equal(op.status,'COMPLETE');assert.equal(op.receivedAmount,'0.02');
});
test('duplicate clicks and a second process cannot interleave while an automatic trade holds the lock',async t=>{
 const f=await fixture(t,['buy']);let release;f.state.hold=new Promise(r=>release=r);const p=request();await f.engine.start(p);await assert.rejects(()=>f.engine.start(request()),{code:'WALLET_BUSY'});await assert.rejects(()=>f.journal.exclusive(async()=>{}),{code:'UNRESOLVED_TRADE_LOCK'});release();await f.engine.drain();assert.deepEqual(f.sent,['buy']);
});
test('a lost submission response is durable and blocks the next trade without resending',async t=>{
 const f=await fixture(t);f.state.unknown=true;await f.engine.start(request());await f.engine.drain();assert.deepEqual(f.sent,['fund']);assert.equal((await f.journal.all())[0].status,'UNKNOWN');await assert.rejects(()=>f.engine.start(request()),{code:'UNRESOLVED_TRADE_EXISTS'});assert.equal(f.sent.length,1);
});
test('a price jump after funding stops before the target buy; no automatic second funding',async t=>{
 const f=await fixture(t,['fund','buy']);f.state.highPrice=true;const p=request();await f.engine.start(p);await f.engine.drain();assert.deepEqual(f.sent,['fund']);assert.equal((await f.journal.read(p.intentId)).error.code,'AUTO_PRICE_CHANGED');
 const g=await fixture(t,['fund','fund']);await g.engine.start(request());await g.engine.drain();assert.deepEqual(g.sent,['fund']);assert.equal((await g.journal.all())[0].error.code,'AUTO_FUNDING_SHORTFALL');
});
test('Gang output-price diagnostic survives a stopped flow without another submission or raw error data',async t=>{
 const f=await fixture(t),p=request();delete p.maxBnb;p.fundingMode='quantity';
 const price={amount:'3',expected:'2.9',minimum:'2.97',spend:'100',symbol:'T',quoteSymbol:'QUOTE',slippageBps:'100'};
 const engine=createAutomaticTrader({journal:f.journal,allowWrites:true,prepare:async()=>{if(f.sent.length)throw Object.assign(Error('not public'),{code:'AUTO_PRICE_CHANGED',details:{price:{...price,stderr:'secret'}}});return {preview:plan('fund')};},submit:async()=>{f.sent.push('fund');return {outcome:'SUBMITTED',data:{txHash:hash(1)}};},reconcile:async op=>{op.status='COMPLETE';Object.assign(op.steps[0],{status:'CONFIRMED',txHash:hash(1),blockNumber:'0x100',gasRaw:'1'});return op;}});
 await engine.start(p);await engine.drain();const op=await f.journal.read(p.intentId);assert.equal(op.status,'FAILED');assert.deepEqual(op.error.price,price);assert.deepEqual(f.sent,['fund']);assert.match(op.message,/2.97/);assert.doesNotMatch(op.message,/secret|not public/);
});
test('new preview risk details stop the automatic path without sending anything',async t=>{
 const f=await fixture(t,['buy']);f.state.risk=true;await f.engine.start(request());await f.engine.drain();assert.equal(f.sent.length,0);assert.equal((await f.journal.all())[0].error.code,'AUTO_RISK_REVIEW_REQUIRED');
});
for(const pending of [false,true])test(`the shared trader completes a verified direct BNB buy (phone confirmation: ${pending})`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'auto-integration-'));t.after(()=>rm(dir,{recursive:true,force:true}));const journal=new FlapJournal(dir);let writes=0;
 const p={...plan('buy'),quote:{address:ZERO,symbol:'BNB',decimals:18},spendRaw:(U/100n).toString(),spend:'0.01',tx:{from:wallet,to:manager,inputData:'0x12345678',value:'0x2386f26fc10000'}};
 const rpc=async(method,args)=>{if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber')return '0x103';if(method==='eth_getBlockByNumber')return {hash:hash(9)};if(method==='eth_getTransactionByHash')return {hash:hash(8),from:wallet,to:manager,input:p.tx.inputData,value:p.tx.value,nonce:'0x1',blockHash:hash(9)};if(method==='eth_getTransactionReceipt')return {transactionHash:hash(8),from:wallet,to:manager,blockHash:hash(9),blockNumber:'0x100',status:'0x1',gasUsed:'0x1',effectiveGasPrice:'0x1',logs:[]};throw Error(method);};
 const reader={rpc,build:async()=>structuredClone(p),recheck:async()=>{},receipt:()=>({receivedAmount:'3',message:'verified'})};
 const cli={status:async()=>({status:'CONNECTED'}),addresses:async()=>({addresses:[{binanceChainId:'56',address:wallet}]}),settings:async()=>({devMode:{enabled:true}}),txLock:async()=>({status:'UNLOCKED'}),previewContract:async()=>({outcome:'PREVIEWED',data:{requestId:'r',expiresAt:Date.now()+60000,parsedTx:{contractAddress:manager},simulationResult:{simulationCode:'000000000',balanceChanges:[],allowanceChanges:[],authorityChanges:[]},risks:{riskDetails:[],riskBehaviors:[],addresses:{}}}}),executePreview:async()=>{writes++;return {outcome:'SUBMITTED',data:{txHash:hash(8)}};}};
 if(pending){cli.executePreview=async()=>{writes++;return {outcome:'PENDING_CONFIRMATION',data:{orderId:'phone-1'}};};cli.recentTransactions=async()=>[hash(8)];}
 const trader=createFourTrader({cli,reader,journal,panel:true,allowWrites:true}),r=request();await trader.handle('panelTrade',r);await trader.drain();const op=await journal.read(r.intentId);assert.equal(op.status,'COMPLETE');assert.equal(op.receivedAmount,'3');assert.equal(writes,1);
});

test('restart reconciles stored final receipts and never resumes an intermediate confirmed step',async t=>{
 for(const kind of ['fund','buy']){const f=await fixture(t),p=request(),now=Date.now(),prepared=plan(kind);
  const op={intentId:p.intentId,action:'panelAutoBuy',market:token,wallet,request:p,status:'SUBMITTED',createdAt:now,deadlineAt:now+180000,lastReceivedAmount:'3',steps:[{action:kind==='fund'?'panelFund':'panelBuy',status:'CONFIRMED',startedAt:now,plan:prepared,...(prepared.tx?{tx:prepared.tx}:{trade:prepared.trade}),txHash:hash(1),blockNumber:'0x100',gasRaw:'1'}]};
  await f.journal.save(op,{create:true});await f.engine.recover(op);const saved=await f.journal.read(p.intentId);
  assert.equal(saved.status,kind==='buy'?'COMPLETE':'FAILED');assert.equal(f.sent.length,0);assert.equal(f.prepared.length,0);
 }
});

test('quantity intent survives journal validation, funds and buys once, and freezes its target',async t=>{
 const f=await fixture(t),p=request();delete p.maxBnb;p.fundingMode='quantity';await f.engine.start(p);await f.engine.drain();
 assert.deepEqual(f.sent,['fund','approve','buy']);assert(f.prepared.every(x=>x.funding.mode==='quantity'&&x.funding.maxBnb===undefined&&x.amount==='3'));const op=await f.journal.read(p.intentId);assert.equal(op.status,'COMPLETE');assert.equal(op.request.fundingMode,'quantity');
 await f.engine.start(p);await f.engine.drain();assert.equal(f.sent.length,3);
});
test('quantity buy retains price-jump and no-second-funding guards',async t=>{
 for(const kinds of [['fund','buy'],['fund','fund']]){const f=await fixture(t,kinds),p=request();delete p.maxBnb;p.fundingMode='quantity';f.state.highPrice=true;await f.engine.start(p);await f.engine.drain();assert.deepEqual(f.sent,['fund']);assert.equal((await f.journal.read(p.intentId)).error.code,kinds[1]==='buy'?'AUTO_PRICE_CHANGED':'AUTO_FUNDING_SHORTFALL');}
});
test('one quantity intent can fund, clear old allowance, approve the required amount, and buy exactly once',async t=>{
 const f=await fixture(t,['fund','revoke','approve','buy']),p=request();delete p.maxBnb;p.fundingMode='quantity';await f.engine.start(p);await f.engine.drain();
 assert.deepEqual(f.sent,['fund','approve','approve','buy']);const op=await f.journal.read(p.intentId);assert.equal(op.status,'COMPLETE');assert.equal(op.steps[1].plan.approvalRaw,'0');assert.equal(op.steps[2].plan.approvalRaw,(100n*U).toString());assert.equal(op.steps[3].plan.amount,'3');
});
test('automatic quantity mode rejects mixed, missing, unknown, and sell funding modes',()=>{
 const p=request();delete p.maxBnb;assert.throws(()=>validateAutomatic(p));assert.doesNotThrow(()=>validateAutomatic({...p,fundingMode:'quantity'}));
 for(const q of [{...p,fundingMode:'quantity',maxBnb:'1'},{...p,fundingMode:'balance'},{...request('sell'),fundingMode:'quantity'}])assert.throws(()=>validateAutomatic(q),{code:'INVALID_REQUEST'});
 assert.doesNotThrow(()=>validateAutomatic(request()));
});

test('Gang carries a frozen settlement spend through funding, revoke, approval and buy',async t=>{
 const f=await fixture(t,['fund','revoke','approve','buy']),p=request();delete p.maxBnb;p.fundingMode='quantity';f.state.protocol='gang-curve';await f.engine.start(p);await f.engine.drain();
 const op=await f.journal.read(p.intentId);assert.equal(op.status,'COMPLETE');assert.deepEqual(f.sent,['fund','approve','approve','buy']);assert.equal(f.prepared[0].execution,undefined);
 for(const r of f.prepared.slice(1)){assert.equal(r.execution.spendRaw,(100n*U).toString());assert.equal(r.execution.protocol,'gang-curve');assert.equal(r.execution.quote,quote);assert.equal(r.execution.manager,manager);assert.equal(r.amount,'3');}
});
