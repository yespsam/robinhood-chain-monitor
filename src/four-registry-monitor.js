import fs from "node:fs/promises";
import path from "node:path";
import { Interface, Signature, Transaction, keccak256, toUtf8Bytes } from "ethers";

export const FOUR_REGISTRY_CHAIN_ID = 56;
export const FOUR_REGISTRY_ADDRESS = "0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94";
export const FOUR_CORE_ADDRESS = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
// Canonical Multicall3 deployment for BNB Smart Chain (chain 56). The runtime
// hash is pinned as well as the address so batching cannot silently redirect
// exact-block Registry reads through an unrelated contract.
export const FOUR_REGISTRY_MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11";
export const FOUR_REGISTRY_MULTICALL3_CODE_HASH = "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891";
export const FOUR_REGISTRY_STATE_VERSION = 12;
export const FOUR_REGISTRY_TRACKED_TOKEN_VERSION = 1;
export const FOUR_REGISTRY_TRACKED_TOKEN_TARGET = 3;
export const FOUR_REGISTRY_EVENT_SCHEMA_VERSION = 1;
export const FOUR_REGISTRY_DEFAULT_CONFIRMATIONS = 3;
export const FOUR_REGISTRY_SOURCE_ID = "fourmeme_openfour_registry";
export const FOUR_CORE_SOURCE_ID = "fourmeme_openfour_core";
export const FOUR_REGISTRY_CAPABILITY_EVENT_TYPE = "platform_capability_update";
export const FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE = "bsc_launchpad_update";
export const FOUR_REGISTRY_FIRST_TOKEN_KIND = "four_registry_first_token";
export const FOUR_REGISTRY_PRESET_CAPABILITY_KINDS = Object.freeze([
  "four_registry_preset_added",
  "four_registry_preset_activated",
  "four_registry_preset_deactivated",
  "four_registry_preset_create_enabled",
  "four_registry_preset_create_disabled",
  "four_registry_preset_updated",
]);
export const FOUR_REGISTRY_PROTOCOL_CAPABILITY_KINDS = Object.freeze([
  "four_registry_module_upserted",
  "four_registry_token_impl_upserted",
  "four_registry_tag_registered",
]);
export const FOUR_REGISTRY_CAPABILITY_KINDS = Object.freeze([
  ...FOUR_REGISTRY_PRESET_CAPABILITY_KINDS,
  ...FOUR_REGISTRY_PROTOCOL_CAPABILITY_KINDS,
]);

const CAPABILITY_STAGE_BY_KIND = Object.freeze({
  four_registry_preset_added: "preset_added",
  four_registry_preset_activated: "preset_activated",
  four_registry_preset_deactivated: "preset_deactivated",
  four_registry_preset_create_enabled: "preset_create_enabled",
  four_registry_preset_create_disabled: "preset_create_disabled",
  four_registry_preset_updated: "preset_updated",
  four_registry_module_upserted: "module_upserted",
  four_registry_token_impl_upserted: "token_impl_upserted",
  four_registry_tag_registered: "tag_registered",
});
const CAPABILITY_CHANGE_BY_KIND = Object.freeze({
  four_registry_preset_added: "added",
  four_registry_preset_activated: "activated",
  four_registry_preset_deactivated: "deactivated",
  four_registry_preset_create_enabled: "create_enabled",
  four_registry_preset_create_disabled: "create_disabled",
  four_registry_preset_updated: "updated",
  four_registry_module_upserted: "module_upserted",
  four_registry_token_impl_upserted: "token_impl_upserted",
  four_registry_tag_registered: "tag_registered",
});

const PROTOCOL_CAPABILITY_BY_EVENT = Object.freeze({
  ModuleUpserted: Object.freeze({
    kind: "four_registry_module_upserted",
    changeType: "module_upserted",
    stage: "module_upserted",
    subjectType: "module",
    product: "openfour-module",
    changesKey: "registryModules",
  }),
  TokenImplUpserted: Object.freeze({
    kind: "four_registry_token_impl_upserted",
    changeType: "token_impl_upserted",
    stage: "token_impl_upserted",
    subjectType: "token-impl",
    product: "openfour-token-implementation",
    changesKey: "registryTokenImplementations",
  }),
  TagRegistered: Object.freeze({
    kind: "four_registry_tag_registered",
    changeType: "tag_registered",
    stage: "tag_registered",
    subjectType: "tag",
    product: "openfour-tag",
    changesKey: "registryTags",
  }),
});

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MODULE_KIND_NAMES = Object.freeze(["token", "vault", "curve", "trade", "migrate", "custom_data"]);
const INVENTORY_READ_CONCURRENCY = 4;
const MULTICALL3_MAX_SUBCALLS = 192;
const RUNTIME_IDENTITY_RECHECK_BLOCKS = 256;
export const FOUR_REGISTRY_RPC_CALLS_PER_HOST_PER_MINUTE = 108;
const RPC_BUDGET_WINDOW_MS = 60_000;
const MIN_RPC_SCHEDULER_INTERVAL_MS = 5_000;
const MAX_PROCESSED_KEYS = 10_000;
const MAX_OUTBOX_EVENTS = 512;
const MAX_LOGS_PER_QUERY = 4_096;
const MAX_REORG_RECOVERIES = 32;
const MAX_CHECKPOINTS = 64;
// One finalized rollback can invalidate the complete accepted-event window
// plus every locally pending event. Keep enough durable owner proofs to make
// that entire reachable state recoverable without a 513th-event deadlock.
const MAX_ORPHANED_DELIVERED_EVENTS = MAX_PROCESSED_KEYS + MAX_OUTBOX_EVENTS;
const FOUR_REGISTRY_DEFAULT_DELAYED_RECOVERY_MS = 15 * 60 * 1_000;
const PRESET_DIRECT_SNAPSHOT_SCOPE = "canonical_event_status_plus_block_end_metadata";
const PRESET_DEFERRED_SNAPSHOT_SCOPE = "canonical_event_status_only_metadata_deferred_within_block";
const PRESET_SETTLED_SNAPSHOT_SCOPE = "canonical_event_status_plus_same_block_final_metadata_settlement";
const PRESET_UNATTRIBUTED_SNAPSHOT_SCOPE = "canonical_event_status_plus_unattributed_same_block_metadata_snapshot";
export const FOUR_REGISTRY_PRESET_BLOCK_END_METADATA_FIELD = "blockEndMetadataSettlement";
export const FOUR_REGISTRY_PRESET_SNAPSHOT_SCOPES = Object.freeze([
  PRESET_DIRECT_SNAPSHOT_SCOPE,
  PRESET_DEFERRED_SNAPSHOT_SCOPE,
  PRESET_SETTLED_SNAPSHOT_SCOPE,
  PRESET_UNATTRIBUTED_SNAPSHOT_SCOPE,
]);
const FOUR_REGISTRY_SOURCE_URL = `https://bscscan.com/address/${FOUR_REGISTRY_ADDRESS}`;
const FOUR_CORE_SOURCE_URL = `https://bscscan.com/address/${FOUR_CORE_ADDRESS}`;
export const FOUR_REGISTRY_REQUIRED_PROVIDER_METHODS = Object.freeze([
  "getNetwork",
  "getBlockNumber",
  "getTransaction",
  "getTransactionReceipt",
  "getBlock",
  "getCode",
  "call",
]);

export const FOUR_REGISTRY_INTERFACE = new Interface([
  "function openFourCore() view returns (address)",
  "function getPresetIds() view returns (uint256[])",
  "function getPreset(uint256 presetId) view returns ((uint256 id,string name,string description,string version,bool active,bool createEnabled,address validator,bytes32 tokenModuleId,bytes32 vaultModuleId,bytes32 curveModuleId,bytes32 tradeModuleId,bytes32 migrateModuleId,bytes32 tokenImplId,bytes32 customDataId,address author))",
  "function isPresetActive(uint256 presetId) view returns (bool)",
  "function isPresetCreateEnabled(uint256 presetId) view returns (bool)",
  "event PresetUpserted(uint256 indexed presetId,bool active,bool createEnabled)",
  "event PresetActiveUpdated(uint256 indexed presetId,bool active)",
  "event PresetCreateEnabledUpdated(uint256 indexed presetId,bool createEnabled)",
  "event ModuleUpserted(bytes32 indexed moduleKey,address beacon,address implementation,uint8 kind,bool active)",
  "event TokenImplUpserted(bytes32 indexed tokenImplId,address implementation,string version)",
  "event TagRegistered(bytes8 indexed tagId,string tag)",
]);

export const FOUR_CORE_INTERFACE = new Interface([
  "function registry() view returns (address)",
  "event TokenCreated(uint256 requestId,uint256 indexed presetId,address indexed creator,address indexed token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,uint256 initialPrice,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address customData,address tokenModule,string tokenMetaUri,uint256 flags,bytes encodedTags)",
]);

export const FOUR_REGISTRY_MULTICALL3_INTERFACE = new Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
]);

export const FOUR_REGISTRY_EVENT_TOPICS = Object.freeze([
  FOUR_REGISTRY_INTERFACE.getEvent("PresetUpserted").topicHash.toLowerCase(),
  FOUR_REGISTRY_INTERFACE.getEvent("PresetActiveUpdated").topicHash.toLowerCase(),
  FOUR_REGISTRY_INTERFACE.getEvent("PresetCreateEnabledUpdated").topicHash.toLowerCase(),
  FOUR_REGISTRY_INTERFACE.getEvent("ModuleUpserted").topicHash.toLowerCase(),
  FOUR_REGISTRY_INTERFACE.getEvent("TokenImplUpserted").topicHash.toLowerCase(),
  FOUR_REGISTRY_INTERFACE.getEvent("TagRegistered").topicHash.toLowerCase(),
]);
export const FOUR_TOKEN_CREATED_TOPIC = FOUR_CORE_INTERFACE.getEvent("TokenCreated").topicHash.toLowerCase();

function fourError(code, message, cause = undefined) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function iso(value) {
  return new Date(value).toISOString();
}

function exactIso(value, label) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed) || iso(parsed) !== value) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", `${label} is not an exact ISO timestamp`);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function integer(value, label, minimum = 0) {
  let parsed;
  if (typeof value === "bigint") parsed = Number(value);
  else if (typeof value === "string" && /^0x[0-9a-f]+$/iu.test(value)) parsed = Number.parseInt(value.slice(2), 16);
  else parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw fourError("FOUR_REGISTRY_NUMBER_INVALID", `${label} is not a safe integer`);
  }
  return parsed;
}

function uintString(value, label) {
  let parsed;
  try { parsed = BigInt(value); }
  catch { throw fourError("FOUR_REGISTRY_UINT_INVALID", `${label} is not uint256`); }
  if (parsed < 0n || parsed >= 2n ** 256n) {
    throw fourError("FOUR_REGISTRY_UINT_INVALID", `${label} is not uint256`);
  }
  return parsed.toString();
}

function address(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/u.test(normalized)) {
    throw fourError("FOUR_REGISTRY_ADDRESS_INVALID", `${label} is not an address`);
  }
  return normalized;
}

function hash32(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[a-f0-9]{64}$/u.test(normalized)) {
    throw fourError("FOUR_REGISTRY_HASH_INVALID", `${label} is not bytes32`);
  }
  return normalized;
}

function bytes8(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x[a-f0-9]{16}$/u.test(normalized)) {
    throw fourError("FOUR_REGISTRY_BYTES8_INVALID", `${label} is not bytes8`);
  }
  return normalized;
}

function moduleKind(value, label) {
  const normalized = integer(value, label);
  if (normalized > 255) {
    throw fourError("FOUR_REGISTRY_MODULE_KIND_INVALID", `${label} is outside uint8`);
  }
  return normalized;
}

function boundedText(value, label, maximum) {
  const text = String(value ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (text.length > maximum) {
    throw fourError("FOUR_REGISTRY_TEXT_INVALID", `${label} exceeds ${maximum} characters`);
  }
  return text;
}

function displayChainText(value, maximum) {
  const normalized = String(value ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return { value: normalized.slice(0, maximum), truncated: normalized.length > maximum };
}

function onchainTextProof(value, label, maximum, persistedProof = undefined) {
  const display = displayChainText(value, maximum);
  if (persistedProof !== undefined) {
    if (!hasExactKeys(persistedProof, ["hash", "truncated"])
      || hash32(persistedProof.hash, `${label}.hash`) !== persistedProof.hash
      || typeof persistedProof.truncated !== "boolean"
      || display.truncated) {
      throw fourError("FOUR_REGISTRY_TEXT_INVALID", `${label} persisted display/proof is invalid`);
    }
    const localHash = keccak256(toUtf8Bytes(display.value)).toLowerCase();
    if (!persistedProof.truncated && persistedProof.hash !== localHash) {
      throw fourError("FOUR_REGISTRY_TEXT_INVALID", `${label} exact text hash does not match`);
    }
    return { value: display.value, proof: { hash: persistedProof.hash, truncated: persistedProof.truncated } };
  }
  const normalizedFull = String(value ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    value: display.value,
    proof: {
      hash: keccak256(toUtf8Bytes(normalizedFull)).toLowerCase(),
      truncated: display.truncated,
    },
  };
}

function boolean(value, label) {
  if (typeof value !== "boolean") {
    throw fourError("FOUR_REGISTRY_BOOLEAN_INVALID", `${label} is not boolean`);
  }
  return value;
}

function presetFingerprint(preset) {
  const stable = {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    version: preset.version,
    textProof: preset.textProof,
    active: preset.active,
    createEnabled: preset.createEnabled,
    validator: preset.validator,
    tokenModuleId: preset.tokenModuleId,
    vaultModuleId: preset.vaultModuleId,
    curveModuleId: preset.curveModuleId,
    tradeModuleId: preset.tradeModuleId,
    migrateModuleId: preset.migrateModuleId,
    tokenImplId: preset.tokenImplId,
    customDataId: preset.customDataId,
    author: preset.author,
  };
  return keccak256(toUtf8Bytes(JSON.stringify(stable))).toLowerCase();
}

function normalizePreset(raw, expectedId = undefined) {
  if (!raw || typeof raw !== "object") {
    throw fourError("FOUR_REGISTRY_PRESET_INVALID", "getPreset returned no tuple");
  }
  const id = uintString(raw.id ?? raw[0], "preset.id");
  if (expectedId !== undefined && id !== String(expectedId)) {
    throw fourError("FOUR_REGISTRY_PRESET_ID_MISMATCH", `getPreset(${expectedId}) returned preset ${id}`);
  }
  const name = onchainTextProof(raw.name ?? raw[1], "preset.name", 160, raw.textProof?.name);
  const description = onchainTextProof(raw.description ?? raw[2], "preset.description", 2_000, raw.textProof?.description);
  const version = onchainTextProof(raw.version ?? raw[3], "preset.version", 80, raw.textProof?.version);
  const preset = {
    id,
    name: name.value,
    description: description.value,
    version: version.value,
    textProof: {
      name: name.proof,
      description: description.proof,
      version: version.proof,
    },
    active: boolean(raw.active ?? raw[4], "preset.active"),
    createEnabled: boolean(raw.createEnabled ?? raw[5], "preset.createEnabled"),
    validator: address(raw.validator ?? raw[6], "preset.validator"),
    tokenModuleId: hash32(raw.tokenModuleId ?? raw[7], "preset.tokenModuleId"),
    vaultModuleId: hash32(raw.vaultModuleId ?? raw[8], "preset.vaultModuleId"),
    curveModuleId: hash32(raw.curveModuleId ?? raw[9], "preset.curveModuleId"),
    tradeModuleId: hash32(raw.tradeModuleId ?? raw[10], "preset.tradeModuleId"),
    migrateModuleId: hash32(raw.migrateModuleId ?? raw[11], "preset.migrateModuleId"),
    tokenImplId: hash32(raw.tokenImplId ?? raw[12], "preset.tokenImplId"),
    customDataId: hash32(raw.customDataId ?? raw[13], "preset.customDataId"),
    author: address(raw.author ?? raw[14], "preset.author"),
  };
  preset.canCreate = preset.active && preset.createEnabled;
  preset.validatorConfigured = preset.validator !== ZERO_ADDRESS;
  preset.fingerprint = presetFingerprint(preset);
  return preset;
}

function emptyState() {
  return {
    version: FOUR_REGISTRY_STATE_VERSION,
    initialized: false,
    chainId: FOUR_REGISTRY_CHAIN_ID,
    registry: FOUR_REGISTRY_ADDRESS,
    core: FOUR_CORE_ADDRESS,
    cursor: null,
    presets: {},
    presetAuditCursor: 0,
    presetAuditProofs: {},
    pendingConfirmations: {},
    mechanismTracking: emptyMechanismTracking(),
    outbox: [],
    processedEvents: {},
    processedEventKeys: [],
    orphanedDeliveredEvents: {},
    canonicalRecoveryEpoch: 0,
    checkpoints: [],
    reorgRecoveries: [],
    tokenBackfillSuppressedThroughBlock: null,
    baselineBlock: null,
    baselineAt: null,
    updatedAt: null,
  };
}

function normalizeCursor(raw) {
  if (!raw || typeof raw !== "object") throw fourError("FOUR_REGISTRY_STATE_INVALID", "state cursor is missing");
  const nextBlock = integer(raw.nextBlock, "cursor.nextBlock");
  const anchorBlock = integer(raw.anchorBlock, "cursor.anchorBlock");
  if (nextBlock !== anchorBlock + 1) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "state cursor is not contiguous");
  }
  return { nextBlock, anchorBlock, anchorBlockHash: hash32(raw.anchorBlockHash, "cursor.anchorBlockHash") };
}

function normalizePosition(raw, label) {
  if (!raw || typeof raw !== "object") throw fourError("FOUR_REGISTRY_STATE_INVALID", `${label} is missing`);
  return {
    blockNumber: integer(raw.blockNumber, `${label}.blockNumber`),
    transactionIndex: integer(raw.transactionIndex, `${label}.transactionIndex`),
    logIndex: integer(raw.logIndex, `${label}.logIndex`),
    blockHash: hash32(raw.blockHash, `${label}.blockHash`),
  };
}

function canonicalPositionKey(transactionHash, eventLogIndex) {
  return `four-registry-position:${FOUR_REGISTRY_CHAIN_ID}:${hash32(transactionHash, "position transactionHash")}:${integer(eventLogIndex, "position logIndex")}`;
}

function canonicalOwnerHistoryKey(transactionHash, eventLogIndex, ownerBlockHash) {
  return `${canonicalPositionKey(transactionHash, eventLogIndex)}:${hash32(ownerBlockHash, "owner blockHash")}`;
}

function baseEventKeyFor(eventType, kind, transactionHash, eventLogIndex) {
  const suffix = eventType === FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE
    ? "token-confirmation"
    : CAPABILITY_CHANGE_BY_KIND[kind];
  if (!suffix) throw fourError("FOUR_REGISTRY_STATE_INVALID", `event kind ${kind} has no deterministic key suffix`);
  return `four-registry:${FOUR_REGISTRY_CHAIN_ID}:${hash32(transactionHash, "event transactionHash")}:${integer(eventLogIndex, "event logIndex")}:${suffix}`;
}

function parseCapabilityOwnerKey(value) {
  return /^four-registry:56:(0x[a-f0-9]{64}):(0|[1-9]\d*):(added|activated|create_enabled|updated|module_upserted|token_impl_upserted)(?::canonical-revision:(0x[a-f0-9]{64}):([1-9]\d*))?$/u
    .exec(String(value || ""));
}

const CANONICAL_REVISION_KEYS = Object.freeze([
  "version", "reason", "baseEventKey", "currentBasePayloadDigest", "replacesEventKey", "replacesBaseEventKey",
  "replacesBlockHash", "replacesPayloadDigest", "transactionHash", "logIndex", "newBlockHash",
  "replacesDeliveryStatus", "replacesDuplicateOf", "replacesCanonicalOwnerDelivered", "cancellationStatus",
  "recoveryEpoch",
  "recoveryDetectedAt", "recoveryOldAnchorBlock", "recoveryOldAnchorBlockHash",
  "recoveryObservedAnchorBlockHash", "recoveryResumeBlock", "recoveryResumeBlockHash",
]);
const CANONICAL_RESTORATION_KEYS = Object.freeze([
  "version", "reason", "cancelledEventId", "blockHash", "payloadDigest", "detectedAt",
]);
const CANONICAL_SUPERSESSION_KEYS = Object.freeze([
  "version", "reason", "baseEventKey", "currentBasePayloadDigest", "cancelledEventId", "cancelledBaseEventKey",
  "cancelledBlockHash", "cancelledPayloadDigest", "transactionHash", "logIndex", "newBlockHash", "detectedAt",
]);

function parseFourRegistryEventKey(value) {
  return /^four-registry:56:(0x[a-f0-9]{64}):(0|[1-9]\d*):(added|activated|deactivated|create_enabled|create_disabled|updated|module_upserted|token_impl_upserted|tag_registered|token-confirmation)(?::canonical-revision:(0x[a-f0-9]{64}):([1-9]\d*))?$/u
    .exec(String(value || ""));
}

function normalizeCanonicalRevision(raw, context) {
  if (!hasExactKeys(raw, CANONICAL_REVISION_KEYS)) {
    throw fourError("FOUR_REGISTRY_CANONICAL_REVISION_INVALID", "canonical revision shape is invalid");
  }
  const baseEventKey = boundedText(raw.baseEventKey, "canonicalRevision.baseEventKey", 300);
  const replacesEventKey = boundedText(raw.replacesEventKey, "canonicalRevision.replacesEventKey", 400);
  const replacesBaseEventKey = boundedText(raw.replacesBaseEventKey, "canonicalRevision.replacesBaseEventKey", 300);
  const replacesBlockHash = hash32(raw.replacesBlockHash, "canonicalRevision.replacesBlockHash");
  const newBlockHash = hash32(raw.newBlockHash, "canonicalRevision.newBlockHash");
  const transactionHash = hash32(raw.transactionHash, "canonicalRevision.transactionHash");
  const revisionLogIndex = integer(raw.logIndex, "canonicalRevision.logIndex");
  const recoveryEpoch = integer(raw.recoveryEpoch, "canonicalRevision.recoveryEpoch", 1);
  const recoveryDetectedAt = exactIso(raw.recoveryDetectedAt, "canonicalRevision.recoveryDetectedAt");
  const recoveryOldAnchorBlock = integer(raw.recoveryOldAnchorBlock, "canonicalRevision.recoveryOldAnchorBlock");
  const recoveryResumeBlock = integer(raw.recoveryResumeBlock, "canonicalRevision.recoveryResumeBlock");
  const currentKeyParts = parseFourRegistryEventKey(baseEventKey);
  const replacedBaseParts = parseFourRegistryEventKey(replacesBaseEventKey);
  const replacedKeyParts = parseFourRegistryEventKey(replacesEventKey);
  const replacesDuplicateOf = raw.replacesDuplicateOf === null
    ? null
    : boundedText(raw.replacesDuplicateOf, "canonicalRevision.replacesDuplicateOf", 512);
  if (raw.version !== 1
    || raw.reason !== "canonical_reinclusion_after_finalized_reorg"
    || baseEventKey !== context.baseEventKey
    || !currentKeyParts || currentKeyParts[4]
    || !replacedBaseParts || replacedBaseParts[4]
    || !replacedKeyParts
    || replacedKeyParts[1] !== transactionHash
    || Number(replacedKeyParts[2]) !== revisionLogIndex
    || replacedBaseParts[1] !== transactionHash
    || Number(replacedBaseParts[2]) !== revisionLogIndex
    || replacedKeyParts[3] !== replacedBaseParts[3]
    || (replacedKeyParts[4]
      ? replacedKeyParts[4] !== replacesBlockHash || Number(replacedKeyParts[5]) < 1
      : replacesEventKey !== replacesBaseEventKey)
    || currentKeyParts[1] !== transactionHash
    || Number(currentKeyParts[2]) !== revisionLogIndex
    || transactionHash !== context.transactionHash
    || revisionLogIndex !== context.logIndex
    || replacesBlockHash === newBlockHash
    || newBlockHash !== context.blockHash
    || hash32(raw.currentBasePayloadDigest, "canonicalRevision.currentBasePayloadDigest") !== raw.currentBasePayloadDigest
    || hash32(raw.replacesPayloadDigest, "canonicalRevision.replacesPayloadDigest") !== raw.replacesPayloadDigest
    || !["delivered", "queued", "semantic_duplicate"].includes(raw.replacesDeliveryStatus)
    || typeof raw.replacesCanonicalOwnerDelivered !== "boolean"
    || (raw.replacesDeliveryStatus === "semantic_duplicate"
      ? replacesDuplicateOf === null || raw.replacesCanonicalOwnerDelivered !== true
      : replacesDuplicateOf !== null || raw.replacesCanonicalOwnerDelivered !== false)
    || !["superseded", "delivered_orphaned"].includes(raw.cancellationStatus)
    || hash32(raw.recoveryOldAnchorBlockHash, "canonicalRevision.recoveryOldAnchorBlockHash") !== raw.recoveryOldAnchorBlockHash
    || hash32(raw.recoveryObservedAnchorBlockHash, "canonicalRevision.recoveryObservedAnchorBlockHash") !== raw.recoveryObservedAnchorBlockHash
    || raw.recoveryOldAnchorBlockHash === raw.recoveryObservedAnchorBlockHash
    || hash32(raw.recoveryResumeBlockHash, "canonicalRevision.recoveryResumeBlockHash") !== raw.recoveryResumeBlockHash
    || recoveryResumeBlock >= context.blockNumber
    || recoveryOldAnchorBlock <= recoveryResumeBlock
    || Date.parse(recoveryDetectedAt) > Date.parse(context.observedOrAcceptedAt)) {
    throw fourError("FOUR_REGISTRY_CANONICAL_REVISION_INVALID", "canonical revision proof is inconsistent");
  }
  return {
    version: 1,
    reason: raw.reason,
    baseEventKey,
    currentBasePayloadDigest: raw.currentBasePayloadDigest,
    replacesEventKey,
    replacesBaseEventKey,
    replacesBlockHash,
    replacesPayloadDigest: raw.replacesPayloadDigest,
    transactionHash,
    logIndex: revisionLogIndex,
    newBlockHash,
    replacesDeliveryStatus: raw.replacesDeliveryStatus,
    replacesDuplicateOf,
    replacesCanonicalOwnerDelivered: raw.replacesCanonicalOwnerDelivered,
    cancellationStatus: raw.cancellationStatus,
    recoveryEpoch,
    recoveryDetectedAt,
    recoveryOldAnchorBlock,
    recoveryOldAnchorBlockHash: raw.recoveryOldAnchorBlockHash,
    recoveryObservedAnchorBlockHash: raw.recoveryObservedAnchorBlockHash,
    recoveryResumeBlock,
    recoveryResumeBlockHash: raw.recoveryResumeBlockHash,
  };
}

function normalizeProcessedRecord(raw, expectedKey) {
  const keys = [
    "eventKey", "baseEventKey", "canonicalRevision", "event", "eventType", "kind", "subjectType", "subjectKey", "presetId", "lifecycleKey",
    "capabilityEventKey", "transactionHash", "transactionIndex", "logIndex", "blockNumber", "blockHash",
    "evidenceBasis", "eventName", "canonicalLog", "canonicalTokenCreatedKey", "payloadDigest", "deliveryStatus",
    "duplicateOf", "canonicalOwnerDelivered", "acceptedAt",
  ];
  if (!hasExactKeys(raw, keys)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", `processed event ${expectedKey} is invalid`);
  }
  const eventKey = boundedText(raw.eventKey, "processed.eventKey", 400);
  const baseEventKey = boundedText(raw.baseEventKey, "processed.baseEventKey", 300);
  const lifecycleKey = boundedText(raw.lifecycleKey, "processed.lifecycleKey", 400);
  const subjectType = boundedText(raw.subjectType, "processed.subjectType", 32);
  const subjectKey = normalizeCapabilitySubjectKey(subjectType, raw.subjectKey, "processed.subjectKey");
  const lifecycleSubject = capabilityLifecycleSubject(lifecycleKey);
  const transactionHash = hash32(raw.transactionHash, "processed.transactionHash");
  const transactionIndex = integer(raw.transactionIndex, "processed.transactionIndex");
  const processedLogIndex = integer(raw.logIndex, "processed.logIndex");
  const blockNumber = integer(raw.blockNumber, "processed.blockNumber");
  const blockHash = hash32(raw.blockHash, "processed.blockHash");
  const canonicalLog = canonicalLogMaterial(raw.canonicalLog);
  if (!exactData(canonicalLog, raw.canonicalLog)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", `processed event ${expectedKey} canonical log is invalid`);
  }
  const payloadDigest = hash32(raw.payloadDigest, "processed.payloadDigest");
  const persistedEventIsValid = raw.event?.type === FOUR_REGISTRY_CAPABILITY_EVENT_TYPE
    ? isFourRegistryCapabilityEvent(raw.event)
    : isFourRegistryFirstTokenEvent(raw.event);
  if (eventKey !== expectedKey
    || !lifecycleSubject
    || lifecycleSubject.type !== subjectType
    || lifecycleSubject.key !== subjectKey) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", `processed event ${expectedKey} identity is inconsistent`);
  }
  const expectedSubjectType = capabilitySubjectType(raw.kind, raw.eventType);
  const expectedBaseEventKey = baseEventKeyFor(raw.eventType, raw.kind, transactionHash, processedLogIndex);
  const canonicalRevision = raw.canonicalRevision === null
    ? null
    : normalizeCanonicalRevision(raw.canonicalRevision, {
      baseEventKey: expectedBaseEventKey,
      blockNumber,
      blockHash,
      transactionHash,
      logIndex: processedLogIndex,
      observedOrAcceptedAt: raw.acceptedAt,
    });
  const expectedEventKey = canonicalRevision === null
    ? expectedBaseEventKey
    : `${expectedBaseEventKey}:canonical-revision:${canonicalRevision.newBlockHash}:${canonicalRevision.recoveryEpoch}`;
  const expectedBasis = raw.eventType === FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE
    ? "canonical_token_created_after_capability"
    : subjectType === "preset"
      ? "canonical_registry_event_and_finalized_block_snapshot"
      : "canonical_registry_event";
  const expectedNames = subjectType === "preset"
    ? raw.eventType === FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE
      ? ["TokenCreated"]
      : ["PresetUpserted", "PresetActiveUpdated", "PresetCreateEnabledUpdated"]
    : subjectType === "module" ? ["ModuleUpserted"] : subjectType === "token-impl" ? ["TokenImplUpserted"] : ["TagRegistered"];
  const presetLifecycle = subjectType === "preset" ? expectedPresetLifecycleParts(lifecycleKey) : null;
  const capabilityKey = raw.capabilityEventKey === null
    ? null
    : boundedText(raw.capabilityEventKey, "processed.capabilityEventKey", 400);
  const firstCapability = capabilityKey === null ? null : parseCapabilityOwnerKey(capabilityKey);
  let decodedProof;
  try {
    decodedProof = raw.eventType === FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE
      ? parseTokenCreatedLog(canonicalLog, {})
      : parseRegistryLog(canonicalLog, {});
  } catch (error) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", `processed event ${expectedKey} canonical log cannot be decoded`, error);
  }
  const canonicalTokenCreatedKey = raw.canonicalTokenCreatedKey === null
    ? null
    : boundedText(raw.canonicalTokenCreatedKey, "processed.canonicalTokenCreatedKey", 400);
  const duplicateOf = raw.duplicateOf === null
    ? null
    : boundedText(raw.duplicateOf, "processed.duplicateOf", 512);
  if (![FOUR_REGISTRY_CAPABILITY_EVENT_TYPE, FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE].includes(raw.eventType)
    || (raw.eventType === FOUR_REGISTRY_CAPABILITY_EVENT_TYPE && !FOUR_REGISTRY_CAPABILITY_KINDS.includes(raw.kind))
    || (raw.eventType === FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE && raw.kind !== FOUR_REGISTRY_FIRST_TOKEN_KIND)
    || expectedSubjectType !== subjectType
    || !persistedEventIsValid
    || raw.event.eventKey !== eventKey
    || raw.event.type !== raw.eventType
    || raw.event.kind !== raw.kind
    || raw.event.lifecycleKey !== lifecycleKey
    || raw.event.transactionHash !== transactionHash
    || raw.event.transactionIndex !== transactionIndex
    || raw.event.logIndex !== processedLogIndex
    || raw.event.blockNumber !== blockNumber
    || raw.event.blockHash !== blockHash
    || raw.event.payloadDigest !== payloadDigest
    || !exactData(raw.event.evidence?.canonicalLog, canonicalLog)
    || baseEventKey !== expectedBaseEventKey
    || eventKey !== expectedEventKey
    || raw.evidenceBasis !== expectedBasis
    || !expectedNames.includes(raw.eventName)
    || decodedProof.eventName !== undefined && decodedProof.eventName !== raw.eventName
    || (subjectType === "preset" && (decodedProof.presetId ?? null) !== subjectKey)
    || (subjectType !== "preset" && decodedProof.subjectKey !== subjectKey)
    || (raw.eventType === FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE
      && canonicalTokenCreatedKey !== `fourmeme:openfour-core-token-created:${FOUR_REGISTRY_CHAIN_ID}:${transactionHash}:${processedLogIndex}:${decodedProof.token}`)
    || (raw.eventType === FOUR_REGISTRY_CAPABILITY_EVENT_TYPE && canonicalTokenCreatedKey !== null)
    || (subjectType === "preset" && presetLifecycle?.[1] !== subjectKey)
    || (raw.eventType === FOUR_REGISTRY_CAPABILITY_EVENT_TYPE
      && subjectType === "preset"
      && (presetLifecycle?.[2] !== transactionHash || Number(presetLifecycle?.[3]) !== processedLogIndex))
    || (raw.eventType === FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE
      && (!firstCapability
        || firstCapability[1] !== presetLifecycle?.[2]
        || firstCapability[2] !== presetLifecycle?.[3]))
    || (raw.eventType === FOUR_REGISTRY_CAPABILITY_EVENT_TYPE && capabilityKey !== null)
    || (subjectType !== "preset"
      && lifecycleKey !== `fourmeme:openfour:${subjectType}:${subjectKey}:generation:${transactionHash}:${processedLogIndex}`)
    || raw.presetId !== (subjectType === "preset" ? subjectKey : null)
    || !["delivered", "queued", "semantic_duplicate"].includes(raw.deliveryStatus)
    || typeof raw.canonicalOwnerDelivered !== "boolean"
    || (raw.deliveryStatus === "semantic_duplicate"
      ? duplicateOf === null || raw.canonicalOwnerDelivered !== true
      : duplicateOf !== null || raw.canonicalOwnerDelivered !== false)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", `processed event ${expectedKey} schema is inconsistent`);
  }
  return {
    eventKey,
    baseEventKey,
    canonicalRevision,
    event: clone(raw.event),
    eventType: raw.eventType,
    kind: raw.kind,
    subjectType,
    subjectKey,
    presetId: subjectType === "preset" ? subjectKey : null,
    lifecycleKey,
    capabilityEventKey: capabilityKey,
    transactionHash,
    transactionIndex,
    logIndex: processedLogIndex,
    blockNumber,
    blockHash,
    evidenceBasis: raw.evidenceBasis,
    eventName: raw.eventName,
    canonicalLog,
    canonicalTokenCreatedKey,
    payloadDigest,
    deliveryStatus: raw.deliveryStatus,
    duplicateOf,
    canonicalOwnerDelivered: raw.canonicalOwnerDelivered,
    acceptedAt: exactIso(raw.acceptedAt, "processed.acceptedAt"),
  };
}

function normalizeOutboxEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !raw.event || typeof raw.event !== "object") {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "outbox entry is invalid");
  }
  const eventKey = boundedText(raw.eventKey, "outbox.eventKey", 400);
  const lifecycleKey = boundedText(raw.lifecycleKey, "outbox.lifecycleKey", 400);
  const validEvent = raw.event.type === FOUR_REGISTRY_CAPABILITY_EVENT_TYPE
    ? isFourRegistryCapabilityEvent(raw.event)
    : isFourRegistryFirstTokenEvent(raw.event);
  if (!validEvent || raw.event.eventKey !== eventKey || raw.event.lifecycleKey !== lifecycleKey) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", `outbox event ${eventKey} does not satisfy its closed producer schema`);
  }
  return {
    eventKey,
    lifecycleKey,
    event: clone(raw.event),
    enqueuedAt: exactIso(raw.enqueuedAt, "outbox.enqueuedAt"),
    attempts: integer(raw.attempts, "outbox.attempts"),
    lastAttemptAt: raw.lastAttemptAt === null ? null : exactIso(raw.lastAttemptAt, "outbox.lastAttemptAt"),
    lastOutcome: raw.lastOutcome === null ? null : boundedText(raw.lastOutcome, "outbox.lastOutcome", 160),
  };
}

function normalizeRecovery(raw) {
  if (!hasExactKeys(raw, [
    "recoveryEpoch", "detectedAt", "oldAnchorBlock", "oldAnchorBlockHash", "observedAnchorBlockHash",
    "recoveredAtBlock", "recoveredAtBlockHash", "catchUpThroughBlock", "policy", "droppedOutboxEventKeys",
  ])) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "reorg recovery entry is invalid");
  }
  return {
    recoveryEpoch: integer(raw.recoveryEpoch, "reorg.recoveryEpoch", 1),
    detectedAt: exactIso(raw.detectedAt, "reorg.detectedAt"),
    oldAnchorBlock: integer(raw.oldAnchorBlock, "reorg.oldAnchorBlock"),
    oldAnchorBlockHash: hash32(raw.oldAnchorBlockHash, "reorg.oldAnchorBlockHash"),
    observedAnchorBlockHash: hash32(raw.observedAnchorBlockHash, "reorg.observedAnchorBlockHash"),
    recoveredAtBlock: integer(raw.recoveredAtBlock, "reorg.recoveredAtBlock"),
    recoveredAtBlockHash: hash32(raw.recoveredAtBlockHash, "reorg.recoveredAtBlockHash"),
    catchUpThroughBlock: integer(raw.catchUpThroughBlock, "reorg.catchUpThroughBlock"),
    policy: raw.policy === "bounded_checkpoint_replay"
      ? raw.policy
      : (() => { throw fourError("FOUR_REGISTRY_STATE_INVALID", "reorg recovery policy is invalid"); })(),
    droppedOutboxEventKeys: Array.isArray(raw.droppedOutboxEventKeys)
      && raw.droppedOutboxEventKeys.every((key) => typeof key === "string" && key.length <= 400)
      ? [...raw.droppedOutboxEventKeys]
      : (() => { throw fourError("FOUR_REGISTRY_STATE_INVALID", "reorg dropped event keys are invalid"); })(),
  };
}

const ORPHAN_RECOVERY_KEYS = Object.freeze([
  "recoveryEpoch", "detectedAt", "oldAnchorBlock", "oldAnchorBlockHash", "observedAnchorBlockHash", "resumeBlock", "resumeBlockHash",
  "cancellationStatus",
]);

function normalizeOrphanedDeliveredEvent(raw, expectedOwnerKey) {
  if (!hasExactKeys(raw, ["positionKey", "origin", "processedEvent", "recovery"])
    || !hasExactKeys(raw.recovery, ORPHAN_RECOVERY_KEYS)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", `orphaned delivered event ${expectedOwnerKey} is invalid`);
  }
  const processedEvent = normalizeProcessedRecord(raw.processedEvent, raw.processedEvent?.eventKey);
  const origin = boundedText(raw.origin, "orphan origin", 16);
  const positionKey = canonicalPositionKey(processedEvent.transactionHash, processedEvent.logIndex);
  const ownerKey = canonicalOwnerHistoryKey(
    processedEvent.transactionHash,
    processedEvent.logIndex,
    processedEvent.blockHash,
  );
  const recovery = {
    recoveryEpoch: integer(raw.recovery.recoveryEpoch, "orphan recovery.recoveryEpoch", 1),
    detectedAt: exactIso(raw.recovery.detectedAt, "orphan recovery.detectedAt"),
    oldAnchorBlock: integer(raw.recovery.oldAnchorBlock, "orphan recovery.oldAnchorBlock"),
    oldAnchorBlockHash: hash32(raw.recovery.oldAnchorBlockHash, "orphan recovery.oldAnchorBlockHash"),
    observedAnchorBlockHash: hash32(raw.recovery.observedAnchorBlockHash, "orphan recovery.observedAnchorBlockHash"),
    resumeBlock: integer(raw.recovery.resumeBlock, "orphan recovery.resumeBlock"),
    resumeBlockHash: hash32(raw.recovery.resumeBlockHash, "orphan recovery.resumeBlockHash"),
    cancellationStatus: boundedText(raw.recovery.cancellationStatus, "orphan recovery.cancellationStatus", 40),
  };
  if (ownerKey !== expectedOwnerKey
    || raw.positionKey !== positionKey
    || !["outbox", "processed"].includes(origin)
    || recovery.oldAnchorBlock < processedEvent.blockNumber
    || recovery.resumeBlock >= processedEvent.blockNumber
    || recovery.oldAnchorBlock <= recovery.resumeBlock
    || recovery.oldAnchorBlockHash === recovery.observedAnchorBlockHash
    || !["still_canonical", "superseded", "delivered_orphaned"].includes(recovery.cancellationStatus)
    || Date.parse(recovery.detectedAt) < Date.parse(processedEvent.acceptedAt)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", `orphaned delivered event ${expectedOwnerKey} recovery proof is inconsistent`);
  }
  return { positionKey, origin, processedEvent, recovery };
}

function canonicalRevisionFromOrphan(baseEventKey, newBlockHash, currentBasePayloadDigest, orphan) {
  return {
    version: 1,
    reason: "canonical_reinclusion_after_finalized_reorg",
    baseEventKey,
    currentBasePayloadDigest,
    replacesEventKey: orphan.processedEvent.eventKey,
    replacesBaseEventKey: orphan.processedEvent.baseEventKey,
    replacesBlockHash: orphan.processedEvent.blockHash,
    replacesPayloadDigest: orphan.processedEvent.payloadDigest,
    transactionHash: orphan.processedEvent.transactionHash,
    logIndex: orphan.processedEvent.logIndex,
    newBlockHash,
    replacesDeliveryStatus: orphan.processedEvent.deliveryStatus,
    replacesDuplicateOf: orphan.processedEvent.duplicateOf,
    replacesCanonicalOwnerDelivered: orphan.processedEvent.canonicalOwnerDelivered,
    cancellationStatus: orphan.recovery.cancellationStatus,
    recoveryEpoch: orphan.recovery.recoveryEpoch,
    recoveryDetectedAt: orphan.recovery.detectedAt,
    recoveryOldAnchorBlock: orphan.recovery.oldAnchorBlock,
    recoveryOldAnchorBlockHash: orphan.recovery.oldAnchorBlockHash,
    recoveryObservedAnchorBlockHash: orphan.recovery.observedAnchorBlockHash,
    recoveryResumeBlock: orphan.recovery.resumeBlock,
    recoveryResumeBlockHash: orphan.recovery.resumeBlockHash,
  };
}

function canonicalRestorationFromOwner(orphan) {
  return {
    version: 1,
    reason: "original_block_recanonicalized",
    cancelledEventId: orphan.processedEvent.eventKey,
    blockHash: orphan.processedEvent.blockHash,
    payloadDigest: orphan.processedEvent.payloadDigest,
    detectedAt: orphan.recovery.detectedAt,
  };
}

function canonicalSupersessionFromOwner(baseEventKey, newBlockHash, currentBasePayloadDigest, orphan) {
  return {
    version: 1,
    reason: "undelivered_canonical_proof_superseded",
    baseEventKey,
    currentBasePayloadDigest,
    cancelledEventId: orphan.processedEvent.eventKey,
    cancelledBaseEventKey: orphan.processedEvent.baseEventKey,
    cancelledBlockHash: orphan.processedEvent.blockHash,
    cancelledPayloadDigest: orphan.processedEvent.payloadDigest,
    transactionHash: orphan.processedEvent.transactionHash,
    logIndex: orphan.processedEvent.logIndex,
    newBlockHash,
    detectedAt: orphan.recovery.detectedAt,
  };
}

function orphanOwnerWasDelivered(orphan) {
  const previous = orphan.processedEvent;
  return previous.deliveryStatus === "delivered"
    || (previous.deliveryStatus === "semantic_duplicate" && previous.canonicalOwnerDelivered === true)
    || orphan.recovery.cancellationStatus === "delivered_orphaned";
}

function canonicalOwnersAtPosition(durableState, transactionHash, eventLogIndex) {
  const positionKey = canonicalPositionKey(transactionHash, eventLogIndex);
  return Object.values(durableState.orphanedDeliveredEvents)
    .filter((owner) => owner.positionKey === positionKey)
    .sort((left, right) => Date.parse(left.recovery.detectedAt) - Date.parse(right.recovery.detectedAt)
      || Date.parse(left.processedEvent.acceptedAt) - Date.parse(right.processedEvent.acceptedAt)
      || left.processedEvent.blockHash.localeCompare(right.processedEvent.blockHash));
}

function normalizeCheckpoint(raw, mechanismOwner) {
  if (!hasExactKeys(raw, ["blockNumber", "blockHash", "presets", "pendingConfirmations", "mechanismTracking"])
    || !raw.presets || typeof raw.presets !== "object" || Array.isArray(raw.presets)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "checkpoint is invalid");
  }
  const presets = {};
  const checkpointBlockNumber = integer(raw.blockNumber, "checkpoint.blockNumber");
  const checkpointBlockHash = hash32(raw.blockHash, "checkpoint.blockHash");
  for (const [id, value] of Object.entries(raw.presets)) {
    const preset = normalizePreset(value, id);
    if (preset.fingerprint !== String(value.fingerprint || "").toLowerCase()) {
      throw fourError("FOUR_REGISTRY_STATE_INVALID", `checkpoint preset ${id} fingerprint is invalid`);
    }
    presets[id] = preset;
  }
  if (!raw.pendingConfirmations || typeof raw.pendingConfirmations !== "object" || Array.isArray(raw.pendingConfirmations)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "checkpoint pending confirmations are invalid");
  }
  const pendingConfirmations = {};
  for (const [id, pending] of Object.entries(raw.pendingConfirmations)) {
    const presetId = uintString(id, "checkpoint pending presetId");
    if (!presets[presetId]?.canCreate || !hasExactKeys(pending, ["presetId", "capabilityEventKey", "lifecycleKey", "armedAt"])) {
      throw fourError("FOUR_REGISTRY_STATE_INVALID", `checkpoint pending confirmation ${id} is invalid`);
    }
    const armedAt = normalizePosition(pending.armedAt, `checkpoint.pendingConfirmations.${id}.armedAt`);
    const lifecycleKey = boundedText(pending.lifecycleKey, "checkpoint pending lifecycleKey", 400);
    const capabilityEventKey = boundedText(pending.capabilityEventKey, "checkpoint pending capabilityEventKey", 400);
    const lifecycle = expectedPresetLifecycleParts(lifecycleKey);
    const capability = parseCapabilityOwnerKey(capabilityEventKey);
    if (uintString(pending.presetId, "checkpoint pending.presetId") !== presetId
      || lifecycle?.[1] !== presetId
      || capability?.[1] !== lifecycle?.[2]
      || capability?.[2] !== lifecycle?.[3]
      || armedAt.blockNumber > checkpointBlockNumber
      || (armedAt.blockNumber === checkpointBlockNumber && armedAt.blockHash !== checkpointBlockHash)
      || armedAt.logIndex !== Number(lifecycle?.[3])) {
      throw fourError("FOUR_REGISTRY_STATE_INVALID", `checkpoint pending confirmation ${id} lifecycle is inconsistent`);
    }
    pendingConfirmations[presetId] = { presetId, capabilityEventKey, lifecycleKey, armedAt };
  }
  return {
    blockNumber: checkpointBlockNumber,
    blockHash: checkpointBlockHash,
    presets,
    pendingConfirmations,
    mechanismTracking: validateMechanismCheckpoint(raw.mechanismTracking, mechanismOwner, checkpointBlockNumber),
  };
}

function normalizePresetAuditProof(raw, expectedId, expectedFingerprint) {
  if (!hasExactKeys(raw, ["presetId", "blockNumber", "blockHash", "fingerprint"])
    || uintString(raw.presetId, "presetAudit.presetId") !== expectedId
    || hash32(raw.fingerprint, "presetAudit.fingerprint") !== expectedFingerprint) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", `preset audit proof ${expectedId} is invalid`);
  }
  return {
    presetId: expectedId,
    blockNumber: integer(raw.blockNumber, "presetAudit.blockNumber"),
    blockHash: hash32(raw.blockHash, "presetAudit.blockHash"),
    fingerprint: expectedFingerprint,
  };
}

function normalizeState(raw) {
  // Upgrade only the known closed v11 schema. Existing mechanisms become a
  // silent consumed baseline, never three newly available historical entries.
  if (raw?.version === 11 && hasExactKeys(raw, Object.keys(emptyState()).filter((key) => key !== "mechanismTracking"))) {
    const tracking = seedMechanismTracking(raw.presets);
    // Old retained checkpoints carry no post-upgrade token-order authority.
    for (const checkpoint of raw.checkpoints) Object.assign(tracking.generations, seedMechanismTracking(checkpoint.presets).generations);
    raw = { ...clone(raw), version: FOUR_REGISTRY_STATE_VERSION, mechanismTracking: tracking,
      checkpoints: raw.checkpoints.map((checkpoint) => ({ ...checkpoint,
        mechanismTracking: mechanismCheckpoint(tracking) })) };
  }
  if (!hasExactKeys(raw, Object.keys(emptyState()))) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "state root does not satisfy the closed schema");
  }
  if (raw.version !== FOUR_REGISTRY_STATE_VERSION
    || integer(raw.chainId, "state.chainId") !== FOUR_REGISTRY_CHAIN_ID
    || address(raw.registry, "state.registry") !== FOUR_REGISTRY_ADDRESS
    || address(raw.core, "state.core") !== FOUR_CORE_ADDRESS
    || typeof raw.initialized !== "boolean") {
    throw fourError("FOUR_REGISTRY_STATE_IDENTITY_MISMATCH", "persisted Four Registry identity is invalid");
  }
  // Only an absent state file is a valid first launch. Treating a persisted
  // initialized:false bit as a new install would silently replace a damaged
  // cursor with a fresh baseline and skip everything in between.
  if (!raw.initialized) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "persisted state cannot be uninitialized");
  }
  const presets = {};
  if (!raw.presets || typeof raw.presets !== "object" || Array.isArray(raw.presets)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "state presets are invalid");
  }
  for (const [id, value] of Object.entries(raw.presets)) {
    const preset = normalizePreset(value, id);
    if (preset.fingerprint !== String(value.fingerprint || "").toLowerCase()) {
      throw fourError("FOUR_REGISTRY_STATE_INVALID", `persisted preset ${id} fingerprint is invalid`);
    }
    presets[id] = preset;
  }
  if (!raw.presetAuditProofs || typeof raw.presetAuditProofs !== "object" || Array.isArray(raw.presetAuditProofs)
    || Object.keys(raw.presetAuditProofs).length !== Object.keys(presets).length) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "state preset audit proofs are not an exact preset index");
  }
  const presetAuditProofs = Object.fromEntries(Object.entries(presets).map(([id, preset]) => [
    id,
    normalizePresetAuditProof(raw.presetAuditProofs[id], id, preset.fingerprint),
  ]));
  const presetAuditCursor = integer(raw.presetAuditCursor, "state.presetAuditCursor");
  if (!raw.processedEvents || typeof raw.processedEvents !== "object" || Array.isArray(raw.processedEvents)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "state processed events are invalid");
  }
  const processedEvents = Object.fromEntries(Object.entries(raw.processedEvents)
    .map(([key, value]) => [key, normalizeProcessedRecord(value, key)]));
  if (Object.keys(processedEvents).length > MAX_PROCESSED_KEYS
    || !Array.isArray(raw.processedEventKeys)
    || raw.processedEventKeys.some((key) => typeof key !== "string" || key.length > 400)
    || raw.processedEventKeys.length !== Object.keys(processedEvents).length
    || new Set(raw.processedEventKeys).size !== raw.processedEventKeys.length
    || raw.processedEventKeys.some((key) => !Object.hasOwn(processedEvents, key))) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "state processed keys are not an exact index of processed events");
  }
  if (!Array.isArray(raw.outbox) || raw.outbox.length > MAX_OUTBOX_EVENTS) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "state outbox is invalid");
  }
  const outbox = raw.outbox.map(normalizeOutboxEntry);
  const outboxKeys = new Set(outbox.map((entry) => entry.eventKey));
  if (outboxKeys.size !== outbox.length || [...outboxKeys].some((key) => Object.hasOwn(processedEvents, key))) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "state outbox is duplicated or already processed");
  }
  if (!raw.orphanedDeliveredEvents
    || typeof raw.orphanedDeliveredEvents !== "object"
    || Array.isArray(raw.orphanedDeliveredEvents)
    || Object.keys(raw.orphanedDeliveredEvents).length > MAX_ORPHANED_DELIVERED_EVENTS) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "state orphaned delivered events are invalid");
  }
  const orphanedDeliveredEvents = Object.fromEntries(Object.entries(raw.orphanedDeliveredEvents)
    .map(([key, value]) => [key, normalizeOrphanedDeliveredEvent(value, key)]));
  const canonicalRecoveryEpoch = integer(raw.canonicalRecoveryEpoch, "state.canonicalRecoveryEpoch");
  const durableReorgEvents = [
    ...Object.values(processedEvents).map((record) => record.event),
    ...outbox.map((entry) => entry.event),
  ].filter((event) => event.canonicalRevision || event.canonicalRestoration || event.canonicalSupersession);
  for (const event of durableReorgEvents) {
    const priorBlockHash = event.canonicalRestoration?.blockHash
      || event.canonicalRevision?.replacesBlockHash
      || event.canonicalSupersession?.cancelledBlockHash;
    const ownerKey = canonicalOwnerHistoryKey(event.transactionHash, event.logIndex, priorBlockHash);
    const orphan = orphanedDeliveredEvents[ownerKey];
    if (!orphan) {
      throw fourError("FOUR_REGISTRY_STATE_INVALID", `reorg envelope ${event.eventKey} has no durable prior owner`);
    }
    if (event.canonicalRevision) {
      const revision = event.canonicalRevision;
      if (event.canonicalRestoration) {
        if (!exactData(revision, orphan.processedEvent.event.canonicalRevision)) {
          throw fourError("FOUR_REGISTRY_STATE_INVALID", `restored revision ${event.eventKey} changed its underlying proof`);
        }
      } else {
      const deliveredHistory = orphanOwnerWasDelivered(orphan)
        || orphan.processedEvent.event.canonicalRevision?.replacesDeliveryStatus === "delivered"
        || orphan.processedEvent.event.canonicalRevision?.replacesCanonicalOwnerDelivered === true
        || orphan.processedEvent.event.canonicalRevision?.cancellationStatus === "delivered_orphaned";
      if (!deliveredHistory || !exactData(
        revision,
        canonicalRevisionFromOrphan(
          revision.baseEventKey,
          event.blockHash,
          revision.currentBasePayloadDigest,
          orphan,
        ),
      )) {
        throw fourError("FOUR_REGISTRY_STATE_INVALID", `canonical revision ${event.eventKey} does not bind a delivered prior owner`);
      }
      }
    }
    if (event.canonicalRestoration
      && (orphanOwnerWasDelivered(orphan)
        || orphan.recovery.cancellationStatus !== "superseded"
        || event.blockHash !== orphan.processedEvent.blockHash
        || !exactData(event.canonicalRestoration, canonicalRestorationFromOwner(orphan)))) {
      throw fourError("FOUR_REGISTRY_STATE_INVALID", `canonical restoration ${event.eventKey} does not bind a cancelled prior owner`);
    }
    if (event.canonicalSupersession && event.canonicalRestoration
      && !exactData(event.canonicalSupersession, orphan.processedEvent.event.canonicalSupersession)) {
      throw fourError("FOUR_REGISTRY_STATE_INVALID", `restored supersession ${event.eventKey} changed its underlying proof`);
    }
    if (event.canonicalSupersession && !event.canonicalRestoration
      && (orphanOwnerWasDelivered(orphan)
        || orphan.recovery.cancellationStatus !== "superseded"
        || event.blockHash === orphan.processedEvent.blockHash
        || !exactData(event.canonicalSupersession, canonicalSupersessionFromOwner(
          event.canonicalSupersession.baseEventKey,
          event.blockHash,
          event.canonicalSupersession.currentBasePayloadDigest,
          orphan,
        )))) {
      throw fourError("FOUR_REGISTRY_STATE_INVALID", `canonical supersession ${event.eventKey} does not bind a cancelled prior owner`);
    }
  }
  const pendingConfirmations = {};
  if (!raw.pendingConfirmations || typeof raw.pendingConfirmations !== "object" || Array.isArray(raw.pendingConfirmations)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "state pending confirmations are invalid");
  }
  for (const [id, pending] of Object.entries(raw.pendingConfirmations)) {
    if (!pending || typeof pending !== "object") {
      throw fourError("FOUR_REGISTRY_STATE_INVALID", `pending confirmation ${id} is invalid`);
    }
    pendingConfirmations[id] = {
      presetId: id,
      capabilityEventKey: boundedText(pending.capabilityEventKey, "capabilityEventKey", 300),
      lifecycleKey: boundedText(pending.lifecycleKey, "lifecycleKey", 400),
      armedAt: normalizePosition(pending.armedAt, `pendingConfirmations.${id}.armedAt`),
    };
    const referenced = processedEvents[pendingConfirmations[id].capabilityEventKey]
      || outbox.find((entry) => entry.eventKey === pendingConfirmations[id].capabilityEventKey)?.event;
    const referencedEvent = referenced?.event || referenced;
    const replayOwner = referencedEvent && orphanedDeliveredEvents[canonicalOwnerHistoryKey(
      referencedEvent.transactionHash,
      referencedEvent.logIndex,
      referencedEvent.blockHash,
    )];
    const missingPresetIsRetainedOverlay = !presets[id]
      && referencedEvent?.currentPreset?.id === id
      && referencedEvent.currentPreset.canCreate === true
      && replayOwner?.recovery.cancellationStatus === "still_canonical"
      && exactData(replayOwner.processedEvent.event, referencedEvent);
    if ((!presets[id] && !missingPresetIsRetainedOverlay)
      || !referenced
      || (referenced.eventType || referenced.type) !== FOUR_REGISTRY_CAPABILITY_EVENT_TYPE
      || referenced.lifecycleKey !== pendingConfirmations[id].lifecycleKey
      || String(referenced.presetId) !== id
      || !exactData(pendingConfirmations[id].armedAt, {
        blockNumber: referencedEvent.blockNumber,
        transactionIndex: referencedEvent.transactionIndex,
        logIndex: referencedEvent.logIndex,
        blockHash: referencedEvent.blockHash,
      })) {
      throw fourError("FOUR_REGISTRY_STATE_INVALID", `pending confirmation ${id} is not bound to a durable capability event`);
    }
  }
  if (!Array.isArray(raw.reorgRecoveries) || raw.reorgRecoveries.length > MAX_REORG_RECOVERIES) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "state reorg recoveries are invalid");
  }
  const reorgRecoveries = raw.reorgRecoveries.map(normalizeRecovery);
  if (reorgRecoveries.some((recovery, index) => recovery.recoveryEpoch > canonicalRecoveryEpoch
    || (index > 0 && reorgRecoveries[index - 1].recoveryEpoch >= recovery.recoveryEpoch))
    || Object.values(orphanedDeliveredEvents).some((owner) => owner.recovery.recoveryEpoch > canonicalRecoveryEpoch)
    || durableReorgEvents.some((event) => (event.canonicalRevision?.recoveryEpoch || 0) > canonicalRecoveryEpoch)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "canonical recovery epochs are not monotonic and state-bound");
  }
  if (!Array.isArray(raw.checkpoints) || raw.checkpoints.length === 0 || raw.checkpoints.length > MAX_CHECKPOINTS) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "state checkpoints are invalid");
  }
  const checkpoints = raw.checkpoints.map((checkpoint) => normalizeCheckpoint(checkpoint, raw.mechanismTracking));
  for (let index = 1; index < checkpoints.length; index += 1) {
    if (checkpoints[index - 1].blockNumber >= checkpoints[index].blockNumber) {
      throw fourError("FOUR_REGISTRY_STATE_INVALID", "state checkpoints are not strictly ordered");
    }
  }
  for (const checkpoint of checkpoints) {
    for (const [presetId, pending] of Object.entries(checkpoint.pendingConfirmations)) {
      const referenced = processedEvents[pending.capabilityEventKey]
        || outbox.find((entry) => entry.eventKey === pending.capabilityEventKey)?.event;
      if (!referenced
        || (referenced.eventType || referenced.type) !== FOUR_REGISTRY_CAPABILITY_EVENT_TYPE
        || referenced.lifecycleKey !== pending.lifecycleKey
        || String(referenced.presetId) !== presetId
        || Number(referenced.blockNumber) > checkpoint.blockNumber
        || !exactData(pending.armedAt, {
          blockNumber: Number(referenced.blockNumber),
          transactionIndex: Number(referenced.transactionIndex),
          logIndex: Number(referenced.logIndex),
          blockHash: referenced.blockHash,
        })) {
        throw fourError(
          "FOUR_REGISTRY_STATE_INVALID",
          `checkpoint ${checkpoint.blockNumber} pending confirmation ${presetId} lacks its durable capability proof`,
        );
      }
    }
  }
  const lastCheckpoint = checkpoints.at(-1);
  const cursor = normalizeCursor(raw.cursor);
  const mechanismTracking = normalizeMechanismTracking(raw.mechanismTracking, cursor.anchorBlock);
  if (!exactData(mechanismCheckpoint(mechanismTracking), lastCheckpoint.mechanismTracking)) {
    throw fourError("FOUR_REGISTRY_TRACKING_INVALID", "latest checkpoint does not bind mechanism/order history");
  }
  if (lastCheckpoint.blockNumber !== cursor.anchorBlock || lastCheckpoint.blockHash !== cursor.anchorBlockHash) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "latest checkpoint does not bind the state cursor");
  }
  const statePresetFingerprints = Object.fromEntries(Object.entries(presets).map(([id, preset]) => [id, preset.fingerprint]));
  const checkpointPresetFingerprints = Object.fromEntries(Object.entries(lastCheckpoint.presets).map(([id, preset]) => [id, preset.fingerprint]));
  if (JSON.stringify(statePresetFingerprints) !== JSON.stringify(checkpointPresetFingerprints)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "latest checkpoint does not bind the state inventory");
  }
  const checkpointBoundPending = Object.fromEntries(Object.entries(pendingConfirmations)
    .filter(([, pending]) => pending.armedAt.blockNumber <= lastCheckpoint.blockNumber));
  if (!exactData(lastCheckpoint.pendingConfirmations, checkpointBoundPending)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "latest checkpoint does not bind pending capability lifecycles");
  }
  const isRetainedCanonicalReplayEvent = (event) => {
    const owner = orphanedDeliveredEvents[canonicalOwnerHistoryKey(
      event.transactionHash,
      event.logIndex,
      event.blockHash,
    )];
    return owner?.recovery.cancellationStatus === "still_canonical"
      && owner.recovery.resumeBlock === cursor.anchorBlock
      && exactData(owner.processedEvent.event, event);
  };
  if (outbox.some((entry) => integer(entry.event.blockNumber, "outbox.event.blockNumber") > cursor.anchorBlock
      && !isRetainedCanonicalReplayEvent(entry.event))
    || Object.values(processedEvents).some((entry) => entry.blockNumber > cursor.anchorBlock
      && !isRetainedCanonicalReplayEvent(entry.event))
    || Object.values(pendingConfirmations).some((pending) => {
      if (pending.armedAt.blockNumber <= cursor.anchorBlock) return false;
      const referenced = processedEvents[pending.capabilityEventKey]
        || outbox.find((entry) => entry.eventKey === pending.capabilityEventKey)?.event;
      return !referenced || !isRetainedCanonicalReplayEvent(referenced.event || referenced);
    })) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "durable event lifecycle is ahead of the state cursor");
  }
  if (Object.values(presetAuditProofs).some((proof) => proof.blockNumber > cursor.anchorBlock)
    || (Object.keys(presets).length === 0 ? presetAuditCursor !== 0 : presetAuditCursor >= Object.keys(presets).length)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "preset audit cursor/proof is ahead of durable state");
  }
  const tokenBackfillSuppressedThroughBlock = raw.tokenBackfillSuppressedThroughBlock === null
    ? null
    : integer(raw.tokenBackfillSuppressedThroughBlock, "state.tokenBackfillSuppressedThroughBlock");
  const baselineBlock = integer(raw.baselineBlock, "state.baselineBlock");
  if (baselineBlock > cursor.anchorBlock
    || tokenBackfillSuppressedThroughBlock === null
    || tokenBackfillSuppressedThroughBlock !== baselineBlock
    || !checkpoints.some((checkpoint) => checkpoint.blockNumber === baselineBlock)
    || reorgRecoveries.some((recovery) => recovery.recoveredAtBlock > recovery.catchUpThroughBlock)) {
    throw fourError("FOUR_REGISTRY_STATE_INVALID", "historical token suppression is not bound exactly to the retained first-run baseline");
  }
  return {
    ...emptyState(),
    initialized: true,
    cursor,
    presets,
    presetAuditCursor,
    presetAuditProofs,
    pendingConfirmations,
    mechanismTracking,
    outbox,
    processedEvents,
    processedEventKeys: [...raw.processedEventKeys],
    orphanedDeliveredEvents,
    canonicalRecoveryEpoch,
    checkpoints,
    reorgRecoveries,
    tokenBackfillSuppressedThroughBlock,
    baselineBlock,
    baselineAt: exactIso(raw.baselineAt, "state.baselineAt"),
    updatedAt: exactIso(raw.updatedAt, "state.updatedAt"),
  };
}

export async function readFourRegistryState(file, fsImpl = fs) {
  try { return normalizeState(JSON.parse(await fsImpl.readFile(file, "utf8"))); }
  catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
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

export async function atomicWriteFourRegistryState(file, value, fsImpl = fs) {
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

async function contractCall(provider, iface, functionName, to, args, blockTag) {
  let raw;
  const request = { to, data: iface.encodeFunctionData(functionName, args), blockTag };
  let retryHash = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      raw = await provider.call(request);
      break;
    } catch (error) {
      const seen = new Set();
      const messages = [];
      const visit = (candidate) => {
        if (!candidate || seen.has(candidate)) return;
        if (typeof candidate === "string") {
          messages.push(candidate);
          return;
        }
        if (typeof candidate !== "object") return;
        seen.add(candidate);
        if (typeof candidate.message === "string") messages.push(candidate.message);
        visit(candidate.cause);
        visit(candidate.error);
        visit(candidate.info?.error);
      };
      visit(error);
      const exactUnavailable = messages
        .map((message) => /^historical state (0x[a-f0-9]{64}) is not available$/iu.exec(message.trim()))
        .find(Boolean);
      const unavailableHash = exactUnavailable?.[1]?.toLowerCase() || null;
      if (attempt < 2 && unavailableHash && (retryHash === null || retryHash === unavailableHash)) {
        retryHash = unavailableHash;
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 50 : 100));
        continue;
      }
      throw fourError("FOUR_REGISTRY_CALL_FAILED", `${functionName} failed at block ${blockTag}: ${error.message}`, error);
    }
  }
  if (typeof raw !== "string" || !/^0x(?:[a-f0-9]{2})*$/iu.test(raw)) {
    throw fourError("FOUR_REGISTRY_CALL_INVALID", `${functionName} returned malformed ABI data`);
  }
  try { return iface.decodeFunctionResult(functionName, raw); }
  catch (error) {
    throw fourError("FOUR_REGISTRY_CALL_INVALID", `${functionName} returned undecodable ABI data`, error);
  }
}

function blockRecord(raw, expectedNumber, label) {
  if (!raw || integer(raw.number, `${label}.number`) !== expectedNumber) {
    throw fourError("FOUR_REGISTRY_BLOCK_INVALID", `${label} ${expectedNumber} is unavailable`);
  }
  return {
    number: expectedNumber,
    hash: hash32(raw.hash, `${label}.hash`),
    timestamp: integer(raw.timestamp, `${label}.timestamp`),
  };
}

function exactBlock(provider, blockNumber) {
  return typeof provider.getHistoricalBlock === "function"
    ? provider.getHistoricalBlock(blockNumber)
    : provider.getBlock(blockNumber);
}

export function restoreFourLegacyTransaction(raw, transactionHash) {
  // Some public BSC RPCs serialize pre-EIP-155 transactions with chainId="".
  // Recover only that exact representation defect, never assume chain 56.
  // v=27/28 means an unprotected legacy signature (chainId 0); canonical BSC
  // inclusion still requires the independent network/block/receipt proofs.
  if (!raw || raw.chainId !== "" || raw.type !== "0x0") {
    throw fourError("FOUR_REGISTRY_TRANSACTION_INVALID", "unsupported malformed transaction representation");
  }
  try {
    for (const field of ["nonce", "gas", "gasPrice", "value", "v", "blockNumber", "transactionIndex"]) {
      if (typeof raw[field] !== "string" || !/^0x(?:0|[1-9a-f][a-f0-9]*)$/iu.test(raw[field])) {
        throw new Error(`invalid transaction ${field}`);
      }
    }
    if (typeof raw.input !== "string" || !/^0x(?:[a-f0-9]{2})*$/iu.test(raw.input)) throw new Error("invalid transaction input");
    const signature = Signature.from({ r: raw.r, s: raw.s, v: BigInt(raw.v) });
    const chainId = Signature.getChainId(BigInt(raw.v));
    if (chainId !== 0n && chainId !== BigInt(FOUR_REGISTRY_CHAIN_ID)) throw new Error("signature belongs to another chain");
    const transaction = Transaction.from({
      type: 0, chainId, nonce: integer(raw.nonce, "transaction.nonce"),
      gasLimit: raw.gas, gasPrice: raw.gasPrice, value: raw.value,
      to: raw.to === null ? null : address(raw.to, "transaction.to"),
      data: raw.input, signature,
    });
    const expectedHash = hash32(transactionHash, "requested transaction hash");
    if (transaction.hash?.toLowerCase() !== expectedHash
      || hash32(raw.hash, "transaction.hash") !== expectedHash
      || transaction.from?.toLowerCase() !== address(raw.from, "transaction.from")) {
      throw new Error("signed transaction hash or sender mismatch");
    }
    return { ...raw, chainId: `0x${chainId.toString(16)}`,
      blockHash: hash32(raw.blockHash, "transaction.blockHash"),
      blockNumber: integer(raw.blockNumber, "transaction.blockNumber"),
      index: integer(raw.transactionIndex, "transaction.transactionIndex") };
  } catch (error) {
    throw fourError("FOUR_REGISTRY_TRANSACTION_INVALID", `legacy signed transaction verification failed: ${error.message}`, error);
  }
}

async function exactTransaction(provider, transactionHash) {
  try {
    return await (typeof provider.getHistoricalTransaction === "function"
      ? provider.getHistoricalTransaction(transactionHash)
      : provider.getTransaction(transactionHash));
  } catch (error) {
    // Do not turn rate limits, null transactions, or other format errors into
    // an extra read. The same pinned source and its RPC budget remain in use.
    if (typeof provider.send !== "function" || !/chainId/i.test(error?.message || "")
      || !/empty string/i.test(error?.message || "")) throw error;
    const raw = await provider.send("eth_getTransactionByHash", [transactionHash]);
    return restoreFourLegacyTransaction(raw, transactionHash);
  }
}

function exactTransactionReceipt(provider, transactionHash) {
  return typeof provider.getHistoricalTransactionReceipt === "function"
    ? provider.getHistoricalTransactionReceipt(transactionHash)
    : provider.getTransactionReceipt(transactionHash);
}

function parseRpcChainId(value, label) {
  const chainId = integer(value, label, 1);
  if (chainId !== FOUR_REGISTRY_CHAIN_ID) {
    throw fourError("FOUR_REGISTRY_CHAIN_ID_MISMATCH", `${label} is chain ${chainId}, expected BSC 56`);
  }
  return chainId;
}

export async function verifyFourRegistryIdentity(provider, blockNumber) {
  let network;
  let liveChainId = null;
  let block;
  let registryCode;
  let coreCode;
  try {
    [network, block, registryCode, coreCode] = await Promise.all([
      provider.getNetwork(),
      exactBlock(provider, blockNumber),
      provider.getCode(FOUR_REGISTRY_ADDRESS, blockNumber),
      provider.getCode(FOUR_CORE_ADDRESS, blockNumber),
    ]);
    if (typeof provider.send === "function") liveChainId = await provider.send("eth_chainId", []);
  } catch (error) {
    throw fourError("FOUR_REGISTRY_IDENTITY_UNAVAILABLE", `Four Registry identity lookup failed: ${error.message}`, error);
  }
  parseRpcChainId(network?.chainId, "provider.getNetwork()");
  if (liveChainId !== null) parseRpcChainId(liveChainId, "eth_chainId");
  const finalizedBlock = blockRecord(block, blockNumber, "finalized block");
  if (typeof registryCode !== "string" || !/^0x[a-f0-9]+$/iu.test(registryCode) || registryCode === "0x") {
    throw fourError("FOUR_REGISTRY_CODE_EMPTY", "pinned Four Registry has no finalized runtime code");
  }
  if (typeof coreCode !== "string" || !/^0x[a-f0-9]+$/iu.test(coreCode) || coreCode === "0x") {
    throw fourError("FOUR_CORE_CODE_EMPTY", "pinned OpenFour Core has no finalized runtime code");
  }
  const [coreResult, registryResult] = await Promise.all([
    contractCall(provider, FOUR_REGISTRY_INTERFACE, "openFourCore", FOUR_REGISTRY_ADDRESS, [], blockNumber),
    contractCall(provider, FOUR_CORE_INTERFACE, "registry", FOUR_CORE_ADDRESS, [], blockNumber),
  ]);
  const registryCore = address(coreResult[0], "registry.openFourCore");
  const coreRegistry = address(registryResult[0], "core.registry");
  if (registryCore !== FOUR_CORE_ADDRESS || coreRegistry !== FOUR_REGISTRY_ADDRESS) {
    throw fourError("FOUR_REGISTRY_BINDING_MISMATCH", "pinned Registry and Core do not bind to each other at the finalized block");
  }
  return {
    chainId: FOUR_REGISTRY_CHAIN_ID,
    registry: FOUR_REGISTRY_ADDRESS,
    core: FOUR_CORE_ADDRESS,
    block: finalizedBlock,
    registryCodeHash: keccak256(registryCode).toLowerCase(),
    coreCodeHash: keccak256(coreCode).toLowerCase(),
  };
}

export async function readFourRegistryPreset(provider, idValue, blockNumber) {
  const id = uintString(idValue, "presetId");
  const [preset, activeResult, createEnabledResult] = await Promise.all([
    readFourRegistryPresetTuple(provider, id, blockNumber),
    contractCall(provider, FOUR_REGISTRY_INTERFACE, "isPresetActive", FOUR_REGISTRY_ADDRESS, [id], blockNumber),
    contractCall(provider, FOUR_REGISTRY_INTERFACE, "isPresetCreateEnabled", FOUR_REGISTRY_ADDRESS, [id], blockNumber),
  ]);
  if (typeof activeResult[0] !== "boolean" || typeof createEnabledResult[0] !== "boolean"
    || preset.active !== activeResult[0] || preset.createEnabled !== createEnabledResult[0]) {
    throw fourError("FOUR_REGISTRY_STATUS_MISMATCH", `preset ${id} tuple and status getters disagree at block ${blockNumber}`);
  }
  return preset;
}

async function readFourRegistryPresetTuple(provider, idValue, blockNumber) {
  const id = uintString(idValue, "presetId");
  const tupleResult = await contractCall(
    provider,
    FOUR_REGISTRY_INTERFACE,
    "getPreset",
    FOUR_REGISTRY_ADDRESS,
    [id],
    blockNumber,
  );
  return normalizePreset(tupleResult[0], id);
}

async function readFourRegistryPresetIds(provider, blockNumber) {
  const idsResult = await contractCall(provider, FOUR_REGISTRY_INTERFACE, "getPresetIds", FOUR_REGISTRY_ADDRESS, [], blockNumber);
  if (!Array.isArray(idsResult[0])) {
    throw fourError("FOUR_REGISTRY_INVENTORY_INVALID", "getPresetIds returned a non-array");
  }
  const ids = idsResult[0].map((value, index) => uintString(value, `presetIds[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw fourError("FOUR_REGISTRY_INVENTORY_INVALID", "getPresetIds returned duplicate ids");
  }
  ids.sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0));
  return ids;
}

export async function readFourRegistryInventory(provider, blockNumber) {
  const ids = await readFourRegistryPresetIds(provider, blockNumber);
  const records = new Array(ids.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(INVENTORY_READ_CONCURRENCY, ids.length) }, async () => {
    while (nextIndex < ids.length) {
      const index = nextIndex;
      nextIndex += 1;
      records[index] = await readFourRegistryPreset(provider, ids[index], blockNumber);
    }
  }));
  return Object.fromEntries(records.map((preset) => [preset.id, preset]));
}

function multicallRead(target, iface, functionName, args, label) {
  return {
    target,
    iface,
    functionName,
    args,
    label,
    callData: iface.encodeFunctionData(functionName, args),
  };
}

async function executeFourRegistryMulticall(provider, reads, blockNumber) {
  const decoded = [];
  for (let offset = 0; offset < reads.length; offset += MULTICALL3_MAX_SUBCALLS) {
    const batch = reads.slice(offset, offset + MULTICALL3_MAX_SUBCALLS);
    const aggregate = await contractCall(
      provider,
      FOUR_REGISTRY_MULTICALL3_INTERFACE,
      "aggregate3",
      FOUR_REGISTRY_MULTICALL3_ADDRESS,
      [batch.map((read) => ({
        target: read.target,
        allowFailure: false,
        callData: read.callData,
      }))],
      blockNumber,
    );
    const results = aggregate[0];
    if (!Array.isArray(results) || results.length !== batch.length) {
      throw fourError(
        "FOUR_REGISTRY_MULTICALL_INVALID",
        `Multicall3 returned ${results?.length ?? "invalid"} results for ${batch.length} exact reads`,
      );
    }
    for (let index = 0; index < batch.length; index += 1) {
      const result = results[index];
      const success = result?.success ?? result?.[0];
      const returnData = result?.returnData ?? result?.[1];
      if (success !== true || typeof returnData !== "string" || !/^0x(?:[a-f0-9]{2})*$/iu.test(returnData)) {
        throw fourError("FOUR_REGISTRY_MULTICALL_INVALID", `${batch[index].label} did not return exact ABI data`);
      }
      try {
        decoded.push(batch[index].iface.decodeFunctionResult(batch[index].functionName, returnData));
      } catch (error) {
        throw fourError("FOUR_REGISTRY_MULTICALL_INVALID", `${batch[index].label} returned undecodable ABI data`, error);
      }
    }
  }
  return decoded;
}

async function runtimeIdentityAt(provider, blockNumber, cache) {
  const cached = cache.get(provider);
  if (cached
    && blockNumber >= cached.verifiedAtBlock
    && blockNumber - cached.verifiedAtBlock < RUNTIME_IDENTITY_RECHECK_BLOCKS) return cached;
  let network;
  let liveChainId = null;
  let registryCode;
  let coreCode;
  let multicallCode;
  try {
    [network, registryCode, coreCode, multicallCode, liveChainId] = await Promise.all([
      provider.getNetwork(),
      provider.getCode(FOUR_REGISTRY_ADDRESS, blockNumber),
      provider.getCode(FOUR_CORE_ADDRESS, blockNumber),
      provider.getCode(FOUR_REGISTRY_MULTICALL3_ADDRESS, blockNumber),
      typeof provider.send === "function" ? provider.send("eth_chainId", []) : null,
    ]);
  } catch (error) {
    throw fourError("FOUR_REGISTRY_IDENTITY_UNAVAILABLE", `Four Registry runtime identity lookup failed: ${error.message}`, error);
  }
  parseRpcChainId(network?.chainId, "provider.getNetwork()");
  if (liveChainId !== null) parseRpcChainId(liveChainId, "eth_chainId");
  const normalizedRegistryCode = normalizedRuntimeCode(registryCode, "Four Registry runtime");
  const normalizedCoreCode = normalizedRuntimeCode(coreCode, "OpenFour Core runtime");
  const normalizedMulticallCode = normalizedRuntimeCode(multicallCode, "Multicall3 runtime");
  if (normalizedRegistryCode === "0x") {
    throw fourError("FOUR_REGISTRY_CODE_EMPTY", "pinned Four Registry has no finalized runtime code");
  }
  if (normalizedCoreCode === "0x") {
    throw fourError("FOUR_CORE_CODE_EMPTY", "pinned OpenFour Core has no finalized runtime code");
  }
  const multicallCodeHash = keccak256(normalizedMulticallCode).toLowerCase();
  if (multicallCodeHash !== cache.expectedMulticall3CodeHash) {
    throw fourError("FOUR_REGISTRY_MULTICALL_IDENTITY_MISMATCH", "pinned BSC Multicall3 runtime hash is invalid");
  }
  const verified = {
    verifiedAtBlock: blockNumber,
    registryCodeHash: keccak256(normalizedRegistryCode).toLowerCase(),
    coreCodeHash: keccak256(normalizedCoreCode).toLowerCase(),
    multicallCodeHash,
  };
  cache.set(provider, verified);
  return verified;
}

async function readFourRegistryMulticallSnapshot(provider, block, runtimeCache) {
  const runtimePromise = runtimeIdentityAt(provider, block.number, runtimeCache);
  const headerReads = [
    multicallRead(FOUR_REGISTRY_ADDRESS, FOUR_REGISTRY_INTERFACE, "openFourCore", [], "registry.openFourCore"),
    multicallRead(FOUR_CORE_ADDRESS, FOUR_CORE_INTERFACE, "registry", [], "core.registry"),
    multicallRead(FOUR_REGISTRY_ADDRESS, FOUR_REGISTRY_INTERFACE, "getPresetIds", [], "registry.getPresetIds"),
  ];
  const [runtime, headerResults] = await Promise.all([
    runtimePromise,
    executeFourRegistryMulticall(provider, headerReads, block.number),
  ]);
  const registryCore = address(headerResults[0]?.[0], "registry.openFourCore");
  const coreRegistry = address(headerResults[1]?.[0], "core.registry");
  if (registryCore !== FOUR_CORE_ADDRESS || coreRegistry !== FOUR_REGISTRY_ADDRESS) {
    throw fourError("FOUR_REGISTRY_BINDING_MISMATCH", "pinned Registry and Core do not bind to each other at the finalized block");
  }
  if (!Array.isArray(headerResults[2]?.[0])) {
    throw fourError("FOUR_REGISTRY_INVENTORY_INVALID", "getPresetIds returned a non-array");
  }
  const ids = headerResults[2][0].map((value, index) => uintString(value, `presetIds[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw fourError("FOUR_REGISTRY_INVENTORY_INVALID", "getPresetIds returned duplicate ids");
  }
  ids.sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0));
  const presetReads = ids.flatMap((id) => [
    multicallRead(FOUR_REGISTRY_ADDRESS, FOUR_REGISTRY_INTERFACE, "getPreset", [id], `preset ${id} tuple`),
    multicallRead(FOUR_REGISTRY_ADDRESS, FOUR_REGISTRY_INTERFACE, "isPresetActive", [id], `preset ${id} active`),
    multicallRead(FOUR_REGISTRY_ADDRESS, FOUR_REGISTRY_INTERFACE, "isPresetCreateEnabled", [id], `preset ${id} createEnabled`),
  ]);
  const presetResults = presetReads.length > 0
    ? await executeFourRegistryMulticall(provider, presetReads, block.number)
    : [];
  const inventory = {};
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const preset = normalizePreset(presetResults[index * 3]?.[0], id);
    const active = presetResults[index * 3 + 1]?.[0];
    const createEnabled = presetResults[index * 3 + 2]?.[0];
    if (typeof active !== "boolean" || typeof createEnabled !== "boolean"
      || preset.active !== active || preset.createEnabled !== createEnabled) {
      throw fourError("FOUR_REGISTRY_STATUS_MISMATCH", `preset ${id} tuple and status getters disagree at block ${block.number}`);
    }
    inventory[id] = preset;
  }
  return {
    identity: {
      chainId: FOUR_REGISTRY_CHAIN_ID,
      registry: FOUR_REGISTRY_ADDRESS,
      core: FOUR_CORE_ADDRESS,
      block: clone(block),
      registryCodeHash: runtime.registryCodeHash,
      coreCodeHash: runtime.coreCodeHash,
    },
    inventory,
  };
}

async function readFourRegistryTupleInventory(provider, blockNumber) {
  const ids = await readFourRegistryPresetIds(provider, blockNumber);
  const records = new Array(ids.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(INVENTORY_READ_CONCURRENCY, ids.length) }, async () => {
    while (nextIndex < ids.length) {
      const index = nextIndex;
      nextIndex += 1;
      // The tuple already includes both status bits. Two fixed state hosts
      // must agree on the complete tuple below; the dedicated status getters
      // remain an additional baseline/event-position identity check.
      records[index] = await readFourRegistryPresetTuple(provider, ids[index], blockNumber);
    }
  }));
  return Object.fromEntries(records.map((preset) => [preset.id, preset]));
}

function logIndex(log) {
  return integer(log?.index ?? log?.logIndex, "log.index");
}

function logPosition(log) {
  return {
    blockNumber: integer(log.blockNumber, "log.blockNumber"),
    transactionIndex: integer(log.transactionIndex, "log.transactionIndex"),
    logIndex: logIndex(log),
    blockHash: hash32(log.blockHash, "log.blockHash"),
  };
}

function comparePosition(left, right) {
  return left.blockNumber - right.blockNumber
    || left.transactionIndex - right.transactionIndex
    || left.logIndex - right.logIndex;
}

function sameLog(left, right) {
  if (!left || !right) return false;
  const leftTopics = (left.topics || []).map((item) => String(item).toLowerCase());
  const rightTopics = (right.topics || []).map((item) => String(item).toLowerCase());
  return address(left.address, "receipt.log.address") === address(right.address, "log.address")
    && String(left.data || "0x").toLowerCase() === String(right.data || "0x").toLowerCase()
    && logIndex(left) === logIndex(right)
    && leftTopics.length === rightTopics.length
    && leftTopics.every((topic, index) => topic === rightTopics[index]);
}

function canonicalLogMaterial(log) {
  const material = {
    address: address(log?.address, "canonical log.address"),
    topics: Array.isArray(log?.topics)
      ? log.topics.map((topic, index) => hash32(topic, `canonical log.topics[${index}]`))
      : (() => { throw fourError("FOUR_REGISTRY_LOG_QUERY_INVALID", "canonical log topics are missing"); })(),
    data: String(log?.data || "").toLowerCase(),
  };
  if (material.topics.length === 0 || !/^0x(?:[a-f0-9]{2})*$/u.test(material.data)) {
    throw fourError("FOUR_REGISTRY_LOG_QUERY_INVALID", "canonical log payload is malformed");
  }
  return {
    ...material,
    payloadHash: keccak256(toUtf8Bytes(JSON.stringify(material))).toLowerCase(),
  };
}

async function verifyCanonicalLog(provider, log, expectedAddress, allowedTopics, fromBlock, toBlock) {
  if (log?.removed === true || address(log?.address, "log.address") !== expectedAddress) {
    throw fourError("FOUR_REGISTRY_LOG_SOURCE_MISMATCH", "event came from an unexpected or removed log");
  }
  const topic0 = hash32(log?.topics?.[0], "log.topic0");
  if (!allowedTopics.has(topic0)) throw fourError("FOUR_REGISTRY_LOG_TOPIC_INVALID", "event topic is not allowlisted");
  const position = logPosition(log);
  if (position.blockNumber < fromBlock || position.blockNumber > toBlock) {
    throw fourError("FOUR_REGISTRY_LOG_RANGE_INVALID", "RPC returned an event outside the requested finalized range");
  }
  const transactionHash = hash32(log.transactionHash, "log.transactionHash");
  let receipt;
  let block;
  let transaction;
  try {
    [receipt, block, transaction] = await Promise.all([
      exactTransactionReceipt(provider, transactionHash),
      exactBlock(provider, position.blockNumber),
      exactTransaction(provider, transactionHash),
    ]);
  } catch (error) {
    throw fourError("FOUR_REGISTRY_LOG_PROOF_UNAVAILABLE", `canonical proof failed for ${transactionHash}: ${error.message}`, error);
  }
  const canonicalBlock = blockRecord(block, position.blockNumber, "event block");
  const receiptTransactionHash = receipt?.hash ?? receipt?.transactionHash ?? null;
  const receiptTransactionIndex = receipt?.index ?? receipt?.transactionIndex ?? null;
  const transactionIndex = transaction?.index ?? transaction?.transactionIndex ?? null;
  if (Number(receipt?.status) !== 1
    || integer(receipt?.blockNumber, "receipt.blockNumber") !== position.blockNumber
    || hash32(receipt?.blockHash, "receipt.blockHash") !== position.blockHash
    || canonicalBlock.hash !== position.blockHash
    || integer(transaction?.blockNumber, "transaction.blockNumber") !== position.blockNumber
    || hash32(transaction?.blockHash, "transaction.blockHash") !== position.blockHash
    || hash32(transaction?.hash ?? transactionHash, "transaction.hash") !== transactionHash
    || (receiptTransactionHash !== null
      && hash32(receiptTransactionHash, "receipt.transactionHash") !== transactionHash)
    || (receiptTransactionIndex !== null
      && integer(receiptTransactionIndex, "receipt.transactionIndex") !== position.transactionIndex)
    || (transactionIndex !== null
      && integer(transactionIndex, "transaction.transactionIndex") !== position.transactionIndex)
    || !(receipt?.logs || []).some((candidate) => sameLog(candidate, log))) {
    throw fourError("FOUR_REGISTRY_LOG_NOT_CANONICAL", `event ${transactionHash}:${position.logIndex} failed canonical receipt/block/transaction binding`);
  }
  return {
    ...position,
    transactionHash,
    topic0,
    blockTimestamp: iso(canonicalBlock.timestamp * 1_000),
    canonicalLog: canonicalLogMaterial(log),
  };
}

function parseRegistryLog(log, proof) {
  let parsed;
  try { parsed = FOUR_REGISTRY_INTERFACE.parseLog(log); }
  catch (error) { throw fourError("FOUR_REGISTRY_LOG_DECODE_FAILED", `Registry log could not be decoded: ${error.message}`, error); }
  if (!parsed || ![
    "PresetUpserted",
    "PresetActiveUpdated",
    "PresetCreateEnabledUpdated",
    "ModuleUpserted",
    "TokenImplUpserted",
    "TagRegistered",
  ].includes(parsed.name)) {
    throw fourError("FOUR_REGISTRY_LOG_DECODE_FAILED", "Registry log decoded to an unsupported event");
  }
  if (parsed.name === "ModuleUpserted") {
    return {
      eventName: parsed.name,
      subjectType: "module",
      subjectKey: hash32(parsed.args.moduleKey, "ModuleUpserted.moduleKey"),
      record: {
        moduleKey: hash32(parsed.args.moduleKey, "ModuleUpserted.moduleKey"),
        beacon: address(parsed.args.beacon, "ModuleUpserted.beacon"),
        implementation: address(parsed.args.implementation, "ModuleUpserted.implementation"),
        kind: moduleKind(parsed.args.kind, "ModuleUpserted.kind"),
        kindName: MODULE_KIND_NAMES[moduleKind(parsed.args.kind, "ModuleUpserted.kind")] || "unknown_numeric_kind",
        active: boolean(parsed.args.active, "ModuleUpserted.active"),
      },
      proof,
    };
  }
  if (parsed.name === "TokenImplUpserted") {
    const version = onchainTextProof(parsed.args.version, "TokenImplUpserted.version", 80);
    return {
      eventName: parsed.name,
      subjectType: "token-impl",
      subjectKey: hash32(parsed.args.tokenImplId, "TokenImplUpserted.tokenImplId"),
      record: {
        tokenImplId: hash32(parsed.args.tokenImplId, "TokenImplUpserted.tokenImplId"),
        implementation: address(parsed.args.implementation, "TokenImplUpserted.implementation"),
        version: version.value,
        versionProof: version.proof,
      },
      proof,
    };
  }
  if (parsed.name === "TagRegistered") {
    const tag = onchainTextProof(parsed.args.tag, "TagRegistered.tag", 256);
    return {
      eventName: parsed.name,
      subjectType: "tag",
      subjectKey: bytes8(parsed.args.tagId, "TagRegistered.tagId"),
      record: {
        tagId: bytes8(parsed.args.tagId, "TagRegistered.tagId"),
        tag: tag.value,
        tagProof: tag.proof,
      },
      proof,
    };
  }
  return {
    eventName: parsed.name,
    presetId: uintString(parsed.args.presetId, `${parsed.name}.presetId`),
    active: parsed.name === "PresetUpserted" || parsed.name === "PresetActiveUpdated" ? Boolean(parsed.args.active) : null,
    createEnabled: parsed.name === "PresetUpserted" || parsed.name === "PresetCreateEnabledUpdated"
      ? Boolean(parsed.args.createEnabled)
      : null,
    proof,
  };
}

async function attachProtocolRuntimeProof(stateVerificationProviders, registryEvent) {
  if (registryEvent.eventName === "ModuleUpserted") {
    const [implementationRuntime, beaconRuntime] = await Promise.all([
      consensusRuntimeCodeAt(
        stateVerificationProviders,
        registryEvent.record.implementation,
        registryEvent.proof.blockNumber,
        "ModuleUpserted implementation",
      ),
      consensusRuntimeCodeAt(
        stateVerificationProviders,
        registryEvent.record.beacon,
        registryEvent.proof.blockNumber,
        "ModuleUpserted beacon",
      ),
    ]);
    // The official public integration interface exposes this governance event
    // but not the production Registry write invariants. A zero/empty runtime is
    // therefore reported as evidence, not used to wedge the cursor forever.
    registryEvent.record.implementationCodePresent = implementationRuntime.present;
    registryEvent.record.implementationCodeHash = implementationRuntime.codeHash;
    registryEvent.record.beaconCodePresent = beaconRuntime.present;
    registryEvent.record.beaconCodeHash = beaconRuntime.codeHash;
  } else if (registryEvent.eventName === "TokenImplUpserted") {
    const runtime = await consensusRuntimeCodeAt(
      stateVerificationProviders,
      registryEvent.record.implementation,
      registryEvent.proof.blockNumber,
      "TokenImplUpserted implementation",
    );
    registryEvent.record.implementationCodePresent = runtime.present;
    registryEvent.record.implementationCodeHash = runtime.codeHash;
  }
  return registryEvent;
}

function parseTokenCreatedLog(log, proof) {
  let parsed;
  try { parsed = FOUR_CORE_INTERFACE.parseLog(log); }
  catch (error) { throw fourError("FOUR_TOKEN_CREATED_DECODE_FAILED", `TokenCreated log could not be decoded: ${error.message}`, error); }
  if (!parsed || parsed.name !== "TokenCreated") throw fourError("FOUR_TOKEN_CREATED_DECODE_FAILED", "Core log is not TokenCreated");
  const name = onchainTextProof(parsed.args.name, "TokenCreated.name", 160);
  const symbol = onchainTextProof(parsed.args.symbol, "TokenCreated.symbol", 80);
  const tokenMetaUri = onchainTextProof(parsed.args.tokenMetaUri, "TokenCreated.tokenMetaUri", 2_000);
  return {
    requestId: uintString(parsed.args.requestId, "TokenCreated.requestId"),
    presetId: uintString(parsed.args.presetId, "TokenCreated.presetId"),
    creator: address(parsed.args.creator, "TokenCreated.creator"),
    token: address(parsed.args.token, "TokenCreated.token"),
    name: name.value,
    symbol: symbol.value,
    maxSupply: uintString(parsed.args.maxSupply, "TokenCreated.maxSupply"),
    saleAmount: uintString(parsed.args.saleAmount, "TokenCreated.saleAmount"),
    raiseAmount: uintString(parsed.args.raiseAmount, "TokenCreated.raiseAmount"),
    initialPrice: uintString(parsed.args.initialPrice, "TokenCreated.initialPrice"),
    quoteAsset: address(parsed.args.quoteAsset, "TokenCreated.quoteAsset"),
    vault: address(parsed.args.vault, "TokenCreated.vault"),
    curveModule: address(parsed.args.curveModule, "TokenCreated.curveModule"),
    tradeModule: address(parsed.args.tradeModule, "TokenCreated.tradeModule"),
    migrateModule: address(parsed.args.migrateModule, "TokenCreated.migrateModule"),
    customData: address(parsed.args.customData, "TokenCreated.customData"),
    tokenModule: address(parsed.args.tokenModule, "TokenCreated.tokenModule"),
    tokenMetaUri: tokenMetaUri.value,
    metadataTruncated: {
      name: name.proof.truncated,
      symbol: symbol.proof.truncated,
      tokenMetaUri: tokenMetaUri.proof.truncated,
    },
    metadataHashes: {
      name: name.proof.hash,
      symbol: symbol.proof.hash,
      tokenMetaUri: tokenMetaUri.proof.hash,
    },
    flags: uintString(parsed.args.flags, "TokenCreated.flags"),
    proof,
  };
}

function parseTokenCreatedIndex(log, proof) {
  if (!Array.isArray(log?.topics) || log.topics.length !== 4
    || hash32(log.topics[0], "TokenCreated.topic0") !== FOUR_TOKEN_CREATED_TOPIC) {
    throw fourError("FOUR_TOKEN_CREATED_DECODE_FAILED", "Core log does not have the official TokenCreated indexed layout");
  }
  return {
    presetId: uintString(BigInt(hash32(log.topics[1], "TokenCreated.presetId topic")), "TokenCreated.presetId"),
    creator: address(`0x${hash32(log.topics[2], "TokenCreated.creator topic").slice(-40)}`, "TokenCreated.creator"),
    token: address(`0x${hash32(log.topics[3], "TokenCreated.token topic").slice(-40)}`, "TokenCreated.token"),
    log,
    proof,
  };
}

function changedFields(previous, current) {
  if (!previous) return Object.keys(current).filter((key) => !["fingerprint", "canCreate", "validatorConfigured"].includes(key));
  return Object.keys(current).filter((key) => !["fingerprint", "canCreate", "validatorConfigured"].includes(key)
    && !exactData(current[key], previous[key]));
}

function attributedPresetChangedFields(previous, current, snapshotScope) {
  const rawFields = changedFields(previous, current);
  if (snapshotScope === PRESET_DIRECT_SNAPSHOT_SCOPE) {
    return rawFields.length > 0 ? rawFields : ["registryEvent"];
  }
  const statusFields = rawFields.filter((field) => field === "active" || field === "createEnabled");
  const metadataFields = rawFields.filter((field) => field !== "active" && field !== "createEnabled");
  if (snapshotScope === PRESET_DEFERRED_SNAPSHOT_SCOPE) {
    if (metadataFields.length > 0) {
      throw fourError(
        "FOUR_REGISTRY_PRESET_ATTRIBUTION_INVALID",
        "a deferred same-block preset event cannot claim block-end metadata",
      );
    }
    return statusFields.length > 0 ? statusFields : ["registryEvent"];
  }
  if (snapshotScope === PRESET_SETTLED_SNAPSHOT_SCOPE
    || snapshotScope === PRESET_UNATTRIBUTED_SNAPSHOT_SCOPE) {
    if (metadataFields.length > 0) statusFields.push(FOUR_REGISTRY_PRESET_BLOCK_END_METADATA_FIELD);
    return statusFields.length > 0 ? statusFields : ["registryEvent"];
  }
  throw fourError("FOUR_REGISTRY_PRESET_ATTRIBUTION_INVALID", `unknown preset snapshot scope ${String(snapshotScope)}`);
}

function evidenceForPreset(registryEvents, presetId, fields) {
  const candidates = registryEvents.filter((event) => event.presetId === presetId && (
    event.eventName === "PresetUpserted"
    || (event.eventName === "PresetActiveUpdated" && fields.includes("active"))
    || (event.eventName === "PresetCreateEnabledUpdated" && fields.includes("createEnabled"))
  ));
  return candidates.sort((left, right) => comparePosition(left.proof, right.proof)).at(-1) || null;
}

function sourceProof(proof, finalizedBlock, basis) {
  const blockNumber = proof?.blockNumber ?? finalizedBlock.number;
  const blockHash = proof?.blockHash ?? finalizedBlock.hash;
  const blockTimestamp = proof?.blockTimestamp ?? iso(finalizedBlock.timestamp * 1_000);
  return {
    basis,
    finality: "confirmed",
    canonical: true,
    blockNumber,
    blockHash,
    blockTimestamp,
    transactionHash: proof?.transactionHash || null,
    transactionIndex: proof?.transactionIndex ?? null,
    logIndex: proof?.logIndex ?? null,
    eventName: proof?.eventName || null,
    confirmationsApplied: null,
    explorerUrl: proof?.transactionHash
      ? `https://bscscan.com/tx/${proof.transactionHash}`
      : `https://bscscan.com/block/${blockNumber}`,
    canonicalLog: clone(proof?.canonicalLog),
  };
}

function capabilityClassification(previous, current) {
  if (!previous) return { kind: "four_registry_preset_added", changeType: "added", stage: "preset_added" };
  if (!previous.active && current.active) {
    return { kind: "four_registry_preset_activated", changeType: "activated", stage: "preset_activated" };
  }
  if (previous.active && !current.active) {
    return { kind: "four_registry_preset_deactivated", changeType: "deactivated", stage: "preset_deactivated" };
  }
  if (!previous.createEnabled && current.createEnabled) {
    return { kind: "four_registry_preset_create_enabled", changeType: "create_enabled", stage: "preset_create_enabled" };
  }
  if (previous.createEnabled && !current.createEnabled) {
    return { kind: "four_registry_preset_create_disabled", changeType: "create_disabled", stage: "preset_create_disabled" };
  }
  return { kind: "four_registry_preset_updated", changeType: "updated", stage: "preset_updated" };
}

function fixedNoTradeBoundary(value) {
  return value?.informationalOnly === true
    && value?.autoTradeEligible === false
    && value?.automaticExecution === false
    && value?.trading?.automaticExecution === false
    && value?.security?.status === "unknown"
    && value?.security?.decision === "unknown";
}

function fixedFourIdentity(value) {
  return Number(value?.chainId) === FOUR_REGISTRY_CHAIN_ID
    && address(value?.registry, "event.registry") === FOUR_REGISTRY_ADDRESS
    && address(value?.core, "event.core") === FOUR_CORE_ADDRESS
    && address(value?.launcher, "event.launcher") === FOUR_CORE_ADDRESS
    && value?.platform?.id === "fourmeme"
    && value?.chain?.environment === "mainnet";
}

function lifecyclePresetId(value) {
  const match = /^fourmeme:openfour:preset:(0|[1-9]\d*):generation:(0x[a-f0-9]{64}):(0|[1-9]\d*)$/u.exec(String(value || ""));
  return match?.[1] || null;
}

function normalizeCapabilitySubjectKey(subjectType, value, label) {
  if (subjectType === "preset") return uintString(value, label);
  if (["module", "token-impl"].includes(subjectType)) return hash32(value, label);
  if (subjectType === "tag") return bytes8(value, label);
  throw fourError("FOUR_REGISTRY_SUBJECT_INVALID", `${label} has an unsupported subject type`);
}

function capabilitySubjectType(kind, eventType = FOUR_REGISTRY_CAPABILITY_EVENT_TYPE) {
  if (eventType === FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE && kind === FOUR_REGISTRY_FIRST_TOKEN_KIND) return "preset";
  if (FOUR_REGISTRY_PRESET_CAPABILITY_KINDS.includes(kind)) return "preset";
  if (kind === "four_registry_module_upserted") return "module";
  if (kind === "four_registry_token_impl_upserted") return "token-impl";
  if (kind === "four_registry_tag_registered") return "tag";
  return null;
}

function capabilityLifecycleSubject(value) {
  const presetId = lifecyclePresetId(value);
  if (presetId !== null) return { type: "preset", key: presetId };
  const match = /^fourmeme:openfour:(module|token-impl|tag):(0x[a-f0-9]+):generation:(0x[a-f0-9]{64}):(0|[1-9]\d*)$/u.exec(String(value || ""));
  if (!match) return null;
  try {
    return { type: match[1], key: normalizeCapabilitySubjectKey(match[1], match[2], "lifecycle subject") };
  } catch {
    return null;
  }
}

function capabilityEventSubject(value) {
  const type = capabilitySubjectType(value?.kind, value?.type);
  if (!type) throw fourError("FOUR_REGISTRY_SUBJECT_INVALID", "event kind has no capability subject");
  const candidate = value?.subject?.id
    ?? (type === "preset" ? value?.presetId
      : type === "module" ? value?.module?.moduleKey
        : type === "token-impl" ? value?.tokenImplementation?.tokenImplId
          : value?.tag?.tagId);
  return { type, key: normalizeCapabilitySubjectKey(type, candidate, "event subject") };
}

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function exactData(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => exactData(item, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return exactData(leftKeys, rightKeys) && leftKeys.every((key) => exactData(left[key], right[key]));
}

// This is discovery/order evidence, never a safety verdict or execution grant.
// Governance toggles and cosmetic text do not create another three-token slot.
const MECHANISM_PRESET_FIELDS = Object.freeze([
  "id", "version", "validator", "tokenModuleId", "vaultModuleId", "curveModuleId",
  "tradeModuleId", "migrateModuleId", "tokenImplId", "customDataId",
]);
const MODULE_PRESET_FIELDS = Object.freeze([
  "tokenModuleId", "vaultModuleId", "curveModuleId", "tradeModuleId", "migrateModuleId", "customDataId",
]);
const TRACKING_RECORD_KEYS = ["generationKey", "presetId", "preset", "revisionEvents", "activationEvent", "presetBinding", "suppressed", "tokens"];
const TRACKED_EVENT_KEYS = ["featureTrackedToken", "featureTokenOrdinal", "featureTokenTarget", "featureTokenProof"];

function emptyMechanismTracking() {
  return { version: 1, revisions: {}, generations: {}, active: {} };
}

function mechanismPreset(preset) {
  return Object.fromEntries(MECHANISM_PRESET_FIELDS.map((key) => [key, preset[key]]));
}

function revisionIdentity(event) {
  return `${event.subject.type}:${event.subject.id}`;
}

function revisionBindsPreset(event, preset) {
  if (event.kind === "four_registry_module_upserted") {
    const field = MODULE_PRESET_FIELDS[event.module.kind];
    return Boolean(field && preset[field] === event.module.moduleKey);
  }
  return event.kind === "four_registry_token_impl_upserted"
    && preset.tokenImplId === event.tokenImplementation.tokenImplId;
}

function presetReferencesRevision(event, preset) {
  return event.kind === "four_registry_module_upserted"
    ? MODULE_PRESET_FIELDS.some((field) => preset[field] === event.module.moduleKey)
    : event.kind === "four_registry_token_impl_upserted" && preset.tokenImplId === event.tokenImplementation.tokenImplId;
}

function mechanismRevisionMaterial(event) {
  if (event.kind === "four_registry_module_upserted") {
    const { active, ...module } = event.module;
    return { key: revisionIdentity(event), module };
  }
  return { key: revisionIdentity(event), tokenImplementation: event.tokenImplementation };
}

function mechanismGenerationKey(preset, revisionEvents) {
  const hash = keccak256(toUtf8Bytes(JSON.stringify({
    preset: mechanismPreset(preset),
    revisions: revisionEvents.map(mechanismRevisionMaterial),
  }))).toLowerCase();
  return `fourmeme:openfour:preset:${preset.id}:mechanism:${hash}`;
}

function seedMechanismTracking(presets) {
  const tracking = emptyMechanismTracking();
  for (const preset of Object.values(presets)) {
    const generationKey = mechanismGenerationKey(preset, []);
    tracking.generations[generationKey] = {
      generationKey, presetId: preset.id, preset: clone(preset), revisionEvents: [],
      activationEvent: null, presetBinding: null, suppressed: true, tokens: [],
    };
  }
  return tracking;
}

function trackingToken(evidence, token) {
  return { token, evidence: clone(evidence) };
}

function validTrackingToken(value, presetId) {
  if (!hasExactKeys(value, ["token", "evidence"])) return false;
  const evidence = value.evidence;
  const decoded = parseTokenCreatedLog(evidence?.canonicalLog, {});
  return decoded.presetId === presetId && decoded.token === value.token
    && exactEvidence({ ...evidence, evidence, url: evidence.explorerUrl,
      sourceOccurredAt: evidence.blockTimestamp }, "canonical_token_created_after_capability", "TokenCreated");
}

function validMechanismRecord(record, expectedKey) {
  if (!hasExactKeys(record, TRACKING_RECORD_KEYS)
    || record.generationKey !== expectedKey
    || typeof record.suppressed !== "boolean"
    || !Array.isArray(record.revisionEvents) || record.revisionEvents.length > 7
    || !Array.isArray(record.tokens) || record.tokens.length > FOUR_REGISTRY_TRACKED_TOKEN_TARGET) return false;
  const preset = exactPreset(record.preset, record.presetId);
  if (!preset || preset.id !== record.presetId) return false;
  const revisionKeys = record.revisionEvents.map(revisionIdentity);
  if (new Set(revisionKeys).size !== revisionKeys.length
    || !exactData(revisionKeys, [...revisionKeys].sort())
    || record.revisionEvents.some((event) => !isFourRegistryProtocolCapabilityEvent(event) || !revisionBindsPreset(event, preset))
    || mechanismGenerationKey(preset, record.revisionEvents) !== expectedKey) return false;
  if (record.suppressed) return record.activationEvent === null && record.presetBinding === null && record.tokens.length === 0;
  const activation = record.activationEvent, binding = record.presetBinding;
  if (!isFourRegistryCapabilityEvent(activation)
    || !preset.canCreate
    || !hasExactKeys(binding, ["scope", "blockNumber", "blockHash", "preset"])
    || binding.blockNumber !== activation.blockNumber || binding.blockHash !== activation.blockHash
    || !exactData(binding.preset, preset)) return false;
  if (FOUR_REGISTRY_PRESET_CAPABILITY_KINDS.includes(activation.kind)) {
    if (activation.presetId !== preset.id || activation.snapshotScope !== PRESET_DIRECT_SNAPSHOT_SCOPE
      || binding.scope !== "canonical_single_preset_event"
      || !exactData(activation.currentPreset, preset)) return false;
  } else if (!revisionBindsPreset(activation, preset)
    || binding.scope !== "canonical_preset_unchanged_within_event_block"
    || !record.revisionEvents.some((event) => exactData(event, activation))) return false;
  if (record.revisionEvents.some((event) => comparePosition(event, activation) > 0)) return false;
  let previous = activation;
  const seen = new Set();
  for (const token of record.tokens) {
    if (!validTrackingToken(token, preset.id) || seen.has(token.token)
      || comparePosition(token.evidence, previous) <= 0) return false;
    seen.add(token.token);
    previous = token.evidence;
  }
  return true;
}

function normalizeMechanismTracking(raw, checkpointBlock = null) {
  if (!hasExactKeys(raw, ["version", "revisions", "generations", "active"]) || raw.version !== 1
    || [raw.revisions, raw.generations, raw.active].some((value) => !value || typeof value !== "object" || Array.isArray(value))
    || Object.keys(raw.generations).length > 2_000) throw fourError("FOUR_REGISTRY_TRACKING_INVALID", "mechanism tracking schema/capacity is invalid");
  for (const [key, event] of Object.entries(raw.revisions)) {
    if (!isFourRegistryProtocolCapabilityEvent(event) || !["module", "token-impl"].includes(event.subject.type)
      || revisionIdentity(event) !== key || checkpointBlock !== null && event.blockNumber > checkpointBlock) {
      throw fourError("FOUR_REGISTRY_TRACKING_INVALID", "mechanism revision lacks canonical Registry evidence");
    }
  }
  for (const [key, record] of Object.entries(raw.generations)) {
    if (!validMechanismRecord(record, key)
      || checkpointBlock !== null && [record.activationEvent, ...record.tokens.map((token) => token.evidence)]
        .filter(Boolean).some((event) => event.blockNumber > checkpointBlock)) {
      throw fourError("FOUR_REGISTRY_TRACKING_INVALID", "mechanism generation/order proof is invalid");
    }
  }
  for (const [presetId, key] of Object.entries(raw.active)) {
    if (raw.generations[key]?.presetId !== presetId || raw.generations[key].suppressed) {
      throw fourError("FOUR_REGISTRY_TRACKING_INVALID", "active mechanism does not bind its generation");
    }
  }
  return clone(raw);
}

function mechanismCheckpoint(tracking) {
  return { version: 2, revisions: clone(tracking.revisions),
    generationCounts: Object.fromEntries(Object.entries(tracking.generations).map(([key, record]) => [key, record.tokens.length])),
    active: clone(tracking.active) };
}

function restoreMechanismCheckpoint(snapshot, owner) {
  if (!hasExactKeys(snapshot, ["version", "revisions", "generationCounts", "active"]) || snapshot.version !== 2
    || !snapshot.generationCounts || typeof snapshot.generationCounts !== "object" || Array.isArray(snapshot.generationCounts)) {
    throw fourError("FOUR_REGISTRY_TRACKING_INVALID", "compact mechanism checkpoint is invalid");
  }
  const generations = {};
  for (const [key, count] of Object.entries(snapshot.generationCounts)) {
    const record = owner.generations[key];
    if (!record || !Number.isSafeInteger(count) || count < 0 || count > record.tokens.length) {
      throw fourError("FOUR_REGISTRY_TRACKING_INVALID", "checkpoint lost immutable generation/order proof");
    }
    generations[key] = { ...clone(record), tokens: clone(record.tokens.slice(0, count)) };
  }
  return { version: 1, revisions: clone(snapshot.revisions), generations, active: clone(snapshot.active) };
}

function validateMechanismCheckpoint(snapshot, owner, checkpointBlock) {
  normalizeMechanismTracking(restoreMechanismCheckpoint(snapshot, owner), checkpointBlock);
  return clone(snapshot);
}

function activateMechanism(tracking, preset, activationEvent, scope) {
  if (!preset.canCreate) { delete tracking.active[preset.id]; return; }
  const revisionEvents = Object.values(tracking.revisions).filter((event) => presetReferencesRevision(event, preset))
    .sort((left, right) => revisionIdentity(left).localeCompare(revisionIdentity(right)));
  if (revisionEvents.some((event) => !revisionBindsPreset(event, preset)
    || event.module && (!event.module.active || !event.module.implementationCodePresent || !event.module.beaconCodePresent)
    || event.tokenImplementation && !event.tokenImplementation.implementationCodePresent)) {
    delete tracking.active[preset.id];
    return;
  }
  const generationKey = mechanismGenerationKey(preset, revisionEvents);
  const existing = tracking.generations[generationKey];
  if (existing) {
    if (existing.suppressed || existing.tokens.length >= FOUR_REGISTRY_TRACKED_TOKEN_TARGET) delete tracking.active[preset.id];
    else tracking.active[preset.id] = generationKey;
    return;
  }
  if (Object.keys(tracking.generations).length >= 2_000) throw fourError("FOUR_REGISTRY_TRACKING_FULL", "mechanism history is full; refusing to erase consumed slots");
  const record = { generationKey, presetId: preset.id, preset: clone(preset), revisionEvents: clone(revisionEvents),
    activationEvent: clone(activationEvent), presetBinding: { scope, blockNumber: activationEvent.blockNumber,
      blockHash: activationEvent.blockHash, preset: clone(preset) }, suppressed: false, tokens: [] };
  if (!validMechanismRecord(record, generationKey)) throw fourError("FOUR_REGISTRY_TRACKING_INVALID", "new mechanism activation proof is invalid");
  tracking.generations[generationKey] = record;
  tracking.active[preset.id] = generationKey;
}

function trackedTokenProof(record) {
  return { version: FOUR_REGISTRY_TRACKED_TOKEN_VERSION, target: FOUR_REGISTRY_TRACKED_TOKEN_TARGET,
    generationKey: record.generationKey, activationEvent: clone(record.activationEvent),
    presetBinding: clone(record.presetBinding), revisionEvents: clone(record.revisionEvents),
    ordering: "canonical_block_transaction_log_unique_ca", priorTokens: clone(record.tokens),
    contiguousFromBlock: record.activationEvent.blockNumber };
}

function validTrackedTokenProof(event) {
  const proof = event.featureTokenProof;
  if (!hasExactKeys(proof, ["version", "target", "generationKey", "activationEvent", "presetBinding", "revisionEvents", "ordering", "priorTokens", "contiguousFromBlock"])
    || proof.version !== FOUR_REGISTRY_TRACKED_TOKEN_VERSION || proof.target !== FOUR_REGISTRY_TRACKED_TOKEN_TARGET
    || proof.ordering !== "canonical_block_transaction_log_unique_ca"
    || !Array.isArray(proof.priorTokens) || proof.priorTokens.length >= FOUR_REGISTRY_TRACKED_TOKEN_TARGET
    || event.featureTrackedToken !== true || event.featureTokenTarget !== FOUR_REGISTRY_TRACKED_TOKEN_TARGET
    || event.featureTokenOrdinal !== proof.priorTokens.length + 1
    || event.featureGenerationKey !== proof.generationKey
    || proof.contiguousFromBlock !== proof.activationEvent?.blockNumber
    || event.capabilityEventKey !== proof.activationEvent?.eventKey
    || event.lifecycleKey !== `fourmeme:openfour:preset:${event.presetId}:generation:${proof.activationEvent?.transactionHash}:${proof.activationEvent?.logIndex}`
    || !exactData(mechanismPreset(event.preset), mechanismPreset(proof.presetBinding?.preset || {}))) return false;
  return validMechanismRecord({ generationKey: proof.generationKey, presetId: event.presetId,
    preset: proof.presetBinding.preset, revisionEvents: proof.revisionEvents, activationEvent: proof.activationEvent,
    presetBinding: proof.presetBinding, suppressed: false,
    tokens: [...proof.priorTokens, trackingToken(event.evidence, event.token.address)] }, proof.generationKey);
}

const PRESET_KEYS = Object.freeze([
  "id", "name", "description", "version", "textProof", "active", "createEnabled", "validator",
  "tokenModuleId", "vaultModuleId", "curveModuleId", "tradeModuleId", "migrateModuleId",
  "tokenImplId", "customDataId", "author", "canCreate", "validatorConfigured", "fingerprint",
]);
const EVIDENCE_KEYS = Object.freeze([
  "basis", "finality", "canonical", "blockNumber", "blockHash", "blockTimestamp",
  "transactionHash", "transactionIndex", "logIndex", "eventName", "confirmationsApplied", "explorerUrl", "canonicalLog",
]);
const DELIVERY_POLICY_KEYS = Object.freeze([
  "tier", "mode", "noChase", "automaticExecution", "durableRetry", "ttlExemptAfterFirstObserved", "firstObservedAt",
]);
const DELAYED_RECOVERY_KEYS = Object.freeze([
  "version", "reason", "sourceOccurredAt", "firstObservedAt", "recoveredAt", "lagMs", "continuousCoverage",
  "baselineBlock", "priorAnchorBlock", "priorAnchorBlockHash", "scanFromBlock", "scanThroughBlock",
  "eventBlockNumber", "eventBlockHash",
]);
const PRESET_EVENT_KEYS = Object.freeze([
  "schemaVersion", "type", "kind", "changeType", "eventKey", "lifecycleKey", "lifecycleStage", "lifecycle",
  "subject", "official", "strong", "informationalOnly", "autoTradeEligible", "automaticExecution", "chainId",
  "chain", "platform", "registry", "core", "launcher", "presetId", "previousPreset", "currentPreset",
  "changedFields", "changes", "mode", "transition", "evidence", "transactionHash", "transactionIndex", "logIndex",
  "blockNumber", "blockHash", "blockTimestamp", "sourceOccurredAt", "snapshotScope", "tokens", "pools",
  "structural", "source", "sourceUrl", "url", "explorerUrl", "security", "trading", "deliveryPolicy",
  "observedAt", "deliveryEvidenceDigest", "payloadDigest",
]);
const PROTOCOL_EVENT_KEYS = Object.freeze([
  "schemaVersion", "type", "kind", "changeType", "registryEventName", "eventKey", "lifecycleKey", "lifecycleStage",
  "lifecycle", "noveltyKey", "subject", "official", "strong", "informationalOnly", "autoTradeEligible",
  "automaticExecution", "chainId", "chain", "platform", "registry", "core", "launcher", "previous", "changedFields",
  "changes", "evidence", "transactionHash", "transactionIndex", "logIndex", "blockNumber", "blockHash",
  "blockTimestamp", "sourceOccurredAt", "tokens", "pools", "structural", "signal", "source", "sourceUrl", "url",
  "explorerUrl", "security", "trading", "deliveryPolicy", "observedAt", "deliveryEvidenceDigest", "payloadDigest",
]);
const FIRST_TOKEN_EVENT_KEYS = Object.freeze([
  "schemaVersion", "type", "kind", "eventKey", "lifecycleKey", "lifecycleStage", "lifecycle", "subject", "official",
  "strong", "informationalOnly", "autoTradeEligible", "automaticExecution", "featurePlatform", "featureActivationKey",
  "featureGenerationKey", "featureFirstToken", "officialFirstToken", "chainId", "chain", "platform", "registry", "core",
  "launcher", "presetId", "capabilityEventKey", "preset", "mode", "token", "tokens", "pools", "launchCount",
  "uniqueTokens", "evidence", "transactionHash", "transactionIndex", "logIndex", "blockNumber", "blockHash",
  "blockTimestamp", "sourceOccurredAt", "presetSnapshotScope", "canonicalTokenCreatedKey", "structural", "source", "sourceUrl", "url",
  "explorerUrl", "security", "trading", "deliveryPolicy", "observedAt", "deliveryEvidenceDigest", "payloadDigest",
]);

function exactPreset(value, expectedId) {
  if (!hasExactKeys(value, PRESET_KEYS)) return null;
  const normalized = normalizePreset(value, expectedId);
  return exactData(value, normalized) ? normalized : null;
}

function exactCommonIdentity(value) {
  return value.registry === FOUR_REGISTRY_ADDRESS
    && value.core === FOUR_CORE_ADDRESS
    && value.launcher === FOUR_CORE_ADDRESS
    && value.chainId === FOUR_REGISTRY_CHAIN_ID
    && hasExactKeys(value.chain, ["id", "chainId", "name", "environment"])
    && exactData(value.chain, { id: 56, chainId: 56, name: "BNB Chain", environment: "mainnet" })
    && hasExactKeys(value.platform, ["id", "name", "website", "trust"])
    && exactData(value.platform, {
      id: "fourmeme",
      name: "Four.Meme / OpenFour",
      website: "https://four.meme",
      trust: "official_onchain",
    });
}

function exactNoTrade(value, reason) {
  return value.official === true
    && value.strong === true
    && value.informationalOnly === true
    && value.autoTradeEligible === false
    && value.automaticExecution === false
    && hasExactKeys(value.security, ["status", "decision", "reason"])
    && exactData(value.security, { status: "unknown", decision: "unknown", reason })
    && hasExactKeys(value.trading, ["decision", "automaticExecution", "security"])
    && exactData(value.trading, { decision: "watch_only", automaticExecution: false, security: "unknown" });
}

function exactEvidence(value, basis, eventName) {
  const evidence = value.evidence;
  if (!hasExactKeys(evidence, EVIDENCE_KEYS)) return false;
  const txUrl = `https://bscscan.com/tx/${value.transactionHash}`;
  const expectedAddress = basis === "canonical_token_created_after_capability"
    ? FOUR_CORE_ADDRESS
    : FOUR_REGISTRY_ADDRESS;
  const canonicalLog = canonicalLogMaterial(evidence.canonicalLog);
  return evidence.basis === basis
    && evidence.finality === "confirmed"
    && evidence.canonical === true
    && evidence.eventName === eventName
    && evidence.transactionHash === value.transactionHash
    && evidence.transactionIndex === value.transactionIndex
    && evidence.logIndex === value.logIndex
    && evidence.blockNumber === value.blockNumber
    && evidence.blockHash === value.blockHash
    && evidence.blockTimestamp === value.blockTimestamp
    && evidence.explorerUrl === txUrl
    && exactData(evidence.canonicalLog, canonicalLog)
    && canonicalLog.address === expectedAddress
    && canonicalLog.topics[0] === (basis === "canonical_token_created_after_capability"
      ? FOUR_TOKEN_CREATED_TOPIC
      : FOUR_REGISTRY_INTERFACE.getEvent(eventName).topicHash.toLowerCase())
    && value.url === txUrl
    && value.explorerUrl === txUrl
    && value.sourceOccurredAt === value.blockTimestamp
    && hash32(value.transactionHash, "event.transactionHash") === value.transactionHash
    && hash32(value.blockHash, "event.blockHash") === value.blockHash
    && integer(value.transactionIndex, "event.transactionIndex") === value.transactionIndex
    && integer(value.logIndex, "event.logIndex") === value.logIndex
    && integer(value.blockNumber, "event.blockNumber") === value.blockNumber
    && integer(evidence.confirmationsApplied, "evidence.confirmationsApplied", 1) === evidence.confirmationsApplied
    && exactIso(value.blockTimestamp, "event.blockTimestamp") === value.blockTimestamp;
}

function eventDeliveryEvidenceDigest(value) {
  const material = {
    type: value.type,
    kind: value.kind,
    eventKey: value.eventKey,
    transactionHash: value.transactionHash,
    logIndex: value.logIndex,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    blockTimestamp: value.blockTimestamp,
    sourceOccurredAt: value.sourceOccurredAt,
    observedAt: value.observedAt,
    deliveryPolicy: value.deliveryPolicy,
    delayedRecovery: value.delayedRecovery || null,
  };
  return keccak256(toUtf8Bytes(JSON.stringify(material))).toLowerCase();
}

function exactDeliveryRecovery(value, freshTier) {
  const observedMs = Date.parse(exactIso(value.observedAt, "event.observedAt"));
  const sourceMs = Date.parse(exactIso(value.blockTimestamp, "event.blockTimestamp"));
  const lagMs = observedMs - sourceMs;
  const delayed = lagMs > FOUR_REGISTRY_DEFAULT_DELAYED_RECOVERY_MS;
  const expectedTier = delayed || Object.hasOwn(value, "canonicalRevision") ? "T2" : freshTier;
  if (lagMs < -120_000
    || !hasExactKeys(value.deliveryPolicy, DELIVERY_POLICY_KEYS)
    || !exactData(value.deliveryPolicy, {
      tier: expectedTier,
      mode: "immediate_monitor_only",
      noChase: true,
      automaticExecution: false,
      durableRetry: true,
      ttlExemptAfterFirstObserved: true,
      firstObservedAt: value.observedAt,
    })) return false;
  const recoveryValid = !delayed
    ? !Object.hasOwn(value, "delayedRecovery")
    : (() => {
        const recovery = value.delayedRecovery;
        return hasExactKeys(recovery, DELAYED_RECOVERY_KEYS)
          && recovery.version === 1
          && recovery.reason === "verified_contiguous_registry_cursor_catch_up"
          && recovery.sourceOccurredAt === value.blockTimestamp
          && recovery.firstObservedAt === value.observedAt
          && recovery.recoveredAt === value.observedAt
          && recovery.lagMs === lagMs
          && recovery.continuousCoverage === true
          && integer(recovery.baselineBlock, "delayedRecovery.baselineBlock") === recovery.baselineBlock
          && integer(recovery.priorAnchorBlock, "delayedRecovery.priorAnchorBlock") === recovery.priorAnchorBlock
          && hash32(recovery.priorAnchorBlockHash, "delayedRecovery.priorAnchorBlockHash") === recovery.priorAnchorBlockHash
          && integer(recovery.scanFromBlock, "delayedRecovery.scanFromBlock") === recovery.scanFromBlock
          && integer(recovery.scanThroughBlock, "delayedRecovery.scanThroughBlock") === recovery.scanThroughBlock
          && integer(recovery.eventBlockNumber, "delayedRecovery.eventBlockNumber") === recovery.eventBlockNumber
          && hash32(recovery.eventBlockHash, "delayedRecovery.eventBlockHash") === recovery.eventBlockHash
          && recovery.baselineBlock <= recovery.priorAnchorBlock
          && recovery.scanFromBlock === recovery.priorAnchorBlock + 1
          && recovery.scanThroughBlock >= recovery.scanFromBlock
          && recovery.eventBlockNumber >= recovery.scanFromBlock
          && recovery.eventBlockNumber <= recovery.scanThroughBlock
          && recovery.eventBlockNumber === value.blockNumber
          && recovery.eventBlockHash === value.blockHash;
      })();
  return recoveryValid
    && hash32(value.deliveryEvidenceDigest, "event.deliveryEvidenceDigest") === eventDeliveryEvidenceDigest(value);
}

function exactCanonicalRevisionEnvelope(value, baseEventKey) {
  if (!Object.hasOwn(value, "canonicalRevision")) return value.eventKey === baseEventKey;
  const baseProjection = clone(value);
  delete baseProjection.canonicalRevision;
  delete baseProjection.canonicalRestoration;
  delete baseProjection.canonicalSupersession;
  baseProjection.eventKey = baseEventKey;
  const currentBasePayloadDigest = eventPayloadDigest(baseProjection);
  const normalized = normalizeCanonicalRevision(value.canonicalRevision, {
    baseEventKey,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    transactionHash: value.transactionHash,
    logIndex: value.logIndex,
    observedOrAcceptedAt: value.observedAt,
  });
  return exactData(value.canonicalRevision, normalized)
    && normalized.currentBasePayloadDigest === currentBasePayloadDigest
    && value.eventKey === `${baseEventKey}:canonical-revision:${value.blockHash}:${normalized.recoveryEpoch}`;
}

function exactCanonicalRestorationEnvelope(value, baseEventKey) {
  const envelope = value.canonicalRestoration;
  if (!hasExactKeys(envelope, CANONICAL_RESTORATION_KEYS)) return false;
  const baseProjection = clone(value);
  delete baseProjection.canonicalRestoration;
  baseProjection.eventKey = baseEventKey;
  const basePayloadDigest = eventPayloadDigest(baseProjection);
  return envelope.version === 1
    && envelope.reason === "original_block_recanonicalized"
    && envelope.cancelledEventId === value.eventKey
    && hash32(envelope.blockHash, "canonicalRestoration.blockHash") === value.blockHash
    && hash32(envelope.payloadDigest, "canonicalRestoration.payloadDigest") === basePayloadDigest
    && exactIso(envelope.detectedAt, "canonicalRestoration.detectedAt") === envelope.detectedAt
    && Date.parse(envelope.detectedAt) <= Date.parse(value.observedAt)
    && value.eventKey === baseEventKey;
}

function exactCanonicalSupersessionEnvelope(value, baseEventKey) {
  const envelope = value.canonicalSupersession;
  if (!hasExactKeys(envelope, CANONICAL_SUPERSESSION_KEYS)) return false;
  const baseProjection = clone(value);
  delete baseProjection.canonicalSupersession;
  delete baseProjection.canonicalRestoration;
  delete baseProjection.canonicalRevision;
  baseProjection.eventKey = baseEventKey;
  const basePayloadDigest = eventPayloadDigest(baseProjection);
  return envelope.version === 1
    && envelope.reason === "undelivered_canonical_proof_superseded"
    && envelope.baseEventKey === baseEventKey
    && envelope.currentBasePayloadDigest === basePayloadDigest
    && envelope.cancelledEventId === baseEventKey
    && envelope.cancelledBaseEventKey === baseEventKey
    && hash32(envelope.cancelledBlockHash, "canonicalSupersession.cancelledBlockHash") === envelope.cancelledBlockHash
    && hash32(envelope.cancelledPayloadDigest, "canonicalSupersession.cancelledPayloadDigest") === envelope.cancelledPayloadDigest
    && hash32(envelope.transactionHash, "canonicalSupersession.transactionHash") === value.transactionHash
    && integer(envelope.logIndex, "canonicalSupersession.logIndex") === value.logIndex
    && hash32(envelope.newBlockHash, "canonicalSupersession.newBlockHash") === value.blockHash
    && envelope.cancelledBlockHash !== envelope.newBlockHash
    && exactIso(envelope.detectedAt, "canonicalSupersession.detectedAt") === envelope.detectedAt
    && Date.parse(envelope.detectedAt) <= Date.parse(value.observedAt)
    && value.eventKey === baseEventKey;
}

function exactCanonicalReorgEnvelope(value, baseEventKey) {
  const primary = ["canonicalRevision", "canonicalSupersession"]
    .filter((key) => Object.hasOwn(value, key));
  if (primary.length > 1) return false;
  const primaryValid = primary.length === 0
    ? value.eventKey === baseEventKey
    : primary[0] === "canonicalRevision"
      ? exactCanonicalRevisionEnvelope(value, baseEventKey)
      : exactCanonicalSupersessionEnvelope(value, baseEventKey);
  return primaryValid
    && (!Object.hasOwn(value, "canonicalRestoration") || exactCanonicalRestorationEnvelope(value, baseEventKey));
}

function exactRegistrySource(value, structuralSource, securityReason) {
  return hasExactKeys(value.source, ["id", "name", "kind", "url", "trust", "official"])
    && exactData(value.source, {
      id: FOUR_REGISTRY_SOURCE_ID,
      name: "OpenFour on-chain Registry",
      kind: "official_onchain_registry",
      url: FOUR_REGISTRY_SOURCE_URL,
      trust: "official_verified",
      official: true,
    })
    && value.sourceUrl === FOUR_REGISTRY_SOURCE_URL
    && hasExactKeys(value.structural, ["eligible", "source", "canonical", "finalized"])
    && exactData(value.structural, { eligible: true, source: structuralSource, canonical: true, finalized: true })
    && exactNoTrade(value, securityReason);
}

function expectedPresetLifecycleParts(value) {
  return /^fourmeme:openfour:preset:(0|[1-9]\d*):generation:(0x[a-f0-9]{64}):(0|[1-9]\d*)$/u.exec(String(value || ""));
}

function validPresetCapabilityPayload(value) {
  const presetId = uintString(value.presetId, "event.presetId");
  const current = exactPreset(value.currentPreset, presetId);
  const previous = value.previousPreset === null ? null : exactPreset(value.previousPreset, presetId);
  if (!current || (!previous && value.previousPreset !== null)) return false;
  const decodedLog = FOUR_REGISTRY_INTERFACE.parseLog(value.evidence?.canonicalLog);
  if (!decodedLog
    || decodedLog.name !== value.evidence?.eventName
    || uintString(decodedLog.args.presetId, "event log.presetId") !== presetId
    || (["PresetUpserted", "PresetActiveUpdated"].includes(decodedLog.name)
      && boolean(decodedLog.args.active, "event log.active") !== current.active)
    || (["PresetUpserted", "PresetCreateEnabledUpdated"].includes(decodedLog.name)
      && boolean(decodedLog.args.createEnabled, "event log.createEnabled") !== current.createEnabled)) return false;
  const classification = capabilityClassification(previous, current);
  const expectedFields = attributedPresetChangedFields(previous, current, value.snapshotScope);
  const lifecycleKey = `fourmeme:openfour:preset:${presetId}:generation:${value.transactionHash}:${value.logIndex}`;
  const eventKey = `four-registry:${FOUR_REGISTRY_CHAIN_ID}:${value.transactionHash}:${value.logIndex}:${classification.changeType}`;
  const statusChange = {
    presetId,
    active: previous ? { before: previous.active, after: current.active } : { before: null, after: current.active },
    createEnabled: previous
      ? { before: previous.createEnabled, after: current.createEnabled }
      : { before: null, after: current.createEnabled },
    canCreate: previous ? { before: previous.canCreate, after: current.canCreate } : { before: null, after: current.canCreate },
  };
  const expectedChanges = {
    newPresets: previous ? [] : [current],
    updatedPresets: previous ? [{ presetId, before: previous, after: current, changedFields: expectedFields }] : [],
    removedPresets: [],
    presetStatusChanges: [statusChange],
  };
  const expectedMode = {
    selector: "openfour-registry-preset",
    presetId,
    name: current.name,
    version: current.version,
    active: current.active,
    createEnabled: current.createEnabled,
  };
  const expectedTransition = {
    active: previous ? { from: previous.active, to: current.active } : { from: null, to: current.active },
    createEnabled: previous ? { from: previous.createEnabled, to: current.createEnabled } : { from: null, to: current.createEnabled },
    canCreate: previous ? { from: previous.canCreate, to: current.canCreate } : { from: null, to: current.canCreate },
  };
  return value.kind === classification.kind
    && value.changeType === classification.changeType
    && value.lifecycleStage === classification.stage
    && exactCanonicalReorgEnvelope(value, eventKey)
    && value.lifecycleKey === lifecycleKey
    && hasExactKeys(value.lifecycle, ["key", "product", "stage"])
    && exactData(value.lifecycle, { key: lifecycleKey, product: "openfour-preset", stage: classification.stage })
    && hasExactKeys(value.subject, ["type", "id"])
    && exactData(value.subject, { type: "preset", id: presetId })
    && exactData(value.changedFields, expectedFields)
    && hasExactKeys(value.changes, ["newPresets", "updatedPresets", "removedPresets", "presetStatusChanges"])
    && exactData(value.changes, expectedChanges)
    && hasExactKeys(value.mode, ["selector", "presetId", "name", "version", "active", "createEnabled"])
    && exactData(value.mode, expectedMode)
    && hasExactKeys(value.transition, ["active", "createEnabled", "canCreate"])
    && exactData(value.transition, expectedTransition)
    && FOUR_REGISTRY_PRESET_SNAPSHOT_SCOPES.includes(value.snapshotScope)
    && ["PresetUpserted", "PresetActiveUpdated", "PresetCreateEnabledUpdated"].includes(value.evidence?.eventName)
    && exactEvidence(value, "canonical_registry_event_and_finalized_block_snapshot", value.evidence.eventName)
    && Array.isArray(value.tokens) && value.tokens.length === 0
    && Array.isArray(value.pools) && value.pools.length === 0
    && exactRegistrySource(
      value,
      "official_onchain_registry",
      "Official Registry state proves capability provenance, not token or module safety",
    )
    && exactDeliveryRecovery(value, "T1")
    && hash32(value.payloadDigest, "event.payloadDigest") === eventPayloadDigest(value);
}

function exactRuntimeProof(target, present, codeHash) {
  const normalizedTarget = address(target, "runtime target");
  return typeof present === "boolean"
    && (present ? hash32(codeHash, "runtime codeHash") === codeHash : codeHash === null)
    && (normalizedTarget !== ZERO_ADDRESS || (present === false && codeHash === null));
}

function exactPersistedTextProof(value, proof, label, maximum) {
  const normalized = onchainTextProof(value, label, maximum, proof);
  return normalized.value === value && exactData(normalized.proof, proof);
}

function validProtocolCapabilityPayload(value, subject) {
  const detail = Object.entries(PROTOCOL_CAPABILITY_BY_EVENT)
    .find(([, candidate]) => candidate.kind === value.kind);
  if (!detail) return false;
  const [eventName, contract] = detail;
  if (contract.subjectType !== subject.type) return false;
  const expectedLifecycle = `fourmeme:openfour:${subject.type}:${subject.key}:generation:${value.transactionHash}:${value.logIndex}`;
  const expectedEventKey = `four-registry:${FOUR_REGISTRY_CHAIN_ID}:${value.transactionHash}:${value.logIndex}:${contract.changeType}`;
  const payloadKey = subject.type === "module" ? "module" : subject.type === "token-impl" ? "tokenImplementation" : "tag";
  const record = value[payloadKey];
  const decodedLog = parseRegistryLog(value.evidence?.canonicalLog, {});
  const expectedRootKeys = [
    ...PROTOCOL_EVENT_KEYS,
    payloadKey,
    ...(value.delayedRecovery ? ["delayedRecovery"] : []),
    ...(value.canonicalRevision ? ["canonicalRevision"] : []),
    ...(value.canonicalRestoration ? ["canonicalRestoration"] : []),
    ...(value.canonicalSupersession ? ["canonicalSupersession"] : []),
  ];
  if (!hasExactKeys(value, expectedRootKeys)
    || value.registryEventName !== eventName
    || decodedLog.eventName !== eventName
    || decodedLog.subjectType !== subject.type
    || decodedLog.subjectKey !== subject.key
    || value.changeType !== contract.changeType
    || value.lifecycleStage !== contract.stage
    || !exactCanonicalReorgEnvelope(value, expectedEventKey)
    || value.lifecycleKey !== expectedLifecycle
    || value.noveltyKey !== expectedLifecycle
    || !hasExactKeys(value.lifecycle, ["key", "product", "stage"])
    || !exactData(value.lifecycle, { key: expectedLifecycle, product: contract.product, stage: contract.stage })
    || !hasExactKeys(value.subject, ["type", "id"])
    || !exactData(value.subject, { type: subject.type, id: subject.key })
    || value.previous !== null
    || !hasExactKeys(value.changes, [contract.changesKey])
    || !Array.isArray(value.changes[contract.changesKey])
    || value.changes[contract.changesKey].length !== 1
    || !exactData(value.changes[contract.changesKey][0], record)
    || !exactEvidence(value, "canonical_registry_event", eventName)
    || !Array.isArray(value.tokens) || value.tokens.length !== 0
    || !Array.isArray(value.pools) || value.pools.length !== 0
    || !exactRegistrySource(value, "official_onchain_registry", "Official Registry provenance does not prove module or token safety")
    || !exactDeliveryRecovery(value, "T1")) return false;
  let expectedChangedFields;
  let expectedHeadline;
  if (subject.type === "module") {
    if (!hasExactKeys(record, [
      "moduleKey", "beacon", "implementation", "kind", "kindName", "active", "implementationCodePresent",
      "implementationCodeHash", "beaconCodePresent", "beaconCodeHash",
    ])
      || hash32(record.moduleKey, "module.moduleKey") !== subject.key
      || address(record.beacon, "module.beacon") !== record.beacon
      || address(record.implementation, "module.implementation") !== record.implementation
      || moduleKind(record.kind, "module.kind") !== record.kind
      || record.kindName !== (MODULE_KIND_NAMES[record.kind] || "unknown_numeric_kind")
      || boolean(record.active, "module.active") !== record.active
      || !exactData(decodedLog.record, {
        moduleKey: record.moduleKey,
        beacon: record.beacon,
        implementation: record.implementation,
        kind: record.kind,
        kindName: record.kindName,
        active: record.active,
      })
      || !exactRuntimeProof(record.implementation, record.implementationCodePresent, record.implementationCodeHash)
      || !exactRuntimeProof(record.beacon, record.beaconCodePresent, record.beaconCodeHash)) return false;
    expectedChangedFields = ["beacon", "implementation", "kind", "active"];
    expectedHeadline = `OpenFour Registry upserted module ${subject.key}`;
  } else if (subject.type === "token-impl") {
    if (!hasExactKeys(record, ["tokenImplId", "implementation", "version", "versionProof", "implementationCodePresent", "implementationCodeHash"])
      || hash32(record.tokenImplId, "tokenImplementation.tokenImplId") !== subject.key
      || address(record.implementation, "tokenImplementation.implementation") !== record.implementation
      || !exactData(decodedLog.record, {
        tokenImplId: record.tokenImplId,
        implementation: record.implementation,
        version: record.version,
        versionProof: record.versionProof,
      })
      || !exactPersistedTextProof(record.version, record.versionProof, "tokenImplementation.version", 80)
      || !exactRuntimeProof(record.implementation, record.implementationCodePresent, record.implementationCodeHash)) return false;
    expectedChangedFields = ["implementation", "version"];
    expectedHeadline = `OpenFour Registry upserted token implementation ${subject.key}`;
  } else {
    if (!hasExactKeys(record, ["tagId", "tag", "tagProof"])
      || bytes8(record.tagId, "tag.tagId") !== subject.key
      || !exactData(decodedLog.record, record)
      || !exactPersistedTextProof(record.tag, record.tagProof, "tag.tag", 256)) return false;
    expectedChangedFields = ["tag"];
    expectedHeadline = `OpenFour Registry registered tag ${record.tag}`;
  }
  return exactData(value.changedFields, expectedChangedFields)
    && hasExactKeys(value.signal, ["strong", "platformStructural", "category", "headline"])
    && exactData(value.signal, {
      strong: true,
      platformStructural: true,
      category: "OpenFour Registry structural capability",
      headline: expectedHeadline,
    })
    && hash32(value.payloadDigest, "event.payloadDigest") === eventPayloadDigest(value);
}

/** Strict raw producer contract. Pipeline-derived alert fields must be
 * validated separately, removed, and only then passed to this validator. */
export function isFourRegistryCapabilityEvent(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== FOUR_REGISTRY_EVENT_SCHEMA_VERSION
      || value.type !== FOUR_REGISTRY_CAPABILITY_EVENT_TYPE
      || !FOUR_REGISTRY_CAPABILITY_KINDS.includes(value.kind)
      || !exactCommonIdentity(value)) return false;
    const subject = capabilityEventSubject(value);
    const lifecycleSubject = capabilityLifecycleSubject(value.lifecycleKey);
    if (!lifecycleSubject || lifecycleSubject.type !== subject.type || lifecycleSubject.key !== subject.key) return false;
    if (subject.type === "preset") {
      const rootKeys = [
        ...PRESET_EVENT_KEYS,
        ...(value.delayedRecovery ? ["delayedRecovery"] : []),
        ...(value.canonicalRevision ? ["canonicalRevision"] : []),
        ...(value.canonicalRestoration ? ["canonicalRestoration"] : []),
        ...(value.canonicalSupersession ? ["canonicalSupersession"] : []),
      ];
      return hasExactKeys(value, rootKeys) && validPresetCapabilityPayload(value);
    }
    return validProtocolCapabilityPayload(value, subject);
  } catch { return false; }
}

export function isFourRegistryProtocolCapabilityEvent(value) {
  return FOUR_REGISTRY_PROTOCOL_CAPABILITY_KINDS.includes(value?.kind)
    && isFourRegistryCapabilityEvent(value);
}

function exactTokenPayload(value) {
  const keys = [
    "token", "address", "creator", "requestId", "name", "symbol", "maxSupply", "saleAmount", "raiseAmount",
    "initialPrice", "quoteAsset", "vault", "curveModule", "tradeModule", "migrateModule", "customData", "tokenModule",
    "tokenMetaUri", "metadataTruncated", "metadataHashes", "flags",
  ];
  if (!hasExactKeys(value, keys)
    || address(value.token, "token.token") !== value.token
    || value.address !== value.token
    || value.token === ZERO_ADDRESS
    || address(value.creator, "token.creator") !== value.creator
    || address(value.quoteAsset, "token.quoteAsset") !== value.quoteAsset
    || !["vault", "curveModule", "tradeModule", "migrateModule", "customData", "tokenModule"]
      .every((key) => address(value[key], `token.${key}`) === value[key])
    || !["requestId", "maxSupply", "saleAmount", "raiseAmount", "initialPrice", "flags"]
      .every((key) => uintString(value[key], `token.${key}`) === value[key])
    || boundedText(value.name, "token.name", 160) !== value.name
    || boundedText(value.symbol, "token.symbol", 80) !== value.symbol
    || boundedText(value.tokenMetaUri, "token.tokenMetaUri", 2_000) !== value.tokenMetaUri
    || !hasExactKeys(value.metadataTruncated, ["name", "symbol", "tokenMetaUri"])
    || !hasExactKeys(value.metadataHashes, ["name", "symbol", "tokenMetaUri"])
    || !["name", "symbol", "tokenMetaUri"].every((key) => typeof value.metadataTruncated[key] === "boolean"
      && exactPersistedTextProof(value[key], {
        hash: value.metadataHashes[key],
        truncated: value.metadataTruncated[key],
      }, `token.${key}`, key === "name" ? 160 : key === "symbol" ? 80 : 2_000))) return false;
  return true;
}

export function isFourRegistryFirstTokenEvent(value) {
  try {
    const tracked = TRACKED_EVENT_KEYS.some((key) => Object.hasOwn(value || {}, key));
    const rootKeys = [
      ...FIRST_TOKEN_EVENT_KEYS,
      ...(tracked ? TRACKED_EVENT_KEYS : []),
      ...(value?.delayedRecovery ? ["delayedRecovery"] : []),
      ...(value?.canonicalRevision ? ["canonicalRevision"] : []),
      ...(value?.canonicalRestoration ? ["canonicalRestoration"] : []),
      ...(value?.canonicalSupersession ? ["canonicalSupersession"] : []),
    ];
    if (!hasExactKeys(value, rootKeys)
      || value.schemaVersion !== FOUR_REGISTRY_EVENT_SCHEMA_VERSION
      || value.type !== FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE
      || value.kind !== FOUR_REGISTRY_FIRST_TOKEN_KIND
      || !exactCommonIdentity(value)) return false;
    const presetId = uintString(value.presetId, "event.presetId");
    const preset = exactPreset(value.preset, presetId);
    if (!preset
      || !preset.canCreate
      || !FOUR_REGISTRY_PRESET_SNAPSHOT_SCOPES.includes(value.presetSnapshotScope)
      || !exactTokenPayload(value.token)) return false;
    const decodedCreated = parseTokenCreatedLog(value.evidence?.canonicalLog, {});
    if (decodedCreated.presetId !== presetId
      || !exactData(tokenPayloadFromCreated(decodedCreated), value.token)) return false;
    const lifecycle = expectedPresetLifecycleParts(value.lifecycleKey);
    const capability = parseCapabilityOwnerKey(value.capabilityEventKey);
    const expectedTxUrl = `https://bscscan.com/tx/${value.transactionHash}`;
    const expectedCanonicalKey = `fourmeme:openfour-core-token-created:${FOUR_REGISTRY_CHAIN_ID}:${value.transactionHash}:${value.logIndex}:${value.token.address}`;
    const expectedMode = {
      selector: "openfour-registry-preset",
      presetId,
      name: preset.name,
      version: preset.version,
      active: preset.active,
      createEnabled: preset.createEnabled,
    };
    return lifecycle?.[1] === presetId
      && capability?.[1] === lifecycle?.[2]
      && capability?.[2] === lifecycle?.[3]
      && exactCanonicalReorgEnvelope(
        value,
        `four-registry:${FOUR_REGISTRY_CHAIN_ID}:${value.transactionHash}:${value.logIndex}:token-confirmation`,
      )
      && value.lifecycleStage === "first_token_confirmed"
      && hasExactKeys(value.lifecycle, ["key", "product", "stage"])
      && exactData(value.lifecycle, { key: value.lifecycleKey, product: "openfour-preset", stage: "first_token_confirmed" })
      && hasExactKeys(value.subject, ["type", "id"])
      && exactData(value.subject, { type: "preset", id: presetId })
      && value.featurePlatform === "fourmeme"
      && value.featureActivationKey === value.lifecycleKey
      && (tracked ? validTrackedTokenProof(value) : value.featureGenerationKey === value.lifecycleKey)
      && value.featureFirstToken === (!tracked || value.featureTokenOrdinal === 1)
      && value.officialFirstToken === (!tracked || value.featureTokenOrdinal === 1)
      && hasExactKeys(value.mode, ["selector", "presetId", "name", "version", "active", "createEnabled"])
      && exactData(value.mode, expectedMode)
      && Array.isArray(value.tokens) && value.tokens.length === 1 && exactData(value.tokens[0], value.token)
      && Array.isArray(value.pools) && value.pools.length === 0
      && value.launchCount === 1 && value.uniqueTokens === 1
      && exactEvidence(value, "canonical_token_created_after_capability", "TokenCreated")
      && value.canonicalTokenCreatedKey === expectedCanonicalKey
      && hasExactKeys(value.structural, ["eligible", "source", "canonical", "finalized"])
      && exactData(value.structural, { eligible: true, source: "official_onchain_core", canonical: true, finalized: true })
      && hasExactKeys(value.source, ["id", "name", "kind", "url", "trust", "official"])
      && exactData(value.source, {
        id: FOUR_CORE_SOURCE_ID,
        name: "OpenFour on-chain Core",
        kind: "official_onchain_core",
        url: expectedTxUrl,
        trust: "official_verified",
        official: true,
      })
      && value.sourceUrl === expectedTxUrl
      && exactNoTrade(value, "TokenCreated confirms provenance only; it is not a contract safety verdict")
      && exactDeliveryRecovery(value, "T2")
      && hash32(value.payloadDigest, "event.payloadDigest") === eventPayloadDigest(value);
  } catch { return false; }
}

export function isFourRegistryTrackedTokenEvent(value) {
  return value?.featureTrackedToken === true && isFourRegistryFirstTokenEvent(value);
}

export function fourRegistryEventSupersedesTrackedToken(capability, tokenEvent) {
  if (!isFourRegistryCapabilityEvent(capability) || !isFourRegistryTrackedTokenEvent(tokenEvent)
    || comparePosition(capability, tokenEvent) <= 0) return false;
  const preset = tokenEvent.featureTokenProof.presetBinding.preset;
  if (FOUR_REGISTRY_PRESET_CAPABILITY_KINDS.includes(capability.kind)) {
    return capability.presetId === preset.id && (!capability.currentPreset.canCreate
      || !exactData(mechanismPreset(capability.currentPreset), mechanismPreset(preset)));
  }
  if (!presetReferencesRevision(capability, preset)) return false;
  if (!revisionBindsPreset(capability, preset)) return true; // Known key, unrecognised/inconsistent kind: observe only.
  const previous = tokenEvent.featureTokenProof.revisionEvents.find(event => revisionIdentity(event) === revisionIdentity(capability));
  return capability.module?.active === false || !previous
    || !exactData(mechanismRevisionMaterial(previous), mechanismRevisionMaterial(capability));
}

function deliveryRecoveryFields(blockTimestamp, observedAt, coverageProof, freshTier) {
  const lagMs = Date.parse(observedAt) - Date.parse(blockTimestamp);
  const delayed = Number.isSafeInteger(lagMs) && lagMs > FOUR_REGISTRY_DEFAULT_DELAYED_RECOVERY_MS;
  const deliveryPolicy = {
    tier: delayed ? "T2" : freshTier,
    mode: "immediate_monitor_only",
    noChase: true,
    automaticExecution: false,
    durableRetry: true,
    ttlExemptAfterFirstObserved: true,
    firstObservedAt: observedAt,
  };
  if (!delayed) return { deliveryPolicy };
  return {
    deliveryPolicy,
    delayedRecovery: {
      version: 1,
      reason: "verified_contiguous_registry_cursor_catch_up",
      sourceOccurredAt: blockTimestamp,
      firstObservedAt: observedAt,
      recoveredAt: observedAt,
      lagMs,
      continuousCoverage: true,
      baselineBlock: coverageProof.baselineBlock,
      priorAnchorBlock: coverageProof.priorAnchorBlock,
      priorAnchorBlockHash: coverageProof.priorAnchorBlockHash,
      scanFromBlock: coverageProof.scanFromBlock,
      scanThroughBlock: coverageProof.scanThroughBlock,
      eventBlockNumber: coverageProof.eventBlockNumber,
      eventBlockHash: coverageProof.eventBlockHash,
    },
  };
}

function eventPayloadDigest(value) {
  const coordinates = {
    transactionHash: value.transactionHash,
    transactionIndex: value.transactionIndex,
    logIndex: value.logIndex,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    blockTimestamp: value.blockTimestamp,
  };
  const canonicalRevision = value.canonicalRevision || null;
  const canonicalRestoration = value.canonicalRestoration || null;
  const canonicalSupersession = value.canonicalSupersession || null;
  let material;
  if (value.type === FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE) {
    material = {
      type: value.type,
      kind: value.kind,
      eventKey: value.eventKey,
      lifecycleKey: value.lifecycleKey,
      presetId: value.presetId,
      capabilityEventKey: value.capabilityEventKey,
      preset: value.preset,
      presetSnapshotScope: value.presetSnapshotScope,
      token: value.token,
      ...(value.featureTrackedToken === true ? { tracked: Object.fromEntries([
        ...TRACKED_EVENT_KEYS, "featureGenerationKey", "featureFirstToken", "officialFirstToken",
      ].map((key) => [key, value[key]])) } : {}),
      coordinates,
      canonicalRevision,
      canonicalRestoration,
      canonicalSupersession,
    };
  } else if (FOUR_REGISTRY_PRESET_CAPABILITY_KINDS.includes(value.kind)) {
    material = {
      type: value.type,
      kind: value.kind,
      changeType: value.changeType,
      eventKey: value.eventKey,
      lifecycleKey: value.lifecycleKey,
      presetId: value.presetId,
      previousPreset: value.previousPreset,
      currentPreset: value.currentPreset,
      changedFields: value.changedFields,
      snapshotScope: value.snapshotScope,
      coordinates,
      canonicalRevision,
      canonicalRestoration,
      canonicalSupersession,
    };
  } else {
    const payload = value.module ?? value.tokenImplementation ?? value.tag;
    material = {
      type: value.type,
      kind: value.kind,
      changeType: value.changeType,
      registryEventName: value.registryEventName,
      eventKey: value.eventKey,
      lifecycleKey: value.lifecycleKey,
      subject: value.subject,
      payload,
      coordinates,
      canonicalRevision,
      canonicalRestoration,
      canonicalSupersession,
    };
  }
  return keccak256(toUtf8Bytes(JSON.stringify(material))).toLowerCase();
}

function finalizeEventDigests(event) {
  event.deliveryEvidenceDigest = eventDeliveryEvidenceDigest(event);
  event.payloadDigest = eventPayloadDigest(event);
  return event;
}

function capabilityEvent(
  previous,
  current,
  fields,
  registryEvent,
  finalizedBlock,
  observedAt,
  confirmations,
  coverageProof,
  snapshotScope = PRESET_DIRECT_SNAPSHOT_SCOPE,
) {
  if (!registryEvent) {
    throw fourError("FOUR_REGISTRY_LOG_CONSENSUS_INCOMPLETE", `preset ${current.id} has no canonical Registry event position`);
  }
  const proof = { ...registryEvent.proof, eventName: registryEvent.eventName };
  const evidence = sourceProof(proof, finalizedBlock, "canonical_registry_event_and_finalized_block_snapshot");
  evidence.confirmationsApplied = confirmations;
  const classification = capabilityClassification(previous, current);
  const lifecycleKey = `fourmeme:openfour:preset:${current.id}:generation:${proof.transactionHash}:${proof.logIndex}`;
  const eventKey = `four-registry:${FOUR_REGISTRY_CHAIN_ID}:${proof.transactionHash}:${proof.logIndex}:${classification.changeType}`;
  const statusChange = {
    presetId: current.id,
    active: previous ? { before: previous.active, after: current.active } : { before: null, after: current.active },
    createEnabled: previous
      ? { before: previous.createEnabled, after: current.createEnabled }
      : { before: null, after: current.createEnabled },
    canCreate: previous ? { before: previous.canCreate, after: current.canCreate } : { before: null, after: current.canCreate },
  };
  const changes = {
    newPresets: previous ? [] : [clone(current)],
    updatedPresets: previous ? [{ presetId: current.id, before: clone(previous), after: clone(current), changedFields: [...fields] }] : [],
    // Deactivation is a status transition, not inventory deletion.
    removedPresets: [],
    presetStatusChanges: [statusChange],
  };
  const event = {
    schemaVersion: FOUR_REGISTRY_EVENT_SCHEMA_VERSION,
    type: FOUR_REGISTRY_CAPABILITY_EVENT_TYPE,
    kind: classification.kind,
    changeType: classification.changeType,
    eventKey,
    lifecycleKey,
    lifecycleStage: classification.stage,
    lifecycle: { key: lifecycleKey, product: "openfour-preset", stage: classification.stage },
    subject: { type: "preset", id: current.id },
    official: true,
    strong: true,
    informationalOnly: true,
    autoTradeEligible: false,
    automaticExecution: false,
    chainId: FOUR_REGISTRY_CHAIN_ID,
    chain: { id: FOUR_REGISTRY_CHAIN_ID, chainId: FOUR_REGISTRY_CHAIN_ID, name: "BNB Chain", environment: "mainnet" },
    platform: {
      id: "fourmeme",
      name: "Four.Meme / OpenFour",
      website: "https://four.meme",
      trust: "official_onchain",
    },
    registry: FOUR_REGISTRY_ADDRESS,
    core: FOUR_CORE_ADDRESS,
    launcher: FOUR_CORE_ADDRESS,
    presetId: current.id,
    previousPreset: previous ? clone(previous) : null,
    currentPreset: clone(current),
    changedFields: fields,
    changes,
    mode: {
      selector: "openfour-registry-preset",
      presetId: current.id,
      name: current.name,
      version: current.version,
      active: current.active,
      createEnabled: current.createEnabled,
    },
    transition: {
      active: previous ? { from: previous.active, to: current.active } : { from: null, to: current.active },
      createEnabled: previous ? { from: previous.createEnabled, to: current.createEnabled } : { from: null, to: current.createEnabled },
      canCreate: previous ? { from: previous.canCreate, to: current.canCreate } : { from: null, to: current.canCreate },
    },
    evidence,
    transactionHash: evidence.transactionHash,
    transactionIndex: evidence.transactionIndex,
    logIndex: evidence.logIndex,
    blockNumber: evidence.blockNumber,
    blockHash: evidence.blockHash,
    blockTimestamp: evidence.blockTimestamp,
    sourceOccurredAt: evidence.blockTimestamp,
    snapshotScope,
    tokens: [],
    pools: [],
    structural: { eligible: true, source: "official_onchain_registry", canonical: true, finalized: true },
    source: {
      id: FOUR_REGISTRY_SOURCE_ID,
      name: "OpenFour on-chain Registry",
      kind: "official_onchain_registry",
      url: FOUR_REGISTRY_SOURCE_URL,
      trust: "official_verified",
      official: true,
    },
    sourceUrl: FOUR_REGISTRY_SOURCE_URL,
    url: evidence.explorerUrl,
    explorerUrl: evidence.explorerUrl,
    security: {
      status: "unknown",
      decision: "unknown",
      reason: "Official Registry state proves capability provenance, not token or module safety",
    },
    trading: { decision: "watch_only", automaticExecution: false, security: "unknown" },
    ...deliveryRecoveryFields(evidence.blockTimestamp, observedAt, coverageProof, "T1"),
    observedAt,
  };
  return finalizeEventDigests(event);
}

function protocolCapabilityEvent(registryEvent, observedAt, confirmations, coverageProof) {
  const detail = PROTOCOL_CAPABILITY_BY_EVENT[registryEvent.eventName];
  if (!detail || registryEvent.subjectType !== detail.subjectType) {
    throw fourError("FOUR_REGISTRY_LOG_DECODE_FAILED", `unsupported protocol capability ${registryEvent.eventName}`);
  }
  const proof = { ...registryEvent.proof, eventName: registryEvent.eventName };
  const evidence = sourceProof(
    proof,
    { number: proof.blockNumber, hash: proof.blockHash },
    "canonical_registry_event",
  );
  evidence.confirmationsApplied = confirmations;
  const lifecycleKey = `fourmeme:openfour:${detail.subjectType}:${registryEvent.subjectKey}:generation:${proof.transactionHash}:${proof.logIndex}`;
  const eventKey = `four-registry:${FOUR_REGISTRY_CHAIN_ID}:${proof.transactionHash}:${proof.logIndex}:${detail.changeType}`;
  const record = clone(registryEvent.record);
  const changedFields = registryEvent.eventName === "ModuleUpserted"
    ? ["beacon", "implementation", "kind", "active"]
    : registryEvent.eventName === "TokenImplUpserted"
      ? ["implementation", "version"]
      : ["tag"];
  const payloadField = detail.subjectType === "module"
    ? "module"
    : detail.subjectType === "token-impl" ? "tokenImplementation" : "tag";
  const headline = registryEvent.eventName === "ModuleUpserted"
    ? `OpenFour Registry upserted module ${registryEvent.subjectKey}`
    : registryEvent.eventName === "TokenImplUpserted"
      ? `OpenFour Registry upserted token implementation ${registryEvent.subjectKey}`
      : `OpenFour Registry registered tag ${record.tag}`;
  const event = {
    schemaVersion: FOUR_REGISTRY_EVENT_SCHEMA_VERSION,
    type: FOUR_REGISTRY_CAPABILITY_EVENT_TYPE,
    kind: detail.kind,
    changeType: detail.changeType,
    registryEventName: registryEvent.eventName,
    eventKey,
    lifecycleKey,
    lifecycleStage: detail.stage,
    lifecycle: { key: lifecycleKey, product: detail.product, stage: detail.stage },
    noveltyKey: lifecycleKey,
    subject: { type: detail.subjectType, id: registryEvent.subjectKey },
    official: true,
    strong: true,
    informationalOnly: true,
    autoTradeEligible: false,
    automaticExecution: false,
    chainId: FOUR_REGISTRY_CHAIN_ID,
    chain: { id: FOUR_REGISTRY_CHAIN_ID, chainId: FOUR_REGISTRY_CHAIN_ID, name: "BNB Chain", environment: "mainnet" },
    platform: {
      id: "fourmeme",
      name: "Four.Meme / OpenFour",
      website: "https://four.meme",
      trust: "official_onchain",
    },
    registry: FOUR_REGISTRY_ADDRESS,
    core: FOUR_CORE_ADDRESS,
    launcher: FOUR_CORE_ADDRESS,
    [payloadField]: record,
    previous: null,
    changedFields,
    changes: { [detail.changesKey]: [clone(record)] },
    evidence,
    transactionHash: evidence.transactionHash,
    transactionIndex: evidence.transactionIndex,
    logIndex: evidence.logIndex,
    blockNumber: evidence.blockNumber,
    blockHash: evidence.blockHash,
    blockTimestamp: evidence.blockTimestamp,
    sourceOccurredAt: evidence.blockTimestamp,
    tokens: [],
    pools: [],
    structural: { eligible: true, source: "official_onchain_registry", canonical: true, finalized: true },
    signal: {
      strong: true,
      platformStructural: true,
      category: "OpenFour Registry structural capability",
      headline,
    },
    source: {
      id: FOUR_REGISTRY_SOURCE_ID,
      name: "OpenFour on-chain Registry",
      kind: "official_onchain_registry",
      url: FOUR_REGISTRY_SOURCE_URL,
      trust: "official_verified",
      official: true,
    },
    sourceUrl: FOUR_REGISTRY_SOURCE_URL,
    url: evidence.explorerUrl,
    explorerUrl: evidence.explorerUrl,
    security: {
      status: "unknown",
      decision: "unknown",
      reason: "Official Registry provenance does not prove module or token safety",
    },
    trading: { decision: "watch_only", automaticExecution: false, security: "unknown" },
    ...deliveryRecoveryFields(evidence.blockTimestamp, observedAt, coverageProof, "T1"),
    observedAt,
  };
  return finalizeEventDigests(event);
}

function tokenPayloadFromCreated(created) {
  return {
    token: created.token,
    address: created.token,
    creator: created.creator,
    requestId: created.requestId,
    name: created.name,
    symbol: created.symbol,
    maxSupply: created.maxSupply,
    saleAmount: created.saleAmount,
    raiseAmount: created.raiseAmount,
    initialPrice: created.initialPrice,
    quoteAsset: created.quoteAsset,
    vault: created.vault,
    curveModule: created.curveModule,
    tradeModule: created.tradeModule,
    migrateModule: created.migrateModule,
    customData: created.customData,
    tokenModule: created.tokenModule,
    tokenMetaUri: created.tokenMetaUri,
    metadataTruncated: clone(created.metadataTruncated),
    metadataHashes: clone(created.metadataHashes),
    flags: created.flags,
  };
}

function confirmationEvent(created, pending, preset, presetSnapshotScope, observedAt, confirmations, coverageProof, mechanism = null) {
  const eventKey = `four-registry:${FOUR_REGISTRY_CHAIN_ID}:${created.proof.transactionHash}:${created.proof.logIndex}:token-confirmation`;
  const evidence = sourceProof({ ...created.proof, eventName: "TokenCreated" }, { number: created.proof.blockNumber, hash: created.proof.blockHash }, "canonical_token_created_after_capability");
  evidence.confirmationsApplied = confirmations;
  const token = tokenPayloadFromCreated(created);
  const event = {
    schemaVersion: FOUR_REGISTRY_EVENT_SCHEMA_VERSION,
    type: FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE,
    kind: FOUR_REGISTRY_FIRST_TOKEN_KIND,
    eventKey,
    lifecycleKey: pending.lifecycleKey,
    lifecycleStage: "first_token_confirmed",
    lifecycle: { key: pending.lifecycleKey, product: "openfour-preset", stage: "first_token_confirmed" },
    subject: { type: "preset", id: created.presetId },
    official: true,
    strong: true,
    informationalOnly: true,
    autoTradeEligible: false,
    automaticExecution: false,
    featurePlatform: "fourmeme",
    featureActivationKey: pending.lifecycleKey,
    featureGenerationKey: mechanism?.generationKey || pending.lifecycleKey,
    featureFirstToken: !mechanism || mechanism.tokens.length === 0,
    officialFirstToken: !mechanism || mechanism.tokens.length === 0,
    ...(mechanism ? { featureTrackedToken: true, featureTokenOrdinal: mechanism.tokens.length + 1,
      featureTokenTarget: FOUR_REGISTRY_TRACKED_TOKEN_TARGET, featureTokenProof: trackedTokenProof(mechanism) } : {}),
    chainId: FOUR_REGISTRY_CHAIN_ID,
    chain: { id: FOUR_REGISTRY_CHAIN_ID, chainId: FOUR_REGISTRY_CHAIN_ID, name: "BNB Chain", environment: "mainnet" },
    platform: {
      id: "fourmeme",
      name: "Four.Meme / OpenFour",
      website: "https://four.meme",
      trust: "official_onchain",
    },
    registry: FOUR_REGISTRY_ADDRESS,
    core: FOUR_CORE_ADDRESS,
    launcher: FOUR_CORE_ADDRESS,
    presetId: created.presetId,
    capabilityEventKey: pending.capabilityEventKey,
    preset: clone(preset),
    presetSnapshotScope,
    mode: {
      selector: "openfour-registry-preset",
      presetId: created.presetId,
      name: preset.name,
      version: preset.version,
      active: preset.active,
      createEnabled: preset.createEnabled,
    },
    token,
    tokens: [token],
    pools: [],
    launchCount: 1,
    uniqueTokens: 1,
    evidence,
    transactionHash: evidence.transactionHash,
    transactionIndex: evidence.transactionIndex,
    logIndex: evidence.logIndex,
    blockNumber: evidence.blockNumber,
    blockHash: evidence.blockHash,
    blockTimestamp: evidence.blockTimestamp,
    sourceOccurredAt: evidence.blockTimestamp,
    canonicalTokenCreatedKey: `fourmeme:openfour-core-token-created:${FOUR_REGISTRY_CHAIN_ID}:${evidence.transactionHash}:${evidence.logIndex}:${created.token}`,
    structural: { eligible: true, source: "official_onchain_core", canonical: true, finalized: true },
    source: {
      id: FOUR_CORE_SOURCE_ID,
      name: "OpenFour on-chain Core",
      kind: "official_onchain_core",
      url: `https://bscscan.com/tx/${created.proof.transactionHash}`,
      trust: "official_verified",
      official: true,
    },
    sourceUrl: `https://bscscan.com/tx/${created.proof.transactionHash}`,
    url: `https://bscscan.com/tx/${created.proof.transactionHash}`,
    explorerUrl: `https://bscscan.com/tx/${created.proof.transactionHash}`,
    security: {
      status: "unknown",
      decision: "unknown",
      reason: "TokenCreated confirms provenance only; it is not a contract safety verdict",
    },
    trading: { decision: "watch_only", automaticExecution: false, security: "unknown" },
    ...deliveryRecoveryFields(evidence.blockTimestamp, observedAt, coverageProof, "T2"),
    observedAt,
  };
  return finalizeEventDigests(event);
}

function resolveCanonicalReinclusion(event, durableState) {
  const positionKey = canonicalPositionKey(event.transactionHash, event.logIndex);
  const owners = canonicalOwnersAtPosition(durableState, event.transactionHash, event.logIndex);
  if (owners.length === 0) return { event, previouslyDelivered: false, positionKey };
  const exactOwner = durableState.orphanedDeliveredEvents[canonicalOwnerHistoryKey(
    event.transactionHash,
    event.logIndex,
    event.blockHash,
  )];
  // Prefer the owner invalidated by the current finalized transition. A hash
  // that was canonical in an older epoch is not globally "already done": when
  // A→B→A→B, each transition needs a fresh correction so the user's last card
  // always matches the current chain. The epoch makes retries within one
  // recovery deterministic while keeping later transitions distinct.
  const transitionOwner = [...owners].reverse().find((owner) =>
    owner.recovery.recoveryEpoch === durableState.canonicalRecoveryEpoch
      && owner.processedEvent.blockHash !== event.blockHash);
  const orphan = transitionOwner
    || exactOwner
    || [...owners].reverse().find(orphanOwnerWasDelivered)
    || [...owners].reverse().find((owner) => owner.recovery.cancellationStatus === "superseded")
    || owners.at(-1);
  const previous = orphan.processedEvent;
  if (previous.blockNumber <= orphan.recovery.resumeBlock) {
    throw fourError(
      "FOUR_REGISTRY_CANONICAL_REVISION_INVALID",
      `canonical position ${positionKey} does not match its delivered owner`,
    );
  }
  const priorOwnerWasDelivered = orphanOwnerWasDelivered(orphan);
  const deliveredHistoryExists = priorOwnerWasDelivered
    || previous.event.canonicalRevision?.replacesDeliveryStatus === "delivered"
    || previous.event.canonicalRevision?.replacesCanonicalOwnerDelivered === true
    || previous.event.canonicalRevision?.cancellationStatus === "delivered_orphaned";
  if (previous.blockHash === event.blockHash) {
    if (previous.baseEventKey !== event.eventKey
      || previous.kind !== event.kind
      || previous.eventType !== event.type
      || previous.lifecycleKey !== event.lifecycleKey
      || !exactData(previous.canonicalLog, event.evidence.canonicalLog)) {
      throw fourError(
        "FOUR_REGISTRY_CANONICAL_REVISION_INVALID",
        `canonical position ${positionKey} changed payload under an identical block hash`,
      );
    }
    if (priorOwnerWasDelivered) {
      return {
        event: clone(previous.event),
        previouslyDelivered: true,
        positionKey,
        processedEvent: clone(previous),
      };
    }
    if (orphan.recovery.cancellationStatus === "still_canonical") {
      return { event: clone(previous.event), previouslyDelivered: false, positionKey };
    }
    if (previous.event.canonicalRevision) {
      event.canonicalRevision = clone(previous.event.canonicalRevision);
      event.eventKey = previous.event.eventKey;
      event.deliveryPolicy.tier = "T2";
    } else if (previous.event.canonicalSupersession) {
      event.canonicalSupersession = clone(previous.event.canonicalSupersession);
      event.eventKey = previous.event.eventKey;
    }
    event.deliveryEvidenceDigest = eventDeliveryEvidenceDigest(event);
    const restoredPayloadDigest = eventPayloadDigest(event);
    if (restoredPayloadDigest !== previous.payloadDigest) {
      throw fourError(
        "FOUR_REGISTRY_CANONICAL_RESTORATION_INVALID",
        `canonical position ${positionKey} cannot restore a changed cancelled payload`,
      );
    }
    event.canonicalRestoration = canonicalRestorationFromOwner(orphan);
    event.canonicalRestoration.payloadDigest = restoredPayloadDigest;
    finalizeEventDigests(event);
    return { event, previouslyDelivered: false, positionKey };
  }
  if (!deliveredHistoryExists) {
    if (orphan.recovery.cancellationStatus === "still_canonical") {
      throw fourError(
        "FOUR_REGISTRY_CANCELLATION_REQUIRED",
        `canonical owner ${previous.eventKey} changed again before its queued proof was resolved`,
      );
    }
    if (previous.baseEventKey === event.eventKey) {
      const currentBasePayloadDigest = event.payloadDigest;
      event.canonicalSupersession = canonicalSupersessionFromOwner(
        event.eventKey,
        event.blockHash,
        currentBasePayloadDigest,
        orphan,
      );
      finalizeEventDigests(event);
    }
    return { event, previouslyDelivered: false, positionKey };
  }
  const currentBasePayloadDigest = event.payloadDigest;
  event.canonicalRevision = canonicalRevisionFromOrphan(
    event.eventKey,
    event.blockHash,
    currentBasePayloadDigest,
    orphan,
  );
  event.eventKey = `${event.eventKey}:canonical-revision:${event.blockHash}:${event.canonicalRevision.recoveryEpoch}`;
  event.deliveryPolicy.tier = "T2";
  finalizeEventDigests(event);
  return { event, previouslyDelivered: false, positionKey };
}

function restoreCanonicalOwner(candidate, resolution) {
  if (!resolution.previouslyDelivered) return;
  const record = resolution.processedEvent;
  if (!Object.hasOwn(candidate.processedEvents, record.eventKey)) {
    candidate.processedEvents[record.eventKey] = clone(record);
    candidate.processedEventKeys.push(record.eventKey);
  }
  // Keep the compact position+blockHash owner history. A later finalized fork
  // can oscillate back to this exact proof; retaining it is what prevents a
  // reused revision id from acquiring a different replacement payload.
}

function armPosition(registryEvent, finalizedBlock) {
  if (registryEvent) return {
    blockNumber: registryEvent.proof.blockNumber,
    transactionIndex: registryEvent.proof.transactionIndex,
    logIndex: registryEvent.proof.logIndex,
    blockHash: registryEvent.proof.blockHash,
  };
  return {
    blockNumber: finalizedBlock.number,
    transactionIndex: Number.MAX_SAFE_INTEGER,
    logIndex: Number.MAX_SAFE_INTEGER,
    blockHash: finalizedBlock.hash,
  };
}

async function presetSnapshotForCanonicalEvent(stateVerificationProviders, registryEvent) {
  const id = registryEvent.presetId;
  const snapshot = await consensusPresetAt(
    stateVerificationProviders,
    id,
    registryEvent.proof.blockNumber,
    registryEvent.proof.blockHash,
  );
  if (!snapshot) throw fourError("FOUR_REGISTRY_PRESET_INVALID", `preset ${id} is absent after its Registry event`);
  const eventState = clone(snapshot);
  if (["PresetUpserted", "PresetActiveUpdated"].includes(registryEvent.eventName)) {
    eventState.active = boolean(registryEvent.active, `${registryEvent.eventName}.active`);
  }
  if (["PresetUpserted", "PresetCreateEnabledUpdated"].includes(registryEvent.eventName)) {
    eventState.createEnabled = boolean(registryEvent.createEnabled, `${registryEvent.eventName}.createEnabled`);
  }
  return normalizePreset(eventState, id);
}

function rpcQuantity(value) {
  return `0x${integer(value, "RPC block number").toString(16)}`;
}

export function assertFourRegistryProvider(provider) {
  if (!provider || FOUR_REGISTRY_REQUIRED_PROVIDER_METHODS.some((method) => typeof provider[method] !== "function")) {
    throw new Error(`Four Registry provider requires ${FOUR_REGISTRY_REQUIRED_PROVIDER_METHODS.join(", ")}`);
  }
  if (typeof provider.getLogs !== "function" && typeof provider.send !== "function") {
    throw new Error("Four Registry provider requires getLogs(filter) or send('eth_getLogs', [filter])");
  }
  return provider;
}

function verificationSourceHost(value, label) {
  const raw = boundedText(value, label, 300).toLowerCase();
  if (!raw) throw fourError("FOUR_REGISTRY_PROVIDER_QUORUM_INVALID", `${label} is empty`);
  let parsed;
  try { parsed = new URL(raw.includes("://") ? raw : `https://${raw}`); }
  catch { throw fourError("FOUR_REGISTRY_PROVIDER_QUORUM_INVALID", `${label} is not a physical RPC host`); }
  if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) {
    throw fourError("FOUR_REGISTRY_PROVIDER_QUORUM_INVALID", `${label} is not an HTTP(S) RPC host`);
  }
  return `${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}`;
}

function normalizeVerificationProviders(value, label, { logs = false } = {}) {
  if (!Array.isArray(value) || value.length < 2) {
    throw fourError("FOUR_REGISTRY_PROVIDER_QUORUM_INVALID", `${label} requires at least two independent providers`);
  }
  const providers = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw fourError("FOUR_REGISTRY_PROVIDER_QUORUM_INVALID", `${label}[${index}] is invalid`);
    }
    const provider = entry.provider;
    assertFourRegistryProvider(provider);
    if (logs && typeof provider.getLogs !== "function" && typeof provider.send !== "function") {
      throw fourError("FOUR_REGISTRY_PROVIDER_QUORUM_INVALID", `${label}[${index}] cannot query logs`);
    }
    return {
      sourceId: verificationSourceHost(entry.sourceId, `${label}[${index}].sourceId`),
      provider,
    };
  });
  if (new Set(providers.map((entry) => entry.sourceId)).size !== providers.length
    || new Set(providers.map((entry) => entry.provider)).size !== providers.length) {
    throw fourError("FOUR_REGISTRY_PROVIDER_QUORUM_INVALID", `${label} must use distinct physical hosts and provider instances`);
  }
  return providers;
}

const TELEMETRY_PROVIDER_METHODS = new Set([
  "getNetwork",
  "getBlockNumber",
  "getBlock",
  "getHistoricalBlock",
  "getCode",
  "call",
  "getLogs",
  "getTransaction",
  "getHistoricalTransaction",
  "getTransactionReceipt",
  "getHistoricalTransactionReceipt",
  "send",
]);

function rateLimitFailure(error) {
  const seen = new Set();
  const queue = [error];
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate || seen.has(candidate)) continue;
    if (typeof candidate === "string") {
      if (/(?:\b429\b|rate.?limit|too many requests|compute units?)/iu.test(candidate)) return true;
      continue;
    }
    if (typeof candidate !== "object") continue;
    seen.add(candidate);
    if (Number(candidate.status) === 429 || Number(candidate.code) === 429) return true;
    queue.push(candidate.message, candidate.cause, candidate.error, candidate.info?.error);
  }
  return false;
}

function rpcRetryAfterMs(error) {
  const seen = new Set();
  const queue = [error];
  let delay = 0;
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    // These hosts are prerequisites, not alternative pools. Keep the longest
    // declared cooldown, including evidence wrapped by the Registry reader.
    for (const value of [candidate.retryAfterMs, candidate.rpcHostRetryAfterMs]) {
      if (Number.isFinite(Number(value)) && Number(value) > 0) delay = Math.max(delay, Math.ceil(Number(value)));
    }
    queue.push(candidate.cause, candidate.error, candidate.info?.error,
      ...(Array.isArray(candidate.errors) ? candidate.errors : []));
  }
  return delay;
}

function emptyRpcCounter() {
  return { calls: 0, failures: 0, rateLimited: 0, latencyMs: 0 };
}

function incrementRpcCounter(counter, elapsedMs, error) {
  counter.calls += 1;
  counter.latencyMs += elapsedMs;
  if (error) counter.failures += 1;
  if (error && rateLimitFailure(error)) counter.rateLimited += 1;
}

async function acquirePhysicalHostBudget(entry, lane, method, rpcBudget) {
  let totalWaitMs = 0;
  const starts = rpcBudget.callStarts.get(entry.sourceId) || [];
  rpcBudget.callStarts.set(entry.sourceId, starts);
  while (true) {
    if (rpcBudget.stopped) {
      throw fourError("FOUR_REGISTRY_STOPPED", "Four Registry RPC budget wait was stopped");
    }
    const nowMs = rpcBudget.nowMs();
    const cutoff = nowMs - RPC_BUDGET_WINDOW_MS;
    while (starts.length > 0 && starts[0] <= cutoff) starts.shift();
    if (starts.length < FOUR_REGISTRY_RPC_CALLS_PER_HOST_PER_MINUTE) {
      starts.push(nowMs);
      rpcBudget.onCallStart?.({ sourceId: entry.sourceId, lane, method, atMs: nowMs });
      return totalWaitMs;
    }
    const waitMs = Math.max(1, starts[0] + RPC_BUDGET_WINDOW_MS - nowMs + 1);
    totalWaitMs += waitMs;
    await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        rpcBudget.waiters.delete(cancel);
        if (timer !== null) clearTimeout(timer);
        callback(value);
      };
      const cancel = () => finish(
        reject,
        fourError("FOUR_REGISTRY_STOPPED", "Four Registry RPC budget wait was stopped"),
      );
      rpcBudget.waiters.add(cancel);
      if (rpcBudget.stopped) {
        cancel();
        return;
      }
      const delay = rpcBudget.sleep
        ? Promise.resolve().then(() => rpcBudget.sleep(waitMs))
        : new Promise((delayResolve) => { timer = setTimeout(delayResolve, waitMs); });
      delay.then(
        () => finish(resolve),
        (error) => finish(reject, error),
      );
    });
  }
}

function instrumentVerificationProvider(entry, lane, telemetry, rpcBudget, logger) {
  const wrappers = new Map();
  const provider = new Proxy(entry.provider, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function" || !TELEMETRY_PROVIDER_METHODS.has(property)) {
        return typeof value === "function" ? value.bind(target) : value;
      }
      if (wrappers.has(property)) return wrappers.get(property);
      const wrapped = async (...args) => {
        const method = property === "send" ? String(args[0] || "send") : String(property);
        const throttledMs = await acquirePhysicalHostBudget(entry, lane, method, rpcBudget);
        const startedAt = Date.now();
        let failure = null;
        try {
          // Resolve again at invocation time. Tests and circuit-breaker
          // facades may atomically replace a provider method after monitor
          // construction; telemetry must not pin the stale implementation.
          const current = Reflect.get(target, property, target);
          return await current.apply(target, args);
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          const elapsedMs = Math.max(0, Date.now() - startedAt);
          const host = telemetry.hosts[entry.sourceId] ||= {
            ...emptyRpcCounter(),
            throttleWaits: 0,
            throttledMs: 0,
            lanes: {},
            methods: {},
            lastErrorAt: null,
            lastRateLimitAt: null,
            lastRateLimitLogAtMs: 0,
          };
          const laneCounter = host.lanes[lane] ||= emptyRpcCounter();
          const methodCounter = host.methods[method] ||= emptyRpcCounter();
          incrementRpcCounter(host, elapsedMs, failure);
          incrementRpcCounter(laneCounter, elapsedMs, failure);
          incrementRpcCounter(methodCounter, elapsedMs, failure);
          if (throttledMs > 0) {
            host.throttleWaits += 1;
            host.throttledMs += throttledMs;
          }
          if (failure) host.lastErrorAt = new Date().toISOString();
          if (failure && rateLimitFailure(failure)) {
            const nowMs = Date.now();
            host.lastRateLimitAt = new Date(nowMs).toISOString();
            if (nowMs - host.lastRateLimitLogAtMs >= 30_000) {
              host.lastRateLimitLogAtMs = nowMs;
              logger.error?.(`[four-registry][rpc] ${entry.sourceId} ${lane}/${method} rate limited`);
            }
          }
        }
      };
      wrappers.set(property, wrapped);
      return wrapped;
    },
  });
  return { sourceId: entry.sourceId, provider };
}

function rpcTelemetrySnapshot(telemetry, rpcBudget) {
  const snapshot = clone(telemetry);
  snapshot.elapsedMs = Math.max(0, Date.now() - telemetry.startedAtMs);
  snapshot.perHostRollingLimit = FOUR_REGISTRY_RPC_CALLS_PER_HOST_PER_MINUTE;
  snapshot.rollingWindowMs = RPC_BUDGET_WINDOW_MS;
  delete snapshot.startedAtMs;
  const nowMs = rpcBudget.nowMs();
  for (const [sourceId, host] of Object.entries(snapshot.hosts)) {
    delete host.lastRateLimitLogAtMs;
    host.rollingWindowCalls = (rpcBudget.callStarts.get(sourceId) || [])
      .filter((startedAtMs) => startedAtMs > nowMs - RPC_BUDGET_WINDOW_MS).length;
  }
  return snapshot;
}

function exactConsensus(value, label) {
  const serialized = value.map((entry) => JSON.stringify(entry));
  if (new Set(serialized).size !== 1) {
    throw fourError("FOUR_REGISTRY_STATE_CONSENSUS_MISMATCH", `${label} disagreed across independent RPC hosts`);
  }
  return clone(value[0]);
}

async function consensusBlockAt(providers, blockNumber, label) {
  const records = await Promise.all(providers.map(async ({ provider }) => blockRecord(
    await exactBlock(provider, blockNumber),
    blockNumber,
    label,
  )));
  return exactConsensus(records, label);
}

async function consensusStateSnapshotAt(providers, blockNumber, runtimeCache) {
  const snapshots = await Promise.all(providers.map(async ({ provider }) => {
    const before = blockRecord(await exactBlock(provider, blockNumber), blockNumber, "state snapshot start block");
    const snapshot = await readFourRegistryMulticallSnapshot(provider, before, runtimeCache);
    const after = blockRecord(await exactBlock(provider, blockNumber), blockNumber, "state snapshot end block");
    if (after.hash !== before.hash) {
      throw fourError("FOUR_REGISTRY_FINALIZED_BLOCK_CHANGED", `state snapshot changed at block ${blockNumber}`);
    }
    return snapshot;
  }));
  return exactConsensus(snapshots, `state snapshot ${blockNumber}`);
}

async function consensusPresetAt(providers, presetId, blockNumber, expectedBlockHash) {
  const snapshots = await Promise.all(providers.map(async ({ provider }) => {
    const before = blockRecord(await exactBlock(provider, blockNumber), blockNumber, "preset snapshot start block");
    if (before.hash !== expectedBlockHash) {
      throw fourError("FOUR_REGISTRY_LOG_NOT_CANONICAL", `preset ${presetId} snapshot is not on the canonical event block`);
    }
    const preset = await readFourRegistryPreset(provider, presetId, blockNumber);
    const after = blockRecord(await exactBlock(provider, blockNumber), blockNumber, "preset snapshot end block");
    if (after.hash !== before.hash) {
      throw fourError("FOUR_REGISTRY_FINALIZED_BLOCK_CHANGED", `preset ${presetId} block changed during exact reads`);
    }
    return preset;
  }));
  return exactConsensus(snapshots, `preset ${presetId} at block ${blockNumber}`);
}

function normalizedRuntimeCode(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^0x(?:[a-f0-9]{2})*$/u.test(normalized)) {
    throw fourError("FOUR_REGISTRY_CODE_INVALID", `${label} returned malformed runtime code`);
  }
  return normalized;
}

async function consensusRuntimeCodeAt(providers, target, blockNumber, label) {
  if (target === ZERO_ADDRESS) return { present: false, codeHash: null };
  const results = await Promise.all(providers.map(async ({ provider }) => {
    const code = normalizedRuntimeCode(await provider.getCode(target, blockNumber), label);
    return { present: code !== "0x", codeHash: code === "0x" ? null : keccak256(code).toLowerCase() };
  }));
  return exactConsensus(results, `${label} at block ${blockNumber}`);
}

async function queryLogs(provider, filter) {
  if (typeof provider.getLogs === "function") return provider.getLogs(filter);
  const rpcFilter = {
    ...filter,
    fromBlock: rpcQuantity(filter.fromBlock),
    toBlock: rpcQuantity(filter.toBlock),
  };
  return provider.send("eth_getLogs", [rpcFilter]);
}

function normalizeConsensusLog(log, label) {
  if (!log || typeof log !== "object" || !Array.isArray(log.topics) || log.topics.length === 0) {
    throw fourError("FOUR_REGISTRY_LOG_QUERY_INVALID", `${label} returned a malformed log`);
  }
  const data = String(log.data || "").toLowerCase();
  if (!/^0x(?:[a-f0-9]{2})*$/u.test(data)) {
    throw fourError("FOUR_REGISTRY_LOG_QUERY_INVALID", `${label} returned malformed log data`);
  }
  return {
    address: address(log.address, `${label}.address`),
    topics: log.topics.map((topic, index) => hash32(topic, `${label}.topics[${index}]`)),
    data,
    blockNumber: integer(log.blockNumber, `${label}.blockNumber`),
    blockHash: hash32(log.blockHash, `${label}.blockHash`),
    transactionIndex: integer(log.transactionIndex, `${label}.transactionIndex`),
    index: logIndex(log),
    transactionHash: hash32(log.transactionHash, `${label}.transactionHash`),
    removed: log.removed === true,
  };
}

function compareConsensusLogs(left, right) {
  return left.blockNumber - right.blockNumber
    || left.transactionIndex - right.transactionIndex
    || left.index - right.index
    || left.transactionHash.localeCompare(right.transactionHash);
}

function logRangeLimitError(error) {
  const seen = new Set();
  const messages = [];
  const visit = (candidate) => {
    if (!candidate || seen.has(candidate)) return;
    if (typeof candidate === "string") {
      messages.push(candidate);
      return;
    }
    if (typeof candidate !== "object") return;
    seen.add(candidate);
    if (typeof candidate.message === "string") messages.push(candidate.message);
    visit(candidate.cause);
    visit(candidate.error);
    visit(candidate.info?.error);
  };
  visit(error);
  return messages.some((message) => /(?:block|query|response|result|log).*(?:range|limit|too (?:large|many|wide)|exceed|max)|-32005/iu.test(message));
}

async function queryConsensusLogs(providers, filter, label, expectedToBlockHash) {
  try {
    const results = await Promise.all(providers.map(async ({ provider, sourceId }) => {
      const endpointBlock = blockRecord(
        await exactBlock(provider, filter.toBlock),
        filter.toBlock,
        `${label} ${sourceId} range end`,
      );
      if (endpointBlock.hash !== expectedToBlockHash) {
        throw fourError("FOUR_REGISTRY_LOG_RANGE_CHAIN_MISMATCH", `${label} from ${sourceId} is not on the state-quorum range end`);
      }
      const logs = await queryLogs(provider, filter);
      if (!Array.isArray(logs)) {
        throw fourError("FOUR_REGISTRY_LOG_QUERY_INVALID", `${label} from ${sourceId} is not an array`);
      }
      const normalized = logs.map((log, index) => normalizeConsensusLog(log, `${label}[${index}]`))
        .sort(compareConsensusLogs);
      const keys = normalized.map((log) => `${log.blockHash}:${log.transactionHash}:${log.index}`);
      if (new Set(keys).size !== keys.length) {
        throw fourError("FOUR_REGISTRY_LOG_QUERY_INVALID", `${label} from ${sourceId} returned duplicate log identities`);
      }
      return normalized;
    }));
    const agreed = exactConsensus(results, `${label} log set`);
    if (agreed.length > MAX_LOGS_PER_QUERY && filter.fromBlock < filter.toBlock) {
      const midpoint = Math.floor((filter.fromBlock + filter.toBlock) / 2);
      const [leftEnd, rightEnd] = await Promise.all([
        consensusBlockAt(providers, midpoint, `${label} split range end`),
        consensusBlockAt(providers, filter.toBlock, `${label} split final range end`),
      ]);
      const left = await queryConsensusLogs(
        providers,
        { ...filter, toBlock: midpoint },
        label,
        leftEnd.hash,
      );
      const right = await queryConsensusLogs(
        providers,
        { ...filter, fromBlock: midpoint + 1 },
        label,
        rightEnd.hash,
      );
      return [...left, ...right];
    }
    return agreed;
  }
  catch (error) {
    // A provider quota is not a range-size limit. Splitting a 429 would
    // multiply calls against the same physical host during its cooldown.
    if (filter.fromBlock < filter.toBlock && !rateLimitFailure(error) && logRangeLimitError(error)) {
      const midpoint = Math.floor((filter.fromBlock + filter.toBlock) / 2);
      const [leftEnd, rightEnd] = await Promise.all([
        consensusBlockAt(providers, midpoint, `${label} limited split range end`),
        consensusBlockAt(providers, filter.toBlock, `${label} limited split final range end`),
      ]);
      const left = await queryConsensusLogs(
        providers,
        { ...filter, toBlock: midpoint },
        label,
        leftEnd.hash,
      );
      const right = await queryConsensusLogs(
        providers,
        { ...filter, fromBlock: midpoint + 1 },
        label,
        rightEnd.hash,
      );
      return [...left, ...right];
    }
    if (error.code === "FOUR_REGISTRY_STATE_CONSENSUS_MISMATCH") {
      throw fourError("FOUR_REGISTRY_LOG_CONSENSUS_MISMATCH", `${label} disagreed across independent RPC hosts`, error);
    }
    throw error;
  }
}

async function consensusCanonicalLog(
  stateVerificationProviders,
  log,
  expectedAddress,
  allowedTopics,
  fromBlock,
  toBlock,
) {
  const proofs = await Promise.all(stateVerificationProviders.map(({ provider }) => verifyCanonicalLog(
    provider,
    log,
    expectedAddress,
    allowedTopics,
    fromBlock,
    toBlock,
  )));
  return exactConsensus(proofs, `canonical log ${log.transactionHash}:${logIndex(log)}`);
}

async function fetchCanonicalEvents(
  logVerificationProviders,
  stateVerificationProviders,
  fromBlock,
  toBlock,
  toBlockHash,
  pendingPresetIds,
  knownPresets = {},
) {
  if (fromBlock > toBlock) return { registryEvents: [], tokenEvents: [] };
  let registryLogs;
  let tokenLogs;
  try {
    // One range proof and one eth_getLogs call per fixed host cover both pinned
    // contracts. The address/topic cross-product is checked below before the
    // agreed set is partitioned, so batching does not broaden accepted logs.
    const combinedLogs = await queryConsensusLogs(
      logVerificationProviders,
      {
        address: [FOUR_REGISTRY_ADDRESS, FOUR_CORE_ADDRESS],
        fromBlock,
        toBlock,
        topics: [[...FOUR_REGISTRY_EVENT_TOPICS, FOUR_TOKEN_CREATED_TOPIC]],
      },
      "Registry/Core events",
      toBlockHash,
    );
    const registryTopicSet = new Set(FOUR_REGISTRY_EVENT_TOPICS);
    for (const log of combinedLogs) {
      const topic0 = log.topics[0];
      const acceptedRegistryLog = log.address === FOUR_REGISTRY_ADDRESS && registryTopicSet.has(topic0);
      const acceptedCoreLog = log.address === FOUR_CORE_ADDRESS && topic0 === FOUR_TOKEN_CREATED_TOPIC;
      if (!acceptedRegistryLog && !acceptedCoreLog) {
        throw fourError(
          "FOUR_REGISTRY_LOG_QUERY_INVALID",
          `combined log filter returned an invalid address/topic pair ${log.address}:${topic0}`,
        );
      }
    }
    registryLogs = combinedLogs.filter((log) => log.address === FOUR_REGISTRY_ADDRESS);
    tokenLogs = combinedLogs.filter((log) => log.address === FOUR_CORE_ADDRESS);
  } catch (error) {
    throw fourError("FOUR_REGISTRY_LOG_QUERY_FAILED", `finalized event query failed: ${error.message}`, error);
  }
  if (!Array.isArray(registryLogs) || !Array.isArray(tokenLogs)) {
    throw fourError("FOUR_REGISTRY_LOG_QUERY_INVALID", "event query did not return arrays");
  }
  const registryEvents = [];
  for (const log of registryLogs) {
    const proof = await consensusCanonicalLog(
      stateVerificationProviders,
      log,
      FOUR_REGISTRY_ADDRESS,
      new Set(FOUR_REGISTRY_EVENT_TOPICS),
      fromBlock,
      toBlock,
    );
    registryEvents.push(await attachProtocolRuntimeProof(stateVerificationProviders, parseRegistryLog(log, proof)));
  }
  const candidatePresetIds = new Set([
    ...pendingPresetIds.map((id) => uintString(id, "pending presetId")),
    ...registryEvents.filter((event) => event.presetId !== undefined).map((event) => event.presetId),
    ...registryEvents.flatMap((event) => {
      const kind = PROTOCOL_CAPABILITY_BY_EVENT[event.eventName]?.kind;
      const revision = { kind, module: event.record, tokenImplementation: event.record };
      return kind ? Object.values(knownPresets).filter((preset) => revisionBindsPreset(revision, preset)).map((preset) => preset.id) : [];
    }),
  ]);
  const tokenEvents = [];
  for (const log of tokenLogs) {
    const indexed = parseTokenCreatedIndex(log, {
      ...logPosition(log),
      transactionHash: hash32(log.transactionHash, "TokenCreated.transactionHash"),
      topic0: FOUR_TOKEN_CREATED_TOPIC,
      blockTimestamp: null,
    });
    if (!candidatePresetIds.has(indexed.presetId)) continue;
    const proof = await consensusCanonicalLog(
      stateVerificationProviders,
      log,
      FOUR_CORE_ADDRESS,
      new Set([FOUR_TOKEN_CREATED_TOPIC]),
      fromBlock,
      toBlock,
    );
    // Decode only the indexed identity here. User-controlled dynamic metadata
    // is decoded after canonical ordering proves this log belongs to an armed
    // preset generation, so an unrelated oversized token cannot block every
    // later governance update.
    tokenEvents.push({ ...indexed, proof });
  }
  registryEvents.sort((left, right) => comparePosition(left.proof, right.proof));
  tokenEvents.sort((left, right) => comparePosition(left.proof, right.proof));
  return { registryEvents, tokenEvents };
}

export function classifyFourRegistryDelivery(result, expectedEventKey) {
  const status = String(result?.status || "").toLowerCase();
  const eventId = String(result?.eventId || "").trim();
  if (typeof expectedEventKey !== "string" || !expectedEventKey || eventId !== expectedEventKey) return "retry";
  if (["delivered", "queued"].includes(status) && result?.persisted === true) return status;
  const reason = String(result?.reason || result?.disabledReason || "").toLowerCase();
  if (status === "suppressed"
    && reason === "semantic_duplicate"
    && result?.persisted === true
    && result?.canonicalOwnerDelivered === true
    && typeof result?.duplicateOf === "string"
    && result.duplicateOf.length > 0
    && result.duplicateOf.length <= 512) return "semantic_duplicate";
  return "retry";
}

function normalizeFourRegistryCancellationResult(result, expectedEventKey) {
  const common = result && typeof result === "object" && !Array.isArray(result)
    && result.eventId === expectedEventKey;
  if (!common) {
    throw fourError("FOUR_REGISTRY_CANCELLATION_UNRESOLVED", `cancellation did not bind ${expectedEventKey}`);
  }
  if (result.status === "superseded"
    && hasExactKeys(result, ["status", "reason", "persisted", "terminal", "eventId"])
    && result.reason === "canonical_reorg"
    && result.persisted === true
    && result.terminal === true) return { status: result.status, deliveredAt: null };
  if (result.status === "delivered_orphaned"
    && hasExactKeys(result, ["status", "reason", "persisted", "terminal", "eventId", "deliveredAt"])
    && result.reason === "canonical_reorg"
    && result.persisted === true
    && result.terminal === true) {
    return { status: result.status, deliveredAt: exactIso(result.deliveredAt, "cancellation.deliveredAt") };
  }
  if (result.status === "not_found"
    && hasExactKeys(result, ["status", "reason", "persisted", "terminal", "eventId"])
    && result.reason === "registry_event_not_found"
    && result.persisted === false
    && result.terminal === false) return { status: result.status, deliveredAt: null };
  if (result.status === "queued"
    && hasExactKeys(result, ["status", "reason", "persisted", "terminal", "eventId"])
    && result.reason === "delivery_in_flight"
    && result.persisted === true
    && result.terminal === false) {
    throw fourError("FOUR_REGISTRY_CANCELLATION_IN_FLIGHT", `cancellation is waiting for ${expectedEventKey}`);
  }
  throw fourError("FOUR_REGISTRY_CANCELLATION_UNRESOLVED", `cancellation for ${expectedEventKey} was not durable`);
}

async function verifyDurableOutboxEntryOnProvider(entry, provider) {
  const event = entry.event;
  const transactionHash = hash32(event.transactionHash, "outbox event.transactionHash");
  const expectedLogIndex = integer(event.logIndex, "outbox event.logIndex");
  const expectedAddress = event.type === FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE
    ? FOUR_CORE_ADDRESS
    : FOUR_REGISTRY_ADDRESS;
  const allowedTopics = event.type === FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE
    ? new Set([FOUR_TOKEN_CREATED_TOPIC])
    : new Set(FOUR_REGISTRY_EVENT_TOPICS);
  const receipt = await exactTransactionReceipt(provider, transactionHash);
  const receiptLog = (receipt?.logs || []).find((log) => {
    try {
      return logIndex(log) === expectedLogIndex
        && address(log.address, "outbox receipt log.address") === expectedAddress;
    } catch { return false; }
  });
  if (!receiptLog) {
    throw fourError("FOUR_REGISTRY_OUTBOX_PROOF_UNAVAILABLE", `durable event ${entry.eventKey} is absent from its canonical receipt`);
  }
  const proof = await verifyCanonicalLog(
    provider,
    receiptLog,
    expectedAddress,
    allowedTopics,
    event.blockNumber,
    event.blockNumber,
  );
  if (proof.blockHash !== event.blockHash
    || proof.transactionIndex !== event.transactionIndex
    || proof.blockTimestamp !== event.blockTimestamp) {
    throw fourError("FOUR_REGISTRY_OUTBOX_PROOF_MISMATCH", `durable event ${entry.eventKey} no longer matches its canonical coordinates`);
  }
  if (event.type === FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE) {
    const parsed = parseTokenCreatedLog(receiptLog, proof);
    if (parsed.presetId !== event.presetId || !exactData(tokenPayloadFromCreated(parsed), event.token)) {
      throw fourError("FOUR_REGISTRY_OUTBOX_PROOF_MISMATCH", `durable first-token ${entry.eventKey} no longer matches its receipt payload`);
    }
    if (event.featureTrackedToken === true) {
      const tracked = event.featureTokenProof;
      const activation = tracked.activationEvent;
      const proofs = [activation, ...tracked.revisionEvents]
        .filter((item, index, all) => all.findIndex(other => other.eventKey === item.eventKey && other.blockHash === item.blockHash) === index);
      for (const capability of proofs) await verifyDurableOutboxEntryOnProvider({ eventKey: capability.eventKey, event: capability }, provider);
      const bindingSnapshot = await readFourRegistryPreset(provider, event.presetId, tracked.presetBinding.blockNumber);
      if (!exactData(bindingSnapshot, tracked.presetBinding.preset)) {
        throw fourError("FOUR_REGISTRY_OUTBOX_PROOF_MISMATCH", "tracked-token activation lost its exact preset binding");
      }
      for (const prior of tracked.priorTokens) {
        const priorCreated = parseTokenCreatedLog(prior.evidence.canonicalLog, {});
        await verifyDurableOutboxEntryOnProvider({ eventKey: `${prior.evidence.transactionHash}:${prior.evidence.logIndex}`,
          event: { ...prior.evidence, type: FOUR_REGISTRY_FIRST_TOKEN_EVENT_TYPE, presetId: event.presetId,
            token: tokenPayloadFromCreated(priorCreated), evidence: prior.evidence } }, provider);
      }
    }
  } else {
    const parsed = parseRegistryLog(receiptLog, proof);
    if (parsed.eventName !== event.evidence?.eventName) {
      throw fourError("FOUR_REGISTRY_OUTBOX_PROOF_MISMATCH", `durable capability ${entry.eventKey} no longer matches its Registry event`);
    }
    if (parsed.presetId !== undefined) {
      if (parsed.presetId !== event.presetId
        || (parsed.active !== null && parsed.active !== event.currentPreset?.active)
        || (parsed.createEnabled !== null && parsed.createEnabled !== event.currentPreset?.createEnabled)) {
        throw fourError("FOUR_REGISTRY_OUTBOX_PROOF_MISMATCH", `durable preset capability ${entry.eventKey} no longer matches its Registry payload`);
      }
      // A deferred event keeps the prior tuple on purpose, so comparing it
      // with a later same-block V3 snapshot would permanently wedge a valid
      // retry. Every other closed scope explicitly carries block-end metadata
      // and must still match the exact-block state read.
      if (event.snapshotScope !== PRESET_DEFERRED_SNAPSHOT_SCOPE) {
        const snapshot = await readFourRegistryPreset(provider, parsed.presetId, event.blockNumber);
        const staticKeys = [
          "id", "name", "description", "version", "textProof", "validator", "tokenModuleId", "vaultModuleId",
          "curveModuleId", "tradeModuleId", "migrateModuleId", "tokenImplId", "customDataId", "author",
          "validatorConfigured",
        ];
        if (!staticKeys.every((key) => exactData(snapshot[key], event.currentPreset?.[key]))) {
          throw fourError("FOUR_REGISTRY_OUTBOX_PROOF_MISMATCH", `durable preset capability ${entry.eventKey} no longer matches its block-end settlement`);
        }
      }
    } else if (parsed.subjectKey !== event.subject?.id) {
      throw fourError("FOUR_REGISTRY_OUTBOX_PROOF_MISMATCH", `durable protocol capability ${entry.eventKey} no longer matches its Registry subject`);
    } else if (parsed.eventName === "ModuleUpserted") {
      const implementationCode = normalizedRuntimeCode(
        await provider.getCode(parsed.record.implementation, event.blockNumber),
        "durable module implementation",
      );
      const beaconCode = normalizedRuntimeCode(
        await provider.getCode(parsed.record.beacon, event.blockNumber),
        "durable module beacon",
      );
      const runtime = {
        ...parsed.record,
        implementationCodePresent: implementationCode !== "0x",
        implementationCodeHash: implementationCode === "0x" ? null : keccak256(implementationCode).toLowerCase(),
        beaconCodePresent: beaconCode !== "0x",
        beaconCodeHash: beaconCode === "0x" ? null : keccak256(beaconCode).toLowerCase(),
      };
      if (!exactData(runtime, event.module)) {
        throw fourError("FOUR_REGISTRY_OUTBOX_PROOF_MISMATCH", `durable module ${entry.eventKey} no longer matches its runtime proof`);
      }
    } else if (parsed.eventName === "TokenImplUpserted") {
      const code = normalizedRuntimeCode(
        await provider.getCode(parsed.record.implementation, event.blockNumber),
        "durable token implementation",
      );
      const runtime = {
        ...parsed.record,
        implementationCodePresent: code !== "0x",
        implementationCodeHash: code === "0x" ? null : keccak256(code).toLowerCase(),
      };
      if (!exactData(runtime, event.tokenImplementation)) {
        throw fourError("FOUR_REGISTRY_OUTBOX_PROOF_MISMATCH", `durable token implementation ${entry.eventKey} no longer matches its runtime proof`);
      }
    } else if (!exactData(parsed.record, event.tag)) {
      throw fourError("FOUR_REGISTRY_OUTBOX_PROOF_MISMATCH", `durable tag ${entry.eventKey} no longer matches its Registry payload`);
    }
  }
  return proof;
}

async function verifyDurableOutboxCanonical(outbox, stateVerificationProviders) {
  for (const entry of outbox) {
    const proofs = await Promise.all(stateVerificationProviders.map(({ provider }) =>
      verifyDurableOutboxEntryOnProvider(entry, provider)));
    exactConsensus(proofs, `durable outbox event ${entry.eventKey}`);
  }
}

function knownEventKey(candidate, eventKey) {
  return Object.hasOwn(candidate.processedEvents, eventKey)
    || candidate.outbox.some((entry) => entry.eventKey === eventKey);
}

function enqueueDiscovered(candidate, events, enqueuedAt) {
  for (const event of events) {
    if (knownEventKey(candidate, event.eventKey)) continue;
    if (candidate.outbox.length >= MAX_OUTBOX_EVENTS) {
      throw fourError("FOUR_REGISTRY_OUTBOX_FULL", `durable outbox reached ${MAX_OUTBOX_EVENTS} events`);
    }
    candidate.outbox.push({
      eventKey: event.eventKey,
      lifecycleKey: event.lifecycleKey,
      event: clone(event),
      enqueuedAt,
      attempts: 0,
      lastAttemptAt: null,
      lastOutcome: null,
    });
  }
}

function acceptedRecord(entry, deliveryStatus, acceptedAt, deliveryResult = null) {
  const subject = capabilityEventSubject(entry.event);
  return {
    eventKey: entry.eventKey,
    baseEventKey: entry.event.canonicalRevision?.baseEventKey || entry.eventKey,
    canonicalRevision: entry.event.canonicalRevision ? clone(entry.event.canonicalRevision) : null,
    event: clone(entry.event),
    eventType: entry.event.type,
    kind: entry.event.kind,
    subjectType: subject.type,
    subjectKey: subject.key,
    presetId: subject.type === "preset" ? subject.key : null,
    lifecycleKey: entry.lifecycleKey,
    capabilityEventKey: entry.event.capabilityEventKey || null,
    transactionHash: hash32(entry.event.transactionHash, "accepted event.transactionHash"),
    transactionIndex: integer(entry.event.transactionIndex, "accepted event.transactionIndex"),
    logIndex: integer(entry.event.logIndex, "accepted event.logIndex"),
    blockNumber: integer(entry.event.blockNumber, "accepted event.blockNumber"),
    blockHash: hash32(entry.event.blockHash, "accepted event.blockHash"),
    evidenceBasis: entry.event.evidence.basis,
    eventName: entry.event.evidence.eventName,
    canonicalLog: clone(entry.event.evidence.canonicalLog),
    canonicalTokenCreatedKey: entry.event.canonicalTokenCreatedKey || null,
    payloadDigest: hash32(entry.event.payloadDigest, "accepted event.payloadDigest"),
    deliveryStatus,
    duplicateOf: deliveryStatus === "semantic_duplicate" ? deliveryResult.duplicateOf : null,
    canonicalOwnerDelivered: deliveryStatus === "semantic_duplicate" && deliveryResult.canonicalOwnerDelivered === true,
    acceptedAt,
  };
}

function pruneProcessed(candidate) {
  const protectedKeys = new Set([
    ...Object.values(candidate.pendingConfirmations).map((pending) => pending.capabilityEventKey),
    ...candidate.checkpoints.flatMap((checkpoint) => Object.values(checkpoint.pendingConfirmations || {})
      .map((pending) => pending.capabilityEventKey)),
  ]);
  while (candidate.processedEventKeys.length > MAX_PROCESSED_KEYS) {
    const removableIndex = candidate.processedEventKeys.findIndex((key) => !protectedKeys.has(key));
    if (removableIndex < 0) {
      throw fourError("FOUR_REGISTRY_PROCESSED_FULL", "all processed event records are referenced by pending lifecycle state");
    }
    const [removed] = candidate.processedEventKeys.splice(removableIndex, 1);
    delete candidate.processedEvents[removed];
  }
}

function appendCheckpoint(candidate, block, presets) {
  candidate.checkpoints = candidate.checkpoints.filter((checkpoint) => checkpoint.blockNumber < block.number);
  candidate.checkpoints.push({
    blockNumber: block.number,
    blockHash: block.hash,
    presets: clone(presets),
    pendingConfirmations: clone(candidate.pendingConfirmations),
    mechanismTracking: mechanismCheckpoint(candidate.mechanismTracking),
  });
  if (candidate.checkpoints.length > MAX_CHECKPOINTS) {
    const baseline = candidate.checkpoints.find((checkpoint) => checkpoint.blockNumber === candidate.baselineBlock);
    const recent = candidate.checkpoints
      .filter((checkpoint) => checkpoint.blockNumber !== candidate.baselineBlock)
      .slice(-(MAX_CHECKPOINTS - 1));
    candidate.checkpoints = baseline ? [baseline, ...recent] : recent;
  }
}

export function createFourRegistryMonitor(config = {}, dependencies = {}) {
  const provider = assertFourRegistryProvider(dependencies.provider);
  const rawLogVerificationProviders = normalizeVerificationProviders(
    dependencies.logVerificationProviders,
    "logVerificationProviders",
    { logs: true },
  );
  const rawStateVerificationProviders = normalizeVerificationProviders(
    dependencies.stateVerificationProviders,
    "stateVerificationProviders",
  );
  const combinedVerificationProviders = [...rawLogVerificationProviders, ...rawStateVerificationProviders]
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.sourceId === entry.sourceId) === index);
  if (combinedVerificationProviders.length < 3) {
    throw fourError(
      "FOUR_REGISTRY_PROVIDER_QUORUM_INVALID",
      "combined log/state verification requires at least three distinct physical RPC hosts",
    );
  }
  const fsImpl = dependencies.fsImpl || fs;
  const clock = dependencies.now || Date.now;
  const logger = dependencies.logger || console;
  const rpcTelemetry = { startedAtMs: Date.now(), hosts: {} };
  const rpcBudget = {
    callStarts: new Map(),
    nowMs: dependencies.rpcBudgetNowForTesting || Date.now,
    sleep: dependencies.rpcBudgetSleepForTesting,
    onCallStart: dependencies.onRpcCallStartForTesting,
    waiters: new Set(),
    stopped: false,
  };
  const logVerificationProviders = rawLogVerificationProviders.map((entry) => (
    instrumentVerificationProvider(entry, "log", rpcTelemetry, rpcBudget, logger)
  ));
  const stateVerificationProviders = rawStateVerificationProviders.map((entry) => (
    instrumentVerificationProvider(entry, "state", rpcTelemetry, rpcBudget, logger)
  ));
  const onEvent = dependencies.onEvent;
  const cancelPendingEvent = dependencies.cancelPendingEvent;
  if (typeof onEvent === "function" && typeof cancelPendingEvent !== "function") {
    throw fourError(
      "FOUR_REGISTRY_CANCELLATION_REQUIRED",
      "a durable onEvent sink requires cancelPendingEvent for finalized reorg safety",
    );
  }
  const writeState = dependencies.atomicWriteImpl
    || ((file, value) => atomicWriteFourRegistryState(file, value, fsImpl));
  const stateFile = config.fourRegistryStateFile
    || path.join(config.dataDir || ".data", "four-registry-state.json");
  const confirmations = integer(
    config.fourRegistryConfirmations ?? config.confirmations ?? FOUR_REGISTRY_DEFAULT_CONFIRMATIONS,
    "fourRegistryConfirmations",
    1,
  );
  const scanChunkSize = Math.max(1, Math.min(10_000, integer(
    config.fourRegistryLogChunkSize ?? 10_000,
    "fourRegistryLogChunkSize",
  )));
  const reorgLookbackBlocks = Math.max(1, Math.min(10_000, integer(
    config.fourRegistryReorgLookbackBlocks ?? 64,
    "fourRegistryReorgLookbackBlocks",
  )));
  const pollIntervalMs = Math.max(
    MIN_RPC_SCHEDULER_INTERVAL_MS,
    integer(config.fourRegistryPollIntervalMs ?? 30_000, "fourRegistryPollIntervalMs"),
  );
  const catchUpIntervalMs = Math.max(MIN_RPC_SCHEDULER_INTERVAL_MS, Math.min(pollIntervalMs, integer(
    config.fourRegistryCatchUpIntervalMs ?? MIN_RPC_SCHEDULER_INTERVAL_MS,
    "fourRegistryCatchUpIntervalMs",
  )));
  const setTimer = dependencies.setTimeoutImpl || setTimeout;
  const clearTimer = dependencies.clearTimeoutImpl || clearTimeout;
  let state = emptyState();
  let loaded = false;
  let activeCheck = null;
  let timer = null;
  let stopped = false;
  let consecutiveFailures = 0;
  const runtimeIdentityCache = new WeakMap();
  runtimeIdentityCache.expectedMulticall3CodeHash = dependencies.multicall3CodeHashForTesting === undefined
    ? FOUR_REGISTRY_MULTICALL3_CODE_HASH
    : hash32(dependencies.multicall3CodeHashForTesting, "multicall3CodeHashForTesting");

  async function load() {
    if (!loaded) {
      state = await readFourRegistryState(stateFile, fsImpl);
      loaded = true;
    }
  }

  async function commitState(candidate) {
    try {
      await writeState(stateFile, candidate);
      state = candidate;
      return;
    } catch (writeError) {
      // rename(2) may have committed the exact candidate before chmod or the
      // directory fsync reported failure. Read the durable owner back before
      // deciding whether this process may advance; never keep loaded=true on
      // an unverified in-memory predecessor.
      loaded = false;
      try {
        const durableRaw = JSON.parse(await fsImpl.readFile(stateFile, "utf8"));
        const durableState = normalizeState(durableRaw);
        state = durableState;
        loaded = true;
        if (JSON.stringify(durableRaw) === JSON.stringify(candidate)) return;
      } catch (readError) {
        writeError.readBackError = readError;
      }
      throw writeError;
    }
  }

  async function drainOutbox() {
    if (typeof onEvent !== "function" || state.outbox.length === 0) {
      return { accepted: 0, pending: state.outbox.length, lastOutcome: onEvent ? null : "delivery_not_configured" };
    }
    let accepted = 0;
    let lastOutcome = null;
    while (state.outbox.length > 0) {
      const entry = state.outbox[0];
      const attemptedAt = iso(clock());
      let result;
      try { result = await onEvent(clone(entry.event)); }
      catch (error) {
        const retryState = clone(state);
        retryState.outbox[0].attempts += 1;
        retryState.outbox[0].lastAttemptAt = attemptedAt;
        retryState.outbox[0].lastOutcome = `error:${boundedText(error?.message || error, "delivery error", 140)}`;
        retryState.updatedAt = attemptedAt;
        await commitState(retryState);
        logger.error?.(`[four-registry] delivery retry ${entry.eventKey}: ${error?.message || error}`);
        return { accepted, pending: state.outbox.length, lastOutcome: "retry" };
      }
      const classification = classifyFourRegistryDelivery(result, entry.eventKey);
      lastOutcome = classification;
      if (classification === "retry") {
        const retryState = clone(state);
        retryState.outbox[0].attempts += 1;
        retryState.outbox[0].lastAttemptAt = attemptedAt;
        retryState.outbox[0].lastOutcome = `retry:${boundedText(result?.reason || result?.disabledReason || result?.status || "unknown", "delivery outcome", 120)}`;
        retryState.updatedAt = attemptedAt;
        await commitState(retryState);
        return { accepted, pending: state.outbox.length, lastOutcome };
      }
      const acceptedState = clone(state);
      const acceptedEntry = acceptedState.outbox.shift();
      acceptedState.processedEvents[acceptedEntry.eventKey] = acceptedRecord(
        acceptedEntry,
        classification,
        attemptedAt,
        result,
      );
      acceptedState.processedEventKeys.push(acceptedEntry.eventKey);
      pruneProcessed(acceptedState);
      acceptedState.updatedAt = attemptedAt;
      // If this acknowledgement write fails, the pre-delivery outbox record
      // remains durable. A restart retries the identical eventKey; sendAlerts
      // can then return its canonical-owner semantic duplicate receipt.
      await commitState(acceptedState);
      accepted += 1;
    }
    return { accepted, pending: 0, lastOutcome };
  }

  async function cancelCanonicalOwner({ eventId, baseEventKey, blockHash, payloadDigest, deliveryEvidenceDigest }) {
    if (typeof cancelPendingEvent !== "function") {
      throw fourError(
        "FOUR_REGISTRY_CANCELLATION_REQUIRED",
        `cannot resolve canonical owner ${eventId} without cancelPendingEvent`,
      );
    }
    const result = await cancelPendingEvent({
      eventId,
      baseEventKey,
      blockHash,
      payloadDigest,
      deliveryEvidenceDigest,
      reason: "canonical_reorg",
    });
    return normalizeFourRegistryCancellationResult(result, eventId);
  }

  async function reconcileStillCanonicalReplayOwners(finalizedHeadNumber) {
    const candidate = clone(state);
    let changed = false;
    const nextRecoveryEpoch = state.canonicalRecoveryEpoch + 1;
    for (const [ownerKey, owner] of Object.entries(candidate.orphanedDeliveredEvents)) {
      if (owner.recovery.cancellationStatus !== "still_canonical") continue;
      const previous = owner.processedEvent;
      if (previous.blockNumber > finalizedHeadNumber) {
        throw fourError(
          "FOUR_REGISTRY_HEAD_BEHIND",
          `finalized head is behind retained replay owner ${previous.eventKey}`,
        );
      }
      const observedBlock = await consensusBlockAt(
        stateVerificationProviders,
        previous.blockNumber,
        "retained replay owner block",
      );
      const stillCanonical = observedBlock.hash === previous.blockHash;
      if (stillCanonical) continue;
      const cancellation = await cancelCanonicalOwner({
        eventId: previous.eventKey,
        baseEventKey: previous.baseEventKey,
        blockHash: previous.blockHash,
        payloadDigest: previous.payloadDigest,
        deliveryEvidenceDigest: previous.event.deliveryEvidenceDigest,
      });
      candidate.outbox = candidate.outbox.filter((entry) => !(entry.eventKey === previous.eventKey
        && entry.event.blockHash === previous.blockHash
        && entry.event.payloadDigest === previous.payloadDigest));
      if (candidate.processedEvents[previous.eventKey]?.blockHash === previous.blockHash
        && candidate.processedEvents[previous.eventKey]?.payloadDigest === previous.payloadDigest) {
        delete candidate.processedEvents[previous.eventKey];
        candidate.processedEventKeys = candidate.processedEventKeys.filter((key) => key !== previous.eventKey);
      }
      for (const [presetId, pending] of Object.entries(candidate.pendingConfirmations)) {
        if (pending.capabilityEventKey === previous.eventKey
          && pending.armedAt.blockHash === previous.blockHash) delete candidate.pendingConfirmations[presetId];
      }
      if (owner.origin === "outbox" && cancellation.status === "not_found") {
        delete candidate.orphanedDeliveredEvents[ownerKey];
        changed = true;
        continue;
      }
      const semanticOwnerDelivered = previous.deliveryStatus === "semantic_duplicate"
        && previous.canonicalOwnerDelivered === true;
      if (cancellation.status === "not_found"
        || (previous.deliveryStatus === "delivered" && cancellation.status !== "delivered_orphaned")
        || (!semanticOwnerDelivered
          && previous.deliveryStatus !== "delivered"
          && !["superseded", "delivered_orphaned"].includes(cancellation.status))) {
        throw fourError(
          "FOUR_REGISTRY_CANCELLATION_UNRESOLVED",
          `retained replay owner ${previous.eventKey} was not durably resolved`,
        );
      }
      owner.recovery = {
        recoveryEpoch: nextRecoveryEpoch,
        detectedAt: iso(Math.max(Number(clock()), Date.parse(cancellation.deliveredAt || 0))),
        oldAnchorBlock: previous.blockNumber,
        oldAnchorBlockHash: previous.blockHash,
        observedAnchorBlockHash: observedBlock.hash,
        resumeBlock: state.cursor.anchorBlock,
        resumeBlockHash: state.cursor.anchorBlockHash,
        cancellationStatus: cancellation.status,
      };
      candidate.orphanedDeliveredEvents[ownerKey] = owner;
      changed = true;
    }
    if (changed) {
      candidate.canonicalRecoveryEpoch = nextRecoveryEpoch;
      candidate.updatedAt = iso(Math.max(
        Number(clock()),
        ...Object.values(candidate.orphanedDeliveredEvents).map((owner) => Date.parse(owner.recovery.detectedAt)),
      ));
      await commitState(candidate);
    }
    return changed;
  }

  async function recoverFinalizedReorg(anchor, finalizedHeadNumber, observedAt) {
    const recoveryEpoch = state.canonicalRecoveryEpoch + 1;
    let safeCheckpoint = null;
    let baselineCheckpoint = null;
    for (const checkpoint of [...state.checkpoints].reverse()) {
      // The caller already proved this anchor inconsistent. Do not let a
      // second load-balanced endpoint return the old fork and re-elect the
      // same checkpoint as safe.
      if (checkpoint.blockNumber >= state.cursor.anchorBlock) continue;
      const candidate = await consensusBlockAt(
        stateVerificationProviders,
        checkpoint.blockNumber,
        "reorg checkpoint block",
      );
      if (candidate.hash === checkpoint.blockHash) {
        safeCheckpoint = {
          ...checkpoint,
          presets: clone(checkpoint.presets),
          pendingConfirmations: clone(checkpoint.pendingConfirmations),
        };
        break;
      }
    }
    if (!safeCheckpoint) {
      // Only the initial baseline is allowed to be silent. If no retained
      // checkpoint survives a deep reorg, return to that exact baseline block
      // and replay every post-baseline canonical log in bounded chunks.
      const recoveryBlockNumber = state.baselineBlock;
      if (recoveryBlockNumber > finalizedHeadNumber) {
        throw fourError("FOUR_REGISTRY_HEAD_BEHIND", "finalized head is behind the durable first-run baseline");
      }
      const recoverySnapshot = await consensusStateSnapshotAt(
        stateVerificationProviders,
        recoveryBlockNumber,
        runtimeIdentityCache,
      );
      baselineCheckpoint = {
        blockNumber: recoveryBlockNumber,
        blockHash: recoverySnapshot.identity.block.hash,
        presets: recoverySnapshot.inventory,
        pendingConfirmations: {},
        mechanismTracking: mechanismCheckpoint(seedMechanismTracking(recoverySnapshot.inventory)),
      };
      safeCheckpoint = clone(baselineCheckpoint);
      safeCheckpoint.recoveryMechanismOwner = seedMechanismTracking(recoverySnapshot.inventory);
    }

    if (!baselineCheckpoint) {
      const persistedBaseline = state.checkpoints.find((checkpoint) => checkpoint.blockNumber === state.baselineBlock);
      if (!persistedBaseline) {
        throw fourError("FOUR_REGISTRY_STATE_INVALID", "durable first-run baseline checkpoint is missing");
      }
      const baselineHeader = await consensusBlockAt(
        stateVerificationProviders,
        state.baselineBlock,
        "retained baseline header",
      );
      if (baselineHeader.hash !== persistedBaseline.blockHash) {
        throw fourError("FOUR_REGISTRY_REORG_INCONSISTENT", "retained checkpoint survived but the older baseline header did not");
      }
      baselineCheckpoint = clone(persistedBaseline);
    }

    const canonicalHashCache = new Map();
    const eventStillCanonical = async (event, label) => {
      const eventBlock = integer(event.blockNumber, `${label}.blockNumber`);
      if (eventBlock > finalizedHeadNumber) return false;
      if (!canonicalHashCache.has(eventBlock)) {
        canonicalHashCache.set(eventBlock, (await consensusBlockAt(
          stateVerificationProviders,
          eventBlock,
          `${label} recovery block`,
        )).hash);
      }
      return canonicalHashCache.get(eventBlock) === event.blockHash;
    };
    const retainedOutbox = [];
    const replayOwners = [];
    const droppedOutboxEventKeys = [];
    for (const entry of state.outbox) {
      const stillCanonical = await eventStillCanonical(entry.event, "outbox");
      if (entry.event.blockNumber <= safeCheckpoint.blockNumber) {
        if (!stillCanonical) {
          throw fourError("FOUR_REGISTRY_REORG_INCONSISTENT", `safe checkpoint does not contain outbox event ${entry.eventKey}`);
        }
        retainedOutbox.push(clone(entry));
        continue;
      }
      if (stillCanonical) retainedOutbox.push(clone(entry));
      replayOwners.push({ source: "outbox", entry, processedEvent: null, stillCanonical });
      if (!stillCanonical) droppedOutboxEventKeys.push(entry.eventKey);
    }
    const retainedProcessedEventKeys = [];
    const retainedProcessedEvents = {};
    for (const eventKey of state.processedEventKeys) {
      const processedEvent = state.processedEvents[eventKey];
      const stillCanonical = await eventStillCanonical(processedEvent.event, "processed event");
      if (processedEvent.blockNumber <= safeCheckpoint.blockNumber) {
        if (!stillCanonical) {
          throw fourError("FOUR_REGISTRY_REORG_INCONSISTENT", `safe checkpoint does not contain processed event ${eventKey}`);
        }
        retainedProcessedEventKeys.push(eventKey);
        retainedProcessedEvents[eventKey] = clone(processedEvent);
        continue;
      }
      if (stillCanonical) {
        retainedProcessedEventKeys.push(eventKey);
        retainedProcessedEvents[eventKey] = clone(processedEvent);
      }
      replayOwners.push({ source: "processed", entry: null, processedEvent, stillCanonical });
    }
    const resolvedOwners = [];
    let latestDeliveredAtMs = Date.parse(observedAt);
    for (const owner of replayOwners) {
      if (owner.stillCanonical) {
        resolvedOwners.push({
          origin: owner.source,
          processedEvent: owner.source === "processed"
            ? clone(owner.processedEvent)
            : acceptedRecord(owner.entry, "queued", owner.entry.enqueuedAt),
          cancellationStatus: "still_canonical",
        });
        continue;
      }
      const eventId = owner.source === "processed" ? owner.processedEvent.eventKey : owner.entry.eventKey;
      const baseEventKey = owner.source === "processed"
        ? owner.processedEvent.baseEventKey
        : owner.entry.event.canonicalRevision?.baseEventKey || owner.entry.eventKey;
      const event = owner.source === "processed" ? owner.processedEvent.event : owner.entry.event;
      const cancellation = await cancelCanonicalOwner({
        eventId,
        baseEventKey,
        blockHash: event.blockHash,
        payloadDigest: event.payloadDigest,
        deliveryEvidenceDigest: event.deliveryEvidenceDigest,
      });
      if (cancellation.deliveredAt) latestDeliveredAtMs = Math.max(latestDeliveredAtMs, Date.parse(cancellation.deliveredAt));
      if (owner.source === "outbox") {
        if (cancellation.status === "not_found") continue;
        resolvedOwners.push({
          origin: owner.source,
          processedEvent: acceptedRecord(
            owner.entry,
            cancellation.status === "delivered_orphaned" ? "delivered" : "queued",
            cancellation.deliveredAt || owner.entry.enqueuedAt,
          ),
          cancellationStatus: cancellation.status,
        });
        continue;
      }
      const processedEvent = owner.processedEvent;
      const semanticOwnerDelivered = processedEvent.deliveryStatus === "semantic_duplicate"
        && processedEvent.canonicalOwnerDelivered === true;
      const deliveredOwner = cancellation.status === "delivered_orphaned" || semanticOwnerDelivered;
      const invalidProcessedResolution = cancellation.status === "not_found"
        || (processedEvent.deliveryStatus === "delivered" && cancellation.status !== "delivered_orphaned");
      if (invalidProcessedResolution) {
        throw fourError(
          "FOUR_REGISTRY_CANCELLATION_UNRESOLVED",
          `processed canonical owner ${processedEvent.eventKey} was not durably resolved`,
        );
      }
      if (deliveredOwner) {
        resolvedOwners.push({
          origin: owner.source,
          processedEvent: clone(processedEvent),
          cancellationStatus: cancellation.status,
        });
      } else if (processedEvent.deliveryStatus === "queued" && cancellation.status === "superseded") {
        resolvedOwners.push({
          origin: owner.source,
          processedEvent: clone(processedEvent),
          cancellationStatus: cancellation.status,
        });
      }
    }
    const recoveryResolvedAt = iso(Math.max(Number(clock()), latestDeliveredAtMs));
    const orphanedDeliveredEvents = clone(state.orphanedDeliveredEvents);
    const recoveryOwnerBase = {
      recoveryEpoch,
      detectedAt: recoveryResolvedAt,
      oldAnchorBlock: state.cursor.anchorBlock,
      oldAnchorBlockHash: state.cursor.anchorBlockHash,
      observedAnchorBlockHash: anchor.hash,
      resumeBlock: safeCheckpoint.blockNumber,
      resumeBlockHash: safeCheckpoint.blockHash,
    };
    for (const { origin, processedEvent, cancellationStatus } of resolvedOwners) {
      const positionKey = canonicalPositionKey(processedEvent.transactionHash, processedEvent.logIndex);
      const ownerKey = canonicalOwnerHistoryKey(
        processedEvent.transactionHash,
        processedEvent.logIndex,
        processedEvent.blockHash,
      );
      const nextOwner = {
        positionKey,
        origin,
        processedEvent: clone(processedEvent),
        recovery: { ...clone(recoveryOwnerBase), cancellationStatus },
      };
      const priorOwner = orphanedDeliveredEvents[ownerKey];
      if (!priorOwner || !orphanOwnerWasDelivered(priorOwner) || orphanOwnerWasDelivered(nextOwner)) {
        orphanedDeliveredEvents[ownerKey] = nextOwner;
      }
    }
    if (Object.keys(orphanedDeliveredEvents).length > MAX_ORPHANED_DELIVERED_EVENTS) {
      throw fourError(
        "FOUR_REGISTRY_ORPHAN_PROOF_FULL",
        `durable canonical-revision owner set exceeded ${MAX_ORPHANED_DELIVERED_EVENTS}`,
      );
    }
    const durableCapabilityKeys = new Set([
      ...retainedProcessedEventKeys,
      ...retainedOutbox.map((entry) => entry.eventKey),
    ]);
    const retainedPendingConfirmations = {};
    const pendingCandidates = {
      ...clone(safeCheckpoint.pendingConfirmations),
      ...clone(state.pendingConfirmations),
    };
    for (const [presetId, pending] of Object.entries(pendingCandidates)) {
      if (!durableCapabilityKeys.has(pending.capabilityEventKey)) continue;
      if (!canonicalHashCache.has(pending.armedAt.blockNumber)) {
        canonicalHashCache.set(pending.armedAt.blockNumber, (await consensusBlockAt(
          stateVerificationProviders,
          pending.armedAt.blockNumber,
          "pending confirmation recovery block",
        )).hash);
      }
      if (canonicalHashCache.get(pending.armedAt.blockNumber) === pending.armedAt.blockHash
        && (pending.armedAt.blockNumber > safeCheckpoint.blockNumber
          || safeCheckpoint.presets[presetId]?.canCreate)) {
        retainedPendingConfirmations[presetId] = clone(pending);
      }
    }
    const recovered = clone(state);
    recovered.cursor = {
      nextBlock: safeCheckpoint.blockNumber + 1,
      anchorBlock: safeCheckpoint.blockNumber,
      anchorBlockHash: safeCheckpoint.blockHash,
    };
    recovered.presets = clone(safeCheckpoint.presets);
    recovered.mechanismTracking = restoreMechanismCheckpoint(safeCheckpoint.mechanismTracking,
      safeCheckpoint.recoveryMechanismOwner || state.mechanismTracking);
    recovered.presetAuditCursor = 0;
    recovered.presetAuditProofs = Object.fromEntries(Object.entries(safeCheckpoint.presets).map(([id, preset]) => [id, {
      presetId: id,
      blockNumber: safeCheckpoint.blockNumber,
      blockHash: safeCheckpoint.blockHash,
      fingerprint: preset.fingerprint,
    }]));
    // A shallow reorg can invalidate the newest anchor while leaving an older
    // capability proof canonical. Preserve that durable lifecycle arm so the
    // first future TokenCreated is still observed after rollback. Arms on the
    // orphaned branch are discarded and will be reconstructed by replay.
    recovered.pendingConfirmations = retainedPendingConfirmations;
    recovered.outbox = retainedOutbox;
    recovered.processedEvents = retainedProcessedEvents;
    recovered.processedEventKeys = retainedProcessedEventKeys;
    recovered.orphanedDeliveredEvents = orphanedDeliveredEvents;
    recovered.canonicalRecoveryEpoch = recoveryEpoch;
    recovered.checkpoints = safeCheckpoint.blockNumber === baselineCheckpoint.blockNumber
      ? [baselineCheckpoint]
      : [baselineCheckpoint, {
        blockNumber: safeCheckpoint.blockNumber,
        blockHash: safeCheckpoint.blockHash,
        presets: clone(safeCheckpoint.presets),
        pendingConfirmations: clone(safeCheckpoint.pendingConfirmations),
        mechanismTracking: clone(safeCheckpoint.mechanismTracking),
      }];
    recovered.tokenBackfillSuppressedThroughBlock = state.baselineBlock;
    recovered.reorgRecoveries.push({
      recoveryEpoch,
      detectedAt: recoveryResolvedAt,
      oldAnchorBlock: state.cursor.anchorBlock,
      oldAnchorBlockHash: state.cursor.anchorBlockHash,
      observedAnchorBlockHash: anchor.hash,
      recoveredAtBlock: safeCheckpoint.blockNumber,
      recoveredAtBlockHash: safeCheckpoint.blockHash,
      catchUpThroughBlock: finalizedHeadNumber,
      policy: "bounded_checkpoint_replay",
      droppedOutboxEventKeys,
    });
    recovered.reorgRecoveries = recovered.reorgRecoveries.slice(-MAX_REORG_RECOVERIES);
    recovered.updatedAt = recoveryResolvedAt;
    await commitState(recovered);
    return {
      status: "recovered_reorg",
      lifecycleStage: "reorg_checkpoint_replay",
      lifecycle: {
        key: `fourmeme:openfour:registry:reorg:${safeCheckpoint.blockHash}`,
        product: "openfour-registry",
        stage: "reorg_checkpoint_replay",
      },
      finalizedBlock: { number: safeCheckpoint.blockNumber, hash: safeCheckpoint.blockHash },
      events: [],
      droppedOutboxEventKeys,
      retainedOutboxEventKeys: retainedOutbox.map((entry) => entry.eventKey),
      historicalTokenBackfill: true,
      resumeFromBlock: safeCheckpoint.blockNumber + 1,
      catchUpThroughBlock: finalizedHeadNumber,
      hasMore: safeCheckpoint.blockNumber < finalizedHeadNumber,
    };
  }

  async function checkOnce() {
    await load();
    const head = integer(await provider.getBlockNumber(), "head block");
    const finalizedHeadNumber = Math.max(0, head - confirmations);
    if (state.initialized && finalizedHeadNumber < state.cursor.anchorBlock) {
      throw fourError("FOUR_REGISTRY_HEAD_BEHIND", "RPC finalized head is behind the persisted cursor");
    }
    const scanNumber = !state.initialized || state.cursor.nextBlock > finalizedHeadNumber
      ? finalizedHeadNumber
      : Math.min(finalizedHeadNumber, state.cursor.nextBlock + scanChunkSize - 1);

    if (!state.initialized) {
      const snapshot = await consensusStateSnapshotAt(
        stateVerificationProviders,
        scanNumber,
        runtimeIdentityCache,
      );
      const finalizedBlock = snapshot.identity.block;
      const inventory = snapshot.inventory;
      const observedAt = iso(clock());
      const nextState = {
        ...emptyState(),
        initialized: true,
        cursor: { nextBlock: scanNumber + 1, anchorBlock: scanNumber, anchorBlockHash: finalizedBlock.hash },
        presets: inventory,
        mechanismTracking: seedMechanismTracking(inventory),
        presetAuditCursor: 0,
        presetAuditProofs: Object.fromEntries(Object.entries(inventory).map(([id, preset]) => [id, {
          presetId: id,
          blockNumber: scanNumber,
          blockHash: finalizedBlock.hash,
          fingerprint: preset.fingerprint,
        }])),
        checkpoints: [{
          blockNumber: scanNumber,
          blockHash: finalizedBlock.hash,
          presets: clone(inventory),
          pendingConfirmations: {},
          mechanismTracking: mechanismCheckpoint(seedMechanismTracking(inventory)),
        }],
        tokenBackfillSuppressedThroughBlock: scanNumber,
        baselineBlock: scanNumber,
        baselineAt: observedAt,
        updatedAt: observedAt,
      };
      await commitState(nextState);
      return {
        status: "baseline",
        lifecycleStage: "baseline",
        lifecycle: { key: "fourmeme:openfour:registry:baseline", product: "openfour-registry", stage: "baseline" },
        finalizedBlock: clone(finalizedBlock),
        events: [],
      };
    }

    const anchor = await consensusBlockAt(stateVerificationProviders, state.cursor.anchorBlock, "persisted anchor block");
    if (anchor.hash !== state.cursor.anchorBlockHash) {
      return recoverFinalizedReorg(anchor, finalizedHeadNumber, iso(clock()));
    }

    // Reorg recovery can deliberately retain an event whose own block still
    // matched even though a later anchor changed. Before any replay or retry,
    // recheck those proofs: a second fork may have invalidated the event while
    // the older replay anchor itself remains canonical.
    await reconcileStillCanonicalReplayOwners(finalizedHeadNumber);

    // Never deliver a durable event from an orphaned anchor. The anchor and
    // each event proof are revalidated by the fixed state quorum before this
    // retry path is allowed to call the external sender.
    await verifyDurableOutboxCanonical(state.outbox, stateVerificationProviders);
    const preflightDelivery = await drainOutbox();
    if (state.outbox.length > 0) {
      return {
        status: "delivery_pending",
        events: [],
        delivery: preflightDelivery,
        outboxPending: state.outbox.length,
        hasMore: true,
      };
    }

    const scanEndSnapshot = await consensusStateSnapshotAt(
      stateVerificationProviders,
      scanNumber,
      runtimeIdentityCache,
    );
    const finalizedBlock = scanEndSnapshot.identity.block;
    const scanEndInventory = scanEndSnapshot.inventory;
    const canonicalEvents = await fetchCanonicalEvents(
      logVerificationProviders,
      stateVerificationProviders,
      state.cursor.nextBlock,
      scanNumber,
      finalizedBlock.hash,
      [...new Set([...Object.keys(state.pendingConfirmations), ...Object.keys(state.mechanismTracking.active)])],
      state.presets,
    );
    const { registryEvents, tokenEvents } = canonicalEvents;
    const presetIds = Object.keys(scanEndInventory);
    const presetEventIds = new Set(registryEvents
      .filter((event) => event.presetId !== undefined)
      .map((event) => event.presetId));
    const knownPresetIds = new Set(Object.keys(state.presets));
    const livePresetIds = new Set(presetIds);
    const unexplainedNewIds = presetIds.filter((id) => !knownPresetIds.has(id) && !presetEventIds.has(id));
    const disappearedIds = [...knownPresetIds].filter((id) => !livePresetIds.has(id));
    if (unexplainedNewIds.length > 0) {
      throw fourError(
        "FOUR_REGISTRY_LOG_CONSENSUS_INCOMPLETE",
        `new preset ids lack canonical Registry positions: ${unexplainedNewIds.join(",")}`,
      );
    }
    if (disappearedIds.length > 0) {
      throw fourError(
        "FOUR_REGISTRY_PRESET_REMOVAL_UNSUPPORTED",
        `preset ids disappeared without an official removal event: ${disappearedIds.join(",")}`,
      );
    }
    const presetSnapshotCache = new Map();
    const presetEventGroups = new Map();
    for (const registryEvent of registryEvents.filter((event) => event.presetId !== undefined)) {
      const cacheKey = `${registryEvent.proof.blockNumber}:${registryEvent.presetId}`;
      const group = presetEventGroups.get(cacheKey) || [];
      group.push(registryEvent);
      presetEventGroups.set(cacheKey, group);
      if (!presetSnapshotCache.has(cacheKey)) {
        presetSnapshotCache.set(
          cacheKey,
          await presetSnapshotForCanonicalEvent(stateVerificationProviders, registryEvent),
        );
      }
    }
    // Observation starts after range proofs. Exact module/preset attribution
    // below advances this clock again after its additional asynchronous reads.
    let observedAt = iso(Math.max(Number(clock()), Date.parse(state.updatedAt || "") || 0));
    const nextState = clone(state);
    const discovered = [];
    const protocolCapabilityEvents = [];
    const confirmationEvents = [];
    const armedThisCycle = new Set();
    const workingPresets = clone(state.presets);
    const workingPresetSnapshotScopes = Object.fromEntries(
      Object.keys(workingPresets).map((id) => [id, PRESET_DIRECT_SNAPSHOT_SCOPE]),
    );
    for (const [id, pending] of Object.entries(state.pendingConfirmations)) {
      const referenced = state.processedEvents[pending.capabilityEventKey]?.event
        || state.outbox.find((entry) => entry.eventKey === pending.capabilityEventKey)?.event;
      if (FOUR_REGISTRY_PRESET_SNAPSHOT_SCOPES.includes(referenced?.snapshotScope)) {
        workingPresetSnapshotScopes[id] = referenced.snapshotScope;
      }
    }
    const coverageProofFor = (proof) => ({
      baselineBlock: state.baselineBlock,
      priorAnchorBlock: state.cursor.anchorBlock,
      priorAnchorBlockHash: state.cursor.anchorBlockHash,
      scanFromBlock: state.cursor.nextBlock,
      scanThroughBlock: scanNumber,
      eventBlockNumber: proof.blockNumber,
      eventBlockHash: proof.blockHash,
    });
    const applyCapability = (previous, current, fields, proofEvent, snapshotScope) => {
      const baseEvent = capabilityEvent(
        previous,
        current,
        fields,
        proofEvent,
        finalizedBlock,
        observedAt,
        confirmations,
        coverageProofFor(proofEvent.proof),
        snapshotScope,
      );
      const resolution = resolveCanonicalReinclusion(baseEvent, nextState);
      const event = resolution.event;
      restoreCanonicalOwner(nextState, resolution);
      if (!resolution.previouslyDelivered && !knownEventKey(nextState, event.eventKey)) discovered.push(event);
      if (snapshotScope === PRESET_DIRECT_SNAPSHOT_SCOPE) {
        activateMechanism(nextState.mechanismTracking, current, event, "canonical_single_preset_event");
      } else {
        // A block-end tuple shared by several writes cannot identify which
        // transaction introduced its modules. Keep the alert, withhold entry.
        delete nextState.mechanismTracking.active[current.id];
      }
      const becameCreatable = current.canCreate && (!previous || !previous.canCreate);
      if (becameCreatable) {
        nextState.pendingConfirmations[current.id] = {
          presetId: current.id,
          capabilityEventKey: event.eventKey,
          lifecycleKey: event.lifecycleKey,
          armedAt: armPosition(proofEvent, finalizedBlock),
        };
        armedThisCycle.add(current.id);
      } else if (!current.canCreate) {
        delete nextState.pendingConfirmations[current.id];
      }
      workingPresets[current.id] = clone(current);
      workingPresetSnapshotScopes[current.id] = snapshotScope;
    };

    const timeline = [
      ...registryEvents.map((event) => ({ type: "registry", event, proof: event.proof })),
      ...tokenEvents.map((event) => ({ type: "token", event, proof: event.proof })),
    ].sort((left, right) => comparePosition(left.proof, right.proof)
      || (left.type === "registry" ? -1 : 1));
    for (const item of timeline) {
      if (item.type === "registry" && Object.hasOwn(PROTOCOL_CAPABILITY_BY_EVENT, item.event.eventName)) {
        const revision = { kind: PROTOCOL_CAPABILITY_BY_EVENT[item.event.eventName].kind,
          module: item.event.record, tokenImplementation: item.event.record };
        const bindingVerified = new Set();
        for (const preset of Object.values(workingPresets).filter((preset) => presetReferencesRevision(revision, preset))) {
          const cacheKey = `${item.event.proof.blockNumber}:${preset.id}`;
          if (!preset.canCreate || !revisionBindsPreset(revision, preset) || presetEventGroups.has(cacheKey)) continue;
          const snapshot = await consensusPresetAt(stateVerificationProviders, preset.id,
            item.event.proof.blockNumber, item.event.proof.blockHash);
          if (!exactData(snapshot, preset)) {
            throw fourError("FOUR_REGISTRY_TRACKING_BINDING_UNKNOWN", "module update cannot be attributed to the event-block preset");
          }
          bindingVerified.add(preset.id);
        }
        observedAt = iso(Math.max(Number(clock()), Date.parse(observedAt)));
        const baseEvent = protocolCapabilityEvent(
          item.event,
          observedAt,
          confirmations,
          coverageProofFor(item.event.proof),
        );
        const resolution = resolveCanonicalReinclusion(baseEvent, nextState);
        const event = resolution.event;
        restoreCanonicalOwner(nextState, resolution);
        if (!resolution.previouslyDelivered && !knownEventKey(nextState, event.eventKey)) protocolCapabilityEvents.push(event);
        if (["module", "token-impl"].includes(event.subject.type)) {
          nextState.mechanismTracking.revisions[revisionIdentity(event)] = clone(event);
          for (const preset of Object.values(workingPresets).filter((preset) => presetReferencesRevision(event, preset))) {
            if (!bindingVerified.has(preset.id)) {
              delete nextState.mechanismTracking.active[preset.id];
              continue;
            }
            activateMechanism(nextState.mechanismTracking, preset, event, "canonical_preset_unchanged_within_event_block");
          }
        }
        continue;
      }
      if (item.type === "registry") {
        const registryEvent = item.event;
        const cacheKey = `${registryEvent.proof.blockNumber}:${registryEvent.presetId}`;
        const sameBlockEvents = presetEventGroups.get(cacheKey) || [];
        const sameBlockOrdinal = sameBlockEvents.indexOf(registryEvent);
        const hasSameBlockSiblings = sameBlockEvents.length > 1;
        const isLastSameBlockEvent = sameBlockOrdinal === sameBlockEvents.length - 1;
        const previous = workingPresets[registryEvent.presetId] || null;
        let snapshotScope = PRESET_DIRECT_SNAPSHOT_SCOPE;
        let current = clone(presetSnapshotCache.get(cacheKey));
        // eth_call at a block returns block-end state. For an existing preset,
        // replay status from the durable timeline and apply only the boolean
        // carried by this exact log; otherwise a later same-block disable can
        // erase an earlier enable window and its intervening first token.
        if (previous) {
          // If multiple preset logs share a block, block-end metadata cannot be
          // attributed to the first transaction. Preserve the prior metadata
          // until the final related log, where it is explicitly represented as
          // a block-level settlement rather than a per-transaction field diff.
          if (hasSameBlockSiblings && !isLastSameBlockEvent) {
            current = clone(previous);
            snapshotScope = PRESET_DEFERRED_SNAPSHOT_SCOPE;
          } else if (hasSameBlockSiblings) {
            snapshotScope = PRESET_SETTLED_SNAPSHOT_SCOPE;
          }
          current.active = previous.active;
          current.createEnabled = previous.createEnabled;
        } else if (hasSameBlockSiblings) {
          // A newly introduced preset has no earlier tuple to replay. Its exact
          // status still comes from this log, while static text/module fields
          // are labelled as an unattributed block-end snapshot.
          snapshotScope = PRESET_UNATTRIBUTED_SNAPSHOT_SCOPE;
        }
        if (["PresetUpserted", "PresetActiveUpdated"].includes(registryEvent.eventName)) {
          current.active = registryEvent.active;
        }
        if (["PresetUpserted", "PresetCreateEnabledUpdated"].includes(registryEvent.eventName)) {
          current.createEnabled = registryEvent.createEnabled;
        }
        current.canCreate = current.active && current.createEnabled;
        current.fingerprint = presetFingerprint(current);
        const fields = attributedPresetChangedFields(previous, current, snapshotScope);
        applyCapability(previous, current, fields, registryEvent, snapshotScope);
        continue;
      }
      const indexedCreated = item.event;
      const pending = nextState.pendingConfirmations[indexedCreated.presetId];
      const currentPreset = workingPresets[indexedCreated.presetId];
      const generationKey = nextState.mechanismTracking.active[indexedCreated.presetId];
      const mechanism = generationKey ? nextState.mechanismTracking.generations[generationKey] : null;
      const trackingEligible = mechanism && !mechanism.suppressed && mechanism.tokens.length < FOUR_REGISTRY_TRACKED_TOKEN_TARGET
        && !mechanism.tokens.some((token) => token.token === indexedCreated.token)
        && comparePosition(indexedCreated.proof, mechanism.activationEvent) > 0
        && exactData(mechanismPreset(currentPreset || {}), mechanismPreset(mechanism.preset));
      if ((!pending && !trackingEligible)
        || !currentPreset?.canCreate
        || (!trackingEligible && comparePosition(indexedCreated.proof, pending.armedAt) <= 0)
        || (nextState.tokenBackfillSuppressedThroughBlock !== null
          && indexedCreated.proof.blockNumber <= nextState.tokenBackfillSuppressedThroughBlock)) continue;
      const created = parseTokenCreatedLog(indexedCreated.log, indexedCreated.proof);
      if (created.presetId !== indexedCreated.presetId
        || created.creator !== indexedCreated.creator
        || created.token !== indexedCreated.token) {
        throw fourError("FOUR_TOKEN_CREATED_DECODE_FAILED", "TokenCreated indexed identity changed during full decoding");
      }
      const baseEvent = confirmationEvent(
        created,
        trackingEligible ? { capabilityEventKey: mechanism.activationEvent.eventKey,
          lifecycleKey: `fourmeme:openfour:preset:${created.presetId}:generation:${mechanism.activationEvent.transactionHash}:${mechanism.activationEvent.logIndex}` } : pending,
        currentPreset,
        workingPresetSnapshotScopes[created.presetId] || PRESET_DIRECT_SNAPSHOT_SCOPE,
        observedAt,
        confirmations,
        coverageProofFor(created.proof),
        trackingEligible ? mechanism : null,
      );
      const resolution = resolveCanonicalReinclusion(baseEvent, nextState);
      const event = resolution.event;
      restoreCanonicalOwner(nextState, resolution);
      if (!resolution.previouslyDelivered && !knownEventKey(nextState, event.eventKey)) confirmationEvents.push(event);
      if (trackingEligible) {
        mechanism.tokens.push(trackingToken(event.evidence, created.token));
        if (mechanism.tokens.length === FOUR_REGISTRY_TRACKED_TOKEN_TARGET) delete nextState.mechanismTracking.active[created.presetId];
      }
      delete nextState.pendingConfirmations[created.presetId];
    }

    for (const id of Object.keys(nextState.pendingConfirmations)) {
      if (!workingPresets[id]?.canCreate) delete nextState.pendingConfirmations[id];
    }
    for (const [id, auditedPreset] of Object.entries(scanEndInventory)) {
      const expected = workingPresets[id];
      if (!expected || expected.fingerprint !== auditedPreset.fingerprint) {
        throw fourError(
          "FOUR_REGISTRY_LOG_CONSENSUS_INCOMPLETE",
          `preset ${id} scan-end state drifted without a complete canonical Registry log sequence`,
        );
      }
    }
    const events = [...discovered, ...protocolCapabilityEvents, ...confirmationEvents]
      .sort((left, right) => Number(left.blockNumber) - Number(right.blockNumber)
        || Number(left.transactionIndex ?? Number.MAX_SAFE_INTEGER) - Number(right.transactionIndex ?? Number.MAX_SAFE_INTEGER)
        || Number(left.logIndex ?? Number.MAX_SAFE_INTEGER) - Number(right.logIndex ?? Number.MAX_SAFE_INTEGER)
        || String(left.eventKey).localeCompare(String(right.eventKey)));
    nextState.presets = workingPresets;
    nextState.presetAuditCursor = 0;
    nextState.presetAuditProofs = {};
    for (const [id, auditedPreset] of Object.entries(scanEndInventory)) {
      nextState.presetAuditProofs[id] = {
        presetId: id,
        blockNumber: scanNumber,
        blockHash: finalizedBlock.hash,
        fingerprint: auditedPreset.fingerprint,
      };
    }
    nextState.cursor = {
      nextBlock: scanNumber + 1,
      anchorBlock: scanNumber,
      anchorBlockHash: finalizedBlock.hash,
    };
    appendCheckpoint(nextState, finalizedBlock, workingPresets);
    enqueueDiscovered(nextState, events, observedAt);
    pruneProcessed(nextState);
    nextState.updatedAt = observedAt;

    const finalCanonicalCheck = await consensusBlockAt(stateVerificationProviders, scanNumber, "commit finalized block");
    if (finalCanonicalCheck.hash !== finalizedBlock.hash) {
      throw fourError("FOUR_REGISTRY_FINALIZED_BLOCK_CHANGED", "finalized block changed before state commit");
    }
    // Discovery/cursor and the complete events are fsync'd before any external
    // delivery. Policy/source suppression can therefore retry without chain
    // replay, and an acknowledgement failure cannot invent a new event key.
    await commitState(nextState);
    const postCommitBlock = await consensusBlockAt(stateVerificationProviders, scanNumber, "post-commit finalized block");
    if (postCommitBlock.hash !== finalizedBlock.hash) {
      throw fourError("FOUR_REGISTRY_FINALIZED_BLOCK_CHANGED", "finalized block changed after discovery commit; delivery was withheld");
    }
    const currentDelivery = await drainOutbox();
    const delivery = {
      accepted: preflightDelivery.accepted + currentDelivery.accepted,
      pending: currentDelivery.pending,
      lastOutcome: currentDelivery.lastOutcome || preflightDelivery.lastOutcome,
    };
    return {
      status: "ok",
      finalizedBlock: clone(finalizedBlock),
      finalizedHead: finalizedHeadNumber,
      hasMore: scanNumber < finalizedHeadNumber,
      events: clone(events),
      registryEventsObserved: registryEvents.length,
      protocolCapabilityEventsObserved: protocolCapabilityEvents.length,
      tokenCreatedObserved: tokenEvents.length,
      pendingConfirmations: Object.keys(nextState.pendingConfirmations).length,
      armedThisCycle: [...armedThisCycle],
      delivery,
      outboxPending: state.outbox.length,
    };
  }

  async function check() {
    if (stopped) return { status: "stopped", events: [] };
    if (activeCheck) return activeCheck;
    activeCheck = checkOnce().then((result) => {
      consecutiveFailures = 0;
      return result;
    }).catch((error) => {
      consecutiveFailures += 1;
      const retryAfterMs = Math.max(
        rpcRetryAfterMs(error),
        rateLimitFailure(error) ? 60_000 : 0,
        Math.min(60_000, pollIntervalMs * (2 ** Math.min(consecutiveFailures - 1, 6))),
      );
      logger.error?.(`[four-registry] ${error.code || "FOUR_REGISTRY_FAILED"}: ${error.message}`);
      return { status: "degraded", errorCode: error.code || "FOUR_REGISTRY_FAILED", error: error.message, retryAfterMs, events: [] };
    }).finally(() => { activeCheck = null; });
    return activeCheck;
  }

  function nextDelay(result) {
    return Math.max(result?.hasMore === true ? catchUpIntervalMs : pollIntervalMs, result?.retryAfterMs || 0);
  }

  function schedule(delayMs = pollIntervalMs) {
    if (stopped || timer) return;
    timer = setTimer(async () => {
      timer = null;
      const result = await check();
      schedule(nextDelay(result));
    }, delayMs);
    timer.unref?.();
  }

  async function start() {
    if (stopped) throw new Error("Four Registry monitor was stopped");
    const result = await check();
    schedule(nextDelay(result));
    return result;
  }

  async function stop() {
    stopped = true;
    rpcBudget.stopped = true;
    for (const cancel of [...rpcBudget.waiters]) cancel();
    if (timer) clearTimer(timer);
    timer = null;
    if (activeCheck) await activeCheck;
  }

  async function getState() {
    await load();
    return clone(state);
  }

  function getRpcTelemetry() {
    return rpcTelemetrySnapshot(rpcTelemetry, rpcBudget);
  }

  if (dependencies.autoStart === true) {
    void start().catch((error) => logger.error?.(`[four-registry] auto-start failed: ${error.message}`));
  }
  return { check, start, stop, getState, getRpcTelemetry, stateFile };
}
