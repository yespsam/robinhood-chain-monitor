import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRelevantAlert, isStrongAlert } from "../src/alerts.js";
import { buildBilingualAlertBundle, renderBilingualTelegramText } from "../src/bilingual-alert-renderer.js";
import { extractChainSupportSignals } from "../src/chain-support.js";
import { fetchHyperliquidOfficialDocument, PLATFORM_CAPABILITY_TARGETS, runPlatformCapabilityCheck } from "../src/platform-capability-monitor.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";
import { allowedPlatformDocumentUrl, platformDocumentCoverage } from "../src/platform-document-watch.js";

const officialUrl = "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm";
const platform = PLATFORM_CAPABILITY_TARGETS.find((item) => item.id === "hyperevm");
const config = { monitorScope: "focus3", dataDir: "/tmp/hyperevm-telegram-test" };
const docBodyMeaning = "官方文档正文变化待核验；不代表新部署、发射台启用或可交易";

test("HyperEVM curl transport is bounded and refuses non-official redirects before a second request", async () => {
  const calls = [];
  const fakeExecFile = (binary, args, options, callback) => {
    calls.push({ binary, args, options });
    callback(null, Buffer.from("HTTP/2 302\r\nlocation: https://hyperliquid-gitbook.io.evil.test/hyperliquid-docs/page\r\n\r\n"), Buffer.alloc(0));
  };
  await assert.rejects(
    fetchHyperliquidOfficialDocument(officialUrl, {}, 0, fakeExecFile),
    (error) => error.code === "redirect_rejected",
  );
  assert.equal(calls.length, 1, "untrusted redirect is rejected before following it");
  assert.equal(calls[0].binary, "/usr/bin/curl");
  assert.equal(calls[0].options.shell, undefined, "curl is invoked without a shell");
  assert.equal(calls[0].options.timeout, 19_000);
  assert.deepEqual(Object.keys(calls[0].options.env).sort(), ["LANG", "PATH"]);
  assert.ok(calls[0].args.includes("--max-redirs"));
  assert.ok(calls[0].args.includes("8"));
  assert.ok(calls[0].args.includes(officialUrl));

  const before = calls.length;
  await assert.rejects(
    fetchHyperliquidOfficialDocument("https://hyperliquid-gitbook.io.evil.test/hyperliquid-docs/page", {}, 0, fakeExecFile),
    (error) => error.code === "source_not_allowed",
  );
  assert.equal(calls.length, before, "non-official URL never reaches curl");
});

test("HyperEVM curl transport follows only bounded same-origin docs redirects and preserves response metadata", async () => {
  const calls = [];
  const fakeExecFile = (binary, args, options, callback) => {
    calls.push({ binary, args, options });
    if (calls.length === 1) {
      callback(null, Buffer.from("HTTP/2 301\r\nlocation: /hyperliquid-docs/for-developers/hyperevm\r\n\r\n"), Buffer.alloc(0));
      return;
    }
    callback(null, Buffer.from("HTTP/2 200\r\netag: \"hyperevm-v1\"\r\ncontent-type: text/html\r\n\r\n<main>official HyperEVM documentation body</main>"), Buffer.alloc(0));
  };
  const response = await fetchHyperliquidOfficialDocument("https://hyperliquid.gitbook.io/hyperliquid-docs/old-page", {}, 0, fakeExecFile);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.at(-1), officialUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), "\"hyperevm-v1\"");
  assert.equal(await response.text(), "<main>official HyperEVM documentation body</main>");

  const manualCalls = [];
  const manualResponse = await fetchHyperliquidOfficialDocument(officialUrl, { redirect: "manual" }, 0,
    (binary, args, options, callback) => {
      manualCalls.push(binary);
      callback(null, Buffer.from("HTTP/2 302\r\nlocation: https://example.com/outside\r\n\r\n"), Buffer.alloc(0));
    });
  assert.equal(manualCalls.length, 1);
  assert.equal(manualResponse.status, 302, "manual mode returns redirect metadata for the caller to reject");
});

function capabilityEvent(overrides = {}) {
  return {
    type: "platform_capability_update",
    kind: "capability_delta",
    eventKey: "platform-capability:hyperevm:test",
    platform: { id: "hyperevm", name: "HyperEVM", website: "https://hyperliquid.xyz" },
    changes: { newChains: [{ id: "hyperevm", name: "HyperEVM", chainId: 999, environment: "mainnet", stage: "deployed" }] },
    source: officialUrl,
    sources: [officialUrl],
    url: officialUrl,
    observedAt: "2026-11-07T08:00:00.000Z",
    ...overrides,
  };
}

test("HyperEVM chain identities stay distinct from HyperCore and parse official chain IDs", () => {
  assert.deepEqual(
    extractChainSupportSignals("HyperEVM mainnet is deployed with chain ID 999; HyperEVM testnet is deployed with chain ID 998."),
    [
      { id: "hyperevm", name: "HyperEVM", chainId: 999, environment: "mainnet", stage: "deployed" },
      { id: "hyperevm", name: "HyperEVM", chainId: 998, environment: "testnet", stage: "deployed" },
    ],
  );
  assert.equal(platform.name, "HyperEVM");
  assert.equal(platform.marketSources, undefined, "no HyperCore/perps market feed is treated as EVM deployment evidence");
  assert.equal(platformDocumentCoverage(platform, { capabilities: { pageMetadata: [] } }, Date.now()).observationOnly, true);
  assert.ok(allowedPlatformDocumentUrl(platform, officialUrl));
  assert.equal(allowedPlatformDocumentUrl(platform, "https://hyperliquid.gitbook.io.evil.invalid/hyperliquid-docs/for-developers/hyperevm"), null);
});

test("only exact HyperEVM official-document changes pass the Telegram source and relevance gates", () => {
  const valid = capabilityEvent();
  assert.equal(isMonitoringSourceEnabled(config, valid), true);
  assert.equal(isRelevantAlert(valid), true);
  assert.equal(isStrongAlert(valid), true);

  const bodyChange = capabilityEvent({
    kind: "hyperevm_official_document_change_observed",
    changes: { documentBodyChanges: [{
      url: officialUrl,
      added: ["A new HyperEVM launchpad is documented."],
      removed: [],
      meaning: docBodyMeaning,
    }] },
  });
  assert.equal(isMonitoringSourceEnabled(config, bodyChange), true);
  assert.equal(isRelevantAlert(bodyChange), true);

  assert.equal(isMonitoringSourceEnabled(config, capabilityEvent({ source: "https://evil.invalid/hype", sources: ["https://evil.invalid/hype"], url: "https://evil.invalid/hype" })), false);
  assert.equal(isMonitoringSourceEnabled(config, capabilityEvent({ platform: { id: "hyperevm", name: "HyperEVM", website: "https://evil.invalid" } })), false);
  assert.equal(isRelevantAlert(capabilityEvent({ kind: "hyperevm_official_document_change_observed", changes: { documentBodyChanges: [{
    url: officialUrl, added: ["launchpad"], removed: [], meaning: "unverified",
  }] } })), false);
});

test("official HyperEVM body changes enqueue bilingual Telegram events after a quiet baseline", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hyperevm-telegram-"));
  const stateFile = path.join(directory, "platform-capability-state.json");
  const auditFile = path.join(directory, "platform-capability-events.jsonl");
  const sent = [];
  let changed = false;
  let clockMs = Date.parse("2026-11-07T08:00:00.000Z");
  const html = () => `<main><h1>HyperEVM</h1><p>HyperEVM mainnet chain ID 999 is deployed.</p>${changed
    ? "<p>A new HyperEVM launchpad is documented with its factory and deployment requirements.</p>" : ""}</main>`;
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    url,
    redirected: false,
    headers: { get: () => null },
    text: async () => String(url).endsWith("sitemap.xml") ? "<urlset></urlset>" : html(),
  });
  const monitorConfig = {
    dataDir: directory,
    platformCapabilityPollIntervalMs: 1_000,
    platformCapabilityRequestTimeoutMs: 1_000,
    platformCapabilityConcurrency: 2,
  };
  const dependencies = {
    targets: [platform],
    fetchImpl,
    now: () => new Date(clockMs),
    sendAlertsImpl: async (_config, event) => {
      sent.push(event);
      return { status: "delivered", eventId: event.eventKey, persisted: true };
    },
    logger: { error() {} },
    stateFile,
    auditFile,
  };

  await runPlatformCapabilityCheck(monitorConfig, dependencies);
  assert.equal(sent.length, 0, "first observation establishes a baseline without announcing existing HYPE chain support");

  // HyperEVM body reads are deliberately capped at one page per slow cycle.
  // Establish all configured seed baselines before introducing a change, so
  // this test exercises change detection rather than an unchecked-page pass.
  for (let index = 1; index < 7; index += 1) {
    clockMs += 60_000;
    await runPlatformCapabilityCheck(monitorConfig, dependencies);
  }
  let baselineState = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(Object.values(baselineState.hyperevm.documentWatch.pages).filter((page) => page.fingerprint).length, 7);
  assert.equal(sent.length, 0, "all initial document baselines remain silent");

  changed = true;
  clockMs += 31 * 60_000;
  await runPlatformCapabilityCheck(monitorConfig, dependencies);
  assert.ok(sent.length > 0, "a relevant official document body delta reaches the existing Telegram sender");
  for (const event of sent) {
    assert.equal(isMonitoringSourceEnabled(config, event), true);
    assert.equal(isRelevantAlert(event), true);
    assert.equal(event.kind, "hyperevm_official_document_change_observed");
    assert.equal(event.changes.documentBodyChanges[0].meaning, docBodyMeaning);
    assert.match(event.changes.documentBodyChanges[0].added.join(" "), /launchpad/i);
  }

  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.ok(state.hyperevm.documentWatch.changes.some((item) => item.telegramAlertStatus === "accepted"));
  assert.ok(platformDocumentCoverage(platform, state.hyperevm, clockMs).latestChanges.length > 0);

  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async (url) => {
      const parsed = new URL(url);
      const query = parsed.searchParams.get("q") || "";
      return { ok: true, status: 200, text: async () => JSON.stringify([[[query, "source"]], null, "auto"]) };
    },
    alertTranslationTimeoutMs: 500,
  }, sent[0], "HyperEVM official documentation changed; verification pending.");
  const rendered = renderBilingualTelegramText(bundle, true);
  assert.match(rendered, /🇨🇳 中文[\s\S]+🇬🇧 English/);
  assert.match(rendered, /HyperEVM/);
  assert.match(rendered, /launchpad/i);
  assert.match(rendered, /待核验|pending/i);
  assert.ok(rendered.length < 3_800);
});
