import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createRpcStateReadBudget, createRpcPoolSlots, createRpcStateSourceAffinity } from "../src/rpc-state-read-budget.js";
import { createRpcPool } from "../src/bsc-launchpad-monitor.js";

const address = `0x${"1".repeat(40)}`;
const budgetFailure = error => error.rpcBudgetExhausted === true
  && error.rpcFailureScope === "method" && error.rpcCircuitAlreadyOpen === true;

test('state source affinity is short-lived, scope-specific and never orders object/log reads', () => {
  let clock=1000;
  const affinity=createRpcStateSourceAffinity({now:()=>clock});
  affinity.success('archive','getCode',[address,100],1);
  assert.deepEqual(affinity.order('archive','getCode',[address,101],[0,1,2]),[1,0,2]);
  for(const [pool,method,args] of [['standard','getCode',[address,100]],['archive','getStorage',[address,0,100]],
    ['archive','getCode',[address,'latest']],['archive','getCode',[address,'pending']],['archive','getBlock',[100]]]) {
    assert.deepEqual(affinity.order(pool,method,args,[0,1,2]),[0,1,2]);
  }
  clock+=60000;assert.deepEqual(affinity.order('archive','getCode',[address,101],[0,1,2]),[0,1,2]);
  affinity.success('archive','getCode',[address,101],2);
  affinity.failure('archive','getCode',[address,101],2);
  assert.deepEqual(affinity.order('archive','getCode',[address,101],[0,1,2]),[0,1,2]);
});

test('budgeted historical state reuses successful source ordering, not cached values or rewritten block tags', async () => {
  const calls=[];
  const pool=createRpcPool(['https://standard.test'],['https://good.test','https://unproven.test'],2,{
    stateReadBudgetMs:30000,stateReadMaxAttempts:2,requestTimeoutMs:100,
    providerFactory:url=>({getCode:async(a,tag)=>{calls.push({url,a,tag});return `0x${tag}`;}}),
  });
  assert.equal(await pool.getCode(address,100),'0x100');
  assert.equal(await pool.getCode(address,101),'0x101');
  assert.deepEqual(calls.map(c=>c.url),['https://good.test','https://good.test']);
  assert.deepEqual(calls.map(c=>c.tag),[100,101]);
  assert.equal(pool.getStateReadHealth().sourceAffinity.preferredSelections,1);
  pool.destroy();
});

test('successful state affinity yields to real 429 cooldown and keeps bounded fallback available', async () => {
  const calls=[];let fail=false;
  const pool=createRpcPool(['https://good.test','https://backup.test'],[],2,{
    stateReadBudgetMs:30000,stateReadMaxAttempts:2,requestTimeoutMs:100,
    providerFactory:url=>({getCode:async(_a,tag)=>{
      calls.push({url,tag});
      if(fail&&url.includes('good'))throw Object.assign(new Error('HTTP 429'),{status:429,retryAfterMs:60000});
      return '0x6000';
    }}),
  });
  await pool.getCode(address,100);fail=true;
  await pool.getCode(address,101);await pool.getCode(address,102);
  assert.deepEqual(calls.map(c=>c.url),['https://good.test','https://good.test','https://backup.test','https://backup.test']);
  assert.equal(pool.getStateReadHealth().endpointAttempts,4);
  assert.equal(pool.getStateReadHealth().standardSlots.active,0);
  pool.destroy();
});

test('a busy successful state source yields before consuming the bounded attempt budget', async () => {
  let busy=false;const called=[];
  const pool=createRpcPool(['https://good.test','https://idle.test'],[],2,{
    stateReadBudgetMs:30000,stateReadMaxAttempts:2,requestTimeoutMs:100,
    hostCoordinator:{
      snapshot:()=>({leases:busy?[{host:'good.test',lane:'background'}]:[]}),
      run:async(host,_method,_lane,callback)=>{called.push(host);assert.ok(!busy||host!=='good.test');return callback();},
    },
    providerFactory:()=>({getCode:async()=> '0x6000'}),
  });
  await pool.getCode(address,100);busy=true;
  await pool.getCode(address,101);
  assert.deepEqual(called,['good.test','idle.test']);
  assert.equal(pool.getStateReadHealth().endpointAttempts,2);
  assert.equal(pool.getStateReadHealth().sourceAffinity.capacityReorders,1);
  pool.destroy();
});

test('capacity hints cannot bypass authoritative RPC admission after a racing lease', async () => {
  let attempted=0,physical=0;
  const pool=createRpcPool(['https://a.test','https://b.test','https://c.test'],[],2,{
    stateReadBudgetMs:30000,stateReadMaxAttempts:2,requestTimeoutMs:100,
    hostCoordinator:{snapshot:()=>({leases:[]}),run:async()=>{attempted++;throw Object.assign(new Error('capacity raced'),{
      rpcCircuitAlreadyOpen:true,rpcFailureScope:'capacity',code:'RPC_COORDINATOR_UNAVAILABLE'});}},
    providerFactory:()=>({getCode:async()=>{physical++;return '0x6000';}}),
  });
  await assert.rejects(pool.getCode(address,100),budgetFailure);
  assert.equal(attempted,2);assert.equal(physical,0);pool.destroy();
});

test('fresh pool avoids shared method cooldowns before spending state attempts, without changing other methods', async () => {
  const calls=[];
  const pool=createRpcPool(['https://cool.test','https://ready.test'],[],2,{
    stateReadBudgetMs:30000,stateReadMaxAttempts:2,requestTimeoutMs:100,
    hostCoordinator:{snapshot:()=>({leases:[],circuits:[{host:'cool.test',operation:'eth_getCode',until_ms:Date.now()+60000}]}),
      run:async(host,method,_lane,callback)=>{calls.push([host,method]);return callback();}},
    providerFactory:()=>({getCode:async()=> '0x6000',getStorage:async()=> '0x00'}),
  });
  await pool.getCode(address,100);await pool.getStorage(address,0,100);
  assert.deepEqual(calls,[['ready.test','getCode'],['cool.test','getStorage']]);
  assert.equal(pool.getStateReadHealth().sourceAffinity.cooldownReorders,1);
  assert.equal(pool.getStateReadHealth().endpointAttempts,2);pool.destroy();
});

test("state fallback shares one attempt budget across archive and standard pools", async () => {
  const calls = [];
  const pool = createRpcPool(["https://standard.test"], ["https://archive-a.test", "https://archive-b.test"], 2, {
    stateReadBudgetMs: 30_000, stateReadMaxAttempts: 2, requestTimeoutMs: 100,
    providerFactory: url => ({
      getCode: async (_address, tag) => { calls.push({ url, tag }); throw new Error("missing trie node"); },
      getBlockNumber: async () => 123,
    }),
  });
  await assert.rejects(pool.getCode(address, 100), budgetFailure);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(v => v.tag === 100 && v.url.includes("archive")));
  assert.equal(await pool.getBlockNumber(), 123, "state admission failure must not gate object reads");
  assert.equal(pool.getStateReadHealth().exhausted, 1);
  pool.destroy();
});

test("state budget reserves a complete transport timeout before each new endpoint", async () => {
  let clock = 1000;
  const calls = [];
  const pool = createRpcPool(["https://standard.test"], ["https://a.test", "https://b.test"], 1, {
    stateReadBudgetMs: 10_000, stateReadMaxAttempts: 2, stateReadBudgetNow: () => clock, requestTimeoutMs: 7000,
    providerFactory: url => ({ getCode: async () => { calls.push(url); clock += 5000; throw new Error("request timed out"); } }),
  });
  await assert.rejects(pool.getCode(address, 100), budgetFailure);
  assert.equal(calls.length, 1, "insufficient time for a whole next attempt means yield, not abandon its socket");
  assert.equal(pool.getStateReadHealth().lastDurationMs, 5000);
  pool.destroy();
});

test("budgeted retries rotate past locally busy archive hosts without inventing upstream cooldowns", async () => {
  const attempted = [];
  const pool = createRpcPool(["https://standard.test"], ["https://a.test", "https://b.test", "https://c.test", "https://d.test"], 2, {
    stateReadBudgetMs: 30_000, stateReadMaxAttempts: 2, requestTimeoutMs: 100,
    hostCoordinator: {
      async run(host, _method, _lane, callback) {
        attempted.push(host);
        if (host !== "d.test") throw Object.assign(new Error("capacity busy"), {
          code: "RPC_COORDINATOR_UNAVAILABLE", rpcFailureScope: "capacity", rpcCircuitAlreadyOpen: true,
        });
        return callback();
      },
      persistCooldown: async () => assert.fail("local capacity is not a new upstream failure"),
    },
    providerFactory: () => ({ getCode: async () => "0x6000" }),
  });
  await assert.rejects(pool.getCode(address, 100), budgetFailure);
  assert.equal(await pool.getCode(address, 100), "0x6000");
  assert.deepEqual(attempted, ["a.test", "b.test", "c.test", "d.test"]);
  pool.destroy();
});

test("only overlapping identical state reads coalesce; block tags, methods and later reads stay distinct", async () => {
  const calls = [];
  const pool = createRpcPool(["https://state.test"], [], 2, {
    stateReadBudgetMs: 30_000, requestTimeoutMs: 500,
    providerFactory: () => ({
      getCode: async (...args) => { calls.push(["code", ...args]); await delay(15); return "0x6000"; },
      getStorage: async (...args) => { calls.push(["storage", ...args]); await delay(15); return "0x00"; },
      call: async (...args) => { calls.push(["call", ...args]); await delay(15); return "0x01"; },
    }),
  });
  await Promise.all([
    pool.getCode(address, 100), pool.getCode(address, 100), pool.getCode(address, 101),
    pool.getStorage(address, 0n, 100), pool.getStorage(address, 0n, 100),
    pool.call({ to: address, data: "0x", blockTag: 100 }), pool.call({ to: address, data: "0x", blockTag: 100 }),
  ]);
  assert.equal(calls.length, 4);
  assert.equal(pool.getStateReadHealth().joined, 3);
  assert.equal(pool.getStateReadHealth().coalescedKeys, 0);
  await pool.getCode(address, 100);
  assert.equal(calls.length, 5, "this is not a persistent historical or latest-state cache");
  assert.equal(pool.getStateReadHealth().active, 0);
  pool.destroy();
});

test("budget queue expiry removes the waiter and cannot steal or leak a transferred slot", async () => {
  const slots = createRpcPoolSlots(1);
  let release;
  const first = slots.run(() => new Promise(resolve => { release = resolve; }));
  await delay(0);
  const guard = createRpcStateReadBudget({ budgetMs: 30 });
  let expiredRan = false;
  await assert.rejects(guard.run("getCode", [address, 100], budget => slots.run(() => { expiredRan = true; }, budget)), budgetFailure);
  assert.equal(expiredRan, false);
  assert.deepEqual(slots.snapshot(), { active: 1, waiting: 0, limit: 1 });
  const third = slots.run(async () => "next");
  release();
  await first;
  assert.equal(await third, "next");
  assert.deepEqual(slots.snapshot(), { active: 0, waiting: 0, limit: 1 });
});

test("failed coalesced reads are evicted and later calls get a fresh attempt", async () => {
  const guard = createRpcStateReadBudget({ budgetMs: 1000 });
  let attempts = 0;
  const read = () => guard.run("getCode", [address, 100], async () => { attempts++; await delay(5); throw new Error("fixture unavailable"); });
  const results = await Promise.allSettled([read(), read()]);
  assert.ok(results.every(v => v.status === "rejected"));
  assert.equal(attempts, 1);
  await assert.rejects(read(), /unavailable/);
  assert.equal(attempts, 2);
  assert.equal(guard.snapshot().active, 0);
  assert.equal(guard.snapshot().coalescedKeys, 0);
});

test("historical state failover preserves exact getCode, storage and call block tags", async () => {
  const calls = [];
  const pool = createRpcPool(["https://standard.test"], ["https://archive.test"], 2, {
    stateReadBudgetMs: 30_000, stateReadMaxAttempts: 2, requestTimeoutMs: 100,
    providerFactory: (_url, { kind }) => Object.fromEntries(["getCode", "getStorage", "call"].map(method => [method, async (...args) => {
      calls.push({ kind, method, args });
      if (kind === "archive") throw new Error("missing trie node");
      return "0x6000";
    }])),
  });
  await pool.getCode(address, 100);
  await pool.getStorage(address, 0n, 101);
  await pool.call({ to: address, data: "0x", blockTag: 102 });
  assert.equal(calls.length, 6);
  for (let i = 0; i < 6; i += 2) assert.deepEqual(calls[i].args, calls[i + 1].args);
  pool.destroy();
});

test("local retry exhaustion cannot erase an upstream Retry-After circuit", async () => {
  const registry = new Map();
  const clock = 1000;
  const pool = createRpcPool(["https://standard.test"], ["https://rate.test", "https://missing.test"], 2, {
    stateReadBudgetMs: 30_000, stateReadMaxAttempts: 2, requestTimeoutMs: 100, now: () => clock,
    hostCircuitRegistry: registry,
    providerFactory: url => ({ getCode: async () => {
      if (url.includes("rate")) throw Object.assign(new Error("HTTP 429"), { status: 429, retryAfterMs: 60_000 });
      throw new Error("missing trie node");
    } }),
  });
  await assert.rejects(pool.getCode(address, 100), budgetFailure);
  assert.ok(registry.get("rate.test").globalUntil >= clock + 60_000);
  assert.equal(registry.get("standard.test").globalUntil, 0);
  pool.destroy();
});

test("budgeted transport failure closes the real HTTP request before later work reuses its slot", async t => {
  let active = 0, released = 0;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    active++;
    res.once("close", () => { active--; released++; });
    req.resume(); // Deliberately never answer this state read.
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const pool = createRpcPool([`http://127.0.0.1:${server.address().port}`], [], 1, {
    requestTimeoutMs: 1000, stateReadBudgetMs: 2500, stateReadMaxAttempts: 2,
    standardConcurrency: 1, hostCircuitRegistry: new Map(),
  });
  t.after(async () => { pool.destroy(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(pool.getCode(address, 100), /timeout|timed out/);
  for (let n = 0; n < 100 && !released; n++) await delay(20);
  assert.equal(active, 0);
  assert.equal(released, 1);
  assert.equal(pool.getStateReadHealth().standardSlots.active, 0);
});
