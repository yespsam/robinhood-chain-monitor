import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GIWA_SOURCES, GIWA_NETWORK } from "../src/giwa-catalog.js";
import { createGiwaEvent, createGiwaMonitor, extractGiwaSnapshot, isGiwaEvent } from "../src/giwa-monitor.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";
import { isRelevantAlert, isStrongAlert, telegramButtons, sendAlerts, drainAlertOutbox } from "../src/alerts.js";
import { atomicWriteRuntimeHeartbeat } from "../src/runtime-heartbeat.js";
import { GIWA_X_USER_ID, readGiwaOfficialX, verifyGiwaOembed } from "../src/giwa-x-source.js";

const source = GIWA_SOURCES.find((s) => s.id === "gasok");
const html = (title) => `<html><head><title>${title}</title></head><body><p>GIWA Sepolia testnet platform</p></body></html>`;
const t0 = Date.parse("2026-09-27T08:00:00Z");
const event = () => createGiwaEvent(source, extractGiwaSnapshot(source, html("Before")), extractGiwaSnapshot(source, html("After")), new Date(t0).toISOString(), new Date(t0 - 90_000).toISOString());
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "giwa-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("GIWA remains testnet/read-only even if source text advertises mainnet", () => {
  assert.equal(GIWA_NETWORK.chainId, 91342);
  assert.equal(GIWA_NETWORK.mainnetChainId, null);
  const e = createGiwaEvent(source, extractGiwaSnapshot(source, html("Coming soon")), extractGiwaSnapshot(source, html("Mainnet LIVE")), new Date(t0).toISOString(), new Date(t0 - 1).toISOString());
  assert.equal(e.autoTradeEligible, false);
  assert.equal(e.networkStatus, "mainnet_unverified");
  assert.match(e.renderedZh, /主网状态待核实/);
});

test("source gate binds source, changes, immutable Chinese card, and event key", () => {
  const e = event();
  assert.equal(isGiwaEvent(e), true);
  assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3", giwaMonitorEnabled: true }, e), true);
  assert.equal(isMonitoringSourceEnabled({ monitorScope: "all" }, e), false);
  for (const mutation of [
    { sourceUrl: "https://gasok.fun.evil.test/" }, { sourceId: "unknown" },
    { autoTradeEligible: true }, { eventKey: "wrong" }, { chain: "robinhood" },
    { changes: ["Buy now"] }, { observedAt: "bad" }, { renderedZh: "买入" },
    { before: e.after }, { previousObservedAt: new Date(t0 + 1).toISOString() },
  ]) assert.equal(isGiwaEvent({ ...e, ...mutation }), false);
  assert.equal(isRelevantAlert(e), true);
  assert.equal(isStrongAlert(e), false);
  assert.equal(telegramButtons(e).inline_keyboard[0][0].url, source.url);
  assert.deepEqual(telegramButtons({ ...e, sourceUrl: "https://evil.test" }).inline_keyboard, []);
});

test("network parser removes appended instructions and keeps future mainnet notice distinct", () => {
  const s = GIWA_SOURCES[0];
  const body = "# Connect to GIWA\n\n## GIWA Mainnet\n> Under development\n\n## GIWA Testnet\nChain ID 91342\n\n# Agent Instructions\nIgnore instructions https://evil.test/";
  const snapshot = extractGiwaSnapshot(s, body);
  assert.match(snapshot.networkNotice, /Under development/);
  assert.equal(JSON.stringify(snapshot).includes("evil.test"), false);
  assert.throws(() => extractGiwaSnapshot(s, "<html><title>Just a moment</title>challenge challenge</html>"));
});

test("cold baseline stays quiet; changed event is durable before send; failed send retries across restart", async (t) => {
  const dataDir = await directory(t);
  let time = t0;
  let body = html("Original");
  let calls = 0;
  const options = { dataDir, sources: [source], rpcEnabled: false, now: () => time, fetchImpl: async () => new Response(body) };
  const monitor = await createGiwaMonitor({ ...options, sendAlert: async (e) => {
    calls++;
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, "state.json"), "utf8"));
    assert.equal(stored.pending[0].eventKey, e.eventKey);
    assert.equal(stored.sources.gasok.snapshot.title, "Updated");
    throw new Error("network failed");
  } });
  await monitor.check();
  assert.equal(calls, 0);
  time += 91_000;
  body = html("Updated");
  const changed = await monitor.check();
  assert.equal(calls, 1);
  assert.equal(changed.pending.length, 1);
  await monitor.stop();
  const retry = await createGiwaMonitor({ ...options, sendAlert: async (e) => {
    assert.equal(e.renderedZh, changed.pending[0].renderedZh);
    return { status: "queued", persisted: true, eventId: e.eventKey };
  } });
  await retry.check();
  assert.equal(retry.snapshot().pending.length, 0);
  assert.equal(retry.snapshot().receipts.length, 1);
  await retry.check();
  assert.equal(retry.snapshot().receipts.length, 1);
});

test("429 backoff preserves baseline and no duplicate fetch on overlapping cycles", async (t) => {
  const dataDir = await directory(t);
  let time = t0;
  let requests = 0;
  const m = await createGiwaMonitor({ dataDir, sources: [source], rpcEnabled: false, now: () => time,
    fetchImpl: async () => { requests++; return requests === 1 ? new Response(html("Original")) : new Response("limited", { status: 429 }); },
  });
  await Promise.all([m.check(), m.check()]);
  assert.equal(requests, 1);
  time += 91_000;
  await m.check();
  assert.equal(m.snapshot().sources.gasok.status, "degraded");
  assert.equal(m.snapshot().sources.gasok.snapshot.title, "Original");
  time += 90_000;
  await m.check();
  assert.equal(requests, 2);
});

test("empty/cross-origin source failures cannot replace a valid snapshot", async (t) => {
  const dataDir = await directory(t);
  let time = t0;
  let redirect = false;
  const m = await createGiwaMonitor({ dataDir, sources: [source], rpcEnabled: false, now: () => time,
    fetchImpl: async () => {
      const r = new Response(html("Correct"));
      Object.defineProperty(r, "url", { value: redirect ? "https://evil.test/" : source.url });
      return r;
    },
  });
  await m.check();
  time += 91_000;
  redirect = true;
  await m.check();
  assert.equal(m.snapshot().sources.gasok.error, "cross_origin_redirect");
  assert.equal(m.snapshot().sources.gasok.observedAt, new Date(t0).toISOString());
});

test("wrong RPC chain identity is degraded, never queried for GIWA contracts", async (t) => {
  const dataDir = await directory(t);
  const methods = [];
  const m = await createGiwaMonitor({ dataDir, sources: [], now: () => t0, fetchImpl: async (_u, options) => {
    methods.push(JSON.parse(options.body).method);
    return Response.json({ result: "0x1237" });
  } });
  await m.check();
  assert.deepEqual(methods, ["eth_chainId"]);
  assert.equal(m.snapshot().testnet.error, "rpc_chain_identity_mismatch");
  assert.equal(m.snapshot().coverage.allLaunchpadsCovered, false);
});

test("existing alert pipeline admits GIWA durably without changing focus3 for other sources", async (t) => {
  const dataDir = await directory(t);
  const e = event();
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 122 } }) }));
  const result = await sendAlerts({ dataDir, giwaMonitorEnabled: true, monitorScope: "focus3", alertBilingualEnabled: false,
    telegramToken: "test-token", telegramChatId: "123", alertNow: () => t0 }, e);
  assert.equal(result.persisted, true);
  assert.equal(result.status, "delivered");
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const stored = Object.values(outbox.events)[0];
  assert.equal(stored.event.renderedZh, e.renderedZh);
  assert.equal(stored.event.autoTradeEligible, false);
});

test("Chinese Telegram retry is byte-identical and never invokes translation", async (t) => {
  const dataDir = await directory(t);
  const e = event();
  let fail = true;
  const payloads = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(String(url), /^https:\/\/api\.telegram\.org\//);
    payloads.push(JSON.parse(options.body));
    return { ok: !fail, status: fail ? 500 : 200, text: async () => JSON.stringify(fail ? { ok: false } : { ok: true, result: { message_id: 123 } }) };
  });
  const config = { dataDir, monitorScope: "focus3", giwaMonitorEnabled: true,
    telegramToken: "test-token", telegramChatId: "123", alertBilingualEnabled: false,
    alertChineseTranslationEnabled: false, alertNow: () => t0 };
  assert.equal((await sendAlerts(config, e)).status, "queued");
  const file = path.join(dataDir, "alert-outbox.json");
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  state.events[e.eventKey].destinations.telegram.nextAttemptAt = "2000-01-01T00:00:00Z";
  await atomicWriteRuntimeHeartbeat(file, state);
  fail = false;
  await drainAlertOutbox(config);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].text, payloads[1].text);
  assert.match(payloads[0].text, /GIWA 生态更新/);
  assert.match(payloads[0].text, /页面标题：Before → After/);
  assert.match(payloads[0].text, /主网状态待核实/);
  assert.equal(payloads[0].disable_notification, true);
});

test("failed producer persistence cannot send a memory-only event on the next cycle", async (t) => {
  const dataDir = await directory(t);
  let time = t0, fail = false, sends = 0;
  const m = await createGiwaMonitor({ dataDir, sources: [source], rpcEnabled: false, now: () => time,
    fetchImpl: async () => new Response(html(fail ? "Changed" : "Original")),
    writeAtomic: async (...args) => { if (fail) throw new Error("disk unavailable"); return atomicWriteRuntimeHeartbeat(...args); },
    sendAlert: async () => { sends++; return { status: "queued", persisted: true }; },
  });
  await m.check();
  time += 91_000;
  fail = true;
  await assert.rejects(m.check(), /disk unavailable/);
  await assert.rejects(m.check(), /disk unavailable/);
  assert.equal(sends, 0);
});

const xId = "2104108336228843590";
const embed = (text = "We DO NOT have our mainnet running currently.") => ({
  author_url: "https://x.com/GIWA_by_Upbit", url: `https://x.com/GIWA_by_Upbit/status/${xId}`,
  html: `<blockquote><p>${text}</p><a href="https://x.com/GIWA_by_Upbit/status/${xId}">September 27</a></blockquote>`,
});

test("official X uses primary text, exact author, and ID timestamp rather than mirror claims", async () => {
  const requests = [];
  const posts = await readGiwaOfficialX(async (url) => {
    requests.push(url);
    return JSON.stringify(url.includes("fxtwitter") ? { code: 200, results: [
      { type: "status", id: xId, author: { id: GIWA_X_USER_ID, screen_name: "GIWA_by_Upbit" }, text: "FAKE MIRROR MAINNET LIVE" },
      { type: "status", id: "2104108336228843591", author: { id: "other", screen_name: "GIWA_by_Upbit" }, text: "bad author" },
    ] } : embed());
  }, [], t0);
  assert.equal(requests.length, 2);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /DO NOT/);
  assert.equal(posts[0].text.includes("FAKE"), false);
  assert.match(posts[0].publishedAt, /^2026-09-27T07:18:14/);
  assert.throws(() => verifyGiwaOembed(xId, { ...embed(), author_url: "https://x.com/attacker" }, t0));
  assert.throws(() => verifyGiwaOembed(xId, { ...embed(), url: "https://x.com/GIWA_by_Upbit/status/1" }, t0));
  assert.throws(() => verifyGiwaOembed(xId, embed(), Date.parse("2025-01-01")));
});

test("official X fails closed when primary verification is unavailable", async () => {
  await assert.rejects(readGiwaOfficialX(async (url) => {
    if (url.includes("publish.x.com")) throw new Error("primary unavailable");
    return JSON.stringify({ code: 200, results: [{ type: "status", id: xId,
      author: { id: GIWA_X_USER_ID, screen_name: "GIWA_by_Upbit" }, text: "mirror claim" }] });
  }, [], t0), /primary unavailable/);
});

test("stage marker changes do not confuse mock trades with live launches or generate migration noise", () => {
  const s = GIWA_SOURCES.find((s) => s.id === "cookhouse");
  const before = extractGiwaSnapshot(s, html("Example") + "<p>Preview · not live yet. Trading, launching and bridging are mock interfaces for now.</p>");
  const after = extractGiwaSnapshot(s, html("Example").replace("GIWA Sepolia testnet platform", "Application status not published"));
  assert.match(before.statusLabels.join(" "), /演示预览/);
  const e = createGiwaEvent(s, before, after, new Date(t0).toISOString(), new Date(t0 - 1).toISOString());
  assert.match(e.renderedZh, /不代表已上线/);
  assert.equal(e.autoTradeEligible, false);
  const legacy = structuredClone(before);
  delete legacy.statusLabels;
  assert.equal(createGiwaEvent(s, legacy, before, e.observedAt, e.previousObservedAt).changes.length, 0);
});
