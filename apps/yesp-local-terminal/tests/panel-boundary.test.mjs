import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateRequest as browserRequest} from '../extension/background.js';
import {validateRequest as nativeRequest} from '../scripts/flap-native-host.mjs';
import {parseCA,percentAmount,slippageBps,transferBlocked} from '../extension/trade-model.js';
import {validateSlippageBps} from '../extension/slippage-policy.js';
import {createFourTrader} from '../server/four-trader.mjs';
import {FlapJournal} from '../server/flap-journal.mjs';
const id='elekekjeabljofoefoccekebfdalomfp',addr=n=>'0x'+n.toString(16).padStart(40,'0'),wallet=addr(1),token=addr(2),manager=addr(3);
test('slippage above the old 20 percent cap passes browser/native boundaries with exact basis point precision',()=>{
 const url=`chrome-extension://${id}/trade.html`,sender={id,frameId:0,url,tab:{id:1,url}};
 for(const percent of ['0.01','20.01','99','99.99'])for(const action of ['buy','sell']){
  const bps=slippageBps(percent),request={id:randomUUID(),method:'panelPrepare',params:{profile:'unified',tokenAddress:token,action,amount:'100',slippageBps:bps,...(action==='buy'?{buyMode:'tokenAmount'}:{})}};
  assert.equal(browserRequest(request,sender,id).params.slippageBps,bps);assert.equal(nativeRequest(request).params.slippageBps,bps);
 }
 for(const percent of ['0','100','101','99.999','-1','NaN','Infinity','1e1',''])assert.throws(()=>slippageBps(percent),{code:'INVALID_SLIPPAGE'});
 for(const bps of ['0','10000','-1','1.5','Infinity',9900])assert.throws(()=>validateSlippageBps(bps),{code:'INVALID_SLIPPAGE'});
});
test('unified methods accept only the dedicated top-level extension page and typed quantity requests',()=>{
 const url=`chrome-extension://${id}/trade.html#${token}`,sender={id,frameId:0,url,tab:{id:1,url}};
 const r={id:randomUUID(),method:'panelPrepare',params:{profile:'unified',tokenAddress:token,action:'buy',amount:'100',slippageBps:'100',buyMode:'tokenAmount'}};
 assert.equal(browserRequest(r,sender,id).method,'panelPrepare');assert.equal(nativeRequest(r).params.profile,'unified');
 for(const bad of [{...sender,frameId:1},{...sender,url:'https://four.meme'},{...sender,url:`chrome-extension://${id}/wallet.html`},{...sender,tab:{id:1,url:'https://flap.sh/apps/agent-bonding-curve'}}])assert.throws(()=>browserRequest(r,bad,id));
 for(const params of [{...r.params,buyMode:undefined},{...r.params,to:addr(9)},{...r.params,profile:'heyi'},{...r.params,slippageBps:'10000'}])assert.throws(()=>nativeRequest({...r,params}));
 assert.equal(browserRequest({id:randomUUID(),method:'signin',params:{profile:'heyi'}},sender,id).method,'signin');
 assert.throws(()=>browserRequest({id:randomUUID(),method:'transferPrepare',params:{profile:'heyi'}},sender,id));
});
test('CA URLs and large percentage amounts are parsed without Number precision loss',()=>{
 assert.equal(parseCA(`https://four.meme/zh-TW/token/${token}`),token);assert.equal(parseCA(`https://flap.sh/bnb/${token}`),token);
 for(const value of [`https://evil.example/${token}`,`https://four.meme/${token}/${wallet}`,ZERO,'0x12'])assert.equal(parseCA(value),null);
 assert.equal(percentAmount('12345678901234567890.123456789123456789',18,25),'3086419725308641972.530864197280864197');
 assert.equal(percentAmount('1.123456789999999999',18,100,true),'1.123456789');assert.equal(slippageBps('0.01'),'1');assert.equal(slippageBps('99'),'9900');assert.equal(slippageBps('99.99'),'9999');assert.throws(()=>slippageBps('100'));
});
const ZERO='0x'+'0'.repeat(40);

test('inline transfer is restricted to own top-level trade page, with typed transfer fields',()=>{
 const url=`chrome-extension://${id}/trade.html#${token}`,sender={id,frameId:0,url,tab:{id:1,url}};
 const r={id:randomUUID(),method:'transferPrepare',params:{profile:'heyi',tokenAddress:token,recipient:addr(4),amount:'1'}};
 assert.equal(browserRequest(r,sender,id).method,'transferPrepare');assert.equal(nativeRequest(r).method,'transferPrepare');
 for(const bad of [{...sender,frameId:1},{...sender,url:'https://flap.sh/apps/agent-bonding-curve'},{...sender,tab:{id:1,url:'https://four.meme'}}])assert.throws(()=>browserRequest(r,bad,id));
 for(const params of [{...r.params,amount:'max'},{...r.params,to:addr(9)},{...r.params,profile:'unified'}])assert.throws(()=>browserRequest({...r,params},sender,id));
});
test('virtual positions and locked Agent tokens cannot be presented as transferable ERC20 balances',()=>{
 assert.match(transferBlocked({protocol:'flap-agent',phase:1}),/虚拟份额/);
 assert.match(transferBlocked({protocol:'flap-agent',phase:3}),/领取/);
 assert.match(transferBlocked({protocol:'openfour-agent',transferLocked:true}),/锁定/);
 assert.equal(transferBlocked({protocol:'openfour-agent',transferLocked:false}),null);
 assert.equal(transferBlocked({protocol:'flap-standard',agentMarket:{phase:3},supported:false}),null);
});
test('unified execution is one-shot, durable, and an unknown result blocks the old Four engine too',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'yesp-panel-'));t.after(()=>rm(directory,{recursive:true,force:true}));const journal=new FlapJournal(directory);let executions=0;
 const cli={status:async()=>({status:'CONNECTED'}),addresses:async()=>({addresses:[{binanceChainId:'56',address:wallet}]}),settings:async()=>({devMode:{enabled:true}}),txLock:async()=>({status:'UNLOCKED'}),
  previewContract:async()=>({outcome:'PREVIEWED',data:{requestId:'opaque',expiresAt:Date.now()+60000,parsedTx:{contractAddress:manager},simulationResult:{simulationCode:'000000000',balanceChanges:[],allowanceChanges:[],authorityChanges:[]},risks:{riskDetails:[],riskBehaviors:[],addresses:{}}}}),
  executePreview:async()=>{executions++;return {outcome:'UNKNOWN'};}};
 const plan={protocol:'flap-agent',chainId:'56',kind:'sell',action:'sell',wallet,tokenAddress:token,manager,amountRaw:'100',nonce:'0x1',tx:{from:wallet,to:manager,value:'0x0',inputData:'0x12345678'}};
 const reader={build:async()=>plan,recheck:async()=>{}};
 const panel=createFourTrader({cli,reader,journal,panel:true,allowWrites:true}),four=createFourTrader({cli,reader,journal,allowWrites:true});
 const params={profile:'unified',tokenAddress:token,action:'sell',amount:'100',slippageBps:'100'};
 const preview=(await panel.handle('panelPrepare',params)).tradePreview;assert.equal(executions,0);
 const sent=await panel.handle('panelExecute',{profile:'unified',previewId:preview.previewId,intentId:randomUUID()});assert.equal(sent.operation.status,'UNKNOWN');assert.equal(sent.operation.action,'panelSell');assert.equal(executions,1);
 await assert.rejects(()=>panel.handle('panelExecute',{profile:'unified',previewId:preview.previewId,intentId:randomUUID()}),{code:'PREVIEW_EXPIRED'});
 await assert.rejects(()=>four.handle('fourPrepare',{...params,profile:'fourmeme'}),{code:'UNRESOLVED_TRADE_EXISTS'});assert.equal((await journal.all()).length,1);
});
