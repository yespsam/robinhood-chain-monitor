// A range is covered only when every filter succeeds. Once it cannot commit,
// stop admitting more requests, but drain the requests already on the wire.
// Do not cache partial results across retries: they may belong to another fork.
export async function readBscLogFilterBatch(filters, concurrency, query, {
  now = Date.now,
  metrics = {},
} = {}) {
  const startedAt = now();
  Object.assign(metrics, { filters: filters.length, started: 0, completed: 0, failed: 0, skipped: 0, elapsedMs: 0, maxFilterMs: 0 });
  const results = new Array(filters.length);
  let cursor = 0;
  let failure;
  let failed = false;
  const width = Math.max(1, Math.floor(Number(concurrency) || 1));
  await Promise.all(Array.from({ length: Math.min(width, filters.length) }, async () => {
    while (!failed && cursor < filters.length) {
      const index = cursor++;
      const queryStartedAt = now();
      metrics.started += 1;
      try {
        const logs = await query(filters[index]);
        if (!Array.isArray(logs)) throw new Error("eth_getLogs returned a non-array filter result");
        results[index] = logs;
        metrics.completed += 1;
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
        metrics.failed += 1;
      } finally {
        metrics.maxFilterMs = Math.max(metrics.maxFilterMs, Math.max(0, now() - queryStartedAt));
      }
    }
  }));
  metrics.skipped = filters.length - metrics.started;
  metrics.elapsedMs = Math.max(0, now() - startedAt);
  if (failed) throw failure;
  return results;
}
