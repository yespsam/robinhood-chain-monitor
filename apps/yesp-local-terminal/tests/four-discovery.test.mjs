import test from 'node:test';
import assert from 'node:assert/strict';
import {createFourDiscovery,FOUR_DIRECTORY_URL} from '../server/four-discovery.mjs';
import {OPENFOUR,moduleAbi} from '../server/openfour-reader.mjs';
import {coreAbi,registryAbi} from '../server/openfour-abi.mjs';
import {createChainScanner,launchAbi,SCAN_SOURCES} from '../server/chain-scanner.mjs';
import {scanLane,scanSelection} from '../extension/scan-ui.js';
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0');
function fixture(){
 const config={phase:3,preset:OPENFOUR.presetId,tag:'token.tax.binance_agent',core:OPENFOUR.core,fail:false,badIndex:false};const calls=[];
 const rpc=async(method,p)=>{calls.push(method);if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber')return '0x100';if(method==='eth_getBlockByNumber')return {number:'0x100',timestamp:'0x64'};
  assert.equal(method,'eth_call');assert.equal(p[1],'0x100');let abi,tx;for(const a of [coreAbi,registryAbi,moduleAbi]){const t=a.parseTransaction({data:p[0].data});if(t){abi=a;tx=t;break;}}
  let out;switch(tx.name){case 'openFourCore':out=[config.core];break;
   case 'tokens':if(config.fail)throw Error('RPC failed');out=[1,addr(1),config.preset,addr(2),'Old external','OLD',1000,800,100,addr(3),addr(4),addr(5),addr(6),addr(7),addr(8),addr(0),1,true,false,false];break;
   case 'descriptor':out=['0x'+'11'.repeat(8),config.tag,'1'];break;
   case 'phase':out=[config.phase];break;case 'fourCore':out=[OPENFOUR.core];break;default:throw Error(tx.name);
  }return abi.encodeFunctionResult(tx.name,out);
 };
 const requests=[];const fetcher=async(url,options)=>{assert.equal(url,FOUR_DIRECTORY_URL);assert.equal(options.redirect,'error');const p=JSON.parse(options.body);requests.push(p);
  return new Response(JSON.stringify({code:0,data:[{tokenAddress:addr(2),templateId:config.badIndex?'123':OPENFOUR.presetId,status:'TRADE',networkCode:0}]}));};
 return {config,calls,requests,read:createFourDiscovery({rpc,fetcher,clock:()=>100000})};
}
test('Four historical discovery separately requests external/new/near lists and deduplicates before chain reads',async()=>{
 const f=fixture(),s=await f.read.read();assert.equal(s.rows.length,1);assert.equal(s.rows[0].phase,3);assert.equal(s.rows[0].blockNumber,1);assert.equal(s.externalShown,1);assert.equal(s.rows[0].chainTimestamp,null);
 assert.deepEqual(f.requests.map(p=>[p.status,p.type]),[['TRADE','NEW'],['PUBLISH','NEW'],['PUBLISH','PROGRESS']]);assert.ok(f.requests.every(p=>String(p.templateId)===OPENFOUR.presetId));assert.ok(f.calls.every(x=>['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_call'].includes(x)));
});
test('index TRADE flag cannot promote a pending or trading vault to the external lane',async()=>{
 for(const phase of [1,2,3]){const f=fixture();f.config.phase=phase;const s=await f.read.read();assert.equal(s.rows[0].phase,phase);assert.equal(scanLane(s.rows[0]),phase===3?'launched':phase===2?'near':'new');}
 const f=fixture();f.config.phase=4;assert.equal((await f.read.read()).rows.length,0);
});
test('Four excludes wrong presets and token descriptors, and rejects an unverified directory or changed Core',async()=>{
 for(const change of [{preset:'7'},{tag:'token.tax'}]){const f=fixture();Object.assign(f.config,change);const s=await f.read.read();assert.equal(s.rows.length,0);assert.equal(s.rejected,1);}
 const f=fixture();f.config.badIndex=true;await assert.rejects(f.read.read(),{code:'FOUR_DIRECTORY_BINDING'});
 const g=fixture();g.config.core=addr(99);await assert.rejects(g.read.read(),{code:'OPENFOUR_CORE_CHANGED'});
});
test('temporary per-token RPC failures retain only previously verified rows as stale',async()=>{
 const f=fixture();await f.read.read();f.config.fail=true;const s=await f.read.read();assert.equal(s.rows.length,1);assert.equal(s.rows[0].stale,true);assert.equal(s.unverified,1);
 const g=fixture();g.config.fail=true;assert.equal((await g.read.read()).rows.length,0);
});
test('malformed or oversized directory bodies are rejected without making chain requests',async()=>{
 for(const body of ['[]','not json',JSON.stringify({code:1,data:[]}), 'x'.repeat(2000001)]){
  const d=createFourDiscovery({fetcher:async()=>new Response(body),rpc:()=>{assert.fail('unexpected chain request');}});await assert.rejects(d.read(),{code:'FOUR_DIRECTORY_INVALID'});
 }
});
test('scanner publishes older Four externals despite failed creation-event RPC and retains them on index failure',async()=>{
 let now=1000,fail=false;const row={id:'four:'+addr(2),platform:'Four.meme',source:'four-agent-directory',tokenAddress:addr(2),phase:3,blockNumber:1,confirmed:true};
 const discovery={read:async()=>{if(fail)throw Error();return {rows:[row],externalShown:1,updatedAt:now};}};
 const scanner=createChainScanner({rpc:async()=>{throw Error();},discovery:null,fourDiscovery:discovery,clock:()=>now});
 await scanner.refreshFourDirectory();await scanner.tick();assert.equal(scanner.state().rows.length,1);assert.equal(scanner.state().fourDirectory.externalShown,1);assert.ok(scanner.state().error);
 now+=30001;fail=true;await scanner.refreshFourDirectory();assert.equal(scanner.state().rows[0].stale,true);assert.equal(scanner.state().fourDirectory.error,'FOUR_DIRECTORY_UNAVAILABLE');scanner.stop();
});
test('Four catalog and matching live creation event merge once without losing the transaction',async()=>{
 const source=SCAN_SOURCES[0],inputs=launchAbi.getEvent(source.event).inputs;
 const values=inputs.map(x=>x.name==='presetId'?OPENFOUR.presetId:x.name==='token'?addr(2):x.type==='address'?addr(1):x.type==='string'?'T':x.type==='bytes'?'0x':1);
 const log={...launchAbi.encodeEventLog(launchAbi.getEvent(source.event),values),address:source.address,blockNumber:'0xff',logIndex:'0x0',blockHash:hash(2),transactionHash:hash(3)};
 const rpc=async(m,p)=>m==='eth_chainId'?'0x38':m==='eth_blockNumber'?'0x100':p[0].address===source.address?[log]:[];
 const discovery={read:async()=>({rows:[{id:'four:'+addr(2),platform:'Four.meme',tokenAddress:addr(2),phase:3,blockNumber:255,source:'four-agent-directory'}]})};
 const scanner=createChainScanner({rpc,discovery:null,fourDiscovery:discovery,lookback:4});await scanner.refreshFourDirectory();await scanner.tick();
 const s=scanner.state();assert.equal(s.rows.length,1);assert.equal(s.rows[0].phase,3);assert.equal(s.rows[0].txHash,hash(3));scanner.stop();
});
test('over 200 newer tokens cannot hide older externals and filtering happens before per-lane limits',()=>{
 const rows=Array.from({length:250},(_,i)=>({platform:'Flap',phase:1,blockNumber:i+10,tokenAddress:addr(i+10),symbol:'NEW'}));
 rows.push({platform:'Four.meme',phase:3,blockNumber:1,tokenAddress:addr(2),symbol:'OLD'});
 const selected=scanSelection(rows,'all');assert.equal(selected.shown.length,101);assert.equal(selected.counts.new,250);assert.equal(selected.counts.launched,1);assert.ok(selected.shown.some(r=>r.symbol==='OLD'));
 assert.equal(scanSelection(rows,'Four.meme').shown.length,1);assert.equal(scanSelection(rows,'all',{search:'OLD'}).shown.length,1);
 assert.equal(scanLane({phase:1,info:{phaseLabel:'已毕业'}}),'new');
});
