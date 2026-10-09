// Scheduling only: no data substitution, trading permission or shared-gate changes.
export const FOCUSED_RESEARCH_BUDGET_VERSION = 'deadline_chart_detail_turn_v3';

// At most one extra chart before an ordinary detail turn. No new concurrency,
// priority elevation or persistent work queue; a late/failed source still backs off.
export function reserveHotChartTurn({demand,nowMs,listed,due,chartsSinceDetail=0}) {
  return chartsSinceDetail<2 && !!demand && demand.selectedAt<=nowMs
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
