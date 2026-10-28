import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseUnits,formatUnits} from 'ethers';
import {createFourTrader} from '../server/four-trader.mjs';
import {FlapJournal} from '../server/flap-journal.mjs';
import {createReadScopeRpc} from '../server/read-scope.mjs';
import {fault} from '../server/flap-reader.mjs';
import {erc20Abi} from '../server/four-reader.mjs';
import {validatePanelParams} from '../extension/trade-policy.js';
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0'),token=addr(1),wallet=addr(2),manager=addr(3),quote=addr(4),U=10n**18n;
const params={profile:'unified',tokenAddress:token,action:'buy',amount:'100000',buyMode:'tokenAmount',slippageBps:'100',funding:{maxBnb:'0.1',slippageBps:'100'}};
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'panel-funding-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const state={held:100n*U,required:1000n*U,native:U,nonce:'0x1',valueDelta:0n,confirmed:false,orderStatus:'FINISHED',outcome:'SUBMITTED',badOrder:false,badReceipt:false,noRoute:false,tooExpensive:false,swapCount:0,previewCount:0,trade:null};
 const m={chainId:'56',protocol:'gang-curve',platform:'Gang',tokenAddress:token,manager,phase:1,variant:'v2',base:{symbol:'TEST',decimals:18},quote:{address:quote,symbol:'GANG',decimals:18},block:'0x100',supported:true};
 const rpc=createReadScopeRpc(async(method,p)=>{
  if(method==='eth_chainId')return '0x38';if(method==='eth_getBalance')return '0x'+state.native.toString(16);if(method==='eth_getTransactionCount')return state.nonce;
  if(method==='eth_getCode')return '0x60006000';if(method==='eth_getStorageAt')return hash(0);if(method==='eth_blockNumber')return '0x105';if(method==='eth_getBlockByNumber')return {number:p[0],hash:hash(7)};
  if(method==='eth_getTransactionByHash')return state.confirmed?{hash:hash(8),from:state.badReceipt?addr(99):wallet,to:addr(6),nonce:'0x1',value:'0x'+(parseUnits(state.trade.amount,18)+state.valueDelta).toString(16),blockHash:hash(7)}:null;
  if(method==='eth_getTransactionReceipt')return state.confirmed?{transactionHash:hash(8),from:wallet,to:addr(6),blockNumber:'0x102',blockHash:hash(7),status:'0x1',gasUsed:'0x186a0',effectiveGasPrice:'0x3b9aca00',logs:[{address:quote,...erc20Abi.encodeEventLog(erc20Abi.getEvent('Transfer'),[addr(6),wallet,parseUnits(state.trade.amount,18)*100000n])}]}:null;
  throw Error(method);
 });
 const reader={rpc,inspect:async()=>m,holdings:async()=>({base:'0',quote:formatUnits(state.held,18),native:formatUnits(state.native,18)}),build:async(p,w)=>{if(state.held<state.required)throw fault('INSUFFICIENT_BALANCE',{funding:{assetAddress:quote,symbol:'GANG',required:formatUnits(state.required,18),available:formatUnits(state.held,18),shortfall:formatUnits(state.required-state.held,18)}});return {...m,kind:'buy',action:'buy',wallet:w,tx:{to:manager}};}};
 const cli={status:async()=>({status:'CONNECTED'}),addresses:async()=>({addresses:[{binanceChainId:'56',address:wallet}]}),settings:async()=>({devMode:{enabled:true}}),txLock:async()=>({status:'UNLOCKED'}),
  quoteSwap:async trade=>{if(state.noRoute)throw fault('NO_LIQUIDITY');return {fromCoinAmount:trade.amount,toCoinAmount:formatUnits(parseUnits(trade.amount,18)*(state.tooExpensive?1n:100000n),18)};},
  executeSwap:async trade=>{state.swapCount++;state.trade=trade;return state.outcome==='UNKNOWN'?{outcome:'UNKNOWN'}:{outcome:state.outcome,data:{orderId:'order-1'}};},
  readOrder:async()=>({list:[{orderId:'order-1',chain:'56',fromToken:state.trade.fromToken,toToken:state.badOrder?addr(99):quote,fromTokenQty:state.trade.amount,status:state.orderStatus,txHash:hash(8)}]}),
  previewContract:async()=>{state.previewCount++;throw Error('funding must not preview target before funded');},executePreview:async()=>{throw Error('must not buy');}};
 const journal=new FlapJournal(dir),create=()=>createFourTrader({reader,cli,journal,panel:true,allowWrites:true}),trader=create();
 return {state,m,journal,create,trader,prepare:async(p={})=>(await trader.handle('panelPrepare',{...params,...p})).tradePreview,send:p=>trader.handle('panelExecute',{profile:'unified',previewId:p.previewId,intentId:randomUUID()})};
}
test('BNB funding previews only the deficit, separate slippage and budget; no swap or buy before confirmation',async t=>{
 const f=await fixture(t),p=await f.prepare();assert.equal(p.kind,'fund');assert.equal(p.funding.shortfall,'900.0');assert.equal(p.quote.address,quote);assert(BigInt(p.minimumRaw)>=900n*U);assert(parseUnits(p.spend,18)<=parseUnits('0.1',18));assert.equal(p.trade.slippage,'1');assert.equal(f.state.swapCount,0);assert.equal(f.state.previewCount,0);
 await f.send(p);assert.equal(f.state.swapCount,1);await assert.rejects(()=>f.send(p),{code:'PREVIEW_EXPIRED'});assert.equal(f.state.swapCount,1);
 await assert.rejects(()=>f.prepare(),{code:'UNRESOLVED_TRADE_EXISTS'});
});
test('funding survives restart, verifies order and chain receipt, and never auto-buys on completion',async t=>{
 const f=await fixture(t),p=await f.prepare();await f.send(p);f.state.confirmed=true;
 const result=await f.create().handle('panelStatus',{profile:'unified'});assert.equal(result.operation.status,'COMPLETE');assert.equal(result.operation.steps[0].status,'CONFIRMED');assert.match(result.operation.message,/尚未购买/);assert.equal(f.state.swapCount,1);assert.equal(f.state.previewCount,0);
 assert.equal((await f.journal.all())[0].action,'panelFund');
});
test('budget, liquidity and changed funding needs stop before any submission',async t=>{
 const f=await fixture(t);await assert.rejects(()=>f.prepare({funding:{maxBnb:'0.000001',slippageBps:'100'}}),{code:'FUNDING_BUDGET_EXCEEDED'});
 f.state.noRoute=true;await assert.rejects(()=>f.prepare(),{code:'NO_LIQUIDITY'});f.state.noRoute=false;
 const p=await f.prepare();f.state.held=f.state.required;await assert.rejects(()=>f.send(p),{code:'FUNDING_NOT_REQUIRED'});assert.equal(f.state.swapCount,0);assert.equal((await f.journal.all()).length,0);
});
test('unknown swap outcome is never retried, and mismatching order cannot unlock another trade',async t=>{
 const f=await fixture(t);f.state.outcome='UNKNOWN';await f.send(await f.prepare());await assert.rejects(()=>f.prepare(),{code:'UNRESOLVED_TRADE_EXISTS'});assert.equal((await f.create().handle('panelStatus',{profile:'unified'})).operation.status,'UNKNOWN');assert.equal(f.state.swapCount,1);
 const g=await fixture(t);await g.send(await g.prepare());g.state.badOrder=true;const status=await g.trader.handle('panelStatus',{profile:'unified'});assert.equal(status.reconcileError.code,'SWAP_ORDER_MISMATCH');assert.equal(status.operation.status,'SUBMITTED');assert.equal(g.state.swapCount,1);
});
test('pending phone confirmation can reconcile and a mismatched wallet receipt stays unresolved',async t=>{
 const f=await fixture(t);f.state.outcome='PENDING_CONFIRMATION';await f.send(await f.prepare());f.state.confirmed=true;f.state.badReceipt=true;
 const r=await f.trader.handle('panelStatus',{profile:'unified'});assert.equal(r.operation.status,'PENDING_CONFIRMATION');assert.equal(r.reconcileError.code,'FUNDING_SETTLEMENT_MISMATCH');assert.equal(f.state.swapCount,1);
 f.state.badReceipt=false;assert.equal((await f.trader.handle('panelStatus',{profile:'unified'})).operation.status,'COMPLETE');
});
test('funding request is typed, positive, bounded and only valid on a quantity buy',()=>{
 assert.equal(validatePanelParams('panelPrepare',params),params);
 for(const f of [{maxBnb:'0',slippageBps:'100'},{maxBnb:'-1',slippageBps:'100'},{maxBnb:'1e9',slippageBps:'100'},{maxBnb:'0.1',slippageBps:'10000'},{maxBnb:'0.1',slippageBps:'100',to:addr(9)}])assert.throws(()=>validatePanelParams('panelPrepare',{...params,funding:f}));
 assert.throws(()=>validatePanelParams('panelPrepare',{...params,action:'sell'}));
});

test('budget failure reports actual capped quote facts and persists no submitted steps',async t=>{
 const f=await fixture(t);let failure;try{await f.prepare({funding:{maxBnb:'0.000001',slippageBps:'100'}});}catch(e){failure=e;}
 assert.equal(failure.code,'FUNDING_BUDGET_EXCEEDED');assert.equal(failure.details.budget.maxBnb,'0.000001');assert.equal(failure.details.budget.needed,'900.0');assert.equal(failure.details.budget.expected,'0.1');assert.equal(failure.details.budget.minimum,'0.099');assert.equal(f.state.swapCount,0);
 const intentId=randomUUID();await f.trader.handle('panelTrade',{profile:'unified',tokenAddress:token,wallet,intentId,action:'buy',amount:params.amount,slippageBps:'100',swapSlippageBps:'100',maxBnb:'0.000001'});await f.trader.drain();const op=await f.journal.read(intentId);
 assert.equal(op.status,'FAILED');assert.equal(op.steps.length,0);assert.equal(op.error.budget.expected,'0.1');assert.match(op.message,/未提交兑换、授权或买入/);assert.doesNotMatch(op.message,/已完成的步骤保留/);assert.equal(f.state.swapCount,0);
});
test('a small deficit scales the BNB probe down instead of unnecessarily swapping the whole probe amount',async t=>{
 const f=await fixture(t);f.state.held=f.state.required-U;const p=await f.prepare();assert(parseUnits(p.spend,18)<parseUnits('0.001',18));assert(BigInt(p.minimumRaw)>=U);assert(BigInt(p.minimumRaw)<U*102n/100n);assert.equal(f.state.swapCount,0);
});

test('finished native swap permits only a one-wei underpayment, preserving exact order, wallet and receipt verification',async t=>{
 const f=await fixture(t);await f.send(await f.prepare());f.state.confirmed=true;f.state.valueDelta=-1n;
 const r=await f.trader.handle('panelStatus',{profile:'unified'});assert.equal(r.operation.status,'COMPLETE');assert.equal(r.operation.steps[0].inputRoundingRaw,'1');assert.equal(r.operation.steps[0].actualNativeInputRaw,(parseUnits(f.state.trade.amount,18)-1n).toString());assert.equal(f.state.swapCount,1);
 for(const delta of [1n,-2n]){const g=await fixture(t);await g.send(await g.prepare());g.state.confirmed=true;g.state.valueDelta=delta;
  const rejected=await g.trader.handle('panelStatus',{profile:'unified'});assert.equal(rejected.reconcileError.code,'FUNDING_SETTLEMENT_MISMATCH');assert.notEqual(rejected.operation.status,'COMPLETE');assert.equal(g.state.swapCount,1);
 }
});

test('cached funding hash does not bypass rechecking the matching official order',async t=>{
 const f=await fixture(t);await f.send(await f.prepare());await f.trader.handle('panelStatus',{profile:'unified'});
 assert.equal((await f.journal.all())[0].steps[0].txHash,hash(8));f.state.confirmed=true;f.state.badOrder=true;
 const r=await f.trader.handle('panelStatus',{profile:'unified'});assert.equal(r.reconcileError.code,'SWAP_ORDER_MISMATCH');assert.notEqual(r.operation.status,'COMPLETE');
});

test('quantity funding sizes only the deficit above the former 0.1 BNB cap and rechecks without a budget field',async t=>{
 const f=await fixture(t);f.state.required=20000n*U;const p=await f.prepare({funding:{mode:'quantity',slippageBps:'100'}});
 assert.equal(p.fundingSettings.maxBnb,undefined);assert.equal(p.fundingSettings.mode,'quantity');assert.equal(p.funding.shortfall,'19900.0');assert(parseUnits(p.spend,18)>parseUnits('0.1',18));assert(parseUnits(p.spend,18)<parseUnits('0.21',18));assert(BigInt(p.minimumRaw)>=19900n*U);assert.equal(f.state.swapCount,0);
 await f.send(p);assert.equal(f.state.swapCount,1);f.state.confirmed=true;assert.equal((await f.trader.handle('panelStatus',{profile:'unified'})).operation.status,'COMPLETE');
});
test('quantity funding keeps gas reserve and reports wallet shortage without submitting',async t=>{
 const f=await fixture(t);f.state.required=20000n*U;f.state.native=parseUnits('0.1',18);
 await assert.rejects(()=>f.prepare({funding:{mode:'quantity',slippageBps:'100'}}),{code:'FUNDING_BALANCE_INSUFFICIENT'});assert.equal(f.state.swapCount,0);assert.equal((await f.journal.all()).length,0);
 f.state.native=U;f.state.held=f.state.required-U;const p=await f.prepare({funding:{mode:'quantity',slippageBps:'100'}});assert(parseUnits(p.spend,18)<parseUnits('0.00002',18));assert(BigInt(p.minimumRaw)>=U);assert(BigInt(p.minimumRaw)<U*102n/100n);
});
test('quantity funding mode is explicit and cannot be mixed with a legacy cap',()=>{
 assert.doesNotThrow(()=>validatePanelParams('panelPrepare',{...params,funding:{mode:'quantity',slippageBps:'100'}}));
 for(const funding of [{slippageBps:'100'},{mode:'balance',slippageBps:'100'},{mode:'quantity',maxBnb:'1',slippageBps:'100'},{mode:'quantity',slippageBps:'10000'}])assert.throws(()=>validatePanelParams('panelPrepare',{...params,funding}));
});

test('recovery unlocks an interrupted automatic buy after rounded funding receipt, without buying or funding again',async t=>{
 const f=await fixture(t),p=await f.prepare(),now=Date.now(),intentId=randomUUID();f.state.trade=p.trade;f.state.confirmed=true;f.state.valueDelta=-1n;
 await f.journal.save({intentId,action:'panelAutoBuy',market:token,wallet,status:'UNKNOWN',createdAt:now,deadlineAt:now+180000,error:{code:'FUNDING_SETTLEMENT_MISMATCH'},request:{profile:'unified',tokenAddress:token,wallet,action:'buy',amount:params.amount,slippageBps:params.slippageBps,swapSlippageBps:'100',maxBnb:'0.1',intentId},steps:[{action:'panelFund',status:'SUBMITTED',startedAt:now,plan:p,trade:p.trade,orderId:'order-1'}]},{create:true});
 const r=await f.create().handle('panelStatus',{profile:'unified'});assert.equal(r.operation.status,'FAILED');assert.equal(r.operation.steps[0].status,'CONFIRMED');assert.equal(r.operation.steps[0].inputRoundingRaw,'1');assert.match(r.operation.message,/兑换已核验到账/);assert.match(r.operation.message,/旧任务已结束/);assert.equal(f.state.swapCount,0);assert.equal(f.state.previewCount,0);
 const next=await f.prepare();assert.equal(next.kind,'fund');assert.equal(f.state.swapCount,0);
});
