import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRADING_PRIORITY_VERSION,
  deriveTradingPriority,
  legacyTradingPriority,
  withTradingPriority,
} from "../src/trading-priority.js";
import {
  alertDeliveryDisposition,
  classifyAlertFreshness,
  drainAlertOutbox,
  focusNoveltyKeys,
  isRelevantAlert,
  sendAlerts,
  telegramButtons,
} from "../src/alerts.js";
import { isMonitoringSourceEnabled, isOfficialFourMemeCapabilityUpdate } from "../src/source-controls.js";
import { classifyFourMemeOfficialText } from "../src/twitter-monitor.js";
import {
  buildBilingualAlertBundle,
  renderBilingualTelegramText,
} from "../src/bilingual-alert-renderer.js";

const fixtureFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/trading-priority/events.json");
const fixtures = JSON.parse(await fs.readFile(fixtureFile, "utf8"));
const copy = (value) => structuredClone(value);
const FOUR_TEMPLATE_URL = "https://four.meme/meme-api/v1/public/token_template/search";
const fourMemeTemplateEvent = ({ changeType = "published_template_changed", currentStatus = "PUBLISHED" } = {}) => {
  const observedAt = "2026-09-04T05:00:00.000Z";
  const fingerprint = `template-${changeType}`;
  const currentTemplate = { id: "9", name: "ListaYield", status: currentStatus };
  const previousTemplate = changeType === "new_published_template"
    ? null
    : { id: "9", name: "ListaYield", status: "PUBLISHED" };
  return {
    type: "bsc_launchpad_update",
    kind: "new_mode",
    changeType,
    eventKey: `bsc-official-mode:fourmeme:9:${fingerprint}`,
    chainId: 56,
    platform: { id: "fourmeme", name: "Four.Meme", trust: "official_verified" },
    tokens: [],
    pools: [],
    previousTemplate,
    currentTemplate,
    changedFields: changeType === "new_published_template" ? ["template"] : ["status"],
    mode: {
      selector: "official-template",
      fingerprint,
      officialName: "ListaYield",
      componentMode: "ListaYield",
      template: { id: "9", name: "ListaYield", status: currentStatus, fingerprint, changeType },
      sourceUrl: FOUR_TEMPLATE_URL,
    },
    structural: { eligible: true, source: "official_api" },
    officialCapability: {
      version: 1,
      platform: "fourmeme",
      kind: "template",
      changeType,
      sourceId: "fourmeme_public_template_api",
      sourceUrl: FOUR_TEMPLATE_URL,
      observedAt,
    },
    source: {
      id: "fourmeme_public_template_api",
      name: "Four.Meme public template API",
      url: FOUR_TEMPLATE_URL,
      trust: "official_verified",
      official: true,
    },
    sourceTrust: "official_verified",
    sourceUrl: FOUR_TEMPLATE_URL,
    observedAt,
    strong: true,
  };
};
const withInstrumentChange = (source, {
  action = "launch",
  market = "usd_m_perpetual",
  instruments = null,
  instrument = null,
  launchAt = source.launchAt,
  effectiveAt = null,
} = {}) => {
  const event = copy(source);
  const fallback = instrument || event.marketSymbol || event.title?.match(/([\p{L}\p{N}._-]+USDT)/u)?.[1];
  event.announcementDetails = {
    kind: "instrument_change",
    action,
    market,
    ...(fallback ? { instrument: fallback } : {}),
    ...(launchAt ? { launchAt } : {}),
    ...(effectiveAt ? { effectiveAt } : {}),
    ...(instruments ? { instruments } : {}),
  };
  return event;
};

test("Binance MARSCOIN launchAt and HK0625 satisfy every deterministic T0 hard gate", () => {
  for (const [name, expectedTarget] of [["marscoin", "MARSCOINUSDT"], ["hk0625", "HK0625USDT"]]) {
    const event = withInstrumentChange(fixtures[name], { instrument: expectedTarget });
    const priority = deriveTradingPriority(event);
    assert.equal(priority.tier, "T0", name);
    assert.equal(priority.target.type, "market", name);
    assert.equal(priority.target.value, expectedTarget, name);
    assert.equal(priority.confirmation.kind, "official", name);
    assert.equal(priority.window.basis, "launchAt", name);
    assert.deepEqual(priority.hardGates, {
      exactTarget: true,
      completeTargetSet: true,
      trustedConfirmation: true,
      validWindow: true,
      safetyPassed: true,
      explicitPath: true,
      t0Eligible: true,
      t1Eligible: true,
    });
    assert.deepEqual(priority.targets.map((target) => target.value), [expectedTarget]);
    assert.equal(priority.plan.automaticExecution, false);
  }
});

test("Four.Meme strict bStock campaign is T2 immediate while incomplete stock marketing stays closed", () => {
  const createdAt = "2026-09-04T03:21:47.000Z";
  const text = `bStocks szn just got competitive. 🟢

150,000 USDT is now live with @AveaiGlobal × @BNBCHAIN — including a 50,000 USDT leaderboard exclusively for http://Four.Meme traders.

Trade http://Four.Meme Stock Memes on http://Ave.ai.
Climb the Top 500.
Take your share.

The sprint is on. 🏁`;
  const event = {
    type: "twitter_update",
    project: {
      id: "fourmeme",
      name: "Four.meme",
      website: "https://four.meme",
      twitter: "https://x.com/fourdotmemezh",
      handle: "fourdotmemezh",
      xUserId: "1816036559864619011",
      match: "official_x",
    },
    tweet: {
      id: "2095713912188739967",
      text,
      createdAt,
      handle: "fourdotmemezh",
      xUserId: "1816036559864619011",
      authorId: "1816036559864619011",
      url: "https://x.com/fourdotmemezh/status/2095713912188739967",
      sourceVerifiedBy: "official_x_oembed",
      identityVerifiedBy: "fxtwitter_exact_numeric_id",
      isReply: false,
    },
    signal: classifyFourMemeOfficialText(text),
    observedAt: "2026-09-04T03:22:00.000Z",
  };
  assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3" }, event), true);
  const prioritized = withTradingPriority(event, { nowMs: Date.parse(event.observedAt) });
  assert.equal(prioritized.tradingPriority.category, "focus_market_campaign");
  assert.equal(prioritized.tradingPriority.tier, "T2");
  assert.equal(prioritized.tradingPriority.hardGates.explicitPath, false);
  assert.equal(prioritized.tradingPriority.hardGates.t1Eligible, false);
  assert.match(prioritized.tradingPriority.plan.entryCondition.zh, /未指定代币 CA/);
  assert.match(prioritized.tradingPriority.plan.capitalPath.zh, /不是协议升级/);
  assert.equal(prioritized.tradingPriority.plan.automaticExecution, false);
  assert.deepEqual(alertDeliveryDisposition(prioritized), {
    mode: "immediate",
    deliverImmediately: true,
    tier: "T2",
    reason: "fourmeme_market_campaign",
  });
  assert.deepEqual(telegramButtons(prioritized), {
    inline_keyboard: [[{
      text: "𝕏 查看原推",
      url: "https://x.com/fourdotmemezh/status/2095713912188739967",
    }]],
  });

  const incomplete = copy(event);
  incomplete.tweet.text = "Four.Meme bStocks competition with @AveaiGlobal: share 150,000 USDT.";
  incomplete.signal = classifyFourMemeOfficialText(incomplete.tweet.text);
  assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3" }, incomplete), false);
});

test("Four.Meme official template snapshots and authoritative removals use the T1 official lane", () => {
  for (const templateEvent of [
    fourMemeTemplateEvent(),
    fourMemeTemplateEvent({ changeType: "template_unpublished", currentStatus: "DISABLED" }),
  ]) {
    assert.equal(isOfficialFourMemeCapabilityUpdate(templateEvent), true);
    assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3" }, templateEvent), true);
    const freshness = classifyAlertFreshness({}, templateEvent, Date.parse(templateEvent.observedAt) + 30_000);
    assert.equal(freshness.scope, "fourmeme_official_capability");
    assert.equal(freshness.basis, "observedAt_continuous_coverage");
    assert.equal(freshness.decision, "realtime");
    const prioritized = withTradingPriority({ ...templateEvent, freshness }, { nowMs: Date.parse(templateEvent.observedAt) + 30_000 });
    assert.equal(prioritized.tradingPriority.category, "focus_official");
    assert.equal(prioritized.tradingPriority.tier, "T1");
    assert.equal(prioritized.tradingPriority.hardGates.explicitPath, true);
    assert.equal(isRelevantAlert(prioritized), true);
    assert.equal(alertDeliveryDisposition(prioritized).deliverImmediately, true);
  }

  const removal = {
    type: "platform_capability_update",
    platform: { id: "fourmeme", name: "Four.Meme", website: "https://four.meme" },
    url: "https://four.meme/meme-api/v1/public/config",
    observedAt: "2026-09-04T05:00:00.000Z",
    changes: {
      removedQuoteConfigs: [{ symbol: "UUSD", address: "0x1111111111111111111111111111111111111111" }],
    },
  };
  assert.equal(isMonitoringSourceEnabled({ monitorScope: "focus3" }, removal), true);
  const prioritizedRemoval = withTradingPriority(removal, { nowMs: Date.parse(removal.observedAt) + 30_000 });
  assert.equal(prioritizedRemoval.tradingPriority.tier, "T1");
  assert.equal(prioritizedRemoval.tradingPriority.hardGates.explicitPath, true);
  assert.equal(isRelevantAlert(prioritizedRemoval), true);
  assert.deepEqual(focusNoveltyKeys(removal), [
    "fourmeme:quote:0x1111111111111111111111111111111111111111:removed",
  ]);
});

test("Four.Meme official template publish and unpublish traverse source, priority, outbox, and Telegram once each", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fourmeme-template-outbox-"));
  const payloads = [];
  const nowMs = Date.parse("2026-09-04T05:00:30.000Z");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }),
    };
  });
  t.mock.method(console, "info", () => {});
  const config = {
    dataDir,
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    blockedContracts: new Set(),
    telegramToken: "test-bot-token-secret",
    telegramChatId: "1234567890",
    telegramStrongAlerts: false,
    webhookUrl: "",
    alertNow: () => nowMs,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertEnglishTranslationEnabled: false,
  };
  const published = fourMemeTemplateEvent();
  const unpublished = fourMemeTemplateEvent({ changeType: "template_unpublished", currentStatus: "DISABLED" });

  const first = await sendAlerts(config, published);
  const second = await sendAlerts(config, unpublished);
  assert.equal(first.status, "delivered");
  assert.equal(second.status, "delivered");
  assert.equal(payloads.length, 2);

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const publishedEntry = outbox.events[published.eventKey];
  const unpublishedEntry = outbox.events[unpublished.eventKey];
  assert.equal(publishedEntry.status, "delivered");
  assert.equal(unpublishedEntry.status, "delivered");
  assert.equal(publishedEntry.event.tradingPriority.tier, "T1");
  assert.equal(unpublishedEntry.event.tradingPriority.tier, "T1");
  assert.equal(publishedEntry.deliveryDisposition.deliverImmediately, true);
  assert.equal(unpublishedEntry.deliveryDisposition.deliverImmediately, true);
  assert.match(publishedEntry.event.canonicalSignalIds[0], /^fourmeme:official-template:9:published-template-changed:/u);
  assert.match(unpublishedEntry.event.canonicalSignalIds[0], /^fourmeme:official-template:9:template-unpublished:/u);
  assert.notDeepEqual(publishedEntry.event.canonicalSignalIds, unpublishedEntry.event.canonicalSignalIds);
  assert.equal(unpublishedEntry.event.tradingPriority.plan.automaticExecution, false);
  assert.match(unpublishedEntry.event.tradingPriority.plan.entryCondition.zh, /重新发布|恢复/u);
});

test("crypto perpetual and perpetual-delist cards use action-aware derivatives paths", async () => {
  const config = { alertTranslationTimeoutMs: 50 };
  const launch = withTradingPriority(withInstrumentChange(fixtures.marscoin, {
    action: "launch",
    market: "usd_m_perpetual",
    instrument: "MARSCOINUSDT",
  }));
  const launchBundle = await buildBilingualAlertBundle(config, launch, `official monitoring update\n具体更新: ${launch.title}\n状态: verified source\n时间: ${launch.observedAt}`);
  const launchCard = renderBilingualTelegramText(launchBundle, true);
  assert.match(launchCard, /事件：新增 MARSCOINUSDT U 本位永续合约/u);
  assert.match(launchCard, /Event: Added the MARSCOINUSDT USDⓈ-M perpetual contract/u);
  assert.doesNotMatch(launchCard, /风险|Risk|入场=|entry=|失效=|invalid=|非自动交易|no automatic trading/iu);
  assert.doesNotMatch(launchCard, /现货\/Alpha→|spot\/Alpha→/iu);

  const delistSource = withInstrumentChange(fixtures.marscoin, {
    action: "delist",
    market: "usd_m_perpetual",
    instrument: "MARSCOINUSDT",
    launchAt: null,
    effectiveAt: fixtures.marscoin.launchAt,
  });
  delistSource.title = "Binance Futures Will Delist MARSCOINUSDT Perpetual Contract";
  delistSource.signal = { category: "整币下架", labels: ["整币下架"], strong: true };
  const delist = withTradingPriority(delistSource);
  const delistBundle = await buildBilingualAlertBundle(config, delist, `official monitoring update\n具体更新: ${delist.title}\n状态: verified source\n时间: ${delist.observedAt}`);
  const delistCard = renderBilingualTelegramText(delistBundle, true);
  assert.match(delist.tradingPriority.plan.entryCondition.zh, /不新增仓位.*结算时间/u);
  assert.match(delistCard, /事件：Binance Futures Will Delist MARSCOINUSDT Perpetual Contract/u);
  assert.match(delistCard, /Event: Binance Futures Will Delist MARSCOINUSDT Perpetual Contract/u);
  assert.doesNotMatch(delistCard, /风险|Risk|入场=|entry=|失效=|invalid=|非自动交易|no automatic trading/iu);
  assert.doesNotMatch(delistCard, /现货\/Alpha→|spot\/Alpha→/iu);
});

test("structured Binance targets preserve Unicode and validate every multi-instrument time", () => {
  const event = withInstrumentChange(fixtures.marscoin, {
    instrument: "牛来USDT",
    instruments: [
      { symbol: "牛来USDT", launchAt: "2026-09-02T03:00:00.000Z", pairs: ["牛来/USDT"] },
      { symbol: "HK0625USDT", launchAt: "2026-09-02T03:05:00.000Z" },
    ],
  });
  event.title = "Binance Futures Will Launch Multiple USDⓈ-Margined TradFi Perpetual Contracts";
  const priority = deriveTradingPriority(event);
  assert.equal(priority.tier, "T0");
  assert.equal(priority.target.value, "牛来USDT");
  assert.deepEqual(priority.targets.map((target) => target.value), ["牛来USDT", "HK0625USDT"]);
  assert.equal(priority.window.launchAt, "2026-09-02T03:00:00.000Z");
  assert.match(priority.plan.mainline.zh, /新永续入口/);
  assert.match(priority.plan.risk.zh, /永续合约不等于现货股票/);

  const malformed = copy(event);
  malformed.announcementDetails.instruments[1].symbol = "BAD\u0007USDT";
  assert.equal(deriveTradingPriority(malformed).tier, "T2");
  assert.equal(deriveTradingPriority(malformed).hardGates.completeTargetSet, false);

  const singleCharacterSpot = withInstrumentChange(fixtures.marscoin, {
    action: "list",
    market: "spot",
    instrument: "O",
    instruments: [{ symbol: "O", launchAt: fixtures.marscoin.launchAt, pairs: ["O/USDT"] }],
  });
  singleCharacterSpot.title = "Binance Will List O (O) and Open Spot Trading";
  singleCharacterSpot.signal = { category: "现货首次上币", labels: ["现货首次上币"], strong: true };
  const singleCharacterPriority = deriveTradingPriority(singleCharacterSpot);
  assert.equal(singleCharacterPriority.tier, "T0");
  assert.equal(singleCharacterPriority.target.value, "O");
  assert.deepEqual(singleCharacterPriority.targets[0].pairs, ["O/USDT"]);
});

test("Binance spot, Alpha, perpetual, full-delist, and emergency catalysts share the T0 gates", () => {
  const cases = [
    ["现货首次上币", "Binance Will List MARSCOIN (MARSCOIN) with Seed Tag"],
    ["Alpha 上新", "MARSCOIN (MARSCOIN) Is Now Available on Binance Alpha"],
    ["新合约上线", "Binance Futures Will Launch MARSCOINUSDT Perpetual Contract"],
    ["整币下架", "Binance Will Delist MARSCOIN (MARSCOIN) on All Spot Trading Pairs"],
  ];
  for (const [label, title] of cases) {
    let event = copy(fixtures.marscoin);
    event.title = title;
    event.signal = { scope: "exchange", category: label, labels: [label], strong: true };
    const action = label === "整币下架" ? "delist" : label === "新合约上线" ? "launch" : "list";
    const market = label === "新合约上线" ? "usd_m_perpetual" : "spot_pair";
    event = withInstrumentChange(event, { action, market, instrument: "MARSCOINUSDT" });
    const priority = deriveTradingPriority(event);
    assert.equal(priority.tier, "T0", label);
    assert.equal(priority.hardGates.t0Eligible, true, label);
    if (label === "Alpha 上新") {
      assert.match(priority.plan.capitalPath.zh, /Alpha开盘→成交深度与价格发现/u);
      assert.match(priority.plan.capitalPath.en, /Alpha launch→trading depth and price discovery/u);
      assert.doesNotMatch(priority.plan.capitalPath.zh, /永续/u);
      assert.doesNotMatch(priority.plan.capitalPath.en, /perpetual/iu);
    }
    if (label === "现货首次上币") {
      assert.match(priority.plan.capitalPath.zh, /现货开盘→成交深度与价格发现/u);
      assert.doesNotMatch(priority.plan.capitalPath.en, /perpetual/iu);
    }
    if (label === "整币下架") {
      assert.match(priority.plan.capitalPath.zh, /下架→订单、退出与流动性/u);
      assert.match(priority.plan.entryCondition.zh, /不新增仓位.*撤单.*提现安排/u);
    }
  }

  const listingWithContract = withInstrumentChange(fixtures.marscoin, { instrument: "MARSCOINUSDT" });
  listingWithContract.token = "0x4444444444444444444444444444444444444444";
  assert.equal(deriveTradingPriority(listingWithContract).tier, "T0", "Binance does not inherit launchpad token-safety gates");

  const product = copy(fixtures.marscoin);
  product.title = "Binance Agent OS Adds a New Wallet Execution Feature";
  product.signal = { scope: "wallet", category: "产品功能上线", labels: ["新功能/产品更新"], strong: true };
  assert.equal(deriveTradingPriority(product).tier, "T1", "a product feature remains monitored below a market catalyst");

  const venueEmergency = copy(fixtures.marscoin);
  venueEmergency.title = "Binance suspends all withdrawals after a confirmed security breach";
  venueEmergency.signal = { scope: "exchange", category: "安全/紧急公告", labels: ["安全/紧急公告"], strong: true };
  delete venueEmergency.launchAt;
  const emergencyPriority = deriveTradingPriority(venueEmergency);
  assert.equal(emergencyPriority.tier, "T0");
  assert.equal(emergencyPriority.category, "binance_security_emergency");
  assert.deepEqual(emergencyPriority.target, { type: "venue", value: "Binance", exact: true });
  assert.match(emergencyPriority.plan.capitalPath.zh, /平台风险→充提\/交易\/相关资产流动性/u);
  assert.match(emergencyPriority.plan.entryCondition.en, /affected scope.*on-chain anomalies.*recovery/iu);

  const vagueSecurity = copy(venueEmergency);
  vagueSecurity.title = "Emergency Notice for MARSCOINUSDT Market";
  assert.equal(deriveTradingPriority(vagueSecurity).tier, "T2", "a vague emergency label cannot bypass the explicit-action gate");
  assert.equal(deriveTradingPriority(vagueSecurity).category, "binance_information");
});

test("T0 fails closed when target, trusted evidence, or the trading window is missing", () => {
  const noTarget = copy(fixtures.marscoin);
  noTarget.title = "Binance Futures Will Launch a New Perpetual Contract";
  assert.notEqual(deriveTradingPriority(noTarget).tier, "T0");
  assert.equal(deriveTradingPriority(noTarget).hardGates.exactTarget, false);

  const copiedSource = withInstrumentChange(fixtures.marscoin, { instrument: "MARSCOINUSDT" });
  copiedSource.source.url = "https://binance.com.evil.example/copied";
  assert.notEqual(deriveTradingPriority(copiedSource).tier, "T0");
  assert.equal(deriveTradingPriority(copiedSource).hardGates.trustedConfirmation, false);

  const stale = withInstrumentChange(fixtures.marscoin, { instrument: "MARSCOINUSDT" });
  stale.observedAt = "2026-09-02T04:00:01.000Z";
  assert.notEqual(deriveTradingPriority(stale).tier, "T0");
  assert.equal(deriveTradingPriority(stale).hardGates.validWindow, false);

  const missingDetails = copy(fixtures.marscoin);
  assert.equal(deriveTradingPriority(missingDetails).tier, "T2");
  assert.equal(deriveTradingPriority(missingDetails).hardGates.completeTargetSet, false);

  const incompleteTimes = withInstrumentChange(fixtures.marscoin, {
    // Real producer shape: the top-level time mirrors instruments[0] and is
    // not a common schedule for a later target whose time is missing.
    launchAt: fixtures.marscoin.launchAt,
    instruments: [
      { symbol: "MARSCOINUSDT", launchAt: fixtures.marscoin.launchAt },
      { symbol: "HK0625USDT" },
    ],
  });
  delete incompleteTimes.launchAt;
  assert.equal(deriveTradingPriority(incompleteTimes).tier, "T2");
  assert.equal(deriveTradingPriority(incompleteTimes).hardGates.completeTargetSet, false);
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
  assert.equal(unsafeFirstToken.tier, "T2");
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
  assert.equal(blocked.tier, "T2", "a local safety rejection cannot pass the T1 safety gate");
  assert.equal(blocked.plan.conclusion.zh, "不做");
  assert.equal(blocked.plan.automaticExecution, false);
});

test("official Flap pool tokens use ordinal-aware monitor-only priority and every safety state stays immediate", () => {
  const observedAt = "2026-09-04T01:00:00.000Z";
  const quoteAddress = "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf";
  const portal = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
  const tokenCreatedTopic = "0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603";
  const generationKey = `quote:0xd97d097a89113fa59b76c572e5b2eb647e8eefaf:generation:0x${"a".repeat(64)}:0x${"b".repeat(64)}:4`;
  const makeEvent = ({ ordinal, decision, token }) => {
    const transactionHash = `0x${String(ordinal).repeat(64)}`;
    const blockHash = `0x${String(ordinal + 3).repeat(64)}`;
    const pairAddress = `0x${String(ordinal + 5).repeat(40)}`;
    const blockNumber = 119_800_000 + ordinal;
    const transactionIndex = ordinal;
    const logIndex = ordinal + 5;
    const eventKey = `bsc-flap-pool-token:${generationKey}:${ordinal}:${transactionHash}:${logIndex}:${token}`;
    return {
      type: "bsc_launchpad_update",
      kind: "flap_pool_token",
      eventKey,
      launcher: portal,
      featureTrackedToken: true,
      featureTokenOrdinal: ordinal,
      featureTokenTarget: 3,
      featureActivationKey: generationKey,
      featureGenerationKey: generationKey,
      informationalOnly: true,
      autoTradeEligible: false,
      automaticExecution: false,
      platform: { id: "flap", name: "Flap", trust: "official_verified" },
      mode: {
        quoteAsset: quoteAddress,
        quoteSymbol: "SOXLB",
        quoteName: "Semicon Bull 3X ETF",
      },
      tokens: [{ token, metadata: { name: `Tracked ${ordinal}`, symbol: `TRK${ordinal}` } }],
      pools: [{ pool: pairAddress, kind: "v2", token0: token, token1: quoteAddress, verifiedDex: true }],
      security: {
        decision,
        metrics: { liquidityConfirmed: decision === "pass" },
      },
      transactionHash,
      blockNumber,
      blockHash,
      transactionIndex,
      logIndex,
      featureTokenProof: {
        version: 1,
        activationId: generationKey,
        activationEventKey: `flap-quote:56:0x${"b".repeat(64)}:4`,
        quoteAddress,
        tokenAddress: token,
        portal,
        tokenCreatedTopic,
        transactionHash,
        blockNumber,
        blockHash,
        transactionIndex,
        logIndex,
        canonical: true,
        confirmations: 6,
        requiredConfirmations: 6,
        pairAddress,
        pairKind: "v2",
      },
      sourceUrl: `https://bscscan.com/tx/${transactionHash}`,
      explorerUrl: `https://bscscan.com/tx/${transactionHash}`,
      activationSourceUrl: `https://bscscan.com/tx/0x${"b".repeat(64)}`,
      blockTimestamp: observedAt,
      observedAt,
    };
  };

  const cases = [
    { ordinal: 1, decision: "pass", tier: "T0", conclusion: "观察；静态初筛通过，可卖性仍待验证" },
    { ordinal: 2, decision: "pass", tier: "T1", conclusion: "观察；静态初筛通过，可卖性仍待验证" },
    { ordinal: 3, decision: "pass", tier: "T1", conclusion: "观察；静态初筛通过，可卖性仍待验证" },
    { ordinal: 2, decision: "unknown", tier: "T2", conclusion: "安全未完成｜不买" },
    { ordinal: 3, decision: "block", tier: "T2", conclusion: "⛔ 不买；安全门已拦截" },
  ];

  for (const item of cases) {
    const token = `0x${String(item.ordinal).repeat(39)}${item.decision === "pass" ? "a" : item.decision === "block" ? "b" : "c"}`;
    const event = makeEvent({ ...item, token });
    const priority = deriveTradingPriority(event, { nowMs: Date.parse(observedAt) + 5_000 });
    assert.equal(priority.tier, item.tier, `${item.ordinal}/${item.decision}`);
    assert.equal(priority.plan.conclusion.zh, item.conclusion);
    assert.equal(priority.plan.automaticExecution, false);
    assert.equal(event.informationalOnly, true);
    assert.equal(event.autoTradeEligible, false);
    assert.equal(event.automaticExecution, false);
    const disposition = alertDeliveryDisposition({ ...event, tradingPriority: priority });
    assert.equal(disposition.mode, "immediate", `${item.ordinal}/${item.decision}`);
    assert.equal(disposition.deliverImmediately, true, `${item.ordinal}/${item.decision}`);
  }

  const notClosedMonitorOnly = makeEvent({
    ordinal: 2,
    decision: "unknown",
    token: "0x9999999999999999999999999999999999999999",
  });
  delete notClosedMonitorOnly.informationalOnly;
  const priority = deriveTradingPriority(notClosedMonitorOnly, { nowMs: Date.parse(observedAt) + 5_000 });
  assert.equal(priority.tier, "T2");
  assert.equal(alertDeliveryDisposition({ ...notClosedMonitorOnly, tradingPriority: priority }).mode, "audit_only");

  const original = makeEvent({ ordinal: 1, decision: "pass", token: "0x1111111111111111111111111111111111111111" });
  const revisionBlockHash = `0x${"f".repeat(64)}`;
  const canonicalRevision = {
    ...structuredClone(original),
    blockHash: revisionBlockHash,
    eventKey: `${original.eventKey}:canonical-revision:${revisionBlockHash}`,
    featureTokenProof: { ...original.featureTokenProof, blockHash: revisionBlockHash },
    canonicalRevision: {
      version: 1,
      reason: "token_created_reorg",
      ordinal: 1,
      replacesEventKey: original.eventKey,
      replacesBlockHash: original.blockHash,
      replacesTokenAddress: original.tokens[0].token,
    },
  };
  canonicalRevision.tradingPriority = deriveTradingPriority(canonicalRevision, { nowMs: Date.parse(observedAt) + 5_000 });
  assert.equal(canonicalRevision.tradingPriority.tier, "T2");
  assert.equal(canonicalRevision.tradingPriority.plan.conclusion.zh, "链重组修订｜以本条 CA 为准｜不买");
  assert.equal(canonicalRevision.tradingPriority.plan.automaticExecution, false);
  assert.deepEqual(alertDeliveryDisposition(canonicalRevision), {
    mode: "immediate",
    deliverImmediately: true,
    tier: "T2",
    reason: "flap_tracked_token_canonical_revision",
  });

  const recoverySourceAt = "2026-09-04T00:00:00.000Z";
  const recoveryObservedAt = "2026-09-04T01:00:05.000Z";
  const delayedRecovery = {
    ...makeEvent({ ordinal: 2, decision: "pass", token: "0x2222222222222222222222222222222222222222" }),
    blockTimestamp: recoverySourceAt,
    observedAt: recoveryObservedAt,
    delayedRecovery: {
      version: 1,
      reason: "verified_generation_archive_catch_up",
      sourceOccurredAt: recoverySourceAt,
      firstObservedAt: "2026-09-04T00:00:05.000Z",
      recoveredAt: recoveryObservedAt,
      lagMs: 3_605_000,
      continuousCoverage: true,
    },
  };
  delayedRecovery.tradingPriority = deriveTradingPriority(delayedRecovery, { nowMs: Date.parse(recoveryObservedAt) });
  assert.equal(delayedRecovery.tradingPriority.tier, "T2");
  assert.equal(delayedRecovery.tradingPriority.hardGates.validWindow, false);
  assert.match(delayedRecovery.tradingPriority.plan.conclusion.zh, /^延迟补报｜勿追价｜/u);
  assert.match(delayedRecovery.tradingPriority.plan.conclusion.en, /^Delayed recovery \| do not chase \|/);
  assert.doesNotMatch(delayedRecovery.tradingPriority.plan.conclusion.zh, /断线/u);
  assert.deepEqual(alertDeliveryDisposition(delayedRecovery), {
    mode: "immediate",
    deliverImmediately: true,
    tier: "T2",
    reason: "flap_tracked_token_delayed_recovery",
  });
});

test("Flap quote-pair announcements and verified pools are T1 while anonymous pool addresses remain audit-only", () => {
  const createdAt = "2026-09-02T12:20:25.000Z";
  const announcement = {
    type: "twitter_update",
    project: { id: "flap", name: "Flap", match: "official_x" },
    tweet: {
      id: "2095124685788979225",
      handle: "flapdotsh",
      url: "https://x.com/flapdotsh/status/2095124685788979225",
      text: "Flap is expanding the programmable asset layer with two new bStock trading pairs: SOXLB and SOXSB.",
      createdAt,
    },
    signal: {
      relevant: true,
      strong: true,
      platformStructural: true,
      labels: ["税收/募资/报价代币"],
      quotePairChange: {
        assetClass: "bstock_quote",
        stage: "announced",
        assets: [
          { symbol: "SOXLB", name: "Semicon Bull 3X ETF" },
          { symbol: "SOXSB", name: "Direxion Semiconductor Bear 3X ETF" },
        ],
      },
    },
  };
  const announced = deriveTradingPriority(announcement, { nowMs: Date.parse(createdAt) + 30_000 });
  assert.equal(announced.tier, "T1");
  assert.deepEqual(announced.target, { type: "quote_asset", value: "SOXLB", exact: true });
  assert.equal(announced.lifecycle.product, "quote-pair");
  assert.equal(announced.lifecycle.stage, "announced");
  assert.match(announced.plan.capitalPath.zh, /新币定价\/结算/);
  assert.match(announced.plan.risk.en, /not ETF\/share ownership/i);
  assert.equal(announced.plan.automaticExecution, false);

  const pool = (quoteSymbol) => ({
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap", website: "https://flap.sh" },
    url: "https://flap.sh/board",
    observedAt: createdAt,
    changes: {
      newFlapPools: [{
        kind: "quote_asset",
        quoteAddress: "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf",
        quoteSymbol,
        ...(quoteSymbol ? { quoteName: "Semicon Bull 3X ETF", quoteClassification: "bstock" } : {}),
        sourceUrl: "https://flap.sh/board",
        chainId: 56,
      }],
    },
  });
  const anonymous = deriveTradingPriority(pool(null), { nowMs: Date.parse(createdAt) + 30_000 });
  assert.equal(anonymous.tier, "T2");
  assert.equal(anonymous.hardGates.explicitPath, false);

  const confirmed = deriveTradingPriority(pool("SOXLB"), { nowMs: Date.parse(createdAt) + 30_000 });
  assert.equal(confirmed.tier, "T1");
  assert.equal(confirmed.target.value, "SOXLB");
  assert.equal(confirmed.lifecycle.stage, "live");
  assert.match(confirmed.plan.entryCondition.zh, /Portal\/看板 CA/);
  assert.match(confirmed.plan.risk.zh, /不等于 ETF\/股票所有权/);

  for (const quoteSymbol of ["Brk.B", "X", "Mixed_Case$1", "A12345678901234567890123"]) {
    const priority = deriveTradingPriority(pool(quoteSymbol), { nowMs: Date.parse(createdAt) + 30_000 });
    assert.equal(priority.tier, "T1", quoteSymbol);
    assert.equal(priority.target.value, quoteSymbol, quoteSymbol);
    assert.equal(priority.hardGates.explicitPath, true, quoteSymbol);
  }

  const boardObserved = {
    ...pool("SOXLB"),
    kind: "flap_quote_asset_board_observed",
    changeType: "observed",
    source: "https://flap.sh/board",
    url: "https://flap.sh/board",
    sourceOccurredAt: createdAt,
    signal: {
      strong: false,
      platformStructural: true,
      category: "Flap quote asset observed on official Board",
      headline: "Flap official Board first confirmed SOXLB as quote asset",
      quotePairChange: {
        stage: "observed",
        assetClass: "quote_asset",
        assets: [{
          symbol: "SOXLB",
          name: "Semicon Bull 3X ETF",
          address: "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf",
          chainId: 56,
          classification: "bstock",
        }],
      },
    },
  };
  const freshBoard = withTradingPriority(boardObserved, { nowMs: Date.parse(createdAt) + 30_000 });
  assert.equal(freshBoard.tradingPriority.tier, "T1");
  assert.equal(freshBoard.tradingPriority.lifecycle.stage, "observed");
  assert.match(freshBoard.tradingPriority.plan.mainline.zh, /官方看板首次确认观察到/u);
  assert.doesNotMatch(freshBoard.tradingPriority.plan.mainline.zh, /启用.*报价底池/u);
  assert.match(freshBoard.tradingPriority.plan.risk.zh, /不证明 Portal 0→1.*非自动交易/u);
  assert.deepEqual(alertDeliveryDisposition(freshBoard), {
    mode: "immediate",
    deliverImmediately: true,
    tier: "T1",
    reason: "flap_board_quote_observed",
  });
  assert.deepEqual(focusNoveltyKeys(freshBoard), [
    "flap:quote-pair:soxlb:ca:0xd97d097a89113fa59b76c572e5b2eb647e8eefaf:observed",
  ]);

  const mixedCaseBoard = structuredClone(boardObserved);
  mixedCaseBoard.changes.newFlapPools[0].quoteSymbol = "Brk.B";
  mixedCaseBoard.signal.headline = "Flap official Board first confirmed Brk.B as quote asset";
  mixedCaseBoard.signal.quotePairChange.assets[0].symbol = "Brk.B";
  const prioritizedMixedCaseBoard = withTradingPriority(mixedCaseBoard, { nowMs: Date.parse(createdAt) + 30_000 });
  assert.deepEqual(alertDeliveryDisposition(prioritizedMixedCaseBoard), {
    mode: "immediate",
    deliverImmediately: true,
    tier: "T1",
    reason: "flap_board_quote_observed",
  });
  assert.deepEqual(focusNoveltyKeys(prioritizedMixedCaseBoard), [
    "flap:quote-pair:brk-b:ca:0xd97d097a89113fa59b76c572e5b2eb647e8eefaf:observed",
  ]);

  const lateBoard = withTradingPriority({
    ...structuredClone(boardObserved),
    observedAt: new Date(Date.parse(createdAt) + 20 * 60_000).toISOString(),
  }, { nowMs: Date.parse(createdAt) + 20 * 60_000 });
  assert.equal(lateBoard.tradingPriority.tier, "T2");
  assert.equal(lateBoard.tradingPriority.window.valid, false);
  assert.match(lateBoard.tradingPriority.plan.entryCondition.zh, /元数据延迟补齐，勿追价/u);
  assert.deepEqual(alertDeliveryDisposition(lateBoard), {
    mode: "immediate",
    deliverImmediately: true,
    tier: "T2",
    reason: "flap_board_quote_observed",
  });

  const recoveredAt = "2026-09-02T12:40:25.000Z";
  const delayedEvent = {
    ...pool("Brk.B"),
    kind: "flap_quote_asset_enabled",
    transactionHash: `0x${"ab".repeat(32)}`,
    blockNumber: 119_700_000,
    blockTimestamp: createdAt,
    occurredAt: createdAt,
    observedAt: recoveredAt,
    delayedRecovery: {
      version: 1,
      reason: "monitoring_gap_recovery",
      sourceOccurredAt: createdAt,
      recoveredAt,
      lagMs: 20 * 60_000,
    },
    freshness: {
      version: 1,
      scope: "flap_delayed_recovery",
      basis: "delayedRecovery.recoveredAt_continuous_recovery",
      sourceOccurredAt: recoveredAt,
      discoveredAt: recoveredAt,
      lagMs: 0,
      sourceTimeReliable: true,
      realtimeMaxAgeMs: 600_000,
      telegramMaxAgeMs: 7_200_000,
      decision: "realtime",
      reason: "within_realtime_window",
    },
  };
  delayedEvent.tradingPriority = deriveTradingPriority(delayedEvent, { nowMs: Date.parse(recoveredAt) });
  assert.equal(delayedEvent.tradingPriority.tier, "T2");
  assert.equal(delayedEvent.tradingPriority.target.value, "Brk.B");
  assert.match(delayedEvent.tradingPriority.plan.entryCondition.zh, /断线补报勿追价/);
  assert.match(delayedEvent.tradingPriority.plan.risk.en, /do not chase.*no automatic trading/i);
  assert.deepEqual(alertDeliveryDisposition(delayedEvent), {
    mode: "immediate",
    deliverImmediately: true,
    tier: "T2",
    reason: "flap_delayed_recovery",
  });

  const firstObserved = structuredClone(delayedEvent);
  const observedAsset = firstObserved.changes.newFlapPools[0];
  firstObserved.kind = "flap_quote_asset_first_observed_after_gap";
  firstObserved.changeType = "observed";
  firstObserved.strong = false;
  firstObserved.changes = { newFlapPools: [], updatedFlapPools: [observedAsset] };
  firstObserved.signal = {
    strong: false,
    platformStructural: true,
    category: "Flap quote asset first observed after gap",
    headline: "Flap first observed Brk.B currently enabled after a monitoring gap",
    quotePairChange: {
      stage: "observed",
      assetClass: "quote_asset",
      assets: [{
        symbol: observedAsset.quoteSymbol,
        name: observedAsset.quoteName,
        address: observedAsset.quoteAddress,
        decimals: 18,
      }],
    },
  };
  firstObserved.delayedRecovery.reason = "first_observed_after_gap";
  firstObserved.freshness.scope = "flap_first_observed_after_gap";
  firstObserved.tradingPriority = deriveTradingPriority(firstObserved, { nowMs: Date.parse(recoveredAt) });
  assert.equal(firstObserved.tradingPriority.tier, "T2");
  assert.equal(firstObserved.tradingPriority.lifecycle.stage, "observed");
  assert.equal(firstObserved.tradingPriority.hardGates.explicitPath, false);
  assert.equal(firstObserved.tradingPriority.hardGates.t1Eligible, false);
  assert.match(firstObserved.tradingPriority.plan.mainline.zh, /当前启用.*0→1 未证/u);
  assert.match(firstObserved.tradingPriority.plan.mainline.en, /currently enabled.*0→1 is unproven/i);
  assert.match(firstObserved.tradingPriority.plan.entryCondition.zh, /勿追价/u);
  assert.match(firstObserved.tradingPriority.plan.risk.zh, /补扫仅确认当前启用.*0→1 未证.*非自动交易/u);
  assert.match(firstObserved.tradingPriority.plan.risk.en, /confirms only the current enabled state.*0→1 is unproven.*do not chase.*no automatic trading/i);
  assert.deepEqual(alertDeliveryDisposition(firstObserved), {
    mode: "immediate",
    deliverImmediately: true,
    tier: "T2",
    reason: "flap_first_observed_after_gap",
  });
});

test("Binance campaigns are forced to T3, ordinary announcements stay T2, and routine code is T3", () => {
  const activity = copy(fixtures.marscoin);
  activity.signal = { scope: "exchange", category: "活动公告", labels: ["活动/奖励公告"], strong: false };
  activity.title = "Binance Alpha Trading Campaign: Trade ABC and Share Rewards";
  delete activity.launchAt;
  assert.equal(deriveTradingPriority(activity).tier, "T3");

  const activityWithListingWords = copy(activity);
  activityWithListingWords.title = "Binance Alpha Campaign: Add FOOUSDT to Watchlist and Earn Rewards";
  assert.equal(deriveTradingPriority(activityWithListingWords).tier, "T3",
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
    committedAt: "2026-09-02T01:29:59.000Z",
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

test("recent 24h Binance noise shapes are T3 and Square governance cannot become T1", () => {
  const titles = [
    "Binance Academy Bitcoin Page: Complete Quiz to Earn BTC Rewards This September 2026!",
    "Altcoin Trading Festival: Trade to Share Up to 300,000 USDC Token Vouchers",
    "APAC Exclusive: Celebrating Mid-Autumn - Upgrade or Trade to Claim Your VIP Suitcase",
    "CIS New User Exclusive: Subscribe to USDT Simple Earn to Enjoy 35% APR During the Promotion Period!",
    "Binance Alpha Trading Competition: Trade Collect on Fanable (COLLECT) and Share $200K Worth of Rewards",
    "Become a Binance P2P Merchant in CIS & CEE and Get 100 USDT in Token Vouchers",
    "Pakistan Exclusive: Road to Skardu KOL Challenge - Bring Qualified Referrals, Earn Your Spot!",
    "Complete Your First Trade and Earn Up to 20 USDC in Token Voucher Rewards",
  ];
  for (const title of titles) {
    const event = copy(fixtures.marscoin);
    event.title = title;
    event.signal = { category: "活动公告", labels: ["活动/奖励公告"], strong: false };
    delete event.launchAt;
    assert.equal(deriveTradingPriority(event).tier, "T3", title);
  }
  const square = copy(fixtures.marscoin);
  square.source = { id: "binance_square_cms", url: "https://www.binance.com/en/square/post/123" };
  square.url = square.source.url;
  square.title = "Binance Square Community Governance Announcement (Aug 24 – Aug 30)";
  square.signal = { category: "产品功能上线", labels: ["功能/产品更新"], strong: true };
  delete square.launchAt;
  const squarePriority = deriveTradingPriority(square);
  assert.equal(squarePriority.category, "binance_low_value");
  assert.equal(squarePriority.tier, "T3");
});

test("delivery disposition is fail-closed with only explicit realtime exceptions", () => {
  const t0 = withTradingPriority(withInstrumentChange(fixtures.marscoin, { instrument: "MARSCOINUSDT" }));
  const t1 = withTradingPriority(fixtures.flapUpgrade);
  const t2 = withTradingPriority({ type: "telegram_news_update", sourceOccurredAt: "2026-09-02T01:00:00.000Z", observedAt: "2026-09-02T01:00:01.000Z" });
  const campaign = copy(fixtures.marscoin);
  campaign.signal = { category: "活动公告", labels: ["活动/奖励公告"] };
  campaign.title = "Trade ABC and Share Rewards";
  delete campaign.launchAt;
  const t3 = withTradingPriority(campaign);
  assert.equal(alertDeliveryDisposition(t0).mode, "immediate");
  assert.equal(alertDeliveryDisposition(t1).mode, "immediate");
  assert.equal(alertDeliveryDisposition(t2).mode, "audit_only");
  assert.equal(alertDeliveryDisposition(t3).mode, "audit_only");
  assert.equal(alertDeliveryDisposition({ type: "fomo_monitor_health_update" }).mode, "immediate");
  const legacyStrong = withTradingPriority({ type: "legacy_pending", strong: true }, { legacy: true });
  assert.equal(legacyStrong.tradingPriority.tier, "T1");
  assert.equal(alertDeliveryDisposition(legacyStrong).mode, "audit_only", "a legacy T1 cannot bypass current hard gates");

  const now = "2026-09-02T04:00:00.000Z";
  const pon = {
    type: "pon_fun_update",
    kind: "market_created",
    platform: { id: "ponfun" },
    source: { id: "pon_fun_official_api_onchain", trust: "official_site_bound_onchain_fingerprinted", official: true },
    sourceTrust: "official_site_bound_onchain_fingerprinted",
    factory: "0xf698d13348686c1529c2dc54847c123424d9dae0",
    token: "0x1111111111111111111111111111111111111111",
    transactionHash: `0x${"a".repeat(64)}`,
    blockNumber: 52_000_001,
    blockTimestamp: now,
    observedAt: now,
    evidence: {
      factoryCodeHash: "0x4cb9795396b800a4b1e46f2e91a690ecf004ac0d52b059a7ef0e6b190af17384",
      receiptVerified: true,
    },
    freshness: { version: 1, basis: "blockTimestamp", decision: "realtime", sourceOccurredAt: now, discoveredAt: now },
  };
  pon.tradingPriority = deriveTradingPriority(pon, { nowMs: Date.parse(now) });
  assert.equal(pon.tradingPriority.tier, "T2");
  assert.equal(alertDeliveryDisposition(pon).reason, "pon_exact_onchain_realtime");
  const provenanceSpoof = structuredClone(pon);
  provenanceSpoof.source = { id: "copied_feed", trust: "public_onchain", official: false };
  provenanceSpoof.sourceTrust = "public_onchain";
  provenanceSpoof.tradingPriority = deriveTradingPriority(provenanceSpoof, { nowMs: Date.parse(now) });
  assert.equal(provenanceSpoof.tradingPriority.confirmation.kind, "onchain");
  assert.equal(alertDeliveryDisposition(provenanceSpoof).mode, "audit_only", "generic on-chain proof is not the pon.fun exception");
  const delayed = {
    ...pon,
    delayedRecovery: { version: 1, reason: "monitoring_gap_recovery" },
  };
  assert.equal(alertDeliveryDisposition(delayed).reason, "pon_delayed_recovery");
  const apiLifecycle = {
    ...pon,
    kind: "market_lifecycle",
    transactionHash: undefined,
    blockNumber: undefined,
    freshness: { ...pon.freshness, basis: "observedAt_continuous_coverage" },
  };
  apiLifecycle.tradingPriority = deriveTradingPriority(apiLifecycle, { nowMs: Date.parse(now) });
  assert.equal(alertDeliveryDisposition(apiLifecycle).mode, "audit_only");
  const unpaused = {
    ...pon,
    kind: "factory_unpaused",
    token: undefined,
  };
  unpaused.tradingPriority = deriveTradingPriority(unpaused, { nowMs: Date.parse(now) });
  assert.equal(unpaused.tradingPriority.target.value, pon.factory);
  assert.equal(alertDeliveryDisposition(unpaused).reason, "pon_exact_onchain_realtime");
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
    publishedAt: "2026-09-02T01:30:00.000Z",
    observedAt: "2026-09-02T01:30:01.000Z",
  };
  const developerPriority = deriveTradingPriority(developerFeature);
  assert.equal(developerPriority.category, "binance_product");
  assert.equal(developerPriority.tier, "T1");

  const agentOsPageFeature = {
    ...developerFeature,
    project: { id: "binance-wallet", name: "Binance Web3" },
    title: "Binance Agent OS 官方 Web3 developer product feature",
    addedSignals: ["Binance Agent OS adds an on-chain developer capability"],
    developerChange: { classification: "product_feature", productFeature: true, substantive: true },
    source: { id: "binance_agent_os_page", url: "https://www.binance.com/agent-os" },
    url: "https://www.binance.com/agent-os",
    comparisonBasis: "exact_snapshot",
  };
  const agentOsPagePriority = deriveTradingPriority(agentOsPageFeature);
  assert.equal(agentOsPagePriority.confirmation.trusted, true);
  assert.equal(agentOsPagePriority.category, "binance_product");
  assert.equal(agentOsPagePriority.tier, "T1");

  const missingSourceTime = copy(developerFeature);
  delete missingSourceTime.publishedAt;
  assert.equal(deriveTradingPriority(missingSourceTime).tier, "T2", "T1 requires a reliable fresh source time");

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

test("T0/T1 cards are local deterministic compact bilingual bundles and never wait for translation", async () => {
  let translationCalls = 0;
  const config = {
    alertTranslationFetchImpl: async () => {
      translationCalls += 1;
      return { ok: false, status: 503, text: async () => "unavailable" };
    },
    alertTranslationTimeoutMs: 50,
  };
  for (const sourceEvent of [withInstrumentChange(fixtures.marscoin, { instrument: "MARSCOINUSDT" }), fixtures.fomoBuy]) {
    const event = withTradingPriority(sourceEvent);
    const bundle = await buildBilingualAlertBundle(config, event, [
      "official monitoring update",
      `具体更新: ${event.title || event.tokenSymbol}`,
      "状态: verified source",
      `时间: ${event.observedAt}`,
    ].join("\n"));
    const rendered = renderBilingualTelegramText(bundle, true);
    assert.ok(["T0", "T1"].includes(bundle.priority.tier));
    if (sourceEvent.type === "binance_official_update") {
      assert.equal(bundle.priority.label.zh, "最高优先催化");
      assert.equal(bundle.priority.label.en, "Top-priority catalyst");
      assert.match(bundle.zh.text, /09-02 03:00 UTC/);
      assert.match(bundle.en.text, /09-02 03:00 UTC/);
    }
    if (sourceEvent.type === "fomo_family_top_call") {
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
    assert.ok(rendered.length < 3_800, `card=${rendered.length}`);
    assert.ok(rendered.split("\n").length <= 18, `card lines=${rendered.split("\n").length}`);
  }
  assert.equal(translationCalls, 0);
});

test("outbox drain migrates old active priority and delivers only T0/T1 plus health", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "trading-priority-outbox-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = new Date();
  const iso = (offsetMs) => new Date(now.getTime() + offsetMs).toISOString();
  const t0 = withInstrumentChange(fixtures.marscoin, { instrument: "MARSCOINUSDT", launchAt: iso(60_000) });
  t0.publishedAt = iso(-2_000);
  t0.observedAt = iso(-1_000);
  t0.launchAt = iso(60_000);
  const t1Legacy = {
    type: "platform_capability_update",
    eventKey: "priority-fixture:t1",
    platform: { id: "flap", name: "Flap" },
    changes: { newModules: ["Vault V3"] },
    strong: true,
    publishedAt: iso(-950),
    observedAt: iso(-900),
  };
  const t2Legacy = copy(fixtures.marscoin);
  t2Legacy.eventKey = "priority-fixture:t2";
  t2Legacy.signal = { scope: "exchange", category: "普通公告", labels: ["普通官方公告"], strong: false };
  t2Legacy.title = "Binance Publishes an Ordinary Service Notice";
  t2Legacy.strong = false;
  t2Legacy.publishedAt = iso(-800);
  t2Legacy.observedAt = iso(-700);
  delete t2Legacy.launchAt;
  t2Legacy.tradingPriority = {
    version: 1,
    schema: "news_trading_priority_v1",
    deterministic: true,
    tier: "T1",
    rank: 3,
    plan: { automaticExecution: false },
  };
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
  assert.equal(count, 4);
  assert.deepEqual(
    delivered.map((event) => event.type === "fomo_monitor_health_update" ? "HEALTH" : event.tradingPriority.tier),
    ["T0", "HEALTH", "T1", "T1"],
  );
  assert.equal(delivered[1].tradingPriority, undefined, "health keeps its closed non-trading schema");
  assert.deepEqual(delivered.slice(2, 4).map((event) => event.eventKey), ["priority-fixture:t1-older", "priority-fixture:t1"]);
  assert.equal(delivered[2].tradingPriority.version, TRADING_PRIORITY_VERSION);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(persisted.events.t2.event.tradingPriority.version, TRADING_PRIORITY_VERSION);
  assert.equal(persisted.events.t2.event.tradingPriority.tier, "T2", "old v1 T1 is recomputed instead of trusted");
  assert.equal(persisted.events.t2.status, "suppressed");
  assert.equal(persisted.events.t2.destinations.webhook.disabledReason, "policy_suppressed");
  assert.equal(persisted.events.t3.status, "suppressed");
  assert.equal(legacyTradingPriority({ strong: true }).tier, "T1");
  assert.equal(legacyTradingPriority({ strong: false }).tier, "T2");
  assert.equal(withTradingPriority({ strong: true }, { legacy: true }).tradingPriority.tier, "T1");
});

test("pon.fun structural updates are T1, market/recovery updates are T2, and none can become T0", () => {
  const nowMs = Date.parse("2026-09-02T04:00:30.000Z");
  const factory = "0xF698d13348686C1529c2DC54847C123424d9DAE0";
  const coin = "0x1111111111111111111111111111111111111111";
  const base = {
    type: "pon_fun_update",
    platform: { id: "ponfun", name: "pon.fun", chainId: 4663 },
    source: {
      id: "pon_fun_official_api_onchain",
      trust: "official_site_bound_onchain_fingerprinted",
      official: true,
      url: "https://www.pon.fun/api/markets",
    },
    sourceTrust: "official_site_bound_onchain_fingerprinted",
    factory,
    token: coin,
    contractAddress: coin,
    blockTimestamp: "2026-09-02T04:00:00.000Z",
    observedAt: "2026-09-02T04:00:00.000Z",
    evidence: {
      factoryCodeHash: "0x4cb9795396b800a4b1e46f2e91a690ecf004ac0d52b059a7ef0e6b190af17384",
    },
  };
  const expected = new Map([
    ["factory_config", "T1"],
    ["curve_params", "T1"],
    ["factory_paused", "T1"],
    ["ownership_transfer_started", "T1"],
    ["ownership_transferred", "T1"],
    ["platform_token_update", "T1"],
    ["market_created", "T2"],
    ["market_lifecycle", "T2"],
    ["stock_listing", "T2"],
    ["factory_unpaused", "T2"],
  ]);
  for (const [kind, tier] of expected) {
    const priority = deriveTradingPriority({ ...base, kind }, { nowMs });
    assert.equal(priority.tier, tier, kind);
    assert.equal(priority.hardGates.t0Eligible, false, kind);
    assert.equal(priority.confirmation.kind, "official_site_bound_onchain_fingerprint", kind);
    assert.equal(priority.plan.automaticExecution, false, kind);
  }

  const officialX = (signal) => ({
    type: "twitter_update",
    project: {
      id: "ponfun",
      name: "pon.fun",
      handle: "pondotfun",
      xUserId: "2094048312772993024",
      match: "official_x",
      signalProfile: "pon_fun",
      website: "https://www.pon.fun",
      twitter: "https://x.com/pondotfun",
    },
    tweet: {
      id: "2095100000000000000",
      authorId: "2094048312772993024",
      xUserId: "2094048312772993024",
      sourceVerifiedBy: "official_x_oembed",
      identityVerifiedBy: "fxtwitter_exact_numeric_id",
      url: "https://x.com/pondotfun/status/2095100000000000000",
      createdAt: "2026-09-02T04:00:00.000Z",
    },
    signal,
  });
  const major = deriveTradingPriority(officialX({
    relevant: true,
    ponPriority: "T1",
    majorProductUpdate: true,
    platformStructural: true,
    ponStage: "supply_burned",
  }), { nowMs });
  const ordinary = deriveTradingPriority(officialX({
    relevant: true,
    ponPriority: "T2",
    majorProductUpdate: false,
    ponStage: "recovered",
  }), { nowMs });
  assert.equal(major.tier, "T1");
  assert.equal(ordinary.tier, "T2");
  assert.equal(major.confirmation.kind, "official_x_numeric_id_oembed");
  assert.equal(major.hardGates.t0Eligible, false);
  assert.equal(ordinary.hardGates.t0Eligible, false);
  const delayedRecovery = {
    version: 1,
    reason: "monitoring_gap_recovery",
    gapSince: "2026-09-02T03:30:00.000Z",
    sourceOccurredAt: "2026-09-02T03:00:00.000Z",
    recoveredAt: "2026-09-02T04:00:30.000Z",
    lagMs: 60 * 60_000 + 30_000,
    cursor: { latestIdAtRecovery: "2095099999999999999", tweetId: "2095100000000000000" },
  };
  const delayedX = deriveTradingPriority({
    ...officialX({
      relevant: true,
      ponPriority: "T1",
      majorProductUpdate: true,
      platformStructural: true,
      ponStage: "supply_burned",
    }),
    delayedRecovery,
  }, { nowMs });
  const delayedChain = deriveTradingPriority({
    ...base,
    kind: "factory_config",
    delayedRecovery: {
      ...delayedRecovery,
      cursor: { nextBlockAtRecovery: 52_000_100, eventBlock: 52_000_001 },
    },
  }, { nowMs });
  assert.equal(delayedX.tier, "T2");
  assert.equal(delayedChain.tier, "T2");
  assert.equal(delayedX.hardGates.t0Eligible, false);
  assert.equal(delayedChain.hardGates.t0Eligible, false);

  for (const mutate of [
    (event) => { event.project.xUserId = "2094048312772993025"; },
    (event) => { event.tweet.authorId = "2094048312772993025"; },
    (event) => { delete event.tweet.sourceVerifiedBy; },
    (event) => { event.tweet.url = `https://x.com/pondotfun_/status/${event.tweet.id}`; },
  ]) {
    const spoof = officialX({
      relevant: true,
      ponPriority: "T1",
      majorProductUpdate: true,
      platformStructural: true,
      ponStage: "supply_burned",
    });
    mutate(spoof);
    const priority = deriveTradingPriority(spoof, { nowMs });
    assert.equal(priority.confirmation.trusted, false);
    assert.equal(priority.tier, "T2");
    assert.equal(priority.hardGates.t0Eligible, false);
  }
});
