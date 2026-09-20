import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

import { createNarrativeBscJsonRpcReader } from "../src/narrative-bsc-json-rpc-reader.js";

const URL = "https://rpc-a.example/rpc";
const BLOCK_HASH = `0x${"ab".repeat(32)}`;
const TO = "0x1111111111111111111111111111111111111111";

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

function readerWith(handler, overrides = {}) {
  const requests = [];
  const reader = createNarrativeBscJsonRpcReader({
    rpcId: "bsc.quote.a",
    url: URL,
    requestTimeoutMs: 500,
    ...overrides,
  }, {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, options, body });
      const result = await handler(body, options);
      return result instanceof Response ? result : jsonResponse({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  return { reader, requests };
}

test("exposes exactly one strict, read-only RPC origin and normalizes standard responses", async () => {
  const { reader, requests } = readerWith((body) => {
    if (body.method === "eth_chainId") return "0x38";
    if (body.method === "eth_blockNumber") return "0x64";
    if (body.method === "eth_getBlockByNumber") {
      return { number: "0x63", hash: BLOCK_HASH, timestamp: "0x5f5e100", transactions: [] };
    }
    if (body.method === "eth_call") return "0x1234";
    throw new Error("unexpected method");
  });

  assert.deepEqual(Object.keys(reader).sort(), ["call", "getBlock", "getBlockNumber", "getNetwork", "rpcId", "trustDomain"]);
  assert.equal(Object.isFrozen(reader), true);
  assert.equal(reader.trustDomain, "rpc-a.example");
  assert.deepEqual(await reader.getNetwork(), { chainId: 56 });
  assert.equal(await reader.getBlockNumber(), 100);
  assert.deepEqual(await reader.getBlock(99), { number: 99, hash: BLOCK_HASH, timestamp: 100_000_000 });
  assert.equal(await reader.call({ to: TO, data: "0x1234", blockTag: 99 }), "0x1234");
  assert.deepEqual(requests.map(({ body }) => body.method), [
    "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_call",
  ]);
  assert.deepEqual(requests[2].body.params, ["0x63", false]);
  assert.deepEqual(requests[3].body.params, [{ to: TO, data: "0x1234" }, "0x63"]);
  assert.ok(requests.every(({ options }) => options.method === "POST" && options.signal instanceof AbortSignal));
  assert.ok(requests.every(({ options }) => options.redirect === "error"));
  for (const forbidden of ["send", "getSigner", "sendTransaction", "broadcastTransaction", "wallet", "swap"]) {
    assert.equal(forbidden in reader, false);
  }
});

test("groups sibling RPC subdomains into one provider trust domain", () => {
  const make = (rpcId, url) => createNarrativeBscJsonRpcReader({ rpcId, url }, {
    fetchImpl: async () => { throw new Error("unused"); },
  });
  assert.equal(make("a", "https://a.vendor.example/rpc").trustDomain, "vendor.example");
  assert.equal(make("b", "https://b.vendor.example/rpc").trustDomain, "vendor.example");
});

test("rejects response identity conflicts, JSON-RPC errors, noncanonical quantities, and wrong chains", async (t) => {
  const cases = [
    ["wrong id", (body) => jsonResponse({ jsonrpc: "2.0", id: body.id + 1, result: "0x38" }), /identity or shape/u],
    ["extra alias", (body) => jsonResponse({ jsonrpc: "2.0", id: body.id, result: "0x38", chainId: 56 }), /identity or shape/u],
    ["result and error", (body) => jsonResponse({ jsonrpc: "2.0", id: body.id, result: "0x38", error: { code: -1 } }), /identity or shape/u],
    ["rpc error", (body) => jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "no" } }), /returned an error/u],
    ["noncanonical quantity", () => "0x038", /canonical JSON-RPC quantity/u],
    ["wrong chain", () => "0x1", /chain id mismatch/u],
  ];
  for (const [name, handler, expected] of cases) {
    await t.test(name, async () => {
      const { reader } = readerWith(handler);
      await assert.rejects(reader.getNetwork(), expected);
    });
  }
});

test("an external abort stops a hanging read and reaches the physical fetch signal", async () => {
  let physicalSignal;
  const { reader } = readerWith((_body, options) => {
    physicalSignal = options.signal;
    return new Promise(() => {});
  }, { requestTimeoutMs: 1_000 });
  const controller = new AbortController();
  const pending = reader.getNetwork({ signal: controller.signal });
  controller.abort(new Error("test abort"));
  await assert.rejects(Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("reader did not abort")), 100)),
  ]), /test abort/u);
  assert.equal(physicalSignal.aborted, true);
});

test("enforces its own timeout and bounded response body", async (t) => {
  await t.test("timeout", async () => {
    let signal;
    const { reader } = readerWith((_body, options) => {
      signal = options.signal;
      return new Promise(() => {});
    }, { requestTimeoutMs: 100 });
    await assert.rejects(reader.getNetwork(), /timed out/u);
    assert.equal(signal.aborted, true);
  });
  await t.test("body limit", async () => {
    const { reader } = readerWith((body) => jsonResponse(
      { jsonrpc: "2.0", id: body.id, result: `0x${"00".repeat(1_000)}` },
      { headers: { "content-length": "5000000" } },
    ), { maxResponseBytes: 1_024 });
    await assert.rejects(reader.getNetwork(), /byte limit/u);
  });
});

test("releases abort listeners for every chunk and rejects redirects", async (t) => {
  await t.test("chunk listeners", async () => {
    let physicalSignal;
    const { reader } = readerWith((body, options) => {
      physicalSignal = options.signal;
      const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x38" }));
      return new Response(new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }), { status: 200 });
    });
    assert.deepEqual(await reader.getNetwork(), { chainId: 56 });
    assert.equal(getEventListeners(physicalSignal, "abort").length, 0);
  });
  await t.test("redirect", async () => {
    const reader = createNarrativeBscJsonRpcReader({ rpcId: "redirect", url: URL }, {
      fetchImpl: async () => ({
        status: 200,
        redirected: true,
        url: "https://evil.example/rpc",
        headers: new Headers(),
      }),
    });
    await assert.rejects(reader.getNetwork(), /redirect/u);
  });
});
