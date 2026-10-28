import {AsyncLocalStorage} from 'node:async_hooks';
// Reuse exact reads only inside one query/quote/recheck. Nothing survives into
// a later preview or execution; pending nonces and gas simulations stay fresh.
export function createReadScopeRpc(base){
 if(base.withReadScope)return base;
 const contexts=new AsyncLocalStorage();let reused=0;
 const pinned=v=>typeof v==='string'&&/^0x[\da-f]+$/i.test(v);
 function cacheable(method,p){
  if(method==='eth_chainId'||method==='eth_blockNumber')return true;
  if(method==='eth_getBlockByNumber')return pinned(p[0]);
  if(['eth_call','eth_getBalance','eth_getCode','eth_getTransactionCount'].includes(method))return pinned(p[1]);
  return method==='eth_getStorageAt'&&pinned(p[2]);
 }
 async function rpc(method,params,options){const cache=contexts.getStore();if(!cache||options||!cacheable(method,params))return base(method,params,options);
  const key=JSON.stringify([method,params]);if(cache.has(key)){reused++;return cache.get(key);}if(cache.size>=512)return base(method,params,options);
  const promise=Promise.resolve().then(()=>base(method,params));cache.set(key,promise);try{return await promise;}catch(e){if(cache.get(key)===promise)cache.delete(key);throw e;}
 }
 rpc.batch=calls=>Promise.all(calls.map(async([method,params],id)=>{try{return {jsonrpc:'2.0',id,result:await rpc(method,params)};}catch(e){if(e.rpcError)return {jsonrpc:'2.0',id,error:e.rpcError};throw e;}}));
 rpc.withReadScope=fn=>contexts.run(new Map(),fn);
 rpc.metrics=()=>({...base.metrics?.(),reusedReads:reused});
 return rpc;
}
