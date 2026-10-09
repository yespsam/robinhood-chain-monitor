// This queue contains bounded wakeups only. Authoritative work and cursors
// remain in the scan WAL; refusing a wakeup never marks a task complete.
export function createBscReplayScheduler({ now = Date.now, maxPending = 8, retryState = new Map() } = {}) {
  const jobs = new Map(), queue = [], retries = retryState;
  let active = null, stopped = false;
  const stats = { started: 0, completed: 0, failed: 0, joined: 0, capacityYields: 0, cooldownYields: 0, cancelled: 0, expired: 0 };
  function pump() {
    if (active || stopped) return;
    let job = queue.shift();
    while (job && job.deadlineAt <= now()) {
      jobs.delete(job.key); stats.expired++; job.resolve(false); job = queue.shift();
    }
    if (!job) return;
    active = job;
    stats.started++;
    job.startedAt = now();
    Promise.resolve().then(job.operation).then(value => {
      retries.delete(job.key); stats.completed++; job.resolve(value);
    }, error => {
      if (!stopped) {
        const failures = (retries.get(job.key)?.failures || 0) + 1;
        const delay = Math.max(Math.min(60_000, 5000 * 2 ** Math.min(failures - 1, 4)),
          Number(error?.retryAfterMs) || 0, Number(error?.rpcHostRetryAfterMs) || 0);
        retries.delete(job.key);
        retries.set(job.key, { failures, until: now() + delay });
        while (retries.size > 256) retries.delete(retries.keys().next().value);
      }
      stats.failed++; job.reject(error);
    }).finally(() => { jobs.delete(job.key); active = null; pump(); });
  }
  function run(key, operation, { deadlineAt = Infinity } = {}) {
    if (stopped) return Promise.resolve(false);
    if (jobs.has(key)) { stats.joined++; return jobs.get(key).promise; }
    if ((retries.get(key)?.until || 0) > now()) { stats.cooldownYields++; return Promise.resolve(false); }
    if (active && queue.length >= maxPending) { stats.capacityYields++; return Promise.resolve(false); }
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { key, operation, promise, resolve, reject, deadlineAt };
    jobs.set(key, job); queue.push(job); pump();
    return promise;
  }
  return {
    run,
    async idle() { while (jobs.size) { await Promise.allSettled([...jobs.values()].map(job => job.promise)); await Promise.resolve(); } },
    stop() {
      stopped = true;
      for (const job of queue.splice(0)) { jobs.delete(job.key); stats.cancelled++; job.resolve(false); }
    },
    snapshot: () => ({ ...stats, active: active ? 1 : 0, pending: queue.length, maxPending,
      activeFamily: active?.key.split(":")[0] || null,
      activeAgeMs: active ? Math.max(0, now() - active.startedAt) : 0, stopped }),
  };
}
