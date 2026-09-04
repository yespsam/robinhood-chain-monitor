import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { FetchRequest, Interface, JsonRpcProvider, getAddress, id, keccak256 } from "ethers";
import { analyzeReceipt, bytecodeFeatures, readTokenMetadata } from "./detector.js";
import { assessLocalTokenSecurity } from "./local-security.js";
import { sendAlerts } from "./alerts.js";
import { inferBscLaunchpadAttribution, parseBscScanAttribution, parseDexScreenerTokenPairs } from "./bsc-attribution.js";
import { isStrictFlapTrackedPoolTokenUpdate } from "./source-controls.js";

export const BSC_CHAIN_ID = 56;
export const BSC_WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const BSC_TRANSFER_TOPIC = id("Transfer(address,address,uint256)");
export const BSC_ZERO_TOPIC = `0x${"0".repeat(64)}`;
export const BSC_PAIR_CREATED_TOPIC = id("PairCreated(address,address,address,uint256)");
export const BSC_V3_POOL_CREATED_TOPIC = id("PoolCreated(address,address,uint24,int24,address)");
export const PANCAKE_INFINITY_CL_INITIALIZE_TOPIC = "0x426cc62fe6a33a40ba2788c2c87a9c34ee4582b95bc9fa5a7bb7ae70b750b99c";
export const PANCAKE_INFINITY_BIN_INITIALIZE_TOPIC = "0xddfde5903015c0eb1671976c6c8f760f1328bec57f15286b6bdab2f955cab9c9";
export const UNISWAP_V4_INITIALIZE_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
export const FLAP_TOKEN_CREATED_TOPIC = "0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603";
export const FLAP_VAULT_TOKEN_CREATED_TOPIC = "0x1a9fe01bcb4855c926d7757a81014e36cae596a0e3047d297d2cf88ca298a77d";
const FLAP_PORTAL_ADDRESS = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
const FLAP_VAULT_PORTAL_ADDRESS = "0x90497450f2a706f1951b5bdda52b4e5d16f34c06";
export const FOUR_MEME_TOKEN_CREATE_TOPIC = "0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20";
export const FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC = "0xc285d9db59058d31582ee15fb4da72b5d13afb16e9fe17eeaedbf7cc4a6015e1";
export const OPENFOUR_TOKEN_CREATED_TOPIC = "0x7dae4dcd1b20eb0445e7cc1d02b3e2e7f32fa63081a0e764732c269f2b8f228f";
export const GRAFUN_TOKEN_SALE_CREATED_TOPIC = "0xcde74a020c2b1d58387550896d50c1140999bee9a03aabd666746c959338709a";
export const HODL_BONDING_TOKEN_LAUNCHED_TOPIC = id("TokenLaunched(address,address,address)");
export const HODL_V2_TOKEN_LAUNCHED_TOPIC = id("TokenLaunchedV2(address,address,address,uint256,uint256,uint256,uint256,bytes32,string)");
export const HODL_V3_TOKEN_LAUNCHED_TOPIC = id("TokenLaunched(address,address,uint256,address,bytes32,string,uint256)");
export const MOONSALE_PRESALE_CREATED_TOPIC = id("PresaleCreated(address,address,address,uint256,uint256)");
export const MOONSALE_FAIR_LAUNCH_CREATED_TOPIC = id("FairLaunchCreated(address,address,address,uint256,uint256)");
export const MOONSALE_TOKEN_CREATED_TOPIC = id("TokenCreated(address,address,string,string,uint8,uint256,uint256,bool,bool)");
export const MOONSALE_LIQUIDITY_TOKEN_CREATED_TOPIC = id("LiquidityTokenCreated(address,address,string,string,uint8,uint256,uint16,uint16)");
export const HUKS_TOKEN_CREATED_TOPIC = id("TokenCreated(address,address,string,string,uint256,uint256,uint256,int24,int24)");
export const AGENT_LAUNCH_TOKEN_CREATED_TOPIC = "0x91891eee2488475580e3ecb4c5bf5c89e7d3a3e4933f9ec22456f0cc7ffa16f9";
export const KARMAFI_MARKET_CREATED_TOPIC = id("MarketCreated(bytes32,address,address,address,string,string)");
export const RUG_CREATED_TOPIC = id("RugCreated(address,address,string,string,uint256,uint40,bytes32,bytes32)");
export const RUG_LAUNCH_SUCCEEDED_TOPIC = id("LaunchSucceeded(address,address,address,uint256,uint256,uint256,uint256,uint256,uint256)");
export const CREATE_TOKEN_CREATED_TOPIC = id("TokenCreated(address,address,string,string,uint256)");
export const POO_MEME_PRESALE_CREATED_TOPIC = "0x10a686e492443912098b779a2c02c2fdfbfb0562b052b588de8f17ca371e7546";
export const BNBPUMP_TOKEN_CREATED_TOPIC = "0xd5f9bdf12adf29dab0248c349842c3822d53ae2bb4f36352f301630d018c8139";
export const MAGICMINT_TOKEN_CREATED_TOPIC = "0xc12630d761ddbf18b9530f31d91e67493535a2b635711bcff59fded8bf381cce";
export const CODELESS_TOKEN_CREATED_TOPIC = "0x2db5c3f1f5d5fd6c4e44a6ca5cee944d0c34e172ab401efd084d22b06f50a6af";
export const XFOUR_TOKEN_CREATED_TOPIC = "0xc9cdba3b3e60120c465c26d69d9fbf513a0fefa1cc6a214daa53120a2f983bd3";
export const BULLSHOT_CREATED_TOPIC = id("Created(address,address,address,address)");
export const EAGLE_TOKEN_CREATED_TOPIC = id("TokenCreated(address,address,address,string,string,uint256,uint256,string,string,string,string,string)");
export const EAGLE_LAUNCHPAD_TOKEN_DEPLOYED_TOPIC = id("LaunchpadTokenDeployed(address,address,uint8,string,string)");
export const BNBS_STANDARD_TOKEN_CREATED_TOPIC = id("TokenCreated(address,string,string,string,string,string,address,uint256)");
export const BNBS_TAX_TOKEN_CREATED_TOPIC = id("TokenCreated(address,string,string,string,string,string,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address)");
export const BFUN_NEW_TOKEN_TOPIC = id("NewBFunToken(address,address,address,bytes,address,address,uint256,string,string,string,string)");
export const SINGULARRY_SYSTEM_DEPLOYED_TOPIC = id("BondingCurveSystemDeployed(address,address,address,string,string)");
export const ONEVONE_TOURNAMENT_CREATED_TOPIC = id("TournamentCreated(uint256,uint256,uint256,uint256,uint256)");
export const SINGULARRY_CURVE_FINALIZED_TOPIC = id("CurveFinalized(address,uint256)");
export const BSC_UPGRADED_TOPIC = id("Upgraded(address)");
export const BSC_IMPLEMENTATION_UPDATED_TOPIC = id("ImplementationUpdated(address)");
export const BSC_TOKEN_IMPLEMENTATION_UPDATED_TOPIC = id("TokenImplementationUpdated(address,address)");
export const CODELESS_IMPLEMENTATION_UPDATED_TOPIC = id("ImplementationUpdated(uint8,address)");

export const FLAP_COMPONENTS = new Map([
  // Official BNB mainnet inventory from docs.flap.sh. These addresses are
  // intentionally exact: the previous look-alike values never matched the
  // implementations observed on chain, leaving every Flap mode unlabelled.
  ["0x8b4329947e34b6d56d71a3385cac122bade7d78d", { role: "token_implementation", mode: "Standard Token" }],
  ["0x29e6383f0ce68507b5a72a53c2b118a118332aa8", { role: "token_implementation", mode: "Tax Token V1" }],
  ["0xae562c6a05b798499507c6276c6ed796027807ba", { role: "token_implementation", mode: "Tax Token V2" }],
  ["0x024f18294970b5c76c0691b87f138a0317156422", { role: "token_implementation", mode: "Tax Token V3" }],
  ["0x88881b6f03090462a969ec7f48385744eeb63333", { role: "token_implementation", mode: "Standard Token V3" }],
  ["0xcf4ee25035cf883895110f367f5ba8172416a7f9", { role: "trigger_service", mode: "Trigger Service" }],
  ["0xaee3a7ca6fe6b53f6c32a3e8407ec5a9df8b7e39", { role: "ai_oracle", mode: "AI Oracle" }],
  ["0x6255fbd731272a517022e99f6cacf6a5de9414ee", { role: "candy_box", mode: "Candy Box" }],
  ["0x53841c73217735f37bc1775538b03b23fefd8346", { role: "tax_helper", mode: "Tax Token Helper" }],
]);

export const FLAP_OFFICIAL_VAULT_FACTORIES = new Map([
  ["0xfab75dc774cb9b38b91749b8833360b46a52345f", "Split Vault"],
  ["0x025549f52b03cf36f9e1a337c02d3aa7af66ab32", "Gift Vault (FlapXVault)"],
]);

const FLAP_SELECTOR_NAMES = new Map([
  ["0x0ba6324e", "newTokenV2"],
  ["0x2e2fdbd9", "newTokenV5"],
  ["0x8cb5772c", "newTokenV6"],
  ["0x87ef5b30", "newTokenV7"],
]);

export const BSC_POOL_TOPICS = [
  BSC_PAIR_CREATED_TOPIC,
  BSC_V3_POOL_CREATED_TOPIC,
  PANCAKE_INFINITY_CL_INITIALIZE_TOPIC,
  PANCAKE_INFINITY_BIN_INITIALIZE_TOPIC,
  UNISWAP_V4_INITIALIZE_TOPIC,
];

export const BSC_LAUNCH_TOPICS = [
  FLAP_TOKEN_CREATED_TOPIC,
  FLAP_VAULT_TOKEN_CREATED_TOPIC,
  FOUR_MEME_TOKEN_CREATE_TOPIC,
  FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC,
  OPENFOUR_TOKEN_CREATED_TOPIC,
  GRAFUN_TOKEN_SALE_CREATED_TOPIC,
  HODL_BONDING_TOKEN_LAUNCHED_TOPIC,
  HODL_V2_TOKEN_LAUNCHED_TOPIC,
  HODL_V3_TOKEN_LAUNCHED_TOPIC,
  MOONSALE_PRESALE_CREATED_TOPIC,
  MOONSALE_FAIR_LAUNCH_CREATED_TOPIC,
  MOONSALE_TOKEN_CREATED_TOPIC,
  MOONSALE_LIQUIDITY_TOKEN_CREATED_TOPIC,
  HUKS_TOKEN_CREATED_TOPIC,
  AGENT_LAUNCH_TOKEN_CREATED_TOPIC,
  KARMAFI_MARKET_CREATED_TOPIC,
  RUG_CREATED_TOPIC,
  RUG_LAUNCH_SUCCEEDED_TOPIC,
  CREATE_TOKEN_CREATED_TOPIC,
  POO_MEME_PRESALE_CREATED_TOPIC,
  BNBPUMP_TOKEN_CREATED_TOPIC,
  MAGICMINT_TOKEN_CREATED_TOPIC,
  CODELESS_TOKEN_CREATED_TOPIC,
  XFOUR_TOKEN_CREATED_TOPIC,
  BULLSHOT_CREATED_TOPIC,
  EAGLE_TOKEN_CREATED_TOPIC,
  EAGLE_LAUNCHPAD_TOKEN_DEPLOYED_TOPIC,
  BNBS_STANDARD_TOKEN_CREATED_TOPIC,
  BNBS_TAX_TOKEN_CREATED_TOPIC,
  BFUN_NEW_TOKEN_TOPIC,
  SINGULARRY_SYSTEM_DEPLOYED_TOPIC,
];

export const BSC_UPGRADE_TOPICS = [BSC_UPGRADED_TOPIC, BSC_IMPLEMENTATION_UPDATED_TOPIC, BSC_TOKEN_IMPLEMENTATION_UPDATED_TOPIC, CODELESS_IMPLEMENTATION_UPDATED_TOPIC];
export const BSC_PLATFORM_LIFECYCLE_TOPICS = [ONEVONE_TOURNAMENT_CREATED_TOPIC, SINGULARRY_CURVE_FINALIZED_TOPIC];
export const BSC_TRIGGER_TOPICS = [...BSC_POOL_TOPICS, ...BSC_LAUNCH_TOPICS, ...BSC_UPGRADE_TOPICS, ...BSC_PLATFORM_LIFECYCLE_TOPICS];
const BSC_FOCUS3_LAUNCH_TOPICS = [
  FLAP_TOKEN_CREATED_TOPIC,
  FLAP_VAULT_TOKEN_CREATED_TOPIC,
  FOUR_MEME_TOKEN_CREATE_TOPIC,
  FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC,
  OPENFOUR_TOKEN_CREATED_TOPIC,
];
// In focus3, global DEX pool topics are both noisy and unnecessary: Flap and
// Four.Meme emit exact creation events, while their quote/pool capabilities
// are independently tracked from the official Board/config sources. Keeping
// this filter at nine topics also stays within the public BlockRazor fallback
// limit, so a transient BlastAPI failure cannot force slow per-block recovery.
const BSC_FOCUS3_TRIGGER_TOPICS = [...BSC_FOCUS3_LAUNCH_TOPICS, ...BSC_UPGRADE_TOPICS];
const BSC_REALTIME_QUEUE_REASONS = new Set(["zero_mint", "known_launch", "official_upgrade", "official_lifecycle", "pool_created", "http_tail", "near_head_gap_recovery"]);
const BSC_UNSCOPED_LOG_MAX_BLOCKS = 10;
const BSC_REALTIME_PENDING_MAX_ENTRIES = 25_000;
const BSC_REALTIME_OLDEST_RESERVE = 2;
const BSC_NEAR_HEAD_ATTEMPTS_PER_HISTORICAL_BATCH = 5;
const BSC_DEEP_RPC_PRIORITY_LAG_BLOCKS = 20;
const BSC_DEEP_RPC_HEALTHY_TAIL_BATCHES = 2;
// Production observed at least 0.473 durable candidates/second before any
// successful removals were counted. A two-second cadence therefore cannot
// drain even a healthy queue. Keep one expensive transaction proof in flight,
// but admit the next one after 750ms when the live tail is continuously
// healthy. Slow RPCs naturally reduce this rate because the lease is serial.
const BSC_DEEP_RPC_PACE_MS = 750;
const BSC_DEEP_RPC_OLD_WITH_GAPS_PACE_MS = 30_000;
const BSC_DEEP_RPC_FRESH_WINDOW_MS = 15 * 60_000;
const BSC_DEEP_RPC_BLOCKING_TAIL_STATUSES = new Set([
  "error",
  "degraded",
  "critical",
  "rebuilding",
]);
const BSC_CAUSAL_BARRIER_KEYS_MAX = 64;

function isBscDurableHandoffCapacityError(error) {
  return error?.code === "BSC_REALTIME_PENDING_CAPACITY";
}

function normalizeBscCausalBarrierKeys(values = []) {
  if (!Array.isArray(values)) return [];
  const normalized = [...new Set(values
    .map((value) => String(value || ""))
    .filter((value) => /^(?:feature|first3):[^\s]{1,480}$/.test(value)))]
    .sort();
  if (normalized.length > BSC_CAUSAL_BARRIER_KEYS_MAX) {
    const error = new Error(`BSC causal barrier capacity ${normalized.length}>${BSC_CAUSAL_BARRIER_KEYS_MAX}`);
    error.code = "BSC_CAUSAL_BARRIER_CAPACITY";
    throw error;
  }
  return normalized;
}

function readBscCausalBarrierKeys(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} causalBarrierKeys must be an array`);
  const normalized = normalizeBscCausalBarrierKeys(value);
  if (normalized.length !== value.length
    || JSON.stringify(normalized) !== JSON.stringify(value)) {
    throw new Error(`${label} causalBarrierKeys are not canonical`);
  }
  return normalized;
}

function bscQueuePosition(value) {
  let numeric;
  try { numeric = typeof value === "bigint" ? Number(value) : Number(value); }
  catch { return Number.MAX_SAFE_INTEGER; }
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : Number.MAX_SAFE_INTEGER;
}

function compareBscQueueEntries(left, right) {
  return Number(left.blockNumber) - Number(right.blockNumber)
    || bscQueuePosition(left.transactionIndex) - bscQueuePosition(right.transactionIndex)
    || bscQueuePosition(left.logIndex) - bscQueuePosition(right.logIndex)
    || String(left.transactionHash || "").localeCompare(String(right.transactionHash || ""));
}

export function selectBscRealtimeEntries(entries, confirmedBlock, seenTransactions = {}, limit = 12, nearHeadWindowBlocks = 64) {
  const candidates = entries.filter((entry) => Number(entry.blockNumber) <= confirmedBlock && !seenTransactions[entry.transactionHash]);
  const realtime = candidates.filter(isBscRealtimeQueueEntry);
  const nearHeadFrom = Math.max(0, Number(confirmedBlock) - Math.max(1, Number(nearHeadWindowBlocks) || 1) + 1);
  const nearHead = realtime.filter((entry) => Number(entry.blockNumber) >= nearHeadFrom).sort(compareBscQueueEntries);
  const nearHeadHashes = new Set(nearHead.map((entry) => entry.transactionHash));
  const older = [
    ...realtime.filter((entry) => !nearHeadHashes.has(entry.transactionHash)),
    ...candidates.filter((entry) => !isBscRealtimeQueueEntry(entry)),
  ].sort(compareBscQueueEntries);
  const boundedLimit = Math.max(0, Number(limit) || 0);
  if (nearHead.length + older.length <= boundedLimit || nearHead.length === 0 || older.length === 0 || boundedLimit <= 1) {
    return [...nearHead, ...older].slice(0, boundedLimit);
  }
  // Reserve a small, fixed share for the oldest durable work. Fresh launches
  // still own most capacity, while an endless near-head stream can no longer
  // keep yesterday's exact candidate at the head of the queue forever.
  const oldestReserve = Math.min(BSC_REALTIME_OLDEST_RESERVE, boundedLimit - 1, older.length);
  const freshLimit = boundedLimit - oldestReserve;
  // A historical ordinary-token backlog must not delay a just-confirmed mode
  // candidate. Preserve chain order inside both shares, then spend any unused
  // fresh capacity on additional oldest durable work.
  return [
    ...nearHead.slice(0, freshLimit),
    ...older.slice(0, oldestReserve),
    ...older.slice(oldestReserve),
  ].slice(0, boundedLimit);
}

function isBscRealtimeQueueEntry(entry) {
  return [...(entry?.reasons || [])].some((reason) => BSC_REALTIME_QUEUE_REASONS.has(reason));
}

export function bscRealtimeProcessLimit(entries, confirmedBlock, seenTransactions = {}, {
  nearHeadWindowBlocks = 64,
  normalLimit = 12,
  backlogLimit = 2,
} = {}) {
  const nearHeadFrom = Math.max(0, Number(confirmedBlock) - Math.max(1, Number(nearHeadWindowBlocks) || 1) + 1);
  const hasNearHeadWork = entries.some((entry) => Number(entry.blockNumber) <= confirmedBlock
    && Number(entry.blockNumber) >= nearHeadFrom
    && !seenTransactions[entry.transactionHash]
    && isBscRealtimeQueueEntry(entry));
  return hasNearHeadWork
    ? Math.max(1, Number(normalLimit) || 1)
    : Math.max(1, Math.min(Number(normalLimit) || 1, Number(backlogLimit) || 1));
}

export function bscDeepRpcPriority({
  realtimeTailRunning = false,
  realtimeTailNextBlock,
  confirmedBlock,
  realtimeTailStatus = null,
  realtimeTailBackpressure = null,
  consecutiveHealthyTailBatches = 0,
  nearHeadGapCount = 0,
} = {}) {
  const nextBlock = Number(realtimeTailNextBlock);
  const confirmed = Number(confirmedBlock);
  const validCursor = Number.isSafeInteger(nextBlock) && nextBlock >= 0;
  const validConfirmed = Number.isSafeInteger(confirmed) && confirmed >= 0;
  const tailLagBlocks = validCursor && validConfirmed
    ? Math.max(0, confirmed - Math.max(0, nextBlock - 1))
    : Number.POSITIVE_INFINITY;
  const blockingStatus = BSC_DEEP_RPC_BLOCKING_TAIL_STATUSES.has(String(realtimeTailStatus || "").toLowerCase());
  const capacityBackpressure = realtimeTailBackpressure === "realtime_pending_capacity";
  const reportedHealthy = String(realtimeTailStatus || "").toLowerCase() === "healthy";
  const tailPriority = Boolean(realtimeTailRunning)
    || !validCursor
    || !validConfirmed
    || tailLagBlocks > BSC_DEEP_RPC_PRIORITY_LAG_BLOCKS
    || blockingStatus;
  const tailReady = !tailPriority
    && reportedHealthy
    && Number(consecutiveHealthyTailBatches || 0) >= BSC_DEEP_RPC_HEALTHY_TAIL_BATCHES;
  const capacityDrainReady = capacityBackpressure
    && !realtimeTailRunning
    && validCursor
    && validConfirmed;
  const gapFree = Number(nearHeadGapCount || 0) === 0;
  return {
    tailLagBlocks,
    tailPriority,
    tailReady,
    capacityBackpressure,
    capacityDrainReady,
    nearHeadGapCount: Math.max(0, Number(nearHeadGapCount) || 0),
    allowFreshQueue: tailReady || capacityDrainReady,
    allowOldQueue: tailReady || capacityDrainReady,
    allowFreshDeferred: tailReady,
    allowOldDeferred: tailReady,
    deepIntervalMs: BSC_DEEP_RPC_PACE_MS,
    oldDeepIntervalMs: gapFree || capacityDrainReady
      ? BSC_DEEP_RPC_PACE_MS
      : BSC_DEEP_RPC_OLD_WITH_GAPS_PACE_MS,
  };
}

export function shouldYieldBscNearHeadRecovery({
  realtimeTailRunning = false,
  realtimeTailNextBlock,
  confirmedBlock,
  permittedLagBlocks = 0,
} = {}) {
  if (realtimeTailRunning) return true;
  if (realtimeTailNextBlock === null || realtimeTailNextBlock === undefined) return true;
  const nextBlock = Number(realtimeTailNextBlock);
  const confirmed = Number(confirmedBlock);
  if (!Number.isSafeInteger(nextBlock) || nextBlock < 0
    || !Number.isSafeInteger(confirmed) || confirmed < 0) return true;
  const lagBlocks = Math.max(0, confirmed - Math.max(0, nextBlock - 1));
  return lagBlocks > Math.max(0, Number(permittedLagBlocks) || 0);
}

export function bscNearHeadRecoveryPermittedLagBlocks({
  realtimeTailBatchSize = 10,
  realtimeTailMaxLagBlocks = 128,
  expectedBlockTimeMs = 450,
} = {}) {
  const batchSize = Math.max(1, Number(realtimeTailBatchSize) || 1);
  const maxLag = Math.max(batchSize, Number(realtimeTailMaxLagBlocks) || batchSize);
  const blockTime = Math.max(1, Number(expectedBlockTimeMs) || 1);
  const safeLagCeiling = Math.max(batchSize, maxLag - (2 * batchSize));
  // Public BSC log endpoints can take 3-4 seconds for a bounded 10-block
  // request. A 20-second window is therefore too narrow in production: the
  // isolated realtime tail can advance successfully while hovering 30-40
  // seconds behind the sub-second chain, permanently starving gap repair.
  // Keep a 45-second live window and two complete tail batches of headroom
  // below the stale-tail handoff threshold. Repair gets bounded work without
  // turning one slow response into another cursor rebuild and a larger gap.
  return Math.min(safeLagCeiling, Math.max(batchSize, Math.ceil(45_000 / blockTime)));
}

export function compactFocus3LiveCoverageState(targetState, {
  maxHistoricalLagBlocks = 50_000,
  replayLookbackBlocks = 2_400,
  current = Date.now(),
} = {}) {
  const tailNext = Number(targetState?.realtimeTailNextBlock);
  const historicalCovered = Number(targetState?.lastFinalizedBlock || 0);
  const tailCovered = tailNext - 1;
  if (!Number.isSafeInteger(tailNext)
    || tailNext <= 0
    || !Number.isSafeInteger(historicalCovered)
    || tailCovered - historicalCovered <= Math.max(1, Number(maxHistoricalLagBlocks) || 1)) {
    return { changed: false, droppedGapCount: 0, retainedGapCount: (targetState?.nearHeadRecoveryGaps || []).length };
  }
  const retainFromBlock = Math.max(0, tailCovered - Math.max(1, Number(replayLookbackBlocks) || 1) + 1);
  const previousGaps = Array.isArray(targetState.nearHeadRecoveryGaps) ? targetState.nearHeadRecoveryGaps : [];
  // This used to advance lastFinalizedBlock to the live tail and discard old
  // gaps. That made the health cursor claim continuous coverage over blocks
  // that had never been read. Keep this exported compatibility hook, but make
  // it lossless: live ingestion is already bounded by the tail cursor and the
  // historical cursor must move only after exact recovery succeeds.
  const refusal = {
    scheduledAt: new Date(current).toISOString(),
    reason: "focus3_live_compaction_refused_uncovered",
    previousLastFinalizedBlock: historicalCovered,
    realtimeTailCoveredBlock: tailCovered,
    replayLookbackFromBlock: retainFromBlock,
    droppedGapCount: 0,
    retainedGapCount: previousGaps.length,
  };
  const priorHistory = targetState.coverageRecoveryHistory || [];
  const previousRefusal = priorHistory.at(-1);
  if (previousRefusal?.reason !== refusal.reason
    || previousRefusal.previousLastFinalizedBlock !== refusal.previousLastFinalizedBlock
    || previousRefusal.realtimeTailCoveredBlock !== refusal.realtimeTailCoveredBlock
    || previousRefusal.retainedGapCount !== refusal.retainedGapCount) {
    targetState.coverageRecoveryHistory = [...priorHistory, refusal].slice(-20);
  }
  return {
    changed: false,
    refusedLossyCompaction: true,
    droppedGapCount: 0,
    retainedGapCount: previousGaps.length,
    previousLastFinalizedBlock: historicalCovered,
    tailCovered,
    retainFromBlock,
  };
}

const BSC_EXACT_TOKEN_CREATION_TOPICS = new Set([
  FLAP_TOKEN_CREATED_TOPIC,
  FLAP_VAULT_TOKEN_CREATED_TOPIC,
  FOUR_MEME_TOKEN_CREATE_TOPIC,
  FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC,
  OPENFOUR_TOKEN_CREATED_TOPIC,
  MOONSALE_TOKEN_CREATED_TOPIC,
  MOONSALE_LIQUIDITY_TOKEN_CREATED_TOPIC,
  HUKS_TOKEN_CREATED_TOPIC,
  AGENT_LAUNCH_TOKEN_CREATED_TOPIC,
  CREATE_TOKEN_CREATED_TOPIC,
  BNBPUMP_TOKEN_CREATED_TOPIC,
  MAGICMINT_TOKEN_CREATED_TOPIC,
  CODELESS_TOKEN_CREATED_TOPIC,
  BULLSHOT_CREATED_TOPIC,
  EAGLE_TOKEN_CREATED_TOPIC,
  EAGLE_LAUNCHPAD_TOKEN_DEPLOYED_TOPIC,
  BNBS_STANDARD_TOKEN_CREATED_TOPIC,
  BNBS_TAX_TOKEN_CREATED_TOPIC,
  BFUN_NEW_TOKEN_TOPIC,
  SINGULARRY_SYSTEM_DEPLOYED_TOPIC,
]);

export const BSC_DEX_CONTRACTS = new Map([
  ["0xca143ce32fe78f1f7019d7d551a6402fc5350c73", { name: "PancakeSwap V2", kind: "v2" }],
  ["0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865", { name: "PancakeSwap V3", kind: "v3" }],
  ["0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b", { name: "Pancake Infinity CL", kind: "infinity-cl" }],
  ["0xc697d2898e0d09264376196696c51d7abbbaa4a9", { name: "Pancake Infinity Bin", kind: "infinity-bin" }],
  ["0x8909dc15e40173ff4699343b6eb8132c65e18ec6", { name: "Uniswap V2", kind: "v2" }],
  ["0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7", { name: "Uniswap V3", kind: "v3" }],
  ["0x28e2ea090877bf75740558f6bfb36a5ffee9e9df", { name: "Uniswap V4", kind: "uniswap-v4" }],
]);

export const BSC_LAUNCHPAD_CATALOG = [
  {
    id: "flap",
    name: "Flap",
    launchers: ["0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0", "0x90497450f2a706f1951b5bdda52b4e5d16f34c06"],
    trust: "official_verified",
    website: "https://flap.sh",
    twitter: "https://x.com/flapdotsh",
    evidenceUrl: "https://docs.flap.sh/flap/developers/deployed-contract-addresses",
  },
  {
    id: "fourmeme",
    name: "Four.Meme",
    launchers: [
      "0xec4549cadce5da21df6e6422d448034b5233bfbc",
      "0x5c952063c7fc8610ffdb798152d69f0b9550762b",
      "0x87fd30d61a8dce9150e173be9bf53e7f1c55dff8",
      "0x681cf37be53aa3493a49bc4d466f81baff7d3966",
      "0x02226545f89d78c1afc936a7147180f061f69325",
      "0x704352c86b10247f361ccb7a1c95841c35753a17",
    ],
    trust: "official_verified",
    website: "https://four.meme",
    twitter: "https://x.com/fourdotmemezh",
    evidenceUrl: "https://four.meme/meme-api/v1/public/address",
  },
  {
    id: "dxsale",
    name: "DxSale",
    launchers: [
      "0xaffc920023b4e05c12d420105bb171c849aa0573",
      "0xa66bec91df02075b8c790d7c6c4bfcdef5ed2bc3",
      "0x23f3a057f4039f77df7a4f711a3409aee955de53",
      "0xc45d702da12c34c2c90710b28572afbf5df924ef",
    ],
    trust: "official_verified",
    website: "https://dx.app",
    twitter: null,
    evidenceUrl: "https://dx.app",
  },
  {
    id: "tokenfi",
    name: "TokenFi Launchpad",
    launchers: ["0xb8d8701589ce9cecbcedc8dbdadff30e987ee0e8"],
    trust: "official_verified",
    website: "https://lp.tokenfi.com",
    twitter: null,
    evidenceUrl: "https://tokenfi.gitbook.io/whitepaper/list-of-tokenfi-products/tokenfi-launchpad",
  },
  {
    id: "openfour",
    name: "OpenFour",
    launchers: ["0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3"],
    trust: "official_verified",
    website: "https://four.meme",
    twitter: "https://x.com/fourdotmemezh",
    evidenceUrl: "https://four.meme/meme-api/v1/public/address",
  },
  {
    id: "grafun",
    name: "GraFun",
    launchers: ["0x8341b19a2a602eae0f22633b6da12e1b016e6451"],
    trust: "official_verified",
    website: "https://gra.fun",
    twitter: "https://x.com/grafunlabs",
    evidenceUrl: "https://gra.fun",
  },
  {
    id: "bullshot",
    name: "Bullshot",
    launchers: [
      "0xcdba6243e733f7d7cdcbc0b4b10f703a11f7432d", // 24 BNB Classic
      "0x8cee21c45c2fec7bdf3181faafa4cc857421202b", // 16 BNB Bond
      "0x18b0d0c5aad9fa205198f6eaf58123d3fbfa0f9c", // 12 BNB Bond
      "0x8d9d3e29876787fd2441b3f8470bb6350eebb6bf", // 8 BNB Bond
      "0xada338ab1f3077c20934daf2317c03a8c56ddf8a", // 4 BNB Bond
    ],
    trust: "official_verified",
    website: "https://bullshot.io",
    twitter: "https://x.com/Bullshot911",
    github: null,
    evidenceUrl: "https://docs.bullshot.io/?page=contracts",
  },
  {
    id: "eaglefun",
    name: "Eagle FUN / Eagle Launch",
    notifyFirstToken: true,
    notifyFirstInfrastructureActivation: true,
    launchers: [
      "0x09c3febd30cb7be4f97924846c24f80604650947", // Inner Market TokenFactory
      "0x56ec1c3c9fd70099aea154c93a2d201e1fa0b589", // LaunchpadTokenFactory
      "0xf37ecf5eef7f7284e311a59dc11fc58380d105fb", // PresaleFactory
      "0x759f270231474abcdf1f7f303021248c31d2f32f", // FairlaunchFactory
    ],
    trust: "official_verified",
    website: "https://eagleworld.fun",
    twitter: "https://x.com/EagleSwapHQ",
    github: null,
    evidenceUrl: "https://eagleworld.fun/docs",
  },
  {
    id: "bnbs",
    name: "BNBS Launchpad",
    launchers: ["0x99433911060ce29ba2272d3664854983bba3e258"],
    trust: "official_verified",
    website: "https://bnbs.meme",
    twitter: null,
    github: "https://github.com/zhangjichao1717/bnbs-meme-token-template",
    evidenceUrl: "https://bnbs.meme",
    trackAssets: true,
  },
  {
    id: "bnbs-tax",
    name: "BNBS Launchpad · 税费/分红模式",
    notifyFirstToken: true,
    notifyFirstInfrastructureActivation: true,
    launchers: ["0xa7fadbd1e27a898f1f719adf7e52206aa413d2aa"],
    trust: "official_verified",
    website: "https://bnbs.meme",
    twitter: null,
    github: "https://github.com/zhangjichao1717/bnbs-meme-token-template",
    evidenceUrl: "https://bnbs.meme",
    trackAssets: true,
    siteMonitor: false,
  },
  {
    id: "bfun",
    name: "B.Fun",
    launchers: ["0x718fa87734cc6fce3e7374663a0dafa334aa4876"],
    trust: "official_verified",
    website: "https://b.fun",
    twitter: "https://x.com/BdotFun",
    github: "https://github.com/bfun-ai/bfun-ai",
    evidenceUrl: "https://docs.b.fun/for-developers/contracts-and-abi",
  },
  {
    id: "singularry",
    name: "Singularry Launchpad",
    notifyFirstToken: true,
    launchers: ["0x1b1bd5e6ba84c8354c671ece0a45c9dfbeb7b4ec"],
    trust: "official_verified",
    website: "https://launch.singularry.org",
    twitter: "https://x.com/singularryai",
    github: null,
    evidenceUrl: "https://docs.singularry.org/launchpad/overview",
  },
  {
    id: "onevone",
    name: "1V1MEME",
    launchers: ["0x5b3ba297a60685844fe673c134651d7dcf1a74b6"],
    trust: "multi_source_corroborated",
    website: "https://1v1me.me",
    twitter: "https://x.com/1v1meme",
    github: "https://github.com/1v1me-me/foundry",
    evidenceUrl: "https://github.com/1v1me-me/foundry#contract-addresses",
  },
  {
    id: "unnamed-usdt-curve-prototype",
    name: "未命名 USDT 曲线发射台原型",
    notifyFirstToken: true,
    launchers: ["0xf77da2cf754234f17c0c0252052daa5af1f32cb4"],
    trust: "chain_verified_prelaunch",
    website: null,
    twitter: null,
    github: null,
    evidenceUrl: "https://sourcify.dev/server/v2/contract/56/0x4e6fa05c5004cf1508347c11596df105b334b627?fields=all",
  },
  {
    id: "hodldance",
    name: "HODL.DANCE",
    notifyFirstToken: true,
    launchers: [
      "0x99a1f02f56e8356e6e90a880dbb1be6ec7485737",
      "0xe78676da7de99964f0e482e646c3a4d1aa39b9e4",
      "0x1d317be2b6e56923337879f393526014861111bc",
    ],
    trust: "official_verified",
    website: "https://hodl.dance",
    twitter: "https://x.com/hodl4meme",
    github: "https://github.com/hodldance/hodl-dance",
    evidenceUrl: "https://docs.hodl.dance/contracts/contract-addresses",
  },
  {
    id: "moonsale",
    name: "MoonSale",
    launchers: [
      "0xd307ee5bf4c505613be6e4af90b6a2bce7d9ccf1",
      "0xe70e643b0ecf01d2d46d35fc73f364cf75d64c5e",
      "0x8d1490006de561c4380e3066a6a1210bc37a205d",
    ],
    trust: "official_verified",
    website: "https://www.moonsale.app",
    twitter: null,
    github: "https://github.com/moonsaleapp/moonsaleapp",
    evidenceUrl: "https://github.com/moonsaleapp/moonsaleapp#deployed-contracts",
  },
  {
    id: "huksfun",
    name: "Huks.fun",
    notifyFirstToken: true,
    launchers: ["0xe658e21bf84be80778d746f0a9c3adaac3ca43a3"],
    trust: "official_verified",
    website: "https://huks.fun",
    twitter: "https://x.com/huksdotfun",
    github: "https://github.com/huksdotfun/bsc-contracts",
    evidenceUrl: "https://github.com/huksdotfun/bsc-contracts",
  },
  {
    id: "agentlaunch",
    name: "Agent Launch",
    notifyFirstToken: true,
    launchers: ["0xc399343771baeac2663b15b1a76c6f53119dc28b"],
    trust: "official_verified",
    website: "https://agent-launch.ai",
    twitter: null,
    github: "https://github.com/fetchai/agent-launch-toolkit",
    evidenceUrl: "https://agent-launch.ai/api/deployer-address",
  },
  {
    id: "flazepad",
    name: "Flazepad",
    notifyFirstToken: true,
    launchers: ["0xd6ecd870fce7bc8b3286f43f709f4339e9f93dfb"],
    trust: "official_verified",
    website: "https://flazepad.xyz",
    twitter: "https://x.com/flazepad",
    github: "https://github.com/Flazepad-xyz/Flazepad-Core",
    evidenceUrl: "https://github.com/Flazepad-xyz/Flazepad-Core",
  },
  {
    id: "karmafi",
    name: "KarmaFi",
    notifyFirstToken: true,
    launchers: ["0x33bca7b97d52d0ff4ad6e4b4551ea0bc29e21bf5"],
    trust: "official_verified",
    website: "https://karmafi.app",
    twitter: "https://x.com/KarmafiBNB",
    github: "https://github.com/karmafionbnb/karmafi",
    evidenceUrl: "https://github.com/karmafionbnb/karmafi/blob/main/SECURITY-REVIEW.md#contracts-reviewed",
  },
  {
    id: "rugspull",
    name: "Rugspull",
    notifyFirstToken: true,
    launchers: ["0xdff540babca2ee8a2a8ff26359ecc9c5921d8a63"],
    trust: "official_verified",
    website: "https://rugspull.com",
    twitter: "https://x.com/rugspull",
    github: "https://github.com/pqchase/rugspull",
    evidenceUrl: "https://rugspull.com/api/config",
  },
  {
    id: "createtoken",
    name: "Create Token",
    launchers: ["0xaa67ba6ff5f846fb73099b5af10292940df68f99"],
    trust: "official_verified",
    website: "https://createtoken.co/app/",
    twitter: "https://x.com/createtokenco",
    github: "https://github.com/createtokenco/bep20standardtoken",
    evidenceUrl: "https://github.com/createtokenco/bep20standardtoken",
  },
  {
    id: "poomeme",
    name: "POO.MEME",
    notifyFirstToken: true,
    launchers: ["0x3f5dcbec068888794f1f2a4b5addf698a7e4b65a"],
    trust: "official_verified",
    website: "https://poo.meme",
    twitter: "https://x.com/PooDotMeme",
    github: null,
    evidenceUrl: "https://poo.meme",
  },
  {
    id: "bnbpump",
    name: "BNBpump",
    notifyFirstToken: true,
    launchers: ["0x5a8a576f7e3d49a572143a13113807ddab8de3ec"],
    trust: "official_verified",
    website: "https://bnbpump.fun",
    twitter: "https://x.com/bnbpumpfun",
    github: null,
    evidenceUrl: "https://bnbpump.fun",
  },
  {
    id: "magicmint",
    name: "MagicMint",
    notifyFirstToken: true,
    launchers: ["0xccb8f444b2e3a0dfd1f5f91aaed75c114f6b8514"],
    trust: "official_verified",
    website: "https://magicmint.app",
    twitter: "https://x.com/MagicMintApp",
    github: "https://github.com/Onchain365/magic-mint-contracts",
    evidenceUrl: "https://github.com/Onchain365/magic-mint-contracts",
  },
  {
    id: "codelessdev",
    name: "CodelessDev",
    notifyFirstToken: true,
    launchers: ["0xf7ab5a0c3e0e00525746de2152e6d68c3076b57a"],
    trust: "official_verified",
    website: "https://codelessdev.org",
    twitter: "https://x.com/Token1000PDF",
    github: "https://github.com/Codeless-Dev/Codelessdev-contracts",
    evidenceUrl: "https://github.com/Codeless-Dev/Codelessdev-contracts",
  },
  {
    id: "xfour",
    name: "XFOUR",
    launchers: ["0xc15b28d1c71ba8f69a8b5eb10e2d26846eb3470c"],
    trust: "official_runtime_candidate",
    website: "https://xfour.fun",
    twitter: "https://x.com/xfourbnb",
    github: "https://github.com/xbsc-402/402bnb-contract",
    evidenceUrl: "https://xfour.fun",
  },
  {
    id: "bltx",
    name: "BLTX.FUN",
    notifyFirstToken: true,
    launchers: [],
    trust: "official_docs_only",
    website: "https://bltx.fun",
    twitter: "https://x.com/Bltxdotfun",
    github: null,
    evidenceUrl: "https://bltx.fun/docs",
  },
  {
    id: "fabi",
    name: "Fabi 发币",
    notifyFirstToken: true,
    launchers: [],
    trust: "official_docs_only",
    website: "https://www.fabibsc.com",
    twitter: "https://x.com/FabiBsc",
    github: null,
    evidenceUrl: "https://www.fabibsc.com",
  },
  {
    id: "flypad",
    name: "FlyPad",
    launchers: [],
    trust: "official_docs_only",
    website: "https://docs.flypad.app",
    twitter: "https://x.com/flypad_app",
    github: null,
    evidenceUrl: "https://docs.flypad.app/additional-resources/faq",
  },
];

const BSC_OFFICIAL_COMPONENTS = new Map([
  ...[...FLAP_COMPONENTS].map(([address, component]) => [address, { platformId: "flap", ...component }]),
  ["0xc51b3054c0a6950238071dbaa64f9a52121fcf37", { platformId: "flazepad", role: "token_beacon", mode: "Token Beacon" }],
  ["0xf0240327ea8d9c7eed2edc9c77918c0e1b92013c", { platformId: "flazepad", role: "curve_beacon", mode: "Curve Beacon" }],
  ["0xeb9bcaa5ac0b9c890862a00a0d482b1fcf15cec1", { platformId: "onevone", role: "contract_beacon", mode: "Contract Beacon" }],
  ["0x2235519578c9effbe52c824fe6fce428bd5ac1d3", { platformId: "onevone", role: "match_engine", mode: "Match Engine" }],
  ["0x22ca8bc2c6ddc31fe76da6a0d587a9c41ebc849c", { platformId: "onevone", role: "fighter_vault", mode: "Fighter Vault" }],
  ["0x164319437119132bbf8b3bee180c669ad450e817", { platformId: "bfun", role: "trade_helper_proxy", mode: "Factory Trade Helper" }],
  ["0x68c082cc36ee2166cf2dd7d82f8acff36331fd54", { platformId: "bfun", role: "vault_factory", mode: "SnowBall Vault" }],
  ["0xd4cde006422348d1c62db86ade854feca4ea77d2", { platformId: "bfun", role: "vault_factory", mode: "BurnDividend Vault" }],
  ["0xa158e4f7271441a4bd2181389153ac8b2b931e16", { platformId: "bfun", role: "vault_factory", mode: "Gift Vault" }],
  ["0xb2935b344417e6240c380235262fa65e15746375", { platformId: "bfun", role: "vault_factory", mode: "Split Vault" }],
  ["0xd3967a57c9910fcc87830b17249d9f6e9d9a97c1", { platformId: "singularry", role: "curve_implementation", mode: "Bonding Curve Clone Implementation" }],
  ["0x17a22edc8c5be07088a6bcfa9b0c1a4d8d025e01", { platformId: "singularry", role: "fee_collector", mode: "Creator Fee Collector" }],
  ["0x0d2f34ff1c0c1341b2f2410c12f970f2ba698749", { platformId: "singularry", role: "graduator", mode: "Thena V3 Graduator" }],
]);
const BSC_SHARED_LAUNCH_ROOTS = new Map([
  ["0x5c952063c7fc8610ffdb798152d69f0b9550762b", {
    id: "fourmeme-springboard-shared",
    name: "Four.Meme / Pancake SpringBoard（共享 Manager）",
    trust: "official_shared",
    website: null,
    twitter: null,
    github: null,
    evidenceUrl: "https://springboard.pancakeswap.finance/bsc",
    notifyFirstToken: false,
  }],
]);

const FOUR_MEME_ADDRESS_URL = "https://four.meme/meme-api/v1/public/address";
const FOUR_MEME_TEMPLATE_URL = "https://four.meme/meme-api/v1/public/token_template/search";
const FOUR_MEME_CONFIG_URL = "https://four.meme/meme-api/v1/public/config";
const FOUR_MEME_TOKEN_URL = "https://four.meme/meme-api/v1/private/token/get/v2";
const FLAP_BOARD_URL = "https://flap.sh/board";
const FOUR_MEME_OPENFOUR_CORE = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
const FOUR_MEME_OPENFOUR_REGISTRY = "0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94";
const FOUR_MEME_PRESALE_MANAGERS = new Set([
  "0x02226545f89d78c1afc936a7147180f061f69325",
  "0x704352c86b10247f361ccb7a1c95841c35753a17",
]);
const FOUR_MEME_ACTIVATION_REPLAY_LOOKBACK_MS = 15 * 60_000;
const FOUR_MEME_ACTIVATION_AUDIT_MAX_AGE_MS = 24 * 60 * 60_000;
const FLAP_ACTIVATION_REPLAY_LOOKBACK_MS = 15 * 60_000;
// Flap's Board can confirm a new quote/Vault mode after a burst of launches
// has already pushed the actual first token out of launcher.tokens (cap 100).
// Keep exact official creation events independently, long enough for two
// Board observations, and large enough for sustained high-volume issuance.
const FLAP_CREATION_HOT_INDEX_TTL_MS = 30 * 60_000;
const FLAP_CREATION_HOT_INDEX_MAX = 6_000;
const FLAP_REPLAY_ATTEMPTED_TRANSACTIONS_MAX = 6_000;
const FLAP_QUOTE_FIRST_THREE_TARGET = 3;
const FLAP_QUOTE_FIRST_THREE_WINDOW_MAX = 2_000;
const FLAP_QUOTE_FIRST_THREE_LIFECYCLE_MAX = 4_000;
const FLAP_QUOTE_FIRST_THREE_PAIR_FACTORIES = new Set([
  "0xca143ce32fe78f1f7019d7d551a6402fc5350c73",
  "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
  "0x8909dc15e40173ff4699343b6eb8132c65e18ec6",
  "0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7",
]);
// Keep a durable near-head cache of exact Four.Meme creation events. Official
// feature APIs can lag the chain, so an activation should be able to revisit
// transactions the realtime lane already classified without first walking a
// 15-minute archive-log window. Archive replay remains the completeness lane.
const FOUR_MEME_CREATION_HOT_INDEX_TTL_MS = 30 * 60_000;
const FOUR_MEME_CREATION_HOT_INDEX_MAX = 6_000;
const BSC_TRANSACTION_CREATION_EVIDENCE_MAX = 64;
const FOUR_MEME_REPLAY_ATTEMPTED_CANDIDATES_MAX = 2_000;
// The primary public BSC archive endpoint rejects ranges wider than 10.
const FOUR_MEME_REPLAY_LOG_BATCH_BLOCKS = 10;
const FOUR_MEME_REPLAY_MAX_BLOCKS_PER_RUN = 2_400;
const FOUR_MEME_FAST_REPLAY_RPC_URL = "https://bsc-rpc.publicnode.com";
const FOUR_MEME_FAST_REPLAY_TIMEOUT_MS = 1_800;
const DEX_SCREENER_TOKEN_PAIRS_URL = "https://api.dexscreener.com/token-pairs/v1/bsc";
const SOURCIFY_CONTRACT_URL = "https://sourcify.dev/server/v2/contract/56";

const BSC_QUOTE_ASSETS = new Set([
  "0x0000000000000000000000000000000000000000",
  BSC_WBNB.toLowerCase(),
  "0x55d398326f99059ff775485246999027b3197955",
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  "0xe9e7cea3dedca5984780bafc599bd69add087d56",
  "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409",
  "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
]);

const BSC_IGNORED_MINTS = new Set(BSC_QUOTE_ASSETS);
export const BSC_EXCLUDED_CONTROLLERS = new Set([
  ...BSC_DEX_CONTRACTS.keys(),
  BSC_WBNB.toLowerCase(),
  "0x10ed43c718714eb63d5aa57b78b54704e256024e",
  "0x41ff9aa7e16b8b1a8a8dc4f0efacd93d02d071c9",
  "0x1b81d678ffb9c0263b24a97847620c99d213eb14",
  "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364",
  "0x13f4ea83d0bd40e75c8222255bc855a974568dd4",
  "0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe",
  "0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94",
  "0x7383b244b416db16aa9dd0ab7c296aa60255b9a2",
  "0x97da82f56fef1a0b974587a48135fa9da2a4e905",
  "0xc7137c4ce54a2815e14e9622029a44795e8259b8",
  "0xc18946abe1e275e4075e797dc72716caad248def",
  "0x47f4bb5e5419a4b09c23173f250b72cc88044ce0",
  // Permissionless vanity CREATE2 deployer used by one linked burner chain to
  // mass-produce near-empty Pancake pairs. It is infrastructure, not a launchpad.
  "0x9f2cd4035023fb3bb1400f7a98ab5d0a59bfbb61",
]);

const BSC_INFRA_MARKERS = Object.fromEntries([
  ["wbnb", BSC_WBNB],
  ...[...BSC_DEX_CONTRACTS].map(([address, profile]) => [profile.name.replace(/[^a-z0-9]/gi, ""), address]),
]);
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const BEACON_IMPLEMENTATION_SELECTOR = "0x5c60da1b";
const GENERIC_TOPICS = new Set([
  BSC_TRANSFER_TOPIC,
  id("Approval(address,address,uint256)"),
  id("OwnershipTransferred(address,address)"),
  id("Swap(address,uint256,uint256,uint256,uint256,address)"),
  id("Sync(uint112,uint112)"),
  id("Mint(address,uint256,uint256)"),
  id("Burn(address,uint256,uint256,address)"),
  ...BSC_POOL_TOPICS,
]);
const WARMUP_MS = 15 * 60_000;
const RUNTIME_PROFILE_TTL_MS = 10_000;
const STATE_VERSION = 7;
// v3 briefly advanced coverage while overloaded RPCs were failing. Reopen the
// whole affected interval once during the v4 migration, including pruned gaps.
const V3_RECONCILIATION_REPLAY_FLOOR = 113578304;
const ADDRESS = /^0x[a-f0-9]{40}$/;
const NON_RETRYABLE_RPC_CODES = new Set(["CALL_EXCEPTION", "INVALID_ARGUMENT", "NUMERIC_FAULT"]);
const NULL_RETRY_RPC_METHODS = new Set(["getTransaction", "getTransactionReceipt", "getBlock"]);

const v2 = new Interface(["event PairCreated(address indexed token0,address indexed token1,address pair,uint256)"]);
const v3 = new Interface(["event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)"]);
const infinityCl = new Interface(["event Initialize(bytes32 indexed poolId,address indexed currency0,address indexed currency1,address hooks,uint24 fee,bytes32 parameters,uint160 sqrtPriceX96,int24 tick)"]);
const infinityBin = new Interface(["event Initialize(bytes32 indexed poolId,address indexed currency0,address indexed currency1,address hooks,uint24 fee,bytes32 parameters,uint24 activeId)"]);
const uniswapV4 = new Interface(["event Initialize(bytes32 indexed poolId,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)"]);
const flapPortal = new Interface(["event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)"]);
const flapVaultPortal = new Interface(["event FlapTaxVaultTokenCreated(address indexed token,address indexed vault,address indexed vaultFactory)"]);
const fourMemeManager = new Interface(["event TokenCreate(address creator,address token,uint256 requestId,string name,string symbol,uint256 totalSupply,uint256 raisedAmount,uint256 reservedAmount)"]);
const fourMemePresaleManager = new Interface(["event TokenCreate(uint256 requestId,address creator,address token)"]);
const fourMemeTokenInfo = new Interface(["function _tokenInfos(address) view returns(address base,address quote,uint256 template,uint256 totalSupply,uint256 maxOffers,uint256 maxRaising,uint256 launchTime,uint256 offers,uint256 funds,uint256 lastPrice,uint256 K,uint256 T,uint256 status)"]);
const openFourRegistry = new Interface([
  "function isPresetActive(uint256 presetId) view returns (bool)",
  "function isPresetCreateEnabled(uint256 presetId) view returns (bool)",
]);
const openFourCore = new Interface(["event TokenCreated(uint256 requestId,uint256 indexed presetId,address indexed creator,address indexed token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,uint256 initialPrice,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address customData,address tokenModule,string tokenMetaUri,uint256 flags,bytes encodedTags)"]);
const grafunFactory = new Interface(["event TokenSaleCreated(address token,string name,string symbol,string metadata,string url,address referralLink)"]);
const hodlBondingFactory = new Interface(["event TokenLaunched(address indexed tokenAddress,address indexed bondingCurveAddress,address indexed creator)"]);
const hodlV2Factory = new Interface(["event TokenLaunchedV2(address indexed token,address indexed creator,address indexed pair,uint256 liquidityBnb,uint256 tokensToLp,uint256 tokensToCreator,uint256 lpBurned,bytes32 salt,string vanitySuffix)"]);
const hodlV3Factory = new Interface(["event TokenLaunched(address indexed token,address indexed creator,uint256 indexed positionId,address pool,bytes32 salt,string vanitySuffix,uint256 initialBuyAmount)"]);
const moonsalePresaleFactory = new Interface(["event PresaleCreated(address indexed presale,address indexed creator,address indexed token,uint256 startTime,uint256 endTime)"]);
const moonsaleFairLaunchFactory = new Interface(["event FairLaunchCreated(address indexed fairLaunch,address indexed creator,address indexed token,uint256 startTime,uint256 endTime)"]);
const moonsaleTokenFactory = new Interface([
  "event TokenCreated(address indexed token,address indexed creator,string name,string symbol,uint8 decimals,uint256 totalSupply,uint256 maxSupply,bool mintable,bool burnable)",
  "event LiquidityTokenCreated(address indexed token,address indexed creator,string name,string symbol,uint8 decimals,uint256 totalSupply,uint16 liquidityFee,uint16 marketingFee)",
]);
const huksFactory = new Interface(["event TokenCreated(address indexed token,address indexed creator,string name,string symbol,uint256 positionId,uint256 totalSupply,uint256 initialFdv,int24 tickLower,int24 tickUpper)"]);
const agentLaunchFactory = new Interface(["event TokenCreated(address indexed tokenAddress,address indexed creator,string indexed name,string ticker,string picture,uint256 tokenId)"]);
const karmafiFactory = new Interface(["event MarketCreated(bytes32 indexed sourceHash,address indexed tokenAddress,address indexed marketAddress,address curator,string name,string symbol)"]);
const rugFactory = new Interface(["event RugCreated(address indexed rug,address indexed creator,string name,string symbol,uint256 creatorStake,uint40 openingEnd,bytes32 metadataHash,bytes32 disclosureHash)"]);
const rugLaunch = new Interface(["event LaunchSucceeded(address indexed rug,address indexed token,address indexed pool,uint256 totalContributed,uint256 acceptedContribution,uint256 openingTokenAllocation,uint256 poolTokenReserve,uint256 poolQuoteReserve,uint256 founderAllocation)"]);
const createTokenFactory = new Interface(["event TokenCreated(address indexed token,address indexed creator,string name,string symbol,uint256 supply)"]);
const pooMemeFactory = new Interface(["event PresaleCreated(address indexed token,address indexed presale,address indexed creator,string name,string symbol,uint64 presaleStart,uint64 presaleEnd,uint64 launchTime,uint32 contractVersion,uint8 lpMode,bool whitelistEnabled)"]);
const bnbPumpManager = new Interface(["event TokenCreated(address indexed tokenAddress,address indexed saleAddress)"]);
const magicMintFactory = new Interface(["event TokenCreated(address indexed tokenAddress,address indexed creator,string name,string symbol,uint256 totalSupply,uint256 feePaid)"]);
const codelessFactory = new Interface(["event TokenCreated(address indexed tokenAddress,address indexed deployer,uint8 indexed tokenType,string name,string symbol,uint256 totalSupply,uint256 timestamp)"]);
const xfourFactory = new Interface(["event TokenCreated(address indexed tokenAddress,address indexed creator,string name,string symbol,bytes32 salt,uint256 saltIndex,uint256 mintAmount,uint256 maxMintCount,uint256 timestamp)"]);
const bullshotFactory = new Interface(["event Created(address indexed bondingCurve,address indexed token,address indexed referrer,address creator)"]);
const eagleTokenFactory = new Interface(["event TokenCreated(address indexed token,address indexed launch,address indexed creator,string name,string symbol,uint256 totalSupply,uint256 saleInventory,string imageURI,string description,string website,string telegram,string twitter)"]);
const eagleLaunchpadTokenFactory = new Interface(["event LaunchpadTokenDeployed(address indexed owner,address indexed token,uint8 indexed tokenType,string name,string symbol)"]);
const bnbsStandardFactory = new Interface(["event TokenCreated(address indexed tokenAddress,string name,string symbol,string logoUrl,string twitter,string telegram,address indexed creator,uint256 fundingGoal)"]);
const bnbsTaxFactory = new Interface(["event TokenCreated(address indexed tokenAddress,string name,string symbol,string logoUrl,string twitter,string telegram,address indexed creator,uint256 fundingGoal,uint256 buyTaxRate,uint256 sellTaxRate,uint256 marketShare,uint256 burnShare,uint256 reflectShare,uint256 liquidityShare,uint256 minHoldForReward,address reflectionAsset)"]);
const bfunFactory = new Interface(["event NewBFunToken(address addr,address bondingCurve,address creator,bytes signature,address payoutRecipient,address owner,uint256 nonce,string name,string symbol,string tokenURI,string version)"]);
const singularryFactory = new Interface(["event BondingCurveSystemDeployed(address indexed bondingCurve,address indexed token,address indexed owner,string name,string symbol)"]);
const singularryCurve = new Interface(["event CurveFinalized(address indexed uniswapPool,uint256 indexed lpTokenId)"]);
const onevoneTournamentManager = new Interface(["event TournamentCreated(uint256 indexed tournamentId,uint256 entryFee,uint256 roundDelay,uint256 roundDuration,uint256 startTime)"]);

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 20);
}

function normalizeOfficialText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/[\t \f\v]+/g, " ").replace(/ *\n */g, "\n").trim();
}

export function parseFourMemeAddressPayload(input) {
  const payload = typeof input === "string" ? JSON.parse(input) : input;
  if (!payload || payload.code !== 0 || !Array.isArray(payload.data)) throw new Error("Four.Meme address schema: expected code=0 and data array");
  const inventory = payload.data
    .filter((item) => item?.networkCode === "BSC" && typeof item.name === "string" && ADDRESS.test(String(item.address || "").toLowerCase()))
    .map((item) => ({ name: item.name.trim(), address: item.address.toLowerCase() }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.address.localeCompare(right.address));
  if (!inventory.length) throw new Error("Four.Meme address schema: empty BSC inventory");
  const roots = inventory.filter((item) => /^TokenManager(?:$|[A-Z0-9])/i.test(item.name) || item.name === "OpenFourCore");
  if (!roots.length) throw new Error("Four.Meme address schema: no launch roots");
  return { inventory, roots, fingerprint: digest(roots) };
}

export function parseFourMemeTemplatePayload(input) {
  const payload = typeof input === "string" ? JSON.parse(input) : input;
  if (!payload || payload.code !== 0 || !Array.isArray(payload.data)) throw new Error("Four.Meme template schema: expected code=0 and data array");
  const templates = payload.data.map((item) => {
    if (item?.id == null || typeof item.name !== "string" || typeof item.status !== "string") throw new Error("Four.Meme template schema: invalid template");
    const template = {
      id: String(item.id),
      name: normalizeOfficialText(item.name),
      tag: normalizeOfficialText(item.tag || (Array.isArray(item.tags) ? item.tags.join(" ") : "")),
      codeType: normalizeOfficialText(item.codeType),
      description: normalizeOfficialText(item.descr),
      amount: normalizeOfficialText(item.amount),
      status: normalizeOfficialText(item.status).toUpperCase(),
      deployCount: item.deploys !== null
        && item.deploys !== undefined
        && String(item.deploys).trim() !== ""
        && Number.isFinite(Number(item.deploys))
        ? Number(item.deploys)
        : null,
    };
    const semanticText = [template.name, template.tag, template.description].join(" ").toLowerCase();
    const mechanismTerms = [...new Set((semanticText.match(/\b(?:tax|royalt(?:y|ies)|fees?|buyback|burn|subscription|presale|airdrop|nft|infinity|dex|lend(?:ing)?|borrow(?:ing)?|liquidity|vesting|refund|verification|oracle|ai|vault|migration|graduation|revenue|anti[- ]?(?:bot|sniper)|bonding\s+curve)\b/gi) || []).map((term) => term.replace(/\s+/g, " ").toLowerCase()))].sort();
    const numericParameters = [...new Set((semanticText.match(/\b\d+(?:\.\d+)?\s*(?:%|bnb|usd[tc]?|tokens?)\b/gi) || []).map((value) => value.replace(/\s+/g, "").toLowerCase()))].sort();
    return {
      ...template,
      mechanismTerms,
      numericParameters,
      fingerprint: digest({
        id: template.id,
        tag: template.tag,
        codeType: template.codeType,
        status: template.status,
        amount: template.amount,
        mechanismTerms,
        numericParameters,
      }),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (!templates.length) throw new Error("Four.Meme template schema: empty template list");
  return templates;
}

const FOUR_MEME_TEMPLATE_COMPARISON_FIELDS = [
  "name",
  "tag",
  "codeType",
  "description",
  "amount",
  "status",
  "mechanismTerms",
  "numericParameters",
];

function compactFourMemeTemplate(template) {
  if (!template) return null;
  return Object.fromEntries([
    ["id", String(template.id)],
    ...FOUR_MEME_TEMPLATE_COMPARISON_FIELDS.map((field) => [
      field,
      Array.isArray(template[field]) ? [...template[field]] : template[field],
    ]),
  ]);
}

function changedFourMemeTemplateFields(previousTemplate, currentTemplate) {
  if (!previousTemplate) return ["template"];
  return FOUR_MEME_TEMPLATE_COMPARISON_FIELDS.filter((field) => (
    JSON.stringify(previousTemplate[field]) !== JSON.stringify(currentTemplate[field])
  ));
}

export function parseFourMemeQuotePayload(input) {
  const payload = typeof input === "string" ? JSON.parse(input) : input;
  if (!payload || payload.code !== 0 || !Array.isArray(payload.data)) throw new Error("Four.Meme quote schema: expected code=0 and data array");
  const configs = payload.data
    .filter((item) => item?.platform === "MEME" && item?.networkCode === "BSC" && item?.status === "PUBLISH")
    .map((item) => {
      const address = String(item.symbolAddress || "").toLowerCase();
      const symbol = normalizeOfficialText(item.symbol).toUpperCase();
      if (!ADDRESS.test(address) || !symbol) throw new Error("Four.Meme quote schema: invalid published quote");
      const config = {
        symbol,
        address,
        status: "PUBLISH",
        fees: {
          deployCost: item.deployCost ?? null,
          buyFee: item.buyFee ?? null,
          sellFee: item.sellFee ?? null,
          minTradeFee: item.minTradeFee ?? null,
        },
        thresholds: {
          b0Amount: item.b0Amount ?? null,
          totalBAmount: item.totalBAmount ?? null,
          totalAmount: item.totalAmount ?? null,
          saleRate: item.saleRate ?? null,
          reservedNumber: item.reservedNumber ?? null,
          tradeLevel: Array.isArray(item.tradeLevel) ? item.tradeLevel.map(String) : [],
        },
      };
      return { ...config, fingerprint: digest(config) };
    })
    .sort((left, right) => left.symbol.localeCompare(right.symbol) || left.address.localeCompare(right.address));
  if (!configs.length) throw new Error("Four.Meme quote schema: no published BSC quote");
  return configs;
}

export function isExcludedFourMemeTemplate(template = {}) {
  const text = [template.name, template.tag, template.description].filter(Boolean).join(" ");
  // Stock/equity/RWA issuance modes are outside the requested scope even when
  // presented as a token template rather than an announcement. Quote-pool and
  // contract changes remain eligible when their own text has no stock/RWA
  // semantics.
  return /(?:\b(?:rwa|stocks?|equity|equities|securit(?:y|ies)|tokenized\s+(?:assets?|stocks?))\b|股票|证券|股权|现实世界资产|实物资产|配股)/i.test(text);
}

export function suppressExcludedFourMemeTemplateActivations(targetState, observedAt = new Date().toISOString()) {
  let changed = 0;
  for (const activation of Object.values(targetState?.officialSources?.fourMeme?.featureActivations || {})) {
    if (activation?.type !== "template" || activation.active === false
      || !isExcludedFourMemeTemplate(activation.template || {})) continue;
    activation.active = false;
    activation.deactivatedAt = observedAt;
    activation.exclusionReason = "stock_equity_rwa_out_of_scope";
    changed += 1;
  }
  return changed;
}

function fourMemeActivationKey(template = {}) {
  return template.id && template.fingerprint ? `template:${template.id}:${template.fingerprint}` : null;
}

function fourMemeQuoteActivationKey(config = {}) {
  return config.symbol && config.address && config.fingerprint
    ? `quote:${config.symbol}:${config.address}:${config.fingerprint}`
    : null;
}

export function isOfficialFourMemeClassicTokenRecord(record) {
  return record?.version === "V3" && record?.networkCode === "BSC";
}

export function parseOfficialRugspullCatalog(input) {
  const payload = typeof input === "string" ? JSON.parse(input) : input;
  if (!Array.isArray(payload?.rugs)) throw new Error("Rugspull catalog schema: expected rugs array");
  const factory = "0xdff540babca2ee8a2a8ff26359ecc9c5921d8a63";
  return payload.rugs.map((item) => {
    const child = String(item?.rug_address || item?.rugAddress || item?.rug || "").toLowerCase();
    const itemFactory = String(item?.factory_address || item?.factoryAddress || "").toLowerCase();
    const chainId = Number(item?.chain_id ?? item?.chainId ?? BSC_CHAIN_ID);
    if (!ADDRESS.test(child) || itemFactory !== factory || chainId !== BSC_CHAIN_ID) return null;
    return {
      child: getAddress(child),
      createdBlock: Number(item?.created_block ?? item?.createdBlock ?? 0) || null,
      status: String(item?.status || "unknown"),
    };
  }).filter(Boolean);
}

export function nextRugspullCatalogCursor(payload, currentCursor, pageSize = 100) {
  const rows = Array.isArray(payload?.rugs) ? payload.rugs : [];
  const next = payload?.nextCursor;
  if (rows.length < pageSize || next === null || next === undefined || next === "") return null;
  const nextNumber = Number(next);
  const currentNumber = currentCursor === null || currentCursor === undefined || currentCursor === ""
    ? null
    : Number(currentCursor);
  if (!Number.isFinite(nextNumber) || nextNumber === 0) return null;
  if (currentNumber !== null && Number.isFinite(currentNumber) && nextNumber <= currentNumber) return null;
  return String(next);
}

export function waifuModeFingerprint(launch = {}) {
  return digest({
    source: "waifu",
    tier: normalizeOfficialText(launch.tier || "default").toLowerCase(),
    vault: Boolean(launch.vault || launch.vaultAddress),
    mechanism: normalizeOfficialText(launch.mechanism || launch.launchMode || launch.launchType || "flap-presale").toLowerCase(),
  });
}

export function parseDappBayLaunchpadCatalog(input) {
  const payload = typeof input === "string" ? JSON.parse(input) : input;
  const items = Array.isArray(payload?.list) ? payload.list : [];
  const records = [];
  const launchSignal = /\b(?:launchpad|token launch|launch token|memecoin|meme coin|bonding curve|fair launch|token factory)\b/i;
  for (const item of items) {
    const text = [item?.name, item?.category, item?.description, item?.advertise_lang, ...(item?.tags || [])].filter(Boolean).join(" ");
    const supportsBsc = (item?.chain_info || []).some((chain) => Number(chain?.id) === 1 || /bnb smart chain|\bbsc\b/i.test(chain?.name || ""));
    if (!supportsBsc || !launchSignal.test(text)) continue;
    const addresses = (item?.build_contracts || [])
      .filter((contract) => Number(contract?.chain_info_id) === 1 && ADDRESS.test(String(contract?.contract || "").toLowerCase()))
      .map((contract) => String(contract.contract).toLowerCase());
    for (const address of new Set(addresses)) records.push({
      address,
      platform: {
        id: `dappbay-${item.id}`,
        name: normalizeOfficialText(item.name),
        website: /^https:\/\//i.test(item.website || "") ? item.website : null,
        twitter: /^https:\/\/(?:x|twitter)\.com\//i.test(item.twitter_url || "") ? item.twitter_url : null,
        github: /^https:\/\/github\.com\//i.test(item.github_url || "") ? item.github_url : null,
      },
      sourceId: "bnb-chain-dappbay",
      sourceUrl: `https://dappbay.bnbchain.org/detail/${item.uniq_name || item.id}`,
      trust: "ecosystem_directory_candidate",
      launchTime: Number(item.launch_time) || null,
    });
  }
  return records.sort((left, right) => left.address.localeCompare(right.address));
}

export function parseSingularryTokenPayload(input) {
  const payload = typeof input === "string" ? JSON.parse(input) : input;
  if (!Array.isArray(payload)) throw new Error("Singularry token schema: expected array");
  return payload.map((item) => {
    const token = String(item?.mint || "").toLowerCase();
    const curve = String(item?.bondingCurve || "").toLowerCase();
    if (!ADDRESS.test(token) || !ADDRESS.test(curve)) return null;
    const pool = String(item?.dexPoolAddress || "").toLowerCase();
    const owner = String(item?.creator?.walletAddress || item?.creatorAddress || "").toLowerCase();
    return {
      token,
      curve,
      owner: ADDRESS.test(owner) ? owner : null,
      name: normalizeOfficialText(item?.name) || null,
      symbol: normalizeOfficialText(item?.symbol) || null,
      complete: item?.complete === true,
      currentPhase: normalizeOfficialText(item?.currentPhase) || null,
      graduatedAt: typeof item?.graduatedAt === "string" && item.graduatedAt ? item.graduatedAt : null,
      pool: ADDRESS.test(pool) ? pool : null,
      graduationDex: normalizeOfficialText(item?.graduationDex) || null,
      progressBps: Number.isFinite(Number(item?.progressBps)) ? Number(item.progressBps) : null,
    };
  }).filter(Boolean).sort((left, right) => left.token.localeCompare(right.token));
}

export function parseKnownBscLaunchEvidence(logs = []) {
  const evidence = [];
  for (const log of logs) {
    try {
      let item = null;
      if (log.topics?.[0] === FLAP_TOKEN_CREATED_TOPIC) {
        const args = flapPortal.parseLog(log).args;
        item = { token: args.token, creator: args.creator, name: args.name, symbol: args.symbol, metadataUri: args.meta, event: "TokenCreated" };
      } else if (log.topics?.[0] === FLAP_VAULT_TOKEN_CREATED_TOPIC) {
        const args = flapVaultPortal.parseLog(log).args;
        item = { token: args.token, vault: args.vault, vaultFactory: args.vaultFactory, event: "FlapTaxVaultTokenCreated" };
      } else if (log.topics?.[0] === FOUR_MEME_TOKEN_CREATE_TOPIC) {
        const args = fourMemeManager.parseLog(log).args;
        item = { token: args.token, creator: args.creator, requestId: args.requestId.toString(), name: args.name, symbol: args.symbol, launchType: "fourmeme_curve", event: "TokenCreate" };
      } else if (log.topics?.[0] === FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC) {
        const args = fourMemePresaleManager.parseLog(log).args;
        item = { token: args.token, creator: args.creator, requestId: args.requestId.toString(), launchType: "fourmeme_presale", event: "TokenCreate" };
      } else if (log.topics?.[0] === OPENFOUR_TOKEN_CREATED_TOPIC) {
        const args = openFourCore.parseLog(log).args;
        item = {
          token: args.token,
          creator: args.creator,
          requestId: args.requestId.toString(),
          presetId: args.presetId.toString(),
          name: args.name,
          symbol: args.symbol,
          maxSupply: args.maxSupply.toString(),
          saleAmount: args.saleAmount.toString(),
          raiseAmount: args.raiseAmount.toString(),
          initialPrice: args.initialPrice.toString(),
          quoteAsset: getAddress(args.quoteAsset),
          vault: getAddress(args.vault),
          curveModule: getAddress(args.curveModule),
          tradeModule: getAddress(args.tradeModule),
          migrateModule: getAddress(args.migrateModule),
          customData: getAddress(args.customData),
          tokenModule: getAddress(args.tokenModule),
          flags: args.flags.toString(),
          encodedTags: args.encodedTags,
          metadataUri: args.tokenMetaUri,
          launchType: "openfour_modular",
          event: "TokenCreated",
        };
      } else if (log.topics?.[0] === GRAFUN_TOKEN_SALE_CREATED_TOPIC) {
        const args = grafunFactory.parseLog(log).args;
        item = { token: args.token, name: args.name, symbol: args.symbol, metadataUri: args.metadata, website: args.url, referral: args.referralLink, event: "TokenSaleCreated" };
      } else if (log.topics?.[0] === HODL_BONDING_TOKEN_LAUNCHED_TOPIC) {
        const args = hodlBondingFactory.parseLog(log).args;
        item = { token: args.tokenAddress, creator: args.creator, bondingCurve: args.bondingCurveAddress, launchType: "bonding", event: "TokenLaunched" };
      } else if (log.topics?.[0] === HODL_V2_TOKEN_LAUNCHED_TOPIC) {
        const args = hodlV2Factory.parseLog(log).args;
        item = { token: args.token, creator: args.creator, pool: args.pair, launchType: "v2_burn", event: "TokenLaunchedV2" };
      } else if (log.topics?.[0] === HODL_V3_TOKEN_LAUNCHED_TOPIC) {
        const args = hodlV3Factory.parseLog(log).args;
        item = { token: args.token, creator: args.creator, pool: args.pool, launchType: "v3_direct", event: "TokenLaunched" };
      } else if (log.topics?.[0] === MOONSALE_PRESALE_CREATED_TOPIC) {
        const args = moonsalePresaleFactory.parseLog(log).args;
        item = { token: args.token, creator: args.creator, sale: args.presale, launchType: "presale", event: "PresaleCreated" };
      } else if (log.topics?.[0] === MOONSALE_FAIR_LAUNCH_CREATED_TOPIC) {
        const args = moonsaleFairLaunchFactory.parseLog(log).args;
        item = { token: args.token, creator: args.creator, sale: args.fairLaunch, launchType: "fair_launch", event: "FairLaunchCreated" };
      } else if (log.topics?.[0] === MOONSALE_TOKEN_CREATED_TOPIC) {
        const args = moonsaleTokenFactory.parseLog(log).args;
        item = { token: args.token, creator: args.creator, name: args.name, symbol: args.symbol, launchType: args.mintable ? "standard_mintable" : "standard_fixed_supply", event: "TokenCreated" };
      } else if (log.topics?.[0] === MOONSALE_LIQUIDITY_TOKEN_CREATED_TOPIC) {
        const args = moonsaleTokenFactory.parseLog(log).args;
        item = { token: args.token, creator: args.creator, name: args.name, symbol: args.symbol, launchType: "liquidity_generator", event: "LiquidityTokenCreated" };
      } else if (log.topics?.[0] === HUKS_TOKEN_CREATED_TOPIC) {
        const args = huksFactory.parseLog(log).args;
        item = { token: args.token, creator: args.creator, name: args.name, symbol: args.symbol, launchType: "uniswap_v3_position", event: "TokenCreated" };
      } else if (log.topics?.[0] === AGENT_LAUNCH_TOKEN_CREATED_TOPIC) {
        const args = agentLaunchFactory.parseLog(log).args;
        item = { token: args.tokenAddress, creator: args.creator, symbol: args.ticker, image: args.picture, launchType: "agent", event: "TokenCreated" };
      } else if (log.topics?.[0] === KARMAFI_MARKET_CREATED_TOPIC) {
        const args = karmafiFactory.parseLog(log).args;
        item = { token: args.tokenAddress, creator: args.curator, market: args.marketAddress, name: args.name, symbol: args.symbol, launchType: "attention_market", event: "MarketCreated" };
      } else if (log.topics?.[0] === RUG_LAUNCH_SUCCEEDED_TOPIC) {
        const args = rugLaunch.parseLog(log).args;
        item = { token: args.token, pool: args.pool, launchType: "successful_rug", event: "LaunchSucceeded" };
      } else if (log.topics?.[0] === CREATE_TOKEN_CREATED_TOPIC) {
        const args = createTokenFactory.parseLog(log).args;
        item = { token: args.token, creator: args.creator, name: args.name, symbol: args.symbol, launchType: "standard_bep20", event: "TokenCreated" };
      } else if (log.topics?.[0] === POO_MEME_PRESALE_CREATED_TOPIC) {
        const args = pooMemeFactory.parseLog(log).args;
        item = { token: args.token, creator: args.creator, name: args.name, symbol: args.symbol, presale: args.presale, launchType: `presale_v${Number(args.contractVersion)}_lp${Number(args.lpMode)}`, event: "PresaleCreated" };
      } else if (log.topics?.[0] === BNBPUMP_TOKEN_CREATED_TOPIC) {
        const args = bnbPumpManager.parseLog(log).args;
        item = { token: args.tokenAddress, sale: args.saleAddress, launchType: "bonding_sale", event: "TokenCreated" };
      } else if (log.topics?.[0] === MAGICMINT_TOKEN_CREATED_TOPIC) {
        const args = magicMintFactory.parseLog(log).args;
        item = { token: args.tokenAddress, creator: args.creator, name: args.name, symbol: args.symbol, launchType: "mint_factory", event: "TokenCreated" };
      } else if (log.topics?.[0] === CODELESS_TOKEN_CREATED_TOPIC) {
        const args = codelessFactory.parseLog(log).args;
        const type = ["standard", "tax", "deflationary", "reflection"][Number(args.tokenType)] || `type_${Number(args.tokenType)}`;
        item = { token: args.tokenAddress, creator: args.deployer, name: args.name, symbol: args.symbol, launchType: type, event: "TokenCreated" };
      } else if (log.topics?.[0] === XFOUR_TOKEN_CREATED_TOPIC) {
        const args = xfourFactory.parseLog(log).args;
        item = { token: args.tokenAddress, creator: args.creator, name: args.name, symbol: args.symbol, launchType: "x402_mint", event: "TokenCreated" };
      } else if (log.topics?.[0] === BULLSHOT_CREATED_TOPIC) {
        const args = bullshotFactory.parseLog(log).args;
        item = { token: args.token, creator: args.creator, bondingCurve: args.bondingCurve, launchType: "bonding_curve", event: "Created" };
      } else if (log.topics?.[0] === EAGLE_TOKEN_CREATED_TOPIC) {
        const args = eagleTokenFactory.parseLog(log).args;
        item = {
          token: args.token,
          creator: args.creator,
          launch: args.launch,
          name: args.name,
          symbol: args.symbol,
          totalSupply: args.totalSupply.toString(),
          saleInventory: args.saleInventory.toString(),
          image: args.imageURI,
          description: args.description,
          website: args.website,
          twitter: args.twitter,
          telegram: args.telegram,
          launchType: "eagle_inner_market",
          event: "TokenCreated",
        };
      } else if (log.topics?.[0] === EAGLE_LAUNCHPAD_TOKEN_DEPLOYED_TOPIC) {
        const args = eagleLaunchpadTokenFactory.parseLog(log).args;
        item = { token: args.token, creator: args.owner, name: args.name, symbol: args.symbol, launchType: `eagle_launchpad_type_${Number(args.tokenType)}`, event: "LaunchpadTokenDeployed" };
      } else if (log.topics?.[0] === BNBS_STANDARD_TOKEN_CREATED_TOPIC) {
        const args = bnbsStandardFactory.parseLog(log).args;
        item = { token: args.tokenAddress, creator: args.creator, name: args.name, symbol: args.symbol, image: args.logoUrl, twitter: args.twitter, telegram: args.telegram, fundingGoal: args.fundingGoal.toString(), launchType: "bnbs_standard_curve", event: "TokenCreated" };
      } else if (log.topics?.[0] === BNBS_TAX_TOKEN_CREATED_TOPIC) {
        const args = bnbsTaxFactory.parseLog(log).args;
        item = {
          token: args.tokenAddress,
          creator: args.creator,
          name: args.name,
          symbol: args.symbol,
          image: args.logoUrl,
          twitter: args.twitter,
          telegram: args.telegram,
          fundingGoal: args.fundingGoal.toString(),
          buyTaxRate: args.buyTaxRate.toString(),
          sellTaxRate: args.sellTaxRate.toString(),
          marketShare: args.marketShare.toString(),
          burnShare: args.burnShare.toString(),
          reflectShare: args.reflectShare.toString(),
          liquidityShare: args.liquidityShare.toString(),
          minHoldForReward: args.minHoldForReward.toString(),
          reflectionAsset: getAddress(args.reflectionAsset),
          launchType: "bnbs_tax_reflection_curve",
          event: "TokenCreated",
        };
      } else if (log.topics?.[0] === BFUN_NEW_TOKEN_TOPIC) {
        const args = bfunFactory.parseLog(log).args;
        item = {
          token: args.addr,
          bondingCurve: getAddress(args.bondingCurve),
          creator: args.creator,
          payoutRecipient: getAddress(args.payoutRecipient),
          owner: getAddress(args.owner),
          nonce: args.nonce.toString(),
          name: args.name,
          symbol: args.symbol,
          metadataUri: args.tokenURI,
          version: args.version,
          launchType: "bfun_dynamic_curve",
          event: "NewBFunToken",
        };
      } else if (log.topics?.[0] === SINGULARRY_SYSTEM_DEPLOYED_TOPIC) {
        const args = singularryFactory.parseLog(log).args;
        item = {
          token: args.token,
          creator: args.owner,
          bondingCurve: getAddress(args.bondingCurve),
          name: args.name,
          symbol: args.symbol,
          launchType: "singularry_bonding_thena_v3",
          event: "BondingCurveSystemDeployed",
        };
      }
      if (item) evidence.push({
        ...item,
        token: getAddress(item.token),
        creator: item.creator ? getAddress(item.creator) : null,
        emitter: getAddress(log.address),
        topic: log.topics[0],
        ...(log.transactionHash ? { transactionHash: String(log.transactionHash).toLowerCase() } : {}),
        ...(log.blockHash ? { blockHash: String(log.blockHash).toLowerCase() } : {}),
        ...(Number.isSafeInteger(Number(log.blockNumber)) ? { blockNumber: Number(log.blockNumber) } : {}),
        ...(Number.isSafeInteger(Number(log.transactionIndex))
          ? { transactionIndex: Number(log.transactionIndex) }
          : {}),
        ...(Number.isSafeInteger(Number(log.index ?? log.logIndex))
          ? { logIndex: Number(log.index ?? log.logIndex) }
          : {}),
      });
    } catch {
      // A copied or malformed topic is not sufficient evidence.
    }
  }
  return [...new Map(evidence.map((item) => [`${item.emitter.toLowerCase()}:${item.token.toLowerCase()}:${item.topic}`, item])).values()];
}

export function parseKnownBscLaunchTokens(logs = []) {
  return [...new Set(parseKnownBscLaunchEvidence(logs).map((item) => item.token))];
}

function parseRugspullChildren(logs = []) {
  const children = [];
  for (const log of logs) {
    if (log.topics?.[0] !== RUG_CREATED_TOPIC || String(log.address || "").toLowerCase() !== "0xdff540babca2ee8a2a8ff26359ecc9c5921d8a63") continue;
    try {
      const args = rugFactory.parseLog(log).args;
      children.push({ child: getAddress(args.rug), creator: getAddress(args.creator), name: args.name, symbol: args.symbol });
    } catch {
      // Malformed copies of the event do not enter the official child graph.
    }
  }
  return children;
}

function containsAddressWord(log, address) {
  const word = String(address || "").toLowerCase().replace(/^0x/, "").padStart(64, "0");
  if (!/^[0-9a-f]{64}$/.test(word)) return false;
  if ((log.topics || []).slice(1).some((topic) => String(topic).toLowerCase().replace(/^0x/, "") === word)) return true;
  const data = String(log.data || "").toLowerCase().replace(/^0x/, "");
  for (let offset = 0; offset + 64 <= data.length; offset += 64) if (data.slice(offset, offset + 64) === word) return true;
  return false;
}

export function findTokenCorrelatedEmitters(logs = [], tokens = [], excludedAddresses = []) {
  const excluded = new Set(excludedAddresses.map((address) => String(address).toLowerCase()));
  const tokenSet = new Set(tokens.map((address) => String(address).toLowerCase()));
  const matches = [];
  for (const log of logs) {
    const emitter = String(log.address || "").toLowerCase();
    const topic = log.topics?.[0];
    if (!ADDRESS.test(emitter) || excluded.has(emitter) || tokenSet.has(emitter) || !topic || GENERIC_TOPICS.has(topic)) continue;
    for (const token of tokenSet) {
      if (containsAddressWord(log, token)) matches.push({ emitter: getAddress(emitter), token: getAddress(token), topic });
    }
  }
  return [...new Map(matches.map((item) => [`${item.emitter.toLowerCase()}:${item.token.toLowerCase()}:${item.topic}`, item])).values()];
}

export function hasBscLaunchArgumentEvidence({ argumentBytes = 0, controllerKind = null, creationTopics = [] } = {}) {
  if (Number(argumentBytes) >= 32) return true;
  return controllerKind === "official_child_event_emitter"
    && creationTopics.includes(RUG_LAUNCH_SUCCEEDED_TOPIC);
}

export function parseBscScanCreationTransaction(html) {
  return parseBscScanAttribution(html).creationTransaction;
}

function iso(now = Date.now()) {
  const value = typeof now === "function" ? now() : now;
  return new Date(value instanceof Date ? value.getTime() : value).toISOString();
}

const BSC_WEBSOCKET_DELIVERY_BUDGET_MS = 5_000;
const BSC_WEBSOCKET_DELIVERY_BASIS = "bsc_websocket_ingest";
const BSC_WEBSOCKET_PROOF_TIMEOUT_MS = 1_250;
const BSC_WEBSOCKET_PROOF_DELIVERY_RESERVE_MS = 250;
const BSC_WEBSOCKET_PROOF_MAX_REQUESTS = 3;
const BSC_WEBSOCKET_PROOF_MAX_BLOCK_AGE_MS = 60_000;
const BSC_WEBSOCKET_PROOF_METHODS = new Set([
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getCode",
]);

function normalizeBscWebsocketDeliverySla(value) {
  if (!value || typeof value !== "object") return null;
  if (value.budgetMs !== BSC_WEBSOCKET_DELIVERY_BUDGET_MS
    || value.pollAllowanceMs !== 0
    || value.basis !== BSC_WEBSOCKET_DELIVERY_BASIS) return null;
  const startedAtMs = Date.parse(value.startedAt || "");
  const deadlineAtMs = Date.parse(value.deadlineAt || "");
  if (!Number.isFinite(startedAtMs)
    || !Number.isFinite(deadlineAtMs)
    || deadlineAtMs < startedAtMs
    || deadlineAtMs - startedAtMs > BSC_WEBSOCKET_DELIVERY_BUDGET_MS) return null;
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    deadlineAt: new Date(deadlineAtMs).toISOString(),
    budgetMs: BSC_WEBSOCKET_DELIVERY_BUDGET_MS,
    pollAllowanceMs: 0,
    basis: BSC_WEBSOCKET_DELIVERY_BASIS,
  };
}

function createBscWebsocketDeliverySla(current) {
  const startedAtMs = current instanceof Date ? current.getTime() : Number(current);
  if (!Number.isFinite(startedAtMs)) return null;
  return normalizeBscWebsocketDeliverySla({
    startedAt: new Date(startedAtMs).toISOString(),
    deadlineAt: new Date(startedAtMs + BSC_WEBSOCKET_DELIVERY_BUDGET_MS).toISOString(),
    budgetMs: BSC_WEBSOCKET_DELIVERY_BUDGET_MS,
    pollAllowanceMs: 0,
    basis: BSC_WEBSOCKET_DELIVERY_BASIS,
  });
}

function earliestBscWebsocketDeliverySla(...values) {
  return values
    .map(normalizeBscWebsocketDeliverySla)
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.deadlineAt) - Date.parse(right.deadlineAt)
      || Date.parse(left.startedAt) - Date.parse(right.startedAt))[0] || null;
}

function strictBscRpcQuantity(value, label) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) {
    throw new Error(`invalid BSC websocket ${label}`);
  }
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid BSC websocket ${label}`);
  return parsed;
}

function strictBscRpcHash(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`invalid BSC websocket ${label}`);
  }
  return value.toLowerCase();
}

function strictBscRpcAddress(value, label) {
  if (typeof value !== "string" || !ADDRESS.test(value.toLowerCase())) {
    throw new Error(`invalid BSC websocket ${label}`);
  }
  try { return getAddress(value); }
  catch { throw new Error(`invalid BSC websocket ${label}`); }
}

function strictBscRpcData(value, label) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`invalid BSC websocket ${label}`);
  }
  return value.toLowerCase();
}

function normalizeBscWebsocketProof({ transactionHash, blockNumber, transaction, receipt, block, triggerLog, current }) {
  const requestedHash = strictBscRpcHash(transactionHash, "requested transaction hash");
  const expectedBlockNumber = Number(blockNumber);
  if (!Number.isSafeInteger(expectedBlockNumber) || expectedBlockNumber < 0) {
    throw new Error("invalid BSC websocket requested block number");
  }
  if (!transaction || typeof transaction !== "object" || !receipt || typeof receipt !== "object"
    || !block || typeof block !== "object" || !triggerLog || typeof triggerLog !== "object"
    || triggerLog.removed === true) {
    throw new Error("missing BSC websocket proof object");
  }
  const transactionProofHash = strictBscRpcHash(transaction.hash, "transaction hash");
  const receiptHash = strictBscRpcHash(receipt.transactionHash, "receipt transaction hash");
  const triggerHash = strictBscRpcHash(triggerLog.transactionHash, "trigger transaction hash");
  if (transactionProofHash !== requestedHash || receiptHash !== requestedHash || triggerHash !== requestedHash) {
    throw new Error("BSC websocket transaction hash mismatch");
  }
  const transactionBlockNumber = strictBscRpcQuantity(transaction.blockNumber, "transaction block number");
  const receiptBlockNumber = strictBscRpcQuantity(receipt.blockNumber, "receipt block number");
  const triggerBlockNumber = strictBscRpcQuantity(triggerLog.blockNumber, "trigger block number");
  const returnedBlockNumber = strictBscRpcQuantity(block.number, "block number");
  if ([transactionBlockNumber, receiptBlockNumber, triggerBlockNumber, returnedBlockNumber]
    .some((value) => value !== expectedBlockNumber)) {
    throw new Error("BSC websocket block number mismatch");
  }
  const transactionBlockHash = strictBscRpcHash(transaction.blockHash, "transaction block hash");
  const receiptBlockHash = strictBscRpcHash(receipt.blockHash, "receipt block hash");
  const triggerBlockHash = strictBscRpcHash(triggerLog.blockHash, "trigger block hash");
  const returnedBlockHash = strictBscRpcHash(block.hash, "block hash");
  if ([receiptBlockHash, triggerBlockHash, returnedBlockHash].some((value) => value !== transactionBlockHash)) {
    throw new Error("BSC websocket block hash mismatch");
  }
  const transactionIndex = strictBscRpcQuantity(transaction.transactionIndex, "transaction index");
  const receiptTransactionIndex = strictBscRpcQuantity(receipt.transactionIndex, "receipt transaction index");
  const triggerTransactionIndex = strictBscRpcQuantity(triggerLog.transactionIndex, "trigger transaction index");
  if (receiptTransactionIndex !== transactionIndex || triggerTransactionIndex !== transactionIndex) {
    throw new Error("BSC websocket transaction index mismatch");
  }
  const transactionFrom = strictBscRpcAddress(transaction.from, "transaction from");
  const transactionTo = strictBscRpcAddress(transaction.to, "transaction to");
  const receiptFrom = strictBscRpcAddress(receipt.from, "receipt from");
  const receiptTo = strictBscRpcAddress(receipt.to, "receipt to");
  if (receiptFrom.toLowerCase() !== transactionFrom.toLowerCase()
    || receiptTo.toLowerCase() !== transactionTo.toLowerCase()) {
    throw new Error("BSC websocket transaction address mismatch");
  }
  if (!["0x0", "0x1"].includes(receipt.status)) throw new Error("invalid BSC websocket receipt status");
  if (receipt.status !== "0x1") throw new Error("BSC websocket transaction was not successful");
  if (!Array.isArray(receipt.logs)) throw new Error("invalid BSC websocket receipt logs");
  const normalizedLogs = receipt.logs.map((log, index) => {
    if (!log || typeof log !== "object" || log.removed === true) {
      throw new Error(`invalid BSC websocket receipt log ${index}`);
    }
    const logTransactionHash = strictBscRpcHash(log.transactionHash, `receipt log ${index} transaction hash`);
    const logBlockNumber = strictBscRpcQuantity(log.blockNumber, `receipt log ${index} block number`);
    const logBlockHash = strictBscRpcHash(log.blockHash, `receipt log ${index} block hash`);
    const logTransactionIndex = strictBscRpcQuantity(log.transactionIndex, `receipt log ${index} transaction index`);
    const logIndex = strictBscRpcQuantity(log.logIndex, `receipt log ${index} index`);
    const address = strictBscRpcAddress(log.address, `receipt log ${index} address`);
    if (logTransactionHash !== requestedHash
      || logBlockNumber !== expectedBlockNumber
      || logBlockHash !== transactionBlockHash
      || logTransactionIndex !== transactionIndex
      || !Array.isArray(log.topics)
      || log.topics.some((topic) => !/^0x[0-9a-fA-F]{64}$/.test(String(topic)))) {
      throw new Error(`BSC websocket receipt log identity mismatch ${index}`);
    }
    return {
      ...log,
      address,
      transactionHash: requestedHash,
      blockNumber: expectedBlockNumber,
      blockHash: transactionBlockHash,
      transactionIndex,
      logIndex,
      index: logIndex,
      topics: log.topics.map((topic) => String(topic).toLowerCase()),
      data: strictBscRpcData(log.data, `receipt log ${index} data`),
      removed: false,
    };
  });
  const triggerLogIndex = strictBscRpcQuantity(triggerLog.logIndex, "trigger log index");
  const triggerAddress = strictBscRpcAddress(triggerLog.address, "trigger address").toLowerCase();
  const triggerTopics = Array.isArray(triggerLog.topics)
    ? triggerLog.topics.map((topic) => strictBscRpcHash(topic, "trigger topic"))
    : null;
  const triggerData = strictBscRpcData(triggerLog.data, "trigger data");
  if (!triggerTopics || !normalizedLogs.some((log) => log.logIndex === triggerLogIndex
    && log.address.toLowerCase() === triggerAddress
    && log.data === triggerData
    && log.topics.length === triggerTopics.length
    && log.topics.every((topic, index) => topic === triggerTopics[index]))) {
    throw new Error("BSC websocket trigger log missing from receipt");
  }
  const timestamp = strictBscRpcQuantity(block.timestamp, "block timestamp");
  const currentMs = Number(current);
  if (timestamp <= 0
    || !Number.isFinite(currentMs)
    || timestamp * 1_000 > currentMs + 60_000
    || currentMs - timestamp * 1_000 > BSC_WEBSOCKET_PROOF_MAX_BLOCK_AGE_MS) {
    throw new Error("invalid BSC websocket block timestamp");
  }
  if (!Array.isArray(block.transactions)) throw new Error("invalid BSC websocket block transactions");
  const blockTransactions = block.transactions.map((hash, index) => strictBscRpcHash(hash, `block transaction ${index}`));
  if (blockTransactions[transactionIndex] !== requestedHash) {
    throw new Error("BSC websocket transaction position mismatch");
  }
  return {
    transaction: {
      ...transaction,
      hash: requestedHash,
      blockNumber: expectedBlockNumber,
      blockHash: transactionBlockHash,
      transactionIndex,
      index: transactionIndex,
      from: transactionFrom,
      to: transactionTo,
      data: strictBscRpcData(transaction.input ?? transaction.data, "transaction input"),
    },
    receipt: {
      ...receipt,
      hash: requestedHash,
      transactionHash: requestedHash,
      blockNumber: expectedBlockNumber,
      blockHash: transactionBlockHash,
      transactionIndex,
      index: transactionIndex,
      from: receiptFrom,
      to: receiptTo,
      status: 1,
      logs: normalizedLogs,
    },
    block: {
      ...block,
      number: expectedBlockNumber,
      hash: transactionBlockHash,
      timestamp,
      transactions: blockTransactions,
    },
  };
}

function normalizeTransactionHash(value) {
  return String(value || "").toLowerCase();
}

function hexBlock(value) {
  return `0x${Number(value).toString(16)}`;
}

function fourMemeCreationCandidateKey(candidate = {}) {
  return `${normalizeTransactionHash(candidate.transactionHash)}:${Number(candidate.logIndex || 0)}:${String(candidate.token || "").toLowerCase()}`;
}

function flapCreationCandidateKey(candidate = {}) {
  return `${normalizeTransactionHash(candidate.transactionHash)}:${Number(candidate.logIndex || 0)}:${String(candidate.token || "").toLowerCase()}`;
}

function compareFlapQuoteTokenCandidates(left = {}, right = {}) {
  return Number(left.blockNumber) - Number(right.blockNumber)
    || bscQueuePosition(left.transactionIndex) - bscQueuePosition(right.transactionIndex)
    || bscQueuePosition(left.logIndex) - bscQueuePosition(right.logIndex)
    || normalizeTransactionHash(left.transactionHash).localeCompare(normalizeTransactionHash(right.transactionHash))
    || String(left.tokenAddress || left.token || "").toLowerCase()
      .localeCompare(String(right.tokenAddress || right.token || "").toLowerCase());
}

function sameFlapQuoteFirstThreeValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameFlapQuoteFirstThreeValue(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameFlapQuoteFirstThreeValue(left[key], right[key]));
}

function exactFlapQuoteFirstThreeIso(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function flapQuoteFirstThreeGenerationKey(record = {}) {
  const quoteAddress = String(record.quoteAddress || "").toLowerCase();
  const blockHash = normalizeTransactionHash(record.blockHash);
  const transactionHash = normalizeTransactionHash(record.transactionHash);
  const logIndex = Number(record.logIndex);
  return `quote:${quoteAddress}:generation:${blockHash}:${transactionHash}:${logIndex}`;
}

function emptyFlapQuoteFirstThreeState() {
  return {
    version: 1,
    windows: {},
    activeByQuote: {},
    lifecycleEvents: {},
  };
}

function normalizeFlapQuotePoolLifecycleRecord(record = {}) {
  const allowedKeys = new Set([
    "version", "action", "quoteAddress", "quoteName", "quoteSymbol",
    "activationEventKey", "transactionHash", "blockNumber", "blockHash",
    "transactionIndex", "logIndex", "occurredAt", "proofType",
    "requiredConfirmations", "monitorOnly", "targetActivationEventKey",
  ]);
  if (!record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error("invalid Flap quote lifecycle record shape");
  }
  const action = String(record.action || "").toLowerCase();
  const quoteAddress = String(record.quoteAddress || "").toLowerCase();
  const activationEventKey = typeof record.activationEventKey === "string"
    ? record.activationEventKey.trim() : "";
  const transactionHash = normalizeTransactionHash(record.transactionHash);
  const blockHash = normalizeTransactionHash(record.blockHash);
  const blockNumber = Number(record.blockNumber);
  const transactionIndex = Number(record.transactionIndex);
  const logIndex = Number(record.logIndex);
  const occurredAtMs = Date.parse(record.occurredAt || "");
  const requiredConfirmations = Number(record.requiredConfirmations);
  const expectedProofType = action === "activated"
    ? "verified_zero_to_one"
    : action === "disabled" ? "verified_disable"
      : action === "restored" ? "verified_disable_orphaned" : null;
  const targetActivationEventKey = typeof record.targetActivationEventKey === "string"
    ? record.targetActivationEventKey.trim() : null;
  const targetActivationMatch = targetActivationEventKey
    ? /^flap-quote:56:(0x[0-9a-f]{64}):(\d+)$/.exec(targetActivationEventKey)
    : null;
  if (record.version !== 1
    || !expectedProofType
    || record.proofType !== expectedProofType
    || record.monitorOnly !== true
    || !ADDRESS.test(quoteAddress)
    || !activationEventKey || activationEventKey.length > 512
    || activationEventKey !== `flap-quote:${BSC_CHAIN_ID}:${transactionHash}:${logIndex}`
    || !/^0x[0-9a-f]{64}$/.test(transactionHash)
    || !/^0x[0-9a-f]{64}$/.test(blockHash)
    || !Number.isSafeInteger(blockNumber) || blockNumber < 0
    || !Number.isSafeInteger(transactionIndex) || transactionIndex < 0
    || !Number.isSafeInteger(logIndex) || logIndex < 0
    || !Number.isFinite(occurredAtMs)
    || !Number.isSafeInteger(requiredConfirmations) || requiredConfirmations < 0
    || (action === "restored" && (!targetActivationMatch
      || !Number.isSafeInteger(Number(targetActivationMatch[2]))))
    || (action !== "restored" && record.targetActivationEventKey !== undefined)) {
    throw new Error("invalid or unverified Flap quote lifecycle record");
  }
  const quoteName = normalizeOfficialText(record.quoteName || "");
  const quoteSymbol = normalizeOfficialText(record.quoteSymbol || "");
  if (!quoteName || quoteName.length > 256 || !quoteSymbol || quoteSymbol.length > 24) {
    throw new Error("invalid Flap quote lifecycle metadata");
  }
  return {
    version: 1,
    action,
    quoteAddress,
    quoteName,
    quoteSymbol,
    activationEventKey,
    transactionHash,
    blockNumber,
    blockHash,
    transactionIndex,
    logIndex,
    occurredAt: new Date(occurredAtMs).toISOString(),
    proofType: expectedProofType,
    ...(targetActivationEventKey ? { targetActivationEventKey } : {}),
    requiredConfirmations,
    monitorOnly: true,
  };
}

function normalizeFlapQuoteFirstThreeState(value = {}) {
  const baseline = emptyFlapQuoteFirstThreeState();
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1
    || !value.windows || typeof value.windows !== "object" || Array.isArray(value.windows)
    || !value.activeByQuote || typeof value.activeByQuote !== "object" || Array.isArray(value.activeByQuote)
    || !value.lifecycleEvents || typeof value.lifecycleEvents !== "object" || Array.isArray(value.lifecycleEvents)) {
    throw new Error("invalid durable Flap first-three state shape");
  }
  const rawWindowEntries = Object.entries(value.windows);
  const windows = {};
  for (const [storedKey, raw] of rawWindowEntries) {
    const quoteAddress = String(raw?.quoteAddress || "").toLowerCase();
    const quoteName = normalizeOfficialText(raw?.quoteName || "");
    const quoteSymbol = normalizeOfficialText(raw?.quoteSymbol || "");
    const activationEventKey = typeof raw?.activationEventKey === "string" ? raw.activationEventKey.trim() : "";
    const activationTransactionHash = normalizeTransactionHash(raw?.activationTransactionHash);
    const activationBlockHash = normalizeTransactionHash(raw?.activationBlockHash);
    const activationBlockNumber = Number(raw?.activationBlockNumber);
    const activationTransactionIndex = Number(raw?.activationTransactionIndex);
    const activationLogIndex = Number(raw?.activationLogIndex);
    const activatedAtMs = Date.parse(raw?.activatedAt || "");
    const generationKey = flapQuoteFirstThreeGenerationKey({
      quoteAddress,
      blockHash: activationBlockHash,
      transactionHash: activationTransactionHash,
      logIndex: activationLogIndex,
    });
    if (!ADDRESS.test(quoteAddress)
      || !activationEventKey || activationEventKey.length > 512
      || activationEventKey !== `flap-quote:${BSC_CHAIN_ID}:${activationTransactionHash}:${activationLogIndex}`
      || !/^0x[0-9a-f]{64}$/.test(activationTransactionHash)
      || !/^0x[0-9a-f]{64}$/.test(activationBlockHash)
      || !Number.isSafeInteger(activationBlockNumber) || activationBlockNumber < 0
      || !Number.isSafeInteger(activationTransactionIndex) || activationTransactionIndex < 0
      || !Number.isSafeInteger(activationLogIndex) || activationLogIndex < 0
      || !Number.isFinite(activatedAtMs)
      || !quoteName || quoteName.length > 256
      || !quoteSymbol || quoteSymbol.length > 24
      || storedKey !== generationKey
      || raw?.proofType !== "verified_zero_to_one") continue;
    const slots = [];
    const seenTokens = new Set();
    const rawSlots = Array.isArray(raw?.slots) ? raw.slots : [];
    const slotKeys = new Set([
      "ordinal", "candidateKey", "tokenAddress", "transactionHash", "blockNumber", "blockHash",
      "transactionIndex", "logIndex", "blockTimestamp", "firstObservedAt", "confirmations",
      "requiredConfirmations", "pairAddress", "pairKind", "pool", "metadata", "security", "replay",
      "reservedAt", "deliveryStatus", "deliveryAcceptedAt", "deliveryEventId", "lastDeliveryRejectedAt",
      "lastDeliveryResult", "canonicalRevision", "eventKey", "event",
    ]);
    for (const item of rawSlots) {
      const ordinal = Number(item?.ordinal);
      const tokenAddress = String(item?.tokenAddress || "").toLowerCase();
      const transactionHash = normalizeTransactionHash(item?.transactionHash);
      const blockHash = normalizeTransactionHash(item?.blockHash);
      const blockNumber = Number(item?.blockNumber);
      const transactionIndex = Number(item?.transactionIndex);
      const logIndex = Number(item?.logIndex);
      const pairAddress = String(item?.pairAddress || "").toLowerCase();
      const candidateKey = flapCreationCandidateKey({ transactionHash, logIndex, token: tokenAddress });
      const pool = item?.pool;
      const poolFactory = String(pool?.factory || "").toLowerCase();
      const dex = BSC_DEX_CONTRACTS.get(poolFactory);
      const poolToken0 = String(pool?.token0 || "").toLowerCase();
      const poolToken1 = String(pool?.token1 || "").toLowerCase();
      const event = item?.event;
      const ordinaryEventKey = `bsc-flap-pool-token:${generationKey}:${ordinal}:${candidateKey}`;
      const expectedEventKey = item?.canonicalRevision
        ? `${ordinaryEventKey}:canonical-revision:${blockHash}` : ordinaryEventKey;
      const acceptedDelivery = exactFlapQuoteFirstThreeIso(item?.deliveryAcceptedAt);
      const pendingDelivery = item?.deliveryAcceptedAt === null && item?.deliveryStatus === "pending";
      const rejectedAtPresent = Object.hasOwn(item || {}, "lastDeliveryRejectedAt");
      const rejectedResultPresent = Object.hasOwn(item || {}, "lastDeliveryResult");
      const rejection = item?.lastDeliveryResult;
      if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > FLAP_QUOTE_FIRST_THREE_TARGET
        || !item || typeof item !== "object" || Array.isArray(item)
        || Object.keys(item).some((key) => !slotKeys.has(key))
        || !ADDRESS.test(tokenAddress) || seenTokens.has(tokenAddress)
        || !/^0x[0-9a-f]{64}$/.test(transactionHash)
        || !/^0x[0-9a-f]{64}$/.test(blockHash)
        || !Number.isSafeInteger(blockNumber) || blockNumber < 0
        || !Number.isSafeInteger(transactionIndex) || transactionIndex < 0
        || !Number.isSafeInteger(logIndex) || logIndex < 0
        || !exactFlapQuoteFirstThreeIso(item?.blockTimestamp)
        || !exactFlapQuoteFirstThreeIso(item?.firstObservedAt)
        || !exactFlapQuoteFirstThreeIso(item?.reservedAt)
        || !Number.isSafeInteger(item?.confirmations) || item.confirmations < 0
        || !Number.isSafeInteger(item?.requiredConfirmations) || item.requiredConfirmations < 0
        || item.confirmations < item.requiredConfirmations
        || typeof item?.replay !== "boolean"
        || !ADDRESS.test(pairAddress)
        || !dex || !FLAP_QUOTE_FIRST_THREE_PAIR_FACTORIES.has(poolFactory)
        || pool?.kind !== dex.kind || item?.pairKind !== dex.kind
        || pool?.factory !== poolFactory
        || pool?.pool !== pairAddress
        || pool?.verifiedDex !== true
        || pool?.poolId !== null || pool?.hook !== null
        || !((poolToken0 === tokenAddress && poolToken1 === quoteAddress)
          || (poolToken1 === tokenAddress && poolToken0 === quoteAddress))
        || item?.candidateKey !== candidateKey
        || item?.eventKey !== expectedEventKey
        || (!acceptedDelivery && !pendingDelivery)
        || (acceptedDelivery && !["delivered", "queued", "suppressed"].includes(item.deliveryStatus))
        || (acceptedDelivery && (typeof item?.deliveryEventId !== "string" || !item.deliveryEventId
          || item.deliveryEventId.length > 512 || rejectedAtPresent || rejectedResultPresent))
        || (pendingDelivery && Object.hasOwn(item, "deliveryEventId"))
        || (rejectedAtPresent !== rejectedResultPresent)
        || (rejectedAtPresent && (!exactFlapQuoteFirstThreeIso(item.lastDeliveryRejectedAt)
          || !rejection || typeof rejection !== "object" || Array.isArray(rejection)
          || !sameFlapQuoteFirstThreeValue(Object.keys(rejection).sort(), ["reason", "status", "terminal"])
          || (rejection.status !== null && typeof rejection.status !== "string")
          || (rejection.reason !== null && typeof rejection.reason !== "string")
          || typeof rejection.terminal !== "boolean"))
        || !isStrictFlapTrackedPoolTokenUpdate(event)
        || event.eventKey !== item.eventKey
        || event.featureActivationKey !== generationKey
        || event.featureGenerationKey !== generationKey
        || event.featureTokenOrdinal !== ordinal
        || event.transactionHash !== transactionHash
        || event.blockNumber !== blockNumber
        || event.blockHash !== blockHash
        || event.transactionIndex !== transactionIndex
        || event.logIndex !== logIndex
        || event.blockTimestamp !== item.blockTimestamp
        || event.observedAt !== item.reservedAt
        || event.mode?.quoteAsset !== quoteAddress
        || event.mode?.quoteName !== quoteName
        || event.mode?.quoteSymbol !== quoteSymbol
        || event.featureTokenProof?.activationEventKey !== activationEventKey
        || event.featureTokenProof?.confirmations !== item.confirmations
        || event.featureTokenProof?.requiredConfirmations !== item.requiredConfirmations
        || event.featureTokenProof?.pairAddress !== pairAddress
        || event.featureTokenProof?.pairKind !== item.pairKind
        || event.tokens?.[0]?.token !== tokenAddress
        || !sameFlapQuoteFirstThreeValue(event.tokens?.[0]?.metadata, item.metadata)
        || !sameFlapQuoteFirstThreeValue(event.pools?.[0], pool)
        || !sameFlapQuoteFirstThreeValue(event.security, item.security)
        || !sameFlapQuoteFirstThreeValue(event.canonicalRevision, item.canonicalRevision)) continue;
      seenTokens.add(tokenAddress);
      slots.push({
        ...item,
        ordinal,
        tokenAddress,
        transactionHash,
        blockHash,
        blockNumber,
        transactionIndex,
        logIndex,
        pairAddress,
        candidateKey,
      });
    }
    if (slots.length !== rawSlots.length) {
      throw new Error(`invalid durable Flap first-three slots ${storedKey}`);
    }
    slots.sort((left, right) => left.ordinal - right.ordinal);
    const activationPosition = {
      blockNumber: activationBlockNumber,
      transactionIndex: activationTransactionIndex,
      logIndex: activationLogIndex,
      transactionHash: activationTransactionHash,
      tokenAddress: "0x0000000000000000000000000000000000000000",
    };
    if (slots.some((slot, index) => slot.ordinal !== index + 1
      || compareFlapQuoteTokenCandidates(slot, index === 0 ? activationPosition : slots[index - 1]) <= 0)) {
      throw new Error(`invalid durable Flap first-three canonical slot order ${storedKey}`);
    }
    const trackingComplete = raw?.trackingCompletedAt !== null
      && raw?.trackingCompletedAt !== undefined;
    const replayComplete = raw?.replayCompletedAt !== null
      && raw?.replayCompletedAt !== undefined;
    const hasReplayNextBlock = raw?.archiveReplayNextBlock !== null
      && raw?.archiveReplayNextBlock !== undefined;
    const hasReplayTargetBlock = raw?.archiveReplayTargetBlock !== null
      && raw?.archiveReplayTargetBlock !== undefined;
    const replayNextBlock = Number(raw?.archiveReplayNextBlock);
    const replayTargetBlock = Number(raw?.archiveReplayTargetBlock);
    const allTargetsAccepted = slots.length === FLAP_QUOTE_FIRST_THREE_TARGET
      && slots.every((slot) => exactFlapQuoteFirstThreeIso(slot.deliveryAcceptedAt));
    if ((trackingComplete && (!exactFlapQuoteFirstThreeIso(raw.trackingCompletedAt) || !allTargetsAccepted))
      || (!trackingComplete && allTargetsAccepted)
      || (replayComplete && !exactFlapQuoteFirstThreeIso(raw.replayCompletedAt))
      || (hasReplayNextBlock && (!Number.isSafeInteger(replayNextBlock)
        || replayNextBlock < activationBlockNumber))
      || (hasReplayTargetBlock && (!Number.isSafeInteger(replayTargetBlock)
        || replayTargetBlock < activationBlockNumber))
      || (hasReplayTargetBlock && !hasReplayNextBlock)
      || (hasReplayNextBlock && hasReplayTargetBlock && replayNextBlock > replayTargetBlock + 1)
      || (replayComplete && (!hasReplayNextBlock || !hasReplayTargetBlock
        || replayNextBlock !== replayTargetBlock + 1))) {
      throw new Error(`invalid durable Flap first-three completion state ${storedKey}`);
    }
    windows[generationKey] = {
      ...raw,
      generationKey,
      activationId: generationKey,
      quoteAddress,
      quoteName,
      quoteSymbol,
      activationEventKey,
      activationTransactionHash,
      activationBlockHash,
      activationBlockNumber,
      activationTransactionIndex,
      activationLogIndex,
      activatedAt: new Date(activatedAtMs).toISOString(),
      proofType: "verified_zero_to_one",
      targetCount: FLAP_QUOTE_FIRST_THREE_TARGET,
      monitorOnly: true,
      active: raw.active === true,
      status: raw.active === true
        ? "active"
        : raw.status === "canonical_replaced" ? "canonical_replaced" : "disabled",
      slots,
      replayAttemptedCandidateKeys: [...new Set((Array.isArray(raw.replayAttemptedCandidateKeys)
        ? raw.replayAttemptedCandidateKeys : [])
        .filter((item) => typeof item === "string" && item.length <= 180))]
        .slice(-FLAP_CREATION_HOT_INDEX_MAX),
    };
  }
  if (Object.keys(windows).length !== rawWindowEntries.length) {
    throw new Error("invalid durable Flap first-three window proof");
  }
  const activeByQuote = {};
  for (const [quoteAddress, generationKey] of Object.entries(value.activeByQuote || {})) {
    const normalizedQuote = String(quoteAddress || "").toLowerCase();
    const window = windows[generationKey];
    if (ADDRESS.test(normalizedQuote)
      && window?.active === true
      && window.quoteAddress === normalizedQuote) activeByQuote[normalizedQuote] = generationKey;
  }
  if (Object.keys(activeByQuote).length !== Object.keys(value.activeByQuote).length
    || Object.values(windows).some((window) => window.active === true
      && activeByQuote[window.quoteAddress] !== window.generationKey)) {
    throw new Error("invalid durable Flap first-three active generation index");
  }
  const lifecycleEvents = {};
  const rawLifecycleEntries = Object.entries(value.lifecycleEvents);
  if (rawLifecycleEntries.length > FLAP_QUOTE_FIRST_THREE_LIFECYCLE_MAX) {
    throw new Error("durable Flap first-three lifecycle bound exceeded");
  }
  for (const [eventKey, item] of rawLifecycleEntries) {
    const quoteAddress = String(item?.quoteAddress || "").toLowerCase();
    const generationKey = item?.generationKey === null ? null : String(item?.generationKey || "");
    const transactionHash = normalizeTransactionHash(item?.transactionHash);
    const blockNumber = Number(item?.blockNumber);
    const blockHash = normalizeTransactionHash(item?.blockHash);
    const transactionIndex = Number(item?.transactionIndex);
    const logIndex = Number(item?.logIndex);
    const occurredAtMs = Date.parse(item?.occurredAt || "");
    const requiredConfirmations = Number(item?.requiredConfirmations);
    const lifecycleWindow = generationKey === null ? null : windows[generationKey];
    const derivedGenerationKey = flapQuoteFirstThreeGenerationKey({
      quoteAddress,
      blockHash,
      transactionHash,
      logIndex,
    });
    const expectedProofType = item?.action === "activated"
      ? "verified_zero_to_one"
      : item?.action === "disabled" ? "verified_disable" : "verified_disable_orphaned";
    if (!eventKey || eventKey.length > 512
      || !["activated", "disabled", "restored"].includes(item?.action)
      || !ADDRESS.test(quoteAddress)
      || eventKey !== `flap-quote:${BSC_CHAIN_ID}:${transactionHash}:${logIndex}`
      || !normalizeOfficialText(item?.quoteName || "")
      || !normalizeOfficialText(item?.quoteSymbol || "")
      || (generationKey !== null && (!windows[generationKey]
        || windows[generationKey].quoteAddress !== quoteAddress))
      || (generationKey === null && item?.action !== "disabled")
      || !/^0x[0-9a-f]{64}$/.test(blockHash)
      || !/^0x[0-9a-f]{64}$/.test(transactionHash)
      || !Number.isSafeInteger(blockNumber) || blockNumber < 0
      || !Number.isSafeInteger(transactionIndex) || transactionIndex < 0
      || !Number.isSafeInteger(logIndex) || logIndex < 0
      || !Number.isFinite(occurredAtMs)
      || item?.proofType !== expectedProofType
      || !Number.isSafeInteger(requiredConfirmations) || requiredConfirmations < 0
      || (item?.action === "restored" && !item?.targetActivationEventKey)
      || (item?.action === "activated" && (generationKey !== derivedGenerationKey
        || lifecycleWindow?.activationEventKey !== eventKey
        || lifecycleWindow?.activationTransactionHash !== transactionHash
        || lifecycleWindow?.activationBlockNumber !== blockNumber
        || lifecycleWindow?.activationBlockHash !== blockHash
        || lifecycleWindow?.activationTransactionIndex !== transactionIndex
        || lifecycleWindow?.activationLogIndex !== logIndex
        || lifecycleWindow?.activatedAt !== new Date(occurredAtMs).toISOString()
        || lifecycleWindow?.requiredActivationConfirmations !== requiredConfirmations
        || lifecycleWindow?.quoteName !== normalizeOfficialText(item.quoteName)
        || lifecycleWindow?.quoteSymbol !== normalizeOfficialText(item.quoteSymbol)))
      || (item?.action === "restored" && generationKey !== null
        && item.targetActivationEventKey !== lifecycleWindow?.activationEventKey)
      || (["disabled", "restored"].includes(item?.action) && generationKey !== null
        && lifecycleWindow?.disableEventKey === eventKey
        && (lifecycleWindow.disableTransactionHash !== transactionHash
          || lifecycleWindow.disableBlockNumber !== blockNumber
          || lifecycleWindow.disableBlockHash !== blockHash
          || lifecycleWindow.disableTransactionIndex !== transactionIndex
          || lifecycleWindow.disableLogIndex !== logIndex))) continue;
    lifecycleEvents[eventKey] = {
      ...item,
      quoteAddress,
      generationKey,
      quoteName: normalizeOfficialText(item.quoteName),
      quoteSymbol: normalizeOfficialText(item.quoteSymbol),
      blockNumber,
      blockHash,
      transactionHash,
      transactionIndex,
      logIndex,
      occurredAt: new Date(occurredAtMs).toISOString(),
      proofType: expectedProofType,
      requiredConfirmations,
    };
  }
  if (Object.keys(lifecycleEvents).length !== rawLifecycleEntries.length) {
    throw new Error("invalid durable Flap first-three lifecycle proof");
  }
  return { version: 1, windows, activeByQuote, lifecycleEvents };
}

function normalizeFlapCreationHotIndex(entries = [], current = null) {
  const cutoff = current !== null && current !== undefined && Number.isFinite(Number(current))
    ? Number(current) - FLAP_CREATION_HOT_INDEX_TTL_MS
    : null;
  const expectedEmitters = new Map([
    [FLAP_TOKEN_CREATED_TOPIC, FLAP_PORTAL_ADDRESS],
    [FLAP_VAULT_TOKEN_CREATED_TOPIC, FLAP_VAULT_PORTAL_ADDRESS],
  ]);
  const normalized = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const launcher = String(entry?.launcher || "").toLowerCase();
    const token = String(entry?.token || "").toLowerCase();
    const transactionHash = normalizeTransactionHash(entry?.transactionHash);
    const blockHash = normalizeTransactionHash(entry?.blockHash);
    const blockNumber = Number(entry?.blockNumber);
    const transactionIndex = Number(entry?.transactionIndex || 0);
    const logIndex = Number(entry?.logIndex || 0);
    const topic = String(entry?.topic || "").toLowerCase();
    const observedMs = Date.parse(entry?.observedAt || entry?.indexedAt || "");
    const indexedMs = Date.parse(entry?.indexedAt || entry?.observedAt || "");
    const vaultFactory = String(entry?.vaultFactory || "").toLowerCase();
    const confirmations = Number(entry?.confirmations);
    const requiredConfirmations = Number(entry?.requiredConfirmations);
    if (!expectedEmitters.has(topic)
      || launcher !== expectedEmitters.get(topic)
      || !ADDRESS.test(token)
      || !/^0x[0-9a-f]{64}$/.test(transactionHash)
      || !Number.isSafeInteger(blockNumber)
      || blockNumber < 0
      || !Number.isSafeInteger(transactionIndex)
      || transactionIndex < 0
      || !Number.isSafeInteger(logIndex)
      || logIndex < 0
      || !Number.isFinite(observedMs)
      || !Number.isFinite(indexedMs)
      || (cutoff !== null && indexedMs < cutoff)
      || (topic === FLAP_VAULT_TOKEN_CREATED_TOPIC && !ADDRESS.test(vaultFactory))) continue;
    const quoteAssets = [...new Set((Array.isArray(entry?.quoteAssets) ? entry.quoteAssets : [])
      .map((address) => String(address || "").toLowerCase())
      .filter((address) => ADDRESS.test(address) && address !== token))]
      .sort()
      .slice(0, 16);
    const candidate = {
      launcher,
      token,
      transactionHash,
      blockHash: /^0x[0-9a-f]{64}$/.test(blockHash) ? blockHash : null,
      blockNumber,
      transactionIndex,
      logIndex,
      topic,
      observedAt: new Date(observedMs).toISOString(),
      indexedAt: new Date(indexedMs).toISOString(),
      confirmations: Number.isSafeInteger(confirmations) && confirmations >= 0 ? confirmations : null,
      requiredConfirmations: Number.isSafeInteger(requiredConfirmations) && requiredConfirmations >= 0
        ? requiredConfirmations : null,
      vaultFactory: topic === FLAP_VAULT_TOKEN_CREATED_TOPIC ? vaultFactory : null,
      quoteAssets: topic === FLAP_TOKEN_CREATED_TOPIC ? quoteAssets : [],
    };
    const key = flapCreationCandidateKey(candidate);
    const previous = normalized.get(key);
    normalized.set(key, previous ? {
      ...previous,
      ...candidate,
      blockHash: candidate.blockHash || previous.blockHash,
      observedAt: new Date(Math.min(Date.parse(previous.observedAt), Date.parse(candidate.observedAt))).toISOString(),
      indexedAt: new Date(Math.max(Date.parse(previous.indexedAt), Date.parse(candidate.indexedAt))).toISOString(),
      confirmations: Math.max(Number(previous.confirmations ?? -1), Number(candidate.confirmations ?? -1)) >= 0
        ? Math.max(Number(previous.confirmations ?? -1), Number(candidate.confirmations ?? -1))
        : null,
      requiredConfirmations: Math.max(Number(previous.requiredConfirmations ?? -1), Number(candidate.requiredConfirmations ?? -1)) >= 0
        ? Math.max(Number(previous.requiredConfirmations ?? -1), Number(candidate.requiredConfirmations ?? -1))
        : null,
      vaultFactory: candidate.vaultFactory || previous.vaultFactory,
      quoteAssets: [...new Set([...(previous.quoteAssets || []), ...(candidate.quoteAssets || [])])].sort().slice(0, 16),
    } : candidate);
  }
  return [...normalized.values()]
    .sort((left, right) => left.blockNumber - right.blockNumber
      || left.transactionIndex - right.transactionIndex
      || left.logIndex - right.logIndex
      || left.transactionHash.localeCompare(right.transactionHash))
    .slice(-FLAP_CREATION_HOT_INDEX_MAX);
}

export function parseFlapCreationHotCandidates(logs = [], details = {}) {
  const numeric = (value, fallback = 0) => {
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value, 16);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const pools = Array.isArray(details.pools) ? details.pools : parseBscPoolLogs(logs);
  const observedAt = details.observedAt || iso(details.current ?? Date.now());
  const indexedAt = details.indexedAt || iso(details.current ?? Date.now());
  const entries = [];
  for (let position = 0; position < logs.length; position += 1) {
    const log = logs[position];
    const topic = String(log?.topics?.[0] || "").toLowerCase();
    const launcher = String(log?.address || "").toLowerCase();
    if ((topic === FLAP_TOKEN_CREATED_TOPIC && launcher !== FLAP_PORTAL_ADDRESS)
      || (topic === FLAP_VAULT_TOKEN_CREATED_TOPIC && launcher !== FLAP_VAULT_PORTAL_ADDRESS)
      || ![FLAP_TOKEN_CREATED_TOPIC, FLAP_VAULT_TOKEN_CREATED_TOPIC].includes(topic)) continue;
    const evidence = parseKnownBscLaunchEvidence([log])[0];
    if (!evidence || String(evidence.topic || "").toLowerCase() !== topic
      || String(evidence.emitter || "").toLowerCase() !== launcher) continue;
    const token = String(evidence.token || "").toLowerCase();
    const quoteAssets = pools.flatMap((pool) => {
      const token0 = String(pool?.token0 || "").toLowerCase();
      const token1 = String(pool?.token1 || "").toLowerCase();
      if (token0 === token && ADDRESS.test(token1)) return [token1];
      if (token1 === token && ADDRESS.test(token0)) return [token0];
      return [];
    });
    entries.push({
      launcher,
      token,
      transactionHash: log.transactionHash || details.transactionHash,
      blockHash: log.blockHash || details.blockHash || null,
      blockNumber: numeric(log.blockNumber, numeric(details.blockNumber, -1)),
      transactionIndex: numeric(log.transactionIndex, numeric(details.transactionIndex, 0)),
      logIndex: numeric(log.logIndex ?? log.index, numeric(details.logIndex, position)),
      topic,
      observedAt,
      indexedAt,
      confirmations: details.confirmations ?? null,
      requiredConfirmations: details.requiredConfirmations ?? null,
      vaultFactory: evidence.vaultFactory || null,
      quoteAssets,
    });
  }
  return normalizeFlapCreationHotIndex(entries, details.current ?? null);
}

function normalizeFourMemeCreationHotIndex(entries = [], current = null) {
  const cutoff = Number.isFinite(Number(current))
    ? Number(current) - FOUR_MEME_CREATION_HOT_INDEX_TTL_MS
    : null;
  const normalized = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const launcher = String(entry?.launcher || "").toLowerCase();
    const token = String(entry?.token || "").toLowerCase();
    const transactionHash = normalizeTransactionHash(entry?.transactionHash);
    const blockNumber = Number(entry?.blockNumber);
    const transactionIndex = Number(entry?.transactionIndex || 0);
    const logIndex = Number(entry?.logIndex || 0);
    const topic = String(entry?.topic || "").toLowerCase();
    const observedMs = Date.parse(entry?.observedAt || entry?.indexedAt || "");
    const indexedMs = Date.parse(entry?.indexedAt || entry?.observedAt || "");
    if (!ADDRESS.test(launcher)
      || !ADDRESS.test(token)
      || !/^0x[0-9a-f]{64}$/.test(transactionHash)
      || !Number.isSafeInteger(blockNumber)
      || blockNumber < 0
      || !Number.isSafeInteger(transactionIndex)
      || transactionIndex < 0
      || !Number.isSafeInteger(logIndex)
      || logIndex < 0
      || ![FOUR_MEME_TOKEN_CREATE_TOPIC, FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC, OPENFOUR_TOKEN_CREATED_TOPIC].includes(topic)
      || !Number.isFinite(observedMs)
      || !Number.isFinite(indexedMs)
      || (cutoff !== null && indexedMs < cutoff)) continue;
    const candidate = {
      launcher,
      token,
      transactionHash,
      blockNumber,
      transactionIndex,
      logIndex,
      topic,
      observedAt: new Date(observedMs).toISOString(),
      indexedAt: new Date(indexedMs).toISOString(),
      presetId: entry?.presetId === null || entry?.presetId === undefined ? null : String(entry.presetId),
      quoteAsset: ADDRESS.test(String(entry?.quoteAsset || "").toLowerCase())
        ? String(entry.quoteAsset).toLowerCase()
        : null,
    };
    const key = fourMemeCreationCandidateKey(candidate);
    const previous = normalized.get(key);
    normalized.set(key, previous ? {
      ...previous,
      ...candidate,
      observedAt: new Date(Math.min(Date.parse(previous.observedAt), Date.parse(candidate.observedAt))).toISOString(),
      indexedAt: new Date(Math.max(Date.parse(previous.indexedAt), Date.parse(candidate.indexedAt))).toISOString(),
      presetId: candidate.presetId ?? previous.presetId,
      quoteAsset: candidate.quoteAsset || previous.quoteAsset,
    } : candidate);
  }
  return [...normalized.values()]
    .sort((left, right) => left.blockNumber - right.blockNumber
      || left.transactionIndex - right.transactionIndex
      || left.logIndex - right.logIndex
      || left.transactionHash.localeCompare(right.transactionHash))
    .slice(-FOUR_MEME_CREATION_HOT_INDEX_MAX);
}

function readBscTransactionCreationEvidence(value, transactionHash, label, normalize) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > BSC_TRANSACTION_CREATION_EVIDENCE_MAX) {
    throw new Error(`${label} creation evidence is not a bounded array`);
  }
  const normalizedHash = normalizeTransactionHash(transactionHash);
  const normalized = normalize(value, null);
  if (normalized.length !== value.length
    || normalized.some((candidate) => candidate.transactionHash !== normalizedHash)
    || JSON.stringify(normalized) !== JSON.stringify(value)) {
    throw new Error(`${label} creation evidence is not canonical`);
  }
  return normalized;
}

function normalizeBscTransactionCreationEvidence(values, transactionHash, label, normalize) {
  const normalizedHash = normalizeTransactionHash(transactionHash);
  const normalized = normalize(Array.isArray(values) ? values : [], null);
  if (normalized.some((candidate) => candidate.transactionHash !== normalizedHash)
    || normalized.length > BSC_TRANSACTION_CREATION_EVIDENCE_MAX) {
    const error = new Error(`${label} transaction creation evidence capacity exceeded`);
    error.code = "BSC_TRANSACTION_CREATION_EVIDENCE_INVALID";
    throw error;
  }
  return normalized;
}

function normalizeNearHeadRecoveryGaps(gaps = []) {
  const normalized = [];
  const seenIds = new Set();
  for (const gap of Array.isArray(gaps) ? gaps : []) {
    const fromBlock = Number(gap?.fromBlock);
    const toBlock = Number(gap?.toBlock);
    const nextBlock = Math.max(fromBlock, Number(gap?.nextBlock ?? fromBlock));
    if (!Number.isSafeInteger(fromBlock)
      || !Number.isSafeInteger(toBlock)
      || !Number.isSafeInteger(nextBlock)
      || fromBlock < 0
      || toBlock < fromBlock
      || nextBlock > toBlock) continue;
    const baseId = typeof gap.id === "string" && gap.id
      ? gap.id
      : `realtime-tail-gap:${fromBlock}:${toBlock}`;
    let id = baseId;
    let suffix = 1;
    while (seenIds.has(id)) id = `${baseId}:${suffix++}`;
    seenIds.add(id);
    const nextAttemptAt = typeof gap.nextAttemptAt === "string" && gap.nextAttemptAt.trim()
      ? Date.parse(gap.nextAttemptAt)
      : Number.NaN;
    const attempts = Number(gap.attempts || 0);
    normalized.push({
      ...gap,
      id,
      fromBlock,
      toBlock,
      nextBlock,
      attempts: Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0,
      nextAttemptAt: Number.isFinite(nextAttemptAt) && nextAttemptAt > 0 ? new Date(nextAttemptAt).toISOString() : null,
    });
  }
  return normalized.sort((left, right) => right.toBlock - left.toBlock || left.nextBlock - right.nextBlock || left.id.localeCompare(right.id));
}

function isPristineNearHeadRecoveryGap(gap) {
  return Number(gap?.nextBlock) === Number(gap?.fromBlock)
    && Number(gap?.attempts || 0) === 0
    && !gap?.nextAttemptAt
    && !gap?.lastAttemptAt
    && !gap?.lastSuccessAt
    && !gap?.lastErrorAt
    && !gap?.lastError;
}

export function compactBscNearHeadRecoveryGaps(gaps = [], segmentSize = 2_000) {
  const boundedSegmentSize = Math.max(1, Math.floor(Number(segmentSize) || 1));
  const normalized = normalizeNearHeadRecoveryGaps(gaps);
  const pristine = normalized
    .filter(isPristineNearHeadRecoveryGap)
    .sort((left, right) => left.fromBlock - right.fromBlock || left.toBlock - right.toBlock);
  const retained = normalized.filter((gap) => !isPristineNearHeadRecoveryGap(gap));
  const merged = [];
  for (const gap of pristine) {
    const previous = merged.at(-1);
    const sameReason = String(previous?.reason || "") === String(gap.reason || "");
    const combinedSize = previous ? gap.toBlock - previous.fromBlock + 1 : Number.POSITIVE_INFINITY;
    if (previous && sameReason && gap.fromBlock <= previous.toBlock + 1 && combinedSize <= boundedSegmentSize) {
      previous.toBlock = Math.max(previous.toBlock, gap.toBlock);
      const detected = [Date.parse(previous.detectedAt || ""), Date.parse(gap.detectedAt || "")]
        .filter(Number.isFinite);
      previous.detectedAt = detected.length ? new Date(Math.min(...detected)).toISOString() : previous.detectedAt || gap.detectedAt;
      previous.id = `realtime-tail-gap:${previous.fromBlock}:${previous.toBlock}`;
      continue;
    }
    merged.push({
      ...gap,
      nextBlock: gap.fromBlock,
      attempts: 0,
      nextAttemptAt: null,
    });
  }
  // Never compact an attempted/partially-scanned gap: its identity and retry
  // metadata are an active cursor. Pristine adjacency alone is rewritten, so
  // the represented pending block union is byte-for-byte equivalent.
  return normalizeNearHeadRecoveryGaps([...retained, ...merged]);
}

function emptyState() {
  return {
    version: STATE_VERSION,
    journalRevision: 0,
    initializedAt: null,
    lastFinalizedBlock: null,
    realtimeTailNextBlock: null,
    realtimeTailInitializedAt: null,
    alertSuppressedThroughBlock: null,
    migrationReplayTransactions: [],
    deferredCreationEvidence: {},
    realtimePendingEntries: {},
    launchers: {},
    hooks: {},
    officialChildren: {},
    singularryCurves: {},
    officialUpgrades: {},
    officialLifecycleEvents: {},
    seenTransactions: {},
    transactionFailures: {},
    nearHeadRecoveryGaps: [],
    coverageGaps: [],
    coverageRecoveryHistory: [],
    coverageContinuity: null,
    officialSources: {
      flap: {
        pools: {},
        featureActivations: {},
        replayControl: {
          status: "idle",
          consecutiveFailures: 0,
          nextRetryAt: null,
        },
        creationEventHotIndex: [],
        quotePoolFirstThree: emptyFlapQuoteFirstThreeState(),
        platformActivationAuditEvents: [],
        initializedAt: null,
        lastSuccessAt: null,
        lastError: null,
      },
      fourMeme: {
        roots: {},
        rootFingerprint: null,
        templates: {},
        quoteConfigs: {},
        quoteBaselineInitialized: false,
        pendingRoots: null,
        pendingTemplates: {},
        pendingQuoteConfigs: {},
        featureActivations: {},
        creationEventHotIndex: [],
        platformActivationAuditEvents: [],
        initializedAt: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastErrorAt: null,
        lastError: null,
        consecutiveFailures: 0,
        sourceCircuits: {},
      },
      agentLaunch: {
        deployer: null,
        pending: null,
        initializedAt: null,
        lastSuccessAt: null,
        lastError: null,
      },
      waifu: {
        launches: {},
        alertedModeFingerprints: [],
        initializedAt: null,
        lastSuccessAt: null,
        lastError: null,
      },
      rugspull: {
        children: {},
        initializedAt: null,
        lastSuccessAt: null,
        lastError: null,
      },
      singularry: {
        tokens: {},
        initializedAt: null,
        lastSuccessAt: null,
        lastErrorAt: null,
        lastError: null,
      },
    },
    discoverySources: {
      dappBay: { contracts: {}, lastAttemptAt: null, lastSuccessAt: null, lastError: null },
      external: { contracts: {} },
    },
    _health: {
      websocket: { status: "unknown", consecutiveFailures: 0 },
      rpc: { status: "unknown", consecutiveFailures: 0 },
      realtimeTail: { status: "unknown", consecutiveFailures: 0 },
      realtimeQueue: { status: "unknown", consecutiveFailures: 0 },
      nearHeadRecovery: { status: "unknown", consecutiveFailures: 0 },
      coverage: {
        status: "unknown",
        headBlock: null,
        confirmedHeadBlock: null,
        coveredBlock: null,
        realtimeTailCoveredBlock: null,
        lagBlocks: null,
        lagSeconds: null,
        unresolvedGapCount: 0,
        nearHeadRecoveryGapCount: 0,
        nearHeadRecoveryBlockCount: 0,
        deferredTransactionCount: 0,
        oldestUnresolvedBlock: null,
      },
    },
  };
}

async function readState(file, metadata = null) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (metadata) {
      metadata.exists = true;
      metadata.legacyJournal = !Object.hasOwn(parsed, "journalRevision");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid BSC state document");
    if (Object.hasOwn(parsed, "journalRevision")
      && (!Number.isSafeInteger(parsed.journalRevision) || parsed.journalRevision < 0)) {
      throw new Error("invalid BSC snapshot journalRevision");
    }
    const parsedVersion = parsed.version ?? 0;
    if (!Number.isInteger(parsedVersion) || parsedVersion < 0) throw new Error(`invalid BSC state version ${parsedVersion}`);
    if (parsedVersion > STATE_VERSION) throw new Error(`BSC state version ${parsedVersion} is newer than supported version ${STATE_VERSION}`);
    const baseline = emptyState();
    const parsedCoverageGaps = parsed.coverageGaps || [];
    const gapBlocks = parsedCoverageGaps.map((gap) => Number(gap.fromBlock)).filter(Number.isFinite);
    const hasCreationEvidenceGap = parsedCoverageGaps.some((gap) => /BscScan (?:contract creation (?:evidence missing|HTTP)|creation evidence unavailable)/i.test(gap?.error || ""));
    const replayReasons = [];
    let replayFromBlock = null;
    if (parsedVersion === 3 && parsedCoverageGaps.length) {
      replayFromBlock = Math.min(V3_RECONCILIATION_REPLAY_FLOOR, ...gapBlocks);
      replayReasons.push("v4_reconcile_v3_rpc_gaps");
    }
    const migratedLaunchers = Object.fromEntries(Object.entries(parsed.launchers || {}).map(([address, launcher]) => [address, parsedVersion < 5 ? {
      ...launcher,
      // v4 fingerprints included buy/progress/tax events and unverified pool
      // topics. Keep discovery history, but relearn stable creation modes.
      modes: {},
      baselineModeFingerprint: null,
      alertedModes: [],
      structuralEligible: false,
      legacyDiscoveryAlerted: !launcher.platform && launcher.discoveryAlerted === true
        ? true
        : Boolean(launcher.legacyDiscoveryAlerted),
      discoveryAlerted: launcher.platform ? launcher.discoveryAlerted === true : false,
    } : launcher]));
    for (const [address, launcher] of Object.entries(migratedLaunchers)) {
      const catalogPlatform = platformForAddress(address);
      if (catalogPlatform && !launcher.platform) launcher.platform = publicPlatform(catalogPlatform);
    }
    const targetedReplay = new Map();
    if (parsedVersion === 4) {
      for (const launcher of Object.values(parsed.launchers || {})) {
        // Rebuild both anonymous and known launchers. v4 mode fingerprints
        // included lifecycle noise, so keeping only anonymous transactions
        // would make the first post-restart launch on an official platform its
        // new (and potentially novel) silent baseline.
        for (const [token, record] of Object.entries(launcher.tokens || {})) {
          const transactionHash = String(record?.transactionHash || "").toLowerCase();
          const blockNumber = Number(record?.firstSeenBlock || record?.lastSeenBlock || 0);
          const normalizedToken = String(token || record?.token || "").toLowerCase();
          if (!/^0x[0-9a-f]{64}$/.test(transactionHash) || !ADDRESS.test(normalizedToken) || !Number.isFinite(blockNumber) || blockNumber <= 0) continue;
          const target = targetedReplay.get(transactionHash) || { transactionHash, blockNumber, tokens: [] };
          target.blockNumber = Math.min(target.blockNumber, blockNumber);
          if (!target.tokens.includes(normalizedToken)) target.tokens.push(normalizedToken);
          targetedReplay.set(transactionHash, target);
        }
      }
    } else {
      for (const target of parsed.migrationReplayTransactions || []) {
        const transactionHash = String(target?.transactionHash || "").toLowerCase();
        const blockNumber = Number(target?.blockNumber || 0);
        const tokens = [...new Set((target?.tokens || []).map((token) => String(token).toLowerCase()).filter((token) => ADDRESS.test(token)))];
        if (!/^0x[0-9a-f]{64}$/.test(transactionHash) || !Number.isFinite(blockNumber) || blockNumber <= 0 || !tokens.length || parsed.seenTransactions?.[transactionHash]) continue;
        targetedReplay.set(transactionHash, { transactionHash, blockNumber, tokens });
      }
    }
    const migrationReplayTransactions = [...targetedReplay.values()]
      .sort((left, right) => left.blockNumber - right.blockNumber || left.transactionHash.localeCompare(right.transactionHash))
      .slice(-1_000);
    const targetedReplayHashes = new Set(migrationReplayTransactions.map((target) => target.transactionHash));
    const targetedReplayThroughBlock = Math.max(0, ...migrationReplayTransactions.map((target) => target.blockNumber));
    if (hasCreationEvidenceGap && gapBlocks.length) {
      replayFromBlock = Math.min(replayFromBlock ?? Number.POSITIVE_INFINITY, ...gapBlocks);
      replayReasons.push("recheck_bscscan_creation_evidence");
    }
    const seenTransactions = Object.fromEntries(Object.entries(parsed.seenTransactions || {}).map(([transactionHash, blockNumber]) => [
      normalizeTransactionHash(transactionHash),
      blockNumber,
    ]));
    const migratedSeenTransactions = Object.fromEntries(Object.entries(seenTransactions).filter(([transactionHash, blockNumber]) =>
      !targetedReplayHashes.has(transactionHash.toLowerCase())
      && (replayFromBlock === null || Number(blockNumber) < replayFromBlock)));
    const coverageRecoveryHistory = [...(parsed.coverageRecoveryHistory || [])];
    if (replayFromBlock !== null) coverageRecoveryHistory.push({
      fromBlock: replayFromBlock,
      scheduledAt: new Date().toISOString(),
      reason: replayReasons.join("+"),
      gaps: parsedCoverageGaps,
    });
    if (parsedVersion === 4 && migrationReplayTransactions.length) coverageRecoveryHistory.push({
      scheduledAt: new Date().toISOString(),
      reason: "v5_targeted_causal_attribution",
      transactionCount: migrationReplayTransactions.length,
      fromBlock: migrationReplayTransactions[0].blockNumber,
      toBlock: migrationReplayTransactions.at(-1).blockNumber,
    });
    return {
      ...baseline,
      ...parsed,
      version: STATE_VERSION,
      journalRevision: Number.isSafeInteger(parsed.journalRevision) && parsed.journalRevision >= 0 ? parsed.journalRevision : 0,
      lastFinalizedBlock: replayFromBlock === null
        ? (parsed.lastFinalizedBlock ?? baseline.lastFinalizedBlock)
        : Math.min(Number(parsed.lastFinalizedBlock ?? replayFromBlock - 1), replayFromBlock - 1),
      alertSuppressedThroughBlock: replayFromBlock === null
        ? Math.max(Number(parsed.alertSuppressedThroughBlock || 0), targetedReplayThroughBlock)
        : Math.max(Number(parsed.alertSuppressedThroughBlock || 0), Number(parsed.lastFinalizedBlock || 0), targetedReplayThroughBlock),
      migrationReplayTransactions,
      deferredCreationEvidence: parsed.deferredCreationEvidence && typeof parsed.deferredCreationEvidence === "object" && !Array.isArray(parsed.deferredCreationEvidence)
        ? Object.fromEntries(Object.entries(parsed.deferredCreationEvidence).map(([transactionHash, record]) => {
          const normalized = normalizeTransactionHash(record?.transactionHash || transactionHash);
          return [normalized, {
            ...record,
            transactionHash: normalized,
            flapCreationHotCandidates: readBscTransactionCreationEvidence(
              record?.flapCreationHotCandidates,
              normalized,
              `deferred ${normalized} Flap`,
              normalizeFlapCreationHotIndex,
            ),
            fourMemeCreationHotCandidates: readBscTransactionCreationEvidence(
              record?.fourMemeCreationHotCandidates,
              normalized,
              `deferred ${normalized} Four.Meme`,
              normalizeFourMemeCreationHotIndex,
            ),
            causalBarrierKeys: readBscCausalBarrierKeys(record?.causalBarrierKeys, `deferred ${normalized}`),
            ...(!Object.hasOwn(record || {}, "causalBarrierKeys")
              ? { causalBarrierMigrationPending: true }
              : {}),
          }];
        }))
        : {},
      realtimePendingEntries: parsed.realtimePendingEntries && typeof parsed.realtimePendingEntries === "object" && !Array.isArray(parsed.realtimePendingEntries)
        ? Object.fromEntries(Object.entries(parsed.realtimePendingEntries).map(([transactionHash, record]) => {
          const normalized = normalizeTransactionHash(record?.transactionHash || transactionHash);
          return [normalized, {
            ...record,
            transactionHash: normalized,
            flapCreationHotCandidates: readBscTransactionCreationEvidence(
              record?.flapCreationHotCandidates,
              normalized,
              `pending ${normalized} Flap`,
              normalizeFlapCreationHotIndex,
            ),
            fourMemeCreationHotCandidates: readBscTransactionCreationEvidence(
              record?.fourMemeCreationHotCandidates,
              normalized,
              `pending ${normalized} Four.Meme`,
              normalizeFourMemeCreationHotIndex,
            ),
            causalBarrierKeys: readBscCausalBarrierKeys(record?.causalBarrierKeys, `pending ${normalized}`),
            ...(!Object.hasOwn(record || {}, "causalBarrierKeys")
              ? { causalBarrierMigrationPending: true }
              : {}),
          }];
        }))
        : {},
      launchers: migratedLaunchers,
      hooks: parsed.hooks || {},
      officialChildren: parsed.officialChildren || {},
      singularryCurves: parsed.singularryCurves || {},
      officialUpgrades: parsed.officialUpgrades || {},
      officialLifecycleEvents: parsed.officialLifecycleEvents || {},
      seenTransactions: migratedSeenTransactions,
      transactionFailures: replayFromBlock === null
        ? Object.fromEntries(Object.entries(parsed.transactionFailures || {}).map(([transactionHash, record]) => [normalizeTransactionHash(transactionHash), record]))
        : {},
      nearHeadRecoveryGaps: normalizeNearHeadRecoveryGaps(parsed.nearHeadRecoveryGaps),
      coverageGaps: replayFromBlock === null ? parsedCoverageGaps.map((gap) => ({
        ...gap,
        ...(gap?.transactionHash ? { transactionHash: normalizeTransactionHash(gap.transactionHash) } : {}),
      })) : [],
      coverageRecoveryHistory: coverageRecoveryHistory.slice(-20),
      officialSources: {
        ...baseline.officialSources,
        ...(parsed.officialSources || {}),
        flap: {
          ...baseline.officialSources.flap,
          ...(parsed.officialSources?.flap || {}),
          pools: parsed.officialSources?.flap?.pools || {},
          featureActivations: Object.fromEntries(Object.entries(parsed.officialSources?.flap?.featureActivations || {}).map(([key, activation]) => [key, {
            ...activation,
            // Board-era activations belong to the legacy one-shot lane. Never
            // manufacture a first-three generation from historical state.
            firstThreeStatus: "legacy_closed",
            replayAttemptedTransactionHashes: [...new Set((Array.isArray(activation?.replayAttemptedTransactionHashes) ? activation.replayAttemptedTransactionHashes : [])
              .map(normalizeTransactionHash)
              .filter((value) => /^0x[0-9a-f]{64}$/.test(value)))]
              .slice(-FLAP_REPLAY_ATTEMPTED_TRANSACTIONS_MAX),
          }])),
          replayControl: {
            ...baseline.officialSources.flap.replayControl,
            ...(parsed.officialSources?.flap?.replayControl || {}),
          },
          creationEventHotIndex: normalizeFlapCreationHotIndex(parsed.officialSources?.flap?.creationEventHotIndex),
          quotePoolFirstThree: parsedVersion >= 7
            ? normalizeFlapQuoteFirstThreeState(parsed.officialSources?.flap?.quotePoolFirstThree)
            : emptyFlapQuoteFirstThreeState(),
          platformActivationAuditEvents: parsed.officialSources?.flap?.platformActivationAuditEvents || [],
        },
        fourMeme: {
          ...baseline.officialSources.fourMeme,
          ...(parsed.officialSources?.fourMeme || {}),
          roots: parsed.officialSources?.fourMeme?.roots || {},
          templates: parsed.officialSources?.fourMeme?.templates || {},
          quoteConfigs: parsed.officialSources?.fourMeme?.quoteConfigs || {},
          quoteBaselineInitialized: parsed.officialSources?.fourMeme?.quoteBaselineInitialized === true,
          pendingTemplates: parsed.officialSources?.fourMeme?.pendingTemplates || {},
          pendingQuoteConfigs: parsed.officialSources?.fourMeme?.pendingQuoteConfigs || {},
          featureActivations: Object.fromEntries(Object.entries(parsed.officialSources?.fourMeme?.featureActivations || {}).map(([key, activation]) => [key, {
            ...activation,
            replayAttemptedCandidateKeys: [...new Set((activation?.replayAttemptedCandidateKeys || [])
              .filter((value) => typeof value === "string" && value.length <= 180))]
              .slice(-FOUR_MEME_REPLAY_ATTEMPTED_CANDIDATES_MAX),
          }])),
          creationEventHotIndex: normalizeFourMemeCreationHotIndex(parsed.officialSources?.fourMeme?.creationEventHotIndex),
          platformActivationAuditEvents: parsed.officialSources?.fourMeme?.platformActivationAuditEvents || [],
          sourceCircuits: parsed.officialSources?.fourMeme?.sourceCircuits
            && typeof parsed.officialSources.fourMeme.sourceCircuits === "object"
            && !Array.isArray(parsed.officialSources.fourMeme.sourceCircuits)
            ? parsed.officialSources.fourMeme.sourceCircuits
            : {},
        },
        agentLaunch: {
          ...baseline.officialSources.agentLaunch,
          ...(parsed.officialSources?.agentLaunch || {}),
        },
        waifu: {
          ...baseline.officialSources.waifu,
          ...(parsed.officialSources?.waifu || {}),
          launches: parsed.officialSources?.waifu?.launches || {},
          alertedModeFingerprints: parsed.officialSources?.waifu?.alertedModeFingerprints || [],
        },
        rugspull: {
          ...baseline.officialSources.rugspull,
          ...(parsed.officialSources?.rugspull || {}),
          children: parsed.officialSources?.rugspull?.children || {},
        },
        singularry: {
          ...baseline.officialSources.singularry,
          ...(parsed.officialSources?.singularry || {}),
          tokens: parsed.officialSources?.singularry?.tokens || {},
        },
      },
      discoverySources: {
        ...baseline.discoverySources,
        ...(parsed.discoverySources || {}),
        dappBay: {
          ...baseline.discoverySources.dappBay,
          ...(parsed.discoverySources?.dappBay || {}),
          contracts: parsed.discoverySources?.dappBay?.contracts || {},
        },
        external: {
          ...baseline.discoverySources.external,
          ...(parsed.discoverySources?.external || {}),
          contracts: parsed.discoverySources?.external?.contracts || {},
        },
      },
      _health: {
        ...baseline._health,
        ...(parsed._health || {}),
        websocket: { ...baseline._health.websocket, ...(parsed._health?.websocket || {}) },
        rpc: { ...baseline._health.rpc, ...(parsed._health?.rpc || {}) },
        realtimeTail: { ...baseline._health.realtimeTail, ...(parsed._health?.realtimeTail || {}) },
        realtimeQueue: { ...baseline._health.realtimeQueue, ...(parsed._health?.realtimeQueue || {}) },
        nearHeadRecovery: { ...baseline._health.nearHeadRecovery, ...(parsed._health?.nearHeadRecovery || {}) },
        coverage: { ...baseline._health.coverage, ...(parsed._health?.coverage || {}) },
      },
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      if (metadata) {
        metadata.exists = false;
        metadata.legacyJournal = true;
      }
      return emptyState();
    }
    throw error;
  }
}

const BSC_STATE_WAL_VERSION = 1;
const BSC_STATE_SNAPSHOT_INTERVAL_MS = 30_000;
const BSC_STATE_WAL_MAX_BYTES = 16 * 1024 * 1024;

function stateDeltaOperations(previous, next, prefix = [], operations = []) {
  if (Object.is(previous, next)) return operations;
  const previousIsObject = previous !== null && typeof previous === "object";
  const nextIsObject = next !== null && typeof next === "object";
  if (Array.isArray(previous) || Array.isArray(next)) {
    const previousJson = JSON.stringify(previous);
    const nextJson = JSON.stringify(next);
    if (previousJson !== nextJson) operations.push({ op: "set", path: prefix, value: JSON.parse(nextJson) });
    return operations;
  }
  if (!previousIsObject || !nextIsObject) {
    operations.push({ op: "set", path: prefix, value: typeof next === "number" && !Number.isFinite(next) ? null : next });
    return operations;
  }
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of [...keys].sort()) {
    const pathParts = [...prefix, key];
    const previousHasValue = Object.hasOwn(previous, key) && previous[key] !== undefined;
    const nextHasValue = Object.hasOwn(next, key) && next[key] !== undefined;
    if (!nextHasValue && previousHasValue) operations.push({ op: "delete", path: pathParts });
    else if (nextHasValue && !previousHasValue) operations.push({ op: "set", path: pathParts, value: next[key] });
    else if (!nextHasValue) continue;
    else stateDeltaOperations(previous[key], next[key], pathParts, operations);
  }
  return operations;
}

function validJournalPath(parts) {
  return Array.isArray(parts)
    && parts.every((part) => typeof part === "string" && part.length > 0
      && part !== "__proto__" && part !== "prototype" && part !== "constructor");
}

function applyStateDeltaOperations(target, operations, { cloneSetValues = true } = {}) {
  let result = target;
  for (const operation of operations) {
    if (!operation || !["set", "delete"].includes(operation.op) || !validJournalPath(operation.path)) {
      throw new Error("invalid BSC state WAL operation");
    }
    if (operation.path.length === 0) throw new Error("BSC state WAL root operations are not supported");
    let parent = result;
    for (const part of operation.path.slice(0, -1)) {
      if (!parent || typeof parent !== "object" || Array.isArray(parent) || !Object.hasOwn(parent, part)) {
        throw new Error(`invalid BSC state WAL path ${operation.path.join(".")}`);
      }
      parent = parent[part];
    }
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
      throw new Error(`invalid BSC state WAL parent ${operation.path.join(".")}`);
    }
    const key = operation.path.at(-1);
    if (operation.op === "delete") {
      if (!Object.hasOwn(parent, key)) throw new Error(`missing BSC state WAL delete target ${operation.path.join(".")}`);
      delete parent[key];
    } else {
      parent[key] = cloneSetValues ? structuredClone(operation.value) : operation.value;
    }
  }
  return result;
}

function encodeStateWalFrame(revision, operations) {
  const core = { version: BSC_STATE_WAL_VERSION, revision, ops: operations };
  const payload = JSON.stringify(core);
  return `${JSON.stringify({
    ...core,
    payloadLength: Buffer.byteLength(payload),
    sha256: createHash("sha256").update(payload).digest("hex"),
  })}\n`;
}

function validateStateWalFrame(frame) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)
    || frame.version !== BSC_STATE_WAL_VERSION
    || !Number.isSafeInteger(frame.revision) || frame.revision <= 0
    || !Array.isArray(frame.ops)
    || !Number.isSafeInteger(frame.payloadLength) || frame.payloadLength < 0
    || !/^[0-9a-f]{64}$/.test(String(frame.sha256 || ""))) {
    throw new Error("invalid BSC state WAL frame");
  }
  const operationPaths = new Set();
  let revisionOperationCount = 0;
  for (const operation of frame.ops) {
    if (!operation || !["set", "delete"].includes(operation.op) || !validJournalPath(operation.path)
      || (operation.op === "set" && !Object.hasOwn(operation, "value"))) {
      throw new Error("invalid BSC state WAL operation");
    }
    const key = operation.path.join("\u0000");
    if (operationPaths.has(key)) throw new Error(`duplicate BSC state WAL path at revision ${frame.revision}`);
    operationPaths.add(key);
    if (operation.path.length === 1 && operation.path[0] === "journalRevision") {
      revisionOperationCount += 1;
      if (operation.op !== "set" || operation.value !== frame.revision) {
        throw new Error(`invalid BSC state WAL journalRevision operation at revision ${frame.revision}`);
      }
    }
  }
  if (revisionOperationCount !== 1) throw new Error(`missing BSC state WAL journalRevision operation at revision ${frame.revision}`);
  const payload = JSON.stringify({ version: frame.version, revision: frame.revision, ops: frame.ops });
  if (Buffer.byteLength(payload) !== frame.payloadLength) throw new Error(`BSC state WAL payload length mismatch at revision ${frame.revision}`);
  const checksum = createHash("sha256").update(payload).digest("hex");
  if (checksum !== frame.sha256) throw new Error(`BSC state WAL checksum mismatch at revision ${frame.revision}`);
  return checksum;
}

async function fsyncDirectory(directory, fsImpl = fs) {
  const handle = await fsImpl.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function appendStateWalFrame(file, frameText, fsImpl = fs) {
  const directory = path.dirname(file);
  await fsImpl.mkdir(directory, { recursive: true });
  let handle;
  let startingSize = 0;
  let sizeKnown = false;
  let writeAttempted = false;
  let failure = null;
  let fsynced = false;
  try {
    handle = await fsImpl.open(file, "a", 0o600);
    startingSize = Number((await handle.stat()).size || 0);
    if (!Number.isSafeInteger(startingSize) || startingSize < 0) throw new Error("invalid BSC state WAL size");
    sizeKnown = true;
    await handle.chmod(0o600);
    writeAttempted = true;
    await handle.writeFile(frameText, "utf8");
    await handle.sync();
    fsynced = true;
  } catch (error) {
    if (!handle) {
      error.walRollbackSafe = true;
      failure = error;
    } else if (!writeAttempted) {
      // A failed fstat gives us no safe rollback offset. No bytes were
      // written, so preserve the old WAL exactly and poison this process
      // rather than ever guessing that offset zero is safe.
      error.walRollbackSafe = sizeKnown;
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
        failure = new AggregateError([error, rollbackError], "BSC state WAL append failed and rollback was not durable");
        failure.walRollbackSafe = false;
      }
    }
  } finally {
    try { await handle?.close(); } catch (closeError) {
      // Once fsync succeeds, a close error cannot make the frame less
      // durable and must not cause the same revision to be appended again.
      if (!fsynced && !failure) {
        closeError.walRollbackSafe = false;
        failure = closeError;
      }
    }
  }
  if (failure) throw failure;
}

async function replaceStateWalWithEmpty(file, fsImpl = fs) {
  const directory = path.dirname(file);
  await fsImpl.mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  let renamed = false;
  try {
    handle = await fsImpl.open(temporary, "w", 0o600);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.rename(temporary, file);
    renamed = true;
    await fsyncDirectory(directory, fsImpl);
  } catch (error) {
    if (renamed) error.walResetAmbiguous = true;
    await handle?.close().catch(() => {});
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function truncateStateWal(file, length, fsImpl = fs) {
  const handle = await fsImpl.open(file, "r+");
  try {
    await handle.truncate(length);
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function replayStateWal(file, snapshot, fsImpl = fs) {
  const snapshotRevision = Number(snapshot?.journalRevision ?? 0);
  if (!Number.isSafeInteger(snapshotRevision) || snapshotRevision < 0) throw new Error("invalid BSC snapshot journalRevision");
  let raw;
  try {
    raw = await fsImpl.readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return { state: snapshot, revision: snapshotRevision, walBytes: 0, truncated: false };
    throw error;
  }
  await fsImpl.chmod(file, 0o600);
  const finalNewline = raw.length > 0 && raw.at(-1) === 0x0a;
  const lastNewline = raw.lastIndexOf(0x0a);
  const completeLength = finalNewline ? raw.length : Math.max(0, lastNewline + 1);
  const complete = raw.subarray(0, completeLength).toString("utf8");
  const lines = complete.split("\n").filter(Boolean);
  let state = structuredClone(snapshot);
  let appliedRevision = snapshotRevision;
  let previousFrameRevision = 0;
  const revisionChecksums = new Map();
  for (const line of lines) {
    let frame;
    try { frame = JSON.parse(line); } catch { throw new Error("corrupt BSC state WAL frame"); }
    const checksum = validateStateWalFrame(frame);
    if (frame.revision < previousFrameRevision) throw new Error(`out-of-order BSC state WAL revision ${frame.revision}`);
    previousFrameRevision = frame.revision;
    const priorChecksum = revisionChecksums.get(frame.revision);
    if (priorChecksum && priorChecksum !== checksum) throw new Error(`conflicting BSC state WAL revision ${frame.revision}`);
    if (priorChecksum) continue;
    revisionChecksums.set(frame.revision, checksum);
    if (frame.revision <= snapshotRevision) continue;
    if (frame.revision !== appliedRevision + 1) throw new Error(`BSC state WAL revision gap ${appliedRevision} -> ${frame.revision}`);
    state = applyStateDeltaOperations(state, frame.ops);
    if (state.journalRevision !== frame.revision) throw new Error(`BSC state WAL revision state mismatch at revision ${frame.revision}`);
    appliedRevision = frame.revision;
  }
  if (!finalNewline && raw.length > completeLength) await truncateStateWal(file, completeLength, fsImpl);
  state.journalRevision = appliedRevision;
  if (!Number.isInteger(state.version) || state.version < 0 || state.version > STATE_VERSION) {
    throw new Error(`BSC state version ${state.version} is newer than supported version ${STATE_VERSION}`);
  }
  return { state, revision: appliedRevision, walBytes: completeLength, truncated: !finalNewline && raw.length > completeLength };
}

export async function readBscLaunchpadDurableState(stateFile) {
  const snapshot = await readState(stateFile);
  return (await replayStateWal(`${stateFile}.wal`, snapshot)).state;
}

async function atomicWrite(file, state, fsImpl = fs) {
  const directory = path.dirname(file);
  await fsImpl.mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  try {
    handle = await fsImpl.open(temporary, "w", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.rename(temporary, file);
    await fsyncDirectory(directory, fsImpl);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function platformForAddress(address) {
  const normalized = String(address || "").toLowerCase();
  const shared = BSC_SHARED_LAUNCH_ROOTS.get(normalized);
  if (shared) return shared;
  return BSC_LAUNCHPAD_CATALOG.find((entry) => entry.launchers.includes(normalized)) || null;
}

function isKnownLaunchRootPlatform(platform) {
  return platform?.trust === "official_verified"
    || platform?.trust === "official_shared"
    || platform?.trust === "multi_source_corroborated";
}

function alertsSuppressedAtBlock(state, blockNumber) {
  const through = Number(state?.alertSuppressedThroughBlock || 0);
  const observed = Number(blockNumber || 0);
  return through > 0 && observed > 0 && observed <= through;
}

function publicPlatform(entry) {
  return entry ? {
    id: entry.id,
    name: entry.name,
    trust: entry.trust,
    website: entry.website,
    twitter: entry.twitter,
    github: entry.github || null,
    notifyFirstToken: entry.notifyFirstToken === true,
    notifyFirstInfrastructureActivation: entry.notifyFirstInfrastructureActivation === true,
    evidenceUrl: entry.evidenceUrl,
  } : null;
}

function platformForLabel(label) {
  const normalized = String(label || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const aliases = new Map([
    ["fourmeme", "fourmeme"],
    ["openfour", "openfour"],
    ["openfourfourmeme", "openfour"],
    ["flap", "flap"],
    ["flapstocks", "flap"],
    ["flapaioracle", "flap"],
    ["hodldance", "hodldance"],
    ["moonsale", "moonsale"],
    ["huksfun", "huksfun"],
    ["agentlaunch", "agentlaunch"],
    ["flazepad", "flazepad"],
    ["karmafi", "karmafi"],
    ["rugspull", "rugspull"],
    ["createtoken", "createtoken"],
    ["poomeme", "poomeme"],
    ["bnbpump", "bnbpump"],
    ["magicmint", "magicmint"],
    ["codelessdev", "codelessdev"],
    ["xfour", "xfour"],
    ["bltx", "bltx"],
    ["bltxfun", "bltx"],
    ["fabi", "fabi"],
    ["fabibsc", "fabi"],
    ["flypad", "flypad"],
    ["grafun", "grafun"],
    ["bullshot", "bullshot"],
    ["eagle", "eaglefun"],
    ["eaglefun", "eaglefun"],
    ["eaglelaunch", "eaglefun"],
    ["bnbs", "bnbs"],
    ["bnbslaunchpad", "bnbs"],
    ["bnbstax", "bnbs-tax"],
    ["bfun", "bfun"],
    ["bdotfun", "bfun"],
    ["singularry", "singularry"],
    ["singularrylaunchpad", "singularry"],
    ["1v1meme", "onevone"],
    ["onevone", "onevone"],
  ]);
  const id = aliases.get(normalized);
  return publicPlatform(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === id));
}

function platformFromVerifiedContractName(contractName) {
  const name = String(contractName || "").toLowerCase();
  if (/\bflap|flaptoken/.test(name)) return platformForLabel("flap");
  if (/moonsale/.test(name)) return platformForLabel("moonsale");
  if (/hodl.*dance|hodldance/.test(name)) return platformForLabel("hodldance");
  if (/huksfun/.test(name)) return platformForLabel("huksfun");
  if (/flaze/.test(name)) return platformForLabel("flazepad");
  if (/grafun/.test(name)) return platformForLabel("grafun");
  if (/bullshot/.test(name)) return platformForLabel("bullshot");
  if (/eagle.*(?:fun|launch)|launchpadtokenfactory/.test(name)) return platformForLabel("eaglefun");
  if (/bnbs/.test(name)) return platformForLabel("bnbs");
  if (/\bbfun|b\.fun/.test(name)) return platformForLabel("bfun");
  if (/singularry/.test(name)) return platformForLabel("singularry");
  if (/tournamentmanager|matchengine|fightervault|1v1meme/.test(name)) return platformForLabel("onevone");
  if (/agentlaunch/.test(name)) return platformForLabel("agentlaunch");
  if (/karmafi/.test(name)) return platformForLabel("karmafi");
  if (/rugspull/.test(name)) return platformForLabel("rugspull");
  if (/createtoken/.test(name)) return platformForLabel("createtoken");
  if (/poo.*meme|poomeme/.test(name)) return platformForLabel("poomeme");
  if (/bnbpump/.test(name)) return platformForLabel("bnbpump");
  if (/magicmint/.test(name)) return platformForLabel("magicmint");
  if (/codeless/.test(name)) return platformForLabel("codelessdev");
  if (/xfour|x402/.test(name)) return platformForLabel("xfour");
  if (/bltx/.test(name)) return platformForLabel("bltx");
  if (/fabi/.test(name)) return platformForLabel("fabi");
  return null;
}

function officialComponentForAddress(address) {
  const normalized = String(address || "").toLowerCase();
  const root = platformForAddress(normalized);
  if (root?.trust === "official_verified") return { platform: publicPlatform(root), role: "factory", mode: "Factory/Manager" };
  if (root?.trust === "official_shared") return { platform: publicPlatform(root), role: "shared_manager", mode: "Shared Factory/Manager" };
  if (root?.trust === "multi_source_corroborated") return { platform: publicPlatform(root), role: "manager", mode: "Corroborated Manager", corroborated: true };
  if (root?.trust === "chain_verified_prelaunch") return { platform: publicPlatform(root), role: "prelaunch_factory", mode: "Prelaunch Factory", shadow: true };
  const component = BSC_OFFICIAL_COMPONENTS.get(normalized);
  if (!component) return null;
  const platform = publicPlatform(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === component.platformId));
  return ["official_verified", "multi_source_corroborated", "chain_verified_prelaunch"].includes(platform?.trust)
    ? { platform, role: component.role, mode: component.mode, corroborated: platform.trust === "multi_source_corroborated", shadow: platform.trust === "chain_verified_prelaunch" }
    : null;
}

export function parseOfficialBscLifecycleLog(log, { singularryCurves = new Map() } = {}) {
  const emitter = String(log?.address || "").toLowerCase();
  const topic = log?.topics?.[0];
  if (emitter === "0x5b3ba297a60685844fe673c134651d7dcf1a74b6" && topic === ONEVONE_TOURNAMENT_CREATED_TOPIC) {
    try {
      const args = onevoneTournamentManager.parseLog(log).args;
      return {
        platform: publicPlatform(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "onevone")),
        lifecycleId: "first_tournament_created",
        eventName: "TournamentCreated",
        componentRole: "tournament_manager",
        componentMode: "首场 Meme 擂台",
        tournamentId: args.tournamentId.toString(),
        entryFee: args.entryFee.toString(),
        roundDelay: args.roundDelay.toString(),
        roundDuration: args.roundDuration.toString(),
        startTime: args.startTime.toString(),
      };
    } catch {
      return null;
    }
  }
  const curve = singularryCurves instanceof Map
    ? singularryCurves.get(emitter)
    : singularryCurves?.[emitter];
  if (curve && topic === SINGULARRY_CURVE_FINALIZED_TOPIC) {
    try {
      const args = singularryCurve.parseLog(log).args;
      return {
        platform: publicPlatform(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "singularry")),
        lifecycleId: "first_curve_finalized",
        eventName: "CurveFinalized",
        componentRole: "official_bonding_curve",
        componentMode: "首个 Thena V3 毕业",
        token: getAddress(curve.token),
        pool: getAddress(args.uniswapPool),
        lpTokenId: args.lpTokenId.toString(),
      };
    } catch {
      return null;
    }
  }
  return null;
}

function addressFromStorage(value) {
  const raw = String(value || "0x").slice(-40);
  if (!raw || /^0+$/.test(raw)) return null;
  try { return getAddress(`0x${raw}`); }
  catch { return null; }
}

function normalizePool(pool) {
  return {
    ...pool,
    factory: getAddress(pool.factory),
    token0: getAddress(pool.token0),
    token1: getAddress(pool.token1),
    pool: pool.pool ? getAddress(pool.pool) : null,
    hook: pool.hook ? getAddress(pool.hook) : null,
  };
}

export function isErc20MintLog(log) {
  return log?.topics?.[0] === BSC_TRANSFER_TOPIC
    && log.topics.length === 3
    && log.topics[1] === BSC_ZERO_TOPIC
    && /^0x[0-9a-fA-F]{64}$/.test(log.data || "");
}

export function parseBscPoolLogs(logs = []) {
  const pools = [];
  for (const log of logs) {
    const topic = log.topics?.[0];
    const factory = String(log.address || "").toLowerCase();
    const source = BSC_DEX_CONTRACTS.get(factory);
    try {
      if (topic === BSC_PAIR_CREATED_TOPIC) {
        const parsed = v2.parseLog(log);
        pools.push(normalizePool({ kind: source?.name || "v2-pair", factory: log.address, token0: parsed.args.token0, token1: parsed.args.token1, pool: parsed.args.pair, poolId: null, hook: null, verifiedDex: Boolean(source) }));
      } else if (topic === BSC_V3_POOL_CREATED_TOPIC) {
        const parsed = v3.parseLog(log);
        pools.push(normalizePool({ kind: source?.name || "v3-pool", factory: log.address, token0: parsed.args.token0, token1: parsed.args.token1, pool: parsed.args.pool, poolId: null, hook: null, fee: Number(parsed.args.fee), verifiedDex: Boolean(source) }));
      } else if (topic === PANCAKE_INFINITY_CL_INITIALIZE_TOPIC) {
        const parsed = infinityCl.parseLog(log);
        pools.push(normalizePool({ kind: "Pancake Infinity CL", factory: log.address, token0: parsed.args.currency0, token1: parsed.args.currency1, pool: null, poolId: parsed.args.poolId, hook: parsed.args.hooks, fee: Number(parsed.args.fee), verifiedDex: source?.kind === "infinity-cl" }));
      } else if (topic === PANCAKE_INFINITY_BIN_INITIALIZE_TOPIC) {
        const parsed = infinityBin.parseLog(log);
        pools.push(normalizePool({ kind: "Pancake Infinity Bin", factory: log.address, token0: parsed.args.currency0, token1: parsed.args.currency1, pool: null, poolId: parsed.args.poolId, hook: parsed.args.hooks, fee: Number(parsed.args.fee), verifiedDex: source?.kind === "infinity-bin" }));
      } else if (topic === UNISWAP_V4_INITIALIZE_TOPIC) {
        const parsed = uniswapV4.parseLog(log);
        pools.push(normalizePool({ kind: "Uniswap V4", factory: log.address, token0: parsed.args.currency0, token1: parsed.args.currency1, pool: null, poolId: parsed.args.poolId, hook: parsed.args.hooks, fee: Number(parsed.args.fee), verifiedDex: source?.kind === "uniswap-v4" }));
      }
    } catch {
      // A third-party contract can copy an event topic with malformed data.
    }
  }
  return [...new Map(pools.map((pool) => [`${pool.factory}:${pool.pool || pool.poolId}`, pool])).values()];
}

function securityPassed(security) {
  return security?.decision === "pass" && security?.metrics?.liquidityConfirmed === true;
}

function infrastructureSafetyPassed(security) {
  if (securityPassed(security)) return true;
  const reasons = security?.reasons || [];
  return security?.decision === "block" && reasons.length > 0 && reasons.every((reason) => reason === "池子实际流动性未确认");
}

function ensureLauncherState(state, observation) {
  const key = observation.launcher.toLowerCase();
  state.launchers[key] ||= {
    launcher: observation.launcher,
    firstSeenBlock: observation.blockNumber,
    lastSeenBlock: observation.blockNumber,
    transactions: [],
    tokens: {},
    modes: {},
    baselineModeFingerprint: null,
    discoveryAlerted: false,
    alertedModes: [],
    structuralEligible: false,
    callers: [],
    platform: observation.platform || null,
  };
  const launcher = state.launchers[key];
  launcher.uniqueTokenCount ??= Object.keys(launcher.tokens || {}).length;
  launcher.callers ||= [];
  for (const mode of Object.values(launcher.modes || {})) {
    mode.uniqueTokenCount ??= (mode.tokens || []).length;
    mode.safeTokens ||= [];
    mode.structuralTransactions ||= [];
    mode.causalTransactions ||= [];
    mode.mechanismTransactions ||= [];
    mode.callers ||= [];
  }
  return launcher;
}

export function modeComponentNovelty(previousModes, shape) {
  const shapes = previousModes.map((mode) => mode.shape || {});
  const knownValues = (key) => new Set(shapes.map((item) => item[key]).filter(Boolean));
  const knownItems = (key) => new Set(shapes.flatMap((item) => item[key] || []));
  const selector = shape.selector && !["internal", "0x"].includes(shape.selector) && !knownValues("selector").has(shape.selector) ? shape.selector : null;
  const implementation = shape.implementation && !knownValues("implementation").has(shape.implementation) ? shape.implementation : null;
  const launcherCodeHash = shape.launcherCodeHash && !knownValues("launcherCodeHash").has(shape.launcherCodeHash) ? shape.launcherCodeHash : null;
  const knownTokenCodeHashes = new Set(shapes.map((item) => item.tokenCodeHash || item.tokenSelectorHash).filter(Boolean));
  const tokenCodeHash = (shape.tokenCodeHash || shape.tokenSelectorHash) && !knownTokenCodeHashes.has(shape.tokenCodeHash || shape.tokenSelectorHash) ? (shape.tokenCodeHash || shape.tokenSelectorHash) : null;
  const tokenImplementation = shape.tokenImplementation && !knownValues("tokenImplementation").has(shape.tokenImplementation) ? shape.tokenImplementation : null;
  const componentMode = shape.componentMode
    && shape.componentModeAlertEligible !== false
    && !knownValues("componentMode").has(shape.componentMode)
    ? shape.componentMode
    : null;
  const vaultFactory = shape.vaultFactory
    && shape.vaultFactoryOfficial === true
    && shape.vaultFactoryAlertEligible === true
    && !knownValues("vaultFactory").has(shape.vaultFactory)
    ? shape.vaultFactory
    : null;
  const presetId = shape.presetId
    && shape.featureActivationEligible === true
    && !knownValues("presetId").has(shape.presetId)
    ? shape.presetId
    : null;
  const quoteAsset = shape.quoteAsset
    && shape.featureActivationEligible === true
    && !knownValues("quoteAsset").has(shape.quoteAsset)
    ? shape.quoteAsset
    : null;
  const openFourModules = {};
  if (shape.featureActivationEligible === true) {
    for (const key of ["curveModule", "tradeModule", "migrateModule", "tokenModule", "flags"]) {
      if (shape[key] && !knownValues(key).has(shape[key])) openFourModules[key] = shape[key];
    }
  }
  const poolKinds = (shape.poolKinds || []).filter((item) => !knownItems("poolKinds").has(item));
  const creationTopics = (shape.creationTopics || []).filter((item) => !knownItems("creationTopics").has(item));
  return {
    selector,
    implementation,
    launcherCodeHash,
    tokenCodeHash,
    tokenSelectorHash: tokenCodeHash,
    tokenImplementation,
    componentMode,
    vaultFactory,
    presetId,
    quoteAsset,
    quoteSymbol: quoteAsset ? shape.quoteSymbol || null : null,
    ...openFourModules,
    poolKinds,
    creationTopics,
    customTopics: creationTopics,
    // Token implementations/code hashes can legitimately vary per ordinary
    // token. They stay in the audit payload but cannot alone create a "new
    // launch mode" notification.
    meaningful: Boolean(selector || implementation || launcherCodeHash || componentMode || vaultFactory || presetId || quoteAsset || Object.keys(openFourModules).length || poolKinds.length || creationTopics.length),
  };
}

function sameOrderedStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function eip1167Implementation(code) {
  const match = String(code || "0x").toLowerCase().replace(/^0x/, "")
    .match(/363d3d373d3d3d363d73([0-9a-f]{40})5af43d/);
  return match ? getAddress(`0x${match[1]}`) : null;
}

async function lightweightRuntimeIdentity(provider, address, blockTag, preferLatestState = false) {
  if (!provider.getStorage) return null;
  const read = async (targetBlockTag) => {
    const code = await provider.getCode(address, targetBlockTag);
    if (!code || code === "0x") return null;
    // EIP-1167 embeds its implementation in runtime bytecode. Avoid two
    // archive storage reads for every ordinary clone token.
    const cloneImplementation = eip1167Implementation(code);
    if (cloneImplementation) return { implementation: cloneImplementation.toLowerCase(), codeHash: null };
    const [implementationStorage, beaconStorage] = await Promise.all([
      provider.getStorage(address, EIP1967_IMPLEMENTATION_SLOT, targetBlockTag),
      provider.getStorage(address, EIP1967_BEACON_SLOT, targetBlockTag),
    ]);
    const directImplementation = addressFromStorage(implementationStorage);
    const beacon = addressFromStorage(beaconStorage);
    let beaconImplementation = null;
    if (!directImplementation && !cloneImplementation && beacon) {
      if (!provider.call) return null;
      const result = await provider.call({
        to: beacon,
        data: BEACON_IMPLEMENTATION_SELECTOR,
        ...(targetBlockTag !== null && targetBlockTag !== undefined ? { blockTag: targetBlockTag } : {}),
      });
      beaconImplementation = addressFromStorage(result);
      if (!beaconImplementation) return null;
    }
    const implementation = directImplementation || beaconImplementation;
    return {
      implementation: implementation?.toLowerCase() || null,
      codeHash: implementation ? null : keccak256(code),
    };
  };
  const primaryBlockTag = preferLatestState ? undefined : blockTag;
  const fallbackBlockTag = preferLatestState ? blockTag : undefined;
  try {
    return await read(primaryBlockTag);
  } catch (error) {
    if (blockTag === null
      || blockTag === undefined
      || (!isBscArchiveStateUnavailable(error) && !isTransientCoverageError(error))) return null;
    try {
      // Exact official creation evidence, selector/mode descriptors and the
      // upgrade guard have already matched before this optimization runs. A
      // alternate-state retry therefore remains fail-closed: both controller
      // and token identities must still equal one complete warmed fingerprint.
      // Near head we try latest first so an archive timeout is not paid for
      // every ordinary Flap/Four token; historical state remains the fallback.
      return await read(fallbackBlockTag);
    } catch {
      return null;
    }
  }
}

function knownOfficialFastTopics(platformId) {
  if (platformId === "flap") return new Set([FLAP_TOKEN_CREATED_TOPIC, FLAP_VAULT_TOKEN_CREATED_TOPIC]);
  if (["fourmeme", "fourmeme-springboard-shared"].includes(platformId)) return new Set([FOUR_MEME_TOKEN_CREATE_TOPIC, FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC]);
  if (platformId === "openfour") return new Set([OPENFOUR_TOKEN_CREATED_TOPIC]);
  return null;
}

function modeHasCompleteFingerprintEvidence(mode) {
  return Boolean(mode?.fingerprint
    && mode.shape?.fingerprint === mode.fingerprint
    && mode.transactions?.length
    && mode.structuralTransactions?.length
    && mode.causalTransactions?.length
    && mode.mechanismTransactions?.length);
}

function storedIdentityMatches(identity, implementation, codeHash) {
  const expectedImplementation = implementation ? String(implementation).toLowerCase() : null;
  if (expectedImplementation) return identity?.implementation === expectedImplementation;
  return Boolean(identity && !identity.implementation && codeHash && identity.codeHash === codeHash);
}

function knownOfficialFastModeKey(controllerAddress, fingerprint) {
  return `${controllerAddress}:${fingerprint}`;
}

const BSC_LINKED_MODE_COMPONENT_FIELDS = [
  "vaultFactory",
  "curveModule",
  "tradeModule",
  "migrateModule",
  "tokenModule",
];

function linkedModeComponentAddresses(shape, controllerAddress = null) {
  return new Set([controllerAddress, ...BSC_LINKED_MODE_COMPONENT_FIELDS.map((field) => shape?.[field])]
    .map((address) => String(address || "").toLowerCase())
    .filter((address) => ADDRESS.test(address)));
}

export async function matchKnownOfficialFastMode({ provider, state, controller, token, blockTag, descriptor, warmedFingerprints, identityCache = null, preferLatestState = false }) {
  const allowedTopics = knownOfficialFastTopics(controller?.platform?.id);
  const controllerAddress = String(controller?.address || "").toLowerCase();
  const tokenAddress = String(token || "").toLowerCase();
  if (!allowedTopics
    || !/^official_/.test(controller?.kind || "")
    || !controller?.causalTokenEvent
    || !ADDRESS.test(controllerAddress)
    || !ADDRESS.test(tokenAddress)
    || !Number.isInteger(Number(blockTag))
    || !descriptor?.argumentEvidence
    || !descriptor.creationTopics?.length
    || descriptor.creationTopics.some((topic) => !allowedTopics.has(topic))
    || !sameOrderedStrings(descriptor.exactCreationTokens, [tokenAddress])) return null;

  const launcher = state?.launchers?.[controllerAddress];
  if (!launcher || !(warmedFingerprints instanceof Set)) return null;
  const candidates = Object.values(launcher.modes || {}).filter((mode) => {
    const shape = mode?.shape;
    if (!modeHasCompleteFingerprintEvidence(mode)
      || !shape
      || !warmedFingerprints.has(knownOfficialFastModeKey(controllerAddress, mode.fingerprint))) return false;
    const linkedComponents = linkedModeComponentAddresses(shape, controllerAddress);
    const hasUnabsorbedUpgrade = Object.values(state.officialUpgrades || {}).some((upgrade) =>
      linkedComponents.has(String(upgrade?.emitter || "").toLowerCase())
      // Transaction ordering for legacy upgrade records is unavailable. An
      // upgrade in the same block therefore invalidates the shortcut too.
      && Number(upgrade?.blockNumber || 0) >= Number(mode.lastSeenBlock || 0));
    return !hasUnabsorbedUpgrade
      && shape.selector === descriptor.selector
      && sameOrderedStrings(shape.poolKinds, descriptor.poolKinds)
      && sameOrderedStrings(shape.verifiedPoolFactories, descriptor.verifiedPoolFactories)
      && sameOrderedStrings(shape.creationTopics, descriptor.creationTopics)
      && sameOrderedStrings(shape.customTopics, descriptor.creationTopics)
      && sameOrderedStrings(shape.launchTypes, descriptor.launchTypes)
      && String(shape.vaultFactory || "").toLowerCase() === String(descriptor.vaultFactory || "").toLowerCase()
      && ["presetId", "managerTemplate", "quoteAsset", "curveModule", "tradeModule", "migrateModule", "tokenModule", "flags"]
        .every((key) => String(shape[key] || "").toLowerCase() === String(descriptor[key] || "").toLowerCase());
  });
  if (!candidates.length) return null;

  const bucket = Math.floor(Number(blockTag) / 20);
  const cachedController = identityCache instanceof Map ? identityCache.get(controllerAddress) : null;
  const controllerIdentityPromise = cachedController?.bucket === bucket
    ? cachedController.promise
    : lightweightRuntimeIdentity(provider, controllerAddress, Number(blockTag), preferLatestState);
  if (identityCache instanceof Map && cachedController?.bucket !== bucket) {
    identityCache.set(controllerAddress, { bucket, promise: controllerIdentityPromise });
  }
  const [controllerIdentity, tokenIdentity] = await Promise.all([
    controllerIdentityPromise,
    lightweightRuntimeIdentity(provider, tokenAddress, Number(blockTag), preferLatestState),
  ]);
  if (!controllerIdentity
    && identityCache instanceof Map
    && identityCache.get(controllerAddress)?.promise === controllerIdentityPromise) {
    identityCache.delete(controllerAddress);
  }
  if (!controllerIdentity || !tokenIdentity) return null;
  const matches = candidates.filter((mode) =>
    storedIdentityMatches(controllerIdentity, mode.shape.implementation, mode.shape.launcherCodeHash)
    && storedIdentityMatches(tokenIdentity, mode.shape.tokenImplementation, mode.shape.tokenCodeHash || mode.shape.tokenSelectorHash));
  return matches.length === 1 ? structuredClone(matches[0].shape) : null;
}

function isFourMemePlatformId(platformId) {
  return ["fourmeme", "openfour", "fourmeme-springboard-shared"].includes(String(platformId || "").toLowerCase());
}

export function shouldReplayFourMemeActivation(activation) {
  return Boolean(activation
    && activation.active !== false
    && activation.allowReplay === true
    && !activation.replayCompletedAt
    && !activation.firstTokenAlertedAt
    && !activation.firstTokenTransactionHash);
}

function featureActivationEligibleAt(activation, observedAt, replayLookbackMs) {
  if (!activation || activation.active === false) return false;
  const eventMs = Date.parse(observedAt || "");
  const confirmedMs = Date.parse(activation.confirmedAt || activation.firstObservedAt || "");
  const firstObservedMs = Date.parse(activation.firstObservedAt || activation.confirmedAt || "");
  if (!Number.isFinite(eventMs) || !Number.isFinite(confirmedMs) || !Number.isFinite(firstObservedMs)) return false;
  const eligibleFromMs = activation.allowReplay === true
    ? firstObservedMs - replayLookbackMs
    : confirmedMs;
  return eventMs >= eligibleFromMs;
}

function flapActivationEligibleAt(activation, observedAt) {
  return featureActivationEligibleAt(activation, observedAt, FLAP_ACTIVATION_REPLAY_LOOKBACK_MS);
}

export function matchFlapFeatureActivation(state, {
  exactCreationEvidence = [],
  relevantPools = [],
  token,
  observedAt,
  requestedActivationKey = null,
} = {}) {
  const tokenAddress = String(token || "").toLowerCase();
  if (!ADDRESS.test(tokenAddress)) return null;
  const entries = Object.entries(state?.officialSources?.flap?.featureActivations || {})
    .filter(([key, activation]) => (!requestedActivationKey || key === requestedActivationKey)
      && flapActivationEligibleAt(activation, observedAt)
      && !(activation.type === "quote_pool"
        && state?.officialSources?.flap?.quotePoolFirstThree?.activeByQuote
          ?.[String(activation.quoteAddress || "").toLowerCase()])
      && !activation.firstTokenAlertedAt
      && !activation.firstTokenTransactionHash);
  const vaultFactories = new Set(exactCreationEvidence
    .filter((item) => item.topic === FLAP_VAULT_TOKEN_CREATED_TOPIC
      && String(item.token || "").toLowerCase() === tokenAddress)
    .map((item) => String(item.vaultFactory || "").toLowerCase())
    .filter((address) => ADDRESS.test(address)));
  const receiptQuoteAssets = new Set(relevantPools.flatMap((pool) => {
    const token0 = String(pool?.token0 || "").toLowerCase();
    const token1 = String(pool?.token1 || "").toLowerCase();
    if (token0 === tokenAddress && ADDRESS.test(token1)) return [token1];
    if (token1 === tokenAddress && ADDRESS.test(token0)) return [token0];
    return [];
  }));
  const hasOfficialTokenCreation = exactCreationEvidence.some((item) => item.topic === FLAP_TOKEN_CREATED_TOPIC
    && String(item.token || "").toLowerCase() === tokenAddress);

  const match = entries.find(([, activation]) => {
    if (activation.type === "vault_factory") {
      return ADDRESS.test(String(activation.vaultFactory || "").toLowerCase())
        && vaultFactories.has(String(activation.vaultFactory).toLowerCase());
    }
    if (activation.type === "quote_pool") {
      return hasOfficialTokenCreation
        && ADDRESS.test(String(activation.quoteAddress || "").toLowerCase())
        && receiptQuoteAssets.has(String(activation.quoteAddress).toLowerCase());
    }
    return false;
  });
  if (!match) return null;
  const [key, activation] = match;
  const category = normalizeOfficialText(activation.category || "").toUpperCase();
  const quoteSymbol = normalizeOfficialText(activation.quoteSymbol || "").toUpperCase() || null;
  const quoteLabel = quoteSymbol || (activation.quoteAddress
    ? `${String(activation.quoteAddress).slice(0, 8)}…${String(activation.quoteAddress).slice(-4)}`
    : "新报价");
  const componentMode = activation.type === "quote_pool"
    ? `Flap ${quoteLabel} 新底池`
    : `Flap ${category || "新"} Vault`;
  return {
    featureActivationKey: key,
    featureActivationEligible: true,
    featurePlatform: "flap",
    featurePoolIdentity: activation.poolIdentity || null,
    featureSourceUrl: activation.sourceUrl || FLAP_BOARD_URL,
    componentMode,
    componentModeAlertEligible: true,
    quoteAsset: activation.type === "quote_pool" ? String(activation.quoteAddress).toLowerCase() : null,
    quoteSymbol: activation.type === "quote_pool" ? quoteSymbol : null,
    quoteFingerprint: activation.type === "quote_pool" ? activation.fingerprint || null : null,
    vaultFactory: activation.type === "vault_factory" ? String(activation.vaultFactory).toLowerCase() : null,
    vaultFactoryOfficial: activation.type === "vault_factory",
    vaultFactoryAlertEligible: activation.type === "vault_factory",
    vaultCategory: activation.type === "vault_factory" ? category || null : null,
  };
}

function fourMemeActivationEligibleAt(activation, observedAt) {
  return featureActivationEligibleAt(activation, observedAt, FOUR_MEME_ACTIVATION_REPLAY_LOOKBACK_MS);
}

function flapActivationForObservation(state, observation) {
  if (!observation?.mode?.featureActivationEligible || !observation.mode.featureActivationKey) return null;
  if (String(observation.platform?.id || "").toLowerCase() !== "flap") return null;
  const activation = state?.officialSources?.flap?.featureActivations?.[observation.mode.featureActivationKey];
  if (!flapActivationEligibleAt(activation, observation.observedAt)
    || (activation?.type === "quote_pool"
      && state?.officialSources?.flap?.quotePoolFirstThree?.activeByQuote
        ?.[String(activation.quoteAddress || "").toLowerCase()])
    || activation.firstTokenAlertedAt
    || activation.firstTokenTransactionHash) return null;
  if (activation.allowReplay === true
    && !activation.replayCompletedAt
    && observation.officialDiscoveryReplay !== true) return null;
  if (activation.type === "quote_pool"
    && String(activation.quoteAddress || "").toLowerCase() !== String(observation.mode.quoteAsset || "").toLowerCase()) return null;
  if (activation.type === "vault_factory"
    && String(activation.vaultFactory || "").toLowerCase() !== String(observation.mode.vaultFactory || "").toLowerCase()) return null;
  return activation;
}

function fourMemeActivationForObservation(state, observation) {
  if (!observation?.mode?.featureActivationEligible || !observation.mode.featureActivationKey) return null;
  if (!["fourmeme", "openfour"].includes(String(observation.platform?.id || "").toLowerCase())) return null;
  const activation = state?.officialSources?.fourMeme?.featureActivations?.[observation.mode.featureActivationKey];
  if (!fourMemeActivationEligibleAt(activation, observation.observedAt)
    || activation.firstTokenAlertedAt
    || activation.firstTokenTransactionHash) return null;
  if (activation.allowReplay === true
    && !activation.replayCompletedAt
    && observation.officialDiscoveryReplay !== true) return null;
  if (activation.type === "quote_config") {
    if (String(activation.quoteAddress || "").toLowerCase() !== String(observation.mode.quoteAsset || "").toLowerCase()
      || String(activation.quoteFingerprint || "") !== String(observation.mode.quoteFingerprint || "")) return null;
  } else {
    const observedTemplateId = activation.verificationLane === "official_token_api"
      ? observation.mode.templateId
      : observation.mode.presetId;
    if (String(activation.templateId || "") !== String(observedTemplateId || "")
      || String(activation.templateFingerprint || "") !== String(observation.mode.templateFingerprint || "")) return null;
  }
  return activation;
}

export function evaluateBscObservation(state, observation, current = Date.now()) {
  const launcher = ensureLauncherState(state, observation);
  const transactionWasKnown = launcher.transactions.includes(observation.transactionHash);
  if (!transactionWasKnown) launcher.transactions = [...launcher.transactions, observation.transactionHash].slice(-50);
  launcher.lastSeenBlock = Math.max(Number(launcher.lastSeenBlock || 0), Number(observation.blockNumber || 0));
  launcher.structuralEligible ||= Boolean(observation.structural?.eligible);
  if (observation.deployer && !launcher.callers.includes(observation.deployer.toLowerCase())) launcher.callers = [...launcher.callers, observation.deployer.toLowerCase()].slice(-50);
  if (observation.platform) launcher.platform = observation.platform;

  const assessments = new Map((observation.tokenAssessments || []).map((item) => [item.token.toLowerCase(), item]));
  if (observation.sampleToken && observation.security && !assessments.has(observation.sampleToken.toLowerCase())) assessments.set(observation.sampleToken.toLowerCase(), {
    token: observation.sampleToken,
    security: observation.security,
    metadata: (observation.tokens || []).find((item) => item.token.toLowerCase() === observation.sampleToken.toLowerCase())?.metadata || null,
    pools: observation.pools || [],
  });

  for (const token of observation.tokens || []) {
    const key = token.token.toLowerCase();
    const assessment = assessments.get(key);
    if (!launcher.tokens[key]) launcher.uniqueTokenCount += 1;
    launcher.tokens[key] = {
      ...(launcher.tokens[key] || {}),
      token: token.token,
      firstSeenBlock: launcher.tokens[key]?.firstSeenBlock || observation.blockNumber,
      lastSeenBlock: observation.blockNumber,
      transactionHash: observation.transactionHash,
      observedAt: observation.observedAt,
      metadata: assessment?.metadata || token.metadata || launcher.tokens[key]?.metadata || null,
      security: assessment?.security || launcher.tokens[key]?.security || null,
      pools: assessment?.pools || observation.pools || launcher.tokens[key]?.pools || [],
    };
  }
  for (const assessment of assessments.values()) {
    const key = assessment.token.toLowerCase();
    if (!launcher.tokens[key]) continue;
    launcher.tokens[key] = {
      ...launcher.tokens[key],
      metadata: assessment.metadata || launcher.tokens[key].metadata || null,
      security: assessment.security || launcher.tokens[key].security || null,
      pools: assessment.pools || launcher.tokens[key].pools || [],
    };
  }
  if (Object.keys(launcher.tokens).length > 100) {
    launcher.tokens = Object.fromEntries(Object.entries(launcher.tokens).sort(([, left], [, right]) => Number(right.lastSeenBlock || 0) - Number(left.lastSeenBlock || 0)).slice(0, 100));
  }

  const fingerprint = observation.mode.fingerprint;
  const existingMode = launcher.modes[fingerprint] || null;
  const modeWasKnown = Boolean(existingMode);
  const priorSafeTokenCount = existingMode?.safeTokens?.length || 0;
  const previousModes = Object.values(launcher.modes)
    .filter((candidate) => candidate.fingerprint !== fingerprint);
  const novelty = modeComponentNovelty(previousModes, observation.mode);
  launcher.modes[fingerprint] ||= {
    fingerprint,
    firstSeenBlock: observation.blockNumber,
    lastSeenBlock: observation.blockNumber,
    transactions: [],
    tokens: [],
    safeTokens: [],
    structuralTransactions: [],
    causalTransactions: [],
    mechanismTransactions: [],
    callers: [],
    shape: observation.mode,
    novelty,
    uniqueTokenCount: 0,
  };
  const mode = launcher.modes[fingerprint];
  // An official docs/GitHub record can arrive a few seconds after the first
  // on-chain use of a permissionless VaultFactory. Promote the already stored
  // observation when that independent evidence appears so a replay can still
  // announce the actual first token instead of requiring a second launch.
  if (!mode.novelty?.meaningful && novelty.meaningful) mode.novelty = novelty;
  if (observation.mode.vaultFactoryAlertEligible === true
    && String(mode.shape?.vaultFactory || "").toLowerCase() === String(observation.mode.vaultFactory || "").toLowerCase()) {
    mode.shape = { ...mode.shape, ...observation.mode };
  }
  if (observation.mode.featureActivationEligible === true
    && ((observation.mode.presetId && String(mode.shape?.presetId || "") === String(observation.mode.presetId))
      || (observation.mode.quoteAsset && String(mode.shape?.quoteAsset || "").toLowerCase() === String(observation.mode.quoteAsset).toLowerCase()))) {
    mode.shape = { ...mode.shape, ...observation.mode };
  }
  mode.lastSeenBlock = observation.blockNumber;
  if (!mode.transactions.includes(observation.transactionHash)) mode.transactions = [...mode.transactions, observation.transactionHash].slice(-30);
  if (observation.structural?.eligible && !mode.structuralTransactions.includes(observation.transactionHash)) mode.structuralTransactions = [...mode.structuralTransactions, observation.transactionHash].slice(-30);
  if (observation.causalTokenEvent && !mode.causalTransactions.includes(observation.transactionHash)) mode.causalTransactions = [...mode.causalTransactions, observation.transactionHash].slice(-30);
  if (observation.structural?.mechanismEvidence && !mode.mechanismTransactions.includes(observation.transactionHash)) mode.mechanismTransactions = [...mode.mechanismTransactions, observation.transactionHash].slice(-30);
  if (observation.deployer && !mode.callers.includes(observation.deployer.toLowerCase())) mode.callers = [...mode.callers, observation.deployer.toLowerCase()].slice(-30);
  for (const token of observation.tokens || []) {
    const normalized = token.token.toLowerCase();
    if (!mode.tokens.includes(normalized)) {
      mode.uniqueTokenCount += 1;
      mode.tokens = [...mode.tokens, normalized].slice(-50);
    }
  }
  for (const assessment of assessments.values()) {
    if (infrastructureSafetyPassed(assessment.security) && !mode.safeTokens.includes(assessment.token.toLowerCase())) mode.safeTokens = [...mode.safeTokens, assessment.token.toLowerCase()].slice(-20);
  }
  launcher.baselineModeFingerprint ||= fingerprint;

  const uniqueTokens = Number(launcher.uniqueTokenCount || Object.keys(launcher.tokens).length);
  const uniqueTransactions = launcher.transactions.length;
  const platformIsVerified = launcher.platform?.trust === "official_verified"
    || (launcher.platform?.trust === "multi_source_corroborated" && launcher.platform?.notifyFirstToken === true);
  const platformIsKnown = isKnownLaunchRootPlatform(launcher.platform);
  const warmedUp = current - Date.parse(state.initializedAt || 0) >= WARMUP_MS;
  const unknownModeConfirmed = Number(mode.uniqueTokenCount || mode.tokens.length) >= 2
    && mode.transactions.length >= 2
    && mode.safeTokens.length >= 2
    && mode.structuralTransactions.length >= 2
    && mode.causalTransactions.length >= 2
    && mode.mechanismTransactions.length >= 2
    && mode.callers.length >= 2;
  const knownModeConfirmed = Number(mode.uniqueTokenCount || mode.tokens.length) >= 2
    && mode.transactions.length >= 2
    && mode.safeTokens.length >= 2
    && mode.structuralTransactions.length >= 2
    && mode.causalTransactions.length >= 2;

  const additionalMode = fingerprint !== launcher.baselineModeFingerprint;
  if (alertsSuppressedAtBlock(state, observation.blockNumber)) {
    if (platformIsKnown && additionalMode && !launcher.alertedModes.includes(fingerprint)) launcher.alertedModes.push(fingerprint);
    if (platformIsVerified && launcher.platform?.notifyFirstToken && observation.causalTokenEvent) launcher.discoveryAlerted = true;
    return null;
  }

  const firstTokenConfirmed = observation.causalTokenEvent
    && observation.structural?.eligible
    && (mode.safeTokens.length >= 1 || launcher.platform?.notifyFirstInfrastructureActivation === true);
  if (platformIsVerified && warmedUp && launcher.platform?.notifyFirstToken && !launcher.discoveryAlerted && firstTokenConfirmed) {
    return { kind: "new_launchpad", launcher, fingerprint, uniqueTokens, uniqueTransactions, officialFirstToken: true };
  }

  if (!platformIsKnown && !launcher.discoveryAlerted && uniqueTokens >= 2 && uniqueTransactions >= 2 && unknownModeConfirmed) {
    return { kind: "new_launchpad", launcher, fingerprint, uniqueTokens, uniqueTransactions };
  }

  const modeWasAlerted = launcher.alertedModes.includes(fingerprint);
  const storedNovelty = mode.novelty || novelty;
  const fourMemeFamily = isFourMemePlatformId(launcher.platform?.id);
  const fourMemeActivation = fourMemeActivationForObservation(state, observation);
  const flapActivation = flapActivationForObservation(state, observation);
  const implementationChanged = Boolean(storedNovelty.implementation || storedNovelty.launcherCodeHash);
  const verifiedImplementationConfirmed = platformIsVerified
    && !modeWasKnown
    && implementationChanged
    && mode.safeTokens.length >= 1
    && mode.structuralTransactions.length >= 1
    && mode.causalTransactions.length >= 1;
  const flapFeatureFirstTokenConfirmed = launcher.platform?.id === "flap"
    && platformIsVerified
    && storedNovelty.meaningful === true
    && (priorSafeTokenCount === 0 || observation.officialDiscoveryReplay === true)
    && mode.safeTokens.length >= 1
    && mode.structuralTransactions.length >= 1
    && mode.causalTransactions.length >= 1
    && mode.mechanismTransactions.length >= 1;
  const fourMemeFeatureFirstTokenConfirmed = Boolean(fourMemeActivation)
    && platformIsVerified
    && observation.causalTokenEvent
    && observation.structural?.eligible === true
    && observation.structural?.mechanismEvidence === true
    && infrastructureSafetyPassed(observation.security);
  const flapOfficialFeatureFirstTokenConfirmed = Boolean(flapActivation)
    && platformIsVerified
    && observation.causalTokenEvent
    && observation.structural?.eligible === true
    && observation.structural?.mechanismEvidence === true
    && infrastructureSafetyPassed(observation.security);
  if (warmedUp && flapOfficialFeatureFirstTokenConfirmed) {
    return {
      kind: "new_mode",
      launcher,
      fingerprint,
      uniqueTokens,
      uniqueTransactions,
      novelty: {
        ...storedNovelty,
        componentMode: observation.mode.componentMode || storedNovelty.componentMode || null,
        quoteAsset: observation.mode.quoteAsset || null,
        quoteSymbol: observation.mode.quoteSymbol || null,
        vaultFactory: observation.mode.vaultFactory || null,
        vaultCategory: observation.mode.vaultCategory || null,
        meaningful: true,
      },
      featureFirstToken: true,
      featurePlatform: "flap",
      featureActivationKey: observation.mode.featureActivationKey,
      observedAt: observation.observedAt,
      transactionHash: observation.transactionHash,
      token: observation.sampleToken || observation.tokens?.[0]?.token || null,
    };
  }
  if (warmedUp && fourMemeFeatureFirstTokenConfirmed) {
    return {
      kind: "new_mode",
      launcher,
      fingerprint,
      uniqueTokens,
      uniqueTransactions,
      novelty: {
        ...storedNovelty,
        componentMode: observation.mode.componentMode || fourMemeActivation.template?.name || storedNovelty.componentMode || null,
        presetId: observation.mode.presetId,
        templateId: observation.mode.templateId || fourMemeActivation.templateId || null,
        quoteAsset: observation.mode.quoteAsset || null,
        quoteSymbol: observation.mode.quoteSymbol || null,
        curveModule: observation.mode.curveModule || null,
        tradeModule: observation.mode.tradeModule || null,
        migrateModule: observation.mode.migrateModule || null,
        tokenModule: observation.mode.tokenModule || null,
        flags: observation.mode.flags || null,
        meaningful: true,
      },
      featureFirstToken: true,
      featurePlatform: "fourmeme",
      featureActivationKey: observation.mode.featureActivationKey,
      observedAt: observation.observedAt,
      transactionHash: observation.transactionHash,
      token: observation.sampleToken || observation.tokens?.[0]?.token || null,
    };
  }
  if (platformIsKnown
    && warmedUp
    && additionalMode
    && !modeWasAlerted
    && flapFeatureFirstTokenConfirmed) {
    return {
      kind: "new_mode",
      launcher,
      fingerprint,
      uniqueTokens,
      uniqueTransactions,
      novelty: storedNovelty,
      featureFirstToken: true,
    };
  }
  const staleFlapMode = launcher.platform?.id === "flap"
    && modeWasKnown
    && priorSafeTokenCount > 0
    && observation.officialDiscoveryReplay !== true;
  if (platformIsKnown && !fourMemeFamily && warmedUp && additionalMode && !modeWasAlerted && !staleFlapMode && storedNovelty.meaningful && (verifiedImplementationConfirmed || knownModeConfirmed)) {
    return { kind: "new_mode", launcher, fingerprint, uniqueTokens, uniqueTransactions, novelty: storedNovelty };
  }
  if (!platformIsKnown && launcher.discoveryAlerted && additionalMode && !modeWasAlerted && unknownModeConfirmed) {
    return { kind: "new_mode", launcher, fingerprint, uniqueTokens, uniqueTransactions };
  }
  return null;
}

export function commitBscDecision(state, decision) {
  if (!decision) return;
  if (decision.kind === "new_launchpad") decision.launcher.discoveryAlerted = true;
  if (decision.kind === "new_mode" && !decision.launcher.alertedModes.includes(decision.fingerprint)) decision.launcher.alertedModes.push(decision.fingerprint);
  if (decision.featureActivationKey) {
    const sourceId = decision.featurePlatform === "flap" ? "flap" : "fourMeme";
    const activation = state?.officialSources?.[sourceId]?.featureActivations?.[decision.featureActivationKey];
    if (activation && !activation.firstTokenAlertedAt) {
      activation.firstTokenAlertedAt = decision.observedAt || new Date().toISOString();
      activation.firstTokenTransactionHash = decision.transactionHash || null;
      activation.firstToken = decision.token || null;
    }
  }
}

function eventFromDecision(decision, observation) {
  const sample = (observation.tokens || []).find((token) => token.token.toLowerCase() === observation.sampleToken?.toLowerCase()) || observation.tokens?.[0] || null;
  const focusPlatform = String(decision.featurePlatform || observation.platform?.id || "").toLowerCase();
  const sampleAddress = String(sample?.token || "").toLowerCase();
  const coreEvidence = (observation.launchEvidence || []).find((item) =>
    String(item?.event || "") === "TokenCreated"
      && String(item?.topic || "").toLowerCase() === OPENFOUR_TOKEN_CREATED_TOPIC
      && String(item?.emitter || "").toLowerCase() === FOUR_MEME_OPENFOUR_CORE
      && String(item?.token || "").toLowerCase() === sampleAddress);
  const openFourFirstToken = Boolean(
    decision.featureFirstToken === true
      && isFourMemePlatformId(focusPlatform)
      && String(observation.launcher || "").toLowerCase() === FOUR_MEME_OPENFOUR_CORE
      && coreEvidence,
  );
  const deliverySla = focusPlatform === "flap" || isFourMemePlatformId(focusPlatform)
    ? normalizeBscWebsocketDeliverySla(observation.deliverySla)
    : null;
  return {
    type: "bsc_launchpad_update",
    kind: decision.kind,
    officialFirstToken: decision.officialFirstToken === true || openFourFirstToken,
    featureFirstToken: decision.featureFirstToken === true,
    featurePlatform: decision.featurePlatform || null,
    featureActivationKey: decision.featureActivationKey || null,
    eventKey: decision.featureActivationKey
      ? `bsc-${decision.featurePlatform || "fourmeme"}-feature-token:${decision.featureActivationKey}`
      : decision.kind === "new_launchpad"
      ? `bsc-launchpad:56:${observation.launcher.toLowerCase()}`
      : `bsc-launchpad-mode:56:${observation.launcher.toLowerCase()}:${observation.mode.fingerprint}`,
    chainId: BSC_CHAIN_ID,
    launcher: observation.launcher,
    platform: observation.platform,
    launchCount: decision.uniqueTransactions,
    uniqueTokens: decision.uniqueTokens,
    transactionHash: observation.transactionHash,
    blockNumber: observation.blockNumber,
    ...(observation.blockHash ? { blockHash: String(observation.blockHash).toLowerCase() } : {}),
    ...(Number.isSafeInteger(Number(observation.transactionIndex))
      ? { transactionIndex: Number(observation.transactionIndex) }
      : {}),
    ...(Number.isSafeInteger(Number(coreEvidence?.logIndex))
      ? { logIndex: Number(coreEvidence.logIndex) }
      : {}),
    ...(typeof observation.canonical === "boolean" ? { canonical: observation.canonical } : {}),
    ...(Number.isSafeInteger(Number(observation.confirmations))
      ? { confirmations: Number(observation.confirmations) }
      : {}),
    ...(Number.isSafeInteger(Number(observation.requiredConfirmations))
      ? { requiredConfirmations: Number(observation.requiredConfirmations) }
      : {}),
    tokens: sample ? [{ ...sample, metadata: sample.metadata || null }] : [],
    pools: observation.pools || [],
    mode: { ...observation.mode, ...(decision.novelty ? { novelty: decision.novelty } : {}) },
    structural: observation.structural,
    security: observation.security || null,
    attribution: observation.attribution || inferBscLaunchpadAttribution({
      officialFactory: observation.platform?.trust === "official_verified"
        ? { platform: observation.platform, address: observation.launcher }
        : null,
      causalEvidence: observation.platform?.trust === "official_shared" && observation.causalTokenEvent
        ? { platform: observation.platform, emitter: observation.launcher, sourceId: "bsc-transaction-receipt" }
        : null,
    }),
    deployer: observation.deployer || null,
    controllerKind: observation.controllerKind || null,
    launchEvidence: (observation.launchEvidence || []).slice(0, 3),
    explorerEvidence: observation.external?.controllerExplorer || null,
    marketContext: observation.external?.dex ? {
      dexId: observation.external.dex.bestPair?.dexId || null,
      pairAddress: observation.external.dex.bestPair?.pairAddress || null,
      liquidityUsd: observation.external.dex.bestPair?.liquidityUsd || null,
      firstPairCreatedAt: observation.external.dex.firstPair?.pairCreatedAt || null,
      website: observation.external.dex.website || null,
      twitter: observation.external.dex.twitter || null,
      telegram: observation.external.dex.telegram || null,
    } : null,
    explorerUrl: `https://bscscan.com/tx/${observation.transactionHash}`,
    launcherUrl: `https://bscscan.com/address/${observation.launcher}`,
    sourceUrl: observation.mode?.featureSourceUrl
      || (observation.mode?.presetId || observation.mode?.templateId
      ? FOUR_MEME_TEMPLATE_URL
      : observation.mode?.quoteAsset && isFourMemePlatformId(observation.platform?.id) ? FOUR_MEME_CONFIG_URL : null),
    blockTimestamp: observation.observedAt,
    observedAt: observation.observedAt,
    strong: true,
    ...(openFourFirstToken ? {
      informationalOnly: true,
      autoTradeEligible: false,
      automaticExecution: false,
    } : {}),
    ...(deliverySla ? { deliverySla } : {}),
  };
}

function pruneState(state, current = Date.now()) {
  const cutoff = current - 7 * 24 * 60 * 60_000;
  for (const [key, launcher] of Object.entries(state.launchers)) {
    const recent = Math.max(...Object.values(launcher.tokens || {}).map((token) => Date.parse(token.observedAt || 0)), 0);
    if (!launcher.discoveryAlerted && !launcher.platform && Object.keys(launcher.tokens || {}).length < 2 && recent && recent < cutoff) delete state.launchers[key];
    const modeEntries = Object.entries(launcher.modes || {});
    if (modeEntries.length > 100) {
      const retained = modeEntries.sort(([, left], [, right]) => Number(right.lastSeenBlock || 0) - Number(left.lastSeenBlock || 0)).slice(0, 100);
      if (launcher.baselineModeFingerprint && !retained.some(([fingerprint]) => fingerprint === launcher.baselineModeFingerprint) && launcher.modes[launcher.baselineModeFingerprint]) retained[retained.length - 1] = [launcher.baselineModeFingerprint, launcher.modes[launcher.baselineModeFingerprint]];
      launcher.modes = Object.fromEntries(retained);
    }
    launcher.alertedModes = (launcher.alertedModes || []).slice(-100);
  }
  const transactions = Object.entries(state.seenTransactions || {}).sort(([, left], [, right]) => Number(right) - Number(left)).slice(0, 20_000);
  state.seenTransactions = Object.fromEntries(transactions);
  state.transactionFailures = Object.fromEntries(Object.entries(state.transactionFailures || {}).sort(([, left], [, right]) => Date.parse(right.lastFailureAt || 0) - Date.parse(left.lastFailureAt || 0)).slice(0, 200));
  state.deferredCreationEvidence ||= {};
  if (state.officialSources?.flap) {
    state.officialSources.flap.creationEventHotIndex = normalizeFlapCreationHotIndex(
      state.officialSources.flap.creationEventHotIndex,
      current,
    );
    for (const activation of Object.values(state.officialSources.flap.featureActivations || {})) {
      activation.replayAttemptedTransactionHashes = [...new Set((Array.isArray(activation.replayAttemptedTransactionHashes) ? activation.replayAttemptedTransactionHashes : [])
        .map(normalizeTransactionHash)
        .filter((value) => /^0x[0-9a-f]{64}$/.test(value)))]
        .slice(-FLAP_REPLAY_ATTEMPTED_TRANSACTIONS_MAX);
    }
  }
  if (state.officialSources?.fourMeme) {
    state.officialSources.fourMeme.creationEventHotIndex = normalizeFourMemeCreationHotIndex(
      state.officialSources.fourMeme.creationEventHotIndex,
      current,
    );
    for (const activation of Object.values(state.officialSources.fourMeme.featureActivations || {})) {
      activation.replayAttemptedCandidateKeys = [...new Set((activation.replayAttemptedCandidateKeys || [])
        .filter((value) => typeof value === "string" && value.length <= 180))]
        .slice(-FOUR_MEME_REPLAY_ATTEMPTED_CANDIDATES_MAX);
    }
  }
  state.nearHeadRecoveryGaps = normalizeNearHeadRecoveryGaps(state.nearHeadRecoveryGaps);
  const unresolvedCoverageGaps = (state.coverageGaps || []).filter((gap) => !gap?.resolvedAt && gap?.status !== "resolved");
  const resolvedCoverageGaps = (state.coverageGaps || [])
    .filter((gap) => gap?.resolvedAt || gap?.status === "resolved")
    .sort((left, right) => Date.parse(right.resolvedAt || right.detectedAt || 0) - Date.parse(left.resolvedAt || left.detectedAt || 0))
    .slice(0, 20);
  state.coverageGaps = [...unresolvedCoverageGaps, ...resolvedCoverageGaps];
}

function isTransientCoverageError(error) {
  return ["NETWORK_ERROR", "TIMEOUT", "SERVER_ERROR", "ALERT_DELIVERY_PENDING"].includes(error?.code)
    || /failed on every BSC RPC|missing (?:block|finalized)|network|timeout|socket|fetch failed|temporarily unavailable/i.test(error?.message || "");
}

function errorSummary(error, limit = 300) {
  const message = error?.info?.error?.message
    || error?.error?.message
    || error?.shortMessage
    || error?.reason
    || error?.message
    || error
    || "unknown error";
  return String(message).replace(/\s+/g, " ").slice(0, limit);
}

export function isBscArchiveStateUnavailable(error) {
  return /archive requests require|missing trie node|not supported|header not found|block not found/i.test(errorSummary(error));
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = { status: "fulfilled", value: await worker(items[index]) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }));
  return results;
}

// Production pools (historical, realtime and archive) intentionally share
// physical-host circuit state. A 429/timeout from Blast/BlockRazor/BLXR must
// not be rediscovered independently by every pool. Provider-factory tests get
// an isolated registry unless they explicitly inject a shared one.
const BSC_RPC_HOST_CIRCUITS = new Map();
const BSC_RPC_CIRCUIT_REGISTRY_META = new WeakMap();

export function createRpcPool(urls, archiveUrls = [], archiveConcurrency = 4, dependencies = {}) {
  const requestTimeoutMs = Math.max(1, Number(dependencies.requestTimeoutMs || 5_000));
  const transportTimeoutMs = Math.max(1, requestTimeoutMs - Math.min(250, Math.max(1, Math.floor(requestTimeoutMs / 10))));
  const standardConcurrency = Math.max(1, Number(dependencies.standardConcurrency || 12));
  const clockNow = dependencies.now || Date.now;
  const recoveryProbeIntervalMs = Math.max(250, Number(dependencies.recoveryProbeIntervalMs || 1_000));
  const hostCircuitRegistry = dependencies.hostCircuitRegistry
    || (dependencies.providerFactory ? new Map() : BSC_RPC_HOST_CIRCUITS);
  let circuitRegistryMeta = BSC_RPC_CIRCUIT_REGISTRY_META.get(hostCircuitRegistry);
  if (!circuitRegistryMeta) {
    circuitRegistryMeta = {
      recoveryProbeAfter: new Map(),
      recoveryProbeInFlight: new Map(),
    };
    BSC_RPC_CIRCUIT_REGISTRY_META.set(hostCircuitRegistry, circuitRegistryMeta);
  }
  const abortableGetUrl = async (request, signal) => {
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeout);
    signal?.addListener(() => {
      cancelled = true;
      controller.abort();
    });
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body ? Buffer.from(request.body) : undefined,
        signal: controller.signal,
      });
      const responseHeaders = Object.fromEntries(response.headers.entries());
      const responseBody = new Uint8Array(await response.arrayBuffer());
      // ethers retries HTTP 429 internally and may issue a large burst before
      // surfacing a generic "maximum retry" error that has lost Retry-After.
      // Stop at the transport boundary so the shared host circuit owns the
      // only retry schedule and every pool sees the server-declared delay.
      if (response.status === 429) {
        const error = new Error(`HTTP 429 from ${new URL(request.url).host}`);
        const retryAfter = response.headers.get("retry-after");
        const seconds = Number(retryAfter);
        const timestamp = Number.isFinite(seconds) ? Number.NaN : Date.parse(String(retryAfter || ""));
        error.code = "SERVER_ERROR";
        error.status = 429;
        error.headers = responseHeaders;
        error.retryAfterMs = Number.isFinite(seconds) && seconds >= 0
          ? seconds * 1_000
          : Number.isFinite(timestamp) ? Math.max(0, timestamp - clockNow()) : 0;
        throw error;
      }
      return {
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: responseHeaders,
        body: responseBody,
      };
    } catch (error) {
      if (timedOut || cancelled) {
        const aborted = new Error(timedOut ? `request timed out after ${request.timeout}ms` : "request cancelled");
        aborted.code = timedOut ? "TIMEOUT" : "CANCELLED";
        throw aborted;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
  const providerFactory = dependencies.providerFactory || ((url) => {
    const request = new FetchRequest(url);
    // Fire the transport timeout just before the outer provider fallback so
    // the socket is already cancelled when the pool advances to another RPC.
    request.timeout = transportTimeoutMs;
    // ethers' Node transport rejects on ClientRequest timeout without closing
    // the underlying socket. Use an AbortController-backed transport so the
    // configured timeout cancels the real HTTP request as well as its promise.
    request.getUrlFunc = abortableGetUrl;
    return new JsonRpcProvider(request, BSC_CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
  });
  const unique = [...new Set(urls.filter(Boolean))];
  const providers = unique.map((url, index) => providerFactory(url, { kind: "standard", index }));
  const circuitForUrl = (url) => {
    const host = new URL(url).hostname.toLowerCase();
    if (!hostCircuitRegistry.has(host)) {
      hostCircuitRegistry.set(host, {
        host,
        globalUntil: 0,
        globalFailures: 0,
        globalGeneration: 0,
        methods: new Map(),
      });
    }
    return hostCircuitRegistry.get(host);
  };
  const providerCircuits = unique.map(circuitForUrl);
  const archiveUnique = [...new Set(archiveUrls.filter(Boolean))];
  const archiveProviders = archiveUnique.map((url, index) => providerFactory(url, { kind: "archive", index }));
  const archiveCircuits = archiveUnique.map(circuitForUrl);
  const hostMethodRecoveryProbeAfter = circuitRegistryMeta.recoveryProbeAfter;
  const hostMethodRecoveryProbeInFlight = circuitRegistryMeta.recoveryProbeInFlight;
  const archiveWaiters = [];
  const standardWaiters = [];
  let activeArchiveRequests = 0;
  let activeStandardRequests = 0;
  let nextProvider = 0;
  let nextArchiveProvider = 0;
  const operationName = (method, args) => method === "send" && typeof args[0] === "string" ? args[0] : method;
  const hostForUrl = (url) => new URL(url).hostname.toLowerCase();
  const knownGetLogsDisabledHosts = new Set([
    "bsc-dataseed.nariox.org",
    "bsc-dataseed.defibit.io",
    "bsc-dataseed.ninicoin.io",
    "bsc.nodereal.io",
  ]);
  const getLogsFilterFromArgs = (args = []) => {
    if (args[0] !== "eth_getLogs" || !Array.isArray(args[1])) return null;
    const filter = args[1][0];
    return filter && typeof filter === "object" ? filter : null;
  };
  const getLogsBlockSpan = (args = []) => {
    const filter = getLogsFilterFromArgs(args);
    const parseBlock = (value) => {
      if (typeof value === "number" && Number.isSafeInteger(value)) return value;
      if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value, 16);
      return null;
    };
    const fromBlock = parseBlock(filter?.fromBlock);
    const toBlock = parseBlock(filter?.toBlock);
    return Number.isSafeInteger(fromBlock) && Number.isSafeInteger(toBlock) && toBlock >= fromBlock
      ? toBlock - fromBlock + 1
      : null;
  };
  const isKnownGetLogsDisabled = (url, args = []) => {
    const host = hostForUrl(url);
    const blockSpan = getLogsBlockSpan(args);
    return knownGetLogsDisabledHosts.has(host)
      || (host.endsWith(".bnbchain.org") && host.startsWith("bsc-dataseed"))
      || (host.includes("blastapi.io") && blockSpan !== null && blockSpan > 10)
      || (host.includes("blockrazor.xyz") && blockSpan !== null && blockSpan > 25)
      // PublicNode's free BSC endpoint accepts recent log queries only when
      // they are scoped to one or more addresses. Sending a global topic-only
      // request adds a guaranteed failure before the next fallback provider.
      || (host.includes("publicnode.com") && !getLogsFilterFromArgs(args)?.address);
  };
  const getLogsPreference = (url) => {
    const host = hostForUrl(url);
    // Keep both realtime-capable public endpoints warm. Always preferring
    // Blast meant every tail range hit the same host first until it timed out,
    // while BlockRazor remained cold and then had to absorb the whole retry.
    if (host.includes("blastapi.io") || host.includes("blockrazor.xyz")) return 0;
    if (host.includes("publicnode.com")) return 1;
    if (host.includes("blxrbdn.com")) return 3;
    return 2;
  };
  const historicalObjectPreference = (url) => {
    const host = hostForUrl(url);
    // This endpoint serves historical transaction objects without sharing the
    // Blast/BlockRazor capacity reserved by the realtime-tail provider.
    if (host.includes("blxrbdn.com")) return 0;
    if (host.includes("blastapi.io") || host.includes("blockrazor.xyz")) return 1;
    return 2;
  };
  const orderForOperation = (indices, operation, sourceUrls, args = []) => {
    const capable = operation === "eth_getLogs"
      ? indices.filter((index) => !isKnownGetLogsDisabled(sourceUrls[index], args))
      : indices;
    if (operation === "eth_getLogs") {
      return capable.map((index, order) => ({ index, order }))
        .sort((left, right) => getLogsPreference(sourceUrls[left.index]) - getLogsPreference(sourceUrls[right.index]) || left.order - right.order)
        .map(({ index }) => index);
    }
    if (["getTransaction", "getTransactionReceipt", "getBlock", "getCode", "getStorage", "call"].includes(operation)) {
      return capable.map((index, order) => ({ index, order }))
        .sort((left, right) => historicalObjectPreference(sourceUrls[left.index]) - historicalObjectPreference(sourceUrls[right.index]) || left.order - right.order)
        .map(({ index }) => index);
    }
    return capable;
  };
  const methodCircuit = (circuit, operation, create = false) => {
    let entry = circuit.methods.get(operation);
    if (!entry && create) {
      entry = { until: 0, failures: 0, generation: 0 };
      circuit.methods.set(operation, entry);
    }
    return entry;
  };
  const cooldownUntil = (circuits, index, operation) => Math.max(
    Number(circuits[index]?.globalUntil || 0),
    Number(methodCircuit(circuits[index], operation)?.until || 0),
  );
  const rpcStatusCode = (error) => Number(
    error?.status
      ?? error?.statusCode
      ?? error?.response?.status
      ?? error?.info?.status
      ?? error?.info?.response?.status,
  );
  const isGlobalRateLimit = (message, error = null) => rpcStatusCode(error) === 429
    || /rate.?limit|too many requests|\b429\b|quota/i.test(message);
  const responseHeader = (headers, name) => {
    if (!headers) return null;
    if (typeof headers.get === "function") return headers.get(name);
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : null;
  };
  const retryAfterDelayMs = (error, current) => {
    const explicitMs = [
      error?.retryAfterMs,
      error?.info?.retryAfterMs,
      error?.error?.retryAfterMs,
      error?.info?.error?.retryAfterMs,
    ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
    const headerContainers = [
      error?.headers,
      error?.response?.headers,
      error?.info?.headers,
      error?.info?.response?.headers,
    ];
    const headerDelays = headerContainers.map((headers) => responseHeader(headers, "retry-after"))
      .filter((value) => value !== null && value !== undefined)
      .map((value) => {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
        const timestamp = Date.parse(String(value));
        return Number.isFinite(timestamp) ? Math.max(0, timestamp - current) : 0;
      })
      .filter((value) => Number.isFinite(value) && value > 0);
    const jsonSeconds = [
      error?.retry_after,
      error?.data?.retry_after,
      error?.error?.data?.retry_after,
      error?.info?.error?.data?.retry_after,
    ].map(Number).filter((value) => Number.isFinite(value) && value > 0).map((value) => value * 1_000);
    return Math.max(0, ...explicitMs, ...headerDelays, ...jsonSeconds);
  };
  const isExplicitMethodCapabilityFailure = (message, error = null) => !isGlobalRateLimit(message, error)
    && /(?:\bmethod\b.{0,100}\b(?:not found|does not exist|not supported|unsupported|not available)\b|\bunsupported method\b)/i.test(message);
  const isHistoricalObjectCapabilityFailure = (operation, message, error = null) => [
    "getTransaction",
    "getTransactionReceipt",
    "getBlock",
    "getCode",
    "getStorage",
    "call",
  ].includes(operation)
    && !isGlobalRateLimit(message, error)
    && isBscArchiveStateUnavailable(error || message);
  const isMethodScopedFailure = (operation, message, error = null) => isExplicitMethodCapabilityFailure(message, error)
    || isHistoricalObjectCapabilityFailure(operation, message, error)
    || (operation === "eth_getLogs"
      && !isGlobalRateLimit(message, error)
      && /\blimit exceeded\b|archive requests require|missing trie node|block range|range (?:is )?too (?:large|wide)|too many (?:logs|results)|response size|header not found|block not found/i.test(message));
  const isTransientMethodTimeout = (_operation, message) => /timed out|\btimeout\b|operation was aborted/i.test(message);
  const isMethodAccessFailure = (_operation, message, error = null) => !isGlobalRateLimit(message, error)
    && (rpcStatusCode(error) === 403 || /\b403\b|forbidden|unauthorized/i.test(message));
  const exponentialCooldown = (base, count, maximum) => Math.min(maximum, base * (2 ** Math.min(Math.max(0, count - 1), 10)));
  const recordFailureCooldown = (circuits, index, operation, error) => {
    const message = error?.info?.error?.message || error?.error?.message || error?.shortMessage || error?.message || "unknown error";
    const current = clockNow();
    const rateLimited = isGlobalRateLimit(message, error);
    const methodScoped = isMethodScopedFailure(operation, message, error)
      || isTransientMethodTimeout(operation, message)
      || isMethodAccessFailure(operation, message, error);
    if (error && typeof error === "object") {
      error.rpcOperation = operation;
      error.rpcFailureScope = methodScoped ? "method" : "host";
    }
    const circuit = circuits[index];
    const method = methodCircuit(circuit, operation, methodScoped);
    const failureCount = methodScoped
      ? Number(method.failures || 0) + 1
      : Number(circuit.globalFailures || 0) + 1;
    const persistentMethodCapabilityFailure = isExplicitMethodCapabilityFailure(message, error)
      || (isHistoricalObjectCapabilityFailure(operation, message, error)
        && /archive requests require|missing trie node|not supported/i.test(message))
      || (operation === "eth_getLogs"
        && !rateLimited
        && /\blimit exceeded\b|archive requests require/i.test(message));
    const transientMethodTimeout = isTransientMethodTimeout(operation, message);
    const declaredRetryAfterMs = rateLimited ? retryAfterDelayMs(error, current) : 0;
    const computedDelayMs = persistentMethodCapabilityFailure
      ? 30 * 60_000
      : transientMethodTimeout
        ? exponentialCooldown(Math.max(1_000, Math.min(5_000, requestTimeoutMs)), failureCount, 60_000)
        : rateLimited
          ? exponentialCooldown(5_000, failureCount, 5 * 60_000)
          : methodScoped ? 60_000 : exponentialCooldown(5_000, failureCount, 60_000);
    const retryAt = current + Math.max(computedDelayMs, declaredRetryAfterMs);
    if (methodScoped) {
      method.failures = failureCount;
      method.generation = Number(method.generation || 0) + 1;
      method.until = Math.max(Number(method.until || 0), retryAt);
    } else {
      circuit.globalFailures = failureCount;
      circuit.globalGeneration = Number(circuit.globalGeneration || 0) + 1;
      circuit.globalUntil = Math.max(Number(circuit.globalUntil || 0), retryAt);
    }
    return message;
  };
  const circuitFailed = (circuits, index, operation) => {
    const circuit = circuits[index];
    return Number(circuit?.globalFailures || 0) > 0
      || Number(methodCircuit(circuit, operation)?.failures || 0) > 0;
  };
  const circuitGeneration = (circuits, index, operation) => ({
    global: Number(circuits[index]?.globalGeneration || 0),
    method: Number(methodCircuit(circuits[index], operation)?.generation || 0),
  });
  const clearCircuit = (circuits, index, operation, expectedGeneration) => {
    const circuit = circuits[index];
    if (Number(circuit.globalGeneration || 0) === Number(expectedGeneration.global || 0)) {
      circuit.globalUntil = 0;
      circuit.globalFailures = 0;
    }
    const method = methodCircuit(circuit, operation);
    if (method && Number(method.generation || 0) === Number(expectedGeneration.method || 0)) {
      method.until = 0;
      method.failures = 0;
    }
  };
  const recoveryProbeKey = (circuits, index, operation) => {
    const circuit = circuits[index];
    // A 429 opens the physical-host circuit, so its half-open lease must also
    // be shared across methods and pools. Method-only failures retain an
    // independent host+operation probe.
    return `${circuit?.host || index}:${Number(circuit?.globalFailures || 0) > 0 ? "*" : operation}`;
  };
  const retryDelayForCircuits = (capable, circuits, operation) => {
    const current = clockNow();
    const earliestCircuit = Math.min(...capable.map((index) => Math.max(
      cooldownUntil(circuits, index, operation),
      Number(hostMethodRecoveryProbeAfter.get(recoveryProbeKey(circuits, index, operation)) || 0),
    )));
    return Math.max(1, earliestCircuit - current);
  };
  const acquireRecoveryProbe = (circuits, index, operation) => {
    const key = recoveryProbeKey(circuits, index, operation);
    if (hostMethodRecoveryProbeInFlight.has(key)) return null;
    const lease = Symbol(key);
    hostMethodRecoveryProbeInFlight.set(key, lease);
    return { key, lease };
  };
  const releaseRecoveryProbe = (probe) => {
    if (probe && hostMethodRecoveryProbeInFlight.get(probe.key) === probe.lease) {
      hostMethodRecoveryProbeInFlight.delete(probe.key);
    }
  };
  const recoveryProbeBusyError = (operation, current, probeBlockedUntil = 0, failureScope = "method") => {
    const retryInMs = Math.max(
      1,
      Number(probeBlockedUntil || 0) - current,
      recoveryProbeIntervalMs,
    );
    const error = new Error(`${operation} failed on every BSC RPC: recovery probe already in flight; retry in ${retryInMs}ms`);
    error.code = "SERVER_ERROR";
    error.retryAfterMs = retryInMs;
    error.rpcOperation = operation;
    error.rpcFailureScope = failureScope;
    return error;
  };
  const invokeWithTimeout = async (operation, label) => {
    let timeout;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            const error = new Error(`${label} timed out after ${requestTimeoutMs}ms`);
            error.code = "TIMEOUT";
            reject(error);
          }, requestTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const withStandardSlot = async (operation) => {
    if (activeStandardRequests >= standardConcurrency) await new Promise((resolve) => standardWaiters.push(resolve));
    activeStandardRequests += 1;
    try { return await operation(); }
    finally {
      activeStandardRequests -= 1;
      standardWaiters.shift()?.();
    }
  };
  const invoke = (method, args) => withStandardSlot(async () => {
    const operation = operationName(method, args);
    const errors = [];
    const failureScopes = [];
    const start = nextProvider++ % providers.length;
    const rotated = providers.map((_, offset) => (start + offset) % providers.length);
    const capable = orderForOperation(rotated, operation, unique, args);
    if (!capable.length) {
      const error = new Error(`${operation} failed on every BSC RPC: no log-capable standard providers configured`);
      error.code = "SERVER_ERROR";
      error.rpcOperation = operation;
      error.rpcFailureScope = "method";
      throw error;
    }
    const current = clockNow();
    const available = capable.filter((index) => cooldownUntil(providerCircuits, index, operation) <= current);
    if (!available.length) {
      const retryInMs = retryDelayForCircuits(capable, providerCircuits, operation);
      const error = new Error(`${operation} failed on every BSC RPC: providers cooling down; retry in ${retryInMs}ms`);
      error.code = "SERVER_ERROR";
      error.retryAfterMs = retryInMs;
      error.rpcOperation = operation;
      error.rpcFailureScope = capable.every((index) => Number(providerCircuits[index]?.globalUntil || 0) > current)
        ? "host"
        : "method";
      throw error;
    }
    const closed = available.filter((index) => !circuitFailed(providerCircuits, index, operation));
    // Closed endpoints retain the existing ordered fallback. Once every host
    // has an open circuit, probe one due physical host per invocation. Probe
    // leases and cooldowns are keyed by host+method, so a slow historical
    // state probe on host A cannot suppress a ready host B (or its log lane).
    const recoveryProbe = closed.length === 0;
    const probeIndex = recoveryProbe ? available.find((index) => {
      const key = recoveryProbeKey(providerCircuits, index, operation);
      return Number(hostMethodRecoveryProbeAfter.get(key) || 0) <= current
        && !hostMethodRecoveryProbeInFlight.has(key);
    }) : null;
    if (recoveryProbe && probeIndex === undefined) {
      const blockedUntil = Math.min(...available.map((index) => {
        const key = recoveryProbeKey(providerCircuits, index, operation);
        return hostMethodRecoveryProbeInFlight.has(key)
          ? current + recoveryProbeIntervalMs
          : Math.max(current + 1, Number(hostMethodRecoveryProbeAfter.get(key) || 0));
      }));
      const failureScope = available.every((index) => Number(providerCircuits[index]?.globalUntil || 0) <= current
        && Number(providerCircuits[index]?.globalFailures || 0) > 0) ? "host" : "method";
      throw recoveryProbeBusyError(operation, current, blockedUntil, failureScope);
    }
    const order = recoveryProbe ? [probeIndex] : closed;
    const recoveryProbeLease = recoveryProbe ? acquireRecoveryProbe(providerCircuits, probeIndex, operation) : null;
    if (recoveryProbe && !recoveryProbeLease) {
      throw recoveryProbeBusyError(operation, current, current + recoveryProbeIntervalMs);
    }
    try {
      for (const index of order) {
        const generationAtStart = circuitGeneration(providerCircuits, index, operation);
        try {
          const result = await invokeWithTimeout(
            () => providers[index][method](...args),
            `${operation} ${new URL(unique[index]).host}`,
          );
          if (result == null && NULL_RETRY_RPC_METHODS.has(method)) throw new Error(`${method} returned null for finalized BSC data`);
          const probeKeyAtStart = recoveryProbeLease?.key || recoveryProbeKey(providerCircuits, index, operation);
          clearCircuit(providerCircuits, index, operation, generationAtStart);
          hostMethodRecoveryProbeAfter.delete(probeKeyAtStart);
          return result;
        } catch (error) {
          if (NON_RETRYABLE_RPC_CODES.has(error.code)) throw error;
          recordFailureCooldown(providerCircuits, index, operation, error);
          failureScopes.push(error?.rpcFailureScope || null);
          errors.push(`${new URL(unique[index]).host}: ${errorSummary(error)}`);
        }
      }
      if (recoveryProbe && probeIndex !== undefined) {
        hostMethodRecoveryProbeAfter.set(
          recoveryProbeLease?.key || recoveryProbeKey(providerCircuits, probeIndex, operation),
          clockNow() + recoveryProbeIntervalMs,
        );
      }
      const error = new Error(`${operation} failed on every BSC RPC: ${errors.join("; ")}`);
      error.code = "SERVER_ERROR";
      error.retryAfterMs = retryDelayForCircuits(capable, providerCircuits, operation);
      error.rpcOperation = operation;
      error.rpcFailureScope = failureScopes.length > 0 && failureScopes.every((scope) => scope === "host")
        ? "host"
        : "method";
      throw error;
    } finally {
      releaseRecoveryProbe(recoveryProbeLease);
    }
  });
  const withArchiveSlot = async (operation) => {
    if (activeArchiveRequests >= archiveConcurrency) await new Promise((resolve) => archiveWaiters.push(resolve));
    activeArchiveRequests += 1;
    try { return await operation(); }
    finally {
      activeArchiveRequests -= 1;
      archiveWaiters.shift()?.();
    }
  };
  const invokeArchive = (method, args) => withArchiveSlot(async () => {
    const operation = operationName(method, args);
    const errors = [];
    const failureScopes = [];
    const start = nextArchiveProvider++ % archiveProviders.length;
    const rotated = archiveProviders.map((_, offset) => (start + offset) % archiveProviders.length);
    const capable = orderForOperation(rotated, operation, archiveUnique, args);
    if (!capable.length) {
      const error = new Error(`${operation} failed on every BSC archive RPC: no capable archive providers configured`);
      error.code = "SERVER_ERROR";
      error.rpcOperation = operation;
      error.rpcFailureScope = "method";
      throw error;
    }
    const current = clockNow();
    const available = capable.filter((index) => cooldownUntil(archiveCircuits, index, operation) <= current);
    const closed = available.filter((index) => !circuitFailed(archiveCircuits, index, operation));
    if (!available.length) {
      const retryInMs = retryDelayForCircuits(capable, archiveCircuits, operation);
      const error = new Error(`${operation} archive RPCs are cooling down; retry in ${retryInMs}ms`);
      error.code = "SERVER_ERROR";
      error.retryAfterMs = retryInMs;
      error.rpcOperation = operation;
      error.rpcFailureScope = capable.every((index) => Number(archiveCircuits[index]?.globalUntil || 0) > current)
        ? "host"
        : "method";
      throw error;
    }
    const recoveryProbe = closed.length === 0;
    const probeIndex = recoveryProbe ? available.find((index) => {
      const key = recoveryProbeKey(archiveCircuits, index, operation);
      return Number(hostMethodRecoveryProbeAfter.get(key) || 0) <= current
        && !hostMethodRecoveryProbeInFlight.has(key);
    }) : null;
    if (recoveryProbe && probeIndex === undefined) {
      const blockedUntil = Math.min(...available.map((index) => {
        const key = recoveryProbeKey(archiveCircuits, index, operation);
        return hostMethodRecoveryProbeInFlight.has(key)
          ? current + recoveryProbeIntervalMs
          : Math.max(current + 1, Number(hostMethodRecoveryProbeAfter.get(key) || 0));
      }));
      const failureScope = available.every((index) => Number(archiveCircuits[index]?.globalUntil || 0) <= current
        && Number(archiveCircuits[index]?.globalFailures || 0) > 0) ? "host" : "method";
      throw recoveryProbeBusyError(operation, current, blockedUntil, failureScope);
    }
    const order = recoveryProbe ? [probeIndex] : closed;
    const recoveryProbeLease = recoveryProbe ? acquireRecoveryProbe(archiveCircuits, probeIndex, operation) : null;
    if (recoveryProbe && !recoveryProbeLease) {
      throw recoveryProbeBusyError(operation, current, current + recoveryProbeIntervalMs);
    }
    try {
      for (const index of order) {
        const generationAtStart = circuitGeneration(archiveCircuits, index, operation);
        try {
          const result = await invokeWithTimeout(
            () => archiveProviders[index][method](...args),
            `${operation} ${new URL(archiveUnique[index]).host}`,
          );
          if (result == null && NULL_RETRY_RPC_METHODS.has(method)) throw new Error(`${method} returned null for finalized BSC data`);
          const probeKeyAtStart = recoveryProbeLease?.key || recoveryProbeKey(archiveCircuits, index, operation);
          clearCircuit(archiveCircuits, index, operation, generationAtStart);
          hostMethodRecoveryProbeAfter.delete(probeKeyAtStart);
          return result;
        } catch (error) {
          recordFailureCooldown(archiveCircuits, index, operation, error);
          failureScopes.push(error?.rpcFailureScope || null);
          errors.push(`${new URL(archiveUnique[index]).host}: ${errorSummary(error)}`);
        }
      }
      if (recoveryProbe && probeIndex !== undefined) {
        hostMethodRecoveryProbeAfter.set(
          recoveryProbeLease?.key || recoveryProbeKey(archiveCircuits, probeIndex, operation),
          clockNow() + recoveryProbeIntervalMs,
        );
      }
      const error = new Error(`${operation} failed on every BSC archive RPC: ${errors.join("; ")}`);
      error.code = "SERVER_ERROR";
      error.retryAfterMs = retryDelayForCircuits(capable, archiveCircuits, operation);
      error.rpcOperation = operation;
      error.rpcFailureScope = failureScopes.length > 0 && failureScopes.every((scope) => scope === "host")
        ? "host"
        : "method";
      throw error;
    } finally {
      releaseRecoveryProbe(recoveryProbeLease);
    }
  });
  const combinedRpcError = (message, ...causes) => {
    const error = new Error(message);
    error.code = "SERVER_ERROR";
    const retryAfterMs = Math.max(0, ...causes.map((cause) => Number(cause?.retryAfterMs) || 0));
    if (retryAfterMs > 0) error.retryAfterMs = retryAfterMs;
    const scopes = causes.map((cause) => cause?.rpcFailureScope).filter(Boolean);
    if (scopes.length) error.rpcFailureScope = scopes.every((scope) => scope === "host") ? "host" : "method";
    error.rpcOperation = causes.find((cause) => cause?.rpcOperation)?.rpcOperation || null;
    return error;
  };
  const invokeArchiveFirst = async (method, args) => {
    let archiveError = null;
    if (archiveProviders.length) {
      try { return await invokeArchive(method, args); }
      catch (error) { archiveError = error; }
    }
    try { return await invoke(method, args); }
    catch (error) {
      if (!archiveError) throw error;
      throw combinedRpcError(
        `${errorSummary(error)}; archive fallback: ${errorSummary(archiveError)}`,
        error,
        archiveError,
      );
    }
  };
  const invokeState = async (method, args, blockIndex, resolveBlockTag = null) => {
    const blockTag = typeof resolveBlockTag === "function" ? resolveBlockTag(args) : args[blockIndex];
    const historical = blockTag !== null && blockTag !== undefined && blockTag !== "latest";
    let archiveError = null;
    if (historical && archiveProviders.length) {
      try { return await invokeArchive(method, args); }
      catch (error) { archiveError = error; }
    }
    try { return await invoke(method, args); }
    catch (error) {
      if (!archiveError) throw error;
      throw combinedRpcError(
        `${errorSummary(error)}; archive fallback: ${errorSummary(archiveError)}`,
        error,
        archiveError,
      );
    }
  };
  const invokeLogs = async (args) => {
    let archiveError = null;
    if (archiveProviders.length) {
      try {
        const result = await invokeArchive("send", args);
        if (!Array.isArray(result)) throw new Error("eth_getLogs archive RPC returned a non-array result");
        return result;
      }
      catch (error) { archiveError = error; }
    }
    try {
      const result = await invoke("send", args);
      if (!Array.isArray(result)) throw new Error("eth_getLogs standard RPC returned a non-array result");
      return result;
    }
    catch (error) {
      if (!archiveError) throw error;
      throw combinedRpcError(
        `${errorSummary(error)}; log-capable archive fallback: ${errorSummary(archiveError)}`,
        error,
        archiveError,
      );
    }
  };
  return {
    getNetwork: (...args) => invoke("getNetwork", args),
    getBlockNumber: (...args) => invoke("getBlockNumber", args),
    getTransaction: (...args) => invoke("getTransaction", args),
    getTransactionReceipt: (...args) => invoke("getTransactionReceipt", args),
    getBlock: (...args) => invoke("getBlock", args),
    getHistoricalTransaction: (...args) => invokeArchiveFirst("getTransaction", args),
    getHistoricalTransactionReceipt: (...args) => invokeArchiveFirst("getTransactionReceipt", args),
    getHistoricalBlock: (...args) => invokeArchiveFirst("getBlock", args),
    getCode: (...args) => invokeState("getCode", args, 1),
    getStorage: (...args) => invokeState("getStorage", args, 2),
    call: (...args) => Object.prototype.hasOwnProperty.call(args[0] || {}, "blockTag")
      ? invokeState("call", args, 0, (callArgs) => callArgs[0]?.blockTag)
      : invoke("call", args),
    send: (method, ...args) => method === "eth_getLogs"
      ? invokeLogs([method, ...args])
      : invoke("send", [method, ...args]),
    destroy: () => [...providers, ...archiveProviders].forEach((provider) => provider.destroy?.()),
    hosts: unique.map((url) => new URL(url).host),
    archiveHosts: archiveUnique.map((url) => new URL(url).host),
  };
}

export function createBscLaunchpadMonitor(config, dependencies = {}) {
  const provider = dependencies.provider || createRpcPool(
    config.bscRpcUrls || [config.bscRpcUrl],
    config.bscArchiveRpcUrls || [],
    config.bscArchiveConcurrency || 4,
    {
      requestTimeoutMs: config.bscRpcRequestTimeoutMs,
      standardConcurrency: config.bscRpcConcurrency,
    },
  );
  const realtimeProvider = dependencies.realtimeProvider || (dependencies.provider ? provider : createRpcPool(
    config.bscRealtimeRpcUrls || config.bscRpcUrls || [config.bscRpcUrl],
    [],
    1,
    {
      requestTimeoutMs: config.bscRealtimeRpcRequestTimeoutMs || Math.min(4_000, config.bscRpcRequestTimeoutMs || 7_000),
      standardConcurrency: config.bscRealtimeRpcConcurrency || 4,
    },
  ));
  const WebSocketImpl = dependencies.WebSocketImpl || globalThis.WebSocket;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const fourMemeFastReplayFetchImpl = dependencies.fourMemeFastReplayFetchImpl || fetchImpl;
  // Unit/integration fixtures normally inject a synthetic provider. Keep the
  // direct PublicNode lane off for those fixtures unless they explicitly
  // inject its transport; production creates the provider internally.
  const fourMemeFastReplayEnabled = dependencies.fourMemeFastReplayEnabled
    ?? (!dependencies.provider || typeof dependencies.fourMemeFastReplayFetchImpl === "function");
  const alertSender = dependencies.sendAlertsImpl || sendAlerts;
  const onLaunchpadCandidate = dependencies.onLaunchpadCandidate;
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const stateFile = path.join(config.dataDir, "bsc-launchpad-state.json");
  const stateWalFile = `${stateFile}.wal`;
  const atomicStateWrite = dependencies.atomicWriteImpl || atomicWrite;
  // Existing test fixtures that replace atomicWriteImpl exercise the legacy
  // whole-snapshot boundary. Production and explicit WAL fixtures use the
  // journal by default; this compatibility branch is never selected by a
  // normal deployment.
  const journalPersistenceEnabled = dependencies.forceJournalPersistence === true
    || typeof dependencies.atomicWriteImpl !== "function";
  const journalFs = dependencies.journalFsImpl || fs;
  const journalAppend = dependencies.journalAppendImpl
    || ((file, frame) => appendStateWalFrame(file, frame, journalFs));
  const journalDetachOperations = dependencies.journalDetachOperationsImpl
    || ((operations) => structuredClone(operations));
  const journalCompactSnapshot = dependencies.journalCompactSnapshotImpl
    || ((file, snapshot) => atomicWrite(file, snapshot, journalFs));
  const journalReset = dependencies.journalResetImpl
    || ((file) => replaceStateWalWithEmpty(file, journalFs));
  const journalReplay = dependencies.journalReplayImpl
    || ((file, snapshot) => replayStateWal(file, snapshot, journalFs));
  const journalSetTimeout = dependencies.journalSetTimeoutImpl || setTimeout;
  const journalClearTimeout = dependencies.journalClearTimeoutImpl || clearTimeout;
  const websocketRpcSetTimeout = dependencies.websocketRpcSetTimeoutImpl || setTimeout;
  const websocketRpcClearTimeout = dependencies.websocketRpcClearTimeoutImpl || clearTimeout;
  const websocketProofTimeoutMs = Math.max(1, Math.min(
    BSC_WEBSOCKET_PROOF_TIMEOUT_MS,
    Number(config.bscWebsocketProofTimeoutMs || BSC_WEBSOCKET_PROOF_TIMEOUT_MS),
  ));
  const journalSnapshotIntervalMs = Math.min(
    BSC_STATE_SNAPSHOT_INTERVAL_MS,
    Math.max(1, Number(dependencies.journalSnapshotIntervalMs || BSC_STATE_SNAPSHOT_INTERVAL_MS)),
  );
  const journalWalMaxBytes = Math.min(
    BSC_STATE_WAL_MAX_BYTES,
    Math.max(1, Number(dependencies.journalWalMaxBytes || BSC_STATE_WAL_MAX_BYTES)),
  );
  const healthSetTimeout = dependencies.healthSetTimeoutImpl || setTimeout;
  const healthClearTimeout = dependencies.healthClearTimeoutImpl || clearTimeout;
  const backgroundSetTimeout = dependencies.backgroundSetTimeoutImpl || setTimeout;
  const backgroundClearTimeout = dependencies.backgroundClearTimeoutImpl || clearTimeout;
  const beforeCausalGroupReservation = dependencies.beforeCausalGroupReservationImpl || null;
  const autoStart = dependencies.autoStart !== false;
  const externalAttributionEnabled = dependencies.externalAttribution ?? autoStart;
  const focus3ChainScope = String(config.monitorScope || "").toLowerCase() === "focus3";
  const flapQuoteFirstThreeWindowMax = Math.max(1, Math.floor(Number(
    dependencies.flapQuoteFirstThreeWindowMax ?? FLAP_QUOTE_FIRST_THREE_WINDOW_MAX,
  ) || FLAP_QUOTE_FIRST_THREE_WINDOW_MAX));
  const flapQuoteFirstThreeLifecycleMax = Math.max(1, Math.floor(Number(
    dependencies.flapQuoteFirstThreeLifecycleMax ?? FLAP_QUOTE_FIRST_THREE_LIFECYCLE_MAX,
  ) || FLAP_QUOTE_FIRST_THREE_LIFECYCLE_MAX));
  const queue = new Map();
  const profileCache = new Map();
  // Deliberately process-local: after every restart the first matching launch
  // is fully profiled before persisted fingerprints may use the fast path.
  const warmedKnownOfficialModes = new Set();
  const officialControllerIdentityCache = new Map();
  const blockCache = new Map();
  const blockCacheAbortController = new AbortController();
  let blockCacheGeneration = 0;
  const creationTransactionCache = new Map();
  const openFourPresetCache = new Map();
  const bscScanWaiters = [];
  const existingMintEmitters = new Set(BSC_IGNORED_MINTS);
  const processBatchSize = Math.max(1, Number(config.bscProcessBatchSize || 12));
  const backlogProcessBatchSize = Math.max(1, Math.min(processBatchSize, Number(config.bscBacklogProcessBatchSize || 2)));
  const entryRpcConcurrency = Math.max(1, Number(config.bscEntryRpcConcurrency ?? 4));
  const recoveryBlockConcurrency = Math.max(1, Number(config.bscRecoveryBlockConcurrency ?? 4));
  const bscScanConcurrency = Math.max(1, Number(config.bscScanConcurrency || 2));
  const realtimeTailLookbackBlocks = Math.max(1, Number(config.bscRealtimeTailLookbackBlocks || 64));
  const realtimeTailBatchSize = Math.max(1, Number(config.bscRealtimeTailBatchSize || 10));
  const expectedBlockTimeMs = Math.max(1, Number(config.bscExpectedBlockTimeMs || 450));
  const healthDegradedLagBlocks = Math.max(1, Number(config.bscHealthDegradedLagBlocks || 240));
  const healthCriticalLagBlocks = Math.max(healthDegradedLagBlocks, Number(config.bscHealthCriticalLagBlocks || 2_400));
  const realtimeTailMaxLagBlocks = Math.max(
    realtimeTailLookbackBlocks,
    Number(config.bscRealtimeTailMaxLagBlocks || Math.max(realtimeTailLookbackBlocks * 4, healthDegradedLagBlocks)),
  );
  const focus3ReplayLookbackBlocks = Math.max(2_400, realtimeTailMaxLagBlocks);
  // Once the durable tail is inside a short live window, its isolated RPC
  // pool can keep advancing while the historical pool repairs one bounded
  // gap batch. Requiring a single 10-block window still starves recovery on
  // BSC whenever public RPC latency stays above the sub-second block time.
  const nearHeadRecoveryPermittedRealtimeLagBlocks = bscNearHeadRecoveryPermittedLagBlocks({
    realtimeTailBatchSize,
    realtimeTailMaxLagBlocks,
    expectedBlockTimeMs,
  });
  const recoveryLogBatchSize = Math.max(1, Number(config.bscRecoveryLogBatchSize || 10));
  // Keep the default within the 10-block eth_getLogs limit enforced by the
  // primary public archive endpoint. Deployments with a wider-capable private
  // RPC can still raise this explicitly.
  const nearHeadRecoveryBatchSize = Math.max(1, Number(config.bscNearHeadRecoveryBatchSize || recoveryLogBatchSize));
  const nearHeadRecoverySegmentSize = Math.max(nearHeadRecoveryBatchSize, Number(config.bscNearHeadRecoverySegmentSize || 2_000));
  const realtimePendingMaxEntries = Math.max(1, Math.floor(Number(
    dependencies.realtimePendingMaxEntries || BSC_REALTIME_PENDING_MAX_ENTRIES,
  )));
  const coverageRetryBaseMs = Math.max(100, Number(config.bscCoverageRetryBaseMs || 5_000));
  const coverageRetryMaxMs = Math.max(coverageRetryBaseMs, Number(config.bscCoverageRetryMaxMs || 60_000));
  const nearHeadRecoveryRetryBaseMs = Math.max(100, Number(config.bscNearHeadRecoveryRetryBaseMs || 1_000));
  const nearHeadRecoveryRetryMaxMs = Math.max(nearHeadRecoveryRetryBaseMs, Number(config.bscNearHeadRecoveryRetryMaxMs || coverageRetryMaxMs));
  const nearHeadRecoverySuccessIntervalMs = Math.max(250, Number(config.bscNearHeadRecoverySuccessIntervalMs || 5_000));
  // This file is multi-megabyte in production. Pure checkedAt/head telemetry
  // is bounded to one flush per 30 seconds; cursor, queue, proof, dedup and
  // delivery mutations continue through the immediate save() path below.
  const healthPersistIntervalMs = Math.max(30_000, Number(config.bscHealthPersistIntervalMs || 30_000));
  let activeBscScanRequests = 0;
  let state = null;
  let started = false;
  let startRunning = false;
  let stopped = false;
  let websocket = null;
  let reconnectTimer = null;
  let startRetryTimer = null;
  let watchdogTimer = null;
  let coverageTimer = null;
  let coverageTimerDueAt = 0;
  let realtimeTimer = null;
  let realtimeTimerDueAt = 0;
  let realtimeTailTimer = null;
  let nearHeadRecoveryTimer = null;
  let nearHeadRecoveryTimerDueAt = 0;
  let httpHeadTimer = null;
  let officialPollTimer = null;
  let discoveryPollTimer = null;
  let deferredEvidenceTimer = null;
  let officialCheckRunning = false;
  let discoveryCheckRunning = false;
  let deferredEvidenceRunning = false;
  let httpHeadPollRunning = false;
  let realtimeRunning = false;
  let realtimeRetryAt = 0;
  let realtimeTailRunning = false;
  let realtimeTailRequested = false;
  let realtimeTailRetryAt = 0;
  let nearHeadRecoveryRunning = false;
  let nearHeadRecoveryRequested = false;
  let nearHeadRecoveryRetryAt = 0;
  let nearHeadRecoveryPacedUntil = 0;
  let flapReplayRetryAt = 0;
  let nearHeadNewestSelectionStreak = 0;
  let nearHeadRecoveryAttemptsSinceCoverage = 0;
  let reconnectAttempts = 0;
  let currentHead = 0;
  let desiredCoverage = 0;
  let recoveryTarget = 0;
  let coverageRunning = false;
  let coverageRetryAt = 0;
  let consecutiveHealthyRealtimeTailBatches = 0;
  let backgroundDeepRpcInFlight = false;
  let backgroundDeepRpcNextAt = 0;
  let backgroundDeepHostRetryAt = 0;
  let backgroundOldDeepRpcNextAt = 0;
  const backgroundDeepPreferredLane = { sla: "realtime", fresh: "realtime", old: "realtime" };
  let backgroundFreshDeepRpcStreak = 0;
  let deferredEvidenceWakeTimer = null;
  let deferredEvidenceWakeTimerDueAt = 0;
  let rpcId = 0;
  let fourMemeFastReplayRpcId = 0;
  let persistedCoverage = 0;
  let lastHealthPersistAt = 0;
  let healthTelemetryTimer = null;
  let healthTelemetryRevision = 0;
  let persistedHealthTelemetryRevision = 0;
  const pendingSubscriptions = new Map();
  const subscriptions = new Map();
  const pendingWsRpc = new Map();
  const pendingWsConfirmations = new Map();
  const websocketProofContexts = new Map();
  const websocketProofTasks = new Set();
  const websocketProofReservations = new Set();
  const websocketHttpFallbackRetryAt = new Map();
  let websocketProofCandidateActive = false;
  const requiredSubscriptionKinds = focus3ChainScope ? ["heads", "protocol"] : ["heads", "mints", "protocol"];
  const dynamicOfficialRoots = new Map();
  const officialChildRoots = new Map();
  const singularryCurveRoots = new Map();
  const dynamicFourRootAddresses = new Set();
  const inFlightEntries = new Map();
  const fourMemeReplayFlights = new Map();
  const flapReplayFlights = new Map();
  const flapQuoteFirstThreeReplayFlights = new Map();
  const flapReplayAbortController = new AbortController();
  let flapReplaySweepLock = Promise.resolve();
  const backgroundReplayTasks = new Set();
  const activeObservationProcessors = new Set();
  const pendingEventDeliveries = new Map();
  // Runtime linearization for causal first-token claims. The reservation is
  // created under stateLock only after every durable/in-progress predecessor
  // has been checked; it is intentionally not held across process restarts.
  const causalGroupReservations = new Map();
  let stateLock = Promise.resolve();
  let saveLock = Promise.resolve();
  let stateRevision = 0;
  let requestedSaveRevision = 0;
  let persistedSaveRevision = 0;
  let saveWriterRunning = false;
  let saveWaiters = [];
  let durableJournalState = null;
  let journalRevision = 0;
  let journalWalBytes = 0;
  let lastJournalSnapshotAt = 0;
  let journalCompactionTimer = null;
  let journalCompactionTimerDueAt = 0;
  let journalCompactionTask = Promise.resolve();
  let journalIoLock = Promise.resolve();
  let journalWritePoisonedError = null;
  let journalResetPoisonedError = null;
  let initializePromise = null;
  let stopPromise = null;
  let providerDestroyPromise = null;
  let wsOpenedAt = 0;
  let lastTailFailureFingerprint = null;
  let lastTailFailureLoggedAt = 0;
  let suppressedTailFailureLogs = 0;
  let lastNearHeadFailureFingerprint = null;
  let lastNearHeadFailureLoggedAt = 0;
  let suppressedNearHeadFailureLogs = 0;
  let lastRealtimeFailureFingerprint = null;
  let lastRealtimeFailureLoggedAt = 0;
  let suppressedRealtimeFailureLogs = 0;
  let lastFlapReplayFailureFingerprint = null;
  let lastFlapReplayFailureLoggedAt = 0;
  let suppressedFlapReplayFailureLogs = 0;

  const backgroundDeepPriorityEnabled = () => focus3ChainScope && started;

  const currentDeepRpcPriority = () => bscDeepRpcPriority({
    realtimeTailRunning,
    realtimeTailNextBlock: state?.realtimeTailNextBlock,
    confirmedBlock: Math.max(0, currentHead - (config.bscConfirmations ?? 2)),
    realtimeTailStatus: state?._health?.realtimeTail?.status,
    realtimeTailBackpressure: state?._health?.realtimeTail?.backpressureReason,
    consecutiveHealthyTailBatches: consecutiveHealthyRealtimeTailBatches,
    nearHeadGapCount: state?.nearHeadRecoveryGaps?.length || 0,
  });

  const isFreshBackgroundEntry = (entry, confirmedBlock, current = Number(now())) => {
    const freshWindowBlocks = Math.max(
      realtimeTailLookbackBlocks,
      Math.ceil(BSC_DEEP_RPC_FRESH_WINDOW_MS / expectedBlockTimeMs),
    );
    const freshFromBlock = Math.max(0, Number(confirmedBlock) - freshWindowBlocks + 1);
    const deliveryStartedAt = Date.parse(entry?.deliverySla?.startedAt || "");
    return Number(entry?.blockNumber) >= freshFromBlock
      || (Number.isFinite(deliveryStartedAt)
        && deliveryStartedAt >= current - BSC_DEEP_RPC_FRESH_WINDOW_MS);
  };

  const backgroundDeliveryDeadline = (entry) => {
    const deadline = Date.parse(entry?.deliverySla?.deadlineAt || "");
    return Number.isFinite(deadline) && deadline > 0 ? deadline : Number.POSITIVE_INFINITY;
  };

  const hasActiveBackgroundDeliverySla = (entry, current) =>
    backgroundDeliveryDeadline(entry) > current
    && Number.isFinite(backgroundDeliveryDeadline(entry));

  const backgroundFeatureKeys = (entry) => [
    entry?.featureActivationReplayKey ? `feature:${entry.featureActivationReplayKey}` : null,
    entry?.flapQuoteFirstThreeReplayGenerationKey
      ? `first3:${entry.flapQuoteFirstThreeReplayGenerationKey}`
      : null,
    ...normalizeBscCausalBarrierKeys(entry?.causalBarrierKeys),
  ].filter(Boolean);

  const outstandingCausalEntries = () => {
    const records = new Map();
    for (const record of [
      ...Object.values(state?.realtimePendingEntries || {}),
      ...Object.values(state?.deferredCreationEvidence || {}),
      // recoverLogRange populates queue before the state/WAL handoff. Official
      // raw-evidence barriers in that interval must block a later fast claim.
      ...[...queue.values()].filter((entry) => backgroundFeatureKeys(entry).length),
    ]) {
      const transactionHash = normalizeTransactionHash(record?.transactionHash);
      if (!/^0x[0-9a-f]{64}$/.test(transactionHash)
        || state?.seenTransactions?.[transactionHash]) continue;
      const previous = records.get(transactionHash);
      if (!previous) {
        records.set(transactionHash, {
          ...record,
          transactionHash,
          causalBarrierKeys: normalizeBscCausalBarrierKeys(record?.causalBarrierKeys),
        });
        continue;
      }
      previous.causalBarrierKeys = normalizeBscCausalBarrierKeys([
        ...(previous.causalBarrierKeys || []),
        ...(record.causalBarrierKeys || []),
      ]);
      for (const field of ["featureActivationReplayKey", "flapQuoteFirstThreeReplayGenerationKey"]) {
        if (previous[field] && record?.[field] && previous[field] !== record[field]) {
          throw new Error(`BSC causal key conflict for ${transactionHash} ${field}`);
        }
        previous[field] ||= record?.[field] || null;
      }
      if (compareBscQueueEntries(record, previous) < 0) {
        previous.blockNumber = record.blockNumber;
        previous.transactionIndex = record.transactionIndex;
        previous.logIndex = record.logIndex;
      }
    }
    return [...records.values()];
  };

  const isDurableBackgroundQueueEntry = (entry) => {
    if (state?.realtimePendingEntries?.[entry.transactionHash]) return true;
    const migration = (state?.migrationReplayTransactions || []).find((record) =>
      normalizeTransactionHash(record?.transactionHash) === entry.transactionHash
      && Number(record?.blockNumber) === Number(entry.blockNumber));
    if (!migration || !entry.reasons?.has?.("v5_targeted_causal_attribution")) return false;
    const candidates = new Set([...(entry.candidateTokens || [])].map((value) => String(value).toLowerCase()));
    const verified = new Set([...(entry.verifiedNewContracts || [])].map((value) => String(value).toLowerCase()));
    const tokens = [...new Set((migration.tokens || []).map((value) => String(value).toLowerCase()))];
    return tokens.length > 0 && tokens.every((token) => ADDRESS.test(token)
      && candidates.has(token)
      && verified.has(token));
  };

  const isDurableCausalGroupHead = (entry) => {
    const keys = backgroundFeatureKeys(entry);
    if (!keys.length) return true;
    const transactionHash = normalizeTransactionHash(entry?.transactionHash);
    const outstanding = outstandingCausalEntries();
    for (const key of keys) {
      const reservation = causalGroupReservations.get(key);
      if (reservation) {
        if (reservation.transactionHash !== transactionHash) return false;
        continue;
      }
      const head = outstanding
        .filter((record) => backgroundFeatureKeys(record).includes(key))
        .sort(compareBscQueueEntries)[0];
      if (head && normalizeTransactionHash(head.transactionHash) !== transactionHash) return false;
    }
    return true;
  };

  const reserveDurableCausalGroups = (entry) => {
    const transactionHash = normalizeTransactionHash(entry?.transactionHash);
    const keys = backgroundFeatureKeys(entry);
    if (!keys.length) return { transactionHash, keys: [] };
    if (!isDurableCausalGroupHead(entry)) return null;
    for (const key of keys) {
      const current = causalGroupReservations.get(key);
      if (current && current.transactionHash !== transactionHash) return null;
    }
    const reservation = { transactionHash, keys, nonce: Symbol(transactionHash) };
    for (const key of keys) causalGroupReservations.set(key, reservation);
    return reservation;
  };

  const releaseDurableCausalGroups = (reservation) => {
    for (const key of reservation?.keys || []) {
      if (causalGroupReservations.get(key)?.nonce === reservation.nonce) {
        causalGroupReservations.delete(key);
      }
    }
  };

  const compareBackgroundEntries = (left, right) => {
    const leftGroups = backgroundFeatureKeys(left);
    const rightGroups = new Set(backgroundFeatureKeys(right));
    if (leftGroups.some((key) => rightGroups.has(key))) return compareBscQueueEntries(left, right);
    return backgroundDeliveryDeadline(left) - backgroundDeliveryDeadline(right)
      || compareBscQueueEntries(left, right)
      || Date.parse(left?.nextAttemptAt || 0) - Date.parse(right?.nextAttemptAt || 0);
  };

  const resetRealtimeTailDeepReadiness = () => {
    consecutiveHealthyRealtimeTailBatches = 0;
  };

  const recordRealtimeTailDeepReadiness = () => {
    const priority = bscDeepRpcPriority({
      realtimeTailRunning: false,
      realtimeTailNextBlock: state?.realtimeTailNextBlock,
      confirmedBlock: Math.max(0, currentHead - (config.bscConfirmations ?? 2)),
      realtimeTailStatus: state?._health?.realtimeTail?.status,
      realtimeTailBackpressure: state?._health?.realtimeTail?.backpressureReason,
      consecutiveHealthyTailBatches: consecutiveHealthyRealtimeTailBatches,
      nearHeadGapCount: state?.nearHeadRecoveryGaps?.length || 0,
    });
    if (priority.tailPriority || state?._health?.realtimeTail?.status !== "healthy") {
      resetRealtimeTailDeepReadiness();
      return;
    }
    consecutiveHealthyRealtimeTailBatches = Math.min(
      BSC_DEEP_RPC_HEALTHY_TAIL_BATCHES,
      consecutiveHealthyRealtimeTailBatches + 1,
    );
  };

  const backgroundDeepEligibility = (current = Number(now())) => {
    const durableTailConfirmed = Number.isSafeInteger(Number(state?.realtimeTailNextBlock))
      ? Math.max(0, Number(state.realtimeTailNextBlock) - 1)
      : 0;
    const confirmed = Math.max(
      0,
      currentHead - (config.bscConfirmations ?? 2),
      durableTailConfirmed,
    );
    const priority = currentDeepRpcPriority();
    const allQueued = [...queue.values()]
      .filter((entry) => Number(entry.blockNumber) <= confirmed
        && !state?.seenTransactions?.[entry.transactionHash]
        // Every focus3 background candidate must cross a checksummed state/WAL
        // handoff before deep reads or alerting. recoverLogRange also populates
        // the process-local queue, so filtering only during capacity errors
        // would let a failed history/tail commit leak an un-durable candidate.
        && isDurableBackgroundQueueEntry(entry));
    const allDeferredForDependencies = Object.values(state?.deferredCreationEvidence || {});
    const featureHeads = new Map();
    const causalGroupDeadlines = new Map();
    for (const entry of [...allQueued, ...allDeferredForDependencies]) {
      for (const key of backgroundFeatureKeys(entry)) {
        const previous = featureHeads.get(key);
        if (!previous || compareBscQueueEntries(entry, previous) < 0) featureHeads.set(key, entry);
        if (hasActiveBackgroundDeliverySla(entry, current)) {
          causalGroupDeadlines.set(key, Math.min(
            causalGroupDeadlines.get(key) ?? Number.POSITIVE_INFINITY,
            backgroundDeliveryDeadline(entry),
          ));
        }
      }
    }
    const effectiveSlaDeadlines = new Map();
    for (const [key, head] of featureHeads) {
      const inheritedDeadline = causalGroupDeadlines.get(key);
      if (!Number.isFinite(inheritedDeadline)) continue;
      effectiveSlaDeadlines.set(head.transactionHash, Math.min(
        effectiveSlaDeadlines.get(head.transactionHash) ?? Number.POSITIVE_INFINITY,
        inheritedDeadline,
      ));
    }
    const effectiveDeadline = (entry) => Math.min(
      backgroundDeliveryDeadline(entry),
      effectiveSlaDeadlines.get(entry.transactionHash) ?? Number.POSITIVE_INFINITY,
    );
    const hasEffectiveSla = (entry) => Number.isFinite(effectiveDeadline(entry))
      && effectiveDeadline(entry) > current;
    const compareEffectiveBackgroundEntries = (left, right) =>
      effectiveDeadline(left) - effectiveDeadline(right)
      || compareBackgroundEntries(left, right);
    const isFeatureHead = (entry) => backgroundFeatureKeys(entry)
      .every((key) => featureHeads.get(key)?.transactionHash === entry.transactionHash);
    const hostCooling = backgroundDeepHostRetryAt > current;
    const queued = (realtimeRetryAt > current || hostCooling ? [] : allQueued)
      .filter((entry) => isFeatureHead(entry)
        && !inFlightEntries.has(entry.transactionHash)
        && !websocketProofReservations.has(entry.transactionHash)
        && Number(websocketHttpFallbackRetryAt.get(entry.transactionHash) || 0) <= current)
      .sort(compareEffectiveBackgroundEntries);
    const queuedCausalGroups = new Set(allQueued.flatMap((entry) => backgroundFeatureKeys(entry)));
    const deferredCapacityUnlocks = allDeferredForDependencies.filter((record) =>
      isFeatureHead(record)
      && backgroundFeatureKeys(record).some((key) => queuedCausalGroups.has(key)));
    // During capacity backpressure, first drain any safe durable pending entry.
    // If every pending entry is causally blocked by an earlier deferred record,
    // admit only that exact group head so the queue can subsequently drain
    // without ever allowing the later first-token candidate to overtake it.
    const allDeferred = hostCooling
      ? []
      : priority.capacityBackpressure
      ? (queued.length > 0 ? [] : deferredCapacityUnlocks)
      : allDeferredForDependencies;
    const deferred = allDeferred
      .filter((record) => isFeatureHead(record)
        && (Date.parse(record.nextAttemptAt || 0) <= current || hasEffectiveSla(record))
        && !inFlightEntries.has(record.transactionHash))
      .sort(compareEffectiveBackgroundEntries);
    return {
      current,
      confirmed,
      hostRetryAt: backgroundDeepHostRetryAt,
      capacityDependencyUnlock: priority.capacityBackpressure && deferred.length > 0,
      effectiveSlaDeadlines,
      priority,
      realtime: {
        sla: queued.filter((entry) => hasEffectiveSla(entry)),
        fresh: queued.filter((entry) => !hasEffectiveSla(entry)
          && isFreshBackgroundEntry(entry, confirmed, current)),
        old: queued.filter((entry) => !hasEffectiveSla(entry)
          && !isFreshBackgroundEntry(entry, confirmed, current)),
      },
      deferred: {
        sla: deferred.filter((entry) => hasEffectiveSla(entry)),
        fresh: deferred.filter((entry) => !hasEffectiveSla(entry)
          && isFreshBackgroundEntry(entry, confirmed, current)),
        old: deferred.filter((entry) => !hasEffectiveSla(entry)
          && !isFreshBackgroundEntry(entry, confirmed, current)),
      },
    };
  };

  const backgroundDeepTarget = (eligibility) => {
    const hasSla = eligibility.realtime.sla.length > 0 || eligibility.deferred.sla.length > 0;
    const hasFresh = eligibility.realtime.fresh.length > 0 || eligibility.deferred.fresh.length > 0;
    const hasOld = eligibility.realtime.old.length > 0 || eligibility.deferred.old.length > 0;
    if (hasSla) return "sla";
    if (!hasFresh && !hasOld) return null;
    const oldDue = eligibility.current >= backgroundOldDeepRpcNextAt;
    // Fresh work always receives the first slot. Once at least one fresh item
    // has run, an already-due old item receives the next slot. With a durable
    // repair gap that old slot is shared by both lanes only once per 30s;
    // without gaps it alternates at the normal 750ms cadence.
    if (hasFresh && (!hasOld || !oldDue || backgroundFreshDeepRpcStreak === 0)) return "fresh";
    return hasOld && oldDue ? "old" : hasFresh ? "fresh" : null;
  };

  const backgroundDeepLane = (eligibility, workClass) => {
    const realtimeReady = eligibility.realtime[workClass]?.length > 0;
    const deferredReady = eligibility.deferred[workClass]?.length > 0;
    if (realtimeReady && deferredReady) {
      if (workClass === "sla") {
        const effectiveDeadline = (entry) => Math.min(
          backgroundDeliveryDeadline(entry),
          eligibility.effectiveSlaDeadlines?.get(entry.transactionHash) ?? Number.POSITIVE_INFINITY,
        );
        const realtimeDeadline = effectiveDeadline(eligibility.realtime.sla[0]);
        const deferredDeadline = effectiveDeadline(eligibility.deferred.sla[0]);
        if (realtimeDeadline !== deferredDeadline) {
          return realtimeDeadline < deferredDeadline ? "realtime" : "deferred";
        }
      }
      return backgroundDeepPreferredLane[workClass];
    }
    if (realtimeReady) return "realtime";
    if (deferredReady) return "deferred";
    return null;
  };

  const backgroundDeepRpcDelayMs = (workClass = null, eligibility = null) => {
    const current = Number(now());
    const snapshot = eligibility || (state ? backgroundDeepEligibility(current) : null);
    let targetClass = workClass || (snapshot ? backgroundDeepTarget(snapshot) : null);
    if (!targetClass && snapshot
      && (snapshot.realtime.old.length > 0 || snapshot.deferred.old.length > 0)) targetClass = "old";
    return Math.max(
      25,
      backgroundDeepRpcNextAt - current,
      backgroundDeepHostRetryAt - current,
      targetClass === "old" && snapshot
        ? backgroundOldDeepRpcNextAt - current
        : 0,
      backgroundDeepRpcInFlight ? BSC_DEEP_RPC_PACE_MS : 0,
    );
  };

  const acquireBackgroundDeepRpc = (lane, workClass, eligibility = null) => {
    const snapshot = eligibility || backgroundDeepEligibility();
    if (!snapshot.priority.allowFreshQueue || backgroundDeepRpcInFlight) return null;
    if (snapshot.current < backgroundDeepHostRetryAt) return null;
    const targetClass = backgroundDeepTarget(snapshot);
    if (targetClass !== workClass || backgroundDeepLane(snapshot, targetClass) !== lane) return null;
    if (snapshot.current < backgroundDeepRpcNextAt) return null;
    if (workClass === "old" && snapshot.current < backgroundOldDeepRpcNextAt) return null;
    backgroundDeepRpcInFlight = true;
    backgroundDeepRpcNextAt = snapshot.current + BSC_DEEP_RPC_PACE_MS;
    if (workClass === "fresh" || workClass === "sla") backgroundFreshDeepRpcStreak += 1;
    else {
      backgroundFreshDeepRpcStreak = 0;
      backgroundOldDeepRpcNextAt = snapshot.current + snapshot.priority.oldDeepIntervalMs;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      backgroundDeepRpcInFlight = false;
      backgroundDeepPreferredLane[workClass] = lane === "realtime" ? "deferred" : "realtime";
    };
  };

  function scheduleDeferredEvidence(delay = 25) {
    if (stopped || deferredEvidenceRunning) return;
    const current = Number(now());
    const requestedDelay = Math.max(25, Number(delay) || 25);
    const dueAt = current + requestedDelay;
    if (deferredEvidenceWakeTimer) {
      if (dueAt >= deferredEvidenceWakeTimerDueAt) return;
      backgroundClearTimeout(deferredEvidenceWakeTimer);
    }
    deferredEvidenceWakeTimerDueAt = dueAt;
    deferredEvidenceWakeTimer = backgroundSetTimeout(() => {
      deferredEvidenceWakeTimer = null;
      deferredEvidenceWakeTimerDueAt = 0;
      void retryDeferredCreationEvidence();
    }, requestedDelay);
    deferredEvidenceWakeTimer.unref?.();
  }

  function wakeBackgroundDeepRpc(delay = 25) {
    if (stopped || !state || !backgroundDeepPriorityEnabled()) return;
    const eligibility = backgroundDeepEligibility();
    if (eligibility.hostRetryAt > eligibility.current) {
      const retryDelay = Math.max(25, eligibility.hostRetryAt - eligibility.current);
      scheduleRealtime(retryDelay);
      scheduleDeferredEvidence(retryDelay);
      return;
    }
    if (!eligibility.priority.allowFreshQueue) {
      if (eligibility.priority.tailPriority) scheduleRealtimeTail();
      return;
    }
    let workClass = backgroundDeepTarget(eligibility);
    if (!workClass) {
      const hasOld = eligibility.realtime.old.length > 0 || eligibility.deferred.old.length > 0;
      if (!hasOld) return;
      workClass = "old";
    }
    if (backgroundDeepRpcInFlight) return;
    const lane = backgroundDeepLane(eligibility, workClass);
    const pacedDelay = Math.max(
      Number(delay) || 25,
      backgroundDeepRpcDelayMs(workClass, eligibility),
    );
    if (lane === "realtime") scheduleRealtime(pacedDelay);
    else if (lane === "deferred") scheduleDeferredEvidence(pacedDelay);
  }

  async function markBackgroundDeepHostRecovered() {
    if (backgroundDeepHostRetryAt <= 0 || Number(now()) < backgroundDeepHostRetryAt) return;
    await withState(async () => {
      if (backgroundDeepHostRetryAt <= 0 || Number(now()) < backgroundDeepHostRetryAt) return;
      backgroundDeepHostRetryAt = 0;
      state._health.backgroundDeepRpc = {
        status: "healthy",
        checkedAt: iso(now),
        lastSuccessAt: iso(now),
        rpcFailureScope: null,
        rpcOperation: null,
        retryDelayMs: null,
        nextRetryAt: null,
      };
      await save();
    });
  }

  const flapReplayStoppedError = () => {
    const error = new Error("Flap activation replay stopped");
    error.code = "BSC_FLAP_REPLAY_STOPPED";
    return error;
  };

  const isFlapReplayStoppedError = (error) => error?.code === "BSC_FLAP_REPLAY_STOPPED";

  const throwIfFlapReplayStopped = (signal = flapReplayAbortController.signal) => {
    if (stopped || signal?.aborted) throw flapReplayStoppedError();
  };

  // Replay RPC reads are safe cancellation boundaries: no state mutation has
  // started yet, and the retained hot-index candidate remains the durable
  // restart cursor. The underlying provider promise still gets fulfillment
  // and rejection handlers so a late socket failure cannot become unhandled.
  const awaitFlapReplayRead = (operation, signal = flapReplayAbortController.signal) => {
    throwIfFlapReplayStopped(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.("abort", onAbort);
        handler(value);
      };
      const onAbort = () => finish(reject, flapReplayStoppedError());
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (signal?.aborted || stopped) {
        onAbort();
        return;
      }
      Promise.resolve()
        .then(() => {
          throwIfFlapReplayStopped(signal);
          return operation();
        })
        .then(
          (value) => finish(resolve, value),
          (error) => finish(reject, error),
        );
    });
  };

  const withState = (operation) => {
    const run = stateLock.catch(() => {}).then(() => {
      stateRevision += 1;
      return operation(stateRevision);
    });
    stateLock = run.catch(() => {});
    return run;
  };
  const settleSaveWaiters = (throughRevision, error = null) => {
    const remaining = [];
    for (const waiter of saveWaiters) {
      if (waiter.revision > throughRevision) {
        remaining.push(waiter);
        continue;
      }
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
    saveWaiters = remaining;
  };

  const runJournalIo = (operation) => {
    const run = journalIoLock.catch(() => {}).then(operation);
    journalIoLock = run.catch(() => {});
    return run;
  };

  const scheduleJournalCompaction = (delayOverride = null) => {
    if (!journalPersistenceEnabled || stopped || journalWalBytes <= 0) return;
    const current = Number(now());
    const regularDelay = Math.max(1, journalSnapshotIntervalMs - Math.max(0, current - lastJournalSnapshotAt));
    const delay = delayOverride === null ? regularDelay : Math.max(1, Number(delayOverride));
    const dueAt = current + delay;
    if (journalCompactionTimer) {
      if (journalCompactionTimerDueAt <= dueAt) return;
      journalClearTimeout(journalCompactionTimer);
      journalCompactionTimer = null;
      journalCompactionTimerDueAt = 0;
    }
    journalCompactionTimer = journalSetTimeout(() => {
      journalCompactionTimer = null;
      journalCompactionTimerDueAt = 0;
      journalCompactionTask = compactStateJournal().catch((error) => {
        logger.error(`[bsc][state-journal] snapshot compaction failed: ${errorSummary(error)}`);
        scheduleJournalCompaction(journalSnapshotIntervalMs);
      });
    }, delay);
    journalCompactionTimerDueAt = dueAt;
    journalCompactionTimer.unref?.();
  };

  const appendCurrentStateToJournal = async () => {
    if (!journalPersistenceEnabled) throw new Error("BSC state journal is disabled");
    if (!durableJournalState) throw new Error("BSC state journal is not initialized");
    if (journalResetPoisonedError) throw journalResetPoisonedError;
    if (journalWritePoisonedError) {
      // An append whose rollback could not be proven leaves this process
      // fail-closed. Re-establish a complete snapshot + empty-WAL barrier
      // before accepting another delta, including when the WAL was empty and
      // no background compaction timer exists.
      await compactStateJournal({ force: true, allowCreate: true });
    }
    if (journalWritePoisonedError) throw journalWritePoisonedError;
    const stateAtSnapshot = state;
    // Freeze the root selection and durable revision synchronously, but do
    // not clone multi-megabyte cold branches that the delta walk will prove
    // unchanged. Some set operations can still point into live state, so
    // detach the complete changed-op set before the first append await.
    const snapshotRoot = { ...stateAtSnapshot, journalRevision };
    const liveOperations = stateDeltaOperations(durableJournalState, snapshotRoot);
    if (!liveOperations.length) return { wrote: false, snapshot: durableJournalState };
    const nextJournalRevision = journalRevision + 1;
    liveOperations.push({ op: "set", path: ["journalRevision"], value: nextJournalRevision });
    const operations = journalDetachOperations(liveOperations);
    const frame = encodeStateWalFrame(nextJournalRevision, operations);
    await runJournalIo(async () => {
      // The revision is allocated from durable state inside the single IO
      // lane. A failed append/fsync leaves both counters untouched.
      if (journalResetPoisonedError) throw journalResetPoisonedError;
      if (journalWritePoisonedError) throw journalWritePoisonedError;
      if (journalRevision + 1 !== nextJournalRevision) throw new Error("stale BSC state WAL revision allocation");
      try {
        await journalAppend(stateWalFile, frame);
      } catch (error) {
        if (error?.walRollbackSafe === false) journalWritePoisonedError = error;
        throw error;
      }
      // The frame is durable before its detached values become the new
      // in-memory baseline. Assigning these values directly is safe: the op
      // set no longer shares references with live state and the encoded frame
      // is already an immutable string.
      durableJournalState = applyStateDeltaOperations(durableJournalState, operations, { cloneSetValues: false });
      journalRevision = nextJournalRevision;
      journalWalBytes += Buffer.byteLength(frame);
    });
    if (state === stateAtSnapshot) state.journalRevision = nextJournalRevision;
    scheduleJournalCompaction(journalWalBytes >= journalWalMaxBytes ? 1 : null);
    return { wrote: true, snapshot: durableJournalState };
  };

  async function compactStateJournal({ force = false, allowCreate = false } = {}) {
    if (!journalPersistenceEnabled || !durableJournalState) return;
    if (!force && journalWalBytes <= 0) return;
    if (!allowCreate) {
      try { await journalFs.stat(stateFile); } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
    }
    const run = runJournalIo(async () => {
      const snapshot = structuredClone(durableJournalState);
      snapshot.journalRevision = journalRevision;
      await journalCompactSnapshot(stateFile, snapshot);
      // Reset only after the snapshot rename and directory fsync. If reset
      // fails, the old WAL remains replayable and <=snapshot revisions are
      // ignored on restart.
      try {
        await journalReset(stateWalFile);
      } catch (error) {
        if (error?.walResetAmbiguous === true) journalResetPoisonedError = error;
        throw error;
      }
      journalResetPoisonedError = null;
      if (force) journalWritePoisonedError = null;
      journalWalBytes = 0;
      lastJournalSnapshotAt = Number(now());
    });
    return run;
  }

  const drainSaveRequests = async () => {
    while (saveWaiters.length) {
      // Capture the newest requested revision and current state together in
      // the actual writer. Calls queued before this point share one clone and
      // one atomic replacement; calls arriving while it is in flight retain a
      // higher revision and wait for the following snapshot.
      const revisionAtSnapshot = requestedSaveRevision;
      const telemetryRevisionAtSnapshot = healthTelemetryRevision;
      let durableSnapshot;
      try {
        if (journalPersistenceEnabled) {
          const persisted = await appendCurrentStateToJournal();
          durableSnapshot = persisted.snapshot;
        } else {
          durableSnapshot = structuredClone(state);
          await atomicStateWrite(stateFile, durableSnapshot);
        }
      } catch (error) {
        // Only requests covered by the failed attempt are rejected. A newer
        // request may already be waiting and is allowed to persist the latest
        // state in the next iteration; a later save also starts a fresh drain.
        settleSaveWaiters(revisionAtSnapshot, error);
        continue;
      }
      persistedSaveRevision = Math.max(persistedSaveRevision, revisionAtSnapshot);
      persistedCoverage = Math.max(persistedCoverage, Number(durableSnapshot?.lastFinalizedBlock || 0));
      persistedHealthTelemetryRevision = Math.max(persistedHealthTelemetryRevision, telemetryRevisionAtSnapshot);
      lastHealthPersistAt = Number(now());
      if (healthTelemetryTimer && persistedHealthTelemetryRevision >= healthTelemetryRevision) {
        healthClearTimeout(healthTelemetryTimer);
        healthTelemetryTimer = null;
      }
      settleSaveWaiters(persistedSaveRevision);
    }
  };

  const ensureSaveWriter = () => {
    if (saveWriterRunning) return;
    saveWriterRunning = true;
    const run = drainSaveRequests().finally(() => {
      saveWriterRunning = false;
      // A request can be queued after the drain observed an empty list but
      // before its finally handler ran. Hand it to a new tracked drain so
      // awaitIdle()/stop cannot return before the durable boundary.
      if (saveWaiters.length) ensureSaveWriter();
    });
    saveLock = run.catch(() => {});
  };

  const save = async (snapshot = state) => {
    // Every current caller installs its draft as the live state before save.
    // Reject a detached snapshot rather than claiming a newer state revision
    // durably contains an object that was never installed.
    if (snapshot !== state) throw new Error("cannot persist a detached BSC state snapshot");
    const revision = ++requestedSaveRevision;
    const persisted = new Promise((resolve, reject) => {
      saveWaiters.push({ revision, resolve, reject });
    });
    ensureSaveWriter();
    return persisted;
  };

  const saveHealthTelemetry = async ({ urgent = false } = {}) => {
    healthTelemetryRevision += 1;
    const current = Number(now());
    const due = !Number.isFinite(lastHealthPersistAt)
      || lastHealthPersistAt <= 0
      || current - lastHealthPersistAt >= healthPersistIntervalMs;
    if (urgent || due) {
      if (healthTelemetryTimer) {
        healthClearTimeout(healthTelemetryTimer);
        healthTelemetryTimer = null;
      }
      await save();
      return;
    }
    if (healthTelemetryTimer) return;
    const delay = Math.max(1, healthPersistIntervalMs - Math.max(0, current - lastHealthPersistAt));
    healthTelemetryTimer = healthSetTimeout(() => {
      healthTelemetryTimer = null;
      void withState(async () => {
        if (stopped || persistedHealthTelemetryRevision >= healthTelemetryRevision) return;
        await save();
      }).catch((error) => logger.error(`[bsc][health-persist] ${errorSummary(error)}`));
    }, delay);
    healthTelemetryTimer.unref?.();
  };

  const logTailFailure = (error) => {
    const summary = errorSummary(error);
    const fingerprint = summary.toLowerCase()
      .replace(/0x[0-9a-f]+/g, "0x#")
      .replace(/\b\d+(?:\.\d+)?(?:ms|s)?\b/g, "#");
    const current = Number(now());
    if (fingerprint !== lastTailFailureFingerprint || current - lastTailFailureLoggedAt >= 60_000) {
      const suffix = suppressedTailFailureLogs ? ` (suppressed=${suppressedTailFailureLogs})` : "";
      logger.error(`[bsc][tail] ${summary}${suffix}`);
      lastTailFailureFingerprint = fingerprint;
      lastTailFailureLoggedAt = current;
      suppressedTailFailureLogs = 0;
      return;
    }
    suppressedTailFailureLogs += 1;
  };

  const resetTailFailureLog = () => {
    lastTailFailureFingerprint = null;
    lastTailFailureLoggedAt = 0;
    suppressedTailFailureLogs = 0;
  };

  const sharedRpcRetryDelayMs = (error) => {
    const retryAfterMs = Number(error?.retryAfterMs);
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return 0;
    if (error?.rpcFailureScope !== "host") return 0;
    return /failed on every BSC (?:archive )?RPC|providers cooling down|archive RPCs are cooling down|recovery probe|rate.?limit|too many requests|\b429\b|timed out|\btimeout\b/i.test(errorSummary(error))
      ? Math.ceil(retryAfterMs)
      : 0;
  };

  const logNearHeadRecoveryFailure = (error) => {
    const summary = errorSummary(error);
    const fingerprint = summary.toLowerCase()
      .replace(/0x[0-9a-f]+/g, "0x#")
      .replace(/\b\d+(?:\.\d+)?(?:ms|s)?\b/g, "#");
    const current = Number(now());
    if (fingerprint !== lastNearHeadFailureFingerprint || current - lastNearHeadFailureLoggedAt >= 60_000) {
      const suffix = suppressedNearHeadFailureLogs ? ` (suppressed=${suppressedNearHeadFailureLogs})` : "";
      logger.error(`[bsc][near-head-gap] ${summary}${suffix}`);
      lastNearHeadFailureFingerprint = fingerprint;
      lastNearHeadFailureLoggedAt = current;
      suppressedNearHeadFailureLogs = 0;
      return;
    }
    suppressedNearHeadFailureLogs += 1;
  };

  const resetNearHeadRecoveryFailureLog = () => {
    lastNearHeadFailureFingerprint = null;
    lastNearHeadFailureLoggedAt = 0;
    suppressedNearHeadFailureLogs = 0;
  };

  const normalizedFailureFingerprint = (error) => errorSummary(error).toLowerCase()
    .replace(/0x[0-9a-f]+/g, "0x#")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)?\b/g, "#");

  const logRealtimeFailure = (error) => {
    const summary = errorSummary(error);
    const fingerprint = normalizedFailureFingerprint(error);
    const current = Number(now());
    if (fingerprint !== lastRealtimeFailureFingerprint || current - lastRealtimeFailureLoggedAt >= 60_000) {
      const suffix = suppressedRealtimeFailureLogs ? ` (suppressed=${suppressedRealtimeFailureLogs})` : "";
      logger.error(`[bsc][realtime] ${summary}${suffix}`);
      lastRealtimeFailureFingerprint = fingerprint;
      lastRealtimeFailureLoggedAt = current;
      suppressedRealtimeFailureLogs = 0;
      return;
    }
    suppressedRealtimeFailureLogs += 1;
  };

  const resetRealtimeFailureLog = () => {
    lastRealtimeFailureFingerprint = null;
    lastRealtimeFailureLoggedAt = 0;
    suppressedRealtimeFailureLogs = 0;
  };

  const logFlapReplayFailure = (activationKey, error) => {
    const summary = errorSummary(error);
    // The physical RPC outage is shared by every activation. Excluding the
    // activation key from this fingerprint prevents one cooling window from
    // producing one copy of the same error per feature.
    const fingerprint = normalizedFailureFingerprint(error);
    const current = Number(now());
    if (fingerprint !== lastFlapReplayFailureFingerprint || current - lastFlapReplayFailureLoggedAt >= 60_000) {
      const suffix = suppressedFlapReplayFailureLogs ? ` (suppressed=${suppressedFlapReplayFailureLogs})` : "";
      logger.error(`[bsc][flap] activation replay ${activationKey}: ${summary}${suffix}`);
      lastFlapReplayFailureFingerprint = fingerprint;
      lastFlapReplayFailureLoggedAt = current;
      suppressedFlapReplayFailureLogs = 0;
      return;
    }
    suppressedFlapReplayFailureLogs += 1;
  };

  const resetFlapReplayFailureLog = () => {
    lastFlapReplayFailureFingerprint = null;
    lastFlapReplayFailureLoggedAt = 0;
    suppressedFlapReplayFailureLogs = 0;
  };

  const trackObservationProcessor = (operation) => {
    let tracked;
    tracked = Promise.resolve().then(operation).finally(() => activeObservationProcessors.delete(tracked));
    activeObservationProcessors.add(tracked);
    return tracked;
  };

  const trackWebsocketProofTask = (operation) => {
    let tracked;
    tracked = Promise.resolve().then(operation).catch(() => {
      // The durable HTTP queue is the authoritative fallback. A fast-path
      // failure must never become an unhandled rejection or close the socket.
      scheduleRealtime();
    }).finally(() => websocketProofTasks.delete(tracked));
    websocketProofTasks.add(tracked);
    return tracked;
  };

  const trackBackgroundReplay = (operation) => {
    let tracked;
    tracked = Promise.resolve().then(operation).catch((error) => {
      logger.error(`[bsc][replay] ${errorSummary(error)}`);
    }).finally(() => backgroundReplayTasks.delete(tracked));
    backgroundReplayTasks.add(tracked);
    return tracked;
  };

  async function withEventDelivery(eventKey, operation) {
    while (true) {
      const existing = pendingEventDeliveries.get(eventKey);
      if (existing) {
        const outcome = await existing;
        if (outcome.ok) return { owner: false, value: outcome.value };
        continue;
      }
      let settle;
      const pending = new Promise((resolve) => { settle = resolve; });
      pendingEventDeliveries.set(eventKey, pending);
      try {
        const value = await operation();
        settle({ ok: true, value });
        return { owner: true, value };
      } catch (error) {
        settle({ ok: false, error });
        throw error;
      } finally {
        if (pendingEventDeliveries.get(eventKey) === pending) pendingEventDeliveries.delete(eventKey);
      }
    }
  }

  async function deliverOfficialEvent(event, commit) {
    return withEventDelivery(event.eventKey, async () => {
      try {
        await alertSender(config, event);
      } catch (error) {
        error.code ||= "ALERT_DELIVERY_PENDING";
        throw error;
      }
      const committed = await withState((revision) => {
        const draft = structuredClone(state);
        const changed = commit(draft, revision) !== false;
        if (!changed) return { savePromise: null, revision };
        state = draft;
        return { savePromise: save(draft), revision };
      });
      if (committed.savePromise) await committed.savePromise;
      return event;
    });
  }

  async function withBscScanSlot(operation) {
    if (activeBscScanRequests >= bscScanConcurrency) await new Promise((resolve) => bscScanWaiters.push(resolve));
    activeBscScanRequests += 1;
    try {
      return await operation();
    } finally {
      activeBscScanRequests -= 1;
      bscScanWaiters.shift()?.();
    }
  }

  function replaceDynamicFourRoots(roots = []) {
    for (const address of dynamicFourRootAddresses) dynamicOfficialRoots.delete(address);
    dynamicFourRootAddresses.clear();
    const fourMeme = publicPlatform(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "fourmeme"));
    const openFour = publicPlatform(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "openfour"));
    for (const root of roots) {
      if (!ADDRESS.test(String(root.address || "").toLowerCase())) continue;
      const address = root.address.toLowerCase();
      dynamicOfficialRoots.set(address, root.name === "OpenFourCore" ? openFour : fourMeme);
      dynamicFourRootAddresses.add(address);
    }
  }

  function runtimeOfficialComponentForAddress(address, snapshot = state) {
    const normalized = String(address || "").toLowerCase();
    if (!ADDRESS.test(normalized)) return null;
    const staticComponent = officialComponentForAddress(normalized);
    if (staticComponent) return staticComponent;

    const flapPlatform = publicPlatform(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "flap"));
    const fourPlatform = publicPlatform(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "fourmeme"));
    const openFourPlatformRecord = publicPlatform(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "openfour"));
    if (normalized === FOUR_MEME_OPENFOUR_REGISTRY) {
      return { platform: fourPlatform, role: "preset_registry", mode: "OpenFour Preset Registry" };
    }
    if (FLAP_OFFICIAL_VAULT_FACTORIES.has(normalized)) {
      return { platform: flapPlatform, role: "vault_factory", mode: FLAP_OFFICIAL_VAULT_FACTORIES.get(normalized) };
    }
    const officialFourRoot = snapshot?.officialSources?.fourMeme?.roots?.[normalized];
    if (officialFourRoot) {
      return {
        platform: officialFourRoot.name === "OpenFourCore" ? openFourPlatformRecord : fourPlatform,
        role: "factory",
        mode: officialFourRoot.name || "Factory/Manager",
      };
    }
    for (const activation of Object.values(snapshot?.officialSources?.flap?.featureActivations || {})) {
      if (String(activation?.vaultFactory || "").toLowerCase() === normalized) {
        return { platform: flapPlatform, role: "vault_factory", mode: activation.category ? `${activation.category} VaultFactory` : "VaultFactory" };
      }
    }
    for (const activation of Object.values(snapshot?.officialSources?.fourMeme?.featureActivations || {})) {
      const template = activation?.template || {};
      const field = BSC_LINKED_MODE_COMPONENT_FIELDS.find((key) => String(template?.[key] || activation?.[key] || "").toLowerCase() === normalized);
      if (field) return { platform: fourPlatform, role: field, mode: `OpenFour ${field}` };
    }
    for (const launcher of Object.values(snapshot?.launchers || {})) {
      const platformId = String(launcher?.platform?.id || "").toLowerCase();
      if (platformId !== "flap" && !isFourMemePlatformId(platformId)) continue;
      for (const mode of Object.values(launcher?.modes || {})) {
        const field = BSC_LINKED_MODE_COMPONENT_FIELDS.find((key) => String(mode?.shape?.[key] || "").toLowerCase() === normalized);
        if (!field) continue;
        return {
          platform: launcher.platform,
          role: field,
          mode: mode.shape?.componentMode || `${launcher.platform?.name || "Launchpad"} ${field}`,
        };
      }
    }
    return null;
  }

  function registerOfficialChildren(children = []) {
    const platform = publicPlatform(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "rugspull"));
    const factory = getAddress(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "rugspull").launchers[0]);
    for (const child of children) {
      const key = child.child.toLowerCase();
      const record = { ...child, child: getAddress(child.child), factory, platform, registeredAt: child.registeredAt || iso(now) };
      officialChildRoots.set(key, record);
      if (state) state.officialChildren[key] = record;
    }
  }

  function registerSingularryCurves(logs = [], details = {}) {
    const records = parseKnownBscLaunchEvidence(logs).filter((item) =>
      item.topic === SINGULARRY_SYSTEM_DEPLOYED_TOPIC
      && item.emitter.toLowerCase() === "0x1b1bd5e6ba84c8354c671ece0a45c9dfbeb7b4ec"
      && item.bondingCurve);
    let changed = false;
    for (const item of records) {
      const key = item.bondingCurve.toLowerCase();
      const record = {
        curve: getAddress(item.bondingCurve),
        token: getAddress(item.token),
        owner: item.creator ? getAddress(item.creator) : null,
        factory: getAddress(item.emitter),
        transactionHash: details.transactionHash || null,
        blockNumber: Number(details.blockNumber || 0) || null,
        registeredAt: details.registeredAt || iso(now),
      };
      singularryCurveRoots.set(key, record);
      if (!state?.singularryCurves?.[key]) changed = true;
      if (state) state.singularryCurves[key] = { ...(state.singularryCurves[key] || {}), ...record };
    }
    return changed;
  }

  function registerSingularryApiCurves(tokens = [], observedAt = iso(now), targetState = state, updateRuntime = true) {
    let changed = false;
    for (const item of tokens) {
      const key = item.curve.toLowerCase();
      const previous = targetState?.singularryCurves?.[key];
      const record = {
        curve: getAddress(item.curve),
        token: getAddress(item.token),
        owner: item.owner ? getAddress(item.owner) : null,
        factory: getAddress("0x1b1bd5e6ba84c8354c671ece0a45c9dfbeb7b4ec"),
        transactionHash: previous?.transactionHash || null,
        blockNumber: previous?.blockNumber || null,
        registeredAt: previous?.registeredAt || observedAt,
        source: "singularry_official_api",
      };
      if (updateRuntime) singularryCurveRoots.set(key, record);
      if (!previous) changed = true;
      if (targetState) targetState.singularryCurves[key] = { ...(previous || {}), ...record };
    }
    return changed;
  }

  const parseRuntimeOfficialLifecycleLog = (log) => parseOfficialBscLifecycleLog(log, { singularryCurves: singularryCurveRoots });

  async function initialize() {
    if (initializePromise) {
      await initializePromise;
      return state;
    }
    if (state) return state;
    if (!initializePromise) initializePromise = (async () => {
      const snapshotMetadata = {};
      let loaded = await readState(stateFile, snapshotMetadata);
      if (journalPersistenceEnabled) {
        const replayed = await journalReplay(stateWalFile, loaded);
        loaded = replayed.state;
        journalRevision = replayed.revision;
        journalWalBytes = replayed.walBytes;
        loaded.journalRevision = journalRevision;
        durableJournalState = structuredClone(loaded);
        let walExists = true;
        try {
          await journalFs.stat(stateWalFile);
          // Resolves a prior process that may have crashed after WAL rename
          // but before the directory barrier. No save promise exists yet.
          await fsyncDirectory(path.dirname(stateWalFile), journalFs);
          journalResetPoisonedError = null;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          walExists = false;
        }
        if (!walExists) {
          // open("a") only fsyncs the file and cannot make a newly-created
          // directory entry durable. Create the empty WAL through the full
          // temp/file-fsync/rename/directory-fsync barrier before any startup
          // normalization delta is allowed to resolve.
          try {
            await journalReset(stateWalFile);
          } catch (error) {
            if (error?.walResetAmbiguous === true) journalResetPoisonedError = error;
            throw error;
          }
          journalResetPoisonedError = null;
          journalWalBytes = 0;
        }
        const current = Number(now());
        try {
          const snapshotStat = await journalFs.stat(stateFile);
          const modifiedAt = Number(snapshotStat.mtimeMs);
          lastJournalSnapshotAt = Number.isFinite(modifiedAt) && modifiedAt > 0 && modifiedAt <= current
            ? modifiedAt
            : current;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          lastJournalSnapshotAt = current;
        }
      }
      state = loaded;
      state.realtimePendingEntries ||= {};
      // WAL frames are replayed after readState(), so an old-process frame can
      // insert a record that never passed the snapshot migration/validator.
      // Revalidate the authoritative post-WAL view before any scheduler can
      // observe it; missing fields become conservative migration work, while
      // malformed or over-capacity arrays fail startup closed.
      for (const collection of [state.realtimePendingEntries, state.deferredCreationEvidence || {}]) {
        for (const record of Object.values(collection || {})) {
          const transactionHash = normalizeTransactionHash(record.transactionHash);
          record.flapCreationHotCandidates = readBscTransactionCreationEvidence(
            record.flapCreationHotCandidates,
            transactionHash,
            `post-WAL ${transactionHash} Flap`,
            normalizeFlapCreationHotIndex,
          );
          record.fourMemeCreationHotCandidates = readBscTransactionCreationEvidence(
            record.fourMemeCreationHotCandidates,
            transactionHash,
            `post-WAL ${transactionHash} Four.Meme`,
            normalizeFourMemeCreationHotIndex,
          );
          if (!Object.hasOwn(record || {}, "causalBarrierKeys")) {
            record.causalBarrierKeys = [];
            record.causalBarrierMigrationPending = true;
          } else {
            record.causalBarrierKeys = readBscCausalBarrierKeys(
              record.causalBarrierKeys,
              `post-WAL ${transactionHash}`,
            );
          }
        }
      }
      compactNearHeadRecoveryState();
      markLegacyLossyFocus3Coverage();
      const persistedRealtimeRetryAt = Date.parse(state._health?.realtimeQueue?.nextRetryAt || "");
      realtimeRetryAt = Number.isFinite(persistedRealtimeRetryAt) && persistedRealtimeRetryAt > now()
        ? persistedRealtimeRetryAt
        : 0;
      const persistedBackgroundHostRetryAt = Date.parse(state._health?.backgroundDeepRpc?.nextRetryAt || "");
      backgroundDeepHostRetryAt = state._health?.backgroundDeepRpc?.rpcFailureScope === "host"
        && Number.isFinite(persistedBackgroundHostRetryAt)
        && persistedBackgroundHostRetryAt > now()
        ? persistedBackgroundHostRetryAt
        : 0;
      const persistedTailRetryAt = Date.parse(state._health?.realtimeTail?.nextRetryAt || "");
      realtimeTailRetryAt = Number.isFinite(persistedTailRetryAt) && persistedTailRetryAt > now()
        ? persistedTailRetryAt
        : 0;
      const persistedNearHeadRetryAt = Date.parse(state._health?.nearHeadRecovery?.sharedRpcRetryAt || "");
      nearHeadRecoveryRetryAt = Number.isFinite(persistedNearHeadRetryAt) && persistedNearHeadRetryAt > now()
        ? persistedNearHeadRetryAt
        : 0;
      const persistedFlapReplayRetryAt = Date.parse(state.officialSources?.flap?.replayControl?.nextRetryAt || "");
      flapReplayRetryAt = Number.isFinite(persistedFlapReplayRetryAt) && persistedFlapReplayRetryAt > now()
        ? persistedFlapReplayRetryAt
        : 0;
      if (focus3ChainScope) {
        // Broad BSC discovery used to retain hundreds of unrelated/anonymous
        // launchers. They can never produce a focus3 alert, yet every state
        // transition cloned and serialized their multi-megabyte history.
        state.launchers = Object.fromEntries(Object.entries(state.launchers || {})
          .filter(([, launcher]) => String(launcher?.platform?.id || "").toLowerCase() === "flap"
            || isFourMemePlatformId(launcher?.platform?.id)));
      }
      // Quote assets from Four.Meme's public config are trading inputs, not
      // factories. Remove records produced by the old generic contract bridge
      // so a quote-token transfer can never be attributed as a launchpad.
      for (const [address, record] of Object.entries(state.discoverySources?.external?.contracts || {})) {
        if ((record.sources || []).length
          && (record.sources || []).every((source) => source.sourceId === "platform-capability:fourmeme"
            && source.sourceUrl === FOUR_MEME_CONFIG_URL)) {
          delete state.discoverySources.external.contracts[address];
        }
      }
      state.officialSources.flap.creationEventHotIndex = normalizeFlapCreationHotIndex(
        state.officialSources.flap.creationEventHotIndex,
        now(),
      );
      state.officialSources.fourMeme.creationEventHotIndex = normalizeFourMemeCreationHotIndex(
        state.officialSources.fourMeme.creationEventHotIndex,
        now(),
      );
      suppressExcludedFourMemeTemplateActivations(state, iso(now));
      if (focus3ChainScope) {
        // State written before barrier-aware scheduling has no receipt topic
        // identity, so it cannot be safely assigned to one exact activation.
        // Conservatively bind each such durable candidate to every currently
        // unresolved official group. Deep receipt classification removes the
        // impossible keys in one later WAL frame. This is delay-only and makes
        // upgrades fail closed instead of letting a new WS candidate overtake
        // an older pre-upgrade record.
        for (const collection of [state.realtimePendingEntries, state.deferredCreationEvidence]) {
          for (const record of Object.values(collection || {})) {
            if (record?.causalBarrierMigrationPending !== true) continue;
            record.causalBarrierKeys = legacyCausalBarrierKeysForRecord(record);
            delete record.causalBarrierMigrationPending;
          }
        }
      } else {
        for (const collection of [state.realtimePendingEntries, state.deferredCreationEvidence]) {
          for (const record of Object.values(collection || {})) {
            delete record.causalBarrierMigrationPending;
          }
        }
      }
      migrateLegacyRealtimeTailHandoff();
      // Normalize v5's durable targeted-replay list into the unified pending
      // WAL before background scheduling. If the pending store is already at
      // capacity, retain the closed legacy record as its own durable admission
      // source so startup can drain space instead of deadlocking in init.
      if (focus3ChainScope) {
        const migrationReplayEntries = [];
        for (const target of state.migrationReplayTransactions || []) {
          enqueue(target.transactionHash, target.blockNumber, "v5_targeted_causal_attribution", {
            mintEmitters: target.tokens,
            candidateTokens: target.tokens,
            verifiedNewContracts: target.tokens,
          });
          const entry = queue.get(normalizeTransactionHash(target.transactionHash));
          if (entry) {
            const barriers = legacyCausalBarrierKeysForRecord(entry);
            if (JSON.stringify(barriers) !== JSON.stringify(entry.causalBarrierKeys || [])) {
              entry.causalBarrierKeys = barriers;
              entry.revision = Number(entry.revision || 0) + 1;
            }
            migrationReplayEntries.push(entry);
          }
        }
        try {
          persistRealtimePendingHandoff(migrationReplayEntries);
          state.migrationReplayTransactions = [];
        } catch (error) {
          if (error?.code !== "BSC_REALTIME_PENDING_CAPACITY") throw error;
        }
      }
      if (focus3ChainScope) compactFocus3LiveCoverageState(state, {
        // Preserve more than the 15-minute Flap/Four activation replay
        // window, while dropping multi-day recovery work that cannot improve
        // a live-first monitor. Already-durable transaction candidates remain
        // in realtimePendingEntries and are not discarded by this baseline.
        replayLookbackBlocks: focus3ReplayLookbackBlocks,
        current: now(),
      });
      if (journalPersistenceEnabled) {
        if (!snapshotMetadata.exists || snapshotMetadata.legacyJournal) {
          // One conservative full barrier migrates legacy JSON. Thereafter
          // every mutation is an fsynced delta frame until the next bounded
          // snapshot compaction.
          state.journalRevision = journalRevision;
          durableJournalState = structuredClone(state);
          await compactStateJournal({ force: true, allowCreate: true });
        } else {
          await appendCurrentStateToJournal();
          await journalFs.chmod(stateFile, 0o600);
          try {
            await journalFs.chmod(stateWalFile, 0o600);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await journalReset(stateWalFile);
          }
          scheduleJournalCompaction();
        }
      } else {
        await atomicStateWrite(stateFile, state);
      }
      lastHealthPersistAt = Number(now());
      persistedCoverage = Number(state.lastFinalizedBlock || 0);
      replaceDynamicFourRoots(Object.values(state.officialSources?.fourMeme?.roots || {}));
      if (ADDRESS.test(String(state.officialSources?.agentLaunch?.deployer || "").toLowerCase())) {
        dynamicOfficialRoots.set(state.officialSources.agentLaunch.deployer.toLowerCase(), platformForLabel("agentlaunch"));
      }
      for (const record of Object.values(state.officialChildren || {})) officialChildRoots.set(record.child.toLowerCase(), record);
      for (const record of Object.values(state.singularryCurves || {})) singularryCurveRoots.set(record.curve.toLowerCase(), record);
      for (const record of Object.values(state.realtimePendingEntries || {})) {
        if (state.seenTransactions[record.transactionHash] || state.deferredCreationEvidence[record.transactionHash]) {
          delete state.realtimePendingEntries[record.transactionHash];
          continue;
        }
        const entry = deserializeRealtimePendingEntry(record);
        queue.set(entry.transactionHash, entry);
      }
      for (const target of state.migrationReplayTransactions || []) {
        enqueue(target.transactionHash, target.blockNumber, "v5_targeted_causal_attribution", {
          mintEmitters: target.tokens,
          candidateTokens: target.tokens,
          verifiedNewContracts: target.tokens,
        });
        const entry = queue.get(normalizeTransactionHash(target.transactionHash));
        if (entry) {
          const barriers = legacyCausalBarrierKeysForRecord(entry);
          if (JSON.stringify(barriers) !== JSON.stringify(entry.causalBarrierKeys || [])) {
            entry.causalBarrierKeys = barriers;
            entry.revision = Number(entry.revision || 0) + 1;
          }
        }
      }
      return state;
    })().catch((error) => {
      state = null;
      throw error;
    }).finally(() => {
      initializePromise = null;
    });
    await initializePromise;
    return state;
  }

  const fourMemePlatform = () => publicPlatform(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "fourmeme"));
  const openFourPlatform = () => publicPlatform(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "openfour"));

  function fourMemePresaleManagerRoots(snapshot = state) {
    const officialRoots = Object.entries(snapshot?.officialSources?.fourMeme?.roots || {})
      .filter(([address, root]) => ADDRESS.test(String(address).toLowerCase())
        && /^TokenManagerPresale(?:$|[A-Z0-9_-])/i.test(String(root?.name || "")))
      .map(([address]) => address.toLowerCase());
    return new Set([...FOUR_MEME_PRESALE_MANAGERS, ...officialRoots]);
  }

  function httpRetryAfterMs(headers, current = Number(now())) {
    const raw = headers?.get?.("retry-after") ?? headers?.get?.("Retry-After") ?? null;
    if (raw === null || raw === undefined || raw === "") return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds * 1_000));
    const deadline = Date.parse(String(raw));
    return Number.isFinite(deadline) && deadline > current ? Math.max(1, deadline - current) : 0;
  }

  async function fetchOfficialJson(url, init = {}) {
    const response = await fetchImpl(url, {
      ...init,
      headers: { accept: "application/json", "user-agent": "bsc-launchpad-monitor/0.1", ...(init.headers || {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response?.ok) {
      const error = new Error(`${url} HTTP ${response?.status ?? "unknown"}`);
      error.status = Number(response?.status) || null;
      error.url = url;
      const retryAfterMs = httpRetryAfterMs(response?.headers);
      if (retryAfterMs > 0) error.retryAfterMs = retryAfterMs;
      throw error;
    }
    return JSON.parse(await response.text());
  }

  async function readOpenFourPresetStatus(presetId) {
    const idValue = String(presetId || "");
    if (!/^\d+$/.test(idValue)) return { verified: false, active: false, createEnabled: false };
    const cached = openFourPresetCache.get(idValue);
    if (cached && now() - cached.checkedAt < 5_000) return cached;
    try {
      const [activeRaw, createRaw] = await Promise.all([
        provider.call({
          to: FOUR_MEME_OPENFOUR_REGISTRY,
          data: openFourRegistry.encodeFunctionData("isPresetActive", [idValue]),
        }),
        provider.call({
          to: FOUR_MEME_OPENFOUR_REGISTRY,
          data: openFourRegistry.encodeFunctionData("isPresetCreateEnabled", [idValue]),
        }),
      ]);
      const result = {
        verified: true,
        active: openFourRegistry.decodeFunctionResult("isPresetActive", activeRaw)[0] === true,
        createEnabled: openFourRegistry.decodeFunctionResult("isPresetCreateEnabled", createRaw)[0] === true,
        checkedAt: now(),
      };
      openFourPresetCache.set(idValue, result);
      return result;
    } catch (error) {
      logger.error(`[bsc][fourmeme] Registry preset ${idValue}: ${errorSummary(error)}`);
      return { verified: false, active: false, createEnabled: false, checkedAt: now() };
    }
  }

  function officialRootEvent(root, snapshot, observedAt) {
    const platform = root.name === "OpenFourCore" ? openFourPlatform() : fourMemePlatform();
    return {
      type: "bsc_launchpad_update",
      kind: "new_factory",
      eventKey: `bsc-official-factory:fourmeme:${root.address}`,
      chainId: BSC_CHAIN_ID,
      launcher: getAddress(root.address),
      platform,
      launchCount: 0,
      uniqueTokens: 0,
      tokens: [],
      pools: [],
      mode: { selector: "official-address-api", fingerprint: snapshot.fingerprint, officialName: root.name, sourceUrl: FOUR_MEME_ADDRESS_URL },
      structural: { eligible: true, source: "official_api" },
      security: null,
      explorerUrl: `https://bscscan.com/address/${root.address}`,
      launcherUrl: `https://bscscan.com/address/${root.address}`,
      sourceUrl: FOUR_MEME_ADDRESS_URL,
      observedAt,
      strong: true,
    };
  }

  function officialTemplateEvent(template, changeType, observedAt, previous = null) {
    const previousTemplate = compactFourMemeTemplate(previous);
    const currentTemplate = compactFourMemeTemplate(template);
    return {
      type: "bsc_launchpad_update",
      kind: "new_mode",
      changeType,
      eventKey: `bsc-official-mode:fourmeme:${template.id}:${template.fingerprint}`,
      chainId: BSC_CHAIN_ID,
      launcher: getAddress(FOUR_MEME_OPENFOUR_CORE),
      platform: fourMemePlatform(),
      launchCount: 0,
      uniqueTokens: 0,
      tokens: [],
      pools: [],
      previousTemplate,
      currentTemplate,
      changedFields: changedFourMemeTemplateFields(previousTemplate, currentTemplate),
      mode: {
        selector: "official-template",
        fingerprint: template.fingerprint,
        officialName: template.name,
        componentMode: template.name,
        template: { ...template, changeType },
        sourceUrl: FOUR_MEME_TEMPLATE_URL,
      },
      structural: { eligible: true, source: "official_api" },
      officialCapability: {
        version: 1,
        platform: "fourmeme",
        kind: "template",
        changeType,
        sourceId: "fourmeme_public_template_api",
        sourceUrl: FOUR_MEME_TEMPLATE_URL,
        observedAt,
      },
      source: {
        id: "fourmeme_public_template_api",
        name: "Four.Meme public template API",
        url: FOUR_MEME_TEMPLATE_URL,
        trust: "official_verified",
        official: true,
      },
      sourceTrust: "official_verified",
      security: null,
      explorerUrl: `https://bscscan.com/address/${FOUR_MEME_OPENFOUR_CORE}`,
      launcherUrl: `https://bscscan.com/address/${FOUR_MEME_OPENFOUR_CORE}`,
      sourceUrl: FOUR_MEME_TEMPLATE_URL,
      observedAt,
      strong: true,
    };
  }

  function templateActivationRecord(template, observedAt, details = {}) {
    const key = fourMemeActivationKey(template);
    return {
      key,
      type: "template",
      templateId: template.id,
      templateFingerprint: template.fingerprint,
      template: { ...template },
      verificationLane: details.verificationLane || "openfour_registry",
      changeType: details.changeType || "published_template_waiting_first_token",
      firstObservedAt: details.firstObservedAt || observedAt,
      confirmedAt: observedAt,
      active: true,
      allowReplay: details.allowReplay === true,
      firstTokenAlertedAt: null,
      firstTokenTransactionHash: null,
      firstToken: null,
      replayCompletedAt: null,
      replayAlgorithmVersion: 2,
      replayNextBlock: null,
      replayScannedThroughBlock: null,
      replayLastAttemptAt: null,
      replayLastError: null,
      hotReplayCompletedAt: null,
      hotReplayLastAttemptAt: null,
      hotReplayIndexWatermark: null,
      replayAttemptedCandidateKeys: [],
    };
  }

  function quoteActivationRecord(config, observedAt, details = {}) {
    const key = fourMemeQuoteActivationKey(config);
    return {
      key,
      type: "quote_config",
      quoteSymbol: config.symbol,
      quoteAddress: config.address,
      quoteFingerprint: config.fingerprint,
      quoteConfig: { ...config },
      changeType: details.changeType || "new_published_quote",
      firstObservedAt: details.firstObservedAt || observedAt,
      confirmedAt: observedAt,
      active: true,
      allowReplay: details.allowReplay !== false,
      firstTokenAlertedAt: null,
      firstTokenTransactionHash: null,
      firstToken: null,
      replayCompletedAt: null,
      replayAlgorithmVersion: 2,
      replayNextBlock: null,
      replayScannedThroughBlock: null,
      replayLastAttemptAt: null,
      replayLastError: null,
      hotReplayCompletedAt: null,
      hotReplayLastAttemptAt: null,
      hotReplayIndexWatermark: null,
      replayAttemptedCandidateKeys: [],
    };
  }

  async function acceptOfficialRootSnapshot(snapshot, observedAt) {
    const phase = await withState(() => {
      const draft = structuredClone(state);
      const official = draft.officialSources.fourMeme;
      const currentRoots = Object.fromEntries(snapshot.roots.map((root) => [root.address, root]));
      if (!Object.keys(official.roots).length) {
        official.roots = currentRoots;
        official.rootFingerprint = snapshot.fingerprint;
        official.pendingRoots = null;
        official.initializedAt ||= observedAt;
        official.lastSuccessAt = observedAt;
        official.lastError = null;
        official.consecutiveFailures = 0;
        state = draft;
        return { savePromise: save(draft), syncRoots: Object.values(currentRoots), plan: null };
      }
      if (official.rootFingerprint === snapshot.fingerprint) {
        official.pendingRoots = null;
        official.lastSuccessAt = observedAt;
        official.lastError = null;
        official.consecutiveFailures = 0;
        state = draft;
        return { savePromise: save(draft), syncRoots: Object.values(official.roots), plan: null };
      }
      const pending = official.pendingRoots?.fingerprint === snapshot.fingerprint
        ? {
          ...official.pendingRoots,
          observations: Number(official.pendingRoots.observations || 0) + 1,
          roots: currentRoots,
          deliveredEventKeys: [...new Set(official.pendingRoots.deliveredEventKeys || [])],
        }
        : {
          fingerprint: snapshot.fingerprint,
          observations: 1,
          roots: currentRoots,
          firstObservedAt: observedAt,
          deliveredEventKeys: [],
        };
      official.pendingRoots = pending;
      official.lastSuccessAt = observedAt;
      official.lastError = null;
      official.consecutiveFailures = 0;
      if (pending.observations < 2) {
        state = draft;
        return { savePromise: save(draft), syncRoots: null, plan: null };
      }
      const additions = Object.values(currentRoots).filter((root) => !official.roots[root.address]);
      const events = additions.map((root) => officialRootEvent(root, snapshot, observedAt));
      if (!events.length) {
        official.roots = currentRoots;
        official.rootFingerprint = snapshot.fingerprint;
        official.pendingRoots = null;
        state = draft;
        return { savePromise: save(draft), syncRoots: Object.values(currentRoots), plan: null };
      }
      state = draft;
      return {
        savePromise: save(draft),
        syncRoots: null,
        plan: {
          fingerprint: snapshot.fingerprint,
          currentRoots,
          events,
          pendingEventKeys: events
            .map((event) => event.eventKey)
            .filter((eventKey) => !pending.deliveredEventKeys.includes(eventKey)),
        },
      };
    });
    await phase.savePromise;
    if (phase.syncRoots) replaceDynamicFourRoots(phase.syncRoots);
    if (!phase.plan) return;

    const eventsByKey = new Map(phase.plan.events.map((event) => [event.eventKey, event]));
    for (const eventKey of phase.plan.pendingEventKeys) {
      const event = eventsByKey.get(eventKey);
      await deliverOfficialEvent(event, (draft) => {
        const pending = draft.officialSources.fourMeme.pendingRoots;
        if (pending?.fingerprint !== phase.plan.fingerprint) return false;
        pending.deliveredEventKeys = [...new Set([...(pending.deliveredEventKeys || []), event.eventKey])];
        return true;
      });
    }

    const finalized = await withState(() => {
      const draft = structuredClone(state);
      const official = draft.officialSources.fourMeme;
      const pending = official.pendingRoots;
      const requiredKeys = phase.plan.events.map((event) => event.eventKey);
      if (pending?.fingerprint !== phase.plan.fingerprint
        || requiredKeys.some((eventKey) => !(pending.deliveredEventKeys || []).includes(eventKey))) {
        return { savePromise: null, syncRoots: null };
      }
      official.roots = phase.plan.currentRoots;
      official.rootFingerprint = phase.plan.fingerprint;
      official.pendingRoots = null;
      state = draft;
      return { savePromise: save(draft), syncRoots: Object.values(phase.plan.currentRoots) };
    });
    if (finalized.savePromise) await finalized.savePromise;
    if (finalized.syncRoots) replaceDynamicFourRoots(finalized.syncRoots);
  }

  async function acceptOfficialTemplateSnapshot(templates, observedAt) {
    const registryCandidates = templates.filter((template) => template.status === "PUBLISHED"
      && !isExcludedFourMemeTemplate(template)
      && (template.deployCount === 0
        || !state.officialSources?.fourMeme?.templates?.[template.id]
        || state.officialSources.fourMeme.templates[template.id].fingerprint !== template.fingerprint));
    const registryChecks = await mapLimit(registryCandidates, 3, async (template) => ({
      id: template.id,
      status: await readOpenFourPresetStatus(template.id),
    }));
    const registryById = new Map(registryChecks
      .filter((result) => result.status === "fulfilled")
      .map((result) => [result.value.id, result.value.status]));
    const verificationLane = (template) => {
      const status = registryById.get(template.id);
      if (status?.verified !== true) return null;
      return status.active === true && status.createEnabled === true
        ? "openfour_registry"
        : "official_token_api";
    };
    const phase = await withState(() => {
      const draft = structuredClone(state);
      const official = draft.officialSources.fourMeme;
      official.featureActivations ||= {};
      suppressExcludedFourMemeTemplateActivations(draft, observedAt);
      if (!Object.keys(official.templates).length) {
        official.templates = Object.fromEntries(templates.map((template) => [template.id, template]));
        official.pendingTemplates = {};
        for (const template of templates) {
          const key = fourMemeActivationKey(template);
          const lane = verificationLane(template);
          if (template.status === "PUBLISHED"
            && template.deployCount === 0
            && !isExcludedFourMemeTemplate(template)
            && lane
            && key
            && !official.featureActivations[key]) {
            // A published preset with zero deployments is already a known
            // feature, but its on-chain activation has not happened yet. Start
            // watching prospectively without replaying old history.
            official.featureActivations[key] = templateActivationRecord(template, observedAt, {
              allowReplay: false,
              verificationLane: lane,
            });
          }
        }
        official.initializedAt ||= observedAt;
        official.lastSuccessAt = observedAt;
        official.lastError = null;
        official.consecutiveFailures = 0;
        state = draft;
        return { savePromise: save(draft), plans: [] };
      }
      for (const template of templates) {
        const previous = official.templates[template.id];
        if (previous?.fingerprint === template.fingerprint) {
          official.templates[template.id] = template;
          delete official.pendingTemplates[template.id];
          const key = fourMemeActivationKey(template);
          const lane = verificationLane(template);
          if (template.status === "PUBLISHED"
            && template.deployCount === 0
            && !isExcludedFourMemeTemplate(template)
            && lane
            && key
            && !official.featureActivations[key]) {
            official.featureActivations[key] = templateActivationRecord(template, observedAt, {
              allowReplay: false,
              verificationLane: lane,
            });
          }
          continue;
        }
        const pending = official.pendingTemplates[template.id];
        official.pendingTemplates[template.id] = pending?.fingerprint === template.fingerprint
          ? { ...pending, observations: Number(pending.observations || 0) + 1, template }
          : { fingerprint: template.fingerprint, observations: 1, template, firstObservedAt: observedAt };
      }
      official.lastSuccessAt = observedAt;
      official.lastError = null;
      official.consecutiveFailures = 0;
      const plans = [];
      for (const [id, pending] of Object.entries(official.pendingTemplates)) {
        if (pending.observations < 2) continue;
        const template = pending.template;
        const previous = official.templates[id];
        const becamePublished = template.status === "PUBLISHED" && previous?.status !== "PUBLISHED";
        const newPublished = template.status === "PUBLISHED" && !previous;
        const publishedMechanismChanged = template.status === "PUBLISHED" && previous?.status === "PUBLISHED" && previous.fingerprint !== template.fingerprint;
        const becameUnpublished = template.status !== "PUBLISHED" && previous?.status === "PUBLISHED";
        if (newPublished || becamePublished || publishedMechanismChanged || becameUnpublished) {
          const changeType = newPublished
            ? "new_published_template"
            : becamePublished
              ? "template_published"
              : publishedMechanismChanged
                ? "published_template_changed"
                : "template_unpublished";
          if (isExcludedFourMemeTemplate(template)) {
            official.templates[id] = template;
            delete official.pendingTemplates[id];
            continue;
          }
          const lane = becameUnpublished ? "official_template_api" : verificationLane(template);
          // A transient Registry read must not permanently consume a newly
          // published template. Leave it pending and retry on the next poll.
          if (!lane) continue;
          plans.push({
            id,
            fingerprint: pending.fingerprint,
            template,
            changeType,
            firstObservedAt: pending.firstObservedAt || observedAt,
            activationKey: becameUnpublished ? null : fourMemeActivationKey(template),
            verificationLane: lane,
            firstTokenEligible: !becameUnpublished && (lane === "openfour_registry" || newPublished || becamePublished),
            event: officialTemplateEvent(template, changeType, observedAt, previous),
          });
          continue;
        }
        official.templates[id] = template;
        delete official.pendingTemplates[id];
      }
      state = draft;
      return { savePromise: save(draft), plans };
    });
    await phase.savePromise;
    for (const plan of phase.plans) {
      await deliverOfficialEvent(plan.event, (draft) => {
        const official = draft.officialSources.fourMeme;
        const pending = official.pendingTemplates[plan.id];
        if (pending?.fingerprint !== plan.fingerprint) return false;
        official.templates[plan.id] = plan.template;
        if (plan.changeType === "template_unpublished") {
          for (const activation of Object.values(official.featureActivations || {})) {
            if (activation?.type !== "template" || activation.active === false
              || String(activation.templateId || "") !== String(plan.id)) continue;
            activation.active = false;
            activation.deactivatedAt = observedAt;
            activation.deactivationReason = "official_template_unpublished";
            activation.deactivatedByEventKey = plan.event.eventKey;
          }
        }
        if (plan.firstTokenEligible && plan.activationKey && !official.featureActivations[plan.activationKey]) {
          official.featureActivations[plan.activationKey] = templateActivationRecord(plan.template, observedAt, {
            changeType: plan.changeType,
            firstObservedAt: plan.firstObservedAt,
            allowReplay: true,
            verificationLane: plan.verificationLane,
          });
          backfillNewFeatureCausalBarrier(
            draft,
            "fourmeme",
            plan.activationKey,
            official.featureActivations[plan.activationKey],
          );
        }
        delete official.pendingTemplates[plan.id];
        return true;
      });
    }
    await replayPendingFourMemeActivations(phase.plans.map((plan) => plan.activationKey).filter(Boolean));
  }

  function replayActivationLowerBoundMs(activation) {
    const firstObservedMs = Date.parse(activation.firstObservedAt || activation.confirmedAt || "");
    return Number.isFinite(firstObservedMs)
      ? firstObservedMs - FOUR_MEME_ACTIVATION_REPLAY_LOOKBACK_MS
      : null;
  }

  async function initialFourMemeReplayBlock(activation, confirmedHead) {
    if (Number.isSafeInteger(Number(activation.replayNextBlock)) && Number(activation.replayNextBlock) > 0) {
      return Number(activation.replayNextBlock);
    }
    const eligibleFromMs = replayActivationLowerBoundMs(activation);
    if (!Number.isFinite(eligibleFromMs)) throw new Error(`Four.Meme activation ${activation.key} has no replay timestamp`);
    const headBlock = await cachedBlock(confirmedHead);
    const headTimestampMs = Number(headBlock?.timestamp) * 1_000;
    if (!Number.isFinite(headTimestampMs)) throw new Error(`missing BSC head timestamp ${confirmedHead}`);
    const estimatedDistance = Math.max(0, Math.ceil((headTimestampMs - eligibleFromMs) / expectedBlockTimeMs));
    const safetyBlocks = Math.max(240, Math.ceil(estimatedDistance * 0.05));
    return Math.max(0, confirmedHead - estimatedDistance - safetyBlocks);
  }

  function fourMemeManagerRoots() {
    return new Set([
      ...Object.entries(state.officialSources?.fourMeme?.roots || {})
        .filter(([, root]) => /^TokenManager/i.test(root.name || ""))
        .map(([address]) => address.toLowerCase()),
      "0x5c952063c7fc8610ffdb798152d69f0b9550762b",
      ...fourMemePresaleManagerRoots(),
    ]);
  }

  function focus3UpgradeLogAddresses(snapshot = state) {
    const addresses = new Set();
    const add = (value) => {
      const normalized = String(value || "").toLowerCase();
      if (ADDRESS.test(normalized)) addresses.add(normalized);
    };
    add(FLAP_PORTAL_ADDRESS);
    add(FLAP_VAULT_PORTAL_ADDRESS);
    add(FOUR_MEME_OPENFOUR_CORE);
    add(FOUR_MEME_OPENFOUR_REGISTRY);
    for (const address of fourMemeManagerRoots()) add(address);
    for (const address of FLAP_COMPONENTS.keys()) add(address);
    for (const address of FLAP_OFFICIAL_VAULT_FACTORIES.keys()) add(address);
    for (const entry of BSC_LAUNCHPAD_CATALOG) {
      if (entry.id !== "flap" && entry.id !== "fourmeme" && entry.id !== "openfour") continue;
      for (const address of entry.launchers || []) add(address);
    }
    for (const [address, component] of BSC_OFFICIAL_COMPONENTS) {
      if (component.platformId === "flap" || isFourMemePlatformId(component.platformId)) add(address);
    }
    for (const [address, platform] of dynamicOfficialRoots) {
      if (platform?.id === "flap" || isFourMemePlatformId(platform?.id)) add(address);
    }
    for (const activation of Object.values(snapshot?.officialSources?.flap?.featureActivations || {})) {
      add(activation?.vaultFactory);
    }
    return [...addresses].sort();
  }

  function protocolLogFilters(range = {}) {
    if (!focus3ChainScope) return [{ ...range, topics: [BSC_TRIGGER_TOPICS] }];
    const filters = [{ ...range, topics: [BSC_FOCUS3_LAUNCH_TOPICS] }];
    const upgradeAddresses = focus3UpgradeLogAddresses();
    // BlockRazor limits the number of alternatives at each filter position.
    // Keep upgrade emitters in small exact shards while the globally unique
    // creation topics remain unscoped, preserving discovery of a new root.
    for (let index = 0; index < upgradeAddresses.length; index += 8) {
      filters.push({
        ...range,
        address: upgradeAddresses.slice(index, index + 8),
        topics: [BSC_UPGRADE_TOPICS],
      });
    }
    return filters;
  }

  function fourMemeCandidateMatchesActivation(candidate, activation, { requireEventTime = true } = {}) {
    const emitter = String(candidate?.launcher || "").toLowerCase();
    const topic = String(candidate?.topic || "").toLowerCase();
    const presaleManagerRoots = fourMemePresaleManagerRoots();
    if (requireEventTime && !fourMemeActivationEligibleAt(activation, candidate?.observedAt)) return false;
    if (activation.type === "template") {
      if (activation.verificationLane === "official_token_api") {
        return [FOUR_MEME_TOKEN_CREATE_TOPIC, FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC].includes(topic)
          && fourMemeManagerRoots().has(emitter)
          && (topic !== FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC || presaleManagerRoots.has(emitter));
      }
      return topic === OPENFOUR_TOKEN_CREATED_TOPIC
        && emitter === FOUR_MEME_OPENFOUR_CORE
        && String(candidate.presetId || "") === String(activation.templateId || "");
    }
    if (topic === OPENFOUR_TOKEN_CREATED_TOPIC) {
      return emitter === FOUR_MEME_OPENFOUR_CORE
        && String(candidate.quoteAsset || "").toLowerCase() === String(activation.quoteAddress || "").toLowerCase();
    }
    return topic === FOUR_MEME_TOKEN_CREATE_TOPIC && fourMemeManagerRoots().has(emitter);
  }

  function fourMemeCreationCandidateFromLog(log, details = {}) {
    const evidence = parseKnownBscLaunchEvidence([log])[0];
    if (!evidence) return null;
    const topic = String(evidence.topic || "").toLowerCase();
    const launcher = String(evidence.emitter || "").toLowerCase();
    if (topic === OPENFOUR_TOKEN_CREATED_TOPIC) {
      if (launcher !== FOUR_MEME_OPENFOUR_CORE) return null;
    } else if (topic === FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC) {
      if (!fourMemePresaleManagerRoots().has(launcher)) return null;
    } else if (topic === FOUR_MEME_TOKEN_CREATE_TOPIC) {
      if (!fourMemeManagerRoots().has(launcher)) return null;
    } else return null;
    const numeric = (value, fallback = 0) => {
      if (typeof value === "number") return value;
      if (typeof value === "bigint") return Number(value);
      if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value, 16);
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    return normalizeFourMemeCreationHotIndex([{
      launcher,
      token: evidence.token,
      transactionHash: log.transactionHash || details.transactionHash,
      blockNumber: numeric(log.blockNumber, numeric(details.blockNumber, -1)),
      transactionIndex: numeric(log.transactionIndex, numeric(details.transactionIndex, 0)),
      logIndex: numeric(log.logIndex ?? log.index, numeric(details.logIndex, 0)),
      topic,
      observedAt: details.observedAt || iso(now),
      indexedAt: iso(now),
      presetId: evidence.presetId || null,
      quoteAsset: evidence.quoteAsset || null,
    }], now())[0] || null;
  }

  function appendFourMemeCreationHotIndex(targetState, candidates = []) {
    if (!candidates.length) return { changed: false, replayKeys: [] };
    const official = targetState.officialSources?.fourMeme;
    if (!official) return { changed: false, replayKeys: [] };
    const previous = normalizeFourMemeCreationHotIndex(official.creationEventHotIndex, now());
    const next = normalizeFourMemeCreationHotIndex([...previous, ...candidates], now());
    const inputKeys = new Set(normalizeFourMemeCreationHotIndex(candidates, null)
      .map(fourMemeCreationCandidateKey));
    const classified = next.filter((candidate) => inputKeys.has(fourMemeCreationCandidateKey(candidate)));
    official.creationEventHotIndex = next;
    const replayKeys = [];
    for (const [key, activation] of Object.entries(official.featureActivations || {})) {
      if (activation.active === false || activation.firstTokenAlertedAt || activation.firstTokenTransactionHash) continue;
      if (!classified.some((candidate) => !fourMemeReplayCandidateWasAttempted(activation, candidate)
        && fourMemeCandidateMatchesActivation(candidate, activation))) continue;
      // A completed archive replay can race with the realtime candidate that
      // it was meant to protect. Reopen it atomically with the hot-index
      // append so the ordinary fast path can never make that first token
      // permanently invisible.
      activation.replayCompletedAt = null;
      activation.hotReplayCompletedAt = null;
      activation.hotReplayReopenedAt = iso(now);
      replayKeys.push(key);
    }
    return {
      changed: JSON.stringify(previous) !== JSON.stringify(next),
      replayKeys,
    };
  }

  function fourMemeReplayCandidate(log, activation) {
    const blockNumber = typeof log.blockNumber === "number" ? log.blockNumber : Number.parseInt(log.blockNumber, 16);
    const transactionIndex = typeof log.transactionIndex === "number" ? log.transactionIndex : Number.parseInt(log.transactionIndex || "0x0", 16);
    const logIndex = typeof log.logIndex === "number" ? log.logIndex : Number.parseInt(log.logIndex || "0x0", 16);
    const transactionHash = normalizeTransactionHash(log.transactionHash);
    if (!Number.isSafeInteger(blockNumber)
      || !Number.isSafeInteger(transactionIndex)
      || !Number.isSafeInteger(logIndex)
      || !/^0x[0-9a-f]{64}$/.test(transactionHash)) return null;
    const evidence = parseKnownBscLaunchEvidence([log])[0];
    if (!evidence) return null;
    const emitter = evidence.emitter.toLowerCase();
    const candidate = {
      launcher: emitter,
      token: evidence.token.toLowerCase(),
      transactionHash,
      blockNumber,
      transactionIndex,
      logIndex,
      topic: String(log.topics[0]).toLowerCase(),
      observedAt: null,
      presetId: evidence.presetId || null,
      quoteAsset: evidence.quoteAsset ? String(evidence.quoteAsset).toLowerCase() : null,
    };
    if (!fourMemeCandidateMatchesActivation(candidate, activation, { requireEventTime: false })) return null;
    return candidate;
  }

  function fourMemeFastReplayScope(activation, fromBlock, toBlock) {
    const allowedAddressTopics = new Map();
    const allow = (addresses, topics) => {
      for (const address of addresses) {
        const normalized = String(address || "").toLowerCase();
        if (!ADDRESS.test(normalized)) continue;
        const allowed = allowedAddressTopics.get(normalized) || new Set();
        for (const topic of topics) allowed.add(String(topic).toLowerCase());
        allowedAddressTopics.set(normalized, allowed);
      }
    };
    if (activation.type === "template") {
      if (activation.verificationLane === "official_token_api") {
        allow(fourMemeManagerRoots(), [FOUR_MEME_TOKEN_CREATE_TOPIC]);
        allow(fourMemePresaleManagerRoots(), [FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC]);
      } else {
        allow([FOUR_MEME_OPENFOUR_CORE], [OPENFOUR_TOKEN_CREATED_TOPIC]);
      }
    } else if (activation.type === "quote_config") {
      allow(fourMemeManagerRoots(), [FOUR_MEME_TOKEN_CREATE_TOPIC]);
      allow([FOUR_MEME_OPENFOUR_CORE], [OPENFOUR_TOKEN_CREATED_TOPIC]);
    }
    const addresses = [...allowedAddressTopics.keys()].sort();
    const topics = [...new Set([...allowedAddressTopics.values()].flatMap((values) => [...values]))].sort();
    if (!addresses.length || !topics.length) return null;
    return {
      allowedAddressTopics,
      filter: {
        fromBlock: hexBlock(fromBlock),
        toBlock: hexBlock(toBlock),
        address: addresses.length === 1 ? addresses[0] : addresses,
        topics: [topics.length === 1 ? topics[0] : topics],
      },
    };
  }

  async function fetchFourMemeFastReplayCandidates(activation, fromBlock, toBlock) {
    if (!fourMemeFastReplayEnabled || typeof fourMemeFastReplayFetchImpl !== "function") return null;
    const scope = fourMemeFastReplayScope(activation, fromBlock, toBlock);
    if (!scope) return null;
    const id = ++fourMemeFastReplayRpcId;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FOUR_MEME_FAST_REPLAY_TIMEOUT_MS);
    try {
      const response = await fourMemeFastReplayFetchImpl(FOUR_MEME_FAST_REPLAY_RPC_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "bsc-launchpad-monitor/0.1" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "eth_getLogs", params: [scope.filter] }),
        signal: controller.signal,
      });
      if (!response?.ok || typeof response.text !== "function") {
        throw new Error(`PublicNode HTTP ${response?.status ?? "invalid response"}`);
      }
      let payload;
      try { payload = JSON.parse(await response.text()); }
      catch (error) { throw new Error(`PublicNode malformed JSON: ${errorSummary(error)}`); }
      if (!payload
        || Array.isArray(payload)
        || payload.jsonrpc !== "2.0"
        || payload.id !== id
        || payload.error != null
        || !Array.isArray(payload.result)) {
        throw new Error(`PublicNode malformed JSON-RPC result${payload?.error?.message ? `: ${payload.error.message}` : ""}`);
      }
      const candidates = payload.result.map((log) => {
        if (!log || typeof log !== "object" || Array.isArray(log) || log.removed === true) {
          throw new Error("PublicNode malformed eth_getLogs entry");
        }
        const address = String(log.address || "").toLowerCase();
        const topic = String(log.topics?.[0] || "").toLowerCase();
        if (!scope.allowedAddressTopics.get(address)?.has(topic)
          || !Array.isArray(log.topics)
          || !/^0x[0-9a-f]*$/i.test(String(log.data || ""))
          || String(log.data || "").length % 2 !== 0) {
          throw new Error("PublicNode returned an out-of-scope or malformed Four.Meme log");
        }
        const candidate = fourMemeReplayCandidate(log, activation);
        if (!candidate || candidate.blockNumber < fromBlock || candidate.blockNumber > toBlock) {
          throw new Error("PublicNode returned an invalid Four.Meme replay candidate");
        }
        return candidate;
      });
      return candidates.sort((left, right) => left.blockNumber - right.blockNumber
        || left.transactionIndex - right.transactionIndex
        || left.logIndex - right.logIndex);
    } finally {
      clearTimeout(timeout);
    }
  }

  function fourMemeReplayCandidateWasAttempted(activation, candidate) {
    return (activation?.replayAttemptedCandidateKeys || []).includes(fourMemeCreationCandidateKey(candidate));
  }

  async function markFourMemeReplayCandidateAttempted(activationKey, candidate) {
    return withState(async () => {
      const current = state.officialSources?.fourMeme?.featureActivations?.[activationKey];
      if (!current) return false;
      const key = fourMemeCreationCandidateKey(candidate);
      current.replayAttemptedCandidateKeys = [...new Set([
        ...(current.replayAttemptedCandidateKeys || []),
        key,
      ])].slice(-FOUR_MEME_REPLAY_ATTEMPTED_CANDIDATES_MAX);
      await save();
      return true;
    });
  }

  async function processFourMemeReplayCandidate(activationKey, activation, candidate) {
    const attempted = await withState(() => {
      const current = state.officialSources?.fourMeme?.featureActivations?.[activationKey];
      return !current || fourMemeReplayCandidateWasAttempted(current, candidate);
    });
    if (attempted) return false;
    if (activation.type === "quote_config" && candidate.topic === FOUR_MEME_TOKEN_CREATE_TOPIC) {
      const info = await readFourMemeManagerTokenInfo(candidate.launcher, candidate.token, candidate.blockNumber);
      if (!info || info.quoteAsset !== String(activation.quoteAddress || "").toLowerCase()) {
        await markFourMemeReplayCandidateAttempted(activationKey, candidate);
        return false;
      }
    }
    const existingFlight = inFlightEntries.get(candidate.transactionHash);
    if (existingFlight) await existingFlight.catch(() => {});
    const reserved = await withState(async () => {
      const current = state.officialSources?.fourMeme?.featureActivations?.[activationKey];
      if (!current || current.active === false || current.firstTokenAlertedAt || current.firstTokenTransactionHash) return false;
      if (state.deferredCreationEvidence?.[candidate.transactionHash]) {
        throw new Error(`Four.Meme replay candidate ${candidate.transactionHash} is deferred`);
      }
      delete state.seenTransactions[candidate.transactionHash];
      await save();
      return true;
    });
    if (!reserved) return true;
    enqueue(candidate.transactionHash, candidate.blockNumber, "fourmeme_feature_replay", {
      transactionIndex: candidate.transactionIndex,
      logIndex: candidate.logIndex,
      mintEmitters: [candidate.token],
      candidateTokens: [candidate.token],
      verifiedNewContracts: [candidate.token],
      featureActivationReplayKey: activationKey,
      protocol: true,
    });
    const entry = queue.get(candidate.transactionHash);
    if (!entry) throw new Error(`Four.Meme replay could not reserve ${candidate.transactionHash}`);
    await processEntries([entry]);
    const claimed = await withState(() => {
      if (state.deferredCreationEvidence?.[candidate.transactionHash]) {
        throw new Error(`Four.Meme replay candidate ${candidate.transactionHash} remains deferred`);
      }
      const current = state.officialSources?.fourMeme?.featureActivations?.[activationKey];
      return Boolean(current?.firstTokenAlertedAt || current?.firstTokenTransactionHash);
    });
    await markFourMemeReplayCandidateAttempted(activationKey, candidate);
    return claimed;
  }

  async function replayFourMemeCreationHotIndex(activationKey, activation) {
    const phase = await withState(async () => {
      const current = state.officialSources?.fourMeme?.featureActivations?.[activationKey];
      if (!current
        || current.active === false
        || current.firstTokenAlertedAt
        || current.firstTokenTransactionHash) return null;
      const hotIndex = normalizeFourMemeCreationHotIndex(
        state.officialSources?.fourMeme?.creationEventHotIndex,
        now(),
      );
      const watermark = digest(hotIndex.map(fourMemeCreationCandidateKey));
      if (current.hotReplayIndexWatermark === watermark) return null;
      current.hotReplayLastAttemptAt = iso(now);
      const matches = hotIndex.filter((candidate) => fourMemeCandidateMatchesActivation(candidate, current)
        && !fourMemeReplayCandidateWasAttempted(current, candidate));
      await save();
      return { watermark, candidates: matches.map((candidate) => structuredClone(candidate)) };
    });
    if (!phase) return false;
    for (const candidate of phase.candidates) {
      if (await processFourMemeReplayCandidate(activationKey, activation, candidate)) return true;
    }
    await withState(async () => {
      const current = state.officialSources?.fourMeme?.featureActivations?.[activationKey];
      if (current && !current.firstTokenAlertedAt && !current.firstTokenTransactionHash) {
        current.hotReplayCompletedAt = iso(now);
        current.hotReplayIndexWatermark = phase.watermark;
      }
      await save();
    });
    return false;
  }

  async function runFourMemeActivationReplay(activationKey) {
    const activation = await withState(() => {
      const current = state.officialSources?.fourMeme?.featureActivations?.[activationKey];
      if (!shouldReplayFourMemeActivation(current)) return null;
      return structuredClone(current);
    });
    if (!activation) return false;
    try {
      if (await replayFourMemeCreationHotIndex(activationKey, activation)) return true;
      const confirmedHead = Math.max(0, (await provider.getBlockNumber()) - (config.bscConfirmations ?? 2));
      let nextBlock = await initialFourMemeReplayBlock(activation, confirmedHead);
      const replayBudgetCeiling = nextBlock + FOUR_MEME_REPLAY_MAX_BLOCKS_PER_RUN - 1;
      let targetHead = Math.min(confirmedHead, replayBudgetCeiling);
      // PublicNode accepts a much wider range when both the emitter and exact
      // creation topic are constrained. This is only a shortcut to a real
      // candidate: an empty, failed, timed-out, or malformed response never
      // advances the durable cursor and falls through to the complete 10-block
      // replay below.
      let fastCandidates = null;
      if (nextBlock <= targetHead) {
        try {
          fastCandidates = await fetchFourMemeFastReplayCandidates(activation, nextBlock, targetHead);
        } catch (error) {
          logger.info?.(`[bsc][fourmeme] PublicNode fast replay fallback: ${errorSummary(error)}`);
        }
      }
      if (fastCandidates?.length) {
        for (const candidate of fastCandidates) {
          if (await processFourMemeReplayCandidate(activationKey, activation, candidate)) return true;
        }
      }
      await withState(async () => {
        const current = state.officialSources.fourMeme.featureActivations[activationKey];
        if (!current) return;
        current.replayAlgorithmVersion = 2;
        current.replayNextBlock = nextBlock;
        current.replayLastAttemptAt = iso(now);
        current.replayLastError = null;
        await save();
      });

      while (nextBlock <= targetHead) {
        const latestActivation = await withState(() => {
          const current = state.officialSources?.fourMeme?.featureActivations?.[activationKey];
          return current ? structuredClone(current) : null;
        });
        if (latestActivation && await replayFourMemeCreationHotIndex(activationKey, latestActivation)) return true;
        const ranges = [];
        for (let from = nextBlock; from <= targetHead && ranges.length < 4; from += FOUR_MEME_REPLAY_LOG_BATCH_BLOCKS) {
          ranges.push({ from, to: Math.min(targetHead, from + FOUR_MEME_REPLAY_LOG_BATCH_BLOCKS - 1) });
        }
        const topics = activation.type === "template"
          ? activation.verificationLane === "official_token_api"
            ? [FOUR_MEME_TOKEN_CREATE_TOPIC, FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC]
            : [OPENFOUR_TOKEN_CREATED_TOPIC]
          : [FOUR_MEME_TOKEN_CREATE_TOPIC, OPENFOUR_TOKEN_CREATED_TOPIC];
        const results = await Promise.all(ranges.map(({ from, to }) => provider.send("eth_getLogs", [{
          fromBlock: hexBlock(from),
          toBlock: hexBlock(to),
          topics: [topics],
        }])));
        if (results.some((logs) => !Array.isArray(logs))) throw new Error("Four.Meme replay eth_getLogs returned malformed data");
        const candidates = results.flatMap((logs) => logs.map((log) => fourMemeReplayCandidate(log, activation)).filter(Boolean))
          .sort((left, right) => left.blockNumber - right.blockNumber
            || left.transactionIndex - right.transactionIndex
            || left.logIndex - right.logIndex);
        for (const candidate of candidates) {
          if (await processFourMemeReplayCandidate(activationKey, activation, candidate)) return true;
        }
        const scannedThrough = ranges.at(-1).to;
        nextBlock = scannedThrough + 1;
        await withState(async () => {
          const current = state.officialSources.fourMeme.featureActivations[activationKey];
          if (!current || current.firstTokenAlertedAt || current.firstTokenTransactionHash) return;
          current.replayScannedThroughBlock = scannedThrough;
          current.replayNextBlock = nextBlock;
          current.replayLastAttemptAt = iso(now);
          current.replayLastError = null;
          await save();
        });
        if (nextBlock > targetHead) {
          const refreshedHead = Math.max(0, (await provider.getBlockNumber()) - (config.bscConfirmations ?? 2));
          if (refreshedHead > targetHead && targetHead < replayBudgetCeiling) {
            targetHead = Math.min(refreshedHead, replayBudgetCeiling);
          }
        }
      }
      const finalConfirmedHead = Math.max(0, (await provider.getBlockNumber()) - (config.bscConfirmations ?? 2));
      if (nextBlock <= finalConfirmedHead) return false;
      const completed = await withState(async () => {
        const current = state.officialSources.fourMeme.featureActivations[activationKey];
        if (current && !current.firstTokenAlertedAt && !current.firstTokenTransactionHash) {
          const hotIndex = normalizeFourMemeCreationHotIndex(
            state.officialSources?.fourMeme?.creationEventHotIndex,
            now(),
          );
          const currentWatermark = digest(hotIndex.map(fourMemeCreationCandidateKey));
          // Finalize only against the exact hot-index snapshot that this run
          // examined. If realtime appended a candidate in the final window,
          // leave the activation pending and immediately rescan it.
          if (current.hotReplayIndexWatermark !== currentWatermark) {
            current.replayCompletedAt = null;
            current.hotReplayCompletedAt = null;
            current.replayLastAttemptAt = iso(now);
            current.replayLastError = null;
            await save();
            return false;
          }
          current.replayCompletedAt = iso(now);
          current.replayLastError = null;
        }
        await save();
        return true;
      });
      return completed;
    } catch (error) {
      await withState(async () => {
        const current = state.officialSources?.fourMeme?.featureActivations?.[activationKey];
        if (current) {
          current.replayLastAttemptAt = iso(now);
          current.replayLastError = errorSummary(error);
        }
        await save().catch(() => {});
      });
      throw error;
    }
  }

  async function replayFourMemeActivation(activationKey) {
    if (fourMemeReplayFlights.has(activationKey)) return fourMemeReplayFlights.get(activationKey);
    let flight;
    flight = runFourMemeActivationReplay(activationKey).finally(() => {
      if (fourMemeReplayFlights.get(activationKey) === flight) fourMemeReplayFlights.delete(activationKey);
    });
    fourMemeReplayFlights.set(activationKey, flight);
    return flight;
  }

  async function replayPendingFourMemeActivations(keys = null) {
    const requested = Array.isArray(keys)
      ? [...new Set(keys)]
      : await withState(() => Object.keys(state.officialSources?.fourMeme?.featureActivations || {}));
    for (const key of requested) {
      try {
        // A newly observed template can deliberately disable historical
        // replay (allowReplay=false).  Treat it as a live-only activation;
        // repeatedly invoking runFourMemeActivationReplay() would otherwise
        // return immediately while this loop kept scheduling Promise
        // microtasks forever, starving timers, WebSocket heads, and the BSC
        // realtime cursor.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const eligible = await withState(() => {
            const activation = state.officialSources?.fourMeme?.featureActivations?.[key];
            return shouldReplayFourMemeActivation(activation);
          });
          if (!eligible) break;
          await replayFourMemeActivation(key);
          // One bounded follow-up closes the race where realtime appends a
          // matching creation candidate while an existing replay flight is
          // finalizing. Long archive replays retain their durable cursor and
          // resume on the next official-source poll rather than monopolizing
          // the event loop.
          const hotIndexChanged = await withState(() => {
            const activation = state.officialSources?.fourMeme?.featureActivations?.[key];
            if (!shouldReplayFourMemeActivation(activation)) return false;
            const hotIndex = normalizeFourMemeCreationHotIndex(
              state.officialSources?.fourMeme?.creationEventHotIndex,
              now(),
            );
            return activation.hotReplayIndexWatermark !== digest(hotIndex.map(fourMemeCreationCandidateKey));
          });
          if (!hotIndexChanged) break;
        }
      } catch (error) {
        logger.error(`[bsc][fourmeme] activation replay ${key}: ${errorSummary(error)}`);
      }
    }
  }

  function normalizeFlapFeatureRecord(record) {
    const pool = record?.flapPool || record?.pool || record;
    const sourceUrl = String(record?.sourceUrl || pool?.sourceUrl || pool?.source?.url || "").replace(/\/$/, "");
    const observations = Number(record?.observations ?? pool?.observations ?? 0);
    const confirmed = record?.confirmed === true || pool?.confirmed === true;
    if (sourceUrl !== FLAP_BOARD_URL || !confirmed || observations < 2) return null;
    const vaultFactory = String(pool?.vaultFactory || "").toLowerCase();
    const quoteAddress = String(pool?.quoteAddress || pool?.quoteTokenAddress || pool?.quoteToken || "").toLowerCase();
    if (!ADDRESS.test(vaultFactory) && !ADDRESS.test(quoteAddress)) return null;
    const category = normalizeOfficialText(pool?.category || pool?.vaultCategory || "").toUpperCase() || null;
    const quoteSymbol = normalizeOfficialText(pool?.quoteSymbol || pool?.symbol || "").toUpperCase() || null;
    const type = ADDRESS.test(vaultFactory) ? "vault_factory" : "quote_pool";
    const identity = type === "vault_factory"
      ? `vault:${category || "UNKNOWN"}:${vaultFactory}`
      : `quote:${quoteAddress}`;
    const normalized = {
      identity,
      type,
      category,
      vaultFactory: type === "vault_factory" ? vaultFactory : null,
      quoteAddress: type === "quote_pool" ? quoteAddress : null,
      quoteSymbol: type === "quote_pool" ? quoteSymbol : null,
      sourceUrl,
    };
    return {
      ...normalized,
      fingerprint: digest(normalized),
      firstObservedAt: record?.firstObservedAt || pool?.firstObservedAt || record?.observedAt || iso(now),
      confirmedAt: record?.confirmedAt || pool?.confirmedAt || record?.observedAt || iso(now),
    };
  }

  function flapFeatureActivationKey(pool) {
    if (pool?.type === "vault_factory") return `vault:${pool.category || "UNKNOWN"}:${pool.vaultFactory}`;
    if (pool?.type === "quote_pool") return `quote:${pool.quoteAddress}`;
    return null;
  }

  function flapActivationRecord(pool) {
    const key = flapFeatureActivationKey(pool);
    return {
      key,
      type: pool.type,
      poolIdentity: pool.identity,
      category: pool.category,
      vaultFactory: pool.vaultFactory,
      quoteAddress: pool.quoteAddress,
      quoteSymbol: pool.quoteSymbol,
      fingerprint: pool.fingerprint,
      sourceUrl: pool.sourceUrl,
      firstObservedAt: pool.firstObservedAt,
      confirmedAt: pool.confirmedAt,
      active: true,
      firstThreeStatus: "legacy_closed",
      allowReplay: true,
      firstTokenAlertedAt: null,
      firstTokenTransactionHash: null,
      firstToken: null,
      replayCompletedAt: null,
      replayLastAttemptAt: null,
      replayLastError: null,
      replayConsecutiveFailures: 0,
      replayRetryDelayMs: null,
      replayNextAttemptAt: null,
      replayAttemptedTransactionHashes: [],
    };
  }

  function flapCandidateMatchesActivation(candidate, activation) {
    if (!flapActivationEligibleAt(activation, candidate?.observedAt)) return false;
    const topic = String(candidate?.topic || "").toLowerCase();
    const launcher = String(candidate?.launcher || "").toLowerCase();
    if (activation.type === "vault_factory") {
      return topic === FLAP_VAULT_TOKEN_CREATED_TOPIC
        && launcher === FLAP_VAULT_PORTAL_ADDRESS
        && ADDRESS.test(String(activation.vaultFactory || "").toLowerCase())
        && String(candidate.vaultFactory || "").toLowerCase() === String(activation.vaultFactory).toLowerCase();
    }
    if (activation.type === "quote_pool") {
      return topic === FLAP_TOKEN_CREATED_TOPIC
        && launcher === FLAP_PORTAL_ADDRESS
        && ADDRESS.test(String(activation.quoteAddress || "").toLowerCase())
        && (candidate.quoteAssets || []).includes(String(activation.quoteAddress).toLowerCase());
    }
    return false;
  }

  function flapActivationHotIndex(snapshot, activation) {
    return normalizeFlapCreationHotIndex(
      snapshot?.officialSources?.flap?.creationEventHotIndex,
      now(),
    ).filter((candidate) => flapCandidateMatchesActivation(candidate, activation));
  }

  function flapActivationHotWatermark(snapshot, activation) {
    return digest(flapActivationHotIndex(snapshot, activation).map(flapCreationCandidateKey));
  }

  function appendFlapCreationHotIndex(targetState, candidates = []) {
    if (!candidates.length) return { changed: false, replayNeeded: false };
    const official = targetState.officialSources?.flap;
    if (!official) return { changed: false, replayNeeded: false };
    const previous = normalizeFlapCreationHotIndex(official.creationEventHotIndex, now());
    const next = normalizeFlapCreationHotIndex([...previous, ...candidates], now());
    const inputKeys = new Set(normalizeFlapCreationHotIndex(candidates, null)
      .map(flapCreationCandidateKey));
    const classified = next.filter((candidate) => inputKeys.has(flapCreationCandidateKey(candidate)));
    official.creationEventHotIndex = next;
    let replayNeeded = false;
    for (const activation of Object.values(official.featureActivations || {})) {
      if (activation.active === false || activation.firstTokenAlertedAt || activation.firstTokenTransactionHash) continue;
      const attempted = new Set((Array.isArray(activation.replayAttemptedTransactionHashes)
        ? activation.replayAttemptedTransactionHashes
        : []).map(normalizeTransactionHash));
      if (!classified.some((candidate) => !attempted.has(candidate.transactionHash)
        && flapCandidateMatchesActivation(candidate, activation))) continue;
      replayNeeded = true;
      // A chain observation can finish preparation just before Board
      // activation completes, then enter this index just after the replay
      // snapshot. Reopen the one-shot so startup/periodic replay cannot lose it.
      if (activation.replayCompletedAt) {
        activation.replayCompletedAt = null;
        activation.hotReplayReopenedAt = iso(now);
      }
    }
    return {
      changed: JSON.stringify(previous) !== JSON.stringify(next),
      replayNeeded,
    };
  }

  function storedFlapReplayCandidates(snapshot, activation) {
    const candidates = new Map();
    for (const candidate of flapActivationHotIndex(snapshot, activation)) {
      // One transaction can emit more than one exact creation log. The hot
      // index is already sorted by block/transaction/log, so retain the first
      // matching log instead of letting a later token in the same tx replace
      // it under the transaction-level replay reservation.
      if (candidates.has(candidate.transactionHash)) continue;
      candidates.set(candidate.transactionHash, {
        ...candidate,
        source: "flap_creation_hot_index",
      });
    }
    for (const [launcherAddress, launcher] of Object.entries(snapshot?.launchers || {})) {
      if (String(launcher?.platform?.id || "").toLowerCase() !== "flap") continue;
      if (activation.type === "quote_pool") {
        for (const [tokenAddress, token] of Object.entries(launcher.tokens || {})) {
          const matches = (token.pools || []).some((pool) => [pool.token0, pool.token1]
            .map((address) => String(address || "").toLowerCase())
            .includes(String(activation.quoteAddress || "").toLowerCase()));
          if (!matches || !token.transactionHash || !Number.isSafeInteger(Number(token.firstSeenBlock))) continue;
          const transactionHash = normalizeTransactionHash(token.transactionHash);
          if (candidates.has(transactionHash)) continue;
          candidates.set(transactionHash, {
            launcher: launcherAddress,
            token: tokenAddress,
            transactionHash,
            blockNumber: Number(token.firstSeenBlock),
            transactionIndex: Number.MAX_SAFE_INTEGER,
            logIndex: Number.MAX_SAFE_INTEGER,
            observedAt: token.observedAt,
            source: "launcher_token_history",
          });
        }
      } else if (activation.type === "vault_factory") {
        for (const mode of Object.values(launcher.modes || {})) {
          if (String(mode?.shape?.vaultFactory || "").toLowerCase() !== String(activation.vaultFactory || "").toLowerCase()) continue;
          for (const tokenAddress of mode.tokens || []) {
            const token = launcher.tokens?.[String(tokenAddress).toLowerCase()];
            if (!token?.transactionHash || !Number.isSafeInteger(Number(token.firstSeenBlock))) continue;
            const transactionHash = normalizeTransactionHash(token.transactionHash);
            if (candidates.has(transactionHash)) continue;
            candidates.set(transactionHash, {
              launcher: launcherAddress,
              token: String(tokenAddress).toLowerCase(),
              transactionHash,
              blockNumber: Number(token.firstSeenBlock),
              transactionIndex: Number.MAX_SAFE_INTEGER,
              logIndex: Number.MAX_SAFE_INTEGER,
              observedAt: token.observedAt,
              source: "launcher_mode_history",
            });
          }
        }
      }
    }
    return [...candidates.values()]
      .filter((candidate) => flapActivationEligibleAt(activation, candidate.observedAt))
      .sort((left, right) => left.blockNumber - right.blockNumber
        || Number(left.transactionIndex || 0) - Number(right.transactionIndex || 0)
        || Number(left.logIndex || 0) - Number(right.logIndex || 0)
        || left.transactionHash.localeCompare(right.transactionHash));
  }

  async function processStoredFlapReplayCandidate(
    activationKey,
    candidate,
    signal = flapReplayAbortController.signal,
  ) {
    throwIfFlapReplayStopped(signal);
    const reserved = await withState(async () => {
      const activation = state.officialSources?.flap?.featureActivations?.[activationKey];
      if (!activation || activation.active === false || activation.firstTokenAlertedAt || activation.firstTokenTransactionHash) return false;
      if ((activation.replayAttemptedTransactionHashes || []).includes(candidate.transactionHash)) return false;
      delete state.seenTransactions[candidate.transactionHash];
      activation.replayLastAttemptAt = iso(now);
      activation.replayLastError = null;
      await save();
      return true;
    });
    if (!reserved) return false;
    throwIfFlapReplayStopped(signal);
    try {
      enqueue(candidate.transactionHash, candidate.blockNumber, "flap_feature_replay", {
        transactionIndex: candidate.transactionIndex,
        logIndex: candidate.logIndex,
        mintEmitters: [candidate.token],
        candidateTokens: [candidate.token],
        verifiedNewContracts: [candidate.token],
        featureActivationReplayKey: activationKey,
        protocol: true,
      });
      const entry = queue.get(candidate.transactionHash);
      if (!entry) throw new Error(`Flap replay could not reserve ${candidate.transactionHash}`);
      await processEntries([entry], entryRpcConcurrency, { flapReplaySignal: signal });
      throwIfFlapReplayStopped(signal);
      const alerted = await withState(async () => {
        const activation = state.officialSources?.flap?.featureActivations?.[activationKey];
        if (!activation) return false;
        activation.replayAttemptedTransactionHashes = [...new Set([
          ...(activation.replayAttemptedTransactionHashes || []),
          candidate.transactionHash,
        ])].slice(-FLAP_REPLAY_ATTEMPTED_TRANSACTIONS_MAX);
        await save();
        return Boolean(activation.firstTokenAlertedAt || activation.firstTokenTransactionHash);
      });
      throwIfFlapReplayStopped(signal);
      return alerted;
    } catch (error) {
      if (isFlapReplayStoppedError(error)) {
        // enqueue() is in-memory only here. Removing its abandoned work does
        // not remove the durable hot-index candidate used on the next start.
        queue.delete(candidate.transactionHash);
        throw error;
      }
      await withState(async () => {
        const activation = state.officialSources?.flap?.featureActivations?.[activationKey];
        if (activation) {
          activation.replayLastAttemptAt = iso(now);
          activation.replayLastError = errorSummary(error);
        }
        await save().catch(() => {});
      });
      throw error;
    }
  }

  async function runFlapActivationReplay(
    activationKey,
    signal = flapReplayAbortController.signal,
  ) {
    while (true) {
      throwIfFlapReplayStopped(signal);
      const phase = await withState(() => {
        const activation = state.officialSources?.flap?.featureActivations?.[activationKey];
        if (!activation || activation.active === false || activation.replayCompletedAt
          || activation.firstTokenAlertedAt || activation.firstTokenTransactionHash) return null;
        return {
          activation: structuredClone(activation),
          candidates: storedFlapReplayCandidates(state, activation),
          hotWatermark: flapActivationHotWatermark(state, activation),
        };
      });
      if (!phase) return false;
      for (const candidate of phase.candidates) {
        throwIfFlapReplayStopped(signal);
        if (await processStoredFlapReplayCandidate(activationKey, candidate, signal)) return true;
      }
      throwIfFlapReplayStopped(signal);
      const completion = await withState(async () => {
        const activation = state.officialSources?.flap?.featureActivations?.[activationKey];
        if (!activation || activation.active === false
          || activation.firstTokenAlertedAt || activation.firstTokenTransactionHash) return "done";
        const currentWatermark = flapActivationHotWatermark(state, activation);
        if (currentWatermark !== phase.hotWatermark) {
          activation.replayLastAttemptAt = iso(now);
          activation.replayLastError = null;
          await save();
          return "rescan";
        }
        activation.replayCompletedAt = iso(now);
        activation.replayLastAttemptAt = iso(now);
        activation.replayLastError = null;
        activation.hotReplayWatermark = currentWatermark;
        await save();
        return "done";
      });
      throwIfFlapReplayStopped(signal);
      if (completion !== "rescan") return false;
    }
  }

  async function replayFlapActivation(
    activationKey,
    signal = flapReplayAbortController.signal,
  ) {
    if (flapReplayFlights.has(activationKey)) return flapReplayFlights.get(activationKey);
    let flight;
    flight = runFlapActivationReplay(activationKey, signal).finally(() => {
      if (flapReplayFlights.get(activationKey) === flight) flapReplayFlights.delete(activationKey);
    });
    flapReplayFlights.set(activationKey, flight);
    return flight;
  }

  function flapReplayBackoffError(retryAt = flapReplayRetryAt) {
    const retryAfterMs = Math.max(1, Number(retryAt) - Number(now()));
    const error = new Error(`Flap activation replay is cooling down; retry in ${retryAfterMs}ms`);
    error.code = "BSC_FLAP_REPLAY_BACKOFF";
    error.retryAfterMs = retryAfterMs;
    return error;
  }

  async function recordFlapReplayBackoff(activationKey, error) {
    const retryDelayMs = sharedRpcRetryDelayMs(error);
    if (retryDelayMs <= 0) return { retryDelayMs: 0, shouldLog: true };
    const failedAt = Number(now());
    const failureFingerprint = normalizedFailureFingerprint(error);
    let shouldLog = true;
    flapReplayRetryAt = Math.max(flapReplayRetryAt, failedAt + retryDelayMs);
    await withState(async () => {
      const flap = state.officialSources.flap;
      const previous = flap.replayControl || { consecutiveFailures: 0 };
      const previousLoggedAt = Date.parse(previous.lastLoggedAt || "");
      shouldLog = previous.lastLoggedFingerprint !== failureFingerprint
        || !Number.isFinite(previousLoggedAt)
        || failedAt - previousLoggedAt >= 60_000;
      flap.replayControl = {
        ...previous,
        status: "backoff",
        checkedAt: iso(failedAt),
        lastErrorAt: iso(failedAt),
        lastError: errorSummary(error),
        consecutiveFailures: Number(previous.consecutiveFailures || 0) + 1,
        retryDelayMs,
        nextRetryAt: iso(flapReplayRetryAt),
        activationKey,
        lastLoggedFingerprint: shouldLog ? failureFingerprint : previous.lastLoggedFingerprint,
        lastLoggedAt: shouldLog ? iso(failedAt) : previous.lastLoggedAt,
      };
      const activation = flap.featureActivations?.[activationKey];
      if (activation) {
        activation.replayConsecutiveFailures = Number(activation.replayConsecutiveFailures || 0) + 1;
        activation.replayRetryDelayMs = retryDelayMs;
        activation.replayNextAttemptAt = iso(flapReplayRetryAt);
      }
      await save();
    });
    return { retryDelayMs, shouldLog };
  }

  async function clearFlapReplayBackoff(activationKey) {
    const needsPersist = await withState(() => {
      const control = state.officialSources?.flap?.replayControl || {};
      const activation = state.officialSources?.flap?.featureActivations?.[activationKey];
      return control.status === "backoff" || control.nextRetryAt || activation?.replayNextAttemptAt;
    });
    flapReplayRetryAt = 0;
    if (!needsPersist) return;
    await withState(async () => {
      const flap = state.officialSources.flap;
      flap.replayControl = {
        ...(flap.replayControl || {}),
        status: "healthy",
        checkedAt: iso(now),
        lastSuccessAt: iso(now),
        consecutiveFailures: 0,
        nextRetryAt: null,
        retryDelayMs: null,
        activationKey: null,
      };
      delete flap.replayControl.lastError;
      delete flap.replayControl.lastErrorAt;
      const activation = flap.featureActivations?.[activationKey];
      if (activation) {
        activation.replayConsecutiveFailures = 0;
        activation.replayRetryDelayMs = null;
        activation.replayNextAttemptAt = null;
      }
      await save();
    });
    resetFlapReplayFailureLog();
  }

  async function runPendingFlapActivations(
    keys = null,
    { throwOnError = false, signal = flapReplayAbortController.signal } = {},
  ) {
    if (stopped || signal?.aborted) return { skipped: true, reason: "stopped" };
    const current = Number(now());
    const persistedRetryAt = Date.parse(state?.officialSources?.flap?.replayControl?.nextRetryAt || "");
    flapReplayRetryAt = Math.max(
      flapReplayRetryAt,
      Number.isFinite(persistedRetryAt) && persistedRetryAt > current ? persistedRetryAt : 0,
    );
    if (flapReplayRetryAt > current) {
      if (throwOnError) throw flapReplayBackoffError();
      return { skipped: true, reason: "backoff", nextRetryAt: iso(flapReplayRetryAt) };
    }
    const requested = Array.isArray(keys)
      ? [...new Set(keys)]
      : await withState(() => Object.keys(state.officialSources?.flap?.featureActivations || {}));
    const failures = [];
    for (const key of requested) {
      try {
        while (true) {
          throwIfFlapReplayStopped(signal);
          await replayFlapActivation(key, signal);
          throwIfFlapReplayStopped(signal);
          const stillPending = await withState(() => {
            const activation = state.officialSources?.flap?.featureActivations?.[key];
            return Boolean(activation && activation.active !== false
              && !activation.replayCompletedAt
              && !activation.firstTokenAlertedAt
              && !activation.firstTokenTransactionHash);
          });
          if (!stillPending) break;
        }
        throwIfFlapReplayStopped(signal);
        await clearFlapReplayBackoff(key);
      } catch (error) {
        if (isFlapReplayStoppedError(error)) return { skipped: true, reason: "stopped" };
        const replayBackoff = await recordFlapReplayBackoff(key, error);
        if (replayBackoff.shouldLog) logFlapReplayFailure(key, error);
        failures.push({ key, error });
        // Every activation uses the same physical BSC RPC hosts. Once the
        // shared circuit supplies a deadline, probing later features in this
        // sweep can only repeat the same fail-fast result.
        if (replayBackoff.retryDelayMs > 0) break;
      }
    }
    if (throwOnError && failures.length === 1) throw failures[0].error;
    if (throwOnError && failures.length > 1) {
      throw new AggregateError(failures.map((failure) => failure.error), `Flap activation replay failed: ${failures.map((failure) => failure.key).join(", ")}`);
    }
    return { skipped: false, failures: failures.length };
  }

  function replayPendingFlapActivations(keys = null, options = {}) {
    const signal = options.signal || flapReplayAbortController.signal;
    if (stopped || signal.aborted) return Promise.resolve({ skipped: true, reason: "stopped" });
    // Serialize whole sweeps as well as individual features. The per-key map
    // keeps identical work single-flight; this lane lock prevents different
    // activation keys from concurrently probing one shared half-open host.
    const operation = flapReplaySweepLock.catch(() => {}).then(() => (
      stopped || signal.aborted
        ? { skipped: true, reason: "stopped" }
        : runPendingFlapActivations(keys, { ...options, signal })
    ));
    flapReplaySweepLock = operation.catch(() => {});
    return operation;
  }

  function compactFlapQuoteFirstThreeState(firstThree) {
    const windowEntries = Object.entries(firstThree.windows || {});
    const activeGenerationKeys = new Set(Object.values(firstThree.activeByQuote || {}));
    const retainedGenerationKeys = new Set(activeGenerationKeys);
    const newestInactive = windowEntries
      .filter(([generationKey]) => !retainedGenerationKeys.has(generationKey))
      .sort(([, left], [, right]) => Date.parse(right.activatedAt || "") - Date.parse(left.activatedAt || ""));
    for (const [generationKey] of newestInactive) {
      if (retainedGenerationKeys.size >= flapQuoteFirstThreeWindowMax) break;
      retainedGenerationKeys.add(generationKey);
    }
    firstThree.windows = Object.fromEntries(windowEntries
      .filter(([generationKey]) => retainedGenerationKeys.has(generationKey)));
    firstThree.activeByQuote = Object.fromEntries(Object.entries(firstThree.activeByQuote || {})
      .filter(([, generationKey]) => retainedGenerationKeys.has(generationKey)));

    const lifecycleEntries = Object.entries(firstThree.lifecycleEvents || {});
    const eligibleLifecycleEntries = lifecycleEntries.filter(([, event]) => (
      event?.generationKey === null || retainedGenerationKeys.has(event?.generationKey)
    ));
    const eligibleByKey = new Map(eligibleLifecycleEntries);
    const requiredLifecycleKeys = new Set();
    for (const window of Object.values(firstThree.windows)) {
      for (const eventKey of [window.activationEventKey, window.disableEventKey]) {
        if (eligibleByKey.has(eventKey)) requiredLifecycleKeys.add(eventKey);
      }
    }
    const retainedLifecycleKeys = new Set();
    for (const [eventKey] of [...eligibleLifecycleEntries].reverse()) {
      if (retainedLifecycleKeys.size >= flapQuoteFirstThreeLifecycleMax) break;
      if (requiredLifecycleKeys.has(eventKey)) retainedLifecycleKeys.add(eventKey);
    }
    for (const [eventKey] of [...eligibleLifecycleEntries].reverse()) {
      if (retainedLifecycleKeys.size >= flapQuoteFirstThreeLifecycleMax) break;
      retainedLifecycleKeys.add(eventKey);
    }
    firstThree.lifecycleEvents = Object.fromEntries(eligibleLifecycleEntries
      .filter(([eventKey]) => retainedLifecycleKeys.has(eventKey)));
  }

  async function registerFlapQuotePoolLifecycle(rawRecord) {
    await initialize();
    const record = normalizeFlapQuotePoolLifecycleRecord(rawRecord);
    const registered = await withState(async () => {
      const flap = state.officialSources.flap;
      flap.quotePoolFirstThree = normalizeFlapQuoteFirstThreeState(flap.quotePoolFirstThree);
      const firstThree = flap.quotePoolFirstThree;
      const duplicate = firstThree.lifecycleEvents[record.activationEventKey];
      let canonicalReplacementOfGeneration = null;
      let canonicalDisableReplacementGeneration = null;
      if (duplicate) {
        const exactProof = duplicate.action === record.action
          && duplicate.quoteAddress === record.quoteAddress
          && duplicate.quoteName === record.quoteName
          && duplicate.quoteSymbol === record.quoteSymbol
          && duplicate.blockHash === record.blockHash
          && duplicate.transactionHash === record.transactionHash
          && duplicate.blockNumber === record.blockNumber
          && duplicate.transactionIndex === record.transactionIndex
          && duplicate.logIndex === record.logIndex
          && duplicate.occurredAt === record.occurredAt
          && duplicate.proofType === record.proofType
          && duplicate.requiredConfirmations === record.requiredConfirmations
          && (duplicate.targetActivationEventKey || null) === (record.targetActivationEventKey || null);
        if (exactProof) {
          const duplicateWindow = duplicate.generationKey
            ? firstThree.windows[duplicate.generationKey]
            : null;
          const resumeDuplicateReplay = ["activated", "restored"].includes(duplicate.action)
            && duplicateWindow?.active === true
            && !duplicateWindow.trackingCompletedAt;
          return {
            accepted: true,
            changed: false,
            action: record.action,
            status: "duplicate",
            quoteAddress: record.quoteAddress,
            generationKey: duplicate.generationKey,
            replayGenerationKey: resumeDuplicateReplay ? duplicate.generationKey : null,
          };
        }
        const canonicalActivationReplacement = record.action === "activated"
          && duplicate.action === "activated"
          && duplicate.quoteAddress === record.quoteAddress
          && duplicate.transactionHash === record.transactionHash
          && duplicate.logIndex === record.logIndex
          && duplicate.blockHash !== record.blockHash;
        const canonicalDisableReplacement = record.action === "disabled"
          && ["disabled", "restored"].includes(duplicate.action)
          && duplicate.quoteAddress === record.quoteAddress
          && duplicate.transactionHash === record.transactionHash
          && duplicate.logIndex === record.logIndex
          && duplicate.blockHash !== record.blockHash;
        if (canonicalActivationReplacement) {
          canonicalReplacementOfGeneration = duplicate.generationKey;
          const orphaned = firstThree.windows[canonicalReplacementOfGeneration];
          if (!orphaned) throw new Error(`missing orphaned Flap quote generation ${canonicalReplacementOfGeneration}`);
          orphaned.active = false;
          orphaned.status = "canonical_replaced";
          orphaned.canonicalReplacedAt = iso(now);
          orphaned.canonicalReplacementBlockHash = record.blockHash;
          if (firstThree.activeByQuote[record.quoteAddress] === canonicalReplacementOfGeneration) {
            delete firstThree.activeByQuote[record.quoteAddress];
          }
        } else if (canonicalDisableReplacement) {
          canonicalDisableReplacementGeneration = duplicate.generationKey || null;
        } else if (!(record.action === "restored"
          && duplicate.action === "disabled"
          && duplicate.quoteAddress === record.quoteAddress)) {
          throw new Error(`conflicting Flap quote lifecycle event ${record.activationEventKey}`);
        }
      }

      if (record.action === "restored") {
        if (!duplicate
          || duplicate.action !== "disabled"
          || duplicate.blockHash !== record.blockHash
          || duplicate.transactionHash !== record.transactionHash
          || duplicate.logIndex !== record.logIndex) {
          throw new Error(`Flap quote restore does not match disabled proof ${record.activationEventKey}`);
        }
        const window = duplicate.generationKey
          ? firstThree.windows[duplicate.generationKey]
          : null;
        if (!window
          || window.quoteAddress !== record.quoteAddress
          || window.activationEventKey !== record.targetActivationEventKey
          || window.active === true
          || window.disableEventKey !== record.activationEventKey
          || window.disableBlockHash !== record.blockHash
          || window.disableTransactionHash !== record.transactionHash
          || window.disableLogIndex !== record.logIndex) {
          throw new Error(`Flap quote restore target is not the exact disabled generation ${record.targetActivationEventKey}`);
        }
        const activeGenerationKey = firstThree.activeByQuote[record.quoteAddress];
        if (activeGenerationKey && activeGenerationKey !== window.generationKey) {
          throw new Error(`Flap quote restore conflicts with active generation ${activeGenerationKey}`);
        }
        window.active = true;
        window.status = "active";
        window.restoredAt = record.occurredAt;
        window.orphanedDisableProof = {
          eventKey: record.activationEventKey,
          transactionHash: record.transactionHash,
          blockHash: record.blockHash,
          transactionIndex: record.transactionIndex,
          logIndex: record.logIndex,
        };
        const resumeReplay = !window.trackingCompletedAt;
        if (resumeReplay) {
          const resumeBlock = Number(window.disableBlockNumber);
          window.archiveReplayNextBlock = Number.isSafeInteger(resumeBlock)
            ? Math.min(Number(window.archiveReplayNextBlock ?? resumeBlock), resumeBlock)
            : Number(window.activationBlockNumber);
          window.archiveReplayTargetBlock = null;
          window.replayCompletedAt = null;
          window.trackingCompletedAt = null;
          window.replayStatus = "restored_disable_orphan";
          window.replayLastError = null;
        }
        firstThree.activeByQuote[record.quoteAddress] = window.generationKey;
        // A candidate can be durably handed off while this generation is
        // disabled. Re-attach the causal key in the same lifecycle commit that
        // makes the generation claimable again, before archive replay or a
        // later WebSocket candidate can reserve an ordinal.
        backfillNewFlapFirstThreeBarrier(state, window.generationKey, window);
        firstThree.lifecycleEvents[record.activationEventKey] = {
          action: "restored",
          quoteAddress: record.quoteAddress,
          quoteName: record.quoteName,
          quoteSymbol: record.quoteSymbol,
          generationKey: window.generationKey,
          targetActivationEventKey: record.targetActivationEventKey,
          transactionHash: record.transactionHash,
          blockNumber: record.blockNumber,
          blockHash: record.blockHash,
          transactionIndex: record.transactionIndex,
          logIndex: record.logIndex,
          occurredAt: record.occurredAt,
          proofType: record.proofType,
          requiredConfirmations: record.requiredConfirmations,
        };
        compactFlapQuoteFirstThreeState(firstThree);
        await save();
        return {
          accepted: true,
          changed: true,
          action: "restored",
          status: "restored",
          quoteAddress: record.quoteAddress,
          generationKey: window.generationKey,
          replayGenerationKey: resumeReplay ? window.generationKey : null,
        };
      }

      if (record.action === "disabled") {
        const generationKey = firstThree.activeByQuote[record.quoteAddress]
          || canonicalDisableReplacementGeneration
          || null;
        const window = generationKey ? firstThree.windows[generationKey] : null;
        if (window) {
          const disablePosition = {
            blockNumber: record.blockNumber,
            transactionIndex: record.transactionIndex,
            logIndex: record.logIndex,
            transactionHash: record.transactionHash,
          };
          const activationPosition = {
            blockNumber: window.activationBlockNumber,
            transactionIndex: window.activationTransactionIndex,
            logIndex: window.activationLogIndex,
            transactionHash: window.activationTransactionHash,
          };
          if (compareFlapQuoteTokenCandidates(disablePosition, activationPosition) <= 0) {
            throw new Error(`Flap quote disable predates active generation ${generationKey}`);
          }
          window.active = false;
          window.status = "disabled";
          window.disabledAt = record.occurredAt;
          window.disableEventKey = record.activationEventKey;
          window.disableTransactionHash = record.transactionHash;
          window.disableBlockHash = record.blockHash;
          window.disableBlockNumber = record.blockNumber;
          window.disableTransactionIndex = record.transactionIndex;
          window.disableLogIndex = record.logIndex;
          if (canonicalDisableReplacementGeneration) {
            window.disableCanonicalReplacementAt = iso(now);
            window.disableCanonicalReplacementOfBlockHash = duplicate.blockHash;
          }
          delete firstThree.activeByQuote[record.quoteAddress];
        }
        firstThree.lifecycleEvents[record.activationEventKey] = {
          action: "disabled",
          quoteAddress: record.quoteAddress,
          quoteName: record.quoteName,
          quoteSymbol: record.quoteSymbol,
          generationKey,
          transactionHash: record.transactionHash,
          blockNumber: record.blockNumber,
          blockHash: record.blockHash,
          transactionIndex: record.transactionIndex,
          logIndex: record.logIndex,
          occurredAt: record.occurredAt,
          proofType: record.proofType,
          requiredConfirmations: record.requiredConfirmations,
        };
        compactFlapQuoteFirstThreeState(firstThree);
        await save();
        return {
          accepted: true,
          changed: true,
          action: "disabled",
          status: "disabled",
          quoteAddress: record.quoteAddress,
          generationKey,
          replayGenerationKey: null,
        };
      }

      const generationKey = flapQuoteFirstThreeGenerationKey(record);
      const activeGenerationKey = firstThree.activeByQuote[record.quoteAddress] || null;
      if (activeGenerationKey && activeGenerationKey !== generationKey) {
        throw new Error(`Flap quote ${record.quoteAddress} already has active generation ${activeGenerationKey}`);
      }
      let window = firstThree.windows[generationKey];
      if (!window) {
        window = {
          generationKey,
          activationId: generationKey,
          quoteAddress: record.quoteAddress,
          quoteName: record.quoteName,
          quoteSymbol: record.quoteSymbol,
          activationEventKey: record.activationEventKey,
          activationTransactionHash: record.transactionHash,
          activationBlockHash: record.blockHash,
          activationBlockNumber: record.blockNumber,
          activationTransactionIndex: record.transactionIndex,
          activationLogIndex: record.logIndex,
          activatedAt: record.occurredAt,
          proofType: "verified_zero_to_one",
          requiredActivationConfirmations: record.requiredConfirmations,
          targetCount: FLAP_QUOTE_FIRST_THREE_TARGET,
          monitorOnly: true,
          active: true,
          status: "active",
          slots: [],
          replayAttemptedCandidateKeys: [],
          replayCompletedAt: null,
          canonicalReplacementOfGeneration,
          createdAt: iso(now),
        };
        firstThree.windows[generationKey] = window;
        backfillNewFlapFirstThreeBarrier(state, generationKey, window);
      } else if (window.activationEventKey !== record.activationEventKey
        || window.quoteAddress !== record.quoteAddress
        || window.activationBlockHash !== record.blockHash
        || window.activationTransactionHash !== record.transactionHash
        || window.activationLogIndex !== record.logIndex) {
        throw new Error(`conflicting Flap quote generation ${generationKey}`);
      } else {
        window.quoteName ||= record.quoteName;
        window.quoteSymbol ||= record.quoteSymbol;
        window.active = true;
        window.status = "active";
      }
      firstThree.activeByQuote[record.quoteAddress] = generationKey;
      firstThree.lifecycleEvents[record.activationEventKey] = {
        action: "activated",
        quoteAddress: record.quoteAddress,
        quoteName: record.quoteName,
        quoteSymbol: record.quoteSymbol,
        generationKey,
        transactionHash: record.transactionHash,
        blockNumber: record.blockNumber,
        blockHash: record.blockHash,
        transactionIndex: record.transactionIndex,
        logIndex: record.logIndex,
        occurredAt: record.occurredAt,
        proofType: record.proofType,
        requiredConfirmations: record.requiredConfirmations,
      };
      compactFlapQuoteFirstThreeState(firstThree);
      await save();
      return {
        accepted: true,
        changed: true,
        action: "activated",
        status: "activated",
        quoteAddress: record.quoteAddress,
        generationKey,
        replayGenerationKey: generationKey,
      };
    });
    // The lifecycle producer advances its own durable cursor only after this
    // acknowledgement. Archive availability must not hold that cursor hostage:
    // the generation and its exact replay cursor are already durable here, and
    // startup/maintenance retries own the independent catch-up lane.
    if (registered.replayGenerationKey) {
      trackBackgroundReplay(() => replayFlapQuoteFirstThreeGeneration(registered.replayGenerationKey));
    }
    const { replayGenerationKey: _replayGenerationKey, ...ack } = registered;
    return ack;
  }

  function activeFlapQuoteFirstThreeWindows(snapshot = state) {
    const firstThree = snapshot?.officialSources?.flap?.quotePoolFirstThree;
    if (!firstThree) return [];
    return Object.entries(firstThree.activeByQuote || {}).flatMap(([quoteAddress, generationKey]) => {
      const window = firstThree.windows?.[generationKey];
      return window?.active === true && window.quoteAddress === quoteAddress
        ? [[generationKey, window]] : [];
    });
  }

  function flapQuoteCandidateAfterActivation(candidate, window) {
    return compareFlapQuoteTokenCandidates(candidate, {
      blockNumber: window.activationBlockNumber,
      transactionIndex: window.activationTransactionIndex,
      logIndex: window.activationLogIndex,
      transactionHash: window.activationTransactionHash,
      tokenAddress: "0x0000000000000000000000000000000000000000",
    }) > 0;
  }

  function addCausalBarrierToTransaction(targetState, transactionHash, causalKey) {
    const normalizedHash = normalizeTransactionHash(transactionHash);
    let changed = false;
    for (const collection of [
      targetState?.realtimePendingEntries || {},
      targetState?.deferredCreationEvidence || {},
    ]) {
      const record = collection[normalizedHash];
      if (!record || targetState?.seenTransactions?.[normalizedHash]) continue;
      const next = normalizeBscCausalBarrierKeys([...(record.causalBarrierKeys || []), causalKey]);
      if (JSON.stringify(next) === JSON.stringify(record.causalBarrierKeys || [])) continue;
      record.causalBarrierKeys = next;
      record.revision = Number(record.revision || 0) + 1;
      changed = true;
    }
    const queued = queue.get(normalizedHash);
    if (queued && !targetState?.seenTransactions?.[normalizedHash]) {
      const next = normalizeBscCausalBarrierKeys([...(queued.causalBarrierKeys || []), causalKey]);
      if (JSON.stringify(next) !== JSON.stringify(queued.causalBarrierKeys || [])) {
        queued.causalBarrierKeys = next;
        queued.revision = Number(queued.revision || 0) + 1;
        changed = true;
      }
    }
    return changed;
  }

  function queuedFlapCreationHotCandidates() {
    return [...queue.values()].flatMap((entry) => [
      ...(entry.flapCreationHotCandidates?.values?.() || []),
    ]);
  }

  function durableFlapCreationHotCandidates(targetState = state) {
    return [
      ...Object.values(targetState?.realtimePendingEntries || {}),
      ...Object.values(targetState?.deferredCreationEvidence || {}),
    ].flatMap((record) => record?.flapCreationHotCandidates || []);
  }

  function queuedFourMemeCreationHotCandidates() {
    return [...queue.values()].flatMap((entry) => [
      ...(entry.fourMemeCreationHotCandidates?.values?.() || []),
    ]);
  }

  function durableFourMemeCreationHotCandidates(targetState = state) {
    return [
      ...Object.values(targetState?.realtimePendingEntries || {}),
      ...Object.values(targetState?.deferredCreationEvidence || {}),
    ].flatMap((record) => record?.fourMemeCreationHotCandidates || []);
  }

  function backfillNewFeatureCausalBarrier(targetState, platform, activationKey, activation) {
    if (!activationKey || activation?.allowReplay !== true || activation?.active === false) return 0;
    const causalKey = `feature:${activationKey}`;
    let candidates = [];
    if (platform === "flap") {
      candidates = normalizeFlapCreationHotIndex([
        ...normalizeFlapCreationHotIndex(targetState?.officialSources?.flap?.creationEventHotIndex, now()),
        ...durableFlapCreationHotCandidates(targetState),
        ...queuedFlapCreationHotCandidates(),
      ], null).filter((candidate) => flapRawCandidateMatchesActivation(candidate, activation)
        && candidateInActivationBlockWindow(
          candidate,
          activation,
          FLAP_ACTIVATION_REPLAY_LOOKBACK_MS,
          targetState,
          { conservative: true },
        ));
    } else if (platform === "fourmeme") {
      candidates = normalizeFourMemeCreationHotIndex([
        ...normalizeFourMemeCreationHotIndex(targetState?.officialSources?.fourMeme?.creationEventHotIndex, now()),
        ...durableFourMemeCreationHotCandidates(targetState),
        ...queuedFourMemeCreationHotCandidates(),
      ], null).filter((candidate) => fourMemeCandidateMatchesActivation(
        candidate,
        activation,
        { requireEventTime: false },
      ) && candidateInActivationBlockWindow(
        candidate,
        activation,
        FOUR_MEME_ACTIVATION_REPLAY_LOOKBACK_MS,
        targetState,
        { conservative: true },
      ));
    }
    let changed = 0;
    for (const transactionHash of new Set(candidates.map((candidate) => candidate.transactionHash))) {
      if (addCausalBarrierToTransaction(targetState, transactionHash, causalKey)) changed += 1;
    }
    return changed;
  }

  function backfillNewFlapFirstThreeBarrier(targetState, generationKey, window) {
    if (!generationKey || window?.active !== true) return 0;
    const causalKey = `first3:${generationKey}`;
    const candidates = normalizeFlapCreationHotIndex([
      ...normalizeFlapCreationHotIndex(targetState?.officialSources?.flap?.creationEventHotIndex, now()),
      ...durableFlapCreationHotCandidates(targetState),
      ...queuedFlapCreationHotCandidates(),
    ], null).filter((candidate) => candidate.topic === FLAP_TOKEN_CREATED_TOPIC
      && candidate.launcher === FLAP_PORTAL_ADDRESS
      && flapQuoteCandidateAfterActivation(candidate, window));
    let changed = 0;
    for (const transactionHash of new Set(candidates.map((candidate) => candidate.transactionHash))) {
      if (addCausalBarrierToTransaction(targetState, transactionHash, causalKey)) changed += 1;
    }
    return changed;
  }

  function verifiedFlapQuotePair(pools = [], tokenAddress, quoteAddress) {
    const token = String(tokenAddress || "").toLowerCase();
    const quote = String(quoteAddress || "").toLowerCase();
    return (pools || []).filter((pool) => {
      const factory = String(pool?.factory || "").toLowerCase();
      const dex = BSC_DEX_CONTRACTS.get(factory);
      const token0 = String(pool?.token0 || "").toLowerCase();
      const token1 = String(pool?.token1 || "").toLowerCase();
      return pool?.verifiedDex === true
        && dex
        && FLAP_QUOTE_FIRST_THREE_PAIR_FACTORIES.has(factory)
        && [dex.name, dex.kind].includes(pool.kind)
        && ADDRESS.test(String(pool?.pool || "").toLowerCase())
        && ((token0 === token && token1 === quote) || (token1 === token && token0 === quote));
    }).sort((left, right) => String(left.pool).toLowerCase().localeCompare(String(right.pool).toLowerCase()))[0] || null;
  }

  function coarseFlapQuoteFirstThreeMatches(
    snapshot,
    observation,
    candidates = [],
    authorizedGenerationKeys = [],
  ) {
    const replayGenerationKeys = new Set([
      observation?.flapQuoteFirstThreeReplayGenerationKey,
      ...authorizedGenerationKeys,
    ].filter(Boolean));
    const windows = activeFlapQuoteFirstThreeWindows(snapshot);
    const matches = [];
    for (const candidate of [...candidates].sort(compareFlapQuoteTokenCandidates)) {
      const tokenAddress = String(candidate?.token || "").toLowerCase();
      if (String(candidate?.topic || "").toLowerCase() !== FLAP_TOKEN_CREATED_TOPIC
        || String(candidate?.launcher || "").toLowerCase() !== FLAP_PORTAL_ADDRESS
        || !ADDRESS.test(tokenAddress)) continue;
      const token = (observation?.tokens || []).find((item) => String(item?.token || "").toLowerCase() === tokenAddress);
      if (!token) continue;
      for (const [generationKey, window] of windows) {
        if (!window.replayCompletedAt && !replayGenerationKeys.has(generationKey)) continue;
        if (!flapQuoteCandidateAfterActivation(candidate, window)) continue;
        const pair = verifiedFlapQuotePair(observation?.pools, tokenAddress, window.quoteAddress);
        if (!pair) continue;
        matches.push({ generationKey, window, candidate, token, pair });
      }
    }
    return matches.sort((left, right) => compareFlapQuoteTokenCandidates(left.candidate, right.candidate)
      || left.window.quoteAddress.localeCompare(right.window.quoteAddress));
  }

  function hasFlapQuoteFirstThreeMatch(snapshot, observation, candidates = [], authorizedGenerationKeys = []) {
    return coarseFlapQuoteFirstThreeMatches(
      snapshot,
      observation,
      candidates,
      authorizedGenerationKeys,
    ).length > 0;
  }

  function normalizedFlapEventPool(pool) {
    const factory = String(pool.factory || "").toLowerCase();
    const dex = BSC_DEX_CONTRACTS.get(factory);
    return {
      ...pool,
      kind: dex?.kind || null,
      factory,
      token0: String(pool.token0 || "").toLowerCase(),
      token1: String(pool.token1 || "").toLowerCase(),
      pool: String(pool.pool || "").toLowerCase(),
      poolId: pool.poolId || null,
      hook: pool.hook ? String(pool.hook).toLowerCase() : null,
      verifiedDex: true,
    };
  }

  function unavailableFlapTokenSecurity(reason = "本地链上安全检查未返回结果") {
    return {
      decision: "unknown",
      label: "安全检查未完成",
      reasons: [reason],
      metrics: {
        sellSimulation: "not_available",
        coverage: {
          bytecodeCapabilities: "unknown",
          owner: "unknown",
          proxy: "unknown",
          liquidity: "unknown",
          sellability: "not_checked",
          buySellTax: "not_checked",
          holderConcentration: "not_checked",
          lpLockOrBurn: "not_checked",
        },
      },
    };
  }

  function flapQuoteFirstThreeEvent(window, slot) {
    const tokenAddress = slot.tokenAddress;
    const quoteAddress = window.quoteAddress;
    const pair = structuredClone(slot.pool);
    const quoteLabel = window.quoteSymbol || window.quoteName
      || `${quoteAddress.slice(0, 8)}…${quoteAddress.slice(-4)}`;
    const sourceUrl = `https://bscscan.com/tx/${slot.transactionHash}`;
    const activationSourceUrl = `https://bscscan.com/tx/${window.activationTransactionHash}`;
    const featureTokenProof = {
      version: 1,
      activationId: window.activationId,
      activationEventKey: window.activationEventKey,
      quoteAddress,
      tokenAddress,
      portal: FLAP_PORTAL_ADDRESS,
      tokenCreatedTopic: FLAP_TOKEN_CREATED_TOPIC,
      transactionHash: slot.transactionHash,
      blockNumber: slot.blockNumber,
      blockHash: slot.blockHash,
      transactionIndex: slot.transactionIndex,
      logIndex: slot.logIndex,
      canonical: true,
      confirmations: slot.confirmations,
      requiredConfirmations: slot.requiredConfirmations,
      pairAddress: slot.pairAddress,
      pairKind: slot.pairKind,
    };
    const recoveryLagMs = Math.max(0, Date.parse(slot.reservedAt) - Date.parse(slot.blockTimestamp));
    const delayedRecovery = recoveryLagMs > FLAP_ACTIVATION_REPLAY_LOOKBACK_MS ? {
      version: 1,
      reason: "verified_generation_archive_catch_up",
      sourceOccurredAt: slot.blockTimestamp,
      firstObservedAt: slot.firstObservedAt,
      recoveredAt: slot.reservedAt,
      lagMs: recoveryLagMs,
      continuousCoverage: true,
    } : null;
    const platform = {
      ...publicPlatform(BSC_LAUNCHPAD_CATALOG.find((entry) => entry.id === "flap")),
      id: "flap",
      name: "Flap",
      trust: "official_verified",
      evidenceUrl: `https://bscscan.com/address/${FLAP_PORTAL_ADDRESS}`,
    };
    return {
      type: "bsc_launchpad_update",
      kind: "flap_pool_token",
      eventKey: slot.eventKey,
      chainId: BSC_CHAIN_ID,
      launcher: FLAP_PORTAL_ADDRESS,
      platform,
      featurePlatform: "flap",
      featureActivationKey: window.generationKey,
      featureGenerationKey: window.generationKey,
      featureTrackedToken: true,
      featureTokenOrdinal: slot.ordinal,
      featureTokenTarget: FLAP_QUOTE_FIRST_THREE_TARGET,
      featureFirstToken: slot.ordinal === 1,
      informationalOnly: true,
      autoTradeEligible: false,
      automaticExecution: false,
      strong: true,
      launchCount: slot.ordinal,
      uniqueTokens: slot.ordinal,
      transactionHash: slot.transactionHash,
      blockNumber: slot.blockNumber,
      blockHash: slot.blockHash,
      blockTimestamp: slot.blockTimestamp,
      transactionIndex: slot.transactionIndex,
      logIndex: slot.logIndex,
      tokens: [{
        token: tokenAddress,
        isNewContract: true,
        metadata: structuredClone(slot.metadata),
      }],
      pools: [pair],
      mode: {
        fingerprint: digest({ generationKey: window.generationKey, quoteAddress }),
        selector: "official-portal-token-created",
        creationTopics: [FLAP_TOKEN_CREATED_TOPIC],
        customTopics: [FLAP_TOKEN_CREATED_TOPIC],
        quoteAsset: quoteAddress,
        quoteName: window.quoteName,
        quoteSymbol: window.quoteSymbol,
        componentMode: `Flap ${quoteLabel} 新底池`,
        componentModeAlertEligible: true,
        featureActivationEligible: true,
        monitorOnly: true,
      },
      structural: {
        eligible: true,
        mechanismEvidence: true,
        causalTokenEvent: true,
        controllerKind: "official_direct",
        source: "verified_flap_portal_receipt",
      },
      security: structuredClone(slot.security),
      featureTokenProof,
      ...(slot.canonicalRevision ? { canonicalRevision: structuredClone(slot.canonicalRevision) } : {}),
      ...(delayedRecovery ? { delayedRecovery } : {}),
      launchEvidence: [{
        emitter: FLAP_PORTAL_ADDRESS,
        topic: FLAP_TOKEN_CREATED_TOPIC,
        token: tokenAddress,
      }],
      sourceUrl,
      activationSourceUrl,
      explorerUrl: sourceUrl,
      launcherUrl: `https://bscscan.com/address/${FLAP_PORTAL_ADDRESS}`,
      observedAt: slot.reservedAt,
    };
  }

  function acceptedFlapQuoteFirstThreeDelivery(result) {
    const status = String(result?.status || "").toLowerCase();
    if (["delivered", "queued"].includes(status)) return true;
    return status === "suppressed"
      && String(result?.reason || result?.disabledReason || "").toLowerCase() === "semantic_duplicate"
      && result?.persisted === true
      && result?.canonicalOwnerDelivered === true;
  }

  async function codeBackedFlapQuoteCandidates(observation, matches) {
    const result = new Map();
    for (const tokenAddress of [...new Set(matches.map((match) => String(match.candidate.token).toLowerCase()))]) {
      let code;
      try {
        code = await provider.getCode(tokenAddress, observation.blockNumber);
      } catch (error) {
        if (!isBscArchiveStateUnavailable(error)) throw error;
        code = await provider.getCode(tokenAddress);
      }
      if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(code)) {
        throw new Error(`Flap first-three token code proof malformed ${tokenAddress}`);
      }
      result.set(tokenAddress, code !== "0x");
    }
    return result;
  }

  async function reconcileFlapQuoteFirstThreeCanonicalSlots(generationKey) {
    const snapshot = await withState(() => {
      const window = state.officialSources?.flap?.quotePoolFirstThree?.windows?.[generationKey];
      return window?.active === true && window.slots?.length
        ? structuredClone(window)
        : null;
    });
    if (!snapshot) return false;
    const blockNumbers = [...new Set(snapshot.slots.map((slot) => Number(slot.blockNumber)))];
    const canonicalBlocks = new Map();
    for (const blockNumber of blockNumbers) {
      const block = await provider.getBlock(blockNumber);
      const blockHash = normalizeTransactionHash(block?.hash);
      if (!block || !/^0x[0-9a-f]{64}$/.test(blockHash)) {
        throw new Error(`Flap first-three canonical block proof unavailable ${blockNumber}`);
      }
      canonicalBlocks.set(blockNumber, blockHash);
    }
    const mismatched = snapshot.slots
      .filter((slot) => canonicalBlocks.get(Number(slot.blockNumber)) !== slot.blockHash)
      .sort((left, right) => left.ordinal - right.ordinal);
    if (!mismatched.length) return false;
    const earliestOrdinal = mismatched[0].ordinal;
    const expectedAnchor = snapshot.slots.find((slot) => slot.ordinal === earliestOrdinal);
    for (const blockNumber of blockNumbers) {
      const cached = blockCache.get(blockNumber);
      if (cached) invalidateBlockCacheGeneration(blockNumber, cached);
    }
    return withState(async () => {
      const window = state.officialSources?.flap?.quotePoolFirstThree?.windows?.[generationKey];
      const anchor = window?.slots?.find((slot) => slot.ordinal === earliestOrdinal);
      if (!window || window.active !== true || !anchor
        || anchor.eventKey !== expectedAnchor.eventKey
        || anchor.blockHash !== expectedAnchor.blockHash) return false;
      const orphanedAt = iso(now);
      const tail = window.slots.filter((slot) => slot.ordinal >= earliestOrdinal);
      window.pendingCanonicalReplacements ||= {};
      window.orphanedSlots ||= [];
      for (const slot of tail) {
        if (slot.deliveryAcceptedAt) {
          window.pendingCanonicalReplacements[String(slot.ordinal)] = {
            ordinal: slot.ordinal,
            eventKey: slot.eventKey,
            blockHash: slot.blockHash,
            tokenAddress: slot.tokenAddress,
            orphanedAt,
          };
        }
        window.orphanedSlots.push({
          ...structuredClone(slot),
          canonicalOrphanedAt: orphanedAt,
        });
        delete state.seenTransactions[slot.transactionHash];
        delete state.deferredCreationEvidence[slot.transactionHash];
        delete state.realtimePendingEntries[slot.transactionHash];
      }
      window.orphanedSlots = window.orphanedSlots.slice(-12);
      window.slots = window.slots.filter((slot) => slot.ordinal < earliestOrdinal);
      window.archiveReplayNextBlock = Math.min(...tail.map((slot) => Number(slot.blockNumber)));
      window.archiveReplayTargetBlock = null;
      window.replayCompletedAt = null;
      window.trackingCompletedAt = null;
      window.replayStatus = "canonical_reorg";
      window.canonicalReorgCount = Number(window.canonicalReorgCount || 0) + 1;
      window.lastCanonicalReorgAt = orphanedAt;
      await save();
      return true;
    });
  }

  async function reserveFlapQuoteFirstThreeSlot(match, observation) {
    const tokenAddress = String(match.candidate.token).toLowerCase();
    const assessment = (observation.tokenAssessments || [])
      .find((item) => String(item?.token || "").toLowerCase() === tokenAddress);
    const metadata = assessment?.metadata || match.token.metadata || null;
    const security = assessment?.security || unavailableFlapTokenSecurity();
    const pool = normalizedFlapEventPool(match.pair);
    const candidateKey = flapCreationCandidateKey({
      transactionHash: match.candidate.transactionHash,
      logIndex: match.candidate.logIndex,
      token: tokenAddress,
    });
    if (beforeCausalGroupReservation) {
      await beforeCausalGroupReservation({
        transactionHash: normalizeTransactionHash(observation.transactionHash),
        causalKeys: [`first3:${match.generationKey}`],
        claim: "flap_first_three",
      });
    }
    return withState(async () => {
      if (!isDurableCausalGroupHead({
        transactionHash: normalizeTransactionHash(observation.transactionHash),
        flapQuoteFirstThreeReplayGenerationKey: match.generationKey,
      })) return null;
      const firstThree = state.officialSources?.flap?.quotePoolFirstThree;
      const window = firstThree?.windows?.[match.generationKey];
      if (!window || window.active !== true
        || firstThree.activeByQuote?.[window.quoteAddress] !== match.generationKey) return null;
      const existing = (window.slots || []).find((slot) => slot.tokenAddress === tokenAddress);
      if (existing) return { window: structuredClone(window), slot: structuredClone(existing) };
      if ((window.slots || []).length >= FLAP_QUOTE_FIRST_THREE_TARGET) return null;
      const previous = window.slots?.at(-1);
      if (previous && compareFlapQuoteTokenCandidates(match.candidate, previous) <= 0) {
        const error = new Error(`Flap first-three candidate arrived out of canonical order ${candidateKey}`);
        error.code = "BSC_FLAP_FIRST_THREE_ORDER_PENDING";
        throw error;
      }
      const ordinal = (window.slots || []).length + 1;
      const replacement = window.pendingCanonicalReplacements?.[String(ordinal)] || null;
      const reservedAt = iso(now);
      const slot = {
        ordinal,
        candidateKey,
        tokenAddress,
        transactionHash: normalizeTransactionHash(match.candidate.transactionHash),
        blockNumber: Number(match.candidate.blockNumber),
        blockHash: observation.blockHash,
        transactionIndex: Number(match.candidate.transactionIndex),
        logIndex: Number(match.candidate.logIndex),
        blockTimestamp: match.candidate.observedAt,
        firstObservedAt: match.candidate.indexedAt || observation.observedAt || reservedAt,
        confirmations: Number(observation.confirmations),
        requiredConfirmations: Number(observation.requiredConfirmations),
        pairAddress: String(pool.pool).toLowerCase(),
        pairKind: pool.kind,
        pool,
        metadata: structuredClone(metadata),
        security: structuredClone(security),
        replay: observation.flapQuoteFirstThreeReplayGenerationKey === match.generationKey,
        reservedAt,
        deliveryStatus: "pending",
        deliveryAcceptedAt: null,
      };
      if (replacement) {
        slot.canonicalRevision = {
          version: 1,
          reason: "token_created_reorg",
          ordinal,
          replacesEventKey: replacement.eventKey,
          replacesBlockHash: replacement.blockHash,
          replacesTokenAddress: replacement.tokenAddress,
        };
      }
      const ordinaryEventKey = `bsc-flap-pool-token:${match.generationKey}:${ordinal}:${candidateKey}`;
      slot.eventKey = replacement
        ? `${ordinaryEventKey}:canonical-revision:${slot.blockHash}`
        : ordinaryEventKey;
      slot.event = flapQuoteFirstThreeEvent(window, slot);
      window.slots ||= [];
      window.slots.push(slot);
      window.lastCandidateAt = reservedAt;
      await save();
      return { window: structuredClone(window), slot: structuredClone(slot) };
    });
  }

  async function deliverFlapQuoteFirstThreeSlot(generationKey, slot) {
    if (!slot || slot.deliveryAcceptedAt) return slot?.event || null;
    const delivery = await withEventDelivery(slot.eventKey, async () => {
      let result;
      try {
        result = await alertSender(config, structuredClone(slot.event));
      } catch (error) {
        error.code ||= "ALERT_DELIVERY_PENDING";
        throw error;
      }
      if (!acceptedFlapQuoteFirstThreeDelivery(result)) {
        await withState(async () => {
          const current = state.officialSources?.flap?.quotePoolFirstThree
            ?.windows?.[generationKey]?.slots?.find((item) => item.eventKey === slot.eventKey);
          if (!current || current.deliveryAcceptedAt) return;
          current.lastDeliveryRejectedAt = iso(now);
          current.lastDeliveryResult = {
            status: result?.status || null,
            reason: result?.reason || result?.disabledReason || null,
            terminal: result?.terminal === true,
          };
          await save();
        });
        const error = new Error(`Flap first-three alert was not durably accepted: ${result?.reason || result?.disabledReason || result?.status || "unknown"}`);
        error.code = "ALERT_DELIVERY_PENDING";
        throw error;
      }
      await withState(async () => {
        const window = state.officialSources?.flap?.quotePoolFirstThree?.windows?.[generationKey];
        const current = window?.slots?.find((item) => item.eventKey === slot.eventKey);
        if (!current || current.deliveryAcceptedAt) return;
        current.deliveryStatus = String(result.status).toLowerCase();
        current.deliveryAcceptedAt = result.deliveredAt || iso(now);
        current.deliveryEventId = result.eventId || slot.eventKey;
        if (current.canonicalRevision
          && window.pendingCanonicalReplacements?.[String(current.ordinal)]?.eventKey
            === current.canonicalRevision.replacesEventKey) {
          delete window.pendingCanonicalReplacements[String(current.ordinal)];
        }
        delete current.lastDeliveryRejectedAt;
        delete current.lastDeliveryResult;
        if (window.slots.length >= FLAP_QUOTE_FIRST_THREE_TARGET
          && window.slots.every((item) => item.deliveryAcceptedAt)) {
          window.trackingCompletedAt ||= iso(now);
        }
        await save();
      });
      return slot.event;
    });
    return delivery.value || slot.event;
  }

  async function processFlapQuoteFirstThreeCandidates(
    observation,
    candidates = [],
    authorizedGenerationKeys = [],
  ) {
    let matches = await withState(() => coarseFlapQuoteFirstThreeMatches(
      state,
      observation,
      candidates,
      authorizedGenerationKeys,
    ));
    if (!matches.length) return [];
    if (!observation.tokenAssessments) {
      const snapshot = await withState(() => structuredClone(state));
      await enrich(observation, snapshot);
    }
    matches = await withState(() => coarseFlapQuoteFirstThreeMatches(
      state,
      observation,
      candidates,
      authorizedGenerationKeys,
    ));
    if (!matches.length) return [];
    if (observation.canonical !== true
      || !/^0x[0-9a-f]{64}$/.test(String(observation.blockHash || "").toLowerCase())
      || !Number.isSafeInteger(Number(observation.confirmations))
      || !Number.isSafeInteger(Number(observation.requiredConfirmations))
      || Number(observation.confirmations) < Number(observation.requiredConfirmations)) {
      const error = new Error(`Flap first-three canonical confirmation proof is incomplete ${observation.transactionHash}`);
      error.code = "BSC_FLAP_FIRST_THREE_PROOF_PENDING";
      throw error;
    }
    const codeBacked = await codeBackedFlapQuoteCandidates(observation, matches);
    const emitted = [];
    for (const match of matches) {
      if (codeBacked.get(String(match.candidate.token).toLowerCase()) !== true) continue;
      const reserved = await reserveFlapQuoteFirstThreeSlot(match, observation);
      if (!reserved) continue;
      const event = await deliverFlapQuoteFirstThreeSlot(match.generationKey, reserved.slot);
      if (event) emitted.push(event);
    }
    return emitted;
  }

  async function flapQuoteFirstThreeConfirmedHead() {
    const requiredConfirmations = Math.max(0, Number(config.bscConfirmations ?? 2));
    let head = Number(currentHead || 0);
    if (typeof provider.getBlockNumber === "function") {
      head = Math.max(head, Number(await provider.getBlockNumber()));
    }
    if (!Number.isSafeInteger(head) || head < requiredConfirmations) {
      throw new Error("BSC head is unavailable for Flap first-three archive replay");
    }
    currentHead = Math.max(currentHead, head);
    return { head, confirmedHead: Math.max(0, head - requiredConfirmations), requiredConfirmations };
  }

  async function readFlapQuoteFirstThreeArchiveLogs(fromBlock, toBlock) {
    const filter = {
      address: FLAP_PORTAL_ADDRESS,
      fromBlock: hexBlock(fromBlock),
      toBlock: hexBlock(toBlock),
      topics: [FLAP_TOKEN_CREATED_TOPIC],
    };
    const logs = typeof provider.send === "function"
      ? await provider.send("eth_getLogs", [filter])
      : await provider.getLogs(filter);
    if (!Array.isArray(logs)) throw new Error(`Flap first-three archive logs missing ${fromBlock}-${toBlock}`);
    const normalized = [];
    for (const log of logs) {
      const transactionHash = normalizeTransactionHash(log?.transactionHash);
      const blockHash = normalizeTransactionHash(log?.blockHash);
      const blockNumber = typeof log?.blockNumber === "number"
        ? log.blockNumber : Number.parseInt(log?.blockNumber, 16);
      const transactionIndex = typeof log?.transactionIndex === "number"
        ? log.transactionIndex : Number.parseInt(log?.transactionIndex, 16);
      const logIndex = typeof (log?.logIndex ?? log?.index) === "number"
        ? (log.logIndex ?? log.index) : Number.parseInt(log?.logIndex ?? log?.index, 16);
      const evidence = parseKnownBscLaunchEvidence([log])[0];
      if (log?.removed === true
        || String(log?.address || "").toLowerCase() !== FLAP_PORTAL_ADDRESS
        || String(log?.topics?.[0] || "").toLowerCase() !== FLAP_TOKEN_CREATED_TOPIC
        || !evidence || String(evidence.token || "").toLowerCase() === ""
        || !/^0x[0-9a-f]{64}$/.test(transactionHash)
        || !/^0x[0-9a-f]{64}$/.test(blockHash)
        || !Number.isSafeInteger(blockNumber) || blockNumber < fromBlock || blockNumber > toBlock
        || !Number.isSafeInteger(transactionIndex) || transactionIndex < 0
        || !Number.isSafeInteger(logIndex) || logIndex < 0) {
        throw new Error(`malformed Flap first-three archive log ${fromBlock}-${toBlock}`);
      }
      normalized.push({
        transactionHash,
        blockHash,
        blockNumber,
        transactionIndex,
        logIndex,
        token: String(evidence.token).toLowerCase(),
      });
    }
    return normalized.sort(compareFlapQuoteTokenCandidates);
  }

  async function runFlapQuoteFirstThreeArchiveReplay(generationKey) {
    await reconcileFlapQuoteFirstThreeCanonicalSlots(generationKey);
    while (true) {
      const phase = await withState(() => {
        const window = state.officialSources?.flap?.quotePoolFirstThree?.windows?.[generationKey];
        if (!window || window.active !== true || window.trackingCompletedAt) return null;
        return {
          nextBlock: Number.isSafeInteger(Number(window.archiveReplayNextBlock))
            ? Number(window.archiveReplayNextBlock) : Number(window.activationBlockNumber),
          window: structuredClone(window),
        };
      });
      if (!phase) return false;
      const head = await flapQuoteFirstThreeConfirmedHead();
      const targetBlock = Math.max(phase.window.activationBlockNumber, head.confirmedHead);
      if (phase.nextBlock > targetBlock) {
        const refreshed = await flapQuoteFirstThreeConfirmedHead();
        const refreshedTarget = Math.max(phase.window.activationBlockNumber, refreshed.confirmedHead);
        if (phase.nextBlock <= refreshedTarget) continue;
        await withState(async () => {
          const window = state.officialSources?.flap?.quotePoolFirstThree?.windows?.[generationKey];
          if (!window || window.active !== true || window.trackingCompletedAt) return;
          window.archiveReplayTargetBlock = Math.max(Number(window.archiveReplayTargetBlock || 0), refreshedTarget);
          window.archiveReplayNextBlock = phase.nextBlock;
          window.replayCompletedAt = iso(now);
          window.replayStatus = "complete";
          await save();
        });
        return true;
      }
      const toBlock = Math.min(targetBlock, phase.nextBlock + recoveryLogBatchSize - 1);
      await withState(async () => {
        const window = state.officialSources?.flap?.quotePoolFirstThree?.windows?.[generationKey];
        if (!window || window.active !== true) return;
        window.archiveReplayNextBlock = phase.nextBlock;
        window.archiveReplayTargetBlock = Math.max(Number(window.archiveReplayTargetBlock || 0), targetBlock);
        window.replayCompletedAt = null;
        window.replayStatus = "running";
        window.replayLastAttemptAt = iso(now);
        window.replayLastError = null;
        await save();
      });
      let logs;
      try {
        logs = await readFlapQuoteFirstThreeArchiveLogs(phase.nextBlock, toBlock);
        const transactions = new Map();
        for (const log of logs) {
          if (!flapQuoteCandidateAfterActivation(log, phase.window)) continue;
          const group = transactions.get(log.transactionHash) || {
            transactionHash: log.transactionHash,
            blockHash: log.blockHash,
            blockNumber: log.blockNumber,
            transactionIndex: log.transactionIndex,
            logIndex: log.logIndex,
            tokens: [],
            candidateKeys: [],
          };
          if (!group.tokens.includes(log.token)) group.tokens.push(log.token);
          group.logIndex = Math.min(group.logIndex, log.logIndex);
          group.candidateKeys.push(flapCreationCandidateKey(log));
          transactions.set(log.transactionHash, group);
        }
        for (const group of [...transactions.values()].sort(compareBscQueueEntries)) {
          let entry;
          await withState(async () => {
            const previousSeen = state.seenTransactions[group.transactionHash];
            const previousPending = state.realtimePendingEntries[group.transactionHash];
            const previousDeferred = state.deferredCreationEvidence[group.transactionHash];
            const previousQueueEntry = queue.has(group.transactionHash)
              ? structuredClone(queue.get(group.transactionHash)) : undefined;
            try {
              delete state.seenTransactions[group.transactionHash];
              enqueue(group.transactionHash, group.blockNumber, "flap_quote_first_three_replay", {
                blockHash: group.blockHash,
                transactionIndex: group.transactionIndex,
                logIndex: group.logIndex,
                mintEmitters: group.tokens,
                candidateTokens: group.tokens,
                verifiedNewContracts: group.tokens,
                flapQuoteFirstThreeReplayGenerationKey: generationKey,
                protocol: true,
              });
              entry = queue.get(group.transactionHash);
              if (!entry) throw new Error(`Flap first-three replay could not reserve ${group.transactionHash}`);
              // Exact replay admission and removal of an obsolete seen owner
              // are one WAL boundary. A restart, or a later WebSocket
              // claimant, must never observe the old durable owner removed
              // while the canonical predecessor exists only in memory.
              persistRealtimePendingHandoff([entry]);
            } catch (error) {
              if (previousSeen === undefined) delete state.seenTransactions[group.transactionHash];
              else state.seenTransactions[group.transactionHash] = previousSeen;
              if (previousPending === undefined) delete state.realtimePendingEntries[group.transactionHash];
              else state.realtimePendingEntries[group.transactionHash] = previousPending;
              if (previousDeferred === undefined) delete state.deferredCreationEvidence[group.transactionHash];
              else state.deferredCreationEvidence[group.transactionHash] = previousDeferred;
              if (previousQueueEntry === undefined) queue.delete(group.transactionHash);
              else queue.set(group.transactionHash, previousQueueEntry);
              throw error;
            }
            await save();
          });
          await processEntries([entry], 1);
          await withState(async () => {
            const window = state.officialSources?.flap?.quotePoolFirstThree?.windows?.[generationKey];
            if (!window) return;
            window.replayAttemptedCandidateKeys = [...new Set([
              ...(window.replayAttemptedCandidateKeys || []),
              ...group.candidateKeys,
            ])].slice(-FLAP_CREATION_HOT_INDEX_MAX);
            await save();
          });
        }
      } catch (error) {
        await withState(async () => {
          const window = state.officialSources?.flap?.quotePoolFirstThree?.windows?.[generationKey];
          if (!window) return;
          window.replayStatus = "error";
          window.replayLastAttemptAt = iso(now);
          window.replayLastError = errorSummary(error);
          await save().catch(() => {});
        });
        throw error;
      }
      await withState(async () => {
        const window = state.officialSources?.flap?.quotePoolFirstThree?.windows?.[generationKey];
        if (!window || window.active !== true) return;
        window.archiveReplayNextBlock = toBlock + 1;
        window.archiveReplayTargetBlock = Math.max(Number(window.archiveReplayTargetBlock || 0), targetBlock);
        window.replayLastAttemptAt = iso(now);
        window.replayLastError = null;
        await save();
      });
    }
  }

  function replayFlapQuoteFirstThreeGeneration(generationKey) {
    if (!generationKey) return Promise.resolve(false);
    if (flapQuoteFirstThreeReplayFlights.has(generationKey)) {
      return flapQuoteFirstThreeReplayFlights.get(generationKey);
    }
    let flight;
    flight = runFlapQuoteFirstThreeArchiveReplay(generationKey).finally(() => {
      if (flapQuoteFirstThreeReplayFlights.get(generationKey) === flight) {
        flapQuoteFirstThreeReplayFlights.delete(generationKey);
      }
    });
    flapQuoteFirstThreeReplayFlights.set(generationKey, flight);
    return flight;
  }

  async function replayPendingFlapQuoteFirstThreeGenerations() {
    await initialize();
    const activeKeys = await withState(() => activeFlapQuoteFirstThreeWindows(state)
      .map(([generationKey]) => generationKey));
    for (const key of activeKeys) await reconcileFlapQuoteFirstThreeCanonicalSlots(key);
    const keys = await withState(() => activeFlapQuoteFirstThreeWindows(state)
      .filter(([, window]) => !window.trackingCompletedAt)
      .map(([generationKey]) => generationKey));
    for (const key of keys) await replayFlapQuoteFirstThreeGeneration(key);
    return keys.length;
  }

  async function registerFlapFeatureActivations(records = [], { awaitReplay = true } = {}) {
    await initialize();
    const pools = records.map(normalizeFlapFeatureRecord).filter(Boolean);
    if (!pools.length) return 0;
    for (const pool of pools) {
      if (pool.type !== "quote_pool" || pool.quoteSymbol) continue;
      if (flapReplayRetryAt > Number(now())) continue;
      let metadata = null;
      try {
        metadata = await readTokenMetadata(provider, pool.quoteAddress, "latest");
      } catch (error) {
        if (sharedRpcRetryDelayMs(error) > 0) {
          const activationKey = flapFeatureActivationKey(pool);
          const replayBackoff = await recordFlapReplayBackoff(activationKey, error);
          if (replayBackoff.shouldLog) logFlapReplayFailure(activationKey, error);
        }
      }
      pool.quoteSymbol = normalizeOfficialText(metadata?.symbol || "").toUpperCase() || null;
      pool.fingerprint = digest({
        identity: pool.identity,
        type: pool.type,
        category: pool.category,
        vaultFactory: pool.vaultFactory,
        quoteAddress: pool.quoteAddress,
        quoteSymbol: pool.quoteSymbol,
        sourceUrl: pool.sourceUrl,
      });
    }
    const registration = await withState(async () => {
      const official = state.officialSources.flap;
      official.pools ||= {};
      official.featureActivations ||= {};
      let createdCount = 0;
      const replayKeys = [];
      for (const pool of pools) {
        official.pools[pool.identity] = pool;
        const key = flapFeatureActivationKey(pool);
        if (!key) continue;
        if (!official.featureActivations[key]) {
          if (pool.type === "vault_factory") {
            for (const activation of Object.values(official.featureActivations)) {
              if (activation.type === "vault_factory" && activation.category === pool.category
                && activation.vaultFactory !== pool.vaultFactory && !activation.firstTokenAlertedAt) {
                activation.active = false;
                activation.deactivatedAt = pool.confirmedAt;
              }
            }
          }
          official.featureActivations[key] = flapActivationRecord(pool);
          backfillNewFeatureCausalBarrier(state, "flap", key, official.featureActivations[key]);
          createdCount += 1;
        }
        const activation = official.featureActivations[key];
        if (activation.active !== false && !activation.replayCompletedAt
          && !activation.firstTokenAlertedAt && !activation.firstTokenTransactionHash) replayKeys.push(key);
      }
      official.initializedAt ||= pools[0].confirmedAt;
      official.lastSuccessAt = pools.at(-1).confirmedAt;
      official.lastError = null;
      await save();
      return { createdCount, replayKeys: [...new Set(replayKeys)] };
    });
    // The activation itself is the durable upstream checkpoint boundary.
    // Historical replay owns a separate persisted cursor and live matching
    // remains closed until replayCompletedAt, so production handoffs can
    // release the Board monitor immediately without losing first-token safety.
    if (awaitReplay) {
      await replayPendingFlapActivations(registration.replayKeys, { throwOnError: true });
    } else if (registration.replayKeys.length) {
      trackBackgroundReplay(() => replayPendingFlapActivations(registration.replayKeys));
    }
    return registration.createdCount;
  }

  async function registerFourMemeFeatureActivations(records = [], { awaitReplay = true } = {}) {
    await initialize();
    const eligibleRecords = records.filter((record) => !record?.changeType || record.changeType === "new_published_quote");
    const observedAt = eligibleRecords.find((record) => record?.observedAt)?.observedAt || iso(now);
    const configs = eligibleRecords.map((record) => record?.quoteConfig || record)
      .filter((config) => config?.symbol && ADDRESS.test(String(config.address || "").toLowerCase()))
      .map((config) => {
        const normalized = {
          ...config,
          symbol: normalizeOfficialText(config.symbol).toUpperCase(),
          address: String(config.address).toLowerCase(),
        };
        normalized.fingerprint ||= digest({
          symbol: normalized.symbol,
          address: normalized.address,
          status: normalized.status || "PUBLISH",
          fees: normalized.fees || {},
          thresholds: normalized.thresholds || {},
        });
        return normalized;
      });
    if (!configs.length) return 0;
    const keys = await withState(async () => {
      const official = state.officialSources.fourMeme;
      official.quoteConfigs ||= {};
      official.featureActivations ||= {};
      const created = [];
      for (const config of configs) {
        official.quoteConfigs[config.symbol] = config;
        const key = fourMemeQuoteActivationKey(config);
        if (key && !official.featureActivations[key]) {
          for (const activation of Object.values(official.featureActivations)) {
            if (activation.type === "quote_config"
              && activation.quoteSymbol === config.symbol
              && activation.quoteAddress !== config.address
              && !activation.firstTokenAlertedAt) {
              activation.active = false;
              activation.deactivatedAt = observedAt;
            }
          }
          official.featureActivations[key] = quoteActivationRecord(config, observedAt, {
            changeType: eligibleRecords.find((record) => String((record.quoteConfig || record).address || "").toLowerCase() === config.address)?.changeType,
            firstObservedAt: eligibleRecords.find((record) => String((record.quoteConfig || record).address || "").toLowerCase() === config.address)?.firstObservedAt || observedAt,
          });
          backfillNewFeatureCausalBarrier(state, "fourmeme", key, official.featureActivations[key]);
          created.push(key);
        }
        const external = state.discoverySources?.external?.contracts?.[config.address];
        if (external && (external.sources || []).every((source) => source.sourceId === "platform-capability:fourmeme"
          && source.sourceUrl === FOUR_MEME_CONFIG_URL)) delete state.discoverySources.external.contracts[config.address];
      }
      await save();
      return created;
    });
    if (awaitReplay) await replayPendingFourMemeActivations(keys);
    else if (keys.length) trackBackgroundReplay(() => replayPendingFourMemeActivations(keys));
    return keys.length;
  }

  async function acceptOfficialQuoteSnapshot(configs, observedAt) {
    const activations = await withState(async () => {
      const official = state.officialSources.fourMeme;
      official.quoteConfigs ||= {};
      official.pendingQuoteConfigs ||= {};
      official.featureActivations ||= {};
      if (official.quoteBaselineInitialized !== true) {
        official.quoteConfigs = Object.fromEntries(configs.map((config) => [config.symbol, config]));
        official.pendingQuoteConfigs = {};
        official.quoteBaselineInitialized = true;
        await save();
        return [];
      }
      const created = [];
      for (const config of configs) {
        const previous = official.quoteConfigs[config.symbol];
        if (previous?.fingerprint === config.fingerprint) {
          official.quoteConfigs[config.symbol] = config;
          delete official.pendingQuoteConfigs[config.symbol];
          continue;
        }
        const pending = official.pendingQuoteConfigs[config.symbol];
        const next = pending?.fingerprint === config.fingerprint
          ? { ...pending, observations: Number(pending.observations || 0) + 1, config }
          : { fingerprint: config.fingerprint, observations: 1, config, firstObservedAt: observedAt };
        official.pendingQuoteConfigs[config.symbol] = next;
        if (next.observations < 2) continue;
        official.quoteConfigs[config.symbol] = config;
        delete official.pendingQuoteConfigs[config.symbol];
        const newQuoteAddress = !previous || previous.address !== config.address;
        const key = newQuoteAddress ? fourMemeQuoteActivationKey(config) : null;
        if (key && !official.featureActivations[key]) {
          for (const activation of Object.values(official.featureActivations)) {
            if (activation.type === "quote_config"
              && activation.quoteSymbol === config.symbol
              && activation.quoteAddress !== config.address
              && !activation.firstTokenAlertedAt) {
              activation.active = false;
              activation.deactivatedAt = observedAt;
            }
          }
          official.featureActivations[key] = quoteActivationRecord(config, observedAt, {
            changeType: previous ? "published_quote_address_changed" : "new_published_quote",
            firstObservedAt: next.firstObservedAt,
          });
          backfillNewFeatureCausalBarrier(state, "fourmeme", key, official.featureActivations[key]);
          created.push(key);
        }
      }
      await save();
      return created;
    });
    await replayPendingFourMemeActivations(activations);
  }

  async function recoverFourMemePlatformActivationHandoffs() {
    const auditFile = path.join(config.dataDir, "platform-capability-events.jsonl");
    let lines;
    try {
      lines = (await fs.readFile(auditFile, "utf8")).split("\n").filter(Boolean);
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
    const parsed = [];
    for (const line of lines.slice(-2_000)) {
      try { parsed.push(JSON.parse(line)); } catch { /* Ignore a torn final audit line. */ }
    }
    const committed = new Set(parsed
      .filter((record) => record?.platform === "fourmeme" && record?.delivery?.status === "checkpoint_committed")
      .map((record) => record.eventKey)
      .filter(Boolean));
    const alreadyProcessed = new Set(state.officialSources?.fourMeme?.platformActivationAuditEvents || []);
    const cutoff = now() - FOUR_MEME_ACTIVATION_AUDIT_MAX_AGE_MS;
    const recordsByEvent = new Map();
    for (const record of parsed) {
      if (record?.platform !== "fourmeme"
        || !record.eventKey
        || !committed.has(record.eventKey)
        || alreadyProcessed.has(record.eventKey)
        || Date.parse(record.observedAt || 0) < cutoff
        || !Array.isArray(record.changes?.newQuoteConfigs)
        || !record.changes.newQuoteConfigs.length) continue;
      recordsByEvent.set(record.eventKey, record);
    }
    if (!recordsByEvent.size) return 0;
    const handoffs = [...recordsByEvent.values()].flatMap((record) => record.changes.newQuoteConfigs.map((quoteConfig) => ({
      quoteConfig,
      changeType: "new_published_quote",
      observedAt: record.observedAt,
      firstObservedAt: record.observedAt,
      sourceUrl: quoteConfig.source?.url || FOUR_MEME_CONFIG_URL,
    })));
    await registerFourMemeFeatureActivations(handoffs);
    await withState(async () => {
      const official = state.officialSources.fourMeme;
      official.platformActivationAuditEvents = [...new Set([
        ...(official.platformActivationAuditEvents || []),
        ...recordsByEvent.keys(),
      ])].slice(-100);
      await save();
    });
    return handoffs.length;
  }

  function fourMemeOfficialFailurePolicy(error, previous = {}) {
    const summary = errorSummary(error);
    const parsedStatus = Number(error?.status)
      || Number(summary.match(/\bHTTP\s+(\d{3})\b/i)?.[1])
      || null;
    const retryAfterMs = Number(error?.retryAfterMs);
    if (parsedStatus === 403) {
      const forbiddenFailures = Number(previous.forbiddenFailures || 0) + 1;
      const delays = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
      return {
        failureKind: "http_403",
        retryDelayMs: delays[Math.min(forbiddenFailures - 1, delays.length - 1)],
        forbiddenFailures,
      };
    }
    if (parsedStatus === 429) {
      return {
        failureKind: "http_429",
        retryDelayMs: Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.ceil(retryAfterMs) : 60_000,
        forbiddenFailures: Number(previous.forbiddenFailures || 0),
      };
    }
    const timeout = /abort|timed?\s*out|timeout|fetch failed|network|socket|temporarily unavailable/i.test(summary)
      || ["ABORT_ERR", "ETIMEDOUT", "TIMEOUT", "NETWORK_ERROR"].includes(error?.code);
    const consecutiveFailures = Number(previous.consecutiveFailures || 0) + 1;
    return {
      failureKind: timeout ? "transport_timeout" : parsedStatus ? `http_${parsedStatus}` : "transport_error",
      retryDelayMs: Math.min(5 * 60_000, 5_000 * (2 ** Math.min(consecutiveFailures - 1, 6))),
      forbiddenFailures: Number(previous.forbiddenFailures || 0),
    };
  }

  function fourMemeSourceCircuitOpen(url, current = Number(now())) {
    const nextRetryAt = Date.parse(state?.officialSources?.fourMeme?.sourceCircuits?.[url]?.nextRetryAt || "");
    return Number.isFinite(nextRetryAt) && nextRetryAt > current;
  }

  async function recordOfficialSourceFailures(failures, observedAt) {
    if (!failures.length) return;
    const failedAt = Date.parse(observedAt);
    const logRecords = [];
    await withState(async () => {
      const official = state.officialSources.fourMeme;
      official.sourceCircuits ||= {};
      for (const { url, error } of failures) {
        const previous = official.sourceCircuits[url] || {};
        const policy = fourMemeOfficialFailurePolicy(error, previous);
        const nextRetryAt = iso(failedAt + policy.retryDelayMs);
        official.sourceCircuits[url] = {
          ...previous,
          url,
          status: "open",
          failureKind: policy.failureKind,
          checkedAt: observedAt,
          lastAttemptAt: observedAt,
          lastErrorAt: observedAt,
          lastError: errorSummary(error),
          consecutiveFailures: Number(previous.consecutiveFailures || 0) + 1,
          forbiddenFailures: policy.forbiddenFailures,
          retryDelayMs: policy.retryDelayMs,
          nextRetryAt,
        };
        logRecords.push({ url, failureKind: policy.failureKind, nextRetryAt, error });
      }
      official.lastErrorAt = observedAt;
      official.lastError = failures.map(({ url, error }) => `${new URL(url).pathname}: ${errorSummary(error)}`).join("; ").slice(0, 600);
      // Count failed poll rounds, not failed URLs. Three simultaneous 403s
      // are one health transition and one durable checkpoint.
      official.consecutiveFailures = Number(official.consecutiveFailures || 0) + 1;
      await save();
    });
    for (const record of logRecords) {
      logger.error(`[bsc][fourmeme-source] ${record.failureKind} ${record.url}; retry=${record.nextRetryAt}: ${errorSummary(record.error)}`);
    }
  }

  async function stageOfficialSourceRecovery(url, observedAt) {
    return withState(() => {
      const official = state.officialSources.fourMeme;
      const previous = official.sourceCircuits?.[url];
      if (!previous || previous.status !== "open") return false;
      official.sourceCircuits[url] = {
        ...previous,
        status: "healthy",
        checkedAt: observedAt,
        lastAttemptAt: observedAt,
        lastSuccessAt: observedAt,
        consecutiveFailures: 0,
        forbiddenFailures: 0,
        retryDelayMs: null,
        nextRetryAt: null,
      };
      delete official.sourceCircuits[url].lastError;
      delete official.sourceCircuits[url].lastErrorAt;
      return true;
    });
  }

  async function recordOfficialFailure(error, observedAt) {
    await withState(async () => {
      const official = state.officialSources.fourMeme;
      official.lastErrorAt = observedAt;
      official.lastError = errorSummary(error);
      official.consecutiveFailures = Number(official.consecutiveFailures || 0) + 1;
      await save();
    });
  }

  async function acceptAgentLaunchDeployer(payload, observedAt) {
    const address = String(payload?.["56"]?.deployerAddress || payload?.deployerAddress || "").toLowerCase();
    if (!ADDRESS.test(address)) throw new Error("Agent Launch official deployer schema missing BSC address");
    const platform = platformForLabel("agentlaunch");
    const phase = await withState(() => {
      const draft = structuredClone(state);
      const official = draft.officialSources.agentLaunch;
      if (!official.deployer) {
        official.deployer = address;
        official.initializedAt = observedAt;
        official.lastSuccessAt = observedAt;
        official.lastError = null;
        state = draft;
        return { savePromise: save(draft), syncAddress: address, event: null };
      }
      if (official.deployer === address) {
        official.pending = null;
        official.lastSuccessAt = observedAt;
        official.lastError = null;
        state = draft;
        return { savePromise: save(draft), syncAddress: address, event: null };
      }
      official.pending = official.pending?.address === address
        ? { ...official.pending, observations: Number(official.pending.observations || 0) + 1 }
        : { address, observations: 1, firstObservedAt: observedAt };
      official.lastSuccessAt = observedAt;
      official.lastError = null;
      state = draft;
      if (official.pending.observations < 2) return { savePromise: save(draft), syncAddress: null, event: null };
      const event = {
        type: "bsc_launchpad_update",
        kind: "new_factory",
        eventKey: `bsc-official-factory:agentlaunch:${address}`,
        chainId: BSC_CHAIN_ID,
        launcher: getAddress(address),
        platform,
        launchCount: 0,
        uniqueTokens: 0,
        tokens: [],
        pools: [],
        mode: { selector: "official-deployer-api", fingerprint: digest({ address }), sourceUrl: platform.evidenceUrl },
        structural: { eligible: true, source: "official_api" },
        attribution: inferBscLaunchpadAttribution({ officialFactory: { platform, address, sourceId: platform.evidenceUrl } }),
        security: null,
        explorerUrl: `https://bscscan.com/address/${address}`,
        launcherUrl: `https://bscscan.com/address/${address}`,
        sourceUrl: platform.evidenceUrl,
        observedAt,
        strong: true,
      };
      return { savePromise: save(draft), syncAddress: null, event };
    });
    await phase.savePromise;
    if (phase.syncAddress) dynamicOfficialRoots.set(phase.syncAddress, platform);
    if (!phase.event) return;
    await deliverOfficialEvent(phase.event, (draft) => {
      const official = draft.officialSources.agentLaunch;
      if (official.pending?.address !== address) return false;
      official.deployer = address;
      official.pending = null;
      dynamicOfficialRoots.set(address, platform);
      return true;
    });
  }

  async function recordAgentLaunchFailure(error, observedAt) {
    await withState(async () => {
      state.officialSources.agentLaunch.lastError = errorSummary(error);
      state.officialSources.agentLaunch.lastErrorAt = observedAt;
      await save();
    });
  }

  function officialWaifuEvent(launch, verifiedTransaction, observedAt) {
    return {
      type: "bsc_launchpad_update",
      kind: "new_mode",
      eventKey: `bsc-official-mode:waifu:${launch.modeFingerprint}`,
      chainId: BSC_CHAIN_ID,
      launcher: getAddress("0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0"),
      platform: { id: "waifufun", name: "waifu.fun × Flap", trust: "official_api_corroborated", website: "https://waifu.fun", twitter: "https://x.com/waifudotfun", evidenceUrl: "https://api.waifu.fun/v2/launches" },
      launchCount: 1,
      uniqueTokens: 1,
      transactionHash: launch.createTxHash,
      blockNumber: verifiedTransaction.blockNumber,
      tokens: [{ token: getAddress(launch.flapTokenAddress), metadata: { name: launch.name, symbol: launch.symbol, twitter: launch.twitter, website: "https://waifu.fun" } }],
      pools: [],
      mode: { selector: "waifu-24h-presale", selectorName: "Flap + 24h presale/vault/agent treasury", componentMode: launch.tier, fingerprint: launch.modeFingerprint },
      structural: { eligible: true, source: "official_api+flap_transaction" },
      attribution: { status: "corroborated", platform: { id: "waifufun", name: "waifu.fun × Flap", website: "https://waifu.fun", twitter: "https://x.com/waifudotfun" }, match: "official_api+flap_create_transaction", evidence: [{ kind: "official_token_record", sourceId: "waifu-official-api", trust: "official_record", address: launch.flapTokenAddress }, { kind: "causal_event", sourceId: "flap-create-transaction", trust: "onchain_causal", address: verifiedTransaction.evidence.emitter }], conflicts: [] },
      security: null,
      explorerUrl: `https://bscscan.com/tx/${launch.createTxHash}`,
      launcherUrl: `https://bscscan.com/address/${launch.token}`,
      sourceUrl: "https://api.waifu.fun/v2/launches",
      blockTimestamp: verifiedTransaction.blockTimestamp,
      observedAt,
      strong: true,
    };
  }

  async function acceptWaifuLaunches(payload, observedAt) {
    const raw = payload?.data?.launches;
    if (payload?.ok !== true || !Array.isArray(raw)) throw new Error("waifu.fun official launch schema invalid");
    const launches = Object.fromEntries(raw.filter((item) => ADDRESS.test(String(item?.tokenAddress || item?.flapTokenAddress || item?.token || "").toLowerCase())).map((item) => {
      // flapTokenAddress is the actual newly-issued Flap token. tokenAddress
      // can be the source/underlying asset in the waifu.fun payload.
      const token = String(item.flapTokenAddress || item.tokenAddress || item.token).toLowerCase();
      return [token, {
        token,
        state: String(item.state || item.status || "unknown").toLowerCase(),
        flapTokenAddress: ADDRESS.test(String(item.flapTokenAddress || "").toLowerCase()) ? String(item.flapTokenAddress).toLowerCase() : null,
        createTxHash: /^0x[0-9a-f]{64}$/i.test(item.createTxHash || "") ? item.createTxHash.toLowerCase() : null,
        name: item.tokenName || item.metadata?.name || null,
        symbol: item.tokenTicker || item.metadata?.symbol || null,
        twitter: item.metadata?.twitter || null,
        tier: item.tierLabel || item.tier || null,
        mechanism: item.launchMode || item.launchType || item.mechanism || null,
        vault: ADDRESS.test(String(item.vaultAddress || item.vault || "").toLowerCase()) ? String(item.vaultAddress || item.vault).toLowerCase() : null,
        observedAt,
      }];
    }));
    for (const launch of Object.values(launches)) launch.modeFingerprint = waifuModeFingerprint(launch);
    const previousSnapshot = await withState(() => structuredClone(state.officialSources.waifu));
    const previousLaunches = previousSnapshot?.launches || {};
    const previouslyAlertedModes = new Set(previousSnapshot?.alertedModeFingerprints || []);
    const launchesNeedingVerification = Object.values(launches).filter((launch) =>
      launch.state === "launched"
      && launch.flapTokenAddress
      && launch.createTxHash
      && previousLaunches[launch.token]?.state !== "launched"
      && !previouslyAlertedModes.has(launch.modeFingerprint));
    const verifiedTransactions = new Map(await Promise.all(launchesNeedingVerification.map(async (launch) => {
      const receipt = await provider.getTransactionReceipt(launch.createTxHash);
      if (!receipt || receipt.status !== 1) return [launch.token, null];
      const evidence = parseKnownBscLaunchEvidence(receipt.logs || []).find((item) =>
        item.token.toLowerCase() === launch.flapTokenAddress
        && platformForAddress(item.emitter)?.id === "flap"
        && [FLAP_TOKEN_CREATED_TOPIC, FLAP_VAULT_TOKEN_CREATED_TOPIC].includes(item.topic));
      const blockNumber = Number(receipt.blockNumber);
      if (!evidence || !Number.isSafeInteger(blockNumber) || blockNumber < 0) return [launch.token, null];
      return [launch.token, {
        evidence,
        blockNumber,
        blockTimestamp: await cachedBlockTimestamp(blockNumber),
      }];
    })));
    const phase = await withState(() => {
      const draft = structuredClone(state);
      const official = draft.officialSources.waifu;
      if (!official.initializedAt) {
        official.launches = launches;
        official.alertedModeFingerprints = [...new Set(Object.values(launches)
          .filter((launch) => launch.state === "launched")
          .map((launch) => launch.modeFingerprint))];
        official.initializedAt = observedAt;
        official.lastSuccessAt = observedAt;
        official.lastError = null;
        state = draft;
        return { savePromise: save(draft), plans: [] };
      }
      const plansByEventKey = new Map();
      for (const [token, launch] of Object.entries(launches)) {
        const previous = official.launches[token];
        const newlyLaunched = launch.state === "launched" && launch.flapTokenAddress && launch.createTxHash && previous?.state !== "launched";
        const modeWasSeen = (official.alertedModeFingerprints || []).includes(launch.modeFingerprint);
        if (newlyLaunched && !modeWasSeen) {
          const verifiedTransaction = verifiedTransactions.get(token);
          if (!verifiedTransaction) {
            // Keep it retryable: a just-mined receipt may not yet be available
            // from every RPC endpoint, and an unverifiable API row must never
            // be permanently accepted as a completed launch.
            official.launches[token] = { ...launch, state: "verification_pending", reportedState: launch.state, verification: "pending_or_invalid" };
            continue;
          }
          const event = officialWaifuEvent(launch, verifiedTransaction, observedAt);
          if (!plansByEventKey.has(event.eventKey)) plansByEventKey.set(event.eventKey, { token, launch, event });
          continue;
        }
        official.launches[token] = launch;
      }
      official.lastSuccessAt = observedAt;
      official.lastError = null;
      state = draft;
      return { savePromise: save(draft), plans: [...plansByEventKey.values()] };
    });
    await phase.savePromise;
    for (const plan of phase.plans) {
      await deliverOfficialEvent(plan.event, (draft) => {
        const official = draft.officialSources.waifu;
        official.alertedModeFingerprints = [...new Set([...(official.alertedModeFingerprints || []), plan.launch.modeFingerprint])].slice(-100);
        official.launches[plan.token] = plan.launch;
        return true;
      });
    }
  }

  async function acceptRugspullCatalog(payload, observedAt) {
    const children = parseOfficialRugspullCatalog(payload);
    await withState(async () => {
      registerOfficialChildren(children.map((child) => ({ ...child, registeredAt: observedAt })));
      state.officialSources.rugspull = {
        ...state.officialSources.rugspull,
        children: Object.fromEntries(children.map((child) => [child.child.toLowerCase(), child])),
        initializedAt: state.officialSources.rugspull.initializedAt || observedAt,
        lastSuccessAt: observedAt,
        lastError: null,
      };
      await save();
    });
  }

  async function acceptSingularryTokens(tokens, observedAt) {
    const current = Object.fromEntries(tokens.map((item) => [item.token, item]));
    const lifecycleKey = "singularry:first_curve_finalized";
    const confirmedGraduations = tokens.filter((item) => item.complete
      && item.pool
      && item.graduatedAt
      && item.currentPhase
      && item.currentPhase.toLowerCase() !== "bonding");
    const phase = await withState(() => {
      const draft = structuredClone(state);
      const official = draft.officialSources.singularry;
      if (!tokens.length && Object.keys(official.tokens || {}).length) {
        throw new Error("Singularry token schema: refused empty replacement snapshot");
      }
      registerSingularryApiCurves(tokens, observedAt, draft, false);
      if (!official.initializedAt) {
        official.tokens = current;
        official.initializedAt = observedAt;
        official.lastSuccessAt = observedAt;
        official.lastError = null;
        if (confirmedGraduations.length && !draft.officialLifecycleEvents[lifecycleKey]) {
          const first = confirmedGraduations[0];
          draft.officialLifecycleEvents[lifecycleKey] = {
            emitter: first.curve,
            token: first.token,
            pool: first.pool,
            source: "singularry_official_api_baseline",
            observedAt,
          };
        }
        state = draft;
        return { savePromise: save(draft), event: null };
      }
      const graduation = confirmedGraduations.find((item) => official.tokens?.[item.token]?.complete !== true);
      if (graduation && !draft.officialLifecycleEvents[lifecycleKey]) {
        const platform = platformForLabel("singularry");
        const event = {
          type: "bsc_launchpad_update",
          kind: "new_mode",
          eventKey: `bsc-official-lifecycle:${lifecycleKey}`,
          chainId: BSC_CHAIN_ID,
          launcher: getAddress(graduation.curve),
          platform,
          launchCount: 1,
          uniqueTokens: 1,
          transactionHash: null,
          tokens: [{ token: getAddress(graduation.token), metadata: { name: graduation.name, symbol: graduation.symbol } }],
          pools: [],
          mode: {
            selector: "official-api-fallback",
            selectorName: "CurveFinalized API fallback",
            componentMode: "首个 Thena V3 毕业",
            lifecycleId: "first_curve_finalized",
            pool: getAddress(graduation.pool),
            graduationDex: graduation.graduationDex,
            graduatedAt: graduation.graduatedAt,
            fingerprint: digest({ lifecycleKey, token: graduation.token, pool: graduation.pool }),
          },
          structural: { eligible: true, source: "official_api_double_confirmation", componentRole: "official_bonding_curve" },
          attribution: {
            status: "verified",
            platform,
            match: "official_factory_curve+official_api_state",
            evidence: [
              { kind: "official_factory_child", sourceId: platform.evidenceUrl, trust: "official_verified", address: graduation.curve },
              { kind: "official_token_record", sourceId: "singularry-token-api", trust: "official_record", address: graduation.token },
            ],
            conflicts: [],
          },
          security: null,
          explorerUrl: `https://bscscan.com/address/${graduation.token}`,
          launcherUrl: `https://bscscan.com/address/${graduation.curve}`,
          sourceUrl: "https://launch.singularry.org/api/tokens?limit=100&chain=bsc&chainId=56",
          observedAt,
          strong: true,
        };
        // Curve ownership is independent discovery evidence and can be
        // persisted now, but the triggering token/lifecycle marker remains
        // untouched until the external notification is confirmed.
        state = draft;
        return { savePromise: save(draft), event, graduation };
      }
      official.tokens = current;
      official.lastSuccessAt = observedAt;
      official.lastError = null;
      state = draft;
      return { savePromise: save(draft), event: null };
    });
    await phase.savePromise;
    for (const item of tokens) {
      const record = state.singularryCurves[item.curve.toLowerCase()];
      if (record) singularryCurveRoots.set(item.curve.toLowerCase(), record);
    }
    if (!phase.event) return;
    await deliverOfficialEvent(phase.event, (draft) => {
      const official = draft.officialSources.singularry;
      registerSingularryApiCurves(tokens, observedAt, draft, false);
      draft.officialLifecycleEvents[lifecycleKey] ||= {
        emitter: phase.graduation.curve,
        token: phase.graduation.token,
        pool: phase.graduation.pool,
        source: "singularry_official_api_double_confirmation",
        observedAt,
      };
      official.tokens = current;
      official.lastSuccessAt = observedAt;
      official.lastError = null;
      return true;
    });
  }

  async function fetchRugspullCatalogPages() {
    const rugs = [];
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const suffix = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const payload = await fetchOfficialJson(`https://rugspull.com/api/rugs?chainId=56&limit=100${suffix}`);
      if (!Array.isArray(payload?.rugs)) throw new Error("Rugspull catalog schema: expected rugs array");
      rugs.push(...payload.rugs);
      const next = nextRugspullCatalogCursor(payload, cursor, 100);
      if (next === null) return { rugs };
      cursor = next;
    }
    throw new Error("Rugspull catalog pagination exceeded 2000 children");
  }

  async function checkOfficialFourMeme() {
    if (officialCheckRunning || stopped) return;
    officialCheckRunning = true;
    const observedAt = iso(now);
    try {
      await initialize();
      await recoverFourMemePlatformActivationHandoffs().catch((error) => {
        logger.error(`[bsc][fourmeme] platform activation handoff: ${errorSummary(error)}`);
      });
      await withState(async () => {
        state.officialSources.fourMeme.lastAttemptAt = observedAt;
      });
      const focusOnly = String(config.monitorScope || "").toLowerCase() === "focus3";
      const fourMemeSources = [
        {
          url: FOUR_MEME_ADDRESS_URL,
          load: () => fetchOfficialJson(FOUR_MEME_ADDRESS_URL).then(parseFourMemeAddressPayload),
          accept: acceptOfficialRootSnapshot,
        },
        {
          url: FOUR_MEME_TEMPLATE_URL,
          load: () => fetchOfficialJson(FOUR_MEME_TEMPLATE_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sort: "LAST" }),
          }).then(parseFourMemeTemplatePayload),
          accept: acceptOfficialTemplateSnapshot,
        },
        {
          url: FOUR_MEME_CONFIG_URL,
          load: () => fetchOfficialJson(FOUR_MEME_CONFIG_URL).then(parseFourMemeQuotePayload),
          accept: acceptOfficialQuoteSnapshot,
        },
      ];
      const fourMemeResultsPromise = Promise.all(fourMemeSources.map(async (source) => {
        if (fourMemeSourceCircuitOpen(source.url)) return { ...source, status: "circuit_open" };
        try {
          return { ...source, status: "fulfilled", value: await source.load() };
        } catch (error) {
          return { ...source, status: "rejected", error };
        }
      }));
      const auxiliaryRequests = focusOnly ? [] : [
        fetchOfficialJson("https://agent-launch.ai/api/deployer-address"),
        fetchOfficialJson("https://api.waifu.fun/v2/launches?limit=20&offset=0"),
        fetchRugspullCatalogPages(),
        fetchOfficialJson("https://launch.singularry.org/api/tokens?limit=100&chain=bsc&chainId=56").then(parseSingularryTokenPayload),
      ];
      const [fourMemeResults, auxiliaryResults] = await Promise.all([
        fourMemeResultsPromise,
        Promise.allSettled(auxiliaryRequests),
      ]);
      for (const result of fourMemeResults) {
        if (result.status !== "fulfilled") continue;
        const recovered = await stageOfficialSourceRecovery(result.url, observedAt);
        await result.accept(result.value, observedAt);
        if (recovered) logger.error(`[bsc][fourmeme-source] recovered ${result.url}`);
      }
      await recordOfficialSourceFailures(
        fourMemeResults.filter((result) => result.status === "rejected")
          .map((result) => ({ url: result.url, error: result.error })),
        observedAt,
      );
      await replayPendingFourMemeActivations();
      if (!focusOnly && auxiliaryResults[0].status === "fulfilled") await acceptAgentLaunchDeployer(auxiliaryResults[0].value, observedAt).catch((error) => recordAgentLaunchFailure(error, observedAt));
      else if (!focusOnly) await recordAgentLaunchFailure(auxiliaryResults[0].reason, observedAt);
      if (!focusOnly && auxiliaryResults[1].status === "fulfilled") await acceptWaifuLaunches(auxiliaryResults[1].value, observedAt).catch(async (error) => {
        await withState(async () => { state.officialSources.waifu.lastError = errorSummary(error); await save(); });
      });
      if (!focusOnly && auxiliaryResults[2].status === "fulfilled") await acceptRugspullCatalog(auxiliaryResults[2].value, observedAt).catch(async (error) => {
        await withState(async () => { state.officialSources.rugspull.lastError = errorSummary(error); await save(); });
      });
      if (!focusOnly && auxiliaryResults[3].status === "fulfilled") await acceptSingularryTokens(auxiliaryResults[3].value, observedAt).catch(async (error) => {
        await withState(async () => {
          state.officialSources.singularry.lastError = errorSummary(error);
          state.officialSources.singularry.lastErrorAt = observedAt;
          await save();
        });
      });
      else if (!focusOnly) await withState(async () => {
        state.officialSources.singularry.lastError = errorSummary(auxiliaryResults[3].reason);
        state.officialSources.singularry.lastErrorAt = observedAt;
        await save();
      });
    } catch (error) {
      logger.error(`[bsc][fourmeme] ${errorSummary(error)}`);
      await recordOfficialFailure(error, observedAt).catch(() => {});
    } finally {
      officialCheckRunning = false;
    }
  }

  async function refreshDappBay() {
    if (discoveryCheckRunning || stopped) return;
    discoveryCheckRunning = true;
    const observedAt = iso(now);
    try {
      await initialize();
      const payload = await fetchOfficialJson("https://dappbay.bnbchain.org/api/v1/dapps?pageSize=2000");
      const records = parseDappBayLaunchpadCatalog(payload);
      await withState(async () => {
        state.discoverySources.dappBay = {
          contracts: Object.fromEntries(records.map((record) => [record.address, record])),
          lastAttemptAt: observedAt,
          lastSuccessAt: observedAt,
          lastError: null,
          count: records.length,
        };
        await save();
      });
    } catch (error) {
      await withState(async () => {
        state.discoverySources.dappBay.lastAttemptAt = observedAt;
        state.discoverySources.dappBay.lastError = errorSummary(error);
        await save();
      }).catch(() => {});
    } finally {
      discoveryCheckRunning = false;
    }
  }

  async function registerDiscoveryCandidates(records = []) {
    await initialize();
    const normalized = records.map((record) => {
      const address = String(record?.address || "").toLowerCase();
      if (!ADDRESS.test(address)) return null;
      const catalogPlatform = platformForLabel(record.platformId || record.platformName || record.platform?.name || record.platform);
      const rawName = normalizeOfficialText(record.platformName || record.platform?.name || record.platform || "BSC launchpad candidate");
      const platform = catalogPlatform || {
        id: normalizeOfficialText(record.platformId || rawName).toLowerCase().replace(/[^a-z0-9]+/g, "") || `candidate-${address.slice(2, 10)}`,
        name: rawName,
      };
      const sourceTrust = record.sourceTrust === "official_verified" ? "official_verified" : "candidate";
      return {
        address,
        platform,
        sourceTrust,
        sourceId: normalizeOfficialText(record.sourceId || "external-discovery").slice(0, 120),
        sourceUrl: /^https:\/\//i.test(record.sourceUrl || "") ? record.sourceUrl : null,
        observedAt: record.observedAt || iso(now),
      };
    }).filter(Boolean);
    if (!normalized.length) return 0;
    const replayPlan = await withState(async () => {
      state.discoverySources.external ||= { contracts: {} };
      state.discoverySources.external.contracts ||= {};
      const replayTargets = new Map();
      const completionAddresses = new Set();
      for (const record of normalized) {
        const previous = state.discoverySources.external.contracts[record.address] || { address: record.address, platform: record.platform, sources: [] };
        const sourceKey = `${record.sourceTrust}:${record.sourceId}:${record.sourceUrl || ""}`;
        const sources = [...(previous.sources || []).filter((source) => `${source.sourceTrust}:${source.sourceId}:${source.sourceUrl || ""}` !== sourceKey), {
          sourceTrust: record.sourceTrust,
          sourceId: record.sourceId,
          sourceUrl: record.sourceUrl,
          observedAt: record.observedAt,
        }].slice(-10);
        state.discoverySources.external.contracts[record.address] = {
          ...previous,
          address: record.address,
          platform: record.platform,
          sources,
          lastSeenAt: record.observedAt,
        };
        const hasOfficialSource = sources.some((source) => source.sourceTrust === "official_verified");
        if (!hasOfficialSource || previous.activationReplayCompletedAt) continue;
        completionAddresses.add(record.address);

        // The official address can appear in GitHub/docs a few seconds after
        // its first transaction. Re-open only the exact stored first-token
        // transaction for a matching launcher or VaultFactory. The original
        // token had already passed historical new-contract verification; the
        // normal enrichment/safety path is run again before any alert.
        for (const [launcherAddress, launcher] of Object.entries(state.launchers || {})) {
          const launcherMatch = launcherAddress.toLowerCase() === record.address;
          for (const mode of Object.values(launcher.modes || {})) {
            const vaultFactoryMatch = String(mode.shape?.vaultFactory || "").toLowerCase() === record.address;
            if (!launcherMatch && !vaultFactoryMatch) continue;
            if (!(mode.structuralTransactions || []).length || !(mode.causalTransactions || []).length) continue;
            const transactionSet = new Set(mode.transactions || []);
            const safeTokenSet = new Set(mode.safeTokens || []);
            const candidates = Object.values(launcher.tokens || {})
              .filter((token) => transactionSet.has(token.transactionHash)
                && (!safeTokenSet.size || safeTokenSet.has(String(token.token || "").toLowerCase())))
              .sort((left, right) => Number(left.firstSeenBlock || left.lastSeenBlock || 0) - Number(right.firstSeenBlock || right.lastSeenBlock || 0));
            const token = candidates[0];
            const transactionHash = normalizeTransactionHash(token?.transactionHash || mode.transactions?.[0]);
            const blockNumber = Number(token?.firstSeenBlock || token?.lastSeenBlock || mode.firstSeenBlock || 0);
            const tokenAddress = String(token?.token || mode.tokens?.[0] || "").toLowerCase();
            if (!/^0x[0-9a-f]{64}$/.test(transactionHash)
              || !Number.isSafeInteger(blockNumber)
              || blockNumber <= 0
              || !ADDRESS.test(tokenAddress)) continue;
            replayTargets.set(transactionHash, { transactionHash, blockNumber, token: tokenAddress });
            delete state.seenTransactions[transactionHash];
          }
        }
      }
      await save();
      return { replayTargets: [...replayTargets.values()], completionAddresses: [...completionAddresses] };
    });

    for (const target of replayPlan.replayTargets) {
      enqueue(target.transactionHash, target.blockNumber, "official_discovery_replay", {
        mintEmitters: [target.token],
        candidateTokens: [target.token],
        verifiedNewContracts: [target.token],
        protocol: true,
      });
    }
    const replayEntries = replayPlan.replayTargets
      .map((target) => queue.get(target.transactionHash))
      .filter(Boolean);
    if (replayEntries.length) await processEntries(replayEntries);
    await withState(async () => {
      const completedAt = iso(now);
      for (const address of replayPlan.completionAddresses) {
        const candidate = state.discoverySources.external.contracts[address];
        if (candidate) candidate.activationReplayCompletedAt = completedAt;
      }
      await save();
    });
    return normalized.length;
  }

  function enqueue(transactionHash, blockNumber, reason, details = {}) {
    const normalizedTransactionHash = normalizeTransactionHash(transactionHash);
    if (!normalizedTransactionHash || state?.seenTransactions?.[normalizedTransactionHash]) return;
    const entry = queue.get(normalizedTransactionHash)
      || (state?.deferredCreationEvidence?.[normalizedTransactionHash]
        ? deserializeDeferredEntry(state.deferredCreationEvidence[normalizedTransactionHash])
        : { transactionHash: normalizedTransactionHash, blockHash: null, blockNumber: Number(blockNumber), transactionIndex: bscQueuePosition(details.transactionIndex), logIndex: bscQueuePosition(details.logIndex), reasons: new Set(), mintEmitters: new Set(), candidateTokens: new Set(), upgradeEmitters: new Set(), lifecycleEmitters: new Set(), hookPools: new Map(), verifiedNewContracts: new Set(), flapCreationHotCandidates: new Map(), fourMemeCreationHotCandidates: new Map(), hasProtocolTrigger: false, deliverySla: null, causalBarrierKeys: [], revision: 0 });
    entry.flapCreationHotCandidates ||= new Map();
    entry.fourMemeCreationHotCandidates ||= new Map();
    let changed = !queue.has(normalizedTransactionHash);
    const incomingBlockNumber = Number(blockNumber);
    const incomingBlockHash = normalizeTransactionHash(details.blockHash
      || details.flapCreationHotCandidates?.[0]?.blockHash
      || details.fourMemeCreationHotCandidates?.[0]?.blockHash);
    const canonicalPositionChanged = Number.isSafeInteger(incomingBlockNumber)
      && ((entry.blockNumber !== undefined && Number(entry.blockNumber) !== incomingBlockNumber)
        || (/^0x[0-9a-f]{64}$/.test(incomingBlockHash)
          && /^0x[0-9a-f]{64}$/.test(String(entry.blockHash || "").toLowerCase())
          && incomingBlockHash !== String(entry.blockHash).toLowerCase()));
    const nextBlockNumber = canonicalPositionChanged
      ? incomingBlockNumber
      : Math.min(entry.blockNumber || incomingBlockNumber, incomingBlockNumber);
    if (nextBlockNumber !== entry.blockNumber) changed = true;
    entry.blockNumber = nextBlockNumber;
    if (/^0x[0-9a-f]{64}$/.test(incomingBlockHash) && entry.blockHash !== incomingBlockHash) {
      entry.blockHash = incomingBlockHash;
      changed = true;
    }
    const nextTransactionIndex = canonicalPositionChanged
      ? bscQueuePosition(details.transactionIndex)
      : Math.min(bscQueuePosition(entry.transactionIndex), bscQueuePosition(details.transactionIndex));
    const nextLogIndex = canonicalPositionChanged
      ? bscQueuePosition(details.logIndex)
      : Math.min(bscQueuePosition(entry.logIndex), bscQueuePosition(details.logIndex));
    if (nextTransactionIndex !== entry.transactionIndex || nextLogIndex !== entry.logIndex) changed = true;
    entry.transactionIndex = nextTransactionIndex;
    entry.logIndex = nextLogIndex;
    const reasonCount = entry.reasons.size;
    entry.reasons.add(reason);
    changed ||= entry.reasons.size !== reasonCount;
    for (const address of details.mintEmitters || []) {
      const before = entry.mintEmitters.size;
      entry.mintEmitters.add(String(address).toLowerCase());
      changed ||= entry.mintEmitters.size !== before;
    }
    for (const address of details.candidateTokens || []) {
      const before = entry.candidateTokens.size;
      entry.candidateTokens.add(String(address).toLowerCase());
      changed ||= entry.candidateTokens.size !== before;
    }
    for (const address of details.verifiedNewContracts || []) {
      const before = entry.verifiedNewContracts.size;
      entry.verifiedNewContracts.add(String(address).toLowerCase());
      changed ||= entry.verifiedNewContracts.size !== before;
    }
    for (const address of details.upgradeEmitters || []) {
      const before = entry.upgradeEmitters.size;
      entry.upgradeEmitters.add(String(address).toLowerCase());
      changed ||= entry.upgradeEmitters.size !== before;
    }
    for (const address of details.lifecycleEmitters || []) {
      const before = entry.lifecycleEmitters.size;
      entry.lifecycleEmitters.add(String(address).toLowerCase());
      changed ||= entry.lifecycleEmitters.size !== before;
    }
    for (const pool of details.hookPools || []) {
      const poolKey = `${pool.factory}:${pool.poolId || pool.pool}`;
      if (!entry.hookPools.has(poolKey)) changed = true;
      entry.hookPools.set(poolKey, pool);
    }
    if (Boolean(details.protocol) && !entry.hasProtocolTrigger) changed = true;
    entry.hasProtocolTrigger ||= Boolean(details.protocol);
    const deliverySla = earliestBscWebsocketDeliverySla(entry.deliverySla, details.deliverySla);
    if (deliverySla && JSON.stringify(deliverySla) !== JSON.stringify(entry.deliverySla || null)) {
      entry.deliverySla = deliverySla;
      changed = true;
    }
    if (details.featureActivationReplayKey
      && entry.featureActivationReplayKey !== details.featureActivationReplayKey) {
      entry.featureActivationReplayKey = details.featureActivationReplayKey;
      changed = true;
    }
    if (details.flapQuoteFirstThreeReplayGenerationKey
      && entry.flapQuoteFirstThreeReplayGenerationKey !== details.flapQuoteFirstThreeReplayGenerationKey) {
      entry.flapQuoteFirstThreeReplayGenerationKey = details.flapQuoteFirstThreeReplayGenerationKey;
      changed = true;
    }
    const causalBarrierKeys = normalizeBscCausalBarrierKeys([
      ...(entry.causalBarrierKeys || []),
      ...(details.causalBarrierKeys || []),
    ]);
    if (JSON.stringify(causalBarrierKeys) !== JSON.stringify(entry.causalBarrierKeys || [])) {
      entry.causalBarrierKeys = causalBarrierKeys;
      changed = true;
    }
    for (const candidate of normalizeFlapCreationHotIndex(details.flapCreationHotCandidates || [], null)) {
      const key = flapCreationCandidateKey(candidate);
      const previous = entry.flapCreationHotCandidates.get(key);
      const merged = normalizeFlapCreationHotIndex(previous ? [previous, candidate] : [candidate], null)[0];
      if (!previous || JSON.stringify(previous) !== JSON.stringify(merged)) {
        entry.flapCreationHotCandidates.set(key, merged);
        changed = true;
      }
    }
    for (const candidate of normalizeFourMemeCreationHotIndex(details.fourMemeCreationHotCandidates || [], null)) {
      const key = fourMemeCreationCandidateKey(candidate);
      const previous = entry.fourMemeCreationHotCandidates.get(key);
      const merged = normalizeFourMemeCreationHotIndex(previous ? [previous, candidate] : [candidate], null)[0];
      if (!previous || JSON.stringify(previous) !== JSON.stringify(merged)) {
        entry.fourMemeCreationHotCandidates.set(key, merged);
        changed = true;
      }
    }
    if (changed) entry.revision = Number(entry.revision || 0) + 1;
    queue.set(normalizedTransactionHash, entry);
  }

  function deferredRetryDelay(attempts) {
    return Math.min(300_000, 15_000 * (2 ** Math.min(Math.max(0, Number(attempts || 1) - 1), 5)));
  }

  function mergeCurrentDurableEntry(entry, ...records) {
    let mergedDurable = false;
    for (const record of records.filter(Boolean)) {
      mergedDurable = true;
      // The entry is the current canonical handoff/retry proof. Never carry an
      // older fork's position forward merely because its numeric block/index
      // sorts first; only monotonic evidence fields are merged below.
      for (const [field, kind] of [
        ["reasons", "set"], ["mintEmitters", "set"], ["candidateTokens", "set"],
        ["verifiedNewContracts", "set"], ["upgradeEmitters", "set"], ["lifecycleEmitters", "set"],
      ]) {
        entry[field] ||= new Set();
        for (const value of record[field] || []) entry[field].add(value);
      }
      entry.hookPools ||= new Map();
      for (const pool of record.hookPools || []) {
        entry.hookPools.set(`${pool.factory}:${pool.poolId || pool.pool}`, pool);
      }
      entry.hasProtocolTrigger ||= Boolean(record.hasProtocolTrigger);
      entry.deliverySla = earliestBscWebsocketDeliverySla(entry.deliverySla, record.deliverySla);
      for (const field of ["featureActivationReplayKey", "flapQuoteFirstThreeReplayGenerationKey"]) {
        if (entry[field] && record[field] && entry[field] !== record[field]) {
          throw new Error(`${field} changed for ${entry.transactionHash}`);
        }
        entry[field] ||= record[field] || null;
      }
      entry.causalBarrierKeys = normalizeBscCausalBarrierKeys([
        ...(entry.causalBarrierKeys || []),
        ...(record.causalBarrierKeys || []),
      ]);
      entry.flapCreationHotCandidates ||= new Map();
      for (const candidate of record.flapCreationHotCandidates || []) {
        const key = flapCreationCandidateKey(candidate);
        const previous = entry.flapCreationHotCandidates.get(key);
        entry.flapCreationHotCandidates.set(
          key,
          normalizeFlapCreationHotIndex(previous ? [candidate, previous] : [candidate], null)[0],
        );
      }
      entry.fourMemeCreationHotCandidates ||= new Map();
      for (const candidate of record.fourMemeCreationHotCandidates || []) {
        const key = fourMemeCreationCandidateKey(candidate);
        const previous = entry.fourMemeCreationHotCandidates.get(key);
        entry.fourMemeCreationHotCandidates.set(
          key,
          normalizeFourMemeCreationHotIndex(previous ? [candidate, previous] : [candidate], null)[0],
        );
      }
      entry.revision = Math.max(Number(entry.revision || 0), Number(record.revision || 0));
    }
    if (mergedDurable) entry.revision = Number(entry.revision || 0) + 1;
    return entry;
  }

  function serializeRealtimePendingEntry(entry, previous = {}) {
    const observedAt = iso(now);
    const deliverySla = earliestBscWebsocketDeliverySla(entry.deliverySla, previous.deliverySla);
    const flapCreationHotCandidates = normalizeBscTransactionCreationEvidence([
      ...(previous.flapCreationHotCandidates || []),
      ...(entry.flapCreationHotCandidates?.values?.() || []),
    ], entry.transactionHash, "Flap", normalizeFlapCreationHotIndex);
    const fourMemeCreationHotCandidates = normalizeBscTransactionCreationEvidence([
      ...(previous.fourMemeCreationHotCandidates || []),
      ...(entry.fourMemeCreationHotCandidates?.values?.() || []),
    ], entry.transactionHash, "Four.Meme", normalizeFourMemeCreationHotIndex);
    return {
      transactionHash: normalizeTransactionHash(entry.transactionHash),
      blockHash: /^0x[0-9a-f]{64}$/.test(String(entry.blockHash || "").toLowerCase())
        ? String(entry.blockHash).toLowerCase() : null,
      blockNumber: Number(entry.blockNumber),
      transactionIndex: bscQueuePosition(entry.transactionIndex),
      logIndex: bscQueuePosition(entry.logIndex),
      reasons: [...(entry.reasons || [])],
      mintEmitters: [...(entry.mintEmitters || [])],
      candidateTokens: [...(entry.candidateTokens || [])],
      verifiedNewContracts: [...(entry.verifiedNewContracts || [])],
      upgradeEmitters: [...(entry.upgradeEmitters || [])],
      lifecycleEmitters: [...(entry.lifecycleEmitters || [])],
      hookPools: [...(entry.hookPools?.values?.() || [])],
      hasProtocolTrigger: Boolean(entry.hasProtocolTrigger),
      ...(deliverySla ? { deliverySla } : {}),
      featureActivationReplayKey: entry.featureActivationReplayKey || null,
      flapQuoteFirstThreeReplayGenerationKey: entry.flapQuoteFirstThreeReplayGenerationKey || null,
      causalBarrierKeys: normalizeBscCausalBarrierKeys(entry.causalBarrierKeys),
      flapCreationHotCandidates,
      fourMemeCreationHotCandidates,
      revision: Number(entry.revision || 0),
      queuedAt: previous.queuedAt || observedAt,
      updatedAt: observedAt,
    };
  }

  function mergeDeferredRecordWithoutAttempt(entry, previous) {
    const common = serializeRealtimePendingEntry(entry, previous);
    return {
      ...previous,
      ...common,
      deferredKind: previous.deferredKind || entry.deferredKind || "creation_evidence",
      attempts: previous.attempts,
      firstDeferredAt: previous.firstDeferredAt,
      lastAttemptAt: previous.lastAttemptAt,
      nextAttemptAt: previous.nextAttemptAt,
      lastError: previous.lastError,
    };
  }

  function persistRealtimePendingHandoff(entries) {
    const candidates = entries.filter((entry) => !state.seenTransactions[entry.transactionHash]);
    const newKeys = new Set(candidates
      .map((entry) => normalizeTransactionHash(entry.transactionHash))
      .filter((transactionHash) => transactionHash
        && !state.realtimePendingEntries[transactionHash]
        && !state.deferredCreationEvidence[transactionHash]));
    const pendingCount = Object.keys(state.realtimePendingEntries || {}).length;
    if (pendingCount + newKeys.size > realtimePendingMaxEntries) {
      const error = new Error(`BSC realtime pending capacity ${pendingCount}+${newKeys.size}>${realtimePendingMaxEntries}`);
      error.code = "BSC_REALTIME_PENDING_CAPACITY";
      error.pendingEntryCount = pendingCount;
      error.newEntryCount = newKeys.size;
      error.pendingEntryCapacity = realtimePendingMaxEntries;
      error.rangeExceedsCapacity = newKeys.size > realtimePendingMaxEntries;
      throw error;
    }
    // Capacity is checked for the complete recovered range before mutating a
    // single record. Cursor advancement and every candidate are therefore an
    // all-or-none state/WAL transaction.
    for (const entry of candidates) {
      const pending = state.realtimePendingEntries[entry.transactionHash];
      const deferred = state.deferredCreationEvidence[entry.transactionHash];
      mergeCurrentDurableEntry(entry, pending, deferred);
      if (deferred) {
        state.deferredCreationEvidence[entry.transactionHash] = mergeDeferredRecordWithoutAttempt(entry, deferred);
      } else {
        state.realtimePendingEntries[entry.transactionHash] = serializeRealtimePendingEntry(entry, pending);
      }
    }
  }

  function deserializeRealtimePendingEntry(record) {
    const hookPools = new Map();
    for (const pool of record.hookPools || []) hookPools.set(`${pool.factory}:${pool.poolId || pool.pool}`, pool);
    return {
      transactionHash: normalizeTransactionHash(record.transactionHash),
      blockHash: /^0x[0-9a-f]{64}$/.test(String(record.blockHash || "").toLowerCase())
        ? String(record.blockHash).toLowerCase() : null,
      blockNumber: Number(record.blockNumber),
      transactionIndex: bscQueuePosition(record.transactionIndex),
      logIndex: bscQueuePosition(record.logIndex),
      reasons: new Set(record.reasons || []),
      mintEmitters: new Set(record.mintEmitters || []),
      candidateTokens: new Set(record.candidateTokens || []),
      verifiedNewContracts: new Set(record.verifiedNewContracts || []),
      upgradeEmitters: new Set(record.upgradeEmitters || []),
      lifecycleEmitters: new Set(record.lifecycleEmitters || []),
      hookPools,
      hasProtocolTrigger: Boolean(record.hasProtocolTrigger),
      deliverySla: normalizeBscWebsocketDeliverySla(record.deliverySla),
      featureActivationReplayKey: record.featureActivationReplayKey || null,
      flapQuoteFirstThreeReplayGenerationKey: record.flapQuoteFirstThreeReplayGenerationKey || null,
      causalBarrierKeys: normalizeBscCausalBarrierKeys(record.causalBarrierKeys),
      flapCreationHotCandidates: new Map(readBscTransactionCreationEvidence(
        record.flapCreationHotCandidates,
        record.transactionHash,
        `pending ${record.transactionHash} Flap`,
        normalizeFlapCreationHotIndex,
      ).map((candidate) => [flapCreationCandidateKey(candidate), candidate])),
      fourMemeCreationHotCandidates: new Map(readBscTransactionCreationEvidence(
        record.fourMemeCreationHotCandidates,
        record.transactionHash,
        `pending ${record.transactionHash} Four.Meme`,
        normalizeFourMemeCreationHotIndex,
      ).map((candidate) => [fourMemeCreationCandidateKey(candidate), candidate])),
      revision: Number(record.revision || 0),
    };
  }

  function serializeDeferredEntry(entry, error, previous = {}) {
    const attempts = Number(previous.attempts || 0) + 1;
    const observedAt = iso(now);
    const deliverySla = earliestBscWebsocketDeliverySla(entry.deliverySla, previous.deliverySla);
    const flapCreationHotCandidates = normalizeBscTransactionCreationEvidence([
      ...(previous.flapCreationHotCandidates || []),
      ...(entry.flapCreationHotCandidates?.values?.() || []),
    ], entry.transactionHash, "Flap", normalizeFlapCreationHotIndex);
    const fourMemeCreationHotCandidates = normalizeBscTransactionCreationEvidence([
      ...(previous.fourMemeCreationHotCandidates || []),
      ...(entry.fourMemeCreationHotCandidates?.values?.() || []),
    ], entry.transactionHash, "Four.Meme", normalizeFourMemeCreationHotIndex);
    return {
      transactionHash: normalizeTransactionHash(entry.transactionHash),
      blockHash: /^0x[0-9a-f]{64}$/.test(String(entry.blockHash || "").toLowerCase())
        ? String(entry.blockHash).toLowerCase() : null,
      blockNumber: Number(entry.blockNumber),
      transactionIndex: bscQueuePosition(entry.transactionIndex),
      logIndex: bscQueuePosition(entry.logIndex),
      reasons: [...(entry.reasons || [])],
      mintEmitters: [...(entry.mintEmitters || [])],
      candidateTokens: [...(entry.candidateTokens || [])],
      verifiedNewContracts: [...(entry.verifiedNewContracts || [])],
      upgradeEmitters: [...(entry.upgradeEmitters || [])],
      lifecycleEmitters: [...(entry.lifecycleEmitters || [])],
      hookPools: [...(entry.hookPools?.values?.() || [])],
      hasProtocolTrigger: Boolean(entry.hasProtocolTrigger),
      ...(deliverySla ? { deliverySla } : {}),
      featureActivationReplayKey: entry.featureActivationReplayKey || null,
      flapQuoteFirstThreeReplayGenerationKey: entry.flapQuoteFirstThreeReplayGenerationKey || null,
      causalBarrierKeys: normalizeBscCausalBarrierKeys(entry.causalBarrierKeys),
      flapCreationHotCandidates,
      fourMemeCreationHotCandidates,
      revision: Number(entry.revision || 0),
      deferredKind: previous.deferredKind || entry.deferredKind || "creation_evidence",
      attempts,
      firstDeferredAt: previous.firstDeferredAt || observedAt,
      lastAttemptAt: observedAt,
      nextAttemptAt: new Date(now() + deferredRetryDelay(attempts)).toISOString(),
      lastError: errorSummary(error),
    };
  }

  function deserializeDeferredEntry(record) {
    const hookPools = new Map();
    for (const pool of record.hookPools || []) hookPools.set(`${pool.factory}:${pool.poolId || pool.pool}`, pool);
    return {
      transactionHash: normalizeTransactionHash(record.transactionHash),
      blockHash: /^0x[0-9a-f]{64}$/.test(String(record.blockHash || "").toLowerCase())
        ? String(record.blockHash).toLowerCase() : null,
      blockNumber: Number(record.blockNumber),
      transactionIndex: bscQueuePosition(record.transactionIndex),
      logIndex: bscQueuePosition(record.logIndex),
      reasons: new Set(record.reasons || []),
      mintEmitters: new Set(record.mintEmitters || []),
      candidateTokens: new Set(record.candidateTokens || []),
      verifiedNewContracts: new Set(record.verifiedNewContracts || []),
      upgradeEmitters: new Set(record.upgradeEmitters || []),
      lifecycleEmitters: new Set(record.lifecycleEmitters || []),
      hookPools,
      hasProtocolTrigger: Boolean(record.hasProtocolTrigger),
      deliverySla: normalizeBscWebsocketDeliverySla(record.deliverySla),
      featureActivationReplayKey: record.featureActivationReplayKey || null,
      flapQuoteFirstThreeReplayGenerationKey: record.flapQuoteFirstThreeReplayGenerationKey || null,
      causalBarrierKeys: normalizeBscCausalBarrierKeys(record.causalBarrierKeys),
      flapCreationHotCandidates: new Map(readBscTransactionCreationEvidence(
        record.flapCreationHotCandidates,
        record.transactionHash,
        `deferred ${record.transactionHash} Flap`,
        normalizeFlapCreationHotIndex,
      ).map((candidate) => [flapCreationCandidateKey(candidate), candidate])),
      fourMemeCreationHotCandidates: new Map(readBscTransactionCreationEvidence(
        record.fourMemeCreationHotCandidates,
        record.transactionHash,
        `deferred ${record.transactionHash} Four.Meme`,
        normalizeFourMemeCreationHotIndex,
      ).map((candidate) => [fourMemeCreationCandidateKey(candidate), candidate])),
      revision: Number(record.revision || 0),
      deferredKind: record.deferredKind || "creation_evidence",
      deferredEvidence: true,
    };
  }

  async function deferCreationEvidence(entry, error) {
    await withState(async () => {
      const previous = state.deferredCreationEvidence[entry.transactionHash] || {};
      mergeCurrentDurableEntry(
        entry,
        state.realtimePendingEntries[entry.transactionHash],
        state.deferredCreationEvidence[entry.transactionHash],
      );
      state.deferredCreationEvidence[entry.transactionHash] = {
        ...serializeDeferredEntry(entry, error, previous),
        deferredKind: "creation_evidence",
      };
      delete state.realtimePendingEntries[entry.transactionHash];
      state._health.creationEvidence = {
        status: "deferred",
        checkedAt: iso(now),
        pending: Object.keys(state.deferredCreationEvidence).length,
        lastError: errorSummary(error),
      };
      updateCoverageHealth();
      await save();
    });
    for (const address of [...(entry.mintEmitters || []), ...(entry.candidateTokens || [])]) {
      creationTransactionCache.delete(String(address).toLowerCase());
    }
  }

  function catalogController(transaction, receipt, candidateTokens = [], pools = []) {
    const tokenAddresses = candidateTokens.map((token) => typeof token === "string" ? token : token.token).filter(Boolean);
    const excluded = [
      ...BSC_EXCLUDED_CONTROLLERS,
      ...pools.flatMap((pool) => [pool.pool, pool.factory]).filter(Boolean).map((address) => String(address).toLowerCase()),
    ];
    const correlated = findTokenCorrelatedEmitters(receipt.logs || [], tokenAddresses, excluded);
    const correlatedEmitters = new Set(correlated.map((item) => item.emitter.toLowerCase()));
    const knownEvidence = parseKnownBscLaunchEvidence(receipt.logs || [])
      .filter((item) => tokenAddresses.some((token) => token.toLowerCase() === item.token.toLowerCase()));
    const exactKnownEmitters = new Set(knownEvidence.map((item) => item.emitter.toLowerCase()));
    for (const item of knownEvidence) correlatedEmitters.add(item.emitter.toLowerCase());

    const direct = platformForAddress(transaction.to);
    if (direct) {
      const selectorCausal = direct.id === "flazepad" && transaction.data?.slice(0, 10).toLowerCase() === "0xf7212153";
      // A future Flap create function may ship before its new event ABI is in
      // this process. The zero-mint lane independently proves that a new token
      // contract was created in this direct official-Portal transaction; use
      // its calldata selector as the causal creation evidence instead of
      // waiting for a second token or silently dropping the first one.
      const flapDirectCreateCandidate = direct.id === "flap"
        && tokenAddresses.length > 0
        && /^0x[0-9a-f]{8}/i.test(transaction.data || "");
      return {
        address: getAddress(transaction.to),
        platform: publicPlatform(direct),
        kind: selectorCausal
          ? "official_create_selector"
          : flapDirectCreateCandidate && !exactKnownEmitters.has(transaction.to.toLowerCase())
            ? "official_flap_create_candidate"
            : "official_direct",
        causalTokenEvent: exactKnownEmitters.has(transaction.to.toLowerCase()) || selectorCausal || flapDirectCreateCandidate,
        correlated,
        launchEvidence: knownEvidence,
      };
    }
    const dynamic = dynamicOfficialRoots.get(transaction.to?.toLowerCase());
    if (dynamic) return { address: getAddress(transaction.to), platform: dynamic, kind: "official_direct", causalTokenEvent: exactKnownEmitters.has(transaction.to.toLowerCase()), correlated, launchEvidence: knownEvidence };

    for (const platform of BSC_LAUNCHPAD_CATALOG.filter((entry) => entry.trust === "official_verified")) {
      const launcher = platform.launchers.find((address) => exactKnownEmitters.has(address));
      if (launcher) {
        const shared = BSC_SHARED_LAUNCH_ROOTS.get(launcher);
        return { address: getAddress(launcher), platform: publicPlatform(shared || platform), kind: shared ? "official_shared_event_emitter" : "official_event_emitter", causalTokenEvent: true, correlated, launchEvidence: knownEvidence };
      }
    }
    for (const [launcher, platform] of dynamicOfficialRoots) {
      if (exactKnownEmitters.has(launcher)) return { address: getAddress(launcher), platform, kind: "official_event_emitter", causalTokenEvent: true, correlated, launchEvidence: knownEvidence };
    }
    for (const emitter of exactKnownEmitters) {
      const child = officialChildRoots.get(emitter);
      if (child) return { address: child.factory, platform: child.platform, kind: "official_child_event_emitter", causalTokenEvent: true, correlated, launchEvidence: knownEvidence, childController: child.child };
    }
    const unknownEmitters = [...correlatedEmitters].filter((address) => !BSC_EXCLUDED_CONTROLLERS.has(address));
    if (unknownEmitters.length === 1) return { address: getAddress(unknownEmitters[0]), platform: null, kind: "token_event_emitter", causalTokenEvent: true, correlated, launchEvidence: knownEvidence };
    if (unknownEmitters.length > 1) return null;
    return transaction.to ? { address: getAddress(transaction.to), platform: null, kind: "root_fallback", causalTokenEvent: false, correlated: [], launchEvidence: knownEvidence } : null;
  }

  function officialCreationEvidenceTokens(logs = []) {
    return [...new Set(parseKnownBscLaunchEvidence(logs)
      .filter((item) => {
        const emitter = item.emitter.toLowerCase();
        const catalogPlatform = platformForAddress(emitter);
        return BSC_EXACT_TOKEN_CREATION_TOPICS.has(item.topic)
          && Boolean(isKnownLaunchRootPlatform(catalogPlatform)
            || isKnownLaunchRootPlatform(dynamicOfficialRoots.get(emitter))
            || officialChildRoots.has(emitter));
      })
      .map((item) => item.token.toLowerCase()))];
  }

  function isNearHeadProfileBlock(blockNumber) {
    const confirmedFromHead = Math.max(0, Number(currentHead || 0) - (config.bscConfirmations ?? 2));
    const confirmedFromTail = Math.max(0, Number(state?.realtimeTailNextBlock || 0) - 1);
    const confirmedReference = Math.max(confirmedFromHead, confirmedFromTail);
    if (!Number.isSafeInteger(Number(blockNumber)) || confirmedReference <= 0) return false;
    const nearHeadFrom = Math.max(0, confirmedReference - realtimeTailLookbackBlocks + 1);
    return Number(blockNumber) >= nearHeadFrom && Number(blockNumber) <= confirmedReference;
  }

  function exactOfficialCausalProfileEligible(controller, token, descriptor) {
    const allowedTopics = knownOfficialFastTopics(controller?.platform?.id);
    const tokenAddress = String(token || "").toLowerCase();
    return Boolean(allowedTopics
      && /^official_/.test(controller?.kind || "")
      && controller?.causalTokenEvent
      && ADDRESS.test(tokenAddress)
      && descriptor?.argumentEvidence
      && descriptor.creationTopics?.length
      && descriptor.creationTopics.every((topic) => allowedTopics.has(topic))
      && sameOrderedStrings(descriptor.exactCreationTokens, [tokenAddress]));
  }

  async function runtimeProfile(address, blockNumber = null, { preferLatestState = false } = {}) {
    const requestedBlockTag = Number.isFinite(Number(blockNumber)) ? Number(blockNumber) : null;
    const latestPreferred = preferLatestState && requestedBlockTag !== null;
    const key = `${address.toLowerCase()}:${latestPreferred ? "latest-preferred" : requestedBlockTag ?? "latest"}`;
    const cached = profileCache.get(key);
    if (cached && cached.expiresAt > now()) return cached.profile;
    const load = async (blockTag, approximate = false) => {
      const readStorage = (slot) => provider.getStorage
        ? provider.getStorage(address, slot, blockTag ?? undefined).catch(() => "0x")
        : Promise.resolve("0x");
      const [proxyCode, implementationStorage, beaconStorage] = await Promise.all([
        provider.getCode(address, blockTag ?? undefined),
        readStorage(EIP1967_IMPLEMENTATION_SLOT),
        readStorage(EIP1967_BEACON_SLOT),
      ]);
      const lowerCode = String(proxyCode || "0x").toLowerCase().replace(/^0x/, "");
      const cloneMatch = lowerCode.match(/363d3d373d3d3d363d73([0-9a-f]{40})5af43d/);
      const directImplementation = addressFromStorage(implementationStorage);
      const cloneImplementation = cloneMatch ? getAddress(`0x${cloneMatch[1]}`) : null;
      const beacon = addressFromStorage(beaconStorage);
      let beaconImplementation = null;
      if (!directImplementation && !cloneImplementation && beacon && provider.call) {
        try {
          const result = await provider.call({ to: beacon, data: BEACON_IMPLEMENTATION_SELECTOR, ...(blockTag !== null ? { blockTag } : {}) });
          beaconImplementation = addressFromStorage(result);
        } catch {
          beaconImplementation = null;
        }
      }
      let implementation = directImplementation || cloneImplementation || beaconImplementation;
      let effectiveCode = implementation ? await provider.getCode(implementation, blockTag ?? undefined) : proxyCode;
      if (implementation && (!effectiveCode || effectiveCode === "0x")) {
        implementation = null;
        effectiveCode = proxyCode;
      }
      const features = bytecodeFeatures(effectiveCode, BSC_INFRA_MARKERS);
      return {
        implementation,
        beacon,
        proxyType: directImplementation ? "eip1967" : cloneImplementation ? "eip1167" : beaconImplementation ? "beacon" : null,
        proxyCodeHash: proxyCode && proxyCode !== "0x" ? keccak256(proxyCode) : null,
        effectiveCodeHash: effectiveCode && effectiveCode !== "0x" ? keccak256(effectiveCode) : null,
        codeHash: effectiveCode && effectiveCode !== "0x" ? keccak256(effectiveCode) : null,
        codeSize: Math.max(0, (effectiveCode.length - 2) / 2),
        blockTag: blockTag ?? "latest",
        approximate,
        ...features,
      };
    };
    let profile;
    if (latestPreferred) {
      try {
        profile = await load(null, true);
      } catch (error) {
        if (!isBscArchiveStateUnavailable(error) && !isTransientCoverageError(error)) throw error;
        profile = await load(requestedBlockTag, false);
      }
    } else {
      try {
        profile = await load(requestedBlockTag, false);
      } catch (error) {
        if (requestedBlockTag === null || !isBscArchiveStateUnavailable(error)) throw error;
        profile = await load(null, true);
      }
    }
    profileCache.set(key, { profile, expiresAt: now() + RUNTIME_PROFILE_TTL_MS });
    if (profileCache.size > 512) profileCache.delete(profileCache.keys().next().value);
    return profile;
  }

  function invalidateRuntimeIdentity(address) {
    const normalized = String(address || "").toLowerCase();
    if (!ADDRESS.test(normalized)) return;
    officialControllerIdentityCache.delete(normalized);
    for (const key of profileCache.keys()) {
      if (key.startsWith(`${normalized}:`)) profileCache.delete(key);
    }
  }

  async function observeVerifiedHook(pool, transactionHash, blockNumber, context = {}) {
    const hookAddress = pool?.hook?.toLowerCase();
    if (!pool?.verifiedDex || !hookAddress || hookAddress === "0x0000000000000000000000000000000000000000" || BSC_EXCLUDED_CONTROLLERS.has(hookAddress)) return null;
    const candidates = [...new Set([pool.token0, pool.token1].map((address) => address.toLowerCase()).filter((address) => !BSC_QUOTE_ASSETS.has(address)))];
    const previousBlock = Math.max(0, Number(blockNumber) - 1);
    const verifiedNewContracts = new Set(context.verifiedNewContracts || []);
    const codeChecks = await Promise.all(candidates.map(async (token) => ({
      token,
      isNewContract: verifiedNewContracts.has(token) || (await provider.getCode(token, previousBlock)) === "0x",
    })));
    const newTokens = codeChecks.filter((item) => item.isNewContract).map((item) => item.token);
    for (const item of codeChecks) if (!item.isNewContract) existingMintEmitters.add(item.token);
    if (!newTokens.length) return null;

    const [transaction, receipt] = context.transaction && context.receipt
      ? [context.transaction, context.receipt]
      : await Promise.all([
        provider.getTransaction(transactionHash),
        provider.getTransactionReceipt(transactionHash),
      ]);
    if (!transaction || !receipt) throw new Error(`missing finalized hook transaction or receipt ${transactionHash}`);
    if (receipt.status !== 1 || !transaction.to) return null;
    const controllerAddress = transaction.to.toLowerCase();
    if (BSC_EXCLUDED_CONTROLLERS.has(controllerAddress) || BSC_DEX_CONTRACTS.has(controllerAddress)) return null;
    const receiptMintTokens = new Set((receipt.logs || []).filter(isErc20MintLog).map((log) => String(log.address).toLowerCase()));
    for (const token of parseKnownBscLaunchTokens(receipt.logs || [])) receiptMintTokens.add(token.toLowerCase());
    const correlatedTokens = newTokens.filter((token) => receiptMintTokens.has(token));
    if (!correlatedTokens.length) return null;

    const [hookProfile, controllerProfile] = await Promise.all([
      runtimeProfile(hookAddress, blockNumber),
      runtimeProfile(controllerAddress, blockNumber),
    ]);
    if (!hookProfile.codeHash || hookProfile.codeSize < 500 || hookProfile.selectors.length < 2) return null;
    if (!controllerProfile.codeHash || controllerProfile.codeSize < 1_000 || (!controllerProfile.usesCreate && !controllerProfile.usesCreate2)) return null;
    const securityAssessments = await Promise.all(correlatedTokens.map(async (token) => ({
      token,
      security: await assessLocalTokenSecurity(provider, token, [pool]),
    })));
    const safeTokens = securityAssessments.filter((item) => infrastructureSafetyPassed(item.security)).map((item) => item.token);
    const caller = ADDRESS.test(String(transaction.from || "").toLowerCase()) ? String(transaction.from).toLowerCase() : null;
    const blockTimestamp = await cachedBlockTimestamp(blockNumber);

    const applyObservation = (draft) => {
      const key = hookAddress;
      draft.hooks[key] ||= {
        hook: getAddress(hookAddress),
        firstSeenBlock: Number(blockNumber),
        lastSeenBlock: Number(blockNumber),
        transactions: [],
        poolIds: [],
        poolKinds: [],
        newTokens: [],
        controllers: {},
      };
      const hook = draft.hooks[key];
      hook.controllers ||= {};
      hook.lastSeenBlock = Math.max(Number(hook.lastSeenBlock || 0), Number(blockNumber));
      if (!hook.transactions.includes(transactionHash)) hook.transactions = [...hook.transactions, transactionHash].slice(-30);
      const poolId = String(pool.poolId || pool.pool || `${pool.factory}:${pool.token0}:${pool.token1}`).toLowerCase();
      if (!hook.poolIds.includes(poolId)) hook.poolIds = [...hook.poolIds, poolId].slice(-30);
      if (!hook.poolKinds.includes(pool.kind)) hook.poolKinds.push(pool.kind);
      for (const token of correlatedTokens) if (!hook.newTokens.includes(token)) hook.newTokens = [...hook.newTokens, token].slice(-50);
      hook.controllers[controllerAddress] ||= { controller: getAddress(controllerAddress), transactions: [], poolIds: [], newTokens: [], safeTokens: [], callers: [], alerted: false };
      const controller = hook.controllers[controllerAddress];
      controller.safeTokens ||= [];
      controller.callers ||= [];
      if (!controller.transactions.includes(transactionHash)) controller.transactions = [...controller.transactions, transactionHash].slice(-30);
      if (!controller.poolIds.includes(poolId)) controller.poolIds = [...controller.poolIds, poolId].slice(-30);
      for (const token of correlatedTokens) if (!controller.newTokens.includes(token)) controller.newTokens = [...controller.newTokens, token].slice(-50);
      for (const token of safeTokens) if (!controller.safeTokens.includes(token)) controller.safeTokens = [...controller.safeTokens, token].slice(-50);
      if (caller && !controller.callers.includes(caller)) controller.callers = [...controller.callers, caller].slice(-30);
      return { hook, controller, key };
    };

    while (true) {
      const phase = await withState((revision) => {
        const draft = structuredClone(state);
        const { hook, controller, key } = applyObservation(draft);
        const ready = controller.transactions.length >= 2
          && controller.poolIds.length >= 2
          && controller.newTokens.length >= 2
          && controller.safeTokens.length >= 2
          && controller.callers.length >= 2;
        if (controller.alerted || !ready) {
          state = draft;
          return { done: true, event: null, savePromise: save(draft) };
        }
        if (alertsSuppressedAtBlock(draft, blockNumber)) {
          controller.alerted = true;
          controller.baselinedAt = iso(now);
          state = draft;
          return { done: true, event: null, savePromise: save(draft) };
        }
      const fingerprint = digest({ hook: key, controller: controllerAddress, hookCodeHash: hookProfile.codeHash, controllerCodeHash: controllerProfile.codeHash, poolKinds: hook.poolKinds });
      const platformEntry = platformForAddress(controllerAddress);
      const kind = isKnownLaunchRootPlatform(platformEntry) ? "new_mode" : "new_launchpad";
      const event = {
        type: "bsc_launchpad_update",
        kind,
        eventKey: `bsc-hook:56:${key}:${controllerAddress}`,
        chainId: BSC_CHAIN_ID,
        launcher: getAddress(controllerAddress),
        platform: publicPlatform(platformEntry),
        launchCount: controller.transactions.length,
        uniqueTokens: controller.newTokens.length,
        transactionHash,
        blockNumber,
        tokens: correlatedTokens.map((token) => ({ token: getAddress(token), metadata: null })),
        pools: [pool],
        mode: { selector: "v4-hook", fingerprint, hook: hook.hook, poolKinds: [...hook.poolKinds], hookCodeHash: hookProfile.codeHash, controllerCodeHash: controllerProfile.codeHash },
        structural: { eligible: true, mechanismEvidence: true, source: "verified_singleton_correlated_controller", codeSize: controllerProfile.codeSize, selectorCount: controllerProfile.selectors.length, usesCreate: controllerProfile.usesCreate, usesCreate2: controllerProfile.usesCreate2, independentCallers: controller.callers.length },
        security: securityAssessments.find((item) => item.token === correlatedTokens[0])?.security || null,
        attribution: inferBscLaunchpadAttribution({
          officialFactory: platformEntry?.trust === "official_verified"
            ? { platform: publicPlatform(platformEntry), address: controllerAddress, sourceId: platformEntry.evidenceUrl }
            : null,
          causalEvidence: platformEntry?.trust === "official_shared"
            ? { platform: publicPlatform(platformEntry), emitter: controllerAddress, sourceId: "verified-v4-hook-controller" }
            : null,
        }),
        explorerUrl: `https://bscscan.com/tx/${transactionHash}`,
        launcherUrl: `https://bscscan.com/address/${controllerAddress}`,
        blockTimestamp,
        observedAt: iso(now),
        strong: true,
      };
        return { done: false, event, evaluatedRevision: revision };
      });
      if (phase.done) {
        await phase.savePromise;
        return phase.event;
      }
      const delivery = await withEventDelivery(phase.event.eventKey, async () => {
        try {
          await alertSender(config, phase.event);
        } catch (error) {
          error.code ||= "ALERT_DELIVERY_PENDING";
          throw error;
        }
        const committed = await withState((revision) => {
          const draft = structuredClone(state);
          const { controller } = applyObservation(draft);
          controller.alerted = true;
          controller.alertedAt = iso(now);
          if (draft.launchers[controllerAddress]) draft.launchers[controllerAddress].discoveryAlerted = true;
          state = draft;
          return { evaluatedRevision: phase.evaluatedRevision, committedRevision: revision, savePromise: save(draft) };
        });
        await committed.savePromise;
        if (onLaunchpadCandidate) void Promise.resolve(onLaunchpadCandidate(phase.event)).catch((error) => logger.error(`[bsc][followup] ${errorSummary(error)}`));
        return phase.event;
      });
      if (delivery.owner) return phase.event;
    }
  }

  function blockCacheStoppedError() {
    const error = new Error("BSC block cache stopped");
    error.code = "BSC_BLOCK_CACHE_STOPPED";
    return error;
  }

  function isBlockCacheStoppedError(error) {
    return error?.code === "BSC_BLOCK_CACHE_STOPPED";
  }

  function throwIfBlockCacheStopped() {
    if (stopped || blockCacheAbortController.signal.aborted) throw blockCacheStoppedError();
  }

  function awaitBlockCacheGeneration(entry) {
    throwIfBlockCacheStopped();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        blockCacheAbortController.signal.removeEventListener("abort", onAbort);
        handler(value);
      };
      const onAbort = () => finish(reject, blockCacheStoppedError());
      blockCacheAbortController.signal.addEventListener("abort", onAbort, { once: true });
      if (stopped || blockCacheAbortController.signal.aborted) {
        onAbort();
        return;
      }
      Promise.race([
        entry.outcome.then((outcome) => ({ kind: "outcome", outcome })),
        entry.superseded.then((next) => ({ kind: "superseded", next })),
      ]).then(
        (result) => finish(resolve, result),
        (error) => finish(reject, error),
      );
    });
  }

  function installBlockCacheGeneration(blockNumber, source, load) {
    const key = Number(blockNumber);
    const previous = blockCache.get(key) || null;
    let supersede;
    const entry = {
      id: ++blockCacheGeneration,
      key,
      source,
      settled: false,
      superseded: new Promise((resolve) => { supersede = resolve; }),
      supersede,
      outcome: null,
    };
    // Outcomes always resolve, even when the underlying RPC/deferred proof
    // rejects. This absorbs late failures after a newer WebSocket generation
    // has replaced the entry and prevents unhandled rejections.
    entry.outcome = Promise.resolve()
      .then(load)
      .then(
        (block) => ({ ok: true, block }),
        (error) => ({ ok: false, error }),
      )
      .then((outcome) => {
        entry.settled = true;
        return outcome;
      });
    blockCache.set(key, entry);
    previous?.supersede(entry);
    return entry;
  }

  function invalidateBlockCacheGeneration(blockNumber, expected) {
    const key = Number(blockNumber);
    if (!expected || blockCache.get(key) !== expected) return false;
    blockCache.delete(key);
    expected.supersede(null);
    return true;
  }

  function replaceBlockCacheGenerationWithHttp(blockNumber, expected) {
    throwIfBlockCacheStopped();
    const key = Number(blockNumber);
    const current = blockCache.get(key) || null;
    if (current && current !== expected) return current;
    return installBlockCacheGeneration(key, "http", () => provider.getBlock(key));
  }

  function currentBlockCacheGeneration(blockNumber) {
    throwIfBlockCacheStopped();
    const key = Number(blockNumber);
    return blockCache.get(key)
      || installBlockCacheGeneration(key, "http", () => provider.getBlock(key));
  }

  async function readBlockCacheGeneration(blockNumber) {
    throwIfBlockCacheStopped();
    const key = Number(blockNumber);
    let entry = currentBlockCacheGeneration(key);
    // One reader may observe HTTP -> WS pending -> WS verified. Cap further
    // generation churn so no external task can make shutdown wait forever.
    for (let hop = 0; hop < 4; hop += 1) {
      const result = await awaitBlockCacheGeneration(entry);
      throwIfBlockCacheStopped();
      if (result.kind === "superseded") {
        entry = result.next || currentBlockCacheGeneration(key);
        continue;
      }
      const current = blockCache.get(key) || null;
      if (current !== entry) {
        entry = current || currentBlockCacheGeneration(key);
        continue;
      }
      if (!result.outcome.ok) {
        if (entry.source === "ws_pending") {
          entry = replaceBlockCacheGenerationWithHttp(key, entry);
          continue;
        }
        invalidateBlockCacheGeneration(key, entry);
        throw result.outcome.error;
      }
      if (blockCache.size > 256) {
        const cutoff = key - 128;
        for (const [number, cached] of blockCache) {
          if (number < cutoff && cached.settled && cached.source !== "ws_pending") {
            invalidateBlockCacheGeneration(number, cached);
          }
        }
      }
      return { entry, block: result.outcome.block };
    }
    const error = new Error(`BSC block cache generation churn ${key}`);
    error.code = "BSC_BLOCK_CACHE_GENERATION_CHURN";
    throw error;
  }

  async function cachedBlock(blockNumber) {
    return (await readBlockCacheGeneration(blockNumber)).block;
  }

  function reserveWebsocketProofBlock(blockNumber, deadlineAtMs, candidateId) {
    const key = Number(blockNumber);
    let resolvePending;
    let rejectPending;
    let settled = false;
    const pending = new Promise((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    const entry = installBlockCacheGeneration(key, "ws_pending", () => pending);
    const remainingMs = Math.max(1, Math.min(
      BSC_WEBSOCKET_DELIVERY_BUDGET_MS,
      Math.floor(deadlineAtMs - Number(now()) - BSC_WEBSOCKET_PROOF_DELIVERY_RESERVE_MS),
    ));
    const timer = websocketRpcSetTimeout(() => {
      if (settled) return;
      settled = true;
      const error = websocketProofUnavailable(`BSC websocket block reservation timed out for ${candidateId}`);
      rejectPending(error);
      invalidateBlockCacheGeneration(key, entry);
    }, remainingMs);
    timer.unref?.();
    return {
      publish(block) {
        if (!settled) {
          settled = true;
          websocketRpcClearTimeout(timer);
          resolvePending(block);
        }
        // A fully normalized proof is authoritative for this confirmed block.
        // Replacing the generation wakes readers of an older pending HTTP RPC;
        // its eventual failure is absorbed by its own outcome.
        return installBlockCacheGeneration(key, "ws_verified", () => block);
      },
      fail(error) {
        if (settled) return;
        settled = true;
        websocketRpcClearTimeout(timer);
        rejectPending(error || websocketProofUnavailable(`BSC websocket block reservation failed for ${candidateId}`));
        invalidateBlockCacheGeneration(key, entry);
      },
    };
  }

  async function cachedBlockTimestamp(blockNumber) {
    const block = await cachedBlock(blockNumber);
    const timestamp = Number(block?.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error(`missing block timestamp ${blockNumber}`);
    return new Date(timestamp * 1_000).toISOString();
  }

  function mergePools(first, second) {
    return [...new Map([...first, ...second].map((pool) => [`${pool.factory}:${pool.pool || pool.poolId || "unknown"}`, pool])).values()];
  }

  function implementationFromUpgradeLog(log) {
    const dataWords = (String(log.data || "0x").replace(/^0x/, "").match(/.{64}/g) || []).map((word) => `0x${word}`);
    const words = [...(log.topics || []).slice(1), ...dataWords];
    return words.map(addressFromStorage).filter(Boolean).at(-1) || null;
  }

  async function observeOfficialLifecycle(receipt, blockNumber) {
    const observations = (receipt.logs || []).map((log) => {
      const lifecycle = parseRuntimeOfficialLifecycleLog(log);
      return lifecycle ? { log, lifecycle } : null;
    }).filter(Boolean);
    if (!observations.length) return false;
    const blockTimestamp = await cachedBlockTimestamp(blockNumber);
    let emitted = false;
    for (const observation of observations) {
      const lifecycleKey = `${observation.lifecycle.platform.id}:${observation.lifecycle.lifecycleId}`;
      const observedAt = iso(now);
      const emitter = getAddress(observation.log.address);
      const transactionHash = receipt.hash || receipt.transactionHash;
      const lifecycleDetails = Object.fromEntries(Object.entries(observation.lifecycle)
        .filter(([key]) => !["platform", "lifecycleId", "eventName", "componentRole", "componentMode"].includes(key)));
      const record = {
        emitter: emitter.toLowerCase(),
        topic: observation.log.topics[0],
        transactionHash,
        blockNumber,
        ...lifecycleDetails,
        blockTimestamp,
        observedAt,
      };
      const platform = observation.lifecycle.platform;
      const event = {
          type: "bsc_launchpad_update",
          kind: "new_mode",
          eventKey: `bsc-official-lifecycle:${lifecycleKey}`,
          chainId: BSC_CHAIN_ID,
          launcher: emitter,
          platform,
          launchCount: 1,
          uniqueTokens: observation.lifecycle.token ? 1 : 0,
          transactionHash,
          blockNumber,
          tokens: observation.lifecycle.token ? [{ token: observation.lifecycle.token, metadata: null }] : [],
          pools: [],
          mode: {
            selector: "official-lifecycle",
            selectorName: observation.lifecycle.eventName,
            componentMode: observation.lifecycle.componentMode,
            lifecycleId: observation.lifecycle.lifecycleId,
            ...lifecycleDetails,
            fingerprint: digest({ lifecycleKey, transactionHash }),
          },
          structural: {
            eligible: true,
            source: platform.trust === "official_verified"
              ? "official_platform_lifecycle_event"
              : "corroborated_platform_lifecycle_event",
            componentRole: observation.lifecycle.componentRole,
          },
          attribution: inferBscLaunchpadAttribution({
            verifiedSourceFamilies: [{
              platform,
              address: emitter,
              contractName: observation.lifecycle.componentRole,
              verifiedSource: true,
              sourceId: platform.evidenceUrl,
            }],
            causalEvidence: {
              platform,
              emitter,
              blockNumber,
              sourceId: "bsc-transaction-receipt",
            },
          }),
          security: null,
          explorerUrl: `https://bscscan.com/tx/${transactionHash}`,
          launcherUrl: `https://bscscan.com/address/${emitter}`,
          blockTimestamp,
          observedAt,
          strong: true,
      };
      while (true) {
        const phase = await withState((revision) => {
          if (state.officialLifecycleEvents[lifecycleKey]) return { done: true, savePromise: null };
          if (!alertsSuppressedAtBlock(state, blockNumber)) return { done: false, revision };
          const draft = structuredClone(state);
          draft.officialLifecycleEvents[lifecycleKey] = record;
          state = draft;
          return { done: true, savePromise: save(draft) };
        });
        if (phase.done) {
          if (phase.savePromise) await phase.savePromise;
          break;
        }
        const delivery = await withEventDelivery(event.eventKey, async () => {
          try {
            await alertSender(config, event);
          } catch (error) {
            error.code ||= "ALERT_DELIVERY_PENDING";
            throw error;
          }
          const committed = await withState((revision) => {
            const draft = structuredClone(state);
            draft.officialLifecycleEvents[lifecycleKey] ||= record;
            state = draft;
            return { evaluatedRevision: phase.revision, committedRevision: revision, savePromise: save(draft) };
          });
          await committed.savePromise;
          if (onLaunchpadCandidate) void Promise.resolve(onLaunchpadCandidate(event)).catch((error) => logger.error(`[bsc][followup] ${errorSummary(error)}`));
          return event;
        });
        if (delivery.owner) emitted = true;
        break;
      }
    }
    return emitted;
  }

  async function observeOfficialUpgrades(receipt, blockNumber) {
    const updates = (receipt.logs || []).filter((log) => BSC_UPGRADE_TOPICS.includes(log.topics?.[0])).map((log) => {
      const component = runtimeOfficialComponentForAddress(log.address);
      const implementation = implementationFromUpgradeLog(log);
      if (!component || !implementation) return null;
      const fingerprint = digest({ emitter: log.address.toLowerCase(), implementation: implementation.toLowerCase() });
      return { log, component, implementation, fingerprint };
    }).filter(Boolean);
    if (!updates.length) return false;
    const verifyImplementation = async (update) => {
      let historicalError = null;
      let implementationCode;
      try {
        implementationCode = await provider.getCode(update.implementation, blockNumber);
        if (typeof implementationCode !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(implementationCode)) {
          const invalid = new Error(`historical code RPC returned invalid code for ${update.implementation}`);
          invalid.code = "NETWORK_ERROR";
          throw invalid;
        }
      } catch (error) {
        historicalError = error;
        try {
          implementationCode = await provider.getCode(update.implementation);
          if (typeof implementationCode !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(implementationCode)) {
            const invalid = new Error(`latest code RPC returned invalid code for ${update.implementation}`);
            invalid.code = "NETWORK_ERROR";
            throw invalid;
          }
        } catch (latestError) {
          const unavailable = new Error(
            `official upgrade implementation verification unavailable for ${update.implementation}: historical=${errorSummary(historicalError)}; latest=${errorSummary(latestError)}`,
          );
          // Regardless of provider-specific error names, two failed code
          // reads mean verification itself is unavailable and must stay on a
          // transient retry path rather than becoming a poison transaction.
          unavailable.code = "NETWORK_ERROR";
          unavailable.rpcCodes = [historicalError?.code, latestError?.code].filter(Boolean);
          unavailable.rpcOperation = "getCode";
          unavailable.rpcFailureScope = [historicalError, latestError]
            .every((error) => error?.rpcFailureScope === "method") ? "method" : undefined;
          const retryAfterMs = Math.max(Number(historicalError?.retryAfterMs) || 0, Number(latestError?.retryAfterMs) || 0);
          if (retryAfterMs > 0) unavailable.retryAfterMs = retryAfterMs;
          throw unavailable;
        }
      }
      return implementationCode === "0x" ? null : update;
    };
    const [blockTimestamp, verifiedUpdates] = await Promise.all([
      cachedBlockTimestamp(blockNumber),
      Promise.all(updates.map(verifyImplementation)).then((items) => items.filter(Boolean)),
    ]);
    let emitted = false;
    for (const update of verifiedUpdates) {
      const observedAt = iso(now);
      const emitter = getAddress(update.log.address);
      // A verified upgrade must never share a latest-state profile or a
      // short-bucket controller identity with a preceding ordinary launch.
      // The following launch is therefore forced through the changed
      // implementation check even when it lands in the same 20-block bucket.
      invalidateRuntimeIdentity(emitter);
      const record = { emitter: emitter.toLowerCase(), implementation: update.implementation.toLowerCase(), topic: update.log.topics[0], transactionHash: receipt.hash || receipt.transactionHash, blockNumber, blockTimestamp, observedAt };
      const event = {
          type: "bsc_launchpad_update",
          kind: "new_mode",
          eventKey: `bsc-official-upgrade:${update.fingerprint}`,
          chainId: BSC_CHAIN_ID,
          launcher: emitter,
          platform: update.component.platform,
          launchCount: 0,
          uniqueTokens: 0,
          transactionHash: receipt.hash || receipt.transactionHash,
          blockNumber,
          tokens: [],
          pools: [],
          mode: { selector: "proxy-upgrade", selectorName: "Upgraded / ImplementationUpdated", componentMode: update.component.mode, implementation: update.implementation, fingerprint: update.fingerprint },
          structural: {
            eligible: true,
            source: update.component.shadow
              ? "chain_verified_prelaunch_upgrade_event"
              : update.component.corroborated ? "corroborated_component_upgrade_event" : "official_component_upgrade_event",
            componentRole: update.component.role,
          },
          attribution: inferBscLaunchpadAttribution({
            officialFactory: update.component.platform?.trust === "official_verified"
              ? { platform: update.component.platform, address: emitter, sourceId: update.component.platform.evidenceUrl }
              : null,
            verifiedSourceFamilies: update.component.platform?.trust === "multi_source_corroborated"
              ? [{ platform: update.component.platform, address: emitter, contractName: update.component.mode, verifiedSource: true, sourceId: "corroborated-deployment-source" }]
              : [],
            causalEvidence: ["official_shared", "multi_source_corroborated", "chain_verified_prelaunch"].includes(update.component.platform?.trust)
              ? { platform: update.component.platform, emitter, sourceId: "bsc-official-component-upgrade" }
              : null,
          }),
          security: null,
          explorerUrl: `https://bscscan.com/tx/${receipt.hash || receipt.transactionHash}`,
          launcherUrl: `https://bscscan.com/address/${emitter}`,
          blockTimestamp,
          observedAt,
          strong: true,
      };
      while (true) {
        const phase = await withState((revision) => {
          if (state.officialUpgrades[update.fingerprint]) return { done: true, savePromise: null };
          if (!alertsSuppressedAtBlock(state, blockNumber)) return { done: false, revision };
          const draft = structuredClone(state);
          draft.officialUpgrades[update.fingerprint] = record;
          state = draft;
          return { done: true, savePromise: save(draft) };
        });
        if (phase.done) {
          if (phase.savePromise) await phase.savePromise;
          break;
        }
        const delivery = await withEventDelivery(event.eventKey, async () => {
          try {
            await alertSender(config, event);
          } catch (error) {
            error.code ||= "ALERT_DELIVERY_PENDING";
            throw error;
          }
          const committed = await withState((revision) => {
            const draft = structuredClone(state);
            draft.officialUpgrades[update.fingerprint] ||= record;
            state = draft;
            return { evaluatedRevision: phase.revision, committedRevision: revision, savePromise: save(draft) };
          });
          await committed.savePromise;
          if (onLaunchpadCandidate) void Promise.resolve(onLaunchpadCandidate(event)).catch((error) => logger.error(`[bsc][followup] ${errorSummary(error)}`));
          return event;
        });
        if (delivery.owner) emitted = true;
        break;
      }
    }
    return emitted;
  }

  function officialReceiptTokens(receipt, controller, pools, verifiedNewContracts = new Set()) {
    const controllerAddress = controller.address.toLowerCase();
    const effectiveEmitter = String(controller.childController || controller.address).toLowerCase();
    const poolAddresses = new Set(pools.map((pool) => pool.pool?.toLowerCase()).filter(Boolean));
    const exactEvidence = (controller.launchEvidence || parseKnownBscLaunchEvidence(receipt.logs || []))
      .filter((item) => item.emitter.toLowerCase() === effectiveEmitter);
    if (exactEvidence.length) return exactEvidence.map((item) => ({
      token: item.token,
      isNewContract: verifiedNewContracts.has(item.token.toLowerCase()),
      metadata: item.name || item.symbol || item.website || item.twitter || item.telegram ? {
        name: item.name || null,
        symbol: item.symbol || null,
        description: item.description || null,
        image: item.image || null,
        website: item.website || null,
        twitter: item.twitter || null,
        telegram: item.telegram || null,
        metadataUri: item.metadataUri || null,
        totalSupply: item.totalSupply || null,
        saleInventory: item.saleInventory || null,
        fundingGoal: item.fundingGoal || null,
        taxConfig: item.buyTaxRate !== undefined ? {
          buyTaxRate: item.buyTaxRate,
          sellTaxRate: item.sellTaxRate,
          marketShare: item.marketShare,
          burnShare: item.burnShare,
          reflectShare: item.reflectShare,
          liquidityShare: item.liquidityShare,
          minHoldForReward: item.minHoldForReward,
          reflectionAsset: item.reflectionAsset,
        } : null,
      } : null,
      launchEvidence: item,
    }));
    if (!controller.causalTokenEvent) return [];
    const mintEmitters = (receipt.logs || [])
      .filter(isErc20MintLog)
      .map((log) => String(log.address).toLowerCase())
      .filter((address) => verifiedNewContracts.has(address) && !BSC_IGNORED_MINTS.has(address) && !BSC_EXCLUDED_CONTROLLERS.has(address) && !poolAddresses.has(address) && address !== controllerAddress);
    return [...new Set(mintEmitters)]
      .map((token) => ({ token: getAddress(token), isNewContract: true, metadata: null }));
  }

  function unresolvedFourMemeQuoteActivations(snapshot = state) {
    return Object.entries(snapshot?.officialSources?.fourMeme?.featureActivations || {})
      .filter(([, activation]) => activation?.type === "quote_config"
        && activation.active !== false
        && !activation.firstTokenAlertedAt
        && !activation.firstTokenTransactionHash);
  }

  function unresolvedFourMemeTokenApiTemplateActivations(snapshot = state) {
    return Object.entries(snapshot?.officialSources?.fourMeme?.featureActivations || {})
      .filter(([, activation]) => activation?.type === "template"
        && activation.verificationLane === "official_token_api"
        && activation.active !== false
        && !activation.firstTokenAlertedAt
        && !activation.firstTokenTransactionHash);
  }

  async function readFourMemeManagerTokenInfo(manager, token, blockTag = null) {
    const request = {
      to: manager,
      data: fourMemeTokenInfo.encodeFunctionData("_tokenInfos", [token]),
      ...(blockTag !== null ? { blockTag: Number(blockTag) } : {}),
    };
    let raw;
    try {
      raw = await provider.call(request);
    } catch (error) {
      if (blockTag === null || !isBscArchiveStateUnavailable(error)) throw error;
      raw = await provider.call({ to: manager, data: request.data });
    }
    const info = fourMemeTokenInfo.decodeFunctionResult("_tokenInfos", raw);
    if (String(info.base).toLowerCase() !== String(token).toLowerCase()) return null;
    return {
      base: getAddress(info.base),
      quoteAsset: getAddress(info.quote).toLowerCase(),
      managerTemplate: info.template.toString(),
      launchTime: info.launchTime.toString(),
      status: Number(info.status),
    };
  }

  function openFourModeContext(exactCreationEvidence, observedAt, requestedActivationKey = null) {
    const evidence = exactCreationEvidence.find((item) => item.topic === OPENFOUR_TOKEN_CREATED_TOPIC && item.presetId);
    if (!evidence) return null;
    const presetId = String(evidence.presetId);
    const template = state.officialSources?.fourMeme?.templates?.[presetId] || null;
    const templateActivationKey = template ? fourMemeActivationKey(template) : null;
    const templateActivation = templateActivationKey
      ? state.officialSources?.fourMeme?.featureActivations?.[templateActivationKey]
      : null;
    const quoteAsset = String(evidence.quoteAsset || "").toLowerCase() || null;
    const quoteMatch = unresolvedFourMemeQuoteActivations()
      .find(([, activation]) => String(activation.quoteAddress || "").toLowerCase() === quoteAsset
        && fourMemeActivationEligibleAt(activation, observedAt));
    const templateEligible = Boolean(templateActivation
      && fourMemeActivationEligibleAt(templateActivation, observedAt)
      && !templateActivation.firstTokenAlertedAt
      && !templateActivation.firstTokenTransactionHash);
    const [quoteActivationKey, quoteActivation] = quoteMatch || [];
    const requestedTemplate = requestedActivationKey && requestedActivationKey === templateActivationKey && templateEligible;
    const requestedQuote = requestedActivationKey && requestedActivationKey === quoteActivationKey && Boolean(quoteActivation);
    const activationKey = requestedActivationKey
      ? requestedTemplate ? templateActivationKey : requestedQuote ? quoteActivationKey : null
      : templateEligible ? templateActivationKey : quoteActivationKey;
    const activation = requestedActivationKey
      ? requestedTemplate ? templateActivation : requestedQuote ? quoteActivation : null
      : templateEligible ? templateActivation : quoteActivation;
    const featureActivationEligible = Boolean(activation);
    const quoteConfig = quoteActivation?.quoteConfig || null;
    return {
      presetId,
      templateFingerprint: template?.fingerprint || null,
      template: template ? { ...template } : null,
      quoteAsset,
      quoteFingerprint: quoteActivation?.quoteFingerprint || null,
      quoteSymbol: quoteActivation?.quoteSymbol || quoteConfig?.symbol || null,
      curveModule: String(evidence.curveModule || "").toLowerCase() || null,
      tradeModule: String(evidence.tradeModule || "").toLowerCase() || null,
      migrateModule: String(evidence.migrateModule || "").toLowerCase() || null,
      tokenModule: String(evidence.tokenModule || "").toLowerCase() || null,
      flags: evidence.flags != null ? String(evidence.flags) : null,
      componentMode: activation?.type === "quote_config"
        ? `Four.Meme ${activation.quoteSymbol || activation.quoteConfig?.symbol || "新报价"} 新底池`
        : template?.name ? `Four.Meme ${template.name}` : `OpenFour preset ${presetId}`,
      componentModeAlertEligible: featureActivationEligible,
      featureActivationKey: featureActivationEligible ? activationKey : null,
      featureActivationEligible,
    };
  }

  async function fourMemeManagerModeContext(controller, exactCreationEvidence, token, blockTag, observedAt, requestedActivationKey = null) {
    const presaleManagerRoots = fourMemePresaleManagerRoots();
    const classicEvidence = exactCreationEvidence.some((item) => item.topic === FOUR_MEME_TOKEN_CREATE_TOPIC);
    const presaleEvidence = exactCreationEvidence.some((item) => item.topic === FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC
      && presaleManagerRoots.has(String(item.emitter || "").toLowerCase()));
    if (!classicEvidence && !presaleEvidence) return null;

    const quoteActivations = classicEvidence ? unresolvedFourMemeQuoteActivations() : [];
    const templateActivations = unresolvedFourMemeTokenApiTemplateActivations();
    if (!quoteActivations.length && !templateActivations.length) return null;

    let info = null;
    if (classicEvidence && quoteActivations.length) {
      try {
        info = await readFourMemeManagerTokenInfo(controller.address, token, blockTag);
      } catch (error) {
        logger.error(`[bsc][fourmeme] _tokenInfos ${controller.address}: ${errorSummary(error)}`);
        if (!templateActivations.length) throw error;
      }
    }

    const needsOfficialTokenProof = presaleEvidence
      || templateActivations.length > 0
      || (quoteActivations.length > 0 && controller.platform?.id === "fourmeme-springboard-shared");
    const officialTokenRecord = needsOfficialTokenProof
      ? await fetchOfficialTokenRecord("fourmeme", token)
      : null;
    if (needsOfficialTokenProof && !officialTokenRecord) {
      const error = new Error(`Four.Meme token API has not indexed ${token}`);
      error.code = "TIMEOUT";
      throw error;
    }

    const templateMatch = templateActivations.find(([key, activation]) =>
      (!requestedActivationKey || key === requestedActivationKey)
      && officialTokenRecord?.networkCode === "BSC"
      && String(activation.templateId || "") === String(officialTokenRecord?.templateId || "")
      && String(activation.templateFingerprint || "") === String(officialTokenRecord?.templateFingerprint || "")
      && fourMemeActivationEligibleAt(activation, observedAt));
    const quoteMatch = info ? quoteActivations.find(([key, activation]) =>
      (!requestedActivationKey || key === requestedActivationKey)
      && String(activation.quoteAddress || "").toLowerCase() === info.quoteAsset
      && fourMemeActivationEligibleAt(activation, observedAt)) : null;

    let match = templateMatch || quoteMatch;
    if (requestedActivationKey) {
      match = [templateMatch, quoteMatch].find((candidate) => candidate?.[0] === requestedActivationKey) || null;
    }
    if (match
      && controller.platform?.id === "fourmeme-springboard-shared"
      && !isOfficialFourMemeClassicTokenRecord(officialTokenRecord)) {
      match = null;
    }
    const selectedKey = match?.[0] || null;
    const selectedActivation = match?.[1] || null;
    const quoteConfig = selectedActivation?.type === "quote_config"
      ? selectedActivation.quoteConfig
      : (info ? Object.values(state.officialSources?.fourMeme?.quoteConfigs || {})
        .find((config) => config.address === info.quoteAsset) : null);
    const template = selectedActivation?.type === "template" ? selectedActivation.template : null;
    return {
      ...(info || {}),
      managerTemplate: info?.managerTemplate || officialTokenRecord?.version || null,
      templateId: template ? selectedActivation.templateId : null,
      templateFingerprint: template ? selectedActivation.templateFingerprint : null,
      template: template ? { ...template } : null,
      quoteFingerprint: selectedActivation?.type === "quote_config"
        ? selectedActivation.quoteFingerprint
        : quoteConfig?.fingerprint || null,
      quoteSymbol: selectedActivation?.type === "quote_config"
        ? selectedActivation.quoteSymbol
        : quoteConfig?.symbol || null,
      componentMode: template?.name
        ? `Four.Meme ${template.name}`
        : quoteConfig?.symbol ? `Four.Meme ${quoteConfig.symbol} 新底池` : (presaleEvidence ? "Four.Meme Presale" : null),
      componentModeAlertEligible: Boolean(match),
      featureActivationKey: selectedKey,
      featureActivationEligible: Boolean(match),
      officialTokenRecord,
    };
  }

  async function prepareTransaction(entry, context = {}) {
    if (state.seenTransactions[entry.transactionHash]) return null;
    const [transaction, receipt] = context.transaction && context.receipt
      ? [context.transaction, context.receipt]
      : await Promise.all([
        provider.getTransaction(entry.transactionHash),
        provider.getTransactionReceipt(entry.transactionHash),
      ]);
    if (!transaction || !receipt) throw new Error(`missing finalized transaction or receipt ${entry.transactionHash}`);
    if (receipt.status !== 1 || !transaction.to) return null;
    const bscPools = context.bscPools || parseBscPoolLogs(receipt.logs);
    const poolAddresses = new Set(bscPools.map((pool) => pool.pool?.toLowerCase()).filter(Boolean));
    const verifiedNewContracts = new Set([...(entry.verifiedNewContracts || [])].map((address) => String(address).toLowerCase()));
    const preliminaryTokens = [...new Set([
      ...parseKnownBscLaunchTokens(receipt.logs || []).map((address) => address.toLowerCase()),
      ...(receipt.logs || []).filter(isErc20MintLog).map((log) => String(log.address).toLowerCase()),
      ...verifiedNewContracts,
    ].filter((address) => ADDRESS.test(address) && !poolAddresses.has(address) && !BSC_IGNORED_MINTS.has(address) && !BSC_EXCLUDED_CONTROLLERS.has(address)))];
    const controller = catalogController(transaction, receipt, preliminaryTokens, bscPools);
    if (!controller || BSC_EXCLUDED_CONTROLLERS.has(controller.address.toLowerCase())) return null;

    let parsed = { launch: null };
    let tokens = [];
    if (controller.platform?.trust === "official_verified") {
      tokens = officialReceiptTokens(receipt, controller, bscPools, verifiedNewContracts);
    } else {
      const block = await cachedBlock(entry.blockNumber);
      if (!block) throw new Error(`missing block ${receipt.blockNumber}`);
      parsed = await analyzeReceipt(provider, transaction, receipt, block, {
        includeTokenMetadata: false,
        wrappedNativeAddresses: [BSC_WBNB],
        ignoredMintEmitters: BSC_IGNORED_MINTS,
        assumeContractCaller: true,
        knownNewContractAddresses: [...(entry.verifiedNewContracts || [])],
        useLatestCodeForDeployment: true,
      });
      tokens = parsed.launch?.tokens?.filter((token) => token.isNewContract) || [];
      for (const token of parseKnownBscLaunchTokens(receipt.logs)) {
        if (verifiedNewContracts.has(token.toLowerCase()) && !tokens.some((item) => item.token.toLowerCase() === token.toLowerCase())) tokens.push({ token, isNewContract: true, metadata: null });
      }
    }
    tokens = tokens.filter((token) => !poolAddresses.has(token.token.toLowerCase()) && (token.isNewContract || verifiedNewContracts.has(token.token.toLowerCase())));
    if (!tokens.length) return null;

    const relevantPools = mergePools(parsed.launch?.pools || [], bscPools)
      .filter((pool) => tokens.some((token) => [pool.token0, pool.token1].some((address) => address.toLowerCase() === token.token.toLowerCase())));
    const effectiveEmitter = String(controller.childController || controller.address).toLowerCase();
    const exactCreationEvidence = (controller.launchEvidence || [])
      .filter((item) => item.emitter.toLowerCase() === effectiveEmitter);
    const transactionObservedAt = await cachedBlockTimestamp(entry.blockNumber);
    const requestedFlapActivationKey = state.officialSources?.flap?.featureActivations?.[entry.featureActivationReplayKey]
      ? entry.featureActivationReplayKey
      : null;
    const requestedFourMemeActivationKey = state.officialSources?.fourMeme?.featureActivations?.[entry.featureActivationReplayKey]
      ? entry.featureActivationReplayKey
      : null;
    const flapModeContext = controller.platform?.id === "flap"
      ? matchFlapFeatureActivation(state, {
        exactCreationEvidence,
        relevantPools,
        token: tokens[0].token,
        observedAt: transactionObservedAt,
        requestedActivationKey: requestedFlapActivationKey,
      })
      : null;
    const openFourContext = openFourModeContext(
      exactCreationEvidence,
      transactionObservedAt,
      requestedFourMemeActivationKey,
    );
    const fourMemeManagerContext = openFourContext
      ? null
      : await fourMemeManagerModeContext(
        controller,
        exactCreationEvidence,
        tokens[0].token,
        entry.blockNumber,
        transactionObservedAt,
        requestedFourMemeActivationKey,
      );
    const fourMemeModeContext = openFourContext || fourMemeManagerContext;
    const officialFeatureModeContext = flapModeContext || fourMemeModeContext;
    const exactCreationTopics = exactCreationEvidence
      .map((item) => item.topic);
    const correlatedCreationTopics = (controller.correlated || [])
      .filter((item) => item.emitter.toLowerCase() === controller.address.toLowerCase())
      .map((item) => item.topic);
    const creationTopics = [...new Set(controller.platform ? exactCreationTopics : [...exactCreationTopics, ...correlatedCreationTopics])].sort();
    if (["official_create_selector", "official_flap_create_candidate"].includes(controller.kind)) {
      creationTopics.push(`selector:${transaction.data.slice(0, 10).toLowerCase()}`);
    }
    const selector = transaction.to.toLowerCase() === controller.address.toLowerCase() ? transaction.data.slice(0, 10).toLowerCase() : "internal";
    const poolKinds = [...new Set(relevantPools.filter((pool) => pool.verifiedDex === true).map((pool) => pool.kind))].sort();
    const verifiedPoolFactories = [...new Set(relevantPools.filter((pool) => pool.verifiedDex === true).map((pool) => pool.factory.toLowerCase()))].sort();
    const launchTypes = [...new Set(exactCreationEvidence.map((item) => item.launchType).filter(Boolean))].sort();
    const vaultFactories = [...new Set(exactCreationEvidence
      .map((item) => String(item.vaultFactory || "").toLowerCase())
      .filter((address) => ADDRESS.test(address)))];
    const vaultFactory = vaultFactories.length === 1 ? vaultFactories[0] : null;
    const configuredVaultName = vaultFactory ? FLAP_OFFICIAL_VAULT_FACTORIES.get(vaultFactory) || null : null;
    const vaultDiscovery = vaultFactory ? state.discoverySources?.external?.contracts?.[vaultFactory] : null;
    const externallyVerifiedVaultFactory = (vaultDiscovery?.sources || [])
      .some((source) => source.sourceTrust === "official_verified");
    const vaultFactoryOfficial = Boolean(configuredVaultName || externallyVerifiedVaultFactory);
    const vaultFactoryMode = configuredVaultName
      || (externallyVerifiedVaultFactory ? `官方 VaultFactory ${vaultFactory.slice(0, 8)}…${vaultFactory.slice(-4)}` : null);
    const argumentBytes = Math.max(0, (transaction.data.length - 10) / 2);
    const argumentEvidence = hasBscLaunchArgumentEvidence({ argumentBytes, controllerKind: controller.kind, creationTopics });
    const profileBlock = alertsSuppressedAtBlock(state, entry.blockNumber) ? null : entry.blockNumber;
    const modeDescriptor = {
      selector,
      poolKinds,
      verifiedPoolFactories,
      creationTopics,
      launchTypes,
      vaultFactory: flapModeContext?.vaultFactory || vaultFactory,
      presetId: fourMemeModeContext?.presetId || null,
      managerTemplate: fourMemeModeContext?.managerTemplate || null,
      quoteAsset: officialFeatureModeContext?.quoteAsset || null,
      curveModule: fourMemeModeContext?.curveModule || null,
      tradeModule: fourMemeModeContext?.tradeModule || null,
      migrateModule: fourMemeModeContext?.migrateModule || null,
      tokenModule: fourMemeModeContext?.tokenModule || null,
      flags: fourMemeModeContext?.flags || null,
      argumentEvidence,
      exactCreationTokens: [...new Set(exactCreationEvidence.map((item) => item.token.toLowerCase()))].sort(),
    };
    // A just-confirmed token with one exact official causal creation event
    // cannot predate its own runtime. Prefer latest for the first full profile
    // and for warmed identity checks, avoiding slow public archive blockTag
    // failures. Static selector/topic/module checks still run before any state
    // shortcut, and official upgrade events invalidate the identity caches.
    const preferLatestOfficialState = profileBlock !== null
      && isNearHeadProfileBlock(entry.blockNumber)
      && exactOfficialCausalProfileEligible(controller, tokens[0].token, modeDescriptor);
    const blockPromise = cachedBlock(entry.blockNumber);
    const fastShape = profileBlock === null ? null : await matchKnownOfficialFastMode({
      provider,
      state,
      controller,
      token: tokens[0].token,
      blockTag: profileBlock,
      descriptor: modeDescriptor,
      warmedFingerprints: warmedKnownOfficialModes,
      identityCache: officialControllerIdentityCache,
      preferLatestState: preferLatestOfficialState,
    });
    let shape;
    let structural;
    let block;
    if (fastShape) {
      shape = officialFeatureModeContext ? { ...fastShape, ...officialFeatureModeContext, fingerprint: fastShape.fingerprint } : fastShape;
      block = await blockPromise;
      structural = {
        eligible: true,
        mechanismEvidence: true,
        argumentBytes,
        codeSize: null,
        usesCreate: null,
        usesCreate2: null,
        infrastructureCount: null,
        customTopicCount: creationTopics.length,
        causalTokenEvent: true,
        controllerKind: controller.kind,
        profileApproximate: preferLatestOfficialState,
        fastPath: "known_official_mode",
      };
    } else {
      const [profile, tokenProfile, resolvedBlock] = await Promise.all([
        runtimeProfile(controller.address, profileBlock, { preferLatestState: preferLatestOfficialState }),
        runtimeProfile(tokens[0].token, profileBlock, { preferLatestState: preferLatestOfficialState }),
        blockPromise,
      ]);
      block = resolvedBlock;
      const flapComponent = controller.platform?.id === "flap"
        ? FLAP_COMPONENTS.get(tokenProfile.implementation?.toLowerCase()) || FLAP_COMPONENTS.get(tokens[0].token.toLowerCase()) || null
        : null;
      shape = {
        selector,
        selectorName: controller.platform?.id === "flap" ? FLAP_SELECTOR_NAMES.get(selector) || null : null,
        poolKinds,
        verifiedPoolFactories,
        creationTopics,
        customTopics: creationTopics,
        launcherCodeHash: profile.codeHash,
        tokenCodeHash: tokenProfile.effectiveCodeHash,
        tokenSelectorHash: tokenProfile.effectiveCodeHash,
        tokenImplementation: tokenProfile.implementation,
        implementation: profile.implementation,
        componentMode: officialFeatureModeContext?.componentMode || vaultFactoryMode || flapComponent?.mode || launchTypes.join("+") || null,
        componentModeAlertEligible: officialFeatureModeContext
          ? officialFeatureModeContext.componentModeAlertEligible
          : externallyVerifiedVaultFactory || (!vaultFactoryMode && !flapComponent),
        vaultFactory: flapModeContext?.vaultFactory || vaultFactory,
        vaultFactoryOfficial: flapModeContext?.vaultFactoryOfficial === true || vaultFactoryOfficial,
        vaultFactoryAlertEligible: flapModeContext?.vaultFactoryAlertEligible === true || externallyVerifiedVaultFactory,
        launchTypes,
        ...(officialFeatureModeContext || {}),
      };
      // Display labels and source-verification flags must not perturb the
      // structural fingerprint. Keeping the legacy identity fields stable
      // avoids turning this monitor upgrade itself into dozens of fake modes;
      // vaultFactory is the only new on-chain identity component.
      const legacyFingerprintInput = {
        selector: shape.selector,
        selectorName: shape.selectorName,
        poolKinds: shape.poolKinds,
        verifiedPoolFactories: shape.verifiedPoolFactories,
        creationTopics: shape.creationTopics,
        customTopics: shape.customTopics,
        launcherCodeHash: shape.launcherCodeHash,
        tokenCodeHash: shape.tokenCodeHash,
        tokenSelectorHash: shape.tokenSelectorHash,
        tokenImplementation: shape.tokenImplementation,
        implementation: shape.implementation,
        componentMode: launchTypes.join("+") || null,
        launchTypes: shape.launchTypes,
        ...(vaultFactory ? { vaultFactory } : {}),
      };
      const fourMemeFingerprintInput = openFourContext ? {
        selector: shape.selector,
        creationTopics: shape.creationTopics,
        launcherCodeHash: shape.launcherCodeHash,
        implementation: shape.implementation,
        presetId: shape.presetId,
        curveModule: shape.curveModule,
        tradeModule: shape.tradeModule,
        migrateModule: shape.migrateModule,
        tokenModule: shape.tokenModule,
        flags: shape.flags,
      } : fourMemeManagerContext ? {
        selector: shape.selector,
        creationTopics: shape.creationTopics,
        launcherCodeHash: shape.launcherCodeHash,
        implementation: shape.implementation,
        managerTemplate: shape.managerTemplate,
        templateId: shape.templateId || null,
        quoteAsset: shape.quoteAsset,
      } : null;
      const flapFeatureFingerprintInput = flapModeContext ? {
        ...legacyFingerprintInput,
        featureActivationKey: flapModeContext.featureActivationKey,
        quoteAsset: flapModeContext.quoteAsset,
        vaultFactory: flapModeContext.vaultFactory,
        vaultCategory: flapModeContext.vaultCategory,
      } : null;
      shape.fingerprint = digest(flapFeatureFingerprintInput || fourMemeFingerprintInput || legacyFingerprintInput);
      const infrastructureCount = Object.values(profile.infrastructure || {}).filter(Boolean).length;
      const mechanismEvidence = Boolean(controller.platform)
        || relevantPools.some((pool) => pool.verifiedDex === true)
        || infrastructureCount > 0;
      structural = {
        eligible: profile.codeSize >= 500
          && argumentEvidence
          && (profile.usesCreate || profile.usesCreate2 || controller.causalTokenEvent)
          && controller.causalTokenEvent
          && creationTopics.length > 0
          && mechanismEvidence,
        mechanismEvidence,
        argumentBytes,
        codeSize: profile.codeSize,
        usesCreate: profile.usesCreate,
        usesCreate2: profile.usesCreate2,
        infrastructureCount,
        customTopicCount: creationTopics.length,
        causalTokenEvent: controller.causalTokenEvent,
        controllerKind: controller.kind,
        profileApproximate: profile.approximate,
      };
      if (structural.eligible && knownOfficialFastTopics(controller.platform?.id)?.has(creationTopics[0])) {
        warmedKnownOfficialModes.add(knownOfficialFastModeKey(controller.address.toLowerCase(), shape.fingerprint));
      }
    }
    if (!block) throw new Error(`missing block ${receipt.blockNumber}`);
    const blockHash = normalizeTransactionHash(block.hash);
    const receiptBlockHash = normalizeTransactionHash(receipt.blockHash);
    const transactionBlockHash = normalizeTransactionHash(transaction.blockHash);
    const requiredConfirmations = Math.max(0, Number(config.bscConfirmations ?? 2));
    const confirmations = Math.max(0, Number(currentHead || 0) - Number(receipt.blockNumber));
    const canonical = /^0x[0-9a-f]{64}$/.test(blockHash)
      && receiptBlockHash === blockHash
      && transactionBlockHash === blockHash
      && normalizeTransactionHash(transaction.hash) === normalizeTransactionHash(receipt.hash || receipt.transactionHash);
    for (const token of tokens) {
      const evidence = (controller.launchEvidence || []).find((item) => item.token.toLowerCase() === token.token.toLowerCase());
      if (!evidence) continue;
      token.launchEvidence = evidence;
      token.metadata = {
        ...(token.metadata || {}),
        name: token.metadata?.name || evidence.name || null,
        symbol: token.metadata?.symbol || evidence.symbol || null,
        description: token.metadata?.description || evidence.description || null,
        image: token.metadata?.image || evidence.image || null,
        website: token.metadata?.website || evidence.website || null,
        twitter: token.metadata?.twitter || evidence.twitter || null,
        telegram: token.metadata?.telegram || evidence.telegram || null,
        metadataUri: token.metadata?.metadataUri || evidence.metadataUri || null,
        totalSupply: token.metadata?.totalSupply || evidence.totalSupply || null,
        saleInventory: token.metadata?.saleInventory || evidence.saleInventory || null,
        fundingGoal: token.metadata?.fundingGoal || evidence.fundingGoal || null,
        taxConfig: token.metadata?.taxConfig || (evidence.buyTaxRate !== undefined ? {
          buyTaxRate: evidence.buyTaxRate,
          sellTaxRate: evidence.sellTaxRate,
          marketShare: evidence.marketShare,
          burnShare: evidence.burnShare,
          reflectShare: evidence.reflectShare,
          liquidityShare: evidence.liquidityShare,
          minHoldForReward: evidence.minHoldForReward,
          reflectionAsset: evidence.reflectionAsset,
        } : null),
      };
    }
    return {
      launcher: controller.address,
      platform: fourMemeModeContext?.featureActivationEligible
        ? { ...fourMemePlatform(), name: openFourContext ? "Four.Meme / OpenFour" : "Four.Meme" }
        : controller.platform,
      transactionHash: transaction.hash,
      blockNumber: receipt.blockNumber,
      blockHash,
      transactionIndex: Number(receipt.index ?? receipt.transactionIndex ?? 0),
      canonical,
      confirmations,
      requiredConfirmations,
      tokens,
      pools: relevantPools,
      mode: shape,
      structural,
      deployer: transaction.from ? getAddress(transaction.from) : null,
      controllerKind: controller.kind,
      causalTokenEvent: controller.causalTokenEvent,
      officialDiscoveryReplay: entry.reasons?.has?.("official_discovery_replay")
        || entry.reasons?.has?.("fourmeme_feature_replay")
        || entry.reasons?.has?.("flap_feature_replay")
        || [...(entry.reasons || [])].some((reason) => ["official_discovery_replay", "fourmeme_feature_replay", "flap_feature_replay"].includes(reason)),
      launchEvidence: controller.launchEvidence || [],
      security: null,
      sampleToken: tokens[0].token,
      observedAt: transactionObservedAt,
      deliverySla: normalizeBscWebsocketDeliverySla(entry.deliverySla),
    };
  }

  async function attributionFromBscScan(address) {
    const key = address.toLowerCase();
    if (!creationTransactionCache.has(key)) {
      let request;
      request = withBscScanSlot(async () => {
        const response = await fetchImpl(`https://bscscan.com/address/${key}`, {
          headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; BSCLaunchpadMonitor/1.0)" },
          signal: AbortSignal.timeout(config.bscScanTimeoutMs ?? 15_000),
        });
        if (!response?.ok) throw new Error(`BscScan contract creation HTTP ${response?.status ?? "unknown"}`);
        const attribution = parseBscScanAttribution(await response.text());
        if (!attribution.creationTransaction) {
          const error = new Error(`BscScan contract creation evidence missing for ${key}`);
          error.code = "BSC_CREATION_EVIDENCE_PENDING";
          throw error;
        }
        return attribution;
      }).catch((error) => {
        const pending = new Error(`BscScan creation evidence unavailable for ${key}: ${errorSummary(error, 180)}`);
        pending.code = "BSC_CREATION_EVIDENCE_PENDING";
        const retryTimer = setTimeout(() => {
          if (creationTransactionCache.get(key) === request) creationTransactionCache.delete(key);
        }, 15_000);
        retryTimer.unref?.();
        throw pending;
      });
      creationTransactionCache.set(key, request);
    }
    return creationTransactionCache.get(key);
  }

  async function creationTransactionFromBscScan(address) {
    return (await attributionFromBscScan(address)).creationTransaction;
  }

  async function needsTransactionInspection(entry) {
    if (entry.upgradeEmitters?.size) return true;
    if (entry.lifecycleEmitters?.size) return true;
    if (entry.verifiedNewContracts?.size) return true;
    const candidates = [...(entry.mintEmitters || []), ...(entry.candidateTokens || [])];
    if (!candidates.length) return false;
    const unknown = [...new Set(candidates)].filter((address) => !existingMintEmitters.has(address) && !BSC_QUOTE_ASSETS.has(address));
    if (!unknown.length) return false;
    const previousBlock = Math.max(0, Number(entry.blockNumber) - 1);
    const results = await mapLimit(unknown, 8, async (address) => {
      if (entry.verifiedNewContracts?.has(address)) return { address, isNewContract: true };
      try {
        return { address, isNewContract: (await provider.getCode(address, previousBlock)) === "0x" };
      } catch (error) {
        if (!isBscArchiveStateUnavailable(error)) throw error;
        const creationTransaction = await creationTransactionFromBscScan(address);
        return { address, isNewContract: creationTransaction === entry.transactionHash.toLowerCase() };
      }
    });
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    let hasNewContract = false;
    for (const settled of results) {
      const result = settled.value;
      if (result.isNewContract) {
        hasNewContract = true;
        entry.verifiedNewContracts ||= new Set();
        entry.verifiedNewContracts.add(result.address);
      } else existingMintEmitters.add(result.address);
    }
    return hasNewContract;
  }

  function needsEnrichment(observation, snapshot = state) {
    const launcher = snapshot.launchers[observation.launcher.toLowerCase()];
    const tokenKeys = new Set([...(launcher ? Object.keys(launcher.tokens) : []), ...observation.tokens.map((token) => token.token.toLowerCase())]);
    const transactionCount = new Set([...(launcher?.transactions || []), observation.transactionHash]).size;
    const mode = launcher?.modes?.[observation.mode.fingerprint];
    const modeTokens = new Set([...(mode?.tokens || []), ...observation.tokens.map((token) => token.token.toLowerCase())]);
    const modeTransactions = new Set([...(mode?.transactions || []), observation.transactionHash]);
    const modeStructuralTransactions = new Set([...(mode?.structuralTransactions || []), ...(observation.structural?.eligible ? [observation.transactionHash] : [])]);
    const modeCausalTransactions = new Set([...(mode?.causalTransactions || []), ...(observation.causalTokenEvent ? [observation.transactionHash] : [])]);
    const modeMechanismTransactions = new Set([...(mode?.mechanismTransactions || []), ...(observation.structural?.mechanismEvidence ? [observation.transactionHash] : [])]);
    const modeCallers = new Set([...(mode?.callers || []), ...(observation.deployer ? [observation.deployer.toLowerCase()] : [])]);
    const verified = observation.platform?.trust === "official_verified";
    const known = isKnownLaunchRootPlatform(observation.platform);
    const warmedUp = now() - Date.parse(snapshot.initializedAt || 0) >= WARMUP_MS;
    const externalCandidate = snapshot.discoverySources?.external?.contracts?.[observation.launcher.toLowerCase()];
    const officialExternalCandidate = (externalCandidate?.sources || []).some((source) => source.sourceTrust === "official_verified");
    if (flapActivationForObservation(snapshot, observation)
      && observation.causalTokenEvent
      && observation.structural?.eligible) return true;
    if (fourMemeActivationForObservation(snapshot, observation)
      && observation.causalTokenEvent
      && observation.structural?.eligible) return true;
    if (!known
      && warmedUp
      && officialExternalCandidate
      && !launcher?.discoveryAlerted
      && observation.causalTokenEvent
      && observation.structural?.eligible
      && observation.structural?.mechanismEvidence) return true;
    if (verified && warmedUp && observation.platform?.notifyFirstToken && !launcher?.discoveryAlerted && observation.causalTokenEvent) return true;
    if (known && warmedUp && launcher?.baselineModeFingerprint) {
      const alerted = launcher.alertedModes?.includes(observation.mode.fingerprint);
      const currentNovelty = modeComponentNovelty(
        Object.values(launcher.modes || {}).filter((candidate) => candidate.fingerprint !== observation.mode.fingerprint),
        observation.mode,
      );
      if (!mode) return currentNovelty.meaningful;
      if (observation.platform?.id === "flap"
        && !alerted
        && (mode.novelty?.meaningful || currentNovelty.meaningful)
        && modeTokens.size >= 1
        && modeTransactions.size >= 1) return true;
      if (!alerted && mode.novelty?.meaningful && modeTokens.size >= 2 && modeTransactions.size >= 2) return true;
    }
    const unknownConfirmationReady = modeTokens.size >= 2
      && modeTransactions.size >= 2
      && modeStructuralTransactions.size >= 2
      && modeCausalTransactions.size >= 2
      && modeMechanismTransactions.size >= 2
      && modeCallers.size >= 2;
    if (!known && !launcher?.discoveryAlerted && tokenKeys.size >= 2 && transactionCount >= 2 && unknownConfirmationReady) return true;
    if (!known && launcher?.discoveryAlerted && unknownConfirmationReady && !launcher.alertedModes?.includes(observation.mode.fingerprint)) return true;
    return false;
  }

  async function readBinanceTokenRecord(token) {
    try {
      const payload = JSON.parse(await fs.readFile(path.join(config.dataDir, "binance-state.json"), "utf8"));
      return payload?.memeRush?.tokenIndex?.[`56:${token.toLowerCase()}`] || null;
    } catch {
      return null;
    }
  }

  async function fetchJsonBestEffort(url) {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "bsc-launchpad-monitor/0.2" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response?.ok) throw new Error(`${url} HTTP ${response?.status ?? "unknown"}`);
    return JSON.parse(await response.text());
  }

  async function fetchOfficialTokenRecord(platformId, token) {
    let payload;
    let records;
    if (platformId === "hodldance") {
      payload = await fetchJsonBestEffort("https://hodl.dance/api/tokens?sort=newest&limit=20&chainId=56");
      records = payload?.data?.tokens;
    } else if (platformId === "waifufun" || platformId === "flap") {
      payload = await fetchJsonBestEffort(`https://api.waifu.fun/v2/launches/by-token/${token}`);
      records = payload?.data ? [payload.data] : [];
    } else if (platformId === "bullshot") {
      payload = await fetchJsonBestEffort(`https://new.bullshot.org/api/tokens/${token}`);
      records = payload?.address ? [payload] : [];
    } else if (platformId === "rugspull") {
      payload = await fetchJsonBestEffort("https://rugspull.com/api/rugs?chainId=56&limit=25");
      records = payload?.rugs;
    } else if (platformId === "fourmeme") {
      payload = await fetchJsonBestEffort(`${FOUR_MEME_TOKEN_URL}?address=${encodeURIComponent(token)}`);
      if (payload?.code !== 0) throw new Error(`Four.Meme token API code ${payload?.code ?? "unknown"}`);
      records = payload?.data ? [payload.data] : [];
    } else return null;
    if (!Array.isArray(records)) return null;
    const record = records.find((item) => [item?.address, item?.token, item?.tokenAddress, item?.flapTokenAddress].some((address) => String(address || "").toLowerCase() === token.toLowerCase()));
    if (!record) return null;
    let fourMemeTemplate = null;
    if (platformId === "fourmeme" && record.tokenTemplateVo) {
      try {
        [fourMemeTemplate] = parseFourMemeTemplatePayload({ code: 0, data: [record.tokenTemplateVo] });
      } catch {
        // A malformed nested template cannot be used to promote a token into
        // a feature activation; the exact token record remains useful for V3.
      }
    }
    return {
      sourceId: `${platformId}-official-token-api`,
      name: record.name || record.tokenName || record.metadata?.name || null,
      symbol: record.symbol || record.tokenTicker || record.metadata?.symbol || null,
      description: record.description || record.tokenDescription || record.metadata?.description || null,
      website: ![null, "", "null", "undefined"].includes(record.website) ? record.website : (record.metadata?.website || null),
      twitter: ![null, "", "null", "undefined"].includes(record.twitter) ? record.twitter : (record.metadata?.twitter || null),
      telegram: ![null, "", "null", "undefined"].includes(record.telegram) ? record.telegram : (record.metadata?.telegram || null),
      creator: record.creator || record.creatorAddress || null,
      launchType: record.bonding_mc_value != null
        ? `${record.bonding_mc_value} BNB ${record.type || "bond"}`
        : (record.launch_type || record.tierLabel || record.tier || record.type || null),
      state: record.state || record.status || null,
      transactionHash: record.tx || record.createTxHash || null,
      version: /^V?\d+$/i.test(String(record.version || ""))
        ? `V${String(record.version).replace(/^V/i, "")}`.toUpperCase()
        : null,
      networkCode: record.networkCode || null,
      templateId: fourMemeTemplate?.id || null,
      templateFingerprint: fourMemeTemplate?.fingerprint || null,
      template: fourMemeTemplate,
      sourceUrl: platformId === "fourmeme" ? `${FOUR_MEME_TOKEN_URL}?address=${token.toLowerCase()}` : null,
    };
  }

  async function collectExternalAttribution(observation, token, snapshot = state) {
    if (!externalAttributionEnabled) return null;
    const timebox = (request) => Promise.race([
      request,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("external attribution time budget exceeded")), 2_500);
        timer.unref?.();
      }),
    ]);
    const settled = await Promise.allSettled([
      attributionFromBscScan(observation.launcher),
      attributionFromBscScan(token),
      fetchJsonBestEffort(`${DEX_SCREENER_TOKEN_PAIRS_URL}/${token}`).then((payload) => parseDexScreenerTokenPairs(payload, token)),
      fetchJsonBestEffort(`${SOURCIFY_CONTRACT_URL}/${token}?fields=all`),
      readBinanceTokenRecord(token),
      fetchOfficialTokenRecord(observation.platform?.id, token),
    ].map(timebox));
    const value = (index) => settled[index].status === "fulfilled" ? settled[index].value : null;
    return {
      controllerExplorer: value(0),
      tokenExplorer: value(1),
      dex: value(2),
      sourcify: value(3),
      binanceTokenRecord: value(4),
      officialTokenRecord: value(5),
      dappBayRecord: snapshot.discoverySources?.dappBay?.contracts?.[observation.launcher.toLowerCase()]
        || snapshot.discoverySources?.dappBay?.contracts?.[token.toLowerCase()]
        || null,
      externalSourceCandidate: snapshot.discoverySources?.external?.contracts?.[observation.launcher.toLowerCase()] || null,
    };
  }

  function attributionForObservation(observation, external) {
    const binancePlatform = platformForLabel(external?.binanceTokenRecord?.protocolName || external?.binanceTokenRecord?.protocol);
    const explorerSourceFamilyPlatform = external?.controllerExplorer?.verifiedSource
      ? (observation.platform || platformFromVerifiedContractName(external.controllerExplorer.contractName))
      : null;
    const officialExternalSources = (external?.externalSourceCandidate?.sources || []).filter((source) => source.sourceTrust === "official_verified");
    const externalSourceFamilyPlatform = officialExternalSources.length ? external.externalSourceCandidate.platform : null;
    const causalPlatform = observation.platform || externalSourceFamilyPlatform || binancePlatform;
    const verifiedSourceFamilies = [
      explorerSourceFamilyPlatform ? {
        platform: explorerSourceFamilyPlatform,
        address: observation.launcher,
        contractName: external.controllerExplorer.contractName,
        verifiedSource: true,
        sourceId: "bscscan-exact-source",
      } : null,
      ...officialExternalSources.map((source) => ({
        platform: externalSourceFamilyPlatform,
        address: observation.launcher,
        verifiedSource: true,
        sourceId: source.sourceId,
        observedAt: source.observedAt,
        detail: source.sourceUrl,
      })),
    ].filter(Boolean);
    return inferBscLaunchpadAttribution({
      officialFactory: observation.platform?.trust === "official_verified" ? {
        platform: observation.platform,
        address: observation.launcher,
        sourceId: observation.platform.evidenceUrl || "official-contract-inventory",
        blockNumber: observation.blockNumber,
      } : null,
      binanceTokenRecord: external?.binanceTokenRecord ? {
        ...external.binanceTokenRecord,
        platform: binancePlatform || external.binanceTokenRecord.protocolName,
        address: external.binanceTokenRecord.contractAddress,
      } : null,
      verifiedSourceFamilies,
      causalEvidence: observation.causalTokenEvent && causalPlatform ? {
        platform: causalPlatform,
        emitter: observation.launcher,
        blockNumber: observation.blockNumber,
        sourceId: "bsc-transaction-receipt",
        detail: observation.mode?.creationTopics?.join(","),
      } : null,
      externalEvidence: external?.dappBayRecord ? {
        platform: external.dappBayRecord.platform,
        address: external.dappBayRecord.address,
        sourceId: external.dappBayRecord.sourceId,
        detail: "BNB Chain ecosystem directory candidate",
      } : null,
    });
  }

  async function enrich(observation, snapshot = state) {
    const launcher = snapshot.launchers[observation.launcher.toLowerCase()];
    const mode = launcher?.modes?.[observation.mode.fingerprint];
    const current = new Map(observation.tokens.map((token) => [token.token.toLowerCase(), token]));
    const tokenAddresses = [...new Set([...(mode?.tokens || []), ...current.keys()])].slice(-4);
    const assessments = await Promise.all(tokenAddresses.map(async (address) => {
      const currentToken = current.get(address);
      const stored = launcher?.tokens?.[address];
      const token = currentToken?.token || stored?.token || getAddress(address);
      const pools = currentToken ? observation.pools : (stored?.pools || []);
      const [metadata, security] = await Promise.all([
        readTokenMetadata(provider, token, observation.blockNumber, true),
        assessLocalTokenSecurity(provider, token, pools),
      ]);
      return { token, metadata: metadata || currentToken?.metadata || stored?.metadata || null, security, pools };
    }));
    observation.tokenAssessments = assessments;
    for (const token of observation.tokens) {
      const assessment = assessments.find((item) => item.token.toLowerCase() === token.token.toLowerCase());
      if (assessment) token.metadata = assessment.metadata;
    }
    const sample = assessments.find((item) => current.has(item.token.toLowerCase())) || assessments[0];
    observation.security = sample?.security || null;
    observation.sampleToken = sample?.token || observation.tokens[0]?.token || null;
    const external = observation.sampleToken ? await collectExternalAttribution(observation, observation.sampleToken, snapshot) : null;
    if (external) {
      observation.external = external;
      observation.attribution = attributionForObservation(observation, external);
      const socials = external.dex?.socials || {};
      const officialRecord = external.officialTokenRecord || {};
      const sampleToken = observation.tokens.find((item) => item.token.toLowerCase() === observation.sampleToken.toLowerCase());
      if (sampleToken) sampleToken.metadata = {
        ...(sampleToken.metadata || {}),
        name: sampleToken.metadata?.name || officialRecord.name || null,
        symbol: sampleToken.metadata?.symbol || officialRecord.symbol || null,
        description: sampleToken.metadata?.description || officialRecord.description || null,
        website: sampleToken.metadata?.website || officialRecord.website || socials.website || null,
        twitter: sampleToken.metadata?.twitter || officialRecord.twitter || socials.twitter || null,
        telegram: sampleToken.metadata?.telegram || officialRecord.telegram || socials.telegram || null,
      };
      const sampleAssessment = observation.tokenAssessments?.find((item) => item.token.toLowerCase() === observation.sampleToken.toLowerCase());
      if (sampleAssessment && sampleToken) sampleAssessment.metadata = sampleToken.metadata;
      if (["verified", "corroborated"].includes(observation.attribution.status) && observation.attribution.platform) observation.platform = {
        ...(observation.platform || {}),
        ...observation.attribution.platform,
        notifyFirstToken: observation.platform?.notifyFirstToken === true
          || (observation.attribution.status === "corroborated"
            && (external.externalSourceCandidate?.sources || []).some((source) => source.sourceTrust === "official_verified")),
        trust: observation.platform?.trust === "official_shared"
          ? "official_shared"
          : observation.attribution.status === "verified" ? "official_verified" : "multi_source_corroborated",
      };
    } else {
      observation.attribution = inferBscLaunchpadAttribution({
        officialFactory: observation.platform?.trust === "official_verified"
          ? { platform: observation.platform, address: observation.launcher, sourceId: observation.platform.evidenceUrl }
          : null,
        causalEvidence: observation.platform?.trust === "official_shared" && observation.causalTokenEvent
          ? { platform: observation.platform, emitter: observation.launcher, sourceId: "bsc-transaction-receipt" }
          : null,
      });
    }
    return observation;
  }

  function commitDeliveredObservation(draft, event, observation) {
    const launcher = draft.launchers[observation.launcher.toLowerCase()];
    if (!launcher) return;
    if (event.kind === "new_launchpad") launcher.discoveryAlerted = true;
    if (event.kind === "new_mode" && !launcher.alertedModes.includes(observation.mode.fingerprint)) {
      launcher.alertedModes.push(observation.mode.fingerprint);
    }
    if (event.featureActivationKey) {
      const sourceId = event.featurePlatform === "flap" ? "flap" : "fourMeme";
      const activation = draft.officialSources?.[sourceId]?.featureActivations?.[event.featureActivationKey];
      if (activation && !activation.firstTokenAlertedAt) {
        activation.firstTokenAlertedAt = event.blockTimestamp || event.observedAt || iso(now);
        activation.firstTokenTransactionHash = event.transactionHash || null;
        activation.firstToken = event.tokens?.[0]?.token || null;
        activation.replayCompletedAt ||= iso(now);
      }
    }
  }

  async function observeInternal(rawObservation, { persistIrrelevant = true } = {}) {
    await initialize();
    const observation = {
      ...rawObservation,
      transactionHash: normalizeTransactionHash(rawObservation.transactionHash),
      tokens: (rawObservation.tokens || []).map((token) => ({ ...token })),
      pools: (rawObservation.pools || []).map((pool) => ({ ...pool })),
    };
    let enrichmentRevision = null;

    while (true) {
      if (!observation.security && enrichmentRevision === null) {
        const enrichmentPlan = await withState((revision) => {
          if (state.seenTransactions[observation.transactionHash]) return { seen: true };
          return needsEnrichment(observation, state)
            ? { snapshot: structuredClone(state), revision }
            : { snapshot: null };
        });
        if (enrichmentPlan.seen) return null;
        if (enrichmentPlan.snapshot) {
          await enrich(observation, enrichmentPlan.snapshot);
          enrichmentRevision = enrichmentPlan.revision;
        }
      }

      const phase = await withState((revision) => {
        if (state.seenTransactions[observation.transactionHash]) return { done: true, event: null, savePromise: null };
        const causalEntry = {
          transactionHash: observation.transactionHash,
          featureActivationReplayKey: observation.mode?.featureActivationKey || null,
          flapQuoteFirstThreeReplayGenerationKey: observation.flapQuoteFirstThreeReplayGenerationKey || null,
        };
        if (!isDurableCausalGroupHead(causalEntry)) return { causalBlocked: true };
        // Another observation may have reached a confirmation threshold while
        // this one was outside the lock. Re-snapshot and enrich before making
        // a decision rather than evaluating with incomplete safety evidence.
        if (!observation.security
          && needsEnrichment(observation, state)
          && (enrichmentRevision === null || revision > enrichmentRevision + 1)) {
          return { retryEnrichment: structuredClone(state), revision };
        }
        const draft = structuredClone(state);
        const decision = evaluateBscObservation(draft, observation, now());
        draft.seenTransactions[observation.transactionHash] = observation.blockNumber;
        pruneState(draft, now());
        if (!decision) {
          state = draft;
          return {
            done: true,
            event: null,
            savePromise: persistIrrelevant ? save(draft) : null,
          };
        }
        return {
          done: false,
          event: eventFromDecision(decision, observation),
          evaluatedRevision: revision,
        };
      });

      if (phase.retryEnrichment) {
        await enrich(observation, phase.retryEnrichment);
        enrichmentRevision = phase.revision;
        continue;
      }
      if (phase.causalBlocked) {
        const error = new Error(`earlier causal-group candidate is pending before ${observation.transactionHash}`);
        error.code = "BSC_CAUSAL_GROUP_PENDING";
        throw error;
      }
      if (phase.done) {
        if (phase.savePromise) await phase.savePromise;
        return phase.event;
      }

      const delivery = await withEventDelivery(phase.event.eventKey, async () => {
        const causalEntry = {
          transactionHash: observation.transactionHash,
          featureActivationReplayKey: observation.mode?.featureActivationKey || null,
          flapQuoteFirstThreeReplayGenerationKey: observation.flapQuoteFirstThreeReplayGenerationKey || null,
        };
        if (beforeCausalGroupReservation && backgroundFeatureKeys(causalEntry).length) {
          await beforeCausalGroupReservation({
            transactionHash: observation.transactionHash,
            causalKeys: backgroundFeatureKeys(causalEntry),
            claim: "observation",
          });
        }
        const causalReservation = await withState(() => reserveDurableCausalGroups(causalEntry));
        if (!causalReservation) {
          const error = new Error(`causal-group head changed before delivery ${observation.transactionHash}`);
          error.code = "BSC_CAUSAL_GROUP_PENDING";
          throw error;
        }
        try {
          try {
            await alertSender(config, phase.event);
          } catch (error) {
            error.code ||= "ALERT_DELIVERY_PENDING";
            throw error;
          }
          const committed = await withState((revision) => {
            // Never install the pre-delivery draft: state may have advanced while
            // Telegram/external delivery was in flight. Re-evaluate against the
            // latest revision, then commit the exact event key that was delivered.
            const draft = structuredClone(state);
            evaluateBscObservation(draft, observation, now());
            draft.seenTransactions[observation.transactionHash] = observation.blockNumber;
            commitDeliveredObservation(draft, phase.event, observation);
            pruneState(draft, now());
            state = draft;
            return {
              evaluatedRevision: phase.evaluatedRevision,
              committedRevision: revision,
              savePromise: save(draft),
            };
          });
          await committed.savePromise;
          if (onLaunchpadCandidate) void Promise.resolve(onLaunchpadCandidate(phase.event)).catch((error) => logger.error(`[bsc][followup] ${errorSummary(error)}`));
          return phase.event;
        } finally {
          releaseDurableCausalGroups(causalReservation);
        }
      });
      if (delivery.owner) return phase.event;
      // A concurrent transaction delivered the same semantic event. Re-run
      // this observation against its committed state so its evidence/seen key
      // is retained without a duplicate notification.
    }
  }

  function observe(observation, options) {
    return trackObservationProcessor(() => observeInternal(observation, options));
  }

  function canonicalReceiptObservationTime(entry, transaction, receipt, block) {
    const numeric = (value) => {
      if (typeof value === "bigint") return Number(value);
      if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value, 16);
      if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
      return typeof value === "number" ? value : Number.NaN;
    };
    const nonnegative = (value, label) => {
      const parsed = numeric(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        const error = new Error(`BSC receipt causal classification invalid ${label}`);
        error.code = "BSC_RECEIPT_CANONICAL_MISMATCH";
        throw error;
      }
      return parsed;
    };
    const expectedHash = normalizeTransactionHash(entry.transactionHash);
    const expectedBlockNumber = nonnegative(entry.blockNumber, "requested block number");
    const blockNumber = nonnegative(block?.number, "block number");
    const receiptBlockNumber = nonnegative(receipt?.blockNumber, "receipt block number");
    const transactionBlockNumber = nonnegative(transaction?.blockNumber, "transaction block number");
    const blockHash = normalizeTransactionHash(block?.hash);
    const receiptBlockHash = normalizeTransactionHash(receipt?.blockHash);
    const transactionBlockHash = normalizeTransactionHash(transaction?.blockHash);
    const receiptTransactionHash = normalizeTransactionHash(receipt?.hash || receipt?.transactionHash);
    const transactionIndex = nonnegative(
      transaction?.index ?? transaction?.transactionIndex,
      "transaction index",
    );
    const receiptTransactionIndex = nonnegative(
      receipt?.index ?? receipt?.transactionIndex,
      "receipt transaction index",
    );
    const receiptStatus = numeric(receipt?.status);
    if (blockNumber !== expectedBlockNumber
      || receiptBlockNumber !== expectedBlockNumber
      || transactionBlockNumber !== expectedBlockNumber
      || !/^0x[0-9a-f]{64}$/.test(blockHash)
      || receiptBlockHash !== blockHash
      || transactionBlockHash !== blockHash
      || (/^0x[0-9a-f]{64}$/.test(String(entry.blockHash || "").toLowerCase())
        && String(entry.blockHash).toLowerCase() !== blockHash)
      || normalizeTransactionHash(transaction?.hash) !== expectedHash
      || receiptTransactionHash !== expectedHash
      || transactionIndex !== receiptTransactionIndex
      || bscQueuePosition(entry.transactionIndex) !== transactionIndex
      || receiptStatus !== 1) {
      const error = new Error(`BSC receipt causal classification proof mismatch ${expectedHash}`);
      error.code = "BSC_RECEIPT_CANONICAL_MISMATCH";
      throw error;
    }
    if (!Array.isArray(block?.transactions)
      || normalizeTransactionHash(
        typeof block.transactions[transactionIndex] === "string"
          ? block.transactions[transactionIndex]
          : block.transactions[transactionIndex]?.hash,
      ) !== expectedHash) {
      const error = new Error(`BSC receipt causal classification transaction position mismatch ${expectedHash}`);
      error.code = "BSC_RECEIPT_CANONICAL_MISMATCH";
      throw error;
    }
    if (!Array.isArray(receipt?.logs)) {
      const error = new Error(`BSC receipt causal classification invalid logs ${expectedHash}`);
      error.code = "BSC_RECEIPT_CANONICAL_MISMATCH";
      throw error;
    }
    const logIndexes = new Set();
    for (let position = 0; position < receipt.logs.length; position += 1) {
      const log = receipt.logs[position];
      const logIndex = nonnegative(log?.index ?? log?.logIndex, `receipt log ${position} index`);
      const logTransactionIndex = nonnegative(log?.transactionIndex, `receipt log ${position} transaction index`);
      const logBlockNumber = nonnegative(log?.blockNumber, `receipt log ${position} block number`);
      const address = String(log?.address || "").toLowerCase();
      const topics = log?.topics;
      if (!log || log.removed === true
        || logIndexes.has(logIndex)
        || normalizeTransactionHash(log.transactionHash) !== expectedHash
        || normalizeTransactionHash(log.blockHash) !== blockHash
        || logBlockNumber !== expectedBlockNumber
        || logTransactionIndex !== transactionIndex
        || !ADDRESS.test(address)
        || !Array.isArray(topics)
        || topics.some((topic) => !/^0x[0-9a-fA-F]{64}$/.test(String(topic)))
        || typeof log.data !== "string"
        || !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)) {
        const error = new Error(`BSC receipt causal classification log identity mismatch ${expectedHash}#${position}`);
        error.code = "BSC_RECEIPT_CANONICAL_MISMATCH";
        throw error;
      }
      logIndexes.add(logIndex);
    }
    const timestamp = nonnegative(block?.timestamp, "block timestamp");
    return new Date(timestamp * 1_000).toISOString();
  }

  async function commitReceiptCausalClassification(entry, transaction, receipt, block) {
    const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
    const observedAt = canonicalReceiptObservationTime(entry, transaction, receipt, block);
    const bscPools = parseBscPoolLogs(logs);
    const flapCreationCandidates = parseFlapCreationHotCandidates(logs, {
      transactionHash: entry.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: entry.blockNumber,
      transactionIndex: receipt.index ?? receipt.transactionIndex ?? entry.transactionIndex ?? 0,
      observedAt,
      indexedAt: iso(now),
      current: entry.flapQuoteFirstThreeReplayGenerationKey ? null : now(),
      confirmations: Math.max(0, Number(currentHead || 0) - Number(entry.blockNumber)),
      requiredConfirmations: Math.max(0, Number(config.bscConfirmations ?? 2)),
      pools: bscPools,
    });
    const fourMemeCreationCandidates = logs.map((log, logIndex) => fourMemeCreationCandidateFromLog(log, {
      transactionHash: entry.transactionHash,
      blockNumber: entry.blockNumber,
      transactionIndex: receipt.index ?? receipt.transactionIndex ?? entry.transactionIndex ?? 0,
      logIndex,
      observedAt,
    })).filter(Boolean);
    const canClassifyFlap = flapCreationCandidates.length > 0;
    // OpenFour carries preset+quote in the canonical event. Classic manager
    // events need _tokenInfos / official API reads later, so their broad
    // feature barrier cannot be contracted from the receipt alone.
    const canClassifyFour = fourMemeCreationCandidates.some((candidate) =>
      candidate.topic === OPENFOUR_TOKEN_CREATED_TOPIC);
    const hasClassicFour = fourMemeCreationCandidates.some((candidate) =>
      candidate.topic !== OPENFOUR_TOKEN_CREATED_TOPIC);
    const committed = await withState(async () => {
      const pending = state.realtimePendingEntries[entry.transactionHash];
      const deferred = state.deferredCreationEvidence[entry.transactionHash];
      const durableBarrierKeys = normalizeBscCausalBarrierKeys([
        ...(entry.causalBarrierKeys || []),
        ...(pending?.causalBarrierKeys || []),
        ...(deferred?.causalBarrierKeys || []),
      ]);
      const fourFeatureKeys = new Set(Object.keys(state.officialSources?.fourMeme?.featureActivations || {}));
      const liveFirstThree = activeFlapQuoteFirstThreeWindows(state);
      const exactKeys = new Set([
        entry.featureActivationReplayKey,
        pending?.featureActivationReplayKey,
        deferred?.featureActivationReplayKey,
      ].filter(Boolean).map((key) => `feature:${key}`));
      for (const key of [
        entry.flapQuoteFirstThreeReplayGenerationKey,
        pending?.flapQuoteFirstThreeReplayGenerationKey,
        deferred?.flapQuoteFirstThreeReplayGenerationKey,
      ].filter(Boolean)) exactKeys.add(`first3:${key}`);
      const retained = durableBarrierKeys.filter((key) => {
        if (exactKeys.has(key)) return true;
        if (key.startsWith("feature:")) {
          const activationKey = key.slice("feature:".length);
          // Classic Four manager logs prove that this is not Flap, but their
          // receipt does not carry enough template/quote identity to choose a
          // Four activation until the manager read later in preparation.
          return hasClassicFour && fourFeatureKeys.has(activationKey);
        }
        return false;
      });
      const exact = new Set(retained);
      if (canClassifyFlap) {
        for (const [activationKey, activation] of Object.entries(
          state.officialSources?.flap?.featureActivations || {},
        )) {
          if (activation?.active === false || activation.firstTokenAlertedAt
            || activation.firstTokenTransactionHash) continue;
          if (flapCreationCandidates.some((candidate) => flapCandidateMatchesActivation(candidate, activation))) {
            exact.add(`feature:${activationKey}`);
          }
        }
        for (const [generationKey, window] of liveFirstThree) {
          if (flapCreationCandidates.some((candidate) => flapQuoteCandidateAfterActivation(candidate, window)
            && verifiedFlapQuotePair(bscPools, candidate.token, window.quoteAddress))) {
            exact.add(`first3:${generationKey}`);
          }
        }
      }
      if (canClassifyFour) {
        for (const [activationKey, activation] of Object.entries(
          state.officialSources?.fourMeme?.featureActivations || {},
        )) {
          if (activation?.active === false || activation.firstTokenAlertedAt
            || activation.firstTokenTransactionHash) continue;
          if (fourMemeCreationCandidates.some((candidate) => fourMemeCandidateMatchesActivation(candidate, activation))) {
            exact.add(`feature:${activationKey}`);
          }
        }
      }
      const nextBarrierKeys = normalizeBscCausalBarrierKeys([...exact]);
      let evidenceChanged = false;
      for (const candidate of flapCreationCandidates) {
        const key = flapCreationCandidateKey(candidate);
        const previous = entry.flapCreationHotCandidates?.get?.(key);
        const merged = normalizeFlapCreationHotIndex(previous ? [previous, candidate] : [candidate], null)[0];
        entry.flapCreationHotCandidates ||= new Map();
        if (!previous || JSON.stringify(previous) !== JSON.stringify(merged)) evidenceChanged = true;
        entry.flapCreationHotCandidates.set(key, merged);
      }
      for (const candidate of fourMemeCreationCandidates) {
        const key = fourMemeCreationCandidateKey(candidate);
        const previous = entry.fourMemeCreationHotCandidates?.get?.(key);
        const merged = normalizeFourMemeCreationHotIndex(previous ? [previous, candidate] : [candidate], null)[0];
        entry.fourMemeCreationHotCandidates ||= new Map();
        if (!previous || JSON.stringify(previous) !== JSON.stringify(merged)) evidenceChanged = true;
        entry.fourMemeCreationHotCandidates.set(key, merged);
      }
      if (JSON.stringify(nextBarrierKeys) !== JSON.stringify(durableBarrierKeys)
        || JSON.stringify(nextBarrierKeys) !== JSON.stringify(entry.causalBarrierKeys || [])
        || evidenceChanged) {
        entry.causalBarrierKeys = nextBarrierKeys;
        entry.revision = Math.max(
          Number(entry.revision || 0),
          Number(pending?.revision || 0),
          Number(deferred?.revision || 0),
        ) + 1;
      }
      if (pending) state.realtimePendingEntries[entry.transactionHash] = serializeRealtimePendingEntry(entry, pending);
      if (deferred) {
        state.deferredCreationEvidence[entry.transactionHash] = mergeDeferredRecordWithoutAttempt(entry, deferred);
      }
      if (pending || deferred) await save();
      return {
        flapReplayNeeded: false,
        fourMemeReplayKeys: [],
      };
    });
    return {
      bscPools,
      flapCreationCandidates,
      fourMemeCreationCandidates,
      ...committed,
    };
  }

  async function bindObservationCausalKeys(entry, observation, flapCreationCandidates = []) {
    return withState(async () => {
      const featureKey = observation?.mode?.featureActivationKey || null;
      const pending = state.realtimePendingEntries[entry.transactionHash];
      const deferred = state.deferredCreationEvidence[entry.transactionHash];
      const durableBarrierKeys = normalizeBscCausalBarrierKeys([
        ...(entry.causalBarrierKeys || []),
        ...(pending?.causalBarrierKeys || []),
        ...(deferred?.causalBarrierKeys || []),
      ]);
      const authorizedFirstThreeKeys = durableBarrierKeys
        .filter((key) => key.startsWith("first3:"))
        .map((key) => key.slice("first3:".length));
      const firstThreeKeys = entry.flapQuoteFirstThreeReplayGenerationKey
        ? [entry.flapQuoteFirstThreeReplayGenerationKey]
        : [...new Set(
          coarseFlapQuoteFirstThreeMatches(
            state,
            observation,
            flapCreationCandidates,
            authorizedFirstThreeKeys,
          )
            .map((match) => match.generationKey),
        )].sort();
      if (firstThreeKeys.length > 1) {
        const error = new Error(`multiple Flap first-three causal groups matched ${entry.transactionHash}`);
        error.code = "BSC_CAUSAL_GROUP_PENDING";
        throw error;
      }
      const firstThreeKey = firstThreeKeys[0] || null;
      const durableFeatureKey = entry.featureActivationReplayKey
        || pending?.featureActivationReplayKey
        || deferred?.featureActivationReplayKey
        || null;
      const durableFirstThreeKey = entry.flapQuoteFirstThreeReplayGenerationKey
        || pending?.flapQuoteFirstThreeReplayGenerationKey
        || deferred?.flapQuoteFirstThreeReplayGenerationKey
        || null;
      if (durableFeatureKey && featureKey && durableFeatureKey !== featureKey) {
        throw new Error(`feature activation key changed for ${entry.transactionHash}`);
      }
      if (durableFirstThreeKey && firstThreeKey && durableFirstThreeKey !== firstThreeKey) {
        throw new Error(`first-three generation key changed for ${entry.transactionHash}`);
      }
      const nextFeatureKey = durableFeatureKey || featureKey;
      const nextFirstThreeKey = durableFirstThreeKey || firstThreeKey;
      const changed = entry.featureActivationReplayKey !== nextFeatureKey
        || entry.flapQuoteFirstThreeReplayGenerationKey !== nextFirstThreeKey
        || JSON.stringify(entry.causalBarrierKeys || []) !== JSON.stringify(durableBarrierKeys);
      if (changed) {
        entry.featureActivationReplayKey = nextFeatureKey;
        entry.flapQuoteFirstThreeReplayGenerationKey = nextFirstThreeKey;
        // Receipt classification already contracted impossible possibilities.
        // Preserve barriers installed by an activation registration that won
        // this state lock after preparation; clearing them from a stale local
        // entry would let a later candidate overtake.
        entry.causalBarrierKeys = durableBarrierKeys;
        entry.revision = Math.max(
          Number(entry.revision || 0),
          Number(pending?.revision || 0),
          Number(deferred?.revision || 0),
        ) + 1;
        if (pending) state.realtimePendingEntries[entry.transactionHash] = serializeRealtimePendingEntry(entry, pending);
        if (deferred) {
          state.deferredCreationEvidence[entry.transactionHash] = {
            ...deferred,
            featureActivationReplayKey: nextFeatureKey,
            flapQuoteFirstThreeReplayGenerationKey: nextFirstThreeKey,
            causalBarrierKeys: durableBarrierKeys,
            revision: entry.revision,
          };
        }
        if (pending || deferred) await save();
      }
      return isDurableCausalGroupHead(entry);
    });
  }

  async function runProcessEntries(entries, rpcConcurrency = entryRpcConcurrency, {
    preserveRealtimePendingOnFailure = false,
    flapReplaySignal = null,
  } = {}) {
    const boundedRpcConcurrency = Math.max(1, Number(rpcConcurrency) || 1);
    const results = await mapLimit(entries, boundedRpcConcurrency, async (entry) => {
      let revision = Number(entry.revision || 0);
      if (flapReplaySignal) throwIfFlapReplayStopped(flapReplaySignal);
      const needsInspection = flapReplaySignal
        ? await awaitFlapReplayRead(() => needsTransactionInspection(entry), flapReplaySignal)
        : await needsTransactionInspection(entry);
      if (!needsInspection) return { revision, observation: null };
      const websocketProof = websocketProofContexts.get(entry.transactionHash) || null;
      const referenceHead = Math.max(
        Number(currentHead || 0),
        Math.max(0, Number(state.realtimeTailNextBlock || 0) - 1),
      );
      const historical = referenceHead > 0
        && Number(entry.blockNumber) <= referenceHead - realtimeTailMaxLagBlocks;
      // Public realtime RPCs commonly reject finalized objects once they are
      // a few hundred blocks old. Route those entries directly to the archive
      // pool instead of timing out through every standard provider first.
      const getTransaction = historical && provider.getHistoricalTransaction
        ? provider.getHistoricalTransaction.bind(provider)
        : provider.getTransaction.bind(provider);
      const getTransactionReceipt = historical && provider.getHistoricalTransactionReceipt
        ? provider.getHistoricalTransactionReceipt.bind(provider)
        : provider.getTransactionReceipt.bind(provider);
      const transactionAndReceipt = () => Promise.all([
        getTransaction(entry.transactionHash),
        getTransactionReceipt(entry.transactionHash),
      ]);
      const [transaction, receipt] = websocketProof
        ? [websocketProof.transaction, websocketProof.receipt]
        : flapReplaySignal
          ? await awaitFlapReplayRead(transactionAndReceipt, flapReplaySignal)
          : await transactionAndReceipt();
      if (flapReplaySignal) throwIfFlapReplayStopped(flapReplaySignal);
      if (!transaction || !receipt) throw new Error(`missing finalized transaction or receipt ${entry.transactionHash}`);
      const hasOfficialCreation = (receipt.logs || []).some((log) => [
        FLAP_TOKEN_CREATED_TOPIC,
        FLAP_VAULT_TOKEN_CREATED_TOPIC,
        FOUR_MEME_TOKEN_CREATE_TOPIC,
        FOUR_MEME_PRESALE_TOKEN_CREATE_TOPIC,
        OPENFOUR_TOKEN_CREATED_TOPIC,
      ].includes(String(log?.topics?.[0] || "").toLowerCase()));
      const exactCausalKeys = new Set([
        entry.featureActivationReplayKey ? `feature:${entry.featureActivationReplayKey}` : null,
        entry.flapQuoteFirstThreeReplayGenerationKey
          ? `first3:${entry.flapQuoteFirstThreeReplayGenerationKey}` : null,
      ].filter(Boolean));
      const hasPotentialCausalBarrier = (entry.causalBarrierKeys || [])
        .some((key) => !exactCausalKeys.has(key));
      const needsReceiptClassification = hasOfficialCreation || hasPotentialCausalBarrier;
      let receiptClassification = {
        bscPools: parseBscPoolLogs(receipt.logs || []),
        flapCreationCandidates: [],
        fourMemeCreationCandidates: [],
        flapReplayNeeded: false,
        fourMemeReplayKeys: [],
      };
      if (needsReceiptClassification) {
        const canonicalBlock = websocketProof?.block || (flapReplaySignal
          ? await awaitFlapReplayRead(() => cachedBlock(entry.blockNumber), flapReplaySignal)
          : await cachedBlock(entry.blockNumber));
        receiptClassification = await commitReceiptCausalClassification(
          entry,
          transaction,
          receipt,
          canonicalBlock,
        );
        revision = Number(entry.revision || 0);
      }
      registerSingularryCurves(receipt.logs || [], {
        transactionHash: entry.transactionHash,
        blockNumber: entry.blockNumber,
      });
      const bscPools = receiptClassification.bscPools;
      const receiptFlapCreationCandidates = receiptClassification.flapCreationCandidates;
      let observation;
      try {
        if (flapReplaySignal) throwIfFlapReplayStopped(flapReplaySignal);
        // These observers own durable commit boundaries. Once one starts it
        // must finish before cancellation is observed so shutdown cannot cut
        // a state/WAL transaction in half.
        await observeOfficialLifecycle(receipt, entry.blockNumber);
        if (flapReplaySignal) throwIfFlapReplayStopped(flapReplaySignal);
        await observeOfficialUpgrades(receipt, entry.blockNumber);
        if (flapReplaySignal) throwIfFlapReplayStopped(flapReplaySignal);
        const hookPools = bscPools.filter((pool) => pool.verifiedDex && pool.hook && pool.hook.toLowerCase() !== "0x0000000000000000000000000000000000000000");
        let hookEvent = null;
        for (const pool of hookPools) {
          if (flapReplaySignal) throwIfFlapReplayStopped(flapReplaySignal);
          hookEvent ||= await observeVerifiedHook(pool, entry.transactionHash, entry.blockNumber, { transaction, receipt, verifiedNewContracts: entry.verifiedNewContracts });
        }
        if (hookEvent) return {
          revision,
          observation: null,
          flapCreationCandidates: receiptFlapCreationCandidates,
          fourMemeCreationCandidates: receiptClassification.fourMemeCreationCandidates,
          receiptClassificationCommitted: true,
          flapReplayNeeded: receiptClassification.flapReplayNeeded,
          fourMemeReplayKeys: receiptClassification.fourMemeReplayKeys,
        };
        observation = flapReplaySignal
          ? await awaitFlapReplayRead(
            () => prepareTransaction(entry, { transaction, receipt, bscPools }),
            flapReplaySignal,
          )
          : await prepareTransaction(entry, { transaction, receipt, bscPools });
        if (flapReplaySignal) throwIfFlapReplayStopped(flapReplaySignal);
      } catch (error) {
        // Receipt parsing is sufficient to preserve exact Flap creation and
        // quote/vault evidence. Carry it through a later profile/RPC failure so
        // a Board activation can replay the first matching token immediately.
        if (error && typeof error === "object" && receiptFlapCreationCandidates.length) {
          error.flapCreationCandidates = receiptFlapCreationCandidates;
        }
        if (error && typeof error === "object" && needsReceiptClassification) {
          error.receiptClassificationCommitted = true;
          error.flapReplayNeeded = receiptClassification.flapReplayNeeded;
          error.fourMemeReplayKeys = receiptClassification.fourMemeReplayKeys;
        }
        throw error;
      }
      const fourMemeCreationCandidates = receiptClassification.fourMemeCreationCandidates;
      // Flap has no separate archive activation replay lane. Preserve every
      // recently processed exact Flap creation receipt, including near-head
      // gap recovery, so a short WebSocket/RPC outage cannot erase the first
      // token before the Board confirms its new pool.
      const flapCreationCandidates = receiptFlapCreationCandidates;
      const authorizedFirstThreeKeys = (entry.causalBarrierKeys || [])
        .filter((key) => key.startsWith("first3:"))
        .map((key) => key.slice("first3:".length));
      const knownOrdinaryFastPath = observation?.structural?.fastPath === "known_official_mode"
        && observation.officialDiscoveryReplay !== true
        && !flapActivationForObservation(state, observation)
        && !hasFlapQuoteFirstThreeMatch(state, {
          ...observation,
          flapQuoteFirstThreeReplayGenerationKey: entry.flapQuoteFirstThreeReplayGenerationKey || null,
        }, receiptFlapCreationCandidates, authorizedFirstThreeKeys)
        && !fourMemeActivationForObservation(state, observation);
      // A warmed exact identity match has already proven the same controller,
      // token implementation, selector and mode fingerprint. Keep its durable
      // seen key and creation hot-index evidence, but do not clone and grow the
      // multi-megabyte launcher profile for every ordinary Flap/Four token.
      // Any pending official feature activation bypasses this fast exit and
      // still receives the complete security/enrichment path.
      return {
        revision,
        observation: !observation || knownOrdinaryFastPath ? null : {
          ...observation,
          flapQuoteFirstThreeReplayGenerationKey: entry.flapQuoteFirstThreeReplayGenerationKey || null,
        },
        fourMemeCreationCandidates,
        flapCreationCandidates,
        receiptClassificationCommitted: needsReceiptClassification,
        flapReplayNeeded: receiptClassification.flapReplayNeeded,
        fourMemeReplayKeys: receiptClassification.fourMemeReplayKeys,
      };
    });
    // No result below this boundary has mutated the queue/state yet. An
    // aborted replay therefore leaves every candidate in its durable hot
    // index and skips failure/backoff bookkeeping during shutdown.
    if (flapReplaySignal) throwIfFlapReplayStopped(flapReplaySignal);
    const transientRpcFailures = results.filter((result) => result.status === "rejected"
      && result.reason?.code !== "ALERT_DELIVERY_PENDING"
      && isTransientCoverageError(result.reason));
    let globalRpcUnavailable = transientRpcFailures.length > 0
      && transientRpcFailures.every((result) => result.reason?.rpcFailureScope === "host");
    if (transientRpcFailures.length) {
      if (!globalRpcUnavailable) {
        try { await provider.getBlockNumber(); }
        catch { globalRpcUnavailable = true; }
      }
    }
    let retryError = null;
    let stateChanged = false;
    let flapReplayNeeded = false;
    const fourMemeReplayKeys = new Set();
    const dirtyEntries = [];
    const orderedResultIndexes = results.map((_result, index) => index)
      .sort((left, right) => compareBscQueueEntries(entries[left], entries[right]));
    for (const index of orderedResultIndexes) {
      if (flapReplaySignal && (stopped || flapReplaySignal.aborted)) {
        // A prior result may already have installed a valid state mutation.
        // Finish that WAL boundary before honoring cancellation.
        if (stateChanged) await save();
        throwIfFlapReplayStopped(flapReplaySignal);
      }
      const result = results[index];
      const entry = entries[index];
      if (result.status === "rejected") {
        flapReplayNeeded ||= result.reason?.flapReplayNeeded === true;
        for (const key of result.reason?.fourMemeReplayKeys || []) fourMemeReplayKeys.add(key);
        const alertPending = result.reason?.code === "ALERT_DELIVERY_PENDING";
        const creationEvidencePending = result.reason?.code === "BSC_CREATION_EVIDENCE_PENDING";
        const transientRpc = !alertPending && isTransientCoverageError(result.reason);
        const methodScopedRpc = transientRpc
          && !globalRpcUnavailable
          && result.reason?.rpcFailureScope === "method";
        // A WebSocket proof attempt is only an optional latency shortcut. If
        // any later enrichment or safety proof fails, leave the authoritative
        // realtime pending record, retry counters and coverage state exactly
        // as they were so the confirmed HTTP lane can retry normally.
        if (preserveRealtimePendingOnFailure) {
          retryError ||= result.reason;
          continue;
        }
        if (creationEvidencePending) {
          if (entry.deferredEvidence) retryError ||= result.reason;
          else {
            await deferCreationEvidence(entry, result.reason);
            queue.delete(entry.transactionHash);
            logger.error(`[bsc][deferred] ${entry.transactionHash} block=${entry.blockNumber}: ${errorSummary(result.reason)}`);
          }
          continue;
        }
        if (entry.deferredEvidence) {
          retryError ||= result.reason;
          continue;
        }
        if (alertPending || (transientRpc && globalRpcUnavailable)) {
          retryError ||= result.reason;
          continue;
        }
        const deferred = await withState(async () => {
          const previous = state.transactionFailures[entry.transactionHash];
          const failure = {
            blockNumber: entry.blockNumber,
            attempts: Number(previous?.attempts || 0) + 1,
            firstFailureAt: previous?.firstFailureAt || iso(now),
            lastFailureAt: iso(now),
            classification: transientRpc ? "transaction_rpc_transient" : "transaction_error",
            error: String(result.reason?.message || result.reason).slice(0, 300),
          };
          state.transactionFailures[entry.transactionHash] = failure;
          // A method-specific outage (most commonly historical getCode) is not
          // evidence that block/log/receipt discovery is unavailable. Move the
          // exact candidate to the durable retry lane immediately so one state
          // method cannot head-of-line block every later launch. Host-wide 429s
          // still take the shared lane backoff above.
          const minimumAttempts = methodScopedRpc ? 1 : transientRpc ? 8 : 3;
          const minimumAgeMs = methodScopedRpc ? 0 : transientRpc ? 30_000 : 15_000;
          const oldEnough = now() - Date.parse(failure.firstFailureAt) >= minimumAgeMs;
          if (failure.attempts < minimumAttempts || !oldEnough) {
            await save();
            return false;
          }
          const previousDeferred = state.deferredCreationEvidence[entry.transactionHash] || {};
          mergeCurrentDurableEntry(
            entry,
            state.realtimePendingEntries[entry.transactionHash],
            previousDeferred,
          );
          const deferredRecord = {
            ...serializeDeferredEntry(entry, result.reason, {
              ...previousDeferred,
              attempts: Math.max(Number(previousDeferred.attempts || 0), failure.attempts - 1),
            }),
            deferredKind: "coverage_processing",
          };
          state.deferredCreationEvidence[entry.transactionHash] = deferredRecord;
          delete state.realtimePendingEntries[entry.transactionHash];
          const existingGap = (state.coverageGaps || []).find((gap) => gap.transactionHash === entry.transactionHash && !gap.resolvedAt && gap.status !== "resolved");
          const gap = {
            fromBlock: entry.blockNumber,
            toBlock: entry.blockNumber,
            transactionHash: entry.transactionHash,
            detectedAt: existingGap?.detectedAt || iso(now),
            lastFailureAt: iso(now),
            nextAttemptAt: deferredRecord.nextAttemptAt,
            status: "deferred",
            reason: transientRpc ? "transient_transaction_deferred" : "poison_transaction_deferred",
            attempts: failure.attempts,
            error: failure.error,
          };
          if (existingGap) Object.assign(existingGap, gap);
          else state.coverageGaps.push(gap);
          state._health.creationEvidence = {
            status: "deferred",
            checkedAt: iso(now),
            pending: Object.keys(state.deferredCreationEvidence).length,
            lastError: failure.error,
          };
          updateCoverageHealth();
          pruneState(state, now());
          await save();
          return true;
        });
        if (!deferred) {
          retryError ||= result.reason;
          continue;
        }
        queue.delete(entry.transactionHash);
        continue;
      }
      if (Number(entry.revision || 0) !== result.value.revision) {
        dirtyEntries.push(entry);
        continue;
      }
      if (flapReplaySignal) throwIfFlapReplayStopped(flapReplaySignal);
      flapReplayNeeded ||= result.value.flapReplayNeeded === true;
      for (const key of result.value.fourMemeReplayKeys || []) fourMemeReplayKeys.add(key);
      if (result.value.observation) {
        const causalHead = await bindObservationCausalKeys(
          entry,
          result.value.observation,
          result.value.flapCreationCandidates || [],
        );
        if (!causalHead) {
          const error = new Error(`earlier causal-group candidate is pending before ${entry.transactionHash}`);
          error.code = "BSC_CAUSAL_GROUP_PENDING";
          throw error;
        }
        await processFlapQuoteFirstThreeCandidates(
          result.value.observation,
          result.value.flapCreationCandidates || [],
          [
            entry.flapQuoteFirstThreeReplayGenerationKey,
            ...(entry.causalBarrierKeys || [])
              .filter((key) => key.startsWith("first3:"))
              .map((key) => key.slice("first3:".length)),
          ].filter(Boolean),
        );
        await observe(result.value.observation, { persistIrrelevant: false });
      }
      await withState(async () => {
        const fourMemeAppend = appendFourMemeCreationHotIndex(state, result.value.fourMemeCreationCandidates || []);
        for (const key of fourMemeAppend.replayKeys) fourMemeReplayKeys.add(key);
        const flapAppend = appendFlapCreationHotIndex(state, result.value.flapCreationCandidates || []);
        flapReplayNeeded ||= flapAppend.replayNeeded;
        delete state.transactionFailures[entry.transactionHash];
        delete state.deferredCreationEvidence[entry.transactionHash];
        delete state.realtimePendingEntries[entry.transactionHash];
        websocketHttpFallbackRetryAt.delete(entry.transactionHash);
        for (const gap of state.coverageGaps || []) {
          if (gap.transactionHash !== entry.transactionHash || gap.resolvedAt || gap.status === "resolved") continue;
          gap.status = "resolved";
          gap.resolvedAt = iso(now);
        }
        if (!result.value.observation) state.seenTransactions[entry.transactionHash] = entry.blockNumber;
        state.migrationReplayTransactions = (state.migrationReplayTransactions || [])
          .filter((target) => target.transactionHash !== entry.transactionHash);
        state._health.creationEvidence = {
          status: Object.keys(state.deferredCreationEvidence).length ? "deferred" : "healthy",
          checkedAt: iso(now),
          pending: Object.keys(state.deferredCreationEvidence).length,
        };
        updateCoverageHealth();
      });
      stateChanged = true;
      queue.delete(entry.transactionHash);
    }
    if (stateChanged) await save();
    if (flapReplaySignal) throwIfFlapReplayStopped(flapReplaySignal);
    if (flapReplayNeeded && !stopped) void replayPendingFlapActivations();
    if (fourMemeReplayKeys.size) void replayPendingFourMemeActivations([...fourMemeReplayKeys]);
    if (retryError) {
      throw retryError;
    }
    if (dirtyEntries.length) await runProcessEntries(dirtyEntries, boundedRpcConcurrency, {
      preserveRealtimePendingOnFailure,
      flapReplaySignal,
    });
  }

  async function processEntries(entries, rpcConcurrency = entryRpcConcurrency, options = {}) {
    const waits = new Set();
    const claimed = [];
    for (const entry of entries) {
      // Once a fresh candidate owns the single WebSocket proof slot, the
      // normal 25ms confirmed-queue wakeup must not race it and claim the same
      // transaction through slow HTTP. Busy/non-owner candidates are skipped,
      // remain in the durable queue, and are retried after the reservation is
      // released.
      if (websocketProofReservations.has(entry.transactionHash)
        && options.websocketProofOwner !== true) continue;
      const websocketFallbackAt = Number(websocketHttpFallbackRetryAt.get(entry.transactionHash) || 0);
      if (options.websocketProofOwner !== true && websocketFallbackAt > Number(now())) continue;
      if (websocketFallbackAt > 0) websocketHttpFallbackRetryAt.delete(entry.transactionHash);
      const existing = inFlightEntries.get(entry.transactionHash);
      if (existing) waits.add(existing);
      else claimed.push(entry);
    }
    if (claimed.length) {
      let tracked;
      tracked = runProcessEntries(claimed, rpcConcurrency, options).finally(() => {
        for (const entry of claimed) if (inFlightEntries.get(entry.transactionHash) === tracked) inFlightEntries.delete(entry.transactionHash);
      });
      for (const entry of claimed) inFlightEntries.set(entry.transactionHash, tracked);
      waits.add(tracked);
    }
    if (waits.size) await Promise.all(waits);
  }

  async function processEntryBatches(entries, rpcConcurrency = entryRpcConcurrency) {
    for (let index = 0; index < entries.length; index += processBatchSize) {
      await processEntries(entries.slice(index, index + processBatchSize), rpcConcurrency);
    }
  }

  async function retryDeferredCreationEvidence() {
    if (deferredEvidenceRunning || stopped) return;
    deferredEvidenceRunning = true;
    let releaseDeepRpc = null;
    try {
      await initialize();
      let due;
      if (backgroundDeepPriorityEnabled()) {
        const eligibility = backgroundDeepEligibility();
        if (!eligibility.priority.allowFreshDeferred && !eligibility.capacityDependencyUnlock) {
          if (eligibility.priority.tailPriority) scheduleRealtimeTail();
          return { skipped: true, reason: "realtime_priority" };
        }
        const workClass = backgroundDeepTarget(eligibility);
        if (!workClass || backgroundDeepLane(eligibility, workClass) !== "deferred") {
          wakeBackgroundDeepRpc();
          return { skipped: true, reason: "deep_rpc_fairness" };
        }
        due = eligibility.deferred[workClass].slice(0, 1).map((record) => structuredClone(record));
        if (!due.length) {
          wakeBackgroundDeepRpc();
          return { skipped: false, attempted: 0 };
        }
        releaseDeepRpc = acquireBackgroundDeepRpc("deferred", workClass, eligibility);
        if (!releaseDeepRpc) {
          wakeBackgroundDeepRpc(backgroundDeepRpcDelayMs(workClass, eligibility));
          return { skipped: true, reason: "deep_rpc_pacing" };
        }
      } else {
        due = await withState(async () => Object.values(state.deferredCreationEvidence || {})
          .filter((record) => Date.parse(record.nextAttemptAt || 0) <= now())
          .sort((left, right) => Date.parse(left.nextAttemptAt || 0) - Date.parse(right.nextAttemptAt || 0))
          .slice(0, bscScanConcurrency)
          .map((record) => structuredClone(record)));
      }
      if (!due.length) return { skipped: false, attempted: 0 };
      const attempts = await mapLimit(due, backgroundDeepPriorityEnabled() ? 1 : bscScanConcurrency, async (record) => {
        const entry = deserializeDeferredEntry(record);
        try {
          await processEntries([entry]);
          await markBackgroundDeepHostRecovered();
          return;
        } catch (error) {
          await withState(async () => {
            const current = state.deferredCreationEvidence[record.transactionHash];
            if (!current) return;
            if (error?.rpcFailureScope === "host") {
              const providerRetryAfterMs = Number(error?.retryAfterMs);
              const hostRetryDelayMs = Math.max(
                1_000,
                sharedRpcRetryDelayMs(error),
                Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0
                  ? Math.ceil(providerRetryAfterMs)
                  : 0,
              );
              backgroundDeepHostRetryAt = Math.max(
                backgroundDeepHostRetryAt,
                Number(now()) + hostRetryDelayMs,
              );
              state._health.backgroundDeepRpc = {
                status: "backoff",
                checkedAt: iso(now),
                lastErrorAt: iso(now),
                lastError: errorSummary(error),
                rpcFailureScope: "host",
                rpcOperation: error?.rpcOperation || null,
                retryDelayMs: hostRetryDelayMs,
                nextRetryAt: iso(backgroundDeepHostRetryAt),
              };
              // A host-wide outage is not evidence that this candidate's
              // transaction proof failed. Keep its original due time and
              // attempt count so it can resume immediately when the shared
              // physical-host cooldown expires.
              await save();
              return;
            }
            mergeCurrentDurableEntry(
              entry,
              state.realtimePendingEntries[record.transactionHash],
              current,
            );
            const updated = serializeDeferredEntry(entry, error, current);
            state.deferredCreationEvidence[record.transactionHash] = updated;
            state._health.creationEvidence = {
              status: "deferred",
              checkedAt: iso(now),
              pending: Object.keys(state.deferredCreationEvidence).length,
              lastError: updated.lastError,
            };
            for (const gap of state.coverageGaps || []) {
              if (gap.transactionHash !== record.transactionHash || gap.resolvedAt || gap.status === "resolved") continue;
              gap.lastFailureAt = iso(now);
              gap.nextAttemptAt = updated.nextAttemptAt;
              gap.attempts = updated.attempts;
              gap.error = updated.lastError;
            }
            updateCoverageHealth();
            await save();
            if (updated.attempts === 2 || updated.attempts % 5 === 0) logger.error(`[bsc][deferred] retry=${updated.attempts} ${record.transactionHash}: ${updated.lastError}`);
          });
        }
      });
      const failure = attempts.find((result) => result.status === "rejected");
      if (failure) logger.error(`[bsc][deferred] ${errorSummary(failure.reason)}`);
      return { skipped: false, attempted: due.length };
    } finally {
      releaseDeepRpc?.();
      deferredEvidenceRunning = false;
      if (backgroundDeepPriorityEnabled() && !stopped) wakeBackgroundDeepRpc();
    }
  }

  function addNearHeadRecoveryGap(fromBlock, toBlock, reason = "realtime_tail_stale_rebuild") {
    const start = Number(fromBlock);
    const end = Number(toBlock);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return [];

    let uncovered = [[start, end]];
    for (const existing of state.nearHeadRecoveryGaps || []) {
      uncovered = uncovered.flatMap(([left, right]) => {
        if (existing.toBlock < left || existing.fromBlock > right) return [[left, right]];
        const segments = [];
        if (left < existing.fromBlock) segments.push([left, existing.fromBlock - 1]);
        if (right > existing.toBlock) segments.push([existing.toBlock + 1, right]);
        return segments;
      });
      if (!uncovered.length) break;
    }

    const segmented = uncovered.flatMap(([left, right]) => {
      const ranges = [];
      // Split from the head-facing edge so the newest segment is always a
      // complete bounded unit. The scheduler processes segments newest-first,
      // while each segment itself retains ascending block order.
      for (let segmentEnd = right; segmentEnd >= left;) {
        const segmentStart = Math.max(left, segmentEnd - nearHeadRecoverySegmentSize + 1);
        ranges.push([segmentStart, segmentEnd]);
        segmentEnd = segmentStart - 1;
      }
      return ranges;
    });
    const detectedAt = iso(now);
    const added = segmented.map(([left, right]) => ({
      id: `realtime-tail-gap:${left}:${right}`,
      fromBlock: left,
      toBlock: right,
      nextBlock: left,
      reason,
      detectedAt,
      attempts: 0,
      nextAttemptAt: null,
    }));
    if (!added.length) return [];
    const addedBlocks = added.map((gap) => [gap.fromBlock, gap.toBlock]);
    state.nearHeadRecoveryGaps = normalizeNearHeadRecoveryGaps([
      ...(state.nearHeadRecoveryGaps || []),
      ...added,
    ]);
    compactNearHeadRecoveryState();
    return state.nearHeadRecoveryGaps.filter((gap) => addedBlocks.some(([left, right]) => gap.toBlock >= left && gap.nextBlock <= right));
  }

  function compactNearHeadRecoveryState() {
    if (!state) return false;
    const previous = normalizeNearHeadRecoveryGaps(state.nearHeadRecoveryGaps);
    const compacted = compactBscNearHeadRecoveryGaps(previous, nearHeadRecoverySegmentSize);
    if (JSON.stringify(previous) === JSON.stringify(compacted)) {
      state.nearHeadRecoveryGaps = previous;
      return false;
    }
    const priorById = new Map(previous.map((gap) => [gap.id, gap]));
    const remapIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).flatMap((id) => {
      const old = priorById.get(id);
      if (!old) return [];
      return compacted
        .filter((gap) => gap.toBlock >= old.nextBlock && gap.nextBlock <= old.toBlock)
        .map((gap) => gap.id);
    }))];
    const tailHealth = state._health?.realtimeTail;
    if (tailHealth?.handoffGapIds) tailHealth.handoffGapIds = remapIds(tailHealth.handoffGapIds);
    const recoveryHealth = state._health?.nearHeadRecovery;
    if (recoveryHealth?.activeGapId && priorById.has(recoveryHealth.activeGapId)) {
      const mapped = remapIds([recoveryHealth.activeGapId]);
      recoveryHealth.activeGapId = mapped.length === 1 ? mapped[0] : null;
    }
    state.nearHeadRecoveryGaps = compacted;
    return true;
  }

  function migrateLegacyRealtimeTailHandoff() {
    const realtimeTail = state?._health?.realtimeTail;
    if (!realtimeTail || realtimeTail.handoffLane !== "historical_recovery" || realtimeTail.legacyHandoffMigratedAt) return false;
    const legacyFrom = Number(realtimeTail.handoffFromBlock);
    const legacyThrough = Number(realtimeTail.handoffThroughBlock);
    if (!Number.isSafeInteger(legacyFrom) || !Number.isSafeInteger(legacyThrough) || legacyFrom < 0 || legacyThrough < legacyFrom) return false;
    const coveredThrough = state.lastFinalizedBlock === null ? -1 : Number(state.lastFinalizedBlock);
    const migrationFrom = Math.max(legacyFrom, Number.isSafeInteger(coveredThrough) ? coveredThrough + 1 : legacyFrom);
    const added = migrationFrom <= legacyThrough
      ? addNearHeadRecoveryGap(migrationFrom, legacyThrough, "legacy_historical_handoff_migration")
      : [];
    realtimeTail.legacyHandoffMigratedAt = iso(now);
    realtimeTail.legacyHandoffOriginalLane = "historical_recovery";
    realtimeTail.handoffLane = "near_head_recovery";
    realtimeTail.handoffGapIds = added.map((gap) => gap.id);
    realtimeTail.handoffMigrationFromBlock = migrationFrom <= legacyThrough ? migrationFrom : null;
    realtimeTail.handoffMigrationThroughBlock = migrationFrom <= legacyThrough ? legacyThrough : null;
    return true;
  }

  function markLegacyLossyFocus3Coverage() {
    if (!focus3ChainScope) return false;
    const history = Array.isArray(state.coverageRecoveryHistory) ? state.coverageRecoveryHistory : [];
    const lossy = history.filter((entry) => entry?.reason === "focus3_live_baseline_compaction");
    const rawHandoffCompaction = state._health?.realtimeTail?.handoffCompaction;
    const handoffKeys = rawHandoffCompaction && typeof rawHandoffCompaction === "object" && !Array.isArray(rawHandoffCompaction)
      ? Object.keys(rawHandoffCompaction).sort()
      : [];
    const expectedHandoffKeys = [
      "compactedThroughBlock",
      "droppedGapCount",
      "previousLastFinalizedBlock",
      "replayLookbackFromBlock",
      "retainedGapCount",
    ];
    const closedLegacyHandoff = handoffKeys.length === expectedHandoffKeys.length
      && handoffKeys.every((key, index) => key === expectedHandoffKeys[index])
      && Number.isSafeInteger(Number(rawHandoffCompaction.previousLastFinalizedBlock))
      && Number(rawHandoffCompaction.previousLastFinalizedBlock) >= 0
      && Number.isSafeInteger(Number(rawHandoffCompaction.compactedThroughBlock))
      && Number(rawHandoffCompaction.compactedThroughBlock) > Number(rawHandoffCompaction.previousLastFinalizedBlock)
      && Number.isSafeInteger(Number(rawHandoffCompaction.replayLookbackFromBlock))
      && Number(rawHandoffCompaction.replayLookbackFromBlock) >= 0
      && Number(rawHandoffCompaction.replayLookbackFromBlock) <= Number(rawHandoffCompaction.compactedThroughBlock)
      && Number.isSafeInteger(Number(rawHandoffCompaction.droppedGapCount))
      && Number(rawHandoffCompaction.droppedGapCount) > 0
      && Number.isSafeInteger(Number(rawHandoffCompaction.retainedGapCount))
      && Number(rawHandoffCompaction.retainedGapCount) >= 0
      && Number.isSafeInteger(Number(state.lastFinalizedBlock))
      && Number(state.lastFinalizedBlock) >= Number(rawHandoffCompaction.compactedThroughBlock)
      ? {
        previousLastFinalizedBlock: Number(rawHandoffCompaction.previousLastFinalizedBlock),
        compactedThroughBlock: Number(rawHandoffCompaction.compactedThroughBlock),
        replayLookbackFromBlock: Number(rawHandoffCompaction.replayLookbackFromBlock),
        droppedGapCount: Number(rawHandoffCompaction.droppedGapCount),
        retainedGapCount: Number(rawHandoffCompaction.retainedGapCount),
      }
      : null;
    const existingContinuity = state.coverageContinuity?.source === "legacy_focus3_lossy_compaction"
      ? state.coverageContinuity
      : null;
    if (!lossy.length && !closedLegacyHandoff && !existingContinuity) return false;
    const currentCursor = Number(state.lastFinalizedBlock);
    const baseline = Number(state.alertSuppressedThroughBlock);
    const earliestRetainedClaim = Math.min(...lossy
      .map((entry) => Number(entry.previousLastFinalizedBlock))
      .filter((value) => Number.isSafeInteger(value) && value >= 0));
    const abandonedFromBlock = Number.isSafeInteger(baseline) && baseline >= 0
      ? baseline + 1
      : null;
    let changed = false;
    if (!existingContinuity) {
      state.coverageContinuity = {
        version: 1,
        status: "partial_legacy_abandoned",
        source: "legacy_focus3_lossy_compaction",
        recordedAt: iso(now),
        abandonedFromBlock,
        abandonedThroughBlock: closedLegacyHandoff?.previousLastFinalizedBlock
          ?? (Number.isSafeInteger(currentCursor) ? currentCursor : null),
        earliestRetainedCompactionCursor: Number.isSafeInteger(earliestRetainedClaim) ? earliestRetainedClaim : null,
        reason: "legacy compaction discarded uncovered gap records; retained history cannot prove an earlier continuous cursor",
      };
      changed = true;
    }
    if (closedLegacyHandoff && !state.coverageContinuity.latestConservativeRescan) {
      // The final legacy handoff record is a closed, durable proof of the
      // newest discarded interval even though the individual gaps are gone.
      // Reopen that entire interval through the truthful full-history cursor;
      // this is a conservative exact superset and never guesses from the
      // rolling 20-entry diagnostic history.
      state.lastFinalizedBlock = Math.min(
        Number(state.lastFinalizedBlock),
        closedLegacyHandoff.previousLastFinalizedBlock,
      );
      state.coverageContinuity.latestConservativeRescan = {
        version: 1,
        status: "pending",
        source: "legacy_realtime_tail_handoff_compaction",
        recordedAt: iso(now),
        rescanFromBlock: closedLegacyHandoff.previousLastFinalizedBlock + 1,
        rescanThroughBlock: closedLegacyHandoff.compactedThroughBlock,
        ...closedLegacyHandoff,
      };
      state.coverageContinuity.abandonedThroughBlock = closedLegacyHandoff.previousLastFinalizedBlock;
      state.coverageRecoveryHistory = [...state.coverageRecoveryHistory, {
        scheduledAt: iso(now),
        reason: "focus3_latest_lossy_compaction_conservative_reopen",
        fromBlock: closedLegacyHandoff.previousLastFinalizedBlock + 1,
        toBlock: closedLegacyHandoff.compactedThroughBlock,
        previousLastFinalizedBlock: closedLegacyHandoff.previousLastFinalizedBlock,
        droppedGapCount: closedLegacyHandoff.droppedGapCount,
      }].slice(-20);
      changed = true;
    } else if (changed) {
      state.coverageRecoveryHistory = [...state.coverageRecoveryHistory, {
        scheduledAt: iso(now),
        reason: "focus3_legacy_lossy_compaction_marked_partial",
        abandonedFromBlock,
        abandonedThroughBlock: state.coverageContinuity.abandonedThroughBlock,
        earliestRetainedCompactionCursor: state.coverageContinuity.earliestRetainedCompactionCursor,
        droppedGapCount: 0,
      }].slice(-20);
    }
    return changed;
  }

  function dueNearHeadRecoveryGap(referenceTime = now()) {
    if (nearHeadRecoveryRetryAt > referenceTime) return null;
    const due = [...(state.nearHeadRecoveryGaps || [])]
      .filter((gap) => Date.parse(gap.nextAttemptAt || 0) <= referenceTime || !gap.nextAttemptAt)
      .sort((left, right) => right.toBlock - left.toBlock || left.nextBlock - right.nextBlock);
    if (!due.length) return null;
    // Newest-first repairs recent detection gaps quickly, but a steady stream
    // of new handoffs must not starve an older first-token forever.
    return nearHeadNewestSelectionStreak >= 8 ? due.at(-1) : due[0];
  }

  function nextNearHeadRecoveryAttemptAt() {
    const current = Number(now());
    if (nearHeadRecoveryRetryAt > current) return nearHeadRecoveryRetryAt;
    const attempts = (state.nearHeadRecoveryGaps || [])
      .map((gap) => Date.parse(gap.nextAttemptAt || 0))
      .filter((value) => Number.isFinite(value) && value > current);
    return attempts.length ? Math.min(...attempts) : null;
  }

  function ensureRealtimeTailCursor(confirmedHeadBlock) {
    const raw = state.realtimeTailNextBlock;
    const numeric = Number(raw);
    const present = raw !== null && raw !== undefined;
    const recentStart = Math.max(0, confirmedHeadBlock - realtimeTailLookbackBlocks + 1);
    const valid = present
      && Number.isSafeInteger(numeric)
      && numeric >= 0
      && numeric <= confirmedHeadBlock + 1;
    const lagBlocks = valid ? Math.max(0, confirmedHeadBlock - Math.max(0, numeric - 1)) : null;
    const stale = valid && lagBlocks > realtimeTailMaxLagBlocks;
    if (valid && !stale) {
      if (raw !== numeric) state.realtimeTailNextBlock = numeric;
      return raw !== numeric;
    }

    const historicalNextRaw = state.lastFinalizedBlock === null ? 0 : Number(state.lastFinalizedBlock) + 1;
    const historicalNext = Number.isSafeInteger(historicalNextRaw) && historicalNextRaw >= 0
      ? Math.min(historicalNextRaw, confirmedHeadBlock + 1)
      : 0;
    const rebuiltNextBlock = present ? recentStart : Math.max(historicalNext, recentStart);
    const handoffThroughBlock = recentStart - 1;
    const handoffGaps = stale
      ? addNearHeadRecoveryGap(numeric, handoffThroughBlock)
      : [];
    state.realtimeTailNextBlock = rebuiltNextBlock;
    const compaction = focus3ChainScope && handoffGaps.length
      ? compactFocus3LiveCoverageState(state, {
        replayLookbackBlocks: focus3ReplayLookbackBlocks,
        current: now(),
      })
      : { changed: false };
    const retainedGapIds = new Set((state.nearHeadRecoveryGaps || []).map((gap) => gap.id));
    state.realtimeTailInitializedAt ||= iso(now);
    state._health.realtimeTail = {
      ...(state._health.realtimeTail || {}),
      status: "rebuilding",
      checkedAt: iso(now),
      cursorRebuiltAt: iso(now),
      cursorRebuildReason: stale
        ? "cursor_stale_handoff_to_near_head_recovery"
        : present ? "cursor_out_of_confirmed_range" : "cursor_missing",
      previousNextBlock: present ? raw : null,
      nextBlock: rebuiltNextBlock,
      lastSuccessAt: null,
      ...(stale ? {
        previousLagBlocks: lagBlocks,
        handoffFromBlock: numeric,
        handoffThroughBlock,
        handoffLane: "near_head_recovery",
        handoffGapIds: handoffGaps.map((gap) => gap.id).filter((id) => retainedGapIds.has(id)),
        ...(compaction.changed ? {
          handoffCompaction: {
            previousLastFinalizedBlock: compaction.previousLastFinalizedBlock,
            compactedThroughBlock: compaction.tailCovered,
            replayLookbackFromBlock: compaction.retainFromBlock,
            droppedGapCount: compaction.droppedGapCount,
            retainedGapCount: compaction.retainedGapCount,
          },
        } : {}),
      } : {}),
    };
    return true;
  }

  function updateCoverageHealth() {
    const previous = state._health.coverage || {};
    const previousRealtimeTail = state._health.realtimeTail || {};
    const confirmedHeadBlock = Math.max(0, currentHead - (config.bscConfirmations ?? 2));
    const coveredBlock = state.lastFinalizedBlock === null ? null : Number(state.lastFinalizedBlock);
    const realtimeTailCoveredBlock = state.realtimeTailNextBlock === null
      ? null
      : Math.min(confirmedHeadBlock, Math.max(0, Number(state.realtimeTailNextBlock) - 1));
    const lagBlocks = coveredBlock === null ? null : Math.max(0, confirmedHeadBlock - coveredBlock);
    const realtimeTailLagBlocks = realtimeTailCoveredBlock === null ? null : Math.max(0, confirmedHeadBlock - realtimeTailCoveredBlock);
    const lastRealtimeTailSuccess = previousRealtimeTail.lastSuccessAt
      ? Date.parse(previousRealtimeTail.lastSuccessAt)
      : Number.NaN;
    const realtimeTailLastSuccessAgeMs = Number.isFinite(lastRealtimeTailSuccess) && lastRealtimeTailSuccess > 0
      ? Math.max(0, now() - lastRealtimeTailSuccess)
      : null;
    const degradedTailAgeMs = healthDegradedLagBlocks * expectedBlockTimeMs;
    const criticalTailAgeMs = healthCriticalLagBlocks * expectedBlockTimeMs;
    let realtimeTailStatus = previousRealtimeTail.status || "unknown";
    if (previousRealtimeTail.status !== "error") {
      if (realtimeTailLagBlocks === null) realtimeTailStatus = "unknown";
      else if (realtimeTailLagBlocks >= healthCriticalLagBlocks
        || (realtimeTailLastSuccessAgeMs !== null && realtimeTailLastSuccessAgeMs >= criticalTailAgeMs)) realtimeTailStatus = "critical";
      else if (realtimeTailLagBlocks >= healthDegradedLagBlocks
        || (realtimeTailLastSuccessAgeMs !== null && realtimeTailLastSuccessAgeMs >= degradedTailAgeMs)) realtimeTailStatus = "degraded";
      else if (previousRealtimeTail.status === "rebuilding") realtimeTailStatus = "rebuilding";
      else realtimeTailStatus = "healthy";
    }
    state._health.realtimeTail = {
      ...previousRealtimeTail,
      status: realtimeTailStatus,
      healthCheckedAt: iso(now),
      confirmedHeadBlock,
      coveredBlock: realtimeTailCoveredBlock,
      lagBlocks: realtimeTailLagBlocks,
      lagSeconds: realtimeTailLagBlocks === null ? null : Math.ceil((realtimeTailLagBlocks * expectedBlockTimeMs) / 1_000),
      lastSuccessAgeMs: realtimeTailLastSuccessAgeMs,
      degradedLagBlocks: healthDegradedLagBlocks,
      criticalLagBlocks: healthCriticalLagBlocks,
    };
    const nearHeadRecoveryGaps = state.nearHeadRecoveryGaps || [];
    const pendingNearHeadBlocks = nearHeadRecoveryGaps.reduce(
      (total, gap) => total + Math.max(0, Number(gap.toBlock) - Number(gap.nextBlock) + 1),
      0,
    );
    const previousNearHeadRecovery = state._health.nearHeadRecovery || {};
    const nearHeadRecoveryStatus = nearHeadRecoveryGaps.length
      ? (["error", "backoff"].includes(previousNearHeadRecovery.status) ? previousNearHeadRecovery.status : "recovering")
      : "healthy";
    state._health.nearHeadRecovery = {
      ...previousNearHeadRecovery,
      status: nearHeadRecoveryStatus,
      checkedAt: iso(now),
      pendingGapCount: nearHeadRecoveryGaps.length,
      pendingBlockCount: pendingNearHeadBlocks,
      oldestPendingBlock: nearHeadRecoveryGaps.length ? Math.min(...nearHeadRecoveryGaps.map((gap) => Number(gap.nextBlock))) : null,
      newestPendingBlock: nearHeadRecoveryGaps.length ? Math.max(...nearHeadRecoveryGaps.map((gap) => Number(gap.toBlock))) : null,
    };
    const unresolvedCoverageGaps = (state.coverageGaps || []).filter((gap) => !gap?.resolvedAt && gap?.status !== "resolved");
    const unresolvedGapBlocks = unresolvedCoverageGaps
      .map((gap) => Number(gap.fromBlock ?? gap.blockNumber))
      .filter(Number.isFinite);
    const deferredTransactions = Object.keys(state.deferredCreationEvidence || {}).length;
    let status = "unknown";
    if (lagBlocks !== null) {
      if (lagBlocks >= healthCriticalLagBlocks) status = "critical";
      else if (lagBlocks >= healthDegradedLagBlocks) status = "degraded";
      else status = "healthy";
    }
    if (unresolvedCoverageGaps.length || nearHeadRecoveryGaps.length) status = "critical";
    else if (deferredTransactions && status !== "critical") status = "degraded";
    if (state.coverageContinuity?.status === "partial_legacy_abandoned") status = "critical";
    state._health.coverage = {
      status,
      checkedAt: iso(now),
      headBlock: currentHead,
      confirmedHeadBlock,
      coveredBlock,
      realtimeTailCoveredBlock,
      lagBlocks,
      lagSeconds: lagBlocks === null ? null : Math.ceil((lagBlocks * expectedBlockTimeMs) / 1_000),
      unresolvedGapCount: unresolvedCoverageGaps.length,
      nearHeadRecoveryGapCount: nearHeadRecoveryGaps.length,
      nearHeadRecoveryBlockCount: pendingNearHeadBlocks,
      deferredTransactionCount: deferredTransactions,
      oldestUnresolvedBlock: unresolvedGapBlocks.length ? Math.min(...unresolvedGapBlocks) : null,
      estimatedBlockTimeMs: expectedBlockTimeMs,
      degradedLagBlocks: healthDegradedLagBlocks,
      criticalLagBlocks: healthCriticalLagBlocks,
      continuity: state.coverageContinuity?.status || "continuous_from_baseline",
      abandonedFromBlock: state.coverageContinuity?.abandonedFromBlock ?? null,
      abandonedThroughBlock: state.coverageContinuity?.abandonedThroughBlock ?? null,
      legacyConservativeRescanStatus: state.coverageContinuity?.latestConservativeRescan?.status || null,
      legacyConservativeRescanFromBlock: state.coverageContinuity?.latestConservativeRescan?.rescanFromBlock ?? null,
      legacyConservativeRescanThroughBlock: state.coverageContinuity?.latestConservativeRescan?.rescanThroughBlock ?? null,
    };
    return previous.status !== status
      || previousRealtimeTail.status !== realtimeTailStatus
      || Number(previous.unresolvedGapCount || 0) !== unresolvedCoverageGaps.length
      || Number(previous.nearHeadRecoveryGapCount || 0) !== nearHeadRecoveryGaps.length
      || Number(previous.deferredTransactionCount || 0) !== deferredTransactions
      || previous.continuity !== state._health.coverage.continuity;
  }

  function activationReplayFloorBlock(activation, lookbackMs = 0, snapshot = state, { conservative = false } = {}) {
    const activationAt = Date.parse(activation?.firstObservedAt || activation?.confirmedAt || "");
    if (!Number.isFinite(activationAt)) return null;
    const tailAnchorBlock = Number(snapshot?._health?.realtimeTail?.toBlock);
    const tailAnchorAt = Date.parse(snapshot?._health?.realtimeTail?.lastSuccessAt || "");
    const hasTailAnchor = Number.isSafeInteger(tailAnchorBlock)
      && tailAnchorBlock >= 0
      && Number.isFinite(tailAnchorAt);
    // Never combine a newer currentHead with an older tail timestamp. The
    // anchor block/time pair must describe one observation; the conservative
    // safety below mirrors archive replay's boundary tolerance.
    const referenceBlock = hasTailAnchor
      ? tailAnchorBlock
      : Math.max(0, Number(currentHead || 0), Number(snapshot?.realtimeTailNextBlock || 1) - 1);
    const referenceAt = hasTailAnchor ? tailAnchorAt : Number(now());
    const lowerBoundAt = activationAt - Math.max(0, Number(lookbackMs) || 0);
    const distance = Math.max(0, Math.ceil((referenceAt - lowerBoundAt) / expectedBlockTimeMs));
    const safetyBlocks = conservative ? Math.max(240, Math.ceil(distance * 0.05)) : 0;
    return Math.max(0, referenceBlock - distance - safetyBlocks);
  }

  function candidateInActivationBlockWindow(candidate, activation, lookbackMs = 0, snapshot = state, options = {}) {
    const blockNumber = Number(candidate?.blockNumber);
    const floor = activationReplayFloorBlock(activation, lookbackMs, snapshot, options);
    return Number.isSafeInteger(blockNumber) && blockNumber >= 0
      && Number.isSafeInteger(floor)
      && blockNumber >= floor;
  }

  function flapRawCandidateMatchesActivation(candidate, activation) {
    const topic = String(candidate?.topic || "").toLowerCase();
    const launcher = String(candidate?.launcher || "").toLowerCase();
    if (activation?.type === "vault_factory") {
      return topic === FLAP_VAULT_TOKEN_CREATED_TOPIC
        && launcher === FLAP_VAULT_PORTAL_ADDRESS
        && ADDRESS.test(String(activation.vaultFactory || "").toLowerCase())
        && String(candidate?.vaultFactory || "").toLowerCase()
          === String(activation.vaultFactory).toLowerCase();
    }
    if (activation?.type === "quote_pool") {
      const quoteAssets = Array.isArray(candidate?.quoteAssets) ? candidate.quoteAssets : [];
      const quoteAddress = String(activation.quoteAddress || "").toLowerCase();
      return topic === FLAP_TOKEN_CREATED_TOPIC
        && launcher === FLAP_PORTAL_ADDRESS
        && ADDRESS.test(quoteAddress)
        && (!quoteAssets.length || quoteAssets.includes(quoteAddress));
    }
    return false;
  }

  function legacyCausalBarrierKeysForRecord(record) {
    const exact = normalizeBscCausalBarrierKeys([
      record?.featureActivationReplayKey ? `feature:${record.featureActivationReplayKey}` : null,
      record?.flapQuoteFirstThreeReplayGenerationKey
        ? `first3:${record.flapQuoteFirstThreeReplayGenerationKey}`
        : null,
    ].filter(Boolean));
    if (exact.length) return exact;

    const transactionHash = normalizeTransactionHash(record?.transactionHash);
    const blockNumber = Number(record?.blockNumber);
    if (!/^0x[0-9a-f]{64}$/.test(transactionHash)
      || !Number.isSafeInteger(blockNumber)
      || blockNumber < 0) return [];
    const collectionSize = (value) => Array.isArray(value)
      ? value.length
      : value instanceof Set ? value.size : 0;
    const likelyCreation = collectionSize(record?.candidateTokens) > 0
      || collectionSize(record?.verifiedNewContracts) > 0;
    if (!likelyCreation) return [];

    const keys = new Set();
    const unresolved = (activation) => activation
      && activation.active !== false
      && !activation.firstTokenAlertedAt
      && !activation.firstTokenTransactionHash;
    const flapHot = normalizeFlapCreationHotIndex(
      state?.officialSources?.flap?.creationEventHotIndex,
      now(),
    ).filter((candidate) => candidate.transactionHash === transactionHash);
    const fourHot = normalizeFourMemeCreationHotIndex(
      state?.officialSources?.fourMeme?.creationEventHotIndex,
      now(),
    ).filter((candidate) => candidate.transactionHash === transactionHash);
    const hasExactHotIdentity = flapHot.length > 0 || fourHot.length > 0;
    for (const [activationKey, activation] of Object.entries(
      state?.officialSources?.flap?.featureActivations || {},
    )) {
      if (!unresolved(activation)) continue;
      if (flapHot.some((candidate) => flapRawCandidateMatchesActivation(candidate, activation)
        && candidateInActivationBlockWindow(candidate, activation, 0))) {
        keys.add(`feature:${activationKey}`);
      } else if (!hasExactHotIdentity
        && candidateInActivationBlockWindow({ blockNumber }, activation, 0)) {
        keys.add(`feature:${activationKey}`);
      }
    }
    for (const [activationKey, activation] of Object.entries(
      state?.officialSources?.fourMeme?.featureActivations || {},
    )) {
      if (!unresolved(activation)) continue;
      if (fourHot.some((candidate) => fourMemeCandidateMatchesActivation(
        candidate,
        activation,
        { requireEventTime: false },
      ) && candidateInActivationBlockWindow(candidate, activation, 0))) {
        keys.add(`feature:${activationKey}`);
      } else if (!hasExactHotIdentity
        && candidateInActivationBlockWindow({ blockNumber }, activation, 0)) {
        keys.add(`feature:${activationKey}`);
      }
    }
    const position = {
      transactionHash,
      blockNumber,
      transactionIndex: bscQueuePosition(record?.transactionIndex),
      logIndex: bscQueuePosition(record?.logIndex),
    };
    for (const [generationKey, window] of activeFlapQuoteFirstThreeWindows()) {
      if ((window.slots || []).length >= FLAP_QUOTE_FIRST_THREE_TARGET
        || !flapQuoteCandidateAfterActivation(position, window)) continue;
      if (!hasExactHotIdentity || flapHot.some((candidate) => candidate.topic === FLAP_TOKEN_CREATED_TOPIC)) {
        keys.add(`first3:${generationKey}`);
      }
    }
    return normalizeBscCausalBarrierKeys([...keys]);
  }

  function officialCreationHandoffEvidenceForLogs(logs, details = {}) {
    const keys = new Set();
    const observedAt = details.observedAt || iso(now);
    const flapCandidates = parseFlapCreationHotCandidates(logs, {
      ...details,
      observedAt,
      indexedAt: observedAt,
      current: now(),
      pools: [],
    });
    const activationReady = (activation) => Boolean(activation
      && activation.active !== false
      && !activation.firstTokenAlertedAt
      && !activation.firstTokenTransactionHash);

    for (const [activationKey, activation] of Object.entries(
      state?.officialSources?.flap?.featureActivations || {},
    )) {
      if (!activationReady(activation)) continue;
      const possible = flapCandidates.some((candidate) => {
        return flapRawCandidateMatchesActivation(candidate, activation)
          && candidateInActivationBlockWindow(
            candidate,
            activation,
            activation.allowReplay === true ? FLAP_ACTIVATION_REPLAY_LOOKBACK_MS : 0,
            state,
            { conservative: true },
          );
      });
      if (possible) keys.add(`feature:${activationKey}`);
    }

    const fourMemeCandidates = logs
      .map((log) => fourMemeCreationCandidateFromLog(log, { ...details, observedAt }))
      .filter(Boolean);
    for (const [activationKey, activation] of Object.entries(
      state?.officialSources?.fourMeme?.featureActivations || {},
    )) {
      if (!activationReady(activation)) continue;
      if (fourMemeCandidates.some((candidate) => fourMemeCandidateMatchesActivation(
        candidate,
        activation,
        { requireEventTime: false },
      ) && candidateInActivationBlockWindow(
        candidate,
        activation,
        activation.allowReplay === true ? FOUR_MEME_ACTIVATION_REPLAY_LOOKBACK_MS : 0,
        state,
        { conservative: true },
      ))) keys.add(`feature:${activationKey}`);
    }

    for (const [generationKey, window] of activeFlapQuoteFirstThreeWindows()) {
      if ((window.slots || []).length >= FLAP_QUOTE_FIRST_THREE_TARGET) continue;
      if (flapCandidates.some((candidate) => candidate.topic === FLAP_TOKEN_CREATED_TOPIC
        && candidate.launcher === FLAP_PORTAL_ADDRESS
        && flapQuoteCandidateAfterActivation(candidate, window))) {
        keys.add(`first3:${generationKey}`);
      }
    }
    return {
      causalBarrierKeys: normalizeBscCausalBarrierKeys([...keys]),
      flapCandidates,
      fourMemeCandidates,
    };
  }

  function causalBarrierKeysForOfficialLogs(logs, details = {}) {
    return officialCreationHandoffEvidenceForLogs(logs, details).causalBarrierKeys;
  }

  function ingestRecoveryLogs(transactionHash, blockNumber, logs, reason = "gap_recovery", details = {}) {
    registerOfficialChildren(parseRugspullChildren(logs).map((child) => ({ ...child, registeredAt: iso(now) })));
    registerSingularryCurves(logs, { transactionHash, blockNumber });
    const launchTopics = focus3ChainScope ? BSC_FOCUS3_LAUNCH_TOPICS : BSC_LAUNCH_TOPICS;
    const focusLaunchLogs = focus3ChainScope ? logs.filter((log) => launchTopics.includes(log.topics?.[0])) : logs;
    const mintEmitters = focus3ChainScope ? [] : logs.filter(isErc20MintLog).map((log) => log.address.toLowerCase()).filter((address) => !existingMintEmitters.has(address));
    const launchProtocol = focusLaunchLogs.some((log) => launchTopics.includes(log.topics?.[0]));
    const lifecycleEmitters = focus3ChainScope ? [] : logs.filter((log) => Boolean(parseRuntimeOfficialLifecycleLog(log))).map((log) => log.address.toLowerCase());
    const lifecycleProtocol = lifecycleEmitters.length > 0;
    const upgradeEmitters = logs.filter((log) => BSC_UPGRADE_TOPICS.includes(log.topics?.[0]) && runtimeOfficialComponentForAddress(log.address)).map((log) => log.address.toLowerCase());
    const parsedPools = focus3ChainScope && !launchProtocol && !upgradeEmitters.length ? [] : parseBscPoolLogs(logs);
    const exactOfficialTokens = officialCreationEvidenceTokens(focusLaunchLogs);
    const candidateTokens = [
      ...parsedPools.flatMap((pool) => [pool.token0, pool.token1]),
      ...parseKnownBscLaunchTokens(focusLaunchLogs),
    ].filter((address) => !BSC_QUOTE_ASSETS.has(address.toLowerCase()));
    const hookPools = parsedPools.filter((pool) => pool.verifiedDex && pool.hook && pool.hook.toLowerCase() !== "0x0000000000000000000000000000000000000000");
    const transactionIndex = Math.min(
      bscQueuePosition(details.transactionIndex),
      ...logs.map((log) => bscQueuePosition(log.transactionIndex)),
    );
    const logIndex = Math.min(
      bscQueuePosition(details.logIndex),
      ...logs.map((log) => bscQueuePosition(log.logIndex ?? log.index)),
    );
    const blockHashes = [...new Set(logs
      .map((log) => normalizeTransactionHash(log?.blockHash))
      .filter((hash) => /^0x[0-9a-f]{64}$/.test(hash)))];
    if (blockHashes.length > 1) throw new Error(`conflicting canonical block hashes for ${transactionHash}`);
    const blockHash = blockHashes[0] || null;
    const handoffEvidence = focus3ChainScope
      ? officialCreationHandoffEvidenceForLogs(focusLaunchLogs, {
        transactionHash,
        blockHash,
        blockNumber,
        transactionIndex,
        logIndex,
      })
      : { causalBarrierKeys: [], flapCandidates: [], fourMemeCandidates: [] };
    if (mintEmitters.length || launchProtocol || lifecycleProtocol || candidateTokens.length || hookPools.length || upgradeEmitters.length) enqueue(transactionHash, blockNumber, reason, {
      transactionIndex,
      logIndex,
      blockHash,
      mintEmitters,
      candidateTokens,
      verifiedNewContracts: exactOfficialTokens,
      upgradeEmitters,
      lifecycleEmitters,
      hookPools,
      causalBarrierKeys: handoffEvidence.causalBarrierKeys,
      flapCreationHotCandidates: handoffEvidence.flapCandidates,
      fourMemeCreationHotCandidates: handoffEvidence.fourMemeCandidates,
      protocol: launchProtocol || lifecycleProtocol || upgradeEmitters.length > 0,
    });
    return { flapReplayNeeded: false };
  }

  function validateRecoveredBlockBundle(blockNumber, receipts, block) {
    if (!Array.isArray(receipts)) throw new Error(`eth_getBlockReceipts missing block ${blockNumber}`);
    if (!block || Number(block.number) !== blockNumber || !Array.isArray(block.transactions)) {
      throw new Error(`eth_getBlockReceipts cannot verify block ${blockNumber}`);
    }
    const blockHash = block.hash === undefined || block.hash === null
      ? null
      : normalizeTransactionHash(block.hash);
    if (blockHash !== null && !/^0x[0-9a-f]{64}$/.test(blockHash)) {
      throw new Error(`block ${blockNumber} returned a malformed block hash`);
    }
    const blockTransactions = block.transactions.map((transaction) => normalizeTransactionHash(
      typeof transaction === "string" ? transaction : transaction?.hash,
    ));
    if (blockTransactions.some((transactionHash) => !/^0x[0-9a-f]{64}$/.test(transactionHash))) {
      throw new Error(`block ${blockNumber} returned malformed transaction hashes`);
    }
    if (receipts.length !== blockTransactions.length) {
      throw new Error(`eth_getBlockReceipts count mismatch for block ${blockNumber}: receipts=${receipts.length} transactions=${blockTransactions.length}`);
    }
    const expectedTransactions = new Set(blockTransactions);
    const recoveredTransactions = new Set();
    const validatedReceipts = [];
    for (const receipt of receipts) {
      const transactionHash = normalizeTransactionHash(receipt?.transactionHash);
      const receiptBlockNumber = typeof receipt?.blockNumber === "number"
        ? receipt.blockNumber
        : Number.parseInt(receipt?.blockNumber, 16);
      const receiptBlockHash = receipt?.blockHash === undefined || receipt?.blockHash === null
        ? null
        : normalizeTransactionHash(receipt.blockHash);
      if (!expectedTransactions.has(transactionHash)
        || recoveredTransactions.has(transactionHash)
        || receiptBlockNumber !== blockNumber
        || (receiptBlockHash !== null && !/^0x[0-9a-f]{64}$/.test(receiptBlockHash))
        || (blockHash !== null && receiptBlockHash !== null && receiptBlockHash !== blockHash)
        || !Array.isArray(receipt?.logs)) {
        throw new Error(`eth_getBlockReceipts returned malformed block ${blockNumber}`);
      }
      recoveredTransactions.add(transactionHash);
      validatedReceipts.push({
        transactionHash,
        blockNumber: receiptBlockNumber,
        transactionIndex: bscQueuePosition(receipt.transactionIndex ?? receipt.index ?? blockTransactions.indexOf(transactionHash)),
        logs: receipt.logs,
      });
    }
    return validatedReceipts;
  }

  async function readRecoveryBlockBundle(blockNumber, rpc) {
    const [receiptsResult, blockResult] = await Promise.allSettled([
      Promise.resolve().then(() => rpc.send("eth_getBlockReceipts", [hexBlock(blockNumber)])),
      rpc === provider
        ? readBlockCacheGeneration(blockNumber)
        : Promise.resolve().then(() => rpc.getBlock(blockNumber)).then((block) => ({ entry: null, block })),
    ]);
    if (receiptsResult.status === "rejected") throw receiptsResult.reason;
    if (blockResult.status === "rejected") throw blockResult.reason;
    return { receipts: receiptsResult.value, ...blockResult.value };
  }

  async function recoverBlock(blockNumber, reason = "gap_recovery", rpc = provider) {
    let bundle = await readRecoveryBlockBundle(blockNumber, rpc);
    let validatedReceipts;
    try {
      validatedReceipts = validateRecoveredBlockBundle(blockNumber, bundle.receipts, bundle.block);
    } catch (initialError) {
      if (rpc !== provider) throw initialError;
      // A resolved cached block can be null, malformed, or from a fork that
      // disagrees with the receipt set. Replace only the generation we read;
      // concurrent callers join the same HTTP refresh, while a newer verified
      // WebSocket generation wins without being deleted. Re-source receipts
      // with the block exactly once so either side of a short reorg can heal.
      replaceBlockCacheGenerationWithHttp(blockNumber, bundle.entry);
      try {
        bundle = await readRecoveryBlockBundle(blockNumber, rpc);
        validatedReceipts = validateRecoveredBlockBundle(blockNumber, bundle.receipts, bundle.block);
      } catch (refreshError) {
        invalidateBlockCacheGeneration(blockNumber, bundle.entry);
        throw refreshError;
      }
    }
    for (const receipt of validatedReceipts) ingestRecoveryLogs(receipt.transactionHash, receipt.blockNumber, receipt.logs, reason, { transactionIndex: receipt.transactionIndex });
  }

  async function recoverLogRange(fromBlock, toBlock, reason = "gap_recovery", rpc = provider) {
    const range = { fromBlock: hexBlock(fromBlock), toBlock: hexBlock(toBlock) };
    const queryLogFilter = async (filter) => {
      if (filter.address || toBlock - fromBlock + 1 <= BSC_UNSCOPED_LOG_MAX_BLOCKS) {
        return rpc.send("eth_getLogs", [filter]);
      }
      const logs = [];
      // Public Blast accepts addressless topic queries only up to ten blocks.
      // Enforce that boundary here regardless of deployment configuration so
      // widening a tail/history batch cannot silently remove a quorum member.
      for (let start = fromBlock; start <= toBlock; start += BSC_UNSCOPED_LOG_MAX_BLOCKS) {
        const end = Math.min(toBlock, start + BSC_UNSCOPED_LOG_MAX_BLOCKS - 1);
        const batch = await rpc.send("eth_getLogs", [{
          ...filter,
          fromBlock: hexBlock(start),
          toBlock: hexBlock(end),
        }]);
        if (!Array.isArray(batch)) throw new Error(`eth_getLogs missing range ${start}-${end}`);
        logs.push(...batch);
      }
      return logs;
    };
    const [mintLogs, protocolLogBatches] = await Promise.all([
      focus3ChainScope ? Promise.resolve([]) : queryLogFilter({ ...range, topics: [BSC_TRANSFER_TOPIC, BSC_ZERO_TOPIC] }),
      Promise.all(protocolLogFilters(range).map(queryLogFilter)),
    ]);
    if (!Array.isArray(mintLogs)
      || !Array.isArray(protocolLogBatches)
      || protocolLogBatches.some((logs) => !Array.isArray(logs))) {
      throw new Error(`eth_getLogs missing range ${fromBlock}-${toBlock}`);
    }
    const protocolLogs = protocolLogBatches.flat();
    const transactions = new Map();
    for (const log of [...mintLogs, ...protocolLogs]) {
      const transactionHash = String(log.transactionHash || "").toLowerCase();
      const blockNumber = typeof log.blockNumber === "number" ? log.blockNumber : Number.parseInt(log.blockNumber, 16);
      if (!/^0x[0-9a-f]{64}$/.test(transactionHash)
        || !Number.isInteger(blockNumber)
        || blockNumber < fromBlock
        || blockNumber > toBlock
        || log.removed === true) {
        throw new Error(`eth_getLogs returned malformed range data ${fromBlock}-${toBlock}`);
      }
      const record = transactions.get(transactionHash) || { transactionHash, blockNumber, logs: [] };
      record.blockNumber = Math.min(record.blockNumber, blockNumber);
      record.transactionIndex = Math.min(bscQueuePosition(record.transactionIndex), bscQueuePosition(log.transactionIndex));
      record.logIndex = Math.min(bscQueuePosition(record.logIndex), bscQueuePosition(log.logIndex ?? log.index));
      record.logs.push(log);
      transactions.set(transactionHash, record);
    }
    let flapReplayNeeded = false;
    for (const record of [...transactions.values()].sort(compareBscQueueEntries)) {
      const ingested = ingestRecoveryLogs(record.transactionHash, record.blockNumber, record.logs, reason, record);
      flapReplayNeeded ||= Boolean(ingested?.flapReplayNeeded);
    }
    return { flapReplayNeeded };
  }

  async function commitCoveredRange(blockNumber) {
    const entries = [...queue.values()]
      .filter((entry) => entry.blockNumber <= blockNumber && !state.seenTransactions[entry.transactionHash])
      .sort(compareBscQueueEntries);
    if (entries.length && !focus3ChainScope) await processEntryBatches(entries);
    await withState(async () => {
      // Focus3 history uses the same durable handoff boundary as tail and
      // near-head recovery. Log coverage and every discovered candidate are
      // committed together; expensive transaction/code analysis then passes
      // through the single paced background lane instead of bursting inside
      // the history scheduler while the live head continues to move.
      if (focus3ChainScope) persistRealtimePendingHandoff(entries);
      if (Object.keys(state.seenTransactions).length > 21_000) pruneState(state, now());
      state.lastFinalizedBlock = blockNumber;
      const legacyRescan = state.coverageContinuity?.latestConservativeRescan;
      if (legacyRescan?.status === "pending"
        && Number.isSafeInteger(Number(legacyRescan.rescanThroughBlock))
        && blockNumber >= Number(legacyRescan.rescanThroughBlock)) {
        legacyRescan.status = "rescanned";
        legacyRescan.completedAt = iso(now);
        legacyRescan.coveredThroughBlock = blockNumber;
        state.coverageRecoveryHistory = [...(state.coverageRecoveryHistory || []), {
          scheduledAt: iso(now),
          reason: "focus3_latest_lossy_compaction_conservative_rescan_completed",
          fromBlock: legacyRescan.rescanFromBlock,
          toBlock: legacyRescan.rescanThroughBlock,
        }].slice(-20);
      }
      state.nearHeadRecoveryGaps = (state.nearHeadRecoveryGaps || []).flatMap((gap) => {
        if (gap.toBlock <= blockNumber) return [];
        if (gap.nextBlock <= blockNumber) return [{ ...gap, nextBlock: blockNumber + 1 }];
        return [gap];
      });
      if (!state.nearHeadRecoveryGaps.length) {
        state._health.nearHeadRecovery = {
          ...(state._health.nearHeadRecovery || {}),
          status: "healthy",
          checkedAt: iso(now),
          consecutiveFailures: 0,
          activeGapId: null,
        };
        delete state._health.nearHeadRecovery.lastError;
        delete state._health.nearHeadRecovery.lastErrorAt;
        delete state._health.nearHeadRecovery.nextRetryAt;
      }
      coverageRetryAt = 0;
      state._health.rpc = { status: "healthy", consecutiveFailures: 0, checkedAt: iso(now), lastSuccessAt: iso(now), blockNumber };
      updateCoverageHealth();
      await save();
    });
    if (focus3ChainScope && entries.length) scheduleRealtime();
  }

  async function advanceCoverage() {
    if (coverageRunning || !state) return;
    if (coverageRetryAt > Date.now()) {
      scheduleCoverage();
      return;
    }
    const confirmed = Math.max(0, currentHead - (config.bscConfirmations ?? 2));
    const realtimeTailBehind = Number(state.realtimeTailNextBlock) <= confirmed;
    const deepPriority = currentDeepRpcPriority();
    if (focus3ChainScope && !deepPriority.tailReady) {
      // Full-history reads share every physical host used by the isolated
      // realtime pool. Never let an error/rebuild state (or more than twenty
      // missing blocks) spend those hosts while the first-detection cursor is
      // behind. The range remains wholly below lastFinalizedBlock until a
      // later turn, so this is delay-only and cannot create false coverage.
      scheduleRealtimeTail();
      scheduleCoverage(BSC_DEEP_RPC_PACE_MS);
      return;
    }
    const historyBackpressure = state._health?.rpc?.backpressureReason;
    if (focus3ChainScope && historyBackpressure === "realtime_pending_capacity") {
      // Re-reading the same history range cannot create capacity. Let one
      // already-durable transaction vacate the queue, then the successful
      // processor wakeup will pre-empt this conservative deadline.
      wakeBackgroundDeepRpc();
      scheduleCoverage(BSC_DEEP_RPC_OLD_WITH_GAPS_PACE_MS);
      return;
    }
    const dueNearHeadGap = Boolean(dueNearHeadRecoveryGap());
    if ((state.nearHeadRecoveryGaps || []).length) {
      if (realtimeTailBehind) scheduleRealtimeTail();
      scheduleNearHeadRecovery();
      // Interleave one truthful full-history batch after a bounded number of
      // near-head attempt slots. Counting failures as well as successes keeps
      // a stream of method-specific poison gaps from starving history forever.
      if (nearHeadRecoveryRunning
        || (dueNearHeadGap && nearHeadRecoveryAttemptsSinceCoverage < BSC_NEAR_HEAD_ATTEMPTS_PER_HISTORICAL_BATCH)) {
        scheduleCoverage(250);
        return;
      }
    }
    coverageRunning = true;
    let failurePhase = "range_recovery";
    try {
      if (!stopped && Number(state.lastFinalizedBlock || 0) < desiredCoverage) {
        // Spending the slot means a real history attempt, whether it succeeds
        // or not. A method-specific archive failure must not then freeze the
        // live repair lane until the history retry deadline.
        if ((state.nearHeadRecoveryGaps || []).length) nearHeadRecoveryAttemptsSinceCoverage = 0;
        if (state.lastFinalizedBlock === null) {
          await withState(async () => {
            state.lastFinalizedBlock = desiredCoverage;
            state.initializedAt ||= iso(now);
            updateCoverageHealth();
            await save();
          });
          return;
        }
        const from = Number(state.lastFinalizedBlock) + 1;
        const batchSize = Math.min(recoveryLogBatchSize, Math.max(1, config.bscMaxCatchupBlocks || 240));
        const batchEnd = Math.min(desiredCoverage, from + batchSize - 1);
        try {
          await recoverLogRange(from, batchEnd);
        } catch (rangeError) {
          // A typed host-wide cooldown (notably HTTP 429) applies to receipts
          // as well as logs. Preserve the provider deadline instead of
          // multiplying the outage into one fallback request per block.
          if (sharedRpcRetryDelayMs(rangeError) > 0) throw rangeError;
          const blockNumbers = Array.from({ length: batchEnd - from + 1 }, (_, index) => from + index);
          const recovered = await mapLimit(blockNumbers, recoveryBlockConcurrency, recoverBlock);
          const failed = recovered.find((result) => result.status === "rejected");
          if (isBlockCacheStoppedError(failed?.reason)) throw failed.reason;
          if (failed) {
            const failure = new Error(`range recovery failed: ${errorSummary(rangeError)}; block fallback failed: ${errorSummary(failed.reason)}`);
            failure.code = failed.reason?.code || rangeError?.code;
            failure.rpcFailureScope = failed.reason?.rpcFailureScope || rangeError?.rpcFailureScope;
            failure.rpcOperation = failed.reason?.rpcOperation || rangeError?.rpcOperation;
            const retryAfterMs = Math.max(Number(rangeError?.retryAfterMs) || 0, Number(failed.reason?.retryAfterMs) || 0);
            if (retryAfterMs > 0) failure.retryAfterMs = retryAfterMs;
            throw failure;
          }
        }
        failurePhase = "entry_processing";
        await commitCoveredRange(batchEnd);
        failurePhase = "range_recovery";
        if (Number(state.lastFinalizedBlock) >= recoveryTarget) recoveryTarget = 0;
      }
    } catch (error) {
      if (stopped && isBlockCacheStoppedError(error)) return;
      await withState(async () => {
        const health = state._health.rpc || { consecutiveFailures: 0 };
        const consecutiveFailures = Number(health.consecutiveFailures || 0) + 1;
        const handoffCapacity = isBscDurableHandoffCapacityError(error);
        const retryDelayMs = handoffCapacity
          ? BSC_DEEP_RPC_OLD_WITH_GAPS_PACE_MS
          : failurePhase === "range_recovery"
          ? Math.min(
            coverageRetryMaxMs,
            coverageRetryBaseMs * (2 ** Math.min(consecutiveFailures - 1, 10)),
          )
          : 150;
        coverageRetryAt = Date.now() + retryDelayMs;
        state._health.rpc = {
          ...health,
          status: "error",
          checkedAt: iso(now),
          lastErrorAt: iso(now),
          lastError: errorSummary(error),
          consecutiveFailures,
          failurePhase,
          retryDelayMs,
          nextRetryAt: iso(now() + retryDelayMs),
          ...(handoffCapacity ? {
            backpressureReason: error.rangeExceedsCapacity === true
              ? "realtime_range_exceeds_pending_capacity"
              : "realtime_pending_capacity",
          } : {}),
        };
        if (!handoffCapacity) delete state._health.rpc.backpressureReason;
        updateCoverageHealth();
        await save().catch(() => {});
      });
      logger.error(`[bsc][rpc] ${errorSummary(error)}`);
    } finally {
      coverageRunning = false;
      if (!stopped && Number(state.lastFinalizedBlock || 0) < desiredCoverage) scheduleCoverage();
      if (!stopped && (state.nearHeadRecoveryGaps || []).length) scheduleNearHeadRecovery();
    }
  }

  function scheduleCoverage(minDelayMs = 150) {
    if (stopped) return;
    const confirmed = Math.max(0, currentHead - (config.bscConfirmations ?? 2));
    desiredCoverage = Math.max(desiredCoverage, confirmed);
    recoveryTarget = Math.max(recoveryTarget, confirmed);
    const current = Date.now();
    const delay = Math.max(minDelayMs, coverageRetryAt - current);
    const dueAt = current + delay;
    if (coverageTimer) {
      if (dueAt >= coverageTimerDueAt) return;
      clearTimeout(coverageTimer);
    }
    coverageTimerDueAt = dueAt;
    coverageTimer = setTimeout(() => {
      coverageTimer = null;
      coverageTimerDueAt = 0;
      void advanceCoverage();
    }, delay);
    coverageTimer.unref?.();
  }

  async function processRealtimeQueue() {
    if (realtimeRunning || !state || stopped) return;
    const current = Number(now());
    if (realtimeRetryAt > current) {
      scheduleRealtime(realtimeRetryAt - current);
      if (focus3ChainScope) wakeBackgroundDeepRpc();
      return;
    }
    realtimeRunning = true;
    let retryDelayMs = 25;
    let releaseDeepRpc = null;
    try {
      const durableTailConfirmed = Number.isSafeInteger(Number(state.realtimeTailNextBlock))
        ? Math.max(0, Number(state.realtimeTailNextBlock) - 1)
        : 0;
      const confirmed = Math.max(0, currentHead - (config.bscConfirmations ?? 2), durableTailConfirmed);
      // Keep first-launch/mode ordering inside each lane, but never let a large
      // historical gap-recovery queue starve confirmed WebSocket observations.
      let queuedEntries;
      if (backgroundDeepPriorityEnabled()) {
        const eligibility = backgroundDeepEligibility(current);
        if (!eligibility.priority.allowFreshQueue) {
          retryDelayMs = BSC_DEEP_RPC_PACE_MS;
          if (eligibility.priority.tailPriority) scheduleRealtimeTail();
          return;
        }
        const workClass = backgroundDeepTarget(eligibility);
        if (!workClass || backgroundDeepLane(eligibility, workClass) !== "realtime") {
          retryDelayMs = backgroundDeepRpcDelayMs(workClass, eligibility);
          wakeBackgroundDeepRpc(retryDelayMs);
          return;
        }
        queuedEntries = eligibility.realtime[workClass].slice(0, 1);
        if (!queuedEntries.length) {
          retryDelayMs = BSC_DEEP_RPC_PACE_MS;
          wakeBackgroundDeepRpc();
          return;
        }
        releaseDeepRpc = acquireBackgroundDeepRpc("realtime", workClass, eligibility);
        if (!releaseDeepRpc) {
          retryDelayMs = backgroundDeepRpcDelayMs(workClass, eligibility);
          wakeBackgroundDeepRpc(retryDelayMs);
          return;
        }
      } else {
        queuedEntries = [...queue.values()].filter((entry) =>
          Number(websocketHttpFallbackRetryAt.get(entry.transactionHash) || 0) <= current);
      }
      const processLimit = backgroundDeepPriorityEnabled() ? 1 : bscRealtimeProcessLimit(queuedEntries, confirmed, state.seenTransactions, {
        nearHeadWindowBlocks: realtimeTailLookbackBlocks,
        normalLimit: processBatchSize,
        backlogLimit: backlogProcessBatchSize,
      });
      const entries = backgroundDeepPriorityEnabled() ? queuedEntries : selectBscRealtimeEntries(
        queuedEntries,
        confirmed,
        state.seenTransactions,
        processLimit,
        realtimeTailLookbackBlocks,
      );
      if (entries.length) {
        await processEntries(entries, backgroundDeepPriorityEnabled() ? 1 : entryRpcConcurrency);
        if (backgroundDeepPriorityEnabled()) await markBackgroundDeepHostRecovered();
        if (backgroundDeepPriorityEnabled()) {
          retryDelayMs = backgroundDeepRpcDelayMs();
          if (state._health?.rpc?.backpressureReason === "realtime_pending_capacity"
            && Object.keys(state.realtimePendingEntries || {}).length < realtimePendingMaxEntries) {
            coverageRetryAt = 0;
            scheduleCoverage(BSC_DEEP_RPC_PACE_MS);
          }
          if (state._health?.realtimeTail?.backpressureReason === "realtime_pending_capacity") {
            realtimeTailRetryAt = 0;
            scheduleRealtimeTail(BSC_DEEP_RPC_PACE_MS);
          }
        }
      }
      if (entries.length && (realtimeRetryAt > 0 || state._health?.realtimeQueue?.status === "backoff")) {
        realtimeRetryAt = 0;
        await withState(async () => {
          const previous = state._health.realtimeQueue || {};
          state._health.realtimeQueue = {
            ...previous,
            status: "healthy",
            checkedAt: iso(now),
            lastSuccessAt: iso(now),
            consecutiveFailures: 0,
            nextRetryAt: null,
            retryDelayMs: null,
          };
          delete state._health.realtimeQueue.lastError;
          delete state._health.realtimeQueue.lastErrorAt;
          await save();
        });
        resetRealtimeFailureLog();
      }
    } catch (error) {
      const providerRetryAfterMs = Number(error?.retryAfterMs);
      retryDelayMs = Math.max(
        1_000,
        sharedRpcRetryDelayMs(error),
        Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0 ? Math.ceil(providerRetryAfterMs) : 0,
      );
      const failedAt = Number(now());
      realtimeRetryAt = Math.max(realtimeRetryAt, failedAt + retryDelayMs);
      await withState(async () => {
        if (error?.rpcFailureScope === "host") {
          backgroundDeepHostRetryAt = Math.max(backgroundDeepHostRetryAt, failedAt + retryDelayMs);
          state._health.backgroundDeepRpc = {
            status: "backoff",
            checkedAt: iso(failedAt),
            lastErrorAt: iso(failedAt),
            lastError: errorSummary(error),
            rpcFailureScope: "host",
            rpcOperation: error?.rpcOperation || null,
            retryDelayMs,
            nextRetryAt: iso(backgroundDeepHostRetryAt),
          };
        }
        const previous = state._health.realtimeQueue || { consecutiveFailures: 0 };
        state._health.realtimeQueue = {
          ...previous,
          status: "backoff",
          checkedAt: iso(failedAt),
          lastErrorAt: iso(failedAt),
          lastError: errorSummary(error),
          consecutiveFailures: Number(previous.consecutiveFailures || 0) + 1,
          retryDelayMs,
          nextRetryAt: iso(realtimeRetryAt),
        };
        await save().catch(() => {});
      });
      logRealtimeFailure(error);
    } finally {
      releaseDeepRpc?.();
      realtimeRunning = false;
      if (backgroundDeepPriorityEnabled()) {
        if (!stopped) {
          const retryRemaining = Math.max(0, realtimeRetryAt - Number(now()));
          const hasDurableRealtimeWork = [...queue.values()].some((entry) =>
            Boolean(state?.realtimePendingEntries?.[entry.transactionHash])
            && !state?.seenTransactions?.[entry.transactionHash]);
          // Eligibility intentionally hides the realtime lane while its retry
          // deadline is active. Install that deadline explicitly; otherwise a
          // 60s head-poll interval could strand a 1s retry indefinitely.
          if (retryRemaining > 0 && hasDurableRealtimeWork) scheduleRealtime(retryRemaining);
          wakeBackgroundDeepRpc(retryDelayMs);
        }
      } else {
        const durableTailConfirmed = Number.isSafeInteger(Number(state.realtimeTailNextBlock))
          ? Math.max(0, Number(state.realtimeTailNextBlock) - 1)
          : 0;
        const confirmed = Math.max(0, currentHead - (config.bscConfirmations ?? 2), durableTailConfirmed);
        const pendingEntries = [...queue.values()].filter((entry) =>
          Number(entry.blockNumber) <= confirmed && !state.seenTransactions[entry.transactionHash]);
        const hasReadyEntry = pendingEntries.some((entry) =>
          Number(websocketHttpFallbackRetryAt.get(entry.transactionHash) || 0) <= Number(now()));
        const nextWebsocketFallbackAt = Math.min(...pendingEntries
          .map((entry) => Number(websocketHttpFallbackRetryAt.get(entry.transactionHash) || 0))
          .filter((value) => value > Number(now())));
        if (hasReadyEntry && !stopped) scheduleRealtime(retryDelayMs);
        else if (Number.isFinite(nextWebsocketFallbackAt) && !stopped) {
          scheduleRealtime(Math.max(25, nextWebsocketFallbackAt - Number(now())));
        }
      }
    }
  }

  function scheduleRealtime(delay = 25) {
    if (stopped || realtimeRunning) return;
    const current = Number(now());
    const retryDelay = Math.max(0, realtimeRetryAt - current);
    const deepRpcDelay = backgroundDeepPriorityEnabled() ? backgroundDeepRpcDelayMs() : 0;
    const effectiveDelay = Math.max(25, Number(delay) || 25, retryDelay, deepRpcDelay);
    const dueAt = current + effectiveDelay;
    if (realtimeTimer) {
      // A pre-readiness attempt may have installed a long wakeup. The second
      // consecutive healthy tail batch is authoritative new information, so
      // let its earlier fresh-work deadline replace that stale timer.
      if (dueAt >= realtimeTimerDueAt) return;
      backgroundClearTimeout(realtimeTimer);
    }
    realtimeTimerDueAt = dueAt;
    realtimeTimer = backgroundSetTimeout(() => {
      realtimeTimer = null;
      realtimeTimerDueAt = 0;
      void processRealtimeQueue();
    }, effectiveDelay);
    realtimeTimer.unref?.();
  }

  async function scanRealtimeTail() {
    if (realtimeTailRunning || stopped) return { skipped: true };
    realtimeTailRunning = true;
    let shouldContinue = false;
    try {
      await initialize();
      if (realtimeTailRetryAt > Number(now())) {
        shouldContinue = true;
        return { skipped: true, reason: "backoff", nextRetryAt: iso(realtimeTailRetryAt) };
      }
      const confirmed = Math.max(0, currentHead - (config.bscConfirmations ?? 2));
      let cursorRebuilt = false;
      await withState(async () => {
        cursorRebuilt = ensureRealtimeTailCursor(confirmed);
        if (cursorRebuilt) {
          updateCoverageHealth();
          await save();
        }
      });
      if (cursorRebuilt) resetRealtimeTailDeepReadiness();
      const fromBlock = Number(state.realtimeTailNextBlock);
      if (fromBlock > confirmed) {
        await withState(async () => {
          const previous = state._health.realtimeTail || { consecutiveFailures: 0 };
          if (previous.status === "healthy") return;
          state._health.realtimeTail = {
            ...previous,
            status: "healthy",
            checkedAt: iso(now),
            lastSuccessAt: iso(now),
            consecutiveFailures: 0,
            nextBlock: fromBlock,
          };
          delete state._health.realtimeTail.lastError;
          delete state._health.realtimeTail.lastErrorAt;
          delete state._health.realtimeTail.backpressureReason;
          delete state._health.realtimeTail.pendingEntryCount;
          delete state._health.realtimeTail.newEntryCount;
          delete state._health.realtimeTail.pendingEntryCapacity;
          updateCoverageHealth();
          await save();
        });
        recordRealtimeTailDeepReadiness();
        if (focus3ChainScope) scheduleRealtime();
        scheduleNearHeadRecovery();
        resetTailFailureLog();
        return { skipped: false, fromBlock, toBlock: null };
      }
      const toBlock = Math.min(confirmed, fromBlock + realtimeTailBatchSize - 1);
      // Keep the realtime lane bounded. A failed range remains behind the
      // durable cursor and is retried after backoff; synchronously expanding
      // it into ten full receipt scans can stall first detection for 20-30s
      // on public RPCs. The WebSocket lane remains live during this retry.
      const recovered = await recoverLogRange(fromBlock, toBlock, "http_tail", realtimeProvider);
      const entries = [...queue.values()]
        .filter((entry) => entry.blockNumber >= fromBlock
          && entry.blockNumber <= toBlock
          && entry.reasons.has("http_tail")
          && !state.seenTransactions[entry.transactionHash])
        .sort(compareBscQueueEntries);
      await withState(async () => {
        // Persist every candidate in the same atomic commit as the cursor.
        // Deep contract/security analysis then runs independently, so one
        // busy token cannot prevent the tail from covering later blocks. A
        // restart restores these entries before any cursor work resumes.
        persistRealtimePendingHandoff(entries);
        state.realtimeTailNextBlock = toBlock + 1;
        state.realtimeTailInitializedAt ||= iso(now);
        const previous = state._health.realtimeTail || {};
        state._health.realtimeTail = {
          ...previous,
          status: toBlock < confirmed ? "rebuilding" : "healthy",
          checkedAt: iso(now),
          lastSuccessAt: iso(now),
          consecutiveFailures: 0,
          fromBlock,
          toBlock,
          nextBlock: toBlock + 1,
        };
        delete state._health.realtimeTail.lastError;
        delete state._health.realtimeTail.lastErrorAt;
        delete state._health.realtimeTail.nextRetryAt;
        delete state._health.realtimeTail.retryDelayMs;
        delete state._health.realtimeTail.backpressureReason;
        delete state._health.realtimeTail.pendingEntryCount;
        delete state._health.realtimeTail.newEntryCount;
        delete state._health.realtimeTail.pendingEntryCapacity;
        updateCoverageHealth();
        await save();
      });
      recordRealtimeTailDeepReadiness();
      if (entries.length || focus3ChainScope) scheduleRealtime();
      if (recovered.flapReplayNeeded) void replayPendingFlapActivations();
      resetTailFailureLog();
      realtimeTailRetryAt = 0;
      shouldContinue = toBlock < confirmed;
      // The tail and near-head lanes use separate RPC pools. Give the repair
      // scheduler a chance after every durable tail batch. The recovery lane
      // starts only inside the short live window defined above; requiring an
      // exact catch-up window on a sub-second chain can starve it indefinitely.
      scheduleNearHeadRecovery();
      return { skipped: false, fromBlock, toBlock };
    } catch (error) {
      resetRealtimeTailDeepReadiness();
      await withState(async () => {
        const previous = state._health.realtimeTail || { consecutiveFailures: 0 };
        const consecutiveFailures = Number(previous.consecutiveFailures || 0) + 1;
        const exponentialDelayMs = Math.min(5_000, 500 * (2 ** Math.min(consecutiveFailures - 1, 4)));
        const providerRetryAfterMs = Math.max(
          sharedRpcRetryDelayMs(error),
          Number.isFinite(Number(error?.retryAfterMs)) && Number(error.retryAfterMs) > 0
            ? Math.ceil(Number(error.retryAfterMs))
            : 0,
        );
        // The local exponential is bounded; an upstream Retry-After is not.
        // Waking before a physical host's declared deadline only creates a
        // fail-fast loop and cannot advance the durable cursor.
        const retryDelayMs = Math.max(exponentialDelayMs, providerRetryAfterMs);
        realtimeTailRetryAt = now() + retryDelayMs;
        state._health.realtimeTail = {
          ...previous,
          status: "error",
          checkedAt: iso(now),
          lastErrorAt: iso(now),
          lastError: errorSummary(error),
          consecutiveFailures,
          nextBlock: state.realtimeTailNextBlock,
          retryDelayMs,
          nextRetryAt: iso(realtimeTailRetryAt),
          ...(isBscDurableHandoffCapacityError(error) ? {
            backpressureReason: error.rangeExceedsCapacity === true
              ? "realtime_range_exceeds_pending_capacity"
              : "realtime_pending_capacity",
            pendingEntryCount: Number(error.pendingEntryCount || 0),
            newEntryCount: Number(error.newEntryCount || 0),
            pendingEntryCapacity: Number(error.pendingEntryCapacity || realtimePendingMaxEntries),
          } : {}),
        };
        if (!isBscDurableHandoffCapacityError(error)) {
          delete state._health.realtimeTail.backpressureReason;
          delete state._health.realtimeTail.pendingEntryCount;
          delete state._health.realtimeTail.newEntryCount;
          delete state._health.realtimeTail.pendingEntryCapacity;
        }
        updateCoverageHealth();
        await save().catch(() => {});
      });
      shouldContinue = true;
      throw error;
    } finally {
      realtimeTailRunning = false;
      if (focus3ChainScope && currentDeepRpcPriority().allowFreshQueue) {
        wakeBackgroundDeepRpc();
      }
      if ((shouldContinue || realtimeTailRequested) && !stopped) {
        realtimeTailRequested = false;
        scheduleRealtimeTail(Math.max(25, realtimeTailRetryAt - now()));
      }
    }
  }

  function scheduleRealtimeTail(delay = 25) {
    if (stopped || realtimeTailTimer) return;
    if (realtimeTailRunning) {
      realtimeTailRequested = true;
      return;
    }
    const retryDelay = Math.max(0, realtimeTailRetryAt - Number(now()));
    realtimeTailTimer = setTimeout(() => {
      realtimeTailTimer = null;
      void scanRealtimeTail().catch(logTailFailure);
    }, Math.max(25, Number(delay) || 25, retryDelay));
    realtimeTailTimer.unref?.();
  }

  async function scanNearHeadRecovery() {
    if (nearHeadRecoveryRunning || stopped) return { skipped: true, reason: nearHeadRecoveryRunning ? "running" : "stopped" };
    nearHeadRecoveryRunning = true;
    let activeGapId = null;
    let fromBlock = null;
    let toBlock = null;
    let shouldContinue = false;
    let continuationDelayMs = 25;
    try {
      await initialize();
      if (!(state.nearHeadRecoveryGaps || []).length) return { skipped: true, reason: "empty" };

      const confirmed = Math.max(0, currentHead - (config.bscConfirmations ?? 2));
      if (focus3ChainScope && currentDeepRpcPriority().capacityBackpressure) {
        scheduleRealtimeTail();
        return { skipped: true, reason: "realtime_capacity_backpressure" };
      }
      if (shouldYieldBscNearHeadRecovery({
        realtimeTailRunning,
        realtimeTailNextBlock: state.realtimeTailNextBlock,
        confirmedBlock: confirmed,
        permittedLagBlocks: nearHeadRecoveryPermittedRealtimeLagBlocks,
      })) {
        // Historical repair must never compete with an active or materially
        // lagging first-detection batch. Once the durable tail is inside the
        // short live window, its isolated RPC pool can advance in parallel.
        scheduleRealtimeTail();
        return { skipped: true, reason: "realtime_priority" };
      }

      if (nearHeadRecoveryAttemptsSinceCoverage >= BSC_NEAR_HEAD_ATTEMPTS_PER_HISTORICAL_BATCH
        && Number(state.lastFinalizedBlock || 0) < desiredCoverage
        && (coverageRunning || coverageRetryAt <= Date.now())) {
        // Once the bounded near-head quota is spent, do not let a 25ms repair
        // timer race a runnable history turn. A history lane still inside its
        // own retry window cannot freeze independent live repair; once that
        // deadline expires, advanceCoverage owns and resets the next slot.
        if (!coverageRunning) {
          shouldContinue = true;
          continuationDelayMs = Math.max(250, nearHeadRecoverySuccessIntervalMs);
          scheduleCoverage(25);
        }
        return { skipped: true, reason: "historical_fairness" };
      }

      const gap = dueNearHeadRecoveryGap();
      if (!gap) {
        shouldContinue = true;
        return { skipped: true, reason: "backoff" };
      }
      if (nearHeadNewestSelectionStreak >= 8) nearHeadNewestSelectionStreak = 0;
      else nearHeadNewestSelectionStreak += 1;
      activeGapId = gap.id;
      fromBlock = gap.nextBlock;
      toBlock = Math.min(gap.toBlock, fromBlock + nearHeadRecoveryBatchSize - 1);
      nearHeadRecoveryAttemptsSinceCoverage += 1;
      await withState(() => {
        const current = state.nearHeadRecoveryGaps.find((item) => item.id === activeGapId);
        if (!current) return;
        current.lastAttemptAt = iso(now);
        state._health.nearHeadRecovery = {
          ...(state._health.nearHeadRecovery || {}),
          status: "recovering",
          checkedAt: iso(now),
          activeGapId,
          fromBlock,
          toBlock,
        };
        updateCoverageHealth();
      });

      let recoveredRange = null;
      try {
        recoveredRange = await recoverLogRange(fromBlock, toBlock, "near_head_gap_recovery");
      } catch (rangeError) {
        // A pool-level cooling/429/timeout already proves that every physical
        // RPC is unavailable for this method. Do not expand it into per-block
        // receipt fallbacks or move on to another durable gap in the same
        // outage window.
        if (sharedRpcRetryDelayMs(rangeError) > 0) throw rangeError;
        const blockNumbers = Array.from({ length: toBlock - fromBlock + 1 }, (_, index) => fromBlock + index);
        const recovered = await mapLimit(
          blockNumbers,
          recoveryBlockConcurrency,
          (blockNumber) => recoverBlock(blockNumber, "near_head_gap_recovery"),
        );
        const failed = recovered.find((result) => result.status === "rejected");
        if (failed) {
          const failure = new Error(`near-head gap recovery failed: ${errorSummary(rangeError)}; block fallback failed: ${errorSummary(failed.reason)}`);
          failure.code = failed.reason?.code || rangeError?.code;
          failure.rpcFailureScope = failed.reason?.rpcFailureScope || rangeError?.rpcFailureScope;
          failure.rpcOperation = failed.reason?.rpcOperation || rangeError?.rpcOperation;
          const retryAfterMs = Math.max(
            sharedRpcRetryDelayMs(rangeError),
            sharedRpcRetryDelayMs(failed.reason),
          );
          if (retryAfterMs > 0) failure.retryAfterMs = retryAfterMs;
          throw failure;
        }
      }

      const entries = [...queue.values()]
        .filter((entry) => entry.blockNumber >= fromBlock
          && entry.blockNumber <= toBlock
          && entry.reasons.has("near_head_gap_recovery")
          && !state.seenTransactions[entry.transactionHash])
        .sort(compareBscQueueEntries);
      await withState(async () => {
        // Mirror the realtime-tail handoff: the recovered candidate set and the
        // exact gap cursor advance share one fsynced WAL frame. Deep runtime and
        // security analysis is intentionally independent. A crash before this
        // frame replays the range; a crash after it restores every candidate.
        persistRealtimePendingHandoff(entries);
        const currentIndex = state.nearHeadRecoveryGaps.findIndex((item) => item.id === activeGapId);
        if (currentIndex >= 0) {
          const current = state.nearHeadRecoveryGaps[currentIndex];
          current.nextBlock = Math.max(current.nextBlock, toBlock + 1);
          current.attempts = 0;
          current.nextAttemptAt = null;
          current.lastSuccessAt = iso(now);
          delete current.lastError;
          delete current.lastErrorAt;
          if (current.nextBlock > current.toBlock) state.nearHeadRecoveryGaps.splice(currentIndex, 1);
        }
        const previous = state._health.nearHeadRecovery || {};
        state._health.nearHeadRecovery = {
          ...previous,
          status: state.nearHeadRecoveryGaps.length ? "recovering" : "healthy",
          checkedAt: iso(now),
          lastSuccessAt: iso(now),
          consecutiveFailures: 0,
          lastRecoveredFromBlock: fromBlock,
          lastRecoveredToBlock: toBlock,
          activeGapId: null,
        };
        delete state._health.nearHeadRecovery.lastError;
        delete state._health.nearHeadRecovery.lastErrorAt;
        delete state._health.nearHeadRecovery.nextRetryAt;
        delete state._health.nearHeadRecovery.sharedRpcRetryAt;
        delete state._health.nearHeadRecovery.sharedRpcBackoff;
        delete state._health.nearHeadRecovery.backpressureReason;
        updateCoverageHealth();
        await save();
      });
      if (entries.length) scheduleRealtime();
      if (recoveredRange?.flapReplayNeeded) void replayPendingFlapActivations();
      nearHeadRecoveryRetryAt = 0;
      nearHeadRecoveryPacedUntil = Number(now()) + nearHeadRecoverySuccessIntervalMs;
      resetNearHeadRecoveryFailureLog();
      shouldContinue = state.nearHeadRecoveryGaps.length > 0;
      continuationDelayMs = nearHeadRecoverySuccessIntervalMs;
      scheduleCoverage();
      return { skipped: false, gapId: activeGapId, fromBlock, toBlock, completed: !state.nearHeadRecoveryGaps.some((item) => item.id === activeGapId) };
    } catch (error) {
      await withState(async () => {
        const gap = state.nearHeadRecoveryGaps.find((item) => item.id === activeGapId);
        const previous = state._health.nearHeadRecovery || { consecutiveFailures: 0 };
        const attempts = Number(gap?.attempts || 0) + 1;
        const localRetryDelayMs = Math.min(
          nearHeadRecoveryRetryMaxMs,
          nearHeadRecoveryRetryBaseMs * (2 ** Math.min(attempts - 1, 10)),
        );
        const failedAt = Number(now());
        const sharedRetryDelayMs = sharedRpcRetryDelayMs(error);
        const retryDelayMs = Math.max(localRetryDelayMs, sharedRetryDelayMs);
        if (sharedRetryDelayMs > 0) {
          // The lane-wide deadline belongs only to the physical-host outage.
          // A high-attempt poison gap keeps its own local 60s deadline without
          // freezing every other due gap for that extra time.
          nearHeadRecoveryRetryAt = Math.max(nearHeadRecoveryRetryAt, failedAt + sharedRetryDelayMs);
        }
        const retryAt = failedAt + retryDelayMs;
        const nextRetryAt = iso(retryAt);
        if (gap) {
          gap.attempts = attempts;
          gap.lastErrorAt = iso(failedAt);
          gap.lastError = errorSummary(error);
          gap.nextAttemptAt = nextRetryAt;
        }
        state._health.nearHeadRecovery = {
          ...previous,
          status: "backoff",
          checkedAt: iso(failedAt),
          lastErrorAt: iso(failedAt),
          lastError: errorSummary(error),
          consecutiveFailures: Number(previous.consecutiveFailures || 0) + 1,
          retryDelayMs,
          nextRetryAt,
          activeGapId: null,
          ...(sharedRetryDelayMs > 0 ? {
            sharedRpcRetryAt: iso(nearHeadRecoveryRetryAt),
            sharedRpcBackoff: true,
          } : {}),
        };
        if (sharedRetryDelayMs <= 0) {
          delete state._health.nearHeadRecovery.sharedRpcRetryAt;
          delete state._health.nearHeadRecovery.sharedRpcBackoff;
        }
        delete state._health.nearHeadRecovery.backpressureReason;
        updateCoverageHealth();
        await save().catch(() => {});
      });
      shouldContinue = true;
      logNearHeadRecoveryFailure(error);
      throw error;
    } finally {
      nearHeadRecoveryRunning = false;
      if (!stopped) scheduleCoverage();
      if ((shouldContinue || nearHeadRecoveryRequested) && !stopped) {
        nearHeadRecoveryRequested = false;
        scheduleNearHeadRecovery(continuationDelayMs);
      }
    }
  }

  function scheduleNearHeadRecovery(minDelayMs = 25) {
    if (stopped || !state || !(state.nearHeadRecoveryGaps || []).length) return;
    if (nearHeadRecoveryRunning) {
      nearHeadRecoveryRequested = true;
      return;
    }
    const dueNow = Boolean(dueNearHeadRecoveryGap());
    const nextAttemptAt = dueNow ? null : nextNearHeadRecoveryAttemptAt();
    const delay = Math.max(
      minDelayMs,
      nextAttemptAt === null ? 0 : nextAttemptAt - now(),
      nearHeadRecoveryPacedUntil - now(),
    );
    const dueAt = now() + delay;
    if (nearHeadRecoveryTimer) {
      if (nearHeadRecoveryTimerDueAt <= dueAt) return;
      clearTimeout(nearHeadRecoveryTimer);
      nearHeadRecoveryTimer = null;
    }
    nearHeadRecoveryTimerDueAt = dueAt;
    nearHeadRecoveryTimer = setTimeout(() => {
      nearHeadRecoveryTimer = null;
      nearHeadRecoveryTimerDueAt = 0;
      void scanNearHeadRecovery().catch(() => {});
    }, delay);
    nearHeadRecoveryTimer.unref?.();
  }

  async function pollHttpHead() {
    if (httpHeadPollRunning || stopped || !started) return;
    httpHeadPollRunning = true;
    try {
      const latest = await realtimeProvider.getBlockNumber();
      currentHead = Math.max(currentHead, latest);
      await withState(async () => {
        const previousHeadStatus = state._health.httpHead?.status;
        state._health.httpHead = { status: "healthy", consecutiveFailures: 0, checkedAt: iso(now), blockNumber: latest };
        const statusChanged = updateCoverageHealth();
        await saveHealthTelemetry({ urgent: statusChanged || previousHeadStatus !== "healthy" });
      });
      scheduleRealtime();
      scheduleRealtimeTail();
      scheduleNearHeadRecovery();
      scheduleCoverage();
    } catch (error) {
      await withState(async () => {
        const previous = state._health.httpHead || { consecutiveFailures: 0 };
        const consecutiveFailures = Number(previous.consecutiveFailures || 0) + 1;
        state._health.httpHead = { status: "error", consecutiveFailures, checkedAt: iso(now), lastError: errorSummary(error) };
        updateCoverageHealth();
        await saveHealthTelemetry({ urgent: previous.status !== "error" }).catch(() => {});
      });
    } finally {
      httpHeadPollRunning = false;
    }
  }

  function nextWebsocketRpcId() {
    if (!Number.isSafeInteger(rpcId) || rpcId >= Number.MAX_SAFE_INTEGER) {
      throw new Error("BSC websocket RPC id space exhausted");
    }
    rpcId += 1;
    return rpcId;
  }

  function websocketProofUnavailable(message, cause = null) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = "BSC_WEBSOCKET_PROOF_UNAVAILABLE";
    return error;
  }

  function rejectPendingWebsocketRpc(socket, reason) {
    for (const [requestId, pending] of pendingWsRpc) {
      if (socket && pending.socket !== socket) continue;
      pendingWsRpc.delete(requestId);
      websocketRpcClearTimeout(pending.timer);
      pending.reject(websocketProofUnavailable(`BSC websocket ${reason}`));
    }
  }

  function rejectPendingWebsocketConfirmations(socket, reason) {
    for (const [candidateId, pending] of pendingWsConfirmations) {
      if (socket && pending.socket !== socket) continue;
      pendingWsConfirmations.delete(candidateId);
      websocketRpcClearTimeout(pending.timer);
      pending.reject(websocketProofUnavailable(`BSC websocket ${reason}`));
    }
  }

  function settleWebsocketConfirmations(socket) {
    for (const [candidateId, pending] of pendingWsConfirmations) {
      if (pending.socket !== socket || currentHead < pending.targetHead) continue;
      pendingWsConfirmations.delete(candidateId);
      websocketRpcClearTimeout(pending.timer);
      pending.resolve(currentHead);
    }
  }

  function waitForWebsocketConfirmation(socket, targetHead, deadlineAtMs, candidateId) {
    if (!socket || socket !== websocket) {
      return Promise.reject(websocketProofUnavailable("BSC websocket confirmation socket is unavailable"));
    }
    if (currentHead >= targetHead) return Promise.resolve(currentHead);
    const remainingMs = Math.floor(deadlineAtMs - Number(now()) - BSC_WEBSOCKET_PROOF_DELIVERY_RESERVE_MS);
    if (remainingMs <= 0) {
      return Promise.reject(websocketProofUnavailable("BSC websocket confirmation deadline exhausted"));
    }
    return new Promise((resolve, reject) => {
      const timer = websocketRpcSetTimeout(() => {
        const pending = pendingWsConfirmations.get(candidateId);
        if (!pending) return;
        pendingWsConfirmations.delete(candidateId);
        reject(websocketProofUnavailable("BSC websocket confirmation timed out"));
      }, remainingMs);
      timer.unref?.();
      pendingWsConfirmations.set(candidateId, { socket, targetHead, timer, resolve, reject });
    });
  }

  function cancelWebsocketProofCandidate(candidateId, reason = "proof cancelled") {
    for (const [requestId, pending] of pendingWsRpc) {
      if (pending.candidateId !== candidateId) continue;
      pendingWsRpc.delete(requestId);
      websocketRpcClearTimeout(pending.timer);
      pending.reject(websocketProofUnavailable(`BSC websocket ${reason}`));
    }
    const confirmation = pendingWsConfirmations.get(candidateId);
    if (confirmation) {
      pendingWsConfirmations.delete(candidateId);
      websocketRpcClearTimeout(confirmation.timer);
      confirmation.reject(websocketProofUnavailable(`BSC websocket ${reason}`));
    }
  }

  function requestWebsocketProofRpc(socket, method, params, deadlineAtMs, candidateId, requestBudget) {
    if (!BSC_WEBSOCKET_PROOF_METHODS.has(method)) {
      return Promise.reject(websocketProofUnavailable(`BSC websocket proof method ${method} is not allowed`));
    }
    if (!socket || socket !== websocket) {
      return Promise.reject(websocketProofUnavailable("BSC websocket proof socket is unavailable"));
    }
    if (requestBudget.count >= BSC_WEBSOCKET_PROOF_MAX_REQUESTS) {
      return Promise.reject(websocketProofUnavailable("BSC websocket proof request cap reached"));
    }
    const remainingMs = Math.floor(deadlineAtMs - Number(now()) - BSC_WEBSOCKET_PROOF_DELIVERY_RESERVE_MS);
    if (remainingMs <= 0) {
      return Promise.reject(websocketProofUnavailable("BSC websocket proof delivery deadline exhausted"));
    }
    requestBudget.count += 1;
    const requestId = nextWebsocketRpcId();
    const timeoutMs = Math.max(1, Math.min(websocketProofTimeoutMs, remainingMs));
    return new Promise((resolve, reject) => {
      const timer = websocketRpcSetTimeout(() => {
        const pending = pendingWsRpc.get(requestId);
        if (!pending) return;
        pendingWsRpc.delete(requestId);
        reject(websocketProofUnavailable(`BSC websocket ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      pendingWsRpc.set(requestId, { socket, method, candidateId, timer, resolve, reject });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
      } catch (error) {
        pendingWsRpc.delete(requestId);
        websocketRpcClearTimeout(timer);
        reject(websocketProofUnavailable(`BSC websocket ${method} send failed`, error));
      }
    });
  }

  function websocketFocusCandidatePlatform(log, observedAt) {
    const activationReady = (activation) => Boolean(activation
      && activation.active !== false
      && !activation.firstTokenAlertedAt
      && !activation.firstTokenTransactionHash
      && (activation.allowReplay !== true || activation.replayCompletedAt));
    const flapCandidate = parseFlapCreationHotCandidates([log], {
      transactionHash: log?.transactionHash,
      blockNumber: typeof log?.blockNumber === "string" ? Number.parseInt(log.blockNumber, 16) : log?.blockNumber,
      transactionIndex: log?.transactionIndex,
      logIndex: log?.logIndex,
      observedAt,
      indexedAt: observedAt,
      current: Date.parse(observedAt),
      pools: [],
    })[0] || null;
    if (flapCandidate) {
      const matches = [];
      for (const [activationKey, activation] of Object.entries(state.officialSources?.flap?.featureActivations || {})) {
        if (!activationReady(activation) || !flapActivationEligibleAt(activation, observedAt)) continue;
        const exactVaultMatch = activation.type === "vault_factory"
          && flapCandidateMatchesActivation(flapCandidate, activation);
        // The TokenCreated notification alone has no pool logs. An unresolved
        // quote activation is still a focused candidate, but the complete
        // receipt must later prove the exact quote before it can alert.
        const possibleQuoteMatch = activation.type === "quote_pool"
          && flapCandidate.topic === FLAP_TOKEN_CREATED_TOPIC
          && flapCandidate.launcher === FLAP_PORTAL_ADDRESS;
        if (exactVaultMatch || possibleQuoteMatch) matches.push(activationKey);
      }
      if (matches.length) return { platform: "flap", activationKey: matches.length === 1 ? matches[0] : null };
    }
    const fourMemeCandidate = fourMemeCreationCandidateFromLog(log, { observedAt });
    if (fourMemeCandidate) {
      const matches = [];
      for (const [activationKey, activation] of Object.entries(state.officialSources?.fourMeme?.featureActivations || {})) {
        if (activationReady(activation) && fourMemeCandidateMatchesActivation(fourMemeCandidate, activation)) {
          matches.push(activationKey);
        }
      }
      if (matches.length) return { platform: "fourmeme", activationKey: matches.length === 1 ? matches[0] : null };
    }
    return null;
  }

  function websocketFlapFirstThreeGenerationKeys(receipt, entry, observedAt) {
    const pools = parseBscPoolLogs(receipt?.logs || []);
    const candidates = parseFlapCreationHotCandidates(receipt?.logs || [], {
      transactionHash: entry.transactionHash,
      blockHash: receipt?.blockHash || null,
      blockNumber: entry.blockNumber,
      transactionIndex: receipt?.index ?? receipt?.transactionIndex ?? entry.transactionIndex ?? 0,
      observedAt,
      indexedAt: observedAt,
      current: Number(now()),
      confirmations: Math.max(0, Number(currentHead || 0) - Number(entry.blockNumber)),
      requiredConfirmations: Math.max(0, Number(config.bscConfirmations ?? 2)),
      pools,
    });
    const matches = new Set();
    for (const [generationKey, window] of activeFlapQuoteFirstThreeWindows()) {
      for (const candidate of candidates) {
        if (!flapQuoteCandidateAfterActivation(candidate, window)) continue;
        if (verifiedFlapQuotePair(pools, candidate.token, window.quoteAddress)) matches.add(generationKey);
      }
    }
    return [...matches].sort();
  }

  async function runWebsocketProofFastPath(entry, triggerLog, observedAt, socket) {
    const deliverySla = normalizeBscWebsocketDeliverySla(entry?.deliverySla);
    const observedAtMs = Date.parse(observedAt || "");
    if (!entry
      || !deliverySla
      || !Number.isFinite(observedAtMs)
      || new Date(observedAtMs).toISOString() !== observedAt
      || Date.parse(deliverySla.startedAt) !== observedAtMs) return { status: "ineligible" };
    const candidateId = `${entry.transactionHash}:${deliverySla.startedAt}`;
    const requestBudget = { count: 0 };
    let ownsSlot = false;
    let blockReservation = null;
    try {
      const deadlineAtMs = Date.parse(deliverySla.deadlineAt);
      const stillFocused = websocketFocusCandidatePlatform(triggerLog, observedAt);
      if (stillFocused?.activationKey
        && !websocketProofCandidateActive
        && !inFlightEntries.has(entry.transactionHash)
        && Number.isFinite(deadlineAtMs)
        && Number(now()) < deadlineAtMs - BSC_WEBSOCKET_PROOF_DELIVERY_RESERVE_MS
        && socket === websocket) {
        // Claim the transaction and its block synchronously, before the first
        // durability await. No proof RPC starts until the pending transaction
        // is durable, but coverage can no longer race ahead with an HTTP read
        // for the same block while that save is in flight.
        websocketProofCandidateActive = true;
        ownsSlot = true;
        websocketProofReservations.add(entry.transactionHash);
        blockReservation = reserveWebsocketProofBlock(entry.blockNumber, deadlineAtMs, candidateId);
      }
      // The candidate is durable before any fast proof or alert work starts.
      // A busy, stale, mismatched or failed fast path therefore falls back to
      // the unchanged HTTP queue after restart without moving a chain cursor.
      const persisted = await withState(async () => {
        if (state.seenTransactions[entry.transactionHash]
          || state.deferredCreationEvidence[entry.transactionHash]) return false;
        persistRealtimePendingHandoff([entry]);
        await save();
        return true;
      });
      if (!persisted) return { status: "already_processed", requests: 0 };

      const ownsKnownCausalHead = await withState(() => isDurableCausalGroupHead(entry));
      if (!ownsKnownCausalHead) {
        wakeBackgroundDeepRpc();
        return { status: "causal_http_fallback", requests: 0 };
      }

      if (!ownsSlot) {
        scheduleRealtime();
        return { status: "http_fallback", requests: 0 };
      }
      const [transaction, receipt] = await Promise.all([
        requestWebsocketProofRpc(socket, "eth_getTransactionByHash", [entry.transactionHash], deadlineAtMs, candidateId, requestBudget),
        requestWebsocketProofRpc(socket, "eth_getTransactionReceipt", [entry.transactionHash], deadlineAtMs, candidateId, requestBudget),
      ]);
      const proofBlockNumber = strictBscRpcQuantity(receipt?.blockNumber, "receipt block number");
      if (proofBlockNumber !== Number(entry.blockNumber)) throw websocketProofUnavailable("BSC websocket receipt block mismatch");
      const confirmations = Math.max(0, Number(config.bscConfirmations ?? 2));
      const targetHead = proofBlockNumber + confirmations;
      if (!Number.isSafeInteger(targetHead)) throw websocketProofUnavailable("BSC websocket confirmation target is invalid");
      // Transaction/receipt may be prefetched at ingress, but the canonical
      // block is fetched only after the same confirmation boundary used by the
      // HTTP lane. Its hash is then checked against every proof object.
      await waitForWebsocketConfirmation(socket, targetHead, deadlineAtMs, candidateId);
      const block = await requestWebsocketProofRpc(
        socket,
        "eth_getBlockByNumber",
        [hexBlock(proofBlockNumber), false],
        deadlineAtMs,
        candidateId,
        requestBudget,
      );
      const proof = normalizeBscWebsocketProof({
        transactionHash: entry.transactionHash,
        blockNumber: entry.blockNumber,
        transaction,
        receipt,
        block,
        triggerLog,
        current: now(),
      });
      const firstThreeGenerationKeys = websocketFlapFirstThreeGenerationKeys(receipt, entry, observedAt);
      if (firstThreeGenerationKeys.length > 1) {
        throw websocketProofUnavailable("BSC websocket proof matched multiple Flap first-three generations");
      }
      if (firstThreeGenerationKeys.length === 1) {
        const [generationKey] = firstThreeGenerationKeys;
        if (entry.flapQuoteFirstThreeReplayGenerationKey
          && entry.flapQuoteFirstThreeReplayGenerationKey !== generationKey) {
          throw websocketProofUnavailable("BSC websocket first-three generation changed during proof");
        }
        if (!entry.flapQuoteFirstThreeReplayGenerationKey) {
          entry.flapQuoteFirstThreeReplayGenerationKey = generationKey;
          entry.revision = Number(entry.revision || 0) + 1;
          await withState(async () => {
            const pending = state.realtimePendingEntries[entry.transactionHash];
            if (!pending || state.seenTransactions[entry.transactionHash]) return;
            state.realtimePendingEntries[entry.transactionHash] = serializeRealtimePendingEntry(entry, pending);
            await save();
          });
        }
      }
      if (!await withState(() => isDurableCausalGroupHead(entry))) {
        wakeBackgroundDeepRpc();
        return { status: "causal_http_fallback", requests: requestBudget.count };
      }
      if (Number(now()) >= deadlineAtMs - BSC_WEBSOCKET_PROOF_DELIVERY_RESERVE_MS) {
        throw websocketProofUnavailable("BSC websocket proof completed after its delivery budget");
      }
      websocketProofContexts.set(entry.transactionHash, proof);
      blockReservation.publish(proof.block);
      try {
        await processEntries([entry], 1, {
          preserveRealtimePendingOnFailure: true,
          websocketProofOwner: true,
        });
      } finally {
        if (websocketProofContexts.get(entry.transactionHash) === proof) {
          websocketProofContexts.delete(entry.transactionHash);
        }
      }
      return { status: "processed", requests: requestBudget.count };
    } catch (error) {
      blockReservation?.fail(error);
      const fallbackAt = Date.parse(deliverySla?.deadlineAt || "");
      if (ownsSlot && Number.isFinite(fallbackAt) && fallbackAt > Number(now())) {
        // A focused WS attempt already used the same HTTP enrichment lane and
        // left the durable candidate untouched. Avoid racing it immediately
        // through the ordinary queue; resume at the original bounded SLA.
        websocketHttpFallbackRetryAt.set(entry.transactionHash, fallbackAt);
        scheduleRealtime(fallbackAt - Number(now()));
      } else scheduleRealtime();
      return { status: "http_fallback", requests: requestBudget.count };
    } finally {
      if (ownsSlot) {
        blockReservation?.fail(websocketProofUnavailable("BSC websocket proof finished without a verified block"));
        cancelWebsocketProofCandidate(candidateId);
        websocketProofReservations.delete(entry.transactionHash);
        websocketProofCandidateActive = false;
      }
    }
  }

  function subscribe(kind, params, socket = websocket) {
    if (!socket || socket !== websocket) throw new Error(`cannot subscribe ${kind} on an inactive BSC websocket`);
    const requestId = nextWebsocketRpcId();
    pendingSubscriptions.set(requestId, kind);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "eth_subscribe", params }));
  }

  async function onMessage(event, socket) {
    // Capture the transport ingress before JSON parsing, state locks, or
    // protocol enrichment. This is the only honest source-side start for the
    // shared five-second first-attempt delivery budget.
    const messageReceivedAt = now();
    if (socket !== websocket) return;
    let message;
    try { message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); }
    catch { return; }
    if (Object.hasOwn(message, "id") && pendingWsRpc.has(message.id)) {
      const pending = pendingWsRpc.get(message.id);
      pendingWsRpc.delete(message.id);
      websocketRpcClearTimeout(pending.timer);
      if (message.jsonrpc !== "2.0") {
        pending.reject(websocketProofUnavailable(`BSC websocket ${pending.method} returned an invalid JSON-RPC envelope`));
      } else if (message.error) {
        pending.reject(websocketProofUnavailable(
          `BSC websocket ${pending.method} RPC ${message.error.code ?? "error"}: ${message.error.message || "failed"}`,
        ));
      } else pending.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, "id") && pendingSubscriptions.has(message.id)) {
      const kind = pendingSubscriptions.get(message.id);
      pendingSubscriptions.delete(message.id);
      if (message.error) throw new Error(`${kind} subscription: ${message.error.message || "failed"}`);
      if (typeof message.result !== "string" || !message.result || subscriptions.has(message.result)) throw new Error(`${kind} subscription returned an invalid or duplicate id`);
      subscriptions.set(message.result, kind);
      const activeKinds = new Set(subscriptions.values());
      await withState(async () => {
        const previous = state._health.websocket || {};
        const complete = requiredSubscriptionKinds.every((required) => activeKinds.has(required));
        state._health.websocket = {
          ...previous,
          status: complete && previous.lastHeadAt ? "healthy" : "subscribing",
          activeSubscriptions: [...activeKinds].sort(),
          pendingSubscriptions: [...pendingSubscriptions.values()].sort(),
        };
      });
      return;
    }
    if (message.method !== "eth_subscription") return;
    const kind = subscriptions.get(message.params?.subscription);
    const result = message.params?.result;
    const deliverySla = createBscWebsocketDeliverySla(messageReceivedAt);
    if (kind === "heads") {
      const nextHead = Number.parseInt(result?.number, 16);
      if (!Number.isFinite(nextHead)) throw new Error("heads subscription returned an invalid block number");
      currentHead = Math.max(currentHead, nextHead);
      settleWebsocketConfirmations(socket);
      const activeKinds = new Set(subscriptions.values());
      const complete = requiredSubscriptionKinds.every((required) => activeKinds.has(required));
      await withState(async () => {
        state._health.websocket = {
          ...state._health.websocket,
          status: complete ? "healthy" : "subscribing",
          consecutiveFailures: complete ? 0 : Number(state._health.websocket?.consecutiveFailures || 0),
          lastHeadAt: iso(now),
          blockNumber: currentHead,
          activeSubscriptions: [...activeKinds].sort(),
          pendingSubscriptions: [...pendingSubscriptions.values()].sort(),
        };
      });
      if (complete) reconnectAttempts = 0;
      scheduleRealtime();
      scheduleRealtimeTail();
      scheduleNearHeadRecovery();
      scheduleCoverage();
    } else if (kind === "mints" && result?.transactionHash) {
      const emitter = String(result.address).toLowerCase();
      if (isErc20MintLog(result) && !existingMintEmitters.has(emitter)) enqueue(result.transactionHash, Number.parseInt(result.blockNumber, 16), "zero_mint", {
        transactionIndex: result.transactionIndex,
        logIndex: result.logIndex,
        mintEmitters: [emitter],
        deliverySla,
      });
    } else if (kind === "protocol" && result?.transactionHash) {
      const observedAt = new Date(Number(messageReceivedAt)).toISOString();
      registerSingularryCurves([result], {
        transactionHash: result.transactionHash,
        blockNumber: Number.parseInt(result.blockNumber, 16),
      });
      const rugChildren = parseRugspullChildren([result]);
      if (rugChildren.length) {
        await withState(async () => {
          registerOfficialChildren(rugChildren.map((child) => ({ ...child, registeredAt: iso(now) })));
          await save();
        });
      }
      const launchProtocol = BSC_LAUNCH_TOPICS.includes(result.topics?.[0]);
      const upgradeProtocol = BSC_UPGRADE_TOPICS.includes(result.topics?.[0]);
      const lifecycleProtocol = BSC_PLATFORM_LIFECYCLE_TOPICS.includes(result.topics?.[0]);
      const lifecycleComponent = lifecycleProtocol ? parseRuntimeOfficialLifecycleLog(result) : null;
      const upgradeComponent = upgradeProtocol ? runtimeOfficialComponentForAddress(result.address) : null;
      if (upgradeProtocol && !upgradeComponent) return;
      if (lifecycleProtocol && !lifecycleComponent) return;
      const parsedPools = launchProtocol || upgradeProtocol || lifecycleProtocol ? [] : parseBscPoolLogs([result]);
      const exactOfficialTokens = officialCreationEvidenceTokens([result]);
      const candidateTokens = [
        ...parsedPools.flatMap((pool) => [pool.token0, pool.token1]),
        ...parseKnownBscLaunchTokens([result]),
      ].filter((address) => !BSC_QUOTE_ASSETS.has(address.toLowerCase()));
      const hookPools = parsedPools.filter((pool) => pool.verifiedDex && pool.hook && pool.hook.toLowerCase() !== "0x0000000000000000000000000000000000000000");
      const handoffEvidence = focus3ChainScope
        ? officialCreationHandoffEvidenceForLogs([result], {
          transactionHash: result.transactionHash,
          blockNumber: Number.parseInt(result.blockNumber, 16),
          transactionIndex: result.transactionIndex,
          logIndex: result.logIndex,
          observedAt,
        })
        : { causalBarrierKeys: [], flapCandidates: [], fourMemeCandidates: [] };
      enqueue(result.transactionHash, Number.parseInt(result.blockNumber, 16), launchProtocol ? "known_launch" : upgradeProtocol ? "official_upgrade" : lifecycleProtocol ? "official_lifecycle" : "pool_created", {
        transactionIndex: result.transactionIndex,
        logIndex: result.logIndex,
        blockHash: result.blockHash,
        candidateTokens,
        verifiedNewContracts: exactOfficialTokens,
        upgradeEmitters: upgradeComponent ? [result.address] : [],
        lifecycleEmitters: lifecycleComponent ? [result.address] : [],
        hookPools,
        causalBarrierKeys: handoffEvidence.causalBarrierKeys,
        flapCreationHotCandidates: handoffEvidence.flapCandidates,
        fourMemeCreationHotCandidates: handoffEvidence.fourMemeCandidates,
        protocol: launchProtocol || upgradeProtocol || lifecycleProtocol,
        deliverySla,
      });
      const fastCandidate = websocketFocusCandidatePlatform(result, observedAt);
      const entry = fastCandidate ? queue.get(normalizeTransactionHash(result.transactionHash)) : null;
      if (entry && fastCandidate.activationKey
        && entry.featureActivationReplayKey !== fastCandidate.activationKey) {
        entry.featureActivationReplayKey = fastCandidate.activationKey;
        entry.revision = Number(entry.revision || 0) + 1;
      }
      if (entry) void trackWebsocketProofTask(() => runWebsocketProofFastPath(entry, result, observedAt, socket));
    }
  }

  function scheduleReconnect() {
    if (stopped || !started || reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * (2 ** Math.min(reconnectAttempts, 5)));
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  function clearRuntime() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (healthTelemetryTimer) healthClearTimeout(healthTelemetryTimer);
    if (coverageTimer) clearTimeout(coverageTimer);
    if (realtimeTimer) backgroundClearTimeout(realtimeTimer);
    if (deferredEvidenceWakeTimer) backgroundClearTimeout(deferredEvidenceWakeTimer);
    if (realtimeTailTimer) clearTimeout(realtimeTailTimer);
    if (nearHeadRecoveryTimer) clearTimeout(nearHeadRecoveryTimer);
    if (httpHeadTimer) clearInterval(httpHeadTimer);
    if (officialPollTimer) clearInterval(officialPollTimer);
    if (discoveryPollTimer) clearInterval(discoveryPollTimer);
    if (deferredEvidenceTimer) clearInterval(deferredEvidenceTimer);
    watchdogTimer = null;
    healthTelemetryTimer = null;
    coverageTimer = null;
    coverageTimerDueAt = 0;
    realtimeTimer = null;
    realtimeTimerDueAt = 0;
    deferredEvidenceWakeTimer = null;
    deferredEvidenceWakeTimerDueAt = 0;
    realtimeTailTimer = null;
    realtimeTailRequested = false;
    nearHeadRecoveryTimer = null;
    nearHeadRecoveryTimerDueAt = 0;
    nearHeadRecoveryRequested = false;
    resetRealtimeTailDeepReadiness();
    backgroundDeepRpcNextAt = 0;
    backgroundDeepHostRetryAt = 0;
    backgroundOldDeepRpcNextAt = 0;
    backgroundFreshDeepRpcStreak = 0;
    backgroundDeepPreferredLane.sla = "realtime";
    backgroundDeepPreferredLane.fresh = "realtime";
    backgroundDeepPreferredLane.old = "realtime";
    httpHeadTimer = null;
    officialPollTimer = null;
    discoveryPollTimer = null;
    deferredEvidenceTimer = null;
    pendingSubscriptions.clear();
    subscriptions.clear();
    websocketHttpFallbackRetryAt.clear();
    wsOpenedAt = 0;
    const socket = websocket;
    rejectPendingWebsocketRpc(socket, "connection closed");
    rejectPendingWebsocketConfirmations(socket, "connection closed");
    websocket = null;
    try { socket?.close(); } catch {}
  }

  function scheduleStartRetry() {
    if (stopped || started || startRetryTimer) return;
    const delay = Math.min(30_000, 1_000 * (2 ** Math.min(reconnectAttempts, 5)));
    reconnectAttempts += 1;
    startRetryTimer = setTimeout(() => {
      startRetryTimer = null;
      void start().catch(handleStartFailure);
    }, delay);
    startRetryTimer.unref?.();
  }

  function handleStartFailure(error) {
    logger.error(`[bsc][start] ${errorSummary(error)}`);
    started = false;
    clearRuntime();
    scheduleStartRetry();
  }

  function connect() {
    if (stopped || !started || !WebSocketImpl) return;
    pendingSubscriptions.clear();
    subscriptions.clear();
    let socket;
    try {
      socket = new WebSocketImpl(config.bscWsUrl);
    } catch (error) {
      logger.error(`[bsc][ws] ${errorSummary(error)}`);
      scheduleReconnect();
      return;
    }
    websocket = socket;
    socket.addEventListener("open", () => {
      if (socket !== websocket) return;
      wsOpenedAt = now();
      void withState(async () => {
        state._health.websocket = { status: "subscribing", consecutiveFailures: Number(state._health.websocket?.consecutiveFailures || 0), connectedAt: iso(now), lastHeadAt: null, activeSubscriptions: [], pendingSubscriptions: [...requiredSubscriptionKinds] };
      });
      try {
        subscribe("heads", ["newHeads"], socket);
        if (!focus3ChainScope) subscribe("mints", ["logs", { topics: [BSC_TRANSFER_TOPIC, BSC_ZERO_TOPIC] }], socket);
        // Keep WebSocket discovery global: unique launch and upgrade topics can
        // reveal a new root before an official API/docs poll has indexed it.
        subscribe("protocol", ["logs", { topics: [focus3ChainScope ? BSC_FOCUS3_TRIGGER_TOPICS : BSC_TRIGGER_TOPICS] }], socket);
      } catch (error) {
        logger.error(`[bsc][ws] subscribe: ${errorSummary(error)}`);
        socket.close();
        return;
      }
      void (async () => {
        try {
          const latest = await realtimeProvider.getBlockNumber();
          if (socket !== websocket) return;
          currentHead = Math.max(currentHead, latest);
          recoveryTarget = Math.max(recoveryTarget, latest - (config.bscConfirmations ?? 2));
          scheduleRealtimeTail();
          scheduleNearHeadRecovery();
          scheduleCoverage();
        } catch (error) {
          logger.error(`[bsc][rpc] reconnect baseline: ${errorSummary(error)}`);
          if (socket === websocket) socket.close();
        }
      })();
    });
    socket.addEventListener("message", (event) => void onMessage(event, socket).catch((error) => {
      logger.error(`[bsc][ws] ${errorSummary(error)}`);
      if (socket === websocket) socket.close();
    }));
    socket.addEventListener("error", () => {
      rejectPendingWebsocketRpc(socket, "connection error");
      rejectPendingWebsocketConfirmations(socket, "connection error");
    });
    socket.addEventListener("close", () => {
      if (socket !== websocket) return;
      rejectPendingWebsocketRpc(socket, "connection closed");
      rejectPendingWebsocketConfirmations(socket, "connection closed");
      websocket = null;
      wsOpenedAt = 0;
      pendingSubscriptions.clear();
      subscriptions.clear();
      if (!state) return;
      void withState(async () => {
        const previous = state._health.websocket || { consecutiveFailures: 0 };
        state._health.websocket = { ...previous, status: "backoff", disconnectedAt: iso(now), consecutiveFailures: Number(previous.consecutiveFailures || 0) + 1, activeSubscriptions: [], pendingSubscriptions: [] };
        await save();
      }).catch(() => {});
      scheduleReconnect();
    });
  }

  async function start() {
    if (started || stopped || config.bscMonitorEnabled === false) return;
    started = true;
    startRunning = true;
    try {
      await initialize();
      if (!WebSocketImpl) throw new Error("BSC WebSocket implementation is unavailable");
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== BSC_CHAIN_ID) throw new Error(`BSC RPC chain ID ${network.chainId} != 56`);
      const latest = await realtimeProvider.getBlockNumber();
      currentHead = latest;
      desiredCoverage = Math.max(0, latest - (config.bscConfirmations ?? 2));
      await withState(async () => {
        const freshState = state.lastFinalizedBlock === null;
        if (freshState) {
          state.lastFinalizedBlock = desiredCoverage;
          state.initializedAt = iso(now);
        } else {
          recoveryTarget = desiredCoverage;
        }
        ensureRealtimeTailCursor(desiredCoverage);
        if (freshState) {
          state._health.realtimeTail = {
            status: "healthy",
            checkedAt: iso(now),
            lastSuccessAt: iso(now),
            consecutiveFailures: 0,
            nextBlock: state.realtimeTailNextBlock,
          };
        }
        updateCoverageHealth();
        await save();
        lastHealthPersistAt = now();
      });
      officialPollTimer = setInterval(() => {
        void checkOfficialFourMeme();
        // Flap Board delivery is a separate source, but incomplete activation
        // replays share this durable maintenance cadence. The per-key flight
        // map prevents overlap with startup, registration, or hot-index wakeups.
        void replayPendingFlapActivations();
        void replayPendingFlapQuoteFirstThreeGenerations().catch((error) => {
          logger.error(`[bsc][flap-first-three] ${errorSummary(error)}`);
        });
      }, config.bscOfficialPollIntervalMs ?? 10_000);
      officialPollTimer.unref?.();
      if (String(config.monitorScope || "").toLowerCase() !== "focus3") {
        void refreshDappBay();
        discoveryPollTimer = setInterval(() => void refreshDappBay(), config.bscDiscoveryPollIntervalMs ?? 300_000);
        discoveryPollTimer.unref?.();
      }
      deferredEvidenceTimer = setInterval(() => void retryDeferredCreationEvidence(), config.bscDeferredRetryIntervalMs ?? 2_000);
      deferredEvidenceTimer.unref?.();
      void retryDeferredCreationEvidence();
      httpHeadTimer = setInterval(() => void pollHttpHead(), config.bscHttpHeadPollIntervalMs ?? 1_000);
      httpHeadTimer.unref?.();
      void pollHttpHead();
      scheduleRealtimeTail();
      scheduleNearHeadRecovery();
      connect();
      // Chain ingestion owns the latency SLO. Official API recovery and its
      // bounded activation replay run in the background so a stale audit
      // checkpoint can never delay the WebSocket/tail startup path.
      void checkOfficialFourMeme();
      void replayPendingFlapActivations();
      trackBackgroundReplay(() => replayPendingFlapQuoteFirstThreeGenerations());
      watchdogTimer = setInterval(() => {
        const socket = websocket;
        if (!socket || !wsOpenedAt) return;
        const activeKinds = new Set(subscriptions.values());
        const missingSubscriptions = requiredSubscriptionKinds.filter((kind) => !activeKinds.has(kind));
        const lastHeadAt = Date.parse(state?._health?.websocket?.lastHeadAt || 0);
        const headReference = Number.isFinite(lastHeadAt) && lastHeadAt > 0 ? lastHeadAt : wsOpenedAt;
        const acknowledgementsExpired = now() - wsOpenedAt > 5_000 && missingSubscriptions.length > 0;
        const headExpired = now() - headReference > 10_000;
        if (!acknowledgementsExpired && !headExpired) return;
        void withState(async () => {
          state._health.websocket = {
            ...state._health.websocket,
            status: "degraded",
            checkedAt: iso(now),
            lastError: acknowledgementsExpired ? `subscription acknowledgement timeout: ${missingSubscriptions.join(",")}` : "newHeads heartbeat timeout",
          };
          await save();
        }).finally(() => {
          if (socket === websocket) socket.close();
        });
      }, 2_500);
      watchdogTimer.unref?.();
      logger.error(`[bsc] chain=56 baseline=${state.lastFinalizedBlock} ws=${new URL(config.bscWsUrl).host} realtime=${realtimeProvider.hosts?.join(",") || "shared"} rpc=${provider.hosts?.join(",") || new URL(config.bscRpcUrl).host} archive=${provider.archiveHosts?.join(",") || "none"}`);
    } catch (error) {
      started = false;
      clearRuntime();
      throw error;
    } finally {
      startRunning = false;
    }
  }

  async function awaitIdle() {
    while (true) {
      const observedStateLock = stateLock;
      const observedSaveLock = saveLock;
      const observedJournalIoLock = journalIoLock;
      const observedJournalCompactionTask = journalCompactionTask;
      const observedInitialize = initializePromise;
      const observedFlapReplaySweep = flapReplaySweepLock;
      const processors = [...activeObservationProcessors];
      const entries = [...new Set(inFlightEntries.values())];
      const deliveries = [...pendingEventDeliveries.values()];
      const backgroundReplays = [...backgroundReplayTasks];
      const websocketProofs = [...websocketProofTasks];
      await Promise.allSettled([
        observedStateLock,
        observedSaveLock,
        observedJournalIoLock,
        observedJournalCompactionTask,
        observedFlapReplaySweep,
        ...(observedInitialize ? [observedInitialize] : []),
        ...processors,
        ...entries,
        ...deliveries,
        ...backgroundReplays,
        ...websocketProofs,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const laneRunning = startRunning
        || officialCheckRunning
        || discoveryCheckRunning
        || deferredEvidenceRunning
        || httpHeadPollRunning
        || realtimeRunning
        || realtimeTailRunning
        || nearHeadRecoveryRunning
        || coverageRunning
        || activeBscScanRequests > 0;
      if (!laneRunning
        && !initializePromise
        && activeObservationProcessors.size === 0
        && inFlightEntries.size === 0
        && pendingEventDeliveries.size === 0
        && backgroundReplayTasks.size === 0
        && websocketProofTasks.size === 0
        && pendingWsRpc.size === 0
        && pendingWsConfirmations.size === 0
        && websocketProofContexts.size === 0
        && websocketProofReservations.size === 0
        && observedStateLock === stateLock
        && observedSaveLock === saveLock
        && observedJournalIoLock === journalIoLock
        && observedJournalCompactionTask === journalCompactionTask
        && observedFlapReplaySweep === flapReplaySweepLock) return;
    }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    started = false;
    if (!blockCacheAbortController.signal.aborted) {
      blockCacheAbortController.abort(blockCacheStoppedError());
    }
    // Cancel replay reads before awaiting lane locks. Already-started durable
    // commits still drain through stateLock/saveLock; unstarted candidates
    // remain in the persisted Flap hot index for the next process.
    if (!flapReplayAbortController.signal.aborted) {
      flapReplayAbortController.abort(flapReplayStoppedError());
    }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (startRetryTimer) clearTimeout(startRetryTimer);
    reconnectTimer = null;
    startRetryTimer = null;
    clearRuntime();
    const attempt = (async () => {
      try {
        await awaitIdle();
        // A lane that was already past its stop guard may have scheduled a
        // timer while draining. Clear once more before closing the provider.
        clearRuntime();
        await Promise.allSettled([stateLock, saveLock]);
        if (journalCompactionTimer) {
          journalClearTimeout(journalCompactionTimer);
          journalCompactionTimer = null;
          journalCompactionTimerDueAt = 0;
        }
        if (journalPersistenceEnabled && durableJournalState) await compactStateJournal({ force: true });
        await Promise.allSettled([journalIoLock]);
      } finally {
        providerDestroyPromise ||= Promise.allSettled(
          [...new Set([provider, realtimeProvider])]
            .map((rpc) => Promise.resolve().then(() => rpc.destroy?.())),
        );
        await providerDestroyPromise;
      }
    })();
    stopPromise = attempt;
    // A failed final durability barrier must be retryable in this process.
    // Successful stops remain cached and idempotent.
    void attempt.catch(() => {
      if (stopPromise === attempt) stopPromise = null;
    });
    return attempt;
  }

  const monitor = { start, stop, awaitIdle, observe, registerDiscoveryCandidates, registerFlapFeatureActivations, registerFlapQuotePoolLifecycle, replayFlapFeatureActivations: replayPendingFlapActivations, replayFlapQuotePoolFirstThree: replayPendingFlapQuoteFirstThreeGenerations, registerFourMemeFeatureActivations, checkOfficialSources: checkOfficialFourMeme, checkHttpHead: pollHttpHead, retryDeferredCreationEvidence, processRealtimeQueue, scanRealtimeTail, scanNearHeadRecovery, advanceCoverage, getState: async () => {
    await initialize();
    return withState(async () => structuredClone(state));
  } };
  if (autoStart && config.bscMonitorEnabled !== false) void start().catch(handleStartFailure);
  return monitor;
}
