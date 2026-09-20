import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GENIUS_FACTORY, GENIUS_FACTORY_CODE_HASH, GENIUS_OFFICIAL_ROLES,
  claimsGeniusSource, isStrictGeniusEvent,
} from "../src/genius-source-policy.js";
import { isMonitoringSourceEnabled, isThreePlatformSource } from "../src/source-controls.js";
import {
  alertDeliveryDisposition, classifyAlertFreshness, drainAlertOutbox, focusNoveltyKeys,
  isRelevantAlert, isStrongAlert, sendAlerts, telegramButtons,
} from "../src/alerts.js";
import { buildBilingualAlertBundle, renderBilingualTelegramText } from "../src/bilingual-alert-renderer.js";
import { geniusAlertNarrative, renderGeniusAlertLines } from "../src/genius-alert.js";
import { hasGeniusBusinessChanges, isGeniusTechnicalChange, summarizeGeniusEvent } from "../src/genius-summary.js";
import { assertGeniusChainDeliveryCanonical } from "../src/genius-delivery-verification.js";

const CA = `0x${"1".repeat(40)}`;
const CURVE = `0x${"2".repeat(40)}`;
const TX = `0x${"3".repeat(64)}`;
const BLOCK = `0x${"4".repeat(64)}`;
const stamp = () => new Date().toISOString();

function documentEvent() {
  const sourceId = "genius_manifest";
  const sourceUrl = "https://genius.fun/contracts/manifest.json";
  const beforeHash = "a".repeat(64);
  const afterHash = "b".repeat(64);
  return {
    type: "genius_fun_update", platform: "geniusfun", chainId: 56, sourceTrust: "official_verified",
    kind: "manifest_update", sourceId, sourceUrl, observedAt: stamp(),
    eventKey: `genius:${sourceId}:${beforeHash}:${afterHash}`,
    evidence: { sourceUrl, beforeHash, afterHash },
    changes: [{ field: "TokenFactory.version", before: "4.0.0", after: "4.1.0" }],
  };
}

function chainEvent() {
  const event = {
    type: "genius_fun_update", platform: "geniusfun", chainId: 56, sourceTrust: "official_verified",
    kind: "official_token_launch", sourceId: "genius_chain", sourceUrl: `https://bscscan.com/tx/${TX}`,
    observedAt: stamp(), sourceOccurredAt: stamp(), eventKey: `genius:chain:${TX}:3:${BLOCK}`,
    factory: GENIUS_FACTORY, transactionHash: TX, blockNumber: 12345678, blockHash: BLOCK, logIndex: 3,
    token: { address: CA, curve: CURVE, classification: "official_wallet_associated", deployer: GENIUS_OFFICIAL_ROLES[1] },
    evidence: { chainId: 56, factory: GENIUS_FACTORY, runtimeCodeHash: GENIUS_FACTORY_CODE_HASH,
      providers: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"],
      eventName: "TokenLaunched", args: { token: CA, curve: CURVE, deployer: GENIUS_OFFICIAL_ROLES[1], launchConfigId: "1" } },
  };
  return event;
}

function xEvent() {
  const sourceOccurredAt = stamp();
  return {
    type: "genius_fun_update", platform: "geniusfun", chainId: 56, sourceTrust: "official_verified",
    kind: "official_announcement", sourceId: "genius_x", sourceUrl: "https://x.com/GeniusTerminal/status/1234567890123456789",
    observedAt: stamp(), sourceOccurredAt, eventKey: "genius:x:1236460732486692864:1234567890123456789",
    tweet: { id: "1234567890123456789", text: `Our test token address is ${CA}.`, createdAt: sourceOccurredAt,
      author: { id: "1236460732486692864", screen_name: "GeniusTerminal" } },
    identity: { handle: "GeniusTerminal", userId: "1236460732486692864", verified: true, verification: "fxtwitter_numeric_id+official_x_oembed" },
    token: { address: CA, classification: "official_mentioned" },
  };
}

test("Genius is an explicit opt-in lane without widening focus3", () => {
  for (const event of [documentEvent(), chainEvent(), xEvent()]) {
    assert.equal(isStrictGeniusEvent(event), true);
    assert.equal(isRelevantAlert(event), true);
    assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3", geniusMonitorEnabled: true }, event), true);
    assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3", geniusMonitorEnabled: false }, event), false);
    assert.equal(isMonitoringSourceEnabled({ monitorScope: "all" }, event), false);
    assert.deepEqual(focusNoveltyKeys(event), []);
    assert.equal(alertDeliveryDisposition(event).reason, "genius_official_watch_only");
  }
  assert.equal(isThreePlatformSource({ id: "geniusfun", name: "Genius.fun" }), false);
  assert.equal(claimsGeniusSource({ platform: "geniusfun" }), true);
  assert.equal(isMonitoringSourceEnabled({ geniusMonitorEnabled: true }, { platform: "geniusfun" }), false);
});

test("Genius document gate binds exact source, hashes and event identity", () => {
  const valid = documentEvent();
  const invalid = [
    { sourceUrl: "https://genius.fun.evil.example/contracts/manifest.json" },
    { sourceUrl: "https://evil.example/https://genius.fun/contracts/manifest.json" },
    { sourceUrl: "https://genius.fun/contracts/manifest.json?redirect=evil" },
    { sourceId: "genius_fake" }, { kind: "official_token_launch" }, { eventKey: "genius:fake" },
    { chainId: 97 }, { sourceTrust: "unverified" }, { observedAt: "invalid" }, { changes: [] },
    { evidence: { ...valid.evidence, beforeHash: valid.evidence.afterHash } },
    { evidence: { ...valid.evidence, sourceUrl: "https://evil.example" } },
    { source: { id: "genius_manifest", url: "https://evil.example" } }, { autoTradeEligible: true },
  ];
  for (const mutation of invalid) assert.equal(isStrictGeniusEvent({ ...valid, ...mutation }), false, JSON.stringify(mutation));
  const part = { ...valid, partIndex: 1, eventKey: `${valid.eventKey}:1` };
  assert.equal(isStrictGeniusEvent(part), true);
  assert.equal(isStrictGeniusEvent({ ...part, partIndex: 0 }), false);
  assert.equal(isStrictGeniusEvent({ ...part, partIndex: "1" }), false);
});

test("Genius chain gate rejects community tokens, incorrect fingerprints and non-independent readers", () => {
  const event = chainEvent();
  for (const mutation of [
    { factory: CA }, { blockNumber: "12345678" }, { logIndex: -1 }, { sourceOccurredAt: undefined },
    { token: { ...event.token, deployer: CA } }, { token: { ...event.token, classification: "official_test" } },
    { officialTestToken: true },
    { evidence: { ...event.evidence, providers: ["https://rpc.example/a", "https://rpc.example/b"] } },
    { evidence: { ...event.evidence, runtimeCodeHash: TX } },
    { evidence: { ...event.evidence, eventName: "Transfer" } },
    { evidence: { ...event.evidence, args: { ...event.evidence.args, token: CURVE } } },
    { evidence: { ...event.evidence, args: { token: CA } } },
  ]) assert.equal(isStrictGeniusEvent({ ...event, ...mutation }), false, JSON.stringify(mutation));
  const lifecycle = { ...event, kind: "official_token_lifecycle", evidence: { ...event.evidence, eventName: "PoolGraduated", args: { token: CA } } };
  assert.equal(isStrictGeniusEvent(lifecycle), true);
  assert.equal(isStrictGeniusEvent({ ...lifecycle, kind: "factory_config" }), false);
  const factory = { ...event, kind: "factory_config", token: undefined,
    evidence: { ...event.evidence, eventName: "LaunchEnabledUpdated", args: { enabled: false } } };
  assert.equal(isStrictGeniusEvent(factory), true);
});

test("Genius X statements and denials never promote mentioned tokens to official tests", () => {
  const event = xEvent();
  for (const mutation of [
    { identity: { ...event.identity, userId: "999999999999999999" } },
    { identity: { ...event.identity, verification: "profile_name" } },
    { tweet: { ...event.tweet, author: { id: "1", screen_name: "GeniusTerminal" } } },
    { sourceUrl: "https://x.com/Impersonator/status/1234567890123456789" },
    { token: { ...event.token, classification: "official_test" } }, { officialToken: true },
    { sourceOccurredAt: "2020-01-01T00:00:00Z" },
  ]) assert.equal(isStrictGeniusEvent({ ...event, ...mutation }), false);
  const denial = { ...event, tweet: { ...event.tweet, text: `We did not issue ${CA}. This is not our token.` } };
  assert.equal(isStrictGeniusEvent(denial), true, "authenticated denial remains monitorable as an announcement");
  assert.match(renderGeniusAlertLines(denial, "zh").join("\n"), /官方否认关联/);
  const mentioned = { ...event, token: undefined, mentionedAddresses: [CA] };
  assert.equal(isStrictGeniusEvent(mentioned), true);
  assert.ok(renderGeniusAlertLines(mentioned, "zh").join("\n").includes(`CA (1): ${CA}`));
  assert.match(renderGeniusAlertLines(mentioned, "zh").join("\n"), /代币归属未确认/);
  assert.match(renderGeniusAlertLines(mentioned, "zh").join("\n"), /链未核实/);
  assert.equal(isStrictGeniusEvent({ ...mentioned, mentionedAddresses: [CURVE] }), false);
});

test("Genius history cards distinguish original event time from discovery and are never strong", async () => {
  const event = { ...chainEvent(), historical: true, sourceOccurredAt: "2026-01-01T00:00:00Z", strong: true };
  assert.equal(isStrongAlert(event), false);
  const fresh = classifyAlertFreshness({}, event, Date.now());
  assert.equal(fresh.basis, "historical_record_observedAt");
  assert.equal(fresh.decision, "realtime");
  const bundle = await buildBilingualAlertBundle({ alertChineseTranslationEnabled: false }, event, "");
  const rendered = renderBilingualTelegramText(bundle, false);
  assert.match(rendered, /历史记录补发现，非刚发行/);
  assert.match(rendered, /Historical record discovered; not a new launch/);
  assert.match(rendered, /2026-01-01/);
  for (const block of [bundle.zh.text, bundle.en.text]) {
    assert.ok(block.includes(CA));
    assert.ok(block.includes(event.sourceUrl));
    assert.equal(block.split("\n").length, 6);
  }
  assert.doesNotMatch(rendered, /风险提示|Risk:|入场|止损/);
  assert.ok(rendered.length < 3_800);
});

test("Genius compact X narrative never splits a contract literal and remains bounded", () => {
  const event = xEvent();
  event.tweet.text = `${"Alpha ".repeat(68)}${CA} ${"More ".repeat(1000)}`;
  const narrative = geniusAlertNarrative(event);
  assert.ok(narrative.length < 500);
  assert.ok(!narrative.includes("0x") || narrative.includes(CA));
  assert.ok(renderGeniusAlertLines(event).join("\n").includes(CA));
});

test("Genius two-field document batches retain both changes within the bilingual card contract", async () => {
  const event = documentEvent();
  event.changes = [{ field: "factory", before: CA, after: CURVE }, { field: "launchEnabled", before: false, after: true }];
  const source = renderGeniusAlertLines(event, "zh").join("\n");
  const bundle = await buildBilingualAlertBundle({ alertChineseTranslationEnabled: false }, event, source);
  const rendered = renderBilingualTelegramText(bundle, false);
  for (const block of [bundle.zh.text, bundle.en.text]) {
    assert.ok(block.includes(CA)); assert.ok(block.includes(CURVE));
    assert.doesNotMatch(block, /launchEnabled: false → true/);
  }
  assert.match(bundle.zh.text, /允许新币发行（清单配置）/);
  assert.match(bundle.en.text, /new token launches enabled in manifest/);
  assert.ok(rendered.length <= 3_800);
  assert.ok(rendered.split("\n").length <= 18);
  assert.ok(rendered.split("\n").every(line => line.length <= 240));
});

test("long Genius documentation removals retain the removal endpoint", () => {
  const event = documentEvent();
  event.changes = [{ field: "document", before: "Previous documentation statement. ".repeat(40), after: null }];
  const lines = renderGeniusAlertLines(event, "en");
  assert.match(lines[1], /Removed source text: Previous documentation statement/);
  assert.match(renderGeniusAlertLines(event, "zh")[1], /文档移除原文/);
  assert.ok(lines[1].length <= 240);
});

test("Genius complete new-stack summary explains the configuration without inventing effective charges", async () => {
  const event = documentEvent();
  event.changes = [{ field: "stacks.bnb-mainnet-m4.2", before: null, after: {
    status: "active", factory: { address: CA, bytecodeHash: TX },
    foundationFees: { snipeTaxStartBps: 9900, snipeTaxSeconds: 15, baseFeeBps: 200 },
    buildHash: "a".repeat(64),
  } }];
  const original = structuredClone(event);
  let translations = 0;
  const bundle = await buildBilingualAlertBundle({ alertTranslationFetchImpl: async () => { translations++; throw new Error("must not translate structured facts"); } }, event, "");
  const rendered = renderBilingualTelegramText(bundle, false);
  assert.equal(translations, 0);
  assert.deepEqual(event, original);
  assert.match(bundle.zh.text, /新发币工厂合约 Factory.*待链上核实/);
  assert.match(bundle.zh.text, /工厂合约（不是代币）/);
  assert.match(bundle.zh.text, /官方清单标记为“新版启用”/);
  assert.match(bundle.zh.text, /99%.*不是实收税率/);
  assert.match(bundle.zh.text, /15 秒/);
  assert.match(bundle.zh.text, /基础费率参数 2%/);
  assert.match(bundle.en.text, /99%.*not the effective charge/);
  assert.match(bundle.en.text, /15 seconds/);
  assert.match(bundle.en.text, /base fee parameter 2%/);
  for (const block of [bundle.zh.text, bundle.en.text]) {
    assert.ok(block.includes(CA)); assert.ok(block.includes("bnb-mainnet-m4.2"));
    assert.doesNotMatch(block, /97%|101%|9900|200bps|bytecodeHash|buildHash/);
    assert.ok(!block.includes(TX));
  }
  assert.ok(rendered.length <= 3800);
  assert.ok(rendered.split("\n").length <= 18);
  assert.ok(rendered.split("\n").every(line => line.length <= 240));
});

test("Genius semantic prose requires explicit official evidence for effective fee and new-token scope", () => {
  const event = documentEvent();
  event.sourceId = "genius_about";
  event.changes = [{ field: "document", before: null, after: "The launch fee is capped at 97%. This applies only to new tokens. Existing tokens remain unchanged." }];
  const summary = summarizeGeniusEvent(event);
  assert.match(summary.facts[0].zh, /仅适用于新发行代币/);
  assert.match(summary.facts[1].zh, /旧币继续使用原有机制/);
  assert.ok(summary.facts[2].rawText, "a bare percentage with no exemption/window context stays observed prose");
  for (const [sourceId, prose] of [
    ["genius_manifest", "The launch fee is capped at 97%."],
    ["genius_about", "The launch fee is not capped at 97%."],
    ["genius_about", "A hypothetical launch fee could reach 97%."],
    ["genius_about", "97% of users asked about launch fees."],
    ["genius_about", "Existing tokens remain at risk."],
  ]) {
    const item = summarizeGeniusEvent({ ...event, sourceId, changes: [{ field: "document", before: null, after: prose }] });
    assert.ok(item.facts.every(fact => fact.rawText), prose);
    assert.match(item.facts[0].zh, /文档新增原文/);
  }
});

test("Genius technical-only suppression is leaf-based and conservatively retains unknown evidence", () => {
  const change = (field, after, before = null) => ({ field, before, after });
  for (const item of [
    change("buildHash", "a".repeat(64)), change("factory.bytecodeHash", TX),
    change("release.version", "4.2"), change("document", "Build hash: abcdef0123456789"),
    change("document", "Snapshot ID: 2026-09-20T12:00:00Z"),
    change("document", "Source commit f5fbd1fde93cbd7dbe44e3276cafbea9875f9996"),
    change("document", "ABI version 4.2.0"),
    change("release.abiChecksums.GeniusLaunchFactory", TX),
  ]) {
    assert.equal(isGeniusTechnicalChange(item), true, item.field);
    assert.equal(hasGeniusBusinessChanges([item]), false, item.field);
  }
  for (const item of [
    change("snapshot", { permissions: { launchEnabled: true } }),
    change("build", { launchFee: 200 }), change("newDeployment", {}), change("newDeployment", []),
    change("document", `Build hash: ${CA}`), change("hash", CA),
    change("document", "Build hash: abcdef0123456789. Launch fee changed to 2%."),
    change("document", "Snapshot announcement: new fee routing is enabled."),
  ]) assert.equal(hasGeniusBusinessChanges([item]), true, JSON.stringify(item));
  const metadata = Object.fromEntries(Array.from({ length: 10001 }, (_, index) => [`metadata${index}`, { hash: "a".repeat(64) }]));
  metadata.zzLateBusiness = { fee: 200 };
  assert.equal(hasGeniusBusinessChanges([change("snapshot", metadata)]), true, "truncation can never hide a late business leaf");
});

test("Genius new-stack economics and scope outrank duplicate initial settings and old-stack status", async () => {
  const event = documentEvent();
  event.changes = [
    { field: "initialConfig.access.launchEnabledAtDeploy", before: true, after: false },
    ...["initialConfig", "initialConfig.foundationFees"].flatMap(field => [
      { field: `${field}.snipeTaxSeconds`, before: 0, after: 15 },
      { field: `${field}.snipeTaxStartBps`, before: 0, after: 9900 },
    ]),
    { field: "stacks.bnb-mainnet-m4.1.creationPolicy", before: null, after: { launchEnabled: true, whitelistedLaunchers: [] } },
    { field: "stacks.bnb-mainnet-m4.1.status", before: "active", after: "legacy" },
    { field: "stacks.bnb-mainnet-m4.2", before: null, after: { status: "active", contracts: { factory: { address: CA } },
      foundationFees: { destinationBps: 100, platformBps: 50, creatorBps: 25, buybackBps: 25, creatorTaxBps: 0,
        snipeTaxStartBps: 9900, snipeTaxSeconds: 15, updatesApplyTo: "new-launches-only" } } },
  ];
  const bundle = await buildBilingualAlertBundle({ alertChineseTranslationEnabled: false }, event, "");
  assert.match(bundle.zh.text, /新发币工厂合约 Factory/);
  assert.match(bundle.zh.text, /99%.*不是实收税率.*15 秒/);
  assert.match(bundle.zh.text, /仅适用于之后发行的新币/);
  assert.match(bundle.en.text, /99%.*not the effective charge.*15 seconds/);
  assert.match(bundle.en.text, /new launches only/);
  assert.doesNotMatch(bundle.zh.text, /当前.*关闭|暂停新币|97%/);
  const initialOnly = summarizeGeniusEvent({ ...event, changes: [event.changes[0]] });
  assert.match(initialOnly.facts[0].zh, /部署时.*默认关闭；不是当前开关状态/);
});

test("Genius observed launch-window explanation preserves fees, timing, exemptions, sells and old-token scope", async () => {
  const event = documentEvent();
  event.kind = "docs_update"; event.sourceId = "genius_about"; event.sourceUrl = "https://genius.fun/about";
  event.evidence.sourceUrl = event.sourceUrl;
  event.eventKey = `genius:genius_about:${event.evidence.beforeHash}:${event.evidence.afterHash}`;
  const prose = "For the first 15 seconds of a launch, every buy that is not exempt pays a launch-window fee on the amount it spends, on top of the ordinary trading fee. It opens at 97% of the amount spent and halves fourteen times across the window, so nothing is charged from the end of the window on. Sells are never charged it. The protocol owner can change the opening rate and the length of the window for launches created afterwards, never for a launch already created, and launches created before this fee took effect never carry it.";
  event.changes = [{ field: "document", before: null, after: prose }];
  const bundle = await buildBilingualAlertBundle({ alertChineseTranslationEnabled: false }, event, "");
  assert.match(bundle.zh.text, /前 15 秒.*非豁免买入.*97%.*不含普通交易费/);
  assert.match(bundle.zh.text, /减半 14 次.*15 秒后归零.*卖出不收/);
  assert.match(bundle.zh.text, /后续新币.*已发行币不追改.*旧币不收/);
  assert.match(bundle.en.text, /15 seconds.*non-exempt.*97%.*excluding ordinary/);
  assert.doesNotMatch(bundle.zh.text, /译文暂缺|实收费为|总手续费.*97%/);
  const wrongSource = summarizeGeniusEvent({ ...event, sourceId: "genius_manifest" });
  assert.ok(wrongSource.facts.every(item => item.rawText));
  const rendered = renderBilingualTelegramText(bundle, false);
  assert.ok(rendered.split("\n").length <= 18);
  assert.ok(rendered.split("\n").every(line => line.length <= 240));
});

test("Genius unknown observed prose remains honest when translation is unavailable", async () => {
  const event = documentEvent();
  event.changes = [{ field: "document", before: null, after: "A future deployment may change the fee recipient." }];
  const bundle = await buildBilingualAlertBundle({ alertChineseTranslationEnabled: false }, event, "");
  assert.match(bundle.zh.text, /文档新增原文/);
  assert.match(bundle.zh.text, /译文暂缺/);
  assert.match(bundle.en.text, /Added source text: A future deployment may change the fee recipient/);
  assert.doesNotMatch(bundle.en.text, /translation unavailable/);
  assert.doesNotMatch(bundle.zh.text, /新功能上线|已部署|已转交/);
});

test("Genius integration changes prioritize the concrete Factory replacement and fee limits", () => {
  const event = documentEvent(); event.sourceId = "genius_integrate";
  event.changes = [
    { field: "document", before: "Stack bnb-mainnet-m4.1", after: null },
    { field: "document", before: null, after: "Index from block 122874828" },
    { field: "document", before: `GeniusLaunchFactory ${CA}`, after: null },
    { field: "document", before: null, after: `GeniusLaunchFactory ${CURVE}` },
    { field: "document", before: null, after: "Creator tax · snipe tax Factory limits in basis points: the most a creator may charge, and the rate the launch window opens at. Each launch freezes both; zero means it never applies 0 · 9900" },
  ];
  const summary = summarizeGeniusEvent(event);
  assert.match(summary.facts[0].zh, /替换发币工厂合约/);
  assert.match(summary.facts[1].zh, /上限 0%.*起始参数 99%.*不等同实收费/);
  assert.deepEqual(summary.addresses, [CA, CURVE]);
  const rendered = renderGeniusAlertLines(event).join("\n");
  assert.match(rendered, /工厂合约（不是代币）/);
  assert.doesNotMatch(rendered, /Index from block|Stack bnb/);
});

test("Genius disabled/mismatched sources produce no buttons", () => {
  assert.equal(telegramButtons(chainEvent()).inline_keyboard[0][0].url, `https://bscscan.com/tx/${TX}`);
  assert.deepEqual(telegramButtons({ ...chainEvent(), sourceUrl: "https://evil.example" }), { inline_keyboard: [] });
});

async function setup(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "genius-alert-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "info", () => {});
  return { dataDir, blockedContracts: new Set(), telegramToken: "test-token", telegramChatId: "1234",
    telegramStrongAlerts: true, monitorScope: "focus3", geniusMonitorEnabled: true,
    alertChineseTranslationEnabled: false, webhookUrl: "" };
}

test("Genius durable delivery deduplicates exact IDs but preserves distinct official announcements", async (t) => {
  const config = await setup(t);
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) };
  });
  const first = { ...xEvent(), canonicalSignalIds: ["flap:concept:launch"], canonicalSignalId: "flap:concept:launch" };
  const original = structuredClone(first);
  assert.equal((await sendAlerts(config, first)).status, "delivered");
  assert.equal((await sendAlerts(config, first)).status, "delivered");
  assert.equal(payloads.length, 1);
  const second = xEvent();
  second.tweet.id = "1234567890123456790";
  second.sourceUrl = `https://x.com/GeniusTerminal/status/${second.tweet.id}`;
  second.eventKey = `genius:x:${second.identity.userId}:${second.tweet.id}`;
  assert.equal((await sendAlerts(config, second)).status, "delivered");
  assert.equal(payloads.length, 2);
  assert.deepEqual(first, original);
  const outbox = JSON.parse(await fs.readFile(path.join(config.dataDir, "alert-outbox.json"), "utf8"));
  const saved = outbox.events[first.eventKey];
  assert.deepEqual(saved.event.canonicalSignalIds, [first.eventKey]);
  assert.equal(saved.event.tradingPriority, undefined);
  assert.equal(saved.renderBundle.format, "telegram_zh_en_genius_v2");
  assert.match(payloads[0].text, /🇨🇳 中文/);
  assert.match(payloads[0].text, /🇬🇧 English/);
});

test("Genius durable retry reuses its persisted bilingual rendering", async (t) => {
  const config = await setup(t);
  let fail = true;
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: !fail, status: fail ? 500 : 200,
      text: async () => JSON.stringify(fail ? { ok: false } : { ok: true, result: { message_id: 44 } }) };
  });
  const event = documentEvent();
  assert.equal((await sendAlerts(config, event)).status, "queued");
  const filename = path.join(config.dataDir, "alert-outbox.json");
  const state = JSON.parse(await fs.readFile(filename, "utf8"));
  const savedBundle = structuredClone(state.events[event.eventKey].renderBundle);
  state.events[event.eventKey].destinations.telegram.nextAttemptAt = "2000-01-01T00:00:00Z";
  await fs.writeFile(filename, JSON.stringify(state));
  fail = false;
  await drainAlertOutbox(config);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].text, payloads[1].text);
  const final = JSON.parse(await fs.readFile(filename, "utf8")).events[event.eventKey];
  assert.deepEqual(final.renderBundle, savedBundle);
  assert.equal(final.status, "delivered");
  assert.equal(final.event.tradingPriority, undefined);
});

test("Genius legacy v1 pending bundle is retried byte-for-byte after the v2 template upgrade", async (t) => {
  const config = await setup(t);
  let fail = true;
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: !fail, status: fail ? 500 : 200,
      text: async () => JSON.stringify(fail ? { ok: false } : { ok: true, result: { message_id: 45 } }) };
  });
  const event = documentEvent();
  assert.equal((await sendAlerts(config, event)).status, "queued");
  const filename = path.join(config.dataDir, "alert-outbox.json");
  const state = JSON.parse(await fs.readFile(filename, "utf8"));
  const entry = state.events[event.eventKey];
  entry.renderBundle.format = "telegram_zh_en_genius_v1";
  entry.renderBundle.zh.text = "旧版已保存原文，不应被重译";
  entry.renderBundle.en.text = "Persisted legacy source; do not translate again";
  const saved = structuredClone(entry.renderBundle);
  entry.destinations.telegram.nextAttemptAt = "2000-01-01T00:00:00Z";
  await fs.writeFile(filename, JSON.stringify(state));
  fail = false; await drainAlertOutbox(config);
  const final = JSON.parse(await fs.readFile(filename, "utf8")).events[event.eventKey];
  assert.deepEqual(final.renderBundle, saved);
  assert.match(payloads.at(-1).text, /旧版已保存原文，不应被重译/);
  assert.equal(final.status, "delivered");
});

test("Genius old X posts cannot bypass freshness with producer-supplied freshness metadata", async (t) => {
  const config = await setup(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("should not send"); });
  const event = xEvent();
  event.sourceOccurredAt = "2020-01-01T00:00:00Z";
  event.tweet.createdAt = event.sourceOccurredAt;
  event.freshness = { version: 1, decision: "realtime" };
  const result = await sendAlerts(config, event);
  assert.equal(result.status, "suppressed");
  assert.equal(calls, 0);
});

function chainDeliveryFixture() {
  const event = chainEvent();
  event.sourceOccurredAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const range = { fromBlock: event.blockNumber, toBlock: event.blockNumber,
    anchor: { number: event.blockNumber, hash: event.blockHash },
    events: [{ address: GENIUS_FACTORY, name: event.evidence.eventName, args: structuredClone(event.evidence.args),
      transactionHash: event.transactionHash, logIndex: event.logIndex, blockNumber: event.blockNumber,
      blockHash: event.blockHash, blockTimestamp: Date.parse(event.sourceOccurredAt) / 1000 }] };
  return { event, range };
}

test("Genius delivery verification uses configured strict readers and checks the exact canonical log", async () => {
  const { event, range } = chainDeliveryFixture();
  let stopped = 0, options;
  const config = { geniusRpcUrls: ["https://configured-a.example", "https://configured-b.example"],
    geniusLogRpcUrls: ["https://log-a.example", "https://log-b.example"], geniusDeliveryReaderFactory: opts => {
      options = opts;
      return { readRange: async (from, to) => { assert.equal(from, event.blockNumber); assert.equal(to, from); return range; }, stop: () => { stopped += 1; } };
    } };
  await assertGeniusChainDeliveryCanonical(config, event);
  assert.deepEqual(options.rpcUrls, config.geniusRpcUrls);
  assert.deepEqual(options.logRpcUrls, config.geniusLogRpcUrls);
  assert.equal(options.confirmations, 15);
  assert.ok(options.operationTimeoutMs <= 15_000);
  assert.equal(stopped, 1);
  for (const mutation of [
    current => { current.anchor.hash = TX; }, current => { current.events = []; },
    current => { current.events[0].transactionHash = BLOCK; }, current => { current.events[0].logIndex += 1; },
    current => { current.events[0].args.launchConfigId = "2"; }, current => { current.events[0].blockTimestamp -= 1; },
    current => { current.events[0].address = CA; }, current => { current.events[0].name = "PoolGraduated"; },
  ]) {
    const changed = structuredClone(range); mutation(changed);
    await assert.rejects(assertGeniusChainDeliveryCanonical({ geniusDeliveryReaderFactory: () => ({
      readRange: async () => changed, stop: () => { stopped += 1; },
    }) }, event), /GENIUS_DELIVERY_REORG/);
  }
  assert.equal(stopped, 9);
});

test("Genius delivery verification stops readers on upstream failure and on a hard timeout", async () => {
  const { event } = chainDeliveryFixture();
  let stopped = 0;
  await assert.rejects(assertGeniusChainDeliveryCanonical({ geniusDeliveryReaderFactory: () => ({
    readRange: async () => { throw new Error("RPC temporarily unavailable"); }, stop: () => { stopped += 1; },
  }) }, event), /RPC temporarily unavailable/);
  assert.equal(stopped, 1);
  await assert.rejects(assertGeniusChainDeliveryCanonical({ geniusDeliveryVerificationTimeoutMs: 15,
    geniusDeliveryReaderFactory: () => ({ readRange: () => new Promise(() => {}), stop: () => { stopped += 1; } }),
  }, event), /GENIUS_DELIVERY_TIMEOUT/);
  assert.ok(stopped >= 2);
});

test("Genius documents and X delivery do not require chain verification", async () => {
  for (const event of [documentEvent(), xEvent()]) {
    await assertGeniusChainDeliveryCanonical({ geniusDeliveryReaderFactory: () => { throw new Error("must not create reader"); } }, event);
  }
});

test("Genius generic outbox retry cannot send an orphaned chain card and can recover later", async (t) => {
  const config = await setup(t);
  const { event, range } = chainDeliveryFixture();
  let orphaned = false, failTelegram = true, reads = 0, stopped = 0;
  const payloads = [];
  config.geniusDeliveryReaderFactory = () => ({
    readRange: async () => { reads += 1; return orphaned ? { ...range, events: [] } : range; },
    stop: () => { stopped += 1; },
  });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: !failTelegram, status: failTelegram ? 503 : 200,
      text: async () => JSON.stringify(failTelegram ? { ok: false } : { ok: true, result: { message_id: 55 } }) };
  });
  const first = await sendAlerts(config, event);
  assert.equal(first.status, "queued");
  assert.equal(payloads.length, 1);
  const filename = path.join(config.dataDir, "alert-outbox.json");
  const due = async () => {
    const state = JSON.parse(await fs.readFile(filename, "utf8"));
    state.events[event.eventKey].destinations.telegram.nextAttemptAt = "2000-01-01T00:00:00Z";
    await fs.writeFile(filename, JSON.stringify(state));
  };
  const initial = JSON.parse(await fs.readFile(filename, "utf8")).events[event.eventKey];
  orphaned = true; failTelegram = false; await due();
  await drainAlertOutbox(config);
  assert.equal(payloads.length, 1, "orphaned queued event never reaches Telegram");
  const held = JSON.parse(await fs.readFile(filename, "utf8")).events[event.eventKey];
  assert.equal(held.status, "pending");
  assert.equal(held.destinations.telegram.status, "failed");
  assert.match(held.destinations.telegram.lastError, /GENIUS_DELIVERY_REORG/);
  assert.equal(held.destinations.telegram.leaseUntil, null);
  assert.ok(held.destinations.telegram.nextAttemptAt);
  assert.equal(held.deliveredAt, null);
  assert.deepEqual(held.renderBundle, initial.renderBundle);
  orphaned = false; await due(); await drainAlertOutbox(config);
  const final = JSON.parse(await fs.readFile(filename, "utf8")).events[event.eventKey];
  assert.equal(final.status, "delivered");
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].text, payloads[1].text);
  assert.equal(reads, 3); assert.equal(stopped, 3);
});

test("unavailable Genius canonical verification holds every destination without external sends", async (t) => {
  const config = await setup(t);
  config.webhookUrl = "https://hook.example/monitor";
  const { event } = chainDeliveryFixture();
  let sends = 0, stopped = 0;
  config.geniusDeliveryReaderFactory = () => ({ readRange: async () => { throw new Error("temporary RPC timeout"); }, stop: () => { stopped += 1; } });
  t.mock.method(globalThis, "fetch", async () => { sends += 1; throw new Error("unexpected external delivery"); });
  assert.equal((await sendAlerts(config, event)).status, "queued");
  const entry = JSON.parse(await fs.readFile(path.join(config.dataDir, "alert-outbox.json"), "utf8")).events[event.eventKey];
  assert.equal(entry.status, "pending");
  for (const name of ["telegram", "webhook"]) {
    assert.equal(entry.destinations[name].status, "failed");
    assert.match(entry.destinations[name].lastError, /temporary RPC timeout/);
    assert.ok(entry.destinations[name].nextAttemptAt);
    assert.equal(entry.destinations[name].leaseUntil, null);
  }
  assert.equal(stopped, 1); assert.equal(sends, 0);
});
