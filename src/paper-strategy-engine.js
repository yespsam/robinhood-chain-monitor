/** Deterministic paper decisions and an isolated, cost-aware simulated ledger. */
import { STRATEGY_ANALYSIS_VERSION, CHART_MISSING, assessPaperNarrative, analyzePaperChart, buildPaperEntryPlan, priceText } from './paper-strategy-analysis.js';
import { validLearningPolicy } from './wallet-learning.js';
import { paperPositionSize, validPaperPositionSize, paperSizingText, PAPER_FIXED_ENTRY_USD, PAPER_FIXED_SIZING_VERSION, PAPER_RECOVERY_SIZING_VERSION } from './paper-position-sizing.js';
import { PAPER_RECOVERY_VERSION, EVIDENCE_GAP_POLICY, validEvidenceGapPolicy, applyEvidenceGapExit, createRecoveryEntryFinalizer, recoveryEntryCheck } from './paper-recovery-policy.js';
import { UPSIDE_EXIT_POLICY, validUpsideExitPolicy, upsidePositionPolicy, upsideExitText } from './paper-upside-policy.js';
import { PVP_EXIT_POLICY, CONFIRMED_PVP_EXIT_POLICY, EVIDENCE_HOLD_EXIT_POLICY, isEvidenceHold, evidenceHoldStatus, validPvpExitPolicy, pvpPositionPolicy, pvpDecision, pvpExitText } from './paper-pvp-policy.js';
import { PAPER_ENTRY_POLICY_VERSION, LEGACY_PAPER_ENTRY_POLICY_VERSION, exploratoryEntryPolicy, meetsPaperEntryFlow } from './paper-entry-policy.js';
import { paperSafetyForEntry, unavailablePaperAuditFields, paperTaxScreen } from './paper-safety-policy.js';
import { diagnosticPaperEntry, isDiagnosticPaperEntry } from './paper-diagnostic-entry.js';
import { confirmedPaperEntry, isConfirmedPaperEntry, confirmedAccountGate, CONFIRMED_PAPER_POLICY, CONTINUOUS_PAPER_VERSION, paperOperatingPolicy } from './paper-confirmed-policy.js';
import { freshNarrativeRecall } from './paper-narrative-recall.js';
import { traderDecision, compareConfirmedCandidates } from './paper-trader-reasoning.js';
import { multiOpportunityEntry, OPPORTUNITY_VERSION } from './paper-opportunity-policy.js';
import { REFERENCE_COST_VERSION, OPPORTUNITY_REVIEW_VERSION, MEME_STRUCTURE_ENTRY_VERSION, structureEconomics, assessStructureHold } from './paper-opportunity-review.js';
import { THESIS_EXIT_VERSION, THESIS_EXIT_POLICY, THESIS_EXIT_TEXT, validThesisPolicy, assessThesisExit } from './paper-thesis-exit.js';
import { MEME_EXIT_VERSION, LEGACY_MEME_EXIT_VERSION, MEME_EXIT_POLICY, MEME_EXIT_TEXT, validMemeExitPolicy, assessMemeExit } from './paper-meme-exit.js';
import { validStructureTrail } from './paper-structure-trail.js';
import {ALPHA_ENTRY_VERSION,validAlphaSignal} from './binance-alpha-catalog.js';
import {confirmAlphaQuotes} from './paper-alpha-entry.js';
import {MONITOR_ENTRY_VERSION,validMonitorSignal,confirmMonitorQuote} from './paper-monitor-signal.js';
import { buildNarrativeThesis, attachNarrativeThesis, NARRATIVE_THESIS_VERSION } from './paper-narrative-thesis.js';
import { paperCostGate } from './paper-cost-policy.js';
const MINUTE = 60_000;
const FRESH_MS = 2 * MINUTE;
const SCHEMA = 'yesp_atm_strategy_paper_v1';
const CHAINS = { sol: 'sol', solana: 'sol', eth: 'eth', ethereum: 'eth', base: 'base', bsc: 'bsc', robinhood: 'robinhood', '4663': 'robinhood' };
const STRATEGY_PRIORITY = Object.freeze(['launch_sniper', 'internal', 'narrative_pvp', 'smart_money']);
const profitTiers = Object.freeze([
  Object.freeze({ multiple: 2, fraction: .5 }),
  Object.freeze({ multiple: 5, fraction: .3 }),
  Object.freeze({ multiple: 10, fraction: .1 }),
]);

export const STRATEGY_POLICIES = Object.freeze([
  { id: 'internal', label: '内盘抢先', description: '已核实内盘阶段，盈利地址持续买入，量价同步。', entryUsd: 5, stopLoss: .18, trailingStop: .35, trailingActivation: 2, maxHoldMs: 45 * MINUTE, minLiquidity: 10_000, minBuyers: 4, minHighProfit: 3, minNetBuy: 1_000, maxMomentum: 80 },
  { id: 'smart_money', label: '聪明钱跟踪', description: '高盈利地址形成新买入共振，跟踪真实净流入。', entryUsd: 8, stopLoss: .2, trailingStop: .3, trailingActivation: 2, maxHoldMs: 4 * 60 * MINUTE, minLiquidity: 50_000, minBuyers: 6, minHighProfit: 5, minNetBuy: 5_000, maxMomentum: 40 },
  { id: 'narrative_pvp', label: '外盘叙事 PVP', description: '外盘代币绑定新鲜叙事来源，资金与量价二次确认。', entryUsd: 8, stopLoss: .2, trailingStop: .4, trailingActivation: 2, maxHoldMs: 24 * 60 * MINUTE, minLiquidity: 50_000, minBuyers: 6, minHighProfit: 3, minNetBuy: 5_000, maxMomentum: 40 },
  { id: 'launch_sniper', label: '新币狙击', description: '已知发射台早期新币，先验证买入地址和可用行情。', entryUsd: 4, stopLoss: .15, trailingStop: .35, trailingActivation: 2, maxHoldMs: 20 * MINUTE, minLiquidity: 10_000, minBuyers: 4, minHighProfit: 3, minNetBuy: 1_000, maxMomentum: 100, maxLaunchAgeMs: 15 * MINUTE },
].map(policy => Object.freeze({ ...policy, minSmartMoney: 2, profitTiers, runnerHoldMs: 7 * 24 * 60 * MINUTE,
  exploratory: Object.freeze(exploratoryEntryPolicy(policy.id)) })));

const entryPolicy = (policy, tier, version = PAPER_ENTRY_POLICY_VERSION) => tier === 'exploratory' ? { ...policy, ...exploratoryEntryPolicy(policy.id, version) } : policy;
const flowMeets = meetsPaperEntryFlow;

const finite = value => value === null || value === undefined || typeof value === 'string' && value.trim() === '' || typeof value === 'boolean' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const bool = value => value === true || value === 1 || value === '1' || value === 'true' ? true : value === false || value === 0 || value === '0' || value === 'false' ? false : null;
// GMGN risk/holder/bundler and tax fields use fractional units. Never reinterpret
// an out-of-range value as percent: e.g. rug_ratio=2 is invalid, not a safe 2%.
const rate = value => { const n = finite(value); return n === null || n < 0 || n > 1 ? null : n; };
const positive = value => { const n = finite(value); return n !== null && n > 0 ? n : null; };
const clean = value => typeof value === 'string' ? value.trim() : '';
const chainName = value => CHAINS[clean(String(value ?? '')).toLowerCase()] || null;
const time = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' || /^\d{10,13}$/.test(String(value)) ? finite(value) : null;
  const result = n === null ? Date.parse(String(value)) : n < 10_000_000_000 ? n * 1_000 : n;
  return Number.isFinite(result) ? result : null;
};
const fresh = (value, nowMs, maxAge = FRESH_MS) => { const at = time(value); return at !== null && at <= nowMs && nowMs - at <= maxAge; };
const iso = nowMs => new Date(nowMs).toISOString();
const keyOf = token => `${chainName(token?.chain)}:${chainName(token?.chain) === 'sol' ? token?.address : clean(token?.address).toLowerCase()}`;
const validAddress = (chain, address) => chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : /^0x[\da-f]{40}$/i.test(address);
const unique = values => [...new Set(values)];

function assertNow(nowMs) {
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > 8.64e15) throw new TypeError('invalid nowMs');
}

export function costAssumptions(chain, buyTax, sellTax, entryUsd, version = 'legacy_cost_v1') {
  const gasUsd = chain === 'eth' ? 2 : chain === 'sol' ? .01 : .02;
  const feeRate = version === REFERENCE_COST_VERSION ? .01 : .003;
  const slippageRate = .01;
  const notionalUsd = buyTax === null ? null : Math.max(0, (entryUsd - gasUsd) / (1 + feeRate + slippageRate + buyTax));
  const estimatedRoundTripCost = notionalUsd === null || sellTax === null ? null
    : entryUsd - notionalUsd + notionalUsd * (feeRate + slippageRate + sellTax) + gasUsd;
  return { version, source: 'assumption', label: version === REFERENCE_COST_VERSION ? 'GMGN 单边 1% 费用参考；滑点 1% 与分链 gas 仍为假设，非路由报价或实测成交' : '模拟成本假设，非实际报价', feeBps: feeRate*10000, slippageBps: 100, feeRate, slippageRate, gasUsd, buyTax, sellTax, notionalUsd, estimatedRoundTripCost, estimatedRoundTripCostRate: estimatedRoundTripCost === null || entryUsd <= 0 ? null : estimatedRoundTripCost / entryUsd };
}

function safety(token, chain) {
  const missing = [], blocked = [];
  const check = (value, expected, label) => {
    const flag = bool(value);
    if (flag === null) missing.push(label);
    else if (flag !== expected) blocked.push(`${label}未通过`);
  };
  if (chain === 'sol') {
    check(token.renouncedMint, true, '增发权限已撤销');
    check(token.renouncedFreezeAccount, true, '冻结权限已撤销');
    if (bool(token.isHoneypot) === true) blocked.push('存在貔貅标记');
  } else check(token.isHoneypot, false, '可卖出检测');
  check(token.isWashTrading, false, '洗量检测');
  const taxFilter = paperTaxScreen(token);
  missing.push(...taxFilter.missing); blocked.push(...taxFilter.reasons);
  const metrics = { rugRatio: rate(token.rugRatio), top10HolderRate: rate(token.top10HolderRate), devTeamHoldRate: rate(token.devTeamHoldRate), bundlerRate: rate(token.bundlerRate), buyTax: taxFilter.buyTax, sellTax: taxFilter.sellTax };
  for (const [key, label, threshold] of [['rugRatio', '撤池风险比', .3], ['top10HolderRate', 'Top10 集中度', .6], ['devTeamHoldRate', '开发团队持仓', .2], ['bundlerRate', '打包买入占比', .3]]) {
    if (metrics[key] === null) missing.push(label);
    else if (metrics[key] >= threshold) blocked.push(`${label}超过筛选线`);
  }
  for (const [key, label] of [['cannotSell', '禁止卖出'], ['isBlacklisted', '黑名单'], ['canMint', '可任意增发'], ['canFreeze', '可任意冻结'], ['canPause', '可任意暂停'], ['fakePool', '池子真实性异常']]) {
    if (bool(token[key]) === true) blocked.push(label);
  }
  if (finite(token.liquidity) === 0) blocked.push('流动性为零');
  return { missing, blocked, metrics, taxFilter, ...(token.sellabilityFlags?{sellabilityFlags:structuredClone(token.sellabilityFlags)}:{}),
    coverage: '使用已接入字段筛选，非完整合约审计；Top10 是集中度代理' };
}

export function evaluatePaperStrategies({ token = {}, marketStatus, observedAt, priceObservedAt = observedAt, requireFastQuote = false, narrativeResearchIndex = null,
  flow = {}, narrative = {}, narrativeRecall = null, alphaSignal = null, monitorSignal = null, candles = [], klineStatus, allowExploratory = false, compoundingCash = null, fixedEntryUsd = null, upsideMode = false, pvpMode = false, diagnosticMode = false, confirmedMode = false, evidenceHoldMode = false, continuousPaperMode = false, opportunityMode = false, opportunityReviewMode = true, memeExitMode = false, recoveryMode = false, opportunityAccount = null, quoteHistory = [], nowMs = Date.now() } = {}) {
  assertNow(nowMs);
  if(typeof recoveryMode!=='boolean'||recoveryMode&&!memeExitMode)throw new TypeError('recovery requires meme paper main');
  if (typeof upsideMode !== 'boolean') throw new TypeError('invalid upside mode');
  if (typeof pvpMode !== 'boolean' || pvpMode && upsideMode) throw new TypeError('invalid pvp mode');
  if (typeof diagnosticMode !== 'boolean' || diagnosticMode && (!pvpMode || !allowExploratory)) throw new TypeError('diagnostic entries require exploratory paper PVP');
  if (typeof confirmedMode !== 'boolean' || confirmedMode && (!pvpMode || !allowExploratory || diagnosticMode)) throw new TypeError('invalid confirmed paper mode');
  if (typeof evidenceHoldMode !== 'boolean' || evidenceHoldMode && !confirmedMode) throw new TypeError('evidence hold requires confirmed paper mode');
  if (typeof continuousPaperMode !== 'boolean' || continuousPaperMode && !confirmedMode) throw new TypeError('continuous mode requires confirmed paper mode');
  if (typeof opportunityMode !== 'boolean' || opportunityMode && (!confirmedMode || !evidenceHoldMode)) throw new TypeError('multi setup requires confirmed evidence-hold paper mode');
  if (typeof memeExitMode !== 'boolean' || memeExitMode && (!opportunityMode || !continuousPaperMode || !opportunityReviewMode)) throw new TypeError('meme entry requires continuous reviewed paper mode');
  if (fixedEntryUsd !== null && (fixedEntryUsd !== PAPER_FIXED_ENTRY_USD || !confirmedMode || compoundingCash === null)) throw new TypeError('fixed paper ticket requires confirmed mode and cash');
  const exitProfile = evidenceHoldMode ? EVIDENCE_HOLD_EXIT_POLICY : confirmedMode ? CONFIRMED_PVP_EXIT_POLICY : pvpMode ? PVP_EXIT_POLICY : upsideMode ? UPSIDE_EXIT_POLICY : null;
  const chain = chainName(token.chain);
  const address = clean(token.address);
  const stage = ['internal', 'near_completion', 'external'].includes(token.marketStage) ? token.marketStage : 'unknown';
  const sourceSafety = safety(token, chain);
  const limitedAuditExperiment = allowExploratory === true && pvpMode && unavailablePaperAuditFields(token, sourceSafety).length > 0;
  const price = positive(token.price);
  const marketFresh = marketStatus === 'ok' && fresh(observedAt, nowMs);
  const priceFresh = fresh(priceObservedAt, nowMs, pvpMode ? PVP_EXIT_POLICY.entryQuoteMaxAgeMs : requireFastQuote ? 15_000 : 120_000);
  const flowFresh = flow.fresh === true && flow.complete === true && ['healthy', 'ok'].includes(flow.status) && !flow.coverageGap && fresh(flow.observedAt, nowMs);
  const flowMetrics = Object.fromEntries(['highProfitCount', 'fomoCount', 'uniqueBuyerCount', 'netBuyUsd', 'smartMoneyCount'].map(key => [key, finite(flow[key])]));
  // Binance does not supply a FOMO tag. It stays unknown, not a fabricated zero;
  // none of these paper lanes has a FOMO minimum. Profit/buyer/net gates remain.
  const fomoUnavailable = flow.fomoSupported === false && ['binance_smartmoney', 'binance_kol'].includes(flow.provider);
  const flowValid = Object.entries(flowMetrics).every(([key, value]) => key === 'fomoCount' && fomoUnavailable && value === null
    || value !== null && (key === 'netBuyUsd' || Number.isInteger(value) && value >= 0));
  const chart = analyzePaperChart({ candles, klineStatus, nowMs });
  const liquidity = finite(token.liquidity);
  const volume = finite(token.volume) !== null
    ? { value: finite(token.volume), window: clean(token.volumeWindow || token.volumeInterval) || 'market_interval_unspecified' }
    : finite(token.volume1h) !== null ? { value: finite(token.volume1h), window: '1h' }
      : finite(token.volume24h) !== null ? { value: finite(token.volume24h), window: '24h' } : { value: null, window: null };
  const sourceUrl = clean(narrative.sourceUrl);
  const narrativeAddress = clean(narrative.address || narrative.tokenAddress);
  const narrativeMatches = chainName(narrative.chain) === chain && narrativeAddress.length > 0 && keyOf({ chain: narrative.chain, address: narrativeAddress }) === keyOf({ chain, address });
  const narrativeFresh = ['sourced', 'verified'].includes(narrative.status) && narrative.caBound === true && narrativeMatches && Boolean(clean(narrative.text)) && /^https?:\/\//.test(sourceUrl) && fresh(narrative.sourceAt, nowMs, 24 * 60 * MINUTE);
  const narrativeAssessment = assessPaperNarrative({ narrative, chain, address, nowMs });
  const createdAt = time(token.creationTimestamp ?? token.openTimestamp);
  const launchAgeMs = createdAt !== null && createdAt <= nowMs ? nowMs - createdAt : null;
  // These modes use only the smart-money lane; do not calculate three discarded lanes.
  const activePolicies = diagnosticMode || confirmedMode ? STRATEGY_POLICIES.filter(p => p.id === 'smart_money') : STRATEGY_POLICIES;
  return activePolicies.map(standard => {
    // A smaller paper experiment, not an assertion that unprofiled wallets are
    // profitable. Strong signals retain their original policy and budget.
    const entryTier = allowExploratory === true && (confirmedMode || diagnosticMode || limitedAuditExperiment || !(flowValid && flowMeets(flowMetrics, standard) && liquidity >= standard.minLiquidity)) ? 'exploratory' : 'standard';
    const safetyResult = paperSafetyForEntry(token, sourceSafety, limitedAuditExperiment && entryTier === 'exploratory');
    const basePolicy = entryPolicy(standard, entryTier);
    const positionSizing = compoundingCash === null ? null : paperPositionSize({ cash: compoundingCash, liquidity, baseEntryUsd: basePolicy.entryUsd, fixedEntryUsd, recoverySizing:recoveryMode });
    const policy = compoundingCash === null ? basePolicy : { ...basePolicy, entryUsd: positionSizing?.budgetUsd || 0 };
    const missing = [...safetyResult.missing], reasons = [], blocked = [...safetyResult.blocked];
    if (!chain || !validAddress(chain, address)) missing.push('有效链和合约地址');
    if (compoundingCash !== null && (!positionSizing || positionSizing.budgetUsd <= 0)) missing.push(fixedEntryUsd !== null ? '可用余额及流动性额度须足够固定 10 U' : '有效可用余额与流动性对应的滚仓预算');
    if (!marketFresh) missing.push('两分钟内的真实行情');
    if (price === null) missing.push('有效正数价格');
    if ((requireFastQuote || pvpMode) && !priceFresh) missing.push(pvpMode ? '五秒内的独立报价' : '十五秒内的独立报价');
    if (!flowFresh) missing.push('完整且新鲜的买入资金流');
    if (!flowValid) missing.push('盈利地址、FOMO、独立买家与净流入数据');
    if (flowValid && ['highProfitCount', 'fomoCount', 'smartMoneyCount'].some(key => flowMetrics[key] > flowMetrics.uniqueBuyerCount)) missing.push('一致的独立买入地址统计');
    if (!chart.ready) missing.push(CHART_MISSING);
    if (chart.ready && createdAt !== null && chart.rows[0].time < createdAt) missing.push('K 线早于代币创建时间，来源待核对');
    if (stage === 'unknown') missing.push('已核实内外盘阶段');
    if (token.stageConflict === true) missing.push('内外盘来源冲突待核对');
    if (liquidity === null) missing.push('真实流动性');
    else if (liquidity < policy.minLiquidity) reasons.push(`流动性低于 $${policy.minLiquidity.toLocaleString('en-US')}`);
    if (volume.value === null) missing.push('真实成交量');
    else if (volume.value <= 0) reasons.push('缺少成交量确认');
    if (flowValid && !flowMeets(flowMetrics, policy)) reasons.push(`资金流未达${entryTier === 'exploratory' ? '探索' : '标准'}门槛：净买家 ${flowMetrics.uniqueBuyerCount}/${policy.minBuyers}、聪明钱标签或盈利地址 ${flowMetrics.smartMoneyCount}/${policy.minSmartMoney}、核实盈利 ${flowMetrics.highProfitCount}/${policy.minHighProfit}、净流入 $${flowMetrics.netBuyUsd.toFixed(2)}/$${policy.minNetBuy}`);
    if (chart.ready && chart.change > policy.maxMomentum) reasons.push('短线涨速超出当前入场窗口');
    if (policy.id === 'internal' && !['internal', 'near_completion'].includes(stage)) reasons.push('等待已核实内盘或临毕业标的');
    if (policy.id === 'narrative_pvp') {
      if (stage !== 'external') reasons.push('叙事 PVP 只评估已核实外盘');
      if (!narrativeFresh) missing.push('绑定精确 CA 的新鲜叙事来源');
      if (!narrativeAssessment.eligible) missing.push(...narrativeAssessment.gaps);
    }
    if (policy.id === 'launch_sniper') {
      if (!clean(token.launchpadPlatform || token.launchpad)) missing.push('已知发射台');
      if (launchAgeMs === null) missing.push('可信创建时间');
      else if (launchAgeMs > policy.maxLaunchAgeMs) reasons.push('已超过早期狙击窗口');
    }
    const costs = costAssumptions(chain, safetyResult.metrics.buyTax, safetyResult.metrics.sellTax, policy.entryUsd, opportunityMode ? REFERENCE_COST_VERSION : 'legacy_cost_v1');
    if (costs.estimatedRoundTripCostRate !== null && costs.estimatedRoundTripCostRate > .15) reasons.push('估算往返成本超过本金的 15%');
    const entryPlan = { ...buildPaperEntryPlan({ chart, price, policy, costs }),
      ...(exitProfile ? { targetRole: 'structure_reference_only', exitPolicyVersion: exitProfile.version } : {}) };
    if (exitProfile) for (const field of ['targetKind', 'summary']) {
      if (typeof entryPlan[field] === 'string') entryPlan[field] = entryPlan[field].replace('首档封顶 2 倍入场价', '局部参考位最多 2 倍入场价，不限制持仓倍数');
    }
    if (chart.ready) reasons.push(...entryPlan.reasons);
    const eligible = !blocked.length && !missing.length && !reasons.length;
    const decision = blocked.length ? '不买' : eligible ? '可模拟' : '观察';
    const entryLogic = `${pvpMode ? '短线 PVP：新鲜报价确认突破/回踩，快速检验后续买盘；不为凑交易笔数入场。' : upsideMode ? '目标为捕捉大行情：按真实突破/回踩结构入场；参考目标只检验局部空间，不自动小幅止盈，也不预测未来倍数。' : ''}${entryTier === 'exploratory' ? '小额探索试仓 v2：允许单个聪明钱净买家，单钱包不是多地址共振；盈利画像不设最低人数，标签不代表已核实盈利；仅用真实净买入与量价结构做模拟实验。' : policy.description} 门槛：流动性 ≥ $${policy.minLiquidity}、高盈利新买地址 ≥ ${policy.minHighProfit}、独立净买家 ≥ ${policy.minBuyers}、聪明钱标签或盈利地址 ≥ ${policy.minSmartMoney}、净流入 ≥ $${policy.minNetBuy}。${entryPlan.summary}`;
    const auditNote = safetyResult.auditMissing.length ? ` 辅助字段未核实：${safetyResult.auditMissing.join('、')}；本单仅为小额 PVP 模拟，不标为审计通过。` : '';
    const exitLogic = pvpMode ? pvpExitText(priceText(entryPlan.stopPrice), policy.stopLoss) : upsideMode ? upsideExitText(priceText(entryPlan.stopPrice), policy.stopLoss, policy.maxHoldMs)
      : `结构止损 ${priceText(entryPlan.stopPrice)}，硬止损上限 ${Math.round(policy.stopLoss * 100)}%；首档 ${priceText(entryPlan.targetPrice)} 兑现原仓 20%，2/5/10 倍再兑现 30%/30%/10%，留 10% 尾仓；首档兑现或达到 1.5 倍后保护剩余本金与模拟成本；2 倍后回撤 ${Math.round(policy.trailingStop * 100)}% 退出；完整资金流连续两次确认聪明钱净卖出时退出。未达 2 倍最长 ${Math.round(policy.maxHoldMs / MINUTE)} 分钟，尾仓最长 7 天。`;
    const result = {
      strategyId: policy.id, label: policy.label, entryTier, decision, reasons: unique(blocked.length ? [...blocked, ...reasons] : eligible ? [entryTier === 'exploratory' ? '来源完整、净买入信号和量价窗口达到小额模拟条件' : '来源完整、买入地址共振和量价窗口达到模拟条件'] : reasons), missing: unique(missing), entryUsd: policy.entryUsd,
      score: blocked.length ? 0 : Math.max(0, Math.min(100, 100 - missing.length * 10 - reasons.length * 15)), entryLogic: entryLogic + auditNote, exitLogic,
      token: { chain, address, symbol: clean(token.symbol) || '未知', price }, observedAt: priceFresh ? iso(time(priceObservedAt)) : priceObservedAt ?? null,
      evidence: { version: STRATEGY_ANALYSIS_VERSION, entryPolicyVersion: PAPER_ENTRY_POLICY_VERSION, entryTier,
        ...(exitProfile ? { exitPolicy: structuredClone(exitProfile) } : {}), ...(positionSizing ? { positionSizing } : {}),
        entryThresholds: { minBuyers: policy.minBuyers, minHighProfit: policy.minHighProfit, minSmartMoney: policy.minSmartMoney, minNetBuy: policy.minNetBuy, minLiquidity: policy.minLiquidity },
        paperEligible: eligible, marketFresh, priceFresh, priceObservedAt, marketObservedAt: observedAt, requireFastQuote,
        marketStage: stage, liquidity, flowFresh, flow: flowMetrics, volume,
        flowDiagnostics: { coverageGap: flow.coverageGap || null, scope: flow.scope || null, provider: flow.provider || 'gmgn', providerLabel: flow.providerLabel || 'GMGN',
          fomoSupported: !fomoUnavailable, evidenceScope: flow.evidenceScope || null, profileCheckedCount: finite(flow.profileCheckedCount), complete: flow.complete === true,
          observedAt: flow.observedAt || null, sourceStatus: flow.sourceStatus || flow.status || null,
          sourceIssue: flow.sourceIssue || null, sources: structuredClone(flow.sources || []),
          profileNote: '平台标签不等于已核实盈利；缺少盈利画像不抹去有效逐笔买卖，过期或断档不用于入场' },
        chart: { ...chart, rows: undefined, previous: undefined, last: undefined }, entryPlan, narrativeAssessment,
        narrativeFresh, narrativeSource: narrativeFresh ? sourceUrl : null, narrativeText: narrativeFresh ? clean(narrative.text) : null, launchAgeMs, safety: safetyResult, costAssumptions: costs },
    };
    const finalizeRoute = recoveryMode ? createRecoveryEntryFinalizer({observedAt,flow,candles,klineStatus,quoteHistory,nowMs,memeExitMode}) : null;
    const evaluated = opportunityMode ? multiOpportunityEntry(result, { token, candles, klineStatus, sourceSafety, pulse:flow.pulse, quoteHistory, narrativeRecall, alphaSignal, monitorSignal, continuousPaperMode, opportunityReviewMode, memeExitMode, opportunityAccount, nowMs, finalizeRoute })
      : confirmedMode ? confirmedPaperEntry(result, { sourceSafety, pulse: flow.pulse, quoteHistory, narrativeRecall, continuousPaperMode, nowMs }) : diagnosticMode ? diagnosticPaperEntry(result, sourceSafety) : result;
    const recovered=finalizeRoute&&!opportunityMode?finalizeRoute(evaluated):evaluated;
    return recoveryMode&&narrativeResearchIndex?attachNarrativeThesis(recovered,buildNarrativeThesis({token,narrative,monitorSignal,alphaSignal,
      index:narrativeResearchIndex,flow,candles,klineStatus,nowMs})):recovered;
  });
}

export function createPaperStrategyAccount({ initialCash = 100, nowMs = Date.now() } = {}) {
  assertNow(nowMs);
  if (typeof initialCash !== 'number' || !Number.isFinite(initialCash) || initialCash <= 0) throw new TypeError('invalid initialCash');
  return { schema: SCHEMA, mode: 'paper', execution: false, signing: false, broadcast: false, initialCash, cash: initialCash, realizedPnl: 0, positions: {}, trades: [], cooldowns: {}, stats: { entries: 0, exits: 0, wins: 0, losses: 0, realizedPnl: 0, dailyRealizedPnl: 0, equity: initialCash, openPositions: 0 }, updatedAt: iso(nowMs) };
}

export function validatePaperStrategyAccount(account) {
  if (!account || account.schema !== SCHEMA || account.mode !== 'paper' || account.execution !== false || account.signing !== false || account.broadcast !== false) throw new TypeError('paper account required');
  if (account.variant !== undefined && !['distilled_shadow', 'learning_control'].includes(account.variant)) throw new TypeError('invalid paper variant');
  if (account.exitExperimentVersion !== undefined && (account.exitExperimentVersion !== THESIS_EXIT_VERSION || account.variant)) throw new TypeError('invalid exit experiment account');
  if (account.memeExitActivation && (![MEME_EXIT_VERSION,LEGACY_MEME_EXIT_VERSION].includes(account.memeExitActivation.version) || account.variant
    || time(account.memeExitActivation.activatedAt)===null || !Number.isInteger(account.memeExitActivation.baselineTradeCount)
    || account.memeExitActivation.baselineTradeCount<0 || account.memeExitActivation.baselineTradeCount>account.trades?.length)) throw new TypeError('invalid meme exit activation');
  if (typeof account.initialCash !== 'number' || !positive(account.initialCash) || typeof account.cash !== 'number' || finite(account.cash) === null || account.cash < 0 || typeof account.realizedPnl !== 'number' || finite(account.realizedPnl) === null || !account.positions || Array.isArray(account.positions) || !Array.isArray(account.trades) || !account.stats || time(account.updatedAt) === null) throw new TypeError('invalid paper account');
  for (const field of ['entries', 'exits', 'wins', 'losses']) if (!Number.isInteger(account.stats[field]) || account.stats[field] < 0) throw new TypeError('invalid paper stats');
  for (const value of Object.values(account.stats)) if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('invalid paper stats number');
  // Frozen continuous-mode lots remain manageable after a restart or rollback.
  // The legacy cap applies only to lots that were opened under the legacy policy.
  if (Object.values(account.positions).filter(p => p.entryEvidence?.accountPolicy?.version !== CONTINUOUS_PAPER_VERSION).length > 2) throw new TypeError('too many paper positions');
  for (const value of Object.values(account.cooldowns || {})) if (!Number.isFinite(value) || value < 0) throw new TypeError('invalid paper cooldown');
  for (const [key, position] of Object.entries(account.positions)) {
    if (position.memeExitPolicy && (!account.memeExitActivation || position.exitExperiment || account.variant
      || !validMemeExitPolicy(position.memeExitPolicy) || !validMemeExitPolicy(position.entryEvidence?.memeExitPolicy)
      || position.memeExitPolicy.version!==position.entryEvidence.memeExitPolicy.version
      || !isConfirmedPaperEntry(position.entryEvidence) || time(position.openedAt)<time(account.memeExitActivation.activatedAt))) throw new TypeError('invalid meme exit policy');
    if (position.entryEvidence?.memeExitPolicy && !position.memeExitPolicy) throw new TypeError('missing effective meme exit policy');
    if(position.structureTrail && (position.memeExitPolicy?.version!==MEME_EXIT_VERSION
      || !validStructureTrail(position.structureTrail,position)))throw new TypeError('invalid confirmed structure trail');
    const entryVersion=position.entryEvidence?.entryPlan?.entryPolicyVersion;
    const alphaEntry=entryVersion===ALPHA_ENTRY_VERSION;
    const monitorEntry=entryVersion===MONITOR_ENTRY_VERSION;
    if (entryVersion && (![MEME_STRUCTURE_ENTRY_VERSION,ALPHA_ENTRY_VERSION,MONITOR_ENTRY_VERSION].includes(entryVersion)
      || !position.memeExitPolicy || position.entryEvidence.opportunity?.entryPolicyVersion!==entryVersion)) throw new TypeError('invalid meme entry policy');
    if(alphaEntry&&(!validAlphaSignal(position.entryEvidence.opportunity?.event,position,time(position.openedAt))
      ||position.entryEvidence.opportunity?.basis!=='official_event'||position.entryEvidence.opportunity?.id!=='alpha_listing'
      ||position.entryEvidence.entryPlan.stopPrice!==null||position.entryEvidence.entryPlan.targetPrice!==null))throw new TypeError('invalid Alpha entry evidence');
    if(monitorEntry&&(!validMonitorSignal(position.entryEvidence.opportunity?.event,position,time(position.openedAt))
      ||position.entryEvidence.opportunity?.basis!=='monitored_event'||position.entryEvidence.opportunity?.id!=='monitored_event'
      ||position.entryEvidence.entryPlan.stopPrice!==null||position.entryEvidence.entryPlan.targetPrice!==null))throw new TypeError('invalid monitored entry evidence');
    const memeContext=position.entryEvidence?.memeExitContext;
    if(position.memeExitPolicy&&memeContext&&(!Array.isArray(memeContext.smartBuyers)||memeContext.smartBuyers.length>200
      ||memeContext.smartBuyers.some(w=>typeof w!=='string'||!validAddress(chainName(position.chain),w))
      ||new Set(memeContext.smartBuyers).size!==memeContext.smartBuyers.length
      ||!Array.isArray(memeContext.narrativeSourceIds)||memeContext.narrativeSourceIds.some(s=>typeof s!=='string')
      ||typeof memeContext.cohortKnown!=='boolean'||memeContext.provider!==(position.entryEvidence?.flowDiagnostics?.provider||'gmgn')
      ||memeContext.cohortKnown&&(time(memeContext.observedAt)===null||time(memeContext.observedAt)>time(position.openedAt))))throw new TypeError('invalid meme entry context');
    if (position.exitExperiment && (account.exitExperimentVersion !== THESIS_EXIT_VERSION || !validThesisPolicy(position.exitExperiment)
      || !validThesisPolicy(position.entryEvidence?.exitExperiment) || !isConfirmedPaperEntry(position.entryEvidence))) throw new TypeError('exit experiment must stay in its isolated paper account');
    if (position.entryEvidence?.exitExperiment && !position.exitExperiment) throw new TypeError('missing effective experimental exit policy');
    if (position.thesisFlowWatch && ((!position.exitExperiment && !position.memeExitPolicy) || ![1, 2].includes(position.thesisFlowWatch.count)
      || time(position.thesisFlowWatch.firstAt) === null || time(position.thesisFlowWatch.lastAt) < time(position.thesisFlowWatch.firstAt))) throw new TypeError('invalid experimental flow confirmation');
    if(position.memeExitPolicy&&position.thesisFlowWatch&&(!position.thesisFlowWatch.amounts
      ||Object.values(position.thesisFlowWatch.amounts).some(n=>!Number.isFinite(n)||n<0)))throw new TypeError('invalid meme sell confirmation');
    const operating = position.entryEvidence?.accountPolicy;
    if (operating && (operating.version !== CONTINUOUS_PAPER_VERSION || operating.mode !== 'paper' || operating.continuous !== true
      || operating.execution !== false || operating.signing !== false || operating.broadcast !== false
      || !isConfirmedPaperEntry(position.entryEvidence) || account.variant)) throw new TypeError('invalid continuous paper position');
    if (position.entryEvidence?.confirmedPolicy && (!isConfirmedPaperEntry(position.entryEvidence) || account.variant
      || ![CONFIRMED_PVP_EXIT_POLICY.version, EVIDENCE_HOLD_EXIT_POLICY.version,'structure_hold_v2'].includes(position.pvpPolicy?.version))) throw new TypeError('invalid confirmed paper position');
    if (isEvidenceHold(position.pvpPolicy) && (!isConfirmedPaperEntry(position.entryEvidence) || account.variant)) throw new TypeError('evidence hold is confirmed paper-main only');
    if (position.pvpPolicy?.version==='structure_hold_v2' && (position.entryEvidence.opportunity?.version!==OPPORTUNITY_VERSION
      || position.entryEvidence.opportunity?.reviewVersion!==OPPORTUNITY_REVIEW_VERSION || position.entryEvidence.opportunity?.basis!=='ohlcv'
      || !positive(position.entryEvidence.opportunity?.pattern?.atr))) throw new TypeError('invalid reviewed structure evidence');
    if (position.entryEvidence?.diagnostic && (!isDiagnosticPaperEntry(position.entryEvidence) || account.variant || !position.pvpPolicy)) throw new TypeError('invalid paper diagnostic position');
    if (account.variant === 'distilled_shadow' && !position.distilledHabit) throw new TypeError('missing distilled paper habit');
    if (position.distilledHabit && (account.variant !== 'distilled_shadow' || !validLearningPolicy(position.distilledHabit, position.chain, time(position.openedAt)))) throw new TypeError('invalid distilled paper habit');
    if (keyOf(position) !== key || !validAddress(chainName(position.chain), position.address) || !STRATEGY_POLICIES.some(policy => policy.id === position.strategyId) || !positive(position.quantity) || !positive(position.initialQuantity) || !positive(position.entryPrice) || !positive(position.costBasisUsd) || finite(position.markPrice) === null || position.markPrice < 0 || !positive(position.peakPrice) || time(position.openedAt) === null || time(position.markAt) === null || !Array.isArray(position.profitTiersTaken) || finite(position.realizedPnl) === null) throw new TypeError('invalid paper position');
    for (const field of ['feeRate', 'slippageRate', 'sellTax', 'gasUsd']) if (!Number.isFinite(position.costAssumptions?.[field]) || position.costAssumptions[field] < 0 || field !== 'gasUsd' && position.costAssumptions[field] > 1) throw new TypeError('invalid paper position costs');
    for (const field of ['quantity', 'initialQuantity', 'entryPrice', 'entryUsd', 'costBasisUsd', 'markPrice', 'peakPrice', 'realizedPnl']) if (!Number.isFinite(position[field])) throw new TypeError('invalid paper position number');
    if (position.entryEvidence?.entryTier != null && !['standard', 'exploratory'].includes(position.entryEvidence.entryTier)) throw new TypeError('invalid paper entry tier');
    if(position.evidenceGapPolicy && (!position.memeExitPolicy||!validEvidenceGapPolicy(position.evidenceGapPolicy)
      ||!Number.isFinite(time(position.evidenceGapActivatedAt))||time(position.evidenceGapActivatedAt)<time(position.openedAt)))throw new TypeError('invalid evidence recovery policy');
    if(position.evidenceGap && (!position.evidenceGapPolicy||position.evidenceGap.version!==position.evidenceGapPolicy.version
      ||!Number.isFinite(position.evidenceGap.since)||!Number.isFinite(position.evidenceGap.lastObservedAt)
      ||position.evidenceGap.since<time(position.evidenceGapActivatedAt)||position.evidenceGap.lastObservedAt<position.evidenceGap.since
      ||!Number.isSafeInteger(position.evidenceGap.observations)||position.evidenceGap.observations<1))throw new TypeError('invalid evidence gap observation');
    const size = position.entryEvidence?.positionSizing;
    if (size?.version === PAPER_FIXED_SIZING_VERSION && (!isConfirmedPaperEntry(position.entryEvidence) || account.variant)) throw new TypeError('fixed ticket outside confirmed main account');
    if (size && !validPaperPositionSize(size, entryPolicy(STRATEGY_POLICIES.find(p => p.id === position.strategyId), position.entryEvidence?.entryTier).entryUsd,
      position.entryUsd, position.entryEvidence.liquidity)) throw new TypeError('invalid compounding budget');
    if (position.entryEvidence?.entryTier === 'exploratory' && ((!size && position.entryUsd > 2) || ![PAPER_ENTRY_POLICY_VERSION, LEGACY_PAPER_ENTRY_POLICY_VERSION].includes(position.entryEvidence.entryPolicyVersion))) throw new TypeError('invalid exploratory budget');
    if (position.pvpPolicy || position.entryEvidence?.exitPolicy?.mode === 'pvp') {
      if (account.variant || position.upsidePolicy || !validPvpExitPolicy(position.pvpPolicy) || !validPvpExitPolicy(position.entryEvidence?.exitPolicy)
        || position.entryEvidence.exitPolicy.version !== position.pvpPolicy.version
        || !position.exitPlan || position.pvpPolicy.version !== 'structure_hold_v2' && position.firstTargetTaken !== false
        || position.entryEvidence.entryPlan?.exitPolicyVersion !== position.pvpPolicy.version
        || position.entryEvidence.entryPlan?.targetRole !== 'structure_reference_only'
        || !positive(position.pvpLastQuote?.price) || position.pvpLastQuote.price !== position.markPrice || time(position.pvpLastQuote?.observedAt) !== time(position.markAt)
        || position.pvpRunnerStartedAt != null && (time(position.pvpRunnerStartedAt) === null || time(position.pvpRunnerStartedAt) < time(position.openedAt)
          || time(position.pvpRunnerStartedAt) > time(position.markAt) || position.quantity > position.initialQuantity * (.2 + 1e-10))) throw new TypeError('invalid pvp exit policy');
    } else if (position.upsidePolicy || position.entryEvidence?.exitPolicy) {
      if (account.variant || !validUpsideExitPolicy(position.upsidePolicy) || !validUpsideExitPolicy(position.entryEvidence?.exitPolicy)
        || !position.exitPlan || position.firstTargetTaken !== false
        || position.entryEvidence.entryPlan?.exitPolicyVersion !== position.upsidePolicy.version
        || position.entryEvidence.entryPlan?.targetRole !== 'structure_reference_only') throw new TypeError('invalid upside exit policy');
    }
    const profile = position.pvpPolicy || position.upsidePolicy;
    const allowedTiers = profile ? profile.profitTiers.map(tier => tier.multiple) : [2, 5, 10];
    if (position.quantity > position.initialQuantity || position.costBasisUsd > position.entryUsd || position.profitTiersTaken.some(value => !allowedTiers.includes(value)) || new Set(position.profitTiersTaken).size !== position.profitTiersTaken.length) throw new TypeError('invalid paper profit accounting');
    if (position.exitPlan) {
      if(alphaEntry||monitorEntry){
        if(position.exitPlan.version!==STRATEGY_ANALYSIS_VERSION||position.exitPlan.initialStopPrice!==null
          ||position.exitPlan.referenceTargetPrice!==null||position.activeStopPrice!==null
          ||position.profitProtectionArmed!==false||position.firstTargetTaken!==false)throw new TypeError('invalid Alpha exit references');
      } else if (position.exitPlan.version !== STRATEGY_ANALYSIS_VERSION || !positive(position.exitPlan.initialStopPrice) || position.exitPlan.initialStopPrice >= position.entryPrice
        || !positive(position.exitPlan.referenceTargetPrice) || position.exitPlan.referenceTargetPrice <= position.entryPrice || position.exitPlan.referenceTargetPrice > position.entryPrice * 2
        || !positive(position.activeStopPrice) || position.activeStopPrice < position.exitPlan.initialStopPrice || position.activeStopPrice >= position.peakPrice
        || typeof position.profitProtectionArmed !== 'boolean' || typeof position.firstTargetTaken !== 'boolean') throw new TypeError('invalid structural exit plan');
      const watch = position.flowExitWatch;
      if (watch && (!Number.isInteger(watch.count) || watch.count < 1 || watch.count > 2 || time(watch.firstAt) === null || time(watch.lastAt) < time(watch.firstAt))) throw new TypeError('invalid flow exit confirmation');
    }
  }
  for (const trade of account.trades) {
    for (const field of ['quantity', 'price', 'grossUsd', 'costsUsd', 'netUsd', 'costBasisUsd', 'realizedPnl', 'atMs']) if (!Number.isFinite(trade[field])) throw new TypeError('invalid paper trade');
    if (!['buy', 'sell', 'writeoff'].includes(trade.side)) throw new TypeError('invalid paper trade side');
  }
  const adjustments = account.cashAdjustments ?? [];
  if (!Array.isArray(adjustments)) throw new TypeError('invalid paper cash adjustments');
  const ids = new Set(); let funding = 0;
  for (const item of adjustments) {
    if (!item || !/^[a-z0-9_-]{8,80}$/.test(item.id) || ids.has(item.id)
      || item.kind !== 'manual_paper_cash_reset' || !Number.isFinite(item.amountUsd)
      || !Number.isFinite(item.cashBefore) || item.cashBefore < 0 || item.cashAfter !== 100
      || Math.abs(item.cashAfter - item.cashBefore - item.amountUsd) > 1e-7
      || time(item.at) === null || !Number.isInteger(item.tradeCount)
      || item.tradeCount < 0 || item.tradeCount > account.trades.length) throw new TypeError('invalid paper cash adjustment');
    ids.add(item.id); funding += item.amountUsd;
  }
  const basis = Object.values(account.positions).reduce((sum, position) => sum + position.costBasisUsd, 0);
  if (!Number.isFinite(funding) || Math.abs(account.cash + basis - account.initialCash - funding - account.realizedPnl) > Math.max(1e-7, account.initialCash * 1e-10)) throw new TypeError('paper balance does not reconcile');
  return true;
}

/** Explicit user-requested paper funding, never a fill or trading profit. */
export function resetPaperCash(account, { operationId, nowMs = Date.now() } = {}) {
  validatePaperStrategyAccount(account); assertNow(nowMs);
  if (account.variant || account.exitExperimentVersion) throw new TypeError('main paper account required');
  if (typeof operationId !== 'string' || !/^[a-z0-9_-]{8,80}$/.test(operationId)) throw new TypeError('invalid reset id');
  if (account.cashAdjustments?.some(item => item.id === operationId)) return structuredClone(account);
  if (Object.keys(account.positions).length) throw new Error('仅空仓时可重置模拟余额；不自动平仓');
  if (nowMs < time(account.updatedAt)) throw new Error('invalid reset time');
  const next = structuredClone(account), amountUsd = 100 - account.cash;
  next.cashAdjustments = [...(next.cashAdjustments || []), { id: operationId, kind: 'manual_paper_cash_reset',
    amountUsd, cashBefore: account.cash, cashAfter: 100, tradeCount: account.trades.length, at: iso(nowMs) }];
  next.cash = 100; next.updatedAt = iso(nowMs);
  next.stats.equity = 100;
  if (next.stats.netLiquidationValue !== undefined) next.stats.netLiquidationValue = 100;
  validatePaperStrategyAccount(next);
  return next;
}

function sell(account, key, quantity, markPrice, reason, nowMs, { writeoff = false } = {}) {
  const position = account.positions[key];
  const amount = Math.min(position.quantity, quantity);
  const ratio = amount / position.quantity;
  const basis = position.costBasisUsd * ratio;
  const gross = amount * markPrice;
  const costs = writeoff ? 0 : gross * (position.costAssumptions.feeRate + position.costAssumptions.slippageRate + position.costAssumptions.sellTax) + position.costAssumptions.gasUsd;
  const net = gross - costs;
  if (account.cash + net < 0 || ![amount, basis, gross, costs, net, account.cash + net, account.realizedPnl + net - basis].every(Number.isFinite)) return false;
  const realizedPnl = net - basis;
  account.cash += net;
  account.realizedPnl += realizedPnl;
  position.quantity -= amount;
  position.costBasisUsd -= basis;
  position.realizedPnl += realizedPnl;
  account.trades.push({ id: `${nowMs}:${account.trades.length}`, side: writeoff ? 'writeoff' : 'sell', strategyId: position.strategyId, strategyLabel: position.strategyLabel, chain: position.chain, address: position.address, symbol: position.symbol, quantity: amount, price: markPrice, grossUsd: gross, costsUsd: costs, netUsd: net, costBasisUsd: basis, realizedPnl, reason, atMs: nowMs, observedAt: position.markAt, costSource: 'assumption',
    exitEvidence: position.exitPlan ? { version: STRATEGY_ANALYSIS_VERSION, ...(position.entryEvidence?.accountPolicy ? { accountPolicyVersion: position.entryEvidence.accountPolicy.version } : {}), ...(isDiagnosticPaperEntry(position.entryEvidence) ? { diagnosticVersion: position.entryEvidence.diagnostic.version } : {}), ...((position.pvpPolicy || position.upsidePolicy) ? { exitPolicyVersion: (position.pvpPolicy || position.upsidePolicy).version } : {}), activeStopPrice: position.activeStopPrice, peakPrice: position.peakPrice, profitProtectionArmed: position.profitProtectionArmed, flowConfirmation: structuredClone(position.flowExitWatch || null), quoteDiagnostics: structuredClone(position.quoteDiagnostics || null), fillModel: '下一次新鲜观察价，不保证止损价成交' } : null });
  if (account.trades.at(-1).exitEvidence) Object.assign(account.trades.at(-1).exitEvidence, {
    opportunityVersion:position.entryEvidence?.opportunity?.version || null,
    structureConfirmation:structuredClone(position.structureStatus || null),costVersion:position.costAssumptions.version || 'legacy_cost_v1' });
  if (position.exitExperiment || position.memeExitPolicy) Object.assign(account.trades.at(-1).exitEvidence, {
    exitPolicyVersion: position.memeExitPolicy?.version || THESIS_EXIT_VERSION, activeStopPrice: null, profitProtectionArmed: false,
    flowConfirmation: structuredClone(position.thesisFlowWatch || null), thesisDecision: structuredClone(position.thesisStatus || null),
    fillModel: '逻辑失效后的新鲜观察价；无固定止损价或最大亏损承诺' });
  if(position.thesisStatus?.recoveryExit)Object.assign(account.trades.at(-1).exitEvidence,{
    exitPolicyVersion:position.thesisStatus.recoveryExit.version,
    evidenceRecovery:structuredClone(position.thesisStatus.recoveryExit),
    recoveryActivatedAt:position.evidenceGapActivatedAt});
  if (position.quantity <= position.initialQuantity * 1e-10) {
    account.stats.exits += 1;
    if (position.realizedPnl > 0) account.stats.wins += 1;
    else account.stats.losses += 1;
    account.cooldowns[key] = nowMs + (isDiagnosticPaperEntry(position.entryEvidence) ? 45_000 : 30 * MINUTE);
    delete account.positions[key];
  }
  return true;
}

function structuralExit(position, mark, policy, nowMs) {
  if (!position.exitPlan) return null; // Legacy positions retain their recorded policy.
  const reviewed=position.pvpPolicy?.version==='structure_hold_v2';
  if (reviewed) {
    const c=position.costAssumptions, breakEven=(position.costBasisUsd+c.gasUsd)/(position.quantity*(1-c.feeRate-c.slippageRate-c.sellTax));
    const atrRate=position.entryEvidence.opportunity.pattern.atr/position.entryPrice;
    if (position.peakPrice >= breakEven*(1+Math.max(.005,atrRate*.5))) position.profitProtectionArmed=true;
    if (position.profitProtectionArmed) position.activeStopPrice=Math.max(position.activeStopPrice,
      position.peakPrice*(1-Math.min(.12,Math.max(.03,atrRate*2))));
    position.structureStatus=assessStructureHold(position,mark.structureChart,mark);
  }
  if (position.firstTargetTaken || position.peakPrice >= position.entryPrice * (position.pvpPolicy?.protectionActivation || position.upsidePolicy?.protectionActivation || 1.5)) position.profitProtectionArmed = true;
  if (position.profitProtectionArmed) {
    const costs = position.costAssumptions;
    const breakEven = (position.costBasisUsd + costs.gasUsd) / (position.quantity * (1 - costs.feeRate - costs.slippageRate - costs.sellTax));
    position.activeStopPrice = Math.max(position.activeStopPrice, breakEven);
  }
  if (position.peakPrice >= position.entryPrice * policy.trailingActivation) position.activeStopPrice = Math.max(position.activeStopPrice, position.peakPrice * (1 - policy.trailingStop));
  const flow = mark.flow;
  const provider = flow?.provider || 'gmgn', entryProvider = position.entryEvidence?.flowDiagnostics?.provider || 'gmgn';
  const usable = flow && keyOf(flow) === keyOf(position) && flow.complete === true && flow.fresh === true && ['ok', 'healthy'].includes(flow.status)
    && provider === entryProvider
    && !flow.coverageGap && fresh(flow.observedAt, nowMs) && time(flow.observedAt) > time(position.openedAt)
    && time(flow.observedAt) <= time(mark.observedAt) && finite(flow.netBuyUsd) !== null && Number.isInteger(flow.smartMoneySellerCount);
  const reversed = usable && flow.netBuyUsd <= -Math.max(policy.minNetBuy * .5, (finite(position.entryEvidence?.flow?.netBuyUsd) || 0) * .5) && flow.smartMoneySellerCount >= 2;
  if (!reversed) position.flowExitWatch = null;
  else {
    const at = time(flow.observedAt), prior = position.flowExitWatch;
    if (!prior || (prior.provider || 'gmgn') !== provider || at - time(prior.lastAt) > 120_000) position.flowExitWatch = { count: 1, provider, firstAt: iso(at), lastAt: iso(at), netBuyUsd: flow.netBuyUsd, smartMoneySellerCount: flow.smartMoneySellerCount };
    else if (at > time(prior.lastAt) && at - time(prior.firstAt) >= 30_000) position.flowExitWatch = { ...prior, count: 2, lastAt: iso(at), netBuyUsd: flow.netBuyUsd, smartMoneySellerCount: flow.smartMoneySellerCount };
  }
  position.exitStatus = { activeStopPrice: position.activeStopPrice, profitProtectionArmed: position.profitProtectionArmed,
    flowStatus: !usable ? '资金流不完整，不据此触发退出' : reversed ? '聪明钱净卖出，等待连续确认' : '未确认聪明钱撤退', checkedAt: mark.observedAt };
  if (mark.price <= position.activeStopPrice) return position.peakPrice >= position.entryPrice * policy.trailingActivation && position.activeStopPrice > position.entryPrice * 1.1 ? '盈利回撤止盈' : position.profitProtectionArmed ? '本金与成本保护退出' : '结构失效止损';
  if (position.flowExitWatch?.count >= 2) return '聪明钱连续净卖出，买入逻辑失效';
  if (reviewed && position.structureStatus?.exit) return position.structureStatus.reason;
  return null;
}

/** New entries can pause independently; fresh-price exits are always evaluated. */
export function advancePaperStrategyAccount(account, { evaluations = [], marks = [], nowMs = Date.now(), enabled = true, distilledPolicy = null, diagnosticMode = false, confirmedMode = false, continuousPaperMode = false, opportunityMode = false, opportunityReviewMode = true, memeExitMode = false, recoveryMode = false } = {}) {
  assertNow(nowMs);
  validatePaperStrategyAccount(account);
  if(typeof recoveryMode!=='boolean'||recoveryMode&&(!memeExitMode||account.variant||account.exitExperimentVersion))throw new TypeError('recovery is paper-main only');
  if (typeof diagnosticMode !== 'boolean' || diagnosticMode && account.variant) throw new TypeError('diagnostic mode is paper-main only');
  if (typeof confirmedMode !== 'boolean' || confirmedMode && (account.variant || diagnosticMode)) throw new TypeError('confirmed mode is paper-main only');
  if (typeof continuousPaperMode !== 'boolean' || continuousPaperMode && (!confirmedMode || account.variant)) throw new TypeError('continuous mode requires confirmed paper-main');
  if (typeof opportunityMode !== 'boolean' || opportunityMode && (!confirmedMode || account.variant)) throw new TypeError('multi setup requires confirmed paper-main');
  if(typeof memeExitMode!=='boolean'||memeExitMode&&(!confirmedMode||!opportunityMode||!continuousPaperMode||account.variant||account.exitExperimentVersion))throw new TypeError('meme exit requires confirmed continuous paper main');
  if (time(account.updatedAt) > nowMs) throw new TypeError('cannot move account backwards in time');
  const next = structuredClone(account);
  if(recoveryMode) {
    next.recoveryActivation ||= {version:PAPER_RECOVERY_VERSION,activatedAt:iso(nowMs),baselineTradeCount:next.trades.length,
      scope:'main_new_entries_and_authorized_existing_meme_lots'};
    for(const p of Object.values(next.positions))if(p.memeExitPolicy&&!p.evidenceGapPolicy) {
      p.evidenceGapPolicy={...EVIDENCE_GAP_POLICY};p.evidenceGapActivatedAt=iso(nowMs);
    }
  }
  if(memeExitMode&&!next.memeExitActivation)next.memeExitActivation={version:MEME_EXIT_VERSION,activatedAt:iso(nowMs),baselineTradeCount:next.trades.length};
  next.cooldowns ||= {};
  const markMap = new Map();
  for (const mark of Array.isArray(marks) ? marks : []) {
    const price = finite(mark.price), key = keyOf(mark);
    if (mark.status !== 'ok' || price === null || price < 0 || price === 0 && mark.confirmedZero !== true || !fresh(mark.observedAt, nowMs)) continue;
    if (!markMap.has(key) || time(mark.observedAt) > time(markMap.get(key).observedAt)) markMap.set(key, { ...mark, price });
  }
  for (const [key, position] of Object.entries(next.positions)) {
    const mark = markMap.get(key);
    if (!mark || time(mark.observedAt) < time(position.markAt) || !Number.isFinite(mark.price * position.quantity)) { position.markStatus = 'stale'; continue; }
    if (position.pvpPolicy && !fresh(mark.observedAt, nowMs, position.pvpPolicy.exitQuoteMaxAgeMs)) { position.markStatus = 'stale'; continue; }
    if (position.pvpPolicy && time(mark.observedAt) <= time(position.markAt)) continue;
    position.quoteDiagnostics = { previousObservedAt: position.markAt, previousPrice: position.markPrice,
      observedAt: iso(time(mark.observedAt)), price: mark.price,
      gapMs: time(mark.observedAt) - time(position.markAt), ageAtDecisionMs: nowMs - time(mark.observedAt),
      priceChangeRate: position.markPrice > 0 ? mark.price / position.markPrice - 1 : null,
      meaning: '相邻可见报价间隔，不能单独区分市场跳价和采集延迟' };
    position.markPrice = mark.price;
    position.markAt = iso(time(mark.observedAt));
    position.markStatus = 'ok';
    position.peakPrice = Math.max(position.peakPrice, mark.price);
    const policy = pvpPositionPolicy(position, upsidePositionPolicy(position, entryPolicy(STRATEGY_POLICIES.find(item => item.id === position.strategyId), position.entryEvidence?.entryTier, position.entryEvidence?.entryPolicyVersion)));
    const multiple = mark.price / position.entryPrice;
    const peakMultiple = position.peakPrice / position.entryPrice;
    const elapsed = nowMs - time(position.openedAt);
    if (mark.price === 0) {
      sell(next, key, position.quantity, 0, '真实零价格记全额损失，未模拟成交', nowMs, { writeoff: true });
      continue;
    }
    if (position.exitExperiment || position.memeExitPolicy) {
      let decision = position.memeExitPolicy ? assessMemeExit(position,mark,nowMs) : assessThesisExit(position, mark, nowMs);
      if(position.evidenceGapPolicy) {
        decision=applyEvidenceGapExit(position,mark,decision,nowMs);
        position.evidenceGap=decision.evidenceGap??null;
      }
      position.thesisFlowWatch = decision.flowWatch;
      if(position.memeExitPolicy?.version===MEME_EXIT_VERSION && decision.structureTrail)position.structureTrail=structuredClone(decision.structureTrail);
      position.thesisStatus = decision;
      position.pvpLastQuote = { price: mark.price, observedAt: position.markAt };
      position.exitStatus = { activeStopPrice: null, checkedAt: position.markAt, holdingMode: position.memeExitPolicy ? '主盘 · 叙事与资金行为退出' : '独立实验 · 量价逻辑退出',
        holdReason: decision.reason, holdLimitMs: null, fixedStopEnabled: false, fixedProfitEnabled: false };
      if (decision.exit) sell(next, key, position.quantity, mark.price, decision.reason, nowMs);
      continue; // No legacy percent stop, cost protection, target or multiple tier.
    }
    const structuralReason = structuralExit(position, mark, policy, nowMs);
    if (position.pvpPolicy) {
      const action = pvpDecision(position, mark);
      position.pvpLastQuote = { price: mark.price, observedAt: position.markAt };
      const reason = multiple <= 1 - policy.stopLoss ? '价格止损' : structuralReason || action.exit;
      if (reason) { sell(next, key, position.quantity, mark.price, reason, nowMs); continue; }
      if (position.pvpPolicy.version==='structure_hold_v2' && !position.firstTargetTaken && mark.price>=position.exitPlan.referenceTargetPrice) {
        const c=position.costAssumptions, amount=position.initialQuantity*.2;
        const net=amount*mark.price*(1-c.feeRate-c.slippageRate-c.sellTax)-c.gasUsd;
        if (net>position.costBasisUsd*amount/position.quantity && sell(next,key,amount,mark.price,'历史结构参考位兑现原仓 20%，保留趋势仓',nowMs)) {
          position.firstTargetTaken=true;
          structuralExit(position,mark,policy,nowMs);
        }
      }
      if (action.trim) {
        const quantity = Math.max(0, position.quantity - position.initialQuantity * policy.runnerFraction);
        if (!quantity || sell(next, key, quantity, mark.price, 'PVP 主仓到期兑现，仅留 20% 强势尾仓', nowMs)) position.pvpRunnerStartedAt = position.markAt;
      }
      if (!position.pvpRunnerStartedAt) for (const tier of policy.profitTiers) {
        if (multiple >= tier.multiple && !position.profitTiersTaken.includes(tier.multiple)
          && sell(next, key, position.initialQuantity * tier.fraction, mark.price, `PVP ${tier.multiple} 倍兑现原仓 ${Math.round(tier.fraction * 100)}%`, nowMs)) position.profitTiersTaken.push(tier.multiple);
      }
      if (position.quantity <= position.initialQuantity * (policy.runnerFraction + 1e-10)) position.pvpRunnerStartedAt ||= position.markAt;
      position.exitStatus = { ...position.exitStatus, ...(isEvidenceHold(position.pvpPolicy) ? evidenceHoldStatus(position, nowMs)
        : { holdingMode: position.pvpRunnerStartedAt ? 'PVP 强势尾仓（最多原仓 20%）' : 'PVP 主仓快速观察',
          holdLimitMs: position.pvpRunnerStartedAt ? policy.runnerHoldMs : policy.coreHoldMs, trailingDrawdown: policy.trailingStop }) };
      continue;
    }
    const habit = position.distilledHabit;
    const learnedExit = habit && (habit.lossCutRate !== null && multiple <= 1 - Math.min(policy.stopLoss, habit.lossCutRate) ? '蒸馏模拟：亏损退出线'
      : !position.profitTiersTaken.length && elapsed >= Math.min(policy.maxHoldMs, habit.maxHoldMs) ? '蒸馏模拟：持仓期限到达' : null);
    const strongHold = !!position.upsidePolicy && peakMultiple >= position.upsidePolicy.strongPeakMultiple && multiple >= position.upsidePolicy.strongCurrentMultiple;
    const holdLimitMs = position.profitTiersTaken.length || strongHold ? policy.runnerHoldMs : policy.maxHoldMs;
    if (position.upsidePolicy) position.exitStatus = { ...position.exitStatus, holdingMode: strongHold || position.profitTiersTaken.length ? '强势延长 / 趋势尾仓' : '弱势观察期', holdLimitMs, trailingDrawdown: policy.trailingStop };
    const exitReason = multiple <= 1 - policy.stopLoss ? '价格止损' : structuralReason || learnedExit || (peakMultiple >= policy.trailingActivation && mark.price <= position.peakPrice * (1 - policy.trailingStop) ? '盈利回撤止盈' : elapsed >= holdLimitMs ? '持仓到期' : null);
    if (exitReason) { sell(next, key, position.quantity, mark.price, exitReason, nowMs); continue; }
    if (position.exitPlan && !position.upsidePolicy && !position.firstTargetTaken && mark.price >= position.exitPlan.referenceTargetPrice) {
      if (sell(next, key, position.initialQuantity * .2, mark.price, '结构目标首档兑现 20%', nowMs)) {
        position.firstTargetTaken = true;
        // The same fresh mark can tighten protection, but never count as a second flow observation.
        structuralExit(position, mark, policy, nowMs);
      }
    }
    for (const tier of policy.profitTiers) {
      if (multiple >= tier.multiple && !position.profitTiersTaken.includes(tier.multiple)) {
        const fraction = !position.upsidePolicy && position.exitPlan && tier.multiple === 2 ? .3 : tier.fraction;
        if (sell(next, key, position.initialQuantity * fraction, mark.price, `${tier.multiple} 倍分批兑现`, nowMs)) position.profitTiersTaken.push(tier.multiple);
      }
    }
  }
  const dayStart = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const dailyRealizedPnl = next.trades.filter(trade => trade.atMs >= dayStart && trade.atMs <= nowMs).reduce((sum, trade) => sum + trade.realizedPnl, 0);
  const guard = !continuousPaperMode && dailyRealizedPnl <= -next.initialCash * .1;
  const qualifiedByToken = new Map();
  for (const item of Array.isArray(evaluations) ? evaluations : []) {
    if (!item || item.decision !== '可模拟' || !STRATEGY_PRIORITY.includes(item.strategyId) || item.evidence?.paperEligible !== true || item.missing?.length || !fresh(item.observedAt, nowMs) || !positive(item.token?.price) || !validAddress(chainName(item.token?.chain), clean(item.token?.address))) continue;
    const key = keyOf(item.token);
    if (!qualifiedByToken.has(key)) qualifiedByToken.set(key, []);
    qualifiedByToken.get(key).push(item);
  }
  const entryCandidates = [...qualifiedByToken.values()].map(group => group.sort((a, b) => STRATEGY_PRIORITY.indexOf(a.strategyId) - STRATEGY_PRIORITY.indexOf(b.strategyId))[0])
    .sort((a, b) => confirmedMode ? compareConfirmedCandidates(a, b) : (finite(b.score) ?? 0) - (finite(a.score) ?? 0) || STRATEGY_PRIORITY.indexOf(a.strategyId) - STRATEGY_PRIORITY.indexOf(b.strategyId) || keyOf(a.token).localeCompare(keyOf(b.token)));
  for (const evaluation of enabled === true ? entryCandidates : []) {
    const diagnostic = isDiagnosticPaperEntry(evaluation.evidence);
    const confirmed = isConfirmedPaperEntry(evaluation.evidence);
    // Only the explicitly selected continuous PAPER mode removes account limits.
    if (diagnostic && !diagnosticMode || confirmed && !confirmedMode || confirmedMode && !confirmed || guard) continue;
    if (evaluation.evidence.narrativeRecall && !freshNarrativeRecall(evaluation.evidence.narrativeRecall,evaluation.token,nowMs)) continue;
    if (evaluation.evidence.accountPolicy?.version === CONTINUOUS_PAPER_VERSION && !continuousPaperMode) continue;
    if (evaluation.evidence.opportunity && (!opportunityMode || evaluation.evidence.opportunity.version !== (opportunityReviewMode ? OPPORTUNITY_VERSION : 'multi_setup_v1'))) continue;
    if (evaluation.evidence.opportunity?.version===OPPORTUNITY_VERSION && evaluation.evidence.opportunity.reviewVersion!==OPPORTUNITY_REVIEW_VERSION) continue;
    if (confirmed && !confirmedAccountGate(next, nowMs, evaluation.token, evaluation.evidence.confirmedPolicy.pulse, evaluation.evidence.narrativeRecall, { continuousPaperMode, opportunity:evaluation.evidence.opportunity }).allowed) continue;
    if (!continuousPaperMode && Object.keys(next.positions).length >= 2) break;
    const standard = STRATEGY_POLICIES.find(item => item.id === evaluation.strategyId);
    const tier = evaluation.evidence?.entryTier;
    if (tier != null && !['standard', 'exploratory'].includes(tier)) continue;
    if (tier === 'exploratory' && evaluation.evidence.entryPolicyVersion !== PAPER_ENTRY_POLICY_VERSION) continue;
    const policy = entryPolicy(standard, tier);
    const token = evaluation.token || {};
    const chain = chainName(token.chain), address = clean(token.address), key = keyOf(token);
    const price = positive(token.price);
    if (account.variant === 'distilled_shadow' && !validLearningPolicy(distilledPolicy, chain, nowMs)) continue;
    if (!policy || !chain || !validAddress(chain, address) || !price || evaluation.evidence?.paperEligible !== true || evaluation.missing?.length || !fresh(evaluation.observedAt, nowMs) || next.positions[key] || !continuousPaperMode && (next.cooldowns[key] || 0) > nowMs) continue;
    const availableMark = markMap.get(key);
    if (availableMark && time(availableMark.observedAt) >= time(evaluation.observedAt) && (availableMark.price === 0 || availableMark.price !== price)) continue;
    const proposedSize = evaluation.evidence?.positionSizing;
    if (proposedSize?.version === PAPER_FIXED_SIZING_VERSION && !confirmed) continue;
    const proposedProfile = evaluation.evidence?.exitPolicy;
    const proposedPvp = proposedProfile?.mode === 'pvp' ? proposedProfile : null;
    if (isEvidenceHold(proposedPvp) && !confirmed) continue;
    const proposedUpside = proposedPvp ? null : proposedProfile;
    if (proposedProfile && (account.variant || !(proposedPvp ? validPvpExitPolicy(proposedPvp) : validUpsideExitPolicy(proposedUpside))
      || evaluation.evidence.entryPlan?.exitPolicyVersion !== proposedProfile.version
      || evaluation.evidence.entryPlan?.targetRole !== 'structure_reference_only')) continue;
    if (proposedPvp && !fresh(evaluation.observedAt, nowMs, proposedPvp.entryQuoteMaxAgeMs)) continue;
    if (proposedSize && (account.variant || !validPaperPositionSize(proposedSize, policy.entryUsd, evaluation.entryUsd, evaluation.evidence.liquidity))) continue;
    // Every fill uses the remaining cash after earlier exits/entries in this
    // same serialized cycle. Never increase beyond the researched signal size.
    const positionSizing = proposedSize ? paperPositionSize({ cash: next.cash, liquidity: evaluation.evidence.liquidity,
      baseEntryUsd: policy.entryUsd, maxBudgetUsd: evaluation.entryUsd, fixedEntryUsd: proposedSize.fixedEntryUsd ?? null,
      recoverySizing:proposedSize.version===PAPER_RECOVERY_SIZING_VERSION }) : null;
    const budget = proposedSize ? positionSizing?.budgetUsd : Math.min(10, policy.entryUsd, positive(evaluation.entryUsd) || policy.entryUsd);
    if (!positive(budget) || next.cash < budget) continue;
    if(recoveryMode && (proposedSize?.version!==PAPER_RECOVERY_SIZING_VERSION
      ||budget>Math.min(10,next.cash*.1)+1e-9
      ||!recoveryEntryCheck(evaluation.evidence.recoveryEntry,token,
        evaluation.evidence.opportunity?.id==='monitored_event'?evaluation.evidence.opportunity.event:null,nowMs).ready))continue;
    const narrativeThesis=evaluation.evidence.narrativeThesis;
    if(narrativeThesis&&(narrativeThesis.version!==NARRATIVE_THESIS_VERSION||keyOf(narrativeThesis)!==keyOf(token)
      ||!fresh(narrativeThesis.observedAt,nowMs)||narrativeThesis.invalidation?.blockNewNarrativeEntry===true))continue;
    if (confirmed && budget < CONFIRMED_PAPER_POLICY.minBudgetUsd) continue;
    const proposedCosts = evaluation.evidence?.costAssumptions;
    const entryTax = paperTaxScreen(proposedCosts);
    if (proposedCosts?.source !== 'assumption' || entryTax.blocked || entryTax.missing.length) continue;
    const costs = costAssumptions(chain, entryTax.buyTax, entryTax.sellTax, budget,
      opportunityMode ? REFERENCE_COST_VERSION : 'legacy_cost_v1');
    if (!costs.notionalUsd || !diagnostic && costs.estimatedRoundTripCostRate > .15) continue;
    const plan = evaluation.evidence?.entryPlan;
    const memeStructureEntry = plan?.entryPolicyVersion===MEME_STRUCTURE_ENTRY_VERSION;
    const alphaEntry=plan?.entryPolicyVersion===ALPHA_ENTRY_VERSION;
    const monitorEntry=plan?.entryPolicyVersion===MONITOR_ENTRY_VERSION,eventEntry=alphaEntry||monitorEntry;
    if (plan?.entryPolicyVersion && (!(memeStructureEntry||eventEntry) || !memeExitMode || !opportunityReviewMode
      || evaluation.evidence.opportunity?.entryPolicyVersion!==plan.entryPolicyVersion
      || evaluation.evidence.opportunity?.basis!==(alphaEntry?'official_event':monitorEntry?'monitored_event':'ohlcv'))) continue;
    if(alphaEntry&&(!validAlphaSignal(evaluation.evidence.opportunity.event,token,nowMs)
      ||!confirmAlphaQuotes((evaluation.evidence.confirmedPolicy?.confirmation?.rows||[]).map(q=>({...q,chain,address,status:'ok'})),
        token,evaluation.evidence.opportunity.event,nowMs).ready))continue;
    if(monitorEntry&&(!validMonitorSignal(evaluation.evidence.opportunity.event,token,nowMs)
      ||!confirmMonitorQuote((evaluation.evidence.confirmedPolicy?.confirmation?.rows||[]).map(q=>({...q,chain,address,status:'ok'})),
        token,evaluation.evidence.opportunity.event,nowMs).ready))continue;
    const reviewedStructure=evaluation.evidence.opportunity?.reviewVersion === OPPORTUNITY_REVIEW_VERSION && evaluation.evidence.opportunity.basis === 'ohlcv';
    const economics=reviewedStructure ? structureEconomics({...evaluation.evidence.opportunity.pattern,support:plan?.stopPrice,targetPrice:plan?.targetPrice},price,costs,budget) : null;
    // Recompute with the serialized actual cash budget; a proposed row cannot
    // grant relaxed costs to a comparison book or bypass net economics.
    const costGate=paperCostGate(costs,{structureMain:memeExitMode && memeStructureEntry && reviewedStructure,economics});
    if (confirmed && !costGate.ready || reviewedStructure && !economics.ready) continue;
    if (evaluation.evidence?.version !== STRATEGY_ANALYSIS_VERSION || plan?.version !== STRATEGY_ANALYSIS_VERSION || plan.eligible !== true
      || (eventEntry ? plan.stopPrice!==null||plan.targetPrice!==null : !positive(plan.stopPrice) || plan.stopPrice >= price || !memeStructureEntry && plan.stopPrice < price * (1 - policy.stopLoss))
      || !fresh(plan.confirmedAt, nowMs) || !positive(plan.entryZone?.low) || !positive(plan.entryZone?.high)
      || !eventEntry && (!positive(plan.targetPrice) || plan.targetPrice <= price || plan.targetPrice > price * 2)
      || price < plan.entryZone.low || price > plan.entryZone.high || !(diagnostic || confirmed) && (!Number.isFinite(plan.netRewardRisk) || plan.netRewardRisk < 1.5)) continue;
    const quantity = costs.notionalUsd / price;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const actualLoss = eventEntry?null:budget - (quantity * plan.stopPrice * (1 - costs.feeRate - costs.slippageRate - costs.sellTax) - costs.gasUsd);
    const actualGain = eventEntry?null:quantity * plan.targetPrice * (1 - costs.feeRate - costs.slippageRate - costs.sellTax) - costs.gasUsd - budget;
    const actualRewardRisk = actualLoss > 0 && actualGain > 0 ? actualGain / actualLoss : null;
    if (!(diagnostic || confirmed) && proposedSize && (!Number.isFinite(actualRewardRisk) || actualRewardRisk < 1.5)) continue;
    const qualifiedStrategyIds = unique(qualifiedByToken.get(key).map(item => item.strategyId));
    const position = { chain, address, symbol: clean(token.symbol) || '未知', strategyId: policy.id, strategyLabel: diagnostic ? '诊断试仓' : policy.label, qualifiedStrategyIds, quantity, initialQuantity: quantity, entryPrice: price, entryUsd: budget, entryCostsUsd: budget - costs.notionalUsd, costBasisUsd: budget, costAssumptions: costs, entryLogic: evaluation.entryLogic, entryReasons: [...(evaluation.reasons || [])], entryEvidence: structuredClone(evaluation.evidence), exitLogic: evaluation.exitLogic, openedAt: iso(nowMs), markAt: iso(time(evaluation.observedAt)), markPrice: price, markStatus: 'ok', peakPrice: price, profitTiersTaken: [], realizedPnl: 0 };
    // Freeze the actual engine mode, never infer authority from a candidate row.
    if (continuousPaperMode) position.entryEvidence.accountPolicy = paperOperatingPolicy(true);
    if (positionSizing) {
      position.entryEvidence.positionSizing = positionSizing;
      position.entryEvidence.costAssumptions = structuredClone(costs);
      position.entryEvidence.entryPlan = { ...position.entryEvidence.entryPlan, netRewardRisk: actualRewardRisk, estimatedStopLossUsd: actualLoss };
      position.entryLogic += ` ${paperSizingText(positionSizing)}`;
    }
    if (confirmed) {
      position.entryEvidence.costGate=costGate;
      position.strategyLabel = evaluation.evidence.opportunity?.label || (evaluation.evidence.narrativeRecall ? 'OG 回流狙击' : '确认型 PVP');
      // Freeze actual budget/costs after serialized sizing, not the preliminary proposal.
      position.entryEvidence.traderDecision = traderDecision({ ...evaluation, entryUsd: budget,
        evidence: { ...position.entryEvidence, costAssumptions: costs } }, nowMs);
    }
    position.exitPlan = { version: STRATEGY_ANALYSIS_VERSION, initialStopPrice: plan.stopPrice, referenceTargetPrice: plan.targetPrice, referenceTargetKind: plan.targetKind };
    if (proposedUpside) position.upsidePolicy = structuredClone(proposedUpside);
    if (proposedPvp) {
      position.pvpPolicy = structuredClone(proposedPvp);
      position.pvpLastQuote = { price, observedAt: position.markAt };
      position.pvpRunnerStartedAt = null;
    }
    position.activeStopPrice = plan.stopPrice; position.profitProtectionArmed = false; position.firstTargetTaken = false; position.flowExitWatch = null;
    if (isEvidenceHold(proposedPvp)) position.exitStatus = { activeStopPrice: plan.stopPrice, checkedAt: position.markAt,
      flowStatus: '尚未取得入场后的资金流证据', ...evidenceHoldStatus(position, nowMs) };
    // Main-account forward policy only; old lots and independent controls keep their frozen versions.
    if(memeExitMode){
      if(!confirmed||!proposedPvp)continue;
      position.memeExitPolicy=structuredClone(MEME_EXIT_POLICY);
      if(recoveryMode){position.evidenceGapPolicy={...EVIDENCE_GAP_POLICY};position.evidenceGapActivatedAt=iso(nowMs);}
      position.entryEvidence.memeExitPolicy=structuredClone(MEME_EXIT_POLICY);
      position.exitLogic=MEME_EXIT_TEXT;
      position.entryEvidence.traderDecision={...position.entryEvidence.traderDecision,exitPolicyVersion:MEME_EXIT_VERSION,
        questions:(position.entryEvidence.traderDecision?.questions||[]).map(q=>['invalidation','hold_or_exit'].includes(q.id)?{...q,text:MEME_EXIT_TEXT}:q)};
      position.entryEvidence.exitReferenceMeaning='结构参考位与目标只作入场情景估算，不触发本仓退出，也不是固定止损或最大亏损承诺';
      position.exitStatus={activeStopPrice:null,checkedAt:position.markAt,holdingMode:'主盘 · 叙事与资金行为退出',
        holdReason:'等待入场后的叙事、地址行为与量价证据',holdLimitMs:null,fixedStopEnabled:false,fixedProfitEnabled:false};
    } else {
      delete position.entryEvidence.memeExitPolicy;
      delete position.entryEvidence.memeExitContext;
    }
    if (next.exitExperimentVersion === THESIS_EXIT_VERSION) {
      if (!confirmed || !proposedPvp) continue;
      position.exitExperiment = structuredClone(THESIS_EXIT_POLICY);
      position.entryEvidence.exitExperiment = structuredClone(THESIS_EXIT_POLICY);
      position.exitLogic = THESIS_EXIT_TEXT;
      // Preserve original entry eligibility and baseline profile for audit,
      // but explicitly mark its stop/target values as research references only.
      position.entryEvidence.exitReferenceMeaning = '原入口的成本空间筛选参考，实验不按该止损线执行；模型止损损失不是实验最大亏损';
      position.entryEvidence.traderDecision = { ...position.entryEvidence.traderDecision, exitPolicyVersion: THESIS_EXIT_VERSION,
        questions: (position.entryEvidence.traderDecision?.questions || []).map(q => ['invalidation', 'hold_or_exit'].includes(q.id) ? { ...q, text: THESIS_EXIT_TEXT } : q) };
      position.exitStatus = { activeStopPrice: null, checkedAt: position.markAt, holdingMode: '独立实验 · 量价逻辑退出',
        holdReason: '等待入场后的量价与完整资金流证据', fixedStopEnabled: false, fixedProfitEnabled: false };
    }
    if (account.variant === 'distilled_shadow') {
      position.distilledHabit = structuredClone(distilledPolicy);
      position.entryEvidence.distilledHabit = structuredClone(distilledPolicy);
      position.exitLogic += ` 蒸馏对照 ${distilledPolicy.version}：未达到 2 倍前持仓不超过 ${Math.min(policy.maxHoldMs, distilledPolicy.maxHoldMs) / 60000} 分钟；亏损退出线 ${distilledPolicy.lossCutRate === null ? '沿用原策略' : `${distilledPolicy.lossCutRate * 100}%`}，原有更紧止损始终优先。`;
    }
    next.positions[key] = position;
    next.cash -= budget;
    next.stats.entries += 1;
    next.trades.push({ id: `${nowMs}:${next.trades.length}`, side: 'buy', strategyId: policy.id, ...(evaluation.evidence.opportunity ? {strategyLabel:position.strategyLabel} : {}), chain, address, symbol: position.symbol, quantity, price, grossUsd: costs.notionalUsd, costsUsd: position.entryCostsUsd, netUsd: -budget, costBasisUsd: budget, realizedPnl: 0, reason: position.entryLogic, atMs: nowMs, observedAt: evaluation.observedAt, costSource: 'assumption', entryLogic: position.entryLogic, exitLogic: position.exitLogic, entryEvidence: structuredClone(position.entryEvidence) });
  }
  let markedValue = 0, unrealizedPnl = 0;
  for (const position of Object.values(next.positions)) {
    position.markValue = position.quantity * position.markPrice;
    position.estimatedExitCostsUsd = position.markValue * (position.costAssumptions.feeRate + position.costAssumptions.slippageRate + position.costAssumptions.sellTax) + position.costAssumptions.gasUsd;
    position.pnl = position.markValue - position.estimatedExitCostsUsd - position.costBasisUsd;
    position.pnlPercent = position.pnl / position.costBasisUsd * 100;
    markedValue += position.markValue;
    unrealizedPnl += position.pnl;
  }
  next.stats = { ...next.stats, realizedPnl: next.realizedPnl, dailyRealizedPnl, dailyLossGuard: guard, equity: next.cash + markedValue, netLiquidationValue: next.cash + markedValue - Object.values(next.positions).reduce((sum, position) => sum + position.estimatedExitCostsUsd, 0), unrealizedPnl, openPositions: Object.keys(next.positions).length, enabled: enabled === true, stalePositions: Object.values(next.positions).filter(position => position.markStatus !== 'ok').length };
  next.updatedAt = iso(nowMs);
  validatePaperStrategyAccount(next);
  return next;
}
