import test from "node:test";
import assert from "node:assert/strict";
import { createRpcPool } from "../src/bsc-launchpad-monitor.js";

const capacityError = () => Object.assign(new Error("shared capacity wait deadline"), {
  code: "RPC_COORDINATOR_UNAVAILABLE", rpcFailureScope: "capacity",
  rpcCircuitAlreadyOpen: true, retryAfterMs: 250,
});

function fixture({ standard, archive = [], admit = async (_host, callback) => callback(),
  read = async (kind, method, args) => method === "send" ? [] : ({ kind, method, args }),
  snapshot = () => ({ leases: [], circuits: [] }), options = {} }) {
  const admissions = [], physical = [], cooldowns = [], registry = new Map();
  const pool = createRpcPool(standard, archive, 1, {
    requestTimeoutMs: 100, physicalWaitMs: 100, standardConcurrency: 1,
    totalConcurrency: 1, objectReadBudgetMs: 10_000, objectReadMaxAttempts: 2,
    stateReadBudgetMs: 10_000, stateReadMaxAttempts: 2,
    now: () => 10_000, hostCircuitRegistry: registry,
    providerFactory: (_url, { kind }) => Object.fromEntries([
      "getBlock", "getTransaction", "getTransactionReceipt", "getCode", "getStorage", "call", "send",
    ].map(method => [method, async (...args) => {
      physical.push({ kind, method, args });
      return read(kind, method, args);
    }])),
    hostCoordinator: {
      snapshot,
      run: async (host, operation, lane, callback, wait) => {
        admissions.push({ host, operation, lane, wait });
        return admit(host, callback);
      },
      persistCooldown: async (...args) => { cooldowns.push(args); },
    },
    ...options,
  });
  return { pool, admissions, physical, cooldowns, registry };
}

test("a known-saturated preferred paid host yields to an available secondary for a bounded state read", async t => {
  const f = fixture({
    standard: ["https://paid.test", "https://secondary.test"],
    snapshot: () => ({ leases: [{ host: "paid.test", lane: "background" }], circuits: [] }),
    options: { preferredHosts: ["paid.test"] },
  });
  t.after(() => f.pool.destroy());

  assert.deepEqual(await f.pool.getCode("0x1234", "latest"), {
    kind: "standard", method: "getCode", args: ["0x1234", "latest"],
  });
  assert.deepEqual(f.admissions.map(item => item.host), ["secondary.test"]);
  assert.equal(f.physical.length, 1);
});

test("pure shared-capacity refusal retains its type and retry deadline when the attempt budget ends", async t => {
  const f = fixture({ standard: ["https://a.test", "https://b.test", "https://c.test"],
    admit: async () => { throw capacityError(); } });
  t.after(() => f.pool.destroy());
  await assert.rejects(f.pool.getBlock(100), error => {
    assert.equal(error.code, "RPC_COORDINATOR_UNAVAILABLE");
    assert.equal(error.rpcFailureScope, "capacity");
    assert.equal(error.rpcBudgetExhausted, true);
    assert.equal(error.rpcCircuitAlreadyOpen, true);
    assert.equal(error.retryAfterMs, 250);
    return true;
  });
  assert.equal(f.admissions.length, 2, "no third admission or extended retry budget");
  assert.equal(f.physical.length, 0);
  assert.equal(f.cooldowns.length, 0, "local pressure is not a new upstream cooldown");
  assert.equal(f.pool.getObjectReadHealth().endpointAttempts, 2);
  assert.equal(f.pool.getObjectReadHealth().totalSlots.active, 0);
});

test("capacity refusal skips same-host URL aliases while retaining the next distinct-host attempt", async t => {
  const f = fixture({ standard: ["https://busy.test/a", "https://busy.test/b", "https://idle.test"],
    admit: async (host, callback) => {
      if (host === "busy.test") throw capacityError();
      return callback();
    } });
  t.after(() => f.pool.destroy());
  assert.deepEqual(await f.pool.getBlock(100), { kind: "standard", method: "getBlock", args: [100] });
  assert.deepEqual(f.admissions.map(item => item.host), ["busy.test", "idle.test"]);
  assert.equal(f.physical.length, 1);
  assert.equal(f.pool.getObjectReadHealth().endpointAttempts, 2);
  assert.equal(f.cooldowns.length, 0);
});

for (const route of ["getHistoricalBlock", "historical-state", "latest-state", "logs"]) {
  test(`${route} shares capacity-refusal evidence across archive and standard aliases only for that read`, async t => {
    let blocked = true;
    const f = fixture({ standard: ["https://same.test/standard"], archive: ["https://same.test/archive"],
      admit: async (_host, callback) => {
        if (blocked) throw capacityError();
        return callback();
      } });
    t.after(() => f.pool.destroy());
    const invoke = () => route === "getHistoricalBlock" ? f.pool.getHistoricalBlock(100)
      : route === "historical-state" ? f.pool.getCode("0x1234", 100)
        : route === "latest-state" ? f.pool.getCode("0x1234", "latest")
          : f.pool.send("eth_getLogs", [{ fromBlock: "0x64", toBlock: "0x65" }]);
    await assert.rejects(invoke(), error => error.rpcFailureScope === "capacity" && error.retryAfterMs === 250);
    assert.equal(f.admissions.length, 1, "same physical host is not queued again through the alternative pool");
    assert.equal(f.physical.length, 0);
    assert.equal(f.cooldowns.length, 0);
    blocked = false;
    await invoke();
    assert.equal(f.admissions.length, 2, "a later logical read is not blocked by the previous local refusal");
    assert.equal(f.physical.length, 1);
    if (route.includes("state")) {
      assert.deepEqual(f.physical[0].args, ["0x1234", route === "historical-state" ? 100 : "latest"]);
    }
  });
}

test("mixed upstream timeout and capacity cannot be downgraded to a pure resource wait", async t => {
  const f = fixture({ standard: ["https://timeout.test", "https://busy.test", "https://unused.test"],
    admit: async (host, callback) => {
      if (host === "busy.test") throw capacityError();
      return callback();
    },
    read: async () => { throw Object.assign(new Error("request timed out"), { code: "TIMEOUT" }); } });
  t.after(() => f.pool.destroy());
  await assert.rejects(f.pool.getBlock(100), error => error.rpcBudgetExhausted === true
    && error.rpcFailureScope === "method" && error.code !== "RPC_COORDINATOR_UNAVAILABLE");
  assert.equal(f.admissions.length, 2);
  assert.equal(f.physical.length, 1);
  assert.equal(f.cooldowns.length, 1, "the real timeout still records its method circuit");
  assert.equal(f.cooldowns[0][3], "method");
});

test("malformed archive logs followed by capacity budget exhaustion remain a mixed method failure", async t => {
  const f = fixture({ standard: ["https://busy.test", "https://unused.test"], archive: ["https://archive.test"],
    admit: async (host, callback) => {
      if (host !== "archive.test") throw capacityError();
      return callback();
    }, read: async () => ({ malformed: true }) });
  t.after(() => f.pool.destroy());
  await assert.rejects(f.pool.send("eth_getLogs", [{ fromBlock: "0x64", toBlock: "0x65" }]), error => {
    assert.equal(error.rpcBudgetExhausted, true);
    assert.equal(error.rpcFailureScope, "method");
    assert.notEqual(error.code, "RPC_COORDINATOR_UNAVAILABLE");
    return true;
  });
  assert.deepEqual(f.admissions.map(item => item.host), ["archive.test", "busy.test"]);
  assert.equal(f.physical.length, 1);
  assert.equal(f.pool.getObjectReadHealth().endpointAttempts, 2);
  assert.equal(f.cooldowns.length, 0, "shape validation does not invent an upstream cooldown");
});

for (const archive of [[], ["https://busy.test"]]) {
  test(`malformed standard logs retain typed method evidence with ${archive.length ? "capacity archive fallback" : "no archive"}`, async t => {
    const f = fixture({ standard: ["https://standard.test"], archive,
      admit: async (host, callback) => {
        if (host === "busy.test") throw capacityError();
        return callback();
      }, read: async () => ({ malformed: true }) });
    t.after(() => f.pool.destroy());
    await assert.rejects(f.pool.send("eth_getLogs", [{ fromBlock: "0x64", toBlock: "0x65" }]), error => {
      assert.equal(error.rpcFailureScope, "method");
      assert.equal(error.rpcOperation, "eth_getLogs");
      assert.equal(error.code, "SERVER_ERROR");
      assert.match(error.message, /standard RPC returned a non-array result/);
      return true;
    });
    assert.equal(f.admissions.length, 1 + archive.length);
    assert.equal(f.physical.length, 1);
    assert.equal(f.cooldowns.length, 0);
  });
}

test("capacity attribution remains mixed when an earlier pool is already cooling", async t => {
  const f = fixture({ standard: ["https://busy.test", "https://other.test", "https://unused.test"],
    archive: ["https://cooling.test"], admit: async () => { throw capacityError(); } });
  t.after(() => f.pool.destroy());
  Object.assign(f.registry.get("cooling.test"), { globalUntil: 70_000, globalFailures: 1 });
  await assert.rejects(f.pool.getHistoricalBlock(100), error => error.rpcBudgetExhausted === true
    && error.rpcFailureScope !== "capacity");
  assert.equal(f.admissions.length, 2);
  assert.equal(f.cooldowns.length, 0, "existing cooldown is not recreated or shortened");
  assert.equal(f.registry.get("cooling.test").globalUntil, 70_000);
});

test("a cooling host in the same pool prevents all-route capacity attribution at budget exhaustion", async t => {
  const f = fixture({ standard: ["https://a.test", "https://b.test", "https://c.test", "https://cooling.test"],
    admit: async () => { throw capacityError(); } });
  t.after(() => f.pool.destroy());
  Object.assign(f.registry.get("cooling.test"), { globalUntil: 70_000, globalFailures: 1 });
  await assert.rejects(f.pool.getBlock(100), error => error.rpcBudgetExhausted === true
    && error.rpcFailureScope !== "capacity");
  assert.equal(f.admissions.length, 2);
  assert.equal(f.cooldowns.length, 0);
  assert.equal(f.registry.get("cooling.test").globalUntil, 70_000);
});

test("elapsed state-read budget after capacity refusal stays bounded and retains capacity evidence", async t => {
  let clock = 0;
  const f = fixture({ standard: ["https://a.test", "https://b.test"],
    admit: async () => { clock = 9_900; throw capacityError(); },
    options: { stateReadBudgetNow: () => clock } });
  t.after(() => f.pool.destroy());
  await assert.rejects(f.pool.getCode("0x1234", "latest"), error => error.rpcBudgetExhausted === true
    && error.rpcFailureScope === "capacity" && error.retryAfterMs === 250);
  assert.equal(f.admissions.length, 1, "insufficient remaining time cannot start another host attempt");
  assert.equal(f.physical.length, 0);
  assert.equal(f.cooldowns.length, 0);
});

test("unbudgeted reads also avoid repeating a refused physical host without creating a lasting gate", async t => {
  const f = fixture({ standard: ["https://same.test/one", "https://same.test/two"],
    admit: async () => { throw capacityError(); }, options: { objectReadBudgetMs: 0 } });
  t.after(() => f.pool.destroy());
  for (let calls = 1; calls <= 2; calls++) {
    await assert.rejects(f.pool.getBlock(100), error => error.rpcFailureScope === "capacity");
    assert.equal(f.admissions.length, calls);
  }
  assert.equal(f.cooldowns.length, 0);
});

for (const [ordinary, historical, argument] of [
  ["getBlock", "getHistoricalBlock", 100],
  ["getTransaction", "getHistoricalTransaction", `0x${"1".repeat(64)}`],
  ["getTransactionReceipt", "getHistoricalTransactionReceipt", `0x${"2".repeat(64)}`],
]) {
  test(`${ordinary} and ${historical} preserve their route identity while joining only matching in-flight reads`, async t => {
    const f = fixture({ standard: ["https://standard.test"], archive: ["https://archive.test"] });
    t.after(() => f.pool.destroy());
    const results = await Promise.all([
      f.pool[ordinary](argument), f.pool[ordinary](argument),
      f.pool[historical](argument), f.pool[historical](argument),
    ]);
    assert.deepEqual(results.map(item => item.kind), ["standard", "standard", "archive", "archive"]);
    assert.equal(f.physical.length, 2);
    assert.ok(f.physical.every(item => item.method === ordinary && item.args[0] === argument));
    assert.equal(f.pool.getObjectReadHealth().joined, 2);
    assert.equal(f.pool.getObjectReadHealth().totalSlots.active, 0);
    await f.pool[historical](argument);
    assert.equal(f.physical.length, 3, "settled reads are not reused as stale canonical evidence");
  });
}
