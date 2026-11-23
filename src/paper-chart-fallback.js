// Nonblocking, source-isolated chart research. The secondary client owns its
// own provider/account pacing; this controller never reserves a GMGN slot.
import { opportunityChart } from './paper-opportunity-policy.js';
import { validateChartSource,validateChartProvenance } from './paper-chart-source.js';
export const CHART_FALLBACK_VERSION='bounded_secondary_chart_v1';
const key=t=>`${t.chain}:${t.chain==='sol'?t.address:String(t.address).toLowerCase()}`;
export const completeEntryChart=(chart,nowMs)=>{
  const checked=opportunityChart(chart?.candles,chart?.status,nowMs,{contiguousTail:true});
  return checked.ready&&checked.rows.length>=24;
};
export function createChartFallback({secondaryMarket=null,now=Date.now,isAdmitted=()=>false,getPrimary=()=>null,
  onReady=()=>{},minAttemptMs=60000,cacheLimit=32}={}) {
  const cache=new Map(),attempts=new Map();let active=null,closed=false,last=null,requests=0,accepted=0;
  const boundedSet=(map,k,value,limit)=>{map.delete(k);map.set(k,value);while(map.size>limit)map.delete(map.keys().next().value);};
  const usable=(token,chart,at)=>chart&&validateChartProvenance(chart.chartProvenance,token,chart.candles,{nowMs:at}).ready&&completeEntryChart(chart,at);
  const select=(token,primary)=>{
    if(!secondaryMarket||closed)return primary;
    if(completeEntryChart(primary,now()))return primary;
    const backup=cache.get(key(token));
    return isAdmitted(token)&&usable(token,backup,now())?backup:primary;
  };
  function observe(token,primary) {
    const selected=select(token,primary),at=now(),k=key(token);
    if(closed||!secondaryMarket?.kline||active||!['hot','catchup'].includes(token.researchLane)
      ||!isAdmitted(token)||completeEntryChart(primary,at)||usable(token,selected,at)
      ||at-(attempts.get(k)??-Infinity)<Math.max(60000,minAttemptMs))return selected;
    boundedSet(attempts,k,at,256);requests++;
    last={chain:token.chain,address:token.address,requestedAt:new Date(at).toISOString(),status:'running'};
    const frozen={chain:token.chain,address:token.address,symbol:token.symbol};
    const job=Promise.resolve().then(async()=>{
      if(closed)return;
      const boundary=Math.floor(now()/60000)*60;
      const raw=await secondaryMarket.kline({...frozen,resolution:'1m',from:boundary-3600,to:boundary,latestClosed:true,waitForSlot:false});
      if(closed)return;
      const receivedAt=now();
      if(raw?.status!=='ok'){last={...last,status:'unavailable',reasonCode:raw?.reasonCode||'SECONDARY_UNAVAILABLE',completedAt:new Date(receivedAt).toISOString()};return;}
      const checked=raw.source==='geckoterminal'?validateChartSource(raw,frozen,{nowMs:receivedAt}):{ready:false,reasonCode:'SECONDARY_SOURCE_UNSUPPORTED'};
      if(!checked.ready){last={...last,status:'rejected',reasonCode:checked.reasonCode,completedAt:new Date(receivedAt).toISOString()};return;}
      const item={...raw,candles:checked.candles,chartProvenance:checked.provenance,
        fetchedAt:Date.parse(raw.receivedAt),closedThroughAtMs:raw.to*1000,
        excludedUnclosedBars:checked.excludedUnclosedBars,markCandles:undefined,secondary:true};
      const chart=opportunityChart(item.candles,item.status,receivedAt,{contiguousTail:true});
      if(!chart.ready||chart.rows.length<24){last={...last,status:'incomplete',reasonCode:chart.diagnostics.code==='ready'?'INSUFFICIENT_ENTRY_THESIS_BARS':chart.diagnostics.code,completedAt:new Date(receivedAt).toISOString()};return;}
      // Membership and the primary may have changed during metadata/network IO.
      if(!isAdmitted(frozen)||completeEntryChart(getPrimary(frozen),receivedAt)) {
        last={...last,status:'discarded',reasonCode:!isAdmitted(frozen)?'CURRENT_RESEARCH_INELIGIBLE':'PRIMARY_READY',completedAt:new Date(receivedAt).toISOString()};return;
      }
      boundedSet(cache,k,item,Math.max(1,Math.min(100,cacheLimit)));
      accepted++;
      last={...last,status:'ready',source:item.source,closedBars:chart.rows.length,
        receivedAt:raw.receivedAt,closedThroughAt:new Date(item.closedThroughAtMs).toISOString(),completedAt:new Date(receivedAt).toISOString()};
      onReady(frozen,item);
    }).catch(()=>{if(!closed)last={...last,status:'unavailable',reasonCode:'SECONDARY_REQUEST_FAILED',completedAt:new Date(now()).toISOString()};})
      .finally(()=>{if(active===job)active=null;});
    active=job;return selected;
  }
  return {observe,select,snapshot:()=>({version:CHART_FALLBACK_VERSION,enabled:!!secondaryMarket,closed,
    pending:!!active,inFlight:!!active,attempts:requests,accepted,requests,cacheCount:cache.size,trackedAttempts:attempts.size,minAttemptMs:Math.max(60000,minAttemptMs),
    concurrency:1,last:last&&{...last},provider:secondaryMarket?.diagnostics?.()||null}),
    drain:()=>active||Promise.resolve(),
    close:async()=>{closed=true;const pending=active;await secondaryMarket?.close?.();await pending;cache.clear();attempts.clear();}};
}
