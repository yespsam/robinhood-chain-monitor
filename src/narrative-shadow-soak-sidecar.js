import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { atomicWriteRuntimeHeartbeat } from "./runtime-heartbeat.js";

export const NARRATIVE_SHADOW_SOAK_VERSION = 1;
export const NARRATIVE_SHADOW_SOAK_SCHEMA = "narrative_shadow_soak_v1";
export const NARRATIVE_SHADOW_SOAK_CHECKPOINT_SCHEMA = "narrative_shadow_soak_checkpoint_v1";

const DEFAULT_DURATION_MS = 24 * 60 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_SOURCE_COUNT = 8;
const MAX_SEEN_RECORDS = 50_000;

const compactError = (error) => String(error?.message || error || "unknown error").slice(0, 500);

function positiveInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new TypeError(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function clockMilliseconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError("shadow soak clock returned an invalid timestamp");
  return milliseconds;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function explicitCoverageReady(assessment) {
  const market = assessment?.marketEvidence || assessment?.market || {};
  const risk = assessment?.riskEvidence || assessment?.risk || {};
  const coverage = risk?.coverage || {};
  const holderReady = ["verified_safe", "complete_safe"].includes(coverage.holderConcentration);
  const lpReady = ["verified_locked_or_burned", "complete_safe"].includes(coverage.lpLockOrBurn);
  return {
    ready: market.walletClusterConfirmed === true && holderReady && lpReady,
    missing: [
      ...(market.walletClusterConfirmed === true ? [] : ["wallet_cluster_unverified"]),
      ...(holderReady ? [] : ["holder_concentration_unverified"]),
      ...(lpReady ? [] : ["lp_lock_or_burn_unverified"]),
    ],
  };
}

/**
 * Prevents this observation-only soak from producing a paper order. Missing
 * wallet/holder/LP evidence is recorded, and even a future fully-covered
 * assessment remains watch-only until it is promoted through a separate,
 * reviewed deployment.
 */
export function createAuditOnlyLiveEvidenceProvider(provider) {
  if (!provider || typeof provider.assess !== "function" || typeof provider.stop !== "function") {
    throw new TypeError("audit-only evidence guard requires assess() and stop()");
  }
  let stopped = false;
  return Object.freeze({
    async assess(input) {
      if (stopped) throw new Error("audit-only evidence provider is stopped");
      const assessment = await provider.assess(input);
      if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) {
        throw new TypeError("live evidence assessment must be an object");
      }
      const admission = explicitCoverageReady(assessment);
      const reasons = admission.ready ? ["audit_only_soak_policy"] : admission.missing;
      const market = clone(assessment.marketEvidence || assessment.market || {});
      const missing = [...new Set([...(Array.isArray(market.missing) ? market.missing : []), ...reasons])];
      return deepFreeze({
        ...clone(assessment),
        status: assessment.status === "blocked" ? "blocked" : "partial",
        complete: false,
        marketEvidence: {
          ...market,
          marketConfirmed: false,
          walletClusterConfirmed: false,
          entryWindow: "closed",
          missing,
          shadowSoakAdmission: {
            status: "watch_only",
            executable: false,
            reasons,
          },
        },
        soakGuard: {
          version: 1,
          mode: "shadow_watch_only",
          executable: false,
          reasons,
        },
      });
    },
    collect(input) { return this.assess(input); },
    getEvidence(input) { return this.assess(input); },
    invalidate(filter) { return provider.invalidate?.(filter); },
    stats() { return { guarded: true, stopped, upstream: provider.stats?.() ?? null }; },
    async stop() {
      if (stopped) return;
      stopped = true;
      await provider.stop();
    },
  });
}

/**
 * A capability-level deny ledger for observation-only soaks. The surrounding
 * runtime can exercise its normal evaluation path, but no order lifecycle
 * mutation is available even if an upstream regression emits a `do` signal.
 */
export function createAuditOnlyShadowLedger() {
  let stopped = false;
  const state = () => ({
    version: 1,
    schema: "narrative_shadow_soak_deny_ledger_v1",
    mode: "shadow_watch_only",
    executable: false,
    stopped,
    orders: {},
  });
  const metrics = () => ({
    mode: "shadow_watch_only",
    executable: false,
    stopped,
    totalOrders: 0,
    activeOrders: 0,
    closedOrders: 0,
  });
  const deny = async () => {
    const error = new Error("shadow soak ledger mutations are disabled by policy");
    error.code = "shadow_soak_ledger_mutation_forbidden";
    throw error;
  };
  return Object.freeze({
    ready: Promise.resolve(true),
    admit: deny,
    open: deny,
    mark: deny,
    close: deny,
    expire: deny,
    invalidate: deny,
    async getOrder() { return null; },
    async getState() { return state(); },
    async getMetrics() { return metrics(); },
    async metrics() { return metrics(); },
    async stop() { stopped = true; },
  });
}

async function syncDirectory(directory, fsImpl) {
  let handle;
  try {
    handle = await fsImpl.open(directory, "r");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

/** A serialized, fsynced JSONL sink. It has no network dependency. */
export function createDurableLocalAlertSink(file, { fsImpl = fs, now = Date.now } = {}) {
  const outputFile = path.resolve(String(file || ""));
  if (!file) throw new TypeError("local alert sink file is required");
  let serial = Promise.resolve();
  let stopped = false;

  function append(record) {
    if (stopped) return Promise.reject(new Error("local alert sink is stopped"));
    const operation = serial.catch(() => {}).then(async () => {
      const directory = path.dirname(outputFile);
      await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
      const existing = await fsImpl.lstat(outputFile).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (existing?.isSymbolicLink()) {
        throw new Error(`refusing to append local shadow output through a symbolic link: ${outputFile}`);
      }
      let handle;
      try {
        const flags = fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_APPEND
          | (fsConstants.O_NOFOLLOW || 0)
          | (fsConstants.O_NONBLOCK || 0);
        handle = await fsImpl.open(outputFile, flags, 0o600);
        const opened = await handle.stat();
        if (!opened.isFile()) throw new Error(`local shadow output is not a regular file: ${outputFile}`);
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
        await handle.chmod(0o600);
      } finally {
        await handle?.close();
      }
      await syncDirectory(directory, fsImpl);
      return record;
    });
    serial = operation;
    return operation;
  }

  return Object.freeze({
    file: outputFile,
    async send(_config, event, metadata = {}) {
      const recordedAt = new Date(clockMilliseconds(now)).toISOString();
      const record = {
        schema: "narrative_shadow_soak_local_alert_v1",
        recordedAt,
        metadata: clone(metadata),
        event: clone(event),
      };
      await append(record);
      return {
        status: "queued",
        destination: "local_fsynced_jsonl",
        eventKey: event?.eventKey || event?.id || null,
      };
    },
    append,
    async stop() {
      stopped = true;
      await serial.catch(() => {});
    },
  });
}

function validateSources(sourceFiles) {
  if (!Array.isArray(sourceFiles) || sourceFiles.length < 1 || sourceFiles.length > MAX_SOURCE_COUNT) {
    throw new TypeError(`sourceFiles must contain 1-${MAX_SOURCE_COUNT} entries`);
  }
  const ids = new Set();
  return sourceFiles.map((source) => {
    const id = String(source?.id || "");
    const file = path.resolve(String(source?.file || ""));
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(id)) throw new TypeError(`invalid source id: ${id}`);
    if (!source?.file) throw new TypeError(`source file is required for ${id}`);
    if (ids.has(id)) throw new TypeError(`duplicate source id: ${id}`);
    ids.add(id);
    return Object.freeze({ id, file });
  });
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function prospectiveRealDirectory(directory, fsImpl, label = "shadow soak dataDir") {
  let cursor = directory;
  while (true) {
    try {
      const entry = await fsImpl.lstat(cursor);
      if (cursor === directory && entry.isSymbolicLink()) {
        throw new Error(`${label} must not be a symbolic link: ${directory}`);
      }
      const realCursor = await fsImpl.realpath(cursor);
      const realEntry = await fsImpl.stat(realCursor);
      if (!realEntry.isDirectory()) {
        throw new Error(`${label} path ancestor is not a directory: ${cursor}`);
      }
      return path.resolve(realCursor, path.relative(cursor, directory));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`no existing ancestor for ${label}: ${directory}`);
      cursor = parent;
    }
  }
}

function defaultCheckpoint(nowIso) {
  return {
    version: NARRATIVE_SHADOW_SOAK_VERSION,
    schema: NARRATIVE_SHADOW_SOAK_CHECKPOINT_SCHEMA,
    createdAt: nowIso,
    updatedAt: nowIso,
    sources: {},
  };
}

function validatedCheckpoint(value) {
  if (!value || value.version !== NARRATIVE_SHADOW_SOAK_VERSION
    || value.schema !== NARRATIVE_SHADOW_SOAK_CHECKPOINT_SCHEMA
    || !value.sources || typeof value.sources !== "object" || Array.isArray(value.sources)) {
    throw new Error("shadow soak checkpoint is invalid or incompatible");
  }
  return value;
}

async function readJson(file, fsImpl) {
  return JSON.parse(await fsImpl.readFile(file, "utf8"));
}

function outboxRecords(payload) {
  const events = payload?.events;
  if (!events || typeof events !== "object") throw new Error("outbox events are missing");
  const rows = Array.isArray(events) ? events.map((entry, index) => [String(entry?.id || index), entry]) : Object.entries(events);
  return rows.map(([fallbackId, entry]) => {
    const id = String(entry?.id || fallbackId || "");
    if (!id) throw new Error("outbox record id is missing");
    const event = entry?.event;
    return {
      id,
      event,
      eventHash: sha256(event ?? null),
      createdAt: String(entry?.createdAt || event?.observedAt || ""),
    };
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

async function outboxSnapshot(source, fsImpl) {
  const before = await fsImpl.stat(source.file);
  if (!before.isFile()) throw new Error(`${source.id} outbox is not a regular file`);
  const payload = await readJson(source.file, fsImpl);
  const after = await fsImpl.stat(source.file);
  return {
    signature: `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}`,
    changedDuringRead: before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs,
    records: outboxRecords(payload),
  };
}

function monitorShape(runtime) {
  return runtime && ["observe", "check", "getState", "getLedgerState", "stop"]
    .every((method) => typeof runtime[method] === "function");
}

/**
 * Reads durable outboxes, but owns no producer and no outbound transport.
 * Existing IDs are baselined; only future IDs are admitted into the runtime.
 */
export function createNarrativeShadowSoak(options = {}, dependencies = {}) {
  const dataDir = path.resolve(String(options.dataDir || ""));
  if (!options.dataDir) throw new TypeError("shadow soak dataDir is required");
  const sourceFiles = validateSources(options.sourceFiles);
  const forbiddenWriteRoots = (Array.isArray(options.forbiddenWriteRoots) ? options.forbiddenWriteRoots : [])
    .map((value) => path.resolve(String(value || "")));
  const ownedWriteDirectories = (Array.isArray(options.ownedWriteDirectories) ? options.ownedWriteDirectories : [])
    .map((value) => path.resolve(String(value || "")));
  if (ownedWriteDirectories.length > 16) throw new TypeError("ownedWriteDirectories exceeds the safe limit");
  for (const directory of ownedWriteDirectories) {
    if (directory === dataDir || !containsPath(dataDir, directory)) {
      throw new TypeError(`owned write directory must be a strict child of dataDir: ${directory}`);
    }
  }
  let runtime = dependencies.runtime || null;
  let kolMonitor = dependencies.kolMonitor || null;
  let cleanup = dependencies.cleanup || (async () => {});
  const initializeDependencies = dependencies.initialize || null;
  if (!runtime && typeof initializeDependencies !== "function") {
    throw new TypeError("shadow soak runtime or initialize() factory is required");
  }
  if (runtime && !monitorShape(runtime)) throw new TypeError("shadow soak runtime is incomplete");
  if (kolMonitor && !["start", "stop", "getState"].every((method) => typeof kolMonitor[method] === "function")) {
    throw new TypeError("KOL monitor is incomplete");
  }
  const fsImpl = dependencies.fsImpl || fs;
  const timers = dependencies.timers || globalThis;
  const now = dependencies.now || Date.now;
  const processRef = dependencies.processRef || process;
  const logger = dependencies.logger || console;
  const writeAtomic = dependencies.atomicWriteImpl || atomicWriteRuntimeHeartbeat;
  const auditSink = dependencies.auditSink || createDurableLocalAlertSink(
    path.join(dataDir, "audit.jsonl"), { fsImpl, now },
  );
  const durationMs = positiveInteger(options.durationMs, DEFAULT_DURATION_MS, "durationMs", 7 * DEFAULT_DURATION_MS);
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs", 60_000);
  const heartbeatIntervalMs = positiveInteger(
    options.heartbeatIntervalMs,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    "heartbeatIntervalMs",
    10 * 60_000,
  );
  const maximumSeenRecords = positiveInteger(
    options.maximumSeenRecords,
    MAX_SEEN_RECORDS,
    "maximumSeenRecords",
    1_000_000,
  );
  const pid = Number(processRef.pid);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new TypeError("shadow soak process pid is invalid");

  const runId = randomBytes(16).toString("hex");
  const checkpointFile = path.join(dataDir, "checkpoint.json");
  const heartbeatFile = path.join(dataDir, "heartbeat.json");
  const statusFile = path.join(dataDir, "status.json");
  const lockFile = path.join(dataDir, "run.lock");
  const startedAtMs = clockMilliseconds(now);
  const startedAt = new Date(startedAtMs).toISOString();
  const deadlineAt = new Date(startedAtMs + durationMs).toISOString();
  const metrics = {
    polls: 0,
    baselineRecords: 0,
    observedRecords: 0,
    ignoredRecords: 0,
    sourceErrors: 0,
    observationErrors: 0,
    mutationsQuarantined: 0,
    runtimeErrors: 0,
  };
  const sourceStatus = Object.fromEntries(sourceFiles.map((source) => [source.id, {
    file: source.file,
    baselined: false,
    records: 0,
    lastReadAt: null,
    lastError: null,
  }]));
  const sourceSignatures = new Map();
  let checkpoint = null;
  let state = "initializing";
  let lastError = null;
  let stopReason = null;
  let fatalError = null;
  let lockOwned = false;
  let started = false;
  let stopping = false;
  let pollTimer = null;
  let heartbeatTimer = null;
  let durationTimer = null;
  let pollFlight = null;
  let pulseFlight = null;
  let kolStartFlight = null;
  let kolState = null;
  let kolError = null;
  let lastRuntimeState = null;
  let lastLedgerMetrics = null;
  let lastSimulatorMetrics = null;
  let stopPromise = null;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  void done.catch(() => {});

  const nowIso = () => new Date(clockMilliseconds(now)).toISOString();

  async function writeCheckpoint() {
    checkpoint.updatedAt = nowIso();
    await writeAtomic(checkpointFile, checkpoint, fsImpl);
  }

  async function acquireLock() {
    const realForbiddenRoots = await Promise.all(forbiddenWriteRoots.map((root) => fsImpl.realpath(root)));
    const prospectiveDataDir = await prospectiveRealDirectory(dataDir, fsImpl);
    for (let index = 0; index < forbiddenWriteRoots.length; index += 1) {
      const root = forbiddenWriteRoots[index];
      const realRoot = realForbiddenRoots[index];
      if (containsPath(realRoot, prospectiveDataDir)) {
        throw new Error(`refusing to create shadow soak state inside protected root ${root}`);
      }
    }
    await fsImpl.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const dataEntry = await fsImpl.lstat(dataDir);
    if (dataEntry.isSymbolicLink() || !dataEntry.isDirectory()) {
      throw new Error(`shadow soak dataDir must be a real directory: ${dataDir}`);
    }
    const realDataDir = await fsImpl.realpath(dataDir);
    for (let index = 0; index < forbiddenWriteRoots.length; index += 1) {
      const root = forbiddenWriteRoots[index];
      const realRoot = realForbiddenRoots[index];
      if (containsPath(realRoot, realDataDir)) {
        throw new Error(`refusing to write shadow soak state inside protected root ${root}`);
      }
    }
    for (const directory of ownedWriteDirectories) {
      const prospectiveDirectory = await prospectiveRealDirectory(directory, fsImpl, "owned write directory");
      if (!containsPath(realDataDir, prospectiveDirectory)) {
        throw new Error(`owned write directory escapes shadow soak dataDir: ${directory}`);
      }
      for (let index = 0; index < forbiddenWriteRoots.length; index += 1) {
        if (containsPath(realForbiddenRoots[index], prospectiveDirectory)) {
          throw new Error(`refusing to create owned shadow state inside protected root ${forbiddenWriteRoots[index]}`);
        }
      }
      await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
      const entry = await fsImpl.lstat(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`owned write directory must be a real directory: ${directory}`);
      }
      const realDirectory = await fsImpl.realpath(directory);
      if (!containsPath(realDataDir, realDirectory)) {
        throw new Error(`owned write directory resolved outside shadow soak dataDir: ${directory}`);
      }
    }
    for (const source of sourceFiles) {
      const realSource = await fsImpl.realpath(source.file).catch((error) => {
        if (error?.code === "ENOENT") return source.file;
        throw error;
      });
      if (containsPath(realDataDir, realSource)) {
        throw new Error(`refusing to consume a source from the shadow soak write directory: ${source.id}`);
      }
    }
    let handle;
    try {
      handle = await fsImpl.open(lockFile, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({
        version: 1,
        runId,
        pid,
        startedAt,
        deadlineAt,
      })}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fsImpl.chmod(lockFile, 0o600);
      await syncDirectory(dataDir, fsImpl);
      lockOwned = true;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code === "EEXIST") {
        throw new Error(`shadow soak lock already exists at ${lockFile}; inspect it before explicit stale-lock recovery`);
      }
      throw error;
    }
  }

  async function releaseLock() {
    if (!lockOwned) return;
    const owner = await readJson(lockFile, fsImpl).catch(() => null);
    if (owner?.runId !== runId || owner?.pid !== pid) throw new Error("shadow soak lock ownership changed");
    await fsImpl.unlink(lockFile);
    await syncDirectory(dataDir, fsImpl);
    lockOwned = false;
  }

  async function initializeSource(source, { baseline }) {
    let snapshot;
    try {
      snapshot = await outboxSnapshot(source, fsImpl);
    } catch (error) {
      if (error?.code === "ENOENT") {
        const current = checkpoint.sources[source.id] || {
          file: source.file,
          baselined: true,
          baselinedAt: null,
          entries: {},
        };
        if (current.file !== source.file) throw new Error(`checkpoint source path changed for ${source.id}`);
        if (!current.baselined) current.baselined = true;
        if (!current.baselinedAt) current.baselinedAt = nowIso();
        current.entries ||= {};
        checkpoint.sources[source.id] = current;
        sourceStatus[source.id] = {
          ...sourceStatus[source.id],
          baselined: true,
          records: 0,
          lastReadAt: nowIso(),
          lastError: "source_missing",
        };
        sourceSignatures.set(source.id, null);
        await auditSink.append({
          schema: "narrative_shadow_soak_audit_v1",
          kind: "source_missing_at_baseline",
          recordedAt: nowIso(),
          sourceId: source.id,
          records: 0,
        });
        return true;
      }
      throw error;
    }
    const current = checkpoint.sources[source.id] || {
      file: source.file,
      baselined: false,
      baselinedAt: null,
      entries: {},
    };
    if (current.file !== source.file) throw new Error(`checkpoint source path changed for ${source.id}`);
    current.entries ||= {};
    if (Object.keys(current.entries).length + snapshot.records.length > maximumSeenRecords && !current.baselined) {
      throw new Error(`source ${source.id} exceeds the safe checkpoint capacity`);
    }
    if (baseline || !current.baselined) {
      const at = nowIso();
      for (const record of snapshot.records) {
        current.entries[record.id] = {
          acceptedHash: record.eventHash,
          lastObservedHash: record.eventHash,
          firstSeenAt: at,
          mutationQuarantinedAt: null,
        };
      }
      current.baselined = true;
      current.baselinedAt = at;
      metrics.baselineRecords += snapshot.records.length;
      await auditSink.append({
        schema: "narrative_shadow_soak_audit_v1",
        kind: "source_baseline",
        recordedAt: at,
        sourceId: source.id,
        records: snapshot.records.length,
      });
    }
    checkpoint.sources[source.id] = current;
    sourceStatus[source.id] = {
      ...sourceStatus[source.id],
      baselined: true,
      records: snapshot.records.length,
      lastReadAt: nowIso(),
      lastError: snapshot.changedDuringRead ? "source_changed_during_read_will_retry" : null,
    };
    sourceSignatures.set(
      source.id,
      snapshot.changedDuringRead || (!baseline && current.baselined) ? null : snapshot.signature,
    );
    return true;
  }

  async function initialize() {
    try {
      await acquireLock();
      if (!runtime) {
        const initialized = await initializeDependencies();
        runtime = initialized?.runtime || null;
        kolMonitor = initialized?.kolMonitor || null;
        cleanup = initialized?.cleanup || cleanup;
        if (!monitorShape(runtime)) throw new TypeError("shadow soak runtime factory returned an incomplete runtime");
        if (kolMonitor && !["start", "stop", "getState"].every((method) => typeof kolMonitor[method] === "function")) {
          throw new TypeError("shadow soak runtime factory returned an incomplete KOL monitor");
        }
      }
      await safetyCheck();
      let existing = null;
      try { existing = validatedCheckpoint(await readJson(checkpointFile, fsImpl)); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      checkpoint = existing || defaultCheckpoint(startedAt);
      for (const source of sourceFiles) {
        const saved = checkpoint.sources[source.id];
        if (saved?.file && saved.file !== source.file) throw new Error(`checkpoint source path changed for ${source.id}`);
        await initializeSource(source, { baseline: !saved });
      }
      await writeCheckpoint();
      state = "ready";
      await pulse();
      return true;
    } catch (error) {
      lastError = compactError(error);
      state = "failed";
      const safetyFailure = String(error?.code || "").startsWith("shadow_soak_");
      if (safetyFailure) fatalError = error;
      const cleanupFailures = [];
      if (kolMonitor) {
        try { await kolMonitor.stop(); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      }
      if (runtime) {
        try { await runtime.stop(); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      }
      try { await cleanup(); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      try { await auditSink.stop(); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      if (lockOwned && cleanupFailures.length === 0 && !safetyFailure) await releaseLock().catch(() => {});
      const failure = cleanupFailures.length
        ? new AggregateError([error, ...cleanupFailures], "shadow soak initialization and cleanup failed")
        : error;
      rejectDone(failure);
      throw failure;
    }
  }

  const ready = initialize();

  async function processSource(source) {
    const saved = checkpoint.sources[source.id];
    if (!saved?.baselined) {
      const initialized = await initializeSource(source, { baseline: true });
      if (initialized) await writeCheckpoint();
      return { baseline: initialized, observed: 0 };
    }
    let stat;
    try { stat = await fsImpl.stat(source.file); }
    catch (error) {
      if (error?.code === "ENOENT") throw new Error(`${source.id} outbox disappeared`);
      throw error;
    }
    const quickSignature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (sourceSignatures.get(source.id) === quickSignature) return { unchanged: true, observed: 0 };
    const savedBefore = clone(saved);
    const metricsBefore = clone(metrics);
    const sourceStatusBefore = clone(sourceStatus[source.id]);
    try {
    const snapshot = await outboxSnapshot(source, fsImpl);
    let changed = false;
    let observed = 0;
    let retryNeeded = snapshot.changedDuringRead;
    for (const record of snapshot.records) {
      const known = saved.entries[record.id];
      if (known) {
        if (known.lastObservedHash !== record.eventHash) {
          known.lastObservedHash = record.eventHash;
          known.mutationQuarantinedAt = nowIso();
          changed = true;
          metrics.mutationsQuarantined += 1;
          await auditSink.append({
            schema: "narrative_shadow_soak_audit_v1",
            kind: "existing_id_mutation_quarantined",
            recordedAt: known.mutationQuarantinedAt,
            sourceId: source.id,
            recordId: record.id,
            acceptedHash: known.acceptedHash,
            observedHash: record.eventHash,
          });
        }
        continue;
      }
      if (Object.keys(saved.entries).length >= maximumSeenRecords) {
        retryNeeded = true;
        throw new Error(`source ${source.id} reached the safe checkpoint capacity`);
      }
      let result;
      try {
        result = record.event && typeof record.event === "object"
          ? await runtime.observe(clone(record.event))
          : { status: "ignored", reason: "missing_event_payload" };
        await auditSink.append({
          schema: "narrative_shadow_soak_audit_v1",
          kind: "outbox_observation",
          recordedAt: nowIso(),
          sourceId: source.id,
          recordId: record.id,
          eventHash: record.eventHash,
          eventType: record.event?.type || null,
          eventKey: record.event?.eventKey || null,
          result: clone(result),
        });
      } catch (error) {
        metrics.observationErrors += 1;
        retryNeeded = true;
        await auditSink.append({
          schema: "narrative_shadow_soak_audit_v1",
          kind: "outbox_observation_error",
          recordedAt: nowIso(),
          sourceId: source.id,
          recordId: record.id,
          eventHash: record.eventHash,
          error: compactError(error),
        });
        continue;
      }
      if (result?.status === "error") {
        metrics.observationErrors += 1;
        retryNeeded = true;
        continue;
      }
      const at = nowIso();
      saved.entries[record.id] = {
        acceptedHash: record.eventHash,
        lastObservedHash: record.eventHash,
        firstSeenAt: at,
        mutationQuarantinedAt: null,
      };
      changed = true;
      observed += 1;
      metrics.observedRecords += 1;
      if (!record.event || result?.status === "ignored") metrics.ignoredRecords += 1;
    }
    sourceStatus[source.id] = {
      ...sourceStatus[source.id],
      baselined: true,
      records: snapshot.records.length,
      lastReadAt: nowIso(),
      lastError: snapshot.changedDuringRead ? "source_changed_during_read_will_retry" : null,
    };
    if (changed) await writeCheckpoint();
    sourceSignatures.set(source.id, retryNeeded ? null : snapshot.signature);
    return { observed, changed, retryNeeded };
    } catch (error) {
      checkpoint.sources[source.id] = savedBefore;
      Object.assign(metrics, metricsBefore);
      sourceStatus[source.id] = sourceStatusBefore;
      sourceSignatures.set(source.id, null);
      throw error;
    }
  }

  async function safetyCheck() {
    const runtimeState = await runtime.getState();
    const unsafeSignals = Object.values(runtimeState?.signals || {}).filter((record) => (
      record?.decision === "do" || record?.signal?.decision === "do"
    ));
    if (unsafeSignals.length > 0) {
      const error = new Error(`shadow soak safety guard failed: ${unsafeSignals.length} do signal(s) were persisted`);
      error.code = "shadow_soak_do_signal_persisted";
      throw error;
    }
    const ledger = await runtime.getLedgerState();
    const orders = Object.keys(ledger?.orders || {}).length;
    if (orders > 0) {
      const error = new Error(`shadow soak safety guard failed: ${orders} paper order(s) were admitted`);
      error.code = "shadow_soak_order_admitted";
      throw error;
    }
  }

  async function runPoll() {
    await ready;
    if (stopping || state === "stopped" || state === "failed") return { status: "stopped" };
    metrics.polls += 1;
    let degraded = false;
    let observed = 0;
    for (const source of sourceFiles) {
      try {
        const result = await processSource(source);
        observed += result.observed || 0;
      } catch (error) {
        degraded = true;
        metrics.sourceErrors += 1;
        sourceStatus[source.id].lastError = compactError(error);
        lastError = `${source.id}: ${compactError(error)}`;
      }
    }
    try {
      await safetyCheck();
      const result = await runtime.check();
      if (["error", "degraded"].includes(result?.status)) degraded = true;
      await safetyCheck();
      const simulation = await runtime.checkShadowSimulation?.();
      if (["error", "degraded"].includes(simulation?.status)) degraded = true;
      await safetyCheck();
    } catch (error) {
      degraded = true;
      metrics.runtimeErrors += 1;
      lastError = compactError(error);
      if (String(error?.code || "").startsWith("shadow_soak_")) {
        fatalError = error;
        state = "failed";
        stopping = true;
        queueMicrotask(() => { void stop("safety_guard_failed").catch(() => {}); });
      }
    }
    if (state !== "failed") state = degraded ? "degraded" : "running";
    if (!degraded) lastError = null;
    await pulse();
    return { status: state, observed };
  }

  function poll() {
    if (pollFlight) return pollFlight;
    pollFlight = runPoll().finally(() => { pollFlight = null; });
    return pollFlight;
  }

  async function statusSnapshot() {
    let runtimeState = lastRuntimeState;
    let ledgerMetrics = lastLedgerMetrics;
    let simulatorMetrics = lastSimulatorMetrics;
    try {
      runtimeState = await runtime.getState();
      lastRuntimeState = clone(runtimeState);
    } catch (error) { if (!stopping) lastError ||= compactError(error); }
    try {
      ledgerMetrics = await runtime.getMetrics?.();
      lastLedgerMetrics = clone(ledgerMetrics);
    } catch (error) { if (!stopping) lastError ||= compactError(error); }
    try {
      simulatorMetrics = await runtime.getShadowSimulationMetrics?.();
      lastSimulatorMetrics = clone(simulatorMetrics);
    } catch (error) { if (!stopping) lastError ||= compactError(error); }
    return {
      version: NARRATIVE_SHADOW_SOAK_VERSION,
      schema: NARRATIVE_SHADOW_SOAK_SCHEMA,
      producer: "narrative_shadow_soak",
      runId,
      pid,
      state,
      mode: "shadow_watch_only",
      executable: false,
      telegramEnabled: false,
      startedAt,
      deadlineAt,
      updatedAt: nowIso(),
      stopReason,
      lastError,
      metrics: clone(metrics),
      sources: clone(sourceStatus),
      runtime: runtimeState ? {
        health: clone(runtimeState.health || null),
        inbox: Object.keys(runtimeState.inbox || {}).length,
        candidates: Object.keys(runtimeState.candidates || {}).length,
        signals: Object.keys(runtimeState.signals || {}).length,
      } : null,
      ledger: ledgerMetrics,
      simulator: simulatorMetrics,
      kol: {
        enabled: Boolean(kolMonitor),
        error: kolError,
        state: clone(kolState),
      },
    };
  }

  function pulse() {
    if (pulseFlight) return pulseFlight;
    pulseFlight = statusSnapshot()
      .then((snapshot) => writeAtomic(heartbeatFile, snapshot, fsImpl).then(() => snapshot))
      .finally(() => { pulseFlight = null; });
    return pulseFlight;
  }

  function refreshKolState() {
    if (!kolMonitor || kolStartFlight) return;
    kolStartFlight = Promise.resolve(kolMonitor.getState()).then((value) => {
      kolState = value;
      kolError = null;
    }, (error) => {
      kolError = compactError(error);
    }).finally(() => { kolStartFlight = null; });
  }

  async function start() {
    await ready;
    if (started) return { status: state, runId, pid };
    if (stopping) throw new Error("shadow soak is stopping");
    started = true;
    state = "running";
    if (kolMonitor) {
      kolStartFlight = Promise.resolve(kolMonitor.start()).then(async () => {
        kolState = await kolMonitor.getState();
        kolError = null;
      }, (error) => {
        kolError = compactError(error);
        logger.error?.(`[shadow-soak][kol] ${kolError}`);
      }).finally(() => { kolStartFlight = null; });
    }
    pollTimer = timers.setInterval(() => void poll().catch((error) => {
      lastError = compactError(error);
      state = "degraded";
      logger.error?.(`[shadow-soak][poll] ${lastError}`);
    }), pollIntervalMs);
    heartbeatTimer = timers.setInterval(() => {
      refreshKolState();
      void pulse().catch((error) => logger.error?.(`[shadow-soak][heartbeat] ${compactError(error)}`));
    }, heartbeatIntervalMs);
    heartbeatTimer?.unref?.();
    const remainingDurationMs = Math.max(0, Date.parse(deadlineAt) - clockMilliseconds(now));
    durationTimer = timers.setTimeout(() => void stop("duration_elapsed").catch((error) => {
      logger.error?.(`[shadow-soak][stop] ${compactError(error)}`);
    }), remainingDurationMs);
    await poll();
    await pulse();
    return { status: state, runId, pid, startedAt, deadlineAt };
  }

  function stop(reason = "requested") {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopReason = String(reason || "requested").slice(0, 100);
    if (pollTimer != null) timers.clearInterval(pollTimer);
    if (heartbeatTimer != null) timers.clearInterval(heartbeatTimer);
    if (durationTimer != null) timers.clearTimeout(durationTimer);
    pollTimer = heartbeatTimer = durationTimer = null;
    stopPromise = (async () => {
      await ready;
      const failures = fatalError ? [fatalError] : [];
      if (!fatalError) state = "stopping";
      try { await pollFlight; } catch (error) { failures.push(error); }
      try { await pulseFlight; } catch (error) { failures.push(error); }
      if (kolMonitor) {
        try { await kolMonitor.stop(); } catch (error) { failures.push(error); }
        try { await kolStartFlight; } catch (error) { failures.push(error); }
      }
      try { await runtime.stop(); } catch (error) { failures.push(error); }
      try { await cleanup(); } catch (error) { failures.push(error); }
      try {
        await auditSink.append({
          schema: "narrative_shadow_soak_audit_v1",
          kind: "run_stopped",
          recordedAt: nowIso(),
          runId,
          reason: stopReason,
          failures: failures.map(compactError),
        });
      } catch (error) { failures.push(error); }
      try { await auditSink.stop(); } catch (error) { failures.push(error); }
      state = failures.length ? "failed" : "stopped";
      if (failures.length) lastError = failures.map(compactError).join(" | ").slice(0, 500);
      const finalStatus = await statusSnapshot();
      try {
        await writeAtomic(heartbeatFile, finalStatus, fsImpl);
        await writeAtomic(statusFile, finalStatus, fsImpl);
      } catch (error) {
        failures.push(error);
        state = "failed";
        lastError = failures.map(compactError).join(" | ").slice(0, 500);
      }
      if (!failures.length) {
        try {
          await releaseLock();
          resolveDone(finalStatus);
          return finalStatus;
        } catch (error) {
          failures.push(error);
          state = "failed";
          lastError = compactError(error);
        }
      }
      const aggregate = new AggregateError(failures, "shadow soak shutdown failed; lock retained for inspection");
      rejectDone(aggregate);
      throw aggregate;
    })();
    return stopPromise;
  }

  return Object.freeze({
    version: NARRATIVE_SHADOW_SOAK_VERSION,
    schema: NARRATIVE_SHADOW_SOAK_SCHEMA,
    dataDir,
    checkpointFile,
    heartbeatFile,
    statusFile,
    lockFile,
    ready,
    done,
    start,
    poll,
    pulse,
    getStatus: statusSnapshot,
    stop,
  });
}
