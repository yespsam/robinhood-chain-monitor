import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GMGN_FLOW_CHAINS, evaluateGmgnFlowSignal, isGmgnFlowEvent } from "../src/gmgn-flow-signal.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";
import { alertDeliveryDisposition, classifyAlertFreshness, drainAlertOutbox, focusNoveltyKeys, isRelevantAlert, isStrongAlert, sendAlerts, telegramButtons } from "../src/alerts.js";
import { buildBilingualAlertBundle, renderBilingualTelegramText } from "../src/bilingual-alert-renderer.js";

const CA = `0x${"1".repeat(40)}`;
function fixture(chain = "bsc", now = Date.now()) {
  const end = Math.floor(now / 60_000) * 60_000;
  const tokenAddress = chain === "sol" ? "So11111111111111111111111111111111111111112" : CA;
  const wallets = Array.from({ length: 6 }, (_, i) => chain === "sol" ? `${"A".repeat(31)}${i + 1}` : `0x${String(i + 2).repeat(40)}`);
  const candles = Array.from({ length: 20 }, (_, i) => ({ time: end - (20 - i) * 60_000, volumeUsd: i >= 15 ? 12_000 : 1_000 }));
  const profiles = Object.fromEntries(wallets.slice(0, 5).map(wallet => [wallet, Object.fromEntries(["7d", "30d"].map(period => [period, {
    chain, wallet, period, checkedAt: new Date(now).toISOString(), realizedProfitUsd: 20_000, realizedRoi: 0.5, winRate: 0.75,
    tokenCount: 150, buyCount: 200, sellCount: 190, tags: [], createdAt: Math.floor((now - 60 * 86_400_000) / 1000),
    lastTradeAt: Math.floor(now / 1000), createdTokenCount: 0,
  }]))]));
  const trades = wallets.map((wallet, i) => ({ chain, wallet, tokenAddress, hash: chain === "sol" ? `${"A".repeat(87)}${i + 1}` : `0x${String(i + 2).repeat(64)}`,
    side: "buy", amountUsd: 2_000, at: end - 60_000, tags: i >= 3 ? ["fomo"] : [] }));
  const evidence = { version: 1, provider: "gmgn-cli", chain, tokenAddress, candles, trades, profiles };
  const result = evaluateGmgnFlowSignal({ ...evidence, nowMs: now });
  assert.ok(result);
  return { type: "gmgn_flow_surge", platform: "gmgn", chain: GMGN_FLOW_CHAINS[chain], token: { address: tokenAddress, symbol: "FLOW", name: "Flow Token" },
    source: { id: "gmgn_flow_observed", trust: "provider_reported", url: `https://gmgn.ai/${chain}/token/${tokenAddress}` },
    observedAt: new Date(now).toISOString(), sourceOccurredAt: result.signal.windowEndAt,
    eventKey: `gmgn-flow:${chain}:${tokenAddress}:${end}`, ...result, evidence,
    narrative: { status: "unverified", text: "未找到可按链和 CA 绑定的叙事出处", sourceUrl: null, sourceAt: null, chain, tokenAddress } };
}

test("GMGN flow is an independent opt-in immediate observation lane on every qualified chain", () => {
  for (const chain of Object.keys(GMGN_FLOW_CHAINS)) {
    const event = fixture(chain);
    assert.equal(isGmgnFlowEvent(event), true);
    assert.equal(isRelevantAlert(event), true);
    assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3", gmgnFlowMonitorEnabled: true }, event), true);
    assert.equal(isMonitoringSourceEnabled({ monitorScope: "all", gmgnFlowMonitorEnabled: false }, event), false);
    assert.equal(alertDeliveryDisposition(event).reason, "gmgn_flow_watch_only");
    assert.equal(isStrongAlert(event), false); assert.deepEqual(focusNoveltyKeys(event), []);
  }
});

test("forged aggregate numbers and source URLs never pass gates or produce buttons", () => {
  const event = fixture();
  for (const invalid of [{ ...event, signal: { ...event.signal, highProfitCount: 500 } }, { ...event, source: { ...event.source, url: "https://evil.example" } }]) {
    assert.equal(isRelevantAlert(invalid), false); assert.deepEqual(telegramButtons(invalid), { inline_keyboard: [] });
    assert.equal(isMonitoringSourceEnabled({ gmgnFlowMonitorEnabled: true }, invalid), false);
  }
  assert.equal(isMonitoringSourceEnabled({ gmgnFlowMonitorEnabled: true }, { type: "other", source: { id: "gmgn_flow_observed" } }), false);
});

test("GMGN card preserves dual wallet counts, overlap, CA, narrative status and no trading claim", async () => {
  const event = fixture("sol"), original = structuredClone(event);
  const bundle = await buildBilingualAlertBundle({ alertChineseTranslationEnabled: false }, event, "");
  const text = renderBilingualTelegramText(bundle);
  assert.equal(bundle.format, "telegram_zh_en_gmgn_flow_v1");
  assert.match(text, /高盈利 5 · FOMO 3 · 去重 6 \(重叠 2\)/u);
  assert.match(text, /high-profit 5 · FOMO 3 · unique 6 \(overlap 2\)/u);
  for (const block of [bundle.zh.text, bundle.en.text]) assert.ok(block.includes(event.token.address));
  assert.match(text, /Narrative \[Unverified\]/u); assert.match(text, /叙事 \[待核实\]/u);
  assert.ok(text.length < 3_800); assert.ok(text.split("\n").length <= 18);
  assert.doesNotMatch(text, /风险提示|Risk:|止损|自动买入|已链上确认/u);
  assert.deepEqual(event, original);
});

test("project description is visibly self-reported and untranslated narrative is explicitly marked", async () => {
  const event = fixture();
  event.narrative = { status: "project_claim", text: `AI agent games ${CA}`, sourceUrl: event.source.url, sourceAt: event.observedAt, chain: "bsc", tokenAddress: CA };
  const bundle = await buildBilingualAlertBundle({ alertChineseTranslationEnabled: false }, event, "");
  assert.match(bundle.zh.text, /项目自述，未独立证实/u); assert.match(bundle.zh.text, /译文暂缺/u);
  assert.match(bundle.en.text, /Project claim; unverified/u);
  assert.ok(bundle.zh.text.includes(CA)); assert.ok(bundle.en.text.includes(CA));
});

test("source-based freshness is fixed at ten minutes realtime and fifteen minutes maximum", () => {
  const event = fixture(), sourceMs = Date.parse(event.sourceOccurredAt);
  const config = { alertBscRealtimeMaxAgeMs: 99_000_000, alertTelegramDeliveryMaxAgeMs: 99_000_000 };
  assert.equal(classifyAlertFreshness(config, event, sourceMs + 600_000).decision, "realtime");
  assert.equal(classifyAlertFreshness(config, event, sourceMs + 600_001).decision, "late");
  assert.equal(classifyAlertFreshness(config, event, sourceMs + 900_001).decision, "suppress");
});

async function setup(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gmgn-flow-alert-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "info", () => {}); t.mock.method(console, "error", () => {});
  return { dataDir, blockedContracts: new Set(), telegramToken: "test-token", telegramChatId: "1234", telegramStrongAlerts: true,
    monitorScope: "focus3", gmgnFlowMonitorEnabled: true, alertBilingualEnabled: false, alertChineseTranslationEnabled: false, webhookUrl: "" };
}

test("GMGN sendAlerts persists one bilingual message, exact dedup and cross-chain independence", async t => {
  const config = await setup(t), payloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => { payloads.push(JSON.parse(options.body)); return { ok: true, status: 200,
    text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }) }; });
  const event = fixture(), original = structuredClone(event);
  assert.equal((await sendAlerts(config, event)).status, "delivered");
  assert.equal((await sendAlerts(config, event)).status, "delivered");
  assert.equal(payloads.length, 1);
  assert.equal((await sendAlerts(config, fixture("base"))).status, "delivered"); assert.equal(payloads.length, 2);
  assert.match(payloads[0].text, /🇨🇳 中文/u); assert.match(payloads[0].text, /🇬🇧 English/u);
  assert.deepEqual(event, original);
  const state = JSON.parse(await fs.readFile(path.join(config.dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(state.events[event.eventKey].renderBundle.format, "telegram_zh_en_gmgn_flow_v1");
  assert.equal(state.events[event.eventKey].event.tradingPriority, undefined);
  assert.deepEqual(state.events[event.eventKey].event.canonicalSignalIds, [event.eventKey]);
});

test("GMGN durable retry reuses bundle and bypasses trading-priority mutation", async t => {
  const config = await setup(t), payloads = [];
  let fail = true;
  t.mock.method(globalThis, "fetch", async (_url, options) => { payloads.push(JSON.parse(options.body)); return { ok: !fail, status: fail ? 500 : 200,
    text: async () => JSON.stringify(fail ? { ok: false } : { ok: true, result: { message_id: 123 } }) }; });
  const event = fixture(); assert.equal((await sendAlerts(config, event)).status, "queued");
  const file = path.join(config.dataDir, "alert-outbox.json"), state = JSON.parse(await fs.readFile(file, "utf8"));
  const bundle = structuredClone(state.events[event.eventKey].renderBundle);
  state.events[event.eventKey].destinations.telegram.nextAttemptAt = "2000-01-01T00:00:00Z";
  await fs.writeFile(file, JSON.stringify(state)); fail = false;
  await drainAlertOutbox(config);
  const final = JSON.parse(await fs.readFile(file, "utf8")).events[event.eventKey];
  assert.equal(payloads.length, 2); assert.equal(payloads[0].text, payloads[1].text); assert.deepEqual(final.renderBundle, bundle);
  assert.equal(final.event.tradingPriority, undefined); assert.equal(final.status, "delivered");
});

test("old source windows cannot be revived by forged freshness or a fresh observation timestamp", async t => {
  const config = await setup(t);
  let sends = 0; t.mock.method(globalThis, "fetch", async () => { sends += 1; throw new Error("unexpected network"); });
  const event = fixture("bsc", Date.now() - 1_000_000); event.freshness = { version: 1, decision: "realtime" };
  assert.equal((await sendAlerts(config, event)).status, "suppressed"); assert.equal(sends, 0);
});

test("GMGN pending Telegram delivery expires from source time after fifteen minutes", async t => {
  const config = await setup(t), event = fixture();
  let now = Date.now(), sends = 0;
  config.alertNow = () => now;
  config.alertTelegramDeliveryMaxAgeMs = 99_000_000;
  t.mock.method(globalThis, "fetch", async () => { sends += 1; return { ok: false, status: 500, text: async () => "unavailable" }; });
  assert.equal((await sendAlerts(config, event)).status, "queued");
  const file = path.join(config.dataDir, "alert-outbox.json"), state = JSON.parse(await fs.readFile(file, "utf8"));
  state.events[event.eventKey].destinations.telegram.nextAttemptAt = "2000-01-01T00:00:00Z";
  await fs.writeFile(file, JSON.stringify(state));
  now = Date.parse(event.sourceOccurredAt) + 900_001;
  await drainAlertOutbox(config);
  const final = JSON.parse(await fs.readFile(file, "utf8")).events[event.eventKey];
  assert.equal(sends, 1); assert.equal(final.status, "suppressed");
  assert.equal(final.destinations.telegram.status, "disabled");
});
