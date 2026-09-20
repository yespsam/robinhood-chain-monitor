import { isEventBlocked } from "./blocklist.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  claimsBscOpenFourFirstTokenUpdate,
  claimsFourRegistryUpdate,
  isMonitoringSourceEnabled,
  isFomoMonitorHealthUpdateAllowed,
  isFourMemePolicyFixRecoveryEvent,
  isOfficialFourMemeCapabilityUpdate,
  isOfficialPonFunUpdate,
  isStrictBscOpenFourFirstTokenUpdate,
  isStrictFourRegistryCapabilityUpdate,
  isStrictFourRegistryCanonicalRestoration,
  isStrictFourRegistryCanonicalRevision,
  isStrictFourRegistryCanonicalSupersession,
  isStrictFourRegistryDelayedRecovery,
  isStrictFourRegistryFirstTokenUpdate,
  isStrictFourMemeMarketCampaign,
  isTelegramNewsUpdateAllowed,
  isThreePlatformScope,
  openFourCoreTokenCreatedSafetyPassSemanticKey,
  openFourCoreTokenCreatedSemanticKey,
} from "./source-controls.js";
import { createHash } from "node:crypto";
import { localizeAlertEvent } from "./chinese-localizer.js";
import { chainSupportLabel, extractChainSupportSignals } from "./chain-support.js";
import {
  BILINGUAL_RENDER_VERSION,
  buildBilingualAlertBundle,
  renderBilingualTelegramText,
} from "./bilingual-alert-renderer.js";
import {
  compareTradingPriority,
  deriveEventLifecycle,
  isTradingPriority,
  withTradingPriority,
} from "./trading-priority.js";
import { verifyNarrativeTradeSignalIntegrity } from "./narrative-trade-signal.js";
import {
  isKolSelfLaunchEvent,
  kolTokenLaunchCanonicalSignalIds,
  kolTokenLaunchEventKey,
  verifyKolTokenLaunchEvent,
} from "./kol-token-launch-alert.js";
import { deriveNewPoolContext } from "./new-pool-context.js";
import { isGeniusHistorical, isGeniusOfficialEvent } from "./genius-source-policy.js";
import { renderGeniusAlertLines } from "./genius-alert.js";
import { assertGeniusChainDeliveryCanonical } from "./genius-delivery-verification.js";
import { isGmgnFlowEvent } from "./gmgn-flow-signal.js";
import { renderGmgnFlowAlertLines } from "./gmgn-flow-alert.js";

const OFFICIAL_TOKEN_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_FRESHNESS_REALTIME_MAX_AGE_MS = 10 * 60 * 1_000;
const DEFAULT_FRESHNESS_TELEGRAM_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_TELEGRAM_DELIVERY_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
const FOMO_TELEGRAM_DELIVERY_MAX_AGE_MS = 5 * 60 * 1_000;
const PON_DELAYED_RECOVERY_DELIVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const SMART_WALLET_SIGNAL_KIND = "high_profit_high_winrate_wallet_buy";
const SMART_WALLET_SOURCE_ID = "gmgn_profitable_wallet_onchain";
const SMART_WALLET_SOURCE_TRUST = "public_onchain_profiled";
const SMART_WALLET_BLOCKED_TAG = /(?:^|[_-])(?:wash(?:[_-]?trader)?|arbitrager|arbitrage|mev(?:[_-]?bot)?|sandwich|router|cex|exchange|contract)(?:$|[_-])/i;
const FRESHNESS_VERSION = 1;
const ALERT_RENDER_VERSION = BILINGUAL_RENDER_VERSION;
const LEGACY_ALERT_RENDER_VERSION = 2;
const FOCUS_PLATFORMS = new Set(["flap", "fourmeme"]);
const BINANCE_PLATFORMS = new Set(["binance", "binancewallet", "binancefutures"]);
const PON_FUN_ALLOWED_KINDS = new Set([
  "market_created", "market_lifecycle", "factory_config", "curve_params", "stock_listing",
  "factory_paused", "factory_unpaused", "ownership_transfer_started", "ownership_transferred",
  "platform_token_update",
]);
const PON_FUN_STRONG_KINDS = new Set([
  "factory_config", "curve_params", "factory_paused", "ownership_transfer_started",
  "ownership_transferred", "platform_token_update",
]);
const PON_FUN_REVISIONED_PLATFORM_KINDS = new Set([
  "factory_config", "curve_params", "factory_paused", "factory_unpaused",
  "ownership_transfer_started", "ownership_transferred", "platform_token_update",
  "stock_listing", "market_lifecycle",
]);
const PLATFORM_TWITTER_SIGNALS = new Set([
  "新发射/新模式",
  "合约/部署",
  "订阅功能",
  "OpenFour",
  "税收/募资/报价代币",
  "活动/费用变更",
  "擂台/赛事新玩法",
  "新增链支持",
  "Agent/Skill 集成",
]);
const STRONG_PLATFORM_CHANGE_KEYS = [
  "newFlapPools",
  "updatedFlapPools",
  "flapPoolChanges",
  "newQuoteTokens",
  "removedQuoteTokens",
  "newQuoteConfigs",
  "removedQuoteConfigs",
  "updatedQuoteConfigs",
  "quoteConfigChanges",
  "newContracts",
  "removedContracts",
  "newModules",
  "removedModules",
  "newVersions",
  "removedVersions",
  "newPackages",
  "removedPackages",
  "updatedPackages",
  "packageVersionChanges",
  "newPages",
  "newAnnouncements",
  "newCampaigns",
  "newChains",
  "chainStageChanges",
];

export function officialTokenDedupKey(event) {
  if (event.type !== "official_activity" || !event.token) return null;
  return `${event.actor || event.project || "official"}:${event.token}`.toLowerCase();
}

async function readAlertState(file) {
  const state = { officialTokens: {} };
  try {
    return { ...state, ...JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") return state;
    throw error;
  }
}

async function writeAlertState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tempFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempFile, file);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

async function isRepeatedOfficialToken(config, event) {
  const key = officialTokenDedupKey(event);
  if (!key) return false;
  const state = await readAlertState(path.join(config.dataDir, "alert-state.json"));
  const previous = Number(state.officialTokens?.[key] || 0);
  return Date.now() - previous < OFFICIAL_TOKEN_COOLDOWN_MS;
}

async function rememberOfficialToken(config, event) {
  const key = officialTokenDedupKey(event);
  if (!key) return;
  const file = path.join(config.dataDir, "alert-state.json");
  const state = await readAlertState(file);
  state.officialTokens ||= {};
  const now = Date.now();
  state.officialTokens[key] = now;
  for (const [entry, timestamp] of Object.entries(state.officialTokens)) {
    if (now - Number(timestamp) > 7 * 24 * 60 * 60 * 1_000) delete state.officialTokens[entry];
  }
  await writeAlertState(file, state);
}

function normalizedPlatform(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function eventPlatform(event) {
  for (const candidate of [event.platform, event.launchpad, event.project]) {
    if (candidate && typeof candidate === "object") {
      if (candidate.id) return normalizedPlatform(candidate.id);
      if (candidate.name) return normalizedPlatform(candidate.name);
    } else if (candidate) return normalizedPlatform(candidate);
  }
  return "";
}

export function isFocusPlatformEvent(event) {
  return FOCUS_PLATFORMS.has(eventPlatform(event));
}

export function isBinancePlatformEvent(event) {
  return BINANCE_PLATFORMS.has(eventPlatform(event));
}

export function isUniswapPlatformEvent(event) {
  const platform = eventPlatform(event);
  return event?.uniswapOfficial === true || platform === "uniswap" || platform === "uniswappools" || platform.startsWith("uniswap");
}

function isPonFunEvent(event) {
  return event?.type === "pon_fun_update" && eventPlatform(event) === "ponfun";
}

function isPonFunTwitterEvent(event) {
  return event?.type === "twitter_update"
    && eventPlatform(event) === "ponfun"
    && event?.project?.signalProfile === "pon_fun"
    && event?.signal?.ponFunOfficial === true;
}

function isPonFunDelayedRecoveryEvent(event) {
  return (isPonFunEvent(event) || isPonFunTwitterEvent(event))
    && event?.delayedRecovery?.version === 1
    && event.delayedRecovery?.reason === "monitoring_gap_recovery";
}

function isFlapQuoteDelayedRecoveryEvent(event) {
  return event?.type === "platform_capability_update"
    && eventPlatform(event) === "flap"
    && event?.kind === "flap_quote_asset_enabled"
    && event?.delayedRecovery?.version === 1
    && event.delayedRecovery?.reason === "monitoring_gap_recovery";
}

function isFlapQuoteFirstObservedAfterGapEvent(event) {
  return event?.type === "platform_capability_update"
    && eventPlatform(event) === "flap"
    && event?.kind === "flap_quote_asset_first_observed_after_gap"
    && event?.changeType === "observed"
    && event?.signal?.quotePairChange?.stage === "observed"
    && event?.delayedRecovery?.version === 1
    && event.delayedRecovery?.reason === "first_observed_after_gap";
}

function isFlapQuoteRecoveryEvent(event) {
  return isFlapQuoteDelayedRecoveryEvent(event)
    || isFlapQuoteFirstObservedAfterGapEvent(event);
}

function isFlapBoardQuoteObservedEvent(event) {
  const changedPools = [
    ...(event?.changes?.newFlapPools || []),
    ...(event?.changes?.updatedFlapPools || []),
    ...(event?.changes?.flapPoolChanges || []).map((change) => change?.after),
  ];
  const pools = [...new Map(changedPools
    .filter((pool) => pool?.kind === "quote_asset")
    .map((pool) => [String(pool.quoteAddress || "").toLowerCase(), pool])).values()];
  const assets = event?.signal?.quotePairChange?.assets;
  const sourceMs = Date.parse(event?.sourceOccurredAt || "");
  const observedMs = Date.parse(event?.observedAt || "");
  return event?.type === "platform_capability_update"
    && eventPlatform(event) === "flap"
    && event.kind === "flap_quote_asset_board_observed"
    && event.changeType === "observed"
    && event.source === "https://flap.sh/board"
    && event.url === "https://flap.sh/board"
    && Number.isFinite(sourceMs)
    && Number.isFinite(observedMs)
    && sourceMs <= observedMs + 60_000
    && !event.transactionHash
    && !event.onchainProof
    && pools.length > 0
    && pools.every((pool) => /^0x[a-f0-9]{40}$/.test(String(pool?.quoteAddress || ""))
      && /^[A-Za-z0-9][A-Za-z0-9_$.-]{0,23}$/.test(String(pool?.quoteSymbol || ""))
      && String(pool?.quoteName || "").trim().length > 0)
    && event?.signal?.quotePairChange?.stage === "observed"
    && event.signal.quotePairChange.assetClass === "quote_asset"
    && Array.isArray(assets)
    && assets.length === pools.length
    && pools.every((pool) => assets.some((asset) => String(asset?.address || "").toLowerCase() === pool.quoteAddress
      && String(asset?.symbol || "").toUpperCase() === String(pool.quoteSymbol || "").toUpperCase()));
}

function isDurableFlapQuoteNotificationEvent(event) {
  return isFlapQuoteRecoveryEvent(event) || isFlapBoardQuoteObservedEvent(event);
}

function isFlapPortalQuoteEvent(event) {
  return event?.type === "platform_capability_update"
    && eventPlatform(event) === "flap"
    && (event?.kind === "flap_quote_asset_enabled"
      || event?.kind === "flap_quote_asset_first_observed_after_gap")
    && event?.signal?.quotePairChange?.assetClass === "quote_asset"
    && event.signal.quotePairChange.stage === (event.kind === "flap_quote_asset_enabled" ? "live" : "observed")
    && /^0x[a-f0-9]{64}$/i.test(String(event?.transactionHash || ""))
    && Number.isSafeInteger(Number(event?.blockNumber));
}

function flapPortalQuoteAddress(event) {
  if (!isFlapPortalQuoteEvent(event)) return null;
  const assets = event?.signal?.quotePairChange?.assets;
  if (!Array.isArray(assets) || assets.length !== 1) return null;
  const address = String(assets[0]?.address || "").toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(address) ? address : null;
}

function flapQuoteProducerGateForEvent(event) {
  const quoteAddress = flapPortalQuoteAddress(event);
  const originalEventKey = isFlapPortalQuoteEvent(event)
    ? String(event.originalEventKey || event.eventKey || "")
    : "";
  if (!quoteAddress || !/^flap-quote:56:0x[a-f0-9]{64}:\d+$/.test(originalEventKey)) return null;
  return Object.freeze({ version: 1, originalEventKey, quoteAddress });
}

function validFlapQuoteProducerGate(value) {
  return Boolean(value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "originalEventKey,quoteAddress,version"
    && value.version === 1
    && /^flap-quote:56:0x[a-f0-9]{64}:\d+$/.test(String(value.originalEventKey || ""))
    && /^0x[a-f0-9]{40}$/.test(String(value.quoteAddress || "")));
}

function isFlapQuoteProducerGatedEntry(entry) {
  return isFlapPortalQuoteEvent(entry?.event)
    || validFlapQuoteProducerGate(entry?.flapQuoteProducerGate);
}

export function isBscLaunchpadEvent(event) {
  return event.type === "bsc_launchpad_update";
}

export function isMorphLaunchpadEvent(event) {
  return event.type === "evm_launchpad_update" && Number(event.chainId || event.chain?.id) === 2818;
}

function publicProjectEvidence(event) {
  const metadata = event.tokens?.[0]?.metadata || event.entry?.metadata || {};
  return Boolean(metadata.website || metadata.twitter || metadata.telegram || metadata.discord);
}

function infrastructureCount(analysis) {
  return Object.values(analysis?.infrastructure || {}).filter(Boolean).length;
}

function passedLocalSafety(event) {
  return event.security?.decision === "pass" && event.security?.metrics?.liquidityConfirmed !== false;
}

function isKnownLaunchpadNewMode(event) {
  if (event.type !== "token_launch" || !["new_mode_candidate", "new_mode_confirmed"].includes(event.modeStatus) || !event.launchpad) return false;
  return event.factoryStatus === "known" || ["exact_factory", "pons_version_shape"].includes(event.launchpad.match);
}

function isConfirmedReusableLaunchpad(event) {
  if (event.type !== "token_launch" || event.factoryStatus !== "rediscovered" || event.launchCount !== 2) return false;
  const analysis = event.launcherAnalysis;
  if (event.launchpad || analysis?.classification !== "reusable_launcher" || !passedLocalSafety(event)) return false;
  if (analysis.codeSize < 10_000 || analysis.argumentBytes < 32) return false;
  return publicProjectEvidence(event) || infrastructureCount(analysis) >= 3 || analysis.selectorSimilarity >= 0.75;
}

export function isActionableLaunchpadCandidate(event) {
  if (event.type !== "token_launch" || event.factoryStatus !== "new_candidate" || event.confidence !== "high") return false;
  if (event.launchpad?.id === "pons") return false;
  const analysis = event.launcherAnalysis;
  if (!analysis || !["reusable_launchpad_candidate", "reusable_launcher"].includes(analysis.classification)) return false;
  if (!passedLocalSafety(event) || !publicProjectEvidence(event)) return false;
  const structuralEvidence = infrastructureCount(analysis) >= 3 || analysis.selectorSimilarity >= 0.75;
  return analysis.argumentBytes >= 64 && analysis.codeSize >= 10_000 && analysis.usesCreate2 && structuralEvidence;
}

export function isImportantRobinhoodEvent(event) {
  if (event.type === "official_activity") {
    return event.activity === "burn" || event.importance === "high" || event.tradeVerified === true;
  }
  if (event.type === "early_activity_alert") {
    return event.activity === "volume_anomaly" && Number(event.stage || 0) >= 2
      && (event.entry?.security?.decision || event.entry?.securityDecision) === "pass";
  }
  if (event.type === "contract_deployed") return false;
  if (event.type === "token_launch") {
    if (event.launchpad?.id === "pons" && event.modeStatus !== "new_mode_candidate") return false;
    return isKnownLaunchpadNewMode(event) || isActionableLaunchpadCandidate(event) || isConfirmedReusableLaunchpad(event);
  }
  return false;
}

const hasValue = (value) => value !== null && value !== undefined && String(value).trim() !== "";
const firstValue = (...values) => values.find(hasValue);
const httpsUrl = (...values) => values.find((value) => /^https:\/\//i.test(String(value || "").trim())) || null;
const visibleTechnicalLiterals = (value) => {
  const source = String(value || "");
  return [...new Set([
    ...(source.match(/https?:\/\/[^\s<>"']+/gi) || []).map((item) => item.replace(/[),.;!?]+$/, "")),
    ...(source.match(/\b0x[a-fA-F0-9]{8,}\b/g) || []),
    ...(source.match(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/g) || []),
    ...(source.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\s*\(\)/g) || []),
    ...(source.match(/#[A-Za-z][A-Za-z0-9_]{1,63}\b/g) || []),
  ])].sort((left, right) => right.length - left.length);
};
const wordBoundarySlice = (value, maximum) => {
  const source = String(value || "");
  if (source.length <= maximum) return source;
  const window = source.slice(0, Math.max(1, maximum));
  const minimum = Math.floor(maximum * 0.55);
  const punctuation = [...window.matchAll(/[.!?。！？;；](?:\s|$)/g)].at(-1);
  if (punctuation && punctuation.index >= minimum) {
    return window.slice(0, punctuation.index + punctuation[0].trimEnd().length).trimEnd();
  }
  const boundary = Math.max(
    window.lastIndexOf(" "),
    window.lastIndexOf("，"),
    window.lastIndexOf(","),
    window.lastIndexOf("；"),
    window.lastIndexOf(";"),
  );
  return boundary >= minimum ? window.slice(0, boundary).trimEnd() : window.trimEnd();
};
const oneLine = (value, maximum = 160) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maximum) return text;
  let missing = [];
  let prefix = wordBoundarySlice(text, maximum - 1);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    missing = visibleTechnicalLiterals(text).filter((literal) => !prefix.includes(literal));
    const suffix = missing.length ? ` · ${missing.join(" · ")}` : "";
    if (!suffix || suffix.length >= maximum - 24) break;
    const next = wordBoundarySlice(text, maximum - suffix.length - 1);
    if (next === prefix) break;
    prefix = next;
  }
  missing = visibleTechnicalLiterals(text).filter((literal) => !prefix.includes(literal));
  const suffix = missing.length ? ` · ${missing.join(" · ")}` : "";
  if (suffix.length && suffix.length < maximum - 24) return `${prefix}…${suffix}`;
  return `${wordBoundarySlice(text, maximum - 1)}…`;
};
const shortAddress = (value) => {
  const text = String(value || "");
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text || "未取得";
};
const numeric = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const money = (value, maximumFractionDigits = 0) => {
  const number = numeric(value);
  return number === null ? "未取得" : `$${number.toLocaleString("en-US", { maximumFractionDigits })}`;
};

function epochMs(value) {
  if (!hasValue(value)) return null;
  if (typeof value === "number") return Number.isFinite(value) ? (value < 10_000_000_000 ? value * 1_000 : value) : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

const ROBINHOOD_CHAIN_ALERT_TYPES = new Set([
  "contract_deployed",
  "token_launch",
  "official_activity",
  "early_activity_alert",
  "pons_v2_factory_discovered",
  "pons_v2_factory_status_update",
]);

function nonNegativeLimit(config, name, fallback) {
  const value = Number(config?.[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function freshnessSource(event) {
  if (event?.type === "gmgn_flow_surge") return { scope: "gmgn_flow", basis: "sourceOccurredAt", value: event.sourceOccurredAt };
  if (event?.type === "genius_fun_update") {
    const historical = isGeniusHistorical(event);
    return {
      scope: "genius_official",
      basis: historical ? "historical_record_observedAt" : event.sourceOccurredAt ? "sourceOccurredAt" : "observedAt_snapshot_change",
      value: historical ? event.observedAt : event.sourceOccurredAt || event.observedAt,
    };
  }
  if (isKolSelfLaunchEvent(event)) {
    return {
      scope: "kol_self_launch",
      basis: event.sourceOccurredAt ? "sourceOccurredAt" : "tweet.createdAt",
      value: event.sourceOccurredAt || event.tweet?.createdAt || event.publishedAt,
    };
  }
  if (event.type === "narrative_trade_signal") {
    return {
      scope: "narrative_trade_signal",
      basis: "signal.event.asOf",
      value: event.signal?.event?.asOf || event.observedAt,
    };
  }
  if (event.type === "telegram_news_update") {
    return { scope: "telegram_news", basis: "sourceOccurredAt", value: event.sourceOccurredAt };
  }
  if (isFourMemePolicyFixRecoveryEvent(event)) {
    return {
      scope: "fourmeme_policy_fix_recovery",
      basis: "policyFixRecovery.recoveredAt_continuous_recovery",
      value: event.policyFixRecovery.recoveredAt,
    };
  }
  if (isStrictFourRegistryCanonicalRevision(event)) {
    return {
      scope: "four_registry_canonical_revision",
      basis: "canonicalRevision.recoveryDetectedAt_finalized_reorg",
      value: event.canonicalRevision.recoveryDetectedAt,
    };
  }
  if (isStrictFourRegistryCanonicalRestoration(event)) {
    return {
      scope: "four_registry_canonical_restoration",
      basis: "canonicalRestoration.detectedAt_recanonicalized",
      value: event.canonicalRestoration.detectedAt,
    };
  }
  if (isStrictFourRegistryCanonicalSupersession(event)) {
    return {
      scope: "four_registry_canonical_supersession",
      basis: "canonicalSupersession.detectedAt_replacement",
      value: event.canonicalSupersession.detectedAt,
    };
  }
  if (isStrictFourRegistryDelayedRecovery(event)) {
    return {
      scope: "four_registry_delayed_recovery",
      basis: "delayedRecovery.recoveredAt_continuous_recovery",
      value: event.delayedRecovery.recoveredAt,
    };
  }
  if (isStrictFourRegistryFirstTokenUpdate(event)) {
    return { scope: "four_registry_first_token", basis: "blockTimestamp", value: event.blockTimestamp };
  }
  if (isStrictFourRegistryCapabilityUpdate(event)) {
    return { scope: "four_registry_capability", basis: "blockTimestamp", value: event.blockTimestamp };
  }
  if (isOfficialFourMemeCapabilityUpdate(event)) {
    return {
      scope: "fourmeme_official_capability",
      basis: "observedAt_continuous_coverage",
      value: event.observedAt,
    };
  }
  if (event.type === "bsc_launchpad_update") {
    const value = firstValue(event.blockTimestamp, event.timestamp);
    return { scope: "bsc_chain", basis: hasValue(event.blockTimestamp) ? "blockTimestamp" : "timestamp", value };
  }
  if (isPonFunDelayedRecoveryEvent(event)) {
    return {
      scope: "pon_delayed_recovery",
      basis: "delayedRecovery.recoveredAt_continuous_recovery",
      value: event.delayedRecovery.recoveredAt || event.observedAt,
    };
  }
  if (isFlapQuoteRecoveryEvent(event)) {
    return {
      scope: isFlapQuoteFirstObservedAfterGapEvent(event)
        ? "flap_first_observed_after_gap"
        : "flap_delayed_recovery",
      basis: "delayedRecovery.recoveredAt_continuous_recovery",
      value: event.delayedRecovery.recoveredAt,
    };
  }
  if (isPonFunEvent(event)) {
    const chainTime = event.blockTimestamp;
    return {
      scope: "robinhood_chain",
      basis: hasValue(chainTime) ? "blockTimestamp" : "observedAt_continuous_coverage",
      value: chainTime || event.observedAt,
    };
  }
  if (isMorphLaunchpadEvent(event)) {
    const value = firstValue(event.blockTimestamp, event.timestamp, event.observedAt);
    return { scope: "morph_chain", basis: hasValue(event.blockTimestamp) ? "blockTimestamp" : "observedAt", value };
  }
  if (ROBINHOOD_CHAIN_ALERT_TYPES.has(event.type)) {
    const candidates = event.type === "early_activity_alert"
      ? [["latestSwapAt", event.latestSwapAt], ["blockTimestamp", event.blockTimestamp], ["timestamp", event.timestamp]]
      : [["blockTimestamp", event.blockTimestamp], ["timestamp", event.timestamp]];
    const selected = candidates.find(([, value]) => hasValue(value));
    return { scope: "robinhood_chain", basis: selected?.[0] || "source_time_missing", value: selected?.[1] };
  }
  if (event.type === "twitter_update") {
    return { scope: "twitter", basis: "tweet.createdAt", value: event.tweet?.createdAt };
  }
  if (event.type === "github_module_update") {
    return { scope: "github", basis: "committedAt", value: event.committedAt };
  }
  if (event.type === "github_repository_discovered") {
    return {
      scope: "github",
      basis: "repositoryMetadata.createdAt",
      value: event.repositoryMetadata?.createdAt || event.createdAt,
    };
  }
  if (event.type === "uniswap_official_update") {
    return { scope: "uniswap", basis: "publishedAt", value: event.publishedAt };
  }
  if (event.type === "ai_official_update") {
    return {
      scope: "ai_official",
      basis: event.publishedAt ? "publishedAt" : "observedAt_continuous_coverage",
      value: event.publishedAt || event.observedAt,
    };
  }
  if (event.type === "binance_official_update" && event.kind === "announcement") {
    if (event.changeType === "revised") {
      return {
        scope: "binance_announcement",
        basis: event.updatedAt ? "updatedAt" : event.revisionRealtimeTrusted ? "observedAt_continuous_coverage" : "publishedAt_recovery_fallback",
        value: event.updatedAt || (event.revisionRealtimeTrusted ? event.observedAt : event.publishedAt),
      };
    }
    return { scope: "binance_announcement", basis: "publishedAt", value: event.publishedAt };
  }
  if (event.type === "binance_official_update" && event.kind === "meme_rush_capability" && event.baselineDiscovery === true) {
    const protocolTimes = (event.changes?.newProtocols || [])
      .map((protocol) => epochMs(protocol?.latestCreateTime))
      .filter((value) => value !== null);
    return {
      scope: "binance_announcement",
      basis: "changes.newProtocols.latestCreateTime",
      value: protocolTimes.length ? Math.max(...protocolTimes) : null,
    };
  }
  // Binance announcement revisions and site/capability snapshots deliberately
  // stay outside this gate: their original publication/observation time does
  // not necessarily describe when the material revision or capability changed.
  return null;
}

function freshnessLimits(config, scope) {
  if (scope === "gmgn_flow") return { realtimeMaxAgeMs: 600_000, telegramMaxAgeMs: 900_000 };
  if (scope === "pon_delayed_recovery") {
    return {
      realtimeMaxAgeMs: DEFAULT_FRESHNESS_REALTIME_MAX_AGE_MS,
      telegramMaxAgeMs: PON_DELAYED_RECOVERY_DELIVERY_MAX_AGE_MS,
    };
  }
  const names = {
    bsc_chain: ["alertBscRealtimeMaxAgeMs", "alertBscTelegramMaxAgeMs"],
    fourmeme_official_capability: ["alertBscRealtimeMaxAgeMs", "alertBscTelegramMaxAgeMs"],
    fourmeme_policy_fix_recovery: ["alertTwitterRealtimeMaxAgeMs", "alertTwitterTelegramMaxAgeMs"],
    four_registry_capability: ["alertBscRealtimeMaxAgeMs", "alertBscTelegramMaxAgeMs"],
    four_registry_first_token: ["alertBscRealtimeMaxAgeMs", "alertBscTelegramMaxAgeMs"],
    four_registry_delayed_recovery: ["alertBscRealtimeMaxAgeMs", "alertBscTelegramMaxAgeMs"],
    four_registry_canonical_revision: ["alertBscRealtimeMaxAgeMs", "alertBscTelegramMaxAgeMs"],
    four_registry_canonical_restoration: ["alertBscRealtimeMaxAgeMs", "alertBscTelegramMaxAgeMs"],
    four_registry_canonical_supersession: ["alertBscRealtimeMaxAgeMs", "alertBscTelegramMaxAgeMs"],
    morph_chain: ["alertMorphRealtimeMaxAgeMs", "alertMorphTelegramMaxAgeMs"],
    robinhood_chain: ["alertRobinhoodRealtimeMaxAgeMs", "alertRobinhoodTelegramMaxAgeMs"],
    twitter: ["alertTwitterRealtimeMaxAgeMs", "alertTwitterTelegramMaxAgeMs"],
    github: ["alertGithubRealtimeMaxAgeMs", "alertGithubTelegramMaxAgeMs"],
    uniswap: ["alertUniswapRealtimeMaxAgeMs", "alertUniswapTelegramMaxAgeMs"],
    ai_official: ["alertAiOfficialRealtimeMaxAgeMs", "alertAiOfficialTelegramMaxAgeMs"],
    genius_official: ["alertGeniusRealtimeMaxAgeMs", "alertGeniusTelegramMaxAgeMs"],
    binance_announcement: ["alertBinanceAnnouncementRealtimeMaxAgeMs", "alertBinanceAnnouncementTelegramMaxAgeMs"],
    telegram_news: ["alertTelegramNewsRealtimeMaxAgeMs", "alertTelegramNewsTelegramMaxAgeMs"],
    kol_self_launch: ["alertTwitterRealtimeMaxAgeMs", "alertTwitterTelegramMaxAgeMs"],
    narrative_trade_signal: ["alertBscRealtimeMaxAgeMs", "alertBscTelegramMaxAgeMs"],
    flap_delayed_recovery: ["alertBscRealtimeMaxAgeMs", "alertBscTelegramMaxAgeMs"],
    flap_first_observed_after_gap: ["alertBscRealtimeMaxAgeMs", "alertBscTelegramMaxAgeMs"],
  }[scope];
  if (!names) return null;
  const realtimeMaxAgeMs = nonNegativeLimit(config, names[0], DEFAULT_FRESHNESS_REALTIME_MAX_AGE_MS);
  const telegramMaxAgeMs = Math.max(
    realtimeMaxAgeMs,
    nonNegativeLimit(config, names[1], DEFAULT_FRESHNESS_TELEGRAM_MAX_AGE_MS),
  );
  return { realtimeMaxAgeMs, telegramMaxAgeMs };
}

export function classifyAlertFreshness(config, event, discoveredAt = Date.now()) {
  const source = freshnessSource(event || {});
  if (!source) return null;
  const limits = freshnessLimits(config, source.scope);
  const discoveredMs = epochMs(discoveredAt) ?? Date.now();
  const sourceMs = epochMs(source.value);
  const common = {
    version: FRESHNESS_VERSION,
    scope: source.scope,
    basis: source.basis,
    sourceOccurredAt: sourceMs === null ? null : new Date(sourceMs).toISOString(),
    discoveredAt: new Date(discoveredMs).toISOString(),
    lagMs: sourceMs === null ? null : Math.max(0, discoveredMs - sourceMs),
    sourceTimeReliable: sourceMs !== null,
    realtimeMaxAgeMs: limits.realtimeMaxAgeMs,
    telegramMaxAgeMs: limits.telegramMaxAgeMs,
  };
  if (sourceMs === null) {
    return { ...common, decision: "unassessed", reason: "source_time_missing_or_invalid" };
  }
  const lagMs = Math.max(0, discoveredMs - sourceMs);
  if (lagMs <= limits.realtimeMaxAgeMs) {
    return { ...common, lagMs, decision: "realtime", reason: sourceMs > discoveredMs ? "source_clock_ahead" : "within_realtime_window" };
  }
  if (lagMs <= limits.telegramMaxAgeMs) {
    return { ...common, lagMs, decision: "late", reason: "late_backfill_downgrade" };
  }
  return { ...common, lagMs, decision: "suppress", reason: "too_old_for_telegram" };
}

function withAlertFreshness(config, event, discoveredAt = Date.now()) {
  if (event?.freshness?.version === FRESHNESS_VERSION) return event;
  const freshness = classifyAlertFreshness(config, event, discoveredAt);
  return freshness ? { ...event, freshness } : event;
}

function effectiveFreshnessDecision(event) {
  return event?.freshness?.deliveryDecision || event?.freshness?.decision || null;
}

function effectiveFreshnessLagMs(event) {
  return event?.freshness?.deliveryLagMs ?? event?.freshness?.lagMs ?? null;
}

function compactAlertEventTime(event, sourceFallback, discoveredFallback) {
  return compactEventTime(
    event?.freshness?.sourceOccurredAt || sourceFallback,
    event?.freshness?.discoveredAt || discoveredFallback,
  );
}

function beijingTime(value) {
  const timestamp = epochMs(value);
  if (timestamp === null) return "未取得";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function durationText(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "未取得";
  const seconds = Math.floor(durationMs / 1_000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时${minutes % 60 ? `${minutes % 60}分` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}天${hours % 24 ? `${hours % 24}小时` : ""}`;
}

function delayBetween(start, end) {
  const from = epochMs(start);
  const to = epochMs(end);
  return from === null || to === null || to < from ? "未取得" : durationText(to - from);
}

function eventTimingLine(event) {
  const chainTime = firstValue(event.blockTimestamp, event.timestamp);
  const discoveredAt = firstValue(event.alertQueuedAt, event.detectedAt, event.checkedAt, event.observedAt);
  return chainTime
    ? `时间: 链上 ${beijingTime(chainTime)}（北京时间） · 发现延迟 ${delayBetween(chainTime, discoveredAt)}`
    : `发现时间: ${beijingTime(discoveredAt)}（北京时间） · 链上时间未取得`;
}

function socialCoverage(values = {}) {
  const fields = [
    ["官网", values.website],
    ["X", values.twitter],
    ["TG", values.telegram],
    ["Discord", values.discord],
  ];
  const known = fields.filter(([, value]) => hasValue(value)).map(([label]) => `${label}✓`);
  const missing = fields.filter(([, value]) => !hasValue(value)).map(([label]) => label);
  return known.length
    ? `${known.join(" ")}${missing.length ? ` · 未取得 ${missing.join("/")}` : ""}`
    : "官网/X/TG/Discord 均未取得";
}

function securitySummary(security, fallbackDecision = null) {
  const decision = security?.decision || fallbackDecision;
  if (!decision || decision === "unknown") return "安全检查未完成";
  const reasons = (security?.reasons || []).filter(Boolean).slice(0, 2);
  if (decision === "block") return `不买${reasons.length ? `：${reasons.join("；")}` : "（风险项未取得）"}`;
  if (decision === "pass") {
    const coverage = security?.metrics?.coverage || {};
    const unfinished = [
      ["可卖", coverage.sellability],
      ["税费", coverage.buySellTax],
      ["持有人集中度", coverage.holderConcentration],
      ["LP锁仓/销毁", coverage.lpLockOrBurn],
    ].filter(([, status]) => !hasValue(status) || /^(?:not_checked|unknown|unavailable|not_available)$/i.test(String(status)))
      .map(([label]) => label);
    return `本地初筛通过${unfinished.length ? `；安全检查未完成：${unfinished.join("/")}未查` : ""}${reasons.length ? `：${reasons.join("；")}` : ""}`;
  }
  return oneLine(security?.label || decision, 120);
}

function coverageMark(value, outcome = null) {
  const normalized = String(value ?? "").toLowerCase();
  if (!hasValue(value) || /(?:^not_checked$|^unknown$|unavailable|not_available|missing|unreadable)/i.test(normalized)) return "未查";
  if (outcome === false || /(?:not_confirmed|failed|blocked|risky)/i.test(normalized)) return "已查✗";
  if (outcome === true) return "已查✓";
  return "已查";
}

function securityCoverageMatrix(security, positionProof = null) {
  const metrics = security?.metrics || {};
  const coverage = metrics.coverage || {};
  const capabilityValues = Object.values(metrics.capabilities || {});
  const owner = String(metrics.owner || "").toLowerCase();
  const ownerSafe = hasValue(metrics.owner)
    ? ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"].includes(owner)
    : null;
  const proxySafe = hasValue(metrics.proxyImplementation) ? false : /(?:slot_clear|not_proxy|none)/i.test(String(coverage.proxy || "")) ? true : null;
  const sellabilityOutcome = firstValue(metrics.sellObserved, metrics.sellVerified);
  const holderChecked = hasValue(metrics.holderCount) || hasValue(metrics.top10HolderPct)
    ? true
    : firstValue(metrics.holdersChecked, metrics.holderDistributionChecked);
  const taxChecked = firstValue(metrics.taxVerified, metrics.taxesChecked, metrics.taxChecked);
  const previousBalanceZero = firstValue(metrics.previousBalanceZero, positionProof?.totalWalletPreRaw === "0" ? true : null);
  return [
    `字节码 ${coverageMark(coverage.bytecodeCapabilities, capabilityValues.length ? !capabilityValues.some(Boolean) : null)}`,
    `Owner ${coverageMark(coverage.owner, ownerSafe)}`,
    `代理 ${coverageMark(coverage.proxy, proxySafe)}`,
    `流动性 ${coverageMark(coverage.liquidity, metrics.liquidityConfirmed)}`,
    `可卖 ${coverageMark(coverage.sellability, sellabilityOutcome)}`,
    `税费 ${coverageMark(coverage.buySellTax, taxChecked)}`,
    `持有人 ${coverageMark(coverage.holderConcentration, holderChecked)}`,
    `LP锁/烧 ${coverageMark(coverage.lpLockOrBurn, firstValue(metrics.lpLocked, metrics.lpBurned))}`,
    ...(positionProof ? [`零仓位 ${coverageMark(positionProof.status, previousBalanceZero)}`] : []),
  ].join(" · ");
}

function securityCapabilityLine(security) {
  if (!security?.metrics) return "权限/Owner/代理/可卖性均未取得";
  const metrics = security.metrics;
  const risky = Object.entries(metrics.capabilities || {}).filter(([, enabled]) => enabled === true).map(([name]) => name);
  const permissions = Object.keys(metrics.capabilities || {}).length
    ? risky.length ? `高危入口 ${risky.join("/")}` : "未检测到列举的高危入口"
    : "权限未取得";
  const owner = hasValue(metrics.owner) ? shortAddress(metrics.owner) : "未取得";
  const sellability = metrics.sellObserved === true
    ? "已见真实卖出"
    : metrics.sellSimulation && metrics.sellSimulation !== "not_available" ? String(metrics.sellSimulation) : "未验证";
  return `${permissions} · Owner ${owner} · 可卖 ${sellability}\n覆盖: ${securityCoverageMatrix(security)}`;
}

function githubClassification(event) {
  const files = event.files || [];
  const paths = files.map((file) => String(file.filename || "").toLowerCase());
  const labels = [];
  if (chainSupportEntries(event).length) labels.push("链/网络");
  const any = (pattern) => paths.some((filename) => pattern.test(filename));
  if ((event.newContracts || []).length || any(/(?:^|\/)(?:deployments?|contracts?)(?:\/|$)|\.sol$/i)) labels.push("合约/部署");
  if (any(/(?:^|\/)(?:abi|abis|artifacts?|interfaces?|typechain)(?:\/|$)|(?:^|\/)\w*abi\.(?:json|[jt]s)$/i)) labels.push("ABI");
  if (any(/(?:showcase|examples?|demo|scene|shaders?|gamefi|3d-assets?|\.gltf$)/i)) labels.push("展示");
  if (any(/(?:^|\/)(?:docs?|skills?|references?)(?:\/|$)|\.(?:md|mdx|rst)$/i)) labels.push("文档");
  if (any(/\.(?:tsx|jsx|css|scss|html)$|(?:^|\/)(?:ui|frontend|components?|pages?|app)(?:\/|$)/i)) labels.push("前端");
  return labels.length ? [...new Set(labels)].join("、") : "代码/配置";
}

function fileChangeCounts(files = []) {
  const counts = { added: 0, modified: 0, removed: 0 };
  for (const file of files) {
    const status = String(file.status || "modified").toLowerCase();
    if (["added", "created"].includes(status)) counts.added += 1;
    else if (["removed", "deleted"].includes(status)) counts.removed += 1;
    else counts.modified += 1;
  }
  return `新增 ${counts.added} · 修改 ${counts.modified} · 删除 ${counts.removed}`;
}

function verificationMark(value) {
  return value === true ? "✓" : value === false ? "✗" : "?";
}

function fomoSecurityMatrix(security) {
  const metrics = security?.metrics || {};
  const payment = firstValue(metrics.actualSpendVerified, metrics.paymentVerified);
  return `${securityCoverageMatrix(security, security?.positionProof)} · 支付 ${verificationMark(payment)}`;
}

function telegramSafeText(value, maximum = 3_850) {
  const text = String(value || "");
  return text.length > maximum ? `${text.slice(0, maximum - 12)}\n…内容已截断` : text;
}

function telegramFreshnessText(event, message) {
  if (effectiveFreshnessDecision(event) !== "late") return message;
  const lag = durationText(effectiveFreshnessLagMs(event));
  const title = String(message || "").replace(/^🚨\s*/, "");
  return `🕘 迟到补扫（延迟${lag}）｜${title}`;
}

function compactList(values = [], maximum = 3, render = (value) => value) {
  const normalized = values.map(render).filter(hasValue);
  if (!normalized.length) return "";
  const visible = normalized.slice(0, maximum);
  return `${visible.join("、")}${normalized.length > maximum ? ` 等${normalized.length}项` : ""}`;
}

function normalizedChainSupportEntry(value) {
  if (typeof value === "string") {
    const inferred = extractChainSupportSignals(`platform adds support for ${value}`)[0];
    return inferred || { id: noveltySlug(value), name: value, chainId: null, environment: "unknown" };
  }
  if (!value || typeof value !== "object") return null;
  const chainId = Number(value.chainId);
  const inferred = extractChainSupportSignals(`platform adds support for ${value.name || value.label || value.id || ""}`)[0];
  return {
    id: value.id || value.slug || inferred?.id || (Number.isSafeInteger(chainId) ? `chain-${chainId}` : noveltySlug(value.name || value.label || "")),
    name: value.name || value.label || inferred?.name || (Number.isSafeInteger(chainId) ? `Chain ID ${chainId}` : "新链（名称待确认）"),
    chainId: Number.isSafeInteger(chainId) && chainId > 0 ? chainId : inferred?.chainId || null,
    environment: ["mainnet", "testnet"].includes(value.environment) ? value.environment : inferred?.environment || "unknown",
    stage: ["configured", "announced", "supported", "deployed", "development"].includes(value.stage) ? value.stage : inferred?.stage || null,
  };
}

function chainSupportEntries(event) {
  const values = [
    ...(event.chainSupport || []),
    ...(event.signal?.chainSupport || []),
    ...(event.chainSupportChange?.chains || []),
    ...(event.changes?.newChains || []),
    ...(event.changes?.chainStageChanges || []).map((item) => item.after || item),
    ...(event.newChains || []),
  ];
  const entries = values.map(normalizedChainSupportEntry).filter(Boolean);
  return [...new Map(entries.map((item) => [`${item.id || item.name}:${item.environment}`, item])).values()];
}

function compactChainSupport(event, maximum = 3) {
  return compactList(chainSupportEntries(event), maximum, chainSupportLabel);
}

function compactCard(title, lines = []) {
  return [title, ...lines.flat().filter(hasValue).map((line) => oneLine(line, 220))].join("\n");
}

function compactEventTime(start, end) {
  const timestamp = firstValue(start, end);
  if (!hasValue(timestamp)) return "时间: 未取得";
  const delay = delayBetween(start, end);
  return `时间: ${beijingTime(timestamp)}${delay !== "未取得" ? ` · 延迟${delay}` : ""}`;
}

const CHAIN_STAGE_TEXT = {
  development: "开发中",
  configured: "已配置",
  announced: "已宣布",
  supported: "已支持",
  deployed: "已部署",
};

function platformModuleFact(value, removed = false) {
  const module = oneLine(value, 120);
  if (!module) return null;
  if (removed) return `移除 ${module}`;
  if (/vault\s*v3/i.test(module) && /erc-?20|报价资产/i.test(module)) {
    return "Vault V3 新增 ERC20 报价资产支持（具体币种待确认）";
  }
  if (/vault\s*nft|nft\s*vault/i.test(module)) return "新增 NFT Vault 模块";
  return `新增 ${module}`;
}

function nestedValue(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function capabilityValue(value, key = "") {
  if (!hasValue(value)) return "未设置";
  if (/address/i.test(key) && /^0x[a-fA-F0-9]{40}$/.test(String(value))) return shortAddress(value);
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  return oneLine(value, 48);
}

const QUOTE_CONFIG_FIELDS = [
  { path: ["fees", "buyFee"], label: "买费" },
  { path: ["fees", "sellFee"], label: "卖费" },
  { path: ["fees", "deployCost"], label: "部署费" },
  { path: ["fees", "minTradeFee"], label: "最低交易费" },
  { path: ["thresholds", "totalBAmount"], label: "募资目标" },
  { path: ["thresholds", "saleRate"], label: "销售比例" },
  { path: ["status"], label: "状态" },
  { path: ["networkCode"], label: "网络" },
  { path: ["address"], label: "合约" },
];

function quoteConfigChangeFact(change) {
  const before = change?.before || {};
  const after = change?.after || change || {};
  const symbol = change?.symbol || after.symbol || before.symbol || "报价币";
  const differences = QUOTE_CONFIG_FIELDS.flatMap(({ path, label }) => {
    const oldValue = nestedValue(before, path);
    const newValue = nestedValue(after, path);
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return [];
    return [`${label} ${capabilityValue(oldValue, path.at(-1))}→${capabilityValue(newValue, path.at(-1))}`];
  });
  return differences.length
    ? `${symbol} 配置调整：${differences.slice(0, 3).join("、")}${differences.length > 3 ? `等${differences.length}项` : ""}`
    : `${symbol} 报价配置已修改（具体字段尚未解析）`;
}

function newQuoteConfigFact(item) {
  const details = [
    hasValue(item?.fees?.buyFee) ? `买费 ${item.fees.buyFee}` : null,
    hasValue(item?.fees?.sellFee) ? `卖费 ${item.fees.sellFee}` : null,
    hasValue(item?.thresholds?.totalBAmount) ? `募资目标 ${item.thresholds.totalBAmount}` : null,
  ].filter(Boolean);
  return `新增 ${item?.symbol || "未命名"} 报价配置${details.length ? `（${details.join("、")}）` : ""}`;
}

function addressValue(...values) {
  const value = values.find((candidate) => /^0x[a-fA-F0-9]{40}$/.test(String(candidate || "")));
  return value ? String(value) : null;
}

function flapPoolParts(item = {}) {
  const factory = addressValue(
    item.factoryAddress,
    item.factory?.address,
    item.vaultFactoryAddress,
    item.vaultFactory?.address,
    item.vaultFactory,
    item.factory,
  );
  const quoteAddress = addressValue(
    item.quoteAddress,
    item.quoteTokenAddress,
    item.quoteAssetAddress,
    item.quoteToken?.address,
    item.quoteAsset?.address,
    item.quoteAsset,
    item.quoteToken,
    item.address,
  );
  const quoteSymbol = oneLine(firstValue(
    item.quoteSymbol,
    item.symbol,
    item.quoteToken?.symbol,
    item.quoteAsset?.symbol,
  ), 24);
  const category = oneLine(firstValue(
    item.category,
    item.vaultFactoryCategory,
    item.poolCategory,
    item.poolType,
    item.kind,
    item.type,
    "quote",
  ), 48);
  return { category, factory, quoteAddress, quoteSymbol };
}

function newFlapPoolFact(item) {
  const { category, factory, quoteAddress, quoteSymbol } = flapPoolParts(item);
  const quote = [quoteSymbol, quoteAddress].filter(Boolean).join(" ");
  return `新增底池: ${category}${factory ? ` · Factory ${factory}` : ""}${quote ? ` · 报价 ${quote}` : ""}`;
}

function updatedFlapPoolFact(change) {
  const before = flapPoolParts(change?.before || {});
  const after = flapPoolParts(change?.after || change || {});
  const differences = [];
  if (before.category !== after.category) differences.push(`Type ${before.category || "?"}→${after.category || "?"}`);
  if (before.factory !== after.factory) differences.push(`Factory ${before.factory || "?"}→${after.factory || "?"}`);
  const beforeQuote = [before.quoteSymbol, before.quoteAddress].filter(Boolean).join(" ") || "?";
  const afterQuote = [after.quoteSymbol, after.quoteAddress].filter(Boolean).join(" ") || "?";
  if (beforeQuote !== afterQuote) differences.push(`Quote ${beforeQuote}→${afterQuote}`);
  return `底池配置更新: ${after.category || before.category || "quote"}${differences.length ? ` · ${differences.join(" · ")}` : " · 结构化配置已变更"}`;
}

function pageName(value) {
  try {
    const url = new URL(value);
    const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || url.hostname);
    return oneLine(name.replace(/[-_]+/g, " "), 70);
  } catch {
    return oneLine(value, 70);
  }
}

function platformCapabilityFacts(event) {
  const changes = event.changes || {};
  const list = (key) => Array.isArray(changes[key]) ? changes[key] : [];
  const facts = [];

  // A Flap pool is a first-class platform capability, not a rotating token
  // card. Keep the complete technical addresses in the alert so translation
  // and Telegram delivery cannot make the pool identity ambiguous.
  const newFlapPools = list("newFlapPools");
  for (const pool of newFlapPools.slice(0, 2)) facts.push(newFlapPoolFact(pool));
  if (newFlapPools.length > 2) facts.push(`另有${newFlapPools.length - 2}个新增底池`);
  const poolChanges = list("flapPoolChanges");
  for (const change of poolChanges.slice(0, 2)) facts.push(updatedFlapPoolFact(change));
  if (poolChanges.length > 2) facts.push(`另有${poolChanges.length - 2}个底池配置更新`);
  if (!poolChanges.length) {
    const updatedFlapPools = list("updatedFlapPools");
    for (const pool of updatedFlapPools.slice(0, 2)) facts.push(updatedFlapPoolFact({ after: pool }));
    if (updatedFlapPools.length > 2) facts.push(`另有${updatedFlapPools.length - 2}个底池配置更新`);
  }

  for (const change of list("chainStageChanges")) {
    const chain = change.after || change;
    const environment = chain.environment === "testnet" ? "测试网" : chain.environment === "mainnet" ? "主网" : "网络";
    facts.push(`${chain.name || change.name || "新链"}${environment}状态：${CHAIN_STAGE_TEXT[change.fromStage] || change.fromStage || "未知"}→${CHAIN_STAGE_TEXT[change.toStage] || change.toStage || "未知"}`);
  }
  for (const chain of list("newChains")) {
    const environment = chain.environment === "testnet" ? "测试网" : chain.environment === "mainnet" ? "主网" : "网络";
    facts.push(`新增 ${chain.name || "未命名链"}${environment}支持${chain.chainId ? `（Chain ID ${chain.chainId}）` : ""}${chain.stage ? `，阶段：${CHAIN_STAGE_TEXT[chain.stage] || chain.stage}` : ""}`);
  }

  for (const module of list("newModules")) facts.push(platformModuleFact(module));
  for (const module of list("removedModules")) facts.push(platformModuleFact(module, true));

  const quoteChanges = list("quoteConfigChanges");
  for (const change of quoteChanges) facts.push(quoteConfigChangeFact(change));
  if (!quoteChanges.length) {
    const previous = new Map((event.previous?.quoteConfigs || []).map((item) => [item.symbol, item]));
    for (const after of list("updatedQuoteConfigs")) {
      facts.push(quoteConfigChangeFact({ symbol: after.symbol, before: previous.get(after.symbol), after }));
    }
  }
  const configuredSymbols = new Set(list("newQuoteConfigs").map((item) => item.symbol));
  for (const item of list("newQuoteConfigs")) facts.push(newQuoteConfigFact(item));
  for (const symbol of list("newQuoteTokens")) {
    if (!configuredSymbols.has(symbol)) facts.push(`新增 ${symbol} 作为报价资产（参数尚未取得）`);
  }

  for (const change of list("packageVersionChanges")) {
    facts.push(`${change.name || "软件包"}：${change.fromVersion || "未知版本"}→${change.toVersion || "未知版本"}`);
  }
  if (!list("packageVersionChanges").length) {
    const previous = new Map((event.previous?.packages || []).map((item) => [item.name, item.version]));
    for (const item of list("updatedPackages")) facts.push(`${item.name || "软件包"}：${previous.get(item.name) || "未知版本"}→${item.version || "未知版本"}`);
  }
  for (const item of list("newPackages")) facts.push(`新增软件包 ${item.name || "未命名"}@${item.version || "版本未取得"}`);
  for (const version of list("newVersions")) facts.push(`官方来源首次列出版本 ${version}`);
  for (const address of list("newContracts")) facts.push(`新增合约地址 ${shortAddress(address)}（角色尚未解析）`);

  const updatedPages = new Set(list("updatedPages"));
  for (const page of list("updatedPages")) facts.push(`修改文档 ${pageName(page)}`);
  for (const page of list("newPages")) if (!updatedPages.has(page)) facts.push(`新增文档 ${pageName(page)}`);
  for (const value of list("newAnnouncements")) facts.push(`新增公告 ${oneLine(String(value).replace(/^\d+:/, ""), 90)}`);
  for (const value of list("newCampaigns")) facts.push(`新增活动 ${oneLine(value, 90)}`);

  const removals = [
    ...list("removedQuoteTokens").map((value) => `移除报价资产 ${value}`),
    ...list("removedVersions").map((value) => `移除版本 ${value}`),
    ...list("removedPackages").map((value) => `移除软件包 ${value.name || value}`),
    ...list("removedContracts").map((value) => `移除合约地址 ${shortAddress(value)}`),
    ...list("removedPages").map((value) => `移除文档 ${pageName(value)}`),
    ...list("removedAnnouncements").map((value) => `移除公告 ${oneLine(String(value).replace(/^\d+:/, ""), 80)}`),
    ...list("removedCampaigns").map((value) => `移除活动 ${oneLine(value, 80)}`),
  ];
  facts.push(...removals);
  return [...new Set(facts.filter(Boolean))];
}

function platformCapabilityStage(event) {
  const changes = event.changes || {};
  const sourceText = [...(event.sources || []), event.source, event.url].filter(Boolean).join(" ").toLowerCase();
  const sourceKind = /github\.com|githubusercontent\.com/.test(sourceText)
    ? "官方代码源"
    : /docs?\.|gitbook|\/docs?(?:\/|$)/.test(sourceText)
      ? "官方文档"
      : /\/api\/|meme-api|graphql/.test(sourceText)
        ? "官方 API"
        : "官方页面";
  if (changes.chainStageChanges?.some((item) => item.toStage === "deployed") || changes.newChains?.some((item) => item.stage === "deployed")) {
    return `${sourceKind}显示为已部署；尚未独立核验链上入口`;
  }
  if (changes.newContracts?.length) return `${sourceKind}已列出地址；合约角色与实际启用尚未确认`;
  return `${sourceKind}已记录；链上部署/实际启用尚未确认`;
}

function githubKeyFiles(files = [], maximum = 3) {
  const scored = files.map((file, index) => {
    const filename = oneLine(file.filename, 100);
    let score = 0;
    if (/(?:contract|deploy|factory|router|vault|hook|strategy|migration|chain|network|config|schema|capabil|package\.json)/i.test(filename)) score += 5;
    if (/\.(?:sol|json|ya?ml|toml|mjs|ts)$/i.test(filename)) score += 2;
    if (/(?:lock|dist|build|generated|snapshot|\.map$)/i.test(filename)) score -= 5;
    return { filename, score, index };
  }).filter((item) => item.filename);
  return scored.sort((left, right) => right.score - left.score || left.index - right.index).slice(0, maximum).map((item) => item.filename);
}

function githubChangeFact(value) {
  if (!value || typeof value !== "object") return "";
  if (value.kind === "config_value") {
    return hasValue(value.before)
      ? `${value.subject} ${capabilityValue(value.before)}→${capabilityValue(value.after)}`
      : `新增配置 ${value.subject}=${capabilityValue(value.after)}`;
  }
  const labels = { contract: "合约", interface: "接口", class: "类", function: "函数" };
  const suffix = value.kind === "function" ? "()" : "";
  return `新增${labels[value.kind] || "结构"} ${value.subject || "名称未解析"}${suffix}`;
}

function githubStageText(event, official, pullRequestStage, onchainConfirmed) {
  if (pullRequestStage) return `PR #${event.pullRequest.number}${event.pullRequest?.draft ? "（草稿）" : ""} 开发中；尚未合并、尚未部署`;
  if (!official) return "候选仓库已有提交；官方归属与链上影响均未确认";
  if (onchainConfirmed) return "代码已进入官方仓库；链上影响已有独立证据";
  return "代码已进入官方仓库；是否发布、部署或启用尚未确认";
}

function twitterClaimText(value) {
  if (typeof value === "string") return oneLine(value, 150);
  if (!value || typeof value !== "object") return "";
  if (hasValue(value.before) || hasValue(value.after)) {
    const subject = oneLine(value.subject || value.field || value.object || "参数", 50);
    return `${subject}：${capabilityValue(value.before)}→${capabilityValue(value.after)}`;
  }
  return oneLine(value.text || value.summary || value.evidence || value.claim || value.object, 150);
}

function twitterKeyChanges(event) {
  const values = event.signal?.keyChanges || event.signal?.claims || event.keyChanges || [];
  return [...new Set(values.map(twitterClaimText).filter(Boolean))];
}

function twitterHeadline(event) {
  return twitterClaimText(event.signal?.headline || event.headline);
}

function twitterStageText(event) {
  const newChain = chainSupportEntries(event).length > 0;
  const source = `${event.tweet?.text || ""} ${twitterKeyChanges(event).join(" ")}`;
  if (newChain) return "官方 X 已宣布新增网络；实际部署/入口尚未独立核验";
  if (/(?:已|正式)(?:上线|启用|部署)|现已开放|\b(?:is|are)\s+(?:now\s+)?live\b|\bhas\s+been\s+deployed\b/i.test(source)) {
    return "官方 X 明示已上线；链上/合约启用尚未独立核验";
  }
  return "官方 X 已宣布；代码与链上启用状态尚未确认";
}

function ponFunChangeFacts(event) {
  const facts = Object.entries(event?.changes || {}).map(([field, change]) => {
    const value = (item) => {
      if (item == null) return "未设置";
      if (["string", "number", "boolean"].includes(typeof item)) return String(item);
      if (typeof item === "object") {
        return [item.symbol, item.ticker, item.address, item.coin, item.stockToken]
          .filter(Boolean).join("/") || "结构化值";
      }
      return String(item);
    };
    return `${field}: ${value(change?.before)} → ${value(change?.after)}`;
  });
  return facts.length ? facts.slice(0, 3).join("；") : event.summary || event.title || "已确认更新";
}

function ponFunKindLabel(kind) {
  return ({
    market_created: "新市场创建",
    market_lifecycle: "市场生命周期更新",
    factory_config: "Factory 配置更新",
    curve_params: "曲线参数更新",
    stock_listing: "股票映射更新",
    factory_paused: "Factory 暂停",
    factory_unpaused: "Factory 恢复",
    ownership_transfer_started: "所有权转移发起",
    ownership_transferred: "所有权已转移",
    platform_token_update: "平台币资料更新",
  })[kind] || "官方更新";
}

const compact = (event) => {
  if (event?.type === "gmgn_flow_surge") return renderGmgnFlowAlertLines(event, "zh").join("\n");
  if (event?.type === "genius_fun_update") return renderGeniusAlertLines(event, "zh").join("\n");
  if (isKolSelfLaunchEvent(event)) {
    const caller = event.caller || {};
    return compactCard("📣 KOL 本人发币声明（观察）", [
      `人物: @${caller.handle || event.handle || "未取得"} · X ID ${caller.xProfileId || caller.xUserId || "未取得"} · 粉丝 ${Number.isSafeInteger(caller.followers) ? caller.followers.toLocaleString("en-US") : "未取得"}`,
      `事件: 本人在 X 自述发行 ${event.tokenSymbol ? `$${event.tokenSymbol}` : "代币"} · creator 未链上核验`,
      `标的: BSC · CA ${event.token || event.contractAddress || "未取得"}`,
      compactAlertEventTime(event, event.sourceOccurredAt || event.tweet?.createdAt || event.publishedAt, event.observedAt),
    ]);
  }
  if (event.type === "narrative_trade_signal") {
    const signal = event.signal || {};
    return compactCard("🎯 AI 叙事分析", [
      `结果: ${signal.decision === "do" ? "入选" : signal.decision === "watch" ? "观察" : "未入选"} · 评分 ${signal.score ?? "—"}/100`,
      `标的: ${signal.target?.symbol || "未知"} · CA ${signal.target?.ca || "未取得"}`,
      compactAlertEventTime(event, signal.event?.asOf, event.observedAt),
    ]);
  }
  if (event.type === "fomo_monitor_health_update") {
    const label = event.transition === "recovered" ? "聚合监控恢复"
      : event.transition === "updated" ? "聚合监控故障扩大" : "聚合监控严重降级";
    return compactCard(`🩺 Fomo ${label}`, [
      `状态: ${event.aggregateStatus}`,
      `范围: Smart Money / BSC / X / Thesis / Fomo outbox`,
      compactAlertEventTime(event, event.observedAt, event.alertQueuedAt || event.observedAt),
    ]);
  }
  if (event.type === "telegram_news_update") {
    const externalHosts = [...new Set((event.news?.externalUrls || []).flatMap((value) => {
      try { return [new URL(value).hostname.toLowerCase()]; } catch { return []; }
    }))];
    return compactCard("📰 Telegram 公共频道新闻", [
      `重点: ${oneLine(event.news?.headline || "标题未取得", 180)}`,
      `内容: ${oneLine(event.news?.summary || "摘要未取得", 220)}`,
      `分类: ${oneLine(event.news?.category || "未分类", 70)}${externalHosts.length ? ` · 外链 ${compactList(externalHosts, 3)}` : ""}`,
      "来源: @maxguruai 公共频道观察；非官方来源，需以原始项目公告为准",
      compactAlertEventTime(event, event.sourceOccurredAt, event.alertQueuedAt || event.observedAt),
    ]);
  }
  if (isPonFunEvent(event)) {
    const market = event.market || event.currentSnapshot || {};
    const asset = market.symbol || event.symbol || market.ticker || event.ticker || "PONFUN";
    return compactCard(`📍 pon.fun ${ponFunKindLabel(event.kind)}`, [
      `具体更新: ${ponFunChangeFacts(event)}`,
      event.token || event.contractAddress ? `标的: ${asset} · CA ${event.token || event.contractAddress}` : `标的: ${asset}`,
      `证据: Factory ${event.factory}${event.transactionHash ? ` · Tx ${event.transactionHash}#${event.blockNumber}` : " · 官方 API 与 Factory 指纹绑定"}`,
      compactAlertEventTime(event, event.blockTimestamp || event.observedAt, event.observedAt),
    ]);
  }
  if (isMorphLaunchpadEvent(event)) {
    const platform = event.platform?.name || "Morph 发射台";
    if (event.kind === "portal_upgrade") {
      return compactCard(`🚨 ${platform} Morph 核心升级`, [
        `具体更新: Portal 实现 ${shortAddress(event.mode?.previousImplementation)} → ${shortAddress(event.mode?.implementation)}`,
        event.mode?.previousVersion || event.mode?.version
          ? `版本: ${event.mode?.previousVersion || "未取得"} → ${event.mode?.version || "未取得"}`
          : null,
        `Portal: ${event.launcher || "未取得"}`,
        "状态: 官方 Morph 合约升级已链上确认；新增功能仍待首币验证",
        compactAlertEventTime(event, event.blockTimestamp, event.observedAt),
      ]);
    }
    if (event.kind === "official_deployment") {
      return compactCard(`🌐 ${platform} Morph 官方部署`, [
        "具体更新: 官方页面首次确认 Morph 支持/部署",
        event.launcher ? `已验证入口: ${event.launcher}` : "合约入口: 官方尚未公开，链上归因保持关闭",
        "状态: 仅跟踪官方来源；不会按 LONG 同名代币猜测",
        compactAlertEventTime(event, event.blockTimestamp, event.observedAt),
      ]);
    }
    const token = event.tokens?.[0] || {};
    const metadata = token.metadata || {};
    const safety = event.security?.decision === "pass"
      ? "本地权限初筛通过；尚不等于可买"
      : `不可买/仅观察：${securitySummary(event.security)}`;
    return compactCard(`🚨 ${platform} Morph 新模式首币`, [
      `具体更新: ${event.mode?.componentMode || "官方新实现/新配置首次产生代币"}`,
      `样本: ${metadata.name || "未命名"} (${metadata.symbol || "?"}) · CA ${token.token || "未取得"}`,
      `机制: TokenVersion ${event.mode?.tokenVersion ?? "?"} · Migrator ${event.mode?.migratorType ?? "?"} · Quote ${shortAddress(event.mode?.quoteToken)}`,
      `安全: ${safety}`,
      "证据: 官方 Portal + canonical receipt；普通发币保持静默",
      compactAlertEventTime(event, event.blockTimestamp, event.observedAt),
    ]);
  }
  if (event.type === "bsc_launchpad_update") {
    if (event.kind === "new_factory" && ["official-address-api", "official-deployer-api"].includes(event.mode?.selector)) {
      return compactCard(`🚨 ${event.platform?.name || "Four.Meme"} 新 Factory`, [
        `结论: 官方地址已确认，已纳入首币/新模式监听`,
        `模块: ${event.mode?.officialName || "新发行控制器"}`,
        `Factory: ${event.launcher || "未取得"}`,
        "证据: 官方接口连续两次一致",
        compactAlertEventTime(event, event.blockTimestamp || event.timestamp, event.alertQueuedAt || event.observedAt),
      ]);
    }
    if (event.kind === "new_mode" && event.mode?.selector === "official-template") {
      const template = event.mode.template || {};
      const actions = {
        new_published_template: "新增并发布",
        template_published: "由未发布变为已发布",
        published_template_changed: "已发布机制发生变化",
      };
      const description = oneLine(template.description || "官方模板接口已确认新模式", 120);
      return compactCard("🚨 Four.Meme 发行模板变化", [
        `结论: ${actions[template.changeType] || "结构变化"}`,
        `模板: ${template.name || "未命名"} · ${template.tag || "未标注"}`,
        `机制: ${description}`,
        "证据: 官方模板接口连续两次一致",
        compactAlertEventTime(event, event.blockTimestamp || event.timestamp, event.alertQueuedAt || event.observedAt),
      ]);
    }
    if (event.kind === "new_mode" && event.mode?.selector === "official-lifecycle") {
      return compactCard("🚨 BSC 新发射玩法启用", [
        `结论: ${event.platform?.name || "待确认平台"} 首次出现新生命周期事件`,
        `事件: ${event.mode?.componentMode || event.mode?.selectorName || "未命名"}${event.mode?.tournamentId ? ` #${event.mode.tournamentId}` : ""}`,
        `合约: ${event.launcher || "未取得"}`,
        "证据: 官网、公开合约与链上事件交叉一致",
        compactAlertEventTime(event, event.blockTimestamp || event.timestamp, event.alertQueuedAt || event.observedAt),
      ]);
    }
    if (event.kind === "new_mode" && event.mode?.selector === "proxy-upgrade") {
      const shadow = event.platform?.trust === "chain_verified_prelaunch";
      const corroborated = event.platform?.trust === "multi_source_corroborated";
      return compactCard(`🚨 ${event.platform?.name || "BSC 发射台"} 组件升级`, [
        `具体更新: ${event.mode?.componentMode || "Factory/Implementation"} 实现切换为 ${event.mode?.implementation || "新地址未解析"}`,
        `合约: ${event.launcher || "未取得"}`,
        `状态: ${shadow ? "预发行原型变更，尚未正式启用" : "链上升级事件已确认；新增功能尚未解析"}`,
        `证据: ${shadow ? "源码与链上因果匹配" : corroborated ? "官网、部署清单与链上交叉一致" : "官方地址 + 链上升级事件"}`,
        compactAlertEventTime(event, event.blockTimestamp || event.timestamp, event.alertQueuedAt || event.observedAt),
      ]);
    }
    if (event.mode?.selector === "v4-hook") {
      return compactCard("🚨 BSC V4/Infinity 新发行组件", [
        "结论: 疑似新发行基础设施",
        `控制合约: ${event.launcher || "未取得"}`,
        `Hook: ${event.mode.hook || "未解析"}`,
        `证据: ${event.uniqueTokens || 0}币/${event.launchCount || 0}次发行 · ${event.mode.poolKinds?.join("+") || "单例池"} · ${event.structural?.usesCreate2 ? "CREATE2" : "CREATE"}`,
        compactAlertEventTime(event, event.blockTimestamp || event.timestamp, event.alertQueuedAt || event.observedAt),
      ]);
    }
    const isMode = event.kind === "new_mode";
    const sample = event.tokens?.[0];
    const attribution = event.attribution || {};
    const attributionLabel = {
      verified: "官方地址确认",
      corroborated: "多源链上关联",
      candidate: "候选线索（未确认）",
      ambiguous: "证据冲突（不命名）",
      unknown: "未知平台",
    }[attribution.status] || (event.platform?.trust === "official_verified" ? "官方地址确认" : "未知平台");
    const attributedPlatform = ["verified", "corroborated"].includes(attribution.status)
      ? attribution.platform
      : event.platform?.trust === "official_verified" ? event.platform : null;
    const candidateName = attribution.status === "candidate" ? attribution.platform?.name : null;
    const metadata = sample?.metadata || {};
    const pool = event.pools?.[0] || null;
    const sampleAddress = sample?.token?.toLowerCase();
    const quoteAddress = pool && sampleAddress
      ? [pool.token0, pool.token1].find((address) => address && address.toLowerCase() !== sampleAddress)
      : null;
    const poolReference = pool?.pool || pool?.poolId || event.marketContext?.pairAddress;
    const poolText = pool
      ? `${pool.kind || "池型未取得"}${hasValue(pool.fee) ? ` fee ${pool.fee}` : ""} · ${shortAddress(poolReference)}`
      : "曲线阶段/池未取得";
    const liquidityUsd = numeric(event.marketContext?.liquidityUsd);
    const liquidity = liquidityUsd !== null
      ? `${money(liquidityUsd, 2)} USD`
      : event.security?.metrics?.liquidityConfirmed === true
        ? `已确认 · 原始值 ${oneLine(event.security.metrics.liquidity || "未取得", 70)}`
        : "未确认/未取得";
    const safety = securitySummary(event.security);
    const evidence = [
      `${event.uniqueTokens} 个独立代币`,
      `${event.launchCount} 笔独立发行`,
      event.structural?.usesCreate2 ? "CREATE2" : event.structural?.usesCreate ? "CREATE" : null,
      event.mode?.poolKinds?.length ? event.mode.poolKinds.join("+") : "曲线/未建池阶段",
      event.controllerKind === "token_event_emitter" ? "代币地址关联创建事件" : null,
    ].filter(Boolean).join(" · ");
    const novelty = event.mode?.novelty || {};
    const differences = [
      novelty.implementation ? "实现合约变化" : novelty.launcherCodeHash ? "Factory 字节码变化" : null,
      novelty.selector ? `新入口 ${novelty.selector}` : null,
      novelty.presetId ? `preset ${novelty.presetId}` : null,
      novelty.quoteAsset ? `新底池 ${novelty.quoteSymbol || shortAddress(novelty.quoteAsset)}` : null,
      novelty.poolKinds?.length ? `新池型 ${novelty.poolKinds.join("+")}` : null,
      novelty.tokenCodeHash || novelty.tokenSelectorHash ? "新 Token 代码模板" : null,
      novelty.componentMode ? `新组件 ${novelty.componentMode}` : null,
      novelty.vaultFactory ? `新 VaultFactory ${shortAddress(novelty.vaultFactory)}` : null,
      novelty.creationTopics?.length ? `${novelty.creationTopics.length} 个创建事件结构` : null,
    ].filter(Boolean).join(" · ");
    const modeName = event.mode?.selectorName || event.mode?.componentMode || event.mode?.selector || "internal";
    const platformName = attributedPlatform?.name || candidateName || "平台待确认";
    const template = event.mode?.template;
    const firstTokenPassedSafety = event.security?.decision === "pass"
      && event.security?.metrics?.liquidityConfirmed === true;
    const firstTokenSafetyEvidence = firstTokenPassedSafety
      ? "首个通过本地权限与交易安全初筛的代币"
      : "仅用于识别新功能，未通过安全门槛/不可买";
    const fourMemeFeature = event.featureFirstToken && (event.mode?.presetId || event.mode?.templateId || event.mode?.quoteAsset);
    const fourMemeFeatureDetail = event.mode?.presetId || event.mode?.templateId
      ? `官方模板 ${template?.name || event.mode.componentMode || "待命名"} · ${event.mode.presetId ? `preset ${event.mode.presetId}` : `template ${event.mode.templateId}`}`
      : event.mode?.quoteAsset
        ? `官方新底池 ${event.mode.quoteSymbol || shortAddress(event.mode.quoteAsset)}`
        : null;
    const opaqueImplementationOnly = isMode
      && Boolean(novelty.implementation)
      && !novelty.selector
      && !novelty.componentMode
      && !(novelty.poolKinds || []).length
      && !novelty.tokenCodeHash
      && !novelty.tokenSelectorHash
      && !(novelty.creationTopics || []).length
      && !event.mode?.selectorName
      && !event.mode?.componentMode;
    if (opaqueImplementationOnly) {
      return compactCard(`🚨 ${platformName} Factory 实现版本变化`, [
        `具体更新: 首次观察到实现 ${shortAddress(novelty.implementation)} 通过官方 Factory 产生活动`,
        `Factory: ${event.launcher || "未取得"}`,
        `状态: 链上交易已确认；具体功能差异尚未解析，不直接称为“新模式”`,
        `证据: ${attributionLabel} · ${event.transactionHash ? String(event.transactionHash).slice(0, 12) : "交易哈希未取得"}`,
        compactAlertEventTime(event, event.timestamp || event.blockTimestamp, event.alertQueuedAt || event.detectedAt || event.observedAt),
      ]);
    }
    const heading = event.featureFirstToken
      ? `🚨 ${platformName} 新功能首币`
      : event.officialFirstToken
        ? `🚨 ${platformName} 新 Factory 首币`
        : isMode ? "🚨 BSC 发射台新模式" : "🚨 BSC 新发射台确认";
    return compactCard(heading, [
      `具体更新: ${fourMemeFeatureDetail || `${platformName} 首次出现模式 ${modeName}`}${differences && !fourMemeFeature ? ` · ${differences}` : ""}`,
      `首币: ${metadata.name || "未命名"} (${metadata.symbol || "?"}) · CA ${sample?.token || "未取得"}`,
      event.mode?.vaultFactory ? `VaultFactory: ${event.mode.vaultFactory}${event.mode.componentMode ? ` · ${event.mode.componentMode}` : ""}` : null,
      `证据: ${fourMemeFeature ? (event.mode?.presetId ? "官方 presetId 与链上 TokenCreated 精确匹配" : event.mode?.templateId ? "官方 templateId、Manager 事件与代币 API 精确匹配" : "官方报价配置与链上 _tokenInfos 精确匹配") : attributionLabel} · ${event.featureFirstToken || event.officialFirstToken ? firstTokenSafetyEvidence : evidence || "结构证据未取得"}`,
      `市场: ${poolText} · 流动性 ${liquidity}`,
      compactAlertEventTime(event, event.timestamp || event.blockTimestamp, event.alertQueuedAt || event.detectedAt || event.observedAt),
    ]);
  }
  if (event.type === "binance_official_update") {
    if (event.kind === "announcement") {
      const wallet = event.signal?.scope === "wallet" || event.project?.id === "binance-wallet";
      const socialTrading = event.signal?.category === "社交交易新功能";
      const heading = socialTrading ? "Binance Square/KOL 新功能" : wallet ? "Binance Wallet 更新" : "Binance 交易所公告";
      const facts = (event.keyChanges || []).slice(0, 2);
      return compactCard(`${event.strong ? "🚨" : "🟡"} ${heading}`, [
        `结论: ${compactList(event.signal?.labels || []) || "官方更新"}${event.changeType === "revised" ? " · 公告修订" : ""}`,
        `事件: ${oneLine(event.title || "标题未取得", 170)}`,
        facts.length ? `重点: ${compactList(facts, 2, (value) => oneLine(value, 150))}` : null,
        compactAlertEventTime(event, event.changeType === "revised" ? (event.updatedAt || event.publishedAt) : event.publishedAt, event.alertQueuedAt || event.observedAt),
      ]);
    }
    if (event.kind === "meme_rush_capability") {
      const changes = event.changes || {};
      const lines = [];
      if (changes.newProtocols?.length) lines.push(`新协议 ${compactList(changes.newProtocols, 2, (item) => `${item.name || "待确认平台"} ${item.chainId}/${item.protocol}`)}`);
      const protocolModes = [...new Set((changes.newProtocols || []).flatMap((item) => item.tokenVersions || []))];
      if (protocolModes.length) lines.push(`新模式 ${compactList(protocolModes)}`);
      if (changes.newVersions?.length) lines.push(`新版本 ${compactList(changes.newVersions, 2, (item) => `${item.protocolName || `协议${item.protocol}`} v${item.version}`)}`);
      if (changes.newSchemaKeys?.length) lines.push(`新字段 ${compactList(changes.newSchemaKeys)}`);
      return compactCard(`🚨 Binance Wallet ${event.baselineDiscovery ? "实时补漏确认" : "Meme Rush 新能力"}`, [
        "结论: 发现发射台/模式级变化",
        `变化: ${lines.slice(0, 3).join("；")}${lines.length > 3 ? `；另有${lines.length - 3}项` : ""}`,
        "过滤: 普通代币不播报",
        compactAlertEventTime(event, event.publishedAt || event.observedAt, event.alertQueuedAt || event.observedAt),
      ]);
    }
    if (event.kind === "developer_update") {
      return compactCard(`${event.strong ? "🚨" : "🟡"} Binance Developer 更新`, [
        `范围: ${compactList(event.signal?.labels || []) || "官方开发文档"}`,
        `具体更新: ${compactList(event.keyChanges || [], 3, (value) => oneLine(value, 155)) || oneLine(event.title || "内容待解析", 170)}`,
        "状态: 官方文档已发布；产品是否已向全部用户开放需以正文为准",
        compactAlertEventTime(event, event.observedAt, event.alertQueuedAt || event.observedAt),
      ]);
    }
    if (event.kind === "launchpool_capability") {
      const changes = event.changes || {};
      const lines = [];
      if (changes.newStakeAssets?.length) lines.push(`新质押资产 ${compactList(changes.newStakeAssets)}`);
      if (changes.newStatuses?.length) lines.push(`新状态 ${compactList(changes.newStatuses)}`);
      if (changes.newBuckets?.length) lines.push(`新生命周期 ${compactList(changes.newBuckets)}`);
      if (changes.newFields?.length) lines.push(`新字段 ${compactList(changes.newFields)}`);
      return compactCard("🟡 Binance Launchpool 新能力", [
        "结论: 平台能力首次变化",
        `变化: ${lines.slice(0, 3).join("；")}${lines.length > 3 ? `；另有${lines.length - 3}项` : ""}`,
        compactEventTime(event.publishedAt || event.observedAt, event.alertQueuedAt || event.observedAt),
      ]);
    }
    return compactCard("🚨 Binance 官方更新", [
      `结论: ${compactList(event.signal?.labels || []) || oneLine(event.kind || "平台能力变化", 80)}`,
      `事件: ${oneLine(event.title || event.summary || "具体内容尚未解析", 160)}`,
      "状态: 已确认来自 Binance 官方监控源；分类模板待补充",
      compactAlertEventTime(event, event.publishedAt || event.observedAt, event.alertQueuedAt || event.observedAt),
    ]);
  }
  if (event.type === "uniswap_official_update") {
    const headings = {
      blog: "🦄 Uniswap 官方发布",
      governance: "🚨 Uniswap 治理动作",
      github_release: "🚨 Uniswap 新版本",
    };
    const sourceLabels = { blog: "官方博客", governance: "治理论坛", github_release: "官方 GitHub Release" };
    const title = oneLine(event.title || "标题未取得", 150);
    const genericSummary = /官方发布高信号更新|协议级更新|详情未取得/.test(String(event.summary || ""));
    const detail = oneLine((genericSummary ? "" : event.summary) || event.description || event.factSummary, 170);
    return compactCard(headings[event.kind] || "🚨 Uniswap 官方更新", [
      `具体更新: ${title}`,
      detail && detail !== title ? `内容: ${detail}` : null,
      chainSupportEntries(event).length ? `网络: ${compactChainSupport(event)}` : null,
      `状态: ${event.stageLabel || (event.kind === "governance" ? "治理提案/讨论阶段，尚不等于已执行" : event.kind === "github_release" ? "代码版本已发布，未确认产品上线" : "官方文章已发布，实际启用待确认")}`,
      `来源: ${sourceLabels[event.kind] || event.source || "Uniswap 官方源"}${event.repository ? ` · ${event.repository}${event.tag ? ` ${event.tag}` : ""}` : ""}`,
      compactAlertEventTime(event, event.publishedAt, event.alertQueuedAt || event.observedAt),
    ]);
  }
  if (event.type === "ai_official_update") {
    const xProduct = ["x", "x-api"].includes(String(event.product?.id || event.project?.id || "").toLowerCase());
    const stageLabels = {
      preview: "预览/测试阶段",
      beta: "Beta 阶段",
      available: "官方已宣布可用",
      ga: "正式可用",
      deprecated: "已宣布弃用",
      removed: "已下线/移除",
      security: "安全更新",
      pricing: "定价更新",
      published: "官方已发布",
    };
    const sourceLabels = {
      x_api_changelog: "X API Changelog",
      xai_release_notes: "xAI Release Notes",
      xai_news: "xAI News",
    };
    return compactCard(`${event.strong ? "🚨" : "🟡"} ${xProduct ? "X" : "xAI / Grok"} 官方产品更新`, [
      `具体更新: ${oneLine(event.title || "标题未取得", 170)}`,
      event.summary && event.summary !== event.title ? `重点: ${oneLine(event.summary, 180)}` : null,
      event.identifiers?.length ? `标识: ${compactList(event.identifiers, 4)}` : null,
      `阶段: ${stageLabels[event.stage] || event.stageLabel || "以官方原文为准"}`,
      `来源: ${sourceLabels[event.source?.id] || event.source?.name || "官方来源"}`,
      compactAlertEventTime(event, event.publishedAt || event.observedAt, event.alertQueuedAt || event.observedAt),
    ]);
  }
  if (event.type === "pons_v2_factory_discovered") {
    const sources = {
      official_v2_docs: "pons v2 官方文档",
      official_v2_hook: "pons v2 官方 Hook 的链上 factory() 指针",
      pons_deployer: "pons 官方部署者链上创建",
    };
    const enabled = event.verification?.launchEnabled == null ? "待确认" : event.verification.launchEnabled ? "已开启" : "尚未开启";
    return compactCard("🚨 pons v2 新 Factory", [
      `结论: v2 接口已验证 · 发行${enabled}`,
      `Factory: ${event.factory || "未取得"}`,
      `证据: ${sources[event.source] || event.source || "来源未取得"} · ${event.verification?.selectorMatches?.length || 0}个接口特征`,
      "监控: 仅新迁移/模块，普通代币静默",
      compactAlertEventTime(event, event.blockTimestamp || event.observedAt, event.alertQueuedAt || event.observedAt),
    ]);
  }
  if (event.type === "pons_v2_factory_status_update") {
    const lines = [];
    if (event.changes?.launchEnabled) lines.push(`发行开关: ${event.changes.launchEnabled.before ? "开启" : "关闭"} → ${event.changes.launchEnabled.after ? "开启" : "关闭"}`);
    if (event.changes?.launchConfigCount) lines.push(`发行配置数: ${event.changes.launchConfigCount.before} → ${event.changes.launchConfigCount.after}`);
    return compactCard("🚨 pons v2 Factory 状态变化", [
      `结论: ${lines.join("；") || "状态结构变化"}`,
      `Factory: ${event.factory || "未取得"}`,
      "监控: 仅新迁移/模块，普通代币静默",
      compactAlertEventTime(event, event.blockTimestamp || event.observedAt, event.alertQueuedAt || event.observedAt),
    ]);
  }
  if (event.type === "platform_capability_update") {
    const facts = platformCapabilityFacts(event);
    const chainChange = Boolean(event.changes?.newChains?.length || event.changes?.chainStageChanges?.length);
    const visibleFacts = facts.slice(0, 3);
    return compactCard(`${chainChange ? "🌐" : "🧩"} ${event.platform?.name || "发射台"} 官方能力更新`, [
      `具体更新: ${visibleFacts.join("；") || "检测到来源变化，但具体内容尚未解析"}${facts.length > visibleFacts.length ? `；另有${facts.length - visibleFacts.length}项` : ""}`,
      `状态: ${platformCapabilityStage(event)}`,
      compactEventTime(event.observedAt, event.alertQueuedAt || event.observedAt),
    ]);
  }
  if (event.type === "fomo_family_top_call") {
    const integer = (value) => numeric(value)?.toLocaleString("en-US", { maximumFractionDigits: 0 }) || "未取得";
    if (event.signalKind === SMART_WALLET_SIGNAL_KIND) {
      const profile = event.walletProfile || {};
      const stats = profile.windows?.["30d"] || {};
      const profit = Number(stats.realizedProfitUsd || 0);
      const winRate = Number(stats.winRate || 0) * 100;
      const sample = Number(stats.tokenCount || 0);
      return compactCard("🔥 BSC 高收益高胜率钱包买入", [
        `画像: 30D 盈利 ${money(profit)} · 胜率 ${winRate.toFixed(1)}% · ${sample}币样本`,
        `代币: ${event.tokenSymbol || "?"} · CA ${event.token || "未取得"}`,
        `钱包: ${event.walletAddress || "未取得"} · GMGN公开画像，归属未验证`,
        `安全: ${securitySummary(event.security)} · 链上买入与零仓位已核验`,
        compactAlertEventTime(event, event.publishedAt || event.signalAt, event.observedAt || event.alertQueuedAt),
      ]);
    }
    if (event.signalKind === "fomo_x_call") {
      const caller = event.caller || {};
      const thesis = oneLine(event.thesis?.text || event.body || event.tweet?.text || "", 220) || "正文未取得";
      const observed = event.walletAttribution?.status === "observed" && event.walletAttribution?.verified === false;
      const identity = observed ? "GMGN 公开观测关联（未验证归属）" : "FomoScan 资料标记绑定";
      return compactCard("🔥 Fomo 关联 KOL X 新喊单", [
        `结论: 观察 · @${caller.handle || event.handle || "未取得"} 发布含 BSC 合约的明确喊单`,
        `观点: ${thesis}`,
        `代币: ${event.tokenSymbol || event.symbol || "?"} · BSC · CA ${event.token || event.contractAddress || "未取得"}`,
        `关联: ${event.walletAddress || "未取得"} · ${identity}`,
        "来源: X 原帖已由官方 oEmbed 核验；非 Fomo 官方发布",
        compactAlertEventTime(event, event.publishedAt || event.tweet?.createdAt, event.observedAt || event.alertQueuedAt),
      ]);
    }
    if (event.signalKind === "fomo_published_call") {
      const caller = event.caller || {};
      const thesis = oneLine(event.thesis?.text || event.body || "", 220) || "正文未取得";
      const market = event.market || {};
      const source = event.source?.trust === "official_authenticated_api" ? "Fomo 官方认证 Feed" : "FomoScan Thesis 可信中继";
      return compactCard("🔥 Fomo 热门 KOL 新喊单", [
        `结论: 观察 · 平台已发布 Trade Thesis · @${caller.handle || event.handle || "未取得"} · X 粉丝约${integer(caller.followers)}`,
        `观点: ${thesis}`,
        `代币: ${event.tokenSymbol || event.symbol || "?"} · BSC · CA ${event.token || event.contractAddress || "未取得"}`,
        `市场: 流动性 ${money(market.liquidityUsd)} · 5分钟量 ${money(market.volumeM5)} · 市值 ${money(market.marketCap)}`,
        `来源: ${source}`,
        compactAlertEventTime(event, event.publishedAt || event.thesis?.createdAt, event.observedAt || event.alertQueuedAt),
      ]);
    }
    const caller = event.caller;
    const callers = event.callers || [];
    const gmgnObservedWallet = event.walletAttribution?.scheme === "gmgn_x_maker_observation_v1"
      && event.walletAttribution?.verified === false;
    const identity = caller
      ? `${gmgnObservedWallet ? "X" : "Fomo"} @${caller.handle || "未取得"} · 关注池 #${caller.trafficRank || "?"} · X 粉丝约${integer(caller.followers)} · ${gmgnObservedWallet ? "GMGN BSC KOL feed 观测钱包（非 Fomo 验证）" : "钱包已验证绑定"}`
      : `${event.buyerCount || callers.length || "未取得"}位关联交易者共振${callers.length ? ` · ${compactList(callers, 3, (item) => `@${item.handle}`)}` : ""}`;
    const proof = event.positionProof || {};
    const exactPreTransactionZero = proof.status === "verified"
      && proof.complete === true
      && proof.phase === "immediately_before_transaction"
      && proof.totalWalletPreRaw === "0";
    const previousBlockZero = proof.status === "verified"
      && proof.phase === "previous_block"
      && firstValue(proof.totalWalletPreRaw, proof.previousBalanceRaw) === "0";
    const firstPositionLabel = exactPreTransactionZero
      ? "精确交易前零仓位首仓"
      : previousBlockZero
        ? "前一区块零仓位首仓候选"
        : "首仓候选（零仓位证明未完整）";
    const action = event.signalKind === "top_blogger_convergence"
      ? `多人首次共振买入 · 合计 ${money(event.totalUsd)}`
      : `${firstPositionLabel} · ${money(event.amountUsd)}`;
    const verification = firstValue(event.payment?.verification, event.paymentVerification, event.market?.paymentVerification, event.security?.metrics?.paymentVerification);
    const paymentAmount = firstValue(event.paymentAmount, event.payment?.amount, event.market?.paymentAmount);
    const paymentSymbol = firstValue(event.paymentSymbol, event.payment?.symbol, event.market?.paymentSymbol);
    const verifiedPayment = /(?:transfer|native_value|balance|actual|verified|official_event)/i.test(String(verification || ""));
    const paymentText = hasValue(paymentAmount) && hasValue(paymentSymbol)
      ? `${Number(paymentAmount).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${paymentSymbol}（${verifiedPayment ? "已核验" : "估算"}）`
      : `${money(event.amountUsd)}（${verifiedPayment ? "已核验" : "估算"}）`;
    const market = event.market || {};
    const publishedAt = event.publishedAt || event.signalAt;
    const deliveredAt = event.alertQueuedAt || event.observedAt;
    const proofRisk = exactPreTransactionZero
      ? "交易前零仓位已核验"
      : previousBlockZero ? "仅前一区块零仓位，精确首仓待核验" : "首仓证明不完整";
    return compactCard("🔥 FOMO BSC KOL 首次买入", [
      `结论: 观察 · ${firstPositionLabel} · ${identity}`,
      `代币: ${event.tokenSymbol || "?"} · ${event.chain?.name || event.chainId || "链未取得"} · CA ${event.token || "未取得"}`,
      `信号: ${action} · 支付 ${paymentText}`,
      `市场: 流动性 ${money(firstValue(market.liquidityUsd, market.curveReserveUsd))} · 5分钟量 ${money(market.volumeM5)} · 市值 ${money(firstValue(market.marketCap, event.marketCapAtDetection))}`,
      compactEventTime(publishedAt, deliveredAt),
    ]);
  }
  if (event.type === "twitter_update") {
    const tweet = event.tweet || {};
    const text = oneLine(tweet.text, 220);
    const changes = twitterKeyChanges(event);
    const headline = twitterHeadline(event);
    const primary = headline || changes[0] || text || "正文未取得";
    const details = changes.filter((value) => value.replace(/[.!?。！？]+$/g, "") !== primary.replace(/[.!?。！？]+$/g, ""));
    const publishedAt = tweet.createdAt;
    const discoveredAt = event.freshness?.discoveredAt || event.observedAt || event.alertQueuedAt;
    const newChain = chainSupportEntries(event).length > 0;
    const aiOfficial = event.project?.signalProfile === "ai";
    return compactCard(`${newChain ? "🌐" : "𝕏"} ${event.project?.name || tweet.authorName || "发射台"} ${newChain ? "新增链支持" : aiOfficial ? "官方产品更新" : "官方动态"}`, [
      `具体更新: ${primary}`,
      details.length ? `关键变化: ${details.slice(0, 3).join("；")}${details.length > 3 ? `；另有${details.length - 3}项` : ""}` : null,
      newChain ? `网络: ${compactChainSupport(event)}` : null,
      aiOfficial ? `类型: ${compactList(event.signal?.labels || []) || "产品/API 更新"}` : headline || changes.length ? null : `类型: ${compactList(event.signal?.labels || []) || "平台更新"}`,
      tweet.textTruncated ? "完整性: 正文补全失败，内容可能不完整" : null,
      `状态: ${twitterStageText(event)}`,
      compactAlertEventTime(event, publishedAt, discoveredAt),
    ]);
  }
  if (event.type === "early_activity_alert") {
    const entry = event.entry || {};
    const metadata = entry.metadata || {};
    const security = entry.security || (entry.securityDecision ? { decision: entry.securityDecision } : null);
    const pool = entry.pool || {};
    const quoteAddress = String(entry.quoteToken || "").toLowerCase();
    const knownQuoteSymbols = {
      "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "WETH",
      "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG",
    };
    const quoteSymbol = oneLine(entry.quoteSymbol || knownQuoteSymbols[quoteAddress] || "符号未取得", 24);
    const poolAddress = firstValue(pool.pool, pool.poolId, pool.address);
    const poolText = `${pool.kind || "池型未取得"}${hasValue(pool.fee) ? ` fee ${pool.fee}` : ""} · ${shortAddress(poolAddress)}`;
    const launchpad = entry.launchpad || {};
    const mechanism = firstValue(launchpad.model, entry.mode?.selector, entry.mode?.poolKinds?.join("+"));
    const observedAt = event.freshness?.discoveredAt || event.observedAt || event.alertQueuedAt;
    if (event.activity === "metadata_enriched") {
      const additions = Object.keys(event.additions || {});
      return compactCard("🧭 项目资料补全", [
        `项目: ${entry.name || metadata.name || "未命名"} (${entry.symbol || metadata.symbol || "?"}) · CA ${entry.token || "未取得"}`,
        `新增: ${compactList(additions) || "字段变化，具体值未解析"}`,
        compactEventTime(observedAt, event.alertQueuedAt || observedAt),
      ]);
    }
    const oneMinuteParts = [];
    if (hasValue(event.buysInMinute) || hasValue(event.sellsInMinute)) oneMinuteParts.push(`买 ${event.buysInMinute ?? "未取得"} / 卖 ${event.sellsInMinute ?? "未取得"}`);
    if (Number(event.unknownDirectionsInMinute || 0) > 0) oneMinuteParts.push(`方向未解 ${event.unknownDirectionsInMinute}`);
    if (hasValue(event.swapsInMinute)) oneMinuteParts.push(`共 ${event.swapsInMinute} 笔`);
    if (hasValue(event.volumeInMinute)) oneMinuteParts.push(`${numeric(event.volumeInMinute)?.toLocaleString("en-US", { maximumFractionDigits: 4 }) ?? event.volumeInMinute} ${quoteSymbol}`);
    const fiveMinuteParts = [];
    if (hasValue(event.buysInFiveMinutes) || hasValue(event.sellsInFiveMinutes)) fiveMinuteParts.push(`买 ${event.buysInFiveMinutes ?? "未取得"} / 卖 ${event.sellsInFiveMinutes ?? "未取得"}`);
    if (Number(event.unknownDirectionsInFiveMinutes || 0) > 0) fiveMinuteParts.push(`方向未解 ${event.unknownDirectionsInFiveMinutes}`);
    if (hasValue(event.swapsInFiveMinutes)) fiveMinuteParts.push(`共 ${event.swapsInFiveMinutes} 笔`);
    if (hasValue(event.volumeInFiveMinutes)) fiveMinuteParts.push(`${numeric(event.volumeInFiveMinutes)?.toLocaleString("en-US", { maximumFractionDigits: 4 }) ?? "成交量未取得"} ${quoteSymbol}`);
    const triggerCriteria = event.stageCriteria?.swaps != null && event.stageCriteria?.volume != null
      ? `门槛 ≥${event.stageCriteria.swaps}笔/≥${numeric(event.stageCriteria.volume)?.toLocaleString("en-US", { maximumFractionDigits: 4 }) ?? event.stageCriteria.volume} ${quoteSymbol}`
      : "门槛未取得";
    const acceleration = hasValue(event.volumeAcceleration)
      ? ` · 加速${numeric(event.volumeAcceleration)?.toLocaleString("en-US", { maximumFractionDigits: 2 }) ?? event.volumeAcceleration}倍`
      : "";
    return compactCard(`📈 早期量能异动 L${event.stage ?? "?"}`, [
      `结论: 观察，量能不是买点 · ${entry.name || metadata.name || "未命名"} (${entry.symbol || metadata.symbol || "?"}) · CA ${entry.token || "未取得"}`,
      `发射台: ${launchpad.name || "未确认"} · ${mechanism || "机制未取得"} · 池 ${poolText}`,
      `1分钟: ${oneMinuteParts.join(" · ") || "数据未取得"}${acceleration} · ${triggerCriteria}`,
      fiveMinuteParts.length ? `5分钟: ${fiveMinuteParts.join(" · ")}` : null,
      compactAlertEventTime(event, event.latestSwapAt || observedAt, observedAt),
    ]);
  }
  if (event.type === "official_activity") {
    const labels = { burn: "🔥 Robinhood 官方资产销毁", buy: "🟢 官方地址买入", sell: "🔴 官方地址卖出" };
    const decimals = event.tokenMetadata?.decimals ?? 18;
    const display = Number(event.amount) / (10 ** Number(decimals));
    return compactCard(labels[event.activity] || "🏛 官方地址行为", [
      `项目: ${event.project || "未取得"} · ${event.role || "官方地址"}`,
      `代币: ${event.tokenMetadata?.symbol || event.tokenMetadata?.name || "?"} · CA ${event.token || "未取得"}`,
      `数量: ${Number.isFinite(display) ? display.toLocaleString("en-US", { maximumFractionDigits: 6 }) : event.amount}`,
      `地址: ${event.actor || event.to || event.from || "未取得"}`,
      compactAlertEventTime(event, event.blockTimestamp || event.timestamp, event.alertQueuedAt || event.observedAt),
    ]);
  }
  if (event.type === "github_module_update") {
    const files = event.files || [];
    const official = event.sourceTrust === "official_verified" || event.verification?.status === "official_verified";
    const classification = githubClassification(event);
    const onchainConfirmed = event.chainImpact?.confirmed === true || event.onchainConfirmed === true;
    const pullRequestStage = event.developmentStage === "pull_request" && Number.isSafeInteger(Number(event.pullRequest?.number));
    const chainSupport = chainSupportEntries(event);
    const newChain = chainSupport.length > 0 || event.chainSupportChange?.candidate === true;
    const committedAt = event.committedAt;
    const discoveredAt = event.freshness?.discoveredAt || event.alertQueuedAt || event.observedAt;
    const aiOfficial = event.xaiOfficial === true;
    const title = newChain
      ? `${pullRequestStage ? "🧪" : "🌐"} ${event.launchpad || "发射台"} 新链${pullRequestStage ? "开发 PR" : "代码更新"}`
      : pullRequestStage
      ? `🧪 ${event.launchpad || "发射台"} 新功能开发 PR`
      : aiOfficial ? `🧠 ${event.launchpad || "xAI / Grok"} 官方代码更新`
        : isBinancePlatformEvent(event) ? "🟡 Binance Wallet 代码更新" : official ? `🧱 ${event.launchpad || "发射台"} 官方代码更新` : `🕵️ ${event.launchpad || "发射台"} 未认证代码线索`;
    const keyFiles = githubKeyFiles(files);
    const changeFacts = [
      ...(event.changeEvidence || []).map(githubChangeFact),
      ...(event.newContracts || []).map((address) => `新增合约地址 ${shortAddress(address)}（角色未解析）`),
    ].filter(Boolean);
    return compactCard(title, [
      `具体更新: ${oneLine(event.message || "提交说明未取得", 170)}`,
      aiOfficial && event.productChange?.labels?.length ? `类型: ${compactList(event.productChange.labels, 4)}` : null,
      aiOfficial && event.productChange?.identifiers?.length ? `标识: ${compactList(event.productChange.identifiers, 4)}` : null,
      newChain ? `网络: ${compactChainSupport(event) || "名称待代码进一步确认"}` : null,
      !newChain && changeFacts.length ? `关键差异: ${compactList(changeFacts, 3)}` : null,
      `范围: ${classification}${keyFiles.length ? ` · ${compactList(keyFiles, 3)}` : ` · ${fileChangeCounts(files)}`}`,
      `状态: ${githubStageText(event, official, pullRequestStage, onchainConfirmed)}`,
      `证据: ${event.repository || "仓库未取得"}${pullRequestStage ? ` · PR #${event.pullRequest.number}` : `#${String(event.commit || "未取得").slice(0, 8)}`}`,
      compactAlertEventTime(event, committedAt, discoveredAt),
    ]);
  }
  if (event.type === "github_monitor_gap") {
    return compactCard("⚠️ GitHub 提交缺口", [
      `仓库: ${event.repository || "未取得"}`,
      `范围: ${String(event.gap?.previousSha || "?").slice(0, 8)} → ${String(event.gap?.newestSha || "?").slice(0, 8)} · 已拉取${event.gap?.fetchedCommits ?? "?"}条`,
      "处理: 已追补并记录，不会假装连续覆盖",
      compactEventTime(event.observedAt, event.alertQueuedAt || event.observedAt),
    ]);
  }
  if (event.type === "github_repository_discovered") {
    const official = event.sourceTrust === "official_verified";
    const metadata = event.repositoryMetadata || {};
    const repositoryName = String(event.repository || "未取得").split("/").at(-1);
    return compactCard(`🔎 ${event.launchpad || "发射台"} ${official ? "官方新增仓库" : "仓库候选"}`, [
      `具体更新: ${official ? "官方组织新增" : "发现候选"} GitHub 仓库 ${repositoryName}`,
      `用途: ${oneLine(metadata.description || event.description || "仓库说明未填写，具体功能尚未解析", 160)}`,
      metadata.createdAt ? `创建: ${beijingTime(metadata.createdAt)}` : null,
      `状态: ${official ? "官方归属已确认；是否发布、部署或启用尚未确认" : "官方归属尚未交叉认证"}`,
      compactAlertEventTime(event, metadata.createdAt || event.createdAt, event.alertQueuedAt || event.observedAt),
    ]);
  }
  if (event.type === "github_repository_verified") {
    const platform = event.launchpadName || event.launchpad || "发射台";
    const source = event.evidence?.source === "official_x" ? `${platform} 官方 X` : `${platform} 官方文档/官网`;
    return compactCard(`✅ ${platform} GitHub 已认证`, [
      `仓库: ${event.repository || "未取得"}`,
      `证据: ${source}`,
      "处理: 已纳入15秒高优先级代码监控",
      compactEventTime(event.observedAt, event.alertQueuedAt || event.observedAt),
    ]);
  }
  if (event.type === "launchpad_site_update") {
    const profile = event.launchpad || {};
    const changes = [];
    if (event.newChains?.length) changes.push(`官网新增网络 ${compactChainSupport(event)}`);
    if (event.newSocials?.length) changes.push(`官网新增官方外链 ${compactList(event.newSocials, 2)}`);
    if (event.newContracts?.length) changes.push(`官网新增合约地址 ${compactList(event.newContracts, 2, shortAddress)}（角色尚未解析）`);
    if (event.newFeatures?.length) changes.push(`官网首次列出功能 ${compactList(event.newFeatures)}`);
    if (event.newPages?.length) changes.push(`官网新增页面 ${compactList(event.newPages, 2, pageName)}`);
    if (event.newKeywords?.length) changes.push(`页面首次出现 ${compactList(event.newKeywords)}（具体功能尚未解析）`);
    if (event.newAssets?.length) changes.push(`前端资源新增 ${event.newAssets.length}项（功能差异尚未解析）`);
    return compactCard(`🌐 ${profile.name || "发射台"} ${event.newChains?.length ? "新增链支持" : "官网变化"}`, [
      `具体更新: ${changes.slice(0, 3).join("；") || "检测到页面变化，但具体内容尚未解析"}${changes.length > 3 ? `；另有${changes.length - 3}项` : ""}`,
      "状态: 官方页面已变化；链上部署/实际启用尚未确认",
      compactEventTime(event.observedAt, event.alertQueuedAt || event.observedAt),
    ]);
  }
  const profile = event.launchpad;
  if (event.type === "token_launch") {
    const token = event.tokens?.[0] || {};
    const metadata = token.metadata || {};
    const security = event.security;
    const gap = event.gmgnStatus === "gmgn_gap_candidate" ? " · GMGN未集成候选" : "";
    const mode = event.modeStatus === "new_mode_candidate"
      ? `新模式: ${event.modeDifference?.current?.selector || event.mode?.selector || "入口未取得"}/${(event.modeDifference?.current?.poolKinds || event.mode?.poolKinds || []).join("+") || "池型未取得"}`
      : null;
    const discovery = event.factoryStatus === "new_candidate"
      ? event.launcherAnalysis?.classification === "single_project_launcher"
        ? "🧪 Robinhood 单项目启动合约"
        : "🔭 Robinhood 可复用发射台候选"
      : isConfirmedReusableLaunchpad(event)
        ? "✅ Robinhood 可复用发射台确认"
      : "🚀 Robinhood 新模式发射";
    const evidence = event.launcherAnalysis ? [event.launcherAnalysis.usesCreate2 && "CREATE2", event.launcherAnalysis.selectorSimilarity >= 0.2 && `Factory相似度 ${(event.launcherAnalysis.selectorSimilarity * 100).toFixed(1)}%`, event.launcherAnalysis.codeSize >= 10_000 && `平台级代码 ${event.launcherAnalysis.codeSize}B`, (metadata.website || metadata.twitter) && "公开资料"].filter(Boolean).join(" · ") : "";
    const chainTime = event.timestamp || event.blockTimestamp;
    const discoveredAt = event.freshness?.discoveredAt || event.alertQueuedAt || event.observedAt;
    return compactCard(discovery, [
      `代币: ${metadata.name || "未命名"} (${metadata.symbol || "?"}) · CA ${token.token || "未取得"}${gap}`,
      `发射台: ${profile?.name || "未知候选"} · ${profile?.model || event.mode?.selector || "机制未取得"}`,
      event.launcherAnalysis || mode ? `证据: ${event.launcherAnalysis ? evidence || `${event.launcherAnalysis.selector || "入口未取得"} · 相似度 ${(event.launcherAnalysis.selectorSimilarity * 100).toFixed(1)}%` : "结构差异已确认"}${mode ? ` · ${mode}` : ""}` : null,
      compactAlertEventTime(event, chainTime, discoveredAt),
    ]);
  }
  const candidate = event.earlyLaunchpad?.candidate;
  return compactCard(candidate ? "🚨 疑似早期发射台部署" : "🧩 Robinhood 新合约", [
    `结论: ${candidate ? "观察 · 待交叉确认" : "普通部署记录"}`,
    `合约: ${event.contract || "未取得"}`,
    `部署者: ${event.deployer || "未取得"}`,
    candidate ? `证据: 评分 ${event.earlyLaunchpad.score ?? "?"} · 相似度 ${event.earlyLaunchpad.selectorSimilarity ?? "?"}` : null,
    `发射台: ${profile?.name || "未知"}`,
    compactAlertEventTime(event, event.blockTimestamp || event.timestamp, event.alertQueuedAt || event.observedAt),
  ]);
};

const TRUSTED_GITHUB_PULL_REQUEST_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function isUntrustedOpenGithubPullRequest(event) {
  if (event?.type !== "github_module_update") return false;
  const pullRequest = event.pullRequest;
  if (event.developmentStage !== "pull_request" && !pullRequest) return false;
  const state = String(pullRequest?.state || event.pullRequestState || "open").trim().toUpperCase();
  if (state !== "OPEN") return false;
  const association = String(
    pullRequest?.authorAssociation
      || pullRequest?.author_association
      || event.authorAssociation
      || event.author_association
      || "",
  ).trim().toUpperCase();
  return !TRUSTED_GITHUB_PULL_REQUEST_ASSOCIATIONS.has(association);
}

function isBinanceOfficialProductFeature(event) {
  const classification = String(
    event?.developerChange?.classification
      || event?.binanceChange?.classification
      || "",
  ).trim().toLowerCase();
  if (classification === "product_feature") {
    return event?.developerChange?.productFeature === true
      || event?.binanceChange?.productFeature === true
      || event?.productFeature === true;
  }
  // Agent OS / Agent Native is an actual Binance product surface, not a
  // connector release. The developer monitor already assigns this exact
  // category from Binance's official product documentation.
  return String(event?.signal?.category || "").trim().toLowerCase() === "agent_native";
}

function isRelevantBinanceOfficialUpdate(event) {
  if (event?.type !== "binance_official_update") return false;
  if (["announcement", "meme_rush_capability", "launchpool_capability"].includes(event.kind)) return true;
  if (event.kind === "developer_update") return isBinanceOfficialProductFeature(event);
  return false;
}

function isRelevantBinanceGithubUpdate(event) {
  if (event?.type !== "github_module_update" || !isBinancePlatformEvent(event)) return false;
  const classification = String(event?.binanceChange?.classification || "").trim().toLowerCase();
  return event?.sourceTrust === "official_verified"
    && classification === "product_feature"
    && event?.binanceChange?.productFeature === true;
}

export function isStrongAlert(event) {
  if (event?.type === "gmgn_flow_surge") return false;
  if (event?.type === "genius_fun_update") return isGeniusOfficialEvent(event) && !isGeniusHistorical(event) && event.strong === true;
  if (isKolSelfLaunchEvent(event)) return false;
  if (event?.type === "fomo_monitor_health_update") return false;
  if (event?.type === "telegram_news_update") return false;
  if (["late", "suppress"].includes(effectiveFreshnessDecision(event))) return false;
  if (event?.type === "narrative_trade_signal") return event.signal?.decision === "do";
  // New outbox entries carry a deterministic trading tier. The tier, rather
  // than translated wording or an LLM summary, controls Telegram sound and
  // the five-second critical path. Pending legacy entries are intentionally
  // handled by the old rules below until drainAlertOutbox maps them once.
  if (isTradingPriority(event?.tradingPriority)) {
    return ["T0", "T1"].includes(event.tradingPriority.tier);
  }
  if (isPonFunEvent(event)) return PON_FUN_STRONG_KINDS.has(event.kind);
  if (isPonFunTwitterEvent(event)) return event.signal?.ponPriority === "T1"
    && event.signal?.majorProductUpdate === true;
  // Open pull requests are useful early evidence, but only organization-owned
  // work receives a loud notification. Community and unattributed PRs still
  // pass the relevance gate and are delivered as ordinary alerts.
  if (isUntrustedOpenGithubPullRequest(event)) return false;
  // Flap and Four.Meme are the active focus platforms: every event that passes
  // the relevance gate is delivered as a non-silent strong alert. Ordinary
  // token launches still fail the relevance gate and remain quiet.
  if (isFocusPlatformEvent(event) && isRelevantAlert(event)) return true;
  if (event.type === "binance_official_update") return isRelevantBinanceOfficialUpdate(event) && event.strong === true;
  if (event.type === "uniswap_official_update") return event.strong === true;
  if (event.type === "ai_official_update") return event.strong === true;
  if (isMorphLaunchpadEvent(event)) return event.strong === true;
  if (event.type === "bsc_launchpad_update") return true;
  if (event.type === "fomo_family_top_call") return true;
  if (event.type === "pons_v2_factory_discovered") return true;
  if (event.type === "pons_v2_factory_status_update") return true;
  if (event.type === "platform_capability_update") {
    return isFocusPlatformEvent(event) && STRONG_PLATFORM_CHANGE_KEYS.some((key) => event.changes?.[key]?.length);
  }
  if (event.type === "github_module_update") {
    if (event.sourceTrust === "unverified_candidate") return false;
    if (event.xaiOfficial === true) return event.strong === true;
    if (isUniswapPlatformEvent(event)) return event.strong === true;
    if (isBinancePlatformEvent(event)) return isRelevantBinanceGithubUpdate(event) && Boolean(event.modeChange?.candidate || event.strong);
    return isFocusPlatformEvent(event) || Boolean(event.modeChange?.candidate);
  }
  if (event.type === "github_repository_verified") return true;
  if (event.type === "github_monitor_gap") return isFocusPlatformEvent(event);
  if (event.type === "github_repository_discovered") return (isFocusPlatformEvent(event) || isUniswapPlatformEvent(event)) && event.sourceTrust !== "unverified_candidate";
  if (event.type === "launchpad_site_update") {
    const structural = Boolean(event.newContracts?.length || event.newKeywords?.length || event.newFeatures?.length || event.newPages?.length || event.newChains?.length);
    return structural && (isFocusPlatformEvent(event) || (isUniswapPlatformEvent(event) && event.newChains?.length));
  }
  if (event.type === "twitter_update") {
    if (event.project?.signalProfile === "ai") return event.signal?.strong === true;
    if (isBinancePlatformEvent(event)) return Boolean(
      event.signal?.strong
      || event.signal?.labels?.includes("Meme Rush 新平台/新模式")
      || binanceAgentNativeNovelty(event)?.stage === "launch"
    );
    if (isUniswapPlatformEvent(event)) return event.signal?.strong === true;
    if (eventPlatform(event) === "long") {
      return event.signal?.strong === true
        && (event.signal?.chainSupport || []).some((chain) => Number(chain.chainId) === 2818 || String(chain.id || "").toLowerCase() === "morph");
    }
    return isFocusPlatformEvent(event) && event.signal?.labels?.some((label) => PLATFORM_TWITTER_SIGNALS.has(label));
  }
  if (["official_activity", "early_activity_alert", "contract_deployed", "token_launch"].includes(event.type)) return isImportantRobinhoodEvent(event);
  return false;
}

async function postJson(url, body, headers = {}, options = {}) {
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(1, Math.floor(requestedTimeout))
    : 10_000;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`alert request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  let response;
  let responseText;
  try {
    ({ response, responseText } = await Promise.race([
      (async () => {
        const fetched = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = typeof fetched.text === "function" ? await fetched.text() : "";
        return { response: fetched, responseText: text };
      })(),
      timeout,
    ]));
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let description = "";
    try { description = JSON.parse(responseText)?.description || ""; }
    catch { description = responseText.slice(0, 160); }
    throw new Error(`alert returned HTTP ${response.status}${description ? `: ${description}` : ""}`);
  }
  if (!responseText) {
    if (options.requireTelegramReceipt) throw new Error("Telegram returned an empty response");
    return null;
  }
  try {
    const payload = JSON.parse(responseText);
    if (payload?.ok === false) throw new Error(`alert API rejected request: ${payload.description || "unknown error"}`);
    if (options.requireTelegramReceipt && (payload?.ok !== true || payload?.result?.message_id === undefined)) {
      throw new Error("Telegram response missing ok=true or message_id");
    }
    return payload;
  } catch (error) {
    if (error instanceof SyntaxError && !options.requireTelegramReceipt) return null;
    if (error instanceof SyntaxError) throw new Error("Telegram returned non-JSON content");
    throw error;
  }
}

function safeFailureMessage(reason, secrets) {
  let message = reason instanceof Error ? reason.message : String(reason);
  message = message.replace(/https?:\/\/\S+/gi, "[redacted-url]");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) message = message.split(secret).join("[redacted]");
  }
  return message.slice(0, 500) || "unknown delivery error";
}

export class AlertDeliveryError extends Error {
  constructor(eventType, failures) {
    super(`Alert delivery failed for ${eventType}: ${failures.map(({ destination, message }) => `${destination} (${message})`).join("; ")}`);
    this.name = "AlertDeliveryError";
    this.eventType = eventType;
    this.destinations = failures.map(({ destination }) => destination);
    this.failures = failures;
  }
}

const copyButton = (address, text = "📋 一键复制合约") => address
  ? { text, copy_text: { text: address } }
  : null;

function absoluteTweetUrl(tweet = {}) {
  const value = String(tweet.url || "").trim();
  if (/^https:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `https://x.com${value}`;
  if (tweet.handle && tweet.id) return `https://x.com/${tweet.handle}/status/${tweet.id}`;
  return "https://x.com";
}

export function telegramButtons(event) {
  if (event?.type === "gmgn_flow_surge") {
    if (!isGmgnFlowEvent(event)) return { inline_keyboard: [] };
    return { inline_keyboard: [
      [{ text: "查看 GMGN | View token", url: event.source.url }, copyButton(event.token.address)],
      ...(event.narrative.sourceUrl && event.narrative.sourceUrl !== event.source.url
        ? [[{ text: "叙事出处 | Narrative source", url: event.narrative.sourceUrl }]] : []),
    ] };
  }
  if (event?.type === "genius_fun_update") {
    return { inline_keyboard: isGeniusOfficialEvent(event)
      ? [[{ text: "查看官方来源 | Official source", url: event.sourceUrl }], [{ text: "Genius.fun", url: "https://genius.fun" }]] : [] };
  }
  if (event.type === "telegram_news_update") {
    const messageId = String(event.messageId || "");
    const numericMessageId = Number(messageId);
    const expectedUrl = `https://t.me/maxguruai/${messageId}`;
    const validMessage = /^[1-9]\d*$/.test(messageId)
      && Number.isSafeInteger(numericMessageId)
      && String(numericMessageId) === messageId
      && event.messageUrl === expectedUrl;
    return { inline_keyboard: validMessage ? [[{ text: "查看原消息", url: expectedUrl }]] : [] };
  }
  if (isStrictFourRegistryFirstTokenUpdate(event)) {
    return { inline_keyboard: [
      [copyButton(event.token.address, "📋 复制首个 TokenCreated CA")].filter(Boolean),
      [{ text: "🔍 查看 Core TokenCreated", url: `https://bscscan.com/tx/${event.transactionHash}` }],
    ].filter((row) => row.length) };
  }
  if (isStrictFourRegistryCapabilityUpdate(event)) {
    return { inline_keyboard: [
      [copyButton(event.registry, "📋 复制 OpenFour Registry")].filter(Boolean),
      [{ text: "🔍 查看 Registry 交易", url: `https://bscscan.com/tx/${event.transactionHash}` }],
    ].filter((row) => row.length) };
  }
  if (isPonFunEvent(event)) {
    const rows = [
      [copyButton(event.token || event.contractAddress, "📋 复制 Pon 标的")].filter(Boolean),
      [copyButton(event.factory, "📋 复制 pon.fun Factory")].filter(Boolean),
    ];
    const evidence = [];
    if (httpsUrl(event.explorerUrl)) evidence.push({ text: "🔍 查看链上证据", url: event.explorerUrl });
    else if (httpsUrl(event.source?.url)) evidence.push({ text: "📡 查看官方 API", url: event.source.url });
    evidence.push({ text: "🌐 pon.fun", url: "https://www.pon.fun/" });
    if (evidence.length) rows.push(evidence.slice(0, 2));
    rows.push([{ text: "𝕏 @pondotfun", url: "https://x.com/pondotfun" }]);
    return { inline_keyboard: rows.filter((row) => row.length) };
  }
  const token = event.type === "token_launch" ? event.tokens?.[0]?.token : null;
  if (event.type === "early_activity_alert") {
    const entryToken = event.entry?.token;
    const rows = [[copyButton(entryToken)].filter(Boolean)];
    const links = [];
    if (entryToken && (event.entry?.security?.decision || event.entry?.securityDecision) === "pass") links.push({ text: "📈 打开 GMGN", url: `https://gmgn.ai/robinhood/token/${entryToken}` });
    const explorer = httpsUrl(event.explorerUrl, event.entry?.launchExplorerUrl);
    if (explorer) links.push({ text: "🔍 查看池/交易", url: explorer });
    if (links.length) rows.push(links.slice(0, 2));
    return { inline_keyboard: rows.filter((row) => row.length) };
  }
  if (event.type === "twitter_update") {
    const exactTweetUrl = absoluteTweetUrl(event.tweet);
    if (isStrictFourMemeMarketCampaign(event)) {
      return { inline_keyboard: [[{ text: "𝕏 查看原推", url: exactTweetUrl }]] };
    }
    const rows = [[{ text: "𝕏 查看原推", url: exactTweetUrl }]];
    const official = [];
    const projectTwitter = httpsUrl(event.project?.twitter);
    const website = httpsUrl(event.project?.website);
    const docs = httpsUrl(event.project?.docs);
    if (projectTwitter && projectTwitter !== exactTweetUrl) official.push({ text: "𝕏 项目官方", url: projectTwitter });
    if (website) official.push({ text: "🌐 项目官网", url: website });
    if (official.length) rows.push(official.slice(0, 2));
    if (docs) rows.push([{ text: "📘 官方文档", url: docs }]);
    const externalLinks = [...new Set((event.tweet?.expandedUrls || [])
      .filter((url) => /^https:\/\//i.test(String(url || ""))
        && !/^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(String(url))))]
      .filter((url) => ![projectTwitter, website, docs].includes(url))
      .slice(0, 2);
    if (externalLinks.length) rows.push(externalLinks.map((url, index) => ({ text: `🔗 外链${externalLinks.length > 1 ? index + 1 : ""}`, url })));
    return { inline_keyboard: rows };
  }
  if (event.type === "uniswap_official_update") {
    const rows = [];
    if (httpsUrl(event.url)) rows.push([{ text: "📘 查看官方原文", url: event.url }]);
    const links = [{ text: "𝕏 Uniswap", url: "https://x.com/Uniswap" }];
    if (event.kind === "blog" || /(?:launch|pool)/i.test(`${event.title || ""} ${event.summary || ""}`)) {
      links.push({ text: "🚀 Pools.trade", url: "https://pools.trade" });
    }
    rows.push(links.slice(0, 2));
    return { inline_keyboard: rows };
  }
  if (event.type === "ai_official_update") {
    const rows = [];
    if (httpsUrl(event.url)) rows.push([{ text: "📘 查看官方原文", url: event.url }]);
    const productId = String(event.product?.id || event.project?.id || "").toLowerCase();
    if (["x", "x-api"].includes(productId)) {
      rows.push([
        { text: "𝕏 X API", url: "https://x.com/API" },
        { text: "🧪 X Docs", url: "https://docs.x.com/changelog" },
      ]);
    } else {
      rows.push([
        { text: "𝕏 xAI", url: "https://x.com/SpaceXAI" },
        { text: "🧠 xAI Docs", url: "https://docs.x.ai/developers/release-notes" },
      ]);
    }
    return { inline_keyboard: rows };
  }
  if (event.type === "fomo_family_top_call") {
    if (isKolSelfLaunchEvent(event)) {
      if (!verifyKolTokenLaunchEvent(event).valid) return { inline_keyboard: [] };
      const rows = [[copyButton(event.token || event.contractAddress, "📋 复制声明 CA")].filter(Boolean)];
      const evidence = [];
      const tweetUrl = absoluteTweetUrl(event.tweet || {});
      if (httpsUrl(tweetUrl)) evidence.push({ text: "𝕏 查看本人声明", url: tweetUrl });
      if (httpsUrl(event.explorerUrl)) evidence.push({ text: "📄 查看合约", url: event.explorerUrl });
      if (evidence.length) rows.push(evidence.slice(0, 2));
      const backgroundUrl = httpsUrl(event.caller?.background?.sourceUrl, event.caller?.twitter);
      if (backgroundUrl) rows.push([{ text: "👤 查看背景来源", url: backgroundUrl }]);
      return { inline_keyboard: rows.filter((row) => row.length) };
    }
    const rows = [[copyButton(event.token)].filter(Boolean)];
    if (event.signalKind === SMART_WALLET_SIGNAL_KIND) {
      const links = [];
      if (/^0x[0-9a-f]{40}$/i.test(String(event.token || ""))) links.push({ text: "📈 一键打开 GMGN", url: `https://gmgn.ai/bsc/token/${event.token}` });
      if (/^0x[0-9a-f]{64}$/i.test(String(event.transactionHash || ""))) links.push({ text: "🔍 查看交易", url: `https://bscscan.com/tx/${event.transactionHash}` });
      if (links.length) rows.push(links.slice(0, 2));
      if (event.walletAddress) rows.push([copyButton(event.walletAddress, "📋 复制监控钱包")].filter(Boolean));
      return { inline_keyboard: rows.filter((row) => row.length) };
    }
    if (event.signalKind === "fomo_x_call") {
      const links = [];
      if (event.token) links.push({ text: "📈 一键打开 GMGN", url: `https://gmgn.ai/${event.chain?.gmgn || "bsc"}/token/${event.token}` });
      const tweetUrl = absoluteTweetUrl(event.tweet || {});
      if (httpsUrl(tweetUrl)) links.push({ text: "𝕏 查看喊单原帖", url: tweetUrl });
      if (links.length) rows.push(links.slice(0, 2));
      if (event.walletAddress) {
        const verified = event.walletBinding?.status === "verified" && event.walletBinding?.verified === true;
        rows.push([copyButton(event.walletAddress, verified ? "📋 复制绑定钱包" : "📋 复制观测地址")].filter(Boolean));
      }
      if (httpsUrl(event.explorerUrl)) rows.push([{ text: "📄 查看合约", url: event.explorerUrl }]);
      return { inline_keyboard: rows.filter((row) => row.length) };
    }
    if (event.signalKind === "fomo_published_call") {
      const marketLinks = [];
      if (event.token) marketLinks.push({ text: "📈 一键打开 GMGN", url: `https://gmgn.ai/${event.chain?.gmgn || "bsc"}/token/${event.token}` });
      const fomoUrl = httpsUrl(event.fomoUrl, event.profileUrl);
      if (fomoUrl) marketLinks.push({ text: "👀 在 Fomo 打开", url: fomoUrl });
      if (marketLinks.length) rows.push(marketLinks.slice(0, 2));
      if (httpsUrl(event.explorerUrl)) rows.push([{ text: "📄 查看合约", url: event.explorerUrl }]);
      const twitter = event.caller?.twitter;
      if (/^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(twitter || "")) rows.push([{ text: "𝕏 查看 KOL", url: twitter }]);
      return { inline_keyboard: rows.filter((row) => row.length) };
    }
    if (event.walletAddress) rows.push([copyButton(event.walletAddress, "📋 复制交易钱包")].filter(Boolean));
    const marketLinks = [];
    if (httpsUrl(event.transactionUrl)) marketLinks.push({ text: "🔍 查看交易", url: event.transactionUrl });
    if (event.chain?.gmgn && event.token) marketLinks.push({ text: "📈 一键打开 GMGN", url: `https://gmgn.ai/${event.chain.gmgn}/token/${event.token}` });
    if (marketLinks.length) rows.push(marketLinks.slice(0, 2));
    if (httpsUrl(event.explorerUrl) && event.explorerUrl !== event.transactionUrl) rows.push([{ text: "📄 查看合约", url: event.explorerUrl }]);
    const sourceLinks = [];
    if (/^https:\/\/fomo\.family\//i.test(event.fomoUrl || "")) sourceLinks.push({ text: "👀 在 Fomo 打开", url: event.fomoUrl });
    if (/^https:\/\/fomo\.family\//i.test(event.profileUrl || "")) sourceLinks.push({ text: "👤 博主主页", url: event.profileUrl });
    if (sourceLinks.length) rows.push(sourceLinks);
    if (/^https:\/\//i.test(event.launchpad?.evidenceUrl || "")) rows.push([{ text: `🚀 ${event.launchpad.name} 官方机制`, url: event.launchpad.evidenceUrl }]);
    const twitter = event.caller?.twitter || event.market?.twitter;
    if (/^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(twitter || "")) rows.push([{ text: "𝕏 博主/项目账号", url: twitter }]);
    return { inline_keyboard: rows.filter((row) => row.length) };
  }
  if (event.type === "binance_official_update") {
    const rows = [[{ text: "📘 查看官方公告", url: event.url }]];
    if (event.project?.twitter) rows.push([{ text: "𝕏 官方账号", url: event.project.twitter }, { text: "🌐 官方平台", url: event.project.website }]);
    return { inline_keyboard: rows };
  }
  if (isMorphLaunchpadEvent(event)) {
    const token = event.tokens?.[0]?.token;
    const rows = [
      [copyButton(event.launcher, event.platform?.id === "long" ? "📋 复制 Long 入口" : "📋 复制 Morph Portal")].filter(Boolean),
      [copyButton(token, "📋 复制首币合约")].filter(Boolean),
    ];
    const chainLinks = [];
    if (httpsUrl(event.explorerUrl)) chainLinks.push({ text: "🔍 Morph Explorer", url: event.explorerUrl });
    if (token && httpsUrl(event.marketUrl)) chainLinks.push({ text: "📊 DexScreener", url: event.marketUrl });
    if (chainLinks.length) rows.push(chainLinks.slice(0, 2));
    const officialLinks = [];
    if (httpsUrl(event.sourceUrl)) officialLinks.push({ text: "📘 官方证据", url: event.sourceUrl });
    if (event.platform?.id === "flap") officialLinks.push({ text: "🚀 Flap Morph", url: "https://flap.sh/morph/board" });
    else officialLinks.push({ text: "🌐 Long", url: "https://app.long.xyz/" });
    rows.push(officialLinks.slice(0, 2));
    if (httpsUrl(event.platform?.twitter)) rows.push([{ text: "𝕏 官方账号", url: event.platform.twitter }]);
    return { inline_keyboard: rows.filter((row) => row.length) };
  }
  if (event.type === "bsc_launchpad_update") {
    const token = event.tokens?.[0]?.token;
    const metadata = event.tokens?.[0]?.metadata || {};
    if (isStrictBscOpenFourFirstTokenUpdate(event)) {
      const rows = [[copyButton(token, "📋 复制 OpenFour 首币 CA")].filter(Boolean)];
      if (httpsUrl(event.explorerUrl)) rows.push([{ text: "🔍 查看 Core TokenCreated", url: event.explorerUrl }]);
      if (httpsUrl(event.sourceUrl)) rows.push([{ text: "📡 查看官方功能来源", url: event.sourceUrl }]);
      return { inline_keyboard: rows.filter((row) => row.length) };
    }
    const trackedToken = flapTrackedTokenIdentity(event);
    const declaredMonitorOnlyTrackedToken = event.kind === "flap_pool_token"
      && event.featureTrackedToken === true
      && event.informationalOnly === true
      && event.autoTradeEligible === false
      && event.automaticExecution === false;
    if (trackedToken || declaredMonitorOnlyTrackedToken) {
      const ordinal = trackedToken?.ordinal || Number(event.featureTokenOrdinal);
      const copyLabel = Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= 3
        ? `📋 复制第 ${ordinal}/3 个代币 CA`
        : "📋 复制监控代币 CA";
      const rows = [[copyButton(token, copyLabel)].filter(Boolean)];
      const explorer = httpsUrl(event.explorerUrl);
      if (explorer) rows.push([{ text: "🔍 查看 TokenCreated", url: explorer }]);
      const activationSource = httpsUrl(event.activationSourceUrl);
      if (activationSource && activationSource !== explorer) {
        rows.push([{ text: "🧾 底池启用证明", url: activationSource }]);
      }
      return { inline_keyboard: rows.filter((row) => row.length) };
    }
    const poolAddress = firstValue(event.pools?.[0]?.pool, event.pools?.[0]?.poolId, event.marketContext?.pairAddress);
    const rows = [
      [copyButton(event.launcher, "📋 复制 BSC Factory")].filter(Boolean),
      [copyButton(event.mode?.vaultFactory, "📋 复制 VaultFactory")].filter(Boolean),
      [copyButton(token, "📋 复制样本币合约")].filter(Boolean),
      [copyButton(poolAddress, "📋 复制池地址")].filter(Boolean),
    ];
    const links = [];
    if (token && event.security?.decision === "pass") links.unshift({ text: "📈 打开 GMGN", url: `https://gmgn.ai/bsc/token/${token}` });
    const explorer = httpsUrl(event.explorerUrl, event.launcherUrl);
    if (explorer) links.push({ text: "🔍 BscScan", url: explorer });
    if (links.length) rows.push(links.slice(0, 2));
    const verifiedPlatform = event.attribution?.status === "verified"
      ? event.attribution.platform
      : event.platform?.trust === "official_verified" ? event.platform : null;
    const evidenceUrl = verifiedPlatform?.evidenceUrl || (event.platform?.trust === "official_verified" ? event.platform.evidenceUrl : null);
    if (evidenceUrl) rows.push([{ text: "📘 官方地址证据", url: evidenceUrl }]);
    if (httpsUrl(event.sourceUrl)) rows.push([{ text: "📡 监控来源", url: event.sourceUrl }]);
    const publicLinks = [];
    const twitter = metadata.twitter || event.marketContext?.twitter || verifiedPlatform?.twitter || event.platform?.twitter;
    const website = metadata.website || event.marketContext?.website || verifiedPlatform?.website || event.platform?.website;
    if (/^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(twitter || "")) publicLinks.push({ text: "𝕏 官方/项目账号", url: twitter });
    if (/^https:\/\//i.test(website || "")) publicLinks.push({ text: "🌐 官方/项目网站", url: website });
    if (publicLinks.length) rows.push(publicLinks.slice(0, 2));
    const github = verifiedPlatform?.github || (event.platform?.trust === "official_verified" ? event.platform.github : null);
    if (/^https:\/\/github\.com\//i.test(github || "")) rows.push([{ text: "💻 GitHub", url: github }]);
    return { inline_keyboard: rows.filter((row) => row.length) };
  }
  if (event.type === "platform_capability_update") {
    const contracts = event.changes?.newContracts?.slice(0, 3) || [];
    const rows = contracts.map((address, index) => [copyButton(address, contracts.length > 1 ? `📋 复制新合约 ${index + 1}` : undefined)]);
    const poolCopyTargets = [
      ...(event.changes?.newFlapPools || []),
      ...(event.changes?.flapPoolChanges || []).map((change) => change.after || change),
      ...(event.changes?.updatedFlapPools || []),
    ].flatMap((pool) => {
      const { factory, quoteAddress } = flapPoolParts(pool);
      return [
        factory ? { address: factory, label: "📋 复制底池 Factory" } : null,
        quoteAddress ? { address: quoteAddress, label: "📋 复制报价合约" } : null,
      ].filter(Boolean);
    });
    const seenCopyAddresses = new Set(contracts.map((address) => String(address).toLowerCase()));
    for (const target of poolCopyTargets) {
      const identity = target.address.toLowerCase();
      if (seenCopyAddresses.has(identity)) continue;
      seenCopyAddresses.add(identity);
      rows.push([copyButton(target.address, target.label)]);
    }
    rows.push([{ text: "📘 查看官方来源", url: event.url }]);
    const links = [];
    if (event.platform.twitter) links.push({ text: "𝕏 官方账号", url: event.platform.twitter });
    if (event.platform.website) links.push({ text: "🌐 平台官网", url: event.platform.website });
    if (links.length) rows.push(links);
    return { inline_keyboard: rows };
  }
  if (event.type === "pons_v2_factory_discovered") {
    return { inline_keyboard: [
      [copyButton(event.factory, "📋 复制 v2 Factory")].filter(Boolean),
      [
        { text: "📘 pons v2 官方文档", url: "https://docs.ponsfamily.com/v2" },
        { text: "🔍 查看 Factory", url: `https://robinhoodchain.blockscout.com/address/${event.factory}` },
      ],
    ].filter((row) => row.length) };
  }
  if (event.type === "official_activity") {
    return { inline_keyboard: [
      [copyButton(event.token)].filter(Boolean),
      [
        { text: "🔍 查看交易", url: event.explorerUrl },
        { text: "📄 查看合约", url: `https://robinhoodchain.blockscout.com/token/${event.token}` },
      ],
    ].filter((row) => row.length) };
  }
  if (token) {
    const rows = [[copyButton(token)]];
    const marketLinks = [];
    const securityPassed = event.security?.decision === "pass" && event.security?.metrics?.liquidityConfirmed === true;
    if (securityPassed) marketLinks.push({ text: "📈 一键打开 GMGN", url: `https://gmgn.ai/robinhood/token/${token}` });
    if (httpsUrl(event.explorerUrl)) marketLinks.push({ text: "🔍 查看链上交易", url: event.explorerUrl });
    if (marketLinks.length) rows.push(marketLinks.slice(0, 2));
    const metadata = event.tokens?.[0]?.metadata || {};
    const twitter = metadata.twitter || event.launchpad?.twitter;
    const website = metadata.website || event.launchpad?.website;
    const docs = metadata.docs || event.launchpad?.docs;
    const publicLinks = [];
    if (/^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(twitter || "")) publicLinks.push({ text: "𝕏 项目动态", url: twitter });
    if (/^https:\/\//i.test(website || "")) publicLinks.push({ text: "🌐 项目官网", url: website });
    if (publicLinks.length) rows.push(publicLinks.slice(0, 2));
    if (httpsUrl(docs)) rows.push([{ text: "📘 官方文档", url: docs }]);
    return { inline_keyboard: rows };
  }
  if (event.type === "launchpad_site_update") {
    const profile = event.launchpad || {};
    const rows = (event.newContracts || []).slice(0, 3).map((address, index, addresses) => [copyButton(address, addresses.length > 1 ? `📋 复制新合约 ${index + 1}` : undefined)]);
    const official = [];
    const website = httpsUrl(profile.website, event.url);
    const twitter = httpsUrl(profile.twitter);
    const docs = httpsUrl(profile.docs);
    if (website) official.push({ text: "🌐 官方主页", url: website });
    if (twitter) official.push({ text: "𝕏 官方账号", url: twitter });
    if (official.length) rows.push(official.slice(0, 2));
    if (docs) rows.push([{ text: "📘 官方文档", url: docs }]);
    return { inline_keyboard: rows.filter((row) => row.length) };
  }
  if (["github_module_update", "github_repository_discovered", "github_repository_verified", "github_monitor_gap", "launchpad_site_update"].includes(event.type)) {
    const addresses = event.type === "github_repository_discovered"
      ? [event.address].filter(Boolean)
      : (event.newContracts || []).slice(0, 3);
    const rows = addresses.map((address, index) => [copyButton(address, addresses.length > 1 ? `📋 复制新合约 ${index + 1}` : undefined)]);
    if (httpsUrl(event.url)) rows.push([{ text: "🧱 查看 GitHub 更新", url: event.url }]);
    const evidence = httpsUrl(event.verification?.evidence?.url, event.verification?.evidence, event.officialEvidence?.url, event.officialEvidence);
    if (evidence && evidence !== event.url) rows.push([{ text: "✅ 官方认证证据", url: evidence }]);
    return { inline_keyboard: rows };
  }
  if (event.explorerUrl) {
    const address = event.contract || event.token;
    return { inline_keyboard: [
      [copyButton(address)].filter(Boolean),
      [{ text: "🔍 查看链上交易", url: event.explorerUrl }],
    ].filter((row) => row.length) };
  }
  return undefined;
}

const OUTBOX_VERSION = 2;
const OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_IMMUTABLE_OPENFOUR_SIGNAL_OWNERS = 100_000;
const MAX_FOUR_REGISTRY_DELIVERY_OWNERS = 100_000;
const IMMUTABLE_OPENFOUR_SIGNAL = /^fourmeme:openfour-core-token-created:56:0x[a-f0-9]{64}:(?:0|[1-9]\d*):0x[a-f0-9]{40}(?::canonical-revision:0x[a-f0-9]{64}:[1-9]\d*)?(?::safety-pass-v1)?$/u;
const FOCUS_NOVELTY_DEDUP_MS = 30 * 24 * 60 * 60 * 1_000;
const OUTBOX_LEASE_MS = 30_000;
const OUTBOX_IDLE_RECHECK_MS = 5 * 60_000;
const CRITICAL_ALERT_DELIVERY_BUDGET_MS = 5_000;
const CRITICAL_ALERT_TELEGRAM_MAX_MS = 4_000;
const CRITICAL_ALERT_COMPLETION_RESERVE_MS = 250;
const fileLocks = new Map();
const workers = new Map();

function alertPipelineNow(config) {
  const value = typeof config?.alertNow === "function" ? Number(config.alertNow()) : Date.now();
  return Number.isFinite(value) ? value : Date.now();
}

function isCriticalAlertDelivery(event) {
  return isStrongAlert(event);
}

function strictIsoInstantMs(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function sourceDeliverySla(event, pipelineStartedAtMs) {
  const candidate = event?.deliverySla;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const startedAtMs = strictIsoInstantMs(candidate.startedAt);
  const deadlineAtMs = strictIsoInstantMs(candidate.deadlineAt);
  const pollAllowanceMs = candidate.pollAllowanceMs;
  const basis = typeof candidate.basis === "string" ? candidate.basis.trim() : "";
  const queuedAtMs = strictIsoInstantMs(event?.alertQueuedAt);
  const latestValidStartMs = queuedAtMs ?? pipelineStartedAtMs;
  if (startedAtMs === null
    || deadlineAtMs === null
    || typeof candidate.budgetMs !== "number"
    || candidate.budgetMs !== CRITICAL_ALERT_DELIVERY_BUDGET_MS
    || typeof pollAllowanceMs !== "number"
    || !Number.isFinite(pollAllowanceMs)
    || !Number.isInteger(pollAllowanceMs)
    || pollAllowanceMs < 0
    || pollAllowanceMs > CRITICAL_ALERT_DELIVERY_BUDGET_MS
    || !basis
    || basis !== candidate.basis
    || basis.length > 160
    || /[\r\n\u0000-\u001f]/u.test(basis)
    || deadlineAtMs < startedAtMs
    || deadlineAtMs - startedAtMs + pollAllowanceMs > CRITICAL_ALERT_DELIVERY_BUDGET_MS
    || startedAtMs > latestValidStartMs) return null;
  return {
    startedAtMs,
    deadlineAtMs,
    budgetMs: candidate.budgetMs,
    pollAllowanceMs,
    basis,
  };
}

function criticalDeliveryWindow(event, pipelineStartedAtMs, { enforceSourceDeadline = true } = {}) {
  const localDeadlineAtMs = pipelineStartedAtMs + CRITICAL_ALERT_DELIVERY_BUDGET_MS;
  const sourceSla = sourceDeliverySla(event, pipelineStartedAtMs);
  const sourceDeadlineAtMs = sourceSla?.deadlineAtMs ?? localDeadlineAtMs;
  return {
    sourceStartedAtMs: sourceSla?.startedAtMs ?? pipelineStartedAtMs,
    sourceDeadlineAtMs,
    attemptDeadlineAtMs: enforceSourceDeadline
      ? Math.min(sourceDeadlineAtMs, localDeadlineAtMs)
      : localDeadlineAtMs,
    budgetMs: sourceSla?.budgetMs ?? CRITICAL_ALERT_DELIVERY_BUDGET_MS,
    pollAllowanceMs: sourceSla?.pollAllowanceMs ?? 0,
    basis: sourceSla?.basis || "alert_pipeline",
    sourceSlaAccepted: Boolean(sourceSla),
  };
}

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => !["observedAt", "checkedAt", "deliveredAt", "deliverySla", "tradingPriority"].includes(key)).map((key) => [key, stableValue(value[key])]));
  }
  return typeof value === "bigint" ? value.toString() : value;
};

const digest = (value) => createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");

function normalizedGithubDeltaString(value, { path = false } = {}) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
  return path ? normalized.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase() : normalized;
}

function normalizedGithubFileAction(value) {
  const action = normalizedGithubDeltaString(value).toLowerCase();
  if (["a", "add", "added", "new"].includes(action)) return "added";
  if (["d", "delete", "deleted", "remove", "removed"].includes(action)) return "removed";
  if (["m", "modify", "modified", "change", "changed"].includes(action)) return "modified";
  if (["r", "rename", "renamed"].includes(action)) return "renamed";
  return action || "unknown";
}

function normalizedGithubEvidenceValue(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => normalizedGithubEvidenceValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((nestedKey) => [nestedKey, normalizedGithubEvidenceValue(value[nestedKey], nestedKey)]));
  }
  if (typeof value === "string") {
    if (["file", "filename", "path", "previousFilename"].includes(key)) return normalizedGithubDeltaString(value, { path: true });
    if (["action", "status"].includes(key)) return normalizedGithubFileAction(value);
    return normalizedGithubDeltaString(value);
  }
  return typeof value === "bigint" ? value.toString() : value;
}

function githubSemanticNoveltyKeys(event) {
  if (event?.type !== "github_module_update") return [];
  const repository = normalizedGithubDeltaString(event.repository, { path: true });
  const revision = normalizedGithubDeltaString(event.commit || event.headCommit).toLowerCase();
  if (!repository || !revision) return [];
  const changeEvidence = (event.changeEvidence || [])
    .map((item) => normalizedGithubEvidenceValue(item))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const files = (event.files || []).map((file) => ({
    file: normalizedGithubDeltaString(file?.filename || file?.file || file?.path, { path: true }),
    action: normalizedGithubFileAction(file?.status || file?.action),
    additions: Number.isFinite(Number(file?.additions)) ? Number(file.additions) : null,
    deletions: Number.isFinite(Number(file?.deletions)) ? Number(file.deletions) : null,
    previousFile: normalizedGithubDeltaString(file?.previous_filename || file?.previousFilename, { path: true }) || null,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const deltaFingerprint = digest({
    repository,
    revision,
    headCommit: normalizedGithubDeltaString(event.headCommit).toLowerCase() || null,
    changeEvidence,
    files,
    newContracts: (event.newContracts || []).map((address) => String(address).toLowerCase()).sort(),
  }).slice(0, 32);
  return [`github:update:${deltaFingerprint}`];
}

function focusNoveltyPlatform(event) {
  if (event?.type === "uniswap_official_update" || event?.uniswapOfficial === true) return "uniswap";
  const platform = eventPlatform(event);
  if (platform.includes("uniswap") || platform.includes("poolstrade") || platform === "tradepools") return "uniswap";
  if (platform.includes("fourmeme") || platform === "openfour") return "fourmeme";
  if (platform.includes("flap")) return "flap";
  if (platform === "long" || platform === "longdotxyz") return "long";
  return null;
}

function noveltyValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return [value.name, value.label, value.version, value.symbol, value.address, value.url].filter(Boolean).join(" ") || JSON.stringify(value);
}

function noveltySlug(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/0x[a-f0-9]{40}/g, " ")
    .replace(/\b(?:feat|new|add|adds|added|adding|introduce|introduces|introduced|launch|launches|launched|deploy|deploys|deployed|release|releases|released|enable|enables|enabled|support|supports|supported|the|a|an|our|official|is|now|live)\b/g, " ")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function quoteSymbolNoveltySlug(value) {
  return noveltySlug(value)
    || String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const FOCUS_NOVELTY_CONCEPTS = [
  ["liquidity-launcher", /\bliquidity[ -]?launcher\b/i],
  ["crowd-launch", /\bcrowd\s+launch\b/i],
  ["instant-launch", /\binstant\s+launch\b/i],
  ["dualpool", /\bdual\s*pool\b/i],
  ["openfour", /\bopen\s*four\b/i],
  ["tax-mode", /\btax\s+mode\b/i],
  ["subscription", /\bsubscriptions?\b|订阅|会员/i],
  ["bonding-curve", /\bbonding\s+curve\b/i],
  ["presale", /\bpre[- ]?sale\b/i],
  ["vault", /\bvault\b/i],
  ["pool-mode", /\bpool\s+(?:mode|design|type|mechanism|strategy|template|module)\b/i],
  ["hook-mode", /\bhook\s+(?:mode|design|type|mechanism|strategy|template|module)\b/i],
];
const FOCUS_NOVELTY_VERSION = /\bv(?:ersion\s*)?([2-9](?:\.\d+){0,3})\b/gi;

function expandedNoveltyText(value) {
  return noveltyValue(value).replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function normalizedNoveltyVersion(value) {
  const parts = String(value || "").split(".");
  while (parts.length > 1 && parts.at(-1) === "0") parts.pop();
  return parts.join(".");
}

function adjacentNoveltyVersion(text, start, end) {
  const punctuation = "[\\s()\\[\\]{}._:/\\-]*";
  const qualifiers = `(?:(?:module|mode|contract)\\b${punctuation}){0,2}`;
  const after = text.slice(end, end + 40).match(new RegExp(`^${punctuation}${qualifiers}v(?:ersion\\s*)?([2-9](?:\\.\\d+){0,3})\\b`, "i"));
  if (after) return normalizedNoveltyVersion(after[1]);
  const before = text.slice(Math.max(0, start - 40), start).match(new RegExp(`\\bv(?:ersion\\s*)?([2-9](?:\\.\\d+){0,3})${punctuation}${qualifiers}${punctuation}$`, "i"));
  return before ? normalizedNoveltyVersion(before[1]) : null;
}

function conceptNoveltyKeys(platform, value) {
  const text = expandedNoveltyText(value);
  const keys = new Set();
  const vaultSubtypeMatches = [];
  const vaultSubtypes = [
    ["index", /\b(?:vault[\s._/-]*index|index[\s._/-]*vault)\b/gi],
    ["staking", /\b(?:vault[\s._/-]*staking|staking[\s._/-]*vault)\b/gi],
    ["nft", /\b(?:vault[\s._/-]*nft|nft[\s._/-]*vault)\b/gi],
    ["distribution", /\b(?:vault[\s._/-]*distribution|distribution[\s._/-]*vault)\b/gi],
  ];
  for (const [subtype, pattern] of vaultSubtypes) {
    for (const match of text.matchAll(pattern)) {
      keys.add(`${platform}:concept:vault:${subtype}`);
      vaultSubtypeMatches.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  for (const [name, pattern] of FOCUS_NOVELTY_CONCEPTS) {
    const matcher = new RegExp(pattern.source, pattern.flags.includes("i") ? "gi" : "g");
    for (const match of text.matchAll(matcher)) {
      if (name === "vault" && vaultSubtypeMatches.some(({ start, end }) => match.index >= start && match.index < end)) continue;
      const version = adjacentNoveltyVersion(text, match.index, match.index + match[0].length);
      keys.add(`${platform}:concept:${name}${version ? `:v${version}` : ""}`);
    }
  }
  return keys;
}

function namedModuleNoveltyKeys(platform, value) {
  const text = expandedNoveltyText(value);
  const keys = new Set();
  const matcher = /\b(?:new|add(?:s|ed|ing)?|introduc(?:e|es|ed|ing)?|launch(?:es|ed|ing)?|releas(?:e|es|ed|ing)?|enabl(?:e|es|ed|ing)?|support(?:s|ed|ing)?|deploy(?:s|ed|ing)?|ship(?:s|ped|ping)?)(?:\s+(?:an?|the|our|new))*\s+([a-z0-9][a-z0-9.-]*(?:\s+[a-z0-9][a-z0-9.-]*){0,3}?)\s+(mode|module|strategy|mechanism|launcher|factory|vault|hook|pool|plugin|feature)\b/gi;
  for (const match of text.matchAll(matcher)) {
    const name = match[1].split(/\b(?:and|with|plus)\b/i).at(-1).trim();
    const kind = match[2].toLowerCase();
    const label = [name, ["module", "plugin", "feature"].includes(kind) ? null : kind].filter(Boolean).join(" ");
    if (conceptNoveltyKeys(platform, label).size) continue;
    const slug = noveltySlug(label);
    if (!slug || /^(?:v[2-9](?:-\d+){0,3}-)?(?:mode|module|strategy|mechanism|launcher|factory|vault|hook|pool|plugin|feature)$/.test(slug)) continue;
    keys.add(`${platform}:module:${slug}`);
  }
  return keys;
}

function quoteNoveltyKeys(platform, value) {
  const text = expandedNoveltyText(value).replace(/\s+/g, " ");
  const keys = new Set();
  const addSymbol = (raw) => {
    const symbol = String(raw || "").replace(/^\$/, "").toUpperCase();
    if (!symbol || new Set(["FLAP", "BSC", "BNBCHAIN", "ERC20", "QUOTE", "TOKEN", "ASSET", "POOL", "NEW", "LIVE", "UPDATE", "UPDATES"]).has(symbol)) return;
    keys.add(`${platform}:quote:${noveltySlug(symbol)}`);
  };
  if (value && typeof value === "object") {
    const parts = flapPoolParts(value);
    const symbol = noveltySlug(parts.quoteSymbol);
    if (symbol) keys.add(`${platform}:quote:${symbol}`);
    // A first observation may contain only a CA while RPC metadata is
    // temporarily unavailable. Once its verified symbol is backfilled, use a
    // new semantic identity so the readable confirmation is not swallowed by
    // the earlier address-only audit record.
    if (parts.quoteAddress && !symbol) keys.add(`${platform}:quote-address:${parts.quoteAddress.toLowerCase()}`);
  }
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]{1,11})\b.{0,56}\b(?:quote|raised)\s+(?:token|asset)\b/g)) addSymbol(match[1]);
  const marker = /\b(?:quote|raised)\s+(?:token|asset)s?\b|\bnew\s+(?:quote\s+)?pool\b|报价(?:代币|资产|底池)|新底池|募资代币/gi;
  for (const match of text.matchAll(marker)) {
    const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 120).split(/[.!?。！？]/, 1)[0];
    for (const candidate of tail.matchAll(/(?<![@A-Za-z0-9])\$?([A-Z][A-Z0-9]{1,11})\b/g)) addSymbol(candidate[1]);
  }
  return keys;
}

function normalizedFlapPoolCategory(value) {
  const parts = noveltySlug(value).split("-").filter(Boolean);
  const category = parts.filter((part) => !["flap", "vault", "pool", "category", "mode"].includes(part)).join("-");
  return category || "quote";
}

function flapPoolNoveltyKeys(platform, value) {
  if (platform !== "flap" || !value || typeof value !== "object") return [];
  const { category, factory, quoteAddress, quoteSymbol } = flapPoolParts(value);
  const identity = [
    `${platform}:pool:${normalizedFlapPoolCategory(category)}`,
    factory ? `factory:${factory.toLowerCase()}` : null,
    quoteSymbol && quoteAddress
      ? `quote:${noveltySlug(quoteSymbol)}:ca:${quoteAddress.toLowerCase()}`
      : quoteSymbol ? `quote:${noveltySlug(quoteSymbol)}`
        : quoteAddress ? `quote:${quoteAddress.toLowerCase()}` : null,
  ].filter(Boolean).join(":");
  return identity.includes(":factory:") || identity.includes(":quote:") ? [identity] : [];
}

function exactFlapQuoteNoveltyKeys(event, platform) {
  if (platform !== "flap") return null;
  const signal = event?.signal?.quotePairChange;
  const changedPools = [
    ...(event?.changes?.newFlapPools || []),
    ...(event?.changes?.updatedFlapPools || []),
    ...(event?.changes?.flapPoolChanges || []).map((change) => change?.after || change),
  ];
  const quotePools = changedPools.filter((pool) => pool?.kind === "quote_asset");
  const signalClaimsQuote = ["bstock_quote", "quote_asset"].includes(signal?.assetClass)
    && ["announced", "live", "observed"].includes(signal?.stage)
    && Array.isArray(signal?.assets);
  const poolsClaimExactQuote = quotePools.length > 0 && quotePools.length === changedPools.length;
  if (!signalClaimsQuote && !poolsClaimExactQuote) return null;

  const keys = new Set();
  const add = (asset, stage, poolEvidence = false) => {
    const symbol = quoteSymbolNoveltySlug(asset?.symbol || asset?.quoteSymbol);
    const rawAddress = String(asset?.address || asset?.quoteAddress || "");
    const address = /^0x[a-fA-F0-9]{40}$/.test(rawAddress) ? rawAddress.toLowerCase() : null;
    if (symbol && address && stage === "observed") {
      keys.add(`flap:quote-pair:${symbol}:ca:${address}:observed`);
    } else if (symbol && address && (poolEvidence || stage === "live")) {
      keys.add(`flap:quote-pair:${symbol}:ca:${address}:live`);
    } else if (symbol && ["announced", "live", "observed"].includes(stage)) {
      keys.add(`flap:quote-pair:${symbol}:${stage}`);
    } else if (address) {
      keys.add(`flap:quote-address:${address}:observed`);
    }
  };
  const poolStage = isFlapQuoteFirstObservedAfterGapEvent(event) || isFlapBoardQuoteObservedEvent(event)
    ? "observed"
    : "live";
  for (const pool of quotePools) add(pool, poolStage, true);
  if (signalClaimsQuote) {
    for (const asset of signal.assets) add(asset, signal.stage, false);
  }
  return [...keys].sort();
}

function noveltyVersions(value) {
  return [...expandedNoveltyText(value).matchAll(FOCUS_NOVELTY_VERSION)].map((match) => normalizedNoveltyVersion(match[1]));
}

const GENERIC_MODE_ALIAS = /^(?:(?:shared|official)\s+)?(?:factory(?:\s*\/\s*manager)?|manager|proxy(?:[- ]upgrade)?|upgraded(?:\s*\/\s*implementation\s*updated)?|implementation(?:\s*updated)?|internal|unknown)$/i;

function isSpecificModeAlias(value) {
  const normalized = String(value || "").trim().replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return Boolean(normalized) && !GENERIC_MODE_ALIAS.test(normalized);
}

export function focusNoveltyKeys(event) {
  if (event?.type === "gmgn_flow_surge") return [];
  if (event?.type === "genius_fun_update") return [];
  if (event?.type === "telegram_news_update") return [];
  const platform = focusNoveltyPlatform(event);
  if (!platform) return [];
  if (isFourMemePolicyFixRecoveryEvent(event)) {
    return [`fourmeme:policy-fix-recovery:x:${event.tweet.id}:v1`];
  }
  if (isStrictFourRegistryCapabilityUpdate(event)) {
    return [isStrictFourRegistryCanonicalRevision(event)
      ? `${event.lifecycleKey}:canonical-revision:${String(event.blockHash).toLowerCase()}:${Number(event.canonicalRevision.recoveryEpoch)}`
      : event.lifecycleKey];
  }
  if (isOfficialFourMemeCapabilityUpdate(event)) {
    const templateId = noveltySlug(event.currentTemplate?.id);
    const changeType = noveltySlug(event.changeType);
    if (!templateId || !changeType) return [];
    const revision = digest({
      fingerprint: event.mode?.fingerprint,
      changedFields: event.changedFields,
      previousTemplate: event.previousTemplate,
      currentTemplate: event.currentTemplate,
    }).slice(0, 24);
    return [`fourmeme:official-template:${templateId}:${changeType}:${revision}`];
  }
  const openFourCoreTokenKey = openFourCoreTokenCreatedSemanticKey(event);
  if (openFourCoreTokenKey) {
    const safetyPassKey = openFourCoreTokenCreatedSafetyPassSemanticKey(event);
    return safetyPassKey ? [openFourCoreTokenKey, safetyPassKey] : [openFourCoreTokenKey];
  }
  const trackedToken = flapTrackedTokenIdentity(event);
  if (trackedToken) {
    const activationGeneration = digest({
      featureActivationKey: trackedToken.featureActivationKey,
      generation: trackedToken.generation,
    }).slice(0, 24);
    const revision = verifiedFlapTrackedTokenCanonicalRevision(event, trackedToken);
    const revisionIdentity = revision
      ? `:canonical-revision:${digest({
          newBlockHash: revision.newBlockHash,
          replacesEventKey: revision.replacesEventKey,
          replacesBlockHash: revision.replacesBlockHash,
          replacesTokenAddress: revision.replacesTokenAddress,
        }).slice(0, 24)}`
      : "";
    return [`flap:feature-activation:${activationGeneration}:ordinal:${trackedToken.ordinal}:token:${trackedToken.token}${revisionIdentity}`];
  }
  const exactFlapQuoteKeys = exactFlapQuoteNoveltyKeys(event, platform);
  if (exactFlapQuoteKeys !== null) return exactFlapQuoteKeys;
  if (platform === "long") {
    const morphChains = chainSupportEntries(event).filter((chain) => Number(chain.chainId) === 2818
      || String(chain.id || "").toLowerCase() === "morph");
    const morphEvent = isMorphLaunchpadEvent(event) || morphChains.length > 0;
    if (!morphEvent) return [];
    const deployed = event.kind === "official_deployment" || morphChains.some((chain) => chain.stage === "deployed");
    const keys = new Set([`long:chain:morph:mainnet${deployed ? ":deployed" : ""}`]);
    for (const address of [event.launcher, ...(event.officialRoots || [])]) {
      if (/^0x[a-fA-F0-9]{40}$/.test(String(address || ""))) keys.add(`long:contract:${address.toLowerCase()}`);
    }
    return [...keys].sort();
  }
  const changes = event.changes || {};
  const moduleValues = [
    ...(changes.newModules || []),
    ...(event.newFeatures || []),
  ].filter(Boolean);
  const modeAliasValues = [
    event.mode?.novelty?.componentMode,
    event.mode?.componentMode,
    event.mode?.selectorName,
    event.mode?.name,
    event.mode?.template,
    event.mode?.strategy,
    event.template?.name,
    event.componentMode,
    event.modeName,
    event.templateName,
  ].filter(Boolean);
  const versionValues = changes.newVersions || [];
  const quoteValues = [
    ...(changes.newFlapPools || []),
    ...(changes.updatedFlapPools || []),
    ...(changes.flapPoolChanges || []).map((change) => change.after || change),
    ...(changes.newQuoteTokens || []),
    ...(changes.newQuoteConfigs || []),
    ...(changes.updatedQuoteConfigs || []),
    ...(changes.quoteConfigChanges || []),
  ];
  const packageValues = [...(changes.newPackages || []), ...(changes.updatedPackages || []), ...(changes.packageVersionChanges || [])];
  const unstructuredParts = [
    event.title,
    event.summary,
    event.message,
    event.tag,
    event.tweet?.text,
    event.signal?.headline,
    ...(event.signal?.claims || []),
    ...(event.signal?.keyChanges || []),
    ...(event.files || []).filter((file) => !file.status || ["added", "a"].includes(String(file.status).toLowerCase())).map((file) => file.filename),
    ...(event.type === "github_repository_discovered" ? [event.repository] : []),
  ].filter(Boolean);
  const keys = new Set();
  const conceptKeys = new Set();

  // Authoritative removals are their own lifecycle facts. They must not reuse
  // an earlier add/update identity, otherwise a delivered activation can hide
  // the later delisting. Only stable, bounded identifiers enter this namespace.
  const removedIdentities = [
    ["quote", [...(changes.removedQuoteTokens || []), ...(changes.removedQuoteConfigs || [])]],
    ["contract", changes.removedContracts || []],
    ["module", changes.removedModules || []],
    ["version", changes.removedVersions || []],
    ["package", changes.removedPackages || []],
  ];
  for (const [kind, values] of removedIdentities) {
    for (const value of values) {
      const address = /^0x[a-fA-F0-9]{40}$/.test(String(value?.address || value || ""))
        ? String(value?.address || value).toLowerCase()
        : null;
      const identity = address || noveltySlug(value?.symbol || value?.name || noveltyValue(value));
      if (identity) keys.add(`${platform}:${kind}:${identity}:removed`);
    }
  }

  const namedMode = event.signal?.namedMode;
  if (platform === "fourmeme"
    && namedMode?.version === 1
    && /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(namedMode.id || ""))
    && ["announced", "live", "observed"].includes(namedMode.stage)) {
    keys.add(`fourmeme:lifecycle:${namedMode.id}:${namedMode.stage}`);
    keys.add(`fourmeme:module:${namedMode.id}`);
  }
  const marketCampaign = event.signal?.marketCampaign;
  if (platform === "fourmeme"
    && marketCampaign?.version === 1
    && marketCampaign.kind === "bstock_partner_leaderboard"
    && /^fourmeme:market-campaign:bstock:[a-z0-9_]+:\d+-usdt:top-\d+$/.test(String(marketCampaign.campaignKey || ""))) {
    keys.add(marketCampaign.campaignKey);
  }

  // Product lifecycle milestones are separate semantic events even when the
  // same legacy concept name appears in both. For example, a historical
  // OpenFour capability must not suppress the later MEME ARENA live launch.
  // A stable producer lifecycleKey wins; otherwise derive a conservative
  // product+stage key from immutable event facts.
  const lifecycle = deriveEventLifecycle(event);
  const explicitLifecycle = Boolean(event.lifecycleKey || event.lifecycle?.key || event.productLifecycle?.key
    || event.lifecycleStage || event.lifecycle?.stage || event.productLifecycle?.stage);
  const lifecycleProductSpecific = isSpecificModeAlias(
    event.mode?.officialName || event.mode?.componentMode || event.mode?.selectorName || lifecycle.product,
  );
  if (lifecycle.key
    && (explicitLifecycle || lifecycle.product === "meme-arena"
      || (lifecycle.stage !== "observed" && lifecycleProductSpecific))) {
    keys.add(lifecycle.key);
  }

  // A human-readable mode name is shared by announcements and can also be
  // reused by later template/config revisions. On-chain first-token events
  // therefore need the exact feature activation as an additional identity:
  // repeats of one activation collapse, while a new activation with the same
  // display name remains independently alertable.
  if (event.featureActivationKey && isFocusOnchainTokenActivation(event)) {
    keys.add(`${platform}:feature-activation:${digest(event.featureActivationKey).slice(0, 24)}`);
  }

  if (platform === "flap" && event.signal?.quotePairChange?.assetClass === "bstock_quote") {
    const stage = ["announced", "live"].includes(event.signal.quotePairChange.stage)
      ? event.signal.quotePairChange.stage
      : "observed";
    const symbols = (Array.isArray(event.signal.quotePairChange.assets) ? event.signal.quotePairChange.assets : [])
      .map((asset) => noveltySlug(asset?.symbol))
      .filter(Boolean);
    for (const symbol of symbols) keys.add(`flap:quote-pair:${symbol}:${stage}`);
    if (symbols.length > 1) keys.add(`flap:quote-pair-set:${[...new Set(symbols)].sort().join("+")}:${stage}`);
  }

  for (const pool of changes.newFlapPools || []) {
    for (const key of flapPoolNoveltyKeys(platform, pool)) keys.add(key);
    const symbol = noveltySlug(pool?.quoteSymbol);
    const quoteAddress = /^0x[a-fA-F0-9]{40}$/.test(String(pool?.quoteAddress || ""))
      ? String(pool.quoteAddress).toLowerCase()
      : null;
    if (platform === "flap" && pool?.kind === "quote_asset" && symbol) {
      keys.add(`flap:quote-pair:${symbol}${quoteAddress ? `:ca:${quoteAddress}` : ""}:live`);
    }
  }
  for (const change of changes.flapPoolChanges || []) {
    const after = change?.after || change;
    for (const key of flapPoolNoveltyKeys(platform, after)) keys.add(key);
    const symbol = noveltySlug(after?.quoteSymbol);
    const quoteAddress = /^0x[a-fA-F0-9]{40}$/.test(String(after?.quoteAddress || ""))
      ? String(after.quoteAddress).toLowerCase()
      : null;
    if (platform === "flap" && after?.kind === "quote_asset" && symbol) {
      keys.add(`flap:quote-pair:${symbol}${quoteAddress ? `:ca:${quoteAddress}` : ""}:live`);
    }
    keys.add(`${platform}:pool-update:${digest({
      identity: change?.identity || after?.identity || null,
      before: change?.before || null,
      after,
    }).slice(0, 24)}`);
  }
  if (!(changes.flapPoolChanges || []).length) {
    for (const pool of changes.updatedFlapPools || []) {
      for (const key of flapPoolNoveltyKeys(platform, pool)) keys.add(key);
      const symbol = noveltySlug(pool?.quoteSymbol);
      const quoteAddress = /^0x[a-fA-F0-9]{40}$/.test(String(pool?.quoteAddress || ""))
        ? String(pool.quoteAddress).toLowerCase()
        : null;
      if (platform === "flap" && pool?.kind === "quote_asset" && symbol) {
        keys.add(`flap:quote-pair:${symbol}${quoteAddress ? `:ca:${quoteAddress}` : ""}:live`);
      }
      keys.add(`${platform}:pool-update:${digest(pool).slice(0, 24)}`);
    }
  }

  for (const chain of chainSupportEntries(event)) {
    if (chain.id === "unspecified-new-chain") continue;
    const namedIdentity = chain.id && !/^chain-\d+$/.test(chain.id) ? noveltySlug(chain.id) : null;
    const identity = namedIdentity || (chain.chainId ? `chain-${chain.chainId}` : noveltySlug(chain.name));
    if (!identity) continue;
    // Official sources often omit the word "mainnet" for a production chain.
    // Treat that unknown/default environment as mainnet for semantic dedup, while
    // preserving an explicit testnet as a separate first signal.
    const environment = chain.environment === "testnet" ? ":testnet" : ":mainnet";
    const deployment = chain.stage === "deployed" ? ":deployed" : "";
    keys.add(`${platform}:chain:${identity}${environment}${deployment}`);
  }

  for (const value of [...unstructuredParts, ...moduleValues, ...packageValues]) {
    for (const key of conceptNoveltyKeys(platform, value)) conceptKeys.add(key);
  }
  // Component-role labels such as "Factory/Manager" and generic upgrade event
  // names describe where a change happened, not which product feature changed.
  // Using them as the semantic identity collapsed every distinct implementation
  // upgrade into one alert. When no specific name exists, the code below falls
  // back to the verified mode fingerprint so each implementation is announced
  // once while still deduplicating repeated observations of that implementation.
  const specificModeAliases = modeAliasValues.filter(isSpecificModeAlias);
  const selectedModeAlias = specificModeAliases.find((value) => conceptNoveltyKeys(platform, value).size) || specificModeAliases[0];
  if (selectedModeAlias) {
    for (const key of conceptNoveltyKeys(platform, selectedModeAlias)) conceptKeys.add(key);
  }
  for (const key of conceptKeys) keys.add(key);

  for (const value of unstructuredParts) {
    for (const key of namedModuleNoveltyKeys(platform, value)) keys.add(key);
  }

  for (const value of [...unstructuredParts, ...quoteValues]) {
    for (const key of quoteNoveltyKeys(platform, value)) keys.add(key);
  }

  for (const value of moduleValues) {
    if (conceptNoveltyKeys(platform, value).size) continue;
    const slug = noveltySlug(noveltyValue(value));
    if (slug) keys.add(`${platform}:module:${slug}`);
  }
  if (selectedModeAlias && !conceptNoveltyKeys(platform, selectedModeAlias).size) {
    const slug = noveltySlug(noveltyValue(selectedModeAlias));
    if (slug) keys.add(`${platform}:module:${slug}`);
  }
  for (const value of quoteValues) {
    if (quoteNoveltyKeys(platform, value).size) continue;
    const slug = noveltySlug(value?.symbol || noveltyValue(value));
    if (slug) keys.add(`${platform}:quote:${slug}`);
  }
  for (const value of packageValues) {
    if (conceptNoveltyKeys(platform, value).size) continue;
    const slug = noveltySlug(noveltyValue(value));
    if (slug) keys.add(`${platform}:package:${slug}`);
  }
  if (!conceptKeys.size) {
    for (const value of [...unstructuredParts, ...versionValues]) {
      for (const version of noveltyVersions(value)) keys.add(`${platform}:version:v${version}`);
    }
    for (const value of versionValues) {
      if (noveltyVersions(value).length) continue;
      const slug = noveltySlug(noveltyValue(value));
      if (slug) keys.add(`${platform}:version:${slug}`);
    }
  }

  // Contract addresses, bytecode fingerprints, and repository names are
  // evidence for a product change. They become the identity only when no
  // human-readable product/mode identity was available.
  if (!keys.size) {
    const addresses = [
      ...(event.newContracts || []),
      ...(changes.newContracts || []),
      ...(event.type === "bsc_launchpad_update" && event.kind === "new_factory" ? [event.launcher, event.factory] : []),
    ].filter((value) => /^0x[a-fA-F0-9]{40}$/.test(String(value || "")));
    for (const address of addresses) keys.add(`${platform}:contract:${address.toLowerCase()}`);

    const modeFingerprint = event.mode?.fingerprint || event.modeFingerprint;
    if (!keys.size && modeFingerprint) keys.add(`${platform}:mode:${String(modeFingerprint).toLowerCase()}`);
    else if (!keys.size && event.type === "token_launch" && event.mode?.selector) {
      keys.add(`${platform}:mode:${digest({ launcher: event.launcher, selector: event.mode.selector, poolKinds: event.mode.poolKinds || [] }).slice(0, 24)}`);
    }
    if (!keys.size && event.type === "github_repository_discovered" && event.repository) {
      keys.add(`${platform}:repository:${String(event.repository).toLowerCase()}`);
    }
  }

  if (!keys.size) {
    const fallback = noveltySlug(event.message || event.title || event.tweet?.text || "");
    if (fallback) keys.add(`${platform}:${event.type}:text:${fallback}`);
  }
  return [...keys].sort();
}

function ponFunLifecycleStage(event) {
  const explicit = String(event?.signal?.ponStage || event?.ponStage || "").trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(explicit)) return explicit;
  if (event?.kind === "platform_token_update") {
    const supply = event?.changes?.supply;
    const before = Number(supply?.before);
    const after = Number(supply?.after);
    if (Number.isFinite(before) && Number.isFinite(after) && after < before) return "supply_burned";
    if (event?.changes?.address) return "platform_token_address_updated";
  }
  if (event?.kind === "market_lifecycle") {
    const changes = event.changes || {};
    if (changes.lpDeployed?.after === true) return "lp_deployed";
    if (changes.graduated?.after === true) return "graduated";
    if (changes.backingPct) return "backing_updated";
    if (changes.stockToken) return "stock_mapped";
    return `lifecycle_${noveltySlug(Object.keys(changes).sort().join("_")) || "updated"}`;
  }
  return ({
    market_created: "created",
    stock_listing: event?.currentSnapshot?.active === false || event?.changes?.active?.after === false
      ? "stock_delisted"
      : "stock_listed",
    factory_config: "factory_config",
    curve_params: "curve_params",
    factory_paused: "paused",
    factory_unpaused: "recovered",
    ownership_transfer_started: "ownership_transfer_started",
    ownership_transferred: "ownership_transferred",
    platform_token_update: "platform_token_updated",
  })[event?.kind] || null;
}

function ponFunNoveltyAsset(event) {
  const platformWide = new Set([
    "factory_config", "curve_params", "factory_paused", "factory_unpaused",
    "ownership_transfer_started", "ownership_transferred", "platform_token_update",
  ]).has(event?.kind) || String(event?.signal?.ponAsset || "").toUpperCase() === "PONFUN";
  if (platformWide) return "PONFUN";
  const address = [
    event?.signal?.tokenAddress,
    event?.market?.coin,
    event?.currentSnapshot?.coin,
    event?.currentSnapshot?.stockToken,
    event?.token,
    event?.contractAddress,
  ].map((value) => String(value || "").trim()).find((value) => /^0x[a-f0-9]{40}$/i.test(value));
  if (address) return address.toLowerCase();
  const symbol = String(event?.signal?.ponAsset || event?.symbol || event?.ticker || event?.market?.symbol || event?.market?.ticker || "")
    .trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,23}$/.test(symbol) ? symbol : null;
}

function normalizedPonFunChangeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return `number:${value}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return `number:${Object.is(value, -0) ? 0 : value}`;
  }
  if (typeof value === "string") {
    const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (/^0x[a-f0-9]+$/i.test(normalized)) return normalized.toLowerCase();
    if (/^-?(?:0|[1-9]\d*)$/.test(normalized)) {
      try { return `number:${BigInt(normalized)}`; } catch { /* retain the normalized string */ }
    }
    return normalized;
  }
  if (Array.isArray(value)) return value.map(normalizedPonFunChangeValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key.normalize("NFKC").trim(),
      normalizedPonFunChangeValue(value[key]),
    ]));
  }
  return value;
}

function ponFunExactEvidenceAddresses(event) {
  const addresses = new Set();
  const addValue = (value) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/(?<![a-f0-9])0x[a-f0-9]{40}(?![a-f0-9])/gi)) addresses.add(match[0].toLowerCase());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) addValue(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) addValue(item);
    }
  };
  for (const value of [
    event?.signal?.tokenAddress,
    event?.token,
    event?.contractAddress,
    event?.market?.coin,
    event?.currentSnapshot?.coin,
    event?.currentSnapshot?.address,
    event?.tweet?.text,
    event?.signal?.headline,
    event?.signal?.claims,
    event?.signal?.keyChanges,
  ]) addValue(value);
  for (const change of Object.values(event?.changes || {})) addValue(change?.after);
  return [...addresses].sort();
}

function ponFunPlatformRevisionKeys(event, asset, stage) {
  const kind = String(event?.kind || event?.signal?.ponKind || "").trim().toLowerCase();
  if (!PON_FUN_REVISIONED_PLATFORM_KINDS.has(kind)) return [];
  if (kind === "market_lifecycle") {
    const repeatableFields = new Set(["stockToken", "poolFee", "backingPct", "creatorFeeBps"]);
    const hasRepeatableChange = Object.keys(event?.changes || {}).some((field) => repeatableFields.has(field));
    if (!hasRepeatableChange) return [];
  }
  const prefix = `pon:${asset}:${stage}`;
  const keys = [];
  const transactionHash = String(event?.transactionHash || event?.signal?.transactionHash || "").trim().toLowerCase();
  const logIndex = Number(event?.evidence?.logIndex ?? event?.signal?.logIndex);
  if (/^0x[a-f0-9]{64}$/.test(transactionHash)) {
    keys.push(`${prefix}:tx:${transactionHash}`);
    if (Number.isSafeInteger(logIndex) && logIndex >= 0) keys.push(`${prefix}:tx-log:${transactionHash}:${logIndex}`);
  }
  const exactAddresses = ponFunExactEvidenceAddresses(event);
  for (const address of exactAddresses) keys.push(`${prefix}:ca:${address}`);
  if (event?.changes && typeof event.changes === "object" && !Array.isArray(event.changes)
    && Object.keys(event.changes).length > 0) {
    keys.push(`${prefix}:changes:${digest(normalizedPonFunChangeValue(event.changes)).slice(0, 24)}`);
  }
  if (event?.type === "pon_fun_update"
    && !/^0x[a-f0-9]{64}$/.test(transactionHash)
    && ["market_lifecycle", "platform_token_update"].includes(kind)
    && typeof event?.eventKey === "string"
    && event.eventKey.length > 0) {
    keys.push(`${prefix}:revision:${digest(event.eventKey).slice(0, 24)}`);
  }
  if (event?.type === "twitter_update" && !/^0x[a-f0-9]{64}$/.test(transactionHash) && exactAddresses.length === 0) {
    const tweetId = String(event?.tweet?.id || "").trim();
    if (/^\d+$/.test(tweetId)) keys.push(`${prefix}:x-tweet:${tweetId}`);
    else {
      const claims = [
        event?.signal?.headline,
        ...(event?.signal?.claims || []),
        ...(event?.signal?.keyChanges || []),
        event?.tweet?.text,
      ].filter(Boolean).map(normalizedPonFunChangeValue);
      if (claims.length) keys.push(`${prefix}:x-claim:${digest(claims).slice(0, 24)}`);
    }
  }
  return keys;
}

// A separate Pon namespace prevents the stock-backed exception from sharing
// broad focus3 concept keys.  X/API/chain observations of one lifecycle stage
// collapse, while creation, graduation and LP deployment remain distinct.
export function ponFunNoveltyKeys(event) {
  const officialPon = isPonFunEvent(event) || isPonFunTwitterEvent(event);
  if (!officialPon) return [];
  const asset = ponFunNoveltyAsset(event);
  const stage = ponFunLifecycleStage(event);
  if (!asset || !stage) return [];
  return [...new Set([
    `pon:${asset}:${stage}`,
    ...ponFunPlatformRevisionKeys(event, asset, stage),
  ])].sort();
}

function telegramNewsNoveltyKeys(event) {
  if (event?.type !== "telegram_news_update") return [];
  const storyKey = String(event?.news?.storyKey || "").trim();
  const stage = String(event?.news?.stage || "").trim().toLowerCase();
  if (!storyKey || !stage) return [];
  return [`telegram:story:${digest({ storyKey, stage }).slice(0, 24)}`];
}

function withFocusNovelty(config, event) {
  if (event?.type === "gmgn_flow_surge") {
    const { freshness, tradingPriority, ...sourceEvent } = event;
    return { ...sourceEvent, canonicalSignalId: event.eventKey, canonicalSignalIds: [event.eventKey] };
  }
  if (event?.type === "genius_fun_update") {
    // Only exact source/event identity may consume a Genius observation.
    // Ignore producer-provided generic concept keys or ticker-based novelty.
    const { freshness, tradingPriority, ...sourceEvent } = event;
    return { ...sourceEvent, canonicalSignalId: event.eventKey, canonicalSignalIds: [event.eventKey] };
  }
  if (event?.type === "telegram_news_update") {
    // Keep public-channel identity in its own namespace. It can collapse the
    // same observed story/stage across message revisions, but can never cover
    // (or be covered by) an authenticated first-party source.
    const canonicalSignalIds = telegramNewsNoveltyKeys(event);
    return {
      ...event,
      canonicalSignalId: canonicalSignalIds[0] || null,
      canonicalSignalIds,
    };
  }
  const fomoKeys = fomoNoveltyKeys(event);
  const ponKeys = ponFunNoveltyKeys(event);
  const kolLaunchKeys = isKolSelfLaunchEvent(event)
    ? kolTokenLaunchCanonicalSignalIds(event)
    : [];
  if (!isThreePlatformScope(config) && !fomoKeys.length && !ponKeys.length && !kolLaunchKeys.length) return event;
  const canonicalSignalIds = [...new Set([
    ...(isThreePlatformScope(config) ? focusNoveltyKeys(event) : []),
    ...(isThreePlatformScope(config) ? binanceNoveltyKeys(event) : []),
    ...(isThreePlatformScope(config) ? aiNoveltyKeys(event) : []),
    ...(isThreePlatformScope(config) ? githubSemanticNoveltyKeys(event) : []),
    ...ponKeys,
    ...fomoKeys,
    ...kolLaunchKeys,
  ])].sort();
  return canonicalSignalIds.length ? { ...event, canonicalSignalId: canonicalSignalIds[0], canonicalSignalIds } : event;
}

function fomoNoveltyKeys(event) {
  if (event?.type !== "fomo_family_top_call"
    || !["top_blogger_first_buy", "top_blogger_convergence", "fomo_published_call", "fomo_x_call", SMART_WALLET_SIGNAL_KIND].includes(event?.signalKind)) return [];
  const token = String(event?.token || event?.contractAddress || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token) || Number(event?.chain?.id ?? event?.chain?.chainId) !== 56) return [];
  if (event.signalKind === "top_blogger_convergence") return [`fomo:convergence:bsc:${token}`];
  // The user wants the first trustworthy call for a token, not the same call
  // repeated by the official feed, a relay, and the linked public X post.
  return [`fomo:call:bsc:${token}`];
}

const AI_NOVELTY_IDENTIFIERS = /\b(?:grok[- ]?\d+(?:\.\d+)*(?:[- ](?:fast|mini|heavy|preview|beta))?|grok[- ]?(?:build|imagine|voice|bot|code)(?:[- ](?:image|video|fast|mini|preview|beta|\d+(?:\.\d+)*)){0,3}|x\s+activity\s+api|x\s+api|xdk|chat[- ]xdk|responses\s+api|batch\s+api|files\s+api|speech\s+to\s+(?:text|speech)|text\s+to\s+speech|plugin\s+marketplace|context\s+compaction|websocket\s+responses?)\b/gi;

function aiNoveltyKeys(event) {
  const aiOfficial = event?.type === "ai_official_update"
    || event?.project?.signalProfile === "ai"
    || (event?.sourceTrust === "official_verified" && event?.xaiOfficial === true);
  if (!aiOfficial) return [];
  const text = [
    event?.title,
    event?.message,
    event?.summary,
    event?.tweet?.text,
    ...(event?.keyChanges || []),
    ...(event?.signal?.keyChanges || []),
    ...(event?.identifiers || []),
  ].filter(Boolean).join(" ");
  const explicitStage = String(event?.stage || event?.productChange?.stage || "").toLowerCase();
  const stage = /security/.test(explicitStage) || /\bsecurity\s+(?:incident|advisory|fix)\b/i.test(text) ? "security"
    : /pricing/.test(explicitStage) || /\b(?:pricing|price)\s+(?:update|change|cut|drop)\b/i.test(text) ? "pricing"
      : /deprecat|sunset/.test(explicitStage) || /\bdeprecat|sunset\b/i.test(text) ? "deprecated"
        : /remov|retir/.test(explicitStage) || /\bremov(?:e|ed)|retir(?:e|ed)|shut\s+down\b/i.test(text) ? "removed"
          : "new";
  const rawProduct = noveltySlug(event?.product?.id || event?.project?.id || "");
  const product = ["grok", "xai"].includes(rawProduct) ? "grok"
    : rawProduct === "x-api" || /\bx\s+(?:api|activity\s+api)\b|\bxdk\b/i.test(text) ? "x-api"
      : rawProduct === "x" ? "x" : "grok";
  const identifiers = [...text.matchAll(AI_NOVELTY_IDENTIFIERS)]
    .map((match) => noveltySlug(match[0]))
    .filter(Boolean);
  if (identifiers.length) return [...new Set(identifiers.map((identifier) => `ai:${product}:${identifier}:${stage}`))].sort();
  const title = noveltySlug(event?.title || event?.signal?.headline || event?.message || event?.tweet?.text || "");
  return title ? [`ai:${product}:title:${title}:${stage}`] : [];
}

const BINANCE_NOVELTY_CONCEPTS = [
  ["square-kol-call", /\b(?:binance\s+square|square\s+(?:creator|kol|call)|kol\s+(?:buy|call|signal)|trade\s+sharing)\b/i],
  ["smart-money-signal", /\bsmart\s+money\s+(?:signal|copy)\b/i],
  ["signal-copy", /\b(?:signal\s+(?:copy|sharing)|copy\s+(?:a\s+)?(?:signal|trade)|social\s+trading)\b/i],
  ["meme-rush", /\bmeme\s+rush\b/i],
  ["buildkey", /\bbuildkey\b/i],
  ["web3-api", /\bweb3\s+api\b/i],
  ["agentic-wallet", /\bagentic\s+wallet\b/i],
  ["alpha-2", /\balpha\s+2(?:\.0)?\b/i],
  ["prediction-market", /\bprediction\s+markets?\b/i],
  ["launchpool", /\blaunchpool\b/i],
  ["pre-market", /\bpre[- ]market\b/i],
];

function binanceAgentNativeNovelty(event) {
  const developer = event?.type === "binance_official_update" && event?.kind === "developer_update";
  const values = developer
    ? [
      ...(event?.addedSignals || []),
      ...(event?.keyChanges || []).filter((value) => !/^\s*Removed\s*:/iu.test(String(value || ""))),
    ]
    : [
      event?.title,
      event?.message,
      event?.summary,
      event?.factSummary,
      event?.tweet?.text,
      event?.signal?.headline,
      ...(event?.signal?.keyChanges || []),
      ...(event?.keyChanges || []),
      event?.repository,
    ];
  const text = values.filter(Boolean).join(" ");
  if (!/\bAgent\s+(?:OS|Native|REST\s+API)\b|\/agent-native\/|\bBinance\s+MCP\s+Server\b/iu.test(text)) return null;
  const exactLaunch = event?.type === "twitter_update"
    && String(event?.tweet?.id || "") === "2090380033013764166"
    && String(event?.tweet?.handle || "").replace(/^@/, "").toLowerCase() === "binance";
  const stage = developer || /developers\.binance\.com|\/docs?\//iu.test(String(event?.url || event?.source?.url || ""))
    ? "docs"
    : exactLaunch || (/\bAgent\s+OS\b/iu.test(text) && (
      (event?.type === "twitter_update" && /\b(?:build|deploy|use)\b/iu.test(text))
      || (event?.type === "binance_official_update" && event?.kind === "announcement"
        && /\b(?:launch(?:ed)?|available|live)\b|正式发布|已上线/iu.test(text))
    ))
      ? "launch"
      : /\b(?:security|permission|authentication|authorization|sandbox)\b/iu.test(text)
        ? "security"
        : "capability";
  const detail = /\bMCP\b|\/mcp-server(?:\b|\/)/iu.test(text)
    ? "mcp-server"
    : /\bAgent\s+REST\s+API\b/iu.test(text)
      ? "agent-rest-api"
      : /\bAgent\s+OS\b/iu.test(text)
        ? "agent-os"
        : /\bAgent\s+Native\b|\/agent-native\//iu.test(text)
          ? "agent-native"
          : digest(values).slice(0, 16);
  return { stage, detail };
}

function binanceNoveltyKeys(event) {
  const repository = String(event?.repository || "").toLowerCase();
  const officialEvent = event?.type === "binance_official_update"
    || isBinancePlatformEvent(event)
    || (event?.sourceTrust === "official_verified" && repository.startsWith("binance/"));
  if (!officialEvent) return [];
  const agentNative = binanceAgentNativeNovelty(event);
  if (agentNative) return [`binance:agent-os:${agentNative.stage}:${agentNative.detail}`];
  if (event?.type === "binance_official_update" && event?.kind === "developer_update") {
    const delta = [
      ...(event?.addedSignals || []),
      ...(event?.removedSignals || []).map((value) => `removed:${value}`),
      ...(event?.keyChanges || []),
    ].map((value) => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    if (delta.length) return [`binance:developer:${digest(delta).slice(0, 24)}`];
  }
  const text = [
    event?.title,
    event?.message,
    event?.summary,
    event?.factSummary,
    event?.tweet?.text,
    event?.signal?.headline,
    ...(event?.signal?.keyChanges || []),
    ...(event?.keyChanges || []),
  ].filter(Boolean).join(" ");
  const concepts = BINANCE_NOVELTY_CONCEPTS
    .filter(([, pattern]) => pattern.test(text))
    .map(([concept]) => `binance:concept:${concept}`);
  if (concepts.length) return concepts;
  const title = String(event?.title || event?.signal?.headline || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, " ")
    .trim();
  if (title.length < 12) return [];
  const occurredAt = String(event?.publishedAt || event?.tweet?.createdAt || "").slice(0, 16);
  return [`binance:title:${digest({ title, occurredAt }).slice(0, 24)}`];
}

function flapTrackedTokenIdentity(event) {
  if (event?.type !== "bsc_launchpad_update"
    || event?.kind !== "flap_pool_token"
    || event?.featureTrackedToken !== true
    || eventPlatform(event) !== "flap"
    || String(event?.platform?.trust || "").toLowerCase() !== "official_verified"
    || Number(event?.featureTokenTarget) !== 3
    || event?.informationalOnly !== true
    || event?.autoTradeEligible !== false
    || event?.automaticExecution !== false) return null;
  const ordinal = Number(event.featureTokenOrdinal);
  const token = String(event?.tokens?.[0]?.token || "").toLowerCase();
  const quoteAsset = String(event?.mode?.quoteAsset || "").toLowerCase();
  const quoteSymbol = String(event?.mode?.quoteSymbol || "").trim();
  const featureActivationKey = String(event?.featureActivationKey || "").trim();
  const rawGeneration = event?.featureGenerationKey
    ?? event?.generation
    ?? event?.generationKey
    ?? event?.featureTokenGeneration
    ?? event?.featureActivationGeneration;
  const generation = rawGeneration == null ? "" : String(rawGeneration).trim();
  const security = String(event?.security?.decision || "unknown").toLowerCase();
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 3
    || !/^0x[a-f0-9]{40}$/.test(token)
    || !/^0x[a-f0-9]{40}$/.test(quoteAsset)
    || !quoteSymbol
    || !featureActivationKey
    || !generation
    || featureActivationKey !== generation
    || !["pass", "block", "unknown"].includes(security)) return null;
  return { ordinal, token, quoteAsset, quoteSymbol, featureActivationKey, generation, security };
}

const FLAP_TRACKED_TOKEN_PORTAL = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
const FLAP_TRACKED_TOKEN_CREATED_TOPIC = "0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603";

function hasVerifiedFlapTrackedTokenProof(event, identity = flapTrackedTokenIdentity(event)) {
  const proof = event?.featureTokenProof;
  const pair = event?.pools?.[0] || {};
  const generation = /^quote:(0x[a-f0-9]{40}):generation:(0x[a-f0-9]{64}):(0x[a-f0-9]{64}):(0|[1-9]\d*)$/.exec(identity?.generation || "");
  const blockNumber = Number(event?.blockNumber);
  const transactionIndex = Number(event?.transactionIndex);
  const logIndex = Number(event?.logIndex);
  const confirmations = Number(proof?.confirmations);
  const requiredConfirmations = Number(proof?.requiredConfirmations);
  if (!identity
    || !generation
    || generation[1] !== identity.quoteAsset
    || proof?.version !== 1
    || proof?.canonical !== true
    || String(proof?.activationId || "") !== identity.generation
    || String(proof?.activationEventKey || "") !== `flap-quote:56:${generation[3]}:${generation[4]}`
    || String(proof?.quoteAddress || "").toLowerCase() !== identity.quoteAsset
    || String(proof?.tokenAddress || "").toLowerCase() !== identity.token
    || String(proof?.portal || "").toLowerCase() !== FLAP_TRACKED_TOKEN_PORTAL
    || String(proof?.tokenCreatedTopic || "").toLowerCase() !== FLAP_TRACKED_TOKEN_CREATED_TOPIC
    || String(event?.launcher || "").toLowerCase() !== FLAP_TRACKED_TOKEN_PORTAL
    || !/^0x[a-f0-9]{64}$/.test(String(event?.transactionHash || "").toLowerCase())
    || !/^0x[a-f0-9]{64}$/.test(String(event?.blockHash || "").toLowerCase())
    || !Number.isSafeInteger(blockNumber) || blockNumber <= 0
    || !Number.isSafeInteger(transactionIndex) || transactionIndex < 0
    || !Number.isSafeInteger(logIndex) || logIndex < 0
    || String(proof?.transactionHash || "").toLowerCase() !== String(event?.transactionHash || "").toLowerCase()
    || Number(proof?.blockNumber) !== blockNumber
    || String(proof?.blockHash || "").toLowerCase() !== String(event?.blockHash || "").toLowerCase()
    || Number(proof?.transactionIndex) !== transactionIndex
    || Number(proof?.logIndex) !== logIndex
    || !Number.isSafeInteger(confirmations) || confirmations < 0
    || !Number.isSafeInteger(requiredConfirmations) || requiredConfirmations < 0
    || confirmations < requiredConfirmations
    || !/^0x[a-f0-9]{40}$/.test(String(proof?.pairAddress || "").toLowerCase())
    || !String(proof?.pairKind || "").trim()
    || String(pair?.pool || pair?.poolId || "").toLowerCase() !== String(proof.pairAddress).toLowerCase()
    || String(pair?.kind || "") !== String(proof.pairKind)
    || String(event?.sourceUrl || "") !== `https://bscscan.com/tx/${String(event.transactionHash).toLowerCase()}`
    || event?.explorerUrl !== event.sourceUrl
    || String(event?.activationSourceUrl || "") !== `https://bscscan.com/tx/${generation[3]}`) return false;
  const token0 = String(pair?.token0 || "").toLowerCase();
  const token1 = String(pair?.token1 || "").toLowerCase();
  return pair?.verifiedDex === true
    && ((token0 === identity.token && token1 === identity.quoteAsset)
      || (token1 === identity.token && token0 === identity.quoteAsset));
}

function verifiedFlapTrackedTokenCanonicalRevision(event, identity = flapTrackedTokenIdentity(event)) {
  const revision = event?.canonicalRevision;
  const keys = [
    "version", "reason", "ordinal", "replacesEventKey", "replacesBlockHash",
    "replacesTokenAddress",
  ];
  const exactKeys = revision
    && typeof revision === "object"
    && !Array.isArray(revision)
    && Object.keys(revision).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(revision, key));
  const ordinaryPrefix = identity
    ? `bsc-flap-pool-token:${identity.generation}:${identity.ordinal}:`
    : "";
  const replacedTail = exactKeys && String(revision.replacesEventKey || "").startsWith(ordinaryPrefix)
    ? String(revision.replacesEventKey).slice(ordinaryPrefix.length)
    : "";
  const replacedCandidate = /^(0x[a-f0-9]{64}):(0|[1-9]\d*):(0x[a-f0-9]{40})(?::canonical-revision:(0x[a-f0-9]{64}))?$/.exec(replacedTail);
  const newBlockHash = String(event?.blockHash || "").toLowerCase();
  const newBaseKey = identity
    ? `${ordinaryPrefix}${String(event?.transactionHash || "").toLowerCase()}:${Number(event?.logIndex)}:${identity.token}`
    : "";
  if (!identity
    || !exactKeys
    || revision.version !== 1
    || revision.reason !== "token_created_reorg"
    || Number(revision.ordinal) !== identity.ordinal
    || !replacedCandidate
    || replacedCandidate[3] !== String(revision.replacesTokenAddress || "").toLowerCase()
    || !/^0x[a-f0-9]{64}$/.test(String(revision.replacesBlockHash || "").toLowerCase())
    || (replacedCandidate[4]
      && replacedCandidate[4] !== String(revision.replacesBlockHash).toLowerCase())
    || String(revision.replacesBlockHash).toLowerCase() === newBlockHash
    || !/^0x[a-f0-9]{64}$/.test(newBlockHash)
    || event?.eventKey !== `${newBaseKey}:canonical-revision:${newBlockHash}`
    || revision.replacesEventKey === event.eventKey
    || !hasVerifiedFlapTrackedTokenProof(event, identity)) return null;
  return {
    ordinal: identity.ordinal,
    newBlockHash,
    replacesEventKey: revision.replacesEventKey,
    replacesBlockHash: String(revision.replacesBlockHash).toLowerCase(),
    replacesTokenAddress: String(revision.replacesTokenAddress).toLowerCase(),
  };
}

function isVerifiedFlapTrackedTokenRecovery(event) {
  const identity = flapTrackedTokenIdentity(event);
  const recovery = event?.delayedRecovery;
  if (!identity
    || !hasVerifiedFlapTrackedTokenProof(event, identity)
    || recovery?.version !== 1
    || recovery?.reason !== "verified_generation_archive_catch_up"
    || recovery?.continuousCoverage !== true
  ) return false;
  const sourceOccurredAt = Date.parse(recovery.sourceOccurredAt || "");
  const firstObservedAt = Date.parse(recovery.firstObservedAt || "");
  const recoveredAt = Date.parse(recovery.recoveredAt || "");
  return Number.isFinite(sourceOccurredAt)
    && Number.isFinite(firstObservedAt)
    && Number.isFinite(recoveredAt)
    && sourceOccurredAt <= firstObservedAt
    && firstObservedAt <= recoveredAt
    && Number(recovery.lagMs) === Math.max(0, recoveredAt - sourceOccurredAt)
    && Date.parse(event?.blockTimestamp || "") === sourceOccurredAt
    && Date.parse(event?.observedAt || "") === recoveredAt;
}

const DURABLE_FLAP_TRACKED_TOKEN_DISPOSITIONS = new Set([
  "flap_tracked_token_monitor_only",
  "flap_tracked_token_delayed_recovery",
  "flap_tracked_token_canonical_revision",
  "flap_tracked_token_delayed_delivery",
]);

function isDurablyAcceptedFlapTrackedTokenEntry(entry) {
  const identity = flapTrackedTokenIdentity(entry?.event);
  const disposition = entry?.deliveryDisposition;
  const retryableDestination = Object.values(entry?.destinations || {})
    .some((destination) => ["pending", "failed", "delivering"].includes(destination?.status));
  const initiallyFresh = entry?.event?.freshness?.decision === "realtime";
  return Boolean(
    identity
      && hasVerifiedFlapTrackedTokenProof(entry.event, identity)
      && entry?.status === "pending"
      && retryableDestination
      && disposition?.deliverImmediately === true
      && DURABLE_FLAP_TRACKED_TOKEN_DISPOSITIONS.has(disposition?.reason)
      && (initiallyFresh
        || isVerifiedFlapTrackedTokenRecovery(entry.event)
        || Boolean(verifiedFlapTrackedTokenCanonicalRevision(entry.event, identity))),
  );
}

function flapTrackedTokenRetryDisposition(entry, event, fallback) {
  if (!isDurablyAcceptedFlapTrackedTokenEntry(entry) || fallback?.deliverImmediately === true) return fallback;
  const priority = isTradingPriority(event?.tradingPriority) ? event.tradingPriority : null;
  if (!flapTrackedTokenIdentity(event)
    || priority?.tier !== "T2"
    || priority?.hardGates?.exactTarget !== true
    || priority?.hardGates?.trustedConfirmation !== true
    || priority?.plan?.automaticExecution !== false) return fallback;
  // Persistence, not producer-controlled freshness fields, grants this retry.
  // It is permanently monitor-only and downgraded to a no-chase T2 card.
  return Object.freeze({
    mode: "immediate",
    deliverImmediately: true,
    tier: "T2",
    reason: "flap_tracked_token_delayed_delivery",
  });
}

const DURABLE_FOUR_REGISTRY_DISPOSITIONS = new Set([
  "four_registry_capability",
  "four_registry_first_token_monitor_only",
  "four_registry_delayed_recovery",
  "four_registry_delayed_delivery",
  "four_registry_canonical_revision",
]);

function isStrictFourRegistryUpdate(event) {
  return isStrictFourRegistryCapabilityUpdate(event) || isStrictFourRegistryFirstTokenUpdate(event);
}

function fourRegistryEnqueueValidationEvent(event) {
  if (Object.prototype.hasOwnProperty.call(event || {}, "alertQueuedAt")) return event;
  if (!event?.freshness?.discoveredAt || !event?.tradingPriority) return event;
  // `sendAlerts` has authenticated the raw producer payload before deriving
  // canonical ids, freshness, and priority. Enqueue is the one internal stage
  // immediately before alertQueuedAt is persisted; validate that exact staged
  // shape by supplying only the timestamp enqueue itself is about to add.
  return { ...event, alertQueuedAt: event.freshness.discoveredAt };
}

function isStrictFourRegistryEnqueueUpdate(event) {
  return isStrictFourRegistryUpdate(fourRegistryEnqueueValidationEvent(event));
}

function isStrictFourRegistryCanonicalRestorationForEnqueue(event) {
  return isStrictFourRegistryCanonicalRestoration(fourRegistryEnqueueValidationEvent(event));
}

function isStrictFourRegistryCanonicalSupersessionForEnqueue(event) {
  return isStrictFourRegistryCanonicalSupersession(fourRegistryEnqueueValidationEvent(event));
}

function isDurablyAcceptedFourRegistryEntry(entry) {
  const disposition = entry?.deliveryDisposition;
  const retryableDestination = Object.values(entry?.destinations || {})
    .some((destination) => ["pending", "failed", "delivering"].includes(destination?.status));
  return Boolean(
    isStrictFourRegistryUpdate(entry?.event)
      && entry?.status === "pending"
      && retryableDestination
      && disposition?.deliverImmediately === true
      && DURABLE_FOUR_REGISTRY_DISPOSITIONS.has(disposition?.reason)
      && entry.event.deliveryPolicy?.durableRetry === true
      && entry.event.deliveryPolicy?.ttlExemptAfterFirstObserved === true,
  );
}

function isAuthenticatedInitialFourRegistryDelivery(event, disposition) {
  const priority = isTradingPriority(event?.tradingPriority) ? event.tradingPriority : null;
  const policy = event?.deliveryPolicy;
  return Boolean(
    isStrictFourRegistryUpdate(event)
      && effectiveFreshnessDecision(event) === "suppress"
      && disposition?.mode === "immediate"
      && disposition?.deliverImmediately === true
      && disposition?.tier === "T2"
      && DURABLE_FOUR_REGISTRY_DISPOSITIONS.has(disposition?.reason)
      && priority?.tier === "T2"
      && priority?.hardGates?.trustedConfirmation === true
      && priority?.hardGates?.t1Eligible === false
      && priority?.plan?.automaticExecution === false
      && policy?.mode === "immediate_monitor_only"
      && policy?.noChase === true
      && policy?.automaticExecution === false
      && policy?.durableRetry === true
      && policy?.ttlExemptAfterFirstObserved === true
      && policy?.firstObservedAt === event.observedAt,
  );
}

function fourRegistryRetryDisposition(entry, event, fallback) {
  if (!isDurablyAcceptedFourRegistryEntry(entry) || fallback?.deliverImmediately === true) return fallback;
  const priority = isTradingPriority(event?.tradingPriority) ? event.tradingPriority : null;
  if (!isStrictFourRegistryUpdate(event)
    || priority?.tier !== "T2"
    || priority?.hardGates?.trustedConfirmation !== true
    || priority?.hardGates?.t1Eligible !== false
    || priority?.plan?.automaticExecution !== false) return fallback;
  return Object.freeze({
    mode: "immediate",
    deliverImmediately: true,
    tier: "T2",
    reason: "four_registry_delayed_delivery",
  });
}

function isFocusOnchainTokenActivation(event) {
  if (flapTrackedTokenIdentity(event)) return true;
  if (openFourCoreTokenCreatedSemanticKey(event)) return true;
  const supportedType = event?.type === "bsc_launchpad_update"
    || (isMorphLaunchpadEvent(event) && event.kind === "new_mode");
  if (!supportedType || !["new_mode", "new_launchpad"].includes(event.kind)) return false;
  return (event.tokens || []).some((token) => /^0x[a-fA-F0-9]{40}$/.test(String(token?.token || token || "")));
}

function deliveredImmutableOpenFourDuplicate(outbox, eventId, event) {
  const incoming = immutableOpenFourSignalKeys(event);
  if (!incoming.length) return null;
  const coverage = new Map();
  for (const key of incoming) {
    const owner = outbox.immutableOpenFourSignalOwners?.[key];
    if (owner && owner.eventId !== eventId) {
      coverage.set(key, { id: owner.eventId, status: "delivered", immutableSignalOwner: true });
    }
  }
  for (const candidate of Object.values(outbox.events || {})) {
    if (candidate?.id === eventId || candidate?.status !== "delivered") continue;
    for (const key of immutableOpenFourSignalKeys(candidate.event)) {
      if (incoming.includes(key) && !coverage.has(key)) coverage.set(key, candidate);
    }
  }
  if (!incoming.every((key) => coverage.has(key))) return null;
  return coverage.get(incoming[0]);
}

function hasDeliveringOpenFourEntry(outbox, eventId, event, now) {
  const incoming = immutableOpenFourSignalKeys(event);
  if (!incoming.length) return false;
  const base = incoming[0];
  return Object.values(outbox.events || {}).some((candidate) => {
    if (candidate?.id === eventId || candidate?.status !== "pending") return false;
    const prior = immutableOpenFourSignalKeys(candidate.event);
    if (!prior.includes(base)) return false;
    return Object.values(candidate.destinations || {}).some((destination) => (
      destination?.status === "delivering"
      && new Date(destination.leaseUntil || 0).getTime() > now
    ));
  });
}

function semanticDuplicate(outbox, eventId, event, now = Date.now()) {
  const incoming = new Set(event.canonicalSignalIds || []);
  if (!incoming.size) return null;
  const incomingFlapProofBase = isFlapPortalQuoteEvent(event)
    ? event.originalEventKey || event.eventKey
    : null;
  const singleFlapQuoteSignal = eventPlatform(event) === "flap" && incoming.size === 1
    && /^flap:quote-pair:[a-z0-9-]+:ca:0x[a-f0-9]{40}:live$/.test([...incoming][0])
    ? [...incoming][0]
    : null;
  const singleFlapObservedSignal = eventPlatform(event) === "flap" && incoming.size === 1
    && /^flap:quote-pair:[a-z0-9-]+:ca:0x[a-f0-9]{40}:observed$/.test([...incoming][0])
    ? [...incoming][0]
    : null;
  const orphanedEventKeys = new Set(event.reorgOrphanedEventKeys || []);
  const binanceSignal = [...incoming].every((key) => key.startsWith("binance:"));
  const aiSignal = [...incoming].every((key) => key.startsWith("ai:"));
  const fomoSignal = [...incoming].every((key) => key.startsWith("fomo:call:bsc:"));
  const kolLaunchSignal = [...incoming].every((key) => key.startsWith("kol:token-launch:"));
  const ponSignal = [...incoming].every((key) => key.startsWith("pon:"));
  const telegramSignal = [...incoming].every((key) => key.startsWith("telegram:story:"));
  const dedupWindowMs = binanceSignal || ponSignal ? 6 * 60 * 60 * 1_000
    : aiSignal || telegramSignal ? 24 * 60 * 60 * 1_000 : FOCUS_NOVELTY_DEDUP_MS;
  const incomingIsActivation = isFocusOnchainTokenActivation(event);
  const coverage = new Map();
  // Delivered OpenFour Core proofs outlive the ordinary 30-day event archive.
  // They are immutable on-chain identities, so a Registry catch-up months
  // later must still fold into the original provenance/safety owner.
  for (const key of incoming) {
    const owner = outbox.immutableOpenFourSignalOwners?.[key];
    if (!IMMUTABLE_OPENFOUR_SIGNAL.test(key) || !owner) continue;
    coverage.set(key, { id: owner.eventId, status: "delivered", immutableSignalOwner: true });
  }
  for (const entry of Object.values(outbox.events || {})) {
    if (telegramSignal !== (entry.event?.type === "telegram_news_update")) continue;
    const eligibleStatus = ["pending", "delivered"].includes(entry.status)
      || ((fomoSignal || kolLaunchSignal || telegramSignal)
        && entry.status === "suppressed" && !entry.semanticDuplicateOf);
    if (entry.id === eventId || !eligibleStatus) continue;
    const priorFlapProofBase = isFlapPortalQuoteEvent(entry.event)
      ? entry.event.originalEventKey || entry.event.eventKey
      : null;
    if (incomingFlapProofBase
      && priorFlapProofBase === incomingFlapProofBase
      && /^0x[a-f0-9]{64}$/i.test(String(event.blockHash || ""))
      && /^0x[a-f0-9]{64}$/i.test(String(entry.event?.blockHash || ""))
      && String(entry.event.blockHash).toLowerCase() !== String(event.blockHash).toLowerCase()) {
      continue;
    }
    // A fresh Portal attempt can be durably queued while Telegram is down.
    // The producer deliberately keeps its cursor until actual delivery, then
    // upgrades that same proof to the authenticated delayed-recovery key once
    // the 15-minute window closes.  A still-undelivered base entry is not
    // evidence that the market saw the signal and must not suppress the safer
    // T2 recovery card. A delivered base entry still folds normally.
    if (isFlapQuoteRecoveryEvent(event)
      && entry.status !== "delivered"
      && (entry.id === event.originalEventKey
        || entry.event?.eventKey === event.originalEventKey)) continue;
    if (orphanedEventKeys.has(entry.id)
      || orphanedEventKeys.has(entry.event?.originalEventKey)) continue;
    const createdAt = Date.parse(entry.createdAt || "");
    const immutableOpenFourIdentity = [...incoming].every((key) => IMMUTABLE_OPENFOUR_SIGNAL.test(key));
    if (!immutableOpenFourIdentity
      && (!Number.isFinite(createdAt) || now - createdAt > dedupWindowMs)) continue;
    // Product announcements and the first token created through that product
    // are separate milestones. Keep cross-source dedup within each lane so a
    // GitHub/X announcement cannot hide the first on-chain activation, while
    // repeated observations of that same activation are still suppressed.
    if (!ponSignal && isFocusOnchainTokenActivation(entry.event) !== incomingIsActivation) continue;
    // Older outbox entries predate canonicalSignalIds. Derive their identity
    // lazily so a restart or rollout cannot make an already announced feature
    // look new merely because its first source used the previous schema.
    const storedPrior = entry.event?.canonicalSignalIds || [];
    let prior = storedPrior.length ? storedPrior : [
      ...focusNoveltyKeys(entry.event || {}),
      ...binanceNoveltyKeys(entry.event || {}),
      ...aiNoveltyKeys(entry.event || {}),
      ...githubSemanticNoveltyKeys(entry.event || {}),
      ...ponFunNoveltyKeys(entry.event || {}),
      ...fomoNoveltyKeys(entry.event || {}),
      ...(isKolSelfLaunchEvent(entry.event) ? kolTokenLaunchCanonicalSignalIds(entry.event) : []),
      ...telegramNewsNoveltyKeys(entry.event || {}),
    ];
    // Early focus3 entries collapsed every unversioned Flap Vault into one
    // `vault` key. Refine that legacy identity from the immutable forensic
    // event so an INDEX alert cannot suppress STAKING/NFT/DISTRIBUTION, while
    // repeated INDEX observations from GitHub/X/the official site still fold.
    if (storedPrior.includes("flap:concept:vault")) {
      const refined = focusNoveltyKeys(entry.event || {}).filter((key) => /^flap:concept:vault:(?:index|staking|nft|distribution)$/.test(key));
      if (refined.length) prior = [...new Set([...storedPrior.filter((key) => key !== "flap:concept:vault"), ...refined])];
    }
    // A proven live transition is stronger than the fallback observation and
    // may consume a later weak replay. The reverse is intentionally false: a
    // prior-state-unavailable observation must never hide a future proven 0→1.
    if (singleFlapObservedSignal && entry.status === "delivered") {
      const liveEquivalent = singleFlapObservedSignal.replace(/:observed$/u, ":live");
      if (prior.includes(liveEquivalent) && !coverage.has(singleFlapObservedSignal)) {
        coverage.set(singleFlapObservedSignal, entry);
      }
    }
    // Pending cross-source evidence is not durable proof that the alert was
    // seen. The enqueue step migrates this one exact Flap live signal into a
    // single active entry and inherits each already-delivered destination.
    // Only a fully delivered prior entry may semantically consume the Portal
    // producer event and allow its cursor to advance.
    if (singleFlapQuoteSignal
      && entry.status !== "delivered"
      && prior.includes(singleFlapQuoteSignal)) continue;
    for (const key of prior) {
      if (incoming.has(key) && !coverage.has(key)) coverage.set(key, entry);
    }
  }
  if (![...incoming].every((key) => coverage.has(key))) return null;
  const activationIdentity = incomingIsActivation
    ? [...incoming].find((key) => key.includes(":feature-activation:"))
    : null;
  return coverage.get(activationIdentity || incoming.values().next().value) || null;
}

export function alertEventKey(event) {
  if (event?.type === "gmgn_flow_surge") return String(event.eventKey);
  if (isKolSelfLaunchEvent(event)) {
    return kolTokenLaunchEventKey(event) || String(event.eventKey || "kol-self-launch:invalid");
  }
  if (event.type === "narrative_trade_signal") {
    return String(event.eventKey || `narrative-trade:${event.signal?.decisionHash || "invalid"}`);
  }
  if (event.type === "fomo_monitor_health_update") return String(event.eventKey);
  if (event.type === "telegram_news_update") {
    return `telegram-news:${event.chatId}:${String(event.messageId)}:${String(event.contentDigest).slice(0, 16)}`;
  }
  const flapOriginalEventKey = isFlapPortalQuoteEvent(event)
    ? event.originalEventKey || event.eventKey
    : null;
  if (flapOriginalEventKey
    && event.reorgOrphanedEventKeys?.includes(flapOriginalEventKey)
    && /^0x[a-f0-9]{64}$/i.test(String(event.blockHash || ""))) {
    // A reorg can re-include the same transaction/log index in a different
    // canonical block. Keep the authenticated producer eventKey unchanged,
    // but give the replacement its own durable delivery identity. Retrying the
    // same replacement block still resolves to one exact outbox entry.
    return `${event.eventKey}:canonical:${String(event.blockHash).toLowerCase()}`;
  }
  if (event.eventKey) return String(event.eventKey);
  if (event.type === "ai_official_update") {
    return `ai:${event.source?.id || "official"}:${event.entryId || digest({ url: event.url, title: event.title, publishedAt: event.publishedAt })}`.toLowerCase();
  }
  if (event.type === "binance_official_update" && event.kind === "announcement") {
    const code = event.article?.code;
    if (code) return `binance-announcement:${code}`.toLowerCase();
    return `binance-announcement:${digest({
      title: event.title || "untitled",
      publishedAt: event.publishedAt || null,
      changeType: event.changeType || "published",
      updatedAt: event.updatedAt || null,
    })}`;
  }
  if (event.type === "token_launch") return `token-launch:${event.transactionHash || "unknown"}:${event.launcher || "unknown"}:${event.tokens?.[0]?.token || "unknown"}`.toLowerCase();
  if (event.type === "contract_deployed") return `contract-deployed:${event.transactionHash || "unknown"}:${event.contract || "unknown"}`.toLowerCase();
  if (event.type === "official_activity") return `official:${event.transactionHash || "unknown"}:${event.activity || "activity"}:${event.token || "unknown"}`.toLowerCase();
  if (event.type === "fomo_family_top_call") {
    if (event.signalKind === SMART_WALLET_SIGNAL_KIND) {
      const traceIndex = event.logIndex ?? event.traceIndex ?? event.sourceTrade?.logIndex ?? 0;
      return `smart-wallet-buy:bsc:${event.transactionHash || "unknown"}:${traceIndex}:${event.walletAddress || "unknown"}:${event.token || "unknown"}`.toLowerCase();
    }
    return `fomo-call:${event.signalKind || "call"}:${event.callId || `${event.chainId}:${event.token}:${event.publishedAt}`}`.toLowerCase();
  }
  if (event.type === "github_module_update") return `github:${event.repository}:${event.commit}`.toLowerCase();
  if (event.type === "github_monitor_gap") return String(event.eventKey || `github-gap:${event.repository}:${event.gap?.previousSha}:${event.gap?.newestSha}`).toLowerCase();
  if (event.type === "github_repository_discovered") return `github-repository:${event.repository}:${event.address || "unknown"}`.toLowerCase();
  if (event.type === "github_repository_verified") return `github-repository-verified:${event.repository}`.toLowerCase();
  if (event.type === "twitter_update") {
    if (isBinancePlatformEvent(event)) {
      const announcement = [event.tweet?.text, ...(event.tweet?.expandedUrls || [])].join(" ").match(/support\/announcement\/detail\/([a-f0-9]{32})/i)?.[1];
      if (announcement) return `binance-announcement:${announcement}`.toLowerCase();
    }
    return `twitter:${event.tweet?.handle || "unknown"}:${event.tweet?.id || digest(event.tweet?.text || "")}`.toLowerCase();
  }
  if (event.type === "pons_v2_factory_discovered") return `pons-v2-factory:${event.factory}`.toLowerCase();
  if (event.type === "pons_v2_factory_status_update") return String(event.eventKey || `pons-v2-factory-status:${event.factory}:${digest(event.changes || {})}`).toLowerCase();
  if (event.type === "early_activity_alert") return `early:${event.entry?.token || "unknown"}:${event.activity || "activity"}:stage-${event.stage || 0}:${digest(event.additions || {})}`.toLowerCase();
  if (event.type === "launchpad_site_update") return `site:${event.launchpad?.id || event.url || "unknown"}:${digest({ newSocials: event.newSocials, newContracts: event.newContracts, newKeywords: event.newKeywords, newFeatures: event.newFeatures, newPages: event.newPages, newAssets: event.newAssets, newChains: event.newChains })}`;
  return `${event.type}:${digest(event)}`;
}

function configuredDestinations(config) {
  return [
    config.telegramToken && config.telegramChatId ? "telegram" : null,
    config.webhookUrl ? "webhook" : null,
  ].filter(Boolean);
}

function emptyOutbox() {
  return {
    version: OUTBOX_VERSION,
    events: {},
    immutableOpenFourSignalOwners: {},
    fourRegistryDeliveryOwners: {},
  };
}

function immutableOpenFourSignalKeys(event) {
  const base = openFourCoreTokenCreatedSemanticKey(event);
  if (!base || !IMMUTABLE_OPENFOUR_SIGNAL.test(base)) return [];
  const safetyPass = openFourCoreTokenCreatedSafetyPassSemanticKey(event);
  return safetyPass && IMMUTABLE_OPENFOUR_SIGNAL.test(safetyPass)
    ? [base, safetyPass]
    : [base];
}

function normalizeImmutableOpenFourSignalOwners(value) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("immutable OpenFour signal owners must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_IMMUTABLE_OPENFOUR_SIGNAL_OWNERS) {
    throw new TypeError("immutable OpenFour signal owner capacity exceeded");
  }
  const normalizedOwners = {};
  for (const [signal, owner] of entries) {
    const keys = owner && typeof owner === "object" && !Array.isArray(owner)
      ? Object.keys(owner)
      : [];
    const exactKeys = keys.length === 3
      && ["version", "eventId", "deliveredAt"].every((key) => Object.prototype.hasOwnProperty.call(owner, key));
    const deliveredAt = Date.parse(owner?.deliveredAt || "");
    if (!IMMUTABLE_OPENFOUR_SIGNAL.test(signal)
      || !exactKeys
      || owner.version !== 1
      || typeof owner.eventId !== "string"
      || owner.eventId.length < 1
      || owner.eventId.length > 512
      || !Number.isFinite(deliveredAt)) {
      throw new TypeError(`invalid immutable OpenFour signal owner ${signal}`);
    }
    normalizedOwners[signal] = {
      version: 1,
      eventId: owner.eventId,
      deliveredAt: new Date(deliveredAt).toISOString(),
    };
  }
  return normalizedOwners;
}

function normalizeFourRegistryDeliveryOwners(value) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Four Registry delivery owners must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_FOUR_REGISTRY_DELIVERY_OWNERS) {
    throw new TypeError("Four Registry delivery owner capacity exceeded");
  }
  const normalizedOwners = {};
  for (const [eventId, owner] of entries) {
    const keys = owner && typeof owner === "object" && !Array.isArray(owner)
      ? Object.keys(owner)
      : [];
    const deliveredOwner = keys.length === 7
      && [
        "version", "eventId", "baseEventKey", "blockHash", "payloadDigest",
        "deliveryEvidenceDigest", "deliveredAt",
      ]
        .every((key) => Object.prototype.hasOwnProperty.call(owner, key));
    const semanticOwner = keys.length === 10
      && [
        "version", "eventId", "baseEventKey", "blockHash", "payloadDigest",
        "deliveryEvidenceDigest", "status", "duplicateOf", "canonicalOwnerDelivered",
        "ownerDeliveredAt",
      ].every((key) => Object.prototype.hasOwnProperty.call(owner, key));
    const deliveredAt = Date.parse(deliveredOwner ? owner?.deliveredAt || "" : owner?.ownerDeliveredAt || "");
    if ((!deliveredOwner && !semanticOwner)
      || owner.version !== 1
      || owner.eventId !== eventId
      || eventId.length < 1
      || eventId.length > 512
      || typeof owner.baseEventKey !== "string"
      || owner.baseEventKey.length < 1
      || owner.baseEventKey.length > 512
      || !/^0x[a-f0-9]{64}$/u.test(owner.blockHash)
      || !/^0x[a-f0-9]{64}$/u.test(owner.payloadDigest)
      || !/^0x[a-f0-9]{64}$/u.test(owner.deliveryEvidenceDigest)
      || (semanticOwner && (owner.status !== "semantic_duplicate"
        || typeof owner.duplicateOf !== "string"
        || owner.duplicateOf.length < 1
        || owner.duplicateOf.length > 512
        || owner.canonicalOwnerDelivered !== true))
      || !Number.isFinite(deliveredAt)) {
      throw new TypeError(`invalid Four Registry delivery owner ${eventId}`);
    }
    normalizedOwners[eventId] = deliveredOwner ? {
      version: 1,
      eventId,
      baseEventKey: owner.baseEventKey,
      blockHash: owner.blockHash,
      payloadDigest: owner.payloadDigest,
      deliveryEvidenceDigest: owner.deliveryEvidenceDigest,
      deliveredAt: new Date(deliveredAt).toISOString(),
    } : {
      version: 1,
      eventId,
      baseEventKey: owner.baseEventKey,
      blockHash: owner.blockHash,
      payloadDigest: owner.payloadDigest,
      deliveryEvidenceDigest: owner.deliveryEvidenceDigest,
      status: "semantic_duplicate",
      duplicateOf: owner.duplicateOf,
      canonicalOwnerDelivered: true,
      ownerDeliveredAt: new Date(deliveredAt).toISOString(),
    };
  }
  return normalizedOwners;
}

function semanticFourRegistryOwnerDeliveredAt(outbox, entry) {
  if (typeof entry?.semanticDuplicateOf !== "string"
    || !entry.semanticDuplicateOf) return null;
  const direct = outbox.events?.[entry.semanticDuplicateOf];
  if (direct?.status === "delivered"
    || Object.values(direct?.destinations || {}).some((destination) => destination?.status === "delivered")) {
    const destinationAt = Object.values(direct?.destinations || {})
      .filter((destination) => destination?.status === "delivered")
      .map((destination) => Date.parse(destination.deliveredAt || ""))
      .find(Number.isFinite);
    const directAt = Date.parse(direct.deliveredAt || direct.updatedAt || "");
    if (Number.isFinite(destinationAt)) return new Date(destinationAt).toISOString();
    if (Number.isFinite(directAt)) return new Date(directAt).toISOString();
  }
  const registryOwner = outbox.fourRegistryDeliveryOwners?.[entry.semanticDuplicateOf];
  const registryAt = Date.parse(registryOwner?.deliveredAt || registryOwner?.ownerDeliveredAt || "");
  if (Number.isFinite(registryAt)) return new Date(registryAt).toISOString();
  const immutableOwner = Object.values(outbox.immutableOpenFourSignalOwners || {})
    .find((owner) => owner?.eventId === entry.semanticDuplicateOf);
  const immutableAt = Date.parse(immutableOwner?.deliveredAt || "");
  return Number.isFinite(immutableAt) ? new Date(immutableAt).toISOString() : null;
}

function rememberFourRegistryDeliveryOwner(outbox, entry) {
  if (entry?.fourRegistryCompactedOwnerReplay === true || !isStrictFourRegistryUpdate(entry?.event)) return 0;
  const eventId = String(entry.id || "");
  const common = {
    version: 1,
    eventId,
    baseEventKey: String(fourRegistryBaseEventKey(entry.event) || ""),
    blockHash: String(entry.event.blockHash || ""),
    payloadDigest: String(entry.event.payloadDigest || ""),
    deliveryEvidenceDigest: String(entry.event.deliveryEvidenceDigest || ""),
  };
  const semanticOwnerDeliveredAt = semanticFourRegistryOwnerDeliveredAt(outbox, entry);
  const owner = entry.status === "delivered"
    ? {
        ...common,
        deliveredAt: new Date(entry.deliveredAt || entry.updatedAt || Date.now()).toISOString(),
      }
    : entry.status === "suppressed"
      && entry.semanticDuplicateOwnerDelivered === true
      && typeof entry.semanticDuplicateOf === "string"
      && semanticOwnerDeliveredAt
      ? {
          ...common,
          status: "semantic_duplicate",
          duplicateOf: entry.semanticDuplicateOf,
          canonicalOwnerDelivered: true,
          ownerDeliveredAt: semanticOwnerDeliveredAt,
        }
      : null;
  if (!owner) return 0;
  // Reuse the read-time validator here so a future producer schema change
  // cannot silently persist an unauthenticated compact owner.
  normalizeFourRegistryDeliveryOwners({ [eventId]: owner });
  outbox.fourRegistryDeliveryOwners ||= {};
  const existing = outbox.fourRegistryDeliveryOwners[eventId];
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(owner)) {
      throw new Error(`Four Registry delivery owner conflict for ${eventId}`);
    }
    return 0;
  }
  if (Object.keys(outbox.fourRegistryDeliveryOwners).length >= MAX_FOUR_REGISTRY_DELIVERY_OWNERS) {
    throw new Error("Four Registry delivery owner capacity exceeded");
  }
  outbox.fourRegistryDeliveryOwners[eventId] = Object.freeze(owner);
  return 1;
}

function assertFourRegistryDeliveryOwnerCapacity(outbox, event) {
  if (!isStrictFourRegistryEnqueueUpdate(event)) return;
  const eventId = alertEventKey(event);
  const persistedOwner = outbox.fourRegistryDeliveryOwners?.[eventId];
  if (persistedOwner
    && (persistedOwner.baseEventKey !== fourRegistryBaseEventKey(event)
      || persistedOwner.blockHash !== event.blockHash
      || persistedOwner.payloadDigest !== event.payloadDigest
      || persistedOwner.deliveryEvidenceDigest !== event.deliveryEvidenceDigest)) {
    throw new Error(`Four Registry delivery owner conflict for ${eventId}`);
  }
  const occupied = new Set(Object.keys(outbox.fourRegistryDeliveryOwners || {}));
  for (const entry of Object.values(outbox.events || {})) {
    if (isStrictFourRegistryUpdate(entry?.event)) occupied.add(String(entry.id || ""));
  }
  occupied.add(eventId);
  if (occupied.size > MAX_FOUR_REGISTRY_DELIVERY_OWNERS) {
    throw new Error("Four Registry delivery owner capacity exceeded");
  }
}

function rememberImmutableOpenFourSignalOwner(outbox, entry) {
  if (entry?.status !== "delivered") return 0;
  const keys = immutableOpenFourSignalKeys(entry.event);
  if (!keys.length) return 0;
  outbox.immutableOpenFourSignalOwners ||= {};
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(outbox.immutableOpenFourSignalOwners, key));
  if (Object.keys(outbox.immutableOpenFourSignalOwners).length + missing.length > MAX_IMMUTABLE_OPENFOUR_SIGNAL_OWNERS) {
    throw new Error("immutable OpenFour signal owner capacity exceeded");
  }
  const deliveredAt = new Date(entry.deliveredAt || entry.updatedAt || Date.now()).toISOString();
  for (const key of missing) {
    outbox.immutableOpenFourSignalOwners[key] = Object.freeze({
      version: 1,
      eventId: String(entry.id || entry.event?.eventKey || key).slice(0, 512),
      deliveredAt,
    });
  }
  return missing.length;
}

function assertImmutableOpenFourSignalCapacity(outbox, event) {
  const incoming = immutableOpenFourSignalKeys(event);
  if (!incoming.length) return;
  const occupied = new Set(Object.keys(outbox.immutableOpenFourSignalOwners || {}));
  for (const entry of Object.values(outbox.events || {})) {
    for (const key of immutableOpenFourSignalKeys(entry?.event)) occupied.add(key);
  }
  for (const key of incoming) occupied.add(key);
  if (occupied.size > MAX_IMMUTABLE_OPENFOUR_SIGNAL_OWNERS) {
    throw new Error("immutable OpenFour signal owner capacity exceeded");
  }
}

function pruneOutbox(outbox, now = Date.now()) {
  let removed = 0;
  for (const [key, entry] of Object.entries(outbox.events || {})) {
    if (!["delivered", "suppressed"].includes(entry.status)) continue;
    const terminalAt = new Date(entry.deliveredAt || entry.suppressedAt || entry.updatedAt || 0).getTime();
    if (Number.isFinite(terminalAt) && now - terminalAt > OUTBOX_RETENTION_MS) {
      // Compact an authenticated, delivered Core proof into a permanent
      // ownership tombstone before pruning its much larger alert/render
      // payload. The immutable tx/log/token identity and its optional
      // safety-pass strength therefore survive normal 30-day retention.
      rememberImmutableOpenFourSignalOwner(outbox, entry);
      rememberFourRegistryDeliveryOwner(outbox, entry);
      delete outbox.events[key];
      removed += 1;
    }
  }
  return removed;
}

async function readOutbox(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return {
      ...emptyOutbox(),
      ...parsed,
      version: OUTBOX_VERSION,
      events: parsed.events || {},
      immutableOpenFourSignalOwners: normalizeImmutableOpenFourSignalOwners(parsed.immutableOpenFourSignalOwners),
      fourRegistryDeliveryOwners: normalizeFourRegistryDeliveryOwners(parsed.fourRegistryDeliveryOwners),
    };
  } catch (error) {
    if (error.code === "ENOENT") return emptyOutbox();
    throw error;
  }
}

async function withClosedHandle(handle, operation) {
  try {
    const result = await operation(handle);
    await handle.close();
    return result;
  } catch (error) {
    // Preserve the write/sync error: a secondary close failure must not make
    // the durability boundary look like a different, retryable operation.
    await handle.close().catch(() => {});
    throw error;
  }
}

async function writeOutbox(file, outbox, fsImpl = fs) {
  const directory = path.dirname(file);
  await fsImpl.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    // The outbox keeps the full persisted render bundle for deterministic
    // retries. Compact JSON materially reduces parse/stringify allocation for
    // that payload without changing the durable schema.
    const payload = `${JSON.stringify(outbox)}\n`;
    const temporaryHandle = await fsImpl.open(temporary, "wx", 0o600);
    await withClosedHandle(temporaryHandle, async (handle) => {
      await handle.writeFile(payload, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    });
    await fsImpl.rename(temporary, file);
    // Enforce the private mode even when replacing an older permissive file.
    // The temp inode already carries 0600; this explicit post-rename chmod is
    // also the migration boundary for historical 0644 outboxes.
    await fsImpl.chmod(file, 0o600);
    const directoryHandle = await fsImpl.open(directory, "r");
    await withClosedHandle(directoryHandle, (handle) => handle.sync());
  } catch (error) {
    // A failure after rename is intentionally still reported. The visible
    // replacement may be the new file, but mutateOutbox has not acknowledged
    // it; the next source observation reads that state and retries idempotently
    // instead of delivering from an unconfirmed enqueue.
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function outboxFileSignature(file) {
  try {
    const stat = await fs.stat(file, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}`;
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

function withFileLock(file, operation) {
  const previous = fileLocks.get(file) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  fileLocks.set(file, current.catch(() => {}));
  return current;
}

async function mutateOutbox(config, mutation, { writeIf = () => true } = {}) {
  const file = path.join(config.dataDir, "alert-outbox.json");
  return withFileLock(file, async () => {
    const outbox = await readOutbox(file);
    const pruned = pruneOutbox(outbox);
    const result = await mutation(outbox);
    if (pruned > 0 || writeIf(result)) await writeOutbox(file, outbox, config.alertOutboxFsImpl || fs);
    return result;
  });
}

async function inspectOutbox(config, inspection) {
  const file = path.join(config.dataDir, "alert-outbox.json");
  return withFileLock(file, async () => inspection(await readOutbox(file)));
}

function isCurrentTelegramRenderBundle(event, bundle) {
  if (bundle?.version !== BILINGUAL_RENDER_VERSION) return false;
  if (event?.type === "gmgn_flow_surge") return bundle.format === "telegram_zh_en_gmgn_flow_v1" && bundle.eventType === event.type;
  // Preserve already persisted v1 wording on delivery retries; new events use v2.
  if (event?.type === "genius_fun_update") return ["telegram_zh_en_genius_v1", "telegram_zh_en_genius_v2"].includes(bundle.format) && bundle.eventType === event.type;
  if (isKolSelfLaunchEvent(event)) {
    return bundle.format === "telegram_zh_en_kol_launch_v3"
      && bundle.signalKind === "kol_self_launch";
  }
  if (event?.type === "narrative_trade_signal") {
    return bundle.format === "telegram_zh_en_narrative_v2"
      && bundle.focusModel?.eventType === "narrative_trade_signal";
  }
  if (deriveNewPoolContext(event)) {
    return bundle.format === "telegram_zh_en_pool_context_v2"
      && Boolean(bundle.focusModel?.newPoolContext);
  }
  return true;
}

async function ensureTelegramRenderBundle(config, eventId, event, claimedBundle = null) {
  if (isCurrentTelegramRenderBundle(event, claimedBundle)) return claimedBundle;
  // claimAlertDestinations returns the immutable persisted event and the
  // current render bundle in the same locked snapshot. Do not parse the full
  // outbox again on the critical path when that bundle is absent or stale.
  const baseMessage = telegramFreshnessText(event, compact(event));
  const generated = await buildBilingualAlertBundle({
    ...config,
    alertForceLocalStructured: isCriticalAlertDelivery(event),
  }, event, baseMessage);
  const persisted = await mutateOutbox(config, (outbox) => {
    const entry = outbox.events[eventId];
    if (!entry) return generated;
    if (!isCurrentTelegramRenderBundle(event, entry.renderBundle)) {
      entry.renderBundle = generated;
      entry.updatedAt = new Date(alertPipelineNow(config)).toISOString();
    }
    return entry.renderBundle;
  });
  const fallback = [persisted.zh, persisted.en].filter((item) => item?.status?.includes("fallback")
    && item?.provider !== "local_structured");
  if (fallback.length) {
    console.error(`[alert-translation] fallback event=${event?.type || "unknown"} id=${eventId} languages=${fallback.map((item) => item === persisted.zh ? "zh" : "en").join(",")} errors=${fallback.map((item) => item.error || "provider unavailable").join(" | ")}`);
  }
  return persisted;
}

async function deliverDestination(config, event, destination, renderBundle = null, deliveryContext = {}) {
  const criticalAlert = deliveryContext.criticalAlert === true;
  const optionalNumber = (value) => value === null || value === undefined ? null : Number(value);
  const deadlineAtMs = optionalNumber(deliveryContext.deadlineAtMs);
  const sourceDeadlineAtMs = optionalNumber(deliveryContext.sourceDeadlineAtMs);
  const boundedTimeoutAt = (startedAtMs) => {
    if (!criticalAlert || !Number.isFinite(deadlineAtMs)) return 10_000;
    const remainingMs = deadlineAtMs - startedAtMs;
    if (remainingMs <= CRITICAL_ALERT_COMPLETION_RESERVE_MS) {
      throw new Error("critical alert delivery budget exhausted before external delivery attempt");
    }
    return Math.max(1, Math.min(
      CRITICAL_ALERT_TELEGRAM_MAX_MS,
      remainingMs - CRITICAL_ALERT_COMPLETION_RESERVE_MS,
    ));
  };
  if (destination === "telegram") {
    const strong = config.telegramStrongAlerts && isStrongAlert(event);
    let renderedText;
    const bilingualDelivery = config.alertBilingualEnabled === true
      || event.type === "gmgn_flow_surge"
      || event.type === "genius_fun_update"
      || event.type === "fomo_monitor_health_update"
      || isKolSelfLaunchEvent(event)
      || event.type === "narrative_trade_signal"
      || Boolean(deriveNewPoolContext(event));
    if (bilingualDelivery) {
      const bundle = renderBundle || await buildBilingualAlertBundle(config, event, telegramFreshnessText(event, compact(event)));
      renderedText = telegramSafeText(renderBilingualTelegramText(bundle, strong), 3_900);
    } else {
      const localizedEvent = criticalAlert ? event : await localizeAlertEvent(config, event);
      const message = telegramSafeText(telegramFreshnessText(localizedEvent, compact(localizedEvent)), strong ? 3_400 : 3_480);
      renderedText = strong ? `🔴 强提醒｜${message}` : message;
    }
    const telegramStartedAtMs = alertPipelineNow(config);
    const pipelineStartedAtMs = Number(deliveryContext.pipelineStartedAtMs);
    const sourceStartedAtMs = Number(deliveryContext.sourceStartedAtMs);
    const endToEndBudgetMs = optionalNumber(deliveryContext.endToEndBudgetMs);
    const pollAllowanceMs = optionalNumber(deliveryContext.pollAllowanceMs) ?? 0;
    const deliverySlaBasis = String(deliveryContext.deliverySlaBasis || "alert_pipeline");
    const sourceSlaAccepted = deliveryContext.sourceSlaAccepted === true;
    const deliveryAttempt = deliveryContext.deliveryAttempt === "retry" ? "retry" : "realtime";
    const claimedAtMs = Number(deliveryContext.claimedAtMs);
    const renderStartedAtMs = Number(deliveryContext.renderStartedAtMs);
    const renderCompletedAtMs = Number(deliveryContext.renderCompletedAtMs);
    const duration = (start, end) => Number.isFinite(start) && Number.isFinite(end)
      ? Math.max(0, end - start)
      : null;
    let telegramTimeoutMs = null;
    const timingAt = (telegramCompletedAtMs) => {
      const totalMs = duration(pipelineStartedAtMs, telegramCompletedAtMs);
      const sourceToTelegramMs = duration(sourceStartedAtMs, telegramCompletedAtMs);
      const worstCaseEndToEndMs = sourceToTelegramMs === null ? null : pollAllowanceMs + sourceToTelegramMs;
      const withinEndToEndBudget = criticalAlert
        && sourceToTelegramMs !== null
        && worstCaseEndToEndMs !== null
        && Number.isFinite(sourceDeadlineAtMs)
        && Number.isFinite(endToEndBudgetMs)
          ? worstCaseEndToEndMs <= endToEndBudgetMs && telegramCompletedAtMs <= sourceDeadlineAtMs
          : null;
      return {
        pipelineStartedAt: Number.isFinite(pipelineStartedAtMs) ? new Date(pipelineStartedAtMs).toISOString() : null,
        sourceStartedAt: Number.isFinite(sourceStartedAtMs) ? new Date(sourceStartedAtMs).toISOString() : null,
        deliveryDeadlineAt: Number.isFinite(sourceDeadlineAtMs) ? new Date(sourceDeadlineAtMs).toISOString() : null,
        attemptDeadlineAt: Number.isFinite(deadlineAtMs) ? new Date(deadlineAtMs).toISOString() : null,
        deliverySlaBasis,
        sourceSlaAccepted,
        deliveryAttempt,
        claimedAt: Number.isFinite(claimedAtMs) ? new Date(claimedAtMs).toISOString() : null,
        renderStartedAt: Number.isFinite(renderStartedAtMs) ? new Date(renderStartedAtMs).toISOString() : null,
        renderCompletedAt: Number.isFinite(renderCompletedAtMs) ? new Date(renderCompletedAtMs).toISOString() : null,
        telegramStartedAt: new Date(telegramStartedAtMs).toISOString(),
        telegramCompletedAt: new Date(telegramCompletedAtMs).toISOString(),
        enqueueToClaimMs: duration(pipelineStartedAtMs, claimedAtMs),
        claimPersistMs: duration(claimedAtMs, renderStartedAtMs),
        renderMs: duration(renderStartedAtMs, renderCompletedAtMs),
        telegramMs: duration(telegramStartedAtMs, telegramCompletedAtMs),
        telegramTimeoutMs,
        totalMs,
        sourceToTelegramMs,
        pollAllowanceMs,
        worstCaseEndToEndMs,
        budgetMs: criticalAlert ? CRITICAL_ALERT_DELIVERY_BUDGET_MS : null,
        endToEndBudgetMs: criticalAlert && Number.isFinite(endToEndBudgetMs) ? endToEndBudgetMs : null,
        withinBudget: criticalAlert && totalMs !== null
          ? totalMs <= CRITICAL_ALERT_DELIVERY_BUDGET_MS
            && (!Number.isFinite(deadlineAtMs) || telegramCompletedAtMs <= deadlineAtMs)
          : null,
        withinEndToEndBudget,
        slaBreached: sourceSlaAccepted ? withinEndToEndBudget !== true : false,
        breachMs: sourceSlaAccepted && Number.isFinite(sourceDeadlineAtMs)
          ? Math.max(
            0,
            telegramCompletedAtMs - sourceDeadlineAtMs,
            Number.isFinite(worstCaseEndToEndMs) && Number.isFinite(endToEndBudgetMs)
              ? worstCaseEndToEndMs - endToEndBudgetMs
              : 0,
          )
          : null,
      };
    };
    let payload;
    try {
      telegramTimeoutMs = boundedTimeoutAt(telegramStartedAtMs);
      payload = await postJson(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
        chat_id: config.telegramChatId,
        text: renderedText,
        disable_web_page_preview: true,
        disable_notification: !strong,
        reply_markup: telegramButtons(event),
      }, {}, { requireTelegramReceipt: true, timeoutMs: telegramTimeoutMs });
    } catch (error) {
      if (error && typeof error === "object") error.alertDeliveryTiming = timingAt(alertPipelineNow(config));
      throw error;
    }
    const timing = timingAt(alertPipelineNow(config));
    return {
      messageId: payload.result.message_id,
      renderedText,
      renderVersion: bilingualDelivery ? ALERT_RENDER_VERSION : LEGACY_ALERT_RENDER_VERSION,
      timing,
      ...(renderBundle ? {
        translation: {
          zh: { status: renderBundle.zh.status, provider: renderBundle.zh.provider, latencyMs: renderBundle.zh.latencyMs, error: renderBundle.zh.error },
          en: { status: renderBundle.en.status, provider: renderBundle.en.provider, latencyMs: renderBundle.en.latencyMs, error: renderBundle.en.error },
        },
      } : {}),
    };
  }
  if (destination === "webhook") {
    await postJson(config.webhookUrl, event, {}, {
      timeoutMs: boundedTimeoutAt(alertPipelineNow(config)),
    });
    return {};
  }
  throw new Error(`unsupported destination ${destination}`);
}

function refreshDeliveryFreshness(config, event, evaluatedAt = Date.now()) {
  const current = classifyAlertFreshness(config, event, evaluatedAt);
  if (!current || current.decision === "unassessed") return event;
  const initial = event.freshness || current;
  return {
    ...event,
    freshness: {
      ...initial,
      deliveryEvaluatedAt: current.discoveredAt,
      deliveryLagMs: current.lagMs,
      deliveryDecision: current.decision,
    },
  };
}

function outboxEntryStatus(destinationState) {
  const active = Object.values(destinationState || {}).filter((state) => state.status !== "disabled");
  if (!active.length) return "suppressed";
  if (active.every((state) => state.status === "delivered")) return "delivered";
  return "pending";
}

const PON_FUN_REALTIME_T2_CHAIN_KINDS = new Set(["market_created", "stock_listing", "factory_unpaused"]);

function isRealtimeExactPonT2(event, priority) {
  const commonProof = isPonFunEvent(event)
    && !isPonFunDelayedRecoveryEvent(event)
    && effectiveFreshnessDecision(event) === "realtime"
    && priority?.confirmation?.kind === "official_site_bound_onchain_fingerprint"
    && priority?.hardGates?.exactTarget === true
    && priority?.hardGates?.trustedConfirmation === true
    && priority?.hardGates?.validWindow === true;
  if (!commonProof) return false;
  if (event.kind === "market_lifecycle") {
    // API transitions are realtime only when the closed producer envelope
    // proves the exact official endpoints and a fresh on-chain Factory
    // binding. A trust string or a free-form snapshot is insufficient.
    return event.freshness?.basis === "observedAt_continuous_coverage"
      && isOfficialPonFunUpdate(event);
  }
  return PON_FUN_REALTIME_T2_CHAIN_KINDS.has(String(event.kind || ""))
    && /^0x[a-f0-9]{64}$/i.test(String(event.transactionHash || ""))
    && Number.isSafeInteger(Number(event.blockNumber))
    && Number(event.blockNumber) > 0
    && event.evidence?.receiptVerified === true
    && event.freshness?.basis === "blockTimestamp";
}

/**
 * Pure delivery policy. Producers may persist anything admitted by source and
 * relevance gates, but only these explicit lanes are allowed to fan out now.
 */
export function alertDeliveryDisposition(event = {}) {
  if (event.type === "gmgn_flow_surge" && isGmgnFlowEvent(event) && effectiveFreshnessDecision(event) !== "suppress") {
    return Object.freeze({ mode: "immediate", deliverImmediately: true, tier: null, reason: "gmgn_flow_watch_only" });
  }
  if (event.type === "genius_fun_update" && isGeniusOfficialEvent(event) && effectiveFreshnessDecision(event) !== "suppress") {
    return Object.freeze({ mode: "immediate", deliverImmediately: true, tier: null, reason: "genius_official_watch_only" });
  }
  if (event.type === "fomo_monitor_health_update") {
    return Object.freeze({ mode: "immediate", deliverImmediately: true, tier: null, reason: "fomo_health_realtime" });
  }
  if (isKolSelfLaunchEvent(event)
    && verifyKolTokenLaunchEvent(event).valid
    && effectiveFreshnessDecision(event) !== "suppress") {
    return Object.freeze({
      mode: "immediate",
      deliverImmediately: true,
      tier: null,
      reason: "kol_self_launch_watch_only",
    });
  }
  const priority = isTradingPriority(event.tradingPriority) ? event.tradingPriority : null;
  const tier = priority?.tier || null;
  if (isFourMemePolicyFixRecoveryEvent(event)
    && tier === "T2"
    && priority?.category === "focus_policy_recovery"
    && priority?.hardGates?.validWindow === true
    && priority?.hardGates?.t1Eligible === false
    && priority?.plan?.automaticExecution === false) {
    return Object.freeze({
      mode: "immediate",
      deliverImmediately: true,
      tier,
      reason: "fourmeme_policy_fix_recovery",
    });
  }
  if (isStrictFourMemeMarketCampaign(event)
    && tier === "T2"
    && priority?.category === "focus_market_campaign"
    && priority?.hardGates?.trustedConfirmation === true
    && priority?.hardGates?.validWindow === true
    && priority?.hardGates?.t1Eligible === false
    && priority?.plan?.automaticExecution === false) {
    return Object.freeze({
      mode: "immediate",
      deliverImmediately: true,
      tier,
      reason: "fourmeme_market_campaign",
    });
  }
  if (isStrictFourRegistryCanonicalRevision(event)
    && tier === "T2"
    && priority?.category === "focus_registry_canonical_revision"
    && priority?.hardGates?.trustedConfirmation === true
    && priority?.hardGates?.t1Eligible === false
    && priority?.plan?.automaticExecution === false) {
    return Object.freeze({
      mode: "immediate",
      deliverImmediately: true,
      tier,
      reason: "four_registry_canonical_revision",
    });
  }
  if (isStrictFourRegistryDelayedRecovery(event)
    && tier === "T2"
    && priority?.category === "focus_registry_delayed_recovery"
    && priority?.hardGates?.trustedConfirmation === true
    && priority?.hardGates?.t1Eligible === false
    && priority?.plan?.automaticExecution === false) {
    return Object.freeze({
      mode: "immediate",
      deliverImmediately: true,
      tier,
      reason: "four_registry_delayed_recovery",
    });
  }
  if (isStrictFourRegistryFirstTokenUpdate(event)
    && tier === "T2"
    && priority?.category === "focus_registry_first_token"
    && priority?.hardGates?.trustedConfirmation === true
    && priority?.hardGates?.t1Eligible === false
    && priority?.plan?.automaticExecution === false) {
    return Object.freeze({
      mode: "immediate",
      deliverImmediately: true,
      tier,
      reason: isStrictFourRegistryDelayedRecovery(event)
        ? "four_registry_delayed_recovery"
        : effectiveFreshnessDecision(event) === "realtime"
          ? "four_registry_first_token_monitor_only"
          : "four_registry_delayed_delivery",
    });
  }
  if (isStrictFourRegistryCapabilityUpdate(event)
    && tier === "T1"
    && priority?.category === "focus_registry_capability"
    && priority?.hardGates?.trustedConfirmation === true
    && priority?.hardGates?.t1Eligible === true
    && priority?.plan?.automaticExecution === false) {
    return Object.freeze({
      mode: "immediate",
      deliverImmediately: true,
      tier,
      reason: "four_registry_capability",
    });
  }
  if (isStrictFourRegistryCapabilityUpdate(event)
    && !isStrictFourRegistryDelayedRecovery(event)
    && tier === "T2"
    && priority?.category === "focus_registry_capability"
    && priority?.hardGates?.trustedConfirmation === true
    && priority?.hardGates?.t1Eligible === false
    && priority?.plan?.automaticExecution === false) {
    return Object.freeze({
      mode: "immediate",
      deliverImmediately: true,
      tier,
      reason: "four_registry_delayed_delivery",
    });
  }
  if (isStrictBscOpenFourFirstTokenUpdate(event)
    && tier === "T2"
    && priority?.category === "focus_registry_first_token"
    && priority?.hardGates?.trustedConfirmation === true
    && priority?.hardGates?.validWindow === true
    && priority?.hardGates?.t1Eligible === false
    && priority?.plan?.automaticExecution === false) {
    return Object.freeze({
      mode: "immediate",
      deliverImmediately: true,
      tier,
      reason: "four_registry_first_token_monitor_only",
    });
  }
  if (isPonFunDelayedRecoveryEvent(event)) {
    return Object.freeze({ mode: "audit_only", deliverImmediately: false, tier, reason: "pon_delayed_recovery" });
  }
  if (isFlapQuoteRecoveryEvent(event)) {
    // This lane has already been downgraded to a no-chase T2 recovery card.
    // Delivery age updates the warning and timing, but never silently turns a
    // durably queued, verified 0→1 Portal transition into terminal suppression.
    const deliverImmediately = tier === "T2";
    return Object.freeze({
      mode: deliverImmediately ? "immediate" : "audit_only",
      deliverImmediately,
      tier,
      reason: isFlapQuoteFirstObservedAfterGapEvent(event)
        ? "flap_first_observed_after_gap"
        : "flap_delayed_recovery",
    });
  }
  if (isFlapBoardQuoteObservedEvent(event)
    && ["T1", "T2"].includes(tier)
    && priority?.hardGates?.exactTarget === true
    && priority?.hardGates?.trustedConfirmation === true
    && priority?.plan?.automaticExecution === false) {
    // A metadata delay may make the original Board observation stale for
    // trading priority, but it must not erase a genuinely new quote asset.
    // The strict observed-only card remains immediate and never claims 0→1.
    return Object.freeze({ mode: "immediate", deliverImmediately: true, tier, reason: "flap_board_quote_observed" });
  }
  const delayedTrackedTokenRecovery = isVerifiedFlapTrackedTokenRecovery(event);
  const trackedTokenRevision = verifiedFlapTrackedTokenCanonicalRevision(event);
  if (flapTrackedTokenIdentity(event)
    && ["T0", "T1", "T2"].includes(tier)
    && priority?.hardGates?.exactTarget === true
    && priority?.hardGates?.trustedConfirmation === true
    && (priority?.hardGates?.validWindow === true
      || (tier === "T2" && (delayedTrackedTokenRecovery || trackedTokenRevision)))
    && priority?.plan?.automaticExecution === false) {
    // This is a deliberately narrow monitoring exception. A proven official
    // TokenCreated ordinal remains useful even when the local safety result is
    // unknown or blocked, but it can never inherit an execution affordance.
    return Object.freeze({
      mode: "immediate",
      deliverImmediately: true,
      tier,
      reason: trackedTokenRevision
        ? "flap_tracked_token_canonical_revision"
        : delayedTrackedTokenRecovery
        ? "flap_tracked_token_delayed_recovery"
        : "flap_tracked_token_monitor_only",
    });
  }
  const hardGateEligible = tier === "T0"
    ? priority?.hardGates?.t0Eligible === true
    : tier === "T1" ? priority?.hardGates?.t1Eligible === true : false;
  if ((tier === "T0" || tier === "T1") && hardGateEligible) {
    return Object.freeze({ mode: "immediate", deliverImmediately: true, tier, reason: "priority_realtime" });
  }
  if (tier === "T2" && isRealtimeExactPonT2(event, priority)) {
    return Object.freeze({ mode: "immediate", deliverImmediately: true, tier, reason: "pon_exact_onchain_realtime" });
  }
  return Object.freeze({
    mode: "audit_only",
    deliverImmediately: false,
    tier,
    reason: tier ? `${tier.toLowerCase()}_default_audit` : "trading_priority_missing",
  });
}

function disablePolicySuppressedDestinations(destinationState, disposition, now) {
  if (disposition.deliverImmediately) return false;
  let changed = false;
  for (const [name, destination] of Object.entries(destinationState || {})) {
    if (destination.status === "delivered") continue;
    if (destination.status === "disabled" && destination.disabledReason) continue;
    destinationState[name] = {
      ...destination,
      status: "disabled",
      disabledReason: "policy_suppressed",
      policyReason: disposition.reason,
      updatedAt: now,
      leaseUntil: null,
      nextAttemptAt: null,
    };
    changed = true;
  }
  return changed;
}

function disableFreshnessSuppressedTelegram(destinationState, event, now, {
  preserveFlapTrackedToken = false,
  preserveFourRegistry = false,
} = {}) {
  // A strict Flap Portal recovery is a durable structural fact, not an old
  // trade call. Once authenticated and queued it remains retryable as T2 with
  // an explicit no-chase warning until Telegram actually accepts it.
  if (isDurableFlapQuoteNotificationEvent(event)
    || isVerifiedFlapTrackedTokenRecovery(event)
    || isFourMemePolicyFixRecoveryEvent(event)
    || preserveFlapTrackedToken
    || preserveFourRegistry) return false;
  if (effectiveFreshnessDecision(event) !== "suppress") return false;
  const telegram = destinationState.telegram;
  if (!telegram || telegram.status === "delivered") return false;
  destinationState.telegram = {
    ...telegram,
    status: "disabled",
    disabledReason: "freshness_too_old",
    updatedAt: now,
    leaseUntil: null,
    nextAttemptAt: null,
  };
  return true;
}

function disableExpiredTelegramDelivery(config, entry, evaluatedAt = Date.now()) {
  const telegram = entry?.destinations?.telegram;
  if (!telegram || ["delivered", "disabled"].includes(telegram.status)) return false;

  // Operational health transitions describe a still-active monitoring
  // incident, not a time-sensitive market opportunity. Once durably queued,
  // preserve the exact event and render bundle until the destination recovers
  // or an explicit policy/destination decision disables it.
  if (entry.event?.type === "fomo_monitor_health_update") return false;
  if (isDurableFlapQuoteNotificationEvent(entry.event)) return false;
  if (isDurablyAcceptedFlapTrackedTokenEntry(entry)) return false;
  if (isDurablyAcceptedFourRegistryEntry(entry)) return false;
  if (isFourMemePolicyFixRecoveryEvent(entry.event)) return false;

  const isFomo = entry.event?.type === "fomo_family_top_call";
  const isGmgnFlow = entry.event?.type === "gmgn_flow_surge";
  const isPonDelayedRecovery = isPonFunDelayedRecoveryEvent(entry.event);
  // Fomo is useful only as an immediate signal. Anchor its five-minute TTL to
  // immutable source time whenever available; a restart or duplicate scan must
  // never turn an old buy/call into a fresh Telegram delivery. Other alerts
  // retain the durable queue-age contract.
  const sourceAtMs = isGmgnFlow ? epochMs(entry.event.sourceOccurredAt) : isFomo
    ? epochMs(entry.event?.freshness?.sourceOccurredAt)
      ?? epochMs(entry.event?.publishedAt)
      ?? epochMs(entry.event?.blockTimestamp)
      ?? epochMs(entry.event?.timestamp)
      ?? epochMs(entry.event?.timestampMs)
    : null;
  const queuedAtMs = sourceAtMs ?? epochMs(entry.createdAt) ?? epochMs(entry.event?.alertQueuedAt);
  const evaluatedAtMs = epochMs(evaluatedAt) ?? Date.now();
  if (queuedAtMs === null) return false;
  const maxAgeMs = isGmgnFlow ? 900_000 : isFomo
    ? FOMO_TELEGRAM_DELIVERY_MAX_AGE_MS
    : isPonDelayedRecovery
      ? PON_DELAYED_RECOVERY_DELIVERY_MAX_AGE_MS
      : nonNegativeLimit(config, "alertTelegramDeliveryMaxAgeMs", DEFAULT_TELEGRAM_DELIVERY_MAX_AGE_MS);
  const ageMs = Math.max(0, evaluatedAtMs - queuedAtMs);
  if (ageMs <= maxAgeMs) return false;

  entry.destinations.telegram = {
    ...telegram,
    status: "disabled",
    disabledReason: "delivery_ttl_expired",
    deliveryTimeBasis: sourceAtMs === null ? "queue_time" : "source_time",
    deliveryQueuedAt: new Date(queuedAtMs).toISOString(),
    deliveryExpiredAt: new Date(evaluatedAtMs).toISOString(),
    deliveryAgeMs: ageMs,
    deliveryMaxAgeMs: maxAgeMs,
    updatedAt: new Date(evaluatedAtMs).toISOString(),
    leaseUntil: null,
    nextAttemptAt: null,
  };
  return true;
}

async function enqueueAlert(config, event) {
  const destinations = configuredDestinations(config);
  const freshnessSuppressesTelegram = effectiveFreshnessDecision(event) === "suppress";
  const initialDisposition = alertDeliveryDisposition(event);
  if (!destinations.length && !freshnessSuppressesTelegram && initialDisposition.deliverImmediately) {
    throw new AlertDeliveryError(event.type, [{ destination: "configuration", message: "no alert destinations configured" }]);
  }
  const requestedEventId = alertEventKey(event);
  const persistedEventId = await mutateOutbox(config, (outbox) => {
    const now = new Date(alertPipelineNow(config)).toISOString();
    assertImmutableOpenFourSignalCapacity(outbox, event);
    assertFourRegistryDeliveryOwnerCapacity(outbox, event);
    let eventId = requestedEventId;
    const flapProofBase = isFlapPortalQuoteEvent(event)
      ? event.originalEventKey || event.eventKey
      : null;
    const directFlapProducerGate = flapQuoteProducerGateForEvent(event);
    const conflictingFlapProof = flapProofBase && /^0x[a-f0-9]{64}$/i.test(String(event.blockHash || ""))
      ? Object.values(outbox.events || {}).find((entry) => {
          const priorBase = isFlapPortalQuoteEvent(entry.event)
            ? entry.event.originalEventKey || entry.event.eventKey
            : null;
          return priorBase === flapProofBase
            && /^0x[a-f0-9]{64}$/i.test(String(entry.event?.blockHash || ""))
            && String(entry.event.blockHash).toLowerCase() !== String(event.blockHash).toLowerCase();
        })
      : null;
    if (conflictingFlapProof) {
      // The producer may have delivered the old proof and then crashed before
      // persisting its orphan list. The durable outbox is an independent
      // witness: a different canonical block for the same tx/log must receive
      // its own id even when the restarted event cannot carry orphan context.
      eventId = `${event.eventKey}:canonical:${String(event.blockHash).toLowerCase()}`;
    }
    const incomingFlapQuoteSignal = eventPlatform(event) === "flap"
      && event.canonicalSignalIds?.length === 1
      && /^flap:quote-pair:[a-z0-9-]+:ca:0x[a-f0-9]{40}:live$/.test(event.canonicalSignalIds[0])
      ? event.canonicalSignalIds[0]
      : null;
    const incomingFlapObservedSignal = eventPlatform(event) === "flap"
      && event.canonicalSignalIds?.length === 1
      && /^flap:quote-pair:[a-z0-9-]+:ca:0x[a-f0-9]{40}:observed$/.test(event.canonicalSignalIds[0])
      ? event.canonicalSignalIds[0]
      : null;
    const observedEquivalent = incomingFlapQuoteSignal?.replace(/:live$/u, ":observed") || null;
    const liveEquivalent = incomingFlapObservedSignal?.replace(/:observed$/u, ":live") || null;
    const inFlightFlapQuoteEntry = incomingFlapQuoteSignal || incomingFlapObservedSignal
      ? Object.values(outbox.events || {}).find((entry) => entry.id !== eventId
        && (() => {
          const prior = entry.event?.canonicalSignalIds || focusNoveltyKeys(entry.event || {});
          const delivering = Object.values(entry.destinations || {})
            .some((destination) => destination.status === "delivering");
          if (incomingFlapQuoteSignal) {
            return delivering && (prior.includes(incomingFlapQuoteSignal)
              || prior.includes(observedEquivalent));
          }
          // While stronger live evidence is pending, it owns the destination.
          // Let this producer-authorized call drive that entry rather than
          // posting a weaker observation beside it. Once live is delivered,
          // semantic dedup below records the weak observation as suppressed.
          return entry.status === "pending" && prior.includes(liveEquivalent);
        })())
      : null;
    if (inFlightFlapQuoteEntry) {
      // Never migrate a destination while its HTTP request is in flight. The
      // caller reuses the durable entry and receives queued until that request
      // settles; the next observation either folds a delivered signal or
      // takes over a failed/pending destination without creating a second POST.
      // If the incoming evidence is the strict Portal producer, retain that
      // ownership on a board-created entry too. Its retry must wait for a
      // fresh on-chain revalidation instead of being claimed by the generic
      // outbox worker after the in-flight request settles.
      if (directFlapProducerGate && !incomingFlapObservedSignal) {
        inFlightFlapQuoteEntry.flapQuoteProducerGate = directFlapProducerGate;
        inFlightFlapQuoteEntry.updatedAt = now;
      }
      return inFlightFlapQuoteEntry.id;
    }
    const existing = outbox.events[eventId];
    const fourRegistryReactivation = fourRegistryReactivationKind(existing, event, eventId);
    const persistedFourRegistryOwner = outbox.fourRegistryDeliveryOwners?.[eventId];
    if (!existing && persistedFourRegistryOwner && isStrictFourRegistryEnqueueUpdate(event)) {
      // The full alert entry may have been compacted after 30 days while the
      // producer was waiting to persist its acknowledgement. Re-materialize a
      // terminal receipt only; the exact delivered proof must never POST a
      // second time. Identity mismatches were rejected by the capacity guard.
      const duplicateOf = persistedFourRegistryOwner.status === "semantic_duplicate"
        ? persistedFourRegistryOwner.duplicateOf
        : persistedFourRegistryOwner.eventId;
      const queuedEvent = { ...event, alertQueuedAt: event.alertQueuedAt || now };
      const destinationState = Object.fromEntries(destinations.map((destination) => [destination, {
        status: "disabled",
        attempts: 0,
        nextAttemptAt: null,
        receipt: null,
        lastError: null,
        disabledReason: "semantic_duplicate",
        duplicateOf,
        updatedAt: now,
        leaseUntil: null,
      }]));
      outbox.events[eventId] = {
        id: eventId,
        event: queuedEvent,
        eventType: event.type,
        status: "suppressed",
        destinations: destinationState,
        createdAt: now,
        updatedAt: now,
        deliveredAt: null,
        suppressedAt: now,
        duplicateCount: 1,
        duplicateObservations: [],
        sideEffectsCommitted: true,
        semanticDuplicateOf: duplicateOf,
        semanticDuplicateOwnerDelivered: true,
        deliveryDisposition: alertDeliveryDisposition(queuedEvent),
        renderBundle: null,
        fourRegistryCompactedOwnerReplay: true,
      };
      return eventId;
    }
    if (existing
      && isStrictFourRegistryEnqueueUpdate(event)
      && !fourRegistryReactivation
      && (fourRegistryBaseEventKey(existing.event) !== fourRegistryBaseEventKey(event)
        || existing.event?.blockHash !== event.blockHash
        || existing.event?.payloadDigest !== event.payloadDigest
        || existing.event?.deliveryEvidenceDigest !== event.deliveryEvidenceDigest)) {
      // The same base id cannot acknowledge a different fork/payload. A
      // canonical re-inclusion must carry the producer's closed revision
      // envelope and therefore a revision-specific event id.
      throw new Error(`Four Registry event identity conflict for ${eventId}`);
    }
    // Generic draining is forbidden for this entry. Therefore a new strict
    // Portal sendAlerts call for the exact original proof and quote address is
    // the producer's current finalized-state authorization to undo a cancel.
    // This also closes a crash after the outbox fsync but before the producer
    // can persist that the disabling proof was orphaned.
    const reactivatingCancelledFlapQuote = Boolean(existing
      && directFlapProducerGate
      && validFlapQuoteCancellationEvidence(existing.flapQuoteCancellation)
      && existing.flapQuoteCancellation.originalEventKey === directFlapProducerGate.originalEventKey
      && existing.flapQuoteCancellation.quoteAddress === directFlapProducerGate.quoteAddress
      && Object.values(existing.destinations || {}).some((destination) => (
        destination.status === "disabled"
        && destination.disabledReason === "flap_quote_no_longer_live"
      )));
    const existingSuperseded = existing?.status === "suppressed"
      && Object.values(existing.destinations || {}).some((destination) => [
        "superseded_by_delayed_recovery",
        "superseded_by_flap_quote_evidence",
      ].includes(destination.disabledReason));
    const semanticDuplicateOf = !existing || existingSuperseded
      ? semanticDuplicate(outbox, eventId, event, Date.parse(now))
      : null;
    const persistedSemanticDuplicateOwner = existing?.semanticDuplicateOf
      ? outbox.events?.[existing.semanticDuplicateOf]
      : null;
    // Persist the proof that consumed this event, not merely the fact that a
    // canonical owner exists. A producer may only advance its durable cursor
    // after that owner was actually delivered. Retrying the same suppressed
    // event refreshes this proof when a formerly-pending owner later succeeds.
    const semanticDuplicateOwnerDelivered = existing?.semanticDuplicateOwnerDelivered === true
      || semanticDuplicateOf?.status === "delivered"
      || persistedSemanticDuplicateOwner?.status === "delivered";
    const activeExisting = existing && !["delivered", "suppressed"].includes(existing.status);
    const retryingDurableFlapTrackedToken = activeExisting
      && isDurablyAcceptedFlapTrackedTokenEntry(existing);
    const retryingDurableFourRegistry = activeExisting
      && isDurablyAcceptedFourRegistryEntry(existing);
    const refreshingFlapNotification = activeExisting
      && isDurableFlapQuoteNotificationEvent(event)
      && existing.event?.eventKey === event.eventKey
      && (!isFlapQuoteRecoveryEvent(event)
        || existing.event?.originalEventKey === event.originalEventKey);
    let queuedEvent = fourRegistryReactivation
      ? { ...event, alertQueuedAt: event.alertQueuedAt || now }
      : reactivatingCancelledFlapQuote
      ? { ...event, alertQueuedAt: existing.event?.alertQueuedAt || existing.createdAt || now }
      : refreshingFlapNotification
      ? { ...event, alertQueuedAt: existing.event?.alertQueuedAt || existing.createdAt || now }
      : existing?.event || { ...event, alertQueuedAt: event.alertQueuedAt || now };
    if ((activeExisting || reactivatingCancelledFlapQuote || fourRegistryReactivation)
      && !["fomo_monitor_health_update", "genius_fun_update", "gmgn_flow_surge"].includes(queuedEvent.type)) {
      // A valid schema is not a timeless eligibility grant. Re-score active
      // retries at the duplicate observation time so a formerly fresh T1
      // cannot be delivered after its trading window has closed.
      queuedEvent = withTradingPriority(queuedEvent, { nowMs: Date.parse(now) });
    }
    if (refreshingFlapNotification || retryingDurableFlapTrackedToken || retryingDurableFourRegistry) {
      // Refresh delivery age for a producer-authorized Portal observation or
      // an already-admitted tracked-token retry so the rebuilt card reports
      // the real wait when the destination finally returns.
      queuedEvent = refreshDeliveryFreshness(config, queuedEvent, Date.parse(now));
      if (retryingDurableFourRegistry) {
        queuedEvent = withTradingPriority(queuedEvent, { nowMs: Date.parse(now) });
      }
    }
    const flapQuoteSignal = eventPlatform(queuedEvent) === "flap"
      && queuedEvent.canonicalSignalIds?.length === 1
      && /^flap:quote-pair:[a-z0-9-]+:ca:0x[a-f0-9]{40}:live$/.test(queuedEvent.canonicalSignalIds[0])
      ? queuedEvent.canonicalSignalIds[0]
      : null;
    const flapQuoteTakeoverEntries = !existing
      && !semanticDuplicateOf
      && flapQuoteSignal
      ? Object.values(outbox.events || {}).filter((stale) => stale.status !== "delivered"
        && stale.id !== eventId
        && (() => {
          const prior = stale.event?.canonicalSignalIds || focusNoveltyKeys(stale.event || {});
          return prior.includes(flapQuoteSignal)
            || prior.includes(flapQuoteSignal.replace(/:live$/u, ":observed"));
        })())
      : [];
    const flapObservedTakeoverIds = new Set(flapQuoteTakeoverEntries
      .filter((stale) => (stale.event?.canonicalSignalIds || focusNoveltyKeys(stale.event || {}))
        .includes(flapQuoteSignal.replace(/:live$/u, ":observed")))
      .map((stale) => stale.id));
    const flapReorgTakeoverIds = new Set(flapQuoteTakeoverEntries.filter((stale) => {
      const priorBase = isFlapPortalQuoteEvent(stale.event)
        ? stale.event.originalEventKey || stale.event.eventKey
        : null;
      return flapProofBase
        && priorBase === flapProofBase
        && /^0x[a-f0-9]{64}$/i.test(String(stale.event?.blockHash || ""))
        && String(stale.event.blockHash).toLowerCase() !== String(event.blockHash || "").toLowerCase();
    }).map((stale) => stale.id));
    const inheritedFlapProducerGate = flapQuoteTakeoverEntries
      .map((entry) => validFlapQuoteProducerGate(entry.flapQuoteProducerGate)
        ? entry.flapQuoteProducerGate
        : flapQuoteProducerGateForEvent(entry.event))
      .find(Boolean);
    const flapQuoteProducerGate = directFlapProducerGate
      || (validFlapQuoteProducerGate(existing?.flapQuoteProducerGate) ? existing.flapQuoteProducerGate : null)
      || inheritedFlapProducerGate
      || null;
    if (flapQuoteTakeoverEntries.length) {
      for (const stale of flapQuoteTakeoverEntries) {
        for (const [destination, destinationState] of Object.entries(stale.destinations || {})) {
          if (destinationState.status === "delivered") continue;
          stale.destinations[destination] = {
            ...destinationState,
            status: "disabled",
            disabledReason: isFlapQuoteRecoveryEvent(queuedEvent)
              ? "superseded_by_delayed_recovery"
              : "superseded_by_flap_quote_evidence",
            supersededBy: eventId,
            updatedAt: now,
            leaseUntil: null,
            nextAttemptAt: null,
          };
        }
        stale.status = outboxEntryStatus(stale.destinations || {});
        if (stale.status === "suppressed") stale.suppressedAt ||= now;
        stale.updatedAt = now;
      }
    }
    const ordinaryDeliveryDisposition = activeExisting || reactivatingCancelledFlapQuote || fourRegistryReactivation
      ? alertDeliveryDisposition(queuedEvent)
      : existing?.deliveryDisposition || alertDeliveryDisposition(queuedEvent);
    const deliveryDisposition = retryingDurableFlapTrackedToken
      ? flapTrackedTokenRetryDisposition({ ...existing, event: queuedEvent }, queuedEvent, ordinaryDeliveryDisposition)
      : retryingDurableFourRegistry
        ? fourRegistryRetryDisposition({ ...existing, event: queuedEvent }, queuedEvent, ordinaryDeliveryDisposition)
        : ordinaryDeliveryDisposition;
    const destinationState = { ...(existing?.destinations || {}) };
    if (reactivatingCancelledFlapQuote) {
      for (const [destination, state] of Object.entries(destinationState)) {
        if (state.status !== "disabled" || state.disabledReason !== "flap_quote_no_longer_live") continue;
        const {
          disabledReason: _disabledReason,
          cancellationReason: _cancellationReason,
          leaseUntil: _leaseUntil,
          nextAttemptAt: _nextAttemptAt,
          updatedAt: _updatedAt,
          ...preserved
        } = state;
        destinationState[destination] = {
          ...preserved,
          status: "pending",
          nextAttemptAt: null,
          leaseUntil: null,
          updatedAt: now,
        };
      }
    }
    if (fourRegistryReactivation) {
      for (const [destination, state] of Object.entries(destinationState)) {
        if (state.status !== "disabled" || state.disabledReason !== "four_registry_canonical_reorg") continue;
        destinationState[destination] = {
          status: "pending",
          attempts: 0,
          nextAttemptAt: null,
          receipt: null,
          lastError: null,
          lastTiming: null,
          leaseUntil: null,
          updatedAt: now,
        };
      }
    }
    for (const destination of destinations) {
      const inherited = flapQuoteTakeoverEntries
        .filter((entry) => !flapReorgTakeoverIds.has(entry.id)
          && !flapObservedTakeoverIds.has(entry.id))
        .map((entry) => ({ entry, state: entry.destinations?.[destination] }))
        .find(({ state }) => state?.status === "delivered");
      destinationState[destination] ||= inherited
        ? { ...inherited.state, inheritedFromEventId: inherited.entry.id }
        : { status: "pending", attempts: 0, nextAttemptAt: null, receipt: null, lastError: null };
    }
    for (const destination of Object.keys(destinationState)) {
      if (!destinations.includes(destination) && destinationState[destination].status !== "delivered") {
        destinationState[destination] = { ...destinationState[destination], status: "disabled", updatedAt: now };
      }
    }
    if (semanticDuplicateOf) {
      for (const destination of Object.keys(destinationState)) {
        if (destinationState[destination].status === "delivered") continue;
        destinationState[destination] = {
          ...destinationState[destination],
          status: "disabled",
          disabledReason: "semantic_duplicate",
          duplicateOf: semanticDuplicateOf.id,
          updatedAt: now,
          leaseUntil: null,
          nextAttemptAt: null,
        };
      }
    }
    const createdAt = existing?.createdAt || now;
    // A duplicate is audit evidence only. It must never revoke (or restore) the
    // delivery eligibility established by the first payload for this event key.
    disableFreshnessSuppressedTelegram(destinationState, queuedEvent, now, {
      preserveFlapTrackedToken: retryingDurableFlapTrackedToken,
      preserveFourRegistry: retryingDurableFourRegistry
        || isAuthenticatedInitialFourRegistryDelivery(queuedEvent, deliveryDisposition),
    });
    disableExpiredTelegramDelivery(config, {
      createdAt,
      event: queuedEvent,
      destinations: destinationState,
      status: outboxEntryStatus(destinationState),
      deliveryDisposition,
    }, now);
    disablePolicySuppressedDestinations(destinationState, deliveryDisposition, now);
    const status = outboxEntryStatus(destinationState);
    const duplicateObservation = existing ? {
      receivedAt: now,
      payloadDigest: digest(event),
      sourceOccurredAt: event.freshness?.sourceOccurredAt || null,
      discoveredAt: event.freshness?.discoveredAt || null,
      lagMs: event.freshness?.lagMs ?? null,
      decision: event.freshness?.decision || null,
    } : null;
    outbox.events[eventId] = {
      ...existing,
      id: eventId,
      event: queuedEvent,
      eventType: existing?.eventType || event.type,
      status,
      destinations: destinationState,
      createdAt,
      updatedAt: now,
      deliveredAt: existing?.deliveredAt || null,
      suppressedAt: status === "suppressed"
        ? existing?.suppressedAt || now
        : reactivatingCancelledFlapQuote || fourRegistryReactivation
          ? null
          : existing?.suppressedAt || null,
      duplicateCount: Number(existing?.duplicateCount || 0) + (existing ? 1 : 0),
      duplicateObservations: duplicateObservation
        ? [...(existing?.duplicateObservations || []), duplicateObservation].slice(-20)
        : existing?.duplicateObservations || [],
      sideEffectsCommitted: Boolean(existing?.sideEffectsCommitted),
      semanticDuplicateOf: fourRegistryReactivation
        ? null
        : existing?.semanticDuplicateOf || semanticDuplicateOf?.id || null,
      ...(!fourRegistryReactivation && (existing?.semanticDuplicateOf || semanticDuplicateOf)
        ? { semanticDuplicateOwnerDelivered }
        : {}),
      deliveryDisposition,
      ...(flapQuoteProducerGate ? { flapQuoteProducerGate } : {}),
      ...(fourRegistryReactivation ? {
        fourRegistryReactivation: { version: 1, kind: fourRegistryReactivation, reactivatedAt: now },
      } : {}),
      ...(refreshingFlapNotification || reactivatingCancelledFlapQuote || fourRegistryReactivation
        || retryingDurableFlapTrackedToken || retryingDurableFourRegistry
        ? { renderBundle: null }
        : {}),
    };
    if (fourRegistryReactivation) delete outbox.events[eventId].semanticDuplicateOwnerDelivered;
    if (reactivatingCancelledFlapQuote) delete outbox.events[eventId].flapQuoteCancellation;
    rememberFourRegistryDeliveryOwner(outbox, outbox.events[eventId]);
    return eventId;
  });
  return persistedEventId || requestedEventId;
}

const FLAP_QUOTE_CANCELLATION_KEYS = Object.freeze([
  "originalEventKey",
  "quoteAddress",
  "reason",
  "disablingEventKey",
  "blockNumber",
  "blockHash",
  "transactionHash",
  "logIndex",
  "observedAt",
]);

function validateFlapQuoteCancellation(value) {
  const exactKeys = value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === FLAP_QUOTE_CANCELLATION_KEYS.length
    && FLAP_QUOTE_CANCELLATION_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (!exactKeys) throw new TypeError("Flap quote cancellation must use the exact schema");
  const original = /^flap-quote:56:(0x[a-f0-9]{64}):(0|[1-9]\d*)$/.exec(String(value.originalEventKey || ""));
  const disabling = /^flap-quote:56:(0x[a-f0-9]{64}):(0|[1-9]\d*)$/.exec(String(value.disablingEventKey || ""));
  if (!original
    || !disabling
    || value.reason !== "quote_asset_disabled"
    || !/^0x[a-f0-9]{40}$/.test(String(value.quoteAddress || ""))
    || !/^0x[a-f0-9]{64}$/.test(String(value.transactionHash || ""))
    || !/^0x[a-f0-9]{64}$/.test(String(value.blockHash || ""))
    || !Number.isSafeInteger(value.blockNumber)
    || value.blockNumber <= 0
    || !Number.isSafeInteger(value.logIndex)
    || value.logIndex < 0
    || disabling[1] !== value.transactionHash
    || Number(disabling[2]) !== value.logIndex
    || value.disablingEventKey !== `flap-quote:56:${value.transactionHash}:${value.logIndex}`
    || strictIsoInstantMs(value.observedAt) === null) {
    throw new TypeError("Flap quote cancellation evidence is invalid");
  }
  return Object.freeze({ ...value });
}

function validFlapQuoteCancellationEvidence(value) {
  try {
    validateFlapQuoteCancellation(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Durably terminalize an undelivered strict Flap Portal activation after the
 * producer has re-read the finalized configuration as disabled.  The outbox
 * mutation and its fsync finish before this resolves, so the producer may
 * advance its own cursor only after a `cancelled` result.  An in-flight HTTP
 * request is never overwritten; the producer must retry the cancellation.
 */
export async function cancelPendingFlapQuoteActivation(config, cancellation) {
  const evidence = validateFlapQuoteCancellation(cancellation);
  const mutation = await mutateOutbox(config, (outbox) => {
    const entries = Object.values(outbox.events || {});
    const directMatches = entries.filter((entry) => {
      const gate = flapQuoteProducerGateForEvent(entry.event);
      return gate?.originalEventKey === evidence.originalEventKey;
    });
    const gatedMatches = entries.filter((entry) => (
      validFlapQuoteProducerGate(entry.flapQuoteProducerGate)
      && entry.flapQuoteProducerGate.originalEventKey === evidence.originalEventKey
    ));
    const mismatchedAddress = [...directMatches, ...gatedMatches]
      .some((entry) => {
        const address = flapPortalQuoteAddress(entry.event)
          || entry.flapQuoteProducerGate?.quoteAddress;
        return address && address !== evidence.quoteAddress;
      });
    if (mismatchedAddress) {
      throw new TypeError("Flap quote cancellation does not match the queued quote address");
    }
    for (const entry of directMatches) {
      const sourceBlock = Number(entry.event?.blockNumber);
      const sourceLogIndex = Number(entry.event?.logIndex);
      if (!Number.isSafeInteger(sourceBlock)
        || !Number.isSafeInteger(sourceLogIndex)
        || evidence.blockNumber < sourceBlock
        || (evidence.blockNumber === sourceBlock && evidence.logIndex <= sourceLogIndex)) {
        throw new TypeError("Flap quote cancellation must be later than the queued activation");
      }
    }
    const ownerIds = new Set(directMatches.flatMap((entry) => Object.values(entry.destinations || {})
      .map((destination) => destination?.supersededBy)
      .filter(Boolean)));
    const matches = [...new Map(entries
      .filter((entry) => directMatches.includes(entry)
        || gatedMatches.includes(entry)
        || ownerIds.has(entry.id))
      .map((entry) => [entry.id, entry])).values()];
    const delivering = matches.filter((entry) => Object.values(entry.destinations || {})
      .some((destination) => destination.status === "delivering"));
    if (delivering.length) {
      return {
        changed: false,
        status: "queued",
        reason: "delivery_in_flight",
        persisted: true,
        terminal: false,
        eventIds: delivering.map((entry) => entry.id).sort(),
      };
    }
    const now = evidence.observedAt;
    let changed = false;
    let cancelledDestinations = 0;
    for (const entry of matches) {
      for (const [name, destination] of Object.entries(entry.destinations || {})) {
        if (["delivered", "disabled"].includes(destination.status)) continue;
        entry.destinations[name] = {
          ...destination,
          status: "disabled",
          disabledReason: "flap_quote_no_longer_live",
          cancellationReason: evidence.reason,
          updatedAt: now,
          leaseUntil: null,
          nextAttemptAt: null,
        };
        cancelledDestinations += 1;
        changed = true;
      }
      if (JSON.stringify(entry.flapQuoteCancellation) !== JSON.stringify(evidence)) {
        entry.flapQuoteCancellation = evidence;
        changed = true;
      }
      const previousStatus = entry.status;
      entry.status = outboxEntryStatus(entry.destinations || {});
      if (entry.status === "suppressed") entry.suppressedAt ||= now;
      if (entry.status === "delivered") entry.deliveredAt ||= now;
      if (changed || entry.status !== previousStatus) entry.updatedAt = now;
    }
    return {
      changed,
      status: "cancelled",
      reason: evidence.reason,
      persisted: true,
      terminal: true,
      eventIds: matches.map((entry) => entry.id).sort(),
      cancelledDestinations,
    };
  }, { writeIf: (result) => result.changed });
  const { changed: _changed, ...result } = mutation;
  return result;
}

const FOUR_REGISTRY_CANCELLATION_KEYS = Object.freeze([
  "eventId",
  "baseEventKey",
  "blockHash",
  "payloadDigest",
  "deliveryEvidenceDigest",
  "reason",
]);

function validateFourRegistryCancellation(value) {
  const exactKeys = value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === FOUR_REGISTRY_CANCELLATION_KEYS.length
    && FOUR_REGISTRY_CANCELLATION_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (!exactKeys
    || typeof value.eventId !== "string"
    || value.eventId.length < 1
    || value.eventId.length > 512
    || typeof value.baseEventKey !== "string"
    || value.baseEventKey.length < 1
    || value.baseEventKey.length > 512
    || !/^0x[a-f0-9]{64}$/u.test(value.blockHash)
    || !/^0x[a-f0-9]{64}$/u.test(value.payloadDigest)
    || !/^0x[a-f0-9]{64}$/u.test(value.deliveryEvidenceDigest)
    || value.reason !== "canonical_reorg") {
    throw new TypeError("Four Registry cancellation must use the exact schema");
  }
  return Object.freeze({ ...value });
}

function fourRegistryBaseEventKey(event) {
  return typeof event?.canonicalRevision?.baseEventKey === "string"
    ? event.canonicalRevision.baseEventKey
    : event?.eventKey;
}

function fourRegistryReactivationKind(existing, event, eventId) {
  if (!existing
    || existing.id !== eventId
    || !isStrictFourRegistryUpdate(existing.event)
    || !isStrictFourRegistryEnqueueUpdate(event)
    || Object.values(existing.destinations || {}).some((destination) => destination?.status === "delivered")
    || !Object.values(existing.destinations || {}).some((destination) => (
      destination?.status === "disabled"
      && destination?.disabledReason === "four_registry_canonical_reorg"
    ))) return null;
  let cancellation;
  try {
    cancellation = validateFourRegistryCancellation(existing.fourRegistryCancellation);
  } catch {
    return null;
  }
  if (cancellation.eventId !== eventId
    || cancellation.baseEventKey !== fourRegistryBaseEventKey(existing.event)
    || cancellation.blockHash !== existing.event.blockHash
    || cancellation.payloadDigest !== existing.event.payloadDigest
    || cancellation.deliveryEvidenceDigest !== existing.event.deliveryEvidenceDigest) return null;

  if (isStrictFourRegistryCanonicalRestorationForEnqueue(event)) {
    const restoration = event.canonicalRestoration;
    if (restoration.cancelledEventId === eventId
      && restoration.blockHash === cancellation.blockHash
      && restoration.payloadDigest === cancellation.payloadDigest
      && event.blockHash === cancellation.blockHash) return "canonical_restoration";
    return null;
  }
  if (isStrictFourRegistryCanonicalSupersessionForEnqueue(event)) {
    const supersession = event.canonicalSupersession;
    if (supersession.cancelledEventId === eventId
      && supersession.cancelledBaseEventKey === cancellation.baseEventKey
      && supersession.cancelledBlockHash === cancellation.blockHash
      && supersession.cancelledPayloadDigest === cancellation.payloadDigest
      && supersession.baseEventKey === fourRegistryBaseEventKey(event)
      && supersession.newBlockHash === event.blockHash) return "canonical_supersession";
  }
  return null;
}

/**
 * Stop a previously persisted Registry proof before the producer advances its
 * reorg cursor. The exact old block and payload digest are checked under the
 * same outbox lock as destination state. An active HTTP lease is never
 * overwritten; the producer must retry this handshake after it settles.
 */
export async function cancelPendingFourRegistryEvent(config, cancellation) {
  const evidence = validateFourRegistryCancellation(cancellation);
  const mutation = await mutateOutbox(config, (outbox) => {
    const entry = outbox.events?.[evidence.eventId];
    if (!entry) {
      const owner = outbox.fourRegistryDeliveryOwners?.[evidence.eventId];
      if (owner) {
        if (owner.baseEventKey !== evidence.baseEventKey
          || owner.blockHash !== evidence.blockHash
          || owner.payloadDigest !== evidence.payloadDigest
          || owner.deliveryEvidenceDigest !== evidence.deliveryEvidenceDigest) {
          throw new TypeError("Four Registry cancellation does not match the persisted delivery owner");
        }
        return {
          changed: false,
          status: "delivered_orphaned",
          reason: evidence.reason,
          persisted: true,
          terminal: true,
          eventId: evidence.eventId,
          deliveredAt: owner.deliveredAt || owner.ownerDeliveredAt,
        };
      }
      return {
        changed: false,
        status: "not_found",
        reason: "registry_event_not_found",
        persisted: false,
        terminal: false,
        eventId: evidence.eventId,
      };
    }
    const event = entry.event;
    if (!isStrictFourRegistryUpdate(event)
      || alertEventKey(event) !== evidence.eventId
      || fourRegistryBaseEventKey(event) !== evidence.baseEventKey
      || event.blockHash !== evidence.blockHash
      || event.payloadDigest !== evidence.payloadDigest
      || event.deliveryEvidenceDigest !== evidence.deliveryEvidenceDigest) {
      throw new TypeError("Four Registry cancellation does not match the persisted proof");
    }
    const registryCoreSignal = immutableOpenFourSignalKeys(event)[0] || null;
    const relatedEntries = registryCoreSignal && !event.canonicalRevision
      ? Object.values(outbox.events || {}).filter((candidate) => (
        immutableOpenFourSignalKeys(candidate?.event)[0] === registryCoreSignal
        && candidate?.event?.blockHash === evidence.blockHash
      ))
      : [entry];
    const delivering = relatedEntries.some((candidate) => Object.values(candidate.destinations || {})
      .some((destination) => destination?.status === "delivering"));
    if (delivering) {
      return {
        changed: false,
        status: "queued",
        reason: "delivery_in_flight",
        persisted: true,
        terminal: false,
        eventId: evidence.eventId,
      };
    }
    const now = new Date(alertPipelineNow(config)).toISOString();
    let semanticFolded = false;
    const immutableDuplicate = deliveredImmutableOpenFourDuplicate(outbox, evidence.eventId, event);
    const deliveredRelated = relatedEntries.find((candidate) => candidate.id !== evidence.eventId
      && (candidate.status === "delivered"
        || Object.values(candidate.destinations || {}).some((destination) => destination?.status === "delivered")));
    const deliveredOwner = deliveredRelated || immutableDuplicate;
    if (deliveredOwner) {
      if (entry.semanticDuplicateOf !== deliveredOwner.id
        || entry.semanticDuplicateOwnerDelivered !== true) semanticFolded = true;
      entry.semanticDuplicateOf = deliveredOwner.id;
      entry.semanticDuplicateOwnerDelivered = true;
    } else if (entry.semanticDuplicateOf
      && semanticFourRegistryOwnerDeliveredAt(outbox, entry)
      && entry.semanticDuplicateOwnerDelivered !== true) {
      entry.semanticDuplicateOwnerDelivered = true;
      semanticFolded = true;
    }
    let changed = semanticFolded
      || JSON.stringify(entry.fourRegistryCancellation) !== JSON.stringify(evidence);
    entry.fourRegistryCancellation = evidence;
    for (const candidate of relatedEntries) {
      for (const [destination, state] of Object.entries(candidate.destinations || {})) {
        if (state.status === "delivered") continue;
        const replacement = {
          ...state,
          status: "disabled",
          disabledReason: "four_registry_canonical_reorg",
          cancellationReason: evidence.reason,
          cancelledByRegistryEventId: evidence.eventId,
          updatedAt: now,
          leaseUntil: null,
          nextAttemptAt: null,
        };
        if (JSON.stringify(state) !== JSON.stringify(replacement)) changed = true;
        candidate.destinations[destination] = replacement;
      }
      candidate.status = outboxEntryStatus(candidate.destinations || {});
      if (candidate.status === "suppressed") candidate.suppressedAt ||= now;
      if (candidate.status === "delivered") candidate.deliveredAt ||= now;
      if (changed) candidate.updatedAt = now;
    }
    const ownerChanged = rememberFourRegistryDeliveryOwner(outbox, entry);
    const compactOwner = outbox.fourRegistryDeliveryOwners?.[evidence.eventId];
    const delivered = entry.status === "delivered"
      || entry.semanticDuplicateOwnerDelivered === true
      || Boolean(deliveredRelated)
      || Object.values(entry.destinations || {}).some((destination) => destination?.status === "delivered");
    changed ||= Boolean(ownerChanged);
    if (changed) entry.updatedAt = now;
    return delivered
      ? {
          changed,
          status: "delivered_orphaned",
          reason: evidence.reason,
          persisted: true,
          terminal: true,
          eventId: evidence.eventId,
          deliveredAt: entry.deliveredAt || compactOwner?.deliveredAt || compactOwner?.ownerDeliveredAt,
        }
      : {
          changed,
          status: "superseded",
          reason: evidence.reason,
          persisted: true,
          terminal: true,
          eventId: evidence.eventId,
        };
  }, { writeIf: (result) => result.changed });
  const { changed: _changed, ...result } = mutation;
  return result;
}

async function claimAlertDestinations(config, eventId, force = false) {
  return mutateOutbox(config, (outbox) => {
    const entry = outbox.events[eventId];
    if (!entry) return { event: null, destinations: [], destinationRetries: {}, createdAt: null, claimedAt: null, renderBundle: null, tradingPriority: null };
    const now = alertPipelineNow(config);
    if (!["delivered", "suppressed"].includes(entry.status)) {
      disableExpiredTelegramDelivery(config, entry, now);
      entry.status = outboxEntryStatus(entry.destinations);
      if (entry.status === "suppressed") entry.suppressedAt ||= new Date(now).toISOString();
      if (entry.status === "delivered") entry.deliveredAt ||= new Date(now).toISOString();
    }
    if (["delivered", "suppressed"].includes(entry.status)) {
      entry.updatedAt = new Date(now).toISOString();
      return {
        event: entry.event,
        destinations: [],
        destinationRetries: {},
        createdAt: entry.createdAt,
        claimedAt: new Date(now).toISOString(),
        renderBundle: entry.renderBundle?.version === BILINGUAL_RENDER_VERSION ? entry.renderBundle : null,
        tradingPriority: entry.event?.tradingPriority || null,
      };
    }
    const immutableDuplicate = deliveredImmutableOpenFourDuplicate(outbox, eventId, entry.event);
    if (immutableDuplicate) {
      const updatedAt = new Date(now).toISOString();
      for (const [destination, state] of Object.entries(entry.destinations || {})) {
        if (state.status === "delivered") continue;
        entry.destinations[destination] = {
          ...state,
          status: "disabled",
          disabledReason: "semantic_duplicate",
          duplicateOf: immutableDuplicate.id,
          updatedAt,
          leaseUntil: null,
          nextAttemptAt: null,
        };
      }
      entry.status = outboxEntryStatus(entry.destinations);
      entry.semanticDuplicateOf = immutableDuplicate.id;
      entry.semanticDuplicateOwnerDelivered = true;
      if (entry.status === "suppressed") entry.suppressedAt ||= updatedAt;
      if (entry.status === "delivered") entry.deliveredAt ||= updatedAt;
      entry.updatedAt = updatedAt;
      rememberFourRegistryDeliveryOwner(outbox, entry);
      return {
        event: entry.event,
        destinations: [],
        destinationRetries: {},
        createdAt: entry.createdAt,
        claimedAt: updatedAt,
        renderBundle: entry.renderBundle?.version === BILINGUAL_RENDER_VERSION ? entry.renderBundle : null,
        tradingPriority: entry.event?.tradingPriority || null,
      };
    }
    // Serialize every immutable Core proof by its base identity. Whichever
    // strength already owns the in-flight HTTP attempt determines the visible
    // ordering; the waiter is rechecked against delivered ownership before it
    // can claim a destination.
    if (hasDeliveringOpenFourEntry(outbox, eventId, entry.event, now)) {
      entry.updatedAt = new Date(now).toISOString();
      return {
        event: entry.event,
        destinations: [],
        destinationRetries: {},
        createdAt: entry.createdAt,
        claimedAt: entry.updatedAt,
        renderBundle: entry.renderBundle?.version === BILINGUAL_RENDER_VERSION ? entry.renderBundle : null,
        tradingPriority: entry.event?.tradingPriority || null,
      };
    }
    const claimed = [];
    const destinationRetries = {};
    for (const [destination, state] of Object.entries(entry.destinations || {})) {
      const leaseExpired = state.status === "delivering" && new Date(state.leaseUntil || 0).getTime() <= now;
      const retryDue = !state.nextAttemptAt || new Date(state.nextAttemptAt).getTime() <= now;
      if (["pending", "failed"].includes(state.status) && (force || retryDue) || leaseExpired) {
        destinationRetries[destination] = state.status === "failed" || leaseExpired || Number(state.attempts || 0) > 0;
        entry.destinations[destination] = {
          ...state,
          status: "delivering",
          leaseUntil: new Date(now + OUTBOX_LEASE_MS).toISOString(),
          updatedAt: new Date(now).toISOString(),
        };
        claimed.push(destination);
      }
    }
    entry.updatedAt = new Date(now).toISOString();
    return {
      event: entry.event,
      destinations: claimed,
      destinationRetries,
      createdAt: entry.createdAt,
      claimedAt: new Date(now).toISOString(),
      renderBundle: entry.renderBundle?.version === BILINGUAL_RENDER_VERSION ? entry.renderBundle : null,
      tradingPriority: entry.event?.tradingPriority || null,
    };
  });
}

async function completeAlertDestinations(config, eventId, destinations, results) {
  return mutateOutbox(config, (outbox) => {
    const entry = outbox.events[eventId];
    if (!entry) return null;
    const now = alertPipelineNow(config);
    const secrets = [config.telegramToken, config.telegramChatId, config.webhookUrl].filter(Boolean);
    for (let index = 0; index < destinations.length; index += 1) {
      const destination = destinations[index];
      const previous = entry.destinations[destination] || { attempts: 0 };
      const result = results[index];
      if (result.status === "fulfilled") {
        entry.destinations[destination] = {
          ...previous,
          status: "delivered",
          deliveredAt: new Date(now).toISOString(),
          receipt: result.value || {},
          lastError: null,
          lastTiming: null,
          nextAttemptAt: null,
          leaseUntil: null,
        };
      } else {
        const attempts = Number(previous.attempts || 0) + 1;
        const backoffMs = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(attempts - 1, 6)));
        entry.destinations[destination] = {
          ...previous,
          status: "failed",
          attempts,
          lastError: safeFailureMessage(result.reason, secrets),
          lastTiming: result.reason?.alertDeliveryTiming || previous.lastTiming || null,
          lastAttemptAt: new Date(now).toISOString(),
          nextAttemptAt: new Date(now + backoffMs).toISOString(),
          leaseUntil: null,
        };
      }
    }
    const wasDelivered = entry.status === "delivered";
    entry.status = outboxEntryStatus(entry.destinations);
    if (entry.status === "delivered") {
      entry.deliveredAt ||= new Date(now).toISOString();
      rememberImmutableOpenFourSignalOwner(outbox, entry);
      rememberFourRegistryDeliveryOwner(outbox, entry);
    } else if (entry.status === "suppressed") {
      entry.suppressedAt ||= new Date(now).toISOString();
    }
    entry.updatedAt = new Date(now).toISOString();
    return { entry, transitioned: !wasDelivered && entry.status === "delivered" };
  });
}

async function commitDeliverySideEffects(config, eventId) {
  const snapshot = await inspectOutbox(config, (outbox) => {
    const entry = outbox.events[eventId];
    if (!entry || entry.status !== "delivered" || entry.sideEffectsCommitted) return null;
    return { event: entry.event };
  });
  if (!snapshot) return;
  await rememberOfficialToken(config, snapshot.event);
  await mutateOutbox(config, (outbox) => {
    const entry = outbox.events[eventId];
    if (entry?.status === "delivered") entry.sideEffectsCommitted = true;
  });
}

async function deliverOutboxEvent(config, eventId, { force = false, pipelineStartedAtMs: requestedPipelineStartedAtMs } = {}) {
  const pipelineStartedAtMs = Number.isFinite(Number(requestedPipelineStartedAtMs))
    ? Number(requestedPipelineStartedAtMs)
    : alertPipelineNow(config);
  const claim = await claimAlertDestinations(config, eventId, force);
  if (!claim.event) return null;
  let completedEntry = null;
  if (claim.destinations.length) {
    const criticalAlert = isCriticalAlertDelivery(claim.event);
    const claimedAtMs = Date.parse(claim.claimedAt || "");
    const renderStartedAtMs = alertPipelineNow(config);
    const bilingualDelivery = config.alertBilingualEnabled === true
      || claim.event.type === "gmgn_flow_surge"
      || claim.event.type === "genius_fun_update"
      || claim.event.type === "fomo_monitor_health_update"
      || isKolSelfLaunchEvent(claim.event)
      || claim.event.type === "narrative_trade_signal"
      || Boolean(deriveNewPoolContext(claim.event));
    const renderBundle = bilingualDelivery && claim.destinations.includes("telegram")
      ? await ensureTelegramRenderBundle(config, eventId, claim.event, claim.renderBundle)
      : null;
    const renderCompletedAtMs = alertPipelineNow(config);
    try {
      // A source proof can become orphaned while Telegram/webhook delivery is
      // queued. Revalidate at actual fan-out, including generic outbox retries.
      // Failure is recoverable work, never a delivered or terminally consumed
      // notification. Other official Genius sources perform no chain requests.
      await assertGeniusChainDeliveryCanonical(config, claim.event);
    } catch (error) {
      const failed = await completeAlertDestinations(config, eventId, claim.destinations,
        claim.destinations.map(() => ({ status: "rejected", reason: error })));
      return failed?.entry || null;
    }
    const commonDeliveryContext = {
      pipelineStartedAtMs,
      claimedAtMs,
      renderStartedAtMs,
      renderCompletedAtMs,
      criticalAlert,
    };
    const results = await Promise.allSettled(claim.destinations.map((destination) => {
      const retryAttempt = claim.destinationRetries?.[destination] === true;
      const deliveryWindow = criticalAlert
        ? criticalDeliveryWindow(claim.event, pipelineStartedAtMs, { enforceSourceDeadline: !retryAttempt })
        : null;
      return deliverDestination(
        config,
        claim.event,
        destination,
        destination === "telegram" ? renderBundle : null,
        {
          ...commonDeliveryContext,
          deadlineAtMs: deliveryWindow?.attemptDeadlineAtMs ?? null,
          sourceDeadlineAtMs: deliveryWindow?.sourceDeadlineAtMs ?? null,
          sourceStartedAtMs: deliveryWindow?.sourceStartedAtMs ?? pipelineStartedAtMs,
          endToEndBudgetMs: deliveryWindow?.budgetMs ?? null,
          pollAllowanceMs: deliveryWindow?.pollAllowanceMs ?? 0,
          deliverySlaBasis: deliveryWindow?.basis || "alert_pipeline",
          sourceSlaAccepted: deliveryWindow?.sourceSlaAccepted === true,
          deliveryAttempt: retryAttempt ? "retry" : "realtime",
        },
      );
    }));
    const completed = await completeAlertDestinations(config, eventId, claim.destinations, results);
    completedEntry = completed?.entry || null;
    for (let index = 0; index < claim.destinations.length; index += 1) {
      const timing = results[index]?.status === "fulfilled" ? results[index].value?.timing : null;
      if (timing?.slaBreached === true) {
        console.warn(`[alert-sla] late delivery event=${claim.event?.type || "unknown"} destination=${claim.destinations[index]} breachMs=${timing.breachMs} id=${eventId}`);
      }
    }
    if (completed?.transitioned) {
      const receipts = Object.entries(completed.entry.destinations)
        .filter(([, state]) => state.status === "delivered")
        .map(([destination, state]) => `${destination}${state.receipt?.messageId === undefined ? "" : `#${state.receipt.messageId}`}`)
        .join(",");
      console.info(`[alert] delivered event=${completed.entry.eventType} destinations=${receipts} id=${eventId}`);
    }
  }
  const finalEntry = completedEntry || await inspectOutbox(config, (outbox) => outbox.events[eventId] || null);
  if (finalEntry?.status === "delivered") await commitDeliverySideEffects(config, eventId);
  return finalEntry;
}

export async function drainAlertOutbox(config) {
  const snapshot = await mutateOutbox(config, async (outbox) => {
    const now = alertPipelineNow(config);
    let changed = false;
    for (const entry of Object.values(outbox.events || {})) {
      if (["delivered", "suppressed"].includes(entry.status)) continue;
      // A Portal activation can be invalidated by a later finalized disable
      // while Telegram is offline. Only the producer that just revalidated
      // the current chain state may call sendAlerts and claim this work; the
      // generic retry worker has no chain context and must leave it untouched.
      // The gate follows an exact canonical board/Portal takeover as well.
      if (isFlapQuoteProducerGatedEntry(entry)) continue;
      changed = true;
      const retryingDurableFlapTrackedToken = isDurablyAcceptedFlapTrackedTokenEntry(entry);
      const retryingDurableFourRegistry = isDurablyAcceptedFourRegistryEntry(entry);
      const durableNotificationRenderState = isDurableFlapQuoteNotificationEvent(entry.event)
        || retryingDurableFlapTrackedToken
        || retryingDurableFourRegistry
        ? JSON.stringify({
            observedAt: entry.event.observedAt,
            delayedRecovery: entry.event.delayedRecovery,
            freshness: entry.event.freshness,
            tier: entry.event.tradingPriority?.tier,
          })
        : null;
      // Re-evaluate only active work under the current priority contract.
      // Historical terminal archives keep their exact forensic payload, while
      // a pending campaign or incomplete T1 cannot bypass a newly tightened
      // hard gate merely because it entered the durable queue pre-rollout.
      // The watchdog health payload has a deliberately closed, aggregate-only
      // authentication schema. It is operational telemetry rather than a
      // news-trading event, so keep that event byte-safe and rank it through
      // the comparator's ordinary legacy fallback without adding metadata.
      if (!["fomo_monitor_health_update", "genius_fun_update", "gmgn_flow_surge"].includes(entry.event?.type)) {
        entry.event = withTradingPriority(entry.event || {}, { nowMs: now });
      }
      entry.event = withAlertFreshness(config, entry.event || {}, entry.createdAt || now);
      entry.event = refreshDeliveryFreshness(config, entry.event, now);
      if (retryingDurableFourRegistry) {
        // Registry delivery freshness is evaluated after the first priority
        // pass. Re-score once more so an expired T1 becomes the closed T2
        // no-chase retry lane before source-control revalidation.
        entry.event = withTradingPriority(entry.event, { nowMs: now });
      }
      if (durableNotificationRenderState !== null && durableNotificationRenderState !== JSON.stringify({
        observedAt: entry.event.observedAt,
        delayedRecovery: entry.event.delayedRecovery,
        freshness: entry.event.freshness,
        tier: entry.event.tradingPriority?.tier,
      })) entry.renderBundle = null;
      // Block rules are hot-reloaded. Re-evaluate undelivered durable entries
      // as well as newly observed events, otherwise a contract blocked during
      // Telegram downtime could still be delivered by the retry worker.
      if (!isStrictFourRegistryUpdate(entry.event) && await isEventBlocked(config, entry.event || {})) {
        for (const destination of Object.values(entry.destinations || {})) {
          if (destination.status === "delivered") continue;
          destination.status = "disabled";
          destination.disabledReason = "blocked_event";
          destination.updatedAt = new Date(now).toISOString();
          destination.leaseUntil = null;
          destination.nextAttemptAt = null;
        }
        entry.status = outboxEntryStatus(entry.destinations || {});
        if (entry.status === "suppressed") entry.suppressedAt ||= new Date(now).toISOString();
        if (entry.status === "delivered") entry.deliveredAt ||= new Date(now).toISOString();
        entry.updatedAt = new Date(now).toISOString();
        continue;
      }
      if (!isMonitoringSourceEnabled(config, entry.event || {})) {
        for (const destination of Object.values(entry.destinations || {})) {
          if (destination.status !== "delivered") destination.status = "disabled";
        }
        entry.status = "suppressed";
        entry.suppressedAt = new Date(now).toISOString();
        entry.updatedAt = entry.suppressedAt;
        continue;
      }
      if (!isRelevantAlert(entry.event || {})) {
        for (const destination of Object.values(entry.destinations || {})) {
          if (destination.status !== "delivered") destination.status = "disabled";
        }
        entry.status = "suppressed";
        entry.suppressedAt = new Date(now).toISOString();
        entry.updatedAt = entry.suppressedAt;
        continue;
      }
      const ordinaryDeliveryDisposition = alertDeliveryDisposition(entry.event || {});
      entry.deliveryDisposition = retryingDurableFlapTrackedToken
        ? flapTrackedTokenRetryDisposition(entry, entry.event, ordinaryDeliveryDisposition)
        : retryingDurableFourRegistry
          ? fourRegistryRetryDisposition(entry, entry.event, ordinaryDeliveryDisposition)
          : ordinaryDeliveryDisposition;
      disableFreshnessSuppressedTelegram(entry.destinations || {}, entry.event, new Date(now).toISOString(), {
        preserveFlapTrackedToken: retryingDurableFlapTrackedToken,
        preserveFourRegistry: retryingDurableFourRegistry,
      });
      disableExpiredTelegramDelivery(config, entry, now);
      disablePolicySuppressedDestinations(
        entry.destinations || {},
        entry.deliveryDisposition,
        new Date(now).toISOString(),
      );
      entry.status = outboxEntryStatus(entry.destinations);
      if (entry.status === "suppressed") {
        entry.suppressedAt ||= new Date(now).toISOString();
        entry.updatedAt = entry.suppressedAt;
        continue;
      }
      if (entry.status === "delivered") {
        entry.deliveredAt ||= new Date(now).toISOString();
        entry.updatedAt = entry.deliveredAt;
        continue;
      }
      if (entry.event?.type === "twitter_update") {
        const normalized = absoluteTweetUrl(entry.event.tweet);
        if (normalized !== entry.event.tweet?.url) {
          entry.event.tweet.url = normalized;
          for (const destination of Object.values(entry.destinations || {})) {
            if (destination.status === "failed") destination.nextAttemptAt = null;
          }
        }
      }
      entry.updatedAt = new Date(now).toISOString();
    }
    const pendingIds = Object.values(outbox.events || {})
      .filter((entry) => !["delivered", "suppressed"].includes(entry.status)
        && !isFlapQuoteProducerGatedEntry(entry))
      .sort(compareTradingPriority)
      .slice(0, 100)
      .map((entry) => entry.id);
    return { pendingIds, changed };
  }, { writeIf: ({ changed }) => changed });
  const { pendingIds } = snapshot;
  for (const eventId of pendingIds) {
    try { await deliverOutboxEvent(config, eventId); }
    catch (error) { console.error(`[alert-outbox] ${eventId}: ${safeFailureMessage(error, [config.telegramToken, config.webhookUrl].filter(Boolean))}`); }
  }
  return pendingIds.length;
}

export function startAlertOutboxWorker(config) {
  const key = path.join(config.dataDir, "alert-outbox.json");
  if (workers.has(key)) return workers.get(key);
  let runningPromise = null;
  let stopPromise = null;
  let stopped = false;
  let idleSignature = null;
  let idleUntil = 0;
  const run = ({ force = false } = {}) => {
    if (stopped) return runningPromise || Promise.resolve(0);
    if (runningPromise) return runningPromise;
    const execution = (async () => {
      const before = await outboxFileSignature(key);
      if (!force && before === idleSignature && Date.now() < idleUntil) return 0;
      const pending = await drainAlertOutbox(config);
      if (pending === 0) {
        idleSignature = await outboxFileSignature(key);
        idleUntil = Date.now() + OUTBOX_IDLE_RECHECK_MS;
      } else {
        idleSignature = null;
        idleUntil = 0;
      }
      return pending;
    })();
    runningPromise = execution.finally(() => { runningPromise = null; });
    return runningPromise;
  };
  void run({ force: true }).catch((error) => console.error(`[alert-outbox] startup: ${error.message}`));
  const timer = setInterval(() => void run().catch((error) => console.error(`[alert-outbox] retry: ${error.message}`)), config.alertRetryIntervalMs || 5_000);
  timer.unref();
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    clearInterval(timer);
    workers.delete(key);
    stopPromise = Promise.resolve(runningPromise).then(() => undefined);
    return stopPromise;
  };
  const worker = { run, stop };
  workers.set(key, worker);
  return worker;
}

function isRelevantFomoXCall(event) {
  const sourceId = String(event?.source?.id || "").toLowerCase();
  const sourceTrust = String(event?.source?.trust || "").toLowerCase();
  const handle = String(event?.caller?.handle || event?.handle || "").replace(/^@/, "").toLowerCase();
  const tweet = event?.tweet || {};
  const postId = String(tweet?.id || "");
  const postMatch = String(tweet?.url || "").match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?(?:[?#].*)?$/i);
  const callerTwitter = String(event?.caller?.twitter || "").match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i);
  const xProfileId = String(event?.caller?.xProfileId || event?.caller?.xUserId || "");
  const identitySource = String(event?.caller?.identitySource || "").toLowerCase();
  const wallet = String(event?.walletAddress || "").toLowerCase();
  const binding = event?.walletBinding;
  const eventObservedAt = Date.parse(event?.observedAt || "");
  const identityWallClock = Date.now();
  const identityReferenceAt = Number.isFinite(eventObservedAt)
    && identityWallClock - eventObservedAt > 86_400_000
    ? eventObservedAt
    : identityWallClock;
  const bindingCheckedAt = Date.parse(binding?.checkedAt || binding?.lastCheckedAt || "");
  const bindingFresh = Number.isFinite(bindingCheckedAt)
    && bindingCheckedAt <= identityReferenceAt + 60_000
    && identityReferenceAt - bindingCheckedAt <= 86_400_000;
  const callerProfileCheckedAt = Date.parse(event?.caller?.followersSyncedAt || "");
  const callerProfileFresh = Number.isFinite(callerProfileCheckedAt)
    && callerProfileCheckedAt <= identityReferenceAt + 60_000
    && identityReferenceAt - callerProfileCheckedAt <= 86_400_000;
  const bindingValid = binding?.status === "verified"
    && binding?.verified === true
    && String(binding?.proofSource || "").toLowerCase() === "fomoscan"
    && String(binding?.wallet || "").toLowerCase() === wallet
    && String(binding?.handle || "").replace(/^@/, "").toLowerCase() === handle
    && String(binding?.twitterHandle || "").replace(/^@/, "").toLowerCase() === handle
    && /^\d+$/.test(String(binding?.xProfileId || binding?.xUserId || ""))
    && String(binding?.xProfileId || binding?.xUserId) === xProfileId
    && identitySource === "fomoscan+fxtwitter"
    && event?.walletAttribution == null
    && bindingFresh
    && callerProfileFresh;
  const attribution = event?.walletAttribution;
  const tags = Array.isArray(attribution?.tags) ? attribution.tags.map((tag) => String(tag).toLowerCase()) : [];
  const attributionOrigin = String(attribution?.candidateSource || attribution?.originSource || "").toLowerCase();
  const attributionTimes = [attribution?.observedAt, attribution?.xFollowersCheckedAt, attribution?.bscActivityCheckedAt]
    .map((value) => Date.parse(value || ""));
  const attributionFresh = attributionTimes.every((value) => Number.isFinite(value)
    && value <= identityReferenceAt + 60_000
    && identityReferenceAt - value <= 86_400_000);
  const attributionValid = attribution?.scheme === "gmgn_x_maker_observation_v1"
    && attribution?.status === "observed"
    && attribution?.verified === false
    && attribution?.ambiguousIdentity === false
    && attribution?.ambiguousWallets === false
    && attribution?.ambiguousHandles === false
    && String(attribution?.source || "").toLowerCase() === "gmgn_bsc_kol_feed"
    && attributionOrigin === "gmgn_bsc_kol_feed"
    && attribution?.fomoTagged === true
    && tags.includes("kol")
    && tags.includes("fomo")
    && !tags.includes("wash_trader")
    && !tags.includes("arbitrager")
    && attributionFresh
    && String(attribution?.monitoringWallet || "").toLowerCase() === wallet
    && String(attribution?.xHandle || "").replace(/^@/, "").toLowerCase() === handle
    && String(attribution?.xProfileId || "") === xProfileId
    && Number(attribution?.bscTransactionCount) > 0
    && identitySource === "gmgn+fxtwitter"
    && binding == null;
  const callText = String(event?.thesis?.text || event?.body || tweet?.text || "").trim();
  const token = String(event?.token || event?.contractAddress || "").toLowerCase();
  const mentionedContracts = [...new Set((callText.match(/(?<![0-9A-Fa-f])0x[0-9A-Fa-f]{40}(?![0-9A-Fa-f])/g) || []).map((value) => value.toLowerCase()))];
  const publishedAt = Date.parse(event?.publishedAt || tweet?.createdAt || "");
  const observedAt = Date.parse(event?.observedAt || "");
  const fresh = Number.isFinite(publishedAt) && Number.isFinite(observedAt)
    && publishedAt <= observedAt + 60_000 && observedAt - publishedAt <= 300_000;
  return sourceId === "fomo_linked_x_post"
    && sourceTrust === "public_x_identity_linked"
    && (!event?.sourceTrust || String(event.sourceTrust).toLowerCase() === sourceTrust)
    && event?.qualified === true
    && event?.strong === true
    && Number(event?.chain?.id ?? event?.chain?.chainId) === 56
    && String(event?.chain?.slug || "").toLowerCase() === "bsc"
    && event?.security?.decision === "pass"
    && event?.security?.metrics?.liquidityConfirmed === true
    && event?.security?.metrics?.sellObserved === true
    && Number(event?.market?.liquidityUsd || 0) > 0
    && callText.length > 0
    && /^0x[0-9a-f]{40}$/.test(token)
    && String(event?.contractAddress || token).toLowerCase() === token
    && mentionedContracts.length === 1
    && mentionedContracts[0] === token
    && Number(event?.caller?.followers) >= 10_000
    && handle.length > 0
    && String(tweet?.handle || "").replace(/^@/, "").toLowerCase() === handle
    && /^\d+$/.test(postId)
    && postMatch?.[1]?.toLowerCase() === handle
    && postMatch?.[2] === postId
    && callerTwitter?.[1]?.toLowerCase() === handle
    && tweet?.sourceVerifiedBy === "official_x_oembed"
    && xProfileId.length > 0
    && String(tweet?.xUserId || tweet?.authorId || "") === xProfileId
    && /^0x[0-9a-f]{40}$/.test(wallet)
    && (bindingValid || attributionValid)
    && fresh;
}

function isRelevantSmartWalletBuy(event) {
  const lower = (value) => String(value || "").trim().toLowerCase();
  const finiteAtLeast = (value, minimum) => Number.isFinite(Number(value)) && Number(value) >= minimum;
  const positiveIntegerString = (value) => /^\d+$/.test(String(value ?? "")) && !/^0+$/.test(String(value));
  const freshIso = (value, maximumAgeMs) => {
    const timestamp = Date.parse(value || "");
    return Number.isFinite(timestamp) && timestamp <= Date.now() + 60_000 && Date.now() - timestamp <= maximumAgeMs;
  };
  const wallet = lower(event?.walletAddress);
  const token = lower(event?.token || event?.contractAddress);
  const transactionHash = lower(event?.transactionHash);
  const blockNumber = Number(event?.blockNumber);
  const logIndex = Number(event?.logIndex ?? event?.sourceTrade?.logIndex ?? 0);
  const executionPool = lower(event?.executionPool);
  const profile = event?.walletProfile || {};
  const trade = event?.sourceTrade || {};
  const transactionProof = event?.transactionProof || {};
  const sourceClassification = event?.sourceClassification || {};
  const positionSemantics = event?.positionSemantics || {};
  const market = event?.market || {};
  const stats7d = profile?.windows?.["7d"] || {};
  const stats30d = profile?.windows?.["30d"] || {};
  const tags = [...new Set([
    ...(Array.isArray(profile?.tags) ? profile.tags : []),
    ...(Array.isArray(trade?.tags) ? trade.tags : []),
  ].map(lower).filter(Boolean))];
  const classificationTags = [...new Set((Array.isArray(sourceClassification?.gmgnTags)
    ? sourceClassification.gmgnTags : []).map(lower).filter(Boolean))];
  const proof = event?.positionProof || {};
  const zeroPosition = lower(proof?.phase) === "previous_block" && String(proof?.previousBalanceRaw ?? "") === "0";
  const createdAt = Date.parse(profile?.createdAt || "");
  const buyDirection = [event?.activity, event?.action, event?.trade, event?.side, trade?.side]
    .every((value) => lower(value) === "buy")
    && [event?.tradeSide, event?.transactionType]
      .every((value) => !lower(value) || lower(value) === "buy");
  const sourceClassificationAligned = lower(sourceClassification?.id) === "gmgn_public_performance_wallet"
    && sourceClassification?.fomoOfficial === false
    && sourceClassification?.identityVerified === false
    && sourceClassification?.includesKolTag === tags.includes("kol")
    && classificationTags.length === tags.length
    && classificationTags.every((tag) => tags.includes(tag));
  const positionSemanticsAligned = lower(positionSemantics?.id) === "new_position_after_previous_block_zero"
    && lower(positionSemantics?.proofBoundary) === "previous_block"
    && positionSemantics?.lifetimeFirstBuyVerified === false
    && positionSemantics?.transactionImmediatePreBalanceVerified === false
    && event?.firstBuyVerified !== true;
  const profileAligned = profile?.scheme === "gmgn_wallet_stats_dual_window_v1"
    && profile?.qualified === true
    && lower(profile?.source) === "gmgn_portfolio_stats"
    && lower(profile?.wallet) === wallet
    && Number(profile?.chainId) === 56
    && freshIso(profile?.statsCheckedAt, 7_200_000)
    && freshIso(profile?.feedObservedAt, 86_400_000)
    && Number.isFinite(createdAt)
    && Date.now() - createdAt >= 30 * 24 * 60 * 60_000
    && Number.isSafeInteger(Number(profile?.createdTokenCount))
    && Number(profile.createdTokenCount) <= 10
    && !tags.some((tag) => ["wash_trader", "arbitrager"].includes(tag) || SMART_WALLET_BLOCKED_TAG.test(tag))
    && finiteAtLeast(stats7d?.realizedProfitUsd, 3_000)
    && finiteAtLeast(stats7d?.winRate, 0.60)
    && finiteAtLeast(stats7d?.realizedRoi, 0.015)
    && finiteAtLeast(stats7d?.tokenCount, 50)
    && finiteAtLeast(stats30d?.realizedProfitUsd, 10_000)
    && finiteAtLeast(stats30d?.winRate, 0.60)
    && finiteAtLeast(stats30d?.realizedRoi, 0.015)
    && finiteAtLeast(stats30d?.tokenCount, 100);
  const tradeAligned = trade?.scheme === "gmgn_smartmoney_trade_v1"
    && lower(trade?.wallet) === wallet
    && lower(trade?.token) === token
    && lower(trade?.transactionHash) === transactionHash
    && lower(trade?.transactionFrom) === wallet
    && Number(trade?.receiptStatus) === 1
    && Number(trade?.logIndex ?? 0) === logIndex
    && Number(trade?.blockNumber) === blockNumber
    && lower(trade?.side) === "buy"
    && (trade?.swapVerified === true || trade?.curveBuyVerified === true)
    && positiveIntegerString(trade?.paymentRaw)
    && positiveIntegerString(trade?.tokenDeltaRaw)
    && freshIso(trade?.occurredAt, FOMO_TELEGRAM_DELIVERY_MAX_AGE_MS)
    && freshIso(trade?.observedAt, FOMO_TELEGRAM_DELIVERY_MAX_AGE_MS);
  const tradeSwap = trade?.swapVerified === true;
  const tradeCurve = trade?.curveBuyVerified === true;
  const executionPoolAligned = /^0x[0-9a-f]{40}$/.test(executionPool)
    && tradeSwap !== tradeCurve
    && tradeSwap === (transactionProof?.swapVerified === true)
    && tradeCurve === (transactionProof?.curveBuyVerified === true)
    && lower(trade?.executionPool) === executionPool
    && lower(transactionProof?.executionPool) === executionPool
    && Number(trade?.executionPoolCount) === 1
    && Number(transactionProof?.executionPoolCount) === 1
    && trade?.executionPoolReceiptVerified === true
    && transactionProof?.executionPoolReceiptVerified === true
    && trade?.executionPairVerified === true
    && transactionProof?.executionPairVerified === true
    && trade?.exactExecutionPoolVerified === true
    && transactionProof?.exactExecutionPoolVerified === true
    && event?.executionPairVerified === true
    && market?.executionPairVerified === true
    && market?.exactExecutionPoolVerified === true
    && lower(market?.executionPool || market?.pairAddress) === executionPool
    && (tradeCurve
      ? market?.curveVerified === true && lower(event?.launchpad?.launcher) === executionPool
      : lower(market?.pairAddress) === executionPool);
  const proofAligned = proof?.status === "verified"
    && proof?.complete === true
    && zeroPosition
    && lower(proof?.wallet) === wallet
    && lower(proof?.token) === token
    && lower(proof?.transactionHash) === transactionHash
    && Number(proof?.blockNumber) === blockNumber;
  const transactionProofAligned = transactionProof?.scheme === "evm_wallet_buy_proof_v1"
    && Number(transactionProof?.chainId) === 56
    && lower(transactionProof?.wallet) === wallet
    && lower(transactionProof?.token) === token
    && lower(transactionProof?.transactionHash) === transactionHash
    && lower(transactionProof?.transactionFrom) === wallet
    && Number(transactionProof?.receiptStatus) === 1
    && Number(transactionProof?.blockNumber) === blockNumber
    && Number(transactionProof?.logIndex ?? 0) === logIndex
    && positiveIntegerString(transactionProof?.paymentRaw)
    && positiveIntegerString(transactionProof?.tokenDeltaRaw)
    && String(transactionProof?.paymentRaw) === String(trade?.paymentRaw)
    && String(transactionProof?.tokenDeltaRaw) === String(trade?.tokenDeltaRaw)
    && (transactionProof?.swapVerified === true || transactionProof?.curveBuyVerified === true)
    && transactionProof?.eoaVerified === true
    && lower(transactionProof?.walletCode) === "0x"
    && freshIso(transactionProof?.eoaCheckedAt, 7_200_000)
    && transactionProof?.positionProof?.status === proof?.status
    && transactionProof?.positionProof?.complete === proof?.complete
    && lower(transactionProof?.positionProof?.phase) === lower(proof?.phase)
    && lower(transactionProof?.positionProof?.wallet) === wallet
    && lower(transactionProof?.positionProof?.token) === token
    && lower(transactionProof?.positionProof?.transactionHash) === transactionHash
    && Number(transactionProof?.positionProof?.blockNumber) === blockNumber
    && String(transactionProof?.positionProof?.previousBalanceRaw ?? "") === "0"
    && String(transactionProof?.positionProof?.previousBalanceRaw) === String(proof?.previousBalanceRaw);
  return event?.signalKind === SMART_WALLET_SIGNAL_KIND
    && lower(event?.source?.id) === SMART_WALLET_SOURCE_ID
    && lower(event?.source?.trust) === SMART_WALLET_SOURCE_TRUST
    && (!event?.sourceTrust || lower(event.sourceTrust) === SMART_WALLET_SOURCE_TRUST)
    && lower(event?.platform?.id) === "smart-money"
    && event?.caller == null
    && event?.handle == null
    && (event?.callers == null || (Array.isArray(event.callers) && event.callers.length === 0))
    && event?.walletBinding == null
    && event?.walletAttribution == null
    && event?.fomoUrl == null
    && event?.profileUrl == null
    && event?.qualified === true
    && event?.strong === true
    && Number(event?.chain?.id ?? event?.chain?.chainId) === 56
    && lower(event?.chain?.slug) === "bsc"
    && /^0x[0-9a-f]{40}$/.test(wallet)
    && /^0x[0-9a-f]{40}$/.test(token)
    && (!event?.contractAddress || lower(event.contractAddress) === token)
    && /^0x[0-9a-f]{64}$/.test(transactionHash)
    && Number.isSafeInteger(blockNumber)
    && blockNumber > 0
    && Number.isSafeInteger(logIndex)
    && logIndex >= 0
    && buyDirection
    && sourceClassificationAligned
    && positionSemanticsAligned
    && profileAligned
    && tradeAligned
    && executionPoolAligned
    && proofAligned
    && transactionProofAligned
    && event?.security?.decision === "pass"
    && event?.security?.metrics?.liquidityConfirmed === true
    && event?.security?.metrics?.sellObserved === true
    && Number(event?.market?.liquidityUsd || 0) > 0;
}

// Relevance is a config-free shape check. Configurable thresholds and
// freshness belong to isMonitoringSourceEnabled(), which has the runtime
// policy and can therefore decide whether this event is still actionable.
function isStructurallyRelevantFomoConvergence(event) {
  const lower = (value) => String(value || "").trim().toLowerCase();
  if (event?.type !== "fomo_family_top_call"
    || event?.signalKind !== "top_blogger_convergence"
    || event?.qualified !== true
    || event?.strong !== true
    || Number(event?.chain?.id ?? event?.chain?.chainId) !== 56
    || lower(event?.chain?.slug) !== "bsc") return false;

  const source = event?.source || {};
  let sourceUrl;
  try {
    sourceUrl = new URL(String(source.url || ""));
  } catch {
    return false;
  }
  if (lower(source.id) !== "cope_capital"
    || lower(source.trust) !== "authorized_public_api"
    || (event?.sourceTrust && lower(event.sourceTrust) !== lower(source.trust))
    || sourceUrl.protocol !== "https:"
    || sourceUrl.username
    || sourceUrl.password
    || sourceUrl.hostname.toLowerCase().replace(/\.$/, "") !== "api.cope.capital") return false;

  const token = lower(event?.token || event?.contractAddress);
  const directions = [event?.activity, event?.action, event?.side, event?.trade, event?.tradeSide, event?.transactionType]
    .map(lower)
    .filter(Boolean);
  const callId = String(event?.callId || event?.stableId || "").trim();
  const callers = Array.isArray(event?.callers) ? event.callers : [];
  const handles = new Set();
  const wallets = new Set();
  const callersValid = callers.length >= 2 && callers.every((caller) => {
    const handle = lower(caller?.handle).replace(/^@/, "");
    const wallet = lower(caller?.walletAddress || caller?.wallet || caller?.baseAddress);
    const valid = /^[a-z0-9_]{1,15}$/.test(handle)
      && /^0x[0-9a-f]{40}$/.test(wallet)
      && Number.isFinite(Number(caller?.followers))
      && Number(caller.followers) >= 0
      && Number.isFinite(Number(caller?.amountUsd))
      && Number(caller.amountUsd) > 0;
    if (valid) {
      handles.add(handle);
      wallets.add(wallet);
    }
    return valid;
  });
  const timestampsPresent = Number.isFinite(Date.parse(event?.publishedAt || ""))
    && Number.isFinite(Date.parse(event?.observedAt || ""));
  return /^0x[0-9a-f]{40}$/.test(token)
    && (!event?.contractAddress || lower(event.contractAddress) === token)
    && callId.length > 0
    && directions.length > 0
    && directions.every((value) => value === "buy")
    && event?.ambiguousIdentity !== true
    && event?.ambiguousWallets !== true
    && event?.ambiguousHandles !== true
    && event?.security?.decision === "pass"
    && event?.security?.metrics?.liquidityConfirmed === true
    && event?.security?.metrics?.sellObserved === true
    && Number(event?.market?.liquidityUsd || 0) > 0
    && Number.isFinite(Number(event?.buyerCount))
    && Number(event.buyerCount) >= 2
    && Number.isFinite(Number(event?.totalUsd))
    && Number(event.totalUsd) > 0
    && callersValid
    && handles.size === callers.length
    && wallets.size === callers.length
    && timestampsPresent;
}

export function isRelevantAlert(event) {
  if (event?.type === "gmgn_flow_surge") return isGmgnFlowEvent(event);
  if (event?.type === "genius_fun_update") return isGeniusOfficialEvent(event);
  if (isKolSelfLaunchEvent(event)) return verifyKolTokenLaunchEvent(event).valid;
  if (event?.type === "narrative_trade_signal") {
    const integrity = verifyNarrativeTradeSignalIntegrity(event.signal);
    return integrity.valid && event.signal.decision === "do";
  }
  if (event?.type === "fomo_monitor_health_update") {
    return isFomoMonitorHealthUpdateAllowed({ fomoHealthMonitorEnabled: true }, event);
  }
  if (event?.type === "telegram_news_update") return isTelegramNewsUpdateAllowed(event);
  if (Object.prototype.hasOwnProperty.call(event || {}, "policyFixRecovery")) {
    return isFourMemePolicyFixRecoveryEvent(event);
  }
  if (isPonFunEvent(event)) return PON_FUN_ALLOWED_KINDS.has(event.kind);
  if (isMorphLaunchpadEvent(event)) {
    const platform = eventPlatform(event);
    return ["flap", "long"].includes(platform)
      && ["portal_upgrade", "new_mode", "official_deployment"].includes(event.kind)
      && event.strong === true
      && event.structural?.eligible === true;
  }
  if (event.type === "bsc_launchpad_update") {
    if (claimsFourRegistryUpdate(event)) return isStrictFourRegistryFirstTokenUpdate(event);
    if (event.kind === "flap_pool_token") return Boolean(flapTrackedTokenIdentity(event));
    if (claimsBscOpenFourFirstTokenUpdate(event)) return isStrictBscOpenFourFirstTokenUpdate(event);
    if (event.kind === "new_mode" && event.structural?.source === "official_api") {
      return isOfficialFourMemeCapabilityUpdate(event);
    }
    return ["new_launchpad", "new_mode", "new_factory"].includes(event.kind);
  }
  if (event.type === "fomo_family_top_call") {
    if (event.signalKind === SMART_WALLET_SIGNAL_KIND) return isRelevantSmartWalletBuy(event);
    if (event.signalKind === "top_blogger_convergence") {
      return isStructurallyRelevantFomoConvergence(event);
    }
    if (event.signalKind === "fomo_x_call") return isRelevantFomoXCall(event);
    if (event.signalKind === "fomo_published_call") {
      const sourceId = String(event.source?.id || "").toLowerCase();
      const sourceTrust = String(event.source?.trust || "").toLowerCase();
      const trustedSource = (sourceId === "fomo_family_official_thesis" && sourceTrust === "official_authenticated_api")
        || (sourceId === "fomoscan_thesis_relay" && sourceTrust === "verified_thesis_relay");
      return trustedSource
        && event.qualified === true
        && event.strong === true
        && Number(event.chain?.id ?? event.chain?.chainId) === 56
        && String(event.chain?.slug || "").toLowerCase() === "bsc"
        && Boolean(String(event.thesis?.text || "").trim())
        && Boolean(String(event.callId || event.stableId || "").trim())
        && Number(event.caller?.followers) >= 10_000
        && event.security?.decision === "pass"
        && event.security?.metrics?.liquidityConfirmed === true
        && event.security?.metrics?.sellObserved === true
        && Number(event.market?.liquidityUsd || 0) > 0;
    }
    const explicitDirections = [event?.activity, event?.action, event?.side, event?.tradeSide, event?.transactionType]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    const explicitBuy = event.signalKind === "top_blogger_first_buy"
      && explicitDirections.length > 0
      && explicitDirections.every((value) => ["buy", "first_buy", "swap_buy", "top_blogger_first_buy"].includes(value));
    const strictSolanaProof = event.source?.id !== "fomoscan_onchain" || event.chain?.slug !== "solana" || (
      event.positionProof?.status === "verified"
      && event.positionProof?.complete === true
      && event.positionProof?.walletSignerVerified === true
      && event.positionProof?.outputOwnerVerified === true
      && event.positionProof?.scope === "wallet_mint_all_token_accounts"
      && event.positionProof?.phase === "immediately_before_transaction"
      && event.positionProof?.source === "historical_owner_state"
      && event.positionProof?.totalWalletPreRaw === "0"
    );
    return explicitBuy && strictSolanaProof && event.qualified === true
      && ["authorized_public_api", "public_onchain_verified", "public_onchain_attributed"].includes(event.source?.trust)
      && event.security?.decision === "pass"
      && event.security?.metrics?.liquidityConfirmed === true
      && event.security?.metrics?.sellObserved === true
      && (event.market?.curveVerified === true || Number(event.market?.liquidityUsd || 0) > 0);
  }
  if (event.type === "binance_official_update") return isRelevantBinanceOfficialUpdate(event);
  if (event.type === "uniswap_official_update") return event.strong === true && Boolean(event.url && (event.labels?.length || event.title));
  if (event.type === "ai_official_update") return event.strong === true && Boolean(event.url && event.title && event.source?.id);
  if (["pons_v2_factory_discovered", "pons_v2_factory_status_update", "github_repository_verified"].includes(event.type)) return true;
  if (event.type === "platform_capability_update") {
    if (claimsFourRegistryUpdate(event)) return isStrictFourRegistryCapabilityUpdate(event);
    return isFocusPlatformEvent(event);
  }
  if (event.type === "github_module_update") {
    if (event.xaiOfficial === true) return event.sourceTrust === "official_verified" && event.strong === true;
    if (isUniswapPlatformEvent(event)) return event.sourceTrust === "official_verified" && event.strong === true;
    if (isBinancePlatformEvent(event)) return isRelevantBinanceGithubUpdate(event);
    return isFocusPlatformEvent(event) || (event.sourceTrust !== "unverified_candidate" && Boolean(event.modeChange?.candidate));
  }
  if (event.type === "github_monitor_gap") return isFocusPlatformEvent(event);
  if (event.type === "github_repository_discovered") return (isFocusPlatformEvent(event) || isUniswapPlatformEvent(event)) && event.sourceTrust !== "unverified_candidate";
  if (event.type === "launchpad_site_update") {
    return isFocusPlatformEvent(event) || isUniswapPlatformEvent(event) || Boolean(event.newContracts?.length || event.newKeywords?.length || event.newFeatures?.length || event.newPages?.length || event.newAssets?.length || event.newChains?.length);
  }
  if (event.type === "twitter_update") {
    if (isPonFunTwitterEvent(event)) return event.signal?.relevant === true
      && ["T1", "T2"].includes(event.signal?.ponPriority);
    if (event.project?.signalProfile === "ai") return event.signal?.relevant === true && event.signal?.strong === true;
    if (isBinancePlatformEvent(event)) {
      return event.signal?.relevant === true || binanceAgentNativeNovelty(event)?.stage === "launch";
    }
    if (isUniswapPlatformEvent(event)) return event.signal?.relevant === true && event.signal?.strong === true;
    if (event.signal?.marketCampaign != null) return isStrictFourMemeMarketCampaign(event);
    if (eventPlatform(event) === "long") {
      return event.signal?.relevant === true
        && event.signal?.strong === true
        && (event.signal?.chainSupport || []).some((chain) => Number(chain.chainId) === 2818
          || String(chain.id || "").toLowerCase() === "morph");
    }
    return event.signal?.labels?.some((label) => PLATFORM_TWITTER_SIGNALS.has(label)) &&
      (isFocusPlatformEvent(event) || event.signal.labels.some((label) => ["新发射/新模式", "合约/部署", "擂台/赛事新玩法"].includes(label)));
  }
  if (["official_activity", "early_activity_alert", "contract_deployed", "token_launch"].includes(event.type)) return isImportantRobinhoodEvent(event);
  return false;
}

const TERMINAL_ALERT_SUPPRESSION_REASONS = new Set([
  "monitoring_source_disabled",
  "blocked_event",
  "not_relevant",
  "repeated_official_token",
  "semantic_duplicate",
  "freshness_too_old",
  "delivery_ttl_expired",
  "policy_suppressed",
]);

export function isTerminalAlertSuppression(result) {
  if (String(result?.status || "").toLowerCase() !== "suppressed") return false;
  if (result?.terminal === false || result?.disposition === "retry") return false;
  if (result?.terminal === true || result?.disposition === "terminal") return true;
  return TERMINAL_ALERT_SUPPRESSION_REASONS.has(String(result?.reason || result?.disabledReason || "").toLowerCase());
}

function terminalAlertSuppression(eventType, reason, details = {}) {
  return {
    status: "suppressed",
    disposition: "terminal",
    terminal: true,
    eventType: eventType || null,
    reason,
    ...details,
  };
}

export async function sendAlerts(config, event) {
  if (!isMonitoringSourceEnabled(config, event)) return terminalAlertSuppression(event?.type, "monitoring_source_disabled");
  // A closed Four Registry event is already informational-only/no-auto and
  // its addresses are the subject of the governance update. A local address
  // block must not wedge the producer cursor and hide every later Registry
  // event; the dedicated card remains an explicit do-not-buy monitor.
  if (!isStrictFourRegistryUpdate(event) && await isEventBlocked(config, event)) {
    return terminalAlertSuppression(event?.type, "blocked_event");
  }
  if (!isRelevantAlert(event)) return terminalAlertSuppression(event?.type, "not_relevant");
  const pipelineStartedAtMs = alertPipelineNow(config);
  // Keep freshness, priority, enqueue, and delivery on the same injectable
  // clock. Production defaults to Date.now; deterministic producer tests can
  // explicitly share their monitor clock without trusting event.observedAt as
  // a way around the stale-news gate.
  const preparedEvent = withAlertFreshness(config, withFocusNovelty(config, event), pipelineStartedAtMs);
  const queuedEvent = ["fomo_monitor_health_update", "genius_fun_update", "gmgn_flow_surge"].includes(preparedEvent.type)
    ? preparedEvent
    : withTradingPriority(preparedEvent, { nowMs: pipelineStartedAtMs });
  if (effectiveFreshnessDecision(queuedEvent) !== "suppress" && await isRepeatedOfficialToken(config, queuedEvent)) {
    return terminalAlertSuppression(queuedEvent.type, "repeated_official_token");
  }
  const eventId = await enqueueAlert(config, queuedEvent);
  // A new pending destination is immediately due because nextAttemptAt is
  // null. Existing failed destinations must keep their persisted backoff;
  // repeated source observations are not permission to hammer Telegram or a
  // webhook before that deadline.
  const entry = await deliverOutboxEvent(config, eventId, { pipelineStartedAtMs });
  const receipts = Object.entries(entry?.destinations || {}).flatMap(([destination, state]) => state.status === "delivered"
    ? [{ destination, ...(state.receipt?.messageId === undefined ? {} : { messageId: state.receipt.messageId }) }]
    : []);
  if (entry?.status === "delivered") {
    return { status: "delivered", eventType: queuedEvent.type, eventId, persisted: true, deliveredAt: entry.deliveredAt, destinations: configuredDestinations(config), receipts };
  }
  if (entry?.status === "suppressed") {
    const disabledReasons = Object.values(entry?.destinations || {})
      .map((state) => state?.disabledReason)
      .filter(Boolean);
    const semanticDuplicate = disabledReasons.includes("semantic_duplicate");
    const reason = semanticDuplicate
      ? "semantic_duplicate"
      : disabledReasons.find((candidate) => TERMINAL_ALERT_SUPPRESSION_REASONS.has(candidate)) || "policy_suppressed";
    return terminalAlertSuppression(queuedEvent.type, reason, {
      eventId,
      persisted: true,
      ...(semanticDuplicate ? {
        duplicateOf: entry?.semanticDuplicateOf || null,
        canonicalOwnerDelivered: entry?.semanticDuplicateOwnerDelivered === true,
      } : {}),
      suppressedAt: entry.suppressedAt,
      freshness: entry.event?.freshness || queuedEvent.freshness || null,
      destinations: configuredDestinations(config),
      receipts,
    });
  }
  const failures = Object.entries(entry?.destinations || {}).flatMap(([destination, state]) => state.status === "failed"
    ? [{ destination, message: state.lastError }]
    : []);
  console.error(`[alert] queued event=${queuedEvent.type} id=${eventId} pending=${failures.map(({ destination }) => destination).join(",") || "delivery"}`);
  return { status: "queued", eventType: queuedEvent.type, eventId, persisted: true, destinations: configuredDestinations(config), receipts, failures };
}
