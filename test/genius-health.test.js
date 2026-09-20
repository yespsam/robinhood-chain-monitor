import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHealthSettings, runHealthCheck } from "../deploy/health-check.mjs";

const NOW = Date.parse("2026-09-18T09:00:00.000Z");
const START = 122_266_383;
const KEYS = ["genius_manifest", "genius_about", "genius_integrate",
  "genius_x_terminal", "genius_x_foundation", "genius_chain"];
const at = (delta = -5_000) => new Date(NOW + delta).toISOString();

function geniusState() {
  return {
    version: 1,
    identity: { chainId: 56, factory: "0x78EAE9537C0ef90DFe9B7ae964682Fe8138afe31",
      factoryCodeHash: "0x416f19c32fbf75ea1a0cd2f51d05f0722f1f4cb0dbaf8f00cb22832345d4eef6" },
    sources: Object.fromEntries(KEYS.map((key) => [key, { initialized: true }])),
    health: { status: "healthy", checkedAt: at(), sources: Object.fromEntries(KEYS.map((key) => [key, {
      status: "healthy", checkedAt: at(), lastSuccessAt: at(), nextAttemptAt: null,
      consecutiveFailures: 0, lastError: null,
    }])) },
    chain: { initialized: true, realtimeNextBlock: START + 101, historicalNextBlock: START + 11,
      startBlock: START, baselineBlock: START + 10, latestFinalizedBlock: START + 100,
      historyComplete: true, anchors: {} },
    officialTokens: {},
  };
}

function queuedGeniusState() {
  const state = geniusState();
  const before = { lines: ["Existing official statement"] };
  const snapshot = { lines: ["Updated official statement"] };
  const beforeHash = createHash("sha256").update(JSON.stringify(before)).digest("hex");
  const afterHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const event = { type: "genius_fun_update", platform: "geniusfun", chainId: 56,
    sourceTrust: "official_verified", kind: "docs_update", observedAt: at(),
    sourceId: "genius_about", sourceUrl: "https://genius.fun/about", partIndex: 0,
    eventKey: `genius:genius_about:${beforeHash}:${afterHash}:0`,
    changes: [{ field: "document", before: before.lines[0], after: snapshot.lines[0] }],
    evidence: { sourceUrl: "https://genius.fun/about", beforeHash, afterHash } };
  state.sources.genius_about = { initialized: true, snapshot: before, hash: beforeHash,
    pendingObservation: { snapshot, hash: afterHash, events: [event] } };
  state.pendingEvents = [event];
  const token = "0x" + "a".repeat(40);
  const log = { name: "LaunchSwept", args: { token }, transactionHash: "0x" + "b".repeat(64),
    blockHash: "0x" + "c".repeat(64), blockNumber: START + 90, logIndex: 1,
    blockTimestamp: Math.floor(NOW / 1000) - 60 };
  state.unresolvedTokenEvents = [{ lane: "realtime", log, key: `${log.transactionHash}:1:${log.blockHash}`,
    providers: ["https://first.example", "https://second.example"] }];
  state.tokenOwners = { ["0x" + "d".repeat(40)]: "0x" + "e".repeat(40) };
  state.tokenResolutionFailures = { [token]: { consecutiveFailures: 1, lastError: "RPC HTTP 429",
    lastErrorCode: "GENIUS_HTTP", nextAttemptAt: at(120_000) } };
  return state;
}

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "genius-health-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const configDir = path.join(root, "config");
  await fs.mkdir(dataDir);
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "node-id"), "test-node");
  await fs.writeFile(path.join(configDir, "ACTIVE"), "test-node");
  const hydrate = (value) => {
    if (Array.isArray(value)) return value.map(hydrate);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrate(item)]));
    return value === "__NOW__" ? at() : value === "__OLD__" ? at(-600_000) : value === "__NEXT__" ? at(300_000) : value;
  };
  const base = JSON.parse(await fs.readFile(new URL("./fixtures/health/healthy-stack.json", import.meta.url), "utf8"));
  const write = async (file, value) => {
    const filename = path.join(dataDir, file);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, JSON.stringify(value));
    await fs.utimes(filename, new Date(at()), new Date(at()));
  };
  for (const [file, raw] of Object.entries(base)) {
    const value = hydrate(raw);
    if (file === "fomo-x-call-state.json" && value.health) {
      Object.assign(value.health, { operationalStatus: "healthy", lastOperationalSuccessAt: value.health.checkedAt, consecutiveFailures: 0 });
      value.health.sources ||= {};
      value.health.sources.x ||= {};
      Object.assign(value.health.sources.x, { operationalStatus: "healthy", lastOperationalSuccessAt: value.health.checkedAt, consecutiveFailures: 0 });
    }
    await write(file, value);
  }
  const check = async (state = geniusState(), overrides = {}) => {
    if (state) await write("genius-state.json", state);
    return runHealthCheck({
      env: { DATA_DIR: dataDir, HEALTH_CONFIG_DIR: configDir, HEALTH_REQUIRE_EXTERNAL_HEARTBEAT: "false",
        GENIUS_MONITOR_ENABLED: "true", ...overrides },
      nowMs: NOW, serviceStateImpl: async () => "active", writeReportFile: false,
      fetchImpl: async () => { throw new Error("health must not contact external services"); },
    });
  };
  return { dataDir, write, check };
}

test("Genius health is opt-in and exposes poll-derived source windows", () => {
  assert.equal(buildHealthSettings({}).requirements.genius, false);
  assert.equal(buildHealthSettings({ GENIUS_MONITOR_ENABLED: "true" }).requirements.genius, true);
  assert.equal(buildHealthSettings({ GENIUS_MONITOR_ENABLED: "true", HEALTH_REQUIRE_GENIUS: "false" }).requirements.genius, false);
  assert.equal(buildHealthSettings({}).geniusPollIntervals.docsMs, 60_000);
  assert.throws(() => buildHealthSettings({ GENIUS_X_POLL_INTERVAL_MS: "0" }));
});

test("disabled Genius requires no state and complete Genius contributes a healthy lane", async (t) => {
  const { check } = await workspace(t);
  const disabled = await check(null, { GENIUS_MONITOR_ENABLED: "false" });
  assert.equal(disabled.lanes.genius.status, "disabled");
  const report = await check();
  assert.equal(report.lanes.genius.status, "healthy", report.lanes.genius.operationalReasons.join(","));
  assert.equal(report.lanes.genius.coverageComplete, true);
  assert.equal(report.lanes.genius.semantic.officialTokenCount, 0);
  assert.equal(report.lanes.genius.semantic.sources.genius_chain.coverageComplete, true);
});

test("missing required Genius state is operational failure", async (t) => {
  const { check } = await workspace(t);
  const report = await check(null);
  assert.equal(report.lanes.genius.operationalHealthy, false);
  assert.ok(report.lanes.genius.operationalReasons.includes("genius-state.json_missing"));
});

test("Genius historical recovery and realtime gaps are incomplete coverage, not process failure", async (t) => {
  const { check } = await workspace(t);
  const state = geniusState();
  state.chain.historicalNextBlock = START;
  state.chain.historyComplete = false;
  state.chain.realtimeNextBlock -= 1;
  const { lanes: { genius } } = await check(state);
  assert.equal(genius.operationalHealthy, true, genius.operationalReasons.join(","));
  assert.equal(genius.coverageComplete, false);
  assert.ok(genius.coverageReasons.includes("genius_chain_history_incomplete"));
  assert.ok(genius.coverageReasons.includes("genius_chain_realtime_gap"));
});

test("Genius X continuity gaps cannot be hidden by otherwise healthy polls", async (t) => {
  const { check } = await workspace(t);
  for (const location of ["source", "health"]) {
    for (const field of ["coverageGap", "continuityGap"]) {
      const state = geniusState();
      const item = location === "source" ? state.sources.genius_x_terminal : state.health.sources.genius_x_terminal;
      item[field] = { status: "incomplete", reason: "cursor_not_in_timeline" };
      let genius = (await check(state)).lanes.genius;
      assert.equal(genius.operationalHealthy, true);
      assert.equal(genius.coverageComplete, false);
      assert.ok(genius.coverageReasons.includes("genius_source_continuity_gap:genius_x_terminal"));
      item[field].status = "complete";
      genius = (await check(state)).lanes.genius;
      assert.equal(genius.coverageComplete, true);
    }
  }
});

test("Genius bounded source retries remain operational only with a fresh scheduler heartbeat", async (t) => {
  const { check } = await workspace(t);
  const state = geniusState();
  Object.assign(state.health.sources.genius_x_terminal, {
    status: "backoff", checkedAt: at(-600_000), lastSuccessAt: at(-86_400_000),
    nextAttemptAt: at(120_000), consecutiveFailures: 4, lastError: "HTTP 429",
  });
  let genius = (await check(state)).lanes.genius;
  assert.equal(genius.operationalHealthy, true, genius.operationalReasons.join(","));
  assert.equal(genius.coverageComplete, false);
  assert.equal(genius.semantic.sources.genius_x_terminal.scheduledBackoff, true);
  state.health.checkedAt = at(-600_000);
  genius = (await check(state)).lanes.genius;
  assert.equal(genius.operationalHealthy, false);
  assert.ok(genius.operationalReasons.includes("genius_scheduler_checked_stale"));
});

test("Genius retry deadlines must be valid, future, and within 15 minutes of the attempt", async (t) => {
  const { check } = await workspace(t);
  for (const deadline of [null, "invalid", at(-1), at(901_000)]) {
    const state = geniusState();
    Object.assign(state.health.sources.genius_chain, { status: "backoff", checkedAt: at(0),
      nextAttemptAt: deadline, consecutiveFailures: 1, lastError: "timeout" });
    const genius = (await check(state)).lanes.genius;
    assert.equal(genius.operationalHealthy, false, String(deadline));
    assert.ok(genius.operationalReasons.includes("genius_source_backoff_invalid_or_expired:genius_chain"));
  }
});

test("Genius validates exact persisted identity, source health, and chain schema", async (t) => {
  const { check } = await workspace(t);
  const cases = [
    (s) => { s.version = 2; },
    (s) => { s.identity.chainId = 1; },
    (s) => { s.identity.factory = "0x" + "1".repeat(40); },
    (s) => { s.identity.factoryCodeHash = "0x" + "0".repeat(64); },
    (s) => { delete s.sources.genius_manifest; },
    (s) => { delete s.health.sources.genius_about; },
    (s) => { s.sources.genius_integrate.initialized = "true"; },
    (s) => { s.health.sources.genius_chain.consecutiveFailures = -1; },
    (s) => { s.health.sources.genius_chain.status = "unknown"; },
    (s) => { s.health.sources.genius_chain.lastSuccessAt = "garbage"; },
    (s) => { s.health.sources.genius_chain.lastSuccessAt = null; },
    (s) => { s.health.sources.genius_chain.lastSuccessAt = at(-600_000); },
    (s) => { s.health.sources.genius_chain.lastError = "unresolved error"; },
    (s) => { s.health.sources.genius_manifest.checkedAt = at(-600_000); },
    (s) => { s.chain.startBlock -= 1; },
    (s) => { s.chain.historicalNextBlock = 1.5; },
    (s) => { s.chain.realtimeNextBlock = s.chain.latestFinalizedBlock + 2; },
    (s) => { s.chain.historicalNextBlock = s.chain.baselineBlock; },
    (s) => { s.chain.anchors = []; },
    (s) => { s.chain.anchors.realtime = { number: START, hash: "not-a-hash", timestamp: 1 }; },
    (s) => { s.chain.realtimeNextBlock = s.chain.baselineBlock; },
    (s) => { s.officialTokens = []; },
    (s) => { s.officialTokens = { bad: {} }; },
    (s) => { s.officialTokens = Object.fromEntries(Array.from({ length: 5_001 }, (_, i) => [String(i), {}])); },
  ];
  for (const [index, mutate] of cases.entries()) {
    const state = geniusState();
    mutate(state);
    const genius = (await check(state)).lanes.genius;
    assert.equal(genius.operationalHealthy, false, `mutation ${index} should fail`);
    assert.equal(genius.coverageComplete, false);
  }
});

test("Genius initializes as coverage incomplete and docs intervals allow appropriately spaced checks", async (t) => {
  const { check } = await workspace(t);
  const state = geniusState();
  state.chain = { initialized: false, historyComplete: false, realtimeNextBlock: null,
    baselineBlock: null, latestFinalizedBlock: null, historicalNextBlock: START, startBlock: START, anchors: {} };
  for (const key of KEYS) {
    state.sources[key].initialized = false;
    Object.assign(state.health.sources[key], { status: "initializing", checkedAt: null, lastSuccessAt: null });
  }
  state.health.status = "initializing";
  state.health.checkedAt = null;
  let genius = (await check(state)).lanes.genius;
  assert.equal(genius.operationalHealthy, true, genius.operationalReasons.join(","));
  assert.equal(genius.coverageComplete, false);
  const slowDocs = geniusState();
  for (const key of ["genius_manifest", "genius_about", "genius_integrate"]) {
    Object.assign(slowDocs.health.sources[key], { checkedAt: at(-240_000), lastSuccessAt: at(-240_000) });
  }
  genius = (await check(slowDocs, { GENIUS_DOCS_POLL_INTERVAL_MS: "120000" })).lanes.genius;
  assert.equal(genius.operationalHealthy, true);
  assert.equal(genius.coverageComplete, true);
});

test("Genius integrity and durable-delivery failures are never hidden by a scheduled retry", async (t) => {
  const { check } = await workspace(t);
  for (const code of ["GENIUS_FACTORY_IDENTITY", "GENIUS_WRONG_CHAIN", "GENIUS_CANONICAL_ANCHOR_CHANGED",
    "GENIUS_LOG_CONSENSUS", "GENIUS_INVALID_LOG", "GENIUS_DELIVERY_NOT_DURABLE", "GENIUS_STATE_INVALID"]) {
    const state = geniusState();
    Object.assign(state.health.sources.genius_chain, { status: "backoff", checkedAt: at(), nextAttemptAt: at(120_000),
      lastErrorCode: code, lastError: "provider rejected the observed state", consecutiveFailures: 1 });
    const genius = (await check(state)).lanes.genius;
    assert.equal(genius.operationalHealthy, false, code);
    assert.ok(genius.operationalReasons.includes(`genius_source_integrity_failure:genius_chain:${code}`));
  }
  const state = geniusState();
  Object.assign(state.health.sources.genius_chain, { status: "backoff", checkedAt: at(), nextAttemptAt: at(120_000),
    lastError: "GENIUS_DELIVERY_NOT_DURABLE:failed", consecutiveFailures: 1 });
  assert.equal((await check(state)).lanes.genius.operationalHealthy, false);
});

test("Genius detects regressed cursors without treating an unchanged observed tip as frozen", async (t) => {
  const { check, write } = await workspace(t);
  const state = geniusState();
  const prior = (await check(state)).lanes.genius;
  prior.progress.lastAdvancedAt = at(-600_000);
  prior.semantic.historicalProgress.lastAdvancedAt = at(-600_000);
  await write("health.json", { lanes: { genius: prior } });
  let genius = (await check(state)).lanes.genius;
  assert.equal(genius.operationalHealthy, true, genius.operationalReasons.join(","));
  state.chain.realtimeNextBlock -= 1;
  genius = (await check(state)).lanes.genius;
  assert.ok(genius.operationalReasons.includes("genius_chain_cursor_regressed"));
});

test("Genius detects a frozen outstanding cursor but respects a bounded chain-source retry", async (t) => {
  const { check, write } = await workspace(t);
  const state = geniusState();
  state.chain.realtimeNextBlock -= 1;
  state.chain.historicalNextBlock = START;
  state.chain.historyComplete = false;
  const prior = (await check(state)).lanes.genius;
  prior.progress.lastAdvancedAt = at(-600_000);
  prior.semantic.historicalProgress.lastAdvancedAt = at(-600_000);
  await write("health.json", { lanes: { genius: prior } });
  let genius = (await check(state)).lanes.genius;
  assert.ok(genius.operationalReasons.includes("genius_chain_realtime_cursor_frozen"));
  assert.ok(genius.operationalReasons.includes("genius_chain_historical_cursor_frozen"));
  Object.assign(state.health.sources.genius_chain, { status: "backoff", checkedAt: at(), nextAttemptAt: at(300_000),
    lastSuccessAt: at(-600_000), consecutiveFailures: 1, lastError: "RPC timeout" });
  genius = (await check(state)).lanes.genius;
  assert.equal(genius.operationalHealthy, true, genius.operationalReasons.join(","));
  assert.equal(genius.coverageComplete, false);
});

test("Genius durable reservations and unresolved identities stay visible independently of fresh source success", async (t) => {
  const { check } = await workspace(t);
  const genius = (await check(queuedGeniusState())).lanes.genius;
  assert.equal(genius.operationalHealthy, true, genius.operationalReasons.join(","));
  assert.equal(genius.coverageComplete, false);
  assert.deepEqual(genius.semantic.queues, { pendingDeliveryCount: 1, pendingDocumentObservationCount: 1,
    pendingDocumentEventCount: 1, unresolvedTokenEventCount: 1, tokenResolutionFailureCount: 1, knownTokenOwnerCount: 1 });
  for (const reason of ["genius_delivery_pending", "genius_document_observation_pending",
    "genius_token_identity_resolution_pending", "genius_token_resolution_retry_pending"]) {
    assert.ok(genius.coverageReasons.includes(reason), reason);
  }
  // A document observation may remain after its individual cards were durably
  // delivered; don't falsely require every reservation to still be in outbox.
  const committing = queuedGeniusState();
  committing.pendingEvents = [];
  const result = (await check(committing)).lanes.genius;
  assert.equal(result.operationalHealthy, true);
  assert.equal(result.semantic.queues.pendingDocumentObservationCount, 1);
  assert.equal(result.semantic.queues.pendingDeliveryCount, 0);
});

test("Genius queue schema rejects corrupt, mismatched and over-capacity durable records", async (t) => {
  const { check } = await workspace(t);
  const mutations = [
    (s) => { s.pendingEvents = {}; },
    (s) => { s.pendingEvents.push(s.pendingEvents[0]); },
    (s) => { s.pendingEvents = Array(2001).fill(s.pendingEvents[0]); },
    (s) => { s.pendingEvents[0].sourceTrust = "community"; },
    (s) => { s.sources.genius_about.pendingObservation.hash = "a".repeat(64); },
    (s) => { s.sources.genius_about.hash = "a".repeat(64); },
    (s) => { s.sources.genius_about.snapshot.lines[0] = "tampered old snapshot"; },
    (s) => { s.sources.genius_about.pendingObservation.snapshot.lines[0] = "tampered"; },
    (s) => { s.sources.genius_about.pendingObservation.events = {}; },
    (s) => { s.sources.genius_about.pendingObservation.events[0].evidence.beforeHash = "f".repeat(64); },
    (s) => { s.sources.genius_about.pendingObservation = null; },
    (s) => { s.unresolvedTokenEvents = {}; },
    (s) => { s.unresolvedTokenEvents = Array(5001).fill(s.unresolvedTokenEvents[0]); },
    (s) => { s.unresolvedTokenEvents.push(s.unresolvedTokenEvents[0]); },
    (s) => { s.unresolvedTokenEvents[0].key = "wrong"; },
    (s) => { s.unresolvedTokenEvents[0].log.blockHash = "0x0"; },
    (s) => { s.unresolvedTokenEvents[0].providers = ["https://first.example", "https://first.example"]; },
    (s) => { s.unresolvedTokenEvents[0].providers = ["https://first.example/path", "https://second.example"]; },
    (s) => { s.tokenOwners = []; },
    (s) => { s.tokenOwners.bad = "wallet"; },
    (s) => { s.tokenResolutionFailures = []; },
    (s) => { Object.values(s.tokenResolutionFailures)[0].consecutiveFailures = -1; },
    (s) => { Object.values(s.tokenResolutionFailures)[0].nextAttemptAt = at(901_000); },
    (s) => { Object.values(s.tokenResolutionFailures)[0].nextAttemptAt = "invalid"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const state = queuedGeniusState();
    mutate(state);
    const genius = (await check(state)).lanes.genius;
    assert.equal(genius.operationalHealthy, false, `queue mutation ${index}`);
    assert.ok(genius.operationalReasons.some((reason) => reason.startsWith("genius_queue_schema_invalid:")), String(index));
  }
});

test("Genius token-resolution integrity failures stay critical even if the main chain source recovered", async (t) => {
  const { check } = await workspace(t);
  const state = queuedGeniusState();
  Object.values(state.tokenResolutionFailures)[0].lastErrorCode = "GENIUS_LAUNCH_RECORD_MISMATCH";
  const genius = (await check(state)).lanes.genius;
  assert.equal(genius.semantic.sources.genius_chain.status, "healthy");
  assert.equal(genius.operationalHealthy, false);
  assert.ok(genius.operationalReasons.includes("genius_token_resolution_integrity_failure:GENIUS_LAUNCH_RECORD_MISMATCH"));
});
