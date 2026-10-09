import { STRATEGY_ANALYSIS_VERSION, priceText } from './paper-strategy-analysis.js';
import { freshNarrativeRecall } from './paper-narrative-recall.js';
import { traderDecision, traderReview } from './paper-trader-reasoning.js';
import { isEvidenceHold, EVIDENCE_HOLD_TEXT, STRUCTURE_HOLD_EXIT_POLICY } from './paper-pvp-policy.js';
import {ALPHA_ENTRY_VERSION,validAlphaSignal} from './binance-alpha-catalog.js';
import {MONITOR_ENTRY_VERSION,validMonitorSignal} from './paper-monitor-signal.js';
import {isWalletSignalVersion,walletSignalRoute} from './paper-collective-signal.js';
import { paperCostGate, STRUCTURE_COST_TEXT, GAS_ACCOUNT_ONLY_TEXT } from './paper-cost-policy.js';
import { GAS_ACCOUNT_ONLY } from './paper-chain-gas.js';
import { paperLossGuard } from './paper-loss-guard.js';

export const CONFIRMED_PAPER_VERSION = 'confirmed_pvp_v2';
export const CONFIRMED_QUOTE_VERSION = 'path_checked_v1';
export const LOSS_RESPONSE_VERSION = 'review_without_pause_v1';
export const CONTINUOUS_PAPER_VERSION = 'continuous_paper_v1';
export function paperOperatingPolicy(continuousPaperMode = false, enforceLossGuards = false) {
  const disabledLimits = continuousPaperMode ? ['日亏损停机', '累计亏损停机', '每日与每小时开仓次数', '开仓固定间隔', '同币亏损次数', '平仓固定冷却', '两个持仓上限'] : [];
  if (enforceLossGuards) {
    for (const label of ['日亏损停机', '累计亏损停机']) {
      const index = disabledLimits.indexOf(label);
      if (index >= 0) disabledLimits.splice(index, 1);
    }
  }
  return { version: continuousPaperMode ? CONTINUOUS_PAPER_VERSION : 'bounded_paper_v1',
    mode: 'paper', continuous: continuousPaperMode, execution: false, signing: false, broadcast: false,
    enforceLossGuards,
    label: enforceLossGuards ? '持续扫描 · 保留亏损熔断' : continuousPaperMode ? '全天候模拟 · 不按亏损或次数停机' : '限额模拟',
    disabledLimits,
    retainedChecks: ['真实新鲜行情', '买点与退出条件', '可用余额及单笔预算', '旧信号去重', '账本一致性'],
    note: enforceLossGuards ? '持续扫描保留累计与当日亏损熔断；数据断档不自动卖出，不自动补充虚拟本金。'
      : '全天候是持续评估，不是保证每时每刻成交；电脑及网络需保持运行，不自动补充虚拟本金。' };
}
export const CONFIRMED_PAPER_POLICY = Object.freeze({ version: CONFIRMED_PAPER_VERSION,
  minBuyers: 2, minSmartMoney: 1, minNetBuy: 500, minLiquidity: 20_000,
  minRecentBuyers: 2, minRecentNetBuy: 300, flowMaxAgeMs: 90_000,
  minBudgetUsd: 1, maxCostRate: .05, stopLoss: .06,
  quoteCount: 3, quoteSpanMs: 10_000, quoteWindowMs: 30_000, maxQuoteGapMs: 15_000,
  minPriceRise: .005, maxPriceRise: .04, maxPullback: .015,
  minEntryGapMs: 60_000, hourlyEntries: 6, dailyEntries: 24,
  dailyLossRate: .03, maxAccountLossRate: .1,
  consecutiveLosses: 3, losingPauseMs: 0, tokenLossLimit: 2 });
const p = CONFIRMED_PAPER_POLICY;
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
export const isConfirmedPaperEntry = evidence => evidence?.confirmedPolicy?.version === CONFIRMED_PAPER_VERSION
  && evidence.entryPlan?.confirmedPolicyVersion === CONFIRMED_PAPER_VERSION && evidence.entryTier === 'exploratory';

// Minimal paper-entry lane: strategy evidence is retained for research, but
// only the data that can make a simulated fill nonsensical remains blocking.
// This is intentionally paper-only; it never authorizes signing or broadcast.
const minimalChain = value => String(value ?? '').trim().toLowerCase();
const minimalValidAddress = (chain, address) => chain === 'sol'
  ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(address || ''))
  : /^(0x[\da-f]{40})$/i.test(String(address || ''));
const minimalFinite = value => typeof value === 'number' && Number.isFinite(value) ? value : Number.isFinite(Number(value)) ? Number(value) : null;

export const isMinimalPaperEntry = evidence => isConfirmedPaperEntry(evidence) && evidence?.minimalEntryMode === true;

export function minimalPaperEntry(row, { sourceSafety, token: sourceToken = null, nowMs }) {
  const { positionSizing: _ignoredSizing, ...rawEvidence } = row.evidence || {};
  const v = rawEvidence, token = sourceToken || row.token || {}, chain = minimalChain(token.chain);
  const hardBlocked = new Set(['存在貔貅标记', '可卖出检测未通过', '禁止卖出', '黑名单', '可任意增发', '可任意冻结', '可任意暂停', '池子真实性异常', '流动性为零']);
  const reasons = (sourceSafety?.blocked || []).filter(reason => hardBlocked.has(reason) || /税率|买入税|卖出税/.test(reason));
  const missing = [];
  const auditMissing = [...new Set(sourceSafety?.missing || [])];
  const hardAuditFields = new Set(['买入税', '卖出税', '可卖出检测', '内外盘来源冲突待核对']);
  for (const field of auditMissing) if (hardAuditFields.has(field)) missing.push(field);
  if (!['sol', 'eth', 'base', 'bsc', 'robinhood'].includes(chain) || !minimalValidAddress(chain, token.address)) missing.push('有效链和合约地址');
  if (v.marketFresh !== true) missing.push('两分钟内的真实行情');
  if (v.priceFresh !== true || !minimalFinite(token.price) || minimalFinite(token.price) <= 0) missing.push('五秒内的独立报价');
  if (minimalFinite(v.liquidity) === null || minimalFinite(v.liquidity) <= 0) missing.push('真实流动性');
  const buyTax = minimalFinite(sourceSafety?.metrics?.buyTax ?? v.costAssumptions?.buyTax);
  const sellTax = minimalFinite(sourceSafety?.metrics?.sellTax ?? v.costAssumptions?.sellTax);
  if (buyTax === null) missing.push('买入税');
  if (sellTax === null) missing.push('卖出税');
  if (buyTax !== null && buyTax > .06 || sellTax !== null && sellTax > .06) reasons.push('税率超过 6%');
  const sellFlags = token.sellabilityFlags || {};
  const explicitlySellable = token.isHoneypot === false || token.cannotSell === false
    || sellFlags.canSell === true || sellFlags.sellable === true || token.sellability === 'ok';
  if (!explicitlySellable && !reasons.some(reason => /貔貅|禁止卖出|可卖出检测/.test(reason))) missing.push('可卖出检测');
  const eligible = !missing.length && !reasons.length;
  const price = minimalFinite(token.price);
  const confirmedAt = v.priceObservedAt || row.observedAt || new Date(nowMs).toISOString();
  const entryPlan = {
    version: STRATEGY_ANALYSIS_VERSION,
    confirmedPolicyVersion: CONFIRMED_PAPER_VERSION,
    eligible,
    setup: '最小必要门槛：真实报价＋可卖性＋税费＋流动性',
    reasons,
    entryZone: price > 0 ? { low: price, high: price } : null,
    stopPrice: price > 0 ? price * .90 : null,
    targetPrice: price > 0 ? price * 1.15 : null,
    targetRole: 'structure_reference_only',
    exitPolicyVersion: v.exitPolicy?.version || null,
    targetKind: '仅作情景参考，不是固定止盈',
    confirmedAt,
    summary: '取消叙事、聪明钱、K 线、成本比例与恢复期证明的开仓硬门槛；仅模拟，不代表盈利预测。'
  };
  const confirmation = { version: CONFIRMED_QUOTE_VERSION, ready: eligible, count: eligible ? 1 : 0,
    confirmedAt: eligible ? confirmedAt : null, reason: eligible ? null : '最小安全门槛未通过',
    rows: eligible ? [{ observedAt: confirmedAt, price }] : [] };
  return { ...row,
    label: '最小门槛探索',
    decision: sourceSafety?.blocked?.length ? '不买' : eligible ? '可模拟' : '观察',
    reasons: eligible ? ['最小安全门槛通过，进入模拟账本；策略证据仅作研究记录'] : [...new Set(reasons)],
    missing: [...new Set(missing)],
    score: Math.max(0, 100 - missing.length * 20 - reasons.length * 30),
    entryLogic: '最小门槛模拟：不再要求叙事、聪明钱、K 线、成本比例或恢复期证明；必须有有效 CA、两分钟内行情、五秒内报价、可卖性、税率不高于 6%、非零流动性和一致数据绑定。仅模拟，不能用于真实交易授权。',
    exitLogic: v.exitPolicy?.version ? '沿用主盘叙事与资金行为退出；结构参考位不作为固定止盈止损。' : '依据新鲜行情、叙事与资金行为复核退出；无固定收益保证。',
    evidence: { ...v, minimalEntryMode: true, paperEligible: eligible,
      safety: { ...sourceSafety, auditMissing, auditComplete: auditMissing.length === 0, policyVersion: 'minimal_hard_safety_v1' },
      entryThresholds: { minBuyers: 0, minHighProfit: 0, minSmartMoney: 0, minNetBuy: 0, minLiquidity: 0, maxTaxRate: .06 },
      entryPlan, confirmedPolicy: { version: CONFIRMED_PAPER_VERSION, lossResponseVersion: LOSS_RESPONSE_VERSION, pulse: null, confirmation,
        minimal: true, ignoredStrategyGates: ['叙事', '聪明钱', 'K 线', '成本比例', '恢复期证明'] } }
  };
}

function quotePathStats(rows) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.some(r=>!positive(r.price))) return null;
  let peak=rows[0].price,maxDrawdown=0,maxStepRise=0;
  for(let i=1;i<rows.length;i++) {
    maxDrawdown=Math.max(maxDrawdown,1-rows[i].price/peak);
    maxStepRise=Math.max(maxStepRise,rows[i].price/rows[i-1].price-1);
    peak=Math.max(peak,rows[i].price);
  }
  return {maxDrawdown,maxStepRise};
}

export function confirmPaperQuotes(history, token, nowMs) {
  const rows = [], times = new Set();
  for (const q of history || []) {
    const at = Date.parse(q?.observedAt || '');
    if (q?.status !== 'ok' || q.chain !== token.chain || q.address !== token.address || !positive(q.price)
      || !Number.isFinite(at) || at > nowMs || nowMs - at > p.quoteWindowMs) continue;
    if (times.has(at)) {
      if (rows.find(r => r.at === at).price !== q.price) return { ready: false, reason: '同时间报价存在冲突' };
      continue;
    }
    times.add(at); rows.push({ price: q.price, at });
  }
  rows.sort((a, b) => a.at - b.at);
  const first = rows[0], last = rows.at(-1);
  if (rows.length < p.quoteCount || last.at - first.at < p.quoteSpanMs || nowMs - last.at > 5000
    || rows.some((r, i) => i && r.at - rows[i - 1].at > p.maxQuoteGapMs)) return { ready: false, reason: '连续新鲜报价确认', count: rows.length };
  const rise = last.price / first.price - 1, pullback = 1 - last.price / Math.max(...rows.map(r => r.price));
  const previous = rows.at(-2);
  const path = quotePathStats(rows);
  const ready = last.price === token.price && rise >= p.minPriceRise && rise <= p.maxPriceRise
    && pullback <= p.maxPullback && last.price >= previous.price && path.maxDrawdown <= p.maxPullback && path.maxStepRise <= p.maxPriceRise;
  return { version: CONFIRMED_QUOTE_VERSION, ready, reason: ready ? null : '报价路径存在深回撤、急拉或未持续走强，不追反抽', count: rows.length,
    pathMaxDrawdown: path.maxDrawdown, maxStepRise: path.maxStepRise,
    fromAt: new Date(first.at).toISOString(), confirmedAt: new Date(last.at).toISOString(), rise, pullback,
    rows: rows.map(r => ({ observedAt: new Date(r.at).toISOString(), price: r.price })) };
}

export function confirmedPaperEntry(row, { sourceSafety, pulse, quoteHistory, narrativeRecall, continuousPaperMode = false, lossRepairMode = false, memeExitMode = false, route = null, nowMs }) {
  const v = row.evidence, price = row.token.price, costs = v.costAssumptions;
  const structural = route?.basis === 'ohlcv';
  const internal = route?.id === 'internal_launch';
  const recall = freshNarrativeRecall(narrativeRecall,row.token,nowMs) ? narrativeRecall : null;
  const minSmartMoney = recall || internal ? 0 : p.minSmartMoney;
  const minNetBuy = internal ? 300 : p.minNetBuy;
  const required = new Set(['有效链和合约地址', '有效可用余额与流动性对应的滚仓预算', '可用余额及流动性额度须足够固定 10 U', '两分钟内的真实行情',
    '有效正数价格', '五秒内的独立报价', '真实流动性', '真实成交量', '一致的独立买入地址统计']);
  const missing = [...sourceSafety.missing, ...row.missing.filter(x => required.has(x))];
  const reasons = [...sourceSafety.blocked];
  if (structural) {
    const index = missing.indexOf('一致的独立买入地址统计');
    if (index >= 0) missing.splice(index,1);
  } else {
  if (!v.flowFresh) missing.push('完整且新鲜的买入资金流');
  if (!(v.flow.uniqueBuyerCount >= p.minBuyers && v.flow.smartMoneyCount >= minSmartMoney && v.flow.netBuyUsd >= minNetBuy)) reasons.push(internal ? '等待内盘两个净买家及 $300 净流入' : recall ? 'OG 回流仍需两个净买家及 $500 净流入' : '等待两个净买家、至少一个聪明钱标签及 $500 净流入');
  if (!pulse || !Number.isFinite(pulse.lastBuyAt) || pulse.lastBuyAt > nowMs || nowMs - pulse.lastBuyAt > p.flowMaxAgeMs
    || pulse.recentBuyerCount < p.minRecentBuyers || pulse.recentNetBuyUsd < p.minRecentNetBuy) missing.push('九十秒内新增的双地址买盘');
  }
  if (route) { missing.push(...route.missing); reasons.push(...route.reasons); }
  if (!(v.liquidity >= p.minLiquidity)) reasons.push('流动性低于 $20,000');
  if (!(v.volume.value > 0)) reasons.push('等待真实成交量');
  if (!(row.entryUsd >= p.minBudgetUsd)) reasons.push('预算低于 $1，固定成本不适合继续试单');
  const costGate = paperCostGate(costs, { structureMain: memeExitMode && structural && !!route.reviewVersion, economics: route?.economics });
  if (costGate.reason) (costGate.needsStructure ? missing : reasons).push(costGate.reason);
  const confirmation = structural ? route.confirmation : confirmPaperQuotes(quoteHistory, row.token, nowMs);
  if (!confirmation.ready) {
    if (confirmation.reason === '连续新鲜报价确认') missing.push(confirmation.reason);
    else reasons.push(confirmation.reason);
  }
  const eligible = !missing.length && !reasons.length;
  const stopPrice = structural && positive(route.pattern.support) ? route.pattern.support : positive(price) ? price * (1 - p.stopLoss) : null;
  const reviewed = structural && !!route.reviewVersion;
  const exitProfile = reviewed ? STRUCTURE_HOLD_EXIT_POLICY : v.exitPolicy;
  const targetPrice = reviewed ? route.pattern.targetPrice : positive(price) ? price * 1.15 : null;
  const quantity = positive(price) && positive(costs.notionalUsd) ? costs.notionalUsd / price : 0;
  const netAt = x => quantity * x * (1 - costs.feeRate - costs.slippageRate - costs.sellTax) - costs.gasUsd;
  const loss = quantity ? row.entryUsd - netAt(stopPrice) : null, gain = quantity ? netAt(targetPrice) - row.entryUsd : null;
  const entryPlan = { version: STRATEGY_ANALYSIS_VERSION, confirmedPolicyVersion: CONFIRMED_PAPER_VERSION, eligible,
    setup: '新增双地址买盘＋连续独立报价确认', reasons, entryZone: positive(price) ? { low: price, high: price } : null,
    stopPrice, targetPrice, targetRole: 'structure_reference_only', exitPolicyVersion: exitProfile.version,
    targetKind: reviewed ? route.pattern.targetKind : '15% 仅为盈亏情景，不是预测或入场证明', confirmedAt: confirmation.confirmedAt || null,
    ...(reviewed ? {economics:route.economics,reviewVersion:route.reviewVersion} : {}),
    netRewardRisk: loss > 0 && gain > 0 ? gain / loss : null, estimatedStopLossUsd: loss,
    summary: `至少三次独立报价、跨度十秒；整段最大回撤不超过 1.5%、相邻急拉不超过 4%；初始止损 ${priceText(stopPrice)}。` };
  const result = { ...row, label: recall ? 'OG 回流狙击' : '确认型 PVP', decision: sourceSafety.blocked.length ? '不买' : eligible ? '可模拟' : '观察',
    reasons: eligible ? ['新增买盘、连续报价与成本条件通过；仍需账户风控批准'] : [...new Set(reasons)], missing: [...new Set(missing)],
    score: Math.max(0, 100 - missing.length * 10 - reasons.length * 15),
    entryLogic: (recall ? `OG 回流狙击：${recall.summary} 资金路径：新话题可能让注意力回到历史同题材币，不代表作者荐币。历史市值参考/当前市值 ${recall.referenceRoom.toFixed(2)} 倍，非收益预测。出处 ${recall.sourceUrl}；历史 ${recall.historicalSourceUrl}。已核实的叙事回流取代聪明钱标签要求，但双地址买盘、报价、安全及账户保护全部保留。` : '') + '确认型 PVP v2：九十秒内双地址新增买盘；至少三个独立报价跨十秒，短时上涨 0.5%–4%、整段最大回撤不超过 1.5%、相邻涨幅不超过 4%，不追深跌后的急反抽。预算至少 $1、往返模型成本最多 5%；同一旧买盘不重复入场。连亏只复盘、不按次数暂停；其他账户保护保留。仅模拟，参数尚未验证盈利。',
    exitLogic: isEvidenceHold(v.exitPolicy) ? `初始价格止损 6%；${EVIDENCE_HOLD_TEXT} 止损按新鲜观察价记账，不能保证触发价成交。`
      : '初始价格止损 6%；满 120 秒且价格未高于买入价才作停滞退出，不因刚买入尚未覆盖费用立即卖出。主仓最长 5 分钟；2/3 倍分批兑现，强势尾仓最多 20 分钟。止损按新鲜观察价记账，不能保证触发价成交。',
    evidence: { ...v, costGate, exitPolicy:structuredClone(exitProfile), paperEligible: eligible, safety: { ...sourceSafety, auditMissing: [...sourceSafety.missing], auditComplete: !sourceSafety.missing.length, policyVersion: 'strict_fields_v1' },
      ...(recall ? { narrativeRecall: structuredClone(recall) } : {}),
      entryThresholds: { minBuyers: p.minBuyers, minHighProfit: 0, minSmartMoney, minNetBuy: p.minNetBuy, minLiquidity: p.minLiquidity },
      ...(continuousPaperMode ? { accountPolicy: paperOperatingPolicy(true, lossRepairMode) } : {}),
      entryPlan, confirmedPolicy: { version: CONFIRMED_PAPER_VERSION, lossResponseVersion: LOSS_RESPONSE_VERSION, pulse: structuredClone(pulse || null), confirmation } } };
  if (continuousPaperMode) {
    result.entryLogic = result.entryLogic.replace('其他账户保护保留。', '全天候模拟：亏损、交易次数、固定冷却及持仓个数不触发停机；真实数据、买点、余额和旧信号去重仍需通过。');
  }
  if(costs.gasAdmissionPolicy===GAS_ACCOUNT_ONLY) {
    result.entryLogic=result.entryLogic.replace('往返模型成本最多 5%', '不含 Gas 的费用门槛最多 5%');
    result.entryLogic+=` ${GAS_ACCOUNT_ONLY_TEXT}`;
  }
  if (route) {
    result.label = route.label;
    result.reasons = eligible ? [`${route.label}：触发、报价、安全与成本检查通过`] : result.reasons;
    result.entryLogic = `${route.label}：${route.description} ${structural ? '依据真实已收盘 1 分钟 K 线；不把缺失的聪明钱数据当成买盘，也不强制聪明钱标签。两次独立报价跨度至少 3 秒，最新不超过 5 秒；报价仍需站稳结构、距收盘不超过 3%。' : result.entryLogic} 不承诺收益；仅模拟。`;
    if (internal) result.entryLogic = `内盘启动：已核实内盘/临毕业，五分钟两个净买家和 $300 净流入，90 秒两个新增净买家和 $300 净流入；不要求聪明钱标签。三次报价跨十秒且路径持续走强；旧买盘不重复入场。仅模拟。`;
    result.evidence.opportunity = { version:route.version, ...(route.reviewVersion ? {reviewVersion:route.reviewVersion} : {}), id:route.id, label:route.label, basis:route.basis,
      signalId:route.signalId,signalAt:route.signalAt ?? null,pattern:route.pattern || null,
      signalReady:structural ? route.pattern.ready && !route.reasons.length && !route.missing.length : v.flowFresh && v.flow.uniqueBuyerCount >= p.minBuyers
        && v.flow.smartMoneyCount >= minSmartMoney && v.flow.netBuyUsd >= minNetBuy && !route.reasons.length && !route.missing.length };
    result.evidence.entryThresholds = { ...result.evidence.entryThresholds, minSmartMoney, minNetBuy };
    if (structural) {
      if (memeExitMode) result.entryLogic += ` ${costs.gasAdmissionPolicy===GAS_ACCOUNT_ONLY?GAS_ACCOUNT_ONLY_TEXT:STRUCTURE_COST_TEXT}`;
      result.evidence.entryPlan = { ...entryPlan,setup:route.label,summary:`${route.description} 结构失效位 ${priceText(stopPrice)}；不按固定持仓时间卖出。` };
      result.exitLogic = `结构止损 ${priceText(stopPrice)}（距离不超过 6%）；${EVIDENCE_HOLD_TEXT} 仅按新鲜观察价模拟成交，跳价可能超过止损线。`;
      if (reviewed) {
        result.entryLogic += costs.gasAdmissionPolicy===GAS_ACCOUNT_ONLY
          ? ' 报价必须向上并收复确认位；入场只检查结构与非 Gas 成本后的空间。包含 Gas 的净收益另行展示，即使为负也不代表预测可盈利。'
          : ' 报价必须向上并收复确认位；区间空间与扣成本盈亏比通过，不用固定 15% 假设证明利润。';
        result.exitLogic = `真实结构加波动缓冲止损 ${priceText(stopPrice)}；连续两根入场后收盘线确认结构失效才作逻辑退出。历史结构参考位且扣成本盈利时兑现原仓 20%，2 / 3 倍各兑现 30%，余 20% 跟踪；无固定持仓期限。成本保护与波动回撤线只上调不放宽。`;
      }
    }
  }
  // Keep the hot scan lean: detailed questions are needed for eligible entries
  // and the displayed candidate, not hundreds of already-blocked rows.
  if (eligible) result.evidence.traderDecision = traderDecision(result, nowMs);
  return result;
}

// Aggregate by original position, so partial sells do not fake winning/losing streaks.
export function completedPaperRounds(trades) {
  const open = new Map(), closed = [];
  for (const t of trades) {
    const key = `${t.chain}:${t.address}`;
    if (t.side === 'buy') open.set(key, { key, pnl: 0, left: t.quantity, quantity: t.quantity, entry: t, exits: [] });
    else {
      const lot = open.get(key); if (!lot) continue;
      lot.pnl += t.realizedPnl; lot.left -= t.quantity; lot.exits.push(t);
      if (lot.left <= lot.quantity * 1e-9) { closed.push({ key, pnl: lot.pnl, at: t.atMs, entry: lot.entry, exits: lot.exits }); open.delete(key); }
    }
  }
  return closed;
}

function lossReview(rounds) {
  let consecutiveNonWinningRounds=0;
  for(let i=rounds.length-1;i>=0&&rounds[i].pnl<=0;i--)consecutiveNonWinningRounds++;
  const recent=rounds.slice(-5).map(r=>{
    const entry=r.entry,last=r.exits.at(-1),path=quotePathStats(entry.entryEvidence?.confirmedPolicy?.confirmation?.rows);
    const stops=r.exits.filter(t=>/止损/.test(t.reason||'')&&positive(t.exitEvidence?.activeStopPrice)&&positive(t.price));
    const stopShortfallRate=stops.length?Math.max(0,...stops.map(t=>1-t.price/t.exitEvidence.activeStopPrice)):null;
    const costs=Number.isFinite(entry.costsUsd)&&r.exits.every(t=>Number.isFinite(t.costsUsd))
      ? entry.costsUsd+r.exits.reduce((n,t)=>n+t.costsUsd,0):null;
    const findings=[];
    if(path&&(path.maxDrawdown>p.maxPullback||path.maxStepRise>p.maxPriceRise))findings.push('原入场报价有深回撤或急反抽；新路径检查不再通过');
    if(stopShortfallRate>0)findings.push(`止损观察价低于触发线 ${(stopShortfallRate*100).toFixed(2)}%；仅凭成交记录不能归因为跳价或延迟`);
    if(r.pnl<0&&costs!==null&&r.pnl+costs>=0)findings.push('价格毛结果非负，但模型成本造成净亏损');
    return {entryId:entry.id||null,symbol:entry.symbol||entry.address,chain:entry.chain,address:entry.address,
      openedAt:entry.atMs,closedAt:r.at,realizedPnl:r.pnl,costsUsd:costs,
      priceChangeRate:positive(entry.price)&&positive(last.price)?last.price/entry.price-1:null,
      stopShortfallRate,entryQuotePath:path,exitQuoteDiagnostics:last.exitEvidence?.quoteDiagnostics||null,
      findings:findings.length?findings:['已记录完整仓位结果，样本不足以推断稳定优势']};
  });
  return {version:LOSS_RESPONSE_VERSION,mode:'review_only',pauseMs:0,consecutiveNonWinningRounds,
    reviewTriggered:consecutiveNonWinningRounds>=p.consecutiveLosses,completedRounds:rounds.length,recent,
    automaticParameterChanges:false,note:'完整平仓后复盘，不按连亏次数停机；分批卖出不重复计数，日亏损、总亏损和同币保护仍有效。'};
}

export function confirmedAccountGate(account, nowMs, token = null, pulse = null, narrativeRecall = null, { continuousPaperMode = false, opportunity = null, enforceLossGuards = false } = {}) {
  if (typeof continuousPaperMode !== 'boolean' || continuousPaperMode && (account.mode !== 'paper' || account.execution !== false
    || account.signing !== false || account.broadcast !== false || account.variant)) throw new TypeError('continuous mode is paper-main only');
  const day = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const trades = account.trades.filter(t => t.atMs <= nowMs), buys = trades.filter(t => t.side === 'buy');
  const dailyPnl = trades.filter(t => t.atMs >= day).reduce((n, t) => n + t.realizedPnl, 0);
  const rounds = completedPaperRounds(trades), reasons = [], warnings = [];
  const limits = !continuousPaperMode || enforceLossGuards ? reasons : warnings;
  if (enforceLossGuards) reasons.push(...paperLossGuard(account, nowMs).reasons);
  else {
    if (account.realizedPnl <= -account.initialCash * p.maxAccountLossRate) limits.push(continuousPaperMode ? '累计亏损超过原 10% 线，仅记录复盘、不停机' : '累计已实现亏损达到初始本金 10%，需复盘后人工处理');
    if (dailyPnl <= -account.initialCash * p.dailyLossRate) limits.push(continuousPaperMode ? 'UTC 当日亏损超过原 3% 线，仅记录复盘、不停机' : 'UTC 当日已实现亏损达到初始本金 3%，暂停新仓');
  }
  if (!continuousPaperMode) {
    if (buys.filter(t => t.atMs >= day).length >= p.dailyEntries) reasons.push('达到每日 24 次开仓上限');
    if (buys.filter(t => t.atMs > nowMs - 3600_000).length >= p.hourlyEntries) reasons.push('达到每小时 6 次开仓上限');
    if (buys.length && nowMs - buys.at(-1).atMs < p.minEntryGapMs) reasons.push('两次开仓至少间隔一分钟');
  }
  // User-selected paper policy: consecutive non-wins trigger review, never a timed pause.
  if (token) {
    if (narrativeRecall && buys.some(t=>t.entryEvidence?.narrativeRecall?.triggerId===narrativeRecall.triggerId)) reasons.push('这条叙事催化已经交易，等待不同的新事件');
    const key = `${token.chain}:${token.address}`, lastBuy = buys.filter(t => `${t.chain}:${t.address}` === key).at(-1);
    if(opportunity?.basis==='official_event'){
      if(!continuousPaperMode||opportunity.id!=='alpha_listing'||opportunity.entryPolicyVersion!==ALPHA_ENTRY_VERSION
        ||!opportunity.signalReady||!validAlphaSignal(opportunity.event,token,nowMs)
        ||opportunity.signalId!==opportunity.event?.id||opportunity.signalAt!==opportunity.event?.listingTime)
        reasons.push('官方 Alpha 事件无效、过期或模式未批准');
      if(buys.some(t=>t.entryEvidence?.opportunity?.signalId===opportunity.signalId))reasons.push('这次 Alpha 上新已交易，不重复消费');
    } else if(opportunity?.basis==='monitored_event'){
      if(!continuousPaperMode||opportunity.id!=='monitored_event'||opportunity.entryPolicyVersion!==MONITOR_ENTRY_VERSION
        ||!opportunity.signalReady||!validMonitorSignal(opportunity.event,token,nowMs)
        ||opportunity.signalId!==opportunity.event?.id||opportunity.signalAt!==Date.parse(opportunity.event?.sourceAt))
        reasons.push('监控事件无效、过期或主模拟模式未批准');
      if(buys.some(t=>t.entryEvidence?.opportunity?.signalId===opportunity.signalId)
        ||lastBuy&&opportunity.signalAt<=lastBuy.atMs)reasons.push('这条监控事件已消费或早于上次买入，不重复买');
    } else if(opportunity?.basis==='wallet_signal') {
      if(!continuousPaperMode||token.chain!=='bsc'||opportunity.id!==walletSignalRoute({version:opportunity.entryPolicyVersion})
        ||!isWalletSignalVersion(opportunity.entryPolicyVersion)||opportunity.signalReady!==true
        ||!Number.isFinite(opportunity.signalAt)||opportunity.signalAt>nowMs||nowMs-opportunity.signalAt>30000
        ||typeof opportunity.signalId!=='string'||!opportunity.signalId.startsWith(`${key}:${opportunity.entryPolicyVersion}:`))
        reasons.push('集体钱包信号无效、过期或主模拟模式未批准');
      if(buys.some(t=>t.entryEvidence?.opportunity?.signalId===opportunity.signalId)
        ||lastBuy&&opportunity.signalAt<=lastBuy.atMs)reasons.push('钱包信号已消费，等待上次开仓后的新买盘');
    } else if (opportunity?.basis === 'ohlcv') {
      const at=opportunity.signalAt;
      if (!['multi_setup_v1','multi_setup_v2'].includes(opportunity.version) || !['external_breakout','external_pullback','external_trend'].includes(opportunity.id)
        || !opportunity.signalReady || !Number.isFinite(at) || at > nowMs || nowMs-at > 90000
        || opportunity.signalId !== `${token.chain}:${token.address}:${opportunity.id}:${at}`) reasons.push('结构触发信号无效或过期');
      if (lastBuy && (at <= lastBuy.atMs || buys.some(t=>t.entryEvidence?.opportunity?.signalId === opportunity.signalId))) reasons.push('同一旧结构信号已消费，等待新收盘信号');
    } else if (lastBuy && (!Number.isFinite(pulse?.lastBuyAt) || pulse.lastBuyAt <= lastBuy.atMs)) reasons.push('同一旧资金流已消费，等待上次开仓之后的新买盘');
    if (!continuousPaperMode && rounds.filter(r => r.key === key && r.at >= day && r.pnl < 0).length >= p.tokenLossLimit) reasons.push('同币当日已亏损两次，不再反复试单');
    if (!continuousPaperMode && (account.cooldowns[key] || 0) > nowMs) reasons.push('同币平仓后冷却三十分钟');
  }
  const review = lossReview(rounds);
  if (enforceLossGuards) review.note = '持续扫描但保留亏损熔断：累计或当日亏损达到阈值后停止新仓；真实数据、余额、旧信号去重及退出规则仍生效。';
  else if (continuousPaperMode) review.note = '全天候模拟：亏损与次数只用于复盘、不停机；真实数据、余额、旧信号去重及退出规则仍生效。';
  return { version: CONFIRMED_PAPER_VERSION, lossResponseVersion: LOSS_RESPONSE_VERSION,
    operatingPolicy: paperOperatingPolicy(continuousPaperMode, enforceLossGuards),
    allowed: reasons.length === 0, reasons, warnings, dailyPnl, dailyEntries: buys.filter(t => t.atMs >= day).length,
    lossReview: review, traderReview: traderReview(rounds, nowMs) };
}
