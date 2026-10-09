import { createHash } from "node:crypto";
import { FLAP_PORTAL_VERIFIED_VERSION as FLAP_QUOTE_PORTAL_VERSION,
  FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
  FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH as FLAP_QUOTE_PORTAL_IMPLEMENTATION_HASH } from '../src/flap-portal-pins.js';
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readLaunchdService } from "../src/runtime-service-health.js";
import { isStrictGeniusEvent } from "../src/genius-source-policy.js";
import { GMGN_FLOW_CHAINS, GMGN_HOT_ONLY_CHAINS, gmgnFlowAddress, isGmgnFlowEvent } from "../src/gmgn-flow-signal.js";

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
const MORPH_STATE_VERSION = 1;
const MORPH_CHAIN_ID = 2818;
const FLAP_QUOTE_STATE_VERSION = 1;
const FLAP_QUOTE_CHAIN_ID = 56;
const FLAP_QUOTE_PORTAL = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
const FLAP_QUOTE_PORTAL_RUNTIME_HASH = "0x0a3fe6f701ee3cb432f45912e054896327ce5902337eae4d62d01406005a91c3";
const FLAP_QUOTE_PORTAL_IMPLEMENTATION = FLAP_PORTAL_VERIFIED_IMPLEMENTATION.toLowerCase();
const GENIUS_FACTORY = "0x78eae9537c0ef90dfe9b7ae964682fe8138afe31";
const GENIUS_FACTORY_CODE_HASH = "0x416f19c32fbf75ea1a0cd2f51d05f0722f1f4cb0dbaf8f00cb22832345d4eef6";
const GENIUS_START_BLOCK = 122_266_383;
const GENIUS_SOURCE_KEYS = [
  "genius_manifest", "genius_about", "genius_integrate",
  "genius_x_terminal", "genius_x_foundation", "genius_chain",
];
const GENIUS_SOURCE_STATUSES = new Set(["healthy", "backoff", "partial", "initializing"]);
const GENIUS_INTEGRITY_FAILURE_CODES = new Set([
  "GENIUS_STATE_INVALID", "GENIUS_CURSOR_INVALID", "GENIUS_TOKEN_IDENTITY_INVALID",
  "GENIUS_FACTORY_IDENTITY", "GENIUS_WRONG_CHAIN", "GENIUS_CANONICAL_ANCHOR_CHANGED",
  "GENIUS_LOG_CONSENSUS", "GENIUS_INVALID_LOG", "GENIUS_UNKNOWN_EVENT", "GENIUS_REORG",
  "GENIUS_DOCUMENT_IDENTITY_INVALID", "GENIUS_RESPONSE_ORIGIN_MISMATCH",
  "GENIUS_MANIFEST_SCHEMA_INVALID", "GENIUS_CONTENT_TYPE_INVALID", "GENIUS_304_WITHOUT_BASELINE",
  "GENIUS_PENDING_CAPACITY", "GENIUS_MENTIONED_TOKEN_CAPACITY", "GENIUS_OFFICIAL_TOKEN_CAPACITY",
  "GENIUS_DELIVERY_NOT_DURABLE", "GENIUS_TOKEN_OWNER_CAPACITY", "GENIUS_UNRESOLVED_CAPACITY",
  "GENIUS_LAUNCH_RECORD_MISMATCH", "GENIUS_DOCUMENT_STATE_INVALID", "GENIUS_DOCUMENT_OBSERVATION_INVALID",
  "GENIUS_X_CURSOR_INVALID", "GENIUS_HEALTH_STATE_INVALID", "GENIUS_DURABLE_EVENT_STATE_INVALID",
  "GENIUS_ANCHOR_STATE_INVALID", "GENIUS_UNRESOLVED_STATE_INVALID",
]);
const FOUR_REGISTRY_STATE_VERSION = 11;
const FOUR_REGISTRY_CHAIN_ID = 56;
const FOUR_REGISTRY_ADDRESS = "0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94";
const FOUR_CORE_ADDRESS = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
const XAI_OFFICIAL_SOURCE_NAMES = ["x_api_changelog", "xai_release_notes", "xai_news"];
const TELEGRAM_NEWS_CHAT_ID = "-1002540748528";
const TELEGRAM_NEWS_USERNAME = "maxguruai";
// Keep this in lockstep with STATE_VERSION in src/bsc-launchpad-monitor.js.
// The health reader must reject a checkpoint the production reader cannot
// restart from, rather than reporting fresh-but-incompatible state as healthy.
const BSC_STATE_VERSION = 7;
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

// Mirror src/config.js exactly: most monitor lanes are enabled unless their
// switch is the literal word "false"; Telegram is an explicit opt-in. The
// HEALTH_REQUIRE_* override exists because the isolated systemd health unit
// does not load monitor.env.
function enabledUnlessFalse(env, name, fallback = true) {
  return !/^false$/i.test(String(env[name] ?? (fallback ? "true" : "false")));
}

function enabledOnlyTrue(env, name, fallback = false) {
  return /^true$/i.test(String(env[name] ?? (fallback ? "true" : "false")));
}

function monitorRequirement(env, healthName, enabled) {
  return env[healthName] === undefined
    ? enabled
    : booleanSetting(env, healthName, enabled);
}

export function buildHealthSettings(env = process.env) {
  const serviceManager = env.HEALTH_SERVICE_MANAGER || "systemd";
  if (!["systemd", "launchd"].includes(serviceManager)) throw new Error("HEALTH_SERVICE_MANAGER must be systemd or launchd");
  return {
    serviceManager,
    dataDir: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR),
    configDir: path.resolve(env.HEALTH_CONFIG_DIR || DEFAULT_CONFIG_DIR),
    limits: {
      robinhoodAgeSeconds: positiveInteger(env, "HEALTH_ROBINHOOD_MAX_AGE_SECONDS", 180),
      binanceAgeSeconds: positiveInteger(env, "HEALTH_BINANCE_MAX_AGE_SECONDS", 180),
      bscAgeSeconds: positiveInteger(env, "HEALTH_BSC_MAX_AGE_SECONDS", 180),
      githubAgeSeconds: positiveInteger(env, "HEALTH_GITHUB_MAX_AGE_SECONDS", 180),
      platformCapabilityAgeSeconds: positiveInteger(env, "HEALTH_PLATFORM_CAPABILITY_MAX_AGE_SECONDS", 180),
      ponAgeSeconds: positiveInteger(env, "HEALTH_PON_MAX_AGE_SECONDS", 180),
      morphAgeSeconds: positiveInteger(env, "HEALTH_MORPH_MAX_AGE_SECONDS", 180),
      flapQuoteAgeSeconds: positiveInteger(env, "HEALTH_FLAP_QUOTE_MAX_AGE_SECONDS", 180),
      geniusAgeSeconds: positiveInteger(env, "HEALTH_GENIUS_MAX_AGE_SECONDS", 180),
      gmgnFlowAgeSeconds: positiveInteger(env, "HEALTH_GMGN_FLOW_MAX_AGE_SECONDS", 180),
      gmgnFlowSourceAgeSeconds: positiveInteger(env, "HEALTH_GMGN_FLOW_SOURCE_MAX_AGE_SECONDS", 900),
      fourRegistryAgeSeconds: positiveInteger(env, "HEALTH_FOUR_REGISTRY_MAX_AGE_SECONDS", 180),
      uniswapAgeSeconds: positiveInteger(env, "HEALTH_UNISWAP_MAX_AGE_SECONDS", 180),
      xaiOfficialAgeSeconds: positiveInteger(env, "HEALTH_XAI_OFFICIAL_MAX_AGE_SECONDS", 180),
      telegramNewsAgeSeconds: positiveInteger(env, "HEALTH_TELEGRAM_NEWS_MAX_AGE_SECONDS", 180),
      twitterAgeSeconds: positiveInteger(env, "HEALTH_TWITTER_MAX_AGE_SECONDS", 180),
      fomoStateAgeSeconds: positiveInteger(env, "HEALTH_FOMO_STATE_MAX_AGE_SECONDS", 180),
      fomoCheckpointAgeSeconds: positiveInteger(env, "HEALTH_FOMO_CHECKPOINT_MAX_AGE_SECONDS", 900),
      fomoXAgeSeconds: positiveInteger(env, "HEALTH_FOMO_X_MAX_AGE_SECONDS", 180),
      fomoThesisAgeSeconds: positiveInteger(env, "HEALTH_FOMO_THESIS_MAX_AGE_SECONDS", 180),
      outboxPendingAgeSeconds: positiveInteger(env, "HEALTH_OUTBOX_MAX_PENDING_AGE_SECONDS", 60),
      heartbeatTimeoutMs: positiveInteger(env, "HEALTH_HEARTBEAT_TIMEOUT_MS", 5_000),
      runtimeHeartbeatAgeSeconds: positiveInteger(env, "HEALTH_RUNTIME_HEARTBEAT_MAX_AGE_SECONDS", 120),
    },
    requirements: {
      genius: monitorRequirement(env, "HEALTH_REQUIRE_GENIUS", enabledOnlyTrue(env, "GENIUS_MONITOR_ENABLED")),
      gmgnFlow: monitorRequirement(env, "HEALTH_REQUIRE_GMGN_FLOW", enabledOnlyTrue(env, "GMGN_FLOW_MONITOR_ENABLED")),
      pon: monitorRequirement(
        env,
        "HEALTH_REQUIRE_PON",
        enabledOnlyTrue(env, "PON_MONITOR_ENABLED"),
      ),
      morph: monitorRequirement(
        env,
        "HEALTH_REQUIRE_MORPH",
        enabledUnlessFalse(env, "MORPH_MONITOR_ENABLED"),
      ),
      flapQuote: monitorRequirement(
        env,
        "HEALTH_REQUIRE_FLAP_QUOTE",
        enabledUnlessFalse(env, "FLAP_QUOTE_MONITOR_ENABLED"),
      ),
      fourRegistry: monitorRequirement(
        env,
        "HEALTH_REQUIRE_FOUR_REGISTRY",
        enabledUnlessFalse(env, "FOUR_REGISTRY_MONITOR_ENABLED"),
      ),
      uniswap: monitorRequirement(
        env,
        "HEALTH_REQUIRE_UNISWAP",
        enabledUnlessFalse(env, "UNISWAP_MONITOR_ENABLED"),
      ),
      xaiOfficial: monitorRequirement(
        env,
        "HEALTH_REQUIRE_XAI_OFFICIAL",
        enabledUnlessFalse(env, "XAI_OFFICIAL_MONITOR_ENABLED"),
      ),
      telegramNews: monitorRequirement(
        env,
        "HEALTH_REQUIRE_TELEGRAM_NEWS",
        enabledOnlyTrue(env, "TELEGRAM_NEWS_MONITOR_ENABLED"),
      ),
      twitter: monitorRequirement(
        env,
        "HEALTH_REQUIRE_TWITTER",
        enabledUnlessFalse(env, "TWITTER_MONITOR_ENABLED")
          || enabledUnlessFalse(env, "BINANCE_CRITICAL_X_MONITOR_ENABLED")
          || enabledUnlessFalse(env, "FOCUS_CRITICAL_X_MONITOR_ENABLED")
          || enabledOnlyTrue(env, "PON_MONITOR_ENABLED"),
      ),
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
    geniusPollIntervals: {
      chainMs: positiveInteger(env, "GENIUS_POLL_INTERVAL_MS", 10_000),
      docsMs: positiveInteger(env, "GENIUS_DOCS_POLL_INTERVAL_MS", 60_000),
      xMs: positiveInteger(env, "GENIUS_X_POLL_INTERVAL_MS", 30_000),
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

  const documents = {};
  for (const name of ["developerDocs", "web3DeveloperDocs"]) {
    const source = record.value?._health?.[name];
    const prefix = `binance_${name}`;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      operationalReasons.push(`${prefix}_health_missing`);
      documents[name] = { status: "missing" };
      continue;
    }
    const status = normalizedStatus(source.status);
    const backoff = upstreamBackoffState(source, nowMs, maximumAgeSeconds);
    const checked = parsedInstant(source.checkedAt, nowMs);
    const succeeded = parsedInstant(source.lastSuccessAt, nowMs);
    if (checked === null) operationalReasons.push(`${prefix}_checked_invalid`);
    else if (ageSeconds(checked, nowMs) > maximumAgeSeconds) {
      (backoff.active ? coverageReasons : operationalReasons).push(`${prefix}_checked_stale`);
    }
    if (status !== "healthy") coverageReasons.push(`${prefix}_${status}`);
    if (succeeded === null || ageSeconds(succeeded, nowMs) > maximumAgeSeconds) {
      coverageReasons.push(`${prefix}_last_success_stale`);
    }
    const pagesChecked = finiteCount(source.pagesChecked);
    const pagesTotal = Number.isSafeInteger(source.pagesTotal) && source.pagesTotal > 0 ? source.pagesTotal : null;
    if (pagesChecked === 0 || (pagesTotal !== null && pagesChecked < pagesTotal)) {
      coverageReasons.push(`${prefix}_pages_incomplete`);
    }
    documents[name] = { status, pagesChecked, pagesTotal,
      checkedAt: checked === null ? null : new Date(checked).toISOString(),
      lastSuccessAt: succeeded === null ? null : new Date(succeeded).toISOString(),
      upstreamBackoff: backoff };
  }

  return laneResult({
    id: "binance",
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      documents,
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
  if (typeof value !== "string") return null;
  const source = value;
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

function ponXStatusIdAtOrBefore(value, ceiling) {
  if (!ponXStatusId(value) || !ponXStatusId(ceiling)) return false;
  try {
    return BigInt(value) <= BigInt(ceiling);
  } catch {
    return false;
  }
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
      } else {
        // A completed recovery is an immutable audit record for the gap that
        // it closed. The producer deliberately leaves that record in place
        // when a later poll opens a new gap, so it must not be tied forever to
        // the current cursor. Close the old epoch with lastGapResolvedAt,
        // require its cursor to be no newer than the durable cursor, and only
        // accept a coexisting active gap when it is provably a later epoch.
        const completedMs = parsedInstant(delayedRecovery.completedAt, nowMs);
        const lastGapResolvedMs = parsedInstant(health.lastGapResolvedAt, nowMs);
        const completedEpochValid = delayedGapMs !== null
          && completedMs !== null
          && lastGapResolvedMs !== null
          && delayedGapMs <= completedMs
          && completedMs <= lastGapResolvedMs
          && ponXStatusIdAtOrBefore(delayedRecovery.cursorId, cursor.latestId);
        const activeEpochValid = gapSinceMs === null
          || (gapSinceMs !== delayedGapMs && lastGapResolvedMs !== null && lastGapResolvedMs <= gapSinceMs);
        if (!completedEpochValid || !activeEpochValid) {
          operationalReasons.push("pon_x_state_schema_invalid:coverage.delayedRecovery");
        }
        if (gapSinceMs !== null) coverageReasons.push("pon_x_gap_active");
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
      || !ponStateRecord(verification)
      || String(verification.token || "").toLowerCase() !== PON_PLATFORM_TOKEN
      || verification.codePresent !== true
      || !ponHash(verification.codeHash)
      || verification.name !== platformToken.name
      || verification.symbol !== platformToken.symbol
      || !ponSafeCount(verification.decimals, 255)
      || !/^(?:0|[1-9]\d*)$/.test(String(verification.totalSupplyRaw || ""))
      || expectedRawSupply === null
      || expectedRawSupply === "0"
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
  const cycleRetryMs = Date.parse(String(health?.nextAttemptAt || ""));
  const cycleFailureMs = parsedInstant(health?.lastErrorAt, nowMs);
  const cycleCode = String(health?.lastErrorCode || "");
  const cycleUpstreamBackoff = cycleFailureMs !== null
    && Number.isFinite(cycleRetryMs) && cycleRetryMs > nowMs
    && cycleRetryMs - cycleFailureMs > 0 && cycleRetryMs - cycleFailureMs <= 3_600_000
    && ponErrorIsCoverageLimited(cycleCode, sources, sourceBackoffs, health?.reorg)
    && PON_SOURCE_NAMES.every((name) => Date.parse(String(sources[name]?.nextAttemptAt || "")) >= cycleRetryMs);
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
      if (sourceBackoffs.api_health.active || cycleUpstreamBackoff) coverageReasons.push("pon_api_last_verified_stale_during_backoff");
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
    const dependencyBackoff = backoff.active || cycleUpstreamBackoff
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
      cycleUpstreamBackoff,
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

function validEvmAddress(value) {
  return /^0x[0-9a-f]{40}$/i.test(String(value || ""));
}

function validBlockHash(value) {
  return /^0x[0-9a-f]{64}$/i.test(String(value || ""));
}

function sourceAttemptState(item, nowMs, maximumAgeSeconds, attemptField = "lastAttemptAt") {
  return schedulerAttemptState({
    ...item,
    lastAttemptAt: item?.[attemptField],
  }, nowMs, maximumAgeSeconds);
}

function evaluateMorph(record, previous, nowMs, maximumAgeSeconds, required) {
  if (!required) {
    return laneResult({
      id: "morph",
      required,
      maximumAgeSeconds,
      record,
      semantic: { configured: false },
    });
  }
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, { checkFileAge: false });
  const coverageReasons = [];
  const warnings = [];
  const state = record.value || {};
  const health = state.health || {};
  const initialized = state.baselineComplete === true;
  const status = normalizedStatus(health.status);
  let attemptMs = null;
  let successMs = null;
  let longCheckedMs = null;
  let progress = null;

  if (!record.parseError) {
    if (state.version !== MORPH_STATE_VERSION) operationalReasons.push("morph_state_version_invalid");
    if (state.chainId !== MORPH_CHAIN_ID) operationalReasons.push("morph_chain_identity_mismatch");
    if (typeof state.baselineComplete !== "boolean") operationalReasons.push("morph_baseline_flag_invalid");

    attemptMs = parsedInstant(health.lastAttemptAt, nowMs);
    if (attemptMs === null) {
      (initialized ? operationalReasons : coverageReasons).push(
        initialized ? "morph_attempt_timestamp_missing_or_invalid" : "morph_startup_pending",
      );
    } else if (ageSeconds(attemptMs, nowMs) > maximumAgeSeconds) {
      operationalReasons.push("morph_attempt_stalled");
    }
    successMs = parsedInstant(health.lastSuccessAt, nowMs);
    if (successMs === null || ageSeconds(successMs, nowMs) > maximumAgeSeconds) {
      coverageReasons.push("morph_last_success_stale");
    }
    if (!["healthy", "catching_up"].includes(status)) {
      coverageReasons.push(`morph_status_${status}`);
      warnings.push("morph_source_limited");
    }

    if (!initialized) {
      coverageReasons.push("morph_baseline_pending");
    } else {
      const cursor = state.cursor;
      const lastScannedBlock = state.lastScannedBlock;
      if (!Number.isSafeInteger(cursor) || cursor <= 0
        || !Number.isSafeInteger(lastScannedBlock) || lastScannedBlock < 0
        || cursor !== lastScannedBlock + 1
        || !validBlockHash(state.lastScannedBlockHash)) {
        operationalReasons.push("morph_cursor_missing_or_invalid");
      } else {
        progress = progressRecord({
          key: "nextBlock",
          value: cursor,
          sourceAtMs: successMs ?? attemptMs ?? record.mtimeMs,
          previous: previous?.progress,
          nowMs,
          maxAgeSeconds: maximumAgeSeconds,
        });
        if (progress.regressed) operationalReasons.push("morph_cursor_regressed");
        if (progress.frozen) {
          if (["healthy", "catching_up"].includes(status)) operationalReasons.push("morph_cursor_frozen");
          else coverageReasons.push("morph_cursor_frozen_during_source_failure");
        }
      }
    }

    const headBlock = health.headBlock;
    const safeBlock = health.safeBlock;
    const lagBlocks = health.lagBlocks;
    const hasChainProgress = [headBlock, safeBlock, lagBlocks]
      .some((value) => value !== null && value !== undefined);
    let observedCursorLagBlocks = null;
    if (initialized || hasChainProgress) {
      if (!Number.isSafeInteger(headBlock) || headBlock < 0
        || !Number.isSafeInteger(safeBlock) || safeBlock < 0
        || safeBlock > headBlock
        || (initialized && Number.isSafeInteger(state.lastScannedBlock)
          && state.lastScannedBlock > headBlock)) {
        operationalReasons.push("morph_chain_progress_inconsistent");
      }
      if (!Number.isSafeInteger(lagBlocks) || lagBlocks < 0) operationalReasons.push("morph_lag_invalid");
      if (initialized && Number.isSafeInteger(safeBlock) && Number.isSafeInteger(state.lastScannedBlock)) {
        // The producer can persist head/safe through another concurrent source
        // before its current log chunk commits. Derive coverage from the
        // authoritative cursor, but do not call that valid snapshot corrupt.
        observedCursorLagBlocks = Math.max(0, safeBlock - state.lastScannedBlock);
      }
    }
    if ((Number.isSafeInteger(lagBlocks) && lagBlocks > 0)
      || (Number.isSafeInteger(observedCursorLagBlocks) && observedCursorLagBlocks > 0)) {
      coverageReasons.push("morph_chain_coverage_lagging");
    }
    if (normalizedStatus(health.websocket) !== "connected") {
      coverageReasons.push("morph_websocket_not_connected");
      warnings.push("morph_http_polling_fallback");
    }

    longCheckedMs = parsedInstant(state.long?.checkedAt, nowMs);
    if (state.long?.initialized !== true) coverageReasons.push("morph_long_official_baseline_pending");
    if (longCheckedMs === null || ageSeconds(longCheckedMs, nowMs) > maximumAgeSeconds) {
      coverageReasons.push("morph_long_official_stale");
    }
    if (state.long?.lastError) {
      coverageReasons.push("morph_long_official_source_incomplete");
      warnings.push("morph_long_official_source_limited");
    }
  }

  return laneResult({
    id: "morph",
    required,
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      configured: true,
      version: Number.isSafeInteger(state.version) ? state.version : null,
      chainId: Number.isSafeInteger(state.chainId) ? state.chainId : null,
      baselineComplete: initialized,
      status,
      lastAttemptAt: attemptMs === null ? null : new Date(attemptMs).toISOString(),
      lastSuccessAt: successMs === null ? null : new Date(successMs).toISOString(),
      headBlock: Number.isSafeInteger(health.headBlock) ? health.headBlock : null,
      safeBlock: Number.isSafeInteger(health.safeBlock) ? health.safeBlock : null,
      lagBlocks: Number.isSafeInteger(health.lagBlocks) ? health.lagBlocks : null,
      websocket: normalizedStatus(health.websocket),
      longOfficial: {
        initialized: state.long?.initialized === true,
        checkedAt: longCheckedMs === null ? null : new Date(longCheckedMs).toISOString(),
        sourceComplete: !state.long?.lastError,
      },
    },
  });
}

function flapQuoteFailureIsSourceLimited(health) {
  const code = String(health?.lastErrorCode || "").trim();
  if (health?.failureClass === "state" || health?.failureClass === "schema" || health?.failureClass === "delivery") {
    return false;
  }
  return new Set([
    "FLAP_QUOTE_BLOCK_UNAVAILABLE",
    "FLAP_QUOTE_CHAIN_ID_UNAVAILABLE",
    "FLAP_QUOTE_CONFIGURATION_READ_FAILED",
    "FLAP_QUOTE_GET_LOGS_FAILED",
    "FLAP_QUOTE_HEAD_UNAVAILABLE",
    "FLAP_QUOTE_METADATA_UNAVAILABLE",
    "FLAP_QUOTE_PORTAL_IDENTITY_UNAVAILABLE",
    "FLAP_QUOTE_PRIOR_CONFIGURATION_REDUNDANCY_INCOMPLETE",
    "FLAP_QUOTE_PRIOR_CONFIGURATION_UNAVAILABLE",
    "FLAP_QUOTE_RECEIPT_UNAVAILABLE",
    "FLAP_QUOTE_REORG_CHECK_FAILED",
    "FLAP_QUOTE_TRANSACTION_UNAVAILABLE",
  ]).has(code);
}

function evaluateFlapQuote(record, previous, nowMs, maximumAgeSeconds, required) {
  if (!required) {
    return laneResult({
      id: "flapQuote",
      required,
      maximumAgeSeconds,
      record,
      semantic: { configured: false },
    });
  }
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, { checkFileAge: false });
  const coverageReasons = [];
  const warnings = [];
  const state = record.value || {};
  const health = state._health || {};
  const initialized = state.initialized === true;
  const status = normalizedStatus(health.status);
  const sourceLimited = flapQuoteFailureIsSourceLimited(health);
  const attempt = schedulerAttemptState(health, nowMs, maximumAgeSeconds);
  const retryActive = sourceLimited && attempt.operational;
  let progress = null;

  if (!record.parseError) {
    if (state.version !== FLAP_QUOTE_STATE_VERSION) operationalReasons.push("flap_quote_state_version_invalid");
    const identity = state.identity || {};
    if (identity.chainId !== FLAP_QUOTE_CHAIN_ID
      || String(identity.portal || "").toLowerCase() !== FLAP_QUOTE_PORTAL
      || String(identity.portalRuntimeCodeHash || "").toLowerCase() !== FLAP_QUOTE_PORTAL_RUNTIME_HASH
      || identity.version !== FLAP_QUOTE_PORTAL_VERSION
      || String(identity.implementation || "").toLowerCase() !== FLAP_QUOTE_PORTAL_IMPLEMENTATION
      || String(identity.implementationCodeHash || "").toLowerCase() !== FLAP_QUOTE_PORTAL_IMPLEMENTATION_HASH
      || (initialized && (!Number.isSafeInteger(identity.verifiedBlock) || identity.verifiedBlock <= 0
        || !validBlockHash(identity.verifiedBlockHash)
        || !Number.isSafeInteger(identity.portalRuntimeCodeBytes) || identity.portalRuntimeCodeBytes <= 0
        || !Number.isSafeInteger(identity.implementationCodeBytes) || identity.implementationCodeBytes <= 0))) {
      operationalReasons.push("flap_quote_pinned_identity_mismatch");
    }
    if (typeof state.initialized !== "boolean") operationalReasons.push("flap_quote_initialized_flag_invalid");
    if (!attempt.operational) {
      (initialized ? operationalReasons : coverageReasons).push(
        initialized ? "flap_quote_attempt_stalled" : "flap_quote_startup_pending",
      );
    }
    if (!initialized) coverageReasons.push("flap_quote_baseline_pending");

    const lastSuccessMs = parsedInstant(health.lastSuccessAt, nowMs);
    if (lastSuccessMs === null || ageSeconds(lastSuccessMs, nowMs) > maximumAgeSeconds) {
      coverageReasons.push("flap_quote_last_success_stale");
    }
    if (status !== "healthy") {
      coverageReasons.push(`flap_quote_status_${status}`);
      const code = String(health.lastErrorCode || "unknown").slice(0, 120);
      if (retryActive) warnings.push(`flap_quote_source_limited:${code}`);
      else operationalReasons.push(`flap_quote_integrity_failure:${code}`);
    }

    const cursor = state.cursor || {};
    if (initialized && (!Number.isSafeInteger(cursor.nextBlock) || cursor.nextBlock <= 0
      || !Number.isSafeInteger(cursor.anchorBlock) || cursor.anchorBlock < 0
      || !Number.isSafeInteger(cursor.afterLogIndex) || cursor.afterLogIndex < -1
      || (cursor.afterLogIndex === -1 && cursor.nextBlock !== cursor.anchorBlock + 1)
      || (cursor.afterLogIndex >= 0 && cursor.nextBlock !== cursor.anchorBlock)
      || !validBlockHash(cursor.anchorBlockHash)
      || parsedInstant(cursor.baselineEstablishedAt, nowMs) === null)) {
      operationalReasons.push("flap_quote_cursor_missing_or_invalid");
    } else if (initialized) {
      if (Number.isSafeInteger(state.identity?.verifiedBlock) && cursor.nextBlock <= state.identity.verifiedBlock) {
        coverageReasons.push("flap_quote_historical_catchup_pending");
      }
      progress = progressRecord({
        key: "nextBlock",
        value: cursor.nextBlock,
        sourceAtMs: attempt.lastAttemptMs ?? record.mtimeMs,
        previous: previous?.progress,
        nowMs,
        maxAgeSeconds: maximumAgeSeconds,
      });
      if (progress.regressed) operationalReasons.push("flap_quote_cursor_regressed");
      if (progress.frozen) {
        if (retryActive) coverageReasons.push("flap_quote_cursor_frozen_during_source_backoff");
        else operationalReasons.push("flap_quote_cursor_frozen");
      }
    }
  }

  return laneResult({
    id: "flapQuote",
    required,
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      configured: true,
      version: Number.isSafeInteger(state.version) ? state.version : null,
      initialized,
      status,
      chainId: Number.isSafeInteger(state.identity?.chainId) ? state.identity.chainId : null,
      portal: validEvmAddress(state.identity?.portal) ? state.identity.portal : null,
      lastAttemptAt: attempt.lastAttemptMs === null ? null : new Date(attempt.lastAttemptMs).toISOString(),
      lastSuccessAt: isoOrNull(health.lastSuccessAt, nowMs),
      nextAttemptAt: attempt.nextAttemptMs === null ? null : new Date(attempt.nextAttemptMs).toISOString(),
      lastErrorCode: health.lastErrorCode ? String(health.lastErrorCode).slice(0, 120) : null,
      failureClass: health.failureClass ? String(health.failureClass).slice(0, 40) : null,
      sourceLimited: retryActive,
      quoteAssetCount: state.quoteAssets && typeof state.quoteAssets === "object"
        ? Object.keys(state.quoteAssets).length : 0,
      pendingEnableCandidateCount: state.pendingEnableCandidates && typeof state.pendingEnableCandidates === "object"
        ? Object.keys(state.pendingEnableCandidates).length : 0,
      pendingBlocks: Number.isSafeInteger(state.identity?.verifiedBlock) && Number.isSafeInteger(state.cursor?.nextBlock)
        ? Math.max(0, state.identity.verifiedBlock - state.cursor.nextBlock + 1) : null,
    },
  });
}

function geniusGapPresent(value) {
  if (value === undefined || value === null || value === false) return false;
  if (ponStateRecord(value) && ["complete", "resolved"].includes(value.status)) return false;
  return true;
}

function geniusStableJson(value) {
  if (Array.isArray(value)) return `[${value.map(geniusStableJson).join(",")}]`;
  if (ponStateRecord(value)) return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${geniusStableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function inspectGeniusQueues(state, nowMs, operationalReasons, coverageReasons) {
  const summary = { pendingDeliveryCount: 0, pendingDocumentObservationCount: 0, pendingDocumentEventCount: 0,
    unresolvedTokenEventCount: 0, tokenResolutionFailureCount: 0, knownTokenOwnerCount: 0 };
  const invalid = (field) => operationalReasons.push(`genius_queue_schema_invalid:${field}`);
  if (Object.hasOwn(state, "pendingEvents")) {
    if (!Array.isArray(state.pendingEvents) || state.pendingEvents.length > 2_000
      || state.pendingEvents.some((event) => !isStrictGeniusEvent(event))
      || new Set(state.pendingEvents.map((event) => event.eventKey)).size !== state.pendingEvents.length) {
      invalid("pendingEvents");
    }
    if (Array.isArray(state.pendingEvents)) summary.pendingDeliveryCount = state.pendingEvents.length;
  }
  for (const key of ["genius_manifest", "genius_about", "genius_integrate"]) {
    const source = state.sources?.[key];
    if (!ponStateRecord(source) || !Object.hasOwn(source, "pendingObservation")) continue;
    const pending = source.pendingObservation;
    summary.pendingDocumentObservationCount += 1;
    if (Array.isArray(pending?.events)) summary.pendingDocumentEventCount += pending.events.length;
    if (source.initialized !== true || !ponStateRecord(source.snapshot)
      || source.hash !== createHash("sha256").update(geniusStableJson(source.snapshot)).digest("hex")
      || !ponStateRecord(pending) || !ponStateRecord(pending.snapshot)
      || pending.hash !== createHash("sha256").update(geniusStableJson(pending.snapshot)).digest("hex")
      || !Array.isArray(pending.events) || pending.events.length > 2_000
      || pending.events.some((event) => !isStrictGeniusEvent(event) || event.sourceId !== key
        || event.evidence.beforeHash !== source.hash || event.evidence.afterHash !== pending.hash)
      || new Set(pending.events.map((event) => event.eventKey)).size !== pending.events.length) {
      invalid(`sources.${key}.pendingObservation`);
    }
  }
  if (Object.hasOwn(state, "tokenOwners")) {
    if (!ponStateRecord(state.tokenOwners) || Object.keys(state.tokenOwners).length > 50_000
      || Object.entries(state.tokenOwners).some(([address, deployer]) => !validEvmAddress(address) || !validEvmAddress(deployer))) {
      invalid("tokenOwners");
    }
    if (ponStateRecord(state.tokenOwners)) summary.knownTokenOwnerCount = Object.keys(state.tokenOwners).length;
  }
  if (Object.hasOwn(state, "unresolvedTokenEvents")) {
    if (!Array.isArray(state.unresolvedTokenEvents) || state.unresolvedTokenEvents.length > 5_000) {
      invalid("unresolvedTokenEvents");
    } else {
      summary.unresolvedTokenEventCount = state.unresolvedTokenEvents.length;
      const keys = new Set();
      for (const entry of state.unresolvedTokenEvents) {
        const log = entry?.log;
        const providers = entry?.providers;
        const providerOriginsValid = Array.isArray(providers) && providers.length >= 2 && providers.length <= 12
          && providers.every((origin) => {
            try { const url = new URL(origin); return url.protocol === "https:" && url.origin === origin; }
            catch { return false; }
          });
        if (!ponStateRecord(entry) || !["realtime", "historical"].includes(entry.lane)
          || !ponStateRecord(log) || !ponStateRecord(log.args) || !validEvmAddress(log.args.token)
          || !validBlockHash(log.transactionHash) || !validBlockHash(log.blockHash)
          || !Number.isSafeInteger(log.blockNumber) || log.blockNumber < GENIUS_START_BLOCK
          || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0
          || !Number.isSafeInteger(log.blockTimestamp) || log.blockTimestamp <= 0
          || !/^[A-Za-z][A-Za-z0-9]+$/.test(String(log.name || ""))
          || entry.key !== `${log.transactionHash}:${log.logIndex}:${log.blockHash}`
          || keys.has(entry.key) || !providerOriginsValid
          || new Set(providers.map((origin) => new URL(origin).hostname)).size < 2) {
          invalid("unresolvedTokenEvents.entry");
          break;
        }
        keys.add(entry.key);
      }
    }
  }
  if (Object.hasOwn(state, "tokenResolutionFailures")) {
    if (!ponStateRecord(state.tokenResolutionFailures) || Object.keys(state.tokenResolutionFailures).length > 5_000) {
      invalid("tokenResolutionFailures");
    } else {
      summary.tokenResolutionFailureCount = Object.keys(state.tokenResolutionFailures).length;
      for (const [address, failure] of Object.entries(state.tokenResolutionFailures)) {
        const retryMs = Date.parse(String(failure?.nextAttemptAt || ""));
        if (!validEvmAddress(address) || !ponStateRecord(failure)
          || !Number.isSafeInteger(failure.consecutiveFailures) || failure.consecutiveFailures <= 0
          || typeof failure.lastError !== "string" || failure.lastError.length > 300
          || typeof failure.lastErrorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,119}$/.test(failure.lastErrorCode)
          || !Number.isFinite(retryMs) || retryMs > nowMs + 15 * 60_000) {
          invalid("tokenResolutionFailures.entry");
          continue;
        }
        if (GENIUS_INTEGRITY_FAILURE_CODES.has(failure.lastErrorCode)) {
          operationalReasons.push(`genius_token_resolution_integrity_failure:${failure.lastErrorCode}`);
        }
      }
    }
  }
  if (summary.pendingDeliveryCount) coverageReasons.push("genius_delivery_pending");
  if (summary.pendingDocumentObservationCount) coverageReasons.push("genius_document_observation_pending");
  if (summary.unresolvedTokenEventCount) coverageReasons.push("genius_token_identity_resolution_pending");
  if (summary.tokenResolutionFailureCount) coverageReasons.push("genius_token_resolution_retry_pending");
  return summary;
}

function evaluateGenius(record, previous, nowMs, maximumAgeSeconds, required, pollIntervals) {
  if (!required) return laneResult({
    id: "genius", required, maximumAgeSeconds, record, semantic: { configured: false },
  });
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, { checkFileAge: false });
  const coverageReasons = [];
  const warnings = [];
  const state = record.value || {};
  const health = ponStateRecord(state.health) ? state.health : {};
  const sourceStates = ponStateRecord(state.sources) ? state.sources : {};
  const sourceHealth = ponStateRecord(health.sources) ? health.sources : {};
  const chain = ponStateRecord(state.chain) ? state.chain : {};
  const sources = {};
  let progress = null;
  let historicalProgress = null;
  let queues = {};

  if (!record.parseError) {
    if (state.version !== 1) operationalReasons.push("genius_state_version_invalid");
    if (!ponStateRecord(state.identity) || state.identity.chainId !== 56
      || String(state.identity.factory || "").toLowerCase() !== GENIUS_FACTORY
      || state.identity.factoryCodeHash !== GENIUS_FACTORY_CODE_HASH) {
      operationalReasons.push("genius_pinned_identity_mismatch");
    }
    for (const [name, value] of [["health", state.health], ["health.sources", health.sources],
      ["sources", state.sources], ["chain", state.chain], ["officialTokens", state.officialTokens]]) {
      if (!ponStateRecord(value)) operationalReasons.push(`genius_state_schema_invalid:${name}`);
    }
    if (typeof health.status !== "string" || !health.status.trim()) {
      operationalReasons.push("genius_state_schema_invalid:health.status");
    }
    if (health.status === "initializing" && health.checkedAt === null
      && record.ageSeconds !== null && record.ageSeconds <= maximumAgeSeconds) {
      coverageReasons.push("genius_scheduler_initializing");
    } else semanticFreshness(health.checkedAt, nowMs, maximumAgeSeconds, "genius_scheduler_checked", operationalReasons);
    if (ponStateRecord(state.officialTokens) && Object.keys(state.officialTokens).length > 5_000) {
      operationalReasons.push("genius_official_tokens_limit_exceeded");
    }
    if (ponStateRecord(state.officialTokens) && Object.entries(state.officialTokens).some(([address, token]) =>
      !validEvmAddress(address) || !ponStateRecord(token) || String(token.address || "").toLowerCase() !== address
      || !["0xe7c7b7ee71db0f1b4f0ff25d7cec191268e7fd98", "0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed"]
        .includes(String(token.deployer || "").toLowerCase()))) {
      operationalReasons.push("genius_official_token_identity_invalid");
    }
    queues = inspectGeniusQueues(state, nowMs, operationalReasons, coverageReasons);

    for (const key of GENIUS_SOURCE_KEYS) {
      const source = sourceStates[key];
      const item = sourceHealth[key];
      if (!ponStateRecord(source) || typeof source.initialized !== "boolean"
        || !ponStateRecord(item)) {
        operationalReasons.push(`genius_source_schema_invalid:${key}`);
        coverageReasons.push(`genius_source_unverified:${key}`);
        sources[key] = { status: "missing_or_invalid", initialized: false, coverageComplete: false };
        continue;
      }
      const status = normalizedStatus(item.status);
      const intervalMs = key === "genius_chain" ? pollIntervals.chainMs
        : key.startsWith("genius_x_") ? pollIntervals.xMs : pollIntervals.docsMs;
      const sourceMaximumAgeSeconds = Math.max(maximumAgeSeconds, Math.ceil(intervalMs * 3 / 1_000));
      const checkedMs = parsedInstant(item.checkedAt, nowMs);
      const successMs = parsedInstant(item.lastSuccessAt, nowMs);
      const nextMs = item.nextAttemptAt === null || item.nextAttemptAt === undefined
        ? null : Date.parse(String(item.nextAttemptAt));
      const backoff = status === "backoff" && checkedMs !== null
        && Number.isFinite(nextMs) && nextMs > nowMs
        && nextMs > checkedMs && nextMs - checkedMs <= 15 * 60_000;
      const initializing = status === "initializing" && !source.initialized;
      if (!GENIUS_SOURCE_STATUSES.has(status)
        || !Number.isSafeInteger(item.consecutiveFailures) || item.consecutiveFailures < 0
        || (item.nextAttemptAt !== null && item.nextAttemptAt !== undefined && !Number.isFinite(nextMs))
        || (item.lastSuccessAt !== null && item.lastSuccessAt !== undefined && successMs === null)) {
        operationalReasons.push(`genius_source_health_schema_invalid:${key}`);
      }
      if (checkedMs === null) {
        if (!initializing || item.checkedAt !== null) operationalReasons.push(`genius_source_checked_invalid:${key}`);
      } else if (ageSeconds(checkedMs, nowMs) > sourceMaximumAgeSeconds && !backoff) {
        operationalReasons.push(`genius_source_checked_stale:${key}`);
      }
      if (status === "backoff" && !backoff) operationalReasons.push(`genius_source_backoff_invalid_or_expired:${key}`);
      const errorCode = String(item.lastErrorCode || String(item.lastError || "").match(/^GENIUS_[A-Z_]+/)?.[0] || "");
      if (GENIUS_INTEGRITY_FAILURE_CODES.has(errorCode)) {
        operationalReasons.push(`genius_source_integrity_failure:${key}:${errorCode}`);
      }
      if (backoff) warnings.push(`genius_source_scheduled_backoff:${key}`);
      if (!source.initialized) coverageReasons.push(`genius_source_baseline_pending:${key}`);
      if (status !== "healthy") coverageReasons.push(`genius_source_${status}:${key}`);
      if (successMs === null || ageSeconds(successMs, nowMs) > sourceMaximumAgeSeconds) {
        coverageReasons.push(`genius_source_last_success_stale:${key}`);
      }
      if (status === "healthy" && (item.consecutiveFailures > 0 || item.lastError)) {
        operationalReasons.push(`genius_source_healthy_failure_conflict:${key}`);
      }
      if (status === "healthy" && (!source.initialized || successMs === null
        || ageSeconds(successMs, nowMs) > sourceMaximumAgeSeconds)) {
        operationalReasons.push(`genius_source_healthy_success_unproved:${key}`);
      }
      const gap = [source.coverageGap, source.continuityGap, item.coverageGap, item.continuityGap].some(geniusGapPresent);
      if (gap) coverageReasons.push(`genius_source_continuity_gap:${key}`);
      sources[key] = {
        status, initialized: source.initialized, checkedAt: isoOrNull(item.checkedAt, nowMs),
        lastSuccessAt: isoOrNull(item.lastSuccessAt, nowMs),
        nextAttemptAt: Number.isFinite(nextMs) ? new Date(nextMs).toISOString() : null,
        scheduledBackoff: backoff, coverageGap: gap, maxAgeSeconds: sourceMaximumAgeSeconds,
        lastErrorCode: /^GENIUS_[A-Z_]+$/.test(errorCode) ? errorCode.slice(0, 100) : null,
        coverageComplete: source.initialized && status === "healthy" && !gap && successMs !== null
          && ageSeconds(successMs, nowMs) <= sourceMaximumAgeSeconds,
      };
    }

    const block = (value) => Number.isSafeInteger(value) && value >= GENIUS_START_BLOCK;
    if (typeof chain.initialized !== "boolean" || typeof chain.historyComplete !== "boolean"
      || chain.startBlock !== GENIUS_START_BLOCK || !block(chain.historicalNextBlock)
      || !ponStateRecord(chain.anchors)
      || (chain.initialized && (!block(chain.realtimeNextBlock) || !block(chain.baselineBlock)
        || !block(chain.latestFinalizedBlock) || chain.realtimeNextBlock > chain.latestFinalizedBlock + 1
        || chain.realtimeNextBlock < chain.baselineBlock + 1
        || chain.latestFinalizedBlock < chain.baselineBlock
        || chain.historicalNextBlock > chain.baselineBlock + 1))
      || (!chain.initialized && (chain.realtimeNextBlock !== null || chain.baselineBlock !== null
        || chain.latestFinalizedBlock !== null || chain.historyComplete))) {
      operationalReasons.push("genius_chain_schema_invalid");
    }
    if (ponStateRecord(chain.anchors)) {
      for (const lane of ["realtime", "historical"]) {
        const anchor = chain.anchors[lane];
        if (anchor !== undefined && (!ponStateRecord(anchor) || !block(anchor.number)
          || !validBlockHash(anchor.hash) || !Number.isSafeInteger(anchor.timestamp) || anchor.timestamp < 0
          || anchor.number !== chain[`${lane}NextBlock`] - 1)) {
          operationalReasons.push(`genius_chain_anchor_invalid:${lane}`);
        }
      }
    }
    if (!chain.initialized) coverageReasons.push("genius_chain_baseline_pending");
    if (!chain.historyComplete || !block(chain.baselineBlock) || chain.historicalNextBlock <= chain.baselineBlock) {
      coverageReasons.push("genius_chain_history_incomplete");
    }
    if (chain.historyComplete && (!chain.initialized || chain.historicalNextBlock !== chain.baselineBlock + 1)) {
      operationalReasons.push("genius_chain_history_complete_conflict");
    }
    if (chain.initialized && block(chain.realtimeNextBlock) && block(chain.latestFinalizedBlock)
      && chain.realtimeNextBlock <= chain.latestFinalizedBlock) coverageReasons.push("genius_chain_realtime_gap");
    const chainSource = sources.genius_chain;
    if (chain.initialized && block(chain.realtimeNextBlock) && block(chain.historicalNextBlock)) {
      const sourceAtMs = parsedInstant(sourceHealth.genius_chain?.checkedAt, nowMs) ?? record.mtimeMs;
      progress = progressRecord({ key: "realtimeNextBlock", value: chain.realtimeNextBlock,
        sourceAtMs, previous: previous?.progress, nowMs, maxAgeSeconds: maximumAgeSeconds });
      historicalProgress = progressRecord({ key: "historicalNextBlock", value: chain.historicalNextBlock,
        sourceAtMs, previous: previous?.semantic?.historicalProgress, nowMs, maxAgeSeconds: maximumAgeSeconds });
      if (progress.regressed || historicalProgress.regressed) operationalReasons.push("genius_chain_cursor_regressed");
      // An unchanged cursor at the observed tip is normal; only a stalled lane
      // with work outstanding can be frozen. An active source retry is coverage.
      if (progress.frozen && chain.realtimeNextBlock <= chain.latestFinalizedBlock && !chainSource?.scheduledBackoff) {
        operationalReasons.push("genius_chain_realtime_cursor_frozen");
      }
      if (historicalProgress.frozen && !chain.historyComplete && !chainSource?.scheduledBackoff) {
        operationalReasons.push("genius_chain_historical_cursor_frozen");
      }
    }
  }
  if (operationalReasons.length) coverageReasons.push("genius_state_or_schedule_unverified");
  return laneResult({
    id: "genius", required, maximumAgeSeconds, record, operationalReasons, coverageReasons, warnings, progress,
    semantic: {
      configured: true, status: normalizedStatus(health.status), checkedAt: isoOrNull(health.checkedAt, nowMs),
      initialized: chain.initialized === true, historyComplete: chain.historyComplete === true,
      realtimeNextBlock: Number.isSafeInteger(chain.realtimeNextBlock) ? chain.realtimeNextBlock : null,
      historicalNextBlock: Number.isSafeInteger(chain.historicalNextBlock) ? chain.historicalNextBlock : null,
      baselineBlock: Number.isSafeInteger(chain.baselineBlock) ? chain.baselineBlock : null,
      latestFinalizedBlock: Number.isSafeInteger(chain.latestFinalizedBlock) ? chain.latestFinalizedBlock : null,
      officialTokenCount: ponStateRecord(state.officialTokens) ? Object.keys(state.officialTokens).length : 0,
      historicalProgress, sources, queues,
    },
  });
}

function evaluateGmgnFlow(record, nowMs, maximumAgeSeconds, sourceMaximumAgeSeconds, required) {
  if (!required) return laneResult({
    id: "gmgnFlow", required, maximumAgeSeconds, record, semantic: { configured: false },
  });
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, { checkFileAge: false });
  // The hot list is discovery only; never promote its four chains to verified
  // volume + high-profit + FOMO coverage merely because the CLI returned rows.
  const coverageReasons = ["gmgn_hot_only_chains_no_wallet_verification"];
  const warnings = [];
  const state = record.value || {};
  const health = ponStateRecord(state.health) ? state.health : {};
  const chains = {};
  let hotDiscovery = null;
  const invalid = (field) => operationalReasons.push(`gmgn_flow_state_schema_invalid:${field}`);
  const integrityCodes = new Set(["GMGN_FLOW_STATE_INVALID", "GMGN_STATE_INVALID",
    "GMGN_PENDING_CAPACITY", "GMGN_DELIVERY_NOT_DURABLE", "GMGN_FLOW_PENDING_FULL",
    "GMGN_FLOW_DELIVERY_NOT_DURABLE", "GMGN_FLOW_TRADE_STATE_INVALID", "GMGN_FLOW_STATE_TOO_LARGE",
    "GMGN_FLOW_QUARANTINE_FULL"]);
  const textOrNull = (value) => value === null || (typeof value === "string" && value.length <= 2_000);
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  const initializedMs = parsedInstant(state.initializedAt, nowMs);
  const schedulerMs = parsedInstant(health.checkedAt, nowMs);
  const schedulerFresh = schedulerMs !== null && ageSeconds(schedulerMs, nowMs) <= maximumAgeSeconds;
  const initializationFresh = initializedMs !== null && ageSeconds(initializedMs, nowMs) <= maximumAgeSeconds;
  const sourceInitializationFresh = initializedMs !== null && ageSeconds(initializedMs, nowMs) <= sourceMaximumAgeSeconds;
  const retry = (item) => {
    const checked = parsedInstant(item.checkedAt, nowMs);
    const next = item.nextAttemptAt === null ? null : Date.parse(String(item.nextAttemptAt || ""));
    return { next, active: schedulerFresh && checked !== null && Number.isFinite(next)
      && next > nowMs && next > checked && next - checked <= 15 * 60_000 };
  };
  const inspectSource = (key, item, hot = false) => {
    const prefix = `gmgn_flow_source_${key}`;
    if (!ponStateRecord(item)) { invalid(key); coverageReasons.push(`${prefix}_missing`); return null; }
    const statuses = hot ? ["initializing", "healthy", "partial", "backoff"]
      : ["initializing", "healthy", "partial", "backoff", "unsupported"];
    const status = item.status;
    const checked = parsedInstant(item.checkedAt, nowMs);
    const success = hot ? null : parsedInstant(item.lastSuccessAt, nowMs);
    const backoff = retry(item);
    let quarantinedTokenCount = 0;
    if (!hot && item.quarantinedTokens !== undefined) {
      if (!ponStateRecord(item.quarantinedTokens) || Object.keys(item.quarantinedTokens).length > 10_000) invalid(`${key}.quarantinedTokens`);
      else for (const [address, deadline] of Object.entries(item.quarantinedTokens)) {
        const deadlineMs = typeof deadline === "string" ? Date.parse(deadline) : NaN;
        if (gmgnFlowAddress(key, address) !== address || !Number.isFinite(deadlineMs)
          || deadlineMs > nowMs + 15 * 60_000) invalid(`${key}.quarantinedTokens`);
        else if (deadlineMs > nowMs) quarantinedTokenCount++;
      }
    }
    if (!statuses.includes(status) || !textOrNull(item.lastError)
      || (!hot && (!textOrNull(item.lastErrorCode) || !textOrNull(item.coverageGap)
        || typeof item.feedTruncated !== "boolean" || !count(item.tradeCount) || !count(item.candidateCount)))
      || (item.nextAttemptAt !== null && !Number.isFinite(backoff.next))
      || (!hot && item.lastSuccessAt !== null && success === null)) invalid(key);
    const initializing = status === "initializing" && sourceInitializationFresh;
    if (checked === null && !(initializing && item.checkedAt === null)) {
      operationalReasons.push(`${prefix}_checked_invalid`);
    } else if (checked !== null && ageSeconds(checked, nowMs) > sourceMaximumAgeSeconds
      && status !== "unsupported" && !backoff.active) operationalReasons.push(`${prefix}_checked_stale`);
    if (status === "initializing" && !sourceInitializationFresh) operationalReasons.push(`${prefix}_initialization_stalled`);
    if (status === "backoff" && !backoff.active) operationalReasons.push(`${prefix}_backoff_invalid_or_expired`);
    if (status === "healthy" && (item.lastError || (!hot && item.lastErrorCode))) {
      operationalReasons.push(`${prefix}_healthy_failure_conflict`);
    }
    if (integrityCodes.has(item.lastErrorCode)) operationalReasons.push(`${prefix}_integrity_failure`);
    if (!hot && status === "healthy" && (success === null || ageSeconds(success, nowMs) > sourceMaximumAgeSeconds)) {
      operationalReasons.push(`${prefix}_healthy_success_unproved`);
    }
    if (status !== "healthy") coverageReasons.push(`${prefix}_${String(status)}`);
    if (!hot && item.feedTruncated) coverageReasons.push(`${prefix}_feed_truncated`);
    if (!hot && item.coverageGap) coverageReasons.push(`${prefix}_coverage_gap`);
    if (quarantinedTokenCount) coverageReasons.push(`${prefix}_quarantined_tokens`);
    if (backoff.active) warnings.push(`${prefix}_scheduled_backoff`);
    return {
      status, checkedAt: isoOrNull(item.checkedAt, nowMs),
      ...(!hot ? { lastSuccessAt: isoOrNull(item.lastSuccessAt, nowMs),
        tradeCount: finiteCount(item.tradeCount), candidateCount: finiteCount(item.candidateCount),
        quarantinedTokenCount,
        feedTruncated: item.feedTruncated === true, coverageGap: item.coverageGap || null,
        lastErrorCode: typeof item.lastErrorCode === "string" ? item.lastErrorCode.slice(0, 100) : null } : {}),
      nextAttemptAt: Number.isFinite(backoff.next) ? new Date(backoff.next).toISOString() : null,
      scheduledBackoff: status === "backoff" && backoff.active, maxAgeSeconds: sourceMaximumAgeSeconds,
      coverageComplete: status === "healthy" && checked !== null && ageSeconds(checked, nowMs) <= sourceMaximumAgeSeconds
        && !item.feedTruncated && !item.coverageGap && !quarantinedTokenCount
        && (hot || (success !== null && ageSeconds(success, nowMs) <= sourceMaximumAgeSeconds)),
    };
  };
  if (!record.parseError) {
    if (state.version !== 1) invalid("version");
    if (initializedMs === null) invalid("initializedAt");
    semanticFreshness(state.updatedAt, nowMs, maximumAgeSeconds, "gmgn_flow_state_updated", operationalReasons);
    for (const key of ["health", "chains", "hotDiscovery", "episodes", "trades", "profiles"]) {
      if (!ponStateRecord(state[key])) invalid(key);
    }
    if (!["initializing", "healthy", "partial", "backoff"].includes(health.status)
      || !textOrNull(health.lastError) || !textOrNull(health.lastErrorCode)) invalid("health");
    if (health.status === "initializing" && health.checkedAt === null && initializationFresh) {
      coverageReasons.push("gmgn_flow_scheduler_initializing");
    } else semanticFreshness(health.checkedAt, nowMs, maximumAgeSeconds, "gmgn_flow_scheduler_checked", operationalReasons);
    const globalRetry = retry(health);
    if (health.nextAttemptAt !== null && !Number.isFinite(globalRetry.next)) invalid("health.nextAttemptAt");
    if (health.status === "backoff" && !globalRetry.active) operationalReasons.push("gmgn_flow_scheduler_backoff_invalid_or_expired");
    if (health.status !== "healthy") coverageReasons.push(`gmgn_flow_scheduler_${String(health.status)}`);
    if (health.status === "healthy" && (health.lastError || health.lastErrorCode)) {
      operationalReasons.push("gmgn_flow_scheduler_healthy_failure_conflict");
    }
    if (integrityCodes.has(health.lastErrorCode)) operationalReasons.push("gmgn_flow_scheduler_integrity_failure");
    for (const key of Object.keys(GMGN_FLOW_CHAINS)) chains[key] = inspectSource(key, state.chains?.[key]);
    if (ponStateRecord(state.chains) && Object.keys(state.chains).some((key) => !Object.hasOwn(GMGN_FLOW_CHAINS, key))) {
      invalid("chains.unknown_chain");
    }
    hotDiscovery = inspectSource("hotDiscovery", state.hotDiscovery, true);
    if (!Array.isArray(state.hotDiscovery?.chains) || state.hotDiscovery.chains.some((entry) =>
      !ponStateRecord(entry) || !GMGN_HOT_ONLY_CHAINS.includes(entry.chain)
      || !count(entry.count) || entry.mode !== "discovery_only")
      || new Set(state.hotDiscovery.chains.map((entry) => entry?.chain)).size !== state.hotDiscovery.chains.length) invalid("hotDiscovery.chains");
    if (!Array.isArray(state.pendingEvents) || state.pendingEvents.length > 500
      || state.pendingEvents.some((event) => !isGmgnFlowEvent(event))
      || new Set(state.pendingEvents.map((event) => event.eventKey)).size !== state.pendingEvents.length) invalid("pendingEvents");
    if (Array.isArray(state.pendingEvents) && state.pendingEvents.length) coverageReasons.push("gmgn_flow_delivery_pending");
    if (ponStateRecord(state.trades) && Object.entries(state.trades).some(([key, rows]) =>
      !Object.hasOwn(GMGN_FLOW_CHAINS, key) || !Array.isArray(rows) || rows.length > 10_000)) invalid("trades");
    for (const key of ["episodes", "profiles"]) {
      if (ponStateRecord(state[key]) && Object.keys(state[key]).length > 10_000) invalid(key);
    }
  }
  if (operationalReasons.length) coverageReasons.push("gmgn_flow_state_or_schedule_unverified");
  return laneResult({
    id: "gmgnFlow", required, maximumAgeSeconds, record, operationalReasons, coverageReasons, warnings,
    semantic: {
      configured: true, status: normalizedStatus(health.status), checkedAt: isoOrNull(health.checkedAt, nowMs),
      initializedAt: isoOrNull(state.initializedAt, nowMs), updatedAt: isoOrNull(state.updatedAt, nowMs),
      chains, hotDiscovery, hotOnlyChains: [...GMGN_HOT_ONLY_CHAINS],
      pendingDeliveryCount: Array.isArray(state.pendingEvents) ? state.pendingEvents.length : 0,
      episodeCount: ponStateRecord(state.episodes) ? Object.keys(state.episodes).length : 0,
      profileCount: ponStateRecord(state.profiles) ? Object.keys(state.profiles).length : 0,
    },
  });
}

function evaluateFourRegistry(record, previous, nowMs, maximumAgeSeconds, required) {
  if (!required) {
    return laneResult({
      id: "fourRegistry",
      required,
      maximumAgeSeconds,
      record,
      semantic: { configured: false },
    });
  }
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, { checkFileAge: false });
  const coverageReasons = [];
  const state = record.value || {};
  const initialized = state.initialized === true;
  let updatedMs = null;
  let progress = null;

  if (!record.parseError) {
    if (state.version !== FOUR_REGISTRY_STATE_VERSION) operationalReasons.push("four_registry_state_version_invalid");
    if (state.chainId !== FOUR_REGISTRY_CHAIN_ID
      || String(state.registry || "").toLowerCase() !== FOUR_REGISTRY_ADDRESS
      || String(state.core || "").toLowerCase() !== FOUR_CORE_ADDRESS) {
      operationalReasons.push("four_registry_pinned_identity_mismatch");
    }
    if (typeof state.initialized !== "boolean") operationalReasons.push("four_registry_initialized_flag_invalid");
    updatedMs = parsedInstant(state.updatedAt, nowMs);
    if (updatedMs === null) {
      (initialized ? operationalReasons : coverageReasons).push(
        initialized ? "four_registry_updated_timestamp_missing_or_invalid" : "four_registry_startup_pending",
      );
    } else if (ageSeconds(updatedMs, nowMs) > maximumAgeSeconds) {
      operationalReasons.push("four_registry_progress_stalled");
    }
    if (!initialized) coverageReasons.push("four_registry_baseline_pending");

    const cursor = state.cursor;
    if (initialized && (!cursor || typeof cursor !== "object" || Array.isArray(cursor)
      || !Number.isSafeInteger(cursor.nextBlock) || cursor.nextBlock <= 0
      || !Number.isSafeInteger(cursor.anchorBlock) || cursor.anchorBlock < 0
      || cursor.nextBlock !== cursor.anchorBlock + 1
      || !validBlockHash(cursor.anchorBlockHash))) {
      operationalReasons.push("four_registry_cursor_missing_or_invalid");
    } else if (initialized) {
      progress = progressRecord({
        key: "nextBlock",
        value: cursor.nextBlock,
        sourceAtMs: updatedMs ?? record.mtimeMs,
        previous: previous?.progress,
        nowMs,
        maxAgeSeconds: maximumAgeSeconds,
      });
      if (progress.regressed) operationalReasons.push("four_registry_cursor_regressed");
      if (progress.frozen) operationalReasons.push("four_registry_cursor_frozen");

      const checkpoints = state.checkpoints;
      const latestCheckpoint = Array.isArray(checkpoints) ? checkpoints.at(-1) : null;
      if (!Array.isArray(checkpoints) || checkpoints.length === 0
        || latestCheckpoint?.blockNumber !== cursor.anchorBlock
        || String(latestCheckpoint?.blockHash || "").toLowerCase() !== String(cursor.anchorBlockHash).toLowerCase()) {
        operationalReasons.push("four_registry_cursor_checkpoint_missing_or_mismatched");
      }
    }
    if (initialized && (!Number.isSafeInteger(state.baselineBlock) || state.baselineBlock < 0
      || parsedInstant(state.baselineAt, nowMs) === null)) {
      operationalReasons.push("four_registry_baseline_invalid");
    }
    if (!Array.isArray(state.outbox)) operationalReasons.push("four_registry_outbox_invalid");
    else if (state.outbox.length > 0) coverageReasons.push("four_registry_delivery_pending");
    if (!state.pendingConfirmations || typeof state.pendingConfirmations !== "object"
      || Array.isArray(state.pendingConfirmations)) {
      operationalReasons.push("four_registry_pending_confirmations_invalid");
    }
    if (!state.processedEvents || typeof state.processedEvents !== "object"
      || Array.isArray(state.processedEvents)
      || !Array.isArray(state.processedEventKeys)) {
      operationalReasons.push("four_registry_processed_events_invalid");
    }
  }

  return laneResult({
    id: "fourRegistry",
    required,
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    progress,
    semantic: {
      configured: true,
      version: Number.isSafeInteger(state.version) ? state.version : null,
      chainId: Number.isSafeInteger(state.chainId) ? state.chainId : null,
      initialized,
      updatedAt: updatedMs === null ? null : new Date(updatedMs).toISOString(),
      registry: validEvmAddress(state.registry) ? state.registry : null,
      core: validEvmAddress(state.core) ? state.core : null,
      pendingConfirmationCount: state.pendingConfirmations && typeof state.pendingConfirmations === "object"
        && !Array.isArray(state.pendingConfirmations) ? Object.keys(state.pendingConfirmations).length : null,
      pendingDeliveryCount: Array.isArray(state.outbox) ? state.outbox.length : null,
      checkpointCount: Array.isArray(state.checkpoints) ? state.checkpoints.length : null,
    },
  });
}

function evaluateUniswap(record, previous, nowMs, maximumAgeSeconds, required) {
  if (!required) {
    return laneResult({
      id: "uniswap",
      required,
      maximumAgeSeconds,
      record,
      semantic: { configured: false, sources: {} },
    });
  }
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, { checkFileAge: false });
  const coverageReasons = [];
  const warnings = [];
  const state = record.value || {};
  const health = state._health || {};
  const sources = [];
  const sourceSummary = {};
  let latestAttemptMs = null;
  let anyScheduledBackoff = false;

  if (!record.parseError) {
    if (state.version !== 1) operationalReasons.push("uniswap_state_version_invalid");
    sources.push({ name: "blog", state: state.blog, health: health.blog });
    sources.push({ name: "governance", state: state.governance, health: health.governance });
    const releaseStates = state.githubReleases?.feeds;
    const releaseHealth = health.githubReleases;
    const releaseUrls = new Set([
      ...Object.keys(releaseStates && typeof releaseStates === "object" ? releaseStates : {}),
      ...Object.keys(releaseHealth && typeof releaseHealth === "object" ? releaseHealth : {}),
    ]);
    if (releaseUrls.size === 0) {
      operationalReasons.push("uniswap_critical_source_missing:githubReleases");
      coverageReasons.push("uniswap_source_incomplete:githubReleases:missing");
    }
    for (const url of releaseUrls) {
      sources.push({
        name: `github:${String(url).slice(0, 180)}`,
        state: releaseStates?.[url],
        health: releaseHealth?.[url],
      });
    }

    for (const source of sources) {
      if (!source.state || typeof source.state !== "object" || Array.isArray(source.state)
        || !source.health || typeof source.health !== "object" || Array.isArray(source.health)) {
        operationalReasons.push(`uniswap_critical_source_missing:${source.name}`);
        coverageReasons.push(`uniswap_source_incomplete:${source.name}:missing`);
        sourceSummary[source.name] = { status: "missing", initialized: false };
        continue;
      }
      const attempt = schedulerAttemptState(source.health, nowMs, maximumAgeSeconds);
      const initialized = parsedInstant(source.state.initializedAt, nowMs) !== null;
      const lastSuccessMs = parsedInstant(source.health.lastSuccessAt, nowMs);
      if (attempt.lastAttemptMs !== null) latestAttemptMs = Math.max(latestAttemptMs ?? 0, attempt.lastAttemptMs);
      if (!attempt.operational) operationalReasons.push(`uniswap_source_stalled:${source.name}`);
      const complete = initialized
        && attempt.status === "healthy"
        && lastSuccessMs !== null
        && ageSeconds(lastSuccessMs, nowMs) <= maximumAgeSeconds;
      if (!complete) coverageReasons.push(`uniswap_source_incomplete:${source.name}:${attempt.status}`);
      if (SOURCE_LIMITED_STATUSES.has(attempt.status)) {
        warnings.push(`uniswap_source_limited:${source.name}:${attempt.status}`);
        anyScheduledBackoff ||= attempt.nextAttemptMs !== null;
      }
      sourceSummary[source.name] = {
        status: attempt.status,
        initialized,
        lastAttemptAt: attempt.lastAttemptMs === null ? null : new Date(attempt.lastAttemptMs).toISOString(),
        lastSuccessAt: lastSuccessMs === null ? null : new Date(lastSuccessMs).toISOString(),
        nextAttemptAt: attempt.nextAttemptMs === null ? null : new Date(attempt.nextAttemptMs).toISOString(),
      };
    }
  }

  const progress = latestAttemptMs === null ? null : progressRecord({
    key: "latestSourceAttemptAtMs",
    value: latestAttemptMs,
    sourceAtMs: latestAttemptMs,
    previous: previous?.progress,
    nowMs,
    maxAgeSeconds: maximumAgeSeconds,
  });
  if (progress?.frozen) {
    if (anyScheduledBackoff) coverageReasons.push("uniswap_scheduler_frozen_during_source_backoff");
    else operationalReasons.push("uniswap_scheduler_frozen");
  }

  return laneResult({
    id: "uniswap",
    required,
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      configured: true,
      version: Number.isSafeInteger(state.version) ? state.version : null,
      sourceCount: sources.length,
      sources: sourceSummary,
    },
  });
}

function evaluateXaiOfficial(record, previous, nowMs, maximumAgeSeconds, required) {
  if (!required) {
    return laneResult({
      id: "xaiOfficial",
      required,
      maximumAgeSeconds,
      record,
      semantic: { configured: false, sources: {} },
    });
  }
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, { checkFileAge: false });
  const coverageReasons = [];
  const warnings = [];
  const state = record.value || {};
  const health = state.health || {};
  const sourceSummary = {};
  let checkedMs = null;
  let anyScheduledBackoff = false;

  if (!record.parseError) {
    if (state.version !== 1) operationalReasons.push("xai_official_state_version_invalid");
    checkedMs = semanticFreshness(
      health.checkedAt,
      nowMs,
      maximumAgeSeconds,
      "xai_official",
      operationalReasons,
    );
    const aggregateStatus = normalizedStatus(health.status);
    if (aggregateStatus !== "healthy") coverageReasons.push(`xai_official_status_${aggregateStatus}`);
    for (const name of XAI_OFFICIAL_SOURCE_NAMES) {
      const sourceState = state.sources?.[name];
      const sourceHealth = health.sources?.[name];
      if (!sourceState || typeof sourceState !== "object" || Array.isArray(sourceState)
        || !sourceHealth || typeof sourceHealth !== "object" || Array.isArray(sourceHealth)) {
        operationalReasons.push(`xai_official_critical_source_missing:${name}`);
        coverageReasons.push(`xai_official_source_incomplete:${name}:missing`);
        sourceSummary[name] = { status: "missing", initialized: false };
        continue;
      }
      const attempt = sourceAttemptState(sourceHealth, nowMs, maximumAgeSeconds, "checkedAt");
      const initialized = sourceState.initialized === true;
      const lastSuccessMs = parsedInstant(sourceHealth.lastSuccessAt, nowMs);
      if (!attempt.operational) operationalReasons.push(`xai_official_source_stalled:${name}`);
      const complete = initialized
        && attempt.status === "healthy"
        && lastSuccessMs !== null
        && ageSeconds(lastSuccessMs, nowMs) <= maximumAgeSeconds;
      if (!complete) coverageReasons.push(`xai_official_source_incomplete:${name}:${attempt.status}`);
      if (SOURCE_LIMITED_STATUSES.has(attempt.status)) {
        warnings.push(`xai_official_source_limited:${name}:${attempt.status}`);
        anyScheduledBackoff ||= attempt.nextAttemptMs !== null;
      }
      sourceSummary[name] = {
        status: attempt.status,
        initialized,
        checkedAt: attempt.lastAttemptMs === null ? null : new Date(attempt.lastAttemptMs).toISOString(),
        lastSuccessAt: lastSuccessMs === null ? null : new Date(lastSuccessMs).toISOString(),
        nextAttemptAt: attempt.nextAttemptMs === null ? null : new Date(attempt.nextAttemptMs).toISOString(),
      };
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
  if (progress?.frozen) {
    if (anyScheduledBackoff) coverageReasons.push("xai_official_scheduler_frozen_during_source_backoff");
    else operationalReasons.push("xai_official_scheduler_frozen");
  }

  return laneResult({
    id: "xaiOfficial",
    required,
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      configured: true,
      version: Number.isSafeInteger(state.version) ? state.version : null,
      status: normalizedStatus(health.status),
      checkedAt: checkedMs === null ? null : new Date(checkedMs).toISOString(),
      sources: sourceSummary,
    },
  });
}

function evaluateTelegramNews(record, previous, nowMs, maximumAgeSeconds, required) {
  if (!required) {
    return laneResult({
      id: "telegramNews",
      required,
      maximumAgeSeconds,
      record,
      semantic: { configured: false },
    });
  }
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, { checkFileAge: false });
  const coverageReasons = [];
  const warnings = [];
  const state = record.value || {};
  const health = state.health || {};
  const attempt = schedulerAttemptState(health, nowMs, maximumAgeSeconds);
  const initialized = parsedInstant(state.initializedAt, nowMs) !== null;
  const lastSuccessMs = parsedInstant(health.lastSuccessAt, nowMs);
  let progress = null;

  if (!record.parseError) {
    if (state.version !== 1) operationalReasons.push("telegram_news_state_version_invalid");
    if (String(state.identity?.chatId || "") !== TELEGRAM_NEWS_CHAT_ID
      || String(state.identity?.username || "").toLowerCase() !== TELEGRAM_NEWS_USERNAME
      || state.identity?.visibility !== "public") {
      operationalReasons.push("telegram_news_pinned_identity_mismatch");
    }
    if (!attempt.operational) {
      (initialized ? operationalReasons : coverageReasons).push(
        initialized ? "telegram_news_scheduler_stalled" : "telegram_news_startup_pending",
      );
    }
    if (!initialized) coverageReasons.push("telegram_news_baseline_pending");
    if (attempt.status !== "healthy"
      || lastSuccessMs === null
      || ageSeconds(lastSuccessMs, nowMs) > maximumAgeSeconds) {
      coverageReasons.push(`telegram_news_source_incomplete:${attempt.status}`);
    }
    if (SOURCE_LIMITED_STATUSES.has(attempt.status)) warnings.push(`telegram_news_source_limited:${attempt.status}`);

    if (attempt.lastAttemptMs !== null) {
      progress = progressRecord({
        key: "lastAttemptAtMs",
        value: attempt.lastAttemptMs,
        sourceAtMs: attempt.lastAttemptMs,
        previous: previous?.progress,
        nowMs,
        maxAgeSeconds: maximumAgeSeconds,
      });
      if (progress.frozen) {
        if (SOURCE_LIMITED_STATUSES.has(attempt.status) && attempt.nextAttemptMs !== null) {
          coverageReasons.push("telegram_news_scheduler_frozen_during_source_backoff");
        } else operationalReasons.push("telegram_news_scheduler_frozen");
      }
    }
  }

  return laneResult({
    id: "telegramNews",
    required,
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      configured: true,
      version: Number.isSafeInteger(state.version) ? state.version : null,
      initialized,
      status: attempt.status,
      identity: {
        chatId: state.identity?.chatId ? String(state.identity.chatId).slice(0, 40) : null,
        username: state.identity?.username ? String(state.identity.username).slice(0, 80) : null,
      },
      lastAttemptAt: attempt.lastAttemptMs === null ? null : new Date(attempt.lastAttemptMs).toISOString(),
      lastSuccessAt: lastSuccessMs === null ? null : new Date(lastSuccessMs).toISOString(),
      nextAttemptAt: attempt.nextAttemptMs === null ? null : new Date(attempt.nextAttemptMs).toISOString(),
      messageCount: state.messages && typeof state.messages === "object" ? Object.keys(state.messages).length : 0,
    },
  });
}

function evaluateTwitter(record, previous, nowMs, maximumAgeSeconds, required) {
  if (!required) {
    return laneResult({
      id: "twitter",
      required,
      maximumAgeSeconds,
      record,
      semantic: { configured: false },
    });
  }
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, { checkFileAge: false });
  const coverageReasons = [];
  const warnings = [];
  const health = record.value?._meta?.health || {};
  const coverage = health.coverageAccounts || {};
  const status = normalizedStatus(health.status);
  let checkedMs = null;
  let progress = null;
  const countNames = ["total", "covered", "healthy", "fallback", "unavailable", "priorityTotal", "priorityCovered"];
  const countsValid = countNames.every((name) => Number.isSafeInteger(coverage[name]) && coverage[name] >= 0);

  if (!record.parseError) {
    if (!record.value?._meta || !record.value._meta.health) {
      operationalReasons.push("twitter_aggregate_health_missing");
      coverageReasons.push("twitter_coverage_unknown");
    } else {
      checkedMs = semanticFreshness(
        health.checkedAt,
        nowMs,
        maximumAgeSeconds,
        "twitter",
        operationalReasons,
      );
      if (!countsValid
        || coverage.covered > coverage.total
        || coverage.healthy > coverage.covered
        || coverage.fallback > coverage.covered
        || coverage.unavailable > coverage.total
        || coverage.healthy + coverage.fallback !== coverage.covered
        || coverage.unavailable !== coverage.total - coverage.covered
        || coverage.priorityCovered > coverage.priorityTotal
        || coverage.priorityTotal > coverage.total) {
        operationalReasons.push("twitter_coverage_counters_invalid");
      } else {
        if (coverage.total === 0) coverageReasons.push("twitter_no_configured_targets");
        else if (coverage.covered < coverage.total) coverageReasons.push("twitter_account_coverage_incomplete");
        if (coverage.priorityCovered < coverage.priorityTotal) {
          coverageReasons.push("twitter_critical_source_coverage_incomplete");
        }
      }
      if (status !== "healthy") {
        coverageReasons.push(`twitter_status_${status}`);
        warnings.push("twitter_source_limited");
      }
      const successMs = parsedInstant(health.lastSuccessAt, nowMs);
      if (successMs === null || ageSeconds(successMs, nowMs) > maximumAgeSeconds) {
        coverageReasons.push("twitter_last_success_stale");
      }
      if (checkedMs !== null) {
        progress = progressRecord({
          key: "healthCheckedAtMs",
          value: checkedMs,
          sourceAtMs: checkedMs,
          previous: previous?.progress,
          nowMs,
          maxAgeSeconds: maximumAgeSeconds,
        });
        if (progress.frozen) operationalReasons.push("twitter_scheduler_frozen");
      }
    }
  }

  return laneResult({
    id: "twitter",
    required,
    maximumAgeSeconds,
    record,
    operationalReasons,
    coverageReasons,
    warnings,
    progress,
    semantic: {
      configured: true,
      status,
      checkedAt: checkedMs === null ? null : new Date(checkedMs).toISOString(),
      lastSuccessAt: isoOrNull(health.lastSuccessAt, nowMs),
      coverageAccounts: countsValid ? Object.fromEntries(countNames.map((name) => [name, coverage[name]])) : null,
    },
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
  const call = callRecord.value || {};
  const summary = call.coverageSummary || {};
  const callCheckedMs = parsedInstant(call.health?.checkedAt, nowMs);
  const summaryCheckedMs = parsedInstant(summary.checkedAt, nowMs);
  const smartMoney = call.publicOnchain?.smartMoney;
  const emptyRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
  // The collector deliberately leaves its chain cursor untouched when no
  // qualified targets exist. Require fresh, internally consistent collector
  // evidence before exempting that idle cursor from the stalled-worker test.
  const idleWithoutTargets = !callRecord.parseError
    && callCheckedMs !== null && ageSeconds(callCheckedMs, nowMs) <= 180
    && summaryCheckedMs !== null && ageSeconds(summaryCheckedMs, nowMs) <= maximumAgeSeconds
    && ["healthy", "healthy_no_updates", "partial"].includes(call.health?.status)
    && call.health?.consecutiveFailures === 0 && !call.health?.lastError
    && summary.monitoredTopCount === 0
    && summary.targetWallets?.evm === 0 && summary.targetWallets?.solana === 0
    && summary.chainCoverage?.bsc === "not_configured"
    && summary.chainCoverage?.smartMoney?.qualification === "empty"
    && summary.chainCoverage?.smartMoney?.admitted === 0
    && Array.isArray(smartMoney?.admittedWallets) && smartMoney.admittedWallets.length === 0
    && emptyRecord(smartMoney?.pendingTrades);
  const operationalReasons = baseRecordReasons(record, maximumAgeSeconds, { checkFileAge: !idleWithoutTargets });
  const coverageReasons = [];
  const updatedMs = record.parseError || !required
    ? null
    : semanticFreshness(record.value?.updatedAt, nowMs, maximumAgeSeconds, "fomo_checkpoint", operationalReasons);
  if (idleWithoutTargets) {
    const staleIndex = operationalReasons.indexOf("fomo_checkpoint_stale");
    if (staleIndex >= 0) operationalReasons.splice(staleIndex, 1);
    coverageReasons.push("fomo_checkpoint_idle_no_admitted_targets");
  }
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
    if (progress.frozen && !idleWithoutTargets) operationalReasons.push("fomo_checkpoint_cursor_frozen");
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
      idleWithoutTargets,
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
  const operationalStatus = normalizedStatus(health.operationalStatus);
  const lastOperationalSuccessMs = parsedInstant(health.lastOperationalSuccessAt, nowMs);
  const consecutiveFailures = health.consecutiveFailures;
  const coverage = health.coverage || {};
  const eligible = finiteCount(coverage.eligibleCount ?? health.eligibleCount);
  const live = finiteCount(coverage.liveCount ?? health.liveCount ?? health.activeCount);
  const sourceCoverage = normalizedStatus(health.sources?.x?.coverage, "complete");
  if (required && !record.parseError) {
    if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 0) {
      operationalReasons.push("fomo_x_consecutive_failures_invalid");
    }
    if (operationalStatus === "error") {
      operationalReasons.push("fomo_x_operational_status_error");
    } else if (!["healthy", "partial", "backoff", "idle"].includes(operationalStatus)) {
      operationalReasons.push(`fomo_x_operational_status_${operationalStatus}`);
    }
    if (operationalStatus === "healthy" && consecutiveFailures !== 0) {
      operationalReasons.push("fomo_x_operational_state_inconsistent");
    }
    if (operationalStatus === "error" && consecutiveFailures === 0) {
      operationalReasons.push("fomo_x_operational_state_inconsistent");
    }
    if (lastOperationalSuccessMs === null) {
      operationalReasons.push("fomo_x_operational_success_missing_or_invalid");
    } else if (ageSeconds(lastOperationalSuccessMs, nowMs) > maximumAgeSeconds) {
      operationalReasons.push("fomo_x_operational_success_stale");
    }
    if (operationalStatus === "partial") coverageReasons.push("fomo_x_operational_partial");
    if (operationalStatus === "backoff") {
      coverageReasons.push("fomo_x_operational_backoff");
      warnings.push("fomo_x_source_limited");
    }
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
      operationalStatus,
      checkedAt: checkedMs === null ? null : new Date(checkedMs).toISOString(),
      lastSuccessAt: isoOrNull(health.lastSuccessAt, nowMs),
      lastOperationalSuccessAt: lastOperationalSuccessMs === null
        ? null : new Date(lastOperationalSuccessMs).toISOString(),
      consecutiveFailures: Number.isSafeInteger(consecutiveFailures) ? consecutiveFailures : null,
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
  launchdServiceImpl = readLaunchdService,
  fetchImpl = globalThis.fetch,
  writeReportFile = true,
} = {}) {
  const settings = buildHealthSettings(env);
  const { dataDir, configDir, limits, requirements, policy, serviceManager } = settings;
  const isLaunchd = serviceManager === "launchd";
  const serviceLabels = isLaunchd
    ? { main: "com.qohfq.robinhood-launchpad-monitor", fomo: "com.qohfq.fomo-call-monitor" }
    : { main: "robinhood-monitor.service", fomo: "robinhood-fomo.service" };
  const readService = (producer) => isLaunchd
    ? launchdServiceImpl({ label: serviceLabels[producer], producer, dataDir, nowMs, maxAgeSeconds: limits.runtimeHeartbeatAgeSeconds })
    : serviceStateImpl(serviceLabels[producer]);
  const checkedAt = new Date(nowMs);
  const [
    nodeId,
    activeId,
    mainServiceResult,
    fomoServiceResult,
    robinhoodRecord,
    binanceRecord,
    bscRecord,
    ponRecord,
    twitterRecord,
    morphRecord,
    flapQuoteRecord,
    geniusRecord,
    gmgnFlowRecord,
    fourRegistryRecord,
    uniswapRecord,
    xaiOfficialRecord,
    telegramNewsRecord,
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
    isLaunchd ? null : readTrimmed(path.join(configDir, "node-id")),
    isLaunchd ? null : readTrimmed(path.join(configDir, "ACTIVE")),
    readService("main"),
    readService("fomo"),
    readJsonRecord(dataDir, "state.json", nowMs),
    readJsonRecord(dataDir, "binance-state.json", nowMs),
    readBscRecord(dataDir, nowMs),
    readJsonRecord(dataDir, "pon-state.json", nowMs),
    readJsonRecord(dataDir, "twitter-state.json", nowMs),
    readJsonRecord(dataDir, "morph-launchpad-state.json", nowMs),
    readJsonRecord(dataDir, "flap-quote-state.json", nowMs),
    readJsonRecord(dataDir, "genius-state.json", nowMs),
    readJsonRecord(dataDir, "gmgn-flow-state.json", nowMs),
    readJsonRecord(dataDir, "four-registry-state.json", nowMs),
    readJsonRecord(dataDir, "uniswap-state.json", nowMs),
    readJsonRecord(dataDir, "xai-official-state.json", nowMs),
    readJsonRecord(dataDir, "telegram-news-state.json", nowMs),
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
  const mainService = isLaunchd ? mainServiceResult.state : mainServiceResult;
  const fomoService = isLaunchd ? fomoServiceResult.state : fomoServiceResult;
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
    evaluateMorph(
      morphRecord,
      previousLanes.morph,
      nowMs,
      limits.morphAgeSeconds,
      requirements.morph,
    ),
    evaluateFlapQuote(
      flapQuoteRecord,
      previousLanes.flapQuote,
      nowMs,
      limits.flapQuoteAgeSeconds,
      requirements.flapQuote,
    ),
    evaluateGenius(geniusRecord, previousLanes.genius, nowMs, limits.geniusAgeSeconds,
      requirements.genius, settings.geniusPollIntervals),
    evaluateGmgnFlow(gmgnFlowRecord, nowMs, limits.gmgnFlowAgeSeconds,
      limits.gmgnFlowSourceAgeSeconds, requirements.gmgnFlow),
    evaluateFourRegistry(
      fourRegistryRecord,
      previousLanes.fourRegistry,
      nowMs,
      limits.fourRegistryAgeSeconds,
      requirements.fourRegistry,
    ),
    evaluateUniswap(
      uniswapRecord,
      previousLanes.uniswap,
      nowMs,
      limits.uniswapAgeSeconds,
      requirements.uniswap,
    ),
    evaluateXaiOfficial(
      xaiOfficialRecord,
      previousLanes.xaiOfficial,
      nowMs,
      limits.xaiOfficialAgeSeconds,
      requirements.xaiOfficial,
    ),
    evaluateTelegramNews(
      telegramNewsRecord,
      previousLanes.telegramNews,
      nowMs,
      limits.telegramNewsAgeSeconds,
      requirements.telegramNews,
    ),
    evaluateTwitter(
      twitterRecord,
      previousLanes.twitter,
      nowMs,
      limits.twitterAgeSeconds,
      requirements.twitter,
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
  if (!isLaunchd && (!nodeId || activeId !== nodeId)) operationalFailures.push("local ACTIVE marker does not match this node");
  if (mainService !== "active") operationalFailures.push(`${serviceLabels.main} is ${mainService}`);
  if (fomoService !== "active") operationalFailures.push(`${serviceLabels.fomo} is ${fomoService}`);
  if (isLaunchd) {
    for (const [producer, result] of [["main", mainServiceResult], ["fomo", fomoServiceResult]]) {
      if (!result.heartbeat?.healthy) operationalFailures.push(`${producer} runtime: ${(result.heartbeat?.reasons || ["heartbeat_missing"]).join(",")}`);
    }
  }
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
    serviceManager,
    ...(isLaunchd ? { runtimeServices: { main: mainServiceResult, fomo: fomoServiceResult } } : {}),
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
