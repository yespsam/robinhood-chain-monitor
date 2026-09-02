import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_DATA_DIR = "/var/lib/robinhood-chain-monitor";
const DEFAULT_CONFIG_DIR = "/etc/robinhood-chain-monitor";
const PON_STATE_VERSION = 1;
const PON_CHAIN_ID = 4663;
const PON_FACTORY = "0xf698d13348686c1529c2dc54847c123424d9dae0";
const PON_FACTORY_START_BLOCK = 51_807_788;
const PON_FACTORY_DEPLOY_BLOCK = 51_808_655;
const PON_FACTORY_DEPLOY_TRANSACTION = "0x6bf0d084d6b69090a3a4e5c7b68f51fcb1dfd0485f5f0c28f2d59b4d6809654c";
const PON_FACTORY_RUNTIME_HASH = "0x4cb9795396b800a4b1e46f2e91a690ecf004ac0d52b059a7ef0e6b190af17384";
const PON_MARKET_CREATED_TOPIC = "0x8ada27e0afa58f4d4be8c4edbf4bfd49d9d586ce8a714938b12f51b7855893bb";
const PON_PLATFORM_TOKEN = "0x7673dc6d2357bdc2e04fd80c169f2bef56622d9a";
const PON_PROCESSED_EVENT_LIMIT = 2_000;
const PON_FINALIZED_CHECKPOINT_LIMIT = 256;
const PON_ORPHANED_EVENT_LIMIT = 500;
const PON_ALERT_ORIGIN_LIMIT = PON_PROCESSED_EVENT_LIMIT;
const PON_RECENT_ORPHAN_LIMIT = 50;
const PON_MARKET_LIMIT = 10_000;
const PON_PENDING_LIMIT = 500;
const PON_MISSED_CRITICAL_LIMIT = 200;
const PON_MID_CYCLE_RECOVERY_FAILURE_LIMIT = 3;
const PON_X_HANDLE = "pondotfun";
const PON_X_VERIFICATION_IDENTITY = "fxtwitter_exact_numeric_id+official_x_oembed";
const PON_X_CURSOR_GAP_REASONS = new Set([
  "durable_cursor_not_in_numeric_id_timeline",
  "discovery_only_cannot_prove_durable_cursor_continuity",
]);
const PON_X_RECOVERY_WINDOW_REASON = "oldest_unprocessed_tweet_outside_bounded_recovery_window";
const PON_DELAYED_CRITICAL_KINDS = new Set([
  "factory_config",
  "curve_params",
  "stock_listing",
  "factory_paused",
  "factory_unpaused",
  "ownership_transfer_started",
  "ownership_transferred",
]);
const PON_DANGEROUS_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
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
      ponAgeSeconds: positiveInteger(env, "HEALTH_PON_MAX_AGE_SECONDS", 180),
      fomoStateAgeSeconds: positiveInteger(env, "HEALTH_FOMO_STATE_MAX_AGE_SECONDS", 180),
      fomoCheckpointAgeSeconds: positiveInteger(env, "HEALTH_FOMO_CHECKPOINT_MAX_AGE_SECONDS", 900),
      fomoXAgeSeconds: positiveInteger(env, "HEALTH_FOMO_X_MAX_AGE_SECONDS", 180),
      fomoThesisAgeSeconds: positiveInteger(env, "HEALTH_FOMO_THESIS_MAX_AGE_SECONDS", 180),
      outboxPendingAgeSeconds: positiveInteger(env, "HEALTH_OUTBOX_MAX_PENDING_AGE_SECONDS", 60),
      heartbeatTimeoutMs: positiveInteger(env, "HEALTH_HEARTBEAT_TIMEOUT_MS", 5_000),
    },
    requirements: {
      pon: booleanSetting(env, "HEALTH_REQUIRE_PON", false),
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

const PON_SOURCE_NAMES = Object.freeze([
  "api_health",
  "api_markets",
  "api_platform_token",
  "api_token_list",
  "chain",
  "delivery",
]);
const PON_OPERATIONAL_ERROR_CODES = new Set([
  "PON_ALERT_NOT_DURABLE",
  "PON_API_CHAIN_INFRASTRUCTURE_MISMATCH",
  "PON_API_CHAIN_MISMATCH",
  "PON_CONTROL_EVENT_GAP",
  "PON_FACTORY_BINDING_MISMATCH",
  "PON_FACTORY_CODE_EMPTY",
  "PON_FACTORY_CODE_MISMATCH",
  "PON_FACTORY_DEPLOYMENT_MISMATCH",
  "PON_FACTORY_ROOT_MISMATCH",
  "PON_INFRASTRUCTURE_CODE_EMPTY",
  "PON_LISTING_EVENT_COVERAGE_GAP",
  "PON_LOG_DECODE_FAILED",
  "PON_LOG_FACTORY_MISMATCH",
  "PON_LOG_KIND_INVALID",
  "PON_LOG_RECEIPT_MISMATCH",
  "PON_LOG_TOPIC_INVALID",
  "PON_LOG_TRANSACTION_INVALID",
  "PON_MARKET_EVENT_COVERAGE_GAP",
  "PON_PENDING_CAPACITY_EXCEEDED",
  "PON_PENDING_LOG_MISSING",
  "PON_PENDING_PROOF_MISMATCH",
  "PON_REORG_REWIND_FAILED",
  "PON_RPC_CHAIN_MISMATCH",
  "PON_STATE_IDENTITY_MISMATCH",
  "PON_STATE_INVALID",
  "PON_STATE_VERSION_UNSUPPORTED",
]);
const PON_COVERAGE_ERROR_CODES = new Set([
  "PON_API_BLOCK_STALE",
  "PON_API_BLOCK_REGRESSION",
  "PON_API_MARKET_DISAPPEARED",
]);
const PON_COVERAGE_ERROR_SOURCES = Object.freeze({
  PON_API_BLOCK_STALE: "api_health",
  PON_API_BLOCK_REGRESSION: "api_health",
  PON_API_MARKET_DISAPPEARED: "api_markets",
});
const PON_TRANSIENT_TRANSPORT_ERROR_CODES = new Set([
  "PON_CHAIN_ID_FAILED",
  "PON_FACTORY_CALL_FAILED",
  "PON_FACTORY_CODE_FAILED",
  "PON_GET_LOGS_FAILED",
  "PON_HEAD_FAILED",
  "PON_PLATFORM_TOKEN_CALL_FAILED",
]);
const PON_MID_CYCLE_REORG_CODES = new Set([
  "PON_SCAN_ANCHOR_CHANGED",
  "PON_LOG_CANONICAL_HASH_MISMATCH",
]);

function ponErrorIsCoverageLimited(code, sources, sourceBackoffs, reorg = null) {
  if (PON_COVERAGE_ERROR_CODES.has(code)) {
    const expectedSource = PON_COVERAGE_ERROR_SOURCES[code];
    return String(sources[expectedSource]?.lastErrorCode || "") === code
      && sourceBackoffs[expectedSource]?.active === true;
  }
  if (["PON_HTTP_FAILED", "PON_HTTP_BODY_FAILED", "PON_HTTP_STATUS"].includes(code)) {
    return PON_SOURCE_NAMES.some((name) => {
      if (!name.startsWith("api_")
        || String(sources[name]?.lastErrorCode || "") !== code
        || sourceBackoffs[name]?.active !== true) return false;
      const error = String(sources[name]?.lastError || "");
      if (code === "PON_HTTP_STATUS") return /\bHTTP\s+(?:40[13]|429|5\d\d)\b/i.test(error);
      return /(?:timeout|timed out|abort|fetch failed|connect|socket|network|econn|enotfound|eai_again|terminated|stream)/i
        .test(error);
    });
  }
  if (PON_MID_CYCLE_REORG_CODES.has(code)) {
    return String(sources.chain?.lastErrorCode || "") === code
      && sourceBackoffs.chain?.active === true
      && reorg?.recoveryPending === true
      && Number.isSafeInteger(reorg?.midCycleAnchorFailures)
      && reorg.midCycleAnchorFailures > 0
      && Number.isSafeInteger(sources.chain?.consecutiveFailures)
      && sources.chain.consecutiveFailures > 0
      && sources.chain.consecutiveFailures <= PON_MID_CYCLE_RECOVERY_FAILURE_LIMIT
      && reorg.lastAnchorFailureCode === code
      && reorg.lastAnchorFailureAt === sources.chain?.lastAttemptAt;
  }
  if (!PON_TRANSIENT_TRANSPORT_ERROR_CODES.has(code)) return false;
  return PON_SOURCE_NAMES.some((name) => {
    const source = sources[name];
    if (String(source?.lastErrorCode || "") !== code || sourceBackoffs[name]?.active !== true) return false;
    return /(?:timeout|timed out|abort|fetch failed|connect|socket|network|econn|enotfound|eai_again|429|rate.?limit|40[13]|forbidden|waf)/i
      .test(String(source?.lastError || ""));
  });
}

function ponStateRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function ponBoundedKey(value, maximum = 512) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function ponNormalizedText(value, maximum) {
  if (typeof value !== "string") return false;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized === value
    && normalized.length > 0
    && normalized.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(normalized);
}

function ponSafeTicker(value) {
  return ponNormalizedText(value, 24) && !PON_DANGEROUS_RECORD_KEYS.has(value.toLowerCase());
}

function ponAddress(value, { allowZero = false } = {}) {
  if (!/^0x[0-9a-f]{40}$/i.test(String(value || ""))) return false;
  return allowZero || !/^0x0{40}$/i.test(String(value));
}

function ponHash(value) {
  return /^0x[0-9a-f]{64}$/i.test(String(value || ""));
}

function ponSafeCount(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function ponStateReasonKey(value) {
  return String(value || "unknown").slice(0, 120).replace(/[^\w.:-]/g, "_");
}

function ponDecimalSupplyRaw(value, decimals) {
  const source = String(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(source) || !ponSafeCount(decimals, 255)) return null;
  const [whole, fraction = ""] = source.split(".");
  if (fraction.length > decimals) return null;
  try {
    return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`).toString();
  } catch {
    return null;
  }
}

function ponExpectedIdentity(value) {
  return value?.chainId === PON_CHAIN_ID
    && String(value?.factory || "").toLowerCase() === PON_FACTORY
    && String(value?.factoryCodeHash || "").toLowerCase() === PON_FACTORY_RUNTIME_HASH
    && String(value?.deploymentTransaction || "").toLowerCase() === PON_FACTORY_DEPLOY_TRANSACTION
    && value?.deploymentBlock === PON_FACTORY_DEPLOY_BLOCK;
}

function ponHealthExpectedIdentity(value) {
  return value?.expectedChainId === PON_CHAIN_ID
    && String(value?.expectedFactory || "").toLowerCase() === PON_FACTORY
    && String(value?.expectedFactoryCodeHash || "").toLowerCase() === PON_FACTORY_RUNTIME_HASH;
}

function ponObservedIdentity(value) {
  return value?.observedChainId === PON_CHAIN_ID
    && String(value?.observedFactory || "").toLowerCase() === PON_FACTORY
    && String(value?.observedFactoryCodeHash || "").toLowerCase() === PON_FACTORY_RUNTIME_HASH;
}

function ponXStatusId(value) {
  return /^[1-9]\d{5,23}$/.test(String(value || ""));
}

function ponXDependencyBackoff(item, nowMs, maximumAgeSeconds) {
  if (!ponStateRecord(item) || item.circuitState !== "open") return false;
  const status = normalizedStatus(item.status);
  if (!["backoff", "blocked", "error", "rate_limited", "source_limited", "unavailable", "waf_blocked"]
    .includes(status)) return false;
  const attemptMs = latestInstant([item.lastAttemptAt, item.checkedAt, item.lastErrorAt], nowMs);
  const retryMs = scheduledRetryInstant(
    [item.circuitUntil, item.retryAfter, item.nextAttemptAt],
    nowMs,
    maximumAgeSeconds,
  );
  return retryMs !== null
    && (retryMs >= nowMs || (attemptMs !== null && ageSeconds(attemptMs, nowMs) <= maximumAgeSeconds));
}

function evaluatePonX(record, previous, nowMs, maximumAgeSeconds, operationalReasons, coverageReasons, warnings) {
  const summary = {
    statePresent: record.parseError === null,
    baselined: false,
    status: "unknown",
    latestId: null,
    cursorCheckedAt: null,
    healthCheckedAt: null,
    activeSourceId: null,
    timelineStatus: "unknown",
    timelineLastSuccessAt: null,
    verificationStatus: "unknown",
    verificationIdentity: null,
    cursorGapStatus: null,
    delayedRecoveryStatus: null,
    gapSince: null,
    upstreamBackoff: false,
  };
  if (record.parseError === "missing") {
    coverageReasons.push("pon_x_baseline_pending");
    return summary;
  }
  if (record.parseError) {
    operationalReasons.push(`pon_x_state_invalid:${record.parseError}`);
    return summary;
  }

  const state = record.value;
  const cursor = state?.[PON_X_HANDLE];
  const healthRoot = state?._health;
  const health = ponStateRecord(healthRoot) ? healthRoot[PON_X_HANDLE] : undefined;
  if (healthRoot !== undefined && !ponStateRecord(healthRoot)) {
    operationalReasons.push("pon_x_state_schema_invalid:_health");
  }
  if (cursor === undefined || cursor === null) {
    coverageReasons.push("pon_x_baseline_pending");
    if (health !== undefined && !ponStateRecord(health)) {
      operationalReasons.push("pon_x_state_schema_invalid:_health.pondotfun");
    }
    return summary;
  }
  if (!ponStateRecord(cursor) || !ponXStatusId(cursor.latestId)) {
    operationalReasons.push("pon_x_state_schema_invalid:pondotfun");
    return summary;
  }
  summary.baselined = true;
  summary.latestId = cursor.latestId;
  const cursorCheckedMs = parsedInstant(cursor.checkedAt, nowMs);
  summary.cursorCheckedAt = cursorCheckedMs === null ? null : new Date(cursorCheckedMs).toISOString();
  if (cursorCheckedMs === null
    || !ponStateRecord(cursor.profile)
    || String(cursor.profile.handle || "").toLowerCase() !== PON_X_HANDLE
    || !ponBoundedKey(cursor.profile.name, 100)) {
    operationalReasons.push("pon_x_state_schema_invalid:pondotfun");
  }
  if (!ponStateRecord(health)) {
    operationalReasons.push("pon_x_state_schema_invalid:_health.pondotfun");
    return summary;
  }

  const status = normalizedStatus(health.status);
  summary.status = status.slice(0, 80);
  if (!["healthy", "degraded", "error", "backoff", "unknown"].includes(status)) {
    operationalReasons.push("pon_x_state_schema_invalid:_health.pondotfun.status");
  }
  const healthCheckedMs = parsedInstant(health.checkedAt, nowMs);
  summary.healthCheckedAt = healthCheckedMs === null ? null : new Date(healthCheckedMs).toISOString();
  if (healthCheckedMs === null) {
    operationalReasons.push("pon_x_state_schema_invalid:_health.pondotfun.checkedAt");
  }
  if (!ponStateRecord(health.sources)) {
    operationalReasons.push("pon_x_state_schema_invalid:_health.pondotfun.sources");
  }
  const sources = ponStateRecord(health.sources) ? health.sources : {};
  if (health.activeSource !== undefined && !ponBoundedKey(health.activeSource, 2_000)) {
    operationalReasons.push("pon_x_state_schema_invalid:_health.pondotfun.activeSource");
  }
  const activeSource = typeof health.activeSource === "string" ? sources[health.activeSource] : null;
  const activeSourceId = String(health.activeSourceId || "");
  const timelineStatus = normalizedStatus(activeSource?.status);
  summary.activeSourceId = activeSourceId ? activeSourceId.slice(0, 80) : null;
  summary.timelineStatus = timelineStatus.slice(0, 80);
  const timelineIdentity = String(activeSource?.source || activeSourceId || "");
  const timelineSuccessMs = parsedInstant(activeSource?.lastSuccessAt, nowMs);
  summary.timelineLastSuccessAt = timelineSuccessMs === null ? null : new Date(timelineSuccessMs).toISOString();
  const timelineComplete = activeSourceId === "fxtwitter_numeric_id"
    && ponStateRecord(activeSource)
    && timelineStatus === "healthy"
    && timelineIdentity === "fxtwitter_numeric_id"
    && timelineSuccessMs !== null
    && ageSeconds(timelineSuccessMs, nowMs) <= maximumAgeSeconds;

  const verification = health.criticalVerification;
  if (verification !== undefined && !ponStateRecord(verification)) {
    operationalReasons.push("pon_x_state_schema_invalid:_health.pondotfun.criticalVerification");
  }
  const verificationStatus = normalizedStatus(verification?.status);
  const verificationIdentity = String(verification?.identity || "");
  summary.verificationStatus = verificationStatus.slice(0, 80);
  summary.verificationIdentity = verificationIdentity ? verificationIdentity.slice(0, 200) : null;
  const verificationComplete = ponStateRecord(verification)
    && verificationStatus === "healthy"
    && verificationIdentity === PON_X_VERIFICATION_IDENTITY
    && parsedInstant(verification.lastSuccessAt, nowMs) !== null;
  if (verificationStatus === "healthy" && verificationIdentity !== PON_X_VERIFICATION_IDENTITY) {
    operationalReasons.push("pon_x_verification_identity_invalid");
  }

  const activeTimelineBackoff = ponXDependencyBackoff(activeSource, nowMs, maximumAgeSeconds);
  const activeVerificationBackoff = ponXDependencyBackoff(verification, nowMs, maximumAgeSeconds);
  const dependencyBackoff = activeTimelineBackoff || activeVerificationBackoff;
  summary.upstreamBackoff = dependencyBackoff;
  if (dependencyBackoff) warnings.push("pon_x_upstream_backoff");
  if (!timelineComplete) coverageReasons.push("pon_x_numeric_timeline_incomplete");
  if (!verificationComplete) coverageReasons.push("pon_x_identity_verification_incomplete");
  if (["error", "backoff", "unknown"].includes(status)) coverageReasons.push(`pon_x_status_${status}`);
  if (health.slaStatus === "source_limited") warnings.push("pon_x_optional_discovery_source_limited");

  const coverage = health.coverage;
  if (coverage !== undefined && !ponStateRecord(coverage)) {
    operationalReasons.push("pon_x_state_schema_invalid:_health.pondotfun.coverage");
  }
  const cursorGap = ponStateRecord(coverage) ? coverage.cursorGap : undefined;
  if (cursorGap !== undefined) {
    if (!ponStateRecord(cursorGap) || !["complete", "incomplete"].includes(cursorGap.status)) {
      operationalReasons.push("pon_x_state_schema_invalid:coverage.cursorGap");
    } else {
      summary.cursorGapStatus = cursorGap.status;
      if (cursorGap.status === "incomplete") {
        const valid = PON_X_CURSOR_GAP_REASONS.has(cursorGap.reason)
          && cursorGap.cursorId === cursor.latestId
          && (cursorGap.newestSeenId === null || ponXStatusId(cursorGap.newestSeenId))
          && (cursorGap.oldestSeenId === null || ponXStatusId(cursorGap.oldestSeenId))
          && parsedInstant(cursorGap.detectedAt, nowMs) !== null
          && ponBoundedKey(cursorGap.source, 2_000);
        if (!valid) operationalReasons.push("pon_x_state_schema_invalid:coverage.cursorGap");
        coverageReasons.push(`pon_x_cursor_gap:${ponStateReasonKey(cursorGap.reason)}`);
      } else if (parsedInstant(cursorGap.resolvedAt, nowMs) === null) {
        operationalReasons.push("pon_x_state_schema_invalid:coverage.cursorGap");
      }
    }
  }

  const gapSinceMs = health.gapSince === undefined ? null : parsedInstant(health.gapSince, nowMs);
  if (health.gapSince !== undefined && gapSinceMs === null) {
    operationalReasons.push("pon_x_state_schema_invalid:_health.pondotfun.gapSince");
  }
  summary.gapSince = gapSinceMs === null ? null : new Date(gapSinceMs).toISOString();
  const delayedRecovery = ponStateRecord(coverage) ? coverage.delayedRecovery : undefined;
  if (delayedRecovery !== undefined) {
    if (!ponStateRecord(delayedRecovery)
      || !["complete", "in_progress", "incomplete"].includes(delayedRecovery.status)) {
      operationalReasons.push("pon_x_state_schema_invalid:coverage.delayedRecovery");
    } else {
      summary.delayedRecoveryStatus = delayedRecovery.status;
      const delayedGapMs = parsedInstant(delayedRecovery.gapSince, nowMs);
      if (delayedGapMs === null
        || (delayedRecovery.cursorId !== undefined && !ponXStatusId(delayedRecovery.cursorId))) {
        operationalReasons.push("pon_x_state_schema_invalid:coverage.delayedRecovery");
      }
      if (delayedRecovery.status === "in_progress") {
        if (gapSinceMs === null || delayedRecovery.gapSince !== health.gapSince) {
          operationalReasons.push("pon_x_state_schema_invalid:coverage.delayedRecovery");
        }
        coverageReasons.push("pon_x_delayed_recovery_in_progress");
        warnings.push("pon_x_delayed_recovery_in_progress");
      } else if (delayedRecovery.status === "incomplete") {
        if (delayedRecovery.reason !== PON_X_RECOVERY_WINDOW_REASON
          || gapSinceMs === null
          || delayedRecovery.gapSince !== health.gapSince
          || delayedRecovery.cursorId !== cursor.latestId
          || !ponXStatusId(delayedRecovery.blockedTweetId)
          || parsedInstant(delayedRecovery.checkedAt, nowMs) === null) {
          operationalReasons.push("pon_x_state_schema_invalid:coverage.delayedRecovery");
        }
        coverageReasons.push("pon_x_delayed_recovery_incomplete");
      } else if (gapSinceMs !== null
        || delayedRecovery.cursorId !== cursor.latestId
        || parsedInstant(delayedRecovery.completedAt, nowMs) === null) {
        operationalReasons.push("pon_x_state_schema_invalid:coverage.delayedRecovery");
      }
    }
  } else if (gapSinceMs !== null) {
    coverageReasons.push("pon_x_gap_active");
  }

  const staleDuringBackoff = (reason) => {
    if (dependencyBackoff) coverageReasons.push(`${reason}_during_upstream_backoff`);
    else operationalReasons.push(reason);
  };
  if (record.ageSeconds === null || record.ageSeconds > maximumAgeSeconds) {
    staleDuringBackoff("pon_x_state_stale");
  }
  if (healthCheckedMs !== null && ageSeconds(healthCheckedMs, nowMs) > maximumAgeSeconds) {
    staleDuringBackoff("pon_x_worker_stalled");
  }
  if (cursorCheckedMs !== null && ageSeconds(cursorCheckedMs, nowMs) > maximumAgeSeconds) {
    staleDuringBackoff("pon_x_cursor_frozen");
  }

  const priorX = previous?.semantic?.x;
  if (ponXStatusId(priorX?.latestId)) {
    try {
      if (BigInt(cursor.latestId) < BigInt(priorX.latestId)) operationalReasons.push("pon_x_cursor_regressed");
    } catch {
      operationalReasons.push("pon_x_cursor_regressed");
    }
  }
  const priorCursorCheckedMs = parsedInstant(priorX?.cursorCheckedAt, nowMs);
  if (priorCursorCheckedMs !== null && cursorCheckedMs !== null && cursorCheckedMs < priorCursorCheckedMs) {
    operationalReasons.push("pon_x_cursor_timestamp_regressed");
  }
  return summary;
}

function evaluatePon(record, twitterRecord, previous, nowMs, maximumAgeSeconds, required) {
  const combinedRecord = {
    ...record,
    observations: [publicObservation(record), publicObservation(twitterRecord)],
  };
  if (!required) {
    return laneResult({
      id: "pon",
      required: false,
      maximumAgeSeconds,
      record: combinedRecord,
    });
  }

  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, { checkFileAge: false });
  const coverageReasons = [];
  const warnings = [];
  const xSummary = evaluatePonX(
    twitterRecord,
    previous,
    nowMs,
    maximumAgeSeconds,
    operationalReasons,
    coverageReasons,
    warnings,
  );
  if (record.parseError) {
    return laneResult({
      id: "pon",
      maximumAgeSeconds,
      record: combinedRecord,
      operationalReasons,
      coverageReasons,
      warnings,
      semantic: { x: xSummary },
    });
  }

  const state = record.value;
  const health = state?._health;
  const initialized = state?.initialized === true;
  if (state?.version !== PON_STATE_VERSION) operationalReasons.push("pon_state_version_invalid");
  if (typeof state?.initialized !== "boolean") operationalReasons.push("pon_initialized_flag_invalid");
  for (const key of ["cursor", "identity", "listings", "markets", "unmatchedApiMarkets", "pendingMarketEvents"]) {
    if (!ponStateRecord(state?.[key])) operationalReasons.push(`pon_state_schema_invalid:${key}`);
  }
  for (const key of [
    "reorgBaselineMarketRechecks",
    "retiredMarkets",
    "alertOrigins",
    "apiTransitionRevisions",
    "pendingApiTransitions",
  ]) {
    if (state?.[key] !== undefined && !ponStateRecord(state[key])) {
      operationalReasons.push(`pon_state_schema_invalid:${key}`);
    }
  }
  for (const key of ["reorgOrphanedEventKeys", "finalizedCheckpoints", "missedCriticalChanges"]) {
    if (state?.[key] !== undefined && !Array.isArray(state[key])) {
      operationalReasons.push(`pon_state_schema_invalid:${key}`);
    }
  }
  for (const key of ["infrastructure", "curveParams", "platformToken", "platformTokenVerification"]) {
    if (state?.[key] !== null && !ponStateRecord(state?.[key])) {
      operationalReasons.push(`pon_state_schema_invalid:${key}`);
    }
  }
  if (initialized) {
    const platformToken = state?.platformToken;
    const verification = state?.platformTokenVerification;
    const expectedRawSupply = ponStateRecord(platformToken) && ponStateRecord(verification)
      ? ponDecimalSupplyRaw(platformToken.supply, verification.decimals)
      : null;
    if (!ponStateRecord(platformToken)
      || String(platformToken.address || "").toLowerCase() !== PON_PLATFORM_TOKEN
      || platformToken.name !== "Ponfun"
      || platformToken.symbol !== "PONFUN"
      || !Number.isFinite(platformToken.supply)
      || platformToken.supply <= 0
      || !ponStateRecord(verification)
      || String(verification.token || "").toLowerCase() !== PON_PLATFORM_TOKEN
      || verification.codePresent !== true
      || !ponHash(verification.codeHash)
      || verification.name !== platformToken.name
      || verification.symbol !== platformToken.symbol
      || !ponSafeCount(verification.decimals, 255)
      || !/^(?:0|[1-9]\d*)$/.test(String(verification.totalSupplyRaw || ""))
      || expectedRawSupply === null
      || expectedRawSupply !== String(verification.totalSupplyRaw)
      || !ponSafeCount(verification.verifiedBlock)
      || verification.verifiedBlock < PON_FACTORY_DEPLOY_BLOCK
      || !ponHash(verification.verifiedBlockHash)) {
      operationalReasons.push("pon_platform_token_verification_invalid");
    }
  }
  if (!Array.isArray(state?.processedEventKeys)
    || state.processedEventKeys.length > PON_PROCESSED_EVENT_LIMIT
    || new Set(state.processedEventKeys).size !== state.processedEventKeys.length
    || state.processedEventKeys.some((key) => !ponBoundedKey(key))) {
    operationalReasons.push("pon_state_schema_invalid:processedEventKeys");
  }
  if (initialized && parsedInstant(state?.initializedAt, nowMs) === null) {
    operationalReasons.push("pon_initialized_timestamp_missing_or_invalid");
  }
  if (ponStateRecord(state?.pendingMarketEvents)) {
    if (Object.keys(state.pendingMarketEvents).length > PON_PENDING_LIMIT) {
      operationalReasons.push("pon_state_schema_invalid:pendingMarketEvents");
    }
    for (const [eventKey, pending] of Object.entries(state.pendingMarketEvents)) {
      const log = pending?.log;
      const proof = pending?.proof;
      const logIndex = log?.index ?? log?.logIndex;
      const expectedEventKey = ponHash(log?.transactionHash) && ponSafeCount(logIndex) && ponHash(log?.topics?.[0])
        ? `pon-fun:${PON_CHAIN_ID}:${String(log.transactionHash).toLowerCase()}:${logIndex}:${String(log.topics[0]).toLowerCase()}`
        : null;
      const snapshot = pending?.snapshot;
      if (!ponBoundedKey(eventKey)
        || !ponStateRecord(pending)
        || pending.eventKey !== eventKey
        || eventKey !== expectedEventKey
        || !ponStateRecord(snapshot)
        || !ponSafeTicker(snapshot.ticker)
        || !ponNormalizedText(snapshot.symbol, 32)
        || !ponNormalizedText(snapshot.name, 160)
        || !ponAddress(snapshot.coin)
        || !ponAddress(snapshot.vault)
        || !ponAddress(snapshot.curve)
        || !ponAddress(snapshot.creator)
        || !ponSafeCount(snapshot.creatorFeeBps, 10_000)
        || !ponStateRecord(proof)
        || !ponStateRecord(log)
        || String(log?.address || "").toLowerCase() !== PON_FACTORY
        || !/^0x[0-9a-f]{64}$/i.test(String(log?.transactionHash || ""))
        || String(log?.transactionHash || "").toLowerCase() !== String(proof?.transactionHash || "").toLowerCase()
        || !ponSafeCount(log?.blockNumber)
        || log.blockNumber < PON_FACTORY_DEPLOY_BLOCK
        || log.blockNumber !== proof?.blockNumber
        || !ponHash(log?.blockHash)
        || String(log.blockHash).toLowerCase() !== String(proof?.blockHash || "").toLowerCase()
        || !ponSafeCount(logIndex)
        || logIndex !== proof?.logIndex
        || !Array.isArray(log?.topics)
        || log.topics.some((topic) => !ponHash(topic))
        || String(log.topics[0] || "").toLowerCase() !== PON_MARKET_CREATED_TOPIC
        || !/^0x(?:[0-9a-f]{2})*$/i.test(String(log.data || ""))) {
        operationalReasons.push(`pon_state_schema_invalid:pendingMarketEvents.${ponStateReasonKey(eventKey)}`);
      }
    }
  }
  for (const collection of ["markets", "unmatchedApiMarkets"]) {
    if (!ponStateRecord(state?.[collection])) continue;
    const entries = Object.entries(state[collection]);
    const limit = collection === "unmatchedApiMarkets" ? PON_PENDING_LIMIT : PON_MARKET_LIMIT;
    if (entries.length > limit) operationalReasons.push(`pon_state_schema_invalid:${collection}`);
    for (const [coin, market] of entries) {
      const candidate = ponStateRecord(market?.market) ? market.market : market;
      if (!ponAddress(coin)
        || coin !== coin.toLowerCase()
        || !ponStateRecord(market)
        || (candidate.ticker !== undefined && !ponSafeTicker(candidate.ticker))
        || (candidate.coin !== undefined && String(candidate.coin).toLowerCase() !== coin)) {
        operationalReasons.push(`pon_state_schema_invalid:${collection}.${ponStateReasonKey(coin)}`);
      }
    }
  }
  if (ponStateRecord(state?.listings)) {
    const listings = Object.entries(state.listings);
    if (listings.length > PON_MARKET_LIMIT) operationalReasons.push("pon_state_schema_invalid:listings");
    for (const [ticker, listing] of listings) {
      if (!ponSafeTicker(ticker)
        || !ponStateRecord(listing)
        || listing.ticker !== ticker
        || typeof listing.active !== "boolean"
        || !ponSafeCount(listing.poolFee)
        || !ponAddress(listing.stockToken, { allowZero: true })) {
        operationalReasons.push(`pon_state_schema_invalid:listings.${ponStateReasonKey(ticker)}`);
      }
    }
  }
  if (ponStateRecord(state?.reorgBaselineMarketRechecks)) {
    if (Object.keys(state.reorgBaselineMarketRechecks).length > PON_MARKET_LIMIT) {
      operationalReasons.push("pon_state_schema_invalid:reorgBaselineMarketRechecks");
    }
    for (const [coin, recheck] of Object.entries(state.reorgBaselineMarketRechecks)) {
      if (!ponAddress(coin)
        || coin !== coin.toLowerCase()
        || !ponStateRecord(recheck)
        || String(recheck.coin || "").toLowerCase() !== coin
        || !ponSafeTicker(recheck.ticker)
        || parsedInstant(recheck.markedAt, nowMs) === null
        || !ponSafeCount(recheck.rewindFrom)
        || !ponSafeCount(recheck.rewindTo)
        || recheck.rewindFrom < recheck.rewindTo
        || !ponStateRecord(state?.markets?.[coin])) {
        operationalReasons.push(`pon_state_schema_invalid:reorgBaselineMarketRechecks.${ponStateReasonKey(coin)}`);
      }
    }
  }
  if (ponStateRecord(state?.alertOrigins)) {
    const origins = Object.entries(state.alertOrigins);
    if (origins.length > PON_ALERT_ORIGIN_LIMIT) {
      operationalReasons.push("pon_state_schema_invalid:alertOrigins");
    }
    for (const [eventKey, origin] of origins) {
      const rollback = origin?.rollback;
      const rollbackValid = rollback === null || rollback === undefined || (
        ponStateRecord(rollback)
        && ["market", "platform_token", "curve_params", "stock_listing", "infrastructure"].includes(rollback.type)
        && (rollback.type !== "market"
          || (ponAddress(rollback.key) && rollback.key === rollback.key.toLowerCase()))
        && (rollback.type !== "stock_listing" || ponSafeTicker(rollback.key))
        && (rollback.snapshot === null || rollback.snapshot === undefined || ponStateRecord(rollback.snapshot))
        && (rollback.retirement === null || rollback.retirement === undefined || ponStateRecord(rollback.retirement))
      );
      if (!ponBoundedKey(eventKey)
        || !eventKey.startsWith("pon-fun:")
        || !ponStateRecord(origin)
        || !ponSafeCount(origin.blockNumber)
        || origin.blockNumber < PON_FACTORY_DEPLOY_BLOCK
        || !ponHash(origin.blockHash)
        || !ponBoundedKey(origin.kind, 80)
        || parsedInstant(origin.recordedAt, nowMs) === null
        || !rollbackValid
        || (origin.processedKey !== null && origin.processedKey !== undefined
          && !ponBoundedKey(origin.processedKey))) {
        operationalReasons.push(`pon_state_schema_invalid:alertOrigins.${ponStateReasonKey(eventKey)}`);
      }
    }
  }
  if (state?.reorgOrphanedEventKeys !== undefined
    && (!Array.isArray(state.reorgOrphanedEventKeys)
      || state.reorgOrphanedEventKeys.length > PON_ORPHANED_EVENT_LIMIT
      || new Set(state.reorgOrphanedEventKeys).size !== state.reorgOrphanedEventKeys.length
      || state.reorgOrphanedEventKeys.some((key) => !ponBoundedKey(key)))) {
    operationalReasons.push("pon_state_schema_invalid:reorgOrphanedEventKeys");
  }
  if (Array.isArray(state?.finalizedCheckpoints)) {
    let previousCheckpointBlock = null;
    if (state.finalizedCheckpoints.length > PON_FINALIZED_CHECKPOINT_LIMIT) {
      operationalReasons.push("pon_state_schema_invalid:finalizedCheckpoints");
    }
    for (const checkpoint of state.finalizedCheckpoints) {
      if (!ponStateRecord(checkpoint)
        || !ponSafeCount(checkpoint.blockNumber)
        || checkpoint.blockNumber < PON_FACTORY_DEPLOY_BLOCK
        || !ponHash(checkpoint.blockHash)
        || !ponSafeCount(checkpoint.marketCount)
        || !ponSafeCount(checkpoint.listingCount)
        || parsedInstant(checkpoint.recordedAt, nowMs) === null
        || (previousCheckpointBlock !== null && checkpoint.blockNumber <= previousCheckpointBlock)) {
        operationalReasons.push("pon_state_schema_invalid:finalizedCheckpoints.entry");
        break;
      }
      previousCheckpointBlock = checkpoint.blockNumber;
    }
  }
  if (ponStateRecord(state?.retiredMarkets)) {
    const retiredMarkets = Object.entries(state.retiredMarkets);
    if (retiredMarkets.length > PON_MARKET_LIMIT) {
      operationalReasons.push("pon_state_schema_invalid:retiredMarkets");
    }
    for (const [ticker, retirement] of retiredMarkets) {
      if (!ponSafeTicker(ticker)
        || !ponStateRecord(retirement)
        || retirement.ticker !== ticker
        || retirement.active !== false
        || !ponAddress(retirement.stockToken, { allowZero: true })
        || !ponSafeCount(retirement.poolFee, 1_000_000)
        || !ponBoundedKey(retirement.eventKey)
        || !ponBoundedKey(retirement.processedKey)
        || !ponSafeCount(retirement.blockNumber)
        || retirement.blockNumber < PON_FACTORY_DEPLOY_BLOCK
        || !ponHash(retirement.blockHash)
        || !ponHash(retirement.transactionHash)
        || !ponSafeCount(retirement.logIndex)
        || parsedInstant(retirement.retiredAt, nowMs) === null) {
        operationalReasons.push(`pon_state_schema_invalid:retiredMarkets.${ponStateReasonKey(ticker)}`);
      }
    }
  }
  let pendingApiTransitionCount = 0;
  if (ponStateRecord(state?.apiTransitionRevisions)) {
    const revisions = Object.entries(state.apiTransitionRevisions);
    if (revisions.length > PON_MARKET_LIMIT + 1) {
      operationalReasons.push("pon_state_schema_invalid:apiTransitionRevisions");
    }
    for (const [lane, revision] of revisions) {
      const validLane = /^market:0x[a-f0-9]{40}$/.test(lane)
        || lane === `platform-token:${PON_PLATFORM_TOKEN}`;
      if (!validLane || !Number.isSafeInteger(revision) || revision < 1) {
        operationalReasons.push(`pon_state_schema_invalid:apiTransitionRevisions.${ponStateReasonKey(lane)}`);
      }
    }
  }
  if (ponStateRecord(state?.pendingApiTransitions)) {
    const transitions = Object.entries(state.pendingApiTransitions);
    pendingApiTransitionCount = transitions.length;
    if (transitions.length > PON_MARKET_LIMIT + 1) {
      operationalReasons.push("pon_state_schema_invalid:pendingApiTransitions");
    }
    for (const [lane, transition] of transitions) {
      const marketLane = /^market:0x[a-f0-9]{40}$/.test(lane);
      const validLane = marketLane || lane === `platform-token:${PON_PLATFORM_TOKEN}`;
      const expectedPrefix = marketLane
        ? `pon-fun:market-lifecycle:${lane.slice("market:".length)}`
        : `pon-fun:platform-token:${PON_PLATFORM_TOKEN}`;
      if (!validLane
        || !ponStateRecord(transition)
        || transition.lane !== lane
        || !ponBoundedKey(transition.fingerprint, 10_000)
        || !Number.isSafeInteger(transition.revision)
        || transition.revision < 1
        || state.apiTransitionRevisions?.[lane] !== transition.revision
        || !ponSafeCount(transition.apiHealthBlock)
        || transition.apiHealthBlock <= 0
        || !ponSafeCount(transition.bindingBlock)
        || transition.bindingBlock < PON_FACTORY_DEPLOY_BLOCK
        || !ponBoundedKey(transition.eventKey, 768)
        || transition.eventKey !== `${expectedPrefix}:rev:${transition.revision}:api:${transition.apiHealthBlock}:binding:${transition.bindingBlock}`
        || parsedInstant(transition.reservedAt, nowMs) === null) {
        operationalReasons.push(`pon_state_schema_invalid:pendingApiTransitions.${ponStateReasonKey(lane)}`);
      }
    }
    if (pendingApiTransitionCount > 0) coverageReasons.push("pon_api_transitions_pending_delivery");
  }
  let missedCriticalHistoryCount = 0;
  if (Array.isArray(state?.missedCriticalChanges)) {
    missedCriticalHistoryCount = state.missedCriticalChanges.length;
    if (missedCriticalHistoryCount > PON_MISSED_CRITICAL_LIMIT) {
      operationalReasons.push("pon_state_schema_invalid:missedCriticalChanges");
    }
    for (const summary of state.missedCriticalChanges) {
      const recovery = summary?.delayedRecovery;
      const recoveryCursor = recovery?.cursor;
      if (!ponStateRecord(summary)
        || !ponBoundedKey(summary.eventKey, 768)
        || !ponBoundedKey(summary.originalEventKey)
        || !PON_DELAYED_CRITICAL_KINDS.has(summary.kind)
        || summary.priority !== "T2"
        || !ponSafeCount(summary.blockNumber)
        || summary.blockNumber < PON_FACTORY_DEPLOY_BLOCK
        || !ponHash(summary.blockHash)
        || parsedInstant(summary.blockTimestamp, nowMs) === null
        || parsedInstant(summary.observedAt, nowMs) === null
        || !ponStateRecord(summary.changes)
        || parsedInstant(summary.recordedAt, nowMs) === null
        || !ponStateRecord(recovery)
        || recovery.version !== 1
        || recovery.reason !== "monitoring_gap_recovery"
        || parsedInstant(recovery.gapSince, nowMs) === null
        || parsedInstant(recovery.sourceOccurredAt, nowMs) === null
        || parsedInstant(recovery.recoveredAt, nowMs) === null
        || !ponSafeCount(recovery.lagMs)
        || !ponStateRecord(recoveryCursor)
        || !ponSafeCount(recoveryCursor.nextBlockAtRecovery)
        || recoveryCursor.nextBlockAtRecovery <= PON_FACTORY_START_BLOCK
        || recoveryCursor.eventBlock !== summary.blockNumber) {
        operationalReasons.push("pon_state_schema_invalid:missedCriticalChanges.entry");
        break;
      }
    }
  }
  const missedCriticalChangeCount = health?.missedCriticalChangeCount ?? 0;
  const lastMissedCriticalMs = parsedInstant(health?.lastMissedCriticalChangeAt, nowMs);
  if (!ponSafeCount(missedCriticalChangeCount)
    || missedCriticalChangeCount < missedCriticalHistoryCount
    || (missedCriticalChangeCount > 0 && (missedCriticalHistoryCount === 0 || lastMissedCriticalMs === null))) {
    operationalReasons.push("pon_missed_critical_audit_invalid");
  } else if (missedCriticalChangeCount > 0) {
    warnings.push("pon_delayed_critical_recovery_recorded");
  }
  if (!health || typeof health !== "object" || Array.isArray(health)) {
    operationalReasons.push("pon_health_missing_or_invalid");
  }

  const sources = health?.sources && typeof health.sources === "object" && !Array.isArray(health.sources)
    ? health.sources
    : {};
  const sourceSummary = {};
  const sourceBackoffs = Object.fromEntries(PON_SOURCE_NAMES.map((name) => [
    name,
    upstreamBackoffState(sources[name], nowMs, maximumAgeSeconds),
  ]));
  const activeBackoffs = PON_SOURCE_NAMES
    .filter((name) => sourceBackoffs[name].active)
    .map((name) => ({ name, ...sourceBackoffs[name] }));
  const apiDependencyBackoff = activeBackoffs.some(({ name }) => name.startsWith("api_"));
  const errorCodes = new Set([health?.lastErrorCode, ...PON_SOURCE_NAMES.map((name) => sources[name]?.lastErrorCode)]
    .map((value) => String(value || "").trim())
    .filter(Boolean));
  for (const code of errorCodes) {
    if (PON_OPERATIONAL_ERROR_CODES.has(code)
      || (code.startsWith("PON_")
        && !ponErrorIsCoverageLimited(code, sources, sourceBackoffs, health?.reorg))) {
      operationalReasons.push(`pon_integrity_failure:${code}`);
    }
  }

  const apiCoverage = health?.apiCoverage;
  let apiReportedBlock = null;
  let apiFinalizedBlock = null;
  let apiBlockLag = null;
  let apiMaximumBlockLag = null;
  let apiHighWaterBlock = null;
  let apiLastVerifiedMs = null;
  if (!ponStateRecord(apiCoverage)) {
    if (initialized) operationalReasons.push("pon_api_coverage_missing_or_invalid");
  } else {
    apiReportedBlock = apiCoverage.reportedBlock;
    apiFinalizedBlock = apiCoverage.finalizedBlock;
    apiBlockLag = apiCoverage.blockLag;
    apiMaximumBlockLag = apiCoverage.maxBlockLag;
    apiHighWaterBlock = apiCoverage.highWaterBlock;
    apiLastVerifiedMs = parsedInstant(apiCoverage.lastVerifiedAt, nowMs);
    const apiRegressionBackoff = errorCodes.has("PON_API_BLOCK_REGRESSION")
      && ponErrorIsCoverageLimited("PON_API_BLOCK_REGRESSION", sources, sourceBackoffs);
    const apiStaleBackoff = errorCodes.has("PON_API_BLOCK_STALE")
      && ponErrorIsCoverageLimited("PON_API_BLOCK_STALE", sources, sourceBackoffs);
    if (initialized && (!Number.isSafeInteger(apiReportedBlock) || apiReportedBlock <= 0
      || !Number.isSafeInteger(apiFinalizedBlock) || apiFinalizedBlock <= 0
      || !Number.isSafeInteger(apiBlockLag)
      || !Number.isSafeInteger(apiMaximumBlockLag) || apiMaximumBlockLag < 0
      || !Number.isSafeInteger(apiHighWaterBlock) || apiHighWaterBlock <= 0
      || apiBlockLag !== apiFinalizedBlock - apiReportedBlock
      || apiReportedBlock > apiHighWaterBlock
      || (apiReportedBlock < apiHighWaterBlock && !apiRegressionBackoff)
      || (apiStaleBackoff && apiBlockLag <= apiMaximumBlockLag)
      || (apiRegressionBackoff && apiReportedBlock >= apiHighWaterBlock)
      || (apiBlockLag > apiMaximumBlockLag && !apiStaleBackoff && !apiRegressionBackoff))) {
      operationalReasons.push("pon_api_coverage_state_invalid");
    }
    if (initialized && apiLastVerifiedMs === null) {
      operationalReasons.push("pon_api_last_verified_missing_or_invalid");
    } else if (apiLastVerifiedMs !== null && ageSeconds(apiLastVerifiedMs, nowMs) > maximumAgeSeconds) {
      if (sourceBackoffs.api_health.active) coverageReasons.push("pon_api_last_verified_stale_during_backoff");
      else operationalReasons.push("pon_api_last_verified_stale");
    }
  }

  for (const name of PON_SOURCE_NAMES) {
    const source = sources[name];
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      if (initialized) operationalReasons.push(`pon_source_health_missing:${name}`);
      else coverageReasons.push(`pon_source_startup_pending:${name}`);
      sourceSummary[name] = {
        status: "missing",
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastErrorCode: null,
        upstreamBackoff: { active: false, kind: null },
      };
      continue;
    }
    const status = normalizedStatus(source.status);
    const backoff = sourceBackoffs[name];
    const dependencyBackoff = backoff.active
      || (apiDependencyBackoff && ["chain", "delivery"].includes(name));
    const attemptMs = latestInstant([
      source.lastAttemptAt,
      source.checkedAt,
      source.lastErrorAt,
      source.lastSuccessAt,
    ], nowMs);
    const successMs = parsedInstant(source.lastSuccessAt, nowMs);
    if (attemptMs === null) {
      if (initialized) operationalReasons.push(`pon_source_attempt_missing:${name}`);
      else coverageReasons.push(`pon_source_startup_pending:${name}`);
    } else if (ageSeconds(attemptMs, nowMs) > maximumAgeSeconds) {
      if (dependencyBackoff) coverageReasons.push(`pon_source_stale_during_backoff:${name}`);
      else operationalReasons.push(`pon_source_stalled:${name}`);
    }
    if (status !== "healthy") {
      coverageReasons.push(`pon_source_incomplete:${name}:${status}`);
      if (backoff.active) warnings.push(`pon_source_backoff:${name}:${backoff.kind}`);
    }
    if (status === "healthy" && successMs === null) {
      operationalReasons.push(`pon_source_success_timestamp_invalid:${name}`);
    } else if (successMs === null || ageSeconds(successMs, nowMs) > maximumAgeSeconds) {
      coverageReasons.push(`pon_source_last_success_stale:${name}`);
    }
    sourceSummary[name] = {
      status,
      lastAttemptAt: attemptMs === null ? null : new Date(attemptMs).toISOString(),
      lastSuccessAt: successMs === null ? null : new Date(successMs).toISOString(),
      lastErrorCode: source.lastErrorCode ? String(source.lastErrorCode).slice(0, 120) : null,
      upstreamBackoff: backoff,
    };
  }

  const anyBackoff = activeBackoffs.length > 0;
  const nextAttemptMs = scheduledRetryInstant(
    [health?.nextAttemptAt, ...PON_SOURCE_NAMES.map((name) => sources[name]?.nextAttemptAt)],
    nowMs,
    maximumAgeSeconds,
  );
  if (record.ageSeconds === null || record.ageSeconds > maximumAgeSeconds) {
    (anyBackoff ? coverageReasons : operationalReasons).push(
      anyBackoff ? "pon_state_stale_during_upstream_backoff" : "pon_state_stale",
    );
  }

  const checkedMs = latestInstant([health?.checkedAt, state?.checkedAt], nowMs);
  if (checkedMs === null) {
    if (initialized) operationalReasons.push("pon_checked_timestamp_missing_or_invalid");
    else coverageReasons.push("pon_baseline_pending");
  } else if (ageSeconds(checkedMs, nowMs) > maximumAgeSeconds) {
    (anyBackoff ? coverageReasons : operationalReasons).push(
      anyBackoff ? "pon_checked_stale_during_upstream_backoff" : "pon_checked_stale",
    );
  }

  const status = normalizedStatus(health?.status);
  if (status !== "healthy") coverageReasons.push(`pon_status_${status}`);
  if (SOURCE_LIMITED_STATUSES.has(status) || anyBackoff) warnings.push("pon_upstream_coverage_limited");

  const identity = state?.identity;
  const healthIdentity = health?.identity;
  if (!ponExpectedIdentity(identity)) operationalReasons.push("pon_pinned_identity_mismatch");
  if (!ponHealthExpectedIdentity(healthIdentity)) operationalReasons.push("pon_health_expected_identity_mismatch");
  if (initialized && !ponObservedIdentity(healthIdentity)) operationalReasons.push("pon_observed_identity_mismatch");
  if (initialized && identity?.deploymentVerified !== true) operationalReasons.push("pon_deployment_not_verified");

  const reorg = health?.reorg && typeof health.reorg === "object" && !Array.isArray(health.reorg)
    ? health.reorg
    : {};
  const reorgCount = Number(reorg.count ?? 0);
  const reorgDetectedMs = parsedInstant(reorg.lastDetectedAt, nowMs);
  const reorgFrom = reorg.rewindFrom === null || reorg.rewindFrom === undefined
    ? null : Number(reorg.rewindFrom);
  const reorgTo = reorg.rewindTo === null || reorg.rewindTo === undefined
    ? null : Number(reorg.rewindTo);
  const commonAncestorBlock = reorg.commonAncestorBlock === null || reorg.commonAncestorBlock === undefined
    ? null : Number(reorg.commonAncestorBlock);
  const commonAncestorProven = reorg.commonAncestorProven;
  const orphanedAlertCount = Number(reorg.orphanedAlertCount ?? 0);
  const midCycleAnchorFailures = Number(reorg.midCycleAnchorFailures ?? 0);
  const recentOrphanedKeys = reorg.lastOrphanedEventKeys;
  const recoveryPending = reorg.recoveryPending ?? false;
  const unprovenAtMs = reorg.unprovenAt === null || reorg.unprovenAt === undefined
    ? null : parsedInstant(reorg.unprovenAt, nowMs);
  const lastAnchorFailureMs = parsedInstant(reorg.lastAnchorFailureAt, nowMs);
  const lastAnchorFailureCode = reorg.lastAnchorFailureCode ?? null;
  const hasReorg = Number.isSafeInteger(reorgCount) && reorgCount > 0;
  if (!Number.isSafeInteger(reorgCount) || reorgCount < 0
    || (hasReorg && (reorgDetectedMs === null
      || !Number.isSafeInteger(reorgFrom)
      || !Number.isSafeInteger(reorgTo)
      || reorgTo <= 0
      || reorgFrom < reorgTo
      || commonAncestorProven !== true
      || !Number.isSafeInteger(commonAncestorBlock)
      || commonAncestorBlock !== reorgTo - 1))
    || !Number.isSafeInteger(orphanedAlertCount)
    || orphanedAlertCount < 0
    || !Number.isSafeInteger(midCycleAnchorFailures)
    || midCycleAnchorFailures < 0
    || typeof recoveryPending !== "boolean"
    || (reorg.unprovenAt !== null && reorg.unprovenAt !== undefined && unprovenAtMs === null)
    || (midCycleAnchorFailures > 0 && (lastAnchorFailureMs === null
      || !PON_MID_CYCLE_REORG_CODES.has(lastAnchorFailureCode)))
    || !Array.isArray(recentOrphanedKeys)
    || recentOrphanedKeys.length > PON_RECENT_ORPHAN_LIMIT
    || recentOrphanedKeys.some((key) => !ponBoundedKey(key))) {
    operationalReasons.push("pon_reorg_state_invalid");
  }
  const lastOrphanedMs = parsedInstant(reorg.lastOrphanedAt, nowMs);
  if (orphanedAlertCount > 0 && lastOrphanedMs === null) {
    operationalReasons.push("pon_reorg_state_invalid");
  }

  const cursor = state?.cursor;
  let progress = null;
  let nextBlock = null;
  let lastScannedBlock = null;
  let marketCountAtCursor = null;
  let listingCountAtCursor = null;
  let stockListingEventsSinceSnapshot = null;
  if (!initialized) {
    coverageReasons.push("pon_baseline_pending");
  } else if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
    operationalReasons.push("pon_cursor_missing_or_invalid");
  } else {
    nextBlock = cursor.nextBlock;
    lastScannedBlock = cursor.lastScannedBlock;
    marketCountAtCursor = cursor.marketCountAtCursor;
    listingCountAtCursor = cursor.listingCountAtCursor;
    stockListingEventsSinceSnapshot = cursor.stockListingEventsSinceSnapshot;
    if (!Number.isSafeInteger(nextBlock) || nextBlock <= PON_FACTORY_START_BLOCK
      || !Number.isSafeInteger(lastScannedBlock) || lastScannedBlock < PON_FACTORY_START_BLOCK
      || nextBlock !== lastScannedBlock + 1
      || !/^0x[0-9a-f]{64}$/i.test(String(cursor.lastScannedBlockHash || ""))
      || parsedInstant(cursor.baselineEstablishedAt, nowMs) === null
      || !Number.isSafeInteger(marketCountAtCursor) || marketCountAtCursor < 0
      || !Number.isSafeInteger(listingCountAtCursor) || listingCountAtCursor < 0
      || !Number.isSafeInteger(stockListingEventsSinceSnapshot) || stockListingEventsSinceSnapshot < 0) {
      operationalReasons.push("pon_cursor_missing_or_invalid");
    } else {
      const cursorCheckpoint = Array.isArray(state.finalizedCheckpoints)
        ? state.finalizedCheckpoints.find((checkpoint) => checkpoint.blockNumber === lastScannedBlock)
        : null;
      if (!cursorCheckpoint
        || String(cursorCheckpoint.blockHash || "").toLowerCase() !== String(cursor.lastScannedBlockHash).toLowerCase()
        || cursorCheckpoint.marketCount !== marketCountAtCursor
        || cursorCheckpoint.listingCount !== listingCountAtCursor) {
        operationalReasons.push("pon_cursor_checkpoint_missing_or_mismatched");
      }
      const chainSourceAt = latestInstant([
        sources.chain?.lastSuccessAt,
        sources.chain?.lastAttemptAt,
        health?.checkedAt,
      ], nowMs);
      progress = progressRecord({
        key: "ponNextBlock",
        value: nextBlock,
        sourceAtMs: chainSourceAt ?? record.mtimeMs,
        previous: previous?.progress,
        nowMs,
        maxAgeSeconds: maximumAgeSeconds,
      });
      if (progress.regressed) {
        const checkpoints = Array.isArray(state.finalizedCheckpoints) ? state.finalizedCheckpoints : [];
        const ancestorCheckpoint = checkpoints.find((checkpoint) => checkpoint.blockNumber === commonAncestorBlock);
        const cursorCheckpoint = checkpoints.find((checkpoint) => checkpoint.blockNumber === lastScannedBlock);
        const verifiedRecentRewind = hasReorg
          && commonAncestorProven === true
          && commonAncestorBlock === reorgTo - 1
          && ponHash(ancestorCheckpoint?.blockHash)
          && ponHash(cursorCheckpoint?.blockHash)
          && String(cursorCheckpoint.blockHash).toLowerCase() === String(cursor.lastScannedBlockHash).toLowerCase()
          && reorgDetectedMs !== null
          && ageSeconds(reorgDetectedMs, nowMs) <= maximumAgeSeconds
          && nextBlock >= reorgTo
          && nextBlock <= reorgFrom + 1
          && Number(previous?.progress?.value) <= reorgFrom + 1;
        if (verifiedRecentRewind) {
          coverageReasons.push("pon_cursor_rewound_for_finalized_reorg");
          warnings.push("pon_finalized_reorg_recovery");
        } else operationalReasons.push("pon_cursor_regressed");
      }
      if (progress.frozen) {
        if (anyBackoff) coverageReasons.push("pon_cursor_frozen_during_upstream_backoff");
        else operationalReasons.push("pon_cursor_frozen");
      }
    }
  }

  const pendingMarketCount = state?.pendingMarketEvents && typeof state.pendingMarketEvents === "object"
    && !Array.isArray(state.pendingMarketEvents) ? Object.keys(state.pendingMarketEvents).length : 0;
  const unmatchedApiMarketCount = state?.unmatchedApiMarkets && typeof state.unmatchedApiMarkets === "object"
    && !Array.isArray(state.unmatchedApiMarkets) ? Object.keys(state.unmatchedApiMarkets).length : 0;
  if (pendingMarketCount > 0) coverageReasons.push("pon_pending_market_proofs");
  if (unmatchedApiMarketCount > 0) coverageReasons.push("pon_unmatched_api_markets");

  return laneResult({
    id: "pon",
    maximumAgeSeconds,
    record: combinedRecord,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      stateVersion: state?.version ?? null,
      initialized,
      status,
      checkedAt: checkedMs === null ? null : new Date(checkedMs).toISOString(),
      lastSuccessAt: isoOrNull(health?.lastSuccessAt, nowMs),
      nextAttemptAt: nextAttemptMs === null ? null : new Date(nextAttemptMs).toISOString(),
      cursor: {
        nextBlock: Number.isSafeInteger(nextBlock) ? nextBlock : null,
        lastScannedBlock: Number.isSafeInteger(lastScannedBlock) ? lastScannedBlock : null,
        marketCountAtCursor: Number.isSafeInteger(marketCountAtCursor) ? marketCountAtCursor : null,
        listingCountAtCursor: Number.isSafeInteger(listingCountAtCursor) ? listingCountAtCursor : null,
        stockListingEventsSinceSnapshot: Number.isSafeInteger(stockListingEventsSinceSnapshot)
          ? stockListingEventsSinceSnapshot : null,
      },
      identity: {
        expectedChainId: PON_CHAIN_ID,
        expectedFactory: PON_FACTORY,
        expectedFactoryCodeHash: PON_FACTORY_RUNTIME_HASH,
        observedChainId: Number.isSafeInteger(Number(healthIdentity?.observedChainId))
          ? Number(healthIdentity.observedChainId) : null,
        observedFactory: healthIdentity?.observedFactory || null,
        observedFactoryCodeHash: healthIdentity?.observedFactoryCodeHash || null,
        deploymentVerified: identity?.deploymentVerified === true,
      },
      sources: sourceSummary,
      apiCoverage: {
        reportedBlock: Number.isSafeInteger(apiReportedBlock) ? apiReportedBlock : null,
        finalizedBlock: Number.isSafeInteger(apiFinalizedBlock) ? apiFinalizedBlock : null,
        blockLag: Number.isSafeInteger(apiBlockLag) ? apiBlockLag : null,
        maxBlockLag: Number.isSafeInteger(apiMaximumBlockLag) ? apiMaximumBlockLag : null,
        highWaterBlock: Number.isSafeInteger(apiHighWaterBlock) ? apiHighWaterBlock : null,
        lastVerifiedAt: apiLastVerifiedMs === null ? null : new Date(apiLastVerifiedMs).toISOString(),
      },
      activeBackoffSources: activeBackoffs.map(({ name }) => name),
      reorg: {
        count: Number.isSafeInteger(reorgCount) && reorgCount >= 0 ? reorgCount : null,
        lastDetectedAt: reorgDetectedMs === null ? null : new Date(reorgDetectedMs).toISOString(),
        rewindFrom: Number.isSafeInteger(reorgFrom) ? reorgFrom : null,
        rewindTo: Number.isSafeInteger(reorgTo) ? reorgTo : null,
        commonAncestorBlock: Number.isSafeInteger(commonAncestorBlock) ? commonAncestorBlock : null,
        commonAncestorProven: typeof commonAncestorProven === "boolean" ? commonAncestorProven : null,
        orphanedAlertCount: Number.isSafeInteger(orphanedAlertCount) && orphanedAlertCount >= 0
          ? orphanedAlertCount : null,
        lastOrphanedAt: lastOrphanedMs === null ? null : new Date(lastOrphanedMs).toISOString(),
        recentOrphanedEventCount: Array.isArray(recentOrphanedKeys) ? recentOrphanedKeys.length : null,
        midCycleAnchorFailures: Number.isSafeInteger(midCycleAnchorFailures) && midCycleAnchorFailures >= 0
          ? midCycleAnchorFailures : null,
        lastAnchorFailureAt: lastAnchorFailureMs === null ? null : new Date(lastAnchorFailureMs).toISOString(),
        lastAnchorFailureCode: PON_MID_CYCLE_REORG_CODES.has(lastAnchorFailureCode)
          ? lastAnchorFailureCode : null,
        recoveryPending,
        unprovenAt: unprovenAtMs === null ? null : new Date(unprovenAtMs).toISOString(),
      },
      pendingMarketCount,
      unmatchedApiMarketCount,
      pendingApiTransitionCount,
      missedCriticalChanges: {
        total: ponSafeCount(missedCriticalChangeCount) ? missedCriticalChangeCount : null,
        retained: missedCriticalHistoryCount,
        lastRecordedAt: lastMissedCriticalMs === null ? null : new Date(lastMissedCriticalMs).toISOString(),
      },
      x: xSummary,
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
    ponRecord,
    twitterRecord,
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
    readJsonRecord(dataDir, "pon-state.json", nowMs),
    readJsonRecord(dataDir, "twitter-state.json", nowMs),
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
    evaluatePon(
      ponRecord,
      twitterRecord,
      previousLanes.pon,
      nowMs,
      limits.ponAgeSeconds,
      requirements.pon,
    ),
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
