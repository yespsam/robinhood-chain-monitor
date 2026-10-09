// Shared by in-process and cross-process queues. Aging may promote background
// work into the normal FIFO, never above exits / admitted confirmations.
export const READONLY_ADMISSION_VERSION = 'critical_first_background_one_v1';
export function compareReadonlyWork(a, b, nowMs, agingMs) {
  const score = item => item.priority === 2 ? 2
    : Math.min(1, item.priority + Math.floor(Math.max(0, nowMs - item.queuedAt) / agingMs));
  return score(b) - score(a) || a.queuedAt - b.queuedAt
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
