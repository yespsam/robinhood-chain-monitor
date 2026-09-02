import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runHealthCheck } from "../deploy/health-check.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "fixtures", "health");
const BASE_NOW = Date.parse("2026-09-02T12:00:00.000Z");

async function fixture(name) {
  return JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, name), "utf8"));
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, overlay) {
  if (!plainObject(base) || !plainObject(overlay)) return structuredClone(overlay);
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = plainObject(value) && plainObject(merged[key])
      ? deepMerge(merged[key], value)
      : structuredClone(value);
  }
  return merged;
}

function hydrate(value, nowMs) {
  if (Array.isArray(value)) return value.map((item) => hydrate(item, nowMs));
  if (plainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrate(item, nowMs)]));
  }
  if (value === "__NOW__") return new Date(nowMs - 5_000).toISOString();
  if (value === "__OLD__") return new Date(nowMs - 10 * 60_000).toISOString();
  if (value === "__NEXT__") return new Date(nowMs + 5 * 60_000).toISOString();
  return value;
}

function bscWalFrame(revision, operations) {
  const framedOperations = operations.some((operation) => (
    operation.path?.length === 1 && operation.path[0] === "journalRevision"
  )) ? operations : [...operations, { op: "set", path: ["journalRevision"], value: revision }];
  const core = { version: 1, revision, ops: framedOperations };
  const payload = JSON.stringify(core);
  return `${JSON.stringify({
    ...core,
    payloadLength: Buffer.byteLength(payload),
    sha256: createHash("sha256").update(payload).digest("hex"),
  })}\n`;
}

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-health-"));
  const dataDir = path.join(root, "data");
  const configDir = path.join(root, "config");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "node-id"), "node-a\n");
  await fs.writeFile(path.join(configDir, "ACTIVE"), "node-a\n");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, dataDir, configDir };
}

async function writeJson(dataDir, relativeFilename, value, nowMs) {
  const filename = path.join(dataDir, relativeFilename);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const timestamp = new Date(nowMs - 5_000);
  await fs.utimes(filename, timestamp, timestamp);
}

async function installStack(dataDir, nowMs, overrideName = null) {
  const base = await fixture("healthy-stack.json");
  const overrides = overrideName ? await fixture(overrideName) : {};
  const filenames = new Set([...Object.keys(base), ...Object.keys(overrides)]);
  for (const filename of filenames) {
    const value = Object.hasOwn(overrides, filename)
      ? deepMerge(base[filename] || {}, overrides[filename])
      : base[filename];
    await writeJson(dataDir, filename, hydrate(value, nowMs), nowMs);
  }
}

function healthEnv({ dataDir, configDir, heartbeat = false, requireComplete = false } = {}) {
  return {
    DATA_DIR: dataDir,
    HEALTH_CONFIG_DIR: configDir,
    HEALTH_REQUIRE_EXTERNAL_HEARTBEAT: heartbeat ? "true" : "false",
    HEALTH_HEARTBEAT_URL: heartbeat ? "https://heartbeat.example.test/ping/super-secret-token" : "",
    HEALTH_HEARTBEAT_REQUIRE_COVERAGE_COMPLETE: requireComplete ? "true" : "false",
  };
}

const activeService = async () => "active";

test("semantic health reports a fully advancing stack as healthy", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });

  assert.equal(report.version, 3);
  assert.equal(report.healthy, true);
  assert.equal(report.operationalHealthy, true);
  assert.equal(report.coverageComplete, true);
  assert.equal(report.deliveryComplete, true);
  assert.equal(report.status, "healthy");
  assert.equal(report.lanes.binance.operationalHealthy, true);
  assert.equal(report.lanes.binance.coverageComplete, true);
  assert.equal(report.lanes.binance.semantic.websocket.hardRealtime, true);
  assert.equal(report.lanes.bsc.semantic.realtime.status, "healthy");
  assert.equal(report.lanes.bsc.semantic.historical.status, "healthy");
  assert.equal(report.lanes.fomoCheckpoint.progress.value, 201);
});

test("fresh realtime progress stays operational while critical historical and source-limited coverage is honest", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW, "source-limited-overrides.json");
  let heartbeatCalls = 0;
  let requestedUrl = null;

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, heartbeat: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
    fetchImpl: async (url) => {
      heartbeatCalls += 1;
      requestedUrl = url.href;
      return { ok: true, status: 204 };
    },
  });

  assert.equal(report.operationalHealthy, true);
  assert.equal(report.coverageComplete, false);
  assert.equal(report.healthy, false);
  assert.equal(report.status, "degraded");
  assert.equal(report.lanes.binance.operationalHealthy, true);
  assert.equal(report.lanes.binance.coverageComplete, false);
  assert.equal(report.lanes.binance.reason, "websocket_credentials_missing");
  assert.equal(report.lanes.binance.semantic.polling.status, "healthy");
  assert.equal(report.lanes.binance.semantic.websocket.configured, false);
  assert.equal(report.lanes.bsc.operationalHealthy, true);
  assert.equal(report.lanes.bsc.coverageComplete, false);
  assert.equal(report.lanes.bsc.semantic.realtime.status, "healthy");
  assert.equal(report.lanes.bsc.semantic.historical.status, "critical");
  assert.equal(report.lanes.bsc.authoritative.ageSeconds <= 5, true);
  assert.equal(report.lanes.github.operationalHealthy, true);
  assert.equal(report.lanes.github.semantic.sourceLimitations.access_limited, 1);
  assert.equal(report.lanes.platformCapability.operationalHealthy, true);
  assert.equal(report.lanes.fomoX.operationalHealthy, true);
  assert.equal(report.lanes.fomoX.semantic.sourceCoverage, "source_limited");
  assert.equal(report.lanes.fomoThesis.operationalHealthy, true);
  assert.equal(report.lanes.fomoThesis.semantic.blocked, true);
  assert.equal(heartbeatCalls, 1);
  assert.equal(requestedUrl, "https://heartbeat.example.test/ping/super-secret-token");
  assert.equal(report.heartbeat.delivered, true);
  assert.equal(JSON.stringify(report).includes("super-secret-token"), false, "heartbeat URL must not enter reports");
  assert.equal(report.failures.length, 0, "upstream coverage loss must not become a restart signal");
});

test("complete-coverage heartbeat policy skips a degraded stack without leaking or calling the URL", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW, "source-limited-overrides.json");

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, heartbeat: true, requireComplete: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
    fetchImpl: async () => {
      assert.fail("heartbeat must not run when the selected policy is not satisfied");
    },
  });

  assert.equal(report.operationalHealthy, true);
  assert.equal(report.coverageComplete, false);
  assert.equal(report.heartbeat.attempted, false);
  assert.equal(report.heartbeat.error, "skipped_policy_not_satisfied");
  assert.equal(report.heartbeat.policy, "complete_coverage");
});

test("fresh files and semantic timestamps cannot hide frozen chain cursors", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const first = await runHealthCheck({
    env: healthEnv({ dataDir, configDir }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  const later = BASE_NOW + 4 * 60_000;
  await installStack(dataDir, later);
  const previous = structuredClone(first);
  for (const lane of ["robinhood", "bsc", "fomoCheckpoint"]) {
    previous.lanes[lane].progress.lastAdvancedAt = new Date(later - 20 * 60_000).toISOString();
  }
  await writeJson(dataDir, "health.json", previous, later);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir }),
    nowMs: later,
    serviceStateImpl: activeService,
  });

  assert.equal(report.lanes.robinhood.authoritative.ageSeconds <= 5, true);
  assert.equal(report.lanes.bsc.authoritative.ageSeconds <= 5, true);
  assert.equal(report.lanes.bsc.semantic.realtime.checkedAt, new Date(later - 5_000).toISOString());
  assert.equal(report.lanes.robinhood.operationalReasons.includes("lastBlock_frozen"), true);
  assert.equal(report.lanes.bsc.operationalReasons.includes("realtime_cursor_frozen"), true);
  assert.equal(report.lanes.fomoCheckpoint.operationalReasons.includes("fomo_checkpoint_cursor_frozen"), true);
  assert.equal(report.operationalHealthy, false);
  assert.equal(report.status, "critical");
  assert.equal(report.heartbeat.attempted, false);
  assert.equal(report.heartbeat.error, "skipped_operational_unhealthy");
});

test("a freshly rewritten Binance file cannot hide a frozen announcement cursor and polling success", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const stack = hydrate(await fixture("healthy-stack.json"), BASE_NOW);
  const binance = stack["binance-state.json"];
  const old = new Date(BASE_NOW - 10 * 60_000).toISOString();
  binance.scheduler.announcementDetailCheckedAt = old;
  binance.announcements.detailCheckedAt = old;
  binance._health.announcements.checkedAt = old;
  binance._health.announcements.lastSuccessAt = old;
  await writeJson(dataDir, "binance-state.json", binance, BASE_NOW);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });

  assert.equal(report.lanes.binance.authoritative.ageSeconds <= 5, true);
  assert.equal(report.lanes.binance.operationalHealthy, false);
  assert.equal(report.lanes.binance.coverageComplete, true, "stream coverage is separate from local progress");
  assert.match(report.lanes.binance.operationalReasons.join("\n"), /last_success_stale/);
  assert.match(report.lanes.binance.operationalReasons.join("\n"), /cursor_stale/);
  assert.equal(report.operationalHealthy, false);
});

test("fresh upstream backoff attempts keep frozen Binance and BSC cursors operational without claiming coverage", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const first = await runHealthCheck({
    env: healthEnv({ dataDir, configDir }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  const later = BASE_NOW + 10 * 60_000;
  await installStack(dataDir, later, "upstream-backoff-overrides.json");
  const previous = {
    version: 3,
    lanes: {
      binance: structuredClone(first.lanes.binance),
      bsc: structuredClone(first.lanes.bsc),
    },
  };
  previous.lanes.binance.progress.lastAdvancedAt = new Date(later - 10 * 60_000).toISOString();
  previous.lanes.bsc.progress.lastAdvancedAt = new Date(later - 10 * 60_000).toISOString();
  await writeJson(dataDir, "health.json", previous, later);
  let heartbeatCalls = 0;

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, heartbeat: true }),
    nowMs: later,
    serviceStateImpl: activeService,
    fetchImpl: async () => {
      heartbeatCalls += 1;
      return { ok: true, status: 204 };
    },
  });

  assert.equal(report.lanes.binance.progress.frozen, true);
  assert.equal(report.lanes.binance.operationalHealthy, true);
  assert.equal(report.lanes.binance.coverageComplete, false);
  assert.equal(report.lanes.binance.semantic.upstreamBackoff.active, true);
  assert.equal(report.lanes.binance.semantic.upstreamBackoff.kind, "rate_limited");
  assert.equal(report.lanes.binance.operationalReasons.some((reason) => /stale|frozen/.test(reason)), false);
  assert.equal(report.lanes.binance.coverageReasons.includes("binance_announcement_last_success_stale"), true);
  assert.equal(report.lanes.binance.coverageReasons.includes("binance_announcement_cursor_stale"), true);

  assert.equal(report.lanes.bsc.progress.frozen, true);
  assert.equal(report.lanes.bsc.operationalHealthy, true);
  assert.equal(report.lanes.bsc.coverageComplete, false);
  assert.equal(report.lanes.bsc.semantic.realtime.upstreamBackoff.active, true);
  assert.equal(report.lanes.bsc.semantic.realtime.upstreamBackoff.kind, "source_limited");
  assert.equal(report.lanes.bsc.operationalReasons.some((reason) => /stale|frozen/.test(reason)), false);
  assert.equal(report.lanes.bsc.coverageReasons.includes("realtime_cursor_frozen_during_backoff"), true);

  assert.equal(report.operationalHealthy, true);
  assert.equal(report.coverageComplete, false);
  assert.equal(report.status, "degraded");
  assert.equal(heartbeatCalls, 1, "the default operational heartbeat must not restart-storm on upstream backoff");
  assert.equal(report.heartbeat.delivered, true);
  assert.equal(report.failures.length, 0);
});

test("a stale source-limited label without a current attempt or retry does not excuse a frozen BSC cursor", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const first = await runHealthCheck({
    env: healthEnv({ dataDir, configDir }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  const later = BASE_NOW + 10 * 60_000;
  await installStack(dataDir, later);
  const stack = hydrate(await fixture("healthy-stack.json"), later);
  const bsc = stack["bsc-launchpad-state.json"];
  const old = new Date(later - 10 * 60_000).toISOString();
  bsc._health.realtimeTail.status = "source_limited";
  bsc._health.realtimeTail.checkedAt = old;
  bsc._health.realtimeTail.lastAttemptAt = old;
  bsc._health.realtimeTail.lastSuccessAt = old;
  bsc._health.realtimeTail.nextRetryAt = new Date(later - 5 * 60_000).toISOString();
  await writeJson(dataDir, "bsc-launchpad-state.json", bsc, later);
  const previous = { version: 3, lanes: { bsc: structuredClone(first.lanes.bsc) } };
  previous.lanes.bsc.progress.lastAdvancedAt = old;
  await writeJson(dataDir, "health.json", previous, later);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir }),
    nowMs: later,
    serviceStateImpl: activeService,
  });

  assert.equal(report.lanes.bsc.semantic.realtime.upstreamBackoff.active, false);
  assert.equal(report.lanes.bsc.operationalHealthy, false);
  assert.equal(report.lanes.bsc.operationalReasons.includes("realtime_cursor_frozen"), true);
  assert.equal(report.operationalHealthy, false);
});

test("old failed or pending destinations remain nonterminal and fail once stuck", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const stuck = hydrate(await fixture("stuck-outbox.json"), BASE_NOW);
  await writeJson(dataDir, "alert-outbox.json", stuck, BASE_NOW);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });

  assert.equal(report.outboxes.main.nonterminalCount, 1);
  assert.equal(report.outboxes.main.failedDestinationCount, 1);
  assert.equal(report.outboxes.main.oldestPendingAgeSeconds, 600);
  assert.equal(report.outboxes.main.operationalHealthy, false);
  assert.equal(report.deliveryComplete, false);
  assert.equal(report.operationalHealthy, false);
  assert.match(report.failures.join("\n"), /nonterminal_delivery_stuck/);
});

test("a complete corrupt BSC WAL frame is an operational failure", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const wal = path.join(dataDir, "bsc-launchpad-state.json.wal");
  await fs.writeFile(wal, "{\"invalid\":true}\n", { mode: 0o600 });
  const timestamp = new Date(BASE_NOW - 5_000);
  await fs.utimes(wal, timestamp, timestamp);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });

  assert.equal(report.lanes.bsc.operationalHealthy, false);
  assert.match(report.lanes.bsc.operationalReasons.join("\n"), /wal_corrupt/);
});

test("a future BSC state version is rejected exactly as it is by the production restart reader", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const stateFile = path.join(dataDir, "bsc-launchpad-state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  state.version = 7;
  await fs.writeFile(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const timestamp = new Date(BASE_NOW - 5_000);
  await fs.utimes(stateFile, timestamp, timestamp);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });

  assert.equal(report.lanes.bsc.operationalHealthy, false);
  assert.match(report.lanes.bsc.operationalReasons.join("\n"), /state_version_unsupported/);
});

test("a checksummed BSC WAL set cannot create a missing parent during health replay", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const wal = path.join(dataDir, "bsc-launchpad-state.json.wal");
  await fs.writeFile(wal, bscWalFrame(1, [{
    op: "set",
    path: ["missingParent", "nested"],
    value: "must-not-be-created",
  }]), { mode: 0o600 });
  const timestamp = new Date(BASE_NOW - 5_000);
  await fs.utimes(wal, timestamp, timestamp);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });

  assert.equal(report.lanes.bsc.operationalHealthy, false);
  assert.match(report.lanes.bsc.operationalReasons.join("\n"), /wal_corrupt/);
});

test("a checksummed BSC WAL delete must reject a missing target during health replay", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const wal = path.join(dataDir, "bsc-launchpad-state.json.wal");
  await fs.writeFile(wal, bscWalFrame(1, [{
    op: "delete",
    path: ["_health", "missingTarget"],
  }]), { mode: 0o600 });
  const timestamp = new Date(BASE_NOW - 5_000);
  await fs.utimes(wal, timestamp, timestamp);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });

  assert.equal(report.lanes.bsc.operationalHealthy, false);
  assert.match(report.lanes.bsc.operationalReasons.join("\n"), /wal_corrupt/);
});
