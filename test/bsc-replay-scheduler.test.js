import test from "node:test";
import assert from "node:assert/strict";
import { createBscReplayScheduler, isBscReplayResourceWait } from "../src/bsc-replay-scheduler.js";
import { createRpcPool } from "../src/bsc-launchpad-monitor.js";
import { setTimeout as delay } from "node:timers/promises";

test("fresh wakeups expire without executing and share retry cooldown with maintenance", async () => {
  let clock=1000,release;
  const retryState=new Map(),fresh=createBscReplayScheduler({now:()=>clock,maxPending:2,retryState});
  const maintenance=createBscReplayScheduler({now:()=>clock,retryState});
  const running=fresh.run('flap:a',()=>new Promise(resolve=>{release=resolve;}));
  const queued=fresh.run('flap:b',()=>assert.fail('expired wakeup executed'),{deadlineAt:1100});
  await Promise.resolve();clock=1100;release(true);
  assert.equal(await running,true);assert.equal(await queued,false);await fresh.idle();
  assert.equal(fresh.snapshot().expired,1);
  await assert.rejects(fresh.run('flap:c',async()=>{throw Object.assign(Error('429'),{retryAfterMs:60000});}));
  await fresh.idle();
  assert.equal(await maintenance.run('flap:c',()=>assert.fail('lane switch bypassed cooldown')),false);
  assert.equal(await maintenance.run('flap:b',async()=>true),true,'expired wakeup does not delete durable work');
  await maintenance.idle();
});

test("maintenance wakeups are single-flight, FIFO, bounded, and refused work is not executed", async () => {
  const scheduler = createBscReplayScheduler({ maxPending: 2 });
  let release;
  const order = [];
  const a = scheduler.run("four:a", () => new Promise(resolve => { order.push("a"); release = resolve; }));
  const same = scheduler.run("four:a", () => assert.fail("duplicate job"));
  assert.equal(a, same);
  const b = scheduler.run("flap:b", async () => { order.push("b"); return false; });
  const c = scheduler.run("four:c", async () => { order.push("c"); return true; });
  assert.equal(await scheduler.run("flap:d", () => assert.fail("capacity exceeded")), false);
  assert.equal(scheduler.snapshot().active, 1);
  assert.equal(scheduler.snapshot().pending, 2);
  release(true);
  assert.deepEqual(await Promise.all([a, b, c]), [true, false, true]);
  await scheduler.idle();
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(scheduler.snapshot().active, 0);
  assert.equal(scheduler.snapshot().capacityYields, 1);
  assert.equal(await scheduler.run("flap:d", async () => true), true, "durable work may retry a refused wakeup");
});

test("maintenance failure backs off one key, honors server delay and permits other families", async () => {
  let clock = 1000;
  const scheduler = createBscReplayScheduler({ now: () => clock });
  await assert.rejects(scheduler.run("flap:a", async () => { throw Object.assign(new Error("429"), { retryAfterMs: 90_000 }); }));
  await scheduler.idle();
  clock += 60_000;
  assert.equal(await scheduler.run("flap:a", () => assert.fail("still cooling down")), false);
  assert.equal(await scheduler.run("four:b", async () => true), true);
  await scheduler.idle();
  clock += 30_000;
  assert.equal(await scheduler.run("flap:a", async () => true), true);
  await scheduler.idle();
  assert.equal(scheduler.snapshot().failed, 1);
  assert.equal(scheduler.snapshot().cooldownYields, 1);
});

test("maintenance stop cancels unstarted wakeups and waits for the actual in-flight job", async () => {
  const scheduler = createBscReplayScheduler();
  let release;
  const active = scheduler.run("flap:a", () => new Promise(resolve => { release = resolve; }));
  const pending = scheduler.run("four:b", () => assert.fail("stopped job ran"));
  await Promise.resolve();
  scheduler.stop();
  assert.equal(await pending, false);
  let drained = false;
  const idle = scheduler.idle().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal(await scheduler.run("flap:c", () => assert.fail("new work after stop")), false);
  release(false);
  await active;
  await idle;
  assert.equal(scheduler.snapshot().active, 0);
  assert.equal(scheduler.snapshot().cancelled, 1);
});

test("maintenance RPC shares one slot across standard objects, archive logs and state", async () => {
  let active = 0, maximum = 0;
  const calls = [];
  const pool = createRpcPool(["https://standard.test"], ["https://archive.test"], 4, {
    totalConcurrency: 1, standardConcurrency: 4, requestTimeoutMs: 1000,
    stateReadBudgetMs: 10_000, objectReadBudgetMs: 10_000,
    providerFactory: (_url, { kind }) => Object.fromEntries(["getBlock", "getCode", "send"].map(method => [method, async (...args) => {
      active++; maximum = Math.max(maximum, active); calls.push({ kind, method, args });
      await delay(10); active--;
      return method === "send" ? [] : "fixture";
    }])),
  });
  const filter = { fromBlock: "0x64", toBlock: "0x65", topics: [] };
  await Promise.all([pool.getBlock(100), pool.getBlock(100), pool.send("eth_getLogs", [filter]), pool.getCode("0x1", 100)]);
  assert.equal(maximum, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => c.kind), ["standard", "archive", "archive"]);
  assert.equal(pool.getObjectReadHealth().joined, 1);
  assert.deepEqual(pool.getObjectReadHealth().totalSlots, { limit: 1, active: 0, waiting: 0 });
  await pool.getBlock(100);
  assert.equal(calls.length, 4, "canonical rechecks are fresh after settlement");
  pool.destroy();
});

test("maintenance log retry budget does not fan out through every archive and standard endpoint", async () => {
  const calls = [];
  const pool = createRpcPool(["https://standard.test"], ["https://a.test", "https://b.test", "https://c.test"], 1, {
    totalConcurrency: 1, objectReadBudgetMs: 10_000, objectReadMaxAttempts: 2, requestTimeoutMs: 1000,
    providerFactory: url => ({ send: async (...args) => { calls.push({ url, args }); throw new Error("request timed out"); } }),
  });
  const filter = { fromBlock: "0x64", toBlock: "0x65" };
  await assert.rejects(pool.send("eth_getLogs", [filter]), error => error.rpcBudgetExhausted === true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.url !== "https://standard.test"));
  assert.deepEqual(calls[0].args, calls[1].args);
  assert.equal(pool.getObjectReadHealth().totalSlots.active, 0);
  pool.destroy();
});

test("object proof retry budget bounds endpoint attempts for transaction, receipt and canonical block without changing identity", async () => {
  for (const method of ['getNetwork','getTransaction','getTransactionReceipt','getBlock']) {
    const calls=[],arg=method==='getBlock'?100:`0x${'1'.repeat(64)}`;
    const pool=createRpcPool(['https://a.test','https://b.test','https://c.test'],[],1,{
      standardConcurrency:4,objectReadBudgetMs:10000,objectReadMaxAttempts:2,requestTimeoutMs:1000,
      providerFactory:url=>({[method]:async(...args)=>{calls.push({url,args});throw new Error('request timed out');}}),
    });
    await assert.rejects(pool[method](arg),e=>e.rpcBudgetExhausted===true);
    assert.equal(calls.length,2);assert.ok(calls.every(c=>c.args[0]===arg));
    assert.equal(pool.getObjectReadHealth().active,0);
    pool.destroy();
  }
});

test("replay resource waits require whole-route typed evidence, not a mixed method failure", () => {
  assert.equal(isBscReplayResourceWait({ rpcFailureScope: "capacity" }), true);
  for (const evidence of [{ retryAfterMs: 100 }, { rpcHostRetryAfterMs: 100 },
    { rpcCircuitAlreadyOpen: true }, { status: 429 }, { code: 429 }]) {
    assert.equal(isBscReplayResourceWait({ rpcFailureScope: "host", ...evidence }), true);
    assert.equal(isBscReplayResourceWait({ rpcFailureScope: "method", ...evidence }), false);
  }
  assert.equal(isBscReplayResourceWait({ message: "HTTP 429", retryAfterMs: 60_000 }), false);
  assert.equal(isBscReplayResourceWait({ rpcFailureScope: "host", retryAfterMs: NaN }), false);
  assert.equal(isBscReplayResourceWait({ rpcFailureScope: "method", rpcBudgetExhausted: true }), true);
  assert.equal(isBscReplayResourceWait({ rpcFailureScope: "method", rpcBudgetExhausted: "true" }), false);
});

test("typed capacity and host cooldown refuse queued and new route wakeups without discarding durable work", async (t) => {
  for (const scope of ["capacity", "host"]) {
    await t.test(scope, async () => {
      let clock = 1000, rejectActive;
      const retryState = new Map(), scheduler = createBscReplayScheduler({ now: () => clock, retryState });
      const attempts = [];
      const active = scheduler.run("flap:a", () => new Promise((_resolve, reject) => {
        attempts.push("a"); rejectActive = reject;
      }));
      const failed = assert.rejects(active, /resource unavailable/);
      const queued = scheduler.run("four:b", () => assert.fail("queued operation bypassed route cooldown"));
      const another = scheduler.run("flap:c", () => assert.fail("second queued operation bypassed route cooldown"));
      await Promise.resolve();
      rejectActive(Object.assign(new Error("resource unavailable"), {
        rpcFailureScope: scope, retryAfterMs: scope === "capacity" ? 12_000 : 90_000,
      }));
      await failed;
      assert.deepEqual(await Promise.all([queued, another]), [false, false]);
      await scheduler.idle();
      assert.deepEqual(attempts, ["a"]);
      assert.equal(scheduler.snapshot().started, 1);
      assert.equal(scheduler.snapshot().completed, 0);
      assert.equal(scheduler.snapshot().pending, 0);
      assert.equal(retryState.has("four:b"), false, "refused work does not get a fabricated failure or completion");
      const wait = scope === "capacity" ? 12_000 : 90_000;
      assert.equal(scheduler.snapshot().routeCooldownRemainingMs, wait);
      clock += wait - 1;
      assert.equal(await scheduler.run("four:b", () => assert.fail("new key bypassed route cooldown")), false);
      clock += 1;
      assert.equal(await scheduler.run("four:b", async () => { attempts.push("b"); return true; }), true);
      await scheduler.idle();
      assert.deepEqual(attempts, ["a", "b"]);
      assert.equal(retryState.get("flap:a").failures, scope === "capacity" ? 0 : 1);
    });
  }
});

test("capacity preserves genuine failure count and delay while mixed failures retain exponential backoff", async () => {
  let clock = 1000;
  const retryState = new Map(), scheduler = createBscReplayScheduler({ now: () => clock, retryState });
  const fail = async error => {
    const failedAt = clock;
    await assert.rejects(scheduler.run("flap:a", async () => { throw error; }));
    await scheduler.idle();
    const record = retryState.get("flap:a");
    clock = record.until;
    return { failures: record.failures, delay: record.until - failedAt };
  };
  const capacity = () => Object.assign(new Error("local admission unavailable"), { rpcFailureScope: "capacity", retryAfterMs: 100 });
  assert.deepEqual(await fail(capacity()), { failures: 0, delay: 5000 });
  assert.deepEqual(await fail(capacity()), { failures: 0, delay: 5000 });
  for (let failures = 1; failures <= 5; failures++) {
    const actual = await fail(Object.assign(new Error("mixed upstream timeout and capacity"), { rpcFailureScope: "method", retryAfterMs: 100 }));
    assert.deepEqual(actual, { failures, delay: Math.min(60_000, 5000 * 2 ** (failures - 1)) });
  }
  assert.deepEqual(await fail(capacity()), { failures: 5, delay: 60_000 }, "capacity cannot shorten an existing upstream failure delay");
  assert.deepEqual(await fail(Object.assign(capacity(), { rpcHostRetryAfterMs: 95_000, rpcHostFailure: "HTTP 429" })),
    { failures: 6, delay: 95_000 }, "mixed host evidence is never relabelled as pure local admission");
});

test("route cooldown stays local while identical durable keys share retry state across lanes", async () => {
  let clock = 1000;
  const retryState = new Map();
  const maintenance = createBscReplayScheduler({ now: () => clock, retryState });
  const fresh = createBscReplayScheduler({ now: () => clock, retryState });
  await assert.rejects(maintenance.run("flap:a", async () => {
    throw Object.assign(new Error("shared physical capacity wait"), { rpcFailureScope: "capacity", retryAfterMs: 20_000 });
  }));
  await maintenance.idle();
  assert.equal(await maintenance.run("four:b", () => assert.fail("same route was not cooled")), false);
  assert.equal(await fresh.run("flap:a", () => assert.fail("same durable key bypassed shared cooldown")), false);
  assert.equal(await fresh.run("flap:c", async () => true), true, "unrelated fresh route is not frozen by maintenance pressure");
  await fresh.idle();
  assert.equal(fresh.snapshot().routeCooldownRemainingMs, 0);
  clock += 20_000;
  assert.equal(await maintenance.run("four:b", async () => true), true);
  await maintenance.idle();
});

test("queued work checks a newly shared key deadline again before entering another lane", async () => {
  let clock = 1000, release;
  const retryState = new Map();
  const maintenance = createBscReplayScheduler({ now: () => clock, retryState });
  const fresh = createBscReplayScheduler({ now: () => clock, retryState });
  const running = fresh.run("flap:busy", () => new Promise(resolve => { release = resolve; }));
  const queued = fresh.run("flap:a", () => assert.fail("prequeued key bypassed newly shared deadline"));
  await assert.rejects(maintenance.run("flap:a", async () => {
    throw Object.assign(new Error("typed host wait"), { rpcFailureScope: "host", retryAfterMs: 60_000 });
  }));
  await maintenance.idle();
  release(true);
  assert.equal(await running, true);
  assert.equal(await queued, false);
  await fresh.idle();
  assert.equal(fresh.snapshot().routeCooldownRemainingMs, 0);
  assert.equal(retryState.get("flap:a").until, clock + 60_000);
});

test("exhausted method budgets yield the route without relabelling mixed failures or resetting their exponent", async () => {
  let clock = 1000;
  const retryState = new Map(), scheduler = createBscReplayScheduler({ now: () => clock, retryState });
  for (let failures = 1; failures <= 3; failures++) {
    let rejectActive;
    const error = Object.freeze(Object.assign(new Error("mixed upstream timeout and capacity; object budget exhausted"), {
      rpcFailureScope: "method", rpcBudgetExhausted: true, rpcOperation: "getBlock",
      retryAfterMs: failures === 3 ? 90_000 : 100,
    }));
    const active = scheduler.run("flap:a", () => new Promise((_resolve, reject) => { rejectActive = reject; }));
    const rejected = assert.rejects(active, reason => reason === error && reason.rpcFailureScope === "method");
    const queued = scheduler.run("flap:b", () => assert.fail("next window started a new budget before cooldown"));
    await Promise.resolve();
    rejectActive(error);
    await rejected;
    assert.equal(await queued, false);
    await scheduler.idle();
    const wait = failures === 3 ? 90_000 : 5000 * 2 ** (failures - 1);
    assert.deepEqual(retryState.get("flap:a"), { failures, until: clock + wait });
    assert.equal(retryState.has("flap:b"), false, "refused wakeup does not consume or complete its durable work");
    assert.equal(scheduler.snapshot().routeCooldownRemainingMs, wait);
    clock += wait - 1;
    assert.equal(await scheduler.run("flap:b", () => assert.fail("budget cooldown shortened")), false);
    clock += 1;
    assert.equal(await scheduler.run("flap:b", async () => true), true, "the same preserved window can run after cooldown");
    await scheduler.idle();
  }
  assert.equal(retryState.get("flap:a").failures, 3);
});

test("method failures without budget exhaustion still permit a queued independent key", async () => {
  let clock = 1000, rejectActive;
  const retryState = new Map(), scheduler = createBscReplayScheduler({ now: () => clock, retryState });
  const active = scheduler.run("flap:a", () => new Promise((_resolve, reject) => { rejectActive = reject; }));
  const rejected = assert.rejects(active, /one method failed/);
  const queued = scheduler.run("four:b", async () => true);
  await Promise.resolve();
  rejectActive(Object.assign(new Error("one method failed with an alternate host available"), {
    rpcFailureScope: "method", rpcBudgetExhausted: false, retryAfterMs: 20_000,
  }));
  await rejected;
  assert.equal(await queued, true);
  await scheduler.idle();
  assert.deepEqual(retryState.get("flap:a"), { failures: 1, until: clock + 20_000 });
  assert.equal(scheduler.snapshot().routeCooldownRemainingMs, 0);
});
