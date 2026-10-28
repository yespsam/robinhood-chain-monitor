import {fault} from './flap-reader.mjs';
// Coalesce simultaneous read requests into bounded HTTP batches. No stale
// cross-block cache, fallback transaction submission or automatic retry.
export function batchedRpc(base,{maxBatch=40}={}){
 let queue=[],scheduled=false;const inflight=new Map();let requests=0,batches=0,lastMs=0;
 async function flush(){scheduled=false;const rows=queue.splice(0,maxBatch);if(queue.length){scheduled=true;queueMicrotask(flush);}if(!rows.length)return;
  const start=performance.now();batches++;
  try{const results=await base.batch(rows.map(x=>[x.method,x.params]));if(results.length!==rows.length)throw fault('RPC_INVALID_RESPONSE');
   results.forEach((r,i)=>{if(r.error){const e=fault('RPC_CALL_FAILED');e.rpcError=r.error;rows[i].reject(e);}else if(!Object.hasOwn(r,'result'))rows[i].reject(fault('RPC_INVALID_RESPONSE'));else rows[i].resolve(r.result);});
  }catch(e){for(const row of rows)row.reject(e);}finally{lastMs=Math.round(performance.now()-start);for(const row of rows)inflight.delete(row.key);}
 }
 function rpc(method,params){requests++;const key=JSON.stringify([method,params]);if(inflight.has(key))return inflight.get(key);
  const promise=new Promise((resolve,reject)=>queue.push({key,method,params,resolve,reject}));inflight.set(key,promise);if(!scheduled){scheduled=true;queueMicrotask(flush);}return promise;}
 rpc.batch=async calls=>Promise.all(calls.map(async([method,params],i)=>{try{return {jsonrpc:'2.0',id:i,result:await rpc(method,params)};}catch(e){if(e.rpcError)return {jsonrpc:'2.0',id:i,error:e.rpcError};throw e;}}));
 rpc.metrics=()=>({...base.metrics?.(),requests,batches,lastMs,pending:inflight.size});return rpc;
}
