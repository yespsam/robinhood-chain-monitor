// This queue contains bounded wakeups only. Authoritative work and cursors
// remain in the scan WAL; refusing a wakeup never marks a task complete.
const retryDelay = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.ceil(Number(value)) : 0;

// Typed admission/cooldown or an explicitly exhausted bounded RPC operation
// stops later keys from immediately spending another budget on this route.
// Ordinary aggregate method failures may retain usable alternatives and do
// not imply route exhaustion. Yielding never changes the failure's scope.
export function isBscReplayResourceWait(error) {
  return error?.rpcBudgetExhausted === true
    || error?.rpcFailureScope === "capacity"
    || error?.rpcFailureScope === "host" && (
      retryDelay(error?.retryAfterMs) > 0 || retryDelay(error?.rpcHostRetryAfterMs) > 0
      || error?.rpcCircuitAlreadyOpen === true
      || [error?.status, error?.statusCode, error?.code].some(value => Number(value) === 429)
    );
}

export function createBscReplayScheduler({ now = Date.now, maxPending = 8, retryState = new Map() } = {}) {
  const jobs = new Map(), queue = [], retries = retryState;
  // Shared retryState binds the same durable key across fresh/maintenance
  // lanes. Resource pressure belongs only to this scheduler's RPC route.
  let active = null, stopped = false, routeRetryAt = 0;
  const stats = { started: 0, completed: 0, failed: 0, joined: 0, capacityYields: 0, cooldownYields: 0, cancelled: 0, expired: 0 };
  function pump() {
    if (active || stopped) return;
    let job = queue.shift();
    while (job && (job.deadlineAt <= now() || routeRetryAt > now() || (retries.get(job.key)?.until || 0) > now())) {
      jobs.delete(job.key);
      if (job.deadlineAt <= now()) stats.expired++;
      else stats.cooldownYields++;
      // A refused wakeup leaves authoritative work and prior retry evidence
      // intact. The existing cadence may submit it again after the deadline.
      job.resolve(false); job = queue.shift();
    }
    if (!job) return;
    active = job;
    stats.started++;
    job.startedAt = now();
    Promise.resolve().then(job.operation).then(value => {
      retries.delete(job.key); stats.completed++; job.resolve(value);
    }, error => {
      if (!stopped) {
        const capacityOnly = error?.rpcFailureScope === "capacity"
          && retryDelay(error?.rpcHostRetryAfterMs) === 0 && !error?.rpcHostFailure;
        const failures = (retries.get(job.key)?.failures || 0) + (capacityOnly ? 0 : 1);
        // Local admission pressure is not another upstream outage. Preserve
        // earlier genuine failures and their delay, but do not amplify them.
        const delay = Math.max(Math.min(60_000, 5000 * 2 ** Math.min(Math.max(0, failures - 1), 4)),
          retryDelay(error?.retryAfterMs), retryDelay(error?.rpcHostRetryAfterMs));
        const until = now() + delay;
        retries.delete(job.key);
        retries.set(job.key, { failures, until });
        if (isBscReplayResourceWait(error)) routeRetryAt = Math.max(routeRetryAt, until);
        while (retries.size > 256) retries.delete(retries.keys().next().value);
      }
      stats.failed++; job.reject(error);
    }).finally(() => { jobs.delete(job.key); active = null; pump(); });
  }
  function run(key, operation, { deadlineAt = Infinity } = {}) {
    if (stopped) return Promise.resolve(false);
    if (jobs.has(key)) { stats.joined++; return jobs.get(key).promise; }
    if (routeRetryAt > now() || (retries.get(key)?.until || 0) > now()) { stats.cooldownYields++; return Promise.resolve(false); }
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
      activeAgeMs: active ? Math.max(0, now() - active.startedAt) : 0,
      routeCooldownRemainingMs: Math.max(0, routeRetryAt - now()), stopped }),
  };
}
