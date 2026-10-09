import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFomoCallMonitor, createFomoPaidBscReader } from "../src/fomo-call-monitor.js";

const NOW = Date.parse("2027-01-15T00:00:00Z");
const secret = "synthetic_fomo_rpc_token_0123456789";
const privateRpc = { host: "bsc-mainnet.core.chainstack.com",
  httpUrl: `https://bsc-mainnet.core.chainstack.com/${secret}` };
const publicUrl = "https://bsc-rpc.publicnode.com";
const wallet = `0x${"3".repeat(40)}`;
const iso = value => new Date(value).toISOString();
const response = (payload, extra = {}) => ({ ok: true, status: 200, url: privateRpc.httpUrl,
  redirected: false, json: async () => payload, headers: { get: () => null }, ...extra });
function gate() {
  const events = [];
  return { events, async run(host, method, lane, fn, options) {
    events.push(["enter", host, method, lane, options.waitMs]);
    try { return await fn(); } finally { events.push(["release"]); }
  }, async persistCooldown(...args) { events.push(["cooldown", ...args]); } };
}

test("paid Fomo batches remain one gated HTTP request and preserve original response order", async () => {
  const coordinator = gate(), requests = [];
  const reader = createFomoPaidBscReader({ privateRpc, coordinator, now: () => NOW,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.redirect, "error"); assert.ok(options.signal instanceof AbortSignal);
      const body = JSON.parse(options.body);
      return response(body.map(row => ({ jsonrpc: "2.0", id: row.id, result: row.params[0] })).reverse());
    } });
  const calls = Array.from({ length: 40 }, (_, i) => ({ method: "eth_getTransactionCount", params: [String(i), "latest"] }));
  assert.deepEqual(await reader.batch(calls), calls.map(call => call.params[0]));
  assert.equal(requests.length, 1); assert.equal(JSON.parse(requests[0].options.body).length, 40);
  assert.deepEqual(coordinator.events, [["enter", privateRpc.host, "eth_getTransactionCount", "background", 1000], ["release"]]);
  await assert.rejects(reader.batch([...calls, calls[0]]), /invalid bounded/);
  await assert.rejects(reader.batch([calls[0], { method: "eth_getCode", params: [wallet, "latest"] }]), /invalid bounded/);
  await assert.rejects(reader.send("eth_sendRawTransaction", ["0x01"]), /invalid bounded/);
  assert.equal(requests.length, 1);
});

test("paid Fomo refusal issues no RPC and sanitizes even a bare credential", async () => {
  const coordinator = { run: async () => { throw Object.assign(new Error(secret), {
    code: "RPC_COORDINATOR_UNAVAILABLE", rpcFailureScope: "capacity", retryAfterMs: 100 }); } };
  const reader = createFomoPaidBscReader({ privateRpc, coordinator, fetchImpl: async () => assert.fail("must not fetch") });
  await assert.rejects(reader.send("eth_blockNumber", []), error => error.rpcFailureScope === "capacity"
    && error.retryAfterMs === 100 && !JSON.stringify(error).includes(secret) && !error.message.includes(secret));
});

test("paid Fomo HTTP cooldown is persisted before lease release and preserves Retry-After", async () => {
  const coordinator = gate();
  const reader = createFomoPaidBscReader({ privateRpc, coordinator, now: () => NOW,
    fetchImpl: async () => response(null, { ok: false, status: 429, headers: { get: () => "90" } }) });
  await assert.rejects(reader.send("eth_blockNumber", []), /HTTP 429/);
  assert.deepEqual(coordinator.events[1], ["cooldown", privateRpc.host, "eth_blockNumber", NOW + 90000, "host"]);
  assert.deepEqual(coordinator.events[2], ["release"]);
});

for (const code of [429, -32005]) for (const batch of [false, true]) {
  test(`paid Fomo HTTP 200 RPC ${code} preserves the 600-second header wait; batch=${batch}`, async () => {
    const coordinator = gate();
    const payload = { jsonrpc: "2.0", id: 1, error: { code, message: "rate limited", retryAfter: "1" } };
    const reader = createFomoPaidBscReader({ privateRpc, coordinator, now: () => NOW,
      fetchImpl: async () => response(batch ? [payload] : payload, { headers: { get: () => "600" } }) });
    await assert.rejects(batch ? reader.batch([{ method: "eth_getCode", params: [wallet, "latest"] }])
      : reader.send("eth_getCode", [wallet, "latest"]), error => error.status === 429 && error.retryAfter === "600");
    assert.deepEqual(coordinator.events[1], ["cooldown", privateRpc.host, "eth_getCode", NOW + 600000, "host"]);
    assert.deepEqual(coordinator.events[2], ["release"]);
  });
}

for (const mode of ["redirect", "foreign-origin", "duplicate", "foreign-id", "missing", "provider-secret"]) {
  test(`paid Fomo ${mode} responses fail closed without exposing credentials`, async () => {
    const coordinator = gate();
    const reader = createFomoPaidBscReader({ privateRpc, coordinator, now: () => NOW, fetchImpl: async () => {
      const rows = [{ jsonrpc: "2.0", id: 1, result: "0x1" }, { jsonrpc: "2.0", id: 2, result: "0x2" }];
      if (mode === "duplicate") rows[1].id = 1;
      if (mode === "foreign-id") rows[1].id = 3;
      if (mode === "missing") rows.pop();
      if (mode === "provider-secret") rows[0] = { jsonrpc: "2.0", id: 1, error: { code: -32005, message: `rate limited ${privateRpc.httpUrl} ${secret}` } };
      return response(rows, mode === "redirect" ? { redirected: true } : mode === "foreign-origin" ? { url: "https://foreign.example/" } : {});
    } });
    await assert.rejects(reader.batch([1, 2].map(i => ({ method: "eth_getCode", params: [String(i), "latest"] }))),
      error => !error.message.includes(secret) && !JSON.stringify(error).includes(secret));
    assert.equal(coordinator.events[1][0], "cooldown"); assert.equal(coordinator.events.at(-1)[0], "release");
  });
}

test("paid Fomo contract revert does not fabricate a host outage", async () => {
  const coordinator = gate();
  const reader = createFomoPaidBscReader({ privateRpc, coordinator, now: () => NOW,
    fetchImpl: async () => response({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } }) });
  await assert.rejects(reader.send("eth_call", [{ to: wallet }, "latest"]), { code: "CALL_EXCEPTION" });
  assert.equal(coordinator.events.length, 2);
});

function smartState() {
  const checkedAt = iso(NOW), walletProfile = {
    scheme: "gmgn_wallet_stats_dual_window_v1", wallet, chainId: 56, source: "gmgn_portfolio_stats", qualified: true,
    tags: ["launchpad_smart", "axiom"], createdAt: iso(NOW - 365 * 86400000), createdTokenCount: 0,
    feedObservedAt: iso(NOW - 1000), statsCheckedAt: iso(NOW - 1000), windows: {
      "7d": { realizedProfitUsd: 6000, winRate: .62, realizedRoi: .02, tokenCount: 100, buyCount: 100, sellCount: 90 },
      "30d": { realizedProfitUsd: 20000, winRate: .65, realizedRoi: .03, tokenCount: 200, buyCount: 300, sellCount: 280 },
    },
  };
  const entry = { wallet, walletProfile, tags: walletProfile.tags, firstSeenAt: NOW - 60000, lastSeenAt: NOW - 1000,
    lastTradeAt: NOW - 1000, profileStatus: "qualified", nextStatsAttemptAt: NOW + 3600000,
    eoaVerified: true, eoaCheckedAt: checkedAt, walletCode: "0x", baseAddress: wallet,
    monitorKind: "smart_money_performance", source: "gmgn_profitable_wallet_onchain" };
  return { version: 10, publicOnchain: { initializedAt: checkedAt, curveSourcesCheckedAt: checkedAt,
    curveSourcesStatus: "healthy", bscSilentBaselinePending: false, bscNextBlock: 101,
    smartMoney: { initializedAt: checkedAt, feedInitializedAt: checkedAt, feedCheckedAt: checkedAt, feedStatus: "healthy",
      candidates: { [wallet]: entry }, roster: { [wallet]: entry }, admittedWallets: [wallet], seenTrades: {}, pendingTrades: {},
      chainProofedTransactions: {}, statsCheckedAt: checkedAt, statsStatus: "healthy", exactTradeStatus: "not_configured" } } };
}

for (const paidFails of [false, true]) test(`smart-only Fomo paid-first scan keeps batching and source controls; fallback=${paidFails}`, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-paid-wiring-"));
  const initial = smartState();
  await fs.writeFile(path.join(dataDir, "fomo-call-state.json"), JSON.stringify(initial));
  const calls = [], pools = [], logs = [], coordinator = gate(); let destroyed = 0, cooled = false;
  const run = coordinator.run.bind(coordinator);
  coordinator.run = async (...args) => {
    if (cooled) throw Object.assign(new Error("cooling"), { code: "RPC_COORDINATOR_UNAVAILABLE", rpcFailureScope: "host" });
    return run(...args);
  };
  const persist = coordinator.persistCooldown.bind(coordinator);
  coordinator.persistCooldown = async (...args) => { cooled = true; return persist(...args); };
  const config = { dataDir, fomoCallEnabled: true, fomoBuyMonitorEnabled: false, fomoSmartMoneyMonitorEnabled: true,
    fomoPlatformSourcesEnabled: false, fomoPublishedCallEnabled: false, fomoCallBscOnly: true,
    fomoCallBscConfirmations: 0, fomoCallBscRpcUrl: publicUrl, bscRpcUrls: [publicUrl], bscArchiveRpcUrls: [publicUrl] };
  const before = structuredClone(config);
  const monitor = createFomoCallMonitor(config, { autoStart: false, now: () => NOW, wallNow: () => NOW,
    baseProvider: {}, loadPrivateBscRpcConfigImpl: () => privateRpc, bscHostCoordinator: coordinator,
    bscRpcPoolFactory: (...args) => { pools.push(args); return { destroy: () => { destroyed++; } }; },
    discoverSmartMoneyTradesImpl: async () => assert.fail("fresh feed must not refresh"),
    fetchSmartMoneyStatsImpl: async () => assert.fail("fresh stats must not refresh"),
    sendAlertsImpl: async () => assert.fail("empty blocks must not alert"), logger: { error() {}, info: line => logs.push(line) },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, body });
      assert.ok(url === privateRpc.httpUrl || url === publicUrl, "no disabled source may be restored");
      if (paidFails && url === privateRpc.httpUrl) return response(null, { ok: false, status: 429, headers: { get: () => "90" } });
      const answer = row => ({ jsonrpc: "2.0", id: row.id, result: row.method === "eth_blockNumber" ? "0x78" : {
        number: row.params[0], hash: `0x${BigInt(row.params[0]).toString(16).padStart(64, "0")}`,
        timestamp: `0x${Math.floor(NOW / 1000).toString(16)}`, transactions: [],
      } });
      return response(Array.isArray(body) ? body.map(answer).reverse() : answer(body), { url });
    } });
  t.after(async () => { await monitor.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await monitor.check(); await monitor.stop();
  assert.equal(destroyed, 1); assert.deepEqual(config, before);
  assert.deepEqual(logs.filter(line => line.startsWith("[bsc-wallet-reader]")), [`[bsc-wallet-reader] primary=${privateRpc.host}`]);
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.equal(pools.length, 1); assert.equal(pools[0][0][0], privateRpc.httpUrl);
  assert.equal(pools[0][3].priorityLane, "background"); assert.deepEqual(pools[0][3].preferredHosts, [privateRpc.host]);
  assert.equal(calls[0].url, privateRpc.httpUrl);
  const batches = calls.filter(call => Array.isArray(call.body));
  assert.equal(batches.length, 1); assert.equal(batches[0].body.length, 20);
  assert.equal(batches[0].url, paidFails ? publicUrl : privateRpc.httpUrl);
  const saved = await fs.readFile(path.join(dataDir, "fomo-call-state.json"), "utf8");
  assert.equal(JSON.parse(saved).publicOnchain.bscNextBlock, 121);
  assert.ok(!saved.includes(secret));
});

test("disabled or injected Fomo consumers never load a private endpoint", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-paid-disabled-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  // An injected fixture must not even parse this deliberately invalid file.
  await fs.writeFile(path.join(dataDir, "private-bsc-rpc.json"), "invalid", { mode: 0o600 });
  for (const enabled of [false, true]) {
    const monitor = createFomoCallMonitor({ dataDir, fomoCallEnabled: enabled,
      fomoSmartMoneyMonitorEnabled: enabled, fomoPlatformSourcesEnabled: false }, {
      autoStart: false, baseProvider: {}, bscProvider: {}, fetchImpl: async () => assert.fail("must not fetch"),
      ...(enabled ? {} : { loadPrivateBscRpcConfigImpl: () => assert.fail("disabled must not load") }),
    });
    await monitor.stop();
  }
});
