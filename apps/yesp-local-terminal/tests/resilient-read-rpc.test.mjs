import test from 'node:test';
import assert from 'node:assert/strict';
import {createResilientReadRpc} from '../server/resilient-read-rpc.mjs';
import {batchedRpc} from '../server/batched-rpc.mjs';
const replies=calls=>calls.map(([method])=>({result:method==='eth_chainId'?'0x38':'0xa'}));
function fixture(fn){const visits=[[],[]];let now=1000;const rpc=createResilientReadRpc({clock:()=>now,endpoints:[0,1].map(i=>({rpc:{batch:async calls=>{visits[i].push(calls);return fn(i,calls,visits);}}}))});return {rpc,visits,tick:()=>{now+=30001;}};}
test('read failure switches once and cooling primary is skipped until recovery',async()=>{
 const f=fixture((i,c,v)=>{if(!i&&v[0].length===1)throw Error('private RPC URL must not leak');return replies(c);});
 assert.equal(await f.rpc('eth_blockNumber',[]),'0xa');assert.deepEqual(f.visits.map(v=>v.length),[1,1]);
 await f.rpc('eth_getBalance',['0x123','0xa']);assert.deepEqual(f.visits.map(v=>v.length),[1,2]);f.tick();await f.rpc('eth_blockNumber',[]);assert.deepEqual(f.visits.map(v=>v.length),[2,2]);assert.equal(f.rpc.metrics().rpcSwitches,2);
});
test('contract revert data is preserved and never retried on another provider',async()=>{
 const err={code:3,message:'execution reverted: limit exceeded',data:'0x08c379a0'};const f=fixture((i,c)=>c.map(([m])=>m==='eth_chainId'?{result:'0x38'}:{error:err}));
 await assert.rejects(f.rpc('eth_estimateGas',[{}]),e=>e.code==='RPC_CALL_FAILED'&&e.rpcError===err);assert.deepEqual(f.visits.map(v=>v.length),[1,0]);
});
test('quota, wrong chain and malformed read responses fail over without accepting them',async()=>{
 for(const bad of [c=>c.map(()=>({error:{code:-32005,message:'rate limited'}})),c=>c.map(()=>({result:'0x1'})),c=>c.map(()=>({})),()=>null]){
  const f=fixture((i,c)=>i?replies(c):bad(c));assert.equal(await f.rpc('eth_blockNumber',[]),'0xa');assert.equal(f.rpc.metrics().rpcFallback,true);
 }
});
test('all failures stay bounded and sanitized; financial RPC is rejected before any request',async()=>{
 const f=fixture(()=>{throw Error('https://node.invalid/private-api-key');});await assert.rejects(f.rpc('eth_blockNumber',[]),e=>e.code==='RPC_UNAVAILABLE'&&!e.message.includes('key'));assert.deepEqual(f.visits.map(v=>v.length),[1,1]);
 for(const name of ['eth_sendRawTransaction','eth_sendTransaction','personal_sign'])await assert.rejects(f.rpc(name,[]),e=>e.code==='RPC_WRITE_FORBIDDEN');assert.deepEqual(f.visits.map(v=>v.length),[1,1]);
});
test('caller cancellation stops without contacting fallback',async()=>{
 const c=new AbortController(),f=fixture(()=>{c.abort();throw c.signal.reason;});await assert.rejects(f.rpc('eth_blockNumber',[],{signal:c.signal}),e=>e.name==='AbortError');assert.deepEqual(f.visits.map(v=>v.length),[1,0]);
});
test('real JSON-RPC transport verifies ids and preserves batching, with no persistent result cache',async()=>{
 let batches=0;const rpc=batchedRpc(createResilientReadRpc({fetchImpl:async(url,o)=>{batches++;const q=JSON.parse(o.body);return Response.json(q.map(x=>({jsonrpc:'2.0',id:x.id,result:x.method==='eth_chainId'?'0x38':'0xa'})).reverse());}}));
 assert.deepEqual(await Promise.all([rpc('eth_blockNumber',[]),rpc('eth_blockNumber',[]),rpc('eth_getCode',['0x123','0xa'])]),['0xa','0xa','0xa']);assert.equal(batches,1);await rpc('eth_blockNumber',[]);assert.equal(batches,2);assert.equal(rpc.metrics().rpcNode,'主节点');
});
