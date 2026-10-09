import {COLLECTIVE_SIGNAL_VERSION,PREQUALIFIED_WALLET_VERSION,INTERNAL_BURST_VERSION,ONCHAIN_BURST_VERSION,internalOnlySignal,walletSignalRoute,validCollectiveSignal,collectiveQuote} from './paper-collective-signal.js';
import {CONFIRMED_PAPER_VERSION,LOSS_RESPONSE_VERSION,paperOperatingPolicy} from './paper-confirmed-policy.js';
import {STRATEGY_ANALYSIS_VERSION} from './paper-strategy-analysis.js';
import {OPPORTUNITY_REVIEW_VERSION} from './paper-opportunity-review.js';
import {MEME_EXIT_TEXT} from './paper-meme-exit.js';
import {paperCostGate} from './paper-cost-policy.js';
import {internalDepthCheck} from './paper-internal-depth.js';

export const COLLECTIVE_ENTRY_TEXT='算法信号模拟：10/30/60 秒滚动窗口内至少三组历史盈利画像合格地址，各净买入至少 100U，窗口合计净流入至少 300U。同交易地址合并，不宣称控制人独立；不等待 AI 审批。内盘用触发后一次五秒内真实报价，外盘另查真实收盘结构。可卖性、税率≤6%、数据时效、余额、费用与成交去重仍须通过。资金行为不是已核实叙事。';
export const PREQUALIFIED_ENTRY_TEXT='内盘地址快线：7/30天盈利画像在本次买入前已核验，短窗真实净买至少100U；不等待三地址共振、上榜或K线。仍核验内盘阶段、买入交易、完整资金流、新鲜报价、可卖性及税费余额。不是庄家身份认定或盲目跟单。';
export const INTERNAL_BURST_TEXT='内盘逐笔放量：已覆盖公共逐笔流的当前30秒，相比前60秒成交速度至少2倍，成交≥1000U、净买≥300U，至少3组净买，买盘占比≥65%、最大组≤60%。不等待盈利画像或K线；不是全链爆量、叙事认证或盈利保证。仍核验阶段、真实报价、安全及订单深度。';
export const ONCHAIN_BURST_TEXT='内盘链上逐笔放量：固定 Four V2/Flap Portal 已核区间中，原生 BNB 底池普通地址的当前30秒成交，相比前60秒速度至少2倍，成交≥1000U、净买≥300U、至少3组净买、买盘占比≥65%、最大组≤60%。不等待GMGN盈利标签或K线；不是全BSC覆盖，不证明独立控制人、叙事或盈利。仍核验阶段、真实报价、安全及订单深度。';
export function collectivePaperEntry(base,{collectiveSignal,sourceSafety,quoteHistory,token,nowMs,internalDepth=null,internalDepthProposal=null}) {
  // Only this route may research a cash-capped order when the provider's pool
  // field cannot support USD sizing. A proposal still always needs real depth.
  if(internalDepthProposal)base={...base,entryUsd:internalDepthProposal.positionSizing.budgetUsd,
    missing:base.missing.filter(s=>!['真实流动性','有效可用余额与流动性对应的滚仓预算'].includes(s)),
    evidence:{...base.evidence,positionSizing:internalDepthProposal.positionSizing,costAssumptions:internalDepthProposal.costAssumptions}};
  const v=base.evidence,valid=validCollectiveSignal(collectiveSignal,base.token,nowMs);
  const single=collectiveSignal?.version===PREQUALIFIED_WALLET_VERSION,onchain=collectiveSignal?.version===ONCHAIN_BURST_VERSION;
  const burst=onchain||collectiveSignal?.version===INTERNAL_BURST_VERSION;
  const version=onchain?ONCHAIN_BURST_VERSION:burst?INTERNAL_BURST_VERSION:single?PREQUALIFIED_WALLET_VERSION:COLLECTIVE_SIGNAL_VERSION,
    entryText=onchain?ONCHAIN_BURST_TEXT:burst?INTERNAL_BURST_TEXT:single?PREQUALIFIED_ENTRY_TEXT:COLLECTIVE_ENTRY_TEXT;
  const safety={...sourceSafety,auditMissing:[...sourceSafety.missing],auditComplete:!sourceSafety.missing.length,
    sellabilityVerified:token.isHoneypot===false,policyVersion:'collective_source_checks_v1'};
  const required=new Set(['有效链和合约地址','有效可用余额与流动性对应的滚仓预算','可用余额及流动性额度须足够固定 10 U',
    '两分钟内的真实行情','有效正数价格','五秒内的独立报价','真实流动性','真实成交量','内外盘来源冲突待核对']);
  const missing=[...safety.missing,...base.missing.filter(s=>required.has(s))],reasons=[...safety.blocked];
  if(!valid)missing.push(burst?'内盘相邻窗口逐笔放量和分散净买':single?'事前核验盈利地址的新鲜净买':'三组已核实盈利钱包的新鲜净买共振');
  if(!['internal','near_completion','external'].includes(v.marketStage))missing.push('已核实内外盘阶段');
  if(internalOnlySignal(version)&&!['internal','near_completion'].includes(v.marketStage))missing.push('地址/放量快线仅允许已核实内盘');
  const internal=['internal','near_completion'].includes(v.marketStage);
  const needsDepth=internal&&(!!internalDepthProposal||!(v.liquidity>=20000)||v.costAssumptions.estimatedRoundTripCostRate>.05);
  const depthCheck=needsDepth?internalDepthCheck(internalDepth,base.token,base.entryUsd,nowMs,collectiveSignal,v.costAssumptions.notionalUsd):null;
  if(needsDepth&&!depthCheck.ready)missing.push('等待真实订单曲线深度');
  if(!(v.liquidity>=20000)&&!needsDepth)reasons.push('流动性低于 $20,000');
  if(!(v.volume.value>0))reasons.push('等待真实成交量');
  if(!(base.entryUsd>=1))reasons.push('可用模拟预算不足');
  const costGate=paperCostGate(v.costAssumptions,{internalDepthReady:valid&&needsDepth&&depthCheck.ready});
  if(costGate.reason&&!(needsDepth&&!depthCheck.ready&&v.costAssumptions.estimatedRoundTripCostRate<=.15))
    (costGate.needsStructure?missing:reasons).push(costGate.reason);
  const confirmation=collectiveQuote(quoteHistory,base.token,collectiveSignal,nowMs);
  if(!confirmation.ready)missing.push(confirmation.reason);
  const eligible=!missing.length&&!reasons.length,label=onchain?'内盘链上普通地址放量':burst?'内盘逐笔放量快线':single?'内盘预核验地址快线':'集体聪明钱算法信号';
  return {...base,label,decision:safety.blocked.length?'不买':eligible?'可模拟':'观察',
    score:Math.max(0,100-missing.length*10-reasons.length*15),missing:[...new Set(missing)],
    reasons:eligible?[burst?'逐笔成交加速、分散净买与新鲜报价通过，等待账本复核':single?'事前盈利资格、内盘净买与新鲜报价通过，等待账本复核':'三组盈利画像、短窗净买入与新鲜报价通过，等待账本边界复核']:[...new Set(reasons)],
    entryLogic:entryText,exitLogic:MEME_EXIT_TEXT,
    evidence:{...v,...(needsDepth?{internalDepth:internalDepth?structuredClone(internalDepth):null,internalDepthCheck:depthCheck}:{}),collectiveSignal:structuredClone(collectiveSignal),costGate,paperEligible:eligible,safety,accountPolicy:paperOperatingPolicy(true),
      entryPlan:{version:STRATEGY_ANALYSIS_VERSION,confirmedPolicyVersion:CONFIRMED_PAPER_VERSION,entryPolicyVersion:version,
        eligible,setup:label,entryZone:{low:base.token.price,high:base.token.price},stopPrice:null,targetPrice:null,
        targetRole:'structure_reference_only',stopRole:'none',targetKind:'钱包信号不虚构目标价',exitPolicyVersion:v.exitPolicy.version,
        confirmedAt:confirmation.confirmedAt||null,netRewardRisk:null,estimatedStopLossUsd:null,summary:entryText},
      confirmedPolicy:{version:CONFIRMED_PAPER_VERSION,lossResponseVersion:LOSS_RESPONSE_VERSION,pulse:null,confirmation},
      opportunity:{version:'multi_setup_v2',reviewVersion:OPPORTUNITY_REVIEW_VERSION,entryPolicyVersion:version,
        id:walletSignalRoute(collectiveSignal),label,basis:'wallet_signal',signalId:collectiveSignal?.id||null,
        signalAt:Date.parse(collectiveSignal?.sourceAt)||null,signalReady:valid}}};
}
