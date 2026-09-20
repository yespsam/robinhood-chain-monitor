export const NARRATIVE_SHADOW_SIMULATOR_VERSION = 1;
export const NARRATIVE_SHADOW_SIMULATOR_SCHEMA = "narrative_shadow_simulator_v1";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/u;
const BLOCK_HASH_RE = /^0x[0-9a-f]{64}$/u;
const HASH_RE = /^[0-9a-f]{64}$/u;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/u;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const TERMINAL_STATUSES = new Set(["closed", "expired", "invalidated"]);

const exactKeys = (value, expected) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && wanted.every((key, index) => key === actual[index]);
};

const clone = (value) => structuredClone(value);

function positiveInteger(value, fallback, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${label} must be a positive integer`);
  return parsed;
}

function boundedInteger(value, fallback, label, minimum, maximum) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function timestamp(value, label) {
  if (typeof value !== "string") throw new EvidenceError("identity", `${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new EvidenceError("identity", `${label} must be an exact ISO timestamp`);
  }
  return parsed;
}

function clockMilliseconds(now) {
  const value = Number(now());
  if (!Number.isFinite(value)) throw new TypeError("narrative shadow simulator clock must be finite");
  return value;
}

function lowerAddress(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!ADDRESS_RE.test(normalized) || /^0x0{40}$/u.test(normalized)) {
    throw new EvidenceError("identity", `${label} must be a non-zero EVM address`);
  }
  return normalized;
}

function uintString(value, label, { positive = false } = {}) {
  if (typeof value !== "string" || value.length > 78 || !UINT_RE.test(value) || (positive && value === "0")) {
    throw new EvidenceError("quote", `${label} must be a canonical${positive ? " positive" : ""} integer string`);
  }
  return value;
}

function safeBlockNumber(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EvidenceError("identity", `${label} must be a non-negative safe integer`);
  }
  return value;
}

function boundedReason(value, label) {
  if (typeof value !== "string") throw new EvidenceError("unknown", `${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/u.test(normalized)) {
    throw new EvidenceError("unknown", `${label} is invalid`);
  }
  return normalized;
}

class EvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NarrativeShadowEvidenceError";
    this.code = code;
  }
}

function validateLedger(ledger) {
  if (!ledger || typeof ledger !== "object") throw new TypeError("narrative shadow ledger is required");
  for (const method of ["getState", "getOrder", "open", "mark", "close", "expire", "invalidate"]) {
    if (typeof ledger[method] !== "function") throw new TypeError(`narrative shadow ledger.${method} is required`);
  }
  if (!(typeof ledger.getMetrics === "function" || typeof ledger.metrics === "function")) {
    throw new TypeError("narrative shadow ledger metrics method is required");
  }
  return ledger;
}

function validateQuoteProvider(provider) {
  const keys = [
    "checkCanonicalBlock", "getEntryQuote", "getPositionMark", "providerId", "readOnly", "trusted",
  ];
  if (!exactKeys(provider, keys)) throw new TypeError("quoteProvider must expose only the trusted read-only market-data interface");
  if (provider.trusted !== true || provider.readOnly !== true || !PROVIDER_ID_RE.test(String(provider.providerId || ""))) {
    throw new TypeError("quoteProvider must be explicitly trusted, read-only, and have a stable providerId");
  }
  for (const method of ["checkCanonicalBlock", "getEntryQuote", "getPositionMark"]) {
    if (typeof provider[method] !== "function") throw new TypeError(`quoteProvider.${method} is required`);
  }
  return provider;
}

function unknownResult(value, label) {
  if (!exactKeys(value, ["reason", "status"]) || value.status !== "unknown") {
    throw new EvidenceError("identity", `${label} returned an invalid unknown result`);
  }
  return { status: "unknown", reason: boundedReason(value.reason, `${label}.reason`) };
}

function assertFreshObservation(observedAt, nowMs, policy, label) {
  const observedMs = timestamp(observedAt, `${label}.observedAt`);
  if (observedMs > nowMs + policy.maximumFutureSkewMs) {
    throw new EvidenceError("stale", `${label} observation is from the future`);
  }
  if (nowMs - observedMs > policy.maximumObservationAgeMs) {
    throw new EvidenceError("stale", `${label} observation is stale`);
  }
  return observedMs;
}

function normalizeCanonicalResult(value, expected, provider, nowMs, policy) {
  if (value?.status === "unknown") return unknownResult(value, "canonical block check");
  const keys = ["blockHash", "blockNumber", "chainId", "observedAt", "providerId", "status"];
  if (!exactKeys(value, keys) || value.status !== "ok") {
    throw new EvidenceError("identity", "canonical block check returned an invalid shape");
  }
  if (value.providerId !== provider.providerId
    || value.chainId !== expected.chainId
    || value.blockNumber !== expected.blockNumber) {
    throw new EvidenceError("identity", "canonical block check identity mismatch");
  }
  const blockHash = String(value.blockHash || "").toLowerCase();
  if (!BLOCK_HASH_RE.test(blockHash)) throw new EvidenceError("identity", "canonical block hash is invalid");
  assertFreshObservation(value.observedAt, nowMs, policy, "canonical block check");
  return {
    status: blockHash === expected.blockHash ? "canonical" : "reorg",
    actualBlockHash: blockHash,
    observedAt: value.observedAt,
  };
}

function normalizeQuote(value, expected, provider, nowMs, policy) {
  if (value?.status === "unknown") return unknownResult(value, `${expected.kind} quote`);
  const keys = [
    "blockHash", "blockNumber", "blockTimestamp", "ca", "chainId", "estimatedSlippageBps",
    "kind", "marketExecutable", "observedAt", "poolAddress", "priceUsdMicros", "providerId",
    "quantityRaw", "routeDigest", "side", "status", "validUntil", "valueUsdMicros",
  ];
  if (!exactKeys(value, keys) || value.status !== "ok") {
    throw new EvidenceError("identity", `${expected.kind} quote returned an invalid shape`);
  }
  const ca = lowerAddress(value.ca, `${expected.kind}.ca`);
  const poolAddress = lowerAddress(value.poolAddress, `${expected.kind}.poolAddress`);
  if (value.providerId !== provider.providerId
    || value.kind !== expected.kind
    || value.side !== expected.side
    || value.chainId !== expected.chainId
    || ca !== expected.ca
    || poolAddress !== expected.poolAddress) {
    throw new EvidenceError("identity", `${expected.kind} quote identity mismatch`);
  }
  if (value.marketExecutable !== true) {
    throw new EvidenceError("quote", `${expected.kind} quote is not market-executable`);
  }
  const blockNumber = safeBlockNumber(value.blockNumber, `${expected.kind}.blockNumber`);
  const blockHash = String(value.blockHash || "").toLowerCase();
  if (!BLOCK_HASH_RE.test(blockHash)) throw new EvidenceError("identity", `${expected.kind}.blockHash is invalid`);
  const blockTimestampMs = timestamp(value.blockTimestamp, `${expected.kind}.blockTimestamp`);
  const observedAtMs = assertFreshObservation(value.observedAt, nowMs, policy, `${expected.kind} quote`);
  const validUntilMs = timestamp(value.validUntil, `${expected.kind}.validUntil`);
  if (blockTimestampMs > observedAtMs
    || blockTimestampMs > nowMs + policy.maximumFutureSkewMs
    || nowMs - blockTimestampMs > policy.maximumBlockAgeMs) {
    throw new EvidenceError("stale", `${expected.kind} quote block time is stale or inconsistent`);
  }
  if (validUntilMs < nowMs || validUntilMs < observedAtMs
    || validUntilMs - observedAtMs > policy.maximumQuoteValidityMs) {
    throw new EvidenceError("stale", `${expected.kind} quote validity window is stale or excessive`);
  }
  if (!Number.isSafeInteger(value.estimatedSlippageBps)
    || value.estimatedSlippageBps < 0
    || value.estimatedSlippageBps > expected.maximumSlippageBps) {
    throw new EvidenceError("quote", `${expected.kind} quote exceeds the shadow slippage policy`);
  }
  const valueUsdMicros = uintString(value.valueUsdMicros, `${expected.kind}.valueUsdMicros`, { positive: true });
  const quantityRaw = uintString(value.quantityRaw, `${expected.kind}.quantityRaw`, { positive: true });
  const priceUsdMicros = uintString(value.priceUsdMicros, `${expected.kind}.priceUsdMicros`, { positive: true });
  if (expected.valueUsdMicros !== null && valueUsdMicros !== expected.valueUsdMicros) {
    throw new EvidenceError("quote", `${expected.kind} quote notional mismatch`);
  }
  if (expected.quantityRaw !== null && quantityRaw !== expected.quantityRaw) {
    throw new EvidenceError("quote", `${expected.kind} quote quantity mismatch`);
  }
  const routeDigest = String(value.routeDigest || "").toLowerCase();
  if (!HASH_RE.test(routeDigest)) throw new EvidenceError("quote", `${expected.kind}.routeDigest is invalid`);
  return {
    status: "ok",
    chainId: value.chainId,
    ca,
    poolAddress,
    blockNumber,
    blockHash,
    blockTimestamp: value.blockTimestamp,
    observedAt: value.observedAt,
    validUntil: value.validUntil,
    valueUsdMicros,
    quantityRaw,
    priceUsdMicros,
    routeDigest,
    estimatedSlippageBps: value.estimatedSlippageBps,
  };
}

function assertQuoteFreshAtMutation(quote, nowMs, policy, label) {
  const blockTimestampMs = timestamp(quote.blockTimestamp, `${label}.blockTimestamp`);
  const observedAtMs = assertFreshObservation(quote.observedAt, nowMs, policy, label);
  const validUntilMs = timestamp(quote.validUntil, `${label}.validUntil`);
  if (blockTimestampMs > observedAtMs
    || blockTimestampMs > nowMs + policy.maximumFutureSkewMs
    || nowMs - blockTimestampMs > policy.maximumBlockAgeMs) {
    throw new EvidenceError("stale", `${label} block time became stale or inconsistent before ledger mutation`);
  }
  if (validUntilMs < nowMs || validUntilMs < observedAtMs
    || validUntilMs - observedAtMs > policy.maximumQuoteValidityMs) {
    throw new EvidenceError("stale", `${label} validity window expired before ledger mutation`);
  }
}

function assertQuoteCausality(order, kind, quote) {
  if (quote.status !== "ok") return;
  if (kind === "entry") {
    const sourceObservedAtMs = timestamp(order.sourceProof?.observedAt, "sourceProof.observedAt");
    const orderCreatedAtMs = timestamp(order.createdAt, "order.createdAt");
    const entryBlockTimestampMs = timestamp(quote.blockTimestamp, "entry.blockTimestamp");
    const entryObservedAtMs = timestamp(quote.observedAt, "entry.observedAt");
    if (entryObservedAtMs < sourceObservedAtMs) {
      throw new EvidenceError("stale", "entry quote observation precedes the source signal");
    }
    if (entryBlockTimestampMs < Math.max(sourceObservedAtMs, orderCreatedAtMs)) {
      throw new EvidenceError("stale", "entry quote block time precedes shadow admission");
    }
    if (order.sourceProof?.kind === "onchain") {
      const sourceBlockNumber = safeBlockNumber(
        order.sourceProof.blockNumber,
        "sourceProof.blockNumber",
      );
      if (quote.blockNumber < sourceBlockNumber) {
        throw new EvidenceError("stale", "entry quote block precedes the on-chain signal");
      }
      if (quote.blockNumber === sourceBlockNumber
        && quote.blockHash !== String(order.sourceProof.blockHash || "").toLowerCase()) {
        throw new EvidenceError("identity", "entry quote conflicts with the on-chain signal block");
      }
    }
  }
  if (kind === "mark") {
    if (!order.entry) throw new EvidenceError("identity", "mark quote requires a persisted entry");
    const entryBlockNumber = safeBlockNumber(order.entry.blockNumber, "entry.blockNumber");
    if (quote.blockNumber < entryBlockNumber) {
      throw new EvidenceError("stale", "mark quote block precedes the shadow entry");
    }
    if (quote.blockNumber === entryBlockNumber && quote.blockHash !== order.entry.blockHash) {
      throw new EvidenceError("identity", "mark quote conflicts with the shadow entry block");
    }
    const entryObservedAtMs = timestamp(order.entry.observedAt, "entry.observedAt");
    const markBlockTimestampMs = timestamp(quote.blockTimestamp, "mark.blockTimestamp");
    const markObservedAtMs = timestamp(quote.observedAt, "mark.observedAt");
    if (markBlockTimestampMs < entryObservedAtMs) {
      throw new EvidenceError("stale", "mark quote block time precedes the shadow entry");
    }
    if (markObservedAtMs < entryObservedAtMs) {
      throw new EvidenceError("stale", "mark quote observation precedes the shadow entry");
    }
  }
}

function ledgerSnapshot(quote) {
  return {
    chainId: quote.chainId,
    ca: quote.ca,
    poolAddress: quote.poolAddress,
    blockNumber: quote.blockNumber,
    blockHash: quote.blockHash,
    observedAt: quote.observedAt,
    valueUsdMicros: quote.valueUsdMicros,
    quantityRaw: quote.quantityRaw,
    priceUsdMicros: quote.priceUsdMicros,
    routeDigest: quote.routeDigest,
  };
}

function action(type, orderId, details = {}) {
  return Object.freeze({
    type,
    orderId,
    ...details,
    mode: "shadow",
    executable: false,
  });
}

function executionReason(order, mark, nowMs, policy) {
  const entryValue = BigInt(order.entry.valueUsdMicros);
  const markValue = BigInt(mark.valueUsdMicros);
  if (markValue * 10_000n <= entryValue * BigInt(10_000 - policy.stopLossBps)) return "stop_loss";
  if (markValue * 10_000n >= entryValue * BigInt(10_000 + policy.takeProfitBps)) return "take_profit";
  if (nowMs - Date.parse(order.entry.observedAt) >= policy.timeStopMs) return "time_stop";
  return null;
}

function orderEvidence(order) {
  const evidence = [];
  if (order.sourceProof?.kind === "onchain") {
    evidence.push({
      kind: "source",
      chainId: order.sourceProof.chainId,
      blockNumber: order.sourceProof.blockNumber,
      blockHash: String(order.sourceProof.blockHash || "").toLowerCase(),
    });
  }
  // Lifecycle decisions only depend on entry, the latest priced observation,
  // and exit. Historical marks remain in the ledger audit trail but are not
  // re-queried every cycle.
  const snapshots = [
    ["entry", order.entry],
    ...(order.status === "open" ? [["latest_mark", order.latestMark]] : []),
    ...(TERMINAL_STATUSES.has(order.status) ? [["exit", order.exit]] : []),
  ];
  for (const [kind, snapshot] of snapshots) {
    if (!snapshot) continue;
    evidence.push({
      kind,
      chainId: snapshot.chainId,
      blockNumber: snapshot.blockNumber,
      blockHash: String(snapshot.blockHash || "").toLowerCase(),
    });
  }
  const unique = new Map();
  for (const item of evidence) {
    const coordinate = `${item.chainId}:${item.blockNumber}`;
    const previous = unique.get(coordinate);
    if (previous && previous.blockHash !== item.blockHash) {
      return { conflict: true, evidence: [previous, item] };
    }
    unique.set(coordinate, item);
  }
  return { conflict: false, evidence: [...unique.values()] };
}

function immutableRequest(value) {
  return Object.freeze(value);
}

/**
 * Drives a persisted narrative shadow ledger using only injected, trusted,
 * read-only market evidence. It intentionally exposes no transaction path.
 */
export function createNarrativeShadowSimulator(config = {}, dependencies = {}) {
  if (config.narrativeShadowSimulatorEnabled !== true) {
    throw new TypeError("narrative shadow simulator may only be created when explicitly enabled");
  }
  const ledger = validateLedger(dependencies.ledger);
  const quoteProvider = validateQuoteProvider(dependencies.quoteProvider);
  const now = dependencies.now || Date.now;
  const timers = dependencies.timers || globalThis;
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof timers.setTimeout !== "function" || typeof timers.clearTimeout !== "function") {
    throw new TypeError("timers must expose setTimeout and clearTimeout");
  }
  const policy = Object.freeze({
    intervalMs: positiveInteger(config.narrativeShadowMarkIntervalMs, 5_000, "narrativeShadowMarkIntervalMs"),
    maximumObservationAgeMs: positiveInteger(config.narrativeShadowQuoteMaxAgeMs, 15_000, "narrativeShadowQuoteMaxAgeMs"),
    maximumBlockAgeMs: positiveInteger(config.narrativeShadowQuoteBlockMaxAgeMs, 30_000, "narrativeShadowQuoteBlockMaxAgeMs"),
    maximumQuoteValidityMs: positiveInteger(config.narrativeShadowQuoteMaxValidityMs, 30_000, "narrativeShadowQuoteMaxValidityMs"),
    maximumFutureSkewMs: boundedInteger(config.narrativeShadowQuoteFutureSkewMs, 1_000, "narrativeShadowQuoteFutureSkewMs", 0, 60_000),
    takeProfitBps: boundedInteger(config.narrativeShadowTakeProfitBps, 5_000, "narrativeShadowTakeProfitBps", 1, 100_000),
    stopLossBps: boundedInteger(config.narrativeShadowStopLossBps, 2_000, "narrativeShadowStopLossBps", 1, 9_999),
    timeStopMs: positiveInteger(config.narrativeShadowTimeStopMs, 900_000, "narrativeShadowTimeStopMs"),
    maxOrdersPerCycle: boundedInteger(config.narrativeShadowMaxOrdersPerCycle, 100, "narrativeShadowMaxOrdersPerCycle", 1, 250),
    terminalAuditPerCycle: boundedInteger(config.narrativeShadowTerminalAuditPerCycle, 10, "narrativeShadowTerminalAuditPerCycle", 1, 25),
    providerDeadlineMs: boundedInteger(config.narrativeShadowProviderTimeoutMs, 5_000, "narrativeShadowProviderTimeoutMs", 10, 30_000),
  });
  const autoStart = config.narrativeShadowSimulatorAutoStart !== false;
  const metrics = {
    cycles: 0,
    singleFlightJoins: 0,
    opened: 0,
    marked: 0,
    closed: 0,
    expired: 0,
    invalidated: 0,
    staleRejected: 0,
    unknownRejected: 0,
    identityRejected: 0,
    quoteRejected: 0,
    providerErrors: 0,
    providerTimeouts: 0,
    ledgerErrors: 0,
  };
  let timer = null;
  let flight = null;
  let starting = null;
  let stopping = false;
  let stopped = false;
  let lastCycle = null;
  let terminalAuditCursor = 0;

  const ready = Promise.resolve(ledger.ready);

  function recordEvidenceFailure(error) {
    if (error?.code === "stale") metrics.staleRejected += 1;
    else if (error?.code === "unknown") metrics.unknownRejected += 1;
    else if (error?.code === "quote") metrics.quoteRejected += 1;
    else metrics.identityRejected += 1;
  }

  async function callProvider(method, request) {
    const controller = new AbortController();
    let deadline = null;
    const timeout = new Promise((_, reject) => {
      deadline = timers.setTimeout(() => {
        controller.abort();
        const error = new Error(`market-data provider deadline exceeded after ${policy.providerDeadlineMs}ms`);
        error.code = "provider_timeout";
        reject(error);
      }, policy.providerDeadlineMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => method.call(quoteProvider, request, Object.freeze({ signal: controller.signal }))),
        timeout,
      ]);
    } finally {
      if (deadline !== null) timers.clearTimeout(deadline);
      controller.abort();
    }
  }

  async function canonicalStatus(expected) {
    let raw;
    try {
      const requestedAtMs = clockMilliseconds(now);
      raw = await callProvider(quoteProvider.checkCanonicalBlock, immutableRequest({
        schema: "narrative_shadow_canonical_request_v1",
        providerId: quoteProvider.providerId,
        mode: "shadow",
        executable: false,
        chainId: expected.chainId,
        blockNumber: expected.blockNumber,
        expectedBlockHash: expected.blockHash,
        requestedAt: new Date(requestedAtMs).toISOString(),
      }));
    } catch (error) {
      metrics.providerErrors += 1;
      if (error?.code === "provider_timeout") metrics.providerTimeouts += 1;
      return { status: "provider_error", reason: error?.message || "canonical provider failure" };
    }
    try {
      const normalized = normalizeCanonicalResult(
        raw,
        expected,
        quoteProvider,
        clockMilliseconds(now),
        policy,
      );
      if (normalized.status === "unknown") metrics.unknownRejected += 1;
      return normalized;
    } catch (error) {
      recordEvidenceFailure(error);
      return { status: error.code || "identity", reason: error.message };
    }
  }

  async function verifyPersistedEvidence(order) {
    const collected = orderEvidence(order);
    if (collected.conflict) return { status: "reorg", reason: "price_evidence_block_conflict" };
    for (const expected of collected.evidence) {
      if (!BLOCK_HASH_RE.test(expected.blockHash)) return { status: "identity", reason: `${expected.kind}_block_hash_invalid` };
      const checked = await canonicalStatus(expected);
      if (checked.status === "reorg") return { status: "reorg", reason: `${expected.kind}_reorg` };
      if (checked.status !== "canonical") return checked;
    }
    return { status: "canonical" };
  }

  async function verifyQuoteBlock(quote) {
    return canonicalStatus({
      kind: quote.kind,
      chainId: quote.chainId,
      blockNumber: quote.blockNumber,
      blockHash: quote.blockHash,
    });
  }

  function quoteRequest(order, kind, nowMs) {
    const common = {
      schema: "narrative_shadow_quote_request_v1",
      providerId: quoteProvider.providerId,
      mode: "shadow",
      executable: false,
      kind,
      orderId: order.orderId,
      chainId: order.target.chainId,
      ca: order.target.ca,
      poolAddress: order.target.poolAddress,
      maximumSlippageBps: order.policy.maxSlippageBps,
      requestedAt: new Date(nowMs).toISOString(),
    };
    if (kind === "entry") {
      return immutableRequest({
        ...common,
        side: "buy",
        valueUsdMicros: order.policy.notionalUsdMicros,
        quantityRaw: null,
      });
    }
    return immutableRequest({
      ...common,
      side: "sell",
      valueUsdMicros: null,
      quantityRaw: order.entry.quantityRaw,
    });
  }

  async function fetchQuote(order, kind) {
    const expected = {
      kind,
      side: kind === "entry" ? "buy" : "sell",
      chainId: order.target.chainId,
      ca: order.target.ca,
      poolAddress: order.target.poolAddress,
      maximumSlippageBps: order.policy.maxSlippageBps,
      valueUsdMicros: kind === "entry" ? order.policy.notionalUsdMicros : null,
      quantityRaw: kind === "entry" ? null : order.entry.quantityRaw,
    };
    let raw;
    try {
      const requestedAtMs = clockMilliseconds(now);
      raw = kind === "entry"
        ? await callProvider(quoteProvider.getEntryQuote, quoteRequest(order, kind, requestedAtMs))
        : await callProvider(quoteProvider.getPositionMark, quoteRequest(order, kind, requestedAtMs));
    } catch (error) {
      metrics.providerErrors += 1;
      if (error?.code === "provider_timeout") metrics.providerTimeouts += 1;
      return { status: "provider_error", reason: error?.message || `${kind} provider failure` };
    }
    try {
      const normalized = normalizeQuote(
        raw,
        expected,
        quoteProvider,
        clockMilliseconds(now),
        policy,
      );
      assertQuoteCausality(order, kind, normalized);
      if (normalized.status === "unknown") metrics.unknownRejected += 1;
      return normalized;
    } catch (error) {
      recordEvidenceFailure(error);
      return { status: error.code || "identity", reason: error.message };
    }
  }

  async function invalidateOrder(order, reason, actions) {
    try {
      const result = await ledger.invalidate(order.orderId, { reason });
      if (!result.duplicate) metrics.invalidated += 1;
      actions.push(action("invalidated", order.orderId, { reason }));
    } catch (error) {
      metrics.ledgerErrors += 1;
      actions.push(action("ledger_error", order.orderId, { reason: error?.message || "ledger invalidation failed" }));
    }
  }

  async function processOrder(order, nowMs, actions) {
    if (order.status === "invalidated") return;
    if (order.status === "created" && nowMs >= Date.parse(order.entryExpiresAt)) {
      try {
        const result = await ledger.expire(order.orderId, { reason: "entry_window_expired" });
        if (!result.duplicate) metrics.expired += 1;
        actions.push(action("expired", order.orderId, { reason: "entry_window_expired" }));
      } catch (error) {
        metrics.ledgerErrors += 1;
        actions.push(action("ledger_error", order.orderId, { reason: error?.message || "ledger expiry failed" }));
      }
      return;
    }

    const persistedEvidence = await verifyPersistedEvidence(order);
    if (persistedEvidence.status === "reorg") {
      await invalidateOrder(order, persistedEvidence.reason, actions);
      return;
    }
    if (persistedEvidence.status !== "canonical") {
      actions.push(action("blocked", order.orderId, { reason: persistedEvidence.reason || persistedEvidence.status }));
      return;
    }
    if (TERMINAL_STATUSES.has(order.status)) return;

    if (order.status === "created") {
      const quote = await fetchQuote(order, "entry");
      if (quote.status !== "ok") {
        actions.push(action("blocked", order.orderId, { reason: quote.reason || quote.status }));
        return;
      }
      const canonical = await verifyQuoteBlock(quote);
      if (canonical.status === "reorg") {
        actions.push(action("blocked", order.orderId, { reason: "entry_quote_not_canonical" }));
        return;
      }
      if (canonical.status !== "canonical") {
        actions.push(action("blocked", order.orderId, { reason: canonical.reason || canonical.status }));
        return;
      }
      try {
        assertQuoteFreshAtMutation(quote, clockMilliseconds(now), policy, "entry quote");
      } catch (error) {
        recordEvidenceFailure(error);
        actions.push(action("blocked", order.orderId, { reason: error.message }));
        return;
      }
      try {
        const result = await ledger.open(order.orderId, ledgerSnapshot(quote));
        if (!result.duplicate) metrics.opened += 1;
        actions.push(action("opened", order.orderId, {
          blockNumber: quote.blockNumber,
          observedAt: quote.observedAt,
          duplicate: result.duplicate,
        }));
      } catch (error) {
        metrics.ledgerErrors += 1;
        actions.push(action("ledger_error", order.orderId, { reason: error?.message || "ledger open failed" }));
      }
      return;
    }

    if (order.status !== "open") return;
    const mark = await fetchQuote(order, "mark");
    if (mark.status !== "ok") {
      actions.push(action("blocked", order.orderId, { reason: mark.reason || mark.status }));
      return;
    }
    const canonical = await verifyQuoteBlock(mark);
    if (canonical.status === "reorg") {
      actions.push(action("blocked", order.orderId, { reason: "mark_not_canonical" }));
      return;
    }
    if (canonical.status !== "canonical") {
      actions.push(action("blocked", order.orderId, { reason: canonical.reason || canonical.status }));
      return;
    }
    try {
      assertQuoteFreshAtMutation(mark, clockMilliseconds(now), policy, "mark quote");
    } catch (error) {
      recordEvidenceFailure(error);
      actions.push(action("blocked", order.orderId, { reason: error.message }));
      return;
    }
    try {
      const marked = await ledger.mark(order.orderId, ledgerSnapshot(mark));
      if (!marked.duplicate) metrics.marked += 1;
      const reason = executionReason(order, mark, clockMilliseconds(now), policy);
      if (reason) {
        const closed = await ledger.close(order.orderId, ledgerSnapshot(mark), { reason });
        if (!closed.duplicate) metrics.closed += 1;
        actions.push(action("closed", order.orderId, {
          reason,
          blockNumber: mark.blockNumber,
          observedAt: mark.observedAt,
          duplicate: closed.duplicate,
        }));
      } else {
        actions.push(action("marked", order.orderId, {
          blockNumber: mark.blockNumber,
          observedAt: mark.observedAt,
          duplicate: marked.duplicate,
        }));
      }
    } catch (error) {
      metrics.ledgerErrors += 1;
      actions.push(action("ledger_error", order.orderId, { reason: error?.message || "ledger mark failed" }));
    }
  }

  function selectedOrders(state) {
    const all = Object.values(state?.orders || {});
    const byAge = (left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.orderId.localeCompare(right.orderId);
    const active = all
      .filter((order) => order.status === "created" || order.status === "open")
      .sort(byAge)
      .slice(0, policy.maxOrdersPerCycle);
    const terminal = all
      .filter((order) => (order.status === "closed" || order.status === "expired")
        && order.performanceEligible !== false)
      .sort(byAge);
    if (terminal.length === 0) return active;
    const count = Math.min(policy.terminalAuditPerCycle, terminal.length);
    const audit = Array.from({ length: count }, (_, index) => (
      terminal[(terminalAuditCursor + index) % terminal.length]
    ));
    terminalAuditCursor = (terminalAuditCursor + count) % terminal.length;
    return [...active, ...audit];
  }

  async function runCycle() {
    await ready;
    const startedMs = clockMilliseconds(now);
    const startedAt = new Date(startedMs).toISOString();
    const actions = [];
    let cycleStatus = "healthy";
    try {
      const state = await ledger.getState();
      const orders = selectedOrders(state);
      for (const order of orders) {
        if (stopping) break;
        await processOrder(order, clockMilliseconds(now), actions);
      }
      if (actions.some((item) => ["blocked", "invalidated", "ledger_error"].includes(item.type))) {
        cycleStatus = "degraded";
      }
    } catch (error) {
      metrics.ledgerErrors += 1;
      cycleStatus = "error";
      actions.push(action("ledger_error", "shadow:cycle", { reason: error?.message || "simulator cycle failed" }));
    }
    metrics.cycles += 1;
    const finishedAt = new Date(clockMilliseconds(now)).toISOString();
    lastCycle = Object.freeze({
      schema: "narrative_shadow_simulator_cycle_v1",
      status: cycleStatus,
      startedAt,
      finishedAt,
      actions: Object.freeze(actions),
    });
    return lastCycle;
  }

  function check() {
    if (stopping || stopped) return Promise.resolve(Object.freeze({
      schema: "narrative_shadow_simulator_cycle_v1",
      status: "stopped",
      startedAt: null,
      finishedAt: null,
      actions: Object.freeze([]),
    }));
    if (flight) {
      metrics.singleFlightJoins += 1;
      return flight;
    }
    const running = runCycle();
    const wrapped = running.finally(() => {
      if (flight === wrapped) flight = null;
    });
    flight = wrapped;
    return wrapped;
  }

  function schedule() {
    if (timer !== null || stopping || stopped) return;
    timer = timers.setTimeout(async () => {
      timer = null;
      try { await check(); } catch {} finally { schedule(); }
    }, policy.intervalMs);
    timer?.unref?.();
  }

  function start() {
    if (stopping || stopped) throw new Error("narrative shadow simulator is stopped");
    if (starting) return starting;
    starting = ready.then(() => {
      schedule();
      return true;
    });
    return starting;
  }

  async function getState() {
    const ledgerState = await ledger.getState();
    return Object.freeze({
      version: NARRATIVE_SHADOW_SIMULATOR_VERSION,
      schema: NARRATIVE_SHADOW_SIMULATOR_SCHEMA,
      enabled: true,
      mode: "shadow",
      executable: false,
      providerId: quoteProvider.providerId,
      running: timer !== null,
      inFlight: flight !== null,
      stopping,
      stopped,
      policy,
      lastCycle: lastCycle ? clone(lastCycle) : null,
      ledger: ledgerState,
    });
  }

  async function getMetrics() {
    const ledgerMetrics = typeof ledger.getMetrics === "function"
      ? await ledger.getMetrics()
      : await ledger.metrics();
    return Object.freeze({
      version: NARRATIVE_SHADOW_SIMULATOR_VERSION,
      schema: "narrative_shadow_simulator_metrics_v1",
      mode: "shadow",
      executable: false,
      simulator: Object.freeze({ ...metrics }),
      ledger: ledgerMetrics,
    });
  }

  let stopPromise = null;
  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    stopPromise = (async () => {
      let failure = null;
      try {
        try { await starting; } catch {}
        if (flight) await flight;
      } catch (error) {
        failure = error;
      } finally {
        stopped = true;
        stopping = false;
      }
      if (failure) throw failure;
    })();
    return stopPromise;
  }

  if (autoStart) void start().catch(() => {});

  return Object.freeze({
    version: NARRATIVE_SHADOW_SIMULATOR_VERSION,
    schema: NARRATIVE_SHADOW_SIMULATOR_SCHEMA,
    enabled: true,
    ready,
    start,
    check,
    getState,
    getMetrics,
    stop,
  });
}
