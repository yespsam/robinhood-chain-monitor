import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { drainAlertOutbox, sendAlerts } from "../src/alerts.js";
import { classifyFourRegistryDelivery } from "../src/four-registry-monitor.js";
import { isStrictFourRegistryCapabilityUpdate } from "../src/source-controls.js";
import {
  createFourRegistryFixture,
  produceFourRegistryPresetCapability,
} from "./helpers/four-registry-fixture.js";

async function expiredFixture(t, disabledReason = "freshness_too_old") {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "four-expired-receipt-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = { value: Date.parse("2026-09-04T08:00:00.000Z") };
  const config = {
    dataDir,
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    blockedContracts: new Set(),
    telegramToken: "four-expiry-test-token",
    telegramChatId: "four-expiry-test-chat",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    webhookUrl: "",
    alertNow: () => now.value,
  };
  const producer = await produceFourRegistryPresetCapability(t, "four_registry_preset_added", {
    now: () => now.value,
    // Model a producer that committed discovery before receiving a valid ack.
    onEvent: async () => ({ status: "suppressed", reason: "freshness_too_old" }),
  });
  const event = producer.events[0];
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false, status: 503, text: async () => "test destination unavailable",
  }));
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "info", () => {});
  const first = await sendAlerts(config, event);
  assert.equal(first.status, "queued");
  const file = path.join(dataDir, "alert-outbox.json");
  const outbox = JSON.parse(await fs.readFile(file, "utf8"));
  const entry = outbox.events[event.eventKey];
  now.value += 7 * 24 * 60 * 60_000;
  entry.status = "suppressed";
  entry.suppressedAt = new Date(now.value - 1_000).toISOString();
  entry.updatedAt = entry.suppressedAt;
  entry.destinations.telegram = {
    ...entry.destinations.telegram,
    status: "disabled",
    disabledReason,
    nextAttemptAt: null,
    leaseUntil: null,
    updatedAt: entry.suppressedAt,
  };
  await fs.writeFile(file, JSON.stringify(outbox));
  let posted = 0;
  t.mock.method(globalThis, "fetch", async () => {
    posted += 1;
    throw new Error("expired terminal evidence must never be posted again");
  });
  return { producer, config, event, now, file, entry, posted: () => posted };
}

for (const reason of ["freshness_too_old", "delivery_ttl_expired"]) {
  test(`persisted Registry ${reason} returns a bound policy receipt without reopening delivery`, async (t) => {
    const fixture = await expiredFixture(t, reason);
    const beforePayload = structuredClone(fixture.entry.event);
    const result = await sendAlerts(fixture.config, fixture.event);
    assert.equal(result.reason, "policy_suppressed");
    assert.equal(result.suppressionReason, reason);
    assert.equal(result.persisted, true);
    assert.equal(result.terminal, true);
    assert.equal(result.suppressedAt, fixture.entry.suppressedAt);
    assert.equal(classifyFourRegistryDelivery(result, fixture.event.eventKey), "policy_suppressed");
    const after = JSON.parse(await fs.readFile(fixture.file, "utf8")).events[fixture.event.eventKey];
    assert.equal(after.status, "suppressed");
    assert.equal(after.deliveredAt, null);
    assert.equal(after.destinations.telegram.disabledReason, reason);
    assert.deepEqual(after.event, beforePayload, "retain original payload and original freshness evidence");
    assert.equal(fixture.posted(), 0);
    assert.equal((await sendAlerts(fixture.config, fixture.event)).reason, "policy_suppressed");
    assert.equal(fixture.posted(), 0);
  });
}

test("a revalidated Registry producer records expired suppression and scans the next contiguous block", async (t) => {
  const fixture = await expiredFixture(t);
  const prior = await fixture.producer.monitor.getState();
  assert.equal(prior.outbox.length, 1);
  fixture.producer.provider.head += 1;
  const restarted = await createFourRegistryFixture(t, fixture.producer.provider, {
    dataDir: fixture.producer.dataDir,
    now: () => fixture.now.value,
    onEvent: (event) => sendAlerts(fixture.config, event),
  });
  const result = await restarted.monitor.check();
  assert.equal(result.status, "ok");
  const after = await restarted.monitor.getState();
  assert.equal(after.cursor.nextBlock, prior.cursor.nextBlock + 1);
  assert.equal(after.outbox.length, 0);
  const record = after.processedEvents[fixture.event.eventKey];
  assert.equal(record.deliveryStatus, "policy_suppressed");
  assert.equal(record.canonicalOwnerDelivered, false);
  assert.deepEqual(record.event, fixture.event);
  assert.equal(record.policySuppression.suppressedAt, fixture.entry.suppressedAt);
  assert.equal(fixture.posted(), 0);
});

test("non-expiry source suppression is not converted into a Registry policy acknowledgement", async (t) => {
  const fixture = await expiredFixture(t, "monitoring_source_disabled");
  const result = await sendAlerts(fixture.config, fixture.event);
  assert.equal(result.reason, "monitoring_source_disabled");
  assert.equal(classifyFourRegistryDelivery(result, fixture.event.eventKey), "retry");
  assert.equal(fixture.posted(), 0);
});

test("expired Registry acknowledgement still rejects a different persisted canonical payload", async (t) => {
  const fixture = await expiredFixture(t);
  const outbox = JSON.parse(await fs.readFile(fixture.file, "utf8"));
  outbox.events[fixture.event.eventKey].event.payloadDigest = `0x${"0".repeat(64)}`;
  await fs.writeFile(fixture.file, JSON.stringify(outbox));
  await assert.rejects(sendAlerts(fixture.config, fixture.event), /Four Registry event identity conflict/u);
  assert.equal(fixture.posted(), 0);
});

test("legacy sender priority cannot wedge an expired intact Registry proof or be reused to deliver it", async (t) => {
  const fixture = await expiredFixture(t);
  const outbox = JSON.parse(await fs.readFile(fixture.file, "utf8"));
  const entry = outbox.events[fixture.event.eventKey];
  entry.event.tradingPriority.category = "legacy_unverified_platform_update";
  assert.equal(isStrictFourRegistryCapabilityUpdate(entry.event), false);
  await fs.writeFile(fixture.file, JSON.stringify(outbox));
  const result = await sendAlerts(fixture.config, fixture.event);
  assert.equal(result.reason, "policy_suppressed");
  assert.equal(classifyFourRegistryDelivery(result, fixture.event.eventKey), "policy_suppressed");
  const after = JSON.parse(await fs.readFile(fixture.file, "utf8")).events[fixture.event.eventKey];
  assert.deepEqual(after.event, entry.event, "do not rewrite the historical derived envelope");
  assert.equal(fixture.posted(), 0);
});

test("unchanged digest strings cannot authenticate a corrupted persisted Registry source", async (t) => {
  const fixture = await expiredFixture(t);
  const outbox = JSON.parse(await fs.readFile(fixture.file, "utf8"));
  const entry = outbox.events[fixture.event.eventKey];
  entry.event.source.id = "unverified_source";
  await fs.writeFile(fixture.file, JSON.stringify(outbox));
  const result = await sendAlerts(fixture.config, fixture.event);
  assert.equal(result.reason, "freshness_too_old");
  assert.equal(classifyFourRegistryDelivery(result, fixture.event.eventKey), "retry");
  assert.equal(fixture.posted(), 0);
});

test("the production-style 203s enqueue gap acknowledges only the intact expired proof", async t => {
  const fixture = await expiredFixture(t);
  const outbox = JSON.parse(await fs.readFile(fixture.file, "utf8"));
  const entry = outbox.events[fixture.event.eventKey];
  entry.event.alertQueuedAt = new Date(Date.parse(entry.event.freshness.discoveredAt) + 203_410).toISOString();
  assert.equal(isStrictFourRegistryCapabilityUpdate(entry.event), false);
  await fs.writeFile(fixture.file, JSON.stringify(outbox));
  const result = await sendAlerts(fixture.config, fixture.event);
  assert.equal(classifyFourRegistryDelivery(result, fixture.event.eventKey), "policy_suppressed");
  const after = JSON.parse(await fs.readFile(fixture.file, "utf8")).events[fixture.event.eventKey];
  assert.deepEqual(after.event, entry.event);
  assert.equal(fixture.posted(), 0);
});

test("slow first enqueue derives a valid current envelope without refreshing original source evidence", async (t) => {
  const fixture = await expiredFixture(t);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "four-slow-admission-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const started = fixture.now.value;
  let clockCalls = 0;
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 503, text: async () => "test unavailable" }));
  const result = await sendAlerts({ ...fixture.config, dataDir,
    alertNow: () => clockCalls++ === 0 ? started : started + 203_410 }, fixture.event);
  assert.equal(result.status, "queued", "valid informational admission retains the original durable retry policy");
  const entry = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8")).events[fixture.event.eventKey];
  assert.equal(isStrictFourRegistryCapabilityUpdate(entry.event), true);
  assert.equal(entry.event.alertQueuedAt, new Date(started + 203_410).toISOString());
  assert.equal(entry.event.freshness.discoveredAt, entry.event.alertQueuedAt);
  assert.equal(entry.event.observedAt, fixture.event.observedAt);
  assert.equal(entry.event.blockTimestamp, fixture.event.blockTimestamp);
  assert.equal(entry.event.payloadDigest, fixture.event.payloadDigest);
  assert.equal(entry.event.freshness.decision, "suppress", "an old event must not become fresh");
  assert.equal(entry.event.autoTradeEligible, false);
});

test("expired Registry acknowledgement is withheld when sender persistence fails", async (t) => {
  const fixture = await expiredFixture(t);
  const failingFs = {
    ...fs,
    open: async (file, flags, mode) => {
      const handle = await fs.open(file, flags, mode);
      return {
        writeFile: (...args) => handle.writeFile(...args),
        chmod: (...args) => handle.chmod(...args),
        close: () => handle.close(),
        sync: async () => { throw new Error("injected expiry acknowledgement fsync failure"); },
      };
    },
  };
  await assert.rejects(sendAlerts({ ...fixture.config, alertOutboxFsImpl: failingFs }, fixture.event),
    /injected expiry acknowledgement fsync failure/u);
  assert.equal(fixture.posted(), 0);
});

async function handoffFixture(t) {
  const fixture = await expiredFixture(t);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "four-durable-handoff-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { ...fixture,
    config: { ...fixture.config, dataDir, alertFourRegistryDurableHandoff: true },
    file: path.join(dataDir, "alert-outbox.json"),
  };
}

test("Registry durable handoff returns queued only after persistence and the existing worker delivers once", async t => {
  const fixture = await handoffFixture(t);
  let posts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    posts++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 91 } }) };
  });
  const queued = await sendAlerts(fixture.config, fixture.event);
  assert.equal(queued.status, "queued");
  assert.equal(queued.persisted, true);
  assert.equal(classifyFourRegistryDelivery(queued, fixture.event.eventKey), "queued");
  assert.equal(posts, 0, "producer admission must not wait for notification fan-out");
  const durable = JSON.parse(await fs.readFile(fixture.file, "utf8")).events[fixture.event.eventKey];
  assert.equal(durable.status, "pending");
  assert.equal(durable.deliveredAt, null);
  assert.equal(durable.destinations.telegram.attempts, 0);
  assert.equal(durable.event.observedAt, fixture.event.observedAt);
  assert.equal(durable.event.autoTradeEligible, false);
  assert.equal((await sendAlerts(fixture.config, fixture.event)).status, "queued");
  assert.equal(posts, 0);
  await drainAlertOutbox(fixture.config);
  assert.equal(posts, 1);
  assert.equal((await sendAlerts(fixture.config, fixture.event)).status, "delivered");
  await drainAlertOutbox(fixture.config);
  assert.equal(posts, 1, "a restart/retry receipt cannot cause another POST");
});

test("Registry producer advances contiguously after durable handoff while notification is still pending", async t => {
  const fixture = await handoffFixture(t);
  const before = await fixture.producer.monitor.getState();
  fixture.producer.provider.head++;
  const restarted = await createFourRegistryFixture(t, fixture.producer.provider, {
    dataDir: fixture.producer.dataDir,
    now: () => fixture.now.value,
    onEvent: event => sendAlerts(fixture.config, event),
  });
  assert.equal((await restarted.monitor.check()).status, "ok");
  const after = await restarted.monitor.getState();
  assert.equal(after.cursor.nextBlock, before.cursor.nextBlock + 1);
  assert.equal(after.outbox.length, 0);
  assert.equal(after.processedEvents[fixture.event.eventKey].deliveryStatus, "queued");
  assert.equal(JSON.parse(await fs.readFile(fixture.file, "utf8")).events[fixture.event.eventKey].status, "pending");
  assert.equal(fixture.posted(), 0);
});

test("Registry durable handoff withholds queued receipt on fsync failure", async t => {
  const fixture = await handoffFixture(t);
  const failingFs = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return {
      writeFile: (...values) => handle.writeFile(...values),
      chmod: (...values) => handle.chmod(...values),
      close: () => handle.close(),
      sync: async () => { throw new Error("injected handoff fsync failure"); },
    };
  } };
  await assert.rejects(sendAlerts({ ...fixture.config, alertOutboxFsImpl: failingFs }, fixture.event),
    /injected handoff fsync failure/u);
  assert.equal(fixture.posted(), 0);
  await assert.rejects(fs.stat(fixture.file), { code: "ENOENT" });
});

test("Registry handoff cannot turn an invalid source into a persisted queue acknowledgement", async t => {
  const fixture = await handoffFixture(t);
  const event = structuredClone(fixture.event);
  event.source.id = "unverified_source";
  const result = await sendAlerts(fixture.config, event);
  assert.equal(classifyFourRegistryDelivery(result, fixture.event.eventKey), "retry");
  assert.notEqual(result.persisted, true);
  assert.equal(fixture.posted(), 0);
});

test("Registry handoff preserves an existing terminal expiry receipt without reopening it", async t => {
  const fixture = await expiredFixture(t);
  const result = await sendAlerts({ ...fixture.config, alertFourRegistryDurableHandoff: true }, fixture.event);
  assert.equal(result.reason, "policy_suppressed");
  assert.equal(result.suppressedAt, fixture.entry.suppressedAt);
  assert.equal(fixture.posted(), 0);
});
