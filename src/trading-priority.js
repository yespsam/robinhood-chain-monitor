const PRIORITY_SCHEMA = "news_trading_priority_v1";

export const TRADING_PRIORITY_VERSION = 1;
export const TRADING_TIERS = Object.freeze(["T0", "T1", "T2", "T3"]);

const TIER_RANK = Object.freeze({ T0: 4, T1: 3, T2: 2, T3: 1 });
const BINANCE_SOURCE_IDS = new Set([
  "binance_exchange_cms",
  "binance_announcement_websocket",
  "binance_wallet_cms",
  "binance_square_cms",
  "binance_developer_docs",
  "meme_rush_api",
  "launchpool_api",
]);
const OFFICIAL_TRUST = new Set([
  "official_verified",
  "official_authenticated_api",
  "verified_thesis_relay",
  "authorized_public_api",
]);
const FOMO_SINGLE_KINDS = new Set([
  "high_profit_high_winrate_wallet_buy",
  "top_blogger_first_buy",
  "fomo_x_call",
]);
const FOMO_OFFICIAL_KINDS = new Set(["fomo_published_call"]);
const BINANCE_T0_LABELS = new Set([
  "现货首次上币",
  "新币上线",
  "Alpha 上新",
  "新合约上线",
  "整币下架",
  "安全/紧急公告",
]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const lower = (value) => clean(value).toLowerCase();
const list = (value) => Array.isArray(value) ? value : [];
const validAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(clean(value));
const validTransaction = (value) => /^0x[a-fA-F0-9]{64}$/.test(clean(value));

function normalizedPlatform(event = {}) {
  const value = event.platform?.id || event.platform?.name || event.project?.id || event.project?.name
    || event.launchpad?.id || event.launchpad?.name || event.launchpad || "";
  return lower(value).replace(/[^a-z0-9]/g, "");
}

function eventText(event = {}) {
  return [
    event.title,
    event.message,
    event.summary,
    event.factSummary,
    event.body,
    event.thesis?.text,
    event.tweet?.text,
    event.signal?.headline,
    event.signal?.category,
    ...list(event.signal?.labels),
    ...list(event.signal?.claims),
    ...list(event.signal?.keyChanges),
    ...list(event.keyChanges),
    ...list(event.addedSignals),
    ...list(event.removedSignals),
  ].filter(Boolean).join(" ");
}

function parseInstant(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (/^\d{10,13}$/.test(clean(value))) {
    const numeric = Number(value);
    return clean(value).length === 10 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstInstant(...values) {
  for (const value of values) {
    const parsed = parseInstant(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function exactTarget(event = {}, text = eventText(event)) {
  const platform = normalizedPlatform(event);
  if (focusPlatform(platform)) {
    const firstToken = [
      event.token,
      ...list(event.tokens).map((token) => token?.token || token),
    ].find(validAddress);
    if (firstToken) return { type: "CA", value: clean(firstToken), exact: true };
  }
  const addressCandidates = [
    event.token,
    event.contractAddress,
    event.contract,
    event.tokens?.[0]?.token,
    event.entry?.token,
    ...list(event.newContracts),
    ...list(event.changes?.newContracts),
  ];
  if (["flap", "fourmeme", "openfour", "long"].includes(platform)) {
    addressCandidates.push(event.launcher, event.factory, ...list(event.officialRoots));
  }
  const address = addressCandidates.find(validAddress);
  if (address) return { type: "CA", value: clean(address), exact: true };

  const explicit = [
    event.instrument,
    event.marketSymbol,
    event.tradingPair,
    event.tokenSymbol,
    event.symbol,
    event.announcementDetails?.instrument,
    event.signal?.instrument,
    event.signal?.symbol,
  ].map(clean).find((value) => /^[A-Z0-9][A-Z0-9._-]{1,23}$/.test(value));
  if (explicit) return { type: /(?:USDT|USDC|FDUSD|USD|BTC|ETH|BNB)$/u.test(explicit) ? "market" : "ticker", value: explicit, exact: true };

  const upperText = clean(text).toUpperCase();
  const market = upperText.match(/(?<![A-Z0-9])([A-Z0-9][A-Z0-9._-]{1,18}(?:USDT|USDC|FDUSD|TUSD|USD1|USD|BTC|ETH|BNB))(?![A-Z0-9])/u)?.[1];
  if (market) return { type: "market", value: market, exact: true };

  const ticker = upperText.match(/\(([A-Z0-9][A-Z0-9._-]{1,14})\)/u)?.[1];
  if (ticker && !new Set(["UTC", "API", "WEB3", "BSC"]).has(ticker)) {
    return { type: "ticker", value: ticker, exact: true };
  }
  return { type: null, value: null, exact: false };
}

function officialBinanceEvidence(event = {}) {
  const id = lower(event.source?.id);
  if (!BINANCE_SOURCE_IDS.has(id)) return false;
  const urls = [event.source?.url, event.url, event.detailSource].filter(Boolean);
  if (!urls.length) return false;
  return urls.every((value) => {
    try {
      const url = new URL(String(value));
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      return url.protocol === "https:" && (host === "binance.com" || host.endsWith(".binance.com")
        || host === "binance.info" || host.endsWith(".binance.info"));
    } catch {
      return false;
    }
  });
}

function onchainEvidence(event = {}) {
  return validTransaction(event.transactionHash)
    && Number.isSafeInteger(Number(event.blockNumber))
    && Number(event.blockNumber) > 0;
}

function trustedConfirmation(event = {}) {
  if (officialBinanceEvidence(event)) return { trusted: true, kind: "official", value: event.source.id };
  if (onchainEvidence(event)) return {
    trusted: true,
    kind: "onchain",
    value: `${event.transactionHash}#${Number(event.blockNumber)}`,
  };
  if (event.type === "fomo_family_top_call" && event.signalKind === "top_blogger_convergence") {
    try {
      const url = new URL(String(event.source?.url || ""));
      if (lower(event.source?.id) === "cope_capital"
        && lower(event.source?.trust) === "authorized_public_api"
        && url.protocol === "https:"
        && !url.username
        && !url.password
        && url.hostname.toLowerCase().replace(/\.$/, "") === "api.cope.capital") {
        return { trusted: true, kind: "authorized_aggregate", value: "cope_capital" };
      }
    } catch {
      // A malformed aggregate source can never promote a Fomo signal.
    }
    return { trusted: false, kind: null, value: null };
  }
  if (event.type === "fomo_family_top_call"
    && event.signalKind === "fomo_x_call"
    && lower(event.source?.id) === "fomo_linked_x_post"
    && lower(event.source?.trust) === "public_x_identity_linked"
    && event.tweet?.sourceVerifiedBy === "official_x_oembed"
    && /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?(?:[?#].*)?$/i.test(clean(event.tweet?.url))) {
    return { trusted: true, kind: "linked_public_x", value: clean(event.tweet.url) };
  }
  if (event.type === "twitter_update"
    && lower(event.project?.match) === "official_x"
    && /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?(?:[?#].*)?$/i.test(clean(event.tweet?.url))) {
    return { trusted: true, kind: "official_x", value: clean(event.tweet.url) };
  }
  if (["platform_capability_update", "launchpad_site_update"].includes(event.type)
    && event.platform?.website && (event.url || event.sourceUrl)) {
    try {
      const website = new URL(String(event.platform.website));
      const evidence = new URL(String(event.url || event.sourceUrl));
      if (website.protocol === "https:" && evidence.protocol === "https:"
        && (website.hostname === evidence.hostname || evidence.hostname.endsWith(`.${website.hostname}`))) {
        return { trusted: true, kind: "official_snapshot", value: evidence.href };
      }
    } catch {
      // Malformed display URLs cannot become trusted evidence.
    }
  }
  if (event.type === "platform_capability_update"
    && ["flap", "fourmeme", "openfour", "long"].includes(normalizedPlatform(event))
    && event.changes && typeof event.changes === "object") {
    return { trusted: true, kind: "official_monitor_snapshot", value: normalizedPlatform(event) };
  }
  const trust = lower(event.source?.trust || event.sourceTrust || event.platform?.trust || event.project?.trust || event.launchpad?.trust);
  if (OFFICIAL_TRUST.has(trust)) return { trusted: true, kind: "official", value: trust };
  if (event.sourceTrust === "official_verified" && clean(event.repository)) {
    return { trusted: true, kind: "official_code", value: clean(event.repository) };
  }
  return { trusted: false, kind: null, value: null };
}

function launchTime(event = {}) {
  return firstInstant(
    event.launchAt,
    event.launchTime,
    event.tradingStartsAt,
    event.listingAt,
    event.effectiveAt,
    event.signal?.launchAt,
    event.signal?.effectiveAt,
    event.currentSnapshot?.launchAt,
    event.currentSnapshot?.tradingStartsAt,
    event.announcementDetails?.effectiveAt,
  );
}

function sourceTime(event = {}) {
  return firstInstant(
    event.freshness?.sourceOccurredAt,
    event.publishedAt,
    event.sourceOccurredAt,
    event.blockTimestamp,
    event.timestamp,
    event.tweet?.createdAt,
    event.committedAt,
  );
}

function evaluationTime(event = {}, requestedNowMs = null) {
  return firstInstant(
    requestedNowMs,
    event.alertQueuedAt,
    event.observedAt,
    event.freshness?.discoveredAt,
  ) ?? Date.now();
}

function validTradingWindow(event = {}, nowMs = null) {
  const freshnessDecision = lower(event.freshness?.deliveryDecision || event.freshness?.decision);
  if (["late", "suppress"].includes(freshnessDecision)) {
    return { valid: false, basis: "freshness_policy", ageMs: Number(event.freshness?.lagMs ?? event.freshness?.deliveryLagMs) || null };
  }
  const evaluatedAt = evaluationTime(event, nowMs);
  const scheduledAt = launchTime(event);
  if (scheduledAt !== null) {
    const ageMs = evaluatedAt - scheduledAt;
    return {
      valid: ageMs <= 30 * 60_000 && ageMs >= -7 * 24 * 60 * 60_000,
      basis: "launchAt",
      ageMs,
      launchAt: new Date(scheduledAt).toISOString(),
    };
  }
  const occurredAt = sourceTime(event);
  if (occurredAt === null) return { valid: false, basis: "source_time_missing", ageMs: null };
  const ageMs = evaluatedAt - occurredAt;
  const maximum = event.type === "fomo_family_top_call" ? 5 * 60_000
    : event.type === "binance_official_update" ? 10 * 60_000
      : 15 * 60_000;
  return {
    valid: ageMs >= -60_000 && ageMs <= maximum,
    basis: "source_time",
    ageMs,
  };
}

function fomoClusterSize(event = {}) {
  const participants = [
    ...list(event.callers),
    ...list(event.qualifiedWallets),
    ...list(event.walletCluster?.wallets),
  ];
  const handles = new Set();
  const wallets = new Set();
  for (const participant of participants) {
    const wallet = typeof participant === "string" ? participant
      : participant?.walletAddress || participant?.wallet || participant?.baseAddress || participant?.address;
    const handle = typeof participant === "string" ? null : participant?.handle || participant?.twitterHandle;
    if (validAddress(wallet)) wallets.add(lower(wallet));
    if (/^@?[A-Za-z0-9_]{1,15}$/.test(clean(handle))) handles.add(lower(handle).replace(/^@/, ""));
  }
  return Math.min(handles.size, wallets.size);
}

function fomoSafetyPassed(event = {}) {
  return event.security?.decision === "pass"
    && event.security?.metrics?.liquidityConfirmed === true
    && event.security?.metrics?.sellObserved === true
    && Number(event.market?.liquidityUsd || 0) > 0;
}

function focusSafetyPassed(event = {}) {
  const hasToken = validAddress(event.token) || validAddress(event.contractAddress)
    || list(event.tokens).some((token) => validAddress(token?.token || token));
  if (!hasToken) return true;
  return event.security?.decision === "pass"
    && event.security?.metrics?.liquidityConfirmed === true;
}

function focusFirstTokenAddress(event = {}) {
  return [
    event.token,
    ...list(event.tokens).map((token) => token?.token || token),
  ].map(clean).find(validAddress) || null;
}

function confirmedFocusFirstToken(event = {}) {
  return Boolean(
    (event.featureFirstToken === true || event.officialFirstToken === true)
      && focusFirstTokenAddress(event),
  );
}

function binanceLabels(event = {}) {
  return new Set([
    ...list(event.signal?.labels),
    event.signal?.category,
    event.currentSnapshot?.category,
  ].map(clean).filter(Boolean));
}

function focusPlatform(platform) {
  return platform === "flap"
    || platform === "openfour"
    || platform === "long"
    || platform.startsWith("fourmeme");
}

function untrustedOpenPullRequest(event = {}) {
  if (event.type !== "github_module_update") return false;
  const pullRequest = event.pullRequest;
  if (event.developmentStage !== "pull_request" && !pullRequest) return false;
  const state = clean(pullRequest?.state || event.pullRequestState || "open").toUpperCase();
  if (state !== "OPEN") return false;
  const association = clean(
    pullRequest?.authorAssociation
      || pullRequest?.author_association
      || event.authorAssociation
      || event.author_association,
  ).toUpperCase();
  return !new Set(["OWNER", "MEMBER", "COLLABORATOR"]).has(association);
}

function materialFocusGithub(event = {}) {
  return !untrustedOpenPullRequest(event) && Boolean(
    event.strong === true
      || event.modeChange?.candidate === true
      || event.chainSupportChange?.candidate === true
      || list(event.chainSupport).length
      || list(event.newContracts).length,
  );
}

function category(event = {}, text = eventText(event)) {
  // Public-channel observations and operational telemetry are always
  // information. Headline words or optional platform metadata cannot promote
  // them into a market-catalyst lane.
  if (event.type === "telegram_news_update" || event.type === "fomo_monitor_health_update") return "information";
  if (event.type === "fomo_family_top_call") {
    if (event.signalKind === "top_blogger_convergence" && fomoClusterSize(event) >= 2) return "fomo_cluster";
    if (FOMO_OFFICIAL_KINDS.has(event.signalKind)) return "fomo_official_exact";
    if (FOMO_SINGLE_KINDS.has(event.signalKind)) return "fomo_single";
    return "fomo_signal";
  }
  const platform = normalizedPlatform(event);
  const labels = binanceLabels(event);
  const isBinance = event.type === "binance_official_update" || platform.startsWith("binance");
  if (isBinance) {
    const marketAnnouncementSource = event.type === "binance_official_update" || event.type === "twitter_update";
    if (marketAnnouncementSource && [...labels].some((label) => BINANCE_T0_LABELS.has(label))) return "binance_market_catalyst";
    if ([...labels].some((label) => /活动|奖励|普通公告|维护|交易规则|市场公告/u.test(label))) return "binance_information";
    const structuredProductFeature = [event.binanceChange, event.developerChange].some((change) => (
      lower(change?.classification) === "product_feature" && change?.productFeature === true
    )) || event.productFeature === true;
    const agentNativeProductFeature = event.type === "binance_official_update"
      && ((event.kind === "developer_update"
        && ([...labels].some((label) => /agent_native|agent\s+native/i.test(label))
          || list(event.addedSignals).some((signal) => /(?:\/agent-native\/|Binance\s+MCP\s+Server)/iu.test(clean(signal)))))
        || /\bAgent\s+(?:OS|Native)|\bBinance\s+MCP\s+Server\b|\/agent-native\//iu.test(text));
    if (structuredProductFeature || agentNativeProductFeature) return "binance_product";
    if (marketAnnouncementSource
      && /\b(?:will\s+list|alpha\b.*\b(?:add|list)|futures\s+will\s+(?:launch|list)|will\s+delist)\b/iu.test(text)) return "binance_market_catalyst";
    if ([...labels].some((label) => /功能|产品|新链|API|发射|安全|社交交易/u.test(label))) return "binance_product";
    if (event.kind === "developer_update" || event.type === "github_module_update") return "developer_maintenance";
    return "binance_information";
  }
  if (focusPlatform(platform)) {
    if (["bsc_launchpad_update", "evm_launchpad_update", "token_launch"].includes(event.type)) return "focus_onchain";
    if (event.type === "github_module_update" && !materialFocusGithub(event)) return "developer_maintenance";
    return "focus_official";
  }
  if (event.type === "github_module_update" || event.type === "github_monitor_gap" || event.kind === "developer_update") return "developer_maintenance";
  return "information";
}

function catalystScore(eventCategory) {
  if (["binance_market_catalyst", "focus_onchain", "fomo_cluster", "fomo_official_exact"].includes(eventCategory)) return 5;
  if (["binance_product", "focus_official", "fomo_single", "fomo_signal"].includes(eventCategory)) return 3;
  if (eventCategory === "binance_information") return 1;
  return 0;
}

function capitalFlowScore(eventCategory) {
  if (["binance_market_catalyst", "fomo_cluster", "fomo_official_exact"].includes(eventCategory)) return 3;
  if (["focus_onchain", "fomo_single"].includes(eventCategory)) return 2;
  if (["binance_product", "focus_official"].includes(eventCategory)) return 1;
  return 0;
}

function lifecycleProduct(event = {}, text = eventText(event)) {
  const explicit = clean(event.lifecycle?.product || event.lifecycleProduct || event.productLifecycle?.product);
  if (explicit) return lower(explicit).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (/\bmeme\s+arena\b/iu.test(text)) return "meme-arena";
  if (/\bopen\s*four\b/iu.test(text)) return "openfour";
  if (/\bmeme\s+rush\b/iu.test(text)) return "meme-rush";
  const label = clean(event.mode?.officialName || event.mode?.componentMode || event.mode?.selectorName || event.signal?.category);
  return label ? lower(label).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : null;
}

function lifecycleStage(event = {}, text = eventText(event)) {
  const explicit = clean(event.lifecycle?.stage || event.lifecycleStage || event.productLifecycle?.stage || event.stage);
  if (explicit) return lower(explicit).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (onchainEvidence(event)) return event.featureFirstToken || event.officialFirstToken ? "first-safe-token" : "onchain-confirmed";
  if (/\b(?:is\s+live|now\s+live|goes\s+live|launched|available\s+now)\b|已上线|正式上线/iu.test(text)) return "live";
  if (/\b(?:upgrade|upgraded|implementation)\b|升级/iu.test(text)) return "upgrade";
  if (/\b(?:announce|announced|introduc|coming\s+soon)\b|宣布|预告/iu.test(text)) return "announced";
  if (event.changeType === "revised") return "revised";
  return "observed";
}

export function deriveEventLifecycle(event = {}) {
  const product = lifecycleProduct(event);
  const stage = lifecycleStage(event);
  const platform = normalizedPlatform(event) || "monitor";
  const explicitKey = clean(event.lifecycleKey || event.lifecycle?.key || event.productLifecycle?.key);
  return Object.freeze({
    product,
    stage,
    key: explicitKey || (product ? `${platform}:lifecycle:${product}:${stage}` : null),
  });
}

function tradePlan(event, eventCategory, tier, target) {
  const noAutoZh = "仅作决策支持，非自动交易";
  const noAutoEn = "Decision support only; no automatic trading";
  if (eventCategory === "binance_market_catalyst") {
    const delist = /delist|下架/iu.test(eventText(event));
    return {
      conclusion: { zh: delist ? "不做" : "观察", en: delist ? "Do not trade" : "Watch" },
      mainline: { zh: `Binance 市场入口变化→${target.value || "目标资产"}`, en: `Binance market access change→${target.value || "target asset"}` },
      capitalPath: { zh: "现货/Alpha→永续与链上流动性", en: "Spot/Alpha→perpetual and on-chain liquidity" },
      entryCondition: { zh: delist ? "不新增多头" : "开盘量能与现货承接同时确认", en: delist ? "Do not add longs" : "Opening volume and spot support both confirm" },
      invalidation: { zh: "公告撤回、无现货承接或冲高回落", en: "Notice withdrawn, no spot support, or failed breakout" },
      risk: { zh: noAutoZh, en: noAutoEn },
    };
  }
  if (["focus_onchain", "focus_official"].includes(eventCategory)) {
    const blocked = event.security?.decision === "block";
    return {
      conclusion: { zh: blocked ? "不做" : "观察", en: blocked ? "Do not trade" : "Watch" },
      mainline: { zh: "平台新模式/升级→首个安全代币", en: "Platform mode/upgrade→first safe token" },
      capitalPath: { zh: "平台流量→首币流动性池", en: "Platform traffic→first-token liquidity pool" },
      entryCondition: {
        zh: blocked ? "本地安全门拦截，不入场" : "首币安全门、流动性与成交量全部确认",
        en: blocked ? "Local safety gate blocked; do not enter" : "First-token safety, liquidity, and volume all confirm",
      },
      invalidation: {
        zh: blocked ? "风险未消除" : "升级回滚、无安全首币或流动性不足",
        en: blocked ? "Risk remains unresolved" : "Upgrade rollback, no safe first token, or weak liquidity",
      },
      risk: { zh: noAutoZh, en: noAutoEn },
    };
  }
  if (eventCategory.startsWith("fomo_")) {
    return {
      conclusion: { zh: tier === "T0" ? "观察" : "观察", en: "Watch" },
      mainline: { zh: "合格钱包/官方喊单→链上流动性", en: "Qualified wallets/official call→on-chain liquidity" },
      capitalPath: { zh: "钱包共振→成交量与注意力", en: "Wallet convergence→volume and attention" },
      entryCondition: { zh: tier === "T0" ? "独立证据共振且量价确认" : "等待第二个独立合格钱包确认", en: tier === "T0" ? "Independent evidence converges with price-volume confirmation" : "Wait for a second independent qualified wallet" },
      invalidation: { zh: "流动性下降、卖出受阻或钱包反向卖出", en: "Liquidity falls, selling is impaired, or wallets reverse to sells" },
      risk: { zh: noAutoZh, en: noAutoEn },
    };
  }
  if (["binance_product", "binance_information"].includes(eventCategory)) {
    return {
      conclusion: { zh: eventCategory === "binance_product" ? "观察" : "不做", en: eventCategory === "binance_product" ? "Watch" : "Do not trade" },
      mainline: { zh: "官方产品/公告→等待直接资金入口", en: "Official product/notice→wait for a direct capital path" },
      capitalPath: { zh: "尚未形成可执行资金路径", en: "No executable capital path yet" },
      entryCondition: { zh: "出现精确标的与量价确认后再评估", en: "Reassess only after an exact target and price-volume confirmation" },
      invalidation: { zh: "仅有活动热度或普通公告", en: "Only campaign attention or an ordinary notice" },
      risk: { zh: noAutoZh, en: noAutoEn },
    };
  }
  return {
    conclusion: { zh: "不做", en: "Do not trade" },
    mainline: { zh: "信息记录", en: "Information only" },
    capitalPath: { zh: "未确认", en: "Unconfirmed" },
    entryCondition: { zh: "等待官方/链上确认和精确标的", en: "Wait for official/on-chain confirmation and an exact target" },
    invalidation: { zh: "缺少直接资金路径", en: "No direct capital path" },
    risk: { zh: noAutoZh, en: noAutoEn },
  };
}

function tierLabel(tier) {
  const labels = {
    T0: { zh: "最高优先催化", en: "Top-priority catalyst" },
    T1: { zh: "已确认催化", en: "Confirmed catalyst" },
    T2: { zh: "观察信息", en: "Watch information" },
    T3: { zh: "摘要记录", en: "Digest only" },
  };
  return labels[tier];
}

export function deriveTradingPriority(event = {}, { nowMs = null } = {}) {
  const text = eventText(event);
  const eventCategory = category(event, text);
  const target = exactTarget(event, text);
  const confirmation = trustedConfirmation(event);
  const window = validTradingWindow(event, nowMs);
  const riskBlocked = event.security?.decision === "block";
  const focusSafety = focusSafetyPassed(event);
  const fomoSafety = fomoSafetyPassed(event);
  const clusterSize = fomoClusterSize(event);
  const officialFomoExact = eventCategory === "fomo_official_exact"
    && FOMO_OFFICIAL_KINDS.has(event.signalKind)
    && confirmation.trusted;
  const fomoT0 = eventCategory === "fomo_cluster"
    ? clusterSize >= 2 && event.qualified === true && fomoSafety
    : officialFomoExact && fomoSafety;
  // Factory, launcher and proxy upgrades remain important T1 infrastructure
  // evidence. Focus-platform T0 is reserved for the actual first token, with
  // its own CA plus the existing security/liquidity and on-chain hard gates.
  const focusT0 = eventCategory === "focus_onchain"
    && confirmedFocusFirstToken(event)
    && focusSafety
    && onchainEvidence(event);
  const highCatalyst = eventCategory === "binance_market_catalyst" || focusT0 || fomoT0;
  const safetyPassed = eventCategory.startsWith("fomo_")
    ? fomoSafety
    : eventCategory.startsWith("focus_")
      ? focusSafety
      : true;
  const hardGates = {
    exactTarget: target.exact,
    trustedConfirmation: confirmation.trusted,
    validWindow: window.valid,
    safetyPassed: !riskBlocked && safetyPassed,
  };
  hardGates.t0Eligible = highCatalyst
    && hardGates.exactTarget
    && hardGates.trustedConfirmation
    && hardGates.validWindow
    && hardGates.safetyPassed;

  const components = {
    catalyst: catalystScore(eventCategory),
    capitalFlow: capitalFlowScore(eventCategory),
    target: target.exact ? 2 : 0,
    confirmation: confirmation.trusted ? 3 : 0,
    freshness: window.valid ? 2 : 0,
    riskPenalty: riskBlocked ? -8 : 0,
  };
  const score = Object.values(components).reduce((total, value) => total + value, 0);
  let tier;
  if (hardGates.t0Eligible && score >= 10) tier = "T0";
  else if (eventCategory === "developer_maintenance") tier = "T3";
  else if (eventCategory === "binance_information" || eventCategory === "information") tier = "T2";
  else if (eventCategory.startsWith("focus_") && riskBlocked && confirmation.trusted) tier = "T1";
  else if (eventCategory.startsWith("focus_")) tier = "T1";
  else if (eventCategory === "fomo_single" && fomoSafety && confirmation.trusted) tier = "T1";
  else if (eventCategory.startsWith("fomo_") && fomoSafety && confirmation.trusted) tier = "T1";
  else if (["focus_onchain", "focus_official", "binance_product", "binance_market_catalyst"].includes(eventCategory)
    && confirmation.trusted && !riskBlocked) tier = "T1";
  else tier = score >= 6 && !riskBlocked ? "T1" : "T2";

  const lifecycle = deriveEventLifecycle(event);
  return Object.freeze({
    version: TRADING_PRIORITY_VERSION,
    schema: PRIORITY_SCHEMA,
    deterministic: true,
    tier,
    rank: TIER_RANK[tier],
    label: tierLabel(tier),
    score,
    components: Object.freeze(components),
    category: eventCategory,
    target: Object.freeze(target),
    confirmation: Object.freeze(confirmation),
    window: Object.freeze(window),
    hardGates: Object.freeze(hardGates),
    lifecycle,
    plan: Object.freeze({ ...tradePlan(event, eventCategory, tier, target), automaticExecution: false }),
  });
}

export function legacyTradingPriority(event = {}) {
  const tier = event.strong === true ? "T1" : "T2";
  return Object.freeze({
    version: TRADING_PRIORITY_VERSION,
    schema: `${PRIORITY_SCHEMA}:legacy`,
    deterministic: true,
    tier,
    rank: TIER_RANK[tier],
    label: tierLabel(tier),
    score: null,
    components: null,
    category: "legacy_pending",
    target: Object.freeze({ type: null, value: null, exact: false }),
    confirmation: Object.freeze({ trusted: false, kind: "legacy", value: null }),
    window: Object.freeze({ valid: false, basis: "legacy_pending", ageMs: null }),
    hardGates: Object.freeze({ exactTarget: false, trustedConfirmation: false, validWindow: false, safetyPassed: false, t0Eligible: false }),
    lifecycle: deriveEventLifecycle(event),
    plan: Object.freeze({ ...tradePlan(event, "information", tier, { value: null }), automaticExecution: false }),
  });
}

export function isTradingPriority(value) {
  return value?.version === TRADING_PRIORITY_VERSION
    && typeof value?.schema === "string"
    && [PRIORITY_SCHEMA, `${PRIORITY_SCHEMA}:legacy`].includes(value.schema)
    && TRADING_TIERS.includes(value?.tier)
    && value.rank === TIER_RANK[value.tier]
    && value?.deterministic === true
    && value?.plan?.automaticExecution === false;
}

export function tradingPriorityForEvent(event = {}, { legacy = false, nowMs = null } = {}) {
  if (isTradingPriority(event.tradingPriority)) return event.tradingPriority;
  return legacy ? legacyTradingPriority(event) : deriveTradingPriority(event, { nowMs });
}

export function withTradingPriority(event = {}, options = {}) {
  return { ...event, tradingPriority: options.legacy
    ? legacyTradingPriority(event)
    : deriveTradingPriority(event, { nowMs: options.nowMs }) };
}

export function compareTradingPriority(left = {}, right = {}) {
  const leftEvent = left.event || left;
  const rightEvent = right.event || right;
  const leftPriority = tradingPriorityForEvent(leftEvent, { legacy: true });
  const rightPriority = tradingPriorityForEvent(rightEvent, { legacy: true });
  // Health transitions retain their closed, non-trading event schema while
  // draining ahead of ordinary T1/T2 work. Only T0 outranks them.
  const queueRank = (event, priority) => event?.type === "fomo_monitor_health_update"
    ? 3.5
    : TIER_RANK[priority.tier];
  const tierDelta = queueRank(rightEvent, rightPriority) - queueRank(leftEvent, leftPriority);
  if (tierDelta) return tierDelta;
  const leftCreatedAt = left.createdAt || left.event?.alertQueuedAt || "";
  const rightCreatedAt = right.createdAt || right.event?.alertQueuedAt || "";
  const leftMs = Date.parse(String(leftCreatedAt));
  const rightMs = Date.parse(String(rightCreatedAt));
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return leftMs - rightMs;
  return String(leftCreatedAt).localeCompare(String(rightCreatedAt));
}
