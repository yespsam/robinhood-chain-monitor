import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createRpcHostCoordinator } from "../src/rpc-host-coordinator.js";
import { createRpcPool } from "../src/bsc-launchpad-monitor.js";

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rpc-coordinator-test-"));
  const file = path.join(dir, "rpc.sqlite");
  const gate = createRpcHostCoordinator({ file, ...options });
  t.after(async () => { gate.close(); await rm(dir, { recursive: true, force: true }); });
  return { gate, file };
}
test("shared host leases reserve realtime capacity without exceeding two requests", async (t) => {
  const { gate, file } = await fixture(t);
  const other = createRpcHostCoordinator({ file }); t.after(() => other.close());
  const background = gate.tryAcquire("rpc.example", "getBlock", "background");
  assert.ok(background);
  assert.equal(other.tryAcquire("rpc.example", "getCode", "background"), null);
  const live = other.tryAcquire("rpc.example", "eth_getLogs", "realtime");
  assert.ok(live);
  assert.equal(gate.tryAcquire("rpc.example", "getBlockNumber", "realtime"), null);
  gate.release(background); other.release(live);
  assert.equal(gate.snapshot().leases.length, 0);
});
test("429 deadline survives restart and a pre-failure success cannot erase it", async (t) => {
  let current = 1_000;
  const { gate, file } = await fixture(t, { now: () => current });
  const early = gate.tryAcquire("rpc.example", "getBlockNumber", "realtime");
  gate.cooldown("rpc.example", "getBlockNumber", 8_000, "host");
  gate.release(early, true);
  const other = createRpcHostCoordinator({ file, now: () => current }); t.after(() => other.close());
  assert.throws(() => other.tryAcquire("rpc.example", "getCode"), (error) => error.rpcHostRetryAfterMs === 7_000);
  current = 8_001;
  const probe = other.tryAcquire("rpc.example", "getCode", "realtime");
  assert.ok(probe);
  assert.equal(gate.tryAcquire("rpc.example", "getBlock", "realtime"), null);
  other.release(probe, true);
  assert.ok(gate.tryAcquire("rpc.example", "getCode", "realtime"));
});
test("method aliases share cooldown, unrelated methods and hosts remain usable", async (t) => {
  const { gate } = await fixture(t, { now: () => 5_000 });
  gate.cooldown("rpc.example", "getTransaction", 10_000, "method");
  assert.throws(() => gate.tryAcquire("rpc.example", "eth_getTransactionByHash"), (e) => e.rpcFailureScope === "method");
  assert.ok(gate.tryAcquire("rpc.example", "eth_getLogs", "realtime"));
  assert.ok(gate.tryAcquire("other.example", "getTransaction", "realtime"));
  assert.throws(() => gate.tryAcquire("https://rpc.example/private-key", "eth_call"), /hostname/);
});
for (const [alias, canonical] of [["getNetwork", "eth_chainId"], ["callBatch", "eth_call"]]) {
  test(`${alias} and ${canonical} share bidirectional cooldown and a single half-open probe`, async (t) => {
    let current = 5_000;
    const { gate, file } = await fixture(t, { now: () => current });
    const other = createRpcHostCoordinator({ file, now: () => current });
    t.after(() => other.close());
    let dispatched = 0;
    const directions = [[alias, canonical], [canonical, alias]];
    for (const [index, [written, requested]] of directions.entries()) {
      const host = `alias-${index}.example`;
      gate.cooldown(host, written, 10_000, "method");
      const blocked = error => error.code === "RPC_COORDINATOR_UNAVAILABLE"
        && error.rpcFailureScope === "method" && error.rpcOperation === canonical;
      assert.throws(() => other.tryAcquire(host, requested, "realtime"), blocked);
      await assert.rejects(other.run(host, requested, "background", () => { dispatched++; }, { waitMs: 200 }), blocked);
      const unrelated = other.tryAcquire(host, "eth_getLogs", "realtime");
      assert.ok(unrelated); other.release(unrelated);
    }
    assert.equal(dispatched, 0, "neither alias may dispatch during shared cooldown");
    assert.ok(gate.snapshot().circuits.every(row => row.operation === canonical));
    current = 10_001;
    for (const [index, [written, requested]] of directions.entries()) {
      const host = `alias-${index}.example`;
      const probe = other.tryAcquire(host, requested, "realtime");
      assert.equal(probe.operation, canonical);
      assert.equal(gate.tryAcquire(host, written, "realtime"), null, "aliases share the half-open probe");
      other.release(probe, true);
      const recovered = gate.tryAcquire(host, written, "background");
      assert.ok(recovered); gate.release(recovered);
    }
    assert.equal(gate.snapshot().leases.length, 0);
    assert.equal(gate.snapshot().waiters.length, 0);
  });
}
test("real child process respects shared capacity; only dead owners are reclaimed", async (t) => {
  const { gate, file } = await fixture(t);
  const moduleUrl = new URL("../src/rpc-host-coordinator.js", import.meta.url).href;
  const source = `import { createRpcHostCoordinator } from ${JSON.stringify(moduleUrl)};
    const gate = createRpcHostCoordinator({file:process.argv[1]});
    const a=gate.tryAcquire('rpc.example','getCode','background');
    const b=gate.tryAcquire('rpc.example','eth_getLogs','realtime');
    process.send({acquired:!!a&&!!b});
    process.on('message',()=>{});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, file], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const [message] = await once(child, "message");
  assert.equal(message.acquired, true);
  assert.equal(gate.tryAcquire("rpc.example", "eth_getLogs", "realtime"), null);
  const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
  const lease = gate.tryAcquire("rpc.example", "eth_getLogs", "realtime");
  assert.ok(lease);
  assert.equal(gate.snapshot().leases.length, 1);
  gate.release(lease);
});
test("alive owners do not expire; queue timeout does not run physical RPC", async (t) => {
  const { gate } = await fixture(t, { now: () => 1 });
  gate.tryAcquire("rpc.example", "eth_call", "background");
  gate.tryAcquire("rpc.example", "eth_getLogs", "realtime");
  let ran = false;
  await assert.rejects(gate.run("rpc.example", "eth_call", "background", () => { ran = true; }, { waitMs: 10 }), /capacity wait deadline/);
  assert.equal(ran, false);
  assert.equal(gate.snapshot().leases.length, 2);
});
test("separate RPC pools persist a host failure before releasing their lease", async (t) => {
  const { gate, file } = await fixture(t);
  const other = createRpcHostCoordinator({ file }); t.after(() => other.close());
  let calls = 0;
  const failing = createRpcPool(["https://rpc.example"], [], 1, {
    hostCoordinator: gate, priorityLane: "realtime",
    providerFactory: () => ({ getBlockNumber: async () => {
      calls++; throw Object.assign(new Error("HTTP 429"), { status: 429, retryAfterMs: 60_000 });
    } }),
  });
  const healthy = createRpcPool(["https://rpc.example/second-source"], [], 1, {
    hostCoordinator: other, priorityLane: "realtime",
    providerFactory: () => ({ getBlockNumber: async () => { calls++; return 123; } }),
  });
  await assert.rejects(failing.getBlockNumber(), /429/);
  await assert.rejects(healthy.getBlockNumber(), (error) => /cooling down/.test(error.message)
    && error.retryAfterMs > 55_000 && error.rpcFailureScope === "host");
  assert.equal(calls, 1);
  assert.equal(gate.snapshot().leases.length, 0);
  assert.equal(gate.snapshot().circuits.length, 1);
});

test("head, raw chain identity and fixed block reads prefer an idle host without extra capacity", async (t) => {
  const { gate } = await fixture(t);
  const busy = gate.tryAcquire("busy.test", "eth_getLogs", "background");
  const calls = [];
  const pool = createRpcPool(["https://busy.test", "https://idle.test"], [], 1, {
    hostCoordinator: gate, requestTimeoutMs: 100,
    providerFactory: url => ({
      getBlockNumber: async () => { calls.push([url, "head"]); return 100; },
      send: async (method) => { calls.push([url, method]); return "0x38"; },
      getBlock: async (tag) => { calls.push([url, tag]); return { number: tag }; },
    }),
  });
  t.after(() => pool.destroy());
  assert.equal(await pool.getBlockNumber(), 100);
  assert.equal(await pool.send("eth_chainId", []), "0x38");
  assert.equal((await pool.getBlock(99)).number, 99);
  assert.deepEqual(calls, [["https://idle.test", "head"], ["https://idle.test", "eth_chainId"], ["https://idle.test", 99]]);
  assert.equal(gate.snapshot().leases.length, 1);
  gate.release(busy);
});

test("non-state reads avoid shared method cooldown while unrelated methods remain eligible", async (t) => {
  const { gate } = await fixture(t);
  gate.cooldown("cool.test", "getBlock", Date.now() + 60_000, "method");
  const calls = [];
  const pool = createRpcPool(["https://cool.test", "https://idle.test"], [], 1, {
    hostCoordinator: gate,
    providerFactory: url => ({
      getBlock: async tag => { calls.push([url, tag]); return { number: tag }; },
      send: async method => { calls.push([url, method]); return "0x38"; },
    }),
  });
  t.after(() => pool.destroy());
  assert.equal((await pool.getBlock(99)).number, 99);
  await pool.send("eth_chainId", []);
  await pool.send("eth_chainId", []);
  assert.deepEqual(calls, [["https://idle.test", 99], ["https://idle.test", "eth_chainId"], ["https://cool.test", "eth_chainId"]]);
});

test("monitor queue wait is bounded, opt-in and cannot increase shared host slots", async () => {
  const waits = [];
  const coordinator = {
    snapshot: () => ({ leases: [], circuits: [] }),
    run: async (_host, _method, lane, callback, options) => {
      waits.push([lane, options.waitMs]); return callback();
    },
  };
  for (const physicalWaitMs of [undefined, 3_000, 60_000]) {
    const pool = createRpcPool(["https://rpc.test"], [], 1, {
      hostCoordinator: coordinator, physicalWaitMs, requestTimeoutMs: 7_000,
      providerFactory: () => ({ getBlockNumber: async () => 100 }),
    });
    await pool.getBlockNumber(); pool.destroy();
  }
  assert.deepEqual(waits, [["background", 1_000], ["background", 3_000], ["background", 5_000]]);
});

test("shared background queue is FIFO across coordinators and leaves realtime capacity usable", async (t) => {
  const { gate, file } = await fixture(t);
  const other = createRpcHostCoordinator({ file }); t.after(() => other.close());
  const active = gate.tryAcquire("rpc.test", "getCode", "background");
  const order = [];
  const first = other.run("rpc.test", "getBlockNumber", "background", async () => { order.push("first"); await delay(20); }, { waitMs: 500 });
  const second = gate.run("rpc.test", "getBlock", "background", async () => { order.push("second"); }, { waitMs: 500 });
  const realtime = gate.tryAcquire("rpc.test", "eth_getLogs", "realtime");
  assert.ok(realtime, "background waiters cannot consume the realtime reserve");
  gate.release(active);
  assert.equal(gate.tryAcquire("rpc.test", "getCode", "background"), null, "a new poll cannot steal the released slot");
  gate.release(realtime);
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(gate.snapshot().leases.length, 0);
});

test("timed-out waiters and upstream cooldown failures leave no queue obstacle", async (t) => {
  const { gate } = await fixture(t);
  const active = gate.tryAcquire("rpc.test", "getCode", "background");
  await assert.rejects(gate.run("rpc.test", "getBlockNumber", "background", () => assert.fail("not admitted"), { waitMs: 10 }), /capacity wait deadline/);
  gate.release(active);
  assert.equal(await gate.run("rpc.test", "getCode", "background", () => 1), 1);
  gate.cooldown("rpc.test", "getBlock", Date.now() + 10_000, "method");
  await assert.rejects(gate.run("rpc.test", "getBlock", "background", () => assert.fail("cooling")), /cooling down/);
  assert.equal(await gate.run("rpc.test", "getCode", "background", () => 2), 2);
});
