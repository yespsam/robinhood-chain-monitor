import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {sendAlerts,isTerminalAlertSuppression} from './alerts.js';
import {createGmgnFlowClient} from './gmgn-flow-client.js';
import {GMGN_FLOW_CHAINS,GMGN_HOT_ONLY_CHAINS,GMGN_FLOW_DEFAULTS,gmgnFlowAddress,gmgnFlowData,gmgnFlowTags,
  parseGmgnFlowTrades,parseGmgnFlowProfile,parseGmgnFlowCandles,gmgnFlowVolume,evaluateGmgnFlowSignal,isGmgnFlowEvent} from './gmgn-flow-signal.js';
import {resolveGmgnFlowNarrative} from './gmgn-flow-narrative.js';
const CHAINS=Object.keys(GMGN_FLOW_CHAINS),MINUTE=60000;
const iso=n=>new Date(n).toISOString(),plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const accepted=r=>['queued','delivered','duplicate','already_queued'].includes(r?.status)||(r?.status==='suppressed'&&isTerminalAlertSuppression(r));
const emptySource=()=>({status:'initializing',checkedAt:null,lastSuccessAt:null,nextAttemptAt:null,lastError:null,lastErrorCode:null,tradeCount:0,candidateCount:0,feedTruncated:false,coverageGap:null,quarantinedTokens:{}});
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v)),nullableDate=v=>v===null||date(v);
const errorText=v=>v===null||typeof v==='string';
function sourceShape(h,global=false){return plain(h)&&['initializing','healthy','partial','backoff','unsupported'].includes(h.status)
 && nullableDate(h.checkedAt)&&nullableDate(h.nextAttemptAt)&&errorText(h.lastError)
 && (global||(nullableDate(h.lastSuccessAt)&&Number.isSafeInteger(h.tradeCount)&&h.tradeCount>=0
   &&Number.isSafeInteger(h.candidateCount)&&h.candidateCount>=0&&typeof h.feedTruncated==='boolean'&&errorText(h.coverageGap)))&&errorText(h.lastErrorCode);}
export function validateGmgnFlowState(s) {
  if(s?.version!==1||!date(s.initializedAt)||!date(s.updatedAt)||!sourceShape(s.health,true)||!plain(s.chains)||!plain(s.trades)
    ||!plain(s.profiles)||Object.keys(s.profiles).length>10000||!plain(s.episodes)||Object.keys(s.episodes).length>10000
    ||!Array.isArray(s.pendingEvents)||s.pendingEvents.length>500||s.pendingEvents.some(e=>!isGmgnFlowEvent(e))
    ||new Set(s.pendingEvents.map(e=>e.eventKey)).size!==s.pendingEvents.length
    ||!Number.isSafeInteger(s.nextChainIndex)||s.nextChainIndex<0||s.nextChainIndex>=CHAINS.length||!plain(s.hotDiscovery)
    ||CHAINS.some(c=>!sourceShape(s.chains[c])||!Array.isArray(s.trades[c])||s.trades[c].length>10000)) throw new Error('GMGN_FLOW_STATE_INVALID');
  if(!['initializing','healthy','partial','backoff'].includes(s.hotDiscovery.status)
    ||!nullableDate(s.hotDiscovery.checkedAt)||!nullableDate(s.hotDiscovery.nextAttemptAt)||!errorText(s.hotDiscovery.lastError)
    ||!Array.isArray(s.hotDiscovery.chains)||s.hotDiscovery.chains.length>4
    ||s.hotDiscovery.chains.some(c=>!GMGN_HOT_ONLY_CHAINS.includes(c.chain)||!Number.isSafeInteger(c.count)||c.count<0||c.mode!=='discovery_only'))throw new Error('GMGN_FLOW_STATE_INVALID');
  for(const chain of CHAINS){const quarantined=s.chains[chain].quarantinedTokens;
    if(quarantined!==undefined&&(!plain(quarantined)||Object.keys(quarantined).length>10000
      ||Object.entries(quarantined).some(([ca,until])=>gmgnFlowAddress(chain,ca)!==ca||!date(until))))throw new Error('GMGN_FLOW_STATE_INVALID');
  }
  for(const [c,rows] of Object.entries(s.trades)) if(!CHAINS.includes(c)||rows.some(t=>t.chain!==c
    ||gmgnFlowAddress(c,t.wallet)!==t.wallet||gmgnFlowAddress(c,t.tokenAddress)!==t.tokenAddress
    ||!Number.isFinite(t.amountUsd)||t.amountUsd<=0||!Number.isSafeInteger(t.at)||!['buy','sell'].includes(t.side)
    ||!Array.isArray(t.tags)||t.tags.some(x=>typeof x!=='string')
    ||!(c==='sol'?/^[1-9A-HJ-NP-Za-km-z]{64,100}$/:/^0x[\da-f]{64}$/).test(t.hash)
    ||t.key!==`${c}:${t.hash}:${t.wallet}:${t.tokenAddress}:${t.side}`))throw new Error('GMGN_FLOW_TRADE_STATE_INVALID');
  for(const [key,p] of Object.entries(s.profiles)) {
    const [chain,wallet]=key.split(':');
    if(!plain(p)||gmgnFlowAddress(chain,wallet)!==wallet||(p.nextCheckAt!==undefined&&!date(p.nextCheckAt)))throw new Error('GMGN_FLOW_STATE_INVALID');
    for(const period of ['7d','30d'])if(p[period]){const v=p[period];
      if(!plain(v)||v.chain!==chain||v.wallet!==wallet||v.period!==period||!date(v.checkedAt)||!Array.isArray(v.tags)
        ||v.tags.some(t=>typeof t!=='string')||['realizedProfitUsd','realizedRoi','winRate','tokenCount','buyCount','sellCount','createdAt','lastTradeAt','createdTokenCount'].some(k=>!Number.isFinite(v[k])))throw new Error('GMGN_FLOW_STATE_INVALID');
    }
  }
  for(const [key,e] of Object.entries(s.episodes)) {
    const [chain,ca]=key.split(':');
    if(!plain(e)||gmgnFlowAddress(chain,ca)!==ca||(e.lastSentAt!==undefined&&!date(e.lastSentAt))
      ||(e.lastCheckedAt!==undefined&&!date(e.lastCheckedAt)))throw new Error('GMGN_FLOW_STATE_INVALID');
  }
  return s;
}
export function createGmgnFlowMonitor(config={},dependencies={}) {
 const enabled=config.gmgnFlowMonitorEnabled===true,now=dependencies.now||Date.now,fsImpl=dependencies.fsImpl||fs;
 const logger=dependencies.logger||console,sender=dependencies.sendAlertsImpl||sendAlerts;
 const client=dependencies.client||(enabled?createGmgnFlowClient(config):null);
 const file=path.join(config.dataDir||'data','gmgn-flow-state.json');
 const poll=Math.max(5000,Number(config.gmgnFlowPollIntervalMs)||15000);
 const cooldown=Math.max(5*MINUTE,Number(config.gmgnFlowTokenCooldownMs)||30*MINUTE);
 let state,loading,active,saving=Promise.resolve(),writeFault=null,stopped=false;
 async function load() {
  if(state)return;
  if(!loading)loading=(async()=>{
   try {const stat=await fsImpl.stat(file);if(stat.size>24*1024*1024)throw new Error('GMGN_FLOW_STATE_TOO_LARGE');state=validateGmgnFlowState(JSON.parse(await fsImpl.readFile(file,'utf8')));}
   catch(e){if(e.code!=='ENOENT')throw e;state={version:1,initializedAt:iso(now()),updatedAt:iso(now()),nextChainIndex:0,
    health:{status:'initializing',checkedAt:null,lastError:null,lastErrorCode:null,nextAttemptAt:null},
    chains:Object.fromEntries(CHAINS.map(c=>[c,emptySource()])),trades:Object.fromEntries(CHAINS.map(c=>[c,[]])),profiles:{},episodes:{},pendingEvents:[],
    hotDiscovery:{status:'initializing',checkedAt:null,nextAttemptAt:null,lastError:null,chains:[]}};}
  })();
  await loading;
 }
 async function persist() {
  if(writeFault)throw writeFault;
  state.updatedAt=iso(now());
  const text=JSON.stringify(state);
  if(Buffer.byteLength(text)>24*1024*1024)throw new Error('GMGN_FLOW_STATE_TOO_LARGE');
  const task=saving.then(async()=>{
   if(writeFault)throw writeFault;
   await fsImpl.mkdir(path.dirname(file),{recursive:true,mode:0o700});
   const temp=`${file}.${process.pid}.${randomUUID()}.tmp`;
   await fsImpl.writeFile(temp,`${text}\n`,{mode:0o600});await fsImpl.rename(temp,file);
  });
  saving=task.catch(e=>{writeFault=e;});await task;
 }
 async function heartbeat() {state.health.checkedAt=iso(now());await persist();}
 const assertActive=()=>{if(stopped)throw new Error('GMGN_FLOW_STOPPED');};
 const quarantined=(chain,token)=>Date.parse(state.chains[chain]?.quarantinedTokens?.[token])>now();
 async function request(fn) {assertActive();await heartbeat();assertActive();const result=await fn();assertActive();await heartbeat();return result;}
 async function queue(event) {
  assertActive();
  if(quarantined(event.chain.slug,event.token.address)){
   state.pendingEvents=state.pendingEvents.filter(e=>e.eventKey!==event.eventKey);
   state.chains[event.chain.slug].coverageGap='ambiguous_trade_legs';await persist();return;
  }
  if(!state.pendingEvents.some(e=>e.eventKey===event.eventKey)){if(state.pendingEvents.length>=500)throw new Error('GMGN_FLOW_PENDING_FULL');state.pendingEvents.push(event);await persist();}
  assertActive();
  const result=await sender(config,event);
  if(!accepted(result))throw new Error('GMGN_FLOW_DELIVERY_NOT_DURABLE');
  if(result.status!=='suppressed')state.episodes[`${event.chain.slug}:${event.token.address}`]={lastSentAt:iso(now()),windowEndAt:event.signal.windowEndAt,
   volumeMultiple:event.signal.volumeMultiple,uniqueBuyerCount:event.signal.uniqueBuyerCount,eventKey:event.eventKey};
  state.pendingEvents=state.pendingEvents.filter(e=>e.eventKey!==event.eventKey);await persist();
 }
 async function narrativeEvents() {
  if(dependencies.narrativeEventsImpl)return dependencies.narrativeEventsImpl();
  try {const p=path.join(config.dataDir||'data','fomo-alerts','alert-outbox.json'),stat=await fsImpl.stat(p);
   if(stat.size>8*1024*1024)return [];
   const data=JSON.parse(await fsImpl.readFile(p,'utf8'));return Object.values(data.events||{}).slice(-1000);
  }catch{return [];}
 }
 async function tokenCandidate(chain,tokenAddress,trades,market) {
  if(quarantined(chain,tokenAddress)){state.chains[chain].coverageGap='ambiguous_trade_legs';return;}
  const windowEndMs=Math.floor(now()/MINUTE)*MINUTE;
  const rows=trades.filter(t=>t.tokenAddress===tokenAddress&&t.at>=windowEndMs-5*MINUTE&&t.at<windowEndMs);
  if(rows.length>800){state.chains[chain].coverageGap='token_evidence_budget_exceeded';return;}
  const wallets=[...new Set(rows.filter(t=>t.side==='buy').map(t=>t.wallet))];
  const fomo=new Set(rows.filter(t=>t.side==='buy'&&t.tags.includes('fomo')).map(t=>t.wallet));
  if(wallets.length<GMGN_FLOW_DEFAULTS.uniqueBuyerCount||fomo.size<GMGN_FLOW_DEFAULTS.fomoCount)return;
  // Known fake-volume/honeypot flags suppress candidates, without adding noisy risk prose.
  if(market?.is_wash_trading===true||Number(market?.rug_ratio)>0.3||[1,true,'yes'].includes(market?.is_honeypot))return;
  const key=`${chain}:${tokenAddress}`,episode=state.episodes[key];
  if(episode&&now()-Date.parse(episode.lastSentAt)<cooldown)return;
  const candles=parseGmgnFlowCandles(await request(()=>client.candles(chain,tokenAddress,Math.floor((windowEndMs-21*MINUTE)/1000),Math.floor(windowEndMs/1000))));
  const selected=candles.filter(c=>c.time>=windowEndMs-20*MINUTE&&c.time<windowEndMs),volume=gmgnFlowVolume(selected,windowEndMs);
  if(!volume||volume.volumeUsd<GMGN_FLOW_DEFAULTS.volumeUsd||volume.volumeMultiple<GMGN_FLOW_DEFAULTS.volumeMultiple)return;
  const needs=wallets.filter(w=>{
    const p=state.profiles[`${chain}:${w}`];
    if(Date.parse(p?.nextCheckAt)>now())return false;
    return !p||['7d','30d'].some(period=>!p[period]||now()-Date.parse(p[period].checkedAt)>30*MINUTE);
  }).slice(0,8);
  if(needs.length)for(const period of ['7d','30d']) {
   const payload=await request(()=>client.stats(chain,needs,period));
   for(const wallet of needs){const profile=parseGmgnFlowProfile(payload,chain,wallet,period,now());
    if(profile){state.profiles[`${chain}:${wallet}`]||={};state.profiles[`${chain}:${wallet}`][period]=profile;}
    else {state.chains[chain].coverageGap='wallet_profile_incomplete';delete state.profiles[`${chain}:${wallet}`]?.[period];}
   }
   if(period==='30d')for(const wallet of needs){const p=state.profiles[`${chain}:${wallet}`]||={};p.nextCheckAt=iso(now()+(p['7d']&&p['30d']?30:5)*MINUTE);}
   await persist();
  }
  const profiles=Object.fromEntries(wallets.filter(w=>state.profiles[`${chain}:${w}`]).map(w=>[w,state.profiles[`${chain}:${w}`]]));
  if(wallets.some(w=>['7d','30d'].some(period=>!profiles[w]?.[period]
    ||now()-Date.parse(profiles[w][period].checkedAt)>2*3600000)))state.chains[chain].coverageGap='wallet_profile_incomplete';
  const evidence={version:1,provider:'gmgn-cli',chain,tokenAddress,windowEndMs,candles:selected,trades:rows,profiles};
  if(!evaluateGmgnFlowSignal({...evidence,nowMs:now()}))return;
  let tokenInfo=null;
  try {const raw=gmgnFlowData(await request(()=>client.info(chain,tokenAddress)));
   if(gmgnFlowAddress(chain,raw?.address)!==tokenAddress||(raw.chain&&raw.chain!==chain))throw new Error('GMGN_TOKEN_IDENTITY');
   tokenInfo={...raw,chain,address:tokenAddress};
  }catch(e){assertActive();state.chains[chain].coverageGap='narrative_metadata_unavailable';if(e.code==='GMGN_RATE_LIMITED')state.health.nextAttemptAt=e.retryAt;}
  const observedAt=iso(now()),result=evaluateGmgnFlowSignal({...evidence,nowMs:now()});if(!result)return;
  const narrative=resolveGmgnFlowNarrative({chain,tokenAddress,tokenInfo,events:await narrativeEvents(),nowMs:now()});
  const event={type:'gmgn_flow_surge',platform:'gmgn',chain:GMGN_FLOW_CHAINS[chain],token:{address:tokenAddress,
    symbol:String(tokenInfo?.symbol||market?.symbol||rows[0]?.symbol||'').slice(0,40),name:String(tokenInfo?.name||market?.name||'').slice(0,100)},
   source:{id:'gmgn_flow_observed',trust:'provider_reported',url:`https://gmgn.ai/${chain}/token/${tokenAddress}`},
   eventKey:`gmgn-flow:${chain}:${tokenAddress}:${windowEndMs}`,observedAt,sourceOccurredAt:result.signal.windowEndAt,...result,narrative,evidence};
  if(!isGmgnFlowEvent(event))throw new Error('GMGN_FLOW_EVENT_INVALID');
  await queue(event);
 }
 async function scan(chain) {
  const h=state.chains[chain];h.checkedAt=iso(now());h.coverageGap=null;
  h.quarantinedTokens||={};
  for(const [token,until] of Object.entries(h.quarantinedTokens))if(Date.parse(until)<=now())delete h.quarantinedTokens[token];
  const smart=await request(()=>client.trades(chain,'smartmoney'));
  const kol=await request(()=>client.trades(chain,'kol'));
  const feeds=[smart,kol].map(gmgnFlowData);
  if(feeds.some(feed=>!Array.isArray(feed?.list)))throw new Error('GMGN_TRADE_SCHEMA');
  const byToken=new Map(),byKey=new Map(state.trades[chain].filter(t=>t.at>=now()-20*MINUTE
    &&!quarantined(chain,t.tokenAddress)).map(t=>[t.key,t]));
  for(const row of feeds.flatMap(feed=>feed.list)){
   const token=gmgnFlowAddress(chain,row?.base_address);
   if(!token||quarantined(chain,token))continue;
   if(!byToken.has(token))byToken.set(token,[]);
   byToken.get(token).push(row);
  }
  const quarantine=token=>{
   if(!Object.hasOwn(h.quarantinedTokens,token)&&Object.keys(h.quarantinedTokens).length>=10000)throw new Error('GMGN_FLOW_QUARANTINE_FULL');
   h.quarantinedTokens[token]=iso(now()+6*MINUTE);
   for(const [key,t] of byKey)if(t.tokenAddress===token)byKey.delete(key);
   state.pendingEvents=state.pendingEvents.filter(e=>e.chain.slug!==chain||e.token.address!==token);
   h.coverageGap='ambiguous_trade_legs';
  };
  let recentIncomingCount=0;
  for(const [token,rows] of byToken){
   let incoming;
   try{incoming=parseGmgnFlowTrades({list:rows},chain,now());}
   catch(e){if(e?.message==='GMGN_TRADE_CONFLICT'||e?.code==='GMGN_TRADE_CONFLICT'){quarantine(token);continue;}throw e;}
   if(incoming.some(trade=>{const old=byKey.get(trade.key);return old&&(old.amountUsd!==trade.amountUsd||old.at!==trade.at);})){
    quarantine(token);continue;
   }
   recentIncomingCount+=incoming.filter(trade=>trade.at>=now()-6*MINUTE).length;
   for(const trade of incoming){const old=byKey.get(trade.key);
    byKey.set(trade.key,{...trade,tags:gmgnFlowTags([...(old?.tags||[]),...trade.tags])});
   }
  }
  const ordered=[...byKey.values()].sort((a,b)=>a.at-b.at),discarded=ordered.slice(0,Math.max(0,ordered.length-4000));
  if(discarded.length)h.discardedThroughAt=Math.max(h.discardedThroughAt||0,discarded.at(-1).at);
  state.trades[chain]=ordered.slice(-4000);
  h.tradeCount=state.trades[chain].length;
  if(!recentIncomingCount)h.coverageGap='no_recent_trade_observations';
  h.feedTruncated=feeds.some(feed=>feed.list.length>=100);
  if(h.feedTruncated)h.coverageGap='bounded_trade_feed_not_full_chain';
  if(Object.keys(h.quarantinedTokens).length)h.coverageGap='ambiguous_trade_legs';
  await persist();
  const groups=new Map();
  for(const t of state.trades[chain])if(t.side==='buy'&&t.at>=now()-6*MINUTE){const group=groups.get(t.tokenAddress)||{fomo:new Set(),buyers:new Set(),usd:0};
   group.buyers.add(t.wallet);if(t.tags.includes('fomo'))group.fomo.add(t.wallet);group.usd+=t.amountUsd;groups.set(t.tokenAddress,group);}
  const candidates=[...groups].filter(([token,g])=>g.fomo.size>=3&&g.buyers.size>=6
    && !quarantined(chain,token)
    && !(now()-Date.parse(state.episodes[`${chain}:${token}`]?.lastSentAt)<cooldown))
    .sort((a,b)=>(Date.parse(state.episodes[`${chain}:${a[0]}`]?.lastCheckedAt)||0)-(Date.parse(state.episodes[`${chain}:${b[0]}`]?.lastCheckedAt)||0)||b[1].usd-a[1].usd);
  h.candidateCount=candidates.length;
  if((h.discardedThroughAt||0)>=Math.floor(now()/MINUTE)*MINUTE-5*MINUTE)h.coverageGap='local_trade_window_truncated';
  else if(candidates.length){
   const rank=gmgnFlowData(await request(()=>client.trending(chain)));
   if(!Array.isArray(rank?.rank))throw new Error('GMGN_MARKET_SCHEMA');
   for(const [token] of candidates.slice(0,2)){
    (state.episodes[`${chain}:${token}`]||={}).lastCheckedAt=iso(now());
    await tokenCandidate(chain,token,state.trades[chain],rank.rank.find(r=>gmgnFlowAddress(chain,r.address)===token));
   }
   if(candidates.length>2)h.coverageGap='candidate_budget_limited';
  }
  if(Object.keys(h.quarantinedTokens).length)h.coverageGap='ambiguous_trade_legs';
  h.status=h.coverageGap?'partial':'healthy';h.checkedAt=iso(now());h.lastSuccessAt=h.checkedAt;h.nextAttemptAt=iso(now()+poll);
  h.lastError=null;h.lastErrorCode=null;
 }
 async function hotDiscovery() {
  const h=state.hotDiscovery;
  if(Date.parse(h.nextAttemptAt||'')>now())return;
  h.checkedAt=iso(now());
  try {const blocks=gmgnFlowData(await request(()=>client.hotSearches(GMGN_HOT_ONLY_CHAINS)));
   if(!Array.isArray(blocks))throw new Error('GMGN_HOT_SEARCH_SCHEMA');
   h.chains=blocks.filter(b=>GMGN_HOT_ONLY_CHAINS.includes(b.chain)).map(b=>({chain:b.chain,count:Array.isArray(b.tokens)?b.tokens.length:0,mode:'discovery_only'}));
   h.status=h.chains.length===GMGN_HOT_ONLY_CHAINS.length?'healthy':'partial';h.lastError=null;h.nextAttemptAt=iso(now()+5*MINUTE);
  }catch(e){h.status='backoff';h.lastError=String(e.message).slice(0,200);h.nextAttemptAt=e.retryAt||iso(now()+5*MINUTE);if(e.code==='GMGN_RATE_LIMITED')throw e;}
 }
 async function run() {
  await load();if(writeFault)throw writeFault;
  await heartbeat();
  if(Date.parse(state.health.nextAttemptAt||'')>now())return structuredClone(state.health);
  state.health.lastError=null;state.health.lastErrorCode=null;state.health.nextAttemptAt=null;
  const chain=CHAINS[state.nextChainIndex];state.nextChainIndex=(state.nextChainIndex+1)%CHAINS.length;
  try {
   for(const event of [...state.pendingEvents])await queue(event);
   if(Date.parse(state.chains[chain].nextAttemptAt||'')<=now()||!state.chains[chain].nextAttemptAt)await scan(chain);
   if(chain==='robinhood')await hotDiscovery();
  }catch(e){
   if(stopped){await persist();return {status:'stopped'};}
   const retry=e.retryAt||iso(now()+MINUTE),h=state.chains[chain];
   Object.assign(h,{status:'backoff',checkedAt:iso(now()),nextAttemptAt:retry,lastError:String(e.message).slice(0,300),lastErrorCode:e.code||/^GMGN_[A-Z_]+/.exec(e.message)?.[0]||'GMGN_FLOW_SOURCE_FAILED'});
   if(e.code==='GMGN_RATE_LIMITED'){state.health.nextAttemptAt=retry;state.health.status='backoff';}
   state.health.lastError=h.lastError;state.health.lastErrorCode=h.lastErrorCode;
   logger.error?.(`[gmgn-flow][${chain}] ${h.lastErrorCode}`);
  }
  if(state.health.status!=='backoff'||!state.health.nextAttemptAt)state.health.status='partial';
  const prune=(object,limit)=>{const keys=Object.keys(object);for(const k of keys.slice(0,Math.max(0,keys.length-limit)))delete object[k];};
  prune(state.profiles,2000);prune(state.episodes,2000);
  await heartbeat();return structuredClone(state.health);
 }
 function check(){if(!enabled||stopped)return Promise.resolve({status:stopped?'stopped':'disabled'});if(!active)active=run().finally(()=>{active=null;});return active;}
 const timer=enabled&&dependencies.autoStart!==false?setInterval(()=>void check().catch(e=>logger.error?.(`[gmgn-flow] ${e.message}`)),poll):null;
 timer?.unref();if(timer)void check().catch(e=>logger.error?.(`[gmgn-flow] ${e.message}`));
 return {check,state:()=>structuredClone(state),stateFile:file,async stop(){stopped=true;clearInterval(timer);await client?.stop?.();await active;await saving;}};
}
