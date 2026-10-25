import test from "node:test";
import assert from "node:assert/strict";
import { createRpcPool } from "../src/bsc-launchpad-monitor.js";

test("HTTP 429 transport preserves bounded JSON Retry-After without another physical request", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const current = 1_700_000_000_000;
  const envelope = (data) => JSON.stringify({
    jsonrpc: "2.0", id: 1,
    error: { code: 429, message: "private-response-sentinel", data },
  });
  const scenarios = [
    { name: "body milliseconds survive the five-minute backoff cap", body: envelope({ retry_after_ms: 600_000 }), expected: 600_000 },
    { name: "body longer than header wins", header: "120", body: envelope({ retry_after_ms: 600_000 }), expected: 600_000 },
    { name: "header longer than body wins", header: "900", body: envelope({ retry_after_ms: 600_000 }), expected: 900_000 },
    { name: "HTTP-date header longer than body wins", header: new Date(current + 900_000).toUTCString(), body: envelope({ retry_after_ms: 600_000 }), expected: 900_000 },
    { name: "numeric seconds are supported", body: envelope({ retry_after: 600 }), expected: 600_000 },
    { name: "numeric string milliseconds are supported", body: envelope({ retry_after_ms: "600000" }), expected: 600_000 },
    { name: "root hints take the longer unit", body: JSON.stringify({ retry_after: 120, retry_after_ms: 600_000 }), expected: 600_000 },
    { name: "short body hint cannot shorten the minute fallback", body: envelope({ retry_after_ms: 30_000 }), expected: 60_000 },
    { name: "header-only semantics are unchanged", header: "17", body: envelope({}), expected: 17_000 },
    { name: "negative hints are ignored", body: envelope({ retry_after_ms: -600_000, retry_after: -600 }), expected: 60_000 },
    { name: "boolean hints are ignored", body: envelope({ retry_after_ms: true, retry_after: true }), expected: 60_000 },
    { name: "null hints are ignored", body: envelope({ retry_after_ms: null, retry_after: null }), expected: 60_000 },
    { name: "object and array hints are ignored", body: envelope({ retry_after_ms: {}, retry_after: [600] }), expected: 60_000 },
    { name: "non-numeric and nonfinite strings are ignored", body: envelope({ retry_after_ms: "600000ms", retry_after: "Infinity" }), expected: 60_000 },
    { name: "overflowing deadlines are ignored", body: envelope({ retry_after_ms: Number.MAX_SAFE_INTEGER, retry_after: 1e300 }), expected: 60_000 },
    { name: "arbitrary nested fields are not traversed", body: envelope({ nested: { retry_after_ms: 600_000 } }), expected: 60_000 },
    { name: "malformed JSON leaves the minute fallback", body: '{"retry_after_ms":600000', expected: 60_000 },
    { name: "oversized JSON is not parsed", body: JSON.stringify({ retry_after_ms: 600_000, padding: "x".repeat(64 * 1_024) }), expected: 60_000 },
    { name: "range-cap 429 without hints keeps shared cooldown", body: JSON.stringify({ code: 8, message: "public eth_getLogs is limited to 1000 blocks" }), expected: 60_000 },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let physicalRequests = 0;
      globalThis.fetch = async (_url, options) => {
        physicalRequests++;
        const payload = JSON.parse(Buffer.from(options.body).toString());
        assert.equal(payload.method, "eth_blockNumber", "only a read-only mocked method is allowed");
        return new Response(scenario.body, {
          status: 429,
          headers: { "content-type": "application/json", ...(scenario.header ? { "retry-after": scenario.header } : {}) },
        });
      };
      const pool = createRpcPool(["https://rpc.body-retry.test"], [], 1, {
        now: () => current, hostCircuitRegistry: new Map(), requestTimeoutMs: 1_000,
      });
      try {
        const assertCooldown = (error) => {
          assert.equal(error.rpcFailureScope, "host");
          assert.equal(error.retryAfterMs, scenario.expected);
          assert.equal(error.rpcHostRetryAfterMs, scenario.expected);
          assert.ok(!JSON.stringify({ ...error, message: error.message, stack: error.stack }).includes("private-response-sentinel"));
          return true;
        };
        await assert.rejects(pool.getBlockNumber(), assertCooldown);
        await assert.rejects(pool.getBlock(1), assertCooldown);
        assert.equal(physicalRequests, 1, "HTTP 429 must not retry internally or bypass the shared host cooldown");
      } finally { pool.destroy(); }
    });
  }
});

test("nested JSON RPC error wrappers preserve millisecond and second hints", async (t) => {
  for (const [name, hint] of [
    ["millisecond hint", { retry_after_ms: 600_000 }],
    ["second hint", { retry_after: 600 }],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const pool = createRpcPool(["https://rpc.wrapped-retry.test"], [], 1, {
        now: () => 1_700_000_000_000,
        hostCircuitRegistry: new Map(),
        providerFactory: () => ({ async getBlockNumber() {
          calls++;
          throw Object.assign(new Error("HTTP 429"), {
            status: 429, info: { error: { data: hint } },
          });
        } }),
      });
      try {
        await assert.rejects(pool.getBlockNumber(), error =>
          error.retryAfterMs === 600_000 && error.rpcHostRetryAfterMs === 600_000 && error.rpcFailureScope === "host");
        assert.equal(calls, 1);
      } finally { pool.destroy(); }
    });
  }
});
