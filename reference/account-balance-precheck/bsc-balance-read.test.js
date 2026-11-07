import assert from "node:assert/strict";
import fs from "node:fs";
import test, { after } from "node:test";
import {
  BSC_BALANCE_READ_URLS,
  readVerifiedBnbBalance,
  readVerifiedUsdtBalance,
  redactObservationError,
} from "./bsc-balance-read.js";

const OBSERVATION_TTL_MS = 30_000;
const OBSERVATION_MAX_AGE_MS = 60_000;

// Local copy of the studio rule after the one-line diagnostic change.
// A failed refresh keeps the previous timestamp. Only status "fresh" is usable.
async function observeRead(cache, key, reader, clock, isValid = Number.isFinite) {
  const prev = cache[key] || { value: null, observedAtMs: null, attemptedAtMs: null, error: null };
  const nowMs = clock();
  if (prev.attemptedAtMs == null || nowMs - prev.attemptedAtMs >= OBSERVATION_TTL_MS) {
    prev.attemptedAtMs = nowMs;
    try {
      const value = Number(await reader());
      if (!isValid(value)) throw new Error("invalid observation");
      prev.value = value;
      prev.observedAtMs = clock();
      prev.error = null;
    } catch (error) {
      prev.error = redactObservationError(error);
    }
  }
  cache[key] = prev;
  const ageMs = prev.observedAtMs == null ? null : Math.max(0, clock() - prev.observedAtMs);
  const status = prev.value == null ? "unavailable"
    : prev.error ? "degraded"
      : ageMs > OBSERVATION_MAX_AGE_MS ? "stale" : "fresh";
  return {
    value: prev.value,
    status,
    observedAt: prev.observedAtMs == null ? null : new Date(prev.observedAtMs).toISOString(),
    ageMs,
    error: prev.error,
  };
}

function usable(observation) {
  return observation?.status === "fresh" ? observation.value : null;
}

const WALLET = `0x${"ab".repeat(20)}`;
const ONE_BNB = "0xde0b6b3a7640000";
const ONE_USDT = `0x${(10n ** 18n).toString(16).padStart(64, "0")}`;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("unexpected network"); };
after(() => { globalThis.fetch = originalFetch; });

const fast = { attemptTimeoutMs: 50, budgetMs: 400 };
function jsonResult(payload, extra = {}) {
  return { status: 200, redirected: false, json: async () => payload, ...extra };
}
function batch(chainId, result) {
  return [
    { jsonrpc: "2.0", id: 1, result: chainId },
    { jsonrpc: "2.0", id: 2, result },
  ];
}
test("verified primary balance is fresh and does not call fallbacks", async () => {
  const seen = [];
  const bodies = [];
  const fetchImpl = async (url, init) => {
    seen.push(new URL(url).hostname);
    bodies.push(JSON.parse(init.body));
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    return jsonResult(batch("0x38", ONE_BNB));
  };
  const cache = {};
  const observation = await observeRead(cache, "bnb", () => readVerifiedBnbBalance(`0x${"AB".repeat(20)}`, fetchImpl), () => 100_000);
  assert.deepEqual(seen, ["bsc-dataseed.bnbchain.org"]);
  assert.deepEqual(BSC_BALANCE_READ_URLS[0], "https://bsc-dataseed.bnbchain.org");
  assert.equal(bodies[0][0].method, "eth_chainId");
  assert.deepEqual(bodies[0][1], { jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: [WALLET, "latest"] });
  assert.equal(observation.status, "fresh");
  assert.equal(observation.value, 1);
  assert.equal(observation.error, null);
  assert.equal(usable(observation), 1);
});

test("timeout on the primary uses the next chain-verified balance", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const hostname = new URL(url).hostname;
    seen.push(hostname);
    if (hostname === "bsc-dataseed.bnbchain.org") {
      return new Promise((_, reject) => {
        const abort = () => {
          const error = new Error("The operation was aborted due to timeout");
          error.name = "TimeoutError";
          reject(error);
        };
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return jsonResult(batch("0x38", ONE_BNB));
  };
  const cache = {};
  const observation = await observeRead(
    cache,
    "bnb",
    () => readVerifiedBnbBalance(WALLET, fetchImpl, fast),
    () => 100_000,
  );
  assert.deepEqual(seen, ["bsc-dataseed.bnbchain.org", "bsc.nodereal.io"]);
  assert.equal(observation.status, "fresh");
  assert.equal(usable(observation), 1);
  assert.equal(observation.observedAt, new Date(100_000).toISOString());
});

test("a wrong chain id cannot satisfy the precheck", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const hostname = new URL(url).hostname;
    seen.push(hostname);
    if (hostname === "bsc.nodereal.io") return jsonResult(batch("0x1", ONE_BNB));
    return jsonResult(batch("0x38", "0x0"));
  };
  const value = await readVerifiedBnbBalance(WALLET, fetchImpl, {
    ...fast,
    urls: ["https://bsc.nodereal.io", "https://bsc-dataseed.ninicoin.io"],
  });
  assert.deepEqual(seen, ["bsc.nodereal.io", "bsc-dataseed.ninicoin.io"]);
  assert.equal(value, 0);
});

test("all candidates failing throws a redacted diagnostic and no balance", async () => {
  const fetchImpl = async (url) => {
    const hostname = new URL(url).hostname;
    if (hostname.endsWith("bnbchain.org")) {
      const error = new Error(`timeout for ${WALLET}`);
      error.name = "TimeoutError";
      throw error;
    }
    if (hostname.endsWith("nodereal.io")) throw Object.assign(new Error("nope"), { code: "CHAIN" });
    return { status: 503, redirected: false, json: async () => batch("0x38", "0x0") };
  };
  const cache = {};
  const observation = await observeRead(cache, "bnb", () => readVerifiedBnbBalance(WALLET, fetchImpl, {
    ...fast,
    urls: BSC_BALANCE_READ_URLS,
  }), () => 100_000);
  assert.equal(observation.status, "unavailable");
  assert.equal(observation.value, null);
  assert.equal(usable(observation), null);
  assert.equal(observation.error, "balance read failed: bsc-dataseed.bnbchain.org timeout; bsc.nodereal.io chain mismatch; bsc-dataseed.ninicoin.io http 503");
  assert.equal(observation.error.includes(WALLET), false);
  await assert.rejects(
    () => readVerifiedBnbBalance(WALLET, fetchImpl, { ...fast, urls: ["https://user:secret@bsc.nodereal.io/path"] }),
    (error) => {
      assert.equal(error.message, "balance read failed: invalid-url rejected");
      assert.equal(error.message.includes("secret"), false);
      return true;
    },
  );
});

test("stale or degraded observations keep the old timestamp and are not fresh", async () => {
  const degradedCache = {
    bnb: { value: 1.5, observedAtMs: 0, attemptedAtMs: 0, error: null },
  };
  let reads = 0;
  const degraded = await observeRead(degradedCache, "bnb", async () => {
    reads += 1;
    throw new Error(`rpc unavailable ${WALLET}`);
  }, () => 100_000);
  assert.equal(reads, 1);
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.value, 1.5);
  assert.equal(degraded.observedAt, new Date(0).toISOString());
  assert.equal(degraded.ageMs, 100_000);
  assert.equal(degraded.error, "rpc unavailable [redacted]");
  assert.equal(usable(degraded), null);

  const staleCache = {
    bnb: { value: 1.5, observedAtMs: 100_000 - 61_000, attemptedAtMs: 100_000, error: null },
  };
  const stale = await observeRead(staleCache, "bnb", async () => { throw new Error("must not run"); }, () => 100_000);
  assert.equal(stale.status, "stale");
  assert.equal(stale.value, 1.5);
  assert.equal(stale.observedAt, new Date(39_000).toISOString());
  assert.equal(usable(stale), null);
  assert.equal(redactObservationError(new Error("")), "读取失败");
});

test("USDT balance uses the same chain check and 18-decimal conversion", async () => {
  let data;
  const value = await readVerifiedUsdtBalance(WALLET, async (_url, init) => {
    data = JSON.parse(init.body)[1];
    return jsonResult(batch("0x38", ONE_USDT));
  }, fast);
  assert.equal(value, 1);
  assert.equal(data.method, "eth_call");
  assert.equal(data.params[0].to, "0x55d398326f99059ff775485246999027b3197955");
  assert.equal(data.params[0].data, `0x70a08231${WALLET.slice(2).padStart(64, "0")}`);
  assert.equal(await readVerifiedBnbBalance(WALLET, async () => jsonResult(batch("0x38", "0x14d1120d7b160000")), fast), 1.5);
});

test("the shared eight second budget stops a hanging endpoint", async () => {
  let calls = 0;
  const started = Date.now();
  await assert.rejects(() => readVerifiedBnbBalance(WALLET, async () => {
    calls += 1;
    return new Promise(() => {});
  }, { attemptTimeoutMs: 30, budgetMs: 80, urls: BSC_BALANCE_READ_URLS }));
  const elapsed = Date.now() - started;
  assert.ok(calls >= 1 && calls <= 3);
  assert.ok(elapsed < 500, `elapsed ${elapsed}`);
});

test("local patch matches this reader and does not loosen freshness or trading gates", () => {
  const patch = fs.readFileSync(new URL("./apply-to-local-worktree.patch", import.meta.url), "utf8");
  const source = fs.readFileSync(new URL("./bsc-balance-read.js", import.meta.url), "utf8");
  const marker = "+++ b/src/bsc-balance-read.js\n";
  const start = patch.indexOf(marker);
  assert.ok(start > 0);
  const rest = patch.slice(start + marker.length);
  const next = rest.search(/\n--- /);
  const hunk = next === -1 ? rest : rest.slice(0, next);
  const rebuilt = `${hunk.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n")}\n`;
  assert.equal(rebuilt, source);
  assert.match(patch, /\+import \{ readVerifiedBnbBalance, readVerifiedUsdtBalance, redactObservationError \} from "\.\/bsc-balance-read\.js";/);
  assert.match(patch, /\+      prev\.error = redactObservationError\(error\);/);
  assert.match(patch, /^-      prev\.error = '读取失败';/m);
  assert.equal(patch.includes("-export const READ_TIMEOUT_MS"), false);
  assert.equal(patch.includes("+const OBSERVATION_MAX_AGE_MS"), false);
  assert.equal(patch.includes("+const OBSERVATION_TTL_MS"), false);
  assert.equal(/\n\+.*(?:checkGates|maxPerTradeUsd|dailyLossStop|signalSource|LIVE_MAX)/.test(patch), false);
  assert.equal(source.includes("process.env"), false);
  assert.equal(/eth_send|personal_sign|signTransaction/.test(source), false);
});
