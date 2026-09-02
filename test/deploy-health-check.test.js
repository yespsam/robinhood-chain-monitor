import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runHealthCheck } from "../deploy/health-check.mjs";
import {
  PON_FACTORY,
  PON_FACTORY_EVENT_TOPICS,
  PON_FACTORY_INTERFACE,
} from "../src/pon-monitor.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "fixtures", "health");
const INSTALLER = path.join(HERE, "..", "deploy", "bin", "install-ubuntu.sh");
const ACTIVATE = path.join(HERE, "..", "deploy", "bin", "activate-node.sh");
const ASSERT_ACTIVE = path.join(HERE, "..", "deploy", "bin", "assert-active.sh");
const READ_ENV_SETTING = path.join(HERE, "..", "deploy", "bin", "read-env-setting.sh");
const BASE_NOW = Date.parse("2026-09-02T12:00:00.000Z");
const execFileAsync = promisify(execFile);

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

function healthEnv({
  dataDir,
  configDir,
  heartbeat = false,
  requireComplete = false,
  requirePon = false,
} = {}) {
  return {
    DATA_DIR: dataDir,
    HEALTH_CONFIG_DIR: configDir,
    HEALTH_REQUIRE_PON: requirePon ? "true" : "false",
    HEALTH_REQUIRE_EXTERNAL_HEARTBEAT: heartbeat ? "true" : "false",
    HEALTH_HEARTBEAT_URL: heartbeat ? "https://heartbeat.example.test/ping/super-secret-token" : "",
    HEALTH_HEARTBEAT_REQUIRE_COVERAGE_COMPLETE: requireComplete ? "true" : "false",
  };
}

const activeService = async () => "active";

test("Ubuntu installer emits explicit opt-in Pon health defaults and remains valid Bash", async (t) => {
  const source = await fs.readFile(INSTALLER, "utf8");
  assert.equal((source.match(/printf 'HEALTH_PON_MAX_AGE_SECONDS=180\\n'/g) || []).length, 1);
  assert.equal((source.match(/printf 'HEALTH_REQUIRE_PON=false\\n'/g) || []).length, 1);
  const [activate, assertActive] = await Promise.all([
    fs.readFile(ACTIVATE, "utf8"),
    fs.readFile(ASSERT_ACTIVE, "utf8"),
  ]);
  assert.match(activate, /PON_MONITOR_ENABLED/, "activation must inspect the monitor switch");
  assert.match(activate, /HEALTH_REQUIRE_PON/, "activation must require semantic health coverage");
  assert.match(activate, /requires HEALTH_REQUIRE_PON=true/, "activation must fail with an actionable message");
  assert.match(activate, /read-env-setting\.sh/, "activation must resolve the effective last assignment");
  assert.match(assertActive, /PON_MONITOR_ENABLED/, "service preflight must inspect the systemd-injected switch");
  assert.doesNotMatch(assertActive, /read-env-setting\.sh/, "unprivileged preflight must not read root-only env files");
  assert.match(assertActive, /health\.env must be owned by root/, "service preflight must retain health.env ownership");
  assert.match(assertActive, /health\.env must have mode 0600/, "service preflight must retain health.env secrecy");
  assert.match(source, /read-env-setting\.sh/, "installer must deploy the safe EnvironmentFile reader");
  await Promise.all([INSTALLER, ACTIVATE, ASSERT_ACTIVE, READ_ENV_SETTING]
    .map((script) => execFileAsync("/bin/bash", ["-n", script])));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pon-env-setting-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "settings.env");
  await fs.writeFile(file, [
    "PON_MONITOR_ENABLED=true",
    "PON_MONITOR_ENABLED=false",
    "HEALTH_REQUIRE_PON=false",
    "HEALTH_REQUIRE_PON=\"YES\"",
    "",
  ].join("\n"));
  const disabled = await execFileAsync("/bin/bash", [READ_ENV_SETTING, file, "PON_MONITOR_ENABLED"]);
  const protectedHealth = await execFileAsync("/bin/bash", [READ_ENV_SETTING, file, "HEALTH_REQUIRE_PON"]);
  assert.equal(disabled.stdout.trim(), "false");
  assert.equal(protectedHealth.stdout.trim(), "yes");
  await fs.appendFile(file, "HEALTH_REQUIRE_PON=false\n");
  const lastAssignmentWins = await execFileAsync("/bin/bash", [READ_ENV_SETTING, file, "HEALTH_REQUIRE_PON"]);
  assert.equal(lastAssignmentWins.stdout.trim(), "false");
});

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
  assert.equal(report.lanes.pon.status, "disabled");
  assert.equal(report.lanes.binance.semantic.websocket.hardRealtime, true);
  assert.equal(report.lanes.bsc.semantic.realtime.status, "healthy");
  assert.equal(report.lanes.bsc.semantic.historical.status, "healthy");
  assert.equal(report.lanes.fomoCheckpoint.progress.value, 201);
});

test("Pon lane is optional when disabled and healthy when explicitly required", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  await fs.rm(path.join(dataDir, "pon-state.json"));

  const disabled = await runHealthCheck({
    env: healthEnv({ dataDir, configDir }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(disabled.lanes.pon.required, false);
  assert.equal(disabled.lanes.pon.status, "disabled");
  assert.equal(disabled.operationalHealthy, true);

  const pon = hydrate((await fixture("healthy-stack.json"))["pon-state.json"], BASE_NOW);
  await writeJson(dataDir, "pon-state.json", pon, BASE_NOW);
  const required = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(required.lanes.pon.required, true);
  assert.equal(required.lanes.pon.status, "healthy");
  assert.equal(required.lanes.pon.operationalHealthy, true);
  assert.equal(required.lanes.pon.coverageComplete, true);
  assert.equal(required.lanes.pon.progress.value, 51_900_001);
  assert.equal(required.lanes.pon.semantic.identity.observedChainId, 4663);
  assert.equal(required.lanes.pon.semantic.x.baselined, true);
  assert.equal(required.lanes.pon.semantic.x.timelineStatus, "healthy");
  assert.equal(required.lanes.pon.semantic.x.verificationIdentity, "fxtwitter_exact_numeric_id+official_x_oembed");
  assert.equal(required.lanes.pon.warnings.includes("pon_x_optional_discovery_source_limited"), true);
});

test("Pon health requires its official X baseline but does not call first-start absence a worker crash", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  await fs.rm(path.join(dataDir, "twitter-state.json"));

  const pending = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(pending.lanes.pon.operationalHealthy, true);
  assert.equal(pending.lanes.pon.coverageComplete, false);
  assert.equal(pending.lanes.pon.status, "degraded");
  assert.equal(pending.lanes.pon.coverageReasons.includes("pon_x_baseline_pending"), true);

  await fs.writeFile(path.join(dataDir, "twitter-state.json"), "{not-json\n", { mode: 0o600 });
  const malformed = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(malformed.lanes.pon.operationalHealthy, false);
  assert.equal(malformed.lanes.pon.operationalReasons.includes("pon_x_state_invalid:invalid_json"), true);
});

test("a proven Pon X cursor gap freezes its durable cursor and remains coverage-only during source backoff", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const stateFile = path.join(dataDir, "twitter-state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const lane = state._health.pondotfun;
  const sourceName = lane.activeSource;
  const observedAt = new Date(BASE_NOW - 5_000).toISOString();
  const retryAt = new Date(BASE_NOW + 60_000).toISOString();
  state.pondotfun.checkedAt = new Date(BASE_NOW - 10 * 60_000).toISOString();
  lane.status = "error";
  lane.checkedAt = observedAt;
  lane.lastErrorAt = observedAt;
  lane.lastError = "Pon FxTwitter timeline does not cover the durable cursor";
  lane.retryAfter = retryAt;
  lane.gapSince = observedAt;
  lane.sources[sourceName] = {
    ...lane.sources[sourceName],
    status: "error",
    checkedAt: observedAt,
    lastErrorAt: observedAt,
    lastError: lane.lastError,
    circuitState: "open",
    circuitUntil: retryAt,
    retryAfter: retryAt,
  };
  lane.coverage.cursorGap = {
    status: "incomplete",
    reason: "durable_cursor_not_in_numeric_id_timeline",
    cursorId: state.pondotfun.latestId,
    newestSeenId: "2095100000000000001",
    oldestSeenId: "2095100000000000001",
    detectedAt: observedAt,
    source: sourceName,
  };
  await writeJson(dataDir, "twitter-state.json", state, BASE_NOW);

  const degraded = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(degraded.lanes.pon.operationalHealthy, true);
  assert.equal(degraded.lanes.pon.coverageComplete, false);
  assert.equal(degraded.lanes.pon.semantic.x.latestId, state.pondotfun.latestId);
  assert.equal(degraded.lanes.pon.semantic.x.upstreamBackoff, true);
  assert.equal(
    degraded.lanes.pon.coverageReasons.includes("pon_x_cursor_gap:durable_cursor_not_in_numeric_id_timeline"),
    true,
  );
  assert.equal(degraded.lanes.pon.coverageReasons.includes("pon_x_cursor_frozen_during_upstream_backoff"), true);

  lane.sources[sourceName].circuitState = "closed";
  lane.sources[sourceName].circuitUntil = null;
  lane.sources[sourceName].retryAfter = null;
  await writeJson(dataDir, "twitter-state.json", state, BASE_NOW);
  const abandoned = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(abandoned.lanes.pon.operationalHealthy, false);
  assert.equal(abandoned.lanes.pon.operationalReasons.includes("pon_x_cursor_frozen"), true);
});

test("Pon X exact-status plus oEmbed identity outages degrade coverage only while their circuit is active", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  const verification = state._health.pondotfun.criticalVerification;
  const observedAt = new Date(BASE_NOW - 5_000).toISOString();
  const retryAt = new Date(BASE_NOW + 60_000).toISOString();
  Object.assign(verification, {
    status: "error",
    checkedAt: observedAt,
    lastErrorAt: observedAt,
    lastError: "official X oEmbed HTTP 503",
    circuitState: "open",
    circuitUntil: retryAt,
    retryAfter: retryAt,
  });
  await writeJson(dataDir, "twitter-state.json", state, BASE_NOW);

  const outage = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(outage.lanes.pon.operationalHealthy, true);
  assert.equal(outage.lanes.pon.coverageComplete, false);
  assert.equal(outage.lanes.pon.coverageReasons.includes("pon_x_identity_verification_incomplete"), true);
  assert.equal(outage.lanes.pon.semantic.x.upstreamBackoff, true);

  Object.assign(verification, {
    status: "healthy",
    identity: "handle_only",
    circuitState: "closed",
    circuitUntil: null,
    retryAfter: null,
  });
  await writeJson(dataDir, "twitter-state.json", state, BASE_NOW);
  const forged = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(forged.lanes.pon.operationalHealthy, false);
  assert.equal(forged.lanes.pon.operationalReasons.includes("pon_x_verification_identity_invalid"), true);
});

test("Pon X delayed recovery remains visible until every oldest-first item is durably recovered", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  const lane = state._health.pondotfun;
  const gapSince = new Date(BASE_NOW - 20 * 60_000).toISOString();
  lane.gapSince = gapSince;
  lane.coverage.delayedRecovery = {
    status: "in_progress",
    reason: "stale_durable_coverage_checkpoint",
    gapSince,
    cursorId: state.pondotfun.latestId,
    startedAt: new Date(BASE_NOW - 60_000).toISOString(),
    checkedAt: new Date(BASE_NOW - 5_000).toISOString(),
  };
  await writeJson(dataDir, "twitter-state.json", state, BASE_NOW);

  const recovering = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(recovering.lanes.pon.operationalHealthy, true);
  assert.equal(recovering.lanes.pon.coverageComplete, false);
  assert.equal(recovering.lanes.pon.coverageReasons.includes("pon_x_delayed_recovery_in_progress"), true);
  assert.equal(recovering.lanes.pon.semantic.x.gapSince, gapSince);

  delete lane.gapSince;
  lane.coverage.delayedRecovery = {
    ...lane.coverage.delayedRecovery,
    status: "complete",
    completedAt: new Date(BASE_NOW - 1_000).toISOString(),
  };
  await writeJson(dataDir, "twitter-state.json", state, BASE_NOW);
  const recovered = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(recovered.lanes.pon.operationalHealthy, true);
  assert.equal(recovered.lanes.pon.coverageComplete, true);
  assert.equal(recovered.lanes.pon.semantic.x.delayedRecoveryStatus, "complete");

  lane.gapSince = gapSince;
  lane.coverage.delayedRecovery = {
    status: "incomplete",
    reason: "oldest_unprocessed_tweet_outside_bounded_recovery_window",
    gapSince,
    cursorId: state.pondotfun.latestId,
    blockedTweetId: "2095100000000000001",
    checkedAt: new Date(BASE_NOW - 1_000).toISOString(),
  };
  await writeJson(dataDir, "twitter-state.json", state, BASE_NOW);
  const outsideWindow = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(outsideWindow.lanes.pon.operationalHealthy, true);
  assert.equal(outsideWindow.lanes.pon.coverageComplete, false);
  assert.equal(outsideWindow.lanes.pon.coverageReasons.includes("pon_x_delayed_recovery_incomplete"), true);

  lane.coverage.delayedRecovery.reason = "unrecognized_recovery_reason";
  await writeJson(dataDir, "twitter-state.json", state, BASE_NOW);
  const malformed = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(malformed.lanes.pon.operationalHealthy, false);
  assert.equal(
    malformed.lanes.pon.operationalReasons.includes("pon_x_state_schema_invalid:coverage.delayedRecovery"),
    true,
  );
});

test("Pon state corruption and pinned deployment identity mismatches are operational failures", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const stateFile = path.join(dataDir, "pon-state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  state._health.status = "degraded";
  state._health.lastErrorCode = "PON_RPC_CHAIN_MISMATCH";
  state._health.identity.observedChainId = 1;
  state._health.sources.chain.status = "backoff";
  state._health.sources.chain.lastErrorCode = "PON_RPC_CHAIN_MISMATCH";
  state._health.sources.chain.lastError = "RPC chain 1 != 4663";
  state._health.sources.chain.nextAttemptAt = new Date(BASE_NOW + 5 * 60_000).toISOString();
  await writeJson(dataDir, "pon-state.json", state, BASE_NOW);

  const mismatch = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(mismatch.lanes.pon.operationalHealthy, false);
  assert.equal(mismatch.lanes.pon.status, "critical");
  assert.equal(mismatch.lanes.pon.operationalReasons.includes("pon_observed_identity_mismatch"), true);
  assert.equal(
    mismatch.lanes.pon.operationalReasons.includes("pon_integrity_failure:PON_RPC_CHAIN_MISMATCH"),
    true,
  );

  await fs.writeFile(stateFile, "{not-json\n", { mode: 0o600 });
  const timestamp = new Date(BASE_NOW - 5_000);
  await fs.utimes(stateFile, timestamp, timestamp);
  const corrupt = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(corrupt.lanes.pon.operationalHealthy, false);
  assert.match(corrupt.lanes.pon.operationalReasons.join("\n"), /pon-state\.json_invalid_json/);
});

test("Pon platform-token state must retain its finalized ERC-20 closure", async (t) => {
  for (const scenario of [
    {
      label: "missing verification",
      mutate: (state) => { state.platformTokenVerification = null; },
    },
    {
      label: "wrong pinned token",
      mutate: (state) => { state.platformTokenVerification.token = "0x1111111111111111111111111111111111111111"; },
    },
    {
      label: "supply mismatch",
      mutate: (state) => { state.platformTokenVerification.totalSupplyRaw = "1"; },
    },
    {
      label: "invalid finalized block hash",
      mutate: (state) => { state.platformTokenVerification.verifiedBlockHash = "0xdead"; },
    },
  ]) {
    await t.test(scenario.label, async (subtest) => {
      const { dataDir, configDir } = await makeWorkspace(subtest);
      await installStack(dataDir, BASE_NOW);
      const stateFile = path.join(dataDir, "pon-state.json");
      const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
      scenario.mutate(state);
      await writeJson(dataDir, "pon-state.json", state, BASE_NOW);
      const report = await runHealthCheck({
        env: healthEnv({ dataDir, configDir, requirePon: true }),
        nowMs: BASE_NOW,
        serviceStateImpl: activeService,
      });
      assert.equal(report.lanes.pon.operationalHealthy, false);
      assert.equal(report.lanes.pon.operationalReasons.includes("pon_platform_token_verification_invalid"), true);
    });
  }
});

test("a durable delayed-critical recovery stays operational and remains visible as an audit warning", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const stateFile = path.join(dataDir, "pon-state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const sourceOccurredAt = new Date(BASE_NOW - 20_000).toISOString();
  const recoveredAt = new Date(BASE_NOW - 5_000).toISOString();
  state.missedCriticalChanges = [{
    eventKey: "pon-fun:delayed:1",
    originalEventKey: "pon-fun:factory:1",
    kind: "factory_config",
    priority: "T2",
    blockNumber: 51_900_000,
    blockHash: `0x${"11".repeat(32)}`,
    blockTimestamp: sourceOccurredAt,
    observedAt: recoveredAt,
    changes: { oracle: { before: "old", after: "new" } },
    recordedAt: recoveredAt,
    delayedRecovery: {
      version: 1,
      reason: "monitoring_gap_recovery",
      gapSince: sourceOccurredAt,
      sourceOccurredAt,
      recoveredAt,
      lagMs: 15_000,
      cursor: { nextBlockAtRecovery: 51_899_999, eventBlock: 51_900_000 },
    },
  }];
  state._health.missedCriticalChangeCount = 1;
  state._health.lastMissedCriticalChangeAt = recoveredAt;
  await writeJson(dataDir, "pon-state.json", state, BASE_NOW);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(report.lanes.pon.operationalHealthy, true);
  assert.equal(report.lanes.pon.coverageComplete, true);
  assert.equal(report.lanes.pon.warnings.includes("pon_delayed_critical_recovery_recorded"), true);
  assert.equal(report.lanes.pon.semantic.missedCriticalChanges.total, 1);
  assert.equal(report.lanes.pon.semantic.missedCriticalChanges.retained, 1);
});

test("a malformed delayed-critical audit record fails Pon health closed", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const stateFile = path.join(dataDir, "pon-state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  state.missedCriticalChanges = [{ eventKey: "bad", kind: "factory_config", blockNumber: 51_900_000 }];
  state._health.missedCriticalChangeCount = 1;
  state._health.lastMissedCriticalChangeAt = new Date(BASE_NOW - 5_000).toISOString();
  await writeJson(dataDir, "pon-state.json", state, BASE_NOW);
  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(report.lanes.pon.operationalHealthy, false);
  assert.equal(report.lanes.pon.operationalReasons.includes("pon_state_schema_invalid:missedCriticalChanges.entry"), true);
});

test("Pon state version, chain, factory, and runtime fingerprint are fail-closed", async (t) => {
  const scenarios = [
    { label: "version", mutate: (state) => { state.version = 2; }, reason: "pon_state_version_invalid" },
    { label: "chain", mutate: (state) => { state.identity.chainId = 1; }, reason: "pon_pinned_identity_mismatch" },
    {
      label: "factory",
      mutate: (state) => { state.identity.factory = "0x1111111111111111111111111111111111111111"; },
      reason: "pon_pinned_identity_mismatch",
    },
    {
      label: "runtime hash",
      mutate: (state) => { state.identity.factoryCodeHash = `0x${"11".repeat(32)}`; },
      reason: "pon_pinned_identity_mismatch",
    },
    {
      label: "deployment transaction",
      mutate: (state) => { state.identity.deploymentTransaction = `0x${"22".repeat(32)}`; },
      reason: "pon_pinned_identity_mismatch",
    },
    {
      label: "deployment block",
      mutate: (state) => { state.identity.deploymentBlock += 1; },
      reason: "pon_pinned_identity_mismatch",
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.label, async (subtest) => {
      const { dataDir, configDir } = await makeWorkspace(subtest);
      await installStack(dataDir, BASE_NOW);
      const stateFile = path.join(dataDir, "pon-state.json");
      const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
      scenario.mutate(state);
      await writeJson(dataDir, "pon-state.json", state, BASE_NOW);
      const report = await runHealthCheck({
        env: healthEnv({ dataDir, configDir, requirePon: true }),
        nowMs: BASE_NOW,
        serviceStateImpl: activeService,
      });
      assert.equal(report.lanes.pon.operationalHealthy, false);
      assert.equal(report.lanes.pon.status, "critical");
      assert.equal(report.lanes.pon.operationalReasons.includes(scenario.reason), true);
    });
  }
});

test("Pon health rejects restart-incompatible or corrupt durable state shapes", async (t) => {
  for (const scenario of [
    {
      label: "non-numeric count anchor",
      mutate: (state) => { state.cursor.marketCountAtCursor = "4"; },
      reason: "pon_cursor_missing_or_invalid",
    },
    {
      label: "array pending map",
      mutate: (state) => { state.pendingMarketEvents = []; },
      reason: "pon_state_schema_invalid:pendingMarketEvents",
    },
    {
      label: "malformed pending proof",
      mutate: (state) => {
        state.pendingMarketEvents.bad = { eventKey: "different", snapshot: {}, proof: {}, log: {} };
      },
      reason: "pon_state_schema_invalid:pendingMarketEvents.bad",
    },
    {
      label: "invalid processed keys",
      mutate: (state) => { state.processedEventKeys = [""]; },
      reason: "pon_state_schema_invalid:processedEventKeys",
    },
    {
      label: "malformed finalized checkpoint",
      mutate: (state) => { state.finalizedCheckpoints[0].blockHash = "0xdead"; },
      reason: "pon_state_schema_invalid:finalizedCheckpoints.entry",
    },
    {
      label: "missing cursor checkpoint",
      mutate: (state) => { state.finalizedCheckpoints = []; },
      reason: "pon_cursor_checkpoint_missing_or_mismatched",
    },
    {
      label: "cursor checkpoint listing count mismatch",
      mutate: (state) => { state.finalizedCheckpoints[0].listingCount += 1; },
      reason: "pon_cursor_checkpoint_missing_or_mismatched",
    },
    {
      label: "out-of-order finalized checkpoints",
      mutate: (state) => {
        state.finalizedCheckpoints.push({
          ...state.finalizedCheckpoints[0],
          blockNumber: state.finalizedCheckpoints[0].blockNumber - 1,
        });
      },
      reason: "pon_state_schema_invalid:finalizedCheckpoints.entry",
    },
    {
      label: "malformed alert origin",
      mutate: (state) => {
        state.alertOrigins.bad = { blockNumber: 51_900_000, blockHash: "0xdead", processedKey: "processed" };
      },
      reason: "pon_state_schema_invalid:alertOrigins.bad",
    },
    {
      label: "malformed alert rollback proof",
      mutate: (state) => {
        state.alertOrigins["pon-fun:origin:test"] = {
          blockNumber: 51_900_000,
          blockHash: `0x${"11".repeat(32)}`,
          processedKey: null,
          kind: "factory_config",
          recordedAt: state.checkedAt,
          rollback: { type: "market", key: "not-an-address", snapshot: null },
        };
      },
      reason: "pon_state_schema_invalid:alertOrigins.pon-fun:origin:test",
    },
    {
      label: "malformed unproven reorg timestamp",
      mutate: (state) => { state._health.reorg.unprovenAt = "not-a-time"; },
      reason: "pon_reorg_state_invalid",
    },
    {
      label: "unbounded orphan history",
      mutate: (state) => {
        state.reorgOrphanedEventKeys = Array.from({ length: 501 }, (_, index) => `orphan-${index}`);
      },
      reason: "pon_state_schema_invalid:reorgOrphanedEventKeys",
    },
    {
      label: "malformed retirement proof",
      mutate: (state) => {
        state.retiredMarkets.TEST = {
          ticker: "TEST",
          stockToken: "0x0000000000000000000000000000000000000000",
          poolFee: 3000,
          active: false,
          eventKey: "retirement",
          processedKey: "processed",
          blockNumber: 51_900_000,
          blockHash: `0x${"11".repeat(32)}`,
          transactionHash: "bad",
          logIndex: 0,
          retiredAt: state.checkedAt,
        };
      },
      reason: "pon_state_schema_invalid:retiredMarkets.TEST",
    },
    {
      label: "unsafe ticker key",
      mutate: (state) => { state.listings.constructor = {}; },
      reason: "pon_state_schema_invalid:listings.constructor",
    },
  ]) {
    await t.test(scenario.label, async (subtest) => {
      const { dataDir, configDir } = await makeWorkspace(subtest);
      await installStack(dataDir, BASE_NOW);
      const stateFile = path.join(dataDir, "pon-state.json");
      const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
      scenario.mutate(state);
      await writeJson(dataDir, "pon-state.json", state, BASE_NOW);

      const report = await runHealthCheck({
        env: healthEnv({ dataDir, configDir, requirePon: true }),
        nowMs: BASE_NOW,
        serviceStateImpl: activeService,
      });

      assert.equal(report.lanes.pon.operationalHealthy, false);
      assert.equal(report.lanes.pon.operationalReasons.includes(scenario.reason), true);
    });
  }
});

test("Pon durable event and state integrity failures cannot be masked as ordinary upstream backoff", async (t) => {
  for (const errorCode of [
    "PON_MARKET_EVENT_COVERAGE_GAP",
    "PON_LISTING_EVENT_COVERAGE_GAP",
    "PON_PENDING_CAPACITY_EXCEEDED",
    "PON_LOG_RECEIPT_MISMATCH",
    "PON_REORG_REWIND_FAILED",
    "PON_STATE_INVALID",
    "PON_FAILURE",
    "PON_FINALIZED_BLOCK_INVALID",
    "PON_SCAN_BLOCK_INVALID",
    "PON_API_CHAIN_MARKET_MISMATCH",
    "PON_MARKET_CODE_EMPTY",
  ]) {
    await t.test(errorCode, async (subtest) => {
      const { dataDir, configDir } = await makeWorkspace(subtest);
      await installStack(dataDir, BASE_NOW);
      const stateFile = path.join(dataDir, "pon-state.json");
      const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
      state._health.status = "degraded";
      state._health.lastErrorCode = errorCode;
      state._health.lastError = "integrity gate held the durable cursor";
      state._health.sources.chain = {
        ...state._health.sources.chain,
        status: "backoff",
        lastAttemptAt: new Date(BASE_NOW - 5_000).toISOString(),
        lastErrorAt: new Date(BASE_NOW - 5_000).toISOString(),
        lastErrorCode: errorCode,
        lastError: "integrity gate held the durable cursor",
        nextAttemptAt: new Date(BASE_NOW + 5 * 60_000).toISOString(),
      };
      await writeJson(dataDir, "pon-state.json", state, BASE_NOW);

      const report = await runHealthCheck({
        env: healthEnv({ dataDir, configDir, requirePon: true }),
        nowMs: BASE_NOW,
        serviceStateImpl: activeService,
      });

      assert.equal(report.lanes.pon.operationalHealthy, false);
      assert.equal(report.lanes.pon.status, "critical");
      assert.equal(
        report.lanes.pon.operationalReasons.includes(`pon_integrity_failure:${errorCode}`),
        true,
      );
    });
  }
});

test("pending and unmatched Pon markets only degrade source coverage", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const stateFile = path.join(dataDir, "pon-state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const transactionHash = `0x${"33".repeat(32)}`;
  const marketSnapshot = {
    ticker: "TEST",
    symbol: "pTEST",
    name: "Test Market",
    coin: "0x1111111111111111111111111111111111111111",
    vault: "0x2222222222222222222222222222222222222222",
    curve: "0x3333333333333333333333333333333333333333",
    creator: "0x4444444444444444444444444444444444444444",
    creatorFeeBps: 100,
  };
  const encoded = PON_FACTORY_INTERFACE.encodeEventLog(
    PON_FACTORY_INTERFACE.getEvent("MarketCreated"),
    [
      marketSnapshot.ticker,
      marketSnapshot.symbol,
      marketSnapshot.name,
      marketSnapshot.coin,
      marketSnapshot.vault,
      marketSnapshot.curve,
      marketSnapshot.creator,
      marketSnapshot.creatorFeeBps,
    ],
  );
  const eventKey = `pon-fun:4663:${transactionHash}:0:${PON_FACTORY_EVENT_TOPICS.MarketCreated.toLowerCase()}`;
  const blockHash = `0x${"44".repeat(32)}`;
  state.pendingMarketEvents = {
    [eventKey]: {
      eventKey,
      snapshot: marketSnapshot,
      proof: { transactionHash, blockNumber: 51_900_000, blockHash, logIndex: 0 },
      log: {
        address: PON_FACTORY,
        transactionHash,
        blockNumber: 51_900_000,
        blockHash,
        index: 0,
        topics: encoded.topics,
        data: encoded.data,
      },
      firstSeenAt: state.checkedAt,
    },
  };
  state.unmatchedApiMarkets = {
    "0x5555555555555555555555555555555555555555": { firstSeenAt: state.checkedAt },
  };
  await writeJson(dataDir, "pon-state.json", state, BASE_NOW);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(report.lanes.pon.operationalHealthy, true);
  assert.equal(report.lanes.pon.coverageComplete, false);
  assert.equal(report.lanes.pon.status, "degraded");
  assert.equal(report.lanes.pon.coverageReasons.includes("pon_pending_market_proofs"), true);
  assert.equal(report.lanes.pon.coverageReasons.includes("pon_unmatched_api_markets"), true);
  assert.equal(report.operationalHealthy, true);
});

test("a reserved Pon API transition is visible until durable delivery completes", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const stateFile = path.join(dataDir, "pon-state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const lane = "market:0x1111111111111111111111111111111111111111";
  const transitionPrefix = "pon-fun:market-lifecycle:0x1111111111111111111111111111111111111111";
  state.apiTransitionRevisions[lane] = 1;
  state.pendingApiTransitions[lane] = {
    lane,
    fingerprint: "{\"graduated\":true}",
    revision: 1,
    apiHealthBlock: 51_900_000,
    bindingBlock: 51_900_000,
    eventKey: `${transitionPrefix}:rev:1:api:51900000:binding:51900000`,
    reservedAt: new Date(BASE_NOW - 5_000).toISOString(),
  };
  await writeJson(dataDir, "pon-state.json", state, BASE_NOW);
  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(report.lanes.pon.operationalHealthy, true);
  assert.equal(report.lanes.pon.coverageComplete, false);
  assert.equal(report.lanes.pon.coverageReasons.includes("pon_api_transitions_pending_delivery"), true);
  assert.equal(report.lanes.pon.semantic.pendingApiTransitionCount, 1);

  state.pendingApiTransitions[lane].revision = 2;
  await writeJson(dataDir, "pon-state.json", state, BASE_NOW);
  const corrupt = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(corrupt.lanes.pon.operationalHealthy, false);
  assert.equal(
    corrupt.lanes.pon.operationalReasons.includes(`pon_state_schema_invalid:pendingApiTransitions.${lane}`),
    true,
  );
});

test("Pon API 429, 403, 5xx, and timeout backoff degrade coverage without causing restart storms", async (t) => {
  for (const scenario of [
    { label: "429", code: "PON_HTTP_STATUS", error: "official endpoint returned HTTP 429" },
    { label: "403", code: "PON_HTTP_STATUS", error: "official endpoint returned HTTP 403" },
    { label: "503", code: "PON_HTTP_STATUS", error: "official endpoint returned HTTP 503" },
    { label: "timeout", code: "PON_HTTP_FAILED", error: "request failed: TimeoutError" },
  ]) {
    await t.test(scenario.label, async (subtest) => {
      const { dataDir, configDir } = await makeWorkspace(subtest);
      await installStack(dataDir, BASE_NOW);
      const first = await runHealthCheck({
        env: healthEnv({ dataDir, configDir, requirePon: true }),
        nowMs: BASE_NOW,
        serviceStateImpl: activeService,
      });
      const later = BASE_NOW + 10 * 60_000;
      await installStack(dataDir, later);
      const stateFile = path.join(dataDir, "pon-state.json");
      const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
      const nextAttemptAt = new Date(later + 5 * 60_000).toISOString();
      state._health.status = "critical";
      state._health.lastSuccessAt = new Date(later - 10 * 60_000).toISOString();
      state._health.lastErrorCode = scenario.code;
      state._health.lastError = scenario.error;
      state._health.nextAttemptAt = nextAttemptAt;
      state._health.sources.api_markets = {
        ...state._health.sources.api_markets,
        status: "backoff",
        lastAttemptAt: new Date(later - 5_000).toISOString(),
        lastSuccessAt: new Date(later - 10 * 60_000).toISOString(),
        lastErrorAt: new Date(later - 5_000).toISOString(),
        lastErrorCode: scenario.code,
        lastError: scenario.error,
        nextAttemptAt,
      };
      for (const dependent of ["chain", "delivery"]) {
        state._health.sources[dependent].lastAttemptAt = new Date(later - 10 * 60_000).toISOString();
        state._health.sources[dependent].lastSuccessAt = new Date(later - 10 * 60_000).toISOString();
      }
      await writeJson(dataDir, "pon-state.json", state, later);
      const previous = { version: 3, lanes: { pon: structuredClone(first.lanes.pon) } };
      previous.lanes.pon.progress.lastAdvancedAt = new Date(later - 10 * 60_000).toISOString();
      await writeJson(dataDir, "health.json", previous, later);
      let heartbeatCalls = 0;

      const report = await runHealthCheck({
        env: healthEnv({ dataDir, configDir, heartbeat: true, requirePon: true }),
        nowMs: later,
        serviceStateImpl: activeService,
        fetchImpl: async () => {
          heartbeatCalls += 1;
          return { ok: true, status: 204 };
        },
      });

      assert.equal(report.lanes.pon.progress.frozen, true);
      assert.equal(report.lanes.pon.operationalHealthy, true);
      assert.equal(report.lanes.pon.coverageComplete, false);
      assert.equal(report.lanes.pon.status, "degraded");
      assert.equal(report.lanes.pon.coverageReasons.includes("pon_cursor_frozen_during_upstream_backoff"), true);
      assert.equal(report.lanes.pon.coverageReasons.some((reason) => reason.includes("api_markets")), true);
      assert.equal(report.lanes.pon.semantic.nextAttemptAt, nextAttemptAt);
      assert.equal(report.operationalHealthy, true);
      assert.equal(report.coverageComplete, false);
      assert.equal(heartbeatCalls, 1);
      assert.equal(report.failures.length, 0);
    });
  }
});

test("Pon logical HTTP and parser failures remain operational even when an API circuit is open", async (t) => {
  for (const scenario of [
    { code: "PON_HTTP_BODY_INVALID", error: "official endpoint returned an invalid body" },
    { code: "PON_HTTP_JSON_INVALID", error: "official endpoint returned invalid JSON" },
    { code: "PON_HTTP_STATUS", error: "official endpoint returned HTTP 404" },
    { code: "PON_HTTP_FAILED", error: "request failed: invalid redirect state" },
  ]) {
    await t.test(scenario.code, async (subtest) => {
      const { dataDir, configDir } = await makeWorkspace(subtest);
      await installStack(dataDir, BASE_NOW);
      const state = JSON.parse(await fs.readFile(path.join(dataDir, "pon-state.json"), "utf8"));
      const observedAt = new Date(BASE_NOW - 5_000).toISOString();
      state._health.status = "degraded";
      state._health.lastErrorCode = scenario.code;
      state._health.lastError = scenario.error;
      state._health.sources.api_markets = {
        ...state._health.sources.api_markets,
        status: "backoff",
        lastAttemptAt: observedAt,
        lastErrorAt: observedAt,
        lastErrorCode: scenario.code,
        lastError: scenario.error,
        nextAttemptAt: new Date(BASE_NOW + 60_000).toISOString(),
      };
      await writeJson(dataDir, "pon-state.json", state, BASE_NOW);

      const report = await runHealthCheck({
        env: healthEnv({ dataDir, configDir, requirePon: true }),
        nowMs: BASE_NOW,
        serviceStateImpl: activeService,
      });
      assert.equal(report.lanes.pon.operationalHealthy, false);
      assert.equal(
        report.lanes.pon.operationalReasons.includes(`pon_integrity_failure:${scenario.code}`),
        true,
      );
    });
  }
});

test("Pon API block lag and regression are coverage-only only with an active attributed backoff", async (t) => {
  for (const scenario of [
    { label: "stale", code: "PON_API_BLOCK_STALE" },
    { label: "regression", code: "PON_API_BLOCK_REGRESSION" },
  ]) {
    await t.test(scenario.label, async (subtest) => {
      const { dataDir, configDir } = await makeWorkspace(subtest);
      await installStack(dataDir, BASE_NOW);
      const stateFile = path.join(dataDir, "pon-state.json");
      const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
      state._health.status = "degraded";
      state._health.lastErrorCode = scenario.code;
      state._health.lastError = "official health block freshness gate held the cursor";
      state._health.sources.api_health = {
        ...state._health.sources.api_health,
        status: "backoff",
        lastAttemptAt: new Date(BASE_NOW - 5_000).toISOString(),
        lastErrorAt: new Date(BASE_NOW - 5_000).toISOString(),
        lastErrorCode: scenario.code,
        lastError: "official health block freshness gate held the cursor",
        nextAttemptAt: new Date(BASE_NOW + 60_000).toISOString(),
      };
      if (scenario.code === "PON_API_BLOCK_STALE") {
        state._health.apiCoverage.reportedBlock += 10;
        state._health.apiCoverage.highWaterBlock = state._health.apiCoverage.reportedBlock;
        state._health.apiCoverage.finalizedBlock = state._health.apiCoverage.reportedBlock + 129;
        state._health.apiCoverage.blockLag = 129;
      } else {
        state._health.apiCoverage.reportedBlock -= 1;
        state._health.apiCoverage.finalizedBlock += 129;
        state._health.apiCoverage.blockLag = 130;
      }
      const attributedCoverage = { ...state._health.apiCoverage };
      await writeJson(dataDir, "pon-state.json", state, BASE_NOW);

      const degraded = await runHealthCheck({
        env: healthEnv({ dataDir, configDir, requirePon: true }),
        nowMs: BASE_NOW,
        serviceStateImpl: activeService,
      });
      assert.equal(degraded.lanes.pon.operationalHealthy, true);
      assert.equal(degraded.lanes.pon.coverageComplete, false);
      assert.equal(degraded.lanes.pon.status, "degraded");

      if (scenario.code === "PON_API_BLOCK_STALE") {
        state._health.apiCoverage.finalizedBlock = state._health.apiCoverage.reportedBlock
          + state._health.apiCoverage.maxBlockLag;
        state._health.apiCoverage.blockLag = state._health.apiCoverage.maxBlockLag;
      } else {
        state._health.apiCoverage.reportedBlock = state._health.apiCoverage.highWaterBlock;
        state._health.apiCoverage.blockLag = state._health.apiCoverage.finalizedBlock
          - state._health.apiCoverage.reportedBlock;
      }
      await writeJson(dataDir, "pon-state.json", state, BASE_NOW);
      const inconsistent = await runHealthCheck({
        env: healthEnv({ dataDir, configDir, requirePon: true }),
        nowMs: BASE_NOW,
        serviceStateImpl: activeService,
      });
      assert.equal(inconsistent.lanes.pon.operationalHealthy, false);
      assert.equal(
        inconsistent.lanes.pon.operationalReasons.includes("pon_api_coverage_state_invalid"),
        true,
      );

      state._health.apiCoverage = attributedCoverage;
      state._health.sources.api_health.status = "healthy";
      state._health.sources.api_health.nextAttemptAt = null;
      await writeJson(dataDir, "pon-state.json", state, BASE_NOW);
      const unattributed = await runHealthCheck({
        env: healthEnv({ dataDir, configDir, requirePon: true }),
        nowMs: BASE_NOW,
        serviceStateImpl: activeService,
      });
      assert.equal(unattributed.lanes.pon.operationalHealthy, false);
      assert.equal(
        unattributed.lanes.pon.operationalReasons.includes(`pon_integrity_failure:${scenario.code}`),
        true,
      );
    });
  }
});

test("Pon API block arithmetic and silent freshness violations fail closed", async (t) => {
  for (const scenario of [
    {
      label: "inconsistent lag arithmetic",
      mutate: (coverage) => { coverage.blockLag = 7; },
    },
    {
      label: "stale block without recorded gate failure",
      mutate: (coverage) => {
        coverage.finalizedBlock = coverage.reportedBlock + coverage.maxBlockLag + 1;
        coverage.blockLag = coverage.maxBlockLag + 1;
      },
    },
    {
      label: "regressed block without recorded gate failure",
      mutate: (coverage) => {
        coverage.reportedBlock -= 1;
        coverage.blockLag = coverage.finalizedBlock - coverage.reportedBlock;
      },
    },
  ]) {
    await t.test(scenario.label, async (subtest) => {
      const { dataDir, configDir } = await makeWorkspace(subtest);
      await installStack(dataDir, BASE_NOW);
      const stateFile = path.join(dataDir, "pon-state.json");
      const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
      scenario.mutate(state._health.apiCoverage);
      await writeJson(dataDir, "pon-state.json", state, BASE_NOW);
      const report = await runHealthCheck({
        env: healthEnv({ dataDir, configDir, requirePon: true }),
        nowMs: BASE_NOW,
        serviceStateImpl: activeService,
      });
      assert.equal(report.lanes.pon.operationalHealthy, false);
      assert.equal(report.lanes.pon.operationalReasons.includes("pon_api_coverage_state_invalid"), true);
    });
  }
});

test("Pon RPC-call failures are coverage-only only when their error proves a transient transport outage", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const stateFile = path.join(dataDir, "pon-state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const observedAt = new Date(BASE_NOW - 5_000).toISOString();
  state._health.status = "degraded";
  state._health.lastErrorCode = "PON_PLATFORM_TOKEN_CALL_FAILED";
  state._health.sources.chain = {
    ...state._health.sources.chain,
    status: "backoff",
    lastAttemptAt: observedAt,
    lastErrorAt: observedAt,
    lastErrorCode: "PON_PLATFORM_TOKEN_CALL_FAILED",
    lastError: "socket network timeout",
    nextAttemptAt: new Date(BASE_NOW + 60_000).toISOString(),
  };
  await writeJson(dataDir, "pon-state.json", state, BASE_NOW);
  const transport = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(transport.lanes.pon.operationalHealthy, true);
  assert.equal(transport.lanes.pon.coverageComplete, false);

  state._health.sources.chain.lastError = "execution reverted: invalid token ABI";
  await writeJson(dataDir, "pon-state.json", state, BASE_NOW);
  const logical = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(logical.lanes.pon.operationalHealthy, false);
  assert.equal(
    logical.lanes.pon.operationalReasons.includes("pon_integrity_failure:PON_PLATFORM_TOKEN_CALL_FAILED"),
    true,
  );
});

test("a recorded bounded Pon reorg rewind is coverage degradation, not state corruption", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const first = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  const later = BASE_NOW + 60_000;
  await installStack(dataDir, later);
  const stateFile = path.join(dataDir, "pon-state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  state.cursor.nextBlock = 51_899_981;
  state.cursor.lastScannedBlock = 51_899_980;
  state.cursor.lastScannedBlockHash = `0x${"bb".repeat(32)}`;
  state.finalizedCheckpoints = [
    {
      blockNumber: 51_899_949,
      blockHash: `0x${"aa".repeat(32)}`,
      marketCount: 4,
      listingCount: 3,
      recordedAt: new Date(later - 5_000).toISOString(),
    },
    {
      blockNumber: 51_899_980,
      blockHash: `0x${"bb".repeat(32)}`,
      marketCount: 4,
      listingCount: 3,
      recordedAt: new Date(later - 5_000).toISOString(),
    },
  ];
  state._health.reorg = {
    count: 1,
    lastDetectedAt: new Date(later - 5_000).toISOString(),
    rewindFrom: 51_900_000,
    rewindTo: 51_899_950,
    commonAncestorBlock: 51_899_949,
    commonAncestorProven: true,
    orphanedAlertCount: 0,
    lastOrphanedAt: null,
    lastOrphanedEventKeys: [],
    midCycleAnchorFailures: 0,
  };
  await writeJson(dataDir, "pon-state.json", state, later);
  await writeJson(dataDir, "health.json", { version: 3, lanes: { pon: first.lanes.pon } }, later);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: later,
    serviceStateImpl: activeService,
  });
  assert.equal(report.lanes.pon.progress.regressed, true);
  assert.equal(report.lanes.pon.operationalHealthy, true);
  assert.equal(report.lanes.pon.coverageComplete, false);
  assert.equal(report.lanes.pon.coverageReasons.includes("pon_cursor_rewound_for_finalized_reorg"), true);
});

test("an unproven Pon reorg cannot disguise a regressed cursor as bounded recovery", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const first = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  const later = BASE_NOW + 60_000;
  await installStack(dataDir, later);
  const stateFile = path.join(dataDir, "pon-state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  state.cursor.nextBlock = 51_899_981;
  state.cursor.lastScannedBlock = 51_899_980;
  state.cursor.lastScannedBlockHash = `0x${"bb".repeat(32)}`;
  state._health.status = "degraded";
  state._health.lastErrorCode = "PON_REORG_COMMON_ANCESTOR_UNPROVEN";
  state._health.sources.chain.status = "backoff";
  state._health.sources.chain.lastErrorCode = "PON_REORG_COMMON_ANCESTOR_UNPROVEN";
  state._health.sources.chain.lastError = "no matching persisted checkpoint";
  state._health.sources.chain.nextAttemptAt = new Date(later + 60_000).toISOString();
  state._health.reorg = {
    count: 0,
    lastDetectedAt: null,
    rewindFrom: 51_900_000,
    rewindTo: null,
    commonAncestorBlock: null,
    commonAncestorProven: false,
    orphanedAlertCount: 0,
    lastOrphanedAt: null,
    lastOrphanedEventKeys: [],
    midCycleAnchorFailures: 0,
    unprovenAt: new Date(later - 5_000).toISOString(),
  };
  await writeJson(dataDir, "pon-state.json", state, later);
  await writeJson(dataDir, "health.json", { version: 3, lanes: { pon: first.lanes.pon } }, later);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: later,
    serviceStateImpl: activeService,
  });
  assert.equal(report.lanes.pon.progress.regressed, true);
  assert.equal(report.lanes.pon.operationalHealthy, false);
  assert.equal(
    report.lanes.pon.operationalReasons.includes("pon_integrity_failure:PON_REORG_COMMON_ANCESTOR_UNPROVEN"),
    true,
  );
  assert.equal(report.lanes.pon.coverageReasons.includes("pon_cursor_rewound_for_finalized_reorg"), false);
});

test("a bounded Pon mid-cycle anchor change is coverage-only only with its exact recovery marker", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const stateFile = path.join(dataDir, "pon-state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const observedAt = new Date(BASE_NOW - 5_000).toISOString();
  state._health.status = "degraded";
  state._health.lastErrorCode = "PON_SCAN_ANCHOR_CHANGED";
  state._health.lastError = "canonical block changed during cycle";
  state._health.sources.chain = {
    ...state._health.sources.chain,
    status: "backoff",
    lastAttemptAt: observedAt,
    lastErrorAt: observedAt,
    lastErrorCode: "PON_SCAN_ANCHOR_CHANGED",
    lastError: "canonical block changed during cycle",
    consecutiveFailures: 1,
    nextAttemptAt: new Date(BASE_NOW + 60_000).toISOString(),
  };
  state._health.reorg.midCycleAnchorFailures = 1;
  state._health.reorg.lastAnchorFailureAt = observedAt;
  state._health.reorg.lastAnchorFailureCode = "PON_SCAN_ANCHOR_CHANGED";
  state._health.reorg.recoveryPending = true;
  await writeJson(dataDir, "pon-state.json", state, BASE_NOW);

  const recovering = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(recovering.lanes.pon.operationalHealthy, true);
  assert.equal(recovering.lanes.pon.coverageComplete, false);

  state._health.reorg.recoveryPending = false;
  await writeJson(dataDir, "pon-state.json", state, BASE_NOW);
  const unmarked = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(unmarked.lanes.pon.operationalHealthy, false);
  assert.equal(
    unmarked.lanes.pon.operationalReasons.includes("pon_integrity_failure:PON_SCAN_ANCHOR_CHANGED"),
    true,
  );

  state._health.reorg.recoveryPending = true;
  state._health.sources.chain.consecutiveFailures = 4;
  await writeJson(dataDir, "pon-state.json", state, BASE_NOW);
  const repeated = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  assert.equal(repeated.lanes.pon.operationalHealthy, false);
});

test("a fresh Pon state rewrite cannot hide a frozen on-chain cursor", async (t) => {
  const { dataDir, configDir } = await makeWorkspace(t);
  await installStack(dataDir, BASE_NOW);
  const first = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: BASE_NOW,
    serviceStateImpl: activeService,
  });
  const later = BASE_NOW + 10 * 60_000;
  await installStack(dataDir, later);
  const previous = { version: 3, lanes: { pon: structuredClone(first.lanes.pon) } };
  previous.lanes.pon.progress.lastAdvancedAt = new Date(later - 10 * 60_000).toISOString();
  await writeJson(dataDir, "health.json", previous, later);

  const report = await runHealthCheck({
    env: healthEnv({ dataDir, configDir, requirePon: true }),
    nowMs: later,
    serviceStateImpl: activeService,
  });
  assert.equal(report.lanes.pon.authoritative.ageSeconds <= 5, true);
  assert.equal(report.lanes.pon.operationalHealthy, false);
  assert.equal(report.lanes.pon.operationalReasons.includes("pon_cursor_frozen"), true);
  assert.equal(report.status, "critical");
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
