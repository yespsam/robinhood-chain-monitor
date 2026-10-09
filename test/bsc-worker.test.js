import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createBscWorkerMailbox } from "../src/bsc-worker-mailbox.js";
import { createBscWorkerClient } from "../src/bsc-worker-client.js";

test("worker inbox persists, deduplicates, acknowledges only completed commands and retries fairly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bsc-mailbox-test-"));
  let box;
  try {
    box = createBscWorkerMailbox(dir);
    const id = box.enqueue("registerDiscoveryCandidates", [[{ address: "fixture" }]]);
    assert.equal(box.enqueue("registerDiscoveryCandidates", [[{ address: "fixture" }]]), id);
    box.acknowledge(id); assert.ok(box.get(id));
    box.close(); box = createBscWorkerMailbox(dir);
    assert.equal(box.next().id, id);
    box.retry(id, new Error("upstream busy"));
    const next = box.enqueue("registerFlapFeatureActivations", [[{ id: "feature" }]]);
    assert.equal(box.next().id, next);
    box.complete(next, { accepted: true }); box.acknowledge(next);
    assert.equal(box.get(next), undefined);
    assert.equal(box.get(id).status, "pending");
    assert.throws(() => box.enqueue("destroyHistory", []), /unsupported/);
  } finally { box?.close(); await rm(dir, { recursive: true, force: true }); }
});
test("only one live scanner owns the original state, dead owner may be reclaimed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bsc-owner-test-"));
  const a = createBscWorkerMailbox(dir, { pid: 100, alive: () => true });
  const b = createBscWorkerMailbox(dir, { pid: 200, alive: () => true });
  const c = createBscWorkerMailbox(dir, { pid: 300, alive: () => false });
  try {
    assert.equal(a.claimOwner(), true);
    assert.equal(b.claimOwner(), false);
    b.releaseOwner(); assert.equal(b.claimOwner(), false);
    assert.equal(c.claimOwner(), true);
  } finally { a.close(); b.close(); c.close(); await rm(dir, { recursive: true, force: true }); }
});
test("supervised worker crosses a real process boundary and keeps alerts in original sender", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bsc-worker-client-test-"));
  let client;
  let deliveries = 0;
  try {
    client = createBscWorkerClient({ dataDir: dir, bscSharedRpcEnabled: true }, {
      workerFile: fileURLToPath(new URL("./fixtures/bsc-scan-worker.mjs", import.meta.url)),
      logger: { info() {}, error() {} }, restartDelayMs: 10,
      sendAlertsImpl: async (_config, event) => { deliveries++; assert.equal(event.type, "fixture-alert"); return { delivered: true }; },
    });
    assert.notEqual(client.getStatus().pid, process.pid);
    const first = await client.registerDiscoveryCandidates([{ address: "fixture" }]);
    assert.equal(first.accepted, true);
    const alerted = await client.registerDiscoveryCandidates([{ alert: true }]);
    assert.equal(alerted.result.delivered, true);
    assert.equal(deliveries, 1);
    const oldPid = client.getStatus().pid;
    process.kill(oldPid, "SIGTERM");
    const result = await client.registerFourMemeFeatureActivations([{ id: "after-restart" }]);
    assert.equal(result.accepted, true);
    assert.notEqual(client.getStatus().pid, oldPid);
    assert.equal(client.getStatus().inbox.length, 0);
  } finally { await client?.stop(); await rm(dir, { recursive: true, force: true }); }
});
test("acknowledgement timeout leaves command durable, stopping does not fabricate success", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bsc-worker-timeout-test-"));
  let client;
  try {
    client = createBscWorkerClient({ dataDir: dir, bscSharedRpcEnabled: true }, {
      workerFile: fileURLToPath(new URL("./fixtures/bsc-scan-worker.mjs", import.meta.url)),
      logger: { info() {}, error() {} }, commandTimeoutMs: 40,
    });
    await assert.rejects(client.registerDiscoveryCandidates([{ wait: true }]), /remains durable/);
    assert.equal(client.getStatus().inbox[0].count, 1);
    const second = assert.rejects(client.registerDiscoveryCandidates([{ wait: true }]), /remains durable/);
    await delay(10); await client.stop(); await second;
    const box = createBscWorkerMailbox(dir);
    assert.equal(box.summary()[0].count, 1); box.close();
  } finally { await client?.stop(); await rm(dir, { recursive: true, force: true }); }
});
