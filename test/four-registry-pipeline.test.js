import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FOUR_REGISTRY_CAPABILITY_KINDS,
  FOUR_REGISTRY_PRESET_BLOCK_END_METADATA_FIELD,
  FOUR_REGISTRY_PRESET_SNAPSHOT_SCOPES,
  isFourRegistryCapabilityEvent,
  isFourRegistryFirstTokenEvent,
} from "../src/four-registry-monitor.js";
import {
  alertDeliveryDisposition,
  cancelPendingFourRegistryEvent,
  drainAlertOutbox,
  focusNoveltyKeys,
  isRelevantAlert,
  sendAlerts,
} from "../src/alerts.js";
import {
  isStrictBscOpenFourFirstTokenUpdate,
  isStrictFourRegistryCapabilityUpdate,
  isStrictFourRegistryFirstTokenUpdate,
} from "../src/source-controls.js";
import {
  createFourRegistryFixture,
  addFourRegistryActiveUpdate,
  addFourRegistryPresetUpsert,
  addFourRegistryTokenCreated,
  FourRegistryFakeProvider,
  fourRegistryPreset,
  fourRegistryTxHash,
  produceFourRegistryPresetAndFirstToken,
  produceFourRegistryPresetCapability,
  produceFourRegistryProtocolEvents,
  produceFourRegistrySameBlockMetadataEvents,
} from "./helpers/four-registry-fixture.js";
import { produceLegacyBscOpenFourSafetyEvent } from "./helpers/openfour-first-token-fixture.js";

const PRESET_KINDS = [
  "four_registry_preset_added",
  "four_registry_preset_activated",
  "four_registry_preset_deactivated",
  "four_registry_preset_create_enabled",
  "four_registry_preset_create_disabled",
  "four_registry_preset_updated",
];

function telegramConfig(dataDir, now, overrides = {}) {
  return {
    dataDir,
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    blockedContracts: new Set(),
    telegramToken: "registry-pipeline-test-token",
    telegramChatId: "registry-pipeline-test-chat",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
    alertNow: () => now.value,
    ...overrides,
  };
}

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readAlertOutbox(dataDir) {
  return JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
}

function telegramSuccess(messageId) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, result: { message_id: messageId } }),
  };
}

async function produceCrossProducerFirstTokenEvents(t) {
  const registry = await produceFourRegistryPresetAndFirstToken(t);
  const registryEvent = registry.events.find((event) => event.kind === "four_registry_first_token");
  const legacy = await produceLegacyBscOpenFourSafetyEvent(t, {
    transactionHash: registryEvent.transactionHash,
    blockHash: registryEvent.blockHash,
    blockNumber: registryEvent.blockNumber,
    transactionIndex: registryEvent.transactionIndex,
    logIndex: registryEvent.logIndex,
    token: registryEvent.token.address,
    presetId: registryEvent.presetId,
    quoteAsset: registryEvent.token.quoteAsset,
    observedAt: registryEvent.observedAt,
  });
  assert.equal(isStrictFourRegistryFirstTokenUpdate(registryEvent), true);
  assert.equal(isStrictBscOpenFourFirstTokenUpdate(legacy.event), true);
  assert.equal(focusNoveltyKeys(registryEvent).length, 1);
  assert.deepEqual(
    focusNoveltyKeys(legacy.event).slice(0, 1),
    focusNoveltyKeys(registryEvent),
    "both producers bind the same immutable Core tx/log/token base",
  );
  return { weak: registryEvent, strong: legacy.event };
}

async function backdateDeliveredEntries(dataDir, iso) {
  const file = path.join(dataDir, "alert-outbox.json");
  const outbox = JSON.parse(await fs.readFile(file, "utf8"));
  for (const entry of Object.values(outbox.events)) {
    if (!["delivered", "suppressed"].includes(entry.status)) continue;
    entry.createdAt = iso;
    entry.updatedAt = iso;
    if (entry.status === "delivered") entry.deliveredAt = iso;
    if (entry.status === "suppressed") entry.suppressedAt = iso;
    for (const destination of Object.values(entry.destinations || {})) {
      if (destination.status === "delivered") destination.deliveredAt = iso;
    }
  }
  for (const owner of Object.values(outbox.fourRegistryDeliveryOwners || {})) {
    if (owner.deliveredAt) owner.deliveredAt = iso;
    if (owner.ownerDeliveredAt) owner.ownerDeliveredAt = iso;
  }
  for (const owner of Object.values(outbox.immutableOpenFourSignalOwners || {})) owner.deliveredAt = iso;
  await fs.writeFile(file, `${JSON.stringify(outbox)}\n`, "utf8");
}

function registryCancellation(event) {
  return {
    eventId: event.eventKey,
    baseEventKey: event.canonicalRevision?.baseEventKey || event.eventKey,
    blockHash: event.blockHash,
    payloadDigest: event.payloadDigest,
    deliveryEvidenceDigest: event.deliveryEvidenceDigest,
    reason: "canonical_reorg",
  };
}

test("all nine Registry capability kinds and Core first-token traverse producer, strict gates, priority, outbox, and Telegram", async (t) => {
  const alertDataDir = await temporaryDirectory(t, "four-registry-shared-pipeline-");
  const now = { value: Date.parse("2026-09-04T08:00:00.000Z") };
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return telegramSuccess(payloads.length);
  });
  t.mock.method(console, "info", () => {});
  const config = telegramConfig(alertDataDir, now, {
    // A Registry governance card must not wedge merely because the changed
    // implementation is already on the local trading blocklist.
    blockedContracts: new Set(["0x6666666666666666666666666666666666666666"]),
  });
  const deliveryResults = [];
  const onEvent = async (event) => {
    const result = await sendAlerts(config, event);
    deliveryResults.push({ event, result });
    return result;
  };

  const presetEvents = [];
  for (const kind of PRESET_KINDS) {
    const fixture = await produceFourRegistryPresetCapability(t, kind, { onEvent });
    assert.equal(fixture.result.status, "ok", kind);
    assert.equal(fixture.events.length, 1, kind);
    presetEvents.push(fixture.events[0]);
  }
  const protocol = await produceFourRegistryProtocolEvents(t, { onEvent });
  assert.equal(protocol.result.status, "ok");
  const firstTokenFixture = await produceFourRegistryPresetAndFirstToken(t, {
    onEvent,
    capabilityOptions: { hash: fourRegistryTxHash("0") },
  });
  assert.equal(firstTokenFixture.result.status, "ok");
  const firstToken = firstTokenFixture.events.find((event) => event.kind === "four_registry_first_token");

  const capabilities = [...presetEvents, ...protocol.events];
  assert.deepEqual(capabilities.map((event) => event.kind).sort(), [...FOUR_REGISTRY_CAPABILITY_KINDS].sort());
  assert.ok(capabilities.every(isFourRegistryCapabilityEvent));
  assert.equal(isFourRegistryFirstTokenEvent(firstToken), true);
  assert.equal(payloads.length, 11, "ten capability observations plus one first-token card are delivered");
  assert.ok(payloads.every((payload) => !/gmgn|swap|买入|buy now/iu.test(JSON.stringify(payload.reply_markup || {}))));

  const outbox = await readAlertOutbox(alertDataDir);
  for (const raw of capabilities) {
    const entry = outbox.events[raw.eventKey];
    assert.ok(entry, raw.kind);
    assert.equal(entry.status, "delivered", raw.kind);
    assert.equal(isStrictFourRegistryCapabilityUpdate(entry.event), true, raw.kind);
    assert.deepEqual(entry.event.canonicalSignalIds, [raw.lifecycleKey], raw.kind);
    assert.equal(entry.event.tradingPriority.tier, "T1", raw.kind);
    assert.equal(entry.event.tradingPriority.category, "focus_registry_capability", raw.kind);
    assert.equal(entry.event.tradingPriority.confirmation.kind, "official_openfour_registry_log", raw.kind);
    assert.deepEqual(entry.deliveryDisposition, {
      mode: "immediate",
      deliverImmediately: true,
      tier: "T1",
      reason: "four_registry_capability",
    }, raw.kind);
  }
  const tokenEntry = outbox.events[firstToken.eventKey];
  assert.equal(isStrictFourRegistryFirstTokenUpdate(tokenEntry.event), true);
  assert.deepEqual(tokenEntry.event.canonicalSignalIds, focusNoveltyKeys(firstToken));
  assert.equal(tokenEntry.event.tradingPriority.tier, "T2");
  assert.equal(tokenEntry.event.tradingPriority.category, "focus_registry_first_token");
  assert.equal(tokenEntry.event.tradingPriority.confirmation.kind, "official_openfour_core_token_created");
  assert.equal(tokenEntry.event.tradingPriority.plan.automaticExecution, false);
  assert.deepEqual(alertDeliveryDisposition(tokenEntry.event), tokenEntry.deliveryDisposition);

  const beforeMalformed = payloads.length;
  const malformed = await sendAlerts(config, { ...structuredClone(protocol.events[0]), attackerUrl: "https://attacker.invalid/buy" });
  assert.equal(malformed.status, "suppressed");
  assert.equal(malformed.reason, "monitoring_source_disabled");
  assert.equal(payloads.length, beforeMalformed);

  const wrongProof = structuredClone(tokenEntry.event);
  wrongProof.tradingPriority.confirmation.kind = "official_openfour_registry_log";
  assert.equal(isStrictFourRegistryFirstTokenUpdate(wrongProof), false);
  assert.equal(isRelevantAlert(wrongProof), false);
  const wrongCapabilityProof = structuredClone(outbox.events[protocol.events[0].eventKey].event);
  wrongCapabilityProof.tradingPriority.confirmation.kind = "official_openfour_core_token_created";
  assert.equal(isStrictFourRegistryCapabilityUpdate(wrongCapabilityProof), false);
  assert.equal(isRelevantAlert(wrongCapabilityProof), false);
  assert.ok(deliveryResults.every(({ result }) => result.persisted === true));
});

test("same-block Registry metadata stays explicitly unattributed from producer through bilingual Telegram", async (t) => {
  const alertDataDir = await temporaryDirectory(t, "four-registry-same-block-attribution-");
  const now = { value: Date.parse("2026-09-04T08:00:00.000Z") };
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return telegramSuccess(payloads.length);
  });
  t.mock.method(console, "info", () => {});
  const config = telegramConfig(alertDataDir, now);
  const produced = await produceFourRegistrySameBlockMetadataEvents(t, {
    now: () => now.value,
    onEvent: (event) => sendAlerts(config, event),
  });

  assert.equal(produced.result.status, "ok");
  assert.deepEqual(produced.events.map((event) => event.kind), [
    "four_registry_preset_activated",
    "four_registry_first_token",
    "four_registry_preset_updated",
  ]);
  const [deferred, firstToken, settled] = produced.events;
  assert.equal(deferred.snapshotScope, FOUR_REGISTRY_PRESET_SNAPSHOT_SCOPES[1]);
  assert.deepEqual(deferred.changedFields, ["active"]);
  assert.equal(firstToken.presetSnapshotScope, FOUR_REGISTRY_PRESET_SNAPSHOT_SCOPES[1]);
  assert.equal(settled.snapshotScope, FOUR_REGISTRY_PRESET_SNAPSHOT_SCOPES[2]);
  assert.deepEqual(settled.changedFields, [FOUR_REGISTRY_PRESET_BLOCK_END_METADATA_FIELD]);
  assert.equal(deferred.currentPreset.name, "Lista Yield V1");
  assert.equal(firstToken.preset.name, "Lista Yield V1");
  assert.equal(settled.currentPreset.name, "Lista Yield V3");
  assert.ok(produced.events.every((event) => /^0x[a-f0-9]{64}$/u.test(event.deliveryEvidenceDigest)));
  assert.equal(payloads.length, 3);
  for (const [payload, required] of [
    [payloads[0], [
      "模式：OpenFour Preset 1778027615803",
      "配置名称（区块前态）：Lista Yield V1｜同块多次更新；本交易仅确认状态",
      "Mode: OpenFour Preset 1778027615803",
      "Config name (prior same-block state): Lista Yield V1 | multiple same-block updates; this transaction proves status only",
    ]],
    [payloads[1], [
      "Four.Meme｜OpenFour Preset 1778027615803｜首个 CA",
      "配置名称（区块前态）：Lista Yield V1｜同块静态字段沿用前态；非 TokenCreated 时点精确值",
      "Four.Meme｜OpenFour Preset 1778027615803｜first CA",
      "Config name (prior same-block state): Lista Yield V1 | static fields retain the prior state; not exact at TokenCreated time",
    ]],
    [payloads[2], [
      "模式：OpenFour Preset 1778027615803",
      "配置名称（区块末态）：Lista Yield V3｜同块最终状态；具体交易归因未确认",
      "Mode: OpenFour Preset 1778027615803",
      "Config name (block-end snapshot): Lista Yield V3 | same-block final state; not attributable to this transaction",
    ]],
  ]) {
    for (const literal of required) assert.ok(payload.text.includes(literal), literal);
    assert.ok(!/gmgn|swap|buy now/iu.test(JSON.stringify(payload.reply_markup || {})));
  }
  assert.ok(!payloads[0].text.includes("Lista Yield V3"), "the first log must not inherit block-end metadata");
  assert.ok(!payloads[1].text.includes("Lista Yield V3"), "TokenCreated must not inherit later block-end metadata");
  assert.ok(!payloads[0].text.includes("模式：Lista Yield V1"), "prior-state metadata must not become the capability headline");
  assert.ok(!payloads[0].text.includes("Mode: Lista Yield V1"), "prior-state metadata must not become the capability headline");
  assert.ok(!payloads[1].text.includes("Four.Meme｜Lista Yield V1 首个代币"), "prior-state metadata must not become the token headline");
  assert.ok(!payloads[1].text.includes("Four.Meme｜Lista Yield V1 first token"), "prior-state metadata must not become the token headline");
  assert.ok(!payloads[2].text.includes("模式：Lista Yield V3"), "block-end metadata must not become the capability headline");
  assert.ok(!payloads[2].text.includes("Mode: Lista Yield V3"), "block-end metadata must not become the capability headline");

  const outbox = await readAlertOutbox(alertDataDir);
  assert.equal(isStrictFourRegistryCapabilityUpdate(outbox.events[deferred.eventKey].event), true);
  assert.equal(isStrictFourRegistryFirstTokenUpdate(outbox.events[firstToken.eventKey].event), true);
  assert.equal(isStrictFourRegistryCapabilityUpdate(outbox.events[settled.eventKey].event), true);
  assert.equal(outbox.events[deferred.eventKey].event.tradingPriority.tier, "T1");
  assert.equal(outbox.events[firstToken.eventKey].event.tradingPriority.tier, "T2");
  assert.equal(outbox.events[settled.eventKey].event.tradingPriority.tier, "T1");

  const forgedDeliveryProof = structuredClone(deferred);
  forgedDeliveryProof.deliveryEvidenceDigest = `0x${"f".repeat(64)}`;
  assert.equal(isFourRegistryCapabilityEvent(forgedDeliveryProof), false);
  assert.equal((await sendAlerts(config, forgedDeliveryProof)).reason, "monitoring_source_disabled");
  assert.equal(payloads.length, 3);
});

test("Registry late discovery and durable Telegram retry stay T2 immediate beyond the normal TTL", async (t) => {
  const alertDataDir = await temporaryDirectory(t, "four-registry-delayed-delivery-");
  const now = { value: Date.parse("2026-09-04T08:10:00.000Z") };
  const attempts = [];
  let telegramAvailable = false;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const payload = JSON.parse(options.body);
    attempts.push({ payload, ok: telegramAvailable });
    return telegramAvailable
      ? telegramSuccess(attempts.length)
      : { ok: false, status: 503, text: async () => "temporary outage" };
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const config = telegramConfig(alertDataDir, now);
  const results = [];
  const produced = await produceFourRegistryPresetAndFirstToken(t, {
    now: () => now.value,
    onEvent: async (event) => {
      const result = await sendAlerts(config, event);
      results.push(result);
      return result;
    },
  });
  assert.equal(produced.result.status, "ok");
  assert.deepEqual(results.map((result) => result.status), ["queued", "queued"]);
  assert.ok(produced.events.every((event) => event.delayedRecovery === undefined));
  let outbox = await readAlertOutbox(alertDataDir);
  for (const entry of Object.values(outbox.events)) {
    assert.equal(entry.status, "pending");
    assert.equal(entry.event.freshness.decision, "late");
    assert.equal(entry.event.tradingPriority.tier, "T2");
    assert.equal(entry.event.tradingPriority.hardGates.t1Eligible, false);
    assert.equal(entry.deliveryDisposition.reason, "four_registry_delayed_delivery");
    assert.match(entry.renderBundle.zh.text, /延迟发现/u);
  }

  now.value += 3 * 60 * 60_000;
  telegramAvailable = true;
  assert.equal(await drainAlertOutbox(config), 2);
  assert.equal(await drainAlertOutbox(config), 0);
  outbox = await readAlertOutbox(alertDataDir);
  assert.ok(Object.values(outbox.events).every((entry) => entry.status === "delivered"));
  assert.ok(Object.values(outbox.events).every((entry) => entry.deliveryDisposition.reason === "four_registry_delayed_delivery"));
  const successful = attempts.filter((attempt) => attempt.ok);
  assert.equal(successful.length, 2);
  assert.ok(successful.every(({ payload }) => /延迟送达/u.test(payload.text)));
  assert.ok(successful.every(({ payload }) => !/风险|Risk:|勿追价|do not chase|非自动交易|no automatic trading|非买入建议|not a buy recommendation|\bT[0-2]\b/iu.test(payload.text)));
  assert.ok(successful.every(({ payload }) => !/gmgn|swap|买入按钮|buy now/iu.test(JSON.stringify(payload.reply_markup || {}))));

  const boundaryDataDir = await temporaryDirectory(t, "four-registry-late-boundary-");
  const boundaryNow = { value: Date.parse("2026-09-04T08:13:20.000Z") };
  const boundaryPayloads = [];
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    boundaryPayloads.push(JSON.parse(options.body));
    return telegramSuccess(boundaryPayloads.length);
  });
  t.mock.method(console, "info", () => {});
  const boundaryConfig = telegramConfig(boundaryDataDir, boundaryNow);
  const boundaryResults = [];
  const boundary = await produceFourRegistryPresetAndFirstToken(t, {
    now: () => boundaryNow.value,
    onEvent: async (event) => {
      const result = await sendAlerts(boundaryConfig, event);
      boundaryResults.push(result);
      return result;
    },
  });
  assert.equal(boundary.result.status, "ok");
  assert.deepEqual(boundaryResults.map((result) => result.status), ["delivered", "delivered"]);
  assert.ok(boundary.events.every((event) => event.delayedRecovery === undefined));
  const boundaryOutbox = await readAlertOutbox(boundaryDataDir);
  assert.ok(Object.values(boundaryOutbox.events).every((entry) => entry.event.freshness.decision === "late"));
  assert.ok(Object.values(boundaryOutbox.events).every((entry) => entry.deliveryDisposition.reason === "four_registry_delayed_delivery"));
  assert.equal(boundaryPayloads.length, 2);
});

test("a producer-committed fresh Registry event survives a crash before alert enqueue and sends after two hours", async (t) => {
  const rootDir = await temporaryDirectory(t, "four-registry-pre-enqueue-crash-");
  const producerDataDir = path.join(rootDir, "producer");
  const alertDataDir = path.join(rootDir, "alerts");
  const producerNow = Date.parse("2026-09-04T08:00:00.000Z");
  const first = await produceFourRegistryPresetAndFirstToken(t, {
    dataDir: producerDataDir,
    now: () => producerNow,
    onEvent: async () => ({
      status: "suppressed",
      reason: "policy_suppressed",
      disposition: "terminal",
      terminal: true,
    }),
  });
  const committed = JSON.parse(await fs.readFile(path.join(producerDataDir, "four-registry-state.json"), "utf8"));
  assert.equal(committed.outbox.length, 2);
  assert.ok(committed.outbox.every((entry) => entry.event.deliveryPolicy.firstObservedAt === entry.event.observedAt));
  assert.ok(committed.outbox.every((entry) => entry.event.delayedRecovery === undefined));

  const now = { value: producerNow + 3 * 60 * 60_000 };
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return telegramSuccess(payloads.length);
  });
  t.mock.method(console, "info", () => {});
  const config = telegramConfig(alertDataDir, now);
  const restarted = await createFourRegistryFixture(t, first.provider, {
    dataDir: producerDataDir,
    now: () => now.value,
    onEvent: (event) => sendAlerts(config, event),
  });
  const recovered = await restarted.monitor.check();
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.delivery.accepted, 2);
  assert.equal((await restarted.monitor.getState()).outbox.length, 0);
  assert.equal(payloads.length, 2);
  assert.ok(payloads.every((payload) => /延迟送达/u.test(payload.text)));
  assert.ok(payloads.every((payload) => !/风险|Risk:|勿追价|do not chase|非自动交易|no automatic trading|非买入建议|not a buy recommendation|\bT[0-2]\b/iu.test(payload.text)));
  const alertOutbox = await readAlertOutbox(alertDataDir);
  for (const entry of Object.values(alertOutbox.events)) {
    assert.equal(entry.status, "delivered");
    assert.equal(entry.event.freshness.decision, "suppress");
    assert.equal(entry.event.tradingPriority.tier, "T2");
    assert.equal(entry.deliveryDisposition.reason, "four_registry_delayed_delivery");
  }
});

test("OpenFour first-token cross-producer ownership preserves one provenance card and one later safety pass", async (t) => {
  const { weak, strong } = await produceCrossProducerFirstTokenEvents(t);
  const now = { value: Date.parse(weak.observedAt) };
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return telegramSuccess(payloads.length);
  });
  t.mock.method(console, "info", () => {});

  const weakFirstDir = await temporaryDirectory(t, "openfour-cross-weak-first-");
  const weakFirst = telegramConfig(weakFirstDir, now);
  assert.equal((await sendAlerts(weakFirst, weak)).status, "delivered");
  assert.equal((await sendAlerts(weakFirst, strong)).status, "delivered");
  assert.equal(payloads.length, 2);
  assert.match(payloads[1].text, /已取得本地流动性数据/u);
  assert.doesNotMatch(payloads[1].text, /风险|Risk:|勿追价|do not chase|非自动交易|no automatic trading|非买入建议|not a buy recommendation|仍非买入信号|安全升级|\bT[0-2]\b/iu);
  assert.ok(payloads.every((payload) => !/gmgn|swap|买入|buy now/iu.test(JSON.stringify(payload.reply_markup || {}))));

  const strongFirstDir = await temporaryDirectory(t, "openfour-cross-strong-first-");
  const strongFirst = telegramConfig(strongFirstDir, now);
  assert.equal((await sendAlerts(strongFirst, strong)).status, "delivered");
  const folded = await sendAlerts(strongFirst, weak);
  assert.equal(folded.status, "suppressed");
  assert.equal(folded.reason, "semantic_duplicate");
  assert.equal(folded.canonicalOwnerDelivered, true);
  assert.equal(folded.duplicateOf, strong.eventKey);
  assert.equal(payloads.length, 3, "a later weaker Registry observation does not emit another card");

  const restarted = telegramConfig(strongFirstDir, now);
  const repeated = await sendAlerts(restarted, strong);
  assert.equal(repeated.status, "delivered");
  assert.equal(payloads.length, 3, "same-strength replay across restart is exact-once");
});

test("immutable OpenFour Core ownership survives 31-day alert retention in both producer orders", async (t) => {
  const { weak, strong } = await produceCrossProducerFirstTokenEvents(t);
  const now = { value: Date.parse(weak.observedAt) };
  let posts = 0;
  t.mock.method(globalThis, "fetch", async () => telegramSuccess(++posts));
  t.mock.method(console, "info", () => {});
  const old = new Date(now.value - 31 * 24 * 60 * 60_000).toISOString();

  const strongFirstDir = await temporaryDirectory(t, "openfour-cross-31d-strong-");
  const strongFirst = telegramConfig(strongFirstDir, now);
  assert.equal((await sendAlerts(strongFirst, strong)).status, "delivered");
  await backdateDeliveredEntries(strongFirstDir, old);
  const weakFolded = await sendAlerts(strongFirst, weak);
  assert.equal(weakFolded.reason, "semantic_duplicate");
  assert.equal(weakFolded.canonicalOwnerDelivered, true);
  assert.equal(weakFolded.duplicateOf, strong.eventKey);
  let outbox = await readAlertOutbox(strongFirstDir);
  assert.equal(Object.values(outbox.events).filter((entry) => entry.status === "delivered").length, 0);
  assert.equal(Object.keys(outbox.immutableOpenFourSignalOwners).length, 2);

  const weakFirstDir = await temporaryDirectory(t, "openfour-cross-31d-weak-");
  const weakFirst = telegramConfig(weakFirstDir, now);
  assert.equal((await sendAlerts(weakFirst, weak)).status, "delivered");
  await backdateDeliveredEntries(weakFirstDir, old);
  assert.equal((await sendAlerts(weakFirst, strong)).status, "delivered");
  outbox = await readAlertOutbox(weakFirstDir);
  assert.equal(Object.keys(outbox.immutableOpenFourSignalOwners).length, 2);
  assert.equal(posts, 3, "strong→weak emits one card; weak→strong emits provenance plus safety");
});

test("a failed weak OpenFour delivery is folded if the safety-pass owner delivers first", async (t) => {
  const { weak, strong } = await produceCrossProducerFirstTokenEvents(t);
  const dataDir = await temporaryDirectory(t, "openfour-cross-failed-weak-");
  const now = { value: Date.parse(weak.observedAt) };
  const attempts = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    attempts.push(JSON.parse(options.body));
    if (attempts.length === 1) return { ok: false, status: 503, text: async () => "temporary outage" };
    return telegramSuccess(attempts.length);
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const config = telegramConfig(dataDir, now);

  assert.equal((await sendAlerts(config, weak)).status, "queued");
  assert.equal((await sendAlerts(config, strong)).status, "delivered");
  const orphaned = await cancelPendingFourRegistryEvent(config, registryCancellation(weak));
  assert.equal(orphaned.status, "delivered_orphaned", "the delivered safety owner is recognized before a worker retry");
  now.value += 5_001;
  await drainAlertOutbox(config);
  assert.equal(attempts.length, 2, "the stale weak pending entry is suppressed before another POST");
  const outbox = await readAlertOutbox(dataDir);
  const weakEntry = outbox.events[weak.eventKey];
  assert.equal(weakEntry.status, "suppressed");
  assert.equal(weakEntry.destinations.telegram.disabledReason, "four_registry_canonical_reorg");
  assert.equal(weakEntry.semanticDuplicateOf, strong.eventKey);
  assert.equal(weakEntry.semanticDuplicateOwnerDelivered, true);
});

test("a Registry semantic-duplicate receipt survives 31-day pruning and authenticates reorg cancellation", async (t) => {
  const { weak, strong } = await produceCrossProducerFirstTokenEvents(t);
  const dataDir = await temporaryDirectory(t, "openfour-registry-semantic-owner-31d-");
  const now = { value: Date.parse(weak.observedAt) };
  let posts = 0;
  t.mock.method(globalThis, "fetch", async () => telegramSuccess(++posts));
  t.mock.method(console, "info", () => {});
  const config = telegramConfig(dataDir, now);

  assert.equal((await sendAlerts(config, strong)).status, "delivered");
  const folded = await sendAlerts(config, weak);
  assert.equal(folded.reason, "semantic_duplicate");
  assert.equal(folded.duplicateOf, strong.eventKey);
  assert.equal(folded.canonicalOwnerDelivered, true);
  let outbox = await readAlertOutbox(dataDir);
  assert.deepEqual(outbox.fourRegistryDeliveryOwners[weak.eventKey], {
    version: 1,
    eventId: weak.eventKey,
    baseEventKey: weak.eventKey,
    blockHash: weak.blockHash,
    payloadDigest: weak.payloadDigest,
    deliveryEvidenceDigest: weak.deliveryEvidenceDigest,
    status: "semantic_duplicate",
    duplicateOf: strong.eventKey,
    canonicalOwnerDelivered: true,
    ownerDeliveredAt: weak.observedAt,
  });

  const old = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
  await backdateDeliveredEntries(dataDir, old);
  const orphaned = await cancelPendingFourRegistryEvent(config, registryCancellation(weak));
  assert.equal(orphaned.status, "delivered_orphaned");
  assert.equal(orphaned.deliveredAt, old);
  outbox = await readAlertOutbox(dataDir);
  assert.equal(outbox.events[weak.eventKey], undefined, "the suppressed Registry payload is compacted");
  assert.equal(outbox.fourRegistryDeliveryOwners[weak.eventKey].duplicateOf, strong.eventKey);

  const replay = await sendAlerts(config, weak);
  assert.equal(replay.status, "suppressed");
  assert.equal(replay.reason, "semantic_duplicate");
  assert.equal(replay.duplicateOf, strong.eventKey);
  assert.equal(replay.canonicalOwnerDelivered, true);
  assert.equal(posts, 1, "the compact semantic receipt never re-posts the weak card");
});

test("Registry reorg cancellation waits for an in-flight BSC safety owner and then reports delivered history", async (t) => {
  const { weak, strong } = await produceCrossProducerFirstTokenEvents(t);
  const dataDir = await temporaryDirectory(t, "openfour-registry-cancel-strong-inflight-");
  const now = { value: Date.parse(weak.observedAt) };
  let posts = 0;
  let releaseStrong;
  let markStrongStarted;
  const strongStarted = new Promise((resolve) => { markStrongStarted = resolve; });
  const strongGate = new Promise((resolve) => { releaseStrong = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    posts += 1;
    if (posts === 1) return { ok: false, status: 503, text: async () => "temporary outage" };
    markStrongStarted();
    await strongGate;
    return telegramSuccess(posts);
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const config = telegramConfig(dataDir, now);

  assert.equal((await sendAlerts(config, weak)).status, "queued");
  const strongDelivery = sendAlerts(config, strong);
  await strongStarted;
  assert.deepEqual(await cancelPendingFourRegistryEvent(config, registryCancellation(weak)), {
    status: "queued",
    reason: "delivery_in_flight",
    persisted: true,
    terminal: false,
    eventId: weak.eventKey,
  });
  releaseStrong();
  assert.equal((await strongDelivery).status, "delivered");
  const orphaned = await cancelPendingFourRegistryEvent(config, registryCancellation(weak));
  assert.equal(orphaned.status, "delivered_orphaned");
  assert.equal(posts, 2);
  const outbox = await readAlertOutbox(dataDir);
  assert.equal(outbox.events[weak.eventKey].semanticDuplicateOf, strong.eventKey);
  assert.equal(outbox.events[weak.eventKey].semanticDuplicateOwnerDelivered, true);
});

test("producer reorg recovery freezes behind an in-flight BSC owner, then emits one Registry revision", async (t) => {
  const producerDataDir = await temporaryDirectory(t, "four-registry-inflight-revision-producer-");
  const alertDataDir = await temporaryDirectory(t, "four-registry-inflight-revision-alert-");
  const now = { value: Date.parse("2026-09-04T08:00:00.000Z") };
  let posts = 0;
  let releaseStrong;
  let markStrongStarted;
  const strongStarted = new Promise((resolve) => { markStrongStarted = resolve; });
  const strongGate = new Promise((resolve) => { releaseStrong = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    posts += 1;
    if (posts === 2) return { ok: false, status: 503, text: async () => "temporary outage" };
    if (posts === 3) {
      markStrongStarted();
      await strongGate;
    }
    return telegramSuccess(posts);
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const config = telegramConfig(alertDataDir, now);
  const produced = await produceFourRegistryPresetAndFirstToken(t, {
    dataDir: producerDataDir,
    now: () => now.value,
    onEvent: (event) => sendAlerts(config, event),
    cancelPendingEvent: (evidence) => cancelPendingFourRegistryEvent(config, evidence),
  });
  const weak = produced.events.find((event) => event.kind === "four_registry_first_token");
  assert.equal((await readAlertOutbox(alertDataDir)).events[weak.eventKey].status, "pending");
  const strong = (await produceLegacyBscOpenFourSafetyEvent(t, {
    transactionHash: weak.transactionHash,
    blockHash: weak.blockHash,
    blockNumber: weak.blockNumber,
    transactionIndex: weak.transactionIndex,
    logIndex: weak.logIndex,
    token: weak.token.address,
    presetId: weak.presetId,
    quoteAsset: weak.token.quoteAsset,
    observedAt: weak.observedAt,
  })).event;
  const strongDelivery = sendAlerts(config, strong);
  await strongStarted;

  const tokenTx = fourRegistryTxHash("c");
  produced.provider.logs = produced.provider.logs.filter((log) => log.transactionHash !== tokenTx);
  produced.provider.receipts.delete(tokenTx);
  produced.provider.transactions.delete(tokenTx);
  produced.provider.setBlockHash(102, `0x${"e".repeat(64)}`);
  addFourRegistryTokenCreated(produced.provider, produced.added, { hash: tokenTx });
  const blockedRecovery = await produced.monitor.check();
  assert.equal(blockedRecovery.status, "degraded");
  assert.equal(blockedRecovery.errorCode, "FOUR_REGISTRY_CANCELLATION_IN_FLIGHT");
  releaseStrong();
  assert.equal((await strongDelivery).status, "delivered");

  now.value += 1_000;
  assert.equal((await produced.monitor.check()).status, "recovered_reorg");
  const replayed = await produced.monitor.check();
  assert.equal(replayed.events.length, 1);
  const revision = replayed.events[0];
  assert.equal(revision.kind, "four_registry_first_token");
  assert.equal(revision.canonicalRevision.cancellationStatus, "delivered_orphaned");
  assert.equal(revision.canonicalRevision.replacesDeliveryStatus, "queued");
  assert.equal((await readAlertOutbox(alertDataDir)).events[revision.eventKey].status, "delivered");
  assert.equal(posts, 4, "old capability, failed weak, delivered safety owner, and one canonical correction");
});

test("Registry reorg cancellation atomically disables an undelivered BSC safety owner before drain", async (t) => {
  const { weak, strong } = await produceCrossProducerFirstTokenEvents(t);
  const dataDir = await temporaryDirectory(t, "openfour-registry-cancel-strong-pending-");
  const now = { value: Date.parse(weak.observedAt) };
  let available = false;
  let posts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    posts += 1;
    return available ? telegramSuccess(posts) : { ok: false, status: 503, text: async () => "temporary outage" };
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const config = telegramConfig(dataDir, now);

  assert.equal((await sendAlerts(config, strong)).status, "queued");
  const weakResult = await sendAlerts(config, weak);
  assert.ok(["queued", "suppressed"].includes(weakResult.status));
  assert.notEqual(weakResult.canonicalOwnerDelivered, true);
  const postsBeforeCancellation = posts;
  assert.equal((await cancelPendingFourRegistryEvent(config, registryCancellation(weak))).status, "superseded");
  available = true;
  now.value += 6_000;
  assert.equal(await drainAlertOutbox(config), 0);
  assert.equal(posts, postsBeforeCancellation, "the old-fork BSC safety card cannot drain after Registry cancellation");
  const outbox = await readAlertOutbox(dataDir);
  assert.equal(outbox.events[strong.eventKey].status, "suppressed");
  assert.equal(outbox.events[strong.eventKey].destinations.telegram.disabledReason, "four_registry_canonical_reorg");
  assert.equal(outbox.events[weak.eventKey].destinations.telegram.disabledReason, "four_registry_canonical_reorg");
});

test("an in-flight safety pass serializes the weaker Registry producer and becomes its delivered owner", async (t) => {
  const { weak, strong } = await produceCrossProducerFirstTokenEvents(t);
  const dataDir = await temporaryDirectory(t, "openfour-cross-inflight-strong-");
  const now = { value: Date.parse(weak.observedAt) };
  let posts = 0;
  let releasePost;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releasePost = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    posts += 1;
    markStarted();
    await gate;
    return telegramSuccess(posts);
  });
  t.mock.method(console, "info", () => {});
  const config = telegramConfig(dataDir, now);

  const strongDelivery = sendAlerts(config, strong);
  await started;
  const waitingWeak = await sendAlerts(config, weak);
  assert.equal(waitingWeak.status, "queued");
  assert.equal(waitingWeak.persisted, true);
  assert.equal(posts, 1);
  releasePost();
  assert.equal((await strongDelivery).status, "delivered");
  const acknowledgedWeak = await sendAlerts(config, weak);
  assert.equal(acknowledgedWeak.reason, "semantic_duplicate");
  assert.equal(acknowledgedWeak.canonicalOwnerDelivered, true);
  assert.equal(posts, 1, "the weaker producer never races a second Telegram POST");
});

test("immutable OpenFour owner corruption and capacity overflow fail closed before delivery", async (t) => {
  const { weak } = await produceCrossProducerFirstTokenEvents(t);
  const now = { value: Date.parse(weak.observedAt) };
  let posts = 0;
  t.mock.method(globalThis, "fetch", async () => telegramSuccess(++posts));

  const corruptDir = await temporaryDirectory(t, "openfour-owner-corrupt-");
  await fs.writeFile(path.join(corruptDir, "alert-outbox.json"), `${JSON.stringify({
    version: 2,
    events: {},
    immutableOpenFourSignalOwners: {
      [focusNoveltyKeys(weak)[0]]: {
        version: 1,
        eventId: "forged-owner",
        deliveredAt: weak.observedAt,
        attackerUrl: "https://attacker.invalid/buy",
      },
    },
  })}\n`, "utf8");
  await assert.rejects(
    sendAlerts(telegramConfig(corruptDir, now), weak),
    /invalid immutable OpenFour signal owner/u,
  );

  const overflowDir = await temporaryDirectory(t, "openfour-owner-overflow-");
  let overflowOwners = Object.fromEntries(Array.from(
    { length: 100_001 },
    (_unused, index) => [`overflow-${index}`, null],
  ));
  await fs.writeFile(path.join(overflowDir, "alert-outbox.json"), `${JSON.stringify({
    version: 2,
    events: {},
    immutableOpenFourSignalOwners: overflowOwners,
  })}\n`, "utf8");
  await assert.rejects(
    sendAlerts(telegramConfig(overflowDir, now), weak),
    /immutable OpenFour signal owner capacity exceeded/u,
  );

  overflowOwners = null;
  const registryCorruptDir = await temporaryDirectory(t, "four-registry-owner-corrupt-");
  await fs.writeFile(path.join(registryCorruptDir, "alert-outbox.json"), `${JSON.stringify({
    version: 2,
    events: {},
    fourRegistryDeliveryOwners: {
      [weak.eventKey]: {
        version: 1,
        eventId: weak.eventKey,
        baseEventKey: weak.eventKey,
        blockHash: weak.blockHash,
        payloadDigest: weak.payloadDigest,
        deliveryEvidenceDigest: weak.deliveryEvidenceDigest,
        deliveredAt: weak.observedAt,
        attackerUrl: "https://attacker.invalid/buy",
      },
    },
  })}\n`, "utf8");
  await assert.rejects(
    sendAlerts(telegramConfig(registryCorruptDir, now), weak),
    /invalid Four Registry delivery owner/u,
  );

  const registryOverflowDir = await temporaryDirectory(t, "four-registry-owner-overflow-");
  overflowOwners = Object.fromEntries(Array.from(
    { length: 100_001 },
    (_unused, index) => [`overflow-${index}`, null],
  ));
  await fs.writeFile(path.join(registryOverflowDir, "alert-outbox.json"), `${JSON.stringify({
    version: 2,
    events: {},
    fourRegistryDeliveryOwners: overflowOwners,
  })}\n`, "utf8");
  await assert.rejects(
    sendAlerts(telegramConfig(registryOverflowDir, now), weak),
    /Four Registry delivery owner capacity exceeded/u,
  );
  assert.equal(posts, 0);
});

test("Registry reorg cancellation durably supersedes failed old-fork cards before retry drain", async (t) => {
  const alertDataDir = await temporaryDirectory(t, "four-registry-reorg-cancel-");
  const now = { value: Date.parse("2026-09-04T08:00:00.000Z") };
  let telegramAvailable = false;
  let posts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    posts += 1;
    return telegramAvailable
      ? telegramSuccess(posts)
      : { ok: false, status: 503, text: async () => "temporary outage" };
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const config = telegramConfig(alertDataDir, now);
  const deliveryResults = [];
  const produced = await produceFourRegistryPresetAndFirstToken(t, {
    now: () => now.value,
    onEvent: async (event) => {
      const result = await sendAlerts(config, event);
      deliveryResults.push(result);
      return result;
    },
  });
  assert.equal(produced.result.status, "ok", "the producer may advance after a durable shared queued ack");
  assert.deepEqual(deliveryResults.map((result) => result.status), ["queued", "queued"]);
  assert.equal(posts, 2);

  for (const event of produced.events) {
    const cancellation = registryCancellation(event);
    assert.deepEqual(await cancelPendingFourRegistryEvent(config, cancellation), {
      status: "superseded",
      reason: "canonical_reorg",
      persisted: true,
      terminal: true,
      eventId: event.eventKey,
    });
    assert.equal((await cancelPendingFourRegistryEvent(config, structuredClone(cancellation))).status, "superseded");
  }
  telegramAvailable = true;
  now.value += 60_000;
  assert.equal(await drainAlertOutbox(config), 0);
  assert.equal(posts, 2, "generic retry never posts an orphaned Registry proof");
  const outbox = await readAlertOutbox(alertDataDir);
  assert.ok(Object.values(outbox.events).every((entry) => entry.status === "suppressed"));
  assert.ok(Object.values(outbox.events).every((entry) => entry.destinations.telegram.disabledReason === "four_registry_canonical_reorg"));
});

test("Registry cancellation never overwrites an in-flight lease and reports a delivered orphan afterward", async (t) => {
  const produced = await produceFourRegistryPresetCapability(t, "four_registry_preset_added");
  const event = produced.events[0];
  const dataDir = await temporaryDirectory(t, "four-registry-reorg-inflight-");
  const now = { value: Date.parse(event.observedAt) };
  let releasePost;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releasePost = resolve; });
  let posts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    posts += 1;
    markStarted();
    await gate;
    return telegramSuccess(posts);
  });
  t.mock.method(console, "info", () => {});
  const config = telegramConfig(dataDir, now);
  const delivery = sendAlerts(config, event);
  await started;
  assert.deepEqual(await cancelPendingFourRegistryEvent(config, registryCancellation(event)), {
    status: "queued",
    reason: "delivery_in_flight",
    persisted: true,
    terminal: false,
    eventId: event.eventKey,
  });
  let outbox = await readAlertOutbox(dataDir);
  assert.equal(outbox.events[event.eventKey].destinations.telegram.status, "delivering");

  releasePost();
  assert.equal((await delivery).status, "delivered");
  const orphaned = await cancelPendingFourRegistryEvent(config, registryCancellation(event));
  assert.equal(orphaned.status, "delivered_orphaned");
  assert.equal(orphaned.persisted, true);
  assert.equal(orphaned.terminal, true);
  assert.equal(posts, 1);
  outbox = await readAlertOutbox(dataDir);
  assert.deepEqual(outbox.events[event.eventKey].fourRegistryCancellation, registryCancellation(event));

  await assert.rejects(
    cancelPendingFourRegistryEvent(config, { ...registryCancellation(event), attackerUrl: "https://attacker.invalid" }),
    /exact schema/u,
  );
  await assert.rejects(
    cancelPendingFourRegistryEvent(config, { ...registryCancellation(event), blockHash: `0x${"f".repeat(64)}` }),
    /does not match/u,
  );
  await assert.rejects(
    cancelPendingFourRegistryEvent(config, { ...registryCancellation(event), deliveryEvidenceDigest: `0x${"f".repeat(64)}` }),
    /does not match/u,
  );
});

test("a compact Registry delivery owner survives 31-day pruning and closes an ack-fsync reorg gap", async (t) => {
  const produced = await produceFourRegistryPresetCapability(t, "four_registry_preset_added");
  const event = produced.events[0];
  const dataDir = await temporaryDirectory(t, "four-registry-owner-31d-");
  const now = { value: Date.parse(event.observedAt) };
  let posts = 0;
  t.mock.method(globalThis, "fetch", async () => telegramSuccess(++posts));
  t.mock.method(console, "info", () => {});
  const config = telegramConfig(dataDir, now);
  assert.equal((await sendAlerts(config, event)).status, "delivered");
  let outbox = await readAlertOutbox(dataDir);
  assert.deepEqual(outbox.fourRegistryDeliveryOwners[event.eventKey], {
    version: 1,
    eventId: event.eventKey,
    baseEventKey: event.eventKey,
    blockHash: event.blockHash,
    payloadDigest: event.payloadDigest,
    deliveryEvidenceDigest: event.deliveryEvidenceDigest,
    deliveredAt: event.observedAt,
  });

  await backdateDeliveredEntries(dataDir, new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString());
  const orphaned = await cancelPendingFourRegistryEvent(config, registryCancellation(event));
  assert.equal(orphaned.status, "delivered_orphaned");
  assert.equal(orphaned.persisted, true);
  assert.equal(orphaned.eventId, event.eventKey);
  assert.equal(posts, 1);
  outbox = await readAlertOutbox(dataDir);
  assert.equal(outbox.events[event.eventKey], undefined, "large delivered payload is pruned");
  assert.ok(outbox.fourRegistryDeliveryOwners[event.eventKey], "compact exact owner remains queryable");

  const replay = await sendAlerts(config, event);
  assert.equal(replay.status, "suppressed");
  assert.equal(replay.reason, "semantic_duplicate");
  assert.equal(replay.canonicalOwnerDelivered, true);
  assert.equal(posts, 1, "an exact compacted Registry owner short-circuits normal enqueue");

  await assert.rejects(
    cancelPendingFourRegistryEvent(config, { ...registryCancellation(event), payloadDigest: `0x${"f".repeat(64)}` }),
    /does not match/u,
  );
  await assert.rejects(
    cancelPendingFourRegistryEvent(config, { ...registryCancellation(event), deliveryEvidenceDigest: `0x${"f".repeat(64)}` }),
    /does not match/u,
  );
});

test("an undelivered Registry proof is atomically superseded by its authenticated replacement", async (t) => {
  const producerDataDir = await temporaryDirectory(t, "four-registry-supersession-producer-");
  const alertDataDir = await temporaryDirectory(t, "four-registry-supersession-alert-");
  const now = { value: Date.parse("2026-09-04T08:00:00.000Z") };
  let available = false;
  let posts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    posts += 1;
    return available ? telegramSuccess(posts) : { ok: false, status: 503, text: async () => "temporary outage" };
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const config = telegramConfig(alertDataDir, now);
  const disabled = fourRegistryPreset("1778027617301", { active: false });
  const enabled = fourRegistryPreset(disabled.id, { active: true });
  const provider = new FourRegistryFakeProvider({ head: 102 });
  provider.setSnapshot(100, [disabled]);
  const fixture = await createFourRegistryFixture(t, provider, {
    dataDir: producerDataDir,
    now: () => now.value,
    onEvent: (event) => sendAlerts(config, event),
    cancelPendingEvent: (evidence) => cancelPendingFourRegistryEvent(config, evidence),
    config: { fourRegistryLogChunkSize: 1 },
  });
  await fixture.monitor.check();
  const txHash = fourRegistryTxHash("7");
  provider.head = 103;
  provider.setSnapshot(101, [enabled]);
  addFourRegistryActiveUpdate(provider, enabled, { blockNumber: 101, transactionIndex: 1, logIndex: 0, hash: txHash });
  const original = (await fixture.monitor.check()).events[0];
  assert.equal((await readAlertOutbox(alertDataDir)).events[original.eventKey].status, "pending");

  provider.logs = provider.logs.filter((log) => log.transactionHash !== txHash);
  provider.receipts.delete(txHash);
  provider.transactions.delete(txHash);
  provider.setBlockHash(101, `0x${"c".repeat(64)}`);
  addFourRegistryActiveUpdate(provider, enabled, { blockNumber: 101, transactionIndex: 1, logIndex: 0, hash: txHash });
  assert.equal((await fixture.monitor.check()).status, "recovered_reorg");
  available = true;
  now.value += 1_000;
  const replayed = await fixture.monitor.check();
  assert.equal(replayed.events.length, 1);
  assert.ok(replayed.events[0].canonicalSupersession);
  assert.equal(replayed.events[0].canonicalRevision, undefined);
  assert.equal(replayed.events[0].eventKey, original.eventKey);
  const forgedSupersession = structuredClone(replayed.events[0]);
  forgedSupersession.canonicalSupersession.cancelledPayloadDigest = `0x${"f".repeat(64)}`;
  assert.equal(isStrictFourRegistryCapabilityUpdate(forgedSupersession), false);
  assert.equal(isRelevantAlert(forgedSupersession), false);
  const outbox = await readAlertOutbox(alertDataDir);
  assert.equal(outbox.events[original.eventKey].status, "delivered");
  assert.equal(outbox.events[original.eventKey].event.blockHash, `0x${"c".repeat(64)}`);
  assert.equal(outbox.events[original.eventKey].fourRegistryReactivation.kind, "canonical_supersession");
  assert.equal(posts, 2, "one failed old-fork POST and one successful current-proof POST");
});

test("a cancelled Registry proof is restored only by the exact recanonicalization envelope", async (t) => {
  const producerDataDir = await temporaryDirectory(t, "four-registry-restoration-producer-");
  const alertDataDir = await temporaryDirectory(t, "four-registry-restoration-alert-");
  const now = { value: Date.parse("2026-09-04T08:00:00.000Z") };
  let available = false;
  let posts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    posts += 1;
    return available ? telegramSuccess(posts) : { ok: false, status: 503, text: async () => "temporary outage" };
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  const config = telegramConfig(alertDataDir, now);
  const disabled = fourRegistryPreset("1778027617302", { active: false });
  const enabled = fourRegistryPreset(disabled.id, { active: true });
  const provider = new FourRegistryFakeProvider({ head: 102 });
  provider.setSnapshot(100, [disabled]);
  const fixture = await createFourRegistryFixture(t, provider, {
    dataDir: producerDataDir,
    now: () => now.value,
    onEvent: (event) => sendAlerts(config, event),
    cancelPendingEvent: (evidence) => cancelPendingFourRegistryEvent(config, evidence),
    config: { fourRegistryLogChunkSize: 1 },
  });
  await fixture.monitor.check();
  const txHash = fourRegistryTxHash("8");
  provider.head = 103;
  provider.setSnapshot(101, [enabled]);
  addFourRegistryActiveUpdate(provider, enabled, { blockNumber: 101, transactionIndex: 1, logIndex: 0, hash: txHash });
  const original = (await fixture.monitor.check()).events[0];

  provider.logs = provider.logs.filter((log) => log.transactionHash !== txHash);
  provider.receipts.delete(txHash);
  provider.transactions.delete(txHash);
  provider.setBlockHash(101, `0x${"b".repeat(64)}`);
  provider.setSnapshot(101, [disabled]);
  assert.equal((await fixture.monitor.check()).status, "recovered_reorg");
  let outbox = await readAlertOutbox(alertDataDir);
  assert.equal(outbox.events[original.eventKey].destinations.telegram.disabledReason, "four_registry_canonical_reorg");
  const ordinaryReplay = await sendAlerts(config, original);
  assert.equal(ordinaryReplay.status, "suppressed");
  assert.equal(posts, 1, "an ordinary replay cannot revive a proof cancelled by canonical reorg");

  provider.setBlockHash(101, original.blockHash);
  provider.setSnapshot(101, [enabled]);
  addFourRegistryActiveUpdate(provider, enabled, { blockNumber: 101, transactionIndex: 1, logIndex: 0, hash: txHash });
  available = true;
  now.value += 1_000;
  const restored = await fixture.monitor.check();
  assert.equal(restored.events.length, 1);
  assert.ok(restored.events[0].canonicalRestoration);
  const forgedRestoration = structuredClone(restored.events[0]);
  forgedRestoration.canonicalRestoration.attackerUrl = "https://attacker.invalid/buy";
  assert.equal(isStrictFourRegistryCapabilityUpdate(forgedRestoration), false);
  assert.equal(isRelevantAlert(forgedRestoration), false);
  outbox = await readAlertOutbox(alertDataDir);
  assert.equal(outbox.events[original.eventKey].status, "delivered");
  assert.equal(outbox.events[original.eventKey].fourRegistryReactivation.kind, "canonical_restoration");
  assert.match(outbox.events[original.eventKey].renderBundle.zh.text, /链重组后原证据恢复/u);
  assert.equal(posts, 2, "ordinary scans cannot revive the proof; the closed restoration posts once");
});

test("delivered capability and first-token proofs emit one explicit T2 canonical revision per new fork", async (t) => {
  const producerDataDir = await temporaryDirectory(t, "four-registry-revision-producer-");
  const alertDataDir = await temporaryDirectory(t, "four-registry-revision-alert-");
  const now = { value: Date.parse("2026-09-04T08:00:00.000Z") };
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return telegramSuccess(payloads.length);
  });
  t.mock.method(console, "info", () => {});
  const config = telegramConfig(alertDataDir, now);
  const observed = [];
  const produced = await produceFourRegistryPresetAndFirstToken(t, {
    dataDir: producerDataDir,
    now: () => now.value,
    onEvent: async (event) => {
      observed.push(event);
      return sendAlerts(config, event);
    },
    cancelPendingEvent: (evidence) => cancelPendingFourRegistryEvent(config, evidence),
  });
  assert.equal(payloads.length, 2);
  const capabilityTx = fourRegistryTxHash("a");
  const tokenTx = fourRegistryTxHash("c");
  produced.provider.logs = produced.provider.logs.filter((log) => ![capabilityTx, tokenTx].includes(log.transactionHash));
  produced.provider.receipts.delete(capabilityTx);
  produced.provider.receipts.delete(tokenTx);
  produced.provider.transactions.delete(capabilityTx);
  produced.provider.transactions.delete(tokenTx);
  produced.provider.setBlockHash(101, `0x${"d".repeat(64)}`);
  produced.provider.setBlockHash(102, `0x${"e".repeat(64)}`);
  addFourRegistryPresetUpsert(produced.provider, produced.added, { hash: capabilityTx });
  const revisedToken = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  addFourRegistryTokenCreated(produced.provider, produced.added, { hash: tokenTx, token: revisedToken });
  now.value += 1_000;
  assert.equal((await produced.monitor.check()).status, "recovered_reorg");
  const replayed = await produced.monitor.check();
  assert.equal(replayed.events.length, 2);
  assert.ok(replayed.events.every((event) => event.canonicalRevision));
  assert.ok(replayed.events.every((event) => event.deliveryPolicy.tier === "T2"));
  const forgedRevision = structuredClone(replayed.events[0]);
  forgedRevision.canonicalRevision.recoveryEpoch += 1;
  assert.equal(isStrictFourRegistryCapabilityUpdate(forgedRevision), false);
  assert.equal(isRelevantAlert(forgedRevision), false);
  assert.equal(
    replayed.events.find((event) => event.kind === "four_registry_first_token").token.address,
    revisedToken,
    "a replacement-fork token CA is not swallowed by the old immutable Core owner",
  );
  const outbox = await readAlertOutbox(alertDataDir);
  for (const event of replayed.events) {
    const entry = outbox.events[event.eventKey];
    assert.equal(entry.status, "delivered");
    assert.equal(entry.event.tradingPriority.tier, "T2");
    assert.equal(entry.event.tradingPriority.category, "focus_registry_canonical_revision");
    assert.equal(entry.deliveryDisposition.reason, "four_registry_canonical_revision");
    assert.match(entry.renderBundle.zh.text, /链重组修订｜旧证据失效｜以本条为准/u);
    assert.equal((await sendAlerts(config, event)).status, "delivered");
  }
  assert.equal(payloads.length, 4, "two original cards plus one revision for each canonical proof");
  assert.equal(observed.length, 4);
});

test("a 31-day BSC safety owner cannot swallow the Registry first-token canonical revision", async (t) => {
  const producerDataDir = await temporaryDirectory(t, "four-registry-cross-revision-producer-");
  const alertDataDir = await temporaryDirectory(t, "four-registry-cross-revision-alert-");
  const now = { value: Date.parse("2026-09-04T08:00:00.000Z") };
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return telegramSuccess(payloads.length);
  });
  t.mock.method(console, "info", () => {});
  const config = telegramConfig(alertDataDir, now);
  let legacySafety = null;
  const observed = [];
  const produced = await produceFourRegistryPresetAndFirstToken(t, {
    dataDir: producerDataDir,
    now: () => now.value,
    onEvent: async (event) => {
      observed.push(event);
      if (event.kind === "four_registry_first_token" && !event.canonicalRevision && !legacySafety) {
        legacySafety = (await produceLegacyBscOpenFourSafetyEvent(t, {
          transactionHash: event.transactionHash,
          blockHash: event.blockHash,
          blockNumber: event.blockNumber,
          transactionIndex: event.transactionIndex,
          logIndex: event.logIndex,
          token: event.token.address,
          presetId: event.presetId,
          quoteAsset: event.token.quoteAsset,
          observedAt: event.observedAt,
        })).event;
        assert.equal((await sendAlerts(config, legacySafety)).status, "delivered");
      }
      return sendAlerts(config, event);
    },
    cancelPendingEvent: (evidence) => cancelPendingFourRegistryEvent(config, evidence),
  });
  const oldFirst = observed.find((event) => event.kind === "four_registry_first_token");
  let outbox = await readAlertOutbox(alertDataDir);
  assert.equal(outbox.events[oldFirst.eventKey].status, "suppressed");
  assert.equal(outbox.events[oldFirst.eventKey].semanticDuplicateOf, legacySafety.eventKey);
  assert.equal(outbox.fourRegistryDeliveryOwners[oldFirst.eventKey].status, "semantic_duplicate");
  assert.equal(payloads.length, 2, "old capability and BSC safety cards are visible; weak Registry first-token folds");

  await backdateDeliveredEntries(alertDataDir, new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString());
  const capabilityTx = fourRegistryTxHash("a");
  const tokenTx = fourRegistryTxHash("c");
  produced.provider.logs = produced.provider.logs.filter((log) => ![capabilityTx, tokenTx].includes(log.transactionHash));
  produced.provider.receipts.delete(capabilityTx);
  produced.provider.receipts.delete(tokenTx);
  produced.provider.transactions.delete(capabilityTx);
  produced.provider.transactions.delete(tokenTx);
  produced.provider.setBlockHash(101, `0x${"d".repeat(64)}`);
  produced.provider.setBlockHash(102, `0x${"e".repeat(64)}`);
  addFourRegistryPresetUpsert(produced.provider, produced.added, { hash: capabilityTx });
  addFourRegistryTokenCreated(produced.provider, produced.added, { hash: tokenTx });
  now.value += 1_000;
  assert.equal((await produced.monitor.check()).status, "recovered_reorg");
  const replayed = await produced.monitor.check();
  const revisedFirst = replayed.events.find((event) => event.kind === "four_registry_first_token");
  assert.ok(revisedFirst?.canonicalRevision);
  assert.equal(revisedFirst.canonicalRevision.replacesDeliveryStatus, "semantic_duplicate");
  assert.equal(revisedFirst.canonicalRevision.replacesDuplicateOf, legacySafety.eventKey);
  assert.equal(revisedFirst.canonicalRevision.replacesCanonicalOwnerDelivered, true);
  outbox = await readAlertOutbox(alertDataDir);
  assert.equal(outbox.events[revisedFirst.eventKey].status, "delivered");
  assert.match(outbox.events[revisedFirst.eventKey].renderBundle.zh.text, /链重组修订｜旧证据失效｜以本条为准/u);
  assert.equal(payloads.length, 4, "the new-fork capability and first-token revisions each post exactly once");
  assert.ok(payloads.every((payload) => !/gmgn|swap|买入|buy now/iu.test(JSON.stringify(payload.reply_markup || {}))));
});

test("A-B-A-B finalized Registry transitions each emit one epoch-bound correction and retry exact-once", async (t) => {
  const producerDataDir = await temporaryDirectory(t, "four-registry-oscillation-producer-");
  const alertDataDir = await temporaryDirectory(t, "four-registry-oscillation-alert-");
  const now = { value: Date.parse("2026-09-04T08:00:00.000Z") };
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return telegramSuccess(payloads.length);
  });
  t.mock.method(console, "info", () => {});
  const config = telegramConfig(alertDataDir, now);
  const disabled = fourRegistryPreset("1778027617303", { active: false });
  const enabled = fourRegistryPreset(disabled.id, { active: true });
  const provider = new FourRegistryFakeProvider({ head: 102 });
  provider.setSnapshot(100, [disabled]);
  const fixture = await createFourRegistryFixture(t, provider, {
    dataDir: producerDataDir,
    now: () => now.value,
    onEvent: (event) => sendAlerts(config, event),
    cancelPendingEvent: (evidence) => cancelPendingFourRegistryEvent(config, evidence),
    config: { fourRegistryLogChunkSize: 1 },
  });
  await fixture.monitor.check();
  const txHash = fourRegistryTxHash("9");
  provider.head = 103;
  provider.setSnapshot(101, [enabled]);
  addFourRegistryActiveUpdate(provider, enabled, { blockNumber: 101, transactionIndex: 1, logIndex: 0, hash: txHash });
  const branchA = (await fixture.monitor.check()).events[0];
  const originalAHash = branchA.blockHash;

  const replaceBranch = async (blockHash) => {
    provider.logs = provider.logs.filter((log) => log.transactionHash !== txHash);
    provider.receipts.delete(txHash);
    provider.transactions.delete(txHash);
    provider.setBlockHash(101, blockHash);
    addFourRegistryActiveUpdate(provider, enabled, { blockNumber: 101, transactionIndex: 1, logIndex: 0, hash: txHash });
    now.value += 1_000;
    assert.equal((await fixture.monitor.check()).status, "recovered_reorg");
    const current = (await fixture.monitor.check()).events[0];
    assert.ok(current.canonicalRevision);
    return current;
  };

  const branchBHash = `0x${"e".repeat(64)}`;
  const branchB = await replaceBranch(branchBHash);
  const branchASecond = await replaceBranch(originalAHash);
  const branchBSecond = await replaceBranch(branchBHash);
  assert.deepEqual([
    branchB.canonicalRevision.recoveryEpoch,
    branchASecond.canonicalRevision.recoveryEpoch,
    branchBSecond.canonicalRevision.recoveryEpoch,
  ], [1, 2, 3]);
  assert.equal(new Set([branchA.eventKey, branchB.eventKey, branchASecond.eventKey, branchBSecond.eventKey]).size, 4);
  assert.equal(payloads.length, 4, "the original plus every finalized correction is visible once");
  assert.ok(payloads.slice(1).every((payload) => /链重组修订｜以本条为准/u.test(payload.text)));
  assert.ok(payloads.slice(1).every((payload) => !/风险|Risk:|勿追价|do not chase|非自动交易|no automatic trading|非买入建议|not a buy recommendation|旧证据失效|\bT[0-2]\b/iu.test(payload.text)));

  assert.equal((await sendAlerts(config, branchBSecond)).status, "delivered");
  assert.equal(payloads.length, 4, "retrying the same recovery epoch cannot post twice");
  const outbox = await readAlertOutbox(alertDataDir);
  assert.ok([branchB, branchASecond, branchBSecond].every((event) => (
    outbox.events[event.eventKey].deliveryDisposition.reason === "four_registry_canonical_revision"
  )));
});
