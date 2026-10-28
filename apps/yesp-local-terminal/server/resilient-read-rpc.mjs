import {createFlapRpc,fault} from './flap-reader.mjs';

const READS=new Set(['eth_call','eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getCode','eth_getStorageAt','eth_getBalance','eth_getTransactionCount','eth_getTransactionReceipt','eth_getTransactionByHash','eth_estimateGas','eth_gasPrice','eth_getLogs']);
const quota=e=>e?.code===-32005||/rate limit|too many requests|quota exceeded|request limit exceeded/i.test(String(e?.message||''));
// Inspired by TMTN's node cooldown design. Only read requests may fail over;
// contract reverts, signing and submission never get retried here.
export function createResilientReadRpc({url='https://bsc-dataseed.bnbchain.org',fallbackUrl='https://bsc-rpc.publicnode.com',timeoutMs=3500,fetchImpl=fetch,clock=Date.now,endpoints}={}){
 const nodes=endpoints??[...new Set([url,fallbackUrl].filter(Boolean))].map((url,i)=>({name:i?'备用节点':'主节点',rpc:createFlapRpc({url,timeoutMs,fetchImpl})}));
 if(!nodes.length||nodes.length>2)throw fault('RPC_INVALID_CONFIG');
 const health=nodes.map(()=>({until:0}));let active=0,switches=0,failedReads=0;
 async function batch(calls,{signal}={}){
  if(!Array.isArray(calls)||!calls.length||calls.length>100||calls.some(x=>!Array.isArray(x)||!READS.has(x[0])||!Array.isArray(x[1])))throw fault('RPC_WRITE_FORBIDDEN');
  if(signal?.aborted)throw signal.reason;
  const ready=nodes.map((_,i)=>i).filter(i=>health[i].until<=clock()),order=ready.length?ready:nodes.map((_,i)=>i);let last;
  for(const i of order){
   try{
    // Validate BSC on the same endpoint and batch, including after a switch.
    const rows=await nodes[i].rpc.batch([['eth_chainId',[]],...calls],{signal});
    if(!Array.isArray(rows)||rows.length!==calls.length+1||rows.some(r=>!r||typeof r!=='object'||Object.hasOwn(r,'result')===Object.hasOwn(r,'error')))throw fault('RPC_INVALID_RESPONSE');
    if(rows.some(r=>quota(r.error)))throw fault('RPC_RATE_LIMITED');
    if(!/^0x[\da-f]+$/i.test(rows[0]?.result||'')||BigInt(rows[0].result)!==56n)throw fault('CHAIN_MISMATCH');
    if(active!==i){active=i;switches++;}health[i].until=0;
    return rows.slice(1);
   }catch(e){
    if(signal?.aborted)throw signal.reason;
    last=e;failedReads++;health[i].until=clock()+30000;
   }
  }
  // Never surface a provider URL or raw HTTP error, which may contain a key.
  throw fault(['RPC_INVALID_RESPONSE','RPC_RATE_LIMITED','CHAIN_MISMATCH','RPC_OVERSIZED'].includes(last?.code)?last.code:'RPC_UNAVAILABLE');
 }
 async function rpc(method,params,options){const r=(await batch([[method,params]],options))[0];if(r.error){const e=fault('RPC_CALL_FAILED');e.rpcError=r.error;throw e;}if(!Object.hasOwn(r,'result'))throw fault('RPC_INVALID_RESPONSE');return r.result;}
 rpc.batch=batch;rpc.metrics=()=>({rpcNode:active?'备用节点':'主节点',rpcFallback:active!==0,rpcSwitches:switches,rpcFailedReads:failedReads});return rpc;
}
