import {readRecallDocument} from './paper-narrative-recall.js';
import {gmgnFlowAddress} from './gmgn-flow-signal.js';
import {GMGN_SOCIAL_VERSION} from './gmgn-social-monitor.js';
import {MONITOR_ENTRY_VERSION,monitorSignalId,validMonitorSignal} from './paper-monitor-signal.js';
import {kolThemeCandidates} from './paper-kol-theme.js';
import {buildTwitterEventCandidates} from './paper-twitter-event.js';
import {TWITTER_NARRATIVE_TARGETS} from './twitter-narrative-monitor.js';

export const NEWS_WIRE_VERSION='paper_news_research_v1';
const age=(at,now)=>now-Date.parse(at);
const key=t=>`${t.chain}:${t.address}`;
const clean=v=>typeof v==='string'?v.replace(/\s+/g,' ').trim():'';
const fresh=(at,now,ttl=120000)=>Number.isFinite(age(at,now))&&age(at,now)>=0&&age(at,now)<=ttl;

// Research hints retain their old meaning. A separate versioned paper signal
// allows the user-selected event experiment; it never authenticates a GMGN call.
export function buildPaperNewsWire({gmgn,events=[],twitterDocuments=[],anchorDocuments=[],candidates=[],nowMs=Date.now()}={}) {
  const items=[],paperSignals=[],themeCandidates=[],seeds=new Map(),priority=new Map(),documents=new Map(),conflicts=new Set();
  const addSignal=(token,fields)=>{
    const s={version:MONITOR_ENTRY_VERSION,paperOnly:true,...token,...fields};s.id=monitorSignalId(s);
    if(validMonitorSignal(s,token,nowMs))paperSignals.push(s);
  };
  const add=(token,hint)=>{const address=gmgnFlowAddress(token.chain,token.address);if(!address)return;
    const t={...token,address},k=key(t);seeds.set(k,{...seeds.get(k),...t});
    const old=priority.get(k);priority.set(k,{chain:t.chain,address,sourceAt:old&&Date.parse(old.sourceAt)>Date.parse(hint.sourceAt)?old.sourceAt:hint.sourceAt,
      sources:[...new Set([...(old?.sources||[]),hint.source])],researchOnly:true});};
  const independent=twitterDocuments.filter(d=>d?.kind==='independent_x_research'&&d.authenticated===true
    &&d.verifiedBy==='official_x_oembed'&&d.isReply===false&&d.isQuote===false
    &&TWITTER_NARRATIVE_TARGETS.some(t=>t.id===d.authorId&&t.handle.toLowerCase()===d.author?.toLowerCase())
    &&d.url===`https://x.com/${d.author}/status/${String(d.url).split('/').at(-1)}`
    &&/^https:\/\/x\.com\/[a-z\d_]{1,15}\/status\/\d+$/i.test(d.url)
    &&Number.isFinite(d.observedAt)&&d.at<=d.observedAt&&d.observedAt<=nowMs);
  for(const raw of [...(Array.isArray(events)?events:[]),...independent.map(d=>({independentDocument:d}))]){
    const e=raw?.event||raw;let d=independent.includes(raw?.independentDocument)?raw.independentDocument:readRecallDocument(e,nowMs);
    if(!d&&e?.type==='telegram_news_update'&&e.source?.id==='telegram_public_channel'
      &&e.username==='maxguruai'&&/^https:\/\/t\.me\/maxguruai\/\d+$/.test(e.messageUrl||'')) {
      d={id:e.messageUrl,url:e.messageUrl,text:clean(e.news?.headline)+' '+clean(e.news?.summary),
        at:Date.parse(e.sourceOccurredAt),kind:'public_telegram',authenticated:false};
    }
    if(!d||!Number.isFinite(d.at)||d.at>nowMs||nowMs-d.at>(d.authenticated===true?7:1)*86400000||!clean(d.text))continue;
    let id=d.id;const m=id.match(/^https:\/\/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/);if(m)id=`x:${m[1]}`;
    const old=documents.get(id);
    if(old&&(clean(old.text)!==clean(d.text)||old.at!==d.at||old.author!==d.author||old.chain!==d.chain)){conflicts.add(id);continue;}
    documents.set(id,d);
  }
  const twitterEvents=buildTwitterEventCandidates({documents:[...documents].filter(([id])=>!conflicts.has(id)).map(([,d])=>d),anchorDocuments,candidates,nowMs});
  for(const m of twitterEvents.candidates){
    if(m.phase!=='background')add({chain:m.chain,address:m.address,symbol:m.symbol,name:m.name},{sourceAt:m.sourceAt,source:'twitter_event_research'});
  }
  for(const [id,d] of documents){
    if(conflicts.has(id)||nowMs-d.at>86400000)continue;
    const source=d.kind==='public_telegram'?'own_telegram':'own_verified',sourceAt=new Date(d.at).toISOString();
    items.push({id,source,sourceAt,url:d.url,text:clean(d.text).slice(0,600),authenticated:d.authenticated===true,
      fresh:fresh(sourceAt,nowMs),author:d.author||null});
    const matches=kolThemeCandidates(d,candidates,nowMs);themeCandidates.push(...matches);
    for(const m of matches){
      add({chain:m.chain,address:m.address,symbol:m.symbol,name:m.name},{sourceAt,source:'kol_theme_research'});
      if(m.selected)addSignal({chain:m.chain,address:m.address},{source:'kol_theme_hypothesis',sourceId:id,sourceUrl:d.url,
        sourceAt,observedAt:new Date(nowMs).toISOString(),authenticated:true,text:d.text,theme:m});
    }
    if(!fresh(sourceAt,nowMs)||d.authenticated!==true||!d.chain)continue;
    const addresses=d.chain==='sol'?[...new Set(d.text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)||[])]:
      [...new Set((d.text.match(/(?<![\da-fA-F])0x[\da-fA-F]{40}(?![\da-fA-F])/g)||[]).map(a=>a.toLowerCase()))];
    // Unknown / multiple chains and addresses stay in the narrative desk.
    if(addresses.length===1){
      const token={chain:d.chain,address:addresses[0]};add(token,{sourceAt,source});
      // A warning, denial or exit message is not a buy catalyst.
      if(!/\b(?:scam|rugged|honeypot|fake|avoid|not affiliated|do not buy|don't buy|sold|selling|dump|exit)\b|骗局|假冒|诈骗|辟谣|不要买|别买|清仓|卖出|止损|未发行|无关|不是官方/iu.test(d.text))
        addSignal(token,{source,sourceId:id,sourceUrl:d.url,sourceAt,observedAt:new Date(nowMs).toISOString(),authenticated:true,text:clean(d.text).slice(0,4000)});
    }
  }
  for(const m of twitterEvents.candidates)if(m.selected&&!paperSignals.some(s=>s.sourceUrl===m.sourceUrl&&s.chain===m.chain&&s.address===m.address))
    addSignal({chain:m.chain,address:m.address},{source:'twitter_narrative_event',sourceId:m.sourceId,sourceUrl:m.sourceUrl,
      sourceAt:m.sourceAt,observedAt:new Date(nowMs).toISOString(),authenticated:true,text:m.sourceText,narrativeCandidate:m});
  if(gmgn?.version===GMGN_SOCIAL_VERSION)for(const e of Array.isArray(gmgn.events)?gmgn.events:[]){
    if(!e||e.conflict||!['sol','bsc'].includes(e.chain)||gmgnFlowAddress(e.chain,e.address)!==e.address
      ||e.discoveryOnly!==true||!fresh(e.sourceAt,nowMs,86400000))continue;
    const healthy=gmgn.chains?.[e.chain]?.status==='healthy'&&fresh(gmgn.chains[e.chain].lastSuccessAt,nowMs,30000);
    const active=healthy&&fresh(e.sourceAt,nowMs)&&fresh(e.firstObservedAt,nowMs);
    items.push({id:e.id,source:'gmgn_platform_call',sourceAt:e.sourceAt,firstObservedAt:e.firstObservedAt,
      arrivalLagMs:Math.max(0,Date.parse(e.firstObservedAt)-Date.parse(e.sourceAt)),chain:e.chain,address:e.address,
      symbol:e.symbol,contacts:Array.isArray(e.contacts)?e.contacts:[],text:'GMGN 检测到平台喊单；未取得完整推文，角度待原文核实',authenticated:false,fresh:active,
      url:`https://gmgn.ai/${e.chain}/token/${e.address}`});
    if(active){
      const token={chain:e.chain,address:e.address,symbol:e.symbol,name:e.name};
      add(token,{sourceAt:e.sourceAt,source:'gmgn_platform_call'});
      addSignal(token,{source:'gmgn_platform_call',sourceId:e.id,sourceUrl:`https://gmgn.ai/${e.chain}/token/${e.address}`,
        sourceAt:e.sourceAt,firstObservedAt:e.firstObservedAt,observedAt:gmgn.chains[e.chain].lastSuccessAt,authenticated:false,text:null});
    }
  }
  const hints=[...priority.values()];
  const known=new Set(candidates.map(c=>key(c.token||c)));
  const ordered=items.sort((a,b)=>Date.parse(b.sourceAt)-Date.parse(a.sourceAt));
  const own=ordered.filter(i=>i.source!=='gmgn_platform_call'),platform=ordered.filter(i=>i.source==='gmgn_platform_call');
  const usableSignals=paperSignals.filter(s=>!twitterEvents.reports.some(r=>r.negative&&Date.parse(r.sourceAt)>=Date.parse(s.sourceAt)
    &&(r.candidates.some(c=>c.chain===s.chain&&c.address===s.address)
      ||r.author?.toLowerCase()===(s.narrativeCandidate?.author||s.theme?.author||documents.get(s.sourceId)?.author)?.toLowerCase())));
  return {version:NEWS_WIRE_VERSION,updatedAt:new Date(nowMs).toISOString(),
    gmgnStatus:gmgn?.version===GMGN_SOCIAL_VERSION?'platform_calls_only':'unavailable',gmgnChains:gmgn?.chains||{},
    fullTwitterConnected:false,waitForBothSources:false,ttlMs:120000,
    researchOnly:true,conflictingDocuments:conflicts.size,
    ownDocumentCount:own.length,gmgnSignalCount:platform.length,
    freshHints:hints.length,matchedExisting:hints.filter(h=>known.has(key(h))).length,
    dualSourceHints:hints.filter(h=>h.sources.length>1).length,
    latest:[...own.slice(0,6),...platform.slice(0,6)].sort((a,b)=>Date.parse(b.sourceAt)-Date.parse(a.sourceAt)),
    paperSignalCount:usableSignals.length,paperSignals:usableSignals.sort((a,b)=>Date.parse(b.sourceAt)-Date.parse(a.sourceAt)),
    researchDocuments:[...documents].filter(([id,d])=>!conflicts.has(id)&&d.authenticated===true).map(([,d])=>d).slice(-200),
    themeCandidates:themeCandidates.slice(0,24),twitterEvents,
    hints,seeds:[...seeds.values()].slice(0,20)};
}
