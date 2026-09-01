import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createFomoHealthMonitor,
  evaluateFomoHealthRecords,
} from "../src/fomo-health-monitor.js";
import {
  isFomoMonitorHealthUpdateAllowed,
  isMonitoringSourceEnabled,
} from "../src/source-controls.js";
import {
  buildBilingualAlertBundle,
  renderBilingualTelegramText,
} from "../src/bilingual-alert-renderer.js";
import { drainAlertOutbox, focusNoveltyKeys, sendAlerts } from "../src/alerts.js";

const BASE_MS = Date.parse("2026-08-31T00:00:00.000Z");
const asIso = (value) => new Date(value).toISOString();

async function temporaryDataDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-health-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value)}\n`);
}

function healthyCallState(nowMs, overrides = {}) {
  const telemetry = {
    feedStatus: "healthy",
    feedCheckedAt: asIso(nowMs),
    statsStatus: "healthy",
    qualificationCoverage: { status: "healthy", fresh: 1, lastKnownGood: 0 },
    admittedWallets: ["qualified-wallet"],
    exactTradeStatus: "healthy",
    ...(overrides.smartMoney || {}),
  };
  const admitted = overrides.admitted ?? telemetry.admittedWallets.length;
  return {
    health: { status: "healthy", checkedAt: asIso(nowMs), lastSuccessAt: asIso(nowMs) },
    publicOnchain: {
      smartMoney: telemetry,
      coverage: {
        bsc: overrides.bsc || "healthy",
        smartMoney: {
          feed: telemetry.feedStatus,
          stats: telemetry.statsStatus,
          qualification: telemetry.qualificationCoverage.status,
          fresh: telemetry.qualificationCoverage.fresh,
          lastKnownGood: telemetry.qualificationCoverage.lastKnownGood,
          exactTrades: telemetry.exactTradeStatus,
          admitted,
        },
      },
    },
    coverageSummary: {
      monitoredTopCount: admitted,
      profileFreshness: {
        status: telemetry.qualificationCoverage.status,
        fresh: telemetry.qualificationCoverage.fresh,
        stale: telemetry.qualificationCoverage.lastKnownGood,
      },
      chainCoverage: { bsc: overrides.bsc || "healthy" },
    },
  };
}

function xState(nowMs, { eligible = 23, live = eligible, status = live === eligible ? "healthy" : "degraded" } = {}) {
  return {
    health: {
      status,
      checkedAt: asIso(nowMs),
      lastSuccessAt: status === "healthy" ? asIso(nowMs) : null,
      eligibleCount: eligible,
      liveCount: live,
      activeCount: live,
      coverage: { eligibleCount: eligible, liveCount: live },
    },
  };
}

function thesisState(nowMs, status = "healthy") {
  return { health: { status, checkedAt: asIso(nowMs) } };
}

function config(dataDir, overrides = {}) {
  return {
    dataDir,
    fomoCallEnabled: true,
    fomoCallStandalone: true,
    fomoHealthMonitorEnabled: true,
    fomoSmartMoneyMonitorEnabled: true,
    fomoBuyMonitorEnabled: false,
    fomoXCallEnabled: false,
    fomoPublishedCallEnabled: false,
    fomoHealthStateStaleMs: 600_000,
    fomoHealthOpenConsecutive: 3,
    fomoHealthOpenAgeMs: 60_000,
    fomoHealthRecoveryConsecutive: 2,
    fomoHealthRecoveryAgeMs: 60_000,
    fomoHealthZeroTargetCycles: 2,
    fomoHealthZeroTargetAgeMs: 300_000,
    fomoHealthOutboxFailedAgeMs: 120_000,
    fomoHealthOutboxPendingAgeMs: 300_000,
    fomoHealthDeliveryRetryMs: 1_000,
    ...overrides,
  };
}

async function writeHealthyCall(dataDir, nowMs, overrides) {
  await writeJson(path.join(dataDir, "fomo-call-state.json"), healthyCallState(nowMs, overrides));
}

test("initial healthy observation is silent and watchdog state is owner-only", async (t) => {
  const dataDir = await temporaryDataDir(t);
  let nowMs = BASE_MS;
  await writeHealthyCall(dataDir, nowMs);
  const delivered = [];
  const monitor = createFomoHealthMonitor(config(dataDir), {
    autoStart: false,
    now: () => nowMs,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      return { status: "queued" };
    },
  });

  const result = await monitor.check();
  assert.equal(result.status, "healthy");
  assert.deepEqual(delivered, []);
  const persisted = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  assert.equal(persisted.owner, "main_process_fomo_health_watchdog");
  assert.equal(persisted.activeIncident, null);
  assert.equal((await fs.stat(monitor.stateFile)).mode & 0o777, 0o600);
  await monitor.stop();
});

test("the watched outbox path follows standalone versus embedded Fomo delivery mode", async (t) => {
  const dataDir = await temporaryDataDir(t);
  const standalone = createFomoHealthMonitor(config(dataDir), { autoStart: false });
  const embedded = createFomoHealthMonitor(config(dataDir, { fomoCallStandalone: false }), { autoStart: false });
  assert.equal(standalone.files.outbox, path.join(dataDir, "fomo-alerts", "alert-outbox.json"));
  assert.equal(embedded.files.outbox, path.join(dataDir, "alert-outbox.json"));
  await Promise.all([standalone.stop(), embedded.stop()]);
});

test("sustained Thesis block opens once, survives restart, then recovers only after stable dwell", async (t) => {
  const dataDir = await temporaryDataDir(t);
  let nowMs = BASE_MS;
  await writeJson(path.join(dataDir, "fomo-thesis-state.json"), thesisState(nowMs, "blocked_missing_credentials"));
  const delivered = [];
  const testConfig = config(dataDir, {
    fomoSmartMoneyMonitorEnabled: false,
    fomoPublishedCallEnabled: true,
  });
  const dependencies = {
    autoStart: false,
    now: () => nowMs,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      return { status: "queued" };
    },
  };
  const first = createFomoHealthMonitor(testConfig, dependencies);
  await first.check();
  nowMs += 30_000;
  await writeJson(path.join(dataDir, "fomo-thesis-state.json"), thesisState(nowMs, "blocked_missing_credentials"));
  await first.check();
  assert.equal(delivered.length, 0);
  nowMs += 30_000;
  await writeJson(path.join(dataDir, "fomo-thesis-state.json"), thesisState(nowMs, "blocked_missing_credentials"));
  await first.check();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].transition, "opened");
  assert.deepEqual(delivered[0].reasonCodes, ["thesis_blocked"]);
  assert.equal(isFomoMonitorHealthUpdateAllowed(testConfig, delivered[0], nowMs), true);
  await first.stop();

  const restarted = createFomoHealthMonitor(testConfig, dependencies);
  nowMs += 30_000;
  await writeJson(path.join(dataDir, "fomo-thesis-state.json"), thesisState(nowMs, "blocked_missing_credentials"));
  await restarted.check();
  assert.equal(delivered.length, 1, "restart must not repeat the opened transition");

  nowMs += 30_000;
  await writeJson(path.join(dataDir, "fomo-thesis-state.json"), thesisState(nowMs, "healthy"));
  await restarted.check();
  nowMs += 30_000;
  await writeJson(path.join(dataDir, "fomo-thesis-state.json"), thesisState(nowMs, "healthy"));
  await restarted.check();
  assert.equal(delivered.length, 1, "two quick samples do not satisfy the 60-second recovery dwell");
  nowMs += 30_000;
  await writeJson(path.join(dataDir, "fomo-thesis-state.json"), thesisState(nowMs, "healthy"));
  await restarted.check();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].transition, "recovered");
  assert.equal(delivered[1].eventKey, delivered[0].eventKey.replace(/:opened$/, ":recovered"));
  assert.equal(isMonitoringSourceEnabled(testConfig, delivered[1]), true);
  await restarted.stop();
});

test("zero Smart Money targets require two source cycles, five minutes, and incident warmup", async (t) => {
  const dataDir = await temporaryDataDir(t);
  let nowMs = BASE_MS;
  const delivered = [];
  const testConfig = config(dataDir);
  const writeZero = () => writeHealthyCall(dataDir, nowMs, {
    admitted: 0,
    bsc: "not_configured",
    smartMoney: {
      admittedWallets: [],
      statsStatus: "degraded",
      statsError: "no fresh or last-known-good qualified wallets",
      qualificationCoverage: { status: "empty", fresh: 0, lastKnownGood: 0 },
    },
  });
  await writeZero();
  const monitor = createFomoHealthMonitor(testConfig, {
    autoStart: false,
    now: () => nowMs,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      return { status: "queued" };
    },
  });
  await monitor.check();
  nowMs += 60_000;
  await writeZero();
  await monitor.check();
  nowMs = BASE_MS + 299_000;
  await monitor.check();
  assert.equal(delivered.length, 0);
  nowMs = BASE_MS + 300_000;
  await writeZero();
  await monitor.check();
  nowMs += 30_000;
  await monitor.check();
  nowMs += 30_000;
  await monitor.check();
  assert.equal(delivered.length, 1);
  assert.ok(delivered[0].reasonCodes.includes("smart_zero_targets"));
  assert.equal(delivered[0].summary.smartMoney.admitted, 0);
  await monitor.stop();
});

test("stats transport failure remains severe at zero targets, while a partial batch with a fresh profile does not", () => {
  const baseConfig = config("/unused");
  const zeroTransportFailure = healthyCallState(BASE_MS, {
    admitted: 0,
    bsc: "not_configured",
    smartMoney: {
      admittedWallets: [],
      statsStatus: "degraded",
      statsError: "portfolio stats transport timeout",
      qualificationCoverage: { status: "empty", fresh: 0, lastKnownGood: 0 },
    },
  });
  const failed = evaluateFomoHealthRecords(baseConfig, {
    call: { status: "ok", value: zeroTransportFailure },
  }, BASE_MS);
  assert.ok(failed.severeReasons.includes("smart_stats_unhealthy"));
  assert.ok(!failed.severeReasons.includes("smart_zero_targets"), "zero-target guard is applied by the durable state machine");

  const partialWithFreshProfile = healthyCallState(BASE_MS, {
    smartMoney: {
      statsStatus: "partial",
      statsError: "one candidate timed out",
      qualificationCoverage: { status: "healthy", fresh: 1, lastKnownGood: 0 },
    },
  });
  const covered = evaluateFomoHealthRecords(baseConfig, {
    call: { status: "ok", value: partialWithFreshProfile },
  }, BASE_MS);
  assert.equal(covered.summary.smartMoney.status, "degraded");
  assert.deepEqual(covered.severeReasons, []);
});

test("an existing Thesis incident emits one durable updated transition when X coverage later becomes critical", async (t) => {
  const dataDir = await temporaryDataDir(t);
  let nowMs = BASE_MS;
  const delivered = [];
  const testConfig = config(dataDir, {
    fomoSmartMoneyMonitorEnabled: false,
    fomoPublishedCallEnabled: true,
    fomoXCallEnabled: true,
  });
  const writeSources = async (live) => {
    await Promise.all([
      writeJson(path.join(dataDir, "fomo-thesis-state.json"), thesisState(nowMs, "blocked_missing_credentials")),
      writeJson(path.join(dataDir, "fomo-x-call-state.json"), xState(nowMs, { eligible: 23, live, status: live === 23 ? "healthy" : "degraded" })),
    ]);
  };
  await writeSources(23);
  const monitor = createFomoHealthMonitor(testConfig, {
    autoStart: false,
    now: () => nowMs,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      return { status: "queued" };
    },
  });
  for (let index = 0; index < 3; index += 1) {
    nowMs = BASE_MS + index * 30_000;
    await writeSources(23);
    await monitor.check();
  }
  assert.deepEqual(delivered.map((event) => event.transition), ["opened"]);

  for (let index = 1; index <= 3; index += 1) {
    nowMs = BASE_MS + 60_000 + index * 30_000;
    await writeSources(1);
    await monitor.check();
  }
  assert.deepEqual(delivered.map((event) => event.transition), ["opened", "updated"]);
  const update = delivered[1];
  assert.ok(update.reasonCodes.includes("thesis_blocked"));
  assert.ok(update.reasonCodes.includes("x_low_live_coverage"));
  assert.match(update.reasonDigest, /^[a-f0-9]{16}$/);
  assert.equal(update.eventKey, `fomo-health:${update.incidentId}:updated:${update.reasonDigest}`);
  assert.equal(isFomoMonitorHealthUpdateAllowed(testConfig, update, nowMs), true);
  nowMs += 30_000;
  await writeSources(1);
  await monitor.check();
  assert.equal(delivered.length, 2, "the same expansion must not repeat");
  await monitor.stop();

  const restarted = createFomoHealthMonitor(testConfig, {
    autoStart: false,
    now: () => nowMs,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      return { status: "queued" };
    },
  });
  nowMs += 30_000;
  await writeSources(1);
  await restarted.check();
  assert.equal(delivered.length, 2, "restart must preserve the announced expansion dedup");
  await restarted.stop();
});

test("one X handle wobble stays silent but loss of half the effective live roster opens", async (t) => {
  const dataDir = await temporaryDataDir(t);
  let nowMs = BASE_MS;
  const delivered = [];
  const testConfig = config(dataDir, {
    fomoSmartMoneyMonitorEnabled: false,
    fomoXCallEnabled: true,
  });
  await writeJson(path.join(dataDir, "fomo-x-call-state.json"), xState(nowMs, { eligible: 23, live: 22, status: "degraded" }));
  const monitor = createFomoHealthMonitor(testConfig, {
    autoStart: false,
    now: () => nowMs,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      return { status: "queued" };
    },
  });
  for (let index = 0; index < 5; index += 1) {
    nowMs = BASE_MS + index * 30_000;
    await writeJson(path.join(dataDir, "fomo-x-call-state.json"), xState(nowMs, { eligible: 23, live: 22, status: "degraded" }));
    const result = await monitor.check();
    assert.deepEqual(result.severeReasons, []);
  }
  assert.equal(delivered.length, 0);

  for (let index = 0; index < 3; index += 1) {
    nowMs += 30_000;
    await writeJson(path.join(dataDir, "fomo-x-call-state.json"), xState(nowMs, { eligible: 23, live: 1, status: "degraded" }));
    await monitor.check();
  }
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].reasonCodes, ["x_low_live_coverage"]);
  assert.deepEqual(delivered[0].summary.x, { status: "critical", live: 1, eligible: 23 });
  await monitor.stop();
});

test("stale worker heartbeat and aged Fomo outbox failures are severe aggregate evidence", () => {
  const nowMs = BASE_MS;
  const testConfig = config("/unused", {
    fomoSmartMoneyMonitorEnabled: true,
    fomoXCallEnabled: false,
    fomoPublishedCallEnabled: false,
    fomoHealthStateStaleMs: 180_000,
  });
  const staleCall = healthyCallState(nowMs - 181_000);
  const snapshot = evaluateFomoHealthRecords(testConfig, {
    call: { status: "ok", value: staleCall },
    x: { status: "missing", value: null },
    thesis: { status: "missing", value: null },
    outbox: {
      status: "ok",
      value: {
        events: {
          queued: {
            status: "pending",
            createdAt: asIso(nowMs - 180_000),
            destinations: { telegram: { status: "failed" } },
          },
        },
      },
    },
  }, nowMs);
  assert.equal(snapshot.status, "critical");
  assert.ok(snapshot.severeReasons.includes("call_state_stale"));
  assert.ok(snapshot.severeReasons.includes("fomo_outbox_failed"));
  assert.equal(snapshot.summary.outbox.failed, 1);
});

test("a recent failed delivery is not aged by an older pending Fomo outbox entry", () => {
  const nowMs = BASE_MS;
  const testConfig = config("/unused", {
    fomoSmartMoneyMonitorEnabled: false,
    fomoHealthOutboxFailedAgeMs: 120_000,
    fomoHealthOutboxPendingAgeMs: 1_200_000,
  });
  const outbox = {
    events: {
      oldPending: {
        status: "pending",
        createdAt: asIso(nowMs - 600_000),
        destinations: { telegram: { status: "pending" } },
      },
      recentFailure: {
        status: "pending",
        createdAt: asIso(nowMs - 600_000),
        updatedAt: asIso(nowMs - 30_000),
        destinations: {
          telegram: { status: "failed", lastAttemptAt: asIso(nowMs - 30_000) },
        },
      },
    },
  };
  const recent = evaluateFomoHealthRecords(testConfig, {
    outbox: { status: "ok", value: outbox },
  }, nowMs);
  assert.equal(recent.summary.outbox.status, "degraded");
  assert.equal(recent.summary.outbox.failed, 1);
  assert.ok(!recent.severeReasons.includes("fomo_outbox_failed"));
  assert.ok(!recent.severeReasons.includes("fomo_outbox_backlog"));

  outbox.events.recentFailure.destinations.telegram.lastAttemptAt = asIso(nowMs - 121_000);
  const aged = evaluateFomoHealthRecords(testConfig, {
    outbox: { status: "ok", value: outbox },
  }, nowMs);
  assert.equal(aged.summary.outbox.status, "critical");
  assert.ok(aged.severeReasons.includes("fomo_outbox_failed"));
});

test("embedded mode ignores non-Fomo main-outbox failures and detects Fomo producer or health failures", () => {
  const nowMs = BASE_MS;
  const testConfig = config("/unused", {
    fomoCallStandalone: false,
    fomoSmartMoneyMonitorEnabled: false,
  });
  const failedEntry = (type) => ({
    event: { type },
    status: "pending",
    createdAt: asIso(nowMs - 180_000),
    destinations: {
      telegram: { status: "failed", lastAttemptAt: asIso(nowMs - 180_000) },
    },
  });
  const unrelatedOnly = evaluateFomoHealthRecords(testConfig, {
    outbox: {
      status: "ok",
      value: { events: { github: failedEntry("github_module_update") } },
    },
  }, nowMs);
  assert.equal(unrelatedOnly.summary.outbox.status, "healthy");
  assert.equal(unrelatedOnly.summary.outbox.pending, 0);
  assert.equal(unrelatedOnly.summary.outbox.failed, 0);
  assert.deepEqual(unrelatedOnly.severeReasons, []);

  for (const type of ["fomo_family_top_call", "fomo_monitor_health_update"]) {
    const scoped = evaluateFomoHealthRecords(testConfig, {
      outbox: {
        status: "ok",
        value: {
          events: {
            unrelated: failedEntry("github_module_update"),
            fomo: failedEntry(type),
          },
        },
      },
    }, nowMs);
    assert.equal(scoped.summary.outbox.status, "critical");
    assert.equal(scoped.summary.outbox.pending, 1);
    assert.equal(scoped.summary.outbox.failed, 1);
    assert.deepEqual(scoped.severeReasons, ["fomo_outbox_failed"]);
  }
});

test("a failed durability barrier rolls back the observation and retries from the last durable state", async (t) => {
  const dataDir = await temporaryDataDir(t);
  let nowMs = BASE_MS;
  await writeJson(path.join(dataDir, "fomo-thesis-state.json"), thesisState(nowMs, "blocked_missing_credentials"));
  let failDirectorySync = true;
  const syncKinds = [];
  const resolvedDataDir = path.resolve(dataDir);
  const fsImpl = new Proxy(fs, {
    get(target, property, receiver) {
      if (property === "open") {
        return async (targetPath, flags, mode) => {
          const handle = await fs.open(targetPath, flags, mode);
          const directoryHandle = path.resolve(String(targetPath)) === resolvedDataDir;
          return new Proxy(handle, {
            get(handleTarget, handleProperty, handleReceiver) {
              if (handleProperty === "sync") {
                return async () => {
                  syncKinds.push(directoryHandle ? "directory" : "file");
                  if (directoryHandle && failDirectorySync) {
                    failDirectorySync = false;
                    throw new Error("injected directory fsync failure");
                  }
                  return handleTarget.sync();
                };
              }
              const value = Reflect.get(handleTarget, handleProperty, handleReceiver);
              return typeof value === "function" ? value.bind(handleTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const monitor = createFomoHealthMonitor(config(dataDir, {
    fomoSmartMoneyMonitorEnabled: false,
    fomoPublishedCallEnabled: true,
  }), {
    autoStart: false,
    fsImpl,
    now: () => nowMs,
    sendAlertsImpl: async () => ({ status: "queued" }),
  });

  await assert.rejects(monitor.check(), /injected directory fsync failure/);
  nowMs += 30_000;
  await writeJson(path.join(dataDir, "fomo-thesis-state.json"), thesisState(nowMs, "blocked_missing_credentials"));
  await monitor.check();

  const persisted = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  assert.equal(persisted.candidate.consecutive, 1, "the failed observation must not advance the in-memory dwell");
  assert.equal(persisted.candidate.firstObservedAt, asIso(nowMs));
  assert.ok(syncKinds.filter((kind) => kind === "file").length >= 2);
  assert.ok(syncKinds.filter((kind) => kind === "directory").length >= 2);
  await monitor.stop();
});

test("a legacy mode-0644 state is migrated and retained transitions stay bounded", async (t) => {
  const dataDir = await temporaryDataDir(t);
  const nowMs = BASE_MS;
  const stateFile = path.join(dataDir, "fomo-health-watchdog-state.json");
  const transitions = Object.fromEntries(Array.from({ length: 130 }, (_, index) => {
    const eventKey = `fomo-health:aggregate-${index}:opened`;
    return [eventKey, {
      event: { eventKey },
      status: "submitted",
      attempts: 1,
      queuedAt: asIso(nowMs + index),
    }];
  }));
  await writeJson(stateFile, {
    version: 1,
    owner: "main_process_fomo_health_watchdog",
    initializedAt: asIso(nowMs),
    lastCheckedAt: null,
    lastAggregateStatus: "unknown",
    zeroTarget: { firstObservedAt: null, sourceCycles: 0, lastCallCheckedAt: null },
    candidate: null,
    activeIncident: null,
    recovery: null,
    transitions,
    history: Array.from({ length: 75 }, (_, index) => ({ eventKey: `historic-${index}` })),
  });
  await fs.chmod(stateFile, 0o644);
  await writeHealthyCall(dataDir, nowMs);

  const monitor = createFomoHealthMonitor(config(dataDir), {
    autoStart: false,
    now: () => nowMs,
    sendAlertsImpl: async () => ({ status: "queued" }),
  });
  await monitor.check();

  const persisted = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
  assert.equal(Object.keys(persisted.transitions).length, 100);
  assert.equal(persisted.history.length, 50);
  await monitor.stop();
});

test("health event schema rejects raw fields and renderer stays bilingual, two-field, and compact", async () => {
  const nowMs = BASE_MS;
  const event = {
    type: "fomo_monitor_health_update",
    eventKey: "fomo-health:aggregate-1788134400000:opened",
    lane: "aggregate",
    transition: "opened",
    incidentId: "aggregate-1788134400000",
    aggregateStatus: "critical",
    observedAt: asIso(nowMs),
    openedAt: asIso(nowMs),
    durationMs: 0,
    reasonCodes: ["x_low_live_coverage", "thesis_blocked"],
    summary: {
      smartMoney: { status: "healthy", admitted: 1, fresh: 1, lastKnownGood: 0 },
      bsc: { status: "healthy" },
      x: { status: "critical", live: 1, eligible: 23 },
      thesis: { status: "critical" },
      outbox: { status: "healthy", pending: 0, failed: 0 },
    },
    source: { id: "local_fomo_health_watchdog", trust: "local_persisted_health" },
    sourceTrust: "local_persisted_health",
    strong: false,
  };
  const testConfig = { fomoHealthMonitorEnabled: true, alertForceLocalStructured: true };
  assert.equal(isFomoMonitorHealthUpdateAllowed(testConfig, event, nowMs), true);
  assert.equal(isFomoMonitorHealthUpdateAllowed(testConfig, event, nowMs + 8 * 24 * 60 * 60_000), true);
  assert.equal(
    isFomoMonitorHealthUpdateAllowed(testConfig, event, nowMs + 10 * 366 * 24 * 60 * 60_000 + 1),
    false,
    "operational retry age remains explicitly bounded",
  );
  assert.equal(isFomoMonitorHealthUpdateAllowed(testConfig, { ...event, rawError: "secret or address" }, nowMs), false);
  assert.equal(isFomoMonitorHealthUpdateAllowed(testConfig, {
    ...event,
    source: { ...event.source, url: "https://untrusted.example" },
  }, nowMs), false);

  const bundle = await buildBilingualAlertBundle(testConfig, event, "Fomo health transition");
  const rendered = renderBilingualTelegramText(bundle, false);
  assert.match(rendered, /平台：Fomo 监控 · 聚合健康/u);
  assert.match(rendered, /更新了什么：持续严重降级已确认/u);
  assert.match(rendered, /Platform: Fomo Monitor · Aggregate health/u);
  assert.match(rendered, /What changed: Sustained critical degradation confirmed/u);
  assert.equal(rendered.split("\n").length, 8);
  assert.ok(rendered.length <= 600, `rendered health alert is ${rendered.length} chars`);
  assert.doesNotMatch(rendered, /rawError|secret|0x[a-f0-9]{40}/iu);
});

test("health transition uses the main durable outbox and never enters market semantic dedup", async (t) => {
  const dataDir = await temporaryDataDir(t);
  const nowMs = Date.now();
  const event = {
    type: "fomo_monitor_health_update",
    eventKey: `fomo-health:aggregate-${nowMs}:opened`,
    lane: "aggregate",
    transition: "opened",
    incidentId: `aggregate-${nowMs}`,
    aggregateStatus: "critical",
    observedAt: asIso(nowMs),
    openedAt: asIso(nowMs),
    durationMs: 0,
    reasonCodes: ["call_state_stale"],
    summary: {
      smartMoney: { status: "critical", admitted: 1, fresh: 1, lastKnownGood: 0 },
      bsc: { status: "critical" },
      x: { status: "healthy", live: 23, eligible: 23 },
      thesis: { status: "healthy" },
      outbox: { status: "healthy", pending: 0, failed: 0 },
    },
    source: { id: "local_fomo_health_watchdog", trust: "local_persisted_health" },
    sourceTrust: "local_persisted_health",
    strong: false,
  };
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const alertConfig = {
    dataDir,
    monitorScope: "focus3",
    fomoHealthMonitorEnabled: true,
    telegramToken: "test-token",
    telegramChatId: "test-chat",
    webhookUrl: "",
    alertBilingualEnabled: false,
    alertForceLocalStructured: true,
    alertRetryIntervalMs: 1_000,
  };
  const first = await sendAlerts(alertConfig, event);
  const duplicate = await sendAlerts(alertConfig, structuredClone(event));
  assert.equal(first.status, "delivered");
  assert.equal(duplicate.status, "delivered");
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.text, /平台：Fomo 监控 · 聚合健康/u);
  assert.deepEqual(focusNoveltyKeys(event), []);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.deepEqual(Object.keys(outbox.events), [event.eventKey]);
  assert.equal(outbox.events[event.eventKey].event.canonicalSignalIds, undefined);
  assert.equal(outbox.events[event.eventKey].status, "delivered");
  assert.equal(
    outbox.events[event.eventKey].destinations.telegram.receipt.renderVersion,
    outbox.events[event.eventKey].renderBundle.version,
  );
});

test("a queued health transition survives days of Telegram outage and delivers once with its persisted render", async (t) => {
  const dataDir = await temporaryDataDir(t);
  const initialMs = Date.now() - 8 * 24 * 60 * 60_000;
  let nowMs = initialMs;
  let telegramAvailable = false;
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    if (!telegramAvailable) throw new Error("simulated multi-day Telegram outage");
    return new Response(JSON.stringify({ ok: true, result: { message_id: 808 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  const testConfig = config(dataDir, {
    fomoSmartMoneyMonitorEnabled: false,
    fomoPublishedCallEnabled: true,
    monitorScope: "focus3",
    telegramToken: "test-token",
    telegramChatId: "test-chat",
    webhookUrl: "",
    alertBilingualEnabled: false,
    alertForceLocalStructured: true,
    alertRetryIntervalMs: 1_000,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    alertNow: () => nowMs,
  });
  const writeBlockedThesis = () => writeJson(
    path.join(dataDir, "fomo-thesis-state.json"),
    thesisState(nowMs, "blocked_missing_credentials"),
  );
  await writeBlockedThesis();
  const monitor = createFomoHealthMonitor(testConfig, {
    autoStart: false,
    now: () => nowMs,
    sendAlertsImpl: sendAlerts,
  });

  for (let index = 0; index < 3; index += 1) {
    nowMs = initialMs + index * 30_000;
    await writeBlockedThesis();
    await monitor.check();
  }
  assert.equal(payloads.length, 1);
  const firstOutbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const [eventKey] = Object.keys(firstOutbox.events);
  const firstEntry = firstOutbox.events[eventKey];
  const persistedRender = structuredClone(firstEntry.renderBundle);
  assert.equal(firstEntry.status, "pending");
  assert.equal(firstEntry.destinations.telegram.status, "failed");
  assert.equal(isFomoMonitorHealthUpdateAllowed(testConfig, firstEntry.event, Date.now()), true);

  nowMs = Date.now();
  await writeBlockedThesis();
  await monitor.check();
  const watchdogBeforeDelivery = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  assert.deepEqual(Object.keys(watchdogBeforeDelivery.transitions), [eventKey]);
  assert.equal(watchdogBeforeDelivery.transitions[eventKey].status, "submitted");
  assert.equal(payloads.length, 1, "the same active incident must not enqueue a second transition");

  telegramAvailable = true;
  assert.equal(await drainAlertOutbox(testConfig), 1);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].text, payloads[0].text, "retry must reuse the exact persisted render text");
  const finalOutbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.deepEqual(Object.keys(finalOutbox.events), [eventKey]);
  assert.equal(finalOutbox.events[eventKey].status, "delivered");
  assert.equal(finalOutbox.events[eventKey].destinations.telegram.status, "delivered");
  assert.equal(finalOutbox.events[eventKey].destinations.telegram.receipt.messageId, 808);
  assert.deepEqual(finalOutbox.events[eventKey].renderBundle, persistedRender);
  assert.equal(finalOutbox.events[eventKey].destinations.telegram.disabledReason, undefined);
  await monitor.stop();
});

test("stop drains an in-flight transition submission", async (t) => {
  const dataDir = await temporaryDataDir(t);
  let nowMs = BASE_MS;
  await writeJson(path.join(dataDir, "fomo-thesis-state.json"), thesisState(nowMs, "blocked_missing_credentials"));
  let releaseDelivery;
  let deliveryStarted;
  const started = new Promise((resolve) => { deliveryStarted = resolve; });
  const delivery = new Promise((resolve) => { releaseDelivery = resolve; });
  const monitor = createFomoHealthMonitor(config(dataDir, {
    fomoSmartMoneyMonitorEnabled: false,
    fomoPublishedCallEnabled: true,
  }), {
    autoStart: false,
    now: () => nowMs,
    sendAlertsImpl: async () => {
      deliveryStarted();
      await delivery;
      return { status: "queued" };
    },
  });
  await monitor.check();
  nowMs += 30_000;
  await writeJson(path.join(dataDir, "fomo-thesis-state.json"), thesisState(nowMs, "blocked_missing_credentials"));
  await monitor.check();
  nowMs += 30_000;
  await writeJson(path.join(dataDir, "fomo-thesis-state.json"), thesisState(nowMs, "blocked_missing_credentials"));
  const checking = monitor.check();
  await started;
  let stopped = false;
  const stopping = monitor.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseDelivery();
  await Promise.all([checking, stopping]);
  assert.equal(stopped, true);
  const persisted = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  assert.equal(Object.values(persisted.transitions).filter((item) => item.status === "submitted").length, 1);
  assert.equal((await fs.stat(monitor.stateFile)).mode & 0o777, 0o600);
});
