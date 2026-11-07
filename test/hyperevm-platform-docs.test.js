import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PLATFORM_CAPABILITY_TARGETS,
  crawlSitemap,
  extractHyperEvmDocumentFacts,
  fetchPlatformSource,
  runPlatformCapabilityCheck,
} from "../src/platform-capability-monitor.js";
import { isFocusPlatformEvent, isRelevantAlert, isStrongAlert } from "../src/alerts.js";
import { buildBilingualAlertBundle, renderBilingualTelegramText } from "../src/bilingual-alert-renderer.js";
import {
  isMonitoringSourceEnabled,
  isOfficialHyperEvmCapabilityUpdate,
  isOfficialHyperEvmDocumentUrl,
} from "../src/source-controls.js";

const DOC_URL = "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm";
const SECOND_DOC_URL = "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc";
const DOC_KEY = `docs:${DOC_URL}`;
const quietLogger = { error() {} };

function response(body, url, { ok = true, status = 200, headers = {} } = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok,
    status,
    url,
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) || null },
    text: async () => body,
  };
}

async function isolatedState(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hyperevm-doc-queue-test-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function target() {
  const platform = PLATFORM_CAPABILITY_TARGETS.find((item) => item.id === "hyperevm");
  return { ...platform, sources: [DOC_URL] };
}

function monitorOptions(dataDir, fetchImpl, sendAlertsImpl, now = "2026-11-07T12:00:00.000Z") {
  return {
    targets: [target()],
    fetchImpl,
    sendAlertsImpl,
    logger: quietLogger,
    now: () => new Date(now),
  };
}

function documentFetcher(body) {
  return async (url) => {
    assert.equal(url, DOC_URL);
    return response(body, url);
  };
}

test("HyperEVM official document URLs reject lookalike hosts, paths, query and encoded traversal", () => {
  assert.equal(isOfficialHyperEvmDocumentUrl(DOC_URL), true);
  assert.equal(isOfficialHyperEvmDocumentUrl("https://hyperliquid.gitbook.io.evil.test/hyperliquid-docs/for-developers/hyperevm"), false);
  assert.equal(isOfficialHyperEvmDocumentUrl("https://evil.test/hyperliquid.gitbook.io/hyperevm"), false);
  assert.equal(isOfficialHyperEvmDocumentUrl(`${DOC_URL}?next=https://evil.test`), false);
  assert.equal(isOfficialHyperEvmDocumentUrl("https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/%2e%2e/admin"), false);
});

test("first successful observation of each HyperEVM document is a silent baseline", async (t) => {
  const dataDir = await isolatedState(t);
  const alerts = [];
  const body = "<main><h1>HyperEVM</h1><p>HyperEVM uses JSON-RPC for EVM chain requests and HYPE for gas.</p></main>";
  const state = await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, documentFetcher(body), async (_config, event) => alerts.push(event)),
  });
  assert.equal(alerts.length, 0);
  assert.equal(state.hyperevm.sources[DOC_KEY].initialized, true);
  assert.deepEqual(state.hyperevm.sources[DOC_KEY].documentBodyFacts, [
    "HyperEVM uses JSON-RPC for EVM chain requests and HYPE for gas.",
  ]);
});

test("a document added to the watch list is baselined silently on its first success", async (t) => {
  const dataDir = await isolatedState(t);
  const alerts = [];
  const send = async (_config, event) => {
    alerts.push(event);
    return { status: "queued", persisted: true, eventId: event.eventKey };
  };
  const firstBody = "<p>HyperEVM JSON-RPC documents supported methods for EVM applications.</p>";
  const changedFirstBody = "<p>HyperEVM JSON-RPC updates documentation for supported EVM applications.</p>";
  const newDocumentBody = "<p>HyperEVM JSON-RPC gas estimation notes for EVM applications.</p>";
  const fetcher = (first, second = newDocumentBody) => async (url) => response(
    url === DOC_URL ? first : second,
    url,
  );
  const firstTarget = { ...target(), sources: [DOC_URL] };
  const expandedTarget = { ...target(), sources: [DOC_URL, SECOND_DOC_URL] };
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, fetcher(firstBody), send),
    targets: [firstTarget],
  });
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, fetcher(changedFirstBody), send, "2026-11-07T12:16:00.000Z"),
    targets: [expandedTarget],
  });
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].changes.documentBodyChanges.map((change) => change.url), [DOC_URL]);
});

test("successful HyperEVM document polls are rate-limited independently of launchpad lanes", async (t) => {
  const dataDir = await isolatedState(t);
  let requests = 0;
  const fetchImpl = async (url) => {
    requests += 1;
    return response("<p>HyperEVM JSON-RPC documents supported EVM methods.</p>", url);
  };
  const send = async () => assert.fail("unchanged docs must not be queued");
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, fetchImpl, send),
  });
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, fetchImpl, send, "2026-11-07T12:05:00.000Z"),
  });
  assert.equal(requests, 1);
});

test("material official body change is queued as a bilingual pending-verification event", async (t) => {
  const dataDir = await isolatedState(t);
  const alerts = [];
  const send = async (_config, event) => {
    alerts.push(event);
    return { status: "queued", persisted: true, eventId: event.eventKey };
  };
  const baseline = "<p>HyperEVM JSON-RPC describes the supported EVM methods and chain behavior.</p>";
  const changed = "<p>HyperEVM JSON-RPC now describes a launchpad factory interface and related EVM methods.</p>";
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, documentFetcher(baseline), send),
  });
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, documentFetcher(changed), send, "2026-11-07T12:16:00.000Z"),
  });
  assert.equal(alerts.length, 1);
  const event = alerts[0];
  assert.equal(event.type, "platform_capability_update");
  assert.equal(event.kind, "hyperevm_official_document_change_observed");
  assert.equal(event.source, DOC_URL);
  assert.equal(event.changes.documentBodyChanges[0].url, DOC_URL);
  assert.equal(isOfficialHyperEvmCapabilityUpdate(event), true);
  assert.equal(isFocusPlatformEvent(event), true);
  assert.equal(isRelevantAlert(event), true);
  assert.equal(isStrongAlert(event), true);
  assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3" }, event), true);

  const spoofed = {
    ...event,
    source: "https://hyperliquid.gitbook.io.attacker.test/hyperliquid-docs/for-developers/hyperevm",
    url: "https://hyperliquid.gitbook.io.attacker.test/hyperliquid-docs/for-developers/hyperevm",
    sources: ["https://hyperliquid.gitbook.io.attacker.test/hyperliquid-docs/for-developers/hyperevm"],
  };
  assert.equal(isOfficialHyperEvmCapabilityUpdate(spoofed), false);
  assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3" }, spoofed), false);
  const genericBrandSpoof = {
    type: "platform_capability_update",
    platform: { id: "other", name: "Other", website: "https://hyperliquid.xyz" },
    source: "https://other.example/announcement",
    sources: ["https://other.example/announcement"],
    changes: { newChains: [{ name: "HyperEVM", stage: "deployed" }] },
  };
  assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3" }, genericBrandSpoof), false);

  const bundle = await buildBilingualAlertBundle({}, event, "HyperEVM documentation text changed");
  const telegram = renderBilingualTelegramText(bundle, true);
  assert.match(telegram, /文档变化待核验（非部署\/可交易证明）/u);
  assert.match(telegram, /Docs change only; unverified—not proof of deployment\/tradability/u);
  assert.match(telegram, /launchpad factory interface/u);
});

test("markup noise, identical body and repeated polls do not re-enqueue", async (t) => {
  const dataDir = await isolatedState(t);
  const alerts = [];
  const send = async (_config, event) => {
    alerts.push(event);
    return { status: "queued", persisted: true, eventId: event.eventKey };
  };
  const body = "<p>HyperEVM JSON-RPC supports recent-state calls for EVM applications.</p>";
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, documentFetcher(body), send),
  });
  const changed = "<p>HyperEVM JSON-RPC supports historical-state calls for EVM applications.</p><script>buildId=rotates</script>";
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, documentFetcher(changed), send, "2026-11-07T12:16:00.000Z"),
  });
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, documentFetcher(changed.replace("buildId=rotates", "buildId=other")), send, "2026-11-07T12:32:00.000Z"),
  });
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, documentFetcher(changed), send, "2026-11-07T12:48:00.000Z"),
  });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].eventKey, /^platform-capability:hyperevm:/u);
});

test("undurable queue handoff leaves the body baseline uncommitted for retry", async (t) => {
  const dataDir = await isolatedState(t);
  const alerts = [];
  let durable = false;
  const send = async (_config, event) => {
    alerts.push(event);
    return durable
      ? { status: "queued", persisted: true, eventId: event.eventKey }
      : { status: "failed", persisted: false, eventId: event.eventKey };
  };
  const baseline = "<p>HyperEVM JSON-RPC supports latest-state reads for EVM clients.</p>";
  const changed = "<p>HyperEVM JSON-RPC adds documented launchpad interfaces for EVM clients.</p>";
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, documentFetcher(baseline), send),
  });
  const failedState = await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, documentFetcher(changed), send, "2026-11-07T12:16:00.000Z"),
  });
  assert.deepEqual(failedState.hyperevm.sources[DOC_KEY].documentBodyFacts, [
    "HyperEVM JSON-RPC supports latest-state reads for EVM clients.",
  ]);
  assert.equal(failedState.hyperevm.sources[DOC_KEY].deliveryFailures, 1);
  assert.equal(failedState.hyperevm.sources[DOC_KEY].nextAttemptAt, "2026-11-07T12:17:00.000Z");
  durable = true;
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, documentFetcher(changed), send, "2026-11-07T12:32:00.000Z"),
  });
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, documentFetcher(changed), send, "2026-11-07T12:48:00.000Z"),
  });
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].eventKey, alerts[1].eventKey);
});

test("non-official requested source and off-site final redirect are rejected before queueing", async (t) => {
  let fetchCalls = 0;
  await assert.rejects(fetchPlatformSource(
    target(),
    { kind: "docs", url: "https://hyperliquid.gitbook.io.attacker.test/hyperliquid-docs/for-developers/hyperevm", key: "spoof" },
    async () => { fetchCalls += 1; return response("<p>HyperEVM body changed.</p>", DOC_URL); },
  ), /URL rejected by source policy/u);
  assert.equal(fetchCalls, 0);
  await assert.rejects(fetchPlatformSource(
    target(),
    { kind: "live", url: DOC_URL, key: "wrong-kind" },
    async () => { fetchCalls += 1; return response("{}", DOC_URL); },
  ), /documentation descriptors only/u);
  assert.equal(fetchCalls, 0);

  const dataDir = await isolatedState(t);
  const alerts = [];
  const baseline = "<p>HyperEVM JSON-RPC documents EVM requests and gas estimation.</p>";
  await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, documentFetcher(baseline), async (_config, event) => alerts.push(event)),
  });
  const redirectFetcher = async () => response(
    "<p>HyperEVM is now described elsewhere.</p>",
    "https://hyperliquid.gitbook.io.attacker.test/hyperliquid-docs/for-developers/hyperevm",
  );
  const state = await runPlatformCapabilityCheck({ dataDir }, {
    ...monitorOptions(dataDir, redirectFetcher, async (_config, event) => alerts.push(event), "2026-11-07T12:16:00.000Z"),
  });
  assert.equal(alerts.length, 0);
  assert.match(state._health.platforms.hyperevm.lastError || "", /redirect rejected by source policy/u);
});

test("sitemap child redirects are validated before parsing fetched content", async () => {
  const root = "https://hyperliquid.gitbook.io/hyperliquid-docs/sitemap.xml";
  const child = "https://hyperliquid.gitbook.io/hyperliquid-docs/sitemap-1.xml";
  let requests = 0;
  await assert.rejects(crawlSitemap(
    root,
    async (url) => {
      requests += 1;
      assert.equal(url, child);
      return response("<urlset></urlset>", "https://evil.test/sitemap-1.xml");
    },
    /\/hyperliquid-docs\/for-developers\/hyperevm/i,
    `<sitemapindex><sitemap><loc>${child}</loc></sitemap></sitemapindex>`,
    5_000,
    Date.now() + 5_000,
    { validateUrl: isOfficialHyperEvmDocumentUrl },
  ), /all child sitemaps failed/u);
  assert.equal(requests, 1);
});

test("HyperEVM body extraction ignores scripts and keeps bounded prose even without keyword matches", () => {
  const facts = extractHyperEvmDocumentFacts("<script>HyperEVM fake build text</script><p>HyperEVM uses HYPE as its native gas token on mainnet.</p><p>This newly added paragraph has no chain-specific keyword.</p>");
  assert.deepEqual(facts, [
    "HyperEVM uses HYPE as its native gas token on mainnet.",
    "This newly added paragraph has no chain-specific keyword.",
  ]);
});
