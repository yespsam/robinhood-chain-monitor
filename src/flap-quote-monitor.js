import fs from "node:fs/promises";
import path from "node:path";
import {setTimeout as delay} from 'node:timers/promises';
import { Interface, getAddress, keccak256 } from "ethers";
import { cancelPendingFlapQuoteActivation, sendAlerts } from "./alerts.js";
import { isMaterialFlapQuoteConfigurationChange } from "./flap-quote-generation.js";
import { FLAP_PORTAL_VERIFIED_VERSION, FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
  FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH } from './flap-portal-pins.js';
export { FLAP_PORTAL_VERIFIED_VERSION, FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
  FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH } from './flap-portal-pins.js';

// Official address source:
// https://docs.flap.sh/flap/developers/deployed-contract-addresses.md
// Official ABI source:
// https://github.com/flap-sh/FlapVaultExample/blob/main/src/flap/IPortal.sol
export const FLAP_QUOTE_CHAIN_ID = 56;
export const FLAP_PORTAL_ADDRESS = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
export const FLAP_BOARD_URL = "https://flap.sh/board";
export const FLAP_DEPLOYED_CONTRACTS_URL = "https://docs.flap.sh/flap/developers/deployed-contract-addresses";
export const FLAP_QUOTE_CONFIGURATION_SIGNATURE = "QuoteTokenConfigurationSet(address,(uint8,uint8,uint8,uint8,uint8))";
export const FLAP_PORTAL_RUNTIME_HASH = "0x0a3fe6f701ee3cb432f45912e054896327ce5902337eae4d62d01406005a91c3";
export const FLAP_PORTAL_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// The only persisted Portal identity accepted for an in-place pin migration.
// These values are deliberately not configurable: an arbitrary predecessor
// would turn a local-state edit into authority to cross an implementation
// boundary without first proving which monitor produced the cursor.
export const FLAP_PORTAL_PREVIOUS_VERIFIED_VERSION = "v5.23.1";
export const FLAP_PORTAL_PREVIOUS_VERIFIED_IMPLEMENTATION = "0xAb8Ec926b6e113c2212aF152b086eA62d1FDced9";
export const FLAP_PORTAL_PREVIOUS_VERIFIED_IMPLEMENTATION_HASH = "0x78653cdd7296d940ae531c86bc6700ae163f1f9dec002c2af3143c9ae6696a15";
// Canonical EIP-1967 Upgraded(address) evidence for the currently pinned
// implementation. The block and transaction were independently reproduced
// from BlockMachine, Blast and BNB Chain (receipt status 1, transaction
// included in the same canonical block, and identical Portal upgrade log).
// BlockMachine and 48.club agreed on version, EIP-1967 slot, proxy hash and
// implementation hash at fixed block 0x772173b, block hash
// 0xd059ab4872d92c42b8691520def5c74816cf72b00128d3a8acf78692273f38de.
// Official deployed-address documentation still lists the predecessor; this
// upgrade is pinned from canonical chain evidence, not an inferred doc change.
export const FLAP_PORTAL_UPGRADE_BLOCK = 123_307_497;
export const FLAP_PORTAL_UPGRADE_BLOCK_HASH = "0x736aaf4d42db2f599694dc4fd17458926e24202b34f06b0f1eae04824b89a5f0";
export const FLAP_PORTAL_UPGRADE_TRANSACTION = "0xca80914e6f43449a24a5cbf17c43ba23d99aca5579a0c658e6360640f3d502b8";
export const FLAP_QUOTE_REFERENCE_BLOCK = 119_678_948;
export const FLAP_QUOTE_REFERENCE_BLOCK_HASH = "0x63fd84ecfc1fc73d2a2179c4735bfe1b2def3f018118db896f278a39a5349f1b";
export const FLAP_QUOTE_REFERENCE_TRANSACTION = "0x76d94a5561c88f6e86f107ebaa1b7188aa9596a60517346f816abdd3a528eb72";
export const FLAP_MRNAB_ADDRESS = "0x5fd86da9B05abE396fe9d02a4A213A7c00556503";
export const FLAP_SQQQB_ADDRESS = "0x25e572B466D152604D9E6C3e53B432B978825342";

const PORTAL_ABI = [
  "function version() view returns (string)",
  "function getQuoteTokenConfiguration(address quoteToken) view returns ((uint8 enabled,uint8 defaultCurve,uint8 alternativeCurve,uint8 nativeToQuoteSwapType,uint8 dexId) config)",
  "event QuoteTokenConfigurationSet(address quoteToken,(uint8 enabled,uint8 defaultCurve,uint8 alternativeCurve,uint8 nativeToQuoteSwapType,uint8 dexId) config)",
];

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

export const FLAP_PORTAL_INTERFACE = new Interface(PORTAL_ABI);
export const FLAP_ERC20_INTERFACE = new Interface(ERC20_ABI);
export const FLAP_QUOTE_CONFIGURATION_TOPIC = FLAP_PORTAL_INTERFACE
  .getEvent("QuoteTokenConfigurationSet").topicHash;

const STATE_VERSION = 1;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_CONFIRMATIONS = 3;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_CHUNK_SIZE = 20_000;
const DEFAULT_MAX_BLOCKS_PER_CYCLE = 100_000;
const DEFAULT_PROCESSED_LIMIT = 2_000;
const DEFAULT_CHECKPOINT_LIMIT = 128;
const DEFAULT_AUDIT_LIMIT = 500;
const DEFAULT_ORPHANED_EVENT_LIMIT = 500;
export const FLAP_QUOTE_IMMEDIATE_MAX_AGE_MS = 15 * 60_000;
const DEFAULT_BACKOFF_BASE_MS = 3_000;
const DEFAULT_BACKOFF_MAX_MS = 300_000;
const MAX_PERSISTED_BACKOFF_MS = 3_600_000;
const MAX_STATE_EVENT_RECORDS = 20_000;
const MAX_STATE_CHECKPOINTS = 2_000;
const MAX_STATE_AUDITS = 5_000;
const MAX_STATE_ASSETS = 2_000;
const PRIOR_ARCHIVE_UNAVAILABLE_ATTEMPTS = 3;
const PRIOR_ARCHIVE_RETRY_BASE_MS = 50;
const SOURCE_TRUST = "official_docs_bound_fingerprinted_portal_receipt";
const QUOTE_SYMBOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_$.-]{0,23}$/;

function monitorError(source, code, message, details = {}) {
  const error = Object.assign(new Error(message), { source, code, details });
  const retryAfterMs = Number(details?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) error.retryAfterMs = retryAfterMs;
  return error;
}

function retryDetails(error) {
  let rpcError=error?.info?.error||error?.error;
  // ethers retains HTTP 429 JSON in responseBody, rather than retryAfterMs.
  // Preserve the provider's advertised wait instead of falling back to 3 s.
  const body=error?.info?.responseBody;
  if(typeof body==='string'&&body.length<16000)try{rpcError=JSON.parse(body)?.error||rpcError;}catch{}
  const retryAfterMs = Math.max(Number(error?.retryAfterMs)||0,Number(rpcError?.data?.retry_after_ms)||0);
  return Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? { retryAfterMs } : {};
}

export function flapQuoteScheduleInterval(state,pollIntervalMs=3000,catchUpIntervalMs=30000) {
  const behind=Number.isSafeInteger(state?.identity?.verifiedBlock)&&Number.isSafeInteger(state?.cursor?.nextBlock)
    &&state.identity.verifiedBlock-state.cursor.nextBlock>=4096;
  return behind?Math.max(pollIntervalMs,catchUpIntervalMs):pollIntervalMs;
}

function explicitArchiveStateUnavailable(error) {
  const exactBlockMachinePrunedState = [
    error?.info?.error,
    error?.cause?.info?.error,
    error?.error,
    error,
  ].some((rpcError) => Number(rpcError?.code) === -32000
    && /^historical state [0-9a-f]{64} is not available$/i.test(
      String(rpcError?.message || "").trim(),
    ));
  const messages = [
    error?.message,
    error?.shortMessage,
    error?.cause?.message,
    error?.info?.error?.message,
    error?.error?.message,
  ].filter(Boolean).join(" | ");
  return exactBlockMachinePrunedState
    || (/archive requests require|missing trie node|historical state (?:is )?(?:unavailable|not available)|state (?:was )?pruned|old state (?:is )?(?:unavailable|not available)|method (?:is )?not supported|\bnot supported\b/i.test(messages)
      && !/timeout|timed out|rate.?limit|too many requests|\b429\b/i.test(messages));
}

function record(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw monitorError("schema", "FLAP_QUOTE_INVALID_INTEGER", `${label} is invalid`);
  }
  return number;
}

function normalizedHash(value, label) {
  const hash = String(value || "");
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) {
    throw monitorError("schema", "FLAP_QUOTE_INVALID_HASH", `${label} is invalid`);
  }
  return hash.toLowerCase();
}

function normalizedAddress(value, label) {
  try {
    const result = getAddress(String(value));
    if (result.toLowerCase() === ZERO_ADDRESS) throw new Error("zero address");
    return result;
  } catch {
    throw monitorError("schema", "FLAP_QUOTE_INVALID_ADDRESS", `${label} is invalid`);
  }
}

function validCode(value) {
  return typeof value === "string" && /^0x(?:[a-fA-F0-9]{2})+$/.test(value);
}

function codeIdentity(value, label) {
  if (!validCode(value)) {
    throw monitorError("chain", "FLAP_QUOTE_CODE_EMPTY", `${label} has no runtime code`);
  }
  return {
    codeHash: keccak256(value).toLowerCase(),
    codeBytes: (value.length - 2) / 2,
  };
}

function normalizedText(value, label, maximum) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw monitorError("schema", "FLAP_QUOTE_METADATA_INVALID", `${label} is invalid`);
  }
  return text;
}

function iso(value) {
  return new Date(value).toISOString();
}

function nowMs(clock) {
  const value = typeof clock === "function" ? clock() : Date.now();
  const number = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function rpcChainId(value, label) {
  try {
    const number = Number(typeof value === "string" ? BigInt(value) : value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("invalid chain ID");
    return number;
  } catch {
    throw monitorError("chain", "FLAP_QUOTE_CHAIN_ID_INVALID", `${label} returned an invalid chain ID`);
  }
}

function expectedPortalPins(overrides = {}) {
  return {
    version: String(overrides.version || FLAP_PORTAL_VERIFIED_VERSION),
    implementation: normalizedAddress(
      overrides.implementation || FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
      "expected Portal implementation",
    ),
    implementationCodeHash: normalizedHash(
      overrides.implementationCodeHash || FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH,
      "expected Portal implementation code hash",
    ),
  };
}

function previousPortalPins() {
  return expectedPortalPins({
    version: FLAP_PORTAL_PREVIOUS_VERIFIED_VERSION,
    implementation: FLAP_PORTAL_PREVIOUS_VERIFIED_IMPLEMENTATION,
    implementationCodeHash: FLAP_PORTAL_PREVIOUS_VERIFIED_IMPLEMENTATION_HASH,
  });
}

function logIndex(log) {
  const value = log?.index ?? log?.logIndex;
  return safeInteger(value, "log.index");
}

function rpcQuantity(value, label) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw monitorError("chain", "FLAP_QUOTE_LOG_BOUNDARY_INVALID", `${label} is not a canonical RPC quantity`);
  }
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number)) {
    throw monitorError("chain", "FLAP_QUOTE_LOG_BOUNDARY_INVALID", `${label} exceeds the safe integer range`);
  }
  return number;
}

function rpcBlockQuantity(value) {
  return `0x${safeInteger(value, "log filter block").toString(16)}`;
}

function normalizeRpcLog(log) {
  if (!record(log)) {
    throw monitorError("chain", "FLAP_QUOTE_LOG_BOUNDARY_INVALID", "RPC returned a non-object Flap quote log");
  }
  return {
    ...log,
    blockNumber: rpcQuantity(log.blockNumber, "log.blockNumber"),
    transactionIndex: rpcQuantity(log.transactionIndex, "log.transactionIndex"),
    index: rpcQuantity(log.index ?? log.logIndex, "log.logIndex"),
  };
}

export function flapQuoteEventKey(log) {
  return `flap-quote:${FLAP_QUOTE_CHAIN_ID}:${normalizedHash(log?.transactionHash, "log.transactionHash")}:${logIndex(log)}`;
}

function configuration(value, label) {
  if (!value || typeof value[Symbol.iterator] !== "function") {
    throw monitorError("schema", "FLAP_QUOTE_CONFIGURATION_INVALID", `${label} is invalid`);
  }
  const fields = Array.from(value);
  if (fields.length !== 5) {
    throw monitorError("schema", "FLAP_QUOTE_CONFIGURATION_INVALID", `${label} has the wrong field count`);
  }
  const enabledRaw = safeInteger(fields[0], `${label}.enabled`, { maximum: 255 });
  if (![0, 1].includes(enabledRaw)) {
    throw monitorError("schema", "FLAP_QUOTE_CONFIGURATION_INVALID", `${label}.enabled is not a boolean uint8`);
  }
  return {
    enabled: enabledRaw === 1,
    enabledRaw,
    defaultCurve: safeInteger(fields[1], `${label}.defaultCurve`, { maximum: 255 }),
    alternativeCurve: safeInteger(fields[2], `${label}.alternativeCurve`, { maximum: 255 }),
    nativeToQuoteSwapType: safeInteger(fields[3], `${label}.nativeToQuoteSwapType`, { maximum: 255 }),
    dexId: safeInteger(fields[4], `${label}.dexId`, { maximum: 255 }),
  };
}

export function decodeFlapQuoteConfigurationLog(log) {
  if (String(log?.address || "").toLowerCase() !== FLAP_PORTAL_ADDRESS.toLowerCase()) {
    throw monitorError("chain", "FLAP_QUOTE_LOG_PORTAL_MISMATCH", "Flap quote event came from the wrong Portal");
  }
  if (!Array.isArray(log?.topics)
    || log.topics.length !== 1
    || String(log.topics[0] || "").toLowerCase() !== FLAP_QUOTE_CONFIGURATION_TOPIC.toLowerCase()) {
    throw monitorError("chain", "FLAP_QUOTE_LOG_TOPIC_INVALID", "Flap quote event topic shape is invalid");
  }
  if (typeof log.data !== "string" || !/^0x[a-fA-F0-9]{384}$/.test(log.data)) {
    throw monitorError("chain", "FLAP_QUOTE_LOG_DATA_INVALID", "Flap quote event data must contain exactly six ABI words");
  }
  let parsed;
  try {
    parsed = FLAP_PORTAL_INTERFACE.parseLog({ topics: log.topics, data: log.data });
  } catch (error) {
    throw monitorError("chain", "FLAP_QUOTE_LOG_DECODE_FAILED", `Flap quote event could not be decoded: ${error.message}`);
  }
  return {
    quoteToken: normalizedAddress(parsed.args.quoteToken, "event.quoteToken"),
    configuration: configuration(parsed.args.config, "event.configuration"),
  };
}

function initialHealth() {
  return {
    status: "initializing",
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    lastErrorCode: null,
    reorgCount: 0,
    lastReorgAt: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    failureClass: null,
  };
}

function emptyState(expectedRuntimeHash = FLAP_PORTAL_RUNTIME_HASH, pinOverrides = {}) {
  const pins = expectedPortalPins(pinOverrides);
  return {
    version: STATE_VERSION,
    initialized: false,
    initializedAt: null,
    cursor: {
      nextBlock: null,
      afterLogIndex: -1,
      anchorBlock: null,
      anchorBlockHash: null,
      baselineEstablishedAt: null,
    },
    identity: {
      chainId: FLAP_QUOTE_CHAIN_ID,
      portal: FLAP_PORTAL_ADDRESS,
      portalRuntimeCodeHash: String(expectedRuntimeHash).toLowerCase(),
      version: pins.version,
      implementation: pins.implementation,
      implementationCodeHash: pins.implementationCodeHash,
      verifiedBlock: null,
      verifiedBlockHash: null,
    },
    quoteAssets: {},
    pendingEnableCandidates: {},
    processedEventKeys: [],
    reorgOrphanedEventKeys: [],
    eventRecords: [],
    finalizedCheckpoints: [],
    auditTrail: [],
    checkedAt: null,
    _health: initialHealth(),
  };
}

function invalidState(message) {
  throw monitorError("state", "FLAP_QUOTE_STATE_INVALID", `invalid Flap quote state: ${message}`);
}

function stateTimestamp(value, nullable = false) {
  return (nullable && value === null)
    || (typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)));
}

function stateExactKeys(value, keys) {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stateHash(value) {
  return typeof value === "string" && /^0x[a-f0-9]{64}$/.test(value);
}

function stateAddress(value) {
  return typeof value === "string" && /^0x[a-f0-9]{40}$/.test(value) && value !== ZERO_ADDRESS;
}

function stateEventKey(value) {
  return typeof value === "string"
    && /^flap-quote:56:0x[a-f0-9]{64}:\d{1,10}$/.test(value)
    && value.length <= 180;
}

function statePriorStateRead(value, eventBlock) {
  return stateExactKeys(value, [
    "blockNumber", "method", "requiredIndependentReaders", "successfulReaders",
    "matchingUnavailableReaders", "failureClass",
  ])
    && Number.isSafeInteger(value.blockNumber)
    && value.blockNumber === eventBlock - 1
    && value.method === "getQuoteTokenConfiguration(address)"
    && value.requiredIndependentReaders === 2
    && [0, 1].includes(value.successfulReaders)
    && [1, 2].includes(value.matchingUnavailableReaders)
    && value.successfulReaders + value.matchingUnavailableReaders === 2
    && value.failureClass === "archive_state_unavailable";
}

function stateCandidate(value, expectedAddress = null) {
  if (!stateExactKeys(value, ["eventKey", "quoteAddress", "log", "priorTransitionProof", "priorStateRead"])
    || !stateEventKey(value.eventKey)
    || !stateAddress(value.quoteAddress)
    || (expectedAddress !== null && value.quoteAddress !== expectedAddress)
    || !stateExactKeys(value.log, [
      "address", "blockNumber", "blockHash", "transactionHash", "transactionIndex",
      "logIndex", "removed", "topics", "data",
    ])
    || String(value.log.address || "").toLowerCase() !== FLAP_PORTAL_ADDRESS.toLowerCase()
    || !Number.isSafeInteger(value.log.blockNumber)
    || value.log.blockNumber < 0
    || !stateHash(value.log.blockHash)
    || !stateHash(value.log.transactionHash)
    || !Number.isSafeInteger(value.log.transactionIndex)
    || value.log.transactionIndex < 0
    || !Number.isSafeInteger(value.log.logIndex)
    || value.log.logIndex < 0
    || value.log.removed !== false
    || !Array.isArray(value.log.topics)
    || value.log.topics.length !== 1
    || value.log.topics[0] !== FLAP_QUOTE_CONFIGURATION_TOPIC
    || !/^0x[a-f0-9]{384}$/.test(value.log.data)
    || !["verified_zero_to_one", "unavailable"].includes(value.priorTransitionProof)
    || (value.priorTransitionProof === "verified_zero_to_one" && value.priorStateRead !== null)
    || (value.priorTransitionProof === "unavailable" && !statePriorStateRead(value.priorStateRead, value.log.blockNumber))
    || value.eventKey !== `flap-quote:${FLAP_QUOTE_CHAIN_ID}:${value.log.transactionHash}:${value.log.logIndex}`) {
    return false;
  }
  try {
    return decodeFlapQuoteConfigurationLog(value.log).quoteToken.toLowerCase() === value.quoteAddress;
  } catch {
    return false;
  }
}

function stateConfiguration(value) {
  return stateExactKeys(value, [
    "enabled", "enabledRaw", "defaultCurve", "alternativeCurve", "nativeToQuoteSwapType", "dexId",
  ])
    && typeof value.enabled === "boolean"
    && Number.isSafeInteger(value.enabledRaw)
    && value.enabledRaw === (value.enabled ? 1 : 0)
    && [value.defaultCurve, value.alternativeCurve, value.nativeToQuoteSwapType, value.dexId]
      .every((item) => Number.isSafeInteger(item) && item >= 0 && item <= 255);
}

function stateAsset(value, expectedAddress = null) {
  const baseKeys = [
    "identity", "kind", "category", "vaultFactory", "quoteAddress", "quoteName", "quoteSymbol",
    "quoteDecimals", "decimals", "enabled", "configuration", "chainId", "portal", "codeHash",
    "codeBytes", "verifiedAtBlock", "verifiedAtBlockHash", "sourceUrl",
  ];
  const hasLifecycleActivation = Object.hasOwn(value || {}, "lifecycleActivationEventKey");
  if ((!stateExactKeys(value, baseKeys)
      && !stateExactKeys(value, [...baseKeys, "lifecycleActivationEventKey"]))
    || !stateAddress(value.quoteAddress)
    || (expectedAddress !== null && value.quoteAddress !== expectedAddress)
    || value.identity !== `chain-${FLAP_QUOTE_CHAIN_ID}:quote:${value.quoteAddress}`
    || value.kind !== "quote_asset"
    || value.category !== null
    || value.vaultFactory !== null
    || typeof value.quoteName !== "string"
    || !value.quoteName.trim()
    || value.quoteName.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value.quoteName)
    || !/[\p{L}\p{N}]/u.test(value.quoteName)
    || /(?:https?:\/\/|www\.)/iu.test(value.quoteName)
    || typeof value.quoteSymbol !== "string"
    || !QUOTE_SYMBOL_PATTERN.test(value.quoteSymbol)
    || !Number.isSafeInteger(value.quoteDecimals)
    || value.quoteDecimals < 0
    || value.quoteDecimals > 255
    || value.decimals !== value.quoteDecimals
    || typeof value.enabled !== "boolean"
    || !stateConfiguration(value.configuration)
    || value.enabled !== value.configuration.enabled
    || value.chainId !== FLAP_QUOTE_CHAIN_ID
    || String(value.portal || "").toLowerCase() !== FLAP_PORTAL_ADDRESS.toLowerCase()
    || !stateHash(value.codeHash)
    || !Number.isSafeInteger(value.codeBytes)
    || value.codeBytes <= 0
    || !Number.isSafeInteger(value.verifiedAtBlock)
    || value.verifiedAtBlock < 0
    || !stateHash(value.verifiedAtBlockHash)
    || (hasLifecycleActivation
      && value.lifecycleActivationEventKey !== null
      && !stateEventKey(value.lifecycleActivationEventKey))
    || value.sourceUrl !== FLAP_BOARD_URL) return false;
  return true;
}

function stateEvidence(value) {
  return stateExactKeys(value, [
    "chainId", "portal", "portalRuntimeCodeHash", "portalVersion", "portalImplementation",
    "portalImplementationCodeHash", "eventSignature", "topic0", "logIndex", "logData",
    "eventConfiguration", "finalizedConfiguration", "configurationVerifiedAtBlock",
    "metadataVerifiedAtBlock", "metadataCodeHash", "receiptVerified", "transactionVerified",
    "canonicalBlockVerified", "confirmations", "requiredConfirmations", "finalizedHead", "finalizedHeadHash",
  ])
    && value.chainId === FLAP_QUOTE_CHAIN_ID
    && String(value.portal || "").toLowerCase() === FLAP_PORTAL_ADDRESS.toLowerCase()
    && stateHash(value.portalRuntimeCodeHash)
    && typeof value.portalVersion === "string"
    && stateAddress(String(value.portalImplementation || "").toLowerCase())
    && stateHash(value.portalImplementationCodeHash)
    && value.eventSignature === FLAP_QUOTE_CONFIGURATION_SIGNATURE
    && value.topic0 === FLAP_QUOTE_CONFIGURATION_TOPIC
    && Number.isSafeInteger(value.logIndex)
    && value.logIndex >= 0
    && typeof value.logData === "string"
    && /^0x[a-f0-9]{384}$/.test(value.logData)
    && stateConfiguration(value.eventConfiguration)
    && stateConfiguration(value.finalizedConfiguration)
    && Number.isSafeInteger(value.configurationVerifiedAtBlock)
    && Number.isSafeInteger(value.metadataVerifiedAtBlock)
    && stateHash(value.metadataCodeHash)
    && value.receiptVerified === true
    && value.transactionVerified === true
    && value.canonicalBlockVerified === true
    && Number.isSafeInteger(value.confirmations)
    && value.confirmations >= 0
    && Number.isSafeInteger(value.requiredConfirmations)
    && value.requiredConfirmations >= 0
    && Number.isSafeInteger(value.finalizedHead)
    && stateHash(value.finalizedHeadHash);
}

function stateAudit(value) {
  if (!record(value) || !stateTimestamp(value.observedAt)) return false;
  if (value.type === "flap_quote_configuration_audit") {
    return stateExactKeys(value, [
      "type", "action", "eventKey", "quoteAddress", "quoteSymbol", "before", "after",
      "eventConfiguration", "transactionHash", "blockNumber", "blockHash", "logIndex", "evidence", "observedAt",
    ])
      && ["removed", "updated"].includes(value.action)
      && stateEventKey(value.eventKey)
      && stateAddress(value.quoteAddress)
      && typeof value.quoteSymbol === "string"
      && QUOTE_SYMBOL_PATTERN.test(value.quoteSymbol)
      && (value.before === null || stateAsset(value.before, value.quoteAddress))
      && stateAsset(value.after, value.quoteAddress)
      && stateConfiguration(value.eventConfiguration)
      && stateHash(value.transactionHash)
      && Number.isSafeInteger(value.blockNumber)
      && value.blockNumber >= 0
      && stateHash(value.blockHash)
      && Number.isSafeInteger(value.logIndex)
      && value.logIndex >= 0
      && stateEvidence(value.evidence);
  }
  if (value.type !== "flap_quote_reorg_audit") return false;
  if ([
    "delivered_proof_orphaned_before_commit",
    "cancelled_disable_proof_orphaned_before_commit",
  ].includes(value.action)) {
    return stateExactKeys(value, [
      "type", "action", "eventKey", "transactionHash", "blockNumber", "blockHash", "reason", "observedAt",
    ])
      && stateEventKey(value.eventKey)
      && stateHash(value.transactionHash)
      && Number.isSafeInteger(value.blockNumber)
      && value.blockNumber >= 0
      && stateHash(value.blockHash)
      && typeof value.reason === "string"
      && value.reason.length > 0
      && value.reason.length <= 500;
  }
  return stateExactKeys(value, [
    "type", "action", "detectedAtBlock", "rewoundToBlock", "orphanedEventKeys", "observedAt",
  ])
    && value.action === "rewind"
    && Number.isSafeInteger(value.detectedAtBlock)
    && value.detectedAtBlock >= 0
    && Number.isSafeInteger(value.rewoundToBlock)
    && value.rewoundToBlock >= 0
    && value.rewoundToBlock < value.detectedAtBlock
    && Array.isArray(value.orphanedEventKeys)
    && value.orphanedEventKeys.length <= MAX_STATE_EVENT_RECORDS
    && value.orphanedEventKeys.every(stateEventKey)
    && new Set(value.orphanedEventKeys).size === value.orphanedEventKeys.length;
}

function stateHealth(value) {
  return stateExactKeys(value, [
    "status", "consecutiveFailures", "lastSuccessAt", "lastErrorAt", "lastError", "lastErrorCode",
    "reorgCount", "lastReorgAt", "lastAttemptAt", "nextAttemptAt", "failureClass",
  ])
    && ["initializing", "healthy", "degraded"].includes(value.status)
    && Number.isSafeInteger(value.consecutiveFailures)
    && value.consecutiveFailures >= 0
    && stateTimestamp(value.lastSuccessAt, true)
    && stateTimestamp(value.lastErrorAt, true)
    && (value.lastError === null || (typeof value.lastError === "string" && value.lastError.length <= 500))
    && (value.lastErrorCode === null || (typeof value.lastErrorCode === "string" && /^FLAP_QUOTE_[A-Z0-9_]+$/.test(value.lastErrorCode)))
    && Number.isSafeInteger(value.reorgCount)
    && value.reorgCount >= 0
    && stateTimestamp(value.lastReorgAt, true)
    && stateTimestamp(value.lastAttemptAt, true)
    && stateTimestamp(value.nextAttemptAt, true)
    && (value.failureClass === null || ["chain", "delivery", "schema", "state", "unknown"].includes(value.failureClass));
}

function normalizeState(parsed, expectedRuntimeHash, pinOverrides = {}) {
  const pins = expectedPortalPins(pinOverrides);
  if (!record(parsed)) invalidState("root must be an object");
  if (!stateExactKeys(parsed, [
    "version", "initialized", "initializedAt", "cursor", "identity", "quoteAssets", "pendingEnableCandidates", "processedEventKeys",
    "reorgOrphanedEventKeys", "eventRecords", "finalizedCheckpoints", "auditTrail", "checkedAt", "_health",
  ])) invalidState("root keys are malformed");
  if (parsed.version !== STATE_VERSION) invalidState(`unsupported version ${String(parsed.version)}`);
  if (typeof parsed.initialized !== "boolean") invalidState("initialized must be boolean");
  for (const key of ["cursor", "identity", "quoteAssets", "pendingEnableCandidates", "_health"]) {
    if (!record(parsed[key])) invalidState(`${key} must be an object`);
  }
  for (const key of ["processedEventKeys", "reorgOrphanedEventKeys", "eventRecords", "finalizedCheckpoints", "auditTrail"]) {
    if (!Array.isArray(parsed[key])) invalidState(`${key} must be an array`);
  }
  const identityKeys = [
    "chainId", "portal", "portalRuntimeCodeHash", "version", "implementation", "implementationCodeHash",
    "verifiedBlock", "verifiedBlockHash",
    ...(parsed.initialized ? ["portalRuntimeCodeBytes", "implementationCodeBytes"] : []),
  ];
  if (!stateExactKeys(parsed.identity, identityKeys)
    || (parsed.initialized && (!Number.isSafeInteger(parsed.identity.portalRuntimeCodeBytes)
      || parsed.identity.portalRuntimeCodeBytes <= 0
      || !Number.isSafeInteger(parsed.identity.implementationCodeBytes)
      || parsed.identity.implementationCodeBytes <= 0))) {
    invalidState("identity shape is malformed");
  }
  if (parsed.identity.chainId !== FLAP_QUOTE_CHAIN_ID
    || parsed.identity.portal !== FLAP_PORTAL_ADDRESS
    || parsed.identity.portalRuntimeCodeHash !== String(expectedRuntimeHash).toLowerCase()
    || parsed.identity.version !== pins.version
    || parsed.identity.implementation !== pins.implementation
    || parsed.identity.implementationCodeHash !== pins.implementationCodeHash) {
    throw monitorError("state", "FLAP_QUOTE_STATE_IDENTITY_MISMATCH", "persisted Flap Portal identity does not match the pinned runtime");
  }
  if (parsed.processedEventKeys.length > MAX_STATE_EVENT_RECORDS
    || parsed.processedEventKeys.some((key) => !stateEventKey(key))
    || new Set(parsed.processedEventKeys).size !== parsed.processedEventKeys.length) {
    invalidState("processedEventKeys is malformed");
  }
  if (parsed.reorgOrphanedEventKeys.length > 5_000
    || parsed.reorgOrphanedEventKeys.some((key) => !stateEventKey(key))
    || new Set(parsed.reorgOrphanedEventKeys).size !== parsed.reorgOrphanedEventKeys.length) {
    invalidState("reorgOrphanedEventKeys is malformed");
  }
  if (Object.keys(parsed.quoteAssets).length > MAX_STATE_ASSETS) invalidState("quoteAssets exceeds the bound");
  for (const [key, asset] of Object.entries(parsed.quoteAssets)) {
    if (!stateAddress(key) || !stateAsset(asset, key)) {
      invalidState(`quoteAssets.${key} is malformed`);
    }
  }
  if (Object.keys(parsed.pendingEnableCandidates).length > MAX_STATE_ASSETS) {
    invalidState("pendingEnableCandidates exceeds the bound");
  }
  for (const [key, candidate] of Object.entries(parsed.pendingEnableCandidates)) {
    if (!stateAddress(key) || !stateCandidate(candidate, key)) {
      invalidState(`pendingEnableCandidates.${key} is malformed`);
    }
  }
  if (parsed.finalizedCheckpoints.length > MAX_STATE_CHECKPOINTS
    || parsed.finalizedCheckpoints.some((item) => !stateExactKeys(item, ["blockNumber", "blockHash", "observedAt"])
      || !Number.isSafeInteger(item.blockNumber)
      || item.blockNumber < 0
      || !stateHash(item.blockHash)
      || !stateTimestamp(item.observedAt))
    || parsed.finalizedCheckpoints.some((item, index) => index > 0
      && item.blockNumber <= parsed.finalizedCheckpoints[index - 1].blockNumber)) {
    invalidState("finalizedCheckpoints is malformed");
  }
  const eventRecordKeys = [
      "eventKey", "blockNumber", "blockHash", "transactionHash", "logIndex", "quoteAddress",
      "configurationVerifiedAtBlock", "configurationVerifiedAtBlockHash",
      "previousAsset", "nextAsset", "previousCandidate", "nextCandidate", "reorgReplacement", "delivered", "observedAt",
  ];
  const proofBoundEventRecordKeys = [
    ...eventRecordKeys,
    "transactionIndex", "occurredAt", "requiredConfirmations",
  ];
  if (parsed.eventRecords.length > MAX_STATE_EVENT_RECORDS
    || parsed.eventRecords.some((item) => (!stateExactKeys(item, eventRecordKeys)
      && !stateExactKeys(item, proofBoundEventRecordKeys)
      && !stateExactKeys(item, [...proofBoundEventRecordKeys, "configurationChange"]))
      || (Object.hasOwn(item, "configurationChange")
        && (!stateExactKeys(item.configurationChange, ["before", "after"])
          || !isMaterialFlapQuoteConfigurationChange(item.configurationChange.before, item.configurationChange.after)))
      || !stateEventKey(item.eventKey)
      || !Number.isSafeInteger(item.blockNumber)
      || item.blockNumber < 0
      || !stateHash(item.blockHash)
      || !stateHash(item.transactionHash)
      || !Number.isSafeInteger(item.logIndex)
      || item.logIndex < 0
      || (Object.hasOwn(item, "transactionIndex")
        && (!Number.isSafeInteger(item.transactionIndex) || item.transactionIndex < 0))
      || (Object.hasOwn(item, "occurredAt") && !stateTimestamp(item.occurredAt))
      || (Object.hasOwn(item, "requiredConfirmations")
        && (!Number.isSafeInteger(item.requiredConfirmations) || item.requiredConfirmations < 0))
      || item.eventKey !== `flap-quote:${FLAP_QUOTE_CHAIN_ID}:${item.transactionHash}:${item.logIndex}`
      || !stateAddress(item.quoteAddress)
      || !Number.isSafeInteger(item.configurationVerifiedAtBlock)
      || item.configurationVerifiedAtBlock < item.blockNumber
      || !stateHash(item.configurationVerifiedAtBlockHash)
      || (item.previousAsset !== null && !stateAsset(item.previousAsset, item.quoteAddress))
      || (item.nextAsset !== null && !stateAsset(item.nextAsset, item.quoteAddress))
      || (item.previousCandidate !== null && !stateCandidate(item.previousCandidate, item.quoteAddress))
      || (item.nextCandidate !== null && !stateCandidate(item.nextCandidate, item.quoteAddress))
      || typeof item.reorgReplacement !== "boolean"
      || typeof item.delivered !== "boolean"
      || !stateTimestamp(item.observedAt))) {
    invalidState("eventRecords is malformed");
  }
  const configurationSnapshotHashes = new Map();
  for (const item of parsed.eventRecords) {
    const priorHash = configurationSnapshotHashes.get(item.configurationVerifiedAtBlock);
    if ((priorHash && priorHash !== item.configurationVerifiedAtBlockHash)
      || (item.configurationVerifiedAtBlock === item.blockNumber
        && item.configurationVerifiedAtBlockHash !== item.blockHash)) {
      invalidState("eventRecords contain conflicting finalized decision snapshots");
    }
    configurationSnapshotHashes.set(item.configurationVerifiedAtBlock, item.configurationVerifiedAtBlockHash);
  }
  if (parsed.auditTrail.length > MAX_STATE_AUDITS || parsed.auditTrail.some((item) => !stateAudit(item))) {
    invalidState("auditTrail is malformed");
  }
  if (!stateHealth(parsed._health)) invalidState("_health is malformed");
  if (!stateTimestamp(parsed.initializedAt, true) || !stateTimestamp(parsed.checkedAt, true)) {
    invalidState("state timestamps are malformed");
  }
  if (!Number.isSafeInteger(parsed.identity.verifiedBlock) && parsed.identity.verifiedBlock !== null) {
    invalidState("identity.verifiedBlock is malformed");
  }
  if (parsed.identity.verifiedBlock !== null && parsed.identity.verifiedBlock < 0) {
    invalidState("identity.verifiedBlock is malformed");
  }
  if (parsed.identity.verifiedBlockHash !== null && !stateHash(parsed.identity.verifiedBlockHash)) {
    invalidState("identity.verifiedBlockHash is malformed");
  }
  if (parsed.initialized) {
    const cursor = parsed.cursor;
    if (!stateExactKeys(cursor, [
      "nextBlock", "afterLogIndex", "anchorBlock", "anchorBlockHash", "baselineEstablishedAt",
    ])
      || !Number.isSafeInteger(cursor.nextBlock)
      || !Number.isSafeInteger(cursor.afterLogIndex)
      || cursor.afterLogIndex < -1
      || !Number.isSafeInteger(cursor.anchorBlock)
      || !/^0x[a-fA-F0-9]{64}$/.test(String(cursor.anchorBlockHash || ""))
      || (cursor.afterLogIndex === -1 && cursor.nextBlock !== cursor.anchorBlock + 1)
      || (cursor.afterLogIndex >= 0 && cursor.nextBlock !== cursor.anchorBlock)
      || !Number.isFinite(Date.parse(cursor.baselineEstablishedAt))) {
      invalidState("initialized cursor is malformed");
    }
    if (!stateTimestamp(parsed.initializedAt)
      || !stateTimestamp(parsed.checkedAt)
      || parsed.cursor.baselineEstablishedAt !== parsed.initializedAt
      || !Number.isSafeInteger(parsed.identity.verifiedBlock)
      || parsed.identity.verifiedBlock < cursor.anchorBlock
      || !stateHash(parsed.identity.verifiedBlockHash)) {
      invalidState("initialized identity or timestamps are malformed");
    }
    const health = parsed._health;
    const healthyClosed = health.status === "healthy"
      && health.consecutiveFailures === 0
      && health.lastSuccessAt === parsed.checkedAt
      && health.lastAttemptAt === parsed.checkedAt
      && health.lastErrorAt === null
      && health.lastError === null
      && health.lastErrorCode === null
      && health.nextAttemptAt === null
      && health.failureClass === null;
    const degradedDelayMs = health.nextAttemptAt === null
      ? 0
      : Date.parse(health.nextAttemptAt) - Date.parse(health.lastAttemptAt || "");
    const degradedClosed = health.status === "degraded"
      && health.consecutiveFailures >= 1
      && health.lastErrorAt === parsed.checkedAt
      && health.lastAttemptAt === parsed.checkedAt
      && typeof health.lastError === "string"
      && health.lastError.length > 0
      && typeof health.lastErrorCode === "string"
      && typeof health.failureClass === "string"
      && Number.isFinite(degradedDelayMs)
      && degradedDelayMs >= 0
      && degradedDelayMs <= MAX_PERSISTED_BACKOFF_MS;
    if (!healthyClosed && !degradedClosed) invalidState("_health status fields are not closed");
    if ((health.reorgCount === 0) !== (health.lastReorgAt === null)) {
      invalidState("_health reorg fields are not closed");
    }
    const recordKeys = parsed.eventRecords.map((item) => item.eventKey);
    if (recordKeys.length !== parsed.processedEventKeys.length
      || recordKeys.some((key, index) => key !== parsed.processedEventKeys[index])) {
      invalidState("processedEventKeys and eventRecords are not closed");
    }
    if (parsed.reorgOrphanedEventKeys.some((key) => parsed.processedEventKeys.includes(key))) {
      invalidState("orphaned and processed event keys overlap");
    }
    for (const [address, candidate] of Object.entries(parsed.pendingEnableCandidates)) {
      const candidateRecord = parsed.eventRecords.find((item) => item.eventKey === candidate.eventKey
        && item.quoteAddress === address
        && item.blockHash === candidate.log.blockHash);
      let candidateConfiguration = null;
      try { candidateConfiguration = decodeFlapQuoteConfigurationLog(candidate.log).configuration; }
      catch { /* stateCandidate already reports the shape; keep this fail-closed */ }
      if (!candidateRecord
        || candidateRecord.delivered
        || candidateRecord.blockNumber !== candidate.log.blockNumber
        || candidateRecord.transactionHash !== candidate.log.transactionHash
        || candidateRecord.logIndex !== candidate.log.logIndex
        || JSON.stringify(candidateRecord.nextCandidate) !== JSON.stringify(candidate)
        || JSON.stringify(candidateRecord.nextAsset?.configuration) !== JSON.stringify(candidateConfiguration)) {
        invalidState("pending enable candidate has no undelivered event record");
      }
    }
    const latestRecordByAddress = new Map();
    for (const item of parsed.eventRecords) latestRecordByAddress.set(item.quoteAddress, item);
    for (const [address, item] of latestRecordByAddress) {
      const expectedCandidate = item.nextCandidate || null;
      const actualCandidate = parsed.pendingEnableCandidates[address] || null;
      if (JSON.stringify(actualCandidate) !== JSON.stringify(expectedCandidate)) {
        invalidState("pending enable candidates are not closed with the latest event record");
      }
    }
    const anchorCheckpoint = parsed.finalizedCheckpoints.at(-1);
    if (!anchorCheckpoint
      || anchorCheckpoint.blockNumber !== cursor.anchorBlock
      || anchorCheckpoint.blockHash !== cursor.anchorBlockHash) {
      invalidState("cursor anchor is not the latest finalized checkpoint");
    }
    if (cursor.afterLogIndex >= 0 && !parsed.eventRecords.some((item) => item.blockNumber === cursor.anchorBlock
      && item.blockHash === cursor.anchorBlockHash
      && item.logIndex === cursor.afterLogIndex
      && parsed.processedEventKeys.includes(item.eventKey))) {
      invalidState("partial-block cursor has no corresponding processed event");
    }
  } else {
    const cursor = parsed.cursor;
    if (!stateExactKeys(cursor, [
      "nextBlock", "afterLogIndex", "anchorBlock", "anchorBlockHash", "baselineEstablishedAt",
    ])
      || cursor.nextBlock !== null
      || cursor.afterLogIndex !== -1
      || cursor.anchorBlock !== null
      || cursor.anchorBlockHash !== null
      || cursor.baselineEstablishedAt !== null
      || parsed.initializedAt !== null
      || parsed.checkedAt !== null
      || Object.keys(parsed.quoteAssets).length
      || Object.keys(parsed.pendingEnableCandidates).length
      || parsed.processedEventKeys.length
      || parsed.reorgOrphanedEventKeys.length
      || parsed.eventRecords.length
      || parsed.finalizedCheckpoints.length
      || parsed.auditTrail.length
      || JSON.stringify(parsed._health) !== JSON.stringify(initialHealth())) {
      invalidState("uninitialized state is not canonical empty state");
    }
  }
  return structuredClone(parsed);
}

async function readState(file, fsImpl, expectedRuntimeHash, pinOverrides) {
  let parsed;
  try {
    parsed = JSON.parse(await fsImpl.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        state: emptyState(expectedRuntimeHash, pinOverrides),
        portalIdentityMigrationRequired: false,
      };
    }
    throw error;
  }
  try {
    return {
      state: normalizeState(parsed, expectedRuntimeHash, pinOverrides),
      portalIdentityMigrationRequired: false,
    };
  } catch (error) {
    if (error?.code !== "FLAP_QUOTE_STATE_IDENTITY_MISMATCH") throw error;
    // This second normalization is a narrow allow-list, not a relaxed
    // identity comparison. Every state invariant is still checked, and only
    // the exact previous verified implementation tuple may reach migration.
    const legacyState = normalizeState(parsed, expectedRuntimeHash, previousPortalPins());
    if (!legacyState.initialized) throw error;
    return { state: legacyState, portalIdentityMigrationRequired: true };
  }
}

async function closeHandle(handle, operation) {
  try {
    const result = await operation(handle);
    await handle.close();
    return result;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function atomicWriteFlapQuoteState(file, value, fsImpl = fs) {
  const directory = path.dirname(file);
  await fsImpl.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let renamed = false;
  try {
    const handle = await fsImpl.open(temporary, "wx", 0o600);
    await closeHandle(handle, async (opened) => {
      await opened.chmod(0o600);
      await opened.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await opened.sync();
    });
    await fsImpl.rename(temporary, file);
    renamed = true;
    await fsImpl.chmod(file, 0o600);
    const directoryHandle = await fsImpl.open(directory, "r");
    await closeHandle(directoryHandle, (opened) => opened.sync());
  } catch (error) {
    if (!renamed) await fsImpl.rm?.(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function stoppedError() {
  return monitorError("chain", "FLAP_QUOTE_STOPPED", "Flap quote monitor was stopped");
}

function abortable(task, signal) {
  if (!signal) return Promise.resolve(task);
  if (signal.aborted) return Promise.reject(stoppedError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(stoppedError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(task).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function contractCall(provider, iface, functionName, to, args, blockTag, errorCode) {
  const data = iface.encodeFunctionData(functionName, args);
  let output;
  try {
    // ethers v6 accepts blockTag on the transaction request; a second
    // positional argument is ignored and would silently read `latest`.
    output = await provider.call({ to, data, blockTag });
  } catch (error) {
    if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
    throw monitorError("chain", errorCode, `${functionName} failed at finalized block ${blockTag}: ${error.message}`, retryDetails(error));
  }
  if (typeof output !== "string" || !/^0x(?:[a-fA-F0-9]{2})*$/.test(output)) {
    throw monitorError("chain", errorCode, `${functionName} returned malformed ABI data`);
  }
  try {
    return iface.decodeFunctionResult(functionName, output);
  } catch (error) {
    throw monitorError("chain", errorCode, `${functionName} returned undecodable ABI data: ${error.message}`);
  }
}

export async function verifyFlapPortalIdentity(
  provider,
  finalizedBlock,
  expectedRuntimeHash = FLAP_PORTAL_RUNTIME_HASH,
  pinOverrides = {},
) {
  const pins = expectedPortalPins(pinOverrides);
  let network;
  let liveChainId = null;
  let block;
  let portalCode;
  let implementationWord;
  try {
    network = await provider.getNetwork();
    if (typeof provider.send === "function") {
      liveChainId = rpcChainId(await provider.send("eth_chainId", []), "eth_chainId");
    }
    block = await provider.getBlock(finalizedBlock);
    portalCode = await provider.getCode(FLAP_PORTAL_ADDRESS, finalizedBlock);
    implementationWord = await provider.getStorage(
      FLAP_PORTAL_ADDRESS,
      FLAP_PORTAL_IMPLEMENTATION_SLOT,
      finalizedBlock,
    );
  } catch (error) {
    if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
    throw monitorError("chain", "FLAP_QUOTE_PORTAL_IDENTITY_UNAVAILABLE", `Flap Portal identity lookup failed: ${error.message}`, retryDetails(error));
  }
  const networkChainId = rpcChainId(network?.chainId, "provider.getNetwork()");
  if (networkChainId !== FLAP_QUOTE_CHAIN_ID
    || (liveChainId !== null && liveChainId !== FLAP_QUOTE_CHAIN_ID)
    || (liveChainId !== null && liveChainId !== networkChainId)) {
    throw monitorError("chain", "FLAP_QUOTE_CHAIN_ID_MISMATCH", `RPC chain ID ${String(network?.chainId)} is not BSC chain 56`);
  }
  if (!block
    || Number(block.number) !== finalizedBlock
    || !/^0x[a-fA-F0-9]{64}$/.test(String(block.hash || ""))) {
    throw monitorError("chain", "FLAP_QUOTE_FINALIZED_BLOCK_INVALID", `finalized block ${finalizedBlock} is unavailable`);
  }
  const portalIdentity = codeIdentity(portalCode, "Flap Portal");
  if (portalIdentity.codeHash !== String(expectedRuntimeHash).toLowerCase()) {
    throw monitorError("chain", "FLAP_QUOTE_PORTAL_RUNTIME_MISMATCH", `Flap Portal runtime hash ${portalIdentity.codeHash} does not match the pinned deployment`);
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(String(implementationWord || ""))) {
    throw monitorError("chain", "FLAP_QUOTE_PORTAL_IMPLEMENTATION_INVALID", "Flap Portal EIP-1967 implementation slot is invalid");
  }
  const implementation = normalizedAddress(`0x${String(implementationWord).slice(-40)}`, "Portal implementation");
  let implementationCode;
  try {
    implementationCode = await provider.getCode(implementation, finalizedBlock);
  } catch (error) {
    if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
    throw monitorError("chain", "FLAP_QUOTE_PORTAL_IMPLEMENTATION_INVALID", `Flap Portal implementation lookup failed: ${error.message}`, retryDetails(error));
  }
  const implementationIdentity = codeIdentity(implementationCode, "Flap Portal implementation");
  const decodedVersion = await contractCall(
    provider,
    FLAP_PORTAL_INTERFACE,
    "version",
    FLAP_PORTAL_ADDRESS,
    [],
    finalizedBlock,
    "FLAP_QUOTE_PORTAL_VERSION_INVALID",
  );
  const version = normalizedText(decodedVersion[0], "Portal.version", 64);
  if (!/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
    throw monitorError("chain", "FLAP_QUOTE_PORTAL_VERSION_INVALID", `Flap Portal returned an invalid version ${version}`);
  }
  if (version !== pins.version) {
    throw monitorError("chain", "FLAP_QUOTE_PORTAL_VERSION_MISMATCH", `Flap Portal version ${version} does not match pinned ${pins.version}`);
  }
  if (implementation.toLowerCase() !== pins.implementation.toLowerCase()) {
    throw monitorError("chain", "FLAP_QUOTE_PORTAL_IMPLEMENTATION_MISMATCH", `Flap Portal implementation ${implementation} does not match the pinned implementation`);
  }
  if (implementationIdentity.codeHash !== pins.implementationCodeHash) {
    throw monitorError("chain", "FLAP_QUOTE_PORTAL_IMPLEMENTATION_HASH_MISMATCH", `Flap Portal implementation runtime hash ${implementationIdentity.codeHash} does not match the pinned implementation`);
  }
  let finalBlock;
  try { finalBlock = await provider.getBlock(finalizedBlock); }
  catch (error) {
    if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
    throw monitorError("chain", "FLAP_QUOTE_PORTAL_IDENTITY_CHANGED", `finalized identity block ${finalizedBlock} recheck failed: ${error.message}`, retryDetails(error));
  }
  if (!finalBlock
    || Number(finalBlock.number) !== finalizedBlock
    || String(finalBlock.hash || "").toLowerCase() !== String(block.hash).toLowerCase()) {
    throw monitorError("chain", "FLAP_QUOTE_PORTAL_IDENTITY_CHANGED", `finalized identity block ${finalizedBlock} changed during Portal verification`);
  }
  return {
    chainId: FLAP_QUOTE_CHAIN_ID,
    portal: FLAP_PORTAL_ADDRESS,
    portalRuntimeCodeHash: portalIdentity.codeHash,
    portalRuntimeCodeBytes: portalIdentity.codeBytes,
    version,
    implementation,
    implementationCodeHash: implementationIdentity.codeHash,
    implementationCodeBytes: implementationIdentity.codeBytes,
    verifiedBlock: finalizedBlock,
    verifiedBlockHash: normalizedHash(finalBlock.hash, "finalized block hash"),
  };
}

function sameLog(left, right) {
  const leftTopics = Array.isArray(left?.topics) ? left.topics.map((value) => String(value).toLowerCase()) : [];
  const rightTopics = Array.isArray(right?.topics) ? right.topics.map((value) => String(value).toLowerCase()) : [];
  return String(left?.address || "").toLowerCase() === String(right?.address || "").toLowerCase()
    && String(left?.transactionHash || "").toLowerCase() === String(right?.transactionHash || "").toLowerCase()
    && String(left?.blockHash || "").toLowerCase() === String(right?.blockHash || "").toLowerCase()
    && String(left?.data || "").toLowerCase() === String(right?.data || "").toLowerCase()
    && logIndex(left) === logIndex(right)
    && leftTopics.length === rightTopics.length
    && leftTopics.every((topic, index) => topic === rightTopics[index]);
}

function serializableLog(log) {
  return {
    address: normalizedAddress(log.address, "log.address"),
    blockNumber: safeInteger(log.blockNumber, "log.blockNumber"),
    blockHash: normalizedHash(log.blockHash, "log.blockHash"),
    transactionHash: normalizedHash(log.transactionHash, "log.transactionHash"),
    transactionIndex: safeInteger(log.transactionIndex, "log.transactionIndex"),
    logIndex: logIndex(log),
    removed: false,
    topics: log.topics.map((value, index) => normalizedHash(value, `log.topics[${index}]`)),
    data: String(log.data).toLowerCase(),
  };
}

function assertLogBoundary(log, fromBlock, toBlock, finalizedBlock) {
  const blockNumber = safeInteger(log?.blockNumber, "log.blockNumber");
  if (log?.removed !== false
    || blockNumber < fromBlock
    || blockNumber > toBlock
    || blockNumber > finalizedBlock
    || String(log?.address || "").toLowerCase() !== FLAP_PORTAL_ADDRESS.toLowerCase()
    || !Array.isArray(log?.topics)
    || log.topics.length !== 1
    || String(log.topics[0] || "").toLowerCase() !== FLAP_QUOTE_CONFIGURATION_TOPIC.toLowerCase()
    || !/^0x[a-fA-F0-9]{64}$/.test(String(log?.transactionHash || ""))
    || !/^0x[a-fA-F0-9]{64}$/.test(String(log?.blockHash || ""))
    || !Number.isSafeInteger(log?.transactionIndex)
    || !Number.isSafeInteger(log?.index ?? log?.logIndex)) {
    throw monitorError("chain", "FLAP_QUOTE_LOG_BOUNDARY_INVALID", `RPC returned a non-canonical Flap quote log for ${fromBlock}-${toBlock}`);
  }
}

function acceptedDelivery(result) {
  const status = String(result?.status || "").toLowerCase();
  if (status === "delivered") return true;
  return status === "suppressed"
    && result?.persisted === true
    && result?.canonicalOwnerDelivered === true
    && String(result?.reason || result?.disabledReason || "").toLowerCase() === "semantic_duplicate";
}

function acceptedCancellation(result) {
  return String(result?.status || "").toLowerCase() === "cancelled"
    && String(result?.reason || "").toLowerCase() === "quote_asset_disabled"
    && result?.persisted === true
    && result?.terminal === true;
}

function acceptedLifecycle(result, expected) {
  const status = String(result?.status || "").toLowerCase();
  return result?.accepted === true
    && String(result?.action || "").toLowerCase() === expected.action
    && String(result?.quoteAddress || "").toLowerCase() === expected.quoteAddress
    && (status === expected.action || status === "duplicate");
}

function appendBounded(values, value, limit) {
  return [...values, value].slice(-limit);
}

function trimEventJournal(next, limit) {
  if (next.eventRecords.length <= limit) {
    next.processedEventKeys = next.eventRecords.map((item) => item.eventKey);
    return;
  }
  const pinned = new Set(Object.values(next.pendingEnableCandidates).map((item) => item.eventKey));
  if (pinned.size > limit) {
    throw monitorError("state", "FLAP_QUOTE_STATE_INVALID", "pending activation journal exceeds the retained event limit");
  }
  const retained = new Set(pinned);
  for (let index = next.eventRecords.length - 1; index >= 0 && retained.size < limit; index -= 1) {
    retained.add(next.eventRecords[index].eventKey);
  }
  next.eventRecords = next.eventRecords.filter((item) => retained.has(item.eventKey));
  next.processedEventKeys = next.eventRecords.map((item) => item.eventKey);
}

function putCheckpoint(state, blockNumber, blockHash, observedAt, limit) {
  const byBlock = new Map(state.finalizedCheckpoints.map((item) => [item.blockNumber, item]));
  byBlock.set(blockNumber, { blockNumber, blockHash: normalizedHash(blockHash, "checkpoint.blockHash"), observedAt });
  state.finalizedCheckpoints = [...byBlock.values()]
    .sort((left, right) => left.blockNumber - right.blockNumber)
    .slice(-limit);
}

function markHealthy(next, observedAt) {
  next.checkedAt = observedAt;
  next._health = {
    ...next._health,
    status: "healthy",
    consecutiveFailures: 0,
    lastSuccessAt: observedAt,
    lastErrorAt: null,
    lastError: null,
    lastErrorCode: null,
    lastAttemptAt: observedAt,
    nextAttemptAt: null,
    failureClass: null,
  };
}

function eventProof(prepared, identity, finalizedBlock, finalizedBlockHash, latestHead, requiredConfirmations) {
  const { log, proof, eventConfiguration, asset } = prepared;
  return {
    chainId: FLAP_QUOTE_CHAIN_ID,
    portal: FLAP_PORTAL_ADDRESS,
    portalRuntimeCodeHash: identity.portalRuntimeCodeHash,
    portalVersion: identity.version,
    portalImplementation: identity.implementation,
    portalImplementationCodeHash: identity.implementationCodeHash,
    eventSignature: FLAP_QUOTE_CONFIGURATION_SIGNATURE,
    topic0: FLAP_QUOTE_CONFIGURATION_TOPIC,
    logIndex: log.logIndex,
    logData: log.data,
    eventConfiguration,
    finalizedConfiguration: asset.configuration,
    configurationVerifiedAtBlock: finalizedBlock,
    metadataVerifiedAtBlock: finalizedBlock,
    metadataCodeHash: asset.codeHash,
    receiptVerified: true,
    transactionVerified: true,
    canonicalBlockVerified: true,
    confirmations: latestHead - proof.blockNumber,
    requiredConfirmations,
    finalizedHead: finalizedBlock,
    finalizedHeadHash: finalizedBlockHash,
  };
}

function capabilityEvent(prepared, identity, context, observedAt) {
  const { log, proof, asset } = prepared;
  const evidence = eventProof(
    prepared,
    identity,
    context.finalizedBlock,
    context.finalizedBlockHash,
    context.latestHead,
    context.requiredConfirmations,
  );
  const explorerUrl = `https://bscscan.com/tx/${proof.transactionHash}`;
  const originalEventKey = flapQuoteEventKey(log);
  const event = {
    type: "platform_capability_update",
    kind: "flap_quote_asset_enabled",
    changeType: "added",
    eventKey: originalEventKey,
    platform: {
      id: "flap",
      name: "Flap",
      website: "https://flap.sh",
      board: FLAP_BOARD_URL,
    },
    chain: { id: FLAP_QUOTE_CHAIN_ID, chainId: FLAP_QUOTE_CHAIN_ID, name: "BNB Chain", environment: "mainnet" },
    chainId: FLAP_QUOTE_CHAIN_ID,
    portal: FLAP_PORTAL_ADDRESS,
    source: {
      id: "flap_portal_quote_configuration",
      name: "Flap official Portal + Board",
      url: FLAP_BOARD_URL,
      docsUrl: FLAP_DEPLOYED_CONTRACTS_URL,
      official: true,
      trust: SOURCE_TRUST,
    },
    sourceUrl: FLAP_BOARD_URL,
    url: explorerUrl,
    explorerUrl,
    observedAt,
    occurredAt: proof.blockTimestamp,
    blockTimestamp: proof.blockTimestamp,
    transactionHash: proof.transactionHash,
    blockNumber: proof.blockNumber,
    blockHash: proof.blockHash,
    logIndex: proof.logIndex,
    receiptProof: {
      status: 1,
      transactionHash: proof.transactionHash,
      transactionIndex: proof.transactionIndex,
      blockNumber: proof.blockNumber,
      blockHash: proof.blockHash,
      logIndex: proof.logIndex,
      logMatched: true,
    },
    transactionProof: {
      hash: proof.transactionHash,
      from: proof.transactionFrom,
      to: proof.transactionTo,
      nonce: proof.transactionNonce,
      blockNumber: proof.blockNumber,
      blockHash: proof.blockHash,
    },
    blockProof: {
      number: proof.blockNumber,
      hash: proof.blockHash,
      timestamp: proof.blockTimestamp,
      canonical: true,
      confirmations: evidence.confirmations,
      requiredConfirmations: context.requiredConfirmations,
    },
    onchainProof: evidence,
    evidence,
    changes: {
      newFlapPools: [asset],
      updatedFlapPools: [],
      removedFlapPools: [],
      flapPoolChanges: [],
      newQuoteTokens: [asset.quoteSymbol],
      newQuoteConfigs: [{
        symbol: asset.quoteSymbol,
        address: asset.quoteAddress,
        ...asset.configuration,
      }],
      newContracts: [asset.quoteAddress],
    },
    signal: {
      strong: true,
      platformStructural: true,
      category: "Flap quote asset enabled",
      headline: `Flap enabled ${asset.quoteSymbol} as a BSC quote asset`,
      quotePairChange: {
        stage: "live",
        assetClass: "quote_asset",
        assets: [{
          symbol: asset.quoteSymbol,
          name: asset.quoteName,
          address: asset.quoteAddress,
          decimals: asset.quoteDecimals,
        }],
      },
    },
    strong: true,
    reorgOrphanedEventKeys: [...(context.reorgOrphanedEventKeys || [])],
    risk: "A Portal quote configuration is platform capability evidence, not proof of token safety, liquidity depth, backing, or favorable execution.",
  };
  const lagMs = Date.parse(observedAt) - Date.parse(proof.blockTimestamp);
  if (prepared.priorTransitionProof === "unavailable") {
    if (!Number.isFinite(lagMs) || lagMs <= FLAP_QUOTE_IMMEDIATE_MAX_AGE_MS) {
      throw monitorError(
        "state",
        "FLAP_QUOTE_FIRST_OBSERVED_FRESH_INVALID",
        "first-observed-after-gap evidence must be older than the realtime activation window",
      );
    }
    return {
      ...event,
      kind: "flap_quote_asset_first_observed_after_gap",
      changeType: "observed",
      eventKey: `${originalEventKey}:first-observed-after-gap:v1`,
      originalEventKey,
      priorTransitionProof: "unavailable",
      priorStateRead: structuredClone(prepared.priorStateRead),
      changes: {
        newFlapPools: [],
        updatedFlapPools: [asset],
        removedFlapPools: [],
        flapPoolChanges: [],
        newQuoteTokens: [],
        newQuoteConfigs: [],
        newContracts: [],
      },
      signal: {
        strong: false,
        platformStructural: true,
        category: "Flap quote asset first observed after gap",
        headline: `Flap first observed ${asset.quoteSymbol} currently enabled after a monitoring gap`,
        quotePairChange: {
          stage: "observed",
          assetClass: "quote_asset",
          assets: [{
            symbol: asset.quoteSymbol,
            name: asset.quoteName,
            address: asset.quoteAddress,
            decimals: asset.quoteDecimals,
          }],
        },
      },
      strong: false,
      delayedRecovery: {
        version: 1,
        reason: "first_observed_after_gap",
        sourceOccurredAt: proof.blockTimestamp,
        originalBlockNumber: proof.blockNumber,
        originalBlockHash: proof.blockHash,
        originalTransactionHash: proof.transactionHash,
        originalLogIndex: proof.logIndex,
        recoveredAt: observedAt,
        lagMs,
        cursor: {
          nextBlockAtRecovery: context.cursor.nextBlock,
          eventBlock: proof.blockNumber,
        },
      },
      risk: "Historical archive state was unavailable from the required independent readers. This confirms only that the quote asset is enabled now; it does not prove a new 0-to-1 activation, token safety, liquidity, backing, or favorable execution.",
    };
  }
  if (!Number.isFinite(lagMs) || lagMs <= FLAP_QUOTE_IMMEDIATE_MAX_AGE_MS) return event;
  return {
    ...event,
    eventKey: `${originalEventKey}:delayed-recovery:v1`,
    originalEventKey,
    delayedRecovery: {
      version: 1,
      reason: "monitoring_gap_recovery",
      sourceOccurredAt: proof.blockTimestamp,
      originalBlockNumber: proof.blockNumber,
      originalBlockHash: proof.blockHash,
      originalTransactionHash: proof.transactionHash,
      originalLogIndex: proof.logIndex,
      recoveredAt: observedAt,
      lagMs,
      cursor: {
        nextBlockAtRecovery: context.cursor.nextBlock,
        eventBlock: proof.blockNumber,
      },
    },
  };
}

function configurationAudit(prepared, previousAsset, nextAsset, identity, context, observedAt) {
  const action = previousAsset?.enabled === true && !nextAsset.enabled ? "removed" : "updated";
  return {
    type: "flap_quote_configuration_audit",
    action,
    eventKey: flapQuoteEventKey(prepared.log),
    quoteAddress: nextAsset.quoteAddress,
    quoteSymbol: nextAsset.quoteSymbol,
    before: previousAsset || null,
    after: nextAsset,
    eventConfiguration: prepared.eventConfiguration,
    transactionHash: prepared.proof.transactionHash,
    blockNumber: prepared.proof.blockNumber,
    blockHash: prepared.proof.blockHash,
    logIndex: prepared.proof.logIndex,
    evidence: eventProof(
      prepared,
      identity,
      context.finalizedBlock,
      context.finalizedBlockHash,
      context.latestHead,
      context.requiredConfirmations,
    ),
    observedAt,
  };
}

export function createFlapQuoteMonitor(config = {}, dependencies = {}) {
  const enabled = config.flapQuoteMonitorEnabled === true;
  const rawProvider = dependencies.provider;
  const fsImpl = dependencies.fsImpl || fs;
  const logger = dependencies.logger || console;
  const clock = dependencies.now || Date.now;
  const alertSender = dependencies.sendAlertsImpl || sendAlerts;
  const cancelActivation = dependencies.cancelPendingFlapQuoteActivationImpl
    || cancelPendingFlapQuoteActivation;
  const quotePoolLifecycle = dependencies.onFlapQuotePoolLifecycle;
  const autoStart = dependencies.autoStart !== false;
  const expectedRuntimeHash = String(dependencies.expectedPortalRuntimeHash || FLAP_PORTAL_RUNTIME_HASH).toLowerCase();
  const portalPins = expectedPortalPins({
    version: dependencies.expectedPortalVersion,
    implementation: dependencies.expectedPortalImplementation,
    implementationCodeHash: dependencies.expectedPortalImplementationHash,
  });
  const writeStateImpl = dependencies.atomicWriteImpl
    || ((file, value) => atomicWriteFlapQuoteState(file, value, fsImpl));
  const stateFile = config.flapQuoteStateFile
    || path.join(config.dataDir || ".data", "flap-quote-state.json");
  const requiredConfirmations = Math.max(0, safeInteger(
    config.flapQuoteConfirmations ?? config.confirmations ?? DEFAULT_CONFIRMATIONS,
    "flapQuoteConfirmations",
  ));
  const pollIntervalMs = Math.max(250, Number(config.flapQuotePollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
  const catchUpIntervalMs = Math.max(pollIntervalMs,Number(config.flapQuoteCatchUpIntervalMs)||30000);
  const chunkSize = Math.max(1, safeInteger(config.flapQuoteEventChunkSize ?? DEFAULT_CHUNK_SIZE, "flapQuoteEventChunkSize"));
  const maxBlocksPerCycle = Math.max(chunkSize, safeInteger(
    config.flapQuoteMaxBlocksPerCycle ?? DEFAULT_MAX_BLOCKS_PER_CYCLE,
    "flapQuoteMaxBlocksPerCycle",
  ));
  const logMaxBlockSpan = Math.max(1, safeInteger(
    config.flapQuoteLogMaxBlockSpan ?? 10_000,
    "flapQuoteLogMaxBlockSpan",
  ));
  const logConcurrency = Math.max(1, Math.min(32, safeInteger(
    config.flapQuoteLogConcurrency ?? 2,
    "flapQuoteLogConcurrency",
  )));
  const publicLogIntervalMs=Math.max(0,safeInteger(config.flapQuoteLogRequestIntervalMs??1000,'flapQuoteLogRequestIntervalMs'));
  const processedLimit = Math.max(MAX_STATE_ASSETS, Math.min(20_000, safeInteger(
    config.flapQuoteProcessedLimit ?? DEFAULT_PROCESSED_LIMIT,
    "flapQuoteProcessedLimit",
  )));
  const checkpointLimit = Math.max(4, Math.min(2_000, safeInteger(
    config.flapQuoteCheckpointLimit ?? DEFAULT_CHECKPOINT_LIMIT,
    "flapQuoteCheckpointLimit",
  )));
  const auditLimit = Math.max(10, Math.min(5_000, safeInteger(
    config.flapQuoteAuditLimit ?? DEFAULT_AUDIT_LIMIT,
    "flapQuoteAuditLimit",
  )));
  const orphanedEventLimit = Math.max(10, Math.min(5_000, safeInteger(
    config.flapQuoteOrphanedEventLimit ?? DEFAULT_ORPHANED_EVENT_LIMIT,
    "flapQuoteOrphanedEventLimit",
  )));
  const backoffBaseMs = Math.min(MAX_PERSISTED_BACKOFF_MS, safeInteger(
    config.flapQuoteBackoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
    "flapQuoteBackoffBaseMs",
  ));
  const backoffMaxMs = Math.min(MAX_PERSISTED_BACKOFF_MS, Math.max(backoffBaseMs, safeInteger(
    config.flapQuoteBackoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
    "flapQuoteBackoffMaxMs",
  )));
  const random = dependencies.random || Math.random;

  if (enabled && !rawProvider) throw new Error("createFlapQuoteMonitor requires a BSC provider");

  function fixedReaders(candidates, dependencyName) {
    if (enabled && (!Array.isArray(candidates) || candidates.length < 2)) {
      throw new Error(`createFlapQuoteMonitor requires at least two fixed-origin ${dependencyName}`);
    }
    const readers = (candidates || []).map((candidate, index) => {
      const readerProvider = candidate?.provider || candidate;
      const sourceId = String(candidate?.sourceId || candidate?.origin || "");
      let origin;
      let physicalHost;
      try {
        const parsedSource = new URL(sourceId);
        origin = parsedSource.origin.toLowerCase();
        physicalHost = parsedSource.hostname.toLowerCase().replace(/\.+$/u, "");
      }
      catch { throw new Error(`${dependencyName}[${index}] requires a valid sourceId origin`); }
      if (origin !== sourceId.toLowerCase()
        || !["http:", "https:"].includes(new URL(origin).protocol)
        || !physicalHost
        || typeof readerProvider?.send !== "function"
        || ["getNetwork", "getBlock", "getCode", "getStorage", "call"]
          .some((method) => typeof readerProvider?.[method] !== "function")) {
        throw new Error(`${dependencyName}[${index}] must be a fixed HTTP(S) JSON-RPC reader`);
      }
      return { provider: readerProvider, sourceId: origin, physicalHost };
    });
    if (new Set(readers.map((reader) => reader.physicalHost)).size !== readers.length) {
      throw new Error(`${dependencyName} must use distinct physical hosts`);
    }
    return readers;
  }
  const logReaders = fixedReaders(dependencies.logVerificationProviders, "logVerificationProviders");
  const stateReaders = fixedReaders(dependencies.stateVerificationProviders, "stateVerificationProviders");
  if (enabled && stateReaders.length !== 2) {
    throw new Error("createFlapQuoteMonitor requires exactly two stateVerificationProviders");
  }

  let cycleController = null;
  const provider = rawProvider ? new Proxy(rawProvider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args) => abortable(Promise.resolve().then(() => value.apply(target, args)), cycleController?.signal);
    },
  }) : null;
  let state = emptyState(expectedRuntimeHash, portalPins);
  let initialized = false;
  let portalIdentityMigrationRequired = false;
  // Before the first durable baseline, and while an exact legacy identity is
  // awaiting current-chain verification, keep retry pacing in memory. A
  // transient RPC failure must not create a partially trusted durable state
  // or mutate the legacy cursor before the replacement identity is proved.
  let preBaselineFailures = 0;
  let preBaselineNextAttemptAt = null;
  let preBaselineLastErrorCode = null;
  let stopped = false;
  let started = false;
  let timer = null;
  let activeCheck = null;
  let activeDelivery = null;
  let deliveryCriticalSection = false;
  let stopPromise = null;
  let writeQueue = Promise.resolve();
  let pendingCommitSnapshot = null;

  async function initialize() {
    if (initialized) return;
    const loaded = await readState(stateFile, fsImpl, expectedRuntimeHash, portalPins);
    state = loaded.state;
    portalIdentityMigrationRequired = loaded.portalIdentityMigrationRequired;
    if (!portalIdentityMigrationRequired
      && state.initialized
      && state._health.status === "degraded"
      && state._health.nextAttemptAt) {
      const persistedNextMs = Date.parse(state._health.nextAttemptAt);
      const lastAttemptMs = Date.parse(state._health.lastAttemptAt || "");
      const configuredNextMs = lastAttemptMs + backoffMaxMs;
      if (Number.isFinite(persistedNextMs)
        && Number.isFinite(configuredNextMs)
        && persistedNextMs > configuredNextMs) {
        state._health.nextAttemptAt = iso(configuredNextMs);
      }
    }
    trimEventJournal(state, processedLimit);
    state.reorgOrphanedEventKeys = state.reorgOrphanedEventKeys.slice(-orphanedEventLimit);
    state.finalizedCheckpoints = state.finalizedCheckpoints.slice(-checkpointLimit);
    state.auditTrail = state.auditTrail.slice(-auditLimit);
    initialized = true;
  }

  function enqueueWrite(snapshot) {
    const operation = writeQueue.catch(() => {}).then(() => writeStateImpl(stateFile, snapshot));
    writeQueue = operation;
    return operation;
  }

  async function commit(next) {
    const snapshot = structuredClone(next);
    try {
      await enqueueWrite(snapshot);
      state = snapshot;
      pendingCommitSnapshot = null;
    } catch (error) {
      // rename(2) may already have installed the complete snapshot before a
      // later chmod or directory-fsync reports failure.  Reconcile the exact
      // on-disk JSON before deciding whether the in-memory cursor advanced;
      // otherwise a failed first baseline could silently baseline again at a
      // later head and skip every intervening event.
      let persisted = null;
      try {
        persisted = normalizeState(
          JSON.parse(await fsImpl.readFile(stateFile, "utf8")),
          expectedRuntimeHash,
          portalPins,
        );
      }
      catch { /* the commit outcome remains uncertain */ }
      if (persisted !== null && JSON.stringify(persisted) === JSON.stringify(snapshot)) {
        state = snapshot;
        pendingCommitSnapshot = null;
        return;
      } else {
        pendingCommitSnapshot = snapshot;
      }
      throw error;
    }
  }

  async function fixedRpcExact(readers, method, params, errorCode, label) {
    const readFrom = async (reader) => {
      try {
        await requireLogReaderChain(reader);
        const value = await abortable(
          Promise.resolve().then(() => reader.provider.send(method, params)),
          cycleController?.signal,
        );
        return typeof value === "string" ? value.toLowerCase() : value;
      } catch (error) {
        if (error?.code === "FLAP_QUOTE_STOPPED" || error?.code === "FLAP_QUOTE_LOG_CHAIN_ID_MISMATCH") throw error;
        throw monitorError("chain", errorCode, `${label} failed on ${reader.sourceId}: ${error.message}`, retryDetails(error));
      }
    };
    const settled = await Promise.allSettled(readers.map(readFrom));
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    const values = settled.map((result) => result.value);
    const canonical = JSON.stringify(values[0]);
    if (values.slice(1).some((value) => JSON.stringify(value) !== canonical)) {
      throw monitorError("chain", `${errorCode}_MISMATCH`, `${label} disagrees across fixed physical RPC readers`);
    }
    return values[0];
  }

  async function fixedContractCall(iface, functionName, to, args, blockTag, errorCode) {
    const data = iface.encodeFunctionData(functionName, args);
    const output = await fixedRpcExact(
      stateReaders,
      "eth_call",
      [{ to, data }, rpcBlockQuantity(blockTag)],
      errorCode,
      `${functionName} at finalized block ${blockTag}`,
    );
    if (typeof output !== "string" || !/^0x(?:[a-f0-9]{2})*$/.test(output)) {
      throw monitorError("chain", errorCode, `${functionName} returned malformed ABI data`);
    }
    try { return iface.decodeFunctionResult(functionName, output); }
    catch (error) {
      throw monitorError("chain", errorCode, `${functionName} returned undecodable ABI data: ${error.message}`);
    }
  }

  async function readFixedBlockFrom(readers, blockNumber, errorCode, label) {
    const number = safeInteger(blockNumber, "fixed block number");
    const readFrom = async (reader) => {
      try {
        await requireLogReaderChain(reader);
        const block = await abortable(
          Promise.resolve().then(() => reader.provider.getBlock(number)),
          cycleController?.signal,
        );
        if (!block
          || Number(block.number) !== number
          || !/^0x[a-fA-F0-9]{64}$/.test(String(block.hash || ""))
          || !/^0x[a-fA-F0-9]{64}$/.test(String(block.parentHash || ""))
          || !Number.isSafeInteger(Number(block.timestamp))) {
          throw new Error(`block ${number} is malformed`);
        }
        return {
          number,
          hash: normalizedHash(block.hash, `${label} hash`),
          parentHash: normalizedHash(block.parentHash, `${label} parent hash`),
          timestamp: Number(block.timestamp),
        };
      } catch (error) {
        if (error?.code === "FLAP_QUOTE_STOPPED" || error?.code === "FLAP_QUOTE_LOG_CHAIN_ID_MISMATCH") throw error;
        throw monitorError("chain", errorCode, `${label} failed on ${reader.sourceId}: ${error.message}`, retryDetails(error));
      }
    };
    const settled = await Promise.allSettled(readers.map(readFrom));
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    const blocks = settled.map((result) => result.value);
    const canonical = JSON.stringify(blocks[0]);
    if (blocks.slice(1).some((block) => JSON.stringify(block) !== canonical)) {
      throw monitorError(
        "chain",
        `${errorCode}_MISMATCH`,
        `${label} disagrees across fixed physical RPC readers`,
      );
    }
    return blocks[0];
  }

  const readFixedBlock = (blockNumber, errorCode, label) => (
    readFixedBlockFrom(logReaders, blockNumber, errorCode, label)
  );

  const readStateBlock = (blockNumber, errorCode, label) => (
    readFixedBlockFrom(stateReaders, blockNumber, errorCode, label)
  );

  async function requireFixedBlockHash(blockNumber, expectedHash, errorCode, message, details = {}) {
    let block;
    try {
      block = await readFixedBlock(blockNumber, errorCode, message);
    } catch (error) {
      if (error?.code === "FLAP_QUOTE_STOPPED"
        || error?.code === "FLAP_QUOTE_LOG_CHAIN_ID_MISMATCH") throw error;
      // Transport and availability failures are not evidence of a reorg.  In
      // particular, never attach `reorgScope` here: doing so would let a
      // post-delivery timeout incorrectly orphan a still-canonical alert.
      throw monitorError("chain", errorCode, `${message}: ${error.message}`, retryDetails(error));
    }
    if (block.hash !== String(expectedHash).toLowerCase()) {
      throw monitorError("chain", errorCode, message, details);
    }
    return block.hash;
  }

  async function requireStateBlockHash(blockNumber, expectedHash, errorCode, message) {
    let block;
    try {
      block = await readStateBlock(blockNumber, errorCode, message);
    } catch (error) {
      if (error?.code === "FLAP_QUOTE_STOPPED"
        || error?.code === "FLAP_QUOTE_LOG_CHAIN_ID_MISMATCH") throw error;
      throw monitorError("chain", errorCode, `${message}: ${error.message}`, retryDetails(error));
    }
    if (block.hash !== String(expectedHash).toLowerCase()) {
      throw monitorError("chain", errorCode, message);
    }
    return block.hash;
  }

  async function verifyIdentityQuorum(finalizedBlock) {
    const settled = await Promise.allSettled(stateReaders.map(async (reader) => {
      // verifyFlapPortalIdentity already checks getNetwork AND a fresh
      // eth_chainId on this exact reader. Avoid a third identical chain call.
      return verifyFlapPortalIdentity(
        reader.provider,
        finalizedBlock,
        expectedRuntimeHash,
        portalPins,
      );
    }));
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    const identities = settled.map((result) => result.value);
    const canonical = JSON.stringify(identities[0]);
    if (identities.slice(1).some((identity) => JSON.stringify(identity) !== canonical)) {
      throw monitorError(
        "chain",
        "FLAP_QUOTE_PORTAL_IDENTITY_REDUNDANCY_MISMATCH",
        `Flap Portal identity disagrees across fixed physical RPC readers at block ${finalizedBlock}`,
      );
    }
    return identities[0];
  }

  async function readQuoteAsset(quoteToken, finalizedBlock, finalizedBlockHash) {
    const address = normalizedAddress(quoteToken, "quote token");
    await requireStateBlockHash(
      finalizedBlock,
      finalizedBlockHash,
      "FLAP_QUOTE_CONFIGURATION_SNAPSHOT_CHANGED",
      `finalized quote configuration block ${finalizedBlock} changed before fixed-reader state reads`,
    );
    const decodedConfiguration = await fixedContractCall(
      FLAP_PORTAL_INTERFACE,
      "getQuoteTokenConfiguration",
      FLAP_PORTAL_ADDRESS,
      [address],
      finalizedBlock,
      "FLAP_QUOTE_CONFIGURATION_READ_FAILED",
    );
    const finalConfiguration = configuration(decodedConfiguration[0], "finalized configuration");
    const code = await fixedRpcExact(
      stateReaders,
      "eth_getCode",
      [address, rpcBlockQuantity(finalizedBlock)],
      "FLAP_QUOTE_METADATA_UNAVAILABLE",
      `quote token code ${address} at finalized block ${finalizedBlock}`,
    );
    const tokenIdentity = codeIdentity(code, `quote token ${address}`);
    const decodedName = await fixedContractCall(
      FLAP_ERC20_INTERFACE,
      "name",
      address,
      [],
      finalizedBlock,
      "FLAP_QUOTE_METADATA_UNAVAILABLE",
    );
    const decodedSymbol = await fixedContractCall(
      FLAP_ERC20_INTERFACE,
      "symbol",
      address,
      [],
      finalizedBlock,
      "FLAP_QUOTE_METADATA_UNAVAILABLE",
    );
    const decodedDecimals = await fixedContractCall(
      FLAP_ERC20_INTERFACE,
      "decimals",
      address,
      [],
      finalizedBlock,
      "FLAP_QUOTE_METADATA_UNAVAILABLE",
    );
    const quoteName = normalizedText(decodedName[0], "quote token name", 256);
    const quoteSymbol = normalizedText(decodedSymbol[0], "quote token symbol", 24);
    if (!QUOTE_SYMBOL_PATTERN.test(quoteSymbol)) {
      throw monitorError("schema", "FLAP_QUOTE_METADATA_INVALID", "quote token symbol contains unsupported characters");
    }
    if (!/[\p{L}\p{N}]/u.test(quoteName) || /(?:https?:\/\/|www\.)/iu.test(quoteName)) {
      throw monitorError("schema", "FLAP_QUOTE_METADATA_INVALID", "quote token name is unsafe or non-semantic");
    }
    const quoteDecimals = safeInteger(decodedDecimals[0], "quote token decimals", { maximum: 255 });
    await requireStateBlockHash(
      finalizedBlock,
      finalizedBlockHash,
      "FLAP_QUOTE_CONFIGURATION_SNAPSHOT_CHANGED",
      `finalized quote configuration block ${finalizedBlock} changed during fixed-reader state reads`,
    );
    const quoteAddress = address.toLowerCase();
    return {
      identity: `chain-${FLAP_QUOTE_CHAIN_ID}:quote:${quoteAddress}`,
      kind: "quote_asset",
      category: null,
      vaultFactory: null,
      quoteAddress,
      quoteName,
      quoteSymbol,
      quoteDecimals,
      decimals: quoteDecimals,
      enabled: finalConfiguration.enabled,
      configuration: finalConfiguration,
      chainId: FLAP_QUOTE_CHAIN_ID,
      portal: FLAP_PORTAL_ADDRESS,
      codeHash: tokenIdentity.codeHash,
      codeBytes: tokenIdentity.codeBytes,
      verifiedAtBlock: finalizedBlock,
      verifiedAtBlockHash: finalizedBlockHash,
      sourceUrl: FLAP_BOARD_URL,
    };
  }

  async function requireLogReaderChain(reader) {
    const liveChainId = rpcChainId(
      await abortable(
        Promise.resolve().then(() => reader.provider.send("eth_chainId", [])),
        cycleController?.signal,
      ),
      `${reader.sourceId} eth_chainId`,
    );
    if (liveChainId !== FLAP_QUOTE_CHAIN_ID) {
      throw monitorError(
        "chain",
        "FLAP_QUOTE_LOG_CHAIN_ID_MISMATCH",
        `log reader ${reader.sourceId} is on chain ${liveChainId}, not BSC chain 56`,
      );
    }
  }

  async function readPriorConfiguration(
    quoteToken,
    blockNumber,
    blockTimestamp,
    expectedPriorBlockHash,
  ) {
    const priorBlock = safeInteger(blockNumber - 1, "prior configuration block");
    const data = FLAP_PORTAL_INTERFACE.encodeFunctionData("getQuoteTokenConfiguration", [quoteToken]);
    const priorBlockProof = await readStateBlock(
      priorBlock,
      "FLAP_QUOTE_PRIOR_CONFIGURATION_UNAVAILABLE",
      `prior configuration block ${priorBlock}`,
    );
    if (priorBlockProof.hash !== normalizedHash(expectedPriorBlockHash, "event parent block hash")) {
      throw monitorError(
        "chain",
        "FLAP_QUOTE_PRIOR_LANE_MISMATCH",
        `state and log RPC lanes disagree on event parent block ${priorBlock}`,
      );
    }
    const readFrom = async (reader) => {
      let output;
      for (let attempt = 1; attempt <= PRIOR_ARCHIVE_UNAVAILABLE_ATTEMPTS; attempt += 1) {
        try {
          await requireLogReaderChain(reader);
          output = await abortable(
            Promise.resolve().then(() => reader.provider.send("eth_call", [{
              to: FLAP_PORTAL_ADDRESS,
              data,
            }, { blockHash: priorBlockProof.hash, requireCanonical: true }])),
            cycleController?.signal,
          );
          break;
        } catch (error) {
          if (error?.code === "FLAP_QUOTE_STOPPED" || error?.code === "FLAP_QUOTE_LOG_CHAIN_ID_MISMATCH") throw error;
          if (!explicitArchiveStateUnavailable(error)) {
            throw monitorError("chain", "FLAP_QUOTE_PRIOR_CONFIGURATION_UNAVAILABLE", `prior quote configuration read failed at block ${priorBlock}: ${error.message}`, retryDetails(error));
          }
          if (attempt === PRIOR_ARCHIVE_UNAVAILABLE_ATTEMPTS) return { unavailable: true };
          await abortable(
            new Promise((resolve) => setTimeout(
              resolve,
              PRIOR_ARCHIVE_RETRY_BASE_MS * (2 ** (attempt - 1)),
            )),
            cycleController?.signal,
          );
        }
      }
      if (typeof output !== "string" || !/^0x(?:[a-fA-F0-9]{2})+$/.test(output)) {
        throw monitorError("chain", "FLAP_QUOTE_PRIOR_CONFIGURATION_INVALID", "prior quote configuration returned malformed ABI data");
      }
      const normalized = output.toLowerCase();
      try {
        const decoded = FLAP_PORTAL_INTERFACE.decodeFunctionResult("getQuoteTokenConfiguration", normalized);
        return {
          unavailable: false,
          output: normalized,
          configuration: configuration(decoded[0], "prior configuration"),
        };
      } catch (error) {
        throw monitorError("chain", "FLAP_QUOTE_PRIOR_CONFIGURATION_INVALID", `prior quote configuration ABI decode failed: ${error.message}`);
      }
    };
    const settled = await Promise.allSettled(stateReaders.map(readFrom));
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    await requireStateBlockHash(
      priorBlock,
      priorBlockProof.hash,
      "FLAP_QUOTE_PRIOR_CONFIGURATION_CHANGED",
      `prior configuration block ${priorBlock} changed during archive reads`,
    );
    const results = settled.map((result) => result.value);
    const successful = results.filter((result) => !result.unavailable);
    const unavailable = results.length - successful.length;
    if (successful.length === stateReaders.length
      && successful.slice(1).some((result) => result.output !== successful[0].output)) {
      throw monitorError(
        "chain",
        "FLAP_QUOTE_PRIOR_CONFIGURATION_MISMATCH",
        `independent prior quote configurations disagree at block ${priorBlock}`,
      );
    }
    if (successful.length === stateReaders.length) {
      return {
        configuration: successful[0].configuration,
        priorTransitionProof: "verified",
        priorStateRead: null,
      };
    }
    const ageMs = nowMs(clock) - Date.parse(blockTimestamp);
    if (!state.initialized
      || !Number.isFinite(ageMs)
      || ageMs <= FLAP_QUOTE_IMMEDIATE_MAX_AGE_MS
      || successful.length + unavailable !== stateReaders.length) {
      throw monitorError(
        "chain",
        "FLAP_QUOTE_PRIOR_CONFIGURATION_REDUNDANCY_INCOMPLETE",
        `prior quote configuration lacks two archive-state results at block ${priorBlock}`,
      );
    }
    return {
      configuration: null,
      priorTransitionProof: "unavailable",
      priorStateRead: {
        blockNumber: priorBlock,
        method: "getQuoteTokenConfiguration(address)",
        requiredIndependentReaders: stateReaders.length,
        successfulReaders: successful.length,
        matchingUnavailableReaders: unavailable,
        failureClass: "archive_state_unavailable",
      },
    };
  }

  async function verifyReceipt(log, latestHead, receiptCache, transactionCache, blockCache) {
    const transactionHash = normalizedHash(log.transactionHash, "log.transactionHash");
    let receipt = receiptCache.get(transactionHash);
    if (!receipt) {
      try { receipt = await provider.getTransactionReceipt(transactionHash); }
      catch (error) {
        if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
        throw monitorError("chain", "FLAP_QUOTE_RECEIPT_UNAVAILABLE", `receipt lookup failed for ${transactionHash}: ${error.message}`, retryDetails(error));
      }
      receiptCache.set(transactionHash, receipt);
    }
    let transaction = transactionCache.get(transactionHash);
    if (!transaction) {
      try { transaction = await provider.getTransaction(transactionHash); }
      catch (error) {
        if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
        throw monitorError("chain", "FLAP_QUOTE_TRANSACTION_UNAVAILABLE", `transaction lookup failed for ${transactionHash}: ${error.message}`, retryDetails(error));
      }
      transactionCache.set(transactionHash, transaction);
    }
    let block = blockCache.get(log.blockNumber);
    if (!block) {
      try {
        block = await readFixedBlock(
          log.blockNumber,
          "FLAP_QUOTE_BLOCK_UNAVAILABLE",
          `event block ${log.blockNumber}`,
        );
      }
      catch (error) {
        if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
        throw monitorError("chain", "FLAP_QUOTE_BLOCK_UNAVAILABLE", `block lookup failed for ${log.blockNumber}: ${error.message}`, retryDetails(error));
      }
      blockCache.set(log.blockNumber, block);
    }
    const receiptHash = String(receipt?.hash || receipt?.transactionHash || "").toLowerCase();
    const transactionBlockHash = String(transaction?.blockHash || "").toLowerCase();
    const confirmations = latestHead - log.blockNumber;
    if (!receipt
      || Number(receipt.status) !== 1
      || receiptHash !== transactionHash
      || Number(receipt.blockNumber) !== log.blockNumber
      || String(receipt.blockHash || "").toLowerCase() !== log.blockHash
      || !Array.isArray(receipt.logs)
      || !receipt.logs.some((candidate) => sameLog(candidate, log))
      || !transaction
      || String(transaction.hash || "").toLowerCase() !== transactionHash
      || transaction.to == null
      || Number(transaction.blockNumber) !== log.blockNumber
      || transactionBlockHash !== log.blockHash
      || !block
      || Number(block.number) !== log.blockNumber
      || String(block.hash || "").toLowerCase() !== log.blockHash
      || !Number.isSafeInteger(Number(block.timestamp))
      || confirmations < requiredConfirmations) {
      throw monitorError("chain", "FLAP_QUOTE_RECEIPT_MISMATCH", `receipt, transaction, block, or confirmation proof failed for ${transactionHash}`);
    }
    return {
      transactionHash,
      transactionFrom: normalizedAddress(transaction.from, "transaction.from"),
      transactionTo: normalizedAddress(transaction.to, "transaction.to"),
      transactionNonce: safeInteger(transaction.nonce, "transaction.nonce"),
      transactionIndex: safeInteger(receipt.index ?? receipt.transactionIndex, "receipt.transactionIndex"),
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      parentBlockHash: normalizedHash(block.parentHash, "event block parent hash"),
      blockTimestamp: iso(Number(block.timestamp) * 1_000),
      logIndex: log.logIndex,
      confirmations,
    };
  }

  async function prepareRange(fromBlock, toBlock, context) {
    let fixedEnd;
    try { fixedEnd = await readFixedBlock(toBlock, "FLAP_QUOTE_SCAN_ANCHOR_INVALID", `scan end block ${toBlock}`); }
    catch (error) {
      if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
      throw monitorError("chain", "FLAP_QUOTE_SCAN_ANCHOR_INVALID", `scan end block ${toBlock} lookup failed: ${error.message}`, retryDetails(error));
    }
    if (!fixedEnd || Number(fixedEnd.number) !== toBlock || !/^0x[a-fA-F0-9]{64}$/.test(String(fixedEnd.hash || ""))) {
      throw monitorError("chain", "FLAP_QUOTE_SCAN_ANCHOR_INVALID", `scan end block ${toBlock} is invalid`);
    }
    const filter = {
      address: FLAP_PORTAL_ADDRESS,
      fromBlock,
      toBlock,
      topics: [FLAP_QUOTE_CONFIGURATION_TOPIC],
    };
    const readRange = async (reader) => {
      // Public archive endpoints have different bounds. The indexed readers
      // reproduced both historical quote logs and the pinned upgrade log;
      // Sentio explicitly caps a range at 10,000 blocks. NOWNodes 65k reads
      // time out, so use the same verified 10k bound. Older fallbacks retain
      // their smaller tested bounds.
      // Compare the entire contiguous range after paging, never a partial set.
      const providerSpan = {
        'bsc.blockrazor.xyz':25, 'bsc.rpc.blxrbdn.com':512,
        'bsc.rpc.sentio.xyz':10000, 'public-bsc.nownodes.io':10000,
      }[reader.physicalHost];
      const pageBlockSpan = Math.min(providerSpan||logMaxBlockSpan,logMaxBlockSpan);
      const pages = [];
      for (let pageStart = fromBlock; pageStart <= toBlock; pageStart += pageBlockSpan) {
        pages.push({
          fromBlock: pageStart,
          toBlock: Math.min(toBlock, pageStart + pageBlockSpan - 1),
        });
      }
      const pageResults = new Array(pages.length);
      let nextPage = 0;
      let firstError = null;
      let nextRequestAt=0;
      try {
        await requireLogReaderChain(reader);
        const worker = async () => {
          while (firstError === null) {
            const pageIndex = nextPage;
            nextPage += 1;
            if (pageIndex >= pages.length) return;
            const page = pages[pageIndex];
            try {
              if(['bsc.blockrazor.xyz','bsc.rpc.sentio.xyz','public-bsc.nownodes.io'].includes(reader.physicalHost)){
                const at=Math.max(Date.now(),nextRequestAt);nextRequestAt=at+publicLogIntervalMs;
                if(at>Date.now())await abortable(delay(at-Date.now(),undefined,{signal:cycleController?.signal}),cycleController?.signal);
                if(firstError)return;
              }
              pageResults[pageIndex] = await abortable(
                Promise.resolve().then(() => reader.provider.send("eth_getLogs", [{
                  ...filter,
                  fromBlock: rpcBlockQuantity(page.fromBlock),
                  toBlock: rpcBlockQuantity(page.toBlock),
                }])),
                cycleController?.signal,
              );
            } catch (error) {
              firstError ||= error;
            }
          }
        };
        await Promise.all(Array.from(
          { length: Math.min(logConcurrency, pages.length) },
          () => worker(),
        ));
        if (firstError) throw firstError;
      } catch (error) {
        if (error?.code === "FLAP_QUOTE_STOPPED" || error?.code === "FLAP_QUOTE_LOG_CHAIN_ID_MISMATCH") throw error;
        throw monitorError("chain", "FLAP_QUOTE_GET_LOGS_FAILED", `Flap quote log scan ${fromBlock}-${toBlock} at ${reader.physicalHost} failed: ${error.message}`, retryDetails(error));
      }
      if (pageResults.some((result) => !Array.isArray(result))) {
        throw monitorError("chain", "FLAP_QUOTE_LOG_BOUNDARY_INVALID", "RPC returned a non-array Flap quote log result");
      }
      const normalized = pageResults.flat().map(normalizeRpcLog);
      for (const log of normalized) assertLogBoundary(log, fromBlock, toBlock, context.finalizedBlock);
      const orderedResult = normalized.map(serializableLog).sort((left, right) => left.blockNumber - right.blockNumber
        || left.transactionIndex - right.transactionIndex
        || left.logIndex - right.logIndex);
      const resultKeys = orderedResult.map(flapQuoteEventKey);
      if (new Set(resultKeys).size !== resultKeys.length) {
        throw monitorError("chain", "FLAP_QUOTE_LOG_DUPLICATE", `RPC returned duplicate Flap quote logs for ${fromBlock}-${toBlock}`);
      }
      return orderedResult;
    };
    const settled = await Promise.allSettled(logReaders.map(readRange));
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    const replicas = settled.map((result) => result.value);
    const canonicalReplica = JSON.stringify(replicas[0]);
    if (replicas.slice(1).some((candidate) => JSON.stringify(candidate) !== canonicalReplica)) {
      throw monitorError(
        "chain",
        "FLAP_QUOTE_LOG_REDUNDANCY_MISMATCH",
        `independent RPC log results disagree for ${fromBlock}-${toBlock}`,
      );
    }
    const ordered = replicas[0];
    const receiptCache = new Map();
    const transactionCache = new Map();
    const blockCache = new Map();
    const assetCache = new Map();
    const precedingConfiguration = new Map(Object.entries(state.quoteAssets).map(([address, asset]) => [
      address,
      asset.configuration,
    ]));
    const prepared = [];
    for (const log of ordered) {
      if (log.blockNumber === state.cursor.nextBlock && log.logIndex <= state.cursor.afterLogIndex) continue;
      if (state.processedEventKeys.includes(flapQuoteEventKey(log))) continue;
      const decoded = decodeFlapQuoteConfigurationLog(log);
      const proof = await verifyReceipt(log, context.latestHead, receiptCache, transactionCache, blockCache);
      const addressKey = decoded.quoteToken.toLowerCase();
      let priorConfiguration = null;
      let priorTransitionProof = null;
      let priorStateRead = null;
      if (decoded.configuration.enabled) {
        if (precedingConfiguration.has(addressKey)) {
          priorConfiguration = precedingConfiguration.get(addressKey);
          priorTransitionProof = "verified";
        } else {
          const prior = await readPriorConfiguration(
            decoded.quoteToken,
            log.blockNumber,
            proof.blockTimestamp,
            proof.parentBlockHash,
          );
          priorConfiguration = prior.configuration;
          priorTransitionProof = prior.priorTransitionProof;
          priorStateRead = prior.priorStateRead;
        }
      }
      precedingConfiguration.set(addressKey, decoded.configuration);
      let asset = assetCache.get(decoded.quoteToken.toLowerCase());
      if (!asset) {
        asset = await readQuoteAsset(decoded.quoteToken, context.finalizedBlock, context.finalizedBlockHash);
        assetCache.set(decoded.quoteToken.toLowerCase(), asset);
      }
      prepared.push({
        log,
        proof,
        eventConfiguration: decoded.configuration,
        priorConfiguration,
        priorTransitionProof,
        priorStateRead,
        asset,
      });
    }
    let finalEnd;
    try { finalEnd = await readFixedBlock(toBlock, "FLAP_QUOTE_SCAN_ANCHOR_CHANGED", `scan end block ${toBlock} recheck`); }
    catch (error) {
      if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
      throw monitorError("chain", "FLAP_QUOTE_SCAN_ANCHOR_CHANGED", `scan end block ${toBlock} recheck failed: ${error.message}`, retryDetails(error));
    }
    if (!finalEnd
      || Number(finalEnd.number) !== toBlock
      || String(finalEnd.hash || "").toLowerCase() !== String(fixedEnd.hash).toLowerCase()) {
      throw monitorError("chain", "FLAP_QUOTE_SCAN_ANCHOR_CHANGED", `scan end block ${toBlock} changed during verification`);
    }
    return {
      prepared,
      endBlockHash: normalizedHash(finalEnd.hash, "scan end block hash"),
    };
  }

  async function requireCanonicalHash(blockNumber, expectedHash, code, message, details = {}) {
    return requireFixedBlockHash(blockNumber, expectedHash, code, message, details);
  }

  async function requirePreparedCanonical(prepared, context, phase) {
    await requireCanonicalHash(
      prepared.proof.blockNumber,
      prepared.proof.blockHash,
      "FLAP_QUOTE_PRECOMMIT_REORG",
      `Flap quote event block changed ${phase}`,
      { reorgScope: "event" },
    );
    if (prepared.proof.blockNumber !== context.finalizedBlock) {
      await requireCanonicalHash(
        context.finalizedBlock,
        context.finalizedBlockHash,
        "FLAP_QUOTE_PRECOMMIT_REORG",
        `Flap quote finalized snapshot changed ${phase}`,
        { reorgScope: "configuration_snapshot" },
      );
    }
  }

  async function retainDeliveredOrphan(prepared, observedAt, reason) {
    const key = flapQuoteEventKey(prepared.log);
    const next = structuredClone(state);
    const recordIndex = next.eventRecords.findIndex((item) => item.eventKey === key
      && item.blockHash === prepared.proof.blockHash);
    if (recordIndex >= 0) {
      // The candidate was already durably journaled before delivery.  Keep
      // processed/orphan sets disjoint and record that the send happened; the
      // next fixed-reader reorg recovery will rewind the record and promote
      // its key to orphan provenance only if the fork remains non-canonical.
      next.eventRecords[recordIndex].delivered = true;
      for (const item of next.eventRecords) {
        if (item.quoteAddress !== prepared.asset.quoteAddress.toLowerCase()) continue;
        if (item.previousCandidate?.eventKey === key) item.previousCandidate = null;
        if (item.nextCandidate?.eventKey === key) item.nextCandidate = null;
      }
      if (next.pendingEnableCandidates[prepared.asset.quoteAddress.toLowerCase()]?.eventKey === key) {
        delete next.pendingEnableCandidates[prepared.asset.quoteAddress.toLowerCase()];
      }
    } else {
      next.reorgOrphanedEventKeys = [...new Set([
        ...next.reorgOrphanedEventKeys,
        key,
      ])].slice(-orphanedEventLimit);
    }
    next.auditTrail = appendBounded(next.auditTrail, {
      type: "flap_quote_reorg_audit",
      action: "delivered_proof_orphaned_before_commit",
      eventKey: key,
      transactionHash: prepared.proof.transactionHash,
      blockNumber: prepared.proof.blockNumber,
      blockHash: prepared.proof.blockHash,
      reason,
      observedAt,
    }, auditLimit);
    next._health = {
      ...next._health,
      reorgCount: Number(next._health.reorgCount || 0) + 1,
      lastReorgAt: observedAt,
    };
    await commit(next);
  }

  async function retainCancelledDisableOrphan(prepared, observedAt, reason) {
    const key = flapQuoteEventKey(prepared.log);
    const next = structuredClone(state);
    next.reorgOrphanedEventKeys = [...new Set([
      ...next.reorgOrphanedEventKeys,
      key,
    ])].slice(-orphanedEventLimit);
    next.auditTrail = appendBounded(next.auditTrail, {
      type: "flap_quote_reorg_audit",
      action: "cancelled_disable_proof_orphaned_before_commit",
      eventKey: key,
      transactionHash: prepared.proof.transactionHash,
      blockNumber: prepared.proof.blockNumber,
      blockHash: prepared.proof.blockHash,
      reason,
      observedAt,
    }, auditLimit);
    next._health = {
      ...next._health,
      reorgCount: Number(next._health.reorgCount || 0) + 1,
      lastReorgAt: observedAt,
    };
    await commit(next);
  }

  function candidateFor(prepared) {
    return {
      eventKey: flapQuoteEventKey(prepared.log),
      quoteAddress: prepared.asset.quoteAddress.toLowerCase(),
      log: serializableLog(prepared.log),
      priorTransitionProof: prepared.priorTransitionProof === "unavailable"
        ? "unavailable"
        : "verified_zero_to_one",
      priorStateRead: prepared.priorTransitionProof === "unavailable"
        ? structuredClone(prepared.priorStateRead)
        : null,
    };
  }

  function lifecycleRecord(prepared, action) {
    return {
      version: 1,
      action,
      quoteAddress: prepared.asset.quoteAddress.toLowerCase(),
      quoteName: prepared.asset.quoteName,
      quoteSymbol: prepared.asset.quoteSymbol,
      activationEventKey: flapQuoteEventKey(prepared.log),
      transactionHash: prepared.proof.transactionHash,
      blockNumber: prepared.proof.blockNumber,
      blockHash: prepared.proof.blockHash,
      transactionIndex: prepared.proof.transactionIndex,
      logIndex: prepared.proof.logIndex,
      occurredAt: prepared.proof.blockTimestamp,
      proofType: action === "activated" ? "verified_zero_to_one"
        : action === "reconfigured" ? "verified_configuration_change" : "verified_disable",
      ...(action === "reconfigured" ? {
        previousConfiguration: structuredClone(prepared.priorConfiguration),
        configuration: structuredClone(prepared.eventConfiguration),
        configurationLog: { address: prepared.log.address.toLowerCase(),
          topics: [...prepared.log.topics], data: prepared.log.data },
      } : {}),
      requiredConfirmations,
      monitorOnly: true,
    };
  }

  function restoredLifecycleRecord(record) {
    return {
      version: 1,
      action: "restored",
      quoteAddress: record.quoteAddress,
      quoteName: record.previousAsset.quoteName,
      quoteSymbol: record.previousAsset.quoteSymbol,
      activationEventKey: record.eventKey,
      targetActivationEventKey: record.previousAsset.lifecycleActivationEventKey,
      transactionHash: record.transactionHash,
      blockNumber: record.blockNumber,
      blockHash: record.blockHash,
      transactionIndex: record.transactionIndex,
      logIndex: record.logIndex,
      occurredAt: record.occurredAt,
      proofType: "verified_disable_orphaned",
      requiredConfirmations: record.requiredConfirmations,
      monitorOnly: true,
    };
  }

  function revertedConfigurationLifecycleRecord(record) {
    return {
      version: 1,
      action: "reverted",
      quoteAddress: record.quoteAddress,
      activationEventKey: record.eventKey,
      targetActivationEventKey: record.previousAsset?.lifecycleActivationEventKey || null,
      quoteName: record.nextAsset.quoteName,
      quoteSymbol: record.nextAsset.quoteSymbol,
      transactionHash: record.transactionHash,
      blockNumber: record.blockNumber,
      blockHash: record.blockHash,
      transactionIndex: record.transactionIndex,
      logIndex: record.logIndex,
      occurredAt: record.occurredAt,
      proofType: "verified_configuration_change_orphaned",
      requiredConfirmations: record.requiredConfirmations,
      monitorOnly: true,
    };
  }

  async function registerQuotePoolLifecycleRecord(record) {
    if (typeof quotePoolLifecycle !== "function") {
      throw monitorError(
        "delivery",
        "FLAP_QUOTE_LIFECYCLE_NOT_DURABLE",
        "Flap quote lifecycle registry is unavailable",
      );
    }
    const wasDeliveryCritical = deliveryCriticalSection;
    deliveryCriticalSection = true;
    let result;
    const registration = Promise.resolve().then(() => quotePoolLifecycle(structuredClone(record)));
    activeDelivery = registration;
    try {
      try {
        result = await registration;
      } catch (error) {
        throw monitorError(
          "delivery",
          "FLAP_QUOTE_LIFECYCLE_NOT_DURABLE",
          `Flap quote lifecycle registration threw: ${error.message}`,
          retryDetails(error),
        );
      }
      if (!acceptedLifecycle(result, record)) {
        throw monitorError(
          "delivery",
          "FLAP_QUOTE_LIFECYCLE_NOT_DURABLE",
          `Flap quote lifecycle was not durably accepted${result?.reason ? `: ${result.reason}` : ""}`,
          retryDetails(result),
        );
      }
      return result;
    } finally {
      if (activeDelivery === registration) activeDelivery = null;
      deliveryCriticalSection = wasDeliveryCritical;
    }
  }

  function registerQuotePoolLifecycle(prepared, action) {
    return registerQuotePoolLifecycleRecord(lifecycleRecord(prepared, action));
  }

  function eventRecord(
    prepared,
    previousAsset,
    nextAsset,
    previousCandidate,
    nextCandidate,
    reorgReplacement,
    delivered,
    context,
    observedAt,
  ) {
    return {
      eventKey: flapQuoteEventKey(prepared.log),
      blockNumber: prepared.proof.blockNumber,
      blockHash: prepared.proof.blockHash,
      transactionHash: prepared.proof.transactionHash,
      transactionIndex: prepared.proof.transactionIndex,
      logIndex: prepared.proof.logIndex,
      occurredAt: prepared.proof.blockTimestamp,
      requiredConfirmations: context.requiredConfirmations,
      quoteAddress: prepared.asset.quoteAddress,
      configurationVerifiedAtBlock: context.finalizedBlock,
      configurationVerifiedAtBlockHash: context.finalizedBlockHash,
      previousAsset: previousAsset || null,
      nextAsset,
      previousCandidate: previousCandidate || null,
      nextCandidate: nextCandidate || null,
      reorgReplacement,
      delivered,
      observedAt,
      ...(prepared.priorTransitionProof === "verified"
        && isMaterialFlapQuoteConfigurationChange(prepared.priorConfiguration, prepared.eventConfiguration)
        ? { configurationChange: { before: structuredClone(prepared.priorConfiguration),
          after: structuredClone(prepared.eventConfiguration) } } : {}),
    };
  }

  async function commitPrepared(prepared, identity, context, observedAt) {
    const key = flapQuoteEventKey(prepared.log);
    const addressKey = prepared.asset.quoteAddress.toLowerCase();
    const previousAsset = state.quoteAssets[addressKey] ? structuredClone(state.quoteAssets[addressKey]) : null;
    const previousCandidate = state.pendingEnableCandidates[addressKey] || null;
    const reorgReplacement = state.reorgOrphanedEventKeys.includes(key);
    const nextAsset = {
      ...prepared.asset,
      enabled: prepared.eventConfiguration.enabled,
      configuration: prepared.eventConfiguration,
      lifecycleActivationEventKey: prepared.eventConfiguration.enabled
        ? previousAsset?.lifecycleActivationEventKey || null
        : null,
    };
    const activationCandidate = prepared.eventConfiguration.enabled === true
      && (prepared.priorConfiguration?.enabled === false
        || prepared.priorTransitionProof === "unavailable");
    const configurationChanged = prepared.priorTransitionProof === "verified"
      && isMaterialFlapQuoteConfigurationChange(prepared.priorConfiguration, prepared.eventConfiguration);
    const pendingEnableNeedsLifecycle = configurationChanged
      && previousCandidate?.priorTransitionProof === "verified_zero_to_one"
      && !previousAsset?.lifecycleActivationEventKey;
    let nextCandidate = previousCandidate;
    if (!prepared.eventConfiguration.enabled) nextCandidate = null;
    else if (activationCandidate) nextCandidate = candidateFor(prepared);

    await requirePreparedCanonical(prepared, context, "before event decision commit");
    if (!prepared.eventConfiguration.enabled && previousCandidate) {
      const cancellationObservedAt = iso(nowMs(clock));
      let cancellationResult;
      try {
        cancellationResult = await cancelActivation(config, {
          originalEventKey: previousCandidate.eventKey,
          quoteAddress: addressKey,
          reason: "quote_asset_disabled",
          disablingEventKey: key,
          blockNumber: prepared.proof.blockNumber,
          blockHash: prepared.proof.blockHash,
          transactionHash: prepared.proof.transactionHash,
          logIndex: prepared.proof.logIndex,
          observedAt: cancellationObservedAt,
        });
      } catch (error) {
        throw monitorError(
          "delivery",
          "FLAP_QUOTE_CANCELLATION_NOT_DURABLE",
          `pending Flap quote activation cancellation threw: ${error.message}`,
          retryDetails(error),
        );
      }
      if (!acceptedCancellation(cancellationResult)) {
        throw monitorError(
          "delivery",
          "FLAP_QUOTE_CANCELLATION_NOT_DURABLE",
          `pending Flap quote activation was not durably cancelled${cancellationResult?.reason ? `: ${cancellationResult.reason}` : ""}`,
          retryDetails(cancellationResult),
        );
      }
      try {
        await requirePreparedCanonical(prepared, context, "after activation cancellation and before disable commit");
      } catch (error) {
        if (error?.code === "FLAP_QUOTE_PRECOMMIT_REORG"
          && error?.details?.reorgScope === "event") {
          await retainCancelledDisableOrphan(prepared, cancellationObservedAt, error.message);
        }
        throw error;
      }
    }
    if (!prepared.eventConfiguration.enabled) {
      await registerQuotePoolLifecycle(prepared, "disabled");
    }
    if (configurationChanged) {
      // Preserve the original enable identity if it is waiting only for its
      // notification. A later semantic change gets its own generation; it is
      // never represented as another zero-to-one activation.
      if (pendingEnableNeedsLifecycle) {
        const pendingProof = await verifyReceipt(previousCandidate.log, context.latestHead,
          new Map(), new Map(), new Map());
        await registerQuotePoolLifecycle({ ...prepared, log: previousCandidate.log,
          proof: pendingProof }, "activated");
        if (previousAsset) previousAsset.lifecycleActivationEventKey = previousCandidate.eventKey;
      }
      await registerQuotePoolLifecycle(prepared, "reconfigured");
      await requirePreparedCanonical(prepared, context, "after configuration generation handoff");
      nextAsset.lifecycleActivationEventKey = key;
    }
    const next = structuredClone(state);
    if (pendingEnableNeedsLifecycle) {
      const priorRecord = next.eventRecords.find((item) => item.eventKey === previousCandidate.eventKey);
      if (priorRecord) priorRecord.nextAsset.lifecycleActivationEventKey = previousCandidate.eventKey;
    }
    // A canonical replacement may legitimately reuse the same transaction
    // hash and log index after a reorg. Once that exact key is canonical again
    // it must no longer be retained as orphan provenance.
    next.reorgOrphanedEventKeys = next.reorgOrphanedEventKeys.filter((candidate) => candidate !== key);
    next.quoteAssets[addressKey] = nextAsset;
    if (nextCandidate) next.pendingEnableCandidates[addressKey] = nextCandidate;
    else delete next.pendingEnableCandidates[addressKey];
    next.eventRecords.push(
      eventRecord(
        prepared,
        previousAsset,
        nextAsset,
        previousCandidate,
        nextCandidate,
        reorgReplacement,
        false,
        context,
        observedAt,
      ),
    );
    trimEventJournal(next, processedLimit);
    if (!activationCandidate) {
      next.auditTrail = appendBounded(
        next.auditTrail,
        configurationAudit(prepared, previousAsset, nextAsset, identity, context, observedAt),
        auditLimit,
      );
    }
    next.cursor.nextBlock = prepared.proof.blockNumber;
    next.cursor.afterLogIndex = prepared.proof.logIndex;
    next.cursor.anchorBlock = prepared.proof.blockNumber;
    next.cursor.anchorBlockHash = prepared.proof.blockHash;
    next.identity = { ...next.identity, ...identity };
    putCheckpoint(next, prepared.proof.blockNumber, prepared.proof.blockHash, observedAt, checkpointLimit);
    markHealthy(next, observedAt);
    await commit(next);
    return { delivered: 0, audited: activationCandidate ? 0 : 1 };
  }

  async function deliverPending(identity, context, observedAt) {
    if (state.cursor.nextBlock <= context.finalizedBlock) return 0;
    const pending = Object.values(state.pendingEnableCandidates)
      .sort((left, right) => left.log.blockNumber - right.log.blockNumber
        || left.log.transactionIndex - right.log.transactionIndex
        || left.log.logIndex - right.log.logIndex
        || left.quoteAddress.localeCompare(right.quoteAddress));
    let delivered = 0;
    const receiptCache = new Map();
    const transactionCache = new Map();
    const blockCache = new Map();
    for (const candidate of pending) {
      if (stopped) throw stoppedError();
      const addressKey = candidate.quoteAddress.toLowerCase();
      const current = state.pendingEnableCandidates[addressKey];
      if (!current || current.eventKey !== candidate.eventKey || current.log.blockHash !== candidate.log.blockHash) continue;
      const decoded = decodeFlapQuoteConfigurationLog(candidate.log);
      if (!decoded.configuration.enabled || decoded.quoteToken.toLowerCase() !== addressKey) {
        throw monitorError("state", "FLAP_QUOTE_STATE_INVALID", `pending activation ${candidate.eventKey} no longer decodes as enabled`);
      }
      const proof = await verifyReceipt(
        candidate.log,
        context.latestHead,
        receiptCache,
        transactionCache,
        blockCache,
      );
      const asset = await readQuoteAsset(decoded.quoteToken, context.finalizedBlock, context.finalizedBlockHash);
      if (!asset.configuration.enabled) {
        throw monitorError(
          "chain",
          "FLAP_QUOTE_CANDIDATE_FINAL_CONFIGURATION_MISMATCH",
          `pending activation ${candidate.eventKey} is not enabled at finalized block ${context.finalizedBlock}`,
        );
      }
      const prepared = {
        log: candidate.log,
        proof,
        eventConfiguration: decoded.configuration,
        priorConfiguration: null,
        priorTransitionProof: candidate.priorTransitionProof === "unavailable" ? "unavailable" : "verified",
        priorStateRead: candidate.priorStateRead,
        asset,
      };
      const sourceRecord = state.eventRecords.find((item) => item.eventKey === candidate.eventKey
        && item.blockHash === candidate.log.blockHash);
      if (!sourceRecord) {
        throw monitorError("state", "FLAP_QUOTE_STATE_INVALID", `pending activation ${candidate.eventKey} lost its event record`);
      }
      await requirePreparedCanonical(prepared, context, "before pending activation delivery");
      // Catch-up and redundant RPC proof work may itself cross the 15-minute
      // trading boundary. Classify freshness at the actual delivery attempt,
      // not at the beginning of a potentially long scan cycle.
      const deliveryObservedAt = iso(nowMs(clock));
      deliveryCriticalSection = true;
      try {
        // Durable scanner handoff must precede the external notification.
        // Persist its own checkpoint without consuming the alert candidate:
        // a TG failure/restart retries notification, not a new generation.
        // An ambiguous registry acknowledgement is retried with the exact
        // same event identity (the consumer is durably idempotent).
        if (candidate.priorTransitionProof === "verified_zero_to_one"
          && sourceRecord.nextAsset?.lifecycleActivationEventKey !== candidate.eventKey) {
          await registerQuotePoolLifecycle(prepared, "activated");
          await requirePreparedCanonical(prepared, context, "after lifecycle handoff and before notification");
          const handedOff = structuredClone(state);
          const recordIndex = handedOff.eventRecords.findIndex((item) => item.eventKey === candidate.eventKey
            && item.blockHash === candidate.log.blockHash);
          handedOff.eventRecords[recordIndex].nextAsset.lifecycleActivationEventKey = candidate.eventKey;
          handedOff.eventRecords[recordIndex].configurationVerifiedAtBlock = context.finalizedBlock;
          handedOff.eventRecords[recordIndex].configurationVerifiedAtBlockHash = context.finalizedBlockHash;
          handedOff.quoteAssets[addressKey].lifecycleActivationEventKey = candidate.eventKey;
          await commit(handedOff);
        }
        const event = capabilityEvent(prepared, identity, {
          ...context,
          cursor: structuredClone(state.cursor),
          reorgOrphanedEventKeys: [...new Set([
            ...state.reorgOrphanedEventKeys,
            ...(sourceRecord.reorgReplacement ? [candidate.eventKey] : []),
          ])],
        }, deliveryObservedAt);
        let result;
        const delivery = Promise.resolve().then(() => alertSender(config, structuredClone(event)));
        activeDelivery = delivery;
        try {
          result = await delivery;
        } catch (error) {
          throw monitorError("delivery", "FLAP_QUOTE_ALERT_NOT_DURABLE", `Flap quote alert delivery threw: ${error.message}`, retryDetails(error));
        } finally {
          if (activeDelivery === delivery) activeDelivery = null;
        }
        if (!acceptedDelivery(result)) {
          throw monitorError("delivery", "FLAP_QUOTE_ALERT_NOT_DURABLE", `Flap quote alert was not durably accepted${result?.reason ? `: ${result.reason}` : ""}`);
        }
        try {
          await requirePreparedCanonical(prepared, context, "after durable pending delivery and before state commit");
        } catch (error) {
          if (error?.code === "FLAP_QUOTE_PRECOMMIT_REORG"
            && error?.details?.reorgScope === "event") {
            await retainDeliveredOrphan(prepared, deliveryObservedAt, error.message);
          }
          throw error;
        }
        const next = structuredClone(state);
        const retained = next.pendingEnableCandidates[addressKey];
        if (!retained || retained.eventKey !== candidate.eventKey || retained.log.blockHash !== candidate.log.blockHash) {
          throw monitorError("state", "FLAP_QUOTE_STATE_INVALID", `pending activation ${candidate.eventKey} changed during delivery`);
        }
        const recordIndex = next.eventRecords.findIndex((item) => item.eventKey === candidate.eventKey
          && item.blockHash === candidate.log.blockHash);
        if (recordIndex < 0) {
          throw monitorError("state", "FLAP_QUOTE_STATE_INVALID", `pending activation ${candidate.eventKey} lost its event record`);
        }
        delete next.pendingEnableCandidates[addressKey];
        next.eventRecords[recordIndex].delivered = true;
        next.eventRecords[recordIndex].configurationVerifiedAtBlock = context.finalizedBlock;
        next.eventRecords[recordIndex].configurationVerifiedAtBlockHash = context.finalizedBlockHash;
        const deliveredAsset = {
          ...asset,
          lifecycleActivationEventKey: state.quoteAssets[addressKey]?.lifecycleActivationEventKey
            || (candidate.priorTransitionProof === "verified_zero_to_one" ? candidate.eventKey : null),
        };
        next.eventRecords[recordIndex].nextAsset = deliveredAsset;
        for (const item of next.eventRecords) {
          if (item.quoteAddress !== addressKey) continue;
          if (item.previousCandidate?.eventKey === candidate.eventKey) item.previousCandidate = null;
          if (item.nextCandidate?.eventKey === candidate.eventKey) item.nextCandidate = null;
        }
        next.quoteAssets[addressKey] = deliveredAsset;
        next.reorgOrphanedEventKeys = next.reorgOrphanedEventKeys.filter((key) => key !== candidate.eventKey);
        next.identity = { ...next.identity, ...identity };
        markHealthy(next, deliveryObservedAt);
        await commit(next);
        delivered += 1;
      } finally {
        deliveryCriticalSection = false;
      }
    }
    return delivered;
  }

  async function restoreOrphanedDisables(orphanedRecords, finalizedBlock, finalizedBlockHash) {
    const candidates = orphanedRecords
      .filter((item) => ((item.nextAsset?.enabled === false
        && item.previousAsset?.enabled === true
        && stateEventKey(item.previousAsset?.lifecycleActivationEventKey))
        || (item.nextAsset?.lifecycleActivationEventKey === item.eventKey
          && isMaterialFlapQuoteConfigurationChange(item.configurationChange?.before, item.configurationChange?.after)))
        && Number.isSafeInteger(item.transactionIndex)
        && stateTimestamp(item.occurredAt)
        && Number.isSafeInteger(item.requiredConfirmations))
      .sort((left, right) => right.blockNumber - left.blockNumber
        || right.transactionIndex - left.transactionIndex
        || right.logIndex - left.logIndex);
    for (const item of candidates) {
      let canonicalBlock;
      try {
        canonicalBlock = await readFixedBlock(
          item.blockNumber,
          "FLAP_QUOTE_REORG_CHECK_FAILED",
          `orphaned disable block ${item.blockNumber}`,
        );
      } catch (error) {
        if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
        throw monitorError(
          "chain",
          "FLAP_QUOTE_REORG_CHECK_FAILED",
          `orphaned disable block ${item.blockNumber} lookup failed: ${error.message}`,
          retryDetails(error),
        );
      }
      if (!canonicalBlock || Number(canonicalBlock.number) !== item.blockNumber) {
        throw monitorError(
          "chain",
          "FLAP_QUOTE_REORG_CHECK_FAILED",
          `orphaned disable block ${item.blockNumber} is unavailable`,
        );
      }
      if (String(canonicalBlock.hash || "").toLowerCase() === item.blockHash) continue;
      const finalizedAsset = await readQuoteAsset(
        item.quoteAddress,
        finalizedBlock,
        finalizedBlockHash,
      );
      if (!finalizedAsset.configuration.enabled) continue;
      await registerQuotePoolLifecycleRecord(item.nextAsset.enabled === true
        ? revertedConfigurationLifecycleRecord(item) : restoredLifecycleRecord(item));
    }
  }

  async function recoverReorg(observedAt, identity, finalizedBlock) {
    const anchor = state.cursor.anchorBlock;
    let current;
    try { current = await readFixedBlock(anchor, "FLAP_QUOTE_REORG_CHECK_FAILED", `anchor block ${anchor}`); }
    catch (error) {
      if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
      throw monitorError("chain", "FLAP_QUOTE_REORG_CHECK_FAILED", `anchor block ${anchor} lookup failed: ${error.message}`, retryDetails(error));
    }
    const anchorMatches = Boolean(current
      && Number(current.number) === anchor
      && String(current.hash || "").toLowerCase() === String(state.cursor.anchorBlockHash).toLowerCase());
    let dependencyChanged = false;
    if (anchorMatches) {
      const futureSnapshots = new Map();
      for (const item of state.eventRecords) {
        if (item.configurationVerifiedAtBlock > anchor) {
          futureSnapshots.set(item.configurationVerifiedAtBlock, item.configurationVerifiedAtBlockHash);
        }
      }
      for (const [blockNumber, expectedHash] of futureSnapshots) {
        let block;
        try { block = await readFixedBlock(blockNumber, "FLAP_QUOTE_REORG_CHECK_FAILED", `finalized decision block ${blockNumber}`); }
        catch (error) {
          if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
          throw monitorError(
            "chain",
            "FLAP_QUOTE_REORG_CHECK_FAILED",
            `finalized decision block ${blockNumber} lookup failed: ${error.message}`,
            retryDetails(error),
          );
        }
        if (!block
          || Number(block.number) !== blockNumber
          || String(block.hash || "").toLowerCase() !== expectedHash) {
          dependencyChanged = true;
          break;
        }
      }
    }
    if (anchorMatches && !dependencyChanged) {
      return false;
    }
    const candidates = state.finalizedCheckpoints
      .filter((item) => item.blockNumber <= anchor && item.blockNumber <= finalizedBlock)
      .sort((left, right) => right.blockNumber - left.blockNumber);
    const canonicalCheckpointCache = new Map();
    const highestCanonicalCheckpoint = async (maximumBlock) => {
      for (const candidate of candidates) {
        if (candidate.blockNumber > maximumBlock) continue;
        let matches = canonicalCheckpointCache.get(candidate.blockNumber);
        if (matches === undefined) {
          let block = null;
          try {
            block = await readFixedBlock(
              candidate.blockNumber,
              "FLAP_QUOTE_REORG_CHECK_FAILED",
              `checkpoint block ${candidate.blockNumber}`,
            );
          }
          catch (error) {
            if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
            throw monitorError(
              "chain",
              "FLAP_QUOTE_REORG_CHECK_FAILED",
              `checkpoint block ${candidate.blockNumber} lookup failed: ${error.message}`,
              retryDetails(error),
            );
          }
          matches = Boolean(block
            && Number(block.number) === candidate.blockNumber
            && String(block.hash || "").toLowerCase() === String(candidate.blockHash).toLowerCase());
          canonicalCheckpointCache.set(candidate.blockNumber, matches);
        }
        if (matches) return candidate;
      }
      return null;
    };
    const canonicalAncestor = await highestCanonicalCheckpoint(finalizedBlock);
    if (!canonicalAncestor) {
      throw monitorError("chain", "FLAP_QUOTE_REORG_BEYOND_CHECKPOINTS", `no retained common ancestor exists below reorged block ${anchor}`);
    }
    let ancestor = canonicalAncestor;
    // A canonical event can have been classified using a later finalized
    // getQuoteTokenConfiguration snapshot.  If that decision snapshot is on
    // the orphaned side, replay from before the earliest affected event.  The
    // loop handles dependencies pulled in by an earlier rewind as well.
    while (true) {
      const affected = state.eventRecords.filter(
        (item) => item.configurationVerifiedAtBlock > ancestor.blockNumber,
      );
      if (affected.length === 0) break;
      const earliestAffectedBlock = Math.min(...affected.map((item) => item.blockNumber));
      if (earliestAffectedBlock > ancestor.blockNumber) break;
      const expandedAncestor = await highestCanonicalCheckpoint(earliestAffectedBlock - 1);
      if (!expandedAncestor) {
        throw monitorError(
          "chain",
          "FLAP_QUOTE_REORG_BEYOND_CHECKPOINTS",
          `no retained checkpoint exists before finalized-decision dependency at block ${earliestAffectedBlock}`,
        );
      }
      ancestor = expandedAncestor;
    }
    const replayed = state.eventRecords
      .filter((item) => item.blockNumber > ancestor.blockNumber)
      .sort((left, right) => right.blockNumber - left.blockNumber || right.logIndex - left.logIndex);
    const orphaned = replayed.filter((item) => item.blockNumber > canonicalAncestor.blockNumber);
    await restoreOrphanedDisables(orphaned, finalizedBlock, identity.verifiedBlockHash);
    const next = structuredClone(state);
    for (const item of replayed) {
      if (item.previousAsset) next.quoteAssets[item.quoteAddress] = item.previousAsset;
      else delete next.quoteAssets[item.quoteAddress];
      if (item.previousCandidate) next.pendingEnableCandidates[item.quoteAddress] = item.previousCandidate;
      else delete next.pendingEnableCandidates[item.quoteAddress];
    }
    const replayedKeys = new Set(replayed.map((item) => item.eventKey));
    const orphanedKeys = new Set(orphaned.map((item) => item.eventKey));
    const orphanedDeliveredKeys = orphaned.filter((item) => item.delivered).map((item) => item.eventKey);
    next.processedEventKeys = next.processedEventKeys.filter((key) => !replayedKeys.has(key));
    next.eventRecords = next.eventRecords.filter((item) => item.blockNumber <= ancestor.blockNumber);
    next.reorgOrphanedEventKeys = [...new Set([
      ...next.reorgOrphanedEventKeys,
      ...orphanedDeliveredKeys,
    ])].slice(-orphanedEventLimit);
    next.finalizedCheckpoints = next.finalizedCheckpoints.filter((item) => item.blockNumber <= ancestor.blockNumber);
    next.cursor.nextBlock = ancestor.blockNumber + 1;
    next.cursor.afterLogIndex = -1;
    next.cursor.anchorBlock = ancestor.blockNumber;
    next.cursor.anchorBlockHash = ancestor.blockHash;
    next.identity = { ...next.identity, ...identity };
    next.auditTrail = appendBounded(next.auditTrail, {
      type: "flap_quote_reorg_audit",
      action: "rewind",
      detectedAtBlock: anchor,
      rewoundToBlock: ancestor.blockNumber,
      orphanedEventKeys: [...orphanedKeys],
      observedAt,
    }, auditLimit);
    next._health = {
      ...next._health,
      reorgCount: Number(next._health.reorgCount || 0) + 1,
      lastReorgAt: observedAt,
    };
    await commit(next);
    return true;
  }

  async function runCycle() {
    const observedMs = nowMs(clock);
    const observedAt = iso(observedMs);
    try {
      await initialize();
      if (stopped) throw stoppedError();
      const persistedBackoff = state.initialized && !portalIdentityMigrationRequired;
      const activeNextAttemptAt = persistedBackoff
        ? state._health.nextAttemptAt
        : preBaselineNextAttemptAt;
      const activeLastErrorCode = persistedBackoff
        ? state._health.lastErrorCode
        : preBaselineLastErrorCode;
      const nextAttemptMs = Date.parse(String(activeNextAttemptAt || ""));
      if (Number.isFinite(nextAttemptMs) && nextAttemptMs > observedMs) {
        return {
          status: "backoff",
          initialized: state.initialized,
          nextAttemptAt: activeNextAttemptAt,
          errorCode: activeLastErrorCode,
          cursor: structuredClone(state.cursor),
        };
      }
      if (pendingCommitSnapshot) {
        await commit(pendingCommitSnapshot);
      }
      let primaryChainId;
      try {
        if (typeof provider.send === "function") {
          primaryChainId = rpcChainId(await provider.send("eth_chainId", []), "primary eth_chainId");
        } else {
          primaryChainId = rpcChainId((await provider.getNetwork())?.chainId, "primary provider.getNetwork()");
        }
      } catch (error) {
        if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
        throw monitorError("chain", "FLAP_QUOTE_CHAIN_ID_UNAVAILABLE", `primary BSC chain ID lookup failed: ${error.message}`, retryDetails(error));
      }
      if (primaryChainId !== FLAP_QUOTE_CHAIN_ID) {
        throw monitorError("chain", "FLAP_QUOTE_CHAIN_ID_MISMATCH", `primary RPC chain ID ${primaryChainId} is not BSC chain 56`);
      }
      let latestHead;
      try { latestHead = safeInteger(await provider.getBlockNumber(), "latest head"); }
      catch (error) {
        if (error?.code === "FLAP_QUOTE_STOPPED") throw error;
        throw monitorError("chain", "FLAP_QUOTE_HEAD_UNAVAILABLE", `BSC head lookup failed: ${error.message}`, retryDetails(error));
      }
      if (latestHead < requiredConfirmations) {
        throw monitorError("chain", "FLAP_QUOTE_FINALIZED_HEAD_INVALID", "BSC head is below the configured confirmation depth");
      }
      const finalizedBlock = latestHead - requiredConfirmations;
      const identity = await verifyIdentityQuorum(finalizedBlock);
      await requireFixedBlockHash(
        finalizedBlock,
        identity.verifiedBlockHash,
        "FLAP_QUOTE_FINALIZED_LANE_MISMATCH",
        `state and log RPC lanes disagree on finalized block ${finalizedBlock}`,
      );
      const context = {
        latestHead,
        finalizedBlock,
        finalizedBlockHash: identity.verifiedBlockHash,
        requiredConfirmations,
      };
      if (state.initialized && finalizedBlock < state.cursor.anchorBlock) {
        throw monitorError("chain", "FLAP_QUOTE_FINALIZED_HEAD_BEHIND_CURSOR", "finalized BSC head moved behind the durable Flap quote cursor");
      }
      if (portalIdentityMigrationRequired) {
        const migrated = structuredClone(state);
        migrated.identity = { ...migrated.identity, ...identity };
        markHealthy(migrated, observedAt);
        // Validate closure against the new pins before the first migration
        // write. This preserves the exact cursor/journals while refusing a
        // legacy snapshot whose anchor is inconsistent with the verified
        // finalized identity block.
        try {
          await commit(normalizeState(migrated, expectedRuntimeHash, portalPins));
        } catch (error) {
          // Unlike an ordinary cursor/event commit, an unconfirmed identity
          // migration may never be replayed before the next finalized quorum
          // check. The generic pending snapshot would otherwise persist the
          // new pin at the start of the next cycle even if the proxy changed
          // again or the verification block was reorged in between.
          pendingCommitSnapshot = null;
          // The failed migration write is intentionally discarded. Consume
          // that rejected queue tail as well, otherwise stop() would surface
          // the obsolete write error after a later identity recheck already
          // failed closed (or succeeded with a newly verified snapshot).
          writeQueue = writeQueue.catch(() => {});
          throw error;
        }
        portalIdentityMigrationRequired = false;
        preBaselineFailures = 0;
        preBaselineNextAttemptAt = null;
        preBaselineLastErrorCode = null;
      }
      if (!state.initialized) {
        await requireCanonicalHash(
          finalizedBlock,
          identity.verifiedBlockHash,
          "FLAP_QUOTE_BASELINE_REORG",
          `Flap quote baseline block ${finalizedBlock} changed before durable commit`,
        );
        const next = emptyState(expectedRuntimeHash, portalPins);
        next.initialized = true;
        next.initializedAt = observedAt;
        next.cursor = {
          nextBlock: finalizedBlock + 1,
          afterLogIndex: -1,
          anchorBlock: finalizedBlock,
          anchorBlockHash: identity.verifiedBlockHash,
          baselineEstablishedAt: observedAt,
        };
        next.identity = { ...next.identity, ...identity };
        putCheckpoint(next, finalizedBlock, identity.verifiedBlockHash, observedAt, checkpointLimit);
        markHealthy(next, observedAt);
        await commit(next);
        preBaselineFailures = 0;
        preBaselineNextAttemptAt = null;
        preBaselineLastErrorCode = null;
        return { status: "baseline", initialized: true, delivered: 0, cursor: structuredClone(next.cursor) };
      }
      const reorgRecovered = await recoverReorg(observedAt, identity, finalizedBlock);
      let nextBlock = state.cursor.nextBlock;
      let scannedBlocks = 0;
      let delivered = 0;
      let audited = 0;
      while (nextBlock <= finalizedBlock && scannedBlocks < maxBlocksPerCycle) {
        if (stopped) throw stoppedError();
        const toBlock = Math.min(
          finalizedBlock,
          // Public archival pages need durable intermediate checkpoints;
          // don't discard thousands of already-read blocks after one 429.
          nextBlock + Math.min(chunkSize,logReaders.some(r=>r.physicalHost==='bsc.blockrazor.xyz')?500:chunkSize) - 1,
          nextBlock + maxBlocksPerCycle - scannedBlocks - 1,
        );
        const result = await prepareRange(nextBlock, toBlock, context);
        for (const prepared of result.prepared) {
          if (stopped) throw stoppedError();
          const committed = await commitPrepared(prepared, identity, context, observedAt);
          delivered += committed.delivered;
          audited += committed.audited;
        }
        const committedEndHash = await requireCanonicalHash(
          toBlock,
          result.endBlockHash,
          "FLAP_QUOTE_SCAN_ANCHOR_CHANGED",
          `scan end block ${toBlock} changed before cursor commit`,
        );
        if (toBlock !== context.finalizedBlock) {
          await requireCanonicalHash(
            context.finalizedBlock,
            context.finalizedBlockHash,
            "FLAP_QUOTE_PRECOMMIT_REORG",
            `Flap quote finalized decision snapshot changed before range ${nextBlock}-${toBlock} cursor commit`,
          );
        }
        const next = structuredClone(state);
        next.cursor.nextBlock = toBlock + 1;
        next.cursor.afterLogIndex = -1;
        next.cursor.anchorBlock = toBlock;
        next.cursor.anchorBlockHash = committedEndHash;
        next.identity = { ...next.identity, ...identity };
        putCheckpoint(next, toBlock, committedEndHash, observedAt, checkpointLimit);
        markHealthy(next, observedAt);
        await commit(next);
        scannedBlocks += toBlock - nextBlock + 1;
        nextBlock = toBlock + 1;
      }
      if (scannedBlocks === 0) {
        const next = structuredClone(state);
        next.identity = { ...next.identity, ...identity };
        markHealthy(next, observedAt);
        await commit(next);
      }
      if (state.cursor.nextBlock > finalizedBlock) {
        delivered += await deliverPending(identity, context, observedAt);
      }
      return {
        status: "healthy",
        initialized: true,
        caughtUp: state.cursor.nextBlock > finalizedBlock,
        delivered,
        audited,
        reorgRecovered,
        finalizedBlock,
        cursor: structuredClone(state.cursor),
      };
    } catch (error) {
      if (error?.code === "FLAP_QUOTE_STOPPED") {
        return { status: "stopped", initialized: state.initialized, errorCode: error.code };
      }
      const stableErrorCode = /^FLAP_QUOTE_[A-Z0-9_]+$/.test(String(error?.code || ""))
        ? error.code
        : "FLAP_QUOTE_FAILURE";
      let returnedNextAttemptAt = portalIdentityMigrationRequired
        ? preBaselineNextAttemptAt
        : state._health.nextAttemptAt;
      if (initialized && error?.source !== "state") {
        const durableFailureState = state.initialized && !portalIdentityMigrationRequired;
        const consecutiveFailures = durableFailureState
          ? Number(state._health.consecutiveFailures || 0) + 1
          : preBaselineFailures + 1;
        const exponent = Math.min(10, Math.max(0, consecutiveFailures - 1));
        const randomValue = Math.max(0, Math.min(1, Number(random()) || 0));
        const jitteredBackoffMs = backoffBaseMs === 0
          ? 0
          : Math.min(backoffMaxMs, Math.round(backoffBaseMs * (2 ** exponent) * (0.8 + randomValue * 0.4)));
        const retryAfterMs = Math.min(backoffMaxMs, Math.max(0, Number(error?.retryAfterMs) || 0));
        const delayMs = Math.max(jitteredBackoffMs, retryAfterMs);
        // A backfill cycle may run for minutes. A server cooldown starts when
        // it rejects the request, not at the now-stale cycle start timestamp.
        returnedNextAttemptAt = delayMs > 0 ? iso(Math.max(observedMs, nowMs(clock)) + delayMs) : null;
        if (durableFailureState) {
          // If the failed operation was an ambiguous state commit, carry its
          // full intended cursor/journal forward into the degraded retry
          // snapshot. Never overwrite it with health fields based on the old
          // in-memory cursor.
          const next = structuredClone(pendingCommitSnapshot || state);
          next.checkedAt = observedAt;
          next._health = {
            ...next._health,
            status: "degraded",
            consecutiveFailures,
            lastErrorAt: observedAt,
            lastError: String(error?.message || error).slice(0, 500),
            lastErrorCode: stableErrorCode,
            lastAttemptAt: observedAt,
            nextAttemptAt: returnedNextAttemptAt,
            failureClass: ["chain", "delivery", "schema", "state"].includes(error?.source)
              ? error.source
              : "unknown",
          };
          try { await commit(next); }
          catch (persistError) { logger.error?.(`[flap-quote] state failure: ${persistError.message}`); }
        } else {
          preBaselineFailures = consecutiveFailures;
          preBaselineNextAttemptAt = returnedNextAttemptAt;
          preBaselineLastErrorCode = stableErrorCode;
        }
      }
      logger.error?.(`[flap-quote] ${error?.code || "FLAP_QUOTE_FAILURE"}: ${error?.message || error}`);
      return {
        status: "degraded",
        initialized: state.initialized,
        error: String(error?.message || error),
        errorCode: stableErrorCode,
        nextAttemptAt: returnedNextAttemptAt,
        cursor: structuredClone(state.cursor),
      };
    }
  }

  function check() {
    if (!enabled) return Promise.resolve({ status: "disabled", initialized: false });
    if (stopped) return activeCheck || Promise.resolve({ status: "stopped", initialized: state.initialized });
    if (activeCheck) return activeCheck;
    const controller = new AbortController();
    cycleController = controller;
    activeCheck = runCycle().finally(() => {
      if (cycleController === controller) cycleController = null;
      activeCheck = null;
    });
    return activeCheck;
  }

  function start() {
    if (!enabled) return Promise.resolve({ status: "disabled", initialized: false });
    if (stopped) return Promise.resolve({ status: "stopped", initialized: state.initialized });
    if (!started) {
      started = true;
      let lastScheduledAt=nowMs(clock);
      timer = setInterval(() => {
        const current=nowMs(clock);
        if(current-lastScheduledAt<flapQuoteScheduleInterval(state,pollIntervalMs,catchUpIntervalMs))return;
        lastScheduledAt=current;
        void check().catch((error) => logger.error?.(`[flap-quote] scheduler: ${error.message}`));
      }, pollIntervalMs);
      timer.unref?.();
    }
    return check();
  }

  if (autoStart && enabled) void start().catch((error) => logger.error?.(`[flap-quote] startup: ${error.message}`));

  return {
    check,
    start,
    state: () => structuredClone(state),
    stateFile,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      // Never abandon an outbox mutation: when delivery is active, the cycle
      // is allowed to finish its post-delivery canonical check and state
      // commit. Non-delivery RPC work remains abortable for prompt shutdown.
      if (!deliveryCriticalSection) cycleController?.abort();
      if (timer) clearInterval(timer);
      stopPromise = (async () => {
        if (activeDelivery) await activeDelivery.catch(() => {});
        if (activeCheck) await activeCheck;
        await writeQueue;
      })();
      return stopPromise;
    },
  };
}
