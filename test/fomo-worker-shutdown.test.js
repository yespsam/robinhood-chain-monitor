import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAlertOutboxWorker } from "../src/alerts.js";
import {
  createFomoWorkerShutdown,
  installFomoWorkerSignalHandlers,
} from "../src/fomo-worker.js";

test("SIGTERM and SIGINT share one Fomo stop that waits for the active outbox", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-worker-stop-"));
  const outboxFile = path.join(dataDir, "alert-outbox.json");
  await fs.writeFile(outboxFile, `${JSON.stringify({ version: 2, events: {} })}\n`);
  const originalReadFile = fs.readFile.bind(fs);
  let outboxReads = 0;
  let releaseOutbox;
  const outboxGate = new Promise((resolve) => { releaseOutbox = resolve; });
  t.mock.method(fs, "readFile", async (...args) => {
    if (String(args[0]) === outboxFile) {
      outboxReads += 1;
      await outboxGate;
    }
    return originalReadFile(...args);
  });

  const realOutbox = startAlertOutboxWorker({ dataDir, alertRetryIntervalMs: 60_000 });
  const order = [];
  let keepAliveClears = 0;
  let outboxStops = 0;
  const processRef = new EventEmitter();
  processRef.exitCode = 0;
  const monitor = (name) => ({ stop: async () => { order.push(name); } });
  const shutdown = createFomoWorkerShutdown({
    clearKeepAlive: () => { keepAliveClears += 1; order.push("keep-alive"); },
    onStopping: () => { order.push("work-gate"); },
    buyMonitor: monitor("buy"),
    thesisMonitor: monitor("thesis"),
    xCallMonitor: monitor("x-call"),
    outbox: {
      stop: () => {
        outboxStops += 1;
        order.push("outbox");
        return realOutbox.stop();
      },
    },
    runtimeHeartbeat: { stop: async () => { order.push("runtime-heartbeat"); } },
    processRef,
    logger: { error() {}, info() {} },
  });
  const removeSignalHandlers = installFomoWorkerSignalHandlers(shutdown.stop, processRef);
  t.after(async () => {
    removeSignalHandlers();
    releaseOutbox();
    await realOutbox.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const deadline = Date.now() + 1_000;
  while (outboxReads < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(outboxReads, 1, "the real outbox worker is blocked in its active startup run");

  processRef.emit("SIGTERM");
  processRef.emit("SIGINT");
  const sharedStop = shutdown.stop("test-observer");
  assert.equal(shutdown.stop("duplicate"), sharedStop);
  let settled = false;
  void sharedStop.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false, "shutdown cannot finish before the active outbox run drains");
  assert.equal(keepAliveClears, 1);
  assert.equal(outboxStops, 1);
  assert.deepEqual(order, ["work-gate", "keep-alive", "buy", "thesis", "x-call", "outbox"]);

  releaseOutbox();
  await sharedStop;
  assert.equal(settled, true);
  assert.deepEqual(order, ["work-gate", "keep-alive", "buy", "thesis", "x-call", "outbox", "runtime-heartbeat"]);
  assert.equal(processRef.exitCode, 0);
});

test("a failed lane still stops every resource and leaves a failing natural exit code", async () => {
  const order = [];
  const processRef = { exitCode: 0 };
  const shutdown = createFomoWorkerShutdown({
    clearKeepAlive: () => { order.push("keep-alive"); },
    onStopping: () => { order.push("work-gate"); },
    buyMonitor: { stop: async () => { order.push("buy"); throw new Error("buy stop failed"); } },
    thesisMonitor: { stop: async () => { order.push("thesis"); } },
    xCallMonitor: { stop: async () => { order.push("x-call"); } },
    outbox: { stop: async () => { order.push("outbox"); } },
    runtimeHeartbeat: { stop: async () => { order.push("runtime-heartbeat"); throw new Error("heartbeat stop failed"); } },
    processRef,
    logger: { error() {}, info() {} },
  });

  await shutdown.stop("SIGTERM");
  assert.deepEqual(order, ["work-gate", "keep-alive", "buy", "thesis", "x-call", "outbox", "runtime-heartbeat"]);
  assert.equal(processRef.exitCode, 1);
});

test('Binance read-only worker drains before the outbox and heartbeat', async () => {
  const order = [];
  const shutdown = createFomoWorkerShutdown({ binanceFlowMonitor: { stop: async () => { order.push('binance'); } },
    outbox: { stop: async () => { order.push('outbox'); } }, runtimeHeartbeat: { stop: async () => { order.push('heartbeat'); } }, logger: {} });
  await shutdown.stop(); assert.deepEqual(order, ['binance', 'outbox', 'heartbeat']);
});
