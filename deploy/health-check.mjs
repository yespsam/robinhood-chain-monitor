import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_DATA_DIR = "/var/lib/robinhood-chain-monitor";
const DEFAULT_CONFIG_DIR = "/etc/robinhood-chain-monitor";
// Keep this in lockstep with STATE_VERSION in src/bsc-launchpad-monitor.js.
// The health reader must reject a checkpoint the production reader cannot
// restart from, rather than reporting fresh-but-incompatible state as healthy.
const BSC_STATE_VERSION = 6;
const TERMINAL_OUTBOX_STATUSES = new Set(["delivered", "suppressed"]);
const TERMINAL_DESTINATION_STATUSES = new Set(["delivered", "disabled"]);
const SOURCE_LIMITED_STATUSES = new Set([
  "backoff",
  "blocked",
  "blocked_missing_credentials",
  "blocked_no_handles",
  "degraded",
  "partial",
  "rate_limited",
  "source_limited",
  "unavailable",
  "waf_blocked",
]);
const EXPLICIT_UPSTREAM_BACKOFF_STATUSES = new Set([
  "backoff",
  "blocked",
  "blocked_missing_credentials",
  "blocked_no_handles",
  "rate_limited",
  "source_limited",
  "transport_backoff",
  "waf_blocked",
]);

function positiveInteger(env, name, fallback) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function booleanSetting(env, name, fallback) {
  const raw = String(env[name] ?? fallback).trim().toLowerCase();
  if (["true", "1", "yes"].includes(raw)) return true;
  if (["false", "0", "no"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

export function buildHealthSettings(env = process.env) {
  return {
    dataDir: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR),
    configDir: path.resolve(env.HEALTH_CONFIG_DIR || DEFAULT_CONFIG_DIR),
    limits: {
      robinhoodAgeSeconds: positiveInteger(env, "HEALTH_ROBINHOOD_MAX_AGE_SECONDS", 180),
      binanceAgeSeconds: positiveInteger(env, "HEALTH_BINANCE_MAX_AGE_SECONDS", 180),
      bscAgeSeconds: positiveInteger(env, "HEALTH_BSC_MAX_AGE_SECONDS", 180),
      githubAgeSeconds: positiveInteger(env, "HEALTH_GITHUB_MAX_AGE_SECONDS", 180),
      platformCapabilityAgeSeconds: positiveInteger(env, "HEALTH_PLATFORM_CAPABILITY_MAX_AGE_SECONDS", 180),
      fomoStateAgeSeconds: positiveInteger(env, "HEALTH_FOMO_STATE_MAX_AGE_SECONDS", 180),
      fomoCheckpointAgeSeconds: positiveInteger(env, "HEALTH_FOMO_CHECKPOINT_MAX_AGE_SECONDS", 900),
      fomoXAgeSeconds: positiveInteger(env, "HEALTH_FOMO_X_MAX_AGE_SECONDS", 180),
      fomoThesisAgeSeconds: positiveInteger(env, "HEALTH_FOMO_THESIS_MAX_AGE_SECONDS", 180),
      outboxPendingAgeSeconds: positiveInteger(env, "HEALTH_OUTBOX_MAX_PENDING_AGE_SECONDS", 60),
      heartbeatTimeoutMs: positiveInteger(env, "HEALTH_HEARTBEAT_TIMEOUT_MS", 5_000),
    },
    requirements: {
      fomoState: booleanSetting(env, "HEALTH_REQUIRE_FOMO_STATE", true),
      fomoCheckpoint: booleanSetting(env, "HEALTH_REQUIRE_FOMO_CHECKPOINT", true),
      fomoX: booleanSetting(env, "HEALTH_REQUIRE_FOMO_X", true),
      fomoThesis: booleanSetting(env, "HEALTH_REQUIRE_FOMO_THESIS", true),
      externalHeartbeat: booleanSetting(env, "HEALTH_REQUIRE_EXTERNAL_HEARTBEAT", true),
    },
    policy: {
      heartbeatRequireCoverageComplete: booleanSetting(
        env,
        "HEALTH_HEARTBEAT_REQUIRE_COVERAGE_COMPLETE",
        false,
      ),
    },
    heartbeatUrl: String(env.HEALTH_HEARTBEAT_URL || "").trim(),
  };
}

function normalizedStatus(value, fallback = "unknown") {
  const status = String(value || "").trim().toLowerCase();
  return status || fallback;
}

function finiteCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

function parsedInstant(value, nowMs) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed <= nowMs + 60_000 ? parsed : null;
}

function isoOrNull(value, nowMs) {
  const parsed = parsedInstant(value, nowMs);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function ageSeconds(timestampMs, nowMs) {
  return timestampMs === null ? null : Math.max(0, Math.floor((nowMs - timestampMs) / 1_000));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function bounded(values, maximum = 20) {
  return unique(values).slice(0, maximum);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

async function readTrimmed(filename) {
  try {
    return (await fs.readFile(filename, "utf8")).trim();
  } catch {
    return null;
  }
}

async function systemdServiceState(unit) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/systemctl", ["is-active", unit], {
      timeout: 5_000,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch (error) {
    return String(error?.stdout || "unknown").trim() || "unknown";
  }
}

async function fileStat(filename, nowMs) {
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile()) return { exists: false, ageSeconds: null, mtimeAt: null, mtimeMs: null };
    return {
      exists: true,
      ageSeconds: ageSeconds(stat.mtimeMs, nowMs),
      mtimeAt: new Date(stat.mtimeMs).toISOString(),
      mtimeMs: stat.mtimeMs,
      inode: stat.ino,
      size: stat.size,
    };
  } catch {
    return { exists: false, ageSeconds: null, mtimeAt: null, mtimeMs: null };
  }
}

async function readJsonRecord(dataDir, relativeFilename, nowMs) {
  const filename = path.join(dataDir, relativeFilename);
  const stat = await fileStat(filename, nowMs);
  if (!stat.exists) return { file: relativeFilename, ...stat, value: null, parseError: "missing" };
  try {
    const value = JSON.parse(await fs.readFile(filename, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { file: relativeFilename, ...stat, value: null, parseError: "not_an_object" };
    }
    return { file: relativeFilename, ...stat, value, parseError: null };
  } catch {
    return { file: relativeFilename, ...stat, value: null, parseError: "invalid_json" };
  }
}

async function readTextRecord(dataDir, relativeFilename, nowMs) {
  const filename = path.join(dataDir, relativeFilename);
  const stat = await fileStat(filename, nowMs);
  if (!stat.exists) return { file: relativeFilename, ...stat, value: null, parseError: "missing" };
  try {
    return { file: relativeFilename, ...stat, value: await fs.readFile(filename, "utf8"), parseError: null };
  } catch {
    return { file: relativeFilename, ...stat, value: null, parseError: "unreadable" };
  }
}

function publicObservation(record) {
  return {
    file: record.file,
    ageSeconds: record.ageSeconds,
    mtimeAt: record.mtimeAt,
    present: record.exists ?? record.present,
    parseError: record.parseError,
  };
}

function freshestObservation(records) {
  return records
    .filter((record) => record.exists ?? record.present)
    .sort((left, right) => (left.ageSeconds ?? Infinity) - (right.ageSeconds ?? Infinity))[0] || null;
}

function validWalPath(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 32
    && value.every((item) => typeof item === "string"
      && item.length > 0
      && !["__proto__", "prototype", "constructor"].includes(item));
}

function applyWalOperation(state, operation) {
  let parent = state;
  for (const part of operation.path.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || Array.isArray(parent) || !Object.hasOwn(parent, part)) {
      throw new Error("invalid_wal_path");
    }
    parent = parent[part];
  }
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
    throw new Error("invalid_wal_parent");
  }
  const key = operation.path.at(-1);
  if (operation.op === "delete") {
    if (!Object.hasOwn(parent, key)) throw new Error("missing_wal_delete_target");
    delete parent[key];
  } else parent[key] = structuredClone(operation.value);
}

function replayBscWal(snapshot, rawWal) {
  const parsedVersion = snapshot?.version ?? 0;
  if (!Number.isInteger(parsedVersion) || parsedVersion < 0 || parsedVersion > BSC_STATE_VERSION) {
    const error = new Error("unsupported_bsc_state_version");
    error.code = "unsupported_bsc_state_version";
    throw error;
  }
  // Production migrates every supported legacy snapshot to the current
  // version before applying modern WAL frames.
  snapshot.version = BSC_STATE_VERSION;
  if (rawWal === null) return snapshot;
  const snapshotRevision = Number(snapshot?.journalRevision ?? 0);
  if (!Number.isSafeInteger(snapshotRevision) || snapshotRevision < 0) throw new Error("invalid_snapshot_revision");
  const finalNewline = rawWal.endsWith("\n");
  const complete = finalNewline ? rawWal : rawWal.slice(0, Math.max(0, rawWal.lastIndexOf("\n") + 1));
  const lines = complete.split("\n").filter(Boolean);
  let appliedRevision = snapshotRevision;
  let previousFrameRevision = 0;
  const checksums = new Map();
  for (const line of lines) {
    let frame;
    try { frame = JSON.parse(line); } catch { throw new Error("invalid_wal_json"); }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)
      || frame.version !== 1
      || !Number.isSafeInteger(frame.revision) || frame.revision <= 0
      || !Array.isArray(frame.ops)
      || !Number.isSafeInteger(frame.payloadLength) || frame.payloadLength < 0
      || !/^[0-9a-f]{64}$/.test(String(frame.sha256 || ""))) throw new Error("invalid_wal_frame");
    let revisionOperations = 0;
    const paths = new Set();
    for (const operation of frame.ops) {
      if (!operation || !["set", "delete"].includes(operation.op) || !validWalPath(operation.path)
        || (operation.op === "set" && !Object.hasOwn(operation, "value"))) throw new Error("invalid_wal_operation");
      const operationKey = operation.path.join("\u0000");
      if (paths.has(operationKey)) throw new Error("duplicate_wal_path");
      paths.add(operationKey);
      if (operation.path.length === 1 && operation.path[0] === "journalRevision") {
        revisionOperations += 1;
        if (operation.op !== "set" || operation.value !== frame.revision) throw new Error("invalid_wal_revision_operation");
      }
    }
    if (revisionOperations !== 1) throw new Error("missing_wal_revision_operation");
    const payload = JSON.stringify({ version: frame.version, revision: frame.revision, ops: frame.ops });
    const checksum = createHash("sha256").update(payload).digest("hex");
    if (Buffer.byteLength(payload) !== frame.payloadLength || checksum !== frame.sha256) throw new Error("invalid_wal_checksum");
    if (frame.revision < previousFrameRevision) throw new Error("wal_out_of_order");
    previousFrameRevision = frame.revision;
    const prior = checksums.get(frame.revision);
    if (prior && prior !== checksum) throw new Error("wal_revision_conflict");
    if (prior) continue;
    checksums.set(frame.revision, checksum);
    if (frame.revision <= snapshotRevision) continue;
    if (frame.revision !== appliedRevision + 1) throw new Error("wal_revision_gap");
    for (const operation of frame.ops) applyWalOperation(snapshot, operation);
    if (snapshot.journalRevision !== frame.revision) throw new Error("wal_state_revision_mismatch");
    appliedRevision = frame.revision;
  }
  snapshot.journalRevision = appliedRevision;
  if (!Number.isInteger(snapshot.version) || snapshot.version < 0 || snapshot.version > BSC_STATE_VERSION) {
    const error = new Error("unsupported_bsc_state_version");
    error.code = "unsupported_bsc_state_version";
    throw error;
  }
  return snapshot;
}

async function readBscRecord(dataDir, nowMs) {
  // A snapshot compaction is ordered as snapshot rename -> WAL reset. Read the
  // pair sequentially and retry if the snapshot identity changed while the WAL
  // was being read; otherwise an old open snapshot plus a newly reset WAL could
  // briefly look like a cursor regression.
  let snapshot = await readJsonRecord(dataDir, "bsc-launchpad-state.json", nowMs);
  let wal = await readTextRecord(dataDir, "bsc-launchpad-state.json.wal", nowMs);
  const snapshotAfterWal = await fileStat(path.join(dataDir, "bsc-launchpad-state.json"), nowMs);
  if (snapshotAfterWal.exists && (
    snapshotAfterWal.inode !== snapshot.inode
    || snapshotAfterWal.mtimeMs !== snapshot.mtimeMs
    || snapshotAfterWal.size !== snapshot.size
  )) {
    snapshot = await readJsonRecord(dataDir, "bsc-launchpad-state.json", nowMs);
    wal = await readTextRecord(dataDir, "bsc-launchpad-state.json.wal", nowMs);
  }
  const records = [snapshot, wal];
  const authoritative = freshestObservation(records);
  if (snapshot.parseError) {
    return {
      ...snapshot,
      ageSeconds: authoritative?.ageSeconds ?? snapshot.ageSeconds,
      mtimeAt: authoritative?.mtimeAt ?? snapshot.mtimeAt,
      mtimeMs: authoritative?.mtimeMs ?? snapshot.mtimeMs,
      observations: records.map(publicObservation),
    };
  }
  try {
    const value = replayBscWal(snapshot.value, wal.parseError === "missing" ? null : wal.value);
    return {
      file: authoritative?.file || snapshot.file,
      exists: true,
      ageSeconds: authoritative?.ageSeconds ?? snapshot.ageSeconds,
      mtimeAt: authoritative?.mtimeAt ?? snapshot.mtimeAt,
      mtimeMs: authoritative?.mtimeMs ?? snapshot.mtimeMs,
      value,
      parseError: wal.parseError && wal.parseError !== "missing" ? "wal_unreadable" : null,
      observations: records.map(publicObservation),
    };
  } catch (error) {
    return {
      file: authoritative?.file || snapshot.file,
      exists: true,
      ageSeconds: authoritative?.ageSeconds ?? snapshot.ageSeconds,
      mtimeAt: authoritative?.mtimeAt ?? snapshot.mtimeAt,
      mtimeMs: authoritative?.mtimeMs ?? snapshot.mtimeMs,
      value: null,
      parseError: error?.code === "unsupported_bsc_state_version"
        ? "state_version_unsupported"
        : "wal_corrupt",
      observations: records.map(publicObservation),
    };
  }
}

function progressRecord({ key, value, sourceAtMs, previous, nowMs, maxAgeSeconds }) {
  const token = digest({ key, value });
  const prior = previous?.key === key ? previous : null;
  const priorToken = prior?.token || (Object.hasOwn(prior || {}, "value") ? digest({ key, value: prior.value }) : null);
  const same = priorToken === token;
  const numeric = Number.isSafeInteger(value);
  const priorNumeric = Number.isSafeInteger(prior?.value);
  const regressed = numeric && priorNumeric && value < prior.value;
  const advanced = Boolean(prior) && !same && !regressed;
  const fallbackAt = Number.isFinite(sourceAtMs) ? sourceAtMs : nowMs;
  const priorAdvancedAt = parsedInstant(prior?.lastAdvancedAt, nowMs);
  const lastAdvancedMs = same && priorAdvancedAt !== null ? priorAdvancedAt : fallbackAt;
  const progressAgeSeconds = ageSeconds(lastAdvancedMs, nowMs);
  return {
    key,
    value,
    token,
    advanced,
    regressed,
    lastAdvancedAt: new Date(lastAdvancedMs).toISOString(),
    ageSeconds: progressAgeSeconds,
    frozen: progressAgeSeconds !== null && progressAgeSeconds > maxAgeSeconds,
  };
}

function semanticFreshness(value, nowMs, maximumAgeSeconds, label, operationalReasons) {
  const timestamp = parsedInstant(value, nowMs);
  if (timestamp === null) {
    operationalReasons.push(`${label}_timestamp_missing_or_invalid`);
    return null;
  }
  if (ageSeconds(timestamp, nowMs) > maximumAgeSeconds) operationalReasons.push(`${label}_stale`);
  return timestamp;
}

function latestInstant(values, nowMs) {
  const instants = values.map((value) => parsedInstant(value, nowMs)).filter((value) => value !== null);
  return instants.length ? Math.max(...instants) : null;
}

function scheduledRetryInstant(values, nowMs, maximumAgeSeconds) {
  const earliestAccepted = nowMs - maximumAgeSeconds * 1_000;
  const latestAccepted = nowMs + 24 * 60 * 60_000;
  const instants = values
    .map((value) => Date.parse(String(value || "")))
    .filter((value) => Number.isFinite(value) && value >= earliestAccepted && value <= latestAccepted);
  const future = instants.filter((value) => value >= nowMs);
  if (future.length) return Math.min(...future);
  return instants.length ? Math.max(...instants) : null;
}

function upstreamRestrictionKind(item) {
  const status = normalizedStatus(item?.status);
  if (EXPLICIT_UPSTREAM_BACKOFF_STATUSES.has(status) || status.startsWith("blocked_")) return status;
  const statusCode = Number(item?.lastErrorStatus ?? item?.lastStatus ?? item?.statusCode ?? item?.httpStatus);
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 401 || statusCode === 403) return "access_limited";
  if (item?.sourceRateLimited === true || item?.rateLimited === true) return "rate_limited";
  if (item?.wafBlocked === true || item?.sourceBlocked === true) return "waf_blocked";
  const failure = String(item?.lastError || item?.error || "");
  if (/\b429\b|rate.?limit/i.test(failure)) return "rate_limited";
  if (/\b40[13]\b|access.?denied|forbidden|waf|challenge/i.test(failure)) return "access_limited";
  return null;
}

function upstreamBackoffState(item, nowMs, maximumAgeSeconds) {
  const kind = upstreamRestrictionKind(item);
  const attemptMs = latestInstant([
    item?.lastAttemptAt,
    item?.checkedAt,
    item?.lastErrorAt,
    item?.lastLimitedAt,
  ], nowMs);
  const nextRetryMs = scheduledRetryInstant([
    item?.nextRetryAt,
    item?.nextAttemptAt,
    item?.backoffUntil,
    item?.blockedUntil,
    item?.sla?.nextRetryAt,
    item?.coverage?.nextRetryAt,
  ], nowMs, maximumAgeSeconds);
  const attemptFresh = attemptMs !== null && ageSeconds(attemptMs, nowMs) <= maximumAgeSeconds;
  const retryScheduled = nextRetryMs !== null;
  return {
    active: kind !== null && (attemptFresh || retryScheduled),
    kind,
    status: normalizedStatus(item?.status),
    attemptAt: attemptMs === null ? null : new Date(attemptMs).toISOString(),
    nextRetryAt: nextRetryMs === null ? null : new Date(nextRetryMs).toISOString(),
    attemptFresh,
    retryScheduled,
  };
}

function baseRecordReasons(record, maximumAgeSeconds, { checkFileAge = true } = {}) {
  const reasons = [];
  if (record.parseError) reasons.push(`${record.file}_${record.parseError}`);
  if (!record.parseError && checkFileAge && (record.ageSeconds === null || record.ageSeconds > maximumAgeSeconds)) {
    reasons.push(`${record.file}_stale`);
  }
  return reasons;
}

function laneResult({
  id,
  required = true,
  maximumAgeSeconds,
  record,
  operationalReasons = [],
  coverageReasons = [],
  warnings = [],
  progress = null,
  semantic = {},
}) {
  const observations = record.observations || [publicObservation(record)];
  const authoritative = freshestObservation(observations);
  if (!required) {
    return {
      id,
      required: false,
      healthy: true,
      operationalHealthy: true,
      coverageComplete: true,
      status: "disabled",
      reason: "not_required",
      maxAgeSeconds: maximumAgeSeconds,
      authoritative: authoritative ? publicObservation(authoritative) : null,
      observations,
      progress,
      semantic,
      operationalReasons: [],
      coverageReasons: [],
      warnings: [],
    };
  }
  const operational = unique(operationalReasons);
  const coverage = unique(coverageReasons);
  const operationalHealthy = operational.length === 0;
  const coverageComplete = coverage.length === 0;
  return {
    id,
    required: true,
    healthy: operationalHealthy && coverageComplete,
    operationalHealthy,
    coverageComplete,
    status: !operationalHealthy ? "critical" : !coverageComplete ? "degraded" : "healthy",
    reason: operational[0] || coverage[0] || "healthy",
    maxAgeSeconds: maximumAgeSeconds,
    authoritative: authoritative ? publicObservation(authoritative) : null,
    observations,
    progress,
    semantic,
    operationalReasons: operational,
    coverageReasons: coverage,
    warnings: unique(warnings),
  };
}

function evaluateRobinhood(record, previous, nowMs, maximumAgeSeconds) {
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds);
  const lastBlock = Number(record.value?.lastBlock);
  let progress = null;
  if (!Number.isSafeInteger(lastBlock) || lastBlock < 0) operationalReasons.push("lastBlock_missing_or_invalid");
  else {
    progress = progressRecord({
      key: "lastBlock",
      value: lastBlock,
      sourceAtMs: record.mtimeMs,
      previous: previous?.progress,
      nowMs,
      maxAgeSeconds: maximumAgeSeconds,
    });
    if (progress.regressed) operationalReasons.push("lastBlock_regressed");
    if (progress.frozen) operationalReasons.push("lastBlock_frozen");
  }
  return laneResult({
    id: "robinhood",
    maximumAgeSeconds,
    record,
    operationalReasons,
    progress,
    semantic: { lastBlock: Number.isSafeInteger(lastBlock) ? lastBlock : null },
  });
}

function evaluateBinance(record, previous, nowMs, maximumAgeSeconds) {
  const coverageReasons = [];
  const warnings = [];
  const announcementHealth = record.value?._health?.announcements || {};
  const streamHealth = record.value?._health?.announcementStream || {};
  const scheduler = record.value?.scheduler || {};
  const announcements = record.value?.announcements || {};
  const pollingStatus = normalizedStatus(announcementHealth.status);
  const upstreamBackoff = upstreamBackoffState(announcementHealth, nowMs, maximumAgeSeconds);
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, {
    checkFileAge: !upstreamBackoff.active,
  });
  if (upstreamBackoff.active && record.ageSeconds > maximumAgeSeconds) {
    coverageReasons.push("binance_state_stale_during_upstream_backoff");
  }
  const lastSuccessMs = record.parseError ? null : parsedInstant(announcementHealth.lastSuccessAt, nowMs);
  if (!record.parseError && lastSuccessMs === null) {
    const reason = "binance_announcement_last_success_timestamp_missing_or_invalid";
    (upstreamBackoff.active ? coverageReasons : operationalReasons).push(reason);
  } else if (lastSuccessMs !== null && ageSeconds(lastSuccessMs, nowMs) > maximumAgeSeconds) {
    const reason = "binance_announcement_last_success_stale";
    (upstreamBackoff.active ? coverageReasons : operationalReasons).push(reason);
  }
  const rawCursor = scheduler.announcementDetailCheckedAt || announcements.detailCheckedAt;
  let cursorMs = record.parseError ? null : parsedInstant(rawCursor, nowMs);
  if (!record.parseError && cursorMs === null) {
    const initializedMs = parsedInstant(announcements.initializedAt, nowMs);
    if (initializedMs !== null && ageSeconds(initializedMs, nowMs) <= maximumAgeSeconds) {
      coverageReasons.push("announcement_cursor_startup_pending");
    } else operationalReasons.push("binance_announcement_cursor_missing_or_invalid");
  } else if (cursorMs !== null && ageSeconds(cursorMs, nowMs) > maximumAgeSeconds) {
    const reason = "binance_announcement_cursor_stale";
    (upstreamBackoff.active ? coverageReasons : operationalReasons).push(reason);
  }

  let progress = null;
  if (cursorMs !== null) {
    progress = progressRecord({
      key: "announcementDetailCheckedAtMs",
      value: cursorMs,
      sourceAtMs: cursorMs,
      previous: previous?.progress,
      nowMs,
      maxAgeSeconds: maximumAgeSeconds,
    });
    if (progress.regressed) operationalReasons.push("binance_announcement_cursor_regressed");
    if (progress.frozen) {
      if (upstreamBackoff.active) coverageReasons.push("binance_announcement_cursor_frozen_during_backoff");
      else operationalReasons.push("binance_announcement_cursor_frozen");
    }
  }

  const streamEnabled = streamHealth.enabled === true;
  const streamConfigured = streamHealth.configured === true;
  const websocketActive = streamEnabled
    && streamConfigured
    && streamHealth.connected === true
    && normalizedStatus(streamHealth.coverage?.status) === "websocket_active"
    && streamHealth.sla?.hardRealtime === true;
  if (!streamEnabled) coverageReasons.push("websocket_disabled");
  else if (!streamConfigured) {
    coverageReasons.push("websocket_credentials_missing");
    warnings.push("binance_polling_fallback_missing_credentials");
  } else if (!websocketActive) {
    coverageReasons.push("websocket_not_active");
    warnings.push(`binance_websocket_${normalizedStatus(streamHealth.streamStatus || streamHealth.status)}`);
  }
  if (pollingStatus !== "healthy") {
    coverageReasons.push(`cms_polling_${pollingStatus}`);
    if (SOURCE_LIMITED_STATUSES.has(pollingStatus)) warnings.push(`binance_cms_${pollingStatus}`);
  }
  if (upstreamBackoff.active) warnings.push(`binance_upstream_${upstreamBackoff.kind}`);
  const pendingDetails = finiteCount(announcementHealth.pendingDetails);
  if (pendingDetails > 0) coverageReasons.push("announcement_details_pending");

  return laneResult({
    id: "binance",
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      polling: {
        status: pollingStatus,
        checkedAt: isoOrNull(announcementHealth.checkedAt, nowMs),
        lastSuccessAt: lastSuccessMs === null ? null : new Date(lastSuccessMs).toISOString(),
        pendingDetails,
        articleCount: finiteCount(announcementHealth.articles),
      },
      announcementCursor: cursorMs === null ? null : new Date(cursorMs).toISOString(),
      upstreamBackoff,
      websocket: {
        status: normalizedStatus(streamHealth.status),
        streamStatus: normalizedStatus(streamHealth.streamStatus),
        enabled: streamEnabled,
        configured: streamConfigured,
        connected: streamHealth.connected === true,
        websocketObserved: streamHealth.websocketObserved === true,
        coverageStatus: normalizedStatus(streamHealth.coverage?.status),
        mode: normalizedStatus(streamHealth.coverage?.mode),
        hardRealtime: streamHealth.sla?.hardRealtime === true,
        missingCredentialCount: Array.isArray(streamHealth.missingCredentials)
          ? streamHealth.missingCredentials.length : 0,
      },
    },
  });
}

function evaluateBsc(record, previous, nowMs, maximumAgeSeconds) {
  const coverageReasons = [];
  const warnings = [];
  const health = record.value?._health || {};
  const realtime = health.realtimeTail || {};
  const historical = health.coverage || {};
  const recovery = health.nearHeadRecovery || {};
  const upstreamBackoff = upstreamBackoffState(realtime, nowMs, maximumAgeSeconds);
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, {
    checkFileAge: !upstreamBackoff.active,
  });
  if (upstreamBackoff.active && record.ageSeconds > maximumAgeSeconds) {
    coverageReasons.push("bsc_state_stale_during_upstream_backoff");
  }
  const realtimeCheckedMs = record.parseError
    ? null
    : latestInstant([
      realtime.lastAttemptAt,
      realtime.checkedAt,
      realtime.lastErrorAt,
      realtime.healthCheckedAt,
      realtime.lastSuccessAt,
    ], nowMs);
  if (!record.parseError && realtimeCheckedMs === null) {
    const reason = "realtime_tail_timestamp_missing_or_invalid";
    (upstreamBackoff.active ? coverageReasons : operationalReasons).push(reason);
  } else if (realtimeCheckedMs !== null && ageSeconds(realtimeCheckedMs, nowMs) > maximumAgeSeconds) {
    const reason = "realtime_tail_stale";
    (upstreamBackoff.active ? coverageReasons : operationalReasons).push(reason);
  }
  const realtimeLastSuccessMs = record.parseError ? null : parsedInstant(realtime.lastSuccessAt, nowMs);
  if (upstreamBackoff.active
    && (realtimeLastSuccessMs === null || ageSeconds(realtimeLastSuccessMs, nowMs) > maximumAgeSeconds)) {
    coverageReasons.push("realtime_last_success_stale");
  }
  const nextBlock = Number(realtime.nextBlock ?? record.value?.realtimeTailNextBlock);
  let progress = null;
  if (!record.parseError) {
    if (!Number.isSafeInteger(nextBlock) || nextBlock < 0) operationalReasons.push("realtime_cursor_missing_or_invalid");
    else {
      progress = progressRecord({
        key: "realtimeNextBlock",
        value: nextBlock,
        sourceAtMs: realtimeLastSuccessMs ?? realtimeCheckedMs ?? record.mtimeMs,
        previous: previous?.progress,
        nowMs,
        maxAgeSeconds: maximumAgeSeconds,
      });
      if (progress.regressed) operationalReasons.push("realtime_cursor_regressed");
      if (progress.frozen) {
        if (upstreamBackoff.active) coverageReasons.push("realtime_cursor_frozen_during_backoff");
        else operationalReasons.push("realtime_cursor_frozen");
      }
    }

    const realtimeStatus = normalizedStatus(realtime.status);
    const lagBlocks = Number(realtime.lagBlocks);
    const degradedLagBlocks = Number(realtime.degradedLagBlocks ?? historical.degradedLagBlocks ?? 40);
    if (realtimeStatus !== "healthy") coverageReasons.push(`realtime_status_${realtimeStatus}`);
    if (upstreamBackoff.active) {
      coverageReasons.push(`realtime_upstream_${upstreamBackoff.kind}`);
      warnings.push(`realtime_upstream_${upstreamBackoff.kind}`);
    }
    if (Number.isFinite(lagBlocks) && Number.isFinite(degradedLagBlocks) && lagBlocks >= degradedLagBlocks) {
      coverageReasons.push("realtime_lag_degraded");
    }

    const historicalStatus = normalizedStatus(historical.status);
    if (historicalStatus !== "healthy") coverageReasons.push(`historical_coverage_${historicalStatus}`);
    const historicalCheckedMs = parsedInstant(historical.checkedAt, nowMs);
    if (historicalCheckedMs === null || ageSeconds(historicalCheckedMs, nowMs) > maximumAgeSeconds) {
      coverageReasons.push("historical_coverage_stale");
    }
    if (finiteCount(historical.unresolvedGapCount) > 0) coverageReasons.push("historical_unresolved_gaps");
    if (finiteCount(historical.nearHeadRecoveryGapCount) > 0) coverageReasons.push("historical_near_head_gaps");
    if (finiteCount(historical.deferredTransactionCount) > 0) coverageReasons.push("historical_deferred_transactions");
    const recoveryStatus = normalizedStatus(recovery.status);
    if (SOURCE_LIMITED_STATUSES.has(recoveryStatus)) warnings.push(`near_head_recovery_${recoveryStatus}`);
    const rpcStatus = normalizedStatus(health.rpc?.status);
    if (rpcStatus !== "healthy" && rpcStatus !== "unknown") warnings.push(`rpc_${rpcStatus}`);
  }

  return laneResult({
    id: "bsc",
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      journalRevision: Number.isSafeInteger(record.value?.journalRevision) ? record.value.journalRevision : null,
      realtime: {
        status: normalizedStatus(realtime.status),
        checkedAt: realtimeCheckedMs === null ? null : new Date(realtimeCheckedMs).toISOString(),
        nextBlock: Number.isSafeInteger(nextBlock) ? nextBlock : null,
        coveredBlock: Number.isSafeInteger(Number(realtime.coveredBlock)) ? Number(realtime.coveredBlock) : null,
        confirmedHeadBlock: Number.isSafeInteger(Number(realtime.confirmedHeadBlock))
          ? Number(realtime.confirmedHeadBlock) : null,
        lagBlocks: Number.isFinite(Number(realtime.lagBlocks)) ? Number(realtime.lagBlocks) : null,
        upstreamBackoff,
      },
      historical: {
        status: normalizedStatus(historical.status),
        checkedAt: isoOrNull(historical.checkedAt, nowMs),
        coveredBlock: Number.isSafeInteger(Number(historical.coveredBlock)) ? Number(historical.coveredBlock) : null,
        unresolvedGapCount: finiteCount(historical.unresolvedGapCount),
        nearHeadRecoveryGapCount: finiteCount(historical.nearHeadRecoveryGapCount),
        nearHeadRecoveryBlockCount: finiteCount(historical.nearHeadRecoveryBlockCount),
        deferredTransactionCount: finiteCount(historical.deferredTransactionCount),
        recoveryStatus: normalizedStatus(recovery.status),
      },
      websocket: {
        status: normalizedStatus(health.websocket?.status),
        lastHeadAt: isoOrNull(health.websocket?.lastHeadAt, nowMs),
      },
    },
  });
}

function schedulerAttemptState(item, nowMs, maximumAgeSeconds) {
  const lastAttemptMs = parsedInstant(item?.lastAttemptAt, nowMs);
  const parsedNextAttempt = Date.parse(String(item?.nextAttemptAt || ""));
  const nextAttemptMs = Number.isFinite(parsedNextAttempt)
    && parsedNextAttempt >= nowMs - maximumAgeSeconds * 1_000
    && parsedNextAttempt <= nowMs + 24 * 60 * 60_000
    ? parsedNextAttempt
    : null;
  const status = normalizedStatus(item?.status);
  const attemptFresh = lastAttemptMs !== null && ageSeconds(lastAttemptMs, nowMs) <= maximumAgeSeconds;
  const scheduledSourceRetry = SOURCE_LIMITED_STATUSES.has(status)
    && nextAttemptMs !== null
    && nextAttemptMs >= nowMs - maximumAgeSeconds * 1_000;
  return { status, lastAttemptMs, nextAttemptMs, operational: attemptFresh || scheduledSourceRetry };
}

function githubSourceKind(item) {
  const statusCode = Number(item?.lastErrorStatus);
  if (statusCode === 403 || statusCode === 401) return "access_limited";
  if (statusCode === 429) return "rate_limited";
  if (statusCode >= 500) return "upstream_error";
  const status = normalizedStatus(item?.status);
  if (SOURCE_LIMITED_STATUSES.has(status)) return status;
  return status === "healthy" ? null : "other_failure";
}

function evaluateGithub(record, previous, nowMs, maximumAgeSeconds) {
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, { checkFileAge: false });
  const coverageReasons = [];
  const warnings = [];
  const repositories = Object.values(record.value?._health?.repositories || {});
  let active = repositories.filter((item) => normalizedStatus(item?.pollingClass) === "core_or_configured");
  if (!active.length) active = repositories.filter((item) => item?.priority === true);
  const sourceLimited = {};
  const unhealthyRepositories = [];
  let latestAttemptMs = null;
  if (!record.parseError && active.length === 0) {
    operationalReasons.push("github_active_repositories_missing");
    coverageReasons.push("github_coverage_unknown");
  }
  for (const item of active) {
    const repository = String(item?.repository || "unknown").slice(0, 160);
    const attempt = schedulerAttemptState(item, nowMs, maximumAgeSeconds);
    if (attempt.lastAttemptMs !== null) latestAttemptMs = Math.max(latestAttemptMs ?? 0, attempt.lastAttemptMs);
    if (!attempt.operational) operationalReasons.push(`github_repository_stalled:${repository}`);
    const lastSuccessMs = parsedInstant(item?.lastSuccessAt, nowMs);
    const complete = attempt.status === "healthy"
      && lastSuccessMs !== null
      && ageSeconds(lastSuccessMs, nowMs) <= maximumAgeSeconds;
    if (!complete) {
      coverageReasons.push(`github_repository_incomplete:${repository}`);
      unhealthyRepositories.push(repository);
      const kind = githubSourceKind(item);
      if (kind) {
        sourceLimited[kind] = (sourceLimited[kind] || 0) + 1;
        warnings.push(`github_${kind}`);
      }
    }
  }
  let progress = null;
  if (latestAttemptMs !== null) {
    progress = progressRecord({
      key: "latestCoreAttemptAtMs",
      value: latestAttemptMs,
      sourceAtMs: latestAttemptMs,
      previous: previous?.progress,
      nowMs,
      maxAgeSeconds: maximumAgeSeconds,
    });
  }
  return laneResult({
    id: "github",
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      activeRepositoryCount: active.length,
      incompleteRepositoryCount: unhealthyRepositories.length,
      incompleteRepositories: bounded(unhealthyRepositories),
      sourceLimitations: sourceLimited,
      latestAttemptAt: latestAttemptMs === null ? null : new Date(latestAttemptMs).toISOString(),
    },
  });
}

function evaluatePlatform(record, previous, nowMs, maximumAgeSeconds) {
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, { checkFileAge: false });
  const coverageReasons = [];
  const warnings = [];
  const platforms = record.value?._health?.platforms || {};
  const expected = ["flap", "fourmeme"];
  const summary = {};
  let latestAttemptMs = null;
  for (const name of expected) {
    const item = platforms[name];
    if (!item) {
      operationalReasons.push(`platform_health_missing:${name}`);
      coverageReasons.push(`platform_coverage_missing:${name}`);
      summary[name] = { status: "missing", coverageStatus: "unknown" };
      continue;
    }
    const attempt = schedulerAttemptState(item, nowMs, maximumAgeSeconds);
    if (attempt.lastAttemptMs !== null) latestAttemptMs = Math.max(latestAttemptMs ?? 0, attempt.lastAttemptMs);
    if (!attempt.operational) operationalReasons.push(`platform_stalled:${name}`);
    const coverageStatus = normalizedStatus(item.coverageStatus);
    const complete = attempt.status === "healthy" && coverageStatus === "complete";
    if (!complete) coverageReasons.push(`platform_incomplete:${name}:${coverageStatus}`);
    const failureKind = normalizedStatus(item.failureKind, "none");
    if (!complete && (failureKind === "policy_or_source" || SOURCE_LIMITED_STATUSES.has(attempt.status))) {
      warnings.push(`platform_source_limited:${name}`);
    }
    summary[name] = {
      status: attempt.status,
      coverageStatus,
      failureKind,
      lastAttemptAt: attempt.lastAttemptMs === null ? null : new Date(attempt.lastAttemptMs).toISOString(),
      lastSuccessAt: isoOrNull(item.lastSuccessAt, nowMs),
      nextAttemptAt: attempt.nextAttemptMs === null ? null : new Date(attempt.nextAttemptMs).toISOString(),
      optionalCircuitOpenCount: finiteCount(item.optionalCircuitOpenCount),
    };
  }
  let progress = null;
  if (latestAttemptMs !== null) {
    progress = progressRecord({
      key: "latestPlatformAttemptAtMs",
      value: latestAttemptMs,
      sourceAtMs: latestAttemptMs,
      previous: previous?.progress,
      nowMs,
      maxAgeSeconds: maximumAgeSeconds,
    });
  }
  return laneResult({
    id: "platformCapability",
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: { platforms: summary },
  });
}

function evaluateFomoCall(record, previous, nowMs, maximumAgeSeconds, required) {
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds);
  const coverageReasons = [];
  const warnings = [];
  const health = record.value?.health || {};
  const checkedMs = record.parseError || !required
    ? null
    : semanticFreshness(health.checkedAt, nowMs, maximumAgeSeconds, "fomo_call", operationalReasons);
  const status = normalizedStatus(health.status);
  const coverage = record.value?.coverageSummary || {};
  if (required && !record.parseError) {
    if (!["healthy", "healthy_no_updates"].includes(status)) coverageReasons.push(`fomo_call_status_${status}`);
    if (coverage.complete !== true) coverageReasons.push("fomo_call_coverage_incomplete");
    for (const reason of bounded(Array.isArray(coverage.incompleteReasons) ? coverage.incompleteReasons : [])) {
      coverageReasons.push(`fomo_call_${String(reason).slice(0, 120)}`);
    }
    if (SOURCE_LIMITED_STATUSES.has(status)) warnings.push(`fomo_call_${status}`);
  }
  const progress = checkedMs === null ? null : progressRecord({
    key: "healthCheckedAtMs",
    value: checkedMs,
    sourceAtMs: checkedMs,
    previous: previous?.progress,
    nowMs,
    maxAgeSeconds: maximumAgeSeconds,
  });
  return laneResult({
    id: "fomoState",
    required,
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      status,
      checkedAt: checkedMs === null ? null : new Date(checkedMs).toISOString(),
      lastSuccessAt: isoOrNull(health.lastSuccessAt, nowMs),
      coverageComplete: coverage.complete === true,
      monitoredTopCount: finiteCount(coverage.monitoredTopCount),
      gapCount: finiteCount(coverage.gaps?.count),
      skippedBlocks: finiteCount(coverage.gaps?.skippedBlocks),
      incompleteReasons: bounded(Array.isArray(coverage.incompleteReasons) ? coverage.incompleteReasons : []),
    },
  });
}

function evaluateFomoCheckpoint(record, previous, callRecord, nowMs, maximumAgeSeconds, required) {
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds);
  const coverageReasons = [];
  const updatedMs = record.parseError || !required
    ? null
    : semanticFreshness(record.value?.updatedAt, nowMs, maximumAgeSeconds, "fomo_checkpoint", operationalReasons);
  const revision = Number(record.value?.revision);
  const bscNextBlock = Number(record.value?.bscNextBlock);
  if (required && !record.parseError) {
    if (!Number.isSafeInteger(revision) || revision < 0) operationalReasons.push("fomo_checkpoint_revision_invalid");
    if (!Number.isSafeInteger(bscNextBlock) || bscNextBlock < 0) operationalReasons.push("fomo_checkpoint_cursor_invalid");
    if (record.value?.bscSilentBaselinePending === true) coverageReasons.push("fomo_checkpoint_baseline_pending");
    const priorRevision = Number(previous?.semantic?.revision);
    if (Number.isSafeInteger(priorRevision) && Number.isSafeInteger(revision) && revision < priorRevision) {
      operationalReasons.push("fomo_checkpoint_revision_regressed");
    }
    const mainRevision = Number(callRecord.value?.fomoCallCheckpoint?.revision);
    if (Number.isSafeInteger(mainRevision) && Number.isSafeInteger(revision) && mainRevision > revision) {
      operationalReasons.push("fomo_checkpoint_behind_main_state");
    }
  }
  let progress = null;
  if (required && Number.isSafeInteger(bscNextBlock) && bscNextBlock >= 0) {
    progress = progressRecord({
      key: "bscNextBlock",
      value: bscNextBlock,
      sourceAtMs: updatedMs ?? record.mtimeMs,
      previous: previous?.progress,
      nowMs,
      maxAgeSeconds: maximumAgeSeconds,
    });
    if (progress.regressed) operationalReasons.push("fomo_checkpoint_cursor_regressed");
    if (progress.frozen) operationalReasons.push("fomo_checkpoint_cursor_frozen");
  }
  return laneResult({
    id: "fomoCheckpoint",
    required,
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    progress,
    semantic: {
      revision: Number.isSafeInteger(revision) ? revision : null,
      updatedAt: updatedMs === null ? null : new Date(updatedMs).toISOString(),
      bscNextBlock: Number.isSafeInteger(bscNextBlock) ? bscNextBlock : null,
      bscSilentBaselinePending: record.value?.bscSilentBaselinePending === true,
    },
  });
}

function evaluateFomoX(record, previous, nowMs, maximumAgeSeconds, required) {
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds);
  const coverageReasons = [];
  const warnings = [];
  const health = record.value?.health || {};
  const checkedMs = record.parseError || !required
    ? null
    : semanticFreshness(health.checkedAt, nowMs, maximumAgeSeconds, "fomo_x", operationalReasons);
  const status = normalizedStatus(health.status);
  const coverage = health.coverage || {};
  const eligible = finiteCount(coverage.eligibleCount ?? health.eligibleCount);
  const live = finiteCount(coverage.liveCount ?? health.liveCount ?? health.activeCount);
  const sourceCoverage = normalizedStatus(health.sources?.x?.coverage, "complete");
  if (required && !record.parseError) {
    if (status !== "healthy") coverageReasons.push(`fomo_x_status_${status}`);
    if (eligible === 0) coverageReasons.push("fomo_x_no_eligible_targets");
    else if (live < eligible) coverageReasons.push("fomo_x_live_coverage_incomplete");
    if (sourceCoverage !== "complete") coverageReasons.push(`fomo_x_source_${sourceCoverage}`);
    if (SOURCE_LIMITED_STATUSES.has(status) || sourceCoverage === "source_limited") {
      warnings.push("fomo_x_source_limited");
    }
  }
  const progress = checkedMs === null ? null : progressRecord({
    key: "healthCheckedAtMs",
    value: checkedMs,
    sourceAtMs: checkedMs,
    previous: previous?.progress,
    nowMs,
    maxAgeSeconds: maximumAgeSeconds,
  });
  return laneResult({
    id: "fomoX",
    required,
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      status,
      checkedAt: checkedMs === null ? null : new Date(checkedMs).toISOString(),
      lastSuccessAt: isoOrNull(health.lastSuccessAt, nowMs),
      eligibleCount: eligible,
      liveCount: live,
      backlogCount: finiteCount(coverage.backlogCount ?? health.backlogCount),
      sourceCoverage,
      sourceStatus: normalizedStatus(health.sources?.x?.status),
    },
  });
}

function evaluateFomoThesis(record, previous, nowMs, maximumAgeSeconds, required) {
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds);
  const coverageReasons = [];
  const warnings = [];
  const health = record.value?.health || {};
  const checkedMs = record.parseError || !required
    ? null
    : semanticFreshness(health.checkedAt, nowMs, maximumAgeSeconds, "fomo_thesis", operationalReasons);
  const status = normalizedStatus(health.status);
  const sources = Object.values(health.sources || {});
  const sourceStatuses = {};
  for (const source of sources) {
    const sourceStatus = normalizedStatus(source?.status);
    sourceStatuses[sourceStatus] = (sourceStatuses[sourceStatus] || 0) + 1;
  }
  if (required && !record.parseError) {
    if (!["healthy", "healthy_no_updates"].includes(status)) coverageReasons.push(`fomo_thesis_status_${status}`);
    if (SOURCE_LIMITED_STATUSES.has(status) || status.startsWith("blocked_")) warnings.push(`fomo_thesis_${status}`);
  }
  const progress = checkedMs === null ? null : progressRecord({
    key: "healthCheckedAtMs",
    value: checkedMs,
    sourceAtMs: checkedMs,
    previous: previous?.progress,
    nowMs,
    maxAgeSeconds: maximumAgeSeconds,
  });
  return laneResult({
    id: "fomoThesis",
    required,
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      status,
      checkedAt: checkedMs === null ? null : new Date(checkedMs).toISOString(),
      sourceStatuses,
      blocked: status.startsWith("blocked_"),
    },
  });
}

function inspectOutboxRecord(record, nowMs, maximumAgeSeconds) {
  if (record.parseError === "missing") {
    return {
      file: record.file,
      counts: {},
      nonterminalCount: 0,
      failedDestinationCount: 0,
      oldestPendingAgeSeconds: null,
      parseError: null,
      operationalHealthy: true,
      deliveryComplete: true,
      status: "healthy",
      operationalReasons: [],
    };
  }
  if (record.parseError || !record.value?.events || typeof record.value.events !== "object"
    || Array.isArray(record.value.events)) {
    return {
      file: record.file,
      counts: {},
      nonterminalCount: 0,
      failedDestinationCount: 0,
      oldestPendingAgeSeconds: null,
      parseError: record.parseError || "events_missing_or_invalid",
      operationalHealthy: false,
      deliveryComplete: false,
      status: "critical",
      operationalReasons: [`${record.file}_cannot_be_parsed`],
    };
  }
  const counts = {};
  let nonterminalCount = 0;
  let failedDestinationCount = 0;
  let oldestPendingAgeSeconds = null;
  let invalidNonterminalTimestampCount = 0;
  for (const entry of Object.values(record.value.events)) {
    const status = normalizedStatus(entry?.status);
    counts[status] = (counts[status] || 0) + 1;
    const destinations = Object.values(entry?.destinations || {});
    const destinationNonterminal = destinations.some((destination) => (
      !TERMINAL_DESTINATION_STATUSES.has(normalizedStatus(destination?.status))
    ));
    const nonterminal = !TERMINAL_OUTBOX_STATUSES.has(status) || destinationNonterminal;
    if (!nonterminal) continue;
    nonterminalCount += 1;
    failedDestinationCount += destinations.filter((destination) => normalizedStatus(destination?.status) === "failed").length;
    const timestamp = parsedInstant(entry?.createdAt || entry?.updatedAt, nowMs);
    if (timestamp === null) invalidNonterminalTimestampCount += 1;
    else oldestPendingAgeSeconds = Math.max(oldestPendingAgeSeconds ?? 0, ageSeconds(timestamp, nowMs));
  }
  const operationalReasons = [];
  if (invalidNonterminalTimestampCount > 0) operationalReasons.push(`${record.file}_nonterminal_timestamp_invalid`);
  if ((oldestPendingAgeSeconds ?? 0) > maximumAgeSeconds) {
    operationalReasons.push(`${record.file}_nonterminal_delivery_stuck`);
  }
  const operationalHealthy = operationalReasons.length === 0;
  return {
    file: record.file,
    counts,
    nonterminalCount,
    failedDestinationCount,
    oldestPendingAgeSeconds,
    parseError: null,
    operationalHealthy,
    deliveryComplete: nonterminalCount === 0,
    status: !operationalHealthy ? "critical" : nonterminalCount > 0 ? "degraded" : "healthy",
    operationalReasons,
  };
}

async function deliverHeartbeat(rawUrl, { required, timeoutMs, fetchImpl }) {
  const result = {
    required,
    configured: Boolean(rawUrl),
    attempted: false,
    delivered: false,
    status: null,
    error: null,
  };
  if (!rawUrl) {
    result.error = required ? "not_configured" : null;
    return result;
  }
  let url;
  try {
    url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid");
  } catch {
    result.error = "invalid_https_url";
    return result;
  }
  result.attempted = true;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "robinhood-monitor-health/1" },
    });
    result.status = response.status;
    result.delivered = response.ok;
    if (!response.ok) result.error = "non_success_status";
  } catch (error) {
    result.error = `request_failed:${error?.name || "Error"}`;
  }
  return result;
}

async function writeReport(dataDir, report) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const destination = path.join(dataDir, "health.json");
  const temporary = path.join(dataDir, `.health.json.${process.pid}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, destination);
}

export async function runHealthCheck({
  env = process.env,
  nowMs = Date.now(),
  serviceStateImpl = systemdServiceState,
  fetchImpl = globalThis.fetch,
  writeReportFile = true,
} = {}) {
  const settings = buildHealthSettings(env);
  const { dataDir, configDir, limits, requirements, policy } = settings;
  const checkedAt = new Date(nowMs);
  const [
    nodeId,
    activeId,
    mainService,
    fomoService,
    robinhoodRecord,
    binanceRecord,
    bscRecord,
    githubRecord,
    platformRecord,
    fomoCallRecord,
    fomoCheckpointRecord,
    fomoXRecord,
    fomoThesisRecord,
    mainOutboxRecord,
    fomoOutboxRecord,
    previousReportRecord,
  ] = await Promise.all([
    readTrimmed(path.join(configDir, "node-id")),
    readTrimmed(path.join(configDir, "ACTIVE")),
    serviceStateImpl("robinhood-monitor.service"),
    serviceStateImpl("robinhood-fomo.service"),
    readJsonRecord(dataDir, "state.json", nowMs),
    readJsonRecord(dataDir, "binance-state.json", nowMs),
    readBscRecord(dataDir, nowMs),
    readJsonRecord(dataDir, "github-state.json", nowMs),
    readJsonRecord(dataDir, "platform-capability-state.json", nowMs),
    readJsonRecord(dataDir, "fomo-call-state.json", nowMs),
    readJsonRecord(dataDir, "fomo-call-checkpoint.json", nowMs),
    readJsonRecord(dataDir, "fomo-x-call-state.json", nowMs),
    readJsonRecord(dataDir, "fomo-thesis-state.json", nowMs),
    readJsonRecord(dataDir, "alert-outbox.json", nowMs),
    readJsonRecord(dataDir, "fomo-alerts/alert-outbox.json", nowMs),
    readJsonRecord(dataDir, "health.json", nowMs),
  ]);
  const previousLanes = previousReportRecord.parseError ? {} : previousReportRecord.value?.lanes || {};
  const laneResults = [
    evaluateRobinhood(robinhoodRecord, previousLanes.robinhood, nowMs, limits.robinhoodAgeSeconds),
    evaluateBinance(binanceRecord, previousLanes.binance, nowMs, limits.binanceAgeSeconds),
    evaluateBsc(bscRecord, previousLanes.bsc, nowMs, limits.bscAgeSeconds),
    evaluateGithub(githubRecord, previousLanes.github, nowMs, limits.githubAgeSeconds),
    evaluatePlatform(
      platformRecord,
      previousLanes.platformCapability,
      nowMs,
      limits.platformCapabilityAgeSeconds,
    ),
    evaluateFomoCall(
      fomoCallRecord,
      previousLanes.fomoState,
      nowMs,
      limits.fomoStateAgeSeconds,
      requirements.fomoState,
    ),
    evaluateFomoCheckpoint(
      fomoCheckpointRecord,
      previousLanes.fomoCheckpoint,
      fomoCallRecord,
      nowMs,
      limits.fomoCheckpointAgeSeconds,
      requirements.fomoCheckpoint,
    ),
    evaluateFomoX(
      fomoXRecord,
      previousLanes.fomoX,
      nowMs,
      limits.fomoXAgeSeconds,
      requirements.fomoX,
    ),
    evaluateFomoThesis(
      fomoThesisRecord,
      previousLanes.fomoThesis,
      nowMs,
      limits.fomoThesisAgeSeconds,
      requirements.fomoThesis,
    ),
  ];
  const lanes = Object.fromEntries(laneResults.map((lane) => [lane.id, lane]));
  const mainOutbox = inspectOutboxRecord(mainOutboxRecord, nowMs, limits.outboxPendingAgeSeconds);
  const fomoOutbox = inspectOutboxRecord(fomoOutboxRecord, nowMs, limits.outboxPendingAgeSeconds);

  const operationalFailures = [];
  if (!nodeId || activeId !== nodeId) operationalFailures.push("local ACTIVE marker does not match this node");
  if (mainService !== "active") operationalFailures.push(`robinhood-monitor.service is ${mainService}`);
  if (fomoService !== "active") operationalFailures.push(`robinhood-fomo.service is ${fomoService}`);
  for (const lane of laneResults) {
    if (!lane.operationalHealthy) {
      operationalFailures.push(`${lane.id} operational progress failed: ${lane.operationalReasons.join(",")}`);
    }
  }
  for (const outbox of [mainOutbox, fomoOutbox]) operationalFailures.push(...outbox.operationalReasons);

  const coverageIssues = laneResults
    .filter((lane) => lane.required && !lane.coverageComplete)
    .map((lane) => `${lane.id}: ${lane.coverageReasons.join(",")}`);
  const deliveryIssues = [mainOutbox, fomoOutbox]
    .filter((outbox) => !outbox.deliveryComplete)
    .map((outbox) => `${outbox.file}: ${outbox.nonterminalCount} nonterminal deliveries`);
  const coverageComplete = coverageIssues.length === 0;
  const deliveryComplete = deliveryIssues.length === 0;
  const locallyOperational = operationalFailures.length === 0;
  const heartbeatPolicy = policy.heartbeatRequireCoverageComplete ? "complete_coverage" : "operational";
  const heartbeatPolicySatisfied = locallyOperational
    && (!policy.heartbeatRequireCoverageComplete || (coverageComplete && deliveryComplete));
  let heartbeat;
  if (!heartbeatPolicySatisfied) {
    heartbeat = {
      required: requirements.externalHeartbeat,
      configured: Boolean(settings.heartbeatUrl),
      attempted: false,
      delivered: false,
      status: null,
      error: locallyOperational ? "skipped_policy_not_satisfied" : "skipped_operational_unhealthy",
      policy: heartbeatPolicy,
      policySatisfied: false,
    };
  } else {
    heartbeat = {
      ...(await deliverHeartbeat(settings.heartbeatUrl, {
        required: requirements.externalHeartbeat,
        timeoutMs: limits.heartbeatTimeoutMs,
        fetchImpl,
      })),
      policy: heartbeatPolicy,
      policySatisfied: true,
    };
  }
  if (heartbeatPolicySatisfied && requirements.externalHeartbeat && !heartbeat.delivered) {
    operationalFailures.push(`external heartbeat is ${heartbeat.error || "not_delivered"}`);
  }

  const operationalHealthy = operationalFailures.length === 0;
  const healthy = operationalHealthy && coverageComplete && deliveryComplete;
  const report = {
    version: 3,
    healthy,
    status: !operationalHealthy ? "critical" : !coverageComplete || !deliveryComplete ? "degraded" : "healthy",
    operationalHealthy,
    coverageComplete,
    deliveryComplete,
    checkedAt: checkedAt.toISOString(),
    node: { nodeId, activeId, activeMarkerMatches: Boolean(nodeId && nodeId === activeId) },
    services: { main: mainService, fomo: fomoService },
    lanes,
    outboxes: { main: mainOutbox, fomo: fomoOutbox },
    heartbeat,
    limits,
    requirements,
    policy: { heartbeat: heartbeatPolicy },
    failures: operationalFailures,
    operationalFailures,
    coverageIssues,
    deliveryIssues,
  };
  if (writeReportFile) await writeReport(dataDir, report);
  return report;
}

async function main() {
  const report = await runHealthCheck();
  console.log(JSON.stringify(report));
  // Source coverage can be degraded because of a provider WAF, missing
  // credentials, or an API rate limit. Restarting healthy workers cannot fix
  // those conditions. Only local/process/progress failures make the oneshot
  // fail; coverage remains explicit in report.healthy/status.
  if (!report.operationalHealthy) process.exitCode = 1;
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entrypoint === import.meta.url) await main();
