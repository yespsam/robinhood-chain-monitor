// Admission/retry budget, not a Promise.race around an uncancelled RPC. A
// started transport keeps its original timeout and physical-host lease.
export function createRpcStateReadBudget({ budgetMs = 0, maxAttempts = 2, now = Date.now, label = "state-read" } = {}) {
  const enabled = Number(budgetMs) > 0;
  const limit = Math.max(1, Math.min(4, Math.floor(maxAttempts) || 2));
  const inFlight = new Map();
  const stats = { calls: 0, joined: 0, succeeded: 0, failed: 0, exhausted: 0, endpointAttempts: 0, active: 0, lastDurationMs: 0, maxDurationMs: 0 };
  const encode = value => {
    if (value === null) return ["null"];
    if (Array.isArray(value)) return ["array", value.map(encode)];
    if (typeof value === "object") {
      if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("non-plain RPC argument");
      return ["object", Object.entries(value).map(([key, item]) => [key, encode(item)])];
    }
    if (!["string", "number", "boolean", "bigint", "undefined"].includes(typeof value)) throw new Error("unsupported RPC argument");
    return [typeof value, String(value)];
  };
  const keyFor = (method, args) => {
    try { const key = JSON.stringify([method, encode(args)]); return key.length <= 8192 ? key : null; }
    catch { return null; }
  };
  function context(method) {
    const deadline = now() + Number(budgetMs);
    let attempts = 0, failure = null;
    const exhausted = () => {
      if (!failure) {
        stats.exhausted++;
        failure = Object.assign(new Error(`${method} ${label} retry budget exhausted; evidence retained for retry`), {
          code: "SERVER_ERROR", rpcOperation: method, rpcFailureScope: "method",
          rpcBudgetExhausted: true, rpcCircuitAlreadyOpen: true, retryAfterMs: 1000,
        });
      }
      return failure;
    };
    return {
      remaining: () => Math.max(0, deadline - now()),
      exhausted,
      checkTime(reserveMs = 0) {
        if (failure || deadline - now() <= Math.max(0, reserveMs)) throw exhausted();
      },
      check(reserveMs = 0) {
        this.checkTime(reserveMs);
        if (attempts >= limit) throw exhausted();
      },
      attempt(reserveMs) {
        this.check(reserveMs);
        attempts++; stats.endpointAttempts++;
      },
    };
  }
  function run(method, args, operation) {
    if (!enabled) return operation(null);
    stats.calls++;
    const key = keyFor(method, args);
    if (key && inFlight.has(key)) { stats.joined++; return inFlight.get(key); }
    const started = now(), budget = context(method);
    stats.active++;
    // Only overlapping, exactly identical requests share a result. No success
    // cache survives settlement, and no block tag is changed to latest.
    let work;
    work = Promise.resolve().then(() => operation(budget)).then(result => {
      stats.succeeded++; return result;
    }, error => { stats.failed++; throw error; }).finally(() => {
      stats.active--;
      stats.lastDurationMs = Math.max(0, now() - started);
      stats.maxDurationMs = Math.max(stats.maxDurationMs, stats.lastDurationMs);
      if (key && inFlight.get(key) === work) inFlight.delete(key);
    });
    if (key && inFlight.size < 128) inFlight.set(key, work);
    return work;
  }
  return { run, snapshot: () => ({ enabled, budgetMs, maxAttempts: limit, ...stats, coalescedKeys: inFlight.size }) };
}

// Source selection only, never a state/result cache. A recent successful
// historical read is preferable to rotating the two-attempt budget onto
// unproven hosts. Keep latest/pending/history and methods/pools separate;
// the caller still applies host cooldowns, leases and original block tags.
export function createRpcStateSourceAffinity({ now = Date.now, ttlMs = 60_000 } = {}) {
  const successes = new Map();
  let preferredSelections = 0;
  const keyFor = (pool, method, args) => {
    if (!['getCode', 'getStorage', 'call'].includes(method)) return null;
    const tag = method === 'call' ? args[0]?.blockTag : args[method === 'getCode' ? 1 : 2];
    const scope = tag == null || tag === 'latest' ? 'latest' : tag === 'pending' ? 'pending' : 'historical';
    return `${pool}:${method}:${scope}`;
  };
  const active = (key, index) => {
    const at = successes.get(key)?.get(index);
    return Number.isFinite(at) && at <= now() && now() - at < ttlMs;
  };
  return {
    order(pool, method, args, indices) {
      const key = keyFor(pool, method, args);
      if (!key) return indices;
      const preferred = indices.filter(index => active(key, index));
      if (preferred.length && preferred[0] !== indices[0]) preferredSelections++;
      return [...preferred, ...indices.filter(index => !active(key, index))];
    },
    success(pool, method, args, index) {
      const key = keyFor(pool, method, args);
      if (!key) return;
      if (!successes.has(key)) successes.set(key, new Map());
      successes.get(key).set(index, now());
    },
    failure(pool, method, args, index) { successes.get(keyFor(pool, method, args))?.delete(index); },
    snapshot: () => ({ mode: 'recent_success_v1', ttlMs, preferredSelections }),
  };
}

export function createRpcPoolSlots(capacity) {
  const limit = Math.max(1, Number(capacity) || 1);
  let active = 0;
  const waiting = [];
  function acquire(budget) {
    budget?.check();
    if (active < limit) { active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, timer: null };
      waiting.push(waiter);
      if (budget) waiter.timer = setTimeout(() => {
        const index = waiting.indexOf(waiter);
        if (index < 0) return;
        waiting.splice(index, 1);
        reject(budget.exhausted());
      }, budget.remaining());
    });
  }
  function release() {
    const next = waiting.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
    else active--;
  }
  return {
    async run(operation, budget = null) {
      await acquire(budget);
      try { budget?.check(); return await operation(); }
      finally { release(); }
    },
    snapshot: () => ({ active, waiting: waiting.length, limit }),
  };
}
