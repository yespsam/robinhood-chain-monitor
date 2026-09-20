import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { verifyNarrativeTradeSignalIntegrity } from "./narrative-trade-signal.js";

export const NARRATIVE_SHADOW_LEDGER_VERSION = 1;
export const NARRATIVE_SHADOW_LEDGER_SCHEMA = "narrative_shadow_ledger_v1";

const WAL_VERSION = 1;
const HASH_RE = /^[0-9a-f]{64}$/u;
const BLOCK_HASH_RE = /^0x[0-9a-f]{64}$/u;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/u;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/u;
const ORDER_ID_RE = /^shadow:[0-9a-f]{64}$/u;
const MAX_ORDERS = 10_000;
const MAX_MARKS_PER_ORDER = 360;
const MAX_TEXT = 512;

const exactKeys = (value, expected) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && expected.slice().sort().every((key, index) => key === actual[index]);
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function canonicalize(value) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => (
      value[key] === undefined ? [] : [[key, canonicalize(value[key])]]
    )));
  }
  throw new TypeError("unsupported value in narrative shadow ledger digest");
}

const digest = (value) => sha256(JSON.stringify(canonicalize(value)));

function clone(value) {
  return structuredClone(value);
}

function iso(value, label) {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} must be a finite timestamp`);
  return new Date(milliseconds).toISOString();
}

function exactIso(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} must be an exact ISO timestamp`);
  }
  return value;
}

function boundedText(value, label, maximum = MAX_TEXT) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f]/u.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function uintString(value, label, { positive = false } = {}) {
  if (typeof value !== "string" || value.length > 78 || !UINT_RE.test(value)) {
    throw new TypeError(`${label} must be a canonical unsigned integer string`);
  }
  if (positive && value === "0") throw new TypeError(`${label} must be positive`);
  return value;
}

function lowerAddress(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!ADDRESS_RE.test(normalized) || /^0x0{40}$/u.test(normalized)) {
    throw new TypeError(`${label} must be a non-zero EVM address`);
  }
  return normalized;
}

function chainId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return value;
}

function strictSignal(signal) {
  if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
    throw new TypeError("narrative trade signal must be an object");
  }
  if (signal.deterministic !== true || signal.decision !== "do") {
    throw new TypeError("only deterministic do signals may be admitted");
  }
  if (signal.version !== 1 || signal.schema !== "narrative_trade_signal_v1"
    || !Number.isFinite(signal.score) || signal.score < 0 || signal.score > 100) {
    throw new TypeError("narrative trade signal version, schema, or score is invalid");
  }
  if (!HASH_RE.test(String(signal.inputHash || "")) || !HASH_RE.test(String(signal.decisionHash || ""))) {
    throw new TypeError("signal hashes are invalid");
  }
  if (!Array.isArray(signal.hardBlocks) || signal.hardBlocks.length !== 0) {
    throw new TypeError("signal hard blocks must be empty");
  }
  if (!signal.execution || signal.execution.automaticExecution !== false
    || signal.execution.networkAccess !== false
    || signal.execution.signing !== false
    || signal.execution.broadcast !== false) {
    throw new TypeError("signal exposes execution capability");
  }
  if (!signal.event || typeof signal.event !== "object" || Array.isArray(signal.event)) {
    throw new TypeError("signal event is invalid");
  }
  const eventKey = boundedText(signal.event.eventKey, "signal.event.eventKey");
  const shadow = signal.shadowOrder;
  const shadowKeys = [
    "assetKey", "ca", "chainId", "executable", "maxSlippageBps", "mode",
    "notionalUsd", "poolAddress", "side", "signalInputHash", "simulatedAt",
  ];
  if (!exactKeys(shadow, shadowKeys)) throw new TypeError("shadow order shape is invalid");
  if (shadow.mode !== "shadow" || shadow.executable !== false || shadow.side !== "buy") {
    throw new TypeError("signal is not a non-executable shadow buy");
  }
  if (shadow.signalInputHash !== signal.inputHash) throw new TypeError("shadow order input hash mismatch");
  const targetChainId = chainId(shadow.chainId, "shadowOrder.chainId");
  const ca = lowerAddress(shadow.ca, "shadowOrder.ca");
  const poolAddress = lowerAddress(shadow.poolAddress, "shadowOrder.poolAddress");
  const expectedAssetKey = `eip155:${targetChainId}/erc20:${ca}`;
  if (shadow.assetKey !== expectedAssetKey) throw new TypeError("shadow order assetKey mismatch");
  if (!signal.target || typeof signal.target !== "object" || Array.isArray(signal.target)
    || signal.target.chainId !== targetChainId
    || String(signal.target.ca || "").toLowerCase() !== ca
    || String(signal.target.poolAddress || "").toLowerCase() !== poolAddress) {
    throw new TypeError("signal target and shadow order disagree");
  }
  const notionalUsd = Number(shadow.notionalUsd);
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0 || notionalUsd > 100) {
    throw new TypeError("shadow notional must be greater than zero and at most 100 USD");
  }
  const notionalMicros = Math.round(notionalUsd * 1_000_000);
  if (!Number.isSafeInteger(notionalMicros) || notionalMicros <= 0
    || Math.abs(notionalUsd * 1_000_000 - notionalMicros) > Number.EPSILON) {
    throw new TypeError("shadow notional cannot be represented in integer microdollars");
  }
  if (!Number.isSafeInteger(shadow.maxSlippageBps)
    || shadow.maxSlippageBps < 0
    || shadow.maxSlippageBps > 300) {
    throw new TypeError("shadow max slippage must be between 0 and 300 bps");
  }
  const simulatedAt = exactIso(shadow.simulatedAt, "shadowOrder.simulatedAt");
  return {
    eventKey,
    chainId: targetChainId,
    ca,
    poolAddress,
    assetKey: expectedAssetKey,
    notionalUsdMicros: String(notionalMicros),
    maxSlippageBps: shadow.maxSlippageBps,
    simulatedAt,
  };
}

function normalizedSourceProof(sourceProof, signalShape, signal) {
  if (!sourceProof || typeof sourceProof !== "object" || Array.isArray(sourceProof)) {
    throw new TypeError("sourceProof is required");
  }
  const eventKey = boundedText(sourceProof.eventKey ?? signalShape.eventKey, "sourceProof.eventKey");
  if (eventKey !== signalShape.eventKey) throw new TypeError("sourceProof eventKey mismatch");
  const stableEventKey = boundedText(sourceProof.stableEventKey ?? eventKey, "sourceProof.stableEventKey");
  const proofChainId = chainId(sourceProof.chainId ?? signalShape.chainId, "sourceProof.chainId");
  if (proofChainId !== signalShape.chainId) throw new TypeError("sourceProof chainId mismatch");

  const blockClaims = [sourceProof.blockNumber, sourceProof.blockHash, sourceProof.transactionHash, sourceProof.logIndex];
  const presentBlockClaims = blockClaims.filter((value) => value !== undefined && value !== null).length;
  let blockNumber = null;
  let blockHash = null;
  let transactionHash = null;
  let logIndex = null;
  let contentDigest = null;
  let kind;
  if (presentBlockClaims > 0) {
    if (presentBlockClaims !== blockClaims.length) throw new TypeError("sourceProof chain coordinates must be complete");
    blockNumber = nonNegativeInteger(sourceProof.blockNumber, "sourceProof.blockNumber");
    blockHash = String(sourceProof.blockHash || "").toLowerCase();
    transactionHash = String(sourceProof.transactionHash || "").toLowerCase();
    logIndex = nonNegativeInteger(sourceProof.logIndex, "sourceProof.logIndex");
    if (!BLOCK_HASH_RE.test(blockHash) || !BLOCK_HASH_RE.test(transactionHash)) {
      throw new TypeError("sourceProof block or transaction hash is invalid");
    }
    kind = "onchain";
  } else {
    contentDigest = String(sourceProof.contentDigest ?? sourceProof.sourceContentDigest ?? signal.inputHash ?? "").toLowerCase();
    if (!HASH_RE.test(contentDigest)) throw new TypeError("off-chain sourceProof contentDigest is invalid");
    kind = "offchain";
  }
  const observedAt = exactIso(
    sourceProof.observedAt ?? signalShape.simulatedAt,
    "sourceProof.observedAt",
  );
  return {
    kind,
    eventKey,
    stableEventKey,
    chainId: proofChainId,
    blockNumber,
    blockHash,
    transactionHash,
    logIndex,
    contentDigest,
    observedAt,
  };
}

function normalizePriceSnapshot(order, value, kind, currentAt) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${kind} price snapshot must be an object`);
  }
  const snapshotChainId = chainId(value.chainId ?? order.target.chainId, `${kind}.chainId`);
  const ca = lowerAddress(value.ca ?? order.target.ca, `${kind}.ca`);
  const poolAddress = lowerAddress(value.poolAddress ?? order.target.poolAddress, `${kind}.poolAddress`);
  if (snapshotChainId !== order.target.chainId || ca !== order.target.ca || poolAddress !== order.target.poolAddress) {
    throw new TypeError(`${kind} price snapshot target mismatch`);
  }
  const blockNumber = nonNegativeInteger(value.blockNumber, `${kind}.blockNumber`);
  const blockHash = String(value.blockHash || "").toLowerCase();
  if (!BLOCK_HASH_RE.test(blockHash)) throw new TypeError(`${kind}.blockHash is invalid`);
  const valueUsdMicros = uintString(
    value.valueUsdMicros ?? value.usdValueMicros,
    `${kind}.valueUsdMicros`,
    { positive: true },
  );
  const quantityRaw = uintString(value.quantityRaw, `${kind}.quantityRaw`, { positive: true });
  if (order.entry && quantityRaw !== order.entry.quantityRaw) {
    throw new TypeError(`${kind}.quantityRaw must equal the opened position quantity`);
  }
  const observedAt = exactIso(value.observedAt ?? currentAt, `${kind}.observedAt`);
  if (Date.parse(observedAt) < Date.parse(order.createdAt || observedAt)
    || Date.parse(observedAt) > Date.parse(currentAt) + 60_000) {
    throw new TypeError(`${kind}.observedAt is outside the accepted ledger clock window`);
  }
  const priceUsdMicros = value.priceUsdMicros == null
    ? null
    : uintString(value.priceUsdMicros, `${kind}.priceUsdMicros`, { positive: true });
  const routeDigest = value.routeDigest == null
    ? null
    : String(value.routeDigest).toLowerCase();
  if (routeDigest !== null && !HASH_RE.test(routeDigest)) throw new TypeError(`${kind}.routeDigest is invalid`);
  const core = {
    kind,
    chainId: snapshotChainId,
    ca,
    poolAddress,
    blockNumber,
    blockHash,
    observedAt,
    valueUsdMicros,
    quantityRaw,
    priceUsdMicros,
    routeDigest,
  };
  const calculatedId = digest({ orderId: order.orderId, ...core });
  const snapshotId = value.snapshotId == null ? calculatedId : String(value.snapshotId).toLowerCase();
  if (!HASH_RE.test(snapshotId) || snapshotId !== calculatedId) {
    throw new TypeError(`${kind}.snapshotId does not match the snapshot payload`);
  }
  return { snapshotId, ...core };
}

function validateSnapshot(snapshot, kind, target, orderId) {
  const keys = [
    "blockHash", "blockNumber", "ca", "chainId", "kind", "observedAt", "poolAddress",
    "priceUsdMicros", "quantityRaw", "routeDigest", "snapshotId", "valueUsdMicros",
  ];
  if (!exactKeys(snapshot, keys) || snapshot.kind !== kind) throw new Error(`invalid persisted ${kind} snapshot`);
  const synthetic = { target, entry: null, orderId };
  const normalized = normalizePriceSnapshot(synthetic, snapshot, kind, snapshot.observedAt);
  if (JSON.stringify(normalized) !== JSON.stringify(snapshot)) throw new Error(`non-canonical persisted ${kind} snapshot`);
  return snapshot;
}

function emptyState(initialEquityUsdMicros) {
  return {
    version: NARRATIVE_SHADOW_LEDGER_VERSION,
    schema: NARRATIVE_SHADOW_LEDGER_SCHEMA,
    journalRevision: 0,
    initialEquityUsdMicros,
    orders: {},
  };
}

function validateTransition(value) {
  if (!exactKeys(value, ["at", "reason", "revision", "status"])) throw new Error("invalid persisted order transition");
  if (!["created", "open", "closed", "expired", "invalidated"].includes(value.status)) {
    throw new Error("invalid persisted transition status");
  }
  exactIso(value.at, "transition.at");
  if (value.reason !== null) boundedText(value.reason, "transition.reason");
  if (!Number.isSafeInteger(value.revision) || value.revision <= 0) throw new Error("invalid transition revision");
}

function validateOrder(order) {
  const keys = [
    "admissionDigest", "createdAt", "entry", "entryExpiresAt", "exit", "exitReason",
    "generationKey", "intentKey", "latestMark", "marks", "maxMarkValueUsdMicros",
    "minMarkValueUsdMicros", "orderId", "performanceEligible", "policy", "revision",
    "signal", "sourceProof", "status", "target", "terminalReason", "transitions", "updatedAt",
  ];
  if (!exactKeys(order, keys) || !ORDER_ID_RE.test(String(order.orderId || ""))) throw new Error("invalid persisted shadow order");
  for (const key of ["admissionDigest", "generationKey", "intentKey"]) {
    if (!HASH_RE.test(String(order[key] || ""))) throw new Error(`invalid persisted order ${key}`);
  }
  if (!["created", "open", "closed", "expired", "invalidated"].includes(order.status)) throw new Error("invalid persisted order status");
  exactIso(order.createdAt, "order.createdAt");
  exactIso(order.updatedAt, "order.updatedAt");
  exactIso(order.entryExpiresAt, "order.entryExpiresAt");
  if (!Number.isSafeInteger(order.revision) || order.revision <= 0) throw new Error("invalid persisted order revision");
  if (typeof order.performanceEligible !== "boolean") throw new Error("invalid performance eligibility");
  if (!exactKeys(order.signal, ["decisionHash", "eventKey", "inputHash", "score"])) throw new Error("invalid persisted signal summary");
  if (!HASH_RE.test(order.signal.decisionHash) || !HASH_RE.test(order.signal.inputHash)) throw new Error("invalid persisted signal hash");
  if (order.orderId !== `shadow:${order.signal.decisionHash}`) throw new Error("persisted order id does not match decision hash");
  boundedText(order.signal.eventKey, "order.signal.eventKey");
  if (!Number.isFinite(order.signal.score) || order.signal.score < 0 || order.signal.score > 100) throw new Error("invalid persisted signal score");
  if (!exactKeys(order.target, ["assetKey", "ca", "chainId", "poolAddress"])) throw new Error("invalid persisted target");
  chainId(order.target.chainId, "order.target.chainId");
  lowerAddress(order.target.ca, "order.target.ca");
  lowerAddress(order.target.poolAddress, "order.target.poolAddress");
  if (order.target.assetKey !== `eip155:${order.target.chainId}/erc20:${order.target.ca}`) throw new Error("invalid persisted target assetKey");
  if (!exactKeys(order.policy, ["entryTtlMs", "maxSlippageBps", "notionalUsdMicros"])) throw new Error("invalid persisted policy");
  uintString(order.policy.notionalUsdMicros, "order.policy.notionalUsdMicros", { positive: true });
  nonNegativeInteger(order.policy.entryTtlMs, "order.policy.entryTtlMs");
  nonNegativeInteger(order.policy.maxSlippageBps, "order.policy.maxSlippageBps");
  if (BigInt(order.policy.notionalUsdMicros) > 100_000_000n
    || order.policy.entryTtlMs <= 0
    || order.policy.maxSlippageBps > 300) throw new Error("persisted order policy exceeds hard limits");
  const proofKeys = [
    "blockHash", "blockNumber", "chainId", "contentDigest", "eventKey", "kind", "logIndex",
    "observedAt", "stableEventKey", "transactionHash",
  ];
  if (!exactKeys(order.sourceProof, proofKeys)) throw new Error("invalid persisted source proof");
  if (order.sourceProof.kind === "onchain") {
    nonNegativeInteger(order.sourceProof.blockNumber, "sourceProof.blockNumber");
    nonNegativeInteger(order.sourceProof.logIndex, "sourceProof.logIndex");
    if (!BLOCK_HASH_RE.test(order.sourceProof.blockHash) || !BLOCK_HASH_RE.test(order.sourceProof.transactionHash)
      || order.sourceProof.contentDigest !== null) throw new Error("invalid persisted on-chain source proof");
  } else if (order.sourceProof.kind === "offchain") {
    if (![order.sourceProof.blockNumber, order.sourceProof.blockHash, order.sourceProof.transactionHash, order.sourceProof.logIndex].every((item) => item === null)
      || !HASH_RE.test(order.sourceProof.contentDigest)) throw new Error("invalid persisted off-chain source proof");
  } else throw new Error("invalid persisted source proof kind");
  exactIso(order.sourceProof.observedAt, "sourceProof.observedAt");
  boundedText(order.sourceProof.eventKey, "sourceProof.eventKey");
  boundedText(order.sourceProof.stableEventKey, "sourceProof.stableEventKey");
  if (order.sourceProof.eventKey !== order.signal.eventKey
    || order.sourceProof.chainId !== order.target.chainId) throw new Error("persisted source proof does not match its order");
  const expectedIntentKey = digest({
    strategy: "narrative_sniper_shadow_v1",
    eventKey: order.sourceProof.stableEventKey,
    assetKey: order.target.assetKey,
    poolAddress: order.target.poolAddress,
  });
  const generationEvidence = order.sourceProof.kind === "onchain"
    ? order.sourceProof.blockHash
    : order.sourceProof.contentDigest;
  const expectedGenerationKey = digest({ intentKey: expectedIntentKey, generationEvidence });
  const expectedAdmissionDigest = digest({
    signal: order.signal,
    sourceProof: order.sourceProof,
    target: order.target,
    policy: order.policy,
    intentKey: expectedIntentKey,
    generationKey: expectedGenerationKey,
  });
  if (order.intentKey !== expectedIntentKey
    || order.generationKey !== expectedGenerationKey
    || order.admissionDigest !== expectedAdmissionDigest) {
    throw new Error("persisted shadow order identity digest mismatch");
  }
  if (!Array.isArray(order.transitions) || order.transitions.length < 1 || order.transitions.length > 8) throw new Error("invalid persisted transitions");
  order.transitions.forEach(validateTransition);
  if (order.transitions[0].status !== "created"
    || order.transitions.at(-1).status !== order.status
    || order.transitions.some((transition, index) => index > 0
      && transition.revision <= order.transitions[index - 1].revision)
    || order.transitions.some((transition) => transition.revision > order.revision)) {
    throw new Error("persisted order transition history is inconsistent");
  }
  const allowedTransitions = {
    created: new Set(["open", "expired", "invalidated"]),
    open: new Set(["closed", "invalidated"]),
    closed: new Set(["invalidated"]),
    expired: new Set(["invalidated"]),
    invalidated: new Set(),
  };
  for (let index = 1; index < order.transitions.length; index += 1) {
    const previous = order.transitions[index - 1];
    const current = order.transitions[index];
    if (!allowedTransitions[previous.status].has(current.status)
      || Date.parse(current.at) < Date.parse(previous.at)) {
      throw new Error("persisted order contains an illegal lifecycle transition");
    }
  }
  if (!Array.isArray(order.marks) || order.marks.length > MAX_MARKS_PER_ORDER) throw new Error("invalid persisted marks");
  if (order.entry !== null) validateSnapshot(order.entry, "entry", order.target, order.orderId);
  if (order.exit !== null) validateSnapshot(order.exit, "exit", order.target, order.orderId);
  if (order.latestMark !== null) validateSnapshot(order.latestMark, "mark", order.target, order.orderId);
  for (const mark of order.marks) validateSnapshot(mark, "mark", order.target, order.orderId);
  if (order.entry && [order.latestMark, order.exit, ...order.marks].filter(Boolean)
    .some((snapshot) => snapshot.quantityRaw !== order.entry.quantityRaw
      || snapshot.blockNumber < order.entry.blockNumber
      || Date.parse(snapshot.observedAt) < Date.parse(order.entry.observedAt))) {
    throw new Error("persisted price snapshot precedes or disagrees with its entry");
  }
  for (const value of [order.minMarkValueUsdMicros, order.maxMarkValueUsdMicros]) {
    if (value !== null) uintString(value, "order mark extreme", { positive: true });
  }
  if (order.exitReason !== null) boundedText(order.exitReason, "order.exitReason");
  if (order.terminalReason !== null) boundedText(order.terminalReason, "order.terminalReason");
  if (order.status === "created" && (order.entry || order.exit || order.latestMark || order.marks.length)) throw new Error("created order contains fills");
  if (["open", "closed"].includes(order.status) && !order.entry) throw new Error("filled order lacks entry snapshot");
  if (order.status === "closed" && (!order.exit || !order.exitReason)) throw new Error("closed order lacks exit evidence");
  if (order.performanceEligible !== (order.status !== "invalidated")) throw new Error("persisted performance eligibility is inconsistent");
  if (["created", "open"].includes(order.status) && order.terminalReason !== null) throw new Error("non-terminal order has a terminal reason");
  if (["expired", "invalidated", "closed"].includes(order.status) && order.terminalReason === null) throw new Error("terminal order lacks a reason");
  if (order.status === "closed" && order.terminalReason !== order.exitReason) throw new Error("closed order reasons disagree");
  return order;
}

function normalizeState(value, expectedInitialEquity) {
  if (!exactKeys(value, ["initialEquityUsdMicros", "journalRevision", "orders", "schema", "version"])
    || value.version !== NARRATIVE_SHADOW_LEDGER_VERSION
    || value.schema !== NARRATIVE_SHADOW_LEDGER_SCHEMA
    || !Number.isSafeInteger(value.journalRevision)
    || value.journalRevision < 0
    || !value.orders
    || typeof value.orders !== "object"
    || Array.isArray(value.orders)
    || Object.keys(value.orders).length > MAX_ORDERS) {
    throw new Error("invalid narrative shadow ledger snapshot");
  }
  uintString(value.initialEquityUsdMicros, "initialEquityUsdMicros", { positive: true });
  if (value.initialEquityUsdMicros !== expectedInitialEquity) throw new Error("narrative shadow ledger initial equity mismatch");
  const generations = new Set();
  let greatestOrderRevision = 0;
  for (const [orderId, order] of Object.entries(value.orders)) {
    if (orderId !== order.orderId) throw new Error("shadow order map key mismatch");
    validateOrder(order);
    if (generations.has(order.generationKey)) throw new Error("duplicate shadow order generation in snapshot");
    generations.add(order.generationKey);
    if (order.revision > value.journalRevision) throw new Error("shadow order revision exceeds snapshot revision");
    greatestOrderRevision = Math.max(greatestOrderRevision, order.revision);
  }
  if (greatestOrderRevision !== value.journalRevision) throw new Error("snapshot revision has no matching shadow order mutation");
  return value;
}

async function closeHandle(handle, operation) {
  let failure = null;
  try {
    const result = await operation(handle);
    await handle.close();
    return result;
  } catch (error) {
    failure = error;
  }
  try { await handle.close(); } catch {}
  throw failure;
}

async function fsyncDirectory(directory, fsImpl) {
  const handle = await fsImpl.open(directory, "r");
  await closeHandle(handle, (opened) => opened.sync());
}

async function atomicWriteSnapshot(file, value, fsImpl) {
  const directory = path.dirname(file);
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`);
  let renamed = false;
  try {
    const handle = await fsImpl.open(temporary, "wx", 0o600);
    await closeHandle(handle, async (opened) => {
      await opened.chmod(0o600);
      await opened.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await opened.sync();
    });
    await fsImpl.rename(temporary, file);
    renamed = true;
    await fsImpl.chmod(file, 0o600);
    await fsyncDirectory(directory, fsImpl);
  } catch (error) {
    error.atomicRenameCompleted = renamed;
    if (!renamed) await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function createEmptyWal(file, fsImpl) {
  const directory = path.dirname(file);
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const handle = await fsImpl.open(file, "wx", 0o600);
    await closeHandle(handle, async (opened) => {
      await opened.chmod(0o600);
      await opened.sync();
    });
    await fsyncDirectory(directory, fsImpl);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    await fsImpl.chmod(file, 0o600);
  }
}

async function replaceWalWithEmpty(file, fsImpl) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`);
  let renamed = false;
  try {
    const handle = await fsImpl.open(temporary, "wx", 0o600);
    await closeHandle(handle, async (opened) => {
      await opened.chmod(0o600);
      await opened.sync();
    });
    await fsImpl.rename(temporary, file);
    renamed = true;
    await fsImpl.chmod(file, 0o600);
    await fsyncDirectory(directory, fsImpl);
  } catch (error) {
    error.walResetAmbiguous = renamed;
    if (!renamed) await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function encodeWalFrame(revision, mutation) {
  const core = { version: WAL_VERSION, revision, previousRevision: revision - 1, mutation };
  const payload = JSON.stringify(core);
  return `${JSON.stringify({
    ...core,
    payloadLength: Buffer.byteLength(payload),
    sha256: sha256(payload),
  })}\n`;
}

function validateWalFrame(frame) {
  if (!exactKeys(frame, ["mutation", "payloadLength", "previousRevision", "revision", "sha256", "version"])
    || frame.version !== WAL_VERSION
    || !Number.isSafeInteger(frame.revision)
    || frame.revision <= 0
    || frame.previousRevision !== frame.revision - 1
    || !Number.isSafeInteger(frame.payloadLength)
    || frame.payloadLength <= 0
    || !HASH_RE.test(String(frame.sha256 || ""))
    || !exactKeys(frame.mutation, ["order", "orderId", "type"])
    || frame.mutation.type !== "upsert_order"
    || frame.mutation.orderId !== frame.mutation.order?.orderId) {
    throw new Error("invalid narrative shadow ledger WAL frame");
  }
  validateOrder(frame.mutation.order);
  if (frame.mutation.order.revision !== frame.revision) throw new Error("WAL order revision mismatch");
  const payload = JSON.stringify({
    version: frame.version,
    revision: frame.revision,
    previousRevision: frame.previousRevision,
    mutation: frame.mutation,
  });
  if (Buffer.byteLength(payload) !== frame.payloadLength || sha256(payload) !== frame.sha256) {
    throw new Error(`narrative shadow ledger WAL checksum mismatch at revision ${frame.revision}`);
  }
}

async function truncateWal(file, size, fsImpl) {
  const handle = await fsImpl.open(file, "r+");
  await closeHandle(handle, async (opened) => {
    await opened.truncate(size);
    await opened.chmod(0o600);
    await opened.sync();
  });
}

async function replayWal(file, snapshot, fsImpl) {
  const raw = await fsImpl.readFile(file);
  await fsImpl.chmod(file, 0o600);
  const finalNewline = raw.length === 0 || raw.at(-1) === 0x0a;
  const lastNewline = raw.lastIndexOf(0x0a);
  const completeLength = finalNewline ? raw.length : Math.max(0, lastNewline + 1);
  const lines = raw.subarray(0, completeLength).toString("utf8").split("\n").filter(Boolean);
  let state = clone(snapshot);
  let previousPhysicalRevision = null;
  let applied = state.journalRevision;
  for (const line of lines) {
    let frame;
    try { frame = JSON.parse(line); } catch { throw new Error("corrupt narrative shadow ledger WAL frame"); }
    validateWalFrame(frame);
    if (previousPhysicalRevision !== null && frame.revision !== previousPhysicalRevision + 1) {
      throw new Error(`narrative shadow ledger WAL revision gap ${previousPhysicalRevision} -> ${frame.revision}`);
    }
    previousPhysicalRevision = frame.revision;
    if (frame.revision <= snapshot.journalRevision) continue;
    if (frame.revision !== applied + 1) {
      throw new Error(`narrative shadow ledger WAL revision gap ${applied} -> ${frame.revision}`);
    }
    if (Object.keys(state.orders).length >= MAX_ORDERS && !state.orders[frame.mutation.orderId]) {
      throw new Error("narrative shadow ledger order capacity exceeded during replay");
    }
    state.orders[frame.mutation.orderId] = clone(frame.mutation.order);
    state.journalRevision = frame.revision;
    applied = frame.revision;
  }
  if (!finalNewline) await truncateWal(file, completeLength, fsImpl);
  return { state, walFrames: lines.filter((line) => JSON.parse(line).revision > snapshot.journalRevision).length };
}

async function appendWalFrame(file, frameText, fsImpl) {
  let handle = null;
  let startingSize = 0;
  let sizeKnown = false;
  let writeAttempted = false;
  let fsynced = false;
  let failure = null;
  try {
    handle = await fsImpl.open(file, "a", 0o600);
    startingSize = Number((await handle.stat()).size);
    if (!Number.isSafeInteger(startingSize) || startingSize < 0) throw new Error("invalid narrative shadow ledger WAL size");
    sizeKnown = true;
    await handle.chmod(0o600);
    writeAttempted = true;
    await handle.writeFile(frameText, "utf8");
    await handle.sync();
    fsynced = true;
  } catch (error) {
    if (!handle || !writeAttempted) {
      error.walRollbackSafe = Boolean(!handle || sizeKnown);
      failure = error;
    } else if (!sizeKnown) {
      error.walRollbackSafe = false;
      failure = error;
    } else {
      try {
        await handle.truncate(startingSize);
        await handle.sync();
        error.walRollbackSafe = true;
        failure = error;
      } catch (rollbackError) {
        failure = new AggregateError([error, rollbackError], "narrative shadow ledger WAL append failed and rollback was not durable");
        failure.walRollbackSafe = false;
      }
    }
  } finally {
    try { await handle?.close(); } catch (closeError) {
      if (!fsynced && !failure) {
        closeError.walRollbackSafe = false;
        failure = closeError;
      }
    }
  }
  if (failure) throw failure;
}

function statusResult(order, duplicate = false) {
  return Object.freeze({
    orderId: order.orderId,
    status: order.status,
    revision: order.revision,
    persisted: true,
    duplicate,
  });
}

function calculateMetrics(state) {
  const orders = Object.values(state.orders);
  const counts = { created: 0, open: 0, closed: 0, expired: 0, invalidated: 0 };
  for (const order of orders) counts[order.status] += 1;
  const eligibleClosed = orders
    .filter((order) => order.status === "closed" && order.performanceEligible && order.entry && order.exit)
    .sort((left, right) => left.exit.observedAt.localeCompare(right.exit.observedAt)
      || left.orderId.localeCompare(right.orderId));
  let realized = 0n;
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let equity = BigInt(state.initialEquityUsdMicros);
  let peakEquity = equity;
  let maxDrawdown = 0n;
  let maxDrawdownBps = 0;
  for (const order of eligibleClosed) {
    const pnl = BigInt(order.exit.valueUsdMicros) - BigInt(order.entry.valueUsdMicros);
    realized += pnl;
    if (pnl > 0n) wins += 1;
    else if (pnl < 0n) losses += 1;
    else scratches += 1;
    equity += pnl;
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity - equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    const drawdownBps = peakEquity > 0n ? Number((drawdown * 10_000n) / peakEquity) : 0;
    if (drawdownBps > maxDrawdownBps) maxDrawdownBps = drawdownBps;
  }
  let unrealized = 0n;
  let pricedOpen = 0;
  for (const order of orders) {
    if (order.status !== "open" || !order.performanceEligible || !order.entry || !order.latestMark) continue;
    unrealized += BigInt(order.latestMark.valueUsdMicros) - BigInt(order.entry.valueUsdMicros);
    pricedOpen += 1;
  }
  const decisive = wins + losses;
  const winRateBps = decisive ? Math.round((wins * 10_000) / decisive) : null;
  return Object.freeze({
    schema: "narrative_shadow_metrics_v1",
    throughJournalRevision: state.journalRevision,
    totalOrders: orders.length,
    counts: Object.freeze(counts),
    eligibleClosed: eligibleClosed.length,
    wins,
    losses,
    scratches,
    winRateBps,
    realizedPnlUsdMicros: realized.toString(),
    unrealizedPnlUsdMicros: unrealized.toString(),
    pricedOpen,
    unpricedOpen: counts.open - pricedOpen,
    endingRealizedEquityUsdMicros: equity.toString(),
    peakRealizedEquityUsdMicros: peakEquity.toString(),
    maxDrawdownUsdMicros: maxDrawdown.toString(),
    maxDrawdownBps,
    expired: counts.expired,
    invalidated: counts.invalidated,
  });
}

export function createNarrativeShadowLedger({
  dataDir = ".data",
  stateFile = path.join(dataDir, "narrative-shadow-ledger.json"),
  fsImpl = fs,
  now = Date.now,
  integrityVerifier = verifyNarrativeTradeSignalIntegrity,
  initialEquityUsdMicros = "10000000000",
  entryTtlMs = 300_000,
  compactEvery = 512,
} = {}) {
  if (typeof integrityVerifier !== "function") throw new TypeError("integrityVerifier is required");
  uintString(initialEquityUsdMicros, "initialEquityUsdMicros", { positive: true });
  nonNegativeInteger(entryTtlMs, "entryTtlMs");
  if (entryTtlMs <= 0) throw new TypeError("entryTtlMs must be positive");
  if (!Number.isSafeInteger(compactEvery) || compactEvery < 1) throw new TypeError("compactEvery must be positive");
  const walFile = `${stateFile}.wal`;
  let state = null;
  let walFrames = 0;
  let initialized = null;
  let writer = Promise.resolve();
  let stopped = false;
  let stopPromise = null;
  let writePoison = null;
  let resetPoison = null;

  const currentIso = () => iso(now(), "ledger clock");

  const initialize = () => {
    if (initialized) return initialized;
    initialized = (async () => {
      let snapshot;
      try {
        snapshot = normalizeState(JSON.parse(await fsImpl.readFile(stateFile, "utf8")), initialEquityUsdMicros);
        await fsImpl.chmod(stateFile, 0o600);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        snapshot = emptyState(initialEquityUsdMicros);
        await atomicWriteSnapshot(stateFile, snapshot, fsImpl);
      }
      await createEmptyWal(walFile, fsImpl);
      const replayed = await replayWal(walFile, snapshot, fsImpl);
      state = normalizeState(replayed.state, initialEquityUsdMicros);
      walFrames = replayed.walFrames;
      return true;
    })();
    return initialized;
  };

  const enqueue = (operation, { allowStopped = false } = {}) => {
    if (stopped && !allowStopped) return Promise.reject(new Error("narrative shadow ledger is stopped"));
    const run = writer.catch(() => {}).then(async () => {
      await initialize();
      if (resetPoison) throw resetPoison;
      if (writePoison) throw writePoison;
      return operation();
    });
    writer = run.catch(() => {});
    return run;
  };

  const compactUnlocked = async () => {
    if (walFrames === 0) return false;
    await atomicWriteSnapshot(stateFile, state, fsImpl);
    try {
      await replaceWalWithEmpty(walFile, fsImpl);
    } catch (error) {
      if (error.walResetAmbiguous) resetPoison = error;
      throw error;
    }
    walFrames = 0;
    return true;
  };

  const commitOrder = async (order) => {
    const revision = state.journalRevision + 1;
    order.revision = revision;
    order.transitions = order.transitions.map((transition) => (
      transition.revision === 0 ? { ...transition, revision } : transition
    ));
    validateOrder(order);
    const mutation = { type: "upsert_order", orderId: order.orderId, order: clone(order) };
    const frame = encodeWalFrame(revision, mutation);
    try {
      await appendWalFrame(walFile, frame, fsImpl);
    } catch (error) {
      if (error.walRollbackSafe === false) writePoison = error;
      throw error;
    }
    state = {
      ...state,
      journalRevision: revision,
      orders: { ...state.orders, [order.orderId]: clone(order) },
    };
    walFrames += 1;
    if (walFrames >= compactEvery) await compactUnlocked();
    return state.orders[order.orderId];
  };

  const findOrder = (orderId) => {
    if (!ORDER_ID_RE.test(String(orderId || ""))) throw new TypeError("orderId is invalid");
    const order = state.orders[orderId];
    if (!order) throw new Error(`unknown narrative shadow order ${orderId}`);
    return order;
  };

  const mutateOrder = (orderId, operation) => enqueue(async () => {
    const existing = findOrder(orderId);
    return operation(existing);
  });

  async function admit(signal, { sourceProof } = {}) {
    const suppliedSignal = clone(signal);
    const verified = await integrityVerifier(suppliedSignal);
    if (!(verified === true || verified?.valid === true)) throw new TypeError("signal integrity verification failed");
    const shape = strictSignal(suppliedSignal);
    const proof = normalizedSourceProof(sourceProof, shape, suppliedSignal);
    const intentKey = digest({
      strategy: "narrative_sniper_shadow_v1",
      eventKey: proof.stableEventKey,
      assetKey: shape.assetKey,
      poolAddress: shape.poolAddress,
    });
    const generationEvidence = proof.kind === "onchain" ? proof.blockHash : proof.contentDigest;
    const generationKey = digest({ intentKey, generationEvidence });
    const orderId = `shadow:${suppliedSignal.decisionHash}`;
    const admission = {
      signal: {
        decisionHash: suppliedSignal.decisionHash,
        inputHash: suppliedSignal.inputHash,
        eventKey: shape.eventKey,
        score: Number(suppliedSignal.score),
      },
      sourceProof: proof,
      target: {
        chainId: shape.chainId,
        ca: shape.ca,
        poolAddress: shape.poolAddress,
        assetKey: shape.assetKey,
      },
      policy: {
        notionalUsdMicros: shape.notionalUsdMicros,
        maxSlippageBps: shape.maxSlippageBps,
        entryTtlMs,
      },
      intentKey,
      generationKey,
    };
    const admissionDigest = digest(admission);
    return enqueue(async () => {
      const existing = state.orders[orderId];
      if (existing) {
        if (existing.admissionDigest !== admissionDigest) throw new Error(`shadow order idempotency conflict ${orderId}`);
        return statusResult(existing, true);
      }
      const generationOwner = Object.values(state.orders).find((order) => order.generationKey === generationKey);
      if (generationOwner) throw new Error(`shadow order generation conflict with ${generationOwner.orderId}`);
      if (Object.keys(state.orders).length >= MAX_ORDERS) throw new Error("narrative shadow ledger order capacity exceeded");
      const createdAt = currentIso();
      const entryExpiresAt = new Date(Date.parse(createdAt) + entryTtlMs).toISOString();
      const order = {
        orderId,
        intentKey,
        generationKey,
        admissionDigest,
        status: "created",
        signal: admission.signal,
        sourceProof: proof,
        target: admission.target,
        policy: admission.policy,
        createdAt,
        entryExpiresAt,
        entry: null,
        latestMark: null,
        marks: [],
        minMarkValueUsdMicros: null,
        maxMarkValueUsdMicros: null,
        exit: null,
        exitReason: null,
        terminalReason: null,
        performanceEligible: true,
        transitions: [{ status: "created", at: createdAt, reason: null, revision: 0 }],
        updatedAt: createdAt,
        revision: state.journalRevision + 1,
      };
      return statusResult(await commitOrder(order));
    });
  }

  function open(orderId, priceSnapshot) {
    return mutateOrder(orderId, async (existing) => {
      if (existing.status === "open" && existing.entry) {
        const duplicate = normalizePriceSnapshot(existing, priceSnapshot, "entry", existing.entry.observedAt);
        if (duplicate.snapshotId === existing.entry.snapshotId) return statusResult(existing, true);
        throw new Error(`shadow order open conflict ${orderId}`);
      }
      if (existing.status !== "created") throw new Error(`cannot open shadow order from ${existing.status}`);
      const at = currentIso();
      if (Date.parse(at) >= Date.parse(existing.entryExpiresAt)) throw new Error("shadow order entry window expired");
      const entry = normalizePriceSnapshot(existing, priceSnapshot, "entry", at);
      const order = clone(existing);
      order.status = "open";
      order.entry = entry;
      order.minMarkValueUsdMicros = entry.valueUsdMicros;
      order.maxMarkValueUsdMicros = entry.valueUsdMicros;
      order.updatedAt = at;
      order.transitions.push({ status: "open", at, reason: "entry_quote_filled", revision: 0 });
      return statusResult(await commitOrder(order));
    });
  }

  function mark(orderId, priceSnapshot) {
    return mutateOrder(orderId, async (existing) => {
      if (existing.status !== "open") throw new Error(`cannot mark shadow order from ${existing.status}`);
      const at = currentIso();
      const snapshot = normalizePriceSnapshot(existing, priceSnapshot, "mark", at);
      const logical = (candidate) => candidate.blockNumber === snapshot.blockNumber
        && candidate.blockHash === snapshot.blockHash;
      const prior = existing.marks.find(logical);
      if (prior) {
        if (prior.snapshotId === snapshot.snapshotId) return statusResult(existing, true);
        throw new Error(`shadow order mark conflict ${orderId} at block ${snapshot.blockNumber}`);
      }
      if (existing.latestMark && snapshot.blockNumber < existing.latestMark.blockNumber) {
        throw new Error("shadow mark blockNumber moved backwards");
      }
      if (existing.latestMark && Date.parse(snapshot.observedAt) < Date.parse(existing.latestMark.observedAt)) {
        throw new Error("shadow mark observedAt moved backwards");
      }
      const order = clone(existing);
      order.marks = [...order.marks, snapshot].slice(-MAX_MARKS_PER_ORDER);
      order.latestMark = snapshot;
      const currentValue = BigInt(snapshot.valueUsdMicros);
      order.minMarkValueUsdMicros = (order.minMarkValueUsdMicros === null
        || currentValue < BigInt(order.minMarkValueUsdMicros)) ? snapshot.valueUsdMicros : order.minMarkValueUsdMicros;
      order.maxMarkValueUsdMicros = (order.maxMarkValueUsdMicros === null
        || currentValue > BigInt(order.maxMarkValueUsdMicros)) ? snapshot.valueUsdMicros : order.maxMarkValueUsdMicros;
      order.updatedAt = at;
      return statusResult(await commitOrder(order));
    });
  }

  function close(orderId, priceSnapshot, { reason = "exit_policy" } = {}) {
    const normalizedReason = boundedText(reason, "close reason");
    return mutateOrder(orderId, async (existing) => {
      if (existing.status === "closed" && existing.exit) {
        const duplicate = normalizePriceSnapshot(existing, priceSnapshot, "exit", existing.exit.observedAt);
        if (duplicate.snapshotId === existing.exit.snapshotId && normalizedReason === existing.exitReason) {
          return statusResult(existing, true);
        }
        throw new Error(`shadow order close conflict ${orderId}`);
      }
      if (existing.status !== "open") throw new Error(`cannot close shadow order from ${existing.status}`);
      const at = currentIso();
      const exit = normalizePriceSnapshot(existing, priceSnapshot, "exit", at);
      if (exit.blockNumber < existing.entry.blockNumber) throw new Error("shadow exit precedes entry block");
      if (existing.latestMark && (exit.blockNumber < existing.latestMark.blockNumber
        || Date.parse(exit.observedAt) < Date.parse(existing.latestMark.observedAt))) {
        throw new Error("shadow exit precedes the latest mark");
      }
      const order = clone(existing);
      order.status = "closed";
      order.exit = exit;
      order.exitReason = normalizedReason;
      order.terminalReason = normalizedReason;
      order.updatedAt = at;
      order.transitions.push({ status: "closed", at, reason: normalizedReason, revision: 0 });
      return statusResult(await commitOrder(order));
    });
  }

  function expire(orderId, { reason = "entry_window_expired" } = {}) {
    const normalizedReason = boundedText(reason, "expiry reason");
    return mutateOrder(orderId, async (existing) => {
      if (existing.status === "expired") {
        if (existing.terminalReason === normalizedReason) return statusResult(existing, true);
        throw new Error(`shadow order expiry conflict ${orderId}`);
      }
      if (existing.status !== "created") throw new Error(`cannot expire shadow order from ${existing.status}`);
      const at = currentIso();
      if (Date.parse(at) < Date.parse(existing.entryExpiresAt)) throw new Error("shadow order entry window is still open");
      const order = clone(existing);
      order.status = "expired";
      order.terminalReason = normalizedReason;
      order.updatedAt = at;
      order.transitions.push({ status: "expired", at, reason: normalizedReason, revision: 0 });
      return statusResult(await commitOrder(order));
    });
  }

  function invalidate(orderId, { reason = "source_proof_invalidated" } = {}) {
    const normalizedReason = boundedText(reason, "invalidation reason");
    return mutateOrder(orderId, async (existing) => {
      if (existing.status === "invalidated") {
        if (existing.terminalReason === normalizedReason) return statusResult(existing, true);
        throw new Error(`shadow order invalidation conflict ${orderId}`);
      }
      const at = currentIso();
      const order = clone(existing);
      order.status = "invalidated";
      order.performanceEligible = false;
      order.terminalReason = normalizedReason;
      order.updatedAt = at;
      order.transitions.push({ status: "invalidated", at, reason: normalizedReason, revision: 0 });
      return statusResult(await commitOrder(order));
    });
  }

  const ready = initialize();

  return Object.freeze({
    ready,
    stateFile,
    walFile,
    admit,
    open,
    mark,
    close,
    expire,
    invalidate,
    compact: () => enqueue(compactUnlocked),
    getOrder: (orderId) => enqueue(() => clone(findOrder(orderId))),
    getState: () => enqueue(() => clone(state)),
    metrics: () => enqueue(() => calculateMetrics(state)),
    getMetrics: () => enqueue(() => calculateMetrics(state)),
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      const attempt = enqueue(async () => { await compactUnlocked(); }, { allowStopped: true });
      stopPromise = attempt;
      void attempt.catch(() => { if (stopPromise === attempt) stopPromise = null; });
      return attempt;
    },
  });
}
