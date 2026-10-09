import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createBscLaunchpadMonitor, createRpcPool, errorSummary } from "../src/bsc-launchpad-monitor.js";

const paidHost = "bsc-paid.example.test";
const paidUrl = `https://${paidHost}/synthetic-endpoint-token`;
const publicUrl = "https://bsc-rpc.publicnode.com";

test("private BSC config is opt-in per monitor and does not contaminate global consumers", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-private-config-fixture-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const moduleUrl = new URL("../src/config.js", import.meta.url).href;
  // Import from an isolated cwd/data directory: neither dotenv nor the private
  // config loader may inspect the user's real configuration in this test.
  const script = `
    import assert from 'node:assert/strict';
    const { applyPrivateBscRpcConfig, config } = await import(${JSON.stringify(moduleUrl)});
    assert.deepEqual(config.bscPreferredRpcHosts, []);
    const publicUrl = ${JSON.stringify(publicUrl)};
    const paidUrl = ${JSON.stringify(paidUrl)};
    const target = {
      bscRpcUrl: publicUrl, bscRpcUrls: [publicUrl, paidUrl],
      bscRealtimeRpcUrls: [publicUrl], bscArchiveRpcUrls: [publicUrl],
      bscCausalClassificationRpcUrls: [publicUrl], bscWsUrl: 'wss://fallback.test',
      fourRegistryLogRpcUrls: ['https://proof-one.test', 'https://proof-two.test'],
      fourRegistryStateRpcUrls: ['https://proof-one.test', 'https://proof-two.test'],
      flapQuoteStateRpcUrls: ['https://proof-three.test', 'https://proof-four.test'],
      bscRpcConcurrency: 12, bscRealtimeRpcConcurrency: 4
    };
    const before = structuredClone(target);
    assert.equal(applyPrivateBscRpcConfig(target, null), target);
    assert.deepEqual(target, before);
    applyPrivateBscRpcConfig(target, { httpUrl: paidUrl,
      wsUrl: 'wss://bsc-paid.example.test/synthetic-endpoint-token', host: 'bsc-paid.example.test' });
    for (const field of ['bscRpcUrls', 'bscRealtimeRpcUrls', 'bscArchiveRpcUrls', 'bscCausalClassificationRpcUrls']) {
      assert.deepEqual(target[field], [paidUrl, publicUrl]);
    }
    assert.equal(target.bscRpcUrl, paidUrl);
    assert.equal(target.bscWsUrl, 'wss://bsc-paid.example.test/synthetic-endpoint-token');
    assert.deepEqual(target.bscPreferredRpcHosts, ['bsc-paid.example.test']);
    for (const field of ['fourRegistryLogRpcUrls', 'fourRegistryStateRpcUrls', 'flapQuoteStateRpcUrls', 'bscRpcConcurrency', 'bscRealtimeRpcConcurrency']) {
      assert.deepEqual(target[field], before[field]);
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dataDir,
    env: { PATH: process.env.PATH, DATA_DIR: dataDir, DOTENV_CONFIG_PATH: "/dev/null" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const fixture = { version: 1,
    httpUrl: "https://bsc-mainnet.core.chainstack.com/0123456789abcdef0123456789abcdef",
    wsUrl: "wss://bsc-mainnet.core.chainstack.com/0123456789abcdef0123456789abcdef" };
  await fs.writeFile(path.join(dataDir, "private-bsc-rpc.json"), JSON.stringify(fixture), { mode: 0o600 });
  const loaded = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const { config } = await import(${JSON.stringify(moduleUrl)});
    const expected = ${JSON.stringify(fixture)};
    assert.notEqual(config.bscRpcUrl, expected.httpUrl);
    assert.notEqual(config.bscWsUrl, expected.wsUrl);
    assert.deepEqual(config.bscPreferredRpcHosts, []);
    assert.ok(!JSON.stringify(config).includes('0123456789abcdef0123456789abcdef'));
    for (const field of ['bscRpcUrls', 'bscRealtimeRpcUrls', 'bscArchiveRpcUrls', 'bscCausalClassificationRpcUrls']) {
      assert.ok(!config[field].includes(expected.httpUrl));
    }
    for (const field of ['fourRegistryLogRpcUrls', 'fourRegistryStateRpcUrls', 'flapQuoteStateRpcUrls']) {
      assert.equal(config[field].length, 2);
      assert.ok(!config[field].includes(expected.httpUrl));
    }
  `], { cwd: dataDir, env: { PATH: process.env.PATH, DATA_DIR: dataDir, DOTENV_CONFIG_PATH: "/dev/null" }, encoding: "utf8" });
  assert.equal(loaded.status, 0, loaded.stderr);
});

test("private endpoints are loaded only into a cloned scan-monitor config", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-private-local-monitor-fixture-"));
  const token = "0123456789abcdef0123456789abcdef";
  const fixture = { version: 1,
    httpUrl: `https://bsc-mainnet.core.chainstack.com/${token}`,
    wsUrl: `wss://bsc-mainnet.core.chainstack.com/${token}` };
  await fs.writeFile(path.join(dataDir, "private-bsc-rpc.json"), JSON.stringify(fixture), { mode: 0o600 });
  const inputConfig = {
    dataDir, monitorScope: "focus3", bscMonitorEnabled: true,
    bscRpcUrl: publicUrl, bscRpcUrls: [publicUrl], bscArchiveRpcUrls: [],
    bscRealtimeRpcUrls: [publicUrl], bscCausalClassificationRpcUrls: [publicUrl],
    bscWsUrl: "wss://public-rpc.example.test", bscPreferredRpcHosts: [],
    bscHttpHeadPollIntervalMs: 3_600_000, bscOfficialPollIntervalMs: 3_600_000,
    bscDeferredRetryIntervalMs: 3_600_000,
  };
  const before = structuredClone(inputConfig), socketUrls = [], lines = [];
  const monitor = createBscLaunchpadMonitor(inputConfig, {
    autoStart: false,
    provider: {
      async getNetwork() { return { chainId: 56n }; }, async getBlockNumber() { return 100; },
      async send() { return []; }, destroy() {},
    },
    WebSocketImpl: class { constructor(url) { socketUrls.push(url); throw new Error("offline fixture handshake"); } },
    fetchImpl: async () => ({ ok: false, status: 403, headers: { get() { return null; } }, text: async () => "forbidden" }),
    logger: { error: (line) => lines.push(line), info: (line) => lines.push(line) },
    sendAlertsImpl: async () => assert.fail("RPC wiring must not send alerts"),
  });
  t.after(async () => { await monitor.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await monitor.start();
  assert.deepEqual(socketUrls, [fixture.wsUrl]);
  assert.deepEqual(inputConfig, before, "shared config object must retain only its original public endpoints");
  assert.ok(!JSON.stringify({ lines, state: await monitor.getState() }).includes(token));
});

test("explicit paid host stays first for heads, scoped logs and archive state across rotation", async (t) => {
  const calls = [];
  const pool = createRpcPool([publicUrl, paidUrl], ["https://bsc.rpc.sentio.xyz", paidUrl], 1, {
    preferredHosts: [paidHost], stateReadBudgetMs: 10_000,
    providerFactory: (url, context) => ({
      async getBlockNumber() { calls.push([new URL(url).host, context.kind, "head"]); return 100; },
      async getCode() { calls.push([new URL(url).host, context.kind, "code"]); return "0x1234"; },
      async send() { calls.push([new URL(url).host, context.kind, "logs"]); return []; },
    }),
  });
  t.after(() => pool.destroy());
  await pool.getBlockNumber();
  await pool.getBlockNumber();
  await pool.send("eth_getLogs", [{ address: "0x1111111111111111111111111111111111111111", fromBlock: "0x1", toBlock: "0x2" }]);
  await pool.getCode("0x1111111111111111111111111111111111111111", 90);
  await pool.getCode("0x2222222222222222222222222222222222222222", 90);
  assert.equal(calls.length, 5);
  assert.ok(calls.every(([host]) => host === paidHost));
  assert.deepEqual(calls.map(([, kind]) => kind), ["standard", "standard", "archive", "archive", "archive"]);
});

test("busy healthy paid readers use their original bounded queue before idle public readers", async (t) => {
  const admitted = [], calls = [];
  const pool = createRpcPool([publicUrl, paidUrl], [publicUrl, paidUrl], 1, {
    preferredHosts: [paidHost], physicalWaitMs: 200, stateReadBudgetMs: 10_000,
    hostCoordinator: {
      snapshot: () => ({ leases: [{ host: paidHost, lane: 'background', operation: 'eth_call' }], circuits: [], waiters: [] }),
      run: async (host, operation, lane, callback, options) => { admitted.push({host, operation, lane, options}); return callback(); },
      persistCooldown: async () => assert.fail('local capacity is not an upstream fault'),
    },
    providerFactory: (url, context) => ({
      async getBlockNumber() { calls.push([new URL(url).host, context.kind]); return 100; },
      async getCode() { calls.push([new URL(url).host, context.kind]); return '0x1234'; },
    }),
  });
  t.after(() => pool.destroy());
  await pool.getBlockNumber();
  await pool.getCode('0x1111111111111111111111111111111111111111', 90);
  assert.deepEqual(calls, [[paidHost, 'standard'], [paidHost, 'archive']]);
  assert.ok(admitted.every(call => call.host === paidHost && call.lane === 'background' && call.options.waitMs === 200));
});

test("an occupied paid recovery probe yields to an independent healthy fallback", async (t) => {
  const calls = [];
  const pool = createRpcPool([paidUrl, publicUrl], [], 1, {
    preferredHosts: [paidHost],
    hostCoordinator: {
      snapshot: () => ({ leases: [{host: paidHost, lane: 'realtime', operation: 'eth_blockNumber'}],
        circuits: [{host: paidHost, operation: '*', until_ms: Date.now() - 1}] }),
      run: async (_host, _operation, _lane, callback) => callback(),
      persistCooldown: async () => {},
    },
    providerFactory: (url) => ({ async getBlockNumber() { calls.push(new URL(url).host); return 100; } }),
  });
  t.after(() => pool.destroy());
  await pool.getBlockNumber();
  assert.deepEqual(calls, ['bsc-rpc.publicnode.com']);
});

test("caller cancellation never cools paid endpoints or fans out to another provider/pool", async (t) => {
  for (const read of ['head', 'latestCode', 'historicalCode', 'historicalBlock', 'logs']) {
    await t.test(read, async (t) => {
      const calls = [], cooldowns = [];
      const pool = createRpcPool([paidUrl, publicUrl], [paidUrl, publicUrl], 1, {
        preferredHosts: [paidHost], stateReadBudgetMs: 10_000,
        hostCoordinator: { snapshot: () => ({leases: [], circuits: []}),
          run: async (_host, _operation, _lane, callback) => callback(),
          persistCooldown: async (...args) => cooldowns.push(args) },
        providerFactory: (url, context) => {
          const cancel = async () => { calls.push([new URL(url).host, context.kind]);
            throw Object.assign(new Error('caller stopped'), {code: 'CANCELLED'}); };
          return {getBlockNumber: cancel, getCode: cancel, getBlock: cancel, send: cancel};
        },
      });
      t.after(() => pool.destroy());
      const ca = '0x1111111111111111111111111111111111111111';
      const task = read === 'head' ? pool.getBlockNumber()
        : read === 'latestCode' ? pool.getCode(ca, 'latest')
        : read === 'historicalCode' ? pool.getCode(ca, 90)
        : read === 'historicalBlock' ? pool.getHistoricalBlock(90)
        : pool.send('eth_getLogs', [{address: ca, fromBlock: '0x1', toBlock: '0x2'}]);
      await assert.rejects(task, {code: 'CANCELLED'});
      assert.equal(calls.length, 1); assert.equal(calls[0][0], paidHost);
      assert.equal(cooldowns.length, 0);
    });
  }
});

test("paid preference respects local cooldown, falls back and recovers after the deadline", async (t) => {
  let now = 1_000, fail = true;
  const calls = [];
  const pool = createRpcPool([paidUrl, publicUrl], [], 1, {
    preferredHosts: [paidHost], now: () => now,
    providerFactory: (url) => ({
      async getBlockNumber() {
        const host = new URL(url).host;
        calls.push(host);
        if (host === paidHost && fail) {
          const error = new Error("HTTP 429 rate limit");
          error.status = 429; error.retryAfterMs = 12_000;
          throw error;
        }
        return 100;
      },
    }),
  });
  t.after(() => pool.destroy());
  await pool.getBlockNumber();
  await pool.getBlockNumber();
  assert.deepEqual(calls, [paidHost, "bsc-rpc.publicnode.com", "bsc-rpc.publicnode.com"]);
  now += 12_001; fail = false;
  await pool.getBlockNumber();
  assert.equal(calls.at(-1), paidHost);
});

test("paid preference yields to shared host cooldown and cannot override known log capabilities", async (t) => {
  const calls = [];
  const pool = createRpcPool([paidUrl, publicUrl], [], 1, {
    preferredHosts: [paidHost],
    hostCoordinator: {
      snapshot: () => ({ leases: [], circuits: [{ host: paidHost, operation: "eth_blockNumber", until_ms: Date.now() + 60_000 }] }),
      run: async (_host, _operation, _lane, callback) => callback(),
      persistCooldown: async () => {},
    },
    providerFactory: (url) => ({ async getBlockNumber() { calls.push(new URL(url).host); return 100; } }),
  });
  t.after(() => pool.destroy());
  await pool.getBlockNumber();
  assert.deepEqual(calls, ["bsc-rpc.publicnode.com"]);

  const capableCalls = [];
  const capabilityPool = createRpcPool(["https://bsc.nodereal.io", publicUrl], [], 1, {
    preferredHosts: ["bsc.nodereal.io"],
    providerFactory: (url) => ({ async send() { capableCalls.push(new URL(url).host); return []; } }),
  });
  t.after(() => capabilityPool.destroy());
  await capabilityPool.send("eth_getLogs", [{ address: "0x1111111111111111111111111111111111111111", fromBlock: "0x1", toBlock: "0x2" }]);
  assert.deepEqual(capableCalls, ["bsc-rpc.publicnode.com"]);
});

test("nested ethers and websocket error summaries do not expose endpoint paths", async (t) => {
  for (const error of [
    { info: { error: { message: `HTTP 429 at ${paidUrl}` } } },
    { error: { message: `socket failed at wss://${paidHost}/synthetic-endpoint-token` } },
    { shortMessage: `request timeout (${paidUrl})` },
  ]) {
    assert.doesNotMatch(errorSummary(error), /synthetic-endpoint-token/);
    assert.match(errorSummary(error), /429|socket|timeout/);
  }
  const pool = createRpcPool([paidUrl], [], 1, {
    preferredHosts: [paidHost], now: () => 1_000,
    providerFactory: () => ({ async getBlockNumber() {
      const error = new Error(`HTTP 429 ${paidUrl}`);
      error.status = 429; error.retryAfterMs = 12_000;
      throw error;
    } }),
  });
  t.after(() => pool.destroy());
  await assert.rejects(pool.getBlockNumber(), (error) => {
    assert.doesNotMatch(error.message, /synthetic-endpoint-token/);
    assert.doesNotMatch(error.rpcHostFailure, /synthetic-endpoint-token/);
    assert.match(error.message, /429/);
    assert.equal(error.rpcHostRetryAfterMs, 12_000);
    return true;
  });
});

test("a directly injected Chainstack pool registers bare tokens for error redaction", async (t) => {
  const token = "0123456789abcdef0123456789abcdef";
  const pool = createRpcPool([`https://bsc-mainnet.core.chainstack.com/${token}`], [], 1, {
    preferredHosts: ["bsc-mainnet.core.chainstack.com"],
    providerFactory: () => ({ async getBlockNumber() { throw new Error(`timeout for ${token}`); } }),
  });
  t.after(() => pool.destroy());
  await assert.rejects(pool.getBlockNumber(), (error) => {
    assert.match(error.message, /timeout/);
    assert.ok(!error.message.includes(token));
    return true;
  });
  assert.ok(!errorSummary({ error: { message: `socket failed on /${token}` } }).includes(token));
});

test("non-retryable pool errors drop credentials from messages and nested provider metadata", async (t) => {
  const token = "0123456789abcdef0123456789abcdef";
  const url = `https://bsc-mainnet.core.chainstack.com/${token}`;
  for (const code of ["CALL_EXCEPTION", "INVALID_ARGUMENT", "NUMERIC_FAULT"]) {
    await t.test(code, async () => {
      const pool = createRpcPool([url], [], 1, {
        providerFactory: () => ({ async getBlockNumber() {
          throw Object.assign(new Error(`provider rejected bare credential ${token}`), {
            code, info: { request: { url }, error: { message: `upstream ${token}` } },
            request: { url }, cause: new Error(`socket ${url}`),
          });
        } }),
      });
      try {
        await assert.rejects(pool.getBlockNumber(), (error) => {
          assert.equal(error.code, code);
          assert.ok(!JSON.stringify({ ...error, message: error.message, stack: error.stack }).includes(token));
          for (const field of ["info", "request", "cause"]) assert.equal(error[field], undefined);
          return true;
        });
      } finally { pool.destroy(); }
    });
  }
});

test("real pool HTTP transport forbids redirects and rejects changed response origin without networking", async (t) => {
  const token = "abcdef0123456789abcdef0123456789";
  const url = `https://bsc-mainnet.core.chainstack.com/${token}`;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const scenario of ["same_origin", "cross_origin", "redirected"]) {
    await t.test(scenario, async () => {
      const requests = [];
      globalThis.fetch = async (requestedUrl, options) => {
        requests.push({ requestedUrl, redirect: options.redirect });
        const payload = JSON.parse(Buffer.from(options.body).toString());
        assert.equal(payload.method, "eth_blockNumber", "test transport must never send transaction methods");
        const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0x64" }));
        return {
          status: 200, statusText: "OK", headers: new Headers({ "content-type": "application/json" }),
          redirected: scenario === "redirected",
          url: scenario === "cross_origin" ? "https://untrusted.example.test/other" : requestedUrl,
          arrayBuffer: async () => bytes.buffer,
        };
      };
      // No providerFactory: exercise the actual ethers FetchRequest adapter.
      // All fetches are intercepted above; independent circuits avoid a prior
      // fixture's cooldown suppressing the exact transport under inspection.
      const pool = createRpcPool([url], [], 1, { hostCircuitRegistry: new Map(), requestTimeoutMs: 1_000 });
      try {
        if (scenario === "same_origin") assert.equal(await pool.getBlockNumber(), 100);
        else await assert.rejects(pool.getBlockNumber(), /redirect|origin/i);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].requestedUrl, url);
        assert.equal(requests[0].redirect, "error");
      } finally { pool.destroy(); }
    });
  }
});

test("websocket connection failures are redacted before reaching logger and durable monitor state", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bsc-private-ws-fixture-"));
  const lines = [];
  const monitor = createBscLaunchpadMonitor({
    dataDir, monitorScope: "focus3", bscMonitorEnabled: true,
    bscWsUrl: `wss://${paidHost}/synthetic-endpoint-token`, bscRpcUrl: paidUrl,
    bscHttpHeadPollIntervalMs: 3_600_000, bscOfficialPollIntervalMs: 3_600_000,
    bscDeferredRetryIntervalMs: 3_600_000,
  }, {
    autoStart: false,
    provider: {
      async getNetwork() { return { chainId: 56n }; }, async getBlockNumber() { return 100; },
      async send() { return []; }, destroy() {},
    },
    WebSocketImpl: class { constructor(url) { throw new Error(`WebSocket handshake timeout: ${url}`); } },
    fetchImpl: async () => ({ ok: false, status: 403, headers: { get() { return null; } }, text: async () => "forbidden" }),
    logger: { error: (line) => lines.push(line), info: (line) => lines.push(line) },
    sendAlertsImpl: async () => assert.fail("RPC wiring must not send alerts"),
  });
  t.after(async () => { await monitor.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await monitor.start();
  assert.ok(lines.some((line) => line.includes("WebSocket handshake timeout")));
  assert.ok(lines.every((line) => !line.includes("synthetic-endpoint-token")));
  assert.ok(!JSON.stringify(await monitor.getState()).includes("synthetic-endpoint-token"));
});
