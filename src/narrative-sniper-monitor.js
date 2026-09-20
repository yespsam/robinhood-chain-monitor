import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { deriveNarrativeTradeSignal } from "./narrative-trade-signal.js";
import { deriveNewPoolContext } from "./new-pool-context.js";

export const NARRATIVE_SNIPER_MONITOR_VERSION = 1;
export const NARRATIVE_SNIPER_MONITOR_SCHEMA = "narrative_sniper_monitor_v1";

const ADDRESS_RE = /^0x[a-f0-9]{40}$/u;
const HASH_RE = /^0x[a-f0-9]{64}$/u;
const ASSET_KEY_RE = /^eip155:([1-9]\d*)\/erc20:(0x[a-f0-9]{40})$/u;
const DEFAULT_MAX_RAW_EVENT_BYTES = 256 * 1024;
const DEFAULT_CHECK_BATCH = 100;
const DEFAULT_NEWS_REALTIME_MS = 10 * 60_000;
const DEFAULT_NEWS_RETENTION_MS = 2 * 60 * 60_000;
const DEFAULT_POOL_REALTIME_MS = 10 * 60_000;
const DEFAULT_FUTURE_SKEW_MS = 60_000;
const DEFAULT_EFFECT_RETRY_BASE_MS = 1_000;
const DEFAULT_EFFECT_RETRY_MAX_MS = 60_000;
const FOUR_CONFIG_URL = "https://four.meme/meme-api/v1/public/config";
const FLAP_SOURCE_TRUST = "official_docs_bound_fingerprinted_portal_receipt";
const PON_SOURCE_TRUST = "official_site_bound_onchain_fingerprinted";

const DEFAULT_LIMITS = Object.freeze({
  inbox: 512,
  admissions: 2_048,
  news: 512,
  contexts: 256,
  targets: 512,
  candidates: 512,
  signals: 512,
  errors: 128,
});

function clean(value, maximum = 1_000) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function lower(value) {
  return clean(value).toLowerCase();
}

function iso(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function exactAddress(value) {
  const normalized = lower(value);
  return ADDRESS_RE.test(normalized) && normalized !== `0x${"0".repeat(40)}` ? normalized : null;
}

function exactHash(value) {
  const normalized = lower(value);
  return HASH_RE.test(normalized) ? normalized : null;
}

function exactAssetKey(value) {
  const normalized = lower(value);
  return ASSET_KEY_RE.test(normalized) ? normalized : null;
}

function assetKey(chainId, address) {
  const numericChainId = Number(chainId);
  const normalizedAddress = exactAddress(address);
  return Number.isSafeInteger(numericChainId) && numericChainId > 0 && normalizedAddress
    ? `eip155:${numericChainId}/erc20:${normalizedAddress}`
    : null;
}

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (seen.has(value)) throw new TypeError("raw event must not contain circular values");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen)).filter((item) => item !== undefined);
    if (typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
        const normalized = canonicalize(value[key], seen);
        return normalized === undefined ? [] : [[key, normalized]];
      }));
    }
    return String(value);
  } finally {
    seen.delete(value);
  }
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function boundedInteger(value, fallback, minimum = 1, maximum = 100_000) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= minimum
    ? Math.min(maximum, numeric)
    : fallback;
}

function nonNegativeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function safeUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!["http:", "https:"].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function eventIdentity(event) {
  const explicit = clean(event?.eventKey ?? event?.id ?? event?.key, 512);
  if (explicit) return explicit;
  if (event?.type === "twitter_update" && event?.tweet?.id) {
    return `twitter:${lower(event.tweet.handle)}:${clean(event.tweet.id, 64)}`;
  }
  if (event?.type === "github_module_update" && event?.repository && event?.commit) {
    return `github:${lower(event.repository)}:${lower(event.commit)}`;
  }
  return `${clean(event?.type ?? event?.kind ?? "event", 80) || "event"}:${digest(event)}`;
}

function nowMs(now) {
  const value = Number(typeof now === "function" ? now() : Date.now());
  return Number.isFinite(value) ? value : Date.now();
}

function stateTimestamp(record) {
  return Date.parse(record?.updatedAt || record?.createdAt || record?.admittedAt
    || record?.publishedAt || record?.occurredAt || 0) || 0;
}

function pruneObject(records, maximum) {
  const entries = Object.entries(records || {});
  if (entries.length <= maximum) return records || {};
  entries.sort(([leftKey, left], [rightKey, right]) => stateTimestamp(right) - stateTimestamp(left)
    || leftKey.localeCompare(rightKey));
  return Object.fromEntries(entries.slice(0, maximum));
}

function emptyState(createdAt) {
  return {
    version: NARRATIVE_SNIPER_MONITOR_VERSION,
    schema: NARRATIVE_SNIPER_MONITOR_SCHEMA,
    createdAt,
    updatedAt: createdAt,
    inbox: {},
    admissions: {},
    news: {},
    contexts: {},
    targets: {},
    candidates: {},
    signals: {},
    errors: [],
    health: {
      status: "idle",
      lastCheckAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
    },
  };
}

function normalizeState(value, createdAt) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState(createdAt);
  if (value.version !== NARRATIVE_SNIPER_MONITOR_VERSION
    || value.schema !== NARRATIVE_SNIPER_MONITOR_SCHEMA) {
    throw new Error("unsupported narrative sniper state schema");
  }
  const baseline = emptyState(value.createdAt || createdAt);
  const state = {
    ...baseline,
    ...value,
    inbox: value.inbox && typeof value.inbox === "object" && !Array.isArray(value.inbox) ? value.inbox : {},
    admissions: value.admissions && typeof value.admissions === "object" && !Array.isArray(value.admissions) ? value.admissions : {},
    news: value.news && typeof value.news === "object" && !Array.isArray(value.news) ? value.news : {},
    contexts: value.contexts && typeof value.contexts === "object" && !Array.isArray(value.contexts) ? value.contexts : {},
    targets: value.targets && typeof value.targets === "object" && !Array.isArray(value.targets) ? value.targets : {},
    candidates: value.candidates && typeof value.candidates === "object" && !Array.isArray(value.candidates) ? value.candidates : {},
    signals: value.signals && typeof value.signals === "object" && !Array.isArray(value.signals) ? value.signals : {},
    errors: Array.isArray(value.errors) ? value.errors : [],
    health: value.health && typeof value.health === "object" && !Array.isArray(value.health)
      ? { ...baseline.health, ...value.health }
      : baseline.health,
  };
  for (const candidate of Object.values(state.candidates)) {
    if (candidate?.status === "assessing") candidate.status = "pending";
  }
  for (const signal of Object.values(state.signals)) {
    if (signal?.ledger?.status === "submitting") signal.ledger.status = "pending";
    if (signal?.delivery?.status === "submitting") signal.delivery.status = "pending";
  }
  return state;
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

export async function atomicWriteNarrativeSniperState(file, value, fsImpl = fs) {
  const directory = path.dirname(file);
  await fsImpl.mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    const handle = await fsImpl.open(temporary, "wx", 0o600);
    await closeHandle(handle, async (opened) => {
      await opened.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await opened.chmod(0o600);
      await opened.sync();
    });
    await fsImpl.rename(temporary, file);
    await fsImpl.chmod(file, 0o600);
    const directoryHandle = await fsImpl.open(directory, "r");
    await closeHandle(directoryHandle, (opened) => opened.sync());
  } catch (error) {
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function addError(state, stage, error, timestamp, references = {}) {
  const message = clean(error?.message || error || "unknown error", 500) || "unknown error";
  state.errors.push({
    id: digest({ stage, message, timestamp, references }),
    stage,
    message,
    occurredAt: timestamp,
    ...references,
  });
  state.health.status = "degraded";
  state.health.lastErrorAt = timestamp;
  state.health.lastError = `${stage}: ${message}`;
}

function platformIdFromContext(kind) {
  if (kind === "flap_quote_pool") return "flap";
  if (kind === "four_quote_pool") return "fourmeme";
  if (kind === "pon_stock_market") return "ponfun";
  return null;
}

function fourLifecycleKey(config) {
  const symbol = clean(config?.symbol, 80).toUpperCase();
  const address = exactAddress(config?.address);
  const fingerprint = clean(config?.fingerprint, 256) || (symbol && address
    ? createHash("sha256").update(JSON.stringify({
        symbol,
        address,
        status: config?.status || "PUBLISH",
        fees: config?.fees || {},
        thresholds: config?.thresholds || {},
      })).digest("hex").slice(0, 20)
    : null);
  return symbol && address && fingerprint ? `quote:${symbol}:${address}:${fingerprint}` : null;
}

function flapLifecycleKey(event, quoteAddress) {
  const explicitActivation = clean(event?.featureActivationKey, 512);
  const explicitGeneration = clean(event?.featureGenerationKey, 512);
  if (explicitActivation && explicitActivation === explicitGeneration) return explicitActivation;
  const transactionHash = exactHash(event?.transactionHash);
  const blockHash = exactHash(event?.blockHash);
  const logIndex = Number(event?.logIndex);
  const eventKey = clean(event?.originalEventKey || event?.eventKey, 512);
  if (!transactionHash || !blockHash || !Number.isSafeInteger(logIndex) || logIndex < 0
    || eventKey !== `flap-quote:56:${transactionHash}:${logIndex}`) return null;
  return `quote:${quoteAddress}:generation:${blockHash}:${transactionHash}:${logIndex}`;
}

function exactFlapContextProof(event, asset, lifecycleKey) {
  const quoteAddress = exactAddress(asset?.referenceAddress);
  const transactionHash = exactHash(event?.transactionHash);
  const blockHash = exactHash(event?.blockHash);
  const logIndex = Number(event?.logIndex);
  const sourceTrust = lower(event?.source?.trust);
  const proof = event?.onchainProof || event?.evidence;
  const eventKey = clean(event?.eventKey, 512);
  const expectedKey = transactionHash && Number.isSafeInteger(logIndex)
    ? `flap-quote:56:${transactionHash}:${logIndex}`
    : null;
  const valid = event?.type === "platform_capability_update"
    && event?.kind === "flap_quote_asset_enabled"
    && sourceTrust === FLAP_SOURCE_TRUST
    && event?.signal?.quotePairChange?.stage === "live"
    && event?.delayedRecovery == null
    && proof?.receiptVerified === true
    && proof?.canonicalBlockVerified === true
    && proof?.transactionVerified === true
    && quoteAddress
    && transactionHash
    && blockHash
    && Number.isSafeInteger(logIndex)
    && logIndex >= 0
    && expectedKey === eventKey
    && lifecycleKey === `quote:${quoteAddress}:generation:${blockHash}:${transactionHash}:${logIndex}`;
  return {
    valid: Boolean(valid),
    proof: {
      kind: "flap_verified_quote_activation",
      eventKey,
      transactionHash,
      blockHash,
      blockNumber: Number.isSafeInteger(Number(event?.blockNumber)) ? Number(event.blockNumber) : null,
      logIndex: Number.isSafeInteger(logIndex) ? logIndex : null,
      quoteAddress,
      sourceUrl: safeUrl(event?.sourceUrl || event?.source?.url),
    },
  };
}

function exactFourContextProof(event, asset, lifecycleKey) {
  const quoteAddress = exactAddress(asset?.referenceAddress);
  const configs = Array.isArray(event?.changes?.newQuoteConfigs) ? event.changes.newQuoteConfigs : [];
  const config = configs.find((item) => exactAddress(item?.address) === quoteAddress);
  const sourceUrl = safeUrl(config?.source?.url);
  const valid = event?.type === "platform_capability_update"
    && ["fourmeme", "four.meme", "four_meme"].includes(lower(event?.platform?.id || event?.project?.id))
    && configs.length === 1
    && config?.platform === "MEME"
    && config?.status === "PUBLISH"
    && config?.networkCode === "BSC"
    && sourceUrl === FOUR_CONFIG_URL
    && lifecycleKey === fourLifecycleKey(config);
  return {
    valid: Boolean(valid),
    proof: {
      kind: "four_official_quote_config",
      eventKey: clean(event?.eventKey, 512) || null,
      quoteAddress,
      fingerprint: clean(config?.fingerprint, 256) || null,
      sourceUrl,
    },
  };
}

function exactPonContextProof(event, asset, lifecycleKey) {
  const transactionHash = exactHash(event?.transactionHash);
  const blockHash = exactHash(event?.blockHash);
  const blockNumber = Number(event?.blockNumber ?? event?.evidence?.blockNumber);
  const logIndex = Number(event?.evidence?.logIndex ?? event?.logIndex);
  const eventKey = clean(event?.eventKey, 512);
  const valid = event?.type === "pon_fun_update"
    && event?.kind === "market_created"
    && Number(event?.chainId) === 4663
    && lower(event?.source?.trust) === PON_SOURCE_TRUST
    && event?.evidence?.receiptVerified === true
    && transactionHash
    && blockHash
    && Number.isSafeInteger(blockNumber)
    && blockNumber >= 0
    && Number.isSafeInteger(logIndex)
    && logIndex >= 0
    && eventKey === `pon-fun:market_created:4663:${transactionHash}:${logIndex}`
    && lifecycleKey === eventKey
    && exactAddress(asset?.referenceAddress)
    && exactAddress(asset?.poolTokenAddress);
  return {
    valid: Boolean(valid),
    proof: {
      kind: "pon_verified_market_created",
      eventKey,
      transactionHash,
      blockHash,
      blockNumber: Number.isSafeInteger(Number(event?.blockNumber)) ? Number(event.blockNumber) : null,
      logIndex: Number.isSafeInteger(logIndex) ? logIndex : null,
      stockToken: exactAddress(asset?.referenceAddress),
      coin: exactAddress(asset?.poolTokenAddress),
      sourceUrl: safeUrl(event?.explorerUrl || event?.source?.url),
    },
  };
}

function contextRecordsFor(event, admittedAt) {
  const derived = deriveNewPoolContext(event);
  if (!derived) return [];
  const platformId = platformIdFromContext(derived.kind);
  return (derived.assets || []).flatMap((asset) => {
    const contextAddress = exactAddress(asset?.referenceAddress);
    const contextAssetKey = exactAssetKey(asset?.profile?.assetKey || asset?.mappingEvidence?.assetKey);
    if (!platformId || !contextAddress || !contextAssetKey) return [];
    let lifecycleKey = null;
    let proof = { valid: false, proof: null };
    if (platformId === "flap") {
      lifecycleKey = flapLifecycleKey(event, contextAddress);
      proof = exactFlapContextProof(event, asset, lifecycleKey);
    } else if (platformId === "fourmeme") {
      const config = (event?.changes?.newQuoteConfigs || []).find((item) => exactAddress(item?.address) === contextAddress);
      lifecycleKey = fourLifecycleKey(config);
      proof = exactFourContextProof(event, asset, lifecycleKey);
    } else if (platformId === "ponfun") {
      lifecycleKey = clean(event?.eventKey, 512) || null;
      proof = exactPonContextProof(event, asset, lifecycleKey);
    }
    if (!lifecycleKey) return [];
    const exactIdentity = asset?.profile?.resolution === "verified_complete"
      && asset?.identityStatus === "matched"
      && contextAssetKey === assetKey(asset?.chainId, contextAddress);
    const eligible = exactIdentity && proof.valid;
    const id = `context:${platformId}:${digest({ lifecycleKey, contextAssetKey })}`;
    return [{
      id,
      platformId,
      lifecycleKey,
      contextAssetKey,
      contextAddress,
      eligible,
      reasons: [
        ...(!exactIdentity ? ["context_identity_not_exact"] : []),
        ...(!proof.valid ? ["context_source_proof_invalid"] : []),
      ],
      occurredAt: iso(event?.blockTimestamp || event?.occurredAt || event?.observedAt),
      observedAt: iso(event?.observedAt) || admittedAt,
      poolContext: {
        chainId: Number(asset.chainId),
        ca: contextAddress,
        caVerified: eligible,
        identityStatus: asset.identityStatus,
        resolution: asset.profile?.resolution || null,
        profile: clone(asset.profile),
      },
      sourceProof: proof.proof,
      rawEventKey: eventIdentity(event),
      createdAt: admittedAt,
      updatedAt: admittedAt,
    }];
  });
}

function uniqueExactAddress(values) {
  const present = values.filter((value) => value !== undefined && value !== null && value !== "");
  const addresses = present.map(exactAddress);
  if (!present.length || addresses.some((value) => !value) || new Set(addresses).size !== 1) return null;
  return addresses[0];
}

function poolAddressFrom(event, token, quote, { required = false } = {}) {
  const pools = Array.isArray(event?.pools) ? event.pools : [];
  const pair = pools.find((pool) => {
    const token0 = exactAddress(pool?.token0);
    const token1 = exactAddress(pool?.token1);
    return ((token0 === token && token1 === quote) || (token0 === quote && token1 === token))
      && (!required || pool?.verifiedDex === true);
  });
  const address = exactAddress(pair?.pool || pair?.pairAddress);
  return address ? { address, pair: clone(pair) } : null;
}

function ponTargetRecord(event, admittedAt) {
  if (event?.type !== "pon_fun_update" || event?.kind !== "market_created" || Number(event?.chainId) !== 4663) return null;
  const coin = uniqueExactAddress([
    event?.market?.coin,
    event?.currentSnapshot?.coin,
    event?.token,
    event?.contractAddress,
  ]);
  const stockToken = uniqueExactAddress([event?.market?.stockToken, event?.currentSnapshot?.stockToken]);
  const transactionHash = exactHash(event?.transactionHash);
  const blockHash = exactHash(event?.blockHash);
  const blockNumber = Number(event?.blockNumber ?? event?.evidence?.blockNumber);
  const logIndex = Number(event?.evidence?.logIndex ?? event?.logIndex);
  const lifecycleKey = clean(event?.eventKey, 512);
  const proofValid = coin && stockToken && coin !== stockToken
    && lower(event?.source?.trust) === PON_SOURCE_TRUST
    && event?.evidence?.receiptVerified === true
    && transactionHash
    && blockHash
    && Number.isSafeInteger(blockNumber)
    && blockNumber >= 0
    && Number.isSafeInteger(logIndex)
    && lifecycleKey === `pon-fun:market_created:4663:${transactionHash}:${logIndex}`;
  if (!coin || !stockToken || !lifecycleKey) return null;
  const contextAssetKey = assetKey(4663, stockToken);
  const targetAssetKey = assetKey(4663, coin);
  const marketPool = exactAddress(event?.market?.poolAddress || event?.market?.pool || event?.market?.pairAddress);
  return {
    id: `target:ponfun:${digest({ lifecycleKey, targetAssetKey })}`,
    platformId: "ponfun",
    lifecycleKey,
    contextAssetKey,
    targetAssetKey,
    chainId: 4663,
    ca: coin,
    poolAddress: marketPool,
    eligible: Boolean(proofValid),
    reasons: proofValid ? [] : ["target_source_proof_invalid"],
    occurredAt: iso(event?.blockTimestamp || event?.observedAt),
    observedAt: iso(event?.observedAt) || admittedAt,
    sourceProof: {
      kind: "pon_verified_market_created",
      eventKey: lifecycleKey,
      blockNumber: Number.isSafeInteger(blockNumber) && blockNumber >= 0 ? blockNumber : null,
      transactionHash,
      blockHash,
      logIndex: Number.isSafeInteger(logIndex) ? logIndex : null,
      coin,
      stockToken,
      receiptVerified: event?.evidence?.receiptVerified === true,
    },
    rawEventKey: eventIdentity(event),
    createdAt: admittedAt,
    updatedAt: admittedAt,
  };
}

function flapTargetRecord(event, admittedAt) {
  if (event?.type !== "bsc_launchpad_update" || event?.kind !== "flap_pool_token"
    || Number(event?.chainId) !== 56 || lower(event?.featurePlatform) !== "flap") return null;
  const token = uniqueExactAddress([
    event?.tokens?.[0]?.token,
    event?.featureTokenProof?.tokenAddress,
  ]);
  const quote = uniqueExactAddress([
    event?.mode?.quoteAsset,
    event?.featureTokenProof?.quoteAddress,
  ]);
  const lifecycleKey = clean(event?.featureActivationKey, 512);
  const generationKey = clean(event?.featureGenerationKey, 512);
  const proofActivation = clean(event?.featureTokenProof?.activationId, 512);
  const pool = token && quote ? poolAddressFrom(event, token, quote, { required: true }) : null;
  const transactionHash = exactHash(event?.transactionHash);
  const blockHash = exactHash(event?.blockHash);
  const blockNumber = Number(event?.blockNumber);
  const proofValid = token && quote && token !== quote && lifecycleKey
    && lifecycleKey === generationKey
    && lifecycleKey === proofActivation
    && event?.featureTokenProof?.canonical === true
    && event?.featureTrackedToken === true
    && Number(event?.featureTokenOrdinal) >= 1
    && Number(event?.featureTokenOrdinal) <= 3
    && event?.structural?.eligible === true
    && event?.structural?.causalTokenEvent === true
    && transactionHash
    && blockHash
    && Number.isSafeInteger(blockNumber)
    && blockNumber >= 0
    && pool;
  if (!token || !quote || !lifecycleKey) return null;
  const targetAssetKey = assetKey(56, token);
  const contextAssetKey = assetKey(56, quote);
  return {
    id: `target:flap:${digest({ lifecycleKey, targetAssetKey, poolAddress: pool?.address || null })}`,
    platformId: "flap",
    lifecycleKey,
    contextAssetKey,
    targetAssetKey,
    chainId: 56,
    ca: token,
    poolAddress: pool?.address || null,
    eligible: Boolean(proofValid),
    reasons: proofValid ? [] : ["target_source_proof_invalid"],
    occurredAt: iso(event?.blockTimestamp || event?.observedAt),
    observedAt: iso(event?.observedAt) || admittedAt,
    sourceProof: {
      kind: "flap_verified_first_three_token",
      eventKey: clean(event?.eventKey, 512),
      activationEventKey: clean(event?.featureTokenProof?.activationEventKey, 512) || null,
      lifecycleKey,
      blockNumber: Number.isSafeInteger(blockNumber) && blockNumber >= 0 ? blockNumber : null,
      transactionHash,
      blockHash,
      logIndex: Number.isSafeInteger(Number(event?.logIndex)) ? Number(event.logIndex) : null,
      quoteAddress: quote,
      tokenAddress: token,
      poolAddress: pool?.address || null,
      pair: pool?.pair || null,
    },
    rawEventKey: eventIdentity(event),
    createdAt: admittedAt,
    updatedAt: admittedAt,
  };
}

function fourTargetRecord(event, admittedAt) {
  const platform = lower(event?.featurePlatform || event?.platform?.id);
  if (event?.type !== "bsc_launchpad_update" || Number(event?.chainId) !== 56
    || !["fourmeme", "openfour"].includes(platform)
    || event?.featureFirstToken !== true) return null;
  const token = uniqueExactAddress([
    event?.tokens?.[0]?.token ?? event?.tokens?.[0]?.address,
    event?.token?.address,
  ]);
  const quote = uniqueExactAddress([
    event?.mode?.quoteAsset,
    event?.token?.quoteAsset,
  ].filter((value) => value != null));
  const lifecycleKey = clean(event?.featureActivationKey || event?.lifecycleKey, 512);
  const generationKey = clean(event?.featureGenerationKey || lifecycleKey, 512);
  const pool = token && quote ? poolAddressFrom(event, token, quote) : null;
  const transactionHash = exactHash(event?.transactionHash);
  const blockHash = exactHash(event?.blockHash);
  const blockNumber = Number(event?.blockNumber);
  const sourceOfficial = lower(event?.source?.trust) === "official_verified"
    || lower(event?.platform?.trust) === "official_verified"
    || (event?.structural?.eligible === true
      && ["official_onchain_core", "official_api", "verified_receipt"].includes(lower(event?.structural?.source)));
  const proofValid = token && quote && token !== quote && lifecycleKey
    && lifecycleKey === generationKey
    && event?.officialFirstToken === true
    && event?.structural?.eligible === true
    && sourceOfficial
    && transactionHash
    && blockHash
    && Number.isSafeInteger(blockNumber)
    && blockNumber >= 0;
  if (!token || !quote || !lifecycleKey) return null;
  const targetAssetKey = assetKey(56, token);
  const contextAssetKey = assetKey(56, quote);
  return {
    id: `target:fourmeme:${digest({ lifecycleKey, targetAssetKey, poolAddress: pool?.address || null })}`,
    platformId: "fourmeme",
    lifecycleKey,
    contextAssetKey,
    targetAssetKey,
    chainId: 56,
    ca: token,
    poolAddress: pool?.address || null,
    eligible: Boolean(proofValid),
    reasons: proofValid ? [] : ["target_source_proof_invalid"],
    occurredAt: iso(event?.blockTimestamp || event?.sourceOccurredAt || event?.observedAt),
    observedAt: iso(event?.observedAt) || admittedAt,
    sourceProof: {
      kind: "four_verified_first_token",
      eventKey: clean(event?.eventKey, 512),
      lifecycleKey,
      capabilityEventKey: clean(event?.capabilityEventKey, 512) || null,
      blockNumber: Number.isSafeInteger(blockNumber) && blockNumber >= 0 ? blockNumber : null,
      transactionHash,
      blockHash,
      logIndex: Number.isSafeInteger(Number(event?.logIndex)) ? Number(event.logIndex) : null,
      quoteAddress: quote,
      tokenAddress: token,
      poolAddress: pool?.address || null,
    },
    rawEventKey: eventIdentity(event),
    createdAt: admittedAt,
    updatedAt: admittedAt,
  };
}

function targetRecordFor(event, admittedAt) {
  return ponTargetRecord(event, admittedAt)
    || flapTargetRecord(event, admittedAt)
    || fourTargetRecord(event, admittedAt);
}

function poolShapedEvent(event) {
  return event?.type === "platform_capability_update"
    || event?.type === "bsc_launchpad_update"
    || event?.type === "pon_fun_update";
}

function adapterFunction(adapter) {
  if (typeof adapter === "function") return adapter;
  if (typeof adapter?.adapt === "function") return adapter.adapt.bind(adapter);
  if (typeof adapter?.normalize === "function") return adapter.normalize.bind(adapter);
  throw new TypeError("narrativeAdapter must be a function or expose adapt(rawEvent, context)");
}

function assessorFunction(provider) {
  if (typeof provider?.assess === "function") return provider.assess.bind(provider);
  if (typeof provider === "function") return provider;
  throw new TypeError("liveEvidenceProvider must expose assess(candidate)");
}

function normalizeHeadline(value) {
  if (typeof value === "string") {
    const text = clean(value, 500);
    return { zh: text, en: text };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { zh: "", en: "" };
  return { zh: clean(value.zh, 500), en: clean(value.en, 500) };
}

function validPercent(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100 ? numeric : null;
}

function adaptedSubjectKeys(adapted, evidence) {
  const values = [
    adapted?.contextAssetKey,
    adapted?.subjectAssetKey,
    evidence?.contextAssetKey,
    evidence?.subjectAssetKey,
    ...(Array.isArray(adapted?.contextAssetKeys) ? adapted.contextAssetKeys : []),
    ...(Array.isArray(adapted?.subjectAssetKeys) ? adapted.subjectAssetKeys : []),
    ...(Array.isArray(adapted?.assetKeys) ? adapted.assetKeys : []),
  ];
  return [...new Set(values.map(exactAssetKey).filter(Boolean))].sort();
}

function normalizeAdaptedNews(rawEvent, adaptedValue, admittedAt) {
  const values = Array.isArray(adaptedValue) ? adaptedValue : adaptedValue ? [adaptedValue] : [];
  return values.flatMap((adapted, index) => {
    const evidence = adapted?.narrativeEvidence || adapted?.evidence || adapted;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [];
    const telegram = rawEvent?.type === "telegram_news_update";
    const sourceKind = telegram
      ? "public_telegram_observed"
      : clean(evidence.sourceKind, 100) || null;
    const sourceUrl = safeUrl(telegram ? rawEvent?.messageUrl : evidence.sourceUrl);
    const publishedAt = iso(telegram ? rawEvent?.sourceOccurredAt : evidence.publishedAt);
    const headline = normalizeHeadline(evidence.headline || rawEvent?.title || rawEvent?.headline);
    const subjectAssetKeys = adaptedSubjectKeys(adapted, evidence);
    const scoresValid = [evidence.strength, evidence.novelty, evidence.mechanismConfidence]
      .filter((value) => value != null)
      .every((value) => validPercent(value) != null);
    const structurallyValid = Boolean(sourceKind && sourceUrl && publishedAt
      && (headline.zh || headline.en) && scoresValid);
    const subjectMatch = evidence.subjectMatch === true && subjectAssetKeys.length > 0;
    const verified = !telegram && evidence.verified === true && structurallyValid;
    const evidenceKey = clean(adapted?.evidenceKey || evidence?.evidenceKey || rawEvent?.eventKey, 512)
      || digest({ rawEventKey: eventIdentity(rawEvent), index, sourceKind, sourceUrl, publishedAt, headline });
    const narrativeEvidence = {
      verified,
      sourceKind,
      sourceUrl,
      publishedAt,
      headline,
      subjectMatch,
      strength: validPercent(evidence.strength) ?? 0,
      novelty: validPercent(evidence.novelty) ?? 0,
      mechanismConfidence: validPercent(evidence.mechanismConfidence) ?? 0,
      ...(Number.isFinite(Number(evidence.halfLifeMs)) && Number(evidence.halfLifeMs) > 0
        ? { halfLifeMs: Number(evidence.halfLifeMs) }
        : {}),
      ...(evidence.mechanism ? { mechanism: clone(evidence.mechanism) } : {}),
      ...(evidence.capitalFlow ? { capitalFlow: clone(evidence.capitalFlow) } : {}),
    };
    const id = `news:${digest({ evidenceKey, sourceKind, sourceUrl })}`;
    return [{
      id,
      evidenceKey,
      subjectAssetKeys,
      narrativeEvidence,
      structurallyValid,
      reasons: [
        ...(!structurallyValid ? ["narrative_evidence_invalid"] : []),
        ...(!subjectMatch ? ["subject_asset_key_missing_or_unmatched"] : []),
        ...(telegram ? ["telegram_observation_never_verifies_underlying_news"] : []),
      ],
      rawEventKey: eventIdentity(rawEvent),
      payloadDigest: digest({ evidenceKey, subjectAssetKeys, narrativeEvidence }),
      publishedAt,
      observedAt: iso(rawEvent?.observedAt) || admittedAt,
      createdAt: admittedAt,
      updatedAt: admittedAt,
    }];
  });
}

function candidatePrecheck(news, target, current, policy) {
  const reasons = [];
  const publishedMs = Date.parse(news?.narrativeEvidence?.publishedAt || "");
  const poolMs = Date.parse(target?.occurredAt || "");
  if (!news?.structurallyValid) reasons.push("narrative_evidence_invalid");
  if (news?.narrativeEvidence?.verified !== true) reasons.push("narrative_unverified");
  if (news?.narrativeEvidence?.subjectMatch !== true) reasons.push("subject_match_missing");
  if (!Number.isFinite(publishedMs)) reasons.push("news_time_invalid");
  else if (publishedMs - current > policy.futureSkewMs) reasons.push("news_time_future");
  else if (current - publishedMs > policy.newsRealtimeMs) {
    reasons.push(current - publishedMs <= policy.newsRetentionMs ? "news_late" : "news_expired");
  }
  if (!Number.isFinite(poolMs)) reasons.push("pool_time_invalid");
  else if (poolMs - current > policy.futureSkewMs) reasons.push("pool_time_future");
  else if (current - poolMs > policy.poolRealtimeMs) reasons.push("pool_not_realtime");
  return [...new Set(reasons)];
}

function joinedEvent(candidate, news, context, target) {
  const narrative = news.narrativeEvidence;
  return {
    type: "new_pool_narrative_candidate",
    eventKey: candidate.id,
    platform: { id: context.platformId, name: context.platformId },
    title: clone(narrative.headline),
    headline: clone(narrative.headline),
    ...(narrative.mechanism ? { mechanism: clone(narrative.mechanism) } : {}),
    ...(narrative.capitalFlow ? { capitalFlow: clone(narrative.capitalFlow) } : {}),
    occurredAt: narrative.publishedAt,
    publishedAt: narrative.publishedAt,
    poolOccurredAt: target.occurredAt,
    contextEventKey: context.rawEventKey,
    targetEventKey: target.rawEventKey,
    lifecycleKey: context.lifecycleKey,
    sourceProof: {
      context: clone(context.sourceProof),
      target: clone(target.sourceProof),
    },
  };
}

function compactResult(value) {
  if (value == null) return null;
  try {
    const serialized = stableJson(value);
    return serialized.length <= 8_000 ? JSON.parse(serialized) : { status: clean(value?.status || "accepted", 80), truncated: true };
  } catch {
    return { status: clean(value?.status || "accepted", 80), nonSerializable: true };
  }
}

function safeShadowDo(signal) {
  return signal?.decision === "do"
    && signal?.shadowOrder?.mode === "shadow"
    && signal?.shadowOrder?.executable === false
    && lower(signal?.shadowOrder?.side) === "buy"
    && exactAddress(signal?.shadowOrder?.ca)
    && Number.isSafeInteger(Number(signal?.shadowOrder?.chainId))
    && Number(signal.shadowOrder.chainId) > 0;
}

export function createNarrativeSniperMonitor(config = {}, dependencies = {}) {
  if (!config.dataDir && !dependencies.stateFile) {
    throw new TypeError("narrative sniper monitor requires config.dataDir or dependencies.stateFile");
  }
  const adaptNarrative = adapterFunction(dependencies.narrativeAdapter);
  const assessLiveEvidence = assessorFunction(dependencies.liveEvidenceProvider);
  const deriveSignal = dependencies.deriveSignal || deriveNarrativeTradeSignal;
  if (typeof deriveSignal !== "function") throw new TypeError("deriveSignal must be a function");
  const sendSignal = dependencies.sendSignal || (async () => ({ status: "disabled", reason: "sendSignal_not_configured" }));
  if (typeof sendSignal !== "function") throw new TypeError("sendSignal must be a function");
  const ledgerAdmit = typeof dependencies.ledger === "function"
    ? dependencies.ledger
    : typeof dependencies.ledger?.admit === "function"
      ? dependencies.ledger.admit.bind(dependencies.ledger)
      : async () => ({ status: "disabled", reason: "ledger_not_configured" });
  const now = dependencies.now || Date.now;
  const fsImpl = dependencies.fs || dependencies.fsImpl || fs;
  const timers = dependencies.timers || globalThis;
  const stateFile = dependencies.stateFile || path.join(config.dataDir, "narrative-sniper-state.json");
  const limits = {
    inbox: boundedInteger(config.narrativeSniperMaxInbox, DEFAULT_LIMITS.inbox),
    admissions: boundedInteger(config.narrativeSniperMaxAdmissions, DEFAULT_LIMITS.admissions),
    news: boundedInteger(config.narrativeSniperMaxNews, DEFAULT_LIMITS.news),
    contexts: boundedInteger(config.narrativeSniperMaxContexts, DEFAULT_LIMITS.contexts),
    targets: boundedInteger(config.narrativeSniperMaxTargets, DEFAULT_LIMITS.targets),
    candidates: boundedInteger(config.narrativeSniperMaxCandidates, DEFAULT_LIMITS.candidates),
    signals: boundedInteger(config.narrativeSniperMaxSignals, DEFAULT_LIMITS.signals),
    errors: boundedInteger(config.narrativeSniperMaxErrors, DEFAULT_LIMITS.errors),
  };
  const maximumRawBytes = boundedInteger(config.narrativeSniperMaxRawEventBytes, DEFAULT_MAX_RAW_EVENT_BYTES, 1_024, 4 * 1024 * 1024);
  const checkBatch = boundedInteger(config.narrativeSniperCheckBatch, DEFAULT_CHECK_BATCH, 1, 1_000);
  const policy = {
    newsRealtimeMs: nonNegativeNumber(config.narrativeSniperNewsRealtimeMs, DEFAULT_NEWS_REALTIME_MS),
    newsRetentionMs: nonNegativeNumber(config.narrativeSniperNewsRetentionMs, DEFAULT_NEWS_RETENTION_MS),
    poolRealtimeMs: nonNegativeNumber(config.narrativeSniperPoolRealtimeMs, DEFAULT_POOL_REALTIME_MS),
    futureSkewMs: nonNegativeNumber(config.narrativeSniperFutureSkewMs, DEFAULT_FUTURE_SKEW_MS),
    effectRetryBaseMs: nonNegativeNumber(config.narrativeSniperEffectRetryBaseMs, DEFAULT_EFFECT_RETRY_BASE_MS),
    effectRetryMaxMs: nonNegativeNumber(config.narrativeSniperEffectRetryMaxMs, DEFAULT_EFFECT_RETRY_MAX_MS),
  };
  let state = null;
  let initializePromise = null;
  let writeSerial = Promise.resolve();
  let activeCheck = null;
  let rerunRequested = false;
  let scheduledTimer = null;
  let periodicTimer = null;
  let stopped = false;
  let volatileError = null;

  function boundState(draft) {
    draft.admissions = pruneObject(draft.admissions, limits.admissions);
    draft.news = pruneObject(draft.news, limits.news);
    draft.contexts = pruneObject(draft.contexts, limits.contexts);
    draft.targets = pruneObject(draft.targets, limits.targets);
    draft.candidates = pruneObject(draft.candidates, limits.candidates);
    draft.signals = pruneObject(draft.signals, limits.signals);
    draft.errors = (draft.errors || []).slice(-limits.errors);
  }

  async function initialize() {
    if (state) return state;
    if (!initializePromise) {
      initializePromise = (async () => {
        const createdAt = iso(nowMs(now));
        try {
          const loaded = JSON.parse(await fsImpl.readFile(stateFile, "utf8"));
          state = normalizeState(loaded, createdAt);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          state = emptyState(createdAt);
        }
        boundState(state);
        return state;
      })();
    }
    return initializePromise;
  }

  function mutateState(mutation, { writeIf = () => true } = {}) {
    const operation = writeSerial.catch(() => {}).then(async () => {
      await initialize();
      const draft = clone(state);
      const result = await mutation(draft);
      if (!writeIf(result)) return result;
      draft.updatedAt = iso(nowMs(now));
      boundState(draft);
      await atomicWriteNarrativeSniperState(stateFile, draft, fsImpl);
      state = draft;
      volatileError = null;
      return result;
    });
    writeSerial = operation.catch(() => {});
    return operation;
  }

  async function snapshot() {
    await initialize();
    await writeSerial.catch(() => {});
    return clone(state);
  }

  function scheduleCheck() {
    if (stopped || config.narrativeSniperAutoCheckOnObserve === false || scheduledTimer != null) return;
    scheduledTimer = timers.setTimeout(() => {
      scheduledTimer = null;
      void check().catch(() => {});
    }, 0);
    scheduledTimer?.unref?.();
  }

  async function observe(rawEvent) {
    if (stopped) return { status: "stopped", admitted: false };
    let serialized;
    let event;
    try {
      serialized = stableJson(rawEvent);
      if (!serialized || serialized.length > maximumRawBytes) throw new Error("raw event exceeds the local admission limit");
      event = JSON.parse(serialized);
      if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("raw event must be an object");
    } catch (error) {
      volatileError = { stage: "admission_validation", message: clean(error?.message || error, 500), occurredAt: iso(nowMs(now)) };
      return { status: "error", admitted: false, reason: volatileError.message };
    }
    const rawEventKey = eventIdentity(event);
    const payloadDigest = digest(serialized);
    const admissionId = `admission:${digest({ rawEventKey, payloadDigest })}`;
    try {
      const result = await mutateState((draft) => {
        if (draft.inbox[admissionId] || draft.admissions[admissionId]) {
          return { changed: false, status: "duplicate", admitted: false, admissionId, rawEventKey };
        }
        const admittedAt = iso(nowMs(now));
        if (Object.keys(draft.inbox).length >= limits.inbox) {
          addError(draft, "admission_capacity", "narrative sniper inbox capacity exceeded", admittedAt, { admissionId, rawEventKey });
          return { changed: true, status: "error", admitted: false, admissionId, rawEventKey, reason: "inbox_capacity_exceeded" };
        }
        draft.inbox[admissionId] = {
          id: admissionId,
          rawEventKey,
          payloadDigest,
          rawEvent: event,
          admittedAt,
          createdAt: admittedAt,
          updatedAt: admittedAt,
        };
        draft.health.status = "pending";
        return { changed: true, status: "admitted", admitted: true, admissionId, rawEventKey };
      }, { writeIf: (result) => result.changed !== false });
      if (result.admitted) scheduleCheck();
      const { changed: _changed, ...publicResult } = result;
      return publicResult;
    } catch (error) {
      volatileError = { stage: "admission_write", message: clean(error?.message || error, 500), occurredAt: iso(nowMs(now)) };
      return { status: "error", admitted: false, admissionId, rawEventKey, reason: volatileError.message };
    }
  }

  function mergeRecord(draft, collection, record, timestamp, admissionId) {
    const existing = draft[collection][record.id];
    if (!existing) {
      draft[collection][record.id] = record;
      return;
    }
    const existingDigest = digest({ ...existing, createdAt: null, updatedAt: null });
    const incomingDigest = digest({ ...record, createdAt: null, updatedAt: null });
    if (existingDigest === incomingDigest) {
      existing.updatedAt = timestamp;
      return;
    }
    if (collection === "news" && existing.payloadDigest === record.payloadDigest) {
      existing.updatedAt = timestamp;
      return;
    }
    existing.eligible = false;
    existing.conflict = true;
    existing.reasons = [...new Set([...(existing.reasons || []), `${collection}_identity_conflict`])];
    existing.updatedAt = timestamp;
    addError(draft, `${collection}_identity_conflict`, `conflicting payload for ${record.id}`, timestamp, { admissionId, recordId: record.id });
  }

  async function processAdmission(admissionId) {
    const current = await snapshot();
    const admitted = current.inbox[admissionId];
    if (!admitted) return { status: "missing" };
    const timestamp = iso(nowMs(now));
    try {
      const event = admitted.rawEvent;
      let contexts = [];
      let target = null;
      if (poolShapedEvent(event)) {
        contexts = contextRecordsFor(event, admitted.admittedAt);
        target = targetRecordFor(event, admitted.admittedAt);
      }
      let news = [];
      if (!poolShapedEvent(event)) {
        const adapted = await adaptNarrative(clone(event), {
          asOf: timestamp,
          rawEventKey: admitted.rawEventKey,
        });
        news = normalizeAdaptedNews(event, adapted, admitted.admittedAt);
      }
      await mutateState((draft) => {
        if (!draft.inbox[admissionId]) return { changed: false };
        for (const record of contexts) mergeRecord(draft, "contexts", record, timestamp, admissionId);
        if (target) mergeRecord(draft, "targets", target, timestamp, admissionId);
        for (const record of news) mergeRecord(draft, "news", record, timestamp, admissionId);
        draft.admissions[admissionId] = {
          id: admissionId,
          rawEventKey: admitted.rawEventKey,
          payloadDigest: admitted.payloadDigest,
          status: contexts.length || target || news.length ? "processed" : "ignored",
          contextIds: contexts.map((record) => record.id),
          targetIds: target ? [target.id] : [],
          newsIds: news.map((record) => record.id),
          admittedAt: admitted.admittedAt,
          processedAt: timestamp,
          createdAt: admitted.admittedAt,
          updatedAt: timestamp,
        };
        delete draft.inbox[admissionId];
        return { changed: true };
      }, { writeIf: (result) => result.changed !== false });
      return { status: "processed", contexts: contexts.length, targets: target ? 1 : 0, news: news.length };
    } catch (error) {
      await mutateState((draft) => {
        const pending = draft.inbox[admissionId];
        if (!pending) return { changed: false };
        addError(draft, "admission_processing", error, timestamp, { admissionId, rawEventKey: pending.rawEventKey });
        draft.admissions[admissionId] = {
          id: admissionId,
          rawEventKey: pending.rawEventKey,
          payloadDigest: pending.payloadDigest,
          status: "error",
          outcome: "watch",
          error: clean(error?.message || error, 500),
          admittedAt: pending.admittedAt,
          processedAt: timestamp,
          createdAt: pending.admittedAt,
          updatedAt: timestamp,
        };
        delete draft.inbox[admissionId];
        return { changed: true };
      }, { writeIf: (result) => result.changed !== false }).catch(() => {});
      return { status: "error", error: clean(error?.message || error, 500) };
    }
  }

  async function discoverCandidates() {
    const timestampMs = nowMs(now);
    const timestamp = iso(timestampMs);
    return mutateState((draft) => {
      let created = 0;
      for (const context of Object.values(draft.contexts)) {
        if (context?.eligible !== true || context?.conflict === true) continue;
        for (const target of Object.values(draft.targets)) {
          if (target?.eligible !== true || target?.conflict === true
            || target.platformId !== context.platformId
            || target.lifecycleKey !== context.lifecycleKey
            || target.contextAssetKey !== context.contextAssetKey) continue;
          for (const news of Object.values(draft.news)) {
            if (!news?.subjectAssetKeys?.includes(context.contextAssetKey)) continue;
            const id = `candidate:${digest({ newsId: news.id, contextId: context.id, targetId: target.id })}`;
            if (draft.candidates[id]) continue;
            const reasons = candidatePrecheck(news, target, timestampMs, policy);
            draft.candidates[id] = {
              id,
              newsId: news.id,
              contextId: context.id,
              targetId: target.id,
              platformId: context.platformId,
              lifecycleKey: context.lifecycleKey,
              contextAssetKey: context.contextAssetKey,
              targetAssetKey: target.targetAssetKey,
              status: reasons.length ? "watch" : "pending",
              outcome: reasons.length ? "watch" : null,
              reasons,
              attempts: 0,
              decisionHash: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            };
            created += 1;
          }
        }
      }
      return { changed: created > 0, created };
    }, { writeIf: (result) => result.changed });
  }

  function assessmentTargetEvidence(target, assessment) {
    const supplied = assessment?.targetEvidence && typeof assessment.targetEvidence === "object"
      ? assessment.targetEvidence
      : {};
    const suppliedAddresses = [supplied.ca, supplied.address, supplied.tokenAddress, supplied.targetAddress]
      .filter((value) => value != null);
    if (suppliedAddresses.some((value) => exactAddress(value) !== target.ca)) {
      throw new Error("live evidence target address conflicts with the admitted target CA");
    }
    const suppliedChains = [supplied.chainId, supplied.chain?.id, supplied.chain?.chainId]
      .filter((value) => value != null);
    if (suppliedChains.some((value) => Number(value) !== target.chainId)) {
      throw new Error("live evidence chain conflicts with the admitted target chain");
    }
    const suppliedPool = exactAddress(supplied.poolAddress || supplied.pool?.address || supplied.pool?.pool);
    if (target.poolAddress && suppliedPool && target.poolAddress !== suppliedPool) {
      throw new Error("live evidence pool conflicts with the admitted pool address");
    }
    return {
      ...clone(supplied),
      chainId: target.chainId,
      ca: target.ca,
      poolAddress: target.poolAddress || suppliedPool || null,
      caVerified: true,
      poolVerified: supplied.poolVerified === true || Boolean(target.poolAddress),
      assetKey: target.targetAssetKey,
    };
  }

  async function recordCandidateError(candidateId, stage, error) {
    const timestamp = iso(nowMs(now));
    await mutateState((draft) => {
      const candidate = draft.candidates[candidateId];
      if (!candidate) return { changed: false };
      candidate.status = "watch";
      candidate.outcome = "watch";
      candidate.error = { stage, message: clean(error?.message || error, 500), occurredAt: timestamp };
      candidate.reasons = [...new Set([...(candidate.reasons || []), `${stage}_error`])];
      candidate.updatedAt = timestamp;
      addError(draft, stage, error, timestamp, { candidateId });
      return { changed: true };
    }, { writeIf: (result) => result.changed !== false }).catch(() => {});
  }

  async function runSignalEffects(decisionHash) {
    let current = await snapshot();
    let record = current.signals[decisionHash];
    if (!record || !safeShadowDo(record.signal)) return { ledger: false, sent: false };
    const candidate = current.candidates[record.candidateId] || null;
    const target = candidate ? current.targets[candidate.targetId] || null : null;
    const effectDue = (effect, currentMs) => ["pending", "submitting"].includes(effect?.status)
      || (effect?.status === "failed"
        && Number.isFinite(Date.parse(effect?.nextAttemptAt || ""))
        && Date.parse(effect.nextAttemptAt) <= currentMs);
    const attemptMs = nowMs(now);
    const needsLedger = effectDue(record.ledger, attemptMs);
    const needsSend = effectDue(record.delivery, attemptMs);
    if (!needsLedger && !needsSend) return { ledger: false, sent: false };
    const timestamp = iso(nowMs(now));
    await mutateState((draft) => {
      const live = draft.signals[decisionHash];
      if (!live || !safeShadowDo(live.signal)) return { changed: false };
      if (needsLedger && ["pending", "submitting"].includes(live.ledger?.status)) {
        live.ledger = {
          ...live.ledger,
          status: "submitting",
          attempts: Number(live.ledger?.attempts || 0) + 1,
          attemptedAt: timestamp,
          nextAttemptAt: null,
        };
      }
      if (needsLedger && live.ledger?.status === "failed") {
        live.ledger = {
          ...live.ledger,
          status: "submitting",
          attempts: Number(live.ledger?.attempts || 0) + 1,
          attemptedAt: timestamp,
          nextAttemptAt: null,
        };
      }
      if (needsSend && ["pending", "submitting", "failed"].includes(live.delivery?.status)) {
        live.delivery = {
          ...live.delivery,
          status: "submitting",
          attempts: Number(live.delivery?.attempts || 0) + 1,
          attemptedAt: timestamp,
          nextAttemptAt: null,
        };
      }
      live.updatedAt = timestamp;
      return { changed: true };
    }, { writeIf: (result) => result.changed !== false });

    let ledgerResult = null;
    let ledgerError = null;
    if (needsLedger) {
      try {
        ledgerResult = await ledgerAdmit(clone(record.signal), {
          mode: "shadow",
          decisionHash,
          candidateId: record.candidateId,
          idempotencyKey: decisionHash,
          sourceProof: {
            eventKey: clean(record.signal?.event?.eventKey || record.signal?.inputEventKey, 512),
            stableEventKey: clean(target?.sourceProof?.eventKey || target?.rawEventKey, 512),
            chainId: target?.chainId,
            blockNumber: target?.sourceProof?.blockNumber,
            blockHash: target?.sourceProof?.blockHash,
            transactionHash: target?.sourceProof?.transactionHash,
            logIndex: target?.sourceProof?.logIndex,
            observedAt: target?.observedAt,
          },
        });
      } catch (error) {
        ledgerError = error;
      }
    }
    let sendResult = null;
    let sendError = null;
    if (needsSend) {
      try {
        sendResult = await sendSignal(clone(record.signal), {
          mode: "shadow",
          decisionHash,
          candidate: clone(candidate),
          idempotencyKey: decisionHash,
        });
      } catch (error) {
        sendError = error;
      }
    }
    const completedAt = iso(nowMs(now));
    await mutateState((draft) => {
      const live = draft.signals[decisionHash];
      if (!live || !safeShadowDo(live.signal)) return { changed: false };
      if (needsLedger) {
        const attempts = Math.max(1, Number(live.ledger?.attempts || 1));
        const delayMs = Math.min(policy.effectRetryMaxMs,
          policy.effectRetryBaseMs * (2 ** Math.min(10, attempts - 1)));
        live.ledger = ledgerError
          ? {
            ...live.ledger,
            status: "failed",
            error: clean(ledgerError?.message || ledgerError, 500),
            completedAt,
            nextAttemptAt: iso(Date.parse(completedAt) + delayMs),
          }
          : { ...live.ledger, status: "admitted", result: compactResult(ledgerResult), error: null, completedAt, nextAttemptAt: null };
      }
      if (needsSend) {
        const attempts = Math.max(1, Number(live.delivery?.attempts || 1));
        const delayMs = Math.min(policy.effectRetryMaxMs,
          policy.effectRetryBaseMs * (2 ** Math.min(10, attempts - 1)));
        live.delivery = sendError
          ? {
            ...live.delivery,
            status: "failed",
            error: clean(sendError?.message || sendError, 500),
            completedAt,
            nextAttemptAt: iso(Date.parse(completedAt) + delayMs),
          }
          : { ...live.delivery, status: "sent", result: compactResult(sendResult), error: null, completedAt, nextAttemptAt: null };
      }
      live.updatedAt = completedAt;
      if (ledgerError) addError(draft, "ledger_admit", ledgerError, completedAt, { decisionHash, candidateId: live.candidateId });
      if (sendError) addError(draft, "signal_delivery", sendError, completedAt, { decisionHash, candidateId: live.candidateId });
      return { changed: true };
    }, { writeIf: (result) => result.changed !== false }).catch(() => {});
    return { ledger: needsLedger, sent: needsSend, ledgerError, sendError };
  }

  async function assessCandidate(candidateId) {
    let current = await snapshot();
    const candidate = current.candidates[candidateId];
    if (!candidate || !["pending", "assessing"].includes(candidate.status)) return { status: "skipped" };
    const news = current.news[candidate.newsId];
    const context = current.contexts[candidate.contextId];
    const target = current.targets[candidate.targetId];
    if (!news || !context || !target
      || context.eligible !== true || target.eligible !== true
      || context.lifecycleKey !== target.lifecycleKey
      || context.contextAssetKey !== target.contextAssetKey
      || !news.subjectAssetKeys?.includes(context.contextAssetKey)) {
      await recordCandidateError(candidateId, "candidate_revalidation", "candidate lost its exact context/target/news binding");
      return { status: "error" };
    }
    const assessingAt = iso(nowMs(now));
    await mutateState((draft) => {
      const live = draft.candidates[candidateId];
      if (!live || !["pending", "assessing"].includes(live.status)) return { changed: false };
      live.status = "assessing";
      live.attempts = Number(live.attempts || 0) + 1;
      live.updatedAt = assessingAt;
      return { changed: true };
    }, { writeIf: (result) => result.changed !== false });
    try {
      const asOf = iso(nowMs(now));
      const assessment = await assessLiveEvidence({
        candidate: clone(candidate),
        news: clone(news),
        context: clone(context),
        target: clone(target),
        asOf,
        sourceProof: {
          context: clone(context.sourceProof),
          target: clone(target.sourceProof),
        },
      });
      if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) {
        throw new Error("liveEvidenceProvider.assess must return an evidence object");
      }
      const targetEvidence = assessmentTargetEvidence(target, assessment);
      const signalInput = {
        event: joinedEvent(candidate, news, context, target),
        poolContext: clone(context.poolContext),
        targetEvidence,
        narrativeEvidence: clone(news.narrativeEvidence),
        marketEvidence: clone(assessment.marketEvidence || assessment.market || {}),
        riskEvidence: clone(assessment.riskEvidence || assessment.risk || {}),
        asOf,
      };
      const derived = await deriveSignal(signalInput);
      if (!derived || typeof derived !== "object" || Array.isArray(derived)) {
        throw new Error("deriveSignal must return a signal object");
      }
      if (derived.decision === "do" && !safeShadowDo(derived)) {
        throw new Error("a do decision must contain a non-executable shadow buy order");
      }
      const suppliedHash = clean(derived.decisionHash, 256);
      const decisionHash = suppliedHash || digest({ candidateId, signal: derived });
      const signal = { ...clone(derived), decisionHash };
      const signalDigest = digest(signal);
      const persistedAt = iso(nowMs(now));
      const persistence = await mutateState((draft) => {
        const live = draft.candidates[candidateId];
        if (!live) return { changed: false, duplicate: false };
        const existing = draft.signals[decisionHash];
        if (existing && existing.signalDigest !== signalDigest) {
          live.status = "watch";
          live.outcome = "watch";
          live.reasons = [...new Set([...(live.reasons || []), "decision_hash_conflict"])];
          live.updatedAt = persistedAt;
          addError(draft, "decision_hash_conflict", `decisionHash ${decisionHash} has conflicting signal payloads`, persistedAt, { candidateId, decisionHash });
          return { changed: true, duplicate: true, conflict: true };
        }
        if (!existing) {
          draft.signals[decisionHash] = {
            id: decisionHash,
            candidateId,
            decision: signal.decision,
            signal,
            signalDigest,
            ledger: signal.decision === "do" ? { status: "pending" } : null,
            delivery: signal.decision === "do" ? { status: "pending" } : null,
            createdAt: persistedAt,
            updatedAt: persistedAt,
          };
        }
        live.status = signal.decision;
        live.outcome = signal.decision;
        live.decisionHash = decisionHash;
        live.updatedAt = persistedAt;
        return { changed: true, duplicate: Boolean(existing), conflict: false };
      }, { writeIf: (result) => result.changed !== false });
      if (persistence.conflict) return { status: "watch", decisionHash };
      if (signal.decision === "do") await runSignalEffects(decisionHash);
      return { status: signal.decision, decisionHash, duplicate: persistence.duplicate };
    } catch (error) {
      await recordCandidateError(candidateId, "candidate_assessment", error);
      return { status: "error", error: clean(error?.message || error, 500) };
    }
  }

  async function resumePendingSignalEffects() {
    const current = await snapshot();
    const currentMs = nowMs(now);
    const retryable = (effect) => ["pending", "submitting"].includes(effect?.status)
      || (effect?.status === "failed"
        && Number.isFinite(Date.parse(effect?.nextAttemptAt || ""))
        && Date.parse(effect.nextAttemptAt) <= currentMs);
    const pending = Object.values(current.signals)
      .filter((record) => safeShadowDo(record?.signal)
        && (retryable(record?.ledger) || retryable(record?.delivery)))
      .sort((left, right) => stateTimestamp(left) - stateTimestamp(right))
      .slice(0, checkBatch);
    for (const record of pending) await runSignalEffects(record.id);
    return pending.length;
  }

  async function runCheck() {
    if (stopped) return { status: "stopped", processed: 0, candidates: 0, assessed: 0 };
    try {
      const current = await snapshot();
      const pendingIds = Object.values(current.inbox)
        .sort((left, right) => stateTimestamp(left) - stateTimestamp(right) || left.id.localeCompare(right.id))
        .slice(0, checkBatch)
        .map((entry) => entry.id);
      let processed = 0;
      let processingErrors = 0;
      for (const admissionId of pendingIds) {
        const result = await processAdmission(admissionId);
        if (result.status === "error") processingErrors += 1;
        else if (result.status === "processed") processed += 1;
      }
      const discovered = await discoverCandidates();
      const afterDiscovery = await snapshot();
      const candidateIds = Object.values(afterDiscovery.candidates)
        .filter((candidate) => ["pending", "assessing"].includes(candidate.status))
        .sort((left, right) => stateTimestamp(left) - stateTimestamp(right) || left.id.localeCompare(right.id))
        .slice(0, checkBatch)
        .map((candidate) => candidate.id);
      let assessed = 0;
      let assessmentErrors = 0;
      for (const candidateId of candidateIds) {
        const result = await assessCandidate(candidateId);
        if (result.status === "error") assessmentErrors += 1;
        else if (result.status !== "skipped") assessed += 1;
      }
      const resumedSignals = await resumePendingSignalEffects();
      const checkedAt = iso(nowMs(now));
      await mutateState((draft) => {
        const degraded = processingErrors > 0 || assessmentErrors > 0;
        draft.health.status = degraded ? "degraded" : Object.keys(draft.inbox).length ? "pending" : "healthy";
        draft.health.lastCheckAt = checkedAt;
        if (!degraded) {
          draft.health.lastSuccessAt = checkedAt;
          draft.health.lastErrorAt = null;
          draft.health.lastError = null;
        }
        return { changed: true };
      });
      return {
        status: processingErrors || assessmentErrors ? "degraded" : "healthy",
        processed,
        processingErrors,
        candidates: discovered.created,
        assessed,
        assessmentErrors,
        resumedSignals,
      };
    } catch (error) {
      const timestamp = iso(nowMs(now));
      volatileError = { stage: "check", message: clean(error?.message || error, 500), occurredAt: timestamp };
      await mutateState((draft) => {
        addError(draft, "check", error, timestamp);
        draft.health.lastCheckAt = timestamp;
        return { changed: true };
      }).catch(() => {});
      return { status: "error", processed: 0, candidates: 0, assessed: 0, error: volatileError.message };
    }
  }

  function check() {
    if (activeCheck) {
      rerunRequested = true;
      return activeCheck;
    }
    activeCheck = runCheck().finally(() => {
      activeCheck = null;
      if (rerunRequested && !stopped) {
        rerunRequested = false;
        scheduleCheck();
      }
    });
    return activeCheck;
  }

  async function getState() {
    const current = await snapshot();
    if (volatileError) {
      current.health = {
        ...current.health,
        status: "degraded",
        lastErrorAt: volatileError.occurredAt,
        lastError: `${volatileError.stage}: ${volatileError.message}`,
      };
    }
    return current;
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    rerunRequested = false;
    if (scheduledTimer != null) timers.clearTimeout(scheduledTimer);
    scheduledTimer = null;
    if (periodicTimer != null) timers.clearInterval(periodicTimer);
    periodicTimer = null;
    await Promise.resolve(activeCheck).catch(() => {});
    await writeSerial.catch(() => {});
  }

  if (config.narrativeSniperAutoStart === true) {
    const intervalMs = boundedInteger(config.narrativeSniperCheckIntervalMs, 5_000, 10, 60 * 60_000);
    periodicTimer = timers.setInterval(() => void check().catch(() => {}), intervalMs);
    periodicTimer?.unref?.();
  }

  return Object.freeze({
    observe,
    check,
    getState,
    stop,
    stateFile,
  });
}
