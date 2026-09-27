// Paper-only, immutable versioned rules. Legacy positions retain their profile.
export const PVP_EXIT_POLICY = Object.freeze({
  version: 'fast_pvp_v1', mode: 'pvp', label: '短线 PVP',
  noFollowThroughMs: 45_000, coreHoldMs: 180_000, runnerHoldMs: 1_200_000,
  runnerFraction: .2, strongCurrentMultiple: 1.15, strongPeakRatio: .96,
  protectionActivation: 1.15, trailingActivation: 1.15, trailingStop: .12,
  entryQuoteMaxAgeMs: 5000, exitQuoteMaxAgeMs: 15_000,
  profitTiers: Object.freeze([Object.freeze({ multiple: 2, fraction: .5 }), Object.freeze({ multiple: 3, fraction: .3 })]),
});

export const CONFIRMED_PVP_EXIT_POLICY = Object.freeze({ ...PVP_EXIT_POLICY, version: 'confirmed_pvp_exit_v2',
  label: '确认型 PVP', noFollowThroughMs: 120_000, coreHoldMs: 300_000 });

// New paper entries only. Null means no clock-based liquidation, not zero.
// Price/cost protection, fresh-quote requirements and confirmed flow exits stay on.
export const EVIDENCE_HOLD_EXIT_POLICY = Object.freeze({ ...CONFIRMED_PVP_EXIT_POLICY,
  version: 'evidence_hold_v1', label: '证据驱动持仓',
  noFollowThroughMs: null, coreHoldMs: null, runnerHoldMs: null });
export const STRUCTURE_HOLD_EXIT_POLICY = Object.freeze({ ...EVIDENCE_HOLD_EXIT_POLICY,
  version:'structure_hold_v2', label:'结构复核持仓',
  profitTiers:Object.freeze([Object.freeze({multiple:2,fraction:.3}),Object.freeze({multiple:3,fraction:.3})]) });
export const isEvidenceHold = policy => [EVIDENCE_HOLD_EXIT_POLICY.version,STRUCTURE_HOLD_EXIT_POLICY.version].includes(policy?.version);
export const EVIDENCE_HOLD_TEXT = '不按 120 秒、5 分钟或 20 分钟到期退出。价格止损、剩余本金与成本保护、峰值回撤线及完整资金流连续反向确认仍生效；2 / 3 倍分别兑现原仓 50% / 30%，剩余尾仓无固定时限。数据缺失不等于逻辑有效或失效；没有新鲜报价不虚构成交。';

export const validPvpExitPolicy = value => {
  const reference = [PVP_EXIT_POLICY, CONFIRMED_PVP_EXIT_POLICY, EVIDENCE_HOLD_EXIT_POLICY, STRUCTURE_HOLD_EXIT_POLICY].find(p => p.version === value?.version);
  return !!reference && Object.keys(value).length === Object.keys(reference).length
    && Object.entries(reference).every(([key, expected]) => JSON.stringify(value[key]) === JSON.stringify(expected));
};

export function pvpPositionPolicy(position, base) {
  return position.pvpPolicy ? { ...base, ...position.pvpPolicy, maxHoldMs: position.pvpPolicy.coreHoldMs } : base;
}

export function pvpDecision(position, mark) {
  const p = position.pvpPolicy, costs = position.costAssumptions;
  // The engine still evaluates price protection and same-provider flow reversal.
  // Elapsed time, flat price, or missing data alone cannot manufacture a sell.
  if (isEvidenceHold(p)) return {};
  const elapsed = Date.parse(mark.observedAt) - Date.parse(position.openedAt);
  const remainingNetPnl = position.quantity * mark.price * (1 - costs.feeRate - costs.slippageRate - costs.sellTax)
    - costs.gasUsd - position.costBasisUsd;
  const previous = position.pvpLastQuote;
  const rising = previous && Date.parse(mark.observedAt) > Date.parse(previous.observedAt)
    && Date.parse(mark.observedAt) - Date.parse(previous.observedAt) <= p.exitQuoteMaxAgeMs && mark.price > previous.price;
  const strong = remainingNetPnl > 0 && mark.price >= position.entryPrice * p.strongCurrentMultiple
    && mark.price >= position.peakPrice * p.strongPeakRatio && rising;
  if (elapsed >= p.runnerHoldMs) return { exit: 'PVP 尾仓到期（开仓后 20 分钟）' };
  if (elapsed >= p.noFollowThroughMs && remainingNetPnl <= 0) {
    if (p.version !== CONFIRMED_PVP_EXIT_POLICY.version) return { exit: 'PVP 45 秒后仍无成本后盈利，撤退' };
    if (mark.price <= position.entryPrice) return { exit: '确认型 PVP 满 120 秒价格仍未走强，退出' };
  }
  if (!position.pvpRunnerStartedAt && elapsed >= p.coreHoldMs) return strong
    ? { trim: true } : { exit: `PVP 主仓 ${p.coreHoldMs / 60000} 分钟到期，未确认继续走强` };
  return {};
}

export function evidenceHoldStatus(position, nowMs) {
  const flow = position.exitStatus?.flowStatus || '资金流待确认';
  const pending = position.flowExitWatch?.count === 1;
  return { holdingMode: position.pvpRunnerStartedAt ? '趋势尾仓 · 按证据持有' : '主仓 · 按证据持有',
    holdLimitMs: null, timeExitEnabled: false, heldForMs: nowMs - Date.parse(position.openedAt),
    trailingDrawdown: position.pvpPolicy.trailingStop,
    holdReason: position.structureStatus?.reason || (pending ? '已观察到一次资金流反向，等待第二次独立确认；价格保护仍实时检查。'
      : `价格尚未触发退出线；${flow}。不因持仓时长自动卖出，也不将缺少反向证据当作趋势已确认。`) };
}

export function pvpExitText(stopPriceText, stopLoss) {
  return `短线 PVP：结构止损 ${stopPriceText}，硬止损上限 ${Math.round(stopLoss * 100)}%。45 秒后仍无扣成本盈利就退出；主仓最长 3 分钟，只有扣成本盈利、现价 ≥ 1.15 倍且距峰值不超过 4%、连续新鲜报价仍上涨才保留最多原仓 20%。2 / 3 倍分别兑现原仓 50% / 30%，剩余 20% 为尾仓。1.15 倍启动剩余本金与模型成本保护，并按峰值回撤 12% 退出；尾仓自开仓起最多 20 分钟。结构参考位不自动减仓；缺少新报价时等待，不虚构成交。倍数是条件，不是收益预测。`;
}
