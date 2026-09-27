import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { STRATEGY_POLICIES, createPaperStrategyAccount, advancePaperStrategyAccount, evaluatePaperStrategies, resetPaperCash } from './paper-strategy-engine.js';
import {alphaListingSignals,alphaCatalogReport,ALPHA_ENTRY_VERSION} from './binance-alpha-catalog.js';
import {MONITOR_ENTRY_VERSION} from './paper-monitor-signal.js';
import { buildPaperDualFlowEvidence, buildPaperNarrativeEvidence, createPaperEvidenceLoader, createPaperEvidenceIndex } from './paper-strategy-evidence.js';
import { createCooperativeTurn } from './cooperative-turn.js';
import { gmgnFlowAddress, GMGN_FLOW_CHAINS } from './gmgn-flow-signal.js';
import { STRATEGY_ANALYSIS_VERSION, analyzePaperChart } from './paper-strategy-analysis.js';
import { advanceLearningShadow, validateLearningShadow, learningShadowSummary } from './wallet-learning-shadow.js';
import { discoverPaperFlowCandidates } from './paper-candidate-discovery.js';
import { mergeLearningProfiles } from './wallet-learning-universe.js';
import { PAPER_SIZING_VERSION, PAPER_LIQUIDITY_CAP_RATE, PAPER_FIXED_SIZING_VERSION, PAPER_FIXED_ENTRY_USD } from './paper-position-sizing.js';
import { UPSIDE_EXIT_POLICY } from './paper-upside-policy.js';
import { PVP_EXIT_POLICY, CONFIRMED_PVP_EXIT_POLICY, EVIDENCE_HOLD_EXIT_POLICY } from './paper-pvp-policy.js';
import { PAPER_ENTRY_POLICY_VERSION, EXPLORATORY_FLOW } from './paper-entry-policy.js';
import { mergePaperCandidateSnapshots, planPaperCandidateResearch, readyForPaperQuote, canPrefetchPaperFlow, onlyPricingOrFlowWarmupMissing } from './paper-candidate-research.js';
import { paperEntryFunnel } from './paper-entry-funnel.js';
import { gmgnReadonlyPolicy } from './gmgn-readonly-pacing.js';
import { PAPER_AUX_AUDIT_VERSION, PAPER_TAX_FILTER_VERSION, PAPER_MAX_TAX_RATE, PAPER_TAX_FILTER_TEXT, paperTaxScreen } from './paper-safety-policy.js';
import { PAPER_DIAGNOSTIC_ENTRY_VERSION } from './paper-diagnostic-entry.js';
import { CONFIRMED_PAPER_VERSION, CONFIRMED_PAPER_POLICY, confirmedAccountGate, CONTINUOUS_PAPER_VERSION, paperOperatingPolicy } from './paper-confirmed-policy.js';
import { traderDecision, compareConfirmedCandidates } from './paper-trader-reasoning.js';
import { paperSessionLedgerFile, validatePaperSession } from './paper-account-session.js';
import { advanceNarrativeRecall, validNarrativeMemory, freshNarrativeRecall } from './paper-narrative-recall.js';
import { advanceNarrativeLearning, validNarrativeLearning } from './paper-narrative-learning.js';
import { readNarrativeLearningSource } from './paper-narrative-learning-source.js';
import { OPPORTUNITY_VERSION, OPPORTUNITY_ROUTES, canResearchExternal, opportunityChart, MAIN_CHART_WINDOW_VERSION } from './paper-opportunity-policy.js';
import { MEME_STRUCTURE_ENTRY_VERSION } from './paper-opportunity-review.js';
import { STRUCTURE_COST_POLICY_VERSION, STRUCTURE_COST_TEXT, MAIN_STRUCTURE_MAX_COST_RATE } from './paper-cost-policy.js';
import { planHotResearch, selectResearchChart, selectQuoteCandidate, quoteCandidatePool, selectQuoteTarget, chartRefreshDue, advanceEntryFocus, RESEARCH_SCHEDULER_VERSION } from './paper-research-scheduler.js';
import { createReviewComparison, validateReviewComparison, reviewComparisonSummary } from './paper-review-comparison.js';
import { createExitComparison, validateExitComparison, advanceExitComparison, exitComparisonSummary, activateExitEntrySampling } from './paper-exit-comparison.js';
import { nextScanDelay } from './paper-runtime-cadence.js';
import { createTradeReview, advanceTradeReview, validateTradeReview, tradeReviewSummary } from './paper-trade-review.js';
import { MEME_EXIT_POLICY, MEME_EXIT_TEXT, memeEntryContext, memeExitEvaluation } from './paper-meme-exit.js';
import { buildPaperNewsWire } from './paper-news-wire.js';
import { historicalTwitterAnchors } from './paper-twitter-event.js';
import { PAPER_RECOVERY_VERSION, EVIDENCE_GAP_POLICY, RECOVERY_ENTRY_TEXT } from './paper-recovery-policy.js';
import { PAPER_RECOVERY_SIZING_VERSION } from './paper-position-sizing.js';
import { createNarrativeResearchIndex, narrativeDeskReport } from './paper-narrative-thesis.js';

const clone = value => structuredClone(value);
const fastQuoteAvailable = market => typeof market?.quote === 'function';
const keyOf = token => `${token.chain}:${gmgnFlowAddress(token.chain, token.address)}`;
const stamp = value => typeof value === 'number' ? (value < 1e10 ? value * 1000 : value) : Date.parse(value || '');
const fresh = (value, nowMs) => Number.isFinite(stamp(value)) && stamp(value) <= nowMs && stamp(value) >= nowMs - 120_000;

async function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function createPaperStrategyRuntime({ market, dataDir, session = null, chain = 'robinhood', chains = [chain], now = Date.now, intervalMs = 1000, marketIntervalMs = 1000, twitterNarrativeSnapshot = () => null,
  evidenceLoader = createPaperEvidenceLoader(dataDir), evaluate = evaluatePaperStrategies, learningLoader = () => null, narrativeSourceReader = readNarrativeLearningSource, allowExploratory = false, compoundEntries = false, fixedEntryUsd = null, upsideMode = false, pvpMode = false, diagnosticMode = false, confirmedMode = false, evidenceHoldMode = false, continuousPaperMode = false, opportunityMode = false, thesisExitExperiment = false, activeEntrySampling = false, tradeReviewEvery = null, higherFrequencyResearch = false, memeExitMode = false, recoveryMode = false } = {}) {
  if(typeof recoveryMode!=='boolean'||recoveryMode&&!memeExitMode)throw new TypeError('recovery requires meme paper main');
  if(typeof memeExitMode!=='boolean'||memeExitMode&&(!confirmedMode||!continuousPaperMode||!opportunityMode))throw new TypeError('meme exit requires confirmed continuous multi-setup main');
  if (tradeReviewEvery !== null && tradeReviewEvery !== 100) throw new TypeError('paper review batch must contain 100 fills');
  if (typeof higherFrequencyResearch !== 'boolean' || higherFrequencyResearch && (!confirmedMode || !opportunityMode)) throw new TypeError('higher research cadence requires confirmed multi-setup paper mode');
  if (typeof allowExploratory !== 'boolean') throw new TypeError('invalid paper entry mode');
  if (typeof compoundEntries !== 'boolean') throw new TypeError('invalid paper sizing mode');
  if (typeof upsideMode !== 'boolean') throw new TypeError('invalid upside mode');
  if (typeof pvpMode !== 'boolean' || pvpMode && upsideMode) throw new TypeError('invalid pvp mode');
  if (typeof diagnosticMode !== 'boolean' || diagnosticMode && (!allowExploratory || !pvpMode || !fastQuoteAvailable(market))) throw new TypeError('diagnostic entries require exploratory PVP and independent quotes');
  if (typeof confirmedMode !== 'boolean' || confirmedMode && (!allowExploratory || !pvpMode || diagnosticMode || !fastQuoteAvailable(market))) throw new TypeError('invalid confirmed paper configuration');
  if (fixedEntryUsd !== null && (fixedEntryUsd !== PAPER_FIXED_ENTRY_USD || !confirmedMode)) throw new TypeError('invalid fixed paper ticket');
  if (typeof evidenceHoldMode !== 'boolean' || evidenceHoldMode && !confirmedMode) throw new TypeError('evidence hold requires confirmed paper mode');
  if (typeof continuousPaperMode !== 'boolean' || continuousPaperMode && !confirmedMode) throw new TypeError('continuous mode requires confirmed paper mode');
  if (typeof opportunityMode !== 'boolean' || opportunityMode && (!confirmedMode || !evidenceHoldMode)) throw new TypeError('multi setup requires confirmed evidence-hold paper mode');
  if (typeof thesisExitExperiment !== 'boolean' || thesisExitExperiment && (!opportunityMode || !continuousPaperMode)) throw new TypeError('exit comparison requires continuous multi-setup paper mode');
  if (typeof activeEntrySampling !== 'boolean' || activeEntrySampling && (!thesisExitExperiment || fixedEntryUsd!==10)) throw new TypeError('active entries require isolated exit comparison and fixed 10 U');
  const exitProfile = evidenceHoldMode ? EVIDENCE_HOLD_EXIT_POLICY : confirmedMode ? CONFIRMED_PVP_EXIT_POLICY : pvpMode ? PVP_EXIT_POLICY : upsideMode ? UPSIDE_EXIT_POLICY : null;
  if (!market || !dataDir || !GMGN_FLOW_CHAINS[chain] || !Number.isFinite(intervalMs) || intervalMs < 1000) throw new TypeError('invalid paper runtime configuration');
  if (!Number.isFinite(marketIntervalMs) || marketIntervalMs < 1000) throw new TypeError('invalid market interval');
  if (!Array.isArray(chains) || !chains.length || !chains.includes(chain) || chains.some(value => !Object.hasOwn(GMGN_FLOW_CHAINS, value))
    || new Set(chains).size !== chains.length) throw new TypeError('invalid paper chains');
  chains = [...chains];
  if (session) {
    validatePaperSession(session); session = clone(session);
    if (!confirmedMode || session.chain !== chain || JSON.stringify(session.chains) !== JSON.stringify(chains)) throw new Error('独立实验只能使用已选择的 V2 策略与链配置');
  }
  const stateFile = path.join(dataDir, session ? paperSessionLedgerFile(session) : 'yesp-atm-strategy-paper.json'), lockFile = `${stateFile}.lock`;
  const owner = randomUUID();
  let account = null, enabled = true, initialized = false, stopped = false, started = false, lockHeld = false, timer, tail = Promise.resolve(), cycle = null;
  const charts = new Map();
  const chartJobs = new Map(), quotes = new Map(), quoteAttempts = new Map();
  const quoteHistories = new Map();
  const unavailable = { status: 'unavailable', tokens: [], observedAt: null };
  const marketSnapshots = new Map(chains.map(value => [value, [unavailable, unavailable]]));
  let marketOffset = 0, refreshJob = null, refreshTimer, quoteTimer, fastCycle = null;
  const quoteJobs = new Map();
  let auxiliaryJob = null, auxiliaryOffset = 0, lastFastStartedAt = null, lastExitStartedAt = null;
  const auxiliaryAttempts = new Map();
  let quoteEvaluationJob = null, quoteEvaluationRequest = null, quoteTriggeredEvaluations = 0;
  const evaluatedQuoteTimes = new Map();
  let exitJob = null, exitTimer, latestEvidence = {}, exitChecks = 0;
  const details = new Map();
  let detailJob = null, detailTargets = [], detailChainOffset = 0, lastDetailStart = null;
  let detailDispatchCount = 0, detailsSucceeded = 0, lastDetail = null, lastMarketRefreshStartedAt = null;
  let quoteTargets = [], lastQuoteTiming = null, lastTickAt = null, tickCount = 0, lastMarketRefreshAt = null;
  let lastComparisonQuoteAt = -Infinity;
  const quoteDispatches={exit:0,candidate:0,comparisonCandidate:0};
  let lastQuoteDispatch=null, lastCandidateQuote=null, lastComparisonCandidateQuote=null, lastCandidateEvaluation=null;
  const fastQuotes = typeof market.quote === 'function';
  let candidateOffset = 0;
  let lastOpportunityChartAt = -Infinity, chartDispatch = 0, hotResearchKeys = [], lastChartDispatch = null, quoteLease = null;
  const chartDispatches={holding:0,entry:0,hot:0,discovery:0,proactive:0};
  let entryFocus = null;
  const researchDeferrals = { auxiliary: 0, details: 0, learning: 0, discovery: 0 };
  const entryWindowMs = memeExitMode ? 45000 : 20000;
  let lastHotChartChain=null;
  const hotChartDispatchesByChain=Object.fromEntries(chains.map(chain=>[chain,0]));
  const marketRefreshCounts=new Map();
  let reviewComparison = null;
  let tradeCountReview = null, tradeCountReviewError = null;
  let exitComparison = null;
  let learningShadow = null;
  let narrativeMemory = null, narrativeRecallState = null;
  let narrativeLearningMemory = null, narrativeLearningState = null, narrativeLearningTargets = [];
  let narrativeSourceTargets = [];
  let narrativeLearningJob = null, lastNarrativeLearningRequest = null;
  const narrativeLearningMarks = new Map();
  const narrativeSourceObservations = new Map();
  let publicState = { status: 'loading', strategyVersion: STRATEGY_ANALYSIS_VERSION, entryPolicyVersion: PAPER_ENTRY_POLICY_VERSION, entryMode: confirmedMode ? CONFIRMED_PAPER_VERSION : diagnosticMode ? PAPER_DIAGNOSTIC_ENTRY_VERSION : allowExploratory ? 'standard_and_exploratory' : 'standard', exitPolicy: exitProfile ? clone(exitProfile) : null, mode: 'paper', execution: false, signing: false, broadcast: false, enabled, chain, chains, learningChain: chain, updatedAt: null,
    session: session && clone(session), operatingPolicy: paperOperatingPolicy(continuousPaperMode), opportunityMode:opportunityMode ? OPPORTUNITY_VERSION : null, auxiliaryAuditPolicy: !confirmedMode && allowExploratory && pvpMode ? PAPER_AUX_AUDIT_VERSION : 'strict_fields_v1',
    lastError: null, account: null, strategies: STRATEGY_POLICIES.map(p => ({ ...p, decision: '观察', eligibleCount: 0, observedCount: 0, reasons: ['等待首轮真实数据'], candidate: null })), coverage: {}, evaluations: [], pollIntervalMs: intervalMs,
    costModel: '费用、滑点及 gas 按模型估算；非实际成交报价', accountNote: session ? 'V2 独立虚拟实验；历史亏损账本单独保留，不合并成绩或自动补款' : '独立的服务端 100 美元模拟账户；旧浏览器账户只读保留',
    executionModel: `本地每 ${intervalMs / 1000} 秒检查；五分钟为滚动证据窗口，不是每笔等待；上游延迟另计，非毫秒抢跑` };
  const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  const errorState = error => { publicState = { ...publicState, status: 'error', lastError: String(error?.message || error).slice(0, 160), account: account && clone(account) }; };

  async function acquireLock() {
    await fs.mkdir(dataDir, { recursive: true });
    try { await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const reclaimFile = `${lockFile}.reclaim`;
      // An exclusive second lock serializes stale-lock recovery itself. A crash
      // while reclaiming fails closed rather than allowing two ledger writers.
      let recovery;
      try { recovery = await fs.open(reclaimFile, 'wx', 0o600); }
      catch { throw new Error('模拟账本锁正在恢复或需要检查'); }
      try {
        let prior;
        try { prior = JSON.parse(await fs.readFile(lockFile, 'utf8')); } catch { throw new Error('模拟账本锁无法验证，请检查文件，未重置账户'); }
        if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0) throw new Error('模拟账本锁内容异常，未重置账户');
        try { process.kill(prior.pid, 0); throw new Error('模拟账本已有进程运行'); }
        catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
        const check = JSON.parse(await fs.readFile(lockFile, 'utf8'));
        if (check.owner !== prior.owner || check.pid !== prior.pid) throw new Error('模拟账本锁已变化');
        await fs.unlink(lockFile);
        await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 });
      } finally { await recovery.close(); await fs.unlink(reclaimFile); }
    }
    lockHeld = true;
  }

  async function initialize() {
    if (initialized) return;
    await acquireLock();
    try {
      let stored, absent = false;
      try {
        const info = await fs.stat(stateFile);
        if (info.size > 32 * 1024 * 1024) throw new Error('模拟账本过大，请归档；未重置账户');
        stored = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; absent = true; }
      if (!absent) {
        if (!stored || stored.schema !== 'yesp_atm_runtime_v1' || stored.chain !== chain || typeof stored.enabled !== 'boolean') throw new Error('模拟账本配置不匹配，未重置账户');
        if (session ? JSON.stringify(stored.session) !== JSON.stringify(session) : stored.session != null) throw new Error('实验账本身份不匹配，未重置账户');
        if (session && stored.account?.initialCash !== session.initialCash) throw new Error('独立实验初始本金不匹配，未补款');
        // The pure ledger validates the full stored account before advancing.
        account = advancePaperStrategyAccount(stored.account, { enabled: false, nowMs: now() }); enabled = stored.enabled;
        if (stored.tradeCountReview != null) {
          tradeCountReview = stored.tradeCountReview;
          try { validateTradeReview(tradeCountReview, account); }
          catch { tradeCountReviewError = '百笔复盘检查点异常，保留原记录；模拟交易和持仓退出继续'; }
        }
        if (stored.chains != null && (!Array.isArray(stored.chains) || !stored.chains.includes(chain) || new Set(stored.chains).size !== stored.chains.length
          || stored.chains.some(value => !Object.hasOwn(GMGN_FLOW_CHAINS, value)))) throw new Error('模拟账本链配置异常，未重置账户');
        if (Object.values(account.positions).some(position => !chains.includes(position.chain))) throw new Error('不能停用仍有持仓的链，未重置账户');
        if (stored.learningShadow != null) { validateLearningShadow(stored.learningShadow); learningShadow = stored.learningShadow; }
        if (stored.reviewComparison != null) { validateReviewComparison(stored.reviewComparison); reviewComparison=stored.reviewComparison; }
        if (stored.exitComparison != null) { validateExitComparison(stored.exitComparison); exitComparison = stored.exitComparison; }
        if (stored.narrativeMemory != null) {
          if (validNarrativeMemory(stored.narrativeMemory)) narrativeMemory = stored.narrativeMemory;
          else { narrativeMemory = stored.narrativeMemory; narrativeRecallState = { error: '叙事记忆异常，此模块停止匹配，持仓退出仍运行' }; }
        }
        if (stored.narrativeLearningMemory != null) {
          narrativeLearningMemory = stored.narrativeLearningMemory;
          if (!validNarrativeLearning(narrativeLearningMemory)) narrativeLearningState = { error: '起量学习记忆异常，暂停学习；交易账本和退出管理不重置' };
        }
      } else {
        if (session) throw new Error('独立实验账本缺失，禁止自动补款或重建');
        account = createPaperStrategyAccount({ initialCash: 100, nowMs: now() });
        await atomicWrite(stateFile, { schema: 'yesp_atm_runtime_v1', chain, chains, enabled, account });
      }
      if(opportunityMode && !reviewComparison) reviewComparison=createReviewComparison(account,now());
      if (thesisExitExperiment && !exitComparison) exitComparison = createExitComparison(account, now());
      if (activeEntrySampling) exitComparison = activateExitEntrySampling(exitComparison, now());
      if (tradeReviewEvery && tradeCountReview == null) tradeCountReview = createTradeReview(account,now());
      initialized = true; publicState = { ...publicState, enabled, account: clone(account), updatedAt: account.updatedAt,
        tradeCountReview: tradeReviewSummary(tradeCountReview,tradeCountReviewError) };
    } catch (error) { errorState(error); await releaseLock(); throw error; }
  }

  async function releaseLock() {
    if (!lockHeld) return;
    const prior = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    if (prior.owner === owner && prior.pid === process.pid) await fs.unlink(lockFile);
    lockHeld = false;
  }

  async function getChart(token, nowMs) {
    const key = keyOf(token), cached = charts.get(key);
    const active=['hot','holding','entry'].includes(token.researchLane);
    if (!chartRefreshDue(cached,nowMs,{active})) return cached;
    if (chartJobs.has(key)) return chartJobs.get(key);
    const job = loadChart(token, nowMs).finally(() => chartJobs.delete(key));
    chartJobs.set(key, job); return job;
  }

  async function loadChart(token, nowMs) {
    const key = keyOf(token);
    const to = Math.floor(nowMs / 60_000) * 60;
    let result;
    try { result = await market.kline({ chain: token.chain, address: token.address, resolution: '1m', from: to - 3600, to, latestClosed:true,
      purpose: token.researchLane === 'entry' ? 'entry_confirmation' : token.purpose || 'candidate' }); }
    catch { result = { status: 'unavailable', candles: [] }; }
    if (opportunityMode && (result.chain !== token.chain || gmgnFlowAddress(token.chain,result.address) !== gmgnFlowAddress(token.chain,token.address)
      || result.resolution !== '1m')) result = { status:'unavailable',candles:[],reason:'kline_binding_mismatch' };
    // An unfinished provider bar must not become final merely by aging in cache.
    // Bind eligibility to the requested close boundary, not response/cache time.
    let closedThroughAtMs = to * 1000;
    if(result.requestWindow==='latest_closed_at_dispatch') {
      const requestedAt=stamp(result.requestedAt),end=result.to*1000;
      if(result.source!=='gmgn-cli' || !Number.isFinite(requestedAt) || requestedAt>now()
        || !Number.isSafeInteger(result.to) || !Number.isSafeInteger(result.from) || result.to-result.from!==3600
        || end!==Math.floor(requestedAt/60000)*60000)result={status:'unavailable',candles:[],reason:'kline_request_window_mismatch'};
      else closedThroughAtMs=end;
    }
    const candles = Array.isArray(result.candles) ? result.candles.filter(bar => {
      const openAtMs = stamp(bar?.time ?? bar?.timestamp);
      return !Number.isFinite(openAtMs) || openAtMs + 60_000 <= closedThroughAtMs;
    }) : result.candles;
    const item = { ...result, candles, fetchedAt: now(), closedThroughAtMs,
      // Legacy exit marks may use the observed intrabar price, never as a
      // completed OHLCV signal. Preserve that path when fast quotes are absent.
      markCandles: fastQuotes ? undefined : result.candles,
      excludedUnclosedBars: Array.isArray(result.candles) ? result.candles.length - candles.length : 0 };
    charts.set(key, item);
    if (charts.size > 100) charts.delete(charts.keys().next().value);
    return item;
  }

  function publishMarket(currentChain, index, result) {
    if (stopped) return;
    const snapshots = [...marketSnapshots.get(currentChain)];
    const prior = snapshots[index];
    // A failed refresh can retain old data only as explicitly stale, with its
    // original timestamp. It must not look like a newly observed price.
    snapshots[index] = result?.status === 'ok' || result?.status === 'stale' ? result
      : prior?.tokens?.length ? { ...prior, status: 'stale' } : unavailable;
    marketSnapshots.set(currentChain, snapshots);
    lastMarketRefreshAt = now();
  }

  function focusedEntry() {
    if (!enabled || !entryFocus?.active || now() >= entryFocus.until || now() < entryFocus.since) return null;
    return quoteTargets.find(t => keyOf(t) === entryFocus.key) || null;
  }

  function researchLimits() {
    const parallel = higherFrequencyResearch && gmgnReadonlyPolicy(dataDir).normalConcurrency >= 2
      && !focusedEntry() && ![...quoteJobs.values()].some(job=>job.purpose==='candidate');
    return { concurrency: parallel ? 2 : 1, dispatchIntervalMs: parallel ? 2500 : 5000 };
  }

  function nextTradeReview(next, nowMs) {
    if (!tradeReviewEvery || tradeCountReviewError) return tradeCountReview;
    try { return advanceTradeReview(tradeCountReview,next,nowMs); }
    catch { tradeCountReviewError = '百笔复盘与账本不一致，保留原记录；模拟交易和持仓退出继续'; return tradeCountReview; }
  }

  function refreshAuxiliaryMarket() {
    if (stopped || auxiliaryJob || marketRefreshCounts.size < chains.length) return auxiliaryJob || Promise.resolve();
    if (focusedEntry()) { researchDeferrals.auxiliary++; return Promise.resolve(); }
    // One slow discovery request may run beside the minute lane, never an
    // unbounded queue. Use elapsed time, not accelerated tick counts.
    const feeds = chains.flatMap(currentChain => [
      { chain: currentChain, index: 1, interval: 60_000 },
      ...(opportunityMode ? [{ chain: currentChain, index: 2, interval: 300_000 }] : []),
    ]);
    let selected;
    for (let i = 0; i < feeds.length; i++) {
      const feed = feeds[auxiliaryOffset++ % feeds.length];
      if (now() - (auxiliaryAttempts.get(`${feed.chain}:${feed.index}`) ?? -Infinity) >= feed.interval) { selected = feed; break; }
    }
    if (!selected) return Promise.resolve();
    const { chain: currentChain, index } = selected;
    auxiliaryAttempts.set(`${currentChain}:${index}`, now());
    auxiliaryJob = Promise.resolve().then(() => index === 2
      ? market.trending({ chain: currentChain, interval: '1h', limit: 50 })
      : typeof market.trenches === 'function' ? market.trenches({ chain: currentChain, limit: 20 }) : unavailable)
      .catch(() => unavailable).then(result => publishMarket(currentChain, index, result))
      .finally(() => { auxiliaryJob = null; });
    return auxiliaryJob;
  }

  function refreshMarket({ background = false } = {}) {
    if (stopped) return Promise.resolve();
    if (refreshJob) return refreshJob;
    if (background && memeExitMode && focusedEntry()) { researchDeferrals.discovery++; return Promise.resolve(); }
    const currentChain = chains[marketOffset++ % chains.length];
    lastMarketRefreshStartedAt = now();
    const count=marketRefreshCounts.get(currentChain)||0;
    marketRefreshCounts.set(currentChain,count+1);
    const jobs=[{index:0,run:()=>market.trending({chain:currentChain,interval:'1m',limit:opportunityMode?50:20,purpose:'scan'})}];
    // Cold start first covers every chain's minute feed; historical/launch
    // batches must not sit in front of three still-unseen chains.
    if(!background && (!opportunityMode || count%2===1)) jobs.push({index:1,run:()=>typeof market.trenches==='function'?market.trenches({chain:currentChain,limit:20}):unavailable});
    if(!background && opportunityMode && count%6===5) jobs.push({index:2,run:()=>market.trending({chain:currentChain,interval:'1h',limit:50})});
    // Publish each response immediately. Live minute scans do not wait for the
    // separate auxiliary lane; manual runOnce keeps its complete-batch contract.
    refreshJob = Promise.allSettled(jobs.map(j => Promise.resolve().then(j.run).catch(() => unavailable)
      .then(result => publishMarket(currentChain, j.index, result))))
      .finally(() => { refreshJob = null; if (background && !stopped) void refreshAuxiliaryMarket(); });
    return refreshJob;
  }

  function refreshDetails() {
    if (stopped || typeof market.details !== 'function') return Promise.resolve();
    if (detailJob) return detailJob;
    const freshAlpha=t=>Number.isFinite(t.alphaListingTime)&&t.alphaListingTime<=now()&&now()-t.alphaListingTime<=300000;
    const freshMonitor=t=>fresh(t.monitorSourceAt,now());
    const unseenNews=detailTargets.some(t=>(fresh(t.newsSourceAt,now())||freshAlpha(t)||freshMonitor(t))&&!details.has(keyOf(t)));
    if (lastDetailStart !== null && now() - lastDetailStart < (unseenNews?1000:10_000)) return Promise.resolve();
    // Never add research work while a live paper holding lacks its exit quote.
    if (fastQuotes && (recoveryMode?Object.values(account?.positions||{}):heldTokens()).some(token => !recentQuote(token, now()))) return Promise.resolve();
    // Two priority dispatches then one fair chain rotation. Near-entry refresh
    // must not wait behind every unknown token; discovery must not starve either.
    const focus = focusedEntry();
    const due = detailTargets.filter(token => (!focus || keyOf(token) === keyOf(focus) || freshAlpha(token) || freshMonitor(token))
      && (!details.has(keyOf(token)) || now() - details.get(keyOf(token)).fetchedAt >= token.refreshAfterMs));
    if (focus && !due.length) researchDeferrals.details++;
    const priority = Math.max(0, ...due.map(token => token.researchPriority));
    const pool = detailDispatchCount % 3 === 2 ? due : due.filter(token => token.researchPriority === priority);
    let selected;
    for (let i = 0; i < chains.length && !selected; i++) {
      const currentChain = chains[detailChainOffset++ % chains.length];
      selected = pool.filter(token => token.chain === currentChain)
        .sort((a, b) => (details.get(keyOf(a))?.fetchedAt ?? 0) - (details.get(keyOf(b))?.fetchedAt ?? 0))[0];
    }
    if (!selected) return Promise.resolve();
    const key = keyOf(selected); lastDetailStart = now(); detailDispatchCount += 1;
    lastDetail = { chain: selected.chain, address: selected.address, symbol: selected.symbol, reason: selected.researchReason,
      startedAt: new Date(lastDetailStart).toISOString(), status: 'pending', priority: selected.researchPriority };
    detailJob = Promise.resolve().then(() => market.details(selected)).catch(() => ({ status: 'unavailable' })).then(result => {
      if (stopped) return;
      const bound = result?.token?.chain === selected.chain && gmgnFlowAddress(selected.chain, result?.token?.address) === gmgnFlowAddress(selected.chain, selected.address);
      details.set(key, { ...(bound ? result : { status: 'unavailable' }), fetchedAt: now() });
      const success = bound && result.status === 'ok' && fresh(result.observedAt, now());
      if (success) detailsSucceeded += 1;
      lastDetail = { ...lastDetail, status: success ? 'ok' : 'unavailable', finishedAt: new Date(now()).toISOString(),
        observedAt: bound ? result.observedAt || null : null, reasonCode: result?.reasonCode || null };
      if (details.size > 200) details.delete(details.keys().next().value);
    }).finally(() => { detailJob = null; });
    return detailJob;
  }

  function quoteLaneLimits() {
    const total = Math.min(3, gmgnReadonlyPolicy(dataDir).concurrency);
    const reserveCandidate=!recoveryMode||enabled&&quoteTargets.some(t=>t.purpose==='candidate'&&t.candidateBook==='main');
    return { total, exit: total > 1 && reserveCandidate ? total - 1 : total, candidate: 1 };
  }

  const comparisonQuote=t=>recoveryMode&&(t.candidateBook==='comparison'||t.holdingTier==='comparison'&&t.candidateBook!=='main');
  const quoteJobPurpose=t=>t.purpose==='exit'||comparisonQuote(t)?'exit':'candidate';
  function admitCandidate(targets,token) {
    const held=targets.get(keyOf(token));
    // A control lot in the same CA may share the new quote, but must not
    // downgrade a main entry into a once-per-minute comparison mark.
    if(!held||recoveryMode&&token.candidateBook==='main'&&held.holdingTier==='comparison')
      targets.set(keyOf(token),token);
  }

  function refreshQuote() {
    const targets = new Map(heldTokens().map(token => [keyOf(token), { ...token, purpose: 'exit' }]));
    for (const token of quoteTargets) if (token.purpose !== 'exit' && (!recoveryMode||enabled)) admitCandidate(targets,token);
    quoteTargets = [...targets.values()];
    if (stopped || !fastQuotes || !quoteTargets.length) return Promise.resolve();
    // The shared account gate still owns entitlement, pacing and cooldowns.
    // Plus admits two independent held assets and reserves one candidate slot.
    // One slow holding cannot serialize all exits; exits cannot take over the
    // candidate slot. This is admission to the existing shared gate, not a new
    // request allowance. Free and hot downgrades remain serial after draining.
    const limits = quoteLaneLimits();
    while (quoteJobs.size < limits.total) {
      const occupied = { exit: 0, candidate: 0 };
      for (const job of quoteJobs.values()) occupied[job.purpose]++;
      const available = quoteTargets.filter(t => {
        const purpose = quoteJobPurpose(t),comparison=comparisonQuote(t);
        const last = quoteHistories.get(keyOf(t))?.at(-1);
        if(recoveryMode&&purpose==='exit') {
          const attempt=quoteAttempts.get(keyOf(t));
          if(attempt!==undefined&&now()-attempt<(comparison&&t.purpose==='exit'?60000:3000))return false;
          if(comparison&&(now()-lastComparisonQuoteAt<(t.purpose==='exit'?15000:3000)
            ||[...quoteJobs.values()].some(j=>comparisonQuote(j.token))))return false;
        }
        if (purpose === 'candidate' && last && now()-stamp(last.observedAt)<3000) return false;
        return !quoteJobs.has(keyOf(t)) && occupied[purpose] < limits[purpose];
      });
      if (!available.length) break;
      dispatchQuote(selectQuoteTarget(available,quotes,quoteAttempts,now()));
    }
    return Promise.allSettled([...quoteJobs.values()].map(x=>x.job));
  }

  function dispatchQuote(token) {
    const key = keyOf(token), purpose = quoteJobPurpose(token),comparison=comparisonQuote(token);
    quoteDispatches[token.purpose==='candidate'&&comparison?'comparisonCandidate':purpose]++;
    lastQuoteDispatch={chain:token.chain,address:token.address,purpose:token.purpose,candidateBook:token.candidateBook||null,at:new Date(now()).toISOString()};
    const requestedAt = lastQuoteDispatch.at;
    quoteAttempts.set(key, now());
    if(comparison)lastComparisonQuoteAt=now();
    if (quoteAttempts.size > 100) quoteAttempts.delete(quoteAttempts.keys().next().value);
    const priorQuote = quoteHistories.get(key)?.at(-1);
    const job = Promise.resolve().then(() => market.quote({ ...token,
      ...(purpose==='candidate' && recoveryMode ? {purpose:'entry_confirmation'} : {}),
      ...(comparison?{purpose:'comparison'}:{}),
      ...(token.purpose==='candidate' && priorQuote ? {afterObservedAt:priorQuote.observedAt} : {}) })).catch(() => ({ status: 'unavailable' })).then(quote => {
      if (!stopped) {
        const bound = quote?.chain === token.chain && gmgnFlowAddress(token.chain, quote?.address) === gmgnFlowAddress(token.chain, token.address);
        quotes.set(key, bound ? quote : { status: 'unavailable' });
        if (confirmedMode && bound && quote.status === 'ok' && Number.isFinite(quote.price) && quote.price > 0
          && stamp(quote.observedAt) <= now() && now() - stamp(quote.observedAt) <= 5000) {
          const history = (quoteHistories.get(key) || []).filter(q => now() - stamp(q.observedAt) <= CONFIRMED_PAPER_POLICY.quoteWindowMs);
          if (!history.some(q => q.observedAt === quote.observedAt && q.price === quote.price)) history.push({ chain: quote.chain,
            address: gmgnFlowAddress(quote.chain, quote.address), status: quote.status, price: quote.price, observedAt: quote.observedAt });
          quoteHistories.set(key, history.slice(-20));
          if (quoteHistories.size > 100) quoteHistories.delete(quoteHistories.keys().next().value);
        }
        if (token.purpose === 'candidate') {
          const report = { chain:token.chain,address:token.address,candidateBook:token.candidateBook||null,requestedAt,
          receivedAt:new Date(now()).toISOString(),status:bound?quote.status:'unavailable',bound,
          observedAt:bound?quote.observedAt||null:null,
          ageAtReceiveMs:bound&&Number.isFinite(stamp(quote.observedAt))?now()-stamp(quote.observedAt):null,
          totalMs: Math.max(0, now() - stamp(requestedAt)),
          queueMs: bound && Number.isFinite(stamp(quote.queuedAt)) && Number.isFinite(stamp(quote.observedAt))
            ? Math.max(0, stamp(quote.observedAt) - stamp(quote.queuedAt)) : null,
          requestMs: bound && Number.isFinite(stamp(quote.receivedAt)) && Number.isFinite(stamp(quote.observedAt))
            ? Math.max(0, stamp(quote.receivedAt) - stamp(quote.observedAt)) : null,
          confirmationHistoryCount:quoteHistories.get(key)?.length||0 };
          if(comparison)lastComparisonCandidateQuote=report;else lastCandidateQuote=report;
        }
        if (bound && quote.status === 'ok' && Number.isFinite(stamp(quote.queuedAt)) && Number.isFinite(stamp(quote.receivedAt))) {
          lastQuoteTiming = { chain: token.chain, purpose: token.purpose || 'candidate', observedAt: quote.observedAt,
            queueMs: Math.max(0, stamp(quote.observedAt) - stamp(quote.queuedAt)), requestMs: Math.max(0, stamp(quote.receivedAt) - stamp(quote.observedAt)) };
        }
        if (quotes.size > 100) quotes.delete(quotes.keys().next().value);
        if (started) {
          void exitOnce().catch(() => {});
          if (bound && !comparison && (token.purpose !== 'exit' || entryFocus?.key===key)) requestQuoteEvaluation(token);
        }
      }
    }).finally(() => { quoteJobs.delete(key); });
    quoteJobs.set(key,{purpose,token,job});
  }

  // At most one additional, low-priority read per minute, only when a follow-up
  // horizon is due. It never enters the trading quote cache or entry pipeline.
  function refreshNarrativeLearning() {
    if (stopped || !confirmedMode || !fastQuotes || narrativeLearningState?.error) return Promise.resolve();
    if (narrativeLearningJob) return narrativeLearningJob;
    if (lastNarrativeLearningRequest !== null && now() - lastNarrativeLearningRequest < 60000) return Promise.resolve();
    if (focusedEntry()) { researchDeferrals.learning++; return Promise.resolve(); }
    if ((recoveryMode?Object.values(account?.positions||{}):heldTokens()).some(token => !recentQuote(token, now()))) return Promise.resolve();
    const target = narrativeLearningTargets.find(t => t.dueAt <= now() && now() <= t.deadline);
    const sourceUrl = narrativeSourceTargets[0];
    if (!target && !sourceUrl) return Promise.resolve();
    lastNarrativeLearningRequest = now();
    if (!target) {
      narrativeLearningJob = Promise.resolve().then(() => narrativeSourceReader(sourceUrl))
        .then(result => {
          if (!stopped) {
            narrativeSourceObservations.set(sourceUrl, result);
            if (narrativeSourceObservations.size > 100) narrativeSourceObservations.delete(narrativeSourceObservations.keys().next().value);
          }
        }).catch(() => {
          if (!stopped) narrativeSourceObservations.set(sourceUrl, { url: sourceUrl, status: 'unavailable', observedAt: now() });
        }).finally(() => { narrativeLearningJob = null; });
      return narrativeLearningJob;
    }
    narrativeLearningJob = Promise.resolve().then(() => market.quote({ ...target, purpose: 'learning' }))
      .then(mark => {
        if (!stopped && mark?.chain === target.chain && gmgnFlowAddress(target.chain, mark.address) === target.address) {
          narrativeLearningMarks.set(keyOf(target), mark);
          if (narrativeLearningMarks.size > 60) narrativeLearningMarks.delete(narrativeLearningMarks.keys().next().value);
        }
      }).catch(() => {}).finally(() => { narrativeLearningJob = null; });
    return narrativeLearningJob;
  }

  function requestQuoteEvaluation(token) {
    const key = keyOf(token), quote = quotes.get(key);
    const usable = () => {
      const at = stamp(quotes.get(key)?.observedAt);
      return enabled && recentQuote(token, now()) && now() - at <= (pvpMode ? PVP_EXIT_POLICY.entryQuoteMaxAgeMs : 15_000);
    };
    if (stopped || !usable() || evaluatedQuoteTimes.get(key) === quote.observedAt) return;
    evaluatedQuoteTimes.set(key, quote.observedAt);
    if (evaluatedQuoteTimes.size > 100) evaluatedQuoteTimes.delete(evaluatedQuoteTimes.keys().next().value);
    quoteEvaluationRequest = { usable,chain:token.chain,address:token.address,quoteObservedAt:quote.observedAt,receivedAt:now() };
    if (quoteEvaluationJob) return;
    // A quote may arrive after an in-flight cycle has already evaluated inputs.
    // Drain that cycle, then re-read evidence and evaluate under the same writer
    // queue. Never delay the independent exit path or manufacture a fresh stamp.
    quoteEvaluationJob = Promise.resolve().then(async () => {
      while (!stopped && quoteEvaluationRequest) {
        if(recoveryMode) {
          const request=quoteEvaluationRequest;quoteEvaluationRequest=null;
          // Fresh source reads stay outside the ledger lock and do not wait on
          // a universe-wide research cycle. The commit still has ONE writer.
          const research=await loadResearch();
          await serial(async()=>{
            if(stopped)return;
            if(!request.usable() || quotes.get(keyOf(request))?.observedAt!==request.quoteObservedAt) {
              lastCandidateEvaluation={chain:request.chain,address:request.address,at:new Date(now()).toISOString(),
                quoteObservedAt:request.quoteObservedAt,evaluatedPriceObservedAt:null,mode:'targeted_main_quote_v1',decision:'观察',reasons:[],
                missing:[enabled?'报价在证据读取或写入排队期间过期、或已被更新':'新开仓已暂停'],
                quoteAgeAtDecisionMs:now()-stamp(request.quoteObservedAt),receivedToDecisionMs:now()-request.receivedAt,newFills:0};
              publicState={...publicState,cadence:{...publicState.cadence,lastCandidateEvaluation}};
              return;
            }
            quoteTriggeredEvaluations++;
            await performCycle({background:true,research,quoteRequest:request});
          }).catch(errorState);
          continue;
        }
        if (fastCycle) await fastCycle.catch(() => {});
        const request = quoteEvaluationRequest;
        quoteEvaluationRequest = null;
        if (stopped || !request.usable()) continue;
        quoteTriggeredEvaluations += 1;
        await fastOnce().catch(() => {});
        const row=publicState.evaluations?.find(r=>r.token.chain===request.chain && r.token.address===request.address);
        lastCandidateEvaluation={chain:request.chain,address:request.address,at:new Date(now()).toISOString(),
          quoteObservedAt:request.quoteObservedAt,evaluatedPriceObservedAt:row?.evidence?.priceObservedAt||null,
          decision:row?.decision||'未取得本轮评估',reasons:row?.reasons||[],missing:row?.missing||[]};
      }
    }).finally(() => { quoteEvaluationJob = null; });
  }

  function recentQuote(token, nowMs) {
    const quote = quotes.get(keyOf(token)), at = stamp(quote?.observedAt);
    return quote?.status === 'ok' && Number.isFinite(quote.price) && quote.price > 0 && Number.isFinite(at)
      && at <= nowMs && at >= nowMs - 15_000 ? quote : null;
  }

  function priced(item, nowMs) {
    if (!fastQuotes) return item;
    const quote = recentQuote(item.token, nowMs);
    return { ...item, token: { ...item.token, price: quote?.price ?? item.token.price },
      priceObservedAt: quote?.observedAt ?? null, requireFastQuote: true,
      quoteHistory: confirmedMode ? clone(quoteHistories.get(keyOf(item.token)) || []) : [] };
  }

  function heldTokens() {
    const holdings=new Map();
    for(const ledger of [account,reviewComparison?.control,exitComparison?.control,exitComparison?.dynamic,learningShadow?.control,learningShadow?.student].filter(Boolean)) {
      for(const p of Object.values(ledger.positions)) {
        const key=keyOf(p),prior=holdings.get(key);
        const requiresStructureChart=!!p.memeExitPolicy || p.pvpPolicy?.version==='structure_hold_v2' || p.exitExperiment?.version==='volume_structure_exit_v1';
        holdings.set(key,{...(prior||p),requiresStructureChart:!!prior?.requiresStructureChart || requiresStructureChart,
          ...(recoveryMode?{holdingTier:prior?.holdingTier==='main'||ledger===account?'main':'comparison'}:{})});
      }
    }
    return [...holdings.values()]; // Main-account exit needs cannot be overwritten by a legacy control lot.
  }

  function holdingChart(token,quote) {
    const chart=charts.get(keyOf(token));
    if(!opportunityMode || chart?.chain!==token.chain || gmgnFlowAddress(token.chain,chart.address)!==gmgnFlowAddress(token.chain,token.address)) return null;
    const policy=token.entryEvidence?.recoveryEntry?.chartWindowPolicy || token.entryEvidence?.opportunity?.chartWindowPolicy;
    return {...opportunityChart(chart.candles,chart.status,stamp(quote.observedAt),{contiguousTail:policy===MAIN_CHART_WINDOW_VERSION}),chain:token.chain,address:gmgnFlowAddress(token.chain,token.address)};
  }

  function holdingChips(position,nowMs) {
    if(!position?.memeExitPolicy)return null;
    for(const source of [...(marketSnapshots.get(position.chain)||[])].sort((a,b)=>stamp(b.observedAt)-stamp(a.observedAt))){
      if(source.status!=='ok'||!fresh(source.observedAt,nowMs))continue;
      const token=source.tokens?.find(t=>keyOf(t)===keyOf(position));
      if(token)return {chain:position.chain,address:position.address,observedAt:source.observedAt,
        top10HolderRate:token.top10HolderRate,devTeamHoldRate:token.devTeamHoldRate,bundlerRate:token.bundlerRate};
    }
    return null;
  }

  function exitOnce() {
    if (stopped) return Promise.resolve();
    if (exitJob) return exitJob;
    lastExitStartedAt = now();
    exitJob = serial(async () => {
      if (stopped) return;
      await initialize();
      const nowMs = now(), holdings = heldTokens();
      const marksFor = ledger => Object.values(ledger.positions).flatMap(position => {
        const quote = recentQuote(position, nowMs);
        return quote ? [{ ...quote, structureChart: holdingChart(position,quote),
          holderSnapshot:holdingChips(position,nowMs),
          narrative: ledger.exitExperimentVersion || position.memeExitPolicy ? buildPaperNarrativeEvidence({ chain: position.chain, address: position.address, token: position, events: latestEvidence.events, nowMs }) : null,
          flow: buildPaperDualFlowEvidence({ state: latestEvidence.flowState, binanceState: latestEvidence.binanceState,
          chain: position.chain, address: position.address, nowMs, preferredProvider: position.entryEvidence?.flowDiagnostics?.provider || 'gmgn' }) }] : [];
      });
      if (holdings.length && fastQuotes) {
        const next = advancePaperStrategyAccount(account, { marks: marksFor(account), enabled: false, nowMs, confirmedMode, continuousPaperMode,
          ...(recoveryMode?{recoveryMode,memeExitMode,opportunityMode}:{}) });
        next.stats.enabled = enabled;
        const pair = learningShadow ? { ...learningShadow,
          control: advancePaperStrategyAccount(learningShadow.control, { marks: marksFor(learningShadow.control), enabled: false, nowMs }),
          student: advancePaperStrategyAccount(learningShadow.student, { marks: marksFor(learningShadow.student), enabled: false, nowMs }) } : null;
        const comparison=reviewComparison ? {...reviewComparison,control:advancePaperStrategyAccount(reviewComparison.control,
          {marks:marksFor(reviewComparison.control),enabled:false,nowMs,confirmedMode:true,continuousPaperMode})} : null;
        const exits = advanceExitComparison(exitComparison, { marksFor, enabled: false, nowMs });
        const nextReview = nextTradeReview(next,nowMs);
        await atomicWrite(stateFile, { schema: 'yesp_atm_runtime_v1', session, chain, chains, enabled, account: next, learningShadow: pair, narrativeMemory, narrativeLearningMemory, reviewComparison:comparison, exitComparison: exits, tradeCountReview: nextReview });
        tradeCountReview = nextReview;
        exitComparison = exits;
        reviewComparison=comparison;
        account = next; learningShadow = pair;
        publicState = { ...publicState, account: clone(account), updatedAt: account.updatedAt, tradeCountReview: tradeReviewSummary(tradeCountReview,tradeCountReviewError),
          entryGuard: confirmedMode ? confirmedAccountGate(account, nowMs, null, null, null, { continuousPaperMode }) : null,
          learningComparison: { ...learningShadowSummary(learningShadow), chain },reviewComparison:reviewComparisonSummary(reviewComparison,account), exitComparison: exitComparisonSummary(exitComparison) };
      }
      publicState = { ...publicState, exitMonitor: { running: started && !stopped, intervalMs: 1000,
        lastCheckedAt: new Date(nowMs).toISOString(), checks: ++exitChecks, staleQuotes: heldTokens().filter(p => !recentQuote(p, nowMs)).length,
        entriesEnabled: enabled, lastError: null } };
    }).catch(error => {
      publicState = { ...publicState, exitMonitor: { ...publicState.exitMonitor, lastError: '退出检查或账本保存失败，需检查' } };
      throw error;
    }).finally(() => { exitJob = null; });
    return exitJob;
  }

  async function loadResearch() {
    const [loadedEvidence, learning] = await Promise.all([
      Promise.resolve().then(evidenceLoader).catch(() => ({})),
      Promise.resolve().then(learningLoader).catch(() => ({ lastError: 'learning_unavailable', policies: [] })),
    ]);
    return { loadedEvidence, learning };
  }

  async function performQuoteEntry(input, evidence, request) {
    if(stopped || !request.usable())return;
    const startedAt=now(),chart=charts.get(keyOf(request));
    // Same evaluator, admission rules and ledger as the periodic main book;
    // only the requested CA is evaluated. No control/shadow entries here.
    let rows=input ? evaluate({...priced(input,startedAt),nowMs:startedAt,
      candles:chart?.candles||[],klineStatus:chart?.status||'unavailable'}) : [];
    rows=rows.map(row=>{
      if(row.decision==='可模拟') {
        const gate=confirmedAccountGate(account,startedAt,row.token,row.evidence.confirmedPolicy?.pulse,row.evidence.narrativeRecall,
          {continuousPaperMode,opportunity:row.evidence.opportunity});
        if(!gate.allowed)row={...row,decision:'观察',reasons:gate.reasons,evidence:{...row.evidence,paperEligible:false,accountGate:gate}};
      }
      row.evidence.traderDecision=traderDecision(row,startedAt);
      return memeExitEvaluation(row,row.decision==='可模拟'?memeEntryContext(row.token,input,startedAt):null);
    });
    // Recheck the wall clock at the ledger boundary, never stamp a slow quote
    // as fresh or spend cash based on a prior broad-scan snapshot.
    const decisionAt=now();
    if(!request.usable())rows=rows.map(row=>({...row,decision:'观察',missing:[...new Set([...row.missing,'五秒内的独立报价'])],
      evidence:{...row.evidence,paperEligible:false,entryPlan:{...row.evidence.entryPlan,eligible:false}}}));
    const marks=Object.values(account.positions).flatMap(position=>{
      const quote=recentQuote(position,decisionAt);
      return quote?[{...quote,structureChart:holdingChart(position,quote),holderSnapshot:holdingChips(position,decisionAt),
        narrative:buildPaperNarrativeEvidence({chain:position.chain,address:position.address,token:position,events:evidence.events,nowMs:decisionAt}),
        flow:buildPaperDualFlowEvidence({state:evidence.flowState,binanceState:evidence.binanceState,chain:position.chain,address:position.address,
          nowMs:decisionAt,preferredProvider:position.entryEvidence?.flowDiagnostics?.provider||'gmgn'})}]:[];
    });
    const commitAt=now(),beforeCount=account.trades.length;
    const next=advancePaperStrategyAccount(account,{evaluations:rows,marks,enabled,nowMs:commitAt,
      diagnosticMode,confirmedMode,continuousPaperMode,opportunityMode,memeExitMode,recoveryMode});
    const nextReview=nextTradeReview(next,commitAt);
    await atomicWrite(stateFile,{schema:'yesp_atm_runtime_v1',session,chain,chains,enabled,account:next,learningShadow,narrativeMemory,
      narrativeLearningMemory,reviewComparison,exitComparison,tradeCountReview:nextReview});
    account=next;tradeCountReview=nextReview;
    const row=rows.find(r=>r.decision==='可模拟')||rows[0];
    lastCandidateEvaluation={chain:request.chain,address:request.address,at:new Date(commitAt).toISOString(),
      quoteObservedAt:request.quoteObservedAt,evaluatedPriceObservedAt:row?.evidence?.priceObservedAt||null,
      decision:row?.decision||'候选已不在当前数据源',reasons:row?.reasons||[],missing:row?.missing||[],
      mode:'targeted_main_quote_v1',quoteAgeAtDecisionMs:commitAt-stamp(request.quoteObservedAt),
      receivedToDecisionMs:commitAt-request.receivedAt,evaluationMs:commitAt-startedAt,newFills:next.trades.length-beforeCount};
    publicState={...publicState,account:clone(account),updatedAt:account.updatedAt,
      evaluations:[...(publicState.evaluations||[]).filter(r=>keyOf(r.token)!==keyOf(request)),...rows],
      tradeCountReview:tradeReviewSummary(tradeCountReview,tradeCountReviewError),
      entryGuard:confirmedAccountGate(account,commitAt,null,null,null,{continuousPaperMode}),
      cadence:{...publicState.cadence,quoteEvaluationMode:'targeted_main_quote_v1',quoteTriggeredEvaluations,lastCandidateQuote,lastCandidateEvaluation}};
  }

  async function performCycle({ background = false, research, quoteRequest = null } = {}) {
    if (stopped) return;
    await initialize();
    const [trending, trenches] = marketSnapshots.get(chain);
    const { loadedEvidence, learning } = research || await loadResearch();
    const evidence = { ...loadedEvidence, flowState: { ...loadedEvidence.flowState, profiles: { ...loadedEvidence.flowState?.profiles } } };
    // Rankings never supply a buy event or a profit flag. Only separately
    // checked 7d/30d profiles can enrich wallets already in the real trade feed.
    if (!learning?.lastError) for (const [key, profile] of Object.entries(learning?.verifiedLeaderboardProfiles || {}).slice(0, 500)) {
      const [profileChain, wallet] = key.split(':');
      if (!chains.includes(profileChain) || gmgnFlowAddress(profileChain, wallet) !== wallet) continue;
      evidence.flowState.profiles[key] = mergeLearningProfiles(profileChain, wallet, evidence.flowState.profiles[key], profile);
    }
    latestEvidence = evidence;
    const evidenceIndex = createPaperEvidenceIndex(evidence);
    const giveTurn = createCooperativeTurn({ budgetMs: 8, maxOperations: 16 });
    let scanYields = 0;
    // Only pure per-candidate work yields; ledger mutation remains serialized.
    const scanMap = async (values, map) => {
      const result = [];
      for (const value of values) {
        const pending = giveTurn();
        if (pending) { scanYields++; await pending; }
        result.push(map(value));
      }
      return result;
    };
    let nowMs = now();
    const tickStartedAt = nowMs;
    const candidates = new Map();
    for (const currentChain of chains) for (const snapshot of [...marketSnapshots.get(currentChain)].reverse()) {
      if (!Array.isArray(snapshot?.tokens)) continue;
      for (const token of snapshot.tokens.slice(0, 60)) {
        if (token?.chain !== currentChain || !gmgnFlowAddress(currentChain, token?.address)) continue;
        const key = keyOf(token), prior = candidates.get(key);
        const item = { token, observedAt: snapshot.observedAt, marketStatus: snapshot.status };
        candidates.set(key, mergePaperCandidateSnapshots(prior, item, nowMs));
      }
    }
    const discovered = discoverPaperFlowCandidates({ evidence, chains, nowMs });
    for (const item of discovered) {
      const key = keyOf(item.token);
      if (!candidates.has(key)) candidates.set(key, { token: item.token, observedAt: null, marketStatus: 'unavailable', discoverySource: 'flow' });
    }
    const newsCandidates=[...candidates.values()].map(item=>{
      const d=details.get(keyOf(item.token));return d?.token?mergePaperCandidateSnapshots(item,
        {token:d.token,observedAt:d.observedAt,marketStatus:d.status,discoverySource:'details'},nowMs):item;
    });
    // An original X document must reach discovery, not only the display index.
    // Retain known CA metadata for topic recall even after leaving the hot list.
    const newsKeys=new Set(newsCandidates.map(item=>keyOf(item.token)));
    for(const [key,d] of [...details].slice(-600))if(d?.token&&chains.includes(d.token.chain)&&!newsKeys.has(key))
      newsCandidates.push({token:d.token,observedAt:d.observedAt,marketStatus:d.status});
    const twitterNarrative=twitterNarrativeSnapshot();
    const newsWire=buildPaperNewsWire({gmgn:evidence.gmgnSocial,events:evidence.events,twitterDocuments:twitterNarrative?.documents||[],
      anchorDocuments:historicalTwitterAnchors(narrativeLearningMemory?.episodes,nowMs),
      candidates:newsCandidates.filter(item=>!paperTaxScreen(item.token).blocked),nowMs});
    const buys=account.trades.filter(t=>t.side==='buy'),consumedEvents=new Set(buys.map(t=>t.entryEvidence?.opportunity?.signalId).filter(Boolean));
    const alphaSignals=memeExitMode?alphaListingSignals(evidence.alphaCatalog,nowMs)
      .filter(s=>chains.includes(s.chain)&&!consumedEvents.has(s.id)):[];
    const monitorSignals=memeExitMode?newsWire.paperSignals.filter(s=>chains.includes(s.chain)&&!consumedEvents.has(s.id)
      &&!buys.some(t=>keyOf(t)===keyOf(s)&&t.atMs>=Date.parse(s.sourceAt))):[];
    for(const signal of alphaSignals)if(!candidates.has(keyOf(signal)))candidates.set(keyOf(signal),{
      token:{chain:signal.chain,address:signal.address,symbol:signal.symbol,name:signal.name},
      observedAt:null,marketStatus:'unavailable',discoverySource:'binance_alpha'});
    for(const token of newsWire.seeds)if(chains.includes(token.chain)&&!candidates.has(keyOf(token))) {
      // No signal snapshot is promoted to a fresh price, safety check or thesis.
      candidates.set(keyOf(token),{token,observedAt:null,marketStatus:'unavailable',discoverySource:'news_hint'});
    }
    for (const [key, ranked] of candidates) {
      const researched = details.get(key);
      if (researched?.token) candidates.set(key, mergePaperCandidateSnapshots(ranked,
        { token: researched.token, observedAt: researched.observedAt, marketStatus: researched.status, discoverySource: 'details' }, nowMs));
    }
    // Historical OGs may have left the hot list. Their exact known CA can still
    // request bounded read-only research; no symbol search or made-up address.
    if (confirmedMode) for (const [key, asset] of Object.entries(narrativeMemory?.assets || {})) {
      const detail = details.get(key);
      if (!candidates.has(key) && chains.includes(asset.chain) && detail?.token) candidates.set(key,
        { token: detail.token, marketStatus: detail.status, observedAt: detail.observedAt, discoverySource: 'narrative_recall' });
    }
    let recallMatches = [];
    if (confirmedMode && !narrativeRecallState?.error) {
      const result = advanceNarrativeRecall(narrativeMemory, { events: evidence.events, candidates: [...candidates.values()], trades: account.trades, nowMs });
      recallMatches = result.matches.filter(x=>chains.includes(x.chain));
      if(!quoteRequest) {
        narrativeMemory = result.memory;
        narrativeRecallState = { ...result.report, matches: recallMatches, sourceHealth: evidence.narrativeSourceHealth?.status || 'unavailable' };
      }
      for (const match of recallMatches) if (!candidates.has(keyOf(match))) candidates.set(keyOf(match),
        { token: { chain: match.chain, address: match.address, symbol: match.symbol }, marketStatus: 'unavailable', observedAt: null, discoverySource: 'narrative_recall' });
    }
    if (!quoteRequest && confirmedMode && !narrativeLearningState?.error) {
      try {
        const learned = advanceNarrativeLearning(narrativeLearningMemory, {
          snapshots: [...marketSnapshots.values()].flat(), marks: [...quotes.values(), ...narrativeLearningMarks.values()],
          sourceObservations: [...narrativeSourceObservations.values()], narrativeMemory, nowMs,
        });
        narrativeLearningMemory = learned.memory; narrativeLearningState = learned.report; narrativeLearningTargets = learned.followupTargets;
        narrativeSourceTargets = learned.sourceTargets;
      } catch { narrativeLearningState = { error: '起量学习数据异常，暂停学习；持仓退出仍运行' }; narrativeLearningTargets = []; narrativeSourceTargets = []; }
    }
    const recallFor = token => recallMatches.find(x=>keyOf(x)===keyOf(token)) || null;
    const narrativeResearchIndex=recoveryMode?createNarrativeResearchIndex({memory:narrativeMemory,
      documents:[...newsWire.researchDocuments,...(twitterNarrative?.documents||[])],episodes:narrativeLearningMemory?.episodes||[],nowMs}):null;
    const inputs = await scanMap([...candidates.values()].filter(item=>!quoteRequest||keyOf(item.token)===keyOf(quoteRequest)), item => ({ ...item,
      narrativeResearchIndex,
      alphaSignal:alphaSignals.find(s=>keyOf(s)===keyOf(item.token))||null,
      monitorSignal:monitorSignals.find(s=>keyOf(s)===keyOf(item.token))||null,
      newsResearch:newsWire.hints.find(h=>keyOf(h)===keyOf(item.token))||null,
      flow: evidenceIndex.flow({ chain: item.token.chain, address: item.token.address, nowMs }),
      narrative: evidenceIndex.narrative({ chain: item.token.chain, address: item.token.address, token: item.token, nowMs }),
      narrativeRecall: recallFor(item.token),
      opportunityAccount:opportunityMode ? account : null,
      nowMs, allowExploratory, compoundingCash: recoveryMode || compoundEntries || fixedEntryUsd !== null ? account.cash : null,
      fixedEntryUsd:recoveryMode?null:fixedEntryUsd, recoveryMode, upsideMode, pvpMode, diagnosticMode, confirmedMode, evidenceHoldMode, continuousPaperMode, opportunityMode, memeExitMode,
    }));
    if(quoteRequest)return performQuoteEntry(inputs[0],evidence,quoteRequest);
    const preliminary = await scanMap(inputs, input => { const chart=charts.get(keyOf(input.token)); return { input, candidateBook:'main', decisions: evaluate({ ...priced(input,nowMs),
      ...(opportunityMode ? { candles:chart?.candles || [],klineStatus:chart?.status || 'unavailable' } : {}) }) }; });
    const externalResearch=opportunityMode ? preliminary.filter(({input,decisions})=>!paperTaxScreen(input.token).blocked&&canResearchExternal(input,decisions)) : [];
    const hotResearch=planHotResearch(externalResearch,chains,charts,nowMs,hotResearchKeys);
    hotResearchKeys=hotResearch.map(r=>keyOf(r.input.token));
    const samplingActive=activeEntrySampling && !!exitComparison?.entrySampling;
    const samplingCash=samplingActive ? Math.max(exitComparison.control.cash,exitComparison.dynamic.cash) : 0;
    // Each book carries its own budget/holdings into quote admission. Shared
    // active-entry controls use their own cash pool, never the main account's.
    const controlPreliminary=opportunityMode && reviewComparison ? await scanMap(inputs, input=>{
      const chart=charts.get(keyOf(input.token));
      const controlInput={...input,opportunityReviewMode:false,memeExitMode:false,recoveryMode:false,fixedEntryUsd,
        compoundingCash:Math.max(reviewComparison.control.cash,samplingCash),opportunityAccount:samplingActive?null:reviewComparison.control};
      return {input:controlInput,candidateBook:'comparison',decisions:evaluate({...priced(controlInput,nowMs),candles:chart?.candles||[],klineStatus:chart?.status||'unavailable'})};}) : [];
    const researchFlowPolicy = confirmedMode ? { ...CONFIRMED_PAPER_POLICY, minHighProfit: 0 } : diagnosticMode ? { minBuyers: 1, minNetBuy: Number.MIN_VALUE, minHighProfit: 0, minSmartMoney: 0 } : allowExploratory ? EXPLORATORY_FLOW : { minBuyers: 4, minNetBuy: 1000, minHighProfit: 0, minSmartMoney: 0 };
    detailTargets = [];
    for (const { input, decisions } of preliminary) {
      if (paperTaxScreen(input.token).blocked) continue;
      const flow = input.flow;
      const recall = recallFor(input.token);
      const newsHint=input.newsResearch||(input.alphaSignal?{sourceAt:new Date(input.alphaSignal.listingTime).toISOString()}:null);
      const internalResearch = opportunityMode && ['internal','near_completion'].includes(input.token.marketStage)
        && canPrefetchPaperFlow(flow,{ ...researchFlowPolicy,minSmartMoney:0,minNetBuy:300 });
      if (!newsHint && !recall && !internalResearch && !(opportunityMode && canResearchExternal(input,decisions)) && !canPrefetchPaperFlow(flow, researchFlowPolicy)) continue;
      const plan = planPaperCandidateResearch(decisions, input.observedAt, nowMs);
      if(hotResearchKeys.includes(keyOf(input.token)) && (plan.needed || nowMs-stamp(input.observedAt)>=60000)) {
        plan.needed=true;plan.priority=Math.max(2,plan.priority);plan.reason='热点候选优先补齐或刷新，尚不代表可以入场';
      }
      if (plan.needed) detailTargets.push({ ...input.token, purpose: 'candidate', researchPriority: recall || newsHint ? 3 : plan.priority,
        newsSourceAt:newsHint?.sourceAt||null,
        alphaListingTime:input.alphaSignal?.listingTime??null,
        monitorSourceAt:input.monitorSignal?.sourceAt??null,
        refreshAfterMs: plan.refreshAfterMs, researchReason: input.alphaSignal?'官方 Alpha 上新：优先补齐当前行情与税费':input.monitorSignal?'监控事件快线：补齐真实行情与税费，不等待完整审计或 K 线':newsHint ? '新消息优先核查：未核实的喊单不等于已证实叙事' : recall ? '新叙事催化：优先复核历史 OG 行情和安全字段' : plan.reason });
    }
    const initial = [...preliminary,...controlPreliminary]
      // Extra chart calls are useful only after the cheaper evidence gates pass.
      // Holdings remain independently priced below, including during flow outages.
      .filter(({ input }) => !paperTaxScreen(input.token).blocked)
      .filter(({ input, decisions }) => decisions.some(readyForPaperQuote)
        || canPrefetchPaperFlow(input.flow, researchFlowPolicy) && decisions.some(onlyPricingOrFlowWarmupMissing))
      .map(({ input, decisions, candidateBook }) => ({ input,candidateBook,canQuote: decisions.some(readyForPaperQuote), score: Math.max(...decisions.map(result => result.score)) }))
      .sort((a, b) => b.score - a.score);
    // Holdings always get fresh marks first, even when no longer in ranking/trenches.
    const marks = [];
    const allPositions = heldTokens();
    for (const position of allPositions) {
      if (fastQuotes) {
        const quote = recentQuote(position, nowMs);
        if (quote) marks.push({ ...quote });
        continue;
      }
      const match = candidates.get(keyOf(position));
      if (match?.marketStatus === 'ok' && fresh(match.observedAt, nowMs) && Number.isFinite(match.token.price) && match.token.price > 0) {
        marks.push({ ...position, price: match.token.price, observedAt: match.observedAt, status: 'ok' });
      } else {
        if (background && chartJobs.size < 2) void getChart({ ...position, purpose: 'exit' }, nowMs).catch(() => {});
        const chart = background ? charts.get(keyOf(position)) || {} : await getChart({ ...position, purpose: 'exit' }, nowMs);
        const last = (chart.markCandles || chart.candles || []).filter(c => Number.isFinite(c.close) && c.close > 0 && fresh(c.time, now())).sort((a, b) => stamp(a.time) - stamp(b.time)).at(-1);
        if (chart.status === 'ok' && last) marks.push({ chain: position.chain, address: position.address, price: last.close, observedAt: new Date(stamp(last.time)).toISOString(), status: 'ok' });
      }
    }
    if (initial.length && !(diagnosticMode || confirmedMode)) {
      // Give the best candidate and one rotating candidate a chart budget.
      const selected = [initial[0], initial[1 + candidateOffset % Math.max(1, initial.length - 1)]].filter(Boolean);
      candidateOffset += 1;
      for (const { input } of selected) if (chartRefreshDue(charts.get(keyOf(input.token)),nowMs)) {
        if (background) { if (chartJobs.size < 2) void getChart(input.token, nowMs).catch(() => {}); }
        else await getChart(input.token, nowMs);
      }
    }
    // Bounded round-robin quotes: holdings first plus one researched candidate.
    // Slow network calls never own the ledger queue in the running fast loop.
    const targetMap = new Map(allPositions.map(token => [keyOf(token), { ...token, purpose: 'exit' }]));
    // Keep one candidate for a full quote/research interval, then rotate. A
    // two-second rotation would starve candidates waiting behind the CLI gate.
    // Do not spend scarce quote slots on candidates whose chart has not arrived.
    const chartReady = initial.filter(({ input, canQuote }) => {
      const chart = charts.get(keyOf(input.token));
      return canQuote && (diagnosticMode || confirmedMode || analyzePaperChart({ candles: chart?.candles, klineStatus: chart?.status, nowMs }).ready);
    });
    const quotePool=quoteCandidatePool(chartReady,{mainFirst:recoveryMode});
    const narrativeReady = quotePool.filter(x=>freshNarrativeRecall(recallFor(x.input.token),x.input.token,nowMs));
    const alphaReady=quotePool.filter(r=>r.input.alphaSignal);
    const monitorReady=quotePool.filter(r=>r.input.monitorSignal);
    // A just-listed official event preempts a normal candidate once. Holdings
    // retain priority and the event's original clock is never renewed.
    if((alphaReady.some(r=>nowMs-r.input.alphaSignal.listingTime<=300000)||monitorReady.length)
      &&![...alphaReady,...monitorReady].some(r=>keyOf(r.input.token)===quoteLease?.key))quoteLease=null;
    const quoteSelection=selectQuoteCandidate([...alphaReady,...monitorReady,...narrativeReady,...quotePool],quoteLease,nowMs,{windowMs:entryWindowMs,mainFirst:recoveryMode});
    quoteLease=quoteSelection.lease;
    const quoteCandidate=quoteSelection.row;
    if (quoteCandidate && (!recoveryMode||enabled)) admitCandidate(targetMap,{ ...quoteCandidate.input.token, purpose:'candidate',...(recoveryMode?{candidateBook:quoteCandidate.candidateBook}:{}) });
    const previousCandidate = quoteTargets.find(t => t.purpose === 'candidate');
    quoteTargets = [...targetMap.values()];
    if (background) {
      const candidate = quoteCandidate?.input.token;
      entryFocus = advanceEntryFocus(entryFocus, enabled && confirmedMode && (!recoveryMode||quoteCandidate?.candidateBook==='main')
        ? candidate : null, nowMs, {windowMs:entryWindowMs});
      // Admit a newly selected quote before optional research, rather than wait
      // for the independent timer. Per-asset jobs and the shared gate still cap it.
      if (started && confirmedMode && candidate && (keyOf(candidate) !== (previousCandidate && keyOf(previousCandidate))
        ||recoveryMode&&previousCandidate?.candidateBook!==quoteCandidate.candidateBook)) void refreshQuote();
    }
    // Entry focus is bounded (45 seconds for evidence-exit main), then 10 seconds of
    // normal discovery admission. Holding charts always retain first priority.
    const chartLimits = researchLimits();
    if (opportunityMode && chartJobs.size < chartLimits.concurrency && nowMs-lastOpportunityChartAt >= chartLimits.dispatchIntervalMs) {
      const focus = background ? focusedEntry() : null;
      const target=selectResearchChart({holdings:heldTokens(),hot:hotResearch,broad:externalResearch,charts,nowMs,dispatch:chartDispatch,chains,lastHotChain:lastHotChartChain,
        focus: focus && { ...focus, requiresStructureChart: externalResearch.some(r => keyOf(r.input.token) === keyOf(focus)) },
        pendingKeys: new Set(chartJobs.keys()) });
      if(target) {
        lastOpportunityChartAt=nowMs;chartDispatch++;
        const prior=charts.get(keyOf(target)),priorClosed=opportunityChart(prior?.candles,prior?.status,nowMs).diagnostics.lastClosedAtMs;
        lastChartDispatch={chain:target.chain,address:target.address,lane:target.researchLane,at:new Date(nowMs).toISOString(),
          proactive:!!prior && !chartRefreshDue(prior,nowMs),
          previousClosedAt:priorClosed==null?null:new Date(priorClosed).toISOString(),
          previousClosedAgeMs:priorClosed==null?null:nowMs-priorClosed};
        chartDispatches[target.researchLane]++;
        if(lastChartDispatch.proactive)chartDispatches.proactive++;
        if(target.researchLane==='hot'){lastHotChartChain=target.chain;hotChartDispatchesByChain[target.chain]++;}
        if(background) void getChart(target,nowMs).catch(()=>{}); else await getChart(target,nowMs);
      }
    }
    if (background) { void refreshDetails(); void refreshNarrativeLearning(); }
    nowMs = now();
    const finalEvidence=new Map();
    const finalEvaluate = (input, overrides = {}) => {
      const chart = charts.get(keyOf(input.token));
      const key=keyOf(input.token);
      if(!finalEvidence.has(key))finalEvidence.set(key,{
        flow:evidenceIndex.flow({chain:input.token.chain,address:input.token.address,nowMs}),
        narrative:evidenceIndex.narrative({chain:input.token.chain,address:input.token.address,token:input.token,nowMs})});
      return evaluate({ ...priced(input, nowMs), nowMs,
        ...finalEvidence.get(key),
        candles: chart?.candles || [], klineStatus: chart?.status || 'unavailable', ...overrides,
        ...(overrides.memeExitMode===false?{recoveryMode:false,fixedEntryUsd}:{}),
        ...(overrides.confirmedMode===false?{fixedEntryUsd:null}:{}) });
    };
    const originalEvaluations = (await scanMap(inputs, input => finalEvaluate(input))).flat().map(row => {
      if (!confirmedMode || row.decision !== '可模拟') return row;
      const gate = confirmedAccountGate(account, nowMs, row.token, row.evidence.confirmedPolicy?.pulse, row.evidence.narrativeRecall, { continuousPaperMode,opportunity:row.evidence.opportunity });
      if (gate.allowed) return row;
      const blocked = { ...row, decision: '观察', reasons: gate.reasons, evidence: { ...row.evidence, paperEligible: false, accountGate: gate } };
      blocked.evidence.traderDecision = traderDecision(blocked, nowMs);
      return blocked;
    });
    const evaluations=memeExitMode?originalEvaluations.map(row=>memeExitEvaluation(row,row.decision==='可模拟'
      ?memeEntryContext(row.token,finalEvidence.get(keyOf(row.token)),nowMs):null)):originalEvaluations;
    const marksFor = ledger => marks.map(mark => ({ ...mark, structureChart:holdingChart(ledger.positions[keyOf(mark)]||mark,mark),
      holderSnapshot:holdingChips(ledger.positions[keyOf(mark)],nowMs),
      narrative: ledger.exitExperimentVersion || ledger.positions[keyOf(mark)]?.memeExitPolicy ? buildPaperNarrativeEvidence({ chain: mark.chain, address: mark.address, token: ledger.positions[keyOf(mark)], events: evidence.events, nowMs }) : null,
      flow: buildPaperDualFlowEvidence({ state: evidence.flowState, binanceState: evidence.binanceState,
      chain: mark.chain, address: mark.address, nowMs, preferredProvider: ledger.positions[keyOf(mark)]?.entryEvidence?.flowDiagnostics?.provider || 'gmgn' }) }));
    const next = advancePaperStrategyAccount(account, { evaluations, marks: marksFor(account), enabled, nowMs, diagnosticMode, confirmedMode, continuousPaperMode, opportunityMode, memeExitMode, recoveryMode });
    const controlEvaluations=opportunityMode && reviewComparison ? (await scanMap(inputs, input=>finalEvaluate(input,{opportunityReviewMode:false,memeExitMode:false,
      compoundingCash:reviewComparison.control.cash,opportunityAccount:reviewComparison.control}))).flat() : [];
    const nextComparison=reviewComparison ? {...reviewComparison,control:advancePaperStrategyAccount(reviewComparison.control,
      {evaluations:controlEvaluations,marks:marksFor(reviewComparison.control),enabled:enabled && opportunityMode,nowMs,confirmedMode:true,continuousPaperMode,opportunityMode,opportunityReviewMode:false})} : null;
    const shadowEvaluations = (compoundEntries || upsideMode || pvpMode) && (learningShadow || learning?.policies?.length || learning?.personaPolicies?.length)
      ? (await scanMap(inputs.filter(input => input.token.chain === chain), input => finalEvaluate(input, { compoundingCash: null, fixedEntryUsd: null, allowExploratory: false, upsideMode: false, pvpMode: false, diagnosticMode: false, confirmedMode: false, evidenceHoldMode: false, continuousPaperMode: false, opportunityMode:false,memeExitMode:false }))).flat()
      : originalEvaluations.filter(item => item.token?.chain === chain && item.evidence?.entryTier !== 'exploratory');
    const nextShadow = advanceLearningShadow(learningShadow, { report: learning, chain, evaluations: shadowEvaluations, marksFor, enabled, nowMs });
    const samplingEvaluations=samplingActive ? (await scanMap(inputs, input=>finalEvaluate(input,{opportunityReviewMode:false,memeExitMode:false,
      compoundingCash:samplingCash,opportunityAccount:null}))).flat() : [];
    const nextExits = advanceExitComparison(exitComparison, { evaluations:originalEvaluations, samplingEvaluations, marksFor,
      enabled: enabled && thesisExitExperiment && (!exitComparison?.entrySampling || activeEntrySampling), nowMs });
    const nextReview = nextTradeReview(next,nowMs);
    await atomicWrite(stateFile, { schema: 'yesp_atm_runtime_v1', session, chain, chains, enabled, account: next, learningShadow: nextShadow, narrativeMemory, narrativeLearningMemory,reviewComparison:nextComparison, exitComparison: nextExits, tradeCountReview: nextReview });
    tradeCountReview = nextReview;
    exitComparison = nextExits;
    reviewComparison=nextComparison;
    learningShadow = nextShadow;
    account = next;
    const coverage = snapshot => ({ status: snapshot?.status || 'unavailable', observedAt: snapshot?.observedAt || null, count: snapshot?.tokens?.length || 0, reason: snapshot?.reason || null });
    const flow = buildPaperDualFlowEvidence({ state: evidence.flowState, binanceState: evidence.binanceState, chain, nowMs });
    const chainCoverage = Object.fromEntries(chains.map(currentChain => {
      const [ranked, launches, hourly] = marketSnapshots.get(currentChain);
      const chainFlow = buildPaperDualFlowEvidence({ state: evidence.flowState, binanceState: evidence.binanceState, chain: currentChain, nowMs });
      const rows = evaluations.filter(item => item.token?.chain === currentChain);
      return [currentChain, { market: coverage(ranked), trenches: coverage(launches), ...(opportunityMode ? { hourly:coverage(hourly) } : {}),
        flow: { status: chainFlow.status, fresh: chainFlow.fresh, complete: chainFlow.complete, observedAt: chainFlow.observedAt, coverageGap: chainFlow.coverageGap, providerLabel: chainFlow.providerLabel },
        candidates: [...candidates.values()].filter(item => item.token.chain === currentChain).length,
        flowDiscovered: discovered.filter(item => item.token.chain === currentChain).length,
        researchPending: detailTargets.filter(token => token.chain === currentChain).length,
        funnel: paperEntryFunnel(rows),
        eligible: new Set(rows.filter(item => item.decision === '可模拟').map(item => keyOf(item.token))).size }];
    }));
    const strategies = STRATEGY_POLICIES.map(policy => {
      const rows = evaluations.filter(item => item.strategyId === policy.id).sort(confirmedMode ? compareConfirmedCandidates : (a, b) => b.score - a.score);
      const top = rows.find(item => item.decision === '可模拟') || rows.find(item => item.decision === '观察') || rows[0];
      const trades = account.trades.filter(t => t.strategyId === policy.id && (!continuousPaperMode
        || (t.entryEvidence?.accountPolicy?.version || t.exitEvidence?.accountPolicyVersion) === CONTINUOUS_PAPER_VERSION) && (evidenceHoldMode
        ? (t.entryEvidence?.exitPolicy?.version || t.exitEvidence?.exitPolicyVersion) === EVIDENCE_HOLD_EXIT_POLICY.version
        : !confirmedMode || t.entryEvidence?.confirmedPolicy?.version === CONFIRMED_PAPER_VERSION
          || [CONFIRMED_PVP_EXIT_POLICY.version, EVIDENCE_HOLD_EXIT_POLICY.version].includes(t.exitEvidence?.exitPolicyVersion)));
      return { ...policy, ...(pvpMode ? { maxHoldMs: exitProfile.coreHoldMs } : {}), ...(confirmedMode ? { stopLoss: CONFIRMED_PAPER_POLICY.stopLoss } : {}), exitPolicy: exitProfile ? clone(exitProfile) : null, decision: top?.decision || '观察', eligibleCount: rows.filter(r => r.decision === '可模拟').length, observedCount: rows.length,
        entryUsd: fixedEntryUsd ?? policy.entryUsd,
        exploratoryEnabled: allowExploratory, entryTier: top?.entryTier || 'standard', activeEntryUsd: top?.entryUsd ?? fixedEntryUsd ?? policy.entryUsd,
        flowEvidence: top?.evidence?.flow ? {...top.evidence.flow,...top.evidence.flowDiagnostics} : null,
        reasons: top ? [...top.reasons, ...top.missing.map(field => `缺少：${field}`)] : ['等待真实候选数据'], candidate: top?.token || null,
        entryLogic: top?.entryLogic || policy.description, exitLogic: top?.exitLogic || null,
        entryPlan: top?.evidence?.entryPlan || null, narrativeAssessment: top?.evidence?.narrativeAssessment || null,
        traderDecision: top && confirmedMode ? top.evidence?.traderDecision || traderDecision(top, nowMs) : null,
        realizedPnl: trades.reduce((sum, trade) => sum + trade.realizedPnl, 0), entries: trades.filter(t => t.side === 'buy').length,
        costsUsd: trades.reduce((sum, trade) => sum + trade.costsUsd, 0) };
    });
    tickCount += 1;
    const marketSourceAges = chains.map(currentChain => {
      const source = marketSnapshots.get(currentChain)[0];
      return { chain: currentChain, status: source.status, observedAt: source.observedAt,
        ageMs: Number.isFinite(stamp(source.observedAt)) ? Math.max(0, now() - stamp(source.observedAt)) : null };
    });
    const cadence = { evaluationIntervalMs: intervalMs, evaluationCadence: 'start_to_start_single_flight',
      scanOptimization:'indexed_cooperative_v1',scanYields,scanCandidateCount:inputs.length,
      evaluationOverrunMs: Math.max(0, now() - (lastFastStartedAt ?? tickStartedAt) - intervalMs),
      actualTickGapMs: lastTickAt === null ? null : tickStartedAt - lastTickAt,
      lastTickAt: new Date(tickStartedAt).toISOString(), lastTickDurationMs: Math.max(0, now() - tickStartedAt), tickCount,
      marketRefreshIntervalMs: marketIntervalMs, marketRefreshCadence: 'start_to_start', lastMarketRefreshAt: lastMarketRefreshAt === null ? null : new Date(lastMarketRefreshAt).toISOString(),
      marketRefreshPending: !!refreshJob, marketAuxiliaryPending: !!auxiliaryJob, marketSourceAges,
      quoteRequestIntervalMs: 1000, quoteMaxAgeMs: 15_000,
      quoteTargets: quoteTargets.length, freshQuotes: quoteTargets.filter(token => recentQuote(token, nowMs)).length,
      entryQuoteMaxAgeMs: pvpMode ? PVP_EXIT_POLICY.entryQuoteMaxAgeMs : 15_000, lastQuoteTiming,
      quoteEvaluationMode: recoveryMode?'targeted_main_quote_v1':'on_fresh_quote_and_interval', quoteTriggeredEvaluations,
      quotePriorityScope: 'shared_account_queue', quoteScheduling:recoveryMode?'book_isolated_quotes_v1':'bounded_exit_candidate_lanes_v2',quoteDispatches:{...quoteDispatches},lastQuoteDispatch,
      ...(recoveryMode?{mainQuoteTargets:heldTokens().filter(t=>t.holdingTier==='main').length,
        mainFreshQuotes:heldTokens().filter(t=>t.holdingTier==='main'&&recentQuote(t,nowMs)).length,
        comparisonQuoteTargets:heldTokens().filter(t=>t.holdingTier==='comparison').length,
        comparisonMinIntervalMs:60000,comparisonDispatchGapMs:15000,comparisonCandidateMinIntervalMs:3000}:{}),
      quoteConcurrency:quoteLaneLimits().total, quoteExitConcurrency:quoteLaneLimits().exit,
      quoteInFlight:[...quoteJobs.values()].map(({purpose,token})=>({purpose,chain:token.chain,address:token.address,candidateBook:token.candidateBook||null})),
      lastCandidateQuote,lastComparisonCandidateQuote,lastCandidateEvaluation,
      sharedRequestMinIntervalMs: gmgnReadonlyPolicy(dataDir).intervalMs,
      sharedReadonlyPolicy: { ...gmgnReadonlyPolicy(dataDir), oneSecondKlineEnabled: false },
      marketChains: chains.length, marketRefreshMode: 'minute_round_robin_independent_auxiliary', detailRefreshPending: !!detailJob, detailTargets: detailTargets.length,
      flowLookbackMs: 300_000, focusFlowPollTargetMs: 5000, flowIndexBufferMs: 10_000,
      upstreamLatencyGuaranteed: false };
    lastTickAt = tickStartedAt;
    const opportunityRoutes = opportunityMode ? [...OPPORTUNITY_ROUTES,...(memeExitMode?[
      {id:'alpha_listing',label:'Alpha 官方上新',basis:'official_event',description:'刚上新五分钟快线；随后二十四小时内按当前独立报价跟随，不等普通趋势形态。'},
      {id:'monitored_event',label:'监控事件快线',basis:'monitored_event',description:recoveryMode?RECOVERY_ENTRY_TEXT:'两分钟内精确 CA 新消息，一次新鲜独立报价试仓；未知审计不拦截，不等完整 K 线。'}]:[])].map(route=>{
      const rows=evaluations.flatMap(row=>(row.evidence.opportunityRoutes || []).filter(r=>r.id===route.id).map(r=>({ ...r,token:row.token })));
      const top=rows.find(r=>r.decision==='可模拟') || rows.toSorted((a,b)=>b.score-a.score)[0];
      return { ...route,observedCount:rows.length,eligibleCount:rows.filter(r=>r.decision==='可模拟').length,
        decision:top?.decision || '观察',candidate:top?.token || null,reasons:top ? [...top.reasons,...top.missing.map(x=>`缺少：${x}`)] : ['等待数据'],
        entryUsd:recoveryMode?(top?.entryUsd??null):fixedEntryUsd,stopLoss:memeExitMode?null:.06,exitPolicy:clone(exitProfile),maxHoldMs:null,
        ...(memeExitMode?{memeExitPolicy:clone(MEME_EXIT_POLICY),exitLogic:MEME_EXIT_TEXT}:{}),
        entries:account.trades.filter(t=>t.side==='buy' && t.entryEvidence?.opportunity?.version===OPPORTUNITY_VERSION && t.entryEvidence.opportunity.id===route.id).length };
    }) : null;
    const taxChecks = [...candidates.values()].map(({token}) => ({chain:token.chain,address:token.address,symbol:token.symbol,...paperTaxScreen(token)}));
    const taxBlocked = taxChecks.filter(row => row.blocked);
    publicState = { ...publicState, status: 'ok', lastError: null, enabled, updatedAt: account.updatedAt, account: clone(account), strategies, cadence, opportunityRoutes,
      recovery:recoveryMode?{version:PAPER_RECOVERY_VERSION,activation:clone(account.recoveryActivation),
        entriesEnabled:enabled,entryText:RECOVERY_ENTRY_TEXT,evidenceGapPolicy:{...EVIDENCE_GAP_POLICY},
        gapPositions:Object.values(account.positions).filter(p=>p.evidenceGap).map(p=>({chain:p.chain,address:p.address,symbol:p.symbol,
          since:new Date(p.evidenceGap.since).toISOString(),seconds:Math.floor((p.evidenceGap.lastObservedAt-p.evidenceGap.since)/1000),
          observations:p.evidenceGap.observations,quoteAt:p.markAt,status:p.thesisStatus?.status})),
        automaticResume:false,
        comparisonNote:'恢复期主仓与主候选优先；对照持仓每币至少六十秒。仅对照盘合格的候选使用后台报价、不占主盘专注窗口，主候选出现后让位；退出规则未迁移，但更新频率不同，不能作为严格同频 A/B 比较。',
        exitText:'量价与有效地址行为证据连续中断五分钟，须新的真实报价才按授权模拟退出；恢复有效证据取消计时，旧交易不改写。'}:null,
      taxFilter: {version:PAPER_TAX_FILTER_VERSION,maximumRate:PAPER_MAX_TAX_RATE,comparison:'>',text:PAPER_TAX_FILTER_TEXT,
        observedAt:new Date(nowMs).toISOString(),observedCount:taxChecks.length,blockedCount:taxBlocked.length,
        unknownCount:taxChecks.filter(row=>row.missing.length).length,blocked:taxBlocked.slice(0,60),holdingsExempt:true},
      tradeCountReview: tradeReviewSummary(tradeCountReview,tradeCountReviewError),
      mainExitPolicy:memeExitMode?{...clone(MEME_EXIT_POLICY),text:MEME_EXIT_TEXT+(recoveryMode?' 已加授权证据中断退出：连续五分钟无法观测量价或有效地址行为，取得新的真实报价后模拟退出；无报价不伪造成交。':''),activation:clone(account.memeExitActivation)}:null,
      mainEntryPolicy:memeExitMode?{version:MEME_STRUCTURE_ENTRY_VERSION,maxStructureDistance:null,
        structureCostVersion:STRUCTURE_COST_POLICY_VERSION,structureMaxCostRate:MAIN_STRUCTURE_MAX_COST_RATE,
        alphaEntryVersion:ALPHA_ENTRY_VERSION,
        monitorEntryVersion:MONITOR_ENTRY_VERSION,
        quoteMaxAgeMs:5000,structureQuoteMaxGapMs:10000,entryWindowMs,
        text:recoveryMode?`${RECOVERY_ENTRY_TEXT}${STRUCTURE_COST_TEXT}${PAPER_TAX_FILTER_TEXT}`:`主盘监控事件快线：精确 CA 消息两分钟内，一次五秒内独立报价可试仓。无 CA 大 KOL 消息比较主题候选，名称与项目原帖链接同时匹配后才进入交易检查；超过两分钟至一小时只做当前报价重新走强的跟随，不补造狙击成交。同时持仓数量不限，受可用余额约束。Alpha 入口继续运行；真实行情、费用、明确不可交易标记和事件去重仍检查。${STRUCTURE_COST_TEXT}${PAPER_TAX_FILTER_TEXT}`}:null,
      narrativeRecall: narrativeRecallState && clone(narrativeRecallState),
      newsWire: {...newsWire,monitorEntryEnabled:memeExitMode,unconsumedPaperSignals:monitorSignals.length,
        twitterEvents:{...newsWire.twitterEvents,candidates:undefined,reports:newsWire.twitterEvents.reports.map(report=>({...report,
          candidates:report.candidates.map(c=>{const rows=evaluations.filter(r=>keyOf(r.token)===keyOf(c));
            const row=rows.find(r=>r.evidence?.opportunity?.event?.source==='twitter_narrative_event')||rows[0];
            return {...c,sourceText:undefined,checks:row?{decision:row.decision,missing:row.missing,reasons:row.reasons}:null};})}))},
        alphaCatalog:alphaCatalogReport(evidence.alphaCatalog,nowMs),entryRules:recoveryMode?RECOVERY_ENTRY_TEXT:null,
        seeds:undefined,hints:undefined,paperSignals:undefined,researchDocuments:undefined},
      narrativeLearning: narrativeLearningState && clone(narrativeLearningState),
      narrativeDesk:recoveryMode?{...narrativeDeskReport(evaluations,narrativeResearchIndex,narrativeLearningState?.stageResearch,nowMs),twitter:twitterNarrative}:null,
      entryGuard: confirmedMode ? confirmedAccountGate(account, nowMs, null, null, null, { continuousPaperMode }) : null,
      reviewComparison:reviewComparisonSummary(reviewComparison,account),
      exitComparison: exitComparisonSummary(exitComparison),
      researchPipeline: { version: RESEARCH_SCHEDULER_VERSION, detailsRequested: detailDispatchCount, detailsSucceeded, lastDetail: clone(lastDetail),
        researchMode: higherFrequencyResearch ? 'higher_frequency_bounded_v1' : 'standard',
        chartConcurrency: chartLimits.concurrency, chartDispatchIntervalMs: chartLimits.dispatchIntervalMs,
        stageSnapshot:chains.map(currentChain=>{
          const rows=preliminary.filter(r=>r.input.token.chain===currentChain);
          return {chain:currentChain,observedCandidates:rows.length,
            freshMarket:rows.filter(r=>r.decisions.some(d=>d.evidence?.marketFresh)).length,
            freshClosedCharts:rows.filter(r=>{const c=charts.get(keyOf(r.input.token));return opportunityChart(c?.candles,c?.status,nowMs,{contiguousTail:memeExitMode}).ready;}).length,
            structuralSignals:rows.filter(r=>r.decisions.some(d=>d.evidence?.opportunityRoutes?.some(s=>s.basis==='ohlcv'&&s.signalReady))).length,
            quoteReady:new Set(chartReady.filter(r=>r.input.token.chain===currentChain).map(r=>keyOf(r.input.token))).size,
            mainQuoteReady:new Set(chartReady.filter(r=>r.input.token.chain===currentChain&&r.candidateBook==='main').map(r=>keyOf(r.input.token))).size,
            comparisonQuoteReady:new Set(chartReady.filter(r=>r.input.token.chain===currentChain&&r.candidateBook==='comparison').map(r=>keyOf(r.input.token))).size,
            liveQuoteTargets:quoteTargets.filter(t=>t.chain===currentChain&&t.purpose!=='exit').length};
        }),
        stageSnapshotNote:'当前去重候选的阶段快照，不是累计成交数；结构成立仍需行情、安全、成本和独立报价通过。',
        hotCandidates:hotResearch.map(r=>({chain:r.input.token.chain,address:r.input.token.address,symbol:r.input.token.symbol})),
        discoveryCandidates:externalResearch.length,hotLimit:chains.length,lastChartDispatch,chartDispatches:{...chartDispatches},
        hotChartDispatchesByChain:{...hotChartDispatchesByChain},quoteLease,
        entryFocus: entryFocus && { ...entryFocus, active: !!focusedEntry(), maxWindowMs: entryWindowMs, discoveryIntervalMs: 10000 },
        researchDeferrals: { ...researchDeferrals },
        chartDiagnostics:[...charts.entries()].toSorted((a,b)=>b[1].fetchedAt-a[1].fetchedAt).slice(0,10).map(([key,c])=>{
          const [chartChain,address]=key.split(':'), result=opportunityChart(c.candles,c.status,nowMs,{contiguousTail:memeExitMode});
          return {chain:chartChain,address,fetchedAt:new Date(c.fetchedAt).toISOString(),observedAt:c.observedAt||null,
            requestWindow:c.requestWindow||null,queuedAt:c.queuedAt||null,requestedAt:c.requestedAt||null,receivedAt:c.receivedAt||null,
            closedThroughAt:new Date(c.closedThroughAtMs).toISOString(),excludedUnclosedBars:c.excludedUnclosedBars,
            sourceStatus:c.status||'unavailable',sourceReason:c.reason||c.reasonCode||null,
            ready:result.ready,reason:result.reason||null,diagnostics:result.diagnostics};
        }),
        nearEntryRefreshPending: detailTargets.filter(token => token.researchPriority === 2).length, chartReadyCandidates: new Set(chartReady.map(r=>keyOf(r.input.token))).size,
        externalResearchCandidates:externalResearch.length,chartCacheCount:charts.size,chartRequestsPending:chartJobs.size,
        pending: detailTargets.slice(0, 20).map(token => ({ chain: token.chain, address: token.address, symbol: token.symbol, priority: token.researchPriority, reason: token.researchReason })) },
      positionSizing: recoveryMode?{mode:'cash_fraction_cap',version:PAPER_RECOVERY_SIZING_VERSION,
        fixedEntryUsd:null,exactTicket:false,cashBasis:account.cash,includesUnrealizedPnl:false,entryFraction:.1,maxEntryUsd:10,
        maxLiquidityShare:PAPER_LIQUIDITY_CAP_RATE,maxPositions:null,positionLimitBasis:'available_cash'}:{ mode: fixedEntryUsd !== null ? 'fixed' : compoundEntries ? 'cash_fraction' : 'fixed', version: fixedEntryUsd !== null ? PAPER_FIXED_SIZING_VERSION : PAPER_SIZING_VERSION,
        fixedEntryUsd, exactTicket: fixedEntryUsd !== null,
        cashBasis: account.cash, includesUnrealizedPnl: false, exploratoryRate: fixedEntryUsd !== null ? null : .02,
        standardRates: fixedEntryUsd !== null ? null : Object.fromEntries(STRATEGY_POLICIES.map(p => [p.id, p.entryUsd / 100])),
        maxLiquidityShare: PAPER_LIQUIDITY_CAP_RATE, maxPositions: continuousPaperMode ? null : 2, positionLimitBasis: continuousPaperMode ? 'available_cash' : 'fixed_count' },
      learning, learningComparison: { ...learningShadowSummary(learningShadow), chain }, chainCoverage,
      coverage: { market: coverage(trending), trenches: coverage(trenches), flow: { status: flow.status, observedAt: flow.observedAt, fresh: flow.fresh, complete: flow.complete, coverageGap: flow.coverageGap, scope: flow.scope, evidenceScope: flow.evidenceScope, windowStartAt: flow.windowStartAt, windowEndAt: flow.windowEndAt, sourceIssue: flow.sourceIssue, provider: flow.provider, providerLabel: flow.providerLabel, sources: flow.sources } },
      evaluations: evaluations.map(({ evidence: detail, ...entry }) => ({ ...entry, evidence: detail })) };
  }

  function runOnce() {
    if (stopped) return Promise.resolve();
    if (cycle) return cycle;
    cycle = refreshMarket().then(() => serial(() => performCycle())).catch(error => { errorState(error); throw error; }).finally(() => { cycle = null; });
    return cycle;
  }
  function fastOnce() {
    if (stopped) return Promise.resolve();
    if (fastCycle) return fastCycle;
    lastFastStartedAt = now();
    // Slow evidence/learning reads must never occupy the ledger writer queue.
    fastCycle = serial(initialize).then(loadResearch).then(research => serial(() => performCycle({ background: true, research })))
      .catch(error => { errorState(error); throw error; }).finally(() => { fastCycle = null; });
    return fastCycle;
  }
  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => { fastOnce().catch(() => {}).finally(schedule); }, nextScanDelay(intervalMs, lastFastStartedAt ?? now(), now()));
    timer.unref?.();
  }
  function scheduleRefresh() {
    if (stopped) return;
    const delay = memeExitMode && focusedEntry() ? marketIntervalMs
      : nextScanDelay(marketIntervalMs, lastMarketRefreshStartedAt ?? now(), now());
    refreshTimer = setTimeout(() => { refreshMarket({ background: true }).finally(scheduleRefresh); }, delay); refreshTimer.unref?.();
  }
  function scheduleExit() {
    if (stopped) return;
    exitTimer = setTimeout(() => { exitOnce().catch(() => {}).finally(scheduleExit); }, nextScanDelay(1000, lastExitStartedAt ?? now(), now())); exitTimer.unref?.();
  }
  function scheduleQuote(delay = 0) {
    if (stopped) return;
    quoteTimer = setTimeout(() => { const startedAt = now();
      // Pump free lanes independently; the maps above enforce single flight.
      // Waiting for both jobs here would recreate cross-lane head-of-line blocking.
      void Promise.resolve().then(refreshQuote).catch(() => {});
      scheduleQuote(nextScanDelay(1000, startedAt, now()));
    }, delay); quoteTimer.unref?.();
  }
  return {
    stateFile,
    snapshot: () => clone(publicState),
    runOnce, fastOnce, exitOnce, refreshMarket, refreshQuote, refreshDetails, refreshNarrativeLearning,
    start: async () => { if (started || stopped) return; started = true; try { await serial(initialize); } catch (error) { started = false; throw error; }
      void refreshMarket({ background: true }).finally(scheduleRefresh); void fastOnce().catch(() => {}).finally(schedule); scheduleQuote(); scheduleExit(); },
    setEnabled: value => serial(async () => {
      if (typeof value !== 'boolean') throw new TypeError('enabled must be boolean');
      if (stopped) throw new Error('模拟引擎已停止');
      await initialize();
      await atomicWrite(stateFile, { schema: 'yesp_atm_runtime_v1', session, chain, chains, enabled: value, account, learningShadow, narrativeMemory, narrativeLearningMemory,reviewComparison, exitComparison, tradeCountReview });
      enabled = value; publicState = { ...publicState, enabled }; return clone(publicState);
    }),
    resetCash: operationId => serial(async () => {
      if (stopped) throw new Error('模拟引擎已停止');
      await initialize();
      const next = resetPaperCash(account, { operationId, nowMs: now() });
      if (account.cashAdjustments?.some(item => item.id === operationId)) return clone(publicState);
      const before = { schema: 'yesp_atm_runtime_v1', session, chain, chains, enabled, account, learningShadow,
        narrativeMemory, narrativeLearningMemory, reviewComparison, exitComparison, tradeCountReview };
      // Serialized with fills; backup must succeed before funding is persisted.
      const backup = `${stateFile}.before-reset-${operationId}.json`;
      const handle = await fs.open(backup, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(before)); await handle.sync(); } finally { await handle.close(); }
      await atomicWrite(stateFile, { ...before, account: next });
      account = next;
      publicState = { ...publicState, account: clone(account),
        reviewComparison: reviewComparisonSummary(reviewComparison, account) };
      return clone(publicState);
    }),
    stop: async () => { stopped = true; clearTimeout(timer); clearTimeout(refreshTimer); clearTimeout(quoteTimer); clearTimeout(exitTimer);
      await Promise.allSettled([cycle, fastCycle, quoteEvaluationJob, exitJob, refreshJob, auxiliaryJob, ...[...quoteJobs.values()].map(x=>x.job), detailJob, narrativeLearningJob, ...chartJobs.values()]); await tail; await releaseLock(); },
  };
}
