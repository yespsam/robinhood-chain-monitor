import { confirmedPaperEntry, confirmedAccountGate } from './paper-confirmed-policy.js';
import { freshNarrativeRecall } from './paper-narrative-recall.js';
import { traderDecision } from './paper-trader-reasoning.js';
import { reviewStructurePattern, structureEconomics, OPPORTUNITY_REVIEW_VERSION, MEME_STRUCTURE_ENTRY_VERSION } from './paper-opportunity-review.js';
import {alphaPaperEntry} from './paper-alpha-entry.js';
import {monitoredPaperEntry} from './paper-monitor-entry.js';
import {collectivePaperEntry} from './paper-collective-entry.js';
import {evaluatePaperStrategyFocusShadow} from './paper-strategy-focus-shadow.js';

export const OPPORTUNITY_VERSION = 'multi_setup_v2';
export const OPPORTUNITY_ROUTES = Object.freeze([
  { id: 'flow_momentum', label: '聪明钱动量', basis: 'flow', description: '双地址新增买盘、聪明钱标签与连续报价确认。' },
  { id: 'internal_launch', label: '内盘启动', basis: 'flow', description: '已核实内盘或临毕业；双地址净买入，不强制聪明钱标签。' },
  { id: 'external_breakout', label: '外盘放量突破', basis: 'ohlcv', description: '收盘突破前 12 根压力位，成交额至少为基线 1.5 倍；现价仍站稳突破位。' },
  { id: 'external_pullback', label: '外盘回踩再启动', basis: 'ohlcv', description: '观察窗口曾上涨至少 25%，回撤 15%–65% 后出现抬高低点、放量收复前根高点。' },
  { id: 'external_trend', label: '外盘趋势延续', basis: 'ohlcv', description: '均线差、斜率、放量与向上报价共同确认；真实结构空间须覆盖成本，弱趋势只观察。' },
  { id: 'narrative_recall', label: '叙事 OG 回流', basis: 'flow', description: '核实七天内历史主题、新催化出处及精确 CA，再由新增买盘和报价确认。' },
]);
const finite = n => typeof n === 'number' && Number.isFinite(n);
const positive = n => finite(n) && n > 0;
const stamp = n => typeof n === 'number' ? (n < 1e10 ? n * 1000 : n) : Date.parse(n || '');
const median = rows => { const r = rows.toSorted((a,b) => a-b); return r.length ? r[Math.floor(r.length/2)] : 0; };
const ema = (rows, period) => rows.reduce((v,r,i) => i ? r.close*2/(period+1)+v*(1-2/(period+1)) : r.close, 0);

// Closed candles only: no invented bars, forward fills or unfinished-candle signals.
export const MAIN_CHART_WINDOW_VERSION = 'contiguous_tail_v1';
export function opportunityChart(candles, status, nowMs, {contiguousTail=false}={}) {
  // Legacy callers retain full-window integrity. Main-entry callers can select
  // a consecutive suffix, but never fill gaps or renew source timestamps.
  const diagnostics = { receivedBars:Array.isArray(candles)?candles.length:null, closedBars:0, lastClosedAtMs:null };
  const fail = (reason, code, issue = null) => ({ ready: false, reason, rows: [], diagnostics:{...diagnostics,code,issue} });
  if (status !== 'ok' || !Array.isArray(candles)) return fail('新鲜且足够的 K 线',status!=='ok'?'source_unavailable':'invalid_candle_list');
  let rows = candles.map(c => ({ ...c, time: stamp(c.time) }))
    .filter(c => c.time >= nowMs-61*60000 && c.time+60000 <= nowMs).sort((a,b) => a.time-b.time).slice(-60);
  Object.assign(diagnostics,{closedBars:rows.length,firstOpenAtMs:rows[0]?.time??null,lastClosedAtMs:rows.length?rows.at(-1).time+60000:null});
  if (rows.length < 13) return fail('新鲜且足够的 K 线','insufficient_closed_bars');
  if (nowMs-rows.at(-1).time-60000 > 90000) return fail('新鲜且足够的 K 线','stale_closed_bars');
  let lastGap=null;
  for (const [i,r] of rows.entries()) {
    const issue={index:i,openAtMs:r.time};
    let code;
    if (![r.open,r.high,r.low,r.close].every(positive)) code='invalid_price';
    else if (!finite(r.volume) || r.volume<0) code='invalid_volume';
    else if (r.high<Math.max(r.open,r.close,r.low) || r.low>Math.min(r.open,r.close)) code='invalid_ohlc_range';
    else if (i && r.time-rows[i-1].time!==60000) {
      const gapMs=r.time-rows[i-1].time;
      code=gapMs===0?'duplicate_time':gapMs>60000&&gapMs%60000===0?'missing_intervals':'irregular_interval';
      Object.assign(issue,{previousOpenAtMs:rows[i-1].time,gapMs,...(code==='missing_intervals'?{missingIntervals:gapMs/60000-1}:{})});
    }
    if (code==='missing_intervals' && contiguousTail) lastGap=issue;
    else if (code) return fail('K 线缺口、重复或价格字段异常',code,issue);
  }
  if(contiguousTail) {
    // An older missing minute is a boundary, never a zero-volume invented bar.
    // Keep at least 24 consecutive real closed minutes after the LAST gap.
    // Duplicates, malformed values and irregular intervals still fail globally.
    if(lastGap && rows.length-lastGap.index<24)return fail('K 线缺口后连续收盘样本不足','insufficient_contiguous_tail',lastGap);
    const excludedPrefixBars=lastGap?.index||0;
    rows=rows.slice(excludedPrefixBars);
    Object.assign(diagnostics,{windowPolicy:MAIN_CHART_WINDOW_VERSION,excludedPrefixBars,usedBars:rows.length,
      usedFirstOpenAtMs:rows[0]?.time??null,gapBoundary:lastGap});
  }
  return { ready: true, rows, last: rows.at(-1), previous: rows.at(-2), diagnostics:{...diagnostics,code:'ready',issue:null} };
}

function shape(route, chart, price, evidenceExit = false) {
  if (!chart.ready) return { ready: false, missing: chart.reason === '新鲜且足够的 K 线', reason: chart.reason };
  const { rows, last, previous } = chart;
  const baseline = median(rows.slice(-13,-1).map(r=>r.volume));
  const volumeMultiple = baseline > 0 ? last.volume/baseline : null;
  const data = { closedAt: last.time+60000, close: last.close, volumeUsd: last.volume, baselineVolumeUsd: baseline, volumeMultiple };
  let ready = false, support = null, reason;
  if (route.id === 'external_breakout') {
    const resistance = Math.max(...rows.slice(-13,-1).map(r=>r.high));
    support = resistance*.995;
    ready = last.close > resistance*1.002 && volumeMultiple >= 1.5 && price >= resistance && price <= resistance*1.08;
    Object.assign(data,{ resistance }); reason = '等待收盘放量突破并站稳前 12 根压力位';
  } else if (route.id === 'external_pullback') {
    const history = rows.slice(0,-3), peakIndex = history.reduce((best,r,i) => r.high > history[best].high ? i : best,0);
    const peak = history[peakIndex].high, base = Math.min(...history.slice(0,peakIndex+1).map(r=>r.low));
    const trough = Math.min(...rows.slice(peakIndex+1,-1).map(r=>r.low));
    const rise = peak/base-1, pullback = 1-trough/peak;
    support = Math.min(last.low,previous.low)*.995;
    ready = peakIndex >= 2 && rise >= .25 && pullback >= .15 && pullback <= .65
      && last.low > previous.low && last.close > previous.high && last.close > last.open
      && volumeMultiple >= 1.2 && price >= previous.high && price <= last.close*1.03;
    Object.assign(data,{ peak, base, trough, rise, pullback }); reason = '等待拉升后有效回踩、抬高低点及放量收复';
  } else {
    const fast = ema(rows,8), slow = ema(rows,21), priorFast = ema(rows.slice(0,-1),8);
    support = fast*.99;
    ready = rows.length >= 24 && fast > slow && fast > priorFast && last.close >= fast
      && price >= fast && price <= fast*1.06 && last.close >= previous.close && volumeMultiple >= .8;
    Object.assign(data,{ ema8:fast, ema21:slow, priorEma8:priorFast }); reason = '等待均线上行、量能持续且价格不过度偏离';
  }
  // A structural invalidation beyond 6% cannot be silently replaced with an
  // unrelated tighter stop. Wait for a better-priced entry instead.
  if (ready && !(support > 0 && support < price && (evidenceExit || support >= price*.94))) {
    ready = false; reason = evidenceExit ? '结构参考位无效或现价已失守' : '结构失效位距离超过 6% 或现价已跌破，等待更好位置';
  }
  return { ...data, ready, support, reason: ready ? null : reason };
}

export function confirmStructureQuotes(history, token, pattern, nowMs) {
  const rows = [], times = new Map();
  for (const q of history || []) {
    const at = stamp(q.observedAt);
    if (q.status !== 'ok' || q.chain !== token.chain || q.address !== token.address || !positive(q.price)
      || !finite(at) || at > nowMs || nowMs-at > 15000) continue;
    if (times.has(at)) { if (times.get(at) !== q.price) return { ready:false,reason:'同时间报价存在冲突' }; continue; }
    times.set(at,q.price); rows.push({ price:q.price, observedAt:q.observedAt, at });
  }
  rows.sort((a,b)=>a.at-b.at);
  const first=rows[0], last=rows.at(-1);
  if (rows.length < 2 || last.at-first.at < 3000 || nowMs-last.at > 5000
    || rows.some((r,i)=>i && r.at-rows[i-1].at > 10000)) return { ready:false,reason:'连续新鲜报价确认',count:rows.length };
  const ready = pattern.ready && last.price === token.price && rows.every(r=>r.price > pattern.support)
    && Math.max(...rows.map(r=>r.price))/Math.min(...rows.map(r=>r.price)) <= 1.03
    && Math.abs(last.price/pattern.close-1) <= .03
    && (!pattern.reviewVersion || last.price > first.price && last.price >= rows.at(-2).price
      && last.price >= pattern.reclaimPrice && last.price >= pattern.close);
  return { version:'structure_quotes_v1',ready,count:rows.length,confirmedAt:last.observedAt,
    reason:ready ? null : pattern.reviewVersion ? '报价未收复并向上确认，或已偏离结构' : '独立报价已偏离结构或短时波动超过 3%',rows:rows.map(({at,...r})=>r) };
}

export function multiOpportunityEntry(base, options) {
  const { token, candles, klineStatus, nowMs, narrativeRecall } = options;
  const reviewed = options.opportunityReviewMode !== false;
  const evidenceExit = reviewed && options.memeExitMode === true;
  const chart = opportunityChart(candles,klineStatus,nowMs,{contiguousTail:evidenceExit});
  const routes = OPPORTUNITY_ROUTES.map(def => {
    const route = { ...def, version:reviewed ? OPPORTUNITY_VERSION : 'multi_setup_v1', ...(reviewed ? {reviewVersion:OPPORTUNITY_REVIEW_VERSION} : {}), missing:[], reasons:[] };
    // The isolated legacy control retains its old checks. Do not describe it
    // with main-only confirmation/economics requirements it never evaluated.
    if (!reviewed && route.id === 'external_trend') route.description = '旧策略对照：EMA8 高于 EMA21 且继续上行；收盘不低于 EMA8 与前收，现价位于 EMA8 至其上方 6%，成交额至少为基线 0.8 倍。独立报价检查新鲜度与结构偏离，不要求上涨；不启用新版结构空间/成本后盈亏比筛选。';
    if (token.stageConflict) route.missing.push('内外盘来源冲突待核对');
    if (!['internal','near_completion','external'].includes(base.evidence.marketStage)) route.missing.push('已核实内外盘阶段');
    if (route.id === 'internal_launch' && !['internal','near_completion'].includes(base.evidence.marketStage)) route.reasons.push('等待已核实内盘或临毕业');
    if (route.id === 'narrative_recall' && !freshNarrativeRecall(narrativeRecall,base.token,nowMs)) route.missing.push('绑定精确 CA 的新鲜叙事催化');
    if (route.basis === 'ohlcv') {
      if (base.evidence.marketStage !== 'external') route.reasons.push('仅适用于已核实外盘');
      const created = stamp(token.creationTimestamp ?? token.createdAt);
      route.pattern = shape(route,chart,base.token.price,evidenceExit);
      if (reviewed) {
        route.pattern = reviewStructurePattern(route,chart,base.token.price,route.pattern,{evidenceExit});
        if (chart.ready) {
          route.economics = structureEconomics(route.pattern,base.token.price,base.evidence.costAssumptions,base.entryUsd);
          if (!route.economics.ready) route.reasons.push(route.economics.reason);
        }
      }
      // Candle timestamps identify the start of a minute. A token created
      // inside that first minute legitimately shares its bucket; an entire
      // candle ending before creation is still a provenance failure.
      if (chart.ready && finite(created) && chart.diagnostics.firstOpenAtMs+60000 <= created) route.reasons.push('K 线早于代币创建时间，来源待核对');
      if (!route.pattern.ready) (route.pattern.missing ? route.missing : route.reasons).push(route.pattern.reason);
      route.confirmation = confirmStructureQuotes(options.quoteHistory,base.token,route.pattern,nowMs);
      // Pattern failures already have a precise explanation; allow chart research
      // before reserving independent quote capacity for a confirmed structure.
      if (!route.pattern.ready) route.confirmation = { ready:false,reason:'连续新鲜报价确认' };
      route.signalAt = route.pattern.closedAt;
    } else route.signalAt = options.pulse?.lastBuyAt;
    route.signalId = finite(route.signalAt) ? `${token.chain}:${token.address}:${route.id}:${route.signalAt}` : null;
    const row = confirmedPaperEntry(base,{ ...options, narrativeRecall:route.id==='narrative_recall'?narrativeRecall:null, route });
    if(evidenceExit && route.basis==='ohlcv') {
      row.evidence.opportunity.chartWindowPolicy=MAIN_CHART_WINDOW_VERSION;
      row.evidence.opportunity.chartWindow=structuredClone(chart.diagnostics);
    }
    if (evidenceExit && route.basis==='ohlcv') {
      row.evidence.entryPlan = {...row.evidence.entryPlan, entryPolicyVersion:MEME_STRUCTURE_ENTRY_VERSION,
        stopRole:'structure_reference_only', maxStructureDistance:null,
        summary:'真实结构只作研究参考，不用固定 6% 距离拒绝主盘新仓；形态、独立报价和成本空间仍须成立。'};
      row.evidence.opportunity.entryPolicyVersion=MEME_STRUCTURE_ENTRY_VERSION;
      row.entryLogic += ' 主盘证据退出配套入口：不设固定 6% 结构距离上限；结构盈亏比仅为情景估算，不代表固定止损或最大亏损。';
    }
    if (row.decision==='可模拟' && route.basis==='ohlcv') row.evidence.opportunity.closedCandles=structuredClone(chart.rows);
    if (options.opportunityAccount && row.decision==='可模拟') {
      const gate=confirmedAccountGate(options.opportunityAccount,nowMs,row.token,options.pulse,row.evidence.narrativeRecall,
        {continuousPaperMode:options.continuousPaperMode,opportunity:row.evidence.opportunity});
      if (!gate.allowed) {
        row.decision='观察';row.reasons=gate.reasons;row.evidence.paperEligible=false;row.evidence.entryPlan.eligible=false;
        row.evidence.traderDecision=traderDecision(row,nowMs);
      }
    }
    return row;
  });
  for(const [signal,entry] of [[options.monitorSignal,monitoredPaperEntry],[options.alphaSignal,alphaPaperEntry],
    [options.lossRepairMode&&options.collectiveSignal,collectivePaperEntry]])if(evidenceExit && signal){
    const row=entry(base,options);
    if(options.opportunityAccount&&row.decision==='可模拟'){
      const gate=confirmedAccountGate(options.opportunityAccount,nowMs,row.token,null,null,
        {continuousPaperMode:true,opportunity:row.evidence.opportunity});
      if(!gate.allowed){row.decision='观察';row.reasons=gate.reasons;row.evidence.paperEligible=false;row.evidence.entryPlan.eligible=false;}
    }
    routes.unshift(row);
  }
  // Every route must finish its own evidence checks BEFORE selecting a winner.
  // A monitored event's post-event buying requirements do not belong to an
  // independent OHLCV setup (nor may the OHLCV result validate the event).
  const checkedRoutes=options.finalizeRoute?routes.map(options.finalizeRoute):routes;
  const ordered = checkedRoutes.toSorted((a,b) => Number(b.decision==='可模拟')-Number(a.decision==='可模拟')
    || Number(b.evidence.lossRepair?.entryPathAllowed===true)-Number(a.evidence.lossRepair?.entryPathAllowed===true)
    || (a.missing.length+a.reasons.length)-(b.missing.length+b.reasons.length));
  const result = ordered[0];
  result.evidence.opportunityRoutes = checkedRoutes.map(r=>({ ...r.evidence.opportunity,
    decision:r.decision,missing:r.missing,reasons:r.reasons,score:r.score,
    ...(r.evidence.lossRepair?{lossRepair:{catalystReady:r.evidence.lossRepair.catalystReady,
      entryPathAllowed:r.evidence.lossRepair.entryPathAllowed,entryPath:r.evidence.lossRepair.entryPath,
      reentry:{ready:r.evidence.lossRepair.reentry.ready}}}:{}),
    ...(r.evidence.recoveryCheck?{recoveryCheck:r.evidence.recoveryCheck}:{}) }));
  if (reviewed) result.evidence.strategyFocusShadow = evaluatePaperStrategyFocusShadow({
    token:base.token,marketStage:base.evidence.marketStage,chart,quoteHistory:options.quoteHistory,nowMs:options.nowMs,
    costAssumptions:base.evidence.costAssumptions,budgetUsd:base.entryUsd,collectiveSignal:options.collectiveSignal });
  if(options.finalizeRoute)result.evidence.routeSelectionVersion='recovery_per_route_v1';
  if (result.decision==='可模拟'||result.evidence.traderDecision) result.evidence.traderDecision=traderDecision(result,nowMs);
  return result;
}

// Cheap research admission, not permission to trade. No wallet-tag prerequisite.
export function canResearchExternal(input, decisions) {
  const v = decisions[0]?.evidence;
  const age=input.nowMs-stamp(input.observedAt);
  return !['internal','near_completion'].includes(input.token?.marketStage) && !input.token.stageConflict
    && (v?.marketFresh || input.marketStatus==='ok' && age>=0 && age<=600000)
    && v.liquidity >= 20000 && v.volume?.value > 0 && !v.safety?.blocked?.length;
}
