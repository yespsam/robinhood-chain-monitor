import {ALPHA_ENTRY_VERSION, validAlphaSignal} from './binance-alpha-catalog.js';
import {CONFIRMED_PAPER_VERSION,LOSS_RESPONSE_VERSION,paperOperatingPolicy} from './paper-confirmed-policy.js';
import {STRATEGY_ANALYSIS_VERSION} from './paper-strategy-analysis.js';
import {OPPORTUNITY_REVIEW_VERSION} from './paper-opportunity-review.js';
import {MEME_EXIT_TEXT} from './paper-meme-exit.js';
import {traderDecision} from './paper-trader-reasoning.js';
import {monitoredPaperSafety} from './paper-safety-policy.js';

export function confirmAlphaQuotes(history,token,signal,nowMs) {
  const rows=[],times=new Map();
  for(const q of history||[]){
    const at=Date.parse(q.observedAt);
    if(q.status!=='ok'||q.chain!==token.chain||q.address!==token.address||!Number.isFinite(q.price)||q.price<=0
      ||!Number.isFinite(at)||at>nowMs||nowMs-at>15000||at<signal.listingTime)continue;
    if(times.has(at)){if(times.get(at)!==q.price)return {ready:false,reason:'同时间报价存在冲突'};continue;}
    times.set(at,q.price);rows.push({price:q.price,observedAt:q.observedAt,at});
  }
  rows.sort((a,b)=>a.at-b.at);
  const fast=nowMs-signal.listingTime<=300000,last=rows.at(-1),first=rows[0];
  if(!last||nowMs-last.at>5000||last.price!==token.price||!fast&&(rows.length<2||last.at-first.at<3000))
    return {ready:false,reason:'连续新鲜报价确认',count:rows.length};
  // Follow-through is explicitly not a replay of the launch. No candle-pattern,
  // 3%-volatility, fixed-profit or 6%-stop-distance prerequisite on this route.
  const ready=fast||last.price>first.price&&last.price>=rows.at(-2).price;
  return {version:'alpha_quotes_v1',ready,reason:ready?null:'上新后报价尚未重新走强',count:rows.length,
    phase:fast?'launch':'follow_through',confirmedAt:last.observedAt,rows:rows.map(({at,...r})=>r)};
}

export function alphaPaperEntry(base,{alphaSignal,sourceSafety,quoteHistory,token:rawToken,nowMs}) {
  const v=base.evidence,valid=validAlphaSignal(alphaSignal,base.token,nowMs);
  const safety=monitoredPaperSafety(rawToken,sourceSafety,valid),warnings=safety.warnings;
  for(const [field,label] of [['cannotSell','明确不可卖出'],['isBlacklisted','黑名单标记'],['canMint','保留增发权限'],
    ['canFreeze','保留冻结权限'],['canPause','保留暂停权限'],['fakePool','假池标记']])
    if([true,1,'1','true'].includes(rawToken?.[field]))safety.blocked.push(label);
  const required=new Set(['有效链和合约地址','有效可用余额与流动性对应的滚仓预算','可用余额及流动性额度须足够固定 10 U',
    '两分钟内的真实行情','有效正数价格','五秒内的独立报价','真实流动性','真实成交量','内外盘来源冲突待核对']);
  const missing=[...safety.missing,...base.missing.filter(x=>required.has(x))],reasons=[...safety.blocked];
  if(!valid)missing.push('有效且新鲜的官方 Alpha 上新事件');
  if(!(v.liquidity>=20000))reasons.push('流动性低于 $20,000');
  if(!(v.volume.value>0))reasons.push('等待真实成交量');
  const costs=v.costAssumptions;
  if(!(costs.notionalUsd>0)||!Number.isFinite(costs.estimatedRoundTripCostRate)||costs.estimatedRoundTripCostRate>.05)
    reasons.push('预计往返成本超过 5%，停止小额磨损');
  if(!(base.entryUsd>=1))reasons.push('可用模拟预算不足');
  const confirmation=valid?confirmAlphaQuotes(quoteHistory,base.token,alphaSignal,nowMs):{ready:false,reason:'连续新鲜报价确认'};
  if(!confirmation.ready)(confirmation.reason==='连续新鲜报价确认'?missing:reasons).push(confirmation.reason);
  const eligible=!missing.length&&!reasons.length,fast=valid&&nowMs-alphaSignal.listingTime<=300000;
  const label=fast?'Alpha 刚上新快线':'Alpha 上新后跟随';
  const entryLogic=`${label}：官方目录确认 ${base.token.symbol} 的链和 CA；上新时间 ${valid?new Date(alphaSignal.listingTime).toISOString():'待核对'}。`
    +(fast?'五分钟内事件可用一次五秒内独立报价试仓，不等待完整 K 线或聪明钱标签。':'五分钟至二十四小时只做当前行情跟随，至少两次独立报价跨三秒且重新走强；不补造上新时成交。')
    +'不要求普通趋势形态、固定涨跌幅或历史目标位盈亏比；缺失审计字段保留未知、不拦截本模拟入口。保留真实行情、余额、税费、明确不可交易标记与模型成本检查。催化是新增交易入口和关注度，不代表必有买盘或盈利。'
    +(warnings.includes('打包买入占比超过筛选线')?` 打包买入占比 ${(safety.metrics.bundlerRate*100).toFixed(2)}%，仅在本事件模拟入口记录观察，不作为不可卖出的证明，也不标记为低风险。`:'');
  const row={...base,label,decision:safety.blocked.length?'不买':eligible?'可模拟':'观察',
    score:Math.max(0,100-missing.length*10-reasons.length*15),missing:[...new Set(missing)],
    reasons:eligible?[`${label}：官方事件、独立报价和成本检查通过`]:[...new Set(reasons)],entryLogic,exitLogic:MEME_EXIT_TEXT,
    evidence:{...v,paperEligible:eligible,safety,
      accountPolicy:paperOperatingPolicy(true),
      entryPlan:{version:STRATEGY_ANALYSIS_VERSION,confirmedPolicyVersion:CONFIRMED_PAPER_VERSION,entryPolicyVersion:ALPHA_ENTRY_VERSION,
        eligible,setup:label,entryZone:{low:base.token.price,high:base.token.price},stopPrice:null,targetPrice:null,
        targetRole:'structure_reference_only',stopRole:'none',targetKind:'事件入口不虚构价格目标',
        exitPolicyVersion:v.exitPolicy.version,confirmedAt:confirmation.confirmedAt||null,netRewardRisk:null,estimatedStopLossUsd:null,summary:entryLogic},
      confirmedPolicy:{version:CONFIRMED_PAPER_VERSION,lossResponseVersion:LOSS_RESPONSE_VERSION,pulse:null,confirmation},
      opportunity:{version:'multi_setup_v2',reviewVersion:OPPORTUNITY_REVIEW_VERSION,entryPolicyVersion:ALPHA_ENTRY_VERSION,
        id:'alpha_listing',label,basis:'official_event',signalId:alphaSignal?.id||null,signalAt:alphaSignal?.listingTime||null,
        signalReady:valid,phase:fast?'launch':'follow_through',event:structuredClone(alphaSignal||null)}}};
  if(eligible)row.evidence.traderDecision=traderDecision(row,nowMs);
  return row;
}
