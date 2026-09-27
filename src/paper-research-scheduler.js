import { CONFIRMED_PAPER_POLICY } from './paper-confirmed-policy.js';
import { MAIN_STRUCTURE_MAX_COST_RATE } from './paper-cost-policy.js';
const key=t=>`${t.chain}:${t.address}`;
const stamp=v=>typeof v==='number'?(v<1e10?v*1000:v):Date.parse(v||'');
export const RESEARCH_SCHEDULER_VERSION='main_execution_priority_v16';

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
  // A main external candidate needs candles to assess net structural space.
  // Do not exclude it using the legacy 5% cap before that evidence exists.
  // Extreme costs and known safety failures still yield their scarce hot seat.
  const maximum=row.input.memeExitMode===true ? MAIN_STRUCTURE_MAX_COST_RATE : CONFIRMED_PAPER_POLICY.maxCostRate;
  return !evidence?.safety?.blocked?.length && !(Number.isFinite(cost) && cost>maximum);
}

// Five rotating chain seats, not hundreds of nominally "near-entry" tokens.
// Selection uses currently observed fields only, not future performance.
export function planHotResearch(rows, chains, charts, nowMs, previous=[]) {
  const old=new Set(previous), score=r=>{
    const routes=r.decisions.flatMap(d=>d.evidence?.opportunityRoutes||[]);
    const ready=routes.some(s=>s.basis==='ohlcv' && s.signalReady);
    const t=r.input.token, c=charts.get(key(t));
    const candles=c?.candles||[], recent=candles.slice(-12);
    const movement=recent.length ? Math.max(...recent.map(b=>b.high))/Math.min(...recent.map(b=>b.low))-1 : 0;
    const checked=c?.status==='ok' && !chartRefreshDue(c,nowMs,{active:true}) && routes.some(s=>s.pattern && !s.pattern.missing);
    const news=r.input.newsResearch,newsAt=stamp(news?.sourceAt);
    const newsFresh=news?.researchOnly===true&&Number.isFinite(newsAt)&&newsAt<=nowMs&&nowMs-newsAt<=120000;
    return (ready?100:checked?-40:0)+(r.input.narrativeRecall?50:0)+(newsFresh?35:0)+(r.input.flow?.pulse?.recentBuyerCount||0)*2
      +Math.min(20,movement*100)+Math.min(10,Math.log10(Math.max(1,t.volume||t.volume1h||t.volume24h||1)))
      +(old.has(key(t))?3:0);
  };
  const hot=[];
  for(const chain of chains) {
    const eligible=rows.filter(r=>r.input.token.chain===chain && canPrioritizeResearch(r));
    // A new main hotspot must reach its first bounded chart attempt before
    // momentary score churn replaces it. Success AND failure populate the cache,
    // releasing this reservation. Disappearing/unsafe candidates release it too.
    // Existing exit/focus priority, chain rotation and discovery slots are unchanged.
    const firstAttempt=eligible.find(r=>r.input.memeExitMode===true && old.has(key(r.input.token)) && !charts.has(key(r.input.token)));
    const best=firstAttempt || eligible.sort((a,b)=>score(b)-score(a)||key(a.input.token).localeCompare(key(b.input.token)))[0];
    if(best)hot.push(best);
  }
  return hot;
}

export function selectQuoteTarget(targets, quotes, attempts, nowMs) {
  const age=t=>{
    const q=quotes.get(key(t)),at=stamp(q?.observedAt);
    return q?.status==='ok' && q.chain===t.chain && q.address===t.address && Number.isFinite(q.price) && q.price>0
      && Number.isFinite(at) && at<=nowMs ? nowMs-at : Infinity;
  };
  const oldest=rows=>rows.toSorted((a,b)=>(attempts.get(key(a))??-Infinity)-(attempts.get(key(b))??-Infinity))[0];
  // Reserve roughly half the 15-second exit freshness window for network work.
  // Below this deadline use least-recently-attempted fairness, rather than a
  // 3-second urgency threshold that monopolized every slot after a slow request.
  return oldest(targets.filter(t=>t.holdingTier==='main'&&t.purpose==='exit'&&age(t)>=7500))
    ||oldest(targets.filter(t=>t.purpose==='exit'&&t.holdingTier!=='comparison'&&age(t)>=7500))
    ||oldest(targets);
}

export function selectResearchChart({holdings,hot,broad,charts,nowMs,dispatch,chains,lastHotChain=null,focus=null,pendingKeys=new Set()}) {
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
  // Unseen caches all have age zero: sorting by cache time across chains lets
  // endless new names on the first chain monopolize every hot request.
  const start=(chains.indexOf(lastHotChain)+1)%chains.length;
  for(let i=0;i<chains.length;i++) {
    const t=oldest(hotTokens.filter(t=>t.chain===chains[(start+i)%chains.length]),true);
    if(t)return {...t,purpose:'candidate',researchLane:'hot'};
  }
  return fairCold()||(comparison?{...comparison,purpose:'comparison',researchLane:'holding'}:undefined);
}

export function quoteCandidatePool(rows,{mainFirst=false}={}) {
  const usable=rows.filter(r=>!r.input.opportunityAccount?.positions?.[key(r.input.token)]);
  const main=mainFirst?usable.filter(r=>r.candidateBook==='main'):[];
  const pool=main.length?main:usable,unique=new Map();
  for(const r of pool)if(!unique.has(key(r.input.token)))unique.set(key(r.input.token),r);
  return [...unique.values()];
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
