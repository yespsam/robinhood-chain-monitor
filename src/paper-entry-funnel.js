import { isDiagnosticPaperEntry } from './paper-diagnostic-entry.js';
import { isConfirmedPaperEntry } from './paper-confirmed-policy.js';
import { readyForPaperQuote, researchReadyForQuote } from './paper-candidate-research.js';

const key=t=>`${t?.chain}:${t?.chain==='sol'?t?.address:String(t?.address||'').toLowerCase()}`;
const stages=[
  ['safety_blocked','明确不可交易或安全检查未通过'],
  ['market_data','行情缺失或过期，等待补齐'],
  ['catalyst','缺少有效原文催化或核实盈利钱包'],
  ['reentry','上次亏损后的重入证据不足'],
  ['safety_data','该入口所需安全字段尚未补齐'],
  ['fees','所选账本的费用模型不可用'],
  ['chart_missing','买点数据未取得，尚不能判断有无机会'],
  ['chart_stale','买点K线已过期，等待刷新'],
  ['chart_incomplete','买点K线不足或断档，等待补齐'],
  ['chart_invalid','买点K线校验未通过'],
  ['structure','入场结构或退出依据尚未建立'],
  ['setup','买盘、形态或其他入场条件尚未成立'],
  ['quote_wait','已可研究报价，等待调度名额'],
  ['quote_scheduled','已进入报价调度，等待报价与资料确认'],
  ['eligible','模拟条件已通过，是否成交以账本为准'],
];

// Independent of the legacy nested funnel: one primary state per exact CA,
// with source/quote counts alongside it. This is telemetry, never an entry gate.
export function paperEntryDiagnostics(evaluations=[],{quoteTargets=[]}={}) {
  const scheduled=new Set(quoteTargets.filter(t=>t.purpose==='candidate'&&t.candidateBook!=='comparison').map(key));
  const groups=new Map();
  for(const row of evaluations) {
    if(!row?.token?.chain||!row.token.address)continue;
    const k=key(row.token);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(row);
  }
  const canQuote=r=>Array.isArray(r.reasons)&&Array.isArray(r.missing)&&(readyForPaperQuote(r)||researchReadyForQuote(r));
  const state=row=>{
    const e=row.evidence||{},repair=e.lossRepair;
    if(row.decision==='可模拟'&&e.paperEligible===true)return 'eligible';
    if(row.decision==='不买'||e.safety?.blocked?.length)return 'safety_blocked';
    if(e.marketFresh!==true)return 'market_data';
    if(repair&&(repair.entryPathAllowed??repair.catalystReady)!==true)return 'catalyst';
    if(repair&&repair.reentry?.ready!==true)return 'reentry';
    if(e.safety?.missing?.length)return 'safety_data';
    if(repair&&repair.fee?.ready!==true)return 'fees';
    if(canQuote(row))return scheduled.has(key(row.token))?'quote_scheduled':'quote_wait';
    if(repair?.entryPath==='external_structure'||e.opportunity?.basis==='ohlcv') {
      const window=e.opportunity?.chartWindow;
      if(window?.code==='source_unavailable')return 'chart_missing';
      if(window?.code==='stale_closed_bars')return 'chart_stale';
      if(['insufficient_closed_bars','missing_intervals','insufficient_contiguous_tail'].includes(window?.code))return 'chart_incomplete';
      if(window?.code&&window.code!=='ready')return 'chart_invalid';
    }
    if(repair&&!repair.thesis)return 'structure';
    return 'setup';
  };
  const rank=new Map(stages.map(([id],i)=>[id,i])),counts=new Map();
  let verifiedCatalyst=0,externalStructure=0,quoteResearchReady=0,quoteScheduled=0,eligible=0;
  for(const rows of groups.values()) {
    const states=rows.map(state).sort((a,b)=>rank.get(b)-rank.get(a));
    counts.set(states[0],(counts.get(states[0])||0)+1);
    if(rows.some(r=>r.evidence?.lossRepair?.catalystReady===true))verifiedCatalyst++;
    if(rows.some(r=>r.evidence?.lossRepair?.entryPath==='external_structure'&&r.evidence.lossRepair.entryPathAllowed===true))externalStructure++;
    if(rows.some(canQuote))quoteResearchReady++;
    if(scheduled.has(key(rows[0].token)))quoteScheduled++;
    if(states[0]==='eligible')eligible++;
  }
  return {version:'paper_entry_diagnostics_v1',detected:groups.size,verifiedCatalyst,externalStructure,quoteResearchReady,quoteScheduled,eligible,
    blockers:stages.map(([code,label])=>({code,label,count:counts.get(code)||0})).filter(s=>s.count).sort((a,b)=>b.count-a.count),
    note:'按链与 CA 去重的当前快照；每个候选只计一个主要状态。没有有效候选不代表市场没有机会，调度与条件通过均不等于成交。'};
}
const finite = value => typeof value === 'number' && Number.isFinite(value);
const ratio = (part, whole) => whole > 0 ? part / whole : null;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};
const waitMs = row => {
  const queued = Date.parse(row?.queuedAt || '');
  const received = Date.parse(row?.receivedAt || '');
  return Number.isFinite(queued) && Number.isFinite(received) && received >= queued ? received - queued : null;
};

const chartKey = row => row?.chartKey || (row?.chain && row?.address ? `${row.chain}:${row.address}` : null);
const tokenKey = token => `${token.chain}:${token.address}`;

// Telemetry only. Never-fetched names are not source failures, and confirmed
// funnel.chartReady is quote confirmation, not this OHLCV count.
export function summarizeChartHealth({ evaluations = [], chartRows = [], queueRecent = [], funnels = [], hotKeys = [], chartDispatchCount = 0 } = {}) {
  const fetched = new Map();
  for (const row of chartRows) {
    const key = chartKey(row);
    if (!key) continue;
    const prior = fetched.get(key) || { status: null, stale: false, short: false };
    const status = row.status || row.sourceStatus || null;
    if (status) prior.status = status;
    fetched.set(key, prior);
  }
  const byToken = new Map();
  for (const row of evaluations) {
    const token = row?.token;
    if (!token?.chain || !token.address) continue;
    const key = tokenKey(token);
    const item = byToken.get(key) || { ready: false, klineOk: false, unavailable: false, stale: false, short: false };
    const code = row.evidence?.opportunity?.chartWindow?.code;
    const recoveryStatus = row.evidence?.recoveryEntry?.klineStatus;
    if (row.evidence?.chart?.ready === true || code === 'ready') item.ready = true;
    if (recoveryStatus === 'ok' || code === 'ready') item.klineOk = true;
    if (recoveryStatus === 'unavailable' || code === 'source_unavailable') item.unavailable = true;
    if (code === 'stale_closed_bars') item.stale = true;
    if (code === 'insufficient_closed_bars' || code === 'insufficient_contiguous_tail') item.short = true;
    byToken.set(key, item);
  }
  const rows = [...byToken.values()];
  const evaluated = rows.length;
  const chartReady = rows.filter(row => row.ready).length;
  const klineOk = rows.filter(row => row.klineOk).length;
  let notRequested = 0, fetchedCount = 0, fetchedUnavailable = 0, staleClosedBars = 0, insufficientClosedBars = 0;
  for (const [key, item] of byToken) {
    const cache = fetched.get(key);
    const didFetch = !!cache || item.klineOk || item.stale || item.short || (item.ready && !item.unavailable);
    if (!didFetch) { notRequested++; continue; }
    fetchedCount++;
    const empty = cache ? cache.status !== 'ok' && cache.status !== null : item.unavailable && !item.klineOk && !item.stale && !item.short;
    if (empty) fetchedUnavailable++;
    if (item.stale) staleClosedBars++;
    if (item.short) insufficientClosedBars++;
  }
  const hot = [...new Set(hotKeys.filter(key => typeof key === 'string' && key.includes(':')))];
  const hotFetched = hot.filter(key => {
    const item = byToken.get(key), cache = fetched.get(key);
    return !!cache || item?.klineOk || item?.stale || item?.short || item?.ready;
  }).length;
  const hotChartReady = hot.filter(key => byToken.get(key)?.ready).length;
  const hotKlineOk = hot.filter(key => byToken.get(key)?.klineOk).length;
  const waits = [...chartRows.map(waitMs), ...queueRecent.filter(row => row?.kind === 'market:kline').map(row => row.localQueueMs)]
    .filter(value => finite(value) && value >= 0);
  const queueWaitMedianMs = median(waits);
  const warmup = hot.length > 0 && hotFetched < hot.length && chartDispatchCount < hot.length * 2;
  const hotStarved = hot.length >= 3 && !warmup && hotFetched / hot.length < 0.8 && chartDispatchCount >= hot.length;
  const fetchedBad = fetchedCount >= 8 && fetchedUnavailable / fetchedCount >= 0.5;
  const queueBad = queueWaitMedianMs !== null && queueWaitMedianMs >= 20000;
  const alert = hotStarved || fetchedBad || queueBad;
  const funnelOhlcvReady = funnels.reduce((sum, funnel) => sum + (finite(funnel?.ohlcvReady) ? funnel.ohlcvReady : 0), 0);
  const note = warmup
    ? '热点 K 线仍在首轮拉取，未请求的广谱候选不算来源失败。确认型漏斗的 chartReady 是连续报价，不是 K 线。买卖条件未放宽。'
    : hotStarved
      ? '热点候选里仍有较多 CA 没有第一次 K 线请求。广谱未请求不计入来源失败。买卖条件未放宽。'
      : fetchedBad
        ? '已请求的 K 线里空响应偏多。过期或根数不足仍按原门槛拒绝，不补造 K 线。'
        : queueBad
          ? 'K 线排队中位数达到 20 秒。买卖条件未放宽。'
          : '未请求的广谱候选单独计数。确认型漏斗 chartReady 是连续报价确认，ohlcvReady 才是 K 线结构。不代表可以开仓。';
  return {
    version: 'chart_health_v2', alert, warmup, evaluated, chartReady, klineOk,
    notRequested, notRequestedRatio: ratio(notRequested, evaluated),
    fetched: fetchedCount, fetchedUnavailable, fetchedUnavailableRatio: ratio(fetchedUnavailable, fetchedCount),
    sourceUnavailable: fetchedUnavailable, sourceUnavailableRatio: ratio(fetchedUnavailable, fetchedCount),
    staleClosedBars, insufficientClosedBars,
    hotCount: hot.length, hotFetched, hotKlineOk, hotChartReady,
    hotChartReadyRate: ratio(hotChartReady, hot.length),
    chartReadyRate: ratio(chartReady, evaluated), klineOkRate: ratio(klineOk, evaluated),
    funnelChartReady: funnels.reduce((sum, funnel) => sum + (finite(funnel?.chartReady) ? funnel.chartReady : 0), 0),
    funnelOhlcvReady, chartDispatchCount,
    chartCacheCount: chartRows.length,
    cachedUnavailable: chartRows.filter(row => row && (row.status || row.sourceStatus) && (row.status || row.sourceStatus) !== 'ok').length,
    queueWaitMedianMs, queueWaitMaxMs: waits.length ? Math.max(...waits) : null, queueSamples: waits.length,
    note,
  };
}

// Diagnostic counts only; never used to approve a trade. Every stage is a
// subset of the preceding one, deduplicated by chain + exact normalized CA.
export function paperEntryFunnel(evaluations = []) {
  let rows = evaluations;
  const count = () => new Set(rows.map(row => `${row.token.chain}:${row.token.address}`)).size;
  const result = { detected: count() };
  for (const [name, pass] of [
    ['marketFresh', row => row.evidence?.marketFresh === true],
    ['flowReady', row => row.evidence?.opportunity ? row.evidence.opportunity.signalReady === true : row.evidence?.flowFresh === true &&
      [['uniqueBuyerCount', 'minBuyers'], ['highProfitCount', 'minHighProfit'], ['smartMoneyCount', 'minSmartMoney'], ['netBuyUsd', 'minNetBuy']]
        .every(([metric, threshold]) => Number.isFinite(row.evidence.flow?.[metric]) && Number.isFinite(row.evidence.entryThresholds?.[threshold])
          && row.evidence.flow[metric] >= row.evidence.entryThresholds[threshold])],
    ['safetyReady', row => isDiagnosticPaperEntry(row.evidence) ? row.evidence.diagnostic.fillBoundariesPass === true
      : row.evidence?.safety?.missing?.length === 0 && row.evidence.safety.blocked?.length === 0],
    ['chartReady', row => isConfirmedPaperEntry(row.evidence) ? row.evidence.confirmedPolicy.confirmation.ready === true
      : isDiagnosticPaperEntry(row.evidence) || row.evidence?.chart?.ready === true],
    ['quoteFresh', row => row.evidence?.priceFresh === true],
    ['eligible', row => row.decision === '可模拟' && row.evidence?.paperEligible === true],
  ]) { rows = rows.filter(pass); result[name] = count(); }
  const seen = new Set();
  result.ohlcvReady = 0;
  for (const row of evaluations) {
    if (!row?.token?.chain || !row.token.address) continue;
    const key = `${row.token.chain}:${row.token.address}`;
    if (seen.has(key)) continue;
    const ohlcv = row.evidence?.chart?.ready === true || row.evidence?.opportunity?.chartWindow?.code === 'ready';
    if (!ohlcv) continue;
    seen.add(key); result.ohlcvReady++;
  }
  // Confirmed mode stores quote-path confirmation in chartReady. This alias
  // makes that explicit; ohlcvReady is the candle structure count.
  result.confirmationReady = result.chartReady;
  return result;
}
