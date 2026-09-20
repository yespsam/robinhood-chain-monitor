import { createHash } from "node:crypto";

export const NARRATIVE_TRADE_SIGNAL_VERSION = 1;
export const NARRATIVE_TRADE_SIGNAL_SCHEMA = "narrative_trade_signal_v1";
export const NARRATIVE_TRADE_DECISIONS = Object.freeze(["do", "watch", "reject"]);
export const NARRATIVE_TRADE_POLICY = Object.freeze({
  minimumLiquidityUsd: 25_000,
  maximumSlippageBps: 300,
  maximumMarketEvidenceAgeMs: 30 * 1_000,
  maximumRiskEvidenceAgeMs: 5 * 60 * 1_000,
  narrativeHalfLifeMs: 2 * 60 * 60 * 1_000,
  maximumFutureSkewMs: 60 * 1_000,
  minimumFreshnessFactorForDo: 0.25,
  doScore: 70,
  defaultShadowNotionalUsd: 25,
  maximumShadowNotionalUsd: 100,
});

const ADDRESS_RE = /^0x[a-f0-9]{40}$/u;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const SELLABLE = new Set(["sellable", "verified_sellable", "pass", "passed"]);
const CANNOT_SELL = new Set(["cannot_sell", "unsellable", "honeypot", "blocked", "reject"]);
const HIGH_RISK = new Set(["high", "critical", "blocked", "reject"]);
const KNOWN_RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);

const clean = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
const lower = (value) => clean(value).toLowerCase();
const finite = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const bounded = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const round = (value, digits = 2) => {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
};
const positive = (value, fallback) => {
  const numeric = finite(value);
  return numeric != null && numeric > 0 ? numeric : fallback;
};

function percent(value, fallback = 0) {
  const numeric = finite(value);
  if (numeric == null) return bounded(fallback, 0, 100);
  if (numeric >= 0 && numeric <= 1) return numeric * 100;
  return bounded(numeric, 0, 100);
}

function parseInstant(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  const normalized = clean(value);
  if (/^\d{10,13}$/u.test(normalized)) {
    const numeric = Number(normalized);
    return normalized.length === 10 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function bilingual(value, fallback = null) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const zh = clean(value.zh ?? value.cn ?? value.chinese);
    const en = clean(value.en ?? value.english);
    if (zh || en) return Object.freeze({ zh: zh || en, en: en || zh });
  }
  const shared = clean(value);
  if (shared) return Object.freeze({ zh: shared, en: shared });
  if (fallback) return bilingual(fallback);
  return Object.freeze({ zh: "", en: "" });
}

function firstBilingual(...values) {
  for (const value of values) {
    const localized = bilingual(value);
    if (localized.zh || localized.en) return localized;
  }
  return bilingual(null);
}

function canonicalize(value) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
      const item = value[key];
      return item === undefined ? [] : [[key, canonicalize(item)]];
    }));
  }
  return clean(value);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function assetKeyParts(value) {
  const match = /^eip155:(\d+)\/erc20:(0x[a-f0-9]{40})$/u.exec(lower(value));
  if (!match) return { chainId: null, ca: null };
  const chainId = Number(match[1]);
  return {
    chainId: Number.isSafeInteger(chainId) && chainId > 0 ? chainId : null,
    ca: match[2] === ZERO_ADDRESS ? null : match[2],
  };
}

function validAddress(value) {
  return ADDRESS_RE.test(value) && value !== ZERO_ADDRESS;
}

function presentValues(values) {
  return values.filter((value) => value !== undefined && value !== null && value !== "");
}

function strictBooleanClaims(values) {
  const claims = presentValues(values);
  const valid = claims.every((value) => typeof value === "boolean");
  const hasTrue = claims.includes(true);
  const hasFalse = claims.includes(false);
  return {
    valid,
    hasTrue,
    hasFalse,
    consistent: valid && !(hasTrue && hasFalse),
  };
}

function consistentEvidence({ addresses = [], assetKeys = [], chainIds = [] } = {}) {
  const directAddresses = presentValues(addresses).map((value) => clean(value).toLowerCase());
  const rawAssetKeys = presentValues(assetKeys);
  const parsedAssetKeys = rawAssetKeys.map(assetKeyParts);
  const rawChainIds = presentValues(chainIds);
  const parsedAddresses = parsedAssetKeys.map((item) => item.ca).filter(Boolean);
  const parsedChainIds = parsedAssetKeys.map((item) => item.chainId).filter(Boolean);
  const allAddresses = [...directAddresses, ...parsedAddresses];
  const allChainIds = [...rawChainIds, ...parsedChainIds];
  const addressesValid = directAddresses.every(validAddress)
    && parsedAssetKeys.every((item) => item.ca && item.chainId);
  const chainIdsValid = rawChainIds.every((value) => Number.isSafeInteger(value) && value > 0);
  return {
    ca: addressesValid ? allAddresses[0] || null : null,
    chainId: chainIdsValid ? allChainIds[0] || null : null,
    consistent: addressesValid
      && chainIdsValid
      && new Set(allAddresses).size <= 1
      && new Set(allChainIds).size <= 1,
  };
}

function verificationState(booleanClaims = [], labelClaims = []) {
  const typedBooleans = strictBooleanClaims(booleanClaims);
  const claims = presentValues(labelClaims);
  const positiveLabels = new Set(["verified", "pass", "passed", "confirmed", "true"]);
  const negativeLabels = new Set(["unverified", "unknown", "pending", "invalid", "failed", "false", "reject"]);
  let positive = false;
  let negative = false;
  let valid = typedBooleans.valid;
  positive ||= typedBooleans.hasTrue;
  negative ||= typedBooleans.hasFalse;
  for (const claim of claims) {
    if (typeof claim === "boolean") {
      positive ||= claim;
      negative ||= !claim;
      continue;
    }
    const label = lower(claim);
    if (positiveLabels.has(label)) positive = true;
    else if (negativeLabels.has(label)) negative = true;
    else valid = false;
  }
  const consistent = valid && !(positive && negative);
  return { verified: consistent && positive && !negative, consistent };
}

function validNarrativeSourceUrl(value, sourceKind) {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol)) return Boolean(url.hostname);
    return sourceKind === "demo_fixture" && url.protocol === "demo:";
  } catch {
    return false;
  }
}

function normalizedPoolContext(poolContext = {}) {
  const profile = poolContext?.profile && typeof poolContext.profile === "object"
    ? poolContext.profile
    : poolContext;
  const evidence = consistentEvidence({
    addresses: [poolContext?.ca, poolContext?.address, poolContext?.tokenAddress, poolContext?.quoteAddress],
    assetKeys: [profile?.assetKey, poolContext?.assetKey],
    chainIds: [poolContext?.chainId, profile?.chainId],
  });
  const { ca, chainId } = evidence;
  const subject = firstBilingual(profile?.subject, poolContext?.subject);
  const business = firstBilingual(profile?.business, poolContext?.business);
  const meme = firstBilingual(profile?.meme, poolContext?.meme);
  const resolutionClaims = presentValues([profile?.resolution, poolContext?.resolution]).map(lower);
  const resolutionConsistent = new Set(resolutionClaims).size <= 1;
  const resolution = resolutionConsistent ? resolutionClaims[0] || null : "unresolved";
  const identityClaims = presentValues([
    poolContext?.identityStatus,
    profile?.identityStatus,
    poolContext?.verification?.identityStatus,
  ]).map(lower);
  const identityClaimsValid = identityClaims.every((value) => ["matched", "mismatch", "unverified"].includes(value));
  const identityConsistent = identityClaimsValid && new Set(identityClaims).size <= 1;
  const identityStatus = identityClaims.includes("mismatch")
    ? "mismatch"
    : identityClaims.length > 0 && identityClaims.every((value) => value === "matched")
      ? "matched"
      : "unverified";
  const caVerification = verificationState(
    [poolContext?.caVerified, poolContext?.verification?.caVerified],
    [poolContext?.verification?.ca],
  );
  const poolVerification = verificationState(
    [poolContext?.poolVerified, poolContext?.verification?.poolVerified],
    [poolContext?.verification?.pool],
  );
  return {
    chainId,
    ca,
    assetKey: ca && chainId ? `eip155:${chainId}/erc20:${ca}` : clean(profile?.assetKey ?? poolContext?.assetKey) || null,
    poolAddress: clean(poolContext?.poolAddress ?? poolContext?.pool?.address) || null,
    caVerified: caVerification.verified,
    poolVerified: poolVerification.verified,
    evidenceConsistent: evidence.consistent
      && caVerification.consistent
      && poolVerification.consistent
      && resolutionConsistent
      && identityConsistent,
    resolution,
    identityStatus,
    verifiedComplete: resolutionClaims.length > 0
      && resolutionClaims.every((value) => value === "verified_complete"),
    assetClass: clean(profile?.assetClass ?? poolContext?.assetClass) || null,
    canonicalTicker: clean(profile?.canonicalTicker ?? poolContext?.canonicalTicker) || null,
    subject,
    business,
    meme,
    sourceHash: clean(profile?.sourceHash ?? poolContext?.sourceHash) || null,
  };
}

function normalizedTargetEvidence(targetEvidence = {}, poolContext = {}) {
  const explicit = targetEvidence && typeof targetEvidence === "object"
    && !Array.isArray(targetEvidence)
    && Object.keys(targetEvidence).length > 0;
  const source = explicit ? targetEvidence : poolContext;
  const evidence = consistentEvidence({
    addresses: [source?.ca, source?.address, source?.tokenAddress],
    assetKeys: [source?.assetKey],
    chainIds: [source?.chainId],
  });
  const poolEvidence = consistentEvidence({ addresses: [source?.poolAddress, source?.pool?.address] });
  const caVerification = verificationState(
    [source?.caVerified, source?.verification?.caVerified],
    [source?.verification?.ca],
  );
  const poolVerification = verificationState(
    [source?.poolVerified, source?.verification?.poolVerified],
    [source?.verification?.pool],
  );
  const { ca, chainId } = evidence;
  const poolAddress = poolEvidence.ca;
  return {
    chainId,
    ca,
    assetKey: ca && chainId ? `eip155:${chainId}/erc20:${ca}` : clean(source?.assetKey) || null,
    poolAddress,
    caVerified: caVerification.verified,
    poolVerified: poolVerification.verified,
    evidenceConsistent: evidence.consistent
      && poolEvidence.consistent
      && caVerification.consistent
      && poolVerification.consistent,
    symbol: clean(source?.symbol ?? source?.targetSymbol) || null,
    fallbackFromPoolContext: !explicit,
  };
}

function normalizedNarrative(event = {}, narrativeEvidence = {}, asOf = null, marketEvidence = {}, riskEvidence = {}) {
  const headline = firstBilingual(
    narrativeEvidence?.headline,
    event?.headline,
    event?.title,
    event?.summary,
    event?.message,
  );
  const mechanismSource = event?.mechanism && typeof event.mechanism === "object"
    ? event.mechanism.summary ?? event.mechanism.thesis ?? event.mechanism
    : event?.mechanism;
  const mechanism = firstBilingual(mechanismSource, event?.thesis, narrativeEvidence?.mechanism);
  const capitalFlowSource = event?.mechanism && typeof event.mechanism === "object"
    ? event.mechanism.capitalFlow
    : null;
  const capitalFlow = firstBilingual(capitalFlowSource, event?.capitalFlow, narrativeEvidence?.capitalFlow);
  // A joined pool event and its catalyst are two different clocks. Once the
  // adapter supplies an explicit catalyst timestamp, the pool's block time is
  // retained as poolOccurredAt below and must not be mistaken for a second
  // publication-time claim.
  const explicitNarrativePublishedAt = presentValues([narrativeEvidence?.publishedAt]);
  const publicationClaims = explicitNarrativePublishedAt.length
    ? explicitNarrativePublishedAt
    : presentValues([event?.publishedAt, event?.occurredAt]);
  const parsedPublicationClaims = publicationClaims.map(parseInstant).filter((value) => value != null);
  const publicationEvidenceConsistent = parsedPublicationClaims.length === publicationClaims.length
    && (parsedPublicationClaims.length < 2
      || Math.max(...parsedPublicationClaims) - Math.min(...parsedPublicationClaims)
        <= NARRATIVE_TRADE_POLICY.maximumFutureSkewMs);
  const publishedMs = parsedPublicationClaims.length
    ? Math.min(...parsedPublicationClaims)
    : parseInstant(event?.createdAt ?? event?.observedAt);
  const asOfMs = parseInstant(
    asOf
      ?? marketEvidence?.asOf
      ?? marketEvidence?.observedAt
      ?? riskEvidence?.asOf
      ?? riskEvidence?.observedAt
      ?? event?.evaluatedAt
      ?? event?.observedAt
      ?? publishedMs,
  );
  const rawAgeMs = publishedMs != null && asOfMs != null ? asOfMs - publishedMs : null;
  const futureSkewMs = rawAgeMs == null ? null : Math.max(0, -rawAgeMs);
  const timingValid = publicationEvidenceConsistent
    && rawAgeMs != null
    && futureSkewMs <= NARRATIVE_TRADE_POLICY.maximumFutureSkewMs;
  const ageMs = rawAgeMs == null ? null : Math.max(0, rawAgeMs);
  const halfLifeMs = Math.min(
    positive(narrativeEvidence?.halfLifeMs, NARRATIVE_TRADE_POLICY.narrativeHalfLifeMs),
    NARRATIVE_TRADE_POLICY.narrativeHalfLifeMs,
  );
  const percentageClaims = presentValues([
    narrativeEvidence?.strength,
    event?.catalystStrength,
    event?.catalyst?.strength,
    event?.strength,
    narrativeEvidence?.novelty,
    event?.mechanism?.confidence,
    narrativeEvidence?.mechanismConfidence,
  ]).map(finite);
  const scoringEvidenceConsistent = percentageClaims.every((value) => (
    value != null && value >= 0 && value <= 100
  )) && (narrativeEvidence?.halfLifeMs == null
    || (finite(narrativeEvidence.halfLifeMs) != null && finite(narrativeEvidence.halfLifeMs) > 0));
  const freshnessFactor = !timingValid ? 0 : round(2 ** (-ageMs / halfLifeMs), 6);
  const eventStrength = percent(
    narrativeEvidence?.strength
      ?? event?.catalystStrength
      ?? event?.catalyst?.strength
      ?? event?.strength,
    headline.zh || headline.en ? 50 : 0,
  );
  const novelty = percent(narrativeEvidence?.novelty, 0);
  const mechanismConfidence = percent(
    event?.mechanism?.confidence ?? narrativeEvidence?.mechanismConfidence,
    mechanism.zh || mechanism.en ? 60 : 0,
  );
  const sourceKind = clean(narrativeEvidence?.sourceKind ?? event?.source?.kind ?? event?.sourceKind) || null;
  const sourceUrl = clean(narrativeEvidence?.sourceUrl ?? event?.sourceUrl ?? event?.url) || null;
  const sourceUrlValid = Boolean(sourceUrl) && validNarrativeSourceUrl(sourceUrl, sourceKind);
  const verificationClaimed = narrativeEvidence?.verified === true;
  const verified = verificationClaimed
    && Boolean(sourceKind)
    && sourceUrlValid
    && publishedMs != null
    && publicationEvidenceConsistent
    && scoringEvidenceConsistent
    && Boolean(headline.zh || headline.en);
  return {
    verified,
    verificationClaimed,
    subjectMatch: narrativeEvidence?.subjectMatch === true,
    sourceKind,
    sourceUrl,
    sourceUrlValid,
    scoringEvidenceConsistent,
    publicationEvidenceConsistent,
    headline,
    mechanism,
    capitalFlow,
    publishedMs,
    asOfMs,
    asOfExplicit: parseInstant(asOf) != null,
    ageMs,
    futureSkewMs,
    timingValid,
    halfLifeMs,
    freshnessFactor,
    eventStrength,
    novelty,
    mechanismConfidence,
  };
}

function evidenceTiming(evidence = {}, evaluationMs, maximumAgeMs) {
  const timestampClaims = presentValues([
    evidence?.asOf,
    evidence?.checkedAt,
    evidence?.observedAt,
  ]);
  const parsedClaims = timestampClaims.map(parseInstant);
  const claimsValid = parsedClaims.every((value) => value != null);
  const claimsConsistent = claimsValid && (parsedClaims.length < 2
    || Math.max(...parsedClaims) - Math.min(...parsedClaims)
      <= NARRATIVE_TRADE_POLICY.maximumFutureSkewMs);
  const observedMs = claimsConsistent && parsedClaims.length ? Math.max(...parsedClaims) : null;
  const expiresAtPresent = evidence?.expiresAt !== undefined
    && evidence?.expiresAt !== null
    && evidence?.expiresAt !== "";
  const expiresAtMs = expiresAtPresent ? parseInstant(evidence.expiresAt) : null;
  const expiryValid = !expiresAtPresent || expiresAtMs != null;
  const rawAgeMs = observedMs != null && evaluationMs != null ? evaluationMs - observedMs : null;
  const futureSkewMs = rawAgeMs == null ? null : Math.max(0, -rawAgeMs);
  const ageMs = rawAgeMs == null ? null : Math.max(0, rawAgeMs);
  const fresh = claimsConsistent
    && timestampClaims.length > 0
    && evaluationMs != null
    && futureSkewMs <= NARRATIVE_TRADE_POLICY.maximumFutureSkewMs
    && ageMs <= maximumAgeMs
    && expiryValid
    && (expiresAtMs == null || evaluationMs <= expiresAtMs);
  return {
    evidenceTimestamp: iso(observedMs),
    expiresAt: iso(expiresAtMs),
    ageMs,
    futureSkewMs,
    timingConsistent: claimsConsistent && expiryValid,
    fresh,
    maximumAgeMs,
  };
}

function normalizedMarket(marketEvidence = {}, evaluationMs = null) {
  const healthClaims = presentValues([marketEvidence?.dataHealth, marketEvidence?.health]).map(lower);
  const positiveHealthLabels = new Set(["healthy", "ok", "pass", "passed"]);
  const negativeHealthLabels = new Set(["degraded", "unhealthy", "error", "failed", "critical"]);
  const healthClaimsValid = healthClaims.every((value) => (
    positiveHealthLabels.has(value) || negativeHealthLabels.has(value)
  ));
  const healthPositive = healthClaims.some((value) => positiveHealthLabels.has(value));
  const healthNegative = healthClaims.some((value) => negativeHealthLabels.has(value));
  const dataHealthyClaim = strictBooleanClaims([marketEvidence?.dataHealthy]);
  const dataHealthConsistent = dataHealthyClaim.valid
    && healthClaimsValid
    && !(healthPositive && healthNegative)
    && !(
    (dataHealthyClaim.hasTrue && healthNegative)
    || (dataHealthyClaim.hasFalse && healthPositive)
  );
  const dataHealthy = dataHealthConsistent && (dataHealthyClaim.hasTrue || healthPositive);
  const coverageClaim = strictBooleanClaims([marketEvidence?.coverageComplete]);
  const coverageGapClaim = strictBooleanClaims([marketEvidence?.coverageGap]);
  const coverageConsistent = coverageClaim.consistent
    && coverageGapClaim.consistent
    && !(coverageClaim.hasTrue && coverageGapClaim.hasTrue);
  const coverageComplete = coverageConsistent
    && coverageClaim.hasTrue
    && !coverageGapClaim.hasTrue;
  const marketConfirmation = verificationState(
    [marketEvidence?.marketConfirmed],
    [marketEvidence?.confirmation?.market],
  );
  const momentumConfirmation = verificationState(
    [marketEvidence?.momentumConfirmed],
    [marketEvidence?.confirmation?.momentum],
  );
  const walletConfirmation = verificationState(
    [marketEvidence?.walletClusterConfirmed],
    [marketEvidence?.confirmation?.walletCluster],
  );
  const liquidityUsd = finite(marketEvidence?.liquidityUsd);
  const minimumLiquidityUsd = positive(
    marketEvidence?.minimumLiquidityUsd,
    NARRATIVE_TRADE_POLICY.minimumLiquidityUsd,
  );
  const rawSlippageClaims = presentValues([
    marketEvidence?.estimatedSlippageBps,
    marketEvidence?.slippageBps,
  ]);
  const slippageClaims = rawSlippageClaims.map(finite);
  const slippageClaimsValid = slippageClaims.every((value) => value != null && value >= 0);
  const slippageConsistent = slippageClaimsValid && new Set(slippageClaims).size <= 1;
  const estimatedSlippageBps = slippageConsistent ? slippageClaims[0] ?? null : null;
  const maximumSlippageBps = positive(
    marketEvidence?.maximumSlippageBps,
    NARRATIVE_TRADE_POLICY.maximumSlippageBps,
  );
  const rawEntryWindow = marketEvidence?.entryWindow && typeof marketEvidence.entryWindow === "object"
    ? marketEvidence.entryWindow.state
    : marketEvidence?.entryWindow;
  const entryWindow = lower(rawEntryWindow) || "unknown";
  const timing = evidenceTiming(
    marketEvidence,
    evaluationMs,
    NARRATIVE_TRADE_POLICY.maximumMarketEvidenceAgeMs,
  );
  return {
    dataHealthy,
    dataHealth: healthNegative ? "degraded" : healthPositive ? "healthy" : "unknown",
    coverageComplete,
    evidenceConsistent: dataHealthConsistent
      && coverageConsistent
      && marketConfirmation.consistent
      && momentumConfirmation.consistent
      && walletConfirmation.consistent
      && slippageConsistent
      && timing.timingConsistent,
    ...timing,
    marketConfirmed: marketConfirmation.verified,
    momentumConfirmed: momentumConfirmation.verified,
    walletClusterConfirmed: walletConfirmation.verified,
    liquidityUsd: liquidityUsd != null && liquidityUsd >= 0 ? liquidityUsd : null,
    minimumLiquidityUsd: Math.max(minimumLiquidityUsd, NARRATIVE_TRADE_POLICY.minimumLiquidityUsd),
    estimatedSlippageBps: estimatedSlippageBps != null && estimatedSlippageBps >= 0 ? estimatedSlippageBps : null,
    maximumSlippageBps: Math.min(maximumSlippageBps, NARRATIVE_TRADE_POLICY.maximumSlippageBps),
    entryWindow,
    requestedShadowNotionalUsd: positive(
      marketEvidence?.shadowNotionalUsd,
      NARRATIVE_TRADE_POLICY.defaultShadowNotionalUsd,
    ),
  };
}

function normalizedRisk(riskEvidence = {}, evaluationMs = null) {
  const flagsContainerValid = riskEvidence?.flags == null
    || (typeof riskEvidence.flags === "object" && !Array.isArray(riskEvidence.flags));
  const nested = flagsContainerValid && riskEvidence?.flags ? riskEvidence.flags : {};
  const sellableClaim = strictBooleanClaims([riskEvidence?.sellable]);
  const cannotSellClaim = strictBooleanClaims([riskEvidence?.cannotSell]);
  const highRiskClaim = strictBooleanClaims([riskEvidence?.highRisk]);
  const sellabilityClaims = presentValues([
    riskEvidence?.sellability,
    riskEvidence?.sellabilityStatus,
    riskEvidence?.decision,
  ]).map(lower);
  const knownSellabilityClaims = new Set([
    ...SELLABLE,
    ...CANNOT_SELL,
    "unverified",
    "unknown",
    "pending",
  ]);
  const sellabilityClaimsValid = sellabilityClaims.every((value) => knownSellabilityClaims.has(value));
  const sellabilityPositive = sellableClaim.hasTrue
    || sellabilityClaims.some((value) => SELLABLE.has(value));
  const sellabilityUnverified = sellabilityClaims.some((value) => ["unverified", "unknown", "pending"].includes(value));
  const cannotSell = sellableClaim.hasFalse
    || cannotSellClaim.hasTrue
    || sellabilityClaims.some((value) => CANNOT_SELL.has(value));
  const sellabilityConsistent = sellableClaim.consistent
    && cannotSellClaim.consistent
    && sellabilityClaimsValid
    && !(sellabilityPositive && (cannotSell || sellabilityUnverified));
  const sellable = sellabilityConsistent && sellabilityPositive && !cannotSell && !sellabilityUnverified;
  const riskLevelClaims = presentValues([riskEvidence?.riskLevel, riskEvidence?.level]).map((value) => {
    const normalized = lower(value);
    if (normalized === "safe") return "low";
    if (normalized === "moderate") return "medium";
    return normalized;
  });
  const riskLevelClaimsValid = riskLevelClaims.every((value) => KNOWN_RISK_LEVELS.has(value));
  const riskLevelConsistent = riskLevelClaimsValid && new Set(riskLevelClaims).size <= 1;
  const riskRank = { low: 1, medium: 2, high: 3, critical: 4 };
  const riskLevel = riskLevelClaims
    .filter((value) => KNOWN_RISK_LEVELS.has(value))
    .sort((left, right) => riskRank[right] - riskRank[left])[0] || "unknown";
  const flagClaims = {
    honeypot: strictBooleanClaims([riskEvidence?.honeypot, riskEvidence?.isHoneypot, nested?.honeypot, nested?.isHoneypot]),
    blacklist: strictBooleanClaims([riskEvidence?.blacklist, riskEvidence?.ownerCanBlacklist, nested?.blacklist, nested?.ownerCanBlacklist]),
    mint: strictBooleanClaims([riskEvidence?.mint, riskEvidence?.ownerCanMint, riskEvidence?.arbitraryMint, nested?.mint, nested?.ownerCanMint, nested?.arbitraryMint]),
    freeze: strictBooleanClaims([riskEvidence?.freeze, riskEvidence?.ownerCanFreeze, nested?.freeze, nested?.ownerCanFreeze]),
    pause: strictBooleanClaims([riskEvidence?.pause, riskEvidence?.ownerCanPause, nested?.pause, nested?.ownerCanPause]),
    dynamicTax: strictBooleanClaims([riskEvidence?.dynamicTax, riskEvidence?.ownerCanChangeTax, nested?.dynamicTax, nested?.ownerCanChangeTax]),
  };
  const flags = Object.fromEntries(Object.entries(flagClaims).map(([key, state]) => [key, state.hasTrue]));
  const numericRiskScore = finite(riskEvidence?.riskScore);
  const derivedHighRisk = HIGH_RISK.has(riskLevel)
    || (numericRiskScore != null && numericRiskScore >= 80)
    || Object.values(flags).some(Boolean);
  const highRisk = highRiskClaim.hasTrue || derivedHighRisk;
  const coverageClaim = strictBooleanClaims([riskEvidence?.coverageComplete, riskEvidence?.safetyComplete]);
  const coverageGapClaim = strictBooleanClaims([riskEvidence?.coverageGap]);
  const coveragePositive = coverageClaim.hasTrue;
  const coverageNegative = coverageClaim.hasFalse || coverageGapClaim.hasTrue;
  const coverageConsistent = coverageClaim.consistent
    && coverageGapClaim.consistent
    && !(coveragePositive && coverageNegative);
  const coverageComplete = coverageConsistent
    && coveragePositive
    && !coverageNegative
    && KNOWN_RISK_LEVELS.has(riskLevel);
  const riskScoreValid = riskEvidence?.riskScore == null
    || (numericRiskScore != null && numericRiskScore >= 0 && numericRiskScore <= 100);
  const evidenceConsistent = sellabilityConsistent
    && flagsContainerValid
    && Object.values(flagClaims).every((state) => state.consistent)
    && highRiskClaim.consistent
    && riskLevelConsistent
    && coverageConsistent
    && riskScoreValid
    && !(highRiskClaim.hasFalse && derivedHighRisk);
  const timing = evidenceTiming(
    riskEvidence,
    evaluationMs,
    NARRATIVE_TRADE_POLICY.maximumRiskEvidenceAgeMs,
  );
  return {
    evidenceConsistent: evidenceConsistent && timing.timingConsistent,
    ...timing,
    coverageComplete,
    sellability: sellable ? "verified_sellable" : cannotSell ? "cannot_sell" : "unverified",
    sellable,
    cannotSell,
    riskLevel,
    riskScore: riskScoreValid && numericRiskScore != null ? numericRiskScore : null,
    highRisk,
    flags,
  };
}

function hardBlock(code, zh, en) {
  return Object.freeze({ code, zh, en });
}

function deriveHardBlocks(pool, target, market, risk) {
  const blocks = [];
  if (!pool.chainId || !pool.ca) {
    blocks.push(hardBlock(
      "context_unverified",
      "底池叙事映射缺少精确链或非零 CA",
      "Pool narrative mapping lacks an exact chain or non-zero CA",
    ));
  }
  if (!pool.evidenceConsistent) {
    blocks.push(hardBlock(
      "context_evidence_conflict",
      "底池上下文的链、CA 或 assetKey 证据互相冲突",
      "Pool-context chain, CA, or assetKey evidence conflicts",
    ));
  }
  if (pool.identityStatus === "mismatch") {
    blocks.push(hardBlock(
      "context_identity_mismatch",
      "链上标识与精确地址目录身份不一致",
      "On-chain identity conflicts with the exact-address context catalog",
    ));
  }
  if (!target.evidenceConsistent) {
    blocks.push(hardBlock(
      "target_evidence_conflict",
      "交易标的的链、CA、assetKey 或池地址证据互相冲突",
      "Trade-target chain, CA, assetKey, or pool-address evidence conflicts",
    ));
  }
  if (pool.chainId && target.chainId && pool.chainId !== target.chainId) {
    blocks.push(hardBlock(
      "context_target_chain_mismatch",
      "叙事底池与交易标的不在同一条链",
      "Narrative pool context and trade target are on different chains",
    ));
  }
  if (!target.fallbackFromPoolContext && pool.ca && target.ca && pool.ca === target.ca) {
    blocks.push(hardBlock(
      "target_context_collision",
      "交易标的 CA 与报价/stockToken 映射 CA 相同",
      "Trade-target CA equals the quote/stockToken context CA",
    ));
  }
  if (!market.evidenceConsistent) {
    blocks.push(hardBlock(
      "market_evidence_conflict",
      "市场健康、覆盖或确认字段互相冲突",
      "Market health, coverage, or confirmation evidence conflicts",
    ));
  }
  if (!risk.evidenceConsistent) {
    blocks.push(hardBlock(
      "risk_evidence_conflict",
      "安全覆盖、可卖性或风险等级证据互相冲突",
      "Safety coverage, sellability, or risk-level evidence conflicts",
    ));
  }
  if (!target.chainId || !target.ca || target.caVerified !== true) {
    blocks.push(hardBlock("ca_unverified", "CA 未经精确核验", "CA is not exactly verified"));
  }
  if (!target.poolAddress || target.poolVerified !== true) {
    blocks.push(hardBlock("pool_unverified", "交易池地址或真实性未经核验", "Trading-pool address or authenticity is not verified"));
  }
  if (!market.dataHealthy) {
    blocks.push(hardBlock("data_unhealthy", "市场数据不健康或状态未知", "Market data is unhealthy or unknown"));
  }
  if (!market.fresh) {
    blocks.push(hardBlock(
      "market_evidence_stale",
      "市场证据缺少新鲜时间戳或已经过期",
      "Market evidence lacks a fresh timestamp or has expired",
    ));
  }
  if (!risk.fresh) {
    blocks.push(hardBlock(
      "risk_evidence_stale",
      "安全证据缺少新鲜时间戳或已经过期",
      "Risk evidence lacks a fresh timestamp or has expired",
    ));
  }
  if (!market.coverageComplete || !risk.coverageComplete) {
    blocks.push(hardBlock("coverage_gap", "市场或安全数据存在覆盖缺口", "Market or security evidence has a coverage gap"));
  }
  if (risk.cannotSell || risk.flags.honeypot) {
    blocks.push(hardBlock("cannot_sell", "检测到不可卖或 honeypot 风险", "Cannot-sell or honeypot risk detected"));
  } else if (!risk.sellable) {
    blocks.push(hardBlock("sellability_unverified", "可卖性尚未验证", "Sellability is not verified"));
  }
  if (risk.highRisk && !risk.flags.honeypot) {
    blocks.push(hardBlock("contract_high_risk", "合约或权限风险过高", "Contract or admin risk is too high"));
  }
  if (market.liquidityUsd == null) {
    blocks.push(hardBlock("liquidity_unverified", "流动性尚未验证", "Liquidity is not verified"));
  } else if (market.liquidityUsd < market.minimumLiquidityUsd) {
    blocks.push(hardBlock(
      "liquidity_insufficient",
      `流动性 $${round(market.liquidityUsd)} 低于门槛 $${round(market.minimumLiquidityUsd)}`,
      `Liquidity $${round(market.liquidityUsd)} is below the $${round(market.minimumLiquidityUsd)} floor`,
    ));
  }
  if (market.estimatedSlippageBps == null) {
    blocks.push(hardBlock("slippage_unverified", "滑点尚未验证", "Slippage is not verified"));
  } else if (market.estimatedSlippageBps > market.maximumSlippageBps) {
    blocks.push(hardBlock(
      "slippage_excessive",
      `预估滑点 ${round(market.estimatedSlippageBps)} bps 超过上限 ${round(market.maximumSlippageBps)} bps`,
      `Estimated slippage ${round(market.estimatedSlippageBps)} bps exceeds the ${round(market.maximumSlippageBps)} bps cap`,
    ));
  }
  return Object.freeze(blocks);
}

function freshnessLabel(ageMs) {
  if (ageMs == null) return { zh: "时间未知", en: "unknown timing" };
  if (ageMs <= 15 * 60 * 1_000) return { zh: "新鲜", en: "fresh" };
  if (ageMs <= 60 * 60 * 1_000) return { zh: "近期", en: "recent" };
  if (ageMs <= 4 * 60 * 60 * 1_000) return { zh: "衰减中", en: "aging" };
  return { zh: "已陈旧", en: "stale" };
}

function deriveScore(target, narrative, market, risk) {
  const catalystQuality = (narrative.eventStrength + narrative.novelty) / 2;
  const catalystRaw = narrative.verified ? round(20 * catalystQuality / 100) : 0;
  const mechanismRaw = narrative.verified && narrative.subjectMatch
    ? round(15 * narrative.mechanismConfidence / 100)
    : 0;
  const subjectMatchRaw = narrative.verified && narrative.subjectMatch ? 10 : 0;
  const eventSubtotalRaw = round(catalystRaw + mechanismRaw + subjectMatchRaw);
  const eventSubtotalAfterDecay = round(eventSubtotalRaw * narrative.freshnessFactor);
  const liquidityRatio = market.liquidityUsd == null ? 0 : market.liquidityUsd / market.minimumLiquidityUsd;
  const components = {
    eventSubtotalAfterDecay,
    target: target.ca && target.caVerified && target.poolAddress && target.poolVerified ? 10 : 0,
    market: market.marketConfirmed ? 15 : 0,
    momentum: market.momentumConfirmed ? 5 : 0,
    walletCluster: market.walletClusterConfirmed ? 5 : 0,
    liquidity: round(5 * bounded(liquidityRatio / 2, 0, 1)),
    safety: risk.sellable && !risk.highRisk ? risk.riskLevel === "medium" ? 6 : 10 : 0,
    entryWindow: market.entryWindow === "open" ? 5 : 0,
  };
  const total = round(bounded(Object.values(components).reduce((sum, value) => sum + value, 0), 0, 100));
  return {
    total,
    details: {
      threshold: NARRATIVE_TRADE_POLICY.doScore,
      range: { minimum: 0, maximum: 100 },
      components,
      eventComponentsBeforeDecay: {
        catalyst: catalystRaw,
        mechanism: mechanismRaw,
        subjectMatch: subjectMatchRaw,
        subtotal: eventSubtotalRaw,
      },
      freshness: {
        ageMs: narrative.ageMs,
        halfLifeMs: narrative.halfLifeMs,
        factor: narrative.freshnessFactor,
      },
    },
  };
}

function missingConfirmations(pool, target, narrative, market, score) {
  const missing = [];
  if (!pool.verifiedComplete) missing.push("pool_context_verified_complete");
  if (pool.identityStatus !== "matched") missing.push("pool_context_identity_matched");
  if (target.fallbackFromPoolContext) missing.push("explicit_target_evidence");
  if (!narrative.verified) missing.push("narrative_verified");
  if (!narrative.subjectMatch) missing.push("subject_match");
  if (!narrative.asOfExplicit) missing.push("evaluation_time_explicit");
  if (!narrative.timingValid) missing.push("narrative_timestamp_valid");
  if (narrative.ageMs == null) missing.push("freshness_timestamp");
  else if (narrative.freshnessFactor < NARRATIVE_TRADE_POLICY.minimumFreshnessFactorForDo) missing.push("narrative_freshness");
  if (!market.marketConfirmed) missing.push("market_confirmation");
  if (market.entryWindow !== "open") missing.push("entry_window");
  if (score < NARRATIVE_TRADE_POLICY.doScore) missing.push("score_threshold");
  return Object.freeze(missing);
}

function safeEventKey(event = {}) {
  return clean(event?.eventKey ?? event?.id ?? event?.key) || null;
}

function platformIdentifier(event = {}) {
  const value = event?.platform && typeof event.platform === "object"
    ? event.platform.id ?? event.platform.name
    : event?.platform;
  return lower(value).replace(/[^a-z0-9]/gu, "") || null;
}

function decisionText(decision) {
  if (decision === "do") return {
    zh: "可模拟｜仅生成 shadow 影子单；不联网、不签名、不广播",
    en: "Simulation eligible | shadow order only; no network, signing, or broadcast",
  };
  if (decision === "reject") return {
    zh: "拒绝｜硬门未通过；不生成影子单",
    en: "Rejected | a hard gate failed; no shadow order is created",
  };
  return {
    zh: "观察｜确认不足、叙事陈旧或评分未达门槛；不生成影子单",
    en: "Watch | confirmation, freshness, or score is insufficient; no shadow order is created",
  };
}

function targetLabel(target, pool) {
  const subjectZh = target.symbol || pool.subject.zh || pool.canonicalTicker || "未知标的";
  const subjectEn = target.symbol || pool.subject.en || pool.canonicalTicker || "unknown target";
  const ticker = target.symbol || !pool.canonicalTicker ? "" : ` · ${pool.canonicalTicker}`;
  const caZh = target.ca || "未提供";
  const caEn = target.ca || "missing";
  const chainZh = target.chainId ? `｜chainId=${target.chainId}` : "";
  const chainEn = target.chainId ? ` | chainId=${target.chainId}` : "";
  const mappedZh = pool.ca && pool.ca !== target.ca ? `｜叙事映射 CA ${pool.ca}` : "";
  const mappedEn = pool.ca && pool.ca !== target.ca ? ` | context-mapping CA ${pool.ca}` : "";
  return {
    zh: `交易标的｜${subjectZh}${ticker}${chainZh}｜CA ${caZh}${mappedZh}`,
    en: `Trade target | ${subjectEn}${ticker}${chainEn} | CA ${caEn}${mappedEn}`,
  };
}

function confirmationLabel(market) {
  const liquidity = market.liquidityUsd == null ? { zh: "未知", en: "unknown" } : {
    zh: `$${round(market.liquidityUsd)}`,
    en: `$${round(market.liquidityUsd)}`,
  };
  const slippage = market.estimatedSlippageBps == null ? { zh: "未知", en: "unknown" } : {
    zh: `${round(market.estimatedSlippageBps)} bps`,
    en: `${round(market.estimatedSlippageBps)} bps`,
  };
  return {
    zh: `确认｜市场${market.marketConfirmed ? "已确认" : "待确认"}；流动性 ${liquidity.zh}；滑点 ${slippage.zh}；窗口 ${market.entryWindow}`,
    en: `Confirmation | market ${market.marketConfirmed ? "confirmed" : "pending"}; liquidity ${liquidity.en}; slippage ${slippage.en}; window ${market.entryWindow}`,
  };
}

function riskLabel(hardBlocks, risk) {
  if (hardBlocks.length) return {
    zh: `风险｜${hardBlocks.map((item) => item.zh).join("；")}`,
    en: `Risk | ${hardBlocks.map((item) => item.en).join("; ")}`,
  };
  return {
    zh: `风险｜硬门通过；可卖性已核验；风险等级 ${risk.riskLevel}`,
    en: `Risk | hard gates passed; sellability verified; risk level ${risk.riskLevel}`,
  };
}

function shadowNotional(market) {
  const liquidityCap = market.liquidityUsd == null
    ? NARRATIVE_TRADE_POLICY.maximumShadowNotionalUsd
    : Math.max(1, market.liquidityUsd * 0.001);
  return round(Math.min(
    market.requestedShadowNotionalUsd,
    NARRATIVE_TRADE_POLICY.maximumShadowNotionalUsd,
    liquidityCap,
  ));
}

export function deriveNarrativeTradeSignal({
  event = {},
  poolContext = {},
  targetEvidence = {},
  narrativeEvidence = {},
  marketEvidence = {},
  riskEvidence = {},
  asOf = null,
} = {}) {
  const pool = normalizedPoolContext(poolContext);
  const targetState = normalizedTargetEvidence(targetEvidence, poolContext);
  const narrative = normalizedNarrative(event, narrativeEvidence, asOf, marketEvidence, riskEvidence);
  const market = normalizedMarket(marketEvidence, narrative.asOfMs);
  const riskState = normalizedRisk(riskEvidence, narrative.asOfMs);
  const hardBlocks = deriveHardBlocks(pool, targetState, market, riskState);
  const scored = deriveScore(targetState, narrative, market, riskState);
  const missing = missingConfirmations(pool, targetState, narrative, market, scored.total);
  const decision = hardBlocks.length ? "reject" : missing.length ? "watch" : "do";
  const freshness = freshnessLabel(narrative.ageMs);
  const headlineZh = narrative.headline.zh || "未提供叙事标题";
  const headlineEn = narrative.headline.en || "Narrative headline missing";
  const eventSection = {
    zh: `${narrative.verified ? "已核验事件" : "未核验事件"}｜${headlineZh}｜${freshness.zh}`,
    en: `${narrative.verified ? "Verified event" : "Unverified event"} | ${headlineEn} | ${freshness.en}`,
    eventKey: safeEventKey(event),
    type: clean(event?.type ?? event?.kind) || null,
    verified: narrative.verified,
    verificationClaimed: narrative.verificationClaimed,
    sourceKind: narrative.sourceKind,
    sourceUrl: narrative.sourceUrl,
    sourceUrlValid: narrative.sourceUrlValid,
    publicationEvidenceConsistent: narrative.publicationEvidenceConsistent,
    publishedAt: iso(narrative.publishedMs),
    asOf: iso(narrative.asOfMs),
    asOfExplicit: narrative.asOfExplicit,
    ageMs: narrative.ageMs,
    futureSkewMs: narrative.futureSkewMs,
    poolOccurredAt: iso(parseInstant(event?.poolOccurredAt ?? event?.occurredAt ?? event?.blockTimestamp)),
    timingValid: narrative.timingValid,
    novelty: narrative.novelty,
    platform: platformIdentifier(event),
    targetSymbol: clean(event?.targetSymbol ?? targetState.symbol ?? event?.symbol ?? event?.token?.symbol) || null,
  };
  const mechanismFallback = {
    zh: "尚未提供可验证的注意力或流动性传导机制",
    en: "No verified attention or liquidity transmission mechanism was provided",
  };
  const mechanismText = narrative.mechanism.zh || narrative.mechanism.en
    ? narrative.mechanism
    : bilingual(mechanismFallback);
  const mechanismSection = {
    zh: `机制｜${mechanismText.zh}`,
    en: `Mechanism | ${mechanismText.en}`,
    confidence: narrative.mechanismConfidence,
    subjectMatch: narrative.subjectMatch,
    capitalFlow: narrative.capitalFlow,
  };
  const targetSection = {
    ...targetLabel(targetState, pool),
    chainId: targetState.chainId,
    ca: targetState.ca,
    assetKey: targetState.assetKey,
    poolAddress: targetState.poolAddress,
    caVerified: targetState.caVerified,
    poolVerified: targetState.poolVerified,
    evidenceConsistent: targetState.evidenceConsistent,
    symbol: targetState.symbol,
    fallbackFromPoolContext: targetState.fallbackFromPoolContext,
    context: {
      chainId: pool.chainId,
      ca: pool.ca,
      assetKey: pool.assetKey,
      resolution: pool.resolution,
      identityStatus: pool.identityStatus,
      verifiedComplete: pool.verifiedComplete,
      evidenceConsistent: pool.evidenceConsistent,
      assetClass: pool.assetClass,
      canonicalTicker: pool.canonicalTicker,
      subject: pool.subject,
      business: pool.business,
      meme: pool.meme,
      sourceHash: pool.sourceHash,
    },
  };
  const confirmationSection = {
    ...confirmationLabel(market),
    marketConfirmed: market.marketConfirmed,
    momentumConfirmed: market.momentumConfirmed,
    walletClusterConfirmed: market.walletClusterConfirmed,
    entryWindow: market.entryWindow,
    missing,
  };
  const executionCopy = decisionText(decision);
  const executionSection = {
    ...executionCopy,
    eligible: decision === "do",
    mode: decision === "do" ? "shadow" : "none",
    automaticExecution: false,
    networkAccess: false,
    signing: false,
    broadcast: false,
  };
  const riskCopy = riskLabel(hardBlocks, riskState);
  const riskSection = {
    ...riskCopy,
    level: riskState.riskLevel,
    sellability: riskState.sellability,
    dataHealthy: market.dataHealthy,
    marketCoverageComplete: market.coverageComplete,
    securityCoverageComplete: riskState.coverageComplete,
    liquidityUsd: market.liquidityUsd,
    minimumLiquidityUsd: market.minimumLiquidityUsd,
    estimatedSlippageBps: market.estimatedSlippageBps,
    maximumSlippageBps: market.maximumSlippageBps,
    marketEvidenceAt: market.evidenceTimestamp,
    marketEvidenceExpiresAt: market.expiresAt,
    marketEvidenceFresh: market.fresh,
    riskEvidenceAt: riskState.evidenceTimestamp,
    riskEvidenceExpiresAt: riskState.expiresAt,
    riskEvidenceFresh: riskState.fresh,
    flags: riskState.flags,
  };
  const hashMaterial = {
    schema: NARRATIVE_TRADE_SIGNAL_SCHEMA,
    event: eventSection,
    mechanism: mechanismSection,
    target: targetSection,
    poolContext: pool,
    targetEvidence: targetState,
    narrativeEvidence: {
      verified: narrative.verified,
      verificationClaimed: narrative.verificationClaimed,
      subjectMatch: narrative.subjectMatch,
      sourceKind: narrative.sourceKind,
      sourceUrl: narrative.sourceUrl,
      headline: narrative.headline,
      eventStrength: narrative.eventStrength,
      novelty: narrative.novelty,
      publishedAt: iso(narrative.publishedMs),
      halfLifeMs: narrative.halfLifeMs,
    },
    marketEvidence: market,
    riskEvidence: riskState,
  };
  const inputHash = digest(hashMaterial);
  const shadowOrder = decision === "do" ? {
    mode: "shadow",
    executable: false,
    side: "buy",
    chainId: targetState.chainId,
    ca: targetState.ca,
    poolAddress: targetState.poolAddress,
    assetKey: targetState.assetKey,
    notionalUsd: shadowNotional(market),
    maxSlippageBps: market.maximumSlippageBps,
    simulatedAt: iso(narrative.asOfMs),
    signalInputHash: inputHash,
  } : null;
  const result = {
    version: NARRATIVE_TRADE_SIGNAL_VERSION,
    schema: NARRATIVE_TRADE_SIGNAL_SCHEMA,
    deterministic: true,
    decision,
    score: scored.total,
    scoreDetails: scored.details,
    event: eventSection,
    mechanism: mechanismSection,
    target: targetSection,
    confirmation: confirmationSection,
    execution: executionSection,
    risk: riskSection,
    hardBlocks,
    shadowOrder,
    inputHash,
  };
  return deepFreeze({ ...result, decisionHash: digest(result) });
}

export const evaluateNarrativeTradeSignal = deriveNarrativeTradeSignal;

export function verifyNarrativeTradeSignalIntegrity(value) {
  const reasons = [];
  const hashPattern = /^[a-f0-9]{64}$/u;
  if (!isNarrativeTradeSignal(value)) reasons.push("invalid_signal_shape");
  if (!hashPattern.test(String(value?.inputHash || ""))) reasons.push("invalid_input_hash");
  if (value?.shadowOrder && value.shadowOrder.signalInputHash !== value?.inputHash) {
    reasons.push("shadow_input_hash_mismatch");
  }
  if (value?.decision === "do") {
    const notionalUsd = finite(value?.shadowOrder?.notionalUsd);
    const maxSlippageBps = finite(value?.shadowOrder?.maxSlippageBps);
    if (notionalUsd == null || notionalUsd <= 0
      || notionalUsd > NARRATIVE_TRADE_POLICY.maximumShadowNotionalUsd) {
      reasons.push("shadow_notional_out_of_policy");
    }
    if (maxSlippageBps == null || maxSlippageBps < 0
      || maxSlippageBps > NARRATIVE_TRADE_POLICY.maximumSlippageBps) {
      reasons.push("shadow_slippage_out_of_policy");
    }
    if (value?.risk?.marketEvidenceFresh !== true || value?.risk?.riskEvidenceFresh !== true) {
      reasons.push("shadow_evidence_not_fresh");
    }
    if (value?.execution?.automaticExecution !== false
      || value?.execution?.networkAccess !== false
      || value?.execution?.signing !== false
      || value?.execution?.broadcast !== false) {
      reasons.push("shadow_execution_capability_present");
    }
  }
  if (!hashPattern.test(String(value?.decisionHash || ""))) {
    reasons.push("invalid_decision_hash");
  } else if (value && typeof value === "object") {
    const { decisionHash, ...material } = value;
    if (digest(material) !== decisionHash) reasons.push("decision_hash_mismatch");
  }
  return deepFreeze({ valid: reasons.length === 0, reasons: [...new Set(reasons)] });
}

export function isNarrativeTradeSignal(value) {
  const validShadowOrder = value?.decision === "do"
    ? value?.shadowOrder?.mode === "shadow"
      && value.shadowOrder.executable === false
      && value.shadowOrder.side === "buy"
      && validAddress(String(value.shadowOrder.ca || "").toLowerCase())
      && value.shadowOrder.ca === value?.target?.ca
      && Number.isSafeInteger(value.shadowOrder.chainId)
      && value.shadowOrder.chainId > 0
      && value.shadowOrder.chainId === value?.target?.chainId
      && validAddress(String(value.shadowOrder.poolAddress || "").toLowerCase())
      && value.shadowOrder.poolAddress === value?.target?.poolAddress
      && value?.hardBlocks?.length === 0
    : value?.shadowOrder == null;
  return value?.version === NARRATIVE_TRADE_SIGNAL_VERSION
    && value?.schema === NARRATIVE_TRADE_SIGNAL_SCHEMA
    && value?.deterministic === true
    && NARRATIVE_TRADE_DECISIONS.includes(value?.decision)
    && Number.isFinite(value?.score)
    && typeof value?.event?.zh === "string"
    && typeof value?.event?.en === "string"
    && Array.isArray(value?.hardBlocks)
    && validShadowOrder;
}
