import {validMonitorSignal,confirmMonitorQuote} from './paper-monitor-signal.js';
import {validPoolSignal} from './paper-pool-signal.js';

export const LAUNCH_ENTRY_VERSION='new_launch_narrative_v1';
export const LAUNCH_THESIS_VERSION='entry_bound_launch_event_v1';
export const LAUNCH_POLICY=Object.freeze({version:LAUNCH_ENTRY_VERSION,mode:'paper',decisionTargetMs:1000,
  maxTokenAgeMs:900000,maxEventAgeMs:120000,quoteMaxAgeMs:5000,requiresChart:false,quoteCount:1,
  note:'已核实内盘/临毕业、创建十五分钟内、事件两分钟内；收到必要数据后目标一秒决策，非上游或成交时延保证'});
const stamp=v=>typeof v==='number'?(v<1e10?v*1000:v):Date.parse(v||'');

// Stage comes from the token feed, never inferred from a name or a recent tweet.
export function launchContext(token,event,nowMs) {
  if(event?.source==='new_pool_first_three') {
    if(token?.stageConflict||!validPoolSignal(event,token,nowMs))return null;
    return {version:LAUNCH_ENTRY_VERSION,chain:token.chain,address:token.address,marketStage:token.marketStage||'unknown',
      creationTimestamp:Date.parse(event.pool.createdAt),sourceId:event.sourceId,sourceAt:event.sourceAt,
      requiresChart:false,decisionTargetMs:1000,pool:{...event.pool}};
  }
  const created=stamp(token?.creationTimestamp??token?.openTimestamp);
  const sourceAt=Date.parse(event?.sourceAt);
  if(!['internal','near_completion'].includes(token?.marketStage)||token.stageConflict
    ||!Number.isFinite(created)||created>nowMs||nowMs-created>LAUNCH_POLICY.maxTokenAgeMs
    ||!validMonitorSignal(event,token,nowMs)||event.authenticated!==true
    ||!Number.isFinite(sourceAt)||sourceAt>nowMs||nowMs-sourceAt>LAUNCH_POLICY.maxEventAgeMs)return null;
  return {version:LAUNCH_ENTRY_VERSION,chain:token.chain,address:token.address,marketStage:token.marketStage,
    creationTimestamp:created,sourceId:event.sourceId,sourceAt:event.sourceAt,requiresChart:false,decisionTargetMs:1000};
}

export function verifiedLaunchContext(proof,token,event,nowMs) {
  const c=proof?.newLaunch;
  if(!c||c.chain!==token?.chain||c.address!==token?.address)return null;
  const expected=launchContext({...token,marketStage:c.marketStage,creationTimestamp:c.creationTimestamp},event,nowMs);
  return expected&&JSON.stringify(c)===JSON.stringify(expected)?expected:null;
}

export function launchQuote(proof,token,event,nowMs) {
  if(!verifiedLaunchContext(proof,token,event,nowMs))return {ready:false,reason:'新盘阶段或新鲜原文证据失效'};
  return confirmMonitorQuote(proof.quotes||[],token,event,nowMs,{newLaunch:true});
}

export const LAUNCH_ENTRY_TEXT='新盘叙事快线：已核实内盘/临毕业和创建时间，原文事件与 CA 有明确关联；一次事件后的五秒内真实报价即可判断，不等待 K 线、跨三秒报价或盈利钱包人数。保留安全、税率、流动性、成本与余额检查；必要数据到达后的本地决策目标一秒，不保证上游或成交速度。';
export const POOL_ENTRY_TEXT='新模板/新底池前三 CA 快线：按链上创建顺序取每次已核实机制更新的最早三个不同 CA，不等待 K 线或额外推文；模板、底池和创建回执仅是机制证据，不代表聪明钱买入或盈利。仍需事件后新鲜报价、安全、可卖性、税率不高于 6%、真实深度、成本和余额检查；同机制/同CA去重，不替补第四名，仅模拟买入。';
