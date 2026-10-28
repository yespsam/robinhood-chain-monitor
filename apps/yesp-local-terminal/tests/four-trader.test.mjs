import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createFourReader,FOUR,ZERO,helperAbi,managerAbi,erc20Abi,hex} from '../server/four-reader.mjs';
import {createFourTrader,validateFourPreview} from '../server/four-trader.mjs';
import {FlapJournal} from '../server/flap-journal.mjs';
import {createWalletTransfer} from '../server/wallet-transfer.mjs';
import {validateRequest,installBridge,GUARD_KEY} from '../extension/background.js';
import {validateFourParams,isFourPage,isOwnFourPage} from '../extension/four-policy.js';
const address=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0');
const unit=10n**18n,wallet=address(11),token=address(12),quoteToken=address(13),now=1792760000000;
const input={profile:'fourmeme',tokenAddress:token,action:'buy',amount:'0.01',slippageBps:'100'};
async function fixture(t,{quote=ZERO,outcome='SUBMITTED',allowance=unit*1000n}={}){
  const directory=await mkdtemp(join(tmpdir(),'yesp-four-'));t.after(()=>rm(directory,{recursive:true,force:true}));const journal=new FlapJournal(directory);
  let time=now,version=2n,template=0n,feeSetting=0n,migrated=false,chain='0x38',nonce='0x5',connected=true,dev=true,native=unit,balance=unit*1000n;
  let approvals=allowance,codeChanged=false,writes=0,previews=0,confirmed=false,wrongHash=false,reverted=false,tx=null,txNonce=null,previewTx=null,previewFault=false,walletChanged=false;
  const rpc=async(method,args)=>{
    if(method==='eth_chainId')return chain;
    if(method==='eth_blockNumber')return confirmed?'0x103':'0x100';
    if(method==='eth_getBlockByNumber')return {number:args[0],timestamp:hex(Math.floor(time/1000)),hash:hash(100)};
    if(method==='eth_getBalance')return hex(native);
    if(method==='eth_getTransactionCount')return nonce;
    if(method==='eth_getCode')return codeChanged?'0x60006001':'0x60006000';
    if(method==='eth_getStorageAt')return hash(0);
    if(method==='eth_estimateGas')return hex(100000);
    if(method==='eth_gasPrice')return hex(1000000000);
    if(method==='eth_call'){
      const q=args[0];
      if(q.to.toLowerCase()===FOUR.helper.toLowerCase()){
        const c=helperAbi.parseTransaction({data:q.data});
        if(c.name==='getTokenInfo')return helperAbi.encodeFunctionResult(c.name,[version,version===1n?FOUR.v1:FOUR.v2,quote,1n,100n,1n,0n,unit*100n,unit*200n,unit,unit*10n,migrated]);
        if(c.name==='tryBuy'){const exact=c.args[1]>0n,raw=exact?10100000000000000n:c.args[2],fee=exact?100000000000000n:raw/100n;
          return helperAbi.encodeFunctionResult(c.name,[FOUR.v2,quote,exact?c.args[1]:unit*100n,raw-fee,fee,quote===ZERO?raw:0n,quote===ZERO?0n:raw,raw]);}
        if(c.name==='trySell')return helperAbi.encodeFunctionResult(c.name,[FOUR.v2,quote,9900000000000000n,100000000000000n]);
      }
      if(q.to.toLowerCase()===FOUR.v2.toLowerCase()){
        const c=managerAbi.parseTransaction({data:q.data});
        return managerAbi.encodeFunctionResult(c.name,c.name==='_tokenInfos'?[token,quote,template,unit*1000n,unit*200n,unit*10n,0n,unit*100n,unit,1n,0n,0n,migrated?3n:0n]:[0n,0n,feeSetting,0n,0n]);
      }
      const c=erc20Abi.parseTransaction({data:q.data});return erc20Abi.encodeFunctionResult(c.name,[c.name==='decimals'?18:c.name==='symbol'?'TEST':c.name==='allowance'?approvals:balance]);
    }
    if(method==='eth_getTransactionByHash')return tx?{hash:args[0],from:wrongHash?address(99):wallet,to:tx.to,input:tx.inputData,value:tx.value,nonce:txNonce,blockHash:hash(100)}:null;
    if(method==='eth_getTransactionReceipt'){
      if(!confirmed)return null;let log;
      if(tx.to.toLowerCase()!==FOUR.v2.toLowerCase()){const c=erc20Abi.parseTransaction({data:tx.inputData});log={address:tx.to,...erc20Abi.encodeEventLog(erc20Abi.getEvent('Approval'),[wallet,FOUR.v2,c.args[1]])};}
      else{const c=managerAbi.parseTransaction({data:tx.inputData}),buy=['buyTokenAMAP','buyToken'].includes(c.name),cost=c.name==='buyToken'?10000000000000000n:buy?c.args[1]-c.args[1]/100n:10000000000000000n,fee=c.name==='buyToken'?100000000000000n:buy?c.args[1]/100n:100000000000000n;
        log={address:FOUR.v2,...managerAbi.encodeEventLog(managerAbi.getEvent(buy?'TokenPurchase':'TokenSale'),[token,wallet,1n,c.name==='buyToken'?c.args[1]:buy?unit*100n:c.args[2],cost,fee,0n,0n])};}
      return {transactionHash:args[0],from:wallet,to:tx.to,blockHash:hash(100),blockNumber:'0x101',status:reverted?'0x0':'0x1',gasUsed:hex(100000),effectiveGasPrice:hex(1000000000),logs:[log]};
    }
    assert.fail('Unexpected RPC '+method);
  };
  const cli={status:async()=>({status:connected?'CONNECTED':'UNCONNECTED'}),addresses:async()=>({addresses:[{binanceChainId:'56',address:walletChanged?address(22):wallet}]}),
    settings:async()=>({devMode:{enabled:dev}}),txLock:async()=>({status:'UNLOCKED'}),
    async previewContract(p){previews++;previewTx=structuredClone(p);const approve=p.to.toLowerCase()!==FOUR.v2.toLowerCase(),decoded=approve?erc20Abi.parseTransaction({data:p.inputData}):null;
      return {outcome:previewFault?'REJECTED':'PREVIEWED',data:{requestId:randomUUID(),expiresAt:time+60000,
        parsedTx:approve?{contractAddress:p.to,spender:FOUR.v2,...(decoded.args[1]===0n?{transactionType:'Revoke'}:{transactionType:'Approve',amount:decoded.args[1].toString()})}:{contractAddress:FOUR.v2},
        simulationResult:{simulationCode:'000000000',balanceChanges:[],allowanceChanges:approve?[{owner:wallet,tokenAddress:p.to,spender:FOUR.v2,postAmount:decoded.args[1].toString()}]:[],authorityChanges:[]},risks:{riskDetails:[],riskBehaviors:[],addresses:{}}}};},
    async executePreview(){writes++;tx=previewTx;txNonce=nonce;
      return outcome==='REJECTED'?{outcome,submitted:false,code:'OFFICIAL_REJECTED'}:outcome==='SUBMITTED'?{outcome,submitted:true,data:{orderId:'test-order',txHash:hash(1)}}:{outcome,submitted:outcome==='PENDING_CONFIRMATION'?true:null};}};
  const reader=createFourReader({rpc,clock:()=>time}),create=()=>createFourTrader({cli,reader,journal,clock:()=>time,allowWrites:true}),service=create();
  const prepare=async(p={})=>(await service.handle('fourPrepare',{...input,...p})).fourPreview;
  const send=(p,id=randomUUID())=>service.handle('fourExecute',{profile:'fourmeme',previewId:p.previewId,intentId:id});
  return {service,reader,cli,journal,create,prepare,send,writes:()=>writes,previews:()=>previews,
    set(k,v){({time:x=>time=x,version:x=>version=x,template:x=>template=x,feeSetting:x=>feeSetting=x,migrated:x=>migrated=x,chain:x=>chain=x,nonce:x=>nonce=x,
      connected:x=>connected=x,dev:x=>dev=x,native:x=>native=x,balance:x=>balance=x,approvals:x=>approvals=x,codeChanged:x=>codeChanged=x,wrongHash:x=>wrongHash=x,reverted:x=>reverted=x,previewFault:x=>previewFault=x,walletChanged:x=>walletChanged=x})[k](v);},
    confirm(){confirmed=true;nonce='0x6';if(tx.to.toLowerCase()!==FOUR.v2.toLowerCase())approvals=erc20Abi.parseTransaction({data:tx.inputData}).args[1];}};
}
test('Four query and preview are read-only; native BNB buys use bounded value and minimum tokens',async t=>{
  const f=await fixture(t),result=await f.service.handle('fourQuery',{profile:'fourmeme',tokenAddress:token});assert.equal(result.market.supported,true);assert.equal(result.holdings.base,'1000.0');
  const p=await f.prepare();assert.equal(p.kind,'buy');assert.equal(BigInt(p.tx.value),10000000000000000n);assert.equal(p.minimumRaw,(unit*99n).toString());
  const call=managerAbi.parseTransaction({data:p.tx.inputData});assert.equal(call.name,'buyTokenAMAP');assert.equal(call.args[2],unit*99n);assert.equal(f.writes(),0);
});
test('Four quotes remain available without wallet login; preview requires login and developer mode',async t=>{
  const f=await fixture(t);f.set('connected',false);assert.equal((await f.service.handle('fourQuery',{profile:'fourmeme',tokenAddress:token})).wallet.connected,false);
  await assert.rejects(()=>f.prepare(),{code:'LOGIN_REQUIRED'});f.set('connected',true);f.set('dev',false);await assert.rejects(()=>f.prepare(),{code:'DEVELOPER_MODE_REQUIRED'});assert.equal(f.previews(),0);
});
test('V1, migrated, X, tax and dynamic fee markets are identified and cannot be submitted as standard V2',async t=>{
  for(const [key,value,code]of [['version',1n,'FOUR_V1_READ_ONLY'],['migrated',true,'FOUR_MIGRATED'],['template',0x10000n,'FOUR_X_MODE'],['template',8n<<10n,'FOUR_TAX_MODE'],['feeSetting',1n,'FOUR_ANTI_SNIPER']]){
    const f=await fixture(t);f.set(key,value);assert.equal((await f.reader.inspect(token)).supported,false);await assert.rejects(()=>f.prepare(),{code});assert.equal(f.writes(),0);
  }
});
test('sell slippage is applied to gross curve quote; fee is displayed separately and no router fee is charged',async t=>{
  const f=await fixture(t),p=await f.prepare({action:'sell',amount:'10'}),call=managerAbi.parseTransaction({data:p.tx.inputData});
  assert.equal(p.expectedRaw,'9900000000000000');assert.equal(p.minimumRaw,'9900000000000000');assert.equal(call.args[3],9900000000000000n);assert.equal(call.args[4],0n);assert.equal(call.args[5],ZERO);
  await assert.rejects(()=>f.prepare({action:'sell',amount:'0.0000000001'}),{code:'FOUR_GWEI_PRECISION'});
});
test('classic Four supports 99.99 percent while retaining exact quantity cost cap and gross sell minimum',async t=>{
 const f=await fixture(t),buy=await f.prepare({buyMode:'tokenAmount',amount:'10',slippageBps:'9999'}),sell=await f.prepare({action:'sell',amount:'10',slippageBps:'9999'});
 const b=managerAbi.parseTransaction({data:buy.tx.inputData}),s=managerAbi.parseTransaction({data:sell.tx.inputData});
 assert.equal(b.args[2],19999000000000000n);assert.equal(BigInt(buy.spendRaw),BigInt(buy.tx.value));assert.ok(BigInt(buy.spendRaw)>=b.args[2]);
 assert.equal(s.args[3],1000000000000n);assert.equal(sell.minimumRaw,'1000000000000');assert.equal(f.writes(),0);
});
test('ERC20 quote approval is explicit, bounded and separate; confirmed approval never automatically buys',async t=>{
  const f=await fixture(t,{quote:quoteToken,allowance:0n}),p=await f.prepare();assert.equal(p.kind,'approve');assert.equal(p.approvalToken,quoteToken);assert.equal(p.approvalRaw,'10000000000000000');
  await f.send(p);assert.equal(f.writes(),1);f.confirm();assert.equal((await f.service.handle('fourStatus',{profile:'fourmeme'})).operation.status,'COMPLETE');assert.equal(f.writes(),1);
  const next=await f.prepare();assert.equal(next.kind,'buy');assert.equal(BigInt(next.tx.value),0n);assert.equal(f.writes(),1);
});
test('existing insufficient approval is cleared with a separately confirmed zero approval',async t=>{
  const f=await fixture(t,{allowance:1n}),p=await f.prepare({action:'sell',amount:'10'});assert.equal(p.kind,'approve');assert.equal(p.approvalRaw,'0');
  await f.send(p);f.confirm();await f.service.handle('fourStatus',{profile:'fourmeme'});assert.equal((await f.prepare({action:'sell',amount:'10'})).approvalRaw,(unit*10n).toString());assert.equal(f.writes(),1);
});
test('double submission is suppressed and verified receipt after restart completes a Four buy',async t=>{
  const f=await fixture(t),p=await f.prepare(),id=randomUUID();const r=await Promise.allSettled([f.send(p,id),f.send(p,id)]);assert.equal(r.filter(v=>v.status==='fulfilled').length,1);assert.equal(f.writes(),1);
  assert.equal((await f.journal.read(id)).status,'SUBMITTED');f.confirm();assert.equal((await f.create().handle('fourStatus',{profile:'fourmeme'})).operation.status,'COMPLETE');
});
for(const orderId of [undefined,'phone-sale-1'])test(`phone-confirmed manual sell discovers its exact receipt without resending (order id: ${Boolean(orderId)})`,async t=>{
 const f=await fixture(t,{outcome:'PENDING_CONFIRMATION'});if(orderId){const execute=f.cli.executePreview;f.cli.executePreview=async()=>({...await execute(),data:{orderId}});}
 const p=await f.prepare({action:'sell',amount:'10'}),r=await f.send(p);assert.equal(r.operation.status,'PENDING_CONFIRMATION');assert.equal(r.operation.steps[0].orderId,orderId);assert.equal(r.operation.steps[0].txHash,undefined);
 f.confirm();f.cli.recentTransactions=async()=>[hash(1)];const done=await f.create().handle('fourStatus',{profile:'fourmeme'});assert.equal(done.operation.status,'COMPLETE');assert.equal(done.operation.txHash,hash(1));assert.equal(done.operation.receivedAmount,'0.0099');assert.equal(f.writes(),1);
});
test('sell finalizes independently without the Flap convert step',async t=>{
  const f=await fixture(t),p=await f.prepare({action:'sell',amount:'10'});await f.send(p);f.confirm();const op=(await f.create().handle('fourStatus',{profile:'fourmeme'})).operation;
  assert.equal(op.action,'fourSell');assert.equal(op.status,'COMPLETE');assert.equal(op.receivedAmount,'0.0099');assert.equal(op.steps.length,1);
});
test('official preview must match target and exact approval owner, spender, token and quantity',async t=>{
  const f=await fixture(t,{allowance:0n}),p=await f.prepare({action:'sell',amount:'10'});
  for(const mutate of [d=>d.parsedTx.contractAddress=address(99),d=>d.parsedTx.amount='1',d=>d.simulationResult.allowanceChanges[0].owner=address(99),
    d=>d.simulationResult.allowanceChanges[0].postAmount='1',d=>d.simulationResult.allowanceChanges[0].tokenAddress=address(99),d=>d.simulationResult.balanceChanges.push({change:'-1'})]){
    const d=structuredClone(p.official);mutate(d);assert.throws(()=>validateFourPreview({outcome:'PREVIEWED',data:d},p));
  }assert.equal(f.writes(),0);
});

test('lossy official scientific approval displays are checked against exact calldata without changing authorization',()=>{
 const amount='8187976847000337319902',manager=address(14),p={kind:'approve',wallet,manager,approvalToken:quoteToken,approvalRaw:amount,tx:{from:wallet,to:quoteToken,value:'0x0',inputData:erc20Abi.encodeFunctionData('approve',[manager,amount])}};
 const display='8.187976847000337e+21',d={parsedTx:{transactionType:'Approve',contractAddress:quoteToken,spender:manager,amount:display},simulationResult:{simulationCode:'000000000',balanceChanges:[],authorityChanges:[],allowanceChanges:[{owner:wallet,tokenAddress:quoteToken,spender:manager,postAmount:display}]},risks:{riskDetails:[],riskBehaviors:[],addresses:{}}};
 const call=()=>validateFourPreview({outcome:'PREVIEWED',data:d},p);assert.doesNotThrow(call);assert.equal(erc20Abi.decodeFunctionData('approve',p.tx.inputData)[1],BigInt(amount));
 for(const wrong of ['8.187976847000339e+21','8.187976847000337e+22','8187976847000337000000','8.2e+21','Infinity']){const bad=structuredClone(d);bad.simulationResult.allowanceChanges[0].postAmount=wrong;assert.throws(()=>validateFourPreview({outcome:'PREVIEWED',data:bad},p),{code:'APPROVAL_PREVIEW_MISMATCH'});}
 for(const raw of [(BigInt(amount)+1n).toString(),((1n<<256n)-1n).toString()]){const bad=structuredClone(p);bad.tx.inputData=erc20Abi.encodeFunctionData('approve',[manager,raw]);assert.throws(()=>validateFourPreview({outcome:'PREVIEWED',data:d},bad),{code:'APPROVAL_PREVIEW_MISMATCH'});}
 const wrongOwner=structuredClone(d);wrongOwner.simulationResult.allowanceChanges[0].owner=address(99);assert.throws(()=>validateFourPreview({outcome:'PREVIEWED',data:wrongOwner},p),{code:'APPROVAL_PREVIEW_MISMATCH'});
});
test('Binance Revoke with omitted amount is accepted only for exact approve(0) and matching zero allowance simulation',()=>{
 const manager=address(14),p={kind:'approve',wallet,manager,approvalToken:quoteToken,approvalRaw:'0',tx:{from:wallet,to:quoteToken,value:'0x0',inputData:erc20Abi.encodeFunctionData('approve',[manager,0n])}};
 const d={parsedTx:{transactionType:'Revoke',contractAddress:quoteToken,spender:manager},simulationResult:{simulationCode:'000000000',balanceChanges:[],authorityChanges:[],allowanceChanges:[{owner:wallet,tokenAddress:quoteToken,spender:manager,preAmount:'1.0181746490602676e+22',postAmount:0}]},risks:{riskDetails:[],riskBehaviors:[],addresses:{}}};
 assert.doesNotThrow(()=>validateFourPreview({outcome:'PREVIEWED',data:d},p));
 for(const mutate of [v=>v.parsedTx.amount='1',v=>v.parsedTx.amount=null,v=>v.parsedTx.spender=address(99),v=>v.parsedTx.transactionType='Unknown',v=>v.simulationResult.allowanceChanges[0].postAmount=1,v=>v.simulationResult.allowanceChanges[0].owner=address(99),v=>v.simulationResult.allowanceChanges[0].tokenAddress=address(99),v=>v.simulationResult.allowanceChanges[0].spender=address(99),v=>v.simulationResult.allowanceChanges=[],v=>v.simulationResult.balanceChanges=[{change:'-1'}]]){const bad=structuredClone(d);mutate(bad);assert.throws(()=>validateFourPreview({outcome:'PREVIEWED',data:bad},p),{code:'APPROVAL_PREVIEW_MISMATCH'});}
 const nonzero={...p,approvalRaw:'1',tx:{...p.tx,inputData:erc20Abi.encodeFunctionData('approve',[manager,1n])}};assert.throws(()=>validateFourPreview({outcome:'PREVIEWED',data:d},nonzero),{code:'APPROVAL_PREVIEW_MISMATCH'});
 const approve=structuredClone(d);approve.parsedTx.transactionType='Approve';assert.throws(()=>validateFourPreview({outcome:'PREVIEWED',data:approve},p),{code:'APPROVAL_PREVIEW_MISMATCH'});
});
test('small approvals accept Binance canonical rounded decimal displays while exact calldata remains mandatory',()=>{
 const amount='86793400150653448',display='86793400150653440',manager=address(14),p={kind:'approve',wallet,manager,approvalToken:quoteToken,approvalRaw:amount,tx:{from:wallet,to:quoteToken,value:'0x0',inputData:erc20Abi.encodeFunctionData('approve',[manager,amount])}};
 const d={parsedTx:{transactionType:'Approve',contractAddress:quoteToken,spender:manager,amount:display},simulationResult:{simulationCode:'000000000',balanceChanges:[],authorityChanges:[],allowanceChanges:[{owner:wallet,tokenAddress:quoteToken,spender:manager,postAmount:display}]},risks:{riskDetails:[],riskBehaviors:[],addresses:{}}};
 assert.equal(String(Number(amount)),display);assert.doesNotThrow(()=>validateFourPreview({outcome:'PREVIEWED',data:d},p));assert.equal(erc20Abi.decodeFunctionData('approve',p.tx.inputData)[1].toString(),amount);
 for(const wrong of ['86793400150653441','86793400150653456','867934001506534400','8.679340015065344e+16','086793400150653440']){const bad=structuredClone(d);bad.simulationResult.allowanceChanges[0].postAmount=wrong;assert.throws(()=>validateFourPreview({outcome:'PREVIEWED',data:bad},p),{code:'APPROVAL_PREVIEW_MISMATCH'});}
 const changed=structuredClone(p);changed.tx.inputData=erc20Abi.encodeFunctionData('approve',[manager,BigInt(amount)+1n]);assert.throws(()=>validateFourPreview({outcome:'PREVIEWED',data:d},changed),{code:'APPROVAL_PREVIEW_MISMATCH'});
});

test('expiry, wallet/nonce/code changes reject before execute',async t=>{
  for(const [key,value]of [['time',now+60001],['walletChanged',true],['nonce','0x6'],['codeChanged',true]]){
    const f=await fixture(t),p=await f.prepare();f.set(key,value);await assert.rejects(()=>f.send(p),e=>e.submissionNotStarted===true);assert.equal(f.writes(),0);
  }
});
test('preview rejection, insufficient balance/gas and wrong chain never reach execute',async t=>{
  for(const [key,value]of [['previewFault',true],['balance',0n],['native',0n],['chain','0x1']]){
    const f=await fixture(t);f.set(key,value);await assert.rejects(()=>f.prepare(key==='balance'?{action:'sell',amount:'10'}:{}));assert.equal(f.writes(),0);
  }
});
test('unknown Four result blocks wallet transfers and another trade; recovery verifies exact transaction identity',async t=>{
  const f=await fixture(t,{outcome:'UNKNOWN'}),p=await f.prepare(),id=randomUUID();await f.send(p,id);
  await assert.rejects(()=>f.prepare(),{code:'UNRESOLVED_TRADE_EXISTS'});
  const transfer=createWalletTransfer({cli:f.cli,journal:f.journal});await assert.rejects(()=>transfer.handle('transferPrepare',{profile:'heyi',tokenAddress:token,recipient:address(44),amount:'1'}),{code:'UNRESOLVED_TRADE_EXISTS'});
  f.set('wrongHash',true);await assert.rejects(()=>f.create().handle('fourReconcile',{profile:'fourmeme',intentId:id,txHash:hash(1)}),{code:'FOUR_TRANSACTION_MISMATCH'});
  f.set('wrongHash',false);f.confirm();assert.equal((await f.create().handle('fourReconcile',{profile:'fourmeme',intentId:id,txHash:hash(1)})).operation.status,'COMPLETE');assert.equal(f.writes(),1);
});
test('App confirmation stays pending, explicit pre-submit rejection releases, verified revert fails',async t=>{
  const pending=await fixture(t,{outcome:'PENDING_CONFIRMATION'});assert.equal((await pending.send(await pending.prepare())).operation.status,'PENDING_CONFIRMATION');
  const rejected=await fixture(t,{outcome:'REJECTED'});assert.equal((await rejected.send(await rejected.prepare())).operation.status,'REJECTED');await rejected.prepare();
  const failed=await fixture(t);await failed.send(await failed.prepare());failed.set('reverted',true);failed.confirm();assert.equal((await failed.create().handle('fourStatus',{profile:'fourmeme'})).operation.status,'FAILED');
});
test('Four request boundaries reject forged sites, frames, parameters and cross-market commands',()=>{
  const id='elekekjeabljofoefoccekebfdalomfp',sender={id,frameId:0,url:'https://four.meme/zh-TW',tab:{id:1,url:'https://four.meme/zh-TW'}};
  const request={id:'four-request-001',method:'fourPrepare',params:input};assert.deepEqual(validateRequest(request,sender,id),request);
  for(const bad of [{...sender,id:'evil'},{...sender,frameId:1},{...sender,url:'https://four.meme.evil.test/'},{...sender,tab:{id:1,url:'https://flap.sh/apps/agent-bonding-curve'}}])assert.throws(()=>validateRequest(request,bad,id));
  for(const p of [{...input,profile:'heyi'},{...input,amount:'all'},{...input,slippageBps:'10000'},{...input,recipient:address(55)},{...input,tokenAddress:ZERO}])assert.throws(()=>validateFourParams('fourPrepare',p));
  assert.throws(()=>validateRequest({id:'request-001',method:'trade',params:{profile:'heyi',action:'sell',intentId:randomUUID()}},sender,id));
  assert.equal(isFourPage('https://four.meme/zh-TW'),true);assert.equal(isFourPage('https://four.meme.evil.test/'),false);
  assert.equal(isOwnFourPage(`chrome-extension://${id}/four.html#${token}`,id),true);
});
test('Four execute uses the same persistent browser guard as transfer and Flap',async()=>{
  const id='elekekjeabljofoefoccekebfdalomfp',url='https://four.meme/zh-TW',sender={id,frameId:0,url,tab:{id:1,url}},storage={},listeners={},posted=[];
  const api={runtime:{id,onMessage:{addListener(){}},connectNative(){return {postMessage:r=>posted.push(r),onMessage:{addListener:f=>listeners.message=f},onDisconnect:{addListener(){}}};}},
    storage:{local:{async get(k){return {[k]:storage[k]};},async set(v){Object.assign(storage,v);}}},tabs:{async sendMessage(){}}};
  const bridge=installBridge(api),request={id:'request-four-001',method:'fourExecute',params:{profile:'fourmeme',previewId:randomUUID(),intentId:randomUUID()}};
  const first=bridge.handle(request,sender);await new Promise(setImmediate);
  assert.equal(storage[GUARD_KEY].profile,'fourmeme');assert.equal((await bridge.handle({...request,id:'request-four-002'},sender)).error.code,'TRADE_PENDING');
  await listeners.message({id:request.id,ok:false,submissionNotStarted:true,error:{code:'PREVIEW_EXPIRED'}});assert.equal((await first).guard,null);assert.equal(posted.length,1);
});

test('classic quantity buy uses exact token call with gross cost cap and separately bounded fee-inclusive payment',async t=>{
  for(const quote of [ZERO,quoteToken]){const f=await fixture(t,{quote,allowance:0n}),p=await f.prepare({buyMode:'tokenAmount',amount:'10'});
    assert.equal(p.expected,'10.0');assert.equal(p.maximumCostRaw,'10100000000000000');assert.equal(p.spendRaw,'10201000000000000');
    const c=(quote===ZERO?managerAbi:erc20Abi).parseTransaction({data:p.tx.inputData});
    if(quote===ZERO){assert.equal(c.name,'buyToken');assert.equal(c.args[1],10n*unit);assert.equal(c.args[2],BigInt(p.maximumCostRaw));assert.equal(BigInt(p.tx.value),BigInt(p.spendRaw));
      await f.send(p);f.confirm();assert.equal((await f.service.handle('fourStatus',{profile:'fourmeme'})).operation.receivedAmount,'10.0');}
    else{assert.equal(c.name,'approve');assert.equal(c.args[1],BigInt(p.spendRaw));assert.equal(p.tx.value,'0x0');assert.equal(f.writes(),0);}
  }
});

test('classic quantity precision, inventory and explicit buy units are validated',async t=>{
  const f=await fixture(t);await assert.rejects(()=>f.prepare({buyMode:'tokenAmount',amount:'0.0000000001'}),{code:'FOUR_GWEI_PRECISION'});
  await assert.rejects(()=>f.prepare({buyMode:'tokenAmount',amount:'101'}),{code:'FOUR_QUANTITY_UNAVAILABLE'});
  for(const p of [{...input,buyMode:'budget'},{...input,action:'sell',buyMode:'tokenAmount'}])assert.throws(()=>validateFourParams('fourPrepare',p),{code:'INVALID_REQUEST'});
  assert.equal(validateFourParams('fourPrepare',{...input,buyMode:'tokenAmount'}).buyMode,'tokenAmount');assert.equal(f.writes(),0);
});
