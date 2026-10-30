import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { READONLY_ADMISSION_VERSION } from './readonly-admission-policy.js';
import { LOSS_REPAIR_TEXT, LOSS_REPAIR_VERSION, ORDER_FEE_CAPABILITY, lossRepairReport, PAPER_ENTRY_ROUTES_VERSION, PAPER_ENTRY_ROUTES_TEXT } from './paper-loss-repair.js';
import { ESTIMATED_COST_VERSION, ESTIMATED_COST_TEXT } from './paper-estimated-cost.js';
import { paperLossGuard } from './paper-loss-guard.js';
import {LAUNCH_POLICY,launchContext} from './paper-launch-policy.js';
import {DEPTH_TRANSPORT_VERSION,DEPTH_RETRY_POLICY,admitInternalDepthRetryCandidate} from './paper-internal-depth.js';
import {buildPoolFirstThreeWire,POOL_FIRST_THREE_POLICY,validPoolSignal,poolEntryAllowed} from './paper-pool-signal.js';
import { STRATEGY_POLICIES, createPaperStrategyAccount, advancePaperStrategyAccount, evaluatePaperStrategies, resetPaperCash } from './paper-strategy-engine.js';
import {alphaListingSignals,alphaCatalogReport,ALPHA_ENTRY_VERSION} from './binance-alpha-catalog.js';
import {MONITOR_ENTRY_VERSION} from './paper-monitor-signal.js';
import { buildPaperDualFlowEvidence, buildPaperNarrativeEvidence, createPaperEvidenceLoader, createPaperEvidenceIndex } from './paper-strategy-evidence.js';
import { createCooperativeTurn } from './cooperative-turn.js';
import { createPaperResearchReader } from './paper-research-reader.js';
import { gmgnFlowAddress, GMGN_FLOW_CHAINS } from './gmgn-flow-signal.js';
import { STRATEGY_ANALYSIS_VERSION, analyzePaperChart } from './paper-strategy-analysis.js';
import { advanceLearningShadow, validateLearningShadow, learningShadowSummary } from './wallet-learning-shadow.js';
import { discoverPaperFlowCandidates } from './paper-candidate-discovery.js';
import { mergeLearningProfiles } from './wallet-learning-universe.js';
import { PAPER_SIZING_VERSION, PAPER_LIQUIDITY_CAP_RATE, PAPER_FIXED_SIZING_VERSION, PAPER_FIXED_ENTRY_USD } from './paper-position-sizing.js';
import { UPSIDE_EXIT_POLICY } from './paper-upside-policy.js';
import { PVP_EXIT_POLICY, CONFIRMED_PVP_EXIT_POLICY, EVIDENCE_HOLD_EXIT_POLICY } from './paper-pvp-policy.js';
import { PAPER_ENTRY_POLICY_VERSION, EXPLORATORY_FLOW } from './paper-entry-policy.js';
import { mergePaperCandidateSnapshots, planPaperCandidateResearch, readyForPaperQuote, researchReadyForQuote, canPrefetchPaperFlow, onlyPricingOrFlowWarmupMissing, missingRequestedDetailFields } from './paper-candidate-research.js';
import { FOCUSED_RESEARCH_BUDGET_VERSION, detailGapRetry, waitsForChartTurn, reserveHotChartTurn } from './paper-research-budget.js';
import { paperEntryFunnel, paperEntryDiagnostics } from './paper-entry-funnel.js';
import { gmgnReadonlyPolicy } from './gmgn-readonly-pacing.js';
import { PAPER_AUX_AUDIT_VERSION, PAPER_TAX_FILTER_VERSION, PAPER_MAX_TAX_RATE, PAPER_TAX_FILTER_TEXT, paperTaxScreen } from './paper-safety-policy.js';
import { PAPER_DIAGNOSTIC_ENTRY_VERSION } from './paper-diagnostic-entry.js';
import { CONFIRMED_PAPER_VERSION, CONFIRMED_PAPER_POLICY, confirmedAccountGate, CONTINUOUS_PAPER_VERSION, paperOperatingPolicy } from './paper-confirmed-policy.js';
import { traderDecision, compareConfirmedCandidates, CATALYST_SELECTION_VERSION } from './paper-trader-reasoning.js';
import { paperSessionLedgerFile, validatePaperSession } from './paper-account-session.js';
import { advanceNarrativeRecall, validNarrativeMemory, freshNarrativeRecall } from './paper-narrative-recall.js';
import { advanceNarrativeLearning, validNarrativeLearning } from './paper-narrative-learning.js';
import { advanceNarrativeAcademy, validNarrativeAcademy } from './paper-narrative-academy.js';
import { readNarrativeLearningSource } from './paper-narrative-learning-source.js';
import { OPPORTUNITY_VERSION, OPPORTUNITY_ROUTES, canResearchExternal, opportunityChart, MAIN_CHART_WINDOW_VERSION } from './paper-opportunity-policy.js';
import { createPaperStrategyFocusShadowStore } from './paper-strategy-focus-shadow-store.js';
import { createPaperStrategyFocusSimulator, PAPER_STRATEGY_FOCUS_SIMULATION_VERSION } from './paper-strategy-focus-simulator.js';
import { MEME_STRUCTURE_ENTRY_VERSION } from './paper-opportunity-review.js';
import { STRUCTURE_COST_POLICY_VERSION, STRUCTURE_COST_TEXT, MAIN_STRUCTURE_MAX_COST_RATE, GAS_ACCOUNT_ONLY_TEXT } from './paper-cost-policy.js';
import { planHotResearch, selectResearchChart, selectQuoteCandidate, quoteCandidatePool, selectQuoteTarget, chartRefreshDue, advanceEntryFocus, RESEARCH_SCHEDULER_VERSION } from './paper-research-scheduler.js';
import { createReviewComparison, validateReviewComparison, reviewComparisonSummary } from './paper-review-comparison.js';
import { createExitComparison, validateExitComparison, advanceExitComparison, exitComparisonSummary, activateExitEntrySampling } from './paper-exit-comparison.js';
import { nextScanDelay } from './paper-runtime-cadence.js';
import { createTradeReview, advanceTradeReview, validateTradeReview, tradeReviewSummary } from './paper-trade-review.js';
import { MEME_EXIT_POLICY, MEME_EXIT_TEXT, memeEntryContext, memeExitEvaluation } from './paper-meme-exit.js';
import { buildPaperNewsWire } from './paper-news-wire.js';
import { historicalTwitterAnchors } from './paper-twitter-event.js';
import { PAPER_RECOVERY_VERSION, EVIDENCE_GAP_POLICY, RECOVERY_ENTRY_TEXT } from './paper-recovery-policy.js';
import { PAPER_RECOVERY_SIZING_VERSION, PAPER_INTERNAL_DEPTH_SIZING_VERSION } from './paper-position-sizing.js';
import { createNarrativeResearchIndex, narrativeDeskReport } from './paper-narrative-thesis.js';
import { walletBuyResearchHint, WALLET_BUY_PRIORITY_VERSION } from './paper-wallet-priority.js';
import { HOT_RESEARCH_VERSION, HOT_WATCH_MS, hotWatchEligible, advanceHotWatch, marketLeaderHint, selectHotQuoteResearch } from './paper-hot-research.js';
import { paperEventTriggers } from './paper-event-triggers.js';
import {buildCollectiveWire,COLLECTIVE_POLICY,COLLECTIVE_SIGNAL_VERSION,PREQUALIFIED_WALLET_POLICY,INTERNAL_BURST_POLICY,ONCHAIN_BURST_POLICY,ONCHAIN_BURST_VERSION,validCollectiveSignal} from './paper-collective-signal.js';
import {buildOnchainTradeFlow} from './paper-onchain-flow.js';
import { tradingScanChains } from './trading-scan-scope.js';
import { GMGN_THREE_LISTS, FOCUSED_TRENCHES, FOCUSED_REFRESH_MS, focusedListTokens, focusedMembership, focusedDiscoverySnapshot } from './paper-discovery-scope.js';

const clone = value => structuredClone(value);
const fastQuoteAvailable = market => typeof market?.quote === 'function';
const keyOf = token => `${token.chain}:${gmgnFlowAddress(token.chain, token.address)}`;
const stamp = value => typeof value === 'number' ? (value < 1e10 ? value * 1000 : value) : Date.parse(value || '');
const fresh = (value, nowMs, maxAgeMs=120_000) => Number.isFinite(stamp(value)) && stamp(value) <= nowMs && stamp(value) >= nowMs - maxAgeMs;

// Ranking bounds discovery, not continuity: retain at most four existing
// collection targets outside the top 24 while their actual list evidence is
// still fresh. The collector separately enforces its four-slot/lease budget.
export function selectInnerTradeTargets(inputs, { nowMs, listedForEntry, watchedTargets = [] }) {
  const eligible = inputs.filter(i => i.token.chain === 'bsc' && listedForEntry(i.token)
    && ['internal', 'near_completion'].includes(i.token.marketStage) && fresh(i.observedAt, nowMs));
  const ranked = [...eligible].sort((a, b) => (Number(b.token.volume) || 0) - (Number(a.token.volume) || 0));
  const watched = new Set(watchedTargets.slice(0, 4).map(keyOf));
  const selected = new Map(ranked.slice(0, 24).map(i => [keyOf(i.token), i]));
  for (const i of eligible) if (watched.has(keyOf(i.token))) selected.set(keyOf(i.token), i);
  return [...selected.values()].map(i => ({ ...i.token, sourceObservedAt: i.observedAt }));
}

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

export function createPaperStrategyRuntime({ market, dataDir, internalDepthProbe = null, internalTradeMonitor = null, gasMonitor = null, jevResearch = null, chainGasAccounting = false, lossRepairMode = false, enforceLossGuards = lossRepairMode, session = null, chain = 'robinhood', chains = [chain], discoveryMode = 'all_sources', now = Date.now, intervalMs = 1000, marketIntervalMs = 1000, twitterNarrativeSnapshot = () => null, learningReportSnapshot = null,
  evidenceLoader = createPaperEvidenceLoader(dataDir), evaluate = evaluatePaperStrategies, learningLoader = () => null, narrativeSourceReader = readNarrativeLearningSource, allowExploratory = false, compoundEntries = false, fixedEntryUsd = null, upsideMode = false, pvpMode = false, diagnosticMode = false, confirmedMode = false, evidenceHoldMode = false, continuousPaperMode = false, opportunityMode = false, thesisExitExperiment = false, activeEntrySampling = false, tradeReviewEvery = null, higherFrequencyResearch = false, memeExitMode = false, recoveryMode = false, minimalEntryMode = false, evidenceGapExitMode = true, strategyFocusSimulation = false } = {}) {
  if(typeof recoveryMode!=='boolean'||recoveryMode&&!memeExitMode)throw new TypeError('recovery requires paper meme main');
  if(typeof strategyFocusSimulation!=='boolean'||strategyFocusSimulation&&(!confirmedMode||!opportunityMode||!recoveryMode))
    throw new TypeError('focus paper simulation requires confirmed multi-setup recovery paper mode');
  const estimatedFeeMode=session?.costModel===ESTIMATED_COST_VERSION;
  if(typeof lossRepairMode!=='boolean'||lossRepairMode&&(!recoveryMode||!memeExitMode))throw new TypeError('loss repair requires recovered paper main');
  if(estimatedFeeMode&&recoveryMode&&(!lossRepairMode||chainGasAccounting||thesisExitExperiment||activeEntrySampling))throw new TypeError('estimated session requires isolated repair mode without legacy comparisons');
  if(typeof enforceLossGuards!=='boolean'||lossRepairMode&&!enforceLossGuards&&(!estimatedFeeMode||!continuousPaperMode))throw new TypeError('loss guard override requires continuous estimated paper');
  if(chainGasAccounting && (!memeExitMode || !gasMonitor))throw new TypeError('chain gas accounting requires paper main and receipt collector');
  if(typeof memeExitMode!=='boolean'||memeExitMode&&(!confirmedMode||!continuousPaperMode||!opportunityMode))throw new TypeError('meme exit requires confirmed continuous multi-setup main');
  if (tradeReviewEvery !== null && tradeReviewEvery !== 100) throw new TypeError('paper review batch must contain 100 fills');
  if (typeof higherFrequencyResearch !== 'boolean' || higherFrequencyResearch && (!confirmedMode || !opportunityMode)) throw new TypeError('higher research cadence requires confirmed multi-setup paper mode');
  if (typeof allowExploratory !== 'boolean') throw new TypeError('invalid paper entry mode');
  if (typeof compoundEntries !== 'boolean') throw new TypeError('invalid paper sizing mode');
  if (typeof upsideMode !== 'boolean') throw new TypeError('invalid upside mode');
  if (typeof pvpMode !== 'boolean' || pvpMode && upsideMode) throw new TypeError('invalid pvp mode');
  if (typeof diagnosticMode !== 'boolean' || diagnosticMode && (!allowExploratory || !pvpMode || !fastQuoteAvailable(market))) throw new TypeError('diagnostic entries require exploratory PVP and independent quotes');
  if (typeof confirmedMode !== 'boolean' || confirmedMode && (!allowExploratory || !pvpMode || diagnosticMode || !fastQuoteAvailable(market))) throw new TypeError('invalid confirmed paper configuration');
  if (typeof minimalEntryMode !== 'boolean' || minimalEntryMode && (!confirmedMode || !allowExploratory || !pvpMode || diagnosticMode)) throw new TypeError('invalid minimal paper configuration');
  if (typeof evidenceGapExitMode !== 'boolean') throw new TypeError('invalid evidence gap exit mode');
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
  const scanChains=tradingScanChains(dataDir,chains);
  if(!['all_sources',GMGN_THREE_LISTS].includes(discoveryMode))throw new TypeError('invalid discovery mode');
  const focusedDiscovery=discoveryMode===GMGN_THREE_LISTS;
  if(!scanChains.length)throw new TypeError('trading scan scope excludes all session chains');
  if (session) {
    validatePaperSession(session); session = clone(session);
    if (!confirmedMode || session.chain !== chain || JSON.stringify(session.chains) !== JSON.stringify(chains)) throw new Error('独立实验只能使用已选择的 V2 策略与链配置');
  }
  const stateFile = path.join(dataDir, session ? paperSessionLedgerFile(session) : 'yesp-atm-strategy-paper.json'), lockFile = `${stateFile}.lock`;
  const focusShadowStore = opportunityMode ? createPaperStrategyFocusShadowStore({dataDir,sessionId:session?.id||null,now}) : null;
  const focusSimulator = strategyFocusSimulation ? createPaperStrategyFocusSimulator({dataDir,now}) : null;
  const owner = randomUUID();
  const researchReader = createPaperResearchReader({ evidenceLoader, learningLoader, now });
  let account = null, enabled = !lossRepairMode, initialized = false, stopped = false, started = false, lockHeld = false, timer, tail = Promise.resolve(), cycle = null;
  let algorithmSignalJournal=[],collectiveWireState=null,internalTradeTargets=[];
  function positionFlow(position,evidence,nowMs) {
    if(position?.entryEvidence?.collectiveSignal?.version===ONCHAIN_BURST_VERSION)
      return buildOnchainTradeFlow({state:internalTradeMonitor?.snapshot()||evidence.innerTradeState,token:position,nowMs});
    return buildPaperDualFlowEvidence({state:evidence.flowState,binanceState:evidence.binanceState,
      chain:position.chain,address:position.address,nowMs,preferredProvider:position.entryEvidence?.flowDiagnostics?.provider||'gmgn'});
  }
  function entryFlow(token,signal,evidence,index,nowMs) {
    return signal?.version===ONCHAIN_BURST_VERSION
      ?buildOnchainTradeFlow({state:evidence.innerTradeState,token,nowMs})
      :index.flow({chain:token.chain,address:token.address,nowMs});
  }
  const internalDepths=new Map(),depthAttempts=new Map();
  let depthJob=null,lastDepthProbe=null;
  function scheduleInternalDepth(input,rows) {
    if(!internalDepthProbe||!enabled||stopped||depthJob||!lossRepairMode||!estimatedFeeMode||!input)return;
    if(heldTokens().some(p=>!recentQuote(p,now())))return; // preserve exits
    const signal=input.collectiveSignal,key=keyOf(input.token),quote=recentQuote(input.token,now());
    const row=rows.find(r=>r.evidence?.collectiveSignal?.id===signal?.id&&r.evidence?.internalDepthCheck?.ready===false
      &&!r.evidence.safety.blocked.length&&r.evidence.safety.auditComplete&&r.entryUsd>=1
      &&r.evidence.costAssumptions.estimatedRoundTripCostRate<=.15);
    if(!row||!quote||stamp(quote.observedAt)<stamp(signal?.sourceAt)
      ||!validCollectiveSignal(signal,input.token,now())||!['internal','near_completion'].includes(input.token.marketStage))return;
    let prior=depthAttempts.get(key);
    const startedAt=now();
    if(!admitInternalDepthRetryCandidate(depthAttempts,key,startedAt))return;
    // A scheduled short retry is not a new generation just because the
    // event loop woke late. Expire it against the original window and retain
    // the ordinary cooldown measured from the last completed attempt.
    if(prior?.capacityRetry&&startedAt>=prior.generationStartedAt+DEPTH_RETRY_POLICY.windowMs) {
      prior={...prior,capacityRetry:false,nextAttemptAt:prior.at+DEPTH_RETRY_POLICY.failureBackoffMs};
      depthAttempts.set(key,prior);
      if(lastDepthProbe&&keyOf(lastDepthProbe)===key)lastDepthProbe={...lastDepthProbe,
        capacityRetry:false,retryWindowExpired:true,nextAttemptAt:new Date(prior.nextAttemptAt).toISOString()};
    }
    if(prior&&startedAt<prior.nextAttemptAt)return;
    // A zero-RPC capacity-failure chain gets at most three attempts in a
    // fixed ten-second generation. Success keeps the ordinary five-second
    // proof-refresh cadence; it is no longer a failed-capacity retry.
    // A quote refresh or a changing signal ID cannot slide/reset that window;
    // exhausted capacity retries fall back to the ordinary 60-second delay.
    const generation=prior&&startedAt<prior.generationStartedAt+DEPTH_RETRY_POLICY.windowMs?prior:
      {generationStartedAt:startedAt,generationSignalId:signal.id,attempts:0};
    const attempt={at:startedAt,ok:false,nextAttemptAt:startedAt+DEPTH_RETRY_POLICY.failureBackoffMs,
      generationStartedAt:generation.generationStartedAt,generationSignalId:generation.generationSignalId,
      attempts:generation.attempts+1};
    depthAttempts.set(key,attempt);
    depthJob=Promise.resolve().then(()=>internalDepthProbe.probe({token:{...input.token,price:quote.price},budgetUsd:row.entryUsd,
      notionalUsd:row.evidence.costAssumptions.notionalUsd,referenceAt:quote.observedAt})).catch(()=>({status:'unavailable',reason:'曲线试算故障'})).then(result=>{
      if(stopped)return;
      const completedAt=now(),scope=['capacity','host','method'].includes(result.rpcFailureScope)?result.rpcFailureScope:null;
      const retryAfterMs=Number.isSafeInteger(result.retryAfterMs)&&result.retryAfterMs>0?result.retryAfterMs:null;
      const capacityDelay=Math.max(DEPTH_RETRY_POLICY.minBackoffMs,retryAfterMs||0);
      const capacityRetry=result.status==='unavailable'&&result.code==='RPC_COORDINATOR_UNAVAILABLE'
        &&scope==='capacity'&&result.diagnostics?.physicalRequests===0&&retryAfterMs!==null
        &&attempt.attempts<DEPTH_RETRY_POLICY.maxAttempts
        &&completedAt+capacityDelay<attempt.generationStartedAt+DEPTH_RETRY_POLICY.windowMs;
      const delay=result.status==='ok'?5000:capacityRetry?capacityDelay:Math.max(DEPTH_RETRY_POLICY.failureBackoffMs,scope&&retryAfterMs||0);
      const nextAttemptAt=Math.min(Number.MAX_SAFE_INTEGER,completedAt+delay);
      depthAttempts.set(key,{...attempt,at:completedAt,ok:result.status==='ok',nextAttemptAt,capacityRetry});
      lastDepthProbe={chain:input.token.chain,address:input.token.address,status:result.status,reason:result.reason||null,
        code:result.code||null,quoteAddress:result.quoteAddress||result.proof?.quoteAddress||null,
        diagnostics:result.diagnostics||null,
        rpcFailureScope:scope,retryAfterMs,capacityRetry,attempts:attempt.attempts,
        generationStartedAt:new Date(attempt.generationStartedAt).toISOString(),generationSignalId:attempt.generationSignalId,
        nextAttemptAt:nextAttemptAt<=8640000000000000?new Date(nextAttemptAt).toISOString():null,
        observedAt:new Date(completedAt).toISOString(),durationMs:completedAt-startedAt};
      if(result.proof)internalDepths.set(key,result.proof);else internalDepths.delete(key);
      if(internalDepths.size>64)internalDepths.delete(internalDepths.keys().next().value);
      // The same price may already have been evaluated while depth was
      // pending. A completed proof is new evidence, not a new price: use the
      // event lane, which re-reads sources and rechecks quote/signal expiry.
      if(started&&result.status==='ok')requestEventRecheck(input.token,'internal_depth_ready');
    }).finally(()=>{depthJob=null;});
  }
  function withLearningEvidence({loadedEvidence,learning}) {
    const evidence={...loadedEvidence,innerTradeState:internalTradeMonitor?.snapshot()||null,flowState:{...loadedEvidence?.flowState,profiles:{...loadedEvidence?.flowState?.profiles}}};
    if(!learning?.lastError)for(const [key,profile] of Object.entries({...learning?.verifiedLeaderboardProfiles,...learning?.verifiedProfiles}).slice(0,500)) {
      const [c,wallet]=key.split(':');
      if(chains.includes(c)&&gmgnFlowAddress(c,wallet)===wallet)evidence.flowState.profiles[key]=mergeLearningProfiles(c,wallet,evidence.flowState.profiles[key],profile);
    }
    return evidence;
  }
  function observeAlgorithmSignals(signals,atMs) {
    for(const s of signals)if(!algorithmSignalJournal.some(r=>r.id===s.id)) {
      const event=eventInterest.get(keyOf(s));
      algorithmSignalJournal.push({id:s.id,chain:s.chain,address:s.address,source:s.source,sourceAt:s.sourceAt,
        firstDetectedAt:event?.id===s.id?event.firstDetectedAt:new Date(atMs).toISOString(),
        decision:'等待证据检查',missing:[],reasons:[]});
    }
    algorithmSignalJournal=algorithmSignalJournal.slice(-200);
  }
  function recordAlgorithmDecision(rows,atMs) {
    for(const row of rows)for(const route of row.evidence?.opportunityRoutes||[]) {
      const record=algorithmSignalJournal.find(r=>r.id===route.signalId);
      if(record)Object.assign(record,{evaluatedAt:new Date(atMs).toISOString(),decision:route.decision,
        missing:(route.missing||[]).slice(0,10),reasons:(route.reasons||[]).slice(0,10)});
    }
  }
  function algorithmSignalSnapshot() {
    const records=algorithmSignalJournal.map(r=>{
      const fill=account?.trades?.find(t=>t.side==='buy'&&t.entryEvidence?.opportunity?.signalId===r.id);
      const expired=!fill&&now()-Date.parse(r.sourceAt)>(['collective_smart_money','prequalified_wallet','internal_burst','onchain_internal_burst'].includes(r.source)?30000:120000);
      return {...r,status:fill?'filled':expired?'expired':'pending',filledAt:fill?new Date(fill.atMs).toISOString():null,
        detectionToFillMs:fill?fill.atMs-Date.parse(r.firstDetectedAt):null,sourceToFillMs:fill?fill.atMs-Date.parse(r.sourceAt):null};
    });
    const {windows:rawWindows,...onchainCoverage}=internalTradeMonitor?.snapshot()||{status:'disabled'};
    return {version:COLLECTIVE_SIGNAL_VERSION,enabled:lossRepairMode&&estimatedFeeMode&&scanChains.includes('bsc'),
      onchainBurstPolicy:ONCHAIN_BURST_POLICY,onchainCoverage,
      policy:COLLECTIVE_POLICY,innerWalletPolicy:PREQUALIFIED_WALLET_POLICY,internalBurstPolicy:INTERNAL_BURST_POLICY,sourceStatus:collectiveWireState?.sourceStatus||'not_checked',sourceObservedAt:collectiveWireState?.observedAt||null,
      sourceScope:'gmgn_public_tagged_wallet_subset',fullMarketTradesCovered:false,
      coverageNote:'仅 GMGN 聪明钱/KOL 标签钱包的已采集窗口；不包含全部普通钱包买卖，缺少样本不能解释为全市场没有放量。',
      depthProbe:{enabled:!!internalDepthProbe,transportVersion:DEPTH_TRANSPORT_VERSION,...DEPTH_RETRY_POLICY,
        trackedCandidates:depthAttempts.size,running:!!depthJob,last:lastDepthProbe},
      checks:collectiveWireState?.checks||[],records,retained:records.length,filled:records.filter(r=>r.status==='filled').length,
      note:`保留最近 200 个独立信号；触发不等于成交。延迟从本地首次检测或源事件计算；未检测时段未知。收益见分路线复盘；${POOL_FIRST_THREE_POLICY.coverageNote}`};
  }
  const charts = new Map();
  const chartJobs = new Map(), quotes = new Map(), quoteAttempts = new Map();
  // Three-list discovery owns the normal read seats. Exploratory chart/detail
  // work has one shared, queue-free producer slot; exits/confirmed entries do
  // not use it. The account gate still owns actual concurrency and pacing.
  const exploratoryChartKeys=new Set();
  let lastExploratoryKind=null,exploratoryDetailDeferrals=0,exploratoryChartDeferrals=0;
  let exploratoryChartDemand=null,chartTurnDeferrals=0;
  let chartsSinceDetail=0,hotDeadlineDeferrals=0,hotWatch=new Map(),hotWatchRows=[];
  const detailGapRetries=new Map();
  const quoteHistories = new Map();
  const unavailable = { status: 'unavailable', tokens: [], observedAt: null };
  const marketSnapshots = new Map(chains.map(value => [value, Array.from({length:3}, () => ({status:'loading',tokens:[],observedAt:null,reason:'not_requested'}))]));
  const focusedFeedAttempts=new Map();
  const listedForEntry=token=>!focusedDiscovery||focusedMembership(marketSnapshots.get(token.chain)||[],token.chain,now()).has(keyOf(token));
  // A current canonical pool signal is a bounded discovery exception, never
  // list membership or a persistent CA allowlist. Rebuild on every evidence
  // read; missing/disabled/conflicting/consumed evidence removes permission.
  let poolDiscoverySignals=new Map(),poolEvidenceSequence=0;
  function installPoolWire(evidence,nowMs,research) {
    const wire=buildPoolFirstThreeWire({events:lossRepairMode&&estimatedFeeMode?evidence.events||[]:[],
      account,sourceHealth:evidence.poolSourceHealth,launchSourceHealth:evidence.launchSourceHealth,nowMs});
    const sequence=researchSequences.get(research)||0;
    // An older queued quote/broad read cannot restore permission after a newer
    // event read removed, disabled or quarantined the source proof.
    if(sequence>=poolEvidenceSequence) {
      poolEvidenceSequence=sequence;
      poolDiscoverySignals=new Map(wire.signals.filter(s=>scanChains.includes(s.chain)
        &&validPoolSignal(s,s,nowMs)&&poolEntryAllowed(s,account,nowMs)).slice(0,64).map(s=>[keyOf(s),s]));
    }
    return wire;
  }
  const poolDiscoverySignal=token=>{
    if(!lossRepairMode||!estimatedFeeMode||!scanChains.includes(token.chain))return null;
    const signal=poolDiscoverySignals.get(keyOf(token));
    return validPoolSignal(signal,token,now())&&poolEntryAllowed(signal,account,now())?signal:null;
  };
  const poolEntryRow=row=>{
    const signal=row.evidence?.opportunity?.event,current=poolDiscoverySignal(row.token);
    return !!current&&row.evidence?.opportunity?.id==='monitored_event'
      &&row.evidence.opportunity.basis==='monitored_event'&&row.evidence.opportunity.signalId===current.id
      &&signal?.id===current.id&&validPoolSignal(signal,row.token,now())
      &&JSON.stringify(signal.poolEvent)===JSON.stringify(current.poolEvent);
  };
  // A validated live wallet signal can request bounded stage/safety research
  // off-list. Unknown stages never gain buy permission; external tokens still
  // use the three lists. This is not a persistent backlog or an allowlist.
  const walletDiscoverySignal=token=>{
    if(!lossRepairMode||!estimatedFeeMode||token.chain!=='bsc'||!scanChains.includes('bsc'))return null;
    const detail=details.get(keyOf(token)),known=detail?.status==='ok'&&fresh(detail.observedAt,now())?detail.token:token;
    if(known?.stageConflict||known?.marketStage==='external')return null;
    return collectiveWireState?.signals.find(s=>keyOf(s)===keyOf(token)&&fresh(s.sourceAt,now(),30000)
      &&fresh(s.sourceObservedAt,now(),30000))||null;
  };
  const canResearchEntry=token=>listedForEntry(token)||!!walletDiscoverySignal(token)||!!poolDiscoverySignal(token);
  const canEnterRow=row=>listedForEntry(row.token)||poolEntryRow(row)||['internal','near_completion'].includes(row.evidence?.marketStage)
    &&row.evidence?.opportunity?.basis==='wallet_signal'&&walletDiscoverySignal(row.token)?.id===row.evidence.collectiveSignal?.id
    &&validCollectiveSignal(row.evidence.collectiveSignal,row.token,now());
  let marketOffset = 0, refreshJob = null, refreshTimer, quoteTimer, fastCycle = null;
  const marketJobs = new Map();
  const marketLaneLimit = () => higherFrequencyResearch ? Math.min(2, gmgnReadonlyPolicy(dataDir).normalConcurrency) : 1;
  const quoteJobs = new Map();
  let auxiliaryOffset = 0, lastFastStartedAt = null, lastExitStartedAt = null;
  const auxiliaryJobs=new Map();
  const auxiliaryLaneLimit=()=>higherFrequencyResearch?Math.min(2,gmgnReadonlyPolicy(dataDir).normalConcurrency):1;
  const minuteRefreshFloor=()=>focusedDiscovery?FOCUSED_REFRESH_MS:higherFrequencyResearch&&memeExitMode?30000:0;
  const auxiliaryAttempts = new Map();
  let quoteEvaluationJob = null, quoteEvaluationRequest = null, quoteTriggeredEvaluations = 0;
  const readyQuoteEvaluations = new Map(), quotePreparationJobs = new Set();
  let cooperativeQuoteEvaluations = 0, quoteQueueReplacements = 0;
  const readyEventEvaluations=new Map(),eventSeen=new Map(),eventInterest=new Map(),eventQuoteTargets=new Map();
  let eventTimer,eventRefreshJob=null,eventChecks=0,eventEvaluations=0,eventQueueDropped=0,lastEventEvaluation=null,lastEventRefreshAt=null;
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
  const chartDispatches={holding:0,entry:0,hot:0,wallet:0,discovery:0,proactive:0};
  let entryFocus = null, hotQuoteLease = null;
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
  let narrativeAcademyMemory = null, narrativeAcademyState = null, lastNarrativeAcademyAt = 0;
  let narrativeSourceTargets = [];
  let narrativeLearningJob = null, lastNarrativeLearningRequest = null;
  const narrativeLearningMarks = new Map();
  const narrativeSourceObservations = new Map();
  let publicState = { status: 'loading', strategyVersion: STRATEGY_ANALYSIS_VERSION, entryPolicyVersion: PAPER_ENTRY_POLICY_VERSION, entryMode: minimalEntryMode ? 'minimal_hard_safety_v1' : confirmedMode ? CONFIRMED_PAPER_VERSION : diagnosticMode ? PAPER_DIAGNOSTIC_ENTRY_VERSION : allowExploratory ? 'standard_and_exploratory' : 'standard', minimalEntryMode, exitPolicy: exitProfile ? clone(exitProfile) : null, mode: 'paper', execution: false, signing: false, broadcast: false, enabled, chain, chains, learningChain: chain, updatedAt: null,
    session: session && clone(session), operatingPolicy: paperOperatingPolicy(continuousPaperMode, enforceLossGuards), lossGuards: lossRepairMode ? { enforced: enforceLossGuards, threshold: enforceLossGuards ? 'daily_or_round_10_percent' : null, newEntriesStop: enforceLossGuards } : { enforced: !continuousPaperMode, threshold: !continuousPaperMode ? 'daily_10_percent' : null, newEntriesStop: !continuousPaperMode }, newLaunchPolicy:lossRepairMode?{...LAUNCH_POLICY}:null, evidenceGapExitMode, opportunityMode:opportunityMode ? OPPORTUNITY_VERSION : null, auxiliaryAuditPolicy: !confirmedMode && allowExploratory && pvpMode ? PAPER_AUX_AUDIT_VERSION : 'strict_fields_v1',
    lastError: null, account: null, strategies: STRATEGY_POLICIES.map(p => ({ ...p, decision: '观察', eligibleCount: 0, observedCount: 0, reasons: ['等待首轮真实数据'], candidate: null })), coverage: {}, evaluations: [], pollIntervalMs: intervalMs,
    costModel: estimatedFeeMode ? ESTIMATED_COST_TEXT : lossRepairMode ? LOSS_REPAIR_TEXT : chainGasAccounting ? '主盘新仓 Gas 取近期链上 swap 实付费用样本，扣账但不因 Gas 高拒绝入场；费用样本不是本订单实际费用，平台费/滑点仍为模型。旧仓及对照盘保留原成本口径' : '费用、滑点及 gas 按模型估算；非实际成交报价', accountNote: session ? '独立虚拟实验；历史亏损账本单独保留，不合并成绩或自动补款' : '独立的服务端 100 美元模拟账户；旧浏览器账户只读保留',
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
        if((stored.account?.estimatedCostModel===ESTIMATED_COST_VERSION)!==estimatedFeeMode)throw new Error('估算成本账户身份不匹配');
        // The pure ledger validates the full stored account before advancing.
        account = advancePaperStrategyAccount(stored.account, { enabled: false, nowMs: now(), confirmedMode, continuousPaperMode, opportunityMode, memeExitMode, recoveryMode, lossRepairMode, enforceLossGuards, estimatedFeeMode, evidenceGapExitMode });
        enabled = stored.enabled && (!lossRepairMode || estimatedFeeMode) && account.stats.dailyLossGuard !== true;
        if(Array.isArray(stored.algorithmSignalJournal))algorithmSignalJournal=stored.algorithmSignalJournal.filter(r=>
          r&&typeof r.id==='string'&&r.chain==='bsc'&&gmgnFlowAddress('bsc',r.address)===r.address
          &&['collective_smart_money','prequalified_wallet','internal_burst','onchain_internal_burst','new_pool_first_three'].includes(r.source)&&Number.isFinite(Date.parse(r.sourceAt))
          &&Number.isFinite(Date.parse(r.firstDetectedAt))).slice(-200);
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
        if (stored.narrativeAcademyMemory != null) {
          narrativeAcademyMemory = stored.narrativeAcademyMemory;
          if (!validNarrativeAcademy(narrativeAcademyMemory)) narrativeAcademyState = { error: '事件案例记忆异常，保留原记录；仅暂停此学习模块' };
        }
      } else {
        if (session) throw new Error('独立实验账本缺失，禁止自动补款或重建');
        account = createPaperStrategyAccount({ initialCash: 100, nowMs: now() });
        await atomicWrite(stateFile, { schema: 'yesp_atm_runtime_v1', chain, chains, enabled, account });
      }
      if(opportunityMode && !estimatedFeeMode && !reviewComparison) reviewComparison=createReviewComparison(account,now());
      if (thesisExitExperiment && !exitComparison) exitComparison = createExitComparison(account, now());
      if (activeEntrySampling) exitComparison = activateExitEntrySampling(exitComparison, now());
      if (tradeReviewEvery && tradeCountReview == null) tradeCountReview = createTradeReview(account,now());
      await focusShadowStore?.initialize();
      await focusSimulator?.initialize();
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
    const active=['hot','holding','entry','wallet'].includes(token.researchLane);
    if (!chartRefreshDue(cached,nowMs,{active})) return cached;
    if (chartJobs.has(key)) return chartJobs.get(key);
    const exploratory=focusedDiscovery && token.purpose!=='exit' && token.researchLane!=='entry';
    if(exploratory&&(detailJob||exploratoryChartKeys.size)) {exploratoryChartDeferrals++;return cached||{};}
    if(exploratory){exploratoryChartKeys.add(key);lastExploratoryKind='chart';chartsSinceDetail=Math.min(2,chartsSinceDetail+1);}
    const job = loadChart(token, nowMs).finally(() => {
      chartJobs.delete(key);exploratoryChartKeys.delete(key);
      // Give due details the next turn after a chart. No persistent CA queue:
      // refreshDetails rechecks current membership, safety and due times.
      if(exploratory&&started&&!stopped)void refreshDetails();
    });
    chartJobs.set(key, job); return job;
  }

  async function loadChart(token, nowMs) {
    const key = keyOf(token);
    const to = Math.floor(nowMs / 60_000) * 60;
    let result;
    try { result = await market.kline({ chain: token.chain, address: token.address, resolution: '1m', from: to - 3600, to, latestClosed:true,
      purpose: token.researchLane === 'entry' ? 'entry_confirmation' : token.purpose==='exit' ? 'exit'
        : focusedDiscovery ? 'research' : token.purpose || 'candidate' }); }
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
    if(item.status==='ok')requestEventRecheck(token,'chart_ready');
    return item;
  }

  function publishMarket(currentChain, index, result) {
    if (stopped) return;
    const snapshots = [...marketSnapshots.get(currentChain)];
    const prior = snapshots[index];
    // A failed refresh can retain old data only as explicitly stale, with its
    // original timestamp. It must not look like a newly observed price.
    snapshots[index] = result?.status === 'ok' || result?.status === 'stale' ? result
      : prior?.tokens?.length ? { ...prior, status: 'stale', reason:result?.reason || result?.reasonCode || 'fetch_failed' }
        : { ...unavailable, reason:result?.reason || result?.reasonCode || 'fetch_failed' };
    marketSnapshots.set(currentChain, snapshots);
    lastMarketRefreshAt = now();
  }

  function focusedEntry() {
    if (!enabled || !entryFocus?.active || now() >= entryFocus.until || now() < entryFocus.since) return null;
    return quoteTargets.find(t => keyOf(t) === entryFocus.key && !t.researchOnly) || null;
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
    if(focusedDiscovery)return Promise.resolve();
    if (stopped || auxiliaryJobs.size>=auxiliaryLaneLimit() || marketRefreshCounts.size < scanChains.length) return Promise.resolve();
    if (focusedEntry()) { researchDeferrals.auxiliary++; return Promise.resolve(); }
    // One auxiliary request on Free, up to two on Plus, sharing the existing
    // account gate. Use elapsed time, not accelerated tick counts.
    const feeds = scanChains.flatMap(currentChain => [
      { chain: currentChain, index: 1, interval: 60_000 },
      // The 1h ranking is a volume window, not a five-minute cache license:
      // its exclusive candidates still require <=120s market observations.
      ...(opportunityMode ? [{ chain: currentChain, index: 2, interval: 60_000 }] : []),
    ]);
    let selected;
    for (let i = 0; i < feeds.length; i++) {
      const feed = feeds[auxiliaryOffset++ % feeds.length];
      if (!auxiliaryJobs.has(`${feed.chain}:${feed.index}`)
        && now() - (auxiliaryAttempts.get(`${feed.chain}:${feed.index}`) ?? -Infinity) >= feed.interval) { selected = feed; break; }
    }
    if (!selected) return Promise.resolve();
    const { chain: currentChain, index } = selected;
    auxiliaryAttempts.set(`${currentChain}:${index}`, now());
    const feedKey=`${currentChain}:${index}`;
    const job = Promise.resolve().then(() => index === 2
      ? market.trending({ chain: currentChain, interval: '1h', limit: 50, purpose: higherFrequencyResearch ? 'scan' : 'research' })
      : typeof market.trenches === 'function' ? market.trenches({ chain: currentChain, limit: 20, purpose: higherFrequencyResearch ? 'scan' : 'research' }) : unavailable)
      .catch(() => unavailable).then(result => publishMarket(currentChain, index, result))
      .finally(() => {
        auxiliaryJobs.delete(feedKey);
        // Drain due feeds directly, not only when another minute request
        // happens to finish. Still bounded auxiliary requests, with per-feed
        // attempt pacing, entry-focus yielding and the shared account gate.
        if (!stopped) void refreshAuxiliaryMarket();
      });
    auxiliaryJobs.set(feedKey,job);
    // Fill a second slot only when the existing account plan permits it.
    // No duplicate source, unbounded queue or bypass of the shared rate gate.
    if(auxiliaryJobs.size<auxiliaryLaneLimit())void refreshAuxiliaryMarket();
    return job;
  }

  function refreshMarket({ background = false } = {}) {
    if (stopped) return Promise.resolve();
    if(focusedDiscovery)return refreshFocusedMarket({background});
    if (refreshJob) return refreshJob;
    if (background && memeExitMode && focusedEntry()) { researchDeferrals.discovery++; return Promise.resolve(); }
    if (marketJobs.size >= marketLaneLimit()) return background ? Promise.resolve() : Promise.allSettled([...marketJobs.values()]);
    let currentChain;
    for (let i = 0; i < scanChains.length; i++) {
      const candidate = scanChains[marketOffset++ % scanChains.length];
      const snapshot=marketSnapshots.get(candidate)[0];
      if (!marketJobs.has(candidate) && (!background||snapshot.status!=='ok'
        ||!fresh(snapshot.observedAt,now())||now()-stamp(snapshot.observedAt)>=minuteRefreshFloor())) { currentChain = candidate; break; }
    }
    if (!currentChain) {void refreshAuxiliaryMarket();return Promise.resolve();}
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
    const job = Promise.allSettled(jobs.map(j => Promise.resolve().then(j.run).catch(() => unavailable)
      .then(result => publishMarket(currentChain, j.index, result))))
      .finally(() => { marketJobs.delete(currentChain); if (!background) refreshJob = null;
        if (background && !stopped) void refreshAuxiliaryMarket(); });
    marketJobs.set(currentChain, job);
    if (!background) refreshJob = job;
    return job;
  }

  async function refreshFocusedMarket({background}) {
    if(stopped)return;
    const feeds=scanChains.flatMap(chain=>[1,0].map(index=>({chain,index,key:`${chain}:${index}`})));
    const dispatch=feed=>{
      if(stopped)return Promise.resolve();
      if(marketJobs.has(feed.key))return marketJobs.get(feed.key);
      lastMarketRefreshStartedAt=now();focusedFeedAttempts.set(feed.key,now());
      const job=Promise.resolve().then(()=>feed.index===1
        ? market.trenches?.({chain:feed.chain,types:[...FOCUSED_TRENCHES],limit:20,purpose:'scan'})||unavailable
        : market.trending({chain:feed.chain,interval:'5m',limit:50,purpose:'scan'}))
        .catch(()=>unavailable).then(result=>publishMarket(feed.chain,feed.index,result))
        .finally(()=>{marketJobs.delete(feed.key);if(background&&!stopped)void refreshFocusedMarket({background:true});});
      marketJobs.set(feed.key,job);return job;
    };
    if(!background){
      // Manual/test cycle keeps its complete-feed contract; share in-flight
      // background reads rather than issuing duplicate list requests.
      for(const feed of feeds){if(stopped)return;
        if(!marketJobs.has(feed.key)&&marketJobs.size>=marketLaneLimit())await Promise.allSettled([...marketJobs.values()]);
        await dispatch(feed);
      }
      return;
    }
    const due=feeds.filter(f=>!marketJobs.has(f.key)&&now()-(focusedFeedAttempts.get(f.key)??-Infinity)>=FOCUSED_REFRESH_MS)
      .sort((a,b)=>(focusedFeedAttempts.get(a.key)??-Infinity)-(focusedFeedAttempts.get(b.key)??-Infinity));
    const jobs=[];
    for(const feed of due){if(marketJobs.size>=marketLaneLimit())break;jobs.push(dispatch(feed));}
    await Promise.allSettled(jobs);
  }

  function refreshDetails() {
    if (stopped || typeof market.details !== 'function') return Promise.resolve();
    if (detailJob) return detailJob;
    // Completion events cannot steal the next ordinary chart turn. Revalidate
    // the short-lived scan reservation; never create a persistent CA queue.
    const signalPending=detailTargets.some(t=>walletDiscoverySignal(t)||poolDiscoverySignal(t));
    if(focusedDiscovery && !signalPending && hotDeadlineReservation()) {
      hotDeadlineDeferrals++;return Promise.resolve();
    }
    if(focusedDiscovery && !signalPending && waitsForChartTurn({lastKind:lastExploratoryKind,demand:exploratoryChartDemand,nowMs:now(),
      listed:exploratoryChartDemand&&listedForEntry(exploratoryChartDemand.token),
      due:exploratoryChartDemand&&chartRefreshDue(charts.get(keyOf(exploratoryChartDemand.token)),now(),{active:true})})) {
      chartTurnDeferrals++;return Promise.resolve();
    }
    const freshAlpha=t=>Number.isFinite(t.alphaListingTime)&&t.alphaListingTime<=now()&&now()-t.alphaListingTime<=300000;
    const freshMonitor=t=>fresh(t.monitorSourceAt,now());
    const unseenNews=detailTargets.some(t=>(fresh(t.newsSourceAt,now())||freshAlpha(t)||freshMonitor(t)||fresh(t.walletBuyAt,now()))&&!details.has(keyOf(t)));
    if (lastDetailStart !== null && now() - lastDetailStart < (unseenNews?1000:10_000)) return Promise.resolve();
    // Never add research work while a live paper holding lacks its exit quote.
    if (fastQuotes && (recoveryMode?Object.values(account?.positions||{}):heldTokens()).some(token => !recentQuote(token, now()))) return Promise.resolve();
    // Two priority dispatches then one fair chain rotation. Near-entry refresh
    // must not wait behind every unknown token; discovery must not starve either.
    const focus = focusedEntry();
    const due = detailTargets.filter(token => canResearchEntry(token)
      && (!focusedDiscovery || now() >= (detailGapRetries.get(keyOf(token))?.nextAttemptAt ?? 0))
      && (!focus || keyOf(token) === keyOf(focus) || freshAlpha(token) || freshMonitor(token) || walletDiscoverySignal(token))
      && (!details.has(keyOf(token)) || now() - details.get(keyOf(token)).fetchedAt >=
        (['GMGN_QUEUE_EXPIRED','GMGN_REQUEST_BUSY'].includes(details.get(keyOf(token)).reasonCode)?5000:token.refreshAfterMs)));
    if (focus && !due.length) researchDeferrals.details++;
    const priority = Math.max(0, ...due.map(token => token.researchPriority));
    const pool = detailDispatchCount % 3 === 2 ? due : due.filter(token => token.researchPriority === priority);
    let selected;
    for (let i = 0; i < scanChains.length && !selected; i++) {
      const currentChain = scanChains[detailChainOffset++ % scanChains.length];
      selected = pool.filter(token => token.chain === currentChain)
        .sort((a, b) => (details.get(keyOf(a))?.fetchedAt ?? 0) - (details.get(keyOf(b))?.fetchedAt ?? 0))[0];
    }
    if (!selected) return Promise.resolve();
    const signalFast=!!(walletDiscoverySignal(selected)||poolDiscoverySignal(selected));
    if(focusedDiscovery&&!signalFast&&exploratoryChartKeys.size){exploratoryDetailDeferrals++;return Promise.resolve();}
    const key = keyOf(selected); lastDetailStart = now(); detailDispatchCount += 1;
    if(focusedDiscovery&&!signalFast){lastExploratoryKind='details';chartsSinceDetail=0;}
    lastDetail = { chain: selected.chain, address: selected.address, symbol: selected.symbol, reason: selected.researchReason,
      startedAt: new Date(lastDetailStart).toISOString(), status: 'pending', priority: selected.researchPriority };
    detailJob = Promise.resolve().then(() => market.details(focusedDiscovery&&!signalFast?{...selected,purpose:'research'}:selected)).catch(() => ({ status: 'unavailable' })).then(result => {
      if (stopped) return;
      const bound = result?.token?.chain === selected.chain && gmgnFlowAddress(selected.chain, result?.token?.address) === gmgnFlowAddress(selected.chain, selected.address);
      details.set(key, { ...(bound ? result : { status: 'unavailable' }), fetchedAt: now() });
      const success = bound && result.status === 'ok' && fresh(result.observedAt, now());
      if (success) detailsSucceeded += 1;
      if(focusedDiscovery && success) {
        const retry=detailGapRetry(detailGapRetries.get(key),missingRequestedDetailFields(result.token,selected.requestedFields),now());
        if(retry)detailGapRetries.set(key,retry);else detailGapRetries.delete(key);
        if(detailGapRetries.size>200)detailGapRetries.delete(detailGapRetries.keys().next().value);
      }
      lastDetail = { ...lastDetail, status: success ? 'ok' : 'unavailable', finishedAt: new Date(now()).toISOString(),
        observedAt: bound ? result.observedAt || null : null, reasonCode: result?.reasonCode || null };
      if (details.size > 200) details.delete(details.keys().next().value);
      if(success)requestEventRecheck(selected,'details_ready');
    }).finally(() => { detailJob = null; });
    return detailJob;
  }

  function hotDeadlineReservation() {
    const at=now();
    if(chartsSinceDetail>=2 || focusedEntry())return false;
    return hotWatchRows.some(row=>{
      const token={...row.input.token,researchLane:'hot'},chart=charts.get(keyOf(token));
      if(!hotWatchEligible(row,at)||chartJobs.has(keyOf(token)))return false;
      const window=opportunityChart(chart?.candles,chart?.status,at,{contiguousTail:memeExitMode});
      if(!['ready','stale_closed_bars'].includes(window.diagnostics.code))return false;
      return reserveHotChartTurn({demand:{token,selectedAt:at,closedAtMs:window.diagnostics.lastClosedAtMs},nowMs:at,
        listed:listedForEntry(token),due:chartRefreshDue(chart,at,{active:true}),chartsSinceDetail});
    });
  }

  function quoteLaneLimits() {
    const total = Math.min(3, gmgnReadonlyPolicy(dataDir).concurrency);
    const reserveCandidate=!recoveryMode||enabled&&quoteTargets.some(t=>t.purpose==='candidate'&&t.candidateBook==='main');
    return { total, exit: total > 1 && reserveCandidate ? total - 1 : total, candidate: 1 };
  }

  const comparisonQuote=t=>recoveryMode&&(t.candidateBook==='comparison'||t.holdingTier==='comparison'&&t.candidateBook!=='main');
  const quoteJobPurpose=t=>t.purpose==='exit'||comparisonQuote(t)?'exit':'candidate';
  function admitCandidate(targets,token) {
    if(!canResearchEntry(token))return;
    const held=targets.get(keyOf(token));
    // A control lot in the same CA may share the new quote, but must not
    // downgrade a main entry into a once-per-minute comparison mark.
    if(!held||recoveryMode&&token.candidateBook==='main'&&held.holdingTier==='comparison')
      targets.set(keyOf(token),token);
  }

  function refreshQuote() {
    const targets = new Map(heldTokens().map(token => [keyOf(token), { ...token, purpose: 'exit' }]));
    for (const token of quoteTargets) if (token.purpose !== 'exit' && (!recoveryMode||enabled)) admitCandidate(targets,token);
    for(const [key,target] of eventQuoteTargets) {
      if(now()>target.until || account?.positions?.[key] || !canResearchEntry(target.token))eventQuoteTargets.delete(key);
      else if(enabled)admitCandidate(targets,target.token);
    }
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
      dispatchQuote(selectQuoteTarget(available,quotes,quoteAttempts,now(),{quoteProgress:quoteHistories}));
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
      ...(purpose==='candidate' && recoveryMode && !token.researchOnly ? {purpose:'entry_confirmation'} : {}),
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
    const target = narrativeLearningTargets.find(t => scanChains.includes(t.chain) && (listedForEntry(t)||account?.positions?.[keyOf(t)]) && t.dueAt <= now() && now() <= t.deadline);
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

  function requestQuoteEvaluation(token,{evidenceChanged=false}={}) {
    const key = keyOf(token), quote = quotes.get(key);
    if(!quote)return;
    const usable = () => {
      const at = stamp(quotes.get(key)?.observedAt);
      return enabled && canResearchEntry(token) && quotes.get(key)?.observedAt===quote.observedAt && quotes.get(key)?.price===quote.price
        && recentQuote(token, now()) && now() - at <= (pvpMode ? PVP_EXIT_POLICY.entryQuoteMaxAgeMs : 15_000);
    };
    if (stopped || !usable() || !evidenceChanged && evaluatedQuoteTimes.get(key) === quote.observedAt) return;
    evaluatedQuoteTimes.set(key, quote.observedAt);
    if (evaluatedQuoteTimes.size > 100) evaluatedQuoteTimes.delete(evaluatedQuoteTimes.keys().next().value);
    if(recoveryMode) {
      const request={usable,chain:token.chain,address:token.address,quoteObservedAt:quote.observedAt,receivedAt:now()};
      // Read current evidence outside the writer. A missing source remains
      // missing; never fall back to a previously healthy scan to force a fill.
      const preparation=loadResearch({isolated:true}).then(research=>{
        if(stopped || evaluatedQuoteTimes.get(key)!==request.quoteObservedAt)return;
        request.preparedAt=now();request.evidenceReadMs=request.preparedAt-request.receivedAt;
        if(readyQuoteEvaluations.has(key))quoteQueueReplacements++;
        readyQuoteEvaluations.set(key,{request,research});
        if(readyQuoteEvaluations.size>64)readyQuoteEvaluations.delete(readyQuoteEvaluations.keys().next().value);
        pumpQuoteEvaluations();
      }).catch(errorState).finally(()=>quotePreparationJobs.delete(preparation));
      quotePreparationJobs.add(preparation);
      return;
    }
    quoteEvaluationRequest = { usable,chain:token.chain,address:token.address,quoteObservedAt:quote.observedAt,receivedAt:now() };
    if (quoteEvaluationJob) return;
    // A quote may arrive after an in-flight cycle has already evaluated inputs.
    // Drain that cycle, then re-read evidence and evaluate under the same writer
    // queue. Never delay the independent exit path or manufacture a fresh stamp.
    quoteEvaluationJob = Promise.resolve().then(async () => {
      while (!stopped && quoteEvaluationRequest) {
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

  function pumpQuoteEvaluations() {
    if(stopped || quoteEvaluationJob)return;
    quoteEvaluationJob=Promise.resolve().then(async()=>{
      while(!stopped && (readyQuoteEvaluations.size||readyEventEvaluations.size))await serial(()=>drainQuoteEvaluation(false));
    }).catch(errorState).finally(()=>{quoteEvaluationJob=null;if(!stopped&&(readyQuoteEvaluations.size||readyEventEvaluations.size))pumpQuoteEvaluations();});
  }

  function enqueueEvent(request,research) {
    if(stopped||!canResearchEntry(request))return;
    const key=keyOf(request);
    readyEventEvaluations.set(key,{request:{...request,kind:'event'},research});
    if(readyEventEvaluations.size>64){readyEventEvaluations.delete(readyEventEvaluations.keys().next().value);eventQueueDropped++;}
    pumpQuoteEvaluations();
  }

  function requestEventRecheck(token,source) {
    if(!started||stopped||!recoveryMode||!estimatedFeeMode||!scanChains.includes(token.chain)||!canResearchEntry(token))return;
    const prior=eventInterest.get(keyOf(token));
    const interest=prior&&now()-Date.parse(prior.sourceAt)<=120000?prior:{chain:token.chain,address:token.address,
      source:'research_update',sourceAt:new Date(now()).toISOString(),sourceObservedAt:null};
    // A completed detail/chart is a data-availability notification, NOT a new
    // tweet, profitable-wallet event or renewed market-data timestamp.
    const preparation=loadResearch({lane:'events'}).then(research=>enqueueEvent({...interest,trigger:source,receivedAt:now()},research))
      .catch(errorState).finally(()=>quotePreparationJobs.delete(preparation));
    quotePreparationJobs.add(preparation);
  }

  function refreshEvents() {
    if(stopped||!recoveryMode||!estimatedFeeMode)return Promise.resolve();
    if(eventRefreshJob)return eventRefreshJob;
    if(internalTradeMonitor&&lossRepairMode&&scanChains.includes('bsc')) {
      const holdings=heldTokens().filter(p=>p.entryEvidence?.collectiveSignal?.version===ONCHAIN_BURST_VERSION)
        .map(p=>({...p,held:true,platform:p.entryEvidence.collectiveSignal.proof.window.platform,
          marketStage:p.entryEvidence.marketStage||'internal'}));
      // Single-flight monitor has its own bounded cadence. Do not await RPC
      // here or block local events, quote exits, GMGN/X or Telegram monitoring.
      void internalTradeMonitor.refresh({tokens:[...holdings,...internalTradeTargets],
        exitPending:heldTokens().some(p=>!recentQuote(p,now()))}).catch(()=>{});
    }
    // Separate local evidence pump; it neither calls a provider nor owns the
    // ledger lock. Slow research and broad scans cannot stop event discovery.
    eventRefreshJob=loadResearch({lane:'events'}).then(research=>{
      if(stopped)return;
      lastEventRefreshAt=now();eventChecks++;
      const evidence=withLearningEvidence(research),allowPrequalified=lossRepairMode&&estimatedFeeMode;
      collectiveWireState=buildCollectiveWire({state:evidence.flowState,onchainState:evidence.innerTradeState,account,nowMs:now(),allowPrequalified,allowBurst:allowPrequalified});
      installPoolWire(evidence,now(),research);
      const triggers=paperEventTriggers({evidence,account,chains:scanChains,nowMs:now(),allowPrequalified,allowBurst:allowPrequalified});
      let admitted=0;
      for(const trigger of triggers) {
        if(!canResearchEntry(trigger))continue;
        const event={...trigger,firstDetectedAt:new Date(now()).toISOString()};
        if(eventSeen.has(event.id)||admitted>=16)continue;
        eventSeen.set(event.id,now());admitted++;
        eventInterest.set(keyOf(event),event);
        enqueueEvent({...event,trigger:event.source,receivedAt:now()},research);
      }
      for(const [id,at] of eventSeen)if(now()-at>300000)eventSeen.delete(id);
      for(const [key,event] of eventInterest)if(now()-Date.parse(event.sourceAt)>120000)eventInterest.delete(key);
      while(eventSeen.size>2000)eventSeen.delete(eventSeen.keys().next().value);
      while(eventInterest.size>128)eventInterest.delete(eventInterest.keys().next().value);
    }).catch(errorState).finally(()=>{eventRefreshJob=null;});
    return eventRefreshJob;
  }

  // Called ONLY by the current writer: either a short queued task or a broad
  // scan's pure-work checkpoint. Never interrupt an uncommitted ledger write.
  async function drainQuoteEvaluation(cooperative) {
    if(stopped)return;
    // Entry acceleration never jumps ahead of exits for held assets. Both
    // paths are still executed by this same writer; the queued exit is safe
    // to recheck later against the then-current account.
    if(cooperative && (readyQuoteEvaluations.size||readyEventEvaluations.size) && heldTokens().length)
      await performExitCheck();
    if(!readyQuoteEvaluations.size) {
      if(!readyEventEvaluations.size)return;
      const [key,{request,research}]=readyEventEvaluations.entries().next().value;
      readyEventEvaluations.delete(key);
      if(enabled && now()-Date.parse(request.sourceAt)<=120000)
        await performCycle({background:true,research,quoteRequest:request});
      return;
    }
    const [key,{request,research}]=readyQuoteEvaluations.entries().next().value;
    readyQuoteEvaluations.delete(key);
    request.writerAdmittedAt=now();request.writerWaitMs=request.writerAdmittedAt-request.preparedAt;
    if(!request.usable() || quotes.get(key)?.observedAt!==request.quoteObservedAt) {
      lastCandidateEvaluation={chain:request.chain,address:request.address,at:new Date(now()).toISOString(),
        quoteObservedAt:request.quoteObservedAt,evaluatedPriceObservedAt:null,mode:'targeted_main_quote_v1',decision:'观察',reasons:[],
        missing:[enabled?'报价在证据读取或写入排队期间过期、或已被更新':'新开仓已暂停'],
        quoteAgeAtDecisionMs:now()-stamp(request.quoteObservedAt),receivedToDecisionMs:now()-request.receivedAt,newFills:0};
      Object.assign(lastCandidateEvaluation,{evidenceReadMs:request.evidenceReadMs,writerWaitMs:request.writerWaitMs});
      publicState={...publicState,cadence:{...publicState.cadence,lastCandidateEvaluation}};
      return;
    }
    quoteTriggeredEvaluations++;
    if(cooperative)cooperativeQuoteEvaluations++;
    await performCycle({background:true,research,quoteRequest:request});
  }

  function recentQuote(token, nowMs) {
    const quote = quotes.get(keyOf(token)), at = stamp(quote?.observedAt);
    return quote?.status === 'ok' && Number.isFinite(quote.price) && quote.price > 0 && Number.isFinite(at)
      && at <= nowMs && at >= nowMs - 15_000 ? quote : null;
  }

  function priced(item, nowMs) {
    item={...item,lossRepairMode:lossRepairMode&&item.memeExitMode===true&&item.recoveryMode===true};
    item={...item,estimatedFeeMode:estimatedFeeMode&&item.lossRepairMode,enforceLossGuards:item.lossRepairMode&&enforceLossGuards};
    item={...item,internalDepth:internalDepths.get(keyOf(item.token))||null};
    if(chainGasAccounting)item={...item,gasEstimate:item.memeExitMode?gasMonitor.snapshot(item.token.chain):null};
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
    for(const p of focusSimulator?.openPositions()||[]) {
      const key=keyOf(p),prior=holdings.get(key);
      holdings.set(key,{...(prior||p),requiresStructureChart:true,focusPaperPosition:true,
        ...(prior?.holdingTier?{holdingTier:prior.holdingTier}:{holdingTier:'focus_paper'})});
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
    exitJob = serial(performExitCheck).catch(error => {
      publicState = { ...publicState, exitMonitor: { ...publicState.exitMonitor, lastError: '退出检查或账本保存失败，需检查' } };
      throw error;
    }).finally(() => { exitJob = null; });
    return exitJob;
  }

  async function performExitCheck() {
      if (stopped) return;
      await initialize();
      const nowMs = now(), holdings = heldTokens();
      const marksFor = ledger => Object.values(ledger.positions).flatMap(position => {
        const quote = recentQuote(position, nowMs);
        return quote ? [{ ...quote, gasEstimate:chainGasAccounting?gasMonitor.snapshot(position.chain):null, structureChart: holdingChart(position,quote),
          holderSnapshot:holdingChips(position,nowMs),
          narrative: ledger.exitExperimentVersion || position.memeExitPolicy ? buildPaperNarrativeEvidence({ chain: position.chain, address: position.address, token: position, events: latestEvidence.events, nowMs }) : null,
          flow: positionFlow(position,latestEvidence,nowMs) }] : [];
      });
      if(focusSimulator) {
        const focusMarks=focusSimulator.openPositions().map(position=>{
          const quote=recentQuote(position,nowMs);
          return {...position,...(quote||{status:'unavailable'}),chart:quote?holdingChart(position,quote):null};
        });
        await focusSimulator.advance({marks:focusMarks,nowMs});
      }
      if (holdings.length && fastQuotes) {
        const next = advancePaperStrategyAccount(account, { marks: marksFor(account), enabled: false, nowMs, confirmedMode, continuousPaperMode, lossRepairMode, enforceLossGuards, evidenceGapExitMode,
          ...(recoveryMode?{recoveryMode,memeExitMode,opportunityMode}:{}) });
        next.stats.enabled = enabled;
        const pair = learningShadow ? { ...learningShadow,
          control: advancePaperStrategyAccount(learningShadow.control, { marks: marksFor(learningShadow.control), enabled: false, nowMs }),
          student: advancePaperStrategyAccount(learningShadow.student, { marks: marksFor(learningShadow.student), enabled: false, nowMs }) } : null;
        const comparison=reviewComparison ? {...reviewComparison,control:advancePaperStrategyAccount(reviewComparison.control,
          {marks:marksFor(reviewComparison.control),enabled:false,nowMs,confirmedMode:true,continuousPaperMode})} : null;
        const exits = advanceExitComparison(exitComparison, { marksFor, enabled: false, nowMs });
        const nextReview = nextTradeReview(next,nowMs);
        if (lossRepairMode && next.stats.dailyLossGuard) enabled = false;
        next.stats.enabled = enabled;
        await atomicWrite(stateFile, { schema: 'yesp_atm_runtime_v1', session, chain, chains, enabled, account: next, algorithmSignalJournal, learningShadow: pair, narrativeMemory, narrativeLearningMemory, narrativeAcademyMemory, reviewComparison:comparison, exitComparison: exits, tradeCountReview: nextReview });
        tradeCountReview = nextReview;
        exitComparison = exits;
        reviewComparison=comparison;
        account = next; learningShadow = pair;
        publicState = { ...publicState, enabled, account: clone(account), updatedAt: account.updatedAt, tradeCountReview: tradeReviewSummary(tradeCountReview,tradeCountReviewError),
          entryGuard: confirmedMode ? confirmedAccountGate(account, nowMs, null, null, null, { continuousPaperMode, enforceLossGuards }) : null,
          learningComparison: { ...learningShadowSummary(learningShadow), chain },reviewComparison:reviewComparisonSummary(reviewComparison,account), exitComparison: exitComparisonSummary(exitComparison) };
      }
      publicState = { ...publicState, exitMonitor: { running: started && !stopped, intervalMs: 1000,
        lastCheckedAt: new Date(nowMs).toISOString(), checks: ++exitChecks, staleQuotes: heldTokens().filter(p => !recentQuote(p, nowMs)).length,
        entriesEnabled: enabled, lastError: null } };
  }

  const researchJobs=new WeakMap(),researchSequences=new WeakMap();
  let researchSequence=0;
  const loadResearch=options=>{
    const job=researchReader.load(options);
    if(!researchJobs.has(job))researchJobs.set(job,++researchSequence);
    return job.then(research=>{researchSequences.set(research,researchJobs.get(job));return research;});
  };

  async function performQuoteEntry(input, evidence, request) {
    if(stopped || !request.usable())return;
    const startedAt=now(),chart=charts.get(keyOf(request));
    // Same evaluator, admission rules and ledger as the periodic main book;
    // only the requested CA is evaluated. No control/shadow entries here.
    let rows=input ? evaluate({...priced(input,startedAt),nowMs:startedAt,
      candles:chart?.candles||[],klineStatus:chart?.status||'unavailable'}).filter(canEnterRow) : [];
    scheduleInternalDepth(input,rows);
    rows=rows.map(row=>{
      if(row.decision==='可模拟') {
        const gate=confirmedAccountGate(account,startedAt,row.token,row.evidence.confirmedPolicy?.pulse,row.evidence.narrativeRecall,
          {continuousPaperMode, enforceLossGuards, opportunity:row.evidence.opportunity});
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
      return quote?[{...quote,gasEstimate:chainGasAccounting?gasMonitor.snapshot(position.chain):null,structureChart:holdingChart(position,quote),holderSnapshot:holdingChips(position,decisionAt),
        narrative:buildPaperNarrativeEvidence({chain:position.chain,address:position.address,token:position,events:evidence.events,nowMs:decisionAt}),
        flow:positionFlow(position,evidence,decisionAt)}]:[];
    });
    const commitAt=now(),beforeCount=account.trades.length;
    const next=advancePaperStrategyAccount(account,{evaluations:rows,marks,enabled,nowMs:commitAt,
      diagnosticMode,confirmedMode,continuousPaperMode,opportunityMode,memeExitMode,recoveryMode,minimalEntryMode,chainGasAccounting,lossRepairMode,enforceLossGuards,estimatedFeeMode,evidenceGapExitMode});
    if (lossRepairMode && next.stats.dailyLossGuard) enabled = false;
    next.stats.enabled = enabled;
    const nextReview=nextTradeReview(next,commitAt);
    recordAlgorithmDecision(rows,commitAt);
    await atomicWrite(stateFile,{schema:'yesp_atm_runtime_v1',session,chain,chains,enabled,account:next,algorithmSignalJournal,learningShadow,narrativeMemory,
      narrativeLearningMemory,narrativeAcademyMemory,reviewComparison,exitComparison,tradeCountReview:nextReview});
    account=next;tradeCountReview=nextReview;
    const row=rows.find(r=>r.decision==='可模拟')||rows[0];
    lastCandidateEvaluation={chain:request.chain,address:request.address,at:new Date(commitAt).toISOString(),
      quoteObservedAt:request.quoteObservedAt,evaluatedPriceObservedAt:row?.evidence?.priceObservedAt||null,
      decision:row?.decision||'候选已不在当前数据源',reasons:row?.reasons||[],missing:row?.missing||[],
      mode:'targeted_main_quote_v1',quoteAgeAtDecisionMs:commitAt-stamp(request.quoteObservedAt),
      ...(row?.evidence?.newLaunch?{entryLane:row.evidence.newLaunch.version,decisionTargetMs:1000,
        decisionTargetMet:commitAt-request.receivedAt<=1000,sourceToDecisionMs:commitAt-stamp(row.evidence.newLaunch.sourceAt)}:{}),
      ...(row?.evidence?.collectiveSignal?{entryLane:row.evidence.collectiveSignal.version,decisionTargetMs:1000,
        decisionTargetMet:commitAt-request.receivedAt<=1000,sourceToDecisionMs:commitAt-stamp(row.evidence.collectiveSignal.sourceAt)}:{}),
      receivedToDecisionMs:commitAt-request.receivedAt,evaluationMs:commitAt-startedAt,newFills:next.trades.length-beforeCount};
    Object.assign(lastCandidateEvaluation,{evidenceReadMs:request.evidenceReadMs,writerWaitMs:request.writerWaitMs,
      preparationMs:startedAt-request.writerAdmittedAt});
    publicState={...publicState,enabled,account:clone(account),updatedAt:account.updatedAt,
      evaluations:[...(publicState.evaluations||[]).filter(r=>keyOf(r.token)!==keyOf(request)),...rows],
      tradeCountReview:tradeReviewSummary(tradeCountReview,tradeCountReviewError),
      entryGuard:confirmedAccountGate(account,commitAt,null,null,null,{continuousPaperMode, enforceLossGuards}),
      cadence:{...publicState.cadence,quoteEvaluationMode:'targeted_main_quote_v1',quoteTriggeredEvaluations,lastCandidateQuote,lastCandidateEvaluation}};
  }

  function performEventAdmission(input,request) {
    const at=now(),chart=charts.get(keyOf(request));
    const rows=input?evaluate({...priced(input,at),nowMs:at,candles:chart?.candles||[],klineStatus:chart?.status||'unavailable'}):[];
    recordAlgorithmDecision(rows,at);
    const quoteReady=rows.some(readyForPaperQuote)||rows.some(researchReadyForQuote);
    const blocked=!rows.length||rows.every(r=>r.decision==='不买'||r.evidence?.safety?.blocked?.length);
    const plan=planPaperCandidateResearch(rows,input?.observedAt,at);
    if(!blocked&&quoteReady&&enabled) {
      eventQuoteTargets.set(keyOf(request),{token:{...input.token,purpose:'candidate',candidateBook:'main',
        researchOnly:!rows.some(readyForPaperQuote)},until:at+15000});
      if(eventQuoteTargets.size>8)eventQuoteTargets.delete(eventQuoteTargets.keys().next().value);
      // Only this completed-proof notification may re-evaluate an already
      // seen quote. requestQuoteEvaluation still checks its original age,
      // and the single writer rechecks every entry rule before any fill.
      if(started&&request.trigger==='internal_depth_ready')requestQuoteEvaluation(input.token,{evidenceChanged:true});
      if(started)void refreshQuote();
    } else eventQuoteTargets.delete(keyOf(request));
    if(!blocked&&plan.needed) {
      const target={...input.token,purpose:'candidate',researchPriority:3,refreshAfterMs:30000,requestedFields:plan.requestedFields,
        monitorSourceAt:input.monitorSignal?.sourceAt, walletBuyAt:['wallet_buy','collective_smart_money','prequalified_wallet','internal_burst','onchain_internal_burst'].includes(request.source)?request.sourceAt:null,
        researchReason:'新事件定向补证：不等待全市场扫描；补齐后重新判断，不等于买入许可'};
      detailTargets=[target,...detailTargets.filter(t=>keyOf(t)!==keyOf(target))];
      if(started)void refreshDetails();
    }
    eventEvaluations++;
    lastEventEvaluation={chain:request.chain,address:request.address,source:request.source,trigger:request.trigger,
      sourceAt:request.sourceAt,sourceObservedAt:request.sourceObservedAt,at:new Date(at).toISOString(),
      provider:request.provider||null,sourceWindowEndAt:request.sourceWindowEndAt||null,
      sourceSnapshotReceivedAt:request.sourceSnapshotReceivedAt||null,firstDetectedAt:request.firstDetectedAt||null,
      sourceToDetectionMs:request.firstDetectedAt?Date.parse(request.firstDetectedAt)-Date.parse(request.sourceAt):null,
      detectionToEvaluationMs:request.firstDetectedAt?at-Date.parse(request.firstDetectedAt):null,
      receivedToEvaluationMs:at-request.receivedAt,sourceToEvaluationMs:at-Date.parse(request.sourceAt),
      quoteReady,detailsNeeded:!blocked&&plan.needed,decision:quoteReady?'等待真实报价':'观察',
      reasons:rows[0]?.reasons||[],missing:rows[0]?.missing||[],newFills:0};
    publicState={...publicState,cadence:{...publicState.cadence,eventDispatch:eventDispatchSnapshot()}};
  }

  function eventDispatchSnapshot() {
    return {version:'local_event_ca_dispatch_v2',enabled:recoveryMode&&estimatedFeeMode,intervalMs:1000,
      checks:eventChecks,lastCheckedAt:lastEventRefreshAt===null?null:new Date(lastEventRefreshAt).toISOString(),
      evaluations:eventEvaluations,pending:readyEventEvaluations.size,dropped:eventQueueDropped,
      quoteTargets:eventQuoteTargets.size,lastEvaluation:lastEventEvaluation,
      note:'两路资金流分别发现、按 CA 唤醒；覆盖截止时间不等于事件接收时间；不是全链推送或免条件跟买'};
  }

  function discoveryScopeSnapshot() {
    if(!focusedDiscovery)return {version:'all_sources'};
    return {...focusedDiscoverySnapshot(marketSnapshots,scanChains,now()),
      otherSources:'verified_internal_wallet_or_pool_first_three',
      poolSignalDiscovery:{maxCandidates:64,currentCandidates:[...poolDiscoverySignals.values()].filter(poolDiscoverySignal).length,
        requiresCurrentUnconsumedProof:true},
      note:'战壕新创建、即将开盘、已开盘及5分钟热门；榜外仅已核实内盘钱包/逐笔放量，或当前未消费的新模板/新底池首三币信号可有界补证。信号不替代时效、安全、真实报价与模拟账本检查；普通喊单及研究名册不授予资格。TG/FOMO 保持。'};
  }

  async function performCycle({ background = false, research, quoteRequest = null } = {}) {
    if (stopped) return;
    if(quoteRequest&&!scanChains.includes(quoteRequest.chain))return;
    await initialize();
    const [trending, trenches] = marketSnapshots.get(scanChains[0]);
    const currentResearch=research||await loadResearch();
    const { loadedEvidence, learning } = currentResearch;
    const evidence = withLearningEvidence({loadedEvidence,learning});
    const collectiveWire=buildCollectiveWire({state:lossRepairMode&&estimatedFeeMode&&scanChains.includes('bsc')?evidence.flowState:{},
      onchainState:lossRepairMode&&estimatedFeeMode&&scanChains.includes('bsc')?evidence.innerTradeState:null,
      account,nowMs:now(),allowPrequalified:lossRepairMode&&estimatedFeeMode,allowBurst:lossRepairMode&&estimatedFeeMode});
    collectiveWireState=collectiveWire;
    const poolWire=installPoolWire(evidence,now(),currentResearch);
    if(quoteRequest&&!canResearchEntry(quoteRequest))return;
    latestEvidence = evidence;
    const evidenceIndex = createPaperEvidenceIndex(evidence);
    const giveTurn = createCooperativeTurn({ budgetMs: 8, maxOperations: 16 });
    let scanYields = 0, canDrainQuotes = !quoteRequest;
    // Only pure per-candidate work yields; ledger mutation remains serialized.
    const scanMap = async (values, map) => {
      const result = [];
      for (const value of values) {
        const pending = giveTurn();
        if (pending) {
          scanYields++; await pending;
          if(canDrainQuotes && recoveryMode)await drainQuoteEvaluation(true);
        }
        result.push(map(value));
      }
      return result;
    };
    let nowMs = now();
    const tickStartedAt = nowMs;
    const phaseTiming = { newsWireMs: 0, narrativeRecallMs: 0, narrativeLearningMs: 0, casebookMs: 0, ledgerWriteMs: 0 };
    const candidates = new Map(), marketRankObservations = new Map();
    for (const currentChain of scanChains) for (const [index,snapshot] of [...marketSnapshots.get(currentChain).entries()].reverse()) {
      if (!Array.isArray(snapshot?.tokens)) continue;
      for (const token of (focusedDiscovery?focusedListTokens(snapshot,index,nowMs):snapshot.tokens).slice(0, 60)) {
        if (token?.chain !== currentChain || !gmgnFlowAddress(currentChain, token?.address)) continue;
        const key = keyOf(token), prior = candidates.get(key);
        const item = { token, observedAt: snapshot.observedAt, marketStatus: snapshot.status };
        if(['1m','5m','1h'].includes(token.volumeWindow)) {
          const observations=marketRankObservations.get(key)||[];
          observations.push({chain:token.chain,address:token.address,rank:token.rank,volume:token.volume,volumeWindow:token.volumeWindow,
            observedAt:snapshot.observedAt,marketStatus:snapshot.status});
          marketRankObservations.set(key,observations);
        }
        candidates.set(key, mergePaperCandidateSnapshots(prior, item, nowMs));
      }
    }
    const discovered = quoteRequest || focusedDiscovery ? [] : discoverPaperFlowCandidates({ evidence, chains:scanChains, nowMs, evidenceIndex });
    for (const item of discovered) {
      const key = keyOf(item.token);
      if (!candidates.has(key)) candidates.set(key, { token: item.token, observedAt: null, marketStatus: 'unavailable', discoverySource: 'flow' });
    }
    if(!focusedDiscovery&&quoteRequest&&!candidates.has(keyOf(quoteRequest))) {
      const detail=details.get(keyOf(quoteRequest));
      candidates.set(keyOf(quoteRequest),detail?.token?{token:detail.token,observedAt:detail.observedAt,marketStatus:detail.status}:
        {token:{chain:quoteRequest.chain,address:quoteRequest.address},observedAt:null,marketStatus:'unavailable'});
    }
    const newsCandidates=[...candidates.values()].map(item=>{
      const d=details.get(keyOf(item.token));return d?.token?mergePaperCandidateSnapshots(item,
        {token:d.token,observedAt:d.observedAt,marketStatus:d.status,discoverySource:'details'},nowMs):item;
    });
    // An original X document must reach discovery, not only the display index.
    // Retain known CA metadata for topic recall even after leaving the hot list.
    const newsKeys=new Set(newsCandidates.map(item=>keyOf(item.token)));
    for(const [key,d] of [...details].slice(-600))if(!focusedDiscovery&&d?.token&&scanChains.includes(d.token.chain)&&!newsKeys.has(key))
      newsCandidates.push({token:d.token,observedAt:d.observedAt,marketStatus:d.status});
    const twitterNarrative=twitterNarrativeSnapshot();
    const newsWireStartedAt=now();
    const newsWire=buildPaperNewsWire({gmgn:evidence.gmgnSocial,events:evidence.events,twitterDocuments:twitterNarrative?.documents||[],
      anchorDocuments:historicalTwitterAnchors(narrativeLearningMemory?.episodes,nowMs),
      candidates:newsCandidates.filter(item=>!paperTaxScreen(item.token).blocked),nowMs});
    phaseTiming.newsWireMs=Math.max(0,now()-newsWireStartedAt);
    const buys=account.trades.filter(t=>t.side==='buy'),consumedEvents=new Set(buys.map(t=>t.entryEvidence?.opportunity?.signalId).filter(Boolean));
    observeAlgorithmSignals([...collectiveWire.signals.filter(canResearchEntry),...poolWire.signals.filter(canResearchEntry)],nowMs);
    for(const s of collectiveWire.signals)if(canResearchEntry(s)&&!candidates.has(keyOf(s)))candidates.set(keyOf(s),{
      token:{chain:s.chain,address:s.address},observedAt:null,marketStatus:'unavailable',discoverySource:'collective_signal'});
    const alphaSignals=memeExitMode?alphaListingSignals(evidence.alphaCatalog,nowMs)
      .filter(s=>scanChains.includes(s.chain)&&!consumedEvents.has(s.id)):[];
    const monitorSignals=memeExitMode?[...poolWire.signals,...newsWire.paperSignals].filter(s=>scanChains.includes(s.chain)&&!consumedEvents.has(s.id)
      &&!buys.some(t=>keyOf(t)===keyOf(s)&&t.atMs>=Date.parse(s.sourceAt))):[];
    for(const signal of alphaSignals)if(!focusedDiscovery&&!candidates.has(keyOf(signal)))candidates.set(keyOf(signal),{
      token:{chain:signal.chain,address:signal.address,symbol:signal.symbol,name:signal.name},
      observedAt:null,marketStatus:'unavailable',discoverySource:'binance_alpha'});
    for(const token of [...poolWire.seeds,...newsWire.seeds])if((!focusedDiscovery||poolDiscoverySignal(token))
      &&scanChains.includes(token.chain)&&!candidates.has(keyOf(token))) {
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
    if (confirmedMode&&!focusedDiscovery) for (const [key, asset] of Object.entries(narrativeMemory?.assets || {})) {
      const detail = details.get(key);
      if (!candidates.has(key) && scanChains.includes(asset.chain) && detail?.token) candidates.set(key,
        { token: detail.token, marketStatus: detail.status, observedAt: detail.observedAt, discoverySource: 'narrative_recall' });
    }
    let recallMatches = [];
    if (confirmedMode && !narrativeRecallState?.error) {
      const recallStartedAt=now();
      const result = advanceNarrativeRecall(narrativeMemory, { events: evidence.events, candidates: [...candidates.values()], trades: account.trades, nowMs });
      phaseTiming.narrativeRecallMs=Math.max(0,now()-recallStartedAt);
      recallMatches = result.matches.filter(x=>scanChains.includes(x.chain));
      if(!quoteRequest) {
        narrativeMemory = result.memory;
        narrativeRecallState = { ...result.report, matches: recallMatches, sourceHealth: evidence.narrativeSourceHealth?.status || 'unavailable' };
      }
      for (const match of recallMatches) if (!focusedDiscovery&&!candidates.has(keyOf(match))) candidates.set(keyOf(match),
        { token: { chain: match.chain, address: match.address, symbol: match.symbol }, marketStatus: 'unavailable', observedAt: null, discoverySource: 'narrative_recall' });
    }
    if (!quoteRequest && confirmedMode && !narrativeLearningState?.error) {
      const learningStartedAt = now();
      try {
        const learned = advanceNarrativeLearning(narrativeLearningMemory, {
          snapshots: [...marketSnapshots.values()].flat(), marks: [...quotes.values(), ...narrativeLearningMarks.values()],
          sourceObservations: [...narrativeSourceObservations.values()], narrativeMemory, nowMs,
        });
        narrativeLearningMemory = learned.memory; narrativeLearningState = learned.report; narrativeLearningTargets = learned.followupTargets;
        narrativeSourceTargets = learned.sourceTargets;
      } catch { narrativeLearningState = { error: '起量学习数据异常，暂停学习；持仓退出仍运行' }; narrativeLearningTargets = []; narrativeSourceTargets = []; }
      finally { phaseTiming.narrativeLearningMs = Math.max(0, now() - learningStartedAt); }
    }
    const recallFor = token => recallMatches.find(x=>keyOf(x)===keyOf(token)) || null;
    const narrativeResearchIndex=recoveryMode?createNarrativeResearchIndex({memory:narrativeMemory,
      documents:[...newsWire.researchDocuments,...(twitterNarrative?.documents||[])],episodes:narrativeLearningMemory?.episodes||[],nowMs}):null;
    if (!estimatedFeeMode&&(chainGasAccounting || chains.includes('eth'))) void gasMonitor?.refresh(evidence.flowState);
    const gasSnapshot = gasMonitor?.snapshot() || null;
    const inputs = await scanMap([...candidates.values()].filter(item=>scanChains.includes(item.token.chain)&&(!quoteRequest||keyOf(item.token)===keyOf(quoteRequest))), item => ({ ...item,
      marketRankObservations:marketRankObservations.get(keyOf(item.token))||[],
      gasEstimate: chainGasAccounting?gasMonitor.snapshot(item.token.chain):item.token.chain === 'eth' ? gasSnapshot : null,
      chainGasAccounting,
      narrativeResearchIndex,
      alphaSignal:alphaSignals.find(s=>keyOf(s)===keyOf(item.token))||null,
      monitorSignal:monitorSignals.find(s=>keyOf(s)===keyOf(item.token))||null,
      collectiveSignal:collectiveWire.signals.find(s=>keyOf(s)===keyOf(item.token))||null,
      newsResearch:newsWire.hints.find(h=>keyOf(h)===keyOf(item.token))||null,
      flow: entryFlow(item.token,collectiveWire.signals.find(s=>keyOf(s)===keyOf(item.token)),evidence,evidenceIndex,nowMs),
      narrative: evidenceIndex.narrative({ chain: item.token.chain, address: item.token.address, token: item.token, nowMs }),
      narrativeRecall: recallFor(item.token),
      opportunityAccount:opportunityMode ? account : null,
      nowMs, allowExploratory, compoundingCash: recoveryMode || compoundEntries || fixedEntryUsd !== null ? account.cash : null,
      fixedEntryUsd:recoveryMode?null:fixedEntryUsd, recoveryMode, minimalEntryMode, upsideMode, pvpMode, diagnosticMode, confirmedMode, evidenceHoldMode, continuousPaperMode, opportunityMode, memeExitMode,
    }));
    if(quoteRequest)return quoteRequest.kind==='event'?performEventAdmission(inputs[0],quoteRequest):performQuoteEntry(inputs[0],evidence,quoteRequest);
    internalTradeTargets=selectInnerTradeTargets(inputs,{nowMs,listedForEntry,
      watchedTargets:internalTradeMonitor?.snapshot()?.targets||[]});
    const preliminary = await scanMap(inputs, input => { const chart=charts.get(keyOf(input.token)); return { input, candidateBook:'main', decisions: evaluate({ ...priced(input,nowMs),
      ...(opportunityMode ? { candles:chart?.candles || [],klineStatus:chart?.status || 'unavailable' } : {}) }) }; });
    for(const {input,decisions} of preliminary)scheduleInternalDepth(input,decisions);
    jevResearch?.observe(preliminary.flatMap(row=>row.decisions));
    const externalResearch=opportunityMode ? preliminary.filter(({input,decisions})=>!paperTaxScreen(input.token).blocked&&canResearchExternal(input,decisions)) : [];
    const hotPerChain=lossRepairMode&&scanChains.length===1&&scanChains[0]==='bsc'?3:1;
    const hotResearch=planHotResearch(externalResearch,scanChains,charts,nowMs,hotResearchKeys,
      (decision,at)=>jevResearch?.hint(decision,at)?.adjustment||0,{perChainLimit:hotPerChain,maintainLeader:focusedDiscovery,
        watchSince:focusedDiscovery?hotWatch:null});
    if(focusedDiscovery){hotWatch=advanceHotWatch(hotWatch,hotResearch,nowMs);hotWatchRows=hotResearch;}
    hotResearchKeys=hotResearch.map(r=>keyOf(r.input.token));
    const samplingActive=activeEntrySampling && !!exitComparison?.entrySampling;
    const samplingCash=samplingActive ? Math.max(exitComparison.control.cash,exitComparison.dynamic.cash) : 0;
    // Each book carries its own budget/holdings into quote admission. Shared
    // active-entry controls use their own cash pool, never the main account's.
    const controlPreliminary=opportunityMode && reviewComparison ? await scanMap(inputs, input=>{
      const chart=charts.get(keyOf(input.token));
      const controlInput={...input,opportunityReviewMode:false,memeExitMode:false,recoveryMode:false,minimalEntryMode:false,fixedEntryUsd,
        compoundingCash:Math.max(reviewComparison.control.cash,samplingCash),opportunityAccount:samplingActive?null:reviewComparison.control};
      return {input:controlInput,candidateBook:'comparison',decisions:evaluate({...priced(controlInput,nowMs),candles:chart?.candles||[],klineStatus:chart?.status||'unavailable'})};}) : [];
    const researchFlowPolicy = confirmedMode ? { ...CONFIRMED_PAPER_POLICY, minHighProfit: 0 } : diagnosticMode ? { minBuyers: 1, minNetBuy: Number.MIN_VALUE, minHighProfit: 0, minSmartMoney: 0 } : allowExploratory ? EXPLORATORY_FLOW : { minBuyers: 4, minNetBuy: 1000, minHighProfit: 0, minSmartMoney: 0 };
    detailTargets = [];
    for (const { input, decisions } of preliminary) {
      if (paperTaxScreen(input.token).blocked) continue;
      const flow = input.flow;
      const walletBuy=walletBuyResearchHint(input,nowMs);
      const recall = recallFor(input.token);
      const newsHint=input.newsResearch||(input.alphaSignal?{sourceAt:new Date(input.alphaSignal.listingTime).toISOString()}:null);
      const internalResearch = opportunityMode && ['internal','near_completion'].includes(input.token.marketStage)
        && canPrefetchPaperFlow(flow,{ ...researchFlowPolicy,minSmartMoney:0,minNetBuy:300 });
      const plan = planPaperCandidateResearch(decisions, input.observedAt, nowMs);
      if(walletBuy && decisions.some(d=>d.decision!=='不买'&&!d.evidence?.safety?.blocked?.length)
        && (plan.needed || !fresh(input.observedAt,nowMs) || nowMs-stamp(input.observedAt)>=30000)) {
        plan.needed=true;plan.priority=3;plan.refreshAfterMs=30000;
        plan.reason='钱包新增真实买盘：优先补行情和安全字段，再交给买点检查';
      }
      // Safety/detail gaps are themselves a valid bounded research target.
      // Previously a candidate without a narrative, flow pulse or external
      // stage was skipped before planning, leaving the UI unable to
      // distinguish "not requested" from "upstream returned unknown".
      if (!walletBuy && !newsHint && !recall && !internalResearch && !(opportunityMode && canResearchExternal(input,decisions))
        && !canPrefetchPaperFlow(flow, researchFlowPolicy)
        && !(confirmedMode && plan.needed)) continue;
      if(hotResearchKeys.includes(keyOf(input.token)) && (plan.needed || nowMs-stamp(input.observedAt)>=60000)) {
        plan.needed=true;plan.priority=Math.max(2,plan.priority);plan.reason='热点候选优先补齐或刷新，尚不代表可以入场';
      }
      if (plan.needed) detailTargets.push({ ...input.token, purpose: 'candidate', researchPriority: recall || newsHint ? 3 : plan.priority,
        newsSourceAt:newsHint?.sourceAt||null,
        alphaListingTime:input.alphaSignal?.listingTime??null,
        monitorSourceAt:input.monitorSignal?.sourceAt??null,
        walletBuyAt:walletBuy?.buyAt??null, requestedFields:plan.requestedFields,
        refreshAfterMs: plan.refreshAfterMs, researchReason: input.alphaSignal?'官方 Alpha 上新：优先补齐当前行情与税费':input.monitorSignal?'监控事件快线：补齐真实行情与税费，不等待完整审计或 K 线':newsHint ? '新消息优先核查：未核实的喊单不等于已证实叙事' : recall ? '新叙事催化：优先复核历史 OG 行情和安全字段' : plan.reason });
    }
    const initial = [...preliminary,...controlPreliminary]
      // Extra chart calls are useful only after the cheaper evidence gates pass.
      // Holdings remain independently priced below, including during flow outages.
      .filter(({ input }) => !paperTaxScreen(input.token).blocked)
      .filter(({ input, decisions }) => minimalEntryMode && decisions.some(result => result.decision !== '不买' && !result.evidence?.safety?.blocked?.length)
        || decisions.some(readyForPaperQuote)
        || decisions.some(researchReadyForQuote)
        || canPrefetchPaperFlow(input.flow, researchFlowPolicy) && decisions.some(onlyPricingOrFlowWarmupMissing))
      .map(({ input, decisions, candidateBook }) => ({ input,candidateBook,
        // A route-level signal may deserve a quote while cost/structure is
        // still unresolved. It is research, not an admitted confirmation; it
        // must not seize critical capacity or pause all other discoveries.
        researchOnly:recoveryMode&&!decisions.some(readyForPaperQuote),
        // Warmup candidates share the bounded quote lane but remain ordinary
        // observations until the full evaluator marks them paper-eligible.
        canQuote: minimalEntryMode && decisions.some(result => result.decision !== '不买' && !result.evidence?.safety?.blocked?.length)
          || decisions.some(readyForPaperQuote) || decisions.some(researchReadyForQuote),
        score: Math.max(...decisions.map(result => result.score)) }))
      .sort((a, b) => Number(!!walletBuyResearchHint(b.input,nowMs))-Number(!!walletBuyResearchHint(a.input,nowMs)) || b.score - a.score);
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
    const quotePool=quoteCandidatePool(chartReady,{mainFirst:recoveryMode,catalystFirst:lossRepairMode});
    const narrativeReady = quotePool.filter(x=>freshNarrativeRecall(recallFor(x.input.token),x.input.token,nowMs));
    const alphaReady=quotePool.filter(r=>r.input.alphaSignal);
    const monitorReady=quotePool.filter(r=>r.input.monitorSignal);
    const collectiveReady=quotePool.filter(r=>r.input.collectiveSignal);
    const launchReady=lossRepairMode?monitorReady.filter(r=>launchContext(r.input.token,r.input.monitorSignal,nowMs)):[];
    // A just-listed official event preempts a normal candidate once. Holdings
    // retain priority and the event's original clock is never renewed.
    if(launchReady.length&&!launchReady.some(r=>keyOf(r.input.token)===quoteLease?.key))quoteLease=null;
    if((alphaReady.some(r=>nowMs-r.input.alphaSignal.listingTime<=300000)||monitorReady.length)
      &&![...alphaReady,...monitorReady].some(r=>keyOf(r.input.token)===quoteLease?.key))quoteLease=null;
    if(collectiveReady.length&&!collectiveReady.some(r=>keyOf(r.input.token)===quoteLease?.key))quoteLease=null;
    const quoteSelection=selectQuoteCandidate([...launchReady,...collectiveReady,...alphaReady,...monitorReady,...narrativeReady,...quotePool],quoteLease,nowMs,{windowMs:entryWindowMs,mainFirst:recoveryMode});
    quoteLease=quoteSelection.lease;
    const quoteCandidate=quoteSelection.row;
    if (quoteCandidate && (!recoveryMode||enabled)) admitCandidate(targetMap,{ ...quoteCandidate.input.token, purpose:'candidate',
      ...(recoveryMode?{candidateBook:quoteCandidate.candidateBook,researchOnly:quoteCandidate.researchOnly}:{}) });
    // Heat reserves data collection, not an order. Only use otherwise spare
    // candidate capacity; do not take an admitted event/entry or holding seat.
    const hotProbe=selectHotQuoteResearch(lossRepairMode && enabled && !quoteCandidate && !eventQuoteTargets.size
      ? externalResearch : [],hotQuoteLease,nowMs,{laneAvailable:![...quoteJobs.values()].some(j=>j.purpose==='candidate')});
    hotQuoteLease=hotProbe.lease;
    if(hotProbe.row)admitCandidate(targetMap,{...hotProbe.row.input.token,purpose:'candidate',candidateBook:'main',researchOnly:true});
    const previousCandidate = quoteTargets.find(t => t.purpose === 'candidate');
    quoteTargets = [...targetMap.values()];
    if (background) {
      const candidate = quoteCandidate?.input.token;
      entryFocus = advanceEntryFocus(entryFocus, enabled && confirmedMode && (!recoveryMode||quoteCandidate?.candidateBook==='main')
        && !quoteCandidate?.researchOnly ? candidate : null, nowMs, {windowMs:entryWindowMs});
      // Admit a newly selected quote before optional research, rather than wait
      // for the independent timer. Per-asset jobs and the shared gate still cap it.
      if (started && confirmedMode && candidate && (keyOf(candidate) !== (previousCandidate && keyOf(previousCandidate))
        ||recoveryMode&&previousCandidate?.candidateBook!==quoteCandidate.candidateBook)) void refreshQuote();
    }
    // Entry focus is bounded (45 seconds for evidence-exit main), then 10 seconds of
    // normal discovery admission. Holding charts always retain first priority.
    // Alternate expensive producers when both are due, instead of enqueuing
    // two charts plus info/security together on every fast cycle.
    const chartLimits = researchLimits();
    if(focusedDiscovery)exploratoryChartDemand=null;
    if (opportunityMode && chartJobs.size < chartLimits.concurrency && nowMs-lastOpportunityChartAt >= chartLimits.dispatchIntervalMs) {
      const focus = background ? focusedEntry() : null;
      const needsStructure=target=>lossRepairMode
        ? ![...launchReady,...collectiveReady.filter(r=>['internal','near_completion'].includes(r.input.token.marketStage))].some(r=>keyOf(r.input.token)===keyOf(target))
        : externalResearch.some(r=>keyOf(r.input.token)===keyOf(target));
      const target=selectResearchChart({holdings:heldTokens(),hot:hotResearch,broad:externalResearch,charts,nowMs,dispatch:chartDispatch,chains:scanChains,lastHotChain:lastHotChartChain,
        focus:focus&&{...focus,requiresStructureChart:needsStructure(focus)},
        researchFocus:background&&quoteCandidate?.researchOnly?{...quoteCandidate.input.token,
          requiresStructureChart:needsStructure(quoteCandidate.input.token)}:null,
        pendingKeys: new Set(chartJobs.keys()) });
      if(focusedDiscovery && target && target.purpose!=='exit' && target.researchLane!=='entry')
        exploratoryChartDemand={token:target,selectedAt:nowMs};
      if(background&&focusedDiscovery&&lastExploratoryKind==='chart')void refreshDetails();
      if(target && (!focusedDiscovery || target.purpose==='exit' || target.researchLane==='entry'
        || !detailJob&&!exploratoryChartKeys.size)) {
        const row=externalResearch.find(r=>keyOf(r.input.token)===keyOf(target));
        // Bounded hot seats need current charts for independently admitted
        // external routes. Broad discovery stays low-priority; holdings and
        // entry confirmation retain their reserved priority above both.
        if (lossRepairMode && target.researchLane==='discovery'
          && !row?.decisions.some(d=>d.evidence?.lossRepair?.catalystReady===true)
          && !fresh(row?.input.newsResearch?.sourceAt,nowMs)) target.purpose='research';
        lastOpportunityChartAt=nowMs;chartDispatch++;
        const prior=charts.get(keyOf(target)),priorClosed=opportunityChart(prior?.candles,prior?.status,nowMs).diagnostics.lastClosedAtMs;
        lastChartDispatch={chain:target.chain,address:target.address,lane:target.researchLane,purpose:target.purpose,at:new Date(nowMs).toISOString(),
          ...(target.walletTrigger?{walletTrigger:target.walletTrigger}:{}),
          proactive:!!prior && !chartRefreshDue(prior,nowMs),
          previousClosedAt:priorClosed==null?null:new Date(priorClosed).toISOString(),
          previousClosedAgeMs:priorClosed==null?null:nowMs-priorClosed};
        chartDispatches[target.researchLane]++;
        if(lastChartDispatch.proactive)chartDispatches.proactive++;
        if(target.researchLane==='hot'){lastHotChartChain=target.chain;hotChartDispatchesByChain[target.chain]++;}
        if(background) void getChart(target,nowMs).catch(()=>{}); else await getChart(target,nowMs);
      } else if(target&&focusedDiscovery)exploratoryChartDeferrals++;
    }
    if (background) { void refreshDetails(); void refreshNarrativeLearning(); }
    nowMs = now();
    const finalEvidence=new Map();
    const finalEvaluate = (input, overrides = {}) => {
      const chart = charts.get(keyOf(input.token));
      const key=keyOf(input.token);
      if(!finalEvidence.has(key))finalEvidence.set(key,{
        collectiveSignal:input.collectiveSignal,
        flow:entryFlow(input.token,input.collectiveSignal,evidence,evidenceIndex,nowMs),
        narrative:evidenceIndex.narrative({chain:input.token.chain,address:input.token.address,token:input.token,nowMs})});
      return evaluate({ ...priced(input, nowMs), nowMs,
        ...finalEvidence.get(key),
        candles: chart?.candles || [], klineStatus: chart?.status || 'unavailable', ...overrides,
        ...(overrides.memeExitMode===false?{recoveryMode:false,lossRepairMode:false,estimatedFeeMode:false,fixedEntryUsd}:{}),
        ...(overrides.confirmedMode===false?{fixedEntryUsd:null,minimalEntryMode:false}:{}) });
    };
    const originalEvaluations = (await scanMap(inputs, input => finalEvaluate(input))).flat().map(row => {
      if(!canEnterRow(row))return {...row,decision:'观察',missing:[...row.missing,'当前战壕/热门来源、已核实内盘钱包/放量或未消费的新池首三币信号'],
        evidence:{...row.evidence,paperEligible:false,entryPlan:{...row.evidence.entryPlan,eligible:false}}};
      if (!confirmedMode || row.decision !== '可模拟') return row;
      const gate = confirmedAccountGate(account, nowMs, row.token, row.evidence.confirmedPolicy?.pulse, row.evidence.narrativeRecall, { continuousPaperMode, enforceLossGuards, opportunity:row.evidence.opportunity });
      if (gate.allowed) return row;
      const blocked = { ...row, decision: '观察', reasons: gate.reasons, evidence: { ...row.evidence, paperEligible: false, accountGate: gate } };
      blocked.evidence.traderDecision = traderDecision(blocked, nowMs);
      return blocked;
    });
    const evaluations=memeExitMode?originalEvaluations.map(row=>memeExitEvaluation(row,row.decision==='可模拟'
      ?memeEntryContext(row.token,finalEvidence.get(keyOf(row.token)),nowMs):null)):originalEvaluations;
    if(focusSimulator) await focusSimulator.advance({evaluations,nowMs});
    // Local research only. This casebook never changes evaluations, account
    // permissions or paid-call budgets. Persist under the existing ledger lock.
    if (confirmedMode && !narrativeAcademyState?.error && nowMs-lastNarrativeAcademyAt>=15000) {
      const academyStartedAt = now();
      try {
        const index=narrativeResearchIndex||createNarrativeResearchIndex({memory:narrativeMemory,
          documents:[...newsWire.researchDocuments,...(twitterNarrative?.documents||[])],nowMs});
        const learned=advanceNarrativeAcademy(narrativeAcademyMemory,{documents:index.documents,conflictIds:[...index.conflictIds],
          candidates:[...candidates.values()],marks:[...quotes.values(),...narrativeLearningMarks.values()],evaluations,nowMs});
        narrativeAcademyMemory=learned.memory;narrativeAcademyState=learned.report;lastNarrativeAcademyAt=nowMs;
      } catch { narrativeAcademyState={error:'事件案例学习异常，保留记录；行情、模拟交易和持仓退出继续'}; }
      finally { phaseTiming.casebookMs = Math.max(0, now() - academyStartedAt); }
    }
    const marksFor = ledger => marks.map(mark => ({ ...mark, gasEstimate:chainGasAccounting?gasMonitor.snapshot(mark.chain):null, structureChart:holdingChart(ledger.positions[keyOf(mark)]||mark,mark),
      holderSnapshot:holdingChips(ledger.positions[keyOf(mark)],nowMs),
      narrative: ledger.exitExperimentVersion || ledger.positions[keyOf(mark)]?.memeExitPolicy ? buildPaperNarrativeEvidence({ chain: mark.chain, address: mark.address, token: ledger.positions[keyOf(mark)], events: evidence.events, nowMs }) : null,
      flow: positionFlow(ledger.positions[keyOf(mark)]||mark,evidence,nowMs) }));
    // A targeted fill may have committed at a cooperative checkpoint. Use the
    // CURRENT account and wall clock, and exclude callbacks until this write
    // finishes so a broad snapshot can never overwrite that fill.
    canDrainQuotes=false;
    nowMs=now();
    const next = advancePaperStrategyAccount(account, { evaluations:evaluations.filter(canEnterRow), marks: marksFor(account), enabled, nowMs, diagnosticMode, confirmedMode, continuousPaperMode, opportunityMode, memeExitMode, recoveryMode, minimalEntryMode, chainGasAccounting,lossRepairMode,enforceLossGuards,estimatedFeeMode,evidenceGapExitMode });
    if (lossRepairMode && next.stats.dailyLossGuard) enabled = false;
    next.stats.enabled = enabled;
    const controlEvaluations=opportunityMode && reviewComparison ? (await scanMap(inputs, input=>finalEvaluate(input,{opportunityReviewMode:false,memeExitMode:false,
      compoundingCash:reviewComparison.control.cash,opportunityAccount:reviewComparison.control}))).flat() : [];
    const nextComparison=reviewComparison ? {...reviewComparison,control:advancePaperStrategyAccount(reviewComparison.control,
      {evaluations:controlEvaluations,marks:marksFor(reviewComparison.control),enabled:enabled && opportunityMode,nowMs,confirmedMode:true,continuousPaperMode,opportunityMode,opportunityReviewMode:false,minimalEntryMode:false})} : null;
    const shadowEvaluations = estimatedFeeMode ? [] : (compoundEntries || upsideMode || pvpMode) && (learningShadow || learning?.policies?.length || learning?.personaPolicies?.length)
      ? (await scanMap(inputs.filter(input => input.token.chain === chain), input => finalEvaluate(input, { compoundingCash: null, fixedEntryUsd: null, allowExploratory: false, upsideMode: false, pvpMode: false, diagnosticMode: false, confirmedMode: false, minimalEntryMode: false, evidenceHoldMode: false, continuousPaperMode: false, opportunityMode:false,memeExitMode:false }))).flat()
      : originalEvaluations.filter(item => item.token?.chain === chain && item.evidence?.entryTier !== 'exploratory');
    const nextShadow = estimatedFeeMode?null:advanceLearningShadow(learningShadow, { report: learning, chain, evaluations: shadowEvaluations, marksFor, enabled, nowMs });
    const samplingEvaluations=samplingActive ? (await scanMap(inputs, input=>finalEvaluate(input,{opportunityReviewMode:false,memeExitMode:false,minimalEntryMode:false,
      compoundingCash:samplingCash,opportunityAccount:null}))).flat() : [];
    const nextExits = advanceExitComparison(exitComparison, { evaluations:originalEvaluations, samplingEvaluations, marksFor,
      enabled: enabled && thesisExitExperiment && (!exitComparison?.entrySampling || activeEntrySampling), nowMs });
    const nextReview = nextTradeReview(next,nowMs);
    recordAlgorithmDecision(evaluations,nowMs);
    const ledgerWriteStartedAt = now();
    await atomicWrite(stateFile, { schema: 'yesp_atm_runtime_v1', session, chain, chains, enabled, account: next, algorithmSignalJournal, learningShadow: nextShadow, narrativeMemory, narrativeLearningMemory,narrativeAcademyMemory,reviewComparison:nextComparison, exitComparison: nextExits, tradeCountReview: nextReview });
    phaseTiming.ledgerWriteMs = Math.max(0, now() - ledgerWriteStartedAt);
    tradeCountReview = nextReview;
    exitComparison = nextExits;
    reviewComparison=nextComparison;
    learningShadow = nextShadow;
    account = next;
    const coverage = snapshot => ({ status: snapshot?.status === 'ok' && !fresh(snapshot.observedAt,nowMs) ? 'stale' : snapshot?.status || 'loading', observedAt: snapshot?.observedAt || null, count: snapshot?.tokens?.length || 0, reason: snapshot?.reason || snapshot?.reasonCode || null });
    const flow = buildPaperDualFlowEvidence({ state: evidence.flowState, binanceState: evidence.binanceState, chain:scanChains[0], nowMs });
    const chainCoverage = Object.fromEntries(chains.map(currentChain => {
      const [ranked, launches, hourly] = marketSnapshots.get(currentChain);
      const chainFlow = buildPaperDualFlowEvidence({ state: evidence.flowState, binanceState: evidence.binanceState, chain: currentChain, nowMs });
      const rows = evaluations.filter(item => item.token?.chain === currentChain);
      return [currentChain, { scanning:scanChains.includes(currentChain), market: coverage(ranked), trenches: coverage(launches), ...(opportunityMode&&!focusedDiscovery ? { hourly:coverage(hourly) } : {}),
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
    const focusShadowRows = opportunityMode ? evaluations.filter(item=>item.evidence?.strategyFocusShadow)
      .map(item=>({chain:item.token?.chain,address:item.token?.address,symbol:item.token?.symbol||null,
        marketStage:item.evidence?.marketStage||null,
        ...item.evidence.strategyFocusShadow})) : [];
    const focusShadowPersistence = focusShadowStore?.record(focusShadowRows,nowMs)||null;
    const strategyFocusShadow = opportunityMode ? {
      version:'smartmoney_second_breakout_shadow_v1',researchOnly:true,entryAllowed:false,paperFillAllowed:false,
      durability:'bounded_persistent_journal_plus_latest_scan_snapshot',persistence:focusShadowPersistence,
      checkedAt:new Date(nowMs).toISOString(),evaluatedCandidates:focusShadowRows.length,
      internalSmartMoneyWatchCount:focusShadowRows.filter(r=>r.internalSmartMoney?.status==='watch_smart_money_only').length,
      externalSecondBreakoutCandidateCount:focusShadowRows.filter(r=>r.externalSecondBreakout?.signalReady===true).length,
      byChain:Object.fromEntries(chains.map(currentChain=>{
        const rows=focusShadowRows.filter(r=>r.chain===currentChain);
        return [currentChain,{evaluated:rows.length,
          internalSmartMoneyWatch:rows.filter(r=>r.internalSmartMoney?.status==='watch_smart_money_only').length,
          secondBreakoutCandidates:rows.filter(r=>r.externalSecondBreakout?.signalReady===true).length,
          dataIncomplete:rows.filter(r=>r.externalSecondBreakout?.status==='data_incomplete').length}];
      })),
      candidates:focusShadowRows.filter(r=>r.internalSmartMoney?.status==='watch_smart_money_only'
        ||r.externalSecondBreakout?.signalReady===true).slice(0,20),
      note:'候选/未触发/拒绝原因保存在独立有界研究文件并提供当前快照；不进入买卖路由、不生成模拟成交。'
    } : null;
    const strategyFocusSimulation = focusSimulator?.snapshot() || {
      version:PAPER_STRATEGY_FOCUS_SIMULATION_VERSION,enabled:false,status:'disabled',mode:'paper_sidecar',
      execution:false,signing:false,broadcast:false,note:'需确认的独立纸面前向实验；不进入主账本'};
    tickCount += 1;
    const marketSourceAges = scanChains.map(currentChain => {
      const source = marketSnapshots.get(currentChain)[0];
      return { chain: currentChain, status: source.status, observedAt: source.observedAt,
        ageMs: Number.isFinite(stamp(source.observedAt)) ? Math.max(0, now() - stamp(source.observedAt)) : null };
    });
    const cadence = { evaluationIntervalMs: intervalMs, evaluationCadence: 'start_to_start_single_flight',
      runtimePathVersion:'paper_compute_memo_v2',researchReads:researchReader.snapshot(),phaseTiming,
      scanOptimization:'indexed_cooperative_v1',scanYields,scanCandidateCount:inputs.length,
      evaluationOverrunMs: Math.max(0, now() - (lastFastStartedAt ?? tickStartedAt) - intervalMs),
      actualTickGapMs: lastTickAt === null ? null : tickStartedAt - lastTickAt,
      lastTickAt: new Date(tickStartedAt).toISOString(), lastTickDurationMs: Math.max(0, now() - tickStartedAt), tickCount,
      marketRefreshIntervalMs: marketIntervalMs, marketRefreshCadence: 'start_to_start', lastMarketRefreshAt: lastMarketRefreshAt === null ? null : new Date(lastMarketRefreshAt).toISOString(),
      marketRefreshPending: marketJobs.size > 0, marketAuxiliaryPending: auxiliaryJobs.size>0, marketSourceAges,
      marketAuxiliaryIntervalMs: focusedDiscovery?FOCUSED_REFRESH_MS:60_000, marketAuxiliaryMode: focusedDiscovery?GMGN_THREE_LISTS:'bounded_freshness_v3',
      marketAuxiliaryConcurrency:auxiliaryLaneLimit(),marketAuxiliaryInFlight:[...auxiliaryJobs.keys()],marketMinuteRefreshFloorMs:minuteRefreshFloor(),
      marketAuxiliarySourceAges: scanChains.flatMap(currentChain => marketSnapshots.get(currentChain).slice(1,focusedDiscovery?2:3).map((source, index) => ({
        chain: currentChain, source: index === 0 ? 'trenches' : 'ranking_1h', status: source.status,
        observedAt: source.observedAt, ageMs: Number.isFinite(stamp(source.observedAt)) ? Math.max(0, now() - stamp(source.observedAt)) : null,
      }))),
      marketRefreshConcurrency: marketLaneLimit(), marketRefreshInFlight: [...marketJobs.keys()],
      quoteRequestIntervalMs: 1000, quoteMaxAgeMs: 15_000,
      quoteTargets: quoteTargets.length, freshQuotes: quoteTargets.filter(token => recentQuote(token, nowMs)).length,
      entryQuoteMaxAgeMs: pvpMode ? PVP_EXIT_POLICY.entryQuoteMaxAgeMs : 15_000, lastQuoteTiming,
      quoteEvaluationMode: recoveryMode?'targeted_main_quote_v1':'on_fresh_quote_and_interval', quoteTriggeredEvaluations,
      quoteDispatchVersion:'cooperative_ca_dispatch_v1',cooperativeQuoteEvaluations,quoteQueueReplacements,
      pendingQuoteEvaluations:readyQuoteEvaluations.size,quoteEvidenceReads:quotePreparationJobs.size,
      eventDispatch:eventDispatchSnapshot(),
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
      marketChains: scanChains.length, marketRefreshMode: 'bounded_chain_lanes_v2', detailRefreshPending: !!detailJob, detailTargets: detailTargets.length,
      flowLookbackMs: 300_000, focusFlowPollTargetMs: 5000, flowIndexBufferMs: 10_000,
      walletBuyPriority:{version:WALLET_BUY_PRIORITY_VERSION,researchOnly:true,
        triggers:preliminary.filter(r=>r.decisions.some(d=>d.decision!=='不买'&&!d.evidence?.safety?.blocked?.length))
          .map(r=>walletBuyResearchHint(r.input,nowMs)).filter(Boolean)
          .sort((a,b)=>a.ageMs-b.ageMs).slice(0,8),
        note:'钱包新买盘优先补证；通过既有买点后自动模拟，不把卖出、转账或平台标签直接变成买单'},
      upstreamLatencyGuaranteed: false, ethGas: gasMonitor?.snapshot('eth') || null,
      chainGas:chainGasAccounting?gasMonitor.snapshot():null,gasAccountingOnly:chainGasAccounting };
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
    publicState = { ...publicState, status: 'ok', lastError: null, enabled, updatedAt: account.updatedAt, account: clone(account), strategies, cadence, opportunityRoutes, strategyFocusShadow, strategyFocusSimulation,
      lossRepair:lossRepairMode?lossRepairReport(account,evaluations,nowMs,{estimatedFees:estimatedFeeMode}):null,
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
        structureCostVersion:lossRepairMode?LOSS_REPAIR_VERSION:chainGasAccounting?'gas_accounting_not_admission_v1':STRUCTURE_COST_POLICY_VERSION,structureMaxCostRate:MAIN_STRUCTURE_MAX_COST_RATE,
        gasExcludedFromAdmission:chainGasAccounting&&!lossRepairMode,
        alphaEntryVersion:ALPHA_ENTRY_VERSION,
        monitorEntryVersion:MONITOR_ENTRY_VERSION,
        quoteMaxAgeMs:5000,structureQuoteMaxGapMs:10000,entryWindowMs,
        text:minimalEntryMode?'最小必要门槛：有效 CA、两分钟内真实行情、五秒内独立报价、可卖性、税率不高于 6%、非零流动性与链/CA 数据绑定。叙事、聪明钱、K 线、成本比例和恢复期证明只记录为研究证据，不再阻止模拟开仓；仅模拟，不签名、不广播。':lossRepairMode?(estimatedFeeMode?PAPER_ENTRY_ROUTES_TEXT:LOSS_REPAIR_TEXT):recoveryMode?`${RECOVERY_ENTRY_TEXT}${chainGasAccounting?GAS_ACCOUNT_ONLY_TEXT:STRUCTURE_COST_TEXT}${PAPER_TAX_FILTER_TEXT}`:`主盘监控事件快线：精确 CA 消息两分钟内，一次五秒内独立报价可试仓。无 CA 大 KOL 消息比较主题候选，名称与项目原帖链接同时匹配后才进入交易检查；超过两分钟至一小时只做当前报价重新走强的跟随，不补造狙击成交。同时持仓数量不限，受可用余额约束。Alpha 入口继续运行；真实行情、费用、明确不可交易标记和事件去重仍检查。${chainGasAccounting?GAS_ACCOUNT_ONLY_TEXT:STRUCTURE_COST_TEXT}${PAPER_TAX_FILTER_TEXT}`}:null,
      narrativeRecall: narrativeRecallState && clone(narrativeRecallState),
      poolFirstThreePolicy:lossRepairMode&&estimatedFeeMode?{...POOL_FIRST_THREE_POLICY}:null,
      separatedEntryPolicy:estimatedFeeMode?{version:PAPER_ENTRY_ROUTES_VERSION,text:PAPER_ENTRY_ROUTES_TEXT,paperOnly:true}:null,
      newsWire: {...newsWire,monitorEntryEnabled:memeExitMode,unconsumedPaperSignals:monitorSignals.length,
        poolFirstThree:poolWire.report,
        twitterEvents:{...newsWire.twitterEvents,candidates:undefined,reports:newsWire.twitterEvents.reports.map(report=>({...report,
          candidates:report.candidates.map(c=>{const rows=evaluations.filter(r=>keyOf(r.token)===keyOf(c));
            const row=rows.find(r=>r.evidence?.opportunity?.event?.source==='twitter_narrative_event')||rows[0];
            return {...c,sourceText:undefined,checks:row?{decision:row.decision,missing:row.missing,reasons:row.reasons}:null};})}))},
        alphaCatalog:alphaCatalogReport(evidence.alphaCatalog,nowMs),entryRules:recoveryMode?RECOVERY_ENTRY_TEXT:null,
        seeds:undefined,hints:undefined,paperSignals:undefined,researchDocuments:undefined},
      narrativeLearning: narrativeLearningState && clone(narrativeLearningState),
      narrativeAcademy: narrativeAcademyState && clone(narrativeAcademyState),
      narrativeDesk:recoveryMode?{...narrativeDeskReport(evaluations,narrativeResearchIndex,narrativeLearningState?.stageResearch,nowMs),twitter:twitterNarrative}:null,
      entryGuard: confirmedMode ? confirmedAccountGate(account, nowMs, null, null, null, { continuousPaperMode, enforceLossGuards }) : null,
      reviewComparison:reviewComparisonSummary(reviewComparison,account),
      exitComparison: exitComparisonSummary(exitComparison),
      researchPipeline: { version: RESEARCH_SCHEDULER_VERSION, detailsRequested: detailDispatchCount, detailsSucceeded, lastDetail: clone(lastDetail),
        ...(focusedDiscovery?{focusedReadBudget:{version:FOCUSED_RESEARCH_BUDGET_VERSION,exploratoryConcurrency:1,
          exploratoryActive:exploratoryChartKeys.size+(detailJob?1:0),lastKind:lastExploratoryKind,
          chartDeferrals:exploratoryChartDeferrals,detailDeferrals:exploratoryDetailDeferrals,
          chartTurnDeferrals,chartTurnReserved:!!exploratoryChartDemand,
          chartsSinceDetail,maxChartsBeforeDetail:2,hotDeadlineDeferrals,hotDeadlineReserved:hotDeadlineReservation(),
          detailBackoffCandidates:[...detailGapRetries.values()].filter(r=>r.nextAttemptAt>nowMs).length,
          note:'列表独立刷新；单后台席位，热点临期最多连续两次图表后让普通详情继续。最多两个热点保留两分钟观察，普通发现轮次和退出优先级不变；缺字段退避、共享限频与买卖条件不变。'}}:{}),
        candidateSelectionPolicy:lossRepairMode?CATALYST_SELECTION_VERSION:'eligible_cost_then_signal_recency_v1',
        readonlyAdmission:{version:READONLY_ADMISSION_VERSION,backgroundConcurrency:1,criticalAgingBypass:false,
          scope:'loaded_process',note:'本进程按分层规则进入共享账户队列；未重载的其他进程可能仍沿用旧调度。'},
        entryDiagnostics:paperEntryDiagnostics(evaluations,{quoteTargets}),
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
        hotCandidates:hotResearch.map(r=>({chain:r.input.token.chain,address:r.input.token.address,symbol:r.input.token.symbol,
          marketLeader:marketLeaderHint(r,nowMs),
          ...(focusedDiscovery&&hotWatch.has(keyOf(r.input.token))?{watchSince:new Date(hotWatch.get(keyOf(r.input.token))).toISOString(),
            watchUntil:new Date(hotWatch.get(keyOf(r.input.token))+HOT_WATCH_MS).toISOString()}:{}),
          chartClosedAt:(()=>{const c=charts.get(keyOf(r.input.token)),at=opportunityChart(c?.candles,c?.status,nowMs,{contiguousTail:memeExitMode}).diagnostics.lastClosedAtMs;
            return at==null?null:new Date(at).toISOString();})()})),
        hotQuoteResearch:{version:HOT_RESEARCH_VERSION,lease:hotQuoteLease,
          target:hotProbe.row?{chain:hotProbe.row.input.token.chain,address:hotProbe.row.input.token.address}:null,
          note:'热门外盘最多 15 秒普通优先级报价预热，再休息 45 秒；不占已合格入口、不直接授予买入许可'},
        discoveryCandidates:externalResearch.length,hotLimit:scanChains.length*hotPerChain,lastChartDispatch,chartDispatches:{...chartDispatches},
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
        ...(lossRepairMode&&estimatedFeeMode?{internalCurve:{version:PAPER_INTERNAL_DEPTH_SIZING_VERSION,
          scope:'bsc_internal_verified_wallet_or_burst_signal',requiresFreshExactOrderDepth:true,
          providerLiquidityPreserved:true,proposalIsEntryPermission:false}}:{}),
        maxLiquidityShare:PAPER_LIQUIDITY_CAP_RATE,maxPositions:null,positionLimitBasis:'available_cash'}:{ mode: fixedEntryUsd !== null ? 'fixed' : compoundEntries ? 'cash_fraction' : 'fixed', version: fixedEntryUsd !== null ? PAPER_FIXED_SIZING_VERSION : PAPER_SIZING_VERSION,
        fixedEntryUsd, exactTicket: fixedEntryUsd !== null,
        cashBasis: account.cash, includesUnrealizedPnl: false, exploratoryRate: fixedEntryUsd !== null ? null : .02,
        standardRates: fixedEntryUsd !== null ? null : Object.fromEntries(STRATEGY_POLICIES.map(p => [p.id, p.entryUsd / 100])),
        maxLiquidityShare: PAPER_LIQUIDITY_CAP_RATE, maxPositions: continuousPaperMode ? null : 2, positionLimitBasis: continuousPaperMode ? 'available_cash' : 'fixed_count' },
      learning, learningComparison: { ...learningShadowSummary(learningShadow), chain }, chainCoverage,
      coverage: { market: coverage(trending), trenches: coverage(trenches), flow: { status: flow.status, observedAt: flow.observedAt, fresh: flow.fresh, complete: flow.complete, coverageGap: flow.coverageGap, scope: flow.scope, evidenceScope: flow.evidenceScope, windowStartAt: flow.windowStartAt, windowEndAt: flow.windowEndAt, sourceIssue: flow.sourceIssue, provider: flow.provider, providerLabel: flow.providerLabel, sources: flow.sources } },
      evaluations: evaluations.map(({ evidence: detail, ...entry }) => ({ ...entry, evidence: detail })) };
    if(estimatedFeeMode&&publicState.mainEntryPolicy)publicState.mainEntryPolicy={...publicState.mainEntryPolicy,
      text:minimalEntryMode?'最小必要门槛：有效 CA、两分钟内真实行情、五秒内独立报价、可卖性、税率不高于 6%、非零流动性与链/CA 数据绑定。叙事、聪明钱、K 线、成本比例和恢复期证明只记录为研究证据，不再阻止模拟开仓；仅模拟，不签名、不广播。':`${ESTIMATED_COST_TEXT} ${PAPER_ENTRY_ROUTES_TEXT}`,
      structureCostVersion:minimalEntryMode?'minimal_hard_safety_v1':ESTIMATED_COST_VERSION};
    // Keep the old work metric comparable; expose the previously unmeasured
    // state-publication tail separately rather than silently changing its basis.
    cadence.fullCycleMs = Math.max(0, now() - tickStartedAt);
  }

  function displayLearningReport() {
    try { return learningReportSnapshot(); }
    catch { return { lastError: 'learning_report_unavailable' }; }
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
    const delay = marketJobs.size >= marketLaneLimit() || memeExitMode && focusedEntry() ? marketIntervalMs
      : nextScanDelay(marketIntervalMs, lastMarketRefreshStartedAt ?? now(), now());
    refreshTimer = setTimeout(() => {
      // A slow chain retains only its own bounded slot. Another chain may
      // publish while it waits; shared GMGN admission/exit priority is unchanged.
      void refreshMarket({ background: true }).catch(() => {});
      scheduleRefresh();
    }, Math.max(100, delay)); refreshTimer.unref?.();
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
  function scheduleEvents() {
    if(stopped||!recoveryMode||!estimatedFeeMode)return;
    eventTimer=setTimeout(()=>{void refreshEvents().finally(scheduleEvents);},1000);eventTimer.unref?.();
  }
  return {
    stateFile,
    snapshot: () => ({...clone(publicState),
      ...(opportunityMode?{strategyFocusShadow:{...(clone(publicState.strategyFocusShadow)||{
        version:'smartmoney_second_breakout_shadow_v1',researchOnly:true,entryAllowed:false,paperFillAllowed:false,
        durability:'bounded_persistent_journal_plus_latest_scan_snapshot'}),persistence:focusShadowStore?.snapshot()||null}}:{}),
      strategyFocusSimulation:focusSimulator?.snapshot()||clone(publicState.strategyFocusSimulation)||{
        version:PAPER_STRATEGY_FOCUS_SIMULATION_VERSION,enabled:false,status:'disabled',mode:'paper_sidecar',
        execution:false,signing:false,broadcast:false},
      ...(learningReportSnapshot?{learning:displayLearningReport()}:{}),discoveryScope:discoveryScopeSnapshot(),readonlyRequests:market.diagnostics?.()||null,algorithmSignals:algorithmSignalSnapshot(), scanScope:{version:1,scanChains:[...scanChains],managementChains:[...chains],
      retainedExitChains:[...new Set(heldTokens().map(t=>t.chain))].filter(c=>!scanChains.includes(c)),
      newsMonitoring:'unchanged',effectiveOnRestart:true}, ...(lossRepairMode && account ? {lossGuards:paperLossGuard(account, now(), {enforced:enforceLossGuards})} : {}), ...(jevResearch ? {jevResearch:jevResearch.snapshot()} : {})}),
    walletResearchContext: () => ({readOnly:true,
      charts:[...charts.values()].filter(c=>c.status==='ok').map(c=>({chain:c.chain,address:c.address,status:c.status,
        resolution:c.resolution,fetchedAt:c.fetchedAt,closedThroughAtMs:c.closedThroughAtMs,candles:clone(c.candles||[])})),
      documents:validNarrativeAcademy(narrativeAcademyMemory)?clone(narrativeAcademyMemory.cases):[]}),
    runOnce, fastOnce, exitOnce, refreshMarket, refreshQuote, refreshDetails, refreshNarrativeLearning, refreshEvents,
    start: async () => { if (started || stopped) return; started = true; try { await serial(initialize); } catch (error) { started = false; throw error; }
      await jevResearch?.start();
      void refreshMarket({ background: true }).catch(() => {}); scheduleRefresh(); void fastOnce().catch(() => {}).finally(schedule); scheduleQuote(); scheduleExit(); scheduleEvents(); },
    setEnabled: value => serial(async () => {
      if (typeof value !== 'boolean') throw new TypeError('enabled must be boolean');
      if(value&&lossRepairMode&&!estimatedFeeMode&&!ORDER_FEE_CAPABILITY.ready)throw Object.assign(new Error(`不能恢复主盘新仓：${ORDER_FEE_CAPABILITY.reason}`),{code:'PAPER_ORDER_FEES_UNAVAILABLE'});
      if (stopped) throw new Error('模拟引擎已停止');
      await initialize();
      if (value && lossRepairMode && paperLossGuard(account, now(), {enforced:enforceLossGuards}).triggered)
        throw Object.assign(new Error(paperLossGuard(account, now(), {enforced:enforceLossGuards}).reasons.join('；')), {code:'PAPER_LOSS_GUARD_ACTIVE'});
      const next = {...account, stats:{...account.stats, enabled:value}};
      await atomicWrite(stateFile, { schema: 'yesp_atm_runtime_v1', session, chain, chains, enabled: value, account:next, algorithmSignalJournal, learningShadow, narrativeMemory, narrativeLearningMemory,narrativeAcademyMemory,reviewComparison, exitComparison, tradeCountReview });
      enabled = value; account = next;
      publicState = { ...publicState, enabled, account:clone(account) }; return clone(publicState);
    }),
    resetCash: operationId => serial(async () => {
      if (stopped) throw new Error('模拟引擎已停止');
      await initialize();
      const next = resetPaperCash(account, { operationId, nowMs: now() });
      if (account.cashAdjustments?.some(item => item.id === operationId)) return clone(publicState);
      const before = { schema: 'yesp_atm_runtime_v1', session, chain, chains, enabled, account, learningShadow,
        narrativeMemory, narrativeLearningMemory, narrativeAcademyMemory, reviewComparison, exitComparison, tradeCountReview };
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
    stop: async () => { stopped = true; clearTimeout(timer); clearTimeout(refreshTimer); clearTimeout(quoteTimer); clearTimeout(exitTimer); clearTimeout(eventTimer);
      await Promise.allSettled([internalTradeMonitor?.stop(),jevResearch?.stop(),cycle, fastCycle, quoteEvaluationJob, eventRefreshJob, depthJob, ...quotePreparationJobs, exitJob, refreshJob, ...marketJobs.values(), ...auxiliaryJobs.values(), ...[...quoteJobs.values()].map(x=>x.job), detailJob, narrativeLearningJob, ...chartJobs.values()]); await tail; await focusShadowStore?.flush(); await focusSimulator?.flush(); await releaseLock(); },
  };
}
