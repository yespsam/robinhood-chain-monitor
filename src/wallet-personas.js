export const PERSONA_CATALOG = Object.freeze([
  { id: 'ultrafast', label: '超短快进快出', strength: '观察到较短资金占用，可研究及时退出习惯', weakness: '收益可能高度依赖抢跑、费用与延迟；目前不复制这种速度', adoptable: false },
  { id: 'short_cycle', label: '短线轮动', strength: '可测试限时退出，减少无效等待', weakness: '交易频繁时费用侵蚀明显；持仓短不等于买点准确', adoptable: true },
  { id: 'intraday', label: '日内持仓', strength: '可测试更有耐心的持仓期限和亏损退出幅度', weakness: '持仓时间不能证明趋势判断能力，容易受盘中反转影响', adoptable: true },
  { id: 'swing', label: '跨日持仓', strength: '可研究跨日持有与退出纪律', weakness: '短窗口容易只看到已卖出的赢家；当前不据此延长系统持仓', adoptable: false },
  { id: 'scale_out', label: '分批兑现', strength: '观察到拆分卖出，可研究分段收回资金', weakness: '可能过早卖出强势资产；频繁分批也会增加成本', adoptable: true },
  { id: 'pyramid', label: '上涨加仓', strength: '观察到更高价格继续买入，可研究确认后加仓', weakness: '加仓价上升并不能证明趋势确认，可能是高位追涨；暂不自动加仓', adoptable: false },
  { id: 'average_down', label: '下跌补仓', strength: '可研究分批入场的价格分布', weakness: '下跌补仓会扩大下行敞口，不学习自动摊平亏损', adoptable: false },
  { id: 'profit_asymmetry', label: '大盈小亏样本', strength: '观察到盈利退出幅度相对更大，可测试亏损退出纪律', weakness: '仅是已配对卖出的毛收益，可能漏掉未卖出亏损，不等于正净期望', adoptable: true },
]);
const ratio = (a, b) => b > 0 ? a / b : null;
export function classifyWalletPersonas(h, { historyGap = false, lastError = null } = {}) {
  const sufficient = h.matchedSells >= 5 && h.matchedTokenCount >= 3;
  const labels = [];
  if (sufficient) {
    const tempo = h.tooFastSells / h.matchedSells >= .5 ? 'ultrafast' : h.medianHoldMs < 15 * 60000 ? 'short_cycle' : h.medianHoldMs < 86400000 ? 'intraday' : 'swing';
    labels.push(tempo);
    if (h.partialSells >= 3 && h.partialSells / h.matchedSells >= .25) labels.push('scale_out');
    if (h.adds >= 3 && h.risingAdds / h.adds >= .6) labels.push('pyramid');
    if (h.adds >= 3 && h.fallingAdds / h.adds >= .6) labels.push('average_down');
    if (h.winningExits >= 3 && h.losingExits >= 3 && h.medianWinningExit >= Math.abs(h.medianLosingExit) * 2) labels.push('profit_asymmetry');
  }
  const drawbacks = [];
  if (!sufficient) drawbacks.push('可配对卖出或代币种类不足，暂不定型');
  if (historyGap) drawbacks.push('活动页存在未补齐缺口，禁止训练');
  if (lastError) drawbacks.push('本钱包采样待恢复，禁止训练');
  if (h.excludedTokens > 0) drawbacks.push(`${h.excludedTokens} 个代币买卖无法完整归因`);
  if (h.tooFastSells > 0) drawbacks.push(`${h.tooFastSells} 笔持仓不足 30 秒，不纳入蒸馏`);
  if (h.buyCount >= 10 && h.buySizeP90P10 >= 4) drawbacks.push('买入金额差异超过四倍，不照搬仓位规模');
  if (h.buyTokenCount >= 3 && h.largestTokenBuyShare >= .5) drawbacks.push('观察窗口内单一代币占买入金额至少一半，存在集中暴露');
  if (h.winningExits >= 3 && h.losingExits >= 3 && Math.abs(h.medianLosingExit) > h.medianWinningExit * 1.5) drawbacks.push('已配对样本亏损退出幅度偏大，不能凭胜率模仿');
  return { status: sufficient ? 'observed' : 'insufficient', confidence: !historyGap && !lastError && h.matchedSells >= 20 && h.matchedTokenCount >= 5 && h.observedSpanMs >= 3 * 86400000 ? '较充分的描述样本' : '初步观察',
    labels: labels.map(id => PERSONA_CATALOG.find(p => p.id === id)), drawbacks,
    metrics: { matchedTokens: h.matchedTokenCount, spanMs: h.observedSpanMs, partialSellRate: ratio(h.partialSells, h.matchedSells),
      risingAddRate: ratio(h.risingAdds, h.adds), fallingAddRate: ratio(h.fallingAdds, h.adds),
      buySizeP90P10: h.buySizeP90P10, largestTokenBuyShare: h.largestTokenBuyShare },
    unknown: ['真实买点与行情环境', '钱包是否同一控制人', '未卖出亏损与全账户回撤', '可复制的净收益'] };
}
