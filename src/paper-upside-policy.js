// Versioned paper-only exit rules. Multiples are conditional sell triggers,
// never price predictions. Keep this version immutable for persisted holdings.
export const UPSIDE_EXIT_POLICY = Object.freeze({
  version: 'asymmetric_upside_v1', mode: 'upside', label: '大行情优先',
  profitTiers: Object.freeze([3, 10, 30].map(multiple => Object.freeze({ multiple, fraction: .2 }))),
  runnerFraction: .4, protectionActivation: 2, trailingActivation: 3,
  trailingBands: Object.freeze([
    Object.freeze({ multiple: 3, drawdown: .45 }),
    Object.freeze({ multiple: 10, drawdown: .35 }),
    Object.freeze({ multiple: 30, drawdown: .25 }),
  ]),
  strongPeakMultiple: 1.5, strongCurrentMultiple: 1.25, runnerHoldMs: 7 * 24 * 60 * 60_000,
});

export function validUpsideExitPolicy(value) {
  return !!value && Object.keys(value).length === Object.keys(UPSIDE_EXIT_POLICY).length
    && Object.entries(UPSIDE_EXIT_POLICY).every(([key, expected]) => JSON.stringify(value[key]) === JSON.stringify(expected));
}

export function upsidePositionPolicy(position, base) {
  const profile = position.upsidePolicy;
  if (!profile) return base;
  const peakMultiple = position.peakPrice / position.entryPrice;
  const band = profile.trailingBands.filter(item => peakMultiple >= item.multiple).at(-1) || profile.trailingBands[0];
  return { ...base, profitTiers: profile.profitTiers, trailingActivation: profile.trailingActivation,
    trailingStop: band.drawdown, runnerHoldMs: profile.runnerHoldMs };
}

export function upsideExitText(stopPriceText, stopLoss, maxHoldMs) {
  return `大行情优先：结构止损 ${stopPriceText}，硬止损上限 ${Math.round(stopLoss * 100)}%；不在小幅结构目标减仓。达到 3 / 10 / 30 倍各兑现原仓 20%，留 40% 趋势尾仓，不设固定倍数清仓。曾到 2 倍后保护剩余本金与模型成本；3 倍起峰值回撤 45%，10 倍起 35%，30 倍起 25% 退出，止损只上移。初始弱势观察 ${maxHoldMs / 60000} 分钟；曾达 1.5 倍且现价仍 ≥ 1.25 倍，或已分档兑现，延长至开仓后最多 7 天。完整资金流连续两次确认聪明钱撤退仍退出。倍数是条件规则，不是收益预测。`;
}
