import { gmgnFlowAddress } from './gmgn-flow-signal.js';

export const FLOW_SCOPE = 'gmgn_public_smartmoney_kol_5m';
const WINDOW = 300_000;

// A page is NOT full-chain coverage. Prove a continuous interval in each
// provider feed using chronological boundaries and overlapping immutable IDs.
export function advanceFeedCoverage(previous, rows, chain, requestedAt, receivedAt) {
  const invalid = !Array.isArray(rows) || rows.some(r => !Number.isSafeInteger(Number(r.timestamp))
    || Number(r.timestamp) <= 0 || Number(r.timestamp) * 1000 > receivedAt + 30_000
    || !gmgnFlowAddress(chain, r.maker) || !gmgnFlowAddress(chain, r.base_address)
    || (r.chain && r.chain !== chain) || !['buy', 'sell'].includes(r.side)
    || !Number.isFinite(Number(r.amount_usd)) || Number(r.amount_usd) <= 0
    || !(chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{64,100}$/ : /^0x[\da-fA-F]{64}$/).test(r.transaction_hash || ''));
  if (invalid) return { valid: false, reason: 'feed_record_invalid', observedAt: receivedAt, keys: [] };
  const times = rows.map(r => Number(r.timestamp) * 1000);
  const keys = rows.map(r => [r.transaction_hash, r.maker, r.base_address, r.side].join(':'));
  const oldest = times.length ? Math.min(...times) + 1000 : requestedAt;
  // A short/empty first page is not proof that no older records were omitted.
  // Warm up from this observation unless a returned record reaches the boundary.
  let startAt = Math.min(requestedAt, oldest);
  const overlaps = previous?.valid === true && Array.isArray(previous.keys)
    && keys.some(k => previous.keys.includes(k));
  const continuous = Number.isFinite(previous?.observedAt) && previous.observedAt <= requestedAt
    && requestedAt - previous.observedAt <= 120_000
    && (oldest <= previous.observedAt || overlaps || (!keys.length && !previous.keys?.length));
  if (previous?.valid === true && continuous && Number.isFinite(previous.startAt)) startAt = Math.min(startAt, previous.startAt);
  return { valid: true, startAt, endAt: requestedAt, observedAt: receivedAt,
    count: rows.length, oldestAt: times.length ? Math.min(...times) : null,
    keys: keys.slice(0, 200), reason: startAt <= requestedAt - WINDOW ? null : 'feed_window_warming_or_gap' };
}

export function flowWindowCoverage(snapshot, nowMs) {
  const feeds = snapshot?.feedCoverage;
  const values = ['smartmoney', 'kol'].map(k => feeds?.[k]);
  const valid = values.every(v => v?.valid === true && Number.isFinite(v.startAt) && v.startAt > 0 && Number.isFinite(v.endAt)
    && v.startAt <= v.endAt && v.endAt <= nowMs + 30_000 && v.endAt >= nowMs - 120_000
    && Number.isFinite(v.observedAt) && v.observedAt >= v.endAt && v.observedAt <= nowMs + 30_000);
  const endAt = valid ? Math.min(...values.map(v => v.endAt)) : null;
  const startAt = endAt === null ? null : endAt - WINDOW;
  const complete = valid && values.every(v => v.startAt <= startAt)
    && !(Number(snapshot?.discardedThroughAt || 0) >= startAt);
  return { scope: FLOW_SCOPE, complete, startAt, endAt,
    reason: complete ? null : values.find(v => v?.valid === false)?.reason || 'feed_window_warming_or_gap' };
}
