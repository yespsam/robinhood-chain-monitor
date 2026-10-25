import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { keccak256 } from "ethers";
import {
  FOUR_CORE_ADDRESS, FOUR_CORE_INTERFACE, FOUR_REGISTRY_ADDRESS, FOUR_REGISTRY_INTERFACE,
  FOUR_REGISTRY_MULTICALL3_ADDRESS, FOUR_REGISTRY_MULTICALL3_INTERFACE,
  createFourRegistryMonitor, readFourRegistryInventory, settleFourRpcReads, verifyFourRegistryIdentity,
} from "../src/four-registry-monitor.js";

const capacity = (retryAfterMs = 100) => Object.assign(new Error("shared RPC coordinator: capacity wait deadline"), {
  code: "RPC_COORDINATOR_UNAVAILABLE", rpcFailureScope: "capacity", rpcCircuitAlreadyOpen: true,
  rpcOperation: "eth_getBlockByNumber", retryAfterMs,
});
const upstream429 = (retryAfterMs = 90_000) => Object.assign(new Error("HTTP 429"), {
  code: "SERVER_ERROR", status: 429, rpcFailureScope: "host", retryAfterMs,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("Four quorum waits for its peer and preserves a later real 429 instead of the first capacity refusal", async () => {
  const peer = deferred();
  let finished = false;
  const result = settleFourRpcReads([Promise.reject(capacity()), peer.promise])
    .catch(error => { finished = true; return error; });
  await nextTurn();
  assert.equal(finished, false, "the peer must drain before another check can start");
  peer.reject(upstream429(95_000));
  const error = await result;
  assert.equal(error.rpcFailureScope, "host");
  assert.equal(error.retryAfterMs, 95_000);
  assert.equal(error.rpcHostRetryAfterMs, 95_000);
  assert.match(error.message, /429/);
});

test("Four quorum retains the longest local wait and never returns a partial success", async () => {
  await assert.rejects(settleFourRpcReads([Promise.reject(capacity(100)), Promise.reject(capacity(7_500))]),
    error => error.rpcFailureScope === "capacity" && error.retryAfterMs === 7_500);
  await assert.rejects(settleFourRpcReads([Promise.resolve({ verified: true }), Promise.reject(capacity())]),
    error => error.rpcFailureScope === "capacity");
  assert.deepEqual(await settleFourRpcReads([Promise.resolve(2), Promise.resolve(1)]), [2, 1]);
});

test("Four proof failure is not reclassified as capacity, while every prerequisite wait is retained", async () => {
  const proof = Object.assign(new Error("canonical block mismatch"), { code: "FOUR_REGISTRY_LOG_NOT_CANONICAL" });
  await assert.rejects(settleFourRpcReads([Promise.reject(capacity(8_000)), Promise.reject(proof)]), error => {
    assert.equal(error.code, proof.code);
    assert.equal(error.rpcFailureScope, undefined);
    assert.equal(error.retryAfterMs, 8_000);
    return true;
  });
});

test("Four nested identity wrapper preserves capacity and drains already-started identity reads", async () => {
  const remaining = deferred();
  let completed = false;
  const result = verifyFourRegistryIdentity({
    getNetwork: async () => { throw capacity(650); },
    getBlock: async () => ({ number: 100 }),
    getCode: async () => { await remaining.promise; return "0x6000"; },
  }, 100).catch(error => { completed = true; return error; });
  await nextTurn();
  assert.equal(completed, false);
  remaining.resolve();
  const error = await result;
  assert.equal(error.code, "FOUR_REGISTRY_IDENTITY_UNAVAILABLE");
  assert.equal(error.rpcFailureScope, "capacity");
  assert.equal(error.retryAfterMs, 650);
  assert.equal(error.rpcCircuitAlreadyOpen, true);
});

const block = number => ({ number, hash: `0x${BigInt(number).toString(16).padStart(64, "0")}`, timestamp: 1_788_508_600 + number });
function emptyProvider() {
  const provider = {
    head: 102, getNetwork: async () => ({ chainId: 56n }), send: async () => "0x38",
    getBlockNumber: async () => provider.head,
    getBlock: async number => block(number), getCode: async () => "0x6000",
    getLogs: async () => [], getTransactionReceipt: async () => null, getTransaction: async () => null,
    call: async request => {
      const to = request.to.toLowerCase();
      if (to === FOUR_REGISTRY_MULTICALL3_ADDRESS) {
        const parsed = FOUR_REGISTRY_MULTICALL3_INTERFACE.parseTransaction({ data: request.data });
        const results = [];
        for (const item of parsed.args[0]) results.push([true, await provider.call({ to: item.target, data: item.callData, blockTag: request.blockTag })]);
        return FOUR_REGISTRY_MULTICALL3_INTERFACE.encodeFunctionResult("aggregate3", [results]);
      }
      if (to === FOUR_CORE_ADDRESS) return FOUR_CORE_INTERFACE.encodeFunctionResult("registry", [FOUR_REGISTRY_ADDRESS]);
      const parsed = FOUR_REGISTRY_INTERFACE.parseTransaction({ data: request.data });
      return FOUR_REGISTRY_INTERFACE.encodeFunctionResult(parsed.name, [parsed.name === "openFourCore" ? FOUR_CORE_ADDRESS : []]);
    },
  };
  return provider;
}

function monitorFixture(dependencies = {}) {
  const providers = Array.from({ length: 4 }, emptyProvider);
  let durable = null, writes = 0;
  const monitor = createFourRegistryMonitor({ fourRegistryConfirmations: 2, fourRegistryPollIntervalMs: 5_000 }, {
    provider: providers[0],
    logVerificationProviders: providers.slice(0, 2).map((provider, index) => ({ sourceId: `logs-${index}.test`, provider })),
    stateVerificationProviders: providers.slice(2).map((provider, index) => ({ sourceId: `state-${index}.test`, provider })),
    fsImpl: { readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } },
    atomicWriteImpl: async (_file, value) => { durable = structuredClone(value); writes++; },
    multicall3CodeHashForTesting: keccak256("0x6000"),
    logger: { error() {} }, now: () => Date.parse("2026-10-21T00:00:00.000Z"),
    ...dependencies,
  });
  return { providers, monitor, durable: () => durable, writes: () => writes };
}

test("Four head telemetry follows durable commit and reuses fixed readers no more than once per minute", async (t) => {
  let now = Date.parse("2026-10-21T00:00:00.000Z");
  const snapshots = [], probeCalls = [];
  const fixture = monitorFixture({
    now: () => now, headObservationFile: "/missing/four-head-observation-fixture.json",
    writeHeadObservation: async (_file, snapshot) => {
      assert.ok(fixture.writes() > 0, "the scanner must commit before head telemetry");
      assert.deepEqual(snapshot.lastSuccess.cursor, fixture.durable().cursor);
      snapshots.push(structuredClone(snapshot));
    },
  });
  t.after(() => fixture.monitor.stop());
  fixture.providers.slice(2).forEach((provider, index) => {
    provider.getBlockNumber = async () => { probeCalls.push(index); return provider.head; };
  });
  fixture.providers[3].head = 103;
  assert.equal((await fixture.monitor.check()).status, "baseline");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].producer, "fourmeme");
  assert.equal(snapshots[0].displayOnly, true);
  assert.equal(snapshots[0].status, "verified");
  assert.deepEqual(snapshots[0].lastSuccess.sourceTips, [102, 103]);
  assert.equal(snapshots[0].lastSuccess.headNumber, 102);
  assert.equal(snapshots[0].lastSuccess.safeHead, 100);
  assert.equal(new Set(snapshots[0].lastSuccess.sourceIds).size, 2);
  assert.deepEqual(probeCalls, [0, 1]);
  now += 59_999;
  for (const provider of fixture.providers) provider.head = 105;
  assert.equal((await fixture.monitor.check()).status, "ok");
  assert.equal(fixture.durable().cursor.nextBlock, 104);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(probeCalls, [0, 1], "a successful scan must not bypass head-proof pacing");
  now += 1;
  assert.equal((await fixture.monitor.check()).status, "ok");
  assert.equal(snapshots.length, 2);
  assert.deepEqual(probeCalls, [0, 1, 0, 1]);
  assert.equal(snapshots[1].lastSuccess.cursor.nextBlock, 104);
  assert.equal(snapshots[1].lastSuccess.safeHead, 103);
});

test("Four head-only disagreement, 429, and sidecar write failure cannot change the successful durable scan", async (t) => {
  const control = monitorFixture();
  t.after(() => control.monitor.stop());
  const expected = await control.monitor.check();
  for (const mode of ["disagreement", "429", "write"]) {
    await t.test(mode, async (subtest) => {
      let snapshot;
      const fixture = monitorFixture({
        headObservationFile: "/missing/four-head-observation-fixture.json",
        writeHeadObservation: async (_file, value) => {
          snapshot = structuredClone(value);
          if (mode === "write") throw new Error("sidecar disk unavailable");
        },
      });
      subtest.after(() => fixture.monitor.stop());
      const provider = fixture.providers[3];
      provider.getBlock = async number => {
        if (number === provider.head && mode === "429") throw upstream429();
        return number === provider.head && mode === "disagreement"
          ? { ...block(number), hash: "0x" + "f".repeat(64) } : block(number);
      };
      assert.deepEqual(await fixture.monitor.check(), expected);
      assert.deepEqual(fixture.durable(), control.durable(), "telemetry cannot alter cursor, outbox, or scanner proofs");
      assert.equal(snapshot.displayOnly, true);
      assert.equal(snapshot.status, mode === "write" ? "verified" : "error");
      assert.equal(snapshot.errorCode, mode === "disagreement" ? "CHAIN_HEAD_CONSENSUS_MISMATCH"
        : mode === "429" ? "CHAIN_HEAD_RPC_RATE_LIMITED" : null);
      if (mode !== "write") assert.equal(snapshot.lastSuccess, null);
    });
  }
});

test("Four failed and stopped collection cycles never start an extra head probe", async (t) => {
  let now = Date.parse("2026-10-21T00:00:00.000Z"), probes = 0, snapshots = 0;
  const fixture = monitorFixture({
    now: () => now, headObservationFile: "/missing/four-head-observation-fixture.json",
    writeHeadObservation: async () => { snapshots++; },
  });
  t.after(() => fixture.monitor.stop());
  for (const provider of fixture.providers.slice(2)) {
    provider.getBlockNumber = async () => { probes++; return provider.head; };
  }
  assert.equal((await fixture.monitor.check()).status, "baseline");
  const before = structuredClone(fixture.durable());
  now += 60_000;
  fixture.providers[0].getBlockNumber = async () => { throw capacity(); };
  assert.equal((await fixture.monitor.check()).status, "degraded");
  assert.deepEqual(fixture.durable(), before);
  assert.equal(probes, 2);
  assert.equal(snapshots, 1);
  await fixture.monitor.stop();
  assert.equal((await fixture.monitor.check()).status, "stopped");
  assert.equal(probes, 2);
});

test("Four capacity checks preserve durable cursor and real-failure history without growing upstream backoff", async () => {
  const fixture = monitorFixture();
  assert.equal((await fixture.monitor.check()).status, "baseline");
  const original = structuredClone(fixture.durable());
  const writes = fixture.writes();
  let failure = capacity();
  fixture.providers[0].getBlockNumber = async () => { throw failure; };
  for (let index = 0; index < 4; index++) {
    const result = await fixture.monitor.check();
    assert.equal(result.rpcFailureScope, "capacity");
    assert.equal(result.consecutiveFailures, 0);
    assert.equal(result.retryAfterMs, 5_000);
  }
  failure = Object.assign(new Error("upstream read timeout"), { code: "TIMEOUT", rpcFailureScope: "method" });
  assert.equal((await fixture.monitor.check()).consecutiveFailures, 1);
  failure = capacity(9_000);
  const capacityAfterFailure = await fixture.monitor.check();
  assert.equal(capacityAfterFailure.consecutiveFailures, 1);
  assert.equal(capacityAfterFailure.retryAfterMs, 9_000);
  failure = Object.assign(new Error("upstream read timeout"), { code: "TIMEOUT", rpcFailureScope: "method" });
  const secondFailure = await fixture.monitor.check();
  assert.equal(secondFailure.consecutiveFailures, 2);
  assert.equal(secondFailure.retryAfterMs, 10_000);
  assert.equal(fixture.writes(), writes);
  assert.deepEqual(fixture.durable(), original);
  await fixture.monitor.stop();
});

test("Four state quorum rejects partial evidence, retains the peer cooldown and resumes only after both recover", async () => {
  const fixture = monitorFixture();
  assert.equal((await fixture.monitor.check()).status, "baseline");
  const cursor = structuredClone(fixture.durable().cursor);
  const peer = deferred();
  fixture.providers[0].head = 105;
  fixture.providers[2].getBlock = async () => { throw capacity(); };
  fixture.providers[3].getBlock = async () => { await peer.promise; throw upstream429(120_000); };
  let completed = false;
  const check = fixture.monitor.check().then(result => { completed = true; return result; });
  await nextTurn();
  assert.equal(completed, false);
  peer.resolve();
  const failed = await check;
  assert.equal(failed.rpcFailureScope, "host");
  assert.equal(failed.retryAfterMs, 120_000);
  assert.equal(failed.consecutiveFailures, 1);
  assert.deepEqual(fixture.durable().cursor, cursor);
  for (const provider of fixture.providers.slice(2)) provider.getBlock = async number => block(number);
  assert.equal((await fixture.monitor.check()).status, "ok");
  assert.equal(fixture.durable().cursor.nextBlock, 104);
  await fixture.monitor.stop();
});

test("Four inventory failure drains started workers and stops admitting unused preset reads", async () => {
  const peers = deferred();
  const requested = [];
  const zero = "0x" + "0".repeat(64), address = "0x" + "1".repeat(40);
  const provider = { call: async request => {
    const parsed = FOUR_REGISTRY_INTERFACE.parseTransaction({ data: request.data });
    if (parsed.name === "getPresetIds") return FOUR_REGISTRY_INTERFACE.encodeFunctionResult(parsed.name, [[1n, 2n, 3n, 4n, 5n, 6n]]);
    const id = parsed.args[0];
    if (parsed.name === "getPreset") {
      requested.push(Number(id));
      if (id === 1n) throw capacity();
      await peers.promise;
      return FOUR_REGISTRY_INTERFACE.encodeFunctionResult(parsed.name, [[id, "Preset", "", "1", true, true,
        address, zero, zero, zero, zero, zero, zero, zero, address]]);
    }
    return FOUR_REGISTRY_INTERFACE.encodeFunctionResult(parsed.name, [true]);
  } };
  let completed = false;
  const work = readFourRegistryInventory(provider, 100).catch(error => { completed = true; return error; });
  await nextTurn();
  assert.equal(completed, false);
  assert.deepEqual(requested, [1, 2, 3, 4]);
  peers.resolve();
  assert.equal((await work).rpcFailureScope, "capacity");
  assert.deepEqual(requested, [1, 2, 3, 4], "presets 5 and 6 were not started after failure");
});
