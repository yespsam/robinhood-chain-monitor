import {MONITOR_ENTRY_VERSION,validMonitorSignal,confirmMonitorQuote} from './paper-monitor-signal.js';
import {monitoredPaperSafety} from './paper-safety-policy.js';
import {CONFIRMED_PAPER_VERSION,LOSS_RESPONSE_VERSION,paperOperatingPolicy} from './paper-confirmed-policy.js';
import {STRATEGY_ANALYSIS_VERSION} from './paper-strategy-analysis.js';
import {OPPORTUNITY_REVIEW_VERSION} from './paper-opportunity-review.js';
import {MEME_EXIT_TEXT} from './paper-meme-exit.js';
import {paperCostGate} from './paper-cost-policy.js';
import {launchContext,LAUNCH_ENTRY_TEXT,POOL_ENTRY_TEXT} from './paper-launch-policy.js';

export function monitoredPaperEntry(base,{monitorSignal,sourceSafety,quoteHistory,token,nowMs,lossRepairMode=false}) {
  const v=base.evidence,valid=validMonitorSignal(monitorSignal,base.token,nowMs);
  const launch=lossRepairMode?launchContext(token,monitorSignal,nowMs):null;
  const launchText=launch?.pool?POOL_ENTRY_TEXT:LAUNCH_ENTRY_TEXT;
  const safety=launch?{...sourceSafety,auditMissing:[...sourceSafety.missing],auditComplete:!sourceSafety.missing.length,
    sellabilityVerified:token.isHoneypot===false,policyVersion:'launch_source_checks_v1'}:monitoredPaperSafety(token,sourceSafety,valid);
  const required=new Set(['有效链和合约地址','有效可用余额与流动性对应的滚仓预算','可用余额及流动性额度须足够固定 10 U',
    '两分钟内的真实行情','有效正数价格','五秒内的独立报价','真实流动性','真实成交量','内外盘来源冲突待核对']);
  const missing=[...safety.missing,...base.missing.filter(x=>required.has(x))],reasons=[...safety.blocked];
  if(!valid)missing.push(['kol_theme_hypothesis','twitter_narrative_event'].includes(monitorSignal?.source)?'一小时内已核实原帖与新鲜主题候选':'两分钟内绑定精确 CA 的新监控事件');
  if(monitorSignal?.source==='new_pool_first_three'&&!launch)missing.push('新底池前三 CA 仅用于亏损修复模拟盘的专用快线');
  if(!(v.liquidity>=20000))reasons.push('流动性低于 $20,000');
  if(!(v.volume.value>0))reasons.push('等待真实成交量');
  if(!(base.entryUsd>=1))reasons.push('可用模拟预算不足');
  const costGate=paperCostGate(v.costAssumptions);
  if(costGate.reason)(costGate.needsStructure?missing:reasons).push(costGate.reason);
  const confirmation=valid?confirmMonitorQuote(quoteHistory,base.token,monitorSignal,nowMs,{newLaunch:!!launch}):{ready:false,reason:'连续新鲜报价确认'};
  if(!confirmation.ready)(confirmation.reason==='连续新鲜报价确认'?missing:reasons).push(confirmation.reason);
  const eligible=!missing.length&&!reasons.length,label=launch?.pool?'新模板/新底池前三 CA':launch?'新盘叙事快线':'监控事件快线';
  const thematic=monitorSignal?.source==='kol_theme_hypothesis';
  const narrative=monitorSignal?.source==='twitter_narrative_event';
  const source=thematic?'大 KOL 无 CA 主题映射（名称相符且项目资料引用原帖；社区关联假设，不是作者认领 CA）':monitorSignal?.source==='gmgn_platform_call'?'GMGN 平台喊单（未取得完整推文，不代表作者认证或已核实叙事）':'自有监控原文（已核对出处）';
  const entryLogic=narrative?`推特事件驱动：先读 @${monitorSignal.narrativeCandidate.author} 原文，再匹配 ${[...monitorSignal.narrativeCandidate.matchedNames,...monitorSignal.narrativeCandidate.matchedTags,...monitorSignal.narrativeCandidate.concepts].join(' / ')}。${monitorSignal.narrativeCandidate.event.claim}；CA 关联为 ${monitorSignal.narrativeCandidate.binding}，不是作者背书。通过税费、流动性、成本及余额检查后，还须触发后两次独立走强报价；恢复期另查事件后双地址买盘和可观测退出证据。不补造旧成交。`:`${label}：${source}，精确绑定 ${base.token.chain} / ${base.token.address}。消息触发两分钟内，用触发后一次五秒内独立报价模拟试仓；${thematic?'超过两分钟至一小时只作当前行情跟随，两次独立报价跨三秒且重新走强；不补造原帖发布时成交。':''}不等完整 K 线、涨幅形态或聪明钱标签。`
    +'缺失审计字段不拦截，集中度、打包占比等只作观察；未知仍是未知，不声称已排除貔貅。保留链和 CA、真实行情、税费、余额及明确不可交易标记检查；同一消息不重复买。';
  return {...base,label,decision:safety.blocked.length?'不买':eligible?'可模拟':'观察',
    score:Math.max(0,100-missing.length*10-reasons.length*15),missing:[...new Set(missing)],
    reasons:eligible?[launch?.pool?`${launch.pool.mechanismLabel||`新底池 ${launch.pool.quoteSymbol}`} · 第 ${launch.pool.ordinal}/3 个 CA，创建顺序、独立报价与模型成本检查通过`:'新监控事件、独立报价与模型成本检查通过']:[...new Set(reasons)],entryLogic:launch?launchText:entryLogic,exitLogic:MEME_EXIT_TEXT,
    evidence:{...v,...(launch?{newLaunch:launch}:{}),costGate,paperEligible:eligible,safety,accountPolicy:paperOperatingPolicy(true),
      entryPlan:{version:STRATEGY_ANALYSIS_VERSION,confirmedPolicyVersion:CONFIRMED_PAPER_VERSION,entryPolicyVersion:MONITOR_ENTRY_VERSION,
        eligible,setup:label,entryZone:{low:base.token.price,high:base.token.price},stopPrice:null,targetPrice:null,
        targetRole:'structure_reference_only',stopRole:'none',targetKind:'监控事件不虚构价格目标',exitPolicyVersion:v.exitPolicy.version,
        confirmedAt:confirmation.confirmedAt||null,netRewardRisk:null,estimatedStopLossUsd:null,summary:launch?launchText:entryLogic},
      confirmedPolicy:{version:CONFIRMED_PAPER_VERSION,lossResponseVersion:LOSS_RESPONSE_VERSION,pulse:null,confirmation},
      opportunity:{version:'multi_setup_v2',reviewVersion:OPPORTUNITY_REVIEW_VERSION,entryPolicyVersion:MONITOR_ENTRY_VERSION,
        id:'monitored_event',label,basis:'monitored_event',signalId:monitorSignal?.id||null,signalAt:Date.parse(monitorSignal?.sourceAt)||null,
        signalReady:valid,event:structuredClone(monitorSignal||null)}}};
}
