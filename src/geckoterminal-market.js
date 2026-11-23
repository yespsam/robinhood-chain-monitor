import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGmgnAccountGate} from './gmgn-account-gate.js';
import {gmgnFlowAddress} from './gmgn-flow-signal.js';

const API='https://api.geckoterminal.com/api/v2';
// Match the account-gate admission lease. Expired live-PID leases must be
// allowed back into that gate for cleanup, not rejected forever by this hint.
const ACTIVE_LEASE_MS=60000;
export const GECKO_NETWORKS=Object.freeze({bsc:'bsc',sol:'solana',robinhood:'robinhood'});
const failure=(code,extra={})=>Object.assign(new Error(code),{code,...extra});
const iso=at=>new Date(at).toISOString();
const same=(chain,a,b)=>typeof a==='string'&&typeof b==='string'&&(chain==='sol'?a===b:a.toLowerCase()===b.toLowerCase());
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const safePool=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
function identity(chain,address){
  const network=GECKO_NETWORKS[chain],normalized=gmgnFlowAddress(chain,address);
  if(!network||!normalized)throw failure('GT_INVALID_IDENTITY');
  return {chain,address:normalized,network};
}

// Pool IDs are opaque: Uniswap V4 / Infinity IDs can be 32-byte hashes.
export function bindGeckoPoolResponse(payload,{chain,address,requestedAt,receivedAt}) {
  const id=identity(chain,address),expected=`${id.network}_${id.address}`;
  if(!Array.isArray(payload?.data)||!Array.isArray(payload?.included))throw failure('GT_INVALID_POOL_RESPONSE');
  const included=new Map(payload.included.map(x=>[x?.id,x]));
  const pools=[];
  for(const pool of payload.data) {
    const poolId=pool?.attributes?.address;
    if(pool?.type!=='pool'||!safePool(poolId)||pool.id!==`${id.network}_${poolId}`)throw failure('GT_POOL_IDENTITY_MISMATCH');
    const tokens=['base_token','quote_token'].map(role=>{
      const relation=pool.relationships?.[role]?.data,item=included.get(relation?.id),a=item?.attributes;
      const prefix=`${id.network}_`,relationAddress=typeof relation?.id==='string'&&relation.id.startsWith(prefix)?relation.id.slice(prefix.length):null;
      const addressValid=typeof relationAddress==='string'&&(chain==='sol'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(relationAddress):/^0x[0-9a-fA-F]{40}$/.test(relationAddress));
      if(relation?.type!=='token'||!addressValid||item&&(item.type!=='token'||typeof a?.address!=='string'
        ||relation.id!==`${id.network}_${a.address}`||!Number.isInteger(a.decimals)||a.decimals<0||a.decimals>255))
        throw failure('GT_TOKEN_METADATA_MISMATCH');
      if(same(chain,relationAddress,id.address)&&!item)throw failure('GT_TOKEN_METADATA_MISMATCH');
      return {address:relationAddress,decimals:a?.decimals??null};
    });
    const side=tokens.findIndex(t=>same(chain,t.address,id.address));
    if(side<0||!same(chain,pool.relationships?.[side===0?'base_token':'quote_token']?.data?.id,expected))
      throw failure('GT_TOKEN_IDENTITY_MISMATCH');
    const dexId=pool.relationships?.dex?.data?.id;
    if(typeof dexId!=='string'||!dexId)throw failure('GT_INVALID_POOL_RESPONSE');
    pools.push({...id,poolId,dexId,tokenSide:side===0?'base':'quote',
      binding:{network:id.network,poolId,baseToken:tokens[0],quoteToken:tokens[1],metadataRequestedAt:requestedAt,metadataReceivedAt:receivedAt},
      poolCreatedAt:pool.attributes.pool_created_at||null,
      selectedPoolMetadata:{data:structuredClone(pool),included:payload.included.filter(t=>tokens.some(x=>same(chain,x.address,t.attributes?.address))).map(t=>structuredClone(t))}});
  }
  if(!pools.length)throw failure('GT_NO_POOLS');
  // Preserve the provider's liquidity/volume ranking; no cross-pool stitching.
  return pools[0];
}

export function normalizeGeckoOhlcv(payload,pool,{from,to,requestedAt,receivedAt,queuedAt,requestWindow}) {
  const binding=pool?.binding;
  for(const record of [payload,payload?.data?.attributes])if(record&&(record.synthetic||record.filled||record.noTrade||record.include_empty_intervals
    ||Number(record.inferredBars)>0||record.source&&record.source!=='geckoterminal'))throw failure('GT_SYNTHETIC_OR_MIXED_SOURCE');
  if(![from,to].every(Number.isSafeInteger)||from<0||from%60||to%60||to-from!==3600
    ||!finite(Date.parse(requestedAt))||!finite(Date.parse(receivedAt))||Date.parse(receivedAt)<Date.parse(requestedAt)
    ||!finite(Date.parse(binding?.metadataReceivedAt))||!finite(Date.parse(binding?.metadataRequestedAt))
    ||Date.parse(binding.metadataRequestedAt)>Date.parse(binding.metadataReceivedAt)||Date.parse(binding.metadataReceivedAt)>Date.parse(requestedAt)
    ||!['fixed_historical','latest_closed_at_dispatch'].includes(requestWindow)||to*1000>Date.parse(requestedAt)
    ||requestWindow==='latest_closed_at_dispatch'&&to!==Math.floor(Date.parse(requestedAt)/60000)*60)throw failure('GT_INVALID_WINDOW');
  if(!binding||!same(pool.chain,payload?.meta?.base?.address,binding.baseToken.address)
    ||!same(pool.chain,payload?.meta?.quote?.address,binding.quoteToken.address))throw failure('GT_OHLCV_IDENTITY_MISMATCH');
  const list=payload?.data?.attributes?.ohlcv_list;
  if(payload?.data?.type!=='ohlcv_request_response'||!Array.isArray(list)||list.length>1000)throw failure('GT_INVALID_OHLCV');
  const seen=new Set(),all=[];
  for(const row of list) {
    if(!Array.isArray(row)||row.length!==6||!row.every(finite)||!Number.isSafeInteger(row[0])||row[0]<0||row[0]%60!==0
      ||row.slice(1,5).some(n=>n<=0)||row[5]<0||row[2]<Math.max(row[1],row[3],row[4])||row[3]>Math.min(row[1],row[2],row[4])
      ||seen.has(row[0]))throw failure('GT_INVALID_OHLCV');
    if(row[0]>to)throw failure('GT_FUTURE_BAR');
    if(row[5]===0)throw failure('GT_ZERO_VOLUME_BAR');
    seen.add(row[0]);all.push({time:iso(row[0]*1000),open:row[1],high:row[2],low:row[3],close:row[4],volume:row[5],source:'geckoterminal'});
  }
  const candles=all.filter(c=>Date.parse(c.time)>=from*1000&&Date.parse(c.time)+60000<=to*1000).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  return {status:'ok',source:'geckoterminal',chain:pool.chain,address:pool.address,tokenAddress:pool.address,
    network:pool.network,poolId:pool.poolId,dexId:pool.dexId,tokenSide:pool.tokenSide,currency:'usd',resolution:'1m',from,to,
    requestedAt,receivedAt,queuedAt,observedAt:receivedAt,requestWindow,emptyIntervals:false,inferredBars:0,
    binding:structuredClone(binding),ohlcvMeta:structuredClone(payload.meta),poolCreatedAt:pool.poolCreatedAt,
    selectedPoolMetadata:pool.selectedPoolMetadata,candles,rawResponse:payload,
    quality:{rawBars:all.length,closedBars:candles.length,excludedBars:all.length-candles.length,
      poolPredatesWindow:!!pool.poolCreatedAt&&Date.parse(pool.poolCreatedAt)<=from*1000,
      lastClosedAt:candles.length?iso(Date.parse(candles.at(-1).time)+60000):null}};
}

export function createGeckoTerminalMarketClient({dataDir=path.resolve('data'),fetchImpl=fetch,now=Date.now,
  minIntervalMs=30000,timeoutMs=15000,queueWaitMs=65000,metadataTtlMs=300000,gateFactory=createGmgnAccountGate}={}) {
  if(!finite(minIntervalMs)||minIntervalMs<30000||!finite(timeoutMs)||timeoutMs<1||timeoutMs>30000
    ||!finite(queueWaitMs)||queueWaitMs<1||queueWaitMs>120000||!finite(metadataTtlMs)||metadataTtlMs<0||metadataTtlMs>3600000)
    throw failure('GT_INVALID_OPTIONS');
  const providerDir=path.join(path.resolve(dataDir),'geckoterminal-readonly'),cooldownFile=path.join(providerDir,'cooldown.json');
  // Reuse the tested serial filesystem admission primitive in a separate
  // provider directory. This never consumes or modifies GMGN's account budget.
  const gate=gateFactory(providerDir,{intervalMs:minIntervalMs,waitMs:queueWaitMs});
  const fastGate=gateFactory(providerDir,{intervalMs:minIntervalMs,waitMs:100});
  const controller=new AbortController(),jobs=new Set(),metadata=new Map();let closed=false,closing,lastError=null,cooldownUntil=0,lastRequestStartedAt=0;
  const code=e=>typeof e?.code==='string'&&/^(?:GT|GMGN)_[A-Z_]+$/.test(e.code)?e.code.replace(/^GMGN_/,'GT_')
    :e?.name==='TimeoutError'?'GT_REQUEST_TIMEOUT':e?.name==='AbortError'||controller.signal.aborted?'GT_STOPPED':'GT_NETWORK_FAILED';
  async function cooldown() {
    try {
      const stat=await fs.stat(cooldownFile);if(!stat.isFile()||stat.size>4096)throw failure('GT_STATE_INVALID');
      const state=JSON.parse(await fs.readFile(cooldownFile,'utf8'));
      if(state.version!==1||!Number.isSafeInteger(state.until)||state.until<0)throw failure('GT_STATE_INVALID');
      cooldownUntil=state.until;
    }catch(e){if(e.code!=='ENOENT')throw failure('GT_STATE_INVALID');}
    if(cooldownUntil>now())throw failure('GT_COOLDOWN',{retryAt:iso(cooldownUntil)});
  }
  async function recordCooldown(value) {
    const seconds=typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value.trim())?Number(value)*1000:null;
    const date=typeof value==='string'?Date.parse(value):NaN;
    const until=Math.ceil(Math.max(now()+120000,seconds!==null?now()+seconds:finite(date)?date:0));
    const temp=`${cooldownFile}.${randomUUID()}.tmp`;
    await fs.mkdir(providerDir,{recursive:true,mode:0o700});
    await fs.writeFile(temp,JSON.stringify({version:1,until}),{mode:0o600});await fs.rename(temp,cooldownFile);
    cooldownUntil=until;return iso(until);
  }
  async function availability() {
    try{await cooldown();}catch(e){if(e.code==='GT_COOLDOWN')return {available:false,reasonCode:e.code,nextAllowedAt:e.retryAt};throw e;}
    let startedAt=lastRequestStartedAt,active=false;
    try {
      const state=JSON.parse(await fs.readFile(path.join(providerDir,'gmgn-account-slot.json'),'utf8'));
      if(state.version!==1||!finite(state.startedAt)||!Array.isArray(state.active))throw failure('GT_STATE_INVALID');
      startedAt=Math.max(startedAt,state.startedAt);
      active=state.active.some(x=>{
        if(!Number.isSafeInteger(x?.pid)||x.pid<=0||x.admittedAt!==undefined&&!finite(x.admittedAt))throw failure('GT_STATE_INVALID');
        if(now()-(x.admittedAt??state.startedAt)>ACTIVE_LEASE_MS)return false;
        try{process.kill(x.pid,0);return true;}catch(e){return e.code!=='ESRCH';}
      });
    }catch(e){if(e.code!=='ENOENT')throw failure('GT_STATE_INVALID');}
    const next=startedAt?startedAt+minIntervalMs:0;
    return {available:!closed&&!active&&now()>=next,reasonCode:closed?'GT_STOPPED':active?'GT_REQUEST_BUSY':now()<next?'GT_PACING':null,
      nextAllowedAt:next?iso(next):null};
  }
  async function request(buildPath,kind,signal,waitForSlot=true) {
    await cooldown();const queuedAt=iso(now());
    if(!waitForSlot){const ready=await availability();if(!ready.available)throw failure(ready.reasonCode,{retryAt:ready.nextAllowedAt});}
    return (waitForSlot?gate:fastGate)(async()=>{
      await cooldown();if(signal.aborted)throw failure('GT_STOPPED');
      const at=now(),requestedAt=iso(at),url=new URL(buildPath(at),API+'/');lastRequestStartedAt=at;
      if(url.origin!==new URL(API).origin||!url.pathname.startsWith('/api/v2/'))throw failure('GT_INVALID_ROUTE');
      const timeout=AbortSignal.timeout(timeoutMs),combined=AbortSignal.any([signal,timeout]);
      let response,raw;
      try {
        response=await fetchImpl(url,{signal:combined,redirect:'error',headers:{Accept:'application/json;version=20230203','accept-encoding':'identity'}});
        const body=await response.text();if(body.length>16*1024*1024)throw failure('GT_INVALID_RESPONSE');
        try{raw=JSON.parse(body);}catch{raw=body;}
        if(response.status===429){const retryAt=await recordCooldown(response.headers?.get('retry-after'));throw failure('GT_RATE_LIMITED',{retryAt,httpStatus:429,rawResponse:raw});}
        if(!response.ok)throw failure(response.status===404?'GT_NOT_FOUND':response.status>=500?'GT_UPSTREAM_FAILED':'GT_HTTP_FAILED',{httpStatus:response.status,rawResponse:raw});
        if(!raw||typeof raw!=='object')throw failure('GT_INVALID_RESPONSE');
      }catch(e){if(timeout.aborted&&!signal.aborted)throw failure('GT_REQUEST_TIMEOUT');throw e;}
      return {raw,queuedAt,requestedAt,receivedAt:iso(now()),requestUrl:url.toString(),
        responseHeaders:{date:response.headers?.get('date')||null,age:response.headers?.get('age')||null}};
    },signal,{kind:`geckoterminal_${kind}`});
  }
  const metadataKey=(id,inactive)=>`${id.network}:${id.address}:${inactive}`;
  async function loadPool(id,signal,includeInactiveSource=false,waitForSlot=true) {
    const key=metadataKey(id,includeInactiveSource),cached=metadata.get(key);
    if(cached&&now()-Date.parse(cached.binding.metadataReceivedAt)<metadataTtlMs)return cached;
    const result=await request(()=>`networks/${id.network}/tokens/${encodeURIComponent(id.address)}/pools?include=base_token,quote_token,dex&include_inactive_source=${includeInactiveSource}&page=1`,'pools',signal,waitForSlot);
    let selected;
    try{selected=bindGeckoPoolResponse(result.raw,{...id,requestedAt:result.requestedAt,receivedAt:result.receivedAt});}
    catch(error){error.rawResponse=result.raw;throw error;}
    const pool={...selected,metadataRawResponse:result.raw};metadata.set(key,pool);return pool;
  }
  function unavailable(error,id) {
    const reasonCode=code(error);lastError=reasonCode;
    return {status:'unavailable',source:'geckoterminal',...id,reasonCode,
      ...(error?.retryAt?{retryAt:error.retryAt}:{}),...(error?.httpStatus?{httpStatus:error.httpStatus}:{}),
      ...(error?.rawResponse!==undefined?{rawResponse:error.rawResponse}:{}),candles:[]};
  }
  function run(work,id) {
    if(closed)return Promise.resolve(unavailable(failure('GT_STOPPED'),id));
    if(jobs.size>=2)return Promise.resolve(unavailable(failure('GT_REQUEST_BUSY'),id));
    const promise=Promise.resolve().then(work).catch(e=>unavailable(e,id)).finally(()=>jobs.delete(promise));
    jobs.add(promise);return promise;
  }
  function resolvePool({chain,address,signal,includeInactiveSource=false,waitForSlot=true}={}) {
    let id;try{id=identity(chain,address);}catch(e){return Promise.resolve(unavailable(e,{chain,address}));}
    const combined=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
    return run(async()=>({status:'ok',source:'geckoterminal',...await loadPool(id,combined,includeInactiveSource,waitForSlot)}),id);
  }
  function prefetchPools({targets,includeInactiveSource=true,signal}={}) {
    let ids;try{
      if(!Array.isArray(targets)||targets.length>100)throw failure('GT_INVALID_TARGETS');
      ids=[...new Map(targets.map(t=>{const id=identity(t.chain,t.address);return [`${id.network}:${id.address}`,id];})).values()];
    }catch(e){return Promise.resolve(unavailable(e,{}));}
    const combined=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
    return run(async()=>{
      const results=[],rawResponses=[];
      try {
      for(const network of [...new Set(ids.map(i=>i.network))]) {
        const group=ids.filter(i=>i.network===network);
        for(let i=0;i<group.length;i+=30) {
          const batch=group.slice(i,i+30),response=await request(()=>`networks/${network}/tokens/multi/${batch.map(x=>encodeURIComponent(x.address)).join(',')}?include=top_pools&include_inactive_source=${includeInactiveSource}`,'tokens',combined);
          rawResponses.push({...response,network});
          const data=response.raw?.data,included=response.raw?.included;
          if(!Array.isArray(data)||!Array.isArray(included))throw failure('GT_INVALID_POOL_RESPONSE');
          for(const id of batch) {
            try {
              const token=data.find(t=>t.id===`${network}_${id.address}`&&t.type==='token'&&same(id.chain,t.attributes?.address,id.address));
              if(!token)throw failure('GT_TOKEN_NOT_FOUND');
              const top=token.relationships?.top_pools?.data?.[0];
              if(top?.type!=='pool')throw failure('GT_NO_POOLS');
              const pool=included.find(p=>p.type==='pool'&&p.id===top.id);
              if(!pool)throw failure('GT_POOL_IDENTITY_MISMATCH');
              const binding=bindGeckoPoolResponse({data:[pool],included:data},{...id,requestedAt:response.requestedAt,receivedAt:response.receivedAt});
              metadata.set(metadataKey(id,includeInactiveSource),binding);results.push({status:'ok',...id,poolId:binding.poolId});
            }catch(e){results.push(unavailable(e,id));}
          }
        }
      }
      }catch(error){return {...unavailable(error,{}),results,rawResponses};}
      return {status:'ok',source:'geckoterminal',results,rawResponses};
    },{});
  }
  function kline({chain,address,resolution='1m',hours=1,from,to,latestClosed=false,signal,waitForSlot=true,frozenPoolId}={}) {
    let id;
    try {
      id=identity(chain,address);
      if(latestClosed&&from===undefined&&to===undefined){to=Math.floor(now()/60000)*60;from=to-3600;}
      if(resolution!=='1m'||hours!==1||typeof latestClosed!=='boolean'||![from,to].every(Number.isSafeInteger)||from<0||from%60||to%60
        ||to-from!==3600||!latestClosed&&to*1000>now())throw failure('GT_INVALID_WINDOW');
    }catch(e){return Promise.resolve(unavailable(e,{chain,address}));}
    const combined=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
    return run(async()=>{
      let pool;
      if(frozenPoolId!==undefined){pool=metadata.get(metadataKey(id,!latestClosed));if(!pool||pool.poolId!==frozenPoolId)throw failure('GT_FROZEN_POOL_UNAVAILABLE');}
      else pool=await loadPool(id,combined,!latestClosed,waitForSlot);
      let requestFrom=from,requestTo=to;
      const result=await request(at=>{
        if(latestClosed){requestTo=Math.floor(at/60000)*60;requestFrom=requestTo-3600;}
        const query=new URLSearchParams({aggregate:'1',before_timestamp:String(requestTo),limit:'100',currency:'usd',token:id.address,include_empty_intervals:'false'});
        return `networks/${id.network}/pools/${encodeURIComponent(pool.poolId)}/ohlcv/minute?${query}`;
      },'ohlcv',combined,waitForSlot);
      let chart;
      try{chart=normalizeGeckoOhlcv(result.raw,pool,{from:requestFrom,to:requestTo,requestedAt:result.requestedAt,
        receivedAt:result.receivedAt,queuedAt:result.queuedAt,requestWindow:latestClosed?'latest_closed_at_dispatch':'fixed_historical'});}
      catch(error){error.rawResponse=result.raw;throw error;}
      return {...chart,requestUrl:result.requestUrl,responseHeaders:result.responseHeaders};
    },id);
  }
  return {resolvePool,prefetchPools,kline,availability,close:()=>closing||(closed=true,controller.abort(),closing=Promise.allSettled([...jobs]).then(()=>undefined)),
    diagnostics:()=>({source:'geckoterminal',closed,pending:jobs.size,minIntervalMs,nextAllowedAt:lastRequestStartedAt?iso(Math.max(lastRequestStartedAt+minIntervalMs,cooldownUntil)):cooldownUntil?iso(cooldownUntil):null,
      cooldownUntil:cooldownUntil?iso(cooldownUntil):null,lastError})};
}
