import test from "node:test";
import assert from "node:assert/strict";
import { createPonReadOnlyRpcProvider } from "../src/pon-rpc-provider.js";

const CHAIN_ID = 4663;

function fakeProvider({ chainId = CHAIN_ID, methods = {}, delay = 0 } = {}) {
  let active = 0;
  let maximumActive = 0;
  let destroyed = 0;
  const run = async (method, args) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (method === "send" && args[0] === "eth_chainId") return `0x${chainId.toString(16)}`;
      if (typeof methods[method] === "function") return methods[method](...args);
      return methods[method];
    } finally { active -= 1; }
  };
  return {
    send: (...args) => run("send", args),
    getBlockNumber: (...args) => run("getBlockNumber", args),
    getBlock: (...args) => run("getBlock", args),
    getCode: (...args) => run("getCode", args),
    getLogs: (...args) => run("getLogs", args),
    call: (...args) => run("call", args),
    getTransaction: (...args) => run("getTransaction", args),
    getTransactionReceipt: (...args) => run("getTransactionReceipt", args),
    destroy: async () => { destroyed += 1; },
    stats: () => ({ maximumActive, destroyed }),
  };
}

test("Pon RPC pool rejects the wrong chain before serving reads and falls back", async (t) => {
  const wrong = fakeProvider({ chainId: 1, methods: { getBlockNumber: 1 } });
  const correct = fakeProvider({ methods: { getBlockNumber: 123 } });
  const pool = createPonReadOnlyRpcProvider(["https://wrong.test", "https://correct.test"], CHAIN_ID, {
    providerFactory: (_url, index) => [wrong, correct][index],
  });
  t.after(() => pool.destroy());

  assert.equal(await pool.getBlockNumber(), 123);
  assert.equal(wrong.stats().maximumActive, 1, "the wrong endpoint performed only its identity probe");
});

test("method capability failure is isolated while the endpoint remains usable for current reads", async (t) => {
  let current = 1_000;
  const primary = fakeProvider({ methods: {
    getLogs: () => { throw new Error("Archive requests require a personal token"); },
    getBlockNumber: 200,
  } });
  const fallback = fakeProvider({ methods: { getLogs: [{ blockNumber: 10 }], getBlockNumber: 201 } });
  const pool = createPonReadOnlyRpcProvider(["https://primary.test", "https://fallback.test"], CHAIN_ID, {
    providerFactory: (_url, index) => [primary, fallback][index],
    now: () => current,
  });
  t.after(() => pool.destroy());

  assert.deepEqual(await pool.getLogs({ fromBlock: 10, toBlock: 10 }), [{ blockNumber: 10 }]);
  assert.equal(await pool.getBlockNumber(), 200, "archive rejection must not globally disable current reads");
  current += 1_000;
  assert.deepEqual(await pool.getLogs({ fromBlock: 10, toBlock: 10 }), [{ blockNumber: 10 }]);
});

test("one failed pinned call cannot poison the other thirteen Factory getters", async (t) => {
  const calls = Array.from({ length: 14 }, (_, index) => ({
    to: "0xF698d13348686C1529c2DC54847C123424d9DAE0",
    data: `0x${index.toString(16).padStart(8, "0")}`,
    blockTag: 60_000_000,
  }));
  const primaryCalls = [];
  const fallbackCalls = [];
  const primary = fakeProvider({ methods: {
    call: (request) => {
      primaryCalls.push(structuredClone(request));
      if (request.data === calls[5].data) throw new Error("missing revert data");
      return request.data;
    },
  } });
  const fallback = fakeProvider({ methods: {
    call: (request) => {
      fallbackCalls.push(structuredClone(request));
      return request.data;
    },
  } });
  const pool = createPonReadOnlyRpcProvider(["https://primary.test", "https://fallback.test"], CHAIN_ID, {
    providerFactory: (_url, index) => [primary, fallback][index],
  });
  t.after(() => pool.destroy());

  assert.deepEqual(await Promise.all(calls.map((request) => pool.call(request))), calls.map((request) => request.data));
  assert.equal(primaryCalls.length, 14, "the failed sixth selector must not open a call-family circuit");
  assert.deepEqual(fallbackCalls, [calls[5]], "only the exact failed call may use fallback");
});

test("transient call circuit is exact to calldata and pinned block", async (t) => {
  let current = 10_000;
  let primaryAttempts = 0;
  const failed = { to: "0x1111111111111111111111111111111111111111", data: "0x12345678", blockTag: 100 };
  const primary = fakeProvider({ methods: {
    call: (request) => {
      primaryAttempts += 1;
      if (request.data === failed.data && request.blockTag === failed.blockTag) throw new Error("temporary upstream reset");
      return "0x01";
    },
  } });
  const fallback = fakeProvider({ methods: { call: () => "0x02" } });
  const pool = createPonReadOnlyRpcProvider(["https://primary.test", "https://fallback.test"], CHAIN_ID, {
    providerFactory: (_url, index) => [primary, fallback][index],
    now: () => current,
  });
  t.after(() => pool.destroy());

  assert.equal(await pool.call(failed), "0x02");
  assert.equal(await pool.call({ ...failed, data: "0x87654321" }), "0x01");
  assert.equal(await pool.call({ ...failed, blockTag: 101 }), "0x01");
  assert.equal(await pool.call(failed), "0x02", "the exact failed call remains briefly cooled");
  assert.equal(primaryAttempts, 3);
  current += 15_001;
  assert.equal(await pool.call({ ...failed, blockTag: 101 }), "0x01");
});

test("one timed-out selector falls back without changing its pinned block or disabling peers", async (t) => {
  const first = { to: "0x2222222222222222222222222222222222222222", data: "0xaaaaaaaa", blockTag: 222 };
  const second = { ...first, data: "0xbbbbbbbb" };
  const observed = [];
  const timeout = Object.assign(new Error("request timed out after 4000ms"), { code: "TIMEOUT" });
  const primary = fakeProvider({ methods: {
    call: (request) => {
      observed.push(["primary", structuredClone(request)]);
      if (request.data === first.data) throw timeout;
      return "0x11";
    },
  } });
  const fallback = fakeProvider({ methods: {
    call: (request) => {
      observed.push(["fallback", structuredClone(request)]);
      return "0x22";
    },
  } });
  const pool = createPonReadOnlyRpcProvider(["https://primary.test", "https://fallback.test"], CHAIN_ID, {
    providerFactory: (_url, index) => [primary, fallback][index],
  });
  t.after(() => pool.destroy());

  assert.equal(await pool.call(first), "0x22");
  assert.equal(await pool.call(second), "0x11");
  assert.deepEqual(observed.map(([, request]) => request.blockTag), [222, 222, 222]);
  assert.equal(observed.some(([, request]) => request.blockTag === "latest"), false);
});

test("nested archive HTTP 403 cools the endpoint pinned-call family without disabling current reads", async (t) => {
  const archiveError = Object.assign(new Error("missing revert data"), {
    code: "CALL_EXCEPTION",
    status: 403,
    info: { error: { message: "Archive requests require a personal token" } },
  });
  const first = { to: "0x3333333333333333333333333333333333333333", data: "0x11111111", blockTag: 300 };
  const second = { ...first, data: "0x22222222" };
  const latest = { to: first.to, data: "0x33333333" };
  const primaryCalls = [];
  const fallbackCalls = [];
  const primary = fakeProvider({ methods: {
    call: (request) => {
      primaryCalls.push(structuredClone(request));
      if (request.blockTag !== undefined) throw archiveError;
      return "0x01";
    },
    getBlockNumber: 400,
  } });
  const fallback = fakeProvider({ methods: {
    call: (request) => {
      fallbackCalls.push(structuredClone(request));
      return "0x02";
    },
    getBlockNumber: 401,
  } });
  const pool = createPonReadOnlyRpcProvider(["https://primary.test", "https://fallback.test"], CHAIN_ID, {
    providerFactory: (_url, index) => [primary, fallback][index],
  });
  t.after(() => pool.destroy());

  assert.equal(await pool.call(first), "0x02");
  assert.equal(await pool.call(second), "0x02");
  assert.equal(await pool.call(latest), "0x01");
  assert.equal(await pool.getBlockNumber(), 400);
  assert.deepEqual(primaryCalls, [first, latest], "only the first pinned selector may pay the archive probe");
  assert.deepEqual(fallbackCalls, [first, second]);
});

test("a pinned getCode archive policy never disables latest getCode on the same endpoint", async (t) => {
  const archiveError = Object.assign(new Error("missing revert data"), {
    status: 403,
    info: { error: { message: "Archive requests require a personal token" } },
  });
  const primaryReads = [];
  const fallbackReads = [];
  const primary = fakeProvider({ methods: {
    getCode: (candidate, blockTag) => {
      primaryReads.push([candidate, blockTag]);
      if (blockTag !== undefined) throw archiveError;
      return "0x11";
    },
  } });
  const fallback = fakeProvider({ methods: {
    getCode: (candidate, blockTag) => {
      fallbackReads.push([candidate, blockTag]);
      return "0x22";
    },
  } });
  const pool = createPonReadOnlyRpcProvider(["https://primary.test", "https://fallback.test"], CHAIN_ID, {
    providerFactory: (_url, index) => [primary, fallback][index],
  });
  t.after(() => pool.destroy());

  assert.equal(await pool.getCode("0x1111111111111111111111111111111111111111", 100), "0x22");
  assert.equal(await pool.getCode("0x2222222222222222222222222222222222222222", 101), "0x22");
  assert.equal(await pool.getCode("0x3333333333333333333333333333333333333333"), "0x11");
  assert.deepEqual(primaryReads, [
    ["0x1111111111111111111111111111111111111111", 100],
    ["0x3333333333333333333333333333333333333333", undefined],
  ]);
  assert.equal(fallbackReads.length, 2, "the second pinned code read must reuse the scoped archive circuit");
});

test("historical getBlock and getLogs archive circuits remain separate from current reads", async (t) => {
  const archiveError = Object.assign(new Error("missing revert data"), {
    info: { error: { message: "Archive requests require a personal token" } },
  });
  const primaryBlocks = [];
  const fallbackBlocks = [];
  const primaryLogs = [];
  const fallbackLogs = [];
  const primary = fakeProvider({ methods: {
    getBlock: (blockTag) => {
      primaryBlocks.push(blockTag);
      if (blockTag !== "latest") throw archiveError;
      return { number: 500 };
    },
    getLogs: (filter) => {
      primaryLogs.push(structuredClone(filter));
      if (filter.fromBlock !== "latest" || filter.toBlock !== "latest") throw archiveError;
      return [{ source: "primary-current" }];
    },
  } });
  const fallback = fakeProvider({ methods: {
    getBlock: (blockTag) => {
      fallbackBlocks.push(blockTag);
      return { number: Number(blockTag) };
    },
    getLogs: (filter) => {
      fallbackLogs.push(structuredClone(filter));
      return [{ source: "fallback-pinned" }];
    },
  } });
  const pool = createPonReadOnlyRpcProvider(["https://primary.test", "https://fallback.test"], CHAIN_ID, {
    providerFactory: (_url, index) => [primary, fallback][index],
  });
  t.after(() => pool.destroy());

  assert.deepEqual(await pool.getBlock(100), { number: 100 });
  assert.deepEqual(await pool.getBlock(101), { number: 101 });
  assert.deepEqual(await pool.getBlock("latest"), { number: 500 });
  const fixedOne = { fromBlock: 10, toBlock: 20 };
  const fixedTwo = { fromBlock: 21, toBlock: 30 };
  const current = { fromBlock: "latest", toBlock: "latest" };
  assert.deepEqual(await pool.getLogs(fixedOne), [{ source: "fallback-pinned" }]);
  assert.deepEqual(await pool.getLogs(fixedTwo), [{ source: "fallback-pinned" }]);
  assert.deepEqual(await pool.getLogs(current), [{ source: "primary-current" }]);
  assert.deepEqual(primaryBlocks, [100, "latest"]);
  assert.deepEqual(fallbackBlocks, [100, 101]);
  assert.deepEqual(primaryLogs, [fixedOne, current]);
  assert.deepEqual(fallbackLogs, [fixedOne, fixedTwo]);
});

test("recent pinned missing-trie failures for getCode, getBlock, and getLogs never poison current reads", async (t) => {
  const missingTrie = Object.assign(new Error("missing revert data"), {
    code: "CALL_EXCEPTION",
    info: { error: { message: "missing trie node 0xaaa" } },
  });
  const address = "0x4444444444444444444444444444444444444444";
  const pinnedLogs = { fromBlock: 900, toBlock: 910 };
  const currentLogs = { fromBlock: "latest", toBlock: "latest" };
  const primaryReads = [];
  const fallbackReads = [];
  const primary = fakeProvider({ methods: {
    getBlockNumber: 1_000,
    getCode: (candidate, blockTag) => {
      primaryReads.push(["getCode", candidate, blockTag]);
      if (blockTag === 900) throw missingTrie;
      return "0x11";
    },
    getBlock: (blockTag) => {
      primaryReads.push(["getBlock", blockTag]);
      if (blockTag === 900) throw missingTrie;
      return { number: 1_000, source: "primary-current" };
    },
    getLogs: (filter) => {
      primaryReads.push(["getLogs", structuredClone(filter)]);
      if (filter.fromBlock === 900) throw missingTrie;
      return [{ source: "primary-current" }];
    },
  } });
  const fallback = fakeProvider({ methods: {
    getCode: (candidate, blockTag) => {
      fallbackReads.push(["getCode", candidate, blockTag]);
      return "0x22";
    },
    getBlock: (blockTag) => {
      fallbackReads.push(["getBlock", blockTag]);
      return { number: blockTag, source: "fallback-pinned" };
    },
    getLogs: (filter) => {
      fallbackReads.push(["getLogs", structuredClone(filter)]);
      return [{ source: "fallback-pinned" }];
    },
  } });
  const pool = createPonReadOnlyRpcProvider(["https://primary.test", "https://fallback.test"], CHAIN_ID, {
    providerFactory: (_url, index) => [primary, fallback][index],
  });
  t.after(() => pool.destroy());

  assert.equal(await pool.getBlockNumber(), 1_000);

  assert.equal(await pool.getCode(address, 900), "0x22");
  assert.equal(await pool.getCode(address), "0x11");

  assert.deepEqual(await pool.getBlock(900), { number: 900, source: "fallback-pinned" });
  assert.deepEqual(await pool.getBlock("latest"), { number: 1_000, source: "primary-current" });

  assert.deepEqual(await pool.getLogs(pinnedLogs), [{ source: "fallback-pinned" }]);
  assert.deepEqual(await pool.getLogs(currentLogs), [{ source: "primary-current" }]);

  assert.deepEqual(primaryReads, [
    ["getCode", address, 900],
    ["getCode", address, undefined],
    ["getBlock", 900],
    ["getBlock", "latest"],
    ["getLogs", pinnedLogs],
    ["getLogs", currentLogs],
  ]);
  assert.deepEqual(fallbackReads, [
    ["getCode", address, 900],
    ["getBlock", 900],
    ["getLogs", pinnedLogs],
  ]);
});

test("deep pinned missing-trie capability circuits stay exact for non-call reads", async (t) => {
  const missingTrie = () => Object.assign(new Error("missing revert data"), {
    info: { error: { message: "missing trie node 0xbbb" } },
  });
  const address = "0x5555555555555555555555555555555555555555";
  const scenarios = [
    {
      name: "getCode",
      invokePinned: (pool) => pool.getCode(address, 600),
      invokeCurrent: (pool) => pool.getCode(address),
      currentValue: "0x11",
      methods: (attempts) => ({
        getCode: (_candidate, blockTag) => {
          attempts.push(blockTag);
          if (blockTag === 600) throw missingTrie();
          return "0x11";
        },
      }),
      fallbackMethods: { getCode: () => "0x22" },
    },
    {
      name: "getBlock",
      invokePinned: (pool) => pool.getBlock(600),
      invokeCurrent: (pool) => pool.getBlock("latest"),
      currentValue: { number: 1_000 },
      methods: (attempts) => ({
        getBlock: (blockTag) => {
          attempts.push(blockTag);
          if (blockTag === 600) throw missingTrie();
          return { number: 1_000 };
        },
      }),
      fallbackMethods: { getBlock: (blockTag) => ({ number: blockTag }) },
    },
    {
      name: "getLogs",
      invokePinned: (pool) => pool.getLogs({ fromBlock: 600, toBlock: 610 }),
      invokeCurrent: (pool) => pool.getLogs({ fromBlock: "latest", toBlock: "latest" }),
      currentValue: [{ source: "primary" }],
      methods: (attempts) => ({
        getLogs: (filter) => {
          attempts.push(structuredClone(filter));
          if (filter.fromBlock === 600) throw missingTrie();
          return [{ source: "primary" }];
        },
      }),
      fallbackMethods: { getLogs: () => [{ source: "fallback" }] },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const primaryAttempts = [];
      const primary = fakeProvider({ methods: {
        getBlockNumber: 1_000,
        ...scenario.methods(primaryAttempts),
      } });
      const fallback = fakeProvider({ methods: scenario.fallbackMethods });
      const pool = createPonReadOnlyRpcProvider(
        ["https://primary.test", "https://fallback.test"],
        CHAIN_ID,
        {
          providerFactory: (_url, index) => [primary, fallback][index],
          sleep: async () => assert.fail("deep pinned missing-trie must not be rechecked"),
        },
      );
      subtest.after(() => pool.destroy());

      assert.equal(await pool.getBlockNumber(), 1_000);
      await scenario.invokePinned(pool);
      await scenario.invokePinned(pool);
      assert.deepEqual(await scenario.invokeCurrent(pool), scenario.currentValue);
      assert.equal(primaryAttempts.length, 2, "the exact deep read is cooled while current remains on primary");
    });
  }
});

test("recent missing-trie is an exact transient with one fixed-block bounded recheck", async (t) => {
  const request = {
    to: "0x3434343434343434343434343434343434343434",
    data: "0x34343434",
    blockTag: 900,
  };
  const peer = { ...request, data: "0x45454545" };
  const attempts = [];
  let primaryCalls = 0;
  const missingTrie = Object.assign(new Error("missing revert data"), {
    code: "CALL_EXCEPTION",
    info: { error: { message: "missing trie node 0xabc" } },
  });
  const primary = fakeProvider({ methods: {
    getBlockNumber: 1_000,
    call: (observed) => {
      attempts.push(["primary", structuredClone(observed)]);
      primaryCalls += 1;
      if (primaryCalls === 1) throw missingTrie;
      return "0x01";
    },
  } });
  const fallback = fakeProvider({ methods: {
    call: (observed) => {
      attempts.push(["fallback", structuredClone(observed)]);
      throw new Error("method is not supported");
    },
  } });
  const pool = createPonReadOnlyRpcProvider(["https://primary.test", "https://fallback.test"], CHAIN_ID, {
    providerFactory: (_url, index) => [primary, fallback][index],
    sleep: async (ms) => { assert.equal(ms, 100); },
  });
  t.after(() => pool.destroy());

  assert.equal(await pool.getBlockNumber(), 1_000);
  assert.equal(await pool.call(request), "0x01");
  assert.deepEqual(attempts.map(([host]) => host), ["primary", "fallback", "primary"]);
  assert.deepEqual(attempts.map(([, observed]) => observed.blockTag), [900, 900, 900]);
  assert.equal(await pool.call(peer), "0x01", "the missing-trie transient must not poison another selector");
});

test("deep or unknown-head missing-trie failures never schedule a blind recheck", async (t) => {
  for (const scenario of [
    { name: "deep", establishHead: true, blockTag: 700 },
    { name: "unknown-head", establishHead: false, blockTag: 999 },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const attempts = [];
      const providers = ["primary", "fallback"].map((host) => fakeProvider({ methods: {
        getBlockNumber: 1_000,
        call: (observed) => {
          attempts.push([host, structuredClone(observed)]);
          const error = new Error("missing revert data");
          error.info = { error: { message: "missing trie node 0xdef" } };
          throw error;
        },
      } }));
      const pool = createPonReadOnlyRpcProvider(
        ["https://primary.test", "https://fallback.test"],
        CHAIN_ID,
        {
          providerFactory: (_url, index) => providers[index],
          sleep: async () => assert.fail("deep or unknown state must not be retried"),
        },
      );
      subtest.after(() => pool.destroy());
      if (scenario.establishHead) assert.equal(await pool.getBlockNumber(), 1_000);

      await assert.rejects(
        pool.call({
          to: "0x5656565656565656565656565656565656565656",
          data: "0x56565656",
          blockTag: scenario.blockTag,
        }),
        (error) => error.code === "PON_RPC_POOL_FAILED"
          && /primary\.test:capability_unavailable/.test(error.message)
          && /fallback\.test:capability_unavailable/.test(error.message),
      );
      assert.deepEqual(attempts.map(([host]) => host), ["primary", "fallback"]);
      assert.deepEqual(attempts.map(([, observed]) => observed.blockTag), [scenario.blockTag, scenario.blockTag]);
    });
  }
});

test("all-host fast transient failure permits exactly one bounded same-call recheck", async (t) => {
  const request = { to: "0x4444444444444444444444444444444444444444", data: "0xabcdef01", blockTag: 444 };
  const attempts = [];
  const providers = ["first", "second", "third"].map((name, index) => fakeProvider({ methods: {
    call: (observed) => {
      attempts.push([name, structuredClone(observed)]);
      if (index === 0 && attempts.filter(([host]) => host === name).length === 2) return "0x04";
      throw new Error("temporary upstream execution failure");
    },
  } }));
  const pool = createPonReadOnlyRpcProvider(
    ["https://first.test", "https://second.test", "https://third.test"],
    CHAIN_ID,
    {
      providerFactory: (_url, index) => providers[index],
      retryDelayMs: 100,
      sleep: async (ms) => { assert.equal(ms, 100); },
    },
  );
  t.after(() => pool.destroy());

  assert.equal(await pool.call(request), "0x04");
  assert.deepEqual(attempts.map(([host]) => host), ["first", "second", "third", "first"]);
  assert.deepEqual(attempts.map(([, observed]) => observed.blockTag), [444, 444, 444, 444]);
});

test("the bounded recheck cannot extend three endpoint timeout budgets", async (t) => {
  let elapsed = 0;
  let attempts = 0;
  const providers = Array.from({ length: 3 }, () => fakeProvider({ methods: {
    call: () => {
      attempts += 1;
      elapsed += 4_000;
      throw new Error("temporary upstream execution failure");
    },
  } }));
  const pool = createPonReadOnlyRpcProvider(
    ["https://first.test", "https://second.test", "https://third.test"],
    CHAIN_ID,
    {
      requestTimeoutMs: 4_000,
      providerFactory: (_url, index) => providers[index],
      wallNow: () => elapsed,
      sleep: async () => assert.fail("budget exhaustion must not schedule a recheck"),
    },
  );
  t.after(() => pool.destroy());

  await assert.rejects(
    pool.call({ to: "0x5555555555555555555555555555555555555555", data: "0x01020304", blockTag: 555 }),
    { code: "PON_RPC_DEADLINE" },
  );
  assert.equal(attempts, 3);
  assert.equal(elapsed, 12_000);
});

test("cold endpoint validation and business calls share one invoke deadline", async (t) => {
  let elapsed = 0;
  const attempts = [];
  const controls = [];
  const adapters = ["first", "second", "third"].map((host) => ({
    provider: { destroy: async () => {} },
    execute: async (method, _args, control) => {
      controls.push(control);
      attempts.push(`${host}:${method === "send" ? "chainId" : method}`);
      elapsed += 4_000;
      if (method === "send") return `0x${CHAIN_ID.toString(16)}`;
      throw new Error("cold endpoint business failure");
    },
  }));
  const pool = createPonReadOnlyRpcProvider(
    ["https://first.test", "https://second.test", "https://third.test"],
    CHAIN_ID,
    {
      requestTimeoutMs: 4_000,
      wallNow: () => elapsed,
      providerFactory: (_url, index) => adapters[index],
    },
  );
  t.after(() => pool.destroy());

  await assert.rejects(
    pool.call({ to: "0x5757575757575757575757575757575757575757", data: "0x57575757", blockTag: 575 }),
    { code: "PON_RPC_DEADLINE" },
  );
  assert.equal(elapsed, 12_000, "three endpoints may consume only the declared 3 x 4s invoke budget");
  assert.deepEqual(attempts, ["first:chainId", "first:call", "second:chainId"]);
  assert.equal(new Set(controls.map(({ signal }) => signal)).size, 1,
    "validation and business work across fallbacks must share one abort signal");
  assert.equal(controls.at(-1).timeoutMs, 4_000, "the second validation receives only the remaining budget");
});

test("the default HTTP transport receives the shared deadline signal across three cold endpoints", async (t) => {
  const requests = [];
  let active = 0;
  const fetchImpl = async (url, init) => {
    const payload = JSON.parse(Buffer.from(init.body).toString("utf8"));
    const request = Array.isArray(payload) ? payload[0] : payload;
    const observed = {
      host: new URL(url).hostname,
      method: request.method,
      signal: init.signal,
      abortCode: null,
    };
    requests.push(observed);
    active += 1;
    try {
      if (request.method === "eth_chainId") {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 10);
          init.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            observed.abortCode = init.signal.reason?.code || null;
            reject(init.signal.reason || new Error("aborted"));
          }, { once: true });
        });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: `0x${CHAIN_ID.toString(16)}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return await new Promise((_, reject) => {
        const onAbort = () => {
          observed.abortCode = init.signal.reason?.code || null;
          reject(init.signal.reason || new Error("aborted"));
        };
        if (init.signal.aborted) onAbort();
        else init.signal.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      active -= 1;
    }
  };
  const pool = createPonReadOnlyRpcProvider(
    ["https://first.test", "https://second.test", "https://third.test"],
    CHAIN_ID,
    { requestTimeoutMs: 250, fetchImpl },
  );
  t.after(() => pool.destroy());
  const startedAt = Date.now();

  await assert.rejects(pool.getBlockNumber(), { code: "PON_RPC_DEADLINE" });
  const elapsed = Date.now() - startedAt;
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(elapsed >= 740, `shared 750ms deadline must bound the cold pool; observed ${elapsed}ms`);
  const expectedRequests = [
    ["first.test", "eth_chainId"], ["first.test", "eth_blockNumber"],
    ["second.test", "eth_chainId"], ["second.test", "eth_blockNumber"],
    ["third.test", "eth_chainId"], ["third.test", "eth_blockNumber"],
  ];
  assert.ok(requests.length >= 5 && requests.length <= expectedRequests.length,
    "the budget must cover two complete endpoint attempts and start the third identity probe");
  assert.deepEqual(requests.map(({ host, method }) => [host, method]), expectedRequests.slice(0, requests.length),
    "deadline timing may omit only the third business request, never reorder or add physical calls");
  assert.ok(requests.every(({ signal }) => signal.aborted),
    "every default transport request must retain the invoke-wide abort signal");
  assert.equal(requests.at(-1).abortCode, "PON_RPC_DEADLINE",
    "the shared hard deadline must abort the final active physical fetch");
  assert.equal(active, 0, "the shared signal must abort the last physical fetch before invoke rejection");
  const requestsAtDeadline = requests.length;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, requestsAtDeadline, "no physical request may start after the shared deadline");
});

test("bounded recheck refuses a retry when delay consumes the remaining deadline", async (t) => {
  let elapsed = 0;
  let attempts = 0;
  const providers = Array.from({ length: 3 }, () => fakeProvider({ methods: {
    call: () => {
      attempts += 1;
      elapsed += 2_600;
      throw new Error("fast transient failure");
    },
  } }));
  const pool = createPonReadOnlyRpcProvider(
    ["https://first.test", "https://second.test", "https://third.test"],
    CHAIN_ID,
    {
      requestTimeoutMs: 4_000,
      wallNow: () => elapsed,
      providerFactory: (_url, index) => providers[index],
      sleep: async (ms) => {
        assert.equal(ms, 100);
        elapsed += 4_201;
      },
    },
  );
  t.after(() => pool.destroy());

  await assert.rejects(
    pool.call({ to: "0x5858585858585858585858585858585858585858", data: "0x58585858", blockTag: 585 }),
    { code: "PON_RPC_DEADLINE" },
  );
  assert.equal(attempts, 3, "no endpoint may be rechecked after the shared deadline");
});

test("destroy during an endpoint call rejects the invoke and forbids fallback or late success", async () => {
  let rejectPrimary;
  let announceStarted;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  let fallbackCalls = 0;
  const primary = fakeProvider({ methods: {
    getBlockNumber: () => {
      announceStarted();
      return new Promise((_, reject) => { rejectPrimary = reject; });
    },
  } });
  const fallback = fakeProvider({ methods: {
    getBlockNumber: () => {
      fallbackCalls += 1;
      return 999;
    },
  } });
  const pool = createPonReadOnlyRpcProvider(["https://primary.test", "https://fallback.test"], CHAIN_ID, {
    providerFactory: (_url, index) => [primary, fallback][index],
  });
  const outcome = pool.getBlockNumber().then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
  await started;
  await pool.destroy();
  rejectPrimary(new Error("late primary failure"));

  const result = await outcome;
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "PON_RPC_DESTROYED");
  assert.equal(fallbackCalls, 0);
});

test("destroy wakes queued waiters and neither active nor queued invokes can return", async () => {
  let resolveActive;
  let announceStarted;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  let businessCalls = 0;
  const provider = fakeProvider({ methods: {
    getBlockNumber: () => {
      businessCalls += 1;
      announceStarted();
      return new Promise((resolve) => { resolveActive = resolve; });
    },
  } });
  const pool = createPonReadOnlyRpcProvider(["https://only.test"], CHAIN_ID, {
    providerFactory: () => provider,
  });
  const first = pool.getBlockNumber().then(null, (error) => error);
  const waiter = pool.getBlockNumber().then(null, (error) => error);
  await started;
  await pool.destroy();
  resolveActive(123);

  const [firstError, waiterError] = await Promise.all([first, waiter]);
  assert.equal(firstError.code, "PON_RPC_DESTROYED");
  assert.equal(waiterError.code, "PON_RPC_DESTROYED");
  assert.equal(businessCalls, 1, "the queued invoke must never touch the endpoint");
});

test("destroy during the bounded delay prevents the final recheck", async () => {
  let releaseDelay;
  let delayStarted;
  const waiting = new Promise((resolve) => { delayStarted = resolve; });
  const attempts = [];
  const providers = ["first", "second", "third"].map((name) => fakeProvider({ methods: {
    call: () => {
      attempts.push(name);
      throw new Error("temporary upstream execution failure");
    },
  } }));
  const pool = createPonReadOnlyRpcProvider(
    ["https://first.test", "https://second.test", "https://third.test"],
    CHAIN_ID,
    {
      providerFactory: (_url, index) => providers[index],
      sleep: () => {
        delayStarted();
        return new Promise((resolve) => { releaseDelay = resolve; });
      },
    },
  );
  const call = pool.call({
    to: "0x6666666666666666666666666666666666666666",
    data: "0x06060606",
    blockTag: 666,
  });
  await waiting;
  await pool.destroy();
  releaseDelay();

  await assert.rejects(call, { code: "PON_RPC_DESTROYED" });
  assert.deepEqual(attempts, ["first", "second", "third"]);
});

test("Pon RPC pool is single-flight by default and exposes no write surface", async (t) => {
  const provider = fakeProvider({ delay: 15, methods: { getBlockNumber: 42, getCode: "0x12" } });
  const pool = createPonReadOnlyRpcProvider(["https://only.test"], CHAIN_ID, {
    providerFactory: () => provider,
  });
  t.after(() => pool.destroy());

  const [head, code] = await Promise.all([pool.getBlockNumber(), pool.getCode("0xabc")]);
  assert.equal(head, 42);
  assert.equal(code, "0x12");
  assert.equal(provider.stats().maximumActive, 1);
  assert.equal("broadcastTransaction" in pool, false);
  assert.throws(() => pool.send("eth_sendRawTransaction", ["0xdead"]), { code: "PON_RPC_METHOD_REJECTED" });
});

test("destroy closes every owned endpoint exactly once", async () => {
  const providers = [fakeProvider(), fakeProvider(), fakeProvider()];
  const pool = createPonReadOnlyRpcProvider(
    ["https://one.test", "https://two.test", "https://three.test"],
    CHAIN_ID,
    { providerFactory: (_url, index) => providers[index] },
  );
  await pool.destroy();
  await pool.destroy();
  assert.deepEqual(providers.map((provider) => provider.stats().destroyed), [1, 1, 1]);
  await assert.rejects(pool.getBlockNumber(), { code: "PON_RPC_DESTROYED" });
});
