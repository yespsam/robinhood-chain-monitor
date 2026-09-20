import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  NARRATIVE_SHADOW_SOAK_CHECKPOINT_SCHEMA,
  createAuditOnlyLiveEvidenceProvider,
  createAuditOnlyShadowLedger,
  createDurableLocalAlertSink,
  createNarrativeShadowSoak,
} from "../src/narrative-shadow-soak-sidecar.js";
import { deriveNarrativeTradeSignal } from "../src/narrative-trade-signal.js";
import { atomicWriteRuntimeHeartbeat } from "../src/runtime-heartbeat.js";

const LONG_MS = 60_000;

function outbox(records) {
  return {
    version: 2,
    events: Object.fromEntries(records.map((record) => [record.id, {
      id: record.id,
      event: record.event,
      createdAt: record.createdAt || "2026-09-07T00:00:00.000Z",
    }])),
  };
}

async function writeOutbox(file, records) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(outbox(records))}\n`, { mode: 0o600 });
}

function runtimeStub(overrides = {}) {
  const calls = [];
  let stopped = false;
  return {
    calls,
    async observe(event) {
      calls.push(structuredClone(event));
      return overrides.observe ? overrides.observe(event) : { status: "admitted" };
    },
    async check() { return overrides.check ? overrides.check() : { status: "healthy" }; },
    async getState() {
      return { health: { status: stopped ? "stopped" : "healthy" }, inbox: {}, candidates: {}, signals: {} };
    },
    async getLedgerState() { return overrides.ledgerState?.() || { orders: {} }; },
    async getMetrics() { return { totalOrders: 0 }; },
    async getShadowSimulationMetrics() { return { executable: false }; },
    async stop() { stopped = true; await overrides.stop?.(); },
  };
}

async function fixture(t, { records = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-shadow-soak-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.json");
  const dataDir = path.join(root, "isolated");
  await writeOutbox(source, records);
  return { root, source, dataDir };
}

function createWorker(dataDir, source, runtime, dependencies = {}) {
  return createNarrativeShadowSoak({
    dataDir,
    sourceFiles: [{ id: "main", file: source }],
    durationMs: LONG_MS,
    pollIntervalMs: LONG_MS,
    heartbeatIntervalMs: LONG_MS,
  }, { runtime, ...dependencies });
}

test("audit-only live evidence always closes admission while wallet, holder, or LP evidence is missing", async () => {
  const asOf = "2026-09-07T00:10:00.000Z";
  let stopped = false;
  const upstream = {
    async assess() {
      return {
        status: "complete",
        complete: true,
        marketEvidence: {
          asOf,
          dataHealth: "healthy",
          dataHealthy: true,
          coverageComplete: true,
          coverageGap: false,
          marketConfirmed: true,
          momentumConfirmed: true,
          walletClusterConfirmed: false,
          liquidityUsd: 100_000,
          minimumLiquidityUsd: 25_000,
          estimatedSlippageBps: 80,
          maximumSlippageBps: 300,
          shadowNotionalUsd: 25,
          entryWindow: "open",
          missing: [],
        },
        riskEvidence: {
          asOf,
          coverageComplete: true,
          coverageGap: false,
          sellability: "verified_sellable",
          sellable: true,
          cannotSell: false,
          riskLevel: "low",
          highRisk: false,
          honeypot: false,
          ownerCanMint: false,
          ownerCanBlacklist: false,
          ownerCanFreeze: false,
          ownerCanPause: false,
          dynamicTax: false,
          coverage: { holderConcentration: "not_in_scope", lpLockOrBurn: "not_in_scope" },
        },
      };
    },
    async stop() { stopped = true; },
  };
  const guarded = createAuditOnlyLiveEvidenceProvider(upstream);
  const result = await guarded.assess({});
  assert.equal(result.status, "partial");
  assert.equal(result.complete, false);
  assert.equal(result.marketEvidence.marketConfirmed, false);
  assert.equal(result.marketEvidence.entryWindow, "closed");
  assert.deepEqual(result.soakGuard.reasons, [
    "wallet_cluster_unverified",
    "holder_concentration_unverified",
    "lp_lock_or_burn_unverified",
  ]);
  const signal = deriveNarrativeTradeSignal({
    event: {
      eventKey: "soak:test:watch",
      type: "new_pool",
      platform: { id: "flap", name: "Flap" },
      targetSymbol: "NVDAMEME",
      occurredAt: asOf,
    },
    poolContext: {
      chainId: 56,
      ca: "0x1111111111111111111111111111111111111111",
      resolution: "verified_complete",
      identityStatus: "matched",
      canonicalTicker: "NVDA",
      subject: { zh: "NVIDIA", en: "NVIDIA" },
      business: { zh: "AI 芯片", en: "AI chips" },
      meme: { zh: "卖铲人", en: "shovel seller" },
      sourceHash: "context-hash",
    },
    targetEvidence: {
      chainId: 56,
      ca: "0x3333333333333333333333333333333333333333",
      poolAddress: "0x2222222222222222222222222222222222222222",
      caVerified: true,
      poolVerified: true,
    },
    narrativeEvidence: {
      verified: true,
      sourceKind: "official_release",
      sourceUrl: "https://example.test/release",
      publishedAt: asOf,
      headline: { zh: "官方发布", en: "Official release" },
      subjectMatch: true,
      strength: 100,
      novelty: 100,
    },
    marketEvidence: result.marketEvidence,
    riskEvidence: result.riskEvidence,
    asOf,
  });
  assert.equal(signal.decision, "watch");
  assert.equal(signal.shadowOrder, null);
  await guarded.stop();
  assert.equal(stopped, true);
});

test("audit-only policy remains watch-only even if a future provider reports every reviewed coverage field", async () => {
  const guarded = createAuditOnlyLiveEvidenceProvider({
    assess: async () => ({
      status: "complete",
      complete: true,
      marketEvidence: {
        marketConfirmed: true,
        walletClusterConfirmed: true,
        entryWindow: "open",
      },
      riskEvidence: {
        coverage: {
          holderConcentration: "verified_safe",
          lpLockOrBurn: "verified_locked_or_burned",
        },
      },
    }),
    stop: async () => {},
  });
  const result = await guarded.assess({});
  assert.equal(result.marketEvidence.marketConfirmed, false);
  assert.equal(result.marketEvidence.entryWindow, "closed");
  assert.deepEqual(result.soakGuard.reasons, ["audit_only_soak_policy"]);
  await guarded.stop();
});

test("the audit-only ledger exposes no mutation capability", async () => {
  const ledger = createAuditOnlyShadowLedger();
  await ledger.ready;
  for (const method of ["admit", "open", "mark", "close", "expire", "invalidate"]) {
    await assert.rejects(ledger[method]({}), (error) => error?.code === "shadow_soak_ledger_mutation_forbidden");
  }
  assert.deepEqual((await ledger.getState()).orders, {});
  assert.equal((await ledger.getMetrics()).totalOrders, 0);
  await ledger.stop();
  assert.equal((await ledger.getState()).stopped, true);
});

test("first startup baselines existing IDs, consumes only future IDs once, and resumes from checkpoint", async (t) => {
  const first = { id: "event:1", event: { type: "verified_news", eventKey: "news:1", value: 1 } };
  const second = { id: "event:2", event: { type: "verified_news", eventKey: "news:2", value: 2 } };
  const { source, dataDir } = await fixture(t, { records: [first] });
  const runtime = runtimeStub();
  const worker = createWorker(dataDir, source, runtime);
  await worker.ready;
  assert.equal(runtime.calls.length, 0, "existing production history must only be baselined");

  await writeOutbox(source, [first, second]);
  const firstPoll = await worker.poll();
  assert.equal(firstPoll.observed, 1);
  assert.deepEqual(runtime.calls.map((event) => event.eventKey), ["news:2"]);
  await worker.poll();
  assert.equal(runtime.calls.length, 1);
  await worker.stop("test_restart");

  const restartedRuntime = runtimeStub();
  const restarted = createWorker(dataDir, source, restartedRuntime);
  await restarted.ready;
  await restarted.poll();
  assert.equal(restartedRuntime.calls.length, 0, "a durable cursor prevents replay after restart");
  const checkpoint = JSON.parse(await fs.readFile(restarted.checkpointFile, "utf8"));
  assert.equal(checkpoint.schema, NARRATIVE_SHADOW_SOAK_CHECKPOINT_SCHEMA);
  assert.equal(checkpoint.sources.main.baselined, true);
  assert.deepEqual(Object.keys(checkpoint.sources.main.entries).sort(), ["event:1", "event:2"]);
  await restarted.stop("test_complete");
});

test("restart consumes an ID added while the sidecar was stopped", async (t) => {
  const first = { id: "event:1", event: { type: "verified_news", eventKey: "news:1" } };
  const second = { id: "event:2", event: { type: "verified_news", eventKey: "news:2" } };
  const { source, dataDir } = await fixture(t, { records: [first] });
  const firstRuntime = runtimeStub();
  const firstWorker = createWorker(dataDir, source, firstRuntime);
  await firstWorker.ready;
  await firstWorker.stop("test_pause");

  await writeOutbox(source, [first, second]);
  const restartedRuntime = runtimeStub();
  const restarted = createWorker(dataDir, source, restartedRuntime);
  await restarted.ready;
  const result = await restarted.poll();
  assert.equal(result.observed, 1);
  assert.deepEqual(restartedRuntime.calls.map((event) => event.eventKey), ["news:2"]);
  await restarted.stop("test_complete");
});

test("a source missing at startup treats its first later records as future observations", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-shadow-late-source-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "late-source.json");
  const dataDir = path.join(root, "isolated");
  const runtime = runtimeStub();
  const worker = createWorker(dataDir, source, runtime);
  await worker.ready;
  await writeOutbox(source, [{
    id: "event:late",
    event: { type: "verified_news", eventKey: "news:late" },
  }]);
  const result = await worker.poll();
  assert.equal(result.observed, 1);
  assert.deepEqual(runtime.calls.map((event) => event.eventKey), ["news:late"]);
  await worker.stop("test_complete");
});

test("a failed checkpoint commit leaves the source dirty and retries the observation", async (t) => {
  const first = { id: "event:1", event: { type: "verified_news", eventKey: "news:1" } };
  const second = { id: "event:2", event: { type: "verified_news", eventKey: "news:2" } };
  const { source, dataDir } = await fixture(t, { records: [first] });
  const runtime = runtimeStub();
  let failNextCheckpoint = false;
  const worker = createNarrativeShadowSoak({
    dataDir,
    sourceFiles: [{ id: "main", file: source }],
    durationMs: LONG_MS,
    pollIntervalMs: LONG_MS,
    heartbeatIntervalMs: LONG_MS,
  }, {
    runtime,
    atomicWriteImpl: async (file, value, fsImpl) => {
      if (failNextCheckpoint && path.basename(file) === "checkpoint.json") {
        failNextCheckpoint = false;
        throw new Error("injected checkpoint failure");
      }
      return atomicWriteRuntimeHeartbeat(file, value, fsImpl);
    },
  });
  await worker.ready;
  await writeOutbox(source, [first, second]);
  failNextCheckpoint = true;
  const failed = await worker.poll();
  assert.equal(failed.status, "degraded");
  assert.deepEqual(runtime.calls.map((event) => event.eventKey), ["news:2"]);
  const durableBefore = JSON.parse(await fs.readFile(worker.checkpointFile, "utf8"));
  assert.deepEqual(Object.keys(durableBefore.sources.main.entries), ["event:1"]);

  const retried = await worker.poll();
  assert.equal(retried.observed, 1);
  assert.deepEqual(runtime.calls.map((event) => event.eventKey), ["news:2", "news:2"]);
  const durableAfter = JSON.parse(await fs.readFile(worker.checkpointFile, "utf8"));
  assert.deepEqual(Object.keys(durableAfter.sources.main.entries).sort(), ["event:1", "event:2"]);
  await worker.stop("test_complete");
});

test("an existing outbox ID with changed content is quarantined and never replayed", async (t) => {
  const original = { id: "stable:1", event: { type: "platform_capability_update", eventKey: "stable:1", revision: 1 } };
  const changed = { id: "stable:1", event: { type: "platform_capability_update", eventKey: "stable:1", revision: 2 } };
  const { source, dataDir } = await fixture(t, { records: [original] });
  const runtime = runtimeStub();
  const worker = createWorker(dataDir, source, runtime);
  await worker.ready;
  await writeOutbox(source, [changed]);
  await worker.poll();
  assert.equal(runtime.calls.length, 0);
  const status = await worker.getStatus();
  assert.equal(status.metrics.mutationsQuarantined, 1);
  const checkpoint = JSON.parse(await fs.readFile(worker.checkpointFile, "utf8"));
  const saved = checkpoint.sources.main.entries["stable:1"];
  assert.notEqual(saved.acceptedHash, saved.lastObservedHash);
  assert.ok(saved.mutationQuarantinedAt);
  await worker.stop("test_complete");
});

test("a malformed source degrades without advancing the checkpoint and recovers on a valid snapshot", async (t) => {
  const first = { id: "event:1", event: { type: "verified_news", eventKey: "news:1" } };
  const second = { id: "event:2", event: { type: "verified_news", eventKey: "news:2" } };
  const { source, dataDir } = await fixture(t, { records: [first] });
  const runtime = runtimeStub();
  const worker = createWorker(dataDir, source, runtime);
  await worker.ready;
  await fs.writeFile(source, "{not-json", "utf8");
  const failed = await worker.poll();
  assert.equal(failed.status, "degraded");
  assert.equal(runtime.calls.length, 0);
  const before = JSON.parse(await fs.readFile(worker.checkpointFile, "utf8"));
  assert.deepEqual(Object.keys(before.sources.main.entries), ["event:1"]);

  await writeOutbox(source, [first, second]);
  const recovered = await worker.poll();
  assert.equal(recovered.status, "running");
  assert.deepEqual(runtime.calls.map((event) => event.eventKey), ["news:2"]);
  await worker.stop("test_complete");
});

test("the exclusive lock fails before a second runtime factory is initialized", async (t) => {
  const { source, dataDir } = await fixture(t);
  let firstInitializations = 0;
  let secondInitializations = 0;
  const first = createNarrativeShadowSoak({
    dataDir,
    sourceFiles: [{ id: "main", file: source }],
    durationMs: LONG_MS,
    pollIntervalMs: LONG_MS,
    heartbeatIntervalMs: LONG_MS,
  }, {
    initialize: async () => {
      firstInitializations += 1;
      return { runtime: runtimeStub() };
    },
  });
  await first.ready;
  assert.equal(firstInitializations, 1);

  const second = createNarrativeShadowSoak({
    dataDir,
    sourceFiles: [{ id: "main", file: source }],
    durationMs: LONG_MS,
    pollIntervalMs: LONG_MS,
    heartbeatIntervalMs: LONG_MS,
  }, {
    initialize: async () => {
      secondInitializations += 1;
      return { runtime: runtimeStub() };
    },
  });
  await assert.rejects(second.ready, /lock already exists/u);
  assert.equal(secondInitializations, 0);
  await first.stop("test_complete");
});

test("a symlink into a protected production root is rejected before runtime initialization", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-shadow-path-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const production = path.join(root, "production-data");
  const source = path.join(root, "source.json");
  const linked = path.join(root, "soak-link");
  await fs.mkdir(production, { recursive: true });
  await fs.symlink(production, linked, "dir");
  await writeOutbox(source, []);
  let initialized = 0;
  const worker = createNarrativeShadowSoak({
    dataDir: linked,
    sourceFiles: [{ id: "main", file: source }],
    forbiddenWriteRoots: [production],
  }, {
    initialize: async () => {
      initialized += 1;
      return { runtime: runtimeStub() };
    },
  });
  await assert.rejects(worker.ready, /protected root|symbolic link/u);
  assert.equal(initialized, 0);
});

test("a missing child below a symlinked protected ancestor is rejected before mkdir", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-shadow-ancestor-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const production = path.join(root, "production-data");
  const source = path.join(root, "source.json");
  const linked = path.join(root, "linked-production");
  const dataDir = path.join(linked, "must-not-create");
  await fs.mkdir(production, { recursive: true });
  await fs.symlink(production, linked, "dir");
  await writeOutbox(source, []);
  let initialized = 0;
  const worker = createNarrativeShadowSoak({
    dataDir,
    sourceFiles: [{ id: "main", file: source }],
    forbiddenWriteRoots: [production],
  }, {
    initialize: async () => {
      initialized += 1;
      return { runtime: runtimeStub() };
    },
  });
  await assert.rejects(worker.ready, /protected root/u);
  assert.equal(initialized, 0);
  await assert.rejects(fs.stat(path.join(production, "must-not-create")), /ENOENT/u);
});

test("an owned runtime subdirectory symlink cannot escape into production state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-shadow-owned-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const production = path.join(root, "production-data");
  const source = path.join(production, "outbox.json");
  const dataDir = path.join(root, "isolated");
  const linkedRuntime = path.join(dataDir, "narrative-runtime");
  await fs.mkdir(production, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.symlink(production, linkedRuntime, "dir");
  await writeOutbox(source, []);
  let initialized = 0;
  const worker = createNarrativeShadowSoak({
    dataDir,
    sourceFiles: [{ id: "main", file: source }],
    forbiddenWriteRoots: [production],
    ownedWriteDirectories: [linkedRuntime],
  }, {
    initialize: async () => {
      initialized += 1;
      return { runtime: runtimeStub() };
    },
  });
  await assert.rejects(worker.ready, /owned write directory.*symbolic link/u);
  assert.equal(initialized, 0);
  assert.deepEqual((await fs.readdir(production)).sort(), ["outbox.json"]);
});

test("a persisted do signal fails preflight before any source event is consumed", async (t) => {
  const { source, dataDir } = await fixture(t, {
    records: [{ id: "event:1", event: { type: "verified_news", eventKey: "news:1" } }],
  });
  const runtime = runtimeStub();
  runtime.getState = async () => ({
    health: { status: "pending" },
    inbox: {},
    candidates: {},
    signals: { unsafe: { decision: "do", signal: { decision: "do" } } },
  });
  const worker = createWorker(dataDir, source, runtime);
  await assert.rejects(worker.ready, /do signal/u);
  assert.equal(runtime.calls.length, 0);
  await assert.rejects(fs.stat(worker.checkpointFile), /ENOENT/u);
  assert.equal(await fs.stat(worker.lockFile).then(() => true, () => false), true);
});

test("shutdown drains an active observation before stopping runtime and releasing the lock", async (t) => {
  const first = { id: "event:1", event: { type: "verified_news", eventKey: "news:1" } };
  const second = { id: "event:2", event: { type: "verified_news", eventKey: "news:2" } };
  const { source, dataDir } = await fixture(t, { records: [first] });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const order = [];
  const runtime = runtimeStub({
    observe: async () => { order.push("observe-start"); await gate; order.push("observe-end"); return { status: "admitted" }; },
    stop: async () => { order.push("runtime-stop"); },
  });
  const worker = createWorker(dataDir, source, runtime);
  await worker.ready;
  await writeOutbox(source, [first, second]);
  const polling = worker.poll();
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = worker.stop("SIGTERM");
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(await fs.stat(worker.lockFile).then(() => true, () => false), true);
  release();
  await Promise.all([polling, stopping]);
  assert.deepEqual(order, ["observe-start", "observe-end", "runtime-stop"]);
  await assert.rejects(fs.stat(worker.lockFile), /ENOENT/u);
  const status = JSON.parse(await fs.readFile(worker.statusFile, "utf8"));
  assert.equal(status.state, "stopped");
  assert.equal(status.stopReason, "SIGTERM");
  assert.equal(status.telegramEnabled, false);
});

test("final status preserves the last healthy runtime and ledger snapshot after dependencies stop", async (t) => {
  const { source, dataDir } = await fixture(t);
  let stopped = false;
  const runtime = runtimeStub();
  runtime.getState = async () => {
    if (stopped) throw new Error("runtime is stopped");
    return { health: { status: "healthy" }, inbox: {}, candidates: {}, signals: {} };
  };
  runtime.getMetrics = async () => {
    if (stopped) throw new Error("ledger is stopped");
    return { totalOrders: 0 };
  };
  runtime.stop = async () => { stopped = true; };
  const worker = createWorker(dataDir, source, runtime);
  await worker.start();
  const final = await worker.stop("test_complete");
  assert.equal(final.state, "stopped");
  assert.equal(final.lastError, null);
  assert.deepEqual(final.ledger, { totalOrders: 0 });
  const durable = JSON.parse(await fs.readFile(worker.statusFile, "utf8"));
  assert.equal(durable.lastError, null);
  assert.deepEqual(durable.ledger, { totalOrders: 0 });
});

test("the local sink only appends fsynced records and reports a local queued destination", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-shadow-sink-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "alerts.jsonl");
  const sink = createDurableLocalAlertSink(file, { now: () => Date.parse("2026-09-07T00:00:00.000Z") });
  const result = await sink.send({ telegramToken: "must-not-be-read" }, { type: "test", eventKey: "local:1" });
  assert.deepEqual(result, {
    status: "queued",
    destination: "local_fsynced_jsonl",
    eventKey: "local:1",
  });
  const rows = (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event.eventKey, "local:1");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await sink.stop();
  await assert.rejects(sink.send({}, { eventKey: "local:2" }), /stopped/u);
});

test("the local sink refuses to follow an existing output symlink", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-shadow-sink-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const protectedFile = path.join(root, "protected.jsonl");
  const outputFile = path.join(root, "alerts.jsonl");
  await fs.writeFile(protectedFile, "sentinel\n", { mode: 0o600 });
  await fs.symlink(protectedFile, outputFile);
  const sink = createDurableLocalAlertSink(outputFile);
  await assert.rejects(
    sink.append({ eventKey: "must-not-write" }),
    /symbolic link|ELOOP|too many levels/u,
  );
  assert.equal(await fs.readFile(protectedFile, "utf8"), "sentinel\n");
  await sink.stop();
});

test("the duration timer honors the recorded deadline after slow initialization", async (t) => {
  const { source, dataDir } = await fixture(t);
  let clock = Date.parse("2026-09-07T00:00:00.000Z");
  let timeoutDelay = null;
  const intervalHandles = [];
  const timers = {
    setInterval() {
      const handle = { unref() {} };
      intervalHandles.push(handle);
      return handle;
    },
    clearInterval() {},
    setTimeout(_callback, delay) {
      timeoutDelay = delay;
      return { unref() {} };
    },
    clearTimeout() {},
  };
  const worker = createNarrativeShadowSoak({
    dataDir,
    sourceFiles: [{ id: "main", file: source }],
    durationMs: LONG_MS,
    pollIntervalMs: LONG_MS,
    heartbeatIntervalMs: LONG_MS,
  }, {
    now: () => clock,
    timers,
    initialize: async () => {
      clock += 7_500;
      return { runtime: runtimeStub() };
    },
  });
  await worker.ready;
  const started = await worker.start();
  assert.equal(started.startedAt, "2026-09-07T00:00:00.000Z");
  assert.equal(started.deadlineAt, "2026-09-07T00:01:00.000Z");
  assert.equal(timeoutDelay, 52_500);
  assert.equal(intervalHandles.length, 2);
  await worker.stop("test_complete");
});

test("any admitted paper order is a fatal guard violation and preserves the lock for inspection", async (t) => {
  const { source, dataDir } = await fixture(t);
  let checked = false;
  const runtime = runtimeStub({
    check: async () => { checked = true; return { status: "healthy" }; },
    ledgerState: () => checked ? { orders: { forged: { status: "created" } } } : { orders: {} },
  });
  const worker = createWorker(dataDir, source, runtime);
  await worker.ready;
  const result = await worker.poll();
  assert.equal(result.status, "failed");
  await assert.rejects(worker.done, (error) => (
    error instanceof AggregateError
      && error.errors.some((entry) => /paper order/u.test(String(entry?.message || entry)))
  ));
  assert.equal(await fs.stat(worker.lockFile).then(() => true, () => false), true);
});

test("the production runner has no production config, outbox worker, Telegram, signer, or broadcast import", async () => {
  const runner = await fs.readFile(new URL("../scripts/narrative-shadow-soak.js", import.meta.url), "utf8");
  assert.doesNotMatch(runner, /from\s+["'][^"']*\/(?:index|fomo-worker|config|alerts)\.js["']/u);
  assert.doesNotMatch(runner, /\bstartAlertOutboxWorker\b|api\.telegram\.org|\bsendTransaction\b|\bbroadcastTransaction\b|\beth_send\w*\b|\bgetSigner\b|\bprivateKey\b|\bmnemonic\b/u);
  assert.match(runner, /telegramToken:\s*""/u);
  assert.match(runner, /telegramChatId:\s*""/u);
  assert.match(runner, /discoverCandidatesImpl:\s*async\s*\(\)\s*=>\s*\[\]/u);
  assert.match(runner, /ledger:\s*denyLedger/u);
  assert.match(runner, /qualifyCallImpl:\s*async\s*\(\)\s*=>/u);
  assert.match(runner, /NARRATIVE_SHADOW_SOAK_PRODUCTION_DATA_DIR/u);
  assert.match(runner, /sourceFiles\.map\(\(source\)\s*=>\s*path\.dirname\(source\.file\)\)/u);
  assert.match(runner, /ownedWriteDirectories:\s*\[/u);
});
