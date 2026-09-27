import { createHash } from 'node:crypto';
import { gmgnFlowAddress } from './gmgn-flow-signal.js';
import { narrativeTerms, narrativeOverlap, validNarrativeMemory } from './paper-narrative-recall.js';
import { narrativeLearningPermalink as permalink } from './paper-narrative-learning-source.js';
import { classifyNarrativeCase, narrativeStageReport, NARRATIVE_THESIS_VERSION } from './paper-narrative-thesis.js';

export const NARRATIVE_LEARNING_VERSION = 'surge_narrative_learning_v1';
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export const NARRATIVE_LEARNING_POLICY = Object.freeze({
  minMarketCap: 1000000, minVolumeUsd: 10000, minVolumeMultiple: 3, minLiquidity: 20000,
  volumeWindow: '1m', baselineWindowMs: 15 * MINUTE, baselineMinSamples: 3,
  baselineMinSpanMs: 2 * MINUTE, maxBaselineGapMs: 3 * MINUTE, episodeCooldownMs: 30 * MINUTE,
  retentionDays: 30, maxEpisodes: 2000, maxPendingEpisodes: 500, maxResolvedEpisodes: 1500, maxTrackedTokens: 600,
});
export const NARRATIVE_LEARNING_HORIZONS = Object.freeze([
  { id: '5m', delayMs: 5 * MINUTE, toleranceMs: 2 * MINUTE },
  { id: '1h', delayMs: HOUR, toleranceMs: 5 * MINUTE },
  { id: '24h', delayMs: DAY, toleranceMs: 15 * MINUTE },
]);
const stamp = v => typeof v === 'number' ? v : Date.parse(v || '');
const finite = Number.isFinite;
const positive = v => finite(v) && v > 0;
const keyOf = t => `${t.chain}:${gmgnFlowAddress(t.chain, t.address)}`;
const hash = s => createHash('sha256').update(s).digest('hex');
const median = rows => { const s = rows.toSorted((a,b)=>a-b), n=s.length; return n ? n%2 ? s[(n-1)/2] : (s[n/2-1]+s[n/2])/2 : null; };
const fresh = (at, now) => finite(at) && at<=now && now-at<=2*MINUTE;
const clean = s => typeof s==='string' ? s.replace(/\s+/gu,' ').trim().slice(0,700) : '';

export function emptyNarrativeLearning(nowMs) {
  return { version: NARRATIVE_LEARNING_VERSION, startedAt: nowMs, series: {}, episodes: [],
    capacitySkippedEpisodes: 0, evictedResolvedEpisodes: 0 };
}
export function validNarrativeLearning(s) {
  return !!s && s.version===NARRATIVE_LEARNING_VERSION && finite(s.startedAt)
    && ['capacitySkippedEpisodes','evictedResolvedEpisodes'].every(k=>s[k]===undefined||Number.isSafeInteger(s[k])&&s[k]>=0)
    && s.series && typeof s.series==='object' && !Array.isArray(s.series) && Object.keys(s.series).length<=600
    && Object.entries(s.series).every(([key,v])=>v && key===keyOf(v) && gmgnFlowAddress(v.chain,v.address)
      && finite(v.lastAt) && typeof v.armed==='boolean' && (v.lastEpisodeAt===null||finite(v.lastEpisodeAt))
      && Array.isArray(v.points) && v.points.length<=20 && v.points.every(p=>finite(p.at)&&finite(p.volume)&&p.volume>=0))
    && Array.isArray(s.episodes) && s.episodes.length<=NARRATIVE_LEARNING_POLICY.maxEpisodes
    && s.episodes.filter(e=>!e?.outcomes?.['24h']).length<=NARRATIVE_LEARNING_POLICY.maxPendingEpisodes
    && s.episodes.every(e=>e && typeof e.id==='string'
      && gmgnFlowAddress(e.chain,e.address) && finite(e.at) && positive(e.price) && positive(e.marketCap)
      && finite(e.lastAt) && positive(e.peakPrice) && positive(e.troughPrice) && finite(e.maxObservedDrawdown)
      && Array.isArray(e.narratives) && e.narratives.length<=3 && e.narratives.every(n=>typeof n.text==='string'&&n.text.length<=700
        && typeof n.url==='string' && finite(n.at) && finite(n.associatedAt) && ['verified_ca','provider_permalink'].includes(n.binding)
        && Array.isArray(n.terms) && n.terms.length<=64 && n.terms.every(t=>typeof t==='string'))
      && Array.isArray(e.links) && e.links.length<=5 && e.links.every(x=>typeof x==='string')
      && e.sourceLookups && typeof e.sourceLookups==='object' && !Array.isArray(e.sourceLookups)
      && Object.entries(e.sourceLookups).length<=5 && Object.entries(e.sourceLookups).every(([url,l])=>e.links.includes(url)
        && l && finite(l.at) && Number.isInteger(l.attempts) && l.attempts>=1 && l.attempts<=3 && ['ok','unavailable'].includes(l.status))
      && (e.projectClaim===null || typeof e.projectClaim==='string'&&e.projectClaim.length<=700)
      && e.outcomes && typeof e.outcomes==='object' && !Array.isArray(e.outcomes)
      && (e.researchProfile===undefined||e.researchProfile===null||e.researchProfile.version===NARRATIVE_THESIS_VERSION
        &&finite(e.researchProfile.recordedAt)&&e.researchProfile.recordedAt>=e.at
        &&['known_at_observation','retrospective_association'].includes(e.researchProfile.knowledge)
        &&typeof e.researchProfile.sourceKey==='string'&&typeof e.researchProfile.kind==='string')
      && Object.entries(e.outcomes).every(([id,o])=>NARRATIVE_LEARNING_HORIZONS.some(h=>h.id===id) && o
        && ['observed','missing'].includes(o.status) && (o.status==='missing'||positive(o.price)&&finite(o.at)&&finite(o.returnRate))));
}

function tokenLinks(token) {
  return [...new Set([token.twitterUsername,token.website,token.raw?.twitter_username,token.raw?.twitter,
    token.raw?.link?.twitter,token.raw?.link?.website].map(permalink).filter(Boolean))].slice(0,5);
}
function attachLinkedSources(episode, observations, nowMs) {
  for(const result of observations) {
    const url=permalink(result?.url),observed=stamp(result?.observedAt),old=episode.sourceLookups[url];
    if(!url||!episode.links.includes(url)||!fresh(observed,nowMs)||observed<episode.at||old?.at>=observed
      || (old?.attempts||0)>=3 || !['ok','unavailable'].includes(result.status))continue;
    const usable=result.status==='ok'&&result.sourceVerifiedBy==='official_x_oembed'&&finite(result.at)
      &&result.at<=episode.at&&episode.at-result.at<=7*DAY&&clean(result.text);
    episode.sourceLookups[url]={at:observed,attempts:(old?.attempts||0)+1,status:usable?'ok':'unavailable'};
    if(usable&&!episode.narratives.some(n=>permalink(n.url)===url)&&episode.narratives.length<3)
      episode.narratives.push({url,at:result.at,text:clean(result.text),author:clean(result.author),terms:narrativeTerms(result.text),
        binding:'provider_permalink',associatedAt:observed,meaning:'官方 oEmbed 原文，GMGN 项目链接关联；作者 CA / 回复引用身份未确认，仅学习'});
  }
}
function narrativeIndex(memory) {
  if(!memory)return null;
  const conflicts=new Set(memory.conflicts),byAsset=new Map(),byLink=new Map(),byUrl=new Map();
  for(const d of memory.documents.toSorted((a,b)=>b.at-a.at)) {
    if(conflicts.has(d.id)||d.negative||d.authenticated!==true)continue;
    if(d.assetKey){if(!byAsset.has(d.assetKey))byAsset.set(d.assetKey,[]);byAsset.get(d.assetKey).push(d);}
    const link=permalink(d.url);if(link){if(!byLink.has(link))byLink.set(link,[]);byLink.get(link).push(d);}
    byUrl.set(d.url,d);
  }
  return {conflicts,byAsset,byLink,byUrl};
}
function attachNarratives(episode, index, nowMs) {
  if(!index)return;
  const key=keyOf(episode);
  episode.narratives=episode.narratives.filter(n=>!index.conflicts.has(n.url));
  for(const n of episode.narratives) {
    const d=index.byUrl.get(n.url);
    if(n.binding!=='verified_ca'&&d?.assetKey===key&&clean(d.text)===n.text&&d.at<=episode.at&&episode.at-d.at<=7*DAY) {
      n.binding='verified_ca';n.verifiedAt=nowMs;n.meaning='历史文案明确绑定链和 CA；绑定确认时间单独记录';
    }
  }
  const existing=new Set(episode.narratives.map(n=>n.url));
  // Index once per cycle, rather than scanning every document for every case.
  // Late discovery of an OLD post may enrich research, never manufacture a catalyst.
  for(const docs of [index.byAsset.get(key)||[],...episode.links.map(url=>index.byLink.get(url)||[])]) {
    for(const d of docs) {
      if(episode.narratives.length>=3)return;
      if(d.at>episode.at)continue;
      if(episode.at-d.at>7*DAY)break;
      if(existing.has(d.url))continue;
      const binding=d.assetKey===key?'verified_ca':'provider_permalink';
      episode.narratives.push({url:d.url,at:d.at,text:clean(d.text),author:clean(d.author),terms:d.terms,
        binding,associatedAt:nowMs,meaning:binding==='verified_ca'?'历史文案明确绑定链和 CA':'GMGN 项目链接关联，未经作者 CA 确认；仅学习'});
      existing.add(d.url);
    }
  }
}
function markEpisode(e, mark) {
  if(mark.at<=e.lastAt || mark.at>e.at+DAY+15*MINUTE || !finite(mark.price/e.price))return;
  e.lastAt=mark.at; e.lastPrice=mark.price;
  e.peakPrice=Math.max(e.peakPrice,mark.price); e.troughPrice=Math.min(e.troughPrice,mark.price);
  e.maxObservedDrawdown=Math.max(e.maxObservedDrawdown,1-mark.price/e.peakPrice);
  for(const h of NARRATIVE_LEARNING_HORIZONS) {
    const due=e.at+h.delayMs;
    if(!e.outcomes[h.id] && mark.at>=due && mark.at<=due+h.toleranceMs)
      e.outcomes[h.id]={status:'observed',at:mark.at,price:mark.price,returnRate:mark.price/e.price-1};
  }
}

/** Read-only observational learning. No account mutation or trade-eligibility output. */
export function advanceNarrativeLearning(prior,{snapshots=[],marks=[],sourceObservations=[],narrativeMemory=null,nowMs=Date.now()}={}) {
  if(prior && !validNarrativeLearning(prior))throw new Error('起量学习记忆异常，未重建或修改账户');
  const s=structuredClone(prior || emptyNarrativeLearning(nowMs)), p=NARRATIVE_LEARNING_POLICY;
  const memory=validNarrativeMemory(narrativeMemory)?narrativeMemory:null;
  const index=narrativeIndex(memory);
  s.episodes=s.episodes.filter(e=>e.at<=nowMs&&nowMs-e.at<=p.retentionDays*DAY);
  // Older v1 state loads without rewriting or resetting its samples. Reserve
  // pending slots until the last observation window expires, not until the next surge.
  s.capacitySkippedEpisodes ??= 0; s.evictedResolvedEpisodes ??= 0;
  let pendingCount=s.episodes.filter(e=>!e.outcomes['24h']&&nowMs<=e.at+DAY+15*MINUTE).length;
  const seen=new Set(), accepted=[];
  let observedTokens=0, highCapTokens=0, baselineReadyTokens=0, rejectedSnapshots=0;
  for(const snapshot of snapshots) {
    const at=stamp(snapshot?.observedAt);
    // Never compare 1h/24h/trenches volume against a one-minute rank baseline.
    if(snapshot?.status!=='ok'||snapshot.source!=='gmgn-cli'||snapshot.interval!=='1m'||!fresh(at,nowMs)) {rejectedSnapshots++;continue;}
    for(const token of (snapshot.tokens||[]).slice(0,60)) {
      if(token.chain!==snapshot.chain||!gmgnFlowAddress(token.chain,token.address)||!finite(token.volume)||token.volume<0||!positive(token.price))continue;
      const key=keyOf(token); if(seen.has(key))continue; seen.add(key); observedTokens++;
      if(positive(token.marketCap)&&token.marketCap>=p.minMarketCap)highCapTokens++;
      accepted.push({chain:token.chain,address:token.address,at,price:token.price});
      let track=s.series[key];
      if(!track)track=s.series[key]={chain:token.chain,address:gmgnFlowAddress(token.chain,token.address),lastAt:at,armed:true,lastEpisodeAt:null,points:[]};
      const baseline=track.points.filter(v=>v.at<at&&at-v.at<=p.baselineWindowMs);
      const ready=baseline.length>=p.baselineMinSamples && baseline.at(-1).at-baseline[0].at>=p.baselineMinSpanMs
        && at-baseline.at(-1).at<=p.maxBaselineGapMs;
      if(ready)baselineReadyTokens++;
      if(track.points.some(v=>Math.floor(v.at/MINUTE)===Math.floor(at/MINUTE)) || at<track.lastAt)continue;
      const base=ready?median(baseline.map(v=>v.volume)):null;
      const multiple=positive(base)&&finite(token.volume/base)?token.volume/base:null;
      if(multiple!==null&&multiple<1.5)track.armed=true;
      const qualifies=multiple!==null&&multiple>=p.minVolumeMultiple&&token.volume>=p.minVolumeUsd
        && positive(token.marketCap)&&token.marketCap>=p.minMarketCap&&positive(token.liquidity)&&token.liquidity>=p.minLiquidity;
      if(qualifies&&track.armed&&(track.lastEpisodeAt===null||at-track.lastEpisodeAt>=p.episodeCooldownMs)) {
        if(pendingCount>=p.maxPendingEpisodes) {
          s.capacitySkippedEpisodes++;
        } else {
          const e={id:hash(`${key}:${Math.floor(at/MINUTE)}`),chain:token.chain,address:gmgnFlowAddress(token.chain,token.address),symbol:clean(token.symbol),
            at,price:token.price,marketCap:token.marketCap,liquidity:token.liquidity,volumeUsd:token.volume,
            volumeWindow:'1m',baselineVolumeUsd:base,volumeMultiple:multiple,baselineSamples:baseline.length,
            baselineStartAt:baseline[0].at,baselineEndAt:baseline.at(-1).at,links:tokenLinks(token),sourceLookups:{},
            projectClaim:clean(token.raw?.link?.description)||null,narratives:[],
            lastAt:at,lastPrice:token.price,peakPrice:token.price,troughPrice:token.price,maxObservedDrawdown:0,outcomes:{},
            marketFlags:{isWashTrading:token.isWashTrading===true,isHoneypot:token.isHoneypot===true},
            learningOnly:true};
          attachNarratives(e,index,nowMs);s.episodes.push(e);pendingCount++;
        }
        // Consume skipped waves too: do not count every poll as another omission
        // or admit the same wave later at a misleadingly newer starting price.
        track.lastEpisodeAt=at;track.armed=false;
      }
      track.lastAt=at;track.points=[...baseline,{at,volume:token.volume}].slice(-20);
    }
  }
  for(const mark of marks) {
    const at=stamp(mark?.observedAt);
    if(mark?.status==='ok'&&gmgnFlowAddress(mark.chain,mark.address)&&positive(mark.price)&&fresh(at,nowMs))accepted.push({...mark,at});
  }
  accepted.sort((a,b)=>a.at-b.at);
  const marksByAsset=new Map();
  for(const mark of accepted){const key=keyOf(mark);if(!marksByAsset.has(key))marksByAsset.set(key,[]);marksByAsset.get(key).push(mark);}
  for(const e of s.episodes) {
    for(const mark of marksByAsset.get(keyOf(e))||[])markEpisode(e,mark);
    attachNarratives(e,index,nowMs);
    attachLinkedSources(e,sourceObservations,nowMs);
    // Freeze when the relationship becomes known; never pretend enrichment was
    // available at the historical price, or rewrite a previously recorded buy.
    if(!e.researchProfile&&e.narratives.length)e.researchProfile=classifyNarrativeCase(e,nowMs);
    for(const h of NARRATIVE_LEARNING_HORIZONS)if(!e.outcomes[h.id]&&nowMs>e.at+h.delayMs+h.toleranceMs)
      e.outcomes[h.id]={status:'missing',reason:'观察窗口内缺少新鲜价格；不补写零收益或历史价格'};
  }
  const pending=s.episodes.filter(e=>!e.outcomes['24h']);
  const resolved=s.episodes.filter(e=>e.outcomes['24h']).sort((a,b)=>a.at-b.at);
  s.evictedResolvedEpisodes+=Math.max(0,resolved.length-p.maxResolvedEpisodes);
  s.episodes=[...pending,...resolved.slice(-p.maxResolvedEpisodes)].sort((a,b)=>a.at-b.at);
  s.series=Object.fromEntries(Object.entries(s.series).filter(([,v])=>nowMs-v.lastAt<=7*DAY)
    .sort((a,b)=>b[1].lastAt-a[1].lastAt).slice(0,p.maxTrackedTokens));
  const followupTargets=s.episodes.flatMap(e=>NARRATIVE_LEARNING_HORIZONS.filter(h=>!e.outcomes[h.id]
    &&nowMs>=e.at+h.delayMs&&nowMs<=e.at+h.delayMs+h.toleranceMs)
    .map(h=>({chain:e.chain,address:e.address,symbol:e.symbol,dueAt:e.at+h.delayMs,deadline:e.at+h.delayMs+h.toleranceMs,horizon:h.id})))
    .sort((a,b)=>a.deadline-b.deadline).slice(0,20);
  const sourceTargets=[...new Set(s.episodes.filter(e=>nowMs-e.at<=DAY).flatMap(e=>e.links.filter(url=>{
    const lookup=e.sourceLookups[url];
    return !e.narratives.some(n=>permalink(n.url)===url) && (!lookup||lookup.status!=='ok'&&lookup.attempts<3
      &&nowMs-lookup.at>=(lookup.attempts===1?5*MINUTE:30*MINUTE));
  })))].slice(0,20);
  return {memory:s,followupTargets,sourceTargets,report:narrativeLearningReport(s,{observedTokens,highCapTokens,baselineReadyTokens,rejectedSnapshots,nowMs})};
}

export function narrativeLearningReport(s,coverage={}) {
  const episodes=s.episodes, themes=[];
  for(const e of episodes) {
    const doc=e.narratives.find(n=>n.binding==='verified_ca') || e.narratives[0];
    // Provider-linked themes stay in a separate, explicitly unverified cohort.
    if(!doc||doc.terms.length<3)continue;
    let group=themes.find(g=>g.binding===doc.binding&&narrativeOverlap(g.terms,doc.terms).high);
    if(!group){group={terms:doc.terms,binding:doc.binding,samples:[]};themes.push(group);}group.samples.push(e);
  }
  const themeReports=themes.map(g=>{
    const complete=g.samples.filter(e=>e.outcomes['24h']?.status==='observed');
    const uniqueTokens=new Set(complete.map(keyOf)).size,days=new Set(complete.map(e=>Math.floor(e.at/DAY))).size;
    const wins=complete.filter(e=>e.outcomes['24h'].returnRate>0).length,losses=complete.filter(e=>e.outcomes['24h'].returnRate<0).length;
    return {terms:g.terms.slice(0,10),binding:g.binding,sampleCount:g.samples.length,completed:complete.length,uniqueTokens,observationDays:days,
      positive: wins,negative:losses,flat:complete.length-wins-losses,
      medianReturn24h:median(complete.map(e=>e.outcomes['24h'].returnRate)),
      observedPumpThenFade:complete.filter(e=>e.peakPrice/e.price>=1.2&&e.outcomes['24h'].returnRate<=0).length,
      status:g.binding!=='verified_ca'?'仅链接关联，CA 叙事未核实，不作买入依据':complete.length>=10&&uniqueTokens>=5&&days>=3?'可供后续样本外研究，未证明因果或盈利':'样本不足，继续收集',
      autoTradingChanges:false};
  }).sort((a,b)=>b.sampleCount-a.sampleCount).slice(0,10);
  return {version:NARRATIVE_LEARNING_VERSION,enabled:true,mode:'observation_only',policy:NARRATIVE_LEARNING_POLICY,
    startedAt:s.startedAt,trackedTokens:Object.keys(s.series).length,...coverage,
    sampleCount:episodes.length,verifiedNarrativeSamples:episodes.filter(e=>e.narratives.some(n=>n.binding==='verified_ca')).length,
    linkedNarrativeSamples:episodes.filter(e=>e.narratives.some(n=>n.binding==='provider_permalink')).length,
    narrativePending:episodes.filter(e=>!e.narratives.some(n=>n.binding==='verified_ca')).length,
    completed24h:episodes.filter(e=>e.outcomes['24h']?.status==='observed').length,
    missed24h:episodes.filter(e=>e.outcomes['24h']?.status==='missing').length,
    retention:{version:'maturity_first_v1',pending24h:episodes.filter(e=>!e.outcomes['24h']).length,
      resolved24h:episodes.filter(e=>e.outcomes['24h']).length,
      pendingLimit:NARRATIVE_LEARNING_POLICY.maxPendingEpisodes,resolvedLimit:NARRATIVE_LEARNING_POLICY.maxResolvedEpisodes,
      capacitySkippedEpisodes:s.capacitySkippedEpisodes||0,evictedResolvedEpisodes:s.evictedResolvedEpisodes||0,
      note:'未满 24 小时观察窗口的案例不被新起量挤掉；满额时跳过新波次并计数。已结案按时间保留，非按盈亏筛选；统计只代表留存样本，不是全市场。'},
    themes:themeReports,stageResearch:narrativeStageReport(episodes,coverage.nowMs??Date.now()),recentSamples:episodes.slice(-5).reverse(),autoTradingChanges:false,
    note:'只学习已覆盖行情；起量后收益为观察价格变化，未计成本、非回测收益。缺失不当失败，成功与失败都保留；高市值不等于值得买。'};
}
