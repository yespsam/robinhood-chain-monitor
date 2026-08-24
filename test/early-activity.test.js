import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Interface } from "ethers";
import {
  activitySamplesFromLogs,
  activityWindows,
  anomalyStage,
  createEarlyActivityMonitor,
  minimumVolume,
} from "../src/early-activity-monitor.js";

test("volume anomaly escalates without alerting small noise", () => {
  assert.equal(anomalyStage(3, 1_000, 200), 0);
  assert.equal(anomalyStage(10, 200, 200), 1);
  assert.equal(anomalyStage(50, 600, 200), 2);
  assert.equal(anomalyStage(200, 2_000, 200), 3);
});

test("volume thresholds fail closed for unsupported quote tokens", () => {
  assert.equal(minimumVolume({ quoteToken: "0x0bd7d308f8e1639fab988df18a8011f41eacad73" }), 0.2);
  assert.equal(minimumVolume({ quoteToken: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" }), 200);
  assert.equal(minimumVolume({ quoteToken: "0xe934e36a439c94017b64a3fece66af12099abf50" }), null);
});

test("activity windows preserve buy/sell direction, five-minute context and acceleration", () => {
  const now = 1_000_000;
  const summary = activityWindows([
    { at: now - 30_000, swaps: 12, volume: 300, buys: 9, sells: 3 },
    { at: now - 90_000, swaps: 5, volume: 100, buys: 2, sells: 3 },
    { at: now - 180_000, swaps: 4, volume: 50, buys: 1, sells: 3 },
    { at: now - 360_000, swaps: 99, volume: 9_999, buys: 99, sells: 0 },
  ], now);
  assert.deepEqual(summary.minute, { swaps: 12, volume: 300, buys: 9, sells: 3, unknownDirections: 0 });
  assert.deepEqual(summary.previousMinute, { swaps: 5, volume: 100, buys: 2, sells: 3, unknownDirections: 0 });
  assert.deepEqual(summary.fiveMinutes, { swaps: 21, volume: 450, buys: 12, sells: 9, unknownDirections: 0 });
  assert.equal(summary.volumeAcceleration, 3);
});

test("swap samples use block time and preserve V3 and V2 buy/sell directions", () => {
  const token = "0x1111111111111111111111111111111111111111";
  const quote = "0x2222222222222222222222222222222222222222";
  const entry = { token, quoteDecimals: 18, pool: { token0: token, token1: quote } };
  const v3 = new Interface(["event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)"]);
  const v2 = new Interface(["event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)"]);
  const sender = "0x3333333333333333333333333333333333333333";
  const recipient = "0x4444444444444444444444444444444444444444";
  const makeLog = (iface, values, blockNumber) => ({ ...iface.encodeEventLog(iface.getEvent("Swap"), values), blockNumber });
  const now = 1_000_000;
  const logs = [
    makeLog(v3, [sender, recipient, -10n, 2n * 10n ** 18n, 1n, 1n, 0], 10),
    makeLog(v3, [sender, recipient, 10n, -(3n * 10n ** 18n), 1n, 1n, 0], 11),
    makeLog(v2, [sender, 10n, 0n, 0n, 4n * 10n ** 18n, recipient], 12),
    makeLog(v2, [sender, 0n, 5n * 10n ** 18n, 10n, 0n, recipient], 13),
  ];
  const samples = activitySamplesFromLogs(entry, logs, new Map([
    [10, now - 121_000],
    [11, now - 70_000],
    [12, now - 30_000],
    [13, now - 5_000],
  ]));
  const summary = activityWindows(samples, now);

  assert.equal(summary.minute.swaps, 2);
  assert.equal(summary.minute.buys, 1);
  assert.equal(summary.minute.sells, 1);
  assert.equal(summary.minute.volume, 9);
  assert.equal(summary.previousMinute.swaps, 1);
  assert.equal(summary.previousMinute.sells, 1);
  assert.equal(summary.fiveMinutes.swaps, 4);
  assert.equal(summary.fiveMinutes.buys, 2);
  assert.equal(summary.fiveMinutes.sells, 2);
  assert.equal(samples.some((sample) => "buy" in sample || "sell" in sample), false);
});

test("activity timestamps fail closed when a block header is missing and ignore future samples", () => {
  const entry = {
    token: "0x1111111111111111111111111111111111111111",
    quoteDecimals: 18,
    pool: { token0: "0x1111111111111111111111111111111111111111", token1: "0x2222222222222222222222222222222222222222" },
  };
  const v3 = new Interface(["event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)"]);
  const encoded = v3.encodeEventLog(v3.getEvent("Swap"), [
    "0x3333333333333333333333333333333333333333",
    "0x4444444444444444444444444444444444444444",
    -10n,
    10n ** 18n,
    1n,
    1n,
    0,
  ]);
  assert.throws(() => activitySamplesFromLogs(entry, [{ ...encoded, blockNumber: 99 }], new Map()), /missing block timestamp/);
  assert.equal(activityWindows([{ at: 1_001_000, swaps: 10, volume: 10 }], 1_000_000).minute.swaps, 0);
});

test("a malformed activity state is rebuilt from the durable 24h event ledger and saved atomically", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "early-activity-recovery-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "early-watchlist.json"), '{"activityStateVersion":2,"tokens":{');
  const token = "0x1111111111111111111111111111111111111111";
  const quote = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  const event = {
    type: "token_launch",
    factoryStatus: "new_candidate",
    launcher: "0x2222222222222222222222222222222222222222",
    blockNumber: 100,
    timestamp,
    observedAt: new Date().toISOString(),
    transactionHash: `0x${"3".repeat(64)}`,
    tokens: [{ token, metadata: { name: "Recovered", symbol: "RCV", decimals: 18 } }],
    pools: [{ kind: "uniswap-v2", pool: "0x4444444444444444444444444444444444444444", token0: quote, token1: token }],
  };
  const alertSnapshot = {
    type: "early_activity_alert",
    activity: "volume_anomaly",
    stage: 2,
    observedAt: new Date().toISOString(),
    entry: {
      token,
      firstSeenAt: timestamp,
      lastScannedBlock: 101,
      samples: [{ at: Date.now() - 5_000, swaps: 50, volume: 1, buys: 40, sells: 10, unknownDirections: 0 }],
      alertStage: 2,
      lastAlertAt: Date.now() - 5_000,
      metadata: { name: "Recovered", symbol: "RCV", decimals: 18, website: "https://example.test" },
      securityDecision: "pass",
    },
  };
  await fs.writeFile(
    path.join(dataDir, "events.jsonl"),
    `${JSON.stringify(event)}\n${JSON.stringify(alertSnapshot)}\n{"partial":`,
  );
  const provider = {
    async getBlockNumber() { return 102; },
    async getLogs() { return []; },
  };
  const monitor = createEarlyActivityMonitor({
    provider,
    config: { dataDir, confirmations: 2 },
    onEvent: async () => {},
  });
  t.after(() => monitor.stop());

  await monitor.ready;
  const recovered = JSON.parse(await fs.readFile(path.join(dataDir, "early-watchlist.json"), "utf8"));
  assert.equal(recovered.tokens[token].symbol, "RCV");
  assert.equal(recovered.tokens[token].firstSeenAt, timestamp);
  assert.equal(recovered.tokens[token].alertStage, 2);
  assert.equal(recovered.tokens[token].lastScannedBlock, 101);
  assert.equal(recovered.tokens[token].metadata.website, "https://example.test");
  assert.equal(recovered._recovery.source, "events_jsonl_24h");
  assert.equal(recovered._recovery.watchedTokens, 1);
  assert.equal(recovered._recovery.recoveredAlertSnapshots, 1);
  const files = await fs.readdir(dataDir);
  assert.equal(files.filter((name) => name.includes(".corrupt.")).length, 1);
  assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), []);
});

test("V4 poolId-only launches are excluded from the V2/V3 activity scanner", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "early-activity-v4-add-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let getLogsCalls = 0;
  const provider = {
    async getBlockNumber() { return 100; },
    async getLogs() { getLogsCalls += 1; return []; },
  };
  const monitor = createEarlyActivityMonitor({
    provider,
    config: { dataDir, confirmations: 2 },
    onEvent: async () => {},
  });
  t.after(() => monitor.stop());
  await monitor.ready;

  const added = await monitor.add({
    type: "token_launch",
    factoryStatus: "new_candidate",
    blockNumber: 99,
    tokens: [{ token: "0x1111111111111111111111111111111111111111" }],
    pools: [{
      kind: "uniswap-v4",
      pool: "0x3333333333333333333333333333333333333333",
      poolId: `0x${"2".repeat(64)}`,
      token0: "0x1111111111111111111111111111111111111111",
      token1: "0x2222222222222222222222222222222222222222",
    }],
  });
  await monitor.check();

  const saved = JSON.parse(await fs.readFile(path.join(dataDir, "early-watchlist.json"), "utf8"));
  assert.equal(added, false);
  assert.deepEqual(saved.tokens, {});
  assert.equal(getLogsCalls, 0);
});

test("legacy V4 watchlist entries are pruned before activity RPC queries", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "early-activity-v4-migration-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const token = "0x1111111111111111111111111111111111111111";
  const validToken = "0x5555555555555555555555555555555555555555";
  const validPool = "0x6666666666666666666666666666666666666666";
  const sample = { at: Date.now() - 5_000, swaps: 50, volume: 1, buys: 40, sells: 10, unknownDirections: 0 };
  await fs.writeFile(path.join(dataDir, "early-watchlist.json"), JSON.stringify({
    activityStateVersion: 2,
    tokens: {
      [token]: {
        token,
        firstSeenAt: new Date().toISOString(),
        pool: {
          kind: "uniswap-v4",
          pool: null,
          poolId: `0x${"2".repeat(64)}`,
          token0: token,
          token1: "0x2222222222222222222222222222222222222222",
        },
        samples: [],
      },
      [validToken]: {
        token: validToken,
        quoteToken: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
        quoteDecimals: 18,
        firstSeenAt: new Date().toISOString(),
        lastScannedBlock: 90,
        alertStage: 2,
        samples: [sample],
        metadata: {},
        pool: {
          kind: "uniswap-v2",
          pool: validPool,
          token0: validToken,
          token1: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
        },
      },
    },
  }));
  const getLogsCalls = [];
  const provider = {
    async getBlockNumber() { return 100; },
    async getLogs(filter) { getLogsCalls.push(filter); return []; },
  };
  const monitor = createEarlyActivityMonitor({
    provider,
    config: { dataDir, confirmations: 2 },
    onEvent: async () => {},
  });
  t.after(() => monitor.stop());
  await monitor.ready;

  const saved = JSON.parse(await fs.readFile(path.join(dataDir, "early-watchlist.json"), "utf8"));
  assert.equal(saved.activityStateVersion, 3);
  assert.deepEqual(Object.keys(saved.tokens), [validToken]);
  assert.deepEqual(saved.tokens[validToken].samples, [sample]);
  assert.equal(saved.tokens[validToken].alertStage, 2);
  assert.equal(saved.tokens[validToken].lastScannedBlock, 98);
  assert.equal(saved._recovery.prunedUnsupportedPools, 1);
  assert.equal(getLogsCalls.length, 1);
  assert.deepEqual(getLogsCalls[0].address, [validPool]);
});

test("early-activity stop drains startup work and prevents its ready chain from scheduling again", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "early-activity-stop-drain-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let blockRequests = 0;
  let releaseBlock;
  const blockHeld = new Promise((resolve) => { releaseBlock = resolve; });
  let markBlockStarted;
  const blockStarted = new Promise((resolve) => { markBlockStarted = resolve; });
  const provider = {
    async getBlockNumber() {
      blockRequests += 1;
      markBlockStarted();
      await blockHeld;
      return 100;
    },
    async getLogs() { return []; },
  };
  const monitor = createEarlyActivityMonitor({
    provider,
    config: { dataDir, confirmations: 2 },
    onEvent: async () => {},
  });

  await blockStarted;
  const stopping = monitor.stop();
  assert.equal(monitor.stop(), stopping, "repeated stops share one drain boundary");
  void monitor.check();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(blockRequests, 1);

  releaseBlock();
  await stopping;
  assert.equal(blockRequests, 1);
  assert.equal(await monitor.add({
    type: "token_launch",
    factoryStatus: "new_candidate",
    blockNumber: 100,
    tokens: [{ token: "0x1111111111111111111111111111111111111111" }],
    pools: [{
      kind: "uniswap-v2",
      pool: "0x2222222222222222222222222222222222222222",
      token0: "0x1111111111111111111111111111111111111111",
      token1: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    }],
  }), false);
  const durable = JSON.parse(await fs.readFile(path.join(dataDir, "early-watchlist.json"), "utf8"));
  assert.equal(durable._health.status, "healthy");
  assert.deepEqual(durable.tokens, {});
});
