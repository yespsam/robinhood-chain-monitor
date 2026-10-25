/** Fixed 2x / 3x / 5x counterfactual exits over ONE actual-entry cohort, not three portfolios. */
import { createProfitRetentionShadow, advanceProfitRetentionShadow, validateProfitRetentionShadow, profitRetentionSummary } from './paper-profit-retention-shadow.js';

export const PROFIT_RETENTION_MULTIARM_VERSION = 'profit_retention_multiarm_v3';
const MULTIPLES = Object.freeze([2, 3, 5]);
const POLICY = Object.freeze({ triggerPriceMultiples: MULTIPLES, sameActualEntries: true, sameQuotes: true,
  independentHypotheses: true, noPortfolioSum: true, historicalBackfill: false, reusedCapital: false });
const QUOTE_GAPS = Object.freeze(['missing_quote', 'invalid_quote', 'conflicting_quote_timestamp', 'future_quote',
  'pre_entry_quote', 'stale_quote', 'out_of_order_quote']);
const SHARED_GAPS = Object.freeze([...QUOTE_GAPS, 'observer_commit_gap', 'no_post_entry_observation']);
const GAP_LIMIT = 200;
const fail = (ok, reason) => { if (!ok) throw new TypeError(`profit retention multiarm: ${reason}`); };
const finite = n => typeof n === 'number' && Number.isFinite(n);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function sharedBaseline(study) {
  const { tradeCount, lastTradeId, tradePrefixHash, establishedAtMs } = study.baseline;
  return { tradeCount, lastTradeId, tradePrefixHash, establishedAtMs };
}
function commonPair(pair) {
  // Trigger/partial treatment and infeasible-recovery gaps may differ; the source cohort cannot.
  const { id, entry, status, exclusion, control, observations, observationCount, lastObservation, peak } = pair;
  return { id, entry, status, exclusion, control, observations, observationCount, lastObservation, peak };
}
function recordSharedGap(coverage, { reason, atMs, pairIds, fromMs = null }) {
  const ids = [...new Set(pairIds)];
  coverage.gapCount++; coverage.reasons[reason] = (coverage.reasons[reason] ?? 0) + 1;
  coverage.pairGapCount += ids.length;
  coverage.latest.push({ reason, atMs, pairIds: ids, fromMs }); coverage.latest = coverage.latest.slice(-GAP_LIMIT);
  for (const pairId of ids) {
    let row = coverage.byPair.find(x => x.pairId === pairId);
    if (!row) { row = { pairId, gapCount: 0, reasons: {}, lastGapAtMs: atMs }; coverage.byPair.push(row); }
    row.gapCount++; row.reasons[reason] = (row.reasons[reason] ?? 0) + 1; row.lastGapAtMs = atMs;
  }
}

export function createProfitRetentionMultiarm(account, { sessionId, nowMs } = {}) {
  const arms = MULTIPLES.map(multiple => ({ multiple,
    study: createProfitRetentionShadow(account, { sessionId, nowMs, triggerPriceMultiple: multiple }) }));
  const first = arms[0].study;
  const result = { version: PROFIT_RETENTION_MULTIARM_VERSION, sessionId, mode: 'shadow_paper',
    execution: false, signing: false, broadcast: false, pairedCohort: true,
    policy: structuredClone(POLICY), baseline: sharedBaseline(first), cursor: { ...first.cursor }, updatedAtMs: nowMs, arms,
    sharedCoverage: { gapCount: 0, pairGapCount: 0, reasons: {}, latest: [], byPair: [] } };
  validateProfitRetentionMultiarm(result);
  return result;
}

export function validateProfitRetentionMultiarm(state) {
  fail(state?.version === PROFIT_RETENTION_MULTIARM_VERSION && state.mode === 'shadow_paper' && state.pairedCohort === true
    && state.execution === false && state.signing === false && state.broadcast === false, 'invalid study identity');
  fail(typeof state.sessionId === 'string' && state.sessionId.length > 0 && finite(state.updatedAtMs), 'invalid session or timestamp');
  fail(equal(state.policy, POLICY), 'fixed three-arm policy changed');
  fail(Array.isArray(state.arms) && state.arms.length === MULTIPLES.length, 'all three arms required');
  let reference;
  for (let i = 0; i < MULTIPLES.length; i++) {
    const arm = state.arms[i];
    fail(arm?.multiple === MULTIPLES[i], 'arm order, duplicate or identity mismatch');
    validateProfitRetentionShadow(arm.study);
    const study = arm.study;
    fail(study.policy.triggerPriceMultiple === arm.multiple && study.sessionId === state.sessionId, 'arm configuration/session mismatch');
    fail(equal(sharedBaseline(study), state.baseline) && equal(study.cursor, state.cursor) && study.updatedAtMs === state.updatedAtMs, 'arm source checkpoint mismatch');
    const common = { pairs: study.pairs.map(commonPair), ineligible: study.ineligible, ineligibleCount: study.ineligibleCount,
      admissionStopped: study.admissionStopped };
    if (reference) fail(equal(common, reference), 'arms do not share the same entries, controls, exclusions and quotes');
    else reference = common;
    for (const reason of QUOTE_GAPS) fail((study.coverage.reasons[reason] ?? 0) === (state.arms[0].study.coverage.reasons[reason] ?? 0), 'common quote gap mismatch');
  }
  const cov = state.sharedCoverage, ids = new Set(state.arms[0].study.pairs.map(p => p.id));
  const validReasonCounts = counts => counts && typeof counts === 'object' && !Array.isArray(counts)
    && Object.entries(counts).every(([reason, n]) => SHARED_GAPS.includes(reason) && Number.isInteger(n) && n > 0);
  fail(cov && Number.isInteger(cov.gapCount) && cov.gapCount >= 0 && validReasonCounts(cov.reasons)
    && Object.values(cov.reasons).reduce((a, b) => a + b, 0) === cov.gapCount, 'invalid shared coverage totals');
  fail(Array.isArray(cov.latest) && cov.latest.length <= GAP_LIMIT && cov.latest.length <= cov.gapCount
    && cov.latest.every(g => SHARED_GAPS.includes(g.reason) && finite(g.atMs)
      && g.atMs >= state.baseline.establishedAtMs && g.atMs <= state.updatedAtMs && Array.isArray(g.pairIds) && g.pairIds.length > 0
      && new Set(g.pairIds).size === g.pairIds.length && g.pairIds.every(id => ids.has(id))
      && (g.reason !== 'observer_commit_gap' || finite(g.fromMs) && g.atMs - g.fromMs > 15000)), 'invalid shared coverage details');
  fail(Array.isArray(cov.byPair) && cov.byPair.length <= GAP_LIMIT && new Set(cov.byPair.map(p => p.pairId)).size === cov.byPair.length
    && cov.byPair.every(p => ids.has(p.pairId) && Number.isInteger(p.gapCount) && p.gapCount > 0 && validReasonCounts(p.reasons)
      && Object.values(p.reasons).reduce((a, b) => a + b, 0) === p.gapCount && finite(p.lastGapAtMs)
      && p.lastGapAtMs >= state.baseline.establishedAtMs && p.lastGapAtMs <= state.updatedAtMs), 'invalid pair coverage');
  fail(Number.isInteger(cov.pairGapCount) && cov.pairGapCount >= 0
    && cov.byPair.reduce((total, p) => total + p.gapCount, 0) === cov.pairGapCount, 'pair coverage incident total mismatch');
  for (const g of cov.latest) for (const id of g.pairIds) fail(cov.byPair.some(p => p.pairId === id && (p.reasons[g.reason] ?? 0) > 0 && p.lastGapAtMs >= g.atMs), 'pair coverage omits retained gap');
  for (const reason of QUOTE_GAPS) fail((cov.reasons[reason] ?? 0) === (state.arms[0].study.coverage.reasons[reason] ?? 0), 'shared coverage omits quote gaps');
  const noQuoteCompleted = state.arms[0].study.pairs.filter(p => p.status === 'completed' && p.observationCount === 0);
  fail((cov.reasons.no_post_entry_observation ?? 0) === noQuoteCompleted.length
    && noQuoteCompleted.every(p => cov.byPair.some(g => g.pairId === p.id && g.reasons.no_post_entry_observation === 1)), 'completed round without observations lacks shared coverage flag');
  return true;
}

export function advanceProfitRetentionMultiarm(state, { beforeAccount, afterAccount, marks = [], nowMs } = {}) {
  validateProfitRetentionMultiarm(state);
  // Each v2 transition is pure. Do not publish any arm if a later arm fails validation.
  const arms = state.arms.map(arm => ({ multiple: arm.multiple,
    study: advanceProfitRetentionShadow(arm.study, { beforeAccount, afterAccount, marks, nowMs }) }));
  const sharedCoverage = structuredClone(state.sharedCoverage), previous = state.arms[0].study;
  const priorActiveIds = previous.pairs.filter(p => p.status === 'active').map(p => p.id);
  if (priorActiveIds.length && nowMs - state.updatedAtMs > previous.policy.quoteMaxAgeMs) {
    recordSharedGap(sharedCoverage, { reason: 'observer_commit_gap', fromMs: state.updatedAtMs, atMs: nowMs, pairIds: priorActiveIds });
  }
  const current = arms[0].study, addedGapCount = current.coverage.gapCount - previous.coverage.gapCount;
  const additions = current.coverage.latest.slice(-Math.min(addedGapCount, current.coverage.latest.length));
  for (const g of addedGapCount ? additions : []) if (QUOTE_GAPS.includes(g.reason)) {
    recordSharedGap(sharedCoverage, { reason: g.reason, atMs: g.atMs, pairIds: g.pairId ? [g.pairId] : [] });
  }
  const previousCompleted = new Set(previous.pairs.filter(p => p.status === 'completed').map(p => p.id));
  for (const pair of current.pairs) if (pair.status === 'completed' && pair.observationCount === 0 && !previousCompleted.has(pair.id)) {
    recordSharedGap(sharedCoverage, { reason: 'no_post_entry_observation', atMs: nowMs, pairIds: [pair.id] });
  }
  const result = { ...state, policy: structuredClone(state.policy), baseline: { ...state.baseline },
    cursor: { ...arms[0].study.cursor }, updatedAtMs: nowMs, arms, sharedCoverage };
  validateProfitRetentionMultiarm(result);
  return result;
}

const caKey = e => `${e.chain}:${e.chain === 'sol' ? e.address : e.address.toLowerCase()}`;
const legNet = pair => pair.treatment.legs.reduce((total, leg) => total + leg.realizedPnl, 0);
function caRobustness(pairs, net) {
  const grouped = new Map();
  for (const pair of pairs) grouped.set(caKey(pair.entry), (grouped.get(caKey(pair.entry)) ?? 0) + net(pair));
  const rows = [...grouped].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const positive = rows.filter(([, value]) => value > 0), total = rows.reduce((n, [, value]) => n + value, 0);
  const positiveNetUsd = positive.reduce((n, [, value]) => n + value, 0), largest = positive[0];
  return { distinctCAs: rows.length, positiveNetUsd, largestPositiveCA: largest?.[0] ?? null,
    largestPositiveNetUsd: largest?.[1] ?? null, largestPositiveCAShare: largest ? largest[1] / positiveNetUsd : null,
    netExcludingLargestPositiveCAUsd: largest ? total - largest[1] : null };
}
function drawdown(pairs, net) {
  const byCompletion = new Map();
  for (const pair of pairs) byCompletion.set(pair.control.atMs, (byCompletion.get(pair.control.atMs) ?? 0) + net(pair));
  let cumulative = 0, peak = 0, worst = 0;
  for (const [, result] of [...byCompletion].sort((a, b) => a[0] - b[0])) {
    cumulative += result; peak = Math.max(peak, cumulative); worst = Math.max(worst, peak - cumulative);
  }
  return worst;
}
function additionalPerformance(study, sharedCoverage) {
  const pairs = study.pairs.filter(p => p.status === 'completed');
  if (!pairs.length) return null;
  const recoveries = pairs.filter(p => p.treatment.partialTaken).length;
  const foregone = pairs.filter(p => p.treatment.partialTaken && p.control.realizedPnl - legNet(p) > 1e-9);
  const coveredGapIds = new Set(sharedCoverage.byPair.map(p => p.pairId));
  return { completedRounds: pairs.length, recoveries, unrecoveredRounds: pairs.length - recoveries,
    neverTriggeredRounds: pairs.filter(p => p.firstTrigger === null).length, recoveryRate: recoveries / pairs.length,
    observedNeverTriggeredRounds: pairs.filter(p => p.firstTrigger === null).length,
    completedWithCoverageGaps: pairs.filter(p => coveredGapIds.has(p.id)).length,
    coverageMeaning: 'Never-triggered counts mean no trigger in observed quotes only. Completed exit does not establish continuous quote coverage; gaps are not backfilled.',
    foregoneUpsideRounds: foregone.length,
    foregoneUpsideUsd: foregone.reduce((total, p) => total + p.control.realizedPnl - legNet(p), 0),
    foregoneUpsideMeaning: 'Net shortfall versus the same actual main exit after early principal recovery; includes cost differences, not peak-price hindsight.',
    closedRoundDrawdown: { controlMaxDrawdownUsd: drawdown(pairs, p => p.control.realizedPnl), treatmentMaxDrawdownUsd: drawdown(pairs, legNet),
      definition: 'Cumulative completed-round net P&L from zero, ordered by actual completion; simultaneous completions grouped. Not mark-to-market or account drawdown.' },
    caRobustness: { control: caRobustness(pairs, p => p.control.realizedPnl), treatment: caRobustness(pairs, legNet) } };
}

export function profitRetentionMultiarmSummary(state, { nowMs } = {}) {
  validateProfitRetentionMultiarm(state);
  const arms = state.arms.map(({ multiple, study }) => {
    const summary = profitRetentionSummary(study, { nowMs }), additional = additionalPerformance(study, state.sharedCoverage);
    return { multiple, ...summary, performance: summary.performance ? { ...summary.performance, ...additional } : null };
  });
  const first = arms[0];
  return { version: state.version, sessionId: state.sessionId, mode: state.mode, execution: false, signing: false, broadcast: false,
    pairedCohort: true, status: first.status, policy: structuredClone(state.policy), baseline: { ...state.baseline }, cursor: { ...state.cursor },
    startedAtMs: state.baseline.establishedAtMs, updatedAtMs: state.updatedAtMs,
    closedPairs: first.closedPairs, openPairs: first.openPairs, excludedPairs: first.excludedPairs,
    ineligibleEntries: first.ineligibleEntries, admissionStopped: first.admissionStopped, sharedCoverage: structuredClone(state.sharedCoverage), arms,
    note: 'Fixed 2x/3x/5x hypotheses share the same actual entries and control. Do not sum their profits or count the shared baseline three times. All completed rounds include untriggered recoveries; no completed rounds means unknown performance.' };
}
