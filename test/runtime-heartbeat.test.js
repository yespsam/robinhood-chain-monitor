import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RUNTIME_HEARTBEAT_INTERVAL_MS,
  startRuntimeHeartbeat,
} from "../src/runtime-heartbeat.js";

test("runtime heartbeat immediately creates an owner-only atomic sidecar and stops cleanly", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-heartbeat-"));
  const file = path.join(dataDir, "nested", "main-runtime-heartbeat.json");
  let nowMs = Date.parse("2026-09-02T04:00:00.000Z");
  let intervalCallback = null;
  let intervalDelay = null;
  let unrefCalls = 0;
  let clearCalls = 0;
  const timer = { unref: () => { unrefCalls += 1; } };
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));

  const heartbeat = startRuntimeHeartbeat({
    file,
    producer: "main",
    now: () => nowMs,
    processRef: { pid: 42_001 },
    logger: { error() {} },
    setIntervalImpl: (callback, delay) => {
      intervalCallback = callback;
      intervalDelay = delay;
      return timer;
    },
    clearIntervalImpl: (value) => {
      assert.equal(value, timer);
      clearCalls += 1;
    },
  });

  await heartbeat.ready;
  const first = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(first, {
    version: 1,
    producer: "main",
    pid: 42_001,
    startedAt: "2026-09-02T04:00:00.000Z",
    updatedAt: "2026-09-02T04:00:00.000Z",
    sequence: 1,
  });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")), []);
  assert.equal(intervalDelay, RUNTIME_HEARTBEAT_INTERVAL_MS);
  assert.equal(unrefCalls, 1);

  nowMs += RUNTIME_HEARTBEAT_INTERVAL_MS;
  await heartbeat.pulse();
  const second = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(second.sequence, 2);
  assert.equal(second.updatedAt, "2026-09-02T04:00:30.000Z");

  const firstStop = heartbeat.stop();
  assert.equal(heartbeat.stop(), firstStop);
  await firstStop;
  assert.equal(clearCalls, 1);
  assert.equal(await heartbeat.pulse(), false);
  assert.equal(typeof intervalCallback, "function");
});

test("runtime heartbeat coalesces overlapping pulses and shutdown waits for the active write", async () => {
  let intervalCallback = null;
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const writes = [];
  const heartbeat = startRuntimeHeartbeat({
    file: "/fixture/fomo-runtime-heartbeat.json",
    producer: "fomo",
    intervalMs: 25,
    processRef: { pid: 42_002 },
    now: () => Date.parse("2026-09-02T04:01:00.000Z"),
    logger: { error() {} },
    atomicWriteImpl: async (_file, value) => {
      writes.push(value);
      await writeGate;
    },
    setIntervalImpl: (callback) => {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalImpl() {},
  });

  const overlapping = heartbeat.pulse();
  assert.equal(overlapping, heartbeat.ready);
  intervalCallback();
  const stopPromise = heartbeat.stop();
  let stopped = false;
  void stopPromise.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(writes.length, 1, "overlapping timer pulses cannot create concurrent writes");

  releaseWrite();
  await stopPromise;
  assert.equal(stopped, true);
  assert.equal(writes.length, 1, "a queued pulse is cancelled once shutdown starts");
});

test("a transient heartbeat write failure is reported and a later pulse can recover", async () => {
  const errors = [];
  const writes = [];
  const heartbeat = startRuntimeHeartbeat({
    file: "/fixture/main-runtime-heartbeat.json",
    producer: "main",
    processRef: { pid: 42_003 },
    now: () => Date.parse("2026-09-02T04:02:00.000Z"),
    logger: { error: (message) => errors.push(message) },
    atomicWriteImpl: async (_file, value) => {
      writes.push(value);
      if (writes.length === 1) throw new Error("fixture disk unavailable");
    },
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl() {},
  });

  await assert.rejects(heartbeat.ready, /fixture disk unavailable/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(errors[0], /runtime-heartbeat:main.*fixture disk unavailable/);
  await heartbeat.pulse();
  assert.deepEqual(writes.map((value) => value.sequence), [1, 2]);
  await heartbeat.stop();
});
