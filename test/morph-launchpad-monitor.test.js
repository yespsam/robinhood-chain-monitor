import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Interface, id } from "ethers";
import {
  MORPH_CHAIN_ID,
  MORPH_EIP1967_UPGRADED_TOPIC,
  MORPH_FLAP_PORTAL,
  MORPH_FLAP_TOKEN_CREATED_TOPIC,
  createAbortableJsonRpcProvider,
  createMorphLaunchpadMonitor,
  mapWithConcurrency,
  parseMorphFlapCreation,
} from "../src/morph-launchpad-monitor.js";

const IMPLEMENTATION_A = "0x1111111111111111111111111111111111111111";
const IMPLEMENTATION_B = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const CREATOR = "0x4444444444444444444444444444444444444444";
const BASELINE_BLOCK = 1_150_800;
const EVENT_BLOCK = BASELINE_BLOCK + 1;
const BASELINE_BLOCK_HEX = `0x${BASELINE_BLOCK.toString(16)}`;
const EVENT_BLOCK_HEX = `0x${EVENT_BLOCK.toString(16)}`;
const BLOCK_HASH_99 = `0x${"99".repeat(32)}`;
const BLOCK_HASH_100 = `0x${"10".repeat(32)}`;
const BLOCK_HASH_REORG_EMPTY = `0x${"20".repeat(32)}`;
const BLOCK_HASH_REPLAY = `0x${"30".repeat(32)}`;
const TX_HASH = `0x${"ab".repeat(32)}`;

const iface = new Interface([
  "event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)",
  "event TokenVersionSet(address token,uint8 version)",
  "event TokenQuoteSet(address token,address quoteToken)",
  "event TokenCurveSetV2(address token,uint256 r,uint256 h,uint256 k)",
  "event TokenDexSupplyThreshSet(address token,uint256 dexSupplyThresh)",
  "function version() view returns (string)",
]);

const storageFor = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const response = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

function baselineFetch() {
  return async (url) => {
    const value = String(url);
    if (value.endsWith("/api/v2/main-page/indexing-status")) return response({ finished_indexing_blocks: true });
    if (value.endsWith("/api/v2/stats")) return response({ total_blocks: BASELINE_BLOCK });
    if (value.includes("module=logs")) return response({ message: "No logs found", result: [] });
    throw new Error(`unexpected fetch ${value}`);
  };
}

function creationEvidence({ implementation = IMPLEMENTATION_B, version = 2, quote = null, curveV2 = null, dexSupplyThreshold = null, includeUpgrade = false, blockHash = BLOCK_HASH_100 } = {}) {
  const created = iface.encodeEventLog(iface.getEvent("TokenCreated"), [1_700_000_000, CREATOR, 7, TOKEN, "First", "FIRST", "bafy-meta"]);
  const versionSet = iface.encodeEventLog(iface.getEvent("TokenVersionSet"), [TOKEN, version]);
  const logs = [];
  let upgradeLog = null;
  if (includeUpgrade) {
    upgradeLog = {
      address: MORPH_FLAP_PORTAL,
      topics: [MORPH_EIP1967_UPGRADED_TOPIC, storageFor(implementation)],
      data: "0x",
      blockNumber: EVENT_BLOCK_HEX,
      blockHash,
      transactionHash: TX_HASH,
      transactionIndex: "0x0",
      logIndex: "0x0",
    };
    logs.push(upgradeLog);
  }
  const creationLog = {
      address: MORPH_FLAP_PORTAL,
      topics: created.topics,
      data: created.data,
      blockNumber: EVENT_BLOCK_HEX,
      blockHash,
      transactionHash: TX_HASH,
      transactionIndex: "0x0",
      logIndex: includeUpgrade ? "0x1" : "0x0",
    };
  logs.push(creationLog, {
      address: MORPH_FLAP_PORTAL,
      topics: versionSet.topics,
      data: versionSet.data,
      blockNumber: EVENT_BLOCK_HEX,
      blockHash,
      transactionHash: TX_HASH,
      transactionIndex: "0x0",
      logIndex: includeUpgrade ? "0x2" : "0x1",
    });
  if (quote) {
    const quoteSet = iface.encodeEventLog(iface.getEvent("TokenQuoteSet"), [TOKEN, quote]);
    logs.push({
      address: MORPH_FLAP_PORTAL,
      topics: quoteSet.topics,
      data: quoteSet.data,
      blockNumber: EVENT_BLOCK_HEX,
      blockHash,
      transactionHash: TX_HASH,
      transactionIndex: "0x0",
      logIndex: includeUpgrade ? "0x3" : "0x2",
    });
  }
  if (curveV2) {
    const curveSet = iface.encodeEventLog(iface.getEvent("TokenCurveSetV2"), [TOKEN, curveV2.r, curveV2.h, curveV2.k]);
    logs.push({
      address: MORPH_FLAP_PORTAL,
      topics: curveSet.topics,
      data: curveSet.data,
      blockNumber: EVENT_BLOCK_HEX,
      blockHash,
      transactionHash: TX_HASH,
      transactionIndex: "0x0",
      logIndex: `0x${logs.length.toString(16)}`,
    });
  }
  if (dexSupplyThreshold != null) {
    const thresholdSet = iface.encodeEventLog(iface.getEvent("TokenDexSupplyThreshSet"), [TOKEN, dexSupplyThreshold]);
    logs.push({
      address: MORPH_FLAP_PORTAL,
      topics: thresholdSet.topics,
      data: thresholdSet.data,
      blockNumber: EVENT_BLOCK_HEX,
      blockHash,
      transactionHash: TX_HASH,
      transactionIndex: "0x0",
      logIndex: `0x${logs.length.toString(16)}`,
    });
  }
  const receipt = {
    status: "0x1",
    blockNumber: EVENT_BLOCK_HEX,
    blockHash,
    transactionHash: TX_HASH,
    logs,
  };
  const transaction = {
    hash: TX_HASH,
    blockNumber: EVENT_BLOCK_HEX,
    blockHash,
    to: MORPH_FLAP_PORTAL,
    input: `${id("newTokenNoDuel(string,string,string)").slice(0, 10)}${"0".repeat(64)}`,
  };
  return { log: creationLog, upgradeLog, queryLogs: logs.filter((entry) => [MORPH_FLAP_TOKEN_CREATED_TOPIC, MORPH_EIP1967_UPGRADED_TOPIC].includes(entry.topics[0].toLowerCase())), receipt, transaction, implementation };
}

class FakeProvider {
  constructor() {
    this.chainId = MORPH_CHAIN_ID;
    this.head = EVENT_BLOCK;
    this.implementation = IMPLEMENTATION_A;
    this.creation = null;
    this.eventBlockHash = BLOCK_HASH_100;
  }

  async send(method, params) {
    if (method === "eth_chainId") return `0x${this.chainId.toString(16)}`;
    if (method === "eth_blockNumber") return `0x${this.head.toString(16)}`;
    if (method === "eth_getCode") return "0x6001600055";
    if (method === "eth_getStorageAt") return storageFor(this.implementation);
    if (method === "eth_call") return iface.encodeFunctionResult("version", [this.implementation === IMPLEMENTATION_A ? "v1" : "v2"]);
    if (method === "eth_getLogs") {
      const from = Number(BigInt(params[0].fromBlock));
      const to = Number(BigInt(params[0].toBlock));
      if (!this.creation || from > EVENT_BLOCK || to < EVENT_BLOCK) return [];
      const topicFilter = params[0].topics?.[0];
      const accepted = new Set((Array.isArray(topicFilter) ? topicFilter : [topicFilter]).filter(Boolean).map((value) => String(value).toLowerCase()));
      return this.creation.queryLogs.filter((entry) => accepted.has(String(entry.topics[0]).toLowerCase()));
    }
    if (method === "eth_getTransactionReceipt") return this.creation?.receipt || null;
    if (method === "eth_getTransactionByHash") return this.creation?.transaction || null;
    if (method === "eth_getBlockByNumber") {
      const number = Number(BigInt(params[0]));
      return {
        number: params[0],
        hash: number === EVENT_BLOCK ? this.eventBlockHash : BLOCK_HASH_99,
        timestamp: number === EVENT_BLOCK ? "0x6553f100" : "0x6553f0ff",
      };
    }
    throw new Error(`unexpected RPC ${method}`);
  }
}

async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "morph-monitor-test-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = overrides.provider || new FakeProvider();
  const events = [];
  const monitor = createMorphLaunchpadMonitor({
    dataDir,
    morphMonitorEnabled: true,
    morphConfirmations: 1,
    morphLogBatchSize: 2_000,
    morphMaxCatchupBlocks: 5_000,
    morphExplorerApiUrl: "https://explorer.test",
  }, {
    provider,
    autoStart: false,
    disableWebSocket: true,
    fetchImpl: overrides.fetchImpl || baselineFetch(),
    sendAlertsImpl: overrides.sendAlertsImpl || (async (_config, event) => {
      events.push(event);
      return { status: "delivered", eventId: event.eventKey };
    }),
    assessSecurityImpl: overrides.assessSecurityImpl || (async () => ({
      decision: "block",
      reasons: ["检测到 EIP-1167 最小代理", "池子实际流动性未确认"],
      metrics: { liquidityConfirmed: false },
      source: "test",
    })),
    logger: { info() {}, error() {} },
  });
  t.after(() => monitor.stop());
  return { dataDir, provider, events, monitor };
}

test("abortable JSON-RPC timeout closes the underlying HTTP exchange", async (t) => {
  let activeRequests = 0;
  let releasedRequests = 0;
  const server = http.createServer((request) => {
    activeRequests += 1;
    request.once("close", () => {
      activeRequests -= 1;
      releasedRequests += 1;
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const provider = createAbortableJsonRpcProvider(`http://127.0.0.1:${address.port}`, MORPH_CHAIN_ID, {
    requestTimeoutMs: 75,
    batchMaxCount: 1,
  });
  t.after(() => provider.destroy());

  await assert.rejects(provider.send("eth_chainId", []), /timed out|timeout/i);
  const cleanupDeadline = Date.now() + 2_000;
  while (releasedRequests === 0 && Date.now() < cleanupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(activeRequests, 0);
  assert.equal(releasedRequests, 1, "timeout must abort the socket-backed fetch, not only its promise");
});

test("transaction evidence helper preserves order with six-way bounded concurrency", async () => {
  let active = 0;
  let maximumActive = 0;
  const values = Array.from({ length: 18 }, (_, index) => index);
  const results = await mapWithConcurrency(values, 6, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, values.map((value) => value * 2));
  assert.equal(maximumActive, 6);
});

test("bounded transaction evidence waits for active reads before surfacing a failure", async () => {
  let active = 0;
  const started = [];
  await assert.rejects(mapWithConcurrency(Array.from({ length: 20 }, (_, index) => index), 6, async (value) => {
    active += 1;
    started.push(value);
    try {
      if (value === 0) throw new Error("RPC failed");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return value;
    } finally {
      active -= 1;
    }
  }), /RPC failed/);
  assert.equal(active, 0, "a retry must not overlap workers left behind by the failed batch");
  assert.ok(started.length <= 6, "no new evidence reads should start after the first failure");
});

test("Morph shutdown drains active durability work before bounded WebSocket termination", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "morph-shutdown-test-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const provider = new FakeProvider();
  const originalSend = provider.send.bind(provider);
  let blockNextRead = false;
  let releaseRead;
  let readStartedResolve;
  provider.send = async (...args) => {
    if (blockNextRead) {
      blockNextRead = false;
      readStartedResolve();
      await new Promise((resolve) => { releaseRead = resolve; });
    }
    return originalSend(...args);
  };

  const sockets = [];
  class SilentCloseWebSocket extends EventEmitter {
    static CLOSED = 3;
    constructor() {
      super();
      this.readyState = 1;
      this.closeCalls = 0;
      this.terminateCalls = 0;
      this.sendCalls = 0;
      sockets.push(this);
    }
    send() { this.sendCalls += 1; }
    close() { this.closeCalls += 1; }
    terminate() {
      this.terminateCalls += 1;
      this.readyState = SilentCloseWebSocket.CLOSED;
    }
  }
  const scheduled = [];
  const setTimeoutImpl = (callback, delayMs) => {
    const handle = { callback, delayMs, cleared: false, unref() {} };
    scheduled.push(handle);
    return handle;
  };
  const clearTimeoutImpl = (handle) => {
    if (handle) handle.cleared = true;
  };
  const monitor = createMorphLaunchpadMonitor({
    dataDir,
    morphMonitorEnabled: true,
    morphWsUrl: "wss://morph.test",
    morphConfirmations: 1,
    morphLogBatchSize: 2_000,
    morphMaxCatchupBlocks: 5_000,
    morphExplorerApiUrl: "https://explorer.test",
  }, {
    provider,
    autoStart: false,
    WebSocketImpl: SilentCloseWebSocket,
    setTimeoutImpl,
    clearTimeoutImpl,
    websocketShutdownGraceMs: 75,
    fetchImpl: baselineFetch(),
    sendAlertsImpl: async () => ({ status: "delivered" }),
    assessSecurityImpl: async () => ({ decision: "block", reasons: [], metrics: {}, source: "test" }),
    logger: { info() {}, error() {} },
  });
  t.after(() => monitor.stop());

  await monitor.start();
  await monitor.awaitIdle();
  assert.equal(sockets.length, 1);

  blockNextRead = true;
  const readStarted = new Promise((resolve) => { readStartedResolve = resolve; });
  const activeScan = monitor.scan();
  await readStarted;
  const stopping = monitor.stop();
  await Promise.resolve();
  assert.equal(sockets[0].closeCalls, 0, "the socket must remain untouched until active durable work drains");
  assert.equal(scheduled.length, 0);

  releaseRead();
  await activeScan;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets[0].closeCalls, 1);
  assert.equal(sockets[0].terminateCalls, 0);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 75);

  scheduled[0].callback();
  await stopping;
  assert.equal(sockets[0].terminateCalls, 1, "a silent peer must be forcibly released at the bounded deadline");
  assert.equal(scheduled[0].cleared, true);

  sockets[0].emit("open");
  sockets[0].emit("message", JSON.stringify({ method: "eth_subscription" }));
  sockets[0].emit("close");
  await Promise.resolve();
  assert.equal(sockets[0].sendCalls, 0, "late socket events must be inert after shutdown");
  assert.equal(sockets.length, 1, "a late close must not resurrect the reconnect loop");
  assert.equal(scheduled.length, 1, "a late close must not schedule a reconnect timer");
});

test("Morph shutdown accepts a peer close within grace without terminating the socket", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "morph-graceful-close-test-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const sockets = [];
  class GracefulCloseWebSocket extends EventEmitter {
    static CLOSED = 3;
    constructor() {
      super();
      this.readyState = 1;
      this.closeCalls = 0;
      this.terminateCalls = 0;
      sockets.push(this);
    }
    send() {}
    close() {
      this.closeCalls += 1;
      this.readyState = GracefulCloseWebSocket.CLOSED;
      this.emit("close");
    }
    terminate() { this.terminateCalls += 1; }
  }
  const scheduled = [];
  const monitor = createMorphLaunchpadMonitor({
    dataDir,
    morphMonitorEnabled: true,
    morphWsUrl: "wss://morph.test",
    morphConfirmations: 1,
    morphLogBatchSize: 2_000,
    morphMaxCatchupBlocks: 5_000,
    morphExplorerApiUrl: "https://explorer.test",
  }, {
    provider: new FakeProvider(),
    autoStart: false,
    WebSocketImpl: GracefulCloseWebSocket,
    setTimeoutImpl: (callback, delayMs) => {
      const handle = { callback, delayMs, cleared: false, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => { if (handle) handle.cleared = true; },
    websocketShutdownGraceMs: 75,
    fetchImpl: baselineFetch(),
    sendAlertsImpl: async () => ({ status: "delivered" }),
    assessSecurityImpl: async () => ({ decision: "block", reasons: [], metrics: {}, source: "test" }),
    logger: { info() {}, error() {} },
  });

  await monitor.start();
  await monitor.awaitIdle();
  await monitor.stop();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closeCalls, 1);
  assert.equal(sockets[0].terminateCalls, 0);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].cleared, true, "the forced-close deadline must be cancelled after a peer close");
});

test("Morph Flap decoder binds TokenCreated to the exact official Portal receipt", () => {
  const evidence = creationEvidence({
    quote: "0x5555555555555555555555555555555555555555",
    curveV2: { r: 5n, h: 0n, k: 50n },
    dexSupplyThreshold: 800n,
  });
  const parsed = parseMorphFlapCreation(evidence.receipt, evidence.transaction, evidence.implementation);
  assert.equal(parsed.token, TOKEN);
  assert.equal(parsed.name, "First");
  assert.equal(parsed.mode.tokenVersion, 2);
  assert.equal(parsed.mode.quoteToken, "0x5555555555555555555555555555555555555555");
  assert.deepEqual(parsed.mode.curveV2, { r: "5", h: "0", k: "50" });
  assert.equal(parsed.mode.dexSupplyThreshold, "800");
  assert.equal(parsed.features.some((feature) => feature.startsWith("curve-v2-profile:")), true);
  assert.equal(parsed.features.some((feature) => feature.startsWith("dex-supply-threshold:")), false);
  assert.equal(parsed.features.includes("quote:0x5555555555555555555555555555555555555555"), true);
  assert.equal(evidence.log.topics[0], MORPH_FLAP_TOKEN_CREATED_TOPIC);

  const copied = structuredClone(evidence.receipt);
  copied.logs[0].address = TOKEN;
  assert.equal(parseMorphFlapCreation(copied, evidence.transaction, evidence.implementation), null);

  const wrapped = parseMorphFlapCreation(evidence.receipt, { ...evidence.transaction, to: TOKEN, input: "0xdeadbeef" }, evidence.implementation);
  assert.equal(wrapped.mode.entrySelector, null);
  assert.equal(wrapped.features.some((feature) => feature.startsWith("entry-selector:")), false);
});

test("first startup creates a quiet Morph baseline and advances a durable cursor", async (t) => {
  const { monitor, events } = await fixture(t);
  await monitor.scan();
  const state = await monitor.getState();
  assert.equal(state.baselineComplete, true);
  assert.equal(state.cursor, EVENT_BLOCK);
  assert.equal(state.portal.implementation, IMPLEMENTATION_A);
  assert.equal(state.portal.protocolVersion, "v1");
  assert.equal(events.length, 0);
});

test("wrong-chain RPC fails closed without committing a Morph baseline", async (t) => {
  const provider = new FakeProvider();
  provider.chainId = 56;
  const { monitor } = await fixture(t, { provider });
  await assert.rejects(monitor.scan(), /chain ID 56/);
  const state = await monitor.getState();
  assert.equal(state.baselineComplete, false);
  assert.equal(state.cursor, null);
});

test("a durable cursor beyond the RPC head fails closed instead of becoming permanently healthy", async (t) => {
  const { dataDir, provider, monitor } = await fixture(t);
  await monitor.scan();
  await monitor.stop();

  const stateFile = path.join(dataDir, "morph-launchpad-state.json");
  const persisted = JSON.parse(await fs.readFile(stateFile, "utf8"));
  persisted.lastScannedBlock = provider.head + 10_000;
  persisted.cursor = persisted.lastScannedBlock + 1;
  persisted.lastScannedBlockHash = BLOCK_HASH_99;
  persisted.health.status = "healthy";
  persisted.health.headBlock = provider.head;
  persisted.health.safeBlock = provider.head - 1;
  persisted.health.lagBlocks = 0;
  await fs.writeFile(stateFile, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

  const restarted = createMorphLaunchpadMonitor({
    dataDir,
    morphMonitorEnabled: true,
    morphConfirmations: 1,
    morphLogBatchSize: 2_000,
    morphMaxCatchupBlocks: 5_000,
    morphExplorerApiUrl: "https://explorer.test",
  }, {
    provider,
    autoStart: false,
    disableWebSocket: true,
    fetchImpl: baselineFetch(),
    sendAlertsImpl: async () => ({ status: "delivered" }),
    assessSecurityImpl: async () => ({ decision: "block", reasons: [], metrics: {}, source: "test" }),
    logger: { info() {}, error() {} },
  });
  t.after(() => restarted.stop());

  await assert.rejects(restarted.scan(), /ahead of RPC head/);
  const failed = await restarted.getState();
  assert.equal(failed.health.status, "degraded");
  assert.match(failed.health.lastError, /ahead of RPC head/);
  assert.equal(failed.cursor, persisted.cursor, "the invalid future cursor must not be advanced or silently rewound");
  assert.equal(failed.lastScannedBlock, persisted.lastScannedBlock);
});

test("Portal upgrade alerts immediately and its first token alerts exactly once", async (t) => {
  const { monitor, provider, events } = await fixture(t);
  await monitor.scan();
  provider.implementation = IMPLEMENTATION_B;
  provider.creation = creationEvidence({ includeUpgrade: true });
  provider.head = EVENT_BLOCK + 1;
  await monitor.scan();
  await monitor.scan();

  assert.deepEqual(events.map((event) => event.kind), ["portal_upgrade", "new_mode"]);
  assert.equal(events[1].tokens[0].token, TOKEN);
  assert.equal(events[1].featureFirstToken, true);
  assert.equal(events[1].security.decision, "block", "risk is shown but never converted into a buy claim");
  const state = await monitor.getState();
  assert.ok(state.portal.pendingUpgrade.firstTokenAlertedAt);
  assert.equal(Object.keys(state.seenTransactions).length, 1);
});

test("a reorg rolls back an upgrade first-token milestone and permits canonical replay of the same event keys", async (t) => {
  const { monitor, provider, events } = await fixture(t);
  await monitor.scan();

  provider.implementation = IMPLEMENTATION_B;
  provider.creation = creationEvidence({ includeUpgrade: true, version: 9 });
  provider.head = EVENT_BLOCK + 1;
  await monitor.scan();

  let state = await monitor.getState();
  const orphanedEventKeys = events.map((event) => event.eventKey);
  assert.deepEqual(events.map((event) => event.kind), ["portal_upgrade", "new_mode"]);
  assert.equal(state.portal.implementation, IMPLEMENTATION_B);
  assert.ok(state.portal.pendingUpgrade?.firstTokenAlertedAt);
  assert.equal(state.knownFeatures.includes("token-version:9"), true);
  assert.equal(state.featureOrigins["token-version:9"], EVENT_BLOCK);
  assert.equal(state.upgradeHistory.length, 1);
  assert.equal(Object.keys(state.seenTransactions).length, 1);
  assert.deepEqual(new Set(state.alertedKeys), new Set(orphanedEventKeys));
  assert.deepEqual(Object.keys(state.alertOrigins).sort(), orphanedEventKeys.slice().sort());

  // The old block disappears and the proxy points back to its pre-upgrade
  // implementation. This scan must remove every state marker derived from the
  // orphaned block, rather than merely rewinding the log cursor.
  provider.eventBlockHash = BLOCK_HASH_REORG_EMPTY;
  provider.implementation = IMPLEMENTATION_A;
  provider.creation = null;
  await monitor.scan();

  state = await monitor.getState();
  assert.equal(state.portal.implementation, IMPLEMENTATION_A);
  assert.equal(state.portal.pendingUpgrade, null);
  assert.equal(state.knownFeatures.includes("token-version:9"), false);
  assert.equal(state.featureOrigins["token-version:9"], undefined);
  assert.equal(Object.values(state.pendingFeatures).some((feature) => Number(feature?.firstSeenBlock || 0) === EVENT_BLOCK), false);
  assert.equal(state.upgradeHistory.length, 0);
  assert.equal(Object.keys(state.seenTransactions).length, 0);
  assert.equal(orphanedEventKeys.some((eventKey) => state.alertedKeys.includes(eventKey)), false);
  assert.equal(orphanedEventKeys.some((eventKey) => eventKey in state.alertOrigins), false);
  assert.deepEqual(new Set(state.reorgOrphanedEventKeys), new Set(orphanedEventKeys));

  // Reuse the exact transaction and event keys on a new canonical block hash.
  // Delivery must happen again; changing an event key here would weaken this
  // assertion by allowing ordinary deduplication to hide a broken rollback.
  provider.eventBlockHash = BLOCK_HASH_REPLAY;
  provider.implementation = IMPLEMENTATION_B;
  provider.creation = creationEvidence({
    includeUpgrade: true,
    version: 9,
    blockHash: BLOCK_HASH_REPLAY,
  });
  await monitor.scan();

  state = await monitor.getState();
  assert.deepEqual(events.slice(2).map((event) => event.eventKey), orphanedEventKeys);
  assert.deepEqual(events.slice(2).map((event) => event.kind), ["portal_upgrade", "new_mode"]);
  assert.equal(events.slice(2).every((event) => orphanedEventKeys.every((key) => event.reorgOrphanedEventKeys.includes(key))), true);
  assert.equal(state.portal.implementation, IMPLEMENTATION_B);
  assert.ok(state.portal.pendingUpgrade?.firstTokenAlertedAt);
  assert.equal(state.knownFeatures.includes("token-version:9"), true);
  assert.equal(state.featureOrigins["token-version:9"], EVENT_BLOCK);
  assert.deepEqual(new Set(state.alertedKeys), new Set(orphanedEventKeys));
  assert.deepEqual(Object.keys(state.alertOrigins).sort(), orphanedEventKeys.slice().sort());
  assert.equal(Object.keys(state.seenTransactions).length, 1);
});

test("failed upgrade delivery does not commit the new implementation or advance the cursor", async (t) => {
  let fail = false;
  const { monitor, provider } = await fixture(t, {
    sendAlertsImpl: async () => {
      if (fail) throw new Error("telegram unavailable");
      return { status: "delivered" };
    },
  });
  await monitor.scan();
  provider.implementation = IMPLEMENTATION_B;
  provider.head = EVENT_BLOCK + 1;
  fail = true;
  await assert.rejects(monitor.scan(), /telegram unavailable/);
  const state = await monitor.getState();
  assert.equal(state.portal.implementation, IMPLEMENTATION_A);
  assert.equal(state.cursor, EVENT_BLOCK);
});

test("temporary unknown safety does not consume a new semantic feature", async (t) => {
  let safetyChecks = 0;
  const { monitor, provider, events } = await fixture(t, {
    assessSecurityImpl: async () => {
      safetyChecks += 1;
      if (safetyChecks === 1) return { decision: "unknown", reasons: ["RPC unavailable"] };
      return { decision: "block", reasons: ["liquidity not confirmed"], metrics: { liquidityConfirmed: false } };
    },
  });
  await monitor.scan();
  provider.creation = creationEvidence({ implementation: IMPLEMENTATION_A, version: 9 });
  provider.head = EVENT_BLOCK + 1;

  await assert.rejects(monitor.scan(), /safety is unavailable/);
  let state = await monitor.getState();
  assert.equal(state.knownFeatures.includes("token-version:9"), false);
  assert.equal(state.cursor, EVENT_BLOCK);

  await monitor.scan();
  state = await monitor.getState();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "new_mode");
  assert.equal(state.knownFeatures.includes("token-version:9"), true);
  assert.equal(state.cursor, EVENT_BLOCK + 1);
});

test("Long existing Morph content is a quiet semantic baseline and unrelated page churn cannot replay it", async (t) => {
  let prefix = "build-a";
  const longText = () => `${prefix} Long launchpad is now live on Morph mainnet. Factory ${IMPLEMENTATION_A}`;
  const { monitor, events } = await fixture(t, {
    fetchImpl: async () => response(longText()),
  });
  await monitor.checkLongOfficial();
  await monitor.checkLongOfficial();
  await monitor.checkLongOfficial();
  assert.equal(events.length, 0);

  prefix = "build-b";
  await monitor.checkLongOfficial();
  await monitor.checkLongOfficial();
  assert.equal(events.length, 0);
  const state = await monitor.getState();
  assert.ok(state.long.lastAlertHash);
});
