import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const PAPER_STRATEGY_FOCUS_SIMULATION_VERSION = 'second_breakout_narrative_paper_v1';
const SCHEMA = 'paper_strategy_focus_simulation_v1';
const MAX_QUOTE_AGE_MS = 15_000;
const MAX_ENTRY_QUOTE_AGE_MS = 5_000;
const MAX_HOLD_MS = 60 * 60_000;
const MAX_COST_RATE = .15;
const MAX_STOP_LOSS_RATE = .25;
const MAX_LIQUIDITY_USD = 50_000;
const HOUR_MS = 60 * 60_000;
const FLOW_MAX_AGE_MS = 90_000;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const stamp = value => typeof value === 'number' ? (value < 1e10 ? value * 1000 : value) : Date.parse(value || '');
const iso = value => new Date(value).toISOString();
const canonicalAddress = (chain, address) => ['sol', 'solana'].includes(String(chain).toLowerCase())
  ? address : String(address || '').toLowerCase();
const tokenKey = (chain, address) => `${String(chain || '').toLowerCase()}:${canonicalAddress(chain, address)}`;
const validAddress = (chain, address) => ['sol', 'solana'].includes(String(chain || '').toLowerCase())
  ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
  : /^0x[\da-f]{40}$/i.test(address);
const compact = value => finite(value) ? Number(value.toPrecision(10)) : null;
const short = value => typeof value === 'string' ? value.slice(0, 500) : null;

async function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function fresh(value, nowMs, maxAgeMs) {
  const at = stamp(value);
  return Number.isFinite(at) && at <= nowMs && nowMs - at <= maxAgeMs;
}

function narrativeAdmissionBlockers(thesis, token, nowMs) {
  const blockers = [];
  const bound = ['direct_ca', 'official_catalog'].includes(thesis?.relationship?.kind);
  if (thesis?.researchOnly !== true || !token || thesis.chain !== token.chain
    || canonicalAddress(token.chain, thesis?.address) !== canonicalAddress(token.chain, token.address)) {
    blockers.push('叙事分析未绑定当前精确链 / CA');
  }
  const sourceAt = stamp(thesis?.event?.sourceAt);
  const source = thesis?.sources?.find(item => item?.url === thesis?.event?.sourceUrl);
  let publicSource = false;
  try {
    const url = new URL(source?.url || '');
    publicSource = url.protocol === 'https:' && !url.username && !url.password && !url.port;
  } catch { /* missing/invalid source fails closed */ }
  if (!source || !publicSource || !Number.isFinite(sourceAt) || sourceAt > nowMs || nowMs - sourceAt > HOUR_MS) {
    blockers.push('缺少一小时内可核验的 HTTPS 原文');
  }
  if (!bound || !['direct_ca', 'official_catalog'].includes(source?.binding)) {
    blockers.push('原文未与精确 CA 直接绑定或列入官方目录');
  }
  if (!thesis?.event?.kind || thesis.event.kind === 'unclassified') blockers.push('事件机制尚未分类');
  if (thesis?.event?.warning || /计划|传闻|未确认/iu.test(thesis?.event?.claimStatus || '')) {
    blockers.push('事件仍有争议、属于计划 / 传闻或尚未确认');
  }
  if (!['fresh', 'follow_through', 'reactivated'].includes(thesis?.catalyst?.phase)
    || !finite(thesis?.catalyst?.ageMs) || thesis.catalyst.ageMs < 0 || thesis.catalyst.ageMs > HOUR_MS) {
    blockers.push('催化不在新鲜 / 跟随窗口');
  }
  const demandAt = stamp(thesis?.demand?.observedAt);
  if (thesis?.demand?.status !== 'buying' || !Number.isFinite(demandAt) || demandAt > nowMs
    || nowMs - demandAt > FLOW_MAX_AGE_MS || !finite(thesis?.demand?.recentNetBuyers)
    || thesis.demand.recentNetBuyers < 2 || !finite(thesis?.demand?.netBuyUsd) || thesis.demand.netBuyUsd < 300) {
    blockers.push('90 秒内未见至少两个近期净买地址及 300U 净买入承接');
  }
  if (thesis?.market?.ready !== true) blockers.push('缺少可用的入场量价结构确认');
  if (thesis?.invalidation?.blockNewNarrativeEntry === true) blockers.push('原文争议或资金流失效');
  if (thesis?.agenticWallet?.requiresOfficialWalletAndBuyProof
    && thesis.agenticWallet.proofStatus !== 'verified_registered_and_bought') {
    blockers.push('Agentic Wallet 限定主张缺少官方身份与成功买入双重证明');
  }
  return blockers;
}

function normalizedCandidate(evaluation, nowMs, ticketUsd) {
  const evidence = evaluation?.evidence || {};
  const shadow = evidence.strategyFocusShadow;
  const signal = shadow?.externalSecondBreakout;
  const token = evaluation?.token || {};
  const reasons = [];
  const add = reason => { if (reason && !reasons.includes(reason)) reasons.push(reason); };
  if (shadow?.version !== 'smartmoney_second_breakout_shadow_v1' || shadow?.researchOnly !== true) add('缺少受支持的研究版策略证据');
  if (evidence.marketStage !== 'external' || shadow?.marketStage !== 'external') add('内盘 / 临毕业只观察聪明钱，不在此模拟入场');
  if (shadow?.stageConflict === true) add('内外盘阶段冲突');
  if (signal?.status !== 'candidate' || signal?.signalReady !== true) add('二段突破条件尚未全部通过');
  if (signal?.quoteConfirmation?.ready !== true) add('缺少精确 CA 的连续新鲜报价确认');
  if (signal?.economics?.ready !== true || !finite(signal?.economics?.netRewardRisk) || signal.economics.netRewardRisk < 1.2) add('扣费后结构空间 / 盈亏比不足');
  const chain = String(token.chain || '').toLowerCase(), address = String(token.address || '');
  if (!chain || !validAddress(chain, address)) add('链或 CA 无效');
  if (!positive(token.price) || !fresh(evaluation.observedAt, nowMs, MAX_ENTRY_QUOTE_AGE_MS)
    || evidence.priceFresh !== true || evidence.marketFresh !== true) add('行情或入场报价不够新鲜');
  const closedAt = stamp(signal?.metrics?.closedAt);
  const confirmedAt = stamp(signal?.quoteConfirmation?.confirmedAt);
  if (!Number.isFinite(closedAt) || closedAt > nowMs || !Number.isFinite(confirmedAt)
    || confirmedAt > nowMs || nowMs - confirmedAt > MAX_ENTRY_QUOTE_AGE_MS) add('信号收盘时间或报价确认时间无效 / 过期');
  const safety = evidence.safety;
  if (!Array.isArray(safety?.blocked) || !Array.isArray(safety?.missing)) add('核心安全检查结果缺失');
  else {
    if (safety.blocked.length) add(`安全硬阻断：${safety.blocked.slice(0, 3).join('、')}`);
    if (safety.missing.length) add(`安全字段缺失：${safety.missing.slice(0, 3).join('、')}`);
  }
  const liquidity = evidence.liquidity;
  if (!finite(liquidity) || liquidity < MAX_LIQUIDITY_USD) add('真实流动性不足 $50,000 或未知');
  const thesis = evidence.narrativeThesis;
  if (thesis?.researchOnly !== true || thesis?.chain !== chain
    || canonicalAddress(chain, thesis?.address) !== canonicalAddress(chain, address)) add('缺少与精确链 / CA 绑定的原文叙事分析');
  const admissionBlockers = narrativeAdmissionBlockers(thesis, token, nowMs);
  if (admissionBlockers.length) add(`叙事 / 事件 / 买盘确认未通过：${admissionBlockers.slice(0, 2).join('；')}`);

  const costs = evidence.costAssumptions;
  const numericCosts = ['notionalUsd', 'feeRate', 'slippageRate', 'buyTax', 'sellTax', 'gasUsd'];
  if (!costs || numericCosts.some(key => !finite(costs[key]))) add('往返成本模型字段缺失');
  else {
    if (!positive(costs.notionalUsd) || costs.gasUsd < 0 || costs.feeRate < 0 || costs.slippageRate < 0
      || costs.buyTax < 0 || costs.sellTax < 0 || costs.buyTax > .06 || costs.sellTax > .06) add('成本 / 税费范围无效或超过 6%');
    if (!finite(costs.estimatedRoundTripCostRate) || costs.estimatedRoundTripCostRate < 0
      || costs.estimatedRoundTripCostRate > MAX_COST_RATE) add('估算往返成本超过 15% 或未知');
  }
  const baseEntryUsd = finite(evaluation.entryUsd) && evaluation.entryUsd > 0 ? evaluation.entryUsd : ticketUsd;
  const entryUsd = Math.min(ticketUsd, baseEntryUsd);
  if (!positive(entryUsd)) add('固定模拟单笔预算无效');
  if (!positive(signal?.metrics?.support) || !positive(signal?.metrics?.targetPrice)
    || !positive(token.price) || signal?.metrics?.support >= token.price || signal?.metrics?.targetPrice <= token.price) add('结构失效位 / 目标位无效');

  if (reasons.length) return { eligible: false, reasons, signalKey: Number.isFinite(closedAt)
    ? `${tokenKey(chain, address)}:${iso(closedAt)}` : `${tokenKey(chain, address)}:unknown` };
  const scale = entryUsd / baseEntryUsd;
  const notionalUsd = costs.notionalUsd * scale;
  const gasUsd = costs.gasUsd * scale;
  const quantity = notionalUsd / token.price;
  const retention = 1 - costs.feeRate - costs.slippageRate - costs.sellTax;
  const stopProceeds = quantity * signal.metrics.support * retention - gasUsd;
  const estimatedStopLossUsd = entryUsd - stopProceeds;
  const stopLossRate = estimatedStopLossUsd / entryUsd;
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(stopLossRate) || stopLossRate > MAX_STOP_LOSS_RATE) {
    return { eligible: false, reasons: ['结构止损风险超过单笔预算的 25%'], signalKey: `${tokenKey(chain, address)}:${iso(closedAt)}` };
  }
  return { eligible: true, signalKey: `${tokenKey(chain, address)}:${iso(closedAt)}`,
    position: { chain, address: canonicalAddress(chain, address), symbol: String(token.symbol || '未知').slice(0, 48),
      strategyId: 'external_second_breakout', signalVersion: signal.version, signalCandleClosedAt: iso(closedAt),
      openedAt: iso(confirmedAt), entryPrice: token.price, ticketUsd: entryUsd, quantity,
      supportPrice: signal.metrics.support, targetPrice: signal.metrics.targetPrice,
      stopLossRate, entryCostsUsd: entryUsd - notionalUsd,
      feeRate: costs.feeRate, slippageRate: costs.slippageRate, sellTax: costs.sellTax, gasUsd,
      lastProcessedCandleClosedAt: iso(closedAt), markPrice: token.price, markAt: iso(confirmedAt),
      markStatus: 'fresh', unrealizedPnlUsd: null, coverageStatus: 'awaiting_post_entry_candles',
      narrativeEvent: short(thesis.event?.label), narrativeSourceUrl: short(thesis.event?.sourceUrl),
      operatorFootprintStatus: short(shadow.operatorFootprint?.status) } };
}

function validateState(state, config) {
  if (state?.schema !== SCHEMA || state?.version !== PAPER_STRATEGY_FOCUS_SIMULATION_VERSION
    || state?.mode !== 'paper_sidecar' || state?.execution !== false || state?.signing !== false || state?.broadcast !== false
    || !finite(state.initialCashUsd) || state.initialCashUsd !== config.initialCashUsd
    || !finite(state.cashUsd) || !finite(state.realizedPnlUsd) || !Array.isArray(state.positions)
    || !Array.isArray(state.trades) || !Array.isArray(state.openedSignalKeys) || !Array.isArray(state.latestChecks)) return false;
  return state.positions.every(position => typeof position.chain === 'string' && typeof position.address === 'string'
    && positive(position.entryPrice) && positive(position.ticketUsd) && positive(position.quantity)
    && positive(position.supportPrice) && positive(position.targetPrice));
}

export function createPaperStrategyFocusSimulator({ dataDir, now = Date.now, initialCashUsd = 100,
  ticketUsd = 10, maxOpenPositions = 1, maxTrades = 2000, maxOpenedSignalKeys = 5000, maxLatestChecks = 100 } = {}) {
  if (typeof dataDir !== 'string' || !dataDir || typeof now !== 'function'
    || !positive(initialCashUsd) || !positive(ticketUsd) || !Number.isSafeInteger(maxOpenPositions) || maxOpenPositions < 1
    || !Number.isSafeInteger(maxTrades) || maxTrades < 1 || !Number.isSafeInteger(maxOpenedSignalKeys) || maxOpenedSignalKeys < 1
    || !Number.isSafeInteger(maxLatestChecks) || maxLatestChecks < 1) throw new TypeError('invalid focus simulation configuration');
  const config = { initialCashUsd, ticketUsd, maxOpenPositions, maxTrades, maxOpenedSignalKeys, maxLatestChecks };
  const filePath = path.join(dataDir, 'paper-strategy-focus-simulation-v1.json');
  let state = { schema: SCHEMA, version: PAPER_STRATEGY_FOCUS_SIMULATION_VERSION, mode: 'paper_sidecar',
    execution: false, signing: false, broadcast: false, updatedAt: null, ...config,
    cashUsd: initialCashUsd, realizedPnlUsd: 0, positions: [], trades: [], openedSignalKeys: [],
    droppedTrades: 0, droppedSignalKeys: 0, latestChecks: [] };
  let initialized = false, writable = true, lastError = null, dirty = false;

  const snapshot = () => ({ version: PAPER_STRATEGY_FOCUS_SIMULATION_VERSION, mode: 'paper_sidecar',
    execution: false, signing: false, broadcast: false, enabled: true,
    status: !initialized ? 'loading' : writable ? 'ready' : 'error',
    initialCashUsd: state.initialCashUsd, cashUsd: compact(state.cashUsd), realizedPnlUsd: compact(state.realizedPnlUsd),
    unrealizedPnlUsd: state.positions.length && state.positions.every(p => finite(p.unrealizedPnlUsd))
      ? compact(state.positions.reduce((sum, p) => sum + p.unrealizedPnlUsd, 0)) : state.positions.length ? null : 0,
    entries: state.trades.filter(trade => trade.side === 'buy').length,
    completedTrades: state.trades.filter(trade => trade.side === 'sell').length,
    wins: state.trades.filter(trade => trade.side === 'sell' && trade.realizedPnlUsd > 0).length,
    losses: state.trades.filter(trade => trade.side === 'sell' && trade.realizedPnlUsd <= 0).length,
    openPositions: state.positions.length, maxOpenPositions: state.maxOpenPositions,
    ticketUsd: state.ticketUsd, positions: state.positions.map(position => ({ ...position })),
    recentTrades: state.trades.slice(-20).map(trade => ({ ...trade })),
    latestChecks: state.latestChecks.slice(-20).map(check => ({ ...check })),
    droppedTrades: state.droppedTrades, droppedSignalKeys: state.droppedSignalKeys,
    updatedAt: state.updatedAt, lastError: lastError ? String(lastError).slice(0, 180) : null,
    note: '独立前向模拟账本；单笔预算固定且隔离主盘，不签名、不广播、不下真实订单。成本为模型假设；缺安全 / 叙事 / 流动性 / 新鲜数据时不模拟入场。' });

  async function persist() {
    if (!initialized || !writable || !dirty) return snapshot();
    state.updatedAt = iso(now());
    try { await atomicWrite(filePath, state); dirty = false; lastError = null; }
    catch (error) { writable = false; lastError = `focus paper simulation write failed: ${error?.code || error?.message || 'unknown'}`; }
    return snapshot();
  }

  function closePosition(position, exitPrice, exitAt, reason, candleClosedAt = null) {
    const retention = 1 - position.feeRate - position.slippageRate - position.sellTax;
    const proceedsUsd = position.quantity * exitPrice * retention - position.gasUsd;
    const realizedPnlUsd = proceedsUsd - position.ticketUsd;
    state.cashUsd += proceedsUsd;
    state.realizedPnlUsd += realizedPnlUsd;
    const trade = { id: `focus:${position.chain}:${position.address}:${position.signalCandleClosedAt}`,
      side: 'sell', chain: position.chain, address: position.address, symbol: position.symbol,
      strategyId: position.strategyId, entryAt: position.openedAt, exitAt: iso(exitAt),
      entryPrice: position.entryPrice, exitPrice, ticketUsd: position.ticketUsd, quantity: position.quantity,
      supportPrice: position.supportPrice, targetPrice: position.targetPrice,
      entryCostsUsd: compact(position.entryCostsUsd), exitCostsUsd: compact(position.quantity * exitPrice * (1 - retention) + position.gasUsd),
      realizedPnlUsd: compact(realizedPnlUsd), realizedReturnRate: compact(realizedPnlUsd / position.ticketUsd),
      exitReason: reason, exitCandleClosedAt: candleClosedAt ? iso(candleClosedAt) : null,
      costModel: 'assumed_round_trip_costs_v1', execution: false, signing: false, broadcast: false };
    state.trades.push(trade);
    if (state.trades.length > state.maxTrades) {
      const removed = state.trades.splice(0, state.trades.length - state.maxTrades);
      state.droppedTrades += removed.length;
    }
    state.positions = state.positions.filter(item => item !== position);
    dirty = true;
  }

  function advanceExits(marks, nowMs) {
    for (const position of [...state.positions]) {
      const mark = (marks || []).find(row => tokenKey(row?.chain, row?.address) === tokenKey(position.chain, position.address));
      const markAt = stamp(mark?.observedAt);
      const hasFreshMark = mark?.status === 'ok' && positive(mark.price) && Number.isFinite(markAt)
        && markAt <= nowMs && nowMs - markAt <= MAX_QUOTE_AGE_MS;
      if (hasFreshMark) {
        position.markPrice = mark.price; position.markAt = iso(markAt); position.markStatus = 'fresh';
        const retention = 1 - position.feeRate - position.slippageRate - position.sellTax;
        position.unrealizedPnlUsd = compact(position.quantity * mark.price * retention - position.gasUsd - position.ticketUsd);
      } else {
        position.markStatus = 'stale'; position.unrealizedPnlUsd = null;
      }

      const chart = mark?.chart;
      const chartAt = stamp(chart?.last?.time);
      const chartReady = chart?.ready === true && chart.chain === position.chain
        && canonicalAddress(position.chain, chart.address) === canonicalAddress(position.chain, position.address)
        && Array.isArray(chart.rows) && Number.isFinite(chartAt) && chartAt <= nowMs;
      if (!chartReady) {
        position.coverageStatus = 'fresh_closed_chart_unavailable';
        continue;
      }
      let exited = false;
      const bars = [...chart.rows].sort((a, b) => stamp(a.time) - stamp(b.time));
      for (const bar of bars) {
        const openAt = stamp(bar.time), closedAt = openAt + 60_000;
        if (!Number.isFinite(openAt) || closedAt > nowMs || closedAt <= stamp(position.openedAt)
          || closedAt <= stamp(position.lastProcessedCandleClosedAt)) continue;
        if (![bar.open, bar.high, bar.low, bar.close].every(positive) || bar.high < Math.max(bar.open, bar.close, bar.low)
          || bar.low > Math.min(bar.open, bar.close)) {
          position.coverageStatus = 'invalid_post_entry_candle'; break;
        }
        const previousClose = stamp(position.lastProcessedCandleClosedAt);
        if (Number.isFinite(previousClose) && closedAt - previousClose > 60_000) {
          position.coverageStatus = 'post_entry_candle_gap'; break;
        }
        const stopHit = bar.low <= position.supportPrice;
        const targetHit = bar.high >= position.targetPrice;
        position.lastProcessedCandleClosedAt = iso(closedAt); dirty = true;
        if (stopHit) {
          const conservativeStopFill = Math.min(bar.open, position.supportPrice);
          closePosition(position, conservativeStopFill, closedAt,
            targetHit ? '同一根K线同时触及目标和失效位，保守按止损先触发' : '收盘K线触及结构失效位', closedAt);
          exited = true; break;
        }
        if (targetHit) {
          closePosition(position, position.targetPrice, closedAt, '收盘K线触及结构目标参考位（不计价差改善）', closedAt);
          exited = true; break;
        }
        position.coverageStatus = 'continuous_post_entry_closed_candles';
      }
      if (exited) continue;
      if (hasFreshMark && nowMs - stamp(position.openedAt) >= MAX_HOLD_MS
        && position.coverageStatus === 'continuous_post_entry_closed_candles'
        && Number.isFinite(stamp(position.lastProcessedCandleClosedAt))
        && nowMs - stamp(position.lastProcessedCandleClosedAt) <= 120_000) {
        closePosition(position, mark.price, markAt, '连续收盘K线覆盖下达到 60 分钟纸面持有期限');
        continue;
      }
      if (!hasFreshMark) position.unrealizedPnlUsd = null;
    }
  }

  return {
    filePath,
    async initialize() {
      if (initialized) return snapshot();
      try {
        await fs.mkdir(dataDir, { recursive: true });
        let info;
        try { info = await fs.stat(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (info && info.size > 16 * 1024 * 1024) throw new Error('focus paper journal exceeds safe read limit');
        if (info) {
          const loaded = JSON.parse(await fs.readFile(filePath, 'utf8'));
          if (!validateState(loaded, config)) throw new Error('focus paper journal schema invalid; original file preserved');
          state = { ...loaded, ...config,
            positions: loaded.positions,
            trades: loaded.trades.slice(-maxTrades),
            openedSignalKeys: loaded.openedSignalKeys.slice(-maxOpenedSignalKeys),
            latestChecks: loaded.latestChecks.slice(-maxLatestChecks) };
        }
      } catch (error) { writable = false; lastError = `focus paper journal initialization failed: ${error?.code || error?.message || 'unknown'}`; }
      initialized = true;
      return snapshot();
    },
    openPositions() { return state.positions.map(position => ({ ...position })); },
    async advance({ evaluations = [], marks = [], nowMs = now() } = {}) {
      if (!initialized || !writable || !finite(nowMs)) return snapshot();
      advanceExits(marks, nowMs);
      const opened = new Set(state.openedSignalKeys);
      const existing = new Set(state.positions.map(position => tokenKey(position.chain, position.address)));
      for (const evaluation of Array.isArray(evaluations) ? evaluations : []) {
        const shadow = evaluation?.evidence?.strategyFocusShadow;
        if (shadow?.externalSecondBreakout?.signalReady !== true) continue;
        const normalized = normalizedCandidate(evaluation, nowMs, ticketUsd);
        const key = normalized.signalKey;
        if (opened.has(key)) continue;
        if (state.positions.length >= maxOpenPositions) normalized.reasons = [...(normalized.reasons || []), '独立纸面实验仓位上限已满'];
        if (existing.has(tokenKey(evaluation.token?.chain, evaluation.token?.address))) normalized.reasons = [...(normalized.reasons || []), '该 CA 已有独立实验持仓'];
        const ticket = normalized.position?.ticketUsd;
        if (normalized.eligible && finite(ticket) && state.cashUsd < ticket) normalized.reasons = ['独立纸面实验余额不足'];
        const checkResult = normalized.reasons?.length ? 'rejected' : normalized.eligible ? 'opened' : 'rejected';
        const reasonRows = normalized.reasons || [];
        const prior = state.latestChecks.find(check => check.signalKey === key);
        const signature = JSON.stringify([checkResult, reasonRows]);
        if (!prior || prior.signature !== signature) {
          if (prior) { prior.checkedAt = iso(nowMs); prior.result = checkResult; prior.reasons = reasonRows.slice(0, 6); prior.signature = signature; }
          else state.latestChecks.push({ signalKey: key, checkedAt: iso(nowMs), result: checkResult,
            reasons: reasonRows.slice(0, 6), signature });
          if (state.latestChecks.length > maxLatestChecks) state.latestChecks.splice(0, state.latestChecks.length - maxLatestChecks);
          dirty = true;
        }
        if (checkResult !== 'opened' || !normalized.position) continue;
        const position = normalized.position;
        state.cashUsd -= position.ticketUsd;
        state.positions.push(position);
        state.openedSignalKeys.push(key);
        opened.add(key); existing.add(tokenKey(position.chain, position.address));
        if (state.openedSignalKeys.length > maxOpenedSignalKeys) {
          const removed = state.openedSignalKeys.splice(0, state.openedSignalKeys.length - maxOpenedSignalKeys);
          state.droppedSignalKeys += removed.length;
        }
        state.trades.push({ id: `focus:${position.chain}:${position.address}:${position.signalCandleClosedAt}`,
          side: 'buy', chain: position.chain, address: position.address, symbol: position.symbol,
          strategyId: position.strategyId, entryAt: position.openedAt, signalCandleClosedAt: position.signalCandleClosedAt,
          entryPrice: position.entryPrice, ticketUsd: position.ticketUsd, quantity: position.quantity,
          supportPrice: position.supportPrice, targetPrice: position.targetPrice,
          entryCostsUsd: compact(position.entryCostsUsd), costModel: 'assumed_round_trip_costs_v1',
          narrativeEvent: position.narrativeEvent, narrativeSourceUrl: position.narrativeSourceUrl,
          operatorFootprintStatus: position.operatorFootprintStatus,
          execution: false, signing: false, broadcast: false });
        dirty = true;
      }
      if (state.trades.length > maxTrades) {
        const removed = state.trades.splice(0, state.trades.length - maxTrades);
        state.droppedTrades += removed.length; dirty = true;
      }
      await persist();
      return snapshot();
    },
    async flush() { return persist(); },
    snapshot,
  };
}
