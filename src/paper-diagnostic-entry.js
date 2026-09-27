import { STRATEGY_ANALYSIS_VERSION, priceText } from './paper-strategy-analysis.js';

export const PAPER_DIAGNOSTIC_ENTRY_VERSION = 'paper_diagnostic_entry_v1';
// These are modelling/data boundaries, not investment screening thresholds.
const requiredFields = new Set(['有效链和合约地址', '有效可用余额与流动性对应的滚仓预算',
  '两分钟内的真实行情', '有效正数价格', '五秒内的独立报价', '十五秒内的独立报价',
  '真实流动性', '真实成交量', '买入税', '卖出税']);
const impossibleFills = new Set(['存在貔貅标记', '可卖出检测未通过', '禁止卖出', '黑名单', '池子真实性异常', '流动性为零']);

export function diagnosticPaperEntry(row, sourceSafety) {
  const v = row.evidence, price = row.token.price, costs = v.costAssumptions;
  const missing = row.missing.filter(field => requiredFields.has(field));
  const blocked = [...new Set([...sourceSafety.blocked.filter(field => impossibleFills.has(field)),
    ...(sourceSafety.taxFilter?.reasons || [])])];
  const reasons = [];
  if (!v.flowFresh) missing.push('完整且新鲜的买入资金流');
  if (!Number.isInteger(v.flow.uniqueBuyerCount) || v.flow.uniqueBuyerCount < 1
    || !Number.isFinite(v.flow.netBuyUsd) || v.flow.netBuyUsd <= 0) reasons.push('等待至少一个真实净买家与正净流入');
  if (!(v.liquidity > 0)) missing.push('真实流动性');
  if (!(v.volume.value > 0)) reasons.push('等待真实正成交量');
  if (!(costs.notionalUsd > 0) || !Number.isFinite(costs.estimatedRoundTripCostRate)
    || costs.feeRate + costs.slippageRate + costs.sellTax >= 1) reasons.push('当前余额和税费无法形成有效模拟仓位');
  const eligible = !missing.length && !blocked.length && !reasons.length;
  const stopPrice = price > 0 ? price * .95 : null;
  const targetPrice = price > 0 ? price * 1.5 : null;
  const quantity = price > 0 ? costs.notionalUsd / price : null;
  const netAt = p => quantity * p * (1 - costs.feeRate - costs.slippageRate - costs.sellTax) - costs.gasUsd;
  const loss = quantity > 0 ? row.entryUsd - netAt(stopPrice) : null;
  const gain = quantity > 0 ? netAt(targetPrice) - row.entryUsd : null;
  const warnings = [...new Set([...sourceSafety.missing, ...sourceSafety.blocked.filter(field => !blocked.includes(field))])];
  const baseline = { decision: row.decision, missing: [...row.missing], reasons: [...row.reasons], entryPlan: structuredClone(v.entryPlan) };
  const entryPlan = { version: STRATEGY_ANALYSIS_VERSION, diagnosticVersion: PAPER_DIAGNOSTIC_ENTRY_VERSION,
    eligible, setup: '真实净买入诊断试单', reasons: [...blocked, ...reasons], entryZone: price > 0 ? { low: price, high: price } : null,
    stopPrice, targetPrice, targetKind: '1.5 倍仅为成本情景，不是阻力位、预测或入场门槛',
    targetRole: 'structure_reference_only', exitPolicyVersion: v.exitPolicy.version,
    netRewardRisk: loss > 0 && gain > 0 ? gain / loss : null, estimatedStopLossUsd: loss,
    confirmedAt: row.observedAt, summary: `按五秒内独立参考价试单；诊断止损 ${priceText(stopPrice)}。不要求 K 线形态或 1.5 盈亏比。` };
  return { ...row, label: '诊断试仓', decision: blocked.length ? '不买' : eligible ? '可模拟' : '观察',
    missing: [...new Set(missing)], reasons: eligible ? ['真实净买入与独立报价满足诊断试单条件；不代表原策略通过'] : [...blocked, ...reasons],
    score: blocked.length ? 0 : Math.max(0, 100 - missing.length * 10 - reasons.length * 15),
    entryLogic: `模拟诊断试仓：至少一个真实净买家、正净流入、真实行情及五秒内独立参考价；按余额 2% 小额试单。K 线形态、聪明钱人数、叙事、集中度等筛选只记录，不拦截；不标为审计通过。${entryPlan.summary}${warnings.length ? ` 未通过或未核实字段：${warnings.join('、')}。` : ''}`,
    exitLogic: '诊断止损 5%；45 秒仍无成本后盈利则退出；主仓最长 3 分钟，继续走强才留最多 20% 尾仓；使用新鲜观察价，费用和滑点为模型。',
    evidence: { ...v, paperEligible: eligible, entryPlan,
      diagnostic: { version: PAPER_DIAGNOSTIC_ENTRY_VERSION, baseline, warnings, chartRequired: false, riskScreeningRequired: false,
        fillBoundariesPass: blocked.length === 0 && !missing.some(field => ['买入税', '卖出税', '真实流动性'].includes(field)) },
      entryThresholds: { minBuyers: 1, minNetBuy: Number.MIN_VALUE, minHighProfit: 0, minSmartMoney: 0, minLiquidity: Number.MIN_VALUE } } };
}

export const isDiagnosticPaperEntry = evidence => evidence?.diagnostic?.version === PAPER_DIAGNOSTIC_ENTRY_VERSION
  && evidence.entryPlan?.diagnosticVersion === PAPER_DIAGNOSTIC_ENTRY_VERSION && evidence.entryTier === 'exploratory';
