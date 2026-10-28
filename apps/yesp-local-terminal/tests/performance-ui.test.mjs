import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=name=>readFile(new URL('../extension/'+name,import.meta.url),'utf8');
function dom(){
 let created=0;
 class Element{
  constructor(tag='div'){created++;this.tagName=tag;this.children=[];this.dataset={};this.listeners={};this.className='';this.scrollTop=0;this.value='';this.hidden=false;this.classList={toggle(){}};}
  get isConnected(){return !!this.root||!!this.parentNode?.isConnected;}
  get childNodes(){return this.children;}
  append(...nodes){for(const n of nodes){n.remove();n.parentNode=this;this.children.push(n);}}
  insertBefore(n,before){if(n===before)return;n.remove();const i=before?this.children.indexOf(before):this.children.length;assert(i>=0);this.children.splice(i,0,n);n.parentNode=this;}
  remove(){if(this.parentNode){const a=this.parentNode.children;a.splice(a.indexOf(this),1);this.parentNode=null;}}
  replaceChildren(...nodes){for(const n of [...this.children])n.remove();this.append(...nodes);}
  setAttribute(k,v){this[k]=v;}
  addEventListener(k,fn){this.listeners[k]=fn;}
  querySelectorAll(selector){const match=n=>selector.startsWith('.')?n.className.split(' ').includes(selector.slice(1)):n.tagName===selector;const walk=n=>n.children.flatMap(c=>[...(match(c)?[c]:[]),...walk(c)]);return walk(this);}
  querySelector(s){return this.querySelectorAll(s)[0]||null;}
  fire(type,event={isTrusted:true}){return this.listeners[type]?.(event);}
 }
 const nodes=new Map();const get=id=>{if(!nodes.has(id)){const n=new Element();n.root=true;nodes.set(id,n);}return nodes.get(id);};
 const document={hidden:false,getElementById:get,createElement:tag=>new Element(tag),listeners:{},addEventListener(k,f){this.listeners[k]=f;}};
 return {document,get,Element,created:()=>created};
}
const row=(i,phase=1)=>({tokenAddress:'0x'+i.toString(16).padStart(40,'0'),platform:i%2?'Four.meme':'Flap',name:'Token '+i,symbol:'T'+i,mode:'Agent',phase,blockNumber:10000-i,info:{state:'ready',imageUrl:'/api/token-image/'+i.toString(16).padStart(64,'0'),description:'test',quote:{symbol:'BNB'},chainUpdatedAt:1000}});
test('warroom retains unchanged cards and avatars across 100 snapshots; details are built only on expansion',async()=>{
 const d=dom(),context=vm.createContext({document:d.document,Date,URL,navigator:{clipboard:{writeText:async()=>{}}}});vm.runInContext((await source('scan-ui.js')).replaceAll('export ',''),context);
 const render=vm.runInContext('createScanRows(()=>{})',context),rows=Array.from({length:188},(_,i)=>row(i+1,i<120?1:i<180?2:3));render(rows,'all');
 const body=d.get('new-tokens'),cards=body.querySelectorAll('.trench-token');assert.equal(cards.length,48);assert.equal(body.querySelectorAll('.scan-field').length,0);
 const allocations=d.created();for(let i=0;i<100;i++)render(structuredClone(rows),'all');assert.equal(d.created(),allocations);assert.deepEqual(body.querySelectorAll('.trench-token'),cards);
 const first=cards[0],image=first.querySelector('img'),details=first.querySelector('.scan-details');details.open=true;details.fire('toggle');assert(first.querySelectorAll('.scan-field').length>0);
 rows[0].info.pool='1.5';render(rows,'all');const next=body.querySelectorAll('.trench-token')[0];assert.notEqual(next,first);assert.equal(next.querySelector('img'),image);assert(next.querySelector('.scan-details').open);assert.equal(body.querySelectorAll('.trench-token')[1],cards[1]);
});
test('warroom pagination, phase changes, filters and counts preserve all matching external markets',async()=>{
 const d=dom(),context=vm.createContext({document:d.document,Date,URL});vm.runInContext((await source('scan-ui.js')).replaceAll('export ',''),context);const render=vm.runInContext('createScanRows(()=>{})',context);
 const rows=Array.from({length:188},(_,i)=>row(i+1,i<180?1:3));render(rows,'all');const body=d.get('new-tokens');assert.equal(body.querySelectorAll('.trench-token').length,28);assert.equal(body.querySelectorAll('.lane-count')[0].textContent,'20 / 180');
 body.querySelectorAll('.scan-more')[0].fire('click');assert.equal(body.querySelectorAll('.trench-token').length,48);
 rows[0].phase=3;render(rows,'all');const lanes=body.querySelectorAll('.trench-list');assert.equal(lanes[2].querySelectorAll('.trench-token').length,9);assert.equal(lanes[0].querySelectorAll('.trench-token').length,40);
 render(rows,'all',{search:rows[187].tokenAddress});assert.equal(body.querySelectorAll('.trench-token').length,1);assert.equal(lanes[2].querySelectorAll('.trench-token').length,1);
 render([],'all');assert.equal(body.querySelectorAll('.trench-token').length,0);assert.equal(body.querySelectorAll('.lane-empty').length,3);
});
test('hidden and cached pages close SSE; returning opens a single fresh stream without any financial request',async()=>{
 const d=dom(),windows={},streams=[],requests=[];class EventSource{constructor(url){this.url=url;this.listeners={};streams.push(this);}addEventListener(k,f){this.listeners[k]=f;}close(){this.closed=true;}}
 const context=vm.createContext({document:d.document,window:{addEventListener:(k,f)=>windows[k]=f},location:{protocol:'http:',hostname:'127.0.0.1'},EventSource,fetch:async(url,opts)=>{requests.push([url,opts]);return {ok:true,json:async()=>({csrf:'test'})};}});
 vm.runInContext((await source('client-bridge.js')).replace('export const client','globalThis.client'),context);const c=context.client;await Promise.all([c.init(),c.init()]);assert.equal(streams.length,1);
 d.document.hidden=true;d.document.listeners.visibilitychange();assert(streams[0].closed);await c.init();assert.equal(streams.length,1);
 d.document.hidden=false;d.document.listeners.visibilitychange();d.document.listeners.visibilitychange();assert.equal(streams.length,2);
 windows.pagehide();assert(streams[1].closed);windows.pageshow();assert.equal(streams.length,3);assert.deepEqual(requests.map(([url])=>url),['/api/session']);
});
test('chart pointer bursts share one frame and reuse the canvas backing store',async()=>{
 const d=dom(),frames=[];d.document.querySelectorAll=()=>[];const canvas=d.get('price-chart');let resizes=0,w=0,h=0;
 Object.defineProperties(canvas,{width:{get:()=>w,set:v=>{w=v;resizes++;}},height:{get:()=>h,set:v=>{h=v;resizes++;}}});canvas.getBoundingClientRect=()=>({width:800,left:0});canvas.getContext=()=>({setTransform(){},clearRect(){},fillText(){}});
 const context=vm.createContext({document:d.document,window:{devicePixelRatio:1},Date,Intl,ResizeObserver:class{observe(){}},requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},setInterval(){}});
 vm.runInContext((await source('market-chart.js')).replaceAll('export ',''),context);vm.runInContext('setupMarketChart({client:{local:false}})',context);frames.shift()();assert.equal(resizes,2);
 for(let i=0;i<100;i++)canvas.fire('pointermove',{clientX:i});assert.equal(frames.length,1);frames.shift()();assert.equal(resizes,2);
 d.document.hidden=true;canvas.fire('pointermove',{clientX:0});frames.shift()();assert.equal(resizes,2);
});
