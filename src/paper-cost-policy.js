// Paper-only admission. Cost assumptions remain fully charged to the ledger;
// passing this gate is not a forecast, a router quote, or permission to trade.
export const STRUCTURE_COST_POLICY_VERSION = 'structure_net_cost_v1';
export const LEGACY_MAX_COST_RATE = .05;
export const MAIN_STRUCTURE_MAX_COST_RATE = .15;
export const STRUCTURE_COST_TEXT = '主盘外盘按扣费后的结构空间判断，不以 5% 模型成本一刀切；保留 15% 总成本上限，结构净盈亏比至少 1.2，参考涨幅至少覆盖保本涨幅的 1.5 倍。结构只是情景估算，不是收益预测或实际路由报价。';

export function paperCostGate(costs, { structureMain = false, economics = null } = {}) {
  const rate = costs?.estimatedRoundTripCostRate;
  const valid = Number.isFinite(rate) && rate >= 0 && Number.isFinite(costs?.notionalUsd) && costs.notionalUsd > 0;
  const maximumRate = structureMain ? MAIN_STRUCTURE_MAX_COST_RATE : LEGACY_MAX_COST_RATE;
  const reason = !valid ? '往返成本数据无效，等待重新估算'
    : rate > maximumRate ? structureMain ? '预计往返成本超过 15%，停止高磨损试仓' : '预计往返成本超过 5%，停止小额磨损'
      : structureMain && economics?.ready !== true ? '等待新鲜结构验证扣费后的空间' : null;
  return { version: structureMain ? STRUCTURE_COST_POLICY_VERSION : 'fixed_cost_cap_v1',
    source: costs?.source || null, estimatedRate: Number.isFinite(rate) ? rate : null,
    maximumRate, legacyThresholdExceeded: valid && rate > LEGACY_MAX_COST_RATE,
    ready: !reason, reason, needsStructure: structureMain && valid && rate <= maximumRate && economics?.ready !== true };
}
