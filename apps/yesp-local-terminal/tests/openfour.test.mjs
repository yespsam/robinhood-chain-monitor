import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOpenFourReader,OPENFOUR,moduleAbi,openFourError} from '../server/openfour-reader.mjs';
import {createFourRouter} from '../server/four-router.mjs';
import {coreAbi,registryAbi,toolsAbi,feeAbi} from '../server/openfour-abi.mjs';
import {FOUR,ZERO,helperAbi,erc20Abi,hex} from '../server/four-reader.mjs';
import {createFourTrader} from '../server/four-trader.mjs';
import {FlapJournal} from '../server/flap-journal.mjs';
const address=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0'),unit=10n**18n;
const wallet=address(11),token=address(12),tools=address(13),feeRouter=address(14),vault=address(15),quoteToken=address(16),beacon=address(17),implementation=address(18);
const now=1792760000000,input={profile:'fourmeme',tokenAddress:token,action:'buy',amount:'1',slippageBps:'100'};
const tags=['token.tax.binance_agent','module.token.binance_agent','module.vault.tax_bonding','module.curve.bonding_binance_agent','module.trade.tax_bonding_binance_agent','module.migrate.pcs_v2'];
async function fixture(t,{ercQuote=false,quoteDecimals=18,allowance=unit*1000000000n,outcome='SUBMITTED'}={}){
  const root=await mkdtemp(join(tmpdir(),'yesp-openfour-'));t.after(()=>rm(root,{recursive:true,force:true}));const journal=new FlapJournal(root);
  const s={time:now,phase:1n,hold:100n*unit,native:10n*unit,nonce:'0x5',eligible:true,paused:false,presetId:OPENFOUR.presetId,version:'1.0.0',tagChanged:false,
    allowance,fee:11n*unit/100n,expected:100n*unit,quoteCost:unit*80n/100n,partialSell:0n,identityChanged:false,tax:1000n,gateThrows:false,
    code:0n,confirmed:false,wrongEvent:false,badNet:false,badNonce:false,zeroQuote:false,pending:false,coreChanged:false,presale:false,helperError:false,
    maxSupply:unit*1000000000n,remaining:unit*800000000n,partialBuy:0n,receiptBuy:0n,wrongRequested:false};
  const seen=[],txs=[];let writes=0,previewTx=null,tx=null;
  const quote=ercQuote?quoteToken:OPENFOUR.wrappedNative;
  const runtime=()=>[1,wallet,s.presetId,token,'Test Agent','TEST',s.maxSupply,unit*800000000n,unit*14n,quote,vault,address(21),address(22),address(23),address(24),ZERO,s.presale?256:1,true,s.paused,true];
  const preset=()=>[s.presetId,'Binance Agent ID Exclusive','Test',s.version,true,true,address(25),hash(1),hash(2),hash(3),hash(4),hash(5),hash(6),hash(0),wallet];
  const rpc=async(method,args)=>{
    seen.push(method);assert.ok(!/send|sign/i.test(method));
    if(method==='eth_chainId')return '0x38';
    if(method==='eth_blockNumber')return s.confirmed?'0x103':'0x100';
    if(method==='eth_getBlockByNumber')return {number:args[0],timestamp:hex(s.time/1000),hash:hash(100)};
    if(method==='eth_getBalance')return hex(s.native);
    if(method==='eth_getTransactionCount')return args[1]==='pending'&&s.pending?'0x6':s.nonce;
    if(method==='eth_getCode')return args[0].toLowerCase()===implementation.toLowerCase()&&s.identityChanged?'0x60006001':'0x60006000';
    if(method==='eth_getStorageAt')return hash(0);
    if(method==='eth_estimateGas'){txs.push(args[0]);return hex(100000);}
    if(method==='eth_gasPrice')return hex(1000000000);
    if(method==='eth_call'){
      const q=args[0],to=q.to.toLowerCase();let abi,c,values;
      if(to===FOUR.helper.toLowerCase()){
        if(s.helperError)throw Object.assign(Error(),{code:'RPC_UNAVAILABLE'});
        return helperAbi.encodeFunctionResult('getTokenInfo',[0,ZERO,ZERO,0,0,0,0,0,0,0,0,false]);
      }
      if(to===OPENFOUR.registry.toLowerCase()){
        abi=registryAbi;c=abi.parseTransaction({data:q.data});values={openFourCore:[s.coreChanged?address(99):OPENFOUR.core],openFourTool:[tools],getPreset:[(()=>{const p=preset();if(c.name!=='getPreset')return p;p[0]=c.args[0];if(c.args[0]===999n)p[10]=hash(99);return p;})()],getModuleBeacon:[beacon],getPresetTokenImpl:[implementation]}[c.name];
      }else if(to===OPENFOUR.core.toLowerCase()){
        abi=coreAbi;c=abi.parseTransaction({data:q.data});values={tokens:runtime(),registry:[OPENFOUR.registry],wrappedNative:[OPENFOUR.wrappedNative],feeRouter:[feeRouter],paused:[s.paused]}[c.name];
      }else if(to===tools.toLowerCase()){
        abi=toolsAbi;c=abi.parseTransaction({data:q.data});
        if(c.name==='core')values=[OPENFOUR.core];
        else{assert.equal(c.args[1].toLowerCase(),wallet.toLowerCase());assert.equal(c.args[3],0n);assert.equal(c.args[4],'0x');
          const buy=['estimateBuyByBudget','estimateBuy'].includes(c.name),amount=c.name==='estimateBuy'?(s.partialBuy||c.args[2]):buy?s.expected:s.partialSell||c.args[2];
          values=[[s.quoteCost,s.fee,buy?s.quoteCost+s.fee:0n,buy?0n:s.quoteCost-s.fee,s.zeroQuote?0n:amount,1n]];}
      }else if(to===feeRouter.toLowerCase()){abi=feeAbi;c=abi.parseTransaction({data:q.data});values=[50,50,100,1000,10,0,0,0,0,0,0];}
      else {
        c=moduleAbi.parseTransaction({data:q.data});
        if(c){abi=moduleAbi;
          if(c.name==='descriptor'){const index=[token,address(24),vault,address(21),address(22),address(23)].map(x=>x.toLowerCase()).indexOf(to);assert.ok(index>=0);values=['0x'+'11'.repeat(8),s.tagChanged?'unknown':tags[index],index===0?'1':'1.0.0'];}
          else if(c.name==='evaluate'){if(s.gateThrows)throw Object.assign(Error(),{code:'RPC_CALL_FAILED',rpcError:{data:'0x96ea0b74'}});values=[[s.eligible,0,0,[],s.eligible?'':'Agentic wallet required']];}
          else values={fourCore:[OPENFOUR.core],quoteAsset:[quote],quote:[quote],founder:[wallet],phase:[s.phase],remainingForSale:[s.remaining],totalRaised:[unit],
            buyFeeRate:[s.tax],sellFeeRate:[s.tax],rateFounder:[100],rateHolder:[0],rateBurn:[0],rateLiquidity:[0],implementation:[implementation]}[c.name];
        }else{abi=erc20Abi;c=abi.parseTransaction({data:q.data});values={decimals:[to===quoteToken.toLowerCase()?quoteDecimals:18],symbol:['TEST'],balanceOf:[to===token.toLowerCase()?s.hold:unit*10n],allowance:[s.allowance]}[c.name];}
      }
      assert.ok(values,'Unhandled '+c?.name);return abi.encodeFunctionResult(c.name,values);
    }
    if(method==='eth_getTransactionByHash')return tx?{hash:args[0],from:wallet,to:tx.to,input:tx.inputData,value:tx.value,nonce:s.badNonce?'0x6':'0x5',blockHash:hash(100)}:null;
    if(method==='eth_getTransactionReceipt'){
      if(!s.confirmed)return null;let log;
      if(tx.to.toLowerCase()!==OPENFOUR.core.toLowerCase()){
        const c=erc20Abi.parseTransaction({data:tx.inputData});log={address:tx.to,...erc20Abi.encodeEventLog(erc20Abi.getEvent('Approval'),[wallet,OPENFOUR.core,c.args[1]])};
      }else{
        const c=coreAbi.parseTransaction({data:tx.inputData}),buy=['buyByBudget','buy'].includes(c.name),amount=c.name==='buy'?(s.receiptBuy||c.args[1]):buy?s.expected:s.partialSell||c.args[1];
        log={address:OPENFOUR.core,...coreAbi.encodeEventLog(coreAbi.getEvent('TradeExecuted'),[token,wallet,s.wrongEvent?1:s.presetId,buy,quote,vault,s.wrongRequested?1:c.name==='buyByBudget'?0:c.args[1],amount,s.quoteCost,
          s.badNet?1:buy?s.quoteCost+s.fee:s.quoteCost-s.fee,1,c.args[2],s.fee/11n,s.fee*10n/11n,0,0,unit,unit*800000000n])};
      }
      return {transactionHash:args[0],from:wallet,to:tx.to,blockHash:hash(100),blockNumber:'0x101',status:'0x1',gasUsed:hex(100000),effectiveGasPrice:hex(1000000000),logs:[log]};
    }
    assert.fail('Unhandled RPC '+method);
  };
  const cli={status:async()=>({status:'CONNECTED'}),addresses:async()=>({addresses:[{binanceChainId:'56',address:wallet}]}),settings:async()=>({devMode:{enabled:true}}),txLock:async()=>({status:'UNLOCKED'}),
    async previewContract(p){previewTx=p;const approve=p.to.toLowerCase()!==OPENFOUR.core.toLowerCase(),decoded=approve?erc20Abi.parseTransaction({data:p.inputData}):null;
      return {outcome:'PREVIEWED',data:{requestId:randomUUID(),expiresAt:s.time+60000,parsedTx:approve?{contractAddress:p.to,transactionType:'Approve',spender:OPENFOUR.core,amount:String(decoded.args[1])}:{contractAddress:p.to},
        simulationResult:{simulationCode:'000000000',balanceChanges:[],authorityChanges:[],allowanceChanges:approve?[{owner:wallet,spender:OPENFOUR.core,tokenAddress:p.to,postAmount:String(decoded.args[1])}]:[]},risks:{riskDetails:[],riskBehaviors:[],addresses:{}}}};},
    async executePreview(){writes++;tx=previewTx;return {outcome,...(outcome==='SUBMITTED'?{data:{txHash:hash(1)}}:{})};}};
  const reader=createOpenFourReader({rpc,clock:()=>s.time}),router=createFourRouter({rpc,clock:()=>s.time});
  const create=()=>createFourTrader({cli,reader:router,journal,allowWrites:true,clock:()=>s.time}),service=create();
  const prepare=async(p={})=>(await service.handle('fourPrepare',{...input,...p})).fourPreview;
  return {s,rpc,seen,txs,reader,router,journal,service,create,prepare,writes:()=>writes,send:(p,id=randomUUID())=>service.handle('fourExecute',{profile:'fourmeme',previewId:p.previewId,intentId:id})};
}
test('OpenFour detection falls back only for unknown classic tokens and reads cap from creation supply',async t=>{
  const f=await fixture(t),m=await f.router.inspect(token);assert.equal(m.supported,true);assert.equal(m.protocol,'openfour-agent');assert.equal(m.holdCap,'10000000.0');
  assert.equal((await f.reader.holdings(m,wallet)).holdRoom,'9999900.0');assert.equal(f.writes(),0);
  f.s.helperError=true;await assert.rejects(()=>f.router.inspect(token),{code:'RPC_UNAVAILABLE'});
});
test('budget buys include all fees, native value bounds spend, and calldata minimum protects tokens',async t=>{
  const f=await fixture(t),p=await f.prepare(),c=coreAbi.parseTransaction({data:p.tx.inputData});
  assert.equal(c.name,'buyByBudget');assert.equal(c.args[1],unit);assert.equal(c.args[2],99n*unit);assert.equal(BigInt(p.tx.value),unit);
  assert.equal(p.totalFee,'0.11');assert.equal(p.estimatedSpend,'0.91');assert.equal(p.spend,'1.0');assert.equal(p.kind,'buy');assert.equal(f.writes(),0);
});
test('OpenFour sells use minimum net quote after tax, with no classic GWEI rounding restriction',async t=>{
  const f=await fixture(t),p=await f.prepare({action:'sell',amount:'1.000000000000000001'}),c=coreAbi.parseTransaction({data:p.tx.inputData});
  assert.equal(c.name,'sell');assert.equal(c.args[1],unit+1n);assert.equal(c.args[2],683100000000000000n);assert.equal(p.expected,'0.69');assert.equal(p.minimumKind,'net');assert.equal(BigInt(p.tx.value),0n);
});
test('ineligible Agent ID, cap, zero quote, over-budget and creation-block presale cannot prepare',async t=>{
  for(const [key,value,code] of [['eligible',false,'OPENFOUR_AGENT_ID_REQUIRED'],['gateThrows',true,'OPENFOUR_AGENT_ID_REQUIRED'],['hold',unit*10000000n,'OPENFOUR_HOLD_CAP'],
    ['zeroQuote',true,'FOUR_QUOTE_UNAVAILABLE'],['fee',unit,'FOUR_BUDGET_EXCEEDED'],['presale',true,'OPENFOUR_PRESALE_UNSUPPORTED']]){
    const f=await fixture(t);f.s[key]=value;await assert.rejects(()=>f.prepare(),{code});assert.equal(f.writes(),0);assert.equal(f.txs.length,0);
  }
});
test('near cap uses clamped quote, and a quote beyond remaining room is rejected',async t=>{
  const f=await fixture(t);f.s.hold=unit*10000000n-100n*unit;const p=await f.prepare();assert.equal(p.holdRoom,'100.0');assert.equal(p.expected,'100.0');
  f.s.hold++;await assert.rejects(()=>f.prepare(),{code:'FOUR_BUDGET_EXCEEDED'});
});
test('unreviewed preset modules, module and versions, migrated or paused markets stay read-only',async t=>{
  for(const [key,value,code] of [['presetId','999','OPENFOUR_PRESET_UNSUPPORTED'],['tagChanged',true,'OPENFOUR_MODULE_UNSUPPORTED'],['version','2.0.0','OPENFOUR_MODULE_UNSUPPORTED'],
    ['phase',3n,'FOUR_MIGRATED'],['phase',5n,'OPENFOUR_NOT_TRADING'],['paused',true,'OPENFOUR_PAUSED'],['tax',1001n,'OPENFOUR_TAX_UNSUPPORTED'],['coreChanged',true,'OPENFOUR_CORE_CHANGED']]){
    const f=await fixture(t);f.s[key]=value;await assert.rejects(()=>f.prepare(),{code});assert.equal(f.writes(),0);
  }
});
test('ERC20 quote and sell approvals are exact, clear old amounts separately and never auto trade',async t=>{
  for(const [ercQuote,allowance,action,expected] of [[true,0n,'buy',String(unit)],[false,1n,'sell','0']]){
    const f=await fixture(t,{ercQuote,allowance}),p=await f.prepare({action});assert.equal(p.kind,'approve');assert.equal(p.approvalRaw,expected);assert.equal(p.manager,OPENFOUR.core);
    await f.send(p);f.s.confirmed=true;const op=(await f.create().handle('fourStatus',{profile:'fourmeme'})).operation;assert.equal(op.status,'COMPLETE');assert.equal(f.writes(),1);
  }
});
test('recheck invalidates fee, implementation, nonce, eligibility and cap changes before execute',async t=>{
  for(const [key,value] of [['fee',unit*12n/100n],['identityChanged',true],['nonce','0x6'],['eligible',false],['hold',unit*10000000n],['tax',999n],['expected',98n*unit],['pending',true]]){
    const f=await fixture(t),p=await f.prepare();f.s[key]=value;await assert.rejects(()=>f.send(p),e=>e.submissionNotStarted===true,key);assert.equal(f.writes(),0);
  }
});
test('OpenFour receipts finalize buys and partially filled sells using verified net amount',async t=>{
  for(const action of ['buy','sell']){const f=await fixture(t);if(action==='sell')f.s.partialSell=unit/2n;
    const p=await f.prepare({action});await f.send(p);f.s.confirmed=true;const op=(await f.create().handle('fourStatus',{profile:'fourmeme'})).operation;
    assert.equal(op.status,'COMPLETE');assert.equal(op.receivedAmount,action==='buy'?'100.0':'0.69');assert.equal(op.executedTokenAmount,action==='buy'?'100.0':'0.5');assert.equal(f.writes(),1);}
});
test('receipt mismatch remains unresolved; unknown outcomes require exact hash recovery and never resend',async t=>{
  for(const key of ['wrongEvent','badNet','badNonce']){const f=await fixture(t,{outcome:'UNKNOWN'}),p=await f.prepare(),id=randomUUID();await f.send(p,id);f.s.confirmed=true;f.s[key]=true;
    await assert.rejects(()=>f.create().handle('fourReconcile',{profile:'fourmeme',intentId:id,txHash:hash(1)}));assert.notEqual((await f.journal.read(id)).status,'COMPLETE');
    await assert.rejects(()=>f.prepare(),{code:'UNRESOLVED_TRADE_EXISTS'});f.s[key]=false;
    assert.equal((await f.create().handle('fourReconcile',{profile:'fourmeme',intentId:id,txHash:hash(1)})).operation.status,'COMPLETE');assert.equal(f.writes(),1);
  }
});
test('official custom errors are translated without displaying RPC internals',()=>{
  for(const [selector,code] of [['0x96ea0b74','OPENFOUR_AGENT_ID_REQUIRED'],['0x687d0d11','OPENFOUR_HOLD_CAP'],['0xa6708f30','OPENFOUR_TRANSFER_LOCKED']])
    assert.equal(openFourError({rpcError:{data:{result:selector}}}).code,code);
});

test('quantity buy quotes token units and caps total native payment including fees and slippage',async t=>{
  const f=await fixture(t),p=await f.prepare({buyMode:'tokenAmount',amount:'100'}),c=coreAbi.parseTransaction({data:p.tx.inputData});
  assert.equal(c.name,'buy');assert.equal(c.args[1],100n*unit);assert.equal(c.args[2],919100000000000000n);
  assert.equal(BigInt(p.tx.value),c.args[2]);assert.equal(p.spendRaw,String(c.args[2]));assert.equal(p.estimatedSpend,'0.91');assert.equal(p.amountRaw,String(100n*unit));
  assert.equal(p.minimumRaw,p.amountRaw);assert.equal(f.writes(),0);
  await f.send(p);f.s.confirmed=true;assert.equal((await f.create().handle('fourStatus',{profile:'fourmeme'})).operation.receivedAmount,'100.0');
});
test('OpenFour 99.99 percent keeps exact quantity buy payment cap and positive net sell minimum',async t=>{
 const f=await fixture(t),buy=await f.prepare({buyMode:'tokenAmount',amount:'100',slippageBps:'9999'}),sell=await f.prepare({action:'sell',amount:'10',slippageBps:'9999'});
 const buyCall=coreAbi.parseTransaction({data:buy.tx.inputData}),sellCall=coreAbi.parseTransaction({data:sell.tx.inputData});
 assert.equal(buyCall.args[2],(910000000000000000n*19999n+9999n)/10000n);assert.equal(BigInt(buy.spendRaw),buyCall.args[2]);assert.equal(BigInt(buy.tx.value),buyCall.args[2]);assert.equal(buy.minimumRaw,buy.amountRaw);
 assert.equal(BigInt(sell.minimumRaw),BigInt(sell.expectedRaw)/10000n);assert.ok(BigInt(sell.minimumRaw)>0n);assert.equal(sellCall.args[2],BigInt(sell.minimumRaw));assert.equal(f.writes(),0);
});

test('quantity limits derive from each token creation supply, current holdings and inventory',async t=>{
  const f=await fixture(t);f.s.maxSupply=100000n*unit;f.s.hold=900n*unit;f.s.remaining=50n*unit;
  const m=await f.reader.inspect(token),h=await f.reader.holdings(m,wallet);assert.equal(m.holdCap,'1000.0');assert.equal(h.holdRoom,'100.0');assert.equal(h.buyable,'50.0');
  await assert.rejects(()=>f.prepare({buyMode:'tokenAmount',amount:'101'}),{code:'OPENFOUR_BUY_LIMIT'});
  await assert.rejects(()=>f.prepare({buyMode:'tokenAmount',amount:'51'}),{code:'FOUR_QUANTITY_UNAVAILABLE'});
  const p=await f.prepare({buyMode:'tokenAmount',amount:'50'});assert.equal(p.expected,'50.0');
  f.s.partialBuy=40n*unit;await assert.rejects(()=>f.prepare({buyMode:'tokenAmount',amount:'50'}),{code:'FOUR_QUANTITY_UNAVAILABLE'});assert.equal(f.writes(),0);
});

test('quantity buy ERC20 approval uses quote decimals and maximum payment, never target token amount',async t=>{
  const f=await fixture(t,{ercQuote:true,quoteDecimals:6,allowance:0n});f.s.quoteCost=800000n;f.s.fee=110000n;
  const p=await f.prepare({buyMode:'tokenAmount',amount:'10.000000000000000001'}),c=erc20Abi.parseTransaction({data:p.tx.inputData});
  assert.equal(p.amountRaw,String(10n*unit+1n));assert.equal(p.spendRaw,'919100');assert.equal(p.approvalAmount,'0.9191');assert.equal(c.args[1],919100n);assert.equal(p.tx.value,'0x0');
  assert.equal(f.writes(),0);
});

test('quantity buy recheck blocks price over cap, lost room and insufficient maximum-payment balance',async t=>{
  for(const change of ['price','room','funds']){
    const f=await fixture(t),p=await f.prepare({buyMode:'tokenAmount',amount:'100'});
    if(change==='price'){f.s.quoteCost=160n*unit/100n;f.s.fee=22n*unit/100n;}
    if(change==='room')f.s.hold=10000000n*unit-99n*unit;
    if(change==='funds')f.s.native=BigInt(p.spendRaw)-1n;
    await assert.rejects(()=>f.send(p),e=>e.submissionNotStarted===true);assert.equal(f.writes(),0);
  }
});

test('quantity receipt records a cap-clamped fill but rejects excess quantity and wrong requested amount',async t=>{
  const f=await fixture(t),p=await f.prepare({buyMode:'tokenAmount',amount:'100'});await f.send(p);f.s.receiptBuy=90n*unit;f.s.confirmed=true;
  const op=(await f.create().handle('fourStatus',{profile:'fourmeme'})).operation;assert.equal(op.status,'COMPLETE');assert.equal(op.executedTokenAmount,'90.0');assert.match(op.message,/不会自动补买/);assert.equal(f.writes(),1);
  for(const wrong of ['excess','request']){const f=await fixture(t),p=await f.prepare({buyMode:'tokenAmount',amount:'100'});await f.send(p);f.s.confirmed=true;
    if(wrong==='excess')f.s.receiptBuy=101n*unit;else f.s.wrongRequested=true;
    const status=await f.create().handle('fourStatus',{profile:'fourmeme'});assert.equal(status.reconcileError.code,'FOUR_RECEIPT_MISMATCH');assert.notEqual(status.operation.status,'COMPLETE');}
});

test('compatible new Agent preset can quote with its own ID',async t=>{const f=await fixture(t);f.s.presetId='1000';const p=await f.prepare();assert.equal(p.presetId,'1000');assert.equal(p.protocol,'openfour-agent');assert.equal(f.writes(),0);});
