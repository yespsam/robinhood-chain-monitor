// Paper-only admission. Cost assumptions remain fully charged to the ledger;
// passing this gate is not a forecast, a router quote, or permission to trade.
import { GAS_ACCOUNT_ONLY } from './paper-chain-gas.js';
export const STRUCTURE_COST_POLICY_VERSION = 'structure_net_cost_v1';
export const LEGACY_MAX_COST_RATE = .05;
export const MAIN_STRUCTURE_MAX_COST_RATE = .15;
export const STRUCTURE_COST_TEXT = '主盘外盘按扣费后的结构空间判断，不以 5% 模型成本一刀切；保留 15% 总成本上限，结构净盈亏比至少 1.2，参考涨幅至少覆盖保本涨幅的 1.5 倍。结构只是情景估算，不是收益预测或实际路由报价。';
export const GAS_ACCOUNT_ONLY_TEXT = 'Gas 按链上已成交样本估算并扣账，不因 Gas 占比高否决买入；税费、滑点与平台费仍检查。样本不是本订单的真实路由费用，净收益可能不足覆盖 Gas。';

// This view is ONLY for admission. It must never replace actual accounting
// costs in a position or ledger. Gas is fully charged by the engine.
export function admissionCosts(costs,budget) {
  if(costs?.gasAdmissionPolicy!==GAS_ACCOUNT_ONLY)return costs;
  const notionalUsd=budget/(1+costs.feeRate+costs.slippageRate+costs.buyTax);
  const estimatedRoundTripCost=budget-notionalUsd+notionalUsd*(costs.feeRate+costs.slippageRate+costs.sellTax);
  return {...costs,gasUsd:0,notionalUsd,estimatedRoundTripCost,estimatedRoundTripCostRate:estimatedRoundTripCost/budget};
}

export function paperCostGate(costs, { structureMain = false, economics = null, internalDepthReady = false } = {}) {
  if (costs?.gasEvidenceReady === false) return { ready: false, needsStructure: true, reason: '等待新鲜链上 Gas 费用样本', source: 'assumption', estimatedRate: null };
  const rate = admissionCosts(costs,costs?.budgetUsd)?.estimatedRoundTripCostRate;
  const valid = Number.isFinite(rate) && rate >= 0 && Number.isFinite(costs?.notionalUsd) && costs.notionalUsd > 0;
  const maximumRate = structureMain || internalDepthReady ? MAIN_STRUCTURE_MAX_COST_RATE : LEGACY_MAX_COST_RATE;
  const reason = !valid ? '往返成本数据无效，等待重新估算'
    : rate > maximumRate ? structureMain || internalDepthReady ? '预计往返成本超过 15%，停止高磨损试仓' : '预计往返成本超过 5%，停止小额磨损'
      : structureMain && economics?.ready !== true ? '等待新鲜结构验证扣费后的空间' : null;
  return { version: costs?.gasAdmissionPolicy===GAS_ACCOUNT_ONLY?GAS_ACCOUNT_ONLY:internalDepthReady?'internal_depth_cost_v1':structureMain ? STRUCTURE_COST_POLICY_VERSION : 'fixed_cost_cap_v1',
    source: costs?.source || null, estimatedRate: costs?.estimatedRoundTripCostRate??null, admissionRate:Number.isFinite(rate)?rate:null,
    gasExcludedFromAdmission:costs?.gasAdmissionPolicy===GAS_ACCOUNT_ONLY,
    maximumRate, legacyThresholdExceeded: valid && rate > LEGACY_MAX_COST_RATE,
    ready: !reason, reason, needsStructure: structureMain && valid && rate <= maximumRate && economics?.ready !== true };
}
