import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGmgnFlowClient, parseGmgnFlowRateLimit } from "../src/gmgn-flow-client.js";

const EVM = "0x1234567890abcdef1234567890abcdef12345678";
const SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const START = Date.parse("2026-09-19T18:00:00.000Z");

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gmgn-flow-client-"));
  let current = START;
  const calls = [];
  const scheduler = options.scheduler || { tail: Promise.resolve(), lastStartedAt: null, rateLimitedUntil: 0 };
  const execFileImpl = options.execFileImpl || (async (file, args, opts) => {
    calls.push({ file, args, opts, at: current });
    return { stdout: args[0] === "config" ? "configured" : JSON.stringify({ list: [], route: args.slice(0, 2) }) };
  });
  const dependencies = {
    scheduler, now: () => current, sleepImpl: async (ms) => { current += ms; }, execFileImpl,
    ...options.dependencies,
  };
  const config = { dataDir, ...options.config };
  const client = createGmgnFlowClient(config, dependencies);
  t.after(async () => { await client.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { client, calls, config, dependencies, scheduler, dataDir, advance: (ms) => { current += ms; }, current: () => current };
}

test("read-only client builds bounded CLI argv for every route and checks configuration once", async (t) => {
  const { client, calls } = await fixture(t);
  assert.deepEqual(await client.checkConfig(), { ok: true });
  await client.trending("robinhood");
  await client.trades("bsc", "smartmoney");
  await client.trades("eth", "kol");
  await client.candles("sol", SOL, 100, 200);
  await client.stats("base", EVM, "30d");
  await client.info("sol", SOL);
  await client.hotSearches(["monad", "megaeth", "hyperevm", "tron", "monad"]);
  assert.equal(calls.filter((call) => call.args[0] === "config").length, 1);
  assert.deepEqual(calls[1].args, ["market", "trending", "--chain", "robinhood", "--interval", "5m", "--order-by", "volume", "--limit", "50", "--raw"]);
  assert.deepEqual(calls[2].args, ["track", "smartmoney", "--chain", "bsc", "--limit", "200", "--raw"]);
  assert.equal(calls.some((call) => call.args.includes("--side")), false);
  assert.deepEqual(calls[4].args, ["market", "kline", "--chain", "sol", "--address", SOL, "--resolution", "1m", "--from", "100", "--to", "200", "--raw"]);
  assert.deepEqual(calls[5].args, ["portfolio", "stats", "--chain", "base", "--wallet", EVM, "--period", "30d", "--raw"]);
  assert.deepEqual(calls[7].args, ["market", "hot-searches", "--chain", "monad", "--chain", "megaeth", "--chain", "hyperevm", "--chain", "tron", "--interval", "5m", "--limit", "50", "--raw"]);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.opts.shell, false);
    assert.equal(call.opts.maxBuffer, 4 * 1024 * 1024);
    assert.ok(call.opts.timeout <= 15_000);
    if (index) assert.ok(call.at - calls[index - 1].at >= 3000);
  }
});

test("chain capability and address validation reject unsupported or injected inputs before any CLI work", async (t) => {
  const { client, calls } = await fixture(t);
  for (const run of [
    () => client.trending("monad"), () => client.trending("bsc;echo bad"),
    () => client.stats("eth", "--wallet", "7d"), () => client.info("bsc", SOL),
    () => client.info("sol", EVM), () => client.trades("sol", "follow-wallet"),
    () => client.stats("sol", SOL, "1d"), () => client.hotSearches(["all"]),
    () => client.hotSearches([]), () => client.candles("bsc", EVM, 200, 100),
    () => client.candles("bsc", EVM, 1.5, 100),
    () => client.stats("eth", [], "7d"), () => client.stats("eth", Array(21).fill(EVM), "7d"),
    () => client.stats("eth", [EVM, "--raw"], "7d"),
  ]) assert.throws(run, { code: "GMGN_INVALID_ARGUMENT" });
  assert.equal(calls.length, 0);
});

test("wallet stats batch is strictly validated, deduplicated and sent as one CLI request", async (t) => {
  const fx = await fixture(t);
  const second = "0xabcdef1234567890abcdef1234567890abcdef12";
  await fx.client.stats("eth", [EVM, EVM.toUpperCase().replace("0X", "0x"), second], "7d");
  assert.deepEqual(fx.calls[1].args, ["portfolio", "stats", "--chain", "eth", "--wallet",
    EVM.toUpperCase().replace("0X", "0x"), second, "--period", "7d", "--raw"]);
  await fx.client.stats("sol", [SOL, SOL], "30d");
  assert.deepEqual(fx.calls[2].args, ["portfolio", "stats", "--chain", "sol", "--wallet", SOL, "--period", "30d", "--raw"]);
});

test("concurrent routes share one serial process queue and one configuration check", async (t) => {
  let running = 0;
  let maximum = 0;
  let configs = 0;
  const { client } = await fixture(t, { execFileImpl: async (_file, args) => {
    running++; maximum = Math.max(maximum, running);
    await new Promise((resolve) => setImmediate(resolve));
    if (args[0] === "config") configs++;
    running--;
    return { stdout: args[0] === "config" ? "ok" : "{\"list\":[]}" };
  } });
  await Promise.all([client.trending("bsc"), client.trades("sol", "kol"), client.stats("eth", EVM, "7d")]);
  assert.equal(maximum, 1);
  assert.equal(configs, 1);
});

test("separate client instances share the account scheduler and retain a three-second gap", async (t) => {
  const fx = await fixture(t, { config: { gmgnFlowRequestIntervalMs: 1, gmgnFlowRequestTimeoutMs: 99_000 } });
  const other = createGmgnFlowClient(fx.config, fx.dependencies);
  t.after(() => other.stop());
  await Promise.all([fx.client.trending("bsc"), other.trending("eth"), fx.client.trades("sol", "kol")]);
  for (let i = 1; i < fx.calls.length; i++) assert.ok(fx.calls[i].at - fx.calls[i - 1].at >= 3000);
  assert.equal(fx.calls[0].opts.timeout, 15_000);
});

test("rate-limit parser understands CLI GMT+08 reset, numeric reset_at and conservative fallback", () => {
  assert.equal(parseGmgnFlowRateLimit("Rate limit resets at 2026-09-20 02:14:16 GMT+08:00 (~856s remaining)", START), Date.parse("2026-09-19T18:14:16Z"));
  assert.equal(parseGmgnFlowRateLimit({ code: 429, reset_at: (START + 120_000) / 1000 }, START), START + 120_000);
  assert.equal(parseGmgnFlowRateLimit({ stdout: '{"code":429,"error":"RATE_LIMIT_BANNED","reset_at":1789841700}' }, START), 1789841700000);
  assert.equal(parseGmgnFlowRateLimit("HTTP 429", START), START + 60_000);
  assert.equal(parseGmgnFlowRateLimit("provider unavailable", START), null);
  assert.equal(parseGmgnFlowRateLimit("token about API rate limits", START), null);
});

test("429 cooldown is durably stored privately and blocks every route after restart", async (t) => {
  let count = 0;
  const fx = await fixture(t, { execFileImpl: async (_file, args) => {
    count++;
    if (args[0] === "config") return { stdout: "ok" };
    throw Object.assign(new Error("CLI failed"), { stderr: "HTTP 429: Rate limit resets at 2026-09-20 02:14:16 GMT+08:00" });
  } });
  await assert.rejects(fx.client.trending("bsc"), { code: "GMGN_RATE_LIMITED", retryAt: "2026-09-19T18:14:16.000Z" });
  const file = path.join(fx.dataDir, "gmgn-flow-rate-limit.json");
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(persisted.rateLimitedUntil, "2026-09-19T18:14:16.000Z");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(fx.client.info("eth", EVM), { code: "GMGN_RATE_LIMITED" });
  const restarted = createGmgnFlowClient(fx.config, { ...fx.dependencies,
    scheduler: { tail: Promise.resolve(), lastStartedAt: null, rateLimitedUntil: 0 } });
  t.after(() => restarted.stop());
  await assert.rejects(restarted.trades("sol", "kol"), { code: "GMGN_RATE_LIMITED" });
  assert.equal(count, 2);
});

test("successful exit containing a JSON API rate-limit error is not treated as empty data", async (t) => {
  const fx = await fixture(t, { execFileImpl: async (_file, args) => ({ stdout: args[0] === "config" ? "ok"
    : JSON.stringify({ code: 429, error: "RATE_LIMIT_BANNED", reset_at: (START + 100_000) / 1000 }) }) });
  await assert.rejects(fx.client.trending("sol"), { code: "GMGN_RATE_LIMITED" });
  assert.ok(JSON.parse(await fs.readFile(path.join(fx.dataDir, "gmgn-flow-rate-limit.json"), "utf8")).rateLimitedUntil);
});

test("legacy Fomo cooldown is read before request and again after the spacing wait", async (t) => {
  const fx = await fixture(t);
  await fx.client.checkConfig();
  const until = new Date(START + 600_000).toISOString();
  await fs.writeFile(path.join(fx.dataDir, "fomo-call-state.json"), JSON.stringify({ publicOnchain: { smartMoney: { rateLimitedUntil: until } } }));
  await assert.rejects(fx.client.trending("eth"), { code: "GMGN_RATE_LIMITED", retryAt: until });
  assert.equal(fx.calls.length, 1);
  fx.advance(600_001);
  assert.deepEqual(await fx.client.trending("eth"), { list: [], route: ["market", "trending"] });
});

test("a legacy cooldown appearing while waiting for the global request slot prevents the child", async (t) => {
  const fx = await fixture(t);
  await fx.client.checkConfig();
  const other = createGmgnFlowClient(fx.config, { ...fx.dependencies, sleepImpl: async (ms) => {
    fx.advance(ms);
    await fs.writeFile(path.join(fx.dataDir, "fomo-call-state.json"), JSON.stringify({ publicOnchain: {
      smartMoney: { rateLimitedUntil: new Date(START + 600_000).toISOString() },
    } }));
  } });
  t.after(() => other.stop());
  await assert.rejects(other.trending("bsc"), { code: "GMGN_RATE_LIMITED" });
  assert.equal(fx.calls.length, 1);
});

test("malformed cooldown files fail closed rather than bypassing shared account protection", async (t) => {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.dataDir, "gmgn-flow-rate-limit.json"), '{"version":1,"rateLimitedUntil":"bad"}');
  await assert.rejects(fx.client.checkConfig(), { code: "GMGN_STATE_INVALID" });
  assert.equal(fx.calls.length, 0);
});

test("a failed atomic cooldown write latches the client closed without another request", async (t) => {
  let launches = 0;
  const fx = await fixture(t, { dependencies: { fsImpl: { ...fs, rename: async () => { throw new Error("disk fault"); } } },
    execFileImpl: async (_file, args) => {
      launches++;
      if (args[0] === "config") return { stdout: "ok" };
      throw new Error("HTTP 429");
    },
  });
  await assert.rejects(fx.client.trending("sol"), { code: "GMGN_STATE_WRITE_FAILED" });
  fx.advance(600_000);
  await assert.rejects(fx.client.trending("sol"), { code: "GMGN_STATE_WRITE_FAILED" });
  assert.equal(launches, 2);
});

test("ordinary narrative words do not fabricate a rate limit in a successful token response", async (t) => {
  const fx = await fixture(t, { execFileImpl: async (_file, args) => ({ stdout: args[0] === "config" ? "ok"
    : JSON.stringify({ address: EVM, link: { description: "API tooling: rate limit resets at 2030-01-01T00:00:00Z; code 429" } }) }) });
  assert.equal((await fx.client.info("eth", EVM)).address, EVM);
  await assert.rejects(fs.stat(path.join(fx.dataDir, "gmgn-flow-rate-limit.json")), { code: "ENOENT" });
});

test("invalid JSON, error envelopes and unknown CLI failures stay errors without leaking stderr", async (t) => {
  for (const [mode, expected] of [["json", "GMGN_INVALID_RESPONSE"], ["null", "GMGN_INVALID_RESPONSE"],
    ["envelope", "GMGN_API_FAILED"], ["exec", "GMGN_CLI_FAILED"], ["oversize", "GMGN_RESPONSE_TOO_LARGE"]]) {
    await t.test(mode, async (t) => {
      const fx = await fixture(t, { execFileImpl: async (_file, args) => {
        if (args[0] === "config") return { stdout: "ok" };
        if (mode === "exec") throw Object.assign(new Error("secret value in command"), { stderr: "credential=do-not-show" });
        return { stdout: ({ json: "not json", null: "null", envelope: '{"code":503,"message":"unavailable"}',
          oversize: "x".repeat(4 * 1024 * 1024 + 1) })[mode] };
      } });
      await assert.rejects(fx.client.trades("sol", "kol"), (error) => {
        assert.equal(error.code, expected); assert.doesNotMatch(JSON.stringify(error), /secret|credential|do-not-show/); return true;
      });
    });
  }
});

test("stop kills an active child, cancels queued requests and is permanently closed", async (t) => {
  let childStarted;
  const started = new Promise((resolve) => { childStarted = resolve; });
  let killed = 0;
  let launches = 0;
  const fx = await fixture(t, { execFileImpl: (_file, args, _options, callback) => {
    launches++;
    if (args[0] === "config") { queueMicrotask(() => callback(null, "ok", "")); return { kill() {} }; }
    childStarted();
    return { kill(signal) { assert.equal(signal, "SIGKILL"); killed++; } };
  } });
  const first = fx.client.trending("bsc");
  const second = fx.client.trades("sol", "kol");
  const accepted = Promise.allSettled([first, second]);
  await started;
  await fx.client.stop();
  for (const result of await accepted) assert.equal(result.reason.code, "GMGN_STOPPED");
  await assert.rejects(fx.client.info("eth", EVM), { code: "GMGN_STOPPED" });
  assert.equal(killed, 1);
  assert.equal(launches, 2);
});

test("CLI timeout kills the bounded child and rejects rather than stalling the global queue", async (t) => {
  let killed = 0;
  const fx = await fixture(t, { config: { gmgnFlowRequestTimeoutMs: 100 }, execFileImpl: (_file, args, _options, callback) => {
    if (args[0] === "config") queueMicrotask(() => callback(null, "ok", ""));
    return { kill() { killed++; } };
  } });
  await assert.rejects(fx.client.trending("bsc"), { code: "GMGN_CLI_TIMEOUT" });
  assert.equal(killed, 1);
});
