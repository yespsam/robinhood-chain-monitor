import test from "node:test";
import assert from "node:assert/strict";
import { createBscReplayScheduler } from "../src/bsc-replay-scheduler.js";
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
