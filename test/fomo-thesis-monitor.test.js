import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createFomoThesisMonitor,
  parseFomoThesisPayload,
} from "../src/fomo-thesis-monitor.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const quietLogger = { error() {}, warn() {}, info() {}, log() {} };

function ok(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-thesis-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function officialRecord({ id, body, publishedAt, chain = 56, token = TOKEN, type = "thesis_created" }) {
  return {
    feedType: type,
    commentId: id,
    thesisExternalId: `external-${id}`,
    id: `generic-${id}`,
    comment: body,
    publishedAt,
    chainId: chain,
    token: { address: token, symbol: "CALL" },
    trader: { handle: "alpha", followers: 25_000 },
  };
}

test("parses official and relay thesis schemas with stable-id priority", () => {
  const publishedAt = "2026-08-11T02:00:00.000Z";
  const official = parseFomoThesisPayload({ data: { feed: [officialRecord({ id: "comment-1", body: "官方喊单正文", publishedAt })] } });
  assert.equal(official.length, 1);
  assert.equal(official[0].stableId, "external-comment-1");
  assert.equal(official[0].body, "官方喊单正文");
  assert.equal(official[0].publishedAt, publishedAt);
  assert.equal(official[0].chain, 56);
  assert.equal(official[0].source.trust, "official_authenticated_api");

  const relay = parseFomoThesisPayload({
    data: {
      trader: { handle: "relay_alpha" },
      thesis: {
        thesisExternalId: "relay-thesis-2",
        id: "generic-2",
        text: "Relay thesis body",
        created_at: publishedAt,
        chain: "bsc",
        token_address: TOKEN,
      },
    },
  }, { sourceKind: "relay" });
  assert.equal(relay.length, 1);
  assert.equal(relay[0].stableId, "relay-thesis-2");
  assert.equal(relay[0].body, "Relay thesis body");
  assert.equal(relay[0].handle, "relay_alpha");
  assert.equal(relay[0].source.trust, "verified_thesis_relay");

  const flatRelay = parseFomoThesisPayload({ theses: [{
    id: "flat-relay-id",
    thesis: "flat relay thesis",
    createdDate: publishedAt,
    chainId: 56,
    coinAddress: TOKEN,
  }] }, { sourceKind: "relay", handle: "flat_author" });
  assert.equal(flatRelay[0].stableId, "flat-relay-id");
  assert.equal(flatRelay[0].body, "flat relay thesis");
  assert.equal(flatRelay[0].handle, "flat_author");

  const documentedRelay = parseFomoThesisPayload({ items: [{
    thesisExternalId: "documented-relay-id",
    authorHandle: "documented_author",
    tokenSymbol: "DOC",
    tokenAddress: TOKEN,
    body: "documented relay shape",
  }] }, { sourceKind: "relay" });
  assert.equal(documentedRelay[0].stableId, "documented-relay-id");
  assert.equal(documentedRelay[0].handle, "documented_author");
  assert.equal(documentedRelay[0].symbol, "DOC");
});

test("rejects buy, sell, swap and manual activity before monitoring", () => {
  const rows = ["buy", "sell", "swap", "manual"].map((type, index) => ({
    type,
    commentId: `bad-${index}`,
    comment: "not a published thesis",
    publishedAt: "2026-08-11T02:00:00.000Z",
    chainId: 56,
    tokenAddress: TOKEN,
  }));
  rows.push({ type: "token_created", commentId: "also-bad", text: "not a thesis" });
  assert.deepEqual(parseFomoThesisPayload({ data: rows }), []);
});

test("first snapshot is a silent baseline and a later new thesis is delivered once", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-11T02:00:05.000Z");
  let rows = [officialRecord({ id: "baseline", body: "existing call", publishedAt: "2026-08-11T02:00:01.000Z" })];
  const alerts = [];
  const requests = [];
  const monitor = createFomoThesisMonitor({
    dataDir,
    fomoPublishedCallEnabled: true,
    fomoOfficialBearerToken: "official-secret",
    fomoThesisRelayToken: "",
    fomoPublishedCallMaxAgeMs: 300_000,
  }, {
    autoStart: false,
    now: () => current,
    logger: quietLogger,
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.authorization });
      return ok({ data: rows });
    },
    qualifyCallImpl: async () => ({ decision: "pass", security: { decision: "pass" }, market: { liquidityUsd: 25_000 } }),
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });

  await monitor.check();
  assert.equal(alerts.length, 0);
  assert.match(requests[0].url, /\/feed\?limit=50&feedTypes=thesis_created$/);
  assert.equal(requests[0].authorization, "Bearer official-secret");

  current += 2_000;
  rows = [...rows, officialRecord({ id: "new-call", body: "new thesis, not a wallet buy", publishedAt: new Date(current - 500).toISOString() })];
  await monitor.check();
  await monitor.check();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "fomo_family_top_call");
  assert.equal(alerts[0].signalKind, "fomo_published_call");
  assert.equal(alerts[0].qualified, true);
  assert.equal(alerts[0].strong, true);
  assert.equal(alerts[0].caller.followers, 25_000);
  assert.equal(alerts[0].stableId, "external-new-call");
  assert.equal(alerts[0].body, "new thesis, not a wallet buy");
  assert.equal(alerts[0].source.id, "fomo_family_official_thesis");
  assert.equal(alerts[0].source.trust, "official_authenticated_api");
});

test("retryable thesis alert suppression preserves pending state while terminal suppression is consumed", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-11T02:30:05.000Z");
  let rows = [officialRecord({ id: "baseline", body: "existing call", publishedAt: "2026-08-11T02:30:01.000Z" })];
  const alerts = [];
  let delivery = { status: "suppressed", disposition: "retry", terminal: false };
  const monitor = createFomoThesisMonitor({
    dataDir,
    fomoPublishedCallEnabled: true,
    fomoOfficialBearerToken: "token",
    fomoPublishedCallMaxAgeMs: 300_000,
  }, {
    autoStart: false,
    now: () => current,
    logger: quietLogger,
    fetchImpl: async () => ok({ data: rows }),
    qualifyCallImpl: async () => ({ decision: "pass" }),
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return delivery; },
  });
  await monitor.check();

  current += 2_000;
  rows = [...rows, officialRecord({ id: "retry", body: "retry delivery", publishedAt: new Date(current - 500).toISOString() })];
  assert.equal((await monitor.check()).status, "degraded");
  let state = await monitor.getState();
  const retryKey = "fomo_family_official_thesis:external-retry";
  assert.ok(state.pending[retryKey]);
  assert.equal(state.seen[retryKey], undefined);

  delivery = { status: "delivered" };
  current += 2_000;
  assert.equal((await monitor.check()).status, "healthy");
  state = await monitor.getState();
  assert.equal(state.pending[retryKey], undefined);
  assert.ok(state.seen[retryKey]);

  delivery = { status: "suppressed", disposition: "terminal", terminal: true, reason: "not_relevant" };
  current += 2_000;
  rows = [...rows, officialRecord({ id: "terminal", body: "terminal suppression", publishedAt: new Date(current - 500).toISOString() })];
  assert.equal((await monitor.check()).status, "healthy");
  state = await monitor.getState();
  const terminalKey = "fomo_family_official_thesis:external-terminal";
  assert.equal(state.pending[terminalKey], undefined);
  assert.ok(state.seen[terminalKey]);
  assert.equal(alerts.length, 3);
});

test("persisted ids are not replayed after restart", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-11T03:00:05.000Z");
  let rows = [officialRecord({ id: "baseline", body: "old", publishedAt: "2026-08-11T03:00:01.000Z" })];
  const common = {
    autoStart: false,
    now: () => current,
    logger: quietLogger,
    fetchImpl: async () => ok({ items: rows }),
    qualifyCallImpl: async () => ({ decision: "pass" }),
  };
  const config = { dataDir, fomoPublishedCallEnabled: true, fomoOfficialBearerToken: "token" };
  const firstAlerts = [];
  const first = createFomoThesisMonitor(config, {
    ...common,
    sendAlertsImpl: async (_config, event) => { firstAlerts.push(event); return { status: "delivered" }; },
  });
  await first.check();
  current += 2_000;
  rows = [...rows, officialRecord({ id: "once", body: "only once", publishedAt: new Date(current - 500).toISOString() })];
  await first.check();
  assert.equal(firstAlerts.length, 1);

  const restartedAlerts = [];
  const restarted = createFomoThesisMonitor(config, {
    ...common,
    sendAlertsImpl: async (_config, event) => { restartedAlerts.push(event); return { status: "delivered" }; },
  });
  await restarted.check();
  assert.equal(restartedAlerts.length, 0);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-thesis-state.json"), "utf8"));
  assert.ok(state.seen["fomo_family_official_thesis:external-once"]);
});

test("a newly observed thesis without a source timestamp is delivered using first-observed time", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-11T03:30:05.000Z");
  let rows = [{ ...officialRecord({ id: "baseline-no-time", body: "old", publishedAt: null }), publishedAt: undefined }];
  const alerts = [];
  const monitor = createFomoThesisMonitor({
    dataDir,
    fomoPublishedCallEnabled: true,
    fomoOfficialBearerToken: "token",
    fomoPublishedCallMaxAgeMs: 120_000,
  }, {
    autoStart: false,
    now: () => current,
    logger: quietLogger,
    fetchImpl: async () => ok({ data: rows }),
    qualifyCallImpl: async (call) => ({ decision: "pass", caller: call.caller }),
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });

  await monitor.check();
  current += 5_000;
  rows = [...rows, { ...rows[0], commentId: "new-no-time", thesisExternalId: "external-new-no-time", comment: "live thesis without time" }];
  await monitor.check();

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].stableId, "external-new-no-time");
  assert.equal(alerts[0].publishedAtEstimated, true);
  assert.equal(alerts[0].publishedAt, new Date(current).toISOString());
});

test("temporary qualification failure is retried inside the freshness window", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-11T03:45:05.000Z");
  let rows = [officialRecord({ id: "baseline-retry", body: "old", publishedAt: new Date(current - 1_000).toISOString() })];
  let attempts = 0;
  const alerts = [];
  const monitor = createFomoThesisMonitor({
    dataDir,
    fomoPublishedCallEnabled: true,
    fomoOfficialBearerToken: "token",
    fomoPublishedCallMaxAgeMs: 120_000,
  }, {
    autoStart: false,
    now: () => current,
    logger: quietLogger,
    fetchImpl: async () => ok({ data: rows }),
    qualifyCallImpl: async (call) => {
      attempts += 1;
      return attempts === 1 ? { decision: "block", reason: "temporary_upstream_error" } : { decision: "pass", caller: call.caller };
    },
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });

  await monitor.check();
  current += 2_000;
  rows = [...rows, officialRecord({ id: "retry-me", body: "retry this thesis", publishedAt: new Date(current - 500).toISOString() })];
  await monitor.check();
  assert.equal(alerts.length, 0);
  current += 2_000;
  await monitor.check();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].stableId, "external-retry-me");
});

test("BSC-only mode accepts resolver-confirmed records without a chain claim", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-11T04:00:05.000Z");
  let rows = [{
    feedType: "thesis_created",
    commentId: "base",
    comment: "baseline",
    publishedAt: "2026-08-11T04:00:01.000Z",
    tokenAddress: TOKEN,
  }];
  const alerts = [];
  const monitor = createFomoThesisMonitor({ dataDir, fomoPublishedCallEnabled: true, fomoOfficialBearerToken: "token" }, {
    autoStart: false,
    now: () => current,
    logger: quietLogger,
    fetchImpl: async () => ok({ data: rows }),
    resolveCallImpl: async () => ({ chainId: 56 }),
    qualifyCallImpl: async () => ({ decision: "pass" }),
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });
  await monitor.check();
  current += 2_000;
  rows = [...rows, { ...rows[0], commentId: "resolved", comment: "resolved BSC call", publishedAt: new Date(current - 500).toISOString() }];
  await monitor.check();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].chain.id, 56);
});

test("missing credentials writes blocked health and never sends", async (t) => {
  const dataDir = await fixture(t);
  const alerts = [];
  const monitor = createFomoThesisMonitor({ dataDir, fomoPublishedCallEnabled: true }, {
    autoStart: false,
    logger: quietLogger,
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });
  const result = await monitor.check();
  assert.equal(result.status, "blocked_missing_credentials");
  assert.equal(alerts.length, 0);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "fomo-thesis-state.json"), "utf8"));
  assert.equal(state.health.status, "blocked_missing_credentials");
  assert.equal(state.health.sources.official.status, "blocked_missing_credentials");
  assert.equal(state.health.sources.relay.status, "blocked_missing_credentials");
});

test("loading credentials after a blocked worker silently baselines old calls before live delivery", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-11T04:30:05.000Z");
  const blocked = createFomoThesisMonitor({ dataDir, fomoPublishedCallEnabled: true }, {
    autoStart: false,
    now: () => current,
    logger: quietLogger,
    sendAlertsImpl: async () => { throw new Error("a blocked worker must not send"); },
  });
  assert.equal((await blocked.check()).status, "blocked_missing_credentials");

  let rows = [officialRecord({
    id: "before-credentials",
    body: "existing call present before credentials were loaded",
    publishedAt: new Date(current - 1_000).toISOString(),
  })];
  const alerts = [];
  const loaded = createFomoThesisMonitor({
    dataDir,
    fomoPublishedCallEnabled: true,
    fomoOfficialBearerToken: "newly-loaded-token",
    fomoPublishedCallMaxAgeMs: 120_000,
  }, {
    autoStart: false,
    now: () => current,
    logger: quietLogger,
    fetchImpl: async () => ok({ data: rows }),
    qualifyCallImpl: async () => ({ decision: "pass" }),
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });

  assert.equal((await loaded.check()).status, "healthy");
  assert.equal(alerts.length, 0, "the first authenticated snapshot is a baseline even when its rows are fresh");
  let state = await loaded.getState();
  assert.equal(state.initialized.official, true);
  assert.ok(state.seen["fomo_family_official_thesis:external-before-credentials"]);

  current += 2_000;
  rows = [...rows, officialRecord({
    id: "after-credentials",
    body: "first genuinely new live call",
    publishedAt: new Date(current - 500).toISOString(),
  })];
  await loaded.check();
  assert.deepEqual(alerts.map(({ stableId }) => stableId), ["external-after-credentials"]);
  state = await loaded.getState();
  assert.equal(state.health.status, "healthy");
  assert.equal(state.health.sources.official.status, "healthy");
  assert.equal(state.health.sources.relay.status, "blocked_missing_credentials");
});

test("overall Fomo thesis health is degraded when any configured source fails", async (t) => {
  const dataDir = await fixture(t);
  const monitor = createFomoThesisMonitor({
    dataDir,
    fomoPublishedCallEnabled: true,
    fomoOfficialBearerToken: "official-token",
    fomoThesisRelayToken: "relay-token",
    fomoCallPublicHandles: ["alpha"],
    fomoThesisRelayWebSocketEnabled: false,
  }, {
    autoStart: false,
    logger: quietLogger,
    fetchImpl: async (url) => {
      if (String(url).includes("/feed?")) return ok({ data: [] });
      return { ok: false, status: 503, json: async () => ({}) };
    },
    sendAlertsImpl: async () => { throw new Error("a baseline must not send"); },
  });

  assert.equal((await monitor.check()).status, "degraded");
  const state = await monitor.getState();
  assert.equal(state.health.sources.official.status, "healthy");
  assert.equal(state.health.sources.relay.status, "degraded");
  assert.equal(state.health.sources["relay:alpha"].status, "error");
});

test("relay websocket authenticates with token subprotocol and only trusts ready subscribeOk true", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-11T05:00:05.000Z");
  const alerts = [];
  class FakeWebSocket {
    static instances = [];
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
    }
    on(type, listener) { this.listeners.set(type, listener); }
    emit(type, value) { this.listeners.get(type)?.(value); }
    close() { this.emit("close"); }
  }
  const baseline = {
    type: "thesis",
    thesisExternalId: "relay-baseline",
    text: "existing relay thesis",
    createdAt: "2026-08-11T05:00:01.000Z",
    chain: "bsc",
    tokenAddress: TOKEN,
    trader: { handle: "alpha", followers: 50_000 },
  };
  const monitor = createFomoThesisMonitor({
    dataDir,
    fomoPublishedCallEnabled: true,
    fomoThesisRelayToken: "relay-secret",
    fomoCallPublicHandles: ["alpha"],
    fomoThesisRelayWebSocketEnabled: true,
  }, {
    autoStart: false,
    WebSocketImpl: FakeWebSocket,
    now: () => current,
    logger: quietLogger,
    fetchImpl: async () => ok({ data: [baseline] }),
    qualifyCallImpl: async (call) => ({ decision: "pass", caller: call.caller }),
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "delivered" }; },
  });
  t.after(() => monitor.stop());
  await monitor.start();
  const socket = FakeWebSocket.instances[0];
  assert.deepEqual(socket.protocols, ["relay-secret"]);
  assert.match(socket.url, /^wss:\/\//);

  socket.emit("message", JSON.stringify({ type: "ready", subscribeOk: false }));
  let state = await monitor.getState();
  assert.equal(state.health.sources["relay-ws:alpha"].status, "subscription_rejected");
  assert.equal(state.health.sources["relay-ws:alpha"].subscribeOk, false);

  const rejectedLive = { ...baseline, thesisExternalId: "must-not-pass-before-ready", text: "untrusted live frame", createdAt: new Date(current).toISOString() };
  socket.emit("message", JSON.stringify({ type: "thesis", data: rejectedLive }));
  await monitor.getState();
  assert.equal(alerts.length, 0);

  socket.emit("message", JSON.stringify({ type: "ready", subscribeOk: true }));
  state = await monitor.getState();
  assert.equal(state.health.sources["relay-ws:alpha"].status, "healthy");
  assert.equal(state.health.sources["relay-ws:alpha"].subscribeOk, true);

  current += 2_000;
  const snapshot = { ...baseline, thesisExternalId: "snapshot-only", text: "snapshot must not replay", createdAt: new Date(current - 500).toISOString() };
  socket.emit("message", JSON.stringify({ type: "snapshot", data: [snapshot] }));
  await monitor.getState();
  socket.emit("message", JSON.stringify({ type: "thesis", data: snapshot }));
  await monitor.getState();
  assert.equal(alerts.length, 0);

  current += 2_000;
  const live = { ...snapshot, thesisExternalId: "live-thesis", text: "new live thesis", createdAt: new Date(current - 500).toISOString() };
  socket.emit("message", JSON.stringify({ type: "thesis", data: live }));
  await monitor.getState();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].stableId, "live-thesis");
  assert.equal(alerts[0].source.url, "https://api.fomoscan.sh");
});
