import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import {isOfficialSigninUrl} from '../extension/signin-policy.js';
const tick=()=>new Promise(r=>setImmediate(r));
async function panel({connected=true,reply}={}){
  const nodes=new Map(),calls=[],intervals=[];let op=null,time=Date.now();
  class Node {constructor(){this.value='';this.listeners={};this.children=[];this.checked=false;}addEventListener(k,fn){this.listeners[k]=fn;}append(...n){this.children.push(...n);}replaceChildren(){this.children=[];}scrollIntoView(){}removeAttribute(k){delete this[k];}}
  const node=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
  const wallet={connected,address:connected?'0x'+'1'.repeat(40):null,chainId:'56'};
  const preview={previewId:randomUUID(),expiresAt:Date.now()+60000,wallet:wallet.address,recipient:'0x'+'2'.repeat(40),tokenAddress:'0x'+'3'.repeat(40),amount:'1.25',symbol:'TEST',balance:'10',estimatedFee:'0.0001',gasReserve:'0.0002'};
  node('token').value=preview.tokenAddress;node('recipient').value=preview.recipient;node('amount').value=preview.amount;
  const context=vm.createContext({document:{hidden:false,getElementById:node,createElement:()=>new Node()},Date:{now:()=>time},isOfficialSigninUrl,crypto:{randomUUID},setInterval(fn,ms){intervals.push({fn,ms});},
    chrome:{runtime:{id:'test',onMessage:{addListener(){}},async sendMessage(r){calls.push(structuredClone(r));let data={wallet,operation:op},guard=null;
      if(reply){const result=await reply(r,wallet);if(result)return result;}
      if(r.method==='transferPrepare') data={wallet,transferPreview:preview};
      if(r.method==='transfer'){op={intentId:r.params.intentId,action:'transfer',status:'SUBMITTED',message:'已广播'};data={wallet,operation:op};guard={intentId:op.intentId,status:op.status};}
      if(op)guard={intentId:op.intentId,status:op.status};return {ok:true,data,guard};}}}});
  const source=await readFile(new URL('../extension/wallet.js',import.meta.url),'utf8');
  context.client={sendMessage:r=>context.chrome.runtime.sendMessage(r),onProgress(){}};
  vm.runInContext(source.replace(/^import .*;$/gm,''),context);await tick();await tick();
  const event={isTrusted:true,preventDefault(){}};
  return {node,calls,preview,async advance(ms){time+=ms;for(const t of intervals)if(t.ms===1000)await t.fn();},async poll(){for(const t of intervals)if(t.ms===15000)await t.fn();await tick();},async click(id,type='click',trusted=true){await node(id).listeners[type]({...event,isTrusted:trusted});await tick();}};
}
test('wallet UI prepares only on trusted form submission and requires explicit checked confirmation',async()=>{
  const p=await panel();assert.deepEqual(p.calls.map(x=>x.method),['walletStatus']);
  await p.click('transfer-form','submit',false);assert.equal(p.calls.length,1);
  await p.click('transfer-form','submit');assert.equal(p.calls.at(-1).method,'transferPrepare');assert.equal(p.node('send').disabled,true);
  await p.click('send');assert.equal(p.calls.some(x=>x.method==='transfer'),false);
  p.node('acknowledge').checked=true;await p.click('acknowledge','change');assert.equal(p.node('send').disabled,false);
  await Promise.all([p.click('send'),p.click('send')]);const sends=p.calls.filter(x=>x.method==='transfer');assert.equal(sends.length,1);
  assert.deepEqual(Object.keys(sends[0].params).sort(),['intentId','previewId','profile']);assert.equal(sends[0].params.previewId,p.preview.previewId);
  assert.equal(p.node('prepare').disabled,true);
});
test('editing recipient after preview invalidates confirmation and prevents stale transfer',async()=>{
  const p=await panel();await p.click('transfer-form','submit');p.node('acknowledge').checked=true;await p.click('acknowledge','change');
  p.node('recipient').value='0x'+'4'.repeat(40);await p.click('recipient','input');assert.equal(p.node('review').hidden,true);assert.equal(p.node('send').disabled,true);
  await p.click('send');assert.equal(p.calls.some(x=>x.method==='transfer'),false);
});

const signin=()=>({urlForWeb:'https://web3.binance.com/en/agent-login?url=opaque%2Bpayload&expireAt=123',pairingCode:'aB091f',expireAt:Date.now()+60000,qrImage:'data:image/png;base64,aGVsbG8='});
test('explicit signin displays exact official link, local QR and pairing code; expiry removes stale credentials',async()=>{
  const data=signin(),p=await panel({connected:false,reply:r=>r.method==='signin'?{ok:true,data}:null});
  assert.equal(p.node('verify').disabled,true);await p.click('verify');assert.deepEqual(p.calls.map(r=>r.method),['walletStatus']);
  await p.click('signin','click',false);assert.equal(p.calls.length,1);
  await p.click('signin');assert.equal(p.node('signin-details').hidden,false);assert.equal(p.node('signin-link').href,data.urlForWeb);
  assert.equal(p.node('signin-qr').src,data.qrImage);assert.equal(p.node('pairing-code').textContent,data.pairingCode);assert.equal(p.node('verify').disabled,false);
  await p.advance(61000);assert.equal(p.node('signin-details').hidden,true);assert.equal(p.node('signin-qr').src,undefined);
  assert.equal(p.node('signin-link').href,undefined);assert.equal(p.node('pairing-code').textContent,'');assert.equal(p.node('verify').disabled,true);
  await p.poll();assert.equal(p.node('status-title').textContent,'登录二维码已过期');
});
test('missing QR still shows official link; image source cannot request an external QR service',async()=>{
  const data={...signin(),qrImage:'https://evil.test/collect'},p=await panel({connected:false,reply:r=>r.method==='signin'?{ok:true,data}:null});
  await p.click('signin');assert.equal(p.node('signin-qr').hidden,true);assert.equal(p.node('signin-qr').src,undefined);
  assert.equal(p.node('signin-link').hidden,false);assert.match(p.node('status-message').textContent,/官方扫码页面/);
});
test('unreviewed signin links are never displayed',async()=>{
  const p=await panel({connected:false,reply:r=>r.method==='signin'?{ok:true,data:{...signin(),urlForWeb:'https://web3.binance.com.evil.test/login'}}:null});
  await p.click('signin');assert.equal(p.node('signin-link').href,undefined);assert.equal(p.node('signin-details').hidden,true);assert.equal(p.node('verify').disabled,true);
});
test('login failure remains visible through status polling; rejected verification requires a fresh code',async()=>{
  let fail=true;
  const p=await panel({connected:false,reply:r=>r.method==='signin'?(fail?{ok:false,error:{code:'NETWORK_ERROR'}}:{ok:true,data:signin()}):r.method==='verify'?{ok:false,error:{code:'AUTH_REJECTED'}}:null});
  await p.click('signin');assert.match(p.node('status-message').textContent,/NETWORK_ERROR/);await p.poll();assert.match(p.node('status-message').textContent,/NETWORK_ERROR/);
  fail=false;await p.click('signin');await p.click('verify');assert.equal(p.node('signin-details').hidden,true);assert.match(p.node('status-message').textContent,/AUTH_REJECTED/);
  await p.poll();assert.match(p.node('status-message').textContent,/AUTH_REJECTED/);
});
test('verified login is confirmed by wallet status and hides pairing data',async()=>{
  const p=await panel({connected:false,reply:(r,wallet)=>{
    if(r.method==='signin')return {ok:true,data:signin()};
    if(r.method==='verify'){wallet.connected=true;wallet.address='0x'+'1'.repeat(40);return {ok:true,data:{connected:true}};}
  }});
  await p.click('signin');await p.click('verify');assert.equal(p.calls.at(-1).method,'walletStatus');
  assert.equal(p.node('connection').textContent,'本机钱包已连接');assert.equal(p.node('signin-link').href,undefined);assert.equal(p.node('prepare').disabled,false);
});
