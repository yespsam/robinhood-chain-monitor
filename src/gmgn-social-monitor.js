import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGmgnFlowClient} from './gmgn-flow-client.js';
import {gmgnFlowAddress} from './gmgn-flow-signal.js';

export const GMGN_SOCIAL_VERSION = 'gmgn_platform_calls_v1';
const DAY=86400000;
const clean=v=>typeof v==='string'?v.trim():'';

// Only documented signal fields are actionable as discovery metadata. Raw
// call_details are display-only: a profile URL is never a tweet or endorsement.
export function normalizePlatformCall(row,chain,observedMs) {
  const address=gmgnFlowAddress(chain,row?.token_address),trigger=Number(row?.trigger_at)*1000;
  if(!['sol','bsc'].includes(chain)||!address||row?.signal_type!==13
    ||!clean(row.id)||row.id.length>120||!Number.isSafeInteger(trigger)
    ||trigger<=0||trigger>observedMs||observedMs-trigger>DAY
    ||row.data?.chain!==chain||gmgnFlowAddress(chain,row.data?.address)!==address)return null;
  const contacts=(Array.isArray(row.data.call_details)?row.data.call_details:[]).slice(0,50).flatMap(c=>{
    if(c?.platform_type!=='x')return [];
    try {
      const u=new URL(c.url),m=u.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/status\/(\d+))?\/?$/);
      if(u.protocol!=='https:'||!['x.com','twitter.com'].includes(u.hostname)||u.port||u.username||u.password
        ||!m||m[1].toLowerCase()!==clean(c.account).replace(/^@/,'').toLowerCase())return [];
      return [{handle:m[1],url:`https://x.com/${m[1]}${m[2]?`/status/${m[2]}`:''}`,kind:m[2]?'post_link_unverified':'profile_only'}];
    }catch{return [];}
  });
  return {id:`gmgn-call:${chain}:${row.id}`,chain,address,signalId:row.id,
    symbol:clean(row.data.symbol).slice(0,80),name:clean(row.data.name).slice(0,120),
    sourceAt:new Date(trigger).toISOString(),firstObservedAt:new Date(observedMs).toISOString(),
    lastObservedAt:new Date(observedMs).toISOString(),contacts:[...new Map(contacts.map(c=>[c.url,c])).values()],
    source:'gmgn_platform_call',sourceAuthenticated:false,tweetText:null,discoveryOnly:true};
}

export function createGmgnSocialMonitor({dataDir,client=createGmgnFlowClient({dataDir},
  {scheduler:{tail:Promise.resolve(),lastStartedAt:null,rateLimitedUntil:0}}),now=Date.now,intervalMs=5000}={}) {
  if(!dataDir||!Number.isFinite(intervalMs)||intervalMs<5000)throw new TypeError('invalid social monitor configuration');
  const file=path.join(dataDir,'gmgn-social-state.json');
  let state={version:GMGN_SOCIAL_VERSION,events:[],chains:{},updatedAt:null},loaded=false,stopped=false,started=false;
  let job=null,timer=null,cursor=0;
  const save=async()=>{
    const tmp=`${file}.${process.pid}.${randomUUID()}.tmp`;
    try {await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(tmp,JSON.stringify(state),{flag:'wx',mode:0o600});await fs.rename(tmp,file);}
    finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  };
  const initialize=async()=>{
    if(loaded)return;
    try {const stat=await fs.stat(file);if(stat.size>2*1024*1024)throw new Error('invalid social state');
      const old=JSON.parse(await fs.readFile(file,'utf8'));
      if(old.version!==GMGN_SOCIAL_VERSION||!Array.isArray(old.events)||old.events.length>100||!old.chains)throw new Error('invalid social state');
      state=old;
    }catch(e){if(e.code!=='ENOENT')throw e;}
    loaded=true;
  };
  const pollOnce=()=>{
    if(stopped)return Promise.resolve();
    if(job)return job;
    job=(async()=>{
      await initialize();
      const chain=['sol','bsc'][cursor++%2],at=now(),prior=state.chains[chain]||{};
      if(Date.parse(prior.nextAttemptAt)>at)return;
      state.chains[chain]={...prior,status:'checking',lastAttemptAt:new Date(at).toISOString()};
      try {
        const payload=await client.platformCalls(chain),received=now();
        if(stopped)return;
        const rows=Array.isArray(payload)?payload:payload?.data;
        if(!Array.isArray(rows)||rows.length>50)throw Object.assign(new Error(),{code:'GMGN_INVALID_RESPONSE'});
        const previous=new Map(state.events.map(e=>[e.id,e]));
        let accepted=0;
        for(const raw of rows){
          const item=normalizePlatformCall(raw,chain,received);if(!item)continue;accepted++;
          const old=previous.get(item.id);
          if(old&&(old.chain!==item.chain||old.address!==item.address||old.sourceAt!==item.sourceAt)) {
            previous.set(item.id,{...old,conflict:true});continue;
          }
          previous.set(item.id,{...item,firstObservedAt:old?.firstObservedAt||item.firstObservedAt,...(old?.conflict?{conflict:true}:{})});
        }
        state.events=[...previous.values()].filter(e=>received-Date.parse(e.sourceAt)<=DAY)
          .sort((a,b)=>Date.parse(b.sourceAt)-Date.parse(a.sourceAt)).slice(0,100);
        state.chains[chain]={status:'healthy',lastAttemptAt:new Date(at).toISOString(),lastSuccessAt:new Date(received).toISOString(),
          nextAttemptAt:new Date(received+intervalMs).toISOString(),returned:rows.length,accepted,failures:0,
          truncated:rows.length===50,coverage:'latest_50_platform_calls_not_full_twitter',requestMs:received-at};
      }catch(e){
        if(stopped)return;
        const failures=(prior.failures||0)+1,retry=Math.max(now()+Math.min(300000,intervalMs*2**Math.min(failures,6)),Date.parse(e.retryAt)||0);
        state.chains[chain]={...prior,status:'backoff',failures,lastAttemptAt:new Date(at).toISOString(),
          nextAttemptAt:new Date(retry).toISOString(),error:/^GMGN_[A-Z_]+$/.test(e.code||'')?e.code:'GMGN_SOCIAL_UNAVAILABLE'};
      }
      state.updatedAt=new Date(now()).toISOString();await save();
    })().finally(()=>{job=null;});return job;
  };
  const schedule=()=>{if(stopped)return;timer=setTimeout(()=>{pollOnce().catch(()=>{}).finally(schedule);},intervalMs);timer.unref?.();};
  return {pollOnce,snapshot:()=>structuredClone(state),
    async start(){if(started||stopped)return;await initialize();started=true;void pollOnce().catch(()=>{}).finally(schedule);},
    async stop(){stopped=true;clearTimeout(timer);await client.stop();await Promise.allSettled([job]);}};
}
