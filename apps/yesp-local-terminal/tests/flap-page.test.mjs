import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createFlapMarketReader,FLAP_MARKET,marketViewAbi} from '../server/flap-market.mjs';
import {createFlapTrader} from '../server/flap-trader.mjs';
import {validateRequest as nativeRequest} from '../scripts/flap-native-host.mjs';
const address=n=>'0x'+String(n).repeat(40),zero=address(0),source=await readFile(new URL('../extension/flap-page.js',import.meta.url),'utf8');
class Node {
  constructor(tag,text='',children=[]){this.tagName=tag;this.text=text;this.children=[];this.style={};for(const c of children)this.append(c);}
  get textContent(){return this.text+this.children.map(c=>c.textContent).join('');}
  append(node){this.children.push(node);node.parentElement=this;}
  getAttribute(){return null;}
  getClientRects(){return [1];}
  getRootNode(){return {host:this.host};}
  querySelectorAll(selector){const result=[];const visit=n=>{for(const c of n.children){if(selector==='*'||selector.split(',').map(x=>x.trim()).includes(c.tagName)||selector.startsWith('[data-standalone')&&c.app)result.push(c);visit(c);}};visit(this);return result;}
}
const labelCard=(label,value)=>new Node('div','',[new Node('div','',[new Node('span',label)]),new Node('p',value)]);
function documentWith({language='zh',market=address(1),token=address(2),created=false,shadow=false}={}){
  const labels=language==='zh'?['预测代币地址','Market 地址']:['Predicted token address','Market address'];
  const app=new Node('section');app.app=true;const scope=shadow?new Node('shadow'):app;if(shadow){app.shadowRoot=scope;scope.host=app;}
  const main=new Node('main','',[new Node('h1','New coin'),new Node('div','',[labelCard(labels[0],token),labelCard(labels[1],market)])]);scope.append(main);
  const doc=new Node('document','',[new Node('p',address(9)),app]);return {doc,app,scope,main};
}
function read(doc){const context=vm.createContext({document:doc});vm.runInContext(source,context);return context.YespFlapPage.read(doc);}
test('Flap selected address cards are read in Chinese/English, including open shadow roots',()=>{
  for(const language of ['zh','en'])for(const shadow of [false,true]){const {doc}=documentWith({language,shadow}),selection=read(doc);
    assert.equal(selection.marketAddress,address(1));assert.equal(selection.tokenAddress,address(2));assert.equal(selection.name,'New coin');assert.equal(selection.predicted,true);}
});
test('list pages, hidden old details, truncated CA and ambiguous multiple selected pairs do not pick an arbitrary address',()=>{
  const {doc,main,scope}=documentWith();main.hidden=true;assert.equal(read(doc),null);main.hidden=false;
  scope.append(documentWith({market:address(3),token:address(4)}).main);assert.equal(read(doc),null);
  assert.equal(read(documentWith({token:'0x1234…abcd'}).doc),null);
  assert.equal(read(new Node('document','',[new Node('p',address(1))])),null);
});
test('same-page selection changes and return to the market list cannot retain old CA',()=>{
  const {doc,scope,main}=documentWith();assert.equal(read(doc).tokenAddress,address(2));
  scope.children=[];const replacement=documentWith({market:address(3),token:address(4)}).main;scope.append(replacement);assert.equal(read(doc).tokenAddress,address(4));
  scope.children=[];scope.append(new Node('main','Market list'));assert.equal(read(doc),null);
});
test('public market inspection binds Factory, Portal, predicted CA and actual token, without a wallet',async()=>{
  let changed=false,registered=true;const methods=[];const rpc=async(method,args)=>{methods.push(method);
    if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber')return '0x100';if(method==='eth_getBlockByNumber')return {number:'0x100',timestamp:'0x64'};
    assert.equal(method,'eth_call');const c=marketViewAbi.parseTransaction({data:args[0].data});
    const values={factory:[FLAP_MARKET.factory],isMarket:[registered],portal:[FLAP_MARKET.portal],token:[zero],predictedToken:[address(2)],
      marketCards:[[[address(1),zero,'New name','NEW','',changed?address(3):address(2),zero,zero,1,10n**18n,10n**19n,1000,1,0,0,0]]]};
    return marketViewAbi.encodeFunctionResult(c.name,values[c.name]);};
  const reader=createFlapMarketReader({rpc,clock:()=>100000}),params={profile:'heyi',marketAddress:address(1),tokenAddress:address(2)};
  const result=await reader.inspect(params);assert.equal(result.market.name,'New name');assert.equal(result.market.quoteSymbol,'BNB');assert.equal(result.market.pool,'1.0');
  changed=true;await assert.rejects(()=>reader.inspect(params),{code:'PAGE_MARKET_MISMATCH'});changed=false;registered=false;await assert.rejects(()=>reader.inspect(params),{code:'PAGE_MARKET_MISMATCH'});
  assert.ok(methods.every(m=>!m.includes('send')));
});
test('native host refuses unbound prepare/trade, and trader refuses a different page before accessing wallet or executing',async()=>{
  for(const method of ['prepare','trade'])assert.throws(()=>nativeRequest({id:'check-request',method,params:{profile:'heyi',action:'buy'}}),{code:'INVALID_REQUEST'});
  assert.throws(()=>nativeRequest({id:'check-request',method:'trade',params:{profile:'heyi',action:'buy',expectedMarket:address(1),expectedToken:zero}}),{code:'INVALID_REQUEST'});
  const profile={id:'heyi',chainId:'56',market:address(1),buySlippageBps:500,sellSlippageBps:9900,priorAuditUnavailableAcknowledged:true,codeHashes:{a:1,b:2,c:3,d:4,e:5}};
  let reads=0;const service=createFlapTrader({profile,reader:{verifySelection:async()=>{reads++;}},cli:{},journal:{}});
  await assert.rejects(()=>service.handle('trade',{profile:'heyi',action:'buy',expectedMarket:address(3),expectedToken:address(2)}),e=>e.code==='PAGE_MARKET_MISMATCH'&&e.submissionNotStarted===true);assert.equal(reads,0);
});
