import { CONFIRMED_PAPER_POLICY } from './paper-confirmed-policy.js';
import { walletBuyResearchHint } from './paper-wallet-priority.js';
import { compareConfirmedCandidates } from './paper-trader-reasoning.js';
import { marketLeaderHint, compareMarketLeaders, hotWatchEligible, HOT_WATCH_MS } from './paper-hot-research.js';
const key=t=>`${t.chain}:${t.address}`;
const stamp=v=>typeof v==='number'?(v<1e10?v*1000:v):Date.parse(v||'');
export const RESEARCH_SCHEDULER_VERSION='research_evidence_shortlist_v24';

// Actual catalysts and independently admitted external patterns can receive
// the main seat. Legacy/control price-only rows cannot borrow that admission.
const repairResearchPriority=r=>Number(r.input.memeExitMode===true && r.decisions.some(d=>
  d.decision!=='不买' && (d.evidence?.lossRepair?.catalystReady===true
    || d.evidence?.lossRepair?.entryPath==='external_structure'&&d.evidence.lossRepair.entryPathAllowed===true
      && d.evidence.opportunity?.pattern?.ready===true)
    && d.evidence.lossRepair.reentry?.ready===true && !d.evidence?.safety?.blocked?.length));

// A scheduling hint, never trading evidence. A disappearing candidate releases
// focus, and candidate churn cannot postpone the mandatory discovery interval.
export function advanceEntryFocus(current, candidate, nowMs, {windowMs=20000}={}) {
  if (![20000,45000].includes(windowMs)) throw new TypeError('invalid bounded entry window');
  if(current && nowMs<current.nextAllowedAt) return {...current,active:!!current.active
    && !!candidate && key(candidate)===current.key && nowMs>=current.since && nowMs<current.until};
  return candidate ? {key:key(candidate),since:nowMs,until:nowMs+windowMs,nextAllowedAt:nowMs+windowMs+10000,active:true}
    : current ? {...current,active:false} : null;
}

export function chartRefreshDue(chart,nowMs,{active=false}={}) {
  // No upstream sample was attempted when admission timed out. Keep a short,
  // bounded retry gap rather than treating it as a 60s market-data failure.
  if(chart&&['GMGN_QUEUE_EXPIRED','GMGN_REQUEST_BUSY'].includes(chart.reasonCode))return nowMs-chart.fetchedAt>=5000;
  if(!chart || nowMs-chart.fetchedAt>=60000)return true;
  // Keep a hot setup's next closed bar in the bounded queue BEFORE its old
  // evidence expires. A request boundary advances only with a real response;
  // late responses get a minimum gap, failures retain the normal cache backoff.
  if(active && chart.status==='ok' && Number.isFinite(chart.closedThroughAtMs)
    && nowMs-chart.fetchedAt>=5000 && nowMs-chart.closedThroughAtMs>=60000)return true;
  // A late response can expire its original CLOSED boundary before cache TTL.
  // Rejoin the existing bounded queue; failed sources keep the usual backoff.
  return chart.status==='ok' && Number.isFinite(chart.closedThroughAtMs)
    && nowMs-chart.closedThroughAtMs>90000;
}

export function canPrioritizeResearch(row) {
  const evidence=row.decisions[0]?.evidence, cost=evidence?.costAssumptions?.estimatedRoundTripCostRate;
  // One bounded main-research seat per chain is not an order. A fee model must
  // not erase a whole chain before its candles can even be inspected.
  if (row.input.memeExitMode === true) return !evidence?.safety?.blocked?.length;
  // Legacy comparison books retain their original economic admission policy.
  const maximum=CONFIRMED_PAPER_POLICY.maxCostRate;
  return !evidence?.safety?.blocked?.length && !(Number.isFinite(cost) && cost>maximum);
}

// Bounded rotating shortlist (one per chain by default, opt-in up to three).
// Selection uses currently observed fields only, not future performance.
export function planHotResearch(rows, chains, charts, nowMs, previous=[], narrativePriority=()=>0, {perChainLimit=1,maintainLeader=false,watchSince=null}={}) {
  if(!Number.isInteger(perChainLimit)||perChainLimit<1||perChainLimit>3)throw new TypeError('invalid bounded hot shortlist');
  const old=new Set(previous), score=r=>{
    const routes=r.decisions.flatMap(d=>d.evidence?.opportunityRoutes||[]);
    const ready=routes.some(s=>s.basis==='ohlcv' && s.signalReady);
    const t=r.input.token, c=charts.get(key(t));
    const candles=c?.candles||[], recent=candles.slice(-12);
    const movement=recent.length ? Math.max(...recent.map(b=>b.high))/Math.min(...recent.map(b=>b.low))-1 : 0;
    const checked=c?.status==='ok' && !chartRefreshDue(c,nowMs,{active:true}) && routes.some(s=>s.pattern && !s.pattern.missing);
    const news=r.input.newsResearch,newsAt=stamp(news?.sourceAt);
    const newsFresh=news?.researchOnly===true&&Number.isFinite(newsAt)&&newsAt<=nowMs&&nowMs-newsAt<=120000;
    const adjustment=narrativePriority(r.decisions[0],nowMs);
    const bounded=Number.isFinite(adjustment)?Math.max(-20,Math.min(20,adjustment)):0;
    // Negative semantics can reduce NEWS credit only, never erase independent
    // price/flow evidence, a holding exit, a discovery slot or a CA safety gate.
    const newsScore=Math.max(0,(newsFresh?35:0)+bounded);
    const currentFlow=r.input.flow?.fresh===true && r.input.flow?.complete===true && !r.input.flow?.coverageGap;
    const proofScore=r.decisions.some(d=>d.evidence?.lossRepair?.group==='event_narrative')?60
      : currentFlow && r.input.flow?.highProfitCount>0 ? 50 : 0;
    return (ready?100:checked?-40:0)+proofScore+(r.input.narrativeRecall?50:0)+newsScore+(r.input.flow?.pulse?.recentBuyerCount||0)*2
      +Math.min(20,movement*100)+Math.min(10,Math.log10(Math.max(1,t.volume||t.volume1h||t.volume24h||1)))
      +(old.has(key(t))?3:0);
  };
  const hot=[];
  const rank=r=>r.decisions.some(d=>d.evidence?.lossRepair?.catalystReady===true)
    && repairResearchPriority(r) ? 3 : walletBuyResearchHint(r.input,nowMs) ? 2 : repairResearchPriority(r);
  for(const chain of chains) {
    const eligible=rows.filter(r=>r.input.token.chain===chain && canPrioritizeResearch(r));
    // A new main hotspot must reach its first bounded chart attempt before
    // momentary score churn replaces it. Success AND failure populate the cache,
    // releasing this reservation. Disappearing/unsafe candidates release it too.
    // Existing exit/focus priority, chain rotation and discovery slots are unchanged.
    const ranked=eligible.sort((a,b)=>rank(b)-rank(a)||score(b)-score(a)||key(a.input.token).localeCompare(key(b.input.token)));
    const firstAttempt=ranked.filter(r=>r.input.memeExitMode===true && old.has(key(r.input.token)) && !charts.has(key(r.input.token)));
    // Verified catalysts and new buys may replace an unstarted ordinary
    // discovery, but never cancel in-flight work or borrow permission to trade.
    // A first attempt cannot pin a price-only row ahead of a higher-ranked
    // verified catalyst. Same-tier reservations survive harmless score churn.
    const reserved=firstAttempt.filter(r=>rank(r)>=rank(ranked[0]));
    const selected=new Map();
    // One persistent market-leader seat within the existing three-seat cap.
    // A completed non-setup must not erase a still-active top-volume token.
    const leaders=eligible.filter(r=>marketLeaderHint(r,nowMs));
    // In focused mode keep one still-qualified market leader across refreshes,
    // not a new CA merely because its cache is older. Leaving the top five,
    // delisting, stale evidence or a hard block releases this seat immediately.
    const retained=maintainLeader?leaders.filter(r=>old.has(key(r.input.token))).sort((a,b)=>compareMarketLeaders(a,b,nowMs))[0]:null;
    const leader=perChainLimit>1?(retained||leaders.sort((a,b)=>
      (maintainLeader?0:(charts.get(key(a.input.token))?.fetchedAt||0)-(charts.get(key(b.input.token))?.fetchedAt||0))
      ||compareMarketLeaders(a,b,nowMs))[0]):null;
    const catalysts=ranked.filter(r=>rank(r)===3);
    const watched=watchSince?eligible.filter(r=>{
      const since=watchSince.get(key(r.input.token));
      return old.has(key(r.input.token)) && hotWatchEligible(r,nowMs)
        && Number.isFinite(since)&&since<=nowMs&&nowMs-since<HOT_WATCH_MS;
    }).slice(0,2):[];
    const walletPriority=watchSince?ranked.filter(r=>rank(r)===2):[];
    const preferred=maintainLeader?[...catalysts.slice(0,1),...(leader?[leader]:[]),...catalysts,...walletPriority,...watched]
      :[...catalysts,...(leader?[leader]:[]),...walletPriority,...watched];
    for(const r of [...preferred,...reserved,...ranked])
      if(!selected.has(key(r.input.token)))selected.set(key(r.input.token),r);
    hot.push(...[...selected.values()].slice(0,perChainLimit));
  }
  return hot;
}

export function selectQuoteTarget(targets, quotes, attempts, nowMs, { quoteProgress = new Map() } = {}) {
  const age=t=>{
    const q=quotes.get(key(t)),at=stamp(q?.observedAt);
    return q?.status==='ok' && q.chain===t.chain && q.address===t.address && Number.isFinite(q.price) && q.price>0
      && Number.isFinite(at) && at<=nowMs ? nowMs-at : Infinity;
  };
  const oldest=rows=>rows.toSorted((a,b)=>(attempts.get(key(a))??-Infinity)-(attempts.get(key(b))??-Infinity))[0];
  // In the confirmed paper lane, a token with a partial fresh sample set is already
  // paying for a confirmation window. Finish that bounded sequence before
  // rotating to a never-started candidate; otherwise churn can leave every
  // candidate perpetually at historyCount=1/2 and make fills impossible.
  const partial=oldest(targets.filter(t=>{
    const count=Number(quoteProgress.get(key(t))?.length||0);
    return count>0 && count<CONFIRMED_PAPER_POLICY.quoteCount;
  }));
  if(partial)return partial;
  // Reserve roughly half the 15-second exit freshness window for network work.
  // Below this deadline use least-recently-attempted fairness, rather than a
  // 3-second urgency threshold that monopolized every slot after a slow request.
  return oldest(targets.filter(t=>t.holdingTier==='main'&&t.purpose==='exit'&&age(t)>=7500))
    ||oldest(targets.filter(t=>t.purpose==='exit'&&t.holdingTier!=='comparison'&&age(t)>=7500))
    ||oldest(targets);
}

export function selectResearchChart({holdings,hot,broad,charts,nowMs,dispatch,chains,lastHotChain=null,focus=null,researchFocus=null,pendingKeys=new Set()}) {
  const oldest=(rows,active=false)=>rows.filter(t=>!pendingKeys.has(key(t)) && chartRefreshDue(charts.get(key(t)),nowMs,{active}))
    .sort((a,b)=>(charts.get(key(a))?.fetchedAt||0)-(charts.get(key(b))?.fetchedAt||0))[0];
  const needsChart=p=>p.requiresStructureChart || p.pvpPolicy?.version==='structure_hold_v2';
  const main=oldest(holdings.filter(p=>p.holdingTier==='main'&&needsChart(p)),true);
  if(main)return {...main,purpose:'exit',researchLane:'holding'};
  const held=oldest(holdings.filter(p=>p.holdingTier!=='comparison'&&needsChart(p)),true);
  if(held)return {...held,purpose:'exit',researchLane:'holding'};
  if(focus) {
    if(focus.requiresStructureChart===false)return undefined;
    const candidate=oldest([focus],true);
    return candidate ? {...candidate,purpose:'candidate',researchLane:'entry'} : undefined;
  }
  const comparison=oldest(holdings.filter(p=>p.holdingTier==='comparison'&&needsChart(p)));
  // Shadow books cannot consume every chart slot while the main book is flat.
  // Keep one of four non-main slots (or spare capacity) for their real marks.
  if(comparison&&dispatch%4===3)return {...comparison,purpose:'comparison',researchLane:'holding'};
  const hotTokens=hot.map(r=>r.input.token), hotKeys=new Set(hotTokens.map(key));
  const cold=broad.map(r=>r.input.token).filter(t=>!hotKeys.has(key(t)));
  const fairCold=()=>{
    for(let i=0;i<chains.length;i++) {
      const chain=chains[(Math.floor(dispatch/3)+i)%chains.length], t=oldest(cold.filter(t=>t.chain===chain));
      if(t)return {...t,purpose:'candidate',researchLane:'discovery'};
    }
  };
  if(dispatch%3===2) {const t=fairCold();if(t)return t;}
  // Some verified event routes need an exit chart even outside the external
  // shortlist. Research can collect it in normal capacity, without acquiring
  // confirmation priority or suppressing the one-in-three discovery turn.
  if(researchFocus&&researchFocus.requiresStructureChart!==false){
    const t=oldest([researchFocus],true);
    if(t)return {...t,purpose:'candidate',researchLane:'hot',researchOnly:true};
  }
  const leaders=hot.filter(r=>marketLeaderHint(r,nowMs)).sort((a,b)=>compareMarketLeaders(a,b,nowMs));
  const leader=oldest(leaders.map(r=>r.input.token),true);
  if(leader)return {...leader,purpose:'candidate',researchLane:'hot'};
  // One of three chart dispatches may jump directly to a fresh wallet buy.
  // Holding exits, an admitted quote focus, cold discovery and chain rotation
  // keep their capacity. The existing cache/backoff and pending-key gates apply.
  if(dispatch%3===0) {
    const buying=hot.filter(r=>walletBuyResearchHint(r.input,nowMs));
    const target=oldest(buying.map(r=>r.input.token),true);
    if(target)return {...target,purpose:'candidate',researchLane:'wallet',
      walletTrigger:walletBuyResearchHint(buying.find(r=>key(r.input.token)===key(target)).input,nowMs)};
  }
  // Unseen caches all have age zero: sorting by cache time across chains lets
  // endless new names on the first chain monopolize every hot request.
  const start=(chains.indexOf(lastHotChain)+1)%chains.length;
  for(let i=0;i<chains.length;i++) {
    const t=oldest(hotTokens.filter(t=>t.chain===chains[(start+i)%chains.length]),true);
    if(t)return {...t,purpose:'candidate',researchLane:'hot'};
  }
  return fairCold()||(comparison?{...comparison,purpose:'comparison',researchLane:'holding'}:undefined);
}

export function quoteCandidatePool(rows,{mainFirst=false,catalystFirst=false}={}) {
  const usable=rows.filter(r=>!r.input.opportunityAccount?.positions?.[key(r.input.token)]);
  const main=mainFirst?usable.filter(r=>r.candidateBook==='main'):[];
  const pool=main.length?main:usable,unique=new Map();
  for(const r of pool)if(!unique.has(key(r.input.token)))unique.set(key(r.input.token),r);
  const result=[...unique.values()];
  const decision=r=>r.decisions?.[0]||{token:r.input.token,evidence:{}};
  return catalystFirst?result.sort((a,b)=>compareConfirmedCandidates(decision(a),decision(b))):result;
}

export function selectQuoteCandidate(rows,current,nowMs,{windowMs=20000,mainFirst=false}={}) {
  if (![20000,45000].includes(windowMs)) throw new TypeError('invalid bounded quote lease');
  // A lease starts at actual selection, not a wall-clock modulo boundary.
  // A new quote can't get stranded at xx:29 just before an unrelated rotation.
  const usable=quoteCandidatePool(rows,{mainFirst});
  const retained=usable.find(r=>key(r.input.token)===current?.key&&(!mainFirst||r.candidateBook===current.candidateBook));
  if(retained && nowMs-current.since<windowMs)return {row:retained,lease:current};
  const index=usable.findIndex(r=>key(r.input.token)===current?.key);
  const next=usable[(index+1)%usable.length];
  return next?{row:next,lease:{key:key(next.input.token),since:nowMs,...(mainFirst?{candidateBook:next.candidateBook}:{})}}:{row:null,lease:null};
}
