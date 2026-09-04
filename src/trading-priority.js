import {
  isStrictBscOpenFourFirstTokenUpdate,
  isFourMemePolicyFixRecoveryEvent,
  isOfficialFourMemeCapabilityUpdate,
  isStrictFourRegistryCapabilityForPriority,
  isStrictFourRegistryCanonicalRevisionForPriority,
  isStrictFourRegistryDelayedRecoveryForPriority,
  isStrictFourRegistryFirstTokenForPriority,
  isStrictFourMemeMarketCampaign,
} from "./source-controls.js";

const PRIORITY_SCHEMA = "news_trading_priority_v2";

export const TRADING_PRIORITY_VERSION = 2;
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
const BINANCE_STRUCTURED_T0_LABELS = new Set([
  "现货首次上币", "新币上线", "Alpha 上新", "新合约上线", "整币下架",
]);
const BINANCE_LOW_VALUE_LABEL = /活动|奖励|竞赛|比赛|挑战|拉新|推荐|返现|答题|测验|节庆|节日|代金券|年化|campaign|rewards?|competition|tournament|quiz|cashback|referral|festival/i;
const BINANCE_LOW_VALUE_HEADLINE = /\b(?:campaign|competition|tournament|rewards?|prize\s+pool|giveaway|voucher|wotd|word\s+of\s+the\s+day|quiz|cashback|referrals?|new\s+user\s+exclusive|yield\s+arena|limited[- ]time\s+offers?|hackathon|challenge)\b|\bP2P\b[^\n]{0,100}\b(?:merchant|new\s+user|competition|rewards?|voucher)\b|\b(?:merchant|new\s+user)\b[^\n]{0,100}\bP2P\b|\b\d+(?:\.\d+)?%\s+APR\b|活动|奖励|竞赛|比赛|挑战|拉新|推荐有奖|返现|答题|测验|节庆|节日|代金券|奖池|商家招募|年化收益/i;
const BINANCE_SQUARE_GOVERNANCE = /\b(?:community\s+governance|governance\s+announcement|enforcement\s+actions?|violations?|weekly\s+(?:governance\s+)?report)\b|社区治理|治理公告|执法行动|违规处理|违规账号|治理周报/i;
const BINANCE_SECURITY_EMERGENCY_ACTION = /\b(?:security\s+(?:incident|breach|exploit|compromise)|confirmed\s+(?:breach|exploit|attack)|unauthori[sz]ed\s+(?:access|withdrawals?)|hot\s+wallet\s+(?:breach|compromise)|suspend(?:s|ed|ing)?\s+(?:all\s+)?(?:withdrawals?|deposits?|trading)|halt(?:s|ed|ing)?\s+(?:all\s+)?(?:withdrawals?|deposits?|trading)|emergency\s+(?:maintenance|suspension|shutdown))\b|确认(?:安全事件|漏洞|攻击|入侵)|安全(?:事件|漏洞|遭入侵)|暂停(?:全部)?(?:提现|充值|交易)|紧急(?:维护|暂停)/iu;
const PON_STRUCTURAL_KINDS = new Set([
  "factory_config",
  "curve_params",
  "factory_paused",
  "ownership_transfer_started",
  "ownership_transferred",
  "platform_token_update",
]);
const PON_INFORMATION_KINDS = new Set([
  "market_created",
  "market_lifecycle",
  "stock_listing",
  "factory_unpaused",
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

function flapTrackedTokenOrdinal(event = {}) {
  if (event.type !== "bsc_launchpad_update"
    || event.kind !== "flap_pool_token"
    || event.featureTrackedToken !== true
    || normalizedPlatform(event) !== "flap"
    || Number(event.featureTokenTarget) !== 3) return null;
  const ordinal = Number(event.featureTokenOrdinal);
  return Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= 3 ? ordinal : null;
}

function isClosedFlapTrackedTokenMonitor(event = {}) {
  const ordinal = flapTrackedTokenOrdinal(event);
  const token = list(event.tokens).map((item) => item?.token || item).find(validAddress);
  const generation = clean(
    event.featureGenerationKey
      ?? event.generation
      ?? event.generationKey
      ?? event.featureTokenGeneration
      ?? event.featureActivationGeneration,
  );
  return Boolean(
    ordinal
      && token
      && clean(event.featureActivationKey)
      && generation
      && clean(event.featureActivationKey) === generation
      && lower(event.platform?.trust) === "official_verified"
      && event.informationalOnly === true
      && event.autoTradeEligible === false
      && event.automaticExecution === false,
  );
}

function isFlapTrackedTokenCanonicalRevision(event = {}) {
  if (!isClosedFlapTrackedTokenMonitor(event)) return false;
  const revision = event.canonicalRevision;
  const keys = [
    "version", "reason", "ordinal", "replacesEventKey", "replacesBlockHash",
    "replacesTokenAddress",
  ];
  if (!revision
    || typeof revision !== "object"
    || Array.isArray(revision)
    || Object.keys(revision).length !== keys.length
    || !keys.every((key) => Object.prototype.hasOwnProperty.call(revision, key))) return false;
  const ordinal = flapTrackedTokenOrdinal(event);
  const generation = clean(event.featureGenerationKey);
  const token = lower(list(event.tokens).map((item) => item?.token || item).find(validAddress));
  const prefix = `bsc-flap-pool-token:${generation}:${ordinal}:`;
  const replacedEventKey = clean(revision.replacesEventKey);
  const replacedTail = replacedEventKey.startsWith(prefix) ? replacedEventKey.slice(prefix.length) : "";
  const replacedCandidate = /^(0x[a-f0-9]{64}):(0|[1-9]\d*):(0x[a-f0-9]{40})(?::canonical-revision:(0x[a-f0-9]{64}))?$/.exec(replacedTail);
  const blockHash = lower(event.blockHash);
  const baseKey = `${prefix}${lower(event.transactionHash)}:${Number(event.logIndex)}:${token}`;
  return revision.version === 1
    && revision.reason === "token_created_reorg"
    && Number(revision.ordinal) === ordinal
    && Boolean(replacedCandidate)
    && replacedCandidate?.[3] === lower(revision.replacesTokenAddress)
    && (!replacedCandidate?.[4] || replacedCandidate[4] === lower(revision.replacesBlockHash))
    && validTransaction(revision.replacesBlockHash)
    && lower(revision.replacesBlockHash) !== blockHash
    && validTransaction(blockHash)
    && validTransaction(event.transactionHash)
    && Number.isSafeInteger(Number(event.logIndex))
    && Number(event.logIndex) >= 0
    && event.eventKey === `${baseKey}:canonical-revision:${blockHash}`;
}

function isFlapTrackedTokenDelayedRecovery(event = {}) {
  const recovery = event?.delayedRecovery;
  const sourceOccurredAt = Date.parse(recovery?.sourceOccurredAt || "");
  const recoveredAt = Date.parse(recovery?.recoveredAt || "");
  return isClosedFlapTrackedTokenMonitor(event)
    && recovery?.version === 1
    && recovery?.reason === "verified_generation_archive_catch_up"
    && recovery?.continuousCoverage === true
    && Number.isFinite(sourceOccurredAt)
    && Number.isFinite(recoveredAt)
    && recoveredAt >= sourceOccurredAt
    && Number(recovery?.lagMs) === recoveredAt - sourceOccurredAt;
}

function isFlapQuoteDelayedRecovery(event = {}) {
  return event.type === "platform_capability_update"
    && normalizedPlatform(event) === "flap"
    && event.kind === "flap_quote_asset_enabled"
    && event?.delayedRecovery?.version === 1
    && event.delayedRecovery?.reason === "monitoring_gap_recovery";
}

function isFlapQuoteFirstObservedAfterGap(event = {}) {
  return event.type === "platform_capability_update"
    && normalizedPlatform(event) === "flap"
    && event.kind === "flap_quote_asset_first_observed_after_gap"
    && event.changeType === "observed"
    && event?.signal?.quotePairChange?.stage === "observed"
    && event?.delayedRecovery?.version === 1
    && event.delayedRecovery?.reason === "first_observed_after_gap";
}

function isFlapBoardQuoteObserved(event = {}) {
  return event.type === "platform_capability_update"
    && normalizedPlatform(event) === "flap"
    && event.kind === "flap_quote_asset_board_observed"
    && event.changeType === "observed"
    && event?.signal?.quotePairChange?.stage === "observed"
    && event.signal.quotePairChange.assetClass === "quote_asset"
    && !onchainEvidence(event);
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

const BINANCE_INSTRUMENT_ACTIONS = new Set(["launch", "list", "delist"]);
const BINANCE_INSTRUMENT_MARKETS = new Set(["usd_m_perpetual", "coin_m_perpetual", "spot", "spot_pair"]);
const BINANCE_INSTRUMENT_SYMBOL = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const BINANCE_INSTRUMENT_PAIR = /^[\p{L}\p{N}][\p{L}\p{N}._\/-]{1,127}$/u;

function structuredBinanceTargetSet(event = {}) {
  const details = event.announcementDetails;
  if (!details || typeof details !== "object" || lower(details.kind) !== "instrument_change") {
    return { present: false, complete: true, targets: [] };
  }
  const action = lower(details.action);
  const market = lower(details.market);
  const listed = list(details.instruments);
  const rawTargets = listed.length
    ? listed
    : details.instrument ? [{ symbol: details.instrument, launchAt: details.launchAt, effectiveAt: details.effectiveAt }] : [];
  const commonTime = firstInstant(details.launchAt, details.effectiveAt);
  const targets = rawTargets.map((item) => {
    const rawSymbol = item?.symbol ?? item?.instrument;
    const symbol = typeof rawSymbol === "string" ? rawSymbol : "";
    const pairs = list(item?.pairs).map((pair) => typeof pair === "string" ? pair : "");
    // The producer's top-level time is a projection of its first instrument,
    // not proof of a shared schedule. Only a single-target payload may use it
    // as a compatibility fallback; every multi-target item needs its own time.
    const effectiveAt = firstInstant(
      item?.launchAt,
      item?.effectiveAt,
      rawTargets.length === 1 ? commonTime : null,
    );
    return {
      type: /(?:USDT|USDC|FDUSD|TUSD|USD1|USD|BTC|ETH|BNB)$/u.test(symbol)
        || market.endsWith("perpetual") || market === "spot_pair" ? "market" : "ticker",
      value: symbol,
      exact: BINANCE_INSTRUMENT_SYMBOL.test(symbol),
      market,
      action,
      pairs,
      effectiveAt: effectiveAt === null ? null : new Date(effectiveAt).toISOString(),
    };
  });
  const symbolsComplete = targets.length > 0 && targets.every((target) => target.exact
    && target.pairs.every((pair) => BINANCE_INSTRUMENT_PAIR.test(pair)));
  const timingComplete = targets.every((target) => target.effectiveAt !== null);
  const shapeComplete = BINANCE_INSTRUMENT_ACTIONS.has(action) && BINANCE_INSTRUMENT_MARKETS.has(market);
  return { present: true, complete: shapeComplete && symbolsComplete && timingComplete, targets };
}

function exactTarget(event = {}, text = eventText(event)) {
  const platform = normalizedPlatform(event);
  if (isStrictFourRegistryCapabilityForPriority(event)) {
    return {
      type: "registry_subject",
      value: clean(event.subject?.id),
      exact: Boolean(clean(event.subject?.id)),
    };
  }
  if (focusPlatform(platform)) {
    const firstToken = [
      event.token,
      ...list(event.tokens).map((token) => token?.token || token),
    ].find(validAddress);
    if (firstToken) return { type: "CA", value: clean(firstToken), exact: true };

    // Flap quote-pair announcements and confirmed quote assets are platform
    // infrastructure, not token launches. Prefer the verified quote symbol as
    // the decision target so a board/Portal update never degrades into an
    // anonymous address-only alert.
    const quotePairSymbol = [
      ...list(event.signal?.quotePairChange?.assets).map((asset) => asset?.symbol),
      ...list(event.changes?.newFlapPools).map((pool) => pool?.quoteSymbol),
      ...list(event.changes?.updatedFlapPools).map((pool) => pool?.quoteSymbol),
      ...list(event.changes?.flapPoolChanges).map((change) => (change?.after || change)?.quoteSymbol),
    ].map(clean).find((value) => /^[A-Za-z0-9][A-Za-z0-9_$.-]{0,23}$/.test(value));
    if (platform === "flap" && quotePairSymbol) {
      return { type: "quote_asset", value: quotePairSymbol, exact: true };
    }
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
  if (platform === "ponfun") addressCandidates.push(event.factory);
  const address = addressCandidates.find(validAddress);
  if (address) return { type: "CA", value: clean(address), exact: true };

  const structuredTargets = structuredBinanceTargetSet(event);
  if (structuredTargets.present) {
    // A multi-market announcement is exact only when the complete structured
    // set is valid. Never promote it from whichever ticker a prose regex sees
    // first while another listed target or its effective time is absent.
    if (structuredTargets.complete) return structuredTargets.targets[0];
    return { type: null, value: null, exact: false };
  }
  if (normalizedPlatform(event).startsWith("binance")
    && binanceLabels(event).has("安全/紧急公告")
    && BINANCE_SECURITY_EMERGENCY_ACTION.test(text)) {
    return { type: "venue", value: "Binance", exact: true };
  }
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

function officialPonFunEvidence(event = {}) {
  return event.type === "pon_fun_update"
    && normalizedPlatform(event) === "ponfun"
    && lower(event.source?.id) === "pon_fun_official_api_onchain"
    && lower(event.source?.trust) === "official_site_bound_onchain_fingerprinted"
    && lower(event.sourceTrust) === "official_site_bound_onchain_fingerprinted"
    && event.source?.official === true
    && lower(event.factory) === "0xf698d13348686c1529c2dc54847c123424d9dae0"
    && lower(event.evidence?.factoryCodeHash) === "0x4cb9795396b800a4b1e46f2e91a690ecf004ac0d52b059a7ef0e6b190af17384";
}

function officialPonFunTwitterEvidence(event = {}) {
  if (event.type !== "twitter_update"
    || normalizedPlatform(event) !== "ponfun"
    || lower(event.project?.id) !== "ponfun"
    || lower(event.project?.name) !== "pon.fun"
    || lower(event.project?.handle).replace(/^@/, "") !== "pondotfun"
    || String(event.project?.xUserId || "") !== "2094048312772993024"
    || lower(event.project?.match) !== "official_x"
    || lower(event.project?.signalProfile) !== "pon_fun"
    || event.project?.website !== "https://www.pon.fun"
    || event.project?.twitter !== "https://x.com/pondotfun"
    || event.tweet?.sourceVerifiedBy !== "official_x_oembed"
    || event.tweet?.identityVerifiedBy !== "fxtwitter_exact_numeric_id"
    || String(event.tweet?.authorId || "") !== "2094048312772993024"
    || String(event.tweet?.xUserId || "") !== "2094048312772993024"
    || !/^\d+$/.test(String(event.tweet?.id || ""))) return false;
  try {
    const url = new URL(String(event.tweet?.url || ""));
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash
      && url.hostname.toLowerCase() === "x.com"
      && url.pathname.toLowerCase() === `/pondotfun/status/${event.tweet.id}`.toLowerCase();
  } catch {
    return false;
  }
}

function trustedConfirmation(event = {}) {
  if (isStrictFourRegistryFirstTokenForPriority(event)) return {
    trusted: true,
    kind: "official_openfour_core_token_created",
    value: `${event.transactionHash}#${event.logIndex}`,
  };
  if (isStrictFourRegistryCapabilityForPriority(event)) return {
    trusted: true,
    kind: "official_openfour_registry_log",
    value: `${event.transactionHash}#${event.logIndex}`,
  };
  if (isStrictBscOpenFourFirstTokenUpdate(event)) return {
    trusted: true,
    kind: "official_openfour_core_log",
    value: `${event.transactionHash}#${event.logIndex}`,
  };
  if (officialBinanceEvidence(event)) return { trusted: true, kind: "official", value: event.source.id };
  if (officialPonFunEvidence(event)) return {
    trusted: true,
    kind: "official_site_bound_onchain_fingerprint",
    value: event.source.id,
  };
  if (officialPonFunTwitterEvidence(event)) return {
    trusted: true,
    kind: "official_x_numeric_id_oembed",
    value: event.tweet.url,
  };
  if (event.type === "twitter_update" && normalizedPlatform(event) === "ponfun") {
    return { trusted: false, kind: null, value: null };
  }
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
  const announcementTime = firstInstant(
    event.announcementDetails?.launchAt,
    event.announcementDetails?.effectiveAt,
  );
  if (announcementTime !== null) return announcementTime;
  const instrumentTimes = list(event.announcementDetails?.instruments)
    .map((item) => firstInstant(item?.launchAt, item?.effectiveAt))
    .filter((value) => value !== null);
  if (instrumentTimes.length) return Math.min(...instrumentTimes);
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
    isOfficialFourMemeCapabilityUpdate(event) ? event.observedAt : null,
    ["platform_capability_update", "launchpad_site_update"].includes(event.type) ? event.observedAt : null,
    event.type === "binance_official_update" && event.kind === "developer_update"
      && event.comparisonBasis === "exact_snapshot" ? event.observedAt : null,
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

function confirmedFocusLeadToken(event = {}) {
  const trackedOrdinal = flapTrackedTokenOrdinal(event);
  if (trackedOrdinal != null) {
    return isClosedFlapTrackedTokenMonitor(event)
      && trackedOrdinal === 1
      && Boolean(focusFirstTokenAddress(event));
  }
  return confirmedFocusFirstToken(event);
}

function binanceLabels(event = {}) {
  return new Set([
    ...list(event.signal?.labels),
    event.signal?.category,
    event.currentSnapshot?.category,
  ].map(clean).filter(Boolean));
}

function binanceHeadline(event = {}) {
  return clean(event.title || event.signal?.headline || event.tweet?.text || event.message || "");
}

function lowValueBinanceUpdate(event = {}, labels = binanceLabels(event)) {
  const headline = binanceHeadline(event);
  if ([...labels].some((label) => BINANCE_LOW_VALUE_LABEL.test(label))) return true;
  if (BINANCE_LOW_VALUE_HEADLINE.test(headline)) return true;
  return lower(event.source?.id) === "binance_square_cms"
    && BINANCE_SQUARE_GOVERNANCE.test(`${headline} ${[...labels].join(" ")}`);
}

function binanceStructuredTargetRequired(event = {}, eventCategory) {
  if (eventCategory !== "binance_market_catalyst") return false;
  const labels = binanceLabels(event);
  return !labels.has("安全/紧急公告")
    && ([...labels].some((label) => BINANCE_STRUCTURED_T0_LABELS.has(label))
      || structuredBinanceTargetSet(event).present
      || /\b(?:will\s+(?:list|delist)|futures\s+will\s+(?:launch|list)|alpha\b.*\b(?:add|list))\b/iu.test(eventText(event)));
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
  if (isFourMemePolicyFixRecoveryEvent(event)) return "focus_policy_recovery";
  if (isStrictFourRegistryCanonicalRevisionForPriority(event)) return "focus_registry_canonical_revision";
  if (isStrictFourRegistryFirstTokenForPriority(event)) return "focus_registry_first_token";
  if (isStrictFourRegistryCapabilityForPriority(event)) return isStrictFourRegistryDelayedRecoveryForPriority(event)
    ? "focus_registry_delayed_recovery"
    : "focus_registry_capability";
  if (isStrictBscOpenFourFirstTokenUpdate(event)) return "focus_registry_first_token";
  if (event.type === "fomo_family_top_call") {
    if (event.signalKind === "top_blogger_convergence" && fomoClusterSize(event) >= 2) return "fomo_cluster";
    if (FOMO_OFFICIAL_KINDS.has(event.signalKind)) return "fomo_official_exact";
    if (FOMO_SINGLE_KINDS.has(event.signalKind)) return "fomo_single";
    return "fomo_signal";
  }
  const platform = normalizedPlatform(event);
  if (event.type === "pon_fun_update" || platform === "ponfun") {
    if (event?.delayedRecovery?.version === 1
      && event.delayedRecovery?.reason === "monitoring_gap_recovery") return "pon_information";
    if (event.type === "twitter_update") {
      return officialPonFunTwitterEvidence(event)
        && event.signal?.ponPriority === "T1"
        && event.signal?.majorProductUpdate === true
        ? "pon_structural"
        : "pon_information";
    }
    if (PON_STRUCTURAL_KINDS.has(event.kind)) return "pon_structural";
    if (PON_INFORMATION_KINDS.has(event.kind)) return "pon_information";
    return "pon_information";
  }
  const labels = binanceLabels(event);
  const isBinance = event.type === "binance_official_update" || platform.startsWith("binance");
  if (isBinance) {
    const marketAnnouncementSource = event.type === "binance_official_update" || event.type === "twitter_update";
    if (lowValueBinanceUpdate(event, labels)) return "binance_low_value";
    if (labels.has("安全/紧急公告") && BINANCE_SECURITY_EMERGENCY_ACTION.test(text)) {
      return "binance_security_emergency";
    }
    // A broad security label or a ticker in the headline is not evidence of
    // an active venue incident. Only the explicit action branch above may
    // enter the emergency T0 lane.
    if (labels.has("安全/紧急公告")) return "binance_information";
    const structuredTargetSet = structuredBinanceTargetSet(event);
    if (marketAnnouncementSource && structuredTargetSet.present && structuredTargetSet.complete) return "binance_market_catalyst";
    if (marketAnnouncementSource && [...labels].some((label) => BINANCE_T0_LABELS.has(label))) return "binance_market_catalyst";
    if ([...labels].some((label) => /活动|奖励|普通公告|维护|交易规则|市场公告/u.test(label))) return "binance_information";
    const structuredProductFeature = [event.binanceChange, event.developerChange].some((change) => (
      lower(change?.classification) === "product_feature" && change?.productFeature === true
    )) || event.productFeature === true;
    const agentNativeProductFeature = ["binance_official_update", "twitter_update"].includes(event.type)
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
  if (isStrictFourMemeMarketCampaign(event)) return "focus_market_campaign";
  if (isOfficialFourMemeCapabilityUpdate(event)) return "focus_official";
  if (focusPlatform(platform)) {
    if (event.type === "bsc_launchpad_update" && event.kind === "flap_pool_token") {
      return isClosedFlapTrackedTokenMonitor(event) ? "focus_onchain" : "information";
    }
    if (["bsc_launchpad_update", "evm_launchpad_update", "token_launch"].includes(event.type)) return "focus_onchain";
    if (event.type === "github_module_update" && !materialFocusGithub(event)) return "developer_maintenance";
    return "focus_official";
  }
  if (event.type === "github_module_update" || event.type === "github_monitor_gap" || event.kind === "developer_update") return "developer_maintenance";
  return "information";
}

const FOCUS_STRUCTURAL_CHANGE_KEYS = [
  "newFlapPools", "updatedFlapPools", "newQuoteTokens", "removedQuoteTokens", "newQuoteConfigs",
  "removedQuoteConfigs", "updatedQuoteConfigs", "quoteConfigChanges", "newContracts", "removedContracts",
  "newModules", "removedModules", "newVersions", "removedVersions", "newPackages", "removedPackages",
  "updatedPackages", "packageVersionChanges", "newChains",
];

function explicitTradingPath(event = {}, eventCategory, target) {
  if (eventCategory === "pon_structural") {
    return PON_STRUCTURAL_KINDS.has(event.kind)
      || (event.type === "twitter_update"
        && event.signal?.ponPriority === "T1"
        && event.signal?.platformStructural === true
        && event.signal?.majorProductUpdate === true);
  }
  if (["focus_registry_first_token", "focus_registry_delayed_recovery", "focus_registry_canonical_revision"].includes(eventCategory)) return false;
  if (eventCategory === "focus_registry_capability") return isStrictFourRegistryCapabilityForPriority(event);
  if (eventCategory === "focus_onchain") return onchainEvidence(event);
  if (eventCategory === "focus_official") {
    if (isOfficialFourMemeCapabilityUpdate(event)) return true;
    if (event.type === "github_module_update") return materialFocusGithub(event);
    if (isFlapQuoteFirstObservedAfterGap(event)) return false;
    const flapQuotePools = [
      ...list(event.changes?.newFlapPools),
      ...list(event.changes?.updatedFlapPools),
      ...list(event.changes?.flapPoolChanges).map((change) => change?.after || change),
    ].filter((pool) => pool?.kind === "quote_asset");
    const flapQuotePair = normalizedPlatform(event) === "flap"
      && event.signal?.quotePairChange?.assetClass === "bstock_quote"
      && ["announced", "live"].includes(event.signal?.quotePairChange?.stage)
      && list(event.signal?.quotePairChange?.assets).length > 0;
    if (normalizedPlatform(event) === "flap" && (flapQuotePair || flapQuotePools.length)) {
      // A raw CA is durable audit evidence, but it is not a readable trading
      // target. Keep it T2 until the symbol has been verified and backfilled.
      return flapQuotePair || flapQuotePools.every((pool) => /^[A-Za-z0-9][A-Za-z0-9_$.-]{0,23}$/.test(clean(pool?.quoteSymbol)));
    }
    if (event.signal?.platformStructural === true || event.chainSupportChange?.candidate === true) return true;
    if (list(event.chainSupport).length || list(event.newContracts).length) return true;
    return FOCUS_STRUCTURAL_CHANGE_KEYS.some((key) => list(event.changes?.[key]).length > 0);
  }
  if (eventCategory === "binance_market_catalyst") {
    const structured = structuredBinanceTargetSet(event);
    const structuredRequired = binanceStructuredTargetRequired(event, eventCategory);
    return target.exact && (!structuredRequired || (structured.present && structured.complete));
  }
  if (eventCategory === "binance_security_emergency") {
    return target.type === "venue"
      && target.value === "Binance"
      && BINANCE_SECURITY_EMERGENCY_ACTION.test(eventText(event));
  }
  if (eventCategory === "binance_product") {
    const structuredProduct = [event.binanceChange, event.developerChange].some((change) => (
      lower(change?.classification) === "product_feature" && change?.productFeature === true
    )) || event.productFeature === true;
    const agentNative = /\bAgent\s+(?:OS|Native)|\bBinance\s+MCP\s+Server\b|\/agent-native\//iu.test(eventText(event));
    const namedModule = event.signal?.strong === true
      && /\b(?:introduc(?:e|es|ed)|launch(?:es|ed)?|add(?:s|ed)?)\b[^\n]{0,80}\b(?:web3\s+api|wallet\s+api|api\s+module|product\s+feature)\b/iu.test(eventText(event));
    return structuredProduct || agentNative || namedModule;
  }
  if (eventCategory.startsWith("fomo_")) {
    return target.exact && (FOMO_SINGLE_KINDS.has(event.signalKind)
      || FOMO_OFFICIAL_KINDS.has(event.signalKind)
      || event.signalKind === "top_blogger_convergence");
  }
  return false;
}

function catalystScore(eventCategory) {
  if (eventCategory === "pon_structural") return 3;
  if (eventCategory === "pon_information") return 1;
  if (eventCategory === "focus_registry_capability") return 3;
  if (["focus_registry_first_token", "focus_registry_delayed_recovery", "focus_registry_canonical_revision"].includes(eventCategory)) return 1;
  if (["binance_market_catalyst", "binance_security_emergency", "focus_onchain", "fomo_cluster", "fomo_official_exact"].includes(eventCategory)) return 5;
  if (["binance_product", "focus_official", "fomo_single", "fomo_signal"].includes(eventCategory)) return 3;
  if (eventCategory === "focus_market_campaign") return 1;
  if (eventCategory === "binance_information") return 1;
  return 0;
}

function capitalFlowScore(eventCategory) {
  if (eventCategory === "pon_structural") return 1;
  if (eventCategory === "pon_information") return 0;
  if (["focus_registry_capability", "focus_registry_first_token", "focus_registry_delayed_recovery", "focus_registry_canonical_revision"].includes(eventCategory)) return 0;
  if (["binance_market_catalyst", "binance_security_emergency", "fomo_cluster", "fomo_official_exact"].includes(eventCategory)) return 3;
  if (["focus_onchain", "fomo_single"].includes(eventCategory)) return 2;
  if (["binance_product", "focus_official"].includes(eventCategory)) return 1;
  if (eventCategory === "focus_market_campaign") return 1;
  return 0;
}

function lifecycleProduct(event = {}, text = eventText(event)) {
  const explicit = clean(event.lifecycle?.product || event.lifecycleProduct || event.productLifecycle?.product);
  if (explicit) return lower(explicit).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (normalizedPlatform(event) === "flap" && (
    event.signal?.quotePairChange?.assetClass === "bstock_quote"
    || list(event.changes?.newFlapPools).some((pool) => pool?.kind === "quote_asset")
    || list(event.changes?.updatedFlapPools).some((pool) => pool?.kind === "quote_asset")
    || list(event.changes?.flapPoolChanges).some((change) => (change?.after || change)?.kind === "quote_asset")
  )) return "quote-pair";
  if (/\bmeme\s+arena\b/iu.test(text)) return "meme-arena";
  if (/\bopen\s*four\b/iu.test(text)) return "openfour";
  if (/\bmeme\s+rush\b/iu.test(text)) return "meme-rush";
  const label = clean(event.mode?.officialName || event.mode?.componentMode || event.mode?.selectorName || event.signal?.category);
  return label ? lower(label).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : null;
}

function lifecycleStage(event = {}, text = eventText(event)) {
  const explicit = clean(event.lifecycle?.stage || event.lifecycleStage || event.productLifecycle?.stage || event.stage);
  if (explicit) return lower(explicit).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (normalizedPlatform(event) === "flap" && ["announced", "live", "observed"].includes(event.signal?.quotePairChange?.stage)) {
    return event.signal.quotePairChange.stage;
  }
  if (normalizedPlatform(event) === "flap" && (
    list(event.changes?.newFlapPools).some((pool) => pool?.kind === "quote_asset" && pool?.quoteSymbol)
    || list(event.changes?.updatedFlapPools).some((pool) => pool?.kind === "quote_asset" && pool?.quoteSymbol)
    || list(event.changes?.flapPoolChanges).some((change) => (change?.after || change)?.kind === "quote_asset" && (change?.after || change)?.quoteSymbol)
  )) return "live";
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
  if (eventCategory === "focus_policy_recovery") {
    return {
      conclusion: { zh: "历史补报｜勿追价", en: "Historical recovery | do not chase" },
      mainline: {
        zh: "Four.Meme 历史漏报修复→仅补齐监控记录",
        en: "Four.Meme historical policy fix→restore monitoring coverage only",
      },
      capitalPath: {
        zh: "事件已过时；不据此推导当前资金路径",
        en: "The event is stale; do not infer a current capital path",
      },
      entryCondition: {
        zh: "不执行买入；如需评估，仅使用当前标的、流动性与量价",
        en: "Do not execute a buy; any reassessment must use current asset, liquidity, and price-volume data",
      },
      invalidation: {
        zh: "原事件已被市场消化、活动结束或产品状态已变化",
        en: "The original event is priced in, the campaign has ended, or product state has changed",
      },
      risk: {
        zh: `历史补报，勿追价；${noAutoZh}`,
        en: `Historical recovery; do not chase; ${noAutoEn}`,
      },
    };
  }
  if (eventCategory === "focus_registry_canonical_revision") {
    const firstToken = isStrictFourRegistryFirstTokenForPriority(event);
    return {
      conclusion: {
        zh: "链重组修订｜旧证据失效｜以本条为准｜勿买",
        en: "Chain-reorg revision | prior proof invalid | use this update | do not buy",
      },
      mainline: {
        zh: firstToken
          ? "OpenFour Core canonical TokenCreated 修订→仅更新首币来源证明"
          : "OpenFour Registry canonical 修订→更新协议/创建能力状态",
        en: firstToken
          ? "Canonical OpenFour Core TokenCreated revision→updates first-token provenance only"
          : "Canonical OpenFour Registry revision→updates protocol or creation-capability state",
      },
      capitalPath: {
        zh: "链重组修订不建立新的可执行资金路径",
        en: "A chain-reorg revision does not establish a new executable capital path",
      },
      entryCondition: {
        zh: "不执行买入；按本条 canonical 证据重新核验状态与安全性",
        en: "Do not buy; reassess state and safety from this canonical proof",
      },
      invalidation: {
        zh: "后续 canonical 证据再次修订或该能力失效",
        en: "A later canonical revision or capability invalidation",
      },
      risk: {
        zh: `旧区块证据已失效，勿追价；${noAutoZh}`,
        en: `The prior-block proof is invalid; do not chase; ${noAutoEn}`,
      },
    };
  }
  if (["focus_registry_capability", "focus_registry_delayed_recovery"].includes(eventCategory)) {
    const delayed = eventCategory === "focus_registry_delayed_recovery";
    return {
      conclusion: delayed
        ? { zh: "延迟补报｜勿追价", en: "Delayed recovery | do not chase" }
        : { zh: "观察结构变化｜不买入", en: "Watch the structural change | no buy" },
      mainline: {
        zh: "OpenFour Registry 官方链上变更→协议/创建能力更新",
        en: "Official OpenFour Registry change→protocol or creation capability update",
      },
      capitalPath: {
        zh: "结构变化不等于代币安全、流动性或可执行资金路径",
        en: "A structural change does not establish token safety, liquidity, or an executable capital path",
      },
      entryCondition: {
        zh: "等待能力实际使用后的 TokenCreated CA，再独立做安全检查",
        en: "Wait for a TokenCreated CA using the capability, then run an independent safety review",
      },
      invalidation: {
        zh: "能力停用、后续未被采用或链上状态再次变化",
        en: "Capability disabled, no subsequent adoption, or another on-chain state change",
      },
      risk: delayed
        ? { zh: `补扫事件可能已被市场消化，勿追价；${noAutoZh}`, en: `The catch-up event may already be priced in; do not chase; ${noAutoEn}` }
        : { zh: `仅结构信息；${noAutoZh}`, en: `Structural information only; ${noAutoEn}` },
    };
  }
  if (eventCategory === "focus_registry_first_token") {
    return {
      conclusion: { zh: "观察｜不买入", en: "Watch | no buy" },
      mainline: {
        zh: "OpenFour 官方 Core 首币证明→仅确认新能力已被实际使用",
        en: "Official OpenFour Core first-token proof→confirms only that the capability was used",
      },
      capitalPath: {
        zh: "首币出现不等于安全、流动性或持续资金流",
        en: "A first token does not establish safety, liquidity, or durable capital flow",
      },
      entryCondition: {
        zh: "不自动交易；独立核验合约、安全、池深与可卖性后再评估",
        en: "No automatic trading; independently verify contract safety, pool depth, and sellability",
      },
      invalidation: {
        zh: "能力回滚、代币风险、流动性不足或无法卖出",
        en: "Capability rollback, token risk, weak liquidity, or impaired selling",
      },
      risk: { zh: `首币卡仅作来源证明；${noAutoZh}`, en: `The first-token card proves provenance only; ${noAutoEn}` },
    };
  }
  if (eventCategory === "focus_market_campaign") {
    return {
      conclusion: { zh: "观察", en: "Watch" },
      mainline: {
        zh: "Four.Meme bStock 合作榜单→短期平台流量与交易注意力",
        en: "Four.Meme bStock partner leaderboard→short-term platform traffic and trading attention",
      },
      capitalPath: {
        zh: "奖池激励→活动成交量与注意力；不是协议升级",
        en: "Prize incentives→campaign volume and attention; not a protocol upgrade",
      },
      entryCondition: {
        zh: "未指定代币 CA；仅在具体标的、池子深度与成交可核验后再评估",
        en: "No token CA is specified; reassess only after a concrete asset, pool depth, and volume are verifiable",
      },
      invalidation: {
        zh: "活动结束、榜单规则变化或无真实成交承接",
        en: "Campaign expiry, leaderboard-rule changes, or no real trading follow-through",
      },
      risk: {
        zh: `流量活动不等于协议能力或买入信号；${noAutoZh}`,
        en: `A traffic campaign is neither a protocol capability nor a buy signal; ${noAutoEn}`,
      },
    };
  }
  if (eventCategory === "focus_official" && isOfficialFourMemeCapabilityUpdate(event)) {
    const unpublished = event.changeType === "template_unpublished";
    const templateName = clean(event.currentTemplate?.name || event.mode?.officialName) || "Four.Meme 模板";
    return {
      conclusion: { zh: unpublished ? "停止沿用" : "观察", en: unpublished ? "Stop relying on it" : "Watch" },
      mainline: {
        zh: unpublished
          ? `Four.Meme 官方下架 ${templateName}→该模板不再视为当前可用`
          : `Four.Meme 官方模板 ${templateName} 更新→等待真实启用与后续首币`,
        en: unpublished
          ? `Four.Meme officially unpublished ${templateName}→do not treat the template as currently available`
          : `Four.Meme official template ${templateName} changed→await real activation and a subsequent first token`,
      },
      capitalPath: {
        zh: unpublished ? "能力撤回→不建立买入路径" : "模板能力→真实启用→后续发行流动性",
        en: unpublished ? "Capability withdrawal→no buy path" : "Template capability→real activation→subsequent launch liquidity",
      },
      entryCondition: {
        zh: unpublished ? "不执行买入；等待官方重新发布和链上启用" : "未指定代币 CA；仅在启用后首币安全、流动性与成交确认时再评估",
        en: unpublished ? "Do not buy; await official republication and on-chain activation" : "No token CA is specified; reassess only after activation and first-token safety, liquidity, and volume confirmation",
      },
      invalidation: {
        zh: unpublished ? "官方重新发布且链上状态重新启用" : "模板撤回、未启用或没有安全首币",
        en: unpublished ? "Official republication plus renewed on-chain activation" : "Template withdrawal, no activation, or no safe first token",
      },
      risk: {
        zh: `官方 API 变化不等于可交易代币；${noAutoZh}`,
        en: `An official API change is not a tradable token; ${noAutoEn}`,
      },
    };
  }
  if (["pon_structural", "pon_information"].includes(eventCategory)) {
    const structural = eventCategory === "pon_structural";
    return {
      conclusion: { zh: structural ? "观察" : "不做", en: structural ? "Watch" : "Do not trade" },
      mainline: {
        zh: structural ? "pon.fun 结构/平台币变化→关注平台流量与后续市场" : "pon.fun 市场/RWA 信息→仅记录",
        en: structural ? "pon.fun structure/platform-token change→watch platform flow and subsequent markets" : "pon.fun market/RWA information→record only",
      },
      capitalPath: { zh: structural ? "平台注意力→后续市场流动性" : "未形成直接可执行资金路径", en: structural ? "Platform attention→subsequent market liquidity" : "No direct executable capital path" },
      entryCondition: { zh: "等待精确标的、流动性、可卖性与量价确认", en: "Wait for an exact target, liquidity, sellability, and price-volume confirmation" },
      invalidation: { zh: "配置回滚、预言机/背书风险或无真实承接", en: "Config rollback, oracle/backing risk, or no real support" },
      risk: { zh: `平台币/股票映射不等于股票；${noAutoZh}`, en: `Platform coins/stock mappings are not shares; ${noAutoEn}` },
    };
  }
  if (eventCategory === "binance_security_emergency") {
    return {
      conclusion: { zh: "规避风险", en: "Reduce risk" },
      mainline: { zh: "Binance 平台风险→充提、交易与相关资产流动性", en: "Binance venue risk→deposits, withdrawals, trading, and related-asset liquidity" },
      capitalPath: { zh: "平台风险→充提/交易/相关资产流动性", en: "Venue risk→funding/trading/related-asset liquidity" },
      entryCondition: { zh: "核对公告影响范围、链上异常与恢复条件", en: "Verify affected scope, on-chain anomalies, and recovery conditions" },
      invalidation: { zh: "官方确认恢复且链上资金流正常", en: "Official recovery confirmed and on-chain flows normalize" },
      risk: { zh: `不要把安全事故当作抄底信号；${noAutoZh}`, en: `Do not treat a security incident as a dip-buy signal; ${noAutoEn}` },
    };
  }
  if (eventCategory === "binance_market_catalyst") {
    const delist = /delist|下架/iu.test(eventText(event));
    const announcementMarket = lower(event.announcementDetails?.market);
    const perpetualMarket = ["usd_m_perpetual", "coin_m_perpetual"].includes(announcementMarket);
    const alphaMarket = /\bbinance\s+alpha\b|币安\s*alpha|alpha\s*上新/iu.test(eventText(event));
    const tradFiPerpetual = perpetualMarket && (
      /\b(?:tradfi|stocks?|equities|equity|shares?)\b|传统金融|股票|证券/iu.test(eventText(event))
      || lower(event.announcementDetails?.assetClass) === "tradfi"
      || event.announcementDetails?.spotMappingConfirmed === false
    );
    if (perpetualMarket) {
      return {
        conclusion: { zh: delist ? "不做" : "观察", en: delist ? "Do not trade" : "Watch" },
        mainline: {
          zh: delist ? "Binance 永续下架→仓位与结算风险" : "Binance 新永续入口→开盘深度、持仓与基差",
          en: delist ? "Binance perpetual delisting→position and settlement risk" : "New Binance perpetual access→opening depth, open interest, and basis",
        },
        capitalPath: {
          zh: delist ? "永续下架→仓位、保证金与结算" : "永续盘口→成交深度、持仓量、资金费率与基差",
          en: delist ? "Perpetual delisting→positions, margin, and settlement" : "Perpetual order book→depth, open interest, funding, and basis",
        },
        entryCondition: {
          zh: delist ? "不新增仓位；核对停止交易与结算时间" : "仅在开盘深度、成交、持仓与资金费率可验证时观察",
          en: delist ? "Do not add positions; verify trading-stop and settlement times" : "Watch only when opening depth, volume, open interest, and funding are verifiable",
        },
        invalidation: {
          zh: delist ? "未平仓、流动性枯竭或结算异常" : "开盘深度不足、资金费率/基差失真或公告撤回",
          en: delist ? "Open positions, vanishing liquidity, or settlement anomalies" : "Weak opening depth, distorted funding/basis, or notice withdrawal",
        },
        risk: {
          zh: `${tradFiPerpetual ? "永续合约不等于现货股票" : "永续上线不证明现货或Alpha已上线"}；${noAutoZh}`,
          en: `${tradFiPerpetual ? "A perpetual contract is not the underlying cash equity" : "A perpetual launch does not prove a spot or Alpha listing"}; ${noAutoEn}`,
        },
      };
    }
    if (delist) {
      return {
        conclusion: { zh: "不做", en: "Do not trade" },
        mainline: {
          zh: `Binance ${alphaMarket ? "Alpha" : "现货"}下架→订单、退出与流动性风险`,
          en: `Binance ${alphaMarket ? "Alpha" : "spot"} delisting→order, exit, and liquidity risk`,
        },
        capitalPath: {
          zh: `${alphaMarket ? "Alpha" : "现货"}下架→订单、退出与流动性`,
          en: `${alphaMarket ? "Alpha" : "Spot"} delisting→orders, exits, and liquidity`,
        },
        entryCondition: {
          zh: "不新增仓位；核对停止交易、撤单与提现安排",
          en: "Do not add positions; verify trading stop, order cancellation, and withdrawal arrangements",
        },
        invalidation: {
          zh: "未撤单、提现受限或流动性枯竭",
          en: "Open orders, restricted withdrawals, or vanishing liquidity",
        },
        risk: { zh: noAutoZh, en: noAutoEn },
      };
    }
    return {
      conclusion: { zh: "观察", en: "Watch" },
      mainline: {
        zh: `Binance ${alphaMarket ? "Alpha" : "现货"}入口→${target.value || "目标资产"}价格发现`,
        en: `Binance ${alphaMarket ? "Alpha" : "spot"} access→price discovery for ${target.value || "the target asset"}`,
      },
      capitalPath: {
        zh: `${alphaMarket ? "Alpha" : "现货"}开盘→成交深度与价格发现`,
        en: `${alphaMarket ? "Alpha" : "Spot"} launch→trading depth and price discovery`,
      },
      entryCondition: {
        zh: "仅在开盘成交、深度与价格发现可验证时观察",
        en: "Watch only when opening volume, depth, and price discovery are verifiable",
      },
      invalidation: {
        zh: "深度不足、价格失真或公告撤回",
        en: "Weak depth, distorted pricing, or notice withdrawal",
      },
      risk: { zh: noAutoZh, en: noAutoEn },
    };
  }
  if (["focus_onchain", "focus_official"].includes(eventCategory)) {
    const blocked = event.security?.decision === "block";
    const trackedOrdinal = flapTrackedTokenOrdinal(event);
    if (trackedOrdinal != null) {
      const quote = clean(event.mode?.quoteSymbol || event.mode?.quoteName || event.mode?.quoteAsset) || "Flap 底池";
      const decision = lower(event.security?.decision);
      const delayedRecovery = isFlapTrackedTokenDelayedRecovery(event);
      const canonicalRevision = isFlapTrackedTokenCanonicalRevision(event);
      const safetyConclusion = decision === "pass"
        ? {
            zh: "观察；静态初筛通过，可卖性仍待验证",
            en: "Watch; static screening passed; sellability still unverified",
          }
        : decision === "block"
          ? { zh: "⛔ 不买；安全门已拦截", en: "⛔ Do not buy; safety gate blocked" }
          : { zh: "安全未完成｜不买", en: "Safety incomplete | do not buy" };
      const conclusion = canonicalRevision
        ? {
            zh: "链重组修订｜以本条 CA 为准｜不买",
            en: "Chain-reorg revision | use this CA as canonical | do not buy",
          }
        : delayedRecovery
        ? {
            zh: `延迟补报｜勿追价｜${safetyConclusion.zh}`,
            en: `Delayed recovery | do not chase | ${safetyConclusion.en}`,
          }
        : safetyConclusion;
      return {
        conclusion,
        mainline: {
          zh: `官方 TokenCreated→${quote} 第 ${trackedOrdinal}/3 个代币`,
          en: `Official TokenCreated→token ${trackedOrdinal}/3 paired with ${quote}`,
        },
        capitalPath: {
          zh: "仅监控底池注意力与后续流动性，不构成交易准入",
          en: "Monitor pool attention and follow-on liquidity only; this is not trade admission",
        },
        entryCondition: {
          zh: "不执行买入；继续核验可卖性、流动性与量价",
          en: "Do not execute a buy; continue verifying sellability, liquidity, and price-volume",
        },
        invalidation: {
          zh: "不可卖、撤池、权限风险或无量价承接",
          en: "Unsellable, liquidity removal, permission risk, or no price-volume support",
        },
        risk: {
          zh: canonicalRevision
            ? "链重组修订；非自动交易"
            : delayedRecovery ? "延迟补报｜勿追价；非自动交易" : "非自动交易",
          en: canonicalRevision
            ? "Chain-reorg revision; no automatic trading"
            : delayedRecovery ? "Delayed recovery | do not chase; no automatic trading" : "No automatic trading",
        },
      };
    }
    const quotePools = [
      ...list(event.changes?.newFlapPools),
      ...list(event.changes?.updatedFlapPools),
      ...list(event.changes?.flapPoolChanges).map((change) => change?.after || change),
    ].filter((pool) => pool?.kind === "quote_asset");
    const quotePair = event.signal?.quotePairChange;
    const flapQuoteUpdate = normalizedPlatform(event) === "flap"
      && (quotePair?.assetClass === "bstock_quote" || quotePools.length > 0);
    if (flapQuoteUpdate) {
      const delayedRecovery = isFlapQuoteDelayedRecovery(event);
      const firstObservedAfterGap = isFlapQuoteFirstObservedAfterGap(event);
      const boardObserved = isFlapBoardQuoteObserved(event);
      const bstock = quotePair?.assetClass === "bstock_quote"
        || /(?:bstock|stock|equity|ETF|证券|股票)/iu.test([
          ...list(quotePair?.assets).flatMap((asset) => [asset?.name, asset?.classification, ...list(asset?.tags)]),
          ...quotePools.flatMap((pool) => [pool?.quoteName, pool?.quoteClassification, ...list(pool?.quoteTags)]),
        ].filter(Boolean).join(" "));
      const assets = [
        ...list(quotePair?.assets).map((asset) => clean(asset?.symbol)),
        ...quotePools.map((pool) => clean(pool?.quoteSymbol)),
      ].filter(Boolean);
      const labels = [...new Set(assets)].join("/") || "报价资产";
      const live = !boardObserved && (quotePair?.stage === "live" || quotePools.some((pool) => pool?.quoteSymbol));
      return {
        conclusion: { zh: blocked ? "不做" : "观察", en: blocked ? "Do not trade" : "Watch" },
        mainline: {
          zh: firstObservedAfterGap
            ? `补扫首次确认 ${labels} 当前启用→此前是否 0→1 未证，仅观察后续`
            : delayedRecovery
            ? `断线恢复补报 ${labels} 报价底池启用→仅观察后续真实新币`
            : boardObserved
            ? `Flap 官方看板首次确认观察到 ${labels} 报价资产→等待 Portal 0→1 与后续真实新币`
            : live
            ? `Flap 启用 ${labels} 报价底池→关注后续以其计价的新币`
            : `Flap 预告 ${labels} 报价底池→等待链上启用与首个真实新币`,
          en: firstObservedAfterGap
            ? `Backfill first confirmed ${labels} currently enabled→prior 0→1 is unproven; watch only`
            : delayedRecovery
            ? `Recovered ${labels} quote-pool enablement after an outage→watch only for subsequent live tokens`
            : boardObserved
            ? `Flap official Board first confirmed the ${labels} quote asset→await Portal 0→1 and subsequent live tokens`
            : live
            ? `Flap enabled ${labels} quote pools→watch subsequent tokens priced in them`
            : `Flap announced ${labels} quote pools→await on-chain enablement and the first live token`,
        },
        capitalPath: {
          zh: firstObservedAfterGap
            ? "当前报价资产→代币定价/结算→后续发行流动性"
            : boardObserved
            ? "官方看板观察→Portal 启用确认→后续发行流动性"
            : "官方报价资产→新币定价/结算→新发行流动性",
          en: firstObservedAfterGap
            ? "Current quote asset→token pricing/settlement→subsequent launch liquidity"
            : boardObserved
            ? "Official Board observation→Portal enablement confirmation→subsequent launch liquidity"
            : "Official quote asset→new-token pricing/settlement→launch liquidity",
        },
        entryCondition: {
          zh: blocked ? "本地安全门拦截，不入场" : firstObservedAfterGap
            ? "此前是否新增或 0→1 未证；勿追价；核对 Portal CA 后仅等待后续安全、流动性与成交确认"
            : delayedRecovery
            ? "断线补报勿追价；核对 Portal CA 后等待新币安全、流动性与成交确认"
            : boardObserved
            ? `${tier === "T2" ? "元数据延迟补齐，勿追价；" : ""}看板观察不等于 Portal 0→1；核对 CA 后等待链上启用、安全与成交确认`
            : "先核对 Portal/看板 CA，再等真实新币安全、流动性与成交确认",
          en: blocked ? "Local safety gate blocked; do not enter" : firstObservedAfterGap
            ? "Prior listing or 0→1 is unproven; do not chase; verify the Portal CA and await safety, liquidity, and volume confirmation"
            : delayedRecovery
            ? "Do not chase an outage recovery; verify the Portal CA, then await token safety, liquidity, and volume confirmation"
            : boardObserved
            ? `${tier === "T2" ? "Metadata arrived late; do not chase; " : ""}a Board observation is not Portal 0→1; verify the CA and await on-chain enablement, safety, and volume`
            : "Verify the Portal/board CA, then require a live token with safety, liquidity, and volume confirmation",
        },
        invalidation: {
          zh: boardObserved
            ? "Portal 未启用、CA 不一致、无后续发币或流动性不足"
            : "底池未启用、CA 不一致、无后续发币或流动性不足",
          en: boardObserved
            ? "Portal remains disabled, CA mismatch, no downstream launch, or weak liquidity"
            : "Pool not enabled, CA mismatch, no downstream launch, or weak liquidity",
        },
        risk: {
          zh: `${firstObservedAfterGap ? "补扫仅确认当前启用，此前是否新增或 0→1 未证，勿追价；" : delayedRecovery ? "断线恢复补报可能已被市场消化，勿追价；" : boardObserved ? "看板仅确认观察到资产，不证明 Portal 0→1；" : ""}${bstock ? "bStock 报价代币不等于 ETF/股票所有权；预言机、背书、" : "报价代币仍有合约、"}流动性与可卖性风险；${noAutoZh}`,
          en: `${firstObservedAfterGap ? "The backfill confirms only the current enabled state; prior listing or 0→1 is unproven; do not chase; " : delayedRecovery ? "An outage recovery may already be priced in; do not chase; " : boardObserved ? "The Board only confirms observation of the asset, not Portal 0→1; " : ""}${bstock ? "a bStock quote token is not ETF/share ownership; oracle, backing, " : "quote-token contract, "}liquidity, and sellability risks remain; ${noAutoEn}`,
        },
      };
    }
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
  const structuredTargets = structuredBinanceTargetSet(event);
  const structuredTargetsRequired = binanceStructuredTargetRequired(event, eventCategory);
  const target = exactTarget(event, text);
  const confirmation = trustedConfirmation(event);
  const window = validTradingWindow(event, nowMs);
  const riskBlocked = event.security?.decision === "block";
  const trackedOrdinal = isClosedFlapTrackedTokenMonitor(event)
    ? flapTrackedTokenOrdinal(event)
    : null;
  const trackedTokenCanonicalRevision = isFlapTrackedTokenCanonicalRevision(event);
  const trackedTokenDelayedRecovery = isFlapTrackedTokenDelayedRecovery(event);
  const focusSafety = trackedOrdinal != null
    ? lower(event.security?.decision) === "pass"
    : focusSafetyPassed(event);
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
    && confirmedFocusLeadToken(event)
    && !trackedTokenCanonicalRevision
    && !trackedTokenDelayedRecovery
    && focusSafety
    && onchainEvidence(event);
  const highCatalyst = ["binance_market_catalyst", "binance_security_emergency"].includes(eventCategory)
    || focusT0 || fomoT0;
  const safetyPassed = eventCategory.startsWith("fomo_")
    ? fomoSafety
    : eventCategory.startsWith("focus_")
      ? focusSafety
      : true;
  const explicitPath = explicitTradingPath(event, eventCategory, target);
  const hardGates = {
    exactTarget: target.exact,
    completeTargetSet: structuredTargetsRequired
      ? structuredTargets.present && structuredTargets.complete
      : !structuredTargets.present || structuredTargets.complete,
    trustedConfirmation: confirmation.trusted,
    validWindow: window.valid,
    safetyPassed: !riskBlocked && safetyPassed,
    explicitPath,
  };
  hardGates.t0Eligible = highCatalyst
    && hardGates.exactTarget
    && hardGates.completeTargetSet
    && hardGates.trustedConfirmation
    && hardGates.validWindow
    && hardGates.safetyPassed;
  hardGates.t1Eligible = hardGates.trustedConfirmation
    && hardGates.validWindow
    && hardGates.safetyPassed
    && hardGates.explicitPath;
  if (["focus_registry_capability", "focus_registry_first_token", "focus_registry_delayed_recovery", "focus_registry_canonical_revision"].includes(eventCategory)) {
    hardGates.t0Eligible = false;
  }
  if (["focus_registry_first_token", "focus_registry_delayed_recovery", "focus_registry_canonical_revision"].includes(eventCategory)) {
    hardGates.t1Eligible = false;
  }

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
  if (["focus_policy_recovery", "focus_registry_first_token", "focus_registry_delayed_recovery", "focus_registry_canonical_revision"].includes(eventCategory)) tier = "T2";
  else if (trackedTokenCanonicalRevision || trackedTokenDelayedRecovery) tier = "T2";
  else if (hardGates.t0Eligible && score >= 10) tier = "T0";
  else if (["developer_maintenance", "binance_low_value"].includes(eventCategory)) tier = "T3";
  else if (eventCategory === "pon_information") tier = "T2";
  else if (eventCategory === "binance_information" || eventCategory === "information") tier = "T2";
  else if (isFlapQuoteDelayedRecovery(event) || isFlapQuoteFirstObservedAfterGap(event)) tier = "T2";
  else if (hardGates.t1Eligible) tier = "T1";
  else tier = "T2";

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
    targets: Object.freeze((structuredTargets.present ? structuredTargets.targets : target.exact ? [target] : [])
      .map((item) => Object.freeze({ ...item, ...(item.pairs ? { pairs: Object.freeze([...item.pairs]) } : {}) }))),
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
    targets: Object.freeze([]),
    confirmation: Object.freeze({ trusted: false, kind: "legacy", value: null }),
    window: Object.freeze({ valid: false, basis: "legacy_pending", ageMs: null }),
    hardGates: Object.freeze({ exactTarget: false, completeTargetSet: false, trustedConfirmation: false, validWindow: false, safetyPassed: false, explicitPath: false, t0Eligible: false, t1Eligible: false }),
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
