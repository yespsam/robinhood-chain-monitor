import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BSC_DISCOVERY_SITE_TARGETS, extractSiteSignals, startSiteMonitor } from "../src/site-monitor.js";

test("proactively baselines official BSC sources even before a factory is known", () => {
  const flypad = BSC_DISCOVERY_SITE_TARGETS.find((entry) => entry.id === "bsc-flypad");
  assert.equal(flypad.website, "https://docs.flypad.app");
  assert.ok(BSC_DISCOVERY_SITE_TARGETS.some((entry) => entry.id === "bsc-hodldance"));
  assert.ok(BSC_DISCOVERY_SITE_TARGETS.some((entry) => entry.id === "bsc-hodldance-docs"));
  assert.ok(BSC_DISCOVERY_SITE_TARGETS.some((entry) => entry.id === "bsc-flypad-features"));
  assert.ok(BSC_DISCOVERY_SITE_TARGETS.some((entry) => entry.id === "bsc-flypad-ai-anonymous"));
  assert.equal(BSC_DISCOVERY_SITE_TARGETS.find((entry) => entry.id === "bsc-bltx")?.website, "https://bltx.fun");
  assert.equal(BSC_DISCOVERY_SITE_TARGETS.find((entry) => entry.id === "bsc-bltx-docs")?.website, "https://bltx.fun/docs");
  assert.equal(BSC_DISCOVERY_SITE_TARGETS.find((entry) => entry.id === "bsc-fabi")?.twitter, "https://x.com/FabiBsc");
  assert.equal(BSC_DISCOVERY_SITE_TARGETS.find((entry) => entry.id === "bsc-flypad-index").website, "https://docs.flypad.app/llms.txt");
  assert.ok(BSC_DISCOVERY_SITE_TARGETS.find((entry) => entry.id === "bsc-flypad-features").website.endsWith(".md"));
  assert.equal(BSC_DISCOVERY_SITE_TARGETS.find((entry) => entry.id === "bsc-openfour")?.website, "https://four.meme");
  assert.equal(BSC_DISCOVERY_SITE_TARGETS.some((entry) => entry.id === "bsc-openfour-docs"), false);
  assert.equal(BSC_DISCOVERY_SITE_TARGETS.some((entry) => entry.website.includes("/meme-api/v1/public/address")), false);
  assert.ok(BSC_DISCOVERY_SITE_TARGETS.filter((entry) => entry.id.startsWith("bsc-")).every((entry) => entry.chainId === 56));
});

test("focus3 fetches each canonical Flap/Four official homepage once despite factory-keyed auto targets", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-focus3-family-dedupe-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const requested = [];
  const monitor = startSiteMonitor({ dataDir, monitorScope: "focus3", ponsMonitorEnabled: false }, {
    autoStart: false,
    targets: [
      { id: "flap", name: "Flap", website: "https://flap.sh/" },
      { id: "bsc-openfour", name: "OpenFour", platformId: "openfour", website: "https://four.meme" },
    ],
    fetchImpl: async (url) => {
      requested.push(url);
      return { ok: true, status: 200, text: async () => "Factory V2" };
    },
    sendAlertsImpl: async () => {},
  });
  await monitor.watch({
    factory: "0x1111111111111111111111111111111111111111",
    website: "https://flap.sh/?utm_source=discovery",
    name: "Flap",
  });
  await monitor.watch({
    factory: "0x2222222222222222222222222222222222222222",
    website: "https://four.meme/en/create-token",
    name: "Four.Meme",
  });

  await monitor.check();

  assert.deepEqual(requested.sort(), ["https://flap.sh/", "https://four.meme"]);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  assert.ok(state.flap);
  assert.ok(state["bsc-openfour"]);
  assert.equal(Object.keys(state).some((key) => key.startsWith("auto-")), false);
});

test("extracts new launchpad socials, contracts and mode signals", () => {
  const result = extractSiteSignals('<a href="https://x.com/anypadfun">X</a> Factory V2 0xA2763EC712A582A8450D7DB932081ebFE8D951F8');
  assert.deepEqual(result.socials, ["https://x.com/anypadfun"]);
  assert.equal(result.contracts[0], "0xa2763ec712a582a8450d7db932081ebfe8d951f8");
  assert.ok(result.keywords.includes("factory"));
  assert.ok(result.keywords.includes("v2"));
});

test("site update carries exact before/current snapshots without claiming unconfirmed removals", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-signal-delta-"));
  const target = { id: "delta", name: "Delta", website: "https://delta.example" };
  const alerts = [];
  let html = "Factory Router V2";
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const monitor = startSiteMonitor({ dataDir }, {
    autoStart: false,
    targets: [target],
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }),
    sendAlertsImpl: async (_config, event) => alerts.push(event),
  });

  await monitor.check();
  html = "Factory V3";
  await monitor.check();

  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].previousSignals, { keywords: ["factory", "router", "v2"] });
  assert.deepEqual(alerts[0].currentSignals, { keywords: ["factory", "v3"] });
  assert.deepEqual(alerts[0].signalDelta, {
    changeType: "added",
    comparisonMode: "addition_only",
    changedFields: ["keywords"],
    added: { keywords: ["v3"] },
    removalsConfirmed: false,
  });
  assert.equal(Object.hasOwn(alerts[0].signalDelta, "removed"), false);
});

test("extracts supported network lists and structured chain ids without treating casual mentions as support", () => {
  const result = extractSiteSignals('<main>Pools.trade supported networks: BNB Chain, Base mainnet.</main><script>const supportedChains=[42161]</script>');
  assert.deepEqual(result.chains.map((item) => item.name), ["Arbitrum", "Base", "BNB Chain"]);
  assert.deepEqual(extractSiteSignals("Community article about Base builders").chains, []);
});

test("site chain parsing rejects wallet state but accepts explicit supported-network schemas", () => {
  assert.deepEqual(extractSiteSignals('<script>const wallet={chainId:8453}</script>').chains, []);
  assert.deepEqual(
    extractSiteSignals('<script>const supportedNetworks=[{chainId:8453,name:"Base"}]</script>').chains,
    [{ id: "base", name: "Base", chainId: 8453, environment: "mainnet", stage: "supported" }],
  );
  assert.deepEqual(
    extractSiteSignals('<script>const config={networkName:"Base",chainId:42161,rpcUrl:"https://rpc.invalid"}</script>').chains,
    [],
    "a chain name/id conflict must fail closed",
  );
});

test("extracts FlyPad machine-readable feature modes and documentation pages", () => {
  const result = extractSiteSignals("# AI and Anonymous Launching\nSquads enable revenue sharing and weekly airdrops.\nhttps://docs.flypad.app/technical/squads.md");
  assert.deepEqual(result.features, ["ai_launching", "anonymous_launching", "revenue_share", "squads", "weekly_airdrops"]);
  assert.deepEqual(result.pages, ["https://docs.flypad.app/technical/squads"]);
});

test("ignores rotating token-card and quote-token addresses", () => {
  const result = extractSiteSignals(String.raw`<script>
    {\"coin\":{\"address\":\"0xb82535e74b03ffe4910efea1c759b6bbbf0a7777\",\"name\":\"Just a jacket\"},
    \"quoteToken\":\"0x02fca66c1d1afb4e2a7884261eb00f63598a7436\",
    \"vault\":{\"vault\":\"0x3333333333333333333333333333333333333333\",\"vaultFactory\":\"0x4444444444444444444444444444444444444444\"}}
  </script>`);
  assert.deepEqual(result.contracts, []);
});

test("keeps a directly linked official X profile but does not promote its embedded posts", () => {
  const result = extractSiteSignals(`
    <a href="https://x.com/flapdotsh">X</a>
    <a href="https://x.com/flapdotsh/status/123?ref=home">post</a>
    <a href="https://twitter.com/flapdotsh/status/456">post</a>
  `);
  assert.deepEqual(result.socials, ["https://x.com/flapdotsh"]);
});

test("rejects X posts, share routes, intents and raw links as official accounts", () => {
  const result = extractSiteSignals(`
    <a href="https://x.com/madapescall/status/123">call</a>
    <a href="https://x.com/share?url=https%3A%2F%2Fexample.com">share</a>
    <a href="https://twitter.com/intent/tweet?text=launch">share</a>
    <script>window.author = "https://x.com/thirdparty"</script>
    https://x.com/anothercaller
  `);
  assert.deepEqual(result.socials, []);
});

test("rejects an unlabeled third-party profile mention in page content", () => {
  const result = extractSiteSignals('<article>Called by <a href="https://x.com/madapescall">@madapescall</a></article>');
  assert.deepEqual(result.socials, []);
});

test("keeps a direct profile link in trusted site-wide navigation", () => {
  const result = extractSiteSignals('<footer><a href="https://twitter.com/anypadfun?ref=footer">@anypadfun</a></footer>');
  assert.deepEqual(result.socials, ["https://x.com/anypadfun"]);
});

test("rejects X navigation routes that are not project accounts", () => {
  const result = extractSiteSignals('<a href="https://x.com/you">profile</a><a href="https://x.com/explore">explore</a>');
  assert.deepEqual(result.socials, []);
});

test("keeps explicitly named platform contract addresses", () => {
  const result = extractSiteSignals(String.raw`<script>
    {\"factoryAddress\":\"0x1111111111111111111111111111111111111111\"}
    {\"contractName\":\"tokenManagerV4\",\"contractAddress\":\"0x2222222222222222222222222222222222222222\"}
  </script><p>Vault Portal: 0x3333333333333333333333333333333333333333</p>`);
  assert.deepEqual(result.contracts, [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ]);
});

test("site checks use bounded concurrency so one hanging target does not serialize healthy targets", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-bounded-concurrency-"));
  let releaseBad;
  const badGate = new Promise((resolve) => { releaseBad = resolve; });
  const requested = [];
  let active = 0;
  let maxActive = 0;
  const targets = [
    { id: "bad", name: "Bad", website: "https://bad.example" },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `good-${index}`, name: `Good ${index}`, website: `https://good-${index}.example` })),
  ];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const monitor = startSiteMonitor({ dataDir, siteCheckConcurrency: 2, siteRequestTimeoutMs: 5_000 }, {
    autoStart: false,
    targets,
    fetchImpl: async (url) => {
      requested.push(url);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (url === "https://bad.example") await badGate;
      active -= 1;
      return { ok: true, status: 200, text: async () => "Factory V2" };
    },
    sendAlertsImpl: async () => {},
  });
  const checking = monitor.check();
  for (let attempt = 0; attempt < 100 && requested.length < targets.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const healthyRequestsBeforeRelease = requested.filter((url) => url.includes("good-")).length;
  const observedMaxActive = maxActive;
  releaseBad();
  await checking;
  assert.equal(healthyRequestsBeforeRelease, 6);
  assert.equal(observedMaxActive, 2);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  assert.equal(Object.values(state._health.targets).every(({ status }) => status === "healthy"), true);
});

test("site 403 backoff persists across restart and recovery creates a silent baseline", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-blocked-backoff-"));
  const target = { id: "blocked", name: "Blocked", website: "https://blocked.example" };
  const alerts = [];
  let attempts = 0;
  let currentTime = new Date("2026-08-06T00:00:00.000Z");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  const dependencies = {
    autoStart: false,
    targets: [target],
    now: () => new Date(currentTime),
    random: () => 0.5,
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 403, text: async () => "" };
      return { ok: true, status: 200, text: async () => attempts === 2 ? "Factory V2" : "Factory V2 V3" };
    },
  };
  const config = {
    dataDir,
    siteCheckConcurrency: 2,
    siteRetryBaseMs: 1_000,
    siteRetryMaxMs: 8_000,
    siteBlockedRetryMs: 1_000,
    siteNotFoundRetryMs: 4_000,
  };
  const monitor = startSiteMonitor(config, dependencies);
  await monitor.check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  assert.equal(state.blocked, undefined);
  assert.equal(state._health.targets.blocked.status, "degraded");
  assert.equal(state._health.targets.blocked.failureKind, "http_403");
  assert.equal(state._health.targets.blocked.nextAttemptAt, "2026-08-06T00:00:01.000Z");

  const restarted = startSiteMonitor(config, dependencies);
  currentTime = new Date("2026-08-06T00:00:00.500Z");
  await restarted.check();
  assert.equal(attempts, 1);

  currentTime = new Date("2026-08-06T00:00:01.000Z");
  await restarted.check();
  assert.equal(alerts.length, 0, "the first successful observation after an outage remains a baseline");
  state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  assert.equal(state.blocked.signals.keywords.includes("v2"), true);
  assert.equal(state._health.targets.blocked.status, "healthy");
  assert.equal(state._health.targets.blocked.lastRecoveredAt, "2026-08-06T00:00:01.000Z");

  currentTime = new Date("2026-08-06T00:00:02.000Z");
  await restarted.check();
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].newKeywords, ["v3"]);
});

test("site timeout failures use exponential per-target backoff", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-timeout-backoff-"));
  const target = { id: "timeout", name: "Timeout", website: "https://timeout.example" };
  let currentTime = new Date("2026-08-06T00:00:00.000Z");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  const monitor = startSiteMonitor({
    dataDir,
    siteRetryBaseMs: 1_000,
    siteRetryMaxMs: 8_000,
  }, {
    autoStart: false,
    targets: [target],
    now: () => new Date(currentTime),
    random: () => 0.5,
    fetchImpl: async () => {
      const error = new Error("request timed out");
      error.name = "TimeoutError";
      throw error;
    },
    sendAlertsImpl: async () => {},
  });
  await monitor.check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  assert.equal(state._health.targets.timeout.failureKind, "timeout");
  assert.equal(state._health.targets.timeout.backoffMs, 1_000);

  currentTime = new Date("2026-08-06T00:00:01.000Z");
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  assert.equal(state._health.targets.timeout.consecutiveFailures, 2);
  assert.equal(state._health.targets.timeout.backoffMs, 2_000);
  assert.equal(state._health.targets.timeout.nextAttemptAt, "2026-08-06T00:00:03.000Z");
});

test("site 403 and 404 responses use long source-specific cooldowns", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-http-cooldown-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  const monitor = startSiteMonitor({ dataDir }, {
    autoStart: false,
    targets: [
      { id: "blocked", name: "Blocked", website: "https://blocked.example" },
      { id: "missing", name: "Missing", website: "https://missing.example" },
    ],
    now: () => new Date("2026-08-06T00:00:00.000Z"),
    random: () => 0.5,
    fetchImpl: async (url) => ({ ok: false, status: url.includes("blocked") ? 403 : 404, text: async () => "" }),
    sendAlertsImpl: async () => {},
  });
  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  assert.equal(state._health.targets.blocked.backoffMs, 1_800_000);
  assert.equal(state._health.targets.missing.backoffMs, 21_600_000);
  assert.equal(state._health.targets.blocked.failureKind, "http_403");
  assert.equal(state._health.targets.missing.failureKind, "http_404");
});

test("site downstream failures retain the old fingerprint until every discovery callback succeeds", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-callback-retry-"));
  const target = { id: "callbacks", name: "Callbacks", website: "https://callbacks.example", chainId: 56, platformId: "callbacks", sourceTrust: "official_verified" };
  const alerts = [];
  let html = "Factory V2";
  let currentTime = new Date("2026-08-06T00:00:00.000Z");
  let failRepository = true;
  let failContract = true;
  let repositoryCalls = 0;
  let contractCalls = 0;
  const contractSignals = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  const monitor = startSiteMonitor({ dataDir, siteRetryBaseMs: 1_000, siteRetryMaxMs: 8_000 }, {
    autoStart: false,
    targets: [target],
    now: () => new Date(currentTime),
    random: () => 0.5,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }),
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    onOfficialRepository: async () => {
      repositoryCalls += 1;
      if (failRepository) throw new Error("repository callback unavailable");
    },
    onContractDiscovery: async (signal) => {
      contractCalls += 1;
      contractSignals.push(signal);
      if (failContract) throw new Error("contract callback unavailable");
    },
  });
  await monitor.check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  const baselineFingerprint = state.callbacks.fingerprint;

  html = 'Factory V2 V3 <a href="https://github.com/example/contracts">GitHub</a> Contract address: 0x1111111111111111111111111111111111111111';
  currentTime = new Date("2026-08-06T00:00:01.000Z");
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  assert.equal(state.callbacks.fingerprint, baselineFingerprint);
  assert.equal(state._health.targets.callbacks.failureKind, "official_repository_callback");
  assert.equal(repositoryCalls, 1);
  assert.equal(contractCalls, 0);

  failRepository = false;
  currentTime = new Date("2026-08-06T00:00:02.000Z");
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  assert.equal(state.callbacks.fingerprint, baselineFingerprint);
  assert.equal(state._health.targets.callbacks.failureKind, "contract_discovery_callback");
  assert.equal(repositoryCalls, 2);
  assert.equal(contractCalls, 1);

  failContract = false;
  currentTime = new Date("2026-08-06T00:00:04.000Z");
  await monitor.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  assert.notEqual(state.callbacks.fingerprint, baselineFingerprint);
  assert.equal(state._health.targets.callbacks.status, "healthy");
  assert.equal(repositoryCalls, 3);
  assert.equal(contractCalls, 2);
  assert.equal(contractSignals.every((signal) => signal.chainId === 56), true);
  assert.equal(alerts.length, 3);
});

test("concurrent site watch registrations are serialized without losing either target", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-watch-lock-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const monitor = startSiteMonitor({ dataDir }, { autoStart: false, targets: [], sendAlertsImpl: async () => {} });
  await Promise.all([
    monitor.watch({ factory: "0x1111111111111111111111111111111111111111", website: "https://one.example", name: "One" }),
    monitor.watch({ factory: "0x2222222222222222222222222222222222222222", website: "https://two.example", name: "Two" }),
  ]);
  const watchlist = JSON.parse(await fs.readFile(path.join(dataDir, "site-watchlist.json"), "utf8"));
  assert.deepEqual(watchlist.map(({ id }) => id).sort(), [
    "auto-0x1111111111111111111111111111111111111111",
    "auto-0x2222222222222222222222222222222222222222",
  ]);
});

test("a site drift after a long source outage silently rebuilds and records the real outage", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-long-recovery-"));
  const target = { id: "long", name: "Long", website: "https://long.example" };
  const alerts = [];
  const repositoryEvidence = [];
  let html = "Factory V2";
  let failing = false;
  let currentTime = new Date("2026-08-06T00:00:00.000Z");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  const monitor = startSiteMonitor({ dataDir, siteRetryBaseMs: 1_000, siteRetryMaxMs: 8_000 }, {
    autoStart: false,
    targets: [target],
    now: () => new Date(currentTime),
    random: () => 0.5,
    fetchImpl: async () => {
      if (failing) {
        const error = new Error("source timeout");
        error.name = "TimeoutError";
        throw error;
      }
      return { ok: true, status: 200, text: async () => html };
    },
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    onOfficialRepository: async (_repository, evidence) => repositoryEvidence.push(evidence),
  });
  await monitor.check();
  failing = true;
  currentTime = new Date("2026-08-06T00:00:01.000Z");
  await monitor.check();
  failing = false;
  html = 'Factory V2 V3 <a href="https://github.com/example/contracts">GitHub</a>';
  currentTime = new Date("2026-08-06T00:11:01.000Z");
  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  assert.equal(alerts.length, 0);
  assert.equal(state.long.signals.keywords.includes("v3"), true);
  assert.equal(state._health.targets.long.lastRecovery.outageMs, 660_000);
  assert.equal(state._health.targets.long.lastRecovery.driftDetected, true);
  assert.equal(state._health.targets.long.lastRecovery.driftSuppressed, true);
  assert.equal(repositoryEvidence.length, 1);
  assert.equal(repositoryEvidence[0].suppressAlert, true);
  assert.equal(repositoryEvidence[0].recovery.outageMs, 660_000);
});

test("a site drift after a short outage alerts with explicit recovery metadata", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-short-recovery-"));
  const target = { id: "short", name: "Short", website: "https://short.example" };
  const alerts = [];
  let html = "Factory V2";
  let failing = false;
  let currentTime = new Date("2026-08-06T00:00:00.000Z");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  const monitor = startSiteMonitor({ dataDir, siteRetryBaseMs: 1_000, siteRetryMaxMs: 8_000 }, {
    autoStart: false,
    targets: [target],
    now: () => new Date(currentTime),
    random: () => 0.5,
    fetchImpl: async () => {
      if (failing) throw new Error("temporary network failure");
      return { ok: true, status: 200, text: async () => html };
    },
    sendAlertsImpl: async (_config, event) => alerts.push(event),
  });
  await monitor.check();
  failing = true;
  currentTime = new Date("2026-08-06T00:00:01.000Z");
  await monitor.check();
  failing = false;
  html = "Factory V2 V3";
  currentTime = new Date("2026-08-06T00:05:01.000Z");
  await monitor.check();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].recovery.outageMs, 300_000);
  assert.equal(alerts[0].recovery.sourceOutage, true);
  assert.equal(alerts[0].recovery.driftSuppressed, false);
});

test("site Retry-After is never shortened by local jitter or exponential backoff", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-retry-after-"));
  const target = { id: "retry-after", name: "Retry After", website: "https://retry-after.example" };
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  const monitor = startSiteMonitor({ dataDir, siteRetryBaseMs: 1_000, siteRetryMaxMs: 8_000 }, {
    autoStart: false,
    targets: [target],
    now: () => new Date("2026-08-06T00:00:00.000Z"),
    random: () => 0.5,
    fetchImpl: async () => ({ ok: false, status: 503, headers: new Headers({ "retry-after": "900" }), text: async () => "" }),
    sendAlertsImpl: async () => {},
  });
  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  assert.equal(state._health.targets["retry-after"].backoffMs, 900_000);
  assert.equal(state._health.targets["retry-after"].nextAttemptAt, "2026-08-06T00:15:00.000Z");
});

test("scheduled site ticks coalesce into one non-concurrent catch-up cycle", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-scheduler-coalesce-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let intervalTick;
  t.mock.method(globalThis, "setInterval", (callback) => {
    intervalTick = callback;
    return { unref() {} };
  });
  t.mock.method(globalThis, "clearInterval", () => {});

  let requests = 0;
  let active = 0;
  let maximumActive = 0;
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const monitor = startSiteMonitor({ dataDir, sitePollIntervalMs: 10 }, {
    targets: [{ id: "scheduler-test", name: "Scheduler Test", website: "https://scheduler.test" }],
    sendAlertsImpl: async () => {},
    fetchImpl: async () => {
      requests += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (requests === 1) {
          markFirstStarted();
          await firstBlocked;
        }
        return { ok: true, status: 200, text: async () => "Factory V2" };
      } finally {
        active -= 1;
      }
    },
  });

  await firstStarted;
  assert.equal(await monitor.check(), undefined, "an overlapping manual check keeps its prior return value");
  const catchUp = intervalTick();
  intervalTick();
  intervalTick();
  releaseFirst();
  await catchUp;
  monitor.stop();

  assert.equal(requests, 2, "many overlapping timer ticks collapse into one immediate follow-up");
  assert.equal(maximumActive, 1, "the catch-up cycle must never overlap the active cycle");
});

test("site stop is idempotent and drains an in-flight alert plus its durable checkpoint", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-stop-drain-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const target = { id: "stop-drain", name: "Stop Drain", website: "https://stop-drain.example" };
  let html = "Factory V2";
  let releaseAlert;
  const alertBlocked = new Promise((resolve) => { releaseAlert = resolve; });
  let markAlertStarted;
  const alertStarted = new Promise((resolve) => { markAlertStarted = resolve; });
  let alertCommitted = false;
  const monitor = startSiteMonitor({ dataDir }, {
    autoStart: false,
    targets: [target],
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }),
    sendAlertsImpl: async () => {
      markAlertStarted();
      await alertBlocked;
      alertCommitted = true;
    },
  });

  await monitor.check();
  html = "Factory V2 V3";
  const checking = monitor.check();
  await alertStarted;
  const stopping = monitor.stop();
  assert.equal(monitor.stop(), stopping, "repeated stops share one drain boundary");
  assert.equal(monitor.check(), checking, "a post-stop manual check cannot start new work");
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "stop must wait for the durable alert submission");

  releaseAlert();
  await stopping;
  assert.equal(alertCommitted, true);
  assert.equal(await monitor.watch({
    factory: "0x1111111111111111111111111111111111111111",
    website: "https://late-watch.example",
    name: "Late Watch",
  }), false);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "site-state.json"), "utf8"));
  assert.equal(state[target.id].signals.keywords.includes("v3"), true);
  await assert.rejects(fs.access(path.join(dataDir, "site-watchlist.json")), { code: "ENOENT" });
});
