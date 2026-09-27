// Versioned exit-only experiment. Never authorizes entries or wallet execution.
import { opportunityChart } from './paper-opportunity-policy.js';
import { ema } from './paper-opportunity-review.js';
import { assessPaperNarrative } from './paper-strategy-analysis.js';
import { gmgnFlowAddress } from './gmgn-flow-signal.js';

export const THESIS_EXIT_VERSION = 'volume_structure_exit_v1';
export const THESIS_EXIT_POLICY = Object.freeze({ version: THESIS_EXIT_VERSION, mode: 'paper_exit_comparison',
  fixedStop: false, fixedProfitTiers: false, trailingPercent: false, timeExit: false,
  exitQuoteMaxAgeMs: 15000, closedBarMaxAgeMs: 90000,
  breakdownBars: 2, persistenceBars: 3, sellVolumeMultiple: 1.2,
  distributionVolumeMultiple: 2, distributionUpperWick: .45, flowConfirmationMs: 30000,
  minNetSellUsd: 250, entryFlowReversalFraction: .5, minSmartSellers: 2 });
export const THESIS_EXIT_TEXT = '独立退出实验：取消固定百分比止损、倍数止盈和百分比回撤线。放量失守关键位、连续三根收盘失守、放量长上影后跌破，或完整同源聪明钱持续净卖出时退出；喊单仅作经来源校验的背景，不覆盖失效证据。无固定持仓期限。缺失数据记为待确认，不编造成交；没有固定最大亏损保证。';
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const at = value => typeof value === 'number' ? value : Date.parse(value || '');
const fresh = (value, now, age) => Number.isFinite(at(value)) && at(value) <= now && now - at(value) <= age;
const key = token => `${token?.chain}:${gmgnFlowAddress(token?.chain, token?.address)}`;
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
export const validThesisPolicy = value => !!value && Object.keys(value).length === Object.keys(THESIS_EXIT_POLICY).length
  && Object.entries(THESIS_EXIT_POLICY).every(([k, v]) => value[k] === v);

export function assessThesisExit(position, mark, nowMs, { referenceLevel = null, referenceKind = null } = {}) {
  const p = THESIS_EXIT_POLICY, opened = at(position.openedAt), observed = at(mark?.observedAt);
  if (!validThesisPolicy(position.exitExperiment) || key(mark) !== key(position)
    || mark?.status !== 'ok' || !positive(mark.price) || !fresh(observed, nowMs, p.exitQuoteMaxAgeMs) || observed <= opened) {
    return { version: p.version, status: 'unavailable', exit: false, reason: '等待绑定此 CA 的新鲜持仓报价', flowWatch: null };
  }
  const narrative = assessPaperNarrative({ narrative: mark.narrative || {}, chain: position.chain, address: position.address, nowMs: observed });
  const sentiment = { status: narrative.eligible ? 'sourced_context' : 'unverified',
    independentSources: narrative.independentSourceCount, phase: narrative.phase, quality: narrative.quality,
    gaps: narrative.gaps, sources: narrative.sources.slice(0, 3).map(s => ({ sourceUrl: s.sourceUrl, sourceAt: s.sourceAt, authorLabel: s.authorLabel })),
    meaning: '已校验喊单出处不等于真实利好；不从提及数量推导看涨情绪，不覆盖量价或卖盘失效信号' };
  const flow = mark.flow, provider = position.entryEvidence?.flowDiagnostics?.provider || 'gmgn';
  const usable = flow && key(flow) === key(position) && (flow.provider || 'gmgn') === provider
    && flow.complete === true && flow.fresh === true && ['ok', 'healthy'].includes(flow.status) && !flow.coverageGap
    && fresh(flow.observedAt, observed, 120000) && at(flow.observedAt) > opened
    && Number.isFinite(flow.netBuyUsd) && Number.isInteger(flow.smartMoneySellerCount);
  const reversed = usable && flow.netBuyUsd <= -Math.max(p.minNetSellUsd, (position.entryEvidence?.flow?.netBuyUsd || 0) * p.entryFlowReversalFraction) && flow.smartMoneySellerCount >= p.minSmartSellers;
  let flowWatch = null;
  if (reversed) {
    const previous = position.thesisFlowWatch, stamp = at(flow.observedAt);
    flowWatch = previous?.provider === provider && stamp >= at(previous.lastAt) && stamp - at(previous.lastAt) <= 120000
      ? { ...previous } : { provider, count: 1, firstAt: flow.observedAt, lastAt: flow.observedAt };
    if (stamp > at(flowWatch.lastAt) && stamp - at(flowWatch.firstAt) >= p.flowConfirmationMs) {
      flowWatch.count = 2; flowWatch.lastAt = flow.observedAt;
    }
  }
  const result = { version: p.version, status: 'observing', exit: false, checkedAt: mark.observedAt, sentiment, flowWatch,
    flow: { usable: !!usable, reversed: !!reversed, provider, netBuyUsd: usable ? flow.netBuyUsd : null,
      sellerCount: usable ? flow.smartMoneySellerCount : null }, reason: '量价退出证据待确认；不把缺失当成趋势有效' };
  if (flowWatch?.count === 2) return { ...result, status: 'invalidated', exit: true, reason: '同源完整资金流两次确认聪明钱净卖出，买入依据失效' };
  const source = mark.structureChart;
  const chart = source?.ready && key(source) === key(position) ? opportunityChart(source.rows, 'ok', observed) : null;
  if (!chart?.ready || chart.rows.length < 24) return { ...result, status: 'unavailable', reason: '持仓收盘线不足或过期；等待真实量价证据，不据此认定趋势仍有效' };
  const rows = chart.rows, last = rows.at(-1), previous = rows.at(-2), third = rows.at(-3);
  const closedAfterEntry = bar => bar.time + 60000 > opened;
  if (!closedAfterEntry(previous)) return { ...result, status: 'warming', reason: '等待入场后两根独立收盘线；取消固定价格止损的实验此时仍暴露于亏损' };
  const original = position.entryEvidence?.opportunity;
  const anchor = positive(referenceLevel) ? referenceLevel
    : original?.basis === 'ohlcv' && positive(original.pattern?.reclaimPrice) ? original.pattern.reclaimPrice : null;
  const levels = [ema(rows, 21), ema(rows.slice(0, -1), 21), ema(rows.slice(0, -2), 21)];
  const fast = ema(rows, 8), below = (bar, i) => bar.close < (anchor || levels[i]);
  const trendBroken = !!anchor || fast < levels[0];
  const twoBelow = trendBroken && below(last, 0) && below(previous, 1) && mark.price < (anchor || levels[0]);
  const threeBelow = twoBelow && closedAfterEntry(third) && below(third, 2);
  const baseline = median(rows.slice(-14, -2).map(r => r.volume));
  const relativeVolume = baseline > 0 ? last.volume / baseline : null;
  const previousVolume = baseline > 0 ? previous.volume / baseline : null;
  const upperWick = previous.high > previous.low ? (previous.high - Math.max(previous.open, previous.close)) / (previous.high - previous.low) : 0;
  const heavyBreak = twoBelow && last.close < last.open && relativeVolume >= p.sellVolumeMultiple;
  const distribution = previousVolume >= p.distributionVolumeMultiple && upperWick >= p.distributionUpperWick
    && last.close < previous.low && last.close < last.open && mark.price < previous.low;
  const reason = heavyBreak ? '两根入场后收盘失守关键位且下跌放量，退出'
    : threeBelow ? '连续三根入场后收盘失守关键位，弱势持续，退出'
    : distribution ? '放量长上影后收盘跌破前低，派发形态确认，退出'
    : '尚未确认放量破位、持续失守或派发；继续观察量价与资金流，不代表保证上涨';
  return { ...result, status: heavyBreak || threeBelow || distribution ? 'invalidated' : 'observing',
    exit: heavyBreak || threeBelow || distribution, reason,
    structure: { closedAt: last.time + 60000, referenceLevel: anchor || levels[0],
      levelKind: positive(referenceLevel) ? referenceKind : anchor ? '入场时真实结构收复位' : '当前二十一期指数均线',
      close: last.close, ema8: fast, ema21: levels[0], relativeVolume, previousVolume, upperWick,
      twoBelow, threeBelow, heavyBreak, distribution } };
}
