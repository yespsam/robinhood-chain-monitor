import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { formatUnits } from 'ethers';
import { createWalletTransfer, transferAbi, NATIVE, validateTransferFields } from '../server/wallet-transfer.mjs';
import { FlapJournal } from '../server/flap-journal.mjs';
import { createFastTradeCli, transferArguments } from '../server/fast-trade-cli.mjs';
import { validateRequest, installBridge, GUARD_KEY } from '../extension/background.js';

const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0');
const now=1792760000000,unit=10n**18n,from=addr(11),to=addr(12),token=addr(13);
const request={profile:'heyi',recipient:to,tokenAddress:token,amount:'1.234567'};
async function fixture(t,{outcome='SUBMITTED',decimals=6,revert=false}={}) {
  const directory=await mkdtemp(join(tmpdir(),'yesp-transfer-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const journal=new FlapJournal(directory);let clock=now,writes=0,connected=true,changed=false,nonce='0x5',native=unit,balance=123456789n,reportedBalance=null,confirmed=false,mismatch=false,tx=null;
  const rpc=async(method,args)=>{
    if(method==='eth_chainId')return '0x38';
    if(method==='eth_blockNumber')return confirmed?'0x103':'0x100';
    if(method==='eth_getBlockByNumber')return {number:args[0],hash:hash(100),timestamp:'0x'+BigInt(Math.floor(clock/1000)).toString(16)};
    if(method==='eth_getBalance')return '0x'+native.toString(16);
    if(method==='eth_getTransactionCount')return nonce;
    if(method==='eth_getCode')return '0x60006000';
    if(method==='eth_gasPrice')return '0x3b9aca00';
    if(method==='eth_estimateGas')return '0xc350';
    if(method==='eth_call'){
      const decoded=transferAbi.parseTransaction({data:args[0].data});
      return transferAbi.encodeFunctionResult(decoded.name,[decoded.name==='decimals'?decimals:decoded.name==='symbol'?'TEST':balance]);
    }
    if(method==='eth_getTransactionByHash')return tx?{...tx,hash:args[0],from:mismatch?addr(99):from,nonce:'0x5',blockHash:hash(100)}:null;
    if(method==='eth_getTransactionReceipt')return confirmed?{transactionHash:args[0],from,to:tx.to,blockHash:hash(100),blockNumber:'0x101',gasUsed:'0xc350',effectiveGasPrice:'0x3b9aca00',status:revert?'0x0':'0x1',
      logs:tx.input==='0x'?[]:[{address:token,...transferAbi.encodeEventLog(transferAbi.getEvent('Transfer'),[from,to,1234567n])}]}:null;
    assert.fail('Unexpected RPC '+method);
  };
  const cli={status:async()=>({status:connected?'CONNECTED':'UNCONNECTED'}),addresses:async()=>({addresses:[{binanceChainId:'56',address:changed?addr(20):from}]}),txLock:async()=>({status:'UNLOCKED'}),
    transferBalance:async()=>reportedBalance??formatUnits(balance,decimals),
    async sendTransfer(p){writes++;tx={to:p.tokenAddress.toLowerCase()===NATIVE.toLowerCase()?p.recipient:p.tokenAddress,value:p.tokenAddress.toLowerCase()===NATIVE.toLowerCase()?'0x'+BigInt(Math.round(Number(p.amount)*1e18)).toString(16):'0x0',input:p.tokenAddress.toLowerCase()===NATIVE.toLowerCase()?'0x':transferAbi.encodeFunctionData('transfer',[p.recipient,1234567n])};
      return outcome==='SUBMITTED'?{outcome,data:{txHash:hash(1)},submitted:true}:outcome==='REJECTED'?{outcome,submitted:false,code:'OFFICIAL_REJECTED'}:{outcome,submitted:null};}};
  const create=()=>createWalletTransfer({cli,rpc,journal,allowWrites:true,clock:()=>clock});
  const service=create();
  const prepare=async(p={})=>(await service.handle('transferPrepare',{...request,...p})).transferPreview;
  const send=async(preview,intentId=randomUUID())=>service.handle('transfer',{profile:'heyi',previewId:preview.previewId,intentId});
  return {service,create,journal,prepare,send,writes:()=>writes,setHistory:()=>cli.recentTransactions=async()=>[hash(1)],setClock:v=>clock=v,setWalletChanged:()=>changed=true,setConnected:v=>connected=v,
    setNative:v=>native=v,setBalance:v=>balance=v,setReportedBalance:v=>reportedBalance=v,setNonce:v=>nonce=v,setConfirmed:()=>confirmed=true,setMismatch:()=>mismatch=true};
}
test('transfer preparation is read-only, uses exact token decimals, no market profile needed',async t=>{
  const f=await fixture(t),p=await f.prepare();assert.equal(p.amountRaw,'1234567');assert.equal(p.decimals,6);assert.equal(p.balance,'123.456789');assert.equal(f.writes(),0);
  assert.equal((await f.service.handle('walletStatus',{profile:'heyi'})).wallet.address,from);
  f.setConnected(false);assert.equal((await f.service.handle('walletStatus',{profile:'heyi'})).wallet.connected,false);
});

test('missing transfer hash recovers from exact wallet history without resending after restart',async t=>{
 const f=await fixture(t,{outcome:'UNKNOWN'});await f.send(await f.prepare());f.setConfirmed();f.setHistory();
 const r=await f.create().handle('walletStatus',{profile:'heyi'});assert.equal(r.operation.status,'COMPLETE');assert.equal(r.operation.receivedAmount,'1.234567');assert.equal(f.writes(),1);
 const g=await fixture(t,{outcome:'UNKNOWN'});await g.send(await g.prepare());g.setConfirmed();g.setHistory();g.setMismatch();
 assert.equal((await g.create().handle('walletStatus',{profile:'heyi'})).operation.status,'UNKNOWN');assert.equal(g.writes(),1);
});
test('invalid recipient, self transfer, zero, exponent and excess precision cannot submit',async t=>{
  const f=await fixture(t);
  for(const p of [{recipient:addr(0)},{recipient:from},{amount:'0'},{amount:'1e2'},{amount:'1.2345678'},{amount:'-1'},{amount:'1',extra:true}])await assert.rejects(()=>f.prepare(p));
  assert.equal(f.writes(),0);
});
test('insufficient balance or native gas blocks preparation',async t=>{
  const f=await fixture(t);f.setBalance(1n);await assert.rejects(()=>f.prepare(),{code:'INSUFFICIENT_BALANCE'});f.setBalance(123456789n);f.setNative(0n);await assert.rejects(()=>f.prepare(),{code:'INSUFFICIENT_GAS'});assert.equal(f.writes(),0);
});
test('native transfer preserves gas reserve',async t=>{
  const f=await fixture(t);await assert.rejects(()=>f.prepare({tokenAddress:NATIVE,amount:'1'}),{code:'INSUFFICIENT_GAS'});
  const p=await f.prepare({tokenAddress:NATIVE,amount:'0.25'});assert.equal(p.decimals,18);assert.equal(p.tx.to.toLowerCase(),to);assert.equal(p.tx.inputData,'0x');assert.equal(BigInt(p.tx.value),unit/4n);
});
test('CLI unit conversion or stale reported balance cannot change the user-confirmed token amount',async t=>{
  const f=await fixture(t);f.setReportedBalance('246.913578');await assert.rejects(()=>f.prepare(),{code:'TOKEN_UNIT_MISMATCH'});assert.equal(f.writes(),0);
});
test('expired preview, wallet switch and nonce change all block execution before any send',async t=>{
  for(const kind of ['expired','wallet','nonce']) {
    const f=await fixture(t),p=await f.prepare();if(kind==='expired')f.setClock(now+60001);if(kind==='wallet')f.setWalletChanged();if(kind==='nonce')f.setNonce('0x6');
    await assert.rejects(()=>f.send(p),e=>e.submissionNotStarted===true);assert.equal(f.writes(),0);
  }
});
test('double click submits once; broadcast remains pending until verified receipt after restart',async t=>{
  const f=await fixture(t),p=await f.prepare(),id=randomUUID();const results=await Promise.allSettled([f.send(p,id),f.send(p,id)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.writes(),1);assert.equal((await f.journal.read(id)).status,'SUBMITTED');
  await assert.rejects(()=>f.prepare(),{code:'UNRESOLVED_TRADE_EXISTS'});f.setConfirmed();
  const result=await f.create().handle('walletStatus',{profile:'heyi'});assert.equal(result.operation.status,'COMPLETE');assert.equal(result.operation.receivedAmount,'1.234567');assert.equal(f.writes(),1);
});
test('unknown outcome survives restart, blocks another transfer, and verified hash recovers without resending',async t=>{
  const f=await fixture(t,{outcome:'UNKNOWN'}),p=await f.prepare(),id=randomUUID();await f.send(p,id);
  assert.equal((await f.create().handle('walletStatus',{profile:'heyi'})).operation.status,'UNKNOWN');await assert.rejects(()=>f.prepare(),{code:'UNRESOLVED_TRADE_EXISTS'});
  f.setConfirmed();const result=await f.create().handle('transferReconcile',{profile:'heyi',intentId:id,txHash:hash(1)});assert.equal(result.operation.status,'COMPLETE');assert.equal(f.writes(),1);
});
test('mismatched recovery transaction cannot clear unknown outcome',async t=>{
  const f=await fixture(t,{outcome:'UNKNOWN'}),p=await f.prepare(),id=randomUUID();await f.send(p,id);f.setMismatch();
  await assert.rejects(()=>f.create().handle('transferReconcile',{profile:'heyi',intentId:id,txHash:hash(2)}),{code:'TRANSFER_IDENTITY_MISMATCH'});assert.equal((await f.journal.read(id)).status,'UNKNOWN');
});
test('verified revert becomes failed; explicit pre-submission rejection releases journal',async t=>{
  const f=await fixture(t,{revert:true}),p=await f.prepare();await f.send(p);f.setConfirmed();assert.equal((await f.create().handle('walletStatus',{profile:'heyi'})).operation.status,'FAILED');
  const g=await fixture(t,{outcome:'REJECTED'}),q=await g.prepare();assert.equal((await g.send(q)).operation.status,'REJECTED');await g.prepare();
});
test('wallet send adapter pins BSC and typed amount; never permits max or arbitrary args',async()=>{
  const p={chainId:'56',recipient:to,tokenAddress:token,amount:'1.234567'};
  assert.equal(transferArguments(p).includes('--max'),false);assert.throws(()=>transferArguments({...p,chainId:'1'}));assert.throws(()=>transferArguments({...p,max:true}));
  let calls=0;
  const create=allowWrites=>createFastTradeCli({allowWrites,resolveInstallation:async()=>({metadata:{name:'@binance/agentic-wallet',version:'1.11.0',bin:{baw:'dist/index.js'}},entryPath:join(tmpdir(),'fixture','dist','index.js')}),
    execute:async(exe,args,options)=>{calls++;assert.deepEqual(args.slice(1),[...transferArguments(p),'--json']);assert.equal(options.shell,false);return {stdout:JSON.stringify({success:true,data:{txHash:hash(1)}})};}});
  assert.equal((await create(false).sendTransfer(p)).outcome,'REJECTED');assert.equal(calls,0);assert.equal((await create(true).sendTransfer(p)).outcome,'SUBMITTED');assert.equal(calls,1);
});
test('transfers are accepted only from the own extension wallet page with strict fields',()=>{
  const id='elekekjeabljofoefoccekebfdalomfp',url=`chrome-extension://${id}/wallet.html`,sender={id,frameId:0,url,tab:{id:1,url}};
  const req={id:randomUUID(),method:'transferPrepare',params:request};assert.deepEqual(validateRequest(req,sender,id),req);
  assert.throws(()=>validateRequest(req,{...sender,url:'https://flap.sh/apps/agent-bonding-curve',tab:{id:1,url:'https://flap.sh/apps/agent-bonding-curve'}},id));
  assert.throws(()=>validateRequest({...req,params:{...request,extra:'bad'}},sender,id));
  assert.throws(()=>validateTransferFields('transfer',{profile:'heyi',previewId:randomUUID(),intentId:randomUUID(),recipient:to}));
});
test('transfer uses the persisted shared browser guard and clears only explicit not-started or confirmed results',async()=>{
  const id='elekekjeabljofoefoccekebfdalomfp',url=`chrome-extension://${id}/wallet.html`,sender={id,frameId:0,url,tab:{id:1,url}};
  const storage={},posted=[],listeners={};const port={postMessage:x=>posted.push(x),onMessage:{addListener:f=>listeners.message=f},onDisconnect:{addListener:f=>listeners.disconnect=f}};
  const api={runtime:{id,connectNative:()=>port,onMessage:{addListener(){}}},tabs:{sendMessage:async()=>{}},storage:{local:{get:async k=>({[k]:storage[k]}),set:async o=>Object.assign(storage,o)}}};
  const bridge=installBridge(api),intentId=randomUUID(),req={id:randomUUID(),method:'transfer',params:{profile:'heyi',previewId:randomUUID(),intentId}};
  const response=bridge.handle(req,sender);await new Promise(r=>setTimeout(r,10));assert.equal(posted.length,1);assert.equal(storage[GUARD_KEY].intentId,intentId);
  assert.equal((await bridge.handle({...req,id:randomUUID()},sender)).error.code,'TRADE_PENDING');
  await listeners.message({id:req.id,ok:false,error:{code:'PREVIEW_EXPIRED'},submissionNotStarted:true});assert.equal((await response).guard,null);
});
