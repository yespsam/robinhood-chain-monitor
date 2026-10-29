import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as model from '../extension/trade-model.js';
import {fundingMessage,budgetMessage,automaticFailureMessage} from '../extension/funding-model.js';
import {createRoundtripLedger,token as ledgerToken,wallet as ledgerWallet} from './helpers/roundtrip-ledger.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),token=addr(1),wallet=addr(2),quote=addr(3);
const market={tokenAddress:token,base:{symbol:'T',decimals:18},quote:{address:quote,symbol:'GANG',decimals:18},supported:true,protocol:'gang-curve',variant:'v2',block:'0x1'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function ui(){
 class Element{constructor(){this.dataset={};this.value='';this.children=[];this.listeners={};this.style={};this.classList={toggle(){}};this.disabled=false;}addEventListener(k,f){this.listeners[k]=f;}fire(k,e={isTrusted:true}){return this.listeners[k]?.(e);}replaceChildren(...n){this.children=n;}append(...n){this.children.push(...n);}removeAttribute(k){delete this[k];}showModal(){this.open=true;}close(){this.open=false;}}
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},quickBuy=new Element(),quickSell=new Element();quickBuy.dataset.quickBuy='100000';quickSell.dataset.quickSell='50';
 const document={getElementById:get,querySelectorAll:s=>s.includes('data-quick')?[quickBuy,quickSell]:[],createElement:()=>new Element(),addEventListener(){},hidden:false};
 const calls=[];let handler=async r=>r.method==='panelStatus'?{wallet:{connected:true,address:wallet}}:{};
 let progress;const client={version:()=>'',onProgress(){},subscribe(name,fn){if(name==='trade')progress=fn;},storage:{get:async()=>({}),set:async()=>{}},sendMessage:async r=>{calls.push(r);return {ok:true,data:await handler(r)};}};
 const context=vm.createContext({...model,fundingMessage,budgetMessage,automaticFailureMessage,document,client,Date,performance,crypto:{randomUUID},isOfficialSigninUrl:()=>true,setupMarketChart:()=>({select(){}}),setupLocalFeatures(){},setInterval(){},window:{addEventListener(){}},location:{hash:''}});
 vm.runInContext((await readFile(new URL('../extension/trade-ui.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,''),context);
 for(let i=0;i<5;i++)await tick();context.marketInput=market;
 vm.runInContext(`market=marketInput;holdings={base:'100',quote:'0.0'};$('ca').value=market.tokenAddress;$('slippage').value='1';$('funding-slippage').value='1';renderMarket();`,context);calls.length=0;
 const settle=async()=>{for(let i=0;i<30;i++){await tick();if(!vm.runInContext('busy||polling',context))return;}throw Error('UI did not settle');};
 return {context,get,calls,quickBuy,quickSell,settle,client,progress:data=>progress(data),setHandler:f=>handler=f};
}
const preview=p=>({...market,...p,wallet,kind:p.action,amount:p.amount||'50',previewId:randomUUID(),expiresAt:Date.now()+60000,spend:'1',expected:'50',minimum:'49',estimatedGas:'0.0001',official:{},timing:{totalMs:100,walletMs:30,quoteMs:40,previewMs:30}});
test('quick sell makes one percentage preview request, opens review, and never submits automatically',async()=>{
 const u=await ui();u.setHandler(async r=>({tradePreview:preview(r.params)}));u.quickSell.fire('click');await u.settle();assert.deepEqual(u.calls.map(r=>r.method),['panelPrepare']);
 assert.equal(u.calls[0].params.sellPercent,'50');assert.equal(u.calls[0].params.amount,undefined);assert.equal(u.get('amount').value,'50');assert(u.get('review').open);assert.equal(u.get('ack').checked,false);assert(u.get('send').disabled);assert.match(u.get('quote-timing').textContent,/100 ms/);
});
test('quick buy uses token quantity and exposes its ERC20 funding asset before confirmation',async()=>{
 const u=await ui();assert.match(u.get('funding-title').textContent,/GANG/);assert.match(u.get('funding-balance').textContent,/0.0 GANG/);assert.equal(u.get('funding-ca').textContent,quote);
 u.setHandler(async r=>({tradePreview:preview(r.params)}));u.quickBuy.fire('click');await u.settle();assert.equal(u.calls.length,1);assert.equal(u.calls[0].params.amount,'100000');assert.equal(u.calls[0].params.buyMode,'tokenAmount');assert(u.get('review').open);assert(u.get('send').disabled);
});
test('a selection change while preview is pending discards the late result',async()=>{
 const u=await ui();let finish;u.setHandler(r=>new Promise(resolve=>{finish=()=>resolve({tradePreview:preview(r.params)});}));u.quickBuy.fire('click');await tick();
 vm.runInContext(`$('ca').value='${addr(9)}';clearMarket();`,u.context);finish();await u.settle();assert(!u.get('review').open);assert(u.get('send').disabled);
});
test('a quick click waits for status refresh and is not lost or sent twice',async()=>{
 const u=await ui();let finish;u.setHandler(r=>r.method==='panelStatus'?new Promise(resolve=>{finish=()=>resolve({wallet:{connected:true,address:wallet}});}):Promise.resolve({tradePreview:preview(r.params)}));
 const poll=vm.runInContext('refresh()',u.context);await tick();u.quickBuy.fire('click');u.quickBuy.fire('click');await tick();assert.equal(u.calls.length,1);finish();await poll;await u.settle();assert.deepEqual(u.calls.map(r=>r.method),['panelStatus','panelPrepare']);assert(u.get('review').open);
});
test('BNB funding opens a clearly separate swap review with no target-token submission',async()=>{
 const u=await ui();u.get('funding-enabled').checked=true;u.get('funding-slippage').value='2';
 u.setHandler(async r=>({tradePreview:{...preview(r.params),kind:'fund',fundingSettings:r.params.funding,funding:{available:'0',shortfall:'10'},gasReserve:'0.005'}}));u.quickBuy.fire('click');await u.settle();
 assert.equal(u.calls[0].params.funding.mode,'quantity');assert.equal(u.calls[0].params.funding.maxBnb,undefined);assert.equal(u.calls[0].params.funding.slippageBps,'200');assert.equal(u.calls.length,1);assert.equal(u.get('send').textContent,'确认兑换 GANG');assert.match(u.get('review-note').textContent,/不会买入目标/);assert.match(u.get('review-ack-text').textContent,/仅兑换/);assert(u.get('official-details').hidden);assert(u.get('send').disabled);
});
test('local one-click buy sends one bounded intent without opening a second confirmation, and progress unlocks only at completion',async()=>{
 const u=await ui();u.client.local=true;u.get('oneclick-enabled').checked=true;u.get('funding-slippage').value='1';vm.runInContext('render()',u.context);
 let op;u.setHandler(async r=>({operation:op={intentId:r.params.intentId,market:token,action:'panelAutoBuy',status:'SUBMITTING',createdAt:Date.now(),updatedAt:Date.now(),steps:[]}}));u.quickBuy.fire('click');u.quickBuy.fire('click');await u.settle();
 assert.equal(u.calls.length,1);assert.equal(u.calls[0].method,'panelTrade');assert.equal(u.calls[0].params.fundingMode,'quantity');assert.equal(u.calls[0].params.maxBnb,undefined);assert.equal(u.calls[0].params.wallet,wallet);assert.equal(u.calls[0].params.amount,'100000');assert(!u.get('review').open);assert(u.get('prepare').disabled);
 u.progress({operation:{...op,status:'COMPLETE',updatedAt:op.updatedAt+100,completedAt:op.createdAt+100,steps:[{action:'panelBuy',status:'CONFIRMED'}]}});assert(!u.get('prepare').disabled);assert.match(u.get('flow-timing').textContent,/全部到账/);
 u.progress({operation:{...op,intentId:'interrupted-other',status:'FAILED',updatedAt:op.updatedAt+200,steps:[]}});assert(!u.get('prepare').disabled);assert.match(u.get('flow-timing').textContent,/未提交交易/);assert.doesNotMatch(u.get('flow-timing').textContent,/链上确认中/);
});

test('legacy budget failure names the quantity and cap, hides empty steps and does not imply any funds moved',async()=>{
 const u=await ui();u.progress({operation:{intentId:randomUUID(),action:'panelAutoBuy',market:token,status:'FAILED',steps:[],request:{action:'buy',amount:'10000000.0',maxBnb:'0.1'},error:{code:'FUNDING_BUDGET_EXCEEDED'},message:'old opaque failure',updatedAt:Date.now()}});
 assert.match(u.get('status-title').textContent,/未提交交易/);assert.match(u.get('status-text').textContent,/10,000,000/);assert.match(u.get('status-text').textContent,/0.1/);assert.match(u.get('status-text').textContent,/平台持仓额度/);assert.doesNotMatch(u.get('status-text').textContent,/已完成的步骤保留/);assert(u.get('flow-steps').hidden);assert.match(u.get('flow-timing').textContent,/未提交交易/);assert(!u.get('prepare').disabled);
});
test('continuing a stopped buy uses one fresh intent and visible edited parameters without another modal',async()=>{
 const u=await ui();u.client.local=true;u.get('oneclick-enabled').checked=true;
 const op={intentId:randomUUID(),action:'panelAutoBuy',market:token,wallet,status:'FAILED',updatedAt:Date.now(),error:{code:'AUTO_PRICE_CHANGED'},request:{action:'buy',tokenAddress:token,wallet,amount:'10000000',slippageBps:'100',swapSlippageBps:'1000'},steps:[{action:'panelWrap',status:'CONFIRMED',plan:{...market,action:'buy'}}]};
 u.setHandler(async r=>r.method==='panelQuery'?{wallet:{connected:true,address:wallet},market,holdings:{base:'0',quote:'1'}}:{operation:{intentId:r.params.intentId,status:'SUBMITTING',action:'panelAutoBuy',market:token,wallet,steps:[]}});
 u.progress({operation:op});await u.settle();u.calls.length=0;assert(!u.get('continue-buy').hidden);assert.equal(u.get('continue-buy').textContent,'一键继续买入（当前参数）');assert.match(u.get('status-text').textContent,/买入滑点 1%/);assert.equal(u.get('amount').value,'10000000');assert.equal(u.get('funding-slippage').value,'10');
 u.get('amount').value='8000000';u.get('amount').fire('input');u.get('slippage').value='2';u.get('slippage').fire('input');
 u.get('continue-buy').fire('click');u.get('continue-buy').fire('click');await u.settle();assert.deepEqual(u.calls.map(r=>r.method),['panelTrade']);assert.equal(u.calls[0].params.amount,'8000000');assert.equal(u.calls[0].params.slippageBps,'200');assert.equal(u.calls[0].params.swapSlippageBps,'1000');assert.equal(u.calls[0].params.fundingMode,'quantity');assert.notEqual(u.calls[0].params.intentId,op.intentId);assert(!u.get('review').open);
 for(const changed of [{status:'UNKNOWN'},{status:'COMPLETE'},{wallet:addr(9)},{market:addr(9)},{steps:[{action:'panelBuy',status:'CONFIRMED'}]},{steps:[{action:'panelWrap',status:'UNKNOWN'}]}])assert.equal(model.canReviewStoppedBuy({...op,...changed},wallet,token),false);
});
for(const kind of ['fund','wrap','approve','buy'])test(`one-click quote for ${kind} stays read-only until one full-flow buy click, never a single-step approval`,async()=>{
 const u=await ui();u.client.local=true;u.get('oneclick-enabled').checked=true;u.get('amount').value='3';u.get('funding-enabled').checked=false;
 u.setHandler(async r=>r.method==='panelPrepare'?{tradePreview:{...preview(r.params),kind,approvalRaw:'100',funding:{required:'10',available:'1',shortfall:'9'},fundingSettings:r.params.funding}}:{operation:{intentId:r.params.intentId,status:'SUBMITTING',market:token,action:'panelAutoBuy',steps:[]}});
 vm.runInContext('render()',u.context);u.get('preview-only').fire('click');await u.settle();assert.deepEqual(u.calls.map(r=>r.method),['panelPrepare']);assert.equal(u.calls[0].params.funding.mode,'quantity');assert(u.get('review').open);assert(u.get('review-ack').hidden);assert(!u.get('send').disabled);assert.match(u.get('send').textContent,/一键买入/);assert.match(u.get('review-note').textContent,/自动兑换缺口/);assert.doesNotMatch(u.get('review-note').textContent,/本次仅|本次只/);
 u.get('send').fire('click',{isTrusted:false});assert.equal(u.calls.length,1);u.get('send').fire('click');u.get('send').fire('click');await u.settle();assert.deepEqual(u.calls.map(r=>r.method),['panelPrepare','panelTrade']);assert.equal(u.calls[1].params.amount,'3');assert.equal(u.calls[1].params.fundingMode,'quantity');assert(!u.get('review').open);
});
test('one-click quote captures visible quantities, blocks expired or changed forms, and can be closed without buying',async()=>{
 for(const change of ['cancel','amount','wallet','expiry']){const u=await ui();u.client.local=true;u.get('oneclick-enabled').checked=true;u.get('amount').value='3';u.setHandler(async r=>({tradePreview:preview(r.params)}));vm.runInContext('render()',u.context);u.get('preview-only').fire('click');await u.settle();
  if(change==='cancel')u.get('cancel').fire('click');if(change==='amount'){u.get('amount').value='4';u.get('amount').fire('input');}if(change==='wallet')vm.runInContext(`wallet.address='${addr(9)}';render()`,u.context);if(change==='expiry')vm.runInContext('preview.expiresAt=0',u.context);
  u.get('send').fire('click');await u.settle();assert.deepEqual(u.calls.map(r=>r.method),['panelPrepare']);
 }
 const u=await ui();u.client.local=true;u.get('oneclick-enabled').checked=true;vm.runInContext("side='sell';",u.context);u.setHandler(async r=>r.method==='panelPrepare'?{tradePreview:preview(r.params)}:{operation:{intentId:r.params.intentId,status:'SUBMITTING'}});await vm.runInContext("prepare('sell','50')",u.context);u.get('send').fire('click');await u.settle();assert.equal(u.calls[1].params.action,'sell');assert.equal(u.calls[1].params.amount,'50');assert.equal(u.calls[1].params.sellPercent,undefined);
});
test('a completed manual funding or approval can continue once only for its wallet and CA',async()=>{
 for(const action of ['panelFund','panelWrap','panelApprove']){const op={action,status:'COMPLETE',wallet,market:token,steps:[{status:'CONFIRMED',plan:{wallet,tokenAddress:token,action:'buy',amount:'3',slippageBps:'100'}}]};assert.equal(model.continuationBuyRequest(op,wallet,token),op.steps[0].plan);
  assert.equal(model.continuationBuyRequest(op,addr(9),token),null);assert.equal(model.continuationBuyRequest(op,wallet,addr(9)),null);assert.equal(model.continuationBuyRequest({...op,status:'UNKNOWN'},wallet,token),null);
 }
});
test('one browser buy click completes funding and allowances, then one sell click completes proceeds conversion with the ledger',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'oneclick-ui-ledger-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=createRoundtripLedger(dir,{oldAllowance:true}),u=await ui();u.client.local=true;u.get('oneclick-enabled').checked=true;
 u.context.ledgerMarket=await f.reader.inspect(ledgerToken);u.context.ledgerHoldings=await f.reader.holdings(u.context.ledgerMarket,ledgerWallet);
 vm.runInContext(`market=ledgerMarket;holdings=ledgerHoldings;wallet={connected:true,address:'${ledgerWallet}'};$('ca').value=market.tokenAddress;$('amount').value='10000000';$('slippage').value='10';renderMarket();`,u.context);
 let responseDone=Promise.resolve();u.setHandler(r=>(responseDone=f.trader.handle(r.method,r.params)));u.get('order-form').fire('submit',{isTrusted:true,preventDefault(){}});await tick();await responseDone;await u.settle();await f.trader.drain();
 const buyRequest=u.calls.find(r=>r.method==='panelTrade'),bought=await f.journal.read(buyRequest.params.intentId);assert.equal(bought.status,'COMPLETE',JSON.stringify(bought.error));assert.deepEqual(f.state.submissions.map(x=>x.kind),['fund','revoke','approve','buy']);assert(!u.get('review').open);assert(!u.calls.some(r=>r.method==='panelExecute'));
 u.progress({operation:bought});await responseDone;await tick();u.quickSell.fire('click');await tick();await responseDone;await u.settle();await f.trader.drain();
 const trades=u.calls.filter(r=>r.method==='panelTrade');assert.equal(trades.length,2);assert.equal(trades[1].params.sellPercent,'50');assert.equal((await f.journal.read(trades[1].params.intentId)).status,'COMPLETE');assert.deepEqual(f.state.submissions.map(x=>x.kind),['fund','revoke','approve','buy','revoke','approve','sell','convert']);assert(!u.get('review').open);assert(!u.calls.some(r=>r.method==='panelExecute'));
});
test('completed multi-step flow links to final buy receipt instead of the earlier funding transaction',async()=>{
 const u=await ui(),fundHash='0x'+'1'.repeat(64),buyHash='0x'+'2'.repeat(64);
 u.progress({operation:{intentId:randomUUID(),action:'panelAutoBuy',market:token,status:'COMPLETE',updatedAt:Date.now(),txHash:fundHash,steps:[{action:'panelFund',status:'CONFIRMED',txHash:fundHash},{action:'panelBuy',status:'CONFIRMED',txHash:buyHash}]}});
 assert.equal(u.get('tx-link').href,'https://bscscan.com/tx/'+buyHash);assert.equal(u.get('tx-link').hidden,false);
});
test('settled buy refreshes holdings once, enables sell shortcuts, and preserves entered quantity',async()=>{
 const u=await ui();vm.runInContext("holdings={base:'0',quote:'0'};$('amount').value='123';renderMarket();",u.context);assert(u.quickSell.disabled);
 u.setHandler(async r=>({wallet:{connected:true,address:wallet},market,holdings:{base:'98',quote:'1',native:'2'}}));
 const op={intentId:randomUUID(),action:'panelAutoBuy',market:token,status:'COMPLETE',updatedAt:Date.now(),steps:[{action:'panelBuy',status:'CONFIRMED'}]};u.progress({operation:op});await u.settle();
 assert.deepEqual(u.calls.map(c=>c.method),['panelQuery']);assert.equal(u.get('base-balance').textContent,'98');assert(!u.quickSell.disabled);assert.equal(u.get('amount').value,'123');
 u.progress({operation:op});await u.settle();assert.equal(u.calls.length,1);
});
test('settled sell refreshes zero position and disables selling again',async()=>{
 const u=await ui();u.setHandler(async()=>({wallet:{connected:true,address:wallet},market,holdings:{base:'0',quote:'1',native:'2'}}));
 u.progress({operation:{intentId:randomUUID(),action:'panelAutoSell',market:token,status:'COMPLETE',updatedAt:Date.now(),steps:[{action:'panelSell',status:'CONFIRMED'}]}});await u.settle();assert.equal(u.get('base-balance').textContent,'0');assert(u.quickSell.disabled);
});
test('late settlement balance cannot replace another selected CA, and another token completion causes no read',async()=>{
 const u=await ui();let finish;u.setHandler(()=>new Promise(resolve=>{finish=()=>resolve({wallet:{connected:true,address:wallet},market,holdings:{base:'999'}});}));
 u.progress({operation:{intentId:randomUUID(),action:'panelAutoBuy',market:token,status:'COMPLETE',updatedAt:Date.now(),steps:[{action:'panelBuy',status:'CONFIRMED'}]}});
 vm.runInContext(`$('ca').value='${addr(9)}';clearMarket();`,u.context);finish();await u.settle();assert.equal(u.get('base-balance').textContent,'—');assert.equal(vm.runInContext('market',u.context),null);
 const v=await ui();v.progress({operation:{intentId:randomUUID(),action:'panelAutoBuy',market:addr(9),status:'COMPLETE',steps:[{action:'panelBuy',status:'CONFIRMED'}]}});await v.settle();assert.equal(v.calls.length,0);
});
test('local one-click sell freezes percentage in its intent and only-preview stays read-only',async()=>{
 const u=await ui();u.client.local=true;u.get('oneclick-enabled').checked=true;u.get('funding-slippage').value='2';vm.runInContext('render()',u.context);u.setHandler(async r=>({operation:{intentId:r.params.intentId,status:'SUBMITTING'}}));u.quickSell.fire('click');await u.settle();assert.equal(u.calls.length,1);assert.equal(u.calls[0].method,'panelTrade');assert.equal(u.calls[0].params.sellPercent,'50');assert.equal(u.calls[0].params.swapSlippageBps,'200');assert.equal(u.calls[0].params.maxBnb,undefined);
 const v=await ui();v.client.local=true;v.get('oneclick-enabled').checked=true;v.get('amount').value='3';vm.runInContext('render()',v.context);v.setHandler(async r=>({tradePreview:preview(r.params)}));v.get('preview-only').fire('click');await v.settle();assert.deepEqual(v.calls.map(x=>x.method),['panelPrepare']);assert(v.get('review').open);
});

test('graduated GANG sell is enabled and DEX preview shows real route without claiming contract simulation',async()=>{
 const u=await ui();u.client.local=true;u.get('oneclick-enabled').checked=true;
 vm.runInContext("market={...market,protocol:'dex-swap',quote:{address:'0x'+'0'.repeat(40),symbol:'BNB',decimals:18}};side='sell';renderMarket();",u.context);
 assert(!u.get('prepare').disabled);assert(u.get('swap-slippage-label').hidden);assert.match(u.get('route-note').textContent,/DEX/);assert.match(u.get('oneclick-note').textContent,/所选代币/);
 u.get('amount').value='97';u.setHandler(async r=>({tradePreview:{...preview(r.params),protocol:'dex-swap',quote:{address:'0x'+'0'.repeat(40),symbol:'BNB',decimals:18},estimatedGas:undefined,gasReserve:'0.005'}}));
 u.get('preview-only').fire('click');await u.settle();assert.deepEqual(u.calls.map(r=>r.method),['panelPrepare']);assert(u.get('review').open);assert(u.get('official-details').hidden);assert.match(u.get('review-title').textContent,/DEX 卖出/);
 assert.doesNotMatch(u.get('review-facts').children.map(n=>n.textContent).join(' '),/undefined/);assert.match(u.get('risk-summary').textContent,/尚未提交/);assert.match(u.get('status-title').textContent,/报价已返回/);
 vm.runInContext("holdings.base='0.0';render();",u.context);assert(u.get('prepare').disabled);assert.match(u.get('prepare').textContent,/无可卖余额/);assert.match(u.get('amount-hint').textContent,/收款钱包/);
});
