import { AsyncLocalStorage } from "node:async_hooks";
import { createAbortableJsonRpcProvider } from "./morph-launchpad-monitor.js";

const CAPABILITY_BACKOFF_MS = 30 * 60_000;
const ACCESS_BACKOFF_MS = 60_000;
const TRANSIENT_BACKOFF_MS = 15_000;
const MAX_METHOD_CIRCUITS_PER_ENDPOINT = 512;
const DEFAULT_RECENT_PINNED_BLOCK_WINDOW = 256;
const MAX_RECENT_PINNED_BLOCK_WINDOW = 1_024;

const boundedInteger = (value, fallback, minimum = 1) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
};

const hostLabel = (value, index) => {
  try { return new URL(value).hostname.toLowerCase() || `rpc-${index + 1}`; }
  catch { return `rpc-${index + 1}`; }
};

const callBlockTag = (args) => {
  const request = args?.[0] && typeof args[0] === "object" ? args[0] : {};
  return request.blockTag ?? args?.[1];
};

const isPinnedBlockTag = (blockTag) => blockTag !== undefined
  && blockTag !== null
  && !["latest", "pending"].includes(String(blockTag).toLowerCase());

const numericBlockTag = (blockTag) => {
  try {
    const value = BigInt(blockTag);
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  } catch { return null; }
};

const failureKind = (error, { recentPinnedRead = false } = {}) => {
  // ethers can wrap an HTTP JSON-RPC error as CALL_EXCEPTION and leave the
  // actionable provider reason only in info.error. Inspect it for circuit
  // classification, but never copy it into the outward aggregate error.
  const message = [
    error?.shortMessage,
    error?.message,
    error?.info?.error?.message,
    error?.error?.message,
    error?.info?.response?.error?.message,
  ].filter(Boolean).join(" ").toLowerCase();
  const status = Number(error?.status ?? error?.statusCode ?? error?.info?.response?.status);
  if (error?.code === "PON_RPC_CHAIN_MISMATCH") return "chain_mismatch";
  if (/archive requests require/i.test(message)) return "archive_unavailable";
  if (/missing trie node/i.test(message)) {
    return recentPinnedRead ? "unavailable" : "capability_unavailable";
  }
  if (/method .{0,80}(?:not found|not available|unsupported)/i.test(message)) {
    return "capability_unavailable";
  }
  if (status === 403 || /\b403\b|forbidden|cloudflare|just a moment/i.test(message)) return "access_denied";
  if (status === 429 || /\b429\b|rate.?limit|too many requests/i.test(message)) return "rate_limited";
  if (error?.code === "TIMEOUT" || /timed out|\btimeout\b|aborted/i.test(message)) return "timeout";
  return "unavailable";
};

const callCircuitKey = (args) => {
  const request = args?.[0] && typeof args[0] === "object" ? args[0] : {};
  const to = String(request.to || "none").toLowerCase();
  const data = String(request.data || "0x").toLowerCase();
  const blockTag = request.blockTag ?? args?.[1] ?? "latest";
  // Full calldata, target, and the exact pinned block are intentional. A
  // generic transient for one getter must not disable other selectors,
  // arguments, or the same selector at a later finalized block. Explicit
  // archive-policy failures additionally use the separate call:pinned family.
  return `call:${to}:${data}:${String(blockTag).toLowerCase()}`;
};

const keyJson = (value) => JSON.stringify(value, (_key, candidate) =>
  typeof candidate === "bigint" ? candidate.toString() : candidate);

const methodKey = (method, args) => {
  if (method === "send") return String(args[0] || "send");
  if (method === "call") return callCircuitKey(args);
  if (method === "getCode") {
    return `getCode:${String(args?.[0] || "none").toLowerCase()}:${String(args?.[1] ?? "latest").toLowerCase()}`;
  }
  if (method === "getBlock") return `getBlock:${String(args?.[0] ?? "latest").toLowerCase()}`;
  if (method === "getLogs") return `getLogs:${keyJson(args?.[0] || {})}`;
  if (["getTransaction", "getTransactionReceipt"].includes(method)) {
    return `${method}:${String(args?.[0] || "none").toLowerCase()}`;
  }
  return method;
};

const archiveFamilyKey = (method, args) => {
  if (method === "call") return `call:${isPinnedBlockTag(callBlockTag(args)) ? "pinned" : "current"}`;
  if (method === "getCode") return `getCode:${isPinnedBlockTag(args?.[1]) ? "pinned" : "current"}`;
  if (method === "getBlock") return `getBlock:${isPinnedBlockTag(args?.[0]) ? "pinned" : "current"}`;
  if (method === "getLogs") {
    const filter = args?.[0] && typeof args[0] === "object" ? args[0] : {};
    const pinned = filter.blockHash != null
      || isPinnedBlockTag(filter.fromBlock)
      || isPinnedBlockTag(filter.toBlock);
    return `getLogs:${pinned ? "pinned" : "current"}`;
  }
  if (["getTransaction", "getTransactionReceipt"].includes(method)) return `${method}:by-hash`;
  return `${method}:current`;
};

const pinnedReadBlock = (method, args) => {
  if (method === "call") return numericBlockTag(callBlockTag(args));
  if (method === "getCode") return numericBlockTag(args?.[1]);
  if (method === "getBlock") return numericBlockTag(args?.[0]);
  if (method !== "getLogs") return null;
  const filter = args?.[0] && typeof args[0] === "object" ? args[0] : {};
  if (filter.blockHash != null) return null;
  const fixedTags = [filter.fromBlock, filter.toBlock].filter(isPinnedBlockTag);
  if (!fixedTags.length) return null;
  const blocks = fixedTags.map(numericBlockTag);
  return blocks.every(Number.isSafeInteger) ? Math.min(...blocks) : null;
};

const operationLabel = (method, args) => method === "send" ? String(args[0] || "send") : method;

/**
 * Build the dedicated pon.fun read-only RPC lane.
 *
 * The returned facade deliberately exposes only the read methods used by the
 * monitor. It has no signer, transaction submission, or broadcast method.
 * Every physical endpoint proves chainId before it can serve any read, and a
 * failure on one endpoint opens a bounded per-method/global circuit before the
 * next independent host is tried.
 */
export function createPonReadOnlyRpcProvider(urls, chainId, options = {}) {
  const uniqueUrls = [...new Set((urls || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!uniqueUrls.length) throw new Error("pon.fun RPC pool requires at least one endpoint");
  const requestTimeoutMs = boundedInteger(options.requestTimeoutMs, 4_000);
  const concurrency = boundedInteger(options.concurrency, 1);
  const now = options.now || Date.now;
  const wallNow = options.wallNow || Date.now;
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 100) || 0);
  const recentPinnedBlockWindow = Math.min(
    MAX_RECENT_PINNED_BLOCK_WINDOW,
    boundedInteger(options.recentPinnedBlockWindow, DEFAULT_RECENT_PINNED_BLOCK_WINDOW),
  );
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = options.fetchImpl || fetch;
  const providerFactory = options.providerFactory
    || ((url) => {
      const requestContext = new AsyncLocalStorage();
      const provider = createAbortableJsonRpcProvider(url, chainId, {
        requestTimeoutMs,
        batchMaxCount: 1,
        fetchImpl: (resource, init = {}) => {
          const control = requestContext.getStore();
          const signal = control?.signal && init.signal
            ? AbortSignal.any([control.signal, init.signal])
            : (control?.signal || init.signal);
          return fetchImpl(resource, { ...init, ...(signal ? { signal } : {}) });
        },
      });
      return {
        provider,
        execute: (method, args, control) => requestContext.run(control, () => provider[method](...args)),
      };
    });
  const endpoints = uniqueUrls.map((url, index) => {
    const created = providerFactory(url, index);
    const adapted = created?.provider && typeof created.execute === "function"
      ? created
      : {
        provider: created,
        execute: (method, args) => created[method](...args),
      };
    return {
      url,
      host: hostLabel(url, index),
      provider: adapted.provider,
      execute: adapted.execute,
      validated: false,
      validation: null,
      permanentFailure: false,
      globalUntil: 0,
      methodUntil: new Map(),
    };
  });
  let destroyed = false;
  let active = 0;
  let observedHead = null;
  const waiters = [];
  const activeInvocations = new Set();

  const destroyedError = () => Object.assign(new Error("pon.fun RPC pool is destroyed"), {
    code: "PON_RPC_DESTROYED",
  });
  const deadlineError = (label) => Object.assign(new Error(`pon.fun ${label} exceeded its shared RPC deadline`), {
    code: "PON_RPC_DEADLINE",
  });

  const assertInvokeActive = (context, label) => {
    if (destroyed) throw destroyedError();
    if (context.controller.signal.aborted) {
      const reason = context.controller.signal.reason;
      throw reason instanceof Error ? reason : deadlineError(label);
    }
    if (wallNow() >= context.deadline) {
      const error = deadlineError(label);
      context.controller.abort(error);
      throw error;
    }
    return context.deadline - wallNow();
  };

  const requestControl = (context, label) => ({
    signal: context.controller.signal,
    timeoutMs: Math.max(1, assertInvokeActive(context, label)),
  });

  const runWithinInvoke = async (context, label, operation) => {
    assertInvokeActive(context, label);
    const signal = context.controller.signal;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => {
        const reason = signal.reason;
        reject(reason instanceof Error ? reason : (destroyed ? destroyedError() : deadlineError(label)));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const value = await Promise.race([Promise.resolve().then(operation), aborted]);
      assertInvokeActive(context, label);
      return value;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };

  const acquire = async () => {
    if (destroyed) throw destroyedError();
    if (active >= concurrency) await new Promise((resolve) => waiters.push(resolve));
    if (destroyed) throw destroyedError();
    active += 1;
  };
  const release = () => {
    active = Math.max(0, active - 1);
    waiters.shift()?.();
  };

  const validateEndpoint = async (endpoint, context, label) => {
    assertInvokeActive(context, label);
    if (endpoint.validated) return;
    if (endpoint.permanentFailure) {
      throw Object.assign(new Error("endpoint chain identity was rejected"), { code: "PON_RPC_CHAIN_MISMATCH" });
    }
    endpoint.validation ||= Promise.resolve()
      .then(() => endpoint.execute("send", ["eth_chainId", []], requestControl(context, label)))
      .then((raw) => {
        assertInvokeActive(context, label);
        const observed = Number(BigInt(raw));
        if (observed !== Number(chainId)) {
          endpoint.permanentFailure = true;
          throw Object.assign(new Error("endpoint chain identity mismatch"), { code: "PON_RPC_CHAIN_MISMATCH" });
        }
        endpoint.validated = true;
      })
      .finally(() => { endpoint.validation = null; });
    await runWithinInvoke(context, label, () => endpoint.validation);
    assertInvokeActive(context, label);
  };

  const recordFailure = (endpoint, operation, family, error, context) => {
    const kind = failureKind(error, context);
    if (kind === "chain_mismatch") endpoint.permanentFailure = true;
    else if (kind === "archive_unavailable") {
      // An explicit provider policy requiring an archive token applies to all
      // fixed-block eth_call requests on that endpoint, not just one selector.
      // Current-state calls and every other read method remain available.
      endpoint.methodUntil.set(family || operation, now() + CAPABILITY_BACKOFF_MS);
    }
    else if (kind === "capability_unavailable") {
      endpoint.methodUntil.set(operation, now() + CAPABILITY_BACKOFF_MS);
    }
    else if (["access_denied", "rate_limited"].includes(kind)) endpoint.globalUntil = now() + ACCESS_BACKOFF_MS;
    else endpoint.methodUntil.set(operation, now() + TRANSIENT_BACKOFF_MS);
    const current = now();
    for (const [key, until] of endpoint.methodUntil) {
      if (Number(until) <= current) endpoint.methodUntil.delete(key);
    }
    while (endpoint.methodUntil.size > MAX_METHOD_CIRCUITS_PER_ENDPOINT) {
      const oldest = [...endpoint.methodUntil.entries()]
        .sort((left, right) => Number(left[1]) - Number(right[1]))[0]?.[0];
      if (!oldest) break;
      endpoint.methodUntil.delete(oldest);
    }
    return kind;
  };

  const invoke = async (method, args) => {
    await acquire();
    let context = null;
    let deadlineTimer = null;
    try {
      const startedAt = wallNow();
      // One final transient recheck may reuse time saved by fast JSON-RPC
      // failures, but it cannot expand the old worst-case budget of one
      // request timeout per configured endpoint.
      const retryDeadline = startedAt + requestTimeoutMs * endpoints.length;
      const operation = methodKey(method, args);
      const family = archiveFamilyKey(method, args);
      const requestedBlock = pinnedReadBlock(method, args);
      const recentPinnedRead = family.endsWith(":pinned")
        && Number.isSafeInteger(requestedBlock)
        && Number.isSafeInteger(observedHead)
        && requestedBlock <= observedHead
        && observedHead - requestedBlock <= recentPinnedBlockWindow;
      const label = operationLabel(method, args);
      const controller = new AbortController();
      context = { controller, deadline: retryDeadline };
      activeInvocations.add(context);
      deadlineTimer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort(deadlineError(label));
      }, Math.max(1, retryDeadline - wallNow()));
      assertInvokeActive(context, label);
      const failures = [];
      const attempted = [];
      const current = now();
      for (const endpoint of endpoints) {
        for (const [key, until] of endpoint.methodUntil) {
          if (Number(until) <= current) endpoint.methodUntil.delete(key);
        }
      }
      const available = endpoints.filter((endpoint) => !endpoint.permanentFailure
        && endpoint.globalUntil <= current
        && Number(endpoint.methodUntil.get(operation) || 0) <= current
        && (!family || Number(endpoint.methodUntil.get(family) || 0) <= current));
      if (!available.length) {
        assertInvokeActive(context, label);
        const retryAt = Math.min(...endpoints
          .filter((endpoint) => !endpoint.permanentFailure)
          .map((endpoint) => Math.max(
            endpoint.globalUntil,
            Number(endpoint.methodUntil.get(operation) || 0),
            family ? Number(endpoint.methodUntil.get(family) || 0) : 0,
          )));
        const error = new Error(`pon.fun ${label} has no ready read-only RPC endpoint`);
        error.code = "PON_RPC_POOL_COOLING";
        error.retryAfterMs = Number.isFinite(retryAt) ? Math.max(1, retryAt - current) : ACCESS_BACKOFF_MS;
        throw error;
      }
      for (const endpoint of available) {
        assertInvokeActive(context, label);
        try {
          await validateEndpoint(endpoint, context, label);
          assertInvokeActive(context, label);
          const value = await runWithinInvoke(
            context,
            label,
            () => endpoint.execute(method, args, requestControl(context, label)),
          );
          assertInvokeActive(context, label);
          if (method === "getBlockNumber") {
            const head = Number(value);
            if (Number.isSafeInteger(head) && head >= 0) observedHead = Math.max(Number(observedHead || 0), head);
          }
          return value;
        } catch (error) {
          assertInvokeActive(context, label);
          const kind = recordFailure(endpoint, operation, family, error, { recentPinnedRead });
          failures.push(`${endpoint.host}:${kind}`);
          attempted.push({ endpoint, kind });
          assertInvokeActive(context, label);
        }
      }
      const retry = attempted.find(({ kind }) => kind === "unavailable");
      const remaining = retryDeadline - wallNow();
      if (retry && remaining >= requestTimeoutMs + retryDelayMs) {
        assertInvokeActive(context, label);
        if (retryDelayMs) await runWithinInvoke(context, label, () => sleep(retryDelayMs));
        assertInvokeActive(context, label);
        if (retryDeadline - wallNow() >= requestTimeoutMs) {
          try {
            const value = await runWithinInvoke(
              context,
              label,
              () => retry.endpoint.execute(method, args, requestControl(context, label)),
            );
            assertInvokeActive(context, label);
            retry.endpoint.methodUntil.delete(operation);
            if (method === "getBlockNumber") {
              const head = Number(value);
              if (Number.isSafeInteger(head) && head >= 0) observedHead = Math.max(Number(observedHead || 0), head);
            }
            return value;
          } catch (error) {
            assertInvokeActive(context, label);
            const kind = recordFailure(retry.endpoint, operation, family, error, { recentPinnedRead });
            failures.push(`${retry.endpoint.host}:${kind}:bounded_recheck`);
            assertInvokeActive(context, label);
          }
        }
      }
      assertInvokeActive(context, label);
      const error = new Error(`pon.fun ${label} failed across independent read-only RPC hosts (${failures.join(", ")})`);
      error.code = "PON_RPC_POOL_FAILED";
      throw error;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (context) activeInvocations.delete(context);
      release();
    }
  };

  return {
    send(method, params = []) {
      if (method !== "eth_chainId") {
        throw Object.assign(new Error("pon.fun RPC facade rejected a non-read control method"), {
          code: "PON_RPC_METHOD_REJECTED",
        });
      }
      return invoke("send", [method, params]);
    },
    getBlockNumber: () => invoke("getBlockNumber", []),
    getBlock: (...args) => invoke("getBlock", args),
    getCode: (...args) => invoke("getCode", args),
    getLogs: (...args) => invoke("getLogs", args),
    call: (...args) => invoke("call", args),
    getTransaction: (...args) => invoke("getTransaction", args),
    getTransactionReceipt: (...args) => invoke("getTransactionReceipt", args),
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const context of activeInvocations) {
        if (!context.controller.signal.aborted) context.controller.abort(destroyedError());
      }
      while (waiters.length) waiters.shift()?.();
      const results = await Promise.allSettled(endpoints.map((endpoint) => endpoint.provider.destroy?.()));
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    },
  };
}
