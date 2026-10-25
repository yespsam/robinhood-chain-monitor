import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRpcPool } from "../src/bsc-launchpad-monitor.js";
import { createRpcHostCoordinator } from "../src/rpc-host-coordinator.js";

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "static-rpc-network-"));
  const gate = createRpcHostCoordinator({ file: path.join(dir, "rpc.sqlite"), ...options });
  t.after(async () => { gate.close(); await rm(dir, { recursive: true, force: true }); });
  return gate;
}

test("default static network metadata uses neither physical capacity nor transport", async (t) => {
  const gate = await fixture(t);
  const leases = [gate.tryAcquire("rpc.static.test", "eth_call", "background"),
    gate.tryAcquire("rpc.static.test", "eth_getLogs", "realtime")];
  assert.ok(leases.every(Boolean));
  let fetches = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches++; throw new Error("unexpected transport"); };
  t.after(() => { globalThis.fetch = previousFetch; });
  const pool = createRpcPool(["https://rpc.static.test"], [], 1, {
    hostCoordinator: gate, hostCircuitRegistry: new Map(), physicalWaitMs: 10,
  });
  try {
    const before = gate.snapshot();
    assert.equal((await pool.getNetwork()).chainId, 56n);
    assert.equal((await pool.getNetwork()).chainId, 56n);
    assert.deepEqual(gate.snapshot(), before, "local metadata must not queue or release a physical lease");
    await assert.rejects(pool.send("eth_chainId", []), e => e.rpcFailureScope === "capacity");
    assert.equal(fetches, 0, "real identity reads still wait for the shared physical capacity");
  } finally { pool.destroy(); for (const lease of leases) gate.release(lease); }
});

for (const scope of ["method", "host"]) {
  test(`static metadata cannot clear ${scope} cooldown or consume its half-open probe`, async (t) => {
    let current = 5_000;
    const gate = await fixture(t, { now: () => current });
    gate.cooldown("rpc.static.test", "eth_chainId", 10_000, scope);
    let fetches = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      fetches++;
      const request = JSON.parse(Buffer.from(options.body).toString());
      assert.equal(request.method, "eth_chainId");
      // A remote mismatch must remain visible; local 56 is not remote proof.
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x1" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    t.after(() => { globalThis.fetch = previousFetch; });
    const pool = createRpcPool(["https://rpc.static.test"], [], 1, {
      hostCoordinator: gate, hostCircuitRegistry: new Map(), now: () => current, requestTimeoutMs: 1_000,
    });
    try {
      const before = gate.snapshot();
      assert.equal((await pool.getNetwork()).chainId, 56n);
      assert.deepEqual(gate.snapshot(), before);
      await assert.rejects(pool.send("eth_chainId", []), e => e.rpcFailureScope === scope && e.retryAfterMs >= 5_000);
      assert.equal(fetches, 0);
      current = 10_001;
      assert.equal((await pool.getNetwork()).chainId, 56n);
      assert.deepEqual(gate.snapshot().circuits, before.circuits, "cached success must not heal an expired circuit");
      assert.equal(await pool.send("eth_chainId", []), "0x1", "real chain response must not be replaced by static metadata");
      assert.equal(fetches, 1, "only the admitted live read may recover the circuit");
      assert.equal(gate.snapshot().circuits[0].until_ms, 0);
      assert.equal(gate.snapshot().leases.length, 0);
    } finally { pool.destroy(); }
  });
}

test("custom provider getNetwork keeps shared admission and does not bypass cooldown", async (t) => {
  const gate = await fixture(t);
  let calls = 0;
  const options = {
    hostCoordinator: gate, physicalWaitMs: 10,
    providerFactory: () => ({ getNetwork: async () => { calls++; return { chainId: 1n }; } }),
  };
  const pool = createRpcPool(["https://rpc.custom.test"], [], 1, options);
  const lease = gate.tryAcquire("rpc.custom.test", "eth_call", "background");
  try {
    await assert.rejects(pool.getNetwork(), e => e.rpcFailureScope === "capacity");
    assert.equal(calls, 0);
    delete options.providerFactory;
    await assert.rejects(pool.getNetwork(), e => e.rpcFailureScope === "capacity");
    assert.equal(calls, 0, "mutating construction options cannot turn a custom provider into local metadata");
    gate.release(lease);
    gate.cooldown("rpc.custom.test", "eth_chainId", Date.now() + 60_000, "method");
    await assert.rejects(pool.getNetwork(), e => e.rpcFailureScope === "method");
    assert.equal(calls, 0, "custom network detection can perform I/O and must remain gated");
  } finally { pool.destroy(); }
});

test("an empty standard pool cannot invent network metadata from an archive endpoint", async () => {
  const pool = createRpcPool([], ["https://rpc.archive-only.test"], 1, { hostCircuitRegistry: new Map() });
  try { await assert.rejects(pool.getNetwork()); }
  finally { pool.destroy(); }
});
