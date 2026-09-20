import { createHash } from "node:crypto";
import { claimsGeniusSource, isGeniusOfficialEvent } from "./genius-source-policy.js";
import { isGmgnFlowEvent } from "./gmgn-flow-signal.js";
import {
  FOUR_REGISTRY_CAPABILITY_KINDS,
  FOUR_REGISTRY_FIRST_TOKEN_KIND,
  isFourRegistryCapabilityEvent as isRawFourRegistryCapabilityEvent,
  isFourRegistryFirstTokenEvent as isRawFourRegistryFirstTokenEvent,
} from "./four-registry-monitor.js";
import {
  isKolSelfLaunchEvent,
  verifyKolTokenLaunchEvent,
} from "./kol-token-launch-alert.js";

const PONS_REPOSITORIES = new Set([
  "ponsdotdev/ponsfamily",
  "ponsdotfamily/ponsdotfamily",
]);

const PONS_ADDRESSES = new Set([
  "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb",
  "0x0c37a24f5d23a486fa692d1500881d698b1f77a4",
  "0x7e1eabd52ae29598e6483f72dcf1a70b14284db8",
  "0x050e5c224466e2d377a7e555e139d51268239b39",
  "0x8e99d2009d60a917e9b1c00c04c077b8c0c3a044",
  "0x107251ffcc1fc808643dc8da345e901f59ec2044",
  "0xda4bcee76b29efec9697fcf663601c2042043968",
]);

const normalized = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";
const compact = (value) => normalized(value).replace(/[^a-z0-9]/g, "");

// Binance is an explicit opt-in lane inside focus3.  Keep the trust decision
// tied to machine-readable provenance; a display name such as "Binance" must
// never be enough to make an otherwise out-of-scope source eligible.
const BINANCE_OFFICIAL_EVENT_SOURCE_IDS = new Set([
  "binance_exchange_cms",
  "binance_announcement_websocket",
  "binance_wallet_cms",
  "binance_square_cms",
  "binance_developer_docs",
  "binance_agent_os_page",
  "meme_rush_api",
  "launchpool_api",
]);
const BINANCE_OFFICIAL_HOSTS = new Set(["binance.com", "binance.info"]);
const BINANCE_OFFICIAL_X_TARGETS = new Map([
  ["binance", { id: "binance", xUserId: "877807935493033984" }],
  ["binancewallet", { id: "binance-wallet", xUserId: "1400391752368992260" }],
  ["binancefutures", { id: "binance-futures", xUserId: "1426142483822518274" }],
]);

// X/xAI/Grok sources form a separate, fail-closed lane. They deliberately do
// not participate in the ordinary focus3 identity or repository matching.
const AI_OFFICIAL_EVENT_SOURCE_IDS = new Set([
  "x_api_changelog",
  "xai_release_notes",
  "xai_news",
]);
const AI_OFFICIAL_X_TARGETS = new Map([
  ["x", { id: "x", xUserId: "783214", website: "https://x.com", docs: "https://help.x.com/en/using-x" }],
  ["spacexai", { id: "xai", xUserId: "1661523610111193088", website: "https://x.ai", docs: "https://docs.x.ai" }],
  ["grok", { id: "grok", xUserId: "1720665183188922368", website: "https://grok.com", docs: "https://docs.x.ai" }],
  ["api", { id: "x-api", xUserId: "6253282", website: "https://docs.x.com", docs: "https://docs.x.com/changelog" }],
]);

// pon.fun is deliberately isolated from both the legacy Pons monitor and the
// broad focus3 identity matcher.  Its stock/RWA catalogue is an explicit,
// project-scoped exception, so no ticker, headline or generic RWA wording can
// authenticate an event.
const PON_FUN_EVENT_TYPE = "pon_fun_update";
const PON_FUN_SOURCE_ID = "pon_fun_official_api_onchain";
const PON_FUN_SOURCE_TRUST = "official_site_bound_onchain_fingerprinted";
const PON_FUN_CHAIN_ID = 4663;
const PON_FUN_FACTORY = "0xf698d13348686c1529c2dc54847c123424d9dae0";
const PON_FUN_FACTORY_RUNTIME_HASH = "0x4cb9795396b800a4b1e46f2e91a690ecf004ac0d52b059a7ef0e6b190af17384";
const PON_FUN_PLATFORM_TOKEN = "0x7673dc6d2357bdc2e04fd80c169f2bef56622d9a";
const PON_FUN_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PON_FUN_PLATFORM_MODEL = "stock-backed penny meme launchpad; the coin is not the stock";
const PON_FUN_RISK = "PON coins are not the referenced stocks; backing, oracle, liquidity, sellability and admin controls remain risks.";
const PON_FUN_X_HANDLE = "pondotfun";
const PON_FUN_X_USER_ID = "2094048312772993024";
const PON_FUN_X_DELAYED_RECOVERY_VERSION = 1;
const PON_FUN_X_DELAYED_RECOVERY_REASON = "monitoring_gap_recovery";
const PON_FUN_X_REALTIME_MAX_AGE_MS = 10 * 60 * 1_000;
const PON_FUN_DELAYED_RECOVERY_MAX_LAG_MS = 7 * 24 * 60 * 60 * 1_000;
const PON_FUN_ADDRESS = /(?<![a-fA-F0-9])0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g;
const PON_FUN_TRANSACTION = /(?<![a-fA-F0-9])0x[a-fA-F0-9]{64}(?![a-fA-F0-9])/g;
const PON_FUN_MARKET_ACTION = /(?:\b(?:new\s+)?(?:stock|equity|ticker|market)\b[^.!?\n]{0,90}\b(?:list(?:s|ed|ing)?|launch(?:es|ed|ing)?|add(?:s|ed|ing)?|is\s+(?:now\s+)?live)\b|\b(?:list(?:s|ed|ing)?|launch(?:es|ed|ing)?|add(?:s|ed|ing)?)\b[^.!?\n]{0,90}\b(?:stock|equity|ticker|market)\b)/i;
const PON_FUN_STRUCTURAL_OBJECT = /\b(?:factory|config(?:uration)?|curve\s+params?|oracle|swap\s+router|position\s+manager|treasury|owner(?:ship)?|admin|pause|emergency\s+stop|upgrade|implementation|escrow|vault|redemption|backing|fee\s+model|protocol)\b/i;
const PON_FUN_STRUCTURAL_ACTION = /\b(?:set|sets|updated?|changed?|migrat(?:e|es|ed|ing)|transfer(?:s|red|ring)?|paus(?:e|es|ed|ing)|halt(?:s|ed|ing)?|upgrad(?:e|es|ed|ing)|deploy(?:s|ed|ing)?|launch(?:es|ed|ing)?|introduc(?:e|es|ed|ing)|enabl(?:e|es|ed|ing)|replac(?:e|es|ed|ing))\b/i;
const PON_FUN_RECOVERY = /\b(?:unpaus(?:e|es|ed|ing)|resum(?:e|es|ed|ing)|recover(?:s|ed|ing|y)|restor(?:e|es|ed|ing)|back\s+online)\b/i;
const PON_FUN_LP_DEPLOYED = /\b(?:lp|liquidity\s+pool)\b[^.!?\n]{0,80}\bdeploy(?:s|ed|ing)?\b|\bdeploy(?:s|ed|ing)?\b[^.!?\n]{0,80}\b(?:lp|liquidity\s+pool)\b/i;
const PON_FUN_GRADUATED = /\b(?:market|coin|token)\b[^.!?\n]{0,80}\bgraduat(?:e|es|ed|ing)\b|\bgraduat(?:e|es|ed|ing)\b[^.!?\n]{0,80}\b(?:market|coin|token)\b/i;
const PON_FUN_MARKETING_NOISE = /\b(?:giveaway|airdrop|contest|competition|join\s+us|follow\s+us|community|gm|good\s+morning|learn\s+more|how\s+(?:it|pon)\s+works|built\s+for\s+the\s+people)\b/i;
const PON_FUN_X_SIGNAL_RULES = new Map([
  ["platform_token_live", { kind: "platform_token_update", priority: "T1", major: true, address: true }],
  ["supply_burned", { kind: "platform_token_update", priority: "T1", major: true, transaction: true }],
  ["factory_config", { kind: "factory_config", priority: "T1", major: true }],
  ["paused", { kind: "factory_paused", priority: "T1", major: true }],
  ["ownership_transfer_started", { kind: "ownership_transfer_started", priority: "T1", major: true }],
  ["ownership_transferred", { kind: "ownership_transferred", priority: "T1", major: true }],
  ["recovered", { kind: "factory_unpaused", priority: "T2", major: false }],
  ["created", { kind: "market_created", priority: "T2", major: false }],
  ["stock_listed", { kind: "stock_listing", priority: "T2", major: false }],
  ["graduated", { kind: "market_lifecycle", priority: "T2", major: false }],
  ["lp_deployed", { kind: "market_lifecycle", priority: "T2", major: false }],
]);

const FLAP_X_HANDLE = "flapdotsh";
const FLAP_X_USER_ID = "1749114887807320064";
const FOUR_MEME_X_HANDLE = "fourdotmemezh";
const FOUR_MEME_X_USER_ID = "1816036559864619011";
const FOUR_MEME_TEMPLATE_SOURCE_ID = "fourmeme_public_template_api";
const FOUR_MEME_TEMPLATE_URL = "https://four.meme/meme-api/v1/public/token_template/search";
const FOUR_MEME_TEMPLATE_CHANGE_TYPES = new Set([
  "new_published_template",
  "template_published",
  "published_template_changed",
  "template_unpublished",
]);
const FOUR_MEME_POLICY_RECOVERY_SPECS = new Map([
  ["2095361508700258731", {
    kind: "named_mode",
    allowlistId: "four-twitter-policy-fix-2026-09-v1:listayield",
    originalEventKey: "twitter:fourdotmemezh:2095361508700258731",
    derivedEventKey: "twitter:fourdotmemezh:2095361508700258731:policy-fix-recovery:v1",
    createdAt: "2026-09-03T04:01:28.000Z",
    textSha256: "d9997debab05aa886ffa9b95cc0de3fda27bf6a59e23a04328868f99338edd29",
    evidenceSource: "durable_suppressed_outbox+verified_exact_status",
  }],
  ["2095713912188739967", {
    kind: "market_campaign",
    allowlistId: "four-twitter-policy-fix-2026-09-v1:bstock-campaign",
    originalEventKey: "twitter:fourdotmemezh:2095713912188739967",
    derivedEventKey: "twitter:fourdotmemezh:2095713912188739967:policy-fix-recovery:v1",
    createdAt: "2026-09-04T03:21:47.000Z",
    textSha256: "548a09c8436c71905c131c732c258125ba1a66c7baea83a0ecbe65539a606b5c",
    evidenceSource: "verified_recent_timeline+verified_exact_status",
  }],
]);
const FLAP_BOARD_URL = "https://flap.sh/board";
const FLAP_BSC_CHAIN_ID = 56;
const FLAP_BSC_QUOTE_PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
const FLAP_QUOTE_SOURCE_ID = "flap_portal_quote_configuration";
const FLAP_QUOTE_SOURCE_TRUST = "official_docs_bound_fingerprinted_portal_receipt";
const FLAP_QUOTE_DOCS_URL = "https://docs.flap.sh/flap/developers/deployed-contract-addresses";
const FLAP_QUOTE_PORTAL_RUNTIME_HASH = "0x0a3fe6f701ee3cb432f45912e054896327ce5902337eae4d62d01406005a91c3";
const FLAP_QUOTE_PORTAL_VERSION = "v5.23.1";
const FLAP_QUOTE_PORTAL_IMPLEMENTATION = "0xAb8Ec926b6e113c2212aF152b086eA62d1FDced9";
const FLAP_QUOTE_PORTAL_IMPLEMENTATION_HASH = "0x78653cdd7296d940ae531c86bc6700ae163f1f9dec002c2af3143c9ae6696a15";
const FLAP_QUOTE_CONFIGURATION_SIGNATURE = "QuoteTokenConfigurationSet(address,(uint8,uint8,uint8,uint8,uint8))";
const FLAP_QUOTE_CONFIGURATION_TOPIC = "0x9a1f38e55c729ebf0c45d240a00b09f0a79a715df7cfd6e8942bd3f8da839199";
const FLAP_QUOTE_RISK = "A Portal quote configuration is platform capability evidence, not proof of token safety, liquidity depth, backing, or favorable execution.";
const FLAP_FIRST_OBSERVED_RISK = "Historical archive state was unavailable from the required independent readers. This confirms only that the quote asset is enabled now; it does not prove a new 0-to-1 activation, token safety, liquidity, backing, or favorable execution.";
const FLAP_DELAYED_RECOVERY_VERSION = 1;
const FLAP_DELAYED_RECOVERY_REASON = "monitoring_gap_recovery";
const FLAP_FIRST_OBSERVED_KIND = "flap_quote_asset_first_observed_after_gap";
const FLAP_FIRST_OBSERVED_REASON = "first_observed_after_gap";
const FLAP_DELAYED_RECOVERY_MIN_LAG_MS = 15 * 60 * 1_000;
const FLAP_TRACKED_TOKEN_KIND = "flap_pool_token";
const FLAP_TRACKED_TOKEN_PORTAL = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
const FLAP_TRACKED_TOKEN_CREATED_TOPIC = "0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603";
const FLAP_TRACKED_TOKEN_TARGET = 3;
const FLAP_TRACKED_TOKEN_RECOVERY_REASON = "verified_generation_archive_catch_up";
const FOUR_MEME_OPENFOUR_CORE = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
const FOUR_MEME_OPENFOUR_TOKEN_CREATED_TOPIC = "0x7dae4dcd1b20eb0445e7cc1d02b3e2e7f32fa63081a0e764732c269f2b8f228f";
const FOUR_MEME_OPENFOUR_TEMPLATE_SOURCE_URL = "https://four.meme/meme-api/v1/public/token_template/search";
const FOUR_MEME_OPENFOUR_CONFIG_SOURCE_URL = "https://four.meme/meme-api/v1/public/config";
const FOUR_REGISTRY_FIRST_TOKEN_SOURCE_ID = "fourmeme_openfour_core";
const FOUR_REGISTRY_CAPABILITY_SOURCE_ID = "fourmeme_openfour_registry";
const FOUR_REGISTRY_DERIVED_EVENT_KEYS = new Set([
  "canonicalSignalId", "canonicalSignalIds", "freshness", "tradingPriority", "alertQueuedAt",
]);
const FOUR_MEME_OPENFOUR_EVENT_KEYS = new Set([
  "type", "kind", "eventKey", "officialFirstToken", "featureFirstToken", "featurePlatform",
  "featureActivationKey", "chainId", "launcher", "platform", "launchCount", "uniqueTokens",
  "transactionHash", "blockNumber", "blockHash", "transactionIndex", "logIndex", "canonical",
  "confirmations", "requiredConfirmations", "tokens", "pools", "mode", "structural", "security",
  "attribution", "deployer", "controllerKind", "launchEvidence", "explorerEvidence", "marketContext",
  "explorerUrl", "launcherUrl", "sourceUrl", "blockTimestamp", "observedAt", "strong",
  "informationalOnly", "autoTradeEligible", "automaticExecution", "deliverySla",
  "canonicalSignalId", "canonicalSignalIds", "freshness", "tradingPriority", "alertQueuedAt",
]);
const FLAP_TRACKED_TOKEN_DEX_FACTORIES = new Map([
  ["0xca143ce32fe78f1f7019d7d551a6402fc5350c73", "v2"],
  ["0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865", "v3"],
  ["0x8909dc15e40173ff4699343b6eb8132c65e18ec6", "v2"],
  ["0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7", "v3"],
]);
const FLAP_TRACKED_TOKEN_EVENT_KEYS = new Set([
  "type", "kind", "eventKey", "chainId", "launcher", "platform", "featurePlatform",
  "featureActivationKey", "featureGenerationKey", "featureTrackedToken", "featureTokenOrdinal",
  "featureTokenTarget", "featureFirstToken", "informationalOnly", "autoTradeEligible",
  "automaticExecution", "strong", "launchCount", "uniqueTokens", "transactionHash",
  "blockNumber", "blockHash", "blockTimestamp", "transactionIndex", "logIndex", "tokens",
  "pools", "mode", "structural", "security", "featureTokenProof", "delayedRecovery",
  "canonicalRevision", "launchEvidence", "sourceUrl", "activationSourceUrl", "explorerUrl", "launcherUrl",
  "observedAt", "canonicalSignalId", "canonicalSignalIds", "freshness", "tradingPriority",
  "alertQueuedAt",
]);
const FLAP_DIRECT_EVENT_KEYS = new Set([
  "type", "kind", "changeType", "eventKey", "platform", "chain", "chainId", "portal",
  "source", "sourceUrl", "url", "explorerUrl", "observedAt", "occurredAt", "blockTimestamp",
  "transactionHash", "blockNumber", "blockHash", "logIndex", "receiptProof", "transactionProof",
  "blockProof", "onchainProof", "evidence", "changes", "signal", "strong",
  "reorgOrphanedEventKeys", "risk",
]);
const FLAP_DIRECT_RECOVERY_EVENT_KEYS = new Set(["originalEventKey", "delayedRecovery"]);
const FLAP_DIRECT_FIRST_OBSERVED_EVENT_KEYS = new Set(["priorTransitionProof", "priorStateRead"]);
const FLAP_DIRECT_DERIVED_EVENT_KEYS = new Set([
  "canonicalSignalId", "canonicalSignalIds", "freshness", "tradingPriority", "alertQueuedAt",
]);
const FLAP_DIRECT_PLATFORM_KEYS = new Set(["id", "name", "website", "board"]);
const FLAP_DIRECT_CHAIN_KEYS = new Set(["id", "chainId", "name", "environment"]);
const FLAP_BSC_PORTALS = new Set([
  "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0",
  "0x90497450f2a706f1951b5bdda52b4e5d16f34c06",
]);
const FLAP_QUOTE_PAIR_LABEL = "税收/募资/报价代币";
const FLAP_QUOTE_PAIR_PROMOTION = /(?:\b(?:trade\s*(?:&|and)\s*win|trading\s+competition|bonus\s+pool|prize\s+pool|reward\s+pool|giveaway|airdrop|contest|compete\s+for|trading\s+volume|leaderboard)\b|交易(?:大赛|竞赛|赢奖)|奖金池|奖池|交易量)/i;
const FLAP_QUOTE_PAIR_OBJECT = /(?:\bbstocks?\b[^.!?\n]{0,100}\b(?:trading|quote)\s+pairs?\b|\b(?:trading|quote)\s+pairs?\b[^.!?\n]{0,100}\bbstocks?\b|\bbstocks?\b[^.!?\n]{0,100}\bpaired\s+(?:directly\s+)?(?:against|with)\b)/i;
const FLAP_QUOTE_PAIR_LIVE = /(?:\bbstocks?\b[^.!?\n]{0,120}\b(?:trading|quote)\s+pairs?\b[^.!?\n]{0,80}\b(?:now\s+)?(?:live|available|enabled|listed|supported)\b|\b(?:live|available|enabled|listed|supported)\b[^.!?\n]{0,80}\bbstocks?\b[^.!?\n]{0,100}\b(?:trading|quote)\s+pairs?\b|\bflap(?:\.sh)?\b[^.!?\n]{0,100}\b(?:added|adds|enabled|enables|listed|lists|launched|launches|supports)\b[^.!?\n]{0,120}\bbstocks?\b)/i;
const FLAP_QUOTE_PAIR_ANNOUNCED = /(?:\bbstocks?\b[^.!?\n]{0,80}\bcoming\s+to\s+flap(?:\.sh)?\b|\bflap(?:\.sh)?\b[^.!?\n]{0,140}\bexpand(?:s|ed|ing)?\b[^.!?\n]{0,100}\b(?:new\s+)?bstock\b|\b(?:announc(?:e|es|ed|ing)|introduc(?:e|es|ed|ing)|will\s+(?:add|enable|list|launch|support)|coming\s+soon)\b[^.!?\n]{0,140}\bbstocks?\b[^.!?\n]{0,100}\b(?:trading|quote)\s+pairs?\b|\bbstocks?\b[^.!?\n]{0,100}\b(?:trading|quote)\s+pairs?\b[^.!?\n]{0,100}\b(?:coming\s+soon|announced?)\b)/i;
// X list parsing intentionally requires display-style uppercase tickers. The
// direct Portal contract accepts mixed case, but allowing prose-like mixed
// case here would misread numbered product bullets such as `3.Burn — ...` as
// quote assets. Dots/dashes remain valid for real tickers such as BRK.B.
const FLAP_QUOTE_PAIR_ASSET_LINE = /^\*{0,2}\$?([A-Z0-9][A-Z0-9_$.-]{0,23})\*{0,2}\s*(?:—|–|-|:|\|)\s*(.+)$/u;
const FLAP_QUOTE_PAIR_BARE_ASSET = /^\*{0,2}\$?([A-Z0-9][A-Z0-9_$.-]{0,23})\*{0,2}$/u;
const FLAP_QUOTE_PAIR_LIST_PREFIX = /^(?:[-*•▪◦‣●○◆◇]|✅|☑️?|✔️?|🔹|🔸|➤|➡️?)\s*/u;
const FLAP_QUOTE_PAIR_RESERVED_SYMBOLS = new Set([
  "BSTOCK", "BSTOCKS", "BUILD", "BURN", "CREATOR", "CREATORS", "CUSTOM", "DIFFERENT",
  "DIVIDENDS", "ETF", "FLAP", "HOLDER", "HOLDERS", "LIQUIDITY", "PAIR", "PAIRS", "TOKEN", "TOKENS",
]);
const FLAP_QUOTE_PAIR_COUNT = /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:new\s+|additional\s+)?(?:leveraged\s+)?bstock\s+(?:trading|quote)\s+pairs?\b/gi;
const FLAP_QUOTE_PAIR_COUNT_WORDS = new Map([
  ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5],
  ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10],
]);
const FLAP_QUOTE_PAIR_INVALID_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function validFlapQuotePairName(value) {
  return typeof value === "string"
    && value.length >= 2
    && value.length <= 120
    && value === value.replace(/\s+/g, " ").trim()
    && !FLAP_QUOTE_PAIR_INVALID_TEXT.test(value)
    && !/https?:\/\/|(?:^|\s)[@#][A-Za-z0-9_]/i.test(value)
    && /^[A-Za-z0-9][A-Za-z0-9 .,&()/'’+%\-]{1,119}$/u.test(value)
    && /[A-Za-z]/.test(value);
}

function validFlapMetadataText(value, maximum, minimum = 1) {
  return typeof value === "string"
    && value.length >= minimum
    && value.length <= maximum
    && value === value.replace(/\s+/g, " ").trim()
    && !FLAP_QUOTE_PAIR_INVALID_TEXT.test(value)
    && !/https?:\/\//i.test(value)
    && /[\p{L}\p{N}]/u.test(value);
}

function validFlapQuotePairSymbol(value) {
  return typeof value === "string"
    && /^[A-Z0-9][A-Z0-9_$.-]{0,23}$/.test(value)
    && !FLAP_QUOTE_PAIR_RESERVED_SYMBOLS.has(value.toUpperCase());
}

function validFlapDirectQuoteSymbol(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_$.-]{0,23}$/.test(value);
}

function flapDirectQuoteSymbolSlug(value) {
  const slug = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\b(?:feat|new|add|adds|added|adding|introduce|introduces|introduced|launch|launches|launched|deploy|deploys|deployed|release|releases|released|enable|enables|enabled|support|supports|supported|the|a|an|our|official|is|now|live)\b/g, " ")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug
    || String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Keep the semantic parser independent from the X transport.  The producer
// and the final trust gate both call this function, so an injected or stale
// `quotePairChange` cannot disagree with the authenticated tweet body.
export function classifyFlapQuotePairSignalCore(text = "") {
  const source = String(text || "").replace(/&amp;/gi, "&").replace(/\r\n?/g, "\n");
  if (!source || source.length > 20_000 || FLAP_QUOTE_PAIR_INVALID_TEXT.test(source)) return null;
  if (!/\bflap(?:\.sh)?\b/i.test(source)
    || !/\bbstocks?\b/i.test(source)
    || !FLAP_QUOTE_PAIR_OBJECT.test(source)
    || FLAP_QUOTE_PAIR_PROMOTION.test(source)) return null;

  const stage = FLAP_QUOTE_PAIR_LIVE.test(source)
    ? "live"
    : FLAP_QUOTE_PAIR_ANNOUNCED.test(source) ? "announced" : null;
  if (!stage) return null;

  const assets = [];
  let malformedAssetLine = false;
  for (const rawLine of source.split("\n")) {
    const trimmed = rawLine.trim();
    const listed = FLAP_QUOTE_PAIR_LIST_PREFIX.test(trimmed);
    const line = trimmed.replace(FLAP_QUOTE_PAIR_LIST_PREFIX, "").trim();
    const named = line.match(FLAP_QUOTE_PAIR_ASSET_LINE);
    if (named) {
      const symbol = named[1];
      const name = named[2].replace(/^\*+|\*+$/g, "").replace(/\s+/g, " ").trim();
      if (!validFlapQuotePairSymbol(symbol) || !validFlapQuotePairName(name)) {
        malformedAssetLine = true;
        continue;
      }
      assets.push({ symbol, name });
      continue;
    }
    const bare = listed ? line.match(FLAP_QUOTE_PAIR_BARE_ASSET) : null;
    if (bare) {
      if (!validFlapQuotePairSymbol(bare[1])) malformedAssetLine = true;
      else assets.push({ symbol: bare[1] });
    }
  }
  if (malformedAssetLine || assets.length < 1 || assets.length > 8) return null;
  if (new Set(assets.map(({ symbol }) => symbol.toLowerCase())).size !== assets.length) return null;

  const declaredCounts = [...source.matchAll(FLAP_QUOTE_PAIR_COUNT)].map((match) => (
    FLAP_QUOTE_PAIR_COUNT_WORDS.get(match[1].toLowerCase()) ?? Number(match[1])
  ));
  if (declaredCounts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 8 || count !== assets.length)) return null;
  return { assetClass: "bstock_quote", stage, assets };
}

// One canonical classifier core is shared by the X producer and the final
// source gate. Presentation-only claims are added by twitter-monitor after
// this decision; security-sensitive kind/stage/evidence can never drift.
export function classifyPonFunSignalCore(text = "") {
  const source = String(text || "").replace(/&amp;/gi, "&");
  const addresses = [...new Set(source.match(PON_FUN_ADDRESS) || [])];
  const transactions = [...new Set(source.match(PON_FUN_TRANSACTION) || [])];
  const platformTokenLive = /(?=.*\$?PONFUN\b)(?=.*\b(?:is\s+(?:now\s+)?live|launch(?:es|ed)?|trading\s+(?:is\s+)?live)\b)/is.test(source)
    && addresses.length === 1;
  if (platformTokenLive) return {
    relevant: true,
    strong: true,
    labels: ["pon.fun 平台币重大事件"],
    ponFunOfficial: true,
    ponKind: "platform_token_update",
    ponStage: "platform_token_live",
    ponAsset: "PONFUN",
    tokenAddress: addresses[0],
    ponPriority: "T1",
    platformStructural: true,
    majorProductUpdate: true,
    reason: "official_platform_token_launch_with_exact_ca",
  };

  const supplyBurn = /\b(?:dev(?:eloper)?|team|platform)\s+(?:token\s+)?supply\b[^.!?\n]{0,80}\bburn(?:s|ed|t|ing)?\b|\bburn(?:s|ed|t|ing)?\b[^.!?\n]{0,80}\b(?:dev(?:eloper)?|team|platform)\s+(?:token\s+)?supply\b/i.test(source);
  if (supplyBurn && transactions.length === 1) return {
    relevant: true,
    strong: true,
    labels: ["pon.fun 平台币供应结构"],
    ponFunOfficial: true,
    ponKind: "platform_token_update",
    ponStage: "supply_burned",
    ponAsset: "PONFUN",
    transactionHash: transactions[0],
    ponPriority: "T1",
    platformStructural: true,
    majorProductUpdate: true,
    reason: "official_platform_supply_burn_with_transaction",
  };

  const lifecycleStage = PON_FUN_LP_DEPLOYED.test(source)
    ? "lp_deployed"
    : PON_FUN_GRADUATED.test(source) ? "graduated" : null;
  if (lifecycleStage) return {
    relevant: true,
    strong: false,
    labels: ["pon.fun 市场生命周期"],
    ponFunOfficial: true,
    ponKind: "market_lifecycle",
    ponStage: lifecycleStage,
    ...(addresses.length === 1 ? { ponAsset: addresses[0], tokenAddress: addresses[0] } : {}),
    ponPriority: "T2",
    platformStructural: false,
    majorProductUpdate: false,
    reason: lifecycleStage === "lp_deployed"
      ? "official_market_lp_deployed"
      : "official_market_graduated",
  };

  if (PON_FUN_RECOVERY.test(source) && /\b(?:pon\.fun|factory|platform|protocol|operations?)\b/i.test(source)) {
    return {
      relevant: true,
      strong: false,
      labels: ["pon.fun 运行恢复"],
      ponFunOfficial: true,
      ponKind: "factory_unpaused",
      ponStage: "recovered",
      ponAsset: "PONFUN",
      ponPriority: "T2",
      platformStructural: false,
      majorProductUpdate: false,
      reason: "official_factory_or_platform_recovery",
    };
  }

  const structural = PON_FUN_STRUCTURAL_OBJECT.test(source) && PON_FUN_STRUCTURAL_ACTION.test(source);
  if (structural) {
    const paused = /\b(?:paus(?:e|es|ed|ing)|halt(?:s|ed|ing)?|emergency\s+stop)\b/i.test(source);
    const ownership = /\b(?:owner(?:ship)?|admin)\b/i.test(source) && /\btransfer(?:s|red|ring)?\b/i.test(source);
    const ownershipStarted = ownership
      && /\b(?:start(?:s|ed|ing)?|initiat(?:e|es|ed|ing)|pending|propos(?:e|es|ed|ing))\b/i.test(source);
    const ownershipCompleted = ownership
      && /\b(?:accept(?:s|ed|ing)?|complet(?:e|es|ed|ing)|finaliz(?:e|es|ed|ing)|transferred)\b/i.test(source);
    if (ownership && !ownershipStarted && !ownershipCompleted) {
      return {
        relevant: false,
        strong: false,
        labels: [],
        ponFunOfficial: true,
        reason: "ambiguous_ownership_transfer_stage",
      };
    }
    const kind = paused
      ? "factory_paused"
      : ownershipStarted ? "ownership_transfer_started" : ownershipCompleted ? "ownership_transferred" : "factory_config";
    const stage = paused
      ? "paused"
      : ownershipStarted ? "ownership_transfer_started" : ownershipCompleted ? "ownership_transferred" : "factory_config";
    return {
      relevant: true,
      strong: true,
      labels: ["pon.fun 重大结构更新"],
      ponFunOfficial: true,
      ponKind: kind,
      ponStage: stage,
      ponAsset: "PONFUN",
      ...(kind === "factory_config" && addresses.length === 1 ? { tokenAddress: addresses[0] } : {}),
      ...(kind === "factory_config" && transactions.length === 1 ? { transactionHash: transactions[0] } : {}),
      ponPriority: "T1",
      platformStructural: true,
      majorProductUpdate: true,
      reason: "official_factory_config_or_major_product_change",
    };
  }

  if (PON_FUN_MARKET_ACTION.test(source)) return {
    relevant: true,
    strong: false,
    labels: ["pon.fun 市场/RWA 更新"],
    ponFunOfficial: true,
    ponKind: /\bstock|equity|ticker\b/i.test(source) ? "stock_listing" : "market_created",
    ponStage: /\bstock|equity|ticker\b/i.test(source) ? "stock_listed" : "created",
    ...(addresses.length === 1 ? { ponAsset: addresses[0], tokenAddress: addresses[0] } : {}),
    ponPriority: "T2",
    platformStructural: false,
    majorProductUpdate: false,
    reason: "official_market_or_stock_information",
  };

  return {
    relevant: false,
    strong: false,
    labels: [],
    ponFunOfficial: true,
    ponPriority: "T2",
    reason: PON_FUN_MARKETING_NOISE.test(source) ? "mechanism_explainer_or_marketing" : "no_explicit_pon_fun_change",
  };
}
const PON_FUN_KINDS = new Set([
  "market_created",
  "market_lifecycle",
  "factory_config",
  "curve_params",
  "stock_listing",
  "factory_paused",
  "factory_unpaused",
  "ownership_transfer_started",
  "ownership_transferred",
  "platform_token_update",
]);
const PON_FUN_CHAIN_EVENT_KINDS = new Set([
  "market_created",
  "factory_config",
  "curve_params",
  "stock_listing",
  "factory_paused",
  "factory_unpaused",
  "ownership_transfer_started",
  "ownership_transferred",
]);
const PON_FUN_DELAYED_CHAIN_KINDS = new Set([
  "factory_config",
  "curve_params",
  "stock_listing",
  "factory_paused",
  "factory_unpaused",
  "ownership_transfer_started",
  "ownership_transferred",
]);
const PON_FUN_API_PATHS = new Set(["", "/", "/api/health", "/api/markets", "/api/ponfun", "/tokenlist.json"]);
const PON_FUN_KIND_TOPICS = new Map([
  ["factory_config", "0x8d4f9022ab10978259dead0fa01463e75fda43dfe57f0445e69b010074c016fd"],
  ["curve_params", "0x25482d70bd81eb7de3dfac5c42283fda45887a7d1fb434a68c2a13e45baf29f3"],
  ["market_created", "0x8ada27e0afa58f4d4be8c4edbf4bfd49d9d586ce8a714938b12f51b7855893bb"],
  ["stock_listing", "0x7740fd3f56c396ca150bbd7ec72ee92798920ea8eb3f25f9a03582dc9bb564b1"],
  ["ownership_transfer_started", "0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700"],
  ["ownership_transferred", "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0"],
  ["factory_paused", "0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258"],
  ["factory_unpaused", "0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa"],
]);
const AI_GROK_PRODUCT = Object.freeze({ id: "grok", name: "xai / grok", launchpad: "xai / grok" });
const AI_X_PRODUCT = Object.freeze({ id: "x", name: "x", launchpad: "x" });
const AI_X_API_PRODUCT = Object.freeze({ id: "x-api", name: "x api / developer platform", launchpad: "x" });
const AI_OFFICIAL_REPOSITORIES = new Map([
  ["xai-org/grok-build", AI_GROK_PRODUCT],
  ["xai-org/grok-build-plugin-cc", AI_GROK_PRODUCT],
  ["xai-org/plugin-marketplace", AI_GROK_PRODUCT],
  ["xai-org/xai-sdk-python", AI_GROK_PRODUCT],
  ["xai-org/xai-proto", AI_GROK_PRODUCT],
  ["xai-org/x-algorithm", AI_X_PRODUCT],
  ["xai-org/grok-prompts", AI_GROK_PRODUCT],
  ["xdevplatform/chat-xdk", AI_X_API_PRODUCT],
  ["xdevplatform/xurl", AI_X_API_PRODUCT],
  ["xdevplatform/xmcp", AI_X_API_PRODUCT],
  ["xdevplatform/xdk", AI_X_API_PRODUCT],
  ["xdevplatform/xdk-python", AI_X_API_PRODUCT],
  ["xdevplatform/xdk-typescript", AI_X_API_PRODUCT],
]);
const AI_OFFICIAL_GITHUB_ORGANIZATIONS = new Set(["xai-org", "xdevplatform"]);
const AI_REPOSITORY_DISCOVERY_SIGNAL = /(?:^|[^a-z0-9])(?:products?|models?|apis?|sdks?|plugins?|algorithms?|grok|xdk)(?:$|[^a-z0-9])/i;

const FOCUS3_SCOPE = "focus3";
const FOCUS3_IDENTITIES = new Set([
  "flap",
  "flapsh",
  "flapdotsh",
  "fourmeme",
  "fourdotmemezh",
  "openfour",
  "uniswap",
  "uniswappools",
  "poolstrade",
  "tradepools",
  "long",
  "longdotxyz",
]);
const FOCUS3_UNISWAP_REPOSITORIES = new Set([
  "uniswap/liquidity-launcher",
  "uniswap/v4-hooks-public",
  "uniswap/hooklist",
  "uniswap/contracts",
  "uniswap/uniswapx",
  "uniswap/protocol-fees",
  "uniswap/v4-periphery",
  "uniswap/universal-router",
]);
const FOCUS3_UNISWAP_NEW_REPOSITORY = /^uniswap\/(?:(?:deploy|chain|network)[a-z0-9_.-]*|[a-z0-9_.-]*(?:launch|hook|pool|auction|bonding|factory|robinhood)[a-z0-9_.-]*|(?:uniswap[-_.]?)?ai)$/i;
const FOCUS3_DOMAINS = new Set([
  "flap.sh",
  "docs.flap.sh",
  "four.meme",
  "four-meme.gitbook.io",
  "pools.trade",
  "uniswap.org",
  "app.uniswap.org",
  "blog.uniswap.org",
  "developers.uniswap.org",
  "gov.uniswap.org",
  "long.xyz",
  "app.long.xyz",
]);
const FOCUS3_BLOCKED_EVENT_TYPES = new Set([
  "binance_official_update",
  "fomo_family_top_call",
  "official_activity",
  "early_activity_alert",
  "contract_deployed",
  "pons_v2_factory_discovered",
  "pons_v2_factory_status_update",
]);
const FOCUS3_CAPABILITY_KEYS = [
  "newFlapPools",
  "updatedFlapPools",
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
  "newChains",
  "chainStageChanges",
];
const FOCUS3_TWITTER_SIGNALS = new Set([
  "新发射/新模式",
  "合约/部署",
  "订阅功能",
  "OpenFour",
  "税收/募资/报价代币",
  "擂台/赛事新玩法",
  "新增链支持",
  "Agent/Skill 集成",
]);
const FOCUS3_UNISWAP_SIGNAL = /(?:pools?\.trade|liquidity[ -]?launcher|crowd\s+launch|instant\s+launch|launch\s+aggregator|launchpad|token\s+(?:launch|auction)|bonding\s+curve|dualpool|new\s+launch\s+(?:mode|strategy|mechanism)|(?:new\s+)?(?:pool|hook)\s+(?:mode|design|type|mechanism|strategy|template|module)|robinhood[^\n]{0,80}(?:pool|hook|launch|deploy)|(?:pool|hook|launch|deploy)[^\n]{0,80}robinhood|新发射|新底池(?:模式|机制|类型|策略)|新\s*hook(?:模式|机制|模板|模块))/i;
const FOCUS3_UNISWAP_GITHUB_CORE_SIGNAL = /(?:protocol\s+fees?|fee\s+(?:switch|adapter|policy|splitter)|uniswapx\s+(?:reactor|order|deployment|version))/i;
const FOCUS3_UNISWAP_EXCLUDED = /(?:permissioned\s+pools?|tokenized\s+(?:stocks?|equities|securities)|security[- ]+tokens?|equity|stocks?\s+(?:issuance|offering|tokenization|tokens?))/i;
const FOCUS3_STOCK_RWA_EXCLUDED = /(?:\b(?:rwa|stocks?|stock[- ]meme|tokeni[sz]ed\s+(?:assets?|stocks?|equities|securities)|real[- ]world\s+assets?|equity\s+(?:issuance|offering|launch|tokens?|tokenization)|securit(?:y|ies)\s+(?:issuance|offering|tokens?|tokenization))\b|\bbstocks?\b[^.!?\n]{0,100}\b(?:trading|quote)\s+pairs?\b|\b(?:trading|quote)\s+pairs?\b[^.!?\n]{0,100}\bbstocks?\b|股票|证券|股权|现实世界资产|实物资产|配股)/i;
const FOCUS3_FOMO_SOURCE_TRUST = new Set(["public_onchain_verified", "public_onchain_attributed", "authorized_public_api"]);
const FOCUS3_FOMO_DIRTY_GMGN_TAGS = new Set(["wash_trader", "arbitrager"]);
const SMART_WALLET_SIGNAL_KIND = "high_profit_high_winrate_wallet_buy";
const SMART_WALLET_SOURCE_ID = "gmgn_profitable_wallet_onchain";
const SMART_WALLET_SOURCE_TRUST = "public_onchain_profiled";
const SMART_WALLET_BLOCKED_TAG = /(?:^|[_-])(?:wash(?:[_-]?trader)?|arbitrager|arbitrage|mev(?:[_-]?bot)?|sandwich|router|cex|exchange|contract)(?:$|[_-])/i;
const FOMO_HEALTH_SOURCE_ID = "local_fomo_health_watchdog";
const FOMO_HEALTH_SOURCE_TRUST = "local_persisted_health";
const FOMO_HEALTH_MAX_OPERATIONAL_AGE_MS = 10 * 366 * 24 * 60 * 60_000;
const FOMO_HEALTH_LEVELS = new Set(["healthy", "degraded", "critical", "disabled", "unknown"]);
const FOMO_HEALTH_REASON_CODES = new Set([
  "call_state_missing",
  "call_state_unreadable",
  "call_state_stale",
  "smart_telemetry_missing",
  "smart_feed_unhealthy",
  "smart_stats_unhealthy",
  "smart_zero_targets",
  "smart_no_fresh_profiles",
  "smart_exact_trade_unhealthy",
  "bsc_unhealthy",
  "x_state_missing",
  "x_state_unreadable",
  "x_state_stale",
  "x_no_eligible_targets",
  "x_no_live_targets",
  "x_low_live_coverage",
  "thesis_state_missing",
  "thesis_state_unreadable",
  "thesis_state_stale",
  "thesis_blocked",
  "thesis_unhealthy",
  "fomo_outbox_unreadable",
  "fomo_outbox_failed",
  "fomo_outbox_backlog",
]);
const FOCUS3_FOMO_PUBLISHED_SOURCES = new Map([
  ["fomo_family_official_thesis", "official_authenticated_api"],
  ["fomoscan_thesis_relay", "verified_thesis_relay"],
]);

const TELEGRAM_NEWS_SOURCE_ID = "telegram_public_channel";
const TELEGRAM_NEWS_SOURCE_TRUST = "public_telegram_observed";
const TELEGRAM_NEWS_CHAT_ID = "-1002540748528";
const TELEGRAM_NEWS_USERNAME = "maxguruai";
const TELEGRAM_NEWS_SOURCE_URL = "https://t.me/s/maxguruai";
const TELEGRAM_NEWS_MAX_SOURCE_AGE_MS = 2 * 60 * 60 * 1_000;
const TELEGRAM_NEWS_FUTURE_TOLERANCE_MS = 60_000;
const TELEGRAM_NEWS_DISALLOWED_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const TELEGRAM_NEWS_CATEGORIES = new Set([
  "security", "listing", "market", "macro", "governance", "funding", "on_chain", "ai", "product", "crypto",
]);
const TELEGRAM_NEWS_STAGES = new Set([
  "observed", "proposed", "approved", "rejected", "scheduled", "live", "incident", "paused", "patched", "resumed",
]);

function focus3Repository(value) {
  const repository = normalized(value);
  if (/^(?:flap-sh|four-meme|four-meme-community)\/[a-z0-9_.-]+$/i.test(repository)) return true;
  return FOCUS3_UNISWAP_REPOSITORIES.has(repository) || FOCUS3_UNISWAP_NEW_REPOSITORY.test(repository);
}

function focus3Url(value) {
  if (typeof value !== "string") return false;
  try {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const host = new URL(candidate).hostname.toLowerCase().replace(/^www\./, "");
    if (FOCUS3_DOMAINS.has(host)) return true;
    if (host === "github.com") return focus3Repository(new URL(candidate).pathname.split("/").filter(Boolean).slice(0, 2).join("/"));
    if (["x.com", "twitter.com"].includes(host)) return FOCUS3_IDENTITIES.has(compact(new URL(candidate).pathname.split("/").filter(Boolean)[0]));
  } catch { /* Not a URL identity. */ }
  return false;
}

function focus3Identity(value) {
  if (typeof value !== "string") return false;
  const text = normalized(value);
  if (focus3Repository(text) || focus3Url(text)) return true;
  const identity = compact(text.replace(/^@/, ""));
  return FOCUS3_IDENTITIES.has(identity);
}

function parsedHttpsUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function flapRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactFlapKeys(value, allowed, required = []) {
  if (!flapRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key));
}

function sameFlapValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameFlapValue(value, right[index]));
  }
  if (!flapRecord(left) || !flapRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && sameFlapValue(left[key], right[key]));
}

function normalizedFourMemeText(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function boundedFourMemeInteger(value, maximum = 10_000_000) {
  const normalizedValue = String(value || "").replace(/,/g, "");
  if (!/^[1-9]\d*$/.test(normalizedValue)) return null;
  const parsed = Number(normalizedValue);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

export function classifyFourMemeNamedModeCore(text = "") {
  const source = normalizedFourMemeText(text);
  const namedIntroduction = /\bintroduc(?:e|es|ed|ing)\s+ListaYield\s+on\s+(?:https?:\/\/)?(?:www\.)?Four\.Meme\b/i.test(source);
  const parentMode = /\b(?:new\s+)?Open\s*Four\s+mode\b/i.test(source);
  const partner = /\bpowered\s+by\s+@lista_dao\b/i.test(source);
  const taxRoute = /\bevery\s+trade\b[\s\S]{0,180}\btrading\s+tax\b[\s\S]{0,180}\byield[- ]bearing\s+products?\b/i.test(source);
  const holderYield = /(?:\bholders?\s+earn\b|\bcreating\s+ongoing\s+yield\s+for\s+eligible\s+holders\b)/i.test(source);
  const graduationRoute = /\b(?:when|once)\s+(?:the\s+)?token\s+graduates?\b[\s\S]{0,180}\bliquidity\s+moves?\s+to\s+Lista\s+DEX\b[\s\S]{0,80}\bby\s+default\b/i.test(source);
  if (!namedIntroduction || !parentMode || !partner || !taxRoute || !holderYield || !graduationRoute) return null;
  return {
    relevant: true,
    strong: true,
    platformStructural: true,
    labels: ["新发射/新模式", "OpenFour", "税收/募资/报价代币"],
    reason: "fourmeme_named_mode_listayield",
    namedMode: {
      version: 1,
      id: "listayield",
      name: "ListaYield",
      parent: "OpenFour",
      stage: "announced",
      partnerHandle: "lista_dao",
      tradingTaxRoute: "yield_bearing_products",
      holderYield: true,
      graduationLiquidityDestination: "Lista DEX",
    },
  };
}

export function classifyFourMemeMarketCampaignCore(text = "") {
  const source = normalizedFourMemeText(text);
  if (!/\bbStocks?\b/i.test(source) || !/\bStock\s+Memes?\b/i.test(source)) return null;
  const partnership = source.match(/\bwith\s+@([A-Za-z0-9_]{1,15})\s*(?:×|x|&|and)\s*@([A-Za-z0-9_]{1,15})\b/i);
  if (!partnership || normalized(partnership[2]) !== "bnbchain") return null;
  const partnerHandle = partnership[1];
  if (["fourdotmemezh", "bnbchain"].includes(normalized(partnerHandle))) return null;

  const totalMatch = source.match(/\b([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)\s*USDT\s+(?:is\s+)?now\s+live\b/i);
  const exclusiveMatch = source.match(/\b(?:including\s+(?:a\s+)?)?([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)\s*USDT\s+leaderboard\s+exclusively\s+for\s+(?:https?:\/\/)?(?:www\.)?Four\.Meme\/?\s+traders?\b/i);
  const topMatch = source.match(/\b(?:climb\s+the\s+)?Top\s*([1-9]\d{0,4})\b/i);
  const venueMatch = source.match(/\bTrade\s+(?:https?:\/\/)?(?:www\.)?Four\.Meme\/?\s+Stock\s+Memes?\s+on\s+(?:https?:\/\/)?(?:www\.)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\/?/i);
  const totalPrizeUsdt = boundedFourMemeInteger(totalMatch?.[1]);
  const fourMemePrizeUsdt = boundedFourMemeInteger(exclusiveMatch?.[1]);
  const topRanks = boundedFourMemeInteger(topMatch?.[1], 10_000);
  const venue = venueMatch?.[1] || null;
  if (!totalPrizeUsdt || !fourMemePrizeUsdt || fourMemePrizeUsdt > totalPrizeUsdt || !topRanks || !venue) return null;
  const venueName = venue.toLowerCase() === "ave.ai" ? "Ave.ai" : venue;
  return {
    relevant: true,
    strong: true,
    platformStructural: false,
    labels: ["Four.Meme bStock 合作榜单"],
    reason: "fourmeme_bstock_partner_leaderboard_live",
    marketCampaign: {
      version: 1,
      kind: "bstock_partner_leaderboard",
      assetClass: "bstock",
      stage: "live",
      partnerHandle,
      chainHandle: partnership[2],
      venue: venueName,
      totalPrizeUsdt,
      fourMemePrizeUsdt,
      topRanks,
      exclusiveToFourMemeTraders: true,
      campaignKey: `fourmeme:market-campaign:bstock:${normalized(partnerHandle)}:${fourMemePrizeUsdt}-usdt:top-${topRanks}`,
    },
  };
}

export function classifyFourMemeOfficialSignalCore(text = "") {
  return classifyFourMemeNamedModeCore(text) || classifyFourMemeMarketCampaignCore(text);
}

function isOfficialFourMemeXSource(source) {
  const project = source?.project;
  const tweet = source?.tweet;
  const tweetId = typeof tweet?.id === "string" ? tweet.id : "";
  const projectKeys = new Set([
    "id", "name", "website", "twitter", "handle", "xUserId", "match", "priority",
    "backfillOnFirstSeen", "baselineOnFirstSeen", "criticalFastLane", "criticalProfile",
    "fallbackOfficialSources",
  ]);
  const projectRequired = ["id", "name", "website", "twitter", "handle", "xUserId", "match"];
  const tweetKeys = new Set([
    "id", "text", "createdAt", "authorName", "handle", "xUserId", "authorId", "userId",
    "replies", "reposts", "likes", "url", "isReply", "expandedUrls", "sourceVerifiedBy",
    "identityVerifiedBy", "discoveredBy",
  ]);
  const tweetRequired = ["id", "text", "createdAt", "handle", "xUserId", "authorId", "url", "isReply", "sourceVerifiedBy"];
  const fallbackSources = project?.fallbackOfficialSources;
  const fallbackSourcesValid = fallbackSources === undefined || sameFlapValue(fallbackSources, [
    { name: "Four.Meme 公告", url: "https://four.meme/en/announcement", coveredBy: "platform-capability-monitor" },
    { name: "Four.Meme 产品配置", url: "https://four.meme/meme-api/v1/public/config", coveredBy: "platform-capability-monitor" },
  ]);
  const expandedUrls = tweet?.expandedUrls;
  const expandedUrlsValid = expandedUrls === undefined || (Array.isArray(expandedUrls)
    && expandedUrls.length <= 8
    && expandedUrls.every((value) => {
      try {
        const url = new URL(String(value));
        const host = url.hostname.toLowerCase().replace(/^www\./, "");
        return ["http:", "https:"].includes(url.protocol)
          && !url.username && !url.password
          && ["four.meme", "ave.ai"].includes(host);
      } catch {
        return false;
      }
    }));
  const forbiddenRootLink = ["url", "sourceUrl", "explorerUrl", "launcherUrl", "transactionUrl", "marketUrl", "docs"]
    .some((key) => Object.prototype.hasOwnProperty.call(source || {}, key));
  return source?.type === "twitter_update"
    && !forbiddenRootLink
    && exactFlapKeys(project, projectKeys, projectRequired)
    && normalized(project?.id) === "fourmeme"
    && normalized(project?.name) === "four.meme"
    && project?.website === "https://four.meme"
    && project?.twitter === `https://x.com/${FOUR_MEME_X_HANDLE}`
    && normalized(project?.handle).replace(/^@/, "") === FOUR_MEME_X_HANDLE
    && project?.xUserId === FOUR_MEME_X_USER_ID
    && normalized(project?.match) === "official_x"
    && (project?.priority === undefined || project.priority === true)
    && (project?.backfillOnFirstSeen === undefined || typeof project.backfillOnFirstSeen === "boolean")
    && (project?.baselineOnFirstSeen === undefined || project.baselineOnFirstSeen === true)
    && (project?.criticalFastLane === undefined || project.criticalFastLane === true)
    && (project?.criticalProfile === undefined || project.criticalProfile === "focus_launchpad")
    && fallbackSourcesValid
    && exactFlapKeys(tweet, tweetKeys, tweetRequired)
    && /^\d{10,25}$/.test(tweetId)
    && normalized(tweet?.handle).replace(/^@/, "") === FOUR_MEME_X_HANDLE
    && tweet?.xUserId === FOUR_MEME_X_USER_ID
    && tweet?.authorId === FOUR_MEME_X_USER_ID
    && (tweet?.userId == null || tweet.userId === FOUR_MEME_X_USER_ID)
    && tweet?.url === `https://x.com/${FOUR_MEME_X_HANDLE}/status/${tweetId}`
    && tweet?.sourceVerifiedBy === "official_x_oembed"
    && tweet?.isReply === false
    && strictFourMemeInstant(tweet?.createdAt) !== null
    && expandedUrlsValid
    && typeof tweet?.text === "string"
    && tweet.text.length > 0
    && tweet.text.length <= 20_000
    && !/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(tweet.text);
}

export function isOfficialFourMemeNamedModeUpdate(source) {
  const recomputed = classifyFourMemeNamedModeCore(source?.tweet?.text);
  const signalKeys = new Set(["relevant", "strong", "platformStructural", "labels", "reason", "namedMode"]);
  const namedMode = recomputed?.namedMode;
  const promotedShapeValid = Object.prototype.hasOwnProperty.call(source || {}, "policyFixRecovery") || (
    sameFlapValue(source?.mode, {
      officialName: namedMode?.name,
      componentMode: namedMode?.name,
      parentMode: namedMode?.parent,
    })
    && sameFlapValue(source?.productLifecycle, {
      product: namedMode?.id,
      stage: namedMode?.stage,
      key: `fourmeme:lifecycle:${namedMode?.id}:${namedMode?.stage}`,
    })
  );
  return isOfficialFourMemeXSource(source)
    && recomputed !== null
    && promotedShapeValid
    && exactFlapKeys(source.signal, signalKeys, [...signalKeys])
    && sameFlapValue(source.signal, recomputed);
}

export function isStrictFourMemeMarketCampaign(source) {
  const recomputed = classifyFourMemeMarketCampaignCore(source?.tweet?.text);
  const signalKeys = new Set(["relevant", "strong", "platformStructural", "labels", "reason", "marketCampaign"]);
  return isOfficialFourMemeXSource(source)
    && recomputed !== null
    && exactFlapKeys(source.signal, signalKeys, [...signalKeys])
    && sameFlapValue(source.signal, recomputed);
}

function strictFourMemeInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

export function isFourMemePolicyFixRecoveryEvent(source) {
  const tweetId = String(source?.tweet?.id || "");
  const spec = FOUR_MEME_POLICY_RECOVERY_SPECS.get(tweetId);
  const recovery = source?.policyFixRecovery;
  const recoveryKeys = new Set([
    "version", "allowlistId", "reason", "originalEventKey", "derivedEventKey",
    "sourceOccurredAt", "recoveredAt", "lagMs", "evidenceSource", "expectedAuthorId",
    "tweetTextSha256", "stale", "noChase", "automaticExecution",
  ]);
  const rootRequired = ["type", "eventKey", "originalEventKey", "project", "tweet", "signal", "observedAt", "policyFixRecovery"];
  const rootKeys = new Set([
    ...rootRequired,
    "canonicalSignalId", "canonicalSignalIds", "freshness", "tradingPriority", "alertQueuedAt",
  ]);
  const projectKeys = new Set(["id", "name", "website", "twitter", "handle", "xUserId", "match", "priority"]);
  const tweetKeys = new Set([
    "id", "text", "createdAt", "authorName", "handle", "xUserId", "authorId", "url", "isReply",
    "expandedUrls", "sourceVerifiedBy", "identityVerifiedBy",
  ]);
  const expectedRecoveryKey = `fourmeme:policy-fix-recovery:x:${tweetId}:v1`;
  const canonicalKeysPresent = Object.prototype.hasOwnProperty.call(source || {}, "canonicalSignalId")
    || Object.prototype.hasOwnProperty.call(source || {}, "canonicalSignalIds");
  const canonicalKeysValid = !canonicalKeysPresent || (
    source.canonicalSignalId === expectedRecoveryKey
    && sameFlapValue(source.canonicalSignalIds, [expectedRecoveryKey])
  );
  const freshness = source?.freshness;
  const freshnessValid = freshness === undefined || (
    freshness?.version === 1
    && freshness.scope === "fourmeme_policy_fix_recovery"
    && freshness.basis === "policyFixRecovery.recoveredAt_continuous_recovery"
    && freshness.sourceOccurredAt === recovery?.recoveredAt
    && freshness.sourceTimeReliable === true
    && strictFourMemeInstant(freshness.discoveredAt) !== null
    && Number.isSafeInteger(freshness.lagMs)
    && freshness.lagMs === Math.max(0, Date.parse(freshness.discoveredAt) - Date.parse(recovery?.recoveredAt || ""))
    && Number.isFinite(freshness.realtimeMaxAgeMs) && freshness.realtimeMaxAgeMs >= 0
    && Number.isFinite(freshness.telegramMaxAgeMs) && freshness.telegramMaxAgeMs >= freshness.realtimeMaxAgeMs
    && ["realtime", "late", "suppress"].includes(freshness.decision)
  );
  const priority = source?.tradingPriority;
  const priorityValid = priority === undefined || (
    priority?.version === 2
    && priority.schema === "news_trading_priority_v2"
    && priority.deterministic === true
    && priority.tier === "T2"
    && priority.rank === 2
    && priority.category === "focus_policy_recovery"
    && priority.hardGates?.t1Eligible === false
    && priority.plan?.automaticExecution === false
  );
  const expectedExpandedUrls = spec?.kind === "market_campaign"
    ? ["http://Four.Meme", "http://Ave.ai"]
    : ["http://Four.Meme"];
  if (!spec
    || !exactFlapKeys(source, rootKeys, rootRequired)
    || !exactFlapKeys(source?.project, projectKeys, [...projectKeys])
    || !sameFlapValue(source.project, {
      id: "fourmeme",
      name: "Four.meme",
      website: "https://four.meme",
      twitter: `https://x.com/${FOUR_MEME_X_HANDLE}`,
      handle: FOUR_MEME_X_HANDLE,
      xUserId: FOUR_MEME_X_USER_ID,
      match: "official_x",
      priority: true,
    })
    || !exactFlapKeys(source?.tweet, tweetKeys, [...tweetKeys])
    || source.tweet.authorName !== "Four.meme-華語"
    || !sameFlapValue(source.tweet.expandedUrls, expectedExpandedUrls)
    || !canonicalKeysValid
    || !freshnessValid
    || !priorityValid
    || (source.alertQueuedAt !== undefined && strictFourMemeInstant(source.alertQueuedAt) === null)
    || !exactFlapKeys(recovery, recoveryKeys, [...recoveryKeys])
    || recovery.version !== 1
    || recovery.allowlistId !== spec.allowlistId
    || recovery.reason !== "historical_policy_false_negative"
    || recovery.originalEventKey !== spec.originalEventKey
    || recovery.derivedEventKey !== spec.derivedEventKey
    || recovery.sourceOccurredAt !== spec.createdAt
    || recovery.evidenceSource !== spec.evidenceSource
    || recovery.expectedAuthorId !== FOUR_MEME_X_USER_ID
    || recovery.tweetTextSha256 !== spec.textSha256
    || recovery.stale !== true
    || recovery.noChase !== true
    || recovery.automaticExecution !== false
    || source?.eventKey !== spec.derivedEventKey
    || source?.originalEventKey !== spec.originalEventKey
    || source?.observedAt !== recovery.recoveredAt
    || source?.tweet?.createdAt !== spec.createdAt
    || source?.tweet?.identityVerifiedBy !== "fxtwitter_exact_numeric_id"
    || createHash("sha256").update(source.tweet.text, "utf8").digest("hex") !== spec.textSha256) return false;
  const sourceOccurredAt = strictFourMemeInstant(recovery.sourceOccurredAt);
  const recoveredAt = strictFourMemeInstant(recovery.recoveredAt);
  if (sourceOccurredAt === null
    || recoveredAt === null
    || recoveredAt < sourceOccurredAt
    || !Number.isSafeInteger(recovery.lagMs)
    || recovery.lagMs !== recoveredAt - sourceOccurredAt) return false;
  return spec.kind === "named_mode"
    ? isOfficialFourMemeNamedModeUpdate(source)
    : isStrictFourMemeMarketCampaign(source);
}

export function isOfficialFourMemeCapabilityUpdate(source) {
  const capability = source?.officialCapability;
  const evidence = source?.source;
  const template = source?.mode?.template;
  const current = source?.currentTemplate;
  const previous = source?.previousTemplate;
  const changeType = source?.changeType;
  const observedAt = typeof source?.observedAt === "string" ? Date.parse(source.observedAt) : NaN;
  const capabilityKeys = new Set(["version", "platform", "kind", "changeType", "sourceId", "sourceUrl", "observedAt"]);
  const sourceKeys = new Set(["id", "name", "url", "trust", "official"]);
  const published = ["new_published_template", "template_published", "published_template_changed"].includes(changeType);
  return source?.type === "bsc_launchpad_update"
    && source?.kind === "new_mode"
    && Number(source?.chainId) === 56
    && compact(source?.platform?.id || source?.platform?.name) === "fourmeme"
    && source?.strong === true
    && source?.structural?.eligible === true
    && source?.structural?.source === "official_api"
    && source?.mode?.selector === "official-template"
    && source?.mode?.sourceUrl === FOUR_MEME_TEMPLATE_URL
    && source?.sourceUrl === FOUR_MEME_TEMPLATE_URL
    && source?.sourceTrust === "official_verified"
    && exactFlapKeys(capability, capabilityKeys, [...capabilityKeys])
    && capability.version === 1
    && capability.platform === "fourmeme"
    && capability.kind === "template"
    && FOUR_MEME_TEMPLATE_CHANGE_TYPES.has(changeType)
    && capability.changeType === changeType
    && capability.sourceId === FOUR_MEME_TEMPLATE_SOURCE_ID
    && capability.sourceUrl === FOUR_MEME_TEMPLATE_URL
    && capability.observedAt === source.observedAt
    && Number.isFinite(observedAt)
    && new Date(observedAt).toISOString() === source.observedAt
    && exactFlapKeys(evidence, sourceKeys, [...sourceKeys])
    && evidence.id === FOUR_MEME_TEMPLATE_SOURCE_ID
    && evidence.name === "Four.Meme public template API"
    && evidence.url === FOUR_MEME_TEMPLATE_URL
    && evidence.trust === "official_verified"
    && evidence.official === true
    && template?.changeType === changeType
    && String(template?.id || "") === String(current?.id || "")
    && template?.fingerprint === source?.mode?.fingerprint
    && source?.eventKey === `bsc-official-mode:fourmeme:${template.id}:${template.fingerprint}`
    && Array.isArray(source?.tokens) && source.tokens.length === 0
    && Array.isArray(source?.pools) && source.pools.length === 0
    && Array.isArray(source?.changedFields) && source.changedFields.length > 0
    && (published
      ? current?.status === "PUBLISHED"
      : changeType === "template_unpublished"
        && previous?.status === "PUBLISHED"
        && current?.status !== "PUBLISHED");
}

function validFlapQuotePairChange(value) {
  const changeKeys = new Set(["assetClass", "stage", "assets"]);
  if (!exactFlapKeys(value, changeKeys, [...changeKeys])
    || value.assetClass !== "bstock_quote"
    || !["announced", "live"].includes(value.stage)
    || !Array.isArray(value.assets)
    || value.assets.length < 1
    || value.assets.length > 8) return false;
  const symbols = new Set();
  for (const asset of value.assets) {
    const assetKeys = new Set(["symbol", "name"]);
    if (!exactFlapKeys(asset, assetKeys, ["symbol"])
      || !validFlapQuotePairSymbol(asset.symbol)
      || (Object.hasOwn(asset, "name") && !validFlapQuotePairName(asset.name))
      || symbols.has(asset.symbol)) return false;
    symbols.add(asset.symbol);
  }
  return true;
}

export function isOfficialFlapQuotePairUpdate(source) {
  const project = source?.project;
  const tweet = source?.tweet;
  const signal = source?.signal;
  const tweetId = typeof tweet?.id === "string" ? tweet.id : "";
  const recomputed = classifyFlapQuotePairSignalCore(tweet?.text);
  return source?.type === "twitter_update"
    && project?.id === "flap"
    && project?.handle === FLAP_X_HANDLE
    && project?.xUserId === FLAP_X_USER_ID
    && project?.match === "official_x"
    && /^\d{10,25}$/.test(tweetId)
    && tweet?.handle === FLAP_X_HANDLE
    && tweet?.xUserId === FLAP_X_USER_ID
    && tweet?.authorId === FLAP_X_USER_ID
    && tweet?.url === `https://x.com/${FLAP_X_HANDLE}/status/${tweetId}`
    && tweet?.sourceVerifiedBy === "official_x_oembed"
    && tweet?.isReply === false
    && typeof tweet?.text === "string"
    && tweet.text.length > 0
    && tweet.text.length <= 20_000
    && !FLAP_QUOTE_PAIR_INVALID_TEXT.test(tweet.text)
    && signal?.relevant === true
    && signal?.strong === true
    && signal?.platformStructural === true
    && signal?.reason === `flap_bstock_quote_pair_${recomputed?.stage || "invalid"}`
    && Array.isArray(signal?.labels)
    && signal.labels.includes(FLAP_QUOTE_PAIR_LABEL)
    && validFlapQuotePairChange(signal?.quotePairChange)
    && validFlapQuotePairChange(recomputed)
    && sameFlapValue(signal.quotePairChange, recomputed);
}

function validFlapQuoteAssetProof(value, item) {
  const allowed = new Set(["portal", "transactionHash", "blockNumber", "receiptVerified", "chainId"]);
  const required = ["portal", "transactionHash", "blockNumber", "receiptVerified"];
  if (!exactFlapKeys(value, allowed, required)
    || !FLAP_BSC_PORTALS.has(value.portal)
    || !/^0x[a-f0-9]{64}$/.test(value.transactionHash)
    || !Number.isSafeInteger(value.blockNumber)
    || value.blockNumber <= 0
    || value.receiptVerified !== true
    || (Object.hasOwn(value, "chainId") && value.chainId !== FLAP_BSC_CHAIN_ID)) return false;
  for (const key of ["portal", "transactionHash", "blockNumber", "receiptVerified"]) {
    if (Object.hasOwn(item, key) && item[key] !== value[key]) return false;
  }
  return true;
}

// Reused by the board source-control exception and the direct Portal producer.
// It accepts only the canonical BSC quote-asset record; stock/RWA text alone
// is never sufficient to enter this lane.
export function isStrictFlapQuoteAsset(value) {
  const allowed = new Set([
    "identity", "kind", "category", "vaultFactory", "quoteAddress", "quoteSymbol", "quoteName",
    "sourceUrl", "chainId", "quoteClassification", "quoteTags", "onchainProof",
    "portal", "transactionHash", "blockNumber", "receiptVerified",
  ]);
  const required = ["identity", "kind", "quoteAddress", "quoteSymbol", "quoteName", "sourceUrl", "chainId"];
  if (!exactFlapKeys(value, allowed, required)
    || value.kind !== "quote_asset"
    || value.chainId !== FLAP_BSC_CHAIN_ID
    || value.sourceUrl !== FLAP_BOARD_URL
    || !/^0x[a-f0-9]{40}$/.test(value.quoteAddress)
    || value.identity !== `chain-${FLAP_BSC_CHAIN_ID}:quote:${value.quoteAddress}`
    || !validFlapDirectQuoteSymbol(value.quoteSymbol)
    || !validFlapMetadataText(value.quoteName, 96, 2)
    || (Object.hasOwn(value, "category") && value.category !== null)
    || (Object.hasOwn(value, "vaultFactory") && value.vaultFactory !== null)) return false;
  if (Object.hasOwn(value, "quoteClassification")
    && !validFlapMetadataText(value.quoteClassification, 96, 2)) return false;
  if (Object.hasOwn(value, "quoteTags")) {
    if (!Array.isArray(value.quoteTags) || value.quoteTags.length > 8) return false;
    const tags = new Set();
    for (const tag of value.quoteTags) {
      if (!validFlapMetadataText(tag, 48)
        || tags.has(tag)) return false;
      tags.add(tag);
    }
  }
  const rootProofFields = ["portal", "transactionHash", "blockNumber", "receiptVerified"];
  if (!Object.hasOwn(value, "onchainProof")) return !rootProofFields.some((key) => Object.hasOwn(value, key));
  return validFlapQuoteAssetProof(value.onchainProof, value);
}

function isStrictFlapQuoteAssetPrevious(value) {
  const allowed = new Set([
    "identity", "kind", "category", "vaultFactory", "quoteAddress", "quoteSymbol", "quoteName",
    "sourceUrl", "chainId", "quoteClassification", "quoteTags",
  ]);
  const required = ["identity", "kind", "quoteAddress", "sourceUrl", "chainId"];
  if (!exactFlapKeys(value, allowed, required)
    || value.kind !== "quote_asset"
    || value.chainId !== FLAP_BSC_CHAIN_ID
    || value.sourceUrl !== FLAP_BOARD_URL
    || !/^0x[a-f0-9]{40}$/.test(value.quoteAddress)
    || value.identity !== `chain-${FLAP_BSC_CHAIN_ID}:quote:${value.quoteAddress}`
    || (Object.hasOwn(value, "category") && value.category !== null)
    || (Object.hasOwn(value, "vaultFactory") && value.vaultFactory !== null)
    || (Object.hasOwn(value, "quoteSymbol") && value.quoteSymbol !== null && !validFlapDirectQuoteSymbol(value.quoteSymbol))
    || (Object.hasOwn(value, "quoteName") && value.quoteName !== null && !validFlapMetadataText(value.quoteName, 96, 2))
    || (Object.hasOwn(value, "quoteClassification") && !validFlapMetadataText(value.quoteClassification, 96, 2))) return false;
  if (!Object.hasOwn(value, "quoteTags")) return true;
  return Array.isArray(value.quoteTags)
    && value.quoteTags.length <= 8
    && new Set(value.quoteTags).size === value.quoteTags.length
    && value.quoteTags.every((tag) => validFlapMetadataText(tag, 48));
}

function claimsFlapQuoteAssetCapability(source) {
  if (source?.type !== "platform_capability_update" || source?.platform?.id !== "flap") return false;
  const pools = [
    ...(Array.isArray(source.changes?.newFlapPools) ? source.changes.newFlapPools : []),
    ...(Array.isArray(source.changes?.updatedFlapPools) ? source.changes.updatedFlapPools : []),
    ...(Array.isArray(source.changes?.flapPoolChanges)
      ? source.changes.flapPoolChanges.flatMap((change) => [change?.before, change?.after])
      : []),
  ];
  return pools.some((pool) => pool?.kind === "quote_asset"
    || Object.hasOwn(pool || {}, "quoteAddress")
    || /^chain-56:quote:/i.test(String(pool?.identity || "")));
}

function isStrictFlapBoardQuoteAssetUpdate(source) {
  if (source?.type !== "platform_capability_update"
    || source?.platform?.id !== "flap"
    || (source.platform.chainId != null && source.platform.chainId !== FLAP_BSC_CHAIN_ID)
    || (source.chainId != null && source.chainId !== FLAP_BSC_CHAIN_ID)
    || source?.source !== FLAP_BOARD_URL
    || source?.url !== FLAP_BOARD_URL
    || (Object.hasOwn(source, "sources")
      && (!Array.isArray(source.sources) || source.sources.length !== 1 || source.sources[0] !== FLAP_BOARD_URL))
    || !flapRecord(source?.changes)) return false;

  const allowedNonEmpty = new Set([
    "newFlapPools", "updatedFlapPools", "flapPoolChanges", "changedSources", "newContentFingerprints",
  ]);
  for (const [key, value] of Object.entries(source.changes)) {
    if (!Array.isArray(value) || (value.length > 0 && !allowedNonEmpty.has(key))) return false;
  }
  const newPools = source.changes.newFlapPools || [];
  const updatedPools = source.changes.updatedFlapPools || [];
  const changes = source.changes.flapPoolChanges || [];
  if (!Array.isArray(newPools)
    || !Array.isArray(updatedPools)
    || !Array.isArray(changes)
    || newPools.length + updatedPools.length < 1
    || newPools.length + updatedPools.length > 32
    || !newPools.every(isStrictFlapQuoteAsset)
    || !updatedPools.every(isStrictFlapQuoteAsset)) return false;

  const changedSources = source.changes.changedSources || [];
  const fingerprints = source.changes.newContentFingerprints || [];
  if (!Array.isArray(changedSources)
    || changedSources.some((url) => url !== FLAP_BOARD_URL)
    || !Array.isArray(fingerprints)
    || fingerprints.some((value) => !/^https:\/\/flap\.sh\/board#[a-f0-9]{64}$/.test(value))) return false;

  if (updatedPools.length !== changes.length) return false;
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (!exactFlapKeys(change, new Set(["identity", "before", "after"]), ["identity", "before", "after"])
      || !isStrictFlapQuoteAssetPrevious(change.before)
      || !isStrictFlapQuoteAsset(change.after)
      || change.identity !== change.after.identity
      || !sameFlapValue(change.after, updatedPools[index])) return false;
  }
  const identities = [...newPools, ...updatedPools].map(({ identity }) => identity);
  return new Set(identities).size === identities.length;
}

function validFlapQuoteConfiguration(value) {
  const keys = new Set([
    "enabled", "enabledRaw", "defaultCurve", "alternativeCurve", "nativeToQuoteSwapType", "dexId",
  ]);
  if (!exactFlapKeys(value, keys, [...keys]) || value.enabled !== true || value.enabledRaw !== 1) return false;
  return ["defaultCurve", "alternativeCurve", "nativeToQuoteSwapType", "dexId"]
    .every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 255);
}

function expectedFlapQuoteConfigurationLogData(asset, configuration) {
  if (!/^0x[a-f0-9]{40}$/.test(String(asset?.quoteAddress || ""))
    || !validFlapQuoteConfiguration(configuration)) return null;
  const uint256Word = (value) => value.toString(16).padStart(64, "0");
  return `0x${asset.quoteAddress.slice(2).padStart(64, "0")}${[
    configuration.enabledRaw,
    configuration.defaultCurve,
    configuration.alternativeCurve,
    configuration.nativeToQuoteSwapType,
    configuration.dexId,
  ].map(uint256Word).join("")}`;
}

function validFlapDirectQuoteAsset(value) {
  const keys = new Set([
    "identity", "kind", "category", "vaultFactory", "quoteAddress", "quoteName", "quoteSymbol",
    "quoteDecimals", "decimals", "enabled", "configuration", "chainId", "portal", "codeHash",
    "codeBytes", "verifiedAtBlock", "verifiedAtBlockHash", "sourceUrl",
  ]);
  const required = [...keys];
  return exactFlapKeys(value, keys, required)
    && value.kind === "quote_asset"
    && value.category === null
    && value.vaultFactory === null
    && /^0x[a-f0-9]{40}$/.test(value.quoteAddress)
    && value.identity === `chain-${FLAP_BSC_CHAIN_ID}:quote:${value.quoteAddress}`
    && validFlapMetadataText(value.quoteName, 256, 1)
    && validFlapDirectQuoteSymbol(value.quoteSymbol)
    && Number.isSafeInteger(value.quoteDecimals)
    && value.quoteDecimals >= 0
    && value.quoteDecimals <= 255
    && value.decimals === value.quoteDecimals
    && value.enabled === true
    && validFlapQuoteConfiguration(value.configuration)
    && value.chainId === FLAP_BSC_CHAIN_ID
    && value.portal === FLAP_BSC_QUOTE_PORTAL
    && /^0x[a-f0-9]{64}$/.test(value.codeHash)
    && Number.isSafeInteger(value.codeBytes)
    && value.codeBytes > 0
    && Number.isSafeInteger(value.verifiedAtBlock)
    && value.verifiedAtBlock > 0
    && /^0x[a-f0-9]{64}$/.test(value.verifiedAtBlockHash)
    && value.sourceUrl === FLAP_BOARD_URL;
}

function exactFlapIso(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null;
}

function validFlapTrackedTokenDerivedFields(source) {
  const canonicalFields = ["canonicalSignalId", "canonicalSignalIds"]
    .filter((key) => Object.hasOwn(source, key));
  if (canonicalFields.length !== 0 && canonicalFields.length !== 2) return false;
  if (canonicalFields.length === 2) {
    if (typeof source.canonicalSignalId !== "string"
      || source.canonicalSignalId.length < 1
      || source.canonicalSignalId.length > 512
      || !Array.isArray(source.canonicalSignalIds)
      || source.canonicalSignalIds.length < 1
      || source.canonicalSignalIds.length > 16
      || !source.canonicalSignalIds.every((value) => typeof value === "string" && value.length > 0 && value.length <= 512)
      || !source.canonicalSignalIds.includes(source.canonicalSignalId)) return false;
  }
  if (Object.hasOwn(source, "alertQueuedAt") && exactFlapIso(source.alertQueuedAt) === null) return false;
  if (Object.hasOwn(source, "freshness")) {
    if (!flapRecord(source.freshness)
      || !["realtime", "late", "suppress"].includes(source.freshness.decision)
      || source.freshness.version !== 1
      || source.freshness.scope !== "bsc_chain"
      || source.freshness.sourceOccurredAt !== source.blockTimestamp) return false;
  }
  if (Object.hasOwn(source, "tradingPriority")) {
    const priority = source.tradingPriority;
    if (!flapRecord(priority)
      || priority.version !== 2
      || priority.schema !== "news_trading_priority_v2"
      || priority.deterministic !== true
      || !["T0", "T1", "T2"].includes(priority.tier)
      || priority.plan?.automaticExecution !== false) return false;
  }
  return true;
}

function validOpenFourPlatform(value) {
  const keys = new Set([
    "id", "name", "trust", "website", "twitter", "github", "notifyFirstToken",
    "notifyFirstInfrastructureActivation", "evidenceUrl",
  ]);
  return exactFlapKeys(value, keys, [...keys])
    && value.id === "fourmeme"
    && value.name === "Four.Meme / OpenFour"
    && value.trust === "official_verified"
    && value.website === "https://four.meme"
    && value.twitter === "https://x.com/fourdotmemezh"
    && value.github === null
    && value.notifyFirstToken === false
    && value.notifyFirstInfrastructureActivation === false
    && value.evidenceUrl === "https://four.meme/meme-api/v1/public/address";
}

function validOpenFourDeliverySla(value) {
  if (value === undefined) return true;
  const keys = new Set(["startedAt", "deadlineAt", "budgetMs", "pollAllowanceMs", "basis"]);
  const startedAt = exactFlapIso(value?.startedAt);
  const deadlineAt = exactFlapIso(value?.deadlineAt);
  return exactFlapKeys(value, keys, [...keys])
    && startedAt !== null
    && deadlineAt !== null
    && deadlineAt >= startedAt
    && deadlineAt - startedAt <= 5_000
    && value.budgetMs === 5_000
    && value.pollAllowanceMs === 0
    && value.basis === "bsc_websocket_ingest";
}

function validOpenFourFeatureActivation(mode, featureActivationKey, sourceUrl) {
  if (!flapRecord(mode)
    || mode.featureActivationEligible !== true
    || mode.featureActivationKey !== featureActivationKey
    || typeof featureActivationKey !== "string"
    || featureActivationKey.length < 3
    || featureActivationKey.length > 512) return false;
  if (sourceUrl === FOUR_MEME_OPENFOUR_CONFIG_SOURCE_URL) {
    const symbol = String(mode.quoteSymbol || "");
    const quoteAddress = String(mode.quoteAsset || "").toLowerCase();
    const fingerprint = String(mode.quoteFingerprint || "");
    return /^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(symbol)
      && /^0x[a-f0-9]{40}$/.test(quoteAddress)
      && fingerprint.length > 0
      && featureActivationKey === `quote:${symbol}:${quoteAddress}:${fingerprint}`;
  }
  if (sourceUrl !== FOUR_MEME_OPENFOUR_TEMPLATE_SOURCE_URL) return false;
  const templateId = String(mode.templateId || mode.presetId || "");
  const fingerprint = String(mode.templateFingerprint || "");
  return /^[1-9]\d{0,39}$/.test(templateId)
    && fingerprint.length > 0
    && featureActivationKey === `template:${templateId}:${fingerprint}`;
}

function openFourCoreTokenIdentity(transactionHash, logIndex, token) {
  return `fourmeme:openfour-core-token-created:56:${transactionHash}:${logIndex}:${token}`;
}

function fourRegistryFreshnessSource(raw) {
  if (raw?.canonicalRevision) {
    return {
      scope: "four_registry_canonical_revision",
      basis: "canonicalRevision.recoveryDetectedAt_finalized_reorg",
      value: raw.canonicalRevision.recoveryDetectedAt,
    };
  }
  if (raw?.canonicalRestoration) {
    return {
      scope: "four_registry_canonical_restoration",
      basis: "canonicalRestoration.detectedAt_recanonicalized",
      value: raw.canonicalRestoration.detectedAt,
    };
  }
  if (raw?.canonicalSupersession) {
    return {
      scope: "four_registry_canonical_supersession",
      basis: "canonicalSupersession.detectedAt_replacement",
      value: raw.canonicalSupersession.detectedAt,
    };
  }
  if (raw?.delayedRecovery) {
    return {
      scope: "four_registry_delayed_recovery",
      basis: "delayedRecovery.recoveredAt_continuous_recovery",
      value: raw.delayedRecovery.recoveredAt,
    };
  }
  return {
    scope: raw?.kind === FOUR_REGISTRY_FIRST_TOKEN_KIND
      ? "four_registry_first_token"
      : "four_registry_capability",
    basis: "blockTimestamp",
    value: raw?.blockTimestamp,
  };
}

function validFourRegistryPipelineFreshness(value, raw) {
  const source = fourRegistryFreshnessSource(raw);
  const baseKeys = [
    "version", "scope", "basis", "sourceOccurredAt", "discoveredAt", "lagMs", "sourceTimeReliable",
    "realtimeMaxAgeMs", "telegramMaxAgeMs", "decision", "reason",
  ];
  const deliveryKeys = ["deliveryEvaluatedAt", "deliveryLagMs", "deliveryDecision"];
  const hasDelivery = deliveryKeys.some((key) => Object.hasOwn(value || {}, key));
  const expectedKeys = [...baseKeys, ...(hasDelivery ? deliveryKeys : [])];
  if (!exactFlapKeys(value, new Set(expectedKeys), expectedKeys)) return false;
  const sourceMs = exactFlapIso(source.value);
  const sourceOccurredAtMs = exactFlapIso(value.sourceOccurredAt);
  const discoveredMs = exactFlapIso(value.discoveredAt);
  const realtimeMaxAgeMs = Number(value.realtimeMaxAgeMs);
  const telegramMaxAgeMs = Number(value.telegramMaxAgeMs);
  if (value.version !== 1
    || value.scope !== source.scope
    || value.basis !== source.basis
    || sourceMs === null
    || sourceOccurredAtMs !== sourceMs
    || discoveredMs === null
    || value.sourceTimeReliable !== true
    || !Number.isSafeInteger(realtimeMaxAgeMs)
    || realtimeMaxAgeMs < 0
    || !Number.isSafeInteger(telegramMaxAgeMs)
    || telegramMaxAgeMs < realtimeMaxAgeMs) return false;
  const classify = (evaluatedMs) => {
    const lagMs = Math.max(0, evaluatedMs - sourceMs);
    if (lagMs <= realtimeMaxAgeMs) return {
      lagMs,
      decision: "realtime",
      reason: sourceMs > evaluatedMs ? "source_clock_ahead" : "within_realtime_window",
    };
    if (lagMs <= telegramMaxAgeMs) return { lagMs, decision: "late", reason: "late_backfill_downgrade" };
    return { lagMs, decision: "suppress", reason: "too_old_for_telegram" };
  };
  const initial = classify(discoveredMs);
  if (value.lagMs !== initial.lagMs
    || value.decision !== initial.decision
    || value.reason !== initial.reason) return false;
  if (!hasDelivery) return true;
  const deliveryMs = exactFlapIso(value.deliveryEvaluatedAt);
  if (deliveryMs === null || deliveryMs < discoveredMs) return false;
  const delivery = classify(deliveryMs);
  return value.deliveryLagMs === delivery.lagMs
    && value.deliveryDecision === delivery.decision;
}

function validFourRegistryPipelinePriority(value, raw, freshness) {
  const firstToken = raw.kind === FOUR_REGISTRY_FIRST_TOKEN_KIND;
  const expectedConfirmationKind = firstToken
    ? "official_openfour_core_token_created"
    : "official_openfour_registry_log";
  if (!flapRecord(value)
    || value.version !== 2
    || value.schema !== "news_trading_priority_v2"
    || value.deterministic !== true
    || value.plan?.automaticExecution !== false
    || value.confirmation?.trusted !== true
    || value.confirmation?.kind !== expectedConfirmationKind
    || value.confirmation?.value !== `${raw.transactionHash}#${raw.logIndex}`
    || value.hardGates?.trustedConfirmation !== true
    || value.hardGates?.t0Eligible !== false) return false;
  const delayedRecovery = Boolean(raw.delayedRecovery);
  const canonicalRevision = Boolean(raw.canonicalRevision);
  const delayedDelivery = [freshness?.decision, freshness?.deliveryDecision]
    .some((decision) => ["late", "suppress"].includes(decision));
  const expectedCategory = canonicalRevision
    ? "focus_registry_canonical_revision"
    : firstToken
    ? "focus_registry_first_token"
    : delayedRecovery ? "focus_registry_delayed_recovery" : "focus_registry_capability";
  const expectedTier = firstToken || delayedRecovery || delayedDelivery || canonicalRevision ? "T2" : "T1";
  return value.category === expectedCategory
    && value.tier === expectedTier
    && value.rank === (expectedTier === "T1" ? 3 : 2)
    && value.hardGates.t1Eligible === (expectedTier === "T1");
}

function rawFourRegistrySignalKeys(raw) {
  if (raw?.kind === FOUR_REGISTRY_FIRST_TOKEN_KIND) {
    const base = openFourCoreTokenIdentity(
      normalized(raw.transactionHash),
      Number(raw.logIndex),
      normalized(raw.token?.address),
    );
    return [raw.canonicalRevision
      ? `${base}:canonical-revision:${normalized(raw.blockHash)}:${Number(raw.canonicalRevision.recoveryEpoch)}`
      : base];
  }
  return typeof raw?.lifecycleKey === "string" && raw.lifecycleKey
    ? [raw.canonicalRevision
      ? `${raw.lifecycleKey}:canonical-revision:${normalized(raw.blockHash)}:${Number(raw.canonicalRevision.recoveryEpoch)}`
      : raw.lifecycleKey]
    : [];
}

function fourRegistryRawEvent(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  if (isRawFourRegistryCapabilityEvent(source) || isRawFourRegistryFirstTokenEvent(source)) return source;
  const presentDerived = [...FOUR_REGISTRY_DERIVED_EVENT_KEYS].filter((key) => Object.hasOwn(source, key));
  if (!presentDerived.length) return null;
  const raw = { ...source };
  for (const key of FOUR_REGISTRY_DERIVED_EVENT_KEYS) delete raw[key];
  if (!isRawFourRegistryCapabilityEvent(raw) && !isRawFourRegistryFirstTokenEvent(raw)) return null;
  const expectedSignals = [...rawFourRegistrySignalKeys(raw)].sort();
  const canonicalPresent = ["canonicalSignalId", "canonicalSignalIds"].filter((key) => Object.hasOwn(source, key));
  if (canonicalPresent.length !== 0 && canonicalPresent.length !== 2) return null;
  if (canonicalPresent.length === 2
    && (source.canonicalSignalId !== expectedSignals[0]
      || !sameFlapValue(source.canonicalSignalIds, expectedSignals))) return null;
  const runtimePresent = ["freshness", "tradingPriority", "alertQueuedAt"]
    .filter((key) => Object.hasOwn(source, key));
  if (runtimePresent.length === 0) return raw;
  if (runtimePresent.length !== 3
    || canonicalPresent.length !== 2
    || !validFourRegistryPipelineFreshness(source.freshness, raw)
    || !validFourRegistryPipelinePriority(source.tradingPriority, raw, source.freshness)) return null;
  const queuedAtMs = exactFlapIso(source.alertQueuedAt);
  const discoveredAtMs = exactFlapIso(source.freshness.discoveredAt);
  if (queuedAtMs === null
    || discoveredAtMs === null
    || queuedAtMs < discoveredAtMs
    || queuedAtMs - discoveredAtMs > 60_000) return null;
  return raw;
}

function fourRegistryPriorityRawEvent(source) {
  const finalOrRaw = fourRegistryRawEvent(source);
  if (finalOrRaw) return finalOrRaw;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const presentDerived = [...FOUR_REGISTRY_DERIVED_EVENT_KEYS].filter((key) => Object.hasOwn(source, key));
  const expectedDerived = ["canonicalSignalId", "canonicalSignalIds", "freshness"];
  if (!sameFlapValue([...presentDerived].sort(), [...expectedDerived].sort())) return null;
  const raw = { ...source };
  for (const key of FOUR_REGISTRY_DERIVED_EVENT_KEYS) delete raw[key];
  if (!isRawFourRegistryCapabilityEvent(raw) && !isRawFourRegistryFirstTokenEvent(raw)) return null;
  const expectedSignals = [...rawFourRegistrySignalKeys(raw)].sort();
  return source.canonicalSignalId === expectedSignals[0]
    && sameFlapValue(source.canonicalSignalIds, expectedSignals)
    && validFourRegistryPipelineFreshness(source.freshness, raw)
    ? raw
    : null;
}

export function claimsFourRegistryUpdate(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  if (source.type === "platform_capability_update") {
    return FOUR_REGISTRY_CAPABILITY_KINDS.includes(source.kind)
      || source.source?.id === FOUR_REGISTRY_CAPABILITY_SOURCE_ID;
  }
  return source.type === "bsc_launchpad_update"
    && (source.kind === FOUR_REGISTRY_FIRST_TOKEN_KIND
      || (source.schemaVersion === 1 && source.source?.id === FOUR_REGISTRY_FIRST_TOKEN_SOURCE_ID));
}

export function isStrictFourRegistryCapabilityUpdate(source) {
  const raw = fourRegistryRawEvent(source);
  return Boolean(raw && isRawFourRegistryCapabilityEvent(raw));
}

export function isStrictFourRegistryFirstTokenUpdate(source) {
  const raw = fourRegistryRawEvent(source);
  return Boolean(raw && isRawFourRegistryFirstTokenEvent(raw));
}

export function isStrictFourRegistryDelayedRecovery(source) {
  const raw = fourRegistryRawEvent(source);
  return Boolean(raw?.delayedRecovery
    && (isRawFourRegistryCapabilityEvent(raw) || isRawFourRegistryFirstTokenEvent(raw)));
}

export function isStrictFourRegistryCanonicalRevision(source) {
  const raw = fourRegistryRawEvent(source);
  return Boolean(raw?.canonicalRevision
    && (isRawFourRegistryCapabilityEvent(raw) || isRawFourRegistryFirstTokenEvent(raw)));
}

export function isStrictFourRegistryCanonicalRestoration(source) {
  const raw = fourRegistryRawEvent(source);
  return Boolean(raw?.canonicalRestoration
    && (isRawFourRegistryCapabilityEvent(raw) || isRawFourRegistryFirstTokenEvent(raw)));
}

export function isStrictFourRegistryCanonicalSupersession(source) {
  const raw = fourRegistryRawEvent(source);
  return Boolean(raw?.canonicalSupersession
    && (isRawFourRegistryCapabilityEvent(raw) || isRawFourRegistryFirstTokenEvent(raw)));
}

export function isStrictFourRegistryCapabilityForPriority(source) {
  const raw = fourRegistryPriorityRawEvent(source);
  return Boolean(raw && isRawFourRegistryCapabilityEvent(raw));
}

export function isStrictFourRegistryFirstTokenForPriority(source) {
  const raw = fourRegistryPriorityRawEvent(source);
  return Boolean(raw && isRawFourRegistryFirstTokenEvent(raw));
}

export function isStrictFourRegistryDelayedRecoveryForPriority(source) {
  const raw = fourRegistryPriorityRawEvent(source);
  return Boolean(raw?.delayedRecovery
    && (isRawFourRegistryCapabilityEvent(raw) || isRawFourRegistryFirstTokenEvent(raw)));
}

export function isStrictFourRegistryCanonicalRevisionForPriority(source) {
  const raw = fourRegistryPriorityRawEvent(source);
  return Boolean(raw?.canonicalRevision
    && (isRawFourRegistryCapabilityEvent(raw) || isRawFourRegistryFirstTokenEvent(raw)));
}

export function claimsBscOpenFourFirstTokenUpdate(source) {
  return source?.type === "bsc_launchpad_update"
    && (source.featureFirstToken === true
      || source.officialFirstToken === true)
    && (normalized(source.featurePlatform) === "fourmeme"
      || normalized(source.launcher) === FOUR_MEME_OPENFOUR_CORE);
}

/**
 * Authenticate the legacy BSC producer's OpenFour first-token observation.
 * A display label, activation key, or token CA alone cannot enter this lane:
 * the event must bind the exact finalized Core TokenCreated log and preserve
 * the producer's monitor-only execution boundary.
 */
export function isStrictBscOpenFourFirstTokenUpdate(source) {
  const required = [
    "type", "kind", "eventKey", "officialFirstToken", "featureFirstToken", "featurePlatform",
    "featureActivationKey", "chainId", "launcher", "platform", "launchCount", "uniqueTokens",
    "transactionHash", "blockNumber", "blockHash", "transactionIndex", "logIndex", "canonical",
    "confirmations", "requiredConfirmations", "tokens", "pools", "mode", "structural", "security",
    "attribution", "deployer", "controllerKind", "launchEvidence", "explorerEvidence", "marketContext",
    "explorerUrl", "launcherUrl", "sourceUrl", "blockTimestamp", "observedAt", "strong",
    "informationalOnly", "autoTradeEligible", "automaticExecution",
  ];
  if (!exactFlapKeys(source, FOUR_MEME_OPENFOUR_EVENT_KEYS, required)) return false;
  const transactionHash = normalized(source.transactionHash);
  const blockHash = normalized(source.blockHash);
  const tokenEntry = Array.isArray(source.tokens) && source.tokens.length === 1 ? source.tokens[0] : null;
  const token = normalized(tokenEntry?.token);
  const blockNumber = Number(source.blockNumber);
  const transactionIndex = Number(source.transactionIndex);
  const logIndex = Number(source.logIndex);
  const confirmations = Number(source.confirmations);
  const requiredConfirmations = Number(source.requiredConfirmations);
  const blockTimestamp = exactFlapIso(source.blockTimestamp);
  const observedAt = exactFlapIso(source.observedAt);
  const evidence = Array.isArray(source.launchEvidence)
    ? source.launchEvidence.filter((item) => normalized(item?.event) === "tokencreated"
      && normalized(item?.topic) === FOUR_MEME_OPENFOUR_TOKEN_CREATED_TOPIC
      && normalized(item?.emitter) === FOUR_MEME_OPENFOUR_CORE
      && normalized(item?.token) === token)
    : [];
  const proof = evidence.length === 1 ? evidence[0] : null;
  const canonicalSignal = openFourCoreTokenIdentity(transactionHash, logIndex, token);
  const expectedSignals = source.security?.decision === "pass"
    && source.security?.metrics?.liquidityConfirmed === true
    ? [canonicalSignal, `${canonicalSignal}:safety-pass-v1`]
    : [canonicalSignal];
  const derivedSignalsValid = !Object.hasOwn(source, "canonicalSignalId")
    || (source.canonicalSignalId === canonicalSignal
      && Array.isArray(source.canonicalSignalIds)
      && source.canonicalSignalIds.length === expectedSignals.length
      && source.canonicalSignalIds.every((value, index) => value === expectedSignals[index]));
  const featureActivationValid = validOpenFourFeatureActivation(
    source.mode,
    source.featureActivationKey,
    source.sourceUrl,
  );
  const infrastructureSafety = source.security?.decision === "pass"
    ? source.security?.metrics?.liquidityConfirmed === true
    : source.security?.decision === "block"
      ? Array.isArray(source.security?.reasons)
        && source.security.reasons.length > 0
        && source.security.reasons.every((reason) => reason === "池子实际流动性未确认")
      : false;
  return source.type === "bsc_launchpad_update"
    && source.kind === "new_mode"
    && source.officialFirstToken === true
    && source.featureFirstToken === true
    && source.featurePlatform === "fourmeme"
    && source.chainId === FLAP_BSC_CHAIN_ID
    && normalized(source.launcher) === FOUR_MEME_OPENFOUR_CORE
    && source.eventKey === `bsc-fourmeme-feature-token:${source.featureActivationKey}`
    && validOpenFourPlatform(source.platform)
    && Number.isSafeInteger(source.launchCount) && source.launchCount > 0
    && Number.isSafeInteger(source.uniqueTokens) && source.uniqueTokens > 0
    && /^0x[a-f0-9]{64}$/.test(transactionHash)
    && source.transactionHash === transactionHash
    && /^0x[a-f0-9]{64}$/.test(blockHash)
    && source.blockHash === blockHash
    && Number.isSafeInteger(blockNumber) && blockNumber > 0 && source.blockNumber === blockNumber
    && Number.isSafeInteger(transactionIndex) && transactionIndex >= 0 && source.transactionIndex === transactionIndex
    && Number.isSafeInteger(logIndex) && logIndex >= 0 && source.logIndex === logIndex
    && source.canonical === true
    && Number.isSafeInteger(confirmations) && confirmations >= 0 && source.confirmations === confirmations
    && Number.isSafeInteger(requiredConfirmations) && requiredConfirmations >= 1
    && source.requiredConfirmations === requiredConfirmations
    && confirmations >= requiredConfirmations
    && /^0x[a-f0-9]{40}$/.test(token)
    && flapRecord(tokenEntry)
    && sameFlapValue(tokenEntry.launchEvidence, proof)
    && proof?.transactionHash === transactionHash
    && proof?.blockHash === blockHash
    && proof?.blockNumber === blockNumber
    && proof?.transactionIndex === transactionIndex
    && proof?.logIndex === logIndex
    && blockTimestamp !== null
    && observedAt !== null
    && blockTimestamp === observedAt
    && source.strong === true
    && source.informationalOnly === true
    && source.autoTradeEligible === false
    && source.automaticExecution === false
    && source.structural?.eligible === true
    && source.structural?.mechanismEvidence === true
    && infrastructureSafety
    && source.explorerUrl === `https://bscscan.com/tx/${transactionHash}`
    && source.launcherUrl === `https://bscscan.com/address/${FOUR_MEME_OPENFOUR_CORE}`
    && featureActivationValid
    && validOpenFourDeliverySla(source.deliverySla)
    && derivedSignalsValid
    && validFlapTrackedTokenDerivedFields(source);
}

export function openFourCoreTokenCreatedSemanticKey(source) {
  if (isStrictBscOpenFourFirstTokenUpdate(source)) {
    return openFourCoreTokenIdentity(
      normalized(source.transactionHash),
      Number(source.logIndex),
      normalized(source.tokens[0].token),
    );
  }
  if (isStrictFourRegistryFirstTokenUpdate(source)) {
    const base = openFourCoreTokenIdentity(
      normalized(source.transactionHash),
      Number(source.logIndex),
      normalized(source.token?.address),
    );
    return source.canonicalRevision
      ? `${base}:canonical-revision:${normalized(source.blockHash)}:${Number(source.canonicalRevision.recoveryEpoch)}`
      : base;
  }
  return null;
}

export function openFourCoreTokenCreatedSafetyPassSemanticKey(source) {
  const base = openFourCoreTokenCreatedSemanticKey(source);
  return base
    && source.security?.decision === "pass"
    && source.security?.metrics?.liquidityConfirmed === true
    ? `${base}:safety-pass-v1`
    : null;
}

function validFlapTrackedTokenPlatform(value) {
  const keys = new Set([
    "id", "name", "trust", "website", "twitter", "github", "notifyFirstToken",
    "notifyFirstInfrastructureActivation", "evidenceUrl",
  ]);
  return exactFlapKeys(value, keys, [...keys])
    && value.id === "flap"
    && value.name === "Flap"
    && value.trust === "official_verified"
    && value.website === "https://flap.sh"
    && value.twitter === "https://x.com/flapdotsh"
    && value.github === null
    && value.notifyFirstToken === false
    && value.notifyFirstInfrastructureActivation === false
    && value.evidenceUrl === `https://bscscan.com/address/${FLAP_TRACKED_TOKEN_PORTAL}`;
}

function validFlapTrackedTokenMetadata(value) {
  if (value === null) return true;
  if (!flapRecord(value)) return false;
  for (const key of ["name", "symbol", "description"]) {
    if (value[key] !== null && value[key] !== undefined
      && (typeof value[key] !== "string" || value[key].length > 512)) return false;
  }
  if (value.decimals !== null && value.decimals !== undefined
    && (!Number.isSafeInteger(Number(value.decimals)) || Number(value.decimals) < 0 || Number(value.decimals) > 255)) return false;
  return true;
}

function validFlapTrackedTokenSecurity(value) {
  if (!flapRecord(value) || !["pass", "block", "unknown"].includes(value.decision)) return false;
  if (value.label !== undefined && (typeof value.label !== "string" || !value.label.trim() || value.label.length > 256)) return false;
  if (value.reasons !== undefined && (!Array.isArray(value.reasons)
    || value.reasons.length > 64
    || !value.reasons.every((reason) => typeof reason === "string" && reason.length > 0 && reason.length <= 512))) return false;
  return value.metrics === undefined || flapRecord(value.metrics);
}

function validFlapTrackedTokenRecovery(value, source, blockTimestamp, observedAt) {
  const keys = new Set([
    "version", "reason", "sourceOccurredAt", "firstObservedAt", "recoveredAt", "lagMs",
    "continuousCoverage",
  ]);
  if (!exactFlapKeys(value, keys, [...keys])
    || value.version !== 1
    || value.reason !== FLAP_TRACKED_TOKEN_RECOVERY_REASON
    || value.continuousCoverage !== true) return false;
  const sourceOccurredAt = exactFlapIso(value.sourceOccurredAt);
  const firstObservedAt = exactFlapIso(value.firstObservedAt);
  const recoveredAt = exactFlapIso(value.recoveredAt);
  return sourceOccurredAt === blockTimestamp
    && recoveredAt === observedAt
    && firstObservedAt !== null
    && sourceOccurredAt <= firstObservedAt
    && firstObservedAt <= recoveredAt
    && Number.isSafeInteger(value.lagMs)
    && value.lagMs === recoveredAt - sourceOccurredAt
    && value.lagMs > FLAP_DELAYED_RECOVERY_MIN_LAG_MS
    && source.observedAt === value.recoveredAt;
}

function validFlapTrackedTokenCanonicalRevision(value, {
  generationKey,
  ordinal,
  baseEventKey,
  blockHash,
} = {}) {
  const keys = new Set([
    "version", "reason", "ordinal", "replacesEventKey", "replacesBlockHash",
    "replacesTokenAddress",
  ]);
  const priorPrefix = `bsc-flap-pool-token:${generationKey}:${ordinal}:`;
  const priorIdentity = typeof value?.replacesEventKey === "string"
    ? /^(0x[a-f0-9]{64}):(\d+):(0x[a-f0-9]{40})(?::canonical-revision:(0x[a-f0-9]{64}))?$/.exec(
      value.replacesEventKey.slice(priorPrefix.length),
    )
    : null;
  if (!exactFlapKeys(value, keys, [...keys])
    || value.version !== 1
    || value.reason !== "token_created_reorg"
    || value.ordinal !== ordinal
    || typeof value.replacesEventKey !== "string"
    || !value.replacesEventKey.startsWith(priorPrefix)
    || !priorIdentity
    || priorIdentity[2] !== String(Number(priorIdentity[2]))
    || value.replacesEventKey === `${baseEventKey}:canonical-revision:${blockHash}`
    || !/^0x[a-f0-9]{64}$/.test(value.replacesBlockHash)
    || value.replacesBlockHash === blockHash
    || !/^0x[a-f0-9]{40}$/.test(value.replacesTokenAddress)
    || priorIdentity[3] !== value.replacesTokenAddress
    || (priorIdentity[4] && priorIdentity[4] !== value.replacesBlockHash)) return false;
  return true;
}

// The first-three lane is a narrow monitor-only exception to focus3's broad
// stock/RWA exclusion.  A display name, ticker, or generic BSC launch event is
// never sufficient: the producer must bind one TokenCreated log, one verified
// DEX pair, and one exact Portal activation generation all the way through.
export function isStrictFlapTrackedPoolTokenUpdate(source) {
  if (!exactFlapKeys(source, FLAP_TRACKED_TOKEN_EVENT_KEYS, [
    "type", "kind", "eventKey", "chainId", "launcher", "platform", "featurePlatform",
    "featureActivationKey", "featureGenerationKey", "featureTrackedToken", "featureTokenOrdinal",
    "featureTokenTarget", "featureFirstToken", "informationalOnly", "autoTradeEligible",
    "automaticExecution", "strong", "launchCount", "uniqueTokens", "transactionHash",
    "blockNumber", "blockHash", "blockTimestamp", "transactionIndex", "logIndex", "tokens",
    "pools", "mode", "structural", "security", "featureTokenProof", "launchEvidence",
    "sourceUrl", "activationSourceUrl", "explorerUrl", "launcherUrl", "observedAt",
  ])) return false;

  const tokenEntry = Array.isArray(source.tokens) && source.tokens.length === 1 ? source.tokens[0] : null;
  const pool = Array.isArray(source.pools) && source.pools.length === 1 ? source.pools[0] : null;
  const proof = source.featureTokenProof;
  const mode = source.mode;
  const ordinal = Number(source.featureTokenOrdinal);
  const tokenAddress = String(tokenEntry?.token || "").toLowerCase();
  const quoteAddress = String(mode?.quoteAsset || "").toLowerCase();
  const transactionHash = String(source.transactionHash || "").toLowerCase();
  const blockHash = String(source.blockHash || "").toLowerCase();
  const blockNumber = Number(source.blockNumber);
  const transactionIndex = Number(source.transactionIndex);
  const logIndex = Number(source.logIndex);
  const generationKey = String(source.featureGenerationKey || "");
  const generation = /^quote:(0x[a-f0-9]{40}):generation:(0x[a-f0-9]{64}):(0x[a-f0-9]{64}):(\d+)$/.exec(generationKey);
  const blockTimestamp = exactFlapIso(source.blockTimestamp);
  const observedAt = exactFlapIso(source.observedAt);
  if (source.type !== "bsc_launchpad_update"
    || source.kind !== FLAP_TRACKED_TOKEN_KIND
    || source.chainId !== FLAP_BSC_CHAIN_ID
    || String(source.launcher || "").toLowerCase() !== FLAP_TRACKED_TOKEN_PORTAL
    || source.featurePlatform !== "flap"
    || source.featureActivationKey !== generationKey
    || !generation
    || generation[1] !== quoteAddress
    || !Number.isSafeInteger(Number(generation[4]))
    || source.featureTrackedToken !== true
    || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > FLAP_TRACKED_TOKEN_TARGET
    || source.featureTokenOrdinal !== ordinal
    || source.featureTokenTarget !== FLAP_TRACKED_TOKEN_TARGET
    || source.featureFirstToken !== (ordinal === 1)
    || source.informationalOnly !== true
    || source.autoTradeEligible !== false
    || source.automaticExecution !== false
    || source.strong !== true
    || source.launchCount !== ordinal
    || source.uniqueTokens !== ordinal
    || !/^0x[a-f0-9]{40}$/.test(tokenAddress)
    || !/^0x[a-f0-9]{64}$/.test(transactionHash)
    || !/^0x[a-f0-9]{64}$/.test(blockHash)
    || source.transactionHash !== transactionHash
    || source.blockHash !== blockHash
    || !Number.isSafeInteger(blockNumber) || blockNumber <= 0
    || source.blockNumber !== blockNumber
    || !Number.isSafeInteger(transactionIndex) || transactionIndex < 0
    || source.transactionIndex !== transactionIndex
    || !Number.isSafeInteger(logIndex) || logIndex < 0
    || source.logIndex !== logIndex
    || generation[4] !== String(Number(generation[4]))
    || blockTimestamp === null
    || observedAt === null
    || observedAt < blockTimestamp
    || !validFlapTrackedTokenPlatform(source.platform)
    || !validFlapTrackedTokenSecurity(source.security)
    || !validFlapTrackedTokenDerivedFields(source)) return false;

  const candidateKey = `${transactionHash}:${logIndex}:${tokenAddress}`;
  const baseEventKey = `bsc-flap-pool-token:${generationKey}:${ordinal}:${candidateKey}`;
  const canonicalRevision = Object.hasOwn(source, "canonicalRevision");
  const expectedEventKey = canonicalRevision
    ? `${baseEventKey}:canonical-revision:${blockHash}`
    : baseEventKey;
  if (source.eventKey !== expectedEventKey
    || (canonicalRevision && !validFlapTrackedTokenCanonicalRevision(source.canonicalRevision, {
      generationKey,
      ordinal,
      baseEventKey,
      blockHash,
    }))
    || source.sourceUrl !== `https://bscscan.com/tx/${transactionHash}`
    || source.explorerUrl !== source.sourceUrl
    || source.activationSourceUrl !== `https://bscscan.com/tx/${generation[3]}`
    || source.launcherUrl !== `https://bscscan.com/address/${FLAP_TRACKED_TOKEN_PORTAL}`) return false;

  const platformKeys = new Set(["token", "isNewContract", "metadata"]);
  if (!exactFlapKeys(tokenEntry, platformKeys, [...platformKeys])
    || tokenEntry.token !== tokenAddress
    || tokenEntry.isNewContract !== true
    || !validFlapTrackedTokenMetadata(tokenEntry.metadata)) return false;

  const poolKeys = new Set(["kind", "factory", "token0", "token1", "pool", "poolId", "hook", "verifiedDex", "fee"]);
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const poolKind = FLAP_TRACKED_TOKEN_DEX_FACTORIES.get(pool?.factory);
  const v3Pool = poolKind === "v3";
  if (!exactFlapKeys(pool, poolKeys, ["kind", "factory", "token0", "token1", "pool", "poolId", "hook", "verifiedDex"])
    || typeof pool.kind !== "string" || !pool.kind.trim() || pool.kind.length > 64
    || !/^0x[a-f0-9]{40}$/.test(String(pool.pool || ""))
    || !/^0x[a-f0-9]{40}$/.test(String(pool.factory || ""))
    || poolKind !== pool.kind
    || [tokenAddress, quoteAddress, pool.pool, pool.factory].includes(zeroAddress)
    || tokenAddress === quoteAddress
    || pool.pool === tokenAddress
    || pool.pool === quoteAddress
    || pool.verifiedDex !== true
    || !((pool.token0 === tokenAddress && pool.token1 === quoteAddress)
      || (pool.token1 === tokenAddress && pool.token0 === quoteAddress))
    || pool.poolId !== null
    || pool.hook !== null
    || Object.hasOwn(pool, "fee") !== v3Pool
    || (v3Pool && (!Number.isSafeInteger(pool.fee) || pool.fee < 0 || pool.fee > 0xffffff))) return false;

  const modeKeys = new Set([
    "fingerprint", "selector", "creationTopics", "customTopics", "quoteAsset", "quoteName",
    "quoteSymbol", "componentMode", "componentModeAlertEligible", "featureActivationEligible",
    "monitorOnly",
  ]);
  const expectedFingerprint = createHash("sha256")
    .update(JSON.stringify({ generationKey, quoteAddress }))
    .digest("hex")
    .slice(0, 20);
  if (!exactFlapKeys(mode, modeKeys, [...modeKeys])
    || mode.fingerprint !== expectedFingerprint
    || mode.selector !== "official-portal-token-created"
    || !sameFlapValue(mode.creationTopics, [FLAP_TRACKED_TOKEN_CREATED_TOPIC])
    || !sameFlapValue(mode.customTopics, [FLAP_TRACKED_TOKEN_CREATED_TOPIC])
    || mode.quoteAsset !== quoteAddress
    || !validFlapMetadataText(mode.quoteName, 256)
    || !validFlapDirectQuoteSymbol(mode.quoteSymbol)
    || mode.componentMode !== `Flap ${mode.quoteSymbol} 新底池`
    || mode.componentModeAlertEligible !== true
    || mode.featureActivationEligible !== true
    || mode.monitorOnly !== true) return false;

  const structuralKeys = new Set(["eligible", "mechanismEvidence", "causalTokenEvent", "controllerKind", "source"]);
  if (!exactFlapKeys(source.structural, structuralKeys, [...structuralKeys])
    || source.structural.eligible !== true
    || source.structural.mechanismEvidence !== true
    || source.structural.causalTokenEvent !== true
    || source.structural.controllerKind !== "official_direct"
    || source.structural.source !== "verified_flap_portal_receipt") return false;

  const proofKeys = new Set([
    "version", "activationId", "activationEventKey", "quoteAddress", "tokenAddress", "portal",
    "tokenCreatedTopic", "transactionHash", "blockNumber", "blockHash", "transactionIndex",
    "logIndex", "canonical", "confirmations", "requiredConfirmations", "pairAddress", "pairKind",
  ]);
  if (!exactFlapKeys(proof, proofKeys, [...proofKeys])
    || proof.version !== 1
    || proof.activationId !== generationKey
    || proof.activationEventKey !== `flap-quote:${FLAP_BSC_CHAIN_ID}:${generation[3]}:${generation[4]}`
    || proof.quoteAddress !== quoteAddress
    || proof.tokenAddress !== tokenAddress
    || proof.portal !== FLAP_TRACKED_TOKEN_PORTAL
    || proof.tokenCreatedTopic !== FLAP_TRACKED_TOKEN_CREATED_TOPIC
    || proof.transactionHash !== transactionHash
    || proof.blockNumber !== blockNumber
    || proof.blockHash !== blockHash
    || proof.transactionIndex !== transactionIndex
    || proof.logIndex !== logIndex
    || proof.canonical !== true
    || !Number.isSafeInteger(proof.confirmations)
    || !Number.isSafeInteger(proof.requiredConfirmations)
    || proof.requiredConfirmations < 0
    || proof.confirmations < proof.requiredConfirmations
    || proof.pairAddress !== pool.pool
    || proof.pairKind !== pool.kind) return false;

  const launchEvidenceKeys = new Set(["emitter", "topic", "token"]);
  const launchEvidence = Array.isArray(source.launchEvidence) && source.launchEvidence.length === 1
    ? source.launchEvidence[0] : null;
  if (!exactFlapKeys(launchEvidence, launchEvidenceKeys, [...launchEvidenceKeys])
    || launchEvidence.emitter !== FLAP_TRACKED_TOKEN_PORTAL
    || launchEvidence.topic !== FLAP_TRACKED_TOKEN_CREATED_TOPIC
    || launchEvidence.token !== tokenAddress) return false;

  const sourceLagMs = observedAt - blockTimestamp;
  if (Object.hasOwn(source, "delayedRecovery")) {
    if (!validFlapTrackedTokenRecovery(source.delayedRecovery, source, blockTimestamp, observedAt)) return false;
  } else if (sourceLagMs > FLAP_DELAYED_RECOVERY_MIN_LAG_MS) return false;
  return true;
}

function validFlapDirectEvidence(value, source, asset) {
  const keys = new Set([
    "chainId", "portal", "portalRuntimeCodeHash", "portalVersion", "portalImplementation",
    "portalImplementationCodeHash", "eventSignature", "topic0", "logIndex", "logData",
    "eventConfiguration", "finalizedConfiguration", "configurationVerifiedAtBlock",
    "metadataVerifiedAtBlock", "metadataCodeHash", "receiptVerified", "transactionVerified",
    "canonicalBlockVerified", "confirmations", "requiredConfirmations", "finalizedHead", "finalizedHeadHash",
  ]);
  return exactFlapKeys(value, keys, [...keys])
    && value.chainId === FLAP_BSC_CHAIN_ID
    && value.portal === FLAP_BSC_QUOTE_PORTAL
    && value.portalRuntimeCodeHash === FLAP_QUOTE_PORTAL_RUNTIME_HASH
    && value.portalVersion === FLAP_QUOTE_PORTAL_VERSION
    && value.portalImplementation === FLAP_QUOTE_PORTAL_IMPLEMENTATION
    && value.portalImplementationCodeHash === FLAP_QUOTE_PORTAL_IMPLEMENTATION_HASH
    && value.eventSignature === FLAP_QUOTE_CONFIGURATION_SIGNATURE
    && value.topic0 === FLAP_QUOTE_CONFIGURATION_TOPIC
    && value.logIndex === source.logIndex
    && validFlapQuoteConfiguration(value.eventConfiguration)
    && String(value.logData || "").toLowerCase() === expectedFlapQuoteConfigurationLogData(asset, value.eventConfiguration)
    && sameFlapValue(value.finalizedConfiguration, asset.configuration)
    && value.configurationVerifiedAtBlock === asset.verifiedAtBlock
    && value.metadataVerifiedAtBlock === asset.verifiedAtBlock
    && value.metadataCodeHash === asset.codeHash
    && value.receiptVerified === true
    && value.transactionVerified === true
    && value.canonicalBlockVerified === true
    && Number.isSafeInteger(value.confirmations)
    && Number.isSafeInteger(value.requiredConfirmations)
    && value.requiredConfirmations >= 0
    && value.confirmations >= value.requiredConfirmations
    && value.finalizedHead === asset.verifiedAtBlock
    && value.finalizedHead >= source.blockNumber
    && value.confirmations === value.finalizedHead + value.requiredConfirmations - source.blockNumber
    && value.finalizedHeadHash === asset.verifiedAtBlockHash;
}

function validFlapDirectOrphanKeys(value) {
  if (!Array.isArray(value) || value.length > 5_000 || new Set(value).size !== value.length) return false;
  return value.every((key) => {
    if (typeof key !== "string" || key.length > 180) return false;
    const match = key.match(/^flap-quote:56:0x[a-f0-9]{64}:(0|[1-9]\d*)$/);
    return Boolean(match && Number.isSafeInteger(Number(match[1])));
  });
}

function validFlapDirectDelayedRecovery(source, originalEventKey, firstObservedAfterGap = false) {
  const recovery = source?.delayedRecovery;
  const cursor = recovery?.cursor;
  const recoveryKeys = new Set([
    "version", "reason", "sourceOccurredAt", "originalBlockNumber", "originalBlockHash",
    "originalTransactionHash", "originalLogIndex", "recoveredAt", "lagMs", "cursor",
  ]);
  const cursorKeys = new Set(["nextBlockAtRecovery", "eventBlock"]);
  if (!exactFlapKeys(recovery, recoveryKeys, [...recoveryKeys])
    || !exactFlapKeys(cursor, cursorKeys, [...cursorKeys])
    || recovery.version !== FLAP_DELAYED_RECOVERY_VERSION
    || recovery.reason !== (firstObservedAfterGap ? FLAP_FIRST_OBSERVED_REASON : FLAP_DELAYED_RECOVERY_REASON)
    || source?.originalEventKey !== originalEventKey
    || source?.eventKey !== `${originalEventKey}:${firstObservedAfterGap ? "first-observed-after-gap" : "delayed-recovery"}:v1`
    || recovery.sourceOccurredAt !== source?.occurredAt
    || recovery.originalBlockNumber !== source?.blockNumber
    || recovery.originalBlockHash !== source?.blockHash
    || recovery.originalTransactionHash !== source?.transactionHash
    || recovery.originalLogIndex !== source?.logIndex
    || recovery.recoveredAt !== source?.observedAt
    || !Number.isSafeInteger(recovery.lagMs)
    || recovery.lagMs <= FLAP_DELAYED_RECOVERY_MIN_LAG_MS
    || !Number.isSafeInteger(cursor.nextBlockAtRecovery)
    || cursor.nextBlockAtRecovery <= 0
    || !Number.isSafeInteger(cursor.eventBlock)
    || cursor.eventBlock !== recovery.originalBlockNumber) return false;
  const sourceOccurredAt = exactFlapIso(recovery.sourceOccurredAt);
  const recoveredAt = exactFlapIso(recovery.recoveredAt);
  return sourceOccurredAt !== null
    && recoveredAt !== null
    && recoveredAt >= sourceOccurredAt
    && recovery.lagMs === recoveredAt - sourceOccurredAt;
}

function validFlapFirstObservedPriorState(source) {
  const value = source?.priorStateRead;
  const keys = new Set([
    "blockNumber", "method", "requiredIndependentReaders", "successfulReaders",
    "matchingUnavailableReaders", "failureClass",
  ]);
  return source?.priorTransitionProof === "unavailable"
    && exactFlapKeys(value, keys, [...keys])
    && Number.isSafeInteger(value.blockNumber)
    && value.blockNumber === source.blockNumber - 1
    && value.method === "getQuoteTokenConfiguration(address)"
    && value.requiredIndependentReaders === 2
    && [0, 1].includes(value.successfulReaders)
    && value.matchingUnavailableReaders === 2 - value.successfulReaders
    && value.failureClass === "archive_state_unavailable";
}

function validFlapDirectCanonicalIdentity(source, asset) {
  const stage = source?.kind === FLAP_FIRST_OBSERVED_KIND ? "observed" : "live";
  const expected = `flap:quote-pair:${flapDirectQuoteSymbolSlug(asset.quoteSymbol)}:ca:${asset.quoteAddress}:${stage}`;
  return source.canonicalSignalId === expected
    && Array.isArray(source.canonicalSignalIds)
    && source.canonicalSignalIds.length === 1
    && source.canonicalSignalIds[0] === expected;
}

function validFlapDirectFreshness(source) {
  const value = source?.freshness;
  const baseKeys = new Set([
    "version", "scope", "basis", "sourceOccurredAt", "discoveredAt", "lagMs",
    "sourceTimeReliable", "realtimeMaxAgeMs", "telegramMaxAgeMs", "decision", "reason",
  ]);
  const deliveryKeys = ["deliveryEvaluatedAt", "deliveryLagMs", "deliveryDecision"];
  const hasDelivery = deliveryKeys.some((key) => Object.hasOwn(value || {}, key));
  const allowed = new Set([...baseKeys, ...(hasDelivery ? deliveryKeys : [])]);
  if (!exactFlapKeys(value, allowed, [...allowed])
    || value.version !== 1
    || value.scope !== (source?.kind === FLAP_FIRST_OBSERVED_KIND
      ? "flap_first_observed_after_gap"
      : "flap_delayed_recovery")
    || value.basis !== "delayedRecovery.recoveredAt_continuous_recovery"
    || value.sourceOccurredAt !== source?.delayedRecovery?.recoveredAt
    || value.sourceTimeReliable !== true
    || !Number.isSafeInteger(value.realtimeMaxAgeMs)
    || value.realtimeMaxAgeMs < 0
    || !Number.isSafeInteger(value.telegramMaxAgeMs)
    || value.telegramMaxAgeMs < value.realtimeMaxAgeMs) return false;
  const sourceAt = exactFlapIso(value.sourceOccurredAt);
  const discoveredAt = exactFlapIso(value.discoveredAt);
  if (sourceAt === null || discoveredAt === null || discoveredAt < sourceAt
    || value.lagMs !== discoveredAt - sourceAt) return false;
  const expectedDecision = value.lagMs <= value.realtimeMaxAgeMs
    ? "realtime"
    : value.lagMs <= value.telegramMaxAgeMs ? "late" : "suppress";
  const expectedReason = expectedDecision === "realtime"
    ? "within_realtime_window"
    : expectedDecision === "late" ? "late_backfill_downgrade" : "too_old_for_telegram";
  if (value.decision !== expectedDecision || value.reason !== expectedReason) return false;
  if (!hasDelivery) return true;
  const deliveryAt = exactFlapIso(value.deliveryEvaluatedAt);
  if (deliveryAt === null || deliveryAt < sourceAt || value.deliveryLagMs !== deliveryAt - sourceAt) return false;
  const deliveryDecision = value.deliveryLagMs <= value.realtimeMaxAgeMs
    ? "realtime"
    : value.deliveryLagMs <= value.telegramMaxAgeMs ? "late" : "suppress";
  return value.deliveryDecision === deliveryDecision;
}

function validFlapDirectPriority(source, asset) {
  const value = source?.tradingPriority;
  const keys = new Set([
    "version", "schema", "deterministic", "tier", "rank", "label", "score", "components",
    "category", "target", "targets", "confirmation", "window", "hardGates", "lifecycle", "plan",
  ]);
  const expectedTier = source?.delayedRecovery ? "T2" : null;
  return exactFlapKeys(value, keys, [...keys])
    && value.version === 2
    && value.schema === "news_trading_priority_v2"
    && value.deterministic === true
    && ["T1", "T2"].includes(value.tier)
    && (!expectedTier || value.tier === expectedTier)
    && value.rank === ({ T1: 3, T2: 2 })[value.tier]
    && value.category === "focus_official"
    && exactFlapKeys(value.target, new Set(["type", "value", "exact"]), ["type", "value", "exact"])
    && value.target.type === "quote_asset"
    && value.target.value === asset.quoteSymbol
    && value.target.exact === true
    && Array.isArray(value.targets)
    && value.targets.length === 1
    && sameFlapValue(value.targets[0], value.target)
    && value.confirmation?.trusted === true
    && value.confirmation?.kind === "onchain"
    && value.confirmation?.value === `${source.transactionHash}#${source.blockNumber}`
    && value.plan?.automaticExecution === false;
}

function validFlapDirectDerivedFields(source, asset) {
  const present = [...FLAP_DIRECT_DERIVED_EVENT_KEYS].filter((key) => Object.hasOwn(source, key));
  if (!present.length) return true;
  const required = ["canonicalSignalId", "canonicalSignalIds", "tradingPriority", "alertQueuedAt"];
  if (source.delayedRecovery) required.push("freshness");
  if (present.length !== required.length || required.some((key) => !Object.hasOwn(source, key))) return false;
  return exactFlapIso(source.alertQueuedAt) !== null
    && validFlapDirectCanonicalIdentity(source, asset)
    && validFlapDirectPriority(source, asset)
    && (source.delayedRecovery ? validFlapDirectFreshness(source) : !Object.hasOwn(source, "freshness"));
}

export function isStrictFlapPortalQuoteAssetUpdate(source) {
  const firstObservedAfterGap = source?.kind === FLAP_FIRST_OBSERVED_KIND;
  const asset = firstObservedAfterGap
    ? source?.changes?.updatedFlapPools?.[0]
    : source?.changes?.newFlapPools?.[0];
  const transactionHash = source?.transactionHash;
  const blockNumber = source?.blockNumber;
  const blockHash = source?.blockHash;
  const logIndex = source?.logIndex;
  const receipt = source?.receiptProof;
  const transaction = source?.transactionProof;
  const block = source?.blockProof;
  const evidence = source?.onchainProof;
  const change = source?.changes?.newQuoteConfigs?.[0];
  const signalChange = source?.signal?.quotePairChange;
  const signalAsset = signalChange?.assets?.[0];
  const occurredAt = exactFlapIso(source?.occurredAt);
  const observedAt = exactFlapIso(source?.observedAt);
  const originalEventKey = `flap-quote:${FLAP_BSC_CHAIN_ID}:${transactionHash}:${logIndex}`;
  const recoveryFieldsPresent = [...FLAP_DIRECT_RECOVERY_EVENT_KEYS]
    .filter((key) => Object.hasOwn(source || {}, key));
  const firstObservedFieldsPresent = [...FLAP_DIRECT_FIRST_OBSERVED_EVENT_KEYS]
    .filter((key) => Object.hasOwn(source || {}, key));
  const derivedFieldsPresent = [...FLAP_DIRECT_DERIVED_EVENT_KEYS]
    .filter((key) => Object.hasOwn(source || {}, key));
  const allowedEventKeys = new Set([
    ...FLAP_DIRECT_EVENT_KEYS,
    ...(recoveryFieldsPresent.length ? FLAP_DIRECT_RECOVERY_EVENT_KEYS : []),
    ...(firstObservedAfterGap ? FLAP_DIRECT_FIRST_OBSERVED_EVENT_KEYS : []),
    ...derivedFieldsPresent,
  ]);
  if (!exactFlapKeys(source, allowedEventKeys, [...FLAP_DIRECT_EVENT_KEYS])
    || ![0, FLAP_DIRECT_RECOVERY_EVENT_KEYS.size].includes(recoveryFieldsPresent.length)
    || firstObservedFieldsPresent.length !== (firstObservedAfterGap ? FLAP_DIRECT_FIRST_OBSERVED_EVENT_KEYS.size : 0)
    || source.type !== "platform_capability_update"
    || !["flap_quote_asset_enabled", FLAP_FIRST_OBSERVED_KIND].includes(source?.kind)
    || source?.changeType !== (firstObservedAfterGap ? "observed" : "added")
    || !exactFlapKeys(source?.platform, FLAP_DIRECT_PLATFORM_KEYS, [...FLAP_DIRECT_PLATFORM_KEYS])
    || source.platform.id !== "flap"
    || source.platform.name !== "Flap"
    || source.platform.website !== "https://flap.sh"
    || source.platform.board !== FLAP_BOARD_URL
    || source?.chainId !== FLAP_BSC_CHAIN_ID
    || !exactFlapKeys(source?.chain, FLAP_DIRECT_CHAIN_KEYS, [...FLAP_DIRECT_CHAIN_KEYS])
    || source.chain.id !== FLAP_BSC_CHAIN_ID
    || source.chain.chainId !== FLAP_BSC_CHAIN_ID
    || source.chain.name !== "BNB Chain"
    || source.chain.environment !== "mainnet"
    || source?.portal !== FLAP_BSC_QUOTE_PORTAL
    || !exactFlapKeys(source?.source, new Set(["id", "name", "url", "docsUrl", "official", "trust"]), ["id", "name", "url", "docsUrl", "official", "trust"])
    || source.source.id !== FLAP_QUOTE_SOURCE_ID
    || source.source.name !== "Flap official Portal + Board"
    || source.source.url !== FLAP_BOARD_URL
    || source.source.docsUrl !== FLAP_QUOTE_DOCS_URL
    || source.source.official !== true
    || source.source.trust !== FLAP_QUOTE_SOURCE_TRUST
    || source?.sourceUrl !== FLAP_BOARD_URL
    || !/^0x[a-f0-9]{64}$/.test(String(transactionHash || ""))
    || !Number.isSafeInteger(blockNumber)
    || blockNumber <= 0
    || !/^0x[a-f0-9]{64}$/.test(String(blockHash || ""))
    || !Number.isSafeInteger(logIndex)
    || logIndex < 0
    || (recoveryFieldsPresent.length
      ? !validFlapDirectDelayedRecovery(source, originalEventKey, firstObservedAfterGap)
      : source.eventKey !== originalEventKey || observedAt - occurredAt > FLAP_DELAYED_RECOVERY_MIN_LAG_MS)
    || (firstObservedAfterGap
      && (recoveryFieldsPresent.length !== FLAP_DIRECT_RECOVERY_EVENT_KEYS.size
        || !validFlapFirstObservedPriorState(source)))
    || source?.url !== `https://bscscan.com/tx/${transactionHash}`
    || source?.explorerUrl !== source.url
    || occurredAt === null
    || observedAt === null
    || observedAt < occurredAt
    || source?.blockTimestamp !== source.occurredAt
    || !validFlapDirectOrphanKeys(source.reorgOrphanedEventKeys)
    || source.risk !== (firstObservedAfterGap ? FLAP_FIRST_OBSERVED_RISK : FLAP_QUOTE_RISK)
    || !validFlapDirectQuoteAsset(asset)
    || !validFlapDirectDerivedFields(source, asset)
    || !flapRecord(source?.changes)) return false;

  const changeKeys = new Set([
    "newFlapPools", "updatedFlapPools", "removedFlapPools", "flapPoolChanges",
    "newQuoteTokens", "newQuoteConfigs", "newContracts",
  ]);
  if (!exactFlapKeys(source.changes, changeKeys, [...changeKeys])
    || ![...changeKeys].every((key) => Array.isArray(source.changes[key]))
    || source.changes.newFlapPools.length !== (firstObservedAfterGap ? 0 : 1)
    || source.changes.updatedFlapPools.length !== (firstObservedAfterGap ? 1 : 0)
    || source.changes.removedFlapPools.length !== 0
    || source.changes.flapPoolChanges.length !== 0
    || !sameFlapValue(source.changes.newQuoteTokens, firstObservedAfterGap ? [] : [asset.quoteSymbol])
    || !sameFlapValue(source.changes.newContracts, firstObservedAfterGap ? [] : [asset.quoteAddress])
    || (!firstObservedAfterGap && source.changes.newQuoteConfigs.length !== 1)
    || (firstObservedAfterGap
      ? source.changes.newQuoteConfigs.length !== 0
      : !exactFlapKeys(change, new Set(["symbol", "address", "enabled", "enabledRaw", "defaultCurve", "alternativeCurve", "nativeToQuoteSwapType", "dexId"]), ["symbol", "address", "enabled", "enabledRaw", "defaultCurve", "alternativeCurve", "nativeToQuoteSwapType", "dexId"])
        || change.symbol !== asset.quoteSymbol
        || change.address !== asset.quoteAddress
        || !sameFlapValue({
          enabled: change.enabled,
          enabledRaw: change.enabledRaw,
          defaultCurve: change.defaultCurve,
          alternativeCurve: change.alternativeCurve,
          nativeToQuoteSwapType: change.nativeToQuoteSwapType,
          dexId: change.dexId,
        }, asset.configuration))) return false;

  if (!exactFlapKeys(receipt, new Set(["status", "transactionHash", "transactionIndex", "blockNumber", "blockHash", "logIndex", "logMatched"]), ["status", "transactionHash", "transactionIndex", "blockNumber", "blockHash", "logIndex", "logMatched"])
    || receipt.status !== 1
    || receipt.transactionHash !== transactionHash
    || !Number.isSafeInteger(receipt.transactionIndex)
    || receipt.transactionIndex < 0
    || receipt.blockNumber !== blockNumber
    || receipt.blockHash !== blockHash
    || receipt.logIndex !== logIndex
    || receipt.logMatched !== true
    || !exactFlapKeys(transaction, new Set(["hash", "from", "to", "nonce", "blockNumber", "blockHash"]), ["hash", "from", "to", "nonce", "blockNumber", "blockHash"])
    || transaction.hash !== transactionHash
    || !/^0x[a-fA-F0-9]{40}$/.test(String(transaction.from || ""))
    || !/^0x[a-fA-F0-9]{40}$/.test(String(transaction.to || ""))
    || !Number.isSafeInteger(transaction.nonce)
    || transaction.nonce < 0
    || transaction.blockNumber !== blockNumber
    || transaction.blockHash !== blockHash
    || !exactFlapKeys(block, new Set(["number", "hash", "timestamp", "canonical", "confirmations", "requiredConfirmations"]), ["number", "hash", "timestamp", "canonical", "confirmations", "requiredConfirmations"])
    || block.number !== blockNumber
    || block.hash !== blockHash
    || block.timestamp !== source.blockTimestamp
    || block.canonical !== true
    || !sameFlapValue(source.onchainProof, source.evidence)
    || !validFlapDirectEvidence(evidence, source, asset)
    || block.confirmations !== evidence.confirmations
    || block.requiredConfirmations !== evidence.requiredConfirmations) return false;

  const quotePairKeys = new Set(["stage", "assetClass", "assets"]);
  return source?.strong === !firstObservedAfterGap
    && exactFlapKeys(source?.signal, new Set(["strong", "platformStructural", "category", "headline", "quotePairChange"]), ["strong", "platformStructural", "category", "headline", "quotePairChange"])
    && source.signal.strong === !firstObservedAfterGap
    && source.signal.platformStructural === true
    && source.signal.category === (firstObservedAfterGap
      ? "Flap quote asset first observed after gap"
      : "Flap quote asset enabled")
    && source.signal.headline === (firstObservedAfterGap
      ? `Flap first observed ${asset.quoteSymbol} currently enabled after a monitoring gap`
      : `Flap enabled ${asset.quoteSymbol} as a BSC quote asset`)
    && exactFlapKeys(signalChange, quotePairKeys, [...quotePairKeys])
    && signalChange.stage === (firstObservedAfterGap ? "observed" : "live")
    && signalChange.assetClass === "quote_asset"
    && Array.isArray(signalChange.assets)
    && signalChange.assets.length === 1
    && exactFlapKeys(signalAsset, new Set(["symbol", "name", "address", "decimals"]), ["symbol", "name", "address", "decimals"])
    && sameFlapValue(signalAsset, {
      symbol: asset.quoteSymbol,
      name: asset.quoteName,
      address: asset.quoteAddress,
      decimals: asset.quoteDecimals,
    });
}

export function isStrictFlapQuoteAssetUpdate(source) {
  return flapRecord(source?.source) || source?.onchainProof != null
    ? isStrictFlapPortalQuoteAssetUpdate(source)
    : isStrictFlapBoardQuoteAssetUpdate(source);
}

function strictPonFunUrl(value, { xStatus = false } = {}) {
  const raw = typeof value === "string" ? value.trim() : "";
  const authority = raw.match(/^https:\/\/([^/?#]+)/i)?.[1] || "";
  if (/\:\d+$/.test(authority.replace(/^.*@/, ""))) return false;
  const url = parsedHttpsUrl(raw);
  if (!url || url.port || url.search || url.hash) return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "pon.fun") return PON_FUN_API_PATHS.has(url.pathname);
  if (host !== "x.com") return false;
  const segments = url.pathname.split("/").filter(Boolean);
  if (normalized(segments[0]) !== PON_FUN_X_HANDLE) return false;
  if (segments.length === 1) return true;
  return xStatus
    && segments.length === 3
    && normalized(segments[1]) === "status"
    && /^\d+$/.test(segments[2]);
}

function exactPonFunPlatform(platform) {
  const keys = new Set(["id", "name", "website", "twitter", "chainId", "model"]);
  return Boolean(platform
    && typeof platform === "object"
    && !Array.isArray(platform)
    && Object.keys(platform).length === keys.size
    && Object.keys(platform).every((key) => keys.has(key))
    && platform.id === "ponfun"
    && platform.name === "pon.fun"
    && platform.chainId === PON_FUN_CHAIN_ID
    && platform.website === "https://www.pon.fun/"
    && platform.twitter === "https://x.com/pondotfun"
    && platform.model === PON_FUN_PLATFORM_MODEL);
}

function strictPonFunExplorerUrl(value, transactionHash) {
  const url = parsedHttpsUrl(value);
  return Boolean(url
    && !url.port
    && !url.search
    && !url.hash
    && url.hostname.toLowerCase() === "robinhoodchain.blockscout.com"
    && url.pathname.toLowerCase() === `/tx/${String(transactionHash || "").toLowerCase()}`);
}

function validPonFunChainEvidence(event) {
  const evidenceKeys = new Set([
    "chainId", "factory", "factoryCodeHash", "topic0", "logIndex", "receiptVerified", "api",
  ]);
  return Object.keys(event?.evidence || {}).length === evidenceKeys.size
    && Object.keys(event.evidence).every((key) => evidenceKeys.has(key))
    && /^0x[a-f0-9]{64}$/i.test(String(event.transactionHash || ""))
    && Number.isSafeInteger(event.blockNumber)
    && event.blockNumber > 0
    && /^0x[a-f0-9]{64}$/i.test(String(event.blockHash || ""))
    && strictTelegramNewsInstant(event.blockTimestamp) !== null
    && Number.isSafeInteger(event.evidence?.logIndex)
    && event.evidence.logIndex >= 0
    && normalized(event.evidence?.topic0) === PON_FUN_KIND_TOPICS.get(event.kind)
    && event.evidence?.receiptVerified === true;
}

function ponFunRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactPonFunKeys(value, keys) {
  if (!ponFunRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function samePonFunValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => samePonFunValue(value, right[index]));
  }
  if (!ponFunRecord(left) || !ponFunRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && samePonFunValue(left[key], right[key]));
}

function validPonFunText(value, maximum) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value === value.replace(/\s+/g, " ").trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validPonFunTicker(value) {
  return validPonFunText(value, 24)
    && !new Set(["__proto__", "prototype", "constructor", "tostring", "valueof", "hasownproperty", "__definegetter__", "__definesetter__", "__lookupgetter__", "__lookupsetter__"]).has(value.toLowerCase());
}

function validPonFunAddress(value, { allowZero = false } = {}) {
  return typeof value === "string"
    && /^0x[a-f0-9]{40}$/i.test(value)
    && (allowZero || normalized(value) !== PON_FUN_ZERO_ADDRESS);
}

function samePonFunAddress(left, right) {
  return validPonFunAddress(left, { allowZero: true })
    && validPonFunAddress(right, { allowZero: true })
    && normalized(left) === normalized(right);
}

function validPonFunInteger(value, maximum = Number.MAX_SAFE_INTEGER, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function expectedPonFunChanges(previous, current) {
  const changes = {};
  for (const [key, after] of Object.entries(current || {})) {
    const before = previous?.[key] ?? null;
    if (!samePonFunValue(before, after)) changes[key] = { before, after };
  }
  return changes;
}

function exactPonFunChanges(changes, expected) {
  if (!ponFunRecord(changes) || !ponFunRecord(expected)) return false;
  const changeKeys = Object.keys(changes);
  const expectedKeys = Object.keys(expected);
  return changeKeys.length === expectedKeys.length
    && changeKeys.every((key) => exactPonFunKeys(changes[key], ["before", "after"])
      && Object.hasOwn(expected, key)
      && samePonFunValue(changes[key], expected[key]));
}

const PON_FUN_MARKET_KEYS = [
  "ticker", "symbol", "name", "coin", "vault", "curve", "creator", "creatorFeeBps",
  "createdAt", "stockToken", "poolFee", "graduated", "lpDeployed", "backingPct",
  "progressBps", "marketCap", "reserve", "vol24",
];
const PON_FUN_MARKET_CORE_KEYS = [
  "ticker", "symbol", "name", "coin", "vault", "curve", "creator", "creatorFeeBps", "createdAt",
];
const PON_FUN_MARKET_CREATION_KEYS = [
  "ticker", "symbol", "name", "coin", "vault", "curve", "creator", "creatorFeeBps",
];
const PON_FUN_LISTING_KEYS = ["ticker", "stockToken", "poolFee", "active"];
const PON_FUN_CURVE_KEYS = ["p0", "slope", "curveCap", "lpPoolFee", "maxSlippageBps", "autoAcquire"];
const PON_FUN_CONFIG_KEYS = ["oracle", "swapRouter", "positionManager", "protocolTreasury"];

function validPonFunMarket(market) {
  return exactPonFunKeys(market, PON_FUN_MARKET_KEYS)
    && validPonFunTicker(market.ticker)
    && validPonFunText(market.symbol, 32)
    && validPonFunText(market.name, 160)
    && ["coin", "vault", "curve", "creator", "stockToken"].every((key) => validPonFunAddress(market[key]))
    && validPonFunInteger(market.creatorFeeBps, 10_000)
    && validPonFunInteger(market.createdAt, Number.MAX_SAFE_INTEGER, 1)
    && validPonFunInteger(market.poolFee, 1_000_000)
    && typeof market.graduated === "boolean"
    && typeof market.lpDeployed === "boolean"
    && ["backingPct", "progressBps", "marketCap", "reserve", "vol24"]
      .every((key) => market[key] === null || (typeof market[key] === "number" && Number.isFinite(market[key])));
}

function validPonFunTrackedMarket(market) {
  if (!ponFunRecord(market)) return false;
  const metadataKeys = new Set(["baseline", "firstSeenAt", "lastSeenAt", "creationProof"]);
  const marketPart = Object.fromEntries(PON_FUN_MARKET_KEYS.map((key) => [key, market[key]]));
  if (!validPonFunMarket(marketPart)
    || Object.keys(market).some((key) => !PON_FUN_MARKET_KEYS.includes(key) && !metadataKeys.has(key))
    || (market.baseline !== undefined && market.baseline !== true)
    || (market.firstSeenAt !== undefined && strictTelegramNewsInstant(market.firstSeenAt) === null)
    || (market.lastSeenAt !== undefined && strictTelegramNewsInstant(market.lastSeenAt) === null)) return false;
  if (market.creationProof !== undefined) {
    const proof = market.creationProof;
    if (!exactPonFunKeys(proof, ["transactionHash", "blockNumber", "blockHash", "blockTimestamp", "logIndex", "topic0"])
      || !/^0x[a-f0-9]{64}$/i.test(String(proof.transactionHash || ""))
      || !validPonFunInteger(proof.blockNumber, Number.MAX_SAFE_INTEGER, 1)
      || !/^0x[a-f0-9]{64}$/i.test(String(proof.blockHash || ""))
      || strictTelegramNewsInstant(proof.blockTimestamp) === null
      || !validPonFunInteger(proof.logIndex)
      || normalized(proof.topic0) !== PON_FUN_KIND_TOPICS.get("market_created")) return false;
  }
  return market.baseline === true || ponFunRecord(market.creationProof);
}

function ponFunMarketCore(market) {
  return Object.fromEntries(PON_FUN_MARKET_CORE_KEYS.map((key) => [key, market[key]]));
}

function validPonFunMarketCreated(event) {
  const market = event.market;
  const creation = event.creation;
  return validPonFunMarket(market)
    && samePonFunValue(event.currentSnapshot, market)
    && exactPonFunKeys(creation, PON_FUN_MARKET_CREATION_KEYS)
    && samePonFunValue(creation, Object.fromEntries(PON_FUN_MARKET_CREATION_KEYS.map((key) => [key, market[key]])))
    && event.ticker === market.ticker
    && event.symbol === market.symbol
    && samePonFunAddress(event.token, market.coin)
    && samePonFunAddress(event.contractAddress, market.coin)
    && exactPonFunChanges(event.changes, { market: { before: null, after: ponFunMarketCore(market) } })
    && event.title === `pon.fun 新市场：${market.symbol} / ${market.ticker}`
    && event.summary === "A new pon.fun MarketCreated event matches the official markets API, token list and Factory getters.";
}

function validPonFunConfigSnapshot(snapshot) {
  return exactPonFunKeys(snapshot, PON_FUN_CONFIG_KEYS)
    && PON_FUN_CONFIG_KEYS.every((key) => validPonFunAddress(snapshot[key]));
}

function validPonFunCurveSnapshot(snapshot) {
  return exactPonFunKeys(snapshot, PON_FUN_CURVE_KEYS)
    && ["p0", "slope", "curveCap"].every((key) => typeof snapshot[key] === "string" && /^(?:0|[1-9]\d*)$/.test(snapshot[key]))
    && validPonFunInteger(snapshot.lpPoolFee, 1_000_000)
    && validPonFunInteger(snapshot.maxSlippageBps, 10_000)
    && typeof snapshot.autoAcquire === "boolean";
}

function validPonFunInfrastructureSnapshot(snapshot) {
  if (!ponFunRecord(snapshot)) return false;
  const addressKeys = new Set([
    "owner", "pendingOwner", "oracle", "usdg", "swapRouter", "positionManager",
    "protocolTreasury", "coinImpl", "vaultImpl", "curveImpl",
  ]);
  const integerKeys = new Set(["marketCount", "listingCount"]);
  const allowed = new Set([...addressKeys, ...integerKeys, "paused"]);
  return Object.keys(snapshot).length > 0
    && Object.keys(snapshot).every((key) => allowed.has(key))
    && [...addressKeys].every((key) => !Object.hasOwn(snapshot, key)
      || validPonFunAddress(snapshot[key], { allowZero: true }))
    && [...integerKeys].every((key) => !Object.hasOwn(snapshot, key) || validPonFunInteger(snapshot[key]))
    && (!Object.hasOwn(snapshot, "paused") || typeof snapshot.paused === "boolean");
}

function validPonFunListingSnapshot(snapshot) {
  return exactPonFunKeys(snapshot, PON_FUN_LISTING_KEYS)
    && validPonFunTicker(snapshot.ticker)
    && validPonFunAddress(snapshot.stockToken, { allowZero: snapshot.active === false })
    && validPonFunInteger(snapshot.poolFee, 1_000_000)
    && typeof snapshot.active === "boolean";
}

function validPonFunFactoryConfig(event) {
  return (event.previousSnapshot === null || validPonFunInfrastructureSnapshot(event.previousSnapshot))
    && validPonFunConfigSnapshot(event.currentSnapshot)
    && exactPonFunChanges(event.changes, expectedPonFunChanges(event.previousSnapshot, event.currentSnapshot))
    && event.title === "pon.fun Factory 配置更新"
    && event.summary === "Factory emitted ConfigSet; oracle/router/position manager/treasury values are shown exactly.";
}

function validPonFunCurveParams(event) {
  return (event.previousSnapshot === null || validPonFunCurveSnapshot(event.previousSnapshot))
    && validPonFunCurveSnapshot(event.currentSnapshot)
    && exactPonFunChanges(event.changes, expectedPonFunChanges(event.previousSnapshot, event.currentSnapshot))
    && event.title === "pon.fun 曲线参数更新"
    && event.summary === "Factory emitted CurveParamsSet; launch pricing and LP parameters changed.";
}

function validPonFunStockListing(event) {
  const current = event.currentSnapshot;
  return (event.previousSnapshot === null || validPonFunListingSnapshot(event.previousSnapshot))
    && validPonFunListingSnapshot(current)
    && event.ticker === current.ticker
    && samePonFunAddress(event.contractAddress, current.stockToken)
    && exactPonFunChanges(event.changes, expectedPonFunChanges(event.previousSnapshot, current))
    && event.title === `pon.fun 股票映射更新：${current.ticker}`
    && event.summary === "Factory emitted StockListed for a stock-token oracle mapping.";
}

function validPonFunPause(event) {
  const paused = event.kind === "factory_paused";
  const previous = event.previousSnapshot;
  const current = event.currentSnapshot;
  return exactPonFunKeys(previous, ["paused"])
    && (typeof previous.paused === "boolean" || previous.paused === null)
    && exactPonFunKeys(current, ["paused", "account"])
    && current.paused === paused
    && validPonFunAddress(current.account)
    && exactPonFunChanges(event.changes, { paused: { before: previous.paused, after: paused } })
    && event.title === `pon.fun Factory ${paused ? "已暂停" : "已恢复"}`
    && event.summary === `Factory emitted ${paused ? "Paused" : "Unpaused"}; ${paused ? "new launches may be unavailable" : "factory operations were unpaused"}.`;
}

function validPonFunOwnership(event) {
  const previous = event.previousSnapshot;
  const current = event.currentSnapshot;
  if (!exactPonFunKeys(previous, ["owner", "pendingOwner"])
    || !exactPonFunKeys(current, ["owner", "pendingOwner"])
    || ![previous.owner, previous.pendingOwner, current.owner, current.pendingOwner]
      .every((value) => validPonFunAddress(value, { allowZero: true }))) return false;
  if (event.kind === "ownership_transfer_started") {
    return samePonFunAddress(previous.owner, current.owner)
      && normalized(current.pendingOwner) !== PON_FUN_ZERO_ADDRESS
      && exactPonFunChanges(event.changes, {
        pendingOwner: { before: previous.pendingOwner, after: current.pendingOwner },
      })
      && event.title === "pon.fun Factory 所有权转移已发起"
      && event.summary === "Factory emitted OwnershipTransferStarted; a pending admin authority was nominated.";
  }
  return normalized(current.owner) !== PON_FUN_ZERO_ADDRESS
    && normalized(current.pendingOwner) === PON_FUN_ZERO_ADDRESS
    && exactPonFunChanges(event.changes, {
      owner: { before: previous.owner, after: current.owner },
      pendingOwner: { before: previous.pendingOwner, after: current.pendingOwner },
    })
    && event.title === "pon.fun Factory 所有权已转移"
    && event.summary === "Factory emitted OwnershipTransferred; admin authority changed and the pending owner was cleared.";
}

function validPonFunChainSemantics(event) {
  if (event.kind === "market_created") return validPonFunMarketCreated(event);
  if (event.kind === "factory_config") return validPonFunFactoryConfig(event);
  if (event.kind === "curve_params") return validPonFunCurveParams(event);
  if (event.kind === "stock_listing") return validPonFunStockListing(event);
  if (event.kind === "factory_paused" || event.kind === "factory_unpaused") return validPonFunPause(event);
  return validPonFunOwnership(event);
}

function validPonFunApiEvidence(api, kind) {
  if (!api || typeof api !== "object" || Array.isArray(api)) return false;
  if (api.healthUrl !== "https://www.pon.fun/api/health") return false;
  if (kind === "platform_token_update") {
    return Object.keys(api).length === 2
      && Object.keys(api).every((key) => ["healthUrl", "platformTokenUrl"].includes(key))
      && api.platformTokenUrl === "https://www.pon.fun/api/ponfun";
  }
  return Object.keys(api).length === 3
    && Object.keys(api).every((key) => ["healthUrl", "marketsUrl", "tokenListUrl"].includes(key))
    && api.marketsUrl === "https://www.pon.fun/api/markets"
    && api.tokenListUrl === "https://www.pon.fun/tokenlist.json";
}

function exactPonFunSnapshotEventKey(event) {
  const token = normalized(event?.token);
  const evidence = event?.evidence;
  const revision = evidence?.transitionRevision;
  const apiHealthBlock = evidence?.apiHealthBlock;
  const bindingBlock = evidence?.bindingVerifiedAtBlock;
  if (!/^0x[a-f0-9]{40}$/.test(token)
    || !Number.isSafeInteger(revision) || revision <= 0
    || !Number.isSafeInteger(apiHealthBlock) || apiHealthBlock < 0
    || !Number.isSafeInteger(bindingBlock) || bindingBlock <= 0) return null;
  if (event.kind === "market_lifecycle") {
    return `pon-fun:market-lifecycle:${token}:rev:${revision}:api:${apiHealthBlock}:binding:${bindingBlock}`;
  }
  if (event.kind === "platform_token_update") {
    return `pon-fun:platform-token:${token}:rev:${revision}:api:${apiHealthBlock}:binding:${bindingBlock}`;
  }
  return null;
}

function validPonFunApiRevisionEvidence(event) {
  const evidence = event?.evidence;
  const expectedEvidenceKeys = event.kind === "platform_token_update"
    ? new Set([
        "chainId", "factory", "factoryCodeHash", "bindingVerifiedAtBlock",
        "bindingVerifiedAtBlockHash", "apiHealthBlock", "transitionRevision", "platformToken", "api",
      ])
    : new Set([
        "chainId", "factory", "factoryCodeHash", "bindingVerifiedAtBlock",
        "bindingVerifiedAtBlockHash", "apiHealthBlock", "transitionRevision", "api",
      ]);
  return Boolean(evidence
    && typeof evidence === "object"
    && !Array.isArray(evidence)
    && Object.keys(evidence).length === expectedEvidenceKeys.size
    && Object.keys(evidence).every((key) => expectedEvidenceKeys.has(key))
    && Number.isSafeInteger(evidence.bindingVerifiedAtBlock)
    && evidence.bindingVerifiedAtBlock > 0
    && /^0x[a-f0-9]{64}$/i.test(String(evidence.bindingVerifiedAtBlockHash || ""))
    && Number.isSafeInteger(evidence.apiHealthBlock)
    && evidence.apiHealthBlock > 0
    && Number.isSafeInteger(evidence.transitionRevision)
    && evidence.transitionRevision > 0
    && event.eventKey === exactPonFunSnapshotEventKey(event));
}

function exactDecimalSupplyRaw(value, decimals) {
  const source = String(value ?? "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(source)) return null;
  const [whole, fraction = ""] = source.split(".");
  if (fraction.length > decimals) return null;
  try { return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`).toString(); }
  catch { return null; }
}

function validPonFunPlatformTokenProof(event) {
  const proof = event?.evidence?.platformToken;
  const current = event?.currentSnapshot;
  const allowed = new Set([
    "token", "codePresent", "codeHash", "name", "symbol", "decimals",
    "totalSupplyRaw", "verifiedBlock", "verifiedBlockHash",
  ]);
  if (!proof || typeof proof !== "object" || Array.isArray(proof)
    || Object.keys(proof).length !== allowed.size
    || Object.keys(proof).some((key) => !allowed.has(key))
    || normalized(event?.token) !== PON_FUN_PLATFORM_TOKEN
    || normalized(event?.contractAddress) !== PON_FUN_PLATFORM_TOKEN
    || normalized(current?.address) !== PON_FUN_PLATFORM_TOKEN
    || normalized(proof.token) !== PON_FUN_PLATFORM_TOKEN
    || proof.codePresent !== true
    || !/^0x[a-f0-9]{64}$/i.test(String(proof.codeHash || ""))
    || typeof proof.name !== "string" || proof.name !== current?.name
    || typeof proof.symbol !== "string" || proof.symbol !== current?.symbol
    || !Number.isSafeInteger(proof.decimals)
    || proof.decimals < 0 || proof.decimals > 255
    || typeof proof.totalSupplyRaw !== "string"
    || !/^(?:0|[1-9]\d*)$/.test(proof.totalSupplyRaw)
    || !Number.isSafeInteger(proof.verifiedBlock)
    || proof.verifiedBlock !== event.evidence.bindingVerifiedAtBlock
    || !/^0x[a-f0-9]{64}$/i.test(String(proof.verifiedBlockHash || ""))
    || String(proof.verifiedBlockHash).toLowerCase() !== String(event.evidence.bindingVerifiedAtBlockHash).toLowerCase()) return false;
  return exactDecimalSupplyRaw(current?.supply, proof.decimals) === String(proof.totalSupplyRaw);
}

function validPonFunLifecycleChanges(event) {
  const allowed = new Set(["graduated", "lpDeployed", "stockToken", "poolFee"]);
  const changes = event?.changes;
  const previous = event?.previousSnapshot;
  const current = event?.currentSnapshot;
  if (!ponFunRecord(changes) || Object.keys(changes).length === 0
    || Object.keys(changes).some((key) => !allowed.has(key))) return false;
  const expected = {};
  for (const key of allowed) {
    if (!samePonFunValue(previous[key], current[key])) {
      expected[key] = { before: previous[key], after: current[key] };
    }
  }
  return exactPonFunChanges(changes, expected);
}

function validPonFunMarketLifecycle(event) {
  const previous = event.previousSnapshot;
  const current = event.currentSnapshot;
  return validPonFunTrackedMarket(previous)
    && validPonFunMarket(current)
    && samePonFunValue(event.market, current)
    && event.ticker === current.ticker
    && event.symbol === current.symbol
    && samePonFunAddress(event.token, current.coin)
    && samePonFunAddress(event.contractAddress, current.coin)
    && validPonFunLifecycleChanges(event)
    && event.title === `pon.fun 市场状态更新：${current.symbol}`
    && event.summary === "The official market lifecycle changed after its Factory identity was re-verified on-chain.";
}

function validPonFunPlatformSnapshot(snapshot) {
  if (!exactPonFunKeys(snapshot, ["address", "symbol", "name", "supply"])
    || normalized(snapshot.address) !== PON_FUN_PLATFORM_TOKEN
    || snapshot.symbol !== "PONFUN"
    || snapshot.name !== "Ponfun"
    || typeof snapshot.supply !== "string"
    || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(snapshot.supply)) return false;
  const digits = snapshot.supply.replace(".", "");
  try { return BigInt(digits) > 0n; }
  catch { return false; }
}

function validPonFunPlatformTokenUpdate(event) {
  return validPonFunPlatformSnapshot(event.previousSnapshot)
    && validPonFunPlatformSnapshot(event.currentSnapshot)
    && samePonFunAddress(event.token, PON_FUN_PLATFORM_TOKEN)
    && samePonFunAddress(event.contractAddress, PON_FUN_PLATFORM_TOKEN)
    && event.symbol === event.currentSnapshot.symbol
    && exactPonFunChanges(event.changes, expectedPonFunChanges(event.previousSnapshot, event.currentSnapshot))
    && Object.keys(event.changes).length > 0
    && event.title === "pon.fun 平台代币资料更新"
    && event.summary === "The official PONFUN token metadata changed while the platform Factory identity remained verified.";
}

function ponFunChainDisplay(event) {
  if (event.kind === "factory_config") return {
    title: "pon.fun Factory 配置更新",
    summary: "Factory emitted ConfigSet; oracle/router/position manager/treasury values are shown exactly.",
  };
  if (event.kind === "curve_params") return {
    title: "pon.fun 曲线参数更新",
    summary: "Factory emitted CurveParamsSet; launch pricing and LP parameters changed.",
  };
  if (event.kind === "stock_listing") return {
    title: `pon.fun 股票映射更新：${event.currentSnapshot?.ticker || ""}`,
    summary: "Factory emitted StockListed for a stock-token oracle mapping.",
  };
  if (event.kind === "factory_paused" || event.kind === "factory_unpaused") {
    const paused = event.kind === "factory_paused";
    return {
      title: `pon.fun Factory ${paused ? "已暂停" : "已恢复"}`,
      summary: `Factory emitted ${paused ? "Paused" : "Unpaused"}; ${paused ? "new launches may be unavailable" : "factory operations were unpaused"}.`,
    };
  }
  if (event.kind === "ownership_transfer_started") return {
    title: "pon.fun Factory 所有权转移已发起",
    summary: "Factory emitted OwnershipTransferStarted; a pending admin authority was nominated.",
  };
  if (event.kind === "ownership_transferred") return {
    title: "pon.fun Factory 所有权已转移",
    summary: "Factory emitted OwnershipTransferred; admin authority changed and the pending owner was cleared.",
  };
  return null;
}

const PON_FUN_BASE_EVENT_KEYS = [
  "type", "kind", "platform", "source", "sourceTrust", "chainId", "factory",
  "observedAt", "strong", "risk",
];
const PON_FUN_CHAIN_EVENT_KEYS = [
  ...PON_FUN_BASE_EVENT_KEYS,
  "eventKey", "transactionHash", "blockNumber", "blockHash", "blockTimestamp",
  "explorerUrl", "evidence", "title", "summary",
];
const PON_FUN_CHAIN_KIND_KEYS = new Map([
  ["market_created", ["token", "contractAddress", "ticker", "symbol", "market", "currentSnapshot", "changes", "creation"]],
  ["factory_config", ["previousSnapshot", "currentSnapshot", "changes"]],
  ["curve_params", ["previousSnapshot", "currentSnapshot", "changes"]],
  ["stock_listing", ["ticker", "contractAddress", "previousSnapshot", "currentSnapshot", "changes"]],
  ["factory_paused", ["previousSnapshot", "currentSnapshot", "changes"]],
  ["factory_unpaused", ["previousSnapshot", "currentSnapshot", "changes"]],
  ["ownership_transfer_started", ["previousSnapshot", "currentSnapshot", "changes"]],
  ["ownership_transferred", ["previousSnapshot", "currentSnapshot", "changes"]],
]);
const PON_FUN_API_KIND_KEYS = new Map([
  ["market_lifecycle", [
    ...PON_FUN_BASE_EVENT_KEYS,
    "eventKey", "title", "summary", "token", "contractAddress", "ticker", "symbol",
    "market", "previousSnapshot", "currentSnapshot", "changes", "evidence",
  ]],
  ["platform_token_update", [
    ...PON_FUN_BASE_EVENT_KEYS,
    "eventKey", "title", "summary", "token", "contractAddress", "symbol",
    "previousSnapshot", "currentSnapshot", "changes", "evidence",
  ]],
]);

function validPonFunOrphanKeys(value) {
  return Array.isArray(value)
    && value.length <= 500
    && new Set(value).size === value.length
    && value.every((key) => typeof key === "string" && key.startsWith("pon-fun:") && key.length <= 512);
}

function validPonFunDerivedAlertFields(event) {
  if (Object.hasOwn(event, "alertQueuedAt") && strictTelegramNewsInstant(event.alertQueuedAt) === null) return false;
  const hasCanonicalId = Object.hasOwn(event, "canonicalSignalId");
  const hasCanonicalIds = Object.hasOwn(event, "canonicalSignalIds");
  if (hasCanonicalId !== hasCanonicalIds) return false;
  if (hasCanonicalId) {
    if (typeof event.canonicalSignalId !== "string"
      || !event.canonicalSignalId.startsWith("pon:")
      || !Array.isArray(event.canonicalSignalIds)
      || event.canonicalSignalIds.length < 1
      || event.canonicalSignalIds.length > 16
      || new Set(event.canonicalSignalIds).size !== event.canonicalSignalIds.length
      || event.canonicalSignalIds[0] !== event.canonicalSignalId
      || event.canonicalSignalIds.some((value) => typeof value !== "string" || !value.startsWith("pon:") || value.length > 512)) return false;
  }
  if (Object.hasOwn(event, "freshness")) {
    const freshness = event.freshness;
    const expectedOccurredAt = event.delayedRecovery?.recoveredAt
      || event.blockTimestamp
      || event.observedAt;
    const expectedScope = event.delayedRecovery ? "pon_delayed_recovery" : "robinhood_chain";
    const expectedBasis = event.delayedRecovery
      ? "delayedRecovery.recoveredAt_continuous_recovery"
      : event.blockTimestamp ? "blockTimestamp" : "observedAt_continuous_coverage";
    const occurredMs = strictTelegramNewsInstant(expectedOccurredAt);
    const discoveredMs = strictTelegramNewsInstant(freshness?.discoveredAt);
    if (!ponFunRecord(freshness)
      || freshness.version !== 1
      || freshness.scope !== expectedScope
      || freshness.basis !== expectedBasis
      || freshness.sourceOccurredAt !== expectedOccurredAt
      || occurredMs === null
      || discoveredMs === null
      || freshness.sourceTimeReliable !== true
      || !validPonFunInteger(freshness.realtimeMaxAgeMs)
      || !validPonFunInteger(freshness.telegramMaxAgeMs)
      || freshness.telegramMaxAgeMs < freshness.realtimeMaxAgeMs
      || freshness.lagMs !== Math.max(0, discoveredMs - occurredMs)
      || !["realtime", "late", "suppress"].includes(freshness.decision)) return false;
    const expectedDecision = freshness.lagMs <= freshness.realtimeMaxAgeMs
      ? "realtime"
      : freshness.lagMs <= freshness.telegramMaxAgeMs ? "late" : "suppress";
    if (freshness.decision !== expectedDecision) return false;
    if (event.delayedRecovery
      && (freshness.realtimeMaxAgeMs !== PON_FUN_X_REALTIME_MAX_AGE_MS
        || freshness.telegramMaxAgeMs !== PON_FUN_DELAYED_RECOVERY_MAX_LAG_MS)) return false;
    const hasDelivery = ["deliveryEvaluatedAt", "deliveryLagMs", "deliveryDecision"]
      .some((key) => Object.hasOwn(freshness, key));
    if (hasDelivery) {
      const deliveryMs = strictTelegramNewsInstant(freshness.deliveryEvaluatedAt);
      if (deliveryMs === null
        || freshness.deliveryLagMs !== Math.max(0, deliveryMs - occurredMs)
        || !["realtime", "late", "suppress"].includes(freshness.deliveryDecision)) return false;
      const deliveryDecision = freshness.deliveryLagMs <= freshness.realtimeMaxAgeMs
        ? "realtime"
        : freshness.deliveryLagMs <= freshness.telegramMaxAgeMs ? "late" : "suppress";
      if (freshness.deliveryDecision !== deliveryDecision) return false;
    }
  }
  if (Object.hasOwn(event, "tradingPriority")) {
    const priority = event.tradingPriority;
    const expectedTier = event.delayedRecovery
      || ["market_created", "market_lifecycle", "stock_listing", "factory_unpaused"].includes(event.kind)
      ? "T2"
      : "T1";
    if (!ponFunRecord(priority)
      || priority.version !== 2
      || priority.schema !== "news_trading_priority_v2"
      || priority.deterministic !== true
      || priority.tier !== expectedTier
      || priority.rank !== ({ T1: 3, T2: 2 })[expectedTier]
      || priority.plan?.automaticExecution !== false) return false;
  }
  return true;
}

function validPonFunEnvelope(event) {
  const required = PON_FUN_CHAIN_EVENT_KINDS.has(event?.kind)
    ? [...PON_FUN_CHAIN_EVENT_KEYS, ...(PON_FUN_CHAIN_KIND_KEYS.get(event.kind) || [])]
    : PON_FUN_API_KIND_KEYS.get(event?.kind);
  if (!required) return false;
  const optional = [
    ...(event.reorgOrphanedEventKeys === undefined ? [] : ["reorgOrphanedEventKeys"]),
    ...(event.delayedRecovery === undefined ? [] : ["originalEventKey", "delayedRecovery"]),
    ...["canonicalSignalId", "canonicalSignalIds", "freshness", "tradingPriority"]
      .filter((key) => Object.hasOwn(event, key)),
    ...(Object.hasOwn(event, "alertQueuedAt") ? ["alertQueuedAt"] : []),
  ];
  const allowed = [...required, ...optional];
  return exactPonFunKeys(event, allowed)
    && required.every((key) => Object.hasOwn(event, key))
    && (event.reorgOrphanedEventKeys === undefined || validPonFunOrphanKeys(event.reorgOrphanedEventKeys))
    && validPonFunDerivedAlertFields(event);
}

/**
 * Authenticate the monitor's closed pon.fun producer schema.  The trust label
 * means the public site was bound to the observed on-chain factory fingerprint;
 * it is not a source-code audit or a general "verified source" assertion.
 */
export function isOfficialPonFunUpdate(event) {
  if (event && Object.hasOwn(event, "delayedRecovery")) {
    if (event.delayedRecovery == null) return false;
    if (!validPonFunEnvelope(event) || !isStrictPonFunChainDelayedRecovery(event)) return false;
    const display = ponFunChainDisplay(event);
    if (!display
      || event.title !== `pon.fun 延迟恢复摘要：${display.title}`
      || event.summary !== "A still-relevant structural change was recovered after a monitoring gap; the original finalized proof and change are preserved.") return false;
    const original = {
      ...event,
      eventKey: event.originalEventKey,
      title: display.title,
      summary: display.summary,
    };
    delete original.delayedRecovery;
    delete original.originalEventKey;
    delete original.canonicalSignalId;
    delete original.canonicalSignalIds;
    delete original.freshness;
    delete original.tradingPriority;
    delete original.alertQueuedAt;
    return isOfficialPonFunUpdate(original);
  }
  if (!event || typeof event !== "object" || Array.isArray(event)
    || event.type !== PON_FUN_EVENT_TYPE
    || !PON_FUN_KINDS.has(event.kind)
    || !validPonFunEnvelope(event)
    || !exactPonFunPlatform(event.platform)
    || event.chainId !== PON_FUN_CHAIN_ID
    || normalized(event.factory) !== PON_FUN_FACTORY
    || typeof event.eventKey !== "string"
    || !event.eventKey.trim()
    || event.eventKey.length > 512
    || strictTelegramNewsInstant(event.observedAt) === null
    || event.strong !== true
    || event.risk !== PON_FUN_RISK
    || event.sourceTrust !== PON_FUN_SOURCE_TRUST) return false;
  const source = event.source;
  const evidence = event.evidence;
  const sourceKeys = new Set(["id", "name", "url", "official", "trust"]);
  if (!source || typeof source !== "object" || Array.isArray(source)
    || Object.keys(source).length !== sourceKeys.size
    || Object.keys(source).some((key) => !sourceKeys.has(key))
    || source.id !== PON_FUN_SOURCE_ID
    || source.name !== "pon.fun official API + fingerprinted Factory"
    || source.trust !== PON_FUN_SOURCE_TRUST
    || source.official !== true
    || !evidence || typeof evidence !== "object" || Array.isArray(evidence)
    || evidence.chainId !== PON_FUN_CHAIN_ID
    || normalized(evidence.factory) !== PON_FUN_FACTORY
    || normalized(evidence.factoryCodeHash) !== PON_FUN_FACTORY_RUNTIME_HASH
    || !validPonFunApiEvidence(evidence.api, event.kind)) return false;
  if (PON_FUN_CHAIN_EVENT_KINDS.has(event.kind)) {
    return validPonFunChainEvidence(event)
      && validPonFunChainSemantics(event)
      && strictPonFunExplorerUrl(event.explorerUrl, event.transactionHash)
      && source.url === event.explorerUrl
      && event.eventKey === `pon-fun:${event.kind}:${PON_FUN_CHAIN_ID}:${String(event.transactionHash).toLowerCase()}:${event.evidence.logIndex}`;
  }
  if (event.kind === "market_lifecycle") {
    return source.url === "https://www.pon.fun/api/markets"
      && validPonFunApiRevisionEvidence(event)
      && /^0x[a-f0-9]{40}$/i.test(String(event.token || ""))
      && normalized(event.contractAddress) === normalized(event.token)
      && event.eventKey === exactPonFunSnapshotEventKey(event)
      && validPonFunMarketLifecycle(event);
  }
  return source.url === "https://www.pon.fun/api/ponfun"
    && validPonFunApiRevisionEvidence(event)
    && validPonFunPlatformTokenProof(event)
    && /^0x[a-f0-9]{40}$/i.test(String(event.token || ""))
    && normalized(event.contractAddress) === normalized(event.token)
    && event.eventKey === exactPonFunSnapshotEventKey(event)
    && validPonFunPlatformTokenUpdate(event);
}

function strictPonFunInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function isStrictPonFunChainDelayedRecovery(event) {
  const recovery = event?.delayedRecovery;
  const cursor = recovery?.cursor;
  const allowedRecovery = new Set([
    "version", "reason", "gapSince", "sourceOccurredAt", "recoveredAt", "lagMs", "cursor",
  ]);
  const allowedCursor = new Set(["nextBlockAtRecovery", "eventBlock"]);
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)
    || !cursor || typeof cursor !== "object" || Array.isArray(cursor)
    || Object.keys(recovery).length !== allowedRecovery.size
    || Object.keys(recovery).some((key) => !allowedRecovery.has(key))
    || Object.keys(cursor).length !== allowedCursor.size
    || Object.keys(cursor).some((key) => !allowedCursor.has(key))
    || recovery.version !== PON_FUN_X_DELAYED_RECOVERY_VERSION
    || recovery.reason !== PON_FUN_X_DELAYED_RECOVERY_REASON
    || !PON_FUN_DELAYED_CHAIN_KINDS.has(event?.kind)
    || typeof event.originalEventKey !== "string"
    || !event.originalEventKey
    || event.eventKey !== `${event.originalEventKey}:delayed-recovery:v1`
    || !Number.isSafeInteger(cursor.nextBlockAtRecovery)
    || cursor.nextBlockAtRecovery <= 0
    || !Number.isSafeInteger(cursor.eventBlock)
    || cursor.eventBlock !== event.blockNumber) return false;
  const sourceOccurredAt = strictPonFunInstant(recovery.sourceOccurredAt);
  const gapSince = strictPonFunInstant(recovery.gapSince);
  const recoveredAt = strictPonFunInstant(recovery.recoveredAt);
  const observedAt = strictPonFunInstant(event?.observedAt);
  const blockTimestamp = strictPonFunInstant(event?.blockTimestamp);
  const lagMs = recovery.lagMs;
  return sourceOccurredAt !== null
    && gapSince !== null
    && recoveredAt !== null
    && observedAt !== null
    && blockTimestamp !== null
    && Number.isSafeInteger(lagMs)
    && lagMs > 2 * 60 * 60 * 1_000
    && lagMs <= PON_FUN_DELAYED_RECOVERY_MAX_LAG_MS
    && sourceOccurredAt === blockTimestamp
    && recoveredAt === observedAt
    && gapSince <= recoveredAt
    && lagMs === Math.max(0, recoveredAt - sourceOccurredAt);
}

function isStrictPonFunDelayedRecovery(source, classified) {
  const recovery = source?.delayedRecovery;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) return false;
  const cursor = recovery.cursor;
  const allowed = new Set([
    "version", "reason", "gapSince", "sourceOccurredAt", "recoveredAt", "lagMs", "cursor",
  ]);
  const allowedCursor = new Set(["latestIdAtRecovery", "tweetId"]);
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)
    || Object.keys(recovery).length !== allowed.size
    || Object.keys(recovery).some((key) => !allowed.has(key))
    || Object.keys(cursor).length !== allowedCursor.size
    || Object.keys(cursor).some((key) => !allowedCursor.has(key))
    || recovery.version !== PON_FUN_X_DELAYED_RECOVERY_VERSION
    || recovery.reason !== PON_FUN_X_DELAYED_RECOVERY_REASON
    || classified?.ponPriority !== "T1"
    || classified?.majorProductUpdate !== true
    || classified?.platformStructural !== true
    || source.deliverySla != null
    || typeof cursor.latestIdAtRecovery !== "string"
    || !/^[1-9]\d{5,}$/.test(cursor.latestIdAtRecovery)
    || typeof cursor.tweetId !== "string"
    || cursor.tweetId !== source.tweet?.id) return false;
  const sourceOccurredAt = strictPonFunInstant(recovery.sourceOccurredAt);
  const gapSince = strictPonFunInstant(recovery.gapSince);
  const recoveredAt = strictPonFunInstant(recovery.recoveredAt);
  const observedAt = strictPonFunInstant(source.observedAt);
  const createdAt = strictPonFunInstant(source.tweet?.createdAt);
  const lagMs = recovery.lagMs;
  if (sourceOccurredAt === null || gapSince === null || recoveredAt === null
    || observedAt === null || createdAt === null
    || !Number.isSafeInteger(lagMs)
    || lagMs <= PON_FUN_X_REALTIME_MAX_AGE_MS
    || lagMs > PON_FUN_DELAYED_RECOVERY_MAX_LAG_MS
    || sourceOccurredAt !== createdAt
    || recoveredAt !== observedAt
    || lagMs !== Math.max(0, recoveredAt - sourceOccurredAt)
    || gapSince > recoveredAt) return false;
  try {
    return BigInt(cursor.latestIdAtRecovery) < BigInt(source.tweet.id);
  } catch {
    return false;
  }
}

function isOfficialPonFunXSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  if (source.type && source.type !== "twitter_update") return false;
  const target = source.type === "twitter_update" ? source.project : source;
  if (!target || typeof target !== "object" || Array.isArray(target)
    || normalized(target.id) !== "ponfun"
    || normalized(target.name) !== "pon.fun"
    || normalized(target.handle).replace(/^@/, "") !== PON_FUN_X_HANDLE
    || target.xUserId !== PON_FUN_X_USER_ID
    || normalized(target.match) !== "official_x"
    || normalized(target.signalProfile) !== "pon_fun"
    || target.website !== "https://www.pon.fun"
    || target.twitter !== "https://x.com/pondotfun") return false;
  if (source.type !== "twitter_update") return true;
  const tweet = source.tweet;
  if (!tweet || typeof tweet !== "object" || Array.isArray(tweet)
    || typeof tweet.id !== "string"
    || !/^[1-9]\d{5,}$/.test(tweet.id)
    || normalized(tweet.handle).replace(/^@/, "") !== PON_FUN_X_HANDLE
    || !strictPonFunUrl(tweet.url, { xStatus: true })
    || tweet.url !== `https://x.com/pondotfun/status/${tweet.id}`
    || tweet.sourceVerifiedBy !== "official_x_oembed"
    || tweet.identityVerifiedBy !== "fxtwitter_exact_numeric_id"
    || typeof tweet.text !== "string"
    || tweet.text !== tweet.text.trim()
    || tweet.text.length < 1
    || tweet.text.length > 20_000
    || /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(tweet.text)
    || strictPonFunInstant(tweet.createdAt) === null
    || strictPonFunInstant(source.observedAt) === null) return false;
  if (strictPonFunInstant(tweet.createdAt) > strictPonFunInstant(source.observedAt) + 5 * 60 * 1_000) return false;
  const expandedUrls = tweet.expandedUrls == null ? [] : tweet.expandedUrls;
  if (!Array.isArray(expandedUrls)
    || expandedUrls.length > 16
    || new Set(expandedUrls).size !== expandedUrls.length
    || !expandedUrls.every((value) => {
      if (typeof value !== "string" || value !== value.trim() || value.length > 2_048) return false;
      const url = parsedHttpsUrl(value);
      return Boolean(url && !url.port && !url.hash);
    })) return false;
  if (tweet.xUserId !== PON_FUN_X_USER_ID
    || tweet.authorId !== PON_FUN_X_USER_ID
    || (tweet.userId != null && tweet.userId !== PON_FUN_X_USER_ID)) return false;
  const signal = source.signal;
  const signalRule = PON_FUN_X_SIGNAL_RULES.get(String(signal?.ponStage || ""));
  const classified = classifyPonFunSignalCore([tweet.text, ...expandedUrls].join("\n"));
  const exactFields = [
    "relevant", "strong", "ponFunOfficial", "ponKind", "ponStage", "ponAsset",
    "tokenAddress", "transactionHash", "ponPriority", "majorProductUpdate",
    "platformStructural", "reason",
  ];
  const exactClassification = exactFields.every((field) => Object.is(signal?.[field], classified?.[field]))
    && JSON.stringify(signal?.labels) === JSON.stringify(classified?.labels);
  const delayedRecoveryValid = source.delayedRecovery == null
    ? true
    : isStrictPonFunDelayedRecovery(source, classified);
  return Boolean(signal?.ponFunOfficial === true
    && signal?.relevant === true
    && signalRule
    && classified?.relevant === true
    && exactClassification
    && signal?.ponKind === signalRule.kind
    && signal?.ponPriority === signalRule.priority
    && signal?.majorProductUpdate === signalRule.major
    && signal?.platformStructural === signalRule.major
    && signal?.strong === signalRule.major
    && (!signalRule.address || /^0x[a-f0-9]{40}$/i.test(String(signal?.tokenAddress || "")))
    && (!signalRule.transaction || /^0x[a-f0-9]{64}$/i.test(String(signal?.transactionHash || "")))
    && delayedRecoveryValid);
}

function claimsPonFunIdentity(source, seen = new Set()) {
  if (!source || typeof source !== "object" || Array.isArray(source) || seen.has(source)) return false;
  seen.add(source);
  if (source.type === PON_FUN_EVENT_TYPE) return true;
  for (const key of ["id", "name", "handle", "projectId", "platformId", "launchpadId"]) {
    const value = normalized(source[key]).replace(/^@/, "");
    if (["ponfun", "pon.fun", PON_FUN_X_HANDLE].includes(value)) return true;
  }
  for (const key of ["website", "twitter", "url"]) {
    const url = parsedHttpsUrl(source[key]);
    const host = url?.hostname.toLowerCase().replace(/^www\./, "");
    const handle = url?.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    if (host === "pon.fun" || (host === "x.com" && handle === PON_FUN_X_HANDLE)) return true;
  }
  for (const key of ["source", "project", "platform", "launchpad", "evidence"]) {
    if (claimsPonFunIdentity(source[key], seen)) return true;
  }
  return false;
}

export function isPonFunSource(source) {
  return claimsPonFunIdentity(source);
}

export function isPonFunMonitoringEnabled(config) {
  return config?.ponMonitorEnabled === true;
}

function focus3PonFunOfficialSourceAllowed(config, source) {
  return isPonFunMonitoringEnabled(config)
    && (isOfficialPonFunUpdate(source) || isOfficialPonFunXSource(source));
}

function telegramNewsMessageId(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? value : null;
}

function boundedTelegramNewsText(value, maximum) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text.length > 0
    && text.length <= maximum
    && !TELEGRAM_NEWS_DISALLOWED_TEXT_CONTROL.test(text);
}

function strictTelegramNewsInstant(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function safeTelegramNewsExternalUrl(value) {
  if (typeof value !== "string" || value !== value.trim() || value.length > 2_048) return false;
  const url = parsedHttpsUrl(value);
  if (!url || url.port) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // Public news links never need literal or local-only hosts. Rejecting every
  // IP literal also closes the common decimal/IPv6 private-network variants
  // without attempting DNS resolution inside the alert path.
  if (!host.includes(".")
    || host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || /^\d+(?:\.\d+){3}$/.test(host)
    || host.includes(":")) return false;
  return true;
}

function validTelegramNewsPayload(news) {
  if (!news || typeof news !== "object" || Array.isArray(news)) return false;
  if (!TELEGRAM_NEWS_CATEGORIES.has(news.category)
    || !TELEGRAM_NEWS_STAGES.has(news.stage)
    || !boundedTelegramNewsText(news.headline, 300)
    || !boundedTelegramNewsText(news.summary, 2_000)
    || !boundedTelegramNewsText(news.storyKey, 256)
    || news.confidence !== "observed"
    || !Array.isArray(news.externalUrls)
    || news.externalUrls.length > 8
    || !news.externalUrls.every(safeTelegramNewsExternalUrl)) return false;
  return new Set(news.externalUrls).size === news.externalUrls.length;
}

/**
 * Fail-closed authenticity and payload gate for the one explicitly monitored
 * public Telegram channel. This is observation evidence, never an official
 * source assertion.
 */
export function isTelegramNewsUpdateAllowed(event, now = Date.now()) {
  if (!event || typeof event !== "object" || event.type !== "telegram_news_update") return false;
  const messageId = telegramNewsMessageId(event.messageId);
  if (!messageId) return false;
  const messageUrl = `https://t.me/${TELEGRAM_NEWS_USERNAME}/${messageId}`;
  const contentDigest = String(event.contentDigest || "");
  const eventKey = `telegram-news:${TELEGRAM_NEWS_CHAT_ID}:${messageId}:${contentDigest.slice(0, 16)}`;
  const sourceOccurredAt = strictTelegramNewsInstant(event.sourceOccurredAt);
  const evaluatedAt = Number(now);
  if (!Number.isFinite(evaluatedAt)
    || sourceOccurredAt === null
    || sourceOccurredAt > evaluatedAt + TELEGRAM_NEWS_FUTURE_TOLERANCE_MS
    || evaluatedAt - sourceOccurredAt > TELEGRAM_NEWS_MAX_SOURCE_AGE_MS) return false;
  if (event.chatId !== TELEGRAM_NEWS_CHAT_ID
    || event.username !== TELEGRAM_NEWS_USERNAME
    || event.messageUrl !== messageUrl
    || (event.url != null && event.url !== messageUrl)
    || event.eventKey !== eventKey
    || event.sourceTrust !== TELEGRAM_NEWS_SOURCE_TRUST
    || event.strong !== false
    || !/^[a-f0-9]{64}$/.test(contentDigest)) return false;
  if (!event.channel
    || typeof event.channel !== "object"
    || Array.isArray(event.channel)
    || event.channel.chatId !== TELEGRAM_NEWS_CHAT_ID
    || event.channel.username !== TELEGRAM_NEWS_USERNAME
    || event.channel.visibility !== "public"
    || !boundedTelegramNewsText(event.channel.title, 200)) return false;
  if (!event.source
    || typeof event.source !== "object"
    || Array.isArray(event.source)
    || event.source.id !== TELEGRAM_NEWS_SOURCE_ID
    || event.source.trust !== TELEGRAM_NEWS_SOURCE_TRUST
    || event.source.url !== TELEGRAM_NEWS_SOURCE_URL) return false;
  return validTelegramNewsPayload(event.news);
}

function isBinanceOfficialHost(hostname) {
  const host = normalized(hostname).replace(/\.$/, "");
  return [...BINANCE_OFFICIAL_HOSTS].some((root) => host === root || host.endsWith(`.${root}`));
}

function isBinanceOfficialUrl(value) {
  const url = parsedHttpsUrl(value);
  return Boolean(url && isBinanceOfficialHost(url.hostname));
}

function isOfficialBinanceInternalEvent(source) {
  if (source?.type !== "binance_official_update" || !source.source || typeof source.source !== "object") return false;
  if (!BINANCE_OFFICIAL_EVENT_SOURCE_IDS.has(normalized(source.source.id))) return false;
  const declaredUrls = [source.source.url, source.url, source.detailSource]
    .filter((value) => typeof value === "string" && value.trim());
  const declaredHosts = [source.source.host, source.host]
    .filter((value) => typeof value === "string" && value.trim());
  // Every current internal Binance event carries an official source URL (or
  // an already-parsed host). Requiring it and rejecting conflicting
  // provenance means a copied source id cannot authenticate an arbitrary event.
  return declaredUrls.length + declaredHosts.length > 0
    && declaredUrls.every(isBinanceOfficialUrl)
    && declaredHosts.every((host) => isBinanceOfficialHost(host));
}

function exactOfficialXUrl(value, handle, { statusAllowed = false } = {}) {
  const url = parsedHttpsUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!new Set(["x.com", "twitter.com"]).has(host)) return false;
  const segments = url.pathname.split("/").filter(Boolean);
  if (normalized(segments[0]) !== handle) return false;
  if (segments.length === 1) return true;
  return statusAllowed && segments.length === 3 && normalized(segments[1]) === "status" && /^\d+$/.test(segments[2]);
}

function isOfficialBinanceXSource(source) {
  if (!source || typeof source !== "object") return false;
  if (source.type && source.type !== "twitter_update") return false;
  const target = source.type === "twitter_update" ? source.project : source;
  if (!target || typeof target !== "object") return false;
  const handle = normalized(target.handle).replace(/^@/, "");
  const expected = BINANCE_OFFICIAL_X_TARGETS.get(handle);
  if (!expected
    || normalized(target.id) !== expected.id
    || normalized(target.match) !== "official_x"
    || normalized(target.signalProfile) !== "binance"
    || !exactOfficialXUrl(target.twitter, handle)) return false;
  if (target.xUserId != null && String(target.xUserId) !== expected.xUserId) return false;
  if (source.type === "twitter_update" && source.tweet && typeof source.tweet === "object") {
    if (source.tweet.handle != null && normalized(source.tweet.handle).replace(/^@/, "") !== handle) return false;
    if (source.tweet.url != null && !exactOfficialXUrl(source.tweet.url, handle, { statusAllowed: true })) return false;
  }
  return true;
}

function isOfficialBinanceGithubSource(source) {
  if (!source || typeof source !== "object") return false;
  if (source.type && !["github_module_update", "github_repository_discovered"].includes(source.type)) return false;
  const match = normalized(source.repository).match(/^([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/);
  if (source.sourceTrust !== "official_verified" || match?.[1] !== "binance") return false;
  if (source.type !== "github_repository_discovered") return true;

  // Organization discovery is a stronger claim than a configured repository
  // entry or a commit from one. Require the complete producer proof so a bare
  // `repository: binance/...` display claim cannot enter the official lane.
  if (normalized(source.officialOrganization) !== "binance"
    || normalized(source.officialEvidence?.source) !== "official_binance_github") return false;
  const organizationUrl = parsedHttpsUrl(source.officialEvidence?.url);
  if (!organizationUrl
    || normalized(organizationUrl.hostname) !== "github.com"
    || organizationUrl.port
    || organizationUrl.search
    || organizationUrl.hash
    || organizationUrl.pathname.replace(/\/+$/, "").toLowerCase() !== "/binance") return false;
  const repositoryUrl = parsedHttpsUrl(source.url);
  if (!repositoryUrl
    || normalized(repositoryUrl.hostname) !== "github.com"
    || repositoryUrl.port
    || repositoryUrl.search
    || repositoryUrl.hash
    || repositoryUrl.pathname.replace(/\/+$/, "").toLowerCase() !== `/${match[1]}/${match[2]}`) return false;
  const createdAtValue = source.repositoryMetadata?.createdAt || source.createdAt;
  const createdAt = Date.parse(createdAtValue || "");
  const now = Date.now();
  return Number.isFinite(createdAt)
    && createdAt <= now + 60_000
    && now - createdAt <= 2 * 60 * 60_000;
}

function claimsBinanceIdentity(source) {
  if (!source || typeof source !== "object") return false;
  if (source.type === "binance_official_update") return true;
  if (/^binance\//i.test(String(source.repository || ""))) return true;
  const candidates = [
    source.id,
    source.name,
    source.handle,
    source.projectId,
    source.platformId,
    source.launchpadId,
    source.launchpad,
    source.launchpadName,
    source.source?.id,
    source.source?.name,
    source.project?.id,
    source.project?.name,
    source.project?.handle,
  ];
  if (candidates.some((value) => {
    const text = String(value || "").trim();
    return BINANCE_OFFICIAL_X_TARGETS.has(compact(text.replace(/^@/, "")))
      || /^binance(?:\b|[-_. ])/i.test(text);
  })) return true;
  for (const value of [source.twitter, source.project?.twitter]) {
    const url = parsedHttpsUrl(value);
    const handle = url?.pathname.split("/").filter(Boolean)[0];
    if (BINANCE_OFFICIAL_X_TARGETS.has(normalized(handle))) return true;
  }
  return false;
}

function focus3BinanceOfficialSourceAllowed(config, source) {
  if (config?.binanceMonitorEnabled !== true) return false;
  // CMS/WebSocket events have already crossed the strict source-id plus
  // all-declared-URLs provenance check. Do not make this source-control layer
  // a second semantic filter: listings, contracts, activities, and ordinary
  // announcements belong to the central relevance policy.
  if (isOfficialBinanceInternalEvent(source)) return true;
  return !focus3StockRwaSignal(source)
    && (isOfficialBinanceXSource(source) || isOfficialBinanceGithubSource(source));
}

function strictAiUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const authority = raw.match(/^https:\/\/([^/?#]+)/i)?.[1] || "";
  // URL normalizes an explicit default :443 port away, so inspect the raw
  // authority too. An official URL in this lane never needs an explicit port.
  if (/:\d+$/.test(authority.replace(/^.*@/, ""))) return null;
  const url = parsedHttpsUrl(raw);
  return url && url.port === "" && url.search === "" ? url : null;
}

function exactAiHost(url, host) {
  return url.hostname.toLowerCase() === host
    && url.username === ""
    && url.password === "";
}

function safeAiDocumentPath(pathname) {
  return /^\/[a-z0-9._~/-]+$/i.test(pathname)
    && !pathname.includes("//")
    && !pathname.split("/").some((segment) => segment === "." || segment === "..");
}

function safeAiDocumentFragment(hash) {
  return hash === "" || /^#[a-z0-9][a-z0-9._~-]*$/i.test(hash);
}

function isOfficialAiTransportUrl(sourceId, value) {
  const url = strictAiUrl(value);
  if (!url || url.hash) return false;
  if (sourceId === "x_api_changelog") {
    return exactAiHost(url, "docs.x.com") && url.pathname === "/changelog/rss.xml";
  }
  if (sourceId === "xai_release_notes") {
    return exactAiHost(url, "docs.x.ai") && url.pathname === "/developers/release-notes.md";
  }
  return sourceId === "xai_news"
    && exactAiHost(url, "r.jina.ai")
    && ["/http://x.ai/news", "/https://x.ai/news"].includes(url.pathname);
}

const X_CHANGELOG_DATE_FRAGMENT = /^#(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)-\d{1,2}-\d{4}|\d{4}-\d{2}-\d{2})$/i;

function isXaiNewsItemUrl(url, { rootAllowed = false } = {}) {
  if (!exactAiHost(url, "x.ai") || url.hash) return false;
  if (rootAllowed && ["/news", "/news/"].includes(url.pathname)) return true;
  return /^\/news\/[a-z0-9][a-z0-9-]*$/i.test(url.pathname);
}

function isOfficialAiItemUrl(sourceId, value) {
  const url = strictAiUrl(value);
  if (!url) return false;
  if (sourceId === "x_api_changelog") {
    return exactAiHost(url, "docs.x.com")
      && url.pathname === "/changelog"
      && (url.hash === "" || X_CHANGELOG_DATE_FRAGMENT.test(url.hash));
  }
  if (sourceId === "xai_news") return isXaiNewsItemUrl(url);
  if (sourceId !== "xai_release_notes") return false;
  if (isXaiNewsItemUrl(url, { rootAllowed: true })) return true;
  if (!exactAiHost(url, "docs.x.ai")
    || !safeAiDocumentPath(url.pathname)
    || !safeAiDocumentFragment(url.hash)) return false;
  if (["/developers/release-notes", "/developers/release-notes/", "/developers/release-notes.md"].includes(url.pathname)) return true;
  return /^\/(?:developers|grok-bot)\/[a-z0-9._~/-]*[a-z0-9._~-]$/i.test(url.pathname);
}

function exactAiProjectUrl(value, host, pathname = "") {
  const url = strictAiUrl(value);
  if (!url || url.hash || !exactAiHost(url, host)) return false;
  return pathname === "" ? ["", "/"].includes(url.pathname) : url.pathname === pathname;
}

function isOfficialAiInternalProject(sourceId, project) {
  if (!project || typeof project !== "object") return false;
  if (sourceId === "x_api_changelog") {
    return normalized(project.id) === "x"
      && exactAiProjectUrl(project.website, "x.com")
      && exactOfficialAiXUrl(project.twitter, "x");
  }
  if (normalized(project.id) !== "xai"
    || !exactAiProjectUrl(project.website, "x.ai")
    || !exactOfficialAiXUrl(project.twitter, "spacexai")) return false;
  if (project.socials != null) {
    if (!Array.isArray(project.socials) || project.socials.length < 1) return false;
    if (!project.socials.every((value) => exactOfficialAiXUrl(value, "spacexai") || exactOfficialAiXUrl(value, "grok"))) return false;
  }
  return true;
}

function isOfficialAiInternalEvent(source) {
  if (source?.type !== "ai_official_update" || !source.source || typeof source.source !== "object") return false;
  const sourceId = normalized(source.source.id);
  if (!AI_OFFICIAL_EVENT_SOURCE_IDS.has(sourceId)
    || normalized(source.kind) !== sourceId
    || source.source.official !== true
    || normalized(source.source.trust) !== "official_verified"
    || !isOfficialAiTransportUrl(sourceId, source.source.url)
    || !isOfficialAiInternalProject(sourceId, source.project)
    || !isOfficialAiItemUrl(sourceId, source.url)) return false;
  if (source.detailSource != null && !isOfficialAiItemUrl(sourceId, source.detailSource)) return false;
  // These internal events have one canonical project. Conflicting platform
  // metadata must not be able to borrow an otherwise valid source id.
  return source.platform == null && source.launchpad == null && source.repository == null;
}

function exactOfficialAiXUrl(value, handle, { statusAllowed = false } = {}) {
  const url = strictAiUrl(value);
  if (!url || url.hash) return false;
  const host = url.hostname.toLowerCase();
  if (!new Set(["x.com", "twitter.com"]).has(host)) return false;
  const segments = url.pathname.split("/").filter(Boolean);
  if (normalized(segments[0]) !== handle) return false;
  if (segments.length === 1) return true;
  return statusAllowed
    && segments.length === 3
    && normalized(segments[1]) === "status"
    && /^\d+$/.test(segments[2]);
}

function isOfficialAiXSource(source) {
  if (!source || typeof source !== "object") return false;
  if (source.type && source.type !== "twitter_update") return false;
  const target = source.type === "twitter_update" ? source.project : source;
  if (!target || typeof target !== "object") return false;
  const handle = normalized(target.handle).replace(/^@/, "");
  const expected = AI_OFFICIAL_X_TARGETS.get(handle);
  if (!expected
    || normalized(target.id) !== expected.id
    || String(target.xUserId || "") !== expected.xUserId
    || normalized(target.match) !== "official_x"
    || normalized(target.signalProfile) !== "ai"
    || !exactOfficialAiXUrl(target.twitter, handle)) return false;
  if ((target.website != null && target.website !== expected.website)
    || (target.docs != null && target.docs !== expected.docs)
    || target.repository != null
    || target.platform != null
    || target.launchpad != null) return false;
  if (source.type !== "twitter_update") return true;
  if (source.platform != null || source.launchpad != null || source.repository != null) return false;
  if (!source.tweet || typeof source.tweet !== "object") return false;
  if (normalized(source.tweet.handle).replace(/^@/, "") !== handle
    || !exactOfficialAiXUrl(source.tweet.url, handle, { statusAllowed: true })) return false;
  const immutableTweetIds = [source.tweet.xUserId, source.tweet.userId, source.tweet.authorId]
    .filter((value) => value != null);
  if (!immutableTweetIds.length) return false;
  for (const value of immutableTweetIds) {
    if (value != null && String(value) !== expected.xUserId) return false;
  }
  return true;
}

function repositoryParts(value) {
  const match = normalized(value).match(/^([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/);
  return match ? { repository: match[0], owner: match[1], name: match[2] } : null;
}

function exactOfficialGithubUrl(value, pathname) {
  const url = strictAiUrl(value);
  return Boolean(url
    && !url.hash
    && exactAiHost(url, "github.com")
    && normalized(url.pathname) === `/${normalized(pathname)}`);
}

function aiGithubEvidence(source, { event = false } = {}) {
  if (!event) return source.officialEvidence;
  if (source.verification?.status !== "official_verified") return null;
  return source.verification.evidence;
}

function exactAiGithubCommitUrl(value, repository, commit) {
  if (!/^[a-f0-9]{40}$/i.test(String(commit || ""))) return false;
  return exactOfficialGithubUrl(value, `${repository}/commit/${commit}`);
}

function exactAiGithubProduct(source, expected) {
  return Boolean(source?.product
    && typeof source.product === "object"
    && normalized(source.product.id) === expected.id
    && normalized(source.product.name) === expected.name
    && normalized(source.launchpad) === expected.launchpad);
}

function dynamicAiGithubProduct(parts) {
  return parts.owner === "xdevplatform" ? AI_X_API_PRODUCT : AI_GROK_PRODUCT;
}

function dynamicAiRepositoryDiscoverySignal(source, parts) {
  const metadata = source.repositoryMetadata;
  if (!metadata || typeof metadata !== "object") return false;
  const text = [
    parts.name.replace(/[-_.]+/g, " "),
    metadata.description,
    ...(Array.isArray(metadata.topics) ? metadata.topics : []),
  ].filter(Boolean).join("\n");
  return AI_REPOSITORY_DISCOVERY_SIGNAL.test(text);
}

function isOfficialAiStaticGithubSource(source, parts) {
  const expectedProduct = AI_OFFICIAL_REPOSITORIES.get(parts.repository);
  if (!expectedProduct
    || source.sourceTrust !== "official_verified"
    || source.xaiOfficial !== true
    || !exactAiGithubProduct(source, expectedProduct)
    || (source.officialOrganization != null && normalized(source.officialOrganization) !== parts.owner)) return false;
  const event = source.type === "github_module_update";
  if (source.type && !event) return false;
  const evidence = aiGithubEvidence(source, { event });
  if (normalized(evidence?.source) !== "official_x_github_allowlist"
    || !exactOfficialGithubUrl(evidence?.url, parts.repository)) return false;
  if (!event) return true;
  return source.strong === true
    && source.productChange?.candidate === true
    && exactAiGithubCommitUrl(source.url, parts.repository, source.commit);
}

function isOfficialAiDynamicGithubSource(source, parts) {
  if (!AI_OFFICIAL_GITHUB_ORGANIZATIONS.has(parts.owner)
    || normalized(source.officialOrganization) !== parts.owner
    || source.sourceTrust !== "official_verified"
    || source.xaiOfficial !== true
    || !exactAiGithubProduct(source, dynamicAiGithubProduct(parts))) return false;
  const event = source.type === "github_module_update";
  const discovered = source.type === "github_repository_discovered";
  if (source.type && !event && !discovered) return false;
  const evidence = aiGithubEvidence(source, { event });
  if (normalized(evidence?.source) !== "official_x_github_organization"
    || !exactOfficialGithubUrl(evidence?.url, parts.owner)) return false;
  if (!source.type) return true;
  if (discovered) {
    return source.strong === true
      && dynamicAiRepositoryDiscoverySignal(source, parts)
      && exactOfficialGithubUrl(source.url, parts.repository);
  }
  return source.strong === true
    && source.productChange?.candidate === true
    && exactAiGithubCommitUrl(source.url, parts.repository, source.commit);
}

function isOfficialAiGithubSource(source) {
  if (!source || typeof source !== "object") return false;
  if (source.project != null || source.platform != null) return false;
  const parts = repositoryParts(source.repository);
  if (!parts) return false;
  return isOfficialAiStaticGithubSource(source, parts)
    || (!AI_OFFICIAL_REPOSITORIES.has(parts.repository) && isOfficialAiDynamicGithubSource(source, parts));
}

function focus3AiOfficialSourceAllowed(config, source) {
  return config?.xaiOfficialMonitorEnabled === true && (
    isOfficialAiInternalEvent(source)
    || isOfficialAiXSource(source)
    || isOfficialAiGithubSource(source)
  );
}

function looksLikeAiIdentity(value, { handle = false } = {}) {
  if (typeof value !== "string") return false;
  const text = normalized(value).replace(/^@/, "");
  if (!text) return false;
  if (handle && AI_OFFICIAL_X_TARGETS.has(text)) return true;
  return /^(?:x|xai|x\.ai|space\s*x\s*ai|spacexai|grok|x[\s._-]*api)(?:$|[\s._:/-])/i.test(text)
    || /^(?:x_api_changelog|xai_release_notes|xai_news)$/i.test(text);
}

function urlClaimsAiIdentity(value) {
  const url = parsedHttpsUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (["x.ai", "docs.x.ai", "docs.x.com"].includes(host)
    || host.startsWith("x.ai.")
    || host.startsWith("docs.x.ai.")
    || host.startsWith("docs.x.com.")) return true;
  if (host === "r.jina.ai" && /\/x\.ai\/news(?:\/|$)/i.test(url.pathname)) return true;
  if (!["x.com", "twitter.com"].includes(host)) return false;
  const handle = normalized(url.pathname.split("/").filter(Boolean)[0]);
  return AI_OFFICIAL_X_TARGETS.has(handle);
}

function claimsAiIdentity(source, seen = new Set()) {
  if (!source || typeof source !== "object" || seen.has(source)) return false;
  seen.add(source);
  if (source.type === "ai_official_update" || source.xaiOfficial === true) return true;
  const repository = normalized(source.repository);
  if (/^(?:xai-org|xdevplatform)\//.test(repository)) return true;
  for (const key of [
    "id", "name", "product", "projectId", "platformId", "launchpadId", "platformName", "launchpadName", "organization", "officialOrganization",
  ]) {
    if (looksLikeAiIdentity(source[key])) return true;
  }
  if (looksLikeAiIdentity(source.handle, { handle: true })) return true;
  for (const key of ["website", "docs", "twitter", "url", "detailSource"]) {
    if (urlClaimsAiIdentity(source[key])) return true;
  }
  for (const key of ["source", "project", "platform", "launchpad", "attribution", "officialEvidence", "verification", "evidence"]) {
    if (claimsAiIdentity(source[key], seen)) return true;
  }
  return false;
}

export function isThreePlatformScope(config) {
  return normalized(config?.monitorScope) === FOCUS3_SCOPE;
}

export function isThreePlatformSource(source, seen = new Set()) {
  if (focus3Identity(source)) return true;
  if (!source || typeof source !== "object" || seen.has(source)) return false;
  seen.add(source);
  if (source.sourceTrust === "unverified_candidate") return false;
  if (source.sourceTrust === "official_verified"
    && source.uniswapOfficial === true
    && /^uniswap\/[a-z0-9_.-]+$/i.test(normalized(source.repository))
    && (source.chainSupportChange?.candidate === true || source.chainSupportChange?.chains?.length > 0)) return true;
  if (typeof source.repository === "string") return focus3Repository(source.repository);
  if (source.type === "uniswap_official_update" || source.uniswapOfficial === true) return true;
  if (focus3Identity(source.organization)) return true;
  for (const key of [
    "id", "name", "handle", "projectId", "platformId", "launchpadId", "platformName", "launchpadName",
    "website", "docs", "twitter", "repository",
  ]) {
    if (focus3Identity(source[key])) return true;
  }
  for (const key of ["project", "platform", "launchpad", "attribution"]) {
    if (isThreePlatformSource(source[key], seen)) return true;
  }
  if (isThreePlatformSource(source.entry?.launchpad, seen)) return true;
  return false;
}

function hasFocus3CapabilityChange(source) {
  return FOCUS3_CAPABILITY_KEYS.some((key) => Array.isArray(source.changes?.[key]) && source.changes[key].length > 0);
}

function focus3UniswapSignal(source) {
  const text = [
    ...(source.labels || []),
    source.title,
    source.summary,
    source.message,
    source.url,
    source.repository,
    source.tweet?.text,
    ...(source.files || []).map((file) => file.filename),
    ...(source.signal?.labels || []),
  ].filter(Boolean).join(" ");
  const explicitChainSupport = Boolean(
    source.chainSupport?.length
    || source.signal?.chainSupport?.length
    || source.chainSupportChange?.chains?.length
    || source.changes?.newChains?.length
    || source.changes?.chainStageChanges?.length,
  );
  const githubCoreSignal = source.type === "github_module_update"
    && FOCUS3_UNISWAP_GITHUB_CORE_SIGNAL.test(text);
  return !FOCUS3_UNISWAP_EXCLUDED.test(text)
    && (explicitChainSupport || githubCoreSignal || FOCUS3_UNISWAP_SIGNAL.test(text));
}

function focus3StockRwaSignal(source) {
  const mode = source?.mode || {};
  const template = mode?.template || source?.template || {};
  const text = [
    source?.title,
    source?.message,
    source?.summary,
    source?.description,
    source?.body,
    source?.repository,
    source?.repositoryMetadata?.name,
    source?.repositoryMetadata?.description,
    source?.url,
    source?.tweet?.text,
    source?.signal?.headline,
    ...(source?.signal?.labels || []),
    ...(source?.signal?.claims || []),
    ...(source?.signal?.keyChanges || []),
    ...(source?.labels || []),
    ...(source?.keyChanges || []),
    mode?.officialName,
    mode?.componentMode,
    mode?.quoteName,
    template?.name,
    template?.tag,
    template?.description,
    ...(source?.files || []).flatMap((file) => [file?.filename, file?.patch]),
    // `changes` is the emitted diff, unlike platform capability
    // previous/current snapshots. Including only the diff prevents retired
    // stock documentation from suppressing an unrelated new capability.
    source?.changes ? JSON.stringify(source.changes) : null,
  ].filter(Boolean).join(" ");
  return FOCUS3_STOCK_RWA_EXCLUDED.test(text);
}

function focus3GithubGapAllowed(source) {
  if (source?.sourceTrust !== "official_verified") return false;
  const repository = normalized(source.repository);
  if (/^(?:flap-sh|four-meme-community)\/[a-z0-9_.-]+$/i.test(repository)) {
    return source.priority === true && source.pollingClass === "core_priority";
  }
  return source.uniswapOfficial === true && FOCUS3_UNISWAP_REPOSITORIES.has(repository);
}

function smartWalletWindow(profile, period) {
  return profile?.windows?.[period] || null;
}

function finiteAtLeast(value, minimum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum;
}

function positiveIntegerString(value) {
  return /^\d+$/.test(String(value ?? "")) && !/^0+$/.test(String(value));
}

function freshIso(value, maximumAgeMs, nowMs = Date.now()) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp)
    && timestamp <= nowMs + 60_000
    && nowMs - timestamp <= maximumAgeMs;
}

function focus3SmartWalletBuyAllowed(config, source) {
  const wallet = normalized(source?.walletAddress);
  const token = normalized(source?.token || source?.contractAddress);
  const transactionHash = normalized(source?.transactionHash);
  const blockNumber = Number(source?.blockNumber);
  const logIndex = Number(source?.logIndex ?? source?.sourceTrade?.logIndex ?? 0);
  const executionPool = normalized(source?.executionPool);
  const profile = source?.walletProfile || {};
  const trade = source?.sourceTrade || {};
  const transactionProof = source?.transactionProof || {};
  const sourceClassification = source?.sourceClassification || {};
  const positionSemantics = source?.positionSemantics || {};
  const market = source?.market || {};
  const stats7d = smartWalletWindow(profile, "7d") || {};
  const stats30d = smartWalletWindow(profile, "30d") || {};
  const tags = [...new Set([
    ...(Array.isArray(profile?.tags) ? profile.tags : []),
    ...(Array.isArray(trade?.tags) ? trade.tags : []),
  ].map(normalized).filter(Boolean))];
  const classificationTags = [...new Set((Array.isArray(sourceClassification?.gmgnTags)
    ? sourceClassification.gmgnTags : []).map(normalized).filter(Boolean))];
  const proof = source?.positionProof || {};
  const proofPhase = normalized(proof?.phase);
  const zeroPosition = proofPhase === "previous_block" && String(proof?.previousBalanceRaw ?? "") === "0";
  const buyDirection = [source?.activity, source?.action, source?.trade, source?.side, trade?.side]
    .every((value) => normalized(value) === "buy")
    && [source?.tradeSide, source?.transactionType]
      .every((value) => !normalized(value) || normalized(value) === "buy");
  const sourceClassificationAligned = normalized(sourceClassification?.id) === "gmgn_public_performance_wallet"
    && sourceClassification?.fomoOfficial === false
    && sourceClassification?.identityVerified === false
    && sourceClassification?.includesKolTag === tags.includes("kol")
    && classificationTags.length === tags.length
    && classificationTags.every((tag) => tags.includes(tag));
  const positionSemanticsAligned = normalized(positionSemantics?.id) === "new_position_after_previous_block_zero"
    && normalized(positionSemantics?.proofBoundary) === "previous_block"
    && positionSemantics?.lifetimeFirstBuyVerified === false
    && positionSemantics?.transactionImmediatePreBalanceVerified === false
    && source?.firstBuyVerified !== true;
  const profileMaxAgeMs = Math.max(60_000, Number(config?.fomoSmartMoneyMaxStatsAgeMs ?? config?.fomoSmartMoneyProfileMaxAgeMs ?? 7_200_000));
  const candidateMaxAgeMs = Math.max(60_000, Number(config?.fomoSmartMoneyCandidateRetentionMs ?? 86_400_000));
  const tradeMaxAgeMs = Math.max(60_000, Number(config?.fomoCallMaxSignalAgeMs ?? 300_000));
  const createdAt = Date.parse(profile?.createdAt || "");
  const walletOldEnough = Number.isFinite(createdAt) && Date.now() - createdAt >= 30 * 24 * 60 * 60_000;
  const profileAligned = profile?.scheme === "gmgn_wallet_stats_dual_window_v1"
    && profile?.qualified === true
    && normalized(profile?.source) === "gmgn_portfolio_stats"
    && normalized(profile?.wallet) === wallet
    && Number(profile?.chainId) === 56
    && freshIso(profile?.statsCheckedAt, profileMaxAgeMs)
    && freshIso(profile?.feedObservedAt, candidateMaxAgeMs)
    && walletOldEnough
    && Number.isSafeInteger(Number(profile?.createdTokenCount))
    && Number(profile.createdTokenCount) <= 10
    && !tags.some((tag) => FOCUS3_FOMO_DIRTY_GMGN_TAGS.has(tag) || SMART_WALLET_BLOCKED_TAG.test(tag))
    && finiteAtLeast(stats7d?.realizedProfitUsd, 3_000)
    && finiteAtLeast(stats7d?.winRate, 0.60)
    && finiteAtLeast(stats7d?.realizedRoi, 0.015)
    && finiteAtLeast(stats7d?.tokenCount, 50)
    && finiteAtLeast(stats30d?.realizedProfitUsd, 10_000)
    && finiteAtLeast(stats30d?.winRate, 0.60)
    && finiteAtLeast(stats30d?.realizedRoi, 0.015)
    && finiteAtLeast(stats30d?.tokenCount, 100);
  const tradeAligned = trade?.scheme === "gmgn_smartmoney_trade_v1"
    && normalized(trade?.wallet) === wallet
    && normalized(trade?.token) === token
    && normalized(trade?.transactionHash) === transactionHash
    && normalized(trade?.transactionFrom) === wallet
    && Number(trade?.receiptStatus) === 1
    && Number(trade?.logIndex ?? 0) === logIndex
    && Number(trade?.blockNumber) === blockNumber
    && normalized(trade?.side) === "buy"
    && (trade?.swapVerified === true || trade?.curveBuyVerified === true)
    && positiveIntegerString(trade?.paymentRaw)
    && positiveIntegerString(trade?.tokenDeltaRaw)
    && freshIso(trade?.occurredAt, tradeMaxAgeMs)
    && freshIso(trade?.observedAt, tradeMaxAgeMs);
  const tradeSwap = trade?.swapVerified === true;
  const tradeCurve = trade?.curveBuyVerified === true;
  const executionPoolAligned = /^0x[0-9a-f]{40}$/.test(executionPool)
    && tradeSwap !== tradeCurve
    && tradeSwap === (transactionProof?.swapVerified === true)
    && tradeCurve === (transactionProof?.curveBuyVerified === true)
    && normalized(trade?.executionPool) === executionPool
    && normalized(transactionProof?.executionPool) === executionPool
    && Number(trade?.executionPoolCount) === 1
    && Number(transactionProof?.executionPoolCount) === 1
    && trade?.executionPoolReceiptVerified === true
    && transactionProof?.executionPoolReceiptVerified === true
    && trade?.executionPairVerified === true
    && transactionProof?.executionPairVerified === true
    && trade?.exactExecutionPoolVerified === true
    && transactionProof?.exactExecutionPoolVerified === true
    && source?.executionPairVerified === true
    && market?.executionPairVerified === true
    && market?.exactExecutionPoolVerified === true
    && normalized(market?.executionPool || market?.pairAddress) === executionPool
    && (tradeCurve
      ? market?.curveVerified === true && normalized(source?.launchpad?.launcher) === executionPool
      : normalized(market?.pairAddress) === executionPool);
  const proofAligned = proof?.status === "verified"
    && proof?.complete === true
    && zeroPosition
    && normalized(proof?.wallet) === wallet
    && normalized(proof?.token) === token
    && normalized(proof?.transactionHash) === transactionHash
    && Number(proof?.blockNumber) === blockNumber;
  const transactionProofAligned = transactionProof?.scheme === "evm_wallet_buy_proof_v1"
    && Number(transactionProof?.chainId) === 56
    && normalized(transactionProof?.wallet) === wallet
    && normalized(transactionProof?.token) === token
    && normalized(transactionProof?.transactionHash) === transactionHash
    && normalized(transactionProof?.transactionFrom) === wallet
    && Number(transactionProof?.receiptStatus) === 1
    && Number(transactionProof?.blockNumber) === blockNumber
    && Number(transactionProof?.logIndex ?? 0) === logIndex
    && positiveIntegerString(transactionProof?.paymentRaw)
    && positiveIntegerString(transactionProof?.tokenDeltaRaw)
    && String(transactionProof?.paymentRaw) === String(trade?.paymentRaw)
    && String(transactionProof?.tokenDeltaRaw) === String(trade?.tokenDeltaRaw)
    && (transactionProof?.swapVerified === true || transactionProof?.curveBuyVerified === true)
    && transactionProof?.eoaVerified === true
    && normalized(transactionProof?.walletCode) === "0x"
    && freshIso(transactionProof?.eoaCheckedAt, profileMaxAgeMs)
    && transactionProof?.positionProof?.status === proof?.status
    && transactionProof?.positionProof?.complete === proof?.complete
    && normalized(transactionProof?.positionProof?.phase) === normalized(proof?.phase)
    && normalized(transactionProof?.positionProof?.wallet) === wallet
    && normalized(transactionProof?.positionProof?.token) === token
    && normalized(transactionProof?.positionProof?.transactionHash) === transactionHash
    && Number(transactionProof?.positionProof?.blockNumber) === blockNumber
    && String(transactionProof?.positionProof?.previousBalanceRaw ?? "") === "0"
    && String(transactionProof?.positionProof?.previousBalanceRaw) === String(proof?.previousBalanceRaw);
  return config?.fomoSmartMoneyMonitorEnabled === true
    && source?.type === "fomo_family_top_call"
    && source?.signalKind === SMART_WALLET_SIGNAL_KIND
    && Number(source?.chain?.id ?? source?.chain?.chainId) === 56
    && normalized(source?.chain?.slug) === "bsc"
    && source?.qualified === true
    && source?.strong === true
    && normalized(source?.source?.id) === SMART_WALLET_SOURCE_ID
    && normalized(source?.source?.trust) === SMART_WALLET_SOURCE_TRUST
    && (!source?.sourceTrust || normalized(source.sourceTrust) === SMART_WALLET_SOURCE_TRUST)
    && normalized(source?.platform?.id) === "smart-money"
    && source?.caller == null
    && source?.handle == null
    && (source?.callers == null || (Array.isArray(source.callers) && source.callers.length === 0))
    && source?.walletBinding == null
    && source?.walletAttribution == null
    && source?.fomoUrl == null
    && source?.profileUrl == null
    && /^0x[0-9a-f]{40}$/.test(wallet)
    && /^0x[0-9a-f]{40}$/.test(token)
    && (!source?.contractAddress || normalized(source.contractAddress) === token)
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
    && source?.security?.decision === "pass"
    && source?.security?.metrics?.liquidityConfirmed === true
    && source?.security?.metrics?.sellObserved === true
    && Number(source?.market?.liquidityUsd || 0) > 0;
}

export function isFomoConvergenceAlertAllowed(config, source, now = Date.now()) {
  if (source?.type !== "fomo_family_top_call"
    || source?.signalKind !== "top_blogger_convergence"
    || config?.fomoBuyMonitorEnabled === false
    || source?.qualified !== true
    || source?.strong !== true
    || Number(source?.chain?.id ?? source?.chain?.chainId) !== 56
    || normalized(source?.chain?.slug) !== "bsc") return false;

  const sourceId = normalized(source?.source?.id);
  const sourceTrust = normalized(source?.source?.trust);
  const sourceUrl = parsedHttpsUrl(source?.source?.url);
  if (sourceId !== "cope_capital"
    || sourceTrust !== "authorized_public_api"
    || (source?.sourceTrust && normalized(source.sourceTrust) !== sourceTrust)
    || sourceUrl?.hostname.toLowerCase().replace(/\.$/, "") !== "api.cope.capital") return false;

  const token = normalized(source?.token || source?.contractAddress);
  const directions = [source?.activity, source?.action, source?.side, source?.trade, source?.tradeSide, source?.transactionType]
    .map(normalized)
    .filter(Boolean);
  if (!/^0x[0-9a-f]{40}$/.test(token)
    || (source?.contractAddress && normalized(source.contractAddress) !== token)
    || !String(source?.callId || source?.stableId || "").trim()
    || directions.length === 0
    || !directions.every((value) => value === "buy")
    || source?.ambiguousIdentity === true
    || source?.ambiguousWallets === true
    || source?.ambiguousHandles === true
    || source?.security?.decision !== "pass"
    || source?.security?.metrics?.liquidityConfirmed !== true
    || source?.security?.metrics?.sellObserved !== true
    || !(Number(source?.market?.liquidityUsd || 0) > 0)) return false;

  const minimumFollowers = Math.max(0, Number(config?.fomoCallMinXFollowers || 10_000));
  const participants = Array.isArray(source?.callers) ? source.callers : [];
  const validParticipants = participants.filter((participant) => {
    const handle = normalized(participant?.handle).replace(/^@/, "");
    const wallet = normalized(participant?.walletAddress || participant?.wallet || participant?.baseAddress);
    return /^[a-z0-9_]{1,15}$/.test(handle)
      && /^0x[0-9a-f]{40}$/.test(wallet)
      && Number(participant?.followers) >= minimumFollowers
      && Number(participant?.amountUsd) > 0;
  });
  const uniqueHandles = new Set(validParticipants.map((participant) => normalized(participant.handle).replace(/^@/, "")));
  const uniqueWallets = new Set(validParticipants.map((participant) => normalized(
    participant.walletAddress || participant.wallet || participant.baseAddress,
  )));
  const minimumTotalUsd = Math.max(1_000, Number(config?.fomoCallMinConvergenceUsd || 5_000));
  if (uniqueHandles.size < 2
    || uniqueWallets.size < 2
    || Number(source?.buyerCount) < 2
    || Number(source?.totalUsd || 0) < minimumTotalUsd) return false;

  const observedAt = Date.parse(source?.observedAt || "");
  const publishedAt = Date.parse(source?.publishedAt || "");
  const evaluatedAt = Number(now);
  const maximumAgeMs = Math.max(1_000, Number(config?.fomoCallMaxSignalAgeMs || 300_000));
  return Number.isFinite(evaluatedAt)
    && Number.isFinite(observedAt)
    && Number.isFinite(publishedAt)
    && publishedAt <= observedAt + 60_000
    && observedAt <= evaluatedAt + 60_000
    && evaluatedAt - publishedAt <= maximumAgeMs;
}

function focus3FomoCallAllowed(config, source) {
  if (source?.signalKind === SMART_WALLET_SIGNAL_KIND) return focus3SmartWalletBuyAllowed(config, source);
  if (source?.signalKind === "top_blogger_convergence") return isFomoConvergenceAlertAllowed(config, source);
  if (source?.signalKind === "fomo_published_call") {
    const sourceId = normalized(source?.source?.id);
    const sourceTrust = normalized(source?.source?.trust);
    const expectedTrust = FOCUS3_FOMO_PUBLISHED_SOURCES.get(sourceId);
    const twitterMatch = String(source?.caller?.twitter || "").match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i);
    const handle = normalized(source?.caller?.handle || source?.handle);
    const thesisText = String(source?.thesis?.text || "").trim();
    const callId = String(source?.callId || source?.stableId || "").trim();
    const minimumFollowers = Math.max(0, Number(config?.fomoPublishedCallMinXFollowers ?? config?.fomoCallMinXFollowers ?? 10_000));
    const publishedAt = Date.parse(source?.publishedAt || source?.thesis?.createdAt || "");
    const observedAt = Date.parse(source?.observedAt || "");
    const maximumAgeMs = Math.max(1_000, Number(config?.fomoPublishedCallMaxAgeMs || 120_000));
    const timingValid = Number.isFinite(publishedAt)
      && Number.isFinite(observedAt)
      && publishedAt <= observedAt + 60_000
      && observedAt - publishedAt <= maximumAgeMs;
    return config?.fomoPublishedCallEnabled === true
      && source?.type === "fomo_family_top_call"
      && Number(source?.chain?.id ?? source?.chain?.chainId) === 56
      && normalized(source?.chain?.slug) === "bsc"
      && source?.qualified === true
      && source?.strong === true
      && Boolean(expectedTrust)
      && sourceTrust === expectedTrust
      && (!source?.sourceTrust || normalized(source.sourceTrust) === expectedTrust)
      && source?.security?.decision === "pass"
      && source?.security?.metrics?.liquidityConfirmed === true
      && source?.security?.metrics?.sellObserved === true
      && Number(source?.market?.liquidityUsd || 0) > 0
      && thesisText.length > 0
      && callId.length > 0
      && handle.length > 0
      && Boolean(twitterMatch)
      && normalized(twitterMatch?.[1]) === handle
      && Number(source?.caller?.followers) >= minimumFollowers
      && timingValid;
  }
  if (source?.signalKind === "fomo_x_call") {
    const sourceId = normalized(source?.source?.id);
    const sourceTrust = normalized(source?.source?.trust);
    const tweet = source?.tweet || {};
    const handle = normalized(source?.caller?.handle || source?.handle);
    const tweetHandle = normalized(tweet?.handle);
    const postId = String(tweet?.id || "").trim();
    const postUrl = String(tweet?.url || source?.url || "").trim();
    const postMatch = postUrl.match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?(?:[?#].*)?$/i);
    const callerTwitter = String(source?.caller?.twitter || "").match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i);
    const xProfileId = String(source?.caller?.xProfileId || source?.caller?.xUserId || "").trim();
    const tweetUserId = String(tweet?.xUserId || tweet?.authorId || "").trim();
    const identitySource = normalized(source?.caller?.identitySource);
    const publishedAt = Date.parse(source?.publishedAt || tweet?.createdAt || "");
    const observedAt = Date.parse(source?.observedAt || "");
    const maximumAgeMs = Math.max(1_000, Number(config?.fomoXCallMaxPostAgeMs || 300_000));
    const timingValid = Number.isFinite(publishedAt)
      && Number.isFinite(observedAt)
      && publishedAt <= observedAt + 60_000
      && observedAt - publishedAt <= maximumAgeMs;
    const wallet = normalized(source?.walletAddress);
    const binding = source?.walletBinding;
    const identityMaximumAgeMs = Math.max(60_000, Number(config?.fomoXCallAttributionMaxAgeMs || config?.fomoCallGmgnAttributionMaxAgeMs || 86_400_000));
    const eventObservedAt = Date.parse(source?.observedAt || "");
    const identityWallClock = Date.now();
    // Identity evidence is evaluated at the immutable event observation time.
    // Alert freshness independently rejects stale replays, while this keeps a
    // durable forensic event routable after restart or in deterministic tests.
    const identityReferenceAt = Number.isFinite(eventObservedAt)
      && identityWallClock - eventObservedAt > identityMaximumAgeMs
      ? eventObservedAt
      : identityWallClock;
    const bindingCheckedAt = Date.parse(binding?.checkedAt || binding?.lastCheckedAt || "");
    const bindingFresh = Number.isFinite(bindingCheckedAt)
      && bindingCheckedAt <= identityReferenceAt + 60_000
      && identityReferenceAt - bindingCheckedAt <= identityMaximumAgeMs;
    const callerProfileCheckedAt = Date.parse(source?.caller?.followersSyncedAt || "");
    const callerProfileFresh = Number.isFinite(callerProfileCheckedAt)
      && callerProfileCheckedAt <= identityReferenceAt + 60_000
      && identityReferenceAt - callerProfileCheckedAt <= identityMaximumAgeMs;
    const bindingValid = binding?.status === "verified"
      && binding?.verified === true
      && normalized(binding?.proofSource) === "fomoscan"
      && normalized(binding?.wallet) === wallet
      && normalized(binding?.handle) === handle
      && normalized(binding?.twitterHandle) === handle
      && /^\d+$/.test(String(binding?.xProfileId || binding?.xUserId || ""))
      && String(binding?.xProfileId || binding?.xUserId) === xProfileId
      && identitySource === "fomoscan+fxtwitter"
      && source?.walletAttribution == null
      && bindingFresh
      && callerProfileFresh;
    const attribution = source?.walletAttribution;
    const tags = Array.isArray(attribution?.tags) ? attribution.tags.map(normalized) : [];
    const attributionOrigin = normalized(attribution?.candidateSource || attribution?.originSource);
    const attributionMaxAgeMs = identityMaximumAgeMs;
    const attributionTimes = [
      attribution?.observedAt,
      attribution?.xFollowersCheckedAt,
      attribution?.bscActivityCheckedAt,
    ].map((value) => Date.parse(value || ""));
    const attributionFresh = attributionTimes.every((value) => Number.isFinite(value)
      && value <= identityReferenceAt + 60_000
      && identityReferenceAt - value <= attributionMaxAgeMs);
    const attributionValid = config?.fomoCallAllowGmgnObservedWallets === true
      && attribution?.scheme === "gmgn_x_maker_observation_v1"
      && attribution?.status === "observed"
      && attribution?.verified === false
      && attribution?.ambiguousIdentity === false
      && attribution?.ambiguousWallets === false
      && attribution?.ambiguousHandles === false
      && normalized(attribution?.source) === "gmgn_bsc_kol_feed"
      && attributionOrigin === "gmgn_bsc_kol_feed"
      && attribution?.fomoTagged === true
      && tags.includes("kol")
      && tags.includes("fomo")
      && !tags.some((tag) => FOCUS3_FOMO_DIRTY_GMGN_TAGS.has(tag))
      && attributionFresh
      && normalized(attribution?.monitoringWallet) === wallet
      && normalized(attribution?.xHandle) === handle
      && String(attribution?.xProfileId || "") === xProfileId
      && Number(attribution?.bscTransactionCount) > 0
      && identitySource === "gmgn+fxtwitter"
      && binding == null;
    const callText = String(source?.thesis?.text || source?.body || tweet?.text || "").trim();
    const token = normalized(source?.token || source?.contractAddress);
    const mentionedContracts = [...new Set((callText.match(/(?<![0-9A-Fa-f])0x[0-9A-Fa-f]{40}(?![0-9A-Fa-f])/g) || []).map(normalized))];
    const minimumFollowers = Math.max(0, Number(config?.fomoXCallMinXFollowers ?? config?.fomoCallMinXFollowers ?? 10_000));
    return config?.fomoXCallEnabled === true
      && source?.type === "fomo_family_top_call"
      && sourceId === "fomo_linked_x_post"
      && sourceTrust === "public_x_identity_linked"
      && (!source?.sourceTrust || normalized(source.sourceTrust) === sourceTrust)
      && source?.qualified === true
      && source?.strong === true
      && Number(source?.chain?.id ?? source?.chain?.chainId) === 56
      && normalized(source?.chain?.slug) === "bsc"
      && source?.security?.decision === "pass"
      && source?.security?.metrics?.liquidityConfirmed === true
      && source?.security?.metrics?.sellObserved === true
      && Number(source?.market?.liquidityUsd || 0) > 0
      && callText.length > 0
      && /^0x[0-9a-f]{40}$/.test(token)
      && normalized(source?.contractAddress || token) === token
      && mentionedContracts.length === 1
      && mentionedContracts[0] === token
      && handle.length > 0
      && tweetHandle === handle
      && Boolean(callerTwitter)
      && normalized(callerTwitter?.[1]) === handle
      && /^\d+$/.test(postId)
      && Boolean(postMatch)
      && normalized(postMatch?.[1]) === handle
      && postMatch?.[2] === postId
      && tweet?.sourceVerifiedBy === "official_x_oembed"
      && xProfileId.length > 0
      && tweetUserId === xProfileId
      && Number(source?.caller?.followers) >= minimumFollowers
      && timingValid
      && /^0x[0-9a-f]{40}$/.test(wallet)
      && (bindingValid || attributionValid);
  }
  if (config?.fomoBuyMonitorEnabled === false) return false;
  const binding = source?.walletBinding;
  const bindingStatus = typeof binding === "string"
    ? normalized(binding)
    : normalized(binding?.status);
  const bindingVerified = binding && typeof binding === "object" && bindingStatus === "verified" && binding.verified === true;
  const bindingProofSource = normalized(binding && typeof binding === "object" ? binding.proofSource : null);
  const callerTwitterMatch = String(source?.caller?.twitter || "").match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i);
  const callerHandle = normalized(source?.caller?.handle);
  const callerXProfileId = String(source?.caller?.xProfileId || source?.caller?.xUserId || "").trim();
  const callerIdentitySource = normalized(source?.caller?.identitySource);
  const identityMaxAgeMs = Math.max(60_000, Number(config?.fomoCallMaxXProfileAgeMs || config?.fomoCallGmgnAttributionMaxAgeMs || 86_400_000));
  const nowMs = Date.now();
  const freshTimestamp = (value) => {
    const timestamp = Date.parse(value || "");
    return Number.isFinite(timestamp) && timestamp <= nowMs + 60_000 && nowMs - timestamp <= identityMaxAgeMs;
  };
  const bindingXProfileId = String(binding && typeof binding === "object" ? binding.xProfileId || binding.xUserId || "" : "").trim();
  const bindingCheckedAt = binding && typeof binding === "object" ? binding.checkedAt || binding.lastCheckedAt : null;
  const fomoScanBinding = bindingVerified
    && bindingProofSource === "fomoscan"
    && callerIdentitySource === "fomoscan+fxtwitter"
    && normalized(binding?.wallet) === normalized(source?.walletAddress)
    && normalized(binding?.handle) === callerHandle
    && normalized(binding?.twitterHandle) === callerHandle
    && Boolean(callerTwitterMatch)
    && normalized(callerTwitterMatch?.[1]) === callerHandle
    && /^\d+$/.test(callerXProfileId)
    && bindingXProfileId === callerXProfileId
    && freshTimestamp(bindingCheckedAt)
    && freshTimestamp(source?.caller?.followersSyncedAt)
    && source?.walletAttribution == null;
  const proof = source?.positionProof;
  const proofPhase = normalized(proof?.phase);
  const zeroPosition = (proofPhase === "previous_block" && String(proof?.previousBalanceRaw ?? "") === "0")
    || (proofPhase === "immediately_before_transaction" && String(proof?.totalWalletPreRaw ?? "") === "0");
  const explicitDirections = [source?.activity, source?.action, source?.side, source?.tradeSide, source?.transactionType]
    .map(normalized)
    .filter(Boolean);
  const buyDirection = explicitDirections.length > 0
    && explicitDirections.every((value) => ["buy", "first_buy", "swap_buy", "top_blogger_first_buy"].includes(value));
  const eventWallet = normalized(source?.walletAddress);
  const eventToken = normalized(source?.token || source?.contractAddress);
  const eventTransactionHash = normalized(source?.transactionHash);
  const proofAligned = proof?.complete === true
    && /^0x[0-9a-f]{40}$/.test(eventWallet)
    && /^0x[0-9a-f]{40}$/.test(eventToken)
    && /^0x[0-9a-f]{64}$/.test(eventTransactionHash)
    && normalized(proof?.wallet) === eventWallet
    && normalized(proof?.token) === eventToken
    && normalized(proof?.transactionHash) === eventTransactionHash
    && Number.isSafeInteger(Number(source?.blockNumber))
    && Number(source.blockNumber) === Number(proof?.blockNumber);
  const commonAllowed = source?.type === "fomo_family_top_call"
    && source?.signalKind === "top_blogger_first_buy"
    && Number(source?.chain?.id) === 56
    && normalized(source?.chain?.slug) === "bsc"
    && source?.qualified === true
    && source?.strong === true
    && FOCUS3_FOMO_SOURCE_TRUST.has(normalized(source?.source?.trust))
    && source?.security?.decision === "pass"
    && source?.security?.metrics?.liquidityConfirmed === true
    && source?.security?.metrics?.sellObserved === true
    && Number(source?.market?.liquidityUsd || 0) > 0
    && normalized(proof?.status) === "verified"
    && proofAligned
    && zeroPosition
    && buyDirection
    && Boolean(callerTwitterMatch)
    && normalized(callerTwitterMatch?.[1]) === callerHandle
    && callerHandle !== ""
    && /^\d+$/.test(callerXProfileId)
    && Number(source?.caller?.followers) >= 10_000;
  if (!commonAllowed) return false;

  if (fomoScanBinding) {
    return ["public_onchain_verified", "authorized_public_api"].includes(normalized(source?.source?.trust))
      && normalized(source?.source?.id) === "fomoscan_onchain";
  }

  const attribution = source?.walletAttribution;
  const tags = Array.isArray(attribution?.tags) ? attribution.tags.map(normalized) : [];
  const maxAgeMs = Math.max(60_000, Number(config?.fomoCallGmgnAttributionMaxAgeMs || 86_400_000));
  const timestamps = [
    attribution?.observedAt,
    attribution?.xFollowersCheckedAt,
    attribution?.bscActivityCheckedAt,
    source?.caller?.followersSyncedAt,
  ].map((value) => Date.parse(value || ""));
  const timestampsFresh = timestamps.every((value) => Number.isFinite(value)
    && value <= nowMs + 60_000
    && nowMs - value <= maxAgeMs);
  const monitoringWallet = normalized(attribution?.monitoringWallet);
  const xHandle = normalized(attribution?.xHandle);
  const attributionOrigin = normalized(attribution?.candidateSource || attribution?.originSource);

  return config?.fomoCallAllowGmgnObservedWallets === true
    && binding == null
    && normalized(source?.source?.id) === "gmgn_kol_onchain"
    && normalized(source?.source?.trust) === "public_onchain_attributed"
    && attribution?.scheme === "gmgn_x_maker_observation_v1"
    && attribution?.status === "observed"
    && attribution?.verified === false
    && normalized(attribution?.source) === "gmgn_bsc_kol_feed"
    && attributionOrigin === "gmgn_bsc_kol_feed"
    && attribution?.ambiguousIdentity === false
    && attribution?.ambiguousWallets === false
    && attribution?.ambiguousHandles === false
    && attribution?.fomoTagged === true
    && tags.includes("kol")
    && tags.includes("fomo")
    && !tags.some((tag) => FOCUS3_FOMO_DIRTY_GMGN_TAGS.has(tag))
    && timestampsFresh
    && monitoringWallet !== ""
    && monitoringWallet === eventWallet
    && monitoringWallet === normalized(proof?.wallet)
    && xHandle !== ""
    && xHandle === callerHandle
    && xHandle === normalized(callerTwitterMatch?.[1])
    && callerIdentitySource === "gmgn+fxtwitter"
    && String(attribution?.xProfileId || "") !== ""
    && String(attribution?.xProfileId) === String(source?.caller?.xProfileId || "")
    && Number(attribution?.bscTransactionCount) > 0
    && proofAligned;
}

function focus3EventAllowed(source) {
  if (!source?.type) return isThreePlatformSource(source);
  if (FOCUS3_BLOCKED_EVENT_TYPES.has(source.type) || !isThreePlatformSource(source)) return false;
  // A recovery envelope is a privileged, finite migration lane. Its mere
  // presence must never inherit admission from the ordinary Twitter signal;
  // revalidate the immutable tweet, exact source proofs and full envelope.
  if (Object.prototype.hasOwnProperty.call(source, "policyFixRecovery")) {
    return isFourMemePolicyFixRecoveryEvent(source);
  }
  const officialFlapQuotePair = isOfficialFlapQuotePairUpdate(source);
  const strictFlapQuoteAsset = isStrictFlapQuoteAssetUpdate(source);
  const strictFlapTrackedToken = isStrictFlapTrackedPoolTokenUpdate(source);
  const strictBscOpenFourFirstToken = isStrictBscOpenFourFirstTokenUpdate(source);
  const strictFourRegistryCapability = isStrictFourRegistryCapabilityUpdate(source);
  const strictFourRegistryFirstToken = isStrictFourRegistryFirstTokenUpdate(source);
  const strictFourMemeMarketCampaign = isStrictFourMemeMarketCampaign(source);
  // Stock/equity/RWA issuance is deliberately out of scope across every
  // first-party lane. Keep this final routing gate in addition to individual
  // source classifiers so queued or newly introduced event shapes cannot leak
  // those announcements into Telegram. The only exception is a structurally
  // revalidated Flap quote pair from the exact official X identity, or a full
  // BSC quote-asset record from the exact official board source.
  if (focus3StockRwaSignal(source)
    && !officialFlapQuotePair
    && !strictFlapQuoteAsset
    && !strictFlapTrackedToken
    && !strictBscOpenFourFirstToken
    && !strictFourRegistryCapability
    && !strictFourRegistryFirstToken
    && !strictFourMemeMarketCampaign) return false;
  if (source.type === "uniswap_official_update") return source.strong === true && focus3UniswapSignal(source);
  if (source.type === "bsc_launchpad_update") {
    if (claimsFourRegistryUpdate(source)) return strictFourRegistryFirstToken;
    if (source.kind === FLAP_TRACKED_TOKEN_KIND) return strictFlapTrackedToken;
    if (claimsBscOpenFourFirstTokenUpdate(source)) return strictBscOpenFourFirstToken;
    if (source.kind === "new_mode" && source.structural?.source === "official_api") {
      return isOfficialFourMemeCapabilityUpdate(source);
    }
    const focusKind = ["new_mode", "new_factory"].includes(source.kind)
      || (source.kind === "new_launchpad" && source.officialFirstToken === true);
    return focusKind
      && source.strong === true
      && source.structural?.eligible === true;
  }
  if (source.type === "evm_launchpad_update") {
    return Number(source.chainId || source.chain?.id) === 2818
      && ["flap", "long"].includes(compact(source.platform?.id || source.platform?.name))
      && ["portal_upgrade", "new_mode", "official_deployment"].includes(source.kind)
      && source.strong === true
      && source.structural?.eligible === true;
  }
  if (source.type === "token_launch") {
    return source.modeStatus === "new_mode_confirmed"
      && source.launchpad?.match === "exact_factory"
      && Number(source.modeConfirmation?.observations || 0) >= 2;
  }
  if (source.type === "platform_capability_update") {
    if (claimsFourRegistryUpdate(source)) return strictFourRegistryCapability;
    if (claimsFlapQuoteAssetCapability(source)) return strictFlapQuoteAsset;
    return hasFocus3CapabilityChange(source);
  }
  if (source.type === "github_module_update") {
    const actionable = source.strong === true
      || source.modeChange?.candidate === true
      || source.chainSupportChange?.candidate === true
      || source.chainSupport?.length > 0
      || source.newContracts?.length > 0
      // Binance connector dependency/version releases remain monitored as
      // ordinary maintenance alerts. They are intentionally non-strong, but
      // must not disappear at the routing gate after the repository cursor
      // has advanced.
      || source.binanceChange?.classification === "sdk_maintenance";
    if (source.uniswapOfficial === true || compact(source.launchpad).startsWith("uniswap")) {
      return source.sourceTrust === "official_verified" && actionable && focus3UniswapSignal(source);
    }
    return source.sourceTrust === "official_verified" && actionable;
  }
  if (source.type === "github_monitor_gap") return focus3GithubGapAllowed(source);
  if (source.type === "github_repository_discovered") {
    return source.sourceTrust === "official_verified";
  }
  if (source.type === "github_repository_verified") return false;
  if (source.type === "launchpad_site_update") {
    return Boolean(source.newContracts?.length || source.newChains?.length || source.chainSupport?.length);
  }
  if (source.type === "twitter_update") {
    if (source.project?.signalProfile === "uniswap" || source.project?.signalProfile === "uniswap-pools" || source.uniswapOfficial === true) {
      return source.signal?.relevant === true && source.signal?.strong === true && focus3UniswapSignal(source);
    }
    if (source.signal?.quotePairChange != null || classifyFlapQuotePairSignalCore(source.tweet?.text)) {
      return officialFlapQuotePair;
    }
    if (source.signal?.namedMode != null || classifyFourMemeNamedModeCore(source.tweet?.text)) {
      return isOfficialFourMemeNamedModeUpdate(source);
    }
    if (source.signal?.marketCampaign != null || classifyFourMemeMarketCampaignCore(source.tweet?.text)) {
      return strictFourMemeMarketCampaign;
    }
    return source.signal?.platformStructural === true
      && source.signal?.labels?.some((label) => FOCUS3_TWITTER_SIGNALS.has(label)) === true;
  }
  return false;
}

const isPonsIdentity = (value) => {
  const text = normalized(value);
  return text === "pons"
    || text === "pons v2"
    || text === "pons-v2"
    || text === "ponsdotfamily"
    || text === "@ponsdotfamily"
    || PONS_REPOSITORIES.has(text)
    || /^pons(?:dot(?:dev|family)|[-_](?:labs?|family))\/[a-z0-9_.-]+$/.test(text)
    || PONS_ADDRESSES.has(text)
    || /^(?:https?:\/\/)?(?:www\.)?(?:docs\.)?ponsfamily\.com(?:\/|$)/i.test(text)
    || /^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/ponsdotfamily(?:\/|$)/i.test(text);
};

export function isPonsSource(source) {
  if (isPonsIdentity(source)) return true;
  if (!source || typeof source !== "object") return false;
  if (normalized(source.type).startsWith("pons_")) return true;
  if (isPonsIdentity(source.repository)) return true;
  for (const key of ["id", "name", "handle", "projectId", "platformId", "launchpadId", "website", "docs", "twitter", "factory", "launcher", "actor", "sourceContract"]) {
    if (isPonsIdentity(source[key])) return true;
  }
  for (const key of ["project", "platform", "launchpad"]) {
    if (isPonsSource(source[key])) return true;
  }
  for (const key of ["factories", "addresses"]) {
    if (Array.isArray(source[key]) && source[key].some(isPonsIdentity)) return true;
  }
  return false;
}

export function isPonsMonitoringEnabled(config) {
  return config?.ponsMonitorEnabled !== false;
}

function hasOnlyKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function safeHealthCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

function safeHealthDuration(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= FOMO_HEALTH_MAX_OPERATIONAL_AGE_MS;
}

function validHealthLane(value, keys) {
  return hasOnlyKeys(value, new Set(keys)) && FOMO_HEALTH_LEVELS.has(value.status);
}

function fomoHealthReasonDigest(reasonCodes, summary) {
  const criticalLanes = Object.entries(summary || {})
    .filter(([, lane]) => lane?.status === "critical")
    .map(([lane]) => lane)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify({ reasonCodes: [...new Set(reasonCodes)].sort(), criticalLanes }))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Authenticate the one locally generated operational event. Its closed schema
 * contains only aggregate health levels and bounded counters: raw errors,
 * handles, addresses, URLs and credentials cannot cross this routing gate.
 */
export function isFomoMonitorHealthUpdateAllowed(config, source, now = Date.now()) {
  if (config?.fomoHealthMonitorEnabled !== true
    || !source || typeof source !== "object" || Array.isArray(source)
    || source.type !== "fomo_monitor_health_update") return false;
  const allowedTopLevel = new Set([
    "type", "eventKey", "lane", "transition", "incidentId", "aggregateStatus",
    "observedAt", "openedAt", "durationMs", "reasonCodes", "summary", "source",
    "sourceTrust", "strong", "alertQueuedAt", "reasonDigest",
  ]);
  if (!hasOnlyKeys(source, allowedTopLevel)
    || source.lane !== "aggregate"
    || !["opened", "updated", "recovered"].includes(source.transition)
    || !/^aggregate-\d{1,16}$/.test(String(source.incidentId || ""))
    || source.aggregateStatus !== (source.transition === "recovered" ? "healthy" : "critical")
    || source.strong !== false
    || source.sourceTrust !== FOMO_HEALTH_SOURCE_TRUST
    || !hasOnlyKeys(source.source, new Set(["id", "trust"]))
    || source.source.id !== FOMO_HEALTH_SOURCE_ID
    || source.source.trust !== FOMO_HEALTH_SOURCE_TRUST
    || !Array.isArray(source.reasonCodes)
    || source.reasonCodes.length > 20
    || new Set(source.reasonCodes).size !== source.reasonCodes.length
    || !source.reasonCodes.every((reason) => FOMO_HEALTH_REASON_CODES.has(reason))) return false;
  const evaluatedAt = Number(now);
  const observedAt = strictTelegramNewsInstant(source.observedAt);
  const openedAt = strictTelegramNewsInstant(source.openedAt);
  if (!Number.isFinite(evaluatedAt) || observedAt === null || openedAt === null
    || observedAt > evaluatedAt + 60_000 || evaluatedAt - observedAt > FOMO_HEALTH_MAX_OPERATIONAL_AGE_MS
    || openedAt > observedAt
    || !safeHealthDuration(source.durationMs)
    || source.durationMs !== observedAt - openedAt) return false;
  if (source.alertQueuedAt != null && strictTelegramNewsInstant(source.alertQueuedAt) === null) return false;

  const summary = source.summary;
  if (!hasOnlyKeys(summary, new Set(["smartMoney", "bsc", "x", "thesis", "outbox"]))) return false;
  if (!validHealthLane(summary.smartMoney, ["status", "admitted", "fresh", "lastKnownGood"])
    || !safeHealthCount(summary.smartMoney.admitted)
    || !safeHealthCount(summary.smartMoney.fresh)
    || !safeHealthCount(summary.smartMoney.lastKnownGood)
    || !validHealthLane(summary.bsc, ["status"])
    || !validHealthLane(summary.x, ["status", "live", "eligible"])
    || !safeHealthCount(summary.x.live)
    || !safeHealthCount(summary.x.eligible)
    || summary.x.live > summary.x.eligible
    || !validHealthLane(summary.thesis, ["status"])
    || !validHealthLane(summary.outbox, ["status", "pending", "failed"])
    || !safeHealthCount(summary.outbox.pending)
    || !safeHealthCount(summary.outbox.failed)
    || summary.outbox.failed > summary.outbox.pending) return false;
  const summaryLevels = Object.values(summary).map((lane) => lane.status);
  if (source.transition === "recovered") {
    if (summaryLevels.some((level) => !["healthy", "disabled"].includes(level))) return false;
  } else if (!summaryLevels.includes("critical")) return false;
  const expectedDigest = fomoHealthReasonDigest(source.reasonCodes, summary);
  if (source.transition === "updated") {
    if (source.reasonDigest !== expectedDigest
      || source.eventKey !== `fomo-health:${source.incidentId}:updated:${expectedDigest}`) return false;
  } else if (source.reasonDigest != null
    || source.eventKey !== `fomo-health:${source.incidentId}:${source.transition}`) return false;
  return source.transition === "recovered" || source.reasonCodes.length > 0;
}

export function isMonitoringSourceEnabled(config, source) {
  if (source?.type === "gmgn_flow_surge" || source?.source?.id === "gmgn_flow_observed") {
    return config?.gmgnFlowMonitorEnabled === true && isGmgnFlowEvent(source)
      && Date.parse(source.observedAt) <= Date.now() + 30_000;
  }
  // Genius is an explicit independent lane, not an addition to the generic
  // focus3 matcher. Claimed Genius provenance must fail closed in every scope.
  if (claimsGeniusSource(source)) return config?.geniusMonitorEnabled === true && isGeniusOfficialEvent(source);
  if (isKolSelfLaunchEvent(source)) {
    const verification = verifyKolTokenLaunchEvent(source);
    const minimumFollowers = Number(config?.kolLaunchMinXFollowers
      ?? config?.fomoXCallMinXFollowers
      ?? 10_000);
    const capitalIdentity = String(source?.caller?.identitySource || "").toLowerCase()
      === "reviewed_catalog+fxtwitter";
    const enabledCategories = Array.isArray(config?.kolCapitalCategories)
      ? config.kolCapitalCategories.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    const capitalCategory = String(source?.caller?.capitalKolSnapshot?.category
      || source?.capitalKolSnapshot?.category || "").trim();
    const capitalRosterAllowed = capitalIdentity
      && config?.kolCapitalRosterEnabled === true
      && (enabledCategories.length === 0 || enabledCategories.includes(capitalCategory));
    return config?.fomoCallEnabled !== false
      && config?.kolLaunchMonitorEnabled === true
      && Number.isFinite(minimumFollowers)
      && minimumFollowers >= 0
      && verification.valid
      && (capitalIdentity
        ? capitalRosterAllowed
        : Number(source?.caller?.followers) >= minimumFollowers);
  }
  // Narrative trade signals are internal, deterministic derivatives of an
  // already admitted source event. They have their own integrity gate in the
  // alert pipeline and are opt-in independently from the originating monitor.
  if (source?.type === "narrative_trade_signal") {
    return config?.narrativeSniperEnabled === true;
  }
  if (source?.type === "fomo_monitor_health_update") {
    return isFomoMonitorHealthUpdateAllowed(config, source);
  }
  if (source?.type === "telegram_news_update") {
    return config?.telegramNewsMonitorEnabled === true && isTelegramNewsUpdateAllowed(source);
  }
  // pon.fun is an explicit opt-in lane in every scope.  Evaluate it before the
  // generic focus3 stock/RWA exclusion, while keeping legacy Pons and ordinary
  // RWA/token events on their existing paths.
  if (claimsPonFunIdentity(source)) return focus3PonFunOfficialSourceAllowed(config, source);
  if (!isPonsMonitoringEnabled(config) && isPonsSource(source)) return false;
  if (source?.type === "fomo_family_top_call") {
    if (config?.fomoCallEnabled === false) return false;
    if (source?.signalKind === SMART_WALLET_SIGNAL_KIND && config?.fomoSmartMoneyMonitorEnabled !== true) return false;
    if (source?.signalKind === "fomo_published_call" && config?.fomoPublishedCallEnabled !== true) return false;
    if (source?.signalKind === "fomo_x_call" && config?.fomoXCallEnabled !== true) return false;
    if (!["fomo_published_call", "fomo_x_call", SMART_WALLET_SIGNAL_KIND].includes(source?.signalKind) && config?.fomoBuyMonitorEnabled === false) return false;
  }
  if (isThreePlatformScope(config)) {
    if (focus3BinanceOfficialSourceAllowed(config, source)) return true;
    if (claimsBinanceIdentity(source)) return false;
    if (focus3AiOfficialSourceAllowed(config, source)) return true;
    if (claimsAiIdentity(source)) return false;
    if (source?.type === "github_monitor_gap") return focus3EventAllowed(source);
    if (source?.type === "fomo_family_top_call") {
      return config?.fomoCallEnabled === true && focus3FomoCallAllowed(config, source);
    }
    return focus3EventAllowed(source);
  }
  return true;
}
