import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const FOUR_HANDLE = "fourdotmemezh";
const FOUR_AUTHOR_ID = "1816036559864619011";
const ROLLOUT_STARTED_AT = "2026-09-04T08:00:00.000Z";
const ROLLOUT_ENDS_AT = "2026-09-11T08:00:00.000Z";

export const FOUR_TWITTER_POLICY_RECOVERY_SET = "four-twitter-policy-fix-2026-09-v1";

// This is deliberately an immutable, finite migration list. It is not a
// generic backfill mechanism and must never grow by inspecting older timeline
// items. Removing the code after the rollout window is safe because the
// standard alert outbox remains the exact-once authority.
export const FOUR_TWITTER_POLICY_RECOVERY_SPECS = Object.freeze([
  Object.freeze({
    allowlistId: `${FOUR_TWITTER_POLICY_RECOVERY_SET}:listayield`,
    kind: "named_mode",
    tweetId: "2095361508700258731",
    originalEventKey: "twitter:fourdotmemezh:2095361508700258731",
    derivedEventKey: "twitter:fourdotmemezh:2095361508700258731:policy-fix-recovery:v1",
    createdAt: "2026-09-03T04:01:28.000Z",
    textSha256: "d9997debab05aa886ffa9b95cc0de3fda27bf6a59e23a04328868f99338edd29",
    evidenceSource: "durable_suppressed_outbox+verified_exact_status",
    maximumSourceAgeMs: 7 * DAY_MS,
  }),
  Object.freeze({
    allowlistId: `${FOUR_TWITTER_POLICY_RECOVERY_SET}:bstock-campaign`,
    kind: "market_campaign",
    tweetId: "2095713912188739967",
    originalEventKey: "twitter:fourdotmemezh:2095713912188739967",
    derivedEventKey: "twitter:fourdotmemezh:2095713912188739967:policy-fix-recovery:v1",
    createdAt: "2026-09-04T03:21:47.000Z",
    textSha256: "548a09c8436c71905c131c732c258125ba1a66c7baea83a0ecbe65539a606b5c",
    evidenceSource: "verified_recent_timeline+verified_exact_status",
    maximumSourceAgeMs: 48 * HOUR_MS,
  }),
]);

function sha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function strictIsoMs(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function canonicalStatusUrl(tweetId) {
  return `https://x.com/${FOUR_HANDLE}/status/${tweetId}`;
}

function canonicalRecoveryNoveltyKey(tweetId) {
  return `fourmeme:policy-fix-recovery:x:${tweetId}:v1`;
}

function projectIsExactFour(project) {
  return project?.id === "fourmeme"
    && project?.name === "Four.meme"
    && project?.website === "https://four.meme"
    && project?.twitter === `https://x.com/${FOUR_HANDLE}`
    && String(project.handle || "").toLowerCase() === FOUR_HANDLE
    && String(project.xUserId || "") === FOUR_AUTHOR_ID
    && project.match === "official_x";
}

function isFixedRecoverySpec(spec) {
  return FOUR_TWITTER_POLICY_RECOVERY_SPECS.includes(spec);
}

function immutableTweetMatches(tweet, spec, { requireExactProof = false } = {}) {
  if (!tweet || typeof tweet !== "object" || Array.isArray(tweet)) return false;
  if (String(tweet.id || "") !== spec.tweetId
    || String(tweet.authorId || "") !== FOUR_AUTHOR_ID
    || String(tweet.handle || "").toLowerCase() !== FOUR_HANDLE
    || tweet.createdAt !== spec.createdAt
    || tweet.url !== canonicalStatusUrl(spec.tweetId)
    || sha256(tweet.text) !== spec.textSha256
    || tweet.isReply === true) return false;
  if (!requireExactProof) return true;
  return tweet.sourceVerifiedBy === "official_x_oembed"
    && tweet.identityVerifiedBy === "fxtwitter_exact_numeric_id";
}

function suppressedListaYieldSource(outbox, spec) {
  const entry = outbox?.events?.[spec.originalEventKey];
  const telegram = entry?.destinations?.telegram;
  if (!entry
    || entry.id !== spec.originalEventKey
    || entry.status !== "suppressed"
    || telegram?.status !== "disabled"
    || telegram?.disabledReason !== "semantic_duplicate"
    || entry.semanticDuplicateOf !== "twitter:fourdotmemezh:2084706267562709294"
    // Early outbox rows used the outer id as the sole canonical key. Accept
    // that exact legacy shape, but fail closed if an inner key is present and
    // disagrees with the immutable outer id.
    || (entry.event?.eventKey !== undefined && entry.event.eventKey !== spec.originalEventKey)
    || entry.event?.type !== "twitter_update"
    || !projectIsExactFour(entry.event?.project)
    || !immutableTweetMatches(entry.event.tweet, spec)) return null;
  return entry.event.tweet;
}

function recentCampaignSource(recentTweets, spec, nowMs) {
  if (!Array.isArray(recentTweets) || recentTweets.length > 100) return null;
  const tweet = recentTweets.find((candidate) => String(candidate?.id || "") === spec.tweetId);
  const occurredAtMs = strictIsoMs(tweet?.createdAt);
  if (!immutableTweetMatches(tweet, spec)
    || occurredAtMs === null
    || nowMs < occurredAtMs
    || nowMs - occurredAtMs > spec.maximumSourceAgeMs) return null;
  return tweet;
}

function expectedSignalProjection(spec, signal) {
  const common = {
    relevant: signal?.relevant,
    strong: signal?.strong,
    platformStructural: signal?.platformStructural,
    reason: signal?.reason,
    labels: signal?.labels,
  };
  if (spec.kind === "named_mode") return { ...common, namedMode: signal?.namedMode };
  if (spec.kind === "market_campaign") return { ...common, marketCampaign: signal?.marketCampaign };
  return common;
}

// Filled from the deterministic Twitter classifier contract. Recovery never
// supplies a hand-authored signal: the classifier result must match one of
// these exact safety-sensitive shapes before it can enter the alert pipeline.
export const FOUR_TWITTER_POLICY_RECOVERY_SIGNAL_SHAPES = Object.freeze({
  named_mode: Object.freeze({
    relevant: true,
    strong: true,
    platformStructural: true,
    reason: "fourmeme_named_mode_listayield",
    labels: Object.freeze(["新发射/新模式", "OpenFour", "税收/募资/报价代币"]),
    namedMode: Object.freeze({
      version: 1,
      id: "listayield",
      name: "ListaYield",
      parent: "OpenFour",
      stage: "announced",
      partnerHandle: "lista_dao",
      tradingTaxRoute: "yield_bearing_products",
      holderYield: true,
      graduationLiquidityDestination: "Lista DEX",
    }),
  }),
  market_campaign: Object.freeze({
    relevant: true,
    strong: true,
    platformStructural: false,
    reason: "fourmeme_bstock_partner_leaderboard_live",
    labels: Object.freeze(["Four.Meme bStock 合作榜单"]),
    marketCampaign: Object.freeze({
      version: 1,
      kind: "bstock_partner_leaderboard",
      assetClass: "bstock",
      stage: "live",
      partnerHandle: "AveaiGlobal",
      chainHandle: "BNBCHAIN",
      venue: "Ave.ai",
      totalPrizeUsdt: 150000,
      fourMemePrizeUsdt: 50000,
      topRanks: 500,
      exclusiveToFourMemeTraders: true,
      campaignKey: "fourmeme:market-campaign:bstock:aveaiglobal:50000-usdt:top-500",
    }),
  }),
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isExpectedFourRecoverySignal(spec, signal, signalShapes = FOUR_TWITTER_POLICY_RECOVERY_SIGNAL_SHAPES) {
  const expected = signalShapes?.[spec?.kind];
  if (!expected) return false;
  return stableJson(expectedSignalProjection(spec, signal)) === stableJson(expected);
}

function canonicalTweet(tweet, spec) {
  return Object.freeze({
    id: spec.tweetId,
    text: String(tweet.text),
    createdAt: spec.createdAt,
    authorName: "Four.meme-華語",
    handle: FOUR_HANDLE,
    xUserId: FOUR_AUTHOR_ID,
    authorId: FOUR_AUTHOR_ID,
    url: canonicalStatusUrl(spec.tweetId),
    isReply: false,
    expandedUrls: Object.freeze(spec.kind === "market_campaign"
      ? ["http://Four.Meme", "http://Ave.ai"]
      : ["http://Four.Meme"]),
    sourceVerifiedBy: "official_x_oembed",
    identityVerifiedBy: "fxtwitter_exact_numeric_id",
  });
}

function canonicalProject() {
  return Object.freeze({
    id: "fourmeme",
    name: "Four.meme",
    website: "https://four.meme",
    twitter: `https://x.com/${FOUR_HANDLE}`,
    handle: FOUR_HANDLE,
    xUserId: FOUR_AUTHOR_ID,
    match: "official_x",
    priority: true,
  });
}

export function buildFourPolicyRecoveryEvent({
  project,
  tweet,
  signal,
  spec,
  recoveredAt,
  signalShapes = FOUR_TWITTER_POLICY_RECOVERY_SIGNAL_SHAPES,
}) {
  const recoveredAtMs = strictIsoMs(recoveredAt);
  const occurredAtMs = strictIsoMs(spec?.createdAt);
  if (!isFixedRecoverySpec(spec)
    || !projectIsExactFour(project)
    || !immutableTweetMatches(tweet, spec, { requireExactProof: true })
    || !isExpectedFourRecoverySignal(spec, signal, signalShapes)
    || recoveredAtMs === null
    || occurredAtMs === null
    || recoveredAtMs < occurredAtMs) return null;
  const immutableTweet = canonicalTweet(tweet, spec);
  const policyFixRecovery = Object.freeze({
    version: 1,
    allowlistId: spec.allowlistId,
    reason: "historical_policy_false_negative",
    originalEventKey: spec.originalEventKey,
    derivedEventKey: spec.derivedEventKey,
    sourceOccurredAt: spec.createdAt,
    recoveredAt,
    lagMs: recoveredAtMs - occurredAtMs,
    evidenceSource: spec.evidenceSource,
    expectedAuthorId: FOUR_AUTHOR_ID,
    tweetTextSha256: spec.textSha256,
    stale: true,
    noChase: true,
    automaticExecution: false,
  });
  return Object.freeze({
    type: "twitter_update",
    eventKey: spec.derivedEventKey,
    originalEventKey: spec.originalEventKey,
    project: canonicalProject(),
    tweet: immutableTweet,
    signal: Object.freeze({ ...signal }),
    observedAt: recoveredAt,
    policyFixRecovery,
  });
}

function recoveryStateRoot(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new TypeError("Twitter state must be an object");
  state._meta ||= {};
  state._meta.policyFixRecovery ||= {};
  const existing = state._meta.policyFixRecovery.fourTwitterV1;
  if (existing && (existing.version !== 1 || existing.recoverySet !== FOUR_TWITTER_POLICY_RECOVERY_SET)) {
    throw new Error("incompatible Four Twitter policy recovery state");
  }
  state._meta.policyFixRecovery.fourTwitterV1 ||= {
    version: 1,
    recoverySet: FOUR_TWITTER_POLICY_RECOVERY_SET,
    rolloutStartedAt: ROLLOUT_STARTED_AT,
    rolloutEndsAt: ROLLOUT_ENDS_AT,
    items: {},
  };
  return state._meta.policyFixRecovery.fourTwitterV1;
}

function recoveryMarkerMatches(marker, spec) {
  return marker
    && ["durably_accepted", "already_covered", "expired"].includes(marker.status)
    && marker.tweetId === spec.tweetId
    && marker.originalEventKey === spec.originalEventKey
    && marker.derivedEventKey === spec.derivedEventKey;
}

function durableOriginalCampaignEntry(entry, spec, signalShapes = FOUR_TWITTER_POLICY_RECOVERY_SIGNAL_SHAPES) {
  if (spec.kind !== "market_campaign") return false;
  return Boolean(entry
    && entry.id === spec.originalEventKey
    && ["pending", "delivered"].includes(entry.status)
    && entry.event?.type === "twitter_update"
    && (entry.event?.eventKey === undefined || entry.event.eventKey === spec.originalEventKey)
    && projectIsExactFour(entry.event?.project)
    && immutableTweetMatches(entry.event?.tweet, spec)
    && entry.event?.tweet?.sourceVerifiedBy === "official_x_oembed"
    && isExpectedFourRecoverySignal(spec, entry.event?.signal, signalShapes));
}

function durableRecoveryEntry(entry, spec, signalShapes = FOUR_TWITTER_POLICY_RECOVERY_SIGNAL_SHAPES) {
  const recovery = entry?.event?.policyFixRecovery;
  const priority = entry?.event?.tradingPriority;
  const disposition = entry?.deliveryDisposition;
  const recoveredAtMs = strictIsoMs(recovery?.recoveredAt);
  const sourceOccurredAtMs = strictIsoMs(recovery?.sourceOccurredAt);
  return Boolean(entry
    && entry.id === spec.derivedEventKey
    && ["pending", "delivered"].includes(entry.status)
    && entry.event?.type === "twitter_update"
    && entry.event?.eventKey === spec.derivedEventKey
    && entry.event?.originalEventKey === spec.originalEventKey
    && immutableTweetMatches(entry.event?.tweet, spec, { requireExactProof: true })
    && isExpectedFourRecoverySignal(spec, entry.event?.signal, signalShapes)
    && Array.isArray(entry.event?.canonicalSignalIds)
    && entry.event.canonicalSignalIds.includes(canonicalRecoveryNoveltyKey(spec.tweetId))
    && recovery?.version === 1
    && recovery?.allowlistId === spec.allowlistId
    && recovery?.reason === "historical_policy_false_negative"
    && recovery?.derivedEventKey === spec.derivedEventKey
    && recovery?.originalEventKey === spec.originalEventKey
    && recovery?.sourceOccurredAt === spec.createdAt
    && recoveredAtMs !== null
    && sourceOccurredAtMs !== null
    && recoveredAtMs >= sourceOccurredAtMs
    && recovery?.lagMs === recoveredAtMs - sourceOccurredAtMs
    && recovery?.expectedAuthorId === FOUR_AUTHOR_ID
    && recovery?.tweetTextSha256 === spec.textSha256
    && recovery?.stale === true
    && recovery?.noChase === true
    && recovery?.automaticExecution === false
    && priority?.tier === "T2"
    && priority?.plan?.automaticExecution === false
    && disposition?.mode === "immediate"
    && disposition?.deliverImmediately === true
    && disposition?.tier === "T2");
}

async function defaultLoadOutbox(config) {
  try {
    return JSON.parse(await fs.readFile(path.join(config.dataDir, "alert-outbox.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 2, events: {} };
    throw error;
  }
}

function assertOutbox(outbox) {
  if (!outbox
    || outbox.version !== 2
    || !outbox.events
    || typeof outbox.events !== "object"
    || Array.isArray(outbox.events)) throw new Error("invalid alert outbox for Four Twitter policy recovery");
  return outbox;
}

async function persistMarker(state, spec, marker, persistStateImpl) {
  const root = recoveryStateRoot(state);
  const previous = root.items[spec.tweetId];
  root.items[spec.tweetId] = marker;
  try {
    await persistStateImpl(state, { durable: true, reason: "four_twitter_policy_recovery" });
  } catch (error) {
    if (previous === undefined) delete root.items[spec.tweetId];
    else root.items[spec.tweetId] = previous;
    throw error;
  }
}

function acceptedMarker(entry, spec) {
  const recovery = entry.event.policyFixRecovery;
  return {
    status: "durably_accepted",
    tweetId: spec.tweetId,
    originalEventKey: spec.originalEventKey,
    derivedEventKey: spec.derivedEventKey,
    sourceOccurredAt: spec.createdAt,
    recoveredAt: recovery.recoveredAt,
    acceptedAt: entry.updatedAt || entry.createdAt || recovery.recoveredAt,
    outboxStatus: entry.status,
  };
}

function expiredMarker(spec, checkedAt, reason) {
  return {
    status: "expired",
    reason,
    tweetId: spec.tweetId,
    originalEventKey: spec.originalEventKey,
    derivedEventKey: spec.derivedEventKey,
    sourceOccurredAt: spec.createdAt,
    checkedAt,
  };
}

function coveredMarker(entry, spec, checkedAt) {
  return {
    status: "already_covered",
    reason: "normal_producer_durably_accepted",
    tweetId: spec.tweetId,
    originalEventKey: spec.originalEventKey,
    derivedEventKey: spec.derivedEventKey,
    sourceOccurredAt: spec.createdAt,
    checkedAt,
    coveredByEventKey: entry.id,
    outboxStatus: entry.status,
  };
}

export async function recoverFourTwitterPolicyFixes({
  config,
  project,
  state,
  recentTweets = [],
  classifyTweetImpl,
  verifyExactTweetImpl,
  sendAlertsImpl,
  persistStateImpl,
  loadOutboxImpl = defaultLoadOutbox,
  now = Date.now,
  signalShapes = FOUR_TWITTER_POLICY_RECOVERY_SIGNAL_SHAPES,
} = {}) {
  if (!projectIsExactFour(project)) return { status: "not_applicable", recovered: [] };
  if (typeof classifyTweetImpl !== "function"
    || typeof verifyExactTweetImpl !== "function"
    || typeof sendAlertsImpl !== "function"
    || typeof persistStateImpl !== "function"
    || typeof loadOutboxImpl !== "function") throw new TypeError("Four Twitter policy recovery dependencies are required");
  const nowMs = Number(now());
  if (!Number.isFinite(nowMs)) throw new TypeError("Four Twitter policy recovery clock must be finite");
  const checkedAt = new Date(nowMs).toISOString();
  const rolloutStartMs = Date.parse(ROLLOUT_STARTED_AT);
  const rolloutEndMs = Date.parse(ROLLOUT_ENDS_AT);
  if (nowMs < rolloutStartMs) return { status: "not_started", recovered: [] };

  const root = recoveryStateRoot(state);
  const recovered = [];
  const deferred = [];
  const allSettled = FOUR_TWITTER_POLICY_RECOVERY_SPECS.every((spec) => {
    const marker = root.items[spec.tweetId];
    if (marker && !recoveryMarkerMatches(marker, spec)) {
      throw new Error(`invalid Four Twitter policy recovery marker for ${spec.tweetId}`);
    }
    return Boolean(marker);
  });
  // Avoid parsing the shared (and potentially large) outbox on every fast X
  // poll after this finite migration has durably reached a terminal state.
  if (allSettled) return { status: "complete", recovered, deferred };
  let outbox = assertOutbox(await loadOutboxImpl(config));

  for (const spec of FOUR_TWITTER_POLICY_RECOVERY_SPECS) {
    const marker = root.items[spec.tweetId];
    if (marker) {
      if (!recoveryMarkerMatches(marker, spec)) throw new Error(`invalid Four Twitter policy recovery marker for ${spec.tweetId}`);
      continue;
    }

    const existingDerived = outbox?.events?.[spec.derivedEventKey];
    if (existingDerived) {
      if (!durableRecoveryEntry(existingDerived, spec, signalShapes)) {
        throw new Error(`incompatible or non-durable derived recovery outbox entry for ${spec.tweetId}`);
      }
      await persistMarker(state, spec, acceptedMarker(existingDerived, spec), persistStateImpl);
      recovered.push({ tweetId: spec.tweetId, eventKey: spec.derivedEventKey, reused: true });
      break;
    }

    // A normal producer running the fixed classifier may win the race with
    // this migration. Its durable original-key entry already covers the user;
    // recording that fact prevents a second recovery card. A suppressed
    // original is intentionally not coverage and remains eligible below.
    const existingOriginal = outbox?.events?.[spec.originalEventKey];
    if (durableOriginalCampaignEntry(existingOriginal, spec, signalShapes)) {
      await persistMarker(state, spec, coveredMarker(existingOriginal, spec, checkedAt), persistStateImpl);
      continue;
    }

    // A durable outbox enqueue wins over the wall-clock deadline. This order
    // closes a crash where enqueue succeeded before the window ended but the
    // Twitter state marker did not fsync until after it ended.
    const sourceAtMs = Date.parse(spec.createdAt);
    if (nowMs > rolloutEndMs || nowMs - sourceAtMs > spec.maximumSourceAgeMs) {
      const reason = nowMs > rolloutEndMs ? "rollout_window_closed" : "source_age_window_closed";
      await persistMarker(state, spec, expiredMarker(spec, checkedAt, reason), persistStateImpl);
      continue;
    }

    const sourceTweet = spec.kind === "named_mode"
      ? suppressedListaYieldSource(outbox, spec)
      : recentCampaignSource(recentTweets, spec, nowMs);
    if (!sourceTweet) {
      deferred.push({ tweetId: spec.tweetId, reason: spec.kind === "named_mode" ? "suppressed_source_unavailable" : "verified_recent_timeline_item_unavailable" });
      continue;
    }

    let exactTweet;
    try {
      exactTweet = await verifyExactTweetImpl(project, spec.tweetId, sourceTweet);
    } catch (error) {
      deferred.push({ tweetId: spec.tweetId, reason: "exact_status_verification_failed", error: error?.message || String(error) });
      continue;
    }
    if (!immutableTweetMatches(exactTweet, spec, { requireExactProof: true })
      || sha256(sourceTweet.text) !== sha256(exactTweet.text)) {
      deferred.push({ tweetId: spec.tweetId, reason: "immutable_exact_status_mismatch" });
      continue;
    }

    const signal = await classifyTweetImpl(exactTweet.text, project, config, exactTweet.expandedUrls || []);
    if (!isExpectedFourRecoverySignal(spec, signal, signalShapes)) {
      deferred.push({ tweetId: spec.tweetId, reason: "deterministic_classifier_shape_mismatch" });
      continue;
    }
    const event = buildFourPolicyRecoveryEvent({
      project,
      tweet: exactTweet,
      signal,
      spec,
      recoveredAt: checkedAt,
      signalShapes,
    });
    if (!event) {
      deferred.push({ tweetId: spec.tweetId, reason: "recovery_event_validation_failed" });
      continue;
    }

    const result = await sendAlertsImpl(config, event);
    if (!result || !["queued", "delivered"].includes(String(result.status || "").toLowerCase())
      || result.eventId !== spec.derivedEventKey) {
      throw new Error(`Four Twitter policy recovery was not durably accepted for ${spec.tweetId}`);
    }
    outbox = assertOutbox(await loadOutboxImpl(config));
    const persisted = outbox?.events?.[spec.derivedEventKey];
    if (!durableRecoveryEntry(persisted, spec, signalShapes)) {
      throw new Error(`Four Twitter policy recovery outbox proof is missing for ${spec.tweetId}`);
    }
    await persistMarker(state, spec, acceptedMarker(persisted, spec), persistStateImpl);
    recovered.push({ tweetId: spec.tweetId, eventKey: spec.derivedEventKey, reused: false });
    // Deliberately queue at most one stale recovery per monitor cycle.
    break;
  }

  return {
    status: recovered.length ? "recovered" : deferred.length ? "deferred" : "complete",
    recovered,
    deferred,
  };
}
