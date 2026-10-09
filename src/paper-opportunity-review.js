// Deterministic paper research, not a price forecast or an execution adapter.
import { admissionCosts } from './paper-cost-policy.js';
import { GAS_ACCOUNT_ONLY } from './paper-chain-gas.js';
export const OPPORTUNITY_REVIEW_VERSION = 'opportunity_review_v2';
export const MEME_STRUCTURE_ENTRY_VERSION = 'meme_structure_entry_v1';
export const REFERENCE_COST_VERSION = 'gmgn_reference_cost_v1';
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
export const ema = (rows, period) => rows.reduce((v,r,i) => i ? r.close*2/(period+1)+v*(1-2/(period+1)) : r.close, 0);
export function candleVolatility(rows) {
  const ranges = rows.slice(-15).map((r,i,a) => Math.max(r.high-r.low, i ? Math.abs(r.high-a[i-1].close) : 0, i ? Math.abs(r.low-a[i-1].close) : 0));
  return ranges.reduce((a,b)=>a+b,0)/ranges.length;
}

export function reviewStructurePattern(route, chart, price, pattern, { evidenceExit = false } = {}) {
  if (!chart.ready || !positive(price)) return pattern;
  const { rows, last } = chart, atr = candleVolatility(rows), recent = rows.slice(-30);
  const rangeHigh = Math.max(...recent.map(r=>r.high)), rangeLow = Math.min(...recent.map(r=>r.low));
  // Stops are anchored to a real recent low / reclaimed level, with a volatility
  // buffer. If that is too far away we wait; never invent a tighter stop.
  const anchor = route.id === 'external_breakout' ? pattern.resistance
    : Math.min(...rows.slice(-3).map(r=>r.low));
  const support = Math.min(anchor-atr*.5, price-atr*1.25);
  const priorResistance = rows.slice(0,-1).map(r=>r.high).filter(n=>n>price*1.005).sort((a,b)=>a-b)[0];
  const targetPrice = route.id === 'external_pullback' ? pattern.peak
    : priorResistance || Math.min(price*2, (route.id === 'external_breakout' ? pattern.resistance : price) + rangeHigh-rangeLow);
  let reason = pattern.reason;
  if (route.id === 'external_trend') {
    const separation = pattern.ema8/pattern.ema21-1, slope = pattern.ema8/pattern.priorEma8-1;
    if (!(separation >= Math.max(.002, atr/price*.15) && slope >= Math.max(.0003, atr/price*.03)
      && pattern.volumeMultiple >= 1.2 && last.close > last.open)) reason = '均线差、斜率或放量不足，弱趋势只观察';
  }
  if (!(support>0 && support<price)) reason = '真实结构参考位无效或现价已失守';
  else if (!evidenceExit && support<price*.94) reason = '真实结构加波动缓冲超过 6%，等待更好买点';
  return { ...pattern, reviewVersion:OPPORTUNITY_REVIEW_VERSION, ready:pattern.ready && !reason, reason,
    atr, rangeHigh, rangeLow, support, targetPrice,
    targetKind:priorResistance || route.id==='external_pullback' ? '已观察历史压力位，非保证可达' : '已观察区间幅度投影，非收益预测',
    reclaimPrice: route.id==='external_breakout' ? pattern.resistance : route.id==='external_pullback' ? chart.previous.high : pattern.ema8 };
}

export function structureEconomics(pattern, price, costs, budget) {
  const quantity=positive(price)&&positive(costs?.notionalUsd) ? costs.notionalUsd/price : 0;
  const retention=1-costs.feeRate-costs.slippageRate-costs.sellTax;
  const breakEvenPrice=quantity>0 && retention>0 ? (budget+costs.gasUsd)/(quantity*retention) : null;
  const loss=quantity>0 ? budget-(quantity*pattern.support*retention-costs.gasUsd) : null;
  const gain=quantity>0 ? quantity*pattern.targetPrice*retention-costs.gasUsd-budget : null;
  const netRewardRisk=loss>0 && gain>0 ? gain/loss : null;
  const ready=positive(breakEvenPrice) && positive(pattern.targetPrice) && pattern.targetPrice>price
    && pattern.targetPrice/price-1 >= (breakEvenPrice/price-1)*1.5 && netRewardRisk>=1.2;
  const actual={version:OPPORTUNITY_REVIEW_VERSION,ready,breakEvenPrice,breakEvenRate:positive(breakEvenPrice)?breakEvenPrice/price-1:null,
    estimatedStopLossUsd:loss,netRewardRisk,netReferenceGainUsd:gain,
    reason:ready?null:'已观察结构空间不足以覆盖往返成本及失效损失，继续观察'};
  if(costs.gasAdmissionPolicy===GAS_ACCOUNT_ONLY) {
    const admission=structureEconomics(pattern,price,{...admissionCosts(costs,budget),gasAdmissionPolicy:null},budget);
    return {...actual,ready:admission.ready,reason:admission.reason,actualCostEconomicsReady:actual.ready,
      gasAdmissionPolicy:GAS_ACCOUNT_ONLY,admission};
  }
  return actual;
}

// Two distinct CLOSED post-entry bars, plus a fresh current quote, must agree.
// Repeated evaluation of the same candle cannot manufacture confirmation.
export function assessStructureHold(position, chart, mark) {
  if (position.entryEvidence?.opportunity?.reviewVersion !== OPPORTUNITY_REVIEW_VERSION) return null;
  if (!chart?.ready || chart.chain!==position.chain || chart.address!==position.address) return {status:'unavailable',reason:'持仓 K 线待刷新；缺失不代表趋势有效或失效'};
  const {rows,last,previous}=chart, opened=Date.parse(position.openedAt), opportunity=position.entryEvidence.opportunity;
  if (previous.time+60000<=opened || last.time+60000>Date.parse(mark.observedAt)) return {status:'warming',reason:'等待入场后的两根独立收盘线'};
  const fast=ema(rows,8),slow=ema(rows,21),priorSlow=ema(rows.slice(0,-1),21);
  const level=opportunity.pattern.reclaimPrice;
  const failed=opportunity.id==='external_trend'
    ? last.close<slow && previous.close<priorSlow && fast<slow && mark.price<slow
    : positive(level) && last.close<level && previous.close<level && mark.price<level;
  return {status:failed?'invalidated':'holding',closedAt:last.time+60000,ema8:fast,ema21:slow,
    reason:failed ? `${opportunity.label}：连续两根入场后收盘线失守${opportunity.id==='external_trend'?'趋势均线':'收复位'}，买入依据失效`
      : '新鲜收盘结构尚未确认失效；继续检查结构、报价与资金流', exit:failed};
}
