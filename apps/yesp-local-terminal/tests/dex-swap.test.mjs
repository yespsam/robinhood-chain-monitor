import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseUnits,formatUnits} from 'ethers';
import {createFourTrader} from '../server/four-trader.mjs';
import {FlapJournal} from '../server/flap-journal.mjs';
import {externalMarket} from '../server/dex-swap.mjs';
import {createPanelRouter} from '../server/panel-router.mjs';
import {erc20Abi,ZERO} from '../server/four-reader.mjs';
import {NATIVE} from '../server/model.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0'),token=addr(1),wallet=addr(2),manager=addr(3),U=10n**18n;
const old={chainId:'56',protocol:'gang-curve',platform:'Gang',tokenAddress:token,manager,phase:3,variant:'soft',base:{symbol:'GANG',decimals:18},quote:{address:addr(4),symbol:'USD',decimals:18},block:'0x100',supported:false,blockers:['GANG_DEX_ROUTE_REQUIRED'],remainingRaw:'0',pool:addr(5)};
async function fixture(t,{generic=false}={}){const dir=await mkdtemp(join(tmpdir(),'dex-swap-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const state={held:10000n*U,native:U,nonce:'0x1',nonceDelta:0n,valueDelta:0n,confirmed:true,orderStatus:'FINISHED',outcome:'SUBMITTED',badOrder:false,badWallet:false,swapCount:0,quoteCount:0,refund:[],debit:null,receiptStatus:'0x1'};
 const m={...externalMarket(old),...(generic?{originProtocol:'generic-erc20',platform:'通用 Swap',manager:ZERO,phase:null,pool:undefined,routeStatus:'quote-required'}:{})};
 const rpc=async(method,p)=>{
  if(method==='eth_chainId')return '0x38';if(method==='eth_getBalance')return '0x'+state.native.toString(16);if(method==='eth_getTransactionCount')return state.nonce;
  if(method==='eth_getCode')return '0x60006000';if(method==='eth_getStorageAt')return hash(0);if(method==='eth_blockNumber')return '0x105';if(method==='eth_getBlockByNumber')return {number:p[0],hash:hash(7)};
  if(method==='eth_call')return erc20Abi.encodeFunctionResult('balanceOf',[state.held]);
  const buy=state.trade?.fromToken===NATIVE,input=state.trade?parseUnits(state.trade.amount,18):0n;
  if(method==='eth_getTransactionByHash')return state.confirmed?{hash:hash(8),from:state.badWallet?addr(99):wallet,to:addr(6),nonce:'0x'+(1n+state.nonceDelta).toString(16),value:'0x'+((buy?input:0n)+state.valueDelta).toString(16),blockHash:hash(7)}:null;
  if(method==='eth_getTransactionReceipt')return state.confirmed?{transactionHash:hash(8),from:wallet,to:addr(6),blockNumber:'0x102',blockHash:hash(7),status:state.receiptStatus,gasUsed:'0x186a0',effectiveGasPrice:'0x3b9aca00',logs:[{address:token,...erc20Abi.encodeEventLog(erc20Abi.getEvent('Transfer'),buy?[addr(6),wallet,input*100000n]:[wallet,addr(6),state.debit??input])}]}:null;
  throw Error(method);
 };
 const reader={rpc,inspect:async()=>m,holdings:async()=>({base:formatUnits(state.held,18),quote:formatUnits(state.native,18)}),build:async()=>{throw Error('must not use graduated curve');}};
 const cli={status:async()=>({status:'CONNECTED'}),addresses:async()=>({addresses:[{binanceChainId:'56',address:wallet}]}),settings:async()=>({devMode:{enabled:true}}),txLock:async()=>({status:'UNLOCKED'}),
  quoteSwap:async trade=>{state.quoteCount++;if(state.noRoute)throw Object.assign(Error(),{code:'NO_LIQUIDITY'});return {fromCoinAmount:trade.amount,toCoinAmount:formatUnits(parseUnits(trade.amount,18)*(trade.fromToken===NATIVE?100000n:1n)/(trade.fromToken===NATIVE?1n:100000n),18)};},
  executeSwap:async trade=>{state.swapCount++;state.trade=trade;return state.outcome==='UNKNOWN'?{outcome:'UNKNOWN'}:{outcome:state.outcome,data:{orderId:'order-dex'}};},
  readOrder:async()=>({list:[{orderId:'order-dex',chain:'56',fromToken:state.trade.fromToken,toToken:state.badOrder?addr(99):state.trade.toToken,fromTokenQty:state.trade.amount,toTokenActualQty:'0.1',status:state.orderStatus,txHash:hash(8),refund:state.refund}]}),
  previewContract:async()=>{throw Error('DEX is a market order');},executePreview:async()=>{throw Error('must not call curve');}};
 const journal=new FlapJournal(dir),create=()=>createFourTrader({reader,cli,journal,panel:true,allowWrites:true}),trader=create();
 const params={profile:'unified',tokenAddress:token,action:'sell',amount:'9701.171590889243780517',slippageBps:'200'};
 return {state,m,rpc,journal,trader,create,params,prepare:async(p={})=>(await trader.handle('panelPrepare',{...params,...p})).tradePreview,send:p=>trader.handle('panelExecute',{profile:'unified',previewId:p.previewId,intentId:randomUUID()}),status:()=>trader.handle('panelStatus',{profile:'unified'})};
}
test('graduated Gang/Four/Flap use DEX; active curves, migration-in-progress and unknown blockers stay unchanged',()=>{
 for(const m of [old,{...old,protocol:'flap-standard',phase:4,blockers:['FLAP_DEX_ROUTE_REQUIRED']},{...old,protocol:'openfour-agent',phase:'3',blockers:['FOUR_MIGRATED']},{...old,protocol:undefined,liquidityAdded:true,blockers:['FOUR_MIGRATED']}]){const d=externalMarket(m);assert.equal(d.protocol,'dex-swap');assert.equal(d.quote.address,ZERO);assert(d.supported);}
 for(const m of [{...old,phase:1,supported:true,blockers:[]},{...old,protocol:'openfour-agent',phase:'2',blockers:['FOUR_MIGRATED']},{...old,blockers:['GANG_DEX_ROUTE_REQUIRED','UNKNOWN_MODE']}])assert.equal(externalMarket(m),m);
});
test('router reports real external balances without calling inner-curve quota or eligibility',async t=>{
 const f=await fixture(t),missing=code=>({inspect:async()=>{throw Object.assign(Error(),{code});}}),gang={inspect:async()=>old,holdings:async()=>{throw Error('no curve holdings');}};
 const router=createPanelRouter({rpc:f.rpc,readers:{agent:missing('NOT_FLAP_AGENT'),standard:missing('NOT_FLAP_TOKEN'),four:missing('NOT_FOUR_TOKEN'),gang}}),m=await router.inspect(token),h=await router.holdings(m,wallet);
 assert.equal(m.protocol,'dex-swap');assert.equal(h.base,'10000.0');assert.equal(h.quote,'1.0');assert.equal(h.buyableTokenAmount,undefined);
});
test('direct GANG sell preview is read-only and exactly one swap settles to BNB; survives restart',async t=>{
 const f=await fixture(t),p=await f.prepare();assert.equal(p.kind,'sell');assert.equal(p.trade.fromToken,token);assert.equal(p.trade.toToken,NATIVE);assert.equal(p.trade.amount,f.params.amount);assert.equal(p.trade.slippage,'2');assert.equal(f.state.swapCount,0);
 await f.send(p);await assert.rejects(()=>f.send(p),{code:'PREVIEW_EXPIRED'});const r=await f.create().handle('panelStatus',{profile:'unified'});assert.equal(r.operation.status,'COMPLETE');assert.equal(r.operation.receivedAmount,'0.1');assert.equal(r.operation.steps.length,1);assert.equal(f.state.swapCount,1);
});
test('DEX quantity buy sizes fixed BNB input within budget, rejects insufficient budget without spending',async t=>{
 const f=await fixture(t),p=await f.prepare({action:'buy',amount:'10',buyMode:'tokenAmount',funding:{maxBnb:'0.01',slippageBps:'100'}});
 assert(BigInt(p.expectedRaw)>=10n*U);assert(BigInt(p.spendRaw)<10n**15n);assert.equal(p.trade.fromToken,NATIVE);assert.equal(p.trade.toToken,token);assert(f.state.quoteCount<=5);assert.equal(f.state.swapCount,0);
 await assert.rejects(()=>f.prepare({action:'buy',amount:'100000',buyMode:'tokenAmount',funding:{maxBnb:'0.001',slippageBps:'100'}}),{code:'FUNDING_BUDGET_EXCEEDED'});
});
test('unknown-platform ERC20 uses one verified aggregator order for buy or sell, with no inner contract fallback',async t=>{
 for(const action of ['buy','sell']){const f=await fixture(t,{generic:true}),intentId=randomUUID();await f.trader.handle('panelTrade',{profile:'unified',tokenAddress:token,wallet,intentId,action,amount:'100',...(action==='buy'?{fundingMode:'quantity'}:{}),slippageBps:'200',swapSlippageBps:'100'});await f.trader.drain();const op=await f.journal.read(intentId);assert.equal(op.status,'COMPLETE',op.error?.code);assert.equal(op.steps[0].plan.originProtocol,'generic-erc20');assert.equal(f.state.swapCount,1);assert.equal(op.steps.length,1);}
});
test('unknown-platform token with no aggregator route submits nothing',async t=>{const f=await fixture(t,{generic:true});f.state.noRoute=true;await assert.rejects(f.prepare({action:'buy',amount:'10',buyMode:'tokenAmount'}),{code:'NO_LIQUIDITY'});assert.equal(f.state.swapCount,0);});

test('DEX wallet shortage is not mislabeled as a request to increase an already larger budget',async t=>{
 const f=await fixture(t);f.state.native=6000000000000000n;
 await assert.rejects(()=>f.prepare({action:'buy',amount:'10000',buyMode:'tokenAmount',funding:{maxBnb:'0.1',slippageBps:'100'}}),{code:'INSUFFICIENT_BALANCE'});assert.equal(f.state.swapCount,0);
});
test('quantity DEX buy computes input above 0.1 BNB, completes once, and still refuses wallet shortage',async t=>{
 const f=await fixture(t),intentId=randomUUID();await f.trader.handle('panelTrade',{profile:'unified',tokenAddress:token,wallet,intentId,action:'buy',amount:'20000',fundingMode:'quantity',slippageBps:'200',swapSlippageBps:'100'});await f.trader.drain();const op=await f.journal.read(intentId);
 assert.equal(op.status,'COMPLETE');assert.equal(op.steps.length,1);assert.equal(op.request.maxBnb,undefined);assert(parseUnits(op.steps[0].plan.trade.amount,18)>parseUnits('0.1',18));assert(parseUnits(op.steps[0].plan.trade.amount,18)<parseUnits('0.21',18));assert.equal(f.state.swapCount,1);
 f.state.native=parseUnits('0.1',18);await assert.rejects(()=>f.prepare({action:'buy',amount:'20000',buyMode:'tokenAmount',funding:{mode:'quantity',slippageBps:'100'}}),{code:'INSUFFICIENT_BALANCE'});assert.equal(f.state.swapCount,1);
});
test('one-click percentage sell uses fresh balance, one swap, no funding or second conversion',async t=>{
 const f=await fixture(t),intentId=randomUUID();await f.trader.handle('panelTrade',{profile:'unified',tokenAddress:token,wallet,intentId,action:'sell',sellPercent:'50',slippageBps:'200',swapSlippageBps:'100'});await f.trader.drain();
 const op=await f.journal.read(intentId);assert.equal(op.status,'COMPLETE');assert.equal(op.steps.length,1);assert.equal(op.steps[0].plan.amountRaw,(5000n*U).toString());assert.equal(f.state.trade.amount,'5000');assert.equal(f.state.swapCount,1);
});

test('one-click DEX buy verifies native rounding, target receipts and phone-confirmation order',async t=>{
 const f=await fixture(t),intentId=randomUUID();f.state.valueDelta=-1n;f.state.outcome='PENDING_CONFIRMATION';
 await f.trader.handle('panelTrade',{profile:'unified',tokenAddress:token,wallet,intentId,action:'buy',amount:'100',maxBnb:'0.01',slippageBps:'200',swapSlippageBps:'100'});await f.trader.drain();
 const op=await f.journal.read(intentId);assert.equal(op.status,'COMPLETE');assert.equal(op.steps.length,1);assert(parseUnits(op.receivedAmount,18)>=100n*U);assert.equal(f.state.swapCount,1);
});
test('official failure releases the journal; unknown result remains blocked and never resubmits',async t=>{
 const f=await fixture(t);await f.send(await f.prepare());f.state.orderStatus='FAILED';assert.equal((await f.status()).operation.status,'FAILED');await f.prepare();assert.equal(f.state.swapCount,1);
 const g=await fixture(t);g.state.outcome='UNKNOWN';await g.send(await g.prepare());assert.equal((await g.status()).operation.status,'UNKNOWN');await assert.rejects(()=>g.prepare(),{code:'UNRESOLVED_TRADE_EXISTS'});assert.equal(g.state.swapCount,1);
});
test('partial sell and refund remain visible after automatic completion and restart',async t=>{
 const f=await fixture(t);f.state.debit=2500n*U;f.state.refund=[{tokenAddress:token,amount:'2500',symbol:'GANG'}];const intentId=randomUUID();
 await f.trader.handle('panelTrade',{profile:'unified',tokenAddress:token,wallet,intentId,action:'sell',sellPercent:'50',slippageBps:'200',swapSlippageBps:'100'});await f.trader.drain();const op=await f.journal.read(intentId);
 assert.equal(op.status,'COMPLETE');assert.equal(op.partial,true);assert.match(op.message,/部分成交/);assert.equal(op.refunds.length,1);assert.equal(f.state.swapCount,1);assert.equal((await f.create().handle('panelStatus',{profile:'unified'})).operation.partial,true);
});
for(const [key,value,code]of [['badWallet',true,'DEX_SETTLEMENT_MISMATCH'],['badOrder',true,'SWAP_ORDER_MISMATCH'],['nonceDelta',3n,'DEX_SETTLEMENT_MISMATCH'],['valueDelta',1n,'DEX_SETTLEMENT_MISMATCH'],['debit',10001n*U,'DEX_SETTLEMENT_MISMATCH']])test('mismatched DEX '+key+' does not unlock or retry',async t=>{
 const f=await fixture(t);await f.send(await f.prepare());f.state[key]=value;const r=await f.status();assert.equal(r.reconcileError.code,code);assert.equal(r.operation.status,'SUBMITTED');assert.equal(f.state.swapCount,1);
});
test('DEX sell tolerates up to two official approval nonces; a reverted receipt stops safely',async t=>{
 const f=await fixture(t);await f.send(await f.prepare());f.state.nonceDelta=2n;assert.equal((await f.status()).operation.status,'COMPLETE');
 const g=await fixture(t);await g.send(await g.prepare());g.state.receiptStatus='0x0';const r=await g.status();assert.equal(r.operation.status,'FAILED');assert.equal(r.operation.steps[0].failedReceipt.status,'0x0');
});
