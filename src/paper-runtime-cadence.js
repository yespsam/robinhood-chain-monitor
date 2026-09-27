// Start-to-start cadence, without overlapping work or catch-up bursts when a
// cycle exceeds its budget. Yield a little time even after a slow cycle.
export function nextScanDelay(intervalMs, startedAt, nowMs) {
  return Math.max(25, intervalMs - Math.max(0, nowMs - startedAt));
}
