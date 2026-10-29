import test from 'node:test';
import assert from 'node:assert/strict';
import {createFourTrader} from '../server/four-trader.mjs';
import {validatePanelParams} from '../extension/trade-policy.js';
const token='0x'+'1'.repeat(40),address='0x'+'2'.repeat(40),params={profile:'unified',tokenAddress:token};
const fail=code=>Object.assign(Error('private upstream message'),{code,details:{apiKey:'never expose'}});
const journal={all:async()=>[]};
for(const protocol of ['flap-standard','flap-agent','openfour-agent','gang-curve','dex-swap'])test(`${protocol}: public lookup survives wallet failure and trading still checks live authorization`,async()=>{
 const market={protocol,tokenAddress:token};let reads=0,builds=0;
 const cli={status:async()=>{reads++;throw fail('WALLET_NETWORK_ERROR');},addresses:async()=>({addresses:[{binanceChainId:'56',address}]}),settings:async()=>({devMode:{enabled:true}}),txLock:async()=>({status:'UNLOCKED'})};
 const reader={inspect:async()=>market,holdings:async()=>{throw Error('must not read balances without connected wallet');},build:async()=>{builds++;}};
 const t=createFourTrader({reader,cli,journal,panel:true});
 assert.deepEqual(await t.handle('panelQuery',{...params,marketOnly:true}),{market});assert.equal(reads,0);
 const q=await t.handle('panelQuery',params);assert.equal(q.market,market);assert.equal(q.holdings,null);assert.equal(q.wallet.connected,false);assert.equal(q.wallet.unavailable,true);assert.deepEqual(q.wallet.error,{code:'WALLET_NETWORK_ERROR'});assert(!JSON.stringify(q).includes('private'));
 await assert.rejects(()=>t.handle('panelPrepare',{...params,action:'buy',amount:'100',slippageBps:'100',buyMode:'tokenAmount'}),{code:'WALLET_NETWORK_ERROR'});assert.equal(builds,0);
});
test('wallet display requests share only an in-flight read and expose the operation even during failure',async()=>{
 let finish,calls=0;const operation={intentId:'past',action:'panelAutoBuy',status:'FAILED'};
 const t=createFourTrader({cli:{status:()=>{calls++;return new Promise((_,reject)=>{finish=()=>reject(fail('WALLET_READ_TIMEOUT'));});}},reader:{inspect:async()=>({tokenAddress:token})},journal:{all:async()=>[operation]},panel:true});
 const a=t.handle('panelStatus',{profile:'unified'}),b=t.handle('panelQuery',params);await new Promise(setImmediate);assert.equal(calls,1);finish();
 const [status,q]=await Promise.all([a,b]);assert.equal(status.operation,operation);assert.deepEqual(status.wallet,q.wallet);
 const next=t.handle('panelStatus',{profile:'unified'});await new Promise(setImmediate);assert.equal(calls,2);finish();await next;
});
test('holdings failure keeps recognized market and reports unavailable rather than zero',async()=>{
 const market={tokenAddress:token};const t=createFourTrader({panel:true,journal,reader:{inspect:async()=>market,holdings:async()=>{throw fail('RPC_UNAVAILABLE');}},cli:{status:async()=>({status:'CONNECTED'}),addresses:async()=>({addresses:[{binanceChainId:'56',address}]})}});
 const q=await t.handle('panelQuery',params);assert.equal(q.market,market);assert.equal(q.wallet.connected,true);assert.equal(q.holdings,null);assert.deepEqual(q.holdingsError,{code:'RPC_UNAVAILABLE'});
});
test('chain or binding failures remain errors and marketOnly cannot bypass write validation',async()=>{
 const t=createFourTrader({panel:true,journal,cli:{},reader:{inspect:async()=>{throw fail('MARKET_BINDING_CHANGED');}}});
 await assert.rejects(()=>t.handle('panelQuery',{...params,marketOnly:true}),{code:'MARKET_BINDING_CHANGED'});
 for(const value of [null,'true',1,{},[]])assert.throws(()=>validatePanelParams('panelQuery',{...params,marketOnly:value}),{code:'INVALID_REQUEST'});
 assert.throws(()=>validatePanelParams('panelPrepare',{...params,marketOnly:true,action:'buy',amount:'100',slippageBps:'100',buyMode:'tokenAmount'}),{code:'INVALID_REQUEST'});
});
