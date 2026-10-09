// Descriptive reconstruction, not the wallet owner's thoughts or copy orders.
import {createHash} from 'node:crypto';
import {analyzeWalletHabits,learningWalletRole} from './wallet-learning.js';
import {gmgnFlowAddress} from './gmgn-flow-signal.js';
import {narrativeSourceKey} from './paper-narrative-thesis.js';
export const WALLET_CONTEXT_VERSION='wallet_trade_context_v1';
const MINUTE=60000,DAY=86400000,MAX_CASES=2000;
const stamp=v=>typeof v==='number'?v:Date.parse(v||'');
const positive=n=>Number.isFinite(n)&&n>0;
const key=t=>`${t.chain}:${t.address||t.token}`;
const fingerprint=r=>createHash('sha256').update(JSON.stringify([r.chain,r.wallet,r.token,r.hash,r.at,r.side,r.quantity,r.usd,r.price,
  r.positionAction,r.addPriceChange,r.soldFraction,r.matchedCostUsd,r.grossReturn])).digest('hex');
const id=r=>`${r.chain}:${r.wallet}:${r.hash}:${r.token}`;
const median=a=>a.toSorted((x,y)=>x-y)[Math.floor(a.length/2)];
export function walletTradeChartContext(action,chart,nowMs) {
  if(!chart||chart.status!=='ok'||chart.resolution!=='1m'||key(chart)!==key(action)
    ||!positive(stamp(chart.fetchedAt))||stamp(chart.fetchedAt)>nowMs||!positive(chart.closedThroughAtMs))return null;
  const bars=(chart.candles||[]).filter(c=>positive(stamp(c?.time))&&stamp(c.time)+MINUTE<=Math.min(action.at,chart.closedThroughAtMs)
    &&stamp(c.time)>=action.at-30*MINUTE&&[c.open,c.high,c.low,c.close].every(positive)
    &&Number.isFinite(c.volume)&&c.volume>=0&&c.high>=Math.max(c.open,c.close,c.low)&&c.low<=Math.min(c.open,c.close));
  bars.sort((a,b)=>stamp(a.time)-stamp(b.time));
  if(bars.length<5||action.at-stamp(bars.at(-1).time)-MINUTE>2*MINUTE
    ||bars.some((b,i)=>i&&stamp(b.time)-stamp(bars[i-1].time)!==MINUTE))return null;
  const high=Math.max(...bars.map(b=>b.high)),low=Math.min(...bars.map(b=>b.low));
  const priorVolume=median(bars.slice(0,-1).map(b=>b.volume));
  const pullback=action.price/high-1,rangePosition=high>low?(action.price-low)/(high-low):null;
  const kind=action.price>high?'above_prior_high':pullback<=-.15&&rangePosition!==null&&rangePosition<=.35?'deep_pullback':
    rangePosition!==null&&rangePosition>=.8?'upper_range':'within_range';
  return {kind,label:{above_prior_high:'高于此前区间高点',deep_pullback:'此前区间的深回撤低位',upper_range:'此前区间偏高位置',within_range:'此前区间内'}[kind],
    windowStart:stamp(bars[0].time),windowEnd:stamp(bars.at(-1).time)+MINUTE,bars:bars.length,
    price:action.price,priorHigh:high,priorLow:low,pullback,rangePosition,
    lastClosedVolumeRatio:priorVolume>0?bars.at(-1).volume/priorVolume:null,retrievedAt:stamp(chart.fetchedAt),
    knowledge:stamp(chart.fetchedAt)<=action.at?'available_to_system':'retrospective',
    note:'仅用成交前已收盘 K 线；不是未来最高点、精准抄底或卖顶认证'};
}
function narratives(action,documents,nowMs) {
  return documents.filter(d=>!d.conflicted&&narrativeSourceKey(d.url)&&positive(d.sourceAt)&&d.sourceAt<=action.at
    &&action.at-d.sourceAt<=DAY&&positive(d.firstSeenAt)&&d.firstSeenAt>=d.sourceAt&&d.firstSeenAt<=nowMs)
    .flatMap(d=>{
      const linked=d.candidates?.find(t=>t.chain===action.chain&&t.address===action.token&&['direct_ca','project_permalink'].includes(t.binding));
      if(!linked)return [];
      const knownAt=Math.max(d.firstSeenAt,linked.firstSeenAt||d.firstSeenAt);
      return [{url:d.url,sourceAt:d.sourceAt,associatedAt:knownAt,author:d.author||'',excerpt:String(d.text||'').slice(0,240),
        binding:linked.binding,categories:d.categories||[],knowledge:knownAt<=action.at?'available_to_system':'retrospective',
        walletAwareness:'unknown',note:'只证明时间与 CA 关联，不能证明该地址因这条消息交易'}];
    }).sort((a,b)=>b.sourceAt-a.sourceAt).slice(0,3);
}
export function validWalletContext(s) {
  try{return !!s&&s.version===WALLET_CONTEXT_VERSION&&positive(s.updatedAt)&&Array.isArray(s.cases)&&s.cases.length<=MAX_CASES
    &&new Set(s.cases.map(c=>c.id)).size===s.cases.length&&s.cases.every(c=>c.id===id(c)&&gmgnFlowAddress(c.chain,c.wallet)===c.wallet
      &&gmgnFlowAddress(c.chain,c.token)===c.token&&positive(c.at)&&c.at<=s.updatedAt&&positive(c.firstObservedAt)&&c.firstObservedAt<=s.updatedAt
      &&/^[a-f0-9]{64}$/.test(c.fingerprint)&&['buy','sell'].includes(c.side)&&[c.quantity,c.usd,c.price].every(positive)
      &&(c.chartAttempts==null||Number.isSafeInteger(c.chartAttempts)&&c.chartAttempts>=0&&c.chartAttempts<=2)
      &&(c.chartAttemptAt==null||positive(c.chartAttemptAt)&&c.chartAttemptAt<=s.updatedAt)
      &&(!c.chart||['above_prior_high','deep_pullback','upper_range','within_range'].includes(c.chart.kind)
        &&positive(c.chart.windowStart)&&c.chart.windowStart<c.chart.windowEnd&&c.chart.windowEnd<=c.at
        &&positive(c.chart.retrievedAt)&&c.chart.retrievedAt<=s.updatedAt&&positive(c.chart.priorHigh)&&positive(c.chart.priorLow)
        &&Number.isInteger(c.chart.bars)&&c.chart.bars>=5&&c.chart.bars<=30)
      &&Array.isArray(c.narratives)&&c.narratives.length<=3&&c.narratives.every(n=>narrativeSourceKey(n.url)&&n.sourceAt<=c.at
        &&n.associatedAt<=s.updatedAt&&n.walletAwareness==='unknown')&&typeof c.quarantined==='boolean');}catch{return false;}
}
export function advanceWalletContext(prior,{wallets=[],charts=[],documents=[],nowMs=Date.now()}={}) {
  if(prior&&!validWalletContext(prior))throw Error('wallet_context_invalid');
  if(!positive(nowMs)||prior&&prior.updatedAt>nowMs)throw Error('wallet_context_clock');
  const state=prior?structuredClone(prior):{version:WALLET_CONTEXT_VERSION,updatedAt:nowMs,cases:[]};
  state.cases=state.cases.filter(c=>nowMs-c.at<=30*DAY);
  const cases=new Map(state.cases.map(c=>[c.id,c])),byChart=new Map();
  for(const c of charts.slice(0,101)){const k=key(c);if(!byChart.has(k))byChart.set(k,[]);byChart.get(k).push(c);}
  const walletMap=new Map(wallets.slice(0,80).map(w=>[`${w.chain}:${w.wallet}`,w]));
  // Revalidate retained cases against revised/missing/ambiguous inventory;
  // never let an older clean sample survive a newly discovered transfer gap.
  const allActions=new Map(),roles=new Map();
  for(const [walletKey,w] of walletMap) {
    const actions=analyzeWalletHabits(w.rows.filter(r=>r.at<=nowMs)).actions;
    allActions.set(walletKey,new Map(actions.map(a=>[id(a),a])));roles.set(walletKey,learningWalletRole(w,nowMs));
    for(const a of actions.filter(a=>nowMs-a.at<=30*DAY).toSorted((a,b)=>b.at-a.at).slice(0,20)) {
      const caseId=id(a);if(cases.has(caseId))continue;
      cases.set(caseId,{...a,id:caseId,fingerprint:fingerprint(a),firstObservedAt:nowMs,chart:null,narratives:[],quarantined:false});
    }
  }
  for(const c of cases.values()) {
    const wk=`${c.chain}:${c.wallet}`,w=walletMap.get(wk),a=allActions.get(wk)?.get(c.id);
    c.role=roles.get(wk)||'unverified';
    c.quarantined=!w||!!w.historyGap||!!w.lastError||!a||fingerprint(a)!==c.fingerprint||c.role==='excluded';
    c.qualityReason=c.quarantined?'样本缺口 / 修订 / 无法归因，仅保留记录，不用于习惯归纳':c.role==='teacher'?'当前双周期盈利核验通过；不证明可复制收益':'交易事实可观察，尚不是当前合格盈利教师';
    if(c.quarantined)continue;
    if(!c.chart)c.chart=(byChart.get(key(c))||[]).map(chart=>walletTradeChartContext(c,chart,nowMs)).find(Boolean)||null;
    // Persist only sourced associations; future posts and name-only matches
    // cannot backfill a supposed explanation of an earlier trade.
    c.narratives=narratives(c,documents,nowMs).concat(c.narratives.filter(n=>!documents.some(d=>narrativeSourceKey(d.url)===narrativeSourceKey(n.url))))
      .filter(n=>!documents.some(d=>d.conflicted&&narrativeSourceKey(d.url)===narrativeSourceKey(n.url))).slice(0,3);
  }
  state.cases=[...cases.values()].sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id)).slice(0,MAX_CASES);state.updatedAt=nowMs;
  return {memory:state,report:walletContextReport(state)};
}
export function selectWalletChartTarget(memory,nowMs) {
  if(!validWalletContext(memory))return null;
  const c=memory.cases.filter(c=>!c.quarantined&&!c.chart&&c.at<=nowMs&&nowMs-c.at<=7*DAY
    &&['sol','bsc','base','eth'].includes(c.chain)&&(c.chartAttempts||0)<2
    &&(!c.chartAttemptAt||nowMs-c.chartAttemptAt>=6*60*MINUTE))
    .sort((a,b)=>(a.chartAttemptAt||0)-(b.chartAttemptAt||0)||b.at-a.at)[0];
  if(!c)return null;
  const to=Math.floor(c.at/MINUTE)*60;
  return {caseId:c.id,chain:c.chain,address:c.token,from:to-1800,to,resolution:'1m',purpose:'learning',latestClosed:false};
}
export function walletContextReport(s,error=null) {
  if(error||s&&!validWalletContext(s))return {version:WALLET_CONTEXT_VERSION,status:'error',error:error||'钱包情境记录异常，原样保留',researchOnly:true};
  if(!s)return {version:WALLET_CONTEXT_VERSION,status:'waiting',cases:0,researchOnly:true};
  const usable=s.cases.filter(c=>!c.quarantined),teachers=usable.filter(c=>c.role==='teacher');
  const summary=rows=>({cases:rows.length,buys:rows.filter(c=>c.side==='buy').length,sells:rows.filter(c=>c.side==='sell').length,
    partialExits:rows.filter(c=>c.positionAction==='partial_exit').length,
    winningExits:rows.filter(c=>c.side==='sell'&&c.grossReturn>0).length,losingExits:rows.filter(c=>c.side==='sell'&&c.grossReturn<0).length,
    risingAdds:rows.filter(c=>c.side==='buy'&&c.addPriceChange>=.03).length,
    fallingAdds:rows.filter(c=>c.side==='buy'&&Number.isFinite(c.addPriceChange)&&c.addPriceChange<=-.03).length,
    chartContexts:rows.filter(c=>c.chart).length,narrativeContexts:rows.filter(c=>c.narratives.length).length});
  return {version:s.version,status:'collecting',updatedAt:new Date(s.updatedAt).toISOString(),researchOnly:true,autoTradingChanges:false,
    cases:s.cases.length,quarantined:s.cases.length-usable.length,observed:summary(usable),teachers:summary(teachers),
    positionGroups:['above_prior_high','deep_pullback','upper_range','within_range'].map(kind=>({kind,...summary(usable.filter(c=>c.chart?.kind===kind))})),
    recent:usable.toSorted((a,b)=>b.at-a.at).slice(0,12),
    lessons:[
      {name:'买入位置',evidence:usable.filter(c=>c.chart&&c.side==='buy').length,rule:'对照成交前的区间高低点、回撤和已收盘量能；没有 K 线不猜低吸或突破'},
      {name:'卖出习惯',evidence:usable.filter(c=>c.side==='sell').length,rule:'区分分批兑现、退出、盈利卖出和亏损卖出；仅有成交不能断言止盈或恐慌动机'},
      {name:'叙事选择',evidence:usable.filter(c=>c.narratives.length).length,rule:'只关联成交前发布且有同 CA 出处的事件；事后收录独立标记，不猜交易员看过什么'},
    ],limits:{maxCases:MAX_CASES,newestPerWalletPerPass:20,retentionDays:30},
    caveat:'有界观察样本，非完整跟单回测；FIFO 毛收益未扣费用。当前盈利标签不反推历史身份；不自动改变主盘买卖规则'};
}
