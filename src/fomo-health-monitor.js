import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isTerminalAlertSuppression, sendAlerts } from "./alerts.js";

const STATE_VERSION = 1;
const STATE_OWNER = "main_process_fomo_health_watchdog";
const SOURCE_ID = "local_fomo_health_watchdog";
const SOURCE_TRUST = "local_persisted_health";
const HEALTH_LEVELS = new Set(["healthy", "degraded", "critical", "disabled", "unknown"]);
const FOMO_OUTBOX_EVENT_TYPES = new Set(["fomo_family_top_call", "fomo_monitor_health_update"]);
const MAX_TRANSITIONS = 100;

function finiteInteger(value, fallback, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.floor(number)) : fallback;
}

function iso(value) {
  return new Date(Number(value)).toISOString();
}

function parsedInstant(value, nowMs) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed <= nowMs + 60_000 ? parsed : null;
}

function boundedCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(1_000_000, Math.floor(number)) : 0;
}

function normalizedLevel(value, fallback = "unknown") {
  const level = String(value || "").trim().toLowerCase();
  return HEALTH_LEVELS.has(level) ? level : fallback;
}

function emptySummary() {
  return {
    smartMoney: { status: "disabled", admitted: 0, fresh: 0, lastKnownGood: 0 },
    bsc: { status: "disabled" },
    x: { status: "disabled", live: 0, eligible: 0 },
    thesis: { status: "disabled" },
    outbox: { status: "healthy", pending: 0, failed: 0 },
  };
}

function initialState(nowMs) {
  return {
    version: STATE_VERSION,
    owner: STATE_OWNER,
    initializedAt: iso(nowMs),
    lastCheckedAt: null,
    lastAggregateStatus: "unknown",
    zeroTarget: {
      firstObservedAt: null,
      sourceCycles: 0,
      lastCallCheckedAt: null,
    },
    candidate: null,
    activeIncident: null,
    recovery: null,
    transitions: {},
    history: [],
  };
}

function pruneTransitions(state) {
  const entries = Object.entries(state.transitions || {})
    .sort(([, left], [, right]) => String(left?.queuedAt || "").localeCompare(String(right?.queuedAt || "")));
  if (entries.length <= MAX_TRANSITIONS) return;
  const protectedKeys = new Set();
  if (state.activeIncident?.id) {
    const prefix = `fomo-health:${state.activeIncident.id}:`;
    for (const [key] of entries) if (key.startsWith(prefix)) protectedKeys.add(key);
  }
  const removable = [
    ...entries.filter(([key, item]) => !protectedKeys.has(key) && item?.status === "submitted"),
    ...entries.filter(([key, item]) => !protectedKeys.has(key) && item?.status !== "submitted"),
    ...entries.filter(([key]) => protectedKeys.has(key)),
  ];
  let excess = entries.length - MAX_TRANSITIONS;
  for (const [key] of removable) {
    if (excess <= 0) break;
    delete state.transitions[key];
    excess -= 1;
  }
}

function normalizeState(value, nowMs) {
  const fallback = initialState(nowMs);
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  if (value.owner !== STATE_OWNER || Number(value.version) !== STATE_VERSION) return fallback;
  const normalized = {
    ...fallback,
    ...value,
    version: STATE_VERSION,
    owner: STATE_OWNER,
    zeroTarget: { ...fallback.zeroTarget, ...(value.zeroTarget || {}) },
    transitions: value.transitions && typeof value.transitions === "object" && !Array.isArray(value.transitions)
      ? value.transitions : {},
    history: Array.isArray(value.history) ? value.history.slice(-50) : [],
  };
  pruneTransitions(normalized);
  return normalized;
}

async function readJson(file, fsImpl = fs) {
  try {
    const parsed = JSON.parse(await fsImpl.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { status: "ok", value: parsed }
      : { status: "unreadable", value: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", value: null };
    return { status: "unreadable", value: null };
  }
}

export async function atomicWriteFomoHealthState(file, value, fsImpl = fs) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fileHandle = null;
  let directoryHandle = null;
  let renamed = false;
  try {
    fileHandle = await fsImpl.open(temporary, "wx", 0o600);
    await fileHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;
    await fsImpl.rename(temporary, file);
    renamed = true;
    await fsImpl.chmod(file, 0o600);
    directoryHandle = await fsImpl.open(path.dirname(file), "r");
    await directoryHandle.sync();
    await directoryHandle.close();
    directoryHandle = null;
  } catch (error) {
    if (fileHandle) await fileHandle.close().catch(() => {});
    if (directoryHandle) await directoryHandle.close().catch(() => {});
    if (!renamed && typeof fsImpl.rm === "function") await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function stateFreshness(record, nowMs, maximumAgeMs) {
  if (record.status !== "ok") return { fresh: false, checkedAt: null };
  const checkedAt = parsedInstant(record.value?.health?.checkedAt, nowMs);
  return {
    fresh: checkedAt !== null && nowMs - checkedAt <= maximumAgeMs,
    checkedAt,
  };
}

function smartTelemetry(callState) {
  const publicOnchain = callState?.publicOnchain || {};
  const smart = publicOnchain.smartMoney || {};
  const coverage = publicOnchain.coverage?.smartMoney
    || callState?.coverageSummary?.chainCoverage?.smartMoney
    || {};
  const qualification = smart.qualificationCoverage || {};
  const profileFreshness = callState?.coverageSummary?.profileFreshness || {};
  const statsError = String(smart.statsError || "").trim();
  return {
    feed: String(smart.feedStatus || coverage.feed || "unknown").toLowerCase(),
    feedCheckedAt: smart.feedCheckedAt || null,
    stats: String(smart.statsStatus || coverage.stats || "unknown").toLowerCase(),
    qualification: String(qualification.status || coverage.qualification || profileFreshness.status || "unknown").toLowerCase(),
    exactTrades: String(smart.exactTradeStatus || coverage.exactTrades || "unknown").toLowerCase(),
    admitted: boundedCount(coverage.admitted ?? smart.admittedWallets?.length ?? callState?.coverageSummary?.monitoredTopCount),
    fresh: boundedCount(qualification.fresh ?? coverage.fresh ?? profileFreshness.fresh),
    lastKnownGood: boundedCount(qualification.lastKnownGood ?? coverage.lastKnownGood ?? profileFreshness.stale),
    statsEmptyOnly: !statsError || statsError === "no fresh or last-known-good qualified wallets",
  };
}

function evaluateCallState(config, record, nowMs, maximumAgeMs, summary, severeReasons) {
  const smartEnabled = config.fomoSmartMoneyMonitorEnabled === true || config.fomoBuyMonitorEnabled === true;
  if (!smartEnabled) return { callCheckedAt: null, zeroTargets: false };

  if (record.status !== "ok") {
    summary.smartMoney.status = "critical";
    summary.bsc.status = "critical";
    severeReasons.add(record.status === "missing" ? "call_state_missing" : "call_state_unreadable");
    return { callCheckedAt: null, zeroTargets: false };
  }

  const telemetry = smartTelemetry(record.value);
  summary.smartMoney = {
    status: "healthy",
    admitted: telemetry.admitted,
    fresh: telemetry.fresh,
    lastKnownGood: telemetry.lastKnownGood,
  };
  const freshness = stateFreshness(record, nowMs, maximumAgeMs);
  if (!freshness.fresh) {
    summary.smartMoney.status = "critical";
    summary.bsc.status = "critical";
    severeReasons.add("call_state_stale");
    return { callCheckedAt: freshness.checkedAt, zeroTargets: false };
  }

  const acceptedFeed = new Set(["healthy", "empty"]);
  const acceptedExact = new Set(["healthy", "not_configured"]);
  const acceptedStats = new Set(["healthy"]);
  const feedCheckedAt = parsedInstant(telemetry.feedCheckedAt, nowMs);
  if (telemetry.feed === "unknown" || telemetry.stats === "unknown" || telemetry.qualification === "unknown") {
    summary.smartMoney.status = "critical";
    severeReasons.add("smart_telemetry_missing");
  }
  if (!acceptedFeed.has(telemetry.feed)
    || feedCheckedAt === null
    || nowMs - feedCheckedAt > maximumAgeMs) {
    summary.smartMoney.status = "critical";
    severeReasons.add("smart_feed_unhealthy");
  }
  if (!acceptedStats.has(telemetry.stats)) {
    const emptyQualification = telemetry.admitted === 0
      && telemetry.qualification === "empty"
      && telemetry.statsEmptyOnly;
    if (emptyQualification || telemetry.fresh > 0) {
      if (summary.smartMoney.status === "healthy") summary.smartMoney.status = "degraded";
    } else {
      summary.smartMoney.status = "critical";
      severeReasons.add("smart_stats_unhealthy");
    }
  }
  if (!acceptedExact.has(telemetry.exactTrades)) {
    summary.smartMoney.status = "critical";
    severeReasons.add("smart_exact_trade_unhealthy");
  }
  if (telemetry.qualification === "last_known_good") {
    if (telemetry.fresh > 0) {
      if (summary.smartMoney.status === "healthy") summary.smartMoney.status = "degraded";
    } else summary.smartMoney.status = "critical";
    if (telemetry.fresh === 0) severeReasons.add("smart_no_fresh_profiles");
  } else if (telemetry.qualification === "empty" && telemetry.admitted === 0) {
    if (telemetry.statsEmptyOnly) {
      if (summary.smartMoney.status === "healthy") summary.smartMoney.status = "degraded";
    } else summary.smartMoney.status = "critical";
    if (!telemetry.statsEmptyOnly) severeReasons.add("smart_stats_unhealthy");
  } else if (telemetry.qualification !== "healthy" && telemetry.qualification !== "fresh") {
    summary.smartMoney.status = "critical";
    severeReasons.add("smart_stats_unhealthy");
  }

  const bscCoverage = String(
    record.value?.publicOnchain?.coverage?.bsc
      || record.value?.coverageSummary?.chainCoverage?.bsc
      || "unknown",
  ).toLowerCase();
  summary.bsc.status = bscCoverage === "healthy" ? "healthy" : "critical";
  if (bscCoverage !== "healthy" && !(telemetry.admitted === 0 && bscCoverage === "not_configured")) {
    severeReasons.add("bsc_unhealthy");
  } else if (bscCoverage !== "healthy") {
    summary.bsc.status = "degraded";
  }

  const zeroTargets = telemetry.admitted === 0;
  if (zeroTargets && summary.smartMoney.status === "healthy") summary.smartMoney.status = "degraded";
  return { callCheckedAt: freshness.checkedAt, zeroTargets };
}

function evaluateXState(config, record, nowMs, maximumAgeMs, summary, severeReasons) {
  if (config.fomoXCallEnabled !== true) return;
  if (record.status !== "ok") {
    summary.x.status = "critical";
    severeReasons.add(record.status === "missing" ? "x_state_missing" : "x_state_unreadable");
    return;
  }
  const health = record.value.health || {};
  const coverage = health.coverage || {};
  const eligible = boundedCount(coverage.eligibleCount ?? health.eligibleCount);
  const live = boundedCount(coverage.liveCount ?? health.liveCount ?? health.activeCount);
  summary.x.eligible = eligible;
  summary.x.live = eligible ? Math.min(live, eligible) : 0;
  const freshness = stateFreshness(record, nowMs, maximumAgeMs);
  if (!freshness.fresh) {
    summary.x.status = "critical";
    severeReasons.add("x_state_stale");
    return;
  }
  if (eligible === 0) {
    summary.x.status = "critical";
    severeReasons.add("x_no_eligible_targets");
    return;
  }
  if (live === 0) {
    summary.x.status = "critical";
    severeReasons.add("x_no_live_targets");
    return;
  }
  const ratio = live / eligible;
  if (ratio < 0.5) {
    summary.x.status = "critical";
    severeReasons.add("x_low_live_coverage");
  } else if (ratio < 1 || String(health.status || "").toLowerCase() === "degraded") {
    // A single-handle transport wobble remains visible in state but is not an
    // incident trigger. Only loss of at least half the effective live roster
    // is severe enough to open a Telegram transition.
    summary.x.status = "degraded";
  } else {
    summary.x.status = "healthy";
  }
}

function evaluateThesisState(config, record, nowMs, maximumAgeMs, summary, severeReasons) {
  if (config.fomoPublishedCallEnabled !== true) return;
  if (record.status !== "ok") {
    summary.thesis.status = "critical";
    severeReasons.add(record.status === "missing" ? "thesis_state_missing" : "thesis_state_unreadable");
    return;
  }
  const freshness = stateFreshness(record, nowMs, maximumAgeMs);
  if (!freshness.fresh) {
    summary.thesis.status = "critical";
    severeReasons.add("thesis_state_stale");
    return;
  }
  const status = String(record.value?.health?.status || "unknown").trim().toLowerCase();
  if (status === "healthy" || status === "healthy_no_updates") {
    summary.thesis.status = "healthy";
  } else if (status === "blocked_missing_credentials") {
    summary.thesis.status = "critical";
    severeReasons.add("thesis_blocked");
  } else {
    summary.thesis.status = "critical";
    severeReasons.add("thesis_unhealthy");
  }
}

function evaluateFomoOutbox(config, record, nowMs, summary, severeReasons) {
  if (record.status === "missing") return;
  if (record.status !== "ok") {
    summary.outbox.status = "critical";
    severeReasons.add("fomo_outbox_unreadable");
    return;
  }
  const embedded = config.fomoCallStandalone === false;
  const scopedEntries = Object.values(record.value?.events || {})
    .filter((entry) => !embedded || FOMO_OUTBOX_EVENT_TYPES.has(String(entry?.event?.type || "")));
  const unresolved = scopedEntries
    .filter((entry) => !["delivered", "suppressed"].includes(String(entry?.status || "").toLowerCase()));
  const failed = unresolved.filter((entry) => Object.values(entry?.destinations || {})
    .some((destination) => String(destination?.status || "").toLowerCase() === "failed"));
  const oldestAt = unresolved.reduce((oldest, entry) => {
    const createdAt = parsedInstant(entry?.createdAt || entry?.updatedAt, nowMs);
    return createdAt === null ? oldest : Math.min(oldest, createdAt);
  }, nowMs);
  const ageMs = unresolved.length ? Math.max(0, nowMs - oldestAt) : 0;
  const oldestFailedAt = failed.reduce((oldest, entry) => {
    const failedDestinations = Object.values(entry?.destinations || {})
      .filter((destination) => String(destination?.status || "").toLowerCase() === "failed");
    const entryFailedAt = failedDestinations.reduce((candidate, destination) => {
      const timestamp = parsedInstant(destination?.lastAttemptAt || destination?.updatedAt, nowMs);
      return timestamp === null ? candidate : (candidate === null ? timestamp : Math.min(candidate, timestamp));
    }, null);
    const fallback = parsedInstant(entry?.updatedAt || entry?.createdAt, nowMs);
    const candidate = entryFailedAt ?? fallback ?? nowMs;
    return Math.min(oldest, candidate);
  }, nowMs);
  const failedAgeMsObserved = failed.length ? Math.max(0, nowMs - oldestFailedAt) : 0;
  const failedAgeMs = finiteInteger(config.fomoHealthOutboxFailedAgeMs, 120_000, 1_000);
  const pendingAgeMs = finiteInteger(config.fomoHealthOutboxPendingAgeMs, 300_000, 1_000);
  summary.outbox.pending = boundedCount(unresolved.length);
  summary.outbox.failed = boundedCount(failed.length);
  if (failed.length && failedAgeMsObserved >= failedAgeMs) {
    summary.outbox.status = "critical";
    severeReasons.add("fomo_outbox_failed");
  } else if (unresolved.length && ageMs >= pendingAgeMs) {
    summary.outbox.status = "critical";
    severeReasons.add("fomo_outbox_backlog");
  } else if (unresolved.length && ageMs >= Math.min(60_000, pendingAgeMs)) {
    summary.outbox.status = "degraded";
  }
}

function aggregateLevel(summary, severeReasons) {
  if (severeReasons.size) return "critical";
  return Object.values(summary).some((lane) => lane.status === "degraded" || lane.status === "critical")
    ? "degraded" : "healthy";
}

export function evaluateFomoHealthRecords(config, records, nowMs = Date.now()) {
  const summary = emptySummary();
  const severeReasons = new Set();
  const maximumAgeMs = finiteInteger(config.fomoHealthStateStaleMs, 180_000, 30_000);
  const missing = { status: "missing", value: null };
  const call = evaluateCallState(config, records?.call || missing, nowMs, maximumAgeMs, summary, severeReasons);
  evaluateXState(config, records?.x || missing, nowMs, maximumAgeMs, summary, severeReasons);
  evaluateThesisState(config, records?.thesis || missing, nowMs, maximumAgeMs, summary, severeReasons);
  evaluateFomoOutbox(config, records?.outbox || missing, nowMs, summary, severeReasons);
  return {
    status: aggregateLevel(summary, severeReasons),
    summary,
    severeReasons: [...severeReasons].sort(),
    callCheckedAt: call.callCheckedAt === null ? null : iso(call.callCheckedAt),
    zeroTargets: call.zeroTargets,
  };
}

function incidentId(firstObservedAt) {
  return `aggregate-${Math.max(0, Math.floor(firstObservedAt))}`;
}

function criticalLanes(summary) {
  return Object.entries(summary || {})
    .filter(([, lane]) => lane?.status === "critical")
    .map(([lane]) => lane)
    .sort();
}

function healthReasonDigest(reasonCodes, summary) {
  return createHash("sha256")
    .update(JSON.stringify({
      reasonCodes: [...new Set(reasonCodes)].sort(),
      criticalLanes: criticalLanes(summary),
    }))
    .digest("hex")
    .slice(0, 16);
}

function buildTransitionEvent(incident, transition, snapshot, nowMs, reasonCodes) {
  const eventIncidentId = incident.id;
  const eventReasonCodes = [...new Set(reasonCodes)].sort().slice(0, 20);
  const reasonDigest = transition === "updated" ? healthReasonDigest(eventReasonCodes, snapshot.summary) : null;
  return {
    type: "fomo_monitor_health_update",
    eventKey: transition === "updated"
      ? `fomo-health:${eventIncidentId}:updated:${reasonDigest}`
      : `fomo-health:${eventIncidentId}:${transition}`,
    lane: "aggregate",
    transition,
    incidentId: eventIncidentId,
    ...(reasonDigest ? { reasonDigest } : {}),
    aggregateStatus: transition === "recovered" ? "healthy" : "critical",
    observedAt: iso(nowMs),
    openedAt: incident.openedAt,
    durationMs: Math.max(0, nowMs - Date.parse(incident.openedAt)),
    reasonCodes: eventReasonCodes,
    summary: structuredClone(snapshot.summary),
    source: { id: SOURCE_ID, trust: SOURCE_TRUST },
    sourceTrust: SOURCE_TRUST,
    strong: false,
  };
}

function queueTransition(state, event, nowMs) {
  if (state.transitions[event.eventKey]) return false;
  state.transitions[event.eventKey] = {
    event,
    status: "pending",
    attempts: 0,
    queuedAt: iso(nowMs),
    nextAttemptAt: null,
  };
  state.history.push({
    eventKey: event.eventKey,
    incidentId: event.incidentId,
    transition: event.transition,
    queuedAt: iso(nowMs),
  });
  state.history = state.history.slice(-50);
  pruneTransitions(state);
  return true;
}

function updateZeroTargetGuard(state, snapshot, nowMs, config) {
  if (!snapshot.zeroTargets || !snapshot.callCheckedAt) {
    state.zeroTarget = initialState(nowMs).zeroTarget;
    return false;
  }
  if (!state.zeroTarget.firstObservedAt) state.zeroTarget.firstObservedAt = iso(nowMs);
  if (state.zeroTarget.lastCallCheckedAt !== snapshot.callCheckedAt) {
    state.zeroTarget.sourceCycles = boundedCount(state.zeroTarget.sourceCycles) + 1;
    state.zeroTarget.lastCallCheckedAt = snapshot.callCheckedAt;
  }
  const firstObservedAt = Date.parse(state.zeroTarget.firstObservedAt || "");
  const requiredCycles = finiteInteger(config.fomoHealthZeroTargetCycles, 2, 2);
  const requiredAgeMs = finiteInteger(config.fomoHealthZeroTargetAgeMs, 300_000, 60_000);
  return Number.isFinite(firstObservedAt)
    && nowMs - firstObservedAt >= requiredAgeMs
    && state.zeroTarget.sourceCycles >= requiredCycles;
}

function applyIncidentState(config, state, snapshot, nowMs) {
  if (updateZeroTargetGuard(state, snapshot, nowMs, config)) {
    snapshot.severeReasons = [...new Set([...snapshot.severeReasons, "smart_zero_targets"])].sort();
    snapshot.summary.smartMoney.status = "critical";
    snapshot.status = "critical";
  }
  const severe = snapshot.severeReasons.length > 0;
  const openConsecutive = finiteInteger(config.fomoHealthOpenConsecutive, 3, 3);
  const openAgeMs = finiteInteger(config.fomoHealthOpenAgeMs, 90_000, 60_000);
  const recoveryConsecutive = finiteInteger(config.fomoHealthRecoveryConsecutive, 2, 2);
  const recoveryAgeMs = finiteInteger(config.fomoHealthRecoveryAgeMs, 60_000, 60_000);

  if (severe) {
    state.recovery = null;
    if (state.activeIncident) {
      state.activeIncident.lastObservedAt = iso(nowMs);
      state.activeIncident.lastReasonCodes = snapshot.severeReasons;
      const announcedReasons = new Set(state.activeIncident.announcedReasonCodes
        || state.activeIncident.openingReasonCodes || []);
      const announcedLanes = new Set(state.activeIncident.announcedCriticalLanes || []);
      const currentLanes = criticalLanes(snapshot.summary);
      const expanded = snapshot.severeReasons.some((reason) => !announcedReasons.has(reason))
        || currentLanes.some((lane) => !announcedLanes.has(lane));
      if (!expanded) {
        state.activeIncident.expansion = null;
        return;
      }
      const signature = healthReasonDigest(snapshot.severeReasons, snapshot.summary);
      if (state.activeIncident.expansion?.signature !== signature) {
        state.activeIncident.expansion = {
          signature,
          firstObservedAt: iso(nowMs),
          lastObservedAt: iso(nowMs),
          consecutive: 1,
          reasonCodes: snapshot.severeReasons,
          criticalLanes: currentLanes,
        };
      } else {
        state.activeIncident.expansion.consecutive = boundedCount(state.activeIncident.expansion.consecutive) + 1;
        state.activeIncident.expansion.lastObservedAt = iso(nowMs);
      }
      const expansionAt = Date.parse(state.activeIncident.expansion.firstObservedAt || "");
      if (state.activeIncident.expansion.consecutive < openConsecutive
        || !Number.isFinite(expansionAt)
        || nowMs - expansionAt < openAgeMs) return;
      queueTransition(
        state,
        buildTransitionEvent(state.activeIncident, "updated", snapshot, nowMs, snapshot.severeReasons),
        nowMs,
      );
      state.activeIncident.announcedReasonCodes = [...new Set([
        ...announcedReasons,
        ...snapshot.severeReasons,
      ])].sort();
      state.activeIncident.announcedCriticalLanes = [...new Set([
        ...announcedLanes,
        ...currentLanes,
      ])].sort();
      state.activeIncident.expansion = null;
      return;
    }
    if (!state.candidate) {
      state.candidate = {
        id: incidentId(nowMs),
        firstObservedAt: iso(nowMs),
        lastObservedAt: iso(nowMs),
        consecutive: 1,
        reasonCodes: snapshot.severeReasons,
      };
    } else {
      state.candidate.consecutive = boundedCount(state.candidate.consecutive) + 1;
      state.candidate.lastObservedAt = iso(nowMs);
      state.candidate.reasonCodes = snapshot.severeReasons;
    }
    const candidateAt = Date.parse(state.candidate.firstObservedAt || "");
    if (state.candidate.consecutive < openConsecutive
      || !Number.isFinite(candidateAt)
      || nowMs - candidateAt < openAgeMs) return;
    const active = {
      id: state.candidate.id,
      firstObservedAt: state.candidate.firstObservedAt,
      openedAt: iso(nowMs),
      lastObservedAt: iso(nowMs),
      openingReasonCodes: snapshot.severeReasons,
      lastReasonCodes: snapshot.severeReasons,
      announcedReasonCodes: snapshot.severeReasons,
      announcedCriticalLanes: criticalLanes(snapshot.summary),
      expansion: null,
    };
    state.activeIncident = active;
    state.candidate = null;
    queueTransition(state, buildTransitionEvent(active, "opened", snapshot, nowMs, snapshot.severeReasons), nowMs);
    return;
  }

  state.candidate = null;
  if (!state.activeIncident) {
    state.recovery = null;
    return;
  }
  if (snapshot.status !== "healthy") {
    state.recovery = null;
    return;
  }
  if (!state.recovery) {
    state.recovery = { firstObservedAt: iso(nowMs), consecutive: 1 };
  } else {
    state.recovery.consecutive = boundedCount(state.recovery.consecutive) + 1;
  }
  const recoveryAt = Date.parse(state.recovery.firstObservedAt || "");
  if (state.recovery.consecutive < recoveryConsecutive
    || !Number.isFinite(recoveryAt)
    || nowMs - recoveryAt < recoveryAgeMs) return;
  const active = state.activeIncident;
  const recoveryEvent = buildTransitionEvent(
    active,
    "recovered",
    snapshot,
    nowMs,
    active.announcedReasonCodes || active.openingReasonCodes || [],
  );
  queueTransition(state, recoveryEvent, nowMs);
  state.activeIncident = null;
  state.recovery = null;
}

function acceptedDelivery(result) {
  return ["delivered", "queued"].includes(String(result?.status || "").toLowerCase())
    || isTerminalAlertSuppression(result);
}

export function createFomoHealthMonitor(config, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const sendAlert = dependencies.sendAlertsImpl || sendAlerts;
  const now = dependencies.now || Date.now;
  const logger = dependencies.logger || console;
  const stateFile = String(config.fomoHealthStateFile
    || path.join(config.dataDir, "fomo-health-watchdog-state.json"));
  const files = {
    call: path.join(config.dataDir, "fomo-call-state.json"),
    x: path.join(config.dataDir, "fomo-x-call-state.json"),
    thesis: path.join(config.dataDir, "fomo-thesis-state.json"),
    outbox: config.fomoCallStandalone === false
      ? path.join(config.dataDir, "alert-outbox.json")
      : path.join(config.dataDir, "fomo-alerts", "alert-outbox.json"),
  };
  const intervalMs = finiteInteger(config.fomoHealthPollIntervalMs, 30_000, 1_000);
  const retryMs = finiteInteger(config.fomoHealthDeliveryRetryMs, 30_000, 1_000);
  let state = null;
  let serial = Promise.resolve();
  let timer = null;
  let stopped = false;
  let stopPromise = null;

  async function ensureState() {
    if (state) return state;
    const loaded = await readJson(stateFile, fsImpl);
    state = normalizeState(loaded.status === "ok" ? loaded.value : null, Number(now()));
    return state;
  }

  async function persist() {
    await atomicWriteFomoHealthState(stateFile, state, fsImpl);
  }

  async function inspect(nowMs) {
    const [call, x, thesis, outbox] = await Promise.all([
      readJson(files.call, fsImpl),
      readJson(files.x, fsImpl),
      readJson(files.thesis, fsImpl),
      readJson(files.outbox, fsImpl),
    ]);
    return evaluateFomoHealthRecords(config, { call, x, thesis, outbox }, nowMs);
  }

  async function flushTransitions(nowMs) {
    for (const eventKey of Object.keys(state.transitions || {})) {
      let transition = state.transitions[eventKey];
      if (transition?.status !== "pending") continue;
      const nextAttemptAt = Date.parse(transition.nextAttemptAt || "");
      if (Number.isFinite(nextAttemptAt) && nextAttemptAt > nowMs) continue;
      const beforeAttempt = structuredClone(state);
      transition.attempts = boundedCount(transition.attempts) + 1;
      transition.lastAttemptAt = iso(nowMs);
      transition.nextAttemptAt = iso(nowMs + retryMs);
      try {
        await persist();
      } catch (error) {
        state = beforeAttempt;
        throw error;
      }
      const event = structuredClone(transition.event);
      const beforeDisposition = structuredClone(state);
      let result = null;
      try {
        result = await sendAlert(config, event);
      } catch {
        result = null;
      }
      transition = state.transitions[eventKey];
      if (acceptedDelivery(result)) {
        transition.status = "submitted";
        transition.submittedAt = iso(Number(now()));
        transition.nextAttemptAt = null;
        transition.deliveryDisposition = String(result?.status || "accepted").slice(0, 32);
      } else transition.deliveryDisposition = "retry_pending";
      try {
        await persist();
      } catch (error) {
        state = beforeDisposition;
        throw error;
      }
    }
  }

  async function runCheck() {
    await ensureState();
    const nowMs = Number(now());
    const snapshot = await inspect(nowMs);
    const beforeObservation = structuredClone(state);
    applyIncidentState(config, state, snapshot, nowMs);
    state.lastCheckedAt = iso(nowMs);
    state.lastAggregateStatus = normalizedLevel(snapshot.status);
    state.lastSummary = structuredClone(snapshot.summary);
    state.lastReasonCodes = snapshot.severeReasons;
    pruneTransitions(state);
    try {
      await persist();
    } catch (error) {
      state = beforeObservation;
      throw error;
    }
    await flushTransitions(nowMs);
    return {
      status: snapshot.status,
      summary: snapshot.summary,
      severeReasons: snapshot.severeReasons,
      activeIncident: state.activeIncident?.id || null,
      pendingTransitions: Object.values(state.transitions).filter((item) => item.status === "pending").length,
    };
  }

  const check = () => {
    const current = serial.catch(() => {}).then(runCheck);
    serial = current.catch(() => {});
    return current;
  };

  function start() {
    if (timer || stopped || config.fomoHealthMonitorEnabled === false) return;
    void check().catch((error) => logger.error?.(`[fomo-health] check: ${String(error?.message || error).slice(0, 160)}`));
    timer = setInterval(() => {
      void check().catch((error) => logger.error?.(`[fomo-health] check: ${String(error?.message || error).slice(0, 160)}`));
    }, intervalMs);
    timer.unref?.();
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    stopPromise = serial.catch(() => {}).then(() => undefined);
    return stopPromise;
  }

  if (dependencies.autoStart !== false) start();
  return { check, stop, stateFile, files };
}
