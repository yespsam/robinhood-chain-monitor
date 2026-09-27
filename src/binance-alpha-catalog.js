import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {gmgnFlowAddress} from './gmgn-flow-signal.js';

export const ALPHA_CATALOG_VERSION='binance_alpha_catalog_v1';
export const ALPHA_LIST_URL='https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list';
export const ALPHA_ENTRY_VERSION='alpha_event_entry_v1';
export const ALPHA_EVENT_TTL=86400000;
const chains={'56':'bsc','8453':'base','1':'eth','4663':'robinhood','CT_501':'sol'};
const iso=n=>new Date(n).toISOString(), stamp=s=>Date.parse(s||'');
const fresh=(s,now,ttl)=>Number.isFinite(stamp(s))&&stamp(s)<=now&&now-stamp(s)<=ttl;
const key=t=>`${t.chain}:${t.address}`;
const clean=v=>typeof v==='string'?v.trim():'';

// Public, documented Binance directory. Its listingTime is event time, NEVER
// the fetch time. Directory prices are not promoted to independent fill quotes.
export function normalizeAlphaCatalog(payload) {
  if(payload?.code!=='000000'||payload.success!==true||!Array.isArray(payload.data)
    ||!payload.data.length||payload.data.length>5000)throw new Error('Alpha 目录响应异常');
  const rows=[],ids=new Set(),assets=new Set();
  for(const raw of payload.data){
    const chain=chains[raw.chainId];if(!chain)continue;
    const address=gmgnFlowAddress(chain,raw.contractAddress),alphaId=clean(raw.alphaId);
    if(!address||!/^ALPHA_\d+$/.test(alphaId)||!clean(raw.tokenId)||!clean(raw.symbol)||!clean(raw.name)
      ||!Number.isSafeInteger(raw.listingTime)||raw.listingTime<=0
      ||typeof raw.offline!=='boolean'||typeof raw.offsell!=='boolean')throw new Error('Alpha 身份或时间字段异常');
    if(ids.has(alphaId)||assets.has(`${chain}:${address}`))throw new Error('Alpha 身份重复，暂停事件入口');
    ids.add(alphaId);assets.add(`${chain}:${address}`);
    rows.push({alphaId,tokenId:raw.tokenId,chain,address,symbol:raw.symbol.slice(0,80),name:raw.name.slice(0,120),
      listingTime:raw.listingTime,offline:raw.offline,offsell:raw.offsell});
  }
  if(!rows.length)throw new Error('Alpha 目录没有支持链');
  return rows;
}

export function advanceAlphaCatalog(prior,rows,nowMs) {
  const old=new Map((prior?.tokens||[]).map(t=>[t.alphaId,t]));
  const conflicts=new Set(prior?.conflicts||[]);
  for(const t of rows){
    const prev=old.get(t.alphaId);
    if(prev&&(key(prev)!==key(t)||prev.tokenId!==t.tokenId||prev.listingTime!==t.listingTime))conflicts.add(t.alphaId);
    old.set(t.alphaId,{...t,firstObservedAt:prev?.firstObservedAt||iso(nowMs),lastObservedAt:iso(nowMs)});
  }
  if(old.size>5000)throw new Error('Alpha 本地目录容量异常');
  return {version:ALPHA_CATALOG_VERSION,sourceUrl:ALPHA_LIST_URL,tokens:[...old.values()],conflicts:[...conflicts],
    health:{status:'healthy',lastSuccessAt:iso(nowMs),lastError:null,nextAttemptAt:null},updatedAt:iso(nowMs)};
}

export function validAlphaSignal(s,token,nowMs) {
  return !!s&&s.version===ALPHA_ENTRY_VERSION&&s.sourceUrl===ALPHA_LIST_URL
    &&s.chain===token?.chain&&s.address===gmgnFlowAddress(token.chain,token.address)
    &&/^ALPHA_\d+$/.test(s.alphaId||'')&&Number.isSafeInteger(s.listingTime)&&s.listingTime>0
    &&s.listingTime<=nowMs&&nowMs-s.listingTime<=ALPHA_EVENT_TTL
    &&s.id===`binance-alpha:${s.alphaId}:${s.chain}:${s.address}:${s.listingTime}`
    &&fresh(s.observedAt,nowMs,30000)&&s.offline===false&&s.offsell===false;
}

export function alphaListingSignals(state,nowMs) {
  if(state?.version!==ALPHA_CATALOG_VERSION||state.sourceUrl!==ALPHA_LIST_URL
    ||state.health?.status!=='healthy'||!fresh(state.health.lastSuccessAt,nowMs,30000))return [];
  return (state.tokens||[]).flatMap(t=>{
    if(state.conflicts?.includes(t.alphaId)||t.lastObservedAt!==state.health.lastSuccessAt)return [];
    const s={...t,version:ALPHA_ENTRY_VERSION,sourceUrl:ALPHA_LIST_URL,observedAt:t.lastObservedAt,
      id:`binance-alpha:${t.alphaId}:${t.chain}:${t.address}:${t.listingTime}`};
    return validAlphaSignal(s,t,nowMs)?[s]:[];
  }).sort((a,b)=>b.listingTime-a.listingTime);
}

export function alphaCatalogReport(state,nowMs) {
  const signals=alphaListingSignals(state,nowMs);
  return {version:ALPHA_CATALOG_VERSION,sourceUrl:ALPHA_LIST_URL,status:state?.health?.status||'unavailable',
    lastSuccessAt:state?.health?.lastSuccessAt||null,lastError:state?.health?.lastError||null,
    fresh:state?.health?.status==='healthy'&&fresh(state?.health?.lastSuccessAt,nowMs,30000),
    count:state?.tokens?.length||0,activeSignals:signals.length,pollIntervalMs:5000,
    latest:[...(state?.tokens||[])].sort((a,b)=>b.listingTime-a.listingTime).slice(0,6).map(t=>({
      chain:t.chain,address:t.address,symbol:t.symbol,listingAt:iso(t.listingTime),
      eligibleEvent:signals.some(s=>s.alphaId===t.alphaId),
      phase:nowMs-t.listingTime<=300000?'刚上新快线':nowMs-t.listingTime<=ALPHA_EVENT_TTL?'上新后跟随':'历史上新'}))};
}

export function createAlphaCatalogMonitor({dataDir,fetchImpl=fetch,now=Date.now,intervalMs=5000}={}) {
  if(!dataDir||intervalMs<5000)throw new TypeError('invalid Alpha monitor');
  const file=path.join(dataDir,'binance-alpha-catalog.json');
  let state=null,loaded=false,stopped=false,started=false,job=null,timer=null;
  const save=async()=>{
    const tmp=`${file}.${process.pid}.${randomUUID()}.tmp`;
    try{await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(tmp,JSON.stringify(state),{mode:0o600,flag:'wx'});await fs.rename(tmp,file);}
    finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  };
  const load=async()=>{
    if(loaded)return;
    try{const stat=await fs.stat(file);if(stat.size>3*1024*1024)throw new Error('Alpha 状态过大');
      state=JSON.parse(await fs.readFile(file,'utf8'));
      if(state?.version!==ALPHA_CATALOG_VERSION||state.sourceUrl!==ALPHA_LIST_URL||!Array.isArray(state.tokens)
        ||state.tokens.length>5000||!Array.isArray(state.conflicts))throw new Error('Alpha 状态格式异常');
    }catch(e){if(e.code!=='ENOENT')throw e;}
    loaded=true;
  };
  const pollOnce=()=>{
    if(stopped)return Promise.resolve();if(job)return job;
    job=(async()=>{
      await load();if(stamp(state?.health?.nextAttemptAt)>now())return;
      try{
        const response=await fetchImpl(ALPHA_LIST_URL,{signal:AbortSignal.timeout(10000),redirect:'error'});
        if(!response.ok){
          const retry=response.headers?.get('retry-after');
          const delay=retry&&/^\d+$/.test(retry)?Number(retry)*1000:Math.max(0,stamp(retry)-now());
          throw Object.assign(new Error(`Alpha HTTP ${response.status}`),{delay:Math.max(30000,delay||0,response.status===429?60000:0)});
        }
        const raw=await response.text();if(Buffer.byteLength(raw)>3*1024*1024)throw new Error('Alpha 响应过大');
        const next=advanceAlphaCatalog(state,normalizeAlphaCatalog(JSON.parse(raw)),now());
        if(stopped)return;state=next;
      }catch(e){if(stopped)return;
        state={version:ALPHA_CATALOG_VERSION,sourceUrl:ALPHA_LIST_URL,tokens:[],conflicts:[],...state,
          health:{...state?.health,status:'backoff',lastError:e.message.slice(0,180),nextAttemptAt:iso(now()+(e.delay||30000))}};
      }
      await save();
    })().finally(()=>{job=null;});return job;
  };
  const tick=async()=>{try{await pollOnce();}catch(e){console.error(`Alpha 只读监控：${e.message}`);}
    if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref?.();}};
  return {pollOnce,snapshot:()=>structuredClone(state),start:async()=>{if(started)return;started=true;stopped=false;await load();void tick();},
    stop:async()=>{stopped=true;clearTimeout(timer);await job;}};
}
