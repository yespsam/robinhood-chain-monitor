import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChainHeadObserver } from "../src/chain-head-observation.js";

const START = Date.parse("2026-10-21T08:00:00.000Z");
const HASH = `0x${"ab".repeat(32)}`;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const snapshotFs = (value) => ({ async open() {
  const bytes = Buffer.from(JSON.stringify(value));
  return { async stat() { return { isFile: () => true, size: bytes.length, mtimeMs: 1, ctimeMs: 1, nlink: 1 }; },
    async read(buffer, offset, length, position) { return { bytesRead: bytes.copy(buffer, offset, position, position + length) }; },
    async close() {} };
} });

function fixture(overrides = {}) {
  let current = START;
  const calls = [], snapshots = [];
  const readers = [0, 1].map((index) => ({
    sourceId: `https://proof-${index}.example`,
    provider: {
      async send(method, params) { calls.push([index, method, params]); return "0x38"; },
      async getBlockNumber() { calls.push([index, "head"]); return 1_000; },
      async getBlock(number) { calls.push([index, "block", number]); return { number, hash: HASH, timestamp: START / 1_000 - 2 }; },
    },
  }));
  const options = { file: "/unused/head.json", producer: "four", providers: readers, confirmations: 12,
    now: () => current, fsImpl: { async open() { throw Object.assign(new Error(), { code: "ENOENT" }); } },
    writeSnapshot: async (_file, value) => { snapshots.push(structuredClone(value)); }, ...overrides };
  return { readers, calls, snapshots, options, advance: (ms) => { current += ms; }, setTime: (value) => { current = value; } };
}

test("two independent fixed sources produce a display-only, secret-free head snapshot", async () => {
  const f = fixture();
  const result = await createChainHeadObserver(f.options).observe();
  assert.equal(result.status, "verified");
  assert.equal(result.displayOnly, true);
  assert.equal(result.version, "chain_head_observation_v1");
  assert.equal(result.chainId, 56);
  assert.deepEqual(result.lastSuccess.sourceTips, [1_000, 1_000]);
  assert.equal(result.lastSuccess.headNumber, 1_000);
  assert.equal(result.lastSuccess.safeHead, 988);
  assert.equal(result.lastSuccess.headSpread, 0);
  assert.equal(result.lastSuccess.headHash, HASH);
  assert.equal(result.lastSuccess.startedAt, new Date(START).toISOString());
  assert.equal(result.lastSuccess.verifiedAt, new Date(START).toISOString());
  assert.ok(result.lastSuccess.sourceIds.every((value) => /^[a-f0-9]{64}$/.test(value)));
  assert.ok(!JSON.stringify(result).includes("example"));
  assert.equal(f.calls.length, 6);
  assert.deepEqual(f.snapshots, [result]);
});

test("different tip heights verify exactly the common lower head on both sources", async () => {
  const f = fixture();
  f.readers[1].provider.getBlockNumber = async () => 1_006;
  const { lastSuccess } = await createChainHeadObserver(f.options).observe();
  assert.deepEqual(lastSuccess.sourceTips, [1_000, 1_006]);
  assert.equal(lastSuccess.headSpread, 6);
  assert.deepEqual(f.calls.filter((call) => call[1] === "block").map((call) => call[2]), [1_000, 1_000]);
});

test("single-source, shared-host, shared-provider and credential URL configurations fail closed without RPC", async () => {
  for (const mutate of [
    (f) => { f.options.providers = f.readers.slice(0, 1); },
    (f) => { f.readers[1].sourceId = "http://proof-0.example:8080"; },
    (f) => { f.readers[1].provider = f.readers[0].provider; },
    (f) => { f.readers[1].sourceId = "https://secret:private@proof-1.example"; },
    (f) => { f.readers[1].sourceId = "https://proof-1.example/private-key"; },
  ]) {
    const f = fixture(); mutate(f);
    const result = await createChainHeadObserver(f.options).observe();
    assert.equal(result.status, "error"); assert.equal(result.lastSuccess, null);
    assert.equal(f.calls.length, 0);
    assert.ok(!JSON.stringify(result).includes("private"));
  }
});

test("wrong chain and malformed head abort before block requests", async () => {
  for (const mutate of [
    (f) => { f.readers[1].provider.send = async () => "0x1"; },
    (f) => { f.readers[1].provider.getBlockNumber = async () => null; },
    (f) => { f.readers[1].provider.getBlockNumber = async () => 1.5; },
    (f) => { f.readers[1].provider.getBlockNumber = async () => 11; },
  ]) {
    const f = fixture(); mutate(f);
    const result = await createChainHeadObserver(f.options).observe();
    assert.equal(result.status, "error"); assert.equal(result.lastSuccess, null);
    assert.equal(f.calls.filter((call) => call[1] === "block").length, 0);
  }
});

test("bad block number/hash/timestamp and dual-source disagreement fail closed", async () => {
  for (const override of [
    { number: 999 }, { hash: "0xshort" }, { hash: `0x${"cd".repeat(32)}` },
    { timestamp: null }, { timestamp: START / 1_000 + 31 }, { timestamp: START / 1_000 - 3 },
  ]) {
    const f = fixture();
    f.readers[1].provider.getBlock = async (number) => ({ number, hash: HASH, timestamp: START / 1_000 - 2, ...override });
    const result = await createChainHeadObserver(f.options).observe();
    assert.equal(result.status, "error"); assert.equal(result.lastSuccess, null);
  }
});

test("RPC 429 preserves old proof, drains peer request, applies declared cooldown and never retries", async () => {
  const f = fixture();
  const observer = createChainHeadObserver(f.options);
  const success = await observer.observe(); f.advance(60_000);
  const peer = deferred(); let peerStarted = false, attempts = 0;
  f.readers[0].provider.getBlockNumber = async () => { attempts += 1; throw Object.assign(new Error("429 https://secret.example/key"), { status: 429, retryAfterMs: 180_000 }); };
  f.readers[1].provider.getBlockNumber = async () => { peerStarted = true; return peer.promise; };
  let resolved = false;
  const pending = observer.observe().then((result) => { resolved = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerStarted, true); assert.equal(resolved, false);
  peer.resolve(1_000);
  const failed = await pending;
  assert.equal(failed.errorCode, "CHAIN_HEAD_RPC_RATE_LIMITED");
  assert.deepEqual(failed.lastSuccess, success.lastSuccess);
  assert.ok(!JSON.stringify(failed).includes("secret"));
  f.advance(120_000); await observer.observe(); assert.equal(attempts, 1);
  f.advance(60_000); await observer.observe(); assert.equal(attempts, 2);
});

test("capacity failure does not retry or issue block proofs", async () => {
  const f = fixture(); let attempts = 0;
  f.readers[0].provider.getBlockNumber = async () => { attempts += 1; throw Object.assign(new Error("capacity"), { rpcFailureScope: "capacity" }); };
  const observer = createChainHeadObserver(f.options);
  const result = await observer.observe();
  assert.equal(result.errorCode, "CHAIN_HEAD_RPC_CAPACITY");
  await observer.observe(); assert.equal(attempts, 1);
  assert.equal(f.calls.filter((call) => call[1] === "block").length, 0);
});

test("singleflight and minimum 60-second spacing share one successful attempt", async () => {
  const f = fixture({ intervalMs: 1 }); const wait = deferred();
  f.readers[0].provider.getBlockNumber = async () => wait.promise;
  const observer = createChainHeadObserver(f.options);
  const one = observer.observe(), two = observer.observe();
  assert.equal(one, two);
  wait.resolve(1_000); await one;
  f.advance(59_999); await observer.observe(); assert.equal(f.snapshots.length, 1);
  f.advance(1); await observer.observe(); assert.equal(f.snapshots.length, 2);
});

test("slow proof preserves earliest request time, rather than making old evidence fresh on completion", async () => {
  const f = fixture();
  f.readers[1].provider.getBlock = async (number) => { f.advance(180_000); return { number, hash: HASH, timestamp: START / 1_000 - 2 }; };
  const result = await createChainHeadObserver(f.options).observe();
  assert.equal(result.lastSuccess.startedAt, new Date(START).toISOString());
  assert.equal(result.lastSuccess.verifiedAt, new Date(START + 180_000).toISOString());
  assert.equal(result.lastSuccess.blockTimestamp, START / 1_000 - 2);
});

test("cursor snapshot is cloned after quorum, and partial log cursor remains explicit", async () => {
  const cursor = { nextBlock: 990, anchorBlock: 990, anchorBlockHash: HASH, afterLogIndex: 3 };
  const f = fixture({ getCursor: () => cursor });
  const result = await createChainHeadObserver(f.options).observe();
  assert.deepEqual(result.lastSuccess.cursor, cursor);
  assert.equal(result.lastSuccess.cursorObservedAt, result.lastSuccess.verifiedAt);
  cursor.nextBlock = 999;
  assert.equal(result.lastSuccess.cursor.nextBlock, 990);
  const invalid = fixture({ getCursor: () => ({ nextBlock: 990, anchorBlock: 989, anchorBlockHash: HASH, afterLogIndex: 3 }) });
  assert.equal((await createChainHeadObserver(invalid.options).observe()).errorCode, "CHAIN_HEAD_CURSOR_INVALID");
});

test("shutdown drains current requests and prevents starting the next proof phase", async () => {
  let stopped = false;
  const f = fixture({ isStopped: () => stopped }); const wait = deferred();
  f.readers[0].provider.getBlockNumber = async () => wait.promise;
  const observer = createChainHeadObserver(f.options), pending = observer.observe();
  await new Promise((resolve) => setImmediate(resolve)); stopped = true;
  let closed = false; const closing = observer.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(closed, false);
  wait.resolve(1_000); const result = await pending; await closing;
  assert.equal(result.errorCode, "CHAIN_HEAD_STOPPED");
  assert.equal(f.calls.filter((call) => call[1] === "block").length, 0);
});

test("atomic sidecar writes preserve a previous valid proof across restart/failure", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chain-head-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "head.json"), f = fixture({ file, fsImpl: fs, writeSnapshot: undefined });
  const success = await createChainHeadObserver(f.options).observe();
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), success);
  assert.deepEqual(await fs.readdir(directory), ["head.json"]);
  f.advance(60_000); f.readers[0].provider.getBlockNumber = async () => { throw new Error("offline"); };
  const restarted = await createChainHeadObserver(f.options).observe();
  assert.equal(restarted.status, "error"); assert.deepEqual(restarted.lastSuccess, success.lastSuccess);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), restarted);
});

test("rename failure does not replace previous durable proof or escape into the collector", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chain-head-write-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "head.json"), f = fixture({ file, fsImpl: fs, writeSnapshot: undefined });
  const success = await createChainHeadObserver(f.options).observe();
  const before = await fs.readFile(file, "utf8"); f.advance(60_000);
  f.options.fsImpl = { ...fs, async rename() { throw new Error("simulated write failure"); } };
  const failedWrite = await createChainHeadObserver(f.options).observe();
  assert.equal(failedWrite.persistenceErrorCode, "CHAIN_HEAD_WRITE_FAILED");
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.deepEqual(JSON.parse(before), success);
  assert.deepEqual(await fs.readdir(directory), ["head.json"]);
});

test("getNetwork fallback checks real chain identity when send is unavailable", async () => {
  const f = fixture();
  for (const reader of f.readers) { delete reader.provider.send; reader.provider.getNetwork = () => ({ chainId: 56n }); }
  assert.equal((await createChainHeadObserver(f.options).observe()).status, "verified");
});

test("foreign or malformed persisted proof is never resurrected on RPC failure", async () => {
  const baseline = fixture(); const saved = await createChainHeadObserver(baseline.options).observe();
  for (const mutate of [
    (value) => { value.producer = "flap"; },
    (value) => { value.lastSuccess.sourceIds[1] = value.lastSuccess.sourceIds[0]; },
    (value) => { value.lastSuccess.safeHead += 1; },
    (value) => { value.lastSuccess.verifiedAt = new Date(START - 1).toISOString(); },
  ]) {
    const candidate = structuredClone(saved); mutate(candidate);
    const f = fixture({ fsImpl: snapshotFs(candidate) });
    f.readers[0].provider.getBlockNumber = async () => { throw new Error("offline"); };
    const result = await createChainHeadObserver(f.options).observe();
    assert.equal(result.lastSuccess, null);
  }
});

test("close prevents future proof work without a separate owner stopped callback", async () => {
  const f = fixture(), observer = createChainHeadObserver(f.options);
  await observer.close(); const result = await observer.observe();
  assert.equal(result.errorCode, "CHAIN_HEAD_STOPPED"); assert.equal(f.calls.length, 0);
});

test("oversized or non-regular prior sidecars are closed without reading their contents", async () => {
  for (const details of [{ size: 64 * 1024 + 1, isFile: () => true }, { size: 100, isFile: () => false }]) {
    let reads = 0, closed = false;
    const f = fixture({ fsImpl: { async open() { return {
      async stat() { return details; }, async read() { reads += 1; throw new Error(); }, async close() { closed = true; },
    }; } } });
    f.readers[0].provider.getBlockNumber = async () => { throw new Error("offline"); };
    const result = await createChainHeadObserver(f.options).observe();
    assert.equal(result.lastSuccess, null); assert.equal(reads, 0); assert.equal(closed, true);
  }
});
