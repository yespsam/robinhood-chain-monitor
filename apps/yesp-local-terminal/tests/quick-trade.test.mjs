import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createReadScopeRpc} from '../server/read-scope.mjs';
import {createPanelRouter} from '../server/panel-router.mjs';
import {createFourTrader} from '../server/four-trader.mjs';
import {validateRequest as nativeRequest} from '../scripts/flap-native-host.mjs';
import {validateRequest as browserRequest} from '../extension/background.js';
import {safeFunding,fundingMessage} from '../extension/funding-model.js';
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),token=addr(1),wallet=addr(2),manager=addr(3),err=code=>Object.assign(Error(code),{code});
test('a read scope coalesces pinned reads but refreshes each preview, gas and pending nonce',async()=>{
 const calls=[];let value='0x1';const rpc=createReadScopeRpc(async(method,p)=>{calls.push([method,p]);return value;});
 await rpc.withReadScope(async()=>{assert.deepEqual(await Promise.all([rpc('eth_getBalance',[wallet,'0x100']),rpc('eth_getBalance',[wallet,'0x100'])]),['0x1','0x1']);
  for(let i=0;i<2;i++)for(const [m,p] of [['eth_getTransactionCount',[wallet,'pending']],['eth_estimateGas',[{}]],['eth_getBalance',[wallet,'latest']]])await rpc(m,p);
 });
 assert.equal(calls.length,7);value='0x2';assert.equal(await rpc.withReadScope(()=>rpc('eth_getBalance',[wallet,'0x100'])),'0x2');assert.equal(calls.length,8);
 await Promise.all([rpc.withReadScope(()=>rpc('eth_getBalance',[wallet,'0x100'])),rpc.withReadScope(()=>rpc('eth_getBalance',[wallet,'0x100']))]);assert.equal(calls.length,10);
});
test('failed pinned reads are evicted, and RPC errors retain the probe data',async()=>{
 let n=0;const rpc=createReadScopeRpc(async()=>{if(++n===1)throw Object.assign(err('RPC_CALL_FAILED'),{rpcError:{data:'0x1234'}});return '0x2';});
 await rpc.withReadScope(async()=>{assert.equal((await rpc.batch([['eth_call',[{},'0x10']]]))[0].error.data,'0x1234');assert.equal(await rpc('eth_call',[{},'0x10']),'0x2');});assert.equal(n,2);
});
test('route hints skip classification only, re-read market state, expire and never mask RPC failure',async()=>{
 const calls=[];let now=0,phase=1,broken=false;
 const readers={agent:{inspect:async()=>{calls.push('agent');throw err('NOT_FLAP_AGENT');}},standard:{inspect:async()=>{calls.push('standard');throw err('NOT_FLAP_TOKEN');}},four:{inspect:async()=>{calls.push('four');throw err('NOT_FOUR_TOKEN');}},gang:{inspect:async()=>{calls.push('gang');if(broken)throw err('RPC_UNAVAILABLE');return {protocol:'gang-curve',phase};}}};
 const router=createPanelRouter({rpc:async()=>{},readers,clock:()=>now});assert.equal((await router.inspect(token)).phase,1);assert.equal(calls.length,4);phase=3;
 assert.equal((await router.inspect(token)).phase,3);assert.equal(calls.length,5);broken=true;await assert.rejects(()=>router.inspect(token),{code:'RPC_UNAVAILABLE'});assert.equal(calls.length,6);
 broken=false;now=300001;await router.inspect(token);assert.equal(calls.length,10);
});
test('percentage sells pass both boundaries, forbid ambiguous amounts and never accept buys',()=>{
 const id='elekekjeabljofoefoccekebfdalomfp',url=`chrome-extension://${id}/trade.html`,sender={id,frameId:0,url,tab:{id:1,url}};
 const r={id:randomUUID(),method:'panelPrepare',params:{profile:'unified',tokenAddress:token,action:'sell',sellPercent:'100',slippageBps:'100'}};
 for(const p of ['25','50','75','100']){r.params.sellPercent=p;assert.equal(nativeRequest(r).params.sellPercent,p);assert.equal(browserRequest(r,sender,id).params.sellPercent,p);}
 for(const bad of [{sellPercent:'101'},{sellPercent:100},{amount:'1'},{action:'buy'},{buyMode:'tokenAmount'},{inputData:'0x1234'}])assert.throws(()=>nativeRequest({...r,params:{...r.params,...bad}}));
});
test('percentage preview computes latest exact holdings once and cannot execute without explicit confirmation',async()=>{
 let balance='12345678901234567890.123456789123456789',builds=[],previews=0,writes=0,nonce=1;
 const reader={rpc:createReadScopeRpc(async()=>{}),inspect:async()=>({base:{decimals:18}}),holdings:async()=>({base:balance}),build:async(p,w)=>{builds.push(p);return {...p,kind:'sell',wallet:w,nonce,base:{decimals:18,symbol:'T'},quote:{symbol:'BNB'},tx:{from:w,to:manager,value:'0x0',inputData:'0x12345678'}};},recheck:async p=>{if(p.nonce!==nonce)throw err('PREVIEW_EXPIRED');}};
 const cli={status:async()=>({status:'CONNECTED'}),addresses:async()=>({addresses:[{binanceChainId:'56',address:wallet}]}),settings:async()=>({devMode:{enabled:true}}),txLock:async()=>({status:'UNLOCKED'}),previewContract:async()=>{previews++;return {outcome:'PREVIEWED',data:{requestId:'mock',expiresAt:Date.now()+60000,parsedTx:{contractAddress:manager},simulationResult:{simulationCode:'000000000',balanceChanges:[],allowanceChanges:[],authorityChanges:[]},risks:{riskDetails:[],riskBehaviors:[],addresses:{}}}};},executePreview:async()=>{writes++;throw Error('must not send');}};
 const journal={all:async()=>[],exclusive:fn=>fn(),read:async()=>null},trader=createFourTrader({reader,cli,journal,panel:true,allowWrites:true}),p={profile:'unified',tokenAddress:token,action:'sell',sellPercent:'25',slippageBps:'100'};
 let result=await trader.handle('panelPrepare',p);assert.equal(builds[0].amount,'3086419725308641972.530864197');assert.equal(builds[0].sellPercent,undefined);assert.equal(result.tradePreview.sellPercent,'25');assert(result.tradePreview.timing.totalMs>=0);assert.equal(writes,0);
 balance='8';result=await trader.handle('panelPrepare',p);assert.equal(builds[1].amount,'2');assert.equal(writes,0);nonce++;
 await assert.rejects(()=>trader.handle('panelExecute',{profile:'unified',previewId:result.tradePreview.previewId,intentId:randomUUID()}),{code:'PREVIEW_EXPIRED'});assert.equal(writes,0);
 balance='0';await assert.rejects(()=>trader.handle('panelPrepare',p),{code:'INSUFFICIENT_BALANCE'});assert.equal(previews,2);
});
test('funding errors expose only public typed fields and retain exact decimal precision',()=>{
 const f={assetAddress:token,symbol:'GANG',required:'1.000000000000000001',available:'0.0',shortfall:'1.000000000000000001',stderr:'secret'};
 assert.equal(safeFunding(f).stderr,undefined);assert.match(fundingMessage(f),/GANG 不足/);assert.match(fundingMessage(f),/1\.000000000000000001/);
 for(const value of [{...f,shortfall:'Infinity'},{...f,required:1},{...f,assetAddress:'evil'},{...f,symbol:'x\nsecret'}])assert.equal(safeFunding(value),null);
});
