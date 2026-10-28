import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnits, formatUnits } from 'ethers';
import { createFlapTrader } from '../server/flap-trader.mjs';
import { FlapJournal } from '../server/flap-journal.mjs';
import { tokenAbi, portalAbi, tradeEvents } from '../server/flap-reader.mjs';

const now=1792760000000,U=10n**18n;
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0');
const p={id:'heyi',name:'Heyi.ai',chainId:'56',wallet:addr(1),market:addr(2),portal:addr(3),factory:addr(4),quote:addr(5),probe:addr(6),quoteSymbol:'BNCB',
  buySlippageBps:500,sellSlippageBps:9900,priorAuditUnavailableAcknowledged:true,codeHashes:Object.fromEntries([2,3,4,5,6].map(n=>[addr(n),hash(99)]))};
const plan={kind:'buy',grossRaw:5n*U,sharesRaw:10n*U,targetSharesRaw:10n*U,minSharesRaw:95n*U/10n,refundRaw:0n,requiredFundingRaw:0n,calls:1,blockTag:'0x10'};
const req=(id='realjournal-0001')=>({profile:'heyi',action:'buy',intentId:id,deadlineMs:15000});
const transfer=(from,to,amount)=>({address:p.quote,...tokenAbi.encodeEventLog(tokenAbi.getEvent('Transfer'),[from,to,amount])});
function tradeLog() {return {address:p.market,...tradeEvents.encodeEventLog(tradeEvents.getEvent('VirtualTrade'),[1n,p.wallet,0,plan.sharesRaw,plan.grossRaw,plan.grossRaw,0n,0n,0n,0n,0n,0n,0n,0n,0n,0n])};}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

async function fixture(t,{outcome='SUBMITTED',revert=false,prepare=false,gate}={}) {
  const directory=await mkdtemp(join(tmpdir(),'flap-real-journal-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new FlapJournal(directory),rows=new Map(),previews=new Map();let serial=10,writes=0,balance=prepare?0n:100n*U,allowance=prepare?0n:100n*U,shares=0n;
  const makeRow=(action,tx,trade)=>{
    const n=serial++,txHash=hash(n),orderId=String(n),blockHash=hash(1000+n),failed=revert&&action==='buy';
    const amount=action==='fund'?parseUnits(trade.amount,18)*1000n:plan.grossRaw;
    const logs=failed||action==='approve'?[]:action==='fund'?[transfer(addr(8),p.wallet,amount)]:[transfer(p.wallet,p.market,plan.grossRaw),tradeLog()];
    const row={action,tx,trade,amount,orderId,txHash,rec:{transactionHash:txHash,from:p.wallet,to:tx?.to||addr(8),status:failed?'0x0':'0x1',
      blockHash,blockNumber:'0x11',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs}};rows.set(txHash,row);
    if(!failed){if(action==='fund')balance+=amount;else if(action==='approve')allowance=plan.grossRaw;else{balance-=plan.grossRaw;shares=plan.sharesRaw;}}
    return row;
  };
  const reader={async snapshot(){return {block:'0x10',snapshotAtMs:now,readMs:1,phase:1,sharesRaw:shares,roomRaw:plan.targetSharesRaw-shares,limitRaw:plan.targetSharesRaw,
    balanceRaw:balance,allowanceRaw:allowance,nativeRaw:U,nonce:'0x64',pendingNonce:'0x64',eligible:true,buyOk:true,claimOk:false};},
    async buyPlan(){return structuredClone(plan);},async probe(){return {BALANCE_OK:'1',ALLOWANCE_OK:'1'};},
    async rpc(method,args){if(method==='eth_call')return tokenAbi.encodeFunctionResult('allowance',[allowance]);const row=rows.get(args[0]);assert.ok(row,'known synthetic hash');
      if(method==='eth_getTransactionReceipt')return row.rec;if(method==='eth_getTransactionByHash')return {from:p.wallet,to:row.tx?.to||addr(8),input:row.tx?.inputData||'0x',value:'0x0',blockHash:row.rec.blockHash};
      assert.fail('Unexpected mocked RPC '+method);}};
  const cli={async status(){return {status:'CONNECTED'};},async addresses(){return {addresses:[{binanceChainId:'56',address:p.wallet}]};},
    async settings(){return {devMode:{enabled:true}};},async txLock(){return {status:'UNLOCKED'};},
    async previewContract(tx){const action=tx.inputData.slice(0,10)===tokenAbi.getFunction('approve').selector?'approve':'buy',id=`preview-${previews.size}`;previews.set(id,{action,tx});
      return {outcome:'PREVIEWED',data:{requestId:id,expiresAt:now+60000,
        parsedTx:action==='approve'?{transactionType:'Approve',contractAddress:tx.to,spender:p.market,amount:String(plan.grossRaw)}:{transactionType:'ContractInteraction',contractAddress:tx.to,action:tx.inputData.slice(0,10)},
        simulationResult:{simulationCode:'000000000',simulationErrorDetail:null,gasTokenFromData:'0',authorityChanges:[],
          balanceChanges:action==='approve'?[]:[{owner:p.wallet,contractAddress:p.quote,tokenType:'Erc20',change:String(-plan.grossRaw)}],
          allowanceChanges:action==='approve'?[{owner:p.wallet,tokenAddress:p.quote,spender:p.market,postAmount:String(plan.grossRaw)}]:[]},
        risks:{riskDetails:[],riskBehaviors:[],addresses:{}}}};},
    async executePreview(id){writes++;const item=previews.get(id);if(gate&&item.action==='buy'){gate.started.resolve();await gate.finish.promise;}
      if(item.action==='buy'&&outcome!=='SUBMITTED')return {outcome,code:outcome==='UNKNOWN'?'SUBMISSION_UNKNOWN':'OFFICIAL_REJECTED'};
      const row=makeRow(item.action,item.tx);return {outcome:'SUBMITTED',data:{orderId:row.orderId,txHash:row.txHash}};},
    async quoteSwap(trade){return {toCoinAmount:formatUnits(parseUnits(trade.amount,18)*1000n,18)};},
    async executeSwap(trade){writes++;const row=makeRow('fund',null,trade);return {outcome:'SUBMITTED',data:{orderId:row.orderId,txHash:row.txHash}};},
    async readOrder({orderId}){const row=[...rows.values()].find(r=>r.orderId===orderId);assert.ok(row);return {list:[{orderId,chain:'56',status:'FINISHED',txHash:row.txHash,
      fromToken:row.trade.fromToken,toToken:row.trade.toToken,fromTokenQty:row.trade.amount,toTokenActualQty:formatUnits(row.amount,18)}]};}};
  const create=()=>createFlapTrader({allowWrites:true,profile:p,reader,cli,journal,clock:()=>now,sleep:async()=>assert.fail('unexpected receipt polling')});
  return {journal,directory,trader:create(),create,writes:()=>writes};
}

test('real journal persists COMPLETE, confirmed receipt and duplicate-intent suppression',async t=>{
  const f=await fixture(t);const {operation}=await f.trader.handle('trade',req());assert.equal(operation.status,'COMPLETE');
  assert.equal((await new FlapJournal(f.directory).read(req().intentId)).steps[0].status,'CONFIRMED');
  assert.equal((await f.create().handle('trade',req())).operation.status,'COMPLETE');assert.equal(f.writes(),1);
});
test('real journal preserves definite REJECTED as a terminal state',async t=>{
  const f=await fixture(t,{outcome:'REJECTED'});const {operation}=await f.trader.handle('trade',req());assert.equal(operation.status,'REJECTED');
  assert.equal((await f.journal.read(req().intentId)).status,'REJECTED');assert.equal(f.writes(),1);
});
test('real journal UNKNOWN survives restart and blocks a fresh intent',async t=>{
  const f=await fixture(t,{outcome:'UNKNOWN'});const {operation}=await f.trader.handle('trade',req());assert.equal(operation.status,'UNKNOWN');
  assert.equal((await f.create().handle('trade',req())).operation.status,'UNKNOWN');
  await assert.rejects(f.create().handle('trade',req('realjournal-0002')),{code:'UNRESOLVED_TRADE_EXISTS'});assert.equal(f.writes(),1);
});
test('real journal records an authenticated reverted receipt as FAILED',async t=>{
  const f=await fixture(t,{revert:true});const {operation}=await f.trader.handle('trade',req());assert.equal(operation.status,'FAILED');
  const saved=await f.journal.read(req().intentId);assert.equal(saved.error.code,'TRANSACTION_REVERTED');assert.equal(saved.steps[0].failedReceipt.status,'0x0');
  assert.equal(saved.steps[0].failedReceipt.txHash,saved.steps[0].txHash);assert.equal(f.writes(),1);
});
test('real journal allows fund, exact approval, then buy without changing confirmed history',async t=>{
  const f=await fixture(t,{prepare:true});const {operation}=await f.trader.handle('trade',req());assert.equal(operation.status,'COMPLETE');
  const saved=await f.journal.read(req().intentId);assert.deepEqual(saved.steps.map(s=>[s.action,s.status]),[['fund','CONFIRMED'],['approve','CONFIRMED'],['buy','CONFIRMED']]);
  assert.equal(f.writes(),3);
});
test('a second trader status call cannot reconcile or overwrite an active submission',async t=>{
  const gate={started:deferred(),finish:deferred()},f=await fixture(t,{gate});const pending=f.trader.handle('trade',req());await gate.started.promise;
  const other=f.create(),status=await other.handle('status',{profile:'heyi'});assert.equal(status.operation.steps[0].status,'SUBMITTING');
  assert.equal((await f.journal.read(req().intentId)).status,'PREPARING');gate.finish.resolve();
  assert.equal((await pending).operation.status,'COMPLETE');assert.equal((await other.handle('status',{profile:'heyi'})).operation.status,'COMPLETE');
});
