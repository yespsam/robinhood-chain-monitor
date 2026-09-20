import { assessLocalTokenSecurity } from "./local-security.js";
import {
  evaluateGoPlusBscTokenSecurity,
  parseDexScreenerMarket,
} from "./fomo-call-monitor.js";

export const NARRATIVE_LIVE_EVIDENCE_SCHEMA = "narrative_live_evidence_v1";

export const NARRATIVE_LIVE_EVIDENCE_POLICY = Object.freeze({
  chainId: 56,
  marketTtlMs: 15_000,
  goPlusTtlMs: 30_000,
  totalBudgetMs: 5_000,
  negativeCacheMs: 2_000,
  maximumFutureSkewMs: 60_000,
  minimumLiquidityUsd: 25_000,
  maximumSlippageBps: 300,
  shadowNotionalUsd: 25,
  maximumShadowNotionalUsd: 100,
  maximumTax: 0.10,
  approximatePoolFeeBps: 100,
  approximateQuoteLiquidityFraction: 0.25,
});

const BSC = Object.freeze({ id: 56, chainId: 56, slug: "bsc", name: "BNB Smart Chain", evm: true });
const ADDRESS_RE = /^0x[a-f0-9]{40}$/u;
const ASSET_KEY_RE = /^eip155:(\d+)\/erc20:(0x[a-f0-9]{40})$/u;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const DEFAULT_DEX_SCREENER_BASE = "https://api.dexscreener.com/token-pairs/v1";
const DEFAULT_GOPLUS_BASE = "https://api.gopluslabs.io/api/v1/token_security";

const clean = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const present = (value) => value !== undefined && value !== null && value !== "";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function parseInstant(value) {
  if (!present(value)) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  const normalized = clean(value);
  if (/^\d{10,13}$/u.test(normalized)) {
    const number = Number(normalized);
    return normalized.length === 10 ? number * 1_000 : number;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function uniquePresent(values, normalize = clean) {
  return [...new Set(values.filter(present).map(normalize).filter(Boolean))];
}

function localized(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const zh = clean(value.zh ?? value.cn ?? value.chinese);
    const en = clean(value.en ?? value.english);
    return { zh: zh || en, en: en || zh };
  }
  const shared = clean(value);
  return { zh: shared, en: shared };
}

function firstLocalized(...values) {
  for (const value of values) {
    const candidate = localized(value);
    if (candidate.zh || candidate.en) return candidate;
  }
  return { zh: "", en: "" };
}

function percentage(value) {
  if (!present(value)) return null;
  const number = finite(value);
  if (number === null || number < 0 || number > 100) return null;
  return number;
}

function validSourceUrl(value, sourceKind) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      || (sourceKind === "demo_fixture" && url.protocol === "demo:");
  } catch {
    return false;
  }
}

/**
 * Conservatively maps a news/update event to narrative-trade evidence. It is
 * deliberately pure: no clock, network, catalog, or implicit trust lookup is
 * used. In particular, a source name that merely sounds official is not enough
 * to set `verified`.
 */
export function deriveNarrativeEvidenceFromEvent(event = {}) {
  const source = event?.source && typeof event.source === "object" ? event.source : {};
  const news = event?.news && typeof event.news === "object" ? event.news : {};
  const verification = event?.verification && typeof event.verification === "object"
    ? event.verification
    : {};
  const narrative = event?.narrative && typeof event.narrative === "object" ? event.narrative : {};
  const mechanismSource = event?.mechanism && typeof event.mechanism === "object"
    ? event.mechanism.summary ?? event.mechanism.thesis
    : event?.mechanism;
  const capitalFlowSource = event?.mechanism && typeof event.mechanism === "object"
    ? event.mechanism.capitalFlow
    : null;

  const headline = firstLocalized(
    narrative.headline,
    event?.headline,
    event?.title,
    news?.headline,
    news?.title,
    event?.summary,
    event?.message,
  );
  const mechanism = firstLocalized(mechanismSource, event?.thesis, narrative.mechanism);
  const capitalFlow = firstLocalized(capitalFlowSource, event?.capitalFlow, narrative.capitalFlow);

  const explicitSourceKinds = uniquePresent([
    narrative.sourceKind,
    event?.sourceKind,
    source.kind,
    news.sourceKind,
  ], (value) => clean(value).toLowerCase());
  const fallbackSourceKind = clean(event?.kind ?? source.id).toLowerCase() || null;
  const sourceKinds = explicitSourceKinds.length ? explicitSourceKinds : fallbackSourceKind ? [fallbackSourceKind] : [];
  const specificSourceUrls = uniquePresent([
    narrative.sourceUrl,
    event?.sourceUrl,
    news.sourceUrl,
    event?.url,
    event?.messageUrl,
  ]);
  const sourceUrls = specificSourceUrls.length ? specificSourceUrls : uniquePresent([source.url]);
  const sourceKind = sourceKinds.length === 1 ? sourceKinds[0] : null;
  const sourceUrl = sourceUrls.length === 1 ? sourceUrls[0] : null;

  const explicitPublicationClaims = [
    narrative.publishedAt,
    event?.publishedAt,
    event?.sourceOccurredAt,
    news.publishedAt,
  ].filter(present);
  // A joined sniper candidate carries the pool's on-chain timestamp separately
  // from the catalyst publication time. Once any explicit publication claim is
  // present, the generic event timestamp must not be allowed to make otherwise
  // valid news look contradictory merely because the pool launched later.
  const rawPublicationClaims = explicitPublicationClaims.length
    ? explicitPublicationClaims
    : [event?.occurredAt].filter(present);
  const publicationClaims = rawPublicationClaims.map(parseInstant);
  const publicationClaimsValid = publicationClaims.every((value) => value !== null);
  const publicationEvidenceConsistent = publicationClaimsValid
    && (publicationClaims.length < 2
      || Math.max(...publicationClaims) - Math.min(...publicationClaims)
        <= NARRATIVE_LIVE_EVIDENCE_POLICY.maximumFutureSkewMs);
  const publishedMs = publicationEvidenceConsistent && publicationClaims.length
    ? Math.min(...publicationClaims)
    : null;

  const trustedOfficialSource = source.official === true
    && ["official_verified", "verified_official"].includes(clean(source.trust).toLowerCase());
  const verifiedStatus = clean(verification.status).toLowerCase() === "verified";
  const verificationClaims = [
    narrative.verified,
    event?.verified,
    verification.verified,
    source.verified,
    news.verified,
    trustedOfficialSource ? true : null,
    verifiedStatus ? true : null,
  ].filter(present);
  const verificationClaimsValid = verificationClaims.every((value) => typeof value === "boolean");
  const verificationConsistent = verificationClaimsValid
    && !(verificationClaims.includes(true) && verificationClaims.includes(false));
  const verificationClaimed = verificationConsistent && verificationClaims.includes(true);

  const subjectClaims = [
    narrative.subjectMatch,
    event?.subjectMatch,
    verification.subjectMatch,
  ].filter(present);
  const subjectClaimsValid = subjectClaims.every((value) => typeof value === "boolean");
  const subjectMatch = subjectClaimsValid && subjectClaims.length > 0
    && subjectClaims.every((value) => value === true);

  const rawStrength = narrative.strength
    ?? event?.catalystStrength
    ?? event?.catalyst?.strength
    ?? event?.strength;
  const rawNovelty = narrative.novelty ?? event?.novelty ?? event?.catalyst?.novelty;
  const rawMechanismConfidence = narrative.mechanismConfidence
    ?? event?.mechanism?.confidence;
  const strength = percentage(rawStrength);
  const novelty = percentage(rawNovelty);
  const mechanismConfidence = percentage(rawMechanismConfidence);
  const rawHalfLifeMs = narrative.halfLifeMs ?? event?.halfLifeMs;
  const parsedHalfLifeMs = present(rawHalfLifeMs) ? finite(rawHalfLifeMs) : null;
  const halfLifeMs = parsedHalfLifeMs !== null && parsedHalfLifeMs > 0 ? parsedHalfLifeMs : null;

  const errors = [];
  if (sourceKinds.length !== 1) errors.push(sourceKinds.length ? "source_kind_conflict" : "source_kind_missing");
  if (sourceUrls.length !== 1 || !sourceUrl || !validSourceUrl(sourceUrl, sourceKind)) {
    errors.push(sourceUrls.length > 1 ? "source_url_conflict" : "source_url_invalid_or_missing");
  }
  if (!headline.zh && !headline.en) errors.push("headline_missing");
  if (!publicationEvidenceConsistent || publishedMs === null) errors.push("publication_time_invalid_or_conflicting");
  if (!verificationConsistent || !verificationClaimed) errors.push("verification_not_explicit");
  if (present(rawStrength) && strength === null) errors.push("strength_invalid");
  if (present(rawNovelty) && novelty === null) errors.push("novelty_invalid");
  if (present(rawMechanismConfidence) && mechanismConfidence === null) errors.push("mechanism_confidence_invalid");
  if (present(rawHalfLifeMs) && halfLifeMs === null) errors.push("half_life_invalid");

  const verified = verificationClaimed
    && verificationConsistent
    && Boolean(sourceKind)
    && Boolean(sourceUrl && validSourceUrl(sourceUrl, sourceKind))
    && Boolean(headline.zh || headline.en)
    && publicationEvidenceConsistent
    && publishedMs !== null;

  return deepFreeze({
    schema: "narrative_event_evidence_v1",
    verified,
    verificationClaimed,
    subjectMatch,
    sourceKind,
    sourceUrl,
    publishedAt: iso(publishedMs),
    headline,
    mechanism,
    capitalFlow,
    strength,
    novelty,
    mechanismConfidence,
    halfLifeMs,
    coverageComplete: errors.length === 0,
    publicationEvidenceConsistent,
    errors,
  });
}

function normalizedAddress(value) {
  const address = clean(value).toLowerCase();
  return ADDRESS_RE.test(address) && address !== ZERO_ADDRESS ? address : null;
}

function nestedAddress(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return value.address ?? value.pool ?? value.ca ?? value.tokenAddress ?? null;
}

function assetKeyParts(value) {
  const match = ASSET_KEY_RE.exec(clean(value).toLowerCase());
  if (!match) return null;
  const chainId = Number(match[1]);
  const ca = normalizedAddress(match[2]);
  return Number.isSafeInteger(chainId) && ca ? { chainId, ca } : null;
}

function normalizedPoolKind(value) {
  const kind = clean(value).toLowerCase();
  if (!kind) return "";
  if (/(?:^|[^a-z0-9])(?:v3|cl|concentrated|slipstream)(?:$|[^a-z0-9])/u.test(kind)) return "v3";
  if (/(?:^|[^a-z0-9])(?:v2|constant.?product)(?:$|[^a-z0-9])/u.test(kind)) return "v2";
  return kind;
}

function exactIdentity(input = {}) {
  const inputTargetAddress = typeof input?.target === "string" ? input.target : null;
  const target = input?.target && typeof input.target === "object" ? input.target : {};
  const evidence = input?.targetEvidence && typeof input.targetEvidence === "object"
    ? input.targetEvidence
    : {};
  const eventTarget = input?.event?.target && typeof input.event.target === "object"
    ? input.event.target
    : {};
  const errors = [];

  const rawAssetKeys = [input.assetKey, target.assetKey, evidence.assetKey, eventTarget.assetKey].filter(present);
  const parsedAssetKeys = rawAssetKeys.map(assetKeyParts);
  const rawChainClaims = [
    input.chainId,
    target.chainId,
    evidence.chainId,
    eventTarget.chainId,
    ...parsedAssetKeys.filter(Boolean).map((value) => value.chainId),
  ].filter(present);
  const chainClaimsValid = rawChainClaims.every((value) => Number.isSafeInteger(value));
  const chainClaims = chainClaimsValid ? [...new Set(rawChainClaims)] : [];

  const rawTokenClaims = [
    input.ca,
    input.targetAddress,
    input.tokenAddress,
    typeof input.token === "string" ? input.token : null,
    inputTargetAddress,
    target.ca,
    target.targetAddress,
    target.address,
    target.tokenAddress,
    typeof target.token === "string" ? target.token : null,
    evidence.ca,
    evidence.targetAddress,
    evidence.address,
    evidence.tokenAddress,
    typeof evidence.token === "string" ? evidence.token : null,
    eventTarget.ca,
    eventTarget.targetAddress,
    eventTarget.address,
    eventTarget.tokenAddress,
    ...parsedAssetKeys.filter(Boolean).map((value) => value.ca),
  ].filter(present);
  const tokenClaims = rawTokenClaims.map(normalizedAddress);

  const rawPoolClaims = [
    input.poolAddress,
    nestedAddress(input.pool),
    target.poolAddress,
    nestedAddress(target.pool),
    evidence.poolAddress,
    nestedAddress(evidence.pool),
    eventTarget.poolAddress,
    nestedAddress(eventTarget.pool),
  ].filter(present);
  const poolClaims = rawPoolClaims.map(normalizedAddress);

  if (rawChainClaims.length === 0) errors.push("chain_id_missing");
  else if (!chainClaimsValid) errors.push("chain_id_invalid");
  else if (chainClaims.length !== 1 || chainClaims[0] !== BSC.id) errors.push("chain_id_mismatch");
  if (rawTokenClaims.length === 0) errors.push("target_missing");
  else if (tokenClaims.some((value) => !value)) errors.push("target_invalid_or_zero");
  else if (new Set(tokenClaims).size !== 1) errors.push("target_conflict");
  if (rawPoolClaims.length === 0) errors.push("pool_missing");
  else if (poolClaims.some((value) => !value)) errors.push("pool_invalid_or_zero");
  else if (new Set(poolClaims).size !== 1) errors.push("pool_conflict");
  if (parsedAssetKeys.some((value) => !value)) errors.push("asset_key_invalid");

  const token = tokenClaims.find(Boolean) || null;
  const poolAddress = poolClaims.find(Boolean) || null;
  for (const parsed of parsedAssetKeys.filter(Boolean)) {
    if (parsed.chainId !== BSC.id) errors.push("asset_key_chain_mismatch");
    if (token && parsed.ca !== token) errors.push("asset_key_target_mismatch");
  }
  const poolKinds = uniquePresent([
    input.poolKind,
    typeof input.pool === "object" ? input.pool?.kind : null,
    target.poolKind,
    typeof target.pool === "object" ? target.pool?.kind : null,
    evidence.poolKind,
    typeof evidence.pool === "object" ? evidence.pool?.kind : null,
  ], normalizedPoolKind);
  if (poolKinds.length > 1) errors.push("pool_kind_conflict");

  return {
    valid: errors.length === 0,
    chainId: errors.includes("chain_id_missing") ? null : chainClaims[0] ?? null,
    ca: token,
    poolAddress,
    poolKind: poolKinds.length === 1 ? poolKinds[0] : null,
    assetKey: token ? `eip155:${BSC.id}/erc20:${token}` : null,
    errors: [...new Set(errors)],
  };
}

function positiveOption(value, fallback, minimum = 1) {
  const number = finite(value);
  return number !== null && number >= minimum ? number : fallback;
}

function policyFrom(options) {
  const overrides = options?.policy && typeof options.policy === "object" ? options.policy : {};
  const option = (name) => overrides[name] ?? options?.[name];
  return Object.freeze({
    ...NARRATIVE_LIVE_EVIDENCE_POLICY,
    marketTtlMs: positiveOption(option("marketTtlMs"), NARRATIVE_LIVE_EVIDENCE_POLICY.marketTtlMs),
    goPlusTtlMs: positiveOption(option("goPlusTtlMs"), NARRATIVE_LIVE_EVIDENCE_POLICY.goPlusTtlMs),
    totalBudgetMs: positiveOption(option("totalBudgetMs"), NARRATIVE_LIVE_EVIDENCE_POLICY.totalBudgetMs),
    negativeCacheMs: positiveOption(option("negativeCacheMs"), NARRATIVE_LIVE_EVIDENCE_POLICY.negativeCacheMs),
    minimumLiquidityUsd: positiveOption(option("minimumLiquidityUsd"), NARRATIVE_LIVE_EVIDENCE_POLICY.minimumLiquidityUsd, 0),
    maximumSlippageBps: positiveOption(option("maximumSlippageBps"), NARRATIVE_LIVE_EVIDENCE_POLICY.maximumSlippageBps, 0),
    shadowNotionalUsd: positiveOption(option("shadowNotionalUsd"), NARRATIVE_LIVE_EVIDENCE_POLICY.shadowNotionalUsd),
    maximumShadowNotionalUsd: positiveOption(option("maximumShadowNotionalUsd"), NARRATIVE_LIVE_EVIDENCE_POLICY.maximumShadowNotionalUsd),
    maximumTax: Math.max(0, Math.min(1, finite(option("maximumTax")) ?? NARRATIVE_LIVE_EVIDENCE_POLICY.maximumTax)),
    approximatePoolFeeBps: Math.max(0, Math.min(1_000, finite(option("approximatePoolFeeBps")) ?? NARRATIVE_LIVE_EVIDENCE_POLICY.approximatePoolFeeBps)),
    approximateQuoteLiquidityFraction: Math.max(0.01, Math.min(0.5,
      finite(option("approximateQuoteLiquidityFraction"))
        ?? NARRATIVE_LIVE_EVIDENCE_POLICY.approximateQuoteLiquidityFraction)),
  });
}

function budgetAbortError() {
  const error = new Error("narrative live evidence budget exhausted");
  error.code = "NARRATIVE_LIVE_EVIDENCE_BUDGET_EXHAUSTED";
  return error;
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(clean(reason) || "narrative live evidence request aborted");
  error.code = "NARRATIVE_LIVE_EVIDENCE_ABORTED";
  return error;
}

function raceWithAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
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

function safeError(error, source) {
  return {
    source,
    code: clean(error?.code) || `${source}_failed`,
    message: clean(error?.message || error).slice(0, 240) || `${source} failed`,
  };
}

function errorOutcome(error, source, checkedAtMs, negativeCacheMs) {
  return {
    ok: false,
    value: null,
    error: safeError(error, source),
    checkedAtMs,
    expiresAtMs: checkedAtMs + negativeCacheMs,
    cacheHit: false,
  };
}

function sourcePublic(outcome) {
  if (!outcome) return null;
  return {
    status: outcome.ok ? "ok" : "error",
    checkedAt: iso(outcome.checkedAtMs),
    expiresAt: iso(outcome.expiresAtMs),
    cacheHit: outcome.cacheHit === true,
    error: outcome.error || null,
  };
}

function isFresh(outcome, atMs, ttlMs, maximumFutureSkewMs) {
  if (!outcome || outcome.ok !== true || !Number.isFinite(outcome.checkedAtMs)) return false;
  const ageMs = atMs - outcome.checkedAtMs;
  return ageMs >= -maximumFutureSkewMs && ageMs < ttlMs && atMs < outcome.expiresAtMs;
}

function approximateV2Slippage(liquidityUsd, notionalUsd, policy) {
  if (!Number.isFinite(liquidityUsd) || liquidityUsd <= 0
    || !Number.isFinite(notionalUsd) || notionalUsd <= 0) return null;
  const usableQuoteLiquidityUsd = liquidityUsd * policy.approximateQuoteLiquidityFraction;
  const feeFraction = policy.approximatePoolFeeBps / 10_000;
  const effectiveInputUsd = notionalUsd * (1 - feeFraction);
  if (usableQuoteLiquidityUsd <= 0 || effectiveInputUsd <= 0) return null;
  const receivedVersusNoFeeSpot = (1 - feeFraction)
    * usableQuoteLiquidityUsd
    / (usableQuoteLiquidityUsd + effectiveInputUsd);
  const estimatedSlippageBps = Math.ceil(Math.max(0, Math.min(1, 1 - receivedVersusNoFeeSpot)) * 10_000);
  return {
    estimatedSlippageBps,
    method: "liquidity_only_constant_product_v2_conservative_v1",
    executableQuote: false,
    confidence: "approximation_only",
    assumptions: {
      totalLiquidityUsd: liquidityUsd,
      usableQuoteLiquidityUsd,
      quoteLiquidityFraction: policy.approximateQuoteLiquidityFraction,
      assumedPoolFeeBps: policy.approximatePoolFeeBps,
      notionalUsd,
    },
    limitations: [
      "Not a router or quoter response",
      "Assumes a constant-product V2 pool and a conservative fraction of reported USD liquidity",
      "Does not model transfer-tax, MEV, routing, or liquidity changes after observation",
    ],
  };
}

function blankMarketEvidence(asOfMs, policy, missing = []) {
  return {
    asOf: iso(asOfMs),
    dataHealth: "degraded",
    dataHealthy: false,
    coverageComplete: false,
    coverageGap: true,
    marketConfirmed: false,
    momentumConfirmed: false,
    walletClusterConfirmed: false,
    liquidityUsd: null,
    priceUsd: null,
    minimumLiquidityUsd: policy.minimumLiquidityUsd,
    estimatedSlippageBps: null,
    maximumSlippageBps: policy.maximumSlippageBps,
    slippageEstimate: null,
    entryWindow: "unknown",
    shadowNotionalUsd: policy.shadowNotionalUsd,
    missing: [...missing],
  };
}

function blankRiskEvidence(asOfMs, missing = []) {
  return {
    asOf: iso(asOfMs),
    coverageComplete: false,
    coverageGap: true,
    sellability: "unverified",
    sellable: null,
    cannotSell: null,
    riskLevel: "unknown",
    riskScore: null,
    highRisk: null,
    honeypot: null,
    ownerCanMint: null,
    ownerCanBlacklist: null,
    ownerCanFreeze: null,
    ownerCanPause: null,
    dynamicTax: null,
    missing: [...missing],
  };
}

function exactFlag(row, field) {
  if (!row || !Object.prototype.hasOwnProperty.call(row, field)) return null;
  if (String(row[field]) === "1") return true;
  if (String(row[field]) === "0") return false;
  return null;
}

function exactGoPlusRow(payload, token) {
  if (Number(payload?.code) !== 1 || !payload?.result || typeof payload.result !== "object") return null;
  const key = Object.keys(payload.result).find((candidate) => candidate.toLowerCase() === token);
  const row = key ? payload.result[key] : null;
  return row && typeof row === "object" ? row : null;
}

function localSecurityKnown(local) {
  const value = local?.value;
  const coverage = value?.metrics?.coverage || {};
  const reasons = Array.isArray(value?.reasons) ? value.reasons : [];
  return local?.ok === true
    && ["pass", "block"].includes(value?.decision)
    && coverage.bytecodeCapabilities === "static_selector_scan"
    && !reasons.some((reason) => /代码缺失/u.test(String(reason)));
}

function localHardRisk(local) {
  if (!localSecurityKnown(local)) return false;
  const metrics = local.value?.metrics || {};
  const activeOwner = normalizedAddress(metrics.owner)
    && ![ZERO_ADDRESS, "0x000000000000000000000000000000000000dead"].includes(String(metrics.owner).toLowerCase());
  return Boolean(activeOwner
    || metrics.proxyType
    || Object.values(metrics.capabilities || {}).some((value) => value === true));
}

function buildMarketEvidence({ dex, local, identity, asOfMs, notionalUsd, policy }) {
  const missing = [];
  const dexFresh = isFresh(dex, asOfMs, policy.marketTtlMs, policy.maximumFutureSkewMs);
  const localFresh = isFresh(local, asOfMs, policy.marketTtlMs, policy.maximumFutureSkewMs);
  const market = dex?.value || null;
  if (!dexFresh) missing.push("dex_market_missing_or_stale");
  if (!market || normalizedAddress(market.pairAddress) !== identity.poolAddress) missing.push("dex_exact_pair_missing");
  if (market?.kind !== "v2") missing.push("v2_pool_required_for_slippage_approximation");
  if (identity.poolKind && identity.poolKind !== market?.kind) missing.push("pool_kind_mismatch");
  if (!Number.isFinite(market?.liquidityUsd) || market.liquidityUsd <= 0) missing.push("liquidity_usd_missing");
  if (!Number.isFinite(market?.priceUsd) || market.priceUsd <= 0) missing.push("price_usd_missing");
  if (!localFresh || local?.value?.metrics?.liquidityConfirmed !== true) {
    missing.push("onchain_pool_liquidity_unconfirmed");
  }
  const slippage = market?.kind === "v2"
    ? approximateV2Slippage(market?.liquidityUsd, notionalUsd, policy)
    : null;
  if (!slippage) missing.push("slippage_estimate_unavailable");
  const uniqueMissing = [...new Set(missing)];
  const complete = uniqueMissing.length === 0;
  const momentumConfirmed = complete && Number(market.buysM5) > 0 && Number(market.sellsM5) > 0;
  const withinLimits = complete
    && market.liquidityUsd >= policy.minimumLiquidityUsd
    && slippage.estimatedSlippageBps <= policy.maximumSlippageBps;

  return {
    asOf: iso(asOfMs),
    observedAt: dexFresh ? iso(dex.checkedAtMs) : null,
    expiresAt: complete ? iso(Math.min(dex.expiresAtMs, local.expiresAtMs)) : null,
    dataHealth: complete ? "healthy" : "degraded",
    dataHealthy: complete,
    coverageComplete: complete,
    coverageGap: !complete,
    marketConfirmed: complete,
    momentumConfirmed,
    // No wallet provider is part of this module. False means not confirmed,
    // never an inferred negative wallet judgment.
    walletClusterConfirmed: false,
    chainId: identity.chainId,
    ca: identity.ca,
    poolAddress: identity.poolAddress,
    poolKind: complete ? market.kind : identity.poolKind,
    dexId: market?.dexId || null,
    pairCreatedAt: market?.pairCreatedAt ? iso(market.pairCreatedAt) : null,
    liquidityUsd: Number.isFinite(market?.liquidityUsd) ? market.liquidityUsd : null,
    priceUsd: Number.isFinite(market?.priceUsd) ? market.priceUsd : null,
    volumeM5Usd: Number.isFinite(market?.volumeM5) ? market.volumeM5 : null,
    buysM5: Number.isFinite(market?.buysM5) ? market.buysM5 : null,
    sellsM5: Number.isFinite(market?.sellsM5) ? market.sellsM5 : null,
    minimumLiquidityUsd: policy.minimumLiquidityUsd,
    estimatedSlippageBps: slippage?.estimatedSlippageBps ?? null,
    maximumSlippageBps: policy.maximumSlippageBps,
    slippageEstimate: slippage,
    entryWindow: complete ? (withinLimits && momentumConfirmed ? "open" : "closed") : "unknown",
    shadowNotionalUsd: notionalUsd,
    missing: uniqueMissing,
  };
}

function buildRiskEvidence({ goPlus, local, asOfMs, policy }) {
  const missing = [];
  const goFresh = isFresh(goPlus, asOfMs, policy.goPlusTtlMs, policy.maximumFutureSkewMs);
  const localFresh = isFresh(local, asOfMs, policy.marketTtlMs, policy.maximumFutureSkewMs);
  const evaluation = goPlus?.value?.evaluation || null;
  const row = goPlus?.value?.row || null;
  const localKnown = localFresh && localSecurityKnown(local);
  if (!goFresh || !["pass", "block"].includes(evaluation?.decision)) missing.push("goplus_security_missing_or_stale");
  if (!localKnown) missing.push("local_security_incomplete_or_stale");

  const explicitHoneypot = exactFlag(row, "is_honeypot");
  const explicitCannotSell = exactFlag(row, "cannot_sell_all");
  const cannotSell = explicitHoneypot === true || explicitCannotSell === true;
  const sellabilityVerified = goFresh
    && evaluation?.decision === "pass"
    && evaluation?.metrics?.cannotSellAllEvidence === "goplus_explicit_zero";
  if (evaluation?.decision === "pass" && !sellabilityVerified) missing.push("sellability_not_explicitly_verified");

  const hardRisk = (goFresh && evaluation?.decision === "block") || localHardRisk(local);
  const complete = [...new Set(missing)].length === 0;
  const pass = complete && !hardRisk && sellabilityVerified;
  const localCapabilities = local?.value?.metrics?.capabilities || {};
  const flagsKnownSafe = pass;
  const honeypot = cannotSell ? true : flagsKnownSafe ? false : explicitHoneypot;
  const ownerCanMint = localCapabilities.mint === true || exactFlag(row, "is_mintable") === true
    ? true
    : flagsKnownSafe ? false : null;
  const ownerCanBlacklist = localCapabilities.blacklist === true || exactFlag(row, "is_blacklisted") === true
    ? true
    : flagsKnownSafe ? false : null;
  const ownerCanPause = localCapabilities.pause === true || exactFlag(row, "transfer_pausable") === true
    ? true
    : flagsKnownSafe ? false : null;
  const dynamicTax = localCapabilities.tax === true
    || exactFlag(row, "personal_slippage_modifiable") === true
    || exactFlag(row, "slippage_modifiable") === true
    ? true
    : flagsKnownSafe ? false : null;

  return {
    asOf: iso(asOfMs),
    observedAt: goFresh ? iso(goPlus.checkedAtMs) : null,
    expiresAt: complete ? iso(Math.min(goPlus.expiresAtMs, local.expiresAtMs)) : null,
    coverageComplete: complete,
    coverageGap: !complete,
    sellability: cannotSell ? "cannot_sell" : pass ? "verified_sellable" : "unverified",
    sellable: cannotSell ? false : pass ? true : null,
    cannotSell: cannotSell ? true : pass ? false : null,
    riskLevel: hardRisk || cannotSell ? "high" : pass ? "low" : "unknown",
    riskScore: null,
    highRisk: hardRisk || cannotSell ? true : pass ? false : null,
    honeypot,
    ownerCanMint,
    ownerCanBlacklist,
    // GoPlus's strict pass plus a renounced owner supports a false value; no
    // such claim is emitted while either source is incomplete.
    ownerCanFreeze: flagsKnownSafe ? false : null,
    ownerCanPause,
    dynamicTax,
    buyTaxBps: Number.isFinite(evaluation?.metrics?.buyTax)
      ? Math.round(evaluation.metrics.buyTax * 10_000)
      : null,
    sellTaxBps: Number.isFinite(evaluation?.metrics?.sellTax)
      ? Math.round(evaluation.metrics.sellTax * 10_000)
      : null,
    coverage: {
      scope: "bsc_contract_sellability_v1",
      localStaticSecurity: localKnown ? "complete" : "incomplete",
      goPlusStrictSecurity: goFresh && ["pass", "block"].includes(evaluation?.decision) ? "complete" : "incomplete",
      sellability: cannotSell ? "explicitly_blocked" : sellabilityVerified ? "verified_goplus_explicit_zero" : "unverified",
      holderConcentration: "not_in_scope",
      lpLockOrBurn: "not_in_scope",
    },
    missing: [...new Set(missing)],
  };
}

function evidenceStatus(marketEvidence, riskEvidence) {
  if (!marketEvidence.coverageComplete || !riskEvidence.coverageComplete) return "partial";
  const blocked = riskEvidence.highRisk === true
    || riskEvidence.cannotSell === true
    || marketEvidence.liquidityUsd < marketEvidence.minimumLiquidityUsd
    || marketEvidence.estimatedSlippageBps > marketEvidence.maximumSlippageBps;
  return blocked ? "blocked" : "complete";
}

/**
 * Creates a bounded, cache-aware BSC live-evidence provider. The provider only
 * observes public data. It neither signs nor broadcasts transactions.
 */
export function createNarrativeLiveEvidenceProvider(options = {}) {
  const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch;
  const provider = options.provider ?? options.bscProvider ?? null;
  const assessLocalSecurity = options.assessLocalSecurity ?? assessLocalTokenSecurity;
  const parseDexMarket = options.parseDexMarket ?? parseDexScreenerMarket;
  const evaluateGoPlus = options.evaluateGoPlus ?? evaluateGoPlusBscTokenSecurity;
  const clock = options.now ?? Date.now;
  if (typeof clock !== "function") throw new TypeError("now must be a function");
  if (typeof assessLocalSecurity !== "function") throw new TypeError("assessLocalSecurity must be a function");
  const policy = policyFrom(options);
  const dexScreenerBase = clean(options.dexScreenerBase || DEFAULT_DEX_SCREENER_BASE).replace(/\/+$/u, "");
  const goPlusApiBase = clean(options.goPlusApiBase || DEFAULT_GOPLUS_BASE).replace(/\/+$/u, "");
  const marketCache = new Map();
  const goPlusCache = new Map();
  const localCache = new Map();
  const sourceInflight = new Map();
  const assessmentInflight = new Map();
  const controllers = new Set();
  let stopped = false;

  const clockNow = () => {
    const value = parseInstant(clock());
    if (!Number.isFinite(value)) throw new TypeError("now() must return a valid instant");
    return value;
  };

  async function fetchJson(url, signal, source) {
    if (typeof fetchImpl !== "function") {
      const error = new Error("fetch implementation is unavailable");
      error.code = `${source}_fetch_unavailable`;
      throw error;
    }
    const response = await raceWithAbort(fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "robinhood-chain-monitor/0.1 (narrative evidence)" },
      signal,
    }), signal);
    if (!response?.ok) {
      const error = new Error(`${source} HTTP ${Number(response?.status) || "unknown"}`);
      error.code = `${source}_http_error`;
      error.status = Number(response?.status) || null;
      throw error;
    }
    return raceWithAbort(response.json(), signal);
  }

  function cached(cache, key, atMs) {
    const value = cache.get(key);
    if (!value || atMs >= value.expiresAtMs) {
      if (value) cache.delete(key);
      return null;
    }
    return { ...value, cacheHit: true };
  }

  function loadSource({ cache, key, ttlMs, signal, source, loader }) {
    const atMs = clockNow();
    const cacheValue = cached(cache, key, atMs);
    if (cacheValue) return Promise.resolve(cacheValue);
    const inflightKey = `${source}:${key}`;
    const existing = sourceInflight.get(inflightKey);
    if (existing) return raceWithAbort(existing, signal).then((value) => ({ ...value, cacheHit: true }));

    const promise = (async () => {
      try {
        const loaded = await raceWithAbort(Promise.resolve().then(() => loader(signal)), signal);
        const checkedAtMs = clockNow();
        const ok = loaded?.ok === true;
        const outcome = {
          ok,
          value: loaded?.value ?? null,
          error: loaded?.error || null,
          checkedAtMs,
          expiresAtMs: checkedAtMs + (ok ? ttlMs : policy.negativeCacheMs),
          cacheHit: false,
        };
        cache.set(key, outcome);
        return outcome;
      } catch (error) {
        const outcome = errorOutcome(error, source, clockNow(), policy.negativeCacheMs);
        cache.set(key, outcome);
        return outcome;
      } finally {
        sourceInflight.delete(inflightKey);
      }
    })();
    sourceInflight.set(inflightKey, promise);
    return promise;
  }

  function loadDex(identity, signal) {
    const key = `${identity.chainId}:${identity.ca}:${identity.poolAddress}`;
    return loadSource({
      cache: marketCache,
      key,
      ttlMs: policy.marketTtlMs,
      signal,
      source: "dex_screener",
      loader: async (requestSignal) => {
        const payload = await fetchJson(
          `${dexScreenerBase}/bsc/${encodeURIComponent(identity.ca)}`,
          requestSignal,
          "dex_screener",
        );
        const value = parseDexMarket(payload, BSC, identity.ca, identity.poolAddress);
        if (!value || normalizedAddress(value.pairAddress) !== identity.poolAddress) {
          return {
            ok: false,
            error: { source: "dex_screener", code: "dex_exact_pair_missing", message: "DEX Screener did not return the requested BSC target/pair" },
          };
        }
        return { ok: true, value };
      },
    });
  }

  function loadGoPlus(identity, signal) {
    const key = `${identity.chainId}:${identity.ca}`;
    return loadSource({
      cache: goPlusCache,
      key,
      ttlMs: policy.goPlusTtlMs,
      signal,
      source: "goplus",
      loader: async (requestSignal) => {
        const payload = await fetchJson(
          `${goPlusApiBase}/56?contract_addresses=${encodeURIComponent(identity.ca)}`,
          requestSignal,
          "goplus",
        );
        // A DEX aggregate sell count is not a receipt-level proof. Do not use it
        // to supplement a missing cannot_sell_all field.
        const evaluation = evaluateGoPlus(payload, identity.ca, {
          maximumTax: policy.maximumTax,
          observedSell: false,
        });
        const value = { evaluation, row: exactGoPlusRow(payload, identity.ca) };
        if (!["pass", "block"].includes(evaluation?.decision)) {
          return {
            ok: false,
            value,
            error: { source: "goplus", code: "goplus_security_incomplete", message: clean(evaluation?.reason) || "GoPlus security evidence is incomplete" },
          };
        }
        return { ok: true, value };
      },
    });
  }

  function loadLocal(identity, poolKind, signal) {
    const key = `${identity.chainId}:${identity.ca}:${identity.poolAddress}:${poolKind || "unknown"}`;
    return loadSource({
      cache: localCache,
      key,
      ttlMs: policy.marketTtlMs,
      signal,
      source: "local_security",
      loader: async () => {
        if (!provider || typeof provider.getNetwork !== "function") {
          return {
            ok: false,
            error: { source: "local_security", code: "bsc_provider_identity_unavailable", message: "BSC provider network identity is unavailable" },
          };
        }
        const network = await provider.getNetwork();
        if (Number(network?.chainId) !== BSC.id) {
          return {
            ok: false,
            error: { source: "local_security", code: "bsc_provider_chain_mismatch", message: `BSC provider chain ${String(network?.chainId)} != 56` },
          };
        }
        const value = await assessLocalSecurity(provider, identity.ca, [{
          pool: identity.poolAddress,
          kind: poolKind,
        }]);
        if (!["pass", "block"].includes(value?.decision)) {
          return {
            ok: false,
            value,
            error: { source: "local_security", code: "local_security_incomplete", message: clean(value?.reasons?.[0] || value?.label) || "Local security evidence is incomplete" },
          };
        }
        return { ok: true, value };
      },
    });
  }

  function partial(identity, event, errors, atMs = clockNow()) {
    const narrativeEvidence = deriveNarrativeEvidenceFromEvent(event || {});
    const missing = errors.map((error) => error.code);
    return deepFreeze({
      schema: NARRATIVE_LIVE_EVIDENCE_SCHEMA,
      status: "partial",
      complete: false,
      asOf: iso(atMs),
      identity,
      narrativeEvidence,
      marketEvidence: blankMarketEvidence(atMs, policy, missing),
      riskEvidence: blankRiskEvidence(atMs, missing),
      evidence: {
        checkedAt: iso(atMs),
        expiresAt: null,
        sources: {},
        errors,
      },
    });
  }

  async function runAssessment(input, identity, notionalUsd) {
    const controller = new AbortController();
    controllers.add(controller);
    let detachExternalAbort = null;
    if (input?.signal) {
      const onAbort = () => controller.abort(input.signal.reason || abortError(input.signal));
      if (input.signal.aborted) onAbort();
      else {
        input.signal.addEventListener("abort", onAbort, { once: true });
        detachExternalAbort = () => input.signal.removeEventListener("abort", onAbort);
      }
    }
    const timer = setTimeout(() => controller.abort(budgetAbortError()), policy.totalBudgetMs);
    timer.unref?.();
    try {
      const [dex, goPlus] = await Promise.all([
        loadDex(identity, controller.signal),
        loadGoPlus(identity, controller.signal),
      ]);
      const dexKind = dex?.ok ? dex.value?.kind : identity.poolKind;
      const local = !dex?.ok
        ? errorOutcome(
          Object.assign(new Error("Exact DEX pair is required before local pool assessment"), { code: "dex_exact_pair_required" }),
          "local_security",
          clockNow(),
          policy.negativeCacheMs,
        )
        : controller.signal.aborted
        ? errorOutcome(abortError(controller.signal), "local_security", clockNow(), policy.negativeCacheMs)
        : await loadLocal(identity, dexKind, controller.signal);
      const asOfMs = clockNow();
      const marketEvidence = buildMarketEvidence({ dex, local, identity, asOfMs, notionalUsd, policy });
      const riskEvidence = buildRiskEvidence({ goPlus, local, asOfMs, policy });
      const status = evidenceStatus(marketEvidence, riskEvidence);
      const sourceErrors = [dex, goPlus, local].flatMap((source) => source?.error ? [source.error] : []);
      const sourceExpiries = [dex, goPlus, local]
        .filter((source) => source?.ok && Number.isFinite(source.expiresAtMs))
        .map((source) => source.expiresAtMs);
      const narrativeEvidence = deriveNarrativeEvidenceFromEvent(input?.event || {});
      return deepFreeze({
        schema: NARRATIVE_LIVE_EVIDENCE_SCHEMA,
        status,
        complete: status !== "partial",
        asOf: iso(asOfMs),
        identity,
        narrativeEvidence,
        marketEvidence,
        riskEvidence,
        evidence: {
          checkedAt: iso(asOfMs),
          expiresAt: status !== "partial" && sourceExpiries.length ? iso(Math.min(...sourceExpiries)) : null,
          sources: {
            dexScreener: {
              ...sourcePublic(dex),
              pairAddress: dex?.value?.pairAddress || null,
              dexId: dex?.value?.dexId || null,
            },
            goPlus: {
              ...sourcePublic(goPlus),
              decision: goPlus?.value?.evaluation?.decision || "pending",
              reason: goPlus?.value?.evaluation?.reason || null,
              metrics: goPlus?.value?.evaluation?.metrics || null,
            },
            localSecurity: {
              ...sourcePublic(local),
              decision: local?.value?.decision || "unknown",
              label: local?.value?.label || null,
              reasons: local?.value?.reasons || [],
              metrics: local?.value?.metrics || null,
            },
          },
          errors: sourceErrors,
          limitations: [
            "Wallet-cluster evidence is not collected by this provider",
            "Slippage is a conservative liquidity-only V2 approximation, not an executable quote",
            "Holder concentration and LP lock/burn are outside bsc_contract_sellability_v1",
          ],
        },
      });
    } catch (error) {
      return partial(identity, input?.event, [safeError(error, "assessment")]);
    } finally {
      clearTimeout(timer);
      detachExternalAbort?.();
      controllers.delete(controller);
    }
  }

  function assess(input = {}) {
    const atMs = clockNow();
    const identity = exactIdentity(input);
    if (!identity.valid) {
      const errors = identity.errors.map((code) => ({ source: "identity", code, message: `Exact BSC identity rejected: ${code}` }));
      return Promise.resolve(partial(identity, input?.event, errors, atMs));
    }
    if (stopped) {
      return Promise.resolve(partial(identity, input?.event, [{ source: "provider", code: "provider_stopped", message: "Narrative live evidence provider is stopped" }], atMs));
    }
    const rawNotional = finite(input.shadowNotionalUsd ?? input.notionalUsd ?? policy.shadowNotionalUsd);
    const notionalUsd = rawNotional !== null && rawNotional > 0
      ? Math.min(rawNotional, policy.maximumShadowNotionalUsd)
      : policy.shadowNotionalUsd;
    const key = `${identity.chainId}:${identity.ca}:${identity.poolAddress}:${identity.poolKind || "auto"}:${notionalUsd}`;
    const existing = assessmentInflight.get(key);
    if (existing) return existing;
    const promise = runAssessment(input, identity, notionalUsd).finally(() => {
      if (assessmentInflight.get(key) === promise) assessmentInflight.delete(key);
    });
    assessmentInflight.set(key, promise);
    return promise;
  }

  function invalidate(filter = {}) {
    if (!filter || Object.keys(filter).length === 0) {
      marketCache.clear();
      goPlusCache.clear();
      localCache.clear();
      return;
    }
    const token = normalizedAddress(filter.ca ?? filter.token ?? filter.tokenAddress);
    const poolAddress = normalizedAddress(filter.poolAddress ?? nestedAddress(filter.pool));
    for (const cache of [marketCache, goPlusCache, localCache]) {
      for (const key of cache.keys()) {
        if ((!token || key.includes(token)) && (!poolAddress || key.includes(poolAddress))) cache.delete(key);
      }
    }
  }

  function stats() {
    return Object.freeze({
      stopped,
      cache: Object.freeze({
        market: marketCache.size,
        goPlus: goPlusCache.size,
        localSecurity: localCache.size,
      }),
      inflight: assessmentInflight.size,
      sourceInflight: sourceInflight.size,
    });
  }

  async function stop() {
    stopped = true;
    for (const controller of controllers) controller.abort(new Error("narrative live evidence provider stopped"));
    await Promise.allSettled([...assessmentInflight.values()]);
  }

  return Object.freeze({
    assess,
    collect: assess,
    getEvidence: assess,
    invalidate,
    stats,
    stop,
    policy,
  });
}
