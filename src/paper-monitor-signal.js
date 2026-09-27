import {gmgnFlowAddress} from './gmgn-flow-signal.js';
import {KOL_THEME_VERSION,KOL_THEME_TTL_MS} from './paper-kol-theme.js';
import {TWITTER_EVENT_TTL_MS,validTwitterEventCandidate} from './paper-twitter-event.js';

export const MONITOR_ENTRY_VERSION='monitored_event_entry_v1';
export const MONITOR_SIGNAL_TTL_MS=120000;
const recent=(at,now,ttl)=>Number.isFinite(Date.parse(at))&&Date.parse(at)<=now&&now-Date.parse(at)<=ttl;
export const monitorSignalId=s=>`${MONITOR_ENTRY_VERSION}:${s.source}:${s.sourceId}:${s.chain}:${s.address}`;

// This is explicit paper-experiment admission, NOT narrative authentication,
// contract safety, a live-trade permission or proof that a sell can execute.
export function validMonitorSignal(s,token,nowMs) {
  if(!s||s.version!==MONITOR_ENTRY_VERSION||s.paperOnly!==true||s.chain!==token?.chain||s.address!==token?.address
    ||!gmgnFlowAddress(s.chain,s.address)||gmgnFlowAddress(s.chain,s.address)!==s.address
    ||typeof s.sourceId!=='string'||!s.sourceId||s.sourceId.length>500||s.id!==monitorSignalId(s)
    ||!recent(s.sourceAt,nowMs,s.source==='twitter_narrative_event'?TWITTER_EVENT_TTL_MS:s.source==='kol_theme_hypothesis'?KOL_THEME_TTL_MS:MONITOR_SIGNAL_TTL_MS)||!recent(s.observedAt,nowMs,30000)
    ||Date.parse(s.sourceAt)>Date.parse(s.observedAt))return false;
  if(s.source==='gmgn_platform_call')return ['sol','bsc'].includes(s.chain)&&s.authenticated===false
    &&s.sourceId.startsWith(`gmgn-call:${s.chain}:`)
    &&s.sourceUrl===`https://gmgn.ai/${s.chain}/token/${s.address}`
    &&recent(s.firstObservedAt,nowMs,MONITOR_SIGNAL_TTL_MS)
    &&Date.parse(s.sourceAt)<=Date.parse(s.firstObservedAt)&&Date.parse(s.firstObservedAt)<=Date.parse(s.observedAt);
  if(!['own_verified','kol_theme_hypothesis','twitter_narrative_event'].includes(s.source)||s.authenticated!==true||typeof s.text!=='string'||!s.text.trim())return false;
  if(s.source==='twitter_narrative_event'&&!validTwitterEventCandidate(s.narrativeCandidate,s,nowMs))return false;
  if(s.source==='kol_theme_hypothesis'){
    const m=s.theme;
    if(m?.version!==KOL_THEME_VERSION||m.chain!==s.chain||m.address!==s.address||m.sourceUrl!==s.sourceUrl||m.sourceAt!==s.sourceAt
      ||m.binding!=='provider_project_permalink_and_theme'||m.authorEndorsement!==false||m.selected!==true
      ||!Array.isArray(m.matchedTerms)||!m.matchedTerms.length||!recent(m.marketObservedAt,nowMs,120000))return false;
  }
  try { const u=new URL(s.sourceUrl);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port; }catch{return false;}
}

export function confirmMonitorQuote(history,token,signal,nowMs) {
  const follow=signal.source==='twitter_narrative_event'||signal.source==='kol_theme_hypothesis'&&nowMs-Date.parse(signal.sourceAt)>120000;
  const byTime=new Map();
  for(const q of history||[]){
    const at=Date.parse(q?.observedAt);
    if(q?.status!=='ok'||q.chain!==token.chain||q.address!==token.address||!Number.isFinite(q.price)||q.price<=0
      ||!Number.isFinite(at)||at>nowMs||nowMs-at>(follow?15000:5000)||at<Date.parse(signal.sourceAt))continue;
    if(byTime.has(at)&&byTime.get(at).price!==q.price)return {ready:false,reason:'同时间报价存在冲突'};
    byTime.set(at,{price:q.price,observedAt:q.observedAt});
  }
  const rows=[...byTime].sort((a,b)=>a[0]-b[0]).map(([,q])=>q),last=rows.at(-1);
  const pathReady=!follow||rows.length>=2&&Date.parse(last?.observedAt)-Date.parse(rows[0].observedAt)>=3000;
  const quoted=!!last&&last.price===token.price&&nowMs-Date.parse(last.observedAt)<=5000&&pathReady;
  const ready=quoted&&(!follow||last.price>rows[0].price&&last.price>=rows.at(-2).price);
  return {version:follow?'theme_follow_quotes_v1':'monitor_single_quote_v1',ready,reason:ready?null:quoted?'上新后报价尚未重新走强':'连续新鲜报价确认',count:rows.length,
    confirmedAt:ready?last.observedAt:null,rows};
}
