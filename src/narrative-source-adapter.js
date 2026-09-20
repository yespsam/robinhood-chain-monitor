import { createHash } from "node:crypto";

import { DEFAULT_REPOSITORIES } from "./github-monitor.js";
import { matchReviewedPoolAssetKeys } from "./new-pool-context.js";

export const NARRATIVE_SOURCE_ADAPTER_SCHEMA = "narrative_source_adapter_v1";
export const NORMALIZED_NARRATIVE_NEWS_SCHEMA = "normalized_narrative_news_v1";
export const NORMALIZED_NARRATIVE_NEWS_TYPE = "normalized_narrative_news";

const ASSET_KEY_RE = /^eip155:[1-9]\d*\/erc20:0x[a-f0-9]{40}$/u;
const POSITIVE_TRUST = new Set(["official_verified", "verified_official", "official_authenticated_api", "verified"]);
const NEGATIVE_TRUST = new Set([
  "observed",
  "public_observation",
  "public_observed",
  "public_telegram_observed",
  "unverified",
  "unverified_candidate",
]);
const PUBLIC_TYPES = new Set([
  "public_news_observation",
  "telegram_news_update",
]);
const UNSUPPORTED_TYPES = new Set(["panews_news_update", "panews_update"]);
const BINANCE_SOURCE_IDS = new Set([
  "binance_announcement_websocket",
  "binance_developer_docs",
  "binance_exchange_cms",
  "binance_square_cms",
  "binance_wallet_cms",
  "launchpool_api",
  "meme_rush_api",
]);
const UNISWAP_SOURCES = new Map([
  ["uniswap_blog", ["blog.uniswap.org"]],
  ["uniswap_github_release", ["github.com"]],
  ["uniswap_governance", ["gov.uniswap.org"]],
]);
const AI_SOURCE_RULES = new Map([
  ["x_api_changelog", {
    projectId: "x",
    projectWebsite: "https://x.com/",
    projectTwitter: "https://x.com/X",
    transportUrl: "https://docs.x.com/changelog/rss.xml",
  }],
  ["xai_news", {
    projectId: "xai",
    projectWebsite: "https://x.ai/",
    projectTwitter: "https://x.com/SpaceXAI",
    transportUrl: "https://r.jina.ai/https://x.ai/news",
  }],
  ["xai_release_notes", {
    projectId: "xai",
    projectWebsite: "https://x.ai/",
    projectTwitter: "https://x.com/SpaceXAI",
    transportUrl: "https://docs.x.ai/developers/release-notes.md",
  }],
]);
const OFFICIAL_X_IDENTITIES = new Map([
  ["api", { id: "x-api", userId: "6253282" }],
  ["binance", { id: "binance", userId: "877807935493033984" }],
  ["binancefutures", { id: "binance-futures", userId: "1426142483822518274" }],
  ["binancewallet", { id: "binance-wallet", userId: "1400391752368992260" }],
  ["flapdotsh", { id: "flap", userId: "1749114887807320064" }],
  ["fourdotmemezh", { id: "fourmeme", userId: "1816036559864619011" }],
  ["grok", { id: "grok", userId: "1720665183188922368" }],
  ["pondotfun", { id: "ponfun", userId: "2094048312772993024" }],
  ["spacexai", { id: "xai", userId: "1661523610111193088" }],
  ["tradepools", { id: "uniswap-pools", userId: "2080394757721735168" }],
  ["uniswap", { id: "uniswap", userId: "984188226826010624" }],
  ["x", { id: "x", userId: "783214" }],
]);
const OFFICIAL_GITHUB_REPOSITORIES = new Set(DEFAULT_REPOSITORIES
  .filter((entry) => entry?.sourceTrust === "official_verified")
  .map((entry) => String(entry.repository || "").toLowerCase())
  .filter(Boolean));
const TRUSTED_PULL_REQUEST_ASSOCIATIONS = new Set(["collaborator", "member", "owner"]);
const MAX_TEXT_LENGTH = 64_000;

function clean(value, maximum = 4_000) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function lower(value) {
  return clean(value).toLowerCase();
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => (
      value[key] === undefined ? [] : [[key, canonicalize(value[key])]]
    )));
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

function present(value) {
  return value !== undefined && value !== null && value !== "";
}

function normalizeHttpsUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const authority = raw.match(/^https:\/\/([^/?#]+)/iu)?.[1] || "";
  if (!authority || /:\d+$/u.test(authority.replace(/^.*@/u, ""))) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname || url.port || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function urlHost(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return "";
  }
}

function hostAllowed(value, roots) {
  const host = urlHost(value);
  return roots.some((root) => host === root || host.endsWith(`.${root}`));
}

function urlClaimResult(values) {
  const claims = values.filter(present);
  const normalized = claims.map(normalizeHttpsUrl);
  if (!claims.length) return { url: null, valid: false, conflict: false, values: [] };
  if (normalized.some((value) => !value)) return { url: null, valid: false, conflict: false, values: [] };
  const unique = [...new Set(normalized)].sort();
  return {
    url: unique.length === 1 ? unique[0] : null,
    valid: unique.length === 1,
    conflict: unique.length > 1,
    values: unique,
  };
}

function parseInstant(value) {
  if (!present(value)) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function instantClaimResult(values) {
  const claims = values.filter(present);
  const parsed = claims.map(parseInstant);
  if (!claims.length || parsed.some((value) => value === null)) {
    return { publishedAt: null, valid: false, conflict: false };
  }
  const unique = [...new Set(parsed)].sort((left, right) => left - right);
  return {
    publishedAt: unique.length === 1 ? new Date(unique[0]).toISOString() : null,
    valid: unique.length === 1,
    conflict: unique.length > 1,
  };
}

function localized(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const zh = clean(value.zh ?? value.cn ?? value.chinese, 500);
    const en = clean(value.en ?? value.english, 500);
    return { zh: zh || en, en: en || zh };
  }
  const shared = clean(value, 500);
  return { zh: shared, en: shared };
}

function firstHeadline(...values) {
  for (const value of values) {
    const headline = localized(value);
    if (headline.zh || headline.en) return headline;
  }
  return { zh: "", en: "" };
}

function appendText(parts, value) {
  if (typeof value === "string") {
    const text = clean(value, MAX_TEXT_LENGTH);
    if (text) parts.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 32)) appendText(parts, item);
    return;
  }
  if (value && typeof value === "object") {
    for (const key of ["zh", "en", "cn", "chinese", "english", "headline", "title", "summary", "description", "body", "text"] ) {
      if (Object.hasOwn(value, key)) appendText(parts, value[key]);
    }
  }
}

function subjectText(event, evidence, headline) {
  const parts = [];
  for (const value of [
    headline,
    evidence?.summary,
    event?.summary,
    event?.description,
    event?.message,
    event?.body,
    event?.factSummary,
    event?.keyChanges,
    event?.signal?.headline,
    event?.signal?.claims,
    event?.signal?.keyChanges,
    event?.tweet?.text,
    event?.news?.headline,
    event?.news?.summary,
    event?.news?.body,
  ]) appendText(parts, value);
  return [...new Set(parts)].join("\n").slice(0, MAX_TEXT_LENGTH);
}

function addBooleanClaim(state, value, label) {
  if (!present(value)) return;
  if (typeof value !== "boolean") {
    state.invalid.push(label);
    return;
  }
  if (value) state.positive.push(label);
  else state.negative.push(label);
}

function addTrustClaim(state, value, label) {
  if (!present(value)) return;
  if (typeof value !== "string") {
    state.invalid.push(label);
    return;
  }
  const normalized = lower(value);
  if (POSITIVE_TRUST.has(normalized)) state.positive.push(label);
  else if (NEGATIVE_TRUST.has(normalized)) state.negative.push(label);
  else state.invalid.push(label);
}

function trustResult(event, evidence) {
  const state = { positive: [], negative: [], invalid: [] };
  for (const [value, label] of [
    [evidence?.verified, "narrativeEvidence.verified"],
    [event?.verified, "event.verified"],
    [event?.verification?.verified, "verification.verified"],
    [event?.news?.verified, "news.verified"],
    [event?.source?.verified, "source.verified"],
    [event?.source?.official, "source.official"],
  ]) addBooleanClaim(state, value, label);
  for (const [value, label] of [
    [event?.sourceTrust, "event.sourceTrust"],
    [event?.source?.trust, "source.trust"],
    [event?.verification?.status, "verification.status"],
  ]) addTrustClaim(state, value, label);
  return {
    ...state,
    claimedVerified: state.positive.length > 0,
    valid: state.invalid.length === 0 && !(state.positive.length && state.negative.length),
    conflict: state.invalid.length > 0 || Boolean(state.positive.length && state.negative.length),
  };
}

function normalizedAssetClaims(event, evidence) {
  const values = [
    event?.contextAssetKey,
    evidence?.contextAssetKey,
    ...(Array.isArray(event?.contextAssetKeys) ? event.contextAssetKeys : []),
    ...(Array.isArray(evidence?.contextAssetKeys) ? evidence.contextAssetKeys : []),
  ].filter(present);
  const normalized = values.map((value) => lower(value));
  return {
    present: values.length > 0,
    valid: normalized.every((value) => ASSET_KEY_RE.test(value)),
    keys: [...new Set(normalized.filter((value) => ASSET_KEY_RE.test(value)))].sort(),
  };
}

function exactXStatusUrl(value, handle, tweetId) {
  const normalized = normalizeHttpsUrl(value);
  if (!normalized) return false;
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/u);
  return ["twitter.com", "x.com"].includes(host)
    && lower(match?.[1]) === handle
    && match?.[2] === tweetId
    && !url.search && !url.hash;
}

function authenticTwitterEvent(event) {
  const project = event?.project;
  const tweet = event?.tweet;
  const handle = lower(project?.handle).replace(/^@/u, "");
  const expected = OFFICIAL_X_IDENTITIES.get(handle);
  const tweetId = clean(tweet?.id, 30);
  const identityClaims = [tweet?.xUserId, tweet?.authorId, tweet?.userId].filter(present).map(String);
  return event?.type === "twitter_update"
    && expected
    && lower(project?.id) === expected.id
    && lower(project?.match) === "official_x"
    && String(project?.xUserId || "") === expected.userId
    && normalizeHttpsUrl(project?.twitter) === `https://x.com/${clean(project.handle).replace(/^@/u, "")}`
    && /^\d{6,25}$/u.test(tweetId)
    && lower(tweet?.handle).replace(/^@/u, "") === handle
    && identityClaims.length > 0
    && identityClaims.every((value) => value === expected.userId)
    && exactXStatusUrl(tweet?.url, handle, tweetId)
    && tweet?.sourceVerifiedBy === "official_x_oembed"
    && tweet?.isReply === false
    && parseInstant(tweet?.createdAt) !== null
    && typeof tweet?.text === "string"
    && tweet.text.trim().length > 0;
}

function authenticGithubEvent(event) {
  const repository = lower(event?.repository);
  const match = /^([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/u.exec(repository);
  const commit = clean(event?.commit, 100);
  const url = normalizeHttpsUrl(event?.url);
  if (event?.type !== "github_module_update"
    || !match || !OFFICIAL_GITHUB_REPOSITORIES.has(repository)
    || event?.sourceTrust !== "official_verified"
    || event?.verification?.status !== "official_verified"
    || !url || urlHost(url) !== "github.com") return false;
  const parsedUrl = new URL(url);
  if (parsedUrl.search || parsedUrl.hash) return false;
  const pathname = parsedUrl.pathname.toLowerCase().replace(/\/+$/u, "");
  const commitPath = /^[a-f0-9]{40}$/iu.test(commit)
    ? `/${repository}/commit/${commit.toLowerCase()}`
    : null;
  const pullNumber = Number(event?.pullRequest?.number);
  const pullPath = Number.isSafeInteger(pullNumber) && pullNumber > 0 ? `/${repository}/pull/${pullNumber}` : null;
  if (commitPath && pathname === commitPath) return event?.developmentStage !== "pull_request";
  if (!pullPath || pathname !== pullPath) return false;
  const headCommit = lower(event?.headCommit);
  return event?.developmentStage === "pull_request"
    && event?.onchainConfirmed === false
    && /^[a-f0-9]{40}$/u.test(headCommit)
    && lower(event?.pullRequest?.headCommit) === headCommit
    && new RegExp(`^pr-${pullNumber}-[a-f0-9]{12}$`, "u").test(lower(commit))
    && TRUSTED_PULL_REQUEST_ASSOCIATIONS.has(lower(
      event?.pullRequest?.authorAssociation ?? event?.authorAssociation,
    ));
}

function safeAiDocumentPath(pathname) {
  return /^\/[a-z0-9._~/-]+$/iu.test(pathname)
    && !pathname.includes("//")
    && !pathname.split("/").some((segment) => segment === "." || segment === "..");
}

function aiItemUrlAllowed(sourceId, value) {
  const normalized = normalizeHttpsUrl(value);
  if (!normalized) return false;
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase();
  if (url.search) return false;
  if (sourceId === "x_api_changelog") {
    return host === "docs.x.com"
      && url.pathname === "/changelog"
      && (!url.hash || /^#(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)-\d{1,2}-\d{4}|\d{4}-\d{2}-\d{2})$/iu.test(url.hash));
  }
  if (host === "x.ai") {
    if (sourceId === "xai_news") return /^\/news\/[a-z0-9][a-z0-9-]*$/iu.test(url.pathname) && !url.hash;
    return sourceId === "xai_release_notes"
      && (/^\/news(?:\/[a-z0-9][a-z0-9-]*)?\/?$/iu.test(url.pathname))
      && !url.hash;
  }
  return sourceId === "xai_release_notes"
    && host === "docs.x.ai"
    && safeAiDocumentPath(url.pathname)
    && (!url.hash || /^#[a-z0-9][a-z0-9._~-]*$/iu.test(url.hash))
    && (["/developers/release-notes", "/developers/release-notes/", "/developers/release-notes.md"].includes(url.pathname)
      || /^\/(?:developers|grok-bot)\/[a-z0-9._~/-]*[a-z0-9._~-]$/iu.test(url.pathname));
}

function authenticAiEvent(event, contentUrl) {
  const sourceId = lower(event?.source?.id);
  const rule = AI_SOURCE_RULES.get(sourceId);
  const transportUrl = normalizeHttpsUrl(event?.source?.url);
  const projectWebsite = normalizeHttpsUrl(event?.project?.website);
  const projectTwitter = normalizeHttpsUrl(event?.project?.twitter);
  const socials = event?.project?.socials;
  return event?.type === "ai_official_update"
    && rule
    && lower(event?.kind) === sourceId
    && lower(event?.project?.id) === rule.projectId
    && projectWebsite === rule.projectWebsite
    && projectTwitter === rule.projectTwitter
    && (socials == null || (Array.isArray(socials)
      && socials.length > 0
      && socials.every((value) => ["https://x.com/SpaceXAI", "https://x.com/grok"].includes(normalizeHttpsUrl(value)))))
    && event?.source?.official === true
    && event?.source?.trust === "official_verified"
    && transportUrl === rule.transportUrl
    && contentUrl
    && aiItemUrlAllowed(sourceId, contentUrl);
}

function authenticBinanceEvent(event, contentUrl) {
  if (event?.type !== "binance_official_update" || !BINANCE_SOURCE_IDS.has(lower(event?.source?.id))) return false;
  const claims = [event?.source?.url, event?.detailSource, contentUrl].filter(present).map(normalizeHttpsUrl);
  return claims.length > 0 && claims.every((url) => url && hostAllowed(url, ["binance.com", "binance.info"]));
}

function authenticUniswapEvent(event, contentUrl) {
  if (event?.type !== "uniswap_official_update") return false;
  const sourceId = lower(event?.source?.id);
  const hosts = UNISWAP_SOURCES.get(sourceId);
  const sourceUrl = normalizeHttpsUrl(event?.source?.url);
  return Boolean(hosts
    && sourceUrl && contentUrl
    && hostAllowed(sourceUrl, hosts)
    && hostAllowed(contentUrl, hosts));
}

function eventLane(event) {
  if (event?.type === NORMALIZED_NARRATIVE_NEWS_TYPE && event?.schema === NORMALIZED_NARRATIVE_NEWS_SCHEMA) return "normalized";
  if (event?.type === "telegram_news_update") return "telegram";
  if (PUBLIC_TYPES.has(event?.type)) return "public";
  if (event?.type === "ai_official_update") return "ai_official";
  if (event?.type === "binance_official_update") return "binance_official";
  if (event?.type === "uniswap_official_update") return "uniswap_official";
  if (event?.type === "twitter_update") return "twitter_official";
  if (event?.type === "github_module_update") return "github_official";
  return "unknown";
}

function contentUrlClaims(event, evidence, lane) {
  const specific = [evidence?.sourceUrl, event?.sourceUrl, event?.news?.sourceUrl];
  if (lane === "telegram") specific.push(event?.messageUrl, event?.url);
  else if (lane === "twitter_official") specific.push(event?.tweet?.url, event?.url);
  else specific.push(event?.url);
  if (["normalized", "uniswap_official"].includes(lane)) specific.push(event?.source?.url);
  const presentSpecific = specific.filter(present);
  return urlClaimResult(presentSpecific.length ? presentSpecific : [event?.source?.url]);
}

function publicationClaims(event, evidence, lane) {
  const common = [
    evidence?.publishedAt,
    event?.publishedAt,
    event?.sourceOccurredAt,
    event?.news?.publishedAt,
    event?.article?.releaseDate,
    event?.article?.publishDate,
  ];
  if (lane === "twitter_official") common.push(event?.tweet?.createdAt);
  else if (lane === "github_official") common.push(event?.committedAt);
  else if (lane === "normalized" || lane === "unknown") common.push(event?.occurredAt);
  return instantClaimResult(common);
}

function sourceKindResult(event, evidence, lane) {
  const forced = {
    ai_official: "official_release",
    binance_official: "official_release",
    github_official: "official_github",
    public: "public_news_observed",
    telegram: "public_telegram_observed",
    twitter_official: "official_x",
    uniswap_official: "official_release",
    unknown: "unverified_observation",
  }[lane];
  if (forced) {
    const explicit = [evidence?.sourceKind, event?.sourceKind].filter(present).map(lower);
    return { sourceKind: forced, valid: explicit.every((value) => value === forced), conflict: explicit.some((value) => value !== forced) };
  }
  const claims = [evidence?.sourceKind, event?.sourceKind, event?.source?.kind].filter(present).map(lower);
  const unique = [...new Set(claims)].sort();
  return { sourceKind: unique.length === 1 ? unique[0] : null, valid: unique.length === 1, conflict: unique.length > 1 };
}

function percentage(value, fallback) {
  if (!present(value)) return { value: fallback, valid: true };
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100
    ? { value: numeric, valid: true }
    : { value: 0, valid: false };
}

function scoreBundle(event, evidence, verifiedLane) {
  const strength = percentage(
    evidence?.strength ?? event?.catalystStrength ?? event?.catalyst?.strength,
    verifiedLane && event?.strong === true ? 70 : 0,
  );
  const novelty = percentage(
    evidence?.novelty ?? event?.novelty ?? event?.catalyst?.novelty,
    verifiedLane && event?.changeType === "published" ? 70 : 0,
  );
  const mechanismConfidence = percentage(
    evidence?.mechanismConfidence ?? event?.mechanism?.confidence,
    verifiedLane && (event?.signal?.platformStructural === true || event?.signal?.majorProductUpdate === true) ? 70 : 0,
  );
  return {
    strength: strength.value,
    novelty: novelty.value,
    mechanismConfidence: mechanismConfidence.value,
    valid: strength.valid && novelty.valid && mechanismConfidence.valid,
  };
}

function eventIdentity(event) {
  const explicit = clean(event?.eventKey ?? event?.id, 512);
  if (explicit) return explicit;
  if (event?.type === "twitter_update") return `twitter:${lower(event?.tweet?.handle)}:${clean(event?.tweet?.id, 40)}`;
  if (event?.type === "github_module_update") return `github:${lower(event?.repository)}:${lower(event?.commit)}`;
  return `${clean(event?.type || "news", 80)}:${digest({
    title: event?.title,
    headline: event?.headline,
    url: event?.url,
    publishedAt: event?.publishedAt,
  })}`;
}

/**
 * Pure, fail-closed adapter from already-observed news events to the exact
 * evidence contract consumed by narrative-sniper-monitor. It performs no
 * network access and never consults a wall clock.
 */
export function adaptNarrativeSourceEvent(rawEvent, { chainId = null } = {}) {
  if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) return null;
  if (chainId !== null && (!Number.isSafeInteger(chainId) || chainId <= 0)) return null;
  const event = rawEvent;
  // No PANews producer/schema exists in this repository yet. Treating a
  // guessed title/url envelope as evidence would create an unauthenticated
  // source lane, so these names remain an explicit empty accepted set.
  if (UNSUPPORTED_TYPES.has(event?.type)) return null;
  const evidence = event?.narrativeEvidence && typeof event.narrativeEvidence === "object"
    && !Array.isArray(event.narrativeEvidence)
    ? event.narrativeEvidence
    : event?.narrative && typeof event.narrative === "object" && !Array.isArray(event.narrative)
      ? event.narrative
      : {};
  const lane = eventLane(event);
  const headline = firstHeadline(
    evidence?.headline,
    event?.headline,
    event?.title,
    event?.news?.headline,
    event?.news?.title,
    event?.tweet?.text,
    event?.message,
  );
  const text = subjectText(event, evidence, headline);
  const contextAssetKeys = matchReviewedPoolAssetKeys(text, { chainId });
  if (!contextAssetKeys.length) return null;

  const urls = contentUrlClaims(event, evidence, lane);
  const publication = publicationClaims(event, evidence, lane);
  const trust = trustResult(event, evidence);
  const sourceKind = sourceKindResult(event, evidence, lane);
  const declaredAssets = normalizedAssetClaims(event, evidence);
  const declaredAssetsConsistent = !declaredAssets.present
    || (declaredAssets.valid
      && JSON.stringify(declaredAssets.keys) === JSON.stringify(contextAssetKeys));
  const publicObservation = lane === "telegram" || lane === "public";
  // There is no authenticated producer for the normalized envelope in this
  // repository. Its self-declared trust fields are useful for deterministic
  // display and matching, but may never establish verified provenance.
  const sourceAuthentic = authenticAiEvent(event, urls.url)
    || authenticBinanceEvent(event, urls.url)
    || authenticUniswapEvent(event, urls.url)
    || authenticTwitterEvent(event)
    || authenticGithubEvent(event);
  const scores = scoreBundle(event, evidence, sourceAuthentic && !publicObservation);
  const errors = [
    ...(!urls.valid ? [urls.conflict ? "source_url_conflict" : "source_url_invalid_or_missing"] : []),
    ...(!publication.valid ? [publication.conflict ? "publication_time_conflict" : "publication_time_invalid_or_missing"] : []),
    ...(!sourceKind.valid ? [sourceKind.conflict ? "source_kind_conflict" : "source_kind_missing"] : []),
    ...(!trust.valid ? ["trust_claim_conflict_or_invalid"] : []),
    ...(trust.negative.length ? ["trust_explicitly_unverified"] : []),
    ...(!sourceAuthentic ? ["source_not_authenticated"] : []),
    ...(publicObservation ? ["public_observation_never_verifies_underlying_news"] : []),
    ...(!declaredAssetsConsistent ? ["declared_asset_keys_conflict_with_reviewed_text_match"] : []),
    ...(!scores.valid ? ["narrative_score_invalid"] : []),
    ...(!(headline.zh || headline.en) ? ["headline_missing"] : []),
  ];
  const verified = sourceAuthentic
    && !publicObservation
    && urls.valid
    && publication.valid
    && sourceKind.valid
    && trust.valid
    && trust.negative.length === 0
    && declaredAssetsConsistent
    && scores.valid
    && Boolean(headline.zh || headline.en);
  const narrativeEvidence = {
    verified,
    sourceKind: sourceKind.sourceKind,
    sourceUrl: urls.url,
    publishedAt: publication.publishedAt,
    headline,
    subjectMatch: true,
    strength: scores.strength,
    novelty: scores.novelty,
    mechanismConfidence: scores.mechanismConfidence,
    ...(evidence?.mechanism ? { mechanism: canonicalize(evidence.mechanism) } : {}),
    ...(evidence?.capitalFlow ? { capitalFlow: canonicalize(evidence.capitalFlow) } : {}),
    verificationErrors: [...new Set(errors)].sort(),
  };
  const evidenceKey = `narrative:${digest({
    adapterSchema: NARRATIVE_SOURCE_ADAPTER_SCHEMA,
    rawEventKey: eventIdentity(event),
    contextAssetKeys,
    narrativeEvidence,
  })}`;
  return deepFreeze({
    schema: NARRATIVE_SOURCE_ADAPTER_SCHEMA,
    evidenceKey,
    contextAssetKeys,
    narrativeEvidence,
  });
}

export function createNarrativeSourceAdapter({ chainId = null } = {}) {
  if (chainId !== null && (!Number.isSafeInteger(chainId) || chainId <= 0)) {
    throw new TypeError("narrative source adapter chainId must be a positive safe integer");
  }
  return Object.freeze({
    schema: NARRATIVE_SOURCE_ADAPTER_SCHEMA,
    adapt(rawEvent) {
      return adaptNarrativeSourceEvent(rawEvent, { chainId });
    },
  });
}
