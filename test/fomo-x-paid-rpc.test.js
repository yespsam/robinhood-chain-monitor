import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFomoXCallMonitor } from "../src/fomo-x-call-monitor.js";
import { CHAINSTACK_BSC_HOST } from "../src/bsc-private-rpc.js";

const SECRET = "offline_x_chainstack_credential_12345";
const PRIVATE_URL = `https://${CHAINSTACK_BSC_HOST}/${SECRET}`;
const PUBLIC_HOST = "bsc-rpc.publicnode.com";
const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "0x1111111111111111111111111111111111111111";
const PAIR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const X_ID = "123456789012345678";
const word = value => BigInt(value).toString(16).padStart(64, "0");
const privateRpc = { httpUrl: PRIVATE_URL, wsUrl: `wss://${CHAINSTACK_BSC_HOST}/${SECRET}`, host: CHAINSTACK_BSC_HOST };
const json = (data, options) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" }, ...options });

async function harness(t, { paid = true, rpc, dependencies = {}, timeoutMs = 900, releaseHook } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-x-paid-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = { value: Date.parse("2026-10-08T00:00:00Z") };
  const events = [], logs = [], rpcCalls = [], leases = [], cooldowns = [];
  let loads = 0;
  const tweets = [{ id: "900", text: "baseline" }];
  const coordinator = {
    snapshot: () => ({ leases: [], circuits: [] }),
    persistCooldown: async (...args) => { cooldowns.push(args); },
    async run(host, operation, lane, callback) {
      const lease = { host, operation, lane, released: false }; leases.push(lease);
      try { return await callback(); } finally { await releaseHook?.(lease); lease.released = true; }
    },
  };
  const cfg = { dataDir, fomoXCallEnabled: true, fomoPlatformSourcesEnabled: false,
    fomoXCallRequestTimeoutMs: timeoutMs, fomoXCallProfileRefreshMs: 60_000,
    fomoCallFxTwitterApiBase: "https://fxtwitter.test", fomoXCallOembedBase: "https://publish.x.test/oembed",
    fomoCallBscRpcUrl: "https://legacy-rpc.test", fomoCallPublicHandles: ["must_not_query_fomoscan"],
  };
  const monitor = createFomoXCallMonitor(cfg, {
    autoStart: false, now: () => now.value,
    logger: { info: text => logs.push(text), warn: text => logs.push(text), error: text => logs.push(text) },
    rpcHostCoordinator: coordinator,
    loadPrivateBscRpcConfigImpl: () => { loads++; return paid ? privateRpc : null; },
    discoverCandidatesImpl: async () => [{ handle: "alpha", wallet: WALLET, wallets: [WALLET],
      twitterHandles: ["alpha"], tags: ["kol", "fomo"], source: "gmgn_bsc_kol_feed", discoveredAt: now.value - 1_000 }],
    sendAlertsImpl: async (_config, event) => { events.push(event); return { status: "delivered" }; },
    fetchImpl: async (url, options = {}) => {
      const host = new URL(url).hostname;
      if ([CHAINSTACK_BSC_HOST, PUBLIC_HOST, "legacy-rpc.test"].includes(host)) {
        const request = JSON.parse(options.body.toString());
        assert.equal(Array.isArray(request), false, "one RPC per physical lease");
        rpcCalls.push({ host, method: request.method, params: request.params, redirect: options.redirect });
        if (paid) {
          assert.ok(leases.some(lease => lease.host === host && !lease.released), "fetch requires an active shared host lease");
          assert.equal(options.redirect, "error");
        }
        if (rpc) return rpc({ url, host, request, options, leases });
        const result = request.method === "eth_getTransactionCount" ? "0x7"
          : request.method === "eth_getCode" ? "0x60006000"
          : request.method === "eth_getStorageAt" ? `0x${word(0)}`
          : request.method === "eth_call" && request.params[0].to.toLowerCase() === PAIR
            ? `0x${word(1)}${word(2)}${word(0)}` : `0x${word(0)}`;
        return json({ jsonrpc: "2.0", id: request.id, result });
      }
      if (url === "https://fxtwitter.test/2/profile/alpha") return json({ code: 200,
        user: { id: X_ID, screen_name: "alpha", followers: 25_000, protected: false } });
      if (url.includes("/statuses?")) return json({ code: 200, results: tweets.map(tweet => ({ ...tweet,
        created_timestamp: Math.floor(now.value / 1_000), url: `https://x.com/alpha/status/${tweet.id}`,
        author: { id: X_ID, screen_name: "alpha", name: "Alpha" }, replying_to: null })) });
      if (url.startsWith("https://publish.x.test/oembed?")) {
        const id = new URL(url).searchParams.get("url").split("/").at(-1);
        const tweet = tweets.find(tweet => tweet.id === id);
        return json({ author_url: "https://x.com/alpha", url: `https://x.com/alpha/status/${id}`,
          html: `<blockquote><p>${tweet.text}</p>&mdash; Alpha (@alpha) <a href="https://x.com/alpha/status/${id}">October 8, 2026</a></blockquote>` });
      }
      if (url.startsWith("https://api.dexscreener.com/token-pairs/v1/bsc/")) return json([{ chainId: "bsc", dexId: "pancakeswap",
        pairAddress: PAIR, baseToken: { address: TOKEN }, quoteToken: { address: WALLET },
        labels: ["v2"], liquidity: { usd: 25_000 }, txns: { m5: { buys: 4, sells: 3 } } }]);
      throw new Error(`unexpected test request host ${host}`);
    },
    ...dependencies,
  });
  t.after(() => monitor.stop());
  return { monitor, cfg, now, tweets, events, logs, rpcCalls, leases, cooldowns, loads: () => loads };
}

test("X nonce uses paid first through the shared lease, lazily and without persisting credentials", async t => {
  const h = await harness(t);
  assert.equal(h.loads(), 0);
  assert.equal(h.rpcCalls.length, 0);
  await h.monitor.check();
  assert.deepEqual(h.rpcCalls.map(call => [call.host, call.method]), [[CHAINSTACK_BSC_HOST, "eth_getTransactionCount"]]);
  assert.deepEqual(h.rpcCalls[0].params, [WALLET, "latest"]);
  assert.equal(h.loads(), 1);
  assert.ok(h.leases.every(lease => lease.released && lease.lane === "background"));
  assert.deepEqual(h.logs, [`[fomo-x-bsc-reader] primary=${CHAINSTACK_BSC_HOST}`]);
  const state = await h.monitor.getState();
  assert.equal(state.health.sources.fomoscanSeeds.status, "disabled_by_user");
  const persisted = await fs.readFile(h.monitor.stateFile, "utf8");
  assert.equal(JSON.stringify([state, h.cfg, h.logs, h.events, persisted]).includes(SECRET), false);
});

test("X paid nonce fails over once to public and retains transport circuit evidence", async t => {
  const h = await harness(t, { rpc: async ({ host, request }) => host === CHAINSTACK_BSC_HOST
    ? json({ error: { message: `bad gateway ${PRIVATE_URL}` } }, { status: 503 })
    : json({ jsonrpc: "2.0", id: request.id, result: "0x8" }) });
  await h.monitor.check();
  assert.deepEqual(h.rpcCalls.map(call => call.host), [CHAINSTACK_BSC_HOST, PUBLIC_HOST]);
  assert.equal(h.cooldowns.length, 1);
  assert.equal(h.cooldowns[0][0], CHAINSTACK_BSC_HOST);
  assert.equal((await h.monitor.getState()).roster.alpha.bscActivity.count, 8);
});

test("X no-private path preserves legacy activity transport and injected reads stay lazy", async t => {
  const legacy = await harness(t, { paid: false });
  await legacy.monitor.check();
  assert.deepEqual(legacy.rpcCalls.map(call => call.host), ["legacy-rpc.test"]);
  assert.equal(legacy.leases.length, 0);
  const injected = await harness(t, { dependencies: { getBscActivityImpl: async () => 9,
    qualifyCallImpl: async () => ({ decision: "block" }) } });
  await injected.monitor.check();
  injected.now.value += 5_000; injected.tweets.push({ id: "901", text: `I bought this token ${TOKEN}` });
  await injected.monitor.check();
  assert.equal(injected.loads(), 0);
  assert.equal(injected.rpcCalls.length, 0);
});

test("X default qualification uses paid code/storage/calls without changing global config or proof inputs", async t => {
  const h = await harness(t);
  await h.monitor.check();
  h.now.value += 5_000; h.tweets.push({ id: "901", text: `I bought this token ${TOKEN}` });
  await h.monitor.check();
  assert.equal(h.events.length, 1);
  assert.ok(["eth_getCode", "eth_getStorageAt", "eth_call"].every(method => h.rpcCalls.some(call => call.method === method)));
  assert.ok(h.rpcCalls.every(call => call.host === CHAINSTACK_BSC_HOST));
  assert.equal(h.cfg.fomoCallBscRpcUrl, "https://legacy-rpc.test");
  assert.equal(h.loads(), 1);
  assert.equal(JSON.stringify([h.events, await h.monitor.getState(), h.logs]).includes(SECRET), false);
});

test("X paid errors reject redirects, redact provider credentials, and use at most two endpoints", async t => {
  const h = await harness(t, { rpc: async ({ host }) => {
    if (host === CHAINSTACK_BSC_HOST) return { redirected: true, url: "https://redirect.test/", arrayBuffer() { throw new Error("must not read redirected body"); } };
    throw new Error(`upstream unavailable ${PRIVATE_URL} secret=${SECRET}`);
  } });
  await h.monitor.check();
  assert.deepEqual(h.rpcCalls.map(call => call.host), [CHAINSTACK_BSC_HOST, PUBLIC_HOST]);
  const state = await h.monitor.getState();
  assert.equal(Object.keys(state.transportCircuits).length, 1);
  assert.equal(JSON.stringify([state, h.logs, await fs.readFile(h.monitor.stateFile, "utf8")]).includes(SECRET), false);
});

test("X paid HTTP 429 keeps retry-after and fresh-cache backoff semantics", async t => {
  let healthy = true;
  const h = await harness(t, { rpc: async ({ request }) => healthy
    ? json({ jsonrpc: "2.0", id: request.id, result: "0x7" })
    : json({ error: { code: -32005, message: "rate limited" } },
      { status: 429, headers: { "retry-after": "120" } }) });
  await h.monitor.check();
  healthy = false; h.now.value += 61_000;
  await h.monitor.check();
  const state = await h.monitor.getState();
  const circuit = state.transportCircuits["bsc_activity:alpha"];
  assert.equal(circuit.reason, "http_429");
  assert.ok(circuit.nextRetryAt >= h.now.value + 120_000);
  assert.deepEqual(state.health.sources.x.bscActivityFallbackHandles, ["alpha"]);
  await h.monitor.check();
  assert.equal(h.rpcCalls.length, 3, "open X circuit does not retry a paid or public host");
});

test("X paid JSON-RPC rate hints survive while a later malformed fallback stays fail-closed", async t => {
  for (const hardFallback of [false, true]) {
    const h = await harness(t, { rpc: async ({ host, request }) => json({ jsonrpc: "2.0", id: request.id,
      error: host === PUBLIC_HOST && hardFallback ? { code: -32000, message: "malformed response" }
        : { code: -32005, message: "rate limited", data: { retry_after: 180 } } }) });
    await h.monitor.check();
    const circuit = (await h.monitor.getState()).transportCircuits["bsc_activity:alpha"];
    assert.equal(circuit.reason === "http_429", !hardFallback);
    if (!hardFallback) assert.ok(circuit.nextRetryAt >= h.now.value + 180_000);
  }
});

test("X HTTP 200 JSON-RPC rate limit honors the longest header or payload Retry-After", async t => {
  const h = await harness(t, { rpc: async ({ request }) => json({ jsonrpc: "2.0", id: request.id,
    error: { code: -32005, message: "rate limited", data: { retry_after: 1 } } }, { headers: { "retry-after": "600" } }) });
  await h.monitor.check();
  const circuit = (await h.monitor.getState()).transportCircuits["bsc_activity:alpha"];
  assert.equal(circuit.reason, "http_429");
  assert.ok(circuit.nextRetryAt >= h.now.value + 600_000);
});

test("X caller-supplied safety provider wins without loading private credentials", async t => {
  const methods = [];
  const h = await harness(t, { dependencies: { getBscActivityImpl: async () => 7, bscProvider: {
    getCode: async () => { methods.push("code"); return "0x60006000"; },
    getStorage: async () => { methods.push("storage"); return `0x${word(0)}`; },
    call: async tx => { methods.push("call"); return tx.to.toLowerCase() === PAIR ? `0x${word(1)}${word(2)}${word(0)}` : `0x${word(0)}`; },
  } } });
  await h.monitor.check();
  h.now.value += 5_000; h.tweets.push({ id: "901", text: `I bought this token ${TOKEN}` });
  await h.monitor.check();
  assert.equal(h.events.length, 1);
  assert.ok(methods.includes("code") && methods.includes("storage") && methods.includes("call"));
  assert.equal(h.loads(), 0);
  assert.equal(h.rpcCalls.length, 0);
});

test("X stop aborts paid sockets, holds physical lease until settled, and creates no outage", async t => {
  let started, release, aborted;
  const didStart = new Promise(resolve => { started = resolve; });
  const didAbort = new Promise(resolve => { aborted = resolve; });
  const h = await harness(t, { timeoutMs: 3_000, rpc: ({ options }) => new Promise((_, reject) => {
    release = () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    options.signal.addEventListener("abort", aborted, { once: true });
    started();
  }) });
  const checking = h.monitor.check();
  await didStart;
  let stopped = false;
  const stopping = h.monitor.stop().then(() => { stopped = true; });
  await didAbort;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(h.leases[0].released, false);
  release();
  await Promise.all([checking, stopping]);
  assert.equal(h.leases[0].released, true);
  assert.equal(h.rpcCalls.length, 1, "cancel must not try public fallback");
  assert.equal(h.cooldowns.length, 0);
  assert.equal(Object.keys((await h.monitor.getState()).transportCircuits).length, 0);
});

test("X discards a successful paid result if lease cleanup crosses deadline or stop", async t => {
  for (const mode of ["deadline", "stop"]) {
    let reached, release;
    const reachedRelease = new Promise(resolve => { reached = resolve; });
    const releaseGate = new Promise(resolve => { release = resolve; });
    const h = await harness(t, { timeoutMs: 500, releaseHook: async () => { reached(); await releaseGate; } });
    const checking = h.monitor.check();
    await reachedRelease;
    const stopping = mode === "stop" ? h.monitor.stop() : null;
    if (mode === "deadline") await new Promise(resolve => setTimeout(resolve, 550));
    release();
    await checking;
    await stopping;
    const state = await h.monitor.getState();
    assert.equal(state.roster.alpha?.bscActivity?.count, undefined, `${mode} must not accept stale success`);
    assert.equal(h.rpcCalls.length, 1);
    assert.equal(h.cooldowns.length, 0, "successful transport is not a host outage");
    if (mode === "deadline") assert.equal(state.transportCircuits["bsc_activity:alpha"].reason, "timeout");
    else assert.equal(Object.keys(state.transportCircuits).length, 0);
  }
});
