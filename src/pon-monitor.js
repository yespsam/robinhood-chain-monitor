import fs from "node:fs/promises";
import path from "node:path";
import { Interface, getAddress, id, keccak256 } from "ethers";
import { sendAlerts } from "./alerts.js";

export const PON_CHAIN_ID = 4663;
export const PON_FACTORY = "0xF698d13348686C1529c2DC54847C123424d9DAE0";
export const PON_FACTORY_START_BLOCK = 51_807_788;
export const PON_FACTORY_DEPLOY_BLOCK = 51_808_655;
export const PON_FACTORY_DEPLOY_TRANSACTION = "0x6bf0d084d6b69090a3a4e5c7b68f51fcb1dfd0485f5f0c28f2d59b4d6809654c";
export const PON_FACTORY_DEPLOY_BLOCK_HASH = "0xc5c82769065ef82318c24140226d324667853239be7c4116031a8a3da71361af";
export const PON_FACTORY_CREATION_INPUT_HASH = "0xbcf557d53fc7e5e5980ae0161e7be07c931fdcebc09d90fbdd5760c648e3b6c7";
export const PON_FACTORY_RUNTIME_HASH = "0x4cb9795396b800a4b1e46f2e91a690ecf004ac0d52b059a7ef0e6b190af17384";
export const PON_INITIAL_OWNER = "0x50CD2747eFfc8A731d52b29DaCA21dEDA05bCd57";
export const PON_INITIAL_ORACLE = "0x85a3cC5eEb0Eaa7A6BeddC8C672F67E9d5C1e377";
export const PON_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const PON_COIN_IMPL = "0xDce7031584823cf78a0F0C74814c75d9B51f5192";
export const PON_VAULT_IMPL = "0x770d9435763DBCE78F62497a4B1f4c66A3506eFc";
export const PON_CURVE_IMPL = "0x001142aFC836f703ED7568c034e288D06B5C58D4";
export const PONFUN_TOKEN = "0x7673dc6d2357bdc2e04fd80c169f2bef56622d9a";

export const PON_WEBSITE_URL = "https://www.pon.fun/";
export const PON_HEALTH_URL = "https://www.pon.fun/api/health";
export const PON_MARKETS_URL = "https://www.pon.fun/api/markets";
export const PON_PLATFORM_TOKEN_URL = "https://www.pon.fun/api/ponfun";
export const PON_TOKEN_LIST_URL = "https://www.pon.fun/tokenlist.json";
export const PON_X_URL = "https://x.com/pondotfun";
export const PON_SOURCE_ID = "pon_fun_official_api_onchain";
export const PON_SOURCE_TRUST = "official_site_bound_onchain_fingerprinted";

const STATE_VERSION = 1;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_EVENT_CHUNK_SIZE = 2_000;
const DEFAULT_MAX_BLOCKS_PER_CYCLE = 10_000;
const DEFAULT_PENDING_LIMIT = 500;
const DEFAULT_PENDING_BATCH_SIZE = 20;
const DEFAULT_VALIDATION_CONCURRENCY = 4;
const DEFAULT_PROCESSED_LIMIT = 2_000;
const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_BACKOFF_MAX_MS = 300_000;
const DEFAULT_REORG_REWIND_BLOCKS = 128;
const DEFAULT_API_MAX_BLOCK_LAG = 128;
const DEFAULT_CHECKPOINT_LIMIT = 256;
const DEFAULT_ORPHANED_EVENT_LIMIT = 500;
const INCIDENT_OPEN_FAILURES = 3;
const INCIDENT_OPEN_AGE_MS = 60_000;
const INCIDENT_RECOVERY_SUCCESSES = 2;
const INCIDENT_RECOVERY_AGE_MS = 30_000;
const DANGEROUS_RECORD_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "tostring",
  "valueof",
  "hasownproperty",
  "__definegetter__",
  "__definesetter__",
  "__lookupgetter__",
  "__lookupsetter__",
]);

const FACTORY_ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function oracle() view returns (address)",
  "function usdg() view returns (address)",
  "function swapRouter() view returns (address)",
  "function positionManager() view returns (address)",
  "function protocolTreasury() view returns (address)",
  "function paused() view returns (bool)",
  "function coinImpl() view returns (address)",
  "function vaultImpl() view returns (address)",
  "function curveImpl() view returns (address)",
  "function marketCount() view returns (uint256)",
  "function listingCount() view returns (uint256)",
  "function coinToId(address coin) view returns (uint256 idPlus1)",
  "function getMarketById(uint256 id) view returns ((address coin,address vault,address curve,address creator,uint16 creatorFeeBps,uint64 createdAt,string ticker,string symbol,string name))",
  "function getListing(string ticker) view returns ((address stockToken,uint24 poolFee,bool active,string ticker))",
  "function curveParams() view returns (uint256 p0,uint256 slope,uint256 curveCap,uint24 lpPoolFee,uint16 maxSlippageBps,bool autoAcquire)",
  "event ConfigSet(address oracle,address swapRouter,address positionManager,address treasury)",
  "event CurveParamsSet((uint256 p0,uint256 slope,uint256 curveCap,uint24 lpPoolFee,uint16 maxSlippageBps,bool autoAcquire) params)",
  "event MarketCreated(string ticker,string symbol,string name,address coin,address vault,address curve,address creator,uint16 creatorFeeBps)",
  "event StockListed(string ticker,address stockToken,uint24 poolFee,bool active)",
  "event OwnershipTransferStarted(address indexed previousOwner,address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)",
  "event Paused(address account)",
  "event Unpaused(address account)",
];

const ERC20_INTERFACE = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

export const PON_FACTORY_INTERFACE = new Interface(FACTORY_ABI);
export const PON_FACTORY_EVENT_TOPICS = Object.freeze(Object.fromEntries([
  "ConfigSet",
  "CurveParamsSet",
  "MarketCreated",
  "StockListed",
  "OwnershipTransferStarted",
  "OwnershipTransferred",
  "Paused",
  "Unpaused",
].map((name) => [name, PON_FACTORY_INTERFACE.getEvent(name).topicHash])));

const EVENT_TOPIC_SET = new Set(Object.values(PON_FACTORY_EVENT_TOPICS).map((value) => value.toLowerCase()));
const normalizeSpace = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const iso = (value) => new Date(value).toISOString();
const nowMs = (clock) => {
  const value = typeof clock === "function" ? clock() : Date.now();
  const number = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(number) ? number : Date.now();
};

function ponError(source, code, message, details = {}) {
  return Object.assign(new Error(message), { source, code, details });
}

function address(value, label) {
  try {
    const normalized = getAddress(String(value));
    if (normalized === ZERO_ADDRESS) throw new Error("zero address");
    return normalized;
  } catch {
    throw ponError("schema", "PON_INVALID_ADDRESS", `${label} is not a valid non-zero address`);
  }
}

function optionalAddress(value, label) {
  if (String(value || "").toLowerCase() === ZERO_ADDRESS) return ZERO_ADDRESS;
  return address(value, label);
}

function boundedText(value, label, maximum = 160) {
  const text = normalizeSpace(value);
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw ponError("schema", "PON_INVALID_TEXT", `${label} is invalid`);
  }
  return text;
}

function tickerText(value, label) {
  const ticker = boundedText(value, label, 24);
  if (DANGEROUS_RECORD_KEYS.has(ticker.toLowerCase())) {
    throw ponError("schema", "PON_UNSAFE_RECORD_KEY", `${label} is not a safe record key`);
  }
  return ticker;
}

function abortedError(source = "chain") {
  return ponError(source, "PON_STOPPED", "pon.fun monitor operation was stopped");
}

function abortable(promise, signal, source = "chain", abortError = () => abortedError(source)) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
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

async function mapBounded(values, concurrency, worker, shouldStop = () => false) {
  const items = Array.from(values);
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      if (shouldStop()) throw abortedError();
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function safeInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw ponError("schema", "PON_INVALID_INTEGER", `${label} is invalid`);
  }
  return number;
}

function optionalFinite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sourceHealth() {
  return {
    status: "idle",
    consecutiveFailures: 0,
    failureSince: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    lastErrorCode: null,
    nextAttemptAt: null,
  };
}

function emptyState() {
  return {
    version: STATE_VERSION,
    initialized: false,
    initializedAt: null,
    cursor: {
      nextBlock: null,
      lastScannedBlock: null,
      lastScannedBlockHash: null,
      baselineEstablishedAt: null,
      marketCountAtCursor: null,
      listingCountAtCursor: null,
      stockListingEventsSinceSnapshot: 0,
    },
    identity: {
      chainId: PON_CHAIN_ID,
      factory: PON_FACTORY,
      factoryCodeHash: PON_FACTORY_RUNTIME_HASH,
      deploymentTransaction: PON_FACTORY_DEPLOY_TRANSACTION,
      deploymentBlock: PON_FACTORY_DEPLOY_BLOCK,
      deploymentVerified: false,
    },
    infrastructure: null,
    curveParams: null,
    listings: {},
    markets: {},
    unmatchedApiMarkets: {},
    pendingMarketEvents: {},
    reorgBaselineMarketRechecks: {},
    retiredMarkets: {},
    processedEventKeys: [],
    alertOrigins: {},
    reorgOrphanedEventKeys: [],
    missedCriticalChanges: [],
    finalizedCheckpoints: [],
    apiTransitionRevisions: {},
    pendingApiTransitions: {},
    platformToken: null,
    platformTokenVerification: null,
    checkedAt: null,
    _health: {
      status: "initializing",
      checkedAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
      failureSince: null,
      recoveryConsecutive: 0,
      recoverySince: null,
      nextAttemptAt: null,
      sources: {
        api_health: sourceHealth(),
        api_markets: sourceHealth(),
        api_platform_token: sourceHealth(),
        api_token_list: sourceHealth(),
        chain: sourceHealth(),
        delivery: sourceHealth(),
      },
      identity: {
        expectedChainId: PON_CHAIN_ID,
        expectedFactory: PON_FACTORY,
        expectedFactoryCodeHash: PON_FACTORY_RUNTIME_HASH,
        observedChainId: null,
        observedFactory: null,
        observedFactoryCodeHash: null,
      },
      apiCoverage: {
        reportedBlock: null,
        finalizedBlock: null,
        blockLag: null,
        maxBlockLag: DEFAULT_API_MAX_BLOCK_LAG,
        highWaterBlock: null,
        lastVerifiedAt: null,
      },
      reorg: {
        count: 0,
        lastDetectedAt: null,
        rewindFrom: null,
        rewindTo: null,
        commonAncestorBlock: null,
        commonAncestorProven: null,
        orphanedAlertCount: 0,
        lastOrphanedAt: null,
        lastOrphanedEventKeys: [],
        midCycleAnchorFailures: 0,
      },
      missedCriticalChangeCount: 0,
      lastMissedCriticalChangeAt: null,
    },
  };
}

function stateRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function invalidState(message) {
  throw ponError("state", "PON_STATE_INVALID", `invalid pon.fun state: ${message}`);
}

function normalizeState(parsed) {
  const base = emptyState();
  if (!stateRecord(parsed)) invalidState("root must be an object");
  if (parsed.version !== STATE_VERSION) {
    throw ponError("state", "PON_STATE_VERSION_UNSUPPORTED", `unsupported pon.fun state version ${String(parsed.version)}`);
  }
  if (typeof parsed.initialized !== "boolean") invalidState("initialized must be boolean");
  for (const key of ["cursor", "identity", "listings", "markets", "unmatchedApiMarkets", "pendingMarketEvents", "_health"]) {
    if (!stateRecord(parsed[key])) invalidState(`${key} must be an object`);
  }
  if (parsed.reorgBaselineMarketRechecks !== undefined
    && !stateRecord(parsed.reorgBaselineMarketRechecks)) {
    invalidState("reorgBaselineMarketRechecks must be an object");
  }
  for (const key of ["retiredMarkets", "alertOrigins", "apiTransitionRevisions", "pendingApiTransitions"]) {
    if (parsed[key] !== undefined && !stateRecord(parsed[key])) invalidState(`${key} must be an object`);
  }
  for (const key of ["reorgOrphanedEventKeys", "finalizedCheckpoints", "missedCriticalChanges"]) {
    if (parsed[key] !== undefined && !Array.isArray(parsed[key])) invalidState(`${key} must be an array`);
  }
  for (const key of ["infrastructure", "curveParams", "platformToken", "platformTokenVerification"]) {
    if (parsed[key] !== null && !stateRecord(parsed[key])) invalidState(`${key} must be an object or null`);
  }
  if (!Array.isArray(parsed.processedEventKeys)
    || parsed.processedEventKeys.length > DEFAULT_PROCESSED_LIMIT
    || new Set(parsed.processedEventKeys).size !== parsed.processedEventKeys.length
    || parsed.processedEventKeys.some((key) => typeof key !== "string" || !key || key.length > 512)) {
    invalidState("processedEventKeys must contain bounded strings");
  }
  if (!stateRecord(parsed._health.sources)
    || !stateRecord(parsed._health.identity)
    || (parsed._health.apiCoverage !== undefined && !stateRecord(parsed._health.apiCoverage))
    || !stateRecord(parsed._health.reorg)) {
    invalidState("_health subdocuments must be objects");
  }
  if (parsed.initialized) {
    const cursor = parsed.cursor;
    if (!Number.isSafeInteger(cursor.nextBlock)
      || !Number.isSafeInteger(cursor.lastScannedBlock)
      || cursor.nextBlock !== cursor.lastScannedBlock + 1
      || cursor.lastScannedBlock < PON_FACTORY_START_BLOCK
      || !/^0x[a-fA-F0-9]{64}$/.test(String(cursor.lastScannedBlockHash || ""))
      || !Number.isSafeInteger(cursor.marketCountAtCursor)
      || cursor.marketCountAtCursor < 0
      || !Number.isSafeInteger(cursor.listingCountAtCursor)
      || cursor.listingCountAtCursor < 0
      || !Number.isSafeInteger(cursor.stockListingEventsSinceSnapshot)
      || cursor.stockListingEventsSinceSnapshot < 0
      || !Number.isFinite(Date.parse(cursor.baselineEstablishedAt))) {
      invalidState("initialized cursor is malformed");
    }
    const token = parsed.platformToken;
    const verification = parsed.platformTokenVerification;
    if (!stateRecord(token)
      || String(token.address || "").toLowerCase() !== PONFUN_TOKEN.toLowerCase()
      || token.name !== "Ponfun"
      || token.symbol !== "PONFUN"
      || !stateRecord(verification)
      || String(verification.token || "").toLowerCase() !== PONFUN_TOKEN.toLowerCase()
      || verification.codePresent !== true
      || !/^0x[a-fA-F0-9]{64}$/.test(String(verification.codeHash || ""))
      || verification.name !== token.name
      || verification.symbol !== token.symbol
      || !Number.isSafeInteger(verification.decimals)
      || verification.decimals < 0
      || verification.decimals > 255
      || !/^(?:0|[1-9]\d*)$/.test(String(verification.totalSupplyRaw || ""))
      || decimalSupplyToRaw(token.supply, verification.decimals).toString() !== String(verification.totalSupplyRaw)
      || !Number.isSafeInteger(verification.verifiedBlock)
      || verification.verifiedBlock < PON_FACTORY_DEPLOY_BLOCK
      || !/^0x[a-fA-F0-9]{64}$/.test(String(verification.verifiedBlockHash || ""))) {
      invalidState("initialized platform token verification is malformed");
    }
  }
  for (const [eventKey, pending] of Object.entries(parsed.pendingMarketEvents)) {
    if (!stateRecord(pending)
      || pending.eventKey !== eventKey
      || eventKey !== logEventKey(pending.log || {})
      || !stateRecord(pending.snapshot)
      || !stateRecord(pending.proof)
      || !stateRecord(pending.log)
      || String(pending.log.address || "").toLowerCase() !== PON_FACTORY.toLowerCase()
      || !/^0x[a-fA-F0-9]{64}$/.test(String(pending.log.transactionHash || ""))
      || !/^0x[a-fA-F0-9]{64}$/.test(String(pending.proof.transactionHash || ""))
      || String(pending.log.transactionHash || "").toLowerCase() !== String(pending.proof.transactionHash || "").toLowerCase()
      || !Number.isSafeInteger(pending.log.blockNumber)
      || pending.log.blockNumber < PON_FACTORY_DEPLOY_BLOCK
      || !Number.isSafeInteger(pending.proof.blockNumber)
      || Number(pending.log.blockNumber) !== Number(pending.proof.blockNumber)
      || !/^0x[a-fA-F0-9]{64}$/.test(String(pending.log.blockHash || ""))
      || !/^0x[a-fA-F0-9]{64}$/.test(String(pending.proof.blockHash || ""))
      || String(pending.log.blockHash || "").toLowerCase() !== String(pending.proof.blockHash || "").toLowerCase()
      || !Number.isSafeInteger(pending.proof.logIndex)
      || logIndex(pending.log) !== Number(pending.proof.logIndex)
      || String(pending.log.topics?.[0] || "").toLowerCase() !== PON_FACTORY_EVENT_TOPICS.MarketCreated.toLowerCase()
      || !sameMarketCreation(decodedSnapshot(decodedEvent(pending.log)), pending.snapshot)) {
      invalidState(`pendingMarketEvents.${eventKey} is malformed`);
    }
  }
  for (const [coin, recheck] of Object.entries(parsed.reorgBaselineMarketRechecks || {})) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(coin)
      || coin !== coin.toLowerCase()
      || !stateRecord(recheck)
      || String(recheck.coin || "").toLowerCase() !== coin
      || tickerText(recheck.ticker, `reorgBaselineMarketRechecks.${coin}.ticker`) !== recheck.ticker
      || !Number.isFinite(Date.parse(recheck.markedAt))
      || !Number.isSafeInteger(recheck.rewindFrom)
      || !Number.isSafeInteger(recheck.rewindTo)
      || !stateRecord(parsed.markets[coin])) {
      invalidState(`reorgBaselineMarketRechecks.${coin} is malformed`);
    }
  }
  for (const collection of ["markets", "unmatchedApiMarkets"]) {
    for (const [coin, market] of Object.entries(parsed[collection])) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(coin)
        || coin !== coin.toLowerCase()
        || !stateRecord(market)) invalidState(`${collection}.${coin} is malformed`);
      const candidate = market.market && stateRecord(market.market) ? market.market : market;
      if (candidate.ticker !== undefined) tickerText(candidate.ticker, `${collection}.${coin}.ticker`);
      if (candidate.coin !== undefined && String(candidate.coin).toLowerCase() !== coin) {
        invalidState(`${collection}.${coin}.coin does not match its key`);
      }
    }
  }
  for (const collection of ["listings", "retiredMarkets"]) {
    for (const [ticker, value] of Object.entries(parsed[collection] || {})) {
      if (tickerText(ticker, `${collection} key`) !== ticker || !stateRecord(value)) {
        invalidState(`${collection}.${ticker} is malformed`);
      }
      if (collection === "listings") {
        if (value.ticker !== ticker
          || typeof value.active !== "boolean"
          || !Number.isSafeInteger(value.poolFee)
          || value.poolFee < 0
          || !/^0x[a-fA-F0-9]{40}$/.test(String(value.stockToken || ""))) {
          invalidState(`${collection}.${ticker} has invalid listing fields`);
        }
      }
    }
  }
  for (const [eventKey, origin] of Object.entries(parsed.alertOrigins || {})) {
    const rollback = origin?.rollback;
    const rollbackValid = rollback == null
      || (stateRecord(rollback)
        && new Set(["market", "platform_token", "curve_params", "stock_listing", "infrastructure"]).has(rollback.type)
        && (rollback.type !== "market"
          || (/^0x[a-fA-F0-9]{40}$/.test(String(rollback.key || ""))
            && String(rollback.key) === String(rollback.key).toLowerCase()))
        && (rollback.type !== "stock_listing" || tickerText(rollback.key, `alertOrigins.${eventKey}.rollback.key`) === rollback.key)
        && (rollback.snapshot == null || stateRecord(rollback.snapshot))
        && (rollback.retirement == null || stateRecord(rollback.retirement)));
    if (!eventKey || !eventKey.startsWith("pon-fun:") || eventKey.length > 512
      || !stateRecord(origin)
      || !Number.isSafeInteger(origin.blockNumber)
      || origin.blockNumber < PON_FACTORY_DEPLOY_BLOCK
      || !/^0x[a-fA-F0-9]{64}$/.test(String(origin.blockHash || ""))
      || typeof origin.kind !== "string"
      || !Number.isFinite(Date.parse(origin.recordedAt))
      || !rollbackValid
      || (origin.processedKey !== null && origin.processedKey !== undefined
        && (typeof origin.processedKey !== "string" || !origin.processedKey))) {
      invalidState(`alertOrigins.${eventKey} is malformed`);
    }
  }
  if (Object.keys(parsed.alertOrigins || {}).length > DEFAULT_PROCESSED_LIMIT) {
    invalidState("alertOrigins exceeds its safe bound");
  }
  if ((parsed.reorgOrphanedEventKeys || []).length > DEFAULT_ORPHANED_EVENT_LIMIT
    || new Set(parsed.reorgOrphanedEventKeys || []).size !== (parsed.reorgOrphanedEventKeys || []).length
    || (parsed.reorgOrphanedEventKeys || []).some((key) => typeof key !== "string" || !key || key.length > 512)) {
    invalidState("reorgOrphanedEventKeys must contain bounded strings");
  }
  if ((parsed.finalizedCheckpoints || []).length > DEFAULT_CHECKPOINT_LIMIT) {
    invalidState("finalizedCheckpoints exceeds its safe bound");
  }
  let previousCheckpoint = null;
  for (const checkpoint of parsed.finalizedCheckpoints || []) {
    if (!stateRecord(checkpoint)
      || !Number.isSafeInteger(checkpoint.blockNumber)
      || checkpoint.blockNumber < PON_FACTORY_DEPLOY_BLOCK
      || !/^0x[a-fA-F0-9]{64}$/.test(String(checkpoint.blockHash || ""))
      || !Number.isSafeInteger(checkpoint.marketCount)
      || checkpoint.marketCount < 0
      || !Number.isSafeInteger(checkpoint.listingCount)
      || checkpoint.listingCount < 0
      || !Number.isFinite(Date.parse(checkpoint.recordedAt))) {
      invalidState("finalizedCheckpoints contains a malformed checkpoint");
    }
    if (previousCheckpoint !== null && checkpoint.blockNumber <= previousCheckpoint) {
      invalidState("finalizedCheckpoints must be strictly ordered and unique");
    }
    previousCheckpoint = checkpoint.blockNumber;
  }
  if (parsed.initialized) {
    const cursorCheckpoint = (parsed.finalizedCheckpoints || []).find((checkpoint) =>
      checkpoint.blockNumber === parsed.cursor.lastScannedBlock);
    if (!cursorCheckpoint
      || cursorCheckpoint.blockHash.toLowerCase() !== parsed.cursor.lastScannedBlockHash.toLowerCase()
      || cursorCheckpoint.marketCount !== parsed.cursor.marketCountAtCursor
      || cursorCheckpoint.listingCount !== parsed.cursor.listingCountAtCursor) {
      invalidState("initialized cursor lacks an exact finalized checkpoint");
    }
    const coverage = parsed._health.apiCoverage;
    if (!stateRecord(coverage)
      || !Number.isSafeInteger(coverage.reportedBlock)
      || !Number.isSafeInteger(coverage.finalizedBlock)
      || !Number.isSafeInteger(coverage.blockLag)
      || coverage.blockLag !== coverage.finalizedBlock - coverage.reportedBlock
      || !Number.isSafeInteger(coverage.maxBlockLag)
      || coverage.maxBlockLag < 0
      || !Number.isSafeInteger(coverage.highWaterBlock)
      || coverage.highWaterBlock < coverage.reportedBlock
      || !Number.isFinite(Date.parse(coverage.lastVerifiedAt))) {
      invalidState("initialized API coverage proof is malformed");
    }
  }
  if ((parsed.missedCriticalChanges || []).length > 200) invalidState("missedCriticalChanges exceeds its safe bound");
  for (const summary of parsed.missedCriticalChanges || []) {
    if (!stateRecord(summary)
      || typeof summary.eventKey !== "string"
      || !summary.eventKey
      || typeof summary.kind !== "string"
      || !Number.isSafeInteger(summary.blockNumber)
      || !/^0x[a-fA-F0-9]{64}$/.test(String(summary.blockHash || ""))
      || !Number.isFinite(Date.parse(summary.recordedAt))) {
      invalidState("missedCriticalChanges contains a malformed summary");
    }
  }
  for (const [ticker, retirement] of Object.entries(parsed.retiredMarkets || {})) {
    if (retirement.active !== false
      || retirement.ticker !== ticker
      || !/^0x[a-fA-F0-9]{40}$/.test(String(retirement.stockToken || ""))
      || !Number.isSafeInteger(retirement.poolFee)
      || typeof retirement.eventKey !== "string"
      || typeof retirement.processedKey !== "string"
      || !Number.isSafeInteger(retirement.blockNumber)
      || !/^0x[a-fA-F0-9]{64}$/.test(String(retirement.blockHash || ""))
      || !/^0x[a-fA-F0-9]{64}$/.test(String(retirement.transactionHash || ""))
      || !Number.isSafeInteger(retirement.logIndex)
      || !Number.isFinite(Date.parse(retirement.retiredAt))) {
      invalidState(`retiredMarkets.${ticker} has a malformed finalized proof`);
    }
  }
  for (const [lane, revision] of Object.entries(parsed.apiTransitionRevisions || {})) {
    const validLane = /^market:0x[a-f0-9]{40}$/.test(lane)
      || lane === `platform-token:${PONFUN_TOKEN.toLowerCase()}`;
    if (!validLane || !Number.isSafeInteger(revision) || revision < 1) invalidState(`apiTransitionRevisions.${lane} is malformed`);
  }
  for (const [lane, transition] of Object.entries(parsed.pendingApiTransitions || {})) {
    const validLane = /^market:0x[a-f0-9]{40}$/.test(lane)
      || lane === `platform-token:${PONFUN_TOKEN.toLowerCase()}`;
    const expectedPrefix = /^market:0x[a-f0-9]{40}$/.test(lane)
      ? `pon-fun:market-lifecycle:${lane.slice("market:".length)}`
      : `pon-fun:platform-token:${PONFUN_TOKEN.toLowerCase()}`;
    if (!validLane
      || !stateRecord(transition)
      || transition.lane !== lane
      || typeof transition.fingerprint !== "string"
      || !transition.fingerprint
      || !Number.isSafeInteger(transition.revision)
      || transition.revision < 1
      || !Number.isSafeInteger(transition.apiHealthBlock)
      || !Number.isSafeInteger(transition.bindingBlock)
      || typeof transition.eventKey !== "string"
      || transition.eventKey !== `${expectedPrefix}:rev:${transition.revision}:api:${transition.apiHealthBlock}:binding:${transition.bindingBlock}`
      || parsed.apiTransitionRevisions?.[lane] !== transition.revision
      || !Number.isFinite(Date.parse(transition.reservedAt))) {
      invalidState(`pendingApiTransitions.${lane} is malformed`);
    }
  }
  const recentOrphans = parsed._health.reorg.lastOrphanedEventKeys;
  if (recentOrphans !== undefined
    && (!Array.isArray(recentOrphans)
      || recentOrphans.length > 50
      || recentOrphans.some((key) => typeof key !== "string" || !key))) {
    invalidState("_health.reorg.lastOrphanedEventKeys is malformed");
  }
  const state = {
    ...base,
    ...parsed,
    version: STATE_VERSION,
    cursor: { ...base.cursor, ...(parsed.cursor || {}) },
    identity: { ...base.identity, ...(parsed.identity || {}) },
    infrastructure: parsed.infrastructure,
    curveParams: parsed.curveParams,
    listings: parsed.listings,
    markets: parsed.markets,
    unmatchedApiMarkets: parsed.unmatchedApiMarkets,
    pendingMarketEvents: parsed.pendingMarketEvents,
    reorgBaselineMarketRechecks: parsed.reorgBaselineMarketRechecks || {},
    retiredMarkets: parsed.retiredMarkets || {},
    processedEventKeys: [...new Set(parsed.processedEventKeys)],
    alertOrigins: parsed.alertOrigins || {},
    reorgOrphanedEventKeys: [...new Set(parsed.reorgOrphanedEventKeys || [])],
    missedCriticalChanges: parsed.missedCriticalChanges || [],
    finalizedCheckpoints: parsed.finalizedCheckpoints || [],
    apiTransitionRevisions: parsed.apiTransitionRevisions || {},
    pendingApiTransitions: parsed.pendingApiTransitions || {},
    platformTokenVerification: parsed.platformTokenVerification || null,
    _health: {
      ...base._health,
      ...(parsed._health || {}),
      sources: { ...base._health.sources, ...(parsed._health?.sources || {}) },
      identity: { ...base._health.identity, ...(parsed._health?.identity || {}) },
      apiCoverage: { ...base._health.apiCoverage, ...(parsed._health?.apiCoverage || {}) },
      reorg: { ...base._health.reorg, ...(parsed._health?.reorg || {}) },
    },
  };
  for (const key of Object.keys(base._health.sources)) {
    state._health.sources[key] = { ...sourceHealth(), ...(state._health.sources[key] || {}) };
  }
  if (state.identity.chainId !== PON_CHAIN_ID
    || String(state.identity.factory).toLowerCase() !== PON_FACTORY.toLowerCase()
    || String(state.identity.factoryCodeHash).toLowerCase() !== PON_FACTORY_RUNTIME_HASH.toLowerCase()
    || String(state.identity.deploymentTransaction).toLowerCase() !== PON_FACTORY_DEPLOY_TRANSACTION.toLowerCase()
    || Number(state.identity.deploymentBlock) !== PON_FACTORY_DEPLOY_BLOCK
    || typeof state.identity.deploymentVerified !== "boolean") {
    throw ponError("state", "PON_STATE_IDENTITY_MISMATCH", "persisted pon.fun identity does not match the pinned deployment");
  }
  return state;
}

async function readState(file, fsImpl) {
  try {
    return normalizeState(JSON.parse(await fsImpl.readFile(file, "utf8")));
  } catch (error) {
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

export async function atomicWritePonState(file, value, fsImpl = fs) {
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

function assertExactResponseUrl(response, requestedUrl) {
  if (!response?.url) throw ponError("http", "PON_RESPONSE_URL_MISSING", `${requestedUrl} response URL is missing`);
  let actual;
  let expected;
  try {
    actual = new URL(response.url);
    expected = new URL(requestedUrl);
  } catch {
    throw ponError("http", "PON_RESPONSE_URL_INVALID", `${requestedUrl} response URL is invalid`);
  }
  if (actual.protocol !== "https:"
    || actual.username
    || actual.password
    || actual.port
    || actual.origin !== expected.origin
    || actual.pathname !== expected.pathname
    || actual.search !== expected.search
    || actual.hash) {
    throw ponError("http", "PON_RESPONSE_SOURCE_MISMATCH", `${requestedUrl} redirected to a non-official source`);
  }
}

async function fetchOfficialJson(fetchImpl, url, timeoutMs, lifecycleSignal = null) {
  let response;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = lifecycleSignal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([lifecycleSignal, timeoutSignal])
    : (lifecycleSignal || timeoutSignal);
  try {
    response = await abortable(fetchImpl(url, {
      redirect: "error",
      headers: {
        accept: "application/json",
        "user-agent": "robinhood-chain-monitor/pon.fun",
      },
      signal,
    }), signal, "http", () => lifecycleSignal?.aborted
      ? abortedError("http")
      : ponError("http", "PON_HTTP_TIMEOUT", `${url} request timed out after ${timeoutMs}ms`));
  } catch (error) {
    if (lifecycleSignal?.aborted || error?.code === "PON_STOPPED") throw abortedError("http");
    if (timeoutSignal.aborted || error?.code === "PON_HTTP_TIMEOUT" || error?.name === "TimeoutError") {
      throw ponError("http", "PON_HTTP_TIMEOUT", `${url} request timed out after ${timeoutMs}ms`);
    }
    throw ponError("http", "PON_HTTP_FAILED", `${url} request failed: ${error.message}`);
  }
  assertExactResponseUrl(response, url);
  if (!response.ok) throw ponError("http", "PON_HTTP_STATUS", `${url} returned HTTP ${response.status}`);
  let text;
  try {
    text = await abortable(response.text(), signal, "http", () => lifecycleSignal?.aborted
      ? abortedError("http")
      : ponError("http", "PON_HTTP_TIMEOUT", `${url} request timed out after ${timeoutMs}ms`));
  } catch (error) {
    if (lifecycleSignal?.aborted || error?.code === "PON_STOPPED") throw abortedError("http");
    if (timeoutSignal.aborted || error?.code === "PON_HTTP_TIMEOUT" || error?.name === "TimeoutError") {
      throw ponError("http", "PON_HTTP_TIMEOUT", `${url} request timed out after ${timeoutMs}ms`);
    }
    throw ponError("http", "PON_HTTP_BODY_FAILED", `${url} body failed: ${error.message}`);
  }
  if (!text || text.length > 10_000_000) throw ponError("http", "PON_HTTP_BODY_INVALID", `${url} returned an invalid body`);
  try { return JSON.parse(text); }
  catch { throw ponError("http", "PON_HTTP_JSON_INVALID", `${url} returned invalid JSON`); }
}

function parseHealth(payload) {
  if (!payload || payload.ok !== true || payload.deployed !== true) {
    throw ponError("api_health", "PON_HEALTH_NOT_READY", "pon.fun health endpoint is not ready");
  }
  const chainId = safeInteger(payload.chainId, "health.chainId", { minimum: 1 });
  const factory = address(payload.addresses?.factory, "health.addresses.factory");
  const oracle = address(payload.addresses?.oracle, "health.addresses.oracle");
  const usdg = address(payload.addresses?.usdg, "health.addresses.usdg");
  if (chainId !== PON_CHAIN_ID) throw ponError("api_health", "PON_API_CHAIN_MISMATCH", `pon.fun API chain ${chainId} != ${PON_CHAIN_ID}`);
  if (factory.toLowerCase() !== PON_FACTORY.toLowerCase()) {
    throw ponError("api_health", "PON_FACTORY_ROOT_MISMATCH", `pon.fun API factory ${factory} does not match the pinned factory`, {
      observedFactory: factory,
      observedChainId: chainId,
    });
  }
  return {
    ok: true,
    deployed: true,
    chainId,
    block: safeInteger(payload.block, "health.block", { minimum: 1 }),
    latencyMs: optionalFinite(payload.latencyMs),
    addresses: { factory, oracle, usdg },
  };
}

function normalizeMarket(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw ponError("api_markets", "PON_MARKET_SCHEMA", `markets[${index}] is invalid`);
  }
  if (typeof raw.graduated !== "boolean" || typeof raw.lpDeployed !== "boolean") {
    throw ponError("api_markets", "PON_MARKET_LIFECYCLE_SCHEMA", `markets[${index}] lifecycle flags are invalid`);
  }
  return {
    ticker: tickerText(raw.ticker, `markets[${index}].ticker`),
    symbol: boundedText(raw.symbol, `markets[${index}].symbol`, 32),
    name: boundedText(raw.name, `markets[${index}].name`, 160),
    coin: address(raw.coin, `markets[${index}].coin`),
    vault: address(raw.vault, `markets[${index}].vault`),
    curve: address(raw.curve, `markets[${index}].curve`),
    creator: address(raw.creator, `markets[${index}].creator`),
    creatorFeeBps: safeInteger(raw.creatorFeeBps, `markets[${index}].creatorFeeBps`, { maximum: 10_000 }),
    createdAt: safeInteger(raw.createdAt, `markets[${index}].createdAt`, { minimum: 1 }),
    stockToken: address(raw.stockToken, `markets[${index}].stockToken`),
    poolFee: safeInteger(raw.poolFee, `markets[${index}].poolFee`, { maximum: 1_000_000 }),
    graduated: raw.graduated,
    lpDeployed: raw.lpDeployed,
    backingPct: optionalFinite(raw.backingPct),
    progressBps: optionalFinite(raw.progressBps),
    marketCap: optionalFinite(raw.marketCap),
    reserve: optionalFinite(raw.reserve),
    vol24: optionalFinite(raw.vol24),
  };
}

function parseMarkets(payload) {
  if (!payload || payload.deployed !== true || !Array.isArray(payload.markets) || payload.markets.length > 10_000) {
    throw ponError("api_markets", "PON_MARKETS_SCHEMA", "pon.fun markets response is invalid");
  }
  const markets = payload.markets.map(normalizeMarket);
  const coins = new Set();
  for (const market of markets) {
    const key = market.coin.toLowerCase();
    if (coins.has(key)) throw ponError("api_markets", "PON_MARKET_DUPLICATE", `duplicate pon.fun market ${market.coin}`);
    coins.add(key);
  }
  return markets;
}

function parseTokenList(payload) {
  if (!payload || !payload.version || !Array.isArray(payload.tokens) || payload.tokens.length > 10_000) {
    throw ponError("api_token_list", "PON_TOKEN_LIST_SCHEMA", "pon.fun token list is invalid");
  }
  const tokens = {};
  for (const [index, raw] of payload.tokens.entries()) {
    if (!raw || safeInteger(raw.chainId, `tokenlist.tokens[${index}].chainId`, { minimum: 1 }) !== PON_CHAIN_ID) {
      throw ponError("api_token_list", "PON_TOKEN_LIST_CHAIN", `tokenlist.tokens[${index}] has the wrong chain`);
    }
    const token = {
      address: address(raw.address, `tokenlist.tokens[${index}].address`),
      symbol: boundedText(raw.symbol, `tokenlist.tokens[${index}].symbol`, 32),
      name: boundedText(raw.name, `tokenlist.tokens[${index}].name`, 160),
      ticker: tickerText(raw.extensions?.peggedToStock, `tokenlist.tokens[${index}].extensions.peggedToStock`),
      vault: address(raw.extensions?.vault, `tokenlist.tokens[${index}].extensions.vault`),
      curve: address(raw.extensions?.curve, `tokenlist.tokens[${index}].extensions.curve`),
    };
    const key = token.address.toLowerCase();
    if (tokens[key]) throw ponError("api_token_list", "PON_TOKEN_LIST_DUPLICATE", `duplicate token list entry ${token.address}`);
    tokens[key] = token;
  }
  return {
    version: [payload.version.major, payload.version.minor, payload.version.patch]
      .map((value, index) => safeInteger(value, `tokenlist.version[${index}]`)).join("."),
    tokens,
  };
}

function parsePlatformToken(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw ponError("api_platform_token", "PON_PLATFORM_TOKEN_SCHEMA", "pon.fun platform token response is invalid");
  }
  const supply = String(payload.supply ?? "");
  const parsed = {
    address: address(payload.address, "ponfun.address"),
    symbol: boundedText(payload.symbol, "ponfun.symbol", 32),
    name: boundedText(payload.name, "ponfun.name", 80),
    supply,
  };
  if (parsed.address.toLowerCase() !== PONFUN_TOKEN.toLowerCase()
    || parsed.symbol !== "PONFUN"
    || parsed.name !== "Ponfun"
    || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(parsed.supply)
    || Number(parsed.supply) <= 0) {
    throw ponError("api_platform_token", "PON_PLATFORM_TOKEN_MISMATCH", "pon.fun platform token identity changed unexpectedly");
  }
  return parsed;
}

function validateTokenListMarket(market, tokenList) {
  const listed = tokenList.tokens[market.coin.toLowerCase()];
  if (!listed
    || listed.symbol !== market.symbol
    || listed.name !== market.name
    || listed.ticker !== market.ticker
    || listed.vault.toLowerCase() !== market.vault.toLowerCase()
    || listed.curve.toLowerCase() !== market.curve.toLowerCase()) {
    throw ponError("api_token_list", "PON_API_TOKEN_LIST_MISMATCH", `token list does not bind market ${market.coin}`);
  }
  return listed;
}

async function callFactory(provider, functionName, args = [], blockTag = undefined) {
  const data = PON_FACTORY_INTERFACE.encodeFunctionData(functionName, args);
  let raw;
  try {
    raw = await provider.call({
      to: PON_FACTORY,
      data,
      ...(blockTag === undefined ? {} : { blockTag }),
    });
  } catch (error) {
    throw ponError("chain", "PON_FACTORY_CALL_FAILED", `${functionName}() failed: ${error.message}`);
  }
  try { return PON_FACTORY_INTERFACE.decodeFunctionResult(functionName, raw); }
  catch (error) { throw ponError("chain", "PON_FACTORY_DECODE_FAILED", `${functionName}() returned invalid data: ${error.message}`); }
}

async function callErc20(provider, functionName, blockTag) {
  const data = ERC20_INTERFACE.encodeFunctionData(functionName, []);
  let raw;
  try {
    raw = await provider.call({ to: PONFUN_TOKEN, data, blockTag });
  } catch (error) {
    throw ponError("chain", "PON_PLATFORM_TOKEN_CALL_FAILED", `${functionName}() failed: ${error.message}`);
  }
  try { return ERC20_INTERFACE.decodeFunctionResult(functionName, raw)[0]; }
  catch (error) {
    throw ponError("chain", "PON_PLATFORM_TOKEN_DECODE_FAILED", `${functionName}() returned invalid data: ${error.message}`);
  }
}

function decimalSupplyToRaw(value, decimals) {
  const source = String(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(source)) {
    throw ponError("api_platform_token", "PON_PLATFORM_TOKEN_SUPPLY_SCHEMA", "pon.fun supply is not an exact decimal value");
  }
  const [whole, fraction = ""] = source.split(".");
  if (fraction.length > decimals) {
    throw ponError("api_platform_token", "PON_PLATFORM_TOKEN_SUPPLY_SCHEMA", "pon.fun supply exceeds token decimal precision");
  }
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}

async function verifyPlatformTokenOnchain(provider, platformToken, blockNumber, blockHash) {
  const [code, name, symbol, decimalsValue, totalSupplyValue] = await Promise.all([
    provider.getCode(PONFUN_TOKEN, blockNumber),
    callErc20(provider, "name", blockNumber),
    callErc20(provider, "symbol", blockNumber),
    callErc20(provider, "decimals", blockNumber),
    callErc20(provider, "totalSupply", blockNumber),
  ]);
  if (!code || code === "0x") {
    throw ponError("chain", "PON_PLATFORM_TOKEN_CODE_EMPTY", "pinned PONFUN token has no finalized runtime code");
  }
  const chainName = boundedText(name, "PONFUN.name", 80);
  const chainSymbol = boundedText(symbol, "PONFUN.symbol", 32);
  const decimals = safeInteger(decimalsValue, "PONFUN.decimals", { maximum: 255 });
  const totalSupply = BigInt(totalSupplyValue);
  if (chainName !== platformToken.name) {
    throw ponError("api_platform_token", "PON_PLATFORM_TOKEN_NAME_MISMATCH", "pon.fun API token name does not match finalized ERC-20 state");
  }
  if (chainSymbol !== platformToken.symbol) {
    throw ponError("api_platform_token", "PON_PLATFORM_TOKEN_SYMBOL_MISMATCH", "pon.fun API token symbol does not match finalized ERC-20 state");
  }
  if (decimalSupplyToRaw(platformToken.supply, decimals) !== totalSupply) {
    throw ponError("api_platform_token", "PON_PLATFORM_TOKEN_SUPPLY_MISMATCH", "pon.fun API supply does not match finalized ERC-20 totalSupply");
  }
  return {
    token: getAddress(PONFUN_TOKEN),
    codePresent: true,
    codeHash: keccak256(code),
    name: chainName,
    symbol: chainSymbol,
    decimals,
    totalSupplyRaw: totalSupply.toString(),
    verifiedBlock: blockNumber,
    verifiedBlockHash: blockHash,
  };
}

function resultAddress(result, label) {
  return optionalAddress(result?.[0], label);
}

async function readFactorySnapshot(provider, blockTag) {
  const names = [
    "owner",
    "pendingOwner",
    "oracle",
    "usdg",
    "swapRouter",
    "positionManager",
    "protocolTreasury",
    "paused",
    "coinImpl",
    "vaultImpl",
    "curveImpl",
    "marketCount",
    "listingCount",
    "curveParams",
  ];
  const values = await Promise.all(names.map((name) => callFactory(provider, name, [], blockTag)));
  const byName = Object.fromEntries(names.map((name, index) => [name, values[index]]));
  const params = byName.curveParams;
  return {
    owner: resultAddress(byName.owner, "factory.owner"),
    pendingOwner: resultAddress(byName.pendingOwner, "factory.pendingOwner"),
    oracle: resultAddress(byName.oracle, "factory.oracle"),
    usdg: resultAddress(byName.usdg, "factory.usdg"),
    swapRouter: resultAddress(byName.swapRouter, "factory.swapRouter"),
    positionManager: resultAddress(byName.positionManager, "factory.positionManager"),
    protocolTreasury: resultAddress(byName.protocolTreasury, "factory.protocolTreasury"),
    paused: Boolean(byName.paused[0]),
    coinImpl: resultAddress(byName.coinImpl, "factory.coinImpl"),
    vaultImpl: resultAddress(byName.vaultImpl, "factory.vaultImpl"),
    curveImpl: resultAddress(byName.curveImpl, "factory.curveImpl"),
    marketCount: safeInteger(byName.marketCount[0], "factory.marketCount"),
    listingCount: safeInteger(byName.listingCount[0], "factory.listingCount"),
    curveParams: {
      p0: params[0].toString(),
      slope: params[1].toString(),
      curveCap: params[2].toString(),
      lpPoolFee: safeInteger(params[3], "factory.curveParams.lpPoolFee", { maximum: 1_000_000 }),
      maxSlippageBps: safeInteger(params[4], "factory.curveParams.maxSlippageBps", { maximum: 10_000 }),
      autoAcquire: Boolean(params[5]),
    },
  };
}

function assertImmutableFactoryBindings(snapshot) {
  const expected = {
    usdg: PON_USDG,
    coinImpl: PON_COIN_IMPL,
    vaultImpl: PON_VAULT_IMPL,
    curveImpl: PON_CURVE_IMPL,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (String(snapshot[key]).toLowerCase() !== value.toLowerCase()) {
      throw ponError("chain", "PON_FACTORY_BINDING_MISMATCH", `factory ${key} does not match the pinned deployment`);
    }
  }
}

function marketCore(market) {
  return {
    ticker: market.ticker,
    symbol: market.symbol,
    name: market.name,
    coin: market.coin,
    vault: market.vault,
    curve: market.curve,
    creator: market.creator,
    creatorFeeBps: market.creatorFeeBps,
    createdAt: market.createdAt,
  };
}

function sameMarketCore(left, right) {
  if (!left || !right) return false;
  return left.ticker === right.ticker
    && left.symbol === right.symbol
    && left.name === right.name
    && left.coin.toLowerCase() === right.coin.toLowerCase()
    && left.vault.toLowerCase() === right.vault.toLowerCase()
    && left.curve.toLowerCase() === right.curve.toLowerCase()
    && left.creator.toLowerCase() === right.creator.toLowerCase()
    && Number(left.creatorFeeBps) === Number(right.creatorFeeBps)
    && Number(left.createdAt) === Number(right.createdAt);
}

function sameMarketCreation(left, right) {
  if (!left || !right) return false;
  return left.ticker === right.ticker
    && left.symbol === right.symbol
    && left.name === right.name
    && left.coin.toLowerCase() === right.coin.toLowerCase()
    && left.vault.toLowerCase() === right.vault.toLowerCase()
    && left.curve.toLowerCase() === right.curve.toLowerCase()
    && left.creator.toLowerCase() === right.creator.toLowerCase()
    && Number(left.creatorFeeBps) === Number(right.creatorFeeBps);
}

async function verifyMarketOnchain(provider, market, blockTag, { retirement = null } = {}) {
  const [idResult, listingResult, contractCodes] = await Promise.all([
    callFactory(provider, "coinToId", [market.coin], blockTag),
    callFactory(provider, "getListing", [market.ticker], blockTag),
    Promise.all([
      provider.getCode(market.coin, blockTag),
      provider.getCode(market.vault, blockTag),
      provider.getCode(market.curve, blockTag),
    ]),
  ]);
  const idPlusOne = BigInt(idResult[0]);
  if (idPlusOne === 0n) throw ponError("chain", "PON_MARKET_NOT_ONCHAIN", `factory does not contain market ${market.coin}`);
  const marketResult = await callFactory(provider, "getMarketById", [idPlusOne - 1n], blockTag);
  const raw = marketResult[0];
  const onchain = {
    coin: address(raw.coin ?? raw[0], "onchain market coin"),
    vault: address(raw.vault ?? raw[1], "onchain market vault"),
    curve: address(raw.curve ?? raw[2], "onchain market curve"),
    creator: address(raw.creator ?? raw[3], "onchain market creator"),
    creatorFeeBps: safeInteger(raw.creatorFeeBps ?? raw[4], "onchain market creatorFeeBps", { maximum: 10_000 }),
    createdAt: safeInteger(raw.createdAt ?? raw[5], "onchain market createdAt", { minimum: 1 }),
    ticker: tickerText(raw.ticker ?? raw[6], "onchain market ticker"),
    symbol: boundedText(raw.symbol ?? raw[7], "onchain market symbol", 32),
    name: boundedText(raw.name ?? raw[8], "onchain market name", 160),
  };
  if (!sameMarketCore(market, onchain)) {
    throw ponError("chain", "PON_API_CHAIN_MARKET_MISMATCH", `API market ${market.coin} does not match factory state`);
  }
  const listing = listingResult[0];
  const listingActive = Boolean(listing.active ?? listing[2]);
  const normalizedListing = {
    stockToken: listingActive
      ? address(listing.stockToken ?? listing[0], "onchain listing stockToken")
      : optionalAddress(listing.stockToken ?? listing[0], "onchain listing stockToken"),
    poolFee: safeInteger(listing.poolFee ?? listing[1], "onchain listing poolFee", { maximum: 1_000_000 }),
    active: listingActive,
    ticker: tickerText(listing.ticker ?? listing[3], "onchain listing ticker"),
  };
  const listingMatches = retirement
    ? !normalizedListing.active
      && normalizedListing.ticker === market.ticker
      && normalizedListing.stockToken.toLowerCase() === String(retirement.stockToken).toLowerCase()
      && normalizedListing.poolFee === Number(retirement.poolFee)
    : normalizedListing.active
      && normalizedListing.ticker === market.ticker
      && normalizedListing.stockToken.toLowerCase() === market.stockToken.toLowerCase()
      && normalizedListing.poolFee === market.poolFee;
  if (!listingMatches) {
    throw ponError("chain", "PON_API_CHAIN_LISTING_MISMATCH", `API listing ${market.ticker} does not match factory state`);
  }
  if (contractCodes.some((code) => !code || code === "0x")) {
    throw ponError("chain", "PON_MARKET_CODE_EMPTY", `market ${market.coin} has an address without contract code`);
  }
  return { id: Number(idPlusOne - 1n), market: onchain, listing: normalizedListing };
}

async function providerChainId(provider) {
  try {
    // JsonRpcProvider(staticNetwork=true) may answer getNetwork() from local
    // configuration without consulting the endpoint. Prefer a raw RPC probe
    // so a mispointed endpoint cannot inherit the expected chain identity.
    if (typeof provider.send === "function") return Number(BigInt(await provider.send("eth_chainId", [])));
    if (typeof provider.getNetwork === "function") return Number((await provider.getNetwork()).chainId);
    throw new Error("provider does not expose a chain ID method");
  } catch (error) {
    throw ponError("chain", "PON_CHAIN_ID_FAILED", `could not read chain ID: ${error.message}`);
  }
}

async function verifyDeployment(provider, expectedCreationInputHash = PON_FACTORY_CREATION_INPUT_HASH) {
  const [receipt, transaction, block] = await Promise.all([
    provider.getTransactionReceipt(PON_FACTORY_DEPLOY_TRANSACTION),
    provider.getTransaction(PON_FACTORY_DEPLOY_TRANSACTION),
    provider.getBlock(PON_FACTORY_DEPLOY_BLOCK),
  ]);
  if (!receipt
    || Number(receipt.status) !== 1
    || Number(receipt.blockNumber) !== PON_FACTORY_DEPLOY_BLOCK
    || String(receipt.blockHash).toLowerCase() !== PON_FACTORY_DEPLOY_BLOCK_HASH.toLowerCase()
    || String(receipt.contractAddress).toLowerCase() !== PON_FACTORY.toLowerCase()
    || String(receipt.from).toLowerCase() !== PON_INITIAL_OWNER.toLowerCase()
    || receipt.to != null
    || !transaction
    || String(transaction.from).toLowerCase() !== PON_INITIAL_OWNER.toLowerCase()
    || transaction.to != null
    || Number(transaction.nonce) !== 1
    || keccak256(transaction.data).toLowerCase() !== expectedCreationInputHash.toLowerCase()
    || !block
    || Number(block.number) !== PON_FACTORY_DEPLOY_BLOCK
    || String(block.hash).toLowerCase() !== PON_FACTORY_DEPLOY_BLOCK_HASH.toLowerCase()) {
    throw ponError("chain", "PON_FACTORY_DEPLOYMENT_MISMATCH", "pinned pon.fun factory deployment proof did not match");
  }
  // The public Robinhood RPC does not currently expose archive code at the
  // deployment block. Receipt + transaction + block anchor the creation;
  // verifyIdentity fingerprints finalized runtime code on every cycle.
}

async function verifyIdentity(provider, health, finalizedBlock, expectedFactoryCodeHash, state, verifiedChainId = null) {
  const chainId = verifiedChainId ?? await providerChainId(provider);
  state._health.identity.observedChainId = chainId;
  state._health.identity.observedFactory = health.addresses.factory;
  if (chainId !== PON_CHAIN_ID) throw ponError("chain", "PON_RPC_CHAIN_MISMATCH", `RPC chain ${chainId} != ${PON_CHAIN_ID}`);
  let factoryCode;
  try { factoryCode = await provider.getCode(PON_FACTORY, finalizedBlock); }
  catch (error) { throw ponError("chain", "PON_FACTORY_CODE_FAILED", `factory code lookup failed: ${error.message}`); }
  if (!factoryCode || factoryCode === "0x") throw ponError("chain", "PON_FACTORY_CODE_EMPTY", "pinned pon.fun factory has no code");
  const factoryCodeHash = keccak256(factoryCode);
  state._health.identity.observedFactoryCodeHash = factoryCodeHash;
  if (factoryCodeHash.toLowerCase() !== expectedFactoryCodeHash.toLowerCase()) {
    throw ponError("chain", "PON_FACTORY_CODE_MISMATCH", "pinned pon.fun factory runtime fingerprint changed");
  }
  const [oracleCode, usdgCode, latestBindings, finalizedSnapshot] = await Promise.all([
    provider.getCode(health.addresses.oracle),
    provider.getCode(health.addresses.usdg),
    Promise.all([
      callFactory(provider, "oracle"),
      callFactory(provider, "usdg"),
    ]),
    readFactorySnapshot(provider, finalizedBlock),
  ]);
  if (!oracleCode || oracleCode === "0x" || !usdgCode || usdgCode === "0x") {
    throw ponError("chain", "PON_INFRASTRUCTURE_CODE_EMPTY", "pon.fun oracle or USDG has no code");
  }
  const latestOracle = resultAddress(latestBindings[0], "factory.oracle");
  const latestUsdg = resultAddress(latestBindings[1], "factory.usdg");
  if (latestOracle.toLowerCase() !== health.addresses.oracle.toLowerCase()
    || latestUsdg.toLowerCase() !== health.addresses.usdg.toLowerCase()) {
    throw ponError("chain", "PON_API_CHAIN_INFRASTRUCTURE_MISMATCH", "pon.fun health addresses do not match factory getters");
  }
  assertImmutableFactoryBindings(finalizedSnapshot);
  if (health.block > finalizedBlock + 128) {
    throw ponError("api_health", "PON_HEALTH_BLOCK_AHEAD", "pon.fun health block is implausibly ahead of the RPC head");
  }
  return finalizedSnapshot;
}

function logIndex(log) {
  return safeInteger(log.index ?? log.logIndex ?? 0, "log.index");
}

function logEventKey(log) {
  return `pon-fun:${PON_CHAIN_ID}:${String(log.transactionHash).toLowerCase()}:${logIndex(log)}:${String(log.topics?.[0]).toLowerCase()}`;
}

function sameLog(left, right) {
  const leftTopics = (left.topics || []).map((value) => String(value).toLowerCase());
  const rightTopics = (right.topics || []).map((value) => String(value).toLowerCase());
  return String(left.address).toLowerCase() === String(right.address).toLowerCase()
    && String(left.data || "0x").toLowerCase() === String(right.data || "0x").toLowerCase()
    && logIndex(left) === logIndex(right)
    && leftTopics.length === rightTopics.length
    && leftTopics.every((value, index) => value === rightTopics[index]);
}

async function verifyLogReceipt(provider, log) {
  const transactionHash = String(log.transactionHash || "");
  if (!/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) {
    throw ponError("chain", "PON_LOG_TRANSACTION_INVALID", "pon.fun event is missing a valid transaction hash");
  }
  let receipt;
  let block;
  try {
    [receipt, block] = await Promise.all([
      provider.getTransactionReceipt(transactionHash),
      provider.getBlock(Number(log.blockNumber)),
    ]);
  } catch (error) {
    if (error?.code === "PON_STOPPED") throw error;
    throw ponError("chain", "PON_LOG_RECEIPT_FAILED", `pon.fun receipt lookup failed for ${transactionHash}: ${error.message}`);
  }
  if (!receipt
    || Number(receipt.status) !== 1
    || Number(receipt.blockNumber) !== Number(log.blockNumber)
    || (log.blockHash && String(receipt.blockHash).toLowerCase() !== String(log.blockHash).toLowerCase())
    || !(receipt.logs || []).some((candidate) => sameLog(candidate, log))
    || !block
    || Number(block.number) !== Number(log.blockNumber)
    || (log.blockHash && String(block.hash).toLowerCase() !== String(log.blockHash).toLowerCase())) {
    throw ponError("chain", "PON_LOG_RECEIPT_MISMATCH", `pon.fun event receipt proof failed for ${transactionHash}`);
  }
  return {
    transactionHash,
    blockNumber: Number(log.blockNumber),
    blockHash: block.hash,
    blockTimestamp: iso(Number(block.timestamp) * 1_000),
    logIndex: logIndex(log),
    topic0: String(log.topics[0]).toLowerCase(),
  };
}

function decodedEvent(log) {
  if (String(log.address || "").toLowerCase() !== PON_FACTORY.toLowerCase()) {
    throw ponError("chain", "PON_LOG_FACTORY_MISMATCH", "pon.fun event came from the wrong factory");
  }
  const topic0 = String(log.topics?.[0] || "").toLowerCase();
  if (!EVENT_TOPIC_SET.has(topic0)) throw ponError("chain", "PON_LOG_TOPIC_INVALID", "pon.fun event topic is not allowed");
  let parsed;
  try { parsed = PON_FACTORY_INTERFACE.parseLog(log); }
  catch (error) { throw ponError("chain", "PON_LOG_DECODE_FAILED", `pon.fun event could not be decoded: ${error.message}`); }
  return parsed;
}

function serializableLog(log) {
  return {
    address: String(log.address),
    topics: (log.topics || []).map(String),
    data: String(log.data || "0x"),
    blockNumber: Number(log.blockNumber),
    blockHash: log.blockHash ? String(log.blockHash) : null,
    transactionHash: String(log.transactionHash),
    transactionIndex: Number(log.transactionIndex || 0),
    index: logIndex(log),
  };
}

function decodedSnapshot(parsed) {
  const args = parsed.args;
  switch (parsed.name) {
    case "MarketCreated": return {
      ticker: tickerText(args.ticker, "MarketCreated.ticker"),
      symbol: boundedText(args.symbol, "MarketCreated.symbol", 32),
      name: boundedText(args.name, "MarketCreated.name", 160),
      coin: address(args.coin, "MarketCreated.coin"),
      vault: address(args.vault, "MarketCreated.vault"),
      curve: address(args.curve, "MarketCreated.curve"),
      creator: address(args.creator, "MarketCreated.creator"),
      creatorFeeBps: safeInteger(args.creatorFeeBps, "MarketCreated.creatorFeeBps", { maximum: 10_000 }),
    };
    case "ConfigSet": return {
      oracle: address(args.oracle, "ConfigSet.oracle"),
      swapRouter: address(args.swapRouter, "ConfigSet.swapRouter"),
      positionManager: address(args.positionManager, "ConfigSet.positionManager"),
      protocolTreasury: address(args.treasury, "ConfigSet.treasury"),
    };
    case "CurveParamsSet": return {
      p0: args.params.p0.toString(),
      slope: args.params.slope.toString(),
      curveCap: args.params.curveCap.toString(),
      lpPoolFee: safeInteger(args.params.lpPoolFee, "CurveParamsSet.lpPoolFee", { maximum: 1_000_000 }),
      maxSlippageBps: safeInteger(args.params.maxSlippageBps, "CurveParamsSet.maxSlippageBps", { maximum: 10_000 }),
      autoAcquire: Boolean(args.params.autoAcquire),
    };
    case "StockListed": {
      const active = Boolean(args.active);
      return {
        ticker: tickerText(args.ticker, "StockListed.ticker"),
        stockToken: active
          ? address(args.stockToken, "StockListed.stockToken")
          : optionalAddress(args.stockToken, "StockListed.stockToken"),
        poolFee: safeInteger(args.poolFee, "StockListed.poolFee", { maximum: 1_000_000 }),
        active,
      };
    }
    case "Paused":
    case "Unpaused": return { account: address(args.account, `${parsed.name}.account`) };
    case "OwnershipTransferStarted":
    case "OwnershipTransferred": return {
      previousOwner: optionalAddress(args.previousOwner, `${parsed.name}.previousOwner`),
      newOwner: address(args.newOwner, `${parsed.name}.newOwner`),
    };
    default: throw ponError("chain", "PON_LOG_KIND_INVALID", `unsupported pon.fun event ${parsed.name}`);
  }
}

const PON_PLATFORM = Object.freeze({
  id: "ponfun",
  name: "pon.fun",
  website: PON_WEBSITE_URL,
  twitter: PON_X_URL,
  chainId: PON_CHAIN_ID,
  model: "stock-backed penny meme launchpad; the coin is not the stock",
});

function sourceFor(url) {
  return {
    id: PON_SOURCE_ID,
    name: "pon.fun official API + fingerprinted Factory",
    url,
    official: true,
    trust: PON_SOURCE_TRUST,
  };
}

function baseEvent(kind, observedAt, url) {
  return {
    type: "pon_fun_update",
    kind,
    platform: { ...PON_PLATFORM },
    source: sourceFor(url),
    sourceTrust: PON_SOURCE_TRUST,
    chainId: PON_CHAIN_ID,
    factory: PON_FACTORY,
    observedAt,
    strong: true,
    risk: "PON coins are not the referenced stocks; backing, oracle, liquidity, sellability and admin controls remain risks.",
  };
}

function eventEvidence(proof) {
  return {
    chainId: PON_CHAIN_ID,
    factory: PON_FACTORY,
    factoryCodeHash: PON_FACTORY_RUNTIME_HASH,
    topic0: proof.topic0,
    logIndex: proof.logIndex,
    receiptVerified: true,
    api: {
      healthUrl: PON_HEALTH_URL,
      marketsUrl: PON_MARKETS_URL,
      tokenListUrl: PON_TOKEN_LIST_URL,
    },
  };
}

function chainEventBase(kind, proof, observedAt) {
  const explorerUrl = `https://robinhoodchain.blockscout.com/tx/${proof.transactionHash}`;
  return {
    ...baseEvent(kind, observedAt, explorerUrl),
    eventKey: `pon-fun:${kind}:${PON_CHAIN_ID}:${proof.transactionHash.toLowerCase()}:${proof.logIndex}`,
    transactionHash: proof.transactionHash,
    blockNumber: proof.blockNumber,
    blockHash: proof.blockHash,
    blockTimestamp: proof.blockTimestamp,
    explorerUrl,
    evidence: eventEvidence(proof),
  };
}

function objectChanges(previous, current) {
  const changes = {};
  for (const [key, after] of Object.entries(current || {})) {
    const before = previous?.[key] ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) changes[key] = { before, after };
  }
  return changes;
}

function factoryEvent(parsed, snapshot, proof, state, observedAt) {
  if (parsed.name === "ConfigSet") return {
    ...chainEventBase("factory_config", proof, observedAt),
    title: "pon.fun Factory 配置更新",
    summary: "Factory emitted ConfigSet; oracle/router/position manager/treasury values are shown exactly.",
    previousSnapshot: state.infrastructure,
    currentSnapshot: snapshot,
    changes: objectChanges(state.infrastructure, snapshot),
  };
  if (parsed.name === "CurveParamsSet") return {
    ...chainEventBase("curve_params", proof, observedAt),
    title: "pon.fun 曲线参数更新",
    summary: "Factory emitted CurveParamsSet; launch pricing and LP parameters changed.",
    previousSnapshot: state.curveParams,
    currentSnapshot: snapshot,
    changes: objectChanges(state.curveParams, snapshot),
  };
  if (parsed.name === "StockListed") return {
    ...chainEventBase("stock_listing", proof, observedAt),
    title: `pon.fun 股票映射更新：${snapshot.ticker}`,
    summary: "Factory emitted StockListed for a stock-token oracle mapping.",
    ticker: snapshot.ticker,
    contractAddress: snapshot.stockToken,
    previousSnapshot: state.listings[snapshot.ticker] || null,
    currentSnapshot: snapshot,
    changes: objectChanges(state.listings[snapshot.ticker], snapshot),
  };
  if (parsed.name === "Paused" || parsed.name === "Unpaused") {
    const paused = parsed.name === "Paused";
    return {
      ...chainEventBase(paused ? "factory_paused" : "factory_unpaused", proof, observedAt),
      title: `pon.fun Factory ${paused ? "已暂停" : "已恢复"}`,
      summary: `Factory emitted ${parsed.name}; ${paused ? "new launches may be unavailable" : "factory operations were unpaused"}.`,
      previousSnapshot: { paused: state.infrastructure?.paused ?? null },
      currentSnapshot: { paused, account: snapshot.account },
      changes: { paused: { before: state.infrastructure?.paused ?? null, after: paused } },
    };
  }
  const transferred = parsed.name === "OwnershipTransferred";
  if (!transferred) return {
    ...chainEventBase("ownership_transfer_started", proof, observedAt),
    title: "pon.fun Factory 所有权转移已发起",
    summary: "Factory emitted OwnershipTransferStarted; a pending admin authority was nominated.",
    previousSnapshot: {
      owner: snapshot.previousOwner,
      pendingOwner: state.infrastructure?.pendingOwner ?? ZERO_ADDRESS,
    },
    currentSnapshot: { owner: snapshot.previousOwner, pendingOwner: snapshot.newOwner },
    changes: {
      pendingOwner: {
        before: state.infrastructure?.pendingOwner ?? ZERO_ADDRESS,
        after: snapshot.newOwner,
      },
    },
  };
  return {
    ...chainEventBase("ownership_transferred", proof, observedAt),
    title: "pon.fun Factory 所有权已转移",
    summary: "Factory emitted OwnershipTransferred; admin authority changed and the pending owner was cleared.",
    previousSnapshot: {
      owner: snapshot.previousOwner,
      pendingOwner: state.infrastructure?.pendingOwner ?? snapshot.newOwner,
    },
    currentSnapshot: { owner: snapshot.newOwner, pendingOwner: ZERO_ADDRESS },
    changes: {
      owner: { before: snapshot.previousOwner, after: snapshot.newOwner },
      pendingOwner: {
        before: state.infrastructure?.pendingOwner ?? snapshot.newOwner,
        after: ZERO_ADDRESS,
      },
    },
  };
}

function applyFactorySnapshot(state, parsed, snapshot) {
  if (parsed.name === "ConfigSet") state.infrastructure = { ...(state.infrastructure || {}), ...snapshot };
  if (parsed.name === "CurveParamsSet") state.curveParams = snapshot;
  if (parsed.name === "StockListed") state.listings[snapshot.ticker] = snapshot;
  if (parsed.name === "Paused" || parsed.name === "Unpaused") {
    state.infrastructure = { ...(state.infrastructure || {}), paused: parsed.name === "Paused" };
  }
  if (parsed.name === "OwnershipTransferStarted") {
    state.infrastructure = { ...(state.infrastructure || {}), pendingOwner: snapshot.newOwner };
  }
  if (parsed.name === "OwnershipTransferred") {
    state.infrastructure = { ...(state.infrastructure || {}), owner: snapshot.newOwner, pendingOwner: ZERO_ADDRESS };
  }
}

function marketEvent(snapshot, market, proof, observedAt) {
  return {
    ...chainEventBase("market_created", proof, observedAt),
    title: `pon.fun 新市场：${market.symbol} / ${market.ticker}`,
    summary: "A new pon.fun MarketCreated event matches the official markets API, token list and Factory getters.",
    token: market.coin,
    contractAddress: market.coin,
    ticker: market.ticker,
    symbol: market.symbol,
    market,
    currentSnapshot: market,
    changes: { market: { before: null, after: marketCore(market) } },
    creation: snapshot,
  };
}

function lifecycleEvent(previous, current, changes, transition, finalizedBlock, finalizedBlockHash, observedAt) {
  return {
    ...baseEvent("market_lifecycle", observedAt, PON_MARKETS_URL),
    eventKey: transition.eventKey,
    title: `pon.fun 市场状态更新：${current.symbol}`,
    summary: "The official market lifecycle changed after its Factory identity was re-verified on-chain.",
    token: current.coin,
    contractAddress: current.coin,
    ticker: current.ticker,
    symbol: current.symbol,
    market: current,
    previousSnapshot: previous,
    currentSnapshot: current,
    changes,
    evidence: {
      chainId: PON_CHAIN_ID,
      factory: PON_FACTORY,
      factoryCodeHash: PON_FACTORY_RUNTIME_HASH,
      bindingVerifiedAtBlock: finalizedBlock,
      bindingVerifiedAtBlockHash: finalizedBlockHash,
      apiHealthBlock: transition.apiHealthBlock,
      transitionRevision: transition.revision,
      api: { healthUrl: PON_HEALTH_URL, marketsUrl: PON_MARKETS_URL, tokenListUrl: PON_TOKEN_LIST_URL },
    },
  };
}

function platformTokenEvent(previous, current, transition, verification, observedAt) {
  const changes = objectChanges(previous, current);
  return {
    ...baseEvent("platform_token_update", observedAt, PON_PLATFORM_TOKEN_URL),
    eventKey: transition.eventKey,
    title: "pon.fun 平台代币资料更新",
    summary: "The official PONFUN token metadata changed while the platform Factory identity remained verified.",
    token: current.address,
    contractAddress: current.address,
    symbol: current.symbol,
    previousSnapshot: previous,
    currentSnapshot: current,
    changes,
    evidence: {
      chainId: PON_CHAIN_ID,
      factory: PON_FACTORY,
      factoryCodeHash: PON_FACTORY_RUNTIME_HASH,
      bindingVerifiedAtBlock: verification.verifiedBlock,
      bindingVerifiedAtBlockHash: verification.verifiedBlockHash,
      apiHealthBlock: transition.apiHealthBlock,
      transitionRevision: transition.revision,
      platformToken: verification,
      api: { healthUrl: PON_HEALTH_URL, platformTokenUrl: PON_PLATFORM_TOKEN_URL },
    },
  };
}

function acceptedDelivery(result) {
  const status = String(result?.status || "").toLowerCase();
  if (["delivered", "queued"].includes(status)) return true;
  if (status !== "suppressed" || result?.terminal === false || result?.disposition === "retry") return false;
  return new Set([
    "semantic_duplicate",
    "freshness_too_old",
    "delivery_ttl_expired",
    "blocked_event",
    "repeated_official_token",
    "policy_suppressed",
  ]).has(String(result?.reason || result?.disabledReason || "").toLowerCase());
}

const DELAYED_CRITICAL_KINDS = new Set([
  "factory_config",
  "curve_params",
  "stock_listing",
  "factory_paused",
  "factory_unpaused",
  "ownership_transfer_started",
  "ownership_transferred",
]);

function apiMarketMap(markets) {
  return new Map(markets.map((market) => [market.coin.toLowerCase(), market]));
}

function pruneObject(object, limit, order) {
  const entries = Object.entries(object);
  if (entries.length <= limit) return object;
  entries.sort(order);
  return Object.fromEntries(entries.slice(0, limit));
}

function comparePending([, left], [, right]) {
  return Number(left.proof?.blockNumber || 0) - Number(right.proof?.blockNumber || 0)
    || Number(left.proof?.logIndex || 0) - Number(right.proof?.logIndex || 0);
}

function addProcessed(state, eventKey, limit) {
  state.processedEventKeys = [...new Set([...state.processedEventKeys, eventKey])].slice(-limit);
}

function reconcileControlState(state, snapshot) {
  const expectedInfrastructure = {
    owner: snapshot.owner,
    pendingOwner: snapshot.pendingOwner,
    oracle: snapshot.oracle,
    usdg: snapshot.usdg,
    swapRouter: snapshot.swapRouter,
    positionManager: snapshot.positionManager,
    protocolTreasury: snapshot.protocolTreasury,
    paused: snapshot.paused,
    coinImpl: snapshot.coinImpl,
    vaultImpl: snapshot.vaultImpl,
    curveImpl: snapshot.curveImpl,
    marketCount: snapshot.marketCount,
    listingCount: snapshot.listingCount,
  };
  const tracked = state.infrastructure || {};
  for (const key of ["owner", "pendingOwner", "oracle", "usdg", "swapRouter", "positionManager", "protocolTreasury", "paused"]) {
    if (tracked[key] !== undefined && String(tracked[key]).toLowerCase() !== String(expectedInfrastructure[key]).toLowerCase()) {
      throw ponError("chain", "PON_CONTROL_EVENT_GAP", `factory ${key} changed without a matching finalized event`);
    }
  }
  if (state.curveParams && JSON.stringify(state.curveParams) !== JSON.stringify(snapshot.curveParams)) {
    throw ponError("chain", "PON_CONTROL_EVENT_GAP", "factory curveParams changed without a matching finalized event");
  }
  state.infrastructure = expectedInfrastructure;
  state.curveParams = snapshot.curveParams;
}

function markSourceHealthy(state, key, current, intervalMs) {
  const health = state._health.sources[key];
  health.status = "healthy";
  health.lastAttemptAt = iso(current);
  health.lastSuccessAt = iso(current);
  health.consecutiveFailures = 0;
  health.failureSince = null;
  health.lastErrorAt = null;
  health.lastError = null;
  health.lastErrorCode = null;
  health.nextAttemptAt = iso(current + intervalMs);
}

function markSourceFailed(state, key, current, error, backoffBaseMs, backoffMaxMs) {
  const health = state._health.sources[key] || (state._health.sources[key] = sourceHealth());
  const failures = Number(health.consecutiveFailures || 0) + 1;
  health.status = "backoff";
  health.lastAttemptAt = iso(current);
  health.lastErrorAt = iso(current);
  health.lastError = String(error?.message || error).slice(0, 1_000);
  health.lastErrorCode = String(error?.code || "PON_UNKNOWN_FAILURE");
  health.consecutiveFailures = failures;
  health.failureSince ||= iso(current);
  health.nextAttemptAt = iso(current + Math.min(backoffMaxMs, backoffBaseMs * (2 ** Math.min(20, failures - 1))));
}

function markCycleFailed(state, current, error, backoffBaseMs, backoffMaxMs) {
  const health = state._health;
  const failures = Number(health.consecutiveFailures || 0) + 1;
  health.checkedAt = iso(current);
  health.lastErrorAt = iso(current);
  health.lastError = String(error?.message || error).slice(0, 1_000);
  health.lastErrorCode = String(error?.code || "PON_UNKNOWN_FAILURE");
  health.consecutiveFailures = failures;
  health.failureSince ||= iso(current);
  health.recoveryConsecutive = 0;
  health.recoverySince = null;
  const failureAge = current - Date.parse(health.failureSince);
  health.status = failures >= INCIDENT_OPEN_FAILURES && failureAge >= INCIDENT_OPEN_AGE_MS ? "critical" : "degraded";
  health.nextAttemptAt = iso(current + Math.min(backoffMaxMs, backoffBaseMs * (2 ** Math.min(20, failures - 1))));
  // The cycle gate suspends every source, including endpoints that succeeded
  // before a later chain check failed. Publish their effective retry time so
  // consumers do not treat a deliberate global cooldown as a stalled source.
  const cycleRetryAt = Date.parse(health.nextAttemptAt);
  for (const source of Object.values(health.sources)) {
    source.nextAttemptAt = iso(Math.max(cycleRetryAt, Date.parse(source.nextAttemptAt || "") || 0));
  }
}

function markCycleHealthy(state, current, intervalMs) {
  const health = state._health;
  const wasIncident = ["critical", "recovering"].includes(health.status);
  if (wasIncident) {
    health.recoverySince ||= iso(current);
    health.recoveryConsecutive = Number(health.recoveryConsecutive || 0) + 1;
    const recoveryAge = current - Date.parse(health.recoverySince);
    health.status = health.recoveryConsecutive >= INCIDENT_RECOVERY_SUCCESSES || recoveryAge >= INCIDENT_RECOVERY_AGE_MS
      ? "healthy"
      : "recovering";
  } else {
    health.status = "healthy";
    health.recoveryConsecutive = 0;
    health.recoverySince = null;
  }
  health.checkedAt = iso(current);
  health.lastSuccessAt = iso(current);
  health.lastErrorAt = null;
  health.lastError = null;
  health.lastErrorCode = null;
  health.consecutiveFailures = 0;
  health.failureSince = null;
  health.nextAttemptAt = iso(current + intervalMs);
}

export function createPonMonitor(config = {}, dependencies = {}) {
  const enabled = config.ponMonitorEnabled === true;
  const rawProvider = dependencies.provider;
  let cycleController = null;
  const provider = rawProvider ? new Proxy(rawProvider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args) => abortable(
        Promise.resolve().then(() => value.apply(target, args)),
        cycleController?.signal,
        "chain",
      );
    },
  }) : null;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const alertSender = dependencies.sendAlertsImpl || sendAlerts;
  const fsImpl = dependencies.fsImpl || fs;
  const logger = dependencies.logger || console;
  const clock = dependencies.now || Date.now;
  const autoStart = dependencies.autoStart !== false;
  const stateFile = config.ponStateFile || path.join(config.dataDir || ".data", "pon-state.json");
  const pollIntervalMs = Math.max(250, Number(config.ponPollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
  const requestTimeoutMs = Math.max(250, Number(config.ponRequestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
  const confirmations = Math.max(0, Number(config.ponConfirmations ?? config.confirmations) || 0);
  const eventChunkSize = Math.max(1, Number(config.ponEventChunkSize) || DEFAULT_EVENT_CHUNK_SIZE);
  const maxBlocksPerCycle = Math.max(eventChunkSize, Number(config.ponMaxBlocksPerCycle) || DEFAULT_MAX_BLOCKS_PER_CYCLE);
  const pendingLimit = Math.min(DEFAULT_PENDING_LIMIT, Math.max(1, Number(config.ponPendingLimit) || DEFAULT_PENDING_LIMIT));
  const pendingBatchSize = Math.max(1, Math.min(
    pendingLimit,
    Number(config.ponPendingBatchSize) || DEFAULT_PENDING_BATCH_SIZE,
  ));
  const validationConcurrency = Math.max(1, Math.min(
    16,
    Number(config.ponValidationConcurrency) || DEFAULT_VALIDATION_CONCURRENCY,
  ));
  const processedLimit = Math.min(DEFAULT_PROCESSED_LIMIT, Math.max(10, Number(config.ponProcessedEventLimit) || DEFAULT_PROCESSED_LIMIT));
  const backoffBaseMs = Math.max(250, Number(config.ponBackoffBaseMs) || DEFAULT_BACKOFF_BASE_MS);
  const backoffMaxMs = Math.max(backoffBaseMs, Number(config.ponBackoffMaxMs) || DEFAULT_BACKOFF_MAX_MS);
  const reorgRewindBlocks = Math.max(16, Number(config.ponReorgRewindBlocks) || DEFAULT_REORG_REWIND_BLOCKS);
  const configuredApiMaxBlockLag = Number(config.ponApiMaxBlockLag);
  const apiMaxBlockLag = Number.isFinite(configuredApiMaxBlockLag)
    ? Math.max(0, configuredApiMaxBlockLag)
    : DEFAULT_API_MAX_BLOCK_LAG;
  const checkpointLimit = Math.min(DEFAULT_CHECKPOINT_LIMIT, Math.max(8, Number(config.ponFinalizedCheckpointLimit) || DEFAULT_CHECKPOINT_LIMIT));
  const orphanedEventLimit = Math.min(DEFAULT_ORPHANED_EVENT_LIMIT, Math.max(10, Number(config.ponReorgOrphanedEventLimit) || DEFAULT_ORPHANED_EVENT_LIMIT));
  const expectedFactoryCodeHash = dependencies.expectedFactoryCodeHash || PON_FACTORY_RUNTIME_HASH;
  const expectedCreationInputHash = dependencies.expectedCreationInputHash || PON_FACTORY_CREATION_INPUT_HASH;
  const writeStateImpl = dependencies.atomicWriteImpl || ((file, value) => atomicWritePonState(file, value, fsImpl));
  let state = emptyState();
  let initialized = false;
  let stopped = false;
  let activeCheck = null;
  let writeQueue = Promise.resolve();
  let stopPromise = null;

  if (enabled && !rawProvider) throw new Error("createPonMonitor requires a Robinhood Chain provider");

  async function initialize() {
    if (initialized) return;
    state = await readState(stateFile, fsImpl);
    if (Object.keys(state.pendingMarketEvents).length > pendingLimit) {
      throw ponError("state", "PON_PENDING_CAPACITY_EXCEEDED", "persisted pon.fun pending market queue exceeds its configured capacity");
    }
    state.finalizedCheckpoints = state.finalizedCheckpoints.slice(-checkpointLimit);
    state.reorgOrphanedEventKeys = state.reorgOrphanedEventKeys.slice(-orphanedEventLimit);
    initialized = true;
  }

  function persist() {
    const snapshot = structuredClone(state);
    const operation = writeQueue.catch(() => {}).then(() => writeStateImpl(stateFile, snapshot));
    writeQueue = operation;
    return operation;
  }

  function rememberAlertOrigin(event, processedKey = null) {
    const blockNumber = Number(event.blockNumber ?? event.evidence?.bindingVerifiedAtBlock);
    const blockHash = String(event.blockHash ?? event.evidence?.bindingVerifiedAtBlockHash ?? "");
    if (!Number.isSafeInteger(blockNumber) || !/^0x[a-fA-F0-9]{64}$/.test(blockHash)) return;
    let rollback = null;
    if (event.kind === "market_lifecycle") {
      rollback = { type: "market", key: String(event.token).toLowerCase(), snapshot: structuredClone(event.previousSnapshot) };
    } else if (event.kind === "platform_token_update") {
      rollback = { type: "platform_token", snapshot: structuredClone(event.previousSnapshot) };
    } else if (event.kind === "market_created") {
      rollback = { type: "market", key: String(event.token).toLowerCase(), snapshot: state.markets[String(event.token).toLowerCase()] || null };
    } else if (event.kind === "curve_params") {
      rollback = { type: "curve_params", snapshot: structuredClone(state.curveParams) };
    } else if (event.kind === "stock_listing") {
      rollback = {
        type: "stock_listing",
        key: event.ticker,
        snapshot: state.listings[event.ticker] ? structuredClone(state.listings[event.ticker]) : null,
        retirement: state.retiredMarkets[event.ticker] ? structuredClone(state.retiredMarkets[event.ticker]) : null,
      };
    } else if (DELAYED_CRITICAL_KINDS.has(event.kind)) {
      rollback = { type: "infrastructure", snapshot: structuredClone(state.infrastructure) };
    }
    state.alertOrigins[event.eventKey] = {
      blockNumber,
      blockHash,
      processedKey,
      kind: event.kind,
      recordedAt: event.observedAt,
      rollback,
    };
    const retained = Object.entries(state.alertOrigins)
      .sort(([, left], [, right]) => Number(right.blockNumber) - Number(left.blockNumber))
      .slice(0, processedLimit);
    state.alertOrigins = Object.fromEntries(retained);
  }

  async function deliver(event, { processedKey = null } = {}) {
    const outgoing = {
      ...event,
      reorgOrphanedEventKeys: [...state.reorgOrphanedEventKeys],
    };
    let result;
    try { result = await alertSender(config, outgoing); }
    catch (error) {
      throw ponError("delivery", "PON_ALERT_NOT_DURABLE", `pon.fun alert delivery threw: ${error.message}`);
    }
    if (!acceptedDelivery(result)) {
      throw ponError("delivery", "PON_ALERT_NOT_DURABLE", `pon.fun alert was not durably queued${result?.reason ? `: ${result.reason}` : ""}`);
    }
    const suppressionReason = String(result?.reason || result?.disabledReason || "").toLowerCase();
    if (suppressionReason === "freshness_too_old" && DELAYED_CRITICAL_KINDS.has(event.kind)) {
      const sourceOccurredAt = event.blockTimestamp;
      const recoveredAt = event.observedAt;
      const sourceMs = Date.parse(sourceOccurredAt || "");
      const recoveredMs = Date.parse(recoveredAt || "");
      const delayedRecovery = {
        version: 1,
        reason: "monitoring_gap_recovery",
        gapSince: state._health.failureSince || sourceOccurredAt,
        sourceOccurredAt,
        recoveredAt,
        lagMs: Number.isFinite(sourceMs) && Number.isFinite(recoveredMs)
          ? Math.max(0, recoveredMs - sourceMs)
          : 0,
        cursor: {
          nextBlockAtRecovery: Number(state.cursor.nextBlock),
          eventBlock: Number(event.blockNumber),
        },
      };
      const recoveryEvent = {
        ...outgoing,
        eventKey: `${event.eventKey}:delayed-recovery:v1`,
        originalEventKey: event.eventKey,
        title: `pon.fun 延迟恢复摘要：${event.title}`,
        summary: "A still-relevant structural change was recovered after a monitoring gap; the original finalized proof and change are preserved.",
        delayedRecovery,
      };
      let recoveryResult;
      try { recoveryResult = await alertSender(config, recoveryEvent); }
      catch (error) {
        throw ponError("delivery", "PON_ALERT_NOT_DURABLE", `pon.fun delayed recovery delivery threw: ${error.message}`);
      }
      const recoveryReason = String(recoveryResult?.reason || recoveryResult?.disabledReason || "").toLowerCase();
      const recoveryStatus = String(recoveryResult?.status || "").toLowerCase();
      const recoveryDurable = ["delivered", "queued"].includes(recoveryStatus)
        || (recoveryStatus === "suppressed"
          && recoveryReason === "semantic_duplicate"
          && recoveryResult?.persisted === true
          && recoveryResult?.terminal !== false);
      if (!recoveryDurable) {
        throw ponError("delivery", "PON_ALERT_NOT_DURABLE", "pon.fun delayed recovery summary was not durably queued");
      }
      const summary = {
        eventKey: recoveryEvent.eventKey,
        originalEventKey: event.eventKey,
        kind: event.kind,
        priority: "T2",
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        blockTimestamp: event.blockTimestamp,
        observedAt: event.observedAt,
        changes: event.changes,
        recordedAt: iso(nowMs(clock)),
        delayedRecovery,
      };
      state.missedCriticalChanges = [...state.missedCriticalChanges, summary].slice(-200);
      state._health.missedCriticalChangeCount = Number(state._health.missedCriticalChangeCount || 0) + 1;
      state._health.lastMissedCriticalChangeAt = summary.recordedAt;
      rememberAlertOrigin(recoveryEvent, processedKey);
    }
    rememberAlertOrigin(outgoing, processedKey);
    await persist();
    return result;
  }

  async function reserveApiTransition(lane, prefix, fingerprint, apiHealthBlock, bindingBlock, observedAt) {
    const existing = state.pendingApiTransitions[lane];
    if (existing?.fingerprint === fingerprint) return existing;
    if (existing) {
      throw ponError(
        "state",
        "PON_API_TRANSITION_CHANGED_BEFORE_DELIVERY",
        `pon.fun API transition ${lane} changed before its reserved alert was durably consumed`,
      );
    }
    const revision = Number(state.apiTransitionRevisions[lane] || 0) + 1;
    const transition = {
      lane,
      fingerprint,
      revision,
      apiHealthBlock,
      bindingBlock,
      eventKey: `${prefix}:rev:${revision}:api:${apiHealthBlock}:binding:${bindingBlock}`,
      reservedAt: observedAt,
    };
    state.apiTransitionRevisions[lane] = revision;
    state.pendingApiTransitions[lane] = transition;
    await persist();
    return transition;
  }

  function completeApiTransition(lane, eventKey) {
    if (state.pendingApiTransitions[lane]?.eventKey === eventKey) delete state.pendingApiTransitions[lane];
  }

  function retainablePendingMismatch(error) {
    return new Set([
      "PON_EVENT_API_MARKET_MISMATCH",
      "PON_API_TOKEN_LIST_MISMATCH",
      "PON_API_CHAIN_MARKET_MISMATCH",
      "PON_API_CHAIN_LISTING_MISMATCH",
      "PON_MARKET_NOT_ONCHAIN",
      "PON_MARKET_CODE_EMPTY",
    ]).has(String(error?.code || ""));
  }

  function addFinalizedCheckpoints(checkpoints) {
    const byBlock = new Map(state.finalizedCheckpoints.map((checkpoint) => [checkpoint.blockNumber, checkpoint]));
    for (const checkpoint of checkpoints) byBlock.set(checkpoint.blockNumber, checkpoint);
    state.finalizedCheckpoints = [...byBlock.values()]
      .sort((left, right) => left.blockNumber - right.blockNumber)
      .slice(-checkpointLimit);
  }

  async function readCheckpoint(blockNumber, observedAt) {
    const [block, marketCountResult, listingCountResult] = await Promise.all([
      provider.getBlock(blockNumber),
      callFactory(provider, "marketCount", [], blockNumber),
      callFactory(provider, "listingCount", [], blockNumber),
    ]);
    if (!block
      || Number(block.number) !== blockNumber
      || !/^0x[a-fA-F0-9]{64}$/.test(String(block.hash || ""))) {
      throw ponError("chain", "PON_CHECKPOINT_INVALID", `could not verify finalized checkpoint ${blockNumber}`);
    }
    return {
      blockNumber,
      blockHash: block.hash,
      marketCount: safeInteger(marketCountResult[0], `checkpoint ${blockNumber} marketCount`),
      listingCount: safeInteger(listingCountResult[0], `checkpoint ${blockNumber} listingCount`),
      recordedAt: observedAt,
    };
  }

  function verifyApiFreshness(health, finalizedBlock, observedAt, { allowRegression = false } = {}) {
    const coverage = state._health.apiCoverage;
    const lag = finalizedBlock - health.block;
    coverage.reportedBlock = health.block;
    coverage.finalizedBlock = finalizedBlock;
    coverage.blockLag = lag;
    coverage.maxBlockLag = apiMaxBlockLag;
    if (!allowRegression && Number.isSafeInteger(coverage.highWaterBlock) && health.block < coverage.highWaterBlock) {
      throw ponError("api_health", "PON_API_BLOCK_REGRESSION", `pon.fun API block regressed from ${coverage.highWaterBlock} to ${health.block}`);
    }
    // A successfully authenticated health response is still a monotonic
    // observation even when it is too far behind the finalized RPC head. Keep
    // that high-water mark before failing stale so a restart cannot accept an
    // older response or reject the state we just durably wrote.
    coverage.highWaterBlock = allowRegression
      ? health.block
      : Math.max(Number(coverage.highWaterBlock || 0), health.block);
    if (lag > apiMaxBlockLag) {
      throw ponError("api_health", "PON_API_BLOCK_STALE", `pon.fun API block lags finalized RPC by ${lag} blocks (max ${apiMaxBlockLag})`);
    }
    coverage.lastVerifiedAt = observedAt;
  }

  function verifyPlatformTokenCodeContinuity(verification) {
    const previousHash = state.platformTokenVerification?.codeHash;
    if (previousHash && previousHash.toLowerCase() !== verification.codeHash.toLowerCase()) {
      throw ponError("chain", "PON_PLATFORM_TOKEN_CODE_MISMATCH", "pinned PONFUN token runtime fingerprint changed");
    }
  }

  const apiDefinitions = {
    health: ["api_health", PON_HEALTH_URL, parseHealth],
    markets: ["api_markets", PON_MARKETS_URL, parseMarkets],
    platformToken: ["api_platform_token", PON_PLATFORM_TOKEN_URL, parsePlatformToken],
    tokenList: ["api_token_list", PON_TOKEN_LIST_URL, parseTokenList],
  };

  async function fetchApiDefinitions(definitions, current) {
    const settled = await Promise.allSettled(definitions.map(async ([key, url, parser]) => {
      try { return parser(await fetchOfficialJson(fetchImpl, url, requestTimeoutMs, cycleController?.signal)); }
      catch (error) {
        if (!error.source || error.source === "http" || error.source === "schema") error.source = key;
        if (error.code === "PON_FACTORY_ROOT_MISMATCH") {
          state._health.identity.observedFactory = error.details?.observedFactory || null;
          state._health.identity.observedChainId = error.details?.observedChainId ?? null;
        }
        throw error;
      }
    }));
    settled.forEach((result, index) => {
      const key = definitions[index][0];
      if (result.status === "fulfilled") markSourceHealthy(state, key, current, pollIntervalMs);
      else markSourceFailed(state, key, current, result.reason, backoffBaseMs, backoffMaxMs);
    });
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    return settled.map((result) => result.value);
  }

  async function fetchApiSnapshot(current) {
    const [health, markets, platformToken, tokenList] = await fetchApiDefinitions([
      apiDefinitions.health,
      apiDefinitions.markets,
      apiDefinitions.platformToken,
      apiDefinitions.tokenList,
    ], current);
    return { health, markets, platformToken, tokenList };
  }

  async function fetchApiAuxiliary(current) {
    const [markets, platformToken, tokenList] = await fetchApiDefinitions([
      apiDefinitions.markets,
      apiDefinitions.platformToken,
      apiDefinitions.tokenList,
    ], current);
    return { markets, platformToken, tokenList };
  }

  async function verifyAllBaselineMarkets(api, finalizedBlock) {
    await mapBounded(api.markets, validationConcurrency, async (market) => {
      validateTokenListMarket(market, api.tokenList);
      await verifyMarketOnchain(provider, market, finalizedBlock);
    }, () => stopped);
  }

  async function baseline(
    api,
    finalizedBlock,
    finalizedBlockRecord,
    factorySnapshot,
    platformTokenVerification,
    baselineCheckpoints,
    observedAt,
  ) {
    if (!state.identity.deploymentVerified) await verifyDeployment(provider, expectedCreationInputHash);
    await verifyAllBaselineMarkets(api, finalizedBlock);
    state.identity.deploymentVerified = true;
    state.infrastructure = {
      owner: factorySnapshot.owner,
      pendingOwner: factorySnapshot.pendingOwner,
      oracle: factorySnapshot.oracle,
      usdg: factorySnapshot.usdg,
      swapRouter: factorySnapshot.swapRouter,
      positionManager: factorySnapshot.positionManager,
      protocolTreasury: factorySnapshot.protocolTreasury,
      paused: factorySnapshot.paused,
      coinImpl: factorySnapshot.coinImpl,
      vaultImpl: factorySnapshot.vaultImpl,
      curveImpl: factorySnapshot.curveImpl,
      marketCount: factorySnapshot.marketCount,
      listingCount: factorySnapshot.listingCount,
    };
    state.curveParams = factorySnapshot.curveParams;
    state.listings = Object.fromEntries(api.markets.map((market) => [market.ticker, {
      stockToken: market.stockToken,
      poolFee: market.poolFee,
      active: true,
      ticker: market.ticker,
    }]));
    state.markets = Object.fromEntries(api.markets.map((market) => [market.coin.toLowerCase(), { ...market, baseline: true, firstSeenAt: observedAt }]));
    state.platformToken = api.platformToken;
    state.platformTokenVerification = platformTokenVerification;
    state.cursor = {
      nextBlock: finalizedBlock + 1,
      lastScannedBlock: finalizedBlock,
      lastScannedBlockHash: finalizedBlockRecord.hash,
      baselineEstablishedAt: observedAt,
      marketCountAtCursor: factorySnapshot.marketCount,
      listingCountAtCursor: factorySnapshot.listingCount,
      stockListingEventsSinceSnapshot: 0,
    };
    state.initialized = true;
    state.initializedAt = observedAt;
    state.checkedAt = observedAt;
    addFinalizedCheckpoints(baselineCheckpoints);
    await persist();
  }

  async function resolvePendingMarkets(api, finalizedBlock, observedAt) {
    const markets = apiMarketMap(api.markets);
    const entries = Object.entries(state.pendingMarketEvents).sort(comparePending).slice(0, pendingBatchSize);
    const outcomes = await mapBounded(entries, validationConcurrency, async ([eventKey, pending]) => {
      const market = markets.get(String(pending.snapshot?.coin || "").toLowerCase());
      if (!market) {
        return { eventKey, pending, market: null, mismatch: "official markets API does not expose this coin" };
      }
      try {
        if (!pending.log) throw ponError("state", "PON_PENDING_LOG_MISSING", "pending MarketCreated proof is incomplete");
        const refreshedProof = await verifyLogReceipt(provider, pending.log);
        if (refreshedProof.transactionHash.toLowerCase() !== String(pending.proof?.transactionHash || "").toLowerCase()
          || refreshedProof.blockNumber !== Number(pending.proof?.blockNumber)
          || refreshedProof.blockHash.toLowerCase() !== String(pending.proof?.blockHash || "").toLowerCase()
          || refreshedProof.logIndex !== Number(pending.proof?.logIndex)) {
          throw ponError("chain", "PON_PENDING_PROOF_MISMATCH", "pending MarketCreated proof changed");
        }
        validateTokenListMarket(market, api.tokenList);
        if (!sameMarketCreation(pending.snapshot, market)) {
          throw ponError("api_markets", "PON_EVENT_API_MARKET_MISMATCH", `MarketCreated does not match API market ${market.coin}`);
        }
        await verifyMarketOnchain(provider, market, finalizedBlock);
      } catch (error) {
        if (!retainablePendingMismatch(error)) throw error;
        return { eventKey, pending, market, mismatch: String(error.message).slice(0, 500) };
      }
      return { eventKey, pending, market, mismatch: null };
    }, () => stopped);

    for (const { eventKey, pending, market, mismatch } of outcomes) {
      pending.attempts = Number(pending.attempts || 0) + 1;
      pending.lastAttemptAt = observedAt;
      if (mismatch) {
        pending.lastMismatch = mismatch;
        continue;
      }
      if (!state.markets[market.coin.toLowerCase()]) {
        const event = marketEvent(pending.snapshot, market, pending.proof, observedAt);
        if (!state.alertOrigins[event.eventKey]) await deliver(event, { processedKey: eventKey });
        addProcessed(state, eventKey, processedLimit);
        state.markets[market.coin.toLowerCase()] = { ...market, firstSeenAt: observedAt, creationProof: pending.proof };
      }
      delete state.pendingMarketEvents[eventKey];
    }
  }

  function storePendingMarket(eventKey, value) {
    if (!state.pendingMarketEvents[eventKey]
      && Object.keys(state.pendingMarketEvents).length >= pendingLimit) {
      throw ponError(
        "state",
        "PON_PENDING_CAPACITY_EXCEEDED",
        `pon.fun pending market queue reached its safe capacity of ${pendingLimit}; chain cursor will not advance`,
      );
    }
    state.pendingMarketEvents[eventKey] = value;
  }

  async function verifyStockListing(snapshot, blockTag) {
    const listingResult = await callFactory(provider, "getListing", [snapshot.ticker], blockTag);
    const raw = listingResult[0];
    const active = Boolean(raw.active ?? raw[2]);
    const rawTicker = normalizeSpace(raw.ticker ?? raw[3]);
    const ticker = rawTicker ? tickerText(rawTicker, `retired listing ${snapshot.ticker} ticker`) : "";
    const stockToken = optionalAddress(raw.stockToken ?? raw[0], `retired listing ${snapshot.ticker} stockToken`);
    const poolFee = safeInteger(raw.poolFee ?? raw[1], `retired listing ${snapshot.ticker} poolFee`, { maximum: 1_000_000 });
    if (snapshot.active) {
      if (!active
        || ticker !== snapshot.ticker
        || stockToken.toLowerCase() !== snapshot.stockToken.toLowerCase()
        || poolFee !== snapshot.poolFee) {
        throw ponError("chain", "PON_STOCK_LISTING_MISMATCH", `StockListed(true) for ${snapshot.ticker} does not match finalized Factory state`);
      }
      return { ticker, stockToken, poolFee, active: true };
    }
    if (active || ticker !== snapshot.ticker) {
      throw ponError("chain", "PON_STOCK_RETIREMENT_MISMATCH", `StockListed(false) for ${snapshot.ticker} does not match finalized inactive Factory state`);
    }
    return { ticker, stockToken, poolFee, active: false };
  }

  async function processFactoryLog(prepared, api, finalizedBlock, observedAt) {
    const { log, parsed, snapshot, proof, processedKey: eventKey } = prepared;
    if (state.processedEventKeys.includes(eventKey) || state.pendingMarketEvents[eventKey]) return;
    if (parsed.name === "MarketCreated") {
      const market = api ? apiMarketMap(api.markets).get(snapshot.coin.toLowerCase()) : null;
      if (!market) {
        storePendingMarket(eventKey, {
          eventKey,
          snapshot,
          proof,
          log: serializableLog(log),
          firstSeenAt: observedAt,
          lastAttemptAt: observedAt,
          attempts: 1,
          lastMismatch: api
            ? "official markets API does not expose this coin"
            : "waiting for the concurrent official API cross-check",
        });
        return;
      }
      let verified = false;
      try {
        validateTokenListMarket(market, api.tokenList);
        if (!sameMarketCreation(snapshot, market)) {
          throw ponError("api_markets", "PON_EVENT_API_MARKET_MISMATCH", `MarketCreated does not match API market ${market.coin}`);
        }
        await verifyMarketOnchain(provider, market, finalizedBlock);
        verified = true;
      } catch (error) {
        if (!retainablePendingMismatch(error)) throw error;
        storePendingMarket(eventKey, {
          eventKey,
          snapshot,
          proof,
          log: serializableLog(log),
          firstSeenAt: observedAt,
          lastAttemptAt: observedAt,
          attempts: 1,
          lastMismatch: String(error.message).slice(0, 500),
        });
      }
      if (!verified) return;
      if (!state.markets[market.coin.toLowerCase()]) {
        const event = marketEvent(snapshot, market, proof, observedAt);
        if (!state.alertOrigins[event.eventKey]) await deliver(event, { processedKey: eventKey });
        state.markets[market.coin.toLowerCase()] = { ...market, firstSeenAt: observedAt, creationProof: proof };
      }
      addProcessed(state, eventKey, processedLimit);
      return;
    }
    const event = factoryEvent(parsed, snapshot, proof, state, observedAt);
    const verifiedListing = parsed.name === "StockListed"
      ? await verifyStockListing(snapshot, proof.blockNumber)
      : null;
    if (!state.alertOrigins[event.eventKey]) await deliver(event, { processedKey: eventKey });
    applyFactorySnapshot(state, parsed, snapshot);
    if (parsed.name === "StockListed") {
      if (snapshot.active) delete state.retiredMarkets[snapshot.ticker];
      else {
        state.retiredMarkets[snapshot.ticker] = {
          ...verifiedListing,
          eventKey: event.eventKey,
          processedKey: eventKey,
          blockNumber: proof.blockNumber,
          blockHash: proof.blockHash,
          transactionHash: proof.transactionHash,
          logIndex: proof.logIndex,
          retiredAt: observedAt,
        };
      }
    }
    addProcessed(state, eventKey, processedLimit);
  }

  async function scanEvents(latestFinalized, observedAt) {
    let nextBlock = Number(state.cursor.nextBlock);
    let scanned = 0;
    let lastBlock = state.cursor.lastScannedBlock;
    let lastBlockHash = state.cursor.lastScannedBlockHash;
    const preparedLogs = [];
    const checkpoints = [];
    let marketCreatedCount = 0;
    let stockListedCount = 0;
    while (nextBlock <= latestFinalized && scanned < maxBlocksPerCycle) {
      if (stopped) throw ponError("chain", "PON_STOPPED", "pon.fun monitor stopped during log scan");
      const toBlock = Math.min(latestFinalized, nextBlock + eventChunkSize - 1, nextBlock + maxBlocksPerCycle - scanned - 1);
      const fixedEnd = await provider.getBlock(toBlock);
      if (!fixedEnd
        || Number(fixedEnd.number) !== toBlock
        || !/^0x[a-fA-F0-9]{64}$/.test(String(fixedEnd.hash || ""))) {
        throw ponError("chain", "PON_SCAN_BLOCK_INVALID", `pon.fun scan end block ${toBlock} is invalid`);
      }
      let logs;
      try {
        logs = await provider.getLogs({
          address: PON_FACTORY,
          fromBlock: nextBlock,
          toBlock,
          topics: [[...Object.values(PON_FACTORY_EVENT_TOPICS)]],
        });
      } catch (error) {
        throw ponError("chain", "PON_GET_LOGS_FAILED", `pon.fun log scan ${nextBlock}-${toBlock} failed: ${error.message}`);
      }
      if (!Array.isArray(logs)) {
        throw ponError("chain", "PON_LOG_BOUNDARY_INVALID", `pon.fun RPC returned a non-array log result for ${nextBlock}-${toBlock}`);
      }
      const ordered = [...logs].sort((left, right) => Number(left.blockNumber) - Number(right.blockNumber)
        || Number(left.transactionIndex || 0) - Number(right.transactionIndex || 0)
        || logIndex(left) - logIndex(right));
      for (const log of ordered) {
        if (stopped) throw ponError("chain", "PON_STOPPED", "pon.fun monitor stopped during log verification");
        if (log.removed === true
          || !Number.isSafeInteger(log.blockNumber)
          || log.blockNumber < nextBlock
          || log.blockNumber > toBlock
          || log.blockNumber > latestFinalized
          || String(log.address || "").toLowerCase() !== PON_FACTORY.toLowerCase()
          || !Array.isArray(log.topics)
          || !EVENT_TOPIC_SET.has(String(log.topics[0] || "").toLowerCase())
          || !/^0x[a-fA-F0-9]{64}$/.test(String(log.blockHash || ""))) {
          throw ponError("chain", "PON_LOG_BOUNDARY_INVALID", `pon.fun RPC returned a non-canonical log for ${nextBlock}-${toBlock}`);
        }
        const parsed = decodedEvent(log);
        const snapshot = decodedSnapshot(parsed);
        const proof = await verifyLogReceipt(provider, log);
        if (proof.blockHash.toLowerCase() !== String(log.blockHash).toLowerCase()
          || (log.blockNumber === toBlock && proof.blockHash.toLowerCase() !== String(fixedEnd.hash).toLowerCase())) {
          throw ponError("chain", "PON_LOG_CANONICAL_HASH_MISMATCH", `pon.fun log block hash changed inside scan ${nextBlock}-${toBlock}`);
        }
        const topic0 = String(log.topics?.[0] || "").toLowerCase();
        if (topic0 === PON_FACTORY_EVENT_TOPICS.MarketCreated.toLowerCase()) marketCreatedCount += 1;
        if (topic0 === PON_FACTORY_EVENT_TOPICS.StockListed.toLowerCase()) stockListedCount += 1;
        preparedLogs.push({ log, parsed, snapshot, proof, processedKey: logEventKey(log) });
      }
      const checkpoint = await readCheckpoint(toBlock, observedAt);
      if (String(checkpoint.blockHash).toLowerCase() !== String(fixedEnd.hash).toLowerCase()) {
        throw ponError("chain", "PON_SCAN_ANCHOR_CHANGED", `pon.fun scan end block ${toBlock} changed during verification`);
      }
      lastBlock = toBlock;
      lastBlockHash = checkpoint.blockHash;
      checkpoints.push(checkpoint);
      scanned += toBlock - nextBlock + 1;
      nextBlock = toBlock + 1;
    }
    return {
      caughtUp: nextBlock > latestFinalized,
      nextBlock,
      lastScannedBlock: lastBlock,
      lastScannedBlockHash: lastBlockHash,
      preparedLogs,
      checkpoints,
      marketCreatedCount,
      stockListedCount,
    };
  }

  function coverageAfterScan(scanResult, factorySnapshot) {
    const priorMarketCount = Number(state.cursor.marketCountAtCursor);
    const hasPriorMarketCount = Number.isSafeInteger(state.cursor.marketCountAtCursor) && priorMarketCount >= 0;
    const priorListingCount = Number(state.cursor.listingCountAtCursor);
    const hasPriorListingCount = Number.isSafeInteger(state.cursor.listingCountAtCursor) && priorListingCount >= 0;
    const accumulatedStockEvents = Number(state.cursor.stockListingEventsSinceSnapshot || 0)
      + scanResult.stockListedCount;
    const nextMarketCount = hasPriorMarketCount
      ? priorMarketCount + scanResult.marketCreatedCount
      : null;
    const endpoint = scanResult.checkpoints.at(-1) || null;
    const observedMarketCount = endpoint?.marketCount ?? priorMarketCount;
    const observedListingCount = endpoint?.listingCount ?? priorListingCount;

    if (hasPriorMarketCount && nextMarketCount !== observedMarketCount) {
      throw ponError(
        "chain",
        "PON_MARKET_EVENT_COVERAGE_GAP",
        `Factory marketCount moved from ${priorMarketCount} to ${observedMarketCount}, but the finalized scan contained ${scanResult.marketCreatedCount} MarketCreated event(s)`,
      );
    }
    if (hasPriorListingCount) {
      const listingDelta = observedListingCount - priorListingCount;
      if (listingDelta < 0 || listingDelta > accumulatedStockEvents) {
        throw ponError(
          "chain",
          "PON_LISTING_EVENT_COVERAGE_GAP",
          `Factory listingCount moved from ${priorListingCount} to ${factorySnapshot.listingCount}, but the finalized scan covered only ${accumulatedStockEvents} StockListed event(s)`,
        );
      }
    }
    if (scanResult.caughtUp && observedMarketCount !== factorySnapshot.marketCount) {
      throw ponError("chain", "PON_MARKET_EVENT_COVERAGE_GAP", "scan checkpoint marketCount does not match the finalized Factory snapshot");
    }
    if (scanResult.caughtUp && observedListingCount !== factorySnapshot.listingCount) {
      throw ponError("chain", "PON_LISTING_EVENT_COVERAGE_GAP", "scan checkpoint listingCount does not match the finalized Factory snapshot");
    }

    return {
      marketCountAtCursor: observedMarketCount,
      listingCountAtCursor: observedListingCount,
      stockListingEventsSinceSnapshot: scanResult.caughtUp ? 0 : accumulatedStockEvents,
    };
  }

  function retainOrphanFacts(orphanedKeys, observedAt, reason) {
    const unique = [...new Set(orphanedKeys)].filter(Boolean);
    if (!unique.length) return;
    state.reorgOrphanedEventKeys = [...new Set([
      ...state.reorgOrphanedEventKeys,
      ...unique,
    ])].slice(-orphanedEventLimit);
    state._health.reorg.orphanedAlertCount = Number(state._health.reorg.orphanedAlertCount || 0) + unique.length;
    state._health.reorg.lastOrphanedAt = observedAt;
    state._health.reorg.lastOrphanedEventKeys = unique.slice(-50);
    state._health.reorg.lastOrphanReason = reason;
  }

  function applyOriginRollbacks(origins) {
    const ordered = [...origins].sort(([, left], [, right]) => right.blockNumber - left.blockNumber);
    for (const [, origin] of ordered) {
      const rollback = origin.rollback;
      if (!stateRecord(rollback)) continue;
      if (rollback.type === "market") {
        if (stateRecord(rollback.snapshot)) state.markets[rollback.key] = structuredClone(rollback.snapshot);
        else delete state.markets[rollback.key];
      } else if (rollback.type === "platform_token" && stateRecord(rollback.snapshot)) {
        state.platformToken = structuredClone(rollback.snapshot);
      } else if (rollback.type === "curve_params") {
        state.curveParams = stateRecord(rollback.snapshot) ? structuredClone(rollback.snapshot) : null;
      } else if (rollback.type === "stock_listing") {
        if (stateRecord(rollback.snapshot)) state.listings[rollback.key] = structuredClone(rollback.snapshot);
        else delete state.listings[rollback.key];
        if (stateRecord(rollback.retirement)) state.retiredMarkets[rollback.key] = structuredClone(rollback.retirement);
        else delete state.retiredMarkets[rollback.key];
      } else if (rollback.type === "infrastructure") {
        state.infrastructure = stateRecord(rollback.snapshot) ? structuredClone(rollback.snapshot) : null;
      }
    }
  }

  async function verifyTentativeAlertOrigins(observedAt) {
    const cursorBlock = Number(state.cursor.lastScannedBlock || 0);
    const tentative = Object.entries(state.alertOrigins).filter(([, origin]) => origin.blockNumber > cursorBlock);
    if (!tentative.length) return;
    const hashes = new Map();
    for (const [, origin] of tentative) {
      if (!hashes.has(origin.blockNumber)) {
        const block = await provider.getBlock(origin.blockNumber);
        hashes.set(origin.blockNumber, String(block?.hash || "").toLowerCase());
      }
    }
    const orphaned = tentative.filter(([, origin]) => hashes.get(origin.blockNumber) !== String(origin.blockHash).toLowerCase());
    if (!orphaned.length) return;
    const orphanedKeys = orphaned.map(([eventKey]) => eventKey);
    const processedKeys = new Set(orphaned.map(([, origin]) => origin.processedKey).filter(Boolean));
    applyOriginRollbacks(orphaned);
    retainOrphanFacts(orphanedKeys, observedAt, "tentative_origin_reorg");
    state.processedEventKeys = state.processedEventKeys.filter((key) => !processedKeys.has(key));
    state.alertOrigins = Object.fromEntries(Object.entries(state.alertOrigins)
      .filter(([eventKey]) => !orphanedKeys.includes(eventKey)));
    await persist();
  }

  async function verifyCursor(observedAt) {
    if (state.cursor.lastScannedBlock == null || !state.cursor.lastScannedBlockHash) return false;
    const block = await provider.getBlock(Number(state.cursor.lastScannedBlock));
    if (block && String(block.hash).toLowerCase() === String(state.cursor.lastScannedBlockHash).toLowerCase()) return false;
    const oldLastBlock = Number(state.cursor.lastScannedBlock);
    const candidates = state.finalizedCheckpoints
      .filter((checkpoint) => checkpoint.blockNumber <= oldLastBlock)
      .sort((left, right) => right.blockNumber - left.blockNumber);
    let ancestor = null;
    for (const checkpoint of candidates) {
      if (stopped) throw ponError("chain", "PON_STOPPED", "pon.fun monitor stopped during reorg proof");
      const candidate = await provider.getBlock(checkpoint.blockNumber);
      if (candidate && String(candidate.hash).toLowerCase() === String(checkpoint.blockHash).toLowerCase()) {
        ancestor = checkpoint;
        break;
      }
    }
    if (!ancestor) {
      state._health.reorg = {
        ...state._health.reorg,
        lastDetectedAt: observedAt,
        rewindFrom: oldLastBlock,
        rewindTo: null,
        commonAncestorBlock: null,
        commonAncestorProven: false,
        unprovenAt: observedAt,
        recoveryPending: true,
      };
      await persist();
      throw ponError(
        "chain",
        "PON_REORG_COMMON_ANCESTOR_UNPROVEN",
        "pon.fun finalized reorg has no matching persisted checkpoint; cursor remains frozen",
      );
    }
    const rewindTo = ancestor.blockNumber + 1;
    const orphanOrigins = Object.entries(state.alertOrigins)
      .filter(([, origin]) => origin.blockNumber > ancestor.blockNumber);
    const orphanedKeys = orphanOrigins.map(([eventKey]) => eventKey);
    const orphanedProcessedKeys = new Set(orphanOrigins.map(([, origin]) => origin.processedKey).filter(Boolean));
    retainOrphanFacts(orphanedKeys, observedAt, "finalized_reorg");
    applyOriginRollbacks(orphanOrigins);
    state.processedEventKeys = state.processedEventKeys.filter((key) => !orphanedProcessedKeys.has(key));
    state.alertOrigins = Object.fromEntries(Object.entries(state.alertOrigins)
      .filter(([, origin]) => origin.blockNumber <= ancestor.blockNumber));
    state.retiredMarkets = Object.fromEntries(Object.entries(state.retiredMarkets)
      .filter(([, retirement]) => !orphanedKeys.includes(retirement.eventKey)));
    state.finalizedCheckpoints = state.finalizedCheckpoints
      .filter((checkpoint) => checkpoint.blockNumber <= ancestor.blockNumber);
    state.cursor.nextBlock = rewindTo;
    state.cursor.lastScannedBlock = ancestor.blockNumber;
    state.cursor.lastScannedBlockHash = ancestor.blockHash;
    state.cursor.marketCountAtCursor = ancestor.marketCount;
    state.cursor.listingCountAtCursor = ancestor.listingCount;
    state.cursor.stockListingEventsSinceSnapshot = 0;
    for (const [coin, market] of Object.entries(state.markets)) {
      if (market.creationProof) continue;
      const key = coin.toLowerCase();
      state.reorgBaselineMarketRechecks[key] = {
        coin: key,
        ticker: tickerText(market.ticker, `reorg baseline market ${key} ticker`),
        markedAt: state.reorgBaselineMarketRechecks[key]?.markedAt || observedAt,
        rewindFrom: oldLastBlock,
        rewindTo,
      };
    }
    state.infrastructure = null;
    state.curveParams = null;
    state.listings = {};
    state.pendingMarketEvents = Object.fromEntries(Object.entries(state.pendingMarketEvents)
      .filter(([, pending]) => Number(pending.proof?.blockNumber || 0) < rewindTo));
    state.markets = Object.fromEntries(Object.entries(state.markets)
      .filter(([, market]) => !market.creationProof || Number(market.creationProof.blockNumber || 0) < rewindTo));
    state._health.reorg = {
      ...state._health.reorg,
      count: Number(state._health.reorg.count || 0) + 1,
      lastDetectedAt: observedAt,
      rewindFrom: oldLastBlock,
      rewindTo,
      commonAncestorBlock: ancestor.blockNumber,
      commonAncestorProven: true,
      unprovenAt: null,
      recoveryPending: true,
    };
    await persist();
    return true;
  }

  async function reconcileReorgBaselineMarkets(verifiedMarkets, finalizedBlock) {
    const apiMarkets = apiMarketMap(verifiedMarkets);
    const entries = Object.entries(state.reorgBaselineMarketRechecks).sort(([left], [right]) => left.localeCompare(right));
    for (const [coin, recheck] of entries) {
      if (apiMarkets.has(coin)) {
        // verifyMarketOnchain already proved the exact API record against the
        // finalized Factory state. This is the only positive revalidation path.
        delete state.reorgBaselineMarketRechecks[coin];
        continue;
      }

      const tracked = state.markets[coin];
      if (!tracked) invalidState(`reorg baseline market ${coin} is missing its tracked snapshot`);
      const [idResult, listingResult] = await Promise.all([
        callFactory(provider, "coinToId", [coin], finalizedBlock),
        callFactory(provider, "getListing", [recheck.ticker], finalizedBlock),
      ]);
      const idPlusOne = BigInt(idResult[0]);
      const rawListing = listingResult[0];
      const listingActive = Boolean(rawListing.active ?? rawListing[2]);
      const listingTicker = normalizeSpace(rawListing.ticker ?? rawListing[3]);
      optionalAddress(rawListing.stockToken ?? rawListing[0], `reorg listing ${recheck.ticker} stockToken`);
      if (idPlusOne !== 0n
        || listingActive
        || (listingTicker && listingTicker !== recheck.ticker)) {
        throw ponError(
          "api_markets",
          "PON_API_MARKET_DISAPPEARED",
          `official pon.fun markets API stopped exposing tracked market ${recheck.ticker}, but finalized Factory state has not confirmed its removal`,
        );
      }

      // A baseline-origin market has no creation proof to replay. It may be
      // removed only after both official API absence and finalized Factory
      // absence (coinToId=0 plus an inactive/nonexistent listing) agree.
      delete state.markets[coin];
      delete state.listings[recheck.ticker];
      delete state.unmatchedApiMarkets[coin];
      delete state.reorgBaselineMarketRechecks[coin];
    }
  }

  async function updateApiLifecycle(
    api,
    finalizedBlock,
    finalizedBlockHash,
    platformTokenVerification,
    observedAt,
  ) {
    const verified = await mapBounded(api.markets, validationConcurrency, async (market) => {
      validateTokenListMarket(market, api.tokenList);
      const retirement = state.retiredMarkets[market.ticker] || null;
      await verifyMarketOnchain(provider, market, finalizedBlock, { retirement });
      return { market, retirement };
    }, () => stopped);
    const verifiedMarkets = verified.map(({ market }) => market);
    await reconcileReorgBaselineMarkets(verifiedMarkets, finalizedBlock);
    const currentApiCoins = new Set(verifiedMarkets.map((market) => market.coin.toLowerCase()));
    const disappeared = [];
    for (const [coin, market] of Object.entries(state.markets)) {
      if (currentApiCoins.has(coin.toLowerCase())) continue;
      if (state.retiredMarkets[market.ticker]) {
        delete state.markets[coin];
        delete state.listings[market.ticker];
        delete state.unmatchedApiMarkets[coin];
        continue;
      }
      disappeared.push(`${market.ticker || market.symbol || market.coin}`);
    }
    disappeared.sort();
    if (disappeared.length) {
      throw ponError(
        "api_markets",
        "PON_API_MARKET_DISAPPEARED",
        `official pon.fun markets API stopped exposing tracked market(s): ${disappeared.join(", ")}`,
      );
    }
    for (const { market, retirement } of verified) {
      const key = market.coin.toLowerCase();
      const previous = state.markets[key];
      if (!previous) {
        if (retirement) {
          retirement.apiStillPresentAt = observedAt;
          continue;
        }
        state.unmatchedApiMarkets[key] = {
          market,
          firstSeenAt: state.unmatchedApiMarkets[key]?.firstSeenAt || observedAt,
          lastSeenAt: observedAt,
          reason: "waiting for an exact MarketCreated proof",
        };
        continue;
      }
      const expectedListing = {
        stockToken: market.stockToken,
        poolFee: market.poolFee,
        active: true,
        ticker: market.ticker,
      };
      const knownListing = state.listings[market.ticker];
      const changes = {};
      for (const field of ["graduated", "lpDeployed"]) {
        if (Boolean(previous[field]) !== Boolean(market[field])) {
          changes[field] = { before: Boolean(previous[field]), after: Boolean(market[field]) };
        }
      }
      if (!retirement && knownListing
        && String(knownListing.stockToken).toLowerCase() !== market.stockToken.toLowerCase()) {
        changes.stockToken = { before: knownListing.stockToken, after: market.stockToken };
      }
      if (!retirement && knownListing && Number(knownListing.poolFee) !== market.poolFee) {
        changes.poolFee = { before: Number(knownListing.poolFee), after: market.poolFee };
      }
      const lane = `market:${key}`;
      if (Object.keys(changes).length) {
        const fingerprint = JSON.stringify({ previous: marketCore(previous), current: marketCore(market), changes });
        const transition = await reserveApiTransition(
          lane,
          `pon-fun:market-lifecycle:${key}`,
          fingerprint,
          api.health.block,
          finalizedBlock,
          observedAt,
        );
        const event = lifecycleEvent(
          previous,
          market,
          changes,
          transition,
          finalizedBlock,
          finalizedBlockHash,
          observedAt,
        );
        if (!state.alertOrigins[event.eventKey]) await deliver(event);
        completeApiTransition(lane, event.eventKey);
      } else if (state.pendingApiTransitions[lane]) {
        throw ponError("state", "PON_API_TRANSITION_CHANGED_BEFORE_DELIVERY", `reserved ${lane} transition no longer matches the official API`);
      }
      if (!retirement) state.listings[market.ticker] = expectedListing;
      state.markets[key] = {
        ...previous,
        ...market,
        lastSeenAt: observedAt,
      };
      delete state.unmatchedApiMarkets[key];
    }
    state.unmatchedApiMarkets = pruneObject(state.unmatchedApiMarkets, pendingLimit, ([, left], [, right]) =>
      Date.parse(right.lastSeenAt || 0) - Date.parse(left.lastSeenAt || 0));
    const platformLane = `platform-token:${PONFUN_TOKEN.toLowerCase()}`;
    if (state.platformToken && JSON.stringify(state.platformToken) !== JSON.stringify(api.platformToken)) {
      const changes = objectChanges(state.platformToken, api.platformToken);
      const fingerprint = JSON.stringify({ previous: state.platformToken, current: api.platformToken, changes });
      const transition = await reserveApiTransition(
        platformLane,
        `pon-fun:platform-token:${PONFUN_TOKEN.toLowerCase()}`,
        fingerprint,
        api.health.block,
        finalizedBlock,
        observedAt,
      );
      const event = platformTokenEvent(state.platformToken, api.platformToken, transition, platformTokenVerification, observedAt);
      if (!state.alertOrigins[event.eventKey]) await deliver(event);
      completeApiTransition(platformLane, event.eventKey);
    } else if (state.pendingApiTransitions[platformLane]) {
      throw ponError("state", "PON_API_TRANSITION_CHANGED_BEFORE_DELIVERY", "reserved platform-token transition no longer matches the official API");
    }
    state.platformToken = api.platformToken;
    state.platformTokenVerification = platformTokenVerification;
  }

  async function requireCanonicalBlock(blockNumber, expectedHash, code = "PON_SCAN_ANCHOR_CHANGED") {
    const block = await provider.getBlock(blockNumber);
    if (!block
      || Number(block.number) !== blockNumber
      || String(block.hash || "").toLowerCase() !== String(expectedHash || "").toLowerCase()) {
      throw ponError("chain", code, `pon.fun canonical block ${blockNumber} changed during the monitoring cycle`);
    }
    return block;
  }

  function recordAnchorFailure(error, observedAt) {
    if (!["PON_SCAN_ANCHOR_CHANGED", "PON_LOG_CANONICAL_HASH_MISMATCH"].includes(error?.code)) return;
    if (state._health.reorg.lastAnchorFailureAt !== observedAt) {
      state._health.reorg.midCycleAnchorFailures = Number(state._health.reorg.midCycleAnchorFailures || 0) + 1;
    }
    state._health.reorg.lastAnchorFailureAt = observedAt;
    state._health.reorg.lastAnchorFailureCode = error.code;
    state._health.reorg.recoveryPending = true;
  }

  async function rollbackUnstableCycle(beforeApply, observedAt, reason) {
    const working = state;
    const deliveredOrigins = Object.entries(working.alertOrigins).filter(([eventKey, origin]) => {
      const prior = beforeApply.alertOrigins[eventKey];
      return !prior || prior.blockHash !== origin.blockHash;
    });
    const orphanedKeys = deliveredOrigins.map(([eventKey]) => eventKey);
    const revisions = structuredClone(working.apiTransitionRevisions);
    state = structuredClone(beforeApply);
    for (const [lane, revision] of Object.entries(revisions)) {
      state.apiTransitionRevisions[lane] = Math.max(Number(state.apiTransitionRevisions[lane] || 0), Number(revision || 0));
    }
    retainOrphanFacts(orphanedKeys, observedAt, reason);
    state._health.reorg.midCycleAnchorFailures = Number(state._health.reorg.midCycleAnchorFailures || 0) + 1;
    state._health.reorg.lastAnchorFailureAt = observedAt;
    state._health.reorg.lastAnchorFailureCode = "PON_SCAN_ANCHOR_CHANGED";
    state._health.reorg.recoveryPending = true;
    await persist();
  }

  async function runCycle({ force = true } = {}) {
    await initialize();
    const current = nowMs(clock);
    // The first non-forced check must also honor the durable backoff loaded
    // during initialization; the outer fast path only sees in-memory state.
    if (!force && Date.parse(state._health.nextAttemptAt || "") > current) {
      return { status: "backoff", initialized: state.initialized, cursor: structuredClone(state.cursor) };
    }
    const observedAt = iso(current);
    const sourceHealthBeforeCycle = structuredClone(state._health.sources);
    try {
      if (stopped) throw abortedError();
      const baselineApi = state.initialized ? null : await fetchApiSnapshot(current);
      const health = baselineApi?.health
        || (await fetchApiDefinitions([apiDefinitions.health], current))[0];
      let head;
      try { head = safeInteger(await provider.getBlockNumber(), "RPC head", { minimum: 1 }); }
      catch (error) {
        if (error.source) throw error;
        throw ponError("chain", "PON_HEAD_FAILED", `could not read Robinhood Chain head: ${error.message}`);
      }
      // Keep the raw RPC finality boundary separate from the API-aligned cycle
      // anchor. API freshness must continue to measure the real head split;
      // clamping that value would turn every lag into zero.
      const rpcFinalizedBlock = Math.max(PON_FACTORY_DEPLOY_BLOCK, head - confirmations);
      const chainId = await providerChainId(provider);
      state._health.identity.observedChainId = chainId;
      state._health.identity.observedFactory = health.addresses.factory;
      if (chainId !== PON_CHAIN_ID) {
        throw ponError("chain", "PON_RPC_CHAIN_MISMATCH", `RPC chain ${chainId} != ${PON_CHAIN_ID}`);
      }
      if (health.block > rpcFinalizedBlock + 128) {
        throw ponError("api_health", "PON_HEALTH_BLOCK_AHEAD", "pon.fun health block is implausibly ahead of the RPC head");
      }

      let reorgDetected = false;
      if (state.initialized) {
        if (rpcFinalizedBlock < Number(state.cursor.lastScannedBlock)) {
          throw ponError("chain", "PON_FINALIZED_HEAD_BEHIND_CURSOR", "finalized Robinhood Chain head moved behind the durable pon.fun cursor");
        }
        reorgDetected = await verifyCursor(observedAt);
        await verifyTentativeAlertOrigins(observedAt);
      }
      verifyApiFreshness(health, rpcFinalizedBlock, observedAt, { allowRegression: reorgDetected });

      const finalizedBlock = Math.min(rpcFinalizedBlock, health.block);
      if (finalizedBlock < PON_FACTORY_DEPLOY_BLOCK) {
        throw ponError("api_health", "PON_API_ANCHOR_BEFORE_DEPLOYMENT", "pon.fun API common anchor predates the pinned Factory deployment");
      }
      if (state.initialized && finalizedBlock < Number(state.cursor.lastScannedBlock)) {
        throw ponError(
          "api_health",
          "PON_API_ANCHOR_BEHIND_CURSOR",
          "pon.fun API common anchor moved behind the durable chain cursor",
        );
      }
      const finalizedBlockRecord = await provider.getBlock(finalizedBlock);
      if (!finalizedBlockRecord
        || Number(finalizedBlockRecord.number) !== finalizedBlock
        || !/^0x[a-fA-F0-9]{64}$/.test(String(finalizedBlockRecord.hash || ""))) {
        throw ponError("chain", "PON_FINALIZED_BLOCK_INVALID", `finalized block ${finalizedBlock} is invalid`);
      }
      const factorySnapshot = await verifyIdentity(
        provider,
        health,
        finalizedBlock,
        expectedFactoryCodeHash,
        state,
        chainId,
      );
      if (!state.initialized) {
        const platformTokenVerification = await verifyPlatformTokenOnchain(
          provider,
          baselineApi.platformToken,
          finalizedBlock,
          finalizedBlockRecord.hash,
        );
        verifyPlatformTokenCodeContinuity(platformTokenVerification);
        const lookbackBlock = Math.max(PON_FACTORY_DEPLOY_BLOCK, finalizedBlock - reorgRewindBlocks);
        const checkpointBlocks = [...new Set([lookbackBlock, finalizedBlock])];
        const baselineCheckpoints = await mapBounded(
          checkpointBlocks,
          validationConcurrency,
          (blockNumber) => readCheckpoint(blockNumber, observedAt),
          () => stopped,
        );
        const currentCheckpoint = baselineCheckpoints.find((checkpoint) => checkpoint.blockNumber === finalizedBlock);
        if (!currentCheckpoint
          || currentCheckpoint.blockHash.toLowerCase() !== finalizedBlockRecord.hash.toLowerCase()
          || currentCheckpoint.marketCount !== factorySnapshot.marketCount
          || currentCheckpoint.listingCount !== factorySnapshot.listingCount) {
          throw ponError("chain", "PON_BASELINE_ANCHOR_CHANGED", "pon.fun baseline block changed during identity verification");
        }
        await baseline(
          baselineApi,
          finalizedBlock,
          finalizedBlockRecord,
          factorySnapshot,
          platformTokenVerification,
          baselineCheckpoints,
          observedAt,
        );
        markSourceHealthy(state, "chain", current, pollIntervalMs);
        markSourceHealthy(state, "delivery", current, pollIntervalMs);
        markCycleHealthy(state, current, pollIntervalMs);
        state._health.reorg.recoveryPending = false;
        state.checkedAt = observedAt;
        await persist();
        return { status: "baseline", initialized: true, delivered: 0, cursor: structuredClone(state.cursor) };
      }

      const auxiliary = await fetchApiAuxiliary(current);
      const api = { health, ...auxiliary };
      const platformTokenVerification = await verifyPlatformTokenOnchain(
        provider,
        api.platformToken,
        finalizedBlock,
        finalizedBlockRecord.hash,
      );
      verifyPlatformTokenCodeContinuity(platformTokenVerification);
      const scanResult = await scanEvents(finalizedBlock, observedAt);
      const coverage = coverageAfterScan(scanResult, factorySnapshot);
      if (scanResult.lastScannedBlock != null) {
        await requireCanonicalBlock(scanResult.lastScannedBlock, scanResult.lastScannedBlockHash);
      }
      await requireCanonicalBlock(finalizedBlock, finalizedBlockRecord.hash);

      const beforeApply = structuredClone(state);
      await resolvePendingMarkets(api, finalizedBlock, observedAt);
      for (const prepared of scanResult.preparedLogs) {
        if (stopped) throw abortedError();
        await processFactoryLog(prepared, api, finalizedBlock, observedAt);
      }
      if (scanResult.caughtUp) {
        await updateApiLifecycle(
          api,
          finalizedBlock,
          finalizedBlockRecord.hash,
          platformTokenVerification,
          observedAt,
        );
        reconcileControlState(state, factorySnapshot);
      }

      try {
        if (scanResult.lastScannedBlock != null) {
          await requireCanonicalBlock(scanResult.lastScannedBlock, scanResult.lastScannedBlockHash);
        }
        await requireCanonicalBlock(finalizedBlock, finalizedBlockRecord.hash);
      } catch (error) {
        if (error?.code !== "PON_SCAN_ANCHOR_CHANGED") throw error;
        await rollbackUnstableCycle(beforeApply, observedAt, "mid_cycle_anchor_changed");
        throw error;
      }

      addFinalizedCheckpoints(scanResult.checkpoints);
      state.cursor.nextBlock = scanResult.nextBlock;
      state.cursor.lastScannedBlock = scanResult.lastScannedBlock;
      state.cursor.lastScannedBlockHash = scanResult.lastScannedBlockHash;
      state.cursor.marketCountAtCursor = coverage.marketCountAtCursor;
      state.cursor.listingCountAtCursor = coverage.listingCountAtCursor;
      state.cursor.stockListingEventsSinceSnapshot = coverage.stockListingEventsSinceSnapshot;
      state.checkedAt = observedAt;
      state._health.reorg.recoveryPending = false;
      markSourceHealthy(state, "chain", current, pollIntervalMs);
      markSourceHealthy(state, "delivery", current, pollIntervalMs);
      markCycleHealthy(state, current, pollIntervalMs);
      await persist();
      return {
        status: state._health.status,
        initialized: true,
        caughtUp: scanResult.caughtUp,
        pending: Object.keys(state.pendingMarketEvents).length,
        cursor: structuredClone(state.cursor),
      };
    } catch (error) {
      if (error?.code === "PON_STOPPED" && stopped) {
        state.checkedAt = observedAt;
        await persist();
        return {
          status: "stopped",
          initialized: state.initialized,
          error: error.message,
          errorCode: error.code,
          cursor: structuredClone(state.cursor),
        };
      }
      recordAnchorFailure(error, observedAt);
      if (!error.source) error.source = "chain";
      const failedSource = error.source in state._health.sources ? error.source : "chain";
      // A source may pass an early transport/identity check and fail a later
      // semantic or historical check. Only a complete source success clears
      // its previous failure streak; intermediate success is not recovery.
      // Restore before incrementing even if fetchApiDefinitions already marked
      // this source failed, so each cycle records exactly one failure.
      const previousSource = sourceHealthBeforeCycle[failedSource];
      Object.assign(state._health.sources[failedSource], {
        consecutiveFailures: previousSource.consecutiveFailures,
        failureSince: previousSource.failureSince,
        lastSuccessAt: previousSource.lastSuccessAt,
      });
      // Request latency is not cooldown time: a slow failed archive request
      // must still wait the full backoff after the failure becomes known.
      const failedAt = nowMs(clock);
      markSourceFailed(state, failedSource, failedAt, error, backoffBaseMs, backoffMaxMs);
      markCycleFailed(state, failedAt, error, backoffBaseMs, backoffMaxMs);
      state.checkedAt = iso(failedAt);
      await persist();
      logger.error?.(`[pon.fun] ${error.code || "PON_FAILURE"}: ${error.message}`);
      return {
        status: state._health.status,
        initialized: state.initialized,
        error: error.message,
        errorCode: error.code || "PON_FAILURE",
        cursor: structuredClone(state.cursor),
      };
    }
  }

  function check(options = {}) {
    if (!enabled) return Promise.resolve({ status: "disabled", initialized: false });
    if (stopped) return activeCheck || Promise.resolve({ status: "stopped", initialized: state.initialized });
    const force = options.force !== false;
    if (!force && state._health.nextAttemptAt && Date.parse(state._health.nextAttemptAt) > nowMs(clock)) {
      return Promise.resolve({ status: "backoff", initialized: state.initialized, cursor: structuredClone(state.cursor) });
    }
    if (activeCheck) return activeCheck;
    const controller = new AbortController();
    cycleController = controller;
    activeCheck = runCycle({ force }).finally(() => {
      if (cycleController === controller) cycleController = null;
      activeCheck = null;
    });
    return activeCheck;
  }

  const timer = autoStart && enabled ? setInterval(() => {
    void check({ force: false }).catch((error) => logger.error?.(`[pon.fun] scheduler: ${error.message}`));
  }, pollIntervalMs) : null;
  timer?.unref();
  if (autoStart && enabled) void check({ force: false }).catch((error) => logger.error?.(`[pon.fun] startup: ${error.message}`));

  return {
    check,
    state: () => structuredClone(state),
    stateFile,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      cycleController?.abort();
      if (timer) clearInterval(timer);
      stopPromise = (async () => {
        if (activeCheck) await activeCheck;
        await writeQueue;
      })();
      return stopPromise;
    },
  };
}
