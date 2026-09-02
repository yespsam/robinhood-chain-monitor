import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveTradingPriority,
  legacyTradingPriority,
  withTradingPriority,
} from "../src/trading-priority.js";
import {
  drainAlertOutbox,
  focusNoveltyKeys,
  isRelevantAlert,
  sendAlerts,
} from "../src/alerts.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";
import {
  buildBilingualAlertBundle,
  renderBilingualTelegramText,
} from "../src/bilingual-alert-renderer.js";

const fixtureFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/trading-priority/events.json");
const fixtures = JSON.parse(await fs.readFile(fixtureFile, "utf8"));
const copy = (value) => structuredClone(value);

test("Binance MARSCOIN launchAt and HK0625 satisfy every deterministic T0 hard gate", () => {
  for (const [name, expectedTarget] of [["marscoin", "MARSCOINUSDT"], ["hk0625", "HK0625USDT"]]) {
    const priority = deriveTradingPriority(fixtures[name]);
    assert.equal(priority.tier, "T0", name);
    assert.equal(priority.target.type, "market", name);
    assert.equal(priority.target.value, expectedTarget, name);
    assert.equal(priority.confirmation.kind, "official", name);
    assert.equal(priority.window.basis, "launchAt", name);
    assert.deepEqual(priority.hardGates, {
      exactTarget: true,
      trustedConfirmation: true,
      validWindow: true,
      safetyPassed: true,
      t0Eligible: true,
    });
    assert.equal(priority.plan.automaticExecution, false);
  }
});

test("Binance spot, Alpha, perpetual, full-delist, and emergency catalysts share the T0 gates", () => {
  const cases = [
    ["现货首次上币", "Binance Will List MARSCOIN (MARSCOIN) with Seed Tag"],
    ["Alpha 上新", "MARSCOIN (MARSCOIN) Is Now Available on Binance Alpha"],
    ["新合约上线", "Binance Futures Will Launch MARSCOINUSDT Perpetual Contract"],
    ["整币下架", "Binance Will Delist MARSCOIN (MARSCOIN) on All Spot Trading Pairs"],
    ["安全/紧急公告", "Emergency Notice for MARSCOINUSDT Market"],
  ];
  for (const [label, title] of cases) {
    const event = copy(fixtures.marscoin);
    event.title = title;
    event.signal = { scope: "exchange", category: label, labels: [label], strong: true };
    const priority = deriveTradingPriority(event);
    assert.equal(priority.tier, "T0", label);
    assert.equal(priority.hardGates.t0Eligible, true, label);
  }

  const listingWithContract = copy(fixtures.marscoin);
  listingWithContract.token = "0x4444444444444444444444444444444444444444";
  assert.equal(deriveTradingPriority(listingWithContract).tier, "T0", "Binance does not inherit launchpad token-safety gates");

  const product = copy(fixtures.marscoin);
  product.title = "Binance Agent OS Adds a New Wallet Execution Feature";
  product.signal = { scope: "wallet", category: "产品功能上线", labels: ["新功能/产品更新"], strong: true };
  assert.equal(deriveTradingPriority(product).tier, "T1", "a product feature remains monitored below a market catalyst");
});

test("T0 fails closed when target, trusted evidence, or the trading window is missing", () => {
  const noTarget = copy(fixtures.marscoin);
  noTarget.title = "Binance Futures Will Launch a New Perpetual Contract";
  assert.notEqual(deriveTradingPriority(noTarget).tier, "T0");
  assert.equal(deriveTradingPriority(noTarget).hardGates.exactTarget, false);

  const copiedSource = copy(fixtures.marscoin);
  copiedSource.source.url = "https://binance.com.evil.example/copied";
  assert.notEqual(deriveTradingPriority(copiedSource).tier, "T0");
  assert.equal(deriveTradingPriority(copiedSource).hardGates.trustedConfirmation, false);

  const stale = copy(fixtures.marscoin);
  stale.observedAt = "2026-09-02T04:00:01.000Z";
  assert.notEqual(deriveTradingPriority(stale).tier, "T0");
  assert.equal(deriveTradingPriority(stale).hardGates.validWindow, false);
});

test("Flap infrastructure stays T1, only a safe first-token CA reaches T0, and Fomo uses independent confirmation", () => {
  const flap = deriveTradingPriority(fixtures.flapUpgrade);
  assert.equal(flap.tier, "T1");
  assert.equal(flap.target.value, fixtures.flapUpgrade.launcher);
  assert.equal(flap.confirmation.kind, "onchain");
  assert.match(flap.confirmation.value, new RegExp(`${fixtures.flapUpgrade.transactionHash}#${fixtures.flapUpgrade.blockNumber}`));

  const firstToken = deriveTradingPriority(fixtures.flapFirstToken);
  assert.equal(firstToken.tier, "T0");
  assert.equal(firstToken.target.value, fixtures.flapFirstToken.tokens[0].token);
  assert.equal(firstToken.hardGates.safetyPassed, true);

  const missingTokenCa = copy(fixtures.flapFirstToken);
  delete missingTokenCa.tokens;
  assert.equal(deriveTradingPriority(missingTokenCa).tier, "T1");

  const missingLiquidityGate = copy(fixtures.flapFirstToken);
  missingLiquidityGate.security.metrics.liquidityConfirmed = false;
  const unsafeFirstToken = deriveTradingPriority(missingLiquidityGate);
  assert.equal(unsafeFirstToken.tier, "T1");
  assert.equal(unsafeFirstToken.hardGates.safetyPassed, false);

  const single = deriveTradingPriority(fixtures.fomoBuy);
  assert.equal(single.tier, "T1");
  assert.equal(single.category, "fomo_single");
  assert.match(single.plan.entryCondition.zh, /第二个独立合格钱包/);
  assert.equal(single.plan.automaticExecution, false);

  const convergence = copy(fixtures.fomoBuy);
  convergence.signalKind = "top_blogger_convergence";
  convergence.buyerCount = 2;
  convergence.totalUsd = 7_000;
  convergence.source = { id: "cope_capital", trust: "authorized_public_api", url: "https://api.cope.capital/docs" };
  convergence.callId = "convergence-1";
  convergence.callers = [
    { handle: "alpha", walletAddress: "0x4444444444444444444444444444444444444444", followers: 25_000, amountUsd: 3_000 },
    { handle: "beta", walletAddress: "0x5555555555555555555555555555555555555555", followers: 30_000, amountUsd: 4_000 },
  ];
  const cluster = deriveTradingPriority(convergence);
  assert.equal(cluster.tier, "T0");
  assert.equal(cluster.category, "fomo_cluster");

  const duplicateParticipant = copy(convergence);
  duplicateParticipant.callers[1] = { ...duplicateParticipant.callers[0] };
  assert.notEqual(deriveTradingPriority(duplicateParticipant).tier, "T0",
    "the same caller/wallet repeated twice is not a two-wallet cluster");

  const official = copy(fixtures.fomoBuy);
  delete official.transactionHash;
  delete official.blockNumber;
  official.signalKind = "fomo_published_call";
  official.source = { id: "fomo_family_official_thesis", trust: "official_authenticated_api" };
  const exactCall = deriveTradingPriority(official);
  assert.equal(exactCall.tier, "T0");
  assert.equal(exactCall.category, "fomo_official_exact");

  const unsafeFlapToken = copy(fixtures.flapUpgrade);
  unsafeFlapToken.token = "0x5555555555555555555555555555555555555555";
  unsafeFlapToken.security = { decision: "block", metrics: { liquidityConfirmed: false } };
  const blocked = deriveTradingPriority(unsafeFlapToken);
  assert.equal(blocked.hardGates.safetyPassed, false);
  assert.equal(blocked.tier, "T1", "a local safety rejection remains a loud risk warning without becoming T0");
  assert.equal(blocked.plan.conclusion.zh, "不做");
  assert.equal(blocked.plan.automaticExecution, false);
});

test("Binance activities and ordinary announcements remain T2 while routine code is T3", () => {
  const activity = copy(fixtures.marscoin);
  activity.signal = { scope: "exchange", category: "活动公告", labels: ["活动/奖励公告"], strong: false };
  activity.title = "Binance Alpha Trading Campaign: Trade ABC and Share Rewards";
  delete activity.launchAt;
  assert.equal(deriveTradingPriority(activity).tier, "T2");

  const activityWithListingWords = copy(activity);
  activityWithListingWords.title = "Binance Alpha Campaign: Add FOOUSDT to Watchlist and Earn Rewards";
  assert.equal(deriveTradingPriority(activityWithListingWords).tier, "T2",
    "structured campaign labels outrank ambiguous listing words in marketing copy");

  const ordinary = copy(activity);
  ordinary.signal = { scope: "exchange", category: "普通公告", labels: ["普通官方公告"], strong: false };
  ordinary.title = "Binance Publishes an Ordinary Service Notice";
  assert.equal(deriveTradingPriority(ordinary).tier, "T2");

  const code = {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/flap-contracts",
    commit: "abcdef1234567890abcdef1234567890abcdef12",
    sourceTrust: "official_verified",
    message: "docs: clarify integration example",
    observedAt: "2026-09-02T01:30:00.000Z",
  };
  assert.equal(deriveTradingPriority(code).tier, "T3");

  const rejectedModeCandidate = {
    ...code,
    modeChange: { candidate: false, reason: "generic_release_wording" },
  };
  assert.equal(deriveTradingPriority(rejectedModeCandidate).tier, "T3",
    "a rejected mode candidate must not promote routine code");

  const materialFocusCode = {
    ...code,
    strong: true,
    modeChange: { candidate: true, reason: "new_chain_support" },
  };
  assert.equal(deriveTradingPriority(materialFocusCode).tier, "T1", "an admitted Flap structural update keeps its strong lane");

  const communityPullRequest = {
    ...materialFocusCode,
    developmentStage: "pull_request",
    pullRequest: { number: 9, state: "open", authorAssociation: "NONE" },
  };
  assert.equal(deriveTradingPriority(communityPullRequest).tier, "T3", "an external open PR remains ordinary");

  const telegramNews = {
    type: "telegram_news_update",
    strong: true,
    project: { id: "binance" },
    title: "Binance Will List TGNEWSUSDT",
    launchAt: "2026-09-02T03:00:00.000Z",
    observedAt: "2026-09-02T01:00:00.000Z",
    source: {
      id: "binance_exchange_cms",
      url: "https://www.binance.com/en/support/announcement/detail/spoofed-channel-headline",
    },
  };
  assert.equal(deriveTradingPriority(telegramNews).tier, "T2", "Telegram news can never self-promote to T0");
});

test("structured Binance product features are T1 while SDK and schema maintenance stay T3", () => {
  const githubFeature = {
    type: "github_module_update",
    launchpad: "Binance",
    repository: "binance/binance-skills-hub",
    sourceTrust: "official_verified",
    binanceChange: { classification: "product_feature", productFeature: true, substantive: true },
    message: "feat: add multi-signal decision-fusion skill",
    committedAt: "2026-09-02T01:30:00.000Z",
    observedAt: "2026-09-02T01:30:01.000Z",
  };
  const githubPriority = deriveTradingPriority(githubFeature);
  assert.equal(githubPriority.category, "binance_product");
  assert.equal(githubPriority.tier, "T1");

  const developerFeature = {
    type: "binance_official_update",
    kind: "developer_update",
    project: { id: "binance", name: "Binance" },
    title: "Developer 文档目录 官方更新",
    addedSignals: ["[Binance MCP Server](/en/docs/agent-native/mcp-server/agentic.md)"],
    source: { id: "binance_developer_docs", url: "https://developers.binance.com/en/docs/llms.txt" },
    url: "https://developers.binance.com/en/docs/llms.txt",
    observedAt: "2026-09-02T01:30:01.000Z",
  };
  const developerPriority = deriveTradingPriority(developerFeature);
  assert.equal(developerPriority.category, "binance_product");
  assert.equal(developerPriority.tier, "T1");

  const sdkMaintenance = {
    ...githubFeature,
    binanceChange: { classification: "api_or_schema_change", productFeature: false, substantive: true },
    message: "feat: change response schema for a connector method",
  };
  assert.equal(deriveTradingPriority(sdkMaintenance).tier, "T3");

  const listingExampleInDocs = {
    ...githubFeature,
    repository: "binance/binance-spot-api-docs",
    binanceChange: { classification: "connector_code_change", productFeature: false, substantive: false },
    message: "docs: example: Binance will list FAKEUSDT perpetual contract",
  };
  const docsPriority = deriveTradingPriority(listingExampleInDocs);
  assert.equal(docsPriority.category, "developer_maintenance");
  assert.equal(docsPriority.tier, "T3", "repository prose cannot self-promote into a listing catalyst");
});

test("a verified two-wallet Fomo convergence passes source, relevance, and durable enqueue gates", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-convergence-priority-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const observedAt = new Date().toISOString();
  const publishedAt = new Date(Date.now() - 2_000).toISOString();
  const event = {
    type: "fomo_family_top_call",
    eventKey: "fomo-call:top_blogger_convergence:verified-two-wallets",
    signalKind: "top_blogger_convergence",
    callId: "verified-two-wallets",
    qualified: true,
    strong: true,
    activity: "buy",
    action: "buy",
    side: "buy",
    trade: "buy",
    chain: { id: 56, chainId: 56, slug: "bsc", name: "BNB Smart Chain" },
    token: "0x2222222222222222222222222222222222222222",
    contractAddress: "0x2222222222222222222222222222222222222222",
    tokenSymbol: "FOMO",
    buyerCount: 2,
    totalUsd: 7_000,
    callers: [
      { handle: "alpha", walletAddress: "0x4444444444444444444444444444444444444444", followers: 25_000, amountUsd: 3_000 },
      { handle: "beta", walletAddress: "0x5555555555555555555555555555555555555555", followers: 30_000, amountUsd: 4_000 },
    ],
    source: { id: "cope_capital", trust: "authorized_public_api", url: "https://api.cope.capital/docs" },
    sourceTrust: "authorized_public_api",
    market: { liquidityUsd: 65_000, sellsM5: 8 },
    security: { decision: "pass", metrics: { liquidityConfirmed: true, sellObserved: true } },
    publishedAt,
    observedAt,
  };
  const config = {
    dataDir,
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    fomoCallEnabled: true,
    fomoBuyMonitorEnabled: true,
    fomoCallMinConvergenceUsd: 5_000,
    fomoCallMinXFollowers: 10_000,
    fomoCallMaxSignalAgeMs: 300_000,
    blockedContracts: new Set(),
    webhookUrl: "https://webhook.example/alerts",
    telegramToken: "",
    telegramChatId: "",
  };
  assert.equal(isMonitoringSourceEnabled(config, event), true);
  assert.equal(isRelevantAlert(event), true);
  assert.equal(deriveTradingPriority(event).tier, "T0");
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, text: async () => "" }));
  const result = await sendAlerts(config, event);
  assert.ok(["queued", "delivered"].includes(result.status), JSON.stringify(result));
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(Object.values(outbox.events).length, 1);
  const storedEvent = Object.values(outbox.events)[0].event;
  assert.equal(storedEvent.tradingPriority.tier, "T0");
  assert.ok(storedEvent.canonicalSignalIds.includes(`fomo:convergence:bsc:${event.token}`));

  const lowThreshold = copy(event);
  lowThreshold.eventKey = "fomo-call:top_blogger_convergence:custom-threshold";
  lowThreshold.callId = "custom-threshold";
  lowThreshold.token = "0x6666666666666666666666666666666666666666";
  lowThreshold.contractAddress = lowThreshold.token;
  lowThreshold.totalUsd = 1_500;
  lowThreshold.callers = [
    { ...lowThreshold.callers[0], followers: 1_000, amountUsd: 700 },
    { ...lowThreshold.callers[1], followers: 1_200, amountUsd: 800 },
  ];
  const customThresholdConfig = {
    ...config,
    fomoCallMinConvergenceUsd: 1_000,
    fomoCallMinXFollowers: 500,
  };
  assert.equal(isMonitoringSourceEnabled(customThresholdConfig, lowThreshold), true);
  assert.equal(isRelevantAlert(lowThreshold), true, "relevance must not re-impose the default USD/follower thresholds");
  const lowResult = await sendAlerts(customThresholdConfig, lowThreshold);
  assert.ok(["queued", "delivered"].includes(lowResult.status), JSON.stringify(lowResult));

  const stale = copy(lowThreshold);
  stale.observedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  stale.publishedAt = new Date(Date.now() - 60 * 60_000 - 2_000).toISOString();
  assert.equal(isRelevantAlert(stale), true, "relevance checks timestamp shape but not configurable freshness");
  assert.equal(isMonitoringSourceEnabled(customThresholdConfig, stale), false, "source policy owns freshness");

  const spoofedSource = copy(lowThreshold);
  spoofedSource.source = { ...spoofedSource.source, url: "https://api.cope.capital.attacker.example/docs" };
  assert.equal(isRelevantAlert(spoofedSource), false);
  assert.equal(isMonitoringSourceEnabled(customThresholdConfig, spoofedSource), false);

  const duplicate = copy(event);
  duplicate.eventKey = "fomo-call:top_blogger_convergence:duplicate-wallet";
  duplicate.callId = "duplicate-wallet";
  duplicate.callers[1] = { ...duplicate.callers[0], handle: "beta" };
  assert.equal(isMonitoringSourceEnabled(config, duplicate), false);
  assert.equal(isRelevantAlert(duplicate), false);
  assert.notEqual(deriveTradingPriority(duplicate).tier, "T0");

});

test("MEME ARENA live lifecycle cannot be covered by an old OpenFour concept key", () => {
  const live = focusNoveltyKeys(fixtures.memeArena);
  const prior = focusNoveltyKeys({
    type: "platform_capability_update",
    platform: { id: "fourmeme", name: "Four.Meme" },
    changes: { newModules: ["OpenFour developer module"] },
    message: "OpenFour developer modules are available",
  });
  assert.ok(live.includes("fourmeme:lifecycle:meme-arena:live"), live.join("\n"));
  assert.ok(prior.includes("fourmeme:concept:openfour"), prior.join("\n"));
  assert.equal(prior.includes("fourmeme:lifecycle:meme-arena:live"), false);

  const announced = copy(fixtures.memeArena);
  announced.tweet.text = "Four.Meme announces MEME ARENA for OpenFour Tax Tokens; coming soon.";
  const announcedKeys = focusNoveltyKeys(announced);
  assert.ok(announcedKeys.includes("fourmeme:lifecycle:meme-arena:announced"));
  assert.equal(announcedKeys.includes("fourmeme:lifecycle:meme-arena:live"), false);

  const producerKey = "fourmeme:lifecycle:meme-arena:season-2-live";
  const explicit = copy(fixtures.memeArena);
  explicit.lifecycleKey = producerKey;
  assert.ok(focusNoveltyKeys(explicit).includes(producerKey), "a producer lifecycle key remains byte-stable");
});

test("T0/T1 cards are local deterministic two-field bilingual bundles and never wait for translation", async () => {
  let translationCalls = 0;
  const config = {
    alertTranslationFetchImpl: async () => {
      translationCalls += 1;
      return { ok: false, status: 503, text: async () => "unavailable" };
    },
    alertTranslationTimeoutMs: 50,
  };
  for (const sourceEvent of [fixtures.marscoin, fixtures.fomoBuy]) {
    const event = withTradingPriority(sourceEvent);
    const bundle = await buildBilingualAlertBundle(config, event, [
      "official monitoring update",
      `具体更新: ${event.title || event.tokenSymbol}`,
      "状态: verified source",
      `时间: ${event.observedAt}`,
    ].join("\n"));
    const rendered = renderBilingualTelegramText(bundle, true);
    assert.ok(["T0", "T1"].includes(bundle.priority.tier));
    if (sourceEvent === fixtures.marscoin) {
      assert.equal(bundle.priority.label.zh, "最高优先催化");
      assert.equal(bundle.priority.label.en, "Top-priority catalyst");
      assert.match(bundle.zh.text, /上线 UTC=2026-09-02T03:00:00\.000Z/);
      assert.match(bundle.en.text, /Launch UTC=2026-09-02T03:00:00\.000Z/);
    }
    if (sourceEvent === fixtures.fomoBuy) {
      assert.match(bundle.zh.text, /Buy \$1,250/);
      assert.match(bundle.en.text, /Buy \$1,250/);
    }
    assert.equal(bundle.priority.plan.automaticExecution, false);
    assert.equal(bundle.zh.provider, "local_structured");
    assert.equal(bundle.en.provider, "local_structured");
    assert.equal(bundle.zh.text.split("\n").length, 2);
    assert.equal(bundle.en.text.split("\n").length, 2);
    assert.match(bundle.zh.text, /^平台：.* · T[01]$/m);
    assert.match(bundle.zh.text, /^更新了什么：/m);
    assert.match(bundle.en.text, /^Platform: .* · T[01]$/m);
    assert.match(bundle.en.text, /^What changed: /m);
    assert.match(bundle.zh.text, /非自动交易/);
    assert.match(bundle.en.text, /no auto-trading/);
    assert.ok(rendered.length <= 600, `card=${rendered.length}`);
  }
  assert.equal(translationCalls, 0);
});

test("outbox drain orders T0>T1>T2>T3 and maps legacy strong/ordinary safely", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "trading-priority-outbox-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = new Date();
  const iso = (offsetMs) => new Date(now.getTime() + offsetMs).toISOString();
  const t0 = copy(fixtures.marscoin);
  t0.publishedAt = iso(-2_000);
  t0.observedAt = iso(-1_000);
  t0.launchAt = iso(60_000);
  const t1Legacy = {
    type: "platform_capability_update",
    eventKey: "priority-fixture:t1",
    platform: { id: "flap", name: "Flap" },
    changes: { newModules: ["Vault V3"] },
    strong: true,
    observedAt: iso(-900),
  };
  const t2Legacy = copy(fixtures.marscoin);
  t2Legacy.eventKey = "priority-fixture:t2";
  t2Legacy.signal = { scope: "exchange", category: "活动公告", labels: ["活动/奖励公告"], strong: false };
  t2Legacy.title = "Binance Trading Campaign: Trade ABC and Share Rewards";
  t2Legacy.strong = false;
  t2Legacy.publishedAt = iso(-800);
  t2Legacy.observedAt = iso(-700);
  delete t2Legacy.launchAt;
  const t3 = {
    type: "github_module_update",
    eventKey: "priority-fixture:t3",
    launchpad: "Flap",
    repository: "flap-sh/flap-contracts",
    commit: "abcdef1234567890abcdef1234567890abcdef12",
    sourceTrust: "official_verified",
    strong: true,
    modeChange: { candidate: true },
    developmentStage: "pull_request",
    pullRequest: { number: 99, state: "open", authorAssociation: "NONE" },
    message: "docs: clarify VaultFactory integration",
    observedAt: iso(-600),
  };
  t0.tradingPriority = deriveTradingPriority(t0);
  t3.tradingPriority = deriveTradingPriority(t3);
  assert.equal(t0.tradingPriority.tier, "T0");
  assert.equal(t3.tradingPriority.tier, "T3");
  const health = {
    type: "fomo_monitor_health_update",
    eventKey: "fomo-health:aggregate-1788320000000:opened",
    lane: "aggregate",
    transition: "opened",
    incidentId: "aggregate-1788320000000",
    aggregateStatus: "critical",
    observedAt: iso(-50_000),
    openedAt: iso(-50_000),
    durationMs: 0,
    reasonCodes: ["call_state_stale"],
    summary: {
      smartMoney: { status: "healthy", admitted: 1, fresh: 1, lastKnownGood: 0 },
      bsc: { status: "healthy" },
      x: { status: "healthy", live: 23, eligible: 23 },
      thesis: { status: "critical" },
      outbox: { status: "healthy", pending: 0, failed: 0 },
    },
    source: { id: "local_fomo_health_watchdog", trust: "local_persisted_health" },
    sourceTrust: "local_persisted_health",
    strong: false,
  };

  const entries = [
    ["t3", t3, iso(-40_000)],
    ["t2", t2Legacy, iso(-30_000)],
    ["t1-older", { ...t1Legacy, eventKey: "priority-fixture:t1-older" }, iso(-25_000)],
    ["t1", t1Legacy, iso(-20_000)],
    ["health", health, iso(-15_000)],
    ["t0", t0, iso(-10_000)],
  ];
  const outbox = { version: 2, events: {} };
  for (const [id, event, createdAt] of entries) {
    outbox.events[id] = {
      id,
      event,
      eventType: event.type,
      status: "pending",
      destinations: { webhook: { status: "pending", attempts: 0, nextAttemptAt: null, receipt: null, lastError: null } },
      createdAt,
      updatedAt: createdAt,
      deliveredAt: null,
      suppressedAt: null,
      duplicateCount: 0,
      duplicateObservations: [],
      sideEffectsCommitted: false,
    };
  }
  await fs.writeFile(path.join(dataDir, "alert-outbox.json"), `${JSON.stringify(outbox)}\n`);

  const delivered = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    delivered.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => "" };
  });
  t.mock.method(console, "info", () => {});
  const count = await drainAlertOutbox({
    dataDir,
    monitorScope: "focus3",
    fomoHealthMonitorEnabled: true,
    ponsMonitorEnabled: false,
    binanceMonitorEnabled: true,
    blockedContracts: new Set(),
    webhookUrl: "https://webhook.example/alerts",
    telegramToken: "",
    telegramChatId: "",
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
  });
  assert.equal(count, 6);
  assert.deepEqual(
    delivered.map((event) => event.type === "fomo_monitor_health_update" ? "HEALTH" : event.tradingPriority.tier),
    ["T0", "HEALTH", "T1", "T1", "T2", "T3"],
  );
  assert.equal(delivered[1].tradingPriority, undefined, "health keeps its closed non-trading schema");
  assert.deepEqual(delivered.slice(2, 4).map((event) => event.eventKey), ["priority-fixture:t1-older", "priority-fixture:t1"]);
  assert.equal(delivered[2].tradingPriority.schema.endsWith(":legacy"), true);
  assert.equal(delivered[4].tradingPriority.schema.endsWith(":legacy"), true);
  assert.equal(legacyTradingPriority({ strong: true }).tier, "T1");
  assert.equal(legacyTradingPriority({ strong: false }).tier, "T2");
  assert.equal(withTradingPriority({ strong: true }, { legacy: true }).tradingPriority.tier, "T1");
});
