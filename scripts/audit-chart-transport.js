// Audit-only transport: one lazy client sharing the production account gate.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadonlyMarketClient } from '../src/gmgn-readonly-market.js';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export function createSharedReadonlyChartTransport({now=Date.now,createClient=createReadonlyMarketClient}={}) {
  let client,closing,closed=false;
  const close=()=>{
    closed=true;
    return closing || (closing=Promise.resolve().then(()=>client?.close()));
  };
  const fetchImpl=async(url,{signal})=>{
    if(signal.aborted)throw signal.reason;
    if(closed)throw new Error('Audit transport is closed');
    // Lazy creation lets input validation and exclusive output creation finish.
    client ||= createClient({dataDir:path.join(project,'data'),isolated:true,ttlMs:0,timeoutMs:12000});
    const end=Math.floor(now()/60000)*60;
    let aborted;
    const canceled=new Promise((resolve,reject)=>{
      aborted=()=>{void close().catch(()=>{});reject(signal.reason);};
      signal.addEventListener('abort',aborted,{once:true});
    });
    try {
      const raw=await Promise.race([client.kline({chain:url.searchParams.get('chain'),address:url.searchParams.get('address'),
        resolution:'1m',from:end-3600,to:end,purpose:'candidate',latestClosed:true}),canceled]);
      return {ok:true,status:200,json:async()=>raw};
    } finally {signal.removeEventListener('abort',aborted);}
  };
  return {fetchImpl,close};
}
