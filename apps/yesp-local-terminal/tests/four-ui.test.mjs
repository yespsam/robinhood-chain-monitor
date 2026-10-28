import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
const address=n=>'0x'+String(n).repeat(40),tick=()=>new Promise(setImmediate);
async function panel({connected=true,supported=true,kind='buy',reply,own=false,open=false,action='buy',pathname,holdings=null}={}){
  const nodes=new Map(),calls=[],intervals=[];let time=Date.now(),operation=null;
  class Node{
    constructor(tag){this.tagName=tag;this.value='';this.listeners={};this.children=[];this.checked=false;this.style={};}
    set id(value){this._id=value;nodes.set(value,this);}get id(){return this._id;}
    setAttribute(k,v){this[k]=v;}append(...nodes){this.children.push(...nodes);}replaceChildren(){this.children=[];}
    addEventListener(k,fn){this.listeners[k]=fn;}attachShadow(o){this.shadowMode=o.mode;return new Node('shadow');}scrollIntoView(){}
  }
  const id='elekekjeabljofoefoccekebfdalomfp',location=own?{protocol:'chrome-extension:',hostname:id,pathname:'/four.html',hash:'#'+address(2)}:
    {origin:'https://four.meme',protocol:'https:',hostname:'four.meme',pathname:pathname||'/zh-TW/token/'+address(2),hash:''};
  const wallet={connected,address:address(1)},market={supported,tokenAddress:address(2),base:{symbol:'TEST',address:address(2)},quote:{symbol:'BNB',address:'0x'+'0'.repeat(40)},version:2,funds:'1',maxFunds:'10',blockers:supported?[]:['FOUR_TAX_MODE']};
  if(open)Object.assign(market,{protocol:'openfour-agent',preset:{name:'Binance Agent ID Exclusive'},holdCap:'10000000',tax:{buyFeeRate:'1000',sellFeeRate:'1000',rateFounder:'100',rateHolder:'0',rateBurn:'0',rateLiquidity:'0'}});
  const preview={...market,...(action==='buy'?{buyMode:'tokenAmount',estimatedSpend:'0.009'}:{}),...(open?{minimumKind:'net',estimatedSpend:'0.009',holdRoom:'100',totalFee:'0.001'}:{}),previewId:randomUUID(),expiresAt:time+60000,wallet:wallet.address,kind,action,amount:'100',slippageBps:'100',manager:address(3),
    approvalToken:address(2),approvalRaw:'1000',spend:'0.01',expected:'100',minimum:'99',protocolFee:'0.0001',nativeValue:'0.01',estimatedGas:'0.0001',tx:{},official:{risks:{riskDetails:[{description:'Test risk'}]}}};
  const window={};window.top=window;
  const context=vm.createContext({window,location,document:{hidden:false,documentElement:new Node('html'),getElementById:id=>nodes.get(id),createElement:tag=>new Node(tag)},
    Date:{now:()=>time},crypto:{randomUUID},setInterval(fn,ms){intervals.push({fn,ms});},chrome:{runtime:{id,getURL:path=>'chrome-extension://'+id+'/'+path,onMessage:{addListener(){}},
    async sendMessage(r){calls.push(structuredClone(r));if(reply){const result=await reply(r);if(result)return result;}
      let data={wallet,operation},guard=operation?{intentId:operation.intentId}:null;
      if(r.method==='fourQuery')data={wallet,market,holdings};
      if(r.method==='fourPrepare')data={wallet,fourPreview:preview};
      if(r.method==='fourExecute'){operation={action:'fourBuy',intentId:r.params.intentId,status:'UNKNOWN',message:'结果待核验'};data={wallet,operation};guard={intentId:operation.intentId};}
      return {ok:true,data,guard};}}}});
  vm.runInContext(await readFile(new URL('../extension/four-ui.js',import.meta.url),'utf8'),context);await tick();await tick();
  const node=id=>{assert.ok(nodes.has(id),'missing '+id);return nodes.get(id);};
  async function event(id,type='click',isTrusted=true){await node(id).listeners[type]({isTrusted,preventDefault(){}});await tick();}
  return {node,calls,preview,market,wallet,location,event,async ready(){await event('query');node('side').value=action;node('amount').value='100';await event('four-form','submit');},
    async ack(){node('ack').checked=true;await event('ack','change');},async advance(ms){time+=ms;for(const i of intervals)if(i.ms===1000)await i.fn();}};
}
test('Four page is isolated and only prepares after trusted query; exact preview needs checked confirmation',async()=>{
  const p=await panel();assert.equal(p.node('yesp-four-panel').shadowMode,'closed');assert.deepEqual(p.calls.map(r=>r.method),['fourStatus']);
  await p.event('query','click',false);await p.event('four-form','submit',false);assert.equal(p.calls.length,1);
  await p.ready();assert.equal(p.node('send').disabled,true);assert.match(p.node('official-preview').textContent,/Test risk/);assert.match(p.node('risk-summary').textContent,/Test risk/);
  await p.event('send');assert.equal(p.calls.some(r=>r.method==='fourExecute'),false);await p.ack();
  await Promise.all([p.event('send'),p.event('send')]);assert.equal(p.calls.filter(r=>r.method==='fourExecute').length,1);
  assert.deepEqual(Object.keys(p.calls.find(r=>r.method==='fourExecute').params).sort(),['intentId','previewId','profile']);assert.equal(p.node('prepare').disabled,true);
});
test('input changes, expiry and SPA navigation invalidate Four confirmation',async()=>{
  for(const change of ['amount','token','side','slippage','expiry','route','home']){
    const p=await panel();await p.ready();await p.ack();
    if(change==='expiry')await p.advance(60001);
    else if(change==='route')p.location.pathname='/token/'+address(4);
    else if(change==='home')p.location.pathname='/zh-TW';
    else await p.event(change,'input');
    await p.event('send');assert.equal(p.calls.some(r=>r.method==='fourExecute'),false,change);
  }
});
test('approval is explicitly labelled and never automatically buys; standalone links to Agentic Wallet',async()=>{
  const p=await panel({own:true,kind:'approve'});await p.ready();assert.equal(p.node('send').textContent,'确认授权');
  await p.ack();await p.event('send');assert.equal(p.calls.filter(r=>r.method==='fourPrepare').length,1);assert.equal(p.calls.filter(r=>r.method==='fourExecute').length,1);
  await p.event('wallet');assert.equal(p.calls.at(-1).method,'openWallet');assert.equal(p.calls.at(-1).params.profile,'heyi');
  assert.match(p.node('wallet').textContent,/Agentic Wallet/);
});
test('unconnected and unsupported markets stay queryable and cannot submit',async()=>{
  for(const config of [{connected:false},{supported:false}]){const p=await panel(config);await p.event('query');assert.equal(p.node('prepare').disabled,true);
    await p.event('four-form','submit');assert.equal(p.calls.some(r=>r.method==='fourPrepare'),false);}
});
test('lost execute response retains local guard and prevents repeating the trade',async()=>{
  let lost=false;const p=await panel({reply:r=>{if(r.method==='fourExecute'){lost=true;throw Error('disconnected');}if(lost&&r.method==='fourStatus')return {ok:false,error:{code:'NATIVE_UNAVAILABLE'}};}});
  await p.ready();await p.ack();await p.event('send');assert.equal(p.node('prepare').disabled,true);
  await p.event('send');assert.equal(p.calls.filter(r=>r.method==='fourExecute').length,1);
});
const content=node=>[node.textContent,...node.children.flatMap(n=>content(n))].filter(Boolean).join(' ');
test('Agent ID mode shows tax/cap, and OpenFour sells label net slippage without changing classic gross wording',async()=>{
  for(const open of [false,true]){const p=await panel({open,kind:'sell',action:'sell'});await p.ready();
    assert.match(content(p.node('review-facts')),open?/最低净到账/:/最低扣费前收入/);
    assert.match(p.node('review-note').textContent,open?/已扣除代币税/:/扣费前收入/);
    if(open){assert.match(content(p.node('market-info')),/10000000/);assert.match(content(p.node('market-info')),/10% \/ 10%/);assert.match(p.node('market-note').textContent,/普通转出受限/);}
    assert.equal(p.node('send').disabled,true);assert.equal(p.calls.some(r=>r.method==='fourExecute'),false);
  }
});
test('Agent ID eligibility failure does not present a submit button or claim wallet connection proves eligibility',async()=>{
  const p=await panel({open:true,reply:r=>r.method==='fourPrepare'?{ok:false,error:{code:'OPENFOUR_AGENT_ID_REQUIRED'}}:null});await p.ready();
  assert.match(p.node('status-text').textContent,/扫码连接不等于已取得 Agent ID/);assert.equal(p.node('send').disabled,true);assert.equal(p.calls.some(r=>r.method==='fourExecute'),false);
});
test('preset page explains choosing a token and does not send a preset ID as a token address',async()=>{
  const p=await panel({pathname:'/zh-TW/contract/1778027615735'});assert.match(p.node('market-note').textContent,/模式介绍页/);assert.equal(p.node('token').value,'');assert.equal(p.calls.some(r=>r.method==='fourQuery'),false);
});

test('new buys send explicit token units and show target quantity plus fee-inclusive maximum spend',async()=>{
  const p=await panel({open:true});await p.ready();
  assert.equal(p.node('amount-label').textContent,'购买数量（TEST）');
  const req=p.calls.find(r=>r.method==='fourPrepare');assert.equal(req.params.buyMode,'tokenAmount');assert.equal(req.params.amount,'100');
  assert.match(content(p.node('review-facts')),/目标购买数量 100 TEST/);assert.match(content(p.node('review-facts')),/最高支付（含滑点及交易费） 0.01 BNB/);
  assert.match(p.node('review-note').textContent,/不自动补买/);assert.equal(p.node('send').disabled,true);
  const sell=await panel({action:'sell',kind:'sell',open:true});await sell.ready();assert.equal(sell.calls.find(r=>r.method==='fourPrepare').params.buyMode,undefined);
});

test('fill upper limit refreshes holdings, fills the new limit only, and cannot trigger preview or execute',async()=>{
  let queried=0;const p=await panel({open:true,holdings:{base:'100',buyable:'50.0'},reply:r=>{
    if(r.method==='fourQuery'&&++queried===2)return {ok:true,data:{market:p.market,wallet:p.wallet,holdings:{base:'120',buyable:'30.0'}}};
  }});
  await p.event('query');assert.equal(p.node('fill-limit').disabled,false);
  await p.event('fill-limit','click',false);assert.equal(queried,1);
  await p.event('fill-limit');assert.equal(queried,2);assert.equal(p.node('amount').value,'30.0');assert.match(p.node('buy-limit').textContent,/30.0/);
  assert.equal(p.calls.some(r=>['fourPrepare','fourExecute'].includes(r.method)),false);
  p.location.pathname='/token/'+address(4);await p.advance(1000);assert.equal(p.node('amount').value,'');assert.equal(p.node('fill-limit').disabled,true);
});

test('unavailable, exhausted and classic unknown wallet limits cannot fill a guessed maximum',async()=>{
  for(const config of [{open:true},{open:true,holdings:{buyable:'0.0'}},{open:true,connected:false,holdings:{buyable:'7.0'}},{open:false}]){
    const p=await panel(config);await p.event('query');assert.equal(p.node('fill-limit').disabled,true);await p.event('fill-limit');assert.equal(p.calls.filter(r=>r.method==='fourQuery').length,1);
  }
});
