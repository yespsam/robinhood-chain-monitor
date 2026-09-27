// Forward-only paper evidence: confirmed higher lows, never a peak-percent stop.
import { opportunityChart } from './paper-opportunity-policy.js';
import { gmgnFlowAddress } from './gmgn-flow-signal.js';

export const STRUCTURE_TRAIL_VERSION = 'confirmed_higher_low_v1';
const at = value => typeof value === 'number' ? value : Date.parse(value || '');
export function validStructureTrail(trail, position) {
  return !!trail && trail.version === STRUCTURE_TRAIL_VERSION
    && Number.isFinite(trail.level) && trail.level > position.entryPrice
    && Number.isFinite(at(trail.pivotAt)) && at(trail.pivotAt) >= at(position.openedAt)
    && at(trail.confirmedAt) === at(trail.pivotAt) + 180000
    && at(trail.observedAt) >= at(trail.confirmedAt)
    && at(trail.observedAt) <= at(position.markAt);
}

export function advanceStructureTrail(position, mark) {
  const previous = position.structureTrail || null, source = mark.structureChart;
  if (!source?.ready || source.chain !== position.chain
    || gmgnFlowAddress(position.chain, source.address) !== gmgnFlowAddress(position.chain, position.address)) return previous;
  const observed = at(mark.observedAt), chart = opportunityChart(source.rows, 'ok', observed);
  if (!chart.ready || chart.rows.length < 24) return previous;
  const original = position.entryEvidence?.opportunity;
  const anchor = original?.basis === 'ohlcv' ? original.pattern?.reclaimPrice : null;
  let trail = previous;
  // Two bars on each side confirm a local swing low. The right-hand bars must
  // have CLOSED; a wick, an unfinished bar or a pre-entry pivot never qualifies.
  for (let i = 2; i < chart.rows.length - 2; i++) {
    const rows = chart.rows, pivot = rows[i], confirmation = rows[i + 2];
    const level = Math.max(position.entryPrice, Number.isFinite(anchor) ? anchor : 0, trail?.level || 0);
    if (pivot.time < at(position.openedAt) || pivot.low <= level
      || pivot.low >= rows[i - 1].low || pivot.low >= rows[i - 2].low
      || pivot.low >= rows[i + 1].low || pivot.low >= confirmation.low
      || confirmation.close <= pivot.high || confirmation.time + 60000 > observed) continue;
    trail = { version: STRUCTURE_TRAIL_VERSION, level: pivot.low,
      pivotAt: new Date(pivot.time).toISOString(), confirmedAt: new Date(confirmation.time + 60000).toISOString(),
      observedAt: mark.observedAt };
  }
  return trail;
}
