// Research-only focus overlay. It never authorizes an entry or paper fill.
import { COLLECTIVE_SIGNAL_VERSION, PREQUALIFIED_WALLET_VERSION, validCollectiveSignal } from './paper-collective-signal.js';
import { structureEconomics } from './paper-opportunity-review.js';

export const PAPER_STRATEGY_FOCUS_SHADOW_VERSION = 'smartmoney_second_breakout_shadow_v1';
const SECOND_BREAKOUT_VERSION = 'external_second_breakout_pattern_v1';
const QUOTE_CONFIRMATION_VERSION = 'focus_shadow_quote_confirmation_v1';
const finite = n => typeof n === 'number' && Number.isFinite(n);
const positive = n => finite(n) && n > 0;
const stamp = n => typeof n === 'number' ? (n < 1e10 ? n * 1000 : n) : Date.parse(n || '');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const sameAddress = (chain, a, b) => chain === 'sol' ? a === b : String(a || '').toLowerCase() === String(b || '').toLowerCase();

function smartMoneyEvidence(signal, token, nowMs) {
  const version = signal?.version;
  const allowedVersion = version === COLLECTIVE_SIGNAL_VERSION || version === PREQUALIFIED_WALLET_VERSION;
  if (!allowedVersion || !sameAddress(token?.chain, signal?.address, token?.address)
    || signal?.chain !== token?.chain || signal?.paperOnly !== true
    || !validCollectiveSignal(signal, { chain: token.chain, address: token.address }, nowMs)) return null;
  const expectedSource = version === COLLECTIVE_SIGNAL_VERSION ? 'collective_smart_money' : 'prequalified_wallet';
  if (signal.source !== expectedSource || !finite(signal.netBuyUsd) || signal.netBuyUsd <= 0
    || !finite(stamp(signal.sourceAt)) || stamp(signal.sourceAt) > nowMs || nowMs - stamp(signal.sourceAt) > 30_000) return null;
  return { status: 'verified_smart_money_flow', version, source: signal.source,
    observedAt: signal.sourceObservedAt || signal.sourceAt, netBuyUsd: signal.netBuyUsd,
    independentGroups: finite(signal.groupCount) ? signal.groupCount : null,
    note: '公开资金流的聪明钱证据；不证明地址同控、庄家身份或主观操盘意图' };
}

function evaluateSecondBreakout({ token, chart, quoteHistory, nowMs, costAssumptions, budgetUsd }) {
  const base = { version: SECOND_BREAKOUT_VERSION, status: 'observing', signalReady: false,
    entryAllowed: false, paperFillAllowed: false, reasons: [] };
  if (token?.stageConflict === true) return { ...base, status: 'data_incomplete', reasons: ['内外盘阶段冲突待核对'] };
  if (token?.marketStage !== 'external') return { ...base, status: 'not_applicable', reasons: ['未核实为外盘'] };
  if (!chart?.ready || !Array.isArray(chart.rows)) return { ...base, status: 'data_incomplete', reasons: [chart?.reason || '缺少有效收盘 K 线'] };
  if (chart.rows.length < 18) return { ...base, status: 'data_incomplete', reasons: ['二段结构需要至少 18 根连续已收盘 K 线'] };
  const rows = chart.rows;
  const last = rows.at(-1), previous = rows.at(-2);
  const volumeBaseline = median(rows.slice(-13, -1).map(r => r.volume));
  const volumeMultiple = positive(volumeBaseline) ? last.volume / volumeBaseline : null;
  const patterns = [];

  // A candidate impulse peak must be a local high, followed by a 15%-65%
  // retracement, then at least three closed bars building a higher base.
  for (let peakIndex = 3; peakIndex <= rows.length - 5; peakIndex++) {
    const peakBar = rows[peakIndex];
    if (peakBar.high < rows[peakIndex - 1].high || peakBar.high < rows[peakIndex + 1].high) continue;
    const baseRows = rows.slice(Math.max(0, peakIndex - 12), peakIndex);
    const impulseBase = Math.min(...baseRows.map(r => r.low));
    const impulsePeak = peakBar.high;
    const impulseRise = impulsePeak / impulseBase - 1;
    if (!(impulseRise >= 0.25)) continue;
    const later = rows.slice(peakIndex + 1, -1); // exclude the signal candle
    if (later.length < 4) continue;
    const troughOffset = later.reduce((best, row, i) => row.low < later[best].low ? i : best, 0);
    const troughIndex = peakIndex + 1 + troughOffset;
    const trough = rows[troughIndex].low;
    const pullback = 1 - trough / impulsePeak;
    const consolidation = rows.slice(troughIndex, -1);
    if (!(pullback >= 0.15 && pullback <= 0.65) || consolidation.length < 4) continue;
    const postTroughBars = consolidation.slice(1);
    if (postTroughBars.length < 3 || postTroughBars.at(-1).low <= trough) continue;
    const rangeHigh = Math.max(...consolidation.map(r => r.high));
    const rangeLow = Math.min(...consolidation.map(r => r.low));
    patterns.push({ peakIndex, impulseBase, impulsePeak, impulseRise, trough, pullback,
      consolidationBars: consolidation.length, rangeHigh, rangeLow,
      breakoutLevel: rangeHigh * 1.002 });
  }

  if (!patterns.length) return { ...base, status: 'observing', volumeMultiple,
    reasons: ['未同时观察到首段上涨、合格回撤及至少三根整理收盘线'] };
  const pattern = patterns.toSorted((a, b) => b.peakIndex - a.peakIndex)[0];
  const metrics = { ...pattern, volumeBaseline, volumeMultiple, closedAt: new Date(last.time + 60_000).toISOString(),
    lastClose: last.close, signalCandleGreen: last.close > last.open };
  if (!(last.close > pattern.breakoutLevel)) return { ...base, metrics, status: 'watching_base',
    reasons: ['回撤整理区尚未被收盘价有效突破'] };
  if (!(finite(volumeMultiple) && volumeMultiple >= 1.5 && last.close > last.open))
    return { ...base, metrics, status: 'watching_base', reasons: ['二次突破收盘或 1.5 倍量能条件不足'] };

  const targetPrice = pattern.impulsePeak > last.close
    ? pattern.impulsePeak : pattern.rangeHigh + (pattern.rangeHigh - pattern.rangeLow);
  const structural = { ready: true, reviewVersion: SECOND_BREAKOUT_VERSION,
    support: pattern.trough, close: last.close, reclaimPrice: pattern.breakoutLevel };
  const quoteConfirmation = confirmFreshQuotes(quoteHistory, token, structural, nowMs);
  const economicsInputsReady = costAssumptions && ['notionalUsd', 'feeRate', 'slippageRate', 'sellTax', 'gasUsd']
    .every(k => finite(costAssumptions[k])) && positive(budgetUsd);
  const economics = economicsInputsReady
    ? structureEconomics({ ...structural, targetPrice }, token.price, costAssumptions, budgetUsd) : null;
  const reasons = [];
  if (!quoteConfirmation.ready) reasons.push(quoteConfirmation.reason);
  if (!economicsInputsReady) reasons.push('缺少完整往返成本参数，成本后空间未知');
  else if (!economics.ready) reasons.push(economics.reason || '扣费后空间不足');
  const signalReady = quoteConfirmation.ready && economics?.ready === true;
  return { ...base, status: signalReady ? 'candidate' : quoteConfirmation.ready ? 'blocked_by_cost_economics' : 'awaiting_fresh_quote',
    signalReady, reasons, metrics: { ...metrics, targetPrice, targetMeaning: '前高或区间投影情景，不是预测/保证可达', support: pattern.trough },
    quoteConfirmation, economics, note: '研究候选；绝不进入主路由或生成模拟成交' };
}

function confirmFreshQuotes(history, token, pattern, nowMs) {
  const fail = reason => ({ version: QUOTE_CONFIRMATION_VERSION, ready: false, reason, count: 0 });
  if (!positive(token?.price) || !finite(nowMs)) return fail('缺少有效现价或检查时间');
  const byTime = new Map();
  for (const quote of history || []) {
    const at = stamp(quote?.observedAt);
    if (quote?.status !== 'ok' || quote.chain !== token.chain || !sameAddress(token.chain, quote.address, token.address)
      || !positive(quote.price) || !finite(at) || at > nowMs || nowMs - at > 15_000) continue;
    if (byTime.has(at) && byTime.get(at) !== quote.price) return fail('同时间报价冲突');
    byTime.set(at, quote.price);
  }
  const rows = [...byTime].map(([at, price]) => ({ at, price })).sort((a, b) => a.at - b.at);
  const first = rows[0], last = rows.at(-1);
  if (rows.length < 2 || last.at - first.at < 3_000 || nowMs - last.at > 5_000
    || rows.some((r, i) => i && r.at - rows[i - 1].at > 10_000)) return { ...fail('连续新鲜独立报价不足'), count: rows.length };
  const ready = last.price === token.price && rows.every(r => r.price > pattern.support)
    && Math.max(...rows.map(r => r.price)) / Math.min(...rows.map(r => r.price)) <= 1.03
    && Math.abs(last.price / pattern.close - 1) <= 0.03
    && last.price > first.price && last.price >= rows.at(-2).price
    && last.price >= pattern.reclaimPrice && last.price >= pattern.close;
  return { version: QUOTE_CONFIRMATION_VERSION, ready, count: rows.length,
    firstAt: new Date(first.at).toISOString(), confirmedAt: new Date(last.at).toISOString(),
    reason: ready ? null : '独立报价未持续站稳突破位或已偏离收盘结构', rows: rows.map(({ at, ...r }) => r) };
}

export function evaluatePaperStrategyFocusShadow({ token, marketStage, chart, quoteHistory, nowMs,
  costAssumptions, budgetUsd, collectiveSignal } = {}) {
  const exactToken = token && marketStage ? { ...token, marketStage } : token;
  const smartMoney = smartMoneyEvidence(collectiveSignal, exactToken, nowMs);
  const internal = ['internal', 'near_completion'].includes(marketStage);
  let internalSmartMoney;
  if (token?.stageConflict === true) internalSmartMoney = { status: 'data_incomplete', entryAllowed: false, reason: '内外盘阶段冲突待核对' };
  else if (!internal) internalSmartMoney = { status: 'not_applicable', reason: '当前 CA 非内盘/临毕业阶段' };
  else if (token?.chain !== 'bsc') internalSmartMoney = { status: 'unsupported_coverage', reason: '当前聪明钱核验实现只覆盖 BSC' };
  else if (smartMoney) internalSmartMoney = { status: 'watch_smart_money_only', evidence: smartMoney,
    entryAllowed: false, reason: '仅记录聪明钱观察，不生成入场' };
  else internalSmartMoney = { status: 'no_verified_smart_money', entryAllowed: false,
    reason: '无匹配、新鲜、通过本地证明校验的聪明钱信号；一般爆量不替代' };
  const externalSecondBreakout = evaluateSecondBreakout({ token: exactToken, chart, quoteHistory, nowMs, costAssumptions, budgetUsd });
  const operatorFootprint = smartMoney
    ? { status: 'public_smart_money_flow_observed', ...smartMoney,
      caveat: '这是公开资金流标签，不证明庄家身份、地址同控或操盘意图' }
    : { status: 'unknown', reason: '缺少精确 CA 绑定的新鲜、可验证聪明钱资金流；不能仅凭 K 线推断庄操盘' };
  return { version: PAPER_STRATEGY_FOCUS_SHADOW_VERSION, researchOnly: true,
    entryAllowed: false, paperFillAllowed: false, evaluatedAt: finite(nowMs) ? new Date(nowMs).toISOString() : null,
    marketStage: marketStage || null, stageConflict: token?.stageConflict === true,
    internalSmartMoney, externalSecondBreakout, operatorFootprint };
}
