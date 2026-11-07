// Shared by in-process and cross-process queues. Aging may promote background
// work into the normal FIFO, never above exits / admitted confirmations.
// A candidate K-line outranks address notes, aged background work and ordinary
// priority-1 feeds. A background K-line only outranks other priority-0 work
// until it ages into that FIFO. Exits stay strictly first.
export const READONLY_ADMISSION_VERSION = 'kline_before_background_v2';
function scoreReadonly(item, nowMs, agingMs) {
  if (item.priority === 2) return 4;
  const aged = Math.floor(Math.max(0, nowMs - item.queuedAt) / agingMs) > 0;
  // Candidate/hot K-lines sit above aged notes and ordinary priority-1 feeds.
  // A background K-line only steps ahead of other priority-0 work until it ages
  // into the normal FIFO. Exits stay strictly first.
  if (item.kind === 'market:kline' && item.priority >= 1) return 3;
  if (item.kind === 'market:kline') return aged ? 2 : 1;
  if (item.priority >= 1) return 2;
  return aged ? 2 : 0;
}
export function compareReadonlyWork(a, b, nowMs, agingMs) {
  return scoreReadonly(b, nowMs, agingMs) - scoreReadonly(a, nowMs, agingMs)
    || a.queuedAt - b.queuedAt
    || String(a.token || '').localeCompare(String(b.token || ''));
}

export function canAdmitReadonly(item, active, limits) {
  if (active.length >= limits.concurrency) return false;
  if (item.priority === 2) return true;
  if (active.filter(job => job.priority !== 2).length >= limits.normalConcurrency) return false;
  // Under Plus, background work may use only one normal seat. The other stays
  // available for live feeds/candidates; the critical seat is still reserved.
  return item.priority !== 0 || !active.some(job => job.priority === 0);
}
