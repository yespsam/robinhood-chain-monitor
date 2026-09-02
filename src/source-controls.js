import { createHash } from "node:crypto";

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
  "newQuoteConfigs",
  "updatedQuoteConfigs",
  "quoteConfigChanges",
  "newContracts",
  "newModules",
  "newVersions",
  "newPackages",
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
const FOCUS3_STOCK_RWA_EXCLUDED = /(?:\b(?:rwa|stocks?|stock[- ]meme|tokeni[sz]ed\s+(?:assets?|stocks?|equities|securities)|real[- ]world\s+assets?|equity\s+(?:issuance|offering|launch|tokens?|tokenization)|securit(?:y|ies)\s+(?:issuance|offering|tokens?|tokenization))\b|股票|证券|股权|现实世界资产|实物资产|配股)/i;
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
  if (!boundedTelegramNewsText(news.category, 80)
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
  // Stock/equity/RWA issuance is deliberately out of scope across every
  // first-party lane. Keep this final routing gate in addition to individual
  // source classifiers so queued or newly introduced event shapes cannot leak
  // those announcements into Telegram.
  if (focus3StockRwaSignal(source)) return false;
  if (source.type === "uniswap_official_update") return source.strong === true && focus3UniswapSignal(source);
  if (source.type === "bsc_launchpad_update") {
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
  if (source.type === "platform_capability_update") return hasFocus3CapabilityChange(source);
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
  if (source?.type === "fomo_monitor_health_update") {
    return isFomoMonitorHealthUpdateAllowed(config, source);
  }
  if (source?.type === "telegram_news_update") {
    return config?.telegramNewsMonitorEnabled === true && isTelegramNewsUpdateAllowed(source);
  }
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
