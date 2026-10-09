// Scheduling/data preparation only. None of these helpers grants entry permission.
import { gmgnFlowAddress } from './gmgn-flow-signal.js';

export const HOT_RESEARCH_VERSION = 'bounded_market_leader_v1';
export const HOT_WATCH_MS = 120000;
const stamp = v => typeof v === 'number' ? (v < 1e10 ? v * 1000 : v) : Date.parse(v || '');
const key = t => `${t.chain}:${t.address}`;

// A short observation lease is not a signal, and never renews market evidence.
export function hotWatchEligible(row, nowMs) {
  const i=row?.input,t=i?.token,at=stamp(i?.observedAt);
  return i?.memeExitMode===true && t?.marketStage==='external' && !t.stageConflict
    && !!gmgnFlowAddress(t.chain,t.address) && i.marketStatus==='ok'
    && Number.isFinite(at) && at<=nowMs && nowMs-at<=120000
    && !row.decisions?.some(d=>d.decision==='不买'||d.evidence?.safety?.blocked?.length);
}

export function advanceHotWatch(previous, rows, nowMs) {
  const next=new Map(), counts=new Map();
  for(const row of rows) {
    const t=row.input.token;
    if(!hotWatchEligible(row,nowMs)||(counts.get(t.chain)||0)>=2)continue;
    const since=previous.get(key(t));
    next.set(key(t),Number.isFinite(since)&&since<=nowMs&&nowMs-since<HOT_WATCH_MS?since:nowMs);
    counts.set(t.chain,(counts.get(t.chain)||0)+1);
  }
  return next;
}

export function marketLeaderHint(row, nowMs) {
  const i=row?.input, t=i?.token, at=stamp(i?.observedAt);
  if(i?.memeExitMode!==true || t?.chain!=='bsc' || !gmgnFlowAddress(t.chain,t.address)
    || i.marketStatus!=='ok' || !Number.isFinite(at) || at>nowMs || nowMs-at>120000
    || t.marketStage!=='external' || t.stageConflict || !(t.liquidity>=20000)
    || row.decisions?.some(d=>d.decision==='不买'||d.evidence?.safety?.blocked?.length))return null;
  // Keep minute/hour ranking evidence separate: a newer minute snapshot must
  // not erase a still-fresh hourly leader or renew the hourly observation.
  const observations=Array.isArray(i.marketRankObservations)?i.marketRankObservations:
    [{...t,observedAt:i.observedAt,marketStatus:i.marketStatus}];
  const lead=observations.filter(o=>{
    const seen=stamp(o.observedAt),minimum=o.volumeWindow==='1m'?10000:o.volumeWindow==='5m'?50000:o.volumeWindow==='1h'?250000:Infinity;
    return o.chain===t.chain&&gmgnFlowAddress(o.chain,o.address)===gmgnFlowAddress(t.chain,t.address)
      && o.marketStatus==='ok'&&Number.isFinite(seen)&&seen<=nowMs&&nowMs-seen<=120000
      && Number.isFinite(o.volume)&&o.volume>=minimum&&Number.isInteger(o.rank)&&o.rank>=1&&o.rank<=5;
  }).sort((a,b)=>a.rank-b.rank||stamp(b.observedAt)-stamp(a.observedAt))[0];
  if(!lead)return null;
  return {version:HOT_RESEARCH_VERSION,researchOnly:true,chain:t.chain,address:t.address,
    rank:lead.rank,volume:lead.volume,window:lead.volumeWindow,observedAt:lead.observedAt,
    reason:'当前成交额榜前五：保留一个持续研究席位；热度不是买入许可'};
}

export function compareMarketLeaders(a,b,nowMs) {
  const x=marketLeaderHint(a,nowMs),y=marketLeaderHint(b,nowMs);
  return Number(!!y)-Number(!!x) || (x&&y ? x.rank-y.rank || y.volume/x.volume-1 : 0)
    || key(a.input.token).localeCompare(key(b.input.token));
}

export function hotQuoteResearchReady(row,nowMs) {
  if(!marketLeaderHint(row,nowMs) || row.input.opportunityAccount?.positions?.[key(row.input.token)])return false;
  return row.decisions.some(d=>{
    const e=d.evidence||{}, repair=e.lossRepair;
    return e.marketFresh===true && e.chart?.ready===true && e.safety?.missing?.length===0
      && e.safety?.blocked?.length===0 && e.costAssumptions?.accountingEligible===true
      && repair?.entryPath==='external_structure' && repair.entryPathAllowed===true && repair.reentry?.ready===true;
  });
}

// A maximum 15-second normal-priority probe, followed by 45 seconds without
// another probe. Ordinary eligible entries always get the seat first.
export function selectHotQuoteResearch(rows,current,nowMs,{laneAvailable=true}={}) {
  const served=current?.served || (current?.key?{[current.key]:current.since}:{});
  const usable=rows.filter(r=>hotQuoteResearchReady(r,nowMs)).sort((a,b)=>
    (served[key(a.input.token)]||0)-(served[key(b.input.token)]||0)||compareMarketLeaders(a,b,nowMs));
  if(current && nowMs<current.nextAllowedAt) {
    const row=nowMs>=current.since && nowMs<current.until ? usable.find(r=>key(r.input.token)===current.key) : null;
    return {row:row||null,lease:current};
  }
  // Do not spend a new candidate's entire probe window waiting for another
  // CA's in-flight request. Start its clock only when this lane is available.
  if(!laneAvailable)return {row:null,lease:current};
  const row=usable[0];
  // Keep bounded rotation memory: a continuously qualified rank-one token
  // must not monopolize every probe while other leaders wait for quotes.
  return row?{row,lease:{key:key(row.input.token),since:nowMs,until:nowMs+15000,nextAllowedAt:nowMs+60000,
    served:Object.fromEntries(Object.entries({...served,[key(row.input.token)]:nowMs}).sort((a,b)=>b[1]-a[1]).slice(0,20))}}
    :{row:null,lease:current};
}

// Some graduated launchpad feeds report the same creation/open timestamp,
// while their exact-CA candles include the earlier bonding curve. Do not
// guess a new birth time or approve that disputed prefix. Analyze only bars
// from the reported opening-minute boundary onward, preserving diagnostics.
export function externalEntryCandles(token,candles) {
  const created=stamp(token?.creationTimestamp),opened=stamp(token?.openTimestamp);
  if(token?.chain!=='bsc' || token.marketStage!=='external' || token.stageConflict || !Number.isFinite(created) || created!==opened
    || !/^(flap|flap_stocks|flap_aioracle|fourmeme|fourmeme_agent|bn_fourmeme|four_xmode_agent)$/.test(token.launchpadPlatform||token.launchpad||'')
    || !Array.isArray(candles))return {candles,selection:null};
  const boundary=Math.floor(opened/60000)*60000;
  // Preserve malformed rows so the existing validation still rejects them.
  const selected=candles.filter(c=>!Number.isFinite(stamp(c?.time))||stamp(c.time)>=boundary);
  return {candles:selected,selection:{version:'post_reported_open_window_v1',reportedCreationAt:new Date(created).toISOString(),
    reportedOpenAt:new Date(opened).toISOString(),usedFrom:new Date(boundary).toISOString(),
    excludedPrefixBars:candles.length-selected.length,
    note:'创建与开盘时间相同：仅使用该开盘分钟及以后原始 K 线；未证明真实创建时间，不补线、不改时间戳'}};
}
