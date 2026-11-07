// Scheduling only: no data substitution, trading permission or shared-gate changes.
export const FOCUSED_RESEARCH_BUDGET_VERSION = 'chart_budget_hot_lane_v4';

function readEnvInt(env, name, fallback, min, max) {
  const raw = env?.[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw))) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

// Local chart admission only. The shared GMGN gate still owns pacing, the
// critical exit seat and 429 cooldowns. Defaults stay inside a Plus 350ms /
// weight-5 budget: a higher-frequency round may keep a few hot K-lines in
// flight, then yield so details and quotes are not starved.
export function chartPullBudget({ policy = { plan: 'free', normalConcurrency: 1 }, higherFrequency = false,
  entryFocused = false, candidateQuoteInFlight = false, env = {} } = {}) {
  const plus = policy?.plan === 'plus' && policy.normalConcurrency >= 2;
  const yielded = !!(entryFocused || candidateQuoteInFlight);
  // Free stays on the old single pull: its gate is one request every 1.2s.
  // Plus with the higher-frequency paper engine is the congested path, so a
  // round may keep several hot K-lines in flight without taking the exit seat.
  const concurrency = yielded ? 1 : plus && higherFrequency ? 3 : plus ? 2 : 1;
  const dispatchIntervalMs = yielded || !plus ? (plus ? 2500 : 5000) : higherFrequency ? 1500 : 2500;
  const focusedExploratory = yielded ? 1 : plus && higherFrequency ? 3 : plus ? 2 : 1;
  const maxChartsBeforeDetail = yielded || !higherFrequency ? 2 : plus ? 4 : 2;
  return {
    version: 'chart_pull_budget_v1',
    concurrency: readEnvInt(env, 'PAPER_CHART_CONCURRENCY', concurrency, 1, 6),
    dispatchIntervalMs: readEnvInt(env, 'PAPER_CHART_DISPATCH_INTERVAL_MS', dispatchIntervalMs, 250, 15000),
    perRound: readEnvInt(env, 'PAPER_CHART_PER_ROUND', yielded ? 1 : concurrency, 1, 8),
    focusedExploratory: readEnvInt(env, 'PAPER_FOCUSED_CHART_CONCURRENCY', focusedExploratory, 1, 4),
    maxChartsBeforeDetail: readEnvInt(env, 'PAPER_CHARTS_BEFORE_DETAIL', maxChartsBeforeDetail, 1, 12),
    cacheLimit: readEnvInt(env, 'PAPER_CHART_CACHE_LIMIT', plus ? 240 : 160, 100, 500),
    yielded,
  };
}

// At most `maxCharts` hot chart turns before an ordinary detail turn. No new
// shared-gate concurrency or persistent work queue; a late/failed source still backs off.
// A research-only hot quote must not collapse the chart budget. An admitted
// candidate quote still yields, because it shares the normal read seats.
export function quoteBlocksChartBudget(job) {
  return job?.purpose === 'candidate' && job?.token?.researchOnly !== true;
}

export function reserveHotChartTurn({demand,nowMs,listed,due,chartsSinceDetail=0,maxCharts=2}) {
  const cap = Number.isInteger(maxCharts) && maxCharts >= 1 && maxCharts <= 12 ? maxCharts : 2;
  return chartsSinceDetail<cap && !!demand && demand.selectedAt<=nowMs
    && nowMs-demand.selectedAt<=10000 && listed && due
    && demand.token.researchLane==='hot' && Number.isFinite(demand.closedAtMs)
    && demand.closedAtMs<=nowMs && nowMs-demand.closedAtMs>=60000;
}

export function detailGapRetry(previous, missingFields, completedAt) {
  const fields = [...new Set(missingFields)].sort();
  if (!fields.length) return null;
  const signature = JSON.stringify(fields);
  const attempts = previous?.signature === signature ? previous.attempts + 1 : 1;
  const delayMs = Math.min(600000, 60000 * 2 ** Math.min(attempts - 1, 4));
  return {signature, fields, attempts, completedAt, nextAttemptAt: completedAt + delayMs};
}

export function waitsForChartTurn({lastKind, demand, nowMs, listed, due}) {
  return lastKind === 'details' && !!demand && demand.selectedAt <= nowMs
    && nowMs - demand.selectedAt <= 10000 && listed && due;
}
