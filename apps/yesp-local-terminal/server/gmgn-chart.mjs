import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {open,rm} from 'node:fs/promises';
import {secureDirectory,openPrivateRead,checkPrivateFile,commitFile,syncDirectory} from './platform-files.mjs';
import {fault} from './flap-reader.mjs';
import {validateChartRequest} from './market-chart.mjs';

const HOST='https://openapi.gmgn.ai',DAY=86400,RESOLUTIONS={60:'1m',300:'5m',900:'15m',3600:'1h'};
const errorCodes=new Set(['GMGN_NOT_CONFIGURED','GMGN_INVALID_KEY','GMGN_PLAN_REQUIRED','GMGN_RATE_LIMITED','GMGN_NO_DATA','GMGN_INVALID_RESPONSE','GMGN_UNAVAILABLE','GMGN_BUSY','GMGN_CONFIG_CHANGED']);
const safeError=e=>errorCodes.has(e?.code)?e.code:'GMGN_UNAVAILABLE';
const validKey=k=>typeof k==='string'&&(k===''||/^[\x21-\x7e]{16,512}$/.test(k));

// Separate from the wallet session. No private key, wallet address or trade route.
export class GmgnConfigStore{
 constructor(directory=fileURLToPath(new URL('../.private/gmgn/',import.meta.url))){this.directory=directory;this.tail=Promise.resolve();}
 async read(){await secureDirectory(this.directory);const path=join(this.directory,'settings.json');let f;
  try{f=await openPrivateRead(path);}catch(e){if(e.code==='ENOENT')return {apiKey:'',cooldownUntil:0};throw e;}
  try{const s=await checkPrivateFile(path,f);if(s.size>4096)throw fault('GMGN_CONFIG_INVALID');const v=JSON.parse(await f.readFile('utf8'));
   if(!validKey(v.apiKey)||!Number.isSafeInteger(v.cooldownUntil)||v.cooldownUntil<0)throw fault('GMGN_CONFIG_INVALID');return {apiKey:v.apiKey,cooldownUntil:v.cooldownUntil};
  }finally{await f.close();}
 }
 save(value){const content=JSON.stringify(value)+'\n';const run=async()=>{await secureDirectory(this.directory);const target=join(this.directory,'settings.json'),tmp=target+'.'+randomUUID()+'.tmp';const f=await open(tmp,'wx',0o600);
  try{try{await checkPrivateFile(tmp,f);await f.writeFile(content);await f.sync();}finally{await f.close();}await commitFile(tmp,target);await syncDirectory(this.directory);}finally{await rm(tmp,{force:true});}};
  const result=this.tail.then(run);this.tail=result.catch(()=>{});return result;
 }
}
function identity(v,ca){
 if(!v||typeof v!=='object'||Array.isArray(v))throw fault('GMGN_INVALID_RESPONSE');
 if(v.chain!==undefined&&v.chain!=='bsc'||v.address!==undefined&&String(v.address).toLowerCase()!==ca.toLowerCase()||v.token_address!==undefined&&String(v.token_address).toLowerCase()!==ca.toLowerCase())throw fault('GMGN_INVALID_RESPONSE');
}
const decimal=v=>(typeof v==='number'||typeof v==='string'&&/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(v))&&Number.isFinite(Number(v))?Number(v):NaN;
export function normalizeGmgnCandles(payload,{ca,interval,from,to}){
 identity(payload,ca);if(payload.code!==0)throw fault('GMGN_INVALID_RESPONSE');identity(payload.data,ca);
 const rows=payload.data.list;if(!Array.isArray(rows)||rows.length>2000)throw fault('GMGN_INVALID_RESPONSE');
 const seen=new Map();
 for(const item of rows){identity(item,ca);let time=decimal(item.time);if(time>=1e12)time/=1000;
  const [o,h,l,c,v,a]=['open','high','low','close','volume','amount'].map(k=>decimal(item[k]));
  if(!Number.isSafeInteger(time)||time%interval!==0||time<Math.floor(from/interval)*interval||time>to||![o,h,l,c].every(n=>n>0&&Number.isFinite(n))||h<Math.max(o,c,l)||l>Math.min(o,c,h)||!Number.isFinite(v)||v<0||!Number.isFinite(a)||a<0)throw fault('GMGN_INVALID_RESPONSE');
  const candle={time,open:o,high:h,low:l,close:c,volume:v,quoteVolume:a,trades:null,partial:time+interval>to};
  if(seen.has(time)&&JSON.stringify(seen.get(time))!==JSON.stringify(candle))throw fault('GMGN_INVALID_RESPONSE');seen.set(time,candle);
 }
 return [...seen.values()].sort((a,b)=>a.time-b.time);
}
async function responseJson(response){
 if(Number(response.headers.get('content-length'))>1000000)throw fault('GMGN_INVALID_RESPONSE');
 const reader=response.body?.getReader();if(!reader)throw fault('GMGN_INVALID_RESPONSE');let size=0;const parts=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1000000)throw fault('GMGN_INVALID_RESPONSE');parts.push(Buffer.from(value));}
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
 }catch{throw fault('GMGN_INVALID_RESPONSE');}finally{await reader.cancel().catch(()=>{});}
}
export function createGmgnCharts({store=new GmgnConfigStore(),fetchImpl=fetch,clock=Date.now}={}){
 let config,initPromise,revision=0,active=false,lastStart=-Infinity,blocked=null,lastError=null,tail=Promise.resolve();const cache=new Map();
 async function init(){if(!config){initPromise??=store.read().then(v=>{config=v;}).catch(e=>{initPromise=null;throw e;});await initPromise;}}
 function mutate(fn){const result=tail.then(fn);tail=result.catch(()=>{});return result;}
 async function status(){await init();return {gmgn:{configured:Boolean(config.apiKey),cooldownUntil:config.cooldownUntil,lastError}};}
 async function configure(p){if(!p||Object.keys(p).length!==1||!validKey(p.apiKey))throw fault('GMGN_INVALID_KEY');
  return mutate(async()=>{await init();const next={apiKey:p.apiKey,cooldownUntil:config.cooldownUntil};await store.save(next);config=next;revision++;cache.clear();blocked=null;lastError=null;return status();});
 }
 async function fetchCandles(p,from,to){
  if(clock()<config.cooldownUntil)throw fault('GMGN_RATE_LIMITED');if(blocked)throw fault(blocked);
  if(active||clock()-lastStart<1100)throw fault('GMGN_BUSY');active=true;lastStart=clock();const rev=revision;
  try{const url=new URL('/v1/market/token_kline',HOST);for(const [k,v]of Object.entries({chain:'bsc',address:p.tokenAddress,resolution:RESOLUTIONS[p.interval],from:from*1000,to:to*1000,timestamp:Math.floor(clock()/1000),client_id:randomUUID()}))url.searchParams.set(k,String(v));
   // Fixed host and route; no redirects can carry the credential elsewhere.
   const response=await fetchImpl(url,{method:'GET',headers:{'X-APIKEY':config.apiKey,'Content-Type':'application/json','User-Agent':'YESP-Local/1.6.0'},redirect:'error',signal:AbortSignal.timeout(12000)});
   let payload;try{payload=await responseJson(response);}catch(e){if(![401,403,429].includes(response.status))throw e;}
   if(rev!==revision)throw fault('GMGN_CONFIG_CHANGED');
   if(response.status===429||/RATE_LIMIT/.test(payload?.error||'')){
    const reset=Number(response.headers.get('x-ratelimit-reset'))*1000,retry=response.headers.get('retry-after'),retryAt=/^\d+$/.test(retry||'')?clock()+Number(retry)*1000:Date.parse(retry||'');
    const until=Math.max(clock()+60000,Number.isSafeInteger(reset)?reset:0,Number.isSafeInteger(retryAt)?retryAt:0)+1000;
    await mutate(async()=>{config={...config,cooldownUntil:Math.max(config.cooldownUntil,until)};await store.save(config);});throw fault('GMGN_RATE_LIMITED');
   }
   if(payload?.error==='PLAN_UPGRADE_REQUIRED'){blocked='GMGN_PLAN_REQUIRED';throw fault(blocked);}
   if([401,403].includes(response.status)||/INVALID_API_KEY|API_KEY_INVALID|UNAUTHORIZED/.test(payload?.error||'')){blocked='GMGN_INVALID_KEY';throw fault(blocked);}
   if(!response.ok||payload?.code!==0)throw fault('GMGN_UNAVAILABLE');
   return normalizeGmgnCandles(payload,{ca:p.tokenAddress,interval:p.interval,from,to});
  }catch(e){throw fault(safeError(e));}finally{active=false;}
 }
 async function query(params){const p=validateChartRequest(params);await init();if(!config.apiKey)throw fault('GMGN_NOT_CONFIGURED');
  const key=p.tokenAddress.toLowerCase()+':'+p.interval;let entry=cache.get(key);
  if(!entry){if(cache.size>=32){const old=[...cache].find(([,e])=>!e.pending);if(!old)throw fault('GMGN_BUSY');cache.delete(old[0]);}entry={chart:null,pending:null,until:0,error:null};cache.set(key,entry);}
  if(entry.pending)return entry.pending;
  if(clock()<entry.until&&(!p.older||entry.error)){if(entry.error)throw fault(entry.error);return {chart:entry.chart};}
  const rev=revision;
  entry.pending=(async()=>{
   const now=Math.floor(clock()/1000),step=Math.min(300*p.interval,7*DAY),floor=Math.max(0,Math.floor((now-30*DAY)/p.interval)*p.interval),previous=entry.chart;
   if(p.older&&previous&&!previous.hasOlder)return {chart:previous};
   const to=p.older&&previous?previous.fromTime-1:now,from=Math.max(floor,p.older&&previous?to-step+1:previous?Math.floor((previous.toTime-2*p.interval)/p.interval)*p.interval:Math.floor((to-step)/p.interval)*p.interval);
   const rows=await fetchCandles(p,from,to);if(rev!==revision)throw fault('GMGN_CONFIG_CHANGED');if(!rows.length&&!previous)throw fault('GMGN_NO_DATA');
   // Replace the requested time range, including disappeared/updated candles.
   const combined=[...(previous?.candles||[]).filter(c=>c.time<from||c.time>to),...rows].sort((a,b)=>a.time-b.time);
   const truncated=Boolean(previous?.truncated)||combined.length>1600,candles=combined.slice(-1600),fromTime=previous?Math.min(previous.fromTime,from):from;
   entry.chart={tokenAddress:p.tokenAddress,interval:p.interval,source:'gmgn',priceBasis:'usd',quoteSymbol:'USD',baseSymbol:'TOKEN',volumeUnit:'token',
    fromTime,toTime:Math.max(previous?.toTime||0,to),updatedAt:clock(),hasOlder:!truncated&&fromTime>floor&&!(p.older&&!rows.length),truncated,candles};
   entry.error=null;entry.until=clock()+10000;lastError=null;return {chart:entry.chart};
  })().catch(e=>{entry.error=safeError(e);entry.until=clock()+10000;lastError=entry.error;throw fault(entry.error);}).finally(()=>{entry.pending=null;});return entry.pending;
 }
 return {query,status,configure};
}

// Never join USD candles and quote-asset candles into one series.
export function createChartSources({onchain,gmgn}){
 return {async query(params){if(!params||typeof params!=='object'||Array.isArray(params))throw fault('INVALID_REQUEST');const {source='auto',...request}=params;
  if(!['auto','gmgn','onchain'].includes(source))throw fault('INVALID_REQUEST');validateChartRequest(request);
  if(source==='onchain')return onchain.query(request);if(source==='gmgn')return gmgn.query(request);
  try{return await gmgn.query(request);}catch(e){const reason=safeError(e);try{const result=await onchain.query(request);return {...result,chart:{...result.chart,source:'onchain',fallbackReason:reason}};}catch(chainError){if(reason==='GMGN_NOT_CONFIGURED'||chainError.code==='CHART_UNSUPPORTED_MODE')throw fault(reason);throw chainError;}}
 }};
}
